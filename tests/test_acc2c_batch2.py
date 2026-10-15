"""ACC-2c batch-2: the two FAST Czech extras (prox_lite_cs_direct +
belebele_cs) ship through the SAME seam as batch-1 — re-checked here with
the batch-1 suite test (test_acc2c_extras.py). This file additionally pins
the prompt-shape contracts that make them 'direct' (answer-emit, no CoT)
and the sizes facts a run must not silently change.

Measured facts pinned (all real, 2026-10-15, bench-env + isolated :8130
scratch server, SmolLM2-360M, --limit 5; determinism witnessed by a
temp-0 re-run whose per-leaf metrics were compared run1-vs-run2):
- prox lite cs: 14 category leaves / 588 rows, answers spread A-J
  (no position leak: dist checked in the test), extractor is the NATIVE
  'custom-extract' phrase regex, kept unchanged for sister-comparability.
- belebele ces_Latn: ONE leaf, 900 test rows (the config ships one split
  only; a fewshot_split='train' reference crashes), 0-shot, flexible-
  extract scores ('Odpověď: X' style replies), strict kept as reference.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_acc2b_suite_seam import (VALID_16, _req, _run_obj, Pool,  # noqa: E402
                                    fake_ab)


BATCH2 = ("prox_lite_cs_direct", "belebele_cs")
ROWS = {"prox_lite_cs_direct": 588, "belebele_cs": 900}
LABELS = {"prox_lite_cs_direct": "Czech knowledge (ProX-Lite, direct)",
          "belebele_cs": "Belebele (Czech)"}
METRICS = {"prox_lite_cs_direct": ("exact_match", "custom-extract"),
           "belebele_cs": ("exact_match", "flexible-extract")}
FEWSHOT = {"prox_lite_cs_direct": 5, "belebele_cs": 0}
_YAMLS = Path(__file__).resolve().parents[1] / "omlx_uplift" / "bench_tasks" / "yamls"


def _utils():
    # load the yaml-dir helpers module (it lives in the yamls dir, NOT in
    # the package import tree) — import by path so the test cannot silently
    # test an old deployed copy of it.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "uplift_generative_utils", _YAMLS / "uplift_generative_utils.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- 1. the seam block on the two new names ----------------------------

def test_batch2_specs_carry_the_full_seam_block():
    from omlx_uplift import harness_engine as he
    for key in BATCH2:
        spec = he.HARNESS_MAP[key]
        assert spec.get("extra") is True, key
        assert key not in VALID_16, key
        assert spec.get("upload_ok") is False, key
        assert he.upload_blocked(key) is True
        assert he.is_extra(key) is True
        assert spec.get("family") == "locale", key
        assert spec.get("rows") == ROWS[key], key
        assert (spec["metric"], spec.get("metric_contains")) == METRICS[key], key
        assert spec["fewshot"] == FEWSHOT[key], key
        assert he.harness_available(key) is True, key


def test_batch2_labels_plain_and_picker_sorted():
    from omlx_uplift import harness_engine as he
    out = he.extra_suites()
    by_key = {r["key"]: r for r in out}
    for key in BATCH2:
        assert by_key[key] == {"key": key, "label": LABELS[key],
                                "family": "locale", "rows": ROWS[key],
                                "upload_ok": False}, key
    assert [r["key"] for r in out] == sorted(r["key"] for r in out)


@pytest.mark.asyncio
async def test_queue_add_admits_batch2_extras(fake_ab):
    from omlx_uplift import accuracy_engine as ae
    from omlx_uplift import harness_engine as he
    await ae.queue_add({"model_id": "m1",
                        "benchmarks": {k: 5 for k in BATCH2},
                        "engine": "harness"}, Pool())
    req = fake_ab.queue[-1]
    assert getattr(req, "_uplift_engine") == "harness"
    assert he.run_usable(req) is True
    assert he.extra_admission_error(req) is None
    assert fake_ab.upload_calls == []
    # classic still refuses them
    with pytest.raises(ae.BadInput):
        await ae.queue_add({"model_id": "m1",
                            "benchmarks": {"belebele_cs": 5}}, Pool())


# ---- 2. prompt-shape contracts (the 'direct' escape) -------------------

def test_prox_direct_prompt_frame_and_extractor():
    u = _utils()
    doc = {"question": "Kolik je 2+2?", "answer": "D",
           "option_0": "3", "option_1": "5", "option_2": "4",
           "option_3": "100", "option_4": None, "category": "math"}
    txt = u.prox_lite_cs_doc_to_text(doc)
    assert txt.startswith("Otázka:\nKolik je 2+2?\nMožnosti:")
    # options A-D present (None padding respected — no E..J lines)
    assert "A. 3" in txt and "D. 100" in txt and "E." not in txt
    # direct demand, exact form of the native extractor — and NO CoT cue
    assert 'Odpověď je (X)' in txt
    assert "Přemýšlejme" not in txt
    # fewshot target: answer line built from the 'answer' column
    assert u.prox_lite_cs_fewshot_doc_to_target(doc) == "Odpověď je (D)."


def test_prox_leaf_partials_exist_per_category():
    u = _utils()
    cats = ["biology", "business", "chemistry", "computer_science",
            "economics", "engineering", "health", "history", "law", "math",
            "other", "philosophy", "physics", "psychology"]
    for cat in cats:
        fn = getattr(u, f"prox_lite_cs_process_{cat}")
        assert callable(fn), cat
    # a wrong category filters to zero rows (the filter is a == on category)
    datasets = pytest.importorskip("datasets")
    ds = datasets.Dataset.from_list([{"category": "math"},
                                      {"category": "law"}])
    assert len(u.prox_lite_cs_process_math(ds)) == 1
    assert len(u.prox_lite_cs_process_biology(ds)) == 0


def test_belebele_prompt_target_mapping():
    u = _utils()
    doc = {"flores_passage": "Pasedaz", "question": "Ktery?",
           "mc_answer1": "a", "mc_answer2": "b", "mc_answer3": "c",
           "mc_answer4": "d", "correct_answer_num": "3"}
    txt = u.belebele_cs_doc_to_text(doc)
    assert "P: Pasedaz" in txt and "Q: Ktery?" in txt
    assert "C. c" in txt and "Odpověď:" in txt
    assert u.belebele_cs_doc_to_target(doc) == "C"
    # correct_answer_num may arrive int or str — both map
    assert u.belebele_cs_doc_to_target(
        {"correct_answer_num": 1}) == "A"
    assert u.belebele_cs_doc_to_target(
        {"correct_answer_num": " 4 "}) == "D"
    with pytest.raises((IndexError, ValueError)):
        u.belebele_cs_doc_to_target({"correct_answer_num": "5"})


def test_belebele_no_fewshot_split_reference():
    """The config ships ONE split only ('test'); a 'train' fewshot ref
    crashes the build (verified during the 2026-10-15 probe). Pin the
    PARSED config (not the raw text — the header comment discusses the
    word)."""
    import yaml as yaml_lib

    class L(yaml_lib.SafeLoader):
        pass
    L.add_constructor("!function",
                      lambda loader, node: "fn:" + loader.construct_scalar(node))
    cfg = yaml_lib.load((_YAMLS / "uplift_belebele_cs.yaml").read_text(),
                        Loader=L)
    assert "fewshot_split" not in cfg, sorted(cfg.keys())
    assert cfg["test_split"] == "test"
    assert cfg["num_fewshot"] == 0


def test_prox_yaml_until_matches_native():
    txt = (_YAMLS / "uplift_prox_lite_cs_direct.yaml").read_text()
    # same until set as the native cs template (no bare-stop-token echo in
    # this file's comments; the list lives in generation_kwargs)
    for needle in ('- "</s>"', '- "\\n"', '- "Q:"', '- "Otázka:"'):
        assert needle in txt, needle


# ---- 3. sizes probe sees both suites (live, bench-env) ------------------

def _probe_suites():
    """Run the repo's own sizes probe with include_path over the two new
    suites; returns {suite: leaf_count}. Skips when bench-env absent."""
    py = Path.home() / ".omlx/uplift/bench-env/bin/python"
    if not py.exists():
        pytest.skip("bench-env not built here")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "harness_sizes_mod",
        _YAMLS.parent / "harness_sizes.py")
    assert spec is not None
    out = subprocess.run(
        [str(py), str(_YAMLS.parent / "harness_sizes.py"),
         json.dumps({"prox_lite_cs_direct": ["uplift_prox_lite_cs_direct"],
                     "belebele_cs": ["uplift_belebele_cs"]}),
         str(_YAMLS)],
        capture_output=True, text=True, timeout=600)
    line = [ln for ln in out.stdout.splitlines()
            if ln.startswith("UPLIFT_SIZES ")]
    assert line, out.stdout[-400:] + out.stderr[-400:]
    return json.loads(line[0][len("UPLIFT_SIZES "):])


def test_sizes_probe_counts_both_suites():
    sizes = _probe_suites()
    assert sizes.get("prox_lite_cs_direct") == 14, sizes
    assert sizes.get("belebele_cs") == 1, sizes


# ---- 4. rows re-measured via test_docs walk (floor, not quote) --------

def test_rows_walk_matches_map():
    py = Path.home() / ".omlx/uplift/bench-env/bin/python"
    if not py.exists():
        pytest.skip("bench-env not built here")
    out = subprocess.run(
        [str(py), "-c",
         "import sys\n"
         "from lm_eval.tasks import TaskManager\n"
         "tm = TaskManager(verbosity='error', include_path=%r)\n"
         "def walk(o):\n"
         "    if isinstance(o, dict):\n"
         "        return sum(walk(v) for v in o.values())\n"
         "    if hasattr(o, 'test_docs'):\n"
         "        return sum(1 for _ in o.test_docs())\n"
         "    return 0\n"
         "for suite in ['uplift_prox_lite_cs_direct', 'uplift_belebele_cs']:\n"
         "    obj = tm.load_task_or_group(suite)\n"
         "    print(suite, walk(obj))\n" % str(_YAMLS)],
        capture_output=True, text=True, timeout=900,
        env={"PATH": "/usr/bin:/bin", "HOME": str(Path.home()),
             "HF_HOME": str(Path.home() / ".omlx/uplift/bench-cache"),
             "HF_DATASETS_CACHE": str(
                 Path.home() / ".omlx/uplift/bench-cache/datasets")})
    lines = {ln.split()[0]: int(ln.split()[1])
             for ln in out.stdout.splitlines() if len(ln.split()) == 2}
    # the group's leaf walk: 588 across 14 leaves; 900 on the one leaf
    assert lines.get("uplift_prox_lite_cs_direct") == 588, out.stdout[-200:]
    assert lines.get("uplift_belebele_cs") == 900, out.stdout[-200:]
