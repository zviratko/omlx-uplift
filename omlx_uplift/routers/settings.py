"""Settings domain (SPLIT-1): /models used_by overlay, per-model
settings GET/POST/DELETE, deferred two-phase saves (U41), profiles,
prune. Route names deliberately avoid vanilla collisions (registration
order: vanilla registers first and wins on the /admin/api alias)."""

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
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from .base import (api_router, page_router, require_admin, _RedirectToLogin,
                   engine_pool, settings_manager, global_settings,
                   STATIC_DIR, _no_api_cache)


def _require_settings_manager():
    """Same guard as base's — local copy on purpose: it resolves
    settings_manager through THIS module's globals, preserving the
    pre-split patch seam (one module used to hold both names)."""
    mgr = settings_manager()
    if mgr is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    return mgr

from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector


@api_router.get("/models")
async def models_overlay(is_admin: bool = Depends(require_admin)):
    """Vanilla GET /api/models verbatim, with a 'used_by' key per row.

    Delegates to the real omlx route function (no duplication, no drift):
    the drafter reference fields in stored settings are re-read here to
    build drafter -> [consumer ids], so the Helper page can show WHO uses
    a drafter instead of a meaningless load button.
    """
    from omlx.admin import routes as admin_routes

    data = await admin_routes.list_models(is_admin=True)
    mgr = settings_manager()
    helper_users: dict[str, set] = {}
    if mgr is not None:
        for _mid, _ms in mgr.get_all_settings().items():
            for _ref in (
                getattr(_ms, "specprefill_draft_model", None),
                getattr(_ms, "dflash_draft_model", None),
                getattr(_ms, "vlm_mtp_draft_model", None),
            ):
                if _ref:
                    helper_users.setdefault(_ref, set()).add(_mid)
    for row in data.get("models", []):
        users = set(helper_users.get(row.get("id"), set()))
        users |= helper_users.get(row.get("model_path") or "", set())
        users |= helper_users.get(row.get("source_repo_id") or "", set())
        users.discard(row.get("id"))
        row["used_by"] = sorted(users)
    return data


@api_router.get("/models/{model_id}/settings")
async def get_model_settings(
    model_id: str, is_admin: bool = Depends(require_admin)
):
    """Stored settings for one model: {id, settings} (to_dict strips None).

    Works for stored-only ("missing") ids too — the whole point of the
    record is that it survives the model directory.
    """
    mgr = _require_settings_manager()
    settings = mgr.get_settings(model_id)
    return {"id": model_id, "settings": settings.to_dict()}


@api_router.delete("/models/{model_id}/settings")
async def delete_model_settings_route(
    model_id: str, is_admin: bool = Depends(require_admin)
):
    """Clear stored settings for one model (reset to defaults)."""
    mgr = _require_settings_manager()
    if mgr.delete_settings(model_id):
        return {"deleted": model_id}
    raise HTTPException(status_code=404, detail=f"No stored settings: {model_id}")


@api_router.get("/models/{model_id}/deferred-settings")
async def get_deferred_settings_route(model_id: str,
                                      is_admin: bool = Depends(require_admin)):
    from ..store import get_store

    return {"id": model_id,
            "settings": get_store().get_deferred_settings(model_id)}


@api_router.post("/models/{model_id}/deferred-settings")
async def put_deferred_settings_route(model_id: str, request: Request,
                                      is_admin: bool = Depends(require_admin)):
    from ..store import get_store

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    settings = body.get("settings") if isinstance(body, dict) else None
    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="settings object expected")
    get_store().set_deferred_settings(model_id, settings)
    return {"id": model_id, "settings": settings}


@api_router.delete("/models/{model_id}/deferred-settings")
async def delete_deferred_settings_route(model_id: str,
                                         is_admin: bool = Depends(require_admin)):
    from ..store import get_store

    get_store().clear_deferred_settings(model_id)
    return {"cleared": model_id}


@api_router.get("/model-settings-index")
async def model_settings_index(is_admin: bool = Depends(require_admin)):
    """Stored model-settings ids vs models discovered on disk.

    Powers the Models manager 'stored/missing' counts and the prune
    dialog: {stored, known, orphans, entries:[{id, alias}]}.
    """
    mgr = _require_settings_manager()
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    all_settings = mgr.get_all_settings()
    known = set(pool.get_model_ids())
    alias_of = {
        mid: ms.model_alias
        for mid, ms in all_settings.items()
        if getattr(ms, "model_alias", None)
    }
    orphans = sorted(set(all_settings) - known - set(alias_of.values()))
    entries = sorted(
        ({"id": mid, "alias": alias_of.get(mid)} for mid in all_settings),
        key=lambda e: e["id"],
    )
    # stored profiles keyed by BASE id (a profile can exist without a base
    # settings record); the UI shows these as "base:profile" and prunes them.
    # Scanned over candidate ids (stored settings + on-disk models); the
    # private map stays private — vanilla's API is not extended for this.
    candidates = sorted(set(all_settings) | known)
    profiles = []
    for mid in candidates:
        for p in mgr.list_profiles(mid):
            profiles.append({"base": mid, "name": p.get("name") or "",
                             "display_name": p.get("display_name") or p.get("name") or "",
                             "api_name": p.get("api_name")})
    profiles.sort(key=lambda p: (p["base"], p["name"]))
    return {
        "stored": len(all_settings),
        "known": len(known),
        "orphans": orphans,
        "entries": entries,
        "profiles": profiles,
    }


@api_router.post("/models/{model_id}/settings")
async def upsert_model_settings(
    model_id: str, request: Request, is_admin: bool = Depends(require_admin)
):
    """Write stored settings for a model that is NOT on disk (missing).

    The classic PUT requires an engine-pool entry and 404s for missing
    ids, so stored-only records could never be edited. This writes
    straight through the manager — no reload/restart semantics exist
    for a model that is not loaded, and none is claimed.
    """
    mgr = _require_settings_manager()
    from omlx.model_settings import ModelSettings
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="settings object expected")
    merged = mgr.get_settings(model_id).to_dict()
    # to_dict strips None; an explicit null here means "back to default"
    merged.update(body)
    mgr.set_settings(model_id, ModelSettings.from_dict(merged))
    return {"id": model_id, "settings": mgr.get_settings(model_id).to_dict()}


@api_router.get("/models/{model_id}/profiles")
async def list_model_profiles_any(
    model_id: str, is_admin: bool = Depends(require_admin)
):
    """Stored profiles of a model id — works for missing (stored-only) ids,
    unlike the classic route which requires the model on disk."""
    mgr = _require_settings_manager()
    return {"profiles": mgr.list_profiles(model_id)}


@api_router.post("/models/{model_id}/profiles")
async def upsert_model_profile(
    model_id: str, request: Request, is_admin: bool = Depends(require_admin)
):
    """Create-or-update one stored profile by name, without requiring the
    base model to be on disk (missing-model editing). Update replaces the
    settings wholesale — same contract as the classic PUT."""
    mgr = _require_settings_manager()
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict) or not (body.get("name") or "").strip():
        raise HTTPException(status_code=400, detail="name required")
    name = body["name"].strip()
    display_name = (body.get("display_name") or name).strip()
    settings = body.get("settings") or {}
    existing = mgr.get_profile(model_id, name)
    if existing:
        result = mgr.update_profile(
            model_id, name, display_name=display_name,
            description=existing.get("description"), settings=settings,
            expose_as_model=bool(body.get("expose_as_model")),
            api_name=body.get("api_name"))
        return {"profile": result, "created": False}
    result = mgr.save_profile(
        model_id, name, display_name=display_name, description=None,
        settings=settings,
        expose_as_model=bool(body.get("expose_as_model")),
        api_name=body.get("api_name"))
    return {"profile": result, "created": True}


class PruneModelSettingsRequest(BaseModel):
    ids: list[str]
    profiles: list[dict] = []   # [{base, name}] — stored profiles to remove


@api_router.post("/prune-model-settings")
async def prune_model_settings(
    req: PruneModelSettingsRequest, is_admin: bool = Depends(require_admin)
):
    """Delete stored settings for the listed model ids (profiles of that
    base model go with them — delete_settings drops both). Extra
    `profiles` entries remove single profiles of models that stay."""
    mgr = _require_settings_manager()
    if not req.ids and not req.profiles:
        raise HTTPException(status_code=400, detail="ids required")
    removed = [mid for mid in dict.fromkeys(req.ids) if mgr.delete_settings(mid)]
    removed_profiles = []
    for ent in req.profiles:
        base, name = ent.get("base"), ent.get("name")
        if base and name and mgr.delete_profile(base, name):
            removed_profiles.append(f"{base}:{name}")
    return {"removed": removed, "removed_profiles": removed_profiles,
            "removed_templates": []}
