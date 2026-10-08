"""REPL-2a accuracy-engine tests.

Fake classic module (same snapshot/restore doctrine as REPL-1/3 files —
NEVER leak fakes into sys.modules). Pinned contracts:

- queue_add validates via the classic request model (400 on bad task
  name, 404 unknown model, 400 bad model type)
- contention: ANE tuning / context runs block an accuracy add (classic
  queue-add route parity)
- UPLOAD OPT-IN: default path patches AB.upload_intelligence_result to
  the skip stub for the queue window and RESTORES it once the queue
  idles; upload=true leaves classic's function untouched; external runs
  never arm the patch (classic never uploads them anyway)
- results/queue payloads pass classic shapes through verbatim
- cancel restores upload behavior for the next run from ANY UI
"""
from __future__ import annotations

import asyncio
import sys
import types
import pytest


class FakeAccRequest:
    VALID = {"mmlu", "arc_challenge", "gsm8k", "humaneval"}

    def __init__(self, **kw):
        self.model_id = kw.get("model_id", "m1")
        bm = kw.get("benchmarks") or {}
        if not bm:
            raise ValueError("At least one benchmark is required")
        for name in bm:
            if name not in self.VALID:
                raise ValueError(f"Invalid benchmark '{name}'")
        self.benchmarks = bm
        self.batch_size = kw.get("batch_size", 1)
        self.enable_thinking = kw.get("enable_thinking", False)
        self.sampling_profile = kw.get("sampling_profile", "deterministic")
        self.external = kw.get("external")


class FakeQueue:
    def __init__(self):
        self.queue: list[FakeAccRequest] = []
        self.running = False
        self.current_model = None
        self.current_bench_id = None
        self.accum: list[dict] = []
        self.runs: dict[str, types.SimpleNamespace] = {}

    # --- classic module surface used by accuracy_engine ---
    def AccuracyBenchmarkRequest(self, **kw):  # noqa: N802
        return FakeAccRequest(**kw)

    def add_to_queue(self, request):
        self.queue.append(request)

    def start_next_from_queue(self, pool):
        # fake is synchronous: mark running, mint a run, finish at once
        if not self.queue or self.running:
            return
        req = self.queue.pop(0)
        self.running = True
        self.current_model = req.model_id
        bid = f"acc-fake{len(self.runs) + 1}"
        self.current_bench_id = bid
        run = types.SimpleNamespace(
            bench_id=bid, request=req, events=[], cond=asyncio.Condition(),
            terminal=False, status="completed", phase="completed",
            results=[], upload_ctx=None,
            last_progress={"bench": "mmlu", "completed": 5, "total": 5},
        )
        run.events.append({"type": "result", "data": {
            "benchmark_name": "mmlu", "accuracy": 0.8, "total_questions": 5,
            "correct_count": 4, "time_seconds": 1.0, "engine": "classic"}})
        self.runs[bid] = run
        self.accum.append(run.events[0]["data"])
        self.running = False

    def get_queue_status(self):
        return {"running": self.running, "current_model": self.current_model,
                "current_bench_id": self.current_bench_id,
                "last_progress": None, "phase": None,
                "queue": [{"model_id": r.model_id,
                           "benchmarks": list(r.benchmarks),
                           "external": r.external is not None}
                          for r in self.queue]}

    def remove_from_queue(self, idx):
        if 0 <= idx < len(self.queue):
            del self.queue[idx]
            return True
        return False

    def get_accumulated_results(self):
        return self.accum

    def reset_accumulated_results(self):
        self.accum.clear()

    def get_run(self, bench_id):
        return self.runs.get(bench_id)

    async def cancel_queue(self):
        self.queue.clear()
        self.running = False


async def _real_upload(run, ctx, result_data):
    return {"status": "done", "url": "https://omlx.ai/leaderboard/intelligence"}


@pytest.fixture()
def fake_acc(monkeypatch, tmp_path):
    # U64: accuracy write-through now touches the store dir — isolate it
    from omlx_uplift import paths as _paths
    monkeypatch.setattr(_paths, "uplift_store_dir", lambda: tmp_path)
    q = FakeQueue()
    q.VALID_BENCHMARKS = FakeAccRequest.VALID
    q.upload_intelligence_result = _real_upload
    names = ["omlx", "omlx.admin", "omlx.admin.accuracy_benchmark",
             "omlx.admin.ane_tuning", "omlx.admin.context_benchmark"]
    saved = {n: sys.modules.get(n) for n in names}
    if saved["omlx"] is None:
        sys.modules["omlx"] = types.ModuleType("omlx")
    if saved["omlx.admin"] is None:
        sys.modules["omlx.admin"] = types.ModuleType("omlx.admin")
    sys.modules["omlx.admin.accuracy_benchmark"] = q
    setattr(sys.modules["omlx.admin"], "accuracy_benchmark", q)
    ane = types.ModuleType("omlx.admin.ane_tuning")
    ane.get_active_run = lambda: None
    ctx = types.ModuleType("omlx.admin.context_benchmark")
    ctx.get_active_run = lambda: None
    sys.modules["omlx.admin.ane_tuning"] = ane
    sys.modules["omlx.admin.context_benchmark"] = ctx
    setattr(sys.modules["omlx.admin"], "ane_tuning", ane)
    setattr(sys.modules["omlx.admin"], "context_benchmark", ctx)
    try:
        yield q
    finally:
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v


class FakePool:
    def __init__(self):
        self.entries = {"m1": types.SimpleNamespace(model_type="llm"),
                        "emb": types.SimpleNamespace(model_type="embedding")}

    def get_entry(self, model_id):
        return self.entries.get(model_id)


def _mod():
    from omlx_uplift import accuracy_engine
    import importlib
    return importlib.reload(accuracy_engine)


# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_add_validation_errors(fake_acc):
    ae = _mod()
    with pytest.raises(ae.BadInput):
        await ae.queue_add({"model_id": "m1", "benchmarks": {}}, FakePool())
    with pytest.raises(ae.BadInput):
        await ae.queue_add({"model_id": "m1", "benchmarks": {"nope": 5}}, FakePool())
    with pytest.raises(ae.NotFound):
        await ae.queue_add({"model_id": "ghost", "benchmarks": {"mmlu": 5}}, FakePool())
    with pytest.raises(ae.BadInput):
        await ae.queue_add({"model_id": "emb", "benchmarks": {"mmlu": 5}}, FakePool())


@pytest.mark.asyncio
async def test_contention_ane_and_context_block_add(fake_acc):
    ae = _mod()
    admin = sys.modules["omlx.admin"]
    admin.ane_tuning.get_active_run = lambda: types.SimpleNamespace(
        tuning_id="t1", request=types.SimpleNamespace(model_id="m1"))
    with pytest.raises(ae.Conflict):
        await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5}}, FakePool())
    admin.ane_tuning.get_active_run = lambda: None
    admin.context_benchmark.get_active_run = lambda: types.SimpleNamespace(
        bench_id="c1", request=types.SimpleNamespace(model_id="m1"))
    with pytest.raises(ae.Conflict):
        await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5}}, FakePool())


@pytest.mark.asyncio
async def test_default_add_skips_upload_and_restores(fake_acc):
    ae = _mod()
    out = await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5}}, FakePool())
    assert out["running"] is False  # fake ran to completion inline
    # queue idled -> skip stub disarmed, classic function back
    assert fake_acc.upload_intelligence_result is _real_upload


@pytest.mark.asyncio
async def test_skip_stub_active_while_queue_runs(fake_acc):
    ae = _mod()
    # realistic in-flight state: queue_add must NOT disarm while running
    def busy_start(pool):
        fake_acc.running = True
        fake_acc.current_model = "m1"
        fake_acc.current_bench_id = "acc-live1"
        fake_acc.runs["acc-live1"] = types.SimpleNamespace(
            bench_id="acc-live1", terminal=False)
    orig_start = fake_acc.start_next_from_queue
    fake_acc.start_next_from_queue = busy_start
    await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5}}, FakePool())
    armed = fake_acc.upload_intelligence_result
    assert armed is not _real_upload
    outcome = await armed(None, None, {})
    assert outcome == {"status": "skipped", "reason": "uplift_opt_out"}
    # still running -> status poll keeps the window armed
    assert fake_acc.upload_intelligence_result is armed
    # run turns terminal + queue drains -> disarm on next status poll
    fake_acc.runs["acc-live1"].terminal = True
    fake_acc.running = False
    fake_acc.current_bench_id = None
    st = ae.queue_status()
    assert st["running"] is False
    assert fake_acc.upload_intelligence_result is _real_upload
    fake_acc.start_next_from_queue = orig_start


@pytest.mark.asyncio
async def test_opt_in_upload_leaves_classic_fn_untouched(fake_acc):
    ae = _mod()
    await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5}},
                       FakePool(), upload=True)
    assert fake_acc.upload_intelligence_result is _real_upload


@pytest.mark.asyncio
async def test_external_add_never_arms_skip(fake_acc):
    ae = _mod()
    await ae.queue_add({"model_id": "remote-m",
                        "benchmarks": {"mmlu": 5},
                        "external": {"base_url": "https://x/v1",
                                     "api_key": "k", "model": "remote-m"}},
                       FakePool())
    assert fake_acc.upload_intelligence_result is _real_upload


@pytest.mark.asyncio
async def test_results_and_cancel_passthrough(fake_acc):
    ae = _mod()
    await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5}}, FakePool())
    pl = ae.results_payload()
    assert pl["results"] and pl["results"][0]["benchmark_name"] == "mmlu"
    assert ae.results_reset() == {"status": "reset"}
    assert ae.results_payload()["results"] == []
    assert await ae.cancel() == {"status": "cancelled"}


def test_task_list_from_server(fake_acc):
    ae = _mod()
    assert ae.valid_benchmarks() == sorted(FakeAccRequest.VALID)


CLASSIC_16 = {
    # literal from omlx/admin/accuracy_benchmark.py VALID_BENCHMARKS
    # (master/5dcfe24 as of REPL-2 filing) — NOT the fixture's tiny set.
    "mmlu", "mmlu_pro", "kmmlu", "cmmlu", "jmmlu", "hellaswag", "truthfulqa",
    "arc_challenge", "winogrande", "gsm8k", "mathqa", "humaneval", "mbpp",
    "livecodebench", "bbq", "safetybench",
}


def test_task_groups_cover_all_16_classic_tasks():
    """TASK_GROUPS drift guard: the served grid must cover exactly
    classic's 16-task VALID_BENCHMARKS (REPL-2 card: task set is a
    superset requirement — a task disappearing from the grid silently
    loses leaderboard coverage)."""
    from omlx_uplift.accuracy_engine import TASK_GROUPS
    keys = {tk["key"] for grp in TASK_GROUPS for tk in grp["tasks"]}
    assert keys == CLASSIC_16
    for grp in TASK_GROUPS:
        assert grp["group"].startswith("acc_bench.benchmarks.group_")
        for tk in grp["tasks"]:
            assert ("desc" in tk) ^ ("desc_literal" in tk), tk["key"]
            assert tk["sizes"] and tk["full_size"] > 0
