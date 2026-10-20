"""GLOBAL BENCH QUEUE (user 2026-10-13 items 6+7) — pure-asyncio tests.

No omlx, no engines: every engine touch inside bench_queue goes through a
module-level lookup table (DISPATCH / CANCELS / VALIDATORS / BUSY / POOL),
so a test swaps a table and watches the pump. What is under test is the
queue's OWN behaviour — validate-then-enqueue, FIFO across kinds, wait for
the slot, retry cap on Conflict, cancel-vs-drop on remove, board shape.

The route wiring gets thin TestClient cases (busy -> queued=True, garbage
still 400, ANE still 409) with the same fake tables installed, so the HTTP
contract the frontend consumes is pinned too.
"""
from __future__ import annotations

import asyncio
import time
import types

import pytest

# Route-order doctrine (test_nat3_scaffold): import the facade first so
# global route registration order matches the server.
from omlx_uplift import router as _uplift_router  # noqa: F401
from omlx_uplift import accuracy_engine, bench_queue as bq, context_engine

KINDS = bq.KINDS

# Engine exception classes are matched BY NAME (_is_retryable/_is_bad_input)
# because every engine module owns its own — the fakes follow suit.
Conflict = type("Conflict", (Exception,), {})
NotReady = type("NotReady", (Exception,), {})
BadInput = type("BadInput", (Exception,), {})


class World:
    """Fake engines: busy probes, dispatchers, cancellers, validators."""

    def __init__(self):
        self.busy: dict[str, bool] = {}        # probe key -> busy?
        self.calls: list[tuple[str, str]] = []  # (kind, qid) per attempt
        self.started: list[str] = []           # qids that really launched
        self.bodies: dict[str, dict] = {}      # qid -> body the engine saw
        self.cancelled: list[str] = []         # qids sent to a cancel
        self.auto_busy = False                 # fake runs hold their slot
        self.failures: dict[str, list] = {}    # kind -> [left, exc]
        self.pool_missing = False

    # ---- the tables bench_queue consults instead of importing engines ----
    def busy_table(self):
        # 'ane' mirrors the real table: a busy signal, never a queue member
        keys = list(KINDS) + ["ane"]
        return {k: (lambda k=k: self.busy.get(k, False)) for k in keys}

    def install(self, monkeypatch):
        monkeypatch.setattr(bq, "BUSY", self.busy_table())
        monkeypatch.setattr(bq, "DISPATCH", {k: self._start for k in KINDS})
        monkeypatch.setattr(bq, "CANCELS", {k: self._cancel for k in KINDS})
        monkeypatch.setattr(bq, "VALIDATORS", {k: _ok for k in KINDS})
        monkeypatch.setattr(bq, "POOL",
                            lambda: None if self.pool_missing else object())

    # ---- fake engine behaviour -------------------------------------------
    def fail_times(self, kind, n, exc):
        self.failures[kind] = [n, exc]

    async def _start(self, entry):
        kind, qid = entry["kind"], entry["qid"]
        self.calls.append((kind, qid))
        pending = self.failures.get(kind)
        if pending and pending[0] > 0:
            pending[0] -= 1
            raise pending[1]
        self.started.append(qid)
        self.bodies[qid] = dict(entry["body"])
        if self.auto_busy:
            self.busy[kind] = True
        return {"run_id": f"run-{qid}"}

    async def _cancel(self, entry):
        self.cancelled.append(entry["qid"])
        self.busy[entry["kind"]] = False
        return {"status": "cancelled"}


def _ok(body):
    """Permissive validator: the REAL validation paths are pinned by the
    route tests below (embed/decision use their engines' own validate)."""


@pytest.fixture()
def world(monkeypatch):
    bq.clear()
    monkeypatch.setattr(bq, "POLL_S", 0.01)     # 2.0 s is the live cadence
    w = World()
    w.install(monkeypatch)
    yield w
    task = bq._pump
    if task is not None and not task.done():
        try:
            task.cancel()
        except Exception:                       # loop already closed (portal)
            pass
    bq._pump = None
    bq.clear()


async def _until(predicate, timeout=5.0):
    """Wait for a pump transition — the pump polls POLL_S, never sleep-blind."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.005)
    return False


def _entry(qid):
    return next(e for e in bq._entries if e["qid"] == qid)


async def _settle(kind="decision", body=None, label=""):
    snap = await bq.submit(
        kind, body if body is not None else {"model_id": "m"}, label=label)
    return snap["qid"]


# ---- submit validates before anything is enqueued --------------------------

async def test_submit_rejects_garbage_and_queues_nothing(world):
    def _reject(body):
        raise BadInput("packs: non-empty list required")

    bq.VALIDATORS["decision"] = _reject
    with pytest.raises(bq.BadInput) as ei:
        await bq.submit("decision", {"model_id": "m", "packs": []})
    assert "non-empty list" in str(ei.value)
    assert bq._entries == []                    # garbage never enters the queue
    assert bq._pump is None                     # and no pump is born for it


async def test_submit_unknown_kind_is_bad_input(world):
    with pytest.raises(bq.BadInput):
        await bq.submit("ane", {"model_id": "m"})    # ANE is never queued
    assert bq._entries == []


async def test_submit_skips_validation_when_the_validator_cannot_run(world):
    """An unavailable validator (no omlx in this env) is NOT a verdict: the
    entry queues and the engine re-checks it at dispatch."""
    def _unavailable(body):
        raise ImportError("omlx")

    bq.VALIDATORS["throughput"] = _unavailable
    qid = await _settle("throughput", {"model_id": "m", "prompt_lengths": [1]})
    assert _entry(qid)["status"] == "queued"


async def test_bad_input_at_dispatch_fails_without_retry(world):
    """The deferred-validation path: the engine's own BadInput is final."""
    world.fail_times("accuracy", 99, BadInput("benchmarks required"))
    qid = await _settle("accuracy", {"model_id": "m", "benchmarks": {}})
    assert await _until(lambda: _entry(qid)["status"] == "failed")
    assert world.calls == [("accuracy", qid)]   # tried exactly once
    assert _entry(qid)["error"] == "benchmarks required"
    assert world.started == []


# ---- FIFO across the kinds -------------------------------------------------

async def test_dispatch_is_fifo_across_kinds(world):
    order = ["decision", "embed", "throughput", "context", "accuracy"]
    qids = [await _settle(k, {"model_id": f"m{i}"}) for i, k in enumerate(order)]
    assert await _until(lambda: len(world.started) == len(order))
    assert world.started == qids, "the pump must start in click order"
    assert [e["kind"] for e in bq._entries] == order
    assert all(e["status"] in ("running", "done") for e in bq._entries)
    assert [e["run_id"] for e in bq._entries] == [f"run-{q}" for q in qids]
    assert [world.bodies[q]["model_id"] for q in qids] == ["m0", "m1", "m2",
                                                           "m3", "m4"]


async def test_submit_reports_position_and_snapshot(world):
    world.busy["accuracy"] = True               # hold the slot
    first = await bq.submit("decision", {"model_id": "a"})
    second = await bq.submit("embed", {"model_id": "b", "kind": "embed",
                                       "tasks": ["STS12"]})
    assert first["queued"] is True and first["position"] == 1
    assert second["queued"] is True and second["position"] == 2
    assert second["qid"] == _entry(second["qid"])["qid"]
    assert second["kind"] == "embed" and second["status"] == "queued"
    assert second["body"]["tasks"] == ["STS12"]      # bodies ride along
    assert second["label"] == "embed b · 1 task(s)"  # auto-labelled
    assert isinstance(second["queued_at"], float)


# ---- the pump waits for the single engine slot -----------------------------

async def test_pump_dispatches_only_after_idle_flips_true(world):
    world.busy["accuracy"] = True               # classic accuracy queue busy
    qid = await _settle("decision")
    await asyncio.sleep(0.08)
    assert world.started == [], "must not steal a busy engine"
    assert _entry(qid)["status"] == "queued"
    world.busy["accuracy"] = False
    assert await _until(lambda: world.started == [qid])
    assert _entry(qid)["status"] == "running"


async def test_pump_exits_when_the_queue_drains(world):
    await _settle("decision")
    assert bq._pump is not None
    assert await _until(lambda: bq._pump is None), "pump retires when empty"


async def test_missing_pool_is_not_ready_not_failed(world):
    """engine_pool() can restart-wedge: None at dispatch time means wait,
    and the entry must still run once the pool is back."""
    world.pool_missing = True
    qid = await _settle("embed", {"model_id": "m", "kind": "embed",
                                  "tasks": ["STS12"]})
    await asyncio.sleep(0.08)
    assert world.started == [] and _entry(qid)["status"] == "queued"
    world.pool_missing = False
    assert await _until(lambda: world.started == [qid])
    assert _entry(qid)["status"] == "running"


async def test_live_pool_race_guard_is_not_ready_not_crash(world):
    """The dispatch-time re-read: a pool that disappeared between the
    not-ready check and the engine call raises NotReady (retryable) rather
    than handing None to an engine that would die mid-run."""
    world.pool_missing = True
    with pytest.raises(bq.NotReady):
        bq._live_pool()
    world.pool_missing = False
    assert bq._live_pool() is not None


async def test_ane_busy_blocks_the_queue_though_ane_is_never_queued(world):
    world.busy["ane"] = True
    qid = await _settle("context", {"model_id": "m", "target_tokens": 4096})
    await asyncio.sleep(0.08)
    assert world.started == []
    world.busy["ane"] = False
    assert await _until(lambda: world.started == [qid])
    assert "ane" not in KINDS


# ---- Conflict retry cap ----------------------------------------------------

async def test_conflict_requeues_then_fails_at_the_cap(world):
    world.fail_times("throughput", 99, Conflict("context benchmark running"))
    qid = await _settle("throughput", {"model_id": "m", "prompt_lengths": [8]})
    assert await _until(lambda: _entry(qid)["status"] == "failed")
    assert len(world.calls) == bq.MAX_ATTEMPTS == 3
    assert _entry(qid)["attempts"] == 3
    assert _entry(qid)["error"] == "context benchmark running"
    assert world.started == []


async def test_conflict_then_success_keeps_fifo_position(world):
    world.auto_busy = True                      # a started run holds the slot
    first = await _settle("decision")
    second = await _settle("embed", {"model_id": "m2", "kind": "embed",
                                     "tasks": ["STS12"]})
    assert await _until(lambda: world.started == [first])
    world.fail_times("embed", 1, NotReady("mteb-env build in progress"))
    world.busy["decision"] = False              # the first run finishes
    assert await _until(lambda: world.started == [first, second])
    assert [k for k, _ in world.calls].count("embed") == 2      # retried once
    assert _entry(second)["status"] == "running"
    assert _entry(second)["error"] is None      # the retry note is cleared
    # while the embed run still holds the slot, a new click queues (pos 1)
    third = await bq.submit("context", {"model_id": "m3", "target_tokens": 4096})
    assert third["position"] == 1


# ---- remove / cancel -------------------------------------------------------

async def test_remove_queued_entry_drops_without_cancel(world):
    world.busy["context"] = True                # nothing dispatches
    doomed = await _settle("decision")
    keeper = await _settle("embed", {"model_id": "m", "kind": "embed",
                                     "tasks": ["STS12"]})
    out = await bq.remove(doomed)
    assert out["status"] == "removed" and out["was"] == "queued"
    assert out["cancelled"] is False
    assert world.cancelled == []                # never started -> never cancelled
    assert _entry(doomed)["status"] == "done"
    assert _entry(keeper)["status"] == "queued"
    world.busy["context"] = False               # the head is gone: keeper runs
    assert await _until(lambda: world.started == [keeper])


async def test_remove_running_entry_cancels_it(world):
    world.auto_busy = True
    qid = await _settle("decision")
    assert await _until(lambda: world.started == [qid])
    out = await bq.remove(qid)
    assert out["was"] == "running" and out["cancelled"] is True
    assert world.cancelled == [qid]
    assert _entry(qid)["status"] == "done"


async def test_remove_running_entry_drops_even_if_the_engine_refuses(world):
    qid = await _settle("decision")
    assert await _until(lambda: world.started == [qid])

    async def _refuses(entry):
        raise Conflict("already terminal")

    bq.CANCELS["decision"] = _refuses
    out = await bq.remove(qid)
    assert out["was"] == "running" and out["cancelled"] is False
    assert _entry(qid)["status"] == "done"      # the user's intent still holds
    assert "already terminal" in _entry(qid)["error"]


async def test_remove_unknown_qid_raises_not_found(world):
    with pytest.raises(bq.NotFound):
        await bq.remove("deadbeef0000")


# ---- status / board shape --------------------------------------------------

async def test_status_shape_carries_entries_and_idle_flag(world):
    assert bq.status() == {"idle": True, "busy_reason": None, "queued": 0,
                           "running": [], "entries": []}
    qid = await _settle("decision",
                        {"model_id": "qwen", "packs": ["arc-choice"]})
    st = bq.status()
    assert st["idle"] is False and "queued" in st["busy_reason"]
    assert st["queued"] == 1 and st["running"] == []
    assert st["entries"] == [dict(_entry(qid))]
    row = st["entries"][0]
    assert row is not _entry(qid)                    # a copy, not live state
    assert row["body"]["model_id"] == "qwen"         # so the UI can show it
    assert row["label"] == "qwen · 1 pack(s)"
    assert set(row) >= {"qid", "kind", "label", "body", "status", "error",
                        "run_id", "queued_at"}
    assert isinstance(row["queued_at"], float)


async def test_running_entry_becomes_done_when_its_engine_frees(world):
    qid = await _settle("decision")
    assert await _until(lambda: _entry(qid)["status"] == "running")
    world.busy["decision"] = True         # fake engine: still running
    bq.status()
    assert _entry(qid)["status"] == "running"
    world.busy["decision"] = False        # ... and now it is not
    assert bq.status()["entries"][0]["status"] == "done"


# ---- route wiring: the HTTP contract the frontend consumes -----------------

def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base

    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app)


@pytest.fixture()
def pool(monkeypatch):
    """The start routes gate on engine_pool() BEFORE anything else; in a
    test process the server is not running, so hand them one."""
    from omlx_uplift.routers import bench as bench_mod
    monkeypatch.setattr(bench_mod, "engine_pool", lambda: object())
    # bench_queue re-reads the pool at dispatch time through the same seam
    monkeypatch.setattr(bq, "POOL", bench_mod.engine_pool)


@pytest.mark.parametrize("path,body", [
    ("/bench/decision/start", {"model_id": "m", "packs": ["arc-choice"]}),
    ("/bench/embed/start", {"model_id": "m", "kind": "embed",
                            "tasks": ["STS12"]}),
    ("/bench/start", {"model_id": "m", "prompt_lengths": [1024]}),
    ("/bench/context/start", {"model_id": "m", "target_tokens": 4096}),
])
def test_start_routes_queue_instead_of_409(world, pool, path, body):
    """A busy slot -> 200 + queued for EVERY kind (no 409, no lost click)."""
    world.busy["accuracy"] = True
    with _client() as client:
        r = client.post(f"/uplift/api{path}", json={**body, "upload": True})
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["queued"] is True and out["position"] == 1 and out["qid"]
        assert world.started == []                      # nothing launched yet
        assert _entry(out["qid"])["body"]["model_id"] == "m"
        board = client.get("/uplift/api/bench/queue").json()
        assert board["idle"] is False and board["queued"] == 1
        assert board["entries"][0]["kind"] in KINDS
        drop = client.delete(f"/uplift/api/bench/queue/{out['qid']}")
        assert drop.status_code == 200
        assert drop.json()["status"] == "removed"
        assert client.delete(
            "/uplift/api/bench/queue/nope000000").status_code == 404


def test_start_route_validation_error_is_still_400(world, pool):
    """Garbage is a 400 from the ENGINE's validate, before the queue is
    ever consulted — it must not become a failed row minutes later."""
    world.busy["embed"] = True
    with _client() as client:
        r = client.post("/uplift/api/bench/embed/start",
                        json={"model_id": "m", "kind": "embed",
                              "tasks": ["NotACuratedTask"]})
        assert r.status_code == 400
    assert bq._entries == []


def test_start_route_bad_decision_body_is_400_too(world, pool):
    with _client() as client:
        r = client.post("/uplift/api/bench/decision/start",
                        json={"model_id": "m", "packs": []})
        assert r.status_code == 400
    assert bq._entries == []


def test_accuracy_add_conflict_from_cross_type_falls_into_queue(world, pool):
    """classic's IN-TYPE queue stays first; only a cross-type Conflict
    (ANE/context holds the engine) is re-routed to the global queue."""
    from omlx_uplift.routers import bench as bench_mod

    async def _conflict(body, engine_pool, *, upload=False):
        raise accuracy_engine.Conflict("ANE tuning is already running")

    monkey_set = bench_mod.accuracy_engine.queue_add
    bench_mod.accuracy_engine.queue_add = _conflict
    try:
        with _client() as client:
            r = client.post("/uplift/api/bench/accuracy/add",
                            json={"model_id": "m",
                                  "benchmarks": {"mmlu": 30}, "upload": True})
            assert r.status_code == 200, r.text
            assert r.json()["queued"] is True
    finally:
        bench_mod.accuracy_engine.queue_add = monkey_set
    entry = bq._entries[0]
    assert entry["kind"] == "accuracy"
    # upload is preserved in the stored body: the pump re-pops it at start
    assert entry["body"] == {"model_id": "m", "benchmarks": {"mmlu": 30},
                             "upload": True}


def test_accuracy_add_bad_input_is_still_400(world, pool):
    from omlx_uplift.routers import bench as bench_mod

    async def _bad(body, engine_pool, *, upload=False):
        raise accuracy_engine.BadInput("unknown benchmark")

    orig = bench_mod.accuracy_engine.queue_add
    bench_mod.accuracy_engine.queue_add = _bad
    try:
        with _client() as client:
            r = client.post("/uplift/api/bench/accuracy/add",
                            json={"model_id": "m", "benchmarks": {"nope": 30}})
            assert r.status_code == 400
    finally:
        bench_mod.accuracy_engine.queue_add = orig
    assert bq._entries == []


def test_ane_tune_start_still_conflicts(world, pool):
    """ANE keeps its 409 — apply-semantics, human present (see bench.py)."""
    from omlx_uplift.routers import bench as bench_mod

    async def _conflict(body, engine_pool):
        raise context_engine.Conflict("A context benchmark is already running")

    orig = bench_mod.context_engine.ane_start
    bench_mod.context_engine.ane_start = _conflict
    try:
        with _client() as client:
            r = client.post("/uplift/api/bench/ane-tune/start",
                            json={"model_id": "m", "sequence_length": 4096})
            assert r.status_code == 409
    finally:
        bench_mod.context_engine.ane_start = orig
    assert bq._entries == []


# ---- throughput cache-off flags through the queue ---------------------------

def test_throughput_start_route_queued_keeps_cache_flags(world, pool):
    """The queued path stores the flags in the body exactly like upload:
    the click's cache-off choice survives until the pump dispatches."""
    world.busy["accuracy"] = True
    with _client() as client:
        r = client.post("/uplift/api/bench/start",
                        json={"model_id": "m", "prompt_lengths": [1024],
                              "upload": True, "no_hot_cache": True})
        assert r.status_code == 200, r.text
        assert r.json()["queued"] is True
    entry = bq._entries[0]
    assert entry["kind"] == "throughput"
    assert entry["body"] == {"model_id": "m", "prompt_lengths": [1024],
                             "upload": True, "no_hot_cache": True,
                             "no_ssd_cache": False}


async def test_throughput_dispatch_pops_cache_flags(monkeypatch):
    """The REAL _start_throughput re-pops upload AND both flags at its own
    boundary and hands them back as kwargs — the engine body carries only
    classic fields (round-trip of the stored flags above)."""
    calls = []

    async def _start(body, pool, *, upload=False, no_hot_cache=False,
                     no_ssd_cache=False):
        calls.append((dict(body), upload, no_hot_cache, no_ssd_cache))
        return {"bench_id": "b1", "status": "started"}

    fake_m = types.SimpleNamespace(start=_start)
    monkeypatch.setattr(bq, "_mod", lambda name: fake_m)
    monkeypatch.setattr(bq, "POOL", lambda: object())
    entry = {"kind": "throughput",
             "body": {"model_id": "m", "prompt_lengths": [1024],
                      "upload": True, "no_hot_cache": True,
                      "no_ssd_cache": False}}
    out = await bq._start_throughput(entry)
    assert out["status"] == "started"
    body, upload, hot, ssd = calls[0]
    assert upload is True and hot is True and ssd is False
    assert "upload" not in body and "no_hot_cache" not in body \
        and "no_ssd_cache" not in body
    assert body == {"model_id": "m", "prompt_lengths": [1024]}


async def test_throughput_validator_is_blind_to_cache_flags(monkeypatch):
    """_validate_throughput's `clean` filter pre-validates the queued body
    against the CLASSIC pydantic model; with a strict (extra-forbid style)
    stand-in, uplift-only keys must be stripped — flags never 400 a valid
    queued body and never reach classic's schema."""
    seen = []

    class StrictReq:
        CLASSIC = {"model_id", "prompt_lengths", "generation_length",
                   "batch_sizes", "context_profile", "warmup_mode",
                   "align_prompt_to_ane", "force_lm_engine", "external"}

        def __init__(self, **kw):
            seen.append(sorted(kw))
            if not {"model_id", "prompt_lengths"} <= set(kw):
                raise ValueError("field required")
            extra = set(kw) - self.CLASSIC
            if extra:
                raise ValueError(f"extra fields not permitted: {extra}")

    fake_m = types.SimpleNamespace(request_model=lambda: StrictReq)
    monkeypatch.setattr(bq, "_mod", lambda name: fake_m)
    # real function, not the world fixture's permissive table entry
    bq._validate_throughput({"model_id": "m", "prompt_lengths": [1024],
                             "upload": True, "no_hot_cache": True,
                             "no_ssd_cache": True})
    assert seen and "no_hot_cache" not in seen[0] and "upload" not in seen[0]
    # and a genuinely invalid classic body still fails
    with pytest.raises(bq.BadInput):
        bq._validate_throughput({"model_id": "m", "no_hot_cache": True})
