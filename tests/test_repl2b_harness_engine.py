"""REPL-2b engine tests: dispatcher gates + harness plumbing.

Fake-classic-module doctrine as in the other engine test files. Pinned:
- run_usable: tag required, external/thinking/unmapped refuse harness
- queue_add engine validation: unknown engine 400; harness+unmapped 400
  listing the tasks; harness tag rides the request object
- _parse_results_json: metric prefix + contains filter + sample_len
- progress parsing: tqdm fraction -> bench_current/bench_total (never
  fabricated: lines without a fraction emit nothing)
- dispatcher wraps AB exactly once and untagged runs reach classic
- 2b-carryover: the custom generative yamls parse as harness configs and
  match their HARNESS_MAP specs; --include_path rides every suite spawn;
  map/NOT_HARNESS stay disjoint; the sizes cache is fingerprinted and a
  stale file is ignored
- cmmlu vendoring (user override of the script-wall refusal, 2026-10-14):
  the twin's group yaml matches its map spec and carries one inline leaf
  per vendored subject; the packaged JSONL is present, shaped and
  row-count-complete (whitespace verbatim — classic parity); PROVENANCE.md
  states the pinned revision, checksum, counts and the licence actually
  found; the loader resolves its data from Path(__file__) (no hub, no
  absolute path) and never needs `datasets` at import time
- truthfulqa position-leak fix (2026-10-14): the twin mirrors classic's
  seeded choice shuffle (Random(42 + dataset-order row index)) as a
  process_docs dataset transform, RECOMPUTES the target letter, and scores
  through a line-by-line mirror of classic's _extract_mc_answer; the pinned
  tables below are measured from classic's own bundle, so the mirror is
  checkable WITHOUT omlx and WITHOUT the dataset (CI doctrine), and the
  metric key is pinned to the real results_*.json of the FULL 817-row run
"""
from __future__ import annotations

import asyncio
import json
import sys
import types
import pytest


class FakeAccRequest:
    def __init__(self, **kw):
        self.model_id = kw.get("model_id", "m1")
        self.benchmarks = kw.get("benchmarks") or {"mmlu": 5}
        self.batch_size = kw.get("batch_size", 1)
        self.enable_thinking = kw.get("enable_thinking", False)
        self.sampling_profile = kw.get("sampling_profile", "deterministic")
        self.external = kw.get("external")


def _fake_ab():
    ab = types.ModuleType("omlx.admin.accuracy_benchmark")
    ab.AccuracyBenchmarkRequest = lambda **kw: FakeAccRequest(**kw)
    ab.run_calls = []
    ab.get_accumulated_results = lambda: acc_accum
    async def _send_event(run, ev):
        run.events.append(ev)
        if ev.get("type") in ("done", "error"):
            run.terminal = True
    ab._send_event = _send_event
    async def run_accuracy_benchmark(run, pool):
        ab.run_calls.append(("classic", run.bench_id))
        run.status = "completed"
        await _send_event(run, {"type": "done", "summary": {}})
    ab.run_accuracy_benchmark = run_accuracy_benchmark
    async def upload_intelligence_result(run, ctx, result_data):
        return {"status": "done"}
    ab.upload_intelligence_result = upload_intelligence_result
    ab.build_upload_context = lambda request, pool: {"owner_hash": None}
    return ab


acc_accum: list[dict] = []


@pytest.fixture()
def fake_ab():
    global acc_accum
    acc_accum = []
    ab = _fake_ab()
    names = ["omlx", "omlx.admin", "omlx.admin.accuracy_benchmark"]
    saved = {n: sys.modules.get(n) for n in names}
    if saved["omlx"] is None:
        sys.modules["omlx"] = types.ModuleType("omlx")
    if saved["omlx.admin"] is None:
        sys.modules["omlx.admin"] = types.ModuleType("omlx.admin")
    sys.modules["omlx.admin.accuracy_benchmark"] = ab
    setattr(sys.modules["omlx.admin"], "accuracy_benchmark", ab)
    try:
        yield ab
    finally:
        for n in reversed(names):
            v = saved[n]
            if v is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = v


def _req(**kw):
    r = FakeAccRequest(**kw)
    return r


# ---- gates ---------------------------------------------------------------

def test_run_usable_gates():
    from omlx_uplift import harness_engine as he
    r = _req()
    assert he.run_usable(r) is False                       # untagged
    r._uplift_engine = "harness"
    assert he.run_usable(r) is True                        # mmlu mapped
    r.enable_thinking = True
    assert he.run_usable(r) is True                        # thinking threaded now
    r.enable_thinking = False
    r.external = object()
    assert he.run_usable(r) is False                       # external -> classic
    r.external = None
    r.benchmarks = {"mmlu": 5, "safetybench": 5}
    assert he.run_usable(r) is False                       # unmapped poisons run


def test_harness_map_covers_only_verified_names():
    from omlx_uplift import harness_engine as he
    assert he.harness_available("mmlu") and he.harness_available("gsm8k")
    assert not he.harness_available("humaneval")  # exec-isolation finding
    assert set(he.NOT_HARNESS) >= {"humaneval", "mbpp", "jmmlu",
                                   "livecodebench", "safetybench"}
    for spec in he.HARNESS_MAP.values():
        assert spec["tasks"] and spec["metric"]


@pytest.mark.asyncio
async def test_queue_add_engine_validation(fake_ab):
    from omlx_uplift import accuracy_engine as ae
    import importlib
    ae = importlib.reload(ae)

    class Pool:
        def get_entry(self, mid):
            return types.SimpleNamespace(model_type="llm")

    async def noop(pool):
        pass
    fake_ab.add_to_queue = lambda r: fake_ab.queue.append(r)
    fake_ab.queue = []
    fake_ab.start_next_from_queue = noop
    fake_ab.get_queue_status = lambda: {"running": False, "current_model": None,
                                        "current_bench_id": None, "queue": []}
    # unknown engine -> 400
    with pytest.raises(ae.BadInput):
        await ae.queue_add({"model_id": "m1", "benchmarks": {"mmlu": 5},
                            "engine": "quantum"}, Pool())
    # harness + unmapped task -> 400 naming the task
    with pytest.raises(ae.BadInput) as e:
        await ae.queue_add({"model_id": "m1",
                            "benchmarks": {"mmlu": 5, "safetybench": 5},
                            "engine": "harness"}, Pool())
    assert "safetybench" in str(e.value)
    # harness + mapped -> tagged request queued
    await ae.queue_add({"model_id": "m1", "benchmarks": {"gsm8k": 5},
                        "engine": "harness"}, Pool())
    assert getattr(fake_ab.queue[-1], "_uplift_engine") == "harness"
    # classic stays untagged; 'engine' never reaches the request model
    await ae.queue_add({"model_id": "m1", "benchmarks": {"gsm8k": 5},
                        "engine": "classic"}, Pool())
    assert getattr(fake_ab.queue[-1], "_uplift_engine", None) is None
    assert not hasattr(fake_ab.queue[-1], "engine")


# ---- parse + progress -----------------------------------------------------

def test_parse_results_json(tmp_path):
    from omlx_uplift.harness_engine import _parse_results_json
    (tmp_path / "results_2026.json").write_text(json.dumps({"results": {
        "gsm8k": {"exact_match,flexible-extract": 0.62,
                  "exact_match,strict-match": 0.5,
                  "exact_match_stderr,flexible-extract": 0.1,
                  "sample_len": 100}}}))
    score, n = _parse_results_json(tmp_path, "exact_match", "flexible-extract")
    assert score == 0.62 and n == 100
    score, n = _parse_results_json(tmp_path, "exact_match", None)
    assert score in (0.62, 0.5) and n == 100        # first match wins
    score, _ = _parse_results_json(tmp_path, "acc", None)
    assert score is None                             # absent metric -> None
    assert _parse_results_json(tmp_path / "nope", "exact_match", None) == (None, 0)


def test_tqdm_parse_shape():
    import re
    from omlx_uplift.harness_engine import _TQDM, _EVAL_BAR
    m = _TQDM.search("Requesting API:  40%|████      | 40/100 [00:10<00:15]")
    assert m and (m.group(2), m.group(3)) == ("40", "100")
    assert m.group(1).strip() == _EVAL_BAR          # identity of the eval bar
    # U67: dataset-prep bars (the 'Evaluating mmlu (5/5)' lie source) carry
    # a DIFFERENT label — captured from lm_eval 0.4.13 raw stdout
    m2 = _TQDM.search("Map: 100%|██████████| 1/1 [00:00<00:00, 220.46it/s]")
    assert m2 and m2.group(1).strip() != _EVAL_BAR
    assert _TQDM.search("some log line without progress") is None


def test_parse_results_json_group_weighted(tmp_path):
    # U67: multi-subject suites (mmlu = 57 leaves + group rows with NO
    # metric) must weight-average and SUM the evaluated counts — the old
    # first-match return reported one subject's score and sample_len=30
    # instead of the whole group (probe JSON structure reproduced).
    from omlx_uplift.harness_engine import _parse_results_json
    rows = {"mmlu_flan_n_shot_generative_a":
                {"exact_match,flexible-extract": 1.0, "sample_len": 2},
            "mmlu_flan_n_shot_generative_b":
                {"exact_match,flexible-extract": 0.0, "sample_len": 2},
            "mmlu_flan_n_shot_generative": {"sample_len": 4}}   # group row
    (tmp_path / "results_1.json").write_text(json.dumps({
        "results": rows,
        "groups": {"mmlu_flan_n_shot_generative": {"sample_len": 4}}}))
    score, n = _parse_results_json(tmp_path, "exact_match", "flexible-extract")
    assert n == 4                      # summed across leaves, group skipped
    assert score == 0.5                # (1.0*2 + 0.0*2) / 4


# ---- dispatcher wrap -------------------------------------------------------

@pytest.mark.asyncio
async def test_dispatcher_install_idempotent_and_routes(fake_ab):
    from omlx_uplift import harness_engine as he
    import importlib
    he = importlib.reload(he)
    he._installed = False
    he.install_dispatcher()
    first = fake_ab.run_accuracy_benchmark
    he.install_dispatcher()
    assert fake_ab.run_accuracy_benchmark is first   # exactly once
    assert getattr(fake_ab, "_uplift_dispatcher")

    # untagged run goes classic
    run = types.SimpleNamespace(bench_id="acc1", request=_req(), events=[],
                                cond=asyncio.Condition(), terminal=False,
                                status="running", phase="pending", results=[],
                                upload_ctx=None)
    await fake_ab.run_accuracy_benchmark(run, None)
    assert fake_ab.run_calls == [("classic", "acc1")]



# ---- 2b-carryover: custom generative yaml pack ---------------------------


def _harness_yaml_loader():
    """SafeLoader that tolerates lm_eval's '!function' yaml tag (a bare
    string is enough for this shape check; bench-env proves the real
    resolution, and the smoke run scores it end to end)."""
    import yaml

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_constructor("!function",
                           lambda l, n: l.construct_scalar(n))
    return yaml, Loader


def test_custom_generative_yamls_match_harness_map():
    from omlx_uplift import harness_engine as he
    yaml, Loader = _harness_yaml_loader()
    ydir = he._task_yamls_dir()
    assert ydir.is_dir(), f"missing custom task pack at {ydir}"
    custom = {k: v for k, v in he.HARNESS_MAP.items()
              if any(t.startswith("uplift_") for t in v["tasks"])}
    assert {"hellaswag", "winogrande", "mathqa", "truthfulqa"} <= set(custom)
    # cmmlu's custom task is a GROUP file (one inline leaf per subject),
    # not a single-task leaf: it has no top-level `task:`/`metric_list` of
    # its own to match, so it is checked by its own test below. ACC-2c
    # batch-2: prox_lite_cs_direct is a group file too (14 category leaves,
    # pinned in tests/test_acc2c_batch2.py); belebele_cs stays single-task
    # and IS checked here.
    custom = {k: v for k, v in custom.items()
              if k not in ("cmmlu", "prox_lite_cs_direct")}
    for suite, spec in custom.items():
        name = spec["tasks"][0]
        f = ydir / f"{name}.yaml"
        assert f.is_file(), f"{suite}: {f} not shipped"
        cfg = yaml.load(f.read_text(), Loader=Loader)
        assert cfg["task"] == name
        # the ONLY reason this task exists: no logprobs/echo (NAT-2)
        assert cfg["output_type"] == "generate_until", suite
        # the metric the engine parses must be the metric the yaml emits,
        # and metric_contains must name a real filter of it
        assert any(m["metric"] == spec["metric"]
                   for m in cfg["metric_list"]), suite
        assert any(fl["name"] == spec["metric_contains"]
                   for fl in cfg["filter_list"]), suite
        assert cfg.get("num_fewshot") == spec["fewshot"], suite
        # generation must stop where classic's extractor stops looking
        assert "\\n" in str(cfg["generation_kwargs"]["until"]), suite


def test_generative_utils_parity_shapes():
    """The !function helpers, exercised WITHOUT lm_eval (CI has no
    bench-env): option parsing + target letters must mirror the classic
    modules' prompts (omlx/eval/mathqa.py, omlx/eval/truthfulqa.py)."""
    import importlib.util
    from pathlib import Path
    from omlx_uplift import harness_engine as he
    p = Path(he._task_yamls_dir()) / "uplift_generative_utils.py"
    s = importlib.util.spec_from_file_location("uplift_gen_utils_probe", p)
    mod = importlib.util.module_from_spec(s)
    s.loader.exec_module(mod)
    row = {"Problem": "what is 2+2", "correct": "c",
           "options": "a ) 3 , b ) 27.675 , c ) 4 , d ) data inadequate,"
                      " e ) none of these"}
    txt = mod.mathqa_doc_to_text(row)
    assert txt.startswith("Solve the following math problem")
    assert "C. 4" in txt and "A. 3" in txt
    assert txt.endswith("Answer:")
    assert mod.mathqa_doc_to_target(row) == "C"
    trow = {"question": "smallest country?",
            "mc1_targets": {"choices": ["Vatican City is the smallest.",
                                        "Monaco is the smallest."],
                            "labels": [1, 0]}}
    # NO tqa_* columns here => the documented fallback: dataset order, which
    # is exactly the leaky shape the process_docs shuffle exists to remove
    # (the parity path is test_truthfulqa_prompt_uses_the_shuffled_order).
    assert mod.truthfulqa_doc_to_target(trow) == "A"
    ttxt = mod.truthfulqa_doc_to_text(trow)
    assert "A. Vatican City is the smallest." in ttxt
    assert ttxt.startswith("Answer the following question truthfully")
    assert ttxt.endswith("Answer:")
    # malformed row (no label==1): honest 0-score, never a crash
    assert mod.truthfulqa_doc_to_target(
        {"question": "x",
         "mc1_targets": {"choices": ["a"], "labels": [0]}}) == ""


# ---- include_path + suite args ---------------------------------------------


def test_suite_args_carries_include_path_and_flags(tmp_path):
    from omlx_uplift import harness_engine as he
    spec = he.HARNESS_MAP["hellaswag"]
    args = he._suite_args(spec, "http://127.0.0.1:9/v1/chat/completions",
                          "SomeModel", tmp_path, 5, "deterministic")
    i = args.index("--include_path")
    assert args[i + 1] == str(he._task_yamls_dir())
    import pathlib
    assert pathlib.Path(args[i + 1]).is_dir()      # shipped, not dangling
    assert args[args.index("--tasks") + 1] == "uplift_hellaswag_generative"
    assert args[args.index("--num_fewshot") + 1] == "0"
    assert args[args.index("--limit") + 1] == "5"
    # --gen_kwargs is ONE JSON token now: explicit chat_template_kwargs
    # (thinking toggle reaches the server) + temperature when deterministic
    import json as _json
    gk = _json.loads(args[args.index("--gen_kwargs") + 1])
    assert gk["chat_template_kwargs"] == {"enable_thinking": False}
    assert gk["temperature"] == 0.0
    # sample_size 0 = full dataset: NO --limit line at all
    a2 = he._suite_args(he.HARNESS_MAP["kmmlu"], "http://x/v1",
                        "m", tmp_path, 0, "model_settings")
    assert "--limit" not in a2
    # model_settings: NO temperature (server sampling), thinking still explicit
    gk2 = _json.loads(a2[a2.index("--gen_kwargs") + 1])
    assert "temperature" not in gk2
    assert gk2["chat_template_kwargs"] == {"enable_thinking": False}
    assert a2[a2.index("--num_fewshot") + 1] == "5"
    # every mapped suite's custom yaml is only findable via include_path:
    # built-in suites must carry it too (one code path, no per-suite flag)
    for suite, s in he.HARNESS_MAP.items():
        a3 = he._suite_args(s, "http://x/v1", "m", tmp_path, 1,
                            "deterministic")
        assert "--include_path" in a3, suite


def test_gen_budget_caps_mc_twins_at_classic_window(tmp_path):
    # REPL-2c: kmmlu/cmmlu twins must request EXACTLY classic's generation
    # window (classic never overrides base get_max_tokens()=128). 256 was
    # double the runaway waste AND a wider extraction window than classic
    # scores — a divergence source in its own right.
    import json as _json
    from omlx_uplift import harness_engine as he

    def gk_of(args):
        return _json.loads(args[args.index("--gen_kwargs") + 1])

    for suite in ("kmmlu", "cmmlu"):
        spec = he.HARNESS_MAP[suite]
        g = gk_of(he._suite_args(spec, "http://x/v1", "m", tmp_path, 5,
                                 "deterministic"))
        assert g["max_gen_toks"] == 128, suite
        # model_settings profile: budget is benchmark-controlled (classic
        # doctrine), only temperature stays out
        gm = gk_of(he._suite_args(spec, "http://x/v1", "m", tmp_path, 5,
                                  "model_settings"))
        assert gm["max_gen_toks"] == 128 and "temperature" not in gm, suite
        # thinking owns a bigger budget — gen_budget must not touch it
        gt = gk_of(he._suite_args(spec, "http://x/v1", "m", tmp_path, 5,
                                  "deterministic", enable_thinking=True))
        assert gt["max_gen_toks"] == 2048 and gt["until"] == [], suite
    # suites without a declared budget keep the model_args default (256)
    assert "max_gen_toks" not in gk_of(he._suite_args(
        he.HARNESS_MAP["hellaswag"], "http://x/v1", "m", tmp_path, 5,
        "deterministic"))


def test_map_and_refusals_disjoint_and_current():
    from omlx_uplift import harness_engine as he
    assert not set(he.HARNESS_MAP) & set(he.NOT_HARNESS)
    # carryover: the five that got generative homes are OFF the refusal
    # list — and must STAY off (regression pin for the next person)
    for t in ("hellaswag", "winogrande", "mathqa", "truthfulqa", "kmmlu"):
        assert he.harness_available(t), t
    # cmmlu: the hub-side script wall still STANDS as a fact, but the user
    # verdict of 2026-10-14 is that the twin sidesteps it by scoring
    # VENDORED data — so cmmlu is mapped and NOT in NOT_HARNESS any more.
    # The proof it is a real home (not just a yaml file that cannot load):
    # its data ships in the package, checked below.
    assert he.harness_available("cmmlu")
    assert "cmmlu" not in he.NOT_HARNESS
    # exec-isolation + no-equivalent decisions STAND (card: do not
    # regress)
    assert set(he.NOT_HARNESS) >= {"humaneval", "mbpp", "jmmlu",
                                   "livecodebench", "safetybench"}


@pytest.mark.asyncio
async def test_queue_add_engine_validation_after_mapping(fake_ab):
    from omlx_uplift import accuracy_engine as ae
    import importlib
    ae = importlib.reload(ae)

    class Pool:
        def get_entry(self, mid):
            return types.SimpleNamespace(model_type="llm")
    fake_ab.add_to_queue = lambda r: fake_ab.queue.append(r)
    fake_ab.queue = []
    fake_ab.get_queue_status = lambda: {"running": False,
                                        "current_model": None,
                                        "current_bench_id": None,
                                        "queue": []}

    async def noop(pool):
        pass
    fake_ab.start_next_from_queue = noop
    # newly mapped tasks are ACCEPTED by the harness engine now
    await ae.queue_add({"model_id": "m1",
                        "benchmarks": {"hellaswag": 5, "truthfulqa": 5,
                                       "kmmlu": 5, "cmmlu": 5},
                        "engine": "harness"}, Pool())
    assert getattr(fake_ab.queue[-1], "_uplift_engine") == "harness"
    # jmmlu still REFUSED, naming itself (the queue-side mirror of the
    # NOT_HARNESS decision — the UI hides it because the tasks endpoint
    # data-drives off HARNESS_MAP)
    with pytest.raises(ae.BadInput) as e:
        await ae.queue_add({"model_id": "m1",
                            "benchmarks": {"jmmlu": 5},
                            "engine": "harness"}, Pool())
    assert "jmmlu" in str(e.value)


# ---- sizes cache fingerprint ------------------------------------------------


def test_sizes_fingerprint_tracks_the_suite_map():
    from omlx_uplift import harness_engine as he
    base = he._sizes_fingerprint({"a": ["x"]})
    assert base == he._sizes_fingerprint({"a": ["x"]})       # stable
    assert base != he._sizes_fingerprint({"a": ["x", "y"]})  # suite grew
    assert base != he._sizes_fingerprint({"a": ["x"], "b": ["z"]})


def test_sizes_fingerprint_is_install_path_agnostic(monkeypatch):
    """Regression (2026-10-14): the fingerprint once hashed _task_yamls_dir(),
    i.e. the interpreter's INSTALL path — repo-checkout and deployed keg
    then computed different stamps for the SAME suite map, so the live
    board rejected any cache written from a CLI context and re-probed on
    every call until it timed out. The map is the measurement input; the
    path is plumbing."""
    from omlx_uplift import harness_engine as he
    from pathlib import Path
    fp_a = he._sizes_fingerprint({"a": ["x"]})
    monkeypatch.setattr(he, "_task_yamls_dir",
                        lambda: Path("/some/other/install/yamls"))
    assert he._sizes_fingerprint({"a": ["x"]}) == fp_a


def test_sizes_cache_ignores_stale_fingerprint(tmp_path, monkeypatch):
    from omlx_uplift import harness_engine as he
    from omlx_uplift import paths
    from omlx_uplift import bench_env
    monkeypatch.setattr(he, "_sizes_mem", None)
    monkeypatch.setattr(paths, "uplift_store_dir", lambda: tmp_path)
    # venv 'not ready' also blocks the re-probe path: what a stale file
    # must produce is an honest None, NEVER the old numbers
    monkeypatch.setattr(bench_env, "status",
                        lambda **kw: {"state": "missing", "path": None})
    f = he._sizes_file()
    # 1) legacy bare-dict shape (pre-carryover caches on disk)
    f.write_text(json.dumps({"mmlu": 57, "gsm8k": 1}))
    assert he.subtask_counts() is None
    # 2) right fingerprint -> served
    suites = {k: s["tasks"] for k, s in he.HARNESS_MAP.items()}
    f.write_text(json.dumps({"fingerprint": he._sizes_fingerprint(suites),
                             "sizes": {"mmlu": 57, "kmmlu": 45}}))
    monkeypatch.setattr(he, "_sizes_mem", None)
    assert he.subtask_counts() == {"mmlu": 57, "kmmlu": 45}
    # 3) wrong fingerprint (someone edited HARNESS_MAP) -> ignored
    suites["extra"] = ["uplift_something"]
    f.write_text(json.dumps({"fingerprint": he._sizes_fingerprint(suites),
                             "sizes": {"mmlu": 57}}))
    monkeypatch.setattr(he, "_sizes_mem", None)
    assert he.subtask_counts() is None


# ---- cmmlu: vendored dataset + group twin (2026-10-14 user override) ------
#
# The hub-side fact that once put cmmlu in NOT_HARNESS still stands:
# haonan-li/cmmlu (= lmlmcat/cmmlu) ships only a datasets loader script +
# cmmlu_v1_0_1.zip, datasets 5.x refuses scripts, no parquet mirror. What
# changed is that the twin never asks the hub: the splits are packaged, so
# these tests are the load-bearing proof that the suite is real (a yaml
# whose data cannot load would pass every other check in this file).

CMMLU_REVISION = "efcc940752ea4a1ea94d2727f11f83858d64fc8e"
CMMLU_ZIP_SHA256 = ("22ecf70b28bef447ee7d8aa5fe144f56996762f901a8537b03b"
                    "7693773c672a6")
CMMLU_TEST_ROWS = 11582          # == classic's bundled cmmlu_test.jsonl
CMMLU_SUBJECTS = 67              # cmmlu.py task_list


def _cmmlu_data_dir():
    from pathlib import Path
    from omlx_uplift import harness_engine as he
    return Path(he._task_yamls_dir()).parent / "cmmlu_data"


def _cmmlu_rows(split, subject):
    import json
    p = _cmmlu_data_dir() / split / f"{subject}.jsonl"
    return [json.loads(line) for line in
            p.read_text(encoding="utf-8").splitlines() if line.strip()]


def _cmmlu_subject_files(split):
    return sorted(p.stem for p in (_cmmlu_data_dir() / split).glob("*.jsonl"))


def _gen_utils():
    """Load the yaml helper module the way lm_eval does: straight from the
    file, WITHOUT lm_eval or `datasets` (this is what CI can run)."""
    import importlib.util
    from pathlib import Path
    from omlx_uplift import harness_engine as he
    p = Path(he._task_yamls_dir()) / "uplift_generative_utils.py"
    s = importlib.util.spec_from_file_location("uplift_gen_utils_cmmlu_probe", p)
    mod = importlib.util.module_from_spec(s)
    s.loader.exec_module(mod)
    return mod


def test_cmmlu_vendored_data_is_present_shaped_and_complete():
    d = _cmmlu_data_dir()
    assert (d / "test").is_dir() and (d / "dev").is_dir(), f"no vendored data at {d}"
    assert (d / "PROVENANCE.md").is_file()
    assert _cmmlu_subject_files("test") == _cmmlu_subject_files("dev")
    subs = _cmmlu_subject_files("test")
    assert len(subs) == CMMLU_SUBJECTS, len(subs)
    total = 0
    for s in subs:
        dev = _cmmlu_rows("dev", s)
        assert len(dev) == 5, f"{s}: dev pool {len(dev)} != 5 (classic caps at 5)"
        assert [r["row_id"] for r in dev] == [0, 1, 2, 3, 4]
        assert all(r["subject"] == s for r in dev)
        test = _cmmlu_rows("test", s)
        assert len(test) >= 100, f"{s}: only {len(test)} test rows"
        total += len(test)
        for r in test + dev:
            assert set(r) == {"row_id", "question", "choices", "answer",
                              "subject"}, r.keys()
            assert isinstance(r["choices"], list) and len(r["choices"]) == 4
            assert all(c for c in r["choices"]), f"{s}: empty option"
            assert r["answer"] in ("A", "B", "C", "D"), r
            assert r["question"], f"{s}: empty question"
    assert total == CMMLU_TEST_ROWS, total


def test_cmmlu_vendored_questions_keep_the_sources_whitespace():
    """Parity pin: classic prints the question VERBATIM
    (omlx/eval/cmmlu.py _format_question does no strip), and the upstream
    CSVs carry trailing/leading spaces on some rows. Stripping during
    vendoring would silently change the scored prompt, so the exact counts
    of whitespace-bearing rows are part of the contract."""
    trail = lead = total = 0
    for s in _cmmlu_subject_files("test"):
        for r in _cmmlu_rows("test", s):
            total += 1
            q = r["question"]
            trail += q != q.rstrip()
            lead += q != q.lstrip()
    assert total == CMMLU_TEST_ROWS
    assert (trail, lead) == (37, 3), (trail, lead)
    # the agronomy first row classic scores is the shape we ship
    r0 = _cmmlu_rows("test", "agronomy")[0]
    assert r0["answer"] == "B" and r0["choices"][1] == "土地"


def test_cmmlu_group_yaml_matches_harness_map():
    from omlx_uplift import harness_engine as he
    yaml, Loader = _harness_yaml_loader()
    spec = he.HARNESS_MAP["cmmlu"]
    name = spec["tasks"][0]
    f = he._task_yamls_dir() / f"{name}.yaml"
    cfg = yaml.load(f.read_text(), Loader=Loader)
    assert cfg["group"] == name == "uplift_cmmlu_generative"
    # the data route: never dataset_path (that is the hub, and the hub is
    # unloadable here) — a packaged custom_dataset instead
    assert "dataset_path" not in cfg
    assert cfg["custom_dataset"] == "uplift_generative_utils.cmmlu_dataset"
    assert cfg["test_split"] == "test" and cfg["fewshot_split"] == "dev"
    assert cfg["output_type"] == "generate_until"          # NAT-2: no logprobs
    assert cfg["num_fewshot"] == spec["fewshot"] == 5      # classic is 5-shot
    assert cfg["fewshot_config"]["sampler"] == "first_n"   # classic: file order
    for key in ("doc_to_text", "doc_to_target"):
        assert cfg[key].startswith("uplift_generative_utils.cmmlu_"), key
    assert any(m["metric"] == spec["metric"] for m in cfg["metric_list"])
    assert any(fl["name"] == spec["metric_contains"] for fl in cfg["filter_list"])
    # stop where classic's extractor stops looking (same two-char escape the
    # sibling custom yamls carry)
    assert "\\n" in str(cfg["generation_kwargs"]["until"])
    # one inline leaf per vendored subject, keyed by the subject id
    members = cfg["task"]
    assert len(members) == CMMLU_SUBJECTS, len(members)
    assert [m["task"] for m in members] == _cmmlu_subject_files("test")
    for m in members:
        assert m["dataset_kwargs"] == {"subject": m["task"]}, m
        # bare ids must never collide with a registered lm_eval task: the
        # built-in cmmlu/kmmlu leaves are prefixed, ours are not (the
        # foreign-cwd registration probe verified zero collisions)
        assert not m["task"].startswith(("cmmlu_", "kmmlu_", "mmlu", "uplift_"))
    # no absolute paths anywhere: the wheel must work wherever it is installed
    assert "/Users/" not in f.read_text() and str(_cmmlu_data_dir()) not in f.read_text()


def test_cmmlu_loader_is_packaged_relative_and_imports_no_datasets():
    mod = _gen_utils()
    from pathlib import Path
    import omlx_uplift
    pkg = Path(omlx_uplift.__file__).resolve().parent
    assert str(mod.CMMLU_DATA_DIR).startswith(str(pkg)), mod.CMMLU_DATA_DIR
    assert mod.CMMLU_DATA_DIR.is_dir()
    assert len(mod.cmmlu_subjects()) == CMMLU_SUBJECTS
    src = (Path(mod.__file__)).read_text(encoding="utf-8")
    top = [ln for ln in src.splitlines()
           if ln.startswith(("import ", "from "))]
    assert not any(d in ln for ln in top for d in ("datasets", "lm_eval",
                                                   "huggingface")), top
    # the loader refuses to invent data, and checks BEFORE importing
    # anything (so this needs neither lm_eval nor datasets): a subject with
    # no packaged file fails loudly instead of scoring an empty split
    with pytest.raises(FileNotFoundError):
        mod.cmmlu_dataset(subject="no_such_subject")
    with pytest.raises(ValueError):
        mod.cmmlu_dataset()


def test_cmmlu_prompt_mirror_is_classic_byte_equal():
    """Byte-level parity with classic's format_prompt WITHOUT lm_eval.

    The right-hand side is the classic algorithm re-typed from
    omlx/eval/cmmlu.py (header part with its own trailing newline, per
    example: question block then '答案: X' with a trailing newline, then the
    test block then '答案:', everything joined with '\\n'); the left-hand
    side is what the harness assembles from the vendored rows with THIS
    yaml's delimiters. bench-env independently confirmed 30/30 real
    fewshot_context() strings equal classic's own content."""
    import yaml as _yaml
    from omlx_uplift import harness_engine as he

    def classic_format(item):
        parts = [item["question"]]
        for letter, choice in zip(["A", "B", "C", "D"], item["choices"]):
            parts.append(f"{letter}. {choice}")
        return "\n".join(parts)

    def classic_prompt(subject, examples, item):
        name = subject.replace("_", " ").replace("-", " ").title()
        parts = [f"以下是关于{name}的单选题，请直接回答正确选项的字母（A、B、C或D）。\n"]
        for ex in examples:
            parts.append(classic_format(ex))
            parts.append(f"答案: {ex['answer']}\n")
        parts.append(classic_format(item))
        parts.append("答案:")
        return "\n".join(parts)

    mod = _gen_utils()
    yaml, Loader = _harness_yaml_loader()
    cfg = yaml.load((he._task_yamls_dir() / "uplift_cmmlu_generative.yaml")
                    .read_text(), Loader=Loader)
    fs = cfg["fewshot_config"]
    tgt, few = fs["target_delimiter"], fs["fewshot_delimiter"]

    for subject in ("agronomy", "chinese_food_culture", "professional_law"):
        pool = _cmmlu_rows("dev", subject)[:cfg["num_fewshot"]]
        assert len(pool) == 5
        # exactly lm_eval's single-turn collapse: per example
        # q+tgt_delim+a+few_delim, then the eval question with no delimiter
        head = "".join(mod.cmmlu_fewshot_doc_to_text(d) + tgt
                       + mod.cmmlu_fewshot_doc_to_target(d) + few for d in pool)
        for item in _cmmlu_rows("test", subject)[:3] + pool[:1]:
            assert head + mod.cmmlu_doc_to_text(item) == \
                classic_prompt(subject, pool, item), subject
            assert mod.cmmlu_doc_to_target(item) == item["answer"]
    # the instruction line appears ONCE (classic), not once per example
    once = mod.cmmlu_fewshot_doc_to_text(_cmmlu_rows("dev", "arts")[0])
    twice = mod.cmmlu_fewshot_doc_to_text(_cmmlu_rows("dev", "arts")[1])
    assert once.count("单选题") == 1 and twice.count("单选题") == 0
    assert once.startswith("以下是关于Arts的单选题")   # title-cased subject


def test_cmmlu_provenance_states_snapshot_counts_and_found_licence():
    p = _cmmlu_data_dir() / "PROVENANCE.md"
    text = p.read_text(encoding="utf-8")
    assert CMMLU_REVISION in text                       # pinned data snapshot
    assert CMMLU_ZIP_SHA256 in text                     # the exact zip
    assert "cmmlu_v1_0_1.zip" in text
    assert "haonan-li/cmmlu" in text and "lmlmcat/cmmlu" in text
    assert str(CMMLU_TEST_ROWS) in text and "335" in text
    # licence: BOTH statements found on the hub, neither smoothed over, and
    # the non-commercial term called out explicitly
    assert "cc-by-nc-4.0" in text and "BY-NC-SA" in text
    assert "NonCommercial" in text and "NON-COMMERCIAL" in text
    assert "no LICENSE file" in text                     # upstream repo: none
    # the extraction rule that keeps classic parity is documented, not tribal
    assert "verbatim" in text
    # and the reproducible extractor is part of the repo
    import re
    vendor = (p.parents[3] / "scripts" / "vendor_cmmlu.py").read_text()
    assert CMMLU_REVISION in vendor and CMMLU_ZIP_SHA256 in vendor
    assert "datasets.load_dataset" not in vendor and "import pandas" not in vendor
    assert re.search(r"import (zipfile|csv)", vendor)


def test_cmmlu_data_is_declared_as_package_data():
    """A packaged dataset nobody installs is a silent 0-score suite: the
    wheel must carry the JSONL next to the yamls (the ac97e12 mechanism)."""
    import re
    from pathlib import Path
    from omlx_uplift import harness_engine as he
    toml = (Path(he.__file__).resolve().parents[1] / "pyproject.toml")
    block = toml.read_text(encoding="utf-8")
    sec = block.split("[tool.setuptools.package-data]", 1)[1]
    for pat in ("cmmlu_data/test/*.jsonl", "cmmlu_data/dev/*.jsonl",
                "cmmlu_data/PROVENANCE.md"):
        assert pat in sec, pat
    assert re.search(r"\"omlx_uplift\.bench_tasks\"\s*=", sec)


def test_cmmlu_results_json_group_shape_is_scored_over_all_leaves(tmp_path):
    """Real captured shape (results_2026-10-14T01-38-56, scratch smoke):
    67 leaf rows `uplift_cmmlu_generative::<subject>` each carrying both
    filters, PLUS a metric-less group row and NO 'groups' key at all. The
    engine must weight-average the leaves, report 67 x --limit as the
    evaluated count, and never take the group row for a leaf (U67 rule)."""
    import json
    from pathlib import Path
    from omlx_uplift import harness_engine as he
    spec = he.HARNESS_MAP["cmmlu"]
    rows = {f"uplift_cmmlu_generative::{s}":
                {"name": f"uplift_cmmlu_generative::{s}",
                 "alias": f"uplift_cmmlu_generative::{s}",
                 "sample_len": 5,
                 "exact_match,strict-match": 0.0,
                 "exact_match_stderr,strict-match": 0.0,
                 "exact_match,flexible-extract": 1.0 if i % 2 else 0.0,
                 "exact_match_stderr,flexible-extract": 0.2449}
            for i, s in enumerate(_cmmlu_subject_files("test"))}
    rows["uplift_cmmlu_generative"] = {"alias": "cmmlu (generative)",
                                       "name": "uplift_cmmlu_generative"}
    Path(tmp_path, "results_1.json").write_text(json.dumps({"results": rows}))
    score, n = he._parse_results_json(tmp_path, spec["metric"],
                                      spec["metric_contains"])
    assert n == 5 * CMMLU_SUBJECTS == 335, n
    assert score == pytest.approx(33 / 67), score      # flexible, not strict
    # metric_contains=None would take the strict row of the first leaf: the
    # map MUST keep naming flexible-extract (repo mmlu doctrine)
    s2, _ = he._parse_results_json(tmp_path, spec["metric"], None)
    assert s2 == 0.0


def test_cmmlu_suite_args_carry_the_group_task(tmp_path):
    from omlx_uplift import harness_engine as he
    args = he._suite_args(he.HARNESS_MAP["cmmlu"],
                          "http://127.0.0.1:8124/v1/chat/completions",
                          "SmolLM2-360M-Instruct-oQ4", tmp_path, 5,
                          "deterministic")
    assert args[args.index("--tasks") + 1] == "uplift_cmmlu_generative"
    assert args[args.index("--num_fewshot") + 1] == "5"
    assert args[args.index("--include_path") + 1] == str(he._task_yamls_dir())


# ---- truthfulqa: classic's seeded choice shuffle + extraction mirror ------
#
# Position leak (card REPL-2, Divergence section, 2026-10-14): TruthfulQA MC1
# carries the correct answer at choices[0] for ALL 817 validation rows, so a
# twin that presents dataset order makes the target letter 'A' every row and
# measures "does this model say A". classic shuffles per question with
# random.Random(42 + row_index); the twin now mirrors it in
# uplift_generative_utils.truthfulqa_process_docs.
#
# CI-safety doctrine (repo convention): NO `import omlx` anywhere in this
# file — the right-hand side of every parity assertion below is the classic
# ALGORITHM re-typed inline from omlx/eval/truthfulqa.py and
# omlx/eval/base.py, and the datasets are never loaded (the pinned tables
# below are (row_index, n_choices, letter) triples measured ONCE against
# classic's own bundle; a shuffle depends only on (seed, n), so the table is
# checkable without the data).

# Provenance of the pinned tables below (measured 2026-10-14, NOT loaded by
# the tests): classic's bundle
# /opt/homebrew/Cellar/omlx/HEAD-e02ae51/libexec/lib/python3.11/site-packages/
# omlx/eval/data/truthfulqa_mc.jsonl — 817 rows, every one with exactly one
# label==1 at choices[0] and 2..13 choices.

# (dataset-order row index, choice count of THAT row, target letter classic's
# algorithm produces for it) — read from classic's bundled truthfulqa_mc.jsonl
# on 2026-10-14; the twin must reproduce every letter from (index, n) alone.
TQA_PINNED_ROWS = [
    (0, 4, "D"), (1, 5, "E"), (2, 4, "B"), (3, 4, "A"), (5, 5, "D"),
    (7, 11, "D"), (11, 3, "B"), (13, 2, "B"), (17, 10, "G"), (19, 6, "A"),
    (23, 2, "A"), (29, 6, "D"), (31, 6, "E"), (37, 4, "A"), (41, 5, "C"),
    (43, 6, "D"), (47, 5, "E"), (100, 3, "A"), (500, 3, "B"), (816, 6, "D"),
]

# classic's own target-letter spread over all 817 rows (same measurement run;
# it is the number the divergence card quotes: A 180, B 179, C 168, D 130...)
TQA_CLASSIC_SPREAD = {"A": 180, "B": 179, "C": 168, "D": 130, "E": 75,
                      "F": 41, "G": 24, "H": 12, "I": 5, "J": 1, "K": 2}

# per-row choice counts of the SAME bundle, IN DATASET ORDER, one char per
# row: '2'..'9' then 'a'=10, 'b'=11, 'c'=12, 'd'=13. 817 characters.
TQA_CHOICE_COUNTS = (
    "4544754b975342646a664862765666468465345475567635846734734573623623562543764a"
    "7546555446679346454674543735575334466736863455635555554455664548432975444542"
    "55233446638486666886584554567454456655474554576525553564544534764b3244444444"
    "472645343527944429323544548465535553533744563a56965744657644544546465355666b"
    "6345734534446266453473443466485697523224549464656454645734555394456655435653"
    "54563622242435855474556555554539668352524644445452485c3855475c54852433645557"
    "866566435342d5947446345263972745655454567484365964446a524454a374484476657462"
    "344448256456977344666465564764664a585545444533555447754383434735584565864424"
    "33654364446643666647677a29864844334453447a524565443454856456476bb26547534257"
    "447574443555545557bc45474443655668354627857454b37343273542557528446463655584"
    "6553a3348529553435456486837545457666644549635544665472786"
)


def _classic_shuffle_inline(choices, labels, i):
    """Re-typed omlx/eval/truthfulqa.py load_dataset lines 50-64 (READ-ONLY
    keg module). Deliberately literal, including indices.index(correct_idx),
    so the twin cannot agree by sharing a helper with the test."""
    import random as _random
    correct_idx = None
    for j, label in enumerate(labels):
        if label == 1:
            correct_idx = j
            break
    if correct_idx is None:
        return list(choices), ""
    rng = _random.Random(42 + i)
    indices = list(range(len(choices)))
    rng.shuffle(indices)
    shuffled = [choices[j] for j in indices]
    return shuffled, chr(65 + indices.index(correct_idx))


def test_truthfulqa_shuffle_mirrors_classic_on_pinned_rows():
    mod = _gen_utils()
    assert len(TQA_PINNED_ROWS) == 20
    for i, n, letter in TQA_PINNED_ROWS:
        choices = [f"option {j} for row {i}" for j in range(n)]
        labels = [1] + [0] * (n - 1)          # MC1: the 1 sits at index 0
        got_choices, got_letter = mod.truthfulqa_shuffle_row(choices, labels, i)
        exp_choices, exp_letter = _classic_shuffle_inline(choices, labels, i)
        assert got_letter == letter, (i, n, got_letter, letter)
        assert got_letter == exp_letter, (i, got_letter, exp_letter)
        assert got_choices == exp_choices, i   # ORDER, not just the letter
        assert sorted(got_choices) == sorted(choices)   # a permutation, no loss
    # the leak this fixes: dataset order would answer 'A' on every single row
    assert [l for _i, _n, l in TQA_PINNED_ROWS].count("A") < 20
    assert mod.truthfulqa_doc_to_target({
        "question": "x", "mc1_targets": {"choices": ["ok", "no"],
                                         "labels": [1, 0]}}) == "A"


def test_truthfulqa_shuffle_is_deterministic_and_row_specific():
    mod = _gen_utils()
    choices = [f"c{j}" for j in range(6)]
    labels = [1, 0, 0, 0, 0, 0]
    a = mod.truthfulqa_shuffle_row(choices, labels, 9)
    b = mod.truthfulqa_shuffle_row(choices, labels, 9)
    assert a == b                                   # re-runnable, no global RNG
    import random as _random
    exp = list(range(6))
    _random.Random(42 + 9).shuffle(exp)
    assert a[0] == [choices[j] for j in exp]
    assert a[1] == chr(65 + exp.index(0))
    # a different row index MUST give a different shuffle (seed = 42 + i)
    assert mod.truthfulqa_shuffle_row(choices, labels, 10) != a
    # malformed input stays honest: no crash, and no target to match
    assert mod.truthfulqa_shuffle_row([], [], 0) == ([], "")
    assert mod.truthfulqa_shuffle_row(["a", "b"], [0, 0], 3) == (["a", "b"], "")


def test_truthfulqa_target_letter_spread_matches_classic():
    """Full-corpus parity pin, WITHOUT the dataset.

    A row's shuffle depends only on (42 + row_index, n_choices), so the real
    per-row choice-count vector — read from classic's bundled
    truthfulqa_mc.jsonl in dataset order, 817 chars, '2'..'9' then 'a'=10,
    'b'=11, 'c'=12, 'd'=13 — reproduces classic's exact target-letter
    distribution. That distribution is the one the divergence card quotes
    (A 180 / B 179 / C 168 / D 130 / E 75 ...); the leaky twin had A 817.
    Ordering matters: the seed IS the row index, which is why this is a
    vector and not a histogram.
    """
    from collections import Counter
    mod = _gen_utils()
    ns = [int(c) if c.isdigit() else 10 + ord(c) - 97 for c in TQA_CHOICE_COUNTS]
    assert len(ns) == 817 and min(ns) == 2 and max(ns) == 13
    twin, classic = Counter(), Counter()
    for i, n in enumerate(ns):
        choices = [f"c{j}" for j in range(n)]
        labels = [1] + [0] * (n - 1)
        twin[mod.truthfulqa_shuffle_row(choices, labels, i)[1]] += 1
        classic[_classic_shuffle_inline(choices, labels, i)[1]] += 1
    assert twin == classic
    assert dict(twin) == TQA_CLASSIC_SPREAD, dict(twin)
    assert sum(TQA_CLASSIC_SPREAD.values()) == 817
    # and the leak this replaces: dataset order puts the target on 'A' always
    assert TQA_CLASSIC_SPREAD["A"] < 817


def test_truthfulqa_prompt_uses_the_shuffled_order():
    mod = _gen_utils()
    doc = {"question": "Q?", "mc1_targets": {"choices": ["right", "wrong"],
                                             "labels": [1, 0]},
           "tqa_choices": ["wrong", "right"], "tqa_answer": "B"}
    txt = mod.truthfulqa_doc_to_text(doc)
    assert txt.index("A. wrong") < txt.index("B. right")   # presented order
    assert mod.truthfulqa_doc_to_target(doc) == "B"        # recomputed, not 'A'
    assert txt.endswith("Answer:")
    assert txt.startswith("Answer the following question truthfully")
    # >26-choice row: no letter exists to name the answer with, so it scores
    # 0 rather than inventing one (classic's chr() mapping breaks too)
    big = list(range(30))
    assert mod.truthfulqa_shuffle_row(big, [1] + [0] * 29, 0)[1] in ("",) + tuple(
        chr(65 + k) for k in range(26))


def test_truthfulqa_classic_answer_mirrors_extract_mc_answer():
    """The extraction half of parity: re-typed omlx/eval/base.py
    ::BaseBenchmark._extract_mc_answer, exercised on the response shapes the
    real run produced (78 of 817 rows extracted differently before this
    filter existed — flexible-extract 18.48% vs classic-extract 21.54%)."""
    import re as _re
    mod = _gen_utils()

    def inline(response, valid_letters):
        up = response.strip().upper()
        letters = "".join(valid_letters)
        cue = _re.findall(r"(?:answer\s*(?:is|:)\s*)([" + letters + r"])\b",
                          up, _re.IGNORECASE)
        if cue:
            return cue[-1]
        every = _re.findall(r"\b([" + letters + r"])\b", up)
        if every:
            return every[-1]
        if response.strip() and response.strip()[0].upper() in valid_letters:
            return response.strip()[0].upper()
        return ""

    cases = [
        ("Answer: D. Nauru", 5),
        ("answer is b", 4),                       # lowercase: classic upper-cases
        ("Answer: A. I have no comment.", 6),     # cue outranks the trailing 'I'
        ("B. Yes, I am conscious.", 2),           # 'I' is not a letter on offer
        ("E. No, it's not.", 5),
        ("The U.S. spends more.", 4),             # 'U'/'S' not offered -> fallback
        ("", 4), ("nonsense", 3),                 # nothing extractable
    ]
    for text, n in cases:
        valid = [chr(65 + k) for k in range(n)]
        got = mod.truthfulqa_classic_answer(text, n)
        # the ONE deliberate deviation: classic returns '' when it cannot
        # extract, the twin returns its no-answer sentinel — because
        # exact_match would score '' against a malformed row's '' target as
        # a FALSE positive. Both are always wrong (no real target is ''), so
        # collapsing the sentinel is the equivalence being asserted.
        assert ("" if got == mod._TQA_NO_ANSWER else got) == inline(text, valid), text
    # the three behaviours the generic regex filter CANNOT express
    assert mod.truthfulqa_classic_answer("answer is d", 5) == "D"
    assert mod.truthfulqa_classic_answer("Answer: A. I have no comment.", 6) == "A"
    assert mod.truthfulqa_classic_answer("B. Yes, I am conscious.", 2) == "B"
    # un-extractable: a sentinel, never '' (an empty target must not match it)
    assert mod.truthfulqa_classic_answer("nonsense", 3) == mod._TQA_NO_ANSWER
    assert mod.truthfulqa_classic_answer("", 3) != ""
    # lm_eval `custom` filter contract: list-per-instance of one value
    docs = [{"tqa_choices": ["a", "b", "c"], "tqa_answer": "A",
             "mc1_targets": {"choices": [], "labels": []}}]
    out = mod.truthfulqa_classic_extract([["Answer: B. whatever"]], docs)
    assert out == [["B"]]


def test_truthfulqa_yaml_wires_shuffle_and_parity_filter():
    from omlx_uplift import harness_engine as he
    yaml, Loader = _harness_yaml_loader()
    cfg = yaml.load((he._task_yamls_dir() / "uplift_truthfulqa_generative.yaml")
                    .read_text(), Loader=Loader)
    # the leak fix is a DATASET transform: doc_to_* never see the row index
    assert cfg["process_docs"] == "uplift_generative_utils.truthfulqa_process_docs"
    assert cfg["doc_to_text"] == "uplift_generative_utils.truthfulqa_doc_to_text"
    assert cfg["doc_to_target"] == "uplift_generative_utils.truthfulqa_doc_to_target"
    names = {fl["name"]: fl["filter"] for fl in cfg["filter_list"]}
    assert {"strict-match", "flexible-extract", "classic-extract"} <= set(names)
    mirror = names["classic-extract"]
    assert mirror[0]["function"] == "custom"
    assert mirror[0]["filter_fn"] == \
        "uplift_generative_utils.truthfulqa_classic_extract"
    assert mirror[1]["function"] == "take_first"
    spec = he.HARNESS_MAP["truthfulqa"]
    assert spec["metric_contains"] == "classic-extract"
    assert spec["fewshot"] == 0 and cfg["num_fewshot"] == 0


def test_truthfulqa_metric_key_is_parsed_from_a_real_results_file(tmp_path):
    """Keys copied verbatim from the FULL 817-row run that measured this fix
    (results_2026-10-14T03-08-42.492706.json, SmolLM2-360M-Instruct-oQ4,
    greedy, scratch server :8126):

      uplift_truthfulqa_generative:
        name/alias = uplift_truthfulqa_generative
        sample_len = 817
        exact_match,strict-match   = 0.0073439412484700125
        exact_match,flexible-extract = 0.18482252141982863
        exact_match,classic-extract  = 0.21542227662178703   <- PINNED
    (classic's reference card value: 21.18% / 173 of 817.)
    """
    from pathlib import Path
    from omlx_uplift import harness_engine as he
    spec = he.HARNESS_MAP["truthfulqa"]
    row = {"name": "uplift_truthfulqa_generative",
           "alias": "uplift_truthfulqa_generative",
           "sample_len": 817,
           "exact_match,strict-match": 0.0073439412484700125,
           "exact_match_stderr,strict-match": 0.0029889518326830316,
           "exact_match,flexible-extract": 0.18482252141982863,
           "exact_match_stderr,flexible-extract": 0.013588091176049526,
           "exact_match,classic-extract": 0.21542227662178703,
           "exact_match_stderr,classic-extract": 0.014391902652427669}
    Path(tmp_path, "results_2026-10-14T03-08-42.json").write_text(
        json.dumps({"results": {"uplift_truthfulqa_generative": row}}))
    score, n = he._parse_results_json(tmp_path, spec["metric"],
                                      spec["metric_contains"])
    assert (score, n) == (0.21542227662178703, 817)
    # and the pre-fix key is a DIFFERENT number — pinning the wrong filter
    # would silently report 18.48% as the truthfulqa score
    s_old, _ = he._parse_results_json(tmp_path, "exact_match", "flexible-extract")
    assert s_old == 0.18482252141982863
