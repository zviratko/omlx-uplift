"""Metrics API (SPLIT-1): /metrics/latest, /metrics/series, /metrics/hot."""

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
from .derive import _HOURLY_DERIVE, _downsample, _hourly_points, _parse_window


@api_router.get("/metrics/latest")
async def metrics_latest(keys: str = "", is_admin: bool = Depends(require_admin)):
    """Newest stored sample per key (U11): the Memory & cache chart pushes
    live sys.percent points through this instead of re-deriving a flat
    phys_footprint value client-side. Filtered to THIS server's samples
    (plus untagged legacy rows) — a co-tenant's collector must not drive
    the live line."""
    wanted = [k.strip() for k in keys.split(",") if k.strip()][:16]
    store = get_collector().store
    from ..store import server_instance_id

    inst = server_instance_id()
    return {"latest": {k: store.latest(k, instance=inst) for k in wanted}}


@api_router.get("/metrics/series")
async def metrics_series(
    key: str = "",
    keys: str = "",
    window: str = "1h",
    is_admin: bool = Depends(require_admin),
):
    """Series over WINDOW (5m..30d) for KEY, or for every key in
    comma-separated KEYS (multi-metric explorer: one request, one merged
    per-key response in `series_map`). Long windows are averaged down to
    ~MAX_SERIES_POINTS points and say so (res='avg', bucket_s)."""
    import asyncio

    wanted = [k.strip() for k in (keys or key).split(",") if k.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="key or keys required")
    window_s = _parse_window(window)
    store = get_collector().store
    from ..store import server_instance_id

    inst = server_instance_id()

    async def one(k: str):
        fine = await asyncio.to_thread(store.series, k, window_s, None, inst)
        for p in fine:
            p["res"] = "fine"
        hourly = []
        derive = _HOURLY_DERIVE.get(k)
        if derive is not None:
            hourly = await asyncio.to_thread(_hourly_points, derive, window_s)
        # Fine points win where both exist (dedupe by hour bucket).
        fine_hours = {int(p["ts"] // 3600) for p in fine}
        merged = fine + [p for p in hourly if int(p["ts"] // 3600) not in fine_hours]
        merged.sort(key=lambda p: p["ts"])
        return _downsample(merged)

    results = await asyncio.gather(*(one(k) for k in wanted))
    series_map, bucket = {}, 0
    for k, (pts, b) in zip(wanted, results):
        series_map[k] = pts
        bucket = max(bucket, b)
    if key and not keys:
        pts = series_map.get(key, [])
        return {"key": key, "window": window, "window_s": window_s,
                "bucket_s": bucket, "series": pts}
    return {"keys": wanted, "window": window, "window_s": window_s,
            "bucket_s": bucket, "series_map": series_map}


@api_router.get("/metrics/hot")
async def metrics_hot(window: str = "1h",
                      is_admin: bool = Depends(require_admin)):
    """All per-model hot-cache series ('hot.<model>') over WINDOW.
    Discovery endpoint: the key names carry model ids the client cannot
    know up front (a drained model must still backfill after a page
    refresh — 'hot.<model>' keys are stable per model since 2026-09-30).
    Same point shape / downsampling as /metrics/series (multi-key form)."""
    import asyncio

    window_s = _parse_window(window)
    store = get_collector().store
    from ..store import server_instance_id

    inst = server_instance_id()
    keys = await asyncio.to_thread(store.keys_with_prefix, "hot.", window_s, inst)

    async def one(k: str):
        fine = await asyncio.to_thread(store.series, k, window_s, None, inst)
        for p in fine:
            p["res"] = "fine"
        return _downsample(fine)

    results = await asyncio.gather(*(one(k) for k in keys))
    series_map, bucket = {}, 0
    for k, (pts, b) in zip(keys, results):
        series_map[k] = pts
        bucket = max(bucket, b)
    return {"keys": keys, "window": window, "window_s": window_s,
            "bucket_s": bucket, "series_map": series_map}


@api_router.get("/requests/stats")
async def requests_stats(window: str = "1h",
                         is_admin: bool = Depends(require_admin)):
    """U17: full-population request-size stats over WINDOW, computed from
    the stored requests table (client tracker only ever saw the page-open
    session and reset on refresh — the user read every Request sizes
    counter as '—' even while the model served). Rows are retention-capped
    so the Python-side percentile is cheap; n=0 blocks every value so the
    card stays honest instead of inventing one.

    Response shape matches what core.js normalize() forwards as
    stats.request_stats: prompt_tokens/completion_tokens/first_token_ms
    each {avg, p50, p90, p95, p99}, plus errors_total and n."""
    import asyncio

    window_s = _parse_window(window)
    store = get_collector().store

    def query():
        # requests rows are tiny (retention-capped); read under the store's
        # own lock — the collector thread writes on the same connection.
        t0 = time.time() - window_s
        with store._lock:
            return store._conn.execute(
                "SELECT state, prompt_tokens, completion_tokens, first_token_ms"
                " FROM requests WHERE ts_end >= ?", (t0,)).fetchall()

    def pct(vals, p):
        if not vals:
            return None
        s = sorted(vals)
        k = (len(s) - 1) * p / 100.0
        lo, hi = int(k), min(int(k) + 1, len(s) - 1)
        return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)

    def blk(vals):
        vals = [v for v in vals if v is not None]
        return {"n": len(vals),
                "avg": round(sum(vals) / len(vals), 1) if vals else None,
                "p50": pct(vals, 50), "p90": pct(vals, 90),
                "p95": pct(vals, 95), "p99": pct(vals, 99)}

    rows = await asyncio.to_thread(query)
    prompts, combs, ftms, errs = [], [], [], 0
    for state, pt, ct, ftm in rows:
        prompts.append(pt)
        combs.append(ct if state == "complete" else None)
        ftms.append(ftm)
        if state in ("error", "aborted"):
            errs += 1
    return {"window": window, "window_s": window_s,
            "prompt_tokens": blk(prompts),
            "completion_tokens": blk(combs),
            "first_token_ms": blk(ftms),
            "errors_total": errs,
            "observed_real": len(rows),
            "source": "uplift store (2 d retention)"}
