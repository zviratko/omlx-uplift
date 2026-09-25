"""Uplift dashboard — opt-in companion UI for oMLX.

Installable add-on: vanilla oMLX stays byte-identical, the wrapper CLI
(`omlx-uplift serve`) mounts this package's router into `omlx.server.app`
and starts the metrics collector in the same asyncio loop.

Mount points (registered by `register(app)`):
  /uplift/...            static UI + login gate (canonical)
  /admin/uplift/...      legacy alias so bookmarks keep working
  /uplift/api/...        uplift-only JSON API (requests feed, settings
                         index, prune, GET/DELETE model settings,
                         /models overlay with used_by)
  /admin/api/...         alias mount of the same API for the standalone
                         dev gateway (?api=) compatibility
"""

__version__ = "0.1.0"


def register(app) -> None:
    """Mount all Uplift routes onto a FastAPI app (idempotent per app)."""
    from .router import api_router, page_router

    if getattr(app, "_omlx_uplift_mounted", False):
        return
    # API FIRST: the page router's /uplift/{path} catch-all would
    # otherwise swallow /uplift/api/* in registration order.
    app.include_router(api_router, prefix="/uplift/api", include_in_schema=True)
    # Legacy/dev-gateway alias: identical handlers under /admin/api.
    app.include_router(api_router, prefix="/admin/api", include_in_schema=False)
    app.include_router(page_router)
    # Collector lives in omlx's own loop — no separate daemon. Vanilla
    # servers without this package simply never reach this code.
    # FastAPI>=0.140 apps with a lifespan have no add_event_handler, and
    # omlx uses lifespan — wrap the existing lifespan context instead.
    _wrap_lifespan(app)
    # Event-driven request capture (RL3-GAP1): wraps AsyncEngineCore
    # birth/departure in memory only — vanilla files stay byte-identical.
    try:
        from . import instrument

        instrument.install()
    except Exception:  # never break the server for a capture failure
        import logging

        logging.getLogger("omlx_uplift").exception(
            "instrument install failed (tick-based capture only)")
    app._omlx_uplift_mounted = True


def _wrap_lifespan(app) -> None:
    import asyncio
    import logging
    from contextlib import asynccontextmanager

    from .collector import get_collector

    collector = get_collector()
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan_with_uplift(app_obj):
        # Bundled skins are unpacked ONCE here (server startup), never on
        # a browser hit: the crates stay in the keg, only working copies
        # land in ~/.omlx{,-dev}/uplift/skins/. Stale engine copies are
        # pruned in the same pass. Best-effort: a failure logs, the
        # dashboard still boots with user skins + built-in themes.
        try:
            from . import skins

            await asyncio.to_thread(skins.sync_bundled)
        except Exception:
            logging.getLogger("omlx_uplift").exception(
                "bundled skin sync failed (skins listing may be stale)")
        await collector.start()
        try:
            async with original(app_obj):
                yield
        finally:
            await collector.stop()

    app.router.lifespan_context = lifespan_with_uplift
