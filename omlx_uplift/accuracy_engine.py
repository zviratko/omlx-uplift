"""REPL-2a accuracy engine — in-process reuse of omlx.admin.accuracy_benchmark.

Doctrine (REPL-1/3 verdict, unchanged): classic owns the math, the queue,
the _chain_id chaining semantics, event log and result accumulation.
This module owns exactly two things:

1. the admin gate + JSON contract (classic's route layer cannot be
   imported — same finding as bench_engine.py);
2. the community-upload OPT-IN. Classic auto-uploads every LOCAL run
   (:702; upload_intelligence_result is a module global). Uplift flips
   the default: unless upload=true is passed at queue-add time, the run
   window patches AB.upload_intelligence_result with a skip stub that
   returns classic's outcome shape {"status": "skipped", "reason":
   "uplift_opt_out"} — the result row records it, the leaderboard is
   never touched, and the original attribute is restored afterwards.
   The patch is process-wide for the duration of the run: if classic's
   OWN UI starts a local run in the same window it would also skip its
   upload. Accepted deliberately (branch-preview scope; documented)
   rather than racing the runner's per-suite call sites. External runs
   never upload upstream anyway.

Contention mirrors classic's queue-add route (ANE tuning + context probe
block accuracy adds; accuracy queue blocks throughput/context/ANE starts
— the queue side is already wired through _other_bench_busy in
context_engine.py, extended here).

3. the ACC-2b SUITE SEAM (see suite_request_class below): harness-only
  suites — HARNESS_MAP entries marked 'extra', beyond classic's 16 — are
  admitted to the native queue through an UPLIFT-OWNED REQUEST SUBCLASS,
  never by patching classic's class, and only for engine='harness'. They
  ride the identical add/status/results/SSE/upload contract; they are
  LOCAL-ONLY and the harness runner refuses to upload them (see
  harness_engine.LOCAL_ONLY_UPLOAD_REASON).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from .bench_engine import BadInput, Conflict, NotFound  # shared error types

logger = logging.getLogger("uplift.accuracy_engine")


def _acc():
    from omlx.admin import accuracy_benchmark as AB
    return AB


# U64: classic's accumulated list is MEMORY-ONLY (module docstring's
# 'persists until explicit reset' means within one process — a restart
# wiped it; the user's exact complaint). Write-through + restore here,
# classic's file stays untouched; restored rows ride the classic admin
# page too (same in-memory list), which is honest: they are real results.
_acc_restored = False
_acc_last_n = -1          # rows count at the last write-through (poll spam
                          # guard: results_payload runs on every UI poll)


def _ensure_restored() -> None:
    global _acc_restored
    if _acc_restored:
        return
    _acc_restored = True
    try:
        from . import bench_history
        rows = bench_history.acc_restore()
        if rows:
            acc = _acc()
            live = acc.get_accumulated_results()
            have = {(r.get("model_id"), r.get("benchmark"), r.get("ts"))
                    for r in live}
            for r in rows:
                if (r.get("model_id"), r.get("benchmark"), r.get("ts")) not in have:
                    live.append(r)
            global _acc_last_n
            _acc_last_n = len(live)
    except Exception as e:
        logger.warning(f"accuracy history restore failed: {e}")


def valid_benchmarks() -> list[str]:
    return sorted(_acc().VALID_BENCHMARKS)


# ---- ACC-2b: the suite seam ----------------------------------------------
# classic's AccuracyBenchmarkRequest.validate_benchmarks
# (accuracy_benchmark.py:93-103, VANILLA read-only code) hard-refuses any
# name outside VALID_BENCHMARKS (the 16). Harness-only suites — HARNESS_MAP
# entries marked 'extra' (IFEval/BBH/Czech, added by ACC-2c) — must still be
# queueable through the SAME native contract (add/status/results/SSE/upload
# shape), so uplift owns a request SUBCLASS that overrides exactly that one
# validator and admits HARNESS_MAP names alongside the 16.
#
# Why a subclass and not a shim/patch of classic's class:
# * pydantic v2 replaces a parent field_validator by NAME in a subclass, so
#   the override is the framework's own extension point (drift-guarded
#   against the real class in tests/test_acc2b_suite_seam.py);
# * classic's own admin route, its /admin/api/bench/accuracy contract and
#   every other caller keep the vanilla 16-name wall — a module-level patch
#   of AB.AccuracyBenchmarkRequest would silently widen the PUBLIC omlx
#   surface to names omlx cannot run (its Phase-3 evaluator registry has no
#   such entry: accuracy_benchmark.py:494 skips it with a warning only);
# * the subclass is chosen per request, at construction, on the engine the
#   USER picked: 'harness' only. classic requests stay byte-for-byte 2a.
# Admitted names are read from HARNESS_MAP at VALIDATION time (never a
# frozen snapshot), so ACC-2c grows the map without touching this file.
_request_class_cache: tuple = (None, None)     # (base class, uplift subclass)


def suite_request_class(base: type) -> type:
    """The uplift subclass over a given classic request class. Cached per
    base identity so a module reload of classic rebuilds it and repeated
    queue_adds do not create classes.

    A non-class base means the caller is NOT talking to real classic (the
    engine test doubles hand over a plain constructor): there is no
    validator to override, so it is returned unchanged — logged, because on
    a live server it would mean upstream left pydantic and the seam has to
    be revisited (the drift guard in tests/test_acc2b_suite_seam.py is the
    tripwire for exactly that)."""
    global _request_class_cache
    if _request_class_cache[0] is base:
        return _request_class_cache[1]
    if not isinstance(base, type):
        logger.warning("accuracy suite seam: request base %r is not a class "
                       "— nothing to override (test double?), extras stay "
                       "refused", base)
        return base
    import pydantic
    from . import harness_engine

    class UpliftAccuracyRequest(base):  # type: ignore[misc,valid-type]
        @pydantic.field_validator("benchmarks")
        @classmethod
        def validate_benchmarks(cls, v: dict) -> dict:
            if not v:
                raise ValueError("At least one benchmark is required")
            admitted = harness_engine.admitted_benchmarks(
                _acc().VALID_BENCHMARKS)
            for name, size in v.items():
                if name not in admitted:
                    raise ValueError(
                        f"Invalid benchmark '{name}'. Must be one of "
                        f"{sorted(admitted)}")
                if size < 0:
                    raise ValueError(
                        f"Sample size for '{name}' must be >= 0")
            return v

    _request_class_cache = (base, UpliftAccuracyRequest)
    return UpliftAccuracyRequest


# Task grid config: the static table from classic dashboard.js
# accBenchmarkGroups (616-660) — labels/descriptions ride classic i18n
# keys resolved CLIENT-side via C.t (locales are the merged catalog);
# fullSize/sizes are dataset facts, kept server-side so the UI ships no
# per-task prose. desc keys absent from the catalog (kmmlu/cmmlu/jmmlu
# carry hardcoded native-script descs in classic) go in `desc_literal`.
TASK_GROUPS = [
    {"group": "acc_bench.benchmarks.group_knowledge", "tasks": [
        {"key": "mmlu", "label": "MMLU", "desc": "acc_bench.benchmarks.mmlu_desc",
         "full_size": 14042, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
        {"key": "mmlu_pro", "label": "MMLU-Pro", "desc": "acc_bench.benchmarks.mmlu_pro_desc",
         "full_size": 12032, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
        {"key": "kmmlu", "label": "KMMLU", "desc_literal": "한국어 지식 · 45 과목",
         "full_size": 35030, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
        {"key": "cmmlu", "label": "CMMLU", "desc_literal": "中文知识 · 67 科目",
         "full_size": 11582, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
        {"key": "jmmlu", "label": "JMMLU", "desc_literal": "日本語知識 · 112 科目",
         "full_size": 7536, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
    ]},
    {"group": "acc_bench.benchmarks.group_commonsense", "tasks": [
        {"key": "hellaswag", "label": "HellaSwag", "desc": "acc_bench.benchmarks.hellaswag_desc",
         "full_size": 10042, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
        {"key": "arc_challenge", "label": "ARC-C", "desc": "acc_bench.benchmarks.arc_desc",
         "full_size": 1172, "sizes": [30, 50, 100, 200, 300]},
        {"key": "winogrande", "label": "Winogrande", "desc": "acc_bench.benchmarks.winogrande_desc",
         "full_size": 1267, "sizes": [30, 50, 100, 200, 300]},
        {"key": "truthfulqa", "label": "TruthfulQA", "desc": "acc_bench.benchmarks.truthfulqa_desc",
         "full_size": 817, "sizes": [30, 50, 100, 200, 300]},
    ]},
    {"group": "acc_bench.benchmarks.group_math", "tasks": [
        {"key": "gsm8k", "label": "GSM8K", "desc": "acc_bench.benchmarks.gsm8k_desc",
         "full_size": 1319, "sizes": [30, 50, 100, 200, 300]},
        {"key": "mathqa", "label": "MathQA", "desc": "acc_bench.benchmarks.mathqa_desc",
         "full_size": 2985, "sizes": [30, 50, 100, 200, 300, 500, 1000]},
    ]},
    {"group": "acc_bench.benchmarks.group_coding", "tasks": [
        {"key": "humaneval", "label": "HumanEval", "desc": "acc_bench.benchmarks.humaneval_desc",
         "full_size": 164, "sizes": [30, 50, 100]},
        {"key": "mbpp", "label": "MBPP", "desc": "acc_bench.benchmarks.mbpp_desc",
         "full_size": 500, "sizes": [30, 50, 100, 200, 300]},
        {"key": "livecodebench", "label": "LiveCodeBench", "desc": "acc_bench.benchmarks.livecodebench_desc",
         "full_size": 1055, "sizes": [30, 50, 100, 200, 300]},
    ]},
    {"group": "acc_bench.benchmarks.group_safety", "tasks": [
        {"key": "bbq", "label": "BBQ", "desc": "acc_bench.benchmarks.bbq_desc",
         "full_size": 10864, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
        {"key": "safetybench", "label": "SafetyBench", "desc": "acc_bench.benchmarks.safetybench_desc",
         "full_size": 11435, "sizes": [30, 50, 100, 200, 300, 500, 1000, 2000]},
    ]},
]


async def queue_add(body: dict, pool: Any, *, upload: bool = False) -> dict:
    AB = _acc()
    try:
        from omlx.admin import ane_tuning as ANE
        a = ANE.get_active_run()
        if a is not None:
            raise Conflict(f"ANE tuning is already running (tuning_id="
                           f"{a.tuning_id}, model_id={a.request.model_id}).")
    except ImportError:
        pass
    try:
        from omlx.admin import context_benchmark as CTX
        c = CTX.get_active_run()
        if c is not None:
            raise Conflict(f"A context benchmark is already running (bench_id="
                           f"{c.bench_id}, model_id={c.request.model_id}).")
    except ImportError:
        pass

    body = dict(body or {})
    engine = str(body.pop("engine", "classic") or "classic")
    # ACC-2b: the engine decides WHICH request class validates the names, so
    # this check moved above construction (message unchanged). Constructing
    # a harness-only suite with classic's vanilla class would fail first
    # with the misleading 'Must be one of [the 16]' wall and the seam's
    # honest refusal would never be reached.
    if engine not in ("classic", "harness"):
        raise BadInput(f"unknown engine {engine!r} (classic|harness)")
    # classic iterates request.benchmarks in dict order, so suite order used
    # to be UI CLICK order — two runs of the same task SET executed (and
    # reported) differently (user request, 2026-10-13). Sort the keys here so
    # the request the classic engine sees is deterministic; values untouched.
    bm = body.get("benchmarks")
    if isinstance(bm, dict):
        body["benchmarks"] = {k: bm[k] for k in sorted(bm)}
    # the seam: a harness-engine request is validated by the uplift subclass
    # (admits HARNESS_MAP extras); classic keeps classic's own class exactly
    AB_cls = (suite_request_class(AB.AccuracyBenchmarkRequest)
              if engine == "harness" else AB.AccuracyBenchmarkRequest)
    try:
        req = AB_cls(**body)
    except Exception as e:
        raise BadInput(str(e)) from e

    if req.external is None:
        entry = pool.get_entry(req.model_id)
        if entry is None:
            raise NotFound(f"Model not found: {req.model_id}")
        if entry.model_type not in ("llm", "vlm", None):
            raise BadInput(f"Model {req.model_id} is not a supported model "
                           f"(type: {entry.model_type})")

    # REPL-2b: engine choice. 'classic' (default) is byte-for-byte the
    # 2a path; 'harness' tags the request for the dispatcher — it runs
    # ONLY if every task is mapped and the profile is harness-safe
    # (harness_engine.run_usable), otherwise the classic engine takes
    # the run unchanged. The UI shows the effective engine per result row.
    if engine == "harness":
        from . import harness_engine
        if req.external is not None:
            raise BadInput("harness engine is for local models "
                           "(external runs use the classic path)")
        unmapped = [t for t in req.benchmarks if not harness_engine.harness_available(t)]
        if unmapped:
            raise BadInput("harness engine has no equivalent for: "
                           + ", ".join(sorted(unmapped))
                           + " — run them with the classic engine")
        # ACC-2b: a harness-only suite (an 'extra') has NO classic evaluator,
        # so the dispatcher's classic fallback would DROP it silently — it
        # must be admitted only into a run the harness will actually execute.
        # Mirrors run_usable() gate for gate; honest refusal, cmmlu style.
        refusal = harness_engine.extra_admission_error(req)
        if refusal:
            raise BadInput(refusal)
        req._uplift_engine = "harness"

    _ensure_restored()   # U64: disk rows must be in the list before the
                         # next write-through replaces the file (or a
                         # restart-loop would silently shrink history)
    if not upload and req.external is None:
        _arm_upload_skip()

    AB.add_to_queue(req)
    logger.info(f"uplift native accuracy queued: {req.model_id} "
                f"benchmarks={list(req.benchmarks.keys())} "
                f"upload={'on' if upload else 'off'}")
    # synchronous start if idle — classic sets current_bench_id right away
    AB.start_next_from_queue(pool)
    # through OUR status: if the queue somehow drained already (fast
    # cancel, inline completion), the opt-out window must not stay armed
    return queue_status()


# dispatcher wrap: idempotent, in-memory patch of the classic module
# attribute (classic's file stays untouched on disk)
try:
    from . import harness_engine as _he
    _he.install_dispatcher()
except Exception:  # CI without omlx: no module to wrap; pure-import OK
    pass

_upload_orig: Optional[Any] = None


def _arm_upload_skip() -> None:
    """Patch AB.upload_intelligence_result for the opt-out window.
    Idempotent; caller pairs with _disarm_upload_skip once the queue
    drains (status not running)."""
    global _upload_orig
    AB = _acc()
    if _upload_orig is not None:
        return  # already armed
    _upload_orig = AB.upload_intelligence_result

    async def _skipped(run, ctx, result_data):  # same 3-arg contract
        return {"status": "skipped", "reason": "uplift_opt_out"}

    AB.upload_intelligence_result = _skipped


def _disarm_upload_skip() -> None:
    global _upload_orig
    if _upload_orig is None:
        return
    _acc().upload_intelligence_result = _upload_orig
    _upload_orig = None


def queue_status() -> dict:
    st = _acc().get_queue_status()
    # U83 board data: classic's status lists waiting entries as name-only
    # ("benchmarks": [names]). The UI queue needs sizes + engine to compute
    # honest queue-wide suite/question totals, and it needs the RUNNING
    # entry's full spec (classic reports it as phase text only). Additive —
    # classic's own admin page ignores the extra keys.
    AB = _acc()
    try:
        for q, r in zip(st.get("queue", []), list(AB._queue)):
            q["sizes"] = dict(r.benchmarks)
            q["engine"] = getattr(r, "_uplift_engine", "classic")
    except Exception:  # private-attr drift: board falls back to names
        pass
    if st.get("running") and st.get("current_bench_id"):
        try:
            run = AB.get_run(st["current_bench_id"])
            req = getattr(run, "request", None)
            if req is not None:
                st["running_entry"] = {
                    "model_id": req.model_id,
                    "sizes": dict(req.benchmarks),
                    "engine": getattr(req, "_uplift_engine", "classic"),
                    "external": req.external is not None,
                }
        except Exception:
            pass
    # drain management: once the queue idles, restore classic behavior
    if not st.get("running"):
        _disarm_upload_skip()
    return st


def queue_remove(idx: int) -> dict:
    AB = _acc()
    if not AB.remove_from_queue(idx):
        raise NotFound(f"Queue index {idx} not found")
    return AB.get_queue_status()


def results_payload() -> dict:
    AB = _acc()
    _ensure_restored()
    status = AB.get_queue_status()
    for r in AB.get_accumulated_results():
        r.setdefault("engine", "classic")  # label every row (REPL-2b)
    # second drain point: the UI polls results when the SSE stream
    # closes, so the opt-out window never outlives the queue even if
    # nobody hits /queue between done and the next add.
    if not status["running"] and status["current_bench_id"] is None:
        _disarm_upload_skip()
    elif not status["running"]:
        # queue empty but a run object still finalizing (phase
        # unloading->completed keeps current_bench_id); disarm only once
        # the run itself is terminal
        run = AB.get_run(status["current_bench_id"])
        if run is None or getattr(run, "terminal", False):
            _disarm_upload_skip()
    rows = AB.get_accumulated_results()
    global _acc_last_n
    # Strict mirror: the file always equals the live list, INCLUDING
    # shrinking to empty — classic's own admin-page reset must not be
    # 'resurrected' by a stale file on the next restart. Row-count-only
    # change detection (poll spam guard); a same-length in-place row edit
    # (thinking flag flip mid-finalize) is negligible for this store.
    if len(rows) != _acc_last_n:
        _acc_last_n = len(rows)
        try:
            from . import bench_history
            bench_history.acc_persist(rows)
        except Exception as e:
            logger.warning(f"accuracy history persist failed: {e}")
    return {
        "results": rows,
        "running": status["running"],
        "current_model": status["current_model"],
        "current_bench_id": status["current_bench_id"],
    }


def results_reset() -> dict:
    _acc().reset_accumulated_results()
    global _acc_last_n
    _acc_last_n = -1
    try:  # U64: 'until cleared' cuts both ways — Clear clears the disk too
        from . import bench_history
        bench_history.clear("accuracy")
    except Exception as e:
        logger.warning(f"accuracy history clear failed: {e}")
    return {"status": "reset"}


async def cancel() -> dict:
    await _acc().cancel_queue()
    # cancel means 'stop everything' — restore classic upload behavior
    # for the NEXT run started from any UI
    _disarm_upload_skip()
    return {"status": "cancelled"}


def get_run(bench_id: str):
    return _acc().get_run(bench_id)
