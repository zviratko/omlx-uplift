"""REPL-1 engine-layer tests.

Gates the card's acceptance items that are testable without a GPU:
upload opt-out (no POST to omlx.ai from tests), contention 409s,
validation errors, and the SSE replay-after-reconnect semantics ported
by REUSE (the same run-object delivery model classic pins upstream in
test_benchmark_sse_replay.py — here we pin OUR reader loop against it).

The classic engine module is stubbed in sys.modules: CI has no omlx, and
the dev-box run must not depend on a live server. bench_engine imports
`from omlx.admin import benchmark as B` LAZILY (per-call), which is what
makes a swap-in fake legal.
"""
from __future__ import annotations

import asyncio
import sys
import types
import pytest


# ---------------------------------------------------------------------------
# fake classic benchmark module (module-level API surface we depend on)
# ---------------------------------------------------------------------------

class FakeRequest:
    def __init__(self, **kw):
        self.model_id = kw.get("model_id", "m1")
        self.prompt_lengths = sorted(kw.get("prompt_lengths", [1024]))
        self.batch_sizes = sorted(kw.get("batch_sizes", []))
        self.generation_length = kw.get("generation_length", 128)
        self.context_profile = types.SimpleNamespace(value="code_python")
        self.force_lm_engine = kw.get("force_lm_engine", False)
        self.external = kw.get("external")


class FakeRun:
    def __init__(self, bench_id, request):
        self.bench_id = bench_id
        self.request = request
        self.status = "running"
        self.events: list[dict] = []
        self.cond = asyncio.Condition()
        self.terminal = False
        self.task = None
        self.results: list[dict] = []
        self.error_message = ""
        self.feature_flags: list[dict] = []
        self.upload_state = {"phase": "idle", "skipped_reason": None,
                             "results": [], "success": 0, "failed": 0}


class FakeBenchmarkModule(types.ModuleType):
    def __init__(self):
        super().__init__("omlx.admin.benchmark")
        self.runs: dict[str, FakeRun] = {}
        self._n = 0
        self.upload_calls: list[str] = []
        self.run_benchmark_calls = 0

    # --- public surface used by bench_engine ---
    def BenchmarkRequest(self, **kw):  # noqa: N802 (mirrors pydantic model)
        if kw.get("_raise"):
            raise ValueError("bad fields")
        return FakeRequest(**kw)

    def get_run(self, bench_id):
        return self.runs.get(bench_id)

    def get_active_run(self):
        for r in self.runs.values():
            if r.status == "running":
                return r
        return None

    def create_run(self, request):
        self._n += 1
        run = FakeRun(f"bench-fake{self._n}", request)
        self.runs[run.bench_id] = run
        return run

    def cleanup_old_runs(self, max_runs: int = 10):
        pass

    async def _send_event(self, run, event):
        run.events.append(event)
        if event.get("type") in ("upload_done", "upload_skipped", "error"):
            run.terminal = True
        async with run.cond:
            run.cond.notify_all()

    async def run_benchmark(self, run, pool):
        self.run_benchmark_calls += 1
        await self._send_event(run, {"type": "progress", "phase": "single",
                                     "current": 1, "total": 1})
        run.results.append({"test_type": "single", "pp": 1024, "tg": 128,
                            "gen_tps": 42.0, "processing_tps": 1000.0})
        await self._send_event(run, {"type": "result", "data": run.results[-1]})
        run.status = "completed"
        await self._send_event(run, {"type": "done", "summary": {}})
        # classic ALWAYS calls the module attribute for upload:
        await self._upload_to_omlx_ai(run, pool)

    async def _upload_to_omlx_ai(self, run, pool):
        # the REAL function POSTs to omlx.ai; the fake records the call so
        # tests can prove the opt-out swapped it out of the window
        self.upload_calls.append(run.bench_id)
        run.upload_state["phase"] = "done"
        await self._send_event(run, {"type": "upload_done", "data": {}})


@pytest.fixture()
def fake_bench(monkeypatch):
    mod = FakeBenchmarkModule()
    ctx = types.ModuleType("omlx.admin.context_benchmark")
    ctx.get_active_run = lambda: None
    ane = types.ModuleType("omlx.admin.ane_tuning")
    ane.get_active_run = lambda: None
    # Snapshot EVERY omlx module we touch — leaving a fake 'omlx' or
    # 'omlx.admin' behind in a shared pytest process poisons any LATER
    # import of the real package (observed: base.py's try/except import
    # fell to the viewer placeholder, whose request-less-annotated
    # require_admin made FastAPI demand ?request= -> every POST 422).
    names = ["omlx", "omlx.admin", "omlx.admin.benchmark",
             "omlx.admin.context_benchmark", "omlx.admin.ane_tuning"]
    saved = {n: sys.modules.get(n) for n in names}
    if saved["omlx"] is None:
        sys.modules["omlx"] = types.ModuleType("omlx")
    if saved["omlx.admin"] is None:
        sys.modules["omlx.admin"] = types.ModuleType("omlx.admin")
    sys.modules["omlx.admin"].benchmark = mod  # type: ignore[attr-defined]
    sys.modules["omlx.admin.benchmark"] = mod
    sys.modules["omlx.admin.context_benchmark"] = ctx
    sys.modules["omlx.admin.ane_tuning"] = ane
    try:
        yield mod
    finally:
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v


class FakePool:
    def __init__(self, entries=None):
        self.entries = entries if entries is not None else {"m1": types.SimpleNamespace(model_type="llm")}

    def get_entry(self, model_id):
        return self.entries.get(model_id)


def _engine_mod():
    from omlx_uplift import bench_engine
    import importlib
    return importlib.reload(bench_engine)


# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_start_completes_and_skips_upload_by_default(fake_bench):
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    assert out["status"] == "started" and out["upload"] is False
    await asyncio.wait_for(out_task(out, fake_bench), 2)
    run = fake_bench.get_run(out["bench_id"])
    assert run.status == "completed"
    # THE acceptance line: classic's upload path was NEVER entered
    assert fake_bench.upload_calls == []
    assert run.upload_state["phase"] == "skipped"
    assert run.upload_state["skipped_reason"] == "uplift_opt_out"
    types_ = [e["type"] for e in run.events]
    assert types_[-1] == "upload_skipped" and run.terminal


@pytest.mark.asyncio
async def test_start_upload_opt_in_runs_classic_path(fake_bench):
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), upload=True)
    await asyncio.wait_for(out_task(out, fake_bench), 2)
    run = fake_bench.get_run(out["bench_id"])
    assert fake_bench.upload_calls == [run.bench_id]
    assert run.upload_state["phase"] == "done"


@pytest.mark.asyncio
async def test_upload_restored_after_window(fake_bench):
    be = _engine_mod()
    orig = fake_bench._upload_to_omlx_ai
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    await asyncio.wait_for(out_task(out, fake_bench), 2)
    assert fake_bench._upload_to_omlx_ai.__func__ is orig.__func__


@pytest.mark.asyncio
async def test_contention_409(fake_bench):
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    with pytest.raises(be.Conflict):
        await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    await asyncio.wait_for(out_task(out, fake_bench), 2)


@pytest.mark.asyncio
async def test_validation_errors(fake_bench):
    be = _engine_mod()
    with pytest.raises(be.NotFound):
        await be.start({"model_id": "ghost"}, FakePool())
    with pytest.raises(be.BadInput):
        await be.start({"model_id": "m1", "_raise": True}, FakePool())
    emb = FakePool(entries={"e1": types.SimpleNamespace(model_type="embedding")})
    with pytest.raises(be.BadInput):
        await be.start({"model_id": "e1"}, emb)


@pytest.mark.asyncio
async def test_external_never_uploads_even_when_asked(fake_bench):
    be = _engine_mod()
    body = {"model_id": "remote-1", "prompt_lengths": [1024],
            "external": {"base_url": "http://x/v1", "api_key": "", "model": "r"}}
    out = await be.start(body, FakePool(), upload=True)
    await asyncio.wait_for(out_task(out, fake_bench), 2)
    assert fake_bench.upload_calls == []


@pytest.mark.asyncio
async def test_sse_replay_after_disconnect(fake_bench):
    """Port of classic's pinned delivery model to OUR reader: a stream that
    attaches AFTER events exist replays them all, then closes on terminal."""
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    await asyncio.wait_for(out_task(out, fake_bench), 2)
    run = fake_bench.get_run(out["bench_id"])
    got = [chunk async for chunk in be.event_stream(run)]
    import json
    events = [json.loads(c.removeprefix("data: ").strip())
              for c in got if c.startswith("data:")]
    types_ = [e["type"] for e in events]
    terminal = types_[-1]
    assert types_[:3] == ["progress", "result", "done"]
    assert terminal in ("upload_done", "upload_skipped")


def out_task(out, fake_bench):
    run = fake_bench.get_run(out["bench_id"])
    return run.task


# ---------------------------------------------------------------------------
# route layer: no engine pool -> 503; admin gate present on every route
# ---------------------------------------------------------------------------

def test_routes_require_admin_and_start_without_pool():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base

    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    client = TestClient(app)

    # admin gate pinned by Depends GRAPH, not by an HTTP code: on a
    # machine without omlx (CI) base.require_admin is the standalone-
    # viewer placeholder and FastAPI answers 422/500, not 401 — the
    # 401 belongs to omlx.auth and is dev-box-only behavior. The graph
    # assertion holds everywhere: the route WILL consult the gate.
    def _dep_names(route):
        out, stack = set(), [route.dependant]
        while stack:
            d = stack.pop()
            fn = getattr(d, "call", None)
            if fn is not None:
                out.add(getattr(fn, "__name__", ""))
            stack.extend(d.dependencies)
        return out

    for route in app.routes:
        if getattr(route, "path", "").startswith("/uplift/api/bench/"):
            assert "require_admin" in _dep_names(route), route.path

    app.dependency_overrides[up_base.require_admin] = lambda: True
    import omlx_uplift.bench_engine as be
    orig_pool = up_base.engine_pool
    up_base.engine_pool = lambda: None
    try:
        r = client.post("/uplift/api/bench/start", json={})
        assert r.status_code == 503
    finally:
        up_base.engine_pool = orig_pool
