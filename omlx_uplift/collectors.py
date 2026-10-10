"""BE-2: the metric-family collectors split out of collector.sample_once.

Each family is a (mostly) pure function: pool/snapshot/state in, metric
dict out — no persistence, no cross-family reads. Collector keeps the tick
loop, the previous-tick state (prev totals, lifetime counters, persisted
signatures) and the single write_tick transaction.

Honesty rules baked into these families are load-bearing and carry their
dates: negative delta = counter reset -> drop the rate for that tick;
drained models still record 0 (skipping zeros broke series); phantom zero
fans never persist before the first real rpm.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional

from .corewalk import scheduler_for

log = logging.getLogger("omlx_uplift.collectors")

# --------------------------------------------------------------------------
# totals + derived rates
# --------------------------------------------------------------------------

_TOTAL_KEYS = (
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_cached_tokens",
    "total_requests",
    "total_tokens_served",
)
_PASSTHROUGH_KEYS = ("cache_efficiency", "avg_prefill_tps", "avg_generation_tps")


def collect_totals_rates(snap: dict, *, now: float,
                         prev: dict) -> tuple[dict, dict]:
    """ServerMetrics totals + same-process deltas -> rate.* metrics.

    prev is the previous tick's pairs plus '_t' timestamp (Collector owns
    it); returns (pairs, prev_out) where prev_out feeds the next tick.
    Exact counts give honest rates; negative delta = counter reset (model
    reload) -> drop that tick's rate rather than draw a cliff (U30 rule,
    shared by all rate families)."""
    pairs: dict[str, float] = {}
    for key in _TOTAL_KEYS:
        v = snap.get(key)
        if isinstance(v, (int, float)):
            pairs["tot." + key] = float(v)
    for key in _PASSTHROUGH_KEYS:
        v = snap.get(key)
        if isinstance(v, (int, float)):
            pairs[key] = float(v)

    dt = now - prev.get("_t", now)
    if dt > 0 and "_t" in prev:
        d_prompt = pairs.get("tot.total_prompt_tokens", 0) - prev.get(
            "tot.total_prompt_tokens", 0)
        d_comp = pairs.get("tot.total_completion_tokens", 0) - prev.get(
            "tot.total_completion_tokens", 0)
        d_req = pairs.get("tot.total_requests", 0) - prev.get(
            "tot.total_requests", 0)
        d_cached = pairs.get("tot.total_cached_tokens", 0) - prev.get(
            "tot.total_cached_tokens", 0)
        if d_prompt >= 0:
            pairs["rate.prompt_tokens_s"] = d_prompt / dt
        if d_comp >= 0:
            pairs["rate.completion_tokens_s"] = d_comp / dt
        if d_req >= 0:
            pairs["rate.requests_s"] = d_req / dt
        # U30: cached-input rate for the Throughput chart's dotted
        # prefill-colour line. Same counter-reset handling as siblings.
        if d_cached >= 0:
            pairs["rate.cached_tokens_s"] = d_cached / dt
    return pairs, {**pairs, "_t": now}


# --------------------------------------------------------------------------
# engine pool state
# --------------------------------------------------------------------------


def collect_engines(pool: Any) -> dict:
    """engines.loaded + engines.active_requests. Active counts the
    scheduler's published admin snapshot (exactly what classic
    /admin/api/stats counts) plus engine-tracked non-scheduler activity
    (DFlash/non-streaming). num_requests_running does NOT exist — reading
    it silently pinned this metric at 0."""
    pairs: dict[str, float] = {}
    loaded = pool.get_loaded_model_ids()
    pairs["engines.loaded"] = float(len(loaded))
    active = 0
    for mid in loaded:
        try:
            entry = pool.get_entry(mid)
            eng = getattr(entry, "engine", None)
            if eng is None:
                continue
            sched = scheduler_for(entry)
            snap_fn = getattr(sched, "snapshot_for_admin", None)
            if callable(snap_fn):
                s = snap_fn() or {}
                active += len(s.get("running_by_id", {}))
            act_fn = getattr(eng, "get_activity_snapshot", None)
            if callable(act_fn):
                active += int((act_fn() or {}).get("active_requests", 0) or 0)
        except Exception:
            log.debug("engine active_requests probe failed", exc_info=True)
    pairs["engines.active_requests"] = float(active)
    return pairs


# --------------------------------------------------------------------------
# momentary generation (decode) rate
# --------------------------------------------------------------------------


def collect_generation(pool: Any, *, now: float,
                       channel: str = "tick") -> dict:
    """Feed the decode sampler from every loaded scheduler, drain one tick.

    ``Request.num_output_tokens`` is ``len(output_token_ids)`` — it grows
    every decode step, so the per-tick delta over the in-flight set is the
    CURRENT generation rate. avg_generation_tps stays collected next to it
    (the classic session average; small card + tile keep using it).

    The walk must not raise into the tick: pool absent or a per-model probe
    failure just means this tick credits fewer rows (the deltas are
    per-request cumulative, so the next good tick still lands the full
    count — total accuracy survives, one tick smooths). drain() is OUTSIDE
    the walk loop and always returns the key — zero is a data point, and a
    skipped write truncates the series exactly when the engine drains.
    """
    rows: list[tuple[str, Any]] = []
    if pool is not None:
        for mid in pool.get_loaded_model_ids():
            try:
                entry = pool.get_entry(mid)
                sched = scheduler_for(entry)
                snap_fn = getattr(sched, "snapshot_for_admin", None)
                if not callable(snap_fn):
                    continue
                running = (snap_fn() or {}).get("running_by_id") or {}
                for rid, req in running.items():
                    # model-qualified key: request ids are not guaranteed
                    # unique across engines — a shared row would credit one
                    # model's tokens against another's delta.
                    rows.append((f"{mid}\x00{rid}",
                                 getattr(req, "num_output_tokens", None)))
            except Exception:
                log.debug("decode row walk failed for %s", mid,
                          exc_info=True)
    from .decode_sampler import get_decode_sampler
    sampler = get_decode_sampler()
    sampler.sample_running(rows, now=now)
    # FAST-1: the drain is per-channel — the 2 Hz display sampler and the
    # 5 s persisting Collector each read their own baseline of the same
    # monotonic credit total (see decode_sampler.drain).
    return sampler.drain(now=now, channel=channel)


# --------------------------------------------------------------------------
# MTP acceptance counters (native Lightning MTP speculation)
# --------------------------------------------------------------------------


def mtp_live_states(pool: Any) -> list[Any]:
    """Walk every loaded scheduler for live _MtpStats objects.

    A layout change upstream (batch generator moved, attribute renamed)
    makes the walk find nothing — the sampler then sees only zeros, never
    a raised tick. Shared by the 5 s tick and the 2 Hz fast sampler (the
    walk is pure attribute reads; the sampler dedupes states by id)."""
    states: list[Any] = []
    if pool is None:
        return states
    for mid in pool.get_loaded_model_ids():
        try:
            sched = scheduler_for(pool.get_entry(mid))
            gen = getattr(sched, "batch_generator", None)
            batch = getattr(gen, "_generation_batch", None)
            if batch is None:
                continue
            singleton = getattr(batch, "_omlx_mtp_state", None)
            if singleton is not None:
                st = getattr(singleton, "stats", None)
                if st is not None:
                    states.append(st)
            batched = getattr(batch, "_omlx_mtp_batch_state", None)
            for ms in (getattr(batched, "states", None) or {}).values():
                st = getattr(ms, "stats", None)
                if st is not None:
                    states.append(st)
        except Exception:
            log.debug("mtp state walk failed for %s", mid, exc_info=True)
    return states


def collect_mtp(pool: Any, *, now: float) -> dict:
    """Feed the sampler one tick's live MTP states, then drain the
    persisting ('tick') window of mtp.* pairs.

    The states hang off the scheduler's BatchGenerator generation batch
    (see mtp_sampler module docstring for the shape and the crediting
    rules). Zero MTP work is a data point, not an absence: the drain
    always writes the full key set."""
    from .mtp_sampler import get_mtp_sampler
    sampler = get_mtp_sampler()
    sampler.sample_states(mtp_live_states(pool), now=now)
    return sampler.drain(now=now, channel="tick")


def collect_mtp_fast(pool: Any, *, now: float) -> dict:
    """Fast-channel (2 Hz) MTP drain: the same state walk, but the drain
    only divides the rate keys by the fast dt on their own baseline.
    Windowed percent/ratio keys stay with the persisting tick (they must
    not swap the shared accumulator). Feeds mtp.accepted_tokens_s into
    the display ring so the Throughput stack's MTP edge moves at 2 Hz."""
    from .mtp_sampler import get_mtp_sampler
    sampler = get_mtp_sampler()
    sampler.sample_states(mtp_live_states(pool), now=now)
    return sampler.drain(now=now, channel="fast")


# --------------------------------------------------------------------------
# memory gauges
# --------------------------------------------------------------------------


# FAST-1 (user 2026-10-06): the iogpu wired limit is a KERNEL CONSTANT —
# `sysctl iogpu.wired_limit_mb` only moves when an admin rewrites it. Its
# reader FORKS /usr/sbin/sysctl (measured 7.4 ms median per call), so
# sampling it every tick was pure waste, and a fast sampler would turn it
# into 14 forks/second. Cache it; re-probe once a minute 'for good
# measure' (user's words), zero-probes never cached (unset sysctl can gain
# a value later and must become visible).
CEILING_CACHE_S = 60.0
_iogpu_cache: tuple[float, int] = (0.0, 0)


def reset_ceiling_cache() -> None:
    """Test seam: drop the cached iogpu reading (unit tests monkeypatch
    the sysctl helper and must see each fake value, not the cached one)."""
    global _iogpu_cache
    _iogpu_cache = (0.0, 0)


def collect_iogpu_limit_bytes(*, force: bool = False) -> int:
    global _iogpu_cache
    now = time.time()
    val, at = _iogpu_cache
    if not force and val > 0 and now - at < CEILING_CACHE_S:
        return val
    try:
        from omlx.process_memory_enforcer import get_iogpu_wired_limit_bytes
        wired = int(get_iogpu_wired_limit_bytes() or 0)
    except Exception:
        log.debug("iogpu wired limit probe failed", exc_info=True)
        return 0
    if wired > 0:
        _iogpu_cache = (wired, now)
    return wired


def collect_memory_used(pool: Any) -> dict:
    """FAST-1 fast-path slice of collect_memory: the two values that
    actually MOVE (used + percent). No sysctl fork, no settings reads —
    same sources, same accounting as the 5 s path."""
    pairs: dict[str, float] = {}
    from omlx.server import _server_state

    enf = getattr(_server_state, "process_memory_enforcer", None)
    if enf is not None and getattr(enf, "enabled", lambda: False)():
        try:
            used = int(enf.get_status().get("current_bytes", 0))
            maxb = int(enf.get_final_ceiling())
        except Exception:
            used, maxb = 0, 0     # pre-FAST-1 behavior kept: write 0, do
                                  # NOT drop the key (skipping zeros
                                  # truncates the series mid-probe-failure)
    else:
        used = int(getattr(pool, "current_model_memory", 0) or 0)
        cb = getattr(pool, "_get_final_ceiling", None)
        maxb = int(cb()) if callable(cb) else 0
    pairs["mem.used_bytes"] = float(used)
    if maxb > 0:
        pairs["mem.percent"] = 100.0 * used / maxb
    return pairs


def collect_memory(pool: Any) -> dict:
    """mem.used_bytes / mem.percent / mem.custom_ceiling_bytes /
    mem.iogpu_limit_bytes — same sources classic's /admin/api/stats uses
    (U38: absolute ceilings read from the enforcer/upstream helpers, never
    re-derived; 0 = unset -> key absent, no fake zero ceiling).
    FAST-1: the sysctl-forking iogpu probe now rides a 60 s cache."""
    pairs = collect_memory_used(pool)
    from omlx.server import _server_state

    enf = getattr(_server_state, "process_memory_enforcer", None)
    try:
        ceil_b = int(getattr(enf, "memory_guard_custom_ceiling_bytes", 0) or 0) \
            if enf is not None else 0
        if ceil_b > 0:
            pairs["mem.custom_ceiling_bytes"] = float(ceil_b)
    except Exception:
        log.debug("memory enforcer ceiling probe failed", exc_info=True)
    wired = collect_iogpu_limit_bytes()
    if wired > 0:
        pairs["mem.iogpu_limit_bytes"] = float(wired)
    return pairs


# --------------------------------------------------------------------------
# cache + prefix/spec counters + queue gauges (one scheduler walk)
# --------------------------------------------------------------------------

_PFX_MAP = (
    ("hits", "pfx.hits"),
    ("misses", "pfx.misses"),
    ("tokens_matched_total", "pfx.tokens_matched"),
    ("tokens_requested_total", "pfx.tokens_requested"),
    ("tokens_saved", "pfx.tokens_saved"),
    ("exact_prefix_tokens_restored", "pfx.tokens_restored"),
)
_SPEC_MAP = (
    ("target_static_tokens_restored", "spec.tokens_restored"),
    ("draft_prefix_tokens_saved", "spec.tokens_saved"),
)

# BUG-3 (user log evidence 2026-10-06): the prefix_cache-absent notice below
# was STATE-gated, so it re-fired on every 5 s persisting tick while models
# sat loaded-but-idle — 98k lines after one restart. Absence in that window
# is expected (the engine fills the counters only once real requests flow).
# Edge trigger: one line per ABSENCE EPISODE; the flag is set when the
# notice fires and cleared as soon as any tick sees the counters again, so
# a genuine later regression still produces exactly one fresh line.
# Module-level on purpose: a process restart legitimately starts a new
# episode; the bool read/write is GIL-atomic across the collector loop and
# the 2 Hz fast-sampler thread (worst case: one extra line, never spam).
_pfx_absent_logged = False


def collect_cache(pool: Any, *, prev_ctr: dict, dt: float,
                  rates: bool = True) -> tuple[dict, dict]:
    """hot.<model>, queue.*, pfx.*/spec.* rates — one walk of the loaded
    models. Returns (pairs, prev_ctr_out).

    U39: disk-cache TOTALS dropped — walking only loaded models showed 56 GB
    against 500+ GB on disk (user 2026-09-30: 'a lie').
    Stable per-model keys 'hot.<model>' — old rank keys rotated and two
    models shared one series (2026-09-30).
    Zeros ARE data points: skipping drained models made the hot line
    'disappear after a while'.
    .get() not [k] += everywhere: an unseeded key KeyError was swallowed by
    the per-model except and killed every pfx.* series silently
    (2026-09-26)."""
    pairs: dict[str, float] = {}
    from dataclasses import asdict, is_dataclass

    hot: dict[str, int] = {}
    pfx_counters: dict[str, float] = {}
    queue_sum = {"waiting": 0.0, "prefilling": 0.0, "running": 0.0}
    saw_prefix_cache = False
    for mid in pool.get_loaded_model_ids():
        try:
            entry = pool.get_entry(mid)
            eng = getattr(entry, "engine", None)
            sched = scheduler_for(entry)
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
                    log.debug("ssd-cache settings shape failed", exc_info=True)
            # hot_cache_size_bytes lives INSIDE the ssd stats dict
            # (PagedSSDCacheStats), not at the top of get_ssd_cache_stats()
            # — reading st made every hot* series permanently 0 (2026-09-26).
            hb = int(ssd.get("hot_cache_size_bytes", 0) or 0)
            hot[mid] = hb
            # U19: prefix/specprefill counters ride the SAME call; lifetime
            # counters sum across loaded models, rates derive from deltas.
            pfx = st.get("prefix_cache") or {}
            if pfx:
                saw_prefix_cache = True
            for src, key in _PFX_MAP:
                v = pfx.get(src)
                if isinstance(v, (int, float)):
                    pfx_counters[key] = pfx_counters.get(key, 0.0) + float(v)
            spec = st.get("specprefill_cache") or {}
            for src, key in _SPEC_MAP:
                v = spec.get(src)
                if isinstance(v, (int, float)):
                    # omlx 5aa6c7f9 made specprefill_cache stats
                    # unconditional; the first numeric spec value hit an
                    # unseeded [k] += and aborted the model walk every tick.
                    pfx_counters[key] = pfx_counters.get(key, 0.0) + float(v)
            # U19 queue split — scheduler gauge, summed per model.
            gs_fn = getattr(sched, "get_stats", None)
            if callable(gs_fn):
                try:
                    gs = gs_fn() or {}
                    queue_sum["waiting"] += float(gs.get("num_waiting", 0) or 0)
                    queue_sum["prefilling"] += float(
                        gs.get("num_prefilling", 0) or 0)
                    queue_sum["running"] += float(gs.get("num_running", 0) or 0)
                except Exception:
                    log.debug("queue-sum engine snapshot failed", exc_info=True)
        except Exception:
            # A broken walker here once silently killed every pfx.* series
            # (KeyError, 2026-09-26) — keep it loud at debug, not silent.
            log.debug("cache-stats walk failed for %s", mid, exc_info=True)
    for mid, hb in hot.items():
        pairs["hot." + mid] = float(hb)
    if pool.get_loaded_model_ids():
        pairs["queue.waiting"] = queue_sum["waiting"]
        pairs["queue.prefilling"] = queue_sum["prefilling"]
        pairs["queue.running"] = queue_sum["running"]
    # U19 cache savings rates — per-tick deltas of lifetime counters
    # (lifetime ratios are static-ish and useless as time series).
    # FAST-1: the 2 Hz walk passes rates=False — pfx/spec rates come from
    # the SAME lifetime counters the 5 s tick diffs (9 of 10 fast readings
    # would be identical zeros), and its prev_ctr state stays owned by the
    # persisting tick. The fast sampler only takes hot.*/queue.* gauges.
    if rates and dt > 0 and pfx_counters and prev_ctr:
        def _d(key):
            cur = pfx_counters.get(key)
            old = prev_ctr.get(key)
            if cur is None or old is None or cur < old:
                # negative delta = counter reset (model reload): drop THIS
                # tick's rate; the baseline update re-arms from the reset.
                return None
            return cur - old
        d_h, d_m = _d("pfx.hits"), _d("pfx.misses")
        d_mat, d_req = _d("pfx.tokens_matched"), _d("pfx.tokens_requested")
        d_saved = _d("pfx.tokens_saved")
        d_rest = _d("pfx.tokens_restored")
        # BOTH operands must exist: an engine whose prefix_cache stats
        # carry 'hits' but not 'misses' (mruu 2026-10-04: specprefill-
        # enabled model) made d_h + d_m raise TypeError, and the swallowed
        # exception killed the WHOLE family — hot.* and queue.* died with
        # it. Honest absence of lookup_hit_pct, everything else flows.
        if d_h is not None and d_m is not None and d_h + d_m > 0:
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
    prev_out = pfx_counters if pfx_counters else prev_ctr
    # BUG-3: edge-triggered absence notice — one line per episode, not per
    # tick. Only the persisting (rates) tick owns the state; the 2 Hz walk
    # stays stateless here.
    global _pfx_absent_logged
    if rates:
        if pfx_counters or saw_prefix_cache:
            _pfx_absent_logged = False   # counters (re)appeared: re-arm
        elif pool.get_loaded_model_ids() and not _pfx_absent_logged:
            # Engines stopped reporting prefix_cache counters (the pfx.* series
            # went quiet 2026-09-27 with only a reranker resident). Loaders
            # without a block-aware cache never emit them — say so at debug
            # instead of leaving the cards silently flat-lined. FAST-1: gated
            # on rates — the persisting tick owns this notice; the 2 Hz walk
            # would spam server.log every half second with the same line.
            log.debug("prefix_cache counters absent for %d loaded model(s); "
                      "pfx.*/spec.* series paused",
                      len(pool.get_loaded_model_ids()))
            _pfx_absent_logged = True
    return pairs, prev_out


# --------------------------------------------------------------------------
# system memory
# --------------------------------------------------------------------------


def collect_system_memory() -> dict:
    """U11: SYSTEM memory via the same psutil_compat source classic's
    memory card uses. Unlike mem.used_bytes (phys_footprint — flat between
    model load/unload) this moves continuously. total RAM is constant by
    definition, so only used/percent are collected."""
    pairs: dict[str, float] = {}
    from omlx.utils import psutil_compat

    vm = psutil_compat.virtual_memory()
    used = int(getattr(vm, "used", 0) or 0)
    total = int(getattr(vm, "total", 0) or 0)
    if used and total:
        pairs["sys.used_bytes"] = float(used)
        pairs["sys.total_bytes"] = float(total)
        pairs["sys.percent"] = 100.0 * used / total
    return pairs


# --------------------------------------------------------------------------
# macmon power/temperature (optional) — process state owner
# --------------------------------------------------------------------------


class MacmonCollector:
    """U20: `macmon pipe` subprocess reader. None = not probed yet,
    False = absent/dead for good, else a Popen. No macmon => NO pwr.*/
    therm.* keys ever written (silent absence, user addendum)."""

    _MACMON_MAX_RETRIES = 3

    def __init__(self):
        self._proc: object = None
        self._retries = 0
        self._seen_fan = False
        self._samples = 0
        self._buf = b""

    def collect(self, pairs: dict[str, float]) -> None:
        """Tail ONE supervised `macmon pipe` subprocess (never one spawn per
        tick). Non-blocking: drain to the newest line, parse, map. First
        sample reports 0.0 W (SMC delta window) — discarded, and any power
        < 0.5 W in the first two samples is the same warmup artifact."""
        import fcntl
        import os as _os
        import shutil
        import subprocess

        if self._proc is False:
            return
        if self._proc is None:
            if shutil.which("macmon") is None:
                self._proc = False        # silent absence, forever
                return
            try:
                self._proc = subprocess.Popen(
                    ["macmon", "pipe", "--interval", "1000"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, bufsize=1,
                )
                self._buf = b""
                # O_NONBLOCK on the pipe fd: a tick must never wait on macmon.
                fd = self._proc.stdout.fileno()
                fl = fcntl.fcntl(fd, fcntl.F_GETFL)
                fcntl.fcntl(fd, fcntl.F_SETFL, fl | _os.O_NONBLOCK)
            except Exception:
                self._proc = False
                return
        if self._proc is False:
            return
        proc = self._proc
        if proc.poll() is not None:
            # Subprocess died: bounded retries, then go quiet (no log spam).
            self._retries += 1
            self._proc = None if self._retries < self._MACMON_MAX_RETRIES else False
            return
        # Raw non-blocking drain + byte buffer: a text-mode readline on an
        # O_NONBLOCK fd can hand back a PARTIAL line and desync every later
        # sample (2026-09-26). Keep the trailing partial line for next tick.
        try:
            chunk = _os.read(proc.stdout.fileno(), 65536)
        except (BlockingIOError, OSError):
            return
        if not chunk:
            return
        buf = (self._buf + chunk) if self._buf else chunk
        lines = buf.split(b"\n")
        self._buf = lines.pop()             # trailing partial (no \n)
        line = None
        for ln in reversed(lines):          # newest complete line wins
            if ln.strip():
                line = ln
                break
        if not line:
            return
        try:
            d = json.loads(line)
        except Exception:
            return
        self._samples += 1
        warm = self._samples >= 2
        temp = d.get("temp") or {}

        def w(key):
            v = d.get(key)
            if isinstance(v, (int, float)) and (warm or v >= 0.5):
                return float(v)
            return None

        total = w("sys_power")
        if total is None or total <= 0:
            # sys_power is the whole-die SMC reading (CPU+GPU+ANE+DRAM+SoC) —
            # verified equal to mactop's total_power across idle/CPU/DRAM/GPU
            # load states (kocour 2026-09-29). all_power is the component sum
            # (CPU+GPU+ANE) and omits DRAM/system; on some builds it reads 0
            # or is absent. Use it only as a fallback so the card is never
            # dead, not as primary (was inverted pre-2026-09-29 — under-
            # reports by DRAM+SoC share under load).
            total = w("all_power")
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
        rpms = [f for f in fans
                if isinstance(f.get("rpm"), (int, float)) and f["rpm"] > 0]
        if rpms:
            self._seen_fan = True
            f0 = max(rpms, key=lambda f: f["rpm"])
            pairs["fan.max_rpm"] = float(f0["rpm"])
            pairs["fan.max_pct"] = 100.0 * f0["rpm"] / (f0.get("max_rpm") or 1)
        elif self._seen_fan:
            pairs["fan.max_rpm"] = 0.0

    def shutdown(self) -> None:
        """U20: never leave an orphaned macmon pipe behind (Collector.stop).
        """
        proc = self._proc
        if proc and proc is not False:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        self._proc = None
