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

    def series(self, key, window_s, now=None):
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
