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
  * hellaswag / winogrande need no helper: their prompts are static-shape
    Jinja in the yamls (winogrande keeps classic's numeric 1/2 answer
    format on purpose — classic extracts ["1","2"], not letters).
"""
import re

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
