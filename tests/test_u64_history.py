"""U64: bench run history — persistence + capture + reconcile."""
import json

import pytest

from omlx_uplift import bench_history as bh


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    return tmp_path


def _file(surface):
    return bh.root() / surface / "history.json"


class _Req:
    model_id = "m1"
    target_tokens = 131072


class _CtxRun:
    bench_id = "c-1"
    request = _Req()
    status = "completed"
    result = {"measured_tokens": 120000}


def test_upsert_idempotent_and_ordered():
    bh.upsert_run("context", {"id": "c-1", "status": "running", "rows": []})
    bh.upsert_run("context", {"id": "c-1", "status": "completed", "rows": [1]})
    bh.upsert_run("context", {"id": "c-2", "status": "completed", "rows": [2]})
    es = bh.entries("context")["entries"]
    assert [e["id"] for e in es] == ["c-1", "c-2"]
    assert es[0]["status"] == "completed"          # replace, not append
    assert json.loads(_file("context").read_text())[1]["rows"] == [2]


def test_capture_run_dispatch_by_shape():
    bh.capture_run(_CtxRun())
    es = bh.entries("context")["entries"]
    assert es and es[0]["model_id"] == "m1"
    assert es[0]["meta"]["target_tokens"] == 131072
    assert es[0]["rows"] == [{"measured_tokens": 120000}]


def test_capture_run_ane_carries_recommendation():
    class Req:
        model_id = "m2"
        sequence_length = 2048

    class AneRun:
        tuning_id = "a-1"
        request = Req()
        status = "completed"
        results = [{"split": "gpu", "state": "ok"}]
        recommendation = {"processing_tps": 900}

    bh.capture_run(AneRun())
    e = bh.entries("ane")["entries"][0]
    assert e["recommendation"]["processing_tps"] == 900
    assert e["rows"] == [{"split": "gpu", "state": "ok"}]


def test_capture_run_never_raises(capsys):
    class Bad:
        @property
        def request(self):
            raise RuntimeError("nope")

    bh.capture_run(Bad())          # swallow + warn, never explode a callback


def test_reconcile_labels_ghost_runs():
    bh.upsert_run("throughput", {"id": "t-1", "status": "running", "rows": []})
    bh.upsert_run("throughput", {"id": "t-2", "status": "completed", "rows": []})
    bh.reconcile_interrupted({})   # fresh process: no live runs
    es = {e["id"]: e["status"] for e in bh.entries("throughput")["entries"]}
    assert es == {"t-1": "interrupted", "t-2": "completed"}


def test_reconcile_spares_the_live_run():
    bh.upsert_run("throughput", {"id": "t-1", "status": "running", "rows": []})
    bh.reconcile_interrupted({"throughput": "t-1"})
    assert bh.entries("throughput")["entries"][0]["status"] == "running"


def test_clear_removes_file():
    bh.upsert_run("ane", {"id": "a-1", "status": "completed", "rows": []})
    assert bh.clear("ane")["removed"] is True
    assert bh.entries("ane")["entries"] == []
    assert bh.clear("ane")["removed"] is False


def test_corrupt_file_moved_aside_not_crash():
    f = _file("context")
    f.parent.mkdir(parents=True)
    f.write_text("{not json")
    assert bh.load("context") == []
    assert f.with_suffix(".corrupt").exists()


# ---- accuracy write-through/restore via the engine -------------------------

class FakeAB:
    def __init__(self):
        self._accum = []
        self.queue_status = {"running": False, "current_bench_id": None,
                             "current_model": None}

    def get_accumulated_results(self):
        return self._accum

    def get_queue_status(self):
        return self.queue_status

    def get_run(self, _bid):
        return None

    def reset_accumulated_results(self):
        self._accum.clear()


def test_accuracy_persist_restore_roundtrip(monkeypatch):
    from omlx_uplift import accuracy_engine as ae
    ab = FakeAB()
    ab._accum.append({"model_id": "m", "benchmark": "mmlu", "ts": 1,
                      "accuracy": 0.5, "total": 2, "correct": 1})
    monkeypatch.setattr(ae, "_acc", lambda: ab)
    monkeypatch.setattr(ae, "_acc_restored", False)
    monkeypatch.setattr(ae, "_disarm_upload_skip", lambda: None)
    out = ae.results_payload()          # write-through
    assert _file("accuracy").exists()
    # simulate restart: classic list empty, restore from disk
    ab2 = FakeAB()
    monkeypatch.setattr(ae, "_acc", lambda: ab2)
    monkeypatch.setattr(ae, "_acc_restored", False)
    monkeypatch.setattr(ae, "_acc_last_n", -1)
    out2 = ae.results_payload()
    assert out2["results"] == out["results"]
    # reset clears BOTH memories
    ae.results_reset()
    assert ab2._accum == []
    assert bh.entries("accuracy")["entries"] == []
