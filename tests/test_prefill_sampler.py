"""BE-prefill acceptance: the event-fed prefill sampler.

The bug: avg_prefill_tps is a session-lifetime average upstream only
updates at request completion — aborted requests never counted, and a
single prefill could not move the line. The fix: wrap the prefill
progress tracker (update per chunk / remove on completion AND abort) and
store per-tick deltas as prefill.tokens_s.

These tests exercise the sampler directly (the wrappers are thin and
fully guarded, same split as test_instrument.py).
"""
import pytest

from omlx_uplift.prefill_sampler import (FLUSH_CAP_MIN, MAX_TRACKED,
                                         KEY_PREFILL_TOKENS,
                                         ROW_STALE_S, PrefillSampler)


def _drain(s, now):
    return s.drain(now=now)[KEY_PREFILL_TOKENS]


def test_first_drain_opens_the_window_with_zero():
    s = PrefillSampler()
    assert _drain(s, 100.0) == 0.0
    s.note_chunk("r1", 2048, 10000, "m")
    assert _drain(s, 105.0) == pytest.approx(2048 / 5.0)
    s.note_chunk("r1", 4096, 10000, "m")
    assert _drain(s, 110.0) == pytest.approx(2048 / 5.0)


def test_zero_always_written_when_idle():
    s = PrefillSampler()
    _drain(s, 100.0)
    assert _drain(s, 105.0) == 0.0        # drained line is data, not absence


def test_abort_keeps_the_work_already_done():
    """The reported bug: an aborted request must show its prefill work."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 500_000, "m")
    s.note_chunk("r1", 4096, 500_000, "m")
    s.note_end("r1")                      # abort: remove() at 4096/500k
    # 4096 observed + capped tail flush (2 x last chunk), NOT the 495904
    # tokens that were never computed
    assert _drain(s, 105.0) == pytest.approx((2048 + 2048 + 2 * 2048) / 5.0)


def test_completion_flushes_the_unobserved_tail_chunk():
    """Upstream removes the entry at processed >= total, so the final
    chunk never appears in an update(); the tail must still land."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 3000, "m")
    s.note_end("r1")                      # removed at 2048/3000 = 952 tail
    assert _drain(s, 105.0) == pytest.approx(3000 / 5.0)


def test_flush_cap_follows_observed_chunk_scale():
    """A row chunking at 8k flushes an 8k-scale tail, not the 2048 floor."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 8192, 100_000, "m")
    s.note_end("r1")
    assert _drain(s, 105.0) == pytest.approx((8192 + 2 * 8192) / 5.0)


def test_untracked_plain_completion_is_capped():
    """First event of a rid already complete (short whole prefill missed
    its chunks): credit at most one chunk, never the whole count."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 900_000, 900_000, "m", "prefill")
    assert _drain(s, 105.0) == pytest.approx(FLUSH_CAP_MIN / 5.0)


def test_lookahead_completion_update_credits_nothing():
    """specprefill 'lookahead' reports the FULL prompt as processed
    BEFORE the target computes it — must never count as work."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 900_000, 900_000, "m", "specprefill_lookahead")
    assert _drain(s, 105.0) == 0.0


def test_backward_count_is_recycled_id_credited_fresh():
    """Same rid with a lower count = a NEW request reusing the id: its
    progress is new work, counted from zero (never a negative delta)."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 6000, 10000, "m")   # old request: 6000 credited
    s.note_chunk("r1", 1000, 9000, "m")    # recycled: +1000
    s.note_chunk("r1", 3000, 9000, "m")    # new request's next chunk +2000
    assert _drain(s, 105.0) == pytest.approx((6000 + 1000 + 2000) / 5.0)


def test_phase_change_restarts_accrual_without_a_burst():
    """specprefill phases reuse the rid on different token scales; the
    forward jump from scoring to the target pass must not burst."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 50000, "m", "specprefill_scoring")
    s.note_chunk("r1", 40000, 50000, "m", "specprefill_selected")
    assert _drain(s, 105.0) == pytest.approx(2048 / 5.0)   # jump credited 0


def test_model_change_restarts_accrual():
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 10000, "m-a")
    s.note_chunk("r1", 9000, 10000, "m-b")
    assert _drain(s, 105.0) == pytest.approx(2048 / 5.0)


def test_completed_row_is_not_double_flushed_by_remove():
    """Upstream fires the final update (processed >= total) AND remove():
    the row must pay exactly once."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 4096, "m")
    s.note_chunk("r1", 4096, 4096, "m")    # auto-remove update
    s.note_end("r1")                       # then the explicit remove
    assert _drain(s, 105.0) == pytest.approx(4096 / 5.0)


def test_abort_never_seen_a_chunk_credits_nothing():
    """Killed while queued: zero prefill work, zero tokens — not a
    total-sized phantom."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 0, 500_000, "m")
    s.note_end("r1")
    assert _drain(s, 105.0) == 0.0


def test_dt_zero_keeps_accumulator_for_next_tick():
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 10000, "m")
    assert _drain(s, 100.0) == 0.0         # clock didn't move: keep tokens
    s.note_chunk("r1", 4096, 10000, "m")
    assert _drain(s, 105.0) == pytest.approx(4096 / 5.0)


@pytest.mark.parametrize("rid,proc,tot", [
    ("", 100, 200), ("r", -5, 200), ("r", 100, 0), ("r", None, 10),
    ("r", "x", "y"),
])
def test_junk_inputs_are_dropped_not_raised(rid, proc, tot):
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk(rid, proc, tot, "m")
    s.note_end(rid)
    assert _drain(s, 105.0) == 0.0


def test_eviction_bounds_the_row_map():
    s = PrefillSampler()
    _drain(s, 100.0)
    for i in range(MAX_TRACKED + 40):
        s.note_chunk(f"r{i}", 100, 10000, "m", now=100.0 + i * 0.001)
    s.drain(now=101.0)                     # eviction runs on drain
    assert len(s._rows) <= MAX_TRACKED


def test_stale_rows_expire_without_flush():
    """A row abandoned mid-prefill (no remove, no further progress) must
    NOT flush its remainder — that number would be a guess."""
    s = PrefillSampler()
    _drain(s, 100.0)
    s.note_chunk("r1", 2048, 100_000, "m")
    assert _drain(s, 105.0) == pytest.approx(2048 / 5.0)   # clear the acc
    s._rows["r1"] = s._rows["r1"][:5] + (100.0,)           # freeze at t=100
    assert _drain(s, 100.0 + ROW_STALE_S + 10) == 0.0
    assert "r1" not in s._rows
