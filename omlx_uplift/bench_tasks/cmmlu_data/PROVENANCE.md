# CMMLU — vendored dataset provenance

Everything in this directory is **data, not code**. The repo's Apache-2.0
licence covers the surrounding source; it does **not** cover these JSONL
files. Read `Licence` below before redistributing this package.

## What this is

CMMLU: *Measuring Massive Multitask Language Understanding in Chinese*
(Haonan Li, Yixuan Zhang, Fajri Koto, Yifei Yang, Hai Zhao, Yeyun Gong,
Nan Duan, Timothy Baldwin), arXiv:2306.09212 — 67 Chinese-language
multiple-choice subjects, four options (A–D) per question.

```bibtex
@misc{li2023cmmlu,
      title={CMMLU: Measuring massive multitask language understanding in Chinese},
      author={Haonan Li and Yixuan Zhang and Fajri Koto and Yifei Yang and Hai Zhao and Yeyun Gong and Nan Duan and Timothy Baldwin},
      year={2023},
      eprint={2306.09212},
      archivePrefix={arXiv},
      primaryClass={cs.CL}
}
```

## Why it is vendored instead of downloaded

The harness twin (`../yamls/uplift_cmmlu_generative.yaml`) cannot reach
this dataset through the hub from the pinned bench environment:

* `haonan-li/cmmlu` **301-redirects to `lmlmcat/cmmlu`** (repo renamed
  2023-07-13); both names resolve to the same content.
* The repo ships exactly three files: `README.md`, `cmmlu.py` (a
  `datasets.GeneratorBasedBuilder` **loader script**) and
  `cmmlu_v1_0_1.zip`. There is **no auto-converted parquet** on the hub,
  so there is nothing for `datasets` to read without executing the
  script.
* `datasets` 5.x — the major version in `~/.omlx/uplift/bench-env`
  (lm_eval 0.4.13) — refuses loader scripts outright (`"Dataset scripts
  are no longer supported"`). Even lm_eval's own built-in `cmmlu_*`
  multiple_choice tasks (which point at `dataset_path: haonan-li/cmmlu`)
  fail to load there; that was the 2026-10-14 probe that first put cmmlu
  in `NOT_HARNESS`.
* The user verdict of 2026-10-14 overrode that refusal: rather than leave
  cmmlu on the classic engine, the data is extracted **offline** from the
  hub's own zip and committed, and the twin loads it with a
  `custom_dataset` function. Nothing in the suite touches the network
  (proven with `HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1`).

## Source snapshot (pinned, verifiable)

| item | value |
|---|---|
| Hub dataset id | `haonan-li/cmmlu` → renamed `lmlmcat/cmmlu` (same repo) |
| Resolved revision (data snapshot) | `efcc940752ea4a1ea94d2727f11f83858d64fc8e` |
| Last modified upstream | 2023-07-13T10:19:29Z |
| Fetched | 2026-10-14 (CEST) |
| File fetched | `cmmlu_v1_0_1.zip` (1078656 bytes) |
| SHA-256 of the zip | `22ecf70b28bef447ee7d8aa5fe144f56996762f901a8537b03b7693773c672a6` |
| URL | `https://huggingface.co/datasets/lmlmcat/cmmlu/resolve/efcc940752ea4a1ea94d2727f11f83858d64fc8e/cmmlu_v1_0_1.zip` |
| Loader script read for the contract | `cmmlu.py` at the same revision (`task_list` = the 67 subject ids, `test/<subject>.csv` + `dev/<subject>.csv`, `header=0, index_col=0, encoding=utf-8`) |

The revision is pinned by SHA, not `main`, so a later hub-side edit can
never silently change what a stored cmmlu score means.

## Extraction method

`../../../scripts/vendor_cmmlu.py` (stdlib only: `zipfile` + `csv` +
`json`). It replicates what the loader script does — unzip, read
`{split}/{subject}.csv`, first column is the row index — **without
executing any dataset script** and without `pandas`/`datasets`.

Per row:

* header must be exactly `['', 'Question', 'A', 'B', 'C', 'D', 'Answer']`
  (the leading empty name is the unnamed index column);
* question and the four options are stored **verbatim** — no `.strip()`.
  This matters: classic's prompt builder prints the value as-is
  (`omlx/eval/cmmlu.py::_format_question`), and the upstream CSVs do carry
  trailing spaces on some questions (e.g. agronomy) and one leading space
  (world_religions row 121 in the zip). Stripping them here would silently
  change the scored prompt;
* `answer` is validated to be one of `A`/`B`/`C`/`D` (all 11917 rows
  already are, so `.upper()` is a no-op, kept as a guard);
* ragged rows / empty questions / empty options abort the extraction —
  none were found in this snapshot.

Row schema (one JSON object per line, UTF-8, non-ASCII kept literal):

```json
{"row_id": 0, "question": "…", "choices": ["…", "…", "…", "…"], "answer": "B", "subject": "agronomy"}
```

`row_id` is the source CSV's own index column. The cmmlu few-shot helper
uses it to attach the instruction line to the first example only — see
`../yamls/uplift_cmmlu_generative.yaml`.

## Contents and row counts

| split | files | rows | on disk | role in the twin |
|---|---|---|---|---|
| `test/` | 67 (one per subject) | **11582** | 3.5 MB | evaluated split (`test_split: test`) |
| `dev/` | 67 (one per subject) | **335** (exactly 5 per subject) | 268 KB | 5-shot pool (`fewshot_split: dev`, `first_n` sampler) |
| total | 134 | 11917 | **3.8 MB** | |

Per-subject test rows (dev is 5 everywhere):

```
agronomy 169            anatomy 148             ancient_chinese 164
arts 160                astronomy 165           business_ethics 209
chinese_civil_service_exam 160  chinese_driving_rule 131  chinese_food_culture 136
chinese_foreign_policy 107      chinese_history 323       chinese_literature 204
chinese_teacher_qualification 179  clinical_knowledge 237  college_actuarial_science 106
college_education 107   college_engineering_hydrology 106  college_law 108
college_mathematics 105 college_medical_statistics 106     college_medicine 273
computer_science 204    computer_security 171   conceptual_physics 147
construction_project_management 139  economics 159  education 163
electrical_engineering 172  elementary_chinese 252  elementary_commonsense 198
elementary_information_and_technology 238  elementary_mathematics 230  ethnology 135
food_science 143        genetics 176            global_facts 149
high_school_biology 169 high_school_chemistry 132  high_school_geography 118
high_school_mathematics 164  high_school_physics 110  high_school_politics 143
human_sexuality 126     international_law 185   journalism 172
jurisprudence 411       legal_and_moral_basis 214  logical 123
machine_learning 122    management 210          marketing 180
marxist_theory 189      modern_chinese 116      nutrition 145
philosophy 105          professional_accounting 175  professional_law 211
professional_medicine 376  professional_psychology 232  public_relations 174
security_study 135      sociology 226           sports_science 165
traditional_chinese_medicine 185  virology 169  world_history 161
world_religions 160
```

Re-check at any time (no network needed once the zip is on disk):

```
python3 scripts/vendor_cmmlu.py --verify                  # repo == pinned zip
python3 scripts/vendor_cmmlu.py --compare-bundle <omlx>/eval/data   # == classic
```

## Parity with classic (the classic engine's own copy)

classic evaluates `omlx/eval/data/cmmlu_test.jsonl` shipped inside the
omlx package and takes its few-shot pool from `cmmlu_dev.jsonl`. Compared
row-by-row (as multisets of `subject`/`question`/`choices`/`answer`):

* **test: 11582 / 11582 identical** — same rows, same per-subject order
  (`scripts/vendor_cmmlu.py --compare-bundle` prints it; the classic
  bundle's subject blocks are in a different order, its per-subject row
  order matches the CSVs).
* **dev: identical for every subject classic has a pool for** — but
  classic's `cmmlu_dev.jsonl` holds only **50 rows covering 10 of the 67
  subjects** (agronomy, business_ethics, college_actuarial_science,
  college_engineering_hydrology, global_facts, high_school_mathematics,
  high_school_physics, high_school_politics, logical, professional_law:
  exactly the first 10 dev CSVs in the zip). At runtime that means classic
  prompts **5-shot for 10 subjects and 0-shot for 57**, while
  `omlx/eval/cmmlu.py` documents 5-shot. The vendored `dev/` is the full
  67 × 5 (upstream's own dev split), so the twin is 5-shot everywhere and
  its pool rows for those 10 subjects are byte-identical to classic's.
  This is a classic-side data gap, deliberately **not** copied; the
  divergence wave must quantify it before any cmmlu score comparison
  (classic vs harness) is read as a model difference.
* Prompt text parity was verified end to end: the harness context for 30
  docs across all 10 dev-backed subjects is **byte-identical** to
  `CMMLUBenchmark.format_prompt(...)[0]['content']` rendered by the
  installed classic module.

## Licence — what was actually found, and the verdict

Found on 2026-10-14, checked at both sources:

| place | statement |
|---|---|
| HF hub API metadata (`/api/datasets/lmlmcat/cmmlu`, `cardData.license` and the `license:` tag) | **`cc-by-nc-4.0`** |
| HF dataset card `README.md` front-matter | `license: cc-by-nc-4.0` |
| HF dataset card `README.md`, `## License` section | "The CMMLU dataset is licensed under a [Creative Commons **Attribution-NonCommercial-ShareAlike** 4.0 International License](http://creativecommons.org/licenses/by-nc-sa/4.0/)." |
| Upstream code repo `github.com/haonan-li/CMMLU` | **no LICENSE file** (GitHub licence API returns `null`); its README repeats the CC BY-NC-SA 4.0 sentence above |
| inside `cmmlu_v1_0_1.zip` | CSVs only, no licence file |
| `cmmlu.py` loader script | Apache-2.0 header — that is the *HuggingFace dataset-script template* (Copyright 2020 The HuggingFace Datasets Authors), it covers the script, **not** the data |

The hub's structured tag (CC BY-NC 4.0) and its own prose (CC BY-NC-SA
4.0) **disagree**; upstream's only authoritative-looking statement is the
prose, which is the stricter of the two. This directory is therefore
maintained as **CC BY-NC-SA 4.0** and the differences are recorded rather
than quietly resolved.

Verdict for vendoring (both readings agree on the points that matter):

* **Sharing/redistributing the data is permitted** by CC BY 4.0's
  ancestry: both variants allow copying and adapting, unconditionally for
  non-commercial purposes, subject to attribution. Nothing here is
  "all-rights-reserved" or download-gated, and no licence text forbids
  the copy in this repo.
* **Attribution is required** and is provided above (authors, title,
  arXiv id, source revision, this file).
* **NonCommercial** restricts *use of the data* to non-commercial
  purposes. Vendoring does not add that restriction to omlx-uplift's
  code, and does not remove it from the data: whoever runs a benchmark
  over CMMLU is bound by it. Note this is not new to this stack — classic
  omlx has shipped `cmmlu_test.jsonl`/`cmmlu_dev.jsonl` inside its own
  wheel (Apache-2.0 labelled, with **no** data-licence note there) since
  before this change; this file, and the `NON-COMMERCIAL` marker below,
  are strictly more explicit than that.
* **ShareAlike** (only under the prose reading) requires adaptations to
  carry the same licence. These JSONL files are an adaptation of the
  published CSVs, so they are offered under CC BY-NC-SA 4.0 as well and
  are **not** relicensed as Apache-2.0.

Practical rule for anyone repackaging this: ship `cmmlu_data/` with this
`PROVENANCE.md`, keep it out of the Apache-2.0 claim, and flag the
non-commercial term where the benchmark is offered.

```
CMMLU data in this directory: © Haonan Li, Yixuan Zhang, Fajri Koto,
Yifei Yang, Hai Zhao, Yeyun Gong, Nan Duan, Timothy Baldwin;
adapted from https://huggingface.co/datasets/lmlmcat/cmmlu
(revision efcc940752ea4a1ea94d2727f11f83858d64fc8e) under
CC BY-NC-SA 4.0 (hub tag says CC BY-NC 4.0 — see table above). NON-COMMERCIAL USE ONLY.
```
