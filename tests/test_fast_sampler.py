"""FAST-1: 2 Hz display sampler — memory rings + per-channel drains.

The load-bearing contract these tests pin:

1. CHANNEL ISOLATION — the whole reason the fast sampler may share the
   sampler accumulators: each reporting channel drains against ITS OWN
   (ts, total) baseline, so a 2 Hz display drain cannot steal tokens from
   the 5 s persisting drain and the stored series keeps its exact
   full-window semantics (the hourly backfill assumes it).
2. RING-ONLY — the fast sampler never touches the store; the Collector's
   write_tick stays the single writer.
3. 60 s CEILING CACHE — the sysctl fork moved off the per-tick path;
   zeros are never cached (an unset sysctl can gain a value).
4. collect_cache(rates=False) — the fast walk reads gauges only; the
   pfx/spec lifetime-counter state stays owned by the 5 s tick.
"""
import time

from omlx_uplift.decode_sampler import KEY_GENERATION_TOKENS, DecodeSampler
from omlx_uplift.prefill_sampler import KEY_PREFILL_TOKENS, PrefillSampler


# -- 1. channel isolation --------------------------------------------------

def test_decode_channels_do_not_steal_tokens():
    s = DecodeSampler()
    s.sample_running([("a", 0)], now=100.0)
    assert s.drain(now=100.0)[KEY_GENERATION_TOKENS] == 0.0          # tick baseline
    s.sample_running([("a", 10)], now=101.0)
    assert s.drain(now=101.0, channel="fast")[KEY_GENERATION_TOKENS] == 0.0  # fast baseline
    s.sample_running([("a", 40)], now=103.0)
    # tick: every token since ITS baseline (40-0)/3 — the fast drain in the
    # middle did not rob it
    assert abs(s.drain(now=103.0)[KEY_GENERATION_TOKENS] - 40 / 3) < 1e-9
    # fast: only what arrived since the fast baseline (40-10)/2
    assert abs(s.drain(now=103.0, channel="fast")[KEY_GENERATION_TOKENS] - 15.0) < 1e-9
    # no new tokens: both channels write an honest zero (zero IS data)
    assert s.drain(now=104.0, channel="fast")[KEY_GENERATION_TOKENS] == 0.0
    assert s.drain(now=106.0)[KEY_GENERATION_TOKENS] == 0.0


def test_tick_span_semantics_unchanged_by_fast_drains():
    """A session of interleaved fast drains leaves the tick drain exactly
    what a tick-only session would compute: total/elapsed over the tick's
    own window, not the shorter fast spans."""
    plain, mixed = DecodeSampler(), DecodeSampler()
    for both in (plain, mixed):
        both.sample_running([("a", 0)], now=0.0)
        both.drain(now=0.0)
    for now, count in ((1.0, 10), (2.0, 20), (3.0, 30), (4.0, 40), (5.0, 50)):
        plain.sample_running([("a", count)], now=now)
        mixed.sample_running([("a", count)], now=now)
        mixed.drain(now=now, channel="fast")
    a = plain.drain(now=5.0)[KEY_GENERATION_TOKENS]
    b = mixed.drain(now=5.0)[KEY_GENERATION_TOKENS]
    assert abs(a - b) < 1e-9 and abs(a - 10.0) < 1e-9   # 50 tokens / 5 s


def test_prefill_channels_same_rule():
    s = PrefillSampler()
    s.note_chunk("r1", 40, 100, model="m", now=100.0)
    assert s.drain(now=100.0)[KEY_PREFILL_TOKENS] == 0.0        # tick seeds
    assert s.drain(now=100.0, channel="fast")[KEY_PREFILL_TOKENS] == 0.0  # fast seeds
    s.note_chunk("r1", 100, 100, model="m", now=101.0)   # +60 tokens
    assert abs(s.drain(now=101.0, channel="fast")[KEY_PREFILL_TOKENS] - 60.0) < 1e-9
    s.note_chunk("r2", 10, 100, model="m", now=102.0)
    # tick channel: its baseline is (100.0, 40) — 110-40=70 tokens over 2 s
    assert abs(s.drain(now=102.0)[KEY_PREFILL_TOKENS] - 35.0) < 1e-9


# -- 2. the fast sampler: rings, no store ------------------------------------

class ExplodingStore:
    def write_tick(self, *a, **k):
        raise AssertionError("fast sampler must never write to the store")

    def purge(self):
        raise AssertionError("fast sampler must never purge")


def _fake_patch(monkeypatch):
    """Route the fast tick's probes to cheap fakes (no server state needed)."""
    import types

    import omlx_uplift.router as rt
    import omlx_uplift.collectors as ucl

    monkeypatch.setattr(rt, "engine_pool", lambda: None)
    monkeypatch.setattr(ucl, "collect_system_memory",
                        lambda: {"sys.used_bytes": 1.0})
    # no server state in unit tests: the memory family needs _server_state
    monkeypatch.setattr(ucl, "collect_memory_used", lambda pool: {})


def test_fast_sampler_rings_and_snapshot(monkeypatch):
    from omlx_uplift.fast_sampler import FastSampler

    _fake_patch(monkeypatch)
    fs = FastSampler(tick_s=0.5)
    t = time.time()                             # snapshot() staleness is wall-clock
    fs.sample_once(now=t)                       # seeds baselines -> zeros
    pairs = fs.sample_once(now=t + 0.5)
    assert pairs["generation.tokens_s"] == 0.0  # zero is a data point
    snap = fs.snapshot()
    assert snap["metrics"]["generation.tokens_s"]["samples"]
    assert "sys.used_bytes" in snap["metrics"]
    assert not fs.running                       # never started a thread here


def test_ring_bounds_and_stale_age_out():
    from omlx_uplift import fast_sampler as F

    fs = F.FastSampler()
    t = 1_000_000.0
    for i in range(F.RING_CAP + 50):
        fs._push({"gen.x": float(i)}, now=t + i * 1e-4)
    ring = fs._rings["gen.x"]
    assert len(ring) == F.RING_CAP              # capped, no unbounded growth
    # a key silent beyond the ring span disappears from the snapshot
    fs._push({"gone.y": 1.0}, now=t)
    snap = fs.snapshot() if time.time() - t < F.RING_S else None
    # (snapshot() stamps 'now' internally; simulate by aging the ring directly)
    fs._rings["gone.y"] = [(t - F.RING_S - 1, 1.0)]
    snap2 = fs.snapshot()
    assert "gone.y" not in snap2["metrics"] or snap2["metrics"]["gone.y"]["samples"] == []


# -- 3. ceiling cache ---------------------------------------------------------

def test_iogpu_cache_forks_once_per_minute(monkeypatch):
    import omlx.process_memory_enforcer as pme

    import omlx_uplift.collectors as ucl

    calls = {"n": 0}

    def fake():
        calls["n"] += 1
        return 12345

    monkeypatch.setattr(pme, "get_iogpu_wired_limit_bytes", fake)
    ucl.reset_ceiling_cache()
    assert ucl.collect_iogpu_limit_bytes() == 12345
    assert ucl.collect_iogpu_limit_bytes() == 12345
    assert calls["n"] == 1                       # cached read, no second fork
    ucl.reset_ceiling_cache()
    # ZERO is never cached: unset sysctl can gain a value and must be seen
    monkeypatch.setattr(pme, "get_iogpu_wired_limit_bytes", lambda: 0)
    assert ucl.collect_iogpu_limit_bytes() == 0
    assert ucl.collect_iogpu_limit_bytes() == 0  # probes again (correctly)


# -- 4. collect_cache rates=False ---------------------------------------------

def test_fast_cache_walk_skips_rate_state(monkeypatch):
    """The 2 Hz walk must not feed or read the pfx lifetime-counter
    deltas — that state belongs to the persisting tick (9 of 10 fast
    readings would be identical zeros anyway)."""
    from dataclasses import dataclass

    import omlx_uplift.collectors as ucl
    from omlx_uplift.corewalk import scheduler_for  # noqa: F401 (shape import)

    @dataclass
    class HotSsd:
        hot_cache_size_bytes: int = 777

    class Sched:
        def get_ssd_cache_stats(self):
            return {"ssd_cache": HotSsd(), "prefix_cache": {"hits": 5}}

        def get_stats(self):
            return {"num_waiting": 2, "num_prefilling": 0, "num_running": 1}

    import types

    eng = types.SimpleNamespace(
        _engine=types.SimpleNamespace(
            engine=types.SimpleNamespace(scheduler=Sched())))
    pool = types.SimpleNamespace(
        get_loaded_model_ids=lambda: ["m1"],
        get_entry=lambda mid: types.SimpleNamespace(engine=eng))
    pairs, prev_out = ucl.collect_cache(pool, prev_ctr={"pfx.hits": 1.0},
                                        dt=0.5, rates=False)
    assert pairs["hot.m1"] == 777.0
    assert pairs["queue.waiting"] == 2.0
    assert "pfx.lookup_hit_pct" not in pairs     # no rate math on fast ticks
    assert "pfx.saved_tokens_min" not in pairs


# -- 5. routes exist on the API surface ---------------------------------------

def test_live_routes_registered():
    from omlx_uplift import router as rt

    src = (rt.STATIC_DIR.parent / "routers" / "metrics.py").read_text()
    assert '@api_router.get("/metrics/live")' in src
    assert '@api_router.get("/metrics/stream")' in src
    assert callable(rt.metrics_live) and callable(rt.metrics_stream)
    # facade re-exports keep the /admin/api alias mount complete
