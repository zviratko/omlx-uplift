"""PREFILL-4 (user item 4): tests for the uplift-native prefill/parallel
probe — omlx_uplift/bench_prefill.py.

Everything here runs against FAKE classic modules + a FAKE engine pool,
the same shape tests/test_repl1_bench_engine.py uses (bench_prefill
imports `omlx.admin.benchmark` lazily per call, which is what makes a
swap-in fake legal, and what keeps CI — where omlx does not exist — green).

Coverage:
  * validate_body: the floors (prefill >= 1024, parallel >= 1, tg >= 1),
    the stagger bound (>= 0), the parallel sanity ceiling, bool/float/str
    rejection, model_id required, unknown profile when the module declares one
  * start_offsets: the stagger arithmetic that IS the feature
  * aggregate_metrics: the wave math (combined prefill tok/s, combined
    decode tok/s, wall time) + the _MIN_TG_TOKENS honesty rule
  * a full run against a fake core: prompt building (one distinct prompt
    per parallel request + a non-recorded warm-up), the stagger offsets the
    wave actually used, per-request metric kwargs handed to classic's math,
    result rows + aggregate + terminal events
  * contention: classic throughput run, our own second run, bench_queue reason
  * cancel + NotRunning
  * DRIFT GUARD: the seams this module borrows from the INSTALLED vanilla
    module must really exist with the parameter names we send (skips on CI)
"""
from __future__ import annotations

import asyncio
import inspect
import sys
import time
import types

import pytest

from omlx_uplift import bench_prefill as PF
from omlx_uplift.bench_engine import BadInput, Conflict, NotFound


def _body(**over):
    body = {"model_id": "Qwen3-4B-MLX-4bit", "prefill_tokens": 8192,
            "parallel": 4, "stagger_seconds": 0.0, "generation_tokens": 64}
    body.update(over)
    return body


# ---------------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------------

class FakeOutput:
    def __init__(self, completion_tokens, prompt_tokens, finished):
        self.completion_tokens = completion_tokens
        self.prompt_tokens = prompt_tokens
        self.finished = finished


class FakeCore:
    """Stands in for the scheduler core vanilla exposes as
    engine._engine: add_request + stream_outputs (the exact seam
    benchmark.py's _run_batch_test uses)."""

    def __init__(self, *, truncate_at=None, step_s=0.001, tokens=32):
        self.submitted: list[dict] = []
        self.truncate_at = truncate_at      # engine reports fewer prompt tokens
        self.step_s = step_s
        self.tokens = tokens
        self._n = 0

    async def add_request(self, *, prompt, sampling_params, skip_cache_store):
        self._n += 1
        self.submitted.append({
            "t": time.perf_counter(),
            "prompt_len": len(prompt),
            "prompt_id": prompt[0] if prompt else None,
            "max_tokens": getattr(sampling_params, "max_tokens", None),
            "skip_cache_store": skip_cache_store,
        })
        return f"req-{self._n}"

    async def stream_outputs(self, request_id):
        n = int(request_id.split("-")[1])
        prompt_len = self.submitted[n - 1]["prompt_len"]
        reported = self.truncate_at or prompt_len
        for k in range(1, self.tokens + 1):
            await asyncio.sleep(self.step_s)
            yield FakeOutput(k, reported, k == self.tokens)


class FakeBenchmarkModule(types.ModuleType):
    """The slice of omlx/admin/benchmark.py that bench_prefill reuses."""

    def __init__(self, *, active=None):
        super().__init__("omlx.admin.benchmark")
        self.active = active
        self.prompt_calls: list[tuple[int, str]] = []
        self.metrics_calls: list[dict] = []
        self._built = 0

    # --- module constants we read ---
    _MIN_TG_TOKENS = 16
    BENCHMARK_CONTEXT_PROFILES = {}      # empty = profile not policed here

    # --- the reused seams ---
    def _generate_prompt(self, tokenizer, target_tokens, context_profile=None):
        self.prompt_calls.append((target_tokens, context_profile))
        self._built += 1
        # a distinct object per call (vanilla's uniqueness is a UUID prefix)
        return [self._built] + list(range(1, target_tokens))

    def _get_batch_benchmark_core(self, engine):
        return getattr(engine, "_engine", None)

    def _compute_single_metrics(self, *, prompt_tokens, completion_tokens,
                                start_time, first_token_time, end_time,
                                peak_memory, cached_tokens):
        self.metrics_calls.append({
            "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
            "start_time": start_time, "first_token_time": first_token_time,
            "end_time": end_time, "peak_memory": peak_memory,
            "cached_tokens": cached_tokens})
        ttft = first_token_time - start_time
        gen = end_time - first_token_time
        measured = completion_tokens >= self._MIN_TG_TOKENS and gen > 0
        return {
            "ttft_ms": round(ttft * 1000, 1),
            "tpot_ms": round(gen / (completion_tokens - 1) * 1000, 2)
                       if measured else None,
            "gen_tps": round(completion_tokens / gen, 1) if measured else None,
            "processing_tps": round(prompt_tokens / max(ttft, 1e-9), 1),
            "e2e_latency_s": round(end_time - start_time, 3),
            "total_throughput": round((prompt_tokens + completion_tokens)
                                      / max(end_time - start_time, 1e-9), 1),
            "peak_memory_bytes": peak_memory,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cached_tokens": cached_tokens,
        }

    # --- contention registry ---
    def get_active_run(self):
        return self.active


class FakeRunRef:
    def __init__(self, bench_id, model_id):
        self.bench_id = bench_id
        self.request = types.SimpleNamespace(model_id=model_id)


class FakeEngine:
    def __init__(self, core):
        self._engine = core
        self.tokenizer = types.SimpleNamespace(name="fake-tok")


class FakePool:
    def __init__(self, core, *, model_type="llm", fail_load=False):
        self.core = core
        self.model_type = model_type
        self.fail_load = fail_load
        self.load_calls: list[tuple[str, bool]] = []

    def get_entry(self, model_id):
        if model_id == "missing":
            return None
        return types.SimpleNamespace(model_id=model_id,
                                     model_type=self.model_type)

    async def get_engine(self, model_id, force_lm=False):
        self.load_calls.append((model_id, bool(force_lm)))
        if self.fail_load:
            raise RuntimeError("load refused")
        return FakeEngine(self.core)


@pytest.fixture()
def fake_world(monkeypatch):
    mod = FakeBenchmarkModule()
    ctx = types.ModuleType("omlx.admin.context_benchmark")
    ctx.get_active_run = lambda: None
    names = ["omlx", "omlx.admin", "omlx.admin.benchmark",
             "omlx.admin.context_benchmark"]
    saved = {n: sys.modules.get(n) for n in names}
    if saved["omlx"] is None:
        sys.modules["omlx"] = types.ModuleType("omlx")
    if saved["omlx.admin"] is None:
        sys.modules["omlx.admin"] = types.ModuleType("omlx.admin")
    sys.modules["omlx.admin"].benchmark = mod
    sys.modules["omlx.admin.benchmark"] = mod
    sys.modules["omlx.admin.context_benchmark"] = ctx
    # the queue arbiter is its own module (tested in test_bench_queue.py);
    # pin it 'free' so these tests judge bench_prefill, not a live FIFO
    from omlx_uplift import bench_queue
    async def _free(kind=None):
        return None
    monkeypatch.setattr(bench_queue, "busy_check", _free)
    # the probe's sampling params must not import the real omlx.request
    monkeypatch.setattr(PF, "_sampling_params",
                        lambda B, n: types.SimpleNamespace(max_tokens=n))
    PF._runs.clear()
    try:
        yield mod
    finally:
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v
        PF._runs.clear()


async def _finish(run, timeout=10.0):
    await asyncio.wait_for(run.task, timeout=timeout)
    return run


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

def test_validate_body_defaults_and_types(fake_world):
    req = PF.validate_body(_body())
    assert (req.model_id, req.prefill_tokens, req.parallel) == (
        "Qwen3-4B-MLX-4bit", 8192, 4)
    assert req.stagger_seconds == 0.0 and req.generation_tokens == 64
    # integral floats from JSON are whole numbers; a fraction is not
    assert PF.validate_body(_body(prefill_tokens=8192.0)).prefill_tokens == 8192
    with pytest.raises(BadInput):
        PF.validate_body(_body(prefill_tokens=8192.5))
    # string numbers are NOT silently coerced
    with pytest.raises(BadInput):
        PF.validate_body(_body(prefill_tokens="8192"))


@pytest.mark.parametrize("bad", [0, 1, 512, 1023, -8192])
def test_rejects_prefill_below_the_floor(fake_world, bad):
    with pytest.raises(BadInput) as e:
        PF.validate_body(_body(prefill_tokens=bad))
    assert "prefill_tokens" in str(e.value) and "1024" in str(e.value)


def test_prefill_has_no_ceiling(fake_world):
    # the point of the card: longer than vanilla's 200k ladder rung, and
    # arbitrary sizes between the rungs
    for n in (1024, 200000, 200001, 1_000_000):
        assert PF.validate_body(_body(prefill_tokens=n)).prefill_tokens == n


@pytest.mark.parametrize("bad", [0, -1])
def test_rejects_parallel_below_one(fake_world, bad):
    with pytest.raises(BadInput) as e:
        PF.validate_body(_body(parallel=bad))
    assert "parallel" in str(e.value)


def test_parallel_ceiling_is_declared_not_invented(fake_world):
    # MAX_PARALLEL is the one absolute bound this module adds (a typo must
    # not open 100k concurrent add_request calls); the UI input carries the
    # same max, so the panel can never promise more than the runner does.
    assert PF.validate_body(_body(parallel=PF.MAX_PARALLEL)).parallel \
        == PF.MAX_PARALLEL
    with pytest.raises(BadInput):
        PF.validate_body(_body(parallel=PF.MAX_PARALLEL + 1))


@pytest.mark.parametrize("bad", [True, False])
def test_bool_is_never_a_count(fake_world, bad):
    with pytest.raises(BadInput):
        PF.validate_body(_body(parallel=bad))
    with pytest.raises(BadInput):
        PF.validate_body(_body(prefill_tokens=bad))


def test_rejects_negative_stagger(fake_world):
    with pytest.raises(BadInput) as e:
        PF.validate_body(_body(stagger_seconds=-0.5))
    assert "stagger_seconds" in str(e.value)
    assert PF.validate_body(_body(stagger_seconds=0)).stagger_seconds == 0.0
    assert PF.validate_body(_body(stagger_seconds=2)).stagger_seconds == 2.0
    # a string number is rejected, exactly like the integer fields: the
    # panel sends JSON numbers, and a silent float("soon") is a 500 waiting
    # to happen
    with pytest.raises(BadInput):
        PF.validate_body(_body(stagger_seconds="0.5"))
    with pytest.raises(BadInput):
        PF.validate_body(_body(stagger_seconds=True))


@pytest.mark.parametrize("bad", [0, -3])
def test_rejects_generation_tokens_below_one(fake_world, bad):
    with pytest.raises(BadInput):
        PF.validate_body(_body(generation_tokens=bad))


def test_model_id_required(fake_world):
    with pytest.raises(BadInput):
        PF.validate_body(_body(model_id="  "))


def test_unknown_profile_rejected_when_module_declares_them(fake_world):
    fake_world.BENCHMARK_CONTEXT_PROFILES = {
        "code_python": object(), "novel_en": object()}
    PF.validate_body(_body(context_profile="novel_en"))
    with pytest.raises(BadInput):
        PF.validate_body(_body(context_profile="shakespeare"))


# ---------------------------------------------------------------------------
# stagger arithmetic + wave math (pure)
# ---------------------------------------------------------------------------

def test_start_offsets():
    assert PF.start_offsets(4, 0.0) == [0.0, 0.0, 0.0, 0.0]
    assert PF.start_offsets(4, 0.25) == [0.0, 0.25, 0.5, 0.75]
    assert PF.start_offsets(1, 5.0) == [0.0]
    assert PF.start_offsets(3, 0.1) == [0.0, 0.1, 0.2]     # no fp drift
    assert PF.start_offsets(0, 1.0) == []


def _row(first, end, *, prompt=1024, completion=32, ttft=2.0):
    return {"first_token_abs": first, "end_abs": end, "prompt_tokens": prompt,
            "completion_tokens": completion, "ttft_ms": ttft}


def test_aggregate_metrics_math():
    # wall start 100.0; all four prefills done at 102.0; wave ends 104.0
    rows = [_row(102.0, 104.0) for _ in range(4)]
    agg = PF.aggregate_metrics(rows, wall_start=100.0, wall_end=104.0,
                               prompt_tokens=1024)
    assert agg["requests"] == 4
    assert agg["total_prompt_tokens"] == 4096
    assert agg["total_completion_tokens"] == 128
    assert agg["wall_time_s"] == pytest.approx(4.0, abs=1e-6)
    # classic's definition: ALL prompt tokens / time until the LAST first
    # token (= 4096 / 2.0)
    assert agg["combined_prefill_tps"] == pytest.approx(2048.0)
    assert agg["prefill_wall_s"] == pytest.approx(2.0)
    # ALL generated tokens / the wall after that last first-token
    assert agg["combined_decode_tps"] == pytest.approx(64.0)
    assert agg["generation_wall_s"] == pytest.approx(2.0)
    assert agg["avg_ttft_ms"] == 2.0


def test_aggregate_uses_the_last_request_to_finish_prefill():
    rows = [_row(101.0, 104.0), _row(103.0, 104.0)]
    agg = PF.aggregate_metrics(rows, wall_start=100.0, wall_end=104.0,
                               prompt_tokens=2048)
    assert agg["prefill_wall_s"] == pytest.approx(3.0)
    assert agg["combined_prefill_tps"] == pytest.approx(4096 / 3.0, rel=1e-3)
    assert agg["generation_wall_s"] == pytest.approx(1.0)
    assert agg["min_ttft_ms"] == agg["max_ttft_ms"] == 2.0


def test_aggregate_decode_reports_none_below_the_floor():
    # classic's _MIN_TG_TOKENS rule, applied to the wave: a handful of
    # back-to-back emission bursts is not a decode rate -> null, not 0.0
    rows = [_row(102.0, 102.05, completion=4) for _ in range(2)]
    agg = PF.aggregate_metrics(rows, wall_start=100.0, wall_end=102.05,
                               prompt_tokens=1024, min_decode_tokens=16)
    assert agg["combined_decode_tps"] is None
    assert agg["total_completion_tokens"] == 8
    # an empty generation window is equally unmeasurable
    same = [_row(104.0, 104.0) for _ in range(2)]
    assert PF.aggregate_metrics(same, wall_start=100.0, wall_end=104.0,
                                prompt_tokens=1024)["combined_decode_tps"] is None


def test_aggregate_needs_rows():
    with pytest.raises(ValueError):
        PF.aggregate_metrics([], wall_start=0.0, wall_end=1.0,
                             prompt_tokens=1024)


# ---------------------------------------------------------------------------
# the run itself
# ---------------------------------------------------------------------------

async def test_probe_runs_measures_and_publishes(fake_world):
    core = FakeCore(tokens=32)
    pool = FakePool(core)
    out = await PF.start(_body(prefill_tokens=2048, parallel=3,
                               generation_tokens=32), pool)
    run = await _finish(PF.get_run(out["bench_id"]))
    assert out["status"] == "started" and run.status == "completed"
    assert out["requests"] == 3

    # ONE DISTINCT PROMPT PER REQUEST (vanilla builds max_batch prompts for
    # exactly this reason: a shared prompt would hit the prefix cache), plus
    # one 32-token warm-up prompt that is NOT a result.
    measured = [c for c in fake_world.prompt_calls if c[0] == 2048]
    assert len(measured) == 3
    assert (2048, "code_python") in measured
    assert (32, "code_python") in fake_world.prompt_calls
    assert len(core.submitted) == 4          # warm-up + 3 measured

    # the engine seam classic's batch test uses
    assert all(s["skip_cache_store"] is True for s in core.submitted)
    assert all(s["max_tokens"] == 32 for s in core.submitted[1:])
    assert core.submitted[0]["max_tokens"] == 8    # warm-up stays short

    assert len(run.results) == 3
    assert [r["index"] for r in run.results] == [0, 1, 2]
    assert run.results[0]["prompt_tokens"] == 2048
    assert run.results[0]["completion_tokens"] == 32
    # classic's math owns the row: our code only supplies the timings
    for call in fake_world.metrics_calls[1:]:
        assert call["prompt_tokens"] == 2048
        assert call["completion_tokens"] == 32
        assert call["start_time"] <= call["first_token_time"] <= call["end_time"]
        assert "peak_memory_bytes" not in run.results[0]
    agg = run.aggregate
    assert agg["requests"] == 3 and agg["total_prompt_tokens"] == 6144
    assert agg["combined_prefill_tps"] > 0
    types_in_stream = [e["type"] for e in run.events]
    assert types_in_stream.count("result") == 3
    # the client bar is the WAVE: total == parallel, and the last request
    # fills it (the warm-up must not inflate or advance it)
    progress = [e for e in run.events if e["type"] == "progress"]
    assert {p["total"] for p in progress} == {3}
    assert progress[-1]["current"] == 3
    assert [p["phase"] for p in progress][:3] == ["load", "prompt", "warmup"]
    assert types_in_stream[-2:] == ["aggregate", "done"]
    assert run.terminal is True and run.progress == 1.0

    payload = PF.results_payload(run)
    assert payload["status"] == "completed"
    assert payload["request"]["prefill_tokens"] == 2048
    assert len(payload["results"]) == 3
    assert payload["error"] is None
    # absolute clocks are private bookkeeping, never wire format
    assert all("first_token_abs" not in r for r in payload["results"])
    assert PF.get_active_run() is None


async def test_stagger_offsets_actually_shift_the_submits(fake_world):
    stagger = 0.05
    core = FakeCore(tokens=8, step_s=0.001)
    pool = FakePool(core)
    out = await PF.start(_body(prefill_tokens=1024, parallel=4,
                               stagger_seconds=stagger,
                               generation_tokens=8), pool)
    run = await _finish(PF.get_run(out["bench_id"]))
    submits = [s["t"] for s in core.submitted[1:]]        # skip the warm-up
    t0 = submits[0]
    got = [s - t0 for s in submits]
    assert got == sorted(got), "requests must leave in stagger order"
    for i, delta in enumerate(got):
        assert delta == pytest.approx(i * stagger, abs=stagger * 0.6), \
            f"request {i} left at {delta:.3f}s, expected {i * stagger:.3f}s"
    assert [r["start_offset_s"] for r in run.results] == \
        PF.start_offsets(4, stagger)
    # simultaneous stays simultaneous (classic's batch behaviour)
    assert PF.start_offsets(4, 0.0) == [0.0] * 4


async def test_probe_errors_are_reported_not_swallowed(fake_world):
    # the loud no-ceiling rule: the engine cut the prompt -> error, and the
    # error names both numbers
    core = FakeCore(tokens=8, truncate_at=512)
    pool = FakePool(core)
    out = await PF.start(_body(prefill_tokens=4096, parallel=1,
                               generation_tokens=8), pool)
    run = await _finish(PF.get_run(out["bench_id"]))
    assert run.status == "error"
    assert "512" in run.error_message and "4096" in run.error_message
    assert run.events[-1]["type"] == "error"
    assert run.terminal is True
    assert PF.results_payload(run)["error"] == run.error_message
    assert PF.get_active_run() is None       # an error must not hold the slot


async def test_prompt_builder_length_is_verified(fake_world):
    # a builder that silently returns fewer tokens than asked would print a
    # pp8192 row for an 8000-token prefill
    def short(tokenizer, n, profile=None):
        return list(range(min(n, 100)))
    fake_world._generate_prompt = short
    pool = FakePool(FakeCore(tokens=8))
    out = await PF.start(_body(prefill_tokens=8192, parallel=1,
                               generation_tokens=8), pool)
    run = await _finish(PF.get_run(out["bench_id"]))
    assert run.status == "error"
    assert "8192" in run.error_message


async def test_engine_without_batch_core_is_a_clean_error(fake_world):
    pool = FakePool(None)                     # engine._engine is None
    out = await PF.start(_body(parallel=1), pool)
    run = await _finish(PF.get_run(out["bench_id"]))
    assert run.status == "error"
    assert "batched engine core" in run.error_message


async def test_load_failure_leaves_no_run_stuck_running(fake_world):
    pool = FakePool(FakeCore(tokens=8), fail_load=True)
    out = await PF.start(_body(parallel=1), pool)
    run = await _finish(PF.get_run(out["bench_id"]))
    assert run.status == "error" and run.terminal is True
    assert PF.get_active_run() is None


# ---------------------------------------------------------------------------
# contention + control
# ---------------------------------------------------------------------------

async def test_refuses_while_classic_throughput_runs(fake_world):
    fake_world.active = FakeRunRef("bench-1", "Other-Model")
    pool = FakePool(FakeCore())
    with pytest.raises(Conflict) as e:
        await PF.start(_body(), pool)
    assert "throughput" in str(e.value) and "bench-1" in str(e.value)
    assert PF._runs == {}                    # refused starts claim nothing


async def test_refuses_a_second_probe(fake_world):
    pool = FakePool(FakeCore(tokens=64, step_s=0.01))
    out = await PF.start(_body(parallel=2, generation_tokens=64), pool)
    with pytest.raises(Conflict) as e:
        await PF.start(_body(parallel=1), pool)
    assert "prefill probe is already running" in str(e.value)
    await _finish(PF.get_run(out["bench_id"]))


async def test_refuses_when_the_global_queue_is_busy(fake_world):
    from omlx_uplift import bench_queue

    async def _busy(kind=None):
        return "a throughput benchmark is running"
    monkey = pytest.MonkeyPatch()
    monkey.setattr(bench_queue, "busy_check", _busy)
    try:
        with pytest.raises(Conflict) as e:
            await PF.start(_body(), FakePool(FakeCore()))
        assert "throughput" in str(e.value)
    finally:
        monkey.undo()


def test_queue_probe_sees_the_prefill_lane(fake_world):
    """The OTHER direction of the contention rule: bench_queue's BUSY table
    must report the prefill lane, or every native bench start would happily
    double-book the engine while a probe runs."""
    from omlx_uplift import bench_queue
    assert "prefill" in bench_queue.BUSY
    assert bench_queue._busy_prefill() is False
    PF.create_run(PF.validate_body(_body()))
    assert bench_queue._busy_prefill() is True
    assert "prefill" in bench_queue._REASONS


async def test_cancel_settles_the_run(fake_world):
    core = FakeCore(tokens=64, step_s=0.02)
    pool = FakePool(core)
    out = await PF.start(_body(parallel=2, generation_tokens=64,
                               stagger_seconds=0.5), pool)
    run = PF.get_run(out["bench_id"])
    await asyncio.sleep(0.05)
    res = await PF.cancel(run)
    assert res["status"] == "cancelled"
    with pytest.raises(asyncio.CancelledError):
        await run.task
    assert run.status == "cancelled" and run.terminal is True
    assert PF.get_active_run() is None
    with pytest.raises(PF.NotRunning):
        await PF.cancel(run)


async def test_active_summary_shape(fake_world):
    assert PF.active_summary() == {"running": False, "bench_id": None,
                                   "model_id": None}
    core = FakeCore(tokens=16, step_s=0.005)
    pool = FakePool(core)
    out = await PF.start(_body(prefill_tokens=1024, parallel=2,
                               stagger_seconds=0.2, generation_tokens=16), pool)
    s = PF.active_summary()
    assert s["running"] is True and s["bench_id"] == out["bench_id"]
    assert s["model_id"] == "Qwen3-4B-MLX-4bit"
    assert s["prefill_tokens"] == 1024 and s["parallel"] == 2
    assert s["stagger_seconds"] == 0.2 and s["generation_tokens"] == 16
    await _finish(PF.get_run(out["bench_id"]))


async def test_unknown_model_is_404_not_500(fake_world):
    with pytest.raises(NotFound):
        await PF.start(_body(model_id="missing"), FakePool(FakeCore()))


def test_registry_retention_keeps_the_slot(fake_world):
    for _ in range(3):
        PF.create_run(PF.validate_body(_body()))
    PF._runs[list(PF._runs)[0]].status = "completed"
    PF.cleanup_old_runs(max_runs=2)
    assert len(PF._runs) == 2



# ---------------------------------------------------------------------------
# HTTP surface (routers/bench.py): the literals resolve to THEIR handlers
# ---------------------------------------------------------------------------

def _client(monkeypatch, pool=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from omlx_uplift.routers import base as up_base
    from omlx_uplift.routers import bench as bench_mod

    app = FastAPI()
    app.include_router(bench_mod.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    monkeypatch.setattr(bench_mod, "engine_pool", lambda: pool)
    return TestClient(app)


def test_routes_gated_and_literals_resolve(monkeypatch, fake_world):
    client = _client(monkeypatch, pool=None)
    # every prefill route consults the admin gate (the same Depends-graph
    # assertion nat3 pins for the whole bench band)
    for r in client.app.routes:
        path = getattr(r, "path", "")
        if path.startswith("/uplift/api/bench/prefill"):
            calls = set()
            stack = [r.dependant]
            while stack:
                d = stack.pop()
                if getattr(d, "call", None) is not None:
                    calls.add(getattr(d.call, "__name__", ""))
                stack.extend(d.dependencies)
            assert "require_admin" in calls, path
    # pool missing -> 503, never a 500
    assert client.post("/uplift/api/bench/prefill/start",
                       json=_body()).status_code == 503
    # a dynamic id must NOT be swallowed by /bench/{run_id}/results:
    # the throughput handler answers 'Benchmark not found', ours says
    # 'Probe not found' — the detail string IS the routing proof.
    r = client.get("/uplift/api/bench/prefill/nope/results")
    assert r.status_code == 404 and "Probe not found" in r.text, r.text
    r = client.post("/uplift/api/bench/prefill/nope/cancel", json={})
    assert r.status_code == 404 and "Probe not found" in r.text, r.text
    s = client.get("/uplift/api/bench/prefill/active").json()
    assert s == {"running": False, "bench_id": None, "model_id": None}


def test_start_400_vs_404_vs_200_over_http(monkeypatch, fake_world):
    core = FakeCore(tokens=16, step_s=0.001)
    pool = FakePool(core)
    client = _client(monkeypatch, pool=pool)
    # 400: the pure validator rejects before anything claims the engine
    r = client.post("/uplift/api/bench/prefill/start",
                    json=_body(prefill_tokens=512))
    assert r.status_code == 400 and "prefill_tokens" in r.text
    assert PF._runs == {}, "a rejected start claims no run id"
    # 404: unknown model
    assert client.post("/uplift/api/bench/prefill/start",
                       json=_body(model_id="missing")).status_code == 404
    # 409: another bench owns the slot
    fake_world.active = FakeRunRef("bench-9", "Other")
    r = client.post("/uplift/api/bench/prefill/start", json=_body())
    assert r.status_code == 409 and "throughput" in r.text
    fake_world.active = None
    # 200 + the run is registered. NOTE the harness limit, stated rather
    # than papered over: starlette's TestClient runs ONE portal per request,
    # so a task started during this POST is torn down when the response
    # returns — the run ends 'cancelled' here where a real server keeps it
    # running on the app loop. The engine-level tests above (awaiting
    # run.task directly) are what prove a completed probe; this route test
    # proves the HTTP contract: codes, payload shape and handler identity.
    r = client.post("/uplift/api/bench/prefill/start",
                    json=_body(prefill_tokens=1024, parallel=2,
                               generation_tokens=16, stagger_seconds=0.01))
    assert r.status_code == 200, r.text
    started = r.json()
    assert started["status"] == "started" and started["requests"] == 2
    assert started["prefill_tokens"] == 1024 and started["stagger_seconds"] == 0.01
    bid = started["bench_id"]
    assert PF.get_run(bid) is not None, "the start really claimed a run id"

    payload = client.get(f"/uplift/api/bench/prefill/{bid}/results").json()
    assert payload["bench_id"] == bid
    assert payload["status"] in ("running", "completed", "cancelled", "error")
    assert payload["request"] == {"model_id": _body()["model_id"],
                                 "prefill_tokens": 1024,
                                 "parallel": 2, "stagger_seconds": 0.01,
                                 "generation_tokens": 16,
                                 "context_profile": "code_python"}
    assert isinstance(payload["results"], list)
    stream = client.get(f"/uplift/api/bench/prefill/{bid}/stream")
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    # cancel answers through OUR handler (a settled/cancelled run is a 400
    # from NotRunning, never a 500 and never the throughput route's 404)
    cancel = client.post(f"/uplift/api/bench/prefill/{bid}/cancel", json={})
    assert cancel.status_code in (200, 400), cancel.text
    assert cancel.status_code == 400 or cancel.json()["status"] == "cancelled"


def test_reused_vanilla_seams_really_exist():
    """The fakes above declare the shapes we ASSUME. If upstream renames
    `_generate_prompt` or drops a parameter from
    `_compute_single_metrics`, the suite must go red HERE (on the keg
    python; skipped where omlx is not installed) instead of at the first
    live probe."""
    B = pytest.importorskip("omlx.admin.benchmark")
    for name in ("_generate_prompt", "_get_batch_benchmark_core",
                 "_compute_single_metrics", "_MIN_TG_TOKENS",
                 "get_active_run", "BENCHMARK_CONTEXT_PROFILES"):
        assert hasattr(B, name), f"vanilla benchmark lost {name}"
    params = inspect.signature(B._compute_single_metrics).parameters
    sent = {"prompt_tokens", "completion_tokens", "start_time",
            "first_token_time", "end_time", "peak_memory", "cached_tokens"}
    missing = sent - set(params)
    assert not missing, f"_compute_single_metrics no longer takes {missing}"
    # the add_request call signature is the other half of the seam
    SP = pytest.importorskip("omlx.request").SamplingParams
    assert SP(max_tokens=8, temperature=0.0, top_p=1.0, ignore_eos=True)
    ec = pytest.importorskip("omlx.engine_core")
    names = inspect.signature(ec.AsyncEngineCore.add_request).parameters
    assert {"prompt", "sampling_params"} <= set(names), \
        f"AsyncEngineCore.add_request changed: {sorted(names)}"
    # skip_cache_store rides the wrapper's **kwargs down to the real core,
    # where classic's own batch test uses it — check BOTH halves.
    assert any(p.kind is p.VAR_KEYWORD for p in names.values()), \
        "AsyncEngineCore.add_request stopped forwarding **kwargs"
    inner = inspect.signature(ec.EngineCore.add_request).parameters
    assert "skip_cache_store" in inner, \
        f"EngineCore.add_request lost skip_cache_store: {sorted(inner)}"
    assert "stream_outputs" in dir(ec.AsyncEngineCore)
    # the pool seam: get_engine takes force_lm (we pass True — the batched
    # scheduler core only exists on the mlx-lm engine)
    from omlx.engine_pool import EnginePool
    assert "force_lm" in inspect.signature(EnginePool.get_engine).parameters
