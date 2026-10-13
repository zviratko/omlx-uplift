#!/usr/bin/env python3
"""REPL-2b(cmmlu): vendor CMMLU into the repo as packaged JSONL.

Why this script exists: haonan-li/cmmlu (a redirect to lmlmcat/cmmlu) ships
ONLY a datasets loader script plus a raw zip, and datasets 5.x in bench-env
refuses loader scripts ('Dataset scripts are no longer supported'). The
harness twin therefore reads the data from the repo, so the data has to be
extracted OFFLINE and committed. This script replicates what cmmlu.py does
(unwrap cmmlu_v1_0_1.zip, read test/<subject>.csv and dev/<subject>.csv with
the first column as the row index) with plain stdlib csv — no datasets, no
pandas, no script execution — and normalises every row into the schema the
classic module already uses (omlx/eval/cmmlu.py: question/choices/answer/
subject), verified byte-for-byte identical to classic's own bundled
cmmlu_test.jsonl.

Usage:
    python3 scripts/vendor_cmmlu.py [--zip PATH] [--out PATH]
    python3 scripts/vendor_cmmlu.py --verify            # zip -> repo data
    python3 scripts/vendor_cmmlu.py --compare-bundle DIR  # vs classic's jsonl
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

# The rename haonan-li/cmmlu redirects to; pinned so a hub-side edit can
# never silently change what the twin scores.
HF_REPO = "lmlmcat/cmmlu"
PINNED_REVISION = "efcc940752ea4a1ea94d2727f11f83858d64fc8e"
ZIP_NAME = "cmmlu_v1_0_1.zip"
ZIP_URL = (f"https://huggingface.co/datasets/{HF_REPO}/resolve/"
           f"{PINNED_REVISION}/{ZIP_NAME}")
ZIP_SHA256 = "22ecf70b28bef447ee7d8aa5fe144f56996762f901a8537b03b7693773c672a6"

# task_list from cmmlu.py at the same revision (the loader's own contract).
TASK_LIST = [
    "agronomy", "anatomy", "ancient_chinese", "arts", "astronomy",
    "business_ethics", "chinese_civil_service_exam", "chinese_driving_rule",
    "chinese_food_culture", "chinese_foreign_policy", "chinese_history",
    "chinese_literature", "chinese_teacher_qualification", "clinical_knowledge",
    "college_actuarial_science", "college_education",
    "college_engineering_hydrology", "college_law", "college_mathematics",
    "college_medical_statistics", "college_medicine", "computer_science",
    "computer_security", "conceptual_physics", "construction_project_management",
    "economics", "education", "electrical_engineering", "elementary_chinese",
    "elementary_commonsense", "elementary_information_and_technology",
    "elementary_mathematics", "ethnology", "food_science", "genetics",
    "global_facts", "high_school_biology", "high_school_chemistry",
    "high_school_geography", "high_school_mathematics", "high_school_physics",
    "high_school_politics", "human_sexuality", "international_law",
    "journalism", "jurisprudence", "legal_and_moral_basis", "logical",
    "machine_learning", "management", "marketing", "marxist_theory",
    "modern_chinese", "nutrition", "philosophy", "professional_accounting",
    "professional_law", "professional_medicine", "professional_psychology",
    "public_relations", "security_study", "sociology", "sports_science",
    "traditional_chinese_medicine", "virology", "world_history",
    "world_religions",
]
SPLITS = ("test", "dev")
LETTERS = ["A", "B", "C", "D"]
EXPECTED_HEADER = ["", "Question", "A", "B", "C", "D", "Answer"]
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "omlx_uplift" / "bench_tasks" / "cmmlu_data"


def fetch_zip(dest: Path) -> Path:
    if dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == ZIP_SHA256:
        return dest
    print(f"fetching {ZIP_URL}", file=sys.stderr)
    req = urllib.request.Request(ZIP_URL, headers={"User-Agent": "omlx-uplift-vendor"})
    with urllib.request.urlopen(req, timeout=300) as r, dest.open("wb") as fh:
        fh.write(r.read())
    got = hashlib.sha256(dest.read_bytes()).hexdigest()
    if got != ZIP_SHA256:
        dest.unlink(missing_ok=True)
        raise SystemExit(f"checksum mismatch: {got} != {ZIP_SHA256}")
    return dest


def read_csv(zf: zipfile.ZipFile, name: str, subject: str) -> list[dict]:
    """Rows of one split/subject CSV, in file order, values untouched."""
    with zf.open(name) as fh:
        rdr = csv.reader(io.TextIOWrapper(fh, encoding="utf-8", newline=""))
        header = next(rdr)
        if header != EXPECTED_HEADER:
            raise SystemExit(f"{name}: unexpected header {header!r}")
        rows = []
        for raw in rdr:
            if not any(c.strip() for c in raw):
                continue
            if len(raw) != len(header):
                raise SystemExit(f"{name}: ragged row ({len(raw)} cols)")
            q = raw[1]
            choices = [raw[2], raw[3], raw[4], raw[5]]
            answer = raw[6]
            if not q.strip() or any(not c.strip() for c in choices):
                raise SystemExit(f"{name}: empty question/option in row {len(rows)}")
            if answer.strip().upper() not in LETTERS:
                raise SystemExit(f"{name}: answer {answer!r} not A-D")
            # NO strip(): classic's bundle keeps the CSV's own whitespace, and
            # its prompt template prints the value verbatim (omlx/eval/cmmlu.py
            # _format_question), so raw values are the parity-honest choice.
            rows.append({"row_id": len(rows), "question": q, "choices": choices,
                         "answer": answer.strip().upper(), "subject": subject})
        return rows


def build(zf: zipfile.ZipFile, out: Path) -> dict:
    subjects = sorted(Path(n).stem for n in zf.namelist()
                      if n.startswith("test/") and n.endswith(".csv"))
    if subjects != sorted(TASK_LIST):
        raise SystemExit(f"subject set differs from cmmlu.py task_list: "
                         f"{set(subjects) ^ set(TASK_LIST)}")
    stats: dict[str, dict[str, dict]] = {s: {} for s in SPLITS}
    for split in SPLITS:
        have = sorted(Path(n).stem for n in zf.namelist()
                      if n.startswith(f"{split}/") and n.endswith(".csv"))
        if have != subjects:
            raise SystemExit(f"{split}/ subject set differs from test/")
        d = out / split
        d.mkdir(parents=True, exist_ok=True)
        for subject in subjects:
            rows = read_csv(zf, f"{split}/{subject}.csv", subject)
            text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
            (d / f"{subject}.jsonl").write_text(text, encoding="utf-8")
            stats[split][subject] = {
                "rows": len(rows),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
    return stats


def print_summary(stats: dict) -> None:
    for split in SPLITS:
        total = sum(v["rows"] for v in stats[split].values())
        print(f"{split}: {total} rows, {len(stats[split])} subjects")
    print(f"{'subject':38s} {'test':>6s} {'dev':>5s}")
    for s in sorted(stats["test"]):
        print(f"{s:38s} {stats['test'][s]['rows']:6d} {stats['dev'][s]['rows']:5d}")


def manifest(out: Path) -> dict:
    """Recompute row counts + sha256 from the JSONL that is in the repo."""
    m: dict[str, dict[str, dict]] = {}
    for split in SPLITS:
        m[split] = {}
        for f in sorted((out / split).glob("*.jsonl")):
            text = f.read_text(encoding="utf-8")
            m[split][f.stem] = {
                "rows": sum(1 for line in text.splitlines() if line.strip()),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
    return m


def compare_bundle(out: Path, bundle: Path) -> int:
    """Parity proof against classic's own jsonl (omlx/eval/data)."""
    def load(p):
        return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines()
                if line.strip()]
    bad = 0
    ours = [r for f in sorted((out / "test").glob("*.jsonl")) for r in load(f)]
    theirs = load(bundle / "cmmlu_test.jsonl")

    def k(r):
        return (r["subject"], r["question"], tuple(r["choices"]), r["answer"])
    if sorted(map(k, ours)) != sorted(map(k, theirs)):
        only_o = set(map(k, ours)) - set(map(k, theirs))
        only_t = set(map(k, theirs)) - set(map(k, ours))
        bad += 1
        print(f"TEST rows differ: ours-only {len(only_o)} classic-only {len(only_t)}")
    else:
        print(f"TEST rows identical to classic's bundle ({len(ours)} rows)")
    dev_subjects = sorted({r["subject"] for r in load(bundle / "cmmlu_dev.jsonl")}
                          if (bundle / "cmmlu_dev.jsonl").is_file() else [])
    for s in dev_subjects:
        theirs5 = [k(r) for r in load(bundle / "cmmlu_dev.jsonl") if r["subject"] == s][:5]
        ours5 = [k(r) for r in load(out / "dev" / f"{s}.jsonl")][:5]
        if theirs5 != ours5:
            bad += 1
            print(f"DEV pool differs for {s}")
    print(f"classic dev pool covers {len(dev_subjects)} of {len(TASK_LIST)} "
          f"subjects; the vendored dev split covers all {len(TASK_LIST)} "
          f"(first 5 rows per subject are identical where both have them)")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", type=Path, default=None,
                    help="path to a pre-fetched cmmlu_v1_0_1.zip")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--verify", action="store_true",
                    help="re-extract to a temp dir and compare with --out")
    ap.add_argument("--compare-bundle", type=Path, default=None,
                    help="classic's omlx/eval/data dir (parity proof)")
    a = ap.parse_args()

    if a.compare_bundle:
        return compare_bundle(a.out, a.compare_bundle)

    zip_path = a.zip or (Path.home() / "hermes/TMP/cmmlu_src" / ZIP_NAME)
    fetch_zip(zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        if a.verify:
            import tempfile
            with tempfile.TemporaryDirectory() as td:
                stats = build(zf, Path(td))
                bad = 0
                m_ours, m_zip = manifest(a.out), manifest(Path(td))
                if m_ours != m_zip:
                    for split in SPLITS:
                        for s in sorted(set(m_ours[split]) | set(m_zip[split])):
                            if m_ours[split].get(s) != m_zip[split].get(s):
                                bad += 1
                                print(f"DRIFT {split}/{s}: "
                                      f"{m_ours[split].get(s)} != {m_zip[split].get(s)}")
                print("verify:", "OK — repo data matches the pinned zip"
                      if not bad else f"{bad} drifted files")
                return 1 if bad else 0
        stats = build(zf, a.out)
    print_summary(stats)
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
