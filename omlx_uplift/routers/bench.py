"""Native Bench surface API — all throughput/accuracy/context/ANE
surfaces LIVE (REPL-1/2a/3); chat is NAT-4's file.

Every handler drives classic's engine IN-PROCESS (bench_engine,
accuracy_engine, context_engine — reuse verdicts + upload opt-out rules
documented there; classic routes stay untouched at /admin/api/bench/*).

GLOBAL BENCH QUEUE (user 2026-10-13, items 6+7): a start arriving while
ANOTHER bench of ANY kind holds the single engine slot no longer 409s —
routers ask bench_queue.busy_check() first and, when it answers, the click
becomes a FIFO entry (HTTP 200 + queued/qid/position). The accuracy
IN-TYPE queue stays classic's own. ANE tuning is the one surface that
keeps 409 (apply-semantics, human present — see bench_ane_start).

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
from .. import (accuracy_engine, bench_engine, bench_history, bench_prefill,
                bench_queue, context_engine, decision_engine, embed_engine)


async def _queued_start(kind: str, body: dict, label: str = "") -> dict:
    """GLOBAL BENCH QUEUE: the engine slot is busy, so this click becomes a
    queue entry instead of a 409 (user 2026-10-13, items 6+7). Returns
    200 + {queued: true, qid, position} — the client shows the queue row,
    the pump in bench_queue starts the run when the bench before it ends.

    bench_queue.submit validates through the owning engine's pure validator
    first, so a bad body still lands on 400 here and never occupies a slot.
    """
    try:
        return await bench_queue.submit(kind, body or {}, label=label)
    except bench_queue.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---- U64 run history (literals registered BEFORE /bench/{run_id}/... —
# the route-order discipline of this file). Accuracy does not need these:
# its accumulated rows already ride /bench/accuracy/results restored.

@api_router.get("/bench/history")
async def bench_history_list(surface: str,
                             is_admin: bool = Depends(require_admin)):
    if surface not in bench_history.RUN_SURFACES:
        raise HTTPException(status_code=400,
                            detail=f"unknown surface: {surface}")
    return bench_history.entries(surface)


@api_router.post("/bench/history/clear")
async def bench_history_clear(request: Request,
                              is_admin: bool = Depends(require_admin)):
    body = await request.json()
    surface = str((body or {}).get("surface") or "")
    if surface not in bench_history.RUN_SURFACES:
        raise HTTPException(status_code=400,
                            detail=f"unknown surface: {surface}")
    return bench_history.clear(surface)


@api_router.get("/bench/flag")
async def bench_flag(is_admin: bool = Depends(require_admin)):
    """Which native surfaces are on for this server (kill-switch state)."""
    from .. import native_surfaces

    mode = native_surfaces.server_value()
    return {"mode": mode, "bench": native_surfaces.enabled(mode, "bench"),
            "chat": native_surfaces.enabled(mode, "chat")}


# ---- global bench queue (user 2026-10-13 items 6+7) ------------------------
# Literals FIRST in their band, as everywhere in this file: a later
# /bench/{run_id}/... dynamic must never shadow /bench/queue.

@api_router.get("/bench/queue")
async def bench_queue_status(is_admin: bool = Depends(require_admin)):
    """The cross-type FIFO: every entry (kind, label, body, status, run_id,
    error) plus the machine-wide idle flag the start routes consult."""
    return bench_queue.status()


@api_router.delete("/bench/queue/{qid}")
async def bench_queue_drop(qid: str, is_admin: bool = Depends(require_admin)):
    """Drop a queued entry; a RUNNING one is cancelled through its own
    engine first (bench_queue.CANCELS) and then dropped."""
    try:
        return await bench_queue.remove(qid)
    except bench_queue.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


# U64: classic run objects die with the process; a stored entry still
# marked 'running' can only mean the server stopped mid-run. One pass per
# import, before any new run can register (bench_id is uuid-based).
bench_history.reconcile_interrupted()


# ---- accuracy (REPL-2a) — LIVE via accuracy_engine ------------------------

@api_router.get("/bench/accuracy/tasks")
async def bench_accuracy_tasks(is_admin: bool = Depends(require_admin)):
    """Classic's task grid (groups, dataset sizes, sample-size options)
    — VALID_BENCHMARKS stays server-owned; labels/descriptions are i18n
    KEYS resolved client-side against the merged catalog.

    ACC-2b seam keys (both additive; classic ignores what it does not know):
    - 'harness_tasks': every HARNESS_MAP suite (classic-16 twins + extras)
      — UNCHANGED shape, the queue's mapping check reads it;
    - 'extra_suites': the harness-only suites beyond the 16, as
      [{'key','label','family','rows','upload_ok': False}, ...]. The picker
      renders them as a separate 'Additional suites' section; upload_ok is
      False by definition (omlx.ai knows only the 16). 'valid' deliberately
      STAYS the classic 16 — it is the leaderboard-eligible set, not the
      queueable set."""
    from .. import harness_engine
    return {"tasks": accuracy_engine.TASK_GROUPS,
            "valid": accuracy_engine.valid_benchmarks(),
            "harness_tasks": sorted(harness_engine.HARNESS_MAP),
            "extra_suites": harness_engine.extra_suites()}


@api_router.get("/bench/accuracy/harness-sizes")
async def bench_accuracy_harness_sizes(is_admin: bool = Depends(require_admin)):
    """U68: per-suite leaf-subtask counts for the community harness engine
    (its --limit applies PER task; the UI multiplies so the user chooses
    with open eyes). The bench-env probe runs at most once and caches on
    disk; it is OFF the hot route (own endpoint, lazy UI fetch) because
    the first probe can take ~20s — the event loop must not wait."""
    import asyncio
    from .. import harness_engine
    sizes = await asyncio.get_running_loop().run_in_executor(
        None, harness_engine.subtask_counts)
    return {"sizes": sizes}


@api_router.post("/bench/accuracy/add")
async def bench_accuracy_add(request: Request, is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    upload = bool((body or {}).pop("upload", False))
    try:
        # IN-TYPE queue stays classic's (accuracy_engine.queue_add appends
        # to AB's own queue and starts when its turn comes) — untouched.
        return await accuracy_engine.queue_add(body or {}, pool, upload=upload)
    except accuracy_engine.Conflict:
        # Cross-TYPE contention (ANE tuning / context probe holds the
        # engine): queue it globally instead of bouncing the click (6+7).
        return await _queued_start("accuracy", {**(body or {}),
                                                "upload": upload})
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
    # GLOBAL BENCH QUEUE: any other bench (any kind, classic accuracy queue
    # included) holding the engine turns this click into a queue entry.
    if await bench_queue.busy_check("context"):
        return await _queued_start("context", body or {})
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


# ---- uplift-native prefill / parallel probe (user item 4) -----------------
# WHY THESE EXIST: classic's BenchmarkRequest validators pin the option sets
# (VALID_PROMPT_LENGTHS / VALID_BATCH_SIZES) and its batch test hard-codes
# pp1024 with an un-staggered asyncio.gather, so custom prefill length,
# custom parallelism and staggered starts cannot ride /bench/start without
# editing vanilla. bench_prefill.py owns that lane and reuses classic's
# prompt builder, engine seam and metric math instead (reuse verdict in its
# docstring). These are LITERALS and stay above the /bench/{run_id}/...
# dynamics at the bottom of this file; they deliberately do NOT enter the
# global bench queue — a probe is short, interactive and 409s when the
# engine slot is taken (the ANE precedent: refuse, never auto-start).

@api_router.post("/bench/prefill/start")
async def bench_prefill_start(request: Request,
                              is_admin: bool = Depends(require_admin)):
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Engine pool not initialized")
    body = await request.json()
    try:
        # pure shape check FIRST: garbage is a 400, never a claim on the
        # engine (embed_engine / decision_engine precedent)
        bench_prefill.validate_body(body or {})
    except bench_prefill.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        return await bench_prefill.start(body or {}, pool)
    except bench_prefill.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except bench_prefill.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    except bench_prefill.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/prefill/active")
async def bench_prefill_active(is_admin: bool = Depends(require_admin)):
    return bench_prefill.active_summary()


# ---- ANE tuning (REPL-3) — LIVE; poll model (classic has no ANE SSE) ------

@api_router.post("/bench/ane-tune/start")
async def bench_ane_start(request: Request, is_admin: bool = Depends(require_admin)):
    """ANE tuning STAYS 409 while another bench runs — it is deliberately
    NOT part of the global bench queue. Its product is a recommendation a
    human reads and then APPLIES to model settings (apply-semantics, human
    present); a tuning that fires unattended at 03:00 from a queue could
    leave a saved setting nobody chose. ANE busy still BLOCKS the queue
    (bench_queue._busy_ane), so the two never overlap."""
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
        # pure shape check FIRST: garbage is a 400, never a queue entry
        embed_engine.validate_body(body or {})
    except embed_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    if await bench_queue.busy_check("embed"):
        return await _queued_start("embed", body or {})
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


# ---- decision / System-1 (REPL-4c) — LIVE via decision_engine --------------
# Same order discipline: literals BEFORE /bench/{run_id}/... dynamics
# (GET /bench/{run_id}/results would swallow /bench/decision/results).

@api_router.get("/bench/decision/tasks")
async def bench_decision_tasks(is_admin: bool = Depends(require_admin)):
    """Pinned pack list (provenance + item counts) from the manifest."""
    return decision_engine.tasks_payload()


@api_router.get("/bench/decision/models")
async def bench_decision_models(is_admin: bool = Depends(require_admin)):
    """Picker split: Decision models (native /v1/systemone) vs chat models
    (generic /v1/decisions) — classified SERVER-side from the engine pool,
    so the UI stops guessing engine_type off /models rows.

    {generic_available, generic_reason, forced_available, forced_reason,
     native: [ids], generic: [ids]}.
    generic is empty (and generic_available false, with the reason) on kegs
    that predate upstream 981ebcc; forced_available additionally requires
    the require_answer kwarg from 5833533 (forced_capability() probe).
    embedding / reranker / audio_* / markitdown rows are in neither list.
    Literal route, registered with the other /bench/decision/ literals —
    BEFORE the {run_id} dynamics.
    """
    return decision_engine.classify_models()


@api_router.post("/bench/decision/start")
async def bench_decision_start(request: Request, is_admin: bool = Depends(require_admin)):
    body = await request.json()
    try:
        # pure (manifest-only) check FIRST: garbage is a 400, never a queue
        # entry — start() repeats it, and validate_body touches no engine.
        decision_engine.validate_body(body or {})
    except decision_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    if await bench_queue.busy_check("decision"):
        return await _queued_start("decision", body or {})
    try:
        return await decision_engine.start(body or {})
    except decision_engine.Conflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except decision_engine.BadInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    except decision_engine.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@api_router.get("/bench/decision/active")
async def bench_decision_active(is_admin: bool = Depends(require_admin)):
    run = decision_engine.active_run()
    if run is None:
        return {"running": False}
    return {"running": True, "run_id": run.run_id, "status": run.status,
            "model_id": run.model_id, "packs": run.packs,
            "done": len(run.results)}


@api_router.get("/bench/decision/results")
async def bench_decision_results(is_admin: bool = Depends(require_admin)):
    return decision_engine.results_payload()


@api_router.post("/bench/decision/results/reset")
async def bench_decision_results_reset(is_admin: bool = Depends(require_admin)):
    return decision_engine.reset_results()


@api_router.post("/bench/decision/{run_id}/cancel")
async def bench_decision_cancel(run_id: str, is_admin: bool = Depends(require_admin)):
    run = decision_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    try:
        return await decision_engine.cancel(run)
    except decision_engine.NotRunning as e:
        raise HTTPException(status_code=400,
                            detail=f"Run is not active (status: {e})")


@api_router.get("/bench/decision/{run_id}/stream")
async def bench_decision_stream(run_id: str, is_admin: bool = Depends(require_admin)):
    run = decision_engine.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return StreamingResponse(
        decision_engine.event_stream(run),
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
    # cache-off flags: uplift-only keys, popped before the classic
    # BenchmarkRequest is ever built (the engine receives them as kwargs)
    no_hot_cache = bool((body or {}).pop("no_hot_cache", False))
    no_ssd_cache = bool((body or {}).pop("no_ssd_cache", False))
    if await bench_queue.busy_check("throughput"):
        # upload rides the stored body: the pump re-pops it at dispatch,
        # so a queued run keeps the opt-in the click made (or didn't).
        # The cache-off flags ride the same way for the same reason.
        return await _queued_start("throughput", {**(body or {}),
                                                  "upload": upload,
                                                  "no_hot_cache": no_hot_cache,
                                                  "no_ssd_cache": no_ssd_cache})
    try:
        return await bench_engine.start(body or {}, pool, upload=upload,
                                        no_hot_cache=no_hot_cache,
                                        no_ssd_cache=no_ssd_cache)
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


# ---- dynamic prefill probe shapes (user item 4; 4-segment, like the
# context/ANE dynamics — their literals live up in the literal band) --------

@api_router.get("/bench/prefill/{run_id}/stream")
async def bench_prefill_stream(run_id: str, is_admin: bool = Depends(require_admin)):
    run = bench_prefill.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Probe not found: {run_id}")
    return StreamingResponse(
        # our run object carries classic's events/cond/terminal model, so
        # the ONE shared SSE generator serves this surface too.
        bench_engine.event_stream(run),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


@api_router.post("/bench/prefill/{run_id}/cancel")
async def bench_prefill_cancel(run_id: str, is_admin: bool = Depends(require_admin)):
    run = bench_prefill.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Probe not found: {run_id}")
    try:
        return await bench_prefill.cancel(run)
    except bench_prefill.NotRunning as e:
        raise HTTPException(status_code=400,
                            detail=f"Probe is not running (status: {e.status})")


@api_router.get("/bench/prefill/{run_id}/results")
async def bench_prefill_results(run_id: str, is_admin: bool = Depends(require_admin)):
    run = bench_prefill.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Probe not found: {run_id}")
    return bench_prefill.results_payload(run)


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
