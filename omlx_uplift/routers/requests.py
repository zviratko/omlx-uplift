"""Request feed domain (SPLIT-1): stats, list, SSE stream, cancel,
detail (prompt decode), FTS search, model-chip list."""

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


@api_router.get("/requests")
async def list_requests(
    limit: int = 30, is_admin: bool = Depends(require_admin)
):
    """Live + recently finished requests, newest first."""
    import asyncio

    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    tracker = get_request_tracker()
    await asyncio.to_thread(tracker.sample, pool)
    return {"requests": tracker.list_rows(limit=limit), "enabled": True}


@api_router.get("/requests/stream")
async def stream_requests(is_admin: bool = Depends(require_admin)):
    """SSE feed of request lifecycle transitions (1 s sampling tick)."""
    import asyncio

    tracker = get_request_tracker()

    async def event_generator():
        # SSE-SPLIT-1: drain_dirty() hands the dirty set to whichever
        # connection drains first, so with two tabs open each loses the
        # transitions the other ate. Each connection now diffs a shared,
        # NON-destructive snapshot against its own 'seen' watermark —
        # every consumer sees every transition.
        seen: dict[str, tuple] = {}
        # seed with the current ring so a fresh connection sees only NEW
        # transitions (same contract the destructive drain had)
        for row in tracker.list_rows(limit=RING_LIMIT):
            seen[row.get("id")] = (row.get("state"),
                                   row.get("prompt_tokens"),
                                   row.get("completion_tokens"),
                                   bool(row.get("loop_hint")))
        try:
            while True:
                pool = engine_pool()
                if pool is not None:
                    await asyncio.to_thread(tracker.sample, pool)
                rows = []
                for row in tracker.list_rows(limit=RING_LIMIT):
                    mark = (row.get("state"), row.get("prompt_tokens"),
                            row.get("completion_tokens"),
                            bool(row.get("loop_hint")))
                    rid = row.get("id")
                    if rid and seen.get(rid) != mark:
                        seen[rid] = mark
                        rows.append(row)
                # keep the watermark bounded to what the ring can revisit
                if len(seen) > 4 * RING_LIMIT:
                    live = {r.get("id") for r in tracker.list_rows(
                        limit=RING_LIMIT)}
                    seen = {k: v for k, v in seen.items() if k in live}
                for row in rows:
                    ev = {
                        "type": "request",
                        "id": row["id"],
                        "state": row["state"],
                        "model": row.get("model", ""),
                        "origin": row.get("origin", "real"),
                        # RL-2: counters ride along so an open inspector
                        # modal updates progress without extra polls. Keep
                        # this small — full text is fetched by the modal.
                        "prompt": row.get("prompt_tokens"),
                        "completion": row.get("completion_tokens"),
                        "tps": row.get("tps"),
                        "loop_hint": bool(row.get("loop_hint")),
                        # IN-FLIGHT card: terminal reason for DONE/ABORTED/
                        # REFUSED labelling. Small scalars only.
                        "finish": row.get("finish"),
                        "error_code": row.get("error_code"),
                        "error": row.get("error"),
                        # ISSUE-8: lifecycle stamps (epoch seconds). The feed
                        # shows start before the id; start is exact when the
                        # birth hook fired, a sampling estimate otherwise.
                        "started_at": row.get("started_at"),
                        "ended_at": row.get("ended_at"),
                    }
                    yield f"data: {json.dumps(ev)}\n\n"
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@api_router.post("/requests/{request_id}/cancel")
async def cancel_request(
    request_id: str, is_admin: bool = Depends(require_admin)
):
    """Abort an in-flight request (goes through AsyncEngineCore.abort_request
    inside the tracker — the raw scheduler abort would hang the client)."""
    pool = engine_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail="Server not initialized")
    if await get_request_tracker().cancel(pool, request_id):
        return {"cancelled": request_id}
    raise HTTPException(status_code=404, detail=f"Request not found: {request_id}")


def _decode_prompt_ids(model_id: str, ids_json: str, truncated: bool):
    """ISSUE-3: decode a stored token-id sample with the model's tokenizer.

    Runs in a worker thread (tokenizer decode can take ~ms on big samples).
    Never raises: returns None-shaped blocks with an honest note when the
    engine is unloaded or the tokenizer chokes (skip_special_tokens keeps
    chat-template markers from spamming the view)."""
    import json as _json

    try:
        ids = _json.loads(ids_json)
    except ValueError:
        return None
    if not isinstance(ids, list) or not ids:
        return None
    text = None
    note = None
    pool = engine_pool()
    entry = pool.get_entry(model_id) if pool is not None and model_id else None
    engine = getattr(entry, "engine", None) if entry is not None else None
    tok = getattr(engine, "tokenizer", None) if engine is not None else None
    if tok is None:
        note = "model not loaded — tokens kept raw"
    else:
        try:
            text = tok.decode(ids, skip_special_tokens=True)
        except Exception:  # noqa: BLE001
            try:
                text = tok.decode(ids)
            except Exception:  # noqa: BLE001
                note = "tokenizer decode failed"
    return {"text": text, "note": note, "token_count": len(ids),
            "sample_truncated": bool(truncated)}


# NOTE: registered AFTER /requests/stream (a literal route registered first
# wins over this dynamic one in Starlette's order-based matching).
@api_router.get("/requests/{request_id}")
async def request_detail(
    request_id: str, is_admin: bool = Depends(require_admin)
):
    """RL-2 inspector payload: ring-buffer row merged with the stored row.

    Active tracker row wins per-field (it is the freshest); the stored row
    fills gaps (payload persisted by an earlier write_tick). `found:false`
    carries an honest note — never a half-truth from a stale merge.
    """
    import asyncio

    tracker = get_request_tracker()
    pool = engine_pool()
    if pool is not None:
        # refresh so an open modal sees state/payload move without a poll storm
        await asyncio.to_thread(tracker.sample, pool)
    live_row = tracker.lookup(request_id)
    is_live = live_row is not None and tracker.is_live(request_id)
    source = "active" if is_live else "stored"

    from ..store import get_store

    stored = await asyncio.to_thread(get_store().request_by_id, request_id)

    if live_row is None and stored is None:
        return {"found": False, "live": False, "source": None, "row": None,
                "note": "not in live ring buffer and not in the retention "
                        "window (check retention days in Layout settings)"}

    row = dict(stored or {})
    if live_row:
        row.update({k: v for k, v in live_row.items() if v is not None})
        if stored:
            source = "both"
    row.setdefault("id", request_id)

    def _payload(field, trunc_field):
        text = row.get(field)
        return {"text": text, "truncated": bool(row.get(trunc_field))} \
            if text is not None else None

    import json as _json
    params = None
    if row.get("params"):
        try:
            params = _json.loads(row["params"])
        except ValueError:
            params = {"raw": row["params"]}

    # ISSUE-3 decode: token-id prompts were stored as an opaque count. The
    # tracker now keeps a head+tail id sample; turn it back into text with
    # the model's live tokenizer (loaded engines only — an unloaded model
    # says so honestly instead of failing the whole inspector).
    prompt_decoded = None
    if row.get("prompt_ids"):
        prompt_decoded = await asyncio.to_thread(
            _decode_prompt_ids, row.get("model"), row["prompt_ids"],
            bool(row.get("prompt_ids_trunc")))

    timings = None
    t0, t1 = row.get("ts_start"), row.get("ts_end")
    if t0 and t1:
        total = max(0.0, float(t1) - float(t0))
        timings = {"total_s": round(total, 3)}   # prefill split not persisted
    return {
        "found": True, "live": is_live, "source": source,
        "row": {k: row.get(k) for k in
                ("id", "model", "state", "origin", "prompt_tokens",
                 "completion_tokens", "tps", "error", "finish",
                 "ts_start", "ts_end", "ts")},
        "prompt": _payload("prompt", "prompt_trunc"),
        "prompt_decoded": prompt_decoded,
        "output": _payload("output", "output_trunc"),
        "params": params,
        "timings": timings,
    }


@api_router.get("/requests-search")
async def search_requests(
    q: str = "", model: str = "", frm: float | None = None,
    to: float | None = None, limit: int = 50,
    is_admin: bool = Depends(require_admin),
):
    """GET /uplift/api/requests-search?q=&model=&from=&to=&limit=50.

    `frm`/`to` are epoch seconds (query param name avoids the python
    keyword). Returns {results, mode: 'fts'|'like'|'scan', q} — one SQL
    query per search, excerpt built server-side.
    """
    import asyncio

    from ..store import get_store

    return await asyncio.to_thread(
        get_store().search_requests, q=q, model=model,
        ts_from=frm, ts_to=to, limit=limit)


@api_router.get("/requests-models")
async def requests_models(
    frm: float | None = None, is_admin: bool = Depends(require_admin),
):
    """ISSUE-4: models with stored request history (optionally since epoch
    `frm`), for the search dropdown. The old client-side source — what this
    tab's live feed saw — is empty on a fresh page."""
    import asyncio

    from ..store import get_store

    return {"models": await asyncio.to_thread(
        get_store().distinct_models, ts_from=frm)}
