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
  BEFORE done — identical SSE contract. ACC-2b exception: a suite marked
  'extra' (harness-only, see the seam block below) is NEVER uploaded —
  omlx.ai knows only the classic 16 — and its row records the skip.
"""
from __future__ import annotations

import asyncio
import hashlib
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
# 2026-10-08; the uplift_* names come from bench_tasks/yamls/ via
# --include_path, 2b-carryover). fewshot mirrors CLASSIC's own prompting
# (mmlu-family is 5-shot in omlx/eval/mmlu.py:85; generative-native
# tasks 0).
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
    # ---- 2b-carryover: custom generative yamls (bench_tasks/yamls/,
    # shipped via --include_path; metric keys VERIFIED against real
    # results_*.json in the scratch smoke, 2026-10-14). All use the
    # repo's mmlu doctrine: flexible-extract scored, strict kept as
    # reference row only.
    "hellaswag": {"tasks": ["uplift_hellaswag_generative"], "fewshot": 0,
                  "metric": "exact_match",
                  "metric_contains": "flexible-extract"},
    "winogrande": {"tasks": ["uplift_winogrande_generative"], "fewshot": 0,
                   "metric": "exact_match",
                   "metric_contains": "flexible-extract"},
    "mathqa": {"tasks": ["uplift_mathqa_generative"], "fewshot": 0,
               "metric": "exact_match",
               "metric_contains": "flexible-extract"},
    "truthfulqa": {"tasks": ["uplift_truthfulqa_generative"], "fewshot": 0,
                   # MC1 hides the correct answer at choices[0] in EVERY row,
                   # so this twin needs BOTH halves of classic: the seeded
                   # choice shuffle (process_docs,
                   # uplift_generative_utils.truthfulqa_shuffle_row) and
                   # classic's OWN extractor. flexible-extract's plain
                   # last-[A-Z] regex cannot express classic's
                   # upper-case-then-cue-then-valid-letters rules and lost
                   # 3.06 pt on identical responses (78/817 rows), so the
                   # scored filter is the 'classic-extract' custom mirror;
                   # strict-match + flexible-extract stay in the yaml as
                   # reference rows. Keys pinned from the real
                   # results_2026-10-14T03-1x run (n=817).
                   "metric": "exact_match",
                   "metric_contains": "classic-extract"},
    "kmmlu": {"tasks": ["kmmlu_direct"], "fewshot": 5,
              # 2026-10-14 re-probe: the old group-load KeyError is GONE
              # in this bench-env (TaskManager loads kmmlu + all 30
              # kmmlu_* groups cleanly; 45 kmmlu_direct leaves — measured
              # with the repo's own harness_sizes.py probe 2026-10-14),
              # generate_until on HAERAE-HUB/KMMLU with per-subject
              # dataset_name). direct = letter-answer prompt, closest to
              # classic (omlx/eval/kmmlu.py); 5-shot mirrors classic's
              # '< 5' dev examples.
              "metric": "exact_match", "metric_contains": None},
    "cmmlu": {"tasks": ["uplift_cmmlu_generative"], "fewshot": 5,
              # 2026-10-14 USER OVERRIDE of the script-wall refusal: the
              # finding about the hub STANDS (haonan-li/cmmlu =
              # lmlmcat/cmmlu ships only a datasets loader script + a raw
              # zip; datasets 5.x refuses scripts, no parquet mirror) — the
              # twin simply never asks the hub. CMMLU's test + dev splits
              # are VENDORED under bench_tasks/cmmlu_data/ (PROVENANCE.md:
              # pinned revision, checksum, CC BY-NC-SA 4.0) and served by
              # the custom_dataset in bench_tasks/yamls/, so the suite
              # builds with HF_HUB_OFFLINE=1. One leaf per subject (67 =
              # the mmlu suite shape, because --limit is PER TASK), prompt
              # byte-identical to classic's format_prompt on the 50
              # pool-backed samples of a --limit 5 run; the other 285
              # differ ONLY by the shots classic's own dev bundle lost.
              # 5 dev shots, A-D letters; metric key pinned on REAL
              # results_*.json (0-shot AND 5-shot smokes, 67 leaves x 5
              # samples): 'exact_match,flexible-extract' — the group row
              # carries no metric, so _parse_results_json weight-averages
              # the leaves and reports n=335.
              "metric": "exact_match", "metric_contains": "flexible-extract"},
    # ---- ACC-2c: batch-1 HARNESS-ONLY extras (the seam's first residents).
    # Each carries the seam metadata block (harness_engine, 'extra' means:
    # outside classic's 16, harness-runnable only, never uploadable). Task
    # names, leaf counts, splits and METRIC KEYS below were pinned against
    # REAL results_*.json from the SmolLM2-360M scratch smokes of 2026-10-14
    # (outdir ~/.omlx/uplift/bench-results/<bench_id>/<suite>/), never from
    # what the yaml 'should' emit.
    "ifeval": {"tasks": ["ifeval"], "fewshot": 0,
               # Instruction following (google/IFEval). generate_until, ONE
               # leaf, 541 rows — and its eval split is literally named
               # 'train' (ifeval.yaml: test_split: train), which classic's
               # board has no notion of: no parity obligation, no twin.
               # The suite has FOUR metrics (prompt/inst x strict/loose);
               # prompt_level_strict_acc is the headline number the IFEval
               # paper leads with, so it is the ONE we score — averaging
               # across them would invent a measure nobody asked for.
               # Scoring needs langdetect + immutabledict (both pinned in
               # bench_env_requirements.txt) and the nltk corpora that
               # bench_env now pre-seeds (punkt_tab at import, punkt while
               # counting sentences).
               "metric": "prompt_level_strict_acc", "metric_contains": None,
               "extra": True, "label": "IFEval", "family": "instruction",
               "rows": 541, "upload_ok": False},
    "bbh_cot_fewshot": {"tasks": ["bbh_cot_fewshot"], "fewshot": 3,
               # BIG-Bench Hard, chain-of-thought, 3-shot — the task's OWN
               # native num_fewshot (cot_fewshot template), so the prompt
               # shape is what the suite was designed for. 27 leaves /
               # 6511 rows (measured over every leaf's test_docs() in
               # bench-env — what a run actually scores; the design pass's
               # 6761 is a dataset-card figure including rows the test split
               # does not emit). The card feared a per-leaf metric zoo
               # (lm_eval's bigbench sets really do mix em/f1/qa); MEASURED
               # on 0.4.13 this group is uniform: every leaf inherits
               # exact_match from _cot_fewshot_template_yaml and the results
               # row keys it as 'exact_match,get-answer' (the 'get-answer'
               # regex filter), so one pinned pair covers all 27 and the
               # suite needs no 'metrics' fallback list.
               "metric": "exact_match", "metric_contains": "get-answer",
               "extra": True, "label": "BBH (CoT)", "family": "reasoning",
               "rows": 6511, "upload_ok": False},
    "mmlu_prox_lite_cs": {"tasks": ["mmlu_prox_lite_cs"], "fewshot": 5,
               # Czech knowledge: li-lab/MMLU-ProX-Lite config 'cs', 14
               # subject leaves / 588 rows, ~1 MB. The locale answer to the
               # card's Czech question — every OTHER Czech candidate
               # (Global-MMLU-cs, Belebele-cs, multiblimp, CSATQA) is
               # multiple_choice = loglikelihood, which omlx cannot serve
               # (NAT-2), so they stay refused-BY-METHOD. This one is
               # generate_until with a Czech answer-regex extractor
               # ('Odpověď je (X)') and 5-shot from its validation split —
               # again the task's native setting, matched rather than
               # imposed. Metric pinned from the real run:
               # 'exact_match,custom-extract'.
               "metric": "exact_match", "metric_contains": "custom-extract",
               "extra": True, "label": "Czech knowledge (MMLU-ProX-Lite)",
               "family": "locale", "rows": 588, "upload_ok": False},
    # ---- ACC-2c batch-2: the two FAST Czech extras (direct answer emit;
    # one line of generation per item instead of a reasoning chain). Both
    # harness-only 'extra' — no classic twin, no 2-pt parity duty. Metric
    # keys pinned from REAL results_*.json of the 2026-10-15 scratch
    # smokes (SmolLM2-360M, isolated :8130 server, --limit 5).
    "prox_lite_cs_direct": {"tasks": ["uplift_prox_lite_cs_direct"],
               "fewshot": 5,
               # Direct sibling of the suite above: same dataset/splits/pool
               # and the SAME native extractor + filter name ('custom-
               # extract' / 'Odpověď je (X)') so scores stay comparable;
               # the CoT cue is swapped for a direct-answer directive and
               # shot targets are trimmed to their answer line. 14 leaves /
               # 588 rows (sizes probe + test_docs walk re-measured this
               # session); run1 weighted 0.1714 over n=70 (--limit 5).
               "metric": "exact_match", "metric_contains": "custom-extract",
               "extra": True, "label": "Czech knowledge (ProX-Lite, direct)",
               "family": "locale", "rows": 588, "upload_ok": False},
    "belebele_cs": {"tasks": ["uplift_belebele_cs"], "fewshot": 0,
               # Reading comprehension over the translated Flores passages
               # (facebook/belebele ces_Latn, ONE split 'test', 900 rows —
               # fewshot_split 'train' would crash, so 0-shot like
               # arc_challenge_chat). Built-in is multiple_choice = refused
               # by method on omlx (NAT-2); this is the letter-answer
               # generative twin. Licence CC-BY-NC 4.0: local-only extra,
               # rows never upload. run1: flexible-extract 0.2 on n=5,
               # strict 0.0 — the model writes 'Odpověď: X', never bare
               # letters, which is exactly why flexible scores and strict
               # is kept only as a reference row (house doctrine).
               "metric": "exact_match", "metric_contains": "flexible-extract",
               "extra": True, "label": "Belebele (Czech)", "family": "locale",
               "rows": 900, "upload_ok": False},
}

# Custom generative task pack for the suites above (REPL-2b carryover).
# lm_eval only knows these through --include_path; the sizes probe must
# register the same dir or the new suites have no leaf counts and the
# U68 UI math silently degrades to 'x1'.
def _task_yamls_dir() -> Path:
    return Path(__file__).with_name("bench_tasks") / "yamls"

# Why every other classic task stays on the classic engine. Findings are
# live-verified (2b drills) or card decisions; do not 'optimize' a task
# into the map without re-running the divergence check the card demands.
NOT_HARNESS = {
    # cmmlu USED to live here: the 2026-10-14 probe finding (haonan-li/cmmlu
    # ships only a datasets loader script + a raw zip, datasets 5.x refuses
    # scripts, no parquet mirror on the hub) is still true of the HUB. It
    # stopped being a blocker the moment the user overrode the refusal: the
    # twin scores VENDORED data (bench_tasks/cmmlu_data/ + PROVENANCE.md)
    # through custom_dataset, so the hub is never contacted. See HARNESS_MAP.
    "jmmlu": "no harness equivalent (card decision)",
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


# ---- ACC-2b: the suite seam (harness-only suites beyond classic's 16) ------
# A HARNESS_MAP entry may be an uplift-OWNED suite — one classic has never
# heard of (IFEval, BBH, Czech sets ... added by ACC-2c). Such a spec carries
# metadata keys NEXT TO the execution keys it already needs:
#
#   {'extra': True, 'label': <display str>, 'family': one of EXTRA_FAMILIES,
#    'rows': <full-dataset question count or None>, 'upload_ok': False}
#
# Everything else (default-map entries, incl. the classic-16 twins such as
# cmmlu when the sibling lane maps it) carries NO 'extra' key and keeps its
# pre-2b semantics untouched.
#
# 'extra' means two hard things:
# 1. classic's AccuracyBenchmarkRequest.validate_benchmarks refuses the name,
#    so ONLY the harness engine can ever run it. accuracy_engine admits it
#    through an uplift-owned request subclass (see there) — classic's class
#    is never patched, its own admin route keeps the 16-name contract.
# 2. omlx.ai's leaderboard knows only the 16, so the suite is LOCAL-ONLY:
#    uploading would post a score the site has no column for. upload_blocked()
#    is the single runner-side gate for that.
EXTRA_FAMILIES = frozenset({"instruction", "reasoning", "locale"})
# Machine-readable skip reason recorded on the row (and in the 'upload'
# event) instead of an upload attempt. The native board renders ANY
# upload.status == 'skipped' as '—' (uplift_bench.js:3275) exactly like the
# REPL-2a opt-out, so no UI string was needed to surface this.
LOCAL_ONLY_UPLOAD_REASON = "local_only_suite"


def harness_available(task: str) -> bool:
    return task in HARNESS_MAP


def suite_spec(task: str) -> dict:
    """The HARNESS_MAP spec of a suite, or {} (never raises — callers read
    metadata off names that may not be mapped at all)."""
    return HARNESS_MAP.get(task) or {}


def is_extra(task: str) -> bool:
    """True for an uplift-owned suite outside classic's VALID_BENCHMARKS."""
    return bool(suite_spec(task).get("extra"))


def upload_blocked(task: str) -> bool:
    """Runner gate: never hand this suite's score to omlx.ai. Driven by
    'extra' (the leaderboard has no column for it) and honours an explicit
    upload_ok: False on any future spec."""
    spec = suite_spec(task)
    return bool(spec.get("extra")) or spec.get("upload_ok") is False


def admitted_benchmarks(classic_names: Any) -> set:
    """Names a HARNESS-engine request may carry: classic's 16 plus every
    HARNESS_MAP key (twins and extras). Read live on every call — never a
    frozen snapshot — so ACC-2c adding a suite to HARNESS_MAP takes effect
    without touching the seam, and tests can inject a fake extra."""
    return set(classic_names) | set(HARNESS_MAP)


def extra_suites() -> list[dict]:
    """The picker's 'Additional suites' payload (ACC-2b contract, exact
    shape): [{'key','label','family','rows','upload_ok': False}, ...] for
    spec.get('extra') entries only, sorted by key. Twin entries (no
    'extra') never appear here — they are already in the classic grid."""
    out = []
    for key in sorted(HARNESS_MAP):
        spec = HARNESS_MAP[key]
        if not spec.get("extra"):
            continue
        out.append({"key": key,
                    "label": str(spec.get("label") or key),
                    "family": spec.get("family"),
                    "rows": spec.get("rows"),
                    "upload_ok": False})
    return out


def extra_admission_error(request: Any) -> Optional[str]:
    """Queue-side refusal for local-only suites, mirroring run_usable()
    gate for gate (an extra admitted by the seam must be a run the harness
    can ACTUALLY execute — classic cannot run it, so 'tag it and let the
    dispatcher fall back' would silently drop the suite). Returns None when
    the extras may be queued, else the honest message (same style as the
    cmmlu 'no equivalent' refusal)."""
    extras = sorted(t for t in (getattr(request, "benchmarks", None) or {})
                    if is_extra(t))
    if not extras:
        return None
    names = ", ".join(extras)
    if getattr(request, "external", None) is not None:
        return (f"harness-only suite(s) {names} run against a local model "
                f"only — external endpoints use the classic engine")
    # thinking is NOT a wall anymore (2026-10-15): the harness threads the
    # checkbox through chat_template_kwargs, so an extra may run thinking.
    return None


def run_usable(request: Any) -> bool:
    """Dispatcher gate: tagged harness, local (external classic path is
    already native-compatible), all tasks mapped. ACC-2b: extras live IN
    HARNESS_MAP, so they pass through here with no change; queue_add's
    extra_admission_error keeps them from being tagged into a run the
    harness would not execute. THINKING (2026-10-15): no longer a wall —
    the harness now threads the checkbox through chat_template_kwargs, so a
    thinking run on the harness is honest (and gets the budget it needs)."""
    if getattr(request, "_uplift_engine", None) != "harness":
        return False
    if request.external is not None:
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


def _sizes_fingerprint(suites: dict) -> str:
    """Cache validity stamp: ONLY the suite->tasks map, which is what the
    probe measured. When HARNESS_MAP grows the fingerprint changes and a
    stale cache is ignored — the U68 labels must never multiply against an
    old task set. (2026-10-14 fix: the include_path string used to be part
    of this hash. It must not be: it resolves to the interpreter's own
    install dir, so the repo-checkout and the deployed keg computed
    different fingerprints for the SAME map — the live board then refused
    a cache the CLI had just written and re-probed on every call, blowing
    its own subprocess timeout. The path is process-local plumbing, not a
    measurement input; the suites dict passed to the probe is what
    matters.)"""
    payload = json.dumps({"suites": suites}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def subtask_counts() -> Optional[dict[str, int]]:
    global _sizes_mem
    if _sizes_mem is not None:
        return _sizes_mem
    suites = {k: spec["tasks"] for k, spec in HARNESS_MAP.items()}
    fp = _sizes_fingerprint(suites)
    f = _sizes_file()
    try:
        data = json.loads(f.read_text())
        # old cache shape (bare {suite: n}, pre-2b-carryover) fails the
        # fingerprint check like any stale one: re-probe, never trust.
        if data.get("fingerprint") == fp and isinstance(data.get("sizes"),
                                                        dict):
            _sizes_mem = data["sizes"]
            return _sizes_mem
    except Exception:
        pass
    if bench_env.status()["state"] != "ready":
        return None          # no lazy venv build for a label; honest miss
    import subprocess
    import sys as _sys
    py = bench_env.harness_python()
    if py is None:
        return None
    try:
        r = subprocess.run(
            [py, str(Path(__file__).with_name("bench_tasks")
                     / "harness_sizes.py"), json.dumps(suites),
             str(_task_yamls_dir())],
            capture_output=True, text=True, timeout=240,
            # 14-suite warm probe measured ~100 s (cmmlu's 67 inline leaves
            # register one by one); 90 s timed out the board's re-probe and
            # left U68 labels honest-but-missing forever.
            # ACC-2c: expanding a suite LOADS its task module, and lm_eval's
            # ifeval utils import nltk (+ langdetect) at that moment — the
            # probe is a harness child for these purposes and gets the same
            # uplift-owned NLTK_DATA the real run gets, or a sizes probe on a
            # fresh box reaches the network just to print a leaf count.
            env={**__import__("os").environ,
                 "HF_HOME": str(bench_env.hf_cache_dir()),
                 "NLTK_DATA": str(bench_env.nltk_data_dir())},
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
                f.write_text(json.dumps({"fingerprint": fp,
                                         "sizes": _sizes_mem}))
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


def _suite_metrics(spec: dict) -> list[tuple[str, Optional[str]]]:
    """The ordered metric CANDIDATES of a suite: [(prefix, contains), ...].

    ACC-2c: one (metric, metric_contains) pair is enough while every leaf of
    a suite scores with the same metric (all 11 shipped twins do, and
    bbh_cot_fewshot measured uniformly too — exact_match/get-answer on all
    27 leaves of lm_eval 0.4.13, see HARNESS_MAP). It stops being enough the
    moment a suite mixes families: lm_eval's bigbench-style groups carry a
    per-subset metric_list (em / f1 / qa_number ...), and generic-style
    suites add 'alias' rows. A suite declares 'metrics': [...] in that case
    and each leaf takes the FIRST candidate it actually has — no leaf is
    scored twice, and a leaf with NONE of the candidates is MISSING, not
    guessed at.

    Accepted item shapes (documented by the tests, nothing cleverer):
      'exact_match'                      -> ('exact_match', spec's contains)
      ['prompt_level_strict_acc', 'none']-> ('prompt_level_strict_acc','none')
    A spec with only the classic 'metric' key behaves EXACTLY as before.
    """
    contains = spec.get("metric_contains")
    out: list[tuple[str, Optional[str]]] = []
    for item in (spec.get("metrics") or []):
        if isinstance(item, (list, tuple)):
            prefix = item[0]
            narrow = item[1] if len(item) > 1 else contains
        else:
            prefix, narrow = item, contains
        if prefix:
            out.append((str(prefix), narrow or None))
    if not out and spec.get("metric"):
        out.append((spec["metric"], contains or None))
    return out


def _parse_results_json(outdir: Path, metric: str,
                        metric_contains: Optional[str],
                        metrics: Any = None) -> tuple[Optional[float], int]:
    """(score, sample_len) from the harness results file for the suite.

    U67: lm_eval writes ONE row per leaf subtask PLUS group rows (the root
    group row carries only sample_len, no metric — probe-verified). A suite
    like mmlu = 57 subjects: the old first-match return reported ONE
    SUBJECT's aggregate as the suite score. Now: single-task suites return
    their row as before; multi-subject suites weight-average the metric
    over leaf sample_lens and report the SUM as the evaluated count — the
    truth the classic row prints (accuracy over N questions).

    ACC-2c: `metric` may be one prefix (every existing caller) or the whole
    candidate LIST may arrive as `metrics` / a list `metric` — see
    _suite_metrics. The weight-averaging is over whatever leaves DID score,
    so a mixed-metric suite still reports 'accuracy over N questions' and
    never a fabricated mean for a leaf no candidate matched.
    """
    files = sorted(outdir.rglob("results_*.json"))
    if not files:
        return None, 0
    try:
        data = json.loads(files[-1].read_text())
    except Exception:
        return None, 0
    group_names = set((data.get("groups") or {}).keys())
    # candidates in priority order: an explicit list (either shape) wins,
    # otherwise the classic single (metric, metric_contains) pair
    if isinstance(metric, list):
        cands = _suite_metrics({"metrics": metric,
                                "metric_contains": metric_contains})
    elif metrics is not None:
        cands = _suite_metrics({"metrics": list(metrics),
                                "metric_contains": metric_contains})
    else:
        cands = _suite_metrics({"metric": metric,
                                "metric_contains": metric_contains})

    def _metric_of(row: dict) -> Optional[float]:
        for prefix, contains in cands:
            for key, val in row.items():
                if not key.startswith(prefix + ",") or not isinstance(val, (int, float)):
                    continue
                if contains and contains not in key:
                    continue
                return float(val)         # first hit for THIS leaf, in order
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


def _suite_args(spec: dict, base_url: str, model_id: str, outdir: Path,
                sample_size: int, sampling_profile: str,
    enable_thinking: bool = False) -> list[str]:
    """CLI args for one suite subprocess. Own function so tests pin the
    surface without omlx/server state — notably --include_path: the
    custom generative yamls (bench_tasks/yamls/) are ONLY visible to
    lm_eval through it, and omitting it would break exactly the suites
    the 2b-carryover added while the 5 originals keep working (the
    silent-regression shape).

    THINKING (user 2026-10-15): the advanced-settings checkbox is the ONLY
    thinking control; it was never reaching the server here (the harness
    built no chat_template_kwargs), so the server's per-model default leaked
    a CoT into every 'direct' suite. Now EVERY request carries an explicit
    chat_template_kwargs={'enable_thinking': <choice>} — checked => thinking,
    unchecked => direct (no CoT). lm_eval merges --gen_kwargs onto each
    task's generation_kwargs (evaluator update=True), so this reaches both
    the native suites (ifeval/bbh, whose own budgets I don't touch) and my
    custom twins. When thinking is ON I also raise max_gen_toks so the
    answer lands AFTER the reasoning (else it finishes on length). The value
    is a real JSON dict passed as one --gen_kwargs token (MergeDictAction
    try_parse_json -> nested bool, not a string)."""
    args = ["--model", "local-chat-completions",
            "--model_args", (f"base_url={base_url},"
                             f"model={model_id},"
                             "max_gen_toks=256,timeout=300,"
                             "tokenizer_backend=None"),
            "--apply_chat_template",
            "--tasks", ",".join(spec["tasks"]),
            "--include_path", str(_task_yamls_dir()),
            "--num_fewshot", str(spec["fewshot"]),
            "--batch_size", "1",
            "--output_path", str(outdir)]
    if sample_size:
        args += ["--limit", str(sample_size)]
    gen_kwargs = {"chat_template_kwargs": {"enable_thinking": bool(enable_thinking)}}
    if sampling_profile == "deterministic":
        gen_kwargs["temperature"] = 0.0
    if enable_thinking:
        # room for reasoning THEN the answer; task-native budgets
        # (ifeval 1280 / bbh 1024) are below what a thinking pass needs.
        gen_kwargs["max_gen_toks"] = 2048
    args += ["--gen_kwargs", json.dumps(gen_kwargs)]
    return args


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
    args = _suite_args(spec, _base_url(), run.request.model_id, outdir,
                       sample_size, run.request.sampling_profile,
                       bool(getattr(run.request, "enable_thinking", False)))

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
    # U83 (user report: 'stuck on Preparing mmlu (Generating dev split
    # 5/5), no CPU/GPU activity'): while lm-eval downloads/builds a dataset
    # the child prints NOTHING for minutes — the UI froze on the last prep
    # bar and the run looked dead. Silence is now reported: first gap emits
    # 'still alive, quiet for Ns' immediately after _QUIET_S, then a
    # keep-alive every _QUIET_S so the board timestamps the last word.
    _QUIET_S = 30.0
    last_line = time.perf_counter()
    quiet_noted = 0.0
    try:
        while True:
            try:
                line = await asyncio.wait_for(lines.get(), timeout=_QUIET_S)
            except asyncio.TimeoutError:
                if proc.poll() is not None:
                    continue          # dead: the queued sentinel lands next
                silent = time.perf_counter() - last_line
                if silent - quiet_noted >= _QUIET_S:
                    quiet_noted = silent
                    await AB._send_event(run, {
                        "type": "progress", "phase": "prepare",
                        "model_id": run.request.model_id, "benchmark": task,
                        "message": f"Preparing {task} — lm-eval silent "
                                   f"{int(silent)}s (dataset download/build)",
                        "current": suite_index, "total": suite_total,
                        "quiet_s": int(silent)})
                continue
            if line is None:
                break
            last_line = time.perf_counter()
            quiet_noted = 0.0
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
    score, total = _parse_results_json(outdir, spec.get("metric"),
                                       spec.get("metric_contains"),
                                       metrics=spec.get("metrics"))
    if score is None:
        # Honest failure, ACC-2c: a suite whose leaves carry NONE of the
        # declared metrics is MISSING, not zero. Never average what the
        # harness did not score, and never invent a number here.
        names = "/".join(p for p, _c in _suite_metrics(spec)) or "(no metric)"
        raise RuntimeError(f"harness produced no '{names}' score for {task}")
    return {"model_id": run.request.model_id, "external": False,
            "benchmark": task, "accuracy": round(score, 4),
            "thinking_used": bool(getattr(run.request, "enable_thinking", False)),
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
                if upload_blocked(task):
                    # ACC-2b upload gate: a local-only suite's score is
                    # NEVER handed to omlx.ai, even when the user turned
                    # community upload on for the run — the leaderboard has
                    # no column for it. Recorded as a skip (not silence) so
                    # the row and the SSE stream say why; the board renders
                    # any status=='skipped' as '—', same as the opt-out.
                    outcome = {"status": "skipped",
                               "reason": LOCAL_ONLY_UPLOAD_REASON}
                    result_data["upload"] = outcome
                    await AB._send_event(run, {"type": "upload", "data": {
                        "model_id": request.model_id, "benchmark": task,
                        **outcome}})
                    continue
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
        # ACC-2b landmine (grep-verified): classic's Phase-3 loop dispatches
        # on omlx.eval.BENCHMARKS.get(name) and only WARNS on a miss
        # (accuracy_benchmark.py:494 'Unknown benchmark' -> continue). A
        # local-only suite has no classic evaluator, so falling back would
        # 'complete' the run with the extras silently DROPPED (0 suites for
        # an all-extra run) — a green zombie. Runs carrying extras therefore
        # never fall back: the harness failure is reported as the run's own
        # error and the user decides.
        has_extras = any(is_extra(t) for t in request.benchmarks)
        if emitted_any or has_extras:
            # half-scored run (or unrunnable-by-classic run): report the
            # error honestly, NO silent re-run
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
