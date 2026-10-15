"""QR-RAW: harness runs must carry raw per-question records too.

The user wants raw question/result downloads for ALL bench types —
the harness (lm_eval) path shipped `question_results: []`, so its rows
showed a score with no per-question drill-down. lm_eval emits per-request
lines with --log_samples; the mapping into classic's QR contract is pinned
here:

- _suite_args carries --log_samples (one code path, every suite)
- _collect_question_results maps lm_eval sample lines to the classic QR
  keys (id/question/expected/predicted/correct/raw_response/finish_reason/
  prompt_tokens/completion_tokens/time_s/category) — nested resps flattened,
  correct from the computed metric, untracked fields null (never invented)
- rows dedupe by id (first line wins); leaf name parsed from the file
"""
import json
import types

import pytest

from omlx_uplift import harness_engine as he


def _sample_line(leaf, doc_id, question, target, raw, filtered, metric,
                 score):
    return json.dumps({
        "doc_id": doc_id,
        "doc": {"question": question},
        "target": target,
        "arguments": {"gen_args_0": {"arg_0": question,
                                      "arg_1": {"until": [""]}}},
        "resps": [[raw]],
        "filtered_resps": [filtered],
        "filter": "default-extract",
        "metrics": [metric],
        metric: score,
    })


def test_suite_args_always_log_samples():
    spec = he.HARNESS_MAP["prox_lite_cs_direct"]
    a = he._suite_args(spec, "http://x/v1", "m",
                       __import__("pathlib").Path("/tmp/oqr"), 4,
                       "model_settings")
    assert "--log_samples" in a
    # exactly one log_samples line even though the suite has 14 leaves:
    # a single subprocess run covers the whole group
    assert a.count("--log_samples") == 1


def test_collect_maps_lm_eval_lines_to_classic_qr_contract(tmp_path):
    leaf_a = tmp_path / "m1"
    leaf_a.mkdir()
    (leaf_a / "samples_leaf_one_2026-10-16T01-02-03.400000.jsonl").write_text(
        _sample_line("leaf_one", 0, "Kolik je 2+2?", "C", "C",
                     "C", "exact_match", 1.0) + "\n" +
        _sample_line("leaf_one", 1, "Hlavne mesto CECH?", "Praha",
                     "Prague", "Prague", "exact_match", 0.0) + "\n",
        encoding="utf-8")
    # same leaf again (a re-run lands a second timestamped file): the SAME
    # doc ids must not duplicate rows — first line wins
    (leaf_a / "samples_leaf_one_2026-10-16T02-00-00.000000.jsonl").write_text(
        _sample_line("leaf_one", 0, "Kolik je 2+2?", "C", "D",
                     "D", "exact_match", 0.0) + "\n",
        encoding="utf-8")
    leaf_b = tmp_path / "m1"
    (leaf_b / "samples_leaf_two_2026-10-16T03-00-00.000000.jsonl").write_text(
        _sample_line("leaf_two", 5, "Co je to?", "x", "y",
                     "y", "acc", 1.0) + "\n", encoding="utf-8")

    rows = he._collect_question_results(tmp_path)
    assert len(rows) == 3   # 2 (leaf_one deduped) + 1 (leaf_two)
    by_id = {r["id"]: r for r in rows}
    assert set(by_id) == {"leaf_one:0", "leaf_one:1", "leaf_two:5"}
    r0 = by_id["leaf_one:0"]
    assert r0["question"] == "Kolik je 2+2?"
    assert r0["expected"] == "C"
    assert r0["predicted"] == "C"       # first file wins (dedupe)
    assert r0["correct"] is True        # metric 1.0
    assert r0["raw_response"] == "C"
    assert r0["category"] == "leaf_one"
    # untracked fields stay null, never invented
    assert r0["finish_reason"] is None
    assert r0["prompt_tokens"] is None
    assert r0["time_s"] is None
    r1 = by_id["leaf_one:1"]
    assert r1["correct"] is False       # metric 0.0
    # ordering: by file name (leaf_one first, then leaf_two), stable
    assert [r["id"] for r in rows] == ["leaf_one:0", "leaf_one:1",
                                          "leaf_two:5"]


def test_collect_tolerates_garbage(tmp_path):
    d = tmp_path / "m"
    d.mkdir()
    good = _sample_line("t1", 0, "q", "a", "a", "a", "exact_match", 1.0)
    (d / "samples_t1_2026-10-16T01-00-00.000000.jsonl").write_text(
        good + "\nnot-json\n\n" + good + "\n", encoding="utf-8")
    rows = he._collect_question_results(tmp_path)
    assert len(rows) == 1               # garbage + dup dropped
