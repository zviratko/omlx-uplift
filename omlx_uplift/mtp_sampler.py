"""MTP acceptance sampler: per-tick deltas of the Lightning MTP counters.

Why this exists: native MTP (``mtp_enabled``) keeps a per-sequence
``_MtpStats`` accumulator (omlx ``patches/mlx_lm_mtp/batch_generator.py``)
— cycles, accepted draft tokens, per-depth drafted/accepted counts — but
vanilla only ever prints it as one INFO line when a sequence finishes
(``MTP[uid] finish=... accept=A/D (x%)``). Nothing on the dashboard shows
whether the draft head is actually productive right now.

Source, read live every collector tick (no vanilla edits, read-only walk):

    scheduler.batch_generator._generation_batch
        ._omlx_mtp_state            (singleton decode state, .stats)
        ._omlx_mtp_batch_state      (continuous batch, .states[uid].stats)

Crediting rules mirror decode_sampler.py (see its docstring — the same
double-count traps apply):

* a state first seen mid-generation BASELINES AND CREDITS NOTHING; only
  growth observed BETWEEN ticks is credited;
* ``note_finish(stats)`` from the wrapped ``_log_mtp_stats`` flushes the
  tail a sub-tick MTP sequence never showed the walk (born AND finished
  inside one 5 s window) and covers aborted requests, whose unflushed tail
  would otherwise be dropped when the state object is freed;
* counters only ever grow for one sequence, so a BACKWARD value means the
  dataclass id was recycled by a new sequence: re-baseline, credit nothing
  (the new sequence's own walk/finish path credits it from then on);
* zeros are ALWAYS written — an idle or non-MTP engine is a data point,
  and a skipped key truncates the series exactly when speculation stops.

Window semantics: percent/ratio/depth keys drain the window since the
previous persisting tick (windowed mean, same shape as pfx.*_pct);
``mtp.accepted_tokens_s`` and ``mtp.cycles_s`` divide the window delta by
dt (same shape as generation.tokens_s).

Not collected: vlm_mtp (a second, assistant-drafter path — enabled on no
known model; its counters would make the series mean "some speculation")
and DFlash (has its own get_speculation_stats surface, already mirrored).
The keys mean NATIVE Lightning MTP only.

No hourly rollup exists upstream for these counters, so long windows
honestly start at install day (same as prefill.tokens_s).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

log = logging.getLogger("omlx_uplift.mtp_sampler")

# The five plotted/legend keys + depth ladder (one per possible MTP depth,
# MAX_LIGHTNING_MTP_DRAFT_TOKENS = 8 upstream).
KEY_ACCEPTED_TOKENS = "mtp.accepted_tokens_s"
KEY_ACCEPT_PCT = "mtp.accept_pct"
KEY_ZERO_CYCLES_PCT = "mtp.zero_cycles_pct"
KEY_DEPTH_AVG = "mtp.depth_avg"
KEY_TOKENS_PER_CYCLE = "mtp.tokens_per_cycle"
KEY_CYCLES = "mtp.cycles_s"
KEY_DEPTH_PREFIX = "mtp.depth_d"          # + "1".."8" + "_pct"
MAX_DEPTH = 8

# States unseen for this long are dropped: their dataclass id can be
# recycled for a new sequence, and a stale baseline would mis-credit.
STATE_STALE_S = 300.0
MAX_TRACKED = 512

_SUM_KEYS = ("cycles", "accepts", "zero_cycles", "init_emits", "draft_emits",
             "bonus_emits", "verify_emits")
_LIST_KEYS = ("depth_drafted", "depth_accepted")


def _snapshot(stats: Any) -> Optional[dict]:
    """Read one _MtpStats into a plain dict; None when unreadable
    (upstream attribute drift must skip the state, never poison a tick)."""
    try:
        snap = {k: int(getattr(stats, k)) for k in _SUM_KEYS}
        drafted = [int(x) for x in (getattr(stats, "depth_drafted", None) or [])]
        accepted = [int(x) for x in (getattr(stats, "depth_accepted", None) or [])]
    except (AttributeError, TypeError, ValueError):
        return None
    snap["depth_drafted"] = drafted[:MAX_DEPTH]
    snap["depth_accepted"] = accepted[:MAX_DEPTH]
    return snap


class MtpSampler:
    """Accumulator: per-state counter baselines in, per-tick pairs out.

    ``sample_states()`` runs on the collector thread; ``note_finish()``
    runs on the engine thread at sequence finish. One lock, no I/O.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # id(stats) -> (snapshot, last_seen). id() is stable while the
        # state object lives; the finish hook and the stale sweep are what
        # bound recycling risk (see module docstring).
        self._rows: dict[int, tuple[dict, float]] = {}
        # Windowed totals of deltas, drained every persisting tick.
        self._win = self._zero_totals()
        # mtp.accepted_tokens_s / mtp.cycles_s ride the monotonic-total
        # pattern (drain() divides by dt, dt<=0 keeps the baseline).
        self._credited = 0.0
        self._cycles = 0.0
        self._base: Optional[tuple[float, float, float]] = None  # ts, tot, cyc

    @staticmethod
    def _zero_totals() -> dict:
        t = {k: 0 for k in _SUM_KEYS}
        t["depth_drafted"] = [0] * MAX_DEPTH
        t["depth_accepted"] = [0] * MAX_DEPTH
        return t

    # ---- collector thread ----------------------------------------------

    def sample_states(self, states: Any, *,
                      now: Optional[float] = None) -> None:
        """Feed one tick's live MTP states (iterable of _MtpStats objects).

        Best-effort by contract: any junk is skipped, never raised — a
        telemetry walk must not be able to break a tick. FIRST SIGHT
        BASELINES AND CREDITS NOTHING (see module docstring)."""
        if states is None:
            return
        now = time.time() if now is None else now
        try:
            with self._lock:
                seen: set[int] = set()
                for stats in states:
                    if stats is None:
                        continue
                    snap = _snapshot(stats)
                    if snap is None:
                        continue
                    sid = id(stats)
                    seen.add(sid)
                    prev = self._rows.get(sid)
                    if prev is None:
                        self._rows[sid] = (snap, now)
                        continue
                    # Counters never go backward for one sequence; a
                    # backward value = recycled id of a dead sequence ->
                    # re-baseline (credits nothing), same rule as a
                    # counter reset in the pfx/spec walkers.
                    if snap["cycles"] < prev[0]["cycles"] or \
                            snap["accepts"] < prev[0]["accepts"]:
                        self._rows[sid] = (snap, now)
                        continue
                    self._add_delta(prev[0], snap)
                    self._rows[sid] = (snap, now)
                self._sweep(seen, now)
        except Exception:  # noqa: BLE001
            log.debug("mtp sample_states failed", exc_info=True)

    def _add_delta(self, old: dict, new: dict) -> None:
        for k in _SUM_KEYS:
            d = new[k] - old[k]
            if d > 0:
                self._win[k] += d
                if k == "accepts":
                    self._credited += d
                elif k == "cycles":
                    self._cycles += d
        for key in _LIST_KEYS:
            a, b = old[key], new[key]
            row = self._win[key]
            for i in range(min(len(a), len(b), MAX_DEPTH)):
                d = b[i] - a[i]
                if d > 0:
                    row[i] += d

    def _flush(self, snap: dict) -> None:
        """Credit a full snapshot (finish path — the sequence is over and
        everything it accumulated between our last two peeks is due)."""
        for k in _SUM_KEYS:
            v = snap[k]
            if v > 0:
                self._win[k] += v
                if k == "accepts":
                    self._credited += v
                elif k == "cycles":
                    self._cycles += v
        for i, (d, a) in enumerate(zip(snap["depth_drafted"],
                                       snap["depth_accepted"])):
            if i >= MAX_DEPTH:
                break
            if d > 0:
                self._win["depth_drafted"][i] += d
            if a > 0:
                self._win["depth_accepted"][i] += a

    def _sweep(self, seen: set[int], now: float) -> None:
        cutoff = now - STATE_STALE_S
        for k in [k for k, v in self._rows.items()
                  if k not in seen and v[1] < cutoff]:
            self._rows.pop(k, None)
        if len(self._rows) > MAX_TRACKED:
            for k in sorted(self._rows, key=lambda r: self._rows[r][1])[
                    :len(self._rows) - MAX_TRACKED]:
                self._rows.pop(k, None)

    # ---- engine-thread events -------------------------------------------

    def note_finish(self, stats: Any, *, now: Optional[float] = None) -> None:
        """One MTP sequence ended (``_log_mtp_stats`` fires on finish AND
        on every abort/park hand-off, reading the sequence's own stats).

        ``_log_mtp_stats`` fires MORE THAN ONCE for one state (park /
        drop / extend reconciliation each log, then the real finish does),
        so the row is UPDATED, never popped: a repeated fire sees equal
        counters and credits zero. A live row contributes only the tail
        after its last credited snapshot (ticks already paid for the
        rest); a never-seen row (born and finished inside one window)
        contributes its whole count — that work is otherwise invisible to
        the tick walk. A backward live row means the id was already
        recycled by a new sequence whose own path credits it: skip, never
        double-pay. Freed slots leave via the stale sweep."""
        if stats is None:
            return
        snap = _snapshot(stats)
        if snap is None:
            return
        now = time.time() if now is None else now
        try:
            with self._lock:
                sid = id(stats)
                prev = self._rows.get(sid)
                if prev is None:
                    self._flush(snap)
                    self._rows[sid] = (snap, now)
                elif (snap["cycles"] >= prev[0]["cycles"]
                        and snap["accepts"] >= prev[0]["accepts"]):
                    self._add_delta(prev[0], snap)
                    self._rows[sid] = (snap, now)
                # else: recycled id against a newer dead-sequence row —
                # this sequence's work rides the tick walk instead.
        except Exception:  # noqa: BLE001
            log.debug("mtp note_finish failed", exc_info=True)

    # ---- collector thread: drain ----------------------------------------

    def drain(self, *, now: float,
              channel: str = "tick") -> dict[str, float]:
        """One window of MTP pairs. The store has one writer (the 5 s
        Collector, channel='tick'); the fast display path is deliberately
        not fed these counters (speculation cycles are not 2 Hz data).

        First drain seeds the baseline and credits nothing; ``dt <= 0``
        returns zeros WITHOUT draining (same no-fake-spike rule as
        decode_sampler.drain — a swapped baseline would silently lose the
        window's tokens). The seed is (now, 0, 0), not the current totals:
        unlike a decode row's lifetime count, our accumulator can only
        have grown from observations AFTER the hooks installed, so
        pre-first-drain credits are real window work and must not be
        swallowed into the baseline."""
        with self._lock:
            if self._base is None:
                self._base = (now, 0.0, 0.0)
                pairs = self._zero_pairs()
                pairs[KEY_ACCEPTED_TOKENS] = 0.0
                pairs[KEY_CYCLES] = 0.0
                return pairs
            b_ts, b_total, b_cycles = self._base
            dt = now - b_ts
            if dt <= 0:
                return self._all_zero()
            win, self._win = self._win, self._zero_totals()
            total, cycles = self._credited, self._cycles
            self._base = (now, total, cycles)

        pairs = self._pairs_from(win, now)
        pairs[KEY_ACCEPTED_TOKENS] = (total - b_total) / dt
        pairs[KEY_CYCLES] = (cycles - b_cycles) / dt
        return pairs

    @staticmethod
    def _zero_pairs() -> dict[str, float]:
        pairs: dict[str, float] = {
            KEY_ACCEPT_PCT: 0.0, KEY_ZERO_CYCLES_PCT: 0.0,
            KEY_DEPTH_AVG: 0.0, KEY_TOKENS_PER_CYCLE: 0.0}
        for i in range(MAX_DEPTH):
            pairs[f"{KEY_DEPTH_PREFIX}{i + 1}_pct"] = 0.0
        return pairs

    @classmethod
    def _all_zero(cls) -> dict[str, float]:
        z = cls._zero_pairs()
        z[KEY_ACCEPTED_TOKENS] = 0.0
        z[KEY_CYCLES] = 0.0
        return z

    @staticmethod
    def _pairs_from(win: dict, now: float) -> dict[str, float]:  # noqa: ARG004
        pairs = MtpSampler._zero_pairs()
        cycles_w = win["cycles"]
        drafted_total = sum(win["depth_drafted"]) or cycles_w
        if drafted_total > 0:
            pairs[KEY_ACCEPT_PCT] = 100.0 * win["accepts"] / drafted_total
        if cycles_w > 0:
            pairs[KEY_ZERO_CYCLES_PCT] = 100.0 * win["zero_cycles"] / cycles_w
            pairs[KEY_DEPTH_AVG] = sum(win["depth_accepted"]) / cycles_w
            emits = (win["init_emits"] + win["draft_emits"]
                     + win["bonus_emits"] + win["verify_emits"])
            pairs[KEY_TOKENS_PER_CYCLE] = emits / cycles_w
        for i in range(MAX_DEPTH):
            drafted = win["depth_drafted"][i]
            if drafted > 0:
                pairs[f"{KEY_DEPTH_PREFIX}{i + 1}_pct"] = (
                    100.0 * win["depth_accepted"][i] / drafted)
        return pairs


_sampler: Optional[MtpSampler] = None
_sampler_lock = threading.Lock()


def get_mtp_sampler() -> MtpSampler:
    global _sampler
    if _sampler is None:
        with _sampler_lock:
            if _sampler is None:
                _sampler = MtpSampler()
    return _sampler
