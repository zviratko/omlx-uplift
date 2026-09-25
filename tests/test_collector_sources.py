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

    # two running requests in the snapshot; one model with 123456 cached bytes
    assert store.pairs["engines.active_requests"] == 2.0
    assert store.pairs["cache.total_bytes"] == 123456.0
    assert store.pairs["engines.loaded"] == 1.0


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
    assert store.pairs["cache.total_bytes"] == 123456.0
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
