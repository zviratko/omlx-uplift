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
                   _require_settings_manager, STATIC_DIR, _no_api_cache,
                   gzip_or_json)
from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector
from .derive import (_HOURLY_DERIVE, _downsample, _hourly_points,
                     _pack_cols, _parse_window, _wire_v, bucket_for)


@api_router.get("/metrics/latest")
async def metrics_latest(keys: str = "", is_admin: bool = Depends(require_admin)):
    """Newest stored sample per key (U11): the Memory & cache chart pushes
    live sys.percent points through this instead of re-deriving a flat
    phys_footprint value client-side. HIST-1 visibility: this server's
    samples plus dead-session history; a live co-tenant's newer point must
    not drive the live line (latest() orders own rows first)."""
    wanted = [k.strip() for k in keys.split(",") if k.strip()][:16]
    store = get_collector().store
    # HIST-1: visibility policy — LOOP-SAFE: the whole dict runs in a
    # worker thread (latest() takes the store lock and may run the
    # once-per-TTL alien probe; 16 of those inline would queue every other
    # response behind them on this loop).
    def _read_all():
        inst = store.visible_instances()
        return {k: store.latest(k, instance=inst) for k in wanted}
    return {"latest": await asyncio.to_thread(_read_all)}


@api_router.get("/metrics/series")
async def metrics_series(
    request: Request,
    key: str = "",
    keys: str = "",
    window: str = "1h",
    after: float = 0.0,
    is_admin: bool = Depends(require_admin),
):
    """Series over WINDOW (5m..30d) for KEY, or for every key in
    comma-separated KEYS (multi-metric explorer: one request, one merged
    per-key response in `series_map`). Long windows (7h..30d) are averaged
    down to <=~1440 points/key in SQL bucket aggregation (res='avg',
    bucket_s advertised; see bucket_for + store.series_binned) — the raw
    path paid 17k-120k rows/key through Python and onto the wire for a
    ~700 px chart. Everyday windows (<=6 h) keep the raw 5 s collector
    resolution (ISSUE-7). Answers are gzipped when the client accepts it
    (PERF-1: multi-MB uncompressed bodies saturated the browser's
    ~6-per-origin HTTP/1.1 pool and starved the SSE streams).

    TAIL-1: AFTER (epoch seconds) returns ONLY points newer than AFTER —
    the raw fine tail, no binning, no history. The dashboard refetches
    every ~4.5 s per window (POP-PIN: one collector sample per fetch max);
    before TAIL-1 each of those re-paid the FULL window payload (measured:
    74 KB x ~12/min per open tab). With AFTER the steady-state response is
    a handful of points."""
    import asyncio

    wanted = [k.strip() for k in (keys or key).split(",") if k.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="key or keys required")
    window_s = _parse_window(window)
    store = get_collector().store
    # HIST-1: read own samples plus history from dead writers; a live
    # co-tenant sharing this DB stays filtered out (server_instance_id).
    inst = store.visible_instances()

    tail = after if after and after > 0 else None
    bucket = 0 if tail is not None else bucket_for(window_s)
    has_multi = callable(getattr(type(store), "series_multi", None))
    raw_map: dict[str, list[dict]] | None = None
    if has_multi and len(wanted) > 1:
        if tail is not None:
            raw_map = await asyncio.to_thread(
                store.series_multi, wanted, window_s, None, inst, tail)
        elif bucket:
            raw_map = await asyncio.to_thread(
                store.series_binned_multi, wanted, window_s, bucket, inst)
        else:
            raw_map = await asyncio.to_thread(
                store.series_multi, wanted, window_s, None, inst)

    async def one(k: str):
        if tail is not None:
            fine = (raw_map[k] if raw_map is not None
                    else await asyncio.to_thread(
                        lambda: store.series(k, window_s, None, inst, since=tail)))
            for p in fine:
                p["res"] = "fine"
            return _pack_cols(fine, "fine"), 0          # TAIL-1: raw new points only
        if bucket:
            # PERF-1: long window — bucket means computed in SQLite;
            # hourly rollups backfill the hours with no fine coverage.
            rows = (raw_map[k] if raw_map is not None
                    else await asyncio.to_thread(
                        lambda: store.series_binned(k, window_s, bucket, inst)))
            for p in rows:
                p["res"] = "avg"
            derive = _HOURLY_DERIVE.get(k)
            if derive is not None:
                hourly = await asyncio.to_thread(_hourly_points, derive, window_s)
                covered = {int(p["ts"] // 3600) for p in rows}
                extra = [p for p in hourly
                       if int(p["ts"] // 3600) not in covered]
                if extra:
                    rows += extra        # keep the 'hourly' res label
                    rows.sort(key=lambda p: p["ts"])
            for p in rows:             # SQUEEZE parity (wire 6 sig digits)
                p["v"] = _wire_v(p["v"])
            return _pack_cols(rows, "avg"), bucket
        fine = (raw_map[k] if raw_map is not None
                else await asyncio.to_thread(
                    lambda: store.series(k, window_s, None, inst)))
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
        pts, b = _downsample(merged)
        return _pack_cols(pts, "avg" if b else "fine"), b

    results = await asyncio.gather(*(one(k) for k in wanted))
    series_map, bucket = {}, 0
    for k, (pts, b) in zip(wanted, results):
        series_map[k] = pts
        bucket = max(bucket, b)
    if key and not keys:
        pts = series_map.get(key, [[], []])
        out = {"key": key, "window": window, "window_s": window_s,
               "bucket_s": bucket, "series": pts}
    else:
        out = {"keys": wanted, "window": window, "window_s": window_s,
               "bucket_s": bucket, "series_map": series_map}
    if tail is not None:
        out["after"] = tail         # client: merge-append, never replace
    # PERF-1: gzip the answer (serialize + compress off the event loop).
    return await asyncio.to_thread(gzip_or_json, out, request)


@api_router.get("/metrics/live")
async def metrics_live(is_admin: bool = Depends(require_admin)):
    """FAST-1: the 2 Hz in-memory ring snapshot (no SQLite). Fallback for
    clients without EventSource and the health probe for the stream —
    `live: false` tells the dashboard the fast sampler is not running so
    it falls back to the 5 s stored cadence instead of waiting."""
    from ..fast_sampler import get_fast_sampler

    return get_fast_sampler().snapshot()


@api_router.get("/metrics/stream")
async def metrics_stream(is_admin: bool = Depends(require_admin)):
    """FAST-1: SSE of the fast sampler's latest values (~2 Hz).

    Frame contract: first frame carries `samples` (the whole ring, so a
    reconnect replays what the tab missed); every later frame carries
    only the keys whose VALUE changed (per-connection diff — a change-
    driven frame, like the request stream's watermark). The tick channel
    of the samplers is untouched: this stream never writes to SQLite,
    the store keeps its exact one-value-per-5 s shape.

    STATS-SSE adds two OPTIONAL fields to the same frame — `s` (the
    vanilla /admin/api/stats payload) and `sa` (the all-time request
    total) — diff-sent the same way, off the shared StatsFeed ticker. They
    are only ever ADDED: `live`/`tick_s`/`at`/`samples`/`m` keep their
    exact bytes, so a client that does not know the lanes is unaffected,
    and a server whose vanilla seams are unavailable simply never emits
    them. See omlx_uplift/stats_feed.py for the payload contract.
    """
    from ..fast_sampler import FAST_TICK_S, get_fast_sampler
    from ..stats_feed import get_stats_feed

    sampler = get_fast_sampler()
    feed = get_stats_feed()

    async def event_generator():
        sent: dict[str, tuple] = {}
        first = True
        # SMOOTH-2: poll at 4x the sampler cadence. Frames stay
        # change-driven (a poll with no new value sends nothing, so the
        # bandwidth is unchanged), but the write-to-frame delay drops
        # from ~1 tick to ~125 ms — measured before: arrival gaps
        # alternated 501/1004 ms because the generator slept a whole
        # tick and kept missing writes.
        poll_s = max(0.05, FAST_TICK_S / 4)
        # STATS-SSE per-connection cursors into the SHARED cells — the 'm'
        # lane's `sent` dict applied to the two new fields. 0 means "never
        # sent", so the first frame carries both lanes whenever the server
        # can produce them, and a lane that has not moved is never re-sent.
        s_ver = 0
        a_ver = 0
        # Reference-counted: the FIRST subscribed connection starts the one
        # shared stats ticker, the LAST one leaves it an idle-stop countdown.
        # subscribe() must run inside the event loop, which a generator body
        # does on its first __anext__ (StreamingResponse drives it there).
        feed.subscribe()
        try:
            while True:
                snap = sampler.snapshot()
                metrics = snap["metrics"]
                frame: dict = {"live": snap["live"],
                               "tick_s": snap["tick_s"], "at": snap["at"]}
                if first:
                    frame["samples"] = {k: v["samples"]
                                        for k, v in metrics.items()}
                changed = {k: [v["ts"], v["v"]] for k, v in metrics.items()
                           if sent.get(k) != (v["ts"], v["v"])}
                if changed or first:
                    frame["m"] = changed
                    sent.update({k: tuple(v) for k, v in changed.items()})
                # --- 's' / 'sa': appended lanes, the keys above are untouched.
                # feed.off is the cheap latch for a server whose vanilla seams
                # are missing: no lock, no cell read, no log, every tick.
                lane = False
                if not feed.off:
                    # LOOP-SAFE: the first-frame build runs in a worker
                    # thread SHARED by all racing connections (never on the
                    # loop — the walk costs seconds on a live pool); after
                    # the cells exist this is a lock-guarded dict read only.
                    await feed.ensure_seeded()
                    st = feed.snapshot_now()
                    if st["s"] is not None and st["s_ver"] != s_ver:
                        frame["s"] = st["s"]
                        s_ver = st["s_ver"]
                        lane = True
                    if st["sa"] is not None and st["sa_ver"] != a_ver:
                        frame["sa"] = st["sa"]
                        a_ver = st["sa_ver"]
                        lane = True
                # A changed stats lane must produce a frame even when no fast
                # metric moved — an idle server still updates request counts.
                if changed or first or lane:
                    yield f"data: {json.dumps(frame)}\n\n"
                first = False
                await asyncio.sleep(poll_s)
        except asyncio.CancelledError:
            pass
        finally:
            # Cancellation is the NORMAL exit here (tab close / navigate
            # away), so the release lives in finally, not in the handler:
            # any path out of the loop drops this connection's reference.
            feed.unsubscribe()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@api_router.get("/metrics/hot")
async def metrics_hot(request: Request,
                      window: str = "1h",
                      is_admin: bool = Depends(require_admin)):
    """All per-model hot-cache series ('hot.<model>') over WINDOW.
    Discovery endpoint: the key names carry model ids the client cannot
    know up front (a drained model must still backfill after a page
    refresh — 'hot.<model>' keys are stable per model since 2026-09-30).
    PERF-1: discovery is a window-scoped index walk with a shared TTL
    cache (no more full LIKE scan per call); the series answer uses the
    same bucket ladder as /metrics/series (long windows averaged in SQL,
    bucket_s advertised); response gzipped when the client accepts it."""
    window_s = _parse_window(window)
    store = get_collector().store
    # HIST-1: same visible-history policy as /metrics/series.
    inst = store.visible_instances()

    keys = await asyncio.to_thread(store.keys_with_prefix, "hot.", window_s, inst)
    bucket = bucket_for(window_s)
    has_multi = callable(getattr(type(store), "series_multi", None))
    raw_map: dict[str, list[dict]] | None = None
    if has_multi and len(keys) > 1:
        if bucket:
            raw_map = await asyncio.to_thread(
                store.series_binned_multi, keys, window_s, bucket, inst)
        else:
            raw_map = await asyncio.to_thread(
                store.series_multi, keys, window_s, None, inst)

    async def one(k: str):
        if bucket:
            rows = (raw_map[k] if raw_map is not None
                    else await asyncio.to_thread(
                        lambda: store.series_binned(k, window_s, bucket, inst)))
            for p in rows:
                p["res"] = "avg"
                p["v"] = _wire_v(p["v"])
            return _pack_cols(rows, "avg")
        fine = (raw_map[k] if raw_map is not None
                else await asyncio.to_thread(store.series, k, window_s, None, inst))
        for p in fine:
            p["res"] = "fine"
            p["v"] = _wire_v(p["v"])
        return _pack_cols(fine, "fine")

    results = await asyncio.gather(*(one(k) for k in keys))
    series_map = {k: pts for k, pts in zip(keys, results)}
    out = {"keys": keys, "window": window, "window_s": window_s,
           "bucket_s": bucket, "series_map": series_map}
    return await asyncio.to_thread(gzip_or_json, out, request)


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
