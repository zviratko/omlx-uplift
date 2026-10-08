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
