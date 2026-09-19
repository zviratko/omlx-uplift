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
            # token-id prompt: no tokenizer in the tracker — describe it
            out["prompt"] = f"(tokenized prompt, {len(prompt)} tokens)"
            out["prompt_trunc"] = False
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
        # ids of rows whose state changed since the last drain (for SSE)
        self._dirty_ids: set[str] = set()
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
                prev = self._active.get(rid, {})
                merged = {**prev, **row}
                # RL-2 live tail: the per-request output collector carries the
                # cumulative decoded text — that is the ONLY source that
                # grows while generating (Request.output_text lands at
                # finalize only). Skip the prefill phase (no collector yet).
                coll = model_collectors.get(row.get("model"), {}).get(rid)
                if coll is not None:
                    merged.update(_collector_payload(coll))
                if merged.get("state") != prev.get("state"):
                    self._dirty_ids.add(rid)
                self._active[rid] = merged
            # departed rows -> complete. Only when the row's own model was
            # sampled OK this pass (a failed sample says nothing about absence).
            for rid in list(self._active):
                if rid in seen:
                    continue
                row = self._active[rid]
                if row.get("model") not in sampled_models:
                    continue
                if row.get("state") in ("queued", "prefilling", "generating",
                                        "cancelling"):
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
                    self._dirty_ids.add(rid)
                    del self._active[rid]
            # stale active rows (engine vanished mid-flight)
            for rid in list(self._active):
                if now - self._active[rid].get("ts", now) > ACTIVE_STALE_S:
                    self._dirty_ids.add(rid)
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
                if async_core is not None and hasattr(async_core, "abort_request"):
                    ok = bool(await async_core.abort_request(request_id))
                else:
                    ok = bool(sched.abort_request(request_id))
                if ok:
                    with self._lock:
                        row = self._active.get(request_id)
                        if row is not None:
                            row["state"] = "cancelling"
                            row["ts"] = time.time()
                            self._dirty_ids.add(request_id)
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
        yield rid, row


_tracker: RequestTracker | None = None
_tracker_lock = threading.Lock()


def get_request_tracker() -> RequestTracker:
    global _tracker
    with _tracker_lock:
        if _tracker is None:
            _tracker = RequestTracker()
        return _tracker
