"""UP-60: prove the tap formula matches the source tree a dev build uses.

`omlx-uplift dev install` re-cuts `uplift-dev` from a FRESH fetch of
jundot/omlx main, but the FORMULA it builds with is the tap checkout on disk,
which only moves with `brew update`. The two feed different decisions of the
same build: the source tree's ``pyproject.toml`` says which mlx-lm / mlx-audio
commits to install (pip step 02) and the tap's ``Formula/omlx.rb`` stages and
installs the same resources AGAIN, last (step 04). When they disagree, the last
pip step wins and the engine dies at import - while the build reported success.
Measured on 2026-10-29: source wanted mlx-audio 0.6.3, a lagging tap installed
0.4.3 over it, and ``from mlx_lm.generate import GenerationBatch`` failed at
boot on a keg brew had called healthy.

Three guards, all ours, nothing written to upstream files:

1. :func:`pre_build_findings` (before anything expensive): every resource our
   ``Formula/omlx-dev.rb`` re-declares must equal the parent tap formula's, and
   the parent's must equal what the SOURCE tree pins. A disagreement refuses the
   build and names the line to bump (or the ``brew update`` that fixes it).
2. :func:`post_build_probes` (after the keg exists, BEFORE the link switch): the
   new keg's own interpreter must import the engine entry module. A bad
   resolution becomes a failed install with the old keg still live, instead of a
   server that cannot start.
3. the same probe runs the parent formula's OWN self-check statements
   (spaCy + model, mlx_audio, mlx_vlm, mlx_lm GenerationBatch). Both walls of
   2026-10-29 were visible only at that level.

Escape hatch: ``omlx-uplift dev install --force`` (findings become warnings). An
unverifiable comparison (no tap checkout, no network) never blocks a build; an
actual mismatch does.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field

# Our tap is a checkout of this very repo; the parent formula is the vanilla one.
DEV_TAP_REL = ("Library", "Taps", "zviratko", "homebrew-uplift")
PARENT_TAP_REL = ("Library", "Taps", "jundot", "homebrew-omlx")
DEV_FORMULA = ("Formula", "omlx-dev.rb")
PARENT_FORMULA = ("Formula", "omlx.rb")
PARENT_FORMULA_RAW = ("https://raw.githubusercontent.com/jundot/omlx/main/"
                      "Formula/omlx.rb")

# Import statements the finished keg must satisfy, in the order an operator
# should hear about them. 'entry' is what the server imports first; the rest
# are the parent formula's own self-check statements.
PROBES: list[tuple[str, str, str]] = [
    ("entry", "import omlx.scheduler",
     "the engine's own module graph (omlx.scheduler)"),
    ("mlx-lm batch", "from mlx_lm.generate import GenerationBatch",
     "mlx-lm new enough for omlx's scheduler"),
    ("mlx-audio", "import mlx_audio.stt, mlx_audio.tts",
     "the audio stack (TTS/STT)"),
    ("mlx-vlm", "import mlx_vlm", "vision support"),
    ("spacy", "import spacy; spacy.load('en_core_web_sm')",
     "spaCy and its bundled English model"),
]

_RESOURCE_RE = re.compile(
    r'^[ \t]*resource\s+"(?P<name>[^"]+)"\s+do\b(?P<body>.*?)^[ \t]*end\b',
    re.MULTILINE | re.DOTALL)
_REV_RE = re.compile(r'revision\s*:\s*"([0-9a-f]{7,40})"')
_SHA_RE = re.compile(r'sha256\s*:?\s*"([0-9a-f]{64})"')
_URL_RE = re.compile(r'url\s+"([^"]+)')
# pyproject: "mlx-audio @ git+https://github.com/X/Y@<sha>"
_PIN_RE = re.compile(
    r'["\'](?P<name>[A-Za-z0-9._-]+)\s*@\s*git\+https?://[^@"\']+@'
    r'(?P<sha>[0-9a-f]{7,40})["\']')


@dataclass
class Resource:
    name: str
    url: str | None = None
    revision: str | None = None
    sha256: str | None = None
    line: int = 0


@dataclass
class Finding:
    """One refusal (or warning under --force). ``text`` is operator-facing."""
    kind: str
    text: str
    fix: str = ""
    details: list[str] = field(default_factory=list)

    def render(self) -> str:
        out = [self.text]
        out += ["  " + d for d in self.details if d]
        if self.fix:
            out.append("  fix: " + self.fix)
        return "\n".join(out)


def _strip_comments(text: str) -> str:
    return "\n".join("" if ln.lstrip().startswith("#") else ln
                     for ln in text.splitlines())


def parse_resources(formula_text: str) -> dict[str, Resource]:
    """Every ``resource "<name>"`` block of a Homebrew formula.

    Returns name -> Resource (revision for git urls, sha256 for release
    artifacts). Comments are ignored so a commented-out resource never counts.
    """
    body = _strip_comments(formula_text)
    out: dict[str, Resource] = {}
    for m in _RESOURCE_RE.finditer(body):
        block = m.group("body")
        rev = _REV_RE.search(block)
        sha = _SHA_RE.search(block)
        url = _URL_RE.search(block)
        name = m.group("name").strip().lower().replace("_", "-")
        out[name] = Resource(
            name=m.group("name"),
            url=url.group(1) if url else None,
            revision=rev.group(1) if rev else None,
            sha256=sha.group(1) if sha else None,
            line=formula_line_of(formula_text, m.group("name")))
    return out


def parse_source_pins(pyproject_text: str) -> dict[str, str]:
    """name -> commit a source tree pins through ``pkg @ git+https://...@sha``."""
    return {m.group("name").lower().replace("_", "-"): m.group("sha")
            for m in _PIN_RE.finditer(pyproject_text)}


def formula_line_of(text: str, resource_name: str) -> int:
    """1-based line of ``resource "<name>"`` in a formula (0 when absent)."""
    pat = re.compile(r'^[ \t]*resource\s+"' + re.escape(resource_name) + r'"',
                     re.MULTILINE)
    for i, ln in enumerate(text.splitlines(), start=1):
        if pat.match(ln):
            return i
    return 0


# ---------------------------------------------------------------- tap lookup

def tap_paths(brew_prefix: str | None = None) -> tuple[str, str]:
    """(dev formula, parent formula) paths on this box."""
    import os

    from . import paths as _paths

    root = brew_prefix or _paths.brew_prefix()
    return (os.path.join(root, *DEV_TAP_REL, *DEV_FORMULA),
            os.path.join(root, *PARENT_TAP_REL, *PARENT_FORMULA))


def parent_formula_text(parent_path: str, *, fetch=True) -> tuple[str, str]:
    """(text, where) for the parent formula; ("", "") when unreachable.

    The tap checkout first; when it is missing (a box that never ran
    ``brew tap``), fall back to the raw file on GitHub so the guard still has
    something to compare against.
    """
    import os

    try:
        if os.path.isfile(parent_path):
            with open(parent_path, encoding="utf-8") as fh:
                return fh.read(), parent_path
    except OSError:
        pass
    if not fetch:
        return "", ""
    try:
        from urllib.request import urlopen

        with urlopen(PARENT_FORMULA_RAW, timeout=20) as r:  # noqa: S310
            return r.read().decode("utf-8", "replace"), PARENT_FORMULA_RAW
    except Exception:
        return "", ""


# ------------------------------------------------------------- guard #1 (pre)

def pre_build_findings(pyproject_text: str | None, *,
                       source_label: str = "pyproject.toml",
                       brew_prefix: str | None = None) -> list[Finding]:
    """Dependency-coordinate findings for one build. [] = clear.

    ``pyproject_text`` is the dependency file of the COMMIT being built (the
    sync ref), not the working tree - the checkout still sits on the previous
    uplift-dev tip when a build starts. Checks, in order: our re-declared
    resources against the parent formula, and the parent formula against what
    the source pins. Both directions of skew produced a real wall on 2026-10-29.
    """
    import os

    findings: list[Finding] = []
    dev_path, parent_path = tap_paths(brew_prefix)
    try:
        with open(dev_path, encoding="utf-8") as fh:
            dev_text = fh.read()
    except OSError:
        # Nothing we can read means nothing to compare. The missing/stale dev
        # formula is already a hard error of its own (_ensure_versioned_formula
        # names the file and the pull command), so the guard stays out of it.
        return []
    parent_text, parent_where = parent_formula_text(parent_path)
    if not parent_text:
        findings.append(Finding(
            kind="unverifiable",
            text="dependency guard: no parent omlx formula to compare against "
                 f"({parent_path} absent, {PARENT_FORMULA_RAW} unreachable) - "
                 "continuing UNVERIFIED",
            fix="brew tap jundot/omlx (or restore network) so the guard can "
                "actually check the coordinates"))
        return findings

    ours = parse_resources(dev_text)
    theirs = parse_resources(parent_text)

    for name, res in sorted(ours.items()):
        par = theirs.get(name)
        if par is None:
            continue                      # ours alone: a deliberate addition
        diffs = []
        if bool(res.revision) != bool(par.revision):
            diffs.append(("coordinate type", res.revision or res.sha256,
                          par.revision or par.sha256))
        elif res.revision and res.revision != par.revision:
            diffs.append(("revision", res.revision, par.revision))
        elif res.sha256 and res.sha256 != par.sha256:
            diffs.append(("sha256", res.sha256, par.sha256))
        elif res.url and par.url and res.url.rstrip("/") != par.url.rstrip("/"):
            diffs.append(("url", res.url, par.url))
        for what, mine, their in diffs:
            line = formula_line_of(dev_text, res.name)
            findings.append(Finding(
                kind="formula-skew",
                text=f"dependency guard: our Formula/omlx-dev.rb re-declares "
                     f"'{res.name}' with a different {what} than the tap's "
                     f"omlx.rb (ours {str(mine)[:12]}, upstream "
                     f"{str(their)[:12]}). The last pip step wins, so the keg "
                     "would carry the OLDER of the two and the engine would "
                     "fail at import.",
                details=[f"{dev_path}:{line}: {res.name}"],
                fix=f"bump that resource to {their} (or: brew update if the "
                    f"tap checkout at {parent_where} is the stale side)"))

    # source tree vs parent formula (the tap-lags-source direction)
    pyproject = source_label
    pins = parse_source_pins(pyproject_text or "")
    for name, sha in sorted(pins.items()):
        par = theirs.get(name)
        if par is None or not par.revision:
            continue
        if not sha.startswith(par.revision) and not par.revision.startswith(sha):
            tap_root = os.path.dirname(os.path.dirname(
                os.path.dirname(parent_path)))
            findings.append(Finding(
                kind="tap-lag",
                text=f"dependency guard: the source tree pins {name}@{sha[:12]} "
                     f"but the tap's omlx.rb installs {name}@{par.revision[:12]} "
                     "afterwards - the tap checkout lags the source it is "
                     "building, and its pip step wins.",
                details=[pyproject, parent_path],
                fix=f"git -C {tap_root} pull --ff-only   (or: brew update)"))
    return findings


# ----------------------------------------------------------- guard #2/#3 (post)

def keg_python(keg_dir: str) -> str:
    import os

    return os.path.join(keg_dir, "libexec", "bin", "python")


def post_build_probes(python_path: str, *,
                      runner=subprocess.run) -> list[tuple[str, str]]:
    """[(label, error)] for a freshly built keg; [] when it is importable.

    One interpreter boot for all statements (an import storm costs seconds and
    a per-statement subprocess would pay the MLX/torch warm-up each time). The
    probe runs the NEW keg's own python, so nothing has to be linked or
    restarted yet - a failure leaves the live keg untouched.
    """
    script = (
        "import json,sys,traceback\n"
        "res=[]\n"
        f"probes={json.dumps([[l, s] for l, s, _ in PROBES])}\n"
        "for label, src in probes:\n"
        "    try:\n"
        "        exec(compile(src, '<probe>', 'exec'), {})\n"
        "        res.append([label, ''])\n"
        "    except BaseException as exc:\n"
        "        res.append([label, type(exc).__name__ + ': ' + str(exc)[:300]])\n"
        "print(json.dumps(res))\n")
    try:
        r = runner([python_path, "-c", script], capture_output=True, text=True,
                   timeout=600)
    except FileNotFoundError:
        return [("interpreter", f"no python at {python_path}") ]
    except Exception as exc:                       # timeout, OS error
        return [("interpreter", f"{type(exc).__name__}: {exc}")]
    line = (r.stdout or "").strip().splitlines()
    try:
        rows = json.loads(line[-1]) if line else []
    except json.JSONDecodeError:
        return [("probe output", (line[-1][:200] if line else
                                  f"no result (rc {r.returncode})"))]
    out = []
    for label, err in rows:
        if err:
            why = next((w for l, _s, w in PROBES if l == label), label)
            out.append((label, f"{err} - needs {why}"))
    return out
