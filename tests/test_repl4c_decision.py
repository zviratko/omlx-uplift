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
    # LEGACY name, PER-PROBE basis: 2 fixture items cost 6 probes
    # (3 in the main call + 1 re-ask each), so 1500ms/6 = 250ms per probe.
    assert s["ms_per_question"] == 250.0
    # the figure the UI labels 'ms/question' divides by ITEMS (user 2026-10-13)
    assert s["ms_per_item"] == round(1500 / len(rows), 2)
    assert s["ms_per_item"] == 750.0
    # ...and the probe count is now visible so the two can never be confused
    assert s["probes"] == 6
    assert s["time_s"] == 1.5
    assert s["items"] == 2
    empty = de.pack_scores([], elapsed_s=0.0, n_questions=0)
    assert all(empty[k] is None for k in
               ("accuracy", "brier", "ece", "agreement", "ms_per_question",
                "ms_per_item"))
    assert empty["probes"] == 0     # 0 probes, not None — a count, not a rate


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


def test_validate_body_sorts_packs():
    # packs arrive in UI CLICK order; execution order must not depend on it
    # (user request 2026-10-13) — same SET always yields the same sequence
    mid, packs, limit = de.validate_body(
        {"model_id": "m",
         "packs": ["tqa-choice", "arc-choice", "bbq-choice"], "limit": 0})
    assert mid == "m" and limit == 0
    assert packs == ["arc-choice", "bbq-choice", "tqa-choice"]


# ---- routes registered in the load-bearing order ------------------------------

def test_decision_routes_present_before_throughput_dynamics():
    paths = [(m, r.path) for r in _uplift_router.api_router.routes
             for m in [sorted(r.methods)[0]] if hasattr(r, "methods")]
    seen = [p for _, p in paths]
    assert "/bench/decision/tasks" in seen
    i_reset = seen.index("/bench/decision/results")
    i_dyn = seen.index("/bench/{run_id}/results")
    assert i_reset < i_dyn, "decision literals must outrank the dynamic form"
    # DEC-bench generic: the picker literal joins the same band and must
    # outrank BOTH dynamic shapes it could collide with (full golden order
    # incl. this route is pinned in tests/test_nat3_scaffold.py)
    assert "/bench/decision/models" in seen
    i_models = seen.index("/bench/decision/models")
    assert i_models < seen.index("/bench/decision/{run_id}/cancel")
    assert i_models < seen.index("/bench/{run_id}/results")
    assert i_models < i_dyn


def test_decision_models_route_shape_and_auth():
    """GET /bench/decision/models returns EXACTLY the frozen contract keys
    (the static lane renders them verbatim: generic_available /
    generic_reason / native / generic). Admin-gating of every /bench route
    is already pinned by test_nat3_scaffold.test_stub_routes_require_admin,
    which walks this module's routes by path prefix."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from omlx_uplift import decision_engine as de_mod
    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base

    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    client = TestClient(app)
    payload = {"generic_available": True, "generic_reason": "",
               "native": ["dec-a"], "generic": ["chat-b"]}
    orig = de_mod.classify_models
    de_mod.classify_models = lambda: payload
    try:
        r = client.get("/uplift/api/bench/decision/models")
    finally:
        de_mod.classify_models = orig
    assert r.status_code == 200, r.text
    assert r.json() == payload


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
async def test_run_pack_persists_item_results(monkeypatch, tmp_path):
    """The per-item rows ride on the persisted result row (user 2026-10-13):
    accumulated.json is what the JSON download exports, so raw question
    results reach the export with no second store and no route change."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    run = de.DecisionRun("sys1-items", "fake-model", ["arc-choice"], limit=3)
    eng = FakeEngine()
    await de._run_pack(run, eng, "arc-choice", ValueError, KeyError)
    row = run.results[0]
    items = row["item_results"]
    gold_ids = [it["id"] for it in loader.load_pack("arc-choice")["items"][:3]]
    assert [i["id"] for i in items] == gold_ids
    for i in items:
        # exactly the score_item shape — NO per-item timing (the pack is
        # measured as one wall clock) and no extra keys
        assert set(i) == {"id", "correct", "chosen_text", "probs",
                          "agreement", "input_tokens"}
    assert row["items"] == len(items) == 3
    assert eng.calls == 3 * 2
    # latency fields agree with the row count: 3 probes in the main call
    # + 1 in the shuffled re-ask = 4 per item (user's 253.4-vs-298/294 bug)
    assert row["probes"] == 4 * row["items"] == 12
    # per-item divides by 3 rows, per-probe by 12 — same wall clock, so the
    # item figure is the larger one (exact ratio checked in
    # test_pack_scores_math; here time_s is sub-ms and its rounding dominates)
    assert row["ms_per_item"] >= row["ms_per_question"]
    assert row["ms_per_item"] is not None and row["probes"]
    # survives the JSON roundtrip through accumulated.json
    de._save_accum()
    monkeypatch.setattr(de, "_accum", None)
    back = de.results_payload()["results"][0]
    assert [i["id"] for i in back["item_results"]] == gold_ids
    assert back["item_results"][0]["input_tokens"] == 10
    # tuples are JSON arrays on the way out — the (p, y) pairs stay addressable
    assert list(back["item_results"][0]["probs"][0]) == [0.9, 1]
    assert back["probes"] == row["probes"] and back["ms_per_item"] is not None


@pytest.mark.asyncio
async def test_conflict_guard(monkeypatch):
    async def fake_start(body):
        return await de.start(body)
    active = de.DecisionRun("sys1-x", "m", ["arc-choice"], 0)
    active.terminal = False
    monkeypatch.setattr(de, "_active", active)
    with pytest.raises(de.Conflict):
        await de.start({"model_id": "m", "packs": ["arc-choice"]})


# ===================== generic path: /v1/decisions on any chat model ========
# Capability-gated: the installed keg predates upstream 981ebcc, so every
# test below stubs the THREE things decisions_capability() probes instead of
# needing a bumped base. The real letter-readout math (OptionLogitsCapture)
# is upstream's and is NOT re-implemented here — only its call shape.

class _Entry:
    def __init__(self, engine_type):
        self.engine_type = engine_type


class _FakePool:
    def __init__(self, entries):
        self._entries = entries


def _patch_pool(monkeypatch, entries):
    """Fake engine pool — same private _entries dict the real classifier
    reads (mirrors upstream server._is_decision_model)."""
    monkeypatch.setattr(de, "_pool", lambda: _FakePool(entries))


def _stub_base(monkeypatch, *, module=True, observer=True, lease=True):
    """Simulate a base that does/does not carry the /v1/decisions feature.
    module=False puts None in sys.modules, i.e. `import omlx.api.decisions`
    raises ImportError on ANY base (the installed keg's real state)."""
    import dataclasses
    import sys
    import types

    from omlx import request as omlx_request
    from omlx import server as omlx_server

    dec = types.ModuleType("omlx.api.decisions")
    dec.decide = None
    monkeypatch.setitem(sys.modules, "omlx.api.decisions", dec if module else None)
    new_sp = dataclasses.make_dataclass("SPNew", [("max_tokens", int, 8),
                                                  ("logits_observer", object, None)])
    old_sp = dataclasses.make_dataclass("SPOld", [("max_tokens", int, 8)])
    monkeypatch.setattr(omlx_request, "SamplingParams",
                        new_sp if observer else old_sp)
    if not lease:
        monkeypatch.delattr(omlx_server, "get_engine_for_model")


# ---- capability probe -------------------------------------------------------

def test_capability_probe_all_three_parts_present(monkeypatch):
    _stub_base(monkeypatch)
    assert de.decisions_capability() == (True, "")


def test_capability_probe_missing_module_is_honest(monkeypatch):
    """THE SHIPPED STATE on kegs older than 981ebcc: no decisions module."""
    _stub_base(monkeypatch, module=False)
    ok, reason = de.decisions_capability()
    assert ok is False and "omlx.api.decisions unavailable" in reason


def test_capability_probe_module_without_logits_observer(monkeypatch):
    """A module alone is NOT sufficient — without the SamplingParams hook
    every readout dies on 'does not expose next-token logits'."""
    _stub_base(monkeypatch, observer=False)
    ok, reason = de.decisions_capability()
    assert ok is False and "logits_observer" in reason


def test_capability_probe_missing_chat_lease(monkeypatch):
    _stub_base(monkeypatch, lease=False)
    ok, reason = de.decisions_capability()
    assert ok is False and "get_engine_for_model" in reason


def test_capability_probe_never_raises(monkeypatch):
    """Belt and braces: a mangled omlx must produce (False, reason)."""
    import sys
    monkeypatch.setitem(sys.modules, "omlx.request", None)
    ok, reason = de.decisions_capability()
    assert ok is False and reason


# ---- classification (the picker's source of truth) --------------------------

_POOL = {"zed-dec": _Entry("decision"),
         "alpha-dec": _Entry("decision"),
         "qwen-chat": _Entry("batched"),
         "vision-vlm": _Entry("vlm"),
         "embed-me": _Entry("embedding"),
         "rerank-me": _Entry("reranker"),
         "speak-me": _Entry("audio_tts"),
         "md-me": _Entry("markitdown")}


def test_classify_models_new_base(monkeypatch):
    _patch_pool(monkeypatch, dict(_POOL))
    _stub_base(monkeypatch)
    out = de.classify_models()
    assert set(out) == {"generic_available", "generic_reason",
                        "native", "generic"}        # frozen contract keys
    assert out["generic_available"] is True and out["generic_reason"] == ""
    assert out["native"] == ["alpha-dec", "zed-dec"]        # sorted
    assert out["generic"] == ["qwen-chat", "vision-vlm"]
    # embedding/reranker/audio/markitdown are in NEITHER group, ever
    for excluded in ("embed-me", "rerank-me", "speak-me", "md-me"):
        assert excluded not in out["native"] and excluded not in out["generic"]


def test_classify_models_old_base_keeps_native_and_explains(monkeypatch):
    _patch_pool(monkeypatch, dict(_POOL))
    _stub_base(monkeypatch, module=False)
    out = de.classify_models()
    assert out["generic_available"] is False
    assert out["generic_reason"]                       # non-empty: the UI note
    assert out["native"] == ["alpha-dec", "zed-dec"]   # native never gated
    assert out["generic"] == []


def test_classify_models_without_pool(monkeypatch):
    monkeypatch.setattr(de, "_pool", lambda: None)
    _stub_base(monkeypatch)
    out = de.classify_models()
    assert out == {"generic_available": True, "generic_reason": "",
                   "native": [], "generic": []}
    _stub_base(monkeypatch, module=False)
    gated = de.classify_models()
    assert gated["generic_available"] is False and gated["native"] == []


def test_classify_models_accepts_dict_entries(monkeypatch):
    """Pool entries are objects upstream; dicts are accepted so a fake (or a
    future serialised pool) classifies the same way."""
    _patch_pool(monkeypatch, {"a": {"engine_type": "decision"},
                              "b": {"engine_type": "batched"}})
    _stub_base(monkeypatch)
    out = de.classify_models()
    assert (out["native"], out["generic"]) == (["a"], ["b"])


# ---- resolve_path (the server-side gate) ------------------------------------

def test_resolve_path_native_generic_and_refusals(monkeypatch):
    _patch_pool(monkeypatch, dict(_POOL))
    _stub_base(monkeypatch)
    assert de.resolve_path("alpha-dec") == "native"
    assert de.resolve_path("qwen-chat") == "generic"
    assert de.resolve_path("vision-vlm") == "generic"
    with pytest.raises(de.NotFound):
        de.resolve_path("nope")
    with pytest.raises(de.BadInput, match="cannot be scored"):
        de.resolve_path("embed-me")


def test_resolve_path_gates_chat_model_on_capability(monkeypatch):
    _patch_pool(monkeypatch, dict(_POOL))
    _stub_base(monkeypatch, module=False)
    with pytest.raises(de.BadInput) as ei:
        de.resolve_path("qwen-chat")
    msg = str(ei.value)
    assert "/v1/decisions, which this server lacks:" in msg
    assert "omlx.api.decisions unavailable" in msg       # the reason verbatim
    # native stays startable on an old base
    assert de.resolve_path("alpha-dec") == "native"


def test_resolve_path_without_pool_is_native_passthrough(monkeypatch):
    """REPL-4c behaviour preserved: pool not up -> no error here, the lease
    produces the real one (and unit tests never need a pool)."""
    monkeypatch.setattr(de, "_pool", lambda: None)
    assert de.resolve_path("whatever") == "native"
    # a pool that answers but has no _entries is still 'not readable'
    monkeypatch.setattr(de, "_pool", lambda: object())
    assert de.resolve_path("whatever") == "native"


def test_resolve_path_empty_pool_is_not_found(monkeypatch):
    """A server that IS up with no such model must say NotFound — that is
    not the 'pool not up' case and must not fall through to a lease."""
    _patch_pool(monkeypatch, {})
    with pytest.raises(de.NotFound):
        de.resolve_path("whatever")


def test_check_decision_model_seam_stays_native_only(monkeypatch):
    """The legacy gate keeps its meaning (and its name) for callers that
    want /v1/systemone specifically."""
    _patch_pool(monkeypatch, dict(_POOL))
    _stub_base(monkeypatch)
    assert de._check_decision_model("alpha-dec") is None
    with pytest.raises(de.BadInput, match="not a decision model"):
        de._check_decision_model("qwen-chat")


# ---- generic request shaping ------------------------------------------------

def test_build_generic_request_shape():
    item = _sample_item()
    req = de.build_generic_request("mymodel", item, seed=0, shuffle=False)
    assert req["model"] == "mymodel" and req["input"] == item["state"]
    assert set(req) == {"model", "input", "questions"}      # no omlx-only keys
    qs = req["questions"]
    assert isinstance(qs, list) and [q["name"] for q in qs] == \
        ["answer", "gold", "distractor"]
    assert qs[0]["type"] == "choice"
    # choice VALUES are the option keys (sorted), DESCRIPTIONS the texts
    assert [c["value"] for c in qs[0]["choices"]] == ["a", "b", "c"]
    assert [c["description"] for c in qs[0]["choices"]] == \
        ["alpha", "beta", "gamma"]
    assert qs[1]["type"] == "predicate" and '"beta"' in qs[1]["instructions"]
    assert '"alpha"' in qs[2]["instructions"]
    assert len({q["name"] for q in qs}) == len(qs)          # schema: unique


def test_build_generic_request_shuffle_and_deterministic_distractor():
    item = _sample_item()
    plain = de.build_generic_request("m", item, seed=7, shuffle=False)
    shuf = de.build_generic_request("m", item, seed=7, shuffle=True)
    pk = [c["value"] for c in plain["questions"][0]["choices"]]
    sk = [c["value"] for c in shuf["questions"][0]["choices"]]
    assert sorted(pk) == sorted(sk) == ["a", "b", "c"]
    assert pk != sk                                   # order actually permuted
    # only the choice leg moves; gold/distractor legs quote TEXT, not keys
    assert (plain["questions"][1:] == shuf["questions"][1:])
    # distractor is the SAME choice as the native builder's (cross-path parity)
    nat = de.build_request("m", item, seed=7, shuffle=False)
    assert nat["questions"]["distractor"]["instructions"] == \
        plain["questions"][2]["instructions"]
    # deterministic across calls
    again = de.build_generic_request("m", item, seed=7, shuffle=True)
    assert again == shuf


def test_build_generic_request_two_option_item_still_three_legs():
    item = {"id": "t-2", "state": "s", "options": {"a": "one", "b": "two"},
            "answer": "a"}
    qs = de.build_generic_request("m", item, seed=0, shuffle=False)["questions"]
    # answer IS the first sorted key: the distractor is still 'b'
    assert [q["name"] for q in qs] == ["answer", "gold", "distractor"]
    assert '"one"' in qs[1]["instructions"] and '"two"' in qs[2]["instructions"]


def test_build_generic_request_matches_upstream_schema_when_present():
    """On a base that HAS decisions_models, the dict must validate as a real
    DecisionRequest (pydantic catches choice/name violations for us)."""
    pytest.importorskip("omlx.api.decisions_models")
    from omlx.api.decisions_models import DecisionRequest
    for name in PACKS:
        for item in loader.load_pack(name)["items"][:5]:
            req = de.build_generic_request("m", item, seed=1, shuffle=False)
            dr = DecisionRequest(**req)
            assert dr.questions[0].choices[0].value in item["options"]


# ---- answer-list adapter ----------------------------------------------------

def test_generic_adapter_parity_with_native():
    item = _sample_item()
    native = {"answers": {"answer": {"type": "choice", "choice": "b"},
                          "gold": {"type": "noul", "noul": 0.9},
                          "distractor": {"type": "noul", "noul": 0.1}},
              "usage": {"input_tokens": 42}}
    generic = {"answers": [
        {"type": "choice", "name": "answer", "choice": "b",
         "probabilities": [{"value": "a", "probability": 0.05},
                           {"value": "b", "probability": 0.9},
                           {"value": "c", "probability": 0.05}],
         "confidence": 0.8},
        {"type": "predicate", "name": "gold", "probability": 0.9},
        {"type": "predicate", "name": "distractor", "probability": 0.1}],
        "input_tokens": 300, "cached_tokens": 200}
    adapted = de.adapt_generic_answers(generic)
    assert set(adapted["answers"]) == set(native["answers"])
    row_n = de.score_item(item, native, None)
    row_g = de.score_item(item, adapted, None)
    # identical scoring rows except the token figure (sum over readouts)
    assert {k: v for k, v in row_g.items() if k != "input_tokens"} == \
        {k: v for k, v in row_n.items() if k != "input_tokens"}
    assert row_g["correct"] is True and row_g["chosen_text"] == "beta"
    assert row_g["probs"] == [(0.9, 1), (0.1, 0)]
    assert row_g["input_tokens"] == 300
    # answers arrive ordered by request questions; name is the join key
    assert de.adapt_generic_answers({"answers": list(reversed(
        generic["answers"]))})["answers"]["gold"]["noul"] == 0.9


def test_refusal_adapter_missing_choice_never_wrong():
    item = _sample_item()
    refused = {"answers": [{"type": "refusal", "name": "answer"},
                           {"type": "predicate", "name": "gold",
                            "probability": 0.6}]}
    row = de.score_item(item, de.adapt_generic_answers(refused), None)
    assert row["correct"] is None and row["chosen_text"] is None
    assert row["probs"] == [(0.6, 1)]      # the answered legs still score
    assert row["agreement"] is None


def test_adapter_ignores_unnamed_answers():
    out = de.adapt_generic_answers({"answers": [{"type": "predicate"},
                                                None,
                                                {"name": "x", "type": "y"}]})
    assert list(out["answers"]) == ["x"]


# ---- letter-token pre-probe -------------------------------------------------

class _LetterTokenizer:
    """Every letter gets its own id — what /v1/decisions needs."""

    def encode(self, text, add_special_tokens=False):
        t = text.strip()
        return [ord(t)] if len(t) == 1 and t.isalpha() else [1, 2]


class _CollidingTokenizer(_LetterTokenizer):
    def encode(self, text, add_special_tokens=False):
        return [7]           # every letter maps to the same token


class _MultiTokenTokenizer(_LetterTokenizer):
    def encode(self, text, add_special_tokens=False):
        return [3, 4]        # no single-token spelling at all


def test_probe_letter_tokens_accepts_a_real_tokenizer():
    assert de.probe_letter_tokens(_LetterTokenizer()) is None
    assert de._preprobe_letter_tokens(
        type("E", (), {"tokenizer": _LetterTokenizer()})()) is None


def test_probe_letter_tokens_reports_the_failure():
    assert de.probe_letter_tokens(_CollidingTokenizer())
    assert de.probe_letter_tokens(_MultiTokenTokenizer())


def test_preprobe_fails_the_run_before_any_pack():
    class Eng:
        tokenizer = _CollidingTokenizer()

    with pytest.raises(de.BadInput) as ei:
        de._preprobe_letter_tokens(Eng)
    msg = str(ei.value)
    assert msg.startswith("tokenizer lacks distinct single-letter tokens A-Z; "
                          "/v1/decisions cannot score this model")


def test_preprobe_without_tokenizer_is_a_noop():
    assert de._preprobe_letter_tokens(type("E", (), {})()) is None


@pytest.mark.asyncio
async def test_runner_preprobes_generic_run_before_pack_one(monkeypatch,
                                                            tmp_path):
    """The pre-probe sits in _runner, not in the item loop: the run must die
    before the first question, not after 200 of them."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    _install_fake_decisions_api(monkeypatch)
    monkeypatch.setattr(de, "_prepare_readout", lambda engine, mid=None: None)
    probed = []
    monkeypatch.setattr(de, "_preprobe_letter_tokens",
                        lambda eng: probed.append(eng))
    monkeypatch.setattr(de, "_lease_for",
                        lambda m, p: _cm(FakeChatEngine()))
    run = de.DecisionRun("sys1-pre", "chat", ["arc-choice"], 1,
                         path="generic")
    await de._runner(run)
    assert probed and run.status == "completed"

    def boom(engine):
        raise de.BadInput("tokenizer lacks distinct single-letter tokens A-Z")
    monkeypatch.setattr(de, "_preprobe_letter_tokens", boom)
    run2 = de.DecisionRun("sys1-pre2", "chat", ["arc-choice"], 1,
                          path="generic")
    await de._runner(run2)
    assert run2.status == "failed"
    assert "single-letter tokens" in run2.error_message
    assert run2.results == []          # never reached a pack
    # native runs must NOT pay the probe (no chat tokenizer involved)
    calls = []
    monkeypatch.setattr(de, "_preprobe_letter_tokens",
                        lambda eng: calls.append(eng))
    monkeypatch.setattr(de, "_lease_for", lambda m, p: _cm(FakeEngine()))
    run3 = de.DecisionRun("sys1-pre3", "dec", ["arc-choice"], 1)
    await de._runner(run3)
    assert calls == [] and run3.status == "completed"


def _cm(engine):
    class _C:
        async def __aenter__(self):
            return engine

        async def __aexit__(self, *a):
            return False
    return _C()


# ---- the generic runner loop, end to end on a fake chat engine -------------

class FakeChatEngine:
    """Stands in for a leased chat engine: chat() calls the logits observer
    the way batched/vlm engines forward it, and reports token counts."""

    def __init__(self):
        self.readouts = 0
        self.observed = 0
        self.seen_kwargs = []
        self.tokenizer = _LetterTokenizer()

    def count_chat_tokens(self, messages, tools=None, **kwargs):
        return 11

    async def chat(self, messages=None, **kwargs):
        self.readouts += 1
        self.seen_kwargs.append(kwargs)
        obs = kwargs.get("logits_observer")
        if obs is not None:
            self.observed += 1
        return type("Out", (), {"prompt_tokens": 10, "cached_tokens": 8})()


def _install_fake_decisions_api(monkeypatch, *, refuse=()):
    """sys.modules stubs for omlx.api.decisions(+_models): a mini decide()
    that answers EVERY question of the request it is handed, one engine.chat
    per readout — the upstream call shape, without the mlx logits math."""
    import sys
    import types

    async def decide(engine, request, multimodal, prepare=None):
        answers, tokens, cached = [], 0, 0
        for q in request["questions"]:
            extra = prepare([{"role": "user", "content": "readout"}]) \
                if prepare is not None else {}
            out = await engine.chat(
                messages=[{"role": "user", "content": q["name"]}],
                max_tokens=1, temperature=0.0,
                logits_observer=object(), **extra)
            tokens += out.prompt_tokens
            cached += out.cached_tokens
            if q["name"] in refuse:
                answers.append({"type": "refusal", "name": q["name"]})
            elif q["type"] == "choice":
                answers.append({"type": "choice", "name": q["name"],
                                "choice": q["choices"][0]["value"],
                                "probabilities": [
                                    {"value": c["value"], "probability": 0.5}
                                    for c in q["choices"]],
                                "confidence": 0.5})
            else:
                answers.append({"type": "predicate", "name": q["name"],
                                "probability": 0.9})
        return {"answers": answers, "input_tokens": tokens,
                "cached_tokens": cached}

    dec = types.ModuleType("omlx.api.decisions")
    dec.decide = decide
    dec.DecisionsRequestError = type("DecisionsRequestError", (ValueError,), {})
    dec.READOUT_TEMPLATE_KWARGS = {"enable_thinking": False}
    dec.letter_token_ids = lambda tok: [[ord(c)] for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
    models = types.ModuleType("omlx.api.decisions_models")

    class DecisionRequest(dict):
        pass

    models.DecisionRequest = DecisionRequest
    monkeypatch.setitem(sys.modules, "omlx.api.decisions", dec)
    monkeypatch.setitem(sys.modules, "omlx.api.decisions_models", models)
    return dec


@pytest.mark.asyncio
async def test_generic_run_pack_loop_scores_and_persists(monkeypatch, tmp_path):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    _install_fake_decisions_api(monkeypatch)
    # hermetic: the loop test pins the request/answer wiring, not the real
    # server prompt helpers (covered by test_prepare_readout_*)
    monkeypatch.setattr(de, "_prepare_readout", lambda engine, mid=None: None)
    eng = FakeChatEngine()
    run = de.DecisionRun("sys1-gen", "chat-model", ["arc-choice"], 2,
                         path="generic")
    await de._run_pack(run, eng, "arc-choice",
                       de.DecisionContextLengthError, de.DecisionRequestError)
    row = run.results[0]
    assert row["path"] == "generic" and row["engine"] == "decisions"
    assert row["items"] == 2 and row["skipped"] == 0
    # probe accounting is path-independent: 3 legs + 1 shuffled re-ask
    assert row["probes"] == 4 * row["items"] == 8
    # but the READOUT count is what the engine really did: every leg of
    # every call (6 per item) — generic is far more forward passes than
    # native's single batched call, which is why the two paths' token
    # figures must never be averaged together
    assert eng.readouts == 6 * row["items"] == 12
    assert eng.observed == eng.readouts     # every readout captured logits
    assert all(k["max_tokens"] == 1 for k in eng.seen_kwargs)
    for item_row in row["item_results"]:
        assert set(item_row) == {"id", "correct", "chosen_text", "probs",
                                 "agreement", "input_tokens"}
        # the fake always picks the FIRST option key, like the native fake
        assert item_row["input_tokens"] == 30      # 3 readouts x 10 tokens
        assert item_row["probs"] == [(0.9, 1), (0.9, 0)]
    de._save_accum()
    monkeypatch.setattr(de, "_accum", None)
    back = de.results_payload()["results"][0]
    assert back["path"] == "generic" and back["engine"] == "decisions"


@pytest.mark.asyncio
async def test_generic_run_pack_refusal_scores_none_and_survives(monkeypatch,
                                                                tmp_path):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    _install_fake_decisions_api(monkeypatch, refuse=("answer",))
    monkeypatch.setattr(de, "_prepare_readout", lambda engine, mid=None: None)
    run = de.DecisionRun("sys1-ref", "chat-model", ["arc-choice"], 2,
                         path="generic")
    await de._run_pack(run, FakeChatEngine(), "arc-choice",
                       de.DecisionContextLengthError, de.DecisionRequestError)
    row = run.results[0]
    assert all(i["correct"] is None for i in row["item_results"])
    assert row["accuracy"] is None       # nothing scored, honestly None
    assert row["agreement"] is None      # refusal on the re-ask too


def test_mixed_path_rows_coexist_in_the_store(monkeypatch, tmp_path):
    """No migration: native + generic + legacy (no path) rows side by side;
    the client falls back to path=row.path||'native'."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    native = {"pack": "arc-choice", "model_id": "dec", "kind": "decision",
              "engine": "systemone", "path": "native", "accuracy": 0.5}
    generic = dict(native, model_id="chat", engine="decisions",
                   path="generic", accuracy=0.4)
    legacy = {k: v for k, v in native.items() if k != "path"}
    de.get_accumulated().extend([native, generic, legacy])
    de._save_accum()
    monkeypatch.setattr(de, "_accum", None)
    rows = de.results_payload()["results"]
    assert [r["model_id"] for r in rows] == ["dec", "chat", "dec"]
    assert [r.get("path", "native") for r in rows] == \
        ["native", "generic", "native"]
    assert [r["engine"] for r in rows] == \
        ["systemone", "decisions", "systemone"]


@pytest.mark.asyncio
async def test_start_reports_path_and_run_carries_it(monkeypatch, tmp_path):
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    monkeypatch.setattr(de, "resolve_path", lambda m: de.PATH_GENERIC)
    monkeypatch.setattr(de, "_lease_for",
                        lambda m, p: _cm(FakeChatEngine()))
    _install_fake_decisions_api(monkeypatch)
    monkeypatch.setattr(de, "_prepare_readout", lambda engine, mid=None: None)
    out = await de.start({"model_id": "chat-model", "packs": ["arc-choice"],
                          "limit": 1})
    assert out["path"] == "generic"
    assert set(out) == {"run_id", "status", "model_id", "packs", "path"}
    assert de._active.path == "generic"
    await de._active.task
    assert de._active.status == "completed", de._active.error_message
    assert de._active.results[0]["engine"] == "decisions"
    monkeypatch.setattr(de, "_active", None)


def test_decision_run_defaults_to_native():
    """Every pre-existing constructor (and every legacy accumulated row) is
    a native run."""
    assert de.DecisionRun("r", "m", ["arc-choice"], 0).path == "native"


# ---- _decide_generic wiring + error translation -----------------------------

@pytest.mark.asyncio
async def test_decide_generic_normalizes_and_detects_multimodal(monkeypatch):
    rec = {}
    dec = _install_fake_decisions_api(monkeypatch)

    async def spy(engine, request, multimodal, prepare=None):
        rec["request"] = request
        rec["multimodal"] = multimodal
        rec["prepare"] = prepare
        return {"answers": [], "input_tokens": 1, "cached_tokens": 2}

    dec.decide = spy
    req = de.build_generic_request("chat", _sample_item(), seed=0,
                                   shuffle=False)
    out = await de._decide_generic(FakeChatEngine(), req)
    assert out == {"answers": [], "input_tokens": 1, "cached_tokens": 2}
    assert rec["multimodal"] is False
    assert rec["request"]["model"] == "chat"          # DecisionRequest got it
    assert [q["name"] for q in rec["request"]["questions"]] == \
        ["answer", "gold", "distractor"]
    # create_decisions' second half of the multimodal test
    vlm = type("VLMBatchedEngine", (), {})()
    assert de._generic_multimodal(vlm) is True
    fb = type("E", (), {"supports_multimodal_fallback": True})()
    assert de._generic_multimodal(fb) is True


@pytest.mark.asyncio
async def test_decide_generic_translates_context_and_request_errors(monkeypatch):
    import sys

    _install_fake_decisions_api(monkeypatch)
    dec = sys.modules["omlx.api.decisions"]

    class HTTP400(Exception):
        status_code = 400
        detail = ("Prompt too long: 9000 tokens exceeds max context window "
                  "of 4096 tokens")

    async def overflow(engine, request, multimodal, prepare=None):
        raise HTTP400("boom")
    dec.decide = overflow
    with pytest.raises(de.DecisionContextLengthError):
        await de._decide_generic(FakeChatEngine(),
                                 {"model": "m", "input": "x", "questions": []})

    async def template(engine, request, multimodal, prepare=None):
        raise dec.DecisionsRequestError("no letter tokens")
    dec.decide = template
    with pytest.raises(de.DecisionRequestError):
        await de._decide_generic(FakeChatEngine(),
                                 {"model": "m", "input": "x", "questions": []})

    async def other(engine, request, multimodal, prepare=None):
        raise RuntimeError("genuinely unexpected")
    dec.decide = other
    with pytest.raises(RuntimeError):
        await de._decide_generic(FakeChatEngine(),
                                 {"model": "m", "input": "x", "questions": []})


def test_prepare_readout_degrades_and_translates(monkeypatch):
    from omlx import server as omlx_server
    eng = FakeChatEngine()

    # helpers missing -> None -> decide()'s plain-engine.chat arm
    monkeypatch.setattr(omlx_server, "_prepare_chat_prompt_for_request", None)
    assert de._prepare_readout(eng, "m") is None

    monkeypatch.setattr(omlx_server, "_prepare_chat_prompt_for_request",
                        lambda e, msgs, **kw: (12, ("rendered", [1, 2])))

    class HTTP400(Exception):
        status_code = 400
        detail = "Prompt too long: 9000 tokens exceeds max context window"

    def overflow(n, model_id=None):
        raise HTTP400()
    monkeypatch.setattr(omlx_server, "validate_context_window", overflow)
    prepare = de._prepare_readout(eng, "m")
    with pytest.raises(de.DecisionContextLengthError):
        prepare([{"role": "user", "content": "x"}])

    monkeypatch.setattr(omlx_server, "validate_context_window",
                        lambda n, model_id=None: None)
    prepare = de._prepare_readout(eng, "m")
    assert prepare([{"role": "user", "content": "x"}]) == {
        "_prepared_prompt": ("rendered", [1, 2])}

    def unprepared(engine, msgs, **kw):
        return (5, None)
    monkeypatch.setattr(omlx_server, "_prepare_chat_prompt_for_request",
                        unprepared)
    assert de._prepare_readout(eng, "m")([{"role": "user", "content": "x"}]) \
        == {}

    def unrelated(engine, msgs, **kw):
        raise ValueError("chat template blew up")
    monkeypatch.setattr(omlx_server, "_prepare_chat_prompt_for_request",
                        unrelated)
    with pytest.raises(ValueError):
        de._prepare_readout(eng, "m")([{"role": "user", "content": "x"}])


@pytest.mark.asyncio
async def test_generic_item_context_overflow_skips_the_item(monkeypatch,
                                                           tmp_path):
    """One over-long fixture must not kill the pack (native parity: the
    DecisionContextLengthError arm of _run_pack counts a skip)."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    _install_fake_decisions_api(monkeypatch)
    monkeypatch.setattr(de, "_prepare_readout", lambda engine, mid=None: None)
    calls = {"n": 0}
    real = de._decide_generic

    async def flaky(engine, request):
        calls["n"] += 1
        if calls["n"] == 1:
            raise de.DecisionContextLengthError("too long")
        return await real(engine, request)
    monkeypatch.setattr(de, "_decide_generic", flaky)
    run = de.DecisionRun("sys1-skip", "chat", ["arc-choice"], 2,
                         path="generic")
    await de._run_pack(run, FakeChatEngine(), "arc-choice",
                       de.DecisionContextLengthError, de.DecisionRequestError)
    row = run.results[0]
    assert row["skipped"] == 1 and row["items"] == 1
    assert row["path"] == "generic"


# ============ generic path against UPSTREAM'S REAL decide() (not a stub) ====
# The installed keg predates 981ebcc, so the generic arm cannot run against a
# real chat model here. But the mirror checkout at ~/git/omlx-upstream DOES
# carry omlx/api/decisions.py, and every symbol that module imports exists in
# the installed package (mlx.core, numpy, omlx.models.decision.round4,
# omlx.models.openjev.*, pydantic) - only the two api/ files are missing. So
# load those two files into the live `omlx.api` package under their real
# names and run uplift's generic arm against the AUTHENTIC math:
# DecisionRequest validation, the readout rendering, OptionLogitsCapture, the
# letter renormalisation, the MIN_LETTER_MASS refusal gate and the
# answers-as-a-LIST shape. Only the engine stays fake: chat() hands the
# logits observer a fixed row instead of running weights.
# A skip here means 'not verified on this box' (no mirror, or omlx without
# the deps) - never 'verified false'. The stub-based tests above cover the
# same wiring on any CI.
import importlib.util
import os
import sys

MIRROR_API = os.path.expanduser("~/git/omlx-upstream/omlx/api")
MODULES = ("decisions_models", "decisions")


def _load_upstream_decisions():
    """The mirror's two api files, as members of the installed omlx.api
    package (that is what makes their relative imports resolve). None when
    this box cannot run them."""
    if not os.path.isdir(MIRROR_API):
        return None
    try:
        import mlx.core  # noqa: F401
        import numpy  # noqa: F401
        from omlx.models.decision import round4  # noqa: F401
        from omlx.models.openjev import compose_groups  # noqa: F401
    except Exception:
        return None
    loaded = {}
    for name in MODULES:
        path = os.path.join(MIRROR_API, name + ".py")
        if not os.path.exists(path):
            return None
        full = "omlx.api." + name
        mod = sys.modules.get(full)
        if mod is None or os.path.realpath(getattr(mod, "__file__", "")) \
                != os.path.realpath(path):
            spec = importlib.util.spec_from_file_location(full, path)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod
            try:
                spec.loader.exec_module(mod)
            except Exception:                        # upstream drifted again
                sys.modules.pop(spec.name, None)
                return None
        loaded[name] = mod
    return loaded


@pytest.fixture()
def upstream(monkeypatch):
    loaded = _load_upstream_decisions()
    if loaded is None:
        pytest.skip("upstream decisions.py not loadable here "
                    "(no ~/git/omlx-upstream mirror, or omlx lacks its deps)")
    monkeypatch.setitem(sys.modules, "omlx.api.decisions", loaded["decisions"])
    monkeypatch.setitem(sys.modules, "omlx.api.decisions_models",
                        loaded["decisions_models"])
    return loaded["decisions"]


# ---- the fake engine: one behaviour, honoured honestly ---------------------

LETTERS = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
# letter_token_ids() wants BOTH spellings of every option letter (bare and
# space-prefixed) as distinct single tokens, with no id shared between
# letters — that is exactly what this tokenizer provides
TOKEN_OF = {}
for _i, _L in enumerate(LETTERS):
    TOKEN_OF[_L] = 100 + _i
    TOKEN_OF[" " + _L] = 200 + _i
VOCAB = 300


class _RealTokenizer:
    def encode(self, text, add_special_tokens=False):
        tid = TOKEN_OF.get(text)
        return [tid] if tid is not None else [1, 2]


class RealReadoutEngine:
    """Chat-engine stand-in with the one behaviour decide() relies on: it
    runs the passed logits observer over a fixed next-token logit row and
    reports token counts.

    `pick_value` names an OPTION of whatever question is being rendered (an
    option value for a choice leg, 'Yes'/'No' for a predicate leg); the
    letter of that option gets the whole next-token mass. A flat row instead
    holds < MIN_LETTER_MASS (0.5) on the options, which upstream calls a
    refusal — so both honest outcomes are reproducible without weights.
    """

    def __init__(self, pick_value="b", refuse=False):
        self.tokenizer = _RealTokenizer()
        self.pick_value = pick_value
        self.refuse = refuse
        self.readouts = 0
        self.prepared = 0
        self.max_tokens_seen = set()

    def count_chat_tokens(self, messages, tools=None, **kwargs):
        return 13

    def _letter(self, messages):
        text = messages[0]["content"]
        for letter in LETTERS:
            if f"{letter}. {self.pick_value}" in text:
                return letter
        return "A"

    async def chat(self, messages=None, **kwargs):
        import mlx.core as mx
        self.readouts += 1
        self.max_tokens_seen.add(kwargs.get("max_tokens"))
        if kwargs.get("_prepared_prompt") is not None:
            self.prepared += 1
        observer = kwargs.get("logits_observer")
        logits = [0.0] * VOCAB
        if not self.refuse:
            letter = self._letter(messages)
            for text in (letter, " " + letter):
                logits[TOKEN_OF[text]] = 40.0
        if observer is not None:
            observer(mx.array([1]), mx.array([logits]))
        return type("Out", (), {"prompt_tokens": 7, "cached_tokens": 3})()


def _item():
    return {"id": "x-1", "state": "Which is correct?",
            "options": {"a": "alpha", "b": "beta", "c": "gamma"},
            "answer": "b"}


# ---- the authentic request schema ------------------------------------------

def test_upstream_decision_request_accepts_our_body(upstream):
    """build_generic_request's dict is a VALID DecisionRequest per the real
    pydantic models — not per our reading of them."""
    from omlx.api.decisions_models import ChoiceQuestion, DecisionRequest
    for req in (de.build_generic_request("chat", _item(), seed=0,
                                         shuffle=False),
                de.build_generic_request("chat", _item(), seed=0,
                                         shuffle=True)):
        dr = DecisionRequest(**req)
        assert dr.model == "chat" and dr.input == "Which is correct?"
        assert [q.name for q in dr.questions] == ["answer", "gold",
                                                  "distractor"]
        assert isinstance(dr.questions[0], ChoiceQuestion)
    assert [c.value for c in DecisionRequest(
        **de.build_generic_request("chat", _item(), seed=0,
                                   shuffle=False)).questions[0].choices] \
        == ["a", "b", "c"]
    # every real fixture item is a legal request too (option counts, names)
    for name in ("arc-choice", "bbq-choice", "tqa-choice"):
        for item in loader.load_pack(name)["items"][:20]:
            DecisionRequest(**de.build_generic_request("chat", item,
                                                       seed=0, shuffle=False))


# ---- the authentic readout -> adapter -> scorer chain ----------------------

@pytest.mark.asyncio
async def test_real_decide_answers_and_uplift_scores_it(upstream, monkeypatch):
    monkeypatch.setattr(de, "_prepare_readout", lambda e, m=None: None)
    req = de.build_generic_request("chat", _item(), seed=0, shuffle=False)
    eng = RealReadoutEngine(pick_value="c")        # wrong on purpose
    raw = await de._decide_generic(eng, req)
    assert set(raw) == {"answers", "input_tokens", "cached_tokens"}
    assert isinstance(raw["answers"], list) and len(raw["answers"]) == 3
    assert eng.readouts == 3                      # one forward pass per leg
    assert eng.max_tokens_seen == {1}             # the one-token readout
    # generic tokens are the SUM OVER READOUTS (3 x 7), not a call figure
    assert raw["input_tokens"] == 21
    assert raw["cached_tokens"] == 9
    by_name = {a["name"]: a for a in raw["answers"]}
    assert by_name["answer"]["type"] == "choice"
    assert by_name["answer"]["choice"] == "c"     # the peaked option's VALUE
    assert [p["value"] for p in by_name["answer"]["probabilities"]] == \
        ["a", "b", "c"]                           # request order preserved
    assert by_name["gold"]["type"] == "predicate"
    assert by_name["gold"]["probability"] > 0.9   # 'Yes' carried the mass
    row = de.score_item(_item(), de.adapt_generic_answers(raw), None)
    assert row["correct"] is False
    assert row["chosen_text"] == "gamma"          # TEXT, like the native path
    assert row["probs"][0][1] == 1 and row["probs"][1][1] == 0
    assert row["probs"][0][0] > 0.9 and row["input_tokens"] == 21


@pytest.mark.asyncio
async def test_real_decide_choice_agrees_with_gold(upstream, monkeypatch):
    monkeypatch.setattr(de, "_prepare_readout", lambda e, m=None: None)
    req = de.build_generic_request("chat", _item(), seed=0, shuffle=False)
    raw = await de._decide_generic(RealReadoutEngine(pick_value="b"), req)
    row = de.score_item(_item(), de.adapt_generic_answers(raw), None)
    assert row["correct"] is True and row["chosen_text"] == "beta"


@pytest.mark.asyncio
async def test_real_shuffle_re_ask_moves_the_letter_not_the_text(upstream,
                                                                 monkeypatch):
    """Agreement across the two calls is TEXT equality — the letter that
    carries the mass is per-readout, so a permuted option list must still
    resolve to the same option VALUE."""
    monkeypatch.setattr(de, "_prepare_readout", lambda e, m=None: None)
    item = _item()
    plain = await de._decide_generic(
        RealReadoutEngine(pick_value="b"),
        de.build_generic_request("chat", item, seed=7, shuffle=False))
    shuf = await de._decide_generic(
        RealReadoutEngine(pick_value="b"),
        de.build_generic_request("chat", item, seed=7, shuffle=True))
    pa = [a for a in plain["answers"] if a["name"] == "answer"][0]
    sa = [a for a in shuf["answers"] if a["name"] == "answer"][0]
    assert pa["choice"] == sa["choice"] == "b"
    row = de.score_item(item, de.adapt_generic_answers(plain),
                        de.adapt_generic_answers(shuf))
    assert row["agreement"] is True


@pytest.mark.asyncio
async def test_real_low_letter_mass_is_a_refusal_not_a_wrong_answer(upstream,
                                                                    monkeypatch):
    """MIN_LETTER_MASS (0.5) is upstream's call; our adapter must carry the
    resulting {'type':'refusal'} through as NO answer (correct None), never
    as a wrong pick — the accuracy denominator is the honest part."""
    monkeypatch.setattr(de, "_prepare_readout", lambda e, m=None: None)
    assert upstream.MIN_LETTER_MASS == 0.5
    req = de.build_generic_request("chat", _item(), seed=0, shuffle=False)
    raw = await de._decide_generic(RealReadoutEngine(refuse=True), req)
    assert [a["type"] for a in raw["answers"]] == ["refusal"] * 3
    row = de.score_item(_item(), de.adapt_generic_answers(raw), None)
    assert row["correct"] is None and row["chosen_text"] is None


@pytest.mark.asyncio
async def test_real_run_pack_persists_a_generic_row(upstream, monkeypatch,
                                                    tmp_path):
    """The whole loop on authentic math: pack items -> DecisionRequest ->
    decide() -> adapter -> score_item -> the persisted row."""
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)
    monkeypatch.setattr(de, "_prepare_readout", lambda e, m=None: None)
    eng = RealReadoutEngine(pick_value="a")       # first option, always
    run = de.DecisionRun("sys1-real", "chat-model", ["arc-choice"], 3,
                         path="generic")
    await de._run_pack(run, eng, "arc-choice",
                       de.DecisionContextLengthError, de.DecisionRequestError)
    row = run.results[0]
    assert row["path"] == "generic" and row["engine"] == "decisions"
    assert row["items"] == 3 and row["skipped"] == 0
    assert row["probes"] == 4 * 3                 # accounted legs (both paths)
    assert eng.readouts == 6 * 3                  # real forward passes
    first = loader.load_pack("arc-choice")["items"][0]
    got = row["item_results"][0]
    assert set(got) == {"id", "correct", "chosen_text", "probs", "agreement",
                        "input_tokens"}           # shape frozen by the brief
    assert got["chosen_text"] == first["options"]["a"]
    assert got["correct"] == (first["answer"] == "a")
    assert got["input_tokens"] == 21              # 3 readouts x 7 tokens
    assert row["accuracy"] is not None and row["brier"] is not None
    assert row["ece"] is not None
    assert any(i["agreement"] is not None for i in row["item_results"])
    de._save_accum()
    monkeypatch.setattr(de, "_accum", None)
    back = de.results_payload()["results"][0]
    assert back["engine"] == "decisions" and back["path"] == "generic"


@pytest.mark.asyncio
async def test_real_letter_token_preprobe_accepts_and_rejects(upstream):
    """The fail-fast pre-probe must agree with upstream's own function on a
    good AND a broken tokenizer (it prefers the real one when importable)."""
    from omlx.api.decisions import letter_token_ids
    eng = RealReadoutEngine()
    assert letter_token_ids(eng.tokenizer)        # upstream is happy
    de._preprobe_letter_tokens(eng)               # and so are we
    broken = RealReadoutEngine()
    broken.tokenizer = type("T", (), {"encode": lambda self, t, **k: [7]})()
    with pytest.raises(upstream.DecisionsRequestError):
        letter_token_ids(broken.tokenizer)        # upstream says no
    with pytest.raises(de.BadInput) as ei:
        de._preprobe_letter_tokens(broken)        # we say it earlier, as 400
    assert ("tokenizer lacks distinct single-letter tokens A-Z; "
            "/v1/decisions cannot score this model") in str(ei.value)
    # the standalone mirror agrees with upstream on both tokenizers
    assert de.probe_letter_tokens(eng.tokenizer) is None
    assert de.probe_letter_tokens(broken.tokenizer)


@pytest.mark.asyncio
async def test_real_prepare_readout_passes_the_prepared_prompt(upstream,
                                                                monkeypatch):
    """1b96f67's point: every readout reuses the rendered prefix. Drive the
    REAL server helper path (context gate stubbed — it reads live settings)
    and require chat() to actually receive _prepared_prompt."""
    from omlx import server as omlx_server
    monkeypatch.setattr(omlx_server, "validate_context_window",
                        lambda n, model_id=None: None)
    monkeypatch.setattr(omlx_server, "_prepare_chat_prompt_for_request",
                        lambda e, msgs, **kw: (13, ("rendered", [1, 2, 3])))
    req = de.build_generic_request("chat", _item(), seed=0, shuffle=False)
    eng = RealReadoutEngine(pick_value="b")
    await de._decide_generic(eng, req)
    assert eng.prepared == 3                      # every readout got it


@pytest.mark.asyncio
async def test_real_context_overflow_skips_the_item(upstream, monkeypatch,
                                                    tmp_path):
    """An over-long readout must skip ONE item (native's
    DecisionContextLengthError arm), not kill the pack: the HTTP route 400s
    here, and in-process we translate the same exception back."""
    from fastapi import HTTPException
    from omlx import server as omlx_server
    from omlx_uplift import paths
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    monkeypatch.setattr(de, "_accum", None)

    def too_long(n, model_id=None):
        raise HTTPException(status_code=400,
                            detail=f"Prompt too long: {n} tokens exceeds "
                                   "max context window of 128 tokens")
    monkeypatch.setattr(omlx_server, "validate_context_window", too_long)
    monkeypatch.setattr(omlx_server, "_prepare_chat_prompt_for_request",
                        lambda e, msgs, **kw: (9999, None))
    run = de.DecisionRun("sys1-ctx", "chat-model", ["arc-choice"], 2,
                         path="generic")
    await de._run_pack(run, RealReadoutEngine(), "arc-choice",
                       de.DecisionContextLengthError, de.DecisionRequestError)
    # every item skipped, the pack still reports honestly (items 0, skipped N
    # — the pre-existing native semantics for a fully-skipped pack)
    assert run.results[0]["items"] == 0
    assert run.results[0]["skipped"] == 2
    # and the translation is what _run_pack catches:
    with pytest.raises(de.DecisionContextLengthError):
        await de._decide_generic(RealReadoutEngine(),
                                 de.build_generic_request("chat", _item(),
                                                          seed=0,
                                                          shuffle=False))
