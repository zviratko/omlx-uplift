"""ACC-2b: the harness-only suite seam.

Extras are HARNESS_MAP entries carrying {'extra': True, label, family,
rows, upload_ok: False} — suites beyond classic's VALID_BENCHMARKS (the
16) that only the harness engine can run and that omlx.ai must never see.
Pinned here:

- queue_add admits an EXTRA under engine='harness' (uplift request
  SUBCLASS), through the same native contract, tagged for the dispatcher
- the same EXTRA is REFUSED under engine='classic' (classic's vanilla
  16-name wall stays exactly as shipped) and under harness+external /
  harness+thinking (run_usable's gates mirrored, honest refusal)
- run_usable accepts an all-extra run; classic-16 twin names are
  unaffected (vanilla class still constructs them, both engines)
- the seam never touches classic's class: the vanilla request still
  refuses the extra, and the subclass IS-A classic request (queue/typing)
- upload gate in the harness runner: an extra's row records a skip and
  AB.upload_intelligence_result is NEVER called for it, even with the
  community-upload opt-in on; twins still upload
- classic-fallback guard: a harness failure in a run carrying extras
  reports the error instead of silently dropping the suites (classic's
  BENCHMARKS.get() only warns — accuracy_benchmark.py:494)
- /bench/accuracy/tasks keeps 'harness_tasks' shape and ADDS
  'extra_suites' with the exact contract keys; 'valid' stays the 16
- DRIFT GUARD against the REAL classic class (keg python only, skips on
  CI): the override point is still a pydantic field_validator named
  'validate_benchmarks' over the 'benchmarks' field.

Fake-classic-module doctrine as in test_repl2b_harness_engine.py; the
fake request model is REAL pydantic so the seam's override mechanism is
exercised for real without omlx.
"""
from __future__ import annotations

import asyncio
import types
import sys

import pytest

pydantic = pytest.importorskip("pydantic")
from typing import Any  # noqa: E402

from pydantic import BaseModel, field_validator  # noqa: E402

VALID_16 = ["mmlu", "mmlu_pro", "kmmlu", "cmmlu", "jmmlu",
            "hellaswag", "truthfulqa", "arc_challenge", "winogrande",
            "gsm8k", "mathqa", "humaneval", "mbpp", "livecodebench",
            "bbq", "safetybench"]

FAKE_EXTRA = "fake_ifeval"
FAKE_EXTRA_SPEC = {"tasks": ["uplift_fake_ifeval"], "fewshot": 0,
                   "metric": "exact_match", "metric_contains": None,
                   "extra": True, "label": "Fake IFEval",
                   "family": "instruction", "rows": 541,
                   "upload_ok": False}


class FakeAccuracyRequest(BaseModel):
    """Mirror of classic's AccuracyBenchmarkRequest (the validator that
    IS the wall: name must be in VALID_16)."""
    model_id: str
    benchmarks: dict[str, int]
    batch_size: int = 1
    enable_thinking: bool = False
    sampling_profile: str = "deterministic"
    external: Any = None

    @field_validator("benchmarks")
    @classmethod
    def validate_benchmarks(cls, v: dict[str, int]) -> dict[str, int]:
        if not v:
            raise ValueError("At least one benchmark is required")
        for name, size in v.items():
            if name not in VALID_16:
                raise ValueError(
                    f"Invalid benchmark '{name}'. Must be one of {VALID_16}")
            if size < 0:
                raise ValueError(f"Sample size for '{name}' must be >= 0")
        return v


acc_accum: list[dict] = []


def _fake_ab():
    ab = types.ModuleType("omlx.admin.accuracy_benchmark")
    ab.VALID_BENCHMARKS = list(VALID_16)
    ab.AccuracyBenchmarkRequest = FakeAccuracyRequest
    ab.queue = []
    ab.upload_calls: list[str] = []
    ab.get_accumulated_results = lambda: acc_accum
    ab.add_to_queue = lambda r: ab.queue.append(r)
    ab.build_upload_context = lambda request, pool: {"owner_hash": None}

    async def _send_event(run, ev):
        run.events.append(ev)
        if ev.get("type") in ("done", "error"):
            run.terminal = True
    ab._send_event = _send_event

    async def upload_intelligence_result(run, ctx, result_data):
        ab.upload_calls.append(result_data["benchmark"])
        return {"status": "done"}
    ab.upload_intelligence_result = upload_intelligence_result

    def start_next_from_queue(pool):      # sync in classic too (no warning)
        pass
    ab.start_next_from_queue = start_next_from_queue
    ab.get_queue_status = lambda: {"running": False, "current_model": None,
                                   "current_bench_id": None, "queue": []}
    return ab


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


@pytest.fixture()
def extra_map(monkeypatch):
    """A FAKE extra injected into HARNESS_MAP (ACC-2c adds the real ones)."""
    from omlx_uplift import harness_engine as he
    monkeypatch.setitem(he.HARNESS_MAP, FAKE_EXTRA, dict(FAKE_EXTRA_SPEC))
    return he


class Pool:
    def get_entry(self, mid):
        return types.SimpleNamespace(model_type="llm")


# ---- seam helpers ---------------------------------------------------------

def test_extra_helpers_read_the_map_live(extra_map):
    he = extra_map
    assert he.is_extra(FAKE_EXTRA) is True
    assert he.is_extra("mmlu") is False          # classic-16 twin
    assert he.upload_blocked(FAKE_EXTRA) is True
    assert he.upload_blocked("mmlu") is False
    assert FAKE_EXTRA not in VALID_16            # the whole point
    admitted = he.admitted_benchmarks(VALID_16)
    assert {FAKE_EXTRA, "mmlu", "gsm8k"} <= admitted
    # extras-only payload, exact contract keys
    out = he.extra_suites()
    assert out == [{"key": FAKE_EXTRA, "label": "Fake IFEval",
                    "family": "instruction", "rows": 541,
                    "upload_ok": False}]
    for row in out:
        assert row["family"] in he.EXTRA_FAMILIES
        assert isinstance(row["label"], str) and row["label"]
        assert row["rows"] is None or isinstance(row["rows"], int)


def test_extra_invariants_hold_whatever_the_map_ships():
    """The seam's contract on the map itself: 'extra' means NOT one of the
    classic 16 and never uploadable; a twin (no 'extra' key) IS a classic
    name and keeps classic semantics. ACC-2b ships NO extras yet (that is
    ACC-2c) — this stays green either way, so it does not rot when the real
    suites land, but it fails the moment one lands half-configured."""
    from omlx_uplift import harness_engine as he
    for key, spec in he.HARNESS_MAP.items():
        if spec.get("extra"):
            assert key not in VALID_16, key
            assert spec.get("upload_ok") is False, key
            assert spec.get("family") in he.EXTRA_FAMILIES, key
            assert str(spec.get("label") or ""), key
            assert spec.get("rows") is None or isinstance(spec["rows"], int)
            assert he.upload_blocked(key) and he.is_extra(key)
        else:
            assert key in VALID_16, key          # classic-16 twin
            assert not he.is_extra(key) and not he.upload_blocked(key)
    assert ({r["key"] for r in he.extra_suites()}
            == {k for k, s in he.HARNESS_MAP.items() if s.get("extra")})


# ---- queue_add: admit under harness, refuse elsewhere --------------------

async def _add(ab, body, **kw):
    from omlx_uplift import accuracy_engine as ae
    return await ae.queue_add(body, Pool(), **kw)


@pytest.mark.asyncio
async def test_queue_add_accepts_extra_under_harness(fake_ab, extra_map):
    from omlx_uplift import accuracy_engine as ae
    await _add(fake_ab, {"model_id": "m1",
                         "benchmarks": {FAKE_EXTRA: 20, "mmlu": 5},
                         "engine": "harness"})
    req = fake_ab.queue[-1]
    assert req.benchmarks == {FAKE_EXTRA: 20, "mmlu": 5}   # order: sorted keys
    assert list(req.benchmarks) == sorted([FAKE_EXTRA, "mmlu"])
    assert getattr(req, "_uplift_engine") == "harness"
    # the seam is ADDITIVE: the instance is still a classic request, so
    # classic's queue/run/dataclass annotations accept it unchanged
    assert isinstance(req, fake_ab.AccuracyBenchmarkRequest)
    assert type(req) is not fake_ab.AccuracyBenchmarkRequest
    assert extra_map.run_usable(req) is True
    # mixed extras + classic-16 in ONE run: allowed, all harness-mapped
    assert all(extra_map.harness_available(t) for t in req.benchmarks)


@pytest.mark.asyncio
async def test_queue_add_refuses_extra_under_classic(fake_ab, extra_map):
    from omlx_uplift import accuracy_engine as ae
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1",
                             "benchmarks": {FAKE_EXTRA: 20}})
    assert FAKE_EXTRA in str(e.value)
    # classic's OWN message (the vanilla 16-name wall), and classic's own
    # class was used — the seam does not widen the classic engine at all
    assert "Must be one of" in str(e.value)
    assert fake_ab.queue == []


@pytest.mark.asyncio
async def test_queue_add_refuses_extra_external_and_thinking(fake_ab,
                                                             extra_map):
    from omlx_uplift import accuracy_engine as ae
    # external: harness refuses local-only suites (and external anyway)
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1",
                             "benchmarks": {FAKE_EXTRA: 5},
                             "external": {"base_url": "http://x"},
                             "engine": "harness"})
    assert "external" in str(e.value)
    # thinking: run_usable would never take the harness branch, and the
    # classic fallback DROPS extras — refuse at the queue instead
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1",
                             "benchmarks": {FAKE_EXTRA: 5, "mmlu": 5},
                             "enable_thinking": True, "engine": "harness"})
    assert FAKE_EXTRA in str(e.value) and "thinking" in str(e.value)
    assert len(fake_ab.queue) == 0
    # a twin-only run with thinking keeps its PRE-2b behaviour (tag it,
    # dispatcher routes classic) — the seam changed nothing for the 16
    await _add(fake_ab, {"model_id": "m1", "benchmarks": {"mmlu": 5},
                         "enable_thinking": True, "engine": "harness"})
    assert getattr(fake_ab.queue[-1], "_uplift_engine") == "harness"


@pytest.mark.asyncio
async def test_queue_add_unknown_engine_and_junk_name(fake_ab, extra_map):
    from omlx_uplift import accuracy_engine as ae
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1", "benchmarks": {"mmlu": 5},
                             "engine": "quantum"})
    assert "unknown engine 'quantum'" in str(e.value)
    # a name in NO list is refused by the seam too, naming itself
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1", "benchmarks": {"bogus": 5},
                             "engine": "harness"})
    assert "bogus" in str(e.value)
    # negative size still refused (the subclass re-states the parent rule)
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1",
                             "benchmarks": {FAKE_EXTRA: -1},
                             "engine": "harness"})
    assert ">= 0" in str(e.value)
    assert fake_ab.queue == []


@pytest.mark.asyncio
async def test_classic_16_names_unaffected_both_engines(fake_ab, extra_map):
    from omlx_uplift import accuracy_engine as ae
    await _add(fake_ab, {"model_id": "m1",
                         "benchmarks": {"gsm8k": 5, "bbq": 10}})
    assert type(fake_ab.queue[-1]) is fake_ab.AccuracyBenchmarkRequest
    assert getattr(fake_ab.queue[-1], "_uplift_engine", None) is None
    await _add(fake_ab, {"model_id": "m1", "benchmarks": {"gsm8k": 5},
                         "engine": "harness"})
    assert getattr(fake_ab.queue[-1], "_uplift_engine") == "harness"
    # unmapped classic name under harness keeps the cmmlu-style refusal
    with pytest.raises(ae.BadInput) as e:
        await _add(fake_ab, {"model_id": "m1", "benchmarks": {"mbpp": 5},
                             "engine": "harness"})
    assert "mbpp" in str(e.value) and "classic engine" in str(e.value)


def test_run_usable_accepts_all_extra_run(extra_map):
    r = types.SimpleNamespace(model_id="m", benchmarks={FAKE_EXTRA: 5},
                              external=None, enable_thinking=False,
                              _uplift_engine="harness")
    assert extra_map.run_usable(r) is True
    r.enable_thinking = True
    assert extra_map.run_usable(r) is False      # gate still holds
    r.enable_thinking = False
    r.external = object()
    assert extra_map.run_usable(r) is False
    # refusal text comes from the seam, per gate, naming the suite
    r.external = None
    assert extra_map.extra_admission_error(r) is None
    r.enable_thinking = True
    msg = extra_map.extra_admission_error(r)
    assert msg and FAKE_EXTRA in msg and "thinking" in msg
    r.enable_thinking = False
    r.benchmarks = {"mmlu": 5}
    assert extra_map.extra_admission_error(r) is None   # twins untouched


def test_extra_flows_through_suite_args_without_classic_registry(extra_map):
    """The harness subprocess takes HARNESS_MAP['tasks'] names directly —
    no classic evaluator registry is consulted, which is why an extra is
    runnable at all (contract item 5)."""
    he = extra_map
    args = he._suite_args(he.HARNESS_MAP[FAKE_EXTRA], "http://x/v1", "m",
                          __import__("pathlib").Path("/tmp/o"), 7,
                          "deterministic")
    assert args[args.index("--tasks") + 1] == "uplift_fake_ifeval"
    assert args[args.index("--limit") + 1] == "7"
    assert "--include_path" in args


# ---- upload gate + fallback guard in the runner ---------------------------

def _run_obj(request):
    return types.SimpleNamespace(bench_id="acc1", request=request, events=[],
                                 cond=asyncio.Condition(), terminal=False,
                                 status="running", phase="pending",
                                 results=[], upload_ctx=None,
                                 error_message="")


class FakePool:
    async def get_engine(self, mid, force_lm=True, _lease=False):
        return object()

    def release_engine(self, mid):
        return None


def _req(benchmarks, **kw):
    return types.SimpleNamespace(model_id="m1", benchmarks=benchmarks,
                                 sampling_profile="deterministic",
                                 external=None, enable_thinking=False,
                                 _uplift_engine="harness", **kw)


@pytest.mark.asyncio
async def test_upload_skipped_for_extra_rows(fake_ab, extra_map):
    import pathlib
    from omlx_uplift import harness_engine as he
    rows = {}

    async def fake_suite(run, task, size, pool, i, n):
        return {"model_id": run.request.model_id, "external": False,
                "benchmark": task, "accuracy": 0.5, "thinking_used": False,
                "total": size, "correct": size // 2, "time_s": 1.0,
                "dataset_total": None, "sampling_profile": "deterministic",
                "engine": "harness", "question_results": []}
    monkey = pytest.MonkeyPatch()
    monkey.setattr(he, "run_suite", fake_suite)
    monkey.setattr(he, "_base_url", lambda: "http://127.0.0.1:1/v1/x")
    monkey.setattr(he, "_api_key", lambda: "k")
    monkey.setattr(he, "results_root", lambda: pathlib.Path("/tmp/acc2b"))
    monkey.setattr(he.bench_env, "status",
                   lambda **kw: {"state": "ready", "path": None})
    try:
        req = _req({FAKE_EXTRA: 10, "mmlu": 10})
        run = _run_obj(req)
        await he.run_harness(run, FakePool(), None)
    finally:
        monkey.undo()
    assert run.status == "completed"
    # the extra NEVER reached the uploader; the twin did (upload opt-in ON:
    # upload_ctx is built, so this is the 'even if upload is enabled' case)
    assert fake_ab.upload_calls == ["mmlu"]
    by_name = {r["benchmark"]: r for r in run.results}
    assert by_name[FAKE_EXTRA]["upload"] == {"status": "skipped",
                                             "reason": "local_only_suite"}
    assert by_name["mmlu"]["upload"] == {"status": "done"}
    ev = [e for e in run.events if e.get("type") == "upload"]
    assert {e["data"]["benchmark"] for e in ev} == {FAKE_EXTRA, "mmlu"}
    skip = [e for e in ev if e["data"]["benchmark"] == FAKE_EXTRA][0]
    assert skip["data"]["status"] == "skipped"
    assert skip["data"]["reason"] == he.LOCAL_ONLY_UPLOAD_REASON


@pytest.mark.asyncio
async def test_extra_run_never_falls_back_to_classic(fake_ab, extra_map):
    """classic's Phase 3 skips unknown names with a warning only
    (accuracy_benchmark.py:494) — a fallback would 'complete' the run with
    the extras silently dropped."""
    from omlx_uplift import harness_engine as he
    calls = []

    async def boom(run, task, size, pool, i, n):
        raise RuntimeError("harness died before any result")
    monkey = pytest.MonkeyPatch()
    monkey.setattr(he, "run_suite", boom)
    monkey.setattr(he, "_base_url", lambda: "http://127.0.0.1:1/v1/x")
    monkey.setattr(he, "_api_key", lambda: "k")
    monkey.setattr(he.bench_env, "status",
                   lambda **kw: {"state": "ready", "path": None})

    async def classic_runner(run, pool):
        calls.append(run.request.benchmarks)
        run.status = "completed"
    try:
        run = _run_obj(_req({FAKE_EXTRA: 10, "mmlu": 10}))
        await he.run_harness(run, FakePool(), classic_runner)
        assert run.status == "error" and calls == []
        assert any(e.get("type") == "error" for e in run.events)
        # control: a twin-only run KEEPS the pre-2b classic fallback
        run2 = _run_obj(_req({"mmlu": 10}))
        await he.run_harness(run2, FakePool(), classic_runner)
        assert calls == [{"mmlu": 10}] and run2.status == "completed"
    finally:
        monkey.undo()


# ---- endpoint shape (the picker lane codes against this) ------------------

def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base
    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app)


def test_tasks_endpoint_adds_extra_suites(fake_ab, extra_map):
    with _client() as client:
        out = client.get("/uplift/api/bench/accuracy/tasks").json()
    assert FAKE_EXTRA in out["harness_tasks"]          # shape unchanged: keys
    assert isinstance(out["harness_tasks"], list)
    # 'valid' is the leaderboard-eligible 16 — deliberately NOT widened
    assert out["valid"] == sorted(VALID_16)
    assert FAKE_EXTRA not in out["valid"]
    assert out["extra_suites"] == [{"key": FAKE_EXTRA, "label": "Fake IFEval",
                                    "family": "instruction", "rows": 541,
                                    "upload_ok": False}]
    assert {t["key"] for g in out["tasks"] for t in g["tasks"]} <= set(VALID_16)


# ---- drift guard: the seam against the REAL classic class -----------------

def test_seam_overrides_the_real_classic_validator():
    """RUNS ON THE KEG PYTHON, skips on CI (no omlx). If upstream renames
    the validator/field or leaves pydantic, the override silently stops
    overriding and extras become unqueueable — suite-green-elsewhere bug."""
    AB = pytest.importorskip("omlx.admin.accuracy_benchmark")
    from omlx_uplift import accuracy_engine as ae
    from omlx_uplift import harness_engine as he
    Base = AB.AccuracyBenchmarkRequest
    decorators = Base.__pydantic_decorators__
    names = {d.func.__name__ for d in decorators.field_validators.values()}
    assert "validate_benchmarks" in names, names
    assert FAKE_EXTRA not in AB.VALID_BENCHMARKS
    monkey = pytest.MonkeyPatch()
    monkey.setitem(he.HARNESS_MAP, FAKE_EXTRA, dict(FAKE_EXTRA_SPEC))
    try:
        Sub = ae.suite_request_class(Base)
        assert ae.suite_request_class(Base) is Sub         # cached per base
        assert issubclass(Sub, Base)
        r = Sub(model_id="m", benchmarks={FAKE_EXTRA: 5, "mmlu": 3})
        assert r.benchmarks == {FAKE_EXTRA: 5, "mmlu": 3}
        r._uplift_engine = "harness"                       # tag must stick
        assert r._uplift_engine == "harness"
        with pytest.raises(Exception):
            Sub(model_id="m", benchmarks={"bogus_suite": 5})
        with pytest.raises(Exception):
            Sub(model_id="m", benchmarks={FAKE_EXTRA: -1})
        with pytest.raises(Exception):
            Sub(model_id="m", benchmarks={}, )
        # inherited rules survive the override
        with pytest.raises(Exception):
            Sub(model_id="m", benchmarks={"mmlu": 1}, batch_size=3)
        # classic's own class is UNTOUCHED: the vanilla wall still holds
        with pytest.raises(Exception):
            Base(model_id="m", benchmarks={FAKE_EXTRA: 5})
        # and the seam does not leak into the classic 16 accepted set
        assert he.admitted_benchmarks(AB.VALID_BENCHMARKS) >= set(
            AB.VALID_BENCHMARKS) | {FAKE_EXTRA}
    finally:
        monkey.undo()
