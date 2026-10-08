"""Native Bench surface API — all throughput/accuracy/context/ANE
surfaces LIVE (REPL-1/2a/3); chat is NAT-4's file.

Every handler drives classic's engine IN-PROCESS (bench_engine,
accuracy_engine, context_engine — reuse verdicts + upload opt-out rules
documented there; classic routes stay untouched at /admin/api/bench/*).
Route order discipline (SPLIT-1): FastAPI matches in registration order,
every literal under /bench/ is registered BEFORE /bench/{run_id}/... —
tests/test_nat3_scaffold.py pins set+order and literal-vs-dynamic
identity (the 4-segment dynamics can't be shadowed by 3-segment ones,
and the golden order proves it).
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from .base import api_router, engine_pool, require_admin
from .. import accuracy_engine, bench_engine, context_engine, embed_engine


@api_router.get("/bench/flag")
async def bench_flag(is_admin: bool = Depends(require_admin)):
    """Which native surfaces are on for this server (kill-switch state)."""
    from .. import native_surfaces

    mode = native_surfaces.server_value()
    return {"mode": mode, "bench": native_surfaces.enabled(mode, "bench"),
            "chat": native_surfaces.enabled(mode, "chat")}


# ---- accuracy (REPL-2a) — LIVE via accuracy_engine ------------------------

@api_router.get("/bench/accuracy/tasks")
async def bench_accuracy_tasks(is_admin: bool = Depends(require_admin)):
    """Classic's task grid (groups, dataset sizes, sample-size options)
    — VALID_BENCHMARKS stays server-owned; labels/descriptions are i18n
    KEYS resolved client-side against the merged catalog."""
    from .. import harness_engine
    return {"tasks": accuracy_engine.TASK_GROUPS,
            "valid": accuracy_engine.valid_benchmarks(),
            "harness_tasks": sorted(harness_engine.HARNESS_MAP)}


@api_router.post("/bench/accuracy/add")
async def bench_accuracy_add(request: Request, is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    upload = bool((body or {}).pop("upload", False))
    try:
        return await accuracy_engine.queue_add(body or {}, pool, upload=upload)
    except accuracy_engine.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except accuracy_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    except accuracy_engine.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/accuracy/queue")
async def bench_accuracy_queue(is_admin: bool = Depends(require_admin)):
    return accuracy_engine.queue_status()


@api_router.delete("/bench/accuracy/queue/{idx}")
async def bench_accuracy_queue_remove(idx: int, is_admin: bool = Depends(require_admin)):
    try:
        return accuracy_engine.queue_remove(idx)
    except accuracy_engine.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/accuracy/results")
async def bench_accuracy_results(is_admin: bool = Depends(require_admin)):
    return accuracy_engine.results_payload()


@api_router.post("/bench/accuracy/results/reset")
async def bench_accuracy_results_reset(is_admin: bool = Depends(require_admin)):
    return accuracy_engine.results_reset()


@api_router.post("/bench/accuracy/cancel")
async def bench_accuracy_cancel(is_admin: bool = Depends(require_admin)):
    return await accuracy_engine.cancel()


# ---- context probe (REPL-3) — LIVE via context_engine --------------------

@api_router.post("/bench/context/start")
async def bench_context_start(request: Request, is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    try:
        return await context_engine.context_start(body or {}, pool)
    except context_engine.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except context_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    except context_engine.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/context/active")
async def bench_context_active(is_admin: bool = Depends(require_admin)):
    return context_engine.context_active()


# ---- ANE tuning (REPL-3) — LIVE; poll model (classic has no ANE SSE) ------

@api_router.post("/bench/ane-tune/start")
async def bench_ane_start(request: Request, is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    try:
        return await context_engine.ane_start(body or {}, pool)
    except context_engine.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except context_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    except context_engine.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/ane-tune/results")
async def bench_ane_results(is_admin: bool = Depends(require_admin)):
    # literal kept for the NAT-3 route-set pin; the live surface is the
    # {tuning_id} shape below (classic parity: results need the id).
    raise HTTPException(status_code=404, detail="tuning_id required")


@api_router.post("/bench/ane-tune/{tuning_id}/apply")
async def bench_ane_apply(tuning_id: str, request: Request,
                          is_admin: bool = Depends(require_admin)):
    """Apply a finished tuning's recommendation through the SAME settings
    manager classic's PUT uses (engine-reload semantics included, since
    we write via the pool entry, not around it)."""
    run = context_engine.ane_get(tuning_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"ANE tuning not found: {tuning_id}")
    body = await request.json()
    recommendation = (body or {}).get("recommendation")
    if not recommendation:
        raise HTTPException(status_code=400, detail="recommendation body required")
    if recommendation.get("model_id") not in (None, run.request.model_id):
        raise HTTPException(status_code=400, detail="recommendation model mismatch")
    try:
        patch = context_engine.ane_settings_patch(recommendation)
    except context_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    from .base import settings_manager
    mgr = settings_manager()
    if mgr is None:
        raise HTTPException(status_code=503, detail="Settings manager not initialized")
    model_id = run.request.model_id
    try:
        settings = mgr.get_settings(model_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    from omlx.model_settings import ModelSettings
    merged = settings.to_dict()
    merged.update(patch)
    mgr.set_settings(model_id, ModelSettings.from_dict(merged))
    return {"model_id": model_id, "applied_keys": sorted(patch)}


# ---- embeddings / rerankers (REPL-4) — LIVE via embed_engine ---------------

@api_router.get("/bench/embed/tasks")
async def bench_embed_tasks(is_admin: bool = Depends(require_admin)):
    """Curated laptop-sized MTEB shortlist + mteb-env readiness state."""
    return embed_engine.tasks_payload()


@api_router.post("/bench/embed/start")
async def bench_embed_start(request: Request, is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    try:
        return await embed_engine.start(body or {}, pool)
    except embed_engine.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except embed_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.get("/bench/embed/active")
async def bench_embed_active(is_admin: bool = Depends(require_admin)):
    run = embed_engine.active_run()
    if run is None:
        return {"running": False, "run_id": None}
    return {"running": True, "run_id": run.run_id, "model_id": run.model_id,
            "kind": run.kind, "status": run.status, "tasks": run.tasks,
            "done": len(run.results)}


@api_router.get("/bench/embed/results")
async def bench_embed_results(is_admin: bool = Depends(require_admin)):
    return embed_engine.results_payload()


@api_router.post("/bench/embed/results/reset")
async def bench_embed_results_reset(is_admin: bool = Depends(require_admin)):
    return embed_engine.reset_results()


@api_router.post("/bench/embed/{run_id}/cancel")
async def bench_embed_cancel(run_id: str, is_admin: bool = Depends(require_admin)):
    run = embed_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    try:
        return await embed_engine.cancel(run)
    except embed_engine.NotRunning as e:
        raise HTTPException(status_code=400,
                            detail=f"Run is not active (status: {e})")


@api_router.get("/bench/embed/{run_id}/stream")
async def bench_embed_stream(run_id: str, is_admin: bool = Depends(require_admin)):
    run = embed_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return StreamingResponse(
        embed_engine.event_stream(run),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


# ---- throughput (REPL-1) — LIVE via bench_engine --------------------------

@api_router.post("/bench/start")
async def bench_start(request: Request, is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    upload = bool((body or {}).pop("upload", False))
    try:
        return await bench_engine.start(body or {}, pool, upload=upload)
    except bench_engine.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except bench_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    except bench_engine.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/active")
async def bench_active(is_admin: bool = Depends(require_admin)):
    return bench_engine.active_summary()


# ---- dynamic throughput shapes LAST (literals above keep outranking them) --

@api_router.get("/bench/{run_id}/stream")
async def bench_stream(run_id: str, is_admin: bool = Depends(require_admin)):
    run = bench_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {run_id}")
    return StreamingResponse(
        bench_engine.event_stream(run),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


@api_router.post("/bench/{run_id}/cancel")
async def bench_cancel(run_id: str, is_admin: bool = Depends(require_admin)):
    run = bench_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {run_id}")
    try:
        return await bench_engine.cancel(run)
    except bench_engine.NotRunning as e:
        raise HTTPException(status_code=400,
                            detail=f"Benchmark is not running (status: {e.status})")


@api_router.get("/bench/{run_id}/results")
async def bench_results(run_id: str, is_admin: bool = Depends(require_admin)):
    run = bench_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {run_id}")
    return bench_engine.results_payload(run)


# ---- dynamic context probe shapes (REPL-3; 4-seg — no {run_id} clash) ----

@api_router.get("/bench/context/{bench_id}/stream")
async def bench_context_stream(bench_id: str, is_admin: bool = Depends(require_admin)):
    run = context_engine.context_get(bench_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {bench_id}")
    return StreamingResponse(
        # identical events/cond/terminal model as throughput (classic
        # run object) — the SAME generator is reused here.
        bench_engine.event_stream(run),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


@api_router.post("/bench/context/{bench_id}/cancel")
async def bench_context_cancel(bench_id: str, is_admin: bool = Depends(require_admin)):
    run = context_engine.context_get(bench_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {bench_id}")
    try:
        return await context_engine.context_cancel(run)
    except context_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.get("/bench/context/{bench_id}/results")
async def bench_context_results(bench_id: str, is_admin: bool = Depends(require_admin)):
    run = context_engine.context_get(bench_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {bench_id}")
    return context_engine.context_results_payload(run)


# ---- dynamic ANE tuning shapes (REPL-3; poll, no stream — classic parity) --

@api_router.get("/bench/ane-tune/{tuning_id}/results")
async def bench_ane_results_by_id(tuning_id: str, is_admin: bool = Depends(require_admin)):
    run = context_engine.ane_get(tuning_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"ANE tuning not found: {tuning_id}")
    return context_engine.ane_results_payload(run)


@api_router.post("/bench/ane-tune/{tuning_id}/cancel")
async def bench_ane_cancel(tuning_id: str, is_admin: bool = Depends(require_admin)):
    run = context_engine.ane_get(tuning_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"ANE tuning not found: {tuning_id}")
    try:
        return await context_engine.ane_cancel(run)
    except context_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---- dynamic accuracy stream (REPL-2a; 4-segment, no {run_id} clash) -----

@api_router.get("/bench/accuracy/{bench_id}/stream")
async def bench_accuracy_stream(bench_id: str, is_admin: bool = Depends(require_admin)):
    run = accuracy_engine.get_run(bench_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Benchmark not found: {bench_id}")
    return StreamingResponse(
        # accuracy run object: same events/cond/terminal + done/error
        # terminal types as context — event_stream reused verbatim.
        bench_engine.event_stream(run),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )
