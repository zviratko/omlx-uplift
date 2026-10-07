"""Native Bench surface API (NAT-3 scaffold; REPL-1/2/3 fill it).

REPL-1 (throughput) reuses omlx's own benchmark engine IN-PROCESS (the
`from omlx.admin import benchmark` pattern NAT-2 froze; engine_pool DI
lives in routers.base). REPL-2 layers accuracy (classic engine first,
then the lm-eval-harness subprocess). REPL-3 mirrors context/ANE.

This scaffold registers the route TREE with honest 501 stubs so the
frontend, the route-set test and the i18n keys land before any real
engine wiring. Route order note: FastAPI matches in registration order,
so every literal under /bench/ (flag, active, start, accuracy/*,
context/*, ane-tune/*) is registered BEFORE the dynamic
/bench/{run_id}/... shapes — a late literal would be shadowed by the
earlier dynamic match (same discipline as /requests/stats before
/requests/{request_id}). tests/test_nat3_scaffold.py pins the surface,
the order and per-handler identity (the 501 detail names the resolved
handler, so shadowing fails a test instead of hiding in the tree).
"""

from __future__ import annotations

from fastapi import Depends, HTTPException

from .base import api_router, require_admin


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

# ---- throughput (REPL-1) ---------------------------------------------------

bench_start = _stub("bench_start")
bench_active = _stub("bench_active")

api_router.post("/bench/start")(bench_start)
api_router.get("/bench/active")(bench_active)


# DYNAMIC segment shapes LAST (all literals above must keep outranking them):

@api_router.get("/bench/{run_id}/stream")
async def bench_stream(run_id: str, is_admin: bool = Depends(require_admin)):
    raise HTTPException(
        status_code=501,
        detail="native bench surface 'bench_stream': not implemented yet (NAT-3 scaffold)")


@api_router.post("/bench/{run_id}/cancel")
async def bench_cancel(run_id: str, is_admin: bool = Depends(require_admin)):
    raise HTTPException(
        status_code=501,
        detail="native bench surface 'bench_cancel': not implemented yet (NAT-3 scaffold)")


@api_router.get("/bench/{run_id}/results")
async def bench_results(run_id: str, is_admin: bool = Depends(require_admin)):
    raise HTTPException(
        status_code=501,
        detail="native bench surface 'bench_results': not implemented yet (NAT-3 scaffold)")
