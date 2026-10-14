"""ACC-2c: batch-1 harness-only extras, mixed-leaf metric parsing, offline NLTK.

Three things are pinned here that ACC-2b only built the seam for:

1. THE REAL EXTRAS. ifeval / bbh_cot_fewshot / mmlu_prox_lite_cs are now
   HARNESS_MAP entries marked 'extra'. The 2b invariants are re-checked
   against the REAL specs (2b only ever had a fake in the map): outside the
   classic 16, upload blocked, family from EXTRA_FAMILIES, plain-string
   label (the picker needs no locale work), measured int row count, and a
   spec the harness can actually execute (tasks + fewshot + >=1 metric
   candidate). queue_add admits a real extra under engine='harness';
   classic still refuses it; 'valid' stays the 16.

2. THE MIXED-LEAF METRIC PARSER (_parse_results_json + _suite_metrics).
   A suite whose leaves do NOT share one metric scores each leaf with the
   FIRST candidate it has, weight-averages by sample_len exactly as the U67
   contract demands, and treats a leaf with none of the candidates as
   MISSING — excluded from score AND count, never counted as 0.
   Single-metric suites (every twin shipped before 2c) parse byte-identically.
   If NO leaf scores, run_suite raises instead of inventing a number.

3. THE NLTK OFFLINE GAP. lm_eval's ifeval scorer imports nltk (+ langdetect)
   at MODULE LOAD and would download 'punkt_tab' into ~/nltk_data on a
   user's first run. bench_env.create() now pre-seeds uplift's OWN
   nltk_data dir and spawn() hands it over as NLTK_DATA; the live test at
   the bottom proves the scorer imports with sockets DEAD and
   HF_HUB_OFFLINE=1 (it skips on a box without a built bench-env).

The fake classic module, the fake run/request objects and the fake_ab
fixture are REUSED from the ACC-2b seam test (same directory) rather than
forked — the seam must keep working for the real map, and a second copy of
the double would let the two drift.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from omlx_uplift import bench_env, harness_engine as he

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_acc2b_suite_seam import (VALID_16, _req, _run_obj, Pool,  # noqa: E402
                                   fake_ab)

BATCH1 = ("ifeval", "bbh_cot_fewshot", "mmlu_prox_lite_cs")
# Measured in the design pass and RE-measured by the ACC-2c smoke: the
# full-dataset question count per suite (the picker's size chip). lm_eval's
# --limit is PER TASK, so requests = leaves x limit for a group — U68 says
# the UI multiplies, the chip states the corpus size.
ROWS = {"ifeval": 541, "bbh_cot_fewshot": 6511, "mmlu_prox_lite_cs": 588}
# bbh = 6511: measured over every leaf's test_docs() in bench-env — the
# rows a run ACTUALLY scores. The design pass's 6761 is a dataset-card
# figure that includes rows lm_eval's test split does not emit.
FAMILIES = {"ifeval": "instruction", "bbh_cot_fewshot": "reasoning",
            "mmlu_prox_lite_cs": "locale"}
LABELS = {"ifeval": "IFEval", "bbh_cot_fewshot": "BBH (CoT)",
          "mmlu_prox_lite_cs": "Czech knowledge (MMLU-ProX-Lite)"}


# ---- 1. the real batch-1 specs --------------------------------------------

def test_batch1_extras_ship_with_the_full_seam_block():
    for key in BATCH1:
        spec = he.HARNESS_MAP[key]
        assert spec.get("extra") is True, key
        assert key not in VALID_16, key            # the whole point of 2b
        assert spec.get("upload_ok") is False, key
        assert he.upload_blocked(key) is True
        assert he.is_extra(key) is True
        assert spec.get("family") == FAMILIES[key], key
        assert spec["family"] in he.EXTRA_FAMILIES
        assert spec.get("label") == LABELS[key], key
        assert spec.get("rows") == ROWS[key], key


def test_batch1_labels_are_plain_strings_not_locale_keys():
    """ACC-2a renders extra_suites labels verbatim; a dotted key here would
    print 'uplift.bench.suite.ifeval' on the board, and neither the node
    lint nor test_locale_sync can see it (the picker asks for no catalog
    entry — that is why the labels are literals)."""
    for row in he.extra_suites():
        label = row["label"]
        assert isinstance(label, str) and label
        assert not label.startswith(("uplift.", "acc_bench.", "bench.")), row
        assert "." not in label, row          # a dotted label IS a locale key
        assert label == label.strip()


def test_batch1_specs_are_executable_by_the_harness():
    for key in BATCH1:
        spec = he.HARNESS_MAP[key]
        assert spec["tasks"] and all(isinstance(t, str) and t
                                     for t in spec["tasks"]), key
        assert isinstance(spec["fewshot"], int) and spec["fewshot"] >= 0
        # the metric keys are pinned from REAL results_*.json (see the
        # HARNESS_MAP comment); a spec naming no candidate could only fail
        # at parse time, so the seam forbids it here.
        cands = he._suite_metrics(spec)
        assert cands and all(isinstance(p, str) and p for p, _c in cands), key
        args = he._suite_args(spec, "http://127.0.0.1:1/v1/chat/completions",
                              "m", Path("/tmp/o"), 10, "deterministic")
        assert args[args.index("--tasks") + 1] == ",".join(spec["tasks"])
        assert args[args.index("--num_fewshot") + 1] == str(spec["fewshot"])
        assert args[args.index("--limit") + 1] == "10"
        assert args[-2:] == ["--gen_kwargs", "temperature=0.0"]


def test_extra_suites_payload_carries_the_real_chip_values():
    out = he.extra_suites()
    by_key = {r["key"]: r for r in out}
    assert set(BATCH1) <= set(by_key)
    for key in BATCH1:
        assert by_key[key] == {"key": key, "label": LABELS[key],
                               "family": FAMILIES[key], "rows": ROWS[key],
                               "upload_ok": False}
    assert [r["key"] for r in out] == sorted(r["key"] for r in out)  # picker order


def test_admitted_names_grew_without_touching_the_leaderboard_16(fake_ab):
    from omlx_uplift import accuracy_engine as ae
    admitted = he.admitted_benchmarks(VALID_16)
    assert set(BATCH1) <= admitted
    assert admitted == set(VALID_16) | set(he.HARNESS_MAP)
    assert set(ae.valid_benchmarks()) == set(fake_ab.VALID_BENCHMARKS)
    assert not (set(BATCH1) & set(ae.valid_benchmarks()))


@pytest.mark.asyncio
async def test_queue_add_admits_a_real_batch1_extra(fake_ab):
    """The 2b seam proven on a REAL name, not a fake."""
    from omlx_uplift import accuracy_engine as ae
    assert he.harness_available("ifeval") and he.is_extra("ifeval")
    await ae.queue_add({"model_id": "m1", "benchmarks": {"ifeval": 10,
                                                         "bbh_cot_fewshot": 10},
                        "engine": "harness"}, Pool())
    req = fake_ab.queue[-1]
    assert getattr(req, "_uplift_engine") == "harness"
    assert he.run_usable(req) is True
    assert he.extra_admission_error(req) is None
    assert fake_ab.upload_calls == []          # nothing uploaded yet
    # classic still refuses the very same name, with its OWN wall
    with pytest.raises(ae.BadInput) as e:
        await ae.queue_add({"model_id": "m1", "benchmarks": {"ifeval": 10}},
                           Pool())
    assert "ifeval" in str(e.value) and "Must be one of" in str(e.value)
    assert len(fake_ab.queue) == 1
    # harness + thinking: refused, extras can never fall back to classic
    with pytest.raises(ae.BadInput) as e:
        await ae.queue_add({"model_id": "m1", "benchmarks": {"ifeval": 10},
                            "enable_thinking": True, "engine": "harness"},
                           Pool())
    assert "thinking" in str(e.value)


# ---- 2. mixed-leaf metric parsing -----------------------------------------

def test_suite_metrics_shapes():
    # classic shape (every twin shipped before 2c): one pair
    assert he._suite_metrics({"metric": "exact_match",
                              "metric_contains": "flexible-extract"}) == \
        [("exact_match", "flexible-extract")]
    assert he._suite_metrics({"metric": "acc", "metric_contains": None}) == \
        [("acc", None)]
    # list shape: bare prefixes inherit the spec's contains...
    assert he._suite_metrics({"metric": "exact_match",
                              "metric_contains": "get-answer",
                              "metrics": ["exact_match", "em"]}) == \
        [("exact_match", "get-answer"), ("em", "get-answer")]
    # ...while a [prefix, contains] pair pins its own filter
    assert he._suite_metrics({"metric": "x", "metrics": [
        ["prompt_level_strict_acc", None], ["em", "none"]]}) == \
        [("prompt_level_strict_acc", None), ("em", "none")]
    # 'metrics' wins; an empty list falls back to 'metric', never []
    assert he._suite_metrics({"metric": "acc", "metrics": []}) == [("acc", None)]


def _write(tmp_path, rows, groups=None):
    payload = {"results": rows}
    if groups is not None:
        payload["groups"] = groups
    (tmp_path / "results_2026-10-14_10-00-00.json").write_text(
        json.dumps(payload))
    return tmp_path


def test_parse_results_json_single_metric_is_unchanged(tmp_path):
    """Backward-compat for the twins: positional (metric, contains) keeps
    its exact pre-2c answers."""
    _write(tmp_path, {"gsm8k": {"exact_match,flexible-extract": 0.62,
                                "exact_match,strict-match": 0.5,
                                "exact_match_stderr,flexible-extract": 0.1,
                                "sample_len": 100}})
    assert he._parse_results_json(tmp_path, "exact_match",
                                  "flexible-extract") == (0.62, 100)
    assert he._parse_results_json(tmp_path / "nope", "exact_match",
                                  None) == (None, 0)


def test_parse_results_json_mixed_leaf_metrics(tmp_path):
    """The BBH/bigbench shape: leaves scored by DIFFERENT metrics, one
    candidate pair per metric family, first hit per leaf."""
    rows = {
        "grp_boolean": {"exact_match,get-answer": 1.0, "sample_len": 10,
                        "em,none": 0.3},                # candidate 1 wins
        "grp_math": {"em,none": 0.5, "sample_len": 4},
        "grp_translation": {"f1,none": 0.25, "sample_len": 2},
        "grp_nothing": {"some_other_metric,none": 0.99,
                        "sample_len": 7},               # NOT scored -> skipped
        "grp": {"sample_len": 23},                      # group row -> skipped
    }
    _write(tmp_path, rows, groups={"grp": {"sample_len": 23}})
    cands = [["exact_match", "get-answer"], ["em", "none"], ["f1", "none"]]
    score, n = he._parse_results_json(tmp_path, None, None, metrics=cands)
    # weight-averaged BY SAMPLE_LEN over the scored leaves only (U67):
    # (1.0*10 + 0.5*4 + 0.25*2) / 16  == 12.5/16
    assert n == 16, n
    assert score == pytest.approx(12.5 / 16)
    # the unscored leaf is MISSING, not 0: counting it as 0 over its 7
    # samples would have given 12.5/23 — the two shapes are distinguishable
    assert score != pytest.approx(12.5 / 23)
    # the same candidates via the list-in-first-argument shape
    assert he._parse_results_json(tmp_path, cands, None) == (score, n)


def test_parse_results_json_order_is_the_specs_priority(tmp_path):
    """A leaf carrying BOTH candidates takes the first listed one, so the
    spec's order — not dict order — is the suite's headline metric."""
    _write(tmp_path, {"t": {"inst_level_strict_acc,none": 0.9,
                            "prompt_level_strict_acc,none": 0.4,
                            "sample_len": 5}})
    assert he._parse_results_json(tmp_path, None, None, metrics=[
        ["prompt_level_strict_acc", "none"],
        ["inst_level_strict_acc", "none"]])[0] == 0.4
    assert he._parse_results_json(tmp_path, None, None, metrics=[
        ["inst_level_strict_acc", "none"],
        ["prompt_level_strict_acc", "none"]])[0] == 0.9


def test_parse_results_json_no_candidate_hits_is_missing(tmp_path):
    _write(tmp_path, {"t": {"exact_match,get-answer": 0.5, "sample_len": 5}})
    assert he._parse_results_json(tmp_path, None, None,
                                  metrics=[["em", "none"]]) == (None, 0)
    # a metric prefix that exists but whose filter never matches -> missing
    assert he._parse_results_json(tmp_path, "exact_match",
                                  "some-other-filter") == (None, 0)


class _FakeProc:
    """A harness child that exits 0 after printing nothing (the results
    file is written by the spawn double, exactly as a real run leaves it)."""
    pid = 4242
    returncode = 0

    def __init__(self, lines=()):
        self._lines = list(lines)

    def poll(self):
        return 0

    @property
    def stdout(self):
        return iter(self._lines)


@pytest.mark.asyncio
async def test_run_suite_raises_when_no_leaf_scores(fake_ab, tmp_path,
                                                    monkeypatch):
    """No fabricated score: results carrying none of the spec's metrics end
    in an honest error naming the candidates."""
    outdir = tmp_path / "acc9" / "ifeval"

    def fake_spawn(args, **kw):
        outdir.mkdir(parents=True, exist_ok=True)
        (outdir / "results_x.json").write_text(json.dumps({"results": {
            "ifeval": {"some_metric,none": 0.5, "sample_len": 10}}}))
        return _FakeProc(["Requesting API: 100%|#| 10/10 [00:01<00:00]\n"])

    monkeypatch.setattr(he.bench_env, "status",
                        lambda **kw: {"state": "ready", "path": None})
    monkeypatch.setattr(he.bench_env, "spawn", fake_spawn)
    monkeypatch.setattr(he, "results_root", lambda: tmp_path)
    monkeypatch.setattr(he, "_base_url", lambda: "http://127.0.0.1:1/v1/x")
    monkeypatch.setattr(he, "_api_key", lambda: "k")
    run = _run_obj(_req({"ifeval": 10}))
    run.bench_id = "acc9"
    with pytest.raises(RuntimeError) as exc:
        await he.run_suite(run, "ifeval", 10, None, 0, 1)
    assert "prompt_level_strict_acc" in str(exc.value)
    # the failure is the SCORE gate, not the subprocess: the child ran clean
    # (rc 0) and left a real results file behind
    assert (outdir / "results_x.json").exists()


@pytest.mark.asyncio
async def test_run_suite_scores_many_leaves_weighted(fake_ab, tmp_path,
                                                     monkeypatch):
    """The other side of that gate: a bbh-shaped file — 26 leaves scored,
    one leaf with no metric at all, plus the group row — averages the 26 by
    sample_len and reports 260 questions, not 270."""
    outdir = tmp_path / "acc9" / "bbh_cot_fewshot"
    rows = {f"bbh_cot_fewshot_l{i}": {
                "exact_match,get-answer": 1.0 if i % 2 else 0.0,
                "exact_match_stderr,get-answer": 0.2,
                "sample_len": 10} for i in range(26)}
    rows["bbh_cot_fewshot_unscored"] = {"sample_len": 10}
    rows["bbh_cot_fewshot"] = {"alias": "bbh", "sample_len": 270}

    def fake_spawn(args, **kw):
        outdir.mkdir(parents=True, exist_ok=True)
        (outdir / "results_y.json").write_text(
            json.dumps({"results": rows,
                        "groups": {"bbh_cot_fewshot": {"sample_len": 270}}}))
        return _FakeProc()

    monkeypatch.setattr(he.bench_env, "status",
                        lambda **kw: {"state": "ready", "path": None})
    monkeypatch.setattr(he.bench_env, "spawn", fake_spawn)
    monkeypatch.setattr(he, "results_root", lambda: tmp_path)
    monkeypatch.setattr(he, "_base_url", lambda: "http://127.0.0.1:1/v1/x")
    monkeypatch.setattr(he, "_api_key", lambda: "k")
    run = _run_obj(_req({"bbh_cot_fewshot": 10}))
    run.bench_id = "acc9"
    out = await he.run_suite(run, "bbh_cot_fewshot", 10, None, 0, 1)
    assert out["engine"] == "harness" and out["benchmark"] == "bbh_cot_fewshot"
    assert out["total"] == 260 and out["accuracy"] == 0.5
    assert out["correct"] == 130


# ---- 3. the NLTK offline gap ------------------------------------------------

@pytest.fixture()
def tmp_store(monkeypatch, tmp_path):
    monkeypatch.setattr(bench_env, "bench_env_dir",
                        lambda *a, **k: tmp_path / "bench-env")
    monkeypatch.setattr(bench_env, "hf_cache_dir",
                        lambda: tmp_path / "bench-cache")
    return tmp_path


def _fake_build(monkeypatch, venv: Path, *, nltk_stdout=None):
    """Stand in for create()'s subprocess.run. The nltk seed child is
    recognised by the corpus code it carries and answers `nltk_stdout`."""
    calls: list[list[str]] = []

    def fake_run(cmd, *a, **k):
        joined = " ".join(str(c) for c in cmd)
        calls.append([str(c) for c in cmd])
        if "-m venv" in joined:
            (venv / "bin").mkdir(parents=True, exist_ok=True)
            (venv / "bin" / "python").write_text("#!/bin/sh\n")
        elif "find_spec" in joined:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        elif "__version__" in joined:
            return subprocess.CompletedProcess(cmd, 0, "0.4.13", "")
        elif "punkt_tab" in joined:            # the corpus seed child
            return subprocess.CompletedProcess(
                cmd, 0, nltk_stdout if nltk_stdout is not None
                else 'UPLIFT_NLTK {"punkt_tab": "downloaded", '
                     '"punkt": "downloaded"}\n', "")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(bench_env, "_python_for_venv", lambda: sys.executable)
    return calls


def test_nltk_data_dir_is_uplift_owned_not_home(tmp_store):
    d = bench_env.nltk_data_dir()
    assert d == tmp_store / "nltk_data"
    assert str(Path.home() / "nltk_data") != str(d)
    assert str(Path.home()) not in str(d)


def test_create_seeds_nltk_and_stamps_the_marker(tmp_store, monkeypatch):
    calls = _fake_build(monkeypatch, tmp_store / "bench-env")
    st = bench_env.create(quiet=True)
    assert st["state"] == "ready"
    seed_calls = [c for c in calls if "punkt_tab" in " ".join(c)]
    assert seed_calls, "create() never seeded the corpora"
    argv = seed_calls[0]
    assert argv[0].endswith("bench-env/bin/python"), argv   # runs IN the venv
    assert str(tmp_store / "nltk_data") in argv            # target dir
    marker = json.loads((tmp_store / "bench-env" / bench_env.MARKER)
                        .read_text())
    assert marker["nltk"]["punkt_tab"] == "downloaded"
    assert marker["nltk"]["dir"] == str(tmp_store / "nltk_data")


def test_seed_survives_a_broken_child(tmp_store, monkeypatch):
    """A failed download must never destroy a built 604 MB venv or raise
    out of create(): the suite fails loudly at run time instead."""
    _fake_build(monkeypatch, tmp_store / "bench-env",
                nltk_stdout="Traceback: no network\n")
    st = bench_env.create(quiet=True)
    assert st["state"] == "ready"
    marker = json.loads((tmp_store / "bench-env" / bench_env.MARKER)
                        .read_text())
    assert marker["nltk"]["state"] == "unresponsive"


def test_seed_is_bench_env_only(tmp_store, monkeypatch):
    """mteb-env shares create()'s machinery; no scorer there imports nltk,
    so it must not pay for (or pollute) the corpus dir."""
    store = tmp_store
    venv = store / "mteb-env"
    monkeypatch.setattr(bench_env, "bench_env_dir",
                        lambda dirname="bench-env": store / dirname)
    req = store / "mteb_requirements.txt"
    req.write_text("nltk==3.10.3\n")
    calls = _fake_build(monkeypatch, venv)
    bench_env.create(quiet=True, dirname="mteb-env", req=req,
                     marker="uplift-mteb-env.json", import_name="mteb")
    assert not [c for c in calls if "punkt_tab" in " ".join(c)]
    assert not (store / "nltk_data").exists()


def test_spawn_hands_the_child_nltk_data(tmp_store, monkeypatch):
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("#!/bin/sh\n")
    (venv / bench_env.MARKER).write_text(json.dumps(
        {"requirements": bench_env.requirements_digest()}))
    captured = {}

    class P:
        def __init__(self, argv, **kw):
            captured["argv"] = argv
            captured["env"] = kw["env"]

    monkeypatch.setattr(subprocess, "Popen", P)
    bench_env.spawn(["--tasks", "ifeval"], api_key="sk-x",
                    hf_cache=bench_env.hf_cache_dir())
    assert captured["env"]["NLTK_DATA"] == str(tmp_store / "nltk_data")
    assert "NLTK_DATA" not in " ".join(captured["argv"])   # env, never argv
    # the U68 sizes probe LOADS the same task modules -> same treatment
    src = Path(he.__file__).read_text()
    assert '"NLTK_DATA": str(bench_env.nltk_data_dir())' in src


def test_requirements_pin_the_measured_scoring_deps():
    names = bench_env.requirements_names(bench_env.REQUIREMENTS)
    # ifeval cannot even LOAD without these two (instructions.py imports
    # langdetect, utils.py imports immutabledict), and its scorer needs nltk
    assert {"langdetect", "immutabledict", "nltk"} <= names
    assert not any(n.startswith("torch") for n in names)   # ACC-2e guard
    pins = dict(ln.split("==") for ln in
                bench_env.REQUIREMENTS.read_text().splitlines()
                if "==" in ln)
    assert pins["langdetect"] and pins["immutabledict"]    # pinned, not floating


# ---- the live offline proof (bench-env present, else skip) -----------------

def _harness_py():
    py = bench_env.harness_python()
    if not py or not Path(py).exists():
        return None
    probe = subprocess.run(
        [py, "-c", "import importlib.util, sys; sys.exit(0 if "
                   "importlib.util.find_spec('langdetect') else 1)"],
        capture_output=True)
    # a bench-env built BEFORE the ACC-2c pin has no langdetect: the task
    # cannot load there at all, so there is nothing to prove offline
    return py if probe.returncode == 0 else None


def test_live_ifeval_imports_with_sockets_dead(tmp_path):
    """THE point of the pre-seed, end to end: seed once (network allowed),
    then import lm_eval's ifeval scorer with every socket refused and
    HF_HUB_OFFLINE=1. Proves bench_offline can run IFEval and that the
    corpus resolves out of uplift's dir, not ~/nltk_data."""
    py = _harness_py()
    if py is None:
        pytest.skip("no bench-env with the ACC-2c pins on this box")
    store = tmp_path / "store"
    (store / "bench-env").mkdir(parents=True)
    env = {**os.environ, "UPLIFT_HOME": str(store),
           "NLTK_DATA": str(store / "nltk_data")}
    seed = subprocess.run(
        [py, "-c", bench_env._NLTK_SEED_CODE, env["NLTK_DATA"],  # noqa: S607
         json.dumps(list(bench_env.NLTK_PACKAGES))],
        capture_output=True, text=True, env=env, timeout=900)
    assert "UPLIFT_NLTK" in seed.stdout, seed.stderr[-400:]
    facts = json.loads(seed.stdout.split("UPLIFT_NLTK")[1].strip())
    per_pkg = {k: v for k, v in facts.items() if not k.startswith("_")}
    assert set(per_pkg) == set(bench_env.NLTK_PACKAGES), per_pkg
    assert all(v in ("present", "downloaded") for v in per_pkg.values()), facts
    # hygiene: the downloader's archive is dead weight next to the tree
    toks = Path(env["NLTK_DATA"]) / "tokenizers"
    assert not list(toks.glob("*.zip")), list(toks.iterdir())
    assert facts.get("_zips_removed") == 0 or facts.get("_zips_removed") == 2
    for pkg in bench_env.NLTK_PACKAGES:
        assert (toks / pkg).is_dir(), pkg
    child = (
        "import socket\n"
        "class NoNet(socket.socket):\n"
        "    def __init__(self, *a, **k):\n"
        "        raise OSError('network is disabled in this child')\n"
        "socket.socket = NoNet\n"
        "import nltk\n"
        "from lm_eval.tasks.ifeval import utils as ifeval_utils   # noqa\n"
        "found = nltk.data.find('tokenizers/punkt_tab')\n"
        "print('IMPORTED_OK CORPUS=' + str(found.path))\n"
    )
    run = subprocess.run([py, "-c", child], capture_output=True, text=True,
                         env={**env, "HF_HUB_OFFLINE": "1"}, timeout=600)
    out = (run.stdout or "") + (run.stderr or "")
    assert "IMPORTED_OK" in out, out[-900:]
    assert str(store / "nltk_data") in out, out[-400:]
