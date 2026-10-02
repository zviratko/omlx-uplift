"""Shared HTTP plumbing for the uplift routers (SPLIT-1).

Every route lives in omlx_uplift/routers/*; omlx/admin/routes.py stays
vanilla. This module owns: the soft omlx.auth import, the two router
objects (api_router carries the no-store dependency), and the
server-state DI helpers. Auth reuses omlx.admin.auth.require_admin
(session cookie) so a login at /admin also unlocks /uplift and vice
versa — same token, httponly cookie.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.responses import Response

try:  # normal runtime: we are importable inside omlx's environment
    from omlx.admin.auth import _RedirectToLogin, require_admin
except ImportError:  # pragma: no cover
    # Standalone viewer mode on a machine WITHOUT omlx (DMG users): the
    # router is imported only for its static/login helpers; endpoints
    # that actually need auth are unreachable because the viewer mounts
    # its own handlers. Keep the import soft and raise only on use.
    class _RedirectToLogin(Exception):  # placeholder for isinstance checks
        pass

    def require_admin(request):  # type: ignore
        raise RuntimeError(
            "omlx-uplift router mounted without omlx: run `omlx-uplift "
            "serve` inside the oMLX environment, or the standalone viewer"
        )

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

page_router = APIRouter()


def _no_api_cache(response: Response) -> None:
    """API-CACHE-1: the JSON endpoints shipped with NO cache headers at
    all. Responses without validators/Cache-Control can be cached
    heuristically by browser and proxy caches — after a pip upgrade that
    swaps the locale catalog or retention config, a client could keep
    serving stale JSON and the failure would look like the CACHE-1-era
    'stale cache looks like a failed deploy' trap. Every uplift API
    response is live data: no-store. (Routes that return a Response
    object directly, like the SSE stream, skip dependency-set headers —
    streams are never cached bodies anyway.)"""
    response.headers.setdefault("Cache-Control", "no-store")


api_router = APIRouter(dependencies=[Depends(_no_api_cache)])


# --------------------------------------------------------------------------
# Server-state access (same DI convention as omlx.admin.routes)
# --------------------------------------------------------------------------

def engine_pool():
    from omlx.server import _server_state

    return _server_state.engine_pool


def settings_manager():
    from omlx.server import _server_state

    return _server_state.settings_manager


def global_settings():
    from omlx.server import _server_state

    return _server_state.global_settings


def _require_settings_manager():
    mgr = settings_manager()
    if mgr is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    return mgr
