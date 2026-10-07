"""REPL-3 context probe — engine mirrors for the Context benchmark and
ANE tuning.

Same doctrine as throughput (REPL-1): the classic modules own the math,
the registry and the SSE model; uplift owns only the API surface +
upload opt-in. No measurement logic is duplicated.

Reuse notes (2026-10-08):
- omlx.admin.context_benchmark: ContextBenchmarkRequest (target_tokens
  validated against VALID_TARGET_TOKENS), create_run/get_run/
  get_active_run/cleanup_old_runs, run_context_benchmark. Its run object
  carries the identical events/cond/terminal fields -> event_stream()
  from bench_engine is reused verbatim. Apply (writing
  max_context_window) happens INSIDE the classic runner via the pool's
  settings manager — no uplift settings-layer seam is involved; the
  model card reads server settings via the overlay (DEAD-1), so the
  applied value is what the card shows.
- omlx.admin.ane_tuning: ANETuningRequest (sequence_length %64, >=1024;
  allow_* toggles), create_run/get_run/run_tuning/run_snapshot. NO SSE:
  classic's own frontend polls /results (dashboard.js
  pollANETuning) — the mirror keeps the poll model. The apply step in
  classic is a client-side PATCH of qwen35_ane_prefill_* model settings
  (/admin/api/models/{id}/settings); native reuses that same route via
  the settings overlay rather than re-implementing the recommendation->
  settings mapping server-side… EXCEPT the mapping itself lives in
  dashboard.js, so to keep behavior honest it is re-implemented here
  once, reviewed line-by-line against the classic block.
- Contention matrix mirrors classic routes.py: each start rejects while
  ANY of throughput/context/ANE/accuracy runs occupy the engine.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from .bench_engine import (BadInput, Conflict, NotFound, _engine,  # noqa: F401
                           event_stream)

logger = logging.getLogger("uplift.context_engine")


def _ctx():
    from omlx.admin import context_benchmark as CTX
    return CTX


def _ane():
    from omlx.admin import ane_tuning as ANE
    return ANE


async def _other_bench_busy() -> str | None:
    """Classic routes.py contention: which OTHER bench owns the engine?
    Returns a human reason or None. Accuracy queue counts too (all four
    unload/load models and would corrupt each other)."""
    B = _engine()
    t = B.get_active_run()
    if t is not None:
        return (f"A throughput benchmark is already running (bench_id="
                f"{t.bench_id}, model_id={t.request.model_id}).")
    try:
        ANE = _ane()
        a = ANE.get_active_run()
        if a is not None:
            return (f"ANE tuning is already running (tuning_id={a.tuning_id}, "
                    f"model_id={a.request.model_id}).")
    except ImportError:
        pass
    try:
        from omlx.admin.accuracy_benchmark import get_queue_status
        if get_queue_status().get("running"):
            return "An accuracy benchmark is already running."
    except ImportError:
        pass
    return None


# ---------------------------------------------------------------------------
# CONTEXT benchmark (routes.py:8439-8690 contract)
# ---------------------------------------------------------------------------

async def context_start(body: dict, pool: Any) -> dict:
    CTX = _ctx()
    active = CTX.get_active_run()
    if active is not None:
        raise Conflict("A context benchmark is already running "
                       f"(bench_id={active.bench_id}, "
                       f"model_id={active.request.model_id}).")
    reason = await _other_bench_busy()
    if reason:
        raise Conflict(reason)

    # Classic gate: memory guard must be ON — the probe measures the
    # guard's admission boundary; unguarded probes can OOM the machine.
    try:
        from omlx.server import _server_state
        enforcer = getattr(_server_state, "process_memory_enforcer", None)
        ceiling = 0
        if enforcer is not None:
            try:
                ceiling = int(enforcer.get_final_ceiling())
            except Exception:
                ceiling = 0
        if ceiling <= 0:
            raise BadInput(
                "Memory Guard is disabled. The context benchmark measures "
                "the guard's admission boundary, and probing without it can "
                "exhaust system memory. Enable Memory Guard and retry.")
    except ImportError:
        pass  # keg without the enforcer seam: let the probe through

    try:
        req = CTX.ContextBenchmarkRequest(**(body or {}))
    except Exception as e:
        raise BadInput(str(e)) from e

    entry = pool.get_entry(req.model_id)
    if entry is None:
        raise NotFound(f"Model not found: {req.model_id}")
    if entry.model_type not in ("llm", "vlm", None):
        raise BadInput(f"Model {req.model_id} is not a supported model "
                       f"(type: {entry.model_type})")

    CTX.cleanup_old_runs()
    run = CTX.create_run(req)
    run.task = asyncio.create_task(CTX.run_context_benchmark(run, pool))
    logger.info(f"uplift native context probe started: {run.bench_id} "
                f"model={req.model_id} target={req.target_tokens}")
    return {"bench_id": run.bench_id, "status": "started",
            "target_tokens": req.target_tokens}


def context_active() -> dict:
    run = _ctx().get_active_run()
    if run is None:
        return {"running": False, "bench_id": None, "model_id": None}
    return {"running": True, "bench_id": run.bench_id,
            "model_id": run.request.model_id,
            "target_tokens": run.request.target_tokens}


def context_get(bench_id: str):
    return _ctx().get_run(bench_id)


def context_results_payload(run) -> dict:
    # classic's REST poll shape verbatim (native app never parses events)
    return {
        "bench_id": run.bench_id,
        "status": run.status,
        "phase": run.phase,
        "progress": run.progress,
        "message": run.message,
        "result": run.result,
        "error": run.error_message if run.error_message else None,
    }


async def context_cancel(run) -> dict:
    if run.status != "running":
        raise BadInput(f"Context benchmark is not running (status: {run.status})")
    if run.task and not run.task.done():
        run.task.cancel()
    return {"status": "cancelled", "bench_id": run.bench_id}


# ---------------------------------------------------------------------------
# ANE tuning (routes.py:8328-8439 contract; poll model, no SSE)
# ---------------------------------------------------------------------------

async def ane_start(body: dict, pool: Any) -> dict:
    ANE = _ane()
    active = ANE.get_active_run()
    if active is not None:
        raise Conflict(f"ANE tuning is already running (tuning_id="
                       f"{active.tuning_id}, model_id={active.request.model_id}).")
    reason = await _other_bench_busy_ctx()
    if reason:
        raise Conflict(reason)

    try:
        req = ANE.ANETuningRequest(**(body or {}))
    except Exception as e:
        raise BadInput(str(e)) from e

    entry = pool.get_entry(req.model_id)
    if entry is None:
        raise NotFound(f"Model not found: {req.model_id}")
    if entry.model_type not in ("llm", "vlm", None):
        raise BadInput(f"Model {req.model_id} is not a supported language model")

    # classic derives the backend from the config type — same here, the
    # client value never wins (routes.py parity).
    req.backend = "k2" if entry.config_model_type == "k2_horizon" else "qwen"
    ANE.cleanup_old_runs()
    run = ANE.create_run(req)
    run.task = asyncio.create_task(ANE.run_tuning(run, pool))
    logger.info(f"uplift native ANE tuning started: {run.tuning_id} "
                f"model={req.model_id} seq={req.sequence_length}")
    return {"tuning_id": run.tuning_id, "status": "started", "total": run.total}


async def _other_bench_busy_ctx() -> str | None:
    CTX = _ctx()
    c = CTX.get_active_run()
    if c is not None:
        return (f"A context benchmark is already running (bench_id="
                f"{c.bench_id}).")
    return await _other_bench_busy()


def ane_get(tuning_id: str):
    return _ane().get_run(tuning_id)


def ane_results_payload(run) -> dict:
    return _ane().run_snapshot(run)


async def ane_cancel(run) -> dict:
    if run.status != "running":
        raise BadInput(f"ANE tuning is not running ({run.status})")
    if run.phase == "cleaning_up":
        return {"status": "cleaning_up", "tuning_id": run.tuning_id}
    if run.task is not None and not run.task.done():
        run.task.cancel()
    return {"status": "cancelled", "tuning_id": run.tuning_id}


# ---------------------------------------------------------------------------
# ANE recommendation -> model settings patch.
# Line-by-line mirror of dashboard.js applyANETuningRecommendation()
# (2026-10-08 read). Kept server-side so the native UI needs no key
# knowledge; applied through the SAME settings route classic uses.
# ---------------------------------------------------------------------------

def ane_settings_patch(recommendation: dict) -> dict:
    if not recommendation:
        raise BadInput("No recommendation to apply.")
    patch: dict[str, Any] = {
        "qwen35_ane_prefill_enabled": bool(recommendation.get("enabled")),
        "qwen35_ane_prefill_sequence_length": int(recommendation["sequence_length"]),
    }
    if recommendation.get("enabled"):
        patch["qwen35_ane_prefill_fraction"] = float(recommendation["mlp_fraction"])
    if recommendation.get("backend") == "k2":
        if recommendation.get("enabled"):
            patch["qwen35_ane_prefill_shared_fraction"] = float(
                recommendation["shared_fraction"])
    else:
        patch["qwen35_ane_prefill_tail_padding_min_tokens"] = int(
            recommendation.get("tail_padding_min_tokens") or 0)
        if recommendation.get("enabled"):
            patch["qwen35_ane_prefill_fused_down"] = bool(recommendation.get("fused_down"))
            patch["qwen35_ane_prefill_gdn"] = bool(recommendation.get("gdn_enabled"))
            if recommendation.get("gdn_enabled"):
                patch["qwen35_ane_prefill_gdn_fraction"] = float(
                    recommendation["gdn_fraction"])
            patch["qwen35_ane_prefill_cpu_enabled"] = bool(recommendation.get("cpu_enabled"))
            patch["qwen35_ane_prefill_cpu_fraction"] = float(
                recommendation.get("cpu_fraction") or 0)
            patch["qwen35_ane_prefill_cpu_down_fraction"] = float(
                recommendation.get("cpu_down_fraction") or 0)
            patch["qwen35_ane_prefill_cpu_gdn_fraction"] = float(
                recommendation.get("cpu_gdn_fraction") or 0)
            if recommendation.get("cpu_threads") is not None:
                patch["qwen35_ane_prefill_cpu_threads"] = int(
                    recommendation["cpu_threads"])
            if recommendation.get("cpu_shared_resource") is not None:
                patch["qwen35_ane_prefill_cpu_shared_resource"] = bool(
                    recommendation["cpu_shared_resource"])
    return patch
