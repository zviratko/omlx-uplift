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
        # id -> last-persisted change signature (RL-0: persist only on change)
        self._persisted: dict[str, tuple] = {}
        # U19: previous tick's lifetime cache counters (rates = deltas)
        self._prev_ctr: dict[str, float] = {}
        # U20: macmon (optional). None = not probed yet, False = absent/dead
        # for good, else a Popen of `macmon pipe`. No macmon => NO pwr.*/
        # therm.* keys ever written (silent absence, user addendum).
        self._macmon: object = None
        self._macmon_retries = 0
        self._macmon_seen_fan = False
        self._macmon_samples = 0
        self._macmon_buf = b""

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
        # U20: never leave an orphaned macmon pipe behind.
        proc = self._macmon
        if proc and proc is not False:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self._macmon = None

    async def _run(self):
        while True:
            try:
                await asyncio.to_thread(self.sample_once)
            except asyncio.CancelledError:
                raise
            except Exception:  # never die on a bad tick
                log.exception("collector tick failed")
            await asyncio.sleep(self._tick)

    # -- U20 macmon (optional wattage/temperature) -------------------------

    _MACMON_MAX_RETRIES = 3

    def _macmon_collect(self, pairs: dict[str, float]) -> None:
        """Tail ONE supervised `macmon pipe` subprocess (never one spawn per
        tick). Non-blocking: drain to the newest line, parse, map. First
        sample reports 0.0 W (SMC delta window) — discarded, and any power
        < 0.5 W in the first two samples is the same warmup artifact."""
        import fcntl
        import json
        import os
        import shutil
        import subprocess

        if self._macmon is False:
            return
        if self._macmon is None:
            if shutil.which("macmon") is None:
                self._macmon = False      # silent absence, forever
                return
            try:
                self._macmon = subprocess.Popen(
                    ["macmon", "pipe", "--interval", "1000"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, bufsize=1,
                )
                self._macmon_buf = b""
                # O_NONBLOCK on the pipe fd: a tick must never wait on macmon.
                fd = self._macmon.stdout.fileno()
                fl = fcntl.fcntl(fd, fcntl.F_GETFL)
                fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
            except Exception:
                self._macmon = False
                return
        proc = self._macmon
        if proc.poll() is not None:
            # Subprocess died: bounded retries, then go quiet (no log spam).
            self._macmon_retries += 1
            self._macmon = None if self._macmon_retries < self._MACMON_MAX_RETRIES else False
            return
        # Raw non-blocking drain + byte buffer: a text-mode readline on an
        # O_NONBLOCK fd can hand back a PARTIAL line and desync every later
        # sample (2026-09-26). Keep the trailing partial line for next tick.
        import os as _os
        try:
            chunk = _os.read(proc.stdout.fileno(), 65536)
        except (BlockingIOError, OSError):
            return
        if not chunk:
            return
        buf = (self._macmon_buf + chunk) if self._macmon_buf else chunk
        lines = buf.split(b"\n")
        self._macmon_buf = lines.pop()          # trailing partial (no \n)
        line = None
        for ln in reversed(lines):              # newest complete line wins
            if ln.strip():
                line = ln
                break
        if not line:
            return
        try:
            d = json.loads(line)
        except Exception:
            return
        self._macmon_samples += 1
        warm = self._macmon_samples >= 2
        temp = d.get("temp") or {}

        def w(key):
            v = d.get(key)
            if isinstance(v, (int, float)) and (warm or v >= 0.5):
                return float(v)
            return None

        total = w("all_power")
        if total is None or total <= 0:
            # macOS 27 beta + macmon: all_power reads a flat 0.0 while the
            # sys_power channel carries the real package draw (kocour
            # 2026-09-26). Fall back so the card/chip is honest, not dead.
            total = w("sys_power")
        if total is not None:
            pairs["pwr.total_w"] = total
        for src, key in (("cpu_power", "pwr.cpu_w"), ("gpu_power", "pwr.gpu_w"),
                         ("ane_power", "pwr.ane_w")):
            v = w(src)
            if v is not None:
                pairs[key] = v
        for src, key in (("cpu_temp_avg", "therm.cpu_temp_c"),
                         ("gpu_temp_avg", "therm.gpu_temp_c")):
            v = temp.get(src)
            if isinstance(v, (int, float)) and v > 0:
                pairs[key] = float(v)
        # Fans: MacBooks report phantom zero fans — only persist once any
        # rpm > 0 was ever seen (silent absence otherwise).
        fans = d.get("fans") or []
        rpms = [f for f in fans if isinstance(f.get("rpm"), (int, float)) and f["rpm"] > 0]
        if rpms:
            self._macmon_seen_fan = True
            f0 = max(rpms, key=lambda f: f["rpm"])
            pairs["fan.max_rpm"] = float(f0["rpm"])
            pairs["fan.max_pct"] = 100.0 * f0["rpm"] / (f0.get("max_rpm") or 1)
        elif self._macmon_seen_fan:
            pairs["fan.max_rpm"] = 0.0

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
                loaded = pool.get_loaded_model_ids()
                pairs["engines.loaded"] = float(len(loaded))
                # Active = running requests from the scheduler's published
                # admin snapshot (exactly what classic /admin/api/stats
                # counts), plus engine-tracked non-scheduler activity
                # (DFlash/non-streaming). num_requests_running does NOT
                # exist — reading it silently pinned this metric at 0.
                active = 0
                for mid in loaded:
                    try:
                        entry = pool.get_entry(mid)
                        eng = getattr(entry, "engine", None)
                        if eng is None:
                            continue
                        async_core = getattr(eng, "_engine", None)
                        core = getattr(async_core, "engine", None) if async_core else None
                        sched = getattr(core, "scheduler", None) if core else \
                            getattr(eng, "scheduler", None)
                        snap_fn = getattr(sched, "snapshot_for_admin", None)
                        if callable(snap_fn):
                            snap = snap_fn() or {}
                            active += len(snap.get("running_by_id", {}))
                        act_fn = getattr(eng, "get_activity_snapshot", None)
                        if callable(act_fn):
                            active += int((act_fn() or {}).get("active_requests", 0) or 0)
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
        # SSD disk-cache total + per-model hot cache. Classic aggregates
        # scheduler.get_ssd_cache_stats()["ssd_cache"].total_size_bytes per
        # loaded model (scoped via the manager when available); the engine
        # attribute get_runtime_cache_stats does not exist on regular
        # schedulers — that wrong source kept cache.total_bytes at 0.
        try:
            from dataclasses import asdict, is_dataclass

            pool = engine_pool()
            if pool is not None:
                total_bytes = 0
                hot: dict[str, int] = {}
                # U19 lifetime counters / queue gauges, summed per loaded model.
                pfx_counters: dict[str, float] = {}
                queue_sum = {"waiting": 0.0, "prefilling": 0.0, "running": 0.0}
                saw_prefix_cache = False
                for mid in pool.get_loaded_model_ids():
                    try:
                        entry = pool.get_entry(mid)
                        eng = getattr(entry, "engine", None)
                        async_core = getattr(eng, "_engine", None)
                        core = getattr(async_core, "engine", None) if async_core else None
                        sched = getattr(core, "scheduler", None) if core else \
                            getattr(eng, "scheduler", None)
                        if sched is None:
                            # DFlash primary: engine exposes the stats itself
                            sched = eng
                        fn = getattr(sched, "get_ssd_cache_stats", None)
                        if not callable(fn):
                            fn = getattr(eng, "get_runtime_cache_stats", None)
                        if not callable(fn):
                            continue
                        st = fn() or {}
                        ssd = st.get("ssd_cache", st)
                        if is_dataclass(ssd):
                            ssd = asdict(ssd)
                        elif hasattr(ssd, "to_dict"):
                            ssd = ssd.to_dict()
                        if not isinstance(ssd, dict):
                            ssd = {}
                        scoped = getattr(
                            getattr(sched, "paged_ssd_cache_manager", None),
                            "get_stats_for_model", None)
                        if callable(scoped):
                            try:
                                s = scoped(mid)
                                if is_dataclass(s):
                                    ssd = asdict(s)
                                elif isinstance(s, dict):
                                    ssd = s
                            except Exception:
                                pass
                        total_bytes += int(ssd.get("total_size_bytes", 0) or 0)
                        # hot_cache_size_bytes lives INSIDE the ssd stats
                        # dict (PagedSSDCacheStats), not at the top of
                        # get_ssd_cache_stats() — reading st made every
                        # hot* series permanently 0 (2026-09-26).
                        hb = int(ssd.get("hot_cache_size_bytes", 0) or 0)
                        if hb > 0:
                            hot[mid] = hb
                        # U19: prefix/specprefill counters ride the SAME
                        # call. Lifetime counters are summed across loaded
                        # models; per-interval rates are derived below from
                        # the deltas (same pattern as rate.prompt_tokens_s).
                        pfx = st.get("prefix_cache") or {}
                        if pfx:
                            saw_prefix_cache = True
                        for src, key in (
                            ("hits", "pfx.hits"),
                            ("misses", "pfx.misses"),
                            ("tokens_matched_total", "pfx.tokens_matched"),
                            ("tokens_requested_total", "pfx.tokens_requested"),
                            ("tokens_saved", "pfx.tokens_saved"),
                            ("exact_prefix_tokens_restored",
                             "pfx.tokens_restored"),
                        ):
                            v = pfx.get(src)
                            if isinstance(v, (int, float)):
                                # .get() not [k] += — KeyError here was
                                # swallowed by the per-model except and
                                # killed every pfx.* series silently.
                                pfx_counters[key] = pfx_counters.get(key, 0.0) + float(v)
                        spec = st.get("specprefill_cache") or {}
                        for src, key in (
                            ("target_static_tokens_restored",
                             "spec.tokens_restored"),
                            ("draft_prefix_tokens_saved",
                             "spec.tokens_saved"),
                        ):
                            v = spec.get(src)
                            if isinstance(v, (int, float)):
                                pfx_counters[key] += float(v)
                        # U19 queue split — scheduler gauge, summed per model.
                        gs_fn = getattr(sched, "get_stats", None)
                        if callable(gs_fn):
                            try:
                                gs = gs_fn() or {}
                                queue_sum["waiting"] += float(
                                    gs.get("num_waiting", 0) or 0)
                                queue_sum["prefilling"] += float(
                                    gs.get("num_prefilling", 0) or 0)
                                queue_sum["running"] += float(
                                    gs.get("num_running", 0) or 0)
                            except Exception:
                                pass
                    except Exception:
                        # A broken walker here once silently killed every
                        # pfx.* series (KeyError, 2026-09-26) — keep it loud
                        # at debug level, not silent.
                        log.debug("cache-stats walk failed for %s", mid, exc_info=True)
                pairs["cache.total_bytes"] = float(total_bytes)
                for rank, mid in enumerate(sorted(hot, key=lambda m: -hot[m])[:3]):
                    pairs["hot%d.%s" % (rank + 1, mid)] = float(hot[mid])
                # U19 queue gauges — summed scheduler depth across loaded
                # models (the "stuck or just slow" split). Emitted whenever
                # the loop ran on at least one engine.
                if pool.get_loaded_model_ids():
                    pairs["queue.waiting"] = queue_sum["waiting"]
                    pairs["queue.prefilling"] = queue_sum["prefilling"]
                    pairs["queue.running"] = queue_sum["running"]
                # U19 cache savings rates — per-tick deltas of lifetime
                # counters (lifetime ratios are static-ish and useless as
                # time series). Negative delta = counter reset (model
                # reload) -> drop that tick's rates, same honesty rule as
                # the tot.* rates above.
                prev_ctr = self._prev_ctr
                if dt > 0 and pfx_counters and prev_ctr:
                    def _d(key):
                        cur = pfx_counters.get(key)
                        old = prev_ctr.get(key)
                        if cur is None or old is None or cur < old:
                            return None
                        return cur - old
                    d_h, d_m = _d("pfx.hits"), _d("pfx.misses")
                    d_mat, d_req = _d("pfx.tokens_matched"), _d("pfx.tokens_requested")
                    d_saved = _d("pfx.tokens_saved")
                    d_rest = _d("pfx.tokens_restored")
                    if d_h is not None and d_h + d_m > 0:
                        pairs["pfx.lookup_hit_pct"] = 100.0 * d_h / (d_h + d_m)
                    if d_mat is not None and d_req and d_req > 0:
                        pairs["pfx.token_hit_pct"] = 100.0 * d_mat / d_req
                    if d_saved is not None:
                        pairs["pfx.saved_tokens_min"] = 60.0 * d_saved / dt
                    if d_rest is not None:
                        pairs["pfx.restored_tokens_min"] = 60.0 * d_rest / dt
                    d_sres = _d("spec.tokens_restored")
                    d_ssave = _d("spec.tokens_saved")
                    if d_sres is not None:
                        pairs["spec.restored_tokens_min"] = 60.0 * d_sres / dt
                    if d_ssave is not None:
                        pairs["spec.saved_tokens_min"] = 60.0 * d_ssave / dt
                if pfx_counters:
                    self._prev_ctr = pfx_counters
        except Exception:
            log.debug("prefix-cache collect failed", exc_info=True)

        # U20: macmon power/temperature (optional, non-blocking)
        try:
            self._macmon_collect(pairs)
        except Exception:
            log.debug("macmon collect failed", exc_info=True)

        # U11: SYSTEM memory via the same psutil_compat source classic's
        # memory card uses. Unlike mem.used_bytes (phys_footprint — flat
        # between model load/unload) this moves continuously, which is what
        # the user asked the Memory section to actually show. total RAM is
        # constant by definition, so only used/percent are collected.
        try:
            from omlx.utils import psutil_compat

            vm = psutil_compat.virtual_memory()
            used = int(getattr(vm, "used", 0) or 0)
            total = int(getattr(vm, "total", 0) or 0)
            if used and total:
                pairs["sys.used_bytes"] = float(used)
                pairs["sys.total_bytes"] = float(total)
                pairs["sys.percent"] = 100.0 * used / total
        except Exception:
            pass

        # Per-request lifecycle rows from the sampled tracker. RL-0 write
        # hygiene: only persist rows whose state/token counters actually
        # changed since the last persist — finished rows are written
        # exactly once, not re-upserted (COALESCE no-op writes still dirty
        # pages) on every tick. Everything rides ONE write_tick COMMIT.
        request_rows: list[dict] = []
        try:
            from .request_log import get_request_tracker

            for row in get_request_tracker().list_rows(limit=200):
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
