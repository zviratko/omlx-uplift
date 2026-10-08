"""REPL-2b: harness-engine accuracy runs (subprocess) + dispatcher.

Card decisions implemented (each pinned here or in tests):

- MIXED ENGINE BY DESIGN: HARNESS_MAP covers the generative-safe tasks
  (NAT-2 residual table, names VERIFIED to load in the bench venv).
  The 2b execution drill found humaneval/mbpp scoring needs
  HF_ALLOW_CODE_EVAL=1 executing model code IN-PROCESS in the harness
  python — weaker isolation than classic's resource-limited subprocess
  (omlx/eval/humaneval.py SECURITY NOTE) — they STAY classic with that
  reason. Everything else unmapped stays classic too. A run uses the
  harness ONLY when every requested task is mapped; the engine label
  rides on every result row ('engine': 'classic' | 'harness').
- ENGINE CHOICE: explicit. accuracy_engine tags requests from the
  native UI with _uplift_engine when the user checks 'harness engine';
  DEFAULT classic until the card's divergence drill quantifies the gap
  (few-shot formatting differs — card: quantify, don't hide).
- AUTH: key via OPENAI_API_KEY env ONLY (bench_env.spawn), never argv,
  scrubbed from captured output.
- PROGRESS: task granularity per the sanctioned fallback — one
  subprocess per suite; within a suite the harness tqdm fraction is
  parsed best-effort into bench_current/bench_total; never fabricated.
- CONTENTION: the run LEASES the model through the pool exactly like
  classic (get_engine(_lease=True) / release_engine) so settings saves
  and eviction cannot unload mid-run; requests then flow through the
  PUBLIC /v1 path as an ordinary client (the live feed shows the bench
  as a visible client — the card's documented model). We do NOT
  unload-all like classic: coexistence via the scheduler is the chosen
  semantics for harness runs, stated in the PR/CHANGELOG.
- SAMPLING: deterministic -> --gen_kwargs temperature=0.0 (greedy,
  reproducible like classic); model_settings -> gen_kwargs omitted so
  the SERVER applies the model's configured sampling — parity by
  construction on both profiles.
- UPLOAD: reuses classic's build_upload_context + upload_intelligence_
  result through the SAME opt-in window patch as REPL-2a, per suite,
  BEFORE done — identical SSE contract.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Optional

from . import bench_env

logger = logging.getLogger("uplift.harness_engine")

# classic task -> harness invocation. Names VERIFIED loadable in the
# bench venv (TaskManager().all_tasks, lm_eval 0.4.13, dev box
# 2026-10-08). fewshot mirrors CLASSIC's own prompting (mmlu-family is
# 5-shot in omlx/eval/mmlu.py:85; generative-native tasks 0).
# metric = the result-dict key prefix ('exact_match,flexible-extract'
# style); metric_contains narrows it where several filters coexist.
HARNESS_MAP: dict[str, dict[str, Any]] = {
    "mmlu": {"tasks": ["mmlu_flan_n_shot_generative"], "fewshot": 5,
             # NAT-2 residual: strict single-letter get_response scores
             # 0 for small models; flexible-extract is the parity-honest
             # choice (verified scoring live during S2/2b drills).
             "metric": "exact_match", "metric_contains": "flexible-extract"},
    "mmlu_pro": {"tasks": ["mmlu_pro"], "fewshot": 5,
                 "metric": "exact_match", "metric_contains": None},
    "arc_challenge": {"tasks": ["arc_challenge_chat"], "fewshot": 0,
                      "metric": "exact_match", "metric_contains": None},
    "gsm8k": {"tasks": ["gsm8k"], "fewshot": 0,
              "metric": "exact_match", "metric_contains": None},
    "bbq": {"tasks": ["bbq_generate"], "fewshot": 0,
            "metric": "acc", "metric_contains": None},
}

# Why every other classic task stays on the classic engine. Findings are
# live-verified (2b drills) or card decisions; do not 'optimize' a task
# into the map without re-running the divergence check the card demands.
NOT_HARNESS = {
    "kmmlu": "in all_tasks but group load raised KeyError in 0.4.13 "
             "(only per-subject kmmlu_* load) — re-probe before mapping",
    "cmmlu": "no generative variant ships; custom yaml = open 2b work "
             "item (NAT-2 residual 1)",
    "jmmlu": "no harness equivalent (card decision)",
    "hellaswag": "multiple_choice only; custom yaml open (NAT-2 residual 1)",
    "truthfulqa": "truthfulqa_gen is LLM-judge scored (needs a judge "
                  "model) — not parity with classic MC; yaml conversion open",
    "winogrande": "multiple_choice only; custom yaml open (NAT-2 residual 1)",
    "mathqa": "multiple_choice only; custom yaml open (NAT-2 residual 1)",
    "humaneval": "exec-scoring needs HF_ALLOW_CODE_EVAL=1 running model "
                 "code IN-PROCESS in the harness python — weaker isolation "
                 "than classic's resource-limited subprocess (2b live "
                 "drill + omlx/eval/humaneval.py SECURITY NOTE)",
    "mbpp": "same humaneval exec-safety finding",
    "livecodebench": "no harness equivalent (card decision)",
    "safetybench": "no harness equivalent (card decision)",
}

# U67: label-aware tqdm matcher. Group 1 is the bar NAME ('Requesting API'
# for the real evaluation pass on lm_eval 0.4.13 — verified against raw
# stdout in the U67 probe), groups 2-3 are cur/tot.
_TQDM = re.compile(r"([A-Za-z][A-Za-z ]*):\s+\d+%\|[^|]*\|\s*(\d+)/(\d+)")
_EVAL_BAR = "Requesting API"

# restart safety (card): live harness subprocesses are tracked; the
# atexit handler kills any survivor's WHOLE GROUP, and run cancellation
# kills the group inline. The default executor joins non-daemon threads
# at exit, so nothing may block on proc.wait inside one.
_live: set = set()


def _kill_live() -> None:
    for p in list(_live):
        try:
            bench_env.stop(p, grace_s=1.0)
        except Exception:
            pass


_atexit_done = False


def _ensure_atexit() -> None:
    global _atexit_done
    if _atexit_done:
        return
    import atexit
    atexit.register(_kill_live)
    _atexit_done = True


def harness_available(task: str) -> bool:
    return task in HARNESS_MAP


def run_usable(request: Any) -> bool:
    """Dispatcher gate: tagged harness, local (external classic path is
    already native-compatible), no thinking (harness cannot send chat
    template kwargs — classic keeps it honest), all tasks mapped."""
    if getattr(request, "_uplift_engine", None) != "harness":
        return False
    if request.external is not None or request.enable_thinking:
        return False
    return all(harness_available(t) for t in request.benchmarks)


def results_root() -> Path:
    from . import paths
    return paths.uplift_store_dir() / "bench-results"


# ---- U68: honest per-suite subtask counts ----------------------------------
# lm_eval --limit applies PER TASK (0.4.13 help: 'Limit number of examples
# per task'), so suite 30 on mmlu = 57 subjects x 30 requests. The UI must
# show the multiplication. Expanding a group needs lm_eval = bench-env, so
# this runs the tiny harness_sizes.py probe there ONCE and caches the map
# on disk; ready=false answers are honest None (the UI then shows plain
# sizes — never a guessed number, never a blocking call on page load).

_SIZES_FILE_NAME = "harness-subtask-sizes.json"
_sizes_mem: Optional[dict] = None


def _sizes_file() -> Path:
    from . import paths
    return paths.uplift_store_dir() / _SIZES_FILE_NAME


def subtask_counts() -> Optional[dict[str, int]]:
    global _sizes_mem
    if _sizes_mem is not None:
        return _sizes_mem
    f = _sizes_file()
    try:
        _sizes_mem = json.loads(f.read_text())
        return _sizes_mem
    except Exception:
        pass
    if bench_env.status()["state"] != "ready":
        return None          # no lazy venv build for a label; honest miss
    import subprocess
    import sys as _sys
    suites = {k: spec["tasks"] for k, spec in HARNESS_MAP.items()}
    py = bench_env.harness_python()
    if py is None:
        return None
    try:
        r = subprocess.run(
            [py, str(Path(__file__).with_name("bench_tasks")
                     / "harness_sizes.py"), json.dumps(suites)],
            capture_output=True, text=True, timeout=90,
            env={**__import__("os").environ,
                 "HF_HOME": str(bench_env.hf_cache_dir())},
        )
    except Exception:
        return None
    for line in (r.stdout or "").splitlines():
        if line.startswith("UPLIFT_SIZES "):
            try:
                _sizes_mem = json.loads(line[len("UPLIFT_SIZES "):])
            except Exception:
                return None
            try:
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(json.dumps(_sizes_mem))
            except Exception:
                pass
            return _sizes_mem
    return None


def _api_key() -> str:
    from omlx.server import _server_state
    return _server_state.global_settings.auth.api_key


def _base_url() -> str:
    from omlx.server import _server_state
    port = _server_state.global_settings.server.port or 8000
    return f"http://127.0.0.1:{port}/v1/chat/completions"


def _parse_results_json(outdir: Path, metric: str,
                        metric_contains: Optional[str]) -> tuple[Optional[float], int]:
    """(score, sample_len) from the harness results file for the suite.

    U67: lm_eval writes ONE row per leaf subtask PLUS group rows (the root
    group row carries only sample_len, no metric — probe-verified). A suite
    like mmlu = 57 subjects: the old first-match return reported ONE
    SUBJECT's aggregate as the suite score. Now: single-task suites return
    their row as before; multi-subject suites weight-average the metric
    over leaf sample_lens and report the SUM as the evaluated count — the
    truth the classic row prints (accuracy over N questions)."""
    files = sorted(outdir.rglob("results_*.json"))
    if not files:
        return None, 0
    try:
        data = json.loads(files[-1].read_text())
    except Exception:
        return None, 0
    group_names = set((data.get("groups") or {}).keys())

    def _metric_of(row: dict) -> Optional[float]:
        for key, val in row.items():
            if not key.startswith(metric + ",") or not isinstance(val, (int, float)):
                continue
            if metric_contains and metric_contains not in key:
                continue
            return float(val)
        return None

    scored: list[tuple[float, int]] = []   # (score, n) per scored leaf
    for name, t in (data.get("results") or {}).items():
        if not isinstance(t, dict) or name in group_names:
            continue                       # group rows: no metric, avoid 2x
        val = _metric_of(t)
        if val is None:
            continue
        scored.append((val, int(t.get("sample_len") or 0)))
    if not scored:
        return None, 0
    total = sum(n for _s, n in scored)
    if total <= 0:
        return scored[0][0], total
    score = sum(s * n for s, n in scored) / total
    return score, total


def _acc():
    from omlx.admin import accuracy_benchmark as AB
    return AB


async def run_suite(run: Any, task: str, sample_size: int, pool: Any,
                    suite_index: int, suite_total: int) -> dict:
    """One suite = one harness subprocess. Progress events go through
    classic's _send_event on the run object; returns classic-shape
    result_data + engine label."""
    AB = _acc()
    spec = HARNESS_MAP[task]
    if bench_env.status()["state"] != "ready":
        # lazy build per card (first use); cheap no-op when ready
        await asyncio.get_running_loop().run_in_executor(None,
                                                         lambda: bench_env.create(quiet=True))
    outdir = results_root() / run.bench_id / task
    outdir.mkdir(parents=True, exist_ok=True)
    args = ["--model", "local-chat-completions",
            "--model_args", (f"base_url={_base_url()},"
                             f"model={run.request.model_id},"
                             "max_gen_toks=256,timeout=300,"
                             "tokenizer_backend=None"),
            "--apply_chat_template",
            "--tasks", ",".join(spec["tasks"]),
            "--num_fewshot", str(spec["fewshot"]),
            "--batch_size", "1",
            "--output_path", str(outdir)]
    if sample_size:
        args += ["--limit", str(sample_size)]
    if run.request.sampling_profile == "deterministic":
        args += ["--gen_kwargs", "temperature=0.0"]
    # model_settings profile: NO gen_kwargs -> server applies the model's
    # configured sampling (classic's own profile semantics)

    key = _api_key()
    t0 = time.perf_counter()
    loop = asyncio.get_running_loop()
    _ensure_atexit()
    # hf cache + offline mode: uplift config.json (bench_env helpers),
    # card: 'sizes listed in the PR, offline-mode honored, cache dir
    # configurable'
    proc = await loop.run_in_executor(None, lambda: bench_env.spawn(
        args, api_key=key, hf_cache=bench_env.hf_cache_dir(),
        offline=bench_env.offline_mode()))
    _live.add(proc)
    lines: asyncio.Queue = asyncio.Queue()

    def _reader() -> None:
        try:
            for line in proc.stdout:
                lines.put_nowait(line)
        except Exception:
            pass
        finally:
            lines.put_nowait(None)

    reader = loop.run_in_executor(None, _reader)
    try:
        while True:
            line = await lines.get()
            if line is None:
                break
            line = bench_env.scrub_key(line, key)
            m = _TQDM.search(line)
            if m:
                label = m.group(1).strip()
                cur, tot = int(m.group(2)), int(m.group(3))
                if label == _EVAL_BAR:
                    await AB._send_event(run, {
                        "type": "progress", "phase": "eval",
                        "model_id": run.request.model_id, "benchmark": task,
                        "message": f"Evaluating {task} ({cur}/{tot})...",
                        "current": suite_index, "total": suite_total,
                        "bench_current": cur, "bench_total": tot})
                else:
                    # U67: prep bars (dataset Map/cache over FULL split
                    # sizes) must never masquerade as evaluation — the
                    # number is real but it is NOT question progress
                    await AB._send_event(run, {
                        "type": "progress", "phase": "prepare",
                        "model_id": run.request.model_id, "benchmark": task,
                        "message": f"Preparing {task} ({label} {cur}/{tot})",
                        "current": suite_index, "total": suite_total})
        # poll, never executor-blocked wait: cancellation must unwind
        while proc.poll() is None:
            await asyncio.sleep(0.5)
        rc = proc.returncode
        await reader
    except asyncio.CancelledError:
        bench_env.stop(proc)
        raise
    finally:
        _live.discard(proc)
    if rc != 0:
        raise RuntimeError(f"harness exited {rc} for {task} (output under {outdir})")
    score, total = _parse_results_json(outdir, spec["metric"],
                                       spec.get("metric_contains"))
    if score is None:
        raise RuntimeError(f"harness produced no '{spec['metric']}' score for {task}")
    return {"model_id": run.request.model_id, "external": False,
            "benchmark": task, "accuracy": round(score, 4),
            "thinking_used": False,
            "total": total, "correct": int(round(score * total)) if total else 0,
            "time_s": round(time.perf_counter() - t0, 1),
            "dataset_total": None,  # harness reports sampled n, not split size
            "sampling_profile": run.request.sampling_profile,
            "engine": "harness", "question_results": []}


async def run_harness(run: Any, engine_pool: Any, classic_runner) -> None:
    """Harness branch of the accuracy queue. Lease -> per-suite
    subprocess -> events/results/upload -> release -> done, matching
    classic's SSE contract. A failure BEFORE any result falls back to
    classic for the WHOLE run (an honest score beats a half-mechanism)."""
    AB = _acc()
    request = run.request
    leased = False
    emitted_any = False
    try:
        names = list(request.benchmarks)
        run.phase = "loading"
        await AB._send_event(run, {"type": "progress", "phase": "load",
                                   "model_id": request.model_id, "benchmark": "",
                                   "message": f"Loading {request.model_id} "
                                   "(harness serves via the public API)...",
                                   "current": 0, "total": len(names)})
        # classic's own lease call (accuracy_benchmark.py:450) — settings
        # saves and TTL eviction cannot unload the engine mid-run
        await engine_pool.get_engine(request.model_id, force_lm=True, _lease=True)
        leased = True
        try:
            run.upload_ctx = AB.build_upload_context(request, engine_pool)
        except Exception as e:
            logger.warning(f"harness upload context unavailable: {e}")
            run.upload_ctx = None
        run.phase = "evaluating"
        for i, task in enumerate(names):
            result_data = await run_suite(run, task, request.benchmarks[task],
                                          engine_pool, i, len(names))
            run.results.append(result_data)
            AB.get_accumulated_results().append(result_data)
            emitted_any = True
            await AB._send_event(run, {"type": "result", "data": result_data})
            if run.upload_ctx is not None and run.status != "cancelled":
                outcome = await AB.upload_intelligence_result(
                    run, run.upload_ctx, result_data)
                result_data["upload"] = outcome
                await AB._send_event(run, {"type": "upload", "data": {
                    "model_id": request.model_id, "benchmark": task, **outcome}})
        run.phase = "unloading"
        await AB._send_event(run, {"type": "progress", "phase": "unloading",
                                   "model_id": request.model_id, "benchmark": "",
                                   "message": "Releasing harness model lease...",
                                   "current": len(names), "total": len(names)})
        run.status = "completed"
        run.phase = "completed"
        await AB._send_event(run, {"type": "done", "summary": {
            "model_id": request.model_id, "engine": "harness"}})
    except asyncio.CancelledError:
        run.status = "cancelled"
        run.error_message = "Accuracy benchmark cancelled by user"
        run.phase = "cancelled"
        await AB._send_event(run, {"type": "error", "message": run.error_message})
    except Exception as e:
        logger.error(f"harness run failed: {e}", exc_info=True)
        if emitted_any:
            # half-scored run: report error honestly, NO silent re-run
            run.status = "error"
            run.error_message = str(e)
            await AB._send_event(run, {"type": "error", "message": str(e)})
        else:
            # reset to classic's starting state and run classic instead
            run.events.clear()
            run.terminal = False
            run.status = "running"
            run.phase = "pending"
            await classic_runner(run, engine_pool)
            leased = False  # classic manages its own load/unload
    finally:
        if leased:
            try:
                rel = engine_pool.release_engine(request.model_id)
                if asyncio.iscoroutine(rel):
                    await rel
            except Exception as e:
                logger.warning(f"harness release failed: {e}")


_installed = False


def install_dispatcher() -> None:
    """Wrap AB.run_accuracy_benchmark once per process. Idempotent.
    Called from accuracy_engine at import (uplift-owned code only —
    classic's module is patched in memory, never on disk)."""
    global _installed
    AB = _acc()
    if _installed or getattr(AB, "_uplift_dispatcher", False):
        _installed = True
        return
    original = AB.run_accuracy_benchmark

    async def dispatched(run, engine_pool):
        if run_usable(run.request):
            return await run_harness(run, engine_pool, original)
        return await original(run, engine_pool)

    dispatched.__uplift_wraps__ = getattr(original, "__name__", "?")
    AB.run_accuracy_benchmark = dispatched
    AB._uplift_dispatcher = True
    _installed = True
