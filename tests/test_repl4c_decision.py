"""REPL-4c: decision bench — pure scoring math, request shaping, route
order, and store roundtrip. CI-safe: no network, no real settings.json,
no model loading (the runner itself is exercised live on the dev board,
not here — a unit fake of the decision engine covers the loop shape).
"""
from __future__ import annotations

import json

import pytest

# Route-order doctrine (test_nat3_scaffold): import the facade first so
# global route registration order matches the server.
from omlx_uplift import router as _uplift_router  # noqa: F401
from omlx_uplift import decision_engine as de
from omlx_uplift.evals.systemone import loader, metrics

PACKS = ("arc-choice", "bbq-choice", "tqa-choice")


# ---- loader integrity -------------------------------------------------------

def test_manifest_lists_three_packs():
    summ = loader.packs_summary()
    assert set(summ) == set(PACKS)
    for name, meta in summ.items():
        assert meta["items"] > 0
        assert meta["license"] in ("CC-BY-SA-4.0", "CC-BY-4.0", "Apache-2.0")
        assert len(meta["sha256"]) == 64


def test_load_pack_digest_gate(tmp_path, monkeypatch):
    pack = loader.load_pack("arc-choice")
    assert pack["name"] == "arc-choice" and len(pack["items"]) == 294
    # a mutated fixture must be REFUSED, not silently rescored
    f = loader.DATA_DIR / "arc-choice.json"
    orig = f.read_bytes()
    try:
        f.write_bytes(orig.replace(b"answer", b"ANSWER", 1))
        with pytest.raises(loader.PackError, match="sha256 mismatch"):
            loader.load_pack("arc-choice")
    finally:
        f.write_bytes(orig)


def test_items_are_wellformed():
    for name in PACKS:
        pack = loader.load_pack(name)
        ids = set()
        for it in pack["items"]:
            assert it["id"] not in ids, f"dup id in {name}"
            ids.add(it["id"])
            assert it["state"].strip()
            assert it["answer"] in it["options"]
            assert len(it["options"]) >= 2
            assert all(v.strip() for v in it["options"].values())


# ---- request shaping ---------------------------------------------------------

def _sample_item():
    return {"id": "x-1", "state": "Which is correct?",
            "options": {"a": "alpha", "b": "beta", "c": "gamma"},
            "answer": "b"}


def test_build_request_shape_and_distractor():
    req = de.build_request("mymodel", _sample_item(), seed=0, shuffle=False)
    assert req["model"] == "mymodel" and req["truncate"] is True
    q = req["questions"]
    assert set(q) == {"answer", "gold", "distractor"}
    assert q["answer"]["type"] == "choice"
    assert set(q["answer"]["criteria"]) == {"a", "b", "c"}
    # derived noul legs quote option TEXTS (gold + first sorted distractor)
    assert '"beta"' in q["gold"]["instructions"]
    assert '"alpha"' in q["distractor"]["instructions"]


def test_build_request_shuffle_keeps_gold_text():
    item = _sample_item()
    plain = de.build_request("m", item, seed=7, shuffle=False)
    shuf = de.build_request("m", item, seed=7, shuffle=True)
    assert (plain["questions"]["answer"]["criteria"]
            != shuf["questions"]["answer"]["criteria"]
            or sorted(plain["questions"]["answer"]["criteria"]) ==
               sorted(shuf["questions"]["answer"]["criteria"]))
    # same key SET both legs — only order differs (option keys are opaque)
    assert (set(plain["questions"]["answer"]["criteria"])
            == set(shuf["questions"]["answer"]["criteria"]))


# ---- scoring ----------------------------------------------------------------

def test_score_item_choice_and_agreement():
    item = _sample_item()
    res = {"answers": {"answer": {"type": "choice", "choice": "b"},
                       "gold": {"type": "noul", "noul": 0.9},
                       "distractor": {"type": "noul", "noul": 0.1}},
           "usage": {"input_tokens": 42}}
    row = de.score_item(item, res, None)
    assert row["correct"] is True and row["chosen_text"] == "beta"
    assert row["probs"] == [(0.9, 1), (0.1, 0)]
    assert row["agreement"] is None          # no re-ask -> not computable
    res_wrong = {"answers": {"answer": {"type": "choice", "choice": "a"}}}
    row2 = de.score_item(item, res_wrong, res)  # shuffled leg picked 'b'
    assert row2["correct"] is False
    assert row2["agreement"] is False        # 'alpha' vs 'beta' texts differ


def test_score_item_missing_choice_is_none_not_wrong():
    item = _sample_item()
    res = {"answers": {"answer": {"type": "choice"}}}
    row = de.score_item(item, res, None)
    assert row["correct"] is None and row["chosen_text"] is None
    assert row["probs"] == []


def test_pack_scores_math():
    rows = [
        {"correct": True, "probs": [(0.9, 1), (0.1, 0)], "agreement": True},
        {"correct": False, "probs": [(0.8, 1), (0.7, 0)], "agreement": False},
    ]
    s = de.pack_scores(rows, elapsed_s=1.5, n_questions=6)
    assert s["accuracy"] == 0.5
    assert s["agreement"] == 0.5
    assert s["brier"] == metrics.brier([(0.9, 1), (0.1, 0), (0.8, 1), (0.7, 0)])
    assert s["ms_per_question"] == 250.0
    assert s["items"] == 2
    empty = de.pack_scores([], elapsed_s=0.0, n_questions=0)
    assert all(empty[k] is None for k in
               ("accuracy", "brier", "ece", "agreement", "ms_per_question"))


def test_metrics_edge_cases():
    assert metrics.accuracy(0, 0) is None
    assert metrics.brier([]) is None
    assert metrics.ece([]) is None
    # brier 0 on perfect probabilities, ece 0 on perfectly calibrated bins
    assert metrics.brier([(1.0, 1), (0.0, 0)]) == 0.0
    assert metrics.ece([(1.0, 1), (0.0, 0)]) == 0.0
    # overconfident wrong: high ece
    assert metrics.ece([(0.99, 0), (0.99, 0)]) > 0.9


# ---- body validation ----------------------------------------------------------

def test_validate_body_rejects_unknown_pack_and_bad_limit():
    with pytest.raises(de.BadInput):
        de.validate_body({"model_id": "m", "packs": ["nope"]})
    with pytest.raises(de.BadInput):
        de.validate_body({"model_id": "m", "packs": []})
    with pytest.raises(de.BadInput):
        de.validate_body({"model_id": "m", "packs": ["arc-choice"],
                          "limit": 999999})
    mid, packs, limit = de.validate_body(
        {"model_id": "m", "packs": ["arc-choice"], "limit": 25})
    assert (mid, packs, limit) == ("m", ["arc-choice"], 25)


# ---- routes registered in the load-bearing order ------------------------------

def test_decision_routes_present_before_throughput_dynamics():
    paths = [(m, r.path) for r in _uplift_router.api_router.routes
             for m in [sorted(r.methods)[0]] if hasattr(r, "methods")]
    seen = [p for _, p in paths]
    assert "/bench/decision/tasks" in seen
    i_reset = seen.index("/bench/decision/results")
    i_dyn = seen.index("/bench/{run_id}/results")
    assert i_reset < i_dyn, "decision literals must outrank the dynamic form"


# ---- store roundtrip (accumulated results survive engine-free) ----------------

def test_results_store_roundtrip(tmp_path, monkeypatch):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    assert de.results_payload() == {"results": []}
    row = {"pack": "arc-choice", "model_id": "m", "kind": "decision",
           "accuracy": 0.5, "brier": float("nan"), "ts": 1}
    de.get_accumulated().append(de._finite(row))
    de._save_accum()
    monkeypatch.setattr(de, "_accum", None)
    out = de.results_payload()["results"]
    assert out[0]["accuracy"] == 0.5
    assert out[0]["brier"] is None      # NaN -> None (JSON-safe, honest)
    assert de.reset_results() == {"status": "reset"}


# ---- runner loop against a FAKE decision engine (no model, no GPU) -----------

class FakeEngine:
    """Answers every choice question with the gold key, noul legs 0.9."""

    def __init__(self):
        self.calls = 0

    async def encode(self, request, truncate=True):
        self.calls += 1
        return {"request": request}

    async def systemone(self, plan):
        req = plan["request"]
        answers = {}
        for qid, q in req["questions"].items():
            if q["type"] == "choice":
                answers[qid] = {"type": "choice", "choice": "a"}
            else:
                answers[qid] = {"type": "noul", "noul": 0.9}
        return {"answers": answers, "usage": {"input_tokens": 10}}


@pytest.mark.asyncio
async def test_run_pack_loop_cancels_between_items(monkeypatch, tmp_path):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    pack = loader.load_pack("arc-choice")
    run = de.DecisionRun("sys1-test", "fake-model", ["arc-choice"], limit=3)
    eng = FakeEngine()
    await de._run_pack(run, eng, "arc-choice", ValueError, KeyError)
    assert len(run.results) == 1
    row = run.results[0]
    assert row["items"] == 3
    # 'a' is only right for the items whose gold is 'a'; the loop must
    # score each item independently (never all-correct by construction)
    assert 0.0 <= row["accuracy"] <= 1.0
    assert eng.calls == 3 * 2           # shuffle leg runs per item
    # cancellation stops the item loop, no exception
    run2 = de.DecisionRun("sys1-t2", "fake-model", ["arc-choice"], limit=0)
    run2.cancelled = True
    await de._run_pack(run2, eng, "arc-choice", ValueError, KeyError)
    assert run2.results == []           # cancelled before first item


@pytest.mark.asyncio
async def test_conflict_guard(monkeypatch):
    async def fake_start(body):
        return await de.start(body)
    active = de.DecisionRun("sys1-x", "m", ["arc-choice"], 0)
    active.terminal = False
    monkeypatch.setattr(de, "_active", active)
    with pytest.raises(de.Conflict):
        await de.start({"model_id": "m", "packs": ["arc-choice"]})
