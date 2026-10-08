"""REPL-4c: native decision / System-1 bench over /v1/systemone.

Card 4c: no existing harness — the pack is in-house
(omlx_uplift/evals/systemone): pinned JSON fixtures + pure metrics, the
request format is bespoke (typed questions: choice / noul).

Why in-process instead of a subprocess venv (contrast with REPL-4a/4b):
the eval here IS a sequence of /v1/systemone calls — nothing to delegate.
We call the EXACT public endpoint logic (server.create_systemone) through
upstream's own lease helper `acquire_decision_engine` so:
  - the scored path is byte-for-byte what any API client hits (parity
    doctrine: bench measures the serving path, not a private seam),
  - the decision engine cannot be evicted mid-run (eviction-proof lease),
  - no second venv and no HTTP self-calls from inside the server.
Error contract mirrored from server.py: DecisionContextLengthError ->
per-item skip with reason, DecisionRequestError -> run fails (a fixture
the endpoint rejects is a bug in US, not noise to hide).

Scores per pack (metrics.py has the definitions):
  accuracy  — choice answer text == gold text
  brier/ece — DERIVED noul legs: gold option asserted true (y=1) + first
              distractor option asserted true (y=0). These are the
              probability questions the card calls out; they are derived
              at run time so the fixtures stay single-shape.
  agreement — same item re-asked with option keys permuted picks the
              same TEXT again (position-bias test; 1-agreement = bias)
  ms/question — wall time of the full typed call (latency class sanity)
"""
from __future__ import annotations

import asyncio
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


def validate_body(body: dict) -> tuple[str, list[str], int]:
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
    return model_id, [str(p) for p in packs], limit


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
        "items": len(rows),
    }


# ---- run object (same events/cond/terminal shape as embed_engine) ---------

class DecisionRun:
    def __init__(self, run_id: str, model_id: str,
                 packs: list[str], limit: int):
        self.run_id = run_id
        self.model_id = model_id
        self.kind = KIND
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
    model_id, packs, limit = validate_body(body)
    # type gate BEFORE leasing: pointing the bench at an LLM would load a
    # 30B model just to fail — ask the pool what this id is first
    _check_decision_model(model_id)
    run = DecisionRun(f"sys1-{uuid.uuid4().hex[:12]}", model_id, packs, limit)
    _active = run
    # U66: the house INFO-at-start / INFO-at-finish pair the classic bench
    # modules all have — a decision run was invisible in server.log even at
    # TRACE (user report), which reads as 'nothing happened'
    logger.info(f"uplift native decision bench started: {run.run_id} "
                f"model={model_id} packs={packs} limit={limit or 'full'}")
    run.task = asyncio.create_task(_runner(run))
    return {"run_id": run.run_id, "status": "running",
            "model_id": model_id, "packs": packs}


def _check_decision_model(model_id: str) -> None:
    from omlx import server as _srv
    try:
        pool = _srv.get_engine_pool()
    except Exception:
        return   # pool not up yet; the lease below produces the real error
    entry = pool._entries.get(model_id)
    if entry is None:
        raise NotFound(f"model not found: {model_id}")
    if getattr(entry, "engine_type", None) != "decision":
        raise BadInput(f"{model_id} is not a decision model "
                       "(this bench scores /v1/systemone models)")


def _lease(model_id: str):
    """The upstream lease seam, isolated for testing: returns an async CM
    yielding a leased DecisionEngine (server.py acquire_decision_engine).
    Local stand-in classes above mean _runner itself never imports omlx."""
    from omlx import server as _srv
    return _srv.acquire_decision_engine(model_id)


async def _runner(run: DecisionRun) -> None:
    cm = None
    entered = False
    engine = None
    _t0 = time.perf_counter()
    try:
        cm = _lease(run.model_id)
        engine = await cm.__aenter__()
        entered = True
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
                        f"{run.run_id} model={run.model_id} "
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
        if j and j % PROGRESS_STRIDE == 0:
            await run.send({"type": "progress", "phase": "items",
                            "task": pack_name, "current": j,
                            "total": len(items),
                            "message": f"{pack_name}: {j}/{len(items)}"})
        # U66: TRACE heartbeat — level 5 is omlx's trace (logging_config
        # maps TRACE to 5; no logger.trace method exists, discovery.py uses
        # the same logger.log(5, ...) call shape)
        logger.log(5, "decision %s %s item %d/%d", run.run_id,
                   pack_name, j + 1, len(items))
        req = build_request(run.model_id, item, seed=j, shuffle=False)
        try:
            res = await _decide(engine, req)
        except ctx_err:
            skipped += 1     # state too long even truncated: honest skip
            continue
        except req_err as e:
            raise BadInput(f"{pack_name} item {item['id']}: {e}") from e
        n_q += len(req["questions"])
        res_s = None
        try:
            res_s = await _decide(engine, build_request(
                run.model_id, item, seed=j, shuffle=True))
            n_q += 1
        except (ctx_err, req_err):
            pass             # re-ask is optional; agreement stays None
        rows.append(score_item(item, res, res_s))
    elapsed = time.perf_counter() - t0
    if run.cancelled:
        return             # embed_engine._run_one parity: a cancelled pack
                           # is NOT scored/persisted (partial rows would
                           # silently pollute the accumulated table)
    row = {"pack": pack_name, "model_id": run.model_id, "kind": run.kind,
           "engine": "systemone", "skipped": skipped,
           "ts": int(time.time()),
           **pack_scores(rows, elapsed, n_q)}
    row = _finite(row)
    run.results.append(row)
    get_accumulated().append(row)
    _save_accum()   # write-through: a crash keeps finished packs
    logger.info(f"decision {run.run_id} pack {pack_name}: "
                f"{len(rows)} scored, {skipped} skipped, {elapsed:.1f}s")
    await run.send({"type": "result", "data": row})


async def _decide(engine, request: dict) -> dict:
    """The create_systemone logic in-process: encode -> systemone."""
    plan = await engine.encode(request, truncate=request.get("truncate", True))
    return await engine.systemone(plan)


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
