"""UP-64: model update routes (state, check now, ignore rules).

- GET  /model-updates          cached result; starts a background check when
                               the last one is older than the interval.
- POST /model-updates/check    check now (optional ``hf_token`` for gated
                               repos; used for this call only, never stored).
- POST /model-updates/ignore   ``{repo_id, mode}`` with mode ``version``
                               (this Hub commit), ``model`` (every update of
                               the repo) or ``none`` (stop ignoring).
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from .. import model_updates as MU
from .base import api_router, require_admin


@api_router.get("/model-updates")
async def model_updates_state(_auth=Depends(require_admin)):
    MU.ensure_check()
    return MU.view(MU.load())


@api_router.post("/model-updates/check")
async def model_updates_check(request: Request, _auth=Depends(require_admin)):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    token = str((body or {}).get("hf_token") or "") if isinstance(body, dict) else ""
    task = MU.ensure_check(force=True, token=token)
    if task is None:
        raise HTTPException(status_code=503, detail="Downloader not initialized")
    await task
    return MU.view(MU.load())


@api_router.post("/model-updates/ignore")
async def model_updates_ignore(request: Request, _auth=Depends(require_admin)):
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="JSON object required")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    repo = str(body.get("repo_id") or "").strip()
    if not repo or "/" not in repo or len(repo) > 200:
        raise HTTPException(status_code=400, detail="repo_id required")
    try:
        st = MU.set_ignore(repo, body.get("mode"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return MU.view(st)
