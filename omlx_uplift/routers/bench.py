"""Native Bench surface API — throughput LIVE (REPL-1), rest scaffolded.

REPL-1: /bench/start|active|{id}/stream|cancel|results drive classic's
engine IN-PROCESS via bench_engine (reuse verdict + upload opt-out rules
documented there; classic routes stay untouched at /admin/api/bench/*).
REPL-2 layers accuracy, REPL-3 context/ANE — their literals keep their
slots below the dynamic {run_id} shapes and stay 501 stubs until filled.
Route order discipline (SPLIT-1): FastAPI matches in registration order,
every literal under /bench/ is registered BEFORE /bench/{run_id}/... —
tests/test_nat3_scaffold.py pins set+order and stub identity.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from .base import api_router, engine_pool, require_admin
from .. import bench_engine


def _stub(name: str):
    def handler(is_admin: bool = Depends(require_admin)):
        raise HTTPException(
            status_code=501,
            detail=f"native bench surface '{name}': not implemented yet (NAT-3 scaffold)")
    handler.__name__ = name
    return handler


@api_router.get("/bench/flag")
async def bench_flag(is_admin: bool = Depends(require_admin)):
    """Which native surfaces are on for this server (kill-switch state)."""
    from .. import native_surfaces

    mode = native_surfaces.server_value()
    return {"mode": mode, "bench": native_surfaces.enabled(mode, "bench"),
            "chat": native_surfaces.enabled(mode, "chat")}


# ---- accuracy (REPL-2) ----------------------------------------------------

bench_accuracy_add = _stub("bench_accuracy_add")
bench_accuracy_queue = _stub("bench_accuracy_queue")
bench_accuracy_results = _stub("bench_accuracy_results")

api_router.post("/bench/accuracy/add")(bench_accuracy_add)
api_router.get("/bench/accuracy/queue")(bench_accuracy_queue)
api_router.get("/bench/accuracy/results")(bench_accuracy_results)

# ---- context probe (REPL-3) -----------------------------------------------

bench_context_start = _stub("bench_context_start")
bench_context_active = _stub("bench_context_active")

api_router.post("/bench/context/start")(bench_context_start)
api_router.get("/bench/context/active")(bench_context_active)

# ---- ANE tuning (REPL-3) --------------------------------------------------

bench_ane_start = _stub("bench_ane_start")
bench_ane_results = _stub("bench_ane_results")

api_router.post("/bench/ane-tune/start")(bench_ane_start)
api_router.get("/bench/ane-tune/results")(bench_ane_results)


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
