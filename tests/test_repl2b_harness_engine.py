"""REPL-2b engine tests: dispatcher gates + harness plumbing.

Fake-classic-module doctrine as in the other engine test files. Pinned:
- run_usable: tag required, external/thinking/unmapped refuse harness
- queue_add engine validation: unknown engine 400; harness+unmapped 400
  listing the tasks; harness tag rides the request object
- _parse_results_json: metric prefix + contains filter + sample_len
- progress parsing: tqdm fraction -> bench_current/bench_total (never
  fabricated: lines without a fraction emit nothing)
- dispatcher wraps AB exactly once and untagged runs reach classic
"""
from __future__ import annotations

import asyncio
import json
import sys
import types
import pytest


class FakeAccRequest:
    def __init__(self, **kw):
        self.model_id = kw.get("model_id", "m1")
        self.benchmarks = kw.get("benchmarks") or {"mmlu": 5}
        self.batch_size = kw.get("batch_size", 1)
        self.enable_thinking = kw.get("enable_thinking", False)
        self.sampling_profile = kw.get("sampling_profile", "deterministic")
        self.external = kw.get("external")


def _fake_ab():
    ab = types.ModuleType("omlx.admin.accuracy_benchmark")
    ab.AccuracyBenchmarkRequest = lambda **kw: FakeAccRequest(**kw)
    ab.run_calls = []
    ab.get_accumulated_results = lambda: acc_accum
    async def _send_event(run, ev):
        run.events.append(ev)
        if ev.get("type") in ("done", "error"):
            run.terminal = True
    ab._send_event = _send_event
    async def run_accuracy_benchmark(run, pool):
        ab.run_calls.append(("classic", run.bench_id))
        run.status = "completed"
        await _send_event(run, {"type": "done", "summary": {}})
    ab.run_accuracy_benchmark = run_accuracy_benchmark
    async def upload_intelligence_result(run, ctx, result_data):
        return {"status": "done"}
    ab.upload_intelligence_result = upload_intelligence_result
    ab.build_upload_context = lambda request, pool: {"owner_hash": None}
    return ab


acc_accum: list[dict] = []


@pytest.fixture()
def fake_ab():
    global acc_accum
    acc_accum = []
    ab = _fake_ab()
    names = ["omlx", "omlx.admin", "omlx.admin.accuracy_benchmark"]
    saved = {n: sys.modules.get(n) for n in names}
    if saved["omlx"] is None:
        sys.modules["omlx"] = types.ModuleType("omlx")
    if saved["omlx.admin"] is None:
        sys.modules["omlx.admin"] = types.ModuleType("omlx.admin")
    sys.modules["omlx.admin.accuracy_benchmark"] = ab
    setattr(sys.modules["omlx.admin"], "accuracy_benchmark", ab)
    try:
        yield ab
    finally:
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v


def _req(**kw):
    r = FakeAccRequest(**kw)
    return r


# ---- gates ---------------------------------------------------------------

def test_run_usable_gates():
    from omlx_uplift import harness_engine as he
    r = _req()
    assert he.run_usable(r) is False                       # untagged
    r._uplift_engine = "harness"
    assert he.run_usable(r) is True                        # mmlu mapped
    r.enable_thinking = True
    assert he.run_usable(r) is False                       # thinking -> classic
    r.enable_thinking = False
    r.external = object()
    assert he.run_usable(r) is False                       # external -> classic
    r.external = None
    r.benchmarks = {"mmlu": 5, "safetybench": 5}
    assert he.run_usable(r) is False                       # unmapped poisons run


def test_harness_map_covers_only_verified_names():
    from omlx_uplift import harness_engine as he
    assert he.harness_available("mmlu") and he.harness_available("gsm8k")
    assert not he.harness_available("humaneval")  # exec-isolation finding
    assert set(he.NOT_HARNESS) >= {"humaneval", "mbpp", "jmmlu",
                                   "livecodebench", "safetybench"}
    for spec in he.HARNESS_MAP.values():
        assert spec["tasks"] and spec["metric"]


@pytest.mark.asyncio
async def test_queue_add_engine_validation(fake_ab):
    from omlx_uplift import accuracy_engine as ae
    import importlib
    ae = importlib.reload(ae)

    class Pool:
        def get_entry(self, mid):
            return types.SimpleNamespace(model_type="llm")

    async def noop(pool):
        pass
    fake_ab.add_to_queue = lambda r: fake_ab.queue.append(r)
    fake_ab.queue = []
    fake_ab.start_next_from_queue = noop
    fake_ab.get_queue_status = lambda: {"running": False, "current_model": None,
                                        "current_bench_id": None, "queue": []}
    # unknown engine -> 400
    with pytest.raises(ae.BadInput):
        await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5},
                            "engine": "quantum"}, Pool())
    # harness + unmapped task -> 400 naming the task
    with pytest.raises(ae.BadInput) as e:
        await ae.queue_add({"model_id": "m1",
                            "benchmarks": {"mmlu": 5, "safetybench": 5},
                            "engine": "harness"}, Pool())
    assert "safetybench" in str(e.value)
    # harness + mapped -> tagged request queued
    await ae.queue_add({"model_id": "m1", "benchmarks": {"gsm8k": 5},
                        "engine": "harness"}, Pool())
    assert getattr(fake_ab.queue[-1], "_uplift_engine") == "harness"
    # classic stays untagged; 'engine' never reaches the request model
    await ae.queue_add({"model_id": "m1", "benchmarks": {"gsm8k": 5},
                        "engine": "classic"}, Pool())
    assert getattr(fake_ab.queue[-1], "_uplift_engine", None) is None
    assert not hasattr(fake_ab.queue[-1], "engine")


# ---- parse + progress -----------------------------------------------------

def test_parse_results_json(tmp_path):
    from omlx_uplift.harness_engine import _parse_results_json
    (tmp_path / "results_2026.json").write_text(json.dumps({"results": {
        "gsm8k": {"exact_match,flexible-extract": 0.62,
                  "exact_match,strict-match": 0.5,
                  "exact_match_stderr,flexible-extract": 0.1,
                  "sample_len": 100}}}))
    score, n = _parse_results_json(tmp_path, "exact_match", "flexible-extract")
    assert score == 0.62 and n == 100
    score, n = _parse_results_json(tmp_path, "exact_match", None)
    assert score in (0.62, 0.5) and n == 100        # first match wins
    score, _ = _parse_results_json(tmp_path, "acc", None)
    assert score is None                             # absent metric -> None
    assert _parse_results_json(tmp_path / "nope", "exact_match", None) == (None, 0)


def test_tqdm_parse_shape():
    import re
    from omlx_uplift.harness_engine import _TQDM
    m = _TQDM.search("Requesting API:  40%|████      | 40/100 [00:10<00:15]")
    assert m and (m.group(2), m.group(3)) == ("40", "100")
    assert _TQDM.search("some log line without progress") is None


# ---- dispatcher wrap -------------------------------------------------------

@pytest.mark.asyncio
async def test_dispatcher_install_idempotent_and_routes(fake_ab):
    from omlx_uplift import harness_engine as he
    import importlib
    he = importlib.reload(he)
    he._installed = False
    he.install_dispatcher()
    first = fake_ab.run_accuracy_benchmark
    he.install_dispatcher()
    assert fake_ab.run_accuracy_benchmark is first   # exactly once
    assert getattr(fake_ab, "_uplift_dispatcher")

    # untagged run goes classic
    run = types.SimpleNamespace(bench_id="acc1", request=_req(), events=[],
                                cond=asyncio.Condition(), terminal=False,
                                status="running", phase="pending", results=[],
                                upload_ctx=None)
    await fake_ab.run_accuracy_benchmark(run, None)
    assert fake_ab.run_calls == [("classic", "acc1")]
