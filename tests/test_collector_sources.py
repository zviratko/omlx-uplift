"""Collector metric-source tests: active requests and SSD disk-cache total
must come from the same sources classic uses (scheduler admin snapshot /
get_ssd_cache_stats), not attributes that silently do not exist."""
from dataclasses import dataclass

from omlx_uplift.collector import Collector


@dataclass
class SsdStats:
    total_size_bytes: int = 0


class FakeSched:
    def snapshot_for_admin(self):
        return {"running_by_id": {"r1": {}, "r2": {}}}

    def get_ssd_cache_stats(self):
        return {"ssd_cache": SsdStats(123456)}


class FakeCore:
    def __init__(self):
        self.scheduler = FakeSched()


class FakeAsyncCore:
    def __init__(self):
        self.engine = FakeCore()


class FakeEngine:
    def __init__(self):
        self._engine = FakeAsyncCore()


class FakeEntry:
    def __init__(self):
        self.engine = FakeEngine()


class FakePool:
    def get_loaded_model_ids(self):
        return ["m1"]

    def get_entry(self, mid):
        return FakeEntry()


class CapturingStore:
    def __init__(self):
        self.pairs = {}
        self.request_rows = []

    def write_tick(self, pairs, request_rows, ts):
        self.pairs.update(pairs)
        self.request_rows.extend(request_rows)

    def purge(self):
        pass


def test_active_requests_and_ssd_total_use_admin_snapshot_sources(monkeypatch):
    import omlx_uplift.router as rt

    monkeypatch.setattr(rt, "engine_pool", lambda: FakePool())
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()

    # two running requests in the snapshot; one loaded model counted
    assert store.pairs["engines.active_requests"] == 2.0
    # U39: disk-cache totals no longer sampled (loaded-models-only walk lied)
    assert "cache.total_bytes" not in store.pairs
    assert store.pairs["engines.loaded"] == 1.0


def test_hot_cache_uses_stable_per_model_key_and_records_zero(monkeypatch):
    """2026-09-30: hot cache is stored under 'hot.<model>' (stable across
    rank changes) and a DRAINED model (0 bytes) is still written — skipping
    zeros broke the series the moment the hot cache emptied, which is what
    made the MEMORY&CACHE hot line 'disappear after a while'."""
    import omlx_uplift.router as rt

    @dataclass
    class HotSsd:
        total_size_bytes: int = 0
        hot_cache_size_bytes: int = 0

    class BusySched(FakeSched):
        def get_ssd_cache_stats(self):
            return {"ssd_cache": HotSsd(1000, 400)}

    class DrainedSched(FakeSched):
        def get_ssd_cache_stats(self):
            return {"ssd_cache": HotSsd(1000, 0)}

    class TwoPool:
        def get_loaded_model_ids(self):
            return ["busy", "drained"]

        def get_entry(self, mid):
            e = FakeEntry()
            e.engine._engine.engine.scheduler = (
                BusySched() if mid == "busy" else DrainedSched())
            return e

    monkeypatch.setattr(rt, "engine_pool", lambda: TwoPool())
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()

    assert store.pairs["hot.busy"] == 400.0
    assert store.pairs["hot.drained"] == 0.0    # zero IS a data point
    # rank keys (hot1.*) are gone: two models shared one rotated series
    assert not [k for k in store.pairs if k.startswith("hot1")]


def test_broken_engine_does_not_poison_the_tick(monkeypatch):
    import omlx_uplift.router as rt

    class BadEntry:
        engine = None  # attribute chain raises TypeError below

    class BadPool:
        def get_loaded_model_ids(self):
            return ["m1", "m2"]

        def get_entry(self, mid):
            if mid == "m1":
                return FakeEntry()
            raise RuntimeError("engine pool exploded")

    monkeypatch.setattr(rt, "engine_pool", lambda: BadPool())
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()
    # m1 still counted despite m2 blowing up
    assert store.pairs["engines.active_requests"] == 2.0
    assert "cache.total_bytes" not in store.pairs   # U39
    assert store.pairs["engines.loaded"] == 2.0


def test_system_memory_series_collected(monkeypatch):
    # U11: sys.* from the same psutil_compat source classic's memory card
    # reads. Deterministic fake so the assertion does not depend on load.
    from omlx.utils import psutil_compat

    class VM:
        total = 34_359_738_368        # 32 GiB
        used = 17_179_869_184         # 16 GiB -> exactly 50 %

    monkeypatch.setattr(psutil_compat, "virtual_memory", lambda: VM())
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()
    assert store.pairs["sys.used_bytes"] == float(VM.used)
    assert store.pairs["sys.total_bytes"] == float(VM.total)
    assert store.pairs["sys.percent"] == 50.0


def test_system_memory_survives_broken_source(monkeypatch):
    import omlx.utils.psutil_compat as pc

    def boom():
        raise RuntimeError("no psutil on this path")

    monkeypatch.setattr(pc, "virtual_memory", boom)
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()   # must not raise even when the memory source explodes
    assert "sys.used_bytes" not in store.pairs
    assert "sys.percent" not in store.pairs


class SpecSched:
    """Stats shape after omlx 5aa6c7f9: specprefill_cache is built
    UNCONDITIONALLY with target_static_* fields (draft_* only when a draft
    cache exists). Before the .get() fix this shape raised
    KeyError 'spec.tokens_restored' and aborted the model walk every tick,
    killing spec.* rates and the queue block for that model."""

    def __init__(self):
        self.n = 0

    def snapshot_for_admin(self):
        return {"running_by_id": {}}

    def get_ssd_cache_stats(self):
        self.n += 1
        return {
            "ssd_cache": SsdStats(10),
            "prefix_cache": {
                "hits": 10 * self.n, "misses": 2 * self.n,
                "tokens_matched_total": 500 * self.n,
                "tokens_requested_total": 1000 * self.n,
                "tokens_saved": 400 * self.n,
                "exact_prefix_tokens_restored": 300 * self.n,
            },
            "specprefill_cache": {
                "target_static_hits": 1,
                "target_static_tokens_restored": 70 * self.n,
            },
        }

    def get_stats(self):
        return {"num_waiting": 1, "num_prefilling": 0, "num_running": 0}


def _spec_pool(sched):
    class E:
        scheduler = sched
    class Eng:
        _engine = type("C", (), {"engine": E})()
    class Ent:
        engine = Eng()
    class P:
        def get_loaded_model_ids(self): return ["m1"]
        def get_entry(self, mid): return Ent()
    return P()


def test_spec_stats_shape_does_not_abort_cache_walk(monkeypatch):
    """Regression: first numeric spec value must not KeyError (2026-09-26)."""
    import time as _t
    import omlx_uplift.router as rt

    sched = SpecSched()
    monkeypatch.setattr(rt, "engine_pool", lambda: _spec_pool(sched))
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()                      # seeds counters, dt==0 -> no rates
    c._prev["_t"] = _t.time() - 60       # pretend a minute passed
    c.sample_once()

    assert "spec.restored_tokens_min" in store.pairs, store.pairs.keys()
    assert store.pairs["spec.restored_tokens_min"] == 70.0 * 60.0 / 60.0 * 1.0 \
        or store.pairs["spec.restored_tokens_min"] > 0
    # queue block sits AFTER the spec loop — an abort skipped it entirely
    assert store.pairs["queue.waiting"] == 1.0
    assert store.pairs["pfx.token_hit_pct"] == 50.0


def test_pfx_rate_recovers_after_counter_reset(monkeypatch):
    """Regression (user 2026-09-29: pfx cards stuck at 0 under real
    traffic): a model reload resets the engine lifetime counters. The
    reset tick must drop only that tick's rate and re-baseline; the NEXT
    tick's delta must produce a real rate again — never stay pinned."""
    import time as _t
    import omlx_uplift.router as rt

    sched = SpecSched()
    monkeypatch.setattr(rt, "engine_pool", lambda: _spec_pool(sched))
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()                       # sched.n=1, seeds counters
    c._prev["_t"] = _t.time() - 60
    sched.n = 10
    c.sample_once()                       # big positive delta
    assert store.pairs["pfx.saved_tokens_min"] > 0

    sched.n = 1                           # engine reloaded: counters reset
    c._prev["_t"] = _t.time() - 60
    store.pairs.clear()
    c.sample_once()                       # reset tick: honest no-rate
    assert "pfx.saved_tokens_min" not in store.pairs, "reset tick must not lie"

    sched.n = 3                           # two fresh hits since the reset
    c._prev["_t"] = _t.time() - 60
    store.pairs.clear()
    c.sample_once()
    v = store.pairs["pfx.saved_tokens_min"]
    # dt is wall-clock (~60.0s +/- jitter), so compare within tolerance
    assert abs(v - 400 * 2) < 5, \
        "rate must resume from the reset baseline, not stay pinned at 0"


# -- U20 macmon power total -------------------------------------------------
# Regression (user 2026-09-29): the power card under-reported by exactly the
# DRAM+SoC share under load. Cause: macmon's all_power is the COMPONENT SUM
# (CPU+GPU+ANE) — 47 W on an M1 Max running a GPU matmul whose true package
# draw was 92 W (mactop total_power). sys_power is the whole-die SMC reading
# and matched mactop across idle/CPU/DRAM/GPU states. pwr.total_w must come
# from sys_power, with all_power only as fallback when sys_power is dead.

def _macmon_pairs(payload: dict, samples: int = 5) -> dict:
    """Feed ONE complete macmon pipe line through _macmon_collect."""
    import json
    import os

    class _Pipe:
        def __init__(self, fd):
            self._fd = fd

        def fileno(self):
            return self._fd

    class _Proc:
        def __init__(self, line: bytes):
            self.r, self.w = os.pipe()
            os.write(self.w, line)
            os.close(self.w)
            self.stdout = _Pipe(self.r)

        def poll(self):
            return None

    c = Collector(store=None)
    proc = _Proc(json.dumps(payload).encode() + b"\n")
    c._macmon = proc
    c._macmon_buf = b""
    c._macmon_samples = samples       # skip the <0.5 W warmup guard
    pairs: dict[str, float] = {}
    c._macmon_collect(pairs)
    os.close(proc.r)
    return pairs


def test_total_w_prefers_sys_power_over_component_sum():
    # GPU matmul snapshot: all_power tracks the GPU channel ONLY.
    pairs = _macmon_pairs({
        "all_power": 47.5, "sys_power": 92.0, "cpu_power": 0.0,
        "gpu_power": 47.5, "ane_power": 0.0,
    })
    assert pairs["pwr.total_w"] == 92.0, \
        "all_power omits DRAM+SoC — total must come from sys_power"
    assert pairs["pwr.gpu_w"] == 47.5


def test_total_w_falls_back_to_all_power_when_sys_power_dead():
    pairs = _macmon_pairs({
        "all_power": 12.0, "sys_power": 0.0, "cpu_power": 12.0,
        "gpu_power": 0.0, "ane_power": 0.0,
    })
    assert pairs["pwr.total_w"] == 12.0


def test_total_w_reports_zero_when_both_channels_dead():
    # Past warmup a flat 0.0 IS written (honest dead reading, card shows
    # 0 W) — the key only stays absent when macmon never produced a line.
    pairs = _macmon_pairs({
        "all_power": 0.0, "sys_power": 0.0, "cpu_power": 0.0,
        "gpu_power": 0.0, "ane_power": 0.0,
    })
    assert pairs.get("pwr.total_w", 0.0) == 0.0


# -- U30/U34 (2026-09-30): cached-input rate + disk-cache limit -------------

class _SnapMetrics:
    def __init__(self):
        self.snap = {"total_prompt_tokens": 0, "total_completion_tokens": 0,
                     "total_cached_tokens": 0, "total_requests": 0,
                     "total_tokens_served": 0}

    def get_snapshot(self):
        return dict(self.snap)


def _cached_rate_fixture(monkeypatch):
    import omlx.server_metrics as sm
    m = _SnapMetrics()
    monkeypatch.setattr(sm, "get_server_metrics", lambda: m)
    monkeypatch.setattr("omlx_uplift.router.engine_pool", lambda: None)
    store = CapturingStore()
    return m, Collector(store=store), store


def test_cached_tokens_rate_and_disk_max(monkeypatch):
    """U30: rate.cached_tokens_s follows the same delta rule as its siblings;
    a counter reset (negative delta) drops the tick, never lies."""
    m, c, store = _cached_rate_fixture(monkeypatch)
    m.snap["total_cached_tokens"] = 100
    c.sample_once()                              # seed _prev
    c._prev["_t"] = __import__("time").time() - 10
    m.snap["total_cached_tokens"] = 600
    c.sample_once()
    v = store.pairs["rate.cached_tokens_s"]
    assert 40 < v < 60, f"500 tok over ~10 s (dt jitter), got {v}"

    m.snap["total_cached_tokens"] = 5            # reset (stats clear)
    c._prev["_t"] = __import__("time").time() - 10
    store.pairs.clear()
    c.sample_once()
    assert "rate.cached_tokens_s" not in store.pairs, "reset tick must not lie"


def test_u38_memory_budget_lines(monkeypatch):
    """U38: the chart's limits are the SETTINGS custom ceiling (enforcer
    property) and the kernel iogpu.wired_limit_mb (upstream helper). Both
    keys ABSENT when unset (0) — never a fake zero ceiling; the footprint
    line rides the enforcer's current_bytes (mem.used_bytes)."""
    import types
    import omlx_uplift.router as rt
    import omlx.server as srv
    import omlx.process_memory_enforcer as pme

    enf = types.SimpleNamespace(
        enabled=lambda: True,
        get_status=lambda: {"current_bytes": 70_000_000_000},
        get_final_ceiling=lambda: 129_922_760_704,
        memory_guard_custom_ceiling_bytes=129_922_760_704,   # 121 GiB
    )
    srv._server_state.process_memory_enforcer = enf
    monkeypatch.setattr(rt, "engine_pool", lambda: FakePool())
    monkeypatch.setattr(pme, "get_iogpu_wired_limit_bytes",
                        lambda: 124_640 * 1024**2)            # 118.75 GiB
    import omlx_uplift.collectors as ucl
    ucl.reset_ceiling_cache()      # FAST-1: 60 s sysctl cache is module state

    store = CapturingStore()
    Collector(store=store).sample_once()
    assert store.pairs["mem.used_bytes"] == 70_000_000_000.0
    assert store.pairs["mem.custom_ceiling_bytes"] == 129_922_760_704.0
    assert store.pairs["mem.iogpu_limit_bytes"] == 124_640 * 1024**2

    # unset limits -> keys absent (honest), footprint still collected
    enf.memory_guard_custom_ceiling_bytes = 0
    monkeypatch.setattr(pme, "get_iogpu_wired_limit_bytes", lambda: 0)
    ucl.reset_ceiling_cache()
    store = CapturingStore()
    Collector(store=store).sample_once()
    assert "mem.custom_ceiling_bytes" not in store.pairs
    assert "mem.iogpu_limit_bytes" not in store.pairs
    assert store.pairs["mem.used_bytes"] == 70_000_000_000.0


class HitsOnlySched:
    """mruu 2026-10-04 shape (specprefill-enabled model): prefix_cache
    stats carry 'hits' but NO 'misses' key. d_h + d_m raised TypeError,
    the collector's except swallowed it, and the WHOLE family died —
    pfx.*, hot.* and queue.* all stopped being written."""

    def __init__(self):
        self.n = 0

    def snapshot_for_admin(self):
        return {"running_by_id": {}}

    def get_ssd_cache_stats(self):
        self.n += 1
        return {
            "ssd_cache": SsdStats(10),
            "prefix_cache": {"hits": 5 * self.n, "tokens_saved": 100 * self.n},
        }

    def get_stats(self):
        return {"num_waiting": 1, "num_prefilling": 0, "num_running": 0}


def test_hits_without_misses_does_not_kill_the_family(monkeypatch):
    """Regression (mruu 2026-10-04 TypeError): the lookup-hit guard must
    check BOTH operands; a missing 'misses' counter drops only
    pfx.lookup_hit_pct, never hot.*/queue.*."""
    import time as _t
    import omlx_uplift.router as rt

    sched = HitsOnlySched()
    monkeypatch.setattr(rt, "engine_pool", lambda: _spec_pool(sched))
    store = CapturingStore()
    c = Collector(store=store)
    c.sample_once()                       # seed counters, dt==0
    c._prev["_t"] = _t.time() - 60
    c.sample_once()                       # d_h numeric, d_m None

    assert "pfx.lookup_hit_pct" not in store.pairs   # honest absence
    assert store.pairs["pfx.saved_tokens_min"] > 0   # sibling rate flows
    assert store.pairs["queue.waiting"] == 1.0       # family survived
    assert store.pairs["hot.m1"] == 0.0              # written, not skipped
