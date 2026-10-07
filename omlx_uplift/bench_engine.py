"""REPL-1: native throughput bench — in-process reuse of classic's engine.

NAT-2 froze the component choice; the card's question here was reuse-vs-
copy. VERDICT: REUSE — no copy needed (facts from the installed dev-keg
module, omlx/admin/benchmark.py):

- Everything the classic routes use is module-level public API:
  BenchmarkRequest, create_run, get_run, get_active_run, cleanup_old_runs,
  run_benchmark(run, engine_pool). The BenchmarkRun object itself carries
  the SSE delivery model (append-only `events` under `cond` + `terminal`),
  so replay-after-reconnect and multi-tab attach need ZERO ported logic —
  classic's own route only reads those fields (its
  test_benchmark_sse_replay.py pins that model upstream; we reuse the
  loop shape verbatim in event_stream()).
- The only route-level logic we own is the contention policy (409 trio),
  model validation and the auth gate — importing classic's route
  FUNCTIONS instead would drag their Depends(require_admin) along.
- Community upload is AUTO in classic (run_benchmark → _upload_to_omlx_ai
  on every completed standard-local run; no settings gate exists there).
  The card demands 'upload must remain opt-in and skippable', so our
  wrapper defaults to SKIP and only runs classic's unmodified upload path
  when the caller passes upload:true. Implementation = module-attribute
  swap of B._upload_to_omlx_ai RESTORED in finally: safe to scope because
  throughput runs are 1-at-a-time ACROSS both paths (classic's start
  checks the same get_active_run registry this module writes to), and the
  classic source file stays untouched. External-endpoint runs never
  upload — classic's own rule (benchmark.py:2285), we do not override it.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger("omlx_uplift.bench")


def _engine():
    """Lazy import: this module must stay importable without omlx (CI)."""
    from omlx.admin import benchmark as B
    return B


def request_model():
    return _engine().BenchmarkRequest


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


class BadInput(Exception):
    pass


class NotRunning(Exception):
    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


# --------------------------------------------------------------------------
# lifecycle
# --------------------------------------------------------------------------

async def start(body: dict, pool: Any, *, upload: bool = False) -> dict:
    """Validate + launch one throughput run. Mirrors classic's route
    contract: 409 contention (bench/context/ANE), 404 unknown model,
    400 invalid request. No awaits between the active-run checks and
    create_run — the single event loop makes the claim atomic, and
    classic's start checks the same registry, so the 1-at-a-time rule
    holds across the classic and native paths together."""
    B = _engine()

    active = B.get_active_run()
    if active is not None:
        raise Conflict(
            "A throughput benchmark is already running "
            f"(bench_id={active.bench_id}, model_id={active.request.model_id}).")
    try:
        from omlx.admin import context_benchmark as CTX
        if CTX.get_active_run() is not None:
            raise Conflict("A context benchmark is already running.")
    except ImportError:  # keg layout without the module: no contention to check
        pass
    try:
        from omlx.admin import ane_tuning as ANE
        if ANE.get_active_run() is not None:
            raise Conflict("ANE tuning is already running.")
    except ImportError:
        pass

    try:
        bench_request = B.BenchmarkRequest(**body)
    except Exception as e:
        raise BadInput(str(e)) from e

    if bench_request.external is None:
        entry = pool.get_entry(bench_request.model_id)
        if entry is None:
            raise NotFound(f"Model not found: {bench_request.model_id}")
        if entry.model_type not in ("llm", "vlm", None):
            raise BadInput(
                f"Model {bench_request.model_id} is not a supported model "
                f"(type: {entry.model_type})")

    B.cleanup_old_runs()
    run = B.create_run(bench_request)
    upload_allowed = upload and bench_request.external is None
    run.task = asyncio.create_task(_runner(run, pool, upload_allowed))
    total_tests = len(bench_request.prompt_lengths) + len(bench_request.batch_sizes) * 2
    logger.info(
        f"uplift native bench started: {run.bench_id} model={bench_request.model_id} "
        f"tests={total_tests} upload={'on' if upload_allowed else 'off'}")
    return {"bench_id": run.bench_id, "status": "started",
            "total_tests": total_tests, "upload": upload_allowed}


async def _runner(run, pool: Any, upload_allowed: bool) -> None:
    B = _engine()
    if upload_allowed:
        await B.run_benchmark(run, pool)
        return
    # opt-out: neutralize the auto-upload for THIS run window only, then
    # restore the module attribute (classic path untouched afterwards).
    orig = B._upload_to_omlx_ai

    async def _skipped(run_arg, _pool_arg):
        run_arg.upload_state["phase"] = "skipped"
        run_arg.upload_state["skipped_reason"] = "uplift_opt_out"
        await B._send_event(run_arg, {
            "type": "upload_skipped",
            "reason": "uplift_opt_out",
            "features": list(getattr(run_arg, "feature_flags", [])),
        })

    B._upload_to_omlx_ai = _skipped
    try:
        await B.run_benchmark(run, pool)
    finally:
        B._upload_to_omlx_ai = orig
    # belt & braces: guarantee a terminal event exists even if the engine
    # died outside classic's covered try-blocks (pre-try raise)
    if not run.terminal:
        await B._send_event(run, {"type": "error",
                                  "message": "benchmark ended without terminal event"})


# --------------------------------------------------------------------------
# read/control surface (classic route contract shapes)
# --------------------------------------------------------------------------

def active_summary() -> dict:
    B = _engine()
    run = B.get_active_run()
    if run is None:
        return {"running": False, "bench_id": None, "model_id": None,
                "context_profile": None}
    return {
        "running": True,
        "bench_id": run.bench_id,
        "model_id": run.request.model_id,
        "context_profile": run.request.context_profile.value,
        "force_lm_engine": run.request.force_lm_engine,
        # classic parity: never expose base_url/api_key — model_id already
        # carries the external model name.
        "external": run.request.external is not None,
    }


def get(bench_id: str):
    return _engine().get_run(bench_id)


async def cancel(run) -> dict:
    if run.status != "running":
        raise NotRunning(run.status)
    if run.task and not run.task.done():
        run.task.cancel()
    return {"status": "cancelled", "bench_id": run.bench_id}


def results_payload(run) -> dict:
    return {
        "bench_id": run.bench_id,
        "status": run.status,
        "context_profile": run.request.context_profile.value,
        "results": run.results,
        "error": run.error_message if run.error_message else None,
        "upload_state": run.upload_state,
    }


async def event_stream(run, *, keepalive_s: float = 60.0) -> AsyncIterator[str]:
    """Replay-then-attach SSE generator reading only the classic run
    object's documented fields — the delivery model pinned upstream by
    test_benchmark_sse_replay.py (terminal events: upload_done /
    upload_skipped / error; `done` only marks tests→upload boundary)."""
    seen = 0
    try:
        while True:
            async with run.cond:
                while seen >= len(run.events) and not run.terminal:
                    # NOT wait_for: on 3.11 its child task can outlive a
                    # client disconnect and leave run.cond unbalanced
                    # (rationale pinned in classic routes.py).
                    try:
                        async with asyncio.timeout(keepalive_s):
                            await run.cond.wait()
                    except TimeoutError:
                        break
                new = list(run.events[seen:])
                seen = len(run.events)
                done = run.terminal
            for ev in new:
                yield f"data: {json.dumps(ev)}\n\n"
            if not new and not done:
                yield ": keepalive\n\n"
            if done:
                break
    except asyncio.CancelledError:
        pass
