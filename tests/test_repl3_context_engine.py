"""REPL-3 engine-layer tests: context probe + ANE tuning mirrors.

Same fake-classic-module doctrine as test_repl1_bench_engine.py (CI has
no omlx; lazy per-call imports make the swap legal; ALL touched module
names are snapshotted/restored — a leak poisons later FastAPI imports,
see the REPL-1 fixture comment).

Gates what the card pins:
- contention matrix: context start rejects while throughput/ANE/accuracy
  run and vice versa (classic routes.py semantics)
- validation: bad target_tokens / seq len -> 400; unknown model -> 404
- classic run-shape payloads pass through verbatim (result keys)
- SSE reader loop reused for context runs (replay-from-0 on reconnect)
- ane_settings_patch mirrors dashboard.js applyANETuningRecommendation
  for qwen AND k2 backends, enabled AND disabled recommendations
- ANE start forces backend from the pool entry (client value never wins)
"""
from __future__ import annotations

import asyncio
import sys
import types
import pytest


class FakeCtxRequest:
    VALID = [16384, 32768, 65536, 131072, 262144, 524288]

    def __init__(self, **kw):
        self.model_id = kw.get("model_id", "m1")
        t = kw.get("target_tokens", 131072)
        if t not in self.VALID:
            raise ValueError(f"Invalid target {t}")
        self.target_tokens = t


class FakeCtxRun:
    def __init__(self, bench_id, request):
        self.bench_id = bench_id
        self.request = request
        self.status = "running"
        self.events: list[dict] = []
        self.cond = asyncio.Condition()
        self.terminal = False
        self.task = None
        self.phase = "prepare"
        self.progress = 0.0
        self.message = ""
        self.result = None
        self.error_message = ""


class FakeCtxModule(types.ModuleType):
    def __init__(self):
        super().__init__("omlx.admin.context_benchmark")
        self.runs: dict[str, FakeCtxRun] = {}
        self._n = 0
        self.Result = FakeCtxRequest
        self.ContextBenchmarkRequest = FakeCtxRequest

    def get_run(self, bench_id):
        return self.runs.get(bench_id)

    def get_active_run(self):
        for r in self.runs.values():
            if r.status == "running":
                return r
        return None

    def create_run(self, request):
        self._n += 1
        run = FakeCtxRun(f"ctx-fake{self._n}", request)
        self.runs[run.bench_id] = run
        return run

    def cleanup_old_runs(self):
        pass

    async def _send_event(self, run, event):
        run.events.append(event)
        if event.get("type") in ("done", "error"):
            run.terminal = True
        async with run.cond:
            run.cond.notify_all()

    async def run_context_benchmark(self, run, pool):
        run.result = {"model_id": run.request.model_id,
                      "measured_tokens": 60000, "verified_tokens": 59392,
                      "applied_tokens": 59392, "applied": True,
                      "capped_by": "memory", "prefill_tps": 900.0,
                      "duration_s": 12.0}
        await self._send_event(run, {"type": "result", "data": run.result})
        run.status = "completed"
        await self._send_event(run, {"type": "done", "summary": {}})


class FakeANEModel:
    def __init__(self):
        self.model_id = "m1"
        self.sequence_length = 2048


class FakeANERun:
    def __init__(self, tuning_id, request):
        self.tuning_id = tuning_id
        self.request = request
        self.status = "running"
        self.phase = "search"
        self.message = ""
        self.current = 0
        self.total = 3
        self.results: list[dict] = []
        self.recommendation = None
        self.error_message = ""
        self.termination_reason = ""
        self.task = None


def _fake_ane_request(**kw):
    seq = kw.get("sequence_length", 2048)
    if seq < 1024 or seq % 64:
        raise ValueError("bad sequence_length")
    req = FakeANEModel()
    req.model_id = kw.get("model_id", "m1")
    req.sequence_length = seq
    req.backend = kw.get("backend", "qwen")
    for k in ("allow_cpu", "allow_cpu_gate", "allow_cpu_down", "allow_ane_gdn",
              "allow_cpu_gdn", "allow_cpu_shared_resource"):
        setattr(req, k, kw.get(k, True))
    return req


class FakeANEModule(types.ModuleType):
    def __init__(self):
        super().__init__("omlx.admin.ane_tuning")
        self.runs: dict[str, FakeANERun] = {}
        self._n = 0
        self.ANETuningRequest = _fake_ane_request

    def get_run(self, tuning_id):
        return self.runs.get(tuning_id)

    def get_active_run(self):
        for r in self.runs.values():
            if r.status == "running":
                return r
        return None

    def create_run(self, request):
        self._n += 1
        run = FakeANERun(f"ane-fake{self._n}", request)
        self.runs[run.tuning_id] = run
        return run

    def cleanup_old_runs(self):
        pass

    def run_snapshot(self, run):
        return {"tuning_id": run.tuning_id, "model_id": run.request.model_id,
                "status": run.status, "phase": run.phase, "message": run.message,
                "current": run.current, "total": run.total,
                "results": list(run.results), "recommendation": run.recommendation,
                "error": run.error_message or None,
                "termination_reason": run.termination_reason or None}

    async def run_tuning(self, run, pool):
        run.results.append({"split": "a", "state": "done",
                            "processing_tps": 100.0, "latency_ms": 5.0})
        run.recommendation = {"backend": run.request.backend, "enabled": True,
                              "sequence_length": 2048, "mlp_fraction": 0.5,
                              "tail_padding_min_tokens": 64}
        run.status = "completed"


@pytest.fixture()
def fake_engines(monkeypatch):
    ctx = FakeCtxModule()
    ane = FakeANEModule()
    bench = types.ModuleType("omlx.admin.benchmark")
    bench.get_active_run = lambda: None
    names = ["omlx", "omlx.admin", "omlx.admin.benchmark",
             "omlx.admin.context_benchmark", "omlx.admin.ane_tuning"]
    saved = {n: sys.modules.get(n) for n in names}
    if saved["omlx"] is None:
        sys.modules["omlx"] = types.ModuleType("omlx")
    if saved["omlx.admin"] is None:
        sys.modules["omlx.admin"] = types.ModuleType("omlx.admin")
    for n, m in (("omlx.admin.benchmark", bench),
                 ("omlx.admin.context_benchmark", ctx),
                 ("omlx.admin.ane_tuning", ane)):
        sys.modules[n] = m
        setattr(sys.modules["omlx.admin"], n.rsplit(".", 1)[1], m)
    try:
        yield types.SimpleNamespace(ctx=ctx, ane=ane, bench=bench)
    finally:
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v


class FakePool:
    def __init__(self, entries=None):
        self.entries = entries if entries is not None else {
            "m1": types.SimpleNamespace(model_type="llm", config_model_type="qwen3"),
            "k2m": types.SimpleNamespace(model_type="llm", config_model_type="k2_horizon"),
            "emb": types.SimpleNamespace(model_type="embedding", config_model_type=None),
        }

    def get_entry(self, model_id):
        return self.entries.get(model_id)


def _mod():
    from omlx_uplift import context_engine
    import importlib
    return importlib.reload(context_engine)


# ---------------------------------------------------------------------------
# context probe

@pytest.mark.asyncio
async def test_context_start_completes_with_classic_shape(fake_engines):
    ce = _mod()
    out = await ce.context_start({"model_id": "m1", "target_tokens": 65536}, FakePool())
    assert out["status"] == "started" and out["target_tokens"] == 65536
    run = ce.context_get(out["bench_id"])
    await run.task
    pl = ce.context_results_payload(run)
    assert pl["status"] == "completed"
    assert pl["result"]["applied"] is True
    assert {"measured_tokens", "verified_tokens", "applied_tokens",
            "capped_by", "prefill_tps", "duration_s"} <= set(pl["result"])


@pytest.mark.asyncio
async def test_context_bad_target_and_model(fake_engines):
    ce = _mod()
    with pytest.raises(ce.BadInput):
        await ce.context_start({"model_id": "m1", "target_tokens": 12345}, FakePool())
    with pytest.raises(ce.NotFound):
        await ce.context_start({"model_id": "ghost"}, FakePool())
    with pytest.raises(ce.BadInput):
        await ce.context_start({"model_id": "emb"}, FakePool())


@pytest.mark.asyncio
async def test_context_contention_matrix(fake_engines):
    ce = _mod()
    # running context blocks ANE start (classic matrix) — and re-start
    out = await ce.context_start({"model_id": "m1"}, FakePool())
    with pytest.raises(ce.Conflict):
        await ce.context_start({"model_id": "m1"}, FakePool())
    with pytest.raises(ce.Conflict):
        await ce.ane_start({"model_id": "m1"}, FakePool())
    await ce.context_cancel(ce.context_get(out["bench_id"]))
    fake_engines.ctx.runs[out["bench_id"]].status = "cancelled"


@pytest.mark.asyncio
async def test_throughput_blocks_context(fake_engines):
    ce = _mod()
    fake_engines.bench.get_active_run = lambda: types.SimpleNamespace(
        bench_id="bench-x", request=types.SimpleNamespace(model_id="m1"))
    with pytest.raises(ce.Conflict) as e:
        await ce.context_start({"model_id": "m1"}, FakePool())
    assert "throughput" in str(e.value).lower()


@pytest.mark.asyncio
async def test_context_sse_replay_reuses_reader(fake_engines):
    """Same events/cond/terminal model -> bench_engine.event_stream works
    for context runs unchanged; a late subscriber replays from 0."""
    from omlx_uplift import bench_engine
    ce = _mod()
    out = await ce.context_start({"model_id": "m1"}, FakePool())
    run = ce.context_get(out["bench_id"])
    await run.task
    got = [ev async for ev in bench_engine.event_stream(run)]
    assert any('"type": "result"' in g for g in got)
    assert any('"type": "done"' in g for g in got)
    got2 = [ev async for ev in bench_engine.event_stream(run)]
    assert got2 == got  # replay identity


# ---------------------------------------------------------------------------
# ANE tuning

@pytest.mark.asyncio
async def test_ane_start_poll_and_cancel(fake_engines):
    ce = _mod()
    out = await ce.ane_start({"model_id": "m1", "sequence_length": 2048}, FakePool())
    run = ce.ane_get(out["tuning_id"])
    await run.task
    snap = ce.ane_results_payload(run)
    assert snap["status"] == "completed" and snap["recommendation"]["enabled"]
    with pytest.raises(ce.BadInput):
        await ce.ane_cancel(run)  # not running anymore -> 400 semantics


@pytest.mark.asyncio
async def test_ane_backend_forced_from_entry(fake_engines):
    ce = _mod()
    out = await ce.ane_start({"model_id": "k2m", "backend": "qwen"}, FakePool())
    assert ce.ane_get(out["tuning_id"]).request.backend == "k2"


@pytest.mark.asyncio
async def test_ane_validation(fake_engines):
    ce = _mod()
    with pytest.raises(ce.BadInput):
        await ce.ane_start({"model_id": "m1", "sequence_length": 2000}, FakePool())
    with pytest.raises(ce.NotFound):
        await ce.ane_start({"model_id": "ghost"}, FakePool())
    with pytest.raises(ce.BadInput):
        await ce.ane_start({"model_id": "emb"}, FakePool())


@pytest.mark.asyncio
async def test_ane_running_blocks_context(fake_engines):
    ce = _mod()
    await ce.ane_start({"model_id": "m1"}, FakePool())
    with pytest.raises(ce.Conflict) as e:
        await ce.context_start({"model_id": "m1"}, FakePool())
    assert "ANE" in str(e.value)


def test_ane_settings_patch_qwen_enabled():
    ce = _mod()
    rec = {"backend": "qwen", "enabled": True, "sequence_length": 2048,
           "mlp_fraction": 0.5, "tail_padding_min_tokens": 64,
           "fused_down": True, "gdn_enabled": True, "gdn_fraction": 0.25,
           "cpu_enabled": True, "cpu_fraction": 0.1, "cpu_down_fraction": 0.2,
           "cpu_gdn_fraction": 0.3, "cpu_threads": 4,
           "cpu_shared_resource": False}
    p = ce.ane_settings_patch(rec)
    assert p["qwen35_ane_prefill_enabled"] is True
    assert p["qwen35_ane_prefill_sequence_length"] == 2048
    assert p["qwen35_ane_prefill_fraction"] == 0.5
    assert p["qwen35_ane_prefill_tail_padding_min_tokens"] == 64
    assert p["qwen35_ane_prefill_fused_down"] is True
    assert p["qwen35_ane_prefill_gdn"] is True
    assert p["qwen35_ane_prefill_gdn_fraction"] == 0.25
    assert p["qwen35_ane_prefill_cpu_enabled"] is True
    assert p["qwen35_ane_prefill_cpu_fraction"] == 0.1
    assert p["qwen35_ane_prefill_cpu_down_fraction"] == 0.2
    assert p["qwen35_ane_prefill_cpu_gdn_fraction"] == 0.3
    assert p["qwen35_ane_prefill_cpu_threads"] == 4
    assert p["qwen35_ane_prefill_cpu_shared_resource"] is False
    assert "qwen35_ane_prefill_shared_fraction" not in p  # k2-only key


def test_ane_settings_patch_disabled_keeps_seq_and_drops_fractions():
    ce = _mod()
    rec = {"backend": "qwen", "enabled": False, "sequence_length": 1024,
           "mlp_fraction": 0.9, "tail_padding_min_tokens": None}
    p = ce.ane_settings_patch(rec)
    assert p == {"qwen35_ane_prefill_enabled": False,
                 "qwen35_ane_prefill_sequence_length": 1024,
                 "qwen35_ane_prefill_tail_padding_min_tokens": 0}


def test_ane_settings_patch_k2():
    ce = _mod()
    rec = {"backend": "k2", "enabled": True, "sequence_length": 4096,
           "mlp_fraction": 0.75, "shared_fraction": 0.5}
    p = ce.ane_settings_patch(rec)
    assert p["qwen35_ane_prefill_shared_fraction"] == 0.5
    assert "qwen35_ane_prefill_gdn" not in p  # qwen-only branch


def test_ane_settings_patch_empty_rejected():
    ce = _mod()
    with pytest.raises(ce.BadInput):
        ce.ane_settings_patch({})
