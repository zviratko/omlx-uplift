"""Patches API (SPLIT-1): the PATCHES card endpoints. patchsource /
curated / patches stay lazily imported inside handlers — deliberate:
boot cost AND the monkeypatch seams tests rely on."""

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


def patch_store():
    """Indirection for tests: returns the active PatchStore."""
    from .. import patches as _patches

    return _patches.PatchStore()


def _patch_tree_root() -> str:
    from .. import patches as _patches

    root = _patches._omlx_root()
    if not root:
        raise HTTPException(status_code=503,
                            detail="omlx package tree not found")
    return os.path.dirname(root)  # safe_join roots at the site-packages level


@api_router.get("/patches")
async def patches_view(is_admin: bool = Depends(require_admin)):
    from .. import patchsource, patches as _patches

    store = patch_store()
    keg = _patches.keg_id()
    return patchsource.view(store, _patch_tree_root(), keg)


class PatchAddRequest(BaseModel):
    id: str
    kind: str                      # github_pr | url | upload
    repo: Optional[str] = None
    pr: Optional[int] = None
    url: Optional[str] = None
    data: Optional[str] = None     # upload: the diff text
    insecure_tls: bool = False
    order: int = 100
    reversal: bool = False         # undo a merged change (apply in reverse)
    scope: Optional[str] = None    # DEV-1: runtime | build (None = auto-classify)


@api_router.post("/patches/add")
async def patches_add(req: PatchAddRequest, is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    source = {"kind": req.kind, "repo": req.repo, "pr": req.pr,
              "url": req.url, "insecure_tls": req.insecure_tls}
    if req.kind == "upload":
        if req.data is None:
            raise HTTPException(status_code=400, detail="upload needs 'data'")
        source["data"] = req.data.encode("utf-8")
    res = await asyncio.to_thread(
        patchsource.add_patch, patch_store(), req.id, source,
        _patch_tree_root(), order=req.order,
        reversal=req.reversal, scope=req.scope,
        build_root=patchsource.dev_build_root())
    if not res.get("ok") and res.get("stage") in ("fetch", "source"):
        raise HTTPException(status_code=422, detail=res.get("reason"))
    return res


@api_router.post("/patches/check")
async def patches_check(is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    return await asyncio.to_thread(patchsource.check_all, patch_store(),
                                   _patch_tree_root())


@api_router.get("/patches/curated")
async def patches_curated(is_admin: bool = Depends(require_admin)):
    """Remote catalog preview: tiers + per-entry manifest descriptions,
    marked against what the local store already holds. Read-only."""
    from .. import curated

    res = await asyncio.to_thread(curated.list_remote)
    store = patch_store()
    manifest = store.load()
    for tier in res["tiers"].values():
        for e in tier:
            # installed is a SOURCE question, not an id question: the
            # user's own patch that links the same PR counts as installed
            p = curated.find_by_source(manifest, e.get("source")) \
                or store.find(manifest, e["id"])
            e["installed"] = p is not None
            if p is not None:
                e["under_id"] = p["id"]
                e["enabled"] = bool(p.get("enabled"))
                e["adopted"] = bool(p.get("curated_adopted"))
    return res


@api_router.post("/patches/curated/sync")
async def patches_curated_sync(is_admin: bool = Depends(require_admin)):
    from .. import curated, patchsource

    return await asyncio.to_thread(
        curated.sync, patch_store(), _patch_tree_root(),
        build_root=patchsource.dev_build_root())


class PatchIdRequest(BaseModel):
    id: str


@api_router.post("/patches/curated/adopt")
async def patches_curated_adopt(req: PatchIdRequest,
                                is_admin: bool = Depends(require_admin)):
    """Adopt a catalog patch as local — unbundle it without deleting.
    The patch keeps id/state/files; future syncs ignore it."""
    from .. import curated

    res = curated.adopt(patch_store(), req.id)
    if not res.get("ok"):
        raise HTTPException(status_code=404, detail=res.get("reason"))
    return res


class PatchApproveRequest(BaseModel):
    id: str
    approve: Optional[str] = None    # "once" | "always" (safeguard codes)


class PatchVersionRequest(BaseModel):
    id: str
    v: Optional[int] = None


@api_router.post("/patches/enable")
async def patches_enable(req: PatchApproveRequest,
                         is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    res = patchsource.set_enabled(patch_store(), req.id, True,
                                  approve=req.approve)
    if not res.get("ok"):
        raise HTTPException(status_code=409 if res.get("requires_approval")
                            else 422, detail=res.get("reason"))
    return res


@api_router.post("/patches/disable")
async def patches_disable(req: PatchIdRequest, is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    res = patchsource.set_enabled(patch_store(), req.id, False)
    if not res.get("ok"):
        raise HTTPException(status_code=422, detail=res.get("reason"))
    return res


@api_router.post("/patches/promote")
async def patches_promote(req: PatchApproveRequest,
                          is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    res = patchsource.promote(patch_store(), req.id, approve=req.approve)
    if not res.get("ok"):
        raise HTTPException(status_code=409 if res.get("requires_approval")
                            else 422, detail=res.get("reason"))
    return res


@api_router.post("/patches/rollback")
async def patches_rollback(req: PatchVersionRequest,
                           is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    res = patchsource.rollback(patch_store(), req.id, to_v=req.v)
    if not res.get("ok"):
        raise HTTPException(status_code=422, detail=res.get("reason"))
    return res


@api_router.post("/patches/remove")
async def patches_remove(req: PatchIdRequest, is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    res = patchsource.remove_patch(patch_store(), req.id, _patch_tree_root())
    if not res.get("ok"):
        raise HTTPException(status_code=404, detail=res.get("reason"))
    return res


@api_router.post("/patches/test")
async def patches_test(req: PatchIdRequest, is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    res = patchsource.test_dry_run(patch_store(), req.id, _patch_tree_root())
    if not res.get("ok") and not res.get("files"):
        raise HTTPException(status_code=422, detail=res.get("reason"))
    return res


@api_router.get("/patches/diff/{patch_id}/{version}")
async def patches_diff(patch_id: str, version: int,
                       is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    data = patchsource.get_diff(patch_store(), patch_id, version)
    if data is None:
        raise HTTPException(status_code=404, detail="patch version not found")
    return Response(content=data.decode("utf-8", "replace"),
                    media_type="text/plain; charset=utf-8")


class PatchConfigRequest(BaseModel):
    auto_update_check: Optional[bool] = None


@api_router.post("/patches/config")
async def patches_config(req: PatchConfigRequest,
                         is_admin: bool = Depends(require_admin)):
    from .. import patchsource

    return patchsource.set_config(patch_store(), req.auto_update_check)
