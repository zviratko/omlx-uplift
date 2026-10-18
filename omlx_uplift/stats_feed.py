"""STATS-SSE: the vanilla ``/admin/api/stats`` payload on uplift's own stream.

Why this exists: the dashboard polled ``GET /admin/api/stats`` every second
from EVERY focused tab (``uplift.js pollStats -> C.normalize(fetchJson())``).
Vanilla rebuilds that payload per request — an engine-pool walk, the SSD/hot
cache observability walk and the metrics snapshot — so N open boards cost N
rebuilds per second, over N HTTP round trips, and each round trip is a full
response (the client only ever consumes ~11 of its keys). One in-process
sampler, shared by all connections, does the identical work ONCE per tick
and rides the SSE that is already open: zero extra HTTP, zero extra socket
churn, and the per-tab cost drops out of the event loop entirely.

Transport: NOT a new endpoint. The existing 2 Hz stream
(``routers/metrics.py`` ``/metrics/stream``) GAINS two optional frame
fields — ``'s'`` (the stats payload, on (re)connect and whenever its
signature changed) and ``'sa'`` (the all-time request total, same rule).
Fields are only ADDED: a client that ignores them sees the byte-identical
pre-change stream, so an older dashboard against a newer server (and vice
versa) keeps working. Failure here can never break the 2 Hz sampler feed.

Change signature (the reason an idle board does not push 1 KB/s):
``uptime_seconds`` is the one field that moves every single tick (vanilla
rounds it to 0.1 s), so it is floored to whole minutes FOR THE SIGNATURE
only — the payload keeps the exact value. An idle board therefore pushes one
``'s'`` per minute; a board with traffic pushes naturally when a counter, a
model row or a cache number actually moved.

Payload keys are the EXACT vanilla names — the frozen client contract is
``core.js normalize()``, which reads nothing but (verified 2026-10-14):
the ``server_metrics.get_snapshot()`` scalars (total_requests,
total_tokens_served, total_prompt_tokens, total_completion_tokens,
total_cached_tokens, cache_efficiency, avg_prefill_tps,
avg_generation_tps, uptime_seconds), ``active_models`` (the whole
``_build_active_models_data()`` result — per-model and in-flight rows are
derived from it client-side) and ``runtime_cache`` (the whole
``_build_runtime_cache_observability()`` result). Deliberately NOT carried:
``host``/``port``/``cli_prefix`` (route decoration for the copyable command
line; normalize never reads them) and ``api_key`` — that one must not ride a
long-lived stream at all, it is a secret the poll only got because it is an
admin-authenticated response — plus ``engines`` (static package versions,
not read by normalize) and ``request_stats`` (an uplift-only key that the
vanilla route does not produce; normalize guards it to null either way).

Doctrine, spelled out because it is load-bearing:
* vanilla is reached IN-PROCESS (direct coroutine/function calls), never by
  loopback HTTP — uplift runs inside the same uvicorn app.
* The seams (``_build_stats_raw`` / ``_build_alltime_raw``) live HERE and
  soft-import omlx INSIDE themselves, so this module imports cleanly on a
  machine without omlx (the standalone viewer, CI) and is the one
  monkeypatch point for tests.
* Degradation is LOUD ONCE and then silent: if the very first build fails,
  exactly one honest log line names the reason and the feed stays off. A
  stream that quietly omits a lane is indistinguishable from a server that
  never had it, and the next person debugs the wrong layer.
* This is a DISPLAY path only: it never touches the collector's tick channel
  and never writes SQLite (same rule as FAST-1). The persisted series keeps
  its exact one-value-per-5 s shape no matter how many boards are open.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import threading
import time
from typing import Any, Callable, Optional

log = logging.getLogger("omlx_uplift.stats_feed")

# One build every two seconds. The payload's sources move at
# request-completion granularity (server_metrics counters), and the
# signature already suppresses idle frames — 1 Hz bought duplicates while
# the BUILD turned out to cost ~0.5-1.5 s of real work on a loaded engine
# pool (see LOOP-SAFE below), so the slower cadence is also the cheaper one.
STATS_TICK_S = 2.0
# Minimum rest the ticker gives the loop between builds even when a build
# overran its slot. Without a floor, a build slower than the tick makes
# sleep(0) continuous and one core disappears — the exact starvation this
# file's first edition shipped with (measured 2026-10-14: 30.07 CPU-s per
# 30 s wall on a vanilla board with one dashboard tab).
LOOP_REST_S = 0.25
# How long a fresh stream connection waits for the shared first build
# before its frame 1 goes out without 's'/'sa' (the client's poll fallback
# covers the gap; the ticker lands within one tick anyway).
SEED_WAIT_S = 5.0
# The engine-walk half of the payload (active models, runtime cache) moves
# at model-load / minute scale; the snapshot scalars move with traffic. One
# full build per this window, cheap fast rebuilds in between (each ~1 s of
# worker-thread walk costs ~7 % of a core at this cadence instead of 70 %).
SLOW_EVERY_S = 15.0
# Payload keys owned by the slow half; cached and merged under every fast
# rebuild so the frame shape is identical either way.
COMPOSITE_KEYS = ("active_models", "runtime_cache")
# ``uptime_seconds`` is excluded from the signature at this granularity
# (floored to whole minutes) — see the module docstring.
UPTIME_BUCKET_S = 60
# The ticker is lazy: it starts with the first subscribed stream connection
# and stops this long after the last one leaves. The grace is what makes a
# page refresh (unsubscribe + reconnect ~1 s later) free — otherwise every
# refresh would pay a cold first build — while a server nobody is looking at
# costs literally nothing.
IDLE_STOP_S = 30.0

# What normalize() demonstrably reads out of the snapshot part of the
# vanilla payload. Used only for the "the upstream snapshot shape moved"
# warning (see _check_snapshot_keys) — the shipped payload is the WHOLE
# snapshot, so a future upstream scalar rides automatically.
SNAPSHOT_KEYS = (
    "total_requests", "total_tokens_served", "total_prompt_tokens",
    "total_completion_tokens", "total_cached_tokens", "cache_efficiency",
    "avg_prefill_tps", "avg_generation_tps", "uptime_seconds",
)


# --------------------------------------------------------------------------
# the two vanilla seams (soft imports INSIDE; the monkeypatch point)
# --------------------------------------------------------------------------

def _vanilla_ready(admin_routes) -> bool:
    """Can vanilla build its own /admin/api/stats right now?

    Three of its collaborators are module GLOBALS that the admin app assigns
    at startup (``routes.py:1564-1567``: ``_get_server_state``,
    ``_get_engine_pool``, ``_get_global_settings`` — literally ``None`` on a
    fresh import). Vanilla's own route ignores that and would raise
    ``TypeError: 'NoneType' object is not callable`` -> a 500 on the poll;
    here the same state must degrade the LANE instead of propagating out of
    the ticker. Checked by attribute, not by call: a server that never
    finished init must not be poked.
    """
    for name in ("_build_active_models_data",
                 "_build_runtime_cache_observability",
                 "_get_engine_pool", "_get_server_state"):
        if not callable(getattr(admin_routes, name, None)):
            return False
    return True


def _build_stats_fast() -> Optional[dict]:
    """The cheap half of the stats payload: server_metrics snapshot scalars.

    One lock-guarded dict build — microseconds, safe to redo every tick.
    Returns None when vanilla is absent or refuses (same lane-degradation
    contract as _build_stats_raw).
    """
    from omlx.server_metrics import get_server_metrics

    metrics = get_server_metrics()
    if metrics is None:
        return None
    snapshot = metrics.get_snapshot(model_id="", scope="session")
    return _json_safe(dict(snapshot))


def _build_stats_slow() -> Optional[dict]:
    """The expensive half: active models + runtime cache observability.

    THIS is the multi-second walk (engine_pool.get_status() resolves each
    model's cluster key through Path.resolve(), twice). Vanilla's poll paid
    it per request; the feed pays it once per SLOW_EVERY_S, in a worker
    thread, and caches the composites between.
    """
    from omlx.admin import routes as admin_routes

    if not _vanilla_ready(admin_routes):
        return None
    payload: dict[str, Any] = {}
    payload["active_models"] = admin_routes._build_active_models_data()
    gs_getter = getattr(admin_routes, "_get_global_settings", None)
    global_settings = gs_getter() if callable(gs_getter) else None
    payload["runtime_cache"] = admin_routes._build_runtime_cache_observability(
        global_settings, model_filter="",
    )
    return _json_safe(payload)


def _build_stats_raw() -> Optional[dict]:
    """The FULL payload: cheap snapshot scalars + the expensive composites.

    This is what a first frame and every SLOW_EVERY_S full rebuild build;
    in between the ticker uses _build_stats_fast() merged over the cached
    composites (LOOP-SAFE duty-cycle split — the walk is ~1 s of engine
    pool + cluster path resolution, the snapshot is microseconds).
    Composition keeps ONE payload shape either way: same keys, same
    nesting, exactly the vanilla /admin/api/stats body minus the four
    route-decoration keys. Returns None when vanilla is absent or refuses:
    the caller degrades the LANE, never the stream. Called by the ticker
    and the shared seed — ALWAYS from a worker thread, never on the event
    loop (LOOP-SAFE).
    """
    from omlx.admin import routes as admin_routes

    if not _vanilla_ready(admin_routes):
        return None
    payload = _build_stats_fast()
    if payload is None:
        return None
    slow = _build_stats_slow()
    if slow is None:
        return None
    payload.update(slow)
    return payload


def _merge_audio(payload):
    """VOICE-15 seam: attach audio-engine activity to the stats payload.

    Soft import INSIDE (same rule as the other seams: this module must
    import cleanly where omlx is absent). The merge itself never raises —
    audio_activity.merge_stats guards and returns the payload unchanged."""
    from . import audio_activity

    return audio_activity.merge_stats(payload)


def _build_alltime_raw() -> Optional[int]:
    """All-time served request count (U27's 30 s ``scope=alltime`` poll,
    now a single int on the stream). None when unavailable; 0 is a REAL
    value (fresh server) and must not be confused with it — hence the
    explicit ``is not None`` checks instead of truthiness everywhere."""
    from omlx.server_metrics import get_server_metrics

    metrics = get_server_metrics()
    if metrics is None:
        return None
    total = metrics.get_snapshot(model_id="", scope="alltime").get("total_requests")
    if total is None:
        return None
    return int(total)


def _json_safe(payload: dict) -> dict | None:
    """Return a payload that plain ``json.dumps`` can serialise.

    The SSE frame uses ``json.dumps`` (not FastAPI's encoder), so a
    dataclass/set leaking out of an engine walk must not raise inside the
    generator and kill the 2 Hz stream — the exact failure mode this module
    must never cause. ``default=str`` renders anything else as its string
    form in the SAME pass: no second encoder walk, no inspect machinery
    (see the LOOP-SAFE note below). None is returned only for structures
    json truly cannot take (circular references) — the lane degrades.
    """
    try:
        return json.loads(json.dumps(payload, sort_keys=True, default=str))
    except (TypeError, ValueError):  # mixed-type keys / circular: degrade the lane
        return None
    # NO jsonable_encoder fallback (starvation fix): the encoder walked
    # payload objects through inspect/torch machinery — a cProfile capture
    # counted 137 ``_register_fake``/getsource -> realpath storms inside a
    # single 80 s window, i.e. the fallback cost was a second CPU sink on
    # the loop. ``default=str`` renders anything dumps cannot handle
    # (Path, datetime, dataclass) as its string form, which is exactly what
    # the client's defensive readers want anyway.


def stats_signature(payload: dict) -> str:
    """Comparable identity of a payload: every field exact EXCEPT
    ``uptime_seconds``, floored to whole minutes.

    The floor is applied to the SIGNATURE ONLY — ``payload`` itself keeps
    the exact value the vanilla route would have sent, so the client's
    uptime readout is no more stale than a poll's was. A non-numeric or
    missing uptime drops out of the signature instead of crashing it.
    """
    sig = dict(payload)
    up = sig.get("uptime_seconds")
    if isinstance(up, bool) or not isinstance(up, (int, float)) \
            or not math.isfinite(up):
        # A missing / non-numeric / nan-inf uptime drops OUT of the signature
        # rather than crashing the tick: the lane going silent because the
        # floor arithmetic threw would be worse than the field not counting
        # as a change signal.
        sig.pop("uptime_seconds", None)
    else:
        sig["uptime_seconds"] = int(float(up) // UPTIME_BUCKET_S) * UPTIME_BUCKET_S
    # _json_safe already canonicalised the payload, so dumps cannot raise
    # here; default=repr is the belt for a hand-built payload in a test.
    return json.dumps(sig, sort_keys=True, separators=(",", ":"), default=repr)


# --------------------------------------------------------------------------
# the shared ticker
# --------------------------------------------------------------------------

class StatsFeed:
    """ONE asyncio task per server building the payload every STATS_TICK_S
    for ALL subscribed stream connections.

    Cell semantics: ``_stats_ver`` / ``_alltime_ver`` bump only when the
    signature / value changed, so each generator diff-sends by version —
    the same trick the 'm' lane uses with its per-connection ``sent`` dict.

    LOOP-SAFE (starvation fix, 2026-10-14): the builders are NOT the
    "microseconds of dict math" the first edition claimed. A live engine
    pool makes one build walk ``engine_pool.get_status()`` TWICE (active
    models + runtime cache), and each walk resolves every model's cluster
    key through ``Path.resolve()`` — thousands of lstat/pathlib steps per
    second measured in a cProfile capture. Vanilla runs the same builders
    in its route THREADPOOL (sync def routes); calling them directly on
    the event loop pinned a core, queued every HTTP response behind it
    (2.5-6.5 s for 512 B) and drove the browser into EventSource reconnect
    storms. Every tick therefore runs via ``asyncio.to_thread``, the seed
    build is shared and awaited off-loop, and a hard ``LOOP_REST_S`` floor
    keeps a slow build from ever becoming a hot loop.
    """

    def __init__(self,
                 *,
                 stats_builder: Optional[Callable[[], Optional[dict]]] = None,
                 alltime_builder: Optional[Callable[[], Optional[int]]] = None,
                 stats_fast_builder: Optional[Callable[[], Optional[dict]]] = None,
                 tick_s: float = STATS_TICK_S,
                 idle_stop_s: float = IDLE_STOP_S) -> None:
        # None (the normal case) resolves the MODULE-LEVEL seams at call
        # time, which keeps monkeypatching ``stats_feed._build_stats_raw``
        # effective against an already-built singleton; an explicit builder
        # is the constructor-injection path used by unit tests. A custom
        # stats_builder also forces FULL ticks (the fast/slow split is an
        # optimization for the real vanilla seams, not for injected fakes).
        self._stats_builder = stats_builder
        self._alltime_builder = alltime_builder
        self._stats_fast_builder = stats_fast_builder
        self._tick = tick_s
        self._idle_stop_s = idle_stop_s

        self._lock = threading.Lock()
        self._task: Optional[asyncio.Task] = None
        self._task_loop: Optional[asyncio.AbstractEventLoop] = None
        self._subscribers = 0
        self._idle_since: Optional[float] = None

        # 's' cell
        self._payload: Optional[dict] = None
        self._sig: Optional[str] = None
        self._s_ver = 0
        self._s_at = 0.0
        # 'sa' cell
        self._alltime: Optional[int] = None
        self._a_ver = 0
        self._a_at = 0.0

        self._tried_first = False     # a first build has been attempted
        self._off = False             # feed degraded: never build again
        self._off_logged = False      # the ONE honest line has been said
        self._first_error: Optional[str] = None
        self._keys_warned = False     # snapshot-shape drift said once
        self._ticks = 0
        self._failures = 0
        # LOOP-SAFE guards: at most ONE builder walk runs at a time (ticker
        # and seed share it), and the seed task is created once, awaited by
        # any number of racing connections.
        self._build_lock = threading.Lock()
        self._seed_task: Optional["asyncio.Task[bool]"] = None
        # slow-half cache (LOOP-SAFE duty split): composites from the last
        # FULL build, merged under every fast rebuild in between.
        self._slow: Optional[dict] = None
        self._slow_at = 0.0

    # -- lifecycle ---------------------------------------------------------

    @property
    def subscribers(self) -> int:
        with self._lock:
            return self._subscribers

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def off(self) -> bool:
        return self._off

    def subscribe(self) -> None:
        """Take a reference; start the ticker on the FIRST subscriber.

        Must be called from inside the event loop (the generator does). A
        task left over from a DEAD loop — a test suite where every case gets
        its own loop, or a reload — is replaced instead of awaited on, which
        would raise 'attached to a different loop'.
        """
        loop = asyncio.get_running_loop()
        restart = False
        with self._lock:
            self._subscribers += 1
            self._idle_since = None          # reconnect inside the grace is free
            if self._task is not None and self._task_loop is not loop:
                # A task left on a DEAD loop (uvicorn reload, a test suite
                # that gives every case its own loop). Its connections died
                # with that loop — an SSE generator cannot outlive it — so
                # this is a NEW generation: reset the refcount to just us.
                # Without this the count drifts up per reload and the ticker
                # can never reach the idle stop.
                self._subscribers = 1
                dead, self._task, self._task_loop = self._task, None, None
                if dead is not None and not dead.done():
                    try:
                        dead.cancel()        # best effort; its loop may be gone
                    except RuntimeError:
                        pass
                restart = True
            elif self._task is not None and self._task.done():
                restart = True
            elif self._task is None:
                restart = True
        if restart and not self._off:
            self._start(loop)

    def unsubscribe(self) -> None:
        """Release a reference; the LAST one starts the idle-stop countdown
        (the ticker itself notices — no timer to leak or cancel)."""
        with self._lock:
            self._subscribers = max(0, self._subscribers - 1)
            if self._subscribers == 0 and self._idle_since is None:
                self._idle_since = time.monotonic()

    def _start(self, loop: asyncio.AbstractEventLoop) -> None:
        try:
            task = loop.create_task(self._run(), name="uplift-stats-feed")
        except RuntimeError as exc:      # loop already closing/closed
            self._log_offonce("cannot start (%s: %s)"
                              % (type(exc).__name__, exc))
            return
        with self._lock:
            if self._subscribers <= 0:
                # Raced away again: don't keep an orphan ticker for nobody.
                task.cancel()
                return
            self._task = task
            self._task_loop = loop

    def stop(self) -> None:
        """Hard stop (tests / shutdown): cancel and forget the refcount."""
        with self._lock:
            task, self._task, self._task_loop = self._task, None, None
            seed, self._seed_task = self._seed_task, None
            self._subscribers = 0
            self._idle_since = None
        if task is not None and not task.done():
            task.cancel()
        if seed is not None and not seed.done():
            seed.cancel()

    async def _run(self) -> None:
        rest_floor = min(LOOP_REST_S, self._tick)   # tests drive small ticks
        next_due = time.monotonic() + self._tick
        while True:
            # The rest floor is load-bearing: it turns "a build slower
            # than the tick" from a hot loop into a slower stats lane.
            # to_thread keeps the walk itself off the loop — even a
            # 10-second build only occupies a worker thread now.
            await asyncio.sleep(max(rest_floor,
                                    next_due - time.monotonic()))
            try:
                await asyncio.to_thread(self.tick)
            except Exception:      # never die on a bad tick — Collector rule
                self._failures += 1
                log.debug("stats feed tick failed", exc_info=True)
            with self._lock:
                idle = (self._subscribers <= 0 and self._idle_since is not None
                        and time.monotonic() - self._idle_since >= self._idle_stop_s)
            if idle or self._off:
                # Idle grace elapsed (reconnect within it re-starts lazily via
                # subscribe()) or the feed degraded: end the task, don't spin.
                with self._lock:
                    self._task = None
                    self._task_loop = None
                return
            next_due += self._tick
            if next_due < time.monotonic():       # overran: skip ahead
                next_due = time.monotonic() + self._tick

    # -- one tick / one read -----------------------------------------------

    def tick(self) -> bool:
        """Ticker entry (LOOP-SAFE duty split): the FULL build — including
        the multi-second engine-pool/cluster walk — runs at most once per
        ``SLOW_EVERY_S``; in between, only the snapshot scalars are rebuilt
        (microseconds) and merged over the cached composites. Injected
        builders (tests, standalone viewer) always take the full path: the
        split exists for the real vanilla seams only.
        """
        full = (self._stats_builder is not None
                or self._slow is None
                or time.monotonic() - self._slow_at >= SLOW_EVERY_S)
        return self.tick_once(full=full)

    def tick_once(self, *, full: bool = True) -> bool:
        """Rebuild both lanes and bump the version cells on change. Returns
        whether the 's' cell changed (the 'sa' lane is reported by ver).

        Thread-safe by construction (the ticker and the seed call it from
        worker threads). A build already in flight is SKIPPED, not queued:
        the walk is seconds of real work on a loaded pool, and stacking
        identical builds is exactly the waste this whole class exists to
        prevent.
        """
        if not self._build_lock.acquire(blocking=False):
            return False
        try:
            return self._tick_locked(full=full)
        finally:
            self._build_lock.release()

    def _tick_locked(self, *, full: bool = True) -> bool:
        alltime_b = self._alltime_builder or _build_alltime_raw
        stats: Optional[dict] = None
        if full:
            stats_b = self._stats_builder or _build_stats_raw
            stats = self._attempt(stats_b, "stats")
            if isinstance(stats, dict):
                self._slow_at = time.monotonic()
                self._slow = {k: stats[k] for k in COMPOSITE_KEYS
                              if k in stats}
        else:
            fast = self._attempt(self._stats_fast_builder or _build_stats_fast,
                                 "stats")
            if fast is not None:
                stats = {**(self._slow or {}), **fast}
        if stats is not None:
            # VOICE-15: audio-engine activity rides BOTH tiers — the fast
            # rebuild reuses the cached slow composite, and a 3-second
            # transcription must not wait up to SLOW_EVERY_S for the next
            # engine walk. merge_stats replaces rows, never mutates the
            # cache. Failures return the payload untouched.
            stats = _merge_audio(stats)
        alltime = self._attempt(alltime_b, "alltime")

        with self._lock:
            first = not self._tried_first
            self._tried_first = True
        if first and stats is None and alltime is None:
            # Both seams dead on the floor: this server cannot carry the
            # lanes. Say so ONCE with the reason and stay off — the stream
            # keeps running without 's'/'sa', which is exactly the
            # older-server behaviour a client must already tolerate.
            self._log_offonce(
                "vanilla stats unavailable (both seams returned None — omlx "
                "missing or its admin routes not initialised): the stream "
                "carries no 's'/'sa'")
            self._off = True
            return False

        changed = False
        now = time.time()
        with self._lock:
            self._ticks += 1
            if stats is not None:
                if not self._keys_warned:
                    missing = [k for k in SNAPSHOT_KEYS if k not in stats]
                    if missing:
                        # Upstream renamed/dropped a scalar the client maps:
                        # those readouts go null. Loud once, not per tick.
                        self._keys_warned = True
                        log.warning("stats feed: vanilla snapshot is missing "
                                    "%s — the matching cards read '—'",
                                    ", ".join(missing))
                sig = stats_signature(stats)
                if sig != self._sig:
                    self._sig = sig
                    self._payload = stats
                    self._s_ver += 1
                    self._s_at = now
                    changed = True
            if alltime is not None and alltime != self._alltime:
                self._alltime = alltime
                self._a_ver += 1
                self._a_at = now
        return changed

    def _attempt(self, builder: Callable[[], Any], what: str) -> Any:
        """Run one seam; an exception is a None (degrade, never propagate).
        A per-call exception is counted but NOT logged per second: a broken
        keg would otherwise write 86k lines a day to server.log. The one
        honest line is the both-dead case in tick_once()."""
        try:
            return builder()
        except Exception as exc:
            self._failures += 1
            if not self._off and not self._off_logged:
                # First failure of the very first attempt is the diagnosis
                # the off-line then quotes; keep only that one.
                with self._lock:
                    first = not self._tried_first
                if first and self._first_error is None:
                    # Only the FIRST seam's error is kept: both are attempted
                    # before _tried_first flips, so an unguarded assignment
                    # lets the alltime error overwrite (and mislabel) the
                    # stats one in the diagnosis line.
                    self._first_error = f"{what}: {type(exc).__name__}: {exc}"
            log.debug("stats feed %s seam failed", what, exc_info=True)
            return None

    def snapshot_now(self) -> dict:
        """The current cells — a lock-guarded read, NEVER a build.

        (The first edition built ON DEMAND here when the cells were empty,
        which ran multi-second vanilla walks synchronously on the event
        loop every 250 ms tick until the first seed landed. The
        first-frame guarantee moved to ``ensure_seeded``.)
        """
        with self._lock:
            return {"s": self._payload, "s_ver": self._s_ver, "s_at": self._s_at,
                    "sa": self._alltime, "sa_ver": self._a_ver, "a_at": self._a_at,
                    "off": self._off}

    async def ensure_seeded(self) -> None:
        """First-frame guarantee, off the loop: if the cells have never been
        built, run ONE tick in a worker thread and await it briefly.

        Every racing connection SHARES the same seed task; the await is
        capped at ``SEED_WAIT_S`` and a disconnect (generator CancelledError)
        never kills the build for the others. Frame 1 may legitimately lack
        's'/'sa' — the client keeps its slow fallback poll until the first
        real frame, so the cost of a slow board is latency on counters, not
        a frozen loop.
        """
        if self._off or (self._s_ver or self._a_ver):
            return
        loop = asyncio.get_running_loop()
        task = self._seed_task
        if task is None or task.done():
            task = loop.create_task(asyncio.to_thread(self.tick_once))
            self._seed_task = task
        try:
            await asyncio.wait_for(task, timeout=SEED_WAIT_S)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            # Timeout: frame 1 goes without the lane. Cancelled (disconnect):
            # the shield-less task keeps running for everyone else. Any
            # builder error is already counted and logged where it happened.
            pass

    def stats(self) -> dict:
        """Observability for /uplift/api/dev panels (and these tests)."""
        with self._lock:
            return {"running": self.running, "subscribers": self._subscribers,
                    "off": self._off, "tick_s": self._tick,
                    "s_ver": self._s_ver, "sa": self._alltime,
                    "sa_ver": self._a_ver,
                    "ticks": self._ticks,
                    "failures": self._failures,
                    "slow_age_s": (round(time.monotonic() - self._slow_at, 1)
                                   if self._slow is not None else None)}

    def _log_offonce(self, msg: str) -> None:
        """The ONE honest line (project logging doctrine forbids silent
        degradation) — guarded so a reconnecting dashboard cannot print it
        once per refresh."""
        with self._lock:
            if self._off_logged:
                return
            self._off_logged = True
            err = getattr(self, "_first_error", None)
        detail = f" (first seam error: {err})" if err else ""
        log.warning("stats feed disabled: %s%s — /metrics/stream keeps its "
                    "existing fields only", msg, detail)


_feed: Optional[StatsFeed] = None
_feed_lock = threading.Lock()


def get_stats_feed() -> StatsFeed:
    """Process-wide singleton: the whole point is ONE build per tick."""
    global _feed
    with _feed_lock:
        if _feed is None:
            _feed = StatsFeed()
        return _feed
