"""REPL-4c: native decision / System-1 bench over /v1/systemone.

Card 4c: no existing harness — the pack is in-house
(omlx_uplift/evals/systemone): pinned JSON fixtures + pure metrics, the
request format is bespoke (typed questions: choice / noul).

Why in-process instead of a subprocess venv (contrast with REPL-4a/4b):
the eval here IS a sequence of endpoint calls — /v1/systemone on the
native path, /v1/decisions on the generic one — nothing to delegate.
We call the EXACT public endpoint logic (server.create_systemone) through
upstream's real decision lease (`_LLMEngineLease` + `get_decision_engine`,
wrapped as an async CM in _lease) so:
  - the scored path is byte-for-byte what any API client hits (parity
    doctrine: bench measures the serving path, not a private seam),
  - the decision engine cannot be evicted mid-run (eviction-proof lease),
  - no second venv and no HTTP self-calls from inside the server.
Error contract mirrored from server.py: DecisionContextLengthError ->
per-item skip with reason, DecisionRequestError -> run fails (a fixture
the endpoint rejects is a bug in US, not noise to hide).

THREE SCORING PATHS (generic /v1/decisions extension; upstream 981ebcc +
1b96f67; forced mode FORCED-1 on 5833533), reported per run and per result
row as "path":
  "native"   decision models (pool engine_type == 'decision') scored
             through /v1/systemone exactly as above — untouched.
  "generic"  ANY chat model (engine_type 'batched' | 'vlm') scored by
             mirroring server.create_decisions' else-arm IN-PROCESS:
             _LLMEngineLease + get_engine_for_model (_lease_chat), then
             omlx.api.decisions.decide(engine, DecisionRequest, multimodal,
             prepare=_prepare_readout(engine)) — the same serving code the
             HTTP route runs, the same eviction-proof lease, still no HTTP
             self-call from inside the server.
             Capability-gated, never version-pinned: kegs older than
             981ebcc carry neither omlx/api/decisions.py nor the
             SamplingParams.logits_observer hook the letter readouts need,
             so decisions_capability() gates the path (classify_models
             reports it, resolve_path enforces it) and uplift ships ahead
             of keg bumps with the group empty-plus-reason.
  "forced"   FORCED-1: the SAME chat lease and decide() call, but with
             require_answer=False — the /v1/systemone CHAT semantics added
             by upstream 5833533 (#4552, "System One has no refusal
             answer"): every readout skips the letter-mass floor and
             reports a normalized distribution even for near-zero mass.
             Different MEASURAND, not a better gated run: accuracy is the
             quality of a forced guess, brier/ece include the confidence
             of models that abstain entirely when gated. Rows carry
             path:'forced' + engine:'systemone' and the UI marks them
             '(forced)'; never average forced with gated totals.
             forced_capability() probes decide()'s signature (the kwarg
             only exists at/after 5833533) — classify_models reports
             forced_available/forced_reason, start() refuses otherwise.
KNOWN deviations from the HTTP route, stated rather than papered over:
  - get_server_metrics().record_request_complete() is NOT called, so
    generic bench traffic is absent from the dashboard serving charts
    (mirroring _decisions_body for that is follow-up work).
  - _json_response_or_keepalive() is a transport concern; irrelevant
    in-process.
  - generic "input_tokens" is the SUM OVER READOUTS (one forward pass per
    question, decisions.py), so token counts are NOT comparable across
    paths and must never be averaged between them. Probe accounting stays
    name-based (len(questions)) so probes line up: 3 + 1 shuffled re-ask.

Scores per pack (metrics.py has the definitions):
  accuracy  — choice answer text == gold text
  brier/ece — DERIVED noul legs: gold option asserted true (y=1) + first
              distractor option asserted true (y=0). These are the
              probability questions the card calls out; they are derived
              at run time so the fixtures stay single-shape.
  agreement — same item re-asked with option keys permuted picks the
              same TEXT again (position-bias test; 1-agreement = bias)
  latency   — two bases, both reported (user 2026-10-13: a run showed
              ms/question 253.4 next to Time 298.0 / 294 items because
              the legacy field divides by PROBES, not by questions):
              ms_per_question is PER QUESTION-PROBE — each fixture item
              issues 3 probes in the main call (choice + gold noul +
              distractor noul) plus 1 more in the option-shuffled re-ask,
              i.e. 4 probes per item; ms_per_item is PER FIXTURE QUESTION.
              The legacy NAME stays for old accumulated rows; the UI
              labels ms_per_item 'ms/question' and ms_per_question
              'ms/probe'.
"""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from . import paths
from .evals.systemone import loader, metrics

logger = logging.getLogger("omlx.uplift.decision")

KIND = "decision"

# Eligibility split (design brief C). 'decision' is the native /v1/systemone
# path; these two are the generic /v1/decisions path (chat + VLM). Every
# other engine_type the pool can hold — embedding, reranker, audio_stt/
# audio_tts/audio_sts, markitdown, sts — can never answer typed questions and
# is NOT offered on either list (offering them re-creates the "load a 30B
# just to fail" problem the original type gate exists to prevent).
GENERIC_ENGINE_TYPES = ("batched", "vlm")
NATIVE_ENGINE_TYPE = "decision"
NEVER_SCORED_ENGINE_TYPES = ("embedding", "reranker", "markitdown", "sts")
PATH_NATIVE = "native"
PATH_GENERIC = "generic"
# FORCED-1: systemone chat semantics (require_answer=False, upstream
# 5833533). Shares the generic lease + decide() call; differs only in the
# letter-mass floor. 'mode' in the request body selects it: 'gated'
# (default, == today's generic path) | 'forced'.
PATH_FORCED = "forced"
MODE_GATED = "gated"
MODE_FORCED = "forced"

try:  # new omlx (>= b75060e): the real classes raised by the decode path
    from omlx.models.decision import (DecisionContextLengthError,  # noqa: F401
                                      DecisionRequestError)
except ImportError:  # CI / older kegs: local stand-ins (never raised there)
    class DecisionRequestError(ValueError):
        pass

    class DecisionContextLengthError(DecisionRequestError):
        pass
# items stream progress at pack granularity + this item stride (a 300-item
# pack with no mid-progress reads as a hang; per-item events would spam)
PROGRESS_STRIDE = 20


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


class BadInput(Exception):
    pass


class NotRunning(Exception):
    pass


def tasks_payload() -> dict:
    """Pack list for the UI grid (provenance from the pinned manifest)."""
    return {"tasks": {name: dict(meta, kind=KIND)
                      for name, meta in loader.packs_summary().items()}}


def validate_body(body: dict) -> tuple[str, list[str], int, str]:
    model_id = str(body.get("model_id") or "").strip()
    packs = body.get("packs") or []
    if not isinstance(packs, list) or not packs:
        raise BadInput("packs: non-empty list required")
    known = loader.packs_summary()
    for p in packs:
        if str(p) not in known:
            raise BadInput(f"unknown pack: {p}")
    limit = int(body.get("limit") or 0)
    if limit < 0 or limit > 10_000:
        raise BadInput("limit must be 0 (full pack) .. 10000")
    # FORCED-1: answer policy. 'gated' is the historical /v1/decisions
    # behaviour (refusals stay honest nulls) and the DEFAULT — every body
    # written before the mode existed must keep scoring exactly as before.
    mode = str(body.get("mode") or MODE_GATED)
    if mode not in (MODE_GATED, MODE_FORCED):
        raise BadInput(f"mode must be '{MODE_GATED}' or '{MODE_FORCED}'")
    # stable execution order: the UI sends packs in CLICK order, so two
    # runs of the same pack SET would otherwise interleave differently in
    # the results table / progress feed (user request, 2026-10-13)
    return model_id, sorted(str(p) for p in packs), limit, mode


# ---- request shaping (pure, tested) ----------------------------------------

def build_request(model_id: str, item: dict, *, seed: int,
                  shuffle: bool) -> dict:
    """One /v1/systemone body for one fixture item.

    'answer' is the choice leg (option keys; shuffled when asked); 'gold'
    and 'distractor' are the derived noul legs asserting an option text is
    THE correct answer. Distractor choice is deterministic (first option
    key below the gold in sorted order) so two runs stay comparable.
    """
    options = item["options"]
    keys = list(sorted(options))
    if shuffle:
        keys = keys[:]
        random.Random(seed).shuffle(keys)
    gold = options[item["answer"]]
    distr_keys = [k for k in sorted(options) if k != item["answer"]]
    distr = options[distr_keys[0]] if distr_keys else None
    questions: dict[str, Any] = {
        "answer": {"type": "choice",
                   "instructions": "Pick the single correct option.",
                   "criteria": {k: options[k] for k in keys}},
        "gold": {"type": "noul",
                 "instructions": 'Is this the correct answer: "' + gold + '"'},
    }
    if distr is not None:
        questions["distractor"] = {
            "type": "noul",
            "instructions": 'Is this the correct answer: "' + distr + '"'}
    return {"model": model_id, "state": item["state"],
            "questions": questions, "truncate": True}


def build_generic_request(model_id: str, item: dict, *, seed: int,
                          shuffle: bool) -> dict:
    """One /v1/decisions body (DecisionRequest shape) for one fixture item.

    Sibling of build_request for the generic path — a plain dict, no omlx
    import here (the module must stay importable on kegs without the
    feature). Question NAMES match the native legs ('answer' / 'gold' /
    'distractor') so the same score_item + the same probe accounting
    (3 legs + 1 shuffled re-ask) work on both paths.

    Native 'noul' legs become 'predicate' questions (probability that the
    quoted statement is true); the choice leg's criteria dict becomes an
    ordered choices list whose `value` is the OPTION KEY, so the answer's
    `choice` field is the same key the native path reports. Distractor
    choice is deterministic and identical to build_request (first sorted
    non-gold key) so two runs stay comparable.
    """
    options = item["options"]
    keys = list(sorted(options))
    if shuffle:
        keys = keys[:]
        random.Random(seed).shuffle(keys)
    gold = options[item["answer"]]
    distr_keys = [k for k in sorted(options) if k != item["answer"]]
    distr = options[distr_keys[0]] if distr_keys else None
    questions: list[dict] = [
        {"type": "choice", "name": "answer",
         "instructions": "Pick the single correct option.",
         "choices": [{"value": k, "description": options[k]} for k in keys]},
        {"type": "predicate", "name": "gold",
         "instructions": 'Is this the correct answer: "' + gold + '"'},
    ]
    if distr is not None:
        questions.append({
            "type": "predicate", "name": "distractor",
            "instructions": 'Is this the correct answer: "' + distr + '"'})
    return {"model": model_id, "input": item["state"],
            "questions": questions}


def _adapt_answer(answer: dict) -> dict:
    """One generic answer -> the native answer shape score_item reads.

    choice: `choice` already carries the option KEY (we send keys as the
    choice values), so it passes through untouched.
    predicate: the scorer reads `noul`, the endpoint reports `probability`.
    refusal: no letter mass at all — report NO choice (scored None, never
    False: the model did not answer, it did not answer wrong).
    """
    atype = answer.get("type")
    if atype == "predicate":
        return {"type": "noul", "noul": answer.get("probability")}
    if atype == "refusal":
        return {"type": "refusal", "name": answer.get("name"), "choice": None}
    return answer


def adapt_generic_answers(result: dict) -> dict:
    """decide()'s result -> the /v1/systemone response shape.

    decide() returns answers as a LIST ordered by the request's questions,
    each carrying its own `name` (decisions.py); score_item wants a DICT
    keyed by question name in the native shapes. Adapter only — the scoring
    math is shared by both paths, which is what keeps accuracy/brier/ece/
    agreement comparable. `input_tokens` is the SUM OVER READOUTS on this
    path (one pass per question) and is NOT comparable with the native
    single-call figure; never average the two.
    """
    answers = (result or {}).get("answers") or []
    by_name: dict[str, Any] = {}
    if isinstance(answers, dict):        # already native-shaped (defensive)
        by_name = {k: _adapt_answer(dict(v or {})) for k, v in answers.items()}
    else:
        for a in answers:
            if not isinstance(a, dict):
                continue
            name = a.get("name")
            if name is None:
                continue                 # unaddressable: treated missing
            by_name[str(name)] = _adapt_answer(a)
    return {"answers": by_name,
            "usage": {"input_tokens": (result or {}).get("input_tokens")},
            "cached_tokens": (result or {}).get("cached_tokens")}


def score_item(item: dict, res: dict, res_shuffle: Optional[dict]) -> dict:
    """Reduce two raw /v1/systemone responses to one item result row."""
    answers = res.get("answers") or {}
    out: dict[str, Any] = {"id": item["id"]}
    ca = answers.get("answer") or {}
    gold_text = (item["options"] or {}).get(item["answer"])
    chosen = ca.get("choice")
    out["correct"] = (chosen == item["answer"]
                      if chosen is not None else None)
    # text equality is the honest check: a permuted key set must agree on
    # TEXT, key indices carry no meaning across legs
    out["chosen_text"] = (item["options"] or {}).get(chosen) if chosen else None
    probs: list[tuple[float, int]] = []
    ng = answers.get("gold") or {}
    if isinstance(ng.get("noul"), (int, float)):
        probs.append((float(ng["noul"]), 1))
    nd = answers.get("distractor") or {}
    if isinstance(nd.get("noul"), (int, float)):
        probs.append((float(nd["noul"]), 0))
    out["probs"] = probs
    if res_shuffle:
        cs = (res_shuffle.get("answers") or {}).get("answer") or {}
        chosen_s = cs.get("choice")
        text_s = (item["options"] or {}).get(chosen_s) if chosen_s else None
        out["agreement"] = metrics.agreement_rate(out["chosen_text"], text_s)
    else:
        out["agreement"] = None
    out["input_tokens"] = (res.get("usage") or {}).get("input_tokens")
    return out


def pack_scores(rows: list[dict], elapsed_s: float, n_questions: int) -> dict:
    correct = sum(1 for r in rows if r.get("correct"))
    scored = sum(1 for r in rows if r.get("correct") is not None)
    probs = [p for r in rows for p in r.get("probs") or []]
    ags = [r["agreement"] for r in rows if r.get("agreement") is not None]
    return {
        "accuracy": metrics.accuracy(correct, scored),
        "brier": metrics.brier(probs),
        "ece": metrics.ece(probs),
        "agreement": metrics.accuracy(sum(1 for a in ags if a), len(ags)),
        "ms_per_question": (round(elapsed_s * 1000 / n_questions, 2)
                            if n_questions else None),
        # per FIXTURE QUESTION — the number the UI labels 'ms/question'.
        # The field above keeps its legacy per-PROBE basis (name and value)
        # so accumulated rows written before this change stay comparable
        # (user 2026-10-13: 253.4 'ms/question' vs 298.0s / 294 items).
        "ms_per_item": (round(elapsed_s * 1000 / len(rows), 2)
                        if rows else None),
        # what ms_per_question actually divided by: 3 probes per item in
        # the main call + 1 in the shuffled re-ask
        "probes": n_questions,
        # whole-pack wall time — the honest "time (performance)" figure the
        # results table/exports show next to the per-question latency
        "time_s": round(elapsed_s, 2),
        "items": len(rows),
    }


# ---- run object (same events/cond/terminal shape as embed_engine) ---------

class DecisionRun:
    def __init__(self, run_id: str, model_id: str,
                 packs: list[str], limit: int,
                 path: str = PATH_NATIVE):
        self.run_id = run_id
        self.model_id = model_id
        self.kind = KIND
        # 'native' (/v1/systemone heads) | 'generic' (/v1/decisions letter
        # readouts). Default native: every pre-existing constructor — and
        # every accumulated row written before the split — is a native run.
        self.path = path or PATH_NATIVE
        self.packs = packs
        self.limit = limit
        self.status = "running"          # running|completed|cancelled|failed
        self.phase = "starting"
        self.events: list[dict] = []
        self.results: list[dict] = []
        self.error_message: Optional[str] = None
        self.terminal = False
        self.cond = asyncio.Condition()
        self.task: Optional[asyncio.Task] = None
        self.cancelled = False
        self.started_at = time.time()

    async def send(self, ev: dict) -> None:
        async with self.cond:
            self.events.append(ev)
            self.cond.notify_all()


_active: Optional[DecisionRun] = None


def active_run() -> Optional[DecisionRun]:
    return _active if (_active and not _active.terminal) else None


def get(run_id: str) -> Optional[DecisionRun]:
    return _active if (_active and _active.run_id == run_id) else None


async def start(body: dict) -> dict:
    global _active
    if active_run() is not None:
        raise Conflict("a decision benchmark is already running")
    model_id, packs, limit, mode = validate_body(body)
    # type gate BEFORE leasing: pointing the bench at a model that cannot
    # answer typed questions would load a 30B just to fail — ask the pool
    # what this id is first, and pick the scoring path from the answer.
    path = resolve_path(model_id)
    if mode == MODE_FORCED:
        # forced is the /v1/systemone CHAT semantics (5833533): defined
        # only where decide() runs — decision models never refuse, and
        # the native engine has no require_answer to flip.
        if path != PATH_GENERIC:
            raise BadInput(f"mode 'forced' scores chat models through "
                           f"decide(require_answer=False); {model_id} is "
                           f"scored on the native path and never refuses")
        fok, freason = forced_capability()
        if not fok:
            raise BadInput(f"{model_id}: this server cannot force an "
                           f"answer (/v1/systemone chat support missing): "
                           f"{freason}")
        path = PATH_FORCED
    run = DecisionRun(f"sys1-{uuid.uuid4().hex[:12]}", model_id, packs, limit,
                      path=path)
    _active = run
    # U66: the house INFO-at-start / INFO-at-finish pair the classic bench
    # modules all have — a decision run was invisible in server.log even at
    # TRACE (user report), which reads as 'nothing happened'
    logger.info(f"uplift native decision bench started: {run.run_id} "
                f"model={model_id} path={path} packs={packs} "
                f"limit={limit or 'full'}")
    run.task = asyncio.create_task(_runner(run))
    return {"run_id": run.run_id, "status": "running",
            "model_id": model_id, "packs": packs, "path": path}


# ---- eligibility + capability (the picker's single source of truth) ---------

def decisions_capability() -> tuple[bool, str]:
    """Single honest gate for the generic /v1/decisions path. Uplift ships
    ahead of keg bumps, so probe the three things the feature needs — never
    a version string:
      1. omlx.api.decisions        (the route module; 981ebcc)
      2. SamplingParams.logits_observer (the engine hook 981ebcc added —
         without it every readout dies on 'does not expose next-token
         logits', so the module alone is NOT sufficient)
      3. server.get_engine_for_model (the chat lease used by the else-arm)
    Never raises: any import/attribute failure is a (False, reason) answer.
    """
    try:
        from dataclasses import fields

        import omlx.api.decisions  # noqa: F401  (absent on kegs < 981ebcc)
        from omlx import server as _srv
        from omlx.request import SamplingParams
    except Exception as e:
        return False, (f"omlx.api.decisions unavailable "
                       f"({type(e).__name__}: {e})")
    try:
        names = {f.name for f in fields(SamplingParams)}
    except TypeError:                 # not a dataclass any more: be literal
        names = {n for n in ("logits_observer",) if hasattr(SamplingParams, n)}
    if "logits_observer" not in names:
        return False, ("engine has no logits_observer hook "
                       "(needs upstream 981ebcc)")
    if not callable(getattr(_srv, "get_engine_for_model", None)):
        return False, "server.get_engine_for_model missing"
    return True, ""


def forced_capability() -> tuple[bool, str]:
    """ADDITIVE gate for the forced-choice (System One chat) mode, on top
    of decisions_capability(): decide() must accept require_answer — the
    kwarg upstream 5833533 added when /v1/systemone learned to answer with
    chat models. Signature probe, never a version string; never raises
    (a stubbed/None decide() answers honestly False with the reason)."""
    try:
        import inspect

        from omlx.api.decisions import decide
        params = inspect.signature(decide).parameters
    except Exception as e:
        return False, (f"decide() has no readable require_answer signature "
                       f"({type(e).__name__}: {e})")
    if "require_answer" not in params:
        return False, ("decide() lacks require_answer "
                       "(needs upstream 5833533)")
    return True, ""


def _pool() -> Optional[Any]:
    """The live engine pool, or None when the server is not initialised
    (tests, pre-boot). The private _entries access mirrors upstream's own
    _is_decision_model (server.py) — one read point for both classifiers."""
    try:
        from omlx import server as _srv
        return _srv.get_engine_pool()
    except Exception:
        return None


def _pool_entries(pool=None) -> Optional[dict]:
    """{model_id -> pool entry}, or None when the pool is not readable
    (server not up / _entries renamed). Entries may be objects (upstream) or
    plain dicts (test fakes)."""
    pool = _pool() if pool is None else pool
    if pool is None:
        return None
    entries = getattr(pool, "_entries", None)
    return entries if isinstance(entries, dict) else None


def _entry_engine_type(entry) -> Optional[str]:
    if entry is None:
        return None
    if isinstance(entry, dict):
        return entry.get("engine_type")
    return getattr(entry, "engine_type", None)


def classify_models() -> dict:
    """Picker payload, FROZEN with the static lane (do not rename keys):
    {"generic_available": bool, "generic_reason": str (empty when
    available), "forced_available": bool, "forced_reason": str (FORCED-1,
    additive), "native": [ids], "generic": [ids]} — both lists sorted.

    Server-side classification so the UI stops guessing engine_type from
    /models rows. Pool unavailable -> empty lists (the capability answer
    still stands: it does not need the pool). embedding / reranker /
    audio_* / markitdown rows are in NEITHER group.
    """
    ok, reason = decisions_capability()
    out: dict[str, Any] = {"generic_available": ok, "generic_reason": reason,
                           "native": [], "generic": []}
    # FORCED-1: additive answer-policy axis. Forced rides on the generic
    # lease, so when generic is unavailable the forced answer IS generic's
    # reason (one honest chain, no second mystery failure).
    if ok:
        fok, freason = forced_capability()
    else:
        fok, freason = False, reason
    out["forced_available"] = fok
    out["forced_reason"] = freason
    for mid, entry in (_pool_entries() or {}).items():
        et = _entry_engine_type(entry)
        if et in NEVER_SCORED_ENGINE_TYPES or str(et or "").startswith("audio_"):
            continue      # never offered on either list, gated or not
        if et == NATIVE_ENGINE_TYPE:
            out["native"].append(mid)
        elif ok and et in GENERIC_ENGINE_TYPES:
            out["generic"].append(mid)
    out["native"].sort()
    out["generic"].sort()
    return out


def resolve_path(model_id: str) -> str:
    """'native' | 'generic' for this model — raises NotFound / BadInput
    exactly like the old boolean gate, plus the capability refusal.

    Pool not up -> 'native' (REPL-4c's original behaviour: the lease below
    produces the real error, and unit tests never need a pool). A pool that
    IS up but holds no entry for the id is a NotFound, never a passthrough.
    """
    entries = _pool_entries()
    if entries is None:
        return PATH_NATIVE
    entry = entries.get(model_id)
    if entry is None:
        raise NotFound(f"model not found: {model_id}")
    et = _entry_engine_type(entry)
    if et == NATIVE_ENGINE_TYPE:
        return PATH_NATIVE
    if et in GENERIC_ENGINE_TYPES:
        ok, reason = decisions_capability()
        if not ok:
            raise BadInput(f"{model_id} is a chat model; scoring it needs "
                           f"/v1/decisions, which this server lacks: {reason}")
        return PATH_GENERIC
    raise BadInput(f"{model_id} (engine_type={et}) cannot be scored by the "
                   "decision bench (only decision models via /v1/systemone "
                   "and chat models via /v1/decisions)")


def _check_decision_model(model_id: str) -> None:
    """Legacy native-only seam (REPL-4c), kept alive: start() now routes
    through resolve_path, this asserts the /v1/systemone path specifically
    (and is the monkeypatch target of the U66 logging tests)."""
    path = resolve_path(model_id)
    if path != PATH_NATIVE:
        raise BadInput(f"{model_id} is not a decision model "
                       "(this bench scores /v1/systemone models)")


def _lease(model_id: str):
    """The upstream lease seam, isolated for testing: returns an async CM
    yielding a leased DecisionEngine. Local stand-in classes above mean
    _runner itself never imports omlx.

    There is NO `acquire_decision_engine` upstream — REPL-4c guessed the
    name after acquire_embedding_engine/acquire_reranker_engine and the
    mocked seam hid the AttributeError until a live bench run. The real
    create_systemone lease shape is object-based:
        lease = _LLMEngineLease()
        engine = await get_decision_engine(model_id, lease)
        ...
        finally: await lease.release()   # idempotent
    Wrapped as an async CM here so the pinned enter/exit protocol in
    _runner keeps working: when get_decision_engine raises, __aenter__
    raises before any yield, the finally releases a never-taken lease
    (model_id None -> no-op) and _runner correctly skips __aexit__.
    """
    from contextlib import asynccontextmanager
    from omlx import server as _srv

    acquire = getattr(_srv, "acquire_decision_engine", None)
    if callable(acquire):   # prefer a symmetric helper if upstream ever adds one
        return acquire(model_id)

    @asynccontextmanager
    async def _cm():
        lease = _srv._LLMEngineLease()
        try:
            yield await _srv.get_decision_engine(model_id, lease)
        finally:
            await lease.release()

    return _cm()


def _lease_chat(model_id: str):
    """Async CM yielding a leased CHAT engine — the create_decisions
    else-arm's lease (tip server.py: `lease = _LLMEngineLease()` /
    `engine = await get_engine_for_model(request.model, lease=lease)` /
    `finally: await lease.release()`), same enter/exit discipline as _lease.

    Note the keyword: get_engine_for_model takes `lease=` (positional is
    `model`). When the acquisition raises, __aenter__ raises BEFORE any
    yield, the finally releases the never-taken lease (model_id None ->
    no-op upstream) and _runner correctly skips __aexit__ — the exact
    protocol the lease-protocol tests pin for both seams.
    """
    from contextlib import asynccontextmanager
    from omlx import server as _srv

    @asynccontextmanager
    async def _cm():
        lease = _srv._LLMEngineLease()
        try:
            yield await _srv.get_engine_for_model(model_id, lease=lease)
        finally:
            await lease.release()

    return _cm()


def _lease_for(model_id: str, path: str):
    """The seam _runner actually calls, so path selection is one line and
    testable: native -> the decision engine, generic/forced -> the chat
    engine (forced reuses the SAME lease; only decide()'s floor differs)."""
    return (_lease_chat(model_id) if path in (PATH_GENERIC, PATH_FORCED)
            else _lease(model_id))


async def _runner(run: DecisionRun) -> None:
    cm = None
    entered = False
    engine = None
    _t0 = time.perf_counter()
    path = getattr(run, "path", None) or PATH_NATIVE
    try:
        cm = _lease_for(run.model_id, path)
        engine = await cm.__aenter__()
        entered = True
        if path in (PATH_GENERIC, PATH_FORCED):
            # fail FAST: decide() computes the A-Z letter token ids up front
            # and raises for every question if the tokenizer cannot spell them
            # (decisions.py letter_token_ids). Discovering that after 200 items
            # — or after pack 1 of 3 — is a wasted GPU hour. Forced mode reads
            # the SAME letters with the floor removed, so it needs the probe
            # just as much as gated.
            _preprobe_letter_tokens(engine)
        n = len(run.packs)
        for i, pack_name in enumerate(run.packs):
            if run.cancelled:
                break
            await run.send({"type": "progress", "phase": "pack",
                            "task": pack_name, "current": i, "total": n,
                            "message": f"{pack_name} ({i + 1}/{n})"})
            await _run_pack(run, engine, pack_name,
                            DecisionContextLengthError, DecisionRequestError)
        if run.cancelled:
            run.status = "cancelled"
            run.error_message = "Benchmark cancelled by user"
            logger.info(f"uplift native decision bench cancelled: "
                        f"{run.run_id} after {len(run.results)} pack(s)")
            await run.send({"type": "error", "message": run.error_message})
        else:
            run.status = "completed"
            run.phase = "completed"
            logger.info(f"uplift native decision bench completed: "
                        f"{run.run_id} model={run.model_id} path={path} "
                        f"packs={len(run.results)} in "
                        f"{time.perf_counter() - _t0:.1f}s")
            await run.send({"type": "done", "summary": {
                "model_id": run.model_id, "kind": run.kind,
                "packs": len(run.results)}})
    except asyncio.CancelledError:
        # task.cancel() from the cancel route raises BaseException.CancelledError
        # — `except Exception` MISSES it (embed_engine pins this too; without
        # this handler the run stayed status='running', no terminal event was
        # ever sent, and the UI kept the run locked — caught in the live
        # cancel drill).
        run.status = "cancelled"
        run.error_message = "Benchmark cancelled by user"
        await run.send({"type": "error", "message": run.error_message})
    except Exception as e:
        # (DecisionRequestError/ContextLength are already handled per-item
        # in _run_pack — anything reaching here is a real run failure)
        run.status = "failed"
        run.error_message = str(e)
        logger.warning(f"decision run {run.run_id} failed: {e}")
        await run.send({"type": "error", "message": run.error_message})
    finally:
        if entered and cm is not None:
            # ONLY release after a successful enter: __aexit__ on a never-
            # entered _AsyncGeneratorContextManager resumes the generator
            # (loads the engine!), then raises 'generator didn't stop' and
            # LEAKS the lease — caught by the live drill via that exact
            # stray log line.
            try:
                await cm.__aexit__(None, None, None)
            except Exception as e:
                logger.warning(f"decision release failed: {e}")
        run.terminal = True
        async with run.cond:
            run.cond.notify_all()


async def _run_pack(run: DecisionRun, engine, pack_name: str,
                    ctx_err, req_err) -> None:
    path = getattr(run, "path", None) or PATH_NATIVE
    generic = path in (PATH_GENERIC, PATH_FORCED)
    # FORCED-1: the ONLY scoring difference is the letter-mass floor flag;
    # request shapes, legs, adapters and the probe accounting are shared so
    # forced vs gated stay comparable WITHIN the chat-model axis (and the
    # row labels keep them apart in the accumulated table).
    require_answer = path != PATH_FORCED
    pack = loader.load_pack(pack_name)
    items = pack["items"]
    if run.limit:
        items = items[:run.limit]
    rows: list[dict] = []
    skipped = 0
    t0 = time.perf_counter()
    n_q = 0
    for j, item in enumerate(items):
        if run.cancelled:
            break
        # first item moves the bar immediately (short runs used to sit at
        # 0% then jump — 20-item stride was the only event source); then
        # every PROGRESS_STRIDE to keep SSE traffic flat on full packs
        if j == 1 or (j and j % PROGRESS_STRIDE == 0):
            await run.send({"type": "progress", "phase": "items",
                            "task": pack_name, "current": j,
                            "total": len(items),
                            "message": f"{pack_name}: {j}/{len(items)}"})
        # U66: TRACE heartbeat — level 5 is omlx's trace (logging_config
        # maps TRACE to 5; no logger.trace method exists, discovery.py uses
        # the same logger.log(5, ...) call shape)
        logger.log(5, "decision %s %s item %d/%d", run.run_id,
                   pack_name, j + 1, len(items))
        build = build_generic_request if generic else build_request
        if generic:
            # partial binds the CURRENT module global -> monkeypatched fakes
            # (tests) and future reassignment both take effect at call time
            call = functools.partial(_decide_generic,
                                     require_answer=require_answer)
        else:
            call = _decide
        req = build(run.model_id, item, seed=j, shuffle=False)
        try:
            res = await call(engine, req)
        except ctx_err:
            skipped += 1     # state too long even truncated: honest skip
            continue
        except req_err as e:
            raise BadInput(f"{pack_name} item {item['id']}: {e}") from e
        # probe accounting is NAME-based and identical on both paths
        # (3 legs + 1 shuffled re-ask), which is what makes ms/probe
        # comparable. Token counts are NOT: generic input_tokens is the
        # SUM OVER READOUTS (one forward pass per question), native is one
        # batched call — never average the two across paths.
        n_q += len(req["questions"])
        res_s = None
        try:
            res_s = await call(engine, build(
                run.model_id, item, seed=j, shuffle=True))
            n_q += 1
        except (ctx_err, req_err):
            pass             # re-ask is optional; agreement stays None
        if generic:
            # adapter only — score_item's math is shared, so accuracy /
            # brier / ece / agreement stay cross-path comparable
            res = adapt_generic_answers(res)
            res_s = adapt_generic_answers(res_s) if res_s else None
        rows.append(score_item(item, res, res_s))
    elapsed = time.perf_counter() - t0
    if run.cancelled:
        return             # embed_engine._run_one parity: a cancelled pack
                           # is NOT scored/persisted (partial rows would
                           # silently pollute the accumulated table)
    row = {"pack": pack_name, "model_id": run.model_id, "kind": run.kind,
           # 'path' is the picker truth ('native' | 'generic'); 'engine'
           # stays and mirrors the endpoint that scored the row
           # ('systemone' | 'decisions') — legacy readers use it, and rows
           # written before the split have neither and default to native.
           "path": path,
           # FORCED-1: forced rows were scored by the /v1/systemone chat
           # branch (decide with the floor off) -> engine says so honestly;
           # gated generic rows keep 'decisions', native keeps 'systemone'
           "engine": ("systemone" if path == PATH_FORCED
                      else "decisions" if generic else "systemone"),
           "skipped": skipped,
           "ts": int(time.time()),
           # per-item raw rows ride on the result row: it is persisted to
           # accumulated.json verbatim, so the existing JSON download exports
           # the question-level detail (chosen text, probs, agreement) with
           # no second store and no download-route change (user 2026-10-13).
           # NO per-item timing here — the pack call is one wall clock.
           "item_results": rows,
           **pack_scores(rows, elapsed, n_q)}
    row = _finite(row)
    run.results.append(row)
    get_accumulated().append(row)
    _save_accum()   # write-through: a crash keeps finished packs
    logger.info(f"decision {run.run_id} pack {pack_name} "
                f"({row['path']}/{row['engine']}): "
                f"{len(rows)} scored, {skipped} skipped, {elapsed:.1f}s")
    await run.send({"type": "result", "data": row})


async def _decide(engine, request: dict) -> dict:
    """The create_systemone logic in-process: encode -> systemone."""
    plan = await engine.encode(request, truncate=request.get("truncate", True))
    return await engine.systemone(plan)


# ---- generic path: /v1/decisions on a chat model (capability-gated) ---------

_LETTERS = [chr(code) for code in range(ord("A"), ord("Z") + 1)]


def probe_letter_tokens(tokenizer) -> Optional[str]:
    """None when this tokenizer can spell every option letter, else the
    reason it cannot.

    Mirror of upstream decisions.letter_token_ids' precondition, kept HERE so
    the fail-fast check exists on kegs that do not have the module at all
    (identical walk: bare + space-prefixed single-token spellings, and no
    letter may reuse another letter's id — a collision makes the readout
    unattributable). _preprobe_letter_tokens prefers the real upstream
    function when it is importable.
    """
    seen: set[int] = set()
    for letter in _LETTERS:
        ids: list[int] = []
        for text in (letter, " " + letter):
            try:
                encoded = tokenizer.encode(text, add_special_tokens=False)
            except TypeError:                 # tokenizers without the kwarg
                encoded = tokenizer.encode(text)
            except Exception as e:
                return f"tokenizer.encode({text!r}) raised {e!r}"
            if len(encoded) == 1 and int(encoded[0]) not in ids:
                ids.append(int(encoded[0]))
        if not ids or seen.intersection(ids):
            return f"no distinct single token for the option letter {letter!r}"
        seen.update(ids)
    return None


def _preprobe_letter_tokens(engine) -> None:
    """Fail the RUN (BadInput) before pack 1 when the tokenizer cannot carry
    the letter readouts — upstream raises the same way per question, which
    would burn the whole lease before telling us."""
    tokenizer = getattr(engine, "tokenizer", None)
    if tokenizer is None:
        return        # nothing to check without a tokenizer (decide() will
                      # produce the engine's own honest error)
    reason = None
    try:                                    # prefer the real thing (parity)
        from omlx.api.decisions import letter_token_ids
    except Exception:
        reason = probe_letter_tokens(tokenizer)
    else:
        try:
            letter_token_ids(tokenizer)
        except Exception as e:
            reason = str(e) or type(e).__name__
    if reason:
        raise BadInput("tokenizer lacks distinct single-letter tokens A-Z; "
                       "/v1/decisions cannot score this model"
                       f" ({reason})")


def _looks_like_context_error(exc) -> bool:
    """Overflow in any spelling the serving stack uses (the generic path
    reaches it as an HTTPException raised in-process, not as a response)."""
    text = str(getattr(exc, "detail", None) or exc).lower()
    status = getattr(exc, "status_code", None)
    markers = ("context_length_exceeded", "prompt too long",
               "maximum context length", "context window", "too many tokens")
    return bool(status in (400, 413)
                and any(m in text for m in markers))


def _generic_multimodal(engine) -> bool:
    """create_decisions' test, with the import guarded: `isinstance(engine,
    VLMBatchedEngine) or getattr(engine, 'supports_multimodal_fallback',
    False)`. Class-name fallback keeps it honest if the import path moves."""
    try:
        from omlx.engine import VLMBatchedEngine
    except Exception:
        VLMBatchedEngine = None
    if VLMBatchedEngine is not None and isinstance(engine, VLMBatchedEngine):
        return True
    if type(engine).__name__ == "VLMBatchedEngine":
        return True
    return bool(getattr(engine, "supports_multimodal_fallback", False))


def _prepare_readout(engine, model_id: Optional[str] = None):
    """prepare(messages) -> extra engine.chat kwargs, mirroring tip
    create_decisions' inner _prepare_readout: render the readout prompt
    through the real chat-prompt path, validate the context window, and hand
    the already-prepared prompt to chat() so the prefix cache is reused.

    Returns None (decide()'s degraded arm: plain engine.chat) when the
    helpers are missing, and raises our DecisionContextLengthError on
    overflow so _run_pack skips the ITEM instead of failing the run — the
    same handling the native path gives DecisionContextLengthError.
    """
    from omlx import server as _srv

    prep = getattr(_srv, "_prepare_chat_prompt_for_request", None)
    validate = getattr(_srv, "validate_context_window", None)
    if not (callable(prep) and callable(validate)):
        return None
    try:
        from omlx.api.decisions import READOUT_TEMPLATE_KWARGS
    except Exception:
        READOUT_TEMPLATE_KWARGS = {"enable_thinking": False}

    def _prepare(messages):
        try:
            num_prompt_tokens, prepared = prep(
                engine, messages,
                chat_template_kwargs=dict(READOUT_TEMPLATE_KWARGS),
                is_partial=True)
        except Exception as e:
            if _looks_like_context_error(e):
                raise DecisionContextLengthError(str(
                    getattr(e, "detail", None) or e)) from e
            raise
        try:
            validate(num_prompt_tokens, model_id)
        except Exception as e:
            if _looks_like_context_error(e):
                raise DecisionContextLengthError(str(
                    getattr(e, "detail", None) or e)) from e
            raise
        return {} if prepared is None else {"_prepared_prompt": prepared}

    return _prepare


async def _decide_generic(engine, request: dict,
                          require_answer: bool = True) -> dict:
    """The create_decisions else-arm in-process (mirror of _decide for the
    native path): DecisionRequest -> decide() -> {answers, input_tokens,
    cached_tokens}. Answers come back as a LIST ordered by the request's
    questions; adapt_generic_answers maps them onto score_item's shape.

    require_answer=False is the /v1/systemone CHAT branch (upstream
    5833533): the kwarg is passed ONLY when False, so a keg that predates
    5833533 still runs the gated path unchanged (its decide() has no such
    parameter; start()'s forced_capability() gate is the front door, this
    is the belt).

    Error translation (the HTTP route turns these into 4xx; we have no
    transport, so they become the classes _run_pack already handles):
    context overflow -> DecisionContextLengthError (skip the item),
    DecisionsRequestError/pydantic ValidationError -> DecisionRequestError
    (fail the run: a fixture the endpoint rejects is a bug in US).
    """
    from omlx.api.decisions import DecisionsRequestError, decide
    from omlx.api.decisions_models import DecisionRequest

    dr = DecisionRequest(**request)
    prepare = _prepare_readout(engine, request.get("model"))
    forced = {} if require_answer else {"require_answer": False}
    try:
        result = await decide(engine, dr, _generic_multimodal(engine),
                              prepare=prepare, **forced)
    except DecisionContextLengthError:
        raise                      # already translated by _prepare_readout
    except DecisionRequestError:
        raise
    except Exception as e:
        if _looks_like_context_error(e):
            raise DecisionContextLengthError(str(
                getattr(e, "detail", None) or e)) from e
        if isinstance(e, DecisionsRequestError) or type(e).__name__ in (
                "DecisionsRequestError", "ValidationError"):
            raise DecisionRequestError(str(e)) from e
        raise
    return {"answers": result.get("answers") or [],
            "input_tokens": result.get("input_tokens"),
            "cached_tokens": result.get("cached_tokens")}


def _finite(v):
    import math
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


async def cancel(run: DecisionRun) -> dict:
    if run.terminal:
        raise NotRunning(run.status)
    run.cancelled = True
    if run.task and not run.task.done():
        run.task.cancel()
    return {"status": "cancelled", "run_id": run.run_id}


# ---- accumulated results + SSE (same store shape as embed) -----------------

def results_root() -> Path:
    return paths.uplift_store_dir() / "bench-decision"


def _acc_file() -> Path:
    return results_root() / "accumulated.json"


_accum: Optional[list[dict]] = None


def get_accumulated() -> list[dict]:
    global _accum
    if _accum is None:
        try:
            _accum = _finite(json.loads(_acc_file().read_text()))
            if not isinstance(_accum, list):
                _accum = []
        except Exception:
            _accum = []
    return _accum


def _save_accum() -> None:
    f = _acc_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(get_accumulated(), indent=1))


def results_payload() -> dict:
    run = active_run()
    out = {"results": get_accumulated()}
    if run is not None:
        out["active"] = {"run_id": run.run_id, "status": run.status,
                         "model_id": run.model_id, "packs": run.packs,
                         "done": len(run.results)}
    return out


def reset_results() -> dict:
    global _accum
    _accum = []
    _save_accum()
    return {"status": "reset"}


async def event_stream(run: DecisionRun, *, keepalive_s: float = 60.0):
    seen = 0
    try:
        while True:
            async with run.cond:
                while seen >= len(run.events) and not run.terminal:
                    try:
                        async with asyncio.timeout(keepalive_s):
                            await run.cond.wait()
                    except TimeoutError:
                        break
                new = list(run.events[seen:])
                seen = len(run.events)
                done = run.terminal
            for ev in new:
                yield f"data: {json.dumps(ev, default=str)}\n\n"
            if not new and not done:
                yield ": keepalive\n\n"
            if done:
                break
    except asyncio.CancelledError:
        pass
