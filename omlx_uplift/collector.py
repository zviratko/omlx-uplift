"""Background metrics collector — runs inside omlx's own asyncio loop.

Started by register() (app startup handler) — NO separate daemon. Ticks
every TICK_S seconds regardless of any open browser: samples the process
ServerMetrics snapshot (exact token/cache totals — same process, so no
HTTP loopback needed), engine pool state, and the request tracker rows,
then persists to the Uplift-owned SQLite store.

BE-2: the metric families themselves live in collectors.py (pure
functions over pool/snap/state) and the scheduler walk in corewalk.py.
This class keeps ONLY: previous-tick state, the tick loop, the one-
transaction write, and the persisted-signature map.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from .collectors import MacmonCollector

log = logging.getLogger("omlx_uplift.collector")

TICK_S = 5.0


class Collector:
    def __init__(self, store=None, tick_s: float = TICK_S):
        self._store = store
        self._tick = tick_s
        self._task: Optional[asyncio.Task] = None
        self._prev: dict[str, float] = {}
        self._purged_day = 0
        # id -> last-persisted change signature (RL-0: persist only on change)
        self._persisted: dict[str, tuple] = {}
        # U19: previous tick's lifetime cache counters (rates = deltas)
        self._prev_ctr: dict[str, float] = {}
        # U20: macmon (optional); state lives with the family collector.
        self._macmon_collector = MacmonCollector()

    @property
    def store(self):
        if self._store is None:
            from .store import get_store

            self._store = get_store()
        return self._store

    # -- macmon test seams: test_collector_sources drives the reader via
    # these names (fake procs, sample counters); they delegate to the
    # MacmonCollector state so the family owns it without breaking the
    # existing tests (unchanged = the BE-2 acceptance criterion).
    @property
    def _macmon(self):
        return self._macmon_collector._proc

    @_macmon.setter
    def _macmon(self, v):
        self._macmon_collector._proc = v

    @property
    def _macmon_buf(self):
        return self._macmon_collector._buf

    @_macmon_buf.setter
    def _macmon_buf(self, v):
        self._macmon_collector._buf = v

    @property
    def _macmon_samples(self):
        return self._macmon_collector._samples

    @_macmon_samples.setter
    def _macmon_samples(self, v):
        self._macmon_collector._samples = v

    @property
    def _macmon_seen_fan(self):
        return self._macmon_collector._seen_fan

    @_macmon_seen_fan.setter
    def _macmon_seen_fan(self, v):
        self._macmon_collector._seen_fan = v

    @property
    def _macmon_retries(self):
        return self._macmon_collector._retries

    @_macmon_retries.setter
    def _macmon_retries(self, v):
        self._macmon_collector._retries = v

    def _macmon_collect(self, pairs: dict[str, float]) -> None:
        self._macmon_collector.collect(pairs)

    # -- one tick ----------------------------------------------------------

    def sample_once(self):
        from . import collectors

        now = time.time()
        pairs: dict[str, float] = {}

        from omlx.server_metrics import get_server_metrics

        snap = get_server_metrics().get_snapshot()
        # dt from the PREVIOUS '_t' (original sample_once computed it once,
        # up front, and both rate families used it) — _prev is replaced
        # below, so capture it first.
        dt = now - (self._prev.get("_t", now))
        fam, self._prev = collectors.collect_totals_rates(
            snap, now=now, prev=self._prev)
        pairs.update(fam)

        try:
            from .router import engine_pool

            pool = engine_pool()
        except Exception:
            log.debug("engine pool probe failed", exc_info=True)
            pool = None

        if pool is not None:
            try:
                pairs.update(collectors.collect_engines(pool))
            except Exception:
                log.debug("engine active-requests collect failed", exc_info=True)
            try:
                pairs.update(collectors.collect_memory(pool))
            except Exception:
                log.debug("memory-limit metrics collect failed", exc_info=True)
            try:
                fam, self._prev_ctr = collectors.collect_cache(
                    pool, prev_ctr=self._prev_ctr, dt=dt)
                pairs.update(fam)
            except Exception:
                log.debug("prefix-cache collect failed", exc_info=True)

        # U20: macmon power/temperature (optional, non-blocking)
        try:
            self._macmon_collector.collect(pairs)
        except Exception:
            log.debug("macmon collect failed", exc_info=True)

        # U11: SYSTEM memory (continuous, unlike mem.used_bytes)
        try:
            pairs.update(collectors.collect_system_memory())
        except Exception:
            log.debug("system memory collect failed", exc_info=True)

        # Per-request lifecycle rows from the sampled tracker. RL-0 write
        # hygiene: only persist rows whose state/token counters actually
        # changed since the last persist — finished rows are written
        # exactly once, not re-upserted (COALESCE no-op writes still dirty
        # pages) on every tick. Everything rides ONE write_tick COMMIT.
        request_rows: list[dict] = []
        try:
            from .request_log import RING_LIMIT, get_request_tracker

            # PATHS-1 sibling rule: drain the WHOLE ring by its own
            # constant, not a copy of it — a RING_LIMIT bump here used to
            # silently cap persistence at the old size.
            for row in get_request_tracker().list_rows(limit=RING_LIMIT):
                sig = (row.get("state"), row.get("prompt_tokens"),
                       row.get("completion_tokens"), row.get("tps"),
                       row.get("error"))
                if self._persisted.get(row["id"]) == sig:
                    continue
                request_rows.append(row)
        except Exception:
            log.debug("request collect failed", exc_info=True)

        self.store.write_tick(pairs, request_rows, ts=now)
        for row in request_rows:
            self._persisted[row["id"]] = (row.get("state"),
                                          row.get("prompt_tokens"),
                                          row.get("completion_tokens"),
                                          row.get("tps"), row.get("error"))
        # Keep the signature map bounded (tracker ring is 200 + actives).
        if len(self._persisted) > 1000:
            for k in sorted(self._persisted, key=str)[:500]:
                self._persisted.pop(k, None)

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
