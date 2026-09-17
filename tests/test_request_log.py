# SPDX-License-Identifier: Apache-2.0
"""Tests for omlx/request_log.py — the sampled live-request tracker (R12-3).

Fake scheduler objects expose the same snapshot_for_admin() shape as the
real one: {running_by_id: {id: Request-like}, waiting: [Request-like]}.
"""

import time
from types import SimpleNamespace

from omlx_uplift.request_log import RequestTracker, get_request_tracker


def _req(rid, prompt=10, gen_at=None, out=0):
    return SimpleNamespace(
        request_id=rid, num_prompt_tokens=prompt,
        generation_started_at=gen_at, num_output_tokens=out,
    )


class FakeScheduler:
    def __init__(self, waiting=None, running=None):
        self.waiting = waiting or []
        self.running = running or {}
        self.aborted = []
        self.all = {r.request_id: r for r in list(waiting or []) + list((running or {}).values())}

    def snapshot_for_admin(self):
        return {"running_by_id": dict(self.running), "waiting": list(self.waiting)}

    def abort_request(self, rid):
        self.aborted.append(rid)
        return True

    def get_request(self, rid):
        return self.all.get(rid)


def _pool(schedulers):
    entries = {
        mid: SimpleNamespace(engine=SimpleNamespace(_engine=None, scheduler=s))
        for mid, s in schedulers.items()
    }
    return SimpleNamespace(_entries=entries)


def test_sample_tracks_queued_generating_and_departure():
    sched = FakeScheduler(waiting=[_req("q1")],
                          running={"g1": _req("g1", gen_at=time.monotonic(), out=5)})
    t = RequestTracker()
    t.sample(_pool({"m1": sched}))

    rows = {r["id"]: r for r in t.list_rows(limit=10)}
    assert rows["q1"]["state"] == "queued"
    assert rows["g1"]["state"] == "generating"
    assert rows["g1"]["completion_tokens"] == 5
    assert rows["g1"]["model"] == "m1"
    assert rows["g1"]["origin"] == "real"

    # q1 starts generating, g1 keeps going
    sched.waiting = []
    sched.running = {"g1": _req("g1", gen_at=time.monotonic(), out=9),
                     "q1": _req("q1", gen_at=time.monotonic(), out=1)}
    t.sample(_pool({"m1": sched}))
    rows = {r["id"]: r for r in t.list_rows(limit=10)}
    assert rows["q1"]["state"] == "generating"

    sched.running = {}
    t.sample(_pool({"m1": sched}))
    done = {r["id"]: r for r in t.list_rows(limit=10)}
    assert done["g1"]["state"] == "complete"
    assert done["g1"]["completion_tokens"] == 9   # last-seen value kept
    assert "q1" in done and done["q1"]["state"] == "complete"


def test_running_without_generation_start_is_prefilling():
    sched = FakeScheduler(running={"p1": _req("p1")})
    t = RequestTracker()
    t.sample(_pool({"m1": sched}))
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["p1"]["state"] == "prefilling"


def test_failed_model_sample_does_not_finalize_its_rows():
    good = FakeScheduler()
    bad = FakeScheduler()

    class Boom:  # snapshot raises -> contained
        def snapshot_for_admin(self):
            raise RuntimeError("engine executor busy")

    t = RequestTracker()
    pool = {"m1": good, "m2": bad}
    t.sample(_pool(pool))
    good.running = {"x": _req("x", gen_at=time.monotonic(), out=1)}
    t.sample(_pool(pool))

    # break m2's engine walk entirely so its model fails the sample
    pool["m2"] = SimpleNamespace(engine=None, scheduler=Boom())
    good.running = {}
    t.sample(_pool(pool))
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert "x" not in rows or rows["x"]["state"] == "complete"


def test_row_from_unsampled_model_is_not_finalized():
    sched_a = FakeScheduler(running={"a1": _req("a1", gen_at=time.monotonic())})
    sched_b = FakeScheduler()
    t = RequestTracker()
    t.sample(_pool({"ma": sched_a}))
    # second sample: ma's scheduler gone entirely (unload) -> model not
    # sampled -> row kept as stale-active, not falsely completed
    t.sample(_pool({"mb": sched_b}))
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["a1"]["state"] == "generating"


async def test_cancel_marks_cancelling_and_reaches_scheduler():
    req = _req("c1", gen_at=time.monotonic())
    sched = FakeScheduler(running={"c1": req})
    t = RequestTracker()
    pool = _pool({"m1": sched})
    t.sample(pool)
    assert await t.cancel(pool, "c1") is True
    assert sched.aborted == ["c1"]
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["c1"]["state"] == "cancelling"
    assert await t.cancel(pool, "nope") is False


async def test_cancel_prefers_async_core_abort():
    """The collector-signalling AsyncEngineCore path must be used when present."""
    called = []

    class AsyncCore:
        async def abort_request(self, rid):
            called.append(rid)
            return True

    # real structure: entry.engine -> ._engine (AsyncEngineCore) -> .engine
    # (core holding .scheduler)
    sched = FakeScheduler(running={"c3": _req("c3", gen_at=time.monotonic())})
    core = SimpleNamespace(scheduler=sched)

    class AsyncCore:
        def __init__(self):
            self.engine = core
        async def abort_request(self, rid):
            called.append(rid)
            return True

    entry = SimpleNamespace(engine=SimpleNamespace(_engine=AsyncCore()))
    pool = SimpleNamespace(_entries={"m1": entry})
    t = RequestTracker()
    t.sample(pool)
    assert await t.cancel(pool, "c3") is True
    assert called == ["c3"]           # async core used...
    assert sched.aborted == []        # ...not the raw scheduler


async def test_cancel_after_vanish_finalizes_as_error():
    sched = FakeScheduler(running={"c2": _req("c2", gen_at=time.monotonic())})
    t = RequestTracker()
    pool = _pool({"m1": sched})
    t.sample(pool)
    await t.cancel(pool, "c2")
    sched.running = {}
    t.sample(pool)
    done = {r["id"]: r for r in t.list_rows(limit=5)}
    assert done["c2"]["state"] == "error"


def test_drin_dirty_reports_each_transition_once():
    sched = FakeScheduler(waiting=[_req("d1")])
    t = RequestTracker()
    pool = _pool({"m1": sched})
    t.sample(pool)
    d1 = t.drain_dirty()
    assert [r["id"] for r in d1] == ["d1"]
    assert t.drain_dirty() == []          # no change -> nothing dirty
    sched.waiting = []
    sched.running = {"d1": _req("d1", gen_at=time.monotonic())}
    t.sample(pool)
    d2 = t.drain_dirty()
    assert d2[0]["state"] == "generating"


def test_singleton_returns_same_instance():
    assert get_request_tracker() is get_request_tracker()
