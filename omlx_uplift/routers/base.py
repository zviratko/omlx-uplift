"""Shared HTTP plumbing for the uplift routers (SPLIT-1).

Every route lives in omlx_uplift/routers/*; omlx/admin/routes.py stays
vanilla. This module owns: the soft omlx.auth import, the two router
objects (api_router carries the no-store dependency), and the
server-state DI helpers. Auth reuses omlx.admin.auth.require_admin
(session cookie) so a login at /admin also unlocks /uplift and vice
versa — same token, httponly cookie.
"""

from __future__ import annotations

import gzip
import json
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
# GZIP (PERF-1, user 2026-10-21): the heavy uplift answers (multi-key
# series, hot discovery, locale catalog) were shipped uncompressed —
# a 24 h window cost 4.7 MB per fetch, saturating the browser's
# ~6-per-origin HTTP/1.1 link so that everything else (SSE frames,
# label loads, the next card) queued behind it. uvicorn h11 compresses
# nothing by itself and the omlx app is vanilla (no middleware to add),
# so the routes that produce big bodies gzip them here, off the event
# loop. Below the 1 KiB floor gzip costs more than it saves (framing
# overhead + latency on a request that is already done), and a client
# that does not advertise gzip gets plain JSON exactly as before.
# --------------------------------------------------------------------------

GZIP_MIN_BYTES = 1024


def gzip_or_json(payload, request=None, accept_encoding: str = "") -> Response:
    """Serialize PAYLOAD and answer with gzip when the client accepts it.

    Request-aware: reads Accept-Encoding off REQUEST headers (pass either
    the Request or the pre-extracted header string — tests pass request=None
    and get the plain answer, exactly like the old dict return). The body is
    built IN THIS FUNCTION inside a worker thread (asyncio.to_thread at the
    call site), so neither the multi-MB json.dumps nor the compression run
    on the event loop; the returned Response carries no-store (same
    API-CACHE-1 doctrine as the dependency) and Vary so a shared cache
    cannot mix the two encodings. Routes must return this object AS-IS (it
    is the whole answer, already headers-complete)."""
    body = json.dumps(payload, default=str).encode("utf-8")
    ae = accept_encoding
    if request is not None:
        ae = request.headers.get("accept-encoding", "")
    if len(body) >= GZIP_MIN_BYTES and "gzip" in (ae or "").lower():
        comp = gzip.compress(body, 6)
        return Response(
            comp, media_type="application/json", status_code=200,
            headers={"Content-Encoding": "gzip",
                    "Content-Length": str(len(comp)),
                    "Cache-Control": "no-store",
                    "Vary": "Accept-Encoding"},
        )
    return Response(
        body, media_type="application/json", status_code=200,
        headers={"Content-Length": str(len(body)),
                 "Cache-Control": "no-store",
                 "Vary": "Accept-Encoding"},
    )


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
