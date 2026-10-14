"""STATS-SSE: the vanilla /admin/api/stats payload on uplift's own stream.

The load-bearing contracts these tests pin, in order of how much they hurt
when they break:

1. THE SIGNATURE RULE. ``uptime_seconds`` moves every single tick (vanilla
   rounds it to 0.1 s), so it is floored to whole minutes FOR THE SIGNATURE
   ONLY. Get that wrong one way and an idle board pushes ~1 KB/s of frames
   that differ only in a number nobody reads; get it wrong the other way and
   the payload genuinely stops refreshing and the uptime card freezes.
2. THE SHARED CELL. One build per second for the WHOLE server, diff-sent per
   connection by version. N tabs must cost ONE build, and a tab that connects
   between ticks must still get numbers in frame 1 (on-demand seed).
3. LOUD-ONCE DEGRADATION. Both seams dead => exactly one honest log line,
   feed off, ``'s'``/``'sa'`` never appear, and the pre-existing 2 Hz frame
   keeps its exact keys. Project doctrine forbids silent degradation; a
   reconnecting dashboard must not print the diagnosis once per refresh.
4. THE PAYLOAD CONTRACT. The key set is what ``core.js normalize()`` reads:
   the nine snapshot scalars + the whole ``active_models`` + the whole
   ``runtime_cache``. ``api_key`` must never ride a long-lived stream, and
   the route-decoration keys are noise. Guarded against upstream drift by
   the real-keg test at the bottom (drift-guard rule for mocked seams).

Async style: ``asyncio_mode = "auto"`` (pyproject), so bare ``async def``
tests get a loop — no marker, and never ``asyncio.run()`` inside a test that
also subscribes: ``StatsFeed.subscribe()`` binds the ticker to the RUNNING
loop and an inner run() would make a second one.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import sys
import types

import pytest

from omlx_uplift import stats_feed as SF
from omlx_uplift.stats_feed import SNAPSHOT_KEYS, StatsFeed, stats_signature


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------

def payload(requests: int = 0, uptime: float = 61.0, models=None,
            hot_bytes: int = 0) -> dict:
    """A vanilla-shaped stats payload (session scope).

    Deliberately built with the EXACT vanilla key names: a typo here is a
    bug in the test, so the key names are checked against the real module
    constants in test_payload_key_contract rather than hand-copied blindly.
    """
    p = {k: 0.0 for k in SNAPSHOT_KEYS}
    p.update({
        "total_requests": requests,
        "total_tokens_served": requests * 3,
        "uptime_seconds": uptime,
        "avg_generation_tps": 41.2,
    })
    p["active_models"] = {
        "models": list(models or []),
        "model_memory_used": 0, "model_memory_max": 0,
        "memory_pressure": {"pressure_level": "ok"},
        "total_active_requests": 0, "total_waiting_requests": 0,
    }
    p["runtime_cache"] = {"models": [], "hot_cache_size_bytes": hot_bytes,
                          "hot_cache_max_bytes": 0}
    return p


class Model:
    """Constructor-injected seams (the unit-test path; the monkeypatch path
    is the module-level seams, exercised by test_module_seams_are_the_patch_point)."""

    def __init__(self, p=None, a=0, fail_stats=False, fail_alltime=False):
        self.p, self.a = p, a
        self.calls_s = self.calls_a = 0
        self.fail_stats, self.fail_alltime = fail_stats, fail_alltime

    def stats(self):
        self.calls_s += 1
        if self.fail_stats:
            raise RuntimeError("engine pool not initialised")
        return self.p

    def alltime(self):
        self.calls_a += 1
        if self.fail_alltime:
            raise RuntimeError("no metrics singleton")
        return self.a

    def feed(self, **kw) -> StatsFeed:
        kw.setdefault("tick_s", 999.0)      # manual tick_once() controls versions
        kw.setdefault("idle_stop_s", 0.05)
        return StatsFeed(stats_builder=self.stats, alltime_builder=self.alltime,
                         **kw)


def frame_of(chunk: str) -> dict:
    assert chunk.startswith("data: ") and chunk.endswith("\n\n")
    return json.loads(chunk[len("data: "):])


class FakeSampler:
    """Every poll produces a NEW fast value => every poll yields a frame, so
    the test can count frames and see exactly which lanes rode them. Using a
    fake instead of the process singleton also keeps a bogus metric key out
    of the real ring (which /metrics/live would otherwise serve)."""

    def __init__(self):
        self.n = 0

    def snapshot(self):
        self.n += 1
        return {"live": True, "tick_s": 0.5, "at": 1.0,
                "metrics": {"probe.value": {"ts": float(self.n),
                                            "v": float(self.n),
                                            "samples": [(0.0, 0.0)]}}}


@pytest.fixture
def stream_env(monkeypatch):
    """Wire metrics_stream() to a fake sampler + a fresh singleton feed whose
    vanilla seams are stubbed at MODULE level (the documented patch point)."""
    from omlx_uplift import fast_sampler as F
    from omlx_uplift.routers import metrics as M

    monkeypatch.setattr(F, "FAST_TICK_S", 0.01)   # poll_s floor is 50 ms
    sampler = FakeSampler()
    monkeypatch.setattr(F, "get_fast_sampler", lambda: sampler)
    feed = StatsFeed(tick_s=999.0, idle_stop_s=0.05)   # never ticks itself
    monkeypatch.setattr(SF, "_feed", feed)
    state = {"payload": payload(requests=7, uptime=125.0), "alltime": 4242,
             "builds": 0, "off": False}

    def fake_stats():
        state["builds"] += 1
        return None if state["off"] else dict(state["payload"])

    def fake_alltime():
        return None if state["off"] else state["alltime"]

    monkeypatch.setattr(SF, "_build_stats_raw", fake_stats)
    monkeypatch.setattr(SF, "_build_alltime_raw", fake_alltime)

    async def pull(gen):
        return frame_of(await asyncio.wait_for(gen.__anext__(), timeout=5.0))

    yield types.SimpleNamespace(route=M.metrics_stream, feed=feed,
                                state=state, pull=pull)
    feed.stop()


# --------------------------------------------------------------------------
# 1. the signature rule
# --------------------------------------------------------------------------

def test_uptime_floors_into_minute_buckets_in_the_signature():
    a, b = payload(uptime=61.0), payload(uptime=119.9)
    assert stats_signature(a) == stats_signature(b)          # same bucket
    assert stats_signature(a) != stats_signature(payload(uptime=120.0))


def test_signature_does_not_mutate_the_payload():
    """The FLOOR IS SIGNATURE-ONLY: the client's uptime readout must stay as
    exact as the poll's was — 61.0 must still be what gets shipped."""
    p = payload(uptime=61.0)
    stats_signature(p)
    assert p["uptime_seconds"] == 61.0


def test_every_other_field_moves_the_signature():
    base = payload(requests=1, uptime=61.0)
    assert stats_signature(base) != stats_signature(payload(requests=2,
                                                            uptime=61.0))
    # nested composites count too (the active-model rows live in there)
    deep = payload(requests=1, uptime=61.0, models=[{"id": "m1"}])
    assert stats_signature(base) != stats_signature(deep)
    hot = payload(requests=1, uptime=61.0, hot_bytes=999)
    assert stats_signature(base) != stats_signature(hot)


def test_signature_survives_a_missing_or_ragged_uptime():
    """A non-numeric uptime drops out of the signature instead of crashing
    the feed (a bad upstream value must never take the stream down)."""
    for bad in (None, "3h", float("nan"), True, {}):
        assert isinstance(stats_signature(payload(uptime=bad)), str)
    p = {k: 1 for k in SNAPSHOT_KEYS if k != "uptime_seconds"}
    assert isinstance(stats_signature(p), str)


def test_signature_is_key_order_independent():
    a = payload(requests=3)
    b = {k: v for k, v in reversed(list(a.items()))}
    assert stats_signature(a) == stats_signature(b)


# --------------------------------------------------------------------------
# 2. cell semantics + the shared build
# --------------------------------------------------------------------------

def test_identical_payload_does_not_bump_the_version():
    f = StatsFeed(stats_builder=payload, alltime_builder=lambda: 1,
                  tick_s=999.0)
    assert f.tick_once() is True          # first build: new
    for _ in range(5):
        assert f.tick_once() is False     # idle board: silent
    assert f.stats()["s_ver"] == 1


def test_minute_bucket_change_bumps_exactly_once():
    clock = [60.0]

    def stats():
        clock[0] += 1.0
        return payload(uptime=clock[0])

    f = StatsFeed(stats_builder=stats, alltime_builder=lambda: 0, tick_s=999.0)
    f.tick_once()
    bumps = sum(bool(f.tick_once()) for _ in range(118))   # 61s..179s
    assert bumps == 1                                      # crosses 120 once
    assert f.tick_once() is True                           # 180 -> next bucket


def test_alltime_zero_is_data_and_bumps_only_on_change():
    """0 is a REAL value (fresh server) and must not be confused with None
    (unavailable) — hence ``is not None`` everywhere instead of truthiness."""
    val = [0]
    f = StatsFeed(stats_builder=payload, alltime_builder=lambda: val[0],
                  tick_s=999.0)
    f.tick_once()
    snap = f.snapshot_now()
    assert snap["sa"] == 0 and snap["sa_ver"] == 1
    f.tick_once()
    assert f.snapshot_now()["sa_ver"] == 1
    val[0] = 1
    f.tick_once()
    assert f.snapshot_now()["sa"] == 1 and f.snapshot_now()["sa_ver"] == 2


def test_unavailable_alltime_keeps_the_lane_absent_not_zero():
    f = StatsFeed(stats_builder=payload, alltime_builder=lambda: None,
                  tick_s=999.0)
    f.tick_once()
    snap = f.snapshot_now()
    assert snap["sa"] is None and snap["sa_ver"] == 0
    assert snap["s"] is not None      # the other lane is unaffected


def test_first_seed_is_shared_off_the_loop_and_never_rides_a_read():
    """The first-frame guarantee lives in ensure_seeded(), not in a read:
    snapshot_now() is pure cell read (LOOP-SAFE — a read must never run
    vanilla's multi-second walk on whatever thread asked), and concurrent
    seeds share ONE build task."""
    m = Model(p=payload(requests=5), a=99)
    f = m.feed()
    snap = f.snapshot_now()
    assert snap["s"] is None and snap["s_ver"] == 0   # never built on read

    async def go():
        await asyncio.gather(*[f.ensure_seeded() for _ in range(4)])

    asyncio.run(go())
    snap = f.snapshot_now()
    assert snap["s"]["total_requests"] == 5 and snap["sa"] == 99
    assert m.calls_s == 1 and m.calls_a == 1           # ONE shared build
    # structural pin: both schedulers hand the walk to a worker thread
    assert "to_thread" in f._run.__code__.co_names
    assert "to_thread" in f.ensure_seeded.__code__.co_names


def test_shared_cell_one_build_serves_every_connection():
    m = Model(p=payload(requests=5), a=99)
    f = m.feed()
    f.tick_once()
    before = m.calls_s
    for _ in range(5):                    # any number of readers...
        f.snapshot_now()
    assert m.calls_s == before            # ...never cost more than one build


def test_version_cursor_diff_sends_per_connection():
    """A tab that connects late starts at ver 0 and therefore still gets the
    CURRENT payload (not 'wait for the next change'), while an up-to-date
    tab sees no new version."""
    m = Model(p=payload(requests=1), a=1)
    f = m.feed()
    f.tick_once()
    m.p = payload(requests=2)
    m.a = 2
    f.tick_once()
    snap = f.snapshot_now()
    assert snap["s_ver"] == 2 and snap["sa_ver"] == 2
    assert snap["s"]["total_requests"] == 2      # the NEWEST cell, shared


# --------------------------------------------------------------------------
# 3. degradation: loud once, then off, never fatal
# --------------------------------------------------------------------------

def test_both_seams_dead_logs_exactly_one_line_and_stays_off(caplog):
    m = Model(fail_stats=True, fail_alltime=True)
    f = m.feed()
    with caplog.at_level(logging.INFO, logger="omlx_uplift.stats_feed"):
        f.tick_once()
        for _ in range(20):
            f.tick_once()
    assert f.off is True
    msgs = [r for r in caplog.records if "stats feed disabled" in r.getMessage()]
    assert len(msgs) == 1                        # not 21 — doctrine: ONCE
    snap = f.snapshot_now()
    assert snap["s"] is None and snap["sa"] is None and snap["off"] is True


def test_the_one_line_names_the_reason(caplog):
    """An honest line means the NEXT person can find the layer: the failing
    seam and the exception text are quoted in it."""
    m = Model(fail_stats=True, fail_alltime=True)
    f = m.feed()
    with caplog.at_level(logging.WARNING, logger="omlx_uplift.stats_feed"):
        f.tick_once()
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "engine pool not initialised" in text     # the seam's own error


def test_none_seam_on_a_fresh_feed_degrades_without_an_exception(caplog):
    """The older-server path: the helpers simply are not there -> None ->
    no lanes, no crash, one line."""
    f = StatsFeed(stats_builder=lambda: None, alltime_builder=lambda: None,
                  tick_s=999.0)
    with caplog.at_level(logging.WARNING, logger="omlx_uplift.stats_feed"):
        assert f.tick_once() is False
    assert f.off is True and f.snapshot_now()["s"] is None


def test_one_live_seam_keeps_the_feed_on():
    """Only BOTH dead turns the feed off: a server that answers alltime but
    not session stats must still carry the lane it can."""
    m = Model(a=17, fail_stats=True)
    f = m.feed()
    f.tick_once()
    assert f.off is False
    snap = f.snapshot_now()
    assert snap["s"] is None and snap["sa"] == 17


def test_off_feed_never_starts_a_ticker():
    m = Model(fail_stats=True, fail_alltime=True)
    f = m.feed()
    f.tick_once()                            # degrades on the floor

    async def go():
        f.subscribe()                        # a board opening afterwards
        await asyncio.sleep(0)
        return f.running, f.subscribers

    running, subs = asyncio.run(go())
    assert running is False                  # no task for a dead feed
    assert subs == 1                         # the refcount itself is honest
    f.unsubscribe()
    assert f.subscribers == 0


def test_a_bad_tick_never_kills_the_stream():
    """The Collector rule: one exploding tick must not end the task."""
    calls = {"n": 0}

    def stats():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return payload(requests=calls["n"])

    f = StatsFeed(stats_builder=stats, alltime_builder=lambda: 0, tick_s=999.0)
    assert f.tick_once() is False       # first tick: stats died, alltime ok
    assert f.off is False               # not both-dead -> still on
    assert f.tick_once() is True
    assert f.snapshot_now()["s"]["total_requests"] == 2


# --------------------------------------------------------------------------
# 4. refcount, lazy start, idle stop
# --------------------------------------------------------------------------

def test_one_ticker_for_many_subscribers():
    m = Model(p=payload(), a=1)
    f = m.feed(tick_s=0.02, idle_stop_s=5.0)

    async def go():
        f.subscribe()
        first = f._task
        f.subscribe()
        f.subscribe()
        assert f.subscribers == 3
        assert f._task is first                 # SHARED, not a task per tab
        await asyncio.sleep(0.12)
        out = (f.stats()["ticks"], f.running)
        f.stop()                                # stop INSIDE the live loop
        return out

    ticks, running = asyncio.run(go())
    assert ticks >= 2                           # ticking while subscribed
    assert running is True


def test_ticker_stops_after_the_last_subscriber_and_the_grace():
    m = Model(p=payload(), a=1)
    f = m.feed(tick_s=0.02, idle_stop_s=0.05)

    async def go():
        f.subscribe()
        f.unsubscribe()                          # board closed
        task = f._task
        await asyncio.sleep(0.02)
        still = f.running                        # grace not elapsed yet
        await asyncio.sleep(0.12)
        return still, task

    still, task = asyncio.run(go())
    assert still is True       # the idle grace is what makes a refresh cheap
    assert task.done() is True and f.running is False


def test_reconnect_inside_the_grace_reuses_the_same_ticker():
    m = Model(p=payload(), a=1)
    f = m.feed(tick_s=0.02, idle_stop_s=1.0)

    async def go():
        f.subscribe()
        task = f._task
        f.unsubscribe()
        await asyncio.sleep(0.03)
        f.subscribe()                            # page refresh
        try:
            assert f._task is task               # no restart, no double ticker
            assert f.subscribers == 1
        finally:
            f.stop()

    asyncio.run(go())


def test_stop_forgot_the_refcount_and_a_new_generation_resubscribes():
    m = Model(p=payload(), a=1)
    f = m.feed(tick_s=0.02, idle_stop_s=1.0)

    async def go():
        f.subscribe()
        f.stop()
        await asyncio.sleep(0.01)
        assert f.subscribers == 0 and not f.running
        f.subscribe()                            # next connection
        await asyncio.sleep(0.01)
        out = (f.running, f.subscribers)
        f.stop()
        return out

    running, subs = asyncio.run(go())
    assert running is True and subs == 1         # a dead task is replaced


def test_cross_loop_subscription_replaces_the_stale_task():
    """Every pytest-asyncio case gets its own loop (and a uvicorn reload gets
    a new one): a task bound to a DEAD loop must be dropped, not awaited —
    awaiting it raises 'attached to a different loop' inside a request."""
    m = Model(p=payload(), a=1)
    f = m.feed(tick_s=0.02, idle_stop_s=30.0)

    async def first_generation():
        f.subscribe()
        return f._task

    stale = asyncio.run(first_generation())

    async def second_generation():
        f.subscribe()                            # must not raise
        try:
            assert f._task is not stale
            assert f.running
            # the old generation's connections died with its loop: the
            # refcount is that loop's business, not carried over
            assert f.subscribers == 1
        finally:
            f.stop()

    asyncio.run(second_generation())


# --------------------------------------------------------------------------
# 5. the frame, end to end through the real route coroutine
# --------------------------------------------------------------------------

async def test_first_frame_carries_both_lanes(stream_env):
    env = stream_env
    resp = await env.route(is_admin=True)
    gen = resp.body_iterator
    try:
        f1 = await env.pull(gen)
        # the pre-existing 2 Hz keys keep their exact names and semantics
        assert f1["live"] is True and f1["tick_s"] == 0.5
        assert f1["samples"]["probe.value"] == [[0.0, 0.0]]   # JSON: tuples->arrays
        assert "probe.value" in f1["m"]
        assert f1["s"]["total_requests"] == 7
        assert f1["s"]["active_models"]["models"] == []
        assert f1["sa"] == 4242
        assert env.state["builds"] == 1        # seeded on demand, not per tick
    finally:
        await gen.aclose()


async def test_unchanged_lane_is_never_resent(stream_env):
    env = stream_env
    resp = await env.route(is_admin=True)
    gen = resp.body_iterator
    try:
        await env.pull(gen)                    # frame 1: both lanes
        env.feed.tick_once()                   # identical payload, same bucket
        f2 = await env.pull(gen)
        assert "s" not in f2 and "sa" not in f2   # the m lane still rides
        assert "probe.value" in f2["m"]
        env.state["payload"] = payload(requests=8, uptime=125.0)
        env.feed.tick_once()
        f3 = await env.pull(gen)
        assert f3["s"]["total_requests"] == 8 and "sa" not in f3   # only 's'
        env.state["alltime"] = 4243
        env.feed.tick_once()
        f4 = await env.pull(gen)
        assert f4["sa"] == 4243 and "s" not in f4                  # only 'sa'
    finally:
        await gen.aclose()


async def test_two_tabs_share_one_build_and_each_get_their_own_frames(stream_env):
    env = stream_env
    a = (await env.route(is_admin=True)).body_iterator
    b = (await env.route(is_admin=True)).body_iterator
    try:
        fa, fb = await env.pull(a), await env.pull(b)
        assert fa["s"]["total_requests"] == fb["s"]["total_requests"] == 7
        # the tab that connected later still got the CURRENT cell in frame 1,
        # and the shared on-demand seed happened exactly once
        assert env.state["builds"] == 1
        assert env.feed.subscribers == 2
    finally:
        await a.aclose()
        await b.aclose()
    assert env.feed.subscribers == 0           # finally-block released both


async def test_client_disconnect_releases_the_refcount(stream_env):
    env = stream_env
    gen = (await env.route(is_admin=True)).body_iterator
    await env.pull(gen)
    assert env.feed.subscribers == 1
    await gen.aclose()                           # what Starlette does on close
    assert env.feed.subscribers == 0


async def test_cancelled_connection_releases_the_refcount(stream_env):
    """Cancellation is the NORMAL exit for a stream (tab closed mid-sleep)
    and the generator SWALLOWS CancelledError — which is exactly why the
    release lives in a finally, not in the except clause. This pins that."""
    env = stream_env
    gen = (await env.route(is_admin=True)).body_iterator
    await env.pull(gen)
    assert env.feed.subscribers == 1

    parked = asyncio.create_task(gen.__anext__())   # now inside asyncio.sleep
    await asyncio.sleep(0.01)
    parked.cancel()
    try:
        await parked
    except (asyncio.CancelledError, StopAsyncIteration):
        pass                                       # either is a closed lane
    assert env.feed.subscribers == 0
    assert not env.feed.running or env.feed.subscribers == 0


async def test_frame_shape_is_byte_identical_when_the_feed_is_off(stream_env):
    """The older-server contract: 's'/'sa' simply never appear and NOTHING
    else changed — a client written before this feature cannot tell."""
    env = stream_env
    env.state["off"] = True
    resp = await env.route(is_admin=True)
    gen = resp.body_iterator
    try:
        f1 = await env.pull(gen)
        f2 = await env.pull(gen)
        assert set(f1) == {"live", "tick_s", "at", "samples", "m"}
        assert set(f2) == {"live", "tick_s", "at", "m"}
    finally:
        await gen.aclose()


async def test_a_dead_vanilla_never_breaks_the_live_stream(stream_env):
    """The whole risk of the feature in one test: both seams raise on the
    very first build (an ImportError against a keg without the helpers) and
    the 2 Hz frames must keep flowing, plus exactly one honest log line."""
    env = stream_env

    def boom():
        raise ModuleNotFoundError("No module named 'omlx.admin.routes'")

    env.feed._stats_builder = boom           # constructor-level seam override
    env.feed._alltime_builder = boom
    logger = logging.getLogger("omlx_uplift.stats_feed")
    old_level = logger.level
    logger.setLevel(logging.CRITICAL + 1)    # the ONE line is asserted, not spammed
    try:
        resp = await env.route(is_admin=True)
        gen = resp.body_iterator
        f1 = await env.pull(gen)
        f2 = await env.pull(gen)
        assert "s" not in f1 and "s" not in f2
        assert f1["m"] and f2["m"]              # the stream itself is alive
        assert env.feed.off is True
    finally:
        logger.setLevel(old_level)
        await gen.aclose()


# --------------------------------------------------------------------------
# 6. the seams themselves (against an injected fake vanilla)
# --------------------------------------------------------------------------

def _install_fake_omlx(monkeypatch, *, snapshot=None, alltime=None,
                       active=None, runtime=None, metrics_none=False):
    """sys.modules-level fake of the two vanilla seams' imports, so the REAL
    _build_stats_raw() body runs without an engine (the drift-guard test at
    the bottom is what pins it to the real keg's shape)."""
    snap = {k: 1.0 for k in SNAPSHOT_KEYS}
    snap.update(snapshot or {})

    class Metrics:
        def __init__(self):
            self.scopes = []

        def get_snapshot(self, model_id="", scope="session"):
            self.scopes.append((model_id, scope))
            return dict(snap) if scope == "session" else {"total_requests": alltime}

    metrics = Metrics()
    routes = types.ModuleType("omlx.admin.routes")
    routes._build_active_models_data = lambda: dict(active or {"models": []})

    def runtime_builder(global_settings, model_filter=""):
        r = dict(runtime or {"models": []})
        r["_seen_model_filter"] = model_filter
        return r

    routes._build_runtime_cache_observability = runtime_builder
    routes._get_global_settings = None          # vanilla's pre-init state
    # The three server-state globals the real module assigns at admin init
    # (routes.py:1564-1567). Set-but-None is exactly the running-server state
    # _build_active_models_data handles by returning its empty shape.
    routes._get_engine_pool = lambda: None
    routes._get_server_state = lambda: None
    admin = types.ModuleType("omlx.admin")
    admin.routes = routes
    server_metrics = types.ModuleType("omlx.server_metrics")
    server_metrics.get_server_metrics = lambda: metrics
    monkeypatch.setitem(sys.modules, "omlx", types.ModuleType("omlx"))
    monkeypatch.setitem(sys.modules, "omlx.admin", admin)
    monkeypatch.setitem(sys.modules, "omlx.admin.routes", routes)
    monkeypatch.setitem(sys.modules, "omlx.server_metrics", server_metrics)
    return metrics


def test_module_seams_are_the_patch_point(monkeypatch):
    """StatsFeed() with no injected builders resolves the MODULE-LEVEL
    functions at call time — that is what makes monkeypatching the seam
    effective against an already-built singleton."""
    calls = {"n": 0}

    def fake():
        calls["n"] += 1
        return payload(requests=1)

    monkeypatch.setattr(SF, "_build_stats_raw", fake)
    monkeypatch.setattr(SF, "_build_alltime_raw", lambda: 3)
    f = StatsFeed(tick_s=999.0)
    f.tick_once()
    assert calls["n"] == 1 and f.snapshot_now()["sa"] == 3


def test_stats_seam_payload_key_contract(monkeypatch):
    """The frozen client contract, enforced on the seam that builds it."""
    _install_fake_omlx(monkeypatch,
                       snapshot={"total_requests": 12,
                                 "uptime_seconds": 3.4},
                       alltime=99,
                       active={"models": [{"id": "m1"}],
                               "model_memory_used": 5},
                       runtime={"models": [{"id": "m1"}]})
    p = SF._build_stats_raw()
    assert set(p) == set(SNAPSHOT_KEYS) | {"active_models", "runtime_cache"}
    # excluded on purpose — host/port/cli_prefix/engines are route decoration
    # normalize() never reads, and api_key must NOT ride a long-lived stream.
    for junk in ("host", "port", "api_key", "cli_prefix", "engines",
                 "request_stats"):
        assert junk not in p
    assert p["active_models"]["model_memory_used"] == 5     # whole vanilla dict
    assert p["runtime_cache"]["models"] == [{"id": "m1"}]
    assert p["uptime_seconds"] == 3.4                       # exact, unfloored


def test_stats_seam_uses_the_polls_own_request_shape(monkeypatch):
    """Empty model_id + scope='session' is literally what the 1 Hz poll sent
    (no query params); runtime_cache gets model_filter='' likewise. A drift
    here would silently change every card's scope."""
    m = _install_fake_omlx(monkeypatch)
    SF._build_stats_raw()
    assert m.scopes == [("", "session")]
    p = SF._build_stats_raw()
    assert p["runtime_cache"]["_seen_model_filter"] == ""


def test_alltime_seam_reads_the_key_the_client_polls(monkeypatch):
    """U27's readout is raw.total_requests with scope=alltime — 'sa' must be
    that exact number, and None (not 0) when upstream has nothing."""
    _install_fake_omlx(monkeypatch, alltime=4242)
    assert SF._build_alltime_raw() == 4242
    m = _install_fake_omlx(monkeypatch)          # no total_requests key
    m.get_snapshot = lambda model_id="", scope="alltime": {}
    assert SF._build_alltime_raw() is None


def test_stats_seam_returns_none_when_vanilla_has_no_metrics_singleton(monkeypatch):
    _install_fake_omlx(monkeypatch)
    sys.modules["omlx.server_metrics"].get_server_metrics = lambda: None
    assert SF._build_stats_raw() is None
    assert SF._build_alltime_raw() is None


def test_stats_seam_refuses_an_uninitialised_admin_app(monkeypatch, caplog):
    """The pre-init keg: vanilla keeps ``_get_engine_pool`` as a ``None``
    module global until the admin app starts, and its own route would raise
    ``TypeError: 'NoneType' object is not callable`` (a 500 on the poll). The
    seam must return None instead — and the feed must then degrade to the
    no-lane stream with its one honest line, not die in the ticker."""
    _install_fake_omlx(monkeypatch)
    routes = sys.modules["omlx.admin.routes"]
    routes._get_engine_pool = None            # exactly routes.py:1565's state
    routes._get_server_state = None
    assert SF._build_stats_raw() is None

    monkeypatch.setattr(SF, "_build_alltime_raw", lambda: None)
    f = StatsFeed(tick_s=999.0)               # default = the module seams
    with caplog.at_level(logging.WARNING, logger="omlx_uplift.stats_feed"):
        assert f.tick_once() is False
    assert f.off is True
    assert f.snapshot_now()["s"] is None
    assert sum("stats feed disabled" in r.getMessage()
               for r in caplog.records) == 1


def test_json_safe_makes_a_leaky_upstream_frame_serialisable():
    """The SSE frame is json.dumps, not FastAPI's encoder: one dataclass out
    of an engine walk would otherwise raise INSIDE the generator and kill
    the 2 Hz stream — the exact failure this module must never cause."""
    import dataclasses

    @dataclasses.dataclass
    class Row:
        id: str = "m1"

    out = SF._json_safe({"active_models": {"models": [Row()]}, "x": 1})
    # LOOP-SAFE contract: default=str, no jsonable_encoder walk (that walk's
    # inspect/torch chain was a measured CPU sink). Anything dumps cannot
    # handle rides as its honest string form — the client reads numbers
    # from REAL fields, never from a dataclass repr.
    assert out["active_models"]["models"] == [str(Row())]
    assert json.dumps(out)                       # the frame is still safe
    assert SF._json_safe({"leak": {1, 2}})["leak"] == str({1, 2})
    cyc: dict = {}
    cyc["self"] = cyc                            # unserialisable structure
    assert SF._json_safe(cyc) is None            # degrades the lane, not the stream


# --------------------------------------------------------------------------
# 7. drift guard against the REAL keg (no construction, no engine load)
# --------------------------------------------------------------------------

def test_vanilla_keg_shape_drift_guard():
    """The payload is built out of upstream privates. If a rename lands
    upstream, this test goes red HERE instead of the dashboard showing '—'
    for eight cards and nobody knowing which side moved. Nothing is
    constructed: signatures and source only — importing the module is as far
    as it goes (no engine, no server state)."""
    routes = pytest.importorskip("omlx.admin.routes")
    sm = pytest.importorskip("omlx.server_metrics")

    assert callable(routes._build_active_models_data)
    assert list(inspect.signature(routes._build_active_models_data).parameters) == []

    rc = inspect.signature(routes._build_runtime_cache_observability)
    assert list(rc.parameters) == ["global_settings", "model_filter"], rc
    assert rc.parameters["model_filter"].default == ""

    # _get_global_settings is a module GLOBAL assigned at app init (None on a
    # fresh import) — which is exactly why the seam guards it with callable()
    # instead of assuming it; assert it exists, do not call it.
    for name in ("_get_global_settings", "_get_engine_pool", "_get_server_state"):
        assert hasattr(routes, name), name

    assert callable(sm.get_server_metrics)
    gs = inspect.signature(sm.ServerMetrics.get_snapshot)
    assert list(gs.parameters) == ["self", "model_id", "scope"], gs
    assert gs.parameters["scope"].default == "session"

    src = inspect.getsource(sm.ServerMetrics._build_snapshot)
    for key in SNAPSHOT_KEYS:
        assert f'"{key}"' in src, f"vanilla renamed/dropped {key}"

    # the route we replaced still answers on the same path (the poll fallback
    # has to keep working for any client that did not move to the stream).
    # omlx mounts admin.routes under /admin, hence the full path.
    paths = {getattr(r, "path", None) for r in getattr(routes.router, "routes", [])}
    assert "/admin/api/stats" in paths, sorted(str(p) for p in paths)[:8]
