"""GLOBAL BENCH QUEUE — one cross-type FIFO in front of every native bench.

User request (2026-10-13, items 6+7): intelligence already queues accuracy
runs WITHIN its own type, and the other benches answered a busy engine with
a bare 409. That makes staging an evening of runs impossible — you have to
sit at the board and re-click. This module owns the missing layer: a run
arriving while ANY bench (any type, incl. the accuracy queue and ANE
tuning) holds the engine is appended to a queue and started by a pump when
the slot frees, FIFO across the five kinds.

Why a pump task and not a per-run callback chain: every engine keeps its
OWN contention rule (decision/embed have `_active`, throughput/context/ANE
have classic's get_active_run, accuracy has classic's queue). None of them
can see the others, and the classic modules are upstream files we never
patch. A single observer that asks "is the machine free?" before starting
the NEXT thing is the only shape that works across all five without
touching upstream, and it is also the shape the engines already agree on:
`start()` raises Conflict when busy, so the pump just retries what a human
would have re-clicked.

Boundaries:
- ANE tuning is a BUSY signal, never a queue member. Its "apply" step is a
  human looking at a recommendation and pressing save; a tuning that fires
  by itself at 03:00 from a queue would change model settings nobody is
  there to accept (routers/bench.py keeps 409 for it, with the comment).
- Entries store the raw request body, so a queued run starts with exactly
  the spec the click produced — including `upload`, which the engines strip
  at their own boundary.
- Garbage never sits in the queue: `submit()` runs the owning engine's pure
  validation first (decision/embed `validate_body`, classic's pydantic
  request models where they exist) and rejects with BadInput. Validation
  that needs a live engine is skipped here and still fails at dispatch.

Test seam (tests/test_bench_queue.py is pure-asyncio and never imports
omlx): every engine touch goes through a module-level lookup table —
DISPATCH / CANCELS / VALIDATORS / BUSY / POOL. Tests replace table entries
or whole tables; nothing else in the module reaches for an engine.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Optional

logger = logging.getLogger("uplift.bench_queue")

# The queueable bench kinds (ANE tuning is deliberately NOT one of them).
KINDS: tuple[str, ...] = ("decision", "embed", "throughput", "context",
                          "accuracy")

# An engine that refuses a dispatch (Conflict/NotReady) is retried this many
# times before the entry fails — a real conflict normally clears on the
# first retry, so 3 is generous without letting a wedged engine spin.
MAX_ATTEMPTS = 3
# Pump poll period while the queue waits for the single engine slot.
POLL_S = 2.0
# done/failed entries stay on the board (the UI shows what ran and what
# broke); older terminal rows are dropped beyond this many.
MAX_KEEP_TERMINAL = 25

# Kinds whose live start needs the server's engine pool AT DISPATCH TIME.
# The pool is re-fetched when the entry runs, never captured at submit:
# a pool captured behind the queue would be a stale object after a restart
# (`server can restart-wedge`), and `None` at dispatch means "not ready
# yet" -> wait, not fail.
_NEEDS_POOL = frozenset({"embed", "throughput", "context", "accuracy"})


class Conflict(Exception):
    """The engine slot is taken — the queue's own retry signal."""


class NotReady(Exception):
    """A dependency is not up yet (pool, env) — retry, do not fail."""


class NotFound(Exception):
    """Unknown qid (or, at dispatch, an unknown model)."""


class BadInput(Exception):
    """Body can never be valid: fail the entry, never retry it."""


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------

_entries: list[dict] = []
_pump: Optional["asyncio.Task[None]"] = None


def _new_entry(kind: str, body: dict, label: str) -> dict:
    return {
        "qid": uuid.uuid4().hex[:12],
        "kind": kind,
        "label": label or _auto_label(kind, body),
        "body": dict(body or {}),
        "status": "queued",          # queued|running|failed|done
        "error": None,
        "run_id": None,
        "queued_at": time.time(),
        # bookkeeping (additive, harmless to the board):
        "attempts": 0,
        "started_at": None,
        "finished_at": None,
    }


def _snapshot(entry: dict) -> dict:
    """Shallow copy — the body rides along so the client can show
    model + tasks of a queued run without a second fetch."""
    return dict(entry)


def _position(entry: dict) -> int:
    """1-based place among what is still waiting (running is not 'ahead')."""
    n = 0
    for e in _entries:
        if e["status"] != "queued":
            continue
        if e is entry:
            return n + 1
        n += 1
    return 0


def _queued() -> list[dict]:
    return [e for e in _entries if e["status"] == "queued"]


def _find(qid: str) -> Optional[dict]:
    for e in _entries:
        if e["qid"] == qid:
            return e
    return None


def _trim() -> None:
    terminal = [e for e in _entries if e["status"] in ("done", "failed")]
    for stale in terminal[:max(0, len(terminal) - MAX_KEEP_TERMINAL)]:
        _entries.remove(stale)


# ---------------------------------------------------------------------------
# busy probes — the ONLY place the queue asks "is the machine free?"
# True busy / False free / None unknown (engine or omlx absent => free)
# ---------------------------------------------------------------------------

def _mod(name: str):
    try:
        from importlib import import_module
        return import_module(f".{name}", __package__)
    except Exception:
        return None


def _busy_decision() -> Optional[bool]:
    m = _mod("decision_engine")
    if m is None:
        return None
    try:
        return m.active_run() is not None
    except Exception:
        return None


def _busy_embed() -> Optional[bool]:
    m = _mod("embed_engine")
    if m is None:
        return None
    try:
        if m.active_run() is not None:
            return True
        # U86: an mteb-env build (torch download) holds the same slot the
        # embed run is about to need — start() itself refuses then.
        return bool(getattr(m, "_building", False))
    except Exception:
        return None


def _busy_throughput() -> Optional[bool]:
    """bench_engine has no module-level registry of its own: the run object
    lives in classic's registry, and `active_summary()` is its accessor
    (it reads `_engine().get_active_run()`, omlx.admin.benchmark)."""
    m = _mod("bench_engine")
    if m is None:
        return None
    try:
        return bool(m.active_summary().get("running"))
    except Exception:
        return None


def _busy_context() -> Optional[bool]:
    m = _mod("context_engine")
    if m is None:
        return None
    try:
        return bool(m.context_active().get("running"))
    except Exception:
        return None


def _busy_ane() -> Optional[bool]:
    m = _mod("context_engine")
    if m is None:
        return None
    try:
        return m._ane().get_active_run() is not None
    except Exception:
        return None


def _busy_accuracy() -> Optional[bool]:
    """classic's own queue counts as busy while it runs OR still has rows
    waiting (accuracy_engine.queue_add hands off to that queue). The import
    is lazy like accuracy_engine._acc(): without omlx (unit tests, the
    standalone viewer) nothing can be running here -> idle."""
    try:
        from omlx.admin import accuracy_benchmark as AB
    except Exception:
        return None
    try:
        st = AB.get_queue_status()
    except Exception:
        return None
    return bool(st.get("running")) or bool(st.get("queue"))


def _busy_prefill() -> Optional[bool]:
    """The uplift-native prefill probe (bench_prefill) holds the same engine
    slot as every other bench and has NO classic-side registry. Lazy module
    lookup like the other probes: without omlx nothing can be running."""
    m = _mod("bench_prefill")
    if m is None:
        return None
    try:
        return m.get_active_run() is not None
    except Exception:
        return None


BUSY: dict[str, Callable[[], Optional[bool]]] = {
    "decision": _busy_decision,
    "embed": _busy_embed,
    "throughput": _busy_throughput,
    "context": _busy_context,
    "ane": _busy_ane,
    "accuracy": _busy_accuracy,
    # PREFILL-4 (user item 4): the uplift-native prefill probe owns the
    # same single engine slot but lives in NO classic registry, so classic
    # cannot be told about it without editing vanilla. Registering it HERE
    # is the uplift-side half: while a probe runs, every native bench start
    # goes into the FIFO instead of onto the engine. (Probe-only, like
    # 'ane' — it is never itself a queue member.)
    "prefill": _busy_prefill,
}

# qid-independent kind -> probe key (ane is probe-only, never queued)
_REASONS = {
    "decision": "a decision benchmark is running",
    "embed": "an embeddings/reranker benchmark is running (or its mteb env "
             "is being built)",
    "throughput": "a throughput benchmark is running",
    "context": "a context probe is running",
    "ane": "an ANE tuning is running",
    "prefill": "an uplift prefill/parallel probe is running",
    "accuracy": "the accuracy benchmark queue is busy",
}


def _busy_now() -> Optional[str]:
    """Human reason the engine slot is taken, or None when it is free.
    A probe that cannot answer (None) never blocks the queue."""
    for name, probe in BUSY.items():
        try:
            verdict = probe()
        except Exception as e:      # a broken probe must not wedge the pump
            logger.debug("bench queue probe %s failed: %s", name, e)
            continue
        if verdict:
            return _REASONS.get(name, name)
    return None


def _queue_reason() -> Optional[str]:
    """Someone is already waiting — going around them would jump the FIFO."""
    waiting = _queued()
    if not waiting:
        return None
    head = waiting[0]
    return (f"{len(waiting)} benchmark(s) already queued "
            f"(next: {head['kind']} {head['label']})")


async def idle() -> bool:
    """Is the single bench slot free (no run of ANY kind running)?

    Deliberately blind to the queue itself: the pump asks this to decide
    whether it may start the head entry, and 'entries are waiting' is the
    reason to ask, not a reason to wait more.
    """
    return _busy_now() is None


async def busy_check(kind: Optional[str] = None) -> Optional[str]:
    """Router hook: reason to QUEUE this start instead of launching it now.

    Two signals: the slot itself (`_busy_now`) and anyone already waiting
    (`_queue_reason`) — starting a fresh run around a non-empty queue would
    jump the FIFO and could double-book the engine the moment the current
    run ends.
    """
    return _queue_reason() or _busy_now()


# ---------------------------------------------------------------------------
# dispatch tables (the test seam)
# ---------------------------------------------------------------------------

def _pool() -> Any:
    """Live engine pool — re-read at dispatch time, never captured."""
    try:
        from .routers.base import engine_pool
        return engine_pool()
    except Exception:
        return None


#: callable() -> pool | None. A table so tests do not need routers/base.
POOL: Callable[[], Any] = _pool


async def _start_decision(entry: dict) -> Any:
    m = _mod("decision_engine")
    return await m.start(entry["body"])


def _live_pool() -> Any:
    """Pool for a dispatch that needs one. `_wait_pool` already refused to
    dispatch while it is missing; this is the race guard (pool vanishes
    between the check and the call) -> retry, never crash a run task."""
    pool = POOL()
    if pool is None:
        raise NotReady("engine pool is not available yet")
    return pool


async def _start_embed(entry: dict) -> Any:
    m = _mod("embed_engine")
    return await m.start(entry["body"], _live_pool())


async def _start_throughput(entry: dict) -> Any:
    m = _mod("bench_engine")
    body = dict(entry["body"] or {})
    upload = bool(body.pop("upload", False))
    # uplift-only cache-off flags: re-popped at the same boundary as
    # upload and handed back as kwargs — classic's request model never
    # sees them (identical rule to the start route).
    no_hot_cache = bool(body.pop("no_hot_cache", False))
    no_ssd_cache = bool(body.pop("no_ssd_cache", False))
    return await m.start(body, _live_pool(), upload=upload,
                         no_hot_cache=no_hot_cache, no_ssd_cache=no_ssd_cache)


async def _start_context(entry: dict) -> Any:
    m = _mod("context_engine")
    return await m.context_start(entry["body"], _live_pool())


async def _start_accuracy(entry: dict) -> Any:
    m = _mod("accuracy_engine")
    body = dict(entry["body"] or {})
    upload = bool(body.pop("upload", False))
    return await m.queue_add(body, _live_pool(), upload=upload)


DISPATCH: dict[str, Callable[[dict], Any]] = {
    "decision": _start_decision,
    "embed": _start_embed,
    "throughput": _start_throughput,
    "context": _start_context,
    "accuracy": _start_accuracy,
}


async def _cancel_decision(entry: dict) -> Any:
    m = _mod("decision_engine")
    run = m.get(entry["run_id"]) if entry.get("run_id") else m.active_run()
    if run is None:
        return None
    return await m.cancel(run)


async def _cancel_embed(entry: dict) -> Any:
    m = _mod("embed_engine")
    run = m.get(entry["run_id"]) if entry.get("run_id") else m.active_run()
    if run is None:
        return None
    return await m.cancel(run)


async def _cancel_throughput(entry: dict) -> Any:
    m = _mod("bench_engine")
    run = m.get(entry["run_id"]) if entry.get("run_id") else None
    if run is None:
        return None
    return await m.cancel(run)


async def _cancel_context(entry: dict) -> Any:
    m = _mod("context_engine")
    run = m.context_get(entry["run_id"]) if entry.get("run_id") else None
    if run is None:
        return None
    return await m.context_cancel(run)


async def _cancel_accuracy(entry: dict) -> Any:
    """classic exposes no per-run accuracy cancel from the outside — the
    only honest control is its queue cancel, which stops the running suite
    AND drains the classic queue. Removing ONE global-queue accuracy entry
    is a deliberate 'stop accuracy now'; the queue's own rows for accuracy
    are separate and stay visible to the classic board."""
    m = _mod("accuracy_engine")
    return await m.cancel()


CANCELS: dict[str, Callable[[dict], Any]] = {
    "decision": _cancel_decision,
    "embed": _cancel_embed,
    "throughput": _cancel_throughput,
    "context": _cancel_context,
    "accuracy": _cancel_accuracy,
}


def _need_model_id(body: dict) -> None:
    if not str((body or {}).get("model_id") or "").strip():
        raise BadInput("model_id required")


def _validate_decision(body: dict) -> None:
    m = _mod("decision_engine")
    if m is not None:
        m.validate_body(body or {})   # pure: packs exist, limit in range


def _validate_embed(body: dict) -> None:
    m = _mod("embed_engine")
    if m is not None:
        m.validate_body(body or {})   # pure: kind + curated task names


def _validate_throughput(body: dict) -> None:
    _need_model_id(body)
    m = _mod("bench_engine")
    if m is None:
        return
    try:
        Req = m.request_model()
    except Exception:
        return                        # no omlx: the engine re-checks later
    # NOT a fingerprint: this filter feeds the classic pydantic model for
    # PRE-DISPATCH body validation, and it must stay blind to exactly the
    # uplift-only keys the start route pops (upload, and the cache-off
    # flags that ride the stored body). Nothing in classic's schema cares
    # about them; a queued run's flags must never 400 its own submit.
    clean = {k: v for k, v in (body or {}).items()
             if k not in ("upload", "no_hot_cache", "no_ssd_cache")}
    try:
        Req(**clean)
    except Exception as e:
        raise BadInput(str(e)) from e


def _validate_context(body: dict) -> None:
    # classic's ContextBenchmarkRequest whitelist is deliberately bypassed
    # by context_engine (U50) — validating through it here would 400 sizes
    # the probe accepts. Only the engine's OWN uplift floor is mirrored.
    _need_model_id(body)
    tgt = (body or {}).get("target_tokens")
    if tgt is None:
        return
    m = _mod("context_engine")
    floor = getattr(m, "_CTX_MIN_TARGET", 2048) if m is not None else 2048
    if isinstance(tgt, bool) or not isinstance(tgt, int) or tgt < floor:
        raise BadInput(f"Invalid target {tgt!r}. Must be a whole number of "
                       f"at least {floor} tokens.")


def _validate_accuracy(body: dict) -> None:
    _need_model_id(body)
    bm = (body or {}).get("benchmarks")
    if not isinstance(bm, dict) or not bm:
        raise BadInput("benchmarks: non-empty map required")


VALIDATORS: dict[str, Callable[[dict], None]] = {
    "decision": _validate_decision,
    "embed": _validate_embed,
    "throughput": _validate_throughput,
    "context": _validate_context,
    "accuracy": _validate_accuracy,
}


def _is_bad_input(exc: BaseException) -> bool:
    return "BadInput" in {c.__name__ for c in type(exc).__mro__}


def _is_retryable(exc: BaseException) -> bool:
    names = {c.__name__ for c in type(exc).__mro__}
    if names & {"BadInput", "NotFound", "ValidationError", "ValueError",
                "TypeError", "KeyError", "AttributeError"}:
        return False
    return bool(names & {"Conflict", "NotReady", "TimeoutError"})


def _auto_label(kind: str, body: dict) -> str:
    mid = str((body or {}).get("model_id") or "?")
    if kind == "decision":
        return f"{mid} · {len((body or {}).get('packs') or [])} pack(s)"
    if kind == "embed":
        k = str((body or {}).get("kind") or "embed")
        return f"{k} {mid} · {len((body or {}).get('tasks') or [])} task(s)"
    if kind == "accuracy":
        return f"{mid} · {len((body or {}).get('benchmarks') or {})} suite(s)"
    if kind == "throughput":
        return f"{mid} · {len((body or {}).get('prompt_lengths') or [])} len(s)"
    tgt = (body or {}).get("target_tokens")
    return f"{mid} · target {tgt}" if tgt else mid


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

async def submit(kind: str, body: dict, label: str = "") -> dict:
    """Append one bench request and make sure a pump exists.

    Validates FIRST: an entry that can never start must not occupy a queue
    slot or fail silently at 03:00 — the caller gets BadInput, the same 400
    the live engine would have raised.
    """
    if kind not in KINDS:
        raise BadInput(f"unknown bench kind: {kind}")
    validator = VALIDATORS.get(kind)
    if validator is not None:
        try:
            validator(body or {})
        except Exception as e:
            if _is_bad_input(e):
                raise BadInput(str(e)) from e
            # a validator that could not run (engine import failed) is not
            # a verdict — dispatch re-checks with the real engine.
            logger.debug("bench queue validator %s skipped: %s", kind, e)
    entry = _new_entry(kind, body or {}, label)
    _entries.append(entry)
    _trim()
    _ensure_pump()
    logger.info("bench queue: queued %s (%s) %s at position %d",
                entry["qid"], kind, entry["label"], _position(entry))
    snap = _snapshot(entry)
    snap["queued"] = True
    snap["position"] = _position(entry)
    return snap


async def remove(qid: str) -> dict:
    """Drop a queued entry, or cancel + drop a running one."""
    entry = _find(qid)
    if entry is None:
        raise NotFound(f"queue entry not found: {qid}")
    was = entry["status"]
    cancelled = False
    if was == "running":
        cancel = CANCELS.get(entry["kind"])
        if cancel is not None:
            try:
                await cancel(entry)
                cancelled = True
            except Exception as e:
                # the engine says it is not ours to stop any more (already
                # terminal): the entry still leaves the queue — that is the
                # user's intent, and the reason stays on the row.
                entry["error"] = f"cancel: {e}"
                logger.info("bench queue: cancel of %s (%s) refused: %s",
                            qid, entry["kind"], e)
    entry["status"] = "done"
    entry["finished_at"] = time.time()
    _trim()
    logger.info("bench queue: removed %s (%s, was %s)", qid,
                entry["kind"], was)
    return {"status": "removed", "qid": qid, "kind": entry["kind"],
            "was": was, "cancelled": cancelled, "entries": status()["entries"]}


def status() -> dict:
    """The board: every entry (shallow copies, bodies included) + idle flag.

    'idle' here means 'nothing is running AND nothing is waiting' — what a
    poller wants to know. The pump's own question ('may I start the head?')
    is `idle()`, which only looks at the engines.
    """
    _reconcile()
    reason = _busy_now() or _queue_reason()
    return {
        "idle": reason is None,
        "busy_reason": reason,
        "queued": len(_queued()),
        "running": [e["qid"] for e in _entries if e["status"] == "running"],
        "entries": [_snapshot(e) for e in _entries],
    }


def clear() -> None:
    """Board reset (tests + a deliberate 'forget the queue')."""
    _entries.clear()


# ---------------------------------------------------------------------------
# the pump
# ---------------------------------------------------------------------------

def _ensure_pump() -> None:
    global _pump
    loop = asyncio.get_running_loop()
    if _pump is not None and not _pump.done():
        try:
            if _pump.get_loop() is loop:
                return
            # a task bound to a dead loop (tests run one loop per case, a
            # server restart replaces it) can never drain our queue again
            _pump.cancel()
        except Exception:
            pass
    _pump = loop.create_task(_pump_loop())


def _reconcile() -> None:
    """Running entries whose engine no longer reports a run are done."""
    for e in _entries:
        if e["status"] != "running":
            continue
        probe = BUSY.get(e["kind"])
        if probe is None:
            continue
        try:
            verdict = probe()
        except Exception:
            continue
        if verdict is False:
            e["status"] = "done"
            e["finished_at"] = time.time()
            logger.info("bench queue: %s (%s) finished", e["qid"], e["kind"])


def _wait_pool(entry: dict) -> bool:
    """Pool-needing kind while the server has no pool -> not idle yet."""
    if entry["kind"] not in _NEEDS_POOL:
        return False
    try:
        return POOL() is None
    except Exception:
        return True


async def _dispatch(entry: dict) -> bool:
    """Start one entry. True = consumed (running/failed), False = requeued."""
    starter = DISPATCH.get(entry["kind"])
    if starter is None:
        _fail(entry, f"no dispatcher for kind {entry['kind']}")
        return True
    entry["attempts"] = int(entry.get("attempts") or 0) + 1
    try:
        res = await starter(entry)
    except asyncio.CancelledError:
        entry["status"] = "queued"
        entry["attempts"] = 0
        raise
    except Exception as e:
        if _is_retryable(e) and entry["attempts"] < MAX_ATTEMPTS:
            entry["status"] = "queued"
            entry["error"] = (f"engine busy, retry "
                              f"{entry['attempts']}/{MAX_ATTEMPTS}: {e}")
            logger.info("bench queue: %s (%s) refused, will retry: %s",
                        entry["qid"], entry["kind"], e)
            return False
        _fail(entry, str(e) or type(e).__name__)
        return True
    entry["run_id"] = _run_id(res)
    entry["status"] = "running"
    entry["error"] = None
    entry["started_at"] = time.time()
    logger.info("bench queue: started %s (%s) run_id=%s", entry["qid"],
                entry["kind"], entry["run_id"])
    return True


def _run_id(res: Any) -> Optional[str]:
    """Engines name their id differently (run_id / bench_id / tuning_id);
    accuracy hands back its queue status."""
    if isinstance(res, str):
        return res
    if isinstance(res, dict):
        for key in ("run_id", "bench_id", "tuning_id", "current_bench_id"):
            if res.get(key):
                return str(res[key])
    for attr in ("run_id", "bench_id", "tuning_id"):
        v = getattr(res, attr, None)
        if v:
            return str(v)
    return None


def _fail(entry: dict, reason: str) -> None:
    entry["status"] = "failed"
    entry["error"] = reason
    entry["finished_at"] = time.time()
    logger.warning("bench queue: %s (%s) failed: %s", entry["qid"],
                   entry["kind"], reason)


async def _pump_loop() -> None:
    """FIFO drainer: exists only while something waits, sleeps otherwise."""
    global _pump
    try:
        while True:
            waiting = _queued()
            if not waiting:
                return
            try:
                _reconcile()
                head = waiting[0]
                if await idle() and not _wait_pool(head):
                    await _dispatch(head)
                    # let the started run register itself busy before the
                    # next round, or the pump would dispatch two at once
                    await asyncio.sleep(0)
                else:
                    await asyncio.sleep(POLL_S)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # a broken entry must never kill the drainer: the queue is
                # the only thing standing between a click and a 409
                logger.warning("bench queue pump error: %s", e)
                await asyncio.sleep(POLL_S)
    finally:
        _pump = None
