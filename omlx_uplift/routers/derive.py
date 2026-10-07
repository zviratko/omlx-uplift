"""Shared series/window derivation (SPLIT-1): downsampling, hourly
rollups, usage-column aggregation. Used by BOTH metrics and requests;
viewer.py imports these names directly."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
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

_log = logging.getLogger("omlx_uplift.derive")


# --------------------------------------------------------------------------
# Persistent metrics: merge uplift's sub-hour samples with vanilla's
# hourly rollups (~/.omlx/usage.sqlite3, opened READ-ONLY — we never write
# it). Points carry res='fine'|'hourly' so the UI can label the resolution
# boundary honestly instead of pretending one uniform series.
# --------------------------------------------------------------------------

# uplift sample key -> derivation from a model_usage_hourly aggregate row
_HOURLY_DERIVE = {
    "rate.prompt_tokens_s":   lambda r: r["prompt_tokens"] / 3600.0,
    "rate.completion_tokens_s": lambda r: r["completion_tokens"] / 3600.0,
    # BE-decode: the momentary decode line's hourly backfill is the hour's
    # MEAN tokens/s — the same quantity a downsampled fine series would
    # show for that bucket (completion tokens are the only decode work the
    # usage table records per hour).
    "generation.tokens_s":    lambda r: r["completion_tokens"] / 3600.0,
    "rate.requests_s":        lambda r: r["requests"] / 3600.0,
    # SCALE-1 follow-up (2026-10-07): the LIVE key is a PERCENT (vanilla
    # server_metrics._build_snapshot: cached / prompt * 100; uplift's
    # collector passes it through) — this backfill divided raw, so every
    # hourly point was a 0..1 RATIO. Auto-scaled axes hid the mismatch;
    # with percent cards pinned to 0..100 a 7 d backfill would draw flat
    # along the floor (0.4% of the axis). Mirror the live formula: ×100 out.
    "cache_efficiency":       lambda r: (100.0 * r["cached_tokens"] / r["prompt_tokens"])
                                        if r["prompt_tokens"] else None,
    # (prompt - cached) / prefill_seconds, NOT prompt / prefill_seconds:
    # upstream's own live metric (server_metrics._build_snapshot) divides
    # only the tokens it actually processed. Deriving the hourly backfill
    # from raw prompt_tokens inflated prefill TPS up to +45% vs the live
    # number on cache-heavy hours (user 2026-09-29: uplift prefill series
    # much higher than classic / unrealistic).
    "avg_prefill_tps":        lambda r: ((r["prompt_tokens"] - r["cached_tokens"])
                                         / r["prefill_seconds"])
                                        if r["prefill_seconds"] and
                                        r["prompt_tokens"] >= r["cached_tokens"]
                                        else None,
    "avg_generation_tps":     lambda r: (r["completion_tokens"] / r["generation_seconds"])
                                        if r["generation_seconds"] else None,
}


# usage columns needed by the derivations above
_USAGE_COLS = ("requests", "prompt_tokens", "completion_tokens",
               "cached_tokens", "prefill_seconds", "generation_seconds")


# ISSUE-7: 2000 started averaging at ~2.8 h (100 s buckets by 6 h) — far too
# coarse for the everyday windows. 20000 keeps the full 5 s collector
# resolution through 24 h (17.3k pts) and only aggregates 7 d / 30 d.
MAX_SERIES_POINTS = 20000


def _downsample(points: list[dict], max_pts: int = MAX_SERIES_POINTS):
    """Average into equal-width buckets so a 30d pull is ~thousands of
    points, not hundreds of thousands. Buckets align to wall-clock
    multiples of bucket_s; each output point carries the bucket START and
    res='avg' (plus the true resolution inside: 'hourly' stays hourly if
    the whole bucket came from coarse rollups). Returns (points, bucket_s)
    or (points, 0) when no downsampling was needed."""
    if len(points) <= max_pts:
        return points, 0
    span = points[-1]["ts"] - points[0]["ts"] or 1.0
    # Next power of 10 that fits the cap; 60 s is the honest floor (never
    # advertise sub-minute averages). The pow-of-10 step guarantees the
    # 60 s clamp cannot overshoot the cap (raw < 60 => span/60 < max_pts).
    bucket_s = max(60.0, 10.0 ** math.ceil(math.log10(span / max_pts)))
    buckets: dict[int, list[dict]] = {}
    for p in points:
        buckets.setdefault(int(p["ts"] // bucket_s), []).append(p)
    out = []
    for b in sorted(buckets):
        rows = buckets[b]
        vals = [r["v"] for r in rows if r["v"] is not None]
        if not vals:
            continue
        res = "hourly" if all(r["res"] == "hourly" for r in rows) else "avg"
        out.append({"ts": b * bucket_s, "v": sum(vals) / len(vals), "res": res})
    return out, bucket_s


def _parse_window(window: str) -> float:
    units = {"m": 60, "h": 3600, "d": 86400}
    w = (window or "1h").strip().lower()
    if w[-1] in units and w[:-1].isdigit():
        return int(w[:-1]) * units[w[-1]]
    raise HTTPException(status_code=400,
                        detail=f"bad window '{window}' (use e.g. 15m/1h/6h/24h/7d)")


def _hourly_points(derive, window_s: float) -> list[dict]:
    """Coarse history from vanilla's usage.sqlite3, READ-ONLY. Rows are
    per (hour, model) — aggregate to per-hour totals BEFORE deriving, so
    one rate = one point per hour (a server-wide chart, not per-model)."""
    from ..store import open_usage_ro

    try:
        conn = open_usage_ro()
    except Exception as exc:  # noqa: BLE001
        # LOG-SILENT-1: missing/locked DB is fine (fine layer alone is
        # honest) — but a real error here silently empties every coarse
        # chart on an HTTP 200, indistinguishable from 'no history yet'.
        _log.warning("hourly layer disabled this tick: usage DB "
                     "unreachable: %s", exc)
        return []
    try:
        t0 = time.time() - window_s
        sums = ", ".join(f"SUM({c}) AS {c}" for c in _USAGE_COLS)
        cur = conn.execute(
            f"SELECT timestamp_hour, {sums} FROM model_usage_hourly "
            "WHERE timestamp_hour >= ? GROUP BY timestamp_hour "
            "ORDER BY timestamp_hour",
            (int(t0),),
        )
        out = []
        for row in cur.fetchall():
            agg = dict(zip(("timestamp_hour",) + _USAGE_COLS, row))
            ts = agg.pop("timestamp_hour")
            agg = {k: (v or 0) for k, v in agg.items()}
            try:
                v = derive(agg)
            except Exception:
                continue
            if v is not None:
                out.append({"ts": float(ts), "v": float(v), "res": "hourly"})
        return out
    finally:
        conn.close()
