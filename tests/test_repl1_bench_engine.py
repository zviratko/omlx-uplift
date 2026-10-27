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
from pathlib import Path

import asyncio
import sys
import types
import pytest


# ---------------------------------------------------------------------------
# fake classic benchmark module (module-level API surface we depend on)
# ---------------------------------------------------------------------------

class FakeRequest:
    def __init__(self, **kw):
        self.kw = dict(kw)  # the exact kwargs the CLASSIC model received
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
    # U64: run-task done callbacks now snapshot into the REAL store dir;
    # pin it to the test tmp_path like the embed/decision fixtures do, or
    # fake ids leak into ~/.omlx/uplift/bench-history (observed)
    import tempfile
    from omlx_uplift import paths as _paths
    _tmp = Path(tempfile.mkdtemp(prefix='u64-store-'))
    monkeypatch.setattr(_paths, "uplift_store_dir", lambda: _tmp)
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
# cache-off flags: fake seam (omlx.admin.routes) + fake live server state
# ---------------------------------------------------------------------------

class SeamRecorder:
    """Fake omlx.admin.routes._apply_cache_settings_runtime in the shape
    upstream ships SINCE 28f50bb: (enabled, global_settings,
    hot_cache_max_size) — the ssd_cache_dir / ssd_cache_max_size keywords
    came OUT of the signature and the seam reads them from settings now.

    The parameter list is REAL on purpose, not **kwargs: bench_engine must
    send exactly what the installed seam accepts. The pre-28f50bb fake kept
    the old keyword surface, so the suite stayed green while a live keg 409'd
    with 'unexpected keyword argument ssd_cache_dir' — this class is what
    keeps that from happening again (see also the installed-signature guard
    further down). Records every call, can be pinned to fail
    ((ok=False, msg) or an exception) or to hang from a call index on
    (cancel-survival proof). context() is a test-supplied probe of engine
    state AT CALL TIME (proves apply-after-claim / before-task ordering)."""

    SHAPE = ("enabled", "global_settings", "hot_cache_max_size")

    def __init__(self):
        self.calls: list[dict] = []
        self.result = (True, "ok")     # Exception instance => raise instead
        self.hang = None               # asyncio.Event the seam waits on...
        self.hang_from = None          # ... once this many calls happened
        self.context = lambda: None

    async def __call__(self, *, enabled, global_settings,
                       hot_cache_max_size=None):
        return await self._record(
            {"enabled": enabled, "global_settings": global_settings,
             "hot_cache_max_size": hot_cache_max_size}, global_settings)

    async def _record(self, sent, gs):
        self.calls.append({**sent,
                           "hot_cache_only": gs.cache.hot_cache_only,
                           "cache_enabled": gs.cache.enabled,
                           "context": self.context()})
        if isinstance(self.result, Exception):
            raise self.result
        if self.hang is not None and (self.hang_from is None
                                      or len(self.calls) > self.hang_from):
            await self.hang.wait()
        return self.result


def sent_keys(call):
    """Only the keywords the adapter actually passed (probes excluded)."""
    return {k for k in call} - {"hot_cache_only", "cache_enabled", "context"}


class LegacySeamRecorder(SeamRecorder):
    """The same seam as it was BEFORE upstream 28f50bb — it still demanded
    ssd_cache_dir / ssd_cache_max_size. Exists so an older keg stays provably
    working: the adapter must send those two keywords here and NOT send them
    to the modern shape above."""

    SHAPE = ("enabled", "ssd_cache_dir", "ssd_cache_max_size",
             "global_settings", "hot_cache_max_size")

    async def __call__(self, *, enabled, ssd_cache_dir, ssd_cache_max_size,
                       global_settings, hot_cache_max_size):
        return await self._record(
            {"enabled": enabled, "ssd_cache_dir": ssd_cache_dir,
             "ssd_cache_max_size": ssd_cache_max_size,
             "global_settings": global_settings,
             "hot_cache_max_size": hot_cache_max_size}, global_settings)


def _cache_env_gen(fake_bench, seam_cls):
    """Layer the seam + _server_state fakes on fake_bench, with the SAME
    snapshot/restore doctrine (no fake omlx modules leak out; works both
    on CI without omlx and on the dev box where the real package exists —
    sys.modules lookups win over the disk import either way)."""
    names = ["omlx.admin.routes", "omlx.server"]
    saved = {n: sys.modules.get(n) for n in names}
    seam = seam_cls()
    seam.context = lambda: len(fake_bench.runs)   # runs created at call time
    routes = types.ModuleType("omlx.admin.routes")
    routes._apply_cache_settings_runtime = seam
    server = types.ModuleType("omlx.server")
    gs = types.SimpleNamespace(cache=types.SimpleNamespace(
        enabled=True, hot_cache_only=False, hot_cache_max_size="8GB"))
    server._server_state = types.SimpleNamespace(global_settings=gs)
    prev = [(sys.modules["omlx.admin"], "routes",
             getattr(sys.modules["omlx.admin"], "routes", None)),
            (sys.modules["omlx"], "server",
             getattr(sys.modules["omlx"], "server", None))]
    sys.modules["omlx.admin.routes"] = routes
    setattr(sys.modules["omlx.admin"], "routes", routes)
    sys.modules["omlx.server"] = server
    setattr(sys.modules["omlx"], "server", server)
    try:
        yield types.SimpleNamespace(seam=seam, gs=gs)
    finally:
        for holder, attr, old in prev:
            if old is None:
                try:
                    delattr(holder, attr)
                except AttributeError:
                    pass
            else:
                setattr(holder, attr, old)
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v


@pytest.fixture()
def cache_env(fake_bench):
    yield from _cache_env_gen(fake_bench, SeamRecorder)


@pytest.fixture()
def legacy_cache_env(fake_bench):
    """Bench against a pre-28f50bb keg (the seam still wants ssd_*)."""
    yield from _cache_env_gen(fake_bench, LegacySeamRecorder)


async def _tick(n=3):
    """Let scheduled task steps run (cancel delivery, done callbacks)."""
    for _ in range(n):
        await asyncio.sleep(0)


# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cache_off_ssd_applied_before_task_and_restored_on_success(
        fake_bench, cache_env):
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_ssd_cache=True)
    seam = cache_env.seam
    # CLAIM-then-apply: create_run registers the run (status 'running' =
    # the active claim) BEFORE the await-heavy seam runs, so a concurrent
    # start can never slip past the active checks during the apply.
    assert len(seam.calls) == 1
    c0 = seam.calls[0]
    assert c0["hot_cache_only"] is True              # temp: vanilla 'Hot Cache Only'
    assert c0["hot_cache_max_size"] == "8GB"         # untouched field rides the live string
    assert c0["enabled"] is None                     # cache.enabled stays the server's
    # THE CALL SURFACE: exactly what this keg shape accepts. Upstream 28f50bb
    # dropped ssd_cache_dir / ssd_cache_max_size and sending them anyway is
    # what made a live bench start answer 409 with a TypeError.
    assert sent_keys(c0) == set(SeamRecorder.SHAPE)
    assert "ssd_cache_dir" not in c0 and "ssd_cache_max_size" not in c0
    assert c0["cache_enabled"] is True               # cache.enabled never touched
    assert c0["context"] == 1                        # applied AFTER the create_run claim
    assert fake_bench.get_active_run() is not None   # claim held across the apply
    assert fake_bench.run_benchmark_calls == 0       # ... and before the task ran
    run = fake_bench.get_run(out["bench_id"])
    assert run._uplift_cache_off == ["ssd"]
    await asyncio.wait_for(run.task, 2)
    # restore ran: live settings back to the snapshot, seam re-applied it
    assert cache_env.gs.cache.hot_cache_only is False
    assert seam.calls[-1]["hot_cache_only"] is False
    assert seam.calls[-1]["hot_cache_max_size"] == "8GB"


@pytest.mark.asyncio
async def test_cache_off_legacy_seam_still_gets_ssd_keywords(fake_bench,
                                                             legacy_cache_env):
    """A pre-28f50bb keg still DEMANDS ssd_cache_dir / ssd_cache_max_size, so
    the adapter has to send them there — trimming must follow the signature,
    not a hardcoded list, or the same drift breaks the older build the other
    way ('missing required keyword')."""
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_ssd_cache=True)
    seam = legacy_cache_env.seam
    c0 = seam.calls[0]
    assert sent_keys(c0) == set(LegacySeamRecorder.SHAPE)
    assert c0["ssd_cache_dir"] is None and c0["ssd_cache_max_size"] is None
    run = fake_bench.get_run(out["bench_id"])
    await asyncio.wait_for(run.task, 2)
    assert len(seam.calls) == 2                    # apply + restore
    assert sent_keys(seam.calls[-1]) == set(LegacySeamRecorder.SHAPE)


def _gs_stub(hot="8GB"):
    return types.SimpleNamespace(cache=types.SimpleNamespace(
        enabled=True, hot_cache_only=False, hot_cache_max_size=hot))


def test_cache_seam_kwargs_match_the_installed_seam_signature():
    """DRIFT GUARD against the real package (the fakes above can only prove
    the shape they themselves declare). Reads the parameters of the
    _apply_cache_settings_runtime this box actually ships and proves our call
    sends nothing it rejects and everything it requires. Signature probe only:
    no engine pool, no model load, no settings write. Skips on CI (no omlx).

    Why it exists: upstream 28f50bb dropped ssd_cache_dir/ssd_cache_max_size
    and every mocked test stayed green while a live bench start 409'd."""
    import inspect

    routes = pytest.importorskip("omlx.admin.routes")
    seam = getattr(routes, "_apply_cache_settings_runtime", None)
    if seam is None:
        pytest.skip("this omlx build has no runtime cache switch")
    be = _engine_mod()
    gs = _gs_stub()
    sent = be._seam_kwargs(seam, gs)
    params = inspect.signature(seam).parameters
    assert set(sent) <= set(params), f"sending keywords the seam drops: {set(sent) - set(params)}"
    assert {"enabled", "global_settings"} <= set(sent)
    for name, p in params.items():
        if (p.default is p.empty
                and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)):
            assert name in sent, f"installed seam requires '{name}' we do not send"
    assert sent["enabled"] is None
    assert sent["hot_cache_max_size"] == "8GB"


def test_cache_seam_kwargs_refuse_an_unmatchable_seam():
    """A seam whose required arguments this build cannot supply must fail as
    the honest Conflict the UI shows — not as a raw TypeError mid-start."""
    be = _engine_mod()

    async def odd_seam(enabled, global_settings, hot_cache_max_size,
                       brand_new_required):
        return True, "ok"

    with pytest.raises(be.Conflict) as e:
        be._seam_kwargs(odd_seam, _gs_stub())
    assert "brand_new_required" in str(e.value)


def test_cache_seam_kwargs_do_not_invent_names_for_a_var_keyword_seam():
    """**kwargs seams get the modern trio only — passing the retired ssd_*
    keys through a forwarder would hand them to something that never asked."""
    be = _engine_mod()

    async def open_seam(*args, **kwargs):
        return True, "ok"

    assert set(be._seam_kwargs(open_seam, _gs_stub())) == \
        {"enabled", "global_settings", "hot_cache_max_size"}


@pytest.mark.asyncio
async def test_cache_off_hot_flag_zeroes_max_size(fake_bench, cache_env):
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_hot_cache=True)
    c0 = cache_env.seam.calls[0]
    assert c0["hot_cache_max_size"] == "0"           # vanilla: '0' = hot off
    assert c0["hot_cache_only"] is False             # other field untouched
    run = fake_bench.get_run(out["bench_id"])
    assert run._uplift_cache_off == ["hot"]
    await asyncio.wait_for(run.task, 2)
    assert cache_env.gs.cache.hot_cache_max_size == "8GB"


@pytest.mark.asyncio
async def test_cache_off_both_flags(fake_bench, cache_env):
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_hot_cache=True, no_ssd_cache=True)
    c0 = cache_env.seam.calls[0]
    assert c0["hot_cache_max_size"] == "0" and c0["hot_cache_only"] is True
    run = fake_bench.get_run(out["bench_id"])
    assert run._uplift_cache_off == ["hot", "ssd"]
    await asyncio.wait_for(run.task, 2)
    assert (cache_env.gs.cache.hot_cache_only,
            cache_env.gs.cache.hot_cache_max_size) == (False, "8GB")
    assert len(cache_env.seam.calls) == 2


@pytest.mark.asyncio
async def test_cache_apply_failure_abandons_claim(fake_bench, cache_env):
    """CLAIM-then-apply makes failures leak-proof: a seam that refuses
    ((False,msg)) must rewind the live settings (no temp config leaks),
    leave NO active claim behind (an orphaned status='running' run would
    block every later bench forever), raise Conflict, spawn no task and
    not re-apply a restore for a toggle that never went live."""
    be = _engine_mod()
    cache_env.seam.result = (False, "engine pool busy")
    with pytest.raises(be.Conflict):
        await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                       FakePool(), no_ssd_cache=True)
    assert cache_env.gs.cache.hot_cache_only is False   # rewound
    assert fake_bench.get_active_run() is None          # claim abandoned
    runs = list(fake_bench.runs.values())
    assert len(runs) == 1 and runs[0].status == "error" and runs[0].task is None
    assert len(cache_env.seam.calls) == 1               # no second (restore) call
    # the abandoned claim must not block the NEXT start
    cache_env.seam.result = (True, "ok")
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    assert out["status"] == "started"
    await asyncio.wait_for(fake_bench.get_run(out["bench_id"]).task, 2)


@pytest.mark.asyncio
async def test_no_flags_never_probe_and_never_tag(fake_bench, cache_env):
    """Without flags NOTHING is imported/probed and no restore happens:
    with a seam that would raise on call, the plain run still starts and
    the attribute is absent (active_summary then reports cache_off [])."""
    be = _engine_mod()
    cache_env.seam.result = AssertionError("seam must not be called")
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]}, FakePool())
    summ = be.active_summary()
    assert summ["running"] and summ["cache_off"] == []
    run = fake_bench.get_run(out["bench_id"])
    assert not hasattr(run, "_uplift_cache_off")
    await asyncio.wait_for(run.task, 2)
    assert cache_env.seam.calls == []


@pytest.mark.asyncio
async def test_cache_off_summary_reports_active_flags(fake_bench, cache_env):
    be = _engine_mod()
    gate = asyncio.Event()

    async def hang(run, pool):
        await gate.wait()

    fake_bench.run_benchmark = hang
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_ssd_cache=True)
    assert be.active_summary()["cache_off"] == ["ssd"]
    gate.set()
    await asyncio.wait_for(fake_bench.get_run(out["bench_id"]).task, 2)


@pytest.mark.asyncio
async def test_route_pops_cache_flags_before_classic_request(
        fake_bench, cache_env, monkeypatch):
    """Full-chain pin: the route pops both keys (like upload) so the body
    reaching the classic BenchmarkRequest is flag-free, and the engine
    receives them as kwargs."""
    from omlx_uplift.routers import bench as bench_mod
    be = _engine_mod()
    calls = []
    real_start = be.start

    async def spy(body, pool, **kw):
        calls.append((dict(body), dict(kw)))
        return await real_start(body, pool, **kw)

    shim = types.SimpleNamespace(start=spy, Conflict=be.Conflict,
                                 NotFound=be.NotFound, BadInput=be.BadInput)
    monkeypatch.setattr(bench_mod, "bench_engine", shim)
    monkeypatch.setattr(bench_mod, "engine_pool", lambda: FakePool())

    async def _idle(kind):
        return None

    monkeypatch.setattr(bench_mod.bench_queue, "busy_check", _idle)

    async def _json():
        return {"model_id": "m1", "prompt_lengths": [1024],
                "no_hot_cache": True, "no_ssd_cache": True}

    out = await bench_mod.bench_start(types.SimpleNamespace(json=_json),
                                      is_admin=True)
    body, kw = calls[0]
    assert "upload" not in body and "no_hot_cache" not in body \
        and "no_ssd_cache" not in body
    assert kw == {"upload": False, "no_hot_cache": True, "no_ssd_cache": True}
    run = fake_bench.get_run(out["bench_id"])
    # the CLASSIC model never saw the uplift-only keys:
    assert set(run.request.kw) == {"model_id", "prompt_lengths"}
    assert run._uplift_cache_off == ["hot", "ssd"]
    await asyncio.wait_for(run.task, 2)


@pytest.mark.asyncio
async def test_cache_off_external_is_bad_input(fake_bench, cache_env):
    be = _engine_mod()
    body = {"model_id": "remote-1", "prompt_lengths": [1024],
            "external": {"base_url": "http://x/v1", "api_key": "",
                         "model": "r"}}
    with pytest.raises(be.BadInput, match="local models only"):
        await be.start(body, FakePool(), no_hot_cache=True)
    assert cache_env.seam.calls == []        # refused before probing/applying
    with pytest.raises(be.BadInput, match="local models only"):
        await be.start(body, FakePool(), no_ssd_cache=True)
    assert cache_env.seam.calls == []
    assert fake_bench.runs == {}


@pytest.mark.asyncio
async def test_cache_off_missing_seam_is_bad_input(fake_bench, monkeypatch):
    """CI/old-keg shape: the seam import fails -> clear 400, and WITHOUT
    flags nothing is probed at all (plain start still works)."""
    # a routes module WITHOUT the attribute: 'from ... import' raises
    # ImportError regardless of whether real omlx is installed here
    empty = types.ModuleType("omlx.admin.routes")
    monkeypatch.setitem(sys.modules, "omlx.admin.routes", empty)
    be = _engine_mod()
    with pytest.raises(be.BadInput, match="cannot toggle"):
        await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                       FakePool(), no_ssd_cache=True)
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool())
    await asyncio.wait_for(fake_bench.get_run(out["bench_id"]).task, 2)


@pytest.mark.asyncio
async def test_cache_apply_failure_restores_and_conflicts(fake_bench, cache_env):
    """(False, msg) AND a raising seam both pin to Conflict after the
    snapshot was rewound. CLAIM-then-apply: the registered run exists but
    is abandoned terminal ('error', no task, no active claim) — never a
    live 'running' orphan."""
    be = _engine_mod()
    cache_env.seam.result = (False, "Engine pool not initialized")
    with pytest.raises(be.Conflict, match="Could not toggle caches"):
        await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                       FakePool(), no_hot_cache=True)
    assert cache_env.gs.cache.hot_cache_max_size == "8GB"
    assert fake_bench.get_active_run() is None
    assert [r.status for r in fake_bench.runs.values()] == ["error"]

    cache_env.seam.result = RuntimeError("seam exploded")
    n_before = len(fake_bench.runs)
    with pytest.raises(be.Conflict, match="Could not toggle caches"):
        await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                       FakePool(), no_ssd_cache=True)
    assert cache_env.gs.cache.hot_cache_only is False
    assert fake_bench.get_active_run() is None
    assert len(fake_bench.runs) == n_before + 1
    assert list(fake_bench.runs.values())[-1].status == "error"


@pytest.mark.asyncio
async def test_cache_off_restored_on_cancel(fake_bench, cache_env):
    """The common early exit: cancel() kills the run task; the restore
    still runs and the seam receives the ORIGINAL values."""
    be = _engine_mod()
    gate = asyncio.Event()

    async def hang(run, pool):
        try:
            await gate.wait()
        finally:
            run.status = "cancelled"

    fake_bench.run_benchmark = hang
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_ssd_cache=True)
    run = fake_bench.get_run(out["bench_id"])
    await _tick()
    await be.cancel(run)
    with pytest.raises(asyncio.CancelledError):
        await run.task
    assert cache_env.gs.cache.hot_cache_only is False       # restored
    assert cache_env.seam.calls[-1]["hot_cache_only"] is False
    assert run._uplift_cache_off == ["ssd"]                 # history sees it


@pytest.mark.asyncio
async def test_cache_restore_survives_second_cancel(fake_bench, cache_env):
    """Provably await-safe: a SECOND cancel() landing while the restore
    seam call is mid-await does not abort it — the shielded pattern keeps
    waiting until the restore settles, then the task ends cancelled."""
    be = _engine_mod()
    gate = asyncio.Event()

    async def hang(run, pool):
        await gate.wait()

    fake_bench.run_benchmark = hang
    release = asyncio.Event()
    cache_env.seam.hang = release       # the restore (call index 1) blocks
    cache_env.seam.hang_from = 1
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_hot_cache=True)
    run = fake_bench.get_run(out["bench_id"])
    await _tick()
    run.task.cancel()                   # cancel #1: lands in gate.wait
    await _tick()
    assert len(cache_env.seam.calls) == 2       # restore call is in flight
    assert not run.task.done()                  # ... and still awaited
    run.task.cancel()                   # cancel #2: lands in the shielded await
    await _tick()
    assert not run.task.done()          # absorbed; restore not abandoned
    assert cache_env.gs.cache.hot_cache_max_size == "8GB"  # fields rewound
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await run.task
    assert cache_env.seam.calls[-1]["hot_cache_max_size"] == "8GB"


@pytest.mark.asyncio
async def test_history_meta_carries_cache_off(fake_bench, cache_env):
    """capture_run (via the run-task done callback) persists
    meta.cache_off only for flagged runs — the statics lane reads that."""
    from omlx_uplift import bench_history as bh
    be = _engine_mod()
    out = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                         FakePool(), no_hot_cache=True, no_ssd_cache=True)
    await asyncio.wait_for(fake_bench.get_run(out["bench_id"]).task, 2)
    await _tick()                        # let the done callback write
    entries = bh.load("throughput")
    assert len(entries) == 1 and entries[0]["id"] == out["bench_id"]
    assert entries[0]["meta"]["cache_off"] == ["hot", "ssd"]

    out2 = await be.start({"model_id": "m1", "prompt_lengths": [1024]},
                          FakePool())
    await asyncio.wait_for(fake_bench.get_run(out2["bench_id"]).task, 2)
    await _tick()
    e2 = next(e for e in bh.load("throughput") if e["id"] == out2["bench_id"])
    assert "cache_off" not in e2["meta"]


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
