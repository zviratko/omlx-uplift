# SPDX-License-Identifier: Apache-2.0
"""REPL-2b carryover: letter-extract helpers for the custom generative
task yamls in this directory.

lm_eval resolves `!function uplift_generative_utils.<fn>` relative to this
yaml directory (same mechanism the built-in hellaswag/mathqa utils use),
and it must stay importable WITHOUT lm_eval so the repo test can exercise
the exact functions the yamls reference.

Parity doctrine (card: match the classic modules' dataset id, split,
few-shot count and option-letter format):
  * mathqa     -> omlx/eval/mathqa.py      (regisss/math_qa, test split,
                     'Solve the following math problem' A-E letters)
  * truthfulqa -> omlx/eval/truthfulqa.py  (truthfulqa/truthful_qa
                     multiple_choice/validation, MC1 letter answer —
                     NOT the judge-scored truthfulqa_gen)
  * cmmlu      -> omlx/eval/cmmlu.py       (haonan-li/cmmlu test split +
                     dev few-shot pool, 5 shots, A-D, '答案:' cue) and the
                     vendored-data loader, because that dataset is NOT
                     loadable through dataset_path in this bench-env
  * hellaswag / winogrande need no helper: their prompts are static-shape
    Jinja in the yamls (winogrande keeps classic's numeric 1/2 answer
    format on purpose — classic extracts ["1","2"], not letters).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# Classic parses the raw 'options' string with exactly this shape
# ("a ) 38 , b ) 27.675 , ... e ) none of these"); same regex the lm-eval
# built-in mathqa multiple_choice task uses (utils.doc_to_choice).
_MATHQA_OPTION_RE = re.compile(r"[abcd] \) .*?, |e \) .*?$")

_MATHQA_LETTERS = "ABCDE"


def mathqa_options(doc):
    """Ordered option texts for a raw regisss/math_qa row."""
    return [c[4:].rstrip(" ,")
            for c in _MATHQA_OPTION_RE.findall(doc["options"])]


def mathqa_doc_to_text(doc, lm_eval_config=None):
    """Mirror of MathQABenchmark.format_prompt (classic parity, 0-shot)."""
    parts = [
        "Solve the following math problem. Answer with just the letter.\n",
        f"Problem: {doc['Problem']}\n",
    ]
    for letter, choice in zip(_MATHQA_LETTERS, mathqa_options(doc)):
        parts.append(f"{letter}. {choice}")
    parts.append("\nAnswer:")
    return "\n".join(parts)


def mathqa_doc_to_target(doc):
    """Mirror of MathQABenchmark: 'correct' is the answer letter (a-e)."""
    return doc["correct"].upper()


def _truthfulqa_letters(doc):
    targets = doc["mc1_targets"]
    return targets["choices"], targets["labels"]


def truthfulqa_doc_to_text(doc, lm_eval_config=None):
    """Mirror of TruthfulQABenchmark.format_prompt (classic parity, 0-shot).

    Honest divergence note (quantified in the divergence wave, not here):
    classic deterministically SHUFFLES the mc1 choices per question
    (random.Random(42 + i)); the harness scores the dataset order. Also,
    questions with >26 choices would exceed A-Z in classic's own
    chr(65 + idx) mapping and mis-score there too — bounded by regex
    ([A-Z]) here, so such rows simply score 0 instead of matching a
    punctuation letter.
    """
    choices, _labels = _truthfulqa_letters(doc)
    parts = [
        "Answer the following question truthfully. Choose the most "
        "accurate answer. Answer with just the letter.\n",
        f"Question: {doc['question']}\n",
    ]
    for i, choice in enumerate(choices):
        parts.append(f"{chr(ord('A') + i)}. {choice}")
    parts.append("\nAnswer:")
    return "\n".join(parts)


def truthfulqa_doc_to_target(doc):
    """MC1: first label==1 row is the single correct answer (classic's
    own rule, omlx/eval/truthfulqa.py). Returns '' when a malformed row
    has no 1-label — it then scores 0 instead of crashing the suite."""
    _choices, labels = _truthfulqa_letters(doc)
    try:
        return chr(ord("A") + labels.index(1))
    except ValueError:
        return ""


# ---------------------------------------------------------------------------
# cmmlu — the ONLY suite whose data is vendored (cmmlu_data/, see
# PROVENANCE.md): haonan-li/cmmlu (= lmlmcat/cmmlu) ships nothing but a
# datasets loader script + a raw zip, and datasets 5.x refuses scripts, so
# `dataset_path` can never reach it. These helpers are therefore both the
# offline loader and the prompt mirror of omlx/eval/cmmlu.py.
# ---------------------------------------------------------------------------

# Path(__file__)-adjacent packaged data: correct from any cwd and inside an
# installed wheel (pyproject ships bench_tasks/cmmlu_data as package-data),
# where an absolute path baked into the yaml would be a lie.
CMMLU_DATA_DIR = Path(__file__).resolve().parent.parent / "cmmlu_data"

_CMMLU_LETTERS = ["A", "B", "C", "D"]

_CMMLU_SPLITS = ("test", "dev")


def cmmlu_subject_title(subject: str) -> str:
    """Mirror of classic's _format_subject_name (omlx/eval/cmmlu.py:22)."""
    return subject.replace("_", " ").replace("-", " ").title()


def cmmlu_header(subject: str) -> str:
    """Classic's instruction line — note the trailing '\\n' is part of it."""
    return (f"以下是关于{cmmlu_subject_title(subject)}的单选题，"
            f"请直接回答正确选项的字母（A、B、C或D）。\n")


def _cmmlu_qa_block(doc) -> str:
    """Mirror of classic's _format_question: verbatim question (classic does
    NOT strip it) + 'A. '/'B. '/'C. '/'D. ' option lines, newline-joined."""
    parts = [doc["question"]]
    for letter, choice in zip(_CMMLU_LETTERS, doc["choices"]):
        parts.append(f"{letter}. {choice}")
    return "\n".join(parts)


def cmmlu_doc_to_text(doc, lm_eval_config=None):
    """The evaluated question: classic's block + the '答案:' cue.

    The instruction line is NOT repeated here — classic prints it once,
    above the first few-shot example (cmmlu_fewshot_doc_to_text), so the
    harness context and classic's format_prompt() content are byte-equal.
    """
    return _cmmlu_qa_block(doc) + "\n答案:"


def cmmlu_fewshot_doc_to_text(doc, lm_eval_config=None):
    """Few-shot example body; carries the instruction line for row 0 only."""
    block = _cmmlu_qa_block(doc)
    if int(doc.get("row_id", -1)) == 0:
        return cmmlu_header(doc["subject"]) + "\n" + block
    return block


def cmmlu_doc_to_target(doc, lm_eval_config=None):
    """A/B/C/D — classic compares the extracted letter to item['answer']."""
    return doc["answer"]


def cmmlu_fewshot_doc_to_target(doc, lm_eval_config=None):
    """'答案: X' as classic writes it inside the few-shot block."""
    return f"答案: {doc['answer']}"


def cmmlu_read_jsonl(path: Path) -> list[dict]:
    """One vendored split file, in file order (few-shot order is a
    classic-parity input: classic appends dev rows in load order)."""
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def cmmlu_dataset(subject: str | None = None, **_ignored) -> "object":
    """lm_eval `custom_dataset` entry point for ONE cmmlu subject.

    Returns {test, dev} as a DatasetDict built straight from the packaged
    JSONL — no hub, no datasets-script, no parquet, works with
    HF_HUB_OFFLINE=1. Per-subject leaves are what give cmmlu the mmlu suite
    shape (lm_eval's --limit is per task, so 'N questions' stays a spread
    over subjects instead of the first N rows of one file).

    `**_ignored` absorbs task metadata keys lm_eval splats into the call.
    The guards run BEFORE the `datasets` import so a mis-wired yaml fails
    with a readable error in an environment that has no datasets at all
    (the repo test suite).
    """
    if not subject:
        raise ValueError("cmmlu_dataset needs dataset_kwargs: {subject: ...}")
    missing = [s for s in _CMMLU_SPLITS
               if not (CMMLU_DATA_DIR / s / f"{subject}.jsonl").is_file()]
    if missing:
        raise FileNotFoundError(
            f"vendored cmmlu data missing for {subject!r} ({missing}) under "
            f"{CMMLU_DATA_DIR} (package-data not installed?)")
    from datasets import Dataset, DatasetDict

    dd = DatasetDict()
    for split in _CMMLU_SPLITS:
        dd[split] = Dataset.from_list(
            cmmlu_read_jsonl(CMMLU_DATA_DIR / split / f"{subject}.jsonl"))
    return dd


def cmmlu_subjects() -> list[str]:
    """The vendored subject ids (= the suite's leaf set)."""
    return sorted(p.stem for p in (CMMLU_DATA_DIR / "test").glob("*.jsonl"))
