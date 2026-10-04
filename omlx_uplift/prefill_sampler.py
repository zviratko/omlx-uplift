"""BE-prefill: exact computed-prefill token rate, fed by tracker events.

Why not ServerMetrics (the old ``avg_prefill_tps`` chart line):
upstream ``record_request_complete()`` fires ONLY when a request finishes,
and its number is a session-lifetime average
``(total_prompt - total_cached) / total_prefill_duration`` with
``prefill_duration = TTFT`` (queue wait + model load included). The
symptoms the user reported ("prefill numbers are not accurate, a
prefilling request sometimes doesn't show on the graph at all"):

* aborted / disconnected / errored requests NEVER land in the totals;
* one prefill is diluted by every request since boot (lifetime average);
* a prefill that starts and ends between two 5 s ticks is never seen.

Source: the upstream prefill progress tracker
(``omlx.prefill_progress.PrefillProgressTracker``). The scheduler calls
``update(rid, processed, total, model)`` once per prefill chunk with the
CUMULATIVE count of tokens COMPUTED so far (cache-restored tokens are
``base_size`` and never enter ``processed``), and ``remove(rid)`` fires at
completion AND on every abort path (client disconnect, memory rejection,
error). instrument.install_prefill_tracker() wraps those two methods, so:

* every chunk is credited the moment it happens — nothing waits for the
  request to finish, so the work an aborted request did compute counts;
* no tick race: a prefill born and finished inside one 5 s window is
  still fully counted (a tick sampler would miss it entirely);
* ``note_end`` flushes the unobserved tail (upstream updates BEFORE the
  final chunk, so one chunk of every prefill is never in an update),
  capped at the row's own chunk scale — an ABORT of a huge prompt cannot
  dump its uncomputed remainder into one tick. Over-count on abort ≤
  2 chunks; that is the accepted slight inaccuracy.

Edge rules (all covered by tests/test_prefill_sampler.py):
* first sighting of a rid credits its whole processed count (the event
  stream cannot have missed earlier chunks of a row we track from birth;
  for a row already in flight when the hooks were installed this
  retro-credits at most one prompt — bounded, one-off, accepted);
* an UNTRACKED row whose first event is already complete (processed >=
  total): credit at most FLUSH_CAP_MIN, and only in the plain ``prefill``
  phase — a specprefill ``lookahead`` update reports the FULL prompt as
  processed BEFORE the target computes it (draft.py:708);
* same rid + phase change (specprefill scoring→target: different token
  scales) or model change: restart accrual, credit nothing for the jump;
* same rid + BACKWARD count: a recycled id means a NEW request — restart
  from zero and credit the new count;
* rows with no event for ROW_STALE_S are dropped unflushed on drain
  (abandoned; their remainder would be a guess).

Stored series: ``prefill.tokens_s`` — computed prefill tokens/s per
collector tick, zeros always written (a drained line is data).
Session-scoped like every other uplift metric: counters reset with
the process.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

log = logging.getLogger("omlx_uplift.prefill_sampler")

# Tail-flush floor when no chunk delta was ever observed for the row: an
# unobserved final chunk must be creditable. Matches omlx's default
# prefill step size (2048).
FLUSH_CAP_MIN = 2048
# Bounded bookkeeping: a request that updates once and is never removed
# (upstream layout drift) must not grow the map for ever.
MAX_TRACKED = 512
# Rows with no chunk event for this long are dropped UNFLUSHED at drain:
# any real prefill steps chunks far faster than this.
ROW_STALE_S = 300.0

KEY_PREFILL_TOKENS = "prefill.tokens_s"
PREFILL_KEY_PREFIX = "prefill."


class PrefillSampler:
    """Accumulator: exact chunk deltas in, per-tick tok/s out.

    Event methods run on engine thread(s); ``drain()`` runs on the
    collector thread. One lock, no I/O, O(1) per event.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # rid -> (model, processed, total, phase, last_delta, last_seen)
        self._rows: dict[str, tuple[str, int, int, str, int, float]] = {}
        self._acc = 0.0                # tokens credited, not yet drained
        self._since: Optional[float] = None

    # ---- engine-thread events -----------------------------------------

    def note_chunk(self, rid, processed, total, model="", phase="prefill",
                   *, now: Optional[float] = None) -> None:
        """One prefill chunk completed for ``rid`` (cumulative counters)."""
        if not rid:
            return
        try:
            processed = int(processed or 0)
            total = int(total or 0)
        except (TypeError, ValueError):
            return
        if processed < 0 or total <= 0:
            return
        model = str(model or "")
        phase = str(phase or "prefill")
        now = time.time() if now is None else now
        try:
            with self._lock:
                prev = self._rows.get(rid)
                if prev is not None and (prev[3] != phase
                                         or (prev[0] and model
                                             and prev[0] != model)):
                    # specprefill phase scale-change or id moved engines:
                    # restart accrual at this point and credit NOTHING for
                    # the jump — the new scale's history is not computed
                    # work we observed (draft.py reports the whole prompt
                    # as processed at a phase boundary).
                    self._rows[rid] = (model, processed, total, phase,
                                       0, now)
                    if processed >= total:
                        self._rows.pop(rid, None)
                    return
                if prev is not None and prev[1] > processed:
                    # backward count = recycled id (a NEW request). Forget
                    # the old row and treat this event as a fresh sighting
                    # — same caps apply as for any never-tracked row.
                    self._rows.pop(rid, None)
                    prev = None
                if prev is None:
                    if processed >= total:
                        # Untracked row finishing in one event: credit at
                        # most one chunk, and only the plain prefill phase
                        # (see module docstring — lookahead/selected burst
                        # the whole prompt through this door).
                        if phase == "prefill":
                            self._acc += min(processed, FLUSH_CAP_MIN)
                        return
                    self._rows[rid] = (model, processed, total, phase,
                                       processed, now)
                    self._acc += processed
                    return
                d = max(processed - prev[1], 0)
                self._acc += d
                if processed >= total:
                    self._rows.pop(rid, None)   # completion arrives here
                else:
                    self._rows[rid] = (model, processed, total, phase,
                                       d, now)
        except Exception:  # noqa: BLE001 — telemetry must never break serving
            log.debug("prefill note_chunk failed", exc_info=True)

    def note_end(self, rid, *, now: Optional[float] = None) -> None:
        """Tracker dropped ``rid`` — completion OR abort.

        Upstream calls update() BEFORE the final chunk, so one chunk of
        every prefill is unaccounted; flush the ``total - processed``
        remainder, capped at the row's own chunk scale so an abort cannot
        dump a 500k-token prompt's uncomputed remainder into this tick.
        """
        if not rid:
            return
        now = time.time() if now is None else now
        try:
            with self._lock:
                row = self._rows.pop(rid, None)
                if row is None or row[1] <= 0:
                    # never observed any computed chunk -> the remainder
                    # would be a guess, not a flush
                    return
                _model, last_p, total, _phase, last_d, _seen = row
                tail = max(total - last_p, 0)
                self._acc += min(tail, max(2 * last_d, FLUSH_CAP_MIN))
        except Exception:  # noqa: BLE001
            log.debug("prefill note_end failed", exc_info=True)

    # ---- collector thread ----------------------------------------------

    def drain(self, *, now: float) -> dict[str, float]:
        """One tick: tokens since the last drain / dt. Zero always written;
        dt <= 0 keeps the accumulator for the next tick (never a fake
        spike)."""
        with self._lock:
            if self._since is None:
                self._since = now
                return {KEY_PREFILL_TOKENS: 0.0}
            dt = now - self._since
            if dt <= 0:
                return {KEY_PREFILL_TOKENS: 0.0}
            toks = self._acc
            self._acc = 0.0
            self._since = now
            # housekeeping: abandoned rows expire unflushed
            cutoff = now - ROW_STALE_S
            for k in [k for k, v in self._rows.items() if v[5] < cutoff]:
                self._rows.pop(k, None)
            if len(self._rows) > MAX_TRACKED:
                for k in sorted(self._rows, key=lambda r: self._rows[r][5]
                                )[:len(self._rows) - MAX_TRACKED]:
                    self._rows.pop(k, None)
        return {KEY_PREFILL_TOKENS: toks / dt}


_sampler: Optional[PrefillSampler] = None
_sampler_lock = threading.Lock()


def get_prefill_sampler() -> PrefillSampler:
    global _sampler
    with _sampler_lock:
        if _sampler is None:
            _sampler = PrefillSampler()
        return _sampler
