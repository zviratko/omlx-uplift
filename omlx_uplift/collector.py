"""Background metrics collector — runs inside omlx's own asyncio loop.

Started by register() (app startup handler) — NO separate daemon. Ticks
every TICK_S seconds regardless of any open browser: samples the process
ServerMetrics snapshot (exact token/cache totals — same process, so no
HTTP loopback needed), engine pool state, and the request tracker rows,
then persists to the Uplift-owned SQLite store.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

log = logging.getLogger("omlx_uplift.collector")

TICK_S = 5.0


class Collector:
    def __init__(self, store=None, tick_s: float = TICK_S):
        self._store = store
        self._tick = tick_s
        self._task: Optional[asyncio.Task] = None
        self._prev: dict[str, float] = {}
        self._purged_day = 0

    @property
    def store(self):
        if self._store is None:
            from .store import get_store

            self._store = get_store()
        return self._store

    async def start(self):
        if self._task is None or self._task.done():
            self._task = asyncio.ensure_future(self._run())
            log.info("uplift metrics collector started (tick %.1fs)", self._tick)

    async def stop(self):
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self):
        while True:
            try:
                await asyncio.to_thread(self.sample_once)
            except asyncio.CancelledError:
                raise
            except Exception:  # never die on a bad tick
                log.exception("collector tick failed")
            await asyncio.sleep(self._tick)

    # -- one tick ----------------------------------------------------------

    def sample_once(self):
        from omlx.server_metrics import get_server_metrics

        snap = get_server_metrics().get_snapshot()
        now = time.time()
        pairs: dict[str, float] = {}
        for key in (
            "total_prompt_tokens",
            "total_completion_tokens",
            "total_cached_tokens",
            "total_requests",
            "total_tokens_served",
        ):
            v = snap.get(key)
            if isinstance(v, (int, float)):
                pairs["tot." + key] = float(v)
        for key in ("cache_efficiency", "avg_prefill_tps", "avg_generation_tps"):
            v = snap.get(key)
            if isinstance(v, (int, float)):
                pairs[key] = float(v)

        # Derived rates from totals deltas (exact counts -> honest rate).
        dt = now - self._prev.get("_t", now)
        if dt > 0 and "_t" in self._prev:
            d_prompt = pairs.get("tot.total_prompt_tokens", 0) - self._prev.get(
                "tot.total_prompt_tokens", 0
            )
            d_comp = pairs.get("tot.total_completion_tokens", 0) - self._prev.get(
                "tot.total_completion_tokens", 0
            )
            d_req = pairs.get("tot.total_requests", 0) - self._prev.get(
                "tot.total_requests", 0
            )
            if d_prompt >= 0:
                pairs["rate.prompt_tokens_s"] = d_prompt / dt
            if d_comp >= 0:
                pairs["rate.completion_tokens_s"] = d_comp / dt
            if d_req >= 0:
                pairs["rate.requests_s"] = d_req / dt

        # Engine pool state
        try:
            from .router import engine_pool

            pool = engine_pool()
            if pool is not None:
                ids = list(pool.get_model_ids())
                pairs["engines.loaded"] = float(len(ids))
                active = 0
                for mid in ids:
                    try:
                        entry = pool.get_entry(mid)
                        sched = getattr(entry, "engine", None)
                        sched = getattr(sched, "_engine", sched)
                        q = getattr(sched, "num_requests_running", None)
                        if q is not None:
                            active += int(q)
                    except Exception:
                        pass
                pairs["engines.active_requests"] = float(active)
        except Exception:
            pass

        # Memory + cache gauges (same sources classic's /admin/api/stats
        # uses) so the chart explorer can draw persistent memory history.
        try:
            from omlx.server import _server_state

            pool = engine_pool()
            if pool is not None:
                used = 0
                enf = getattr(_server_state, "process_memory_enforcer", None)
                if enf is not None and getattr(enf, "enabled", lambda: False)():
                    try:
                        used = int(enf.get_status().get("current_bytes", 0))
                        maxb = int(enf.get_final_ceiling())
                    except Exception:
                        used, maxb = 0, 0
                else:
                    used = int(getattr(pool, "current_model_memory", 0) or 0)
                    cb = getattr(pool, "_get_final_ceiling", None)
                    maxb = int(cb()) if callable(cb) else 0
                pairs["mem.used_bytes"] = float(used)
                if maxb > 0:
                    pairs["mem.percent"] = 100.0 * used / maxb
        except Exception:
            pass
        # Runtime cache totals + top-3 hot-cache models (cheap per-entry
        # probes; classic's full observability builder is too heavy per tick)
        try:
            pool = engine_pool()
            if pool is not None:
                total_bytes = 0
                hot: dict[str, int] = {}
                for mid in pool.get_model_ids():
                    try:
                        entry = pool.get_entry(mid)
                        eng = getattr(entry, "engine", None)
                        eng = getattr(eng, "_engine", eng)
                        fn = getattr(eng, "get_runtime_cache_stats", None)
                        if not callable(fn):
                            continue
                        st = fn() or {}
                        total_bytes += int(st.get("total_size_bytes", 0) or 0)
                        hb = int(st.get("hot_cache_size_bytes", 0) or 0)
                        if hb > 0:
                            hot[mid] = hb
                    except Exception:
                        pass
                pairs["cache.total_bytes"] = float(total_bytes)
                for rank, mid in enumerate(sorted(hot, key=lambda m: -hot[m])[:3]):
                    pairs["hot%d.%s" % (rank + 1, mid)] = float(hot[mid])
        except Exception:
            pass

        # Per-request lifecycle rows from the sampled tracker
        try:
            from .request_log import get_request_tracker

            tracker = get_request_tracker()
            for row in tracker.list_rows(limit=200):
                self.store.upsert_request(row)
        except Exception:
            log.debug("request persist failed", exc_info=True)

        self.store.write_samples(pairs, ts=now)
        self._prev = {**pairs, "_t": now}

        # Daily retention purge
        day = int(now // 86400)
        if day != self._purged_day:
            self._purged_day = day
            self.store.purge()


_collector: Optional[Collector] = None


def get_collector() -> Collector:
    global _collector
    if _collector is None:
        _collector = Collector()
    return _collector
