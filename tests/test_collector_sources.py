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

    def write_samples(self, pairs, ts):
        self.pairs.update(pairs)

    def upsert_request(self, row):  # request tracker rows: ignore
        pass

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
