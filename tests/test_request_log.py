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


async def test_cancel_stamps_aborted_finish_and_finalize_keeps_it():
    """CANCEL-1: cancel stamps finish='aborted' on the active row and a
    later empty-finish harvest must NOT erase it."""
    req = _req("c2", gen_at=time.monotonic())
    sched = FakeScheduler(running={"c2": req})
    t = RequestTracker()
    pool = _pool({"m1": sched})
    t.sample(pool)
    assert await t.cancel(pool, "c2") is True
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["c2"]["finish"] == "aborted"
    # engine cleanup arrives with an empty finish_reason (abort harvest)
    t.note_finalize("c2", "m1", {"has_output": True, "output_text": "",
                                 "completion_tokens": 42,
                                 "finish_reason": "", "params": ""})
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["c2"]["state"] == "complete"
    assert rows["c2"]["finish"] == "aborted"
    # a real finish_reason still wins over the earlier stamp
    t2 = RequestTracker()
    t2.note_birth("c3", "m1", _req("c3"))
    t2.note_finalize("c3", "m1", {"has_output": True, "output_text": "x",
                                  "completion_tokens": 3,
                                  "finish_reason": "stop", "params": ""})
    rows = {r["id"]: r for r in t2.list_rows(limit=5)}
    assert rows["c3"]["finish"] == "stop"


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


# -- RL-1 payload capture ----------------------------------------------------

import json as _json
from dataclasses import dataclass, fields as _dc_fields

from omlx_uplift.request_log import PARAM_FIELDS, PAYLOAD_CAP, _capture_payload


@dataclass
class FakeParams:
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 256
    stop: list = None
    presence_penalty: float = 0.0
    frequency_penalty: float = 0.0
    # fields the capture must NOT include (subset doctrine pinned below):
    top_k: int = 0
    seed: int = 5

    def __post_init__(self):
        if self.stop is None:
            self.stop = []


def _full_req(rid, prompt="hello world", out="partial answer", fr=None):
    return SimpleNamespace(request_id=rid, prompt=prompt,
                           sampling_params=FakeParams(),
                           output_text=out, finish_reason=fr,
                           num_prompt_tokens=2, num_output_tokens=3)


def test_capture_full_payload_fields_and_flags():
    p = _capture_payload(_full_req("p1"))
    assert p["prompt"] == "hello world" and p["prompt_trunc"] is False
    assert p["output"] == "partial answer" and p["output_trunc"] is False
    params = _json.loads(p["params"])
    assert set(params) == set(PARAM_FIELDS)          # exact field list
    assert params["temperature"] == 0.7 and params["max_tokens"] == 256
    assert "top_k" not in params and "seed" not in params


def test_capture_finish_reason_only_when_present():
    assert "finish" not in _capture_payload(_full_req("f1", fr=None))
    p = _capture_payload(_full_req("f2", fr="stop"))
    assert p["finish"] == "stop"


def test_capture_truncates_at_byte_cap():
    big = "x" * (PAYLOAD_CAP + 100)
    p = _capture_payload(_full_req("p2", prompt=big))
    assert p["prompt_trunc"] is True
    assert len(p["prompt"].encode()) == PAYLOAD_CAP
    # multi-byte chars must not be cut mid-character (decode errors='ignore')
    wide = "\u00e9" * (PAYLOAD_CAP + 10)             # 2 bytes per char
    p2 = _capture_payload(_full_req("p3", prompt=wide))
    assert p2["prompt_trunc"] is True
    assert len(p2["prompt"]) * 2 == PAYLOAD_CAP      # clean 2-byte boundary


def test_capture_tokenized_prompt_described_not_dumped():
    p = _capture_payload(_full_req("p4", prompt=[1, 2, 3, 4, 5]))
    assert p["prompt"] == "(tokenized prompt, 5 tokens)"
    assert p["prompt_trunc"] is False


def test_capture_missing_attrs_absent_not_empty_lies():
    bare = SimpleNamespace(request_id="p5")           # no prompt/params/output
    assert _capture_payload(bare) == {}


def test_capture_exception_never_loses_the_lifecycle_row():
    class Bad:
        request_id = "p6"            # FakeScheduler reads this at build time

        def __getattr__(self, name):
            if name == "prompt":
                raise RuntimeError("exploding attribute")   # defeats getattr default
            raise AttributeError(name)                      # plain missing attr

    t = RequestTracker()
    sched = FakeScheduler(running={"p6": Bad()})
    t.sample(_pool({"m1": sched}))
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["p6"]["state"] == "prefilling"        # row survives capture failure
    assert "prompt" not in rows["p6"]                 # absent, not ''-lies


def test_param_fields_mirror_request_sampling_params():
    """Mirror-the-server doctrine: every PARAM_FIELDS name must exist as a
    real SamplingParams field in omlx/request.py (text-parsed, no import)."""
    import pathlib
    import re
    src = pathlib.Path(__file__).resolve().parents[3].joinpath("omlx", "request.py")
    if not src.exists():  # package installed standalone without the repo tree
        import omlx.request as m
        names = {f.name for f in _dc_fields(m.SamplingParams)}
    else:
        src_txt = src.read_text()
        cls = src_txt[src_txt.index("class SamplingParams:"):]
        cls = cls[:cls.index("\nclass ", 1)] if "\nclass " in cls[1:] else cls
        names = set(re.findall(r"^    (\w+):\s", cls, re.M))
    assert set(PARAM_FIELDS) <= names, set(PARAM_FIELDS) - names


# -- RL-2 tracker lookup + final capture on departure --------------------------

def test_lookup_active_wins_and_is_live_tracks_state():
    req = _full_req("lk1", prompt="hi", out="half")
    sched = FakeScheduler(running={"lk1": req})
    t = RequestTracker()
    t.sample(_pool({"m1": sched}))
    assert t.is_live("lk1") is True
    assert t.lookup("lk1")["prompt"] == "hi"
    sched.running = {}                     # departs
    t.sample(_pool({"m1": sched}))
    assert t.is_live("lk1") is False       # done, not active
    row = t.lookup("lk1")
    assert row["state"] == "complete"
    assert t.lookup("nope") is None


def test_departure_refresh_grabs_final_output():
    """The Request object can outlive its snapshot row by one tick
    (scheduler.requests pops later); the tracker must re-read it at
    departure so output/finish are not lost for fast requests."""
    req = _full_req("dep1", prompt="PROMPT", out="")
    sched = FakeScheduler(running={"dep1": req})
    t = RequestTracker()
    t.sample(_pool({"m1": sched}))
    assert "output" not in t.lookup("dep1")          # live: empty -> absent, no lie
    # engine finalizes, removes from snapshot, but keeps it one step in
    # scheduler.requests (mirrors _cleanup_finished ordering). FakeScheduler
    # mirrors that: snapshot `running` empties, its all-map still resolves.
    req.output_text = "FULL FINAL ANSWER"
    req.finish_reason = "stop"
    sched.running = {}
    t.sample(_pool({"m1": sched}))
    row = t.lookup("dep1")
    assert row["state"] == "complete"
    assert row["output"] == "FULL FINAL ANSWER"
    assert row["finish"] == "stop"


# -- RL-2 live tail from the output collector ----------------------------------

def _async_pool(schedulers, collectors):
    # AsyncEngineCore-shaped: engine._engine.engine.(scheduler, _output_collectors)
    entries = {
        mid: SimpleNamespace(engine=SimpleNamespace(_engine=SimpleNamespace(
            engine=SimpleNamespace(scheduler=s, _output_collectors=collectors.get(mid, {})))))
        for mid, s in schedulers.items()
    }
    return SimpleNamespace(_entries=entries)


def test_live_tail_grows_from_output_collector():
    coll_out = SimpleNamespace(output_text="half a st", finish_reason=None)
    coll = SimpleNamespace(output=coll_out)
    sched = FakeScheduler(running={"t1": _req("t1", gen_at=time.monotonic(), out=9)})
    pool = _async_pool({"m1": sched}, {"m1": {"t1": coll}})
    t = RequestTracker()
    t.sample(pool)
    assert t.lookup("t1")["output"] == "half a st"

    coll_out.output_text = "half a story, growing"      # tokens decode...
    t.sample(pool)
    assert t.lookup("t1")["output"] == "half a story, growing"

    coll_out.finish_reason = "stop"                      # finalized
    t.sample(pool)
    row = t.lookup("t1")
    assert row["finish"] == "stop"


def test_collector_absent_and_broken_never_breaks_feed():
    sched = FakeScheduler(running={"t2": _req("t2", gen_at=time.monotonic())})
    bad = SimpleNamespace()          # no .output attr -> {} payload
    pool = _async_pool({"m1": sched}, {"m1": {"t2": bad}})
    t = RequestTracker()
    t.sample(pool)
    assert t.lookup("t2")["state"] == "generating"       # row survived
    assert "output" not in t.lookup("t2")


def test_collector_payload_truncates_tail():
    from omlx_uplift.request_log import PAYLOAD_CAP, _collector_payload
    coll = SimpleNamespace(output=SimpleNamespace(
        output_text="x" * (PAYLOAD_CAP + 10), finish_reason=None))
    p = _collector_payload(coll)
    assert p["output_trunc"] is True and len(p["output"].encode()) == PAYLOAD_CAP
