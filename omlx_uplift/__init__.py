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

__version__ = "1.2"


def register(app) -> None:
    """Mount all Uplift routes onto a FastAPI app (idempotent per app)."""
    # UP-3: logging is configured by now (omlx/cli.py sets handlers up
    # before importing omlx.server) — release the boot-time patchsync
    # buffer into server.log before anything else mounts.
    try:
        from . import bootlog

        bootlog.flush()
    except Exception:
        pass
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
        # BE-prefill: prefill tracker wrap is independent of the engine
        # core wrap (install() may bail early on layout drift).
        instrument.install_prefill_tracker()
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
    from .fast_sampler import get_fast_sampler

    fast = get_fast_sampler()

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
        # FAST-1: 2 Hz display sampler — memory rings only, never the DB.
        try:
            fast.start()
        except Exception:
            logging.getLogger("omlx_uplift").exception(
                "fast sampler start failed (dashboard keeps 5 s cadence)")
        # DEV-11: AUTO UPDATE — TRACK HEAD check. Own daemon thread so a
        # slow git fetch never delays serving; the hook itself is fully
        # guarded and does nothing at all unless the opt-in flag is ON.
        import threading as _threading

        try:
            from .router import dev11_boot_check

            _threading.Thread(target=dev11_boot_check, daemon=True,
                              name="uplift-dev11").start()
        except Exception:
            logging.getLogger("omlx_uplift").debug(
                "dev-11 boot hook not started", exc_info=True)
        try:
            async with original(app_obj):
                yield
        finally:
            try:
                fast.stop()
            except Exception:
                pass
            await collector.stop()

    app.router.lifespan_context = lifespan_with_uplift
