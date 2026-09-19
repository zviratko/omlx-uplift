"""RL-4 acceptance: detect_repeat / loop_hint on fixture samples.

Must trip: classic degenerate repetition (long unit, >=3 tiling repeats).
Must NOT trip: markdown tables, code with short repeated tokens, normal
prose, CJK prose; short-unit repetition (formatting) stays silent even
with many repeats.
"""
import time

from omlx_uplift.request_log import (LOOP_MIN_REPEATS, LOOP_MIN_UNIT,
                                     RequestTracker, detect_repeat, loop_hint)

# A 40+ char unit repeated 6x — the canonical runaway.
UNIT = "the model will now explain this in more detail: "
LOOP = "intro. " + UNIT * 6

# A markdown table: pipes and row prefixes repeat, but every row differs.
TABLE = ("| model | tps | state |\n"
         "| a-mini | 12.4 | complete |\n"
         "| b-mid | 8.1 | generating |\n"
         "| c-big | 2.0 | queued |\n") * 3

# Code-ish: short tokens repeat (8 spaces), content varies.
CODE = "".join("        return value_%d\n" % i for i in range(12))

PROSE = ("Photosynthesis converts light energy into chemical energy. "
         "Plants capture photons in thylakoid membranes and split water, "
         "releasing oxygen while generating ATP and NADPH for the Calvin "
         "cycle, which fixes carbon dioxide into sugars over many steps.")

CJK = ("光合作用は植物が光エネルギーを化学エネルギーに変える過程です。"
       "类囊体膜で光子を捕捉し水を分解して酸素を放出します。") * 2


def test_loop_trips():
    assert detect_repeat(LOOP) >= LOOP_MIN_REPEATS
    assert loop_hint(LOOP)


def test_table_and_code_do_not_trip():
    assert detect_repeat(TABLE) == 0.0
    assert detect_repeat(CODE) == 0.0
    assert not loop_hint(TABLE) and not loop_hint(CODE)


def test_prose_and_cjk_do_not_trip():
    assert detect_repeat(PROSE) == 0.0
    assert detect_repeat(CJK) == 0.0        # 2x != 3x, and unit is long
    assert detect_repeat("unknown") == 0.0  # shorter than 3 units
    assert not loop_hint(PROSE) and not loop_hint(CJK)


def test_short_unit_repetition_stays_silent():
    # 'ab' * 300: repeating, but unit < LOOP_MIN_UNIT -> formatting noise.
    assert loop_hint("ab" * 300) is False


def test_exactly_threshold_trips():
    unit = "x" * LOOP_MIN_UNIT + "|"          # 21 chars
    assert loop_hint(unit * LOOP_MIN_REPEATS)


def test_unit_just_below_threshold_silent():
    unit = "x" * (LOOP_MIN_UNIT - 2) + "|"    # 19 chars
    assert loop_hint(unit * LOOP_MIN_REPEATS) is False


def test_cjk_loop_trips():
    unit = "系统调用已经完成，正在等待下一次调度处理。"   # >20 chars
    assert loop_hint("开头。" + unit * 4)


# ---- token-id twin -------------------------------------------------------

from omlx_uplift.request_log import detect_repeat_tokens, LOOP_TOK_MIN_UNIT


def test_token_loop_trips():
    unit = list(range(1000, 1000 + LOOP_TOK_MIN_UNIT))
    assert detect_repeat_tokens([7] * 3 + unit * 4) >= LOOP_MIN_REPEATS
    assert detect_repeat_tokens(unit * LOOP_MIN_REPEATS) >= LOOP_MIN_REPEATS


def test_token_varied_and_short_stay_silent():
    assert detect_repeat_tokens(list(range(500))) == 0.0
    assert detect_repeat_tokens([1, 2] * 200) == 0.0     # unit < 20 tokens
    assert detect_repeat_tokens(list(range(40)) * 2) == 0.0   # only 2x


# ---- wiring: sample pass sets loop_hint only when output grew ----------

class _Out:
    def __init__(self, text):
        self.output_text, self.finish_reason = text, None


class _Coll:
    def __init__(self):
        self.output = None


def test_sample_pass_sets_loop_hint_on_growth(tmp_path):
    tr = RequestTracker()
    coll = _Coll()

    class Entry: pass
    class Core:
        _output_collectors = {"r1": coll}
        scheduler = None
    class Async: engine = Core()
    class Eng: _engine = Async()
    class E(Entry): engine = Eng()
    class Pool: _entries = {"m": E()}

    class Req:
        request_id, num_prompt_tokens = "r1", 5
        generation_started_at = time.monotonic() - 2
        num_generated_tokens = 40
        state = "generating"

    class Snap:
        def snapshot_for_admin(self):
            return {"waiting": [], "running_by_id": {"r1": Req()}}
    Core.scheduler = Snap()

    tr.sample(Pool)                       # no text yet
    assert not tr.list_rows()[0].get("loop_hint")

    coll.output = _Out(LOOP)              # text grew -> hint on
    dirty_before = set(tr._dirty_ids)
    tr._dirty_ids.clear()
    tr.sample(Pool)
    assert tr.list_rows()[0]["loop_hint"] is True
    assert "r1" in tr._dirty_ids          # chip change is dirty-flagged

    tr._dirty_ids.clear()
    tr.sample(Pool)                       # no growth -> not recomputed,
    assert tr.list_rows()[0]["loop_hint"] is True   # hint sticks, no churn
    assert "r1" not in tr._dirty_ids
