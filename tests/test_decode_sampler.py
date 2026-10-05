"""BE-decode acceptance: the momentary generation (decode) sampler.

The bug: the Throughput chart's generation line plotted avg_generation_tps,
a SESSION-LIFETIME AVERAGE (completion tokens / generation seconds since
boot, updated only when a request FINISHES). On a long-running server that
is a near-static line — the user read it as "cumulative stats". The fix:
per-tick deltas of the in-flight requests' num_output_tokens, stored as
generation.tokens_s.

These tests exercise the sampler directly (the wrappers in instrument.py
and the pool walk in collectors.py are thin and fully guarded — same split
as test_prefill_sampler.py).
"""
import pytest

from omlx_uplift.decode_sampler import (KEY_GENERATION_TOKENS, MAX_TRACKED,
                                        ROW_STALE_S, DecodeSampler)


def _drain(s, now):
    return s.drain(now=now)[KEY_GENERATION_TOKENS]


# ---------------------------------------------------------------- opening


def test_first_drain_opens_the_window_with_zero():
    s = DecodeSampler()
    assert _drain(s, 100.0) == 0.0           # opens the window, credits none
    s.note_birth("r1")
    s.sample_running([("r1", 40)], now=101.0)
    # rate over the WHOLE window since the previous drain (100 -> 105)
    assert _drain(s, 105.0) == pytest.approx(40 / 5.0)
    s.sample_running([("r1", 80)], now=106.0)
    assert _drain(s, 110.0) == pytest.approx(40 / 5.0)


def test_zero_always_written_when_idle():
    """A drained engine is a DATA POINT — skipping zeros truncated the old
    series exactly when generation stopped."""
    s = DecodeSampler()
    _drain(s, 100.0)
    assert _drain(s, 105.0) == 0.0
    assert KEY_GENERATION_TOKENS in s.drain(now=110.0)


def test_dt_zero_keeps_the_accumulator_for_the_next_tick():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 50)], now=100.5)
    assert _drain(s, 100.0) == 0.0           # no window: never a fake spike
    assert _drain(s, 105.0) == pytest.approx(50 / 5.0)   # still accumulated


# ------------------------------------------------------------- crediting


def test_growth_between_ticks_is_credited_once():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 10)], now=101.0)
    assert _drain(s, 105.0) == pytest.approx(10 / 5.0)
    s.sample_running([("r1", 10)], now=106.0)   # no growth -> no credit
    assert _drain(s, 110.0) == 0.0
    s.sample_running([("r1", 35)], now=111.0)
    assert _drain(s, 115.0) == pytest.approx(25 / 5.0)


def test_many_inflight_requests_sum_into_one_server_rate():
    s = DecodeSampler()
    _drain(s, 100.0)
    for r in ("a", "b", "c"):
        s.note_birth(r)
    s.sample_running([("a", 20), ("b", 30), ("c", 50)], now=105.0)
    assert _drain(s, 105.0) == pytest.approx(100 / 5.0)


def test_unborn_row_baselines_and_credits_nothing():
    """A request already generating when the hooks were installed must not
    dump its whole pre-existing count into one tick — that is the same
    cumulative lie this series replaces."""
    s = DecodeSampler()
    _drain(s, 100.0)
    s.sample_running([("r1", 9000)], now=105.0)     # first sighting
    assert _drain(s, 105.0) == 0.0
    s.sample_running([("r1", 9010)], now=110.0)     # growth IS credited
    assert _drain(s, 110.0) == pytest.approx(10 / 5.0)


def test_departure_flushes_what_the_last_tick_could_not_see():
    """Sub-tick blind spot: born AND finished inside one 5 s window is
    invisible to the walk; the departure hook must still count all of it."""
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.note_end("r1", 250)                    # never seen by any tick walk
    assert _drain(s, 105.0) == pytest.approx(250 / 5.0)


def test_departure_never_double_counts_tokens_a_tick_credited():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 60)], now=105.0)
    assert _drain(s, 105.0) == pytest.approx(60 / 5.0)
    s.note_end("r1", 90)                     # only the tail 30 is new
    s.sample_running([("r1", 90)], now=110.0)   # stale tick still lists it
    assert _drain(s, 110.0) == pytest.approx(30 / 5.0)


def test_departure_of_an_untracked_row_credits_it_in_full():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_end("rX", 42)                     # born+finished between ticks,
    assert _drain(s, 105.0) == pytest.approx(42 / 5.0)    # birth hook missed


def test_aborted_generation_keeps_the_tokens_already_decoded():
    """Upstream's completion-time counters never see an abort; here the
    departure hook fires with whatever the request actually produced."""
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 300)], now=105.0)
    _drain(s, 105.0)
    s.note_end("r1", 340)                    # client disconnected at 340
    assert _drain(s, 110.0) == pytest.approx(40 / 5.0)


def test_recycled_id_rebaselines_instead_of_reading_backward():
    """Same key, count went BACKWARD = a new request restarted from zero."""
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 500)], now=105.0)
    _drain(s, 105.0)
    s.sample_running([("r1", 3)], now=110.0)         # recycled: baseline 3
    assert _drain(s, 110.0) == 0.0                   # never a negative spike
    s.sample_running([("r1", 23)], now=115.0)
    assert _drain(s, 115.0) == pytest.approx(20 / 5.0)


# ----------------------------------------------------------- robustness


def test_junk_rows_are_skipped_not_raised():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("good")
    s.sample_running([
        ("", 10), ("none", None), ("junk", "abc"), ("neg", -5),
        ("good", 12),
    ], now=105.0)
    assert _drain(s, 105.0) == pytest.approx(12 / 5.0)


def test_unreadable_count_does_not_reset_the_credited_total():
    """None (attribute drift) must SKIP the row, not credit it as zero —
    a zero baseline would let note_end re-credit the whole generation."""
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 100)], now=105.0)
    _drain(s, 105.0)
    s.sample_running([("r1", None)], now=110.0)   # drift: row untouched
    s.note_end("r1", 120)
    assert _drain(s, 115.0) == pytest.approx(20 / 10.0)   # window 105 -> 115


def test_none_rows_argument_is_harmless():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.sample_running(None, now=105.0)
    assert _drain(s, 105.0) == 0.0


def test_note_end_junk_is_dropped_not_raised():
    s = DecodeSampler()
    _drain(s, 100.0)
    for bad in (None, "x", -1):
        s.note_end("r1", bad)
    assert _drain(s, 105.0) == 0.0


def test_birth_and_end_ignore_an_empty_key():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("")
    s.note_end("", 500)
    assert _drain(s, 105.0) == 0.0


# ---------------------------------------------------------- housekeeping


def test_departed_rows_expire_and_free_the_map():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 5)], now=105.0)
    s.drain(now=105.0)
    s.drain(now=105.0 + ROW_STALE_S + 1)
    assert "r1" not in s._rows


def test_eviction_bounds_the_row_map():
    s = DecodeSampler()
    _drain(s, 100.0)
    for i in range(MAX_TRACKED + 50):
        s.sample_running([(f"r{i}", 1)], now=100.0 + i * 1e-4)
    s.drain(now=200.0)
    assert len(s._rows) <= MAX_TRACKED


# ------------------------------------------------------- the reported bug


def test_a_single_short_generation_moves_the_line():
    """What the user could not get out of avg_generation_tps: one short
    request on a server that has served millions of tokens must be VISIBLE
    in its own tick, not diluted by the session total."""
    s = DecodeSampler()
    _drain(s, 100.0)
    for _ in range(1000):                    # a long, busy session before
        s.note_birth("bulk")
        s.note_end("bulk", 200)
        s.sample_running([], now=100.0 + _ * 0.001)
    s.drain(now=105.0)
    s.note_birth("mine")
    s.note_end("mine", 60)                   # one short generation, 1 tick
    assert _drain(s, 110.0) == pytest.approx(60 / 5.0)


def test_idle_after_load_returns_to_zero_instead_of_holding():
    s = DecodeSampler()
    _drain(s, 100.0)
    s.note_birth("r1")
    s.sample_running([("r1", 100)], now=102.0)
    assert _drain(s, 105.0) == pytest.approx(100 / 5.0)
    s.note_end("r1", 100)
    assert _drain(s, 110.0) == 0.0           # drains to a real zero


# ---------------------------------------------------- collector plumbing


class _Req:
    """Minimal stand-in for the scheduler Request (num_output_tokens is a
    progressive property upstream)."""

    def __init__(self, n):
        self.num_output_tokens = n


class _Sched:
    def __init__(self, rows):
        self.rows = rows

    def snapshot_for_admin(self):
        return {"running_by_id": dict(self.rows)}


class _BadSched:
    def snapshot_for_admin(self):
        raise RuntimeError("engine thread went away")


def _pool(models):
    """models: {mid: sched} in the entry.engine._engine.engine.scheduler
    shape corewalk.scheduler_for walks."""
    class Core:
        def __init__(s, s_):
            s.scheduler = s_

    class AsyncCore:
        def __init__(s, s_):
            s.engine = Core(s_)

    class Engine:
        def __init__(s, s_):
            s._engine = AsyncCore(s_)

    class Entry:
        def __init__(s, s_):
            s.engine = Engine(s_)

    entries = {m: Entry(sc) for m, sc in models.items()}

    class Pool:
        def get_loaded_model_ids(s):
            return list(entries)

        def get_entry(s, mid):
            return entries[mid]

    return Pool()


@pytest.fixture
def fresh_sampler(monkeypatch):
    from omlx_uplift import decode_sampler as ds
    monkeypatch.setattr(ds, "_sampler", ds.DecodeSampler())
    return ds.get_decode_sampler()


def test_collect_generation_credits_inflight_growth(fresh_sampler):
    from omlx_uplift.collectors import collect_generation
    pool = _pool({"m1": _Sched({"a": _Req(5), "b": _Req(7)})})
    assert collect_generation(pool, now=100.0)[KEY_GENERATION_TOKENS] == 0.0
    # rows are baselined on first sight; only the next window's growth counts
    for r in pool.get_entry("m1").engine._engine.engine.scheduler.rows.values():
        r.num_output_tokens += 20
    got = collect_generation(pool, now=110.0)[KEY_GENERATION_TOKENS]
    assert got == pytest.approx(40 / 10.0)


def test_collect_generation_writes_zero_without_a_pool(fresh_sampler):
    """pool probe failed / nothing loaded: the key must still be written —
    an absent key truncated the old series exactly when the engine drained."""
    from omlx_uplift.collectors import collect_generation
    collect_generation(None, now=100.0)
    assert collect_generation(None, now=105.0) == {KEY_GENERATION_TOKENS: 0.0}


def test_one_broken_model_does_not_cost_the_others(fresh_sampler):
    from omlx_uplift.collectors import collect_generation
    good = _Sched({"a": _Req(1)})
    pool = _pool({"bad": _BadSched(), "good": good})
    collect_generation(pool, now=100.0)
    good.rows["a"].num_output_tokens = 26
    assert collect_generation(pool, now=105.0)[KEY_GENERATION_TOKENS] \
        == pytest.approx(25 / 5.0)


def test_same_request_id_on_two_models_credits_both(fresh_sampler):
    """Row keys are model-qualified: an id collision must not make one
    engine's tokens invisible to the other's delta."""
    from omlx_uplift.collectors import collect_generation
    a, b = _Sched({"x": _Req(0)}), _Sched({"x": _Req(0)})
    pool = _pool({"m1": a, "m2": b})
    collect_generation(pool, now=100.0)
    a.rows["x"].num_output_tokens = 10
    b.rows["x"].num_output_tokens = 20
    assert collect_generation(pool, now=105.0)[KEY_GENERATION_TOKENS] \
        == pytest.approx(30 / 5.0)
