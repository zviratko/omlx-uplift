"""Uplift-owned data policy routes (SPLIT-1): retention (RL-0) and
experimental env tunables (ENV-1). Separate module so the facade can
mount them at their ORIGINAL registration position (between the
requests and patches blocks) — route order is load-bearing."""

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
                   _require_settings_manager, STATIC_DIR, _no_api_cache)
from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector


class RetentionRequest(BaseModel):
    metrics_days: int | None = None
    log_days: int | None = None


@api_router.get("/retention")
async def get_retention(is_admin: bool = Depends(require_admin)):
    from ..store import get_store

    return get_store().retention()


@api_router.post("/retention")
async def set_retention(
    req: RetentionRequest, is_admin: bool = Depends(require_admin)
):
    from ..store import get_store

    return get_store().set_retention(req.metrics_days, req.log_days)


@api_router.get("/env-overrides")
async def get_env_overrides(is_admin: bool = Depends(require_admin)):
    from .. import env_tunables

    return env_tunables.snapshot()


@api_router.get("/env-catalog")
async def get_env_catalog(is_admin: bool = Depends(require_admin)):
    """ENV-3: read-only documentation of the env-only omlx knobs — one row
    per variable with effect class, stock default, live/stored state, and
    the settable flag. Values of secret-ish vars arrive masked."""
    from .. import env_tunables

    return {"vars": env_tunables.catalog()}


@api_router.put("/env-overrides")
async def put_env_overrides(
    req: dict, is_admin: bool = Depends(require_admin)
):
    """Body: {\"<VAR>\": value|null}. null removes the stored override.
    Per-key outcome: applied_live | restart_model | restart_server |
    shadowed (stored for later; genuine launch env keeps precedence)."""
    from datetime import datetime as _dt

    from .. import env_tunables

    body = req or {}
    if not isinstance(body, dict) or not body:
        raise HTTPException(status_code=400, detail="body must be a non-empty object")
    # validate every key BEFORE touching anything (all-or-nothing)
    prepared: dict[str, "str | None"] = {}
    for name, value in body.items():
        if value is None:
            prepared[name] = None
            continue
        try:
            prepared[name] = env_tunables.coerce(name, value)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from None

    data = env_tunables.load_overrides()
    results = {}
    for name, value in prepared.items():
        if value is None:
            data.pop(name, None)
            # remove the uplift-written env var too; a genuine (shadowed)
            # env value must stay untouched
            if name in env_tunables.SHADOWED:
                results[name] = "shadowed"
            else:
                os.environ.pop(name, None)
                results[name] = "removed"
            continue
        data[name] = {
            "value": value,
            "set_at": _dt.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if name in env_tunables.SHADOWED:
            results[name] = "shadowed"
            continue
        effect = env_tunables.ALLOWED[name]["effect"]
        if effect == "immediate":
            os.environ[name] = value
            results[name] = "applied_live"
        elif effect == "model":
            # engine construction re-reads on the next model load only when
            # os.environ carries the value; seed it so no server restart is
            # needed (vanilla reads these at EngineConfig construction).
            os.environ[name] = value
            results[name] = "restart_model"
        else:
            results[name] = "restart_server"
    env_tunables.save_overrides(data)
    return {"results": results, **env_tunables.snapshot()}
