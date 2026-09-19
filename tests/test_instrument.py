"""RL3-GAP1 acceptance: event-driven capture (note_birth / note_finalize)
and the instrument wrapper's total-function behavior.

The gap: requests born AND finishing inside one collector tick never
appeared in ring or db. The fix wraps AsyncEngineCore.add_request /
_cleanup_request; these tests exercise the tracker-side sinks directly
(the wrappers are thin and fully guarded) plus install() idempotence.
"""
import time

import pytest

from omlx_uplift.request_log import RequestTracker


class _Req:
    def __init__(self, prompt="say hi", rid="r1"):
        self.request_id = rid
        self.prompt = prompt
        self.num_prompt_tokens = 7
        class SP: temperature, top_p, max_tokens = 0.5, 0.9, 32
        self.sampling_params = SP()


def test_birth_creates_queued_row_with_payload():
    tr = RequestTracker()
    tr.note_birth("r1", "model-x", _Req())
    rows = tr.list_rows()
    assert rows[0]["id"] == "r1" and rows[0]["state"] == "queued"
    assert rows[0]["prompt"] == "say hi"
    assert '"temperature": 0.5' in rows[0]["params"]
    assert "r1" in tr._dirty_ids


def test_finalize_wins_over_tick_and_stays_final():
    tr = RequestTracker()
    tr.note_birth("r1", "model-x", _Req())
    tr._active["r1"]["ts"] = time.time() - 2.0
    snap = {"has_output": True, "output_text": "hello world",
            "completion_tokens": 20, "finish_reason": "stop", "params": ""}
    tr.note_finalize("r1", "model-x", snap)
    assert not tr.is_live("r1")
    done = [r for r in tr.list_rows() if r["id"] == "r1"][0]
    assert done["state"] == "complete" and done["output"] == "hello world"
    assert done["finish"] == "stop" and done["completion_tokens"] == 20
    assert done["tps"] == pytest.approx(10.0, rel=0.5)
    # a late birth event must NOT resurrect the finalized row
    tr.note_birth("r1", "model-x", _Req())
    assert tr.is_live("r1") is False


def test_finalize_without_output_is_error_not_lie():
    tr = RequestTracker()
    tr.note_birth("r1", "m", _Req())
    tr.note_finalize("r1", "m", {"has_output": True, "output_text": "",
                                 "completion_tokens": 0,
                                 "finish_reason": "aborted", "params": ""})
    done = [r for r in tr.list_rows() if r["id"] == "r1"][0]
    assert done["state"] == "error" and done["error"] == "aborted"


def test_finalize_drained_stream_keeps_tick_counters():
    # Streaming consumer drained everything: harvest arrives empty, but
    # the tick path already saw generating + counters. Row must stay
    # 'complete' with the tick's numbers — never rewritten to error/0.
    tr = RequestTracker()
    tr.note_birth("r1", "m", _Req())
    tr._active["r1"].update(state="generating", completion_tokens=57)
    tr.note_finalize("r1", "m", {"has_output": True, "output_text": "",
                                 "completion_tokens": 0,
                                 "finish_reason": "", "params": ""})
    done = [r for r in tr.list_rows() if r["id"] == "r1"][0]
    assert done["state"] == "complete" and done["error"] is None
    assert done["completion_tokens"] == 57        # tick's count preserved


def test_finalize_without_output_flag_is_noop():
    tr = RequestTracker()
    tr.note_birth("r1", "m", _Req())
    tr.note_finalize("r1", "m", {"has_output": False})
    assert tr.is_live("r1")          # untouched; tick path owns it
    done_ids = {r["id"] for r in tr._done}
    assert "r1" not in done_ids


def test_finalize_standalone_row_without_birth():
    # birth hook missed (e.g. engine mounted earlier) — finalize alone
    # must still produce a full row; counters present, model retained.
    tr = RequestTracker()
    tr.note_finalize("r9", "m", {"has_output": True, "output_text": "x",
                                 "completion_tokens": 3,
                                 "finish_reason": "stop",
                                 "params": '{"temperature": 1}'})
    done = [r for r in tr.list_rows() if r["id"] == "r9"][0]
    assert done["state"] == "complete" and done["model"] == "m"
    assert done["params"] == '{"temperature": 1}'


def test_done_ids_bounded():
    tr = RequestTracker()
    for i in range(1000):
        tr.note_finalize("r%d" % i, "m",
                         {"has_output": True, "output_text": "t",
                          "completion_tokens": 1, "finish_reason": "stop",
                          "params": ""})
    assert len(tr._done_ids) <= 4 * 200 + 1
    assert len(tr._done) == 200        # ring cap unchanged


def test_instrument_install_idempotent_and_total():
    from omlx_uplift import instrument

    instrument.install()
    instrument.install()               # second call is a no-op
    from omlx.engine_core import AsyncEngineCore, EngineCore
    assert getattr(AsyncEngineCore.add_request, "_uplift_hook", False)
    assert getattr(EngineCore.add_request, "_uplift_hook", False)
    assert getattr(EngineCore._cleanup_request, "_uplift_hook", False)
