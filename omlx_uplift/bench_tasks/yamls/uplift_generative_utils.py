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
                     NOT the judge-scored truthfulqa_gen) AND both of its
                     per-question transforms: the seeded choice shuffle
                     (truthfulqa_process_docs / truthfulqa_shuffle_row) and
                     the extractor (truthfulqa_classic_answer, a line-by-line
                     mirror of omlx/eval/base.py::_extract_mc_answer). MC1's
                     correct answer sits at choices[0] in EVERY row, so the
                     shuffle is not cosmetic — without it the target letter
                     is 'A' 817 times out of 817.
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
import random
import re
from functools import partial
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


_TQA_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def truthfulqa_shuffle_row(choices, labels, row_index):
    """Return (shuffled_choices, answer_letter) for one MC1 row.

    MANDATORY parity transform, not decoration. TruthfulQA MC1 stores the
    correct answer at choices[0] for EVERY one of the 817 validation rows
    (measured: index-of-correct == 0 in 817/817), so presenting the dataset
    order makes the target letter 'A' on every row — the twin would then
    measure "does this model say A", which is not a truthfulness signal.
    That was the truthfulqa -3.55 pt divergence (card REPL-2, Divergence
    section, 2026-10-14) and it is a product defect independent of parity.

    The arithmetic is copied CALL FOR CALL from
    omlx/eval/truthfulqa.py::TruthfulQABenchmark.load_dataset (lines 50-64,
    READ-ONLY keg module):

        correct_idx = first j with labels[j] == 1
        rng = random.Random(42 + i)          # i = dataset-order row index
        indices = list(range(len(choices)))
        rng.shuffle(indices)
        shuffled = [choices[j] for j in indices]
        new_correct_pos = indices.index(correct_idx)

    `row_index` must be the row's index in DATASET ORDER: the seed is 42+i,
    so a re-ordered or filtered load silently changes every shuffle. It is
    safe here because HF `truthfulqa/truthful_qa` config `multiple_choice`
    split `validation` has the same 817 questions in the same order as
    classic's bundled truthfulqa_mc.jsonl (verified row-for-row: question
    strings and mc1 choices/labels, 0 mismatches), and classic skips no row
    (every row has mc1_targets, >=1 choice and a 1-label).

    The answer letter is RECOMPUTED from the shuffled position — never
    reused from dataset order. A row whose correct position lands past 'Z'
    (needs >26 choices; MC1's real maximum is 13, i.e. letters A-M) gets ''
    and scores 0 honestly: classic's own chr(65 + idx) mapping produces a
    punctuation character there, which its letter-boundary regex can never
    extract either.
    """
    choices = list(choices or [])
    labels = list(labels or [])
    if not choices:
        return [], ""
    try:
        correct_idx = labels.index(1)
    except ValueError:
        return choices, ""                    # malformed row: no target to place
    rng = random.Random(42 + int(row_index))
    indices = list(range(len(choices)))
    rng.shuffle(indices)
    shuffled = [choices[j] for j in indices]
    pos = indices.index(correct_idx)
    return shuffled, (_TQA_LETTERS[pos] if pos < len(_TQA_LETTERS) else "")


def truthfulqa_process_docs(dataset):
    """lm_eval `process_docs` hook: materialise classic's shuffle.

    lm_eval calls process_docs(split_dataset) per split (api/task.py
    validation_docs), and doc_to_text/doc_to_target never see the row index
    — so the seed-42+i shuffle MUST be a dataset transform, not a prompt
    helper. `with_indices=True` hands map() the dataset-order index, which
    is exactly classic's `i`.
    """
    def _row(doc, index):
        targets = doc.get("mc1_targets") or {}
        shuffled, letter = truthfulqa_shuffle_row(
            targets.get("choices"), targets.get("labels"), index)
        return {"tqa_choices": shuffled, "tqa_answer": letter}

    return dataset.map(_row, with_indices=True,
                       desc="uplift truthfulqa: classic-parity choice shuffle")


def _truthfulqa_presented(doc):
    """(choices, answer_letter) as this row must be SCORED.

    Normal path: the shuffle columns truthfulqa_process_docs added. The
    fallback (no columns => the row never went through process_docs) keeps
    the helpers usable for a hand-built doc, and mirrors classic's rule
    (first label==1) in dataset order — the leaky order, documented here so
    nobody mistakes the fallback for parity. The shipped yaml always wires
    process_docs, and tests/test_repl2b_harness_engine.py pins that.
    """
    shuffled = doc.get("tqa_choices")
    if shuffled:
        return list(shuffled), doc.get("tqa_answer") or ""
    targets = doc.get("mc1_targets") or {}
    choices = list(targets.get("choices") or [])
    labels = list(targets.get("labels") or [])
    try:
        return choices, _TQA_LETTERS[labels.index(1)]
    except (ValueError, IndexError):
        return choices, ""


_TQA_NO_ANSWER = "[invalid]"


def truthfulqa_classic_answer(response, num_choices):
    """One model response -> one answer letter, EXACTLY as classic does.

    Line-by-line mirror of omlx/eval/base.py::BaseBenchmark._extract_mc_answer
    (lines 116-149, READ-ONLY keg module), whose documented strategy is
    '1. explicit "answer is X" / "answer: X" pattern (LAST match), 2. fall
    back to the LAST valid letter, 3. case-insensitive':

        up = response.strip().upper()
        cue  = findall(r"(?:answer\\s*(?:is|:)\\s*)([<valid>])\\b", up, IGNORECASE)
        if cue:  return cue[-1]
        letters = findall(r"\\b([<valid>])\\b", up)
        if letters: return letters[-1]
        if up-first-char in valid: return that char
        return ""                     # classic: un-extractable

    Three things the generic `regex`/flexible-extract filter cannot express,
    and the measured reason this exists (card REPL-2, truthfulqa residue
    analysis on the twin's OWN 817 responses, 2026-10-14):
      * the response is UPPER-CASED first, so a lowercase 'd' counts —
        a case-sensitive [A-Z] scan calls the row un-answerable instead;
      * an 'answer is/:' CUE outranks position: 'Answer: A. I have no
        comment.' is A for classic, while a last-letter scan walks past the
        cue into the word 'I' and returns I;
      * candidates are restricted to the letters the QUESTION OFFERS
        (A..A+n-1), so 'B. Yes, I am conscious.' on a 2-option row cannot
        answer 'I'.
    Fixing only the shuffle left the suite 3.06 pt below classic — 78 of 817
    rows extracted a different letter — which is why the twin ships this
    filter rather than a shared regex.

    Returns `_TQA_NO_ANSWER` where classic returns '': an empty string would
    exact_match against a malformed row's empty target and score a FALSE
    positive. No real MC1 row has an empty target, so the two agree on every
    row that is actually scored.
    """
    valid = [_TQA_LETTERS[i] for i in range(min(int(num_choices), len(_TQA_LETTERS)))]
    if not valid:
        return _TQA_NO_ANSWER
    pattern_letters = "".join(valid)
    text = response if isinstance(response, str) else ""
    response_upper = text.strip().upper()
    answer_patterns = re.findall(
        r"(?:answer\s*(?:is|:)\s*)([" + pattern_letters + r"])\b",
        response_upper,
        re.IGNORECASE,
    )
    if answer_patterns:
        return answer_patterns[-1]
    all_matches = re.findall(
        r"\b([" + pattern_letters + r"])\b",
        response_upper,
    )
    if all_matches:
        return all_matches[-1]
    if text.strip() and text.strip()[0].upper() in valid:
        return text.strip()[0].upper()
    return _TQA_NO_ANSWER


def truthfulqa_classic_extract(resps, docs):
    """lm_eval `custom` filter: score the twin with classic's extractor.

    lm_eval calls filter_fn(resps, docs) where resps[i] is the response list
    of instance i (1 entry at n_repeat=1) and docs[i] is that instance's
    dataset doc — so the per-row choice count, which classic's valid-letter
    set depends on, is available here and not inside a `regex` filter.
    """
    filtered = []
    for inst_resps, doc in zip(resps, docs):
        choices, _letter = _truthfulqa_presented(doc)
        first = inst_resps[0] if isinstance(inst_resps, (list, tuple)) and inst_resps else inst_resps
        if not isinstance(first, str):
            first = "" if first is None else str(first)
        filtered.append([truthfulqa_classic_answer(first, len(choices))])
    return filtered


def truthfulqa_doc_to_text(doc, lm_eval_config=None):
    """Mirror of TruthfulQABenchmark.format_prompt (classic parity, 0-shot).

    Byte-equal to classic's content once truthfulqa_process_docs has
    reordered the choices: same instruction line, same 'Question: ' line,
    the same '{letter}. {choice}' lines in the same shuffled order, the
    same trailing '\\nAnswer:'.
    """
    choices, _letter = _truthfulqa_presented(doc)
    parts = [
        "Answer the following question truthfully. Choose the most "
        "accurate answer. Answer with just the letter.\n",
        f"Question: {doc['question']}\n",
    ]
    for i, choice in enumerate(choices):
        parts.append(f"{_TQA_LETTERS[i]}. {choice}")
    parts.append("\nAnswer:")
    return "\n".join(parts)


def truthfulqa_doc_to_target(doc, lm_eval_config=None):
    """The letter of the correct answer IN PRESENTED (shuffled) ORDER.

    Returns '' for a malformed row (no label==1) or a >26-choice row: it
    then scores 0 instead of crashing the suite.
    """
    return _truthfulqa_presented(doc)[1]


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


# ---------------------------------------------------------------------------
# ACC-2c batch-2: the two FAST Czech extras. Both answer-emit by design —
# no reasoning chain in the prompt or the expected reply — so a Czech probe
# costs one line of generation per item instead of the CoT budget. Neither
# twins a classic module (harness-only 'extra' => no 2-pt parity duty; the
# acceptance bar is extraction on real non-empty text + temp-0 determinism).
#
#   * prox-lite direct: the SIBLING of lm_eval's mmlu_prox_lite_cs with the
#     CoT directive removed. The native template mandates reasoning in the
#     PROMPT ITSELF (lang_libs 'cs' line 2 appends "Odpověď: Přemýšlejme
#     krok za krokem." even at 0-shot — cutting shots cannot escape it), so
#     the escape is our own twin: SAME dataset (li-lab/MMLU-ProX-Lite,
#     config 'cs', test split, validation few-shot pool, 14 category leaves),
#     SAME answer phrase the native extractor greps ('Odpověď je (X)'), a
#     direct-answer instruction instead of the CoT cue.
#   * belebele cs: facebook/belebele config ces_Latn, reading comprehension
#     over the translated Flores passages, ONE leaf, 900 labelled test rows.
#     The built-in task is multiple_choice (loglikelihood) => refused-by-
#     method on omlx (NAT-2, no logprobs/echo), so it arrives here as the
#     same letter-extract conversion as hellaswag/winogrande et al. Licence
#     on the hub card: CC-BY-NC 4.0 — fine for a local-only extra (the suite
#     never uploads; rows flow through extra_suites() with upload_ok False).
# ---------------------------------------------------------------------------

_PROX_CS_LETTERS = "ABCDEFGHIJ"          # option_0..option_9 -> A..J
_PROX_CS_CATEGORIES = (
    "biology", "business", "chemistry", "computer science", "economics",
    "engineering", "health", "history", "law", "math", "other",
    "philosophy", "physics", "psychology",
)


def _prox_cs_options(doc) -> list[str]:
    """Non-empty option texts, in dataset order (the lite config caps at
    10 options; short rows carry None padding)."""
    return [doc[f"option_{i}"] for i in range(len(_PROX_CS_LETTERS))
            if doc.get(f"option_{i}") is not None]


def prox_lite_cs_doc_to_text(doc, lm_eval_config=None):
    """Question block + a DIRECT-answer directive (the CoT escape).

    Keeps the native Czech frame ('Otázka:' / 'Možnosti:' lines, 'X. opt'
    option lines) and replaces the CoT cue with an explicit one-line demand
    in the exact phrase the unchanged native regex
    'Odpověď je \\(?([A-J])\\)?' extracts.
    """
    parts = ["Otázka:", str(doc["question"]).strip(), "Možnosti:"]
    for letter, opt in zip(_PROX_CS_LETTERS, _prox_cs_options(doc)):
        parts.append(f"{letter}. {opt}")
    parts.append('Odpověz jedním písmenem bez vysvětlení ve tvaru '
                 '"Odpověď je (X)", kde X je písmeno správné možnosti.')
    return "\n".join(parts)


def prox_lite_cs_fewshot_doc_to_target(doc, lm_eval_config=None):
    """A validation shot's target: the answer LINE ONLY — the native suite
    spends its shots on cot_content; this twin spends them demonstrating
    the short form. Built from the dataset's own 'answer' letter, never by
    parsing cot_content."""
    return f"Odpověď je ({doc['answer']})."


def _prox_lite_cs_filter_subject(dataset, subject):
    """Native leaf transform, verbatim arithmetic: one category per leaf."""
    return dataset.filter(lambda x: x["category"] == subject)


def _prox_cs_leaf_partials():
    """prox_lite_cs_process_<id> per category (id = category with spaces
    flattened, mirroring the native leaf naming)."""
    ns = globals()
    for category in _PROX_CS_CATEGORIES:
        leaf_id = category.replace(" ", "_")
        ns[f"prox_lite_cs_process_{leaf_id}"] = partial(
            _prox_lite_cs_filter_subject, subject=category)


_prox_cs_leaf_partials()


_BELEBELE_LETTERS = "ABCD"


def belebele_cs_doc_to_text(doc, lm_eval_config=None):
    """Passage + question + A-D options, letter-answer cue.

    Same shape as the other uplift letter twins (instruction line, 'P:'/'Q:'
    block like built-in belebele, 'X. option' lines, 'Odpověď:' cue), 0-shot
    like arc_challenge_chat — built-in belebele has no few-shot pool of its
    own and reading comprehension needs no demonstration beyond the cue.
    """
    parts = [
        "Přečtěte si pasáž a vyberte správnou odpověď. Odpovězte jedním "
        "písmenem (A, B, C nebo D).",
        f"P: {str(doc['flores_passage']).strip()}",
        f"Q: {str(doc['question']).strip()}",
    ]
    for i, letter in enumerate(_BELEBELE_LETTERS):
        parts.append(f"{letter}. {doc[f'mc_answer{i + 1}']}")
    parts.append("Odpověď:")
    return "\n".join(parts)


def belebele_cs_doc_to_target(doc, lm_eval_config=None):
    """'A'..'D' from correct_answer_num ('1'..'4' — a STRING in this dataset)."""
    return _BELEBELE_LETTERS[int(doc["correct_answer_num"]) - 1]
