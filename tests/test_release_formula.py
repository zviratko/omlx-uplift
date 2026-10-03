"""Release integrity: the formula, the package version and the stable
constraints file must describe the SAME release (REL-1, 2026-10-03).

The tap IS this repo (zviratko/omlx-uplift), so a formula edit and a
version bump are ordinary commits — which is exactly how they can drift
apart. These tests pin the invariants that make `brew install` (stable
tag) and `brew install --HEAD` (main) honest:

1. Formula `tag: "v..."` == "v" + omlx_uplift.__version__.
   The release commit carries both, so this can only break by someone
   bumping one and not the other.
2. HEAD-only constraint: the formula's stable pip install must use
   `constraints-stable.txt`; the HEAD block must NOT (head floats).
3. constraints-stable.txt pins every runtime dependency of the built
   venv (fastapi/uvicorn at minimum) — floating pins are not pins.

Historical tags v0.1/v0.9b predate this rule and are not checked; v1.0
is the first release cut under it.
"""

import re
from pathlib import Path

import omlx_uplift

ROOT = Path(__file__).resolve().parents[1]
FORMULA = ROOT / "Formula" / "omlx-uplift.rb"
PINS = ROOT / "constraints-stable.txt"


def _formula_text() -> str:
    return FORMULA.read_text(encoding="utf-8")


def test_formula_tag_matches_package_version():
    m = re.search(r'^\s*url\s+"[^"]+",\s*tag:\s*"(v[^"]+)"',
                  _formula_text(), re.MULTILINE)
    assert m, "formula: no `url ..., tag: \"v...\"` line found"
    tag = m.group(1)
    assert tag == f"v{omlx_uplift.__version__}", (
        f"formula stable tag {tag!r} != package version "
        f"{omlx_uplift.__version__!r} — release commits must change both")


def test_formula_has_head_line_on_main():
    assert re.search(r'^\s*head\s+"[^"]+",\s*branch:\s*"main"',
                     _formula_text(), re.MULTILINE), \
        "formula lost its `head ..., branch: \"main\"` line"


def test_stable_pip_install_uses_constraints_head_does_not():
    text = _formula_text()
    stable = re.search(r'system libexec/"bin/pip", "install", "-c",\s*'
                       r'(?:\\\s*)?buildpath/"constraints-stable\.txt"', text)
    assert stable, ("formula: the fastapi/uvicorn pip install must be "
                    "constraint-pinned for stable builds "
                    "(-c buildpath/constraints-stable.txt)")
    # brew runs ONE install() body for both specs; the split is an
    # explicit head? branch. Require it — and require the head side to
    # carry NO '-c' on its own pip line, i.e. HEAD really floats.
    assert re.search(r'if\s+head\?', text), \
        "formula: no head? branch — stable/HEAD cannot differ"
    float_line = re.search(
        r'if\s+head\?\s*\n\s*system libexec/"bin/pip", "install",\s*'
        r'(?!.*"-c")"fastapi",\s*"uvicorn"', text)
    assert float_line, "formula: the head? branch must pip-install " \
        "fastapi/uvicorn WITHOUT -c (HEAD floats by design, REL-1)"


def test_constraints_pin_core_deps():
    assert PINS.is_file(), "constraints-stable.txt missing from the repo"
    pins = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s]+)$",
                           PINS.read_text(encoding="utf-8"), re.MULTILINE))
    for dep in ("fastapi", "uvicorn"):
        assert dep in pins, f"{dep} not pinned in constraints-stable.txt"
