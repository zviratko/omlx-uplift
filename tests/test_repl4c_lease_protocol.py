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


def test_lease_seam_matches_installed_omlx_shape():
    """Drift guard — the LIVE shape, not the mock.

    REPL-4c guessed `omlx.server.acquire_decision_engine` (mirroring
    acquire_embedding/reranker_engine); it never existed upstream and the
    mocked seam above kept the suite green until a live bench run died with
    AttributeError. This pins that _lease()'s expected API exists in the
    serving/installed source text. CI (no keg, no mirror) skips."""
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
