"""BE-decode: momentary generation (decode) token rate, per collector tick.

Why not ``avg_generation_tps`` (the old Throughput chart line): upstream
``ServerMetrics.avg_generation_tps`` is a SESSION-LIFETIME AVERAGE —
``total_completion_tokens / total_generation_duration`` accumulated since
boot, and ``record_request_complete()`` fires ONLY when a request finishes.
The 5 s tick is then a photo of a heavily smoothed mean: one short
generation cannot move it, and a long one only lands at its end. The user
reported exactly this ("the graph is a flat line, like the stats were
cumulative, while this is a momentary value") — the line is cumulative
arithmetic, so it ramps and never tracks what the engine decodes NOW.

Why not ``rate.completion_tokens_s`` (already collected): its source counter
is fed at request COMPLETION, so one long generation appears as a single
spike at its end instead of a sustained rate. Same dilution defect, one
layer down.

Source: the scheduler's per-request decode counter. ``Request.num_output_tokens``
is ``len(self.output_token_ids)`` — monotonic and progressive, it grows every
step, so a per-tick delta over the in-flight set IS the current rate.

Coverage rules (mirrors prefill_sampler.py; tests/test_decode_sampler.py):

* per-tick walk credits ``count - last_credited`` for every in-flight row;
* ``note_end(rid, final_tokens)`` from the engine-core departure hook
  credits the TAIL between the last tick and the final count. Without it a
  request born and finished inside one 5 s window would contribute NOTHING
  (the tick walk cannot see it) — the exact sub-tick blind spot that made
  the old gauge metrics miss short events;
* already-credited tokens are never double-counted: the departure tail is
  ``max(0, final - last_credited)``;
* a recycled request id (final/observed count BACKWARD) restarts accrual
  and credits the new count, same rule as the prefill sampler;
* zeros are ALWAYS written — a drained engine is a data point, and skipping
  zeros truncated the series at the moment generation stopped (line died
  exactly when the model went idle);
* an unreadable row count (upstream attribute drift) is skipped for that
  tick, never credited as zero and never raised into the collector.

Stored series: ``generation.tokens_s`` — decoded tokens/s per collector
tick. Session-scoped like every other uplift metric: the engine's counters
reset with the process. ``avg_generation_tps`` STAYS collected — it is the
classic session average the small card and the tile legitimately show.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

log = logging.getLogger("omlx_uplift.decode_sampler")

KEY_GENERATION_TOKENS = "generation.tokens_s"
GENERATION_KEY_PREFIX = "generation."

# Rows with no observation for this long are dropped: an id can be reused
# much later, and a stale row would then credit a whole fresh generation as
# a delta against the old count. Any real decode updates far faster.
ROW_STALE_S = 300.0
# Bounded bookkeeping — a departed row that never reached note_end (upstream
# layout drift) must not grow the map for ever.
MAX_TRACKED = 4096


class DecodeSampler:
    """Accumulator: per-request decode counters in, per-tick tok/s out.

    ``sample_running()`` runs on the collector thread; ``note_end()`` runs
    on the engine thread. One lock, no I/O, O(rows) per tick.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # rid -> (credited_tokens, last_seen) — credited_tokens is what the
        # series has ALREADY been fed for this request, so neither the tick
        # walk nor the departure flush can count a token twice.
        self._rows: dict[str, tuple[int, float]] = {}
        self._acc = 0.0                # tokens credited, not yet drained
        self._since: Optional[float] = None

    # ---- collector thread ----------------------------------------------

    def sample_running(self, rows: Any, *, now: Optional[float] = None) -> None:
        """Credit the in-flight set. ``rows`` iterates (key, num_output_tokens).

        ``key`` must be stable for the request's lifetime AND unique across
        engines: upstream request ids carry no global-uniqueness guarantee,
        so two loaded models could otherwise share a row and credit each
        other's tokens. Callers compose model id + request id.

        Best-effort by contract: any junk the upstream hands us is skipped,
        never raised — a telemetry walk must not be able to break a tick.

        FIRST SIGHT BASELINES AND CREDITS NOTHING: a row the walk sees for
        the first time may already carry tokens generated BEFORE this tick
        window (a request born between two walks, or in flight when the
        hooks were installed). Crediting its full count would dump a
        lifetime number into one tick — the cumulative lie this series
        exists to replace. Only growth observed BETWEEN ticks is credited;
        a request born AND finished inside one window is invisible to the
        walk and credited IN FULL by note_end, the event path that cannot
        miss it.
        """
        if rows is None:
            return
        now = time.time() if now is None else now
        try:
            with self._lock:
                for rid, count in rows:
                    if not rid:
                        continue
                    if count is None:
                        # Attribute drift: skip this row for this tick.
                        # Crediting it as 0 would reset the row's credited
                        # total and double-count the generation at note_end.
                        continue
                    try:
                        count = int(count)
                    except (TypeError, ValueError):
                        continue
                    if count < 0:
                        continue
                    prev = self._rows.get(rid)
                    if prev is None or count < prev[0]:
                        # New row: baseline. Backward count = recycled id
                        # (a NEW request restarted from zero): re-baseline.
                        # Either way credit nothing — see docstring.
                        self._rows[rid] = (count, now)
                        continue
                    delta = count - prev[0]
                    if delta > 0:
                        self._acc += delta
                    self._rows[rid] = (count, now)
        except Exception:  # noqa: BLE001
            log.debug("decode sample_running failed", exc_info=True)

    # ---- engine-thread events -------------------------------------------

    def note_birth(self, rid, *, now: Optional[float] = None) -> None:
        """Request admitted: start its row at zero so every token it then
        generates is credited by whichever path sees it first (a tick walk
        or the departure flush). Without this, a row's first sighting
        mid-generation has no starting point and must be baselined (its
        pre-sight tokens are dropped — bounded to one window, and only for
        requests that were already in flight when the hooks installed)."""
        if not rid:
            return
        now = time.time() if now is None else now
        try:
            with self._lock:
                self._rows[rid] = (0, now)
        except Exception:  # noqa: BLE001
            log.debug("decode note_birth failed", exc_info=True)

    def note_end(self, rid, final_tokens, *, now: Optional[float] = None) -> None:
        """Request departed: flush the tail the tick walk could not see.

        A generation that starts and finishes between two ticks is invisible
        to ``sample_running``; the departure hook carries its exact final
        count, so the work still lands (in the tick it happened in). Tokens
        already credited by a tick are not credited again.
        """
        if not rid:
            return
        try:
            final = int(final_tokens or 0)
        except (TypeError, ValueError):
            return
        if final < 0:
            return
        now = time.time() if now is None else now
        try:
            with self._lock:
                prev = self._rows.get(rid)
                if prev is not None and final < prev[0]:
                    prev = None          # recycled id — credit the new count
                credited = prev[0] if prev else 0
                tail = final - credited
                if tail > 0:
                    self._acc += tail
                # Keep the row (with its credited total) so a tick that still
                # lists the departed request cannot re-credit it; the stale
                # sweep drops it later.
                self._rows[rid] = (max(credited, final), now)
        except Exception:  # noqa: BLE001
            log.debug("decode note_end failed", exc_info=True)

    # ---- collector thread -------------------------------------------------

    def drain(self, *, now: float) -> dict[str, float]:
        """One tick: tokens since the last drain / dt. Zero always written;
        dt <= 0 keeps the accumulator for the next tick (never a fake
        spike)."""
        with self._lock:
            if self._since is None:
                self._since = now
                return {KEY_GENERATION_TOKENS: 0.0}
            dt = now - self._since
            if dt <= 0:
                return {KEY_GENERATION_TOKENS: 0.0}
            toks = self._acc
            self._acc = 0.0
            self._since = now
            # housekeeping: rows that never reached note_end expire
            cutoff = now - ROW_STALE_S
            for k in [k for k, v in self._rows.items() if v[1] < cutoff]:
                self._rows.pop(k, None)
            if len(self._rows) > MAX_TRACKED:
                for k in sorted(self._rows, key=lambda r: self._rows[r][1]
                                )[:len(self._rows) - MAX_TRACKED]:
                    self._rows.pop(k, None)
        return {KEY_GENERATION_TOKENS: toks / dt}


_sampler: Optional[DecodeSampler] = None
_sampler_lock = threading.Lock()


def get_decode_sampler() -> DecodeSampler:
    global _sampler
    with _sampler_lock:
        if _sampler is None:
            _sampler = DecodeSampler()
        return _sampler
