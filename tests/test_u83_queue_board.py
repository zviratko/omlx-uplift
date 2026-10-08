"""U83: queue_status board data.

classic's status lists waiting entries as name-only. The native board needs
per-entry SIZES + ENGINE (to compute honest queue-wide question totals) and
the RUNNING entry's full spec (classic exposes it as phase text only). All
additive — classic's own admin page ignores extra keys.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def fake_acc(monkeypatch, tmp_path):
    from tests.test_repl2a_accuracy_engine import FakeQueue, FakePool, _real_upload
    monkeypatch.FAKE_POOL = FakePool()
    from omlx_uplift import paths as _paths
    monkeypatch.setattr(_paths, "uplift_store_dir", lambda: tmp_path)
    import sys, types
    q = FakeQueue()
    q.VALID_BENCHMARKS = {"mmlu", "arc_challenge", "gsm8k", "humaneval"}
    q.upload_intelligence_result = _real_upload
    names = ["omlx", "omlx.admin", "omlx.admin.accuracy_benchmark",
             "omlx.admin.ane_tuning", "omlx.admin.context_benchmark"]
    saved = {n: sys.modules.get(n) for n in names}
    sys.modules.setdefault("omlx", types.ModuleType("omlx"))
    sys.modules.setdefault("omlx.admin", types.ModuleType("omlx.admin"))
    sys.modules["omlx.admin.accuracy_benchmark"] = q
    setattr(sys.modules["omlx.admin"], "accuracy_benchmark", q)
    for mod, attr in (("ane_tuning", "get_active_run"),):
        m = types.ModuleType("omlx.admin." + mod)
        setattr(m, attr, lambda: None)
        sys.modules["omlx.admin." + mod] = m
        setattr(sys.modules["omlx.admin"], mod, m)
    cb = types.ModuleType("omlx.admin.context_benchmark")
    cb.get_active_run = lambda: None
    sys.modules["omlx.admin.context_benchmark"] = cb
    setattr(sys.modules["omlx.admin"], "context_benchmark", cb)
    try:
        yield q
    finally:
        for n in reversed(names):
            if saved[n] is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = saved[n]


@pytest.fixture()
def fake_acc_pool(fake_acc, monkeypatch):
    from tests.test_repl2a_accuracy_engine import FakePool
    return FakePool()


async def test_waiting_entry_carries_sizes_and_engine(fake_acc, fake_acc_pool):
    from omlx_uplift import accuracy_engine as AE
    # block the synchronous start so the entry stays WAITING (real classic
    # is async; the fake starts inline) — queue it, then read status
    fake_acc.start_next_from_queue = lambda pool: None
    await AE.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 30, "gsm8k": 50}},
                       pool=fake_acc_pool)
    st = AE.queue_status()
    assert st["queue"], "entry should be queued"
    e = st["queue"][0]
    assert e["sizes"] == {"mmlu": 30, "gsm8k": 50}
    assert e["engine"] == "classic"


async def test_harness_entry_engine_label(fake_acc, fake_acc_pool):
    from omlx_uplift import accuracy_engine as AE
    fake_acc.start_next_from_queue = lambda pool: None
    # harness engine needs the mapping to accept the task; force classic
    # shape but tag the request as harness the way accuracy_engine does
    await AE.queue_add({"model_id": "m1", "benchmarks": {"gsm8k": 20}},
                       pool=fake_acc_pool)
    req = fake_acc.queue[0]
    req._uplift_engine = "harness"
    st = AE.queue_status()
    assert st["queue"][0]["engine"] == "harness"


async def test_running_entry_spec_exposed(fake_acc):
    from omlx_uplift import accuracy_engine as AE
    st = AE.queue_status()          # idle: no running_entry
    assert "running_entry" not in st
    # simulate a live run the dispatcher would surface
    req = fake_acc.AccuracyBenchmarkRequest(model_id="m1",
                                            benchmarks={"mmlu": 30})
    fake_acc.running = True
    fake_acc.current_model = "m1"
    fake_acc.current_bench_id = "run-1"
    fake_acc.runs["run-1"] = types_ns(request=req)
    st = AE.queue_status()
    re = st["running_entry"]
    assert re["model_id"] == "m1" and re["sizes"] == {"mmlu": 30}
    assert re["engine"] == "classic"


def types_ns(request):  # tiny helper, mirrors SimpleNamespace(request=...)
    import types
    return types.SimpleNamespace(request=request)
