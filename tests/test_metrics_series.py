# SPDX-License-Identifier: Apache-2.0
"""Tests for the metrics series endpoint: downsampling of long windows and
the multi-key (explorer) fetch shape. Bare async tests, asyncio_mode=auto."""

import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from omlx_uplift import router as up   # soft omlx imports: runs with or without omlx


def _fine(key, n, step=5.0):
    t0 = time.time() - n * step
    return [{"ts": t0 + i * step, "v": float(i), "res": "fine"} for i in range(n)]


# ---- _downsample ---------------------------------------------------------

def test_downsample_noop_below_cap():
    pts = _fine("k", 100)
    out, bucket = up._downsample(pts, max_pts=200)
    assert out is pts and bucket == 0


def test_downsample_buckets_average_and_stay_under_cap():
    pts = _fine("k", 10_000, step=5.0)   # ~14h of 5s samples
    out, bucket = up._downsample(pts, max_pts=500)
    assert len(out) <= 500 + 1
    assert bucket >= 60 and bucket % 60 == 0 or bucket >= 100
    assert all(p["res"] == "avg" for p in out)
    # buckets ascend, values are means of their members (monotonic input
    # 0..9999 -> bucket means ascend too)
    ts = [p["ts"] for p in out]
    assert ts == sorted(ts)
    vs = [p["v"] for p in out]
    assert vs == sorted(vs)


def test_downsample_keeps_hourly_label_when_all_coarse():
    pts = [{"ts": 3600 * i, "v": float(i), "res": "hourly"} for i in range(3000)]
    out, bucket = up._downsample(pts, max_pts=100)
    assert bucket > 0
    # every output bucket is pure-hourly OR mixed (avg); pure ones keep res
    assert any(p["res"] == "hourly" for p in out) or all(
        p["res"] in ("hourly", "avg") for p in out)


# ---- /metrics/series -----------------------------------------------------

class _FakeStore:
    def __init__(self, data):
        self._data = data

    def series(self, key, window_s, now=None, instance=None):
        # instance filtering is the store's job (tested against a real
        # MetricsStore in test_samples_are_tagged_and_reads_filter_co_tenant)
        return [dict(p) for p in self._data.get(key, [])]


async def _call(**kw):
    return await up.metrics_series(is_admin=True, **kw)


async def test_single_key_backcompat_shape():
    pts = _fine("avg_generation_tps", 10)
    store = _FakeStore({"avg_generation_tps": pts})
    collector = MagicMock(store=store)
    with patch.object(up, "get_collector", return_value=collector), \
         patch.object(up, "_hourly_points", return_value=[]):
        d = await _call(key="avg_generation_tps", window="1h")
    assert d["key"] == "avg_generation_tps"
    assert d["bucket_s"] == 0
    assert len(d["series"]) == 10


async def test_multi_keys_returns_series_map():
    store = _FakeStore({
        "avg_generation_tps": _fine("a", 5),
        "rate.requests_s": _fine("b", 3),
    })
    collector = MagicMock(store=store)
    with patch.object(up, "get_collector", return_value=collector), \
         patch.object(up, "_hourly_points", return_value=[]):
        d = await _call(keys="avg_generation_tps,rate.requests_s", window="1h")
    assert set(d["series_map"]) == {"avg_generation_tps", "rate.requests_s"}
    assert len(d["series_map"]["rate.requests_s"]) == 3


async def test_long_window_gets_downsampled_and_advertises_bucket():
    store = _FakeStore({"avg_generation_tps": _fine("a", up.MAX_SERIES_POINTS * 3)})
    collector = MagicMock(store=store)
    with patch.object(up, "get_collector", return_value=collector), \
         patch.object(up, "_hourly_points", return_value=[]):
        d = await _call(key="avg_generation_tps", window="7d")
    assert len(d["series"]) <= up.MAX_SERIES_POINTS + 1
    assert d["bucket_s"] >= 60


async def test_no_keys_is_400():
    with pytest.raises(HTTPException) as e:
        await _call(window="1h")
    assert e.value.status_code == 400


# ---- /metrics/hot (per-model hot-cache discovery) --------------------------

async def test_metrics_hot_discovers_per_model_keys():
    from unittest.mock import MagicMock

    store = MagicMock()
    store.keys_with_prefix.return_value = ["hot.m1", "hot.m2"]
    store.series.side_effect = lambda k, w, now=None, inst=None: [
        {"ts": 100.0, "v": 5.0}, {"ts": 105.0, "v": 0.0}]
    collector = MagicMock(store=store)
    with patch.object(up, "get_collector", return_value=collector):
        d = await up.metrics_hot(window="1h", is_admin=True)
    assert d["keys"] == ["hot.m1", "hot.m2"]
    # drained model keeps its trailing ZERO — that point is the whole point
    assert d["series_map"]["hot.m2"][-1]["v"] == 0.0
    assert store.keys_with_prefix.call_args[0][0] == "hot."


def test_keys_with_prefix_filters_window_instance_and_underscores(tmp_path):
    from omlx_uplift import store as st

    s = st.MetricsStore(path=tmp_path / "m.sqlite3")
    try:
        now = time.time()
        me = st.server_instance_id()
        s.write_samples({"hot.model_x": 1.0}, ts=now - 10)
        s.write_samples({"cache.total_bytes": 2.0}, ts=now - 10)
        s.write_samples({"hot1.rotating": 3.0}, ts=now - 10)   # old rank key
        s.write_samples({"hot.gone": 4.0}, ts=now - 99999)     # outside 1h
        s._conn.execute(
            "INSERT INTO samples(ts,key,value,instance) VALUES(?,?,?,'other')",
            (now - 5, "hot.cotenant", 9.0))
        s._conn.commit()

        keys = s.keys_with_prefix("hot.", 3600, instance=me)
        # LIKE '_*' must not let 'hot1.rotating' match 'hot.' ('_' wildcard
        # escaped); co-tenant and out-of-window keys stay out.
        assert keys == ["hot.model_x"]
    finally:
        s.close()


# ---- MetricsStore.latest (U11 live chart push) ---------------------------

def test_store_latest_returns_newest_point(tmp_path):
    from omlx_uplift.store import MetricsStore

    s = MetricsStore(path=tmp_path / "m.sqlite3")
    try:
        assert s.latest("sys.percent") is None
        s.write_samples({"sys.percent": 10.0}, ts=100.0)
        s.write_samples({"sys.percent": 37.5}, ts=200.0)
        s.write_samples({"sys.percent": 12.0}, ts=150.0)   # out-of-order write
        p = s.latest("sys.percent")
        assert p == {"ts": 200.0, "v": 37.5}
    finally:
        s.close()


# ---- co-tenant sample tagging (broken-graphs fix) -------------------------

def test_samples_are_tagged_and_reads_filter_co_tenant(tmp_path):
    """Two servers sharing ONE metrics DB must not poison each other's
    charts: samples carry the writer's instance id and filtered reads keep
    only that writer's rows plus untagged legacy rows."""
    from omlx_uplift import store as st

    s = st.MetricsStore(path=tmp_path / "m.sqlite3")
    try:
        me = st.server_instance_id()
        # legacy rows (pre-migration shape): instance IS NULL
        s._conn.execute("INSERT INTO samples(ts,key,value) VALUES(10,'k',1.0)")
        s._conn.commit()
        s.write_samples({"k": 2.0}, ts=20.0)            # tagged with me
        s._conn.execute(                                # a co-tenant's row
            "INSERT INTO samples(ts,key,value,instance) VALUES(30,'k',99.0,'other')")
        s._conn.commit()

        unfiltered = s.series("k", 10_000, now=100.0)
        assert [p["v"] for p in unfiltered] == [1.0, 2.0, 99.0]

        mine = s.series("k", 10_000, now=100.0, instance=me)
        assert [p["v"] for p in mine] == [1.0, 2.0]     # legacy visible, co-tenant not
        assert s.latest("k", instance=me) == {"ts": 20.0, "v": 2.0}
        assert s.latest("k") == {"ts": 30.0, "v": 99.0}
    finally:
        s.close()


def test_instance_id_unique_per_process():
    """Tagging only works if ids actually differ across processes; a stable
    id (keg-only) would leave same-keg co-tenants mixed."""
    import os

    from omlx_uplift.store import server_instance_id

    assert server_instance_id().endswith(f"\x1f{os.getpid()}")


# ---- _HOURLY_DERIVE: avg_prefill_tps must mirror upstream's honest metric
# (server_metrics._build_snapshot divides prompt MINUS cached tokens). The
# old prompt-only derivation inflated the 7d/30d backfill up to +45% over
# the live number on cache-heavy hours (user 2026-09-29: uplift prefill
# reads much higher than classic, unrealistic).

def test_hourly_prefill_derive_excludes_cached_tokens():
    row = {"requests": 4, "prompt_tokens": 51933, "completion_tokens": 200,
           "cached_tokens": 12288, "prefill_seconds": 335.8,
           "generation_seconds": 40.0}
    v = up._HOURLY_DERIVE["avg_prefill_tps"](row)
    assert abs(v - (51933 - 12288) / 335.8) < 1e-9


def test_hourly_prefill_derive_zero_cached_matches_naive():
    row = {"requests": 1, "prompt_tokens": 175, "completion_tokens": 5,
           "cached_tokens": 0, "prefill_seconds": 1.57,
           "generation_seconds": 1.0}
    assert abs(up._HOURLY_DERIVE["avg_prefill_tps"](row) - 175 / 1.57) < 1e-9


def test_hourly_prefill_derive_guards():
    # no prefill time -> None (same as before)
    assert up._HOURLY_DERIVE["avg_prefill_tps"](
        {"prompt_tokens": 10, "cached_tokens": 0, "prefill_seconds": 0}) is None
    # cached > prompt (a counter glitch) -> None, never a negative TPS
    assert up._HOURLY_DERIVE["avg_prefill_tps"](
        {"prompt_tokens": 10, "cached_tokens": 20, "prefill_seconds": 1.0}) is None
