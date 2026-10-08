#!/usr/bin/env python3
"""REPL-4c: extract the System-1 decision-model task pack to pinned JSON.

Run ONCE with a python that has `datasets` installed (the mteb-env on the
dev box):

    ~/.omlx/uplift/mteb-env/bin/python scripts/extract_systemone_packs.py

Writes omlx_uplift/evals/systemone/data/*.json + manifest.json. Runtime
needs NO network and NO datasets install: the loader ships with the
package and reads the JSON (card 4c: "Task pack ships as JSON fixtures +
loader so datasets are pinned and downloadable offline-first").

Item shape (uniform across packs — the engine knows nothing about
sources):
    {"id": str, "state": str, "options": {"a": str, ...}, "answer": "a"}
choice accuracy scores the answer directly; calibration adds a DERIVED
noul leg per item at run time (proposition = gold option text -> true, a
deterministic distractor option -> false), so probability questions
exist without fixture bloat; rubric consistency re-asks the same item
with option keys permuted (position-bias test).

Determinism: fixed SEED, index-sorted sampling, caps. Every pack records
source, licence, split and sample size — provenance travels with the
data.

Licences verified at extraction time via the HF dataset cards:
  allenai/ai2_arc (ARC-Challenge)  CC-BY-SA-4.0
  oskarvanderwal/bbq (All)         CC-BY-4.0
  truthfulqa/truthful_qa (mc1)     Apache-2.0
All three allow redistribution of derived subsets with attribution;
attribution is recorded in manifest.json next to the data.
"""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

SEED = 20261008
OUT = Path(__file__).resolve().parent.parent / "omlx_uplift" / "evals" / "systemone" / "data"


def _arc(r: dict) -> dict:
    """ARC-Challenge row -> choice item. answerKey 'A'..'E' -> 'a'..'e'."""
    texts = [t.strip() for t in r["choices"]["text"]]
    gi = ord(r["answerKey"]) - 65          # 'A' -> 0
    if not (0 <= gi < len(texts)):
        raise ValueError("answerKey out of range")
    return {
        "id": "arc-" + str(r["id"]),
        "state": "Question: " + r["question"].strip() + "\nWhat is the correct answer?",
        "options": {chr(97 + i): t for i, t in enumerate(texts)},
        "answer": chr(97 + gi),
    }


def _bbq(r: dict) -> dict:
    """BBQ ambiguous-context item -> choice (safety routing: the gold
    answer is frequently 'Can't be determined', so this pack scores
    refuse-to-route behaviour too)."""
    return {
        "id": "bbq-%s-%s" % (r["example_id"], r["question_index"]),
        "state": r["context"].strip() + "\n" + r["question"].strip(),
        "options": {"a": r["ans0"].strip(), "b": r["ans1"].strip(),
                    "c": r["ans2"].strip()},
        "answer": chr(97 + int(r["label"])),
    }


def _tqa(r: dict) -> dict:
    """TruthfulQA mc1 -> choice. The mc1 gold lives nested:
    mc1_targets = {choices: [...], labels: [0/1, ...]} with exactly one 1
    (field name is 'labels', plural — a silent per-row KeyError here once
    zeroed the whole pack)."""
    m = r["mc1_targets"]
    texts = [c.strip() for c in m["choices"]]
    ones = [i for i, l in enumerate(m["labels"]) if int(l) == 1]
    if len(ones) != 1:
        raise ValueError("mc1 must have exactly one gold option")
    return {
        "id": "tqa-" + str(r["_row"]),
        "state": r["question"].strip(),
        "options": {chr(97 + i): t for i, t in enumerate(texts)},
        "answer": chr(97 + ones[0]),
    }


PACKS = {
    "arc-choice": {"dataset": ("allenai/ai2_arc", "ARC-Challenge"),
                   "split": "test", "cap": 300, "license": "CC-BY-SA-4.0",
                   "build": _arc},
    "bbq-choice": {"dataset": ("oskarvanderwal/bbq", "All"),
                   "split": "test", "cap": 300, "license": "CC-BY-4.0",
                   "build": _bbq},
    "tqa-choice": {"dataset": ("truthfulqa/truthful_qa", "multiple_choice"),
                   "split": "validation", "cap": 400, "license": "Apache-2.0",
                   "build": _tqa},
}


def main() -> None:
    from datasets import load_dataset  # extraction-time only dependency

    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {"seed": SEED, "packs": {}}
    for name, spec in PACKS.items():
        path, cfg = spec["dataset"]
        ds = load_dataset(path, cfg, split=spec["split"])
        rng = random.Random(SEED)
        picked = sorted(rng.sample(range(len(ds)), min(spec["cap"], len(ds))))
        items = []
        skipped = 0
        first_err = ""
        seen_ids = set()
        for i in picked:
            r = dict(ds[i])          # datasets rows: plain dict copy
            r["_row"] = i
            try:
                it = spec["build"](r)
                # source example_id is NOT unique across BBQ's per-category
                # example numbering — the row index makes ids collision-free
                it["id"] += "-r" + str(i)
                if it["id"] in seen_ids:
                    raise ValueError("duplicate id " + it["id"])
            except (ValueError, KeyError) as e:
                skipped += 1
                first_err = first_err or f"{type(e).__name__}: {e}"
                continue             # malformed source row; count is honest
            seen_ids.add(it["id"])
            items.append(it)
        # A whole-pack failure usually means a schema typo in the builder;
        # a silently-empty fixture is the worst outcome for an eval pack.
        if not items:
            raise SystemExit(f"{name}: ZERO items extracted (first error: {first_err})")
        if skipped > spec["cap"] // 5:
            print(f"WARNING {name}: {skipped}/{len(picked)} rows skipped "
                  f"(first error: {first_err})")
        items.sort(key=lambda d: d["id"])
        blob = json.dumps({"name": name, "license": spec["license"],
                           "source": f"{path} ({cfg}) split={spec['split']}",
                           "items": items},
                          ensure_ascii=False, indent=1)
        (OUT / f"{name}.json").write_text(blob + "\n")
        digest = hashlib.sha256((blob + "\n").encode()).hexdigest()
        manifest["packs"][name] = {
            "source": f"{path} ({cfg}) split={spec['split']}",
            "license": spec["license"],
            "items": len(items),
            "sha256": digest,
        }
        print(f"{name}: {len(items)} items -> {digest[:12]}")
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")
    print("manifest written")


if __name__ == "__main__":
    main()
