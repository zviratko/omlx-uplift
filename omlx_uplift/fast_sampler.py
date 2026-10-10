"""FAST-1: high-frequency sampling into memory — display only, never stored.

Why this exists: the collector tick is 5 s, so the Throughput and Queue
charts cannot resolve anything shorter than 5 s even though their sources
update every engine step (``Request.num_output_tokens`` grows per token;
the prefill tracker fires per chunk). The user asked for ~2 Hz display
while the PERSISTED series keeps its exact 5 s, one-value-per-tick shape.

The split that makes this safe (the trap this module exists to avoid):
every rate family divides by its own ``dt`` — the time since ITS last
drain. If the 500 ms walk drained the same accumulator, the stored 5 s
value would silently become a 500 ms window at the same row count: the DB
would look unchanged while every ``*.tokens_s`` series meant something
different (and the hourly backfill, which assumes the 5 s definition,
would disagree with the live layer). So the fast sampler feeds the
accumulators through a SECOND, window-scaled drain (``window_s=0.5``) that
touches only the rate they display; the 5 s tick keeps its own drain
(``window_s=None`` -> the full accumulation window, unchanged semantics).

What runs at 500 ms (measured cost, all in-process, no I/O, no fork):
* decode walk + drain        ~0.002 ms per 20 in-flight rows
* prefill drain              ~0.001 ms (event-driven accumulator)
* queue.* + engines gauges   ~0.005 ms per loaded model (asdict walk)
* mem.used_bytes (enforcer)  ~0.01 ms   — ceilings are NOT read here
* sys.used_bytes (psutil)    ~0.003 ms
Deliberately NOT fast-sampled: ``rate.*`` and the ``avg_*`` passthrough
(their source counters update only at request COMPLETION — 10x the
sampling buys 9 identical readings and one misleading spike); macmon
power/thermal (vendor cadence is 1 s, the card is honest at 5 s — user
decision 2026-10-06); the absolute memory ceilings (kernel constants —
see collectors.ceilings_cache).

Transport: an in-memory ring per key, read by the SSE stream
(routers/metrics.py /metrics/stream) and the snapshot endpoint
(/metrics/live). Nothing here ever writes to SQLite; the store keeps
exactly the samples the 5 s tick gives it.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

log = logging.getLogger("omlx_uplift.fast_sampler")

FAST_TICK_S = 0.5
# Ring retention: the dashboard caps a live-resolution window at 5 m
# (user: 15 m was too long; the timeframe chips that keep 5 s resolution
# are honest at their own cadence). 6 m leaves the 5 m window whole with
# margin for a slow reconnect replay.
RING_S = 360.0
RING_CAP = int(RING_S / FAST_TICK_S) + 8     # 728 points/key worst case
# A key that stopped being sampled (collector restart) ages out of reads.
STALE_S = 15.0


class FastSampler:
    """2 Hz collector loop writing into per-key in-memory rings.

    State the 5 s Collector owns is NOT duplicated: the decode row walk
    needs the pool, and the sampler accumulators are shared (that is the
    point — same tokens, two drain windows). The fast loop runs on its own
    thread: the walk is pure reads of GIL-atomic structures, and the
    accumulators are lock-guarded, so no asyncio-loop interference and no
    dependence on the event loop staying responsive.
    """

    def __init__(self, tick_s: float = FAST_TICK_S):
        self._tick = tick_s
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._rings: dict[str, list[tuple[float, float]]] = {}
        self._last_write = 0.0
        self._errors = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name="uplift-fast-sampler")
        self._thread.start()
        log.info("uplift fast sampler started (%.1fs tick, memory-only)",
                 self._tick)

    def stop(self) -> None:
        self._stop.set()
        t, self._thread = self._thread, None
        if t is not None and t.is_alive():
            t.join(timeout=2.0)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _loop(self) -> None:
        # DEADLINE scheduling (SMOOTH-2, user 2026-10-10: "the 2hz timing
        # is not very accurate"): the old loop slept a fixed tick AFTER
        # finishing work, so every sample landed at tick + work + GIL
        # handoff (measured 585-650 ms on kocour) and the x-axis vertices
        # carried that spacing noise. Samples now land on a fixed grid of
        # t0 + n*tick: the wait runs until the NEXT deadline, and a tick
        # that overruns (a huge batch walk, a paused process) skips ahead
        # to the next future deadline instead of bursting — an honest
        # missed sample beats a fake cluster. sample_once gets the NOMINAL
        # ts so the rings and the drain windows ride the exact grid.
        next_due = time.monotonic() + self._tick
        # first sample_only() seeds prev-state; its rates are dropped (dt=0)
        while not self._stop.wait(max(0.0, next_due - time.monotonic())):
            now_nominal = time.time() + (next_due - time.monotonic())
            try:
                self.sample_once(now=now_nominal)
            except Exception:  # never die on a bad tick — same rule as Collector
                self._errors += 1
                log.debug("fast sampler tick failed", exc_info=True)
            next_due += self._tick
            if next_due < time.monotonic():       # overran: skip ahead
                next_due = (time.monotonic()
                            + self._tick * (1 + int((time.monotonic() - next_due)
                                                    // self._tick)))

    # -- one fast tick -------------------------------------------------------

    def sample_once(self, *, now: Optional[float] = None) -> dict[str, float]:
        """Sample every fast-capable family, push into the rings, return the
        pairs (the seam tests call this directly and read the result).

        Shares the family functions with the 5 s Collector; the ONLY
        difference is the drain window: window_s=self._tick makes each
        rate divide by the fast dt, leaving the accumulator's own
        full-window drain (5 s tick, window_s=None) mathematically
        untouched — every token is still credited exactly once per drain
        path, the paths just cover different spans.
        """
        from . import collectors

        now = time.time() if now is None else now
        pairs: dict[str, float] = {}

        try:
            from .router import engine_pool

            pool = engine_pool()
        except Exception:
            pool = None

        # Queue/engines gauges — same walk the 5 s tick does (point-in-time,
        # genuinely faster-samplable).
        if pool is not None:
            try:
                pairs.update(collectors.collect_engines(pool))
            except Exception:
                log.debug("fast engines collect failed", exc_info=True)
            try:
                fam, _ = collectors.collect_cache(
                    pool, prev_ctr={}, dt=self._tick, rates=False)
                pairs.update(fam)
            except Exception:
                log.debug("fast queue collect failed", exc_info=True)
            try:
                pairs.update(collectors.collect_memory_used(pool))
            except Exception:
                log.debug("fast memory_used collect failed", exc_info=True)

        # Momentary decode rate: walk the in-flight rows and drain the
        # shared accumulator through the FAST channel, so the 5 s tick's
        # drain keeps its exact span (per-channel baselines).
        try:
            pairs.update(collectors.collect_generation(
                pool, now=now, channel="fast"))
        except Exception:
            log.debug("fast generation collect failed", exc_info=True)

        # Prefill rate: event-driven accumulator, fast channel only.
        try:
            from .prefill_sampler import get_prefill_sampler

            pairs.update(get_prefill_sampler().drain(now=now,
                                                     channel="fast"))
        except Exception:
            log.debug("fast prefill drain failed", exc_info=True)

        # MTP accepted rate: per-channel drain (same monotonic-total
        # doctrine as decode), so the Throughput stack's MTP edge moves
        # at 2 Hz while the 5 s tick keeps its exact stored window. The
        # windowed percent/distribution keys stay on the tick channel.
        try:
            pairs.update(collectors.collect_mtp_fast(pool, now=now))
        except Exception:
            log.debug("fast mtp drain failed", exc_info=True)

        # System memory (psutil — in-process, cheap, moves continuously).
        try:
            pairs.update(collectors.collect_system_memory())
        except Exception:
            log.debug("fast system memory collect failed", exc_info=True)

        self._push(pairs, now=now)
        return pairs

    # -- ring storage ----------------------------------------------------------

    def _push(self, pairs: dict[str, float], *, now: float) -> None:
        with self._lock:
            self._last_write = now
            for k, v in pairs.items():
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                ring = self._rings.setdefault(k, [])
                ring.append((now, fv))
                if len(ring) > RING_CAP:
                    del ring[:len(ring) - RING_CAP]
            # keys that vanished (engines unloaded): age out by ring span
            cutoff = now - RING_S
            for k in [k for k, r in self._rings.items() if not r or r[-1][0] < cutoff]:
                self._rings.pop(k, None)

    def snapshot(self) -> dict:
        """{key: {ts, v, samples: [[ts, v], ...]}} — newest value plus the
        whole ring, for the SSE stream's first frame and /metrics/live."""
        now = time.time()
        with self._lock:
            out = {}
            for k, ring in self._rings.items():
                if not ring:
                    continue
                ts, v = ring[-1]
                out[k] = {"ts": ts, "v": v,
                          "samples": ring if now - ts <= STALE_S else []}
            return {"live": True if self.running else False,
                    "tick_s": self._tick, "at": now,
                    "last_write": self._last_write, "metrics": out}

    def latest(self) -> dict:
        """Newest value per key only (cheap frame for the SSE stream)."""
        with self._lock:
            out = {}
            for k, ring in self._rings.items():
                if ring:
                    out[k] = ring[-1]
            return out

    def stats(self) -> dict:
        with self._lock:
            return {"running": self.running, "tick_s": self._tick,
                    "keys": len(self._rings), "errors": self._errors}


_sampler: Optional[FastSampler] = None
_sampler_lock = threading.Lock()


def get_fast_sampler() -> FastSampler:
    global _sampler
    with _sampler_lock:
        if _sampler is None:
            _sampler = FastSampler()
        return _sampler
