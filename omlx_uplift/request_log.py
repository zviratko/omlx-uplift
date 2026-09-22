# SPDX-License-Identifier: Apache-2.0
"""
Live request tracker for the Uplift dashboard feed (R12-3).

Sampling design: nothing runs on the inference hot path. Each admin poll
(or SSE tick) samples the schedulers' published admin snapshots — the same
data the stats endpoint already reads — and merges them into an in-memory
per-request view:

  queued      -> scheduler.waiting
  prefilling  -> prefill progress tracker (chunked prefills live outside
                 running_by_id; same source the Active Models card uses)
  generating  -> scheduler.running_by_id minus prefilling ids

A request that was live and is no longer observed anywhere becomes
``complete`` in the ring buffer (no SQLite yet — history beyond the ring
is deferred, see docs/server-plan.md). Token counts are captured from the
Request objects while they are still visible in the snapshot.

Cancellation uses the scheduler's deferred ``abort_request`` (processed at
the next engine step), which closes R12-4.
"""

from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict, deque
from typing import Any

RING_LIMIT = 200          # finished rows kept for the feed
ACTIVE_STALE_S = 300.0    # forget active rows untouched this long

# RL-1 payload capture caps (bytes, per field). Worst case per persisted
# row: ~32 KB prompt + 32 KB output + <1 KB params — and rows only persist
# on state/counter change (collector filter), not per tick.
PAYLOAD_CAP = 32 * 1024

# SamplingParams fields worth persisting for loop diagnosis, mirroring
# omlx/request.py SamplingParams (tests assert this set stays in sync).
PARAM_FIELDS = ("temperature", "top_p", "max_tokens", "stop",
                "presence_penalty", "frequency_penalty")


def _truncate(text: str, cap: int = PAYLOAD_CAP):
    """Return (text, truncated_flag); cap is a UTF-8 BYTE budget."""
    raw = text.encode("utf-8", errors="replace")
    if len(raw) <= cap:
        return text, False
    return raw[:cap].decode("utf-8", errors="ignore"), True


# Issue 3: token-id prompts kept only a count, so the inspector could never
# show what was actually sent. Retain a HEAD + TAIL id sample (the middle of
# a 200k-token prompt is dead weight in RAM and on disk); the router decodes
# them lazily with the loaded engine's tokenizer when a modal is opened.
PROMPT_IDS_HEAD = 4096
PROMPT_IDS_TAIL = 4096


def _token_ids_sample(prompt, head=PROMPT_IDS_HEAD, tail=PROMPT_IDS_TAIL):
    """Return (json_string, truncated_flag) for a token-id prompt sample:
    first `head` ids plus last `tail` ids when longer. None when the list is
    not a pure int sequence (defensive: never store a guess)."""
    try:
        if not all(isinstance(t, int) for t in prompt[:8]):
            return None
        n = len(prompt)
        if n <= head + tail:
            return json.dumps(list(prompt)), False
        return (json.dumps(list(prompt[:head]) + list(prompt[n - tail:])),
                True)
    except Exception:  # noqa: BLE001
        return None


# ---- RL-4 degenerate-loop hint ------------------------------------------
LOOP_WINDOW = 800          # chars of tail inspected per check
_NO_FINISH = object()   # sentinel: row had no 'finish' key

LOOP_MIN_UNIT = 20         # shorter repeating units = formatting, not loop
LOOP_MIN_REPEATS = 3       # unit must tile the tail this many times
LOOP_MAX_UNIT_NEWLINES = 1  # multi-row blocks tiling = structured output


def _primitive_period(s: str) -> int:
    """Smallest p with s[i] == s[i-p] for all i >= p (KMP failure table —
    linear, stdlib-free). Equals len(s) when the text is not periodic."""
    n = len(s)
    fail = [0] * (n + 1)
    k = 0
    for i in range(1, n):
        while k and s[i] != s[k]:
            k = fail[k]
        if s[i] == s[k]:
            k += 1
        fail[i + 1] = k
    return n - fail[n]


def detect_repeat(text: str) -> float:
    """Repetition score of a text tail: repeats of the shortest period >=
    LOOP_MIN_UNIT that still tiles the tail's run of identical blocks.

    Two-offset scan only (character compares, linear in the window) — no
    regex, no dynamic programming, cheap enough for the 1 s sample tick.
    Returns the repeat count of that period over its run (0.0 when the
    tail shows no qualifying repetition). Guards against false positives:
    a tail that is overall periodic with a SHORT primitive period
    ('aaaa…', indentation) is formatting noise, and a unit that tiles
    with several newlines inside is a repeated structured block (a whole
    markdown table), not token-level degeneration.
    """
    tail = text[-LOOP_WINDOW:]
    n = len(tail)
    if n < LOOP_MIN_UNIT * LOOP_MIN_REPEATS:
        return 0.0
    p = _primitive_period(tail)
    if p < LOOP_MIN_UNIT:
        return 0.0                        # whole tail uniform/short-cycle
    # The run of repeats ends at the tail end; walk each candidate period
    # backwards from the end while blocks match the last one.
    for period in range(LOOP_MIN_UNIT, n // 2 + 1):
        # quick reject: last block must equal the one before it
        if tail[-period:] != tail[-2 * period:-period]:
            continue
        unit = tail[n - period:]
        if unit.count("\n") > LOOP_MAX_UNIT_NEWLINES:
            continue                      # tiled table/code block
        blocks = 2
        i = n - 2 * period
        while i - period >= 0 and tail[i - period:i] == unit:
            blocks += 1
            i -= period
        if blocks >= LOOP_MIN_REPEATS:
            # shortest qualifying period wins (found first, ascending);
            # normal prose never has a 20+-char period repeating 3x.
            return float(blocks)
    return 0.0


def loop_hint(text: str) -> bool:
    return detect_repeat(text) >= LOOP_MIN_REPEATS


LOOP_TOK_WINDOW = 200      # token ids of tail inspected per check
LOOP_TOK_MIN_UNIT = 20     # tokens — token-level equivalent of the unit


def _primitive_period_seq(s) -> int:
    """Same as _primitive_period but for token-id sequences (no slicing
    copies — indexing only)."""
    n = len(s)
    fail = [0] * (n + 1)
    k = 0
    for i in range(1, n):
        while k and s[i] != s[k]:
            k = fail[k]
        if s[i] == s[k]:
            k += 1
        fail[i + 1] = k
    return n - fail[n]


def detect_repeat_tokens(ids) -> float:
    """Token-id twin of detect_repeat (runs while streaming, when the text
    collector is already drained by the consumer). Pure int comparisons on
    a bounded tail — no decode, no tokenization, tick-cheap. A tiled
    structured block CAN trip here; the hint is advisory ('LOOP?'), never
    an intervention."""
    tail = list(ids)[-LOOP_TOK_WINDOW:]
    n = len(tail)
    if n < LOOP_TOK_MIN_UNIT * LOOP_MIN_REPEATS:
        return 0.0
    p = _primitive_period_seq(tail)
    if p < LOOP_TOK_MIN_UNIT:
        return 0.0                        # alternating/uniform token noise
    for period in range(LOOP_TOK_MIN_UNIT, n // 2 + 1):
        if tail[-period:] != tail[-2 * period:-period]:
            continue
        unit = tail[n - period:]
        blocks = 2
        i = n - 2 * period
        while i - period >= 0 and tail[i - period:i] == unit:
            blocks += 1
            i -= period
        if blocks >= LOOP_MIN_REPEATS:
            return float(blocks)
    return 0.0


def _capture_payload(req: Any) -> dict:
    """Best-effort payload fields for one Request (RL-1).

    Each getattr is guarded individually: a capture failure must NEVER
    lose the lifecycle row. Missing attributes are ABSENT from the dict,
    never empty-string lies (honest-label doctrine). No tokenization, no
    decoding, no file IO — reads only what the Request already holds.
    """
    out: dict[str, Any] = {}
    try:
        prompt = req.prompt
        if isinstance(prompt, str) and prompt:
            out["prompt"], out["prompt_trunc"] = _truncate(prompt)
        elif isinstance(prompt, list) and prompt:
            # token-id prompt: describe it AND keep the ids so the
            # inspector can decode them lazily with the model's tokenizer
            # (issue 3 — tokenized prompts used to be undecodable dead text).
            out["prompt"] = f"(tokenized prompt, {len(prompt)} tokens)"
            out["prompt_trunc"] = False
            ids = _token_ids_sample(prompt)
            if ids is not None:
                out["prompt_ids"], out["prompt_ids_trunc"] = ids
    except Exception:  # noqa: BLE001
        pass
    try:
        text = getattr(req, "output_text", "") or ""
        if text:
            out["output"], out["output_trunc"] = _truncate(text)
    except Exception:  # noqa: BLE001
        pass
    try:
        sp = req.sampling_params
        params = {f: getattr(sp, f) for f in PARAM_FIELDS
                  if hasattr(sp, f)}
        if params:
            # stop lists may carry non-JSON scalars; default=str keeps it safe
            out["params"] = json.dumps(params, default=str)
    except Exception:  # noqa: BLE001
        pass
    try:
        fr = getattr(req, "finish_reason", None)
        if fr:
            out["finish"] = str(fr)
    except Exception:  # noqa: BLE001
        pass
    return out


class RequestTracker:
    """Thread-safe in-memory view of live + recently finished requests."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: dict[str, dict[str, Any]] = {}
        self._done: deque[dict[str, Any]] = deque(maxlen=RING_LIMIT)
        # ids finalized by the event hook (late birth events must not
        # resurrect them); bounded like _persisted in the collector.
        self._done_ids: set[str] = set()
        # ids of rows whose state changed since the last drain (for SSE)
        self._dirty_ids: set[str] = set()
        # rid -> consecutive sample-passes the row was absent from an
        # otherwise-OK snapshot (MISSES-GRACE; see sample())
        self._miss_counts: dict[str, int] = {}
        self._sampled_at = 0.0

    # ------------------------------------------------------------------
    def sample(self, engine_pool: Any) -> None:
        """Merge one snapshot pass across every loaded engine.

        ``engine_pool`` is the live EnginePool (or None / a stub in tests).
        Any per-model failure is contained: the feed must never take the
        dashboard down.
        """
        now = time.time()
        seen: set[str] = set()
        rows: list[tuple[str, dict[str, Any]]] = []
        sampled_models: set[str] = set()
        model_schedulers: dict[str, Any] = {}

        entries = getattr(engine_pool, "_entries", {}) or {} if engine_pool else {}
        try:
            model_ids = list(entries.keys())
        except Exception:
            model_ids = []

        model_collectors: dict[str, dict] = {}
        for model_id in model_ids:
            try:
                entry = entries.get(model_id)
                sched = _find_scheduler(entry)
                if sched is None:
                    continue
                snap = sched.snapshot_for_admin()
                model_schedulers[model_id] = sched
                model_collectors[model_id] = _find_output_collectors(entry)
                model_rows = list(_rows_from_snapshot(snap, model_id, now))
                # PREFILL-VIS: chunked prefills live in scheduler.prefilling,
                # which the admin snapshot does NOT publish. Without this the
                # tracker saw them "departed" mid-prefill -> premature
                # complete, then a flip back to generating when the request
                # reappeared in running_by_id (user: feed flip-flops and
                # eventually latches everything at complete).
                try:
                    from omlx.prefill_progress import get_prefill_tracker

                    snap_ids = {rid for rid, _ in model_rows}
                    for p in get_prefill_tracker().get_model_progress(model_id):
                        rid = p.get("request_id") or ""
                        if not rid or rid in seen or rid in snap_ids:
                            continue
                        model_rows.append((rid, {
                            "id": rid, "state": "prefilling", "model": model_id,
                            "origin": "real", "ts": now,
                            "prompt_tokens": p.get("prompt_tokens")
                            or p.get("total") or 0,
                        }))
                        seen.add(rid)
                except Exception:  # noqa: BLE001 — vanilla layout changed
                    pass
            except Exception:  # noqa: BLE001 - best-effort like the stats route
                continue
            sampled_models.add(model_id)
            rows.extend(model_rows)
            for rid, _ in model_rows:
                if rid:
                    seen.add(rid)

        with self._lock:
            for rid, row in rows:
                if not rid:
                    continue
                # Event-hook-finalized rows are exact; the scheduler's
                # deferred removal may still show the request in this
                # snapshot — don't resurrect it as active (RL3-GAP1).
                if rid in self._done_ids and rid not in self._active:
                    continue
                tok_tail = row.pop("_tok_tail", None)   # private, never stored
                prev = self._active.get(rid, {})
                merged = {**prev, **row}
                # RL-2 live tail: the per-request output collector carries the
                # cumulative decoded text — that is the ONLY source that
                # grows while generating (Request.output_text lands at
                # finalize only). Skip the prefill phase (no collector yet).
                coll = model_collectors.get(row.get("model"), {}).get(rid)
                if coll is not None:
                    before = prev.get("output")
                    merged.update(_collector_payload(coll))
                    # RL-4 loop hint: run ONLY when the tail text grew since
                    # the last tick (bounded work; generating rows only).
                    after = merged.get("output")
                    if after and after != before:
                        hint = loop_hint(after)
                        if hint != prev.get("loop_hint"):
                            self._dirty_ids.add(rid)   # chip appears via SSE
                        merged["loop_hint"] = hint
                if not merged.get("loop_hint") and tok_tail:
                    # Streaming consumers drain the text collector — fall
                    # back to token-id repetition when text is unavailable.
                    hint = detect_repeat_tokens(tok_tail) >= LOOP_MIN_REPEATS
                    if hint != prev.get("loop_hint"):
                        self._dirty_ids.add(rid)
                    merged["loop_hint"] = hint
                if merged.get("state") != prev.get("state"):
                    self._dirty_ids.add(rid)
                self._active[rid] = merged
            # departed rows -> complete. Only when the row's own model was
            # sampled OK this pass (a failed sample says nothing about
            # absence). MISSES-GRACE: the admin snapshot is published on the
            # engine thread and can lag a step; a request that is simply
            # between queues for ONE tick (chunked-prefill handoff, scheduler
            # moves) used to flip to complete and back (user: rows oscillate
            # ongoing/completed). Require two consecutive absences; the exact
            # note_finalize hook still ends rows immediately when it fires.
            for rid in list(self._active):
                if rid in seen:
                    self._miss_counts.pop(rid, None)
                    continue
                row = self._active[rid]
                if row.get("model") not in sampled_models:
                    continue
                if row.get("state") in ("queued", "prefilling", "generating",
                                        "cancelling"):
                    misses = self._miss_counts.get(rid, 0) + 1
                    self._miss_counts[rid] = misses
                    if misses < 2:
                        continue
                    self._miss_counts.pop(rid, None)
                    done = dict(row)
                    # an aborted row that simply vanished was cancelled
                    done["state"] = ("error" if row.get("state") == "cancelling"
                                     else "complete")
                    done["ts"] = now
                    # RL-2: one last shot at the terminal payload while the
                    # Request object may still sit in scheduler.requests
                    # (output_text is only complete at finalize). Best-effort:
                    # COALESCE in the store keeps whatever earlier sample won.
                    sched = model_schedulers.get(row.get("model"))
                    try:
                        final = sched.get_request(rid) if sched else None
                        if final is not None:
                            done.update(_capture_payload(final))
                    except Exception:  # noqa: BLE001
                        pass
                    self._done.append(done)
                    self._done_ids.add(rid)
                    self._dirty_ids.add(rid)
                    del self._active[rid]
            # stale active rows (engine vanished mid-flight)
            for rid in list(self._active):
                if now - self._active[rid].get("ts", now) > ACTIVE_STALE_S:
                    self._dirty_ids.add(rid)
                    self._miss_counts.pop(rid, None)
                    del self._active[rid]
            self._sampled_at = now

    # ------------------------------------------------------------------
    def list_rows(self, limit: int = 30) -> list[dict[str, Any]]:
        """Active + finished rows, newest first (UI feed shape)."""
        with self._lock:
            rows = list(self._active.values()) + list(self._done)
        rows.sort(key=lambda r: r.get("ts", 0.0), reverse=True)
        return rows[: max(1, min(limit, RING_LIMIT + len(self._active)))]

    def lookup(self, request_id: str) -> dict[str, Any] | None:
        """Row for one id from the ring buffer (active wins over done)."""
        with self._lock:
            row = self._active.get(request_id)
            if row is not None:
                return dict(row)
            for done in reversed(self._done):
                if done.get("id") == request_id:
                    return dict(done)
        return None

    def is_live(self, request_id: str) -> bool:
        """True while the id sits in the active (not-yet-departed) map."""
        with self._lock:
            return request_id in self._active

    # ------------------------------------------------------------------
    # RL3-GAP1 event-driven capture (exact, no tick race).
    #
    # Polling the scheduler snapshot can never see requests that live
    # between two ticks. The engine core itself calls add_request at birth
    # and _cleanup_request at departure — those are wrapped (instrument.py)
    # and feed these two methods. The tick-based sample() stays as the
    # fallback/informational path; hook rows are exact-final and win.
    # ------------------------------------------------------------------
    def note_birth(self, rid: str, model: str, request: Any) -> None:
        """Engine accepted a request: create the row exactly at birth."""
        if not rid:
            return
        row = {"id": rid, "state": "queued", "model": model or "",
               "origin": "real", "ts": time.time(),
               "prompt_tokens": getattr(request, "num_prompt_tokens", 0) or 0}
        try:
            row.update(_capture_payload(request))
        except Exception:  # noqa: BLE001 — capture must never reject a row
            pass
        with self._lock:
            if rid in self._done_ids:      # late birth event: ignore
                return
            prev = self._active.get(rid, {})
            merged = {**prev, **row}
            if row["state"] != prev.get("state"):
                self._dirty_ids.add(rid)
            self._active[rid] = merged

    def note_finalize(self, rid: str, model: str, snap: dict) -> None:
        """Engine cleaned the request up: terminal row with the exact
        final payload harvested from the drained collector."""
        if not rid or not snap.get("has_output"):
            return
        now = time.time()
        with self._lock:
            prev = self._active.pop(rid, None) or {}
            base = dict(prev) if prev else {"id": rid, "model": model or ""}
            text = snap.get("output_text") or ""
            n_out = snap.get("completion_tokens") or 0
            finish = snap.get("finish_reason") or ""
            prev_had_signal = bool(prev.get("completion_tokens")) or \
                prev.get("state") == "generating"
            state = "complete"
            error = None
            if not text and not n_out and not prev_had_signal:
                # nothing produced and nothing seen before — abort/error
                # departure. With prior signal we simply lack harvest data:
                # stay honest with what the tick path already recorded.
                state = "error"
                error = finish or "no output"
            row = {**base,
                   "id": rid, "model": model or base.get("model", ""),
                   "origin": base.get("origin", "real"),
                   "state": state, "error": error,
                   # CANCEL-1: an empty harvest finish must not erase a
                   # reason already recorded (cancel stamps 'aborted').
                   "finish": finish or base.get("finish") or None,
                   "ts": now}
            if n_out:
                row["completion_tokens"] = n_out
            if text:
                capped, trunc = _truncate(text)
                row["output"] = capped
                row["output_trunc"] = trunc
            params = snap.get("params")
            if params and not base.get("params"):
                row["params"] = params
            birth = base.get("ts")
            if birth and now > birth:
                dur = now - float(birth)
                if dur > 0 and n_out:
                    row["tps"] = round(n_out / dur, 1)
            self._done.append(row)
            self._done_ids.add(rid)
            self._miss_counts.pop(rid, None)
            if len(self._done_ids) > 4 * RING_LIMIT:
                # oldest first: evict against the done ring's contents
                self._done_ids &= {r["id"] for r in self._done}
            self._dirty_ids.add(rid)

    def drain_dirty(self) -> list[dict[str, Any]]:
        """State-changed rows since the last call (SSE deltas)."""
        with self._lock:
            ids, self._dirty_ids = self._dirty_ids, set()
            pool = {r["id"]: r for r in self._active.values()}
            pool.update({r["id"]: r for r in reversed(self._done)})
        return [pool[i] for i in ids if i in pool]

    async def cancel(self, engine_pool: Any, request_id: str) -> bool:
        """Abort *request_id* on whichever engine holds it.

        Uses AsyncEngineCore.abort_request — the same path client-disconnect
        cancellation takes: it enqueues the deferred scheduler abort AND
        signals the HTTP output collector, so the waiting handler returns.
        (A raw scheduler.abort_request would free KV blocks but orphan the
        HTTP request.) Engines without an AsyncEngineCore (DFlash fallback)
        get the raw scheduler abort as best effort.
        """
        entries = getattr(engine_pool, "_entries", {}) or {} if engine_pool else {}
        for model_id in list(entries):
            try:
                entry = entries.get(model_id)
                if entry is None or getattr(entry, "engine", None) is None:
                    continue
                async_core = getattr(entry.engine, "_engine", None)
                sched = _find_scheduler(entry)
                if sched is None:
                    continue
                snap = sched.snapshot_for_admin()
                ids = {r.request_id for r in snap.get("waiting", [])}
                ids |= set(snap.get("running_by_id", {}))
                known = request_id in ids or sched.get_request(request_id) is not None
                if not known:
                    continue
                # CANCEL-1: stamp BEFORE issuing the abort. The engine's
                # _cleanup_request can finalize (and pop) the row while
                # abort_request is still awaited — stamping afterwards
                # lost the race and left finish=None (indistinguishable
                # from a clean completion). If the abort fails on this
                # engine the stamp is rolled back before we try the next.
                with self._lock:
                    row = self._active.get(request_id)
                    stamped = row is not None
                    prev_state = prev_finish = None
                    if stamped:
                        prev_state = row.get("state")
                        prev_finish = row.get("finish", _NO_FINISH)
                        row["state"] = "cancelling"
                        row["finish"] = "aborted"
                        row["ts"] = time.time()
                        self._dirty_ids.add(request_id)
                if async_core is not None and hasattr(async_core, "abort_request"):
                    ok = bool(await async_core.abort_request(request_id))
                else:
                    ok = bool(sched.abort_request(request_id))
                if not ok and stamped:
                    with self._lock:
                        row = self._active.get(request_id)
                        if row is not None:
                            row["state"] = prev_state
                            if prev_finish is _NO_FINISH:
                                row.pop("finish", None)
                            else:
                                row["finish"] = prev_finish
                return ok
            except Exception:  # noqa: BLE001
                continue
        return False


def _find_output_collectors(entry: Any) -> dict:
    """AsyncEngineCore's per-request output collectors (same walk as the
    admin stats route). Holder objects expose `.output` — a cumulative
    RequestOutput whose output_text/finish_reason update as tokens decode.
    """
    try:
        async_core = getattr(entry.engine, "_engine", None) if entry else None
        core = getattr(async_core, "engine", None) if async_core else None
        return getattr(core, "_output_collectors", {}) or {} if core else {}
    except Exception:  # noqa: BLE001
        return {}


def _collector_payload(collector: Any) -> dict:
    """RL-2 live tail: output/finish from the collector's latest aggregate."""
    try:
        out = getattr(collector, "output", None)
        if out is None:
            return {}
        res = {}
        text = getattr(out, "output_text", "") or ""
        if text:
            capped, trunc = _truncate(text, PAYLOAD_CAP)
            res["output"] = capped
            res["output_trunc"] = trunc
        fr = getattr(out, "finish_reason", None)
        if fr:
            res["finish"] = fr
        return res
    except Exception:  # noqa: BLE001
        return {}


def _find_scheduler(entry: Any) -> Any:
    """Same walk the admin stats route uses (AsyncEngineCore, else DFlash)."""
    if entry is None or getattr(entry, "engine", None) is None:
        return None
    async_core = getattr(entry.engine, "_engine", None)
    if async_core is not None:
        core = getattr(async_core, "engine", None)
        return getattr(core, "scheduler", None) if core else None
    return getattr(entry.engine, "scheduler", None)


def _rows_from_snapshot(snap: dict[str, Any], model_id: str, now: float):
    """Yield (request_id, row) for every request visible in one snapshot.

    ``now`` is wall-clock (row ts for the UI). Scheduler timing fields
    (arrival_time, generation_started_at) are CLOCK_MONOTONIC — the same
    basis the stats route uses — so elapsed math stays on monotonic.
    """
    mono = time.monotonic()
    for req in snap.get("waiting", []):
        rid = getattr(req, "request_id", "")
        row = {
            "id": rid, "state": "queued", "model": model_id, "origin": "real",
            "prompt_tokens": getattr(req, "num_prompt_tokens", 0) or 0,
            "ts": now,
        }
        row.update(_capture_payload(req))   # RL-1 best-effort, never fatal
        yield rid, row
    running = snap.get("running_by_id", {})
    for rid, req in running.items():
        # prefill vs generate: generation_started_at is set on the first decode
        gen_start = getattr(req, "generation_started_at", None)
        state = "generating" if gen_start else "prefilling"
        generated = getattr(req, "num_output_tokens", 0) or 0
        elapsed = (mono - gen_start) if gen_start else None
        tps = generated / elapsed if elapsed and elapsed > 0 else 0.0
        row = {
            "id": rid, "state": state, "model": model_id, "origin": "real",
            "prompt_tokens": getattr(req, "num_prompt_tokens", 0) or 0,
            "completion_tokens": generated,
            "tps": round(tps, 1),
            "ts": now,
        }
        row.update(_capture_payload(req))   # RL-1 best-effort, never fatal
        if state == "generating":
            # RL-4: private token tail for the loop detector; the scheduler's
            # Request keeps output_token_ids even when a streaming consumer
            # has drained the text collector. Consumed (popped) in sample().
            toks = getattr(req, "output_token_ids", None)
            if toks:
                row["_tok_tail"] = list(toks)[-LOOP_TOK_WINDOW:]
        yield rid, row


_tracker: RequestTracker | None = None
_tracker_lock = threading.Lock()


def get_request_tracker() -> RequestTracker:
    global _tracker
    with _tracker_lock:
        if _tracker is None:
            _tracker = RequestTracker()
        return _tracker
