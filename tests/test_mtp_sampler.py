"""MTP acceptance sampler: crediting rules for the live-state walk and the
finish-hook tail flush.

The sampler reads omlx's per-sequence _MtpStats accumulators (cycles,
accepts, per-depth drafted/accepted). These tests exercise the sampler
directly — the pool walk in collectors.collect_mtp and the wrapper in
instrument.install_mtp_hooks are thin and fully guarded (same split as
test_decode_sampler.py). Fake stats objects mirror the real dataclass
field surface.
"""
import pytest

from omlx_uplift.mtp_sampler import (KEY_ACCEPT_PCT, KEY_ACCEPTED_TOKENS,
                                     KEY_CYCLES, KEY_DEPTH_PREFIX,
                                     KEY_ZERO_CYCLES_PCT, MtpSampler)


class FakeStats:
    """Field-compatible stand-in for omlx _MtpStats."""

    def __init__(self, **kw):
        self.cycles = kw.get("cycles", 0)
        self.accepts = kw.get("accepts", 0)
        self.rejects = kw.get("rejects", 0)
        self.init_emits = kw.get("init_emits", 0)
        self.draft_emits = kw.get("draft_emits", 0)
        self.bonus_emits = kw.get("bonus_emits", 0)
        self.verify_emits = kw.get("verify_emits", 0)
        self.depth_drafted = list(kw.get("depth_drafted", []))
        self.depth_accepted = list(kw.get("depth_accepted", []))
        self.zero_cycles = kw.get("zero_cycles", 0)


def _drain(s, now):
    return s.drain(now=now)


# ---------------------------------------------------------------- opening


def test_first_drain_opens_the_window_with_zeros():
    s = MtpSampler()
    d = _drain(s, 100.0)
    assert d[KEY_ACCEPTED_TOKENS] == 0.0
    assert d[KEY_ACCEPT_PCT] == 0.0
    # every key present — zeros are data, a skipped key truncates the series
    assert f"{KEY_DEPTH_PREFIX}1_pct" in d and f"{KEY_DEPTH_PREFIX}8_pct" in d


def test_zero_written_every_tick_when_idle():
    s = MtpSampler()
    _drain(s, 100.0)
    d = _drain(s, 105.0)
    assert d[KEY_ACCEPTED_TOKENS] == 0.0
    assert d[KEY_ACCEPT_PCT] == 0.0
    assert d[KEY_CYCLES] == 0.0


def test_dt_zero_keeps_the_accumulator_for_the_next_tick():
    s = MtpSampler()
    _drain(s, 100.0)
    st = FakeStats(cycles=4, accepts=2,
                   depth_drafted=[4], depth_accepted=[2])
    s.sample_states([st], now=100.0)        # first sight: baseline, credits 0
    st.cycles, st.accepts = 9, 5
    st.depth_drafted, st.depth_accepted = [9], [5]
    s.sample_states([st], now=100.5)        # credits +3 accepts
    d = _drain(s, 100.0)                    # dt<=0: zeros, nothing drained
    assert d[KEY_ACCEPTED_TOKENS] == 0.0
    d = _drain(s, 105.0)                    # base still 100 -> full 5 s
    assert d[KEY_ACCEPTED_TOKENS] == pytest.approx(3 / 5.0)


# ------------------------------------------------------------- crediting


def test_first_sight_baselines_and_credits_nothing():
    """A state seen mid-generation must not dump its lifetime count into
    one tick (same doctrine as decode rows without note_birth)."""
    s = MtpSampler()
    _drain(s, 100.0)
    s.sample_states([FakeStats(cycles=100, accepts=50,
                               depth_drafted=[100], depth_accepted=[50])],
                    now=101.0)
    d = _drain(s, 105.0)
    assert d[KEY_ACCEPTED_TOKENS] == 0.0
    assert d[KEY_ACCEPT_PCT] == 0.0


def test_growth_between_ticks_is_credited_once():
    s = MtpSampler()
    _drain(s, 100.0)
    st = FakeStats(cycles=0, accepts=0)
    s.sample_states([st], now=101.0)       # baseline at zero
    st.cycles, st.accepts = 10, 6
    st.depth_drafted, st.depth_accepted = [10], [6]
    s.sample_states([st], now=102.0)       # credits +6 accepts / +10 cycles
    _drain(s, 106.0)                        # window drains here (dt from
                                            # the base seeded at the FIRST
                                            # drain — 100 — not from 102)
    st.cycles, st.accepts = 20, 14
    st.depth_drafted, st.depth_accepted = [20], [14]
    s.sample_states([st], now=108.0)       # credits +8 accepts / +10 cycles
    d = _drain(s, 112.0)                   # window 106 -> 112: dt 6
    assert d[KEY_ACCEPTED_TOKENS] == pytest.approx(8 / 6.0)
    assert d[KEY_ACCEPT_PCT] == pytest.approx(100.0 * 8 / 10)   # windowed
    assert d[KEY_CYCLES] == pytest.approx(10 / 6.0)


def test_recycled_state_id_rebaselines_without_credit():
    """In production a recycled id() looks exactly like a BACKWARD count:
    the row under that id carries the dead sequence's high counters, the
    new object starts low. Re-baseline, credit nothing."""
    s = MtpSampler()
    _drain(s, 100.0)
    st1 = FakeStats(cycles=5, accepts=3)
    s.sample_states([st1], now=101.0)      # baseline (first sight)
    s.sample_states([st1], now=102.0)      # equal: credits 0
    st2 = FakeStats(cycles=1, accepts=1)
    s.sample_states([st2], now=103.0)      # fresh row: baseline
    st2.cycles, st2.accepts = 4, 2
    s.sample_states([st2], now=104.0)      # forward: credits +1 accept
    d = _drain(s, 106.0)
    assert d[KEY_ACCEPTED_TOKENS] == pytest.approx(1 / 6.0)
    # backward counters against an existing row = recycled id: re-baseline
    s2 = MtpSampler()
    _drain(s2, 100.0)
    st = FakeStats(cycles=9, accepts=9)
    s2.sample_states([st], now=101.0)      # baseline (first sight)
    st.cycles, st.accepts = 3, 1
    s2.sample_states([st], now=102.0)      # backward: re-baseline only
    d = _drain(s2, 105.0)
    assert d[KEY_ACCEPTED_TOKENS] == 0.0


# ---------------------------------------------------------- finish flush


def test_note_finish_credits_whole_unseen_sequence():
    """Born AND finished inside one window: the tick walk never saw it."""
    s = MtpSampler()
    _drain(s, 100.0)
    st = FakeStats(cycles=8, accepts=5, init_emits=2, draft_emits=5,
                   bonus_emits=3, depth_drafted=[8], depth_accepted=[5])
    s.note_finish(st, now=102.0)
    d = _drain(s, 105.0)
    assert d[KEY_ACCEPTED_TOKENS] == pytest.approx(5 / 5.0)
    assert d[KEY_ACCEPT_PCT] == pytest.approx(100.0 * 5 / 8)
    assert d[f"{KEY_DEPTH_PREFIX}1_pct"] == pytest.approx(62.5)
    assert d["mtp.tokens_per_cycle"] == pytest.approx(10 / 8)


def test_note_finish_tail_only_after_ticks_credited():
    s = MtpSampler()
    _drain(s, 100.0)
    st = FakeStats(cycles=2, accepts=1)
    s.sample_states([st], now=101.0)       # baseline
    st.cycles, st.accepts = 6, 4
    s.sample_states([st], now=102.0)       # credits +3
    st.cycles, st.accepts = 8, 5
    s.note_finish(st, now=103.0)           # tail: +1 accept, +2 cycles
    d = _drain(s, 105.0)
    assert d[KEY_ACCEPTED_TOKENS] == pytest.approx(4 / 5.0)


def test_note_finish_repeated_fire_credits_zero():
    """_log_mtp_stats fires per park/drop AND at finish for the SAME
    state — repeated fires with equal counters must not double-pay."""
    s = MtpSampler()
    _drain(s, 100.0)
    st = FakeStats(cycles=10, accepts=6)
    s.note_finish(st, now=101.0)           # flushes 6
    s.note_finish(st, now=101.5)           # equal: credits 0
    d = _drain(s, 105.0)
    assert d["mtp.cycles_s"] == pytest.approx(10 / 5.0)
    assert d[KEY_ACCEPTED_TOKENS] == pytest.approx(6 / 5.0)


def test_note_finish_ignores_junk():
    s = MtpSampler()
    _drain(s, 100.0)
    s.note_finish(None)
    s.note_finish(object())                 # no fields: snapshot fails
    d = _drain(s, 105.0)
    assert d[KEY_ACCEPTED_TOKENS] == 0.0


# -------------------------------------------------------------- window %


def test_depth_ladder_uses_depth_drafted_denominator():
    s = MtpSampler()
    _drain(s, 100.0)
    st = FakeStats(cycles=4, accepts=5, zero_cycles=1,
                   depth_drafted=[4, 4, 2, 0, 0],
                   depth_accepted=[4, 3, 1, 0, 0])
    s.note_finish(st, now=101.0)
    d = _drain(s, 105.0)
    # accept % = accepts / sum(depth_drafted) = 5/10 (PR-990 headline)
    assert d[KEY_ACCEPT_PCT] == pytest.approx(100.0 * 5 / 10)
    assert d[f"{KEY_DEPTH_PREFIX}1_pct"] == pytest.approx(100.0)
    assert d[f"{KEY_DEPTH_PREFIX}2_pct"] == pytest.approx(75.0)
    assert d[f"{KEY_DEPTH_PREFIX}3_pct"] == pytest.approx(50.0)
    assert d[f"{KEY_DEPTH_PREFIX}4_pct"] == 0.0
    assert d[KEY_ZERO_CYCLES_PCT] == pytest.approx(25.0)
    assert d["mtp.depth_avg"] == pytest.approx(8 / 4)


def test_window_semantics_reset_each_drain():
    """Percent keys are per-window means, not lifetime: a heavy first
    window must not hold the line up after the engine turns unproductive."""
    s = MtpSampler()
    _drain(s, 100.0)
    good = FakeStats(cycles=10, accepts=10, depth_drafted=[10],
                     depth_accepted=[10])
    s.note_finish(good, now=101.0)
    assert _drain(s, 105.0)[KEY_ACCEPT_PCT] == pytest.approx(100.0)
    bad = FakeStats(cycles=10, accepts=0, depth_drafted=[10],
                    depth_accepted=[0])
    s.note_finish(bad, now=106.0)
    assert _drain(s, 110.0)[KEY_ACCEPT_PCT] == pytest.approx(0.0)


def test_sample_states_never_raises_on_junk():
    s = MtpSampler()
    s.sample_states([None, object(), FakeStats(cycles="x")], now=100.0)
    s.sample_states("not-an-iterable-item-type"[0:0], now=100.0)  # empty
    assert _drain(s, 105.0)[KEY_ACCEPTED_TOKENS] == 0.0
