"""ACT-SLEEP-2 (server lane): the scheduler half of each active_models row
(queued/prefilling/generating + counts) must move at the FAST cadence, and
a pool whose membership/loading shape differs from the last FULL build must
upgrade the next tick to a full rebuild.

Measured defect (user 2026-10-19): a finished text generation kept
rendering 'Generating' for ~10-15 s (only the 15 s slow rebuild carried
the scheduler lists), and a model load was invisible end to end (the
loading row could only enter the payload on a full rebuild — short loads
never showed, long ones flashed late; the user read the eventual ghost-row
drop as an erroneous 'was unloaded' achievement).

Fakes mirror the real seams used by admin/routes.py _build_active_models_data:
engine._engine.engine.scheduler.snapshot_for_admin(), the
_output_collectors dict, omlx.prefill_progress.get_prefill_tracker(), and
Splash-style engine.get_live_requests().
"""
import sys
import time
import types

import pytest

from omlx_uplift import stats_feed


# ---------------- fakes (voice15 pool-shim pattern) ----------------

class _RunReq:
    def __init__(self, rid, out=0, prompt=10, started=None, maxtok=None):
        self.request_id = rid
        self.num_output_tokens = out
        self.num_prompt_tokens = prompt
        self.generation_started_at = started
        self.last_activity_at = None
        self.max_tokens = maxtok


class _WaitReq:
    def __init__(self, rid, prompt=10, waited=1.0):
        self.request_id = rid
        self.num_prompt_tokens = prompt
        self.arrival_time = time.time() - waited


class _Sched:
    def __init__(self, running=None, waiting=None, boom=False):
        self.running = running or {}
        self.waiting = waiting or []
        self.boom = boom

    def snapshot_for_admin(self):
        if self.boom:
            raise RuntimeError("scheduler vanished mid-read")
        return {"running_by_id": dict(self.running), "waiting": list(self.waiting)}


class _Core:
    def __init__(self, sched=None, collectors=None):
        self.scheduler = sched
        self._output_collectors = collectors or {}


class _AsyncCore:
    def __init__(self, core):
        self.engine = core


class _Engine:
    """Batched LLM-ish engine: async core wrapper + activity snapshot.
    get_live_requests exists ONLY when the test passes `live` (the route
    probes it with getattr+callable)."""
    def __init__(self, core=None, live=None, acts=None):
        self._engine = _AsyncCore(core) if core is not None else None
        self._acts = acts or []
        if live is not None:
            self.get_live_requests = lambda: live

    def get_activity_snapshot(self):
        return {"active_requests": len(self._acts), "activities": list(self._acts)}


class _Entry:
    def __init__(self, engine=None, is_loading=False):
        self.engine = engine
        self.is_loading = is_loading


class _Pool:
    def __init__(self, entries):
        self._entries = entries


class _Tracker:
    def __init__(self, rows=None, boom=False):
        self.rows = rows or {}
        self.boom = boom

    def get_model_progress(self, model_id):
        if self.boom:
            raise RuntimeError("tracker down")
        return list(self.rows.get(model_id, []))


_pool_holder = {"pool": None}
_tracker_holder = {"tracker": None}


@pytest.fixture()
def pool(monkeypatch):
    omlx = types.ModuleType("omlx")
    admin = types.ModuleType("omlx.admin")
    routes = types.ModuleType("omlx.admin.routes")
    pp = types.ModuleType("omlx.prefill_progress")
    routes._get_engine_pool = lambda: _pool_holder["pool"]
    pp.get_prefill_tracker = lambda: _tracker_holder["tracker"]
    omlx.admin = admin
    admin.routes = routes
    mods = sys.modules
    saved = {n: mods.get(n) for n in ("omlx", "omlx.admin", "omlx.admin.routes",
                                      "omlx.prefill_progress")}
    monkeypatch.setitem(mods, "omlx", omlx)
    monkeypatch.setitem(mods, "omlx.admin", admin)
    monkeypatch.setitem(mods, "omlx.admin.routes", routes)
    monkeypatch.setitem(mods, "omlx.prefill_progress", pp)
    _pool_holder["pool"] = None
    _tracker_holder["tracker"] = None
    yield _pool_holder
    _pool_holder["pool"] = None
    _tracker_holder["tracker"] = None


def _payload(rows, total_active=None, total_waiting=None):
    return {"active_models": {
        "models": [dict(r) for r in rows],
        "total_active_requests": (total_active if total_active is not None
                                  else sum(r.get("active_requests", 0) for r in rows)),
        "total_waiting_requests": (total_waiting if total_waiting is not None
                                   else sum(r.get("waiting_requests", 0) for r in rows)),
    }}


# ---------------- _refresh_live_lists ----------------

def test_completed_generation_clears_the_stale_row(pool):
    """THE reported bug: scheduler says nothing runs -> the cached
    'generating' row must be gone on THIS tick, not on the next slow build."""
    core = _Core(_Sched(running={}))
    eng = _Engine(core=core)
    _pool_holder["pool"] = _Pool({"llm": _Entry(eng)})
    stale = {"id": "llm", "active_requests": 1, "waiting_requests": 0,
             "generating": [{"request_id": "r1", "generated_tokens": 5}],
             "prefilling": [], "waiting": [], "activities": []}
    out = stats_feed._refresh_live_lists(_payload([stale]))
    row = out["active_models"]["models"][0]
    assert row["generating"] == []
    assert row["active_requests"] == 0
    assert out["active_models"]["total_active_requests"] == 0
    # the original cached composite is NEVER mutated
    assert stale["generating"] and stale["active_requests"] == 1


def test_running_request_rows_refresh_with_live_counters(pool):
    now = time.time()
    core = _Core(_Sched(running={"r9": _RunReq("r9", out=42, started=now - 3)}))
    _pool_holder["pool"] = _Pool({"llm": _Entry(_Engine(core=core))})
    _tracker_holder["tracker"] = _Tracker({"llm": [
        {"request_id": "p1", "processed": 7, "total": 10}]})
    stale = {"id": "llm", "active_requests": 0, "waiting_requests": 0,
             "generating": [], "prefilling": [], "waiting": [], "activities": []}
    out = stats_feed._refresh_live_lists(_payload([stale]))
    row = out["active_models"]["models"][0]
    assert [g["request_id"] for g in row["generating"]] == ["r9"]
    assert row["generating"][0]["generated_tokens"] == 42
    assert 13 < row["generating"][0]["tokens_per_second"] < 15   # 42/3
    assert [p["request_id"] for p in row["prefilling"]] == ["p1"]
    assert row["active_requests"] == 2          # r9 (sched) + p1 (tracker)
    assert out["active_models"]["total_active_requests"] == 2


def test_waiting_rows_get_positions_and_wait(pool):
    core = _Core(_Sched(running={}, waiting=[_WaitReq("w1"), _WaitReq("w2")]))
    _pool_holder["pool"] = _Pool({"llm": _Entry(_Engine(core=core))})
    stale = {"id": "llm", "active_requests": 0, "waiting_requests": 0,
             "generating": [], "prefilling": [], "waiting": []}
    out = stats_feed._refresh_live_lists(_payload([stale]))
    row = out["active_models"]["models"][0]
    assert [w["request_id"] for w in row["waiting"]] == ["w1", "w2"]
    assert row["waiting"][0]["queue_position"] == 1
    assert row["waiting_requests"] == 2
    assert out["active_models"]["total_waiting_requests"] == 2


def test_collector_only_engine_counts_rids(pool):
    """Engines without a scheduler snapshot but with output collectors:
    the route's fallback tier — rids without rich counters."""
    core = _Core(sched=None, collectors={"c1": object()})
    _pool_holder["pool"] = _Pool({"llm": _Entry(_Engine(core=core))})
    stale = {"id": "llm", "active_requests": 0, "waiting_requests": 0,
             "generating": [], "prefilling": [], "waiting": []}
    out = stats_feed._refresh_live_lists(_payload([stale]))
    row = out["active_models"]["models"][0]
    assert [g["request_id"] for g in row["generating"]] == ["c1"]
    assert row["generating"][0]["generated_tokens"] == 0
    assert row["active_requests"] == 1


def test_splash_live_requests_extend_rows(pool):
    live = {"prefilling": [{"request_id": "s1"}],
            "generating": [{"request_id": "s2"}]}
    _pool_holder["pool"] = _Pool({"ext": _Entry(_Engine(core=None, live=live))})
    stale = {"id": "ext", "active_requests": 0, "waiting_requests": 0,
             "generating": [], "prefilling": [], "waiting": []}
    out = stats_feed._refresh_live_lists(_payload([stale]))
    row = out["active_models"]["models"][0]
    assert [p["request_id"] for p in row["prefilling"]] == ["s1"]
    assert [g["request_id"] for g in row["generating"]] == ["s2"]
    assert row["active_requests"] == 2


def test_loading_and_absent_and_cluster_rows_are_left_to_the_full_build(pool):
    eng = _Engine(core=_Core(_Sched(running={})))
    _pool_holder["pool"] = _Pool({
        "loading": _Entry(None, is_loading=True),      # membership: full-build's job
        "gone": None,
    })
    _pool_holder["pool"]._entries["absent"] = None
    rows = [
        {"id": "loading", "active_requests": 0, "generating": [{"request_id": "ghost"}]},
        {"id": "gone", "active_requests": 1, "generating": [{"request_id": "old"}]},
        {"id": "clu", "cluster": {"ok": True}, "active_requests": 3,
         "generating": [{"request_id": "rank0"}]},
    ]
    out = stats_feed._refresh_live_lists(_payload(rows, total_active=4))
    got = out["active_models"]["models"]
    assert got == rows                       # every row untouched, content equal


def test_seam_failure_keeps_the_cached_lists(pool):
    """A throwing snapshot must NOT blank the row — keep the last truth."""
    core = _Core(_Sched(boom=True))
    _pool_holder["pool"] = _Pool({"llm": _Entry(_Engine(core=core))})
    cached = {"id": "llm", "active_requests": 2, "waiting_requests": 0,
              "generating": [{"request_id": "r1"}], "prefilling": [], "waiting": []}
    out = stats_feed._refresh_live_lists(_payload([cached]))
    assert out["active_models"]["models"][0]["generating"] == [{"request_id": "r1"}]


def test_no_change_means_no_copy(pool):
    eng = _Engine(core=_Core(_Sched()))
    _pool_holder["pool"] = _Pool({"llm": _Entry(eng)})
    row = {"id": "llm", "active_requests": 0, "waiting_requests": 0,
           "generating": [], "prefilling": [], "waiting": []}
    stats = _payload([row])
    assert stats_feed._refresh_live_lists(stats) is stats


def test_activity_counts_stack_on_the_refreshed_base(pool):
    """Ordering contract with _refresh_activities: the live-list refresh
    keeps the cached activities in the active_requests baseline so the
    activity delta lands on a correct number."""
    a1 = {"request_id": "a1", "kind": "transcribing", "elapsed_seconds": 0}
    eng = _Engine(core=_Core(_Sched(running={"r1": _RunReq("r1", out=3)})), acts=[a1])
    _pool_holder["pool"] = _Pool({"llm": _Entry(eng)})
    row = {"id": "llm", "active_requests": 3, "waiting_requests": 0,
           "generating": [], "prefilling": [], "waiting": [],
           "activities": [dict(a1)]}
    stats = stats_feed._refresh_live_lists(_payload([row]))
    r = stats["active_models"]["models"][0]
    assert r["active_requests"] == 2                 # 1 sched + 1 cached act
    r2 = stats_feed._refresh_activities(stats)["active_models"]["models"][0]
    assert r2["active_requests"] == 2                # same fresh activity
    eng._acts = [a1, {"request_id": "a2", "kind": "transcribing",
                      "elapsed_seconds": 1}]
    r3 = stats_feed._refresh_activities(stats)["active_models"]["models"][0]
    assert r3["active_requests"] == 3                # delta of +1 applied on top
    assert r3["generating"][0]["request_id"] == "r1" # lists survive the second pass


# ---------------- shape-forced FULL build in StatsFeed.tick ----------------

def _mk_feed(poolfake, full_box, fast_box, monkeypatch):
    _pool_holder["pool"] = poolfake
    monkeypatch.setattr(stats_feed, "_get_admin_pool", lambda: poolfake)

    def full():
        full_box.append(1)
        return {"active_models": {"models": [], "total_active_requests": 0,
                                  "total_waiting_requests": 0},
                "uptime_seconds": 1.0}

    def fast():
        fast_box.append(1)
        return {"uptime_seconds": 1.0}
    monkeypatch.setattr(stats_feed, "_build_stats_raw", full)
    monkeypatch.setattr(stats_feed, "_build_stats_fast", fast)
    monkeypatch.setattr(stats_feed, "_build_alltime_raw", lambda: 0)
    feed = stats_feed.StatsFeed()          # NO injected builders: real split
    return feed


def test_shape_change_upgrades_the_next_tick_to_full(monkeypatch):
    full_box, fast_box = [], []
    entries = {}
    feed = _mk_feed(_Pool(entries), full_box, fast_box, monkeypatch)
    assert feed.tick() is True                      # first: full (slow None)
    assert len(full_box) == 1
    assert feed.tick() is False                     # shape stable: FAST tick
    assert len(full_box) == 1 and len(fast_box) == 1
    # a model starts loading: membership/flag shape moved -> force full
    entries["big"] = _Entry(None, is_loading=True)
    monkeypatch.setattr(stats_feed, "FULL_FLOOR_S", 0.0)
    assert feed.tick() is False                     # payload same -> no 's' bump? no:
    #   full build returns identical dict -> signature unchanged -> False,
    #   but the FULL builder RAN:
    assert len(full_box) == 2
    # loading -> loaded flips a flag: full again
    entries["big"] = _Entry(_Engine(core=_Core(_Sched())), is_loading=False)
    assert feed.tick() is False
    assert len(full_box) == 3
    # stable again: fast ticks only
    assert feed.tick() is False
    assert len(full_box) == 3 and len(fast_box) >= 2


def test_shape_probe_failure_keeps_the_cadence(monkeypatch):
    full_box, fast_box = [], []
    feed = _mk_feed(_Pool({}), full_box, fast_box, monkeypatch)
    feed.tick()
    monkeypatch.setattr(stats_feed, "FULL_FLOOR_S", 0.0)
    # entries dict resizes under the read (RuntimeError inside the probe)
    class _Evil:
        @property
        def _entries(self):
            raise RuntimeError("dict changed size during iteration")
    monkeypatch.setattr(stats_feed, "FULL_FLOOR_S", 0.0)
    _pool_holder["pool"] = _Evil()
    feed.tick()                                     # must not raise
    assert len(full_box) == 1                       # stayed on the slow cadence


def test_full_floor_bounds_forced_rebuilds(monkeypatch):
    full_box, fast_box = [], []
    entries = {"a": _Entry(_Engine(core=_Core(_Sched())))}
    feed = _mk_feed(_Pool(entries), full_box, fast_box, monkeypatch)
    feed.tick()                                     # full (cold)
    monkeypatch.setattr(stats_feed, "FULL_FLOOR_S", 60.0)   # floor not elapsed
    entries["b"] = _Entry(_Engine(core=_Core(_Sched())))     # shape moved
    feed.tick()
    assert len(full_box) == 1                       # floor held: no forced rebuild
    monkeypatch.setattr(stats_feed, "FULL_FLOOR_S", 0.0)
    feed.tick()
    assert len(full_box) == 2
