"""Skins API (SPLIT-1): catalog, theme.css and resource serving
(ETag/304 helpers shared with the page surface)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, HTTPException, Request
from starlette.responses import Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from .base import (api_router, page_router, require_admin, _RedirectToLogin,
                   engine_pool, settings_manager, global_settings,
                   _require_settings_manager, STATIC_DIR, _no_api_cache)
from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector
from .pages import _not_modified, _static_etag


@api_router.get("/skins")
async def skins_list(is_admin: bool = Depends(require_admin)):
    from .. import skins

    entries = await asyncio.to_thread(skins.list_skins)
    # reason/warnings are uplift-owned diagnostics; name/label/ts/stale/
    # yml_newer/classic are the picker contract (design section 3)
    return {"skins": entries}


@api_router.get("/skins/{sel}/theme.css")
async def skin_theme_css(sel: str, request: Request,
                         is_admin: bool = Depends(require_admin)):
    from .. import skins

    root, entry = await asyncio.to_thread(skins.skin_state, sel)
    if entry is None or entry.get("dir") is None:
        raise HTTPException(status_code=404, detail="skin not found")
    css, etag = await asyncio.to_thread(skins.theme_css, root, entry)
    if _not_modified(request, etag, time.time()):
        return Response(status_code=304, headers={"ETag": etag})
    # no-cache: revalidate every load (same story as uplift.css — hand
    # edits to overlay.css must show on the next refresh, no rebuild)
    return Response(content=css, media_type="text/css; charset=utf-8",
                    headers={"ETag": etag, "Cache-Control": "no-cache",
                             "X-Content-Type-Options": "nosniff"})


@api_router.get("/skins/{sel}/res/{rel:path}")
async def skin_res(sel: str, rel: str, request: Request,
                   is_admin: bool = Depends(require_admin)):
    from .. import skins

    root, entry = await asyncio.to_thread(skins.skin_state, sel)
    if entry is None or entry.get("dir") is None:
        raise HTTPException(status_code=404, detail="skin not found")
    if not skins.RES_RE.match(rel):
        raise HTTPException(status_code=404, detail="resource not found")
    path = skins._safe_child(root / entry["dir"], rel)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="resource not found")
    media_type = skins.res_media_type(rel)
    st = path.stat()
    etag = _static_etag(st)
    if _not_modified(request, etag, st.st_mtime):
        return Response(status_code=304, headers={"ETag": etag})
    # nosniff always; a hand-dropped file outside the extension whitelist
    # downloads as octet-stream, its type is never inferred from content
    return FileResponse(path, media_type=media_type,
                        headers={"Cache-Control": "no-cache",
                                 "X-Content-Type-Options": "nosniff"})
