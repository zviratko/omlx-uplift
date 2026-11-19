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
    # the write-through guard is a module global; pin it or an earlier
    # test's row count makes this payload look unchanged (order-dependent)
    monkeypatch.setattr(ae, "_acc_last_n", -1)
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


# ---- BENCH-HIST-RACE (user report 2026-11-19): the history GET must not
# race the run task's done callback. Panels reload the list the moment the
# terminal SSE event arrives; the file was only written after engine unload
# and the cache/concurrency restores - seconds later. The route now sweeps
# terminal runs from the live registries before answering.


class _TpReq:
    model_id = "m1"
    external = None

    class context_profile:
        value = "code_python"


class _TpRun:
    bench_id = "t-9"
    status = "completed"
    request = _TpReq()
    results = [{"test_type": "single", "pp": 1024}]


class _RunReq:
    model_id = "m1"
    target_tokens = 65536
    sequence_length = 2048


class _CtxRun2:
    bench_id = "c-9"
    status = "completed"
    request = _RunReq()
    result = {"measured_tokens": 60000}


class _AneRun2:
    tuning_id = "a-9"
    status = "completed"
    request = _RunReq()
    results = [{"split": "gate", "state": "ANE"}]


def _fake_modules(runs_by_surface):
    """(bench_engine._engine, context_engine._ctx, context_engine._ane)
    stand-ins exposing only the registries the sweep reads."""
    import types
    tp = types.SimpleNamespace(_benchmark_runs=runs_by_surface.get("throughput", {}))
    ctx = types.SimpleNamespace(_context_runs=runs_by_surface.get("context", {}))
    ane = types.SimpleNamespace(_runs=runs_by_surface.get("ane", {}))
    return tp, ctx, ane


def _patch_engines(monkeypatch, tp, ctx, ane):
    from omlx_uplift import bench_engine, context_engine
    monkeypatch.setattr(bench_engine, "_engine", lambda: tp)
    monkeypatch.setattr(context_engine, "_ctx", lambda: ctx)
    monkeypatch.setattr(context_engine, "_ane", lambda: ane)


def _bench_routes():
    # facade FIRST: omlx_uplift/router.py fixes the domain import (route
    # registration) order - importing routers.bench cold would move the
    # /bench block and break test_nat3_scaffold's last-block pin
    # (same convention as test_about_route.py).
    from omlx_uplift import router as _up  # noqa: F401
    from omlx_uplift.routers import bench as br
    return br


def test_sweep_captures_terminal_runs_all_surfaces(monkeypatch):
    br = _bench_routes()
    tp, ctx, ane = _fake_modules({
        "throughput": {"t-9": _TpRun()},
        "context": {"c-9": _CtxRun2()},
        "ane": {"a-9": _AneRun2()},
    })
    _patch_engines(monkeypatch, tp, ctx, ane)
    br._sweep_terminal_runs("throughput")
    br._sweep_terminal_runs("context")
    br._sweep_terminal_runs("ane")
    assert bh.entries("throughput")["entries"][0]["id"] == "t-9"
    assert bh.entries("context")["entries"][0]["id"] == "c-9"
    assert bh.entries("ane")["entries"][0]["id"] == "a-9"


def test_sweep_skips_running_and_already_captured(monkeypatch):
    br = _bench_routes()

    class Running(_TpRun):
        bench_id = "t-live"
        status = "running"

    tp, ctx, ane = _fake_modules({"throughput": {"t-9": _TpRun(),
                                                 "t-live": Running()}})
    _patch_engines(monkeypatch, tp, ctx, ane)
    br._sweep_terminal_runs("throughput")
    ids = [e["id"] for e in bh.entries("throughput")["entries"]]
    assert ids == ["t-9"], "a still-running run must not enter history"
    calls = []
    import omlx_uplift.bench_history as bhmod
    real = bhmod.capture_run
    monkeypatch.setattr(bhmod, "capture_run",
                        lambda run: (calls.append(run), real(run))[1])
    br._sweep_terminal_runs("throughput")   # second GET after the same run
    br._sweep_terminal_runs("unknown")      # unknown surface: no-op
    assert calls == [], "captured runs are not re-upserted (ts must not churn)"


def test_sweep_never_raises_without_engine(monkeypatch):
    # CI shape: no omlx keg, _engine() explodes - the list must still answer
    br = _bench_routes()
    from omlx_uplift import bench_engine

    def boom():
        raise RuntimeError("omlx not found")

    monkeypatch.setattr(bench_engine, "_engine", boom)
    br._sweep_terminal_runs("throughput")
    assert bh.entries("throughput")["entries"] == []


@pytest.mark.asyncio
async def test_history_route_sweeps_before_answering(monkeypatch):
    # the route-level contract: the GET that a finishing panel fires already
    # lists that run - no page refresh needed
    br = _bench_routes()
    tp, ctx, ane = _fake_modules({"throughput": {"t-9": _TpRun()}})
    _patch_engines(monkeypatch, tp, ctx, ane)
    out = await br.bench_history_list("throughput", is_admin=True)
    assert [e["id"] for e in out["entries"]] == ["t-9"]


# ---- BENCH-HIST-CLEAR (user report 2026-11-19): clearing history must
#             stick - the live registries still hold the cleared runs ------


def test_clear_tombstones_and_sweep_does_not_resurrect(monkeypatch):
    from omlx_uplift.routers import bench as br
    tp, ctx, ane = _fake_modules({"throughput": {"t-9": _TpRun()}})
    _patch_engines(monkeypatch, tp, ctx, ane)
    br._sweep_terminal_runs("throughput")
    assert [e["id"] for e in bh.entries("throughput")["entries"]] == ["t-9"]
    bh.clear("throughput")
    assert bh.entries("throughput")["entries"] == []
    br._sweep_terminal_runs("throughput")   # the reload right after Clear
    assert bh.entries("throughput")["entries"] == [], \
        "a cleared run still in the registry must not come back"
    bh.capture_run(_TpRun())                # a late done callback either
    assert bh.entries("throughput")["entries"] == []


def test_clear_then_a_new_run_is_captured_normally(monkeypatch):
    from omlx_uplift.routers import bench as br

    class Fresh(_TpRun):
        bench_id = "t-10"

    tp, ctx, ane = _fake_modules({"throughput": {"t-9": _TpRun()}})
    _patch_engines(monkeypatch, tp, ctx, ane)
    bh.capture_run(_TpRun())
    bh.clear("throughput")
    tp._benchmark_runs["t-10"] = Fresh()
    br._sweep_terminal_runs("throughput")
    ids = [e["id"] for e in bh.entries("throughput")["entries"]]
    assert ids == ["t-10"], "only the cleared ids are tombstoned"


def test_clear_empty_surface_writes_no_tombstone():
    assert bh.clear("context")["removed"] is False
    assert not (bh.root() / "context" / "cleared.json").exists()
