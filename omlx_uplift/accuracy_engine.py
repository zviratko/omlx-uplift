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


def valid_benchmarks() -> list[str]:
    return sorted(_acc().VALID_BENCHMARKS)


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

    try:
        req = AB.AccuracyBenchmarkRequest(**(body or {}))
    except Exception as e:
        raise BadInput(str(e)) from e

    if req.external is None:
        entry = pool.get_entry(req.model_id)
        if entry is None:
            raise NotFound(f"Model not found: {req.model_id}")
        if entry.model_type not in ("llm", "vlm", None):
            raise BadInput(f"Model {req.model_id} is not a supported model "
                           f"(type: {entry.model_type})")

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
    status = AB.get_queue_status()
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
    return {
        "results": AB.get_accumulated_results(),
        "running": status["running"],
        "current_model": status["current_model"],
        "current_bench_id": status["current_bench_id"],
    }


def results_reset() -> dict:
    _acc().reset_accumulated_results()
    return {"status": "reset"}


async def cancel() -> dict:
    await _acc().cancel_queue()
    # cancel means 'stop everything' — restore classic upload behavior
    # for the NEXT run started from any UI
    _disarm_upload_skip()
    return {"status": "cancelled"}


def get_run(bench_id: str):
    return _acc().get_run(bench_id)
