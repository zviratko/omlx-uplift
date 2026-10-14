"""REPL-4c follow-up: lease protocol regression proof.

The live drill caught a `__aenter` typo (AttributeError) AND a leak in
the failure path: calling __aexit__ on a never-entered async CM resumes
the generator (loads the model!), then raises "generator didn't stop"
and leaks the lease. Both are pinned here with a fake server seam — no
GPU, no model, CI-safe.
"""
from __future__ import annotations

import pytest

from omlx_uplift import decision_engine as de


class RecordingCM:
    def __init__(self, engine=None, enter_error=None):
        self.engine = engine
        self.enter_error = enter_error
        self.entered = 0
        self.exited = 0

    async def __aenter__(self):
        self.entered += 1
        if self.enter_error:
            raise self.enter_error
        return self.engine

    async def __aexit__(self, *exc):
        self.exited += 1
        return False


class _FakeEngine:
    async def encode(self, request, truncate=True):
        return {"request": request}

    async def systemone(self, plan):
        req = plan["request"]
        answers = {qid: ({"type": "choice", "choice": "a"}
                         if q["type"] == "choice"
                         else {"type": "noul", "noul": 0.5})
                   for qid, q in req["questions"].items()}
        return {"answers": answers, "usage": {"input_tokens": 5}}


def _patch_lease(monkeypatch, cm):
    # the module-level seam keeps this CI-safe: no real omlx lease needed
    monkeypatch.setattr(de, "_lease", lambda model_id: cm)


def _patch_lease_for(monkeypatch, cm):
    """The runner's actual seam after the path split: it dispatches on
    run.path, so a test hands it the CM for whichever path it exercises."""
    monkeypatch.setattr(de, "_lease_for", lambda model_id, path: cm)


@pytest.mark.asyncio
async def test_runner_enters_and_releases_exactly_once(monkeypatch, tmp_path):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    cm = RecordingCM(engine=_FakeEngine())
    _patch_lease(monkeypatch, cm)
    run = de.DecisionRun("sys1-proto", "fake", ["arc-choice"], limit=1)
    await de._runner(run)
    assert run.status == "completed", run.error_message
    assert cm.entered == 1 and cm.exited == 1


@pytest.mark.asyncio
async def test_enter_failure_never_calls_aexit(monkeypatch, tmp_path):
    """__aexit__ on a never-entered CM would LOAD the engine and leak."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    cm = RecordingCM(enter_error=RuntimeError("pool says no"))
    _patch_lease(monkeypatch, cm)
    run = de.DecisionRun("sys1-proto2", "fake", ["arc-choice"], limit=1)
    await de._runner(run)
    assert run.status == "failed"
    assert "pool says no" in run.error_message
    assert cm.entered == 1
    assert cm.exited == 0, "must NOT release a lease that was never taken"


@pytest.mark.asyncio
async def test_task_cancel_reaches_terminal_state_and_releases(monkeypatch,
                                                                tmp_path):
    """The live cancel drill caught task.cancel() slipping past
    `except Exception` (CancelledError is BaseException in 3.8+): the run
    stayed 'running', sent no terminal event, and locked the UI forever."""
    import asyncio
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)

    class HangEngine(_FakeEngine):
        async def systemone(self, plan):
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    cm = RecordingCM(engine=HangEngine())
    _patch_lease(monkeypatch, cm)
    run = de.DecisionRun("sys1-proto3", "fake", ["arc-choice"], limit=0)
    task = asyncio.create_task(de._runner(run))
    await asyncio.sleep(0.3)              # inside the first systemone
    task.cancel()
    await task                            # must NOT re-raise to the caller
    assert run.terminal is True
    assert run.status == "cancelled"
    assert run.error_message == "Benchmark cancelled by user"
    types = [e.get("type") for e in run.events]
    assert "error" in types, "terminal event must reach SSE subscribers"
    assert cm.exited == 1, "cancelled run still releases its lease exactly once"
    assert run.results == [], "a cancelled pack is never persisted"


def _serving_server_py():
    """Resolve omlx/server.py from a checkout that can actually be READ —
    not from an importable venv. SYNC-1 2026-10-13: this guard used to
    import omlx.server, which broke two ways: the dev venv's editable
    ~/git/omlx drifted stale (phantom 'seam removed'), then a fresh pull
    failed to IMPORT on an unrelated mlx_vlm dependency gap. The question
    here is the lease API's TEXT shape, so read the file the server ships:
    newest installed keg first (that is what runs), then the upstream
    mirror. None found -> None -> test skips loudly-by-absence like CI."""
    import glob as _glob
    import os as _os
    cands = sorted(_glob.glob("/opt/homebrew/Cellar/omlx*/**/site-packages/"
                              "omlx/server.py", recursive=True),
                   key=_os.path.getmtime)
    mirror = _os.path.expanduser("~/git/omlx-upstream/omlx/server.py")
    if _os.path.exists(mirror):
        cands.append(mirror)
    for path in reversed(cands):          # newest keg wins
        if _os.path.exists(path):
            return path
    return None


def _tip_server_py():
    """The upstream MIRROR checkout (not the installed keg): the generic
    /v1/decisions seam only exists in a git checkout until the keg bumps.
    None when no mirror is readable — the tip assertions then skip, the
    installed-shape assertions above still run."""
    import os as _os
    path = _os.path.expanduser("~/git/omlx-upstream/omlx/server.py")
    return path if _os.path.exists(path) else None


class _ChatSeam:
    """Fake omlx.server for _lease_chat shape checks (same trick as the
    native seam below: sys.modules swap, restored in the finally)."""

    def __init__(self):
        import sys
        import types
        self.saved = {}
        self.sys = sys
        self.pkg = types.ModuleType("omlx")
        self.mod = types.ModuleType("omlx.server")
        self.leases = []          # every _LLMEngineLease ever created
        self.releases = []        # every release() ever awaited

        outer = self

        class _Lease:
            def __init__(self):
                self.model_id = None
                self.released = 0
                outer.leases.append(self)

            async def release(self):
                self.released += 1
                outer.releases.append(self)

        self.Lease = _Lease
        self.pkg.server = self.mod

    def install(self, get_engine_for_model):
        self.mod._LLMEngineLease = self.Lease
        self.mod.get_engine_for_model = get_engine_for_model
        for name, mod in (("omlx", self.pkg), ("omlx.server", self.mod)):
            self.saved[name] = self.sys.modules.get(name)
            self.sys.modules[name] = mod
        return self

    def restore(self):
        for name, prev in self.saved.items():
            if prev is not None:
                self.sys.modules[name] = prev
            else:
                self.sys.modules.pop(name, None)


@pytest.mark.asyncio
async def test_chat_lease_releases_exactly_once_on_success():
    """_lease_chat mirrors create_decisions' else-arm lease: fresh
    _LLMEngineLease, get_engine_for_model(model, lease=lease) (KEYWORD —
    positional 2nd arg does not exist), release in the finally."""
    seen = {}

    async def get_engine(model, *, lease=None):
        seen["model"] = model
        seen["lease"] = lease
        lease.model_id = model
        return "ENGINE"

    seam = _ChatSeam().install(get_engine)
    try:
        cm = de._lease_chat("qwen-chat")
        engine = await cm.__aenter__()
        assert engine == "ENGINE"
        assert seen == {"model": "qwen-chat", "lease": seam.leases[0]}
        assert seam.releases == []                # still holding the engine
        await cm.__aexit__(None, None, None)
    finally:
        seam.restore()
    assert len(seam.leases) == 1
    assert seam.leases[0].released == 1           # exactly once
    assert [id(x) for x in seam.releases] == [id(seam.leases[0])]


@pytest.mark.asyncio
async def test_chat_lease_failed_enter_still_releases_once():
    """get_engine_for_model raising must NOT leak: the generator's finally
    releases the never-taken lease once (model_id None -> no-op upstream),
    __aenter__ propagates, and the closed generator cannot release twice
    when _runner skips __aexit__."""
    async def no_engine(model, *, lease=None):
        raise RuntimeError("pool says no")

    seam = _ChatSeam().install(no_engine)
    try:
        cm = de._lease_chat("qwen-chat")
        with pytest.raises(RuntimeError, match="pool says no"):
            await cm.__aenter__()
        assert len(seam.leases) == 1
        assert seam.leases[0].released == 1
        assert seam.leases[0].model_id is None    # never actually taken
    finally:
        seam.restore()


def test_lease_for_routes_by_path(monkeypatch):
    """One seam, dispatched on run.path — the runner's only path branch."""
    calls = []

    def fake_native(model_id):
        calls.append(("native", model_id))
        return "N"

    def fake_chat(model_id):
        calls.append(("generic", model_id))
        return "G"

    monkeypatch.setattr(de, "_lease", fake_native)
    monkeypatch.setattr(de, "_lease_chat", fake_chat)
    assert de._lease_for("m", de.PATH_NATIVE) == "N"
    assert de._lease_for("m", de.PATH_GENERIC) == "G"
    assert de._lease_for("m", "anything-else") == "N"   # default = native
    assert calls == [("native", "m"), ("generic", "m"), ("native", "m")]


async def _fake_generic_decide(engine, request):
    """Generic-path stand-in for _decide_generic: the lease tests are about
    the LEASE, and the installed keg has no omlx.api.decisions to call."""
    qs = request["questions"]
    answers = []
    for q in qs:
        if q["type"] == "choice":
            answers.append({"type": "choice", "name": q["name"],
                            "choice": q["choices"][0]["value"]})
        else:
            answers.append({"type": "predicate", "name": q["name"],
                            "probability": 0.9})
    return {"answers": answers, "input_tokens": 3, "cached_tokens": 1}


@pytest.mark.asyncio
async def test_generic_runner_uses_chat_lease_and_releases_once(monkeypatch,
                                                                tmp_path):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    monkeypatch.setattr(de, "_preprobe_letter_tokens", lambda engine: None)
    monkeypatch.setattr(de, "_decide_generic", _fake_generic_decide)
    monkeypatch.setattr(de, "_lease",
                        lambda m: pytest.fail("native lease must not be used"))
    cm = RecordingCM(engine=_FakeEngine())
    monkeypatch.setattr(de, "_lease_chat", lambda m: cm)
    run = de.DecisionRun("sys1-chat", "qwen-chat", ["arc-choice"], 1,
                         path="generic")
    await de._runner(run)
    assert run.status == "completed", run.error_message
    assert cm.entered == 1 and cm.exited == 1
    assert run.results[0]["engine"] == "decisions"


@pytest.mark.asyncio
async def test_generic_runner_enter_failure_never_calls_aexit(monkeypatch,
                                                             tmp_path):
    """Symmetric to the native pin: __aexit__ on a never-entered chat CM
    would LOAD the model and leak the lease."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    monkeypatch.setattr(de, "_preprobe_letter_tokens", lambda engine: None)
    cm = RecordingCM(enter_error=RuntimeError("chat pool says no"))
    monkeypatch.setattr(de, "_lease_chat", lambda m: cm)
    run = de.DecisionRun("sys1-chat2", "qwen-chat", ["arc-choice"], 1,
                         path="generic")
    await de._runner(run)
    assert run.status == "failed"
    assert "chat pool says no" in run.error_message
    assert cm.entered == 1
    assert cm.exited == 0, "must NOT release a lease that was never taken"


def test_lease_seam_matches_installed_omlx_shape():
    """Drift guard — the LIVE shape, not the mock.

    REPL-4c guessed `omlx.server.acquire_decision_engine` (mirroring
    acquire_embedding/reranker_engine); it never existed upstream and the
    mocked seam above kept the suite green until a live bench run died with
    AttributeError. This pins that _lease()'s expected API exists in the
    serving/installed source text, AND (DEC-bench generic) that the chat
    seam _lease_chat() mirrors is real in the upstream tip checkout:
    `get_engine_for_model` + the `omlx/api/decisions.py` module the
    in-process call imports. CI (no keg, no mirror) skips."""
    path = _serving_server_py()
    if path is None:
        pytest.skip("no readable omlx source (keg or ~/git/omlx-upstream)")
    src = open(path, encoding="utf-8").read()

    has_helper = "def acquire_decision_engine" in src
    has_object_lease = ("async def get_decision_engine" in src
                        and "class _LLMEngineLease" in src)
    assert has_helper or has_object_lease, (
        f"omlx.server changed the decision lease shape again in {path} — "
        "adapt _lease()")

    # --- tip mirror: the generic /v1/decisions seam (skip-safe: an absent
    # checkout says nothing about the code, only that we cannot read it) ---
    tip = _tip_server_py()
    if tip is not None:
        import os as _os
        tip_src = open(tip, encoding="utf-8").read()
        # _lease_chat's call: `await get_engine_for_model(model, lease=lease)`
        assert "async def get_engine_for_model" in tip_src, (
            f"{tip} no longer defines get_engine_for_model — _lease_chat "
            "must follow the rename")
        assert "lease=lease" in tip_src, (
            "create_decisions stopped passing lease= by keyword — check "
            "_lease_chat's call shape")
        # the module _decide_generic imports, and the hook it needs
        decisions_py = _os.path.join(_os.path.dirname(tip), "api",
                                     "decisions.py")
        assert _os.path.exists(decisions_py), (
            "upstream tip lost omlx/api/decisions.py — the generic bench "
            "path (decisions_capability / _decide_generic) is dead code")
        dsrc = open(decisions_py, encoding="utf-8").read()
        assert "async def decide(" in dsrc
        assert "letter_token_ids" in dsrc      # the pre-probe mirrors this
        req_py = _os.path.join(_os.path.dirname(tip), "request.py")
        if _os.path.exists(req_py):
            assert "logits_observer" in open(req_py, encoding="utf-8").read(),\
                ("SamplingParams no longer carries logits_observer: "
                 "decisions_capability() must stop claiming the feature works")

    # _lease()'s adapter logic, pinned without importing the real runtime
    # (the dev venv may not satisfy omlx's heavy deps — the shape question
    # is answered by the source text above): stub the seam the shape says
    # exists and require a never-entered async CM back.
    import sys
    import types

    fake_pkg = types.ModuleType("omlx")
    fake = types.ModuleType("omlx.server")

    class _Lease:
        async def release(self):
            pass

    async def get_decision_engine(model, lease):  # noqa: ARG001
        raise AssertionError("must not be entered by the shape check")

    fake._LLMEngineLease = _Lease
    fake.get_decision_engine = get_decision_engine
    fake_pkg.server = fake
    saved = {k: sys.modules.get(k) for k in ("omlx", "omlx.server")}
    sys.modules["omlx"] = fake_pkg
    sys.modules["omlx.server"] = fake
    try:
        cm = de._lease("seam-shape-check-not-entered")
    finally:
        for k, v in saved.items():
            if v is not None:
                sys.modules[k] = v
            else:
                sys.modules.pop(k, None)
    assert hasattr(cm, "__aenter__") and hasattr(cm, "__aexit__")


def test_chat_lease_seam_shape_from_stub_server():
    """_lease_chat's adapter, same discipline as the native shape check
    above: it must hand get_engine_for_model a lease= keyword and return a
    never-entered async CM (no model load at call time)."""
    import sys
    import types

    calls = {}

    fake_pkg = types.ModuleType("omlx")
    fake = types.ModuleType("omlx.server")

    class _Lease:
        async def release(self):
            calls["released"] = calls.get("released", 0) + 1

    async def get_engine_for_model(model=None, *, lease=None):   # noqa: ARG001
        raise AssertionError("must not be entered by the shape check")

    fake._LLMEngineLease = _Lease
    fake.get_engine_for_model = get_engine_for_model
    fake_pkg.server = fake
    saved = {k: sys.modules.get(k) for k in ("omlx", "omlx.server")}
    sys.modules["omlx"] = fake_pkg
    sys.modules["omlx.server"] = fake
    try:
        cm = de._lease_chat("seam-shape-check-not-entered")
    finally:
        for k, v in saved.items():
            if v is not None:
                sys.modules[k] = v
            else:
                sys.modules.pop(k, None)
    assert hasattr(cm, "__aenter__") and hasattr(cm, "__aexit__")
    assert calls == {}      # nothing acquired or released by building the CM
