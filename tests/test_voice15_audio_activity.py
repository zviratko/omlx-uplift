"""VOICE-15 acceptance: engine activity visible on the dashboard.

The gap was NOT missing data — vanilla tracks every non-scheduler
operation (transcribing, streaming, realtime sessions, speech synthesis,
audio processing, embedding, reranking, deciding) through
BaseEngine._begin_activity, and admin's active-models rows carry it as
`activities` with active_requests bumps. Two things made it invisible:

1. uplift's stats feed rebuilds the active_models composite at most once
   per SLOW_EVERY_S (15 s) — a seconds-long transcription could start and
   finish between rebuilds, or only flash on whichever rebuild caught it;
2. the client mapped only prefilling/generating/waiting rows, so a model
   with activities but no scheduler rows rendered the literal "Idle" line.

Fix: stats_feed._refresh_activities() re-reads each engine's activity
snapshot from the pool on EVERY tier (the fast 2 Hz path included), and
uplift.js paints an .if-act sub-row (i18n labels for the known nine
details, raw server string otherwise), suppressing the Idle line.
"""
import types

import pytest

from omlx_uplift import stats_feed


class _Engine:
    def __init__(self, acts):
        self._acts = acts

    def get_activity_snapshot(self):
        return {"active_requests": len(self._acts), "activities": self._acts}


class _PlainEngine:                  # no snapshot method at all (LLM-ish)
    pass


class _Entry:
    def __init__(self, engine):
        self.engine = engine


class _Pool:
    def __init__(self, entries):
        self._entries = entries


def _payload(rows):
    return {"active_models": {
        "models": [dict(r) for r in rows],
        "total_active_requests": sum(r.get("active_requests", 0) for r in rows),
    }}


def _act(rid, detail, elapsed):
    return {"request_id": rid, "kind": detail.split()[0].lower(),
            "detail": detail, "elapsed_seconds": elapsed}


@pytest.fixture()
def pool(monkeypatch):
    routes = types.ModuleType("omlx.admin.routes")
    omlx = types.ModuleType("omlx")
    admin = types.ModuleType("omlx.admin")
    routes._get_engine_pool = lambda: _pool_holder["pool"]
    omlx.admin = admin
    admin.routes = routes
    monkeypatch.setitem(sys_modules, "omlx", omlx)
    monkeypatch.setitem(sys_modules, "omlx.admin", admin)
    monkeypatch.setitem(sys_modules, "omlx.admin.routes", routes)
    return _pool_holder


_pool_holder = {"pool": None}
sys_modules = __import__("sys").modules


def _set_pool(pool):
    _pool_holder["pool"] = pool


# --------------------------------------------------------------------------

def test_new_activity_lights_the_row_on_a_fast_tick(pool):
    eng = _Engine([_act("a1", "Transcribing", 0.4)])
    _set_pool(_Pool({"whisper": _Entry(eng)}))
    try:
        out = stats_feed._refresh_activities(_payload(
            [{"id": "whisper", "active_requests": 0, "activities": []}]))
        row = out["active_models"]["models"][0]
        assert [a["detail"] for a in row["activities"]] == ["Transcribing"]
        assert row["active_requests"] == 1
        assert out["active_models"]["total_active_requests"] == 1
    finally:
        _set_pool(None)


def test_elapsed_moves_every_tick(pool):
    eng = _Engine([_act("a1", "Realtime transcription", 1.0)])
    _set_pool(_Pool({"tiny": _Entry(eng)}))
    try:
        p1 = stats_feed._refresh_activities(_payload(
            [{"id": "tiny", "active_requests": 0, "activities": []}]))
        eng._acts[0]["elapsed_seconds"] = 3.0
        p2 = stats_feed._refresh_activities(p1)
        assert p2["active_models"]["models"][0]["activities"][0][
            "elapsed_seconds"] == 3.0
        assert p2["active_models"]["models"][0]["active_requests"] == 1  # no drift
    finally:
        _set_pool(None)


def test_gone_activity_clears_the_row(pool):
    eng = _Engine([])
    _set_pool(_Pool({"whisper": _Entry(eng)}))
    try:
        out = stats_feed._refresh_activities(_payload(
            [{"id": "whisper", "active_requests": 1,
              "activities": [_act("a1", "Synthesizing speech", 2.0)]}]))
        row = out["active_models"]["models"][0]
        assert row["activities"] == []
        assert row["active_requests"] == 0
        assert out["active_models"]["total_active_requests"] == 0
    finally:
        _set_pool(None)


def test_input_rows_never_mutated(pool):
    eng = _Engine([_act("a1", "Embedding", 0.2)])
    _set_pool(_Pool({"embed": _Entry(eng)}))
    try:
        payload = _payload([{"id": "embed", "active_requests": 0,
                             "activities": []}])
        row0 = payload["active_models"]["models"][0]
        out = stats_feed._refresh_activities(payload)
        assert "activities" in row0 and row0["activities"] == []  # list same, empty
        assert row0["active_requests"] == 0
        assert out["active_models"] is not payload["active_models"]
        assert out["active_models"]["models"][0] is not row0
    finally:
        _set_pool(None)


def test_unchanged_shape_is_a_noop_same_object(pool):
    acts = [_act("a1", "Transcribing", 5.0)]
    eng = _Engine(acts)
    _set_pool(_Pool({"w": _Entry(eng)}))
    try:
        payload = _payload([{"id": "w", "active_requests": 1,
                             "activities": [dict(a) for a in acts]}])
        assert stats_feed._refresh_activities(payload) is payload
    finally:
        _set_pool(None)


def test_batched_rows_keep_scheduler_counts(pool):
    """Delta-adjust only: a text model with 3 scheduler requests and no
    activities must come back untouched, and its activities (none) must
    not resurrect an empty-list rebuild."""
    eng = _PlainEngine()
    _set_pool(_Pool({"llm": _Entry(eng)}))
    try:
        payload = _payload([{"id": "llm", "active_requests": 3,
                             "activities": []}])
        assert stats_feed._refresh_activities(payload) is payload
    finally:
        _set_pool(None)


def test_engine_without_entry_or_snapshot_skipped(pool):
    _set_pool(_Pool({}))
    try:
        payload = _payload([{"id": "ghost", "active_requests": 0}])
        assert stats_feed._refresh_activities(payload) is payload
    finally:
        _set_pool(None)


def test_fails_open(pool):
    class Boom(_Engine):
        def get_activity_snapshot(self):
            raise RuntimeError("engine vanished mid-walk")

    _set_pool(_Pool({"w": _Entry(Boom([_act('a', 'x', 1)]))}))
    try:
        payload = _payload([{"id": "w", "active_requests": 1,
                             "activities": [_act('a', 'x', 1)]}])
        # the raising snapshot is skipped; the row stands as built
        assert stats_feed._refresh_activities(payload) is payload
    finally:
        _set_pool(None)

    _set_pool(None)                        # pool getter returns None
    assert stats_feed._refresh_activities(payload) is payload
    assert stats_feed._refresh_activities(None) is None


# --------------------------------------------------------------------------

def test_feed_calls_refresh_on_both_tiers(pool, monkeypatch):
    calls = []

    def fake_refresh(stats):
        calls.append(1)
        return {**stats, "refreshed": len(calls)}

    monkeypatch.setattr(stats_feed, "_refresh_activities", fake_refresh)
    feed = stats_feed.StatsFeed(
        stats_builder=lambda: {"x": 1, "active_models": {"models": []}},
        stats_fast_builder=lambda: {"y": 2},
        alltime_builder=lambda: 0, tick_s=0.01)
    feed.tick_once(full=True)
    assert feed.snapshot_now()["s"]["refreshed"] == 1
    feed.tick_once(full=False)
    assert feed.snapshot_now()["s"]["refreshed"] == 2   # the fast tier too
    feed.stop()
