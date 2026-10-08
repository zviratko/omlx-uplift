"""U66: bench engines must be visible in server.log.

A decision/embed run used to log NOTHING on the happy path (only two
failure warnings), so even at TRACE the server showed no sign a benchmark
was running — the user read silence as a dead feature. Pin the house
pattern: INFO per scored pack + TRACE heartbeat per item.
"""
import logging
import pytest

from omlx_uplift import decision_engine as de


class FakeEngine:
    async def encode(self, request, truncate=True):
        return {"request": request}

    async def systemone(self, plan):
        req = plan["request"]
        answers = {}
        for qid, q in req["questions"].items():
            answers[qid] = ({"type": "choice", "choice": "a"}
                            if q["type"] == "choice"
                            else {"type": "noul", "noul": 0.9})
        return {"answers": answers, "usage": {"input_tokens": 10}}


@pytest.mark.asyncio
async def test_decision_pack_logs_info_and_trace(monkeypatch, tmp_path, caplog):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    run = de.DecisionRun("sys1-log", "fake-model", ["arc-choice"], limit=2)
    with caplog.at_level(logging.TRACE if hasattr(logging, "TRACE") else 5,
                         logger="omlx.uplift.decision"):
        await de._run_pack(run, FakeEngine(), "arc-choice",
                           ValueError, KeyError)
    infos = [r.getMessage() for r in caplog.records
             if r.levelno == logging.INFO and "sys1-log" in r.getMessage()]
    traces = [r for r in caplog.records
              if r.levelno == 5 and "sys1-log" in r.getMessage()]
    assert any("pack arc-choice" in m and "2 scored" in m for m in infos), infos
    # TRACE heartbeat: exactly one line per item (limit=2)
    assert len(traces) == 2, [r.getMessage() for r in traces]


@pytest.mark.asyncio
async def test_decision_start_and_finish_log(monkeypatch, tmp_path, caplog):
    """start() INFO + runner finish INFO on the happy path (fake lease)."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    monkeypatch.setattr(de, "_check_decision_model", lambda m: None)
    monkeypatch.setattr(de, "_lease", lambda m: _ok_cm(FakeEngine()))
    with caplog.at_level(logging.INFO, logger="omlx.uplift.decision"):
        out = await de.start({"model_id": "fake-model",
                              "packs": ["arc-choice"], "limit": 1})
        await de._active.task
    msgs = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert any("started: " + out["run_id"] in m for m in msgs), msgs
    assert any("completed: " + out["run_id"] in m for m in msgs), msgs
    monkeypatch.setattr(de, "_active", None)


@pytest.mark.asyncio
async def test_decision_cancelled_logs(monkeypatch, tmp_path, caplog):
    """Cancelled pre-work: the runner still tells the log (not silence)."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    monkeypatch.setattr(de, "_lease", lambda m: _ok_cm(FakeEngine()))
    run = de.DecisionRun("sys1-cancel", "fake-model", ["arc-choice"], 0)
    run.cancelled = True
    with caplog.at_level(logging.INFO, logger="omlx.uplift.decision"):
        await de._runner(run)
    assert any("cancelled: sys1-cancel" in r.getMessage()
               for r in caplog.records if r.levelno == logging.INFO)


class _ok_cm:
    def __init__(self, eng):
        self.eng = eng

    async def __aenter__(self):
        return self.eng

    async def __aexit__(self, *a):
        return False
