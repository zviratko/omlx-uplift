"""brew keg utilities: python paths, the .pth mount, brew build command
shape, INSTALL_RECEIPT introspection.

BE-1: cli.cmd_dev_install used to BE the omlx-dev build engine — the
dashboard ran its PRINT code in-process and scraped 'RESULT:' lines. The
engine moved to devsrc.run_dev_build; everything it needs from the CLI
world (brew command shape, receipt options, the dev-keg .pth mount) lives
here instead, so devsrc never imports cli and neither side reaches for
the other's private names. cli keeps thin aliases for its existing users.
"""

from __future__ import annotations

import os
import site
import subprocess
import sys
from pathlib import Path

PTH_NAME = "omlx_uplift.pth"


def resolve_site_packages(python: str | None) -> Path:
    code = (
        "import site,sys; ps=site.getsitepackages()"
        "if hasattr(site,'getsitepackages') and site.getsitepackages() "
        "else [site.getusersitepackages()]; print(ps[0])"
    )
    if python:
        out = subprocess.run(
            [python, "-c", code], capture_output=True, text=True, check=True
        )
        return Path(out.stdout.strip())
    # current interpreter: prefer the *real* install over user-site
    for p in site.getsitepackages():  # pragma: no cover (env-dependent)
        cand = Path(p)
        if cand.is_dir() and os.access(cand, os.W_OK):
            return cand
    user = Path(site.getusersitepackages())
    user.mkdir(parents=True, exist_ok=True)
    return user


def brew_formula_python(formula: str) -> Path | None:
    """Path to a Homebrew keg's libexec python for ANY formula (omlx,
    omlx-dev, ...), if brew + the keg exist."""
    import shutil

    brew = shutil.which("brew")
    if not brew:
        return None
    try:
        prefix = subprocess.run(
            [brew, "--prefix", formula], capture_output=True, text=True,
            timeout=15).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):  # pragma: no cover
        return None
    cand = Path(prefix) / "libexec" / "bin" / "python"
    return cand if prefix and cand.is_file() else None


def brew_omlx_python() -> Path | None:
    """Path to a Homebrew oMLX keg interpreter, if brew + omlx exist."""
    return brew_formula_python("omlx")


def pth_content(target: Path | None) -> str:
    """The .pth body: ALWAYS bootstrap sys.path with OUR package parent
    dir, then import autopatch — a .pth line starting with 'import ' is
    executed, any other line is appended to sys.path, so the keg needs
    exactly this ONE file, nothing else. Order matters: path line first.

    Do NOT probe the target for 'import omlx_uplift' to decide whether the
    path line is needed: a working .pth already in the target's
    site-packages makes that probe succeed BY BOOTSTRAPPING ITSELF, so the
    rewrite would drop the path line and break the mount we just proved
    (the run-1 404 / run-2 fixes-it sequence). A duplicated sys.path entry
    is harmless; the conditional was not."""
    lines: list[str] = []
    if target is not None:
        pkg_parent = str(Path(__file__).resolve().parent.parent)
        # brew kegs live under a VERSIONED Cellar dir; point the .pth at
        # the stable opt/ symlink instead so `brew upgrade omlx-uplift`
        # needs no remount.
        if "/Cellar/omlx-uplift/" in pkg_parent:
            base, rest = pkg_parent.split("/Cellar/omlx-uplift/", 1)
            rest = rest.split("/", 1)[1]  # drop the version directory
            pkg_parent = f"{base}/opt/omlx-uplift/{rest}"
        lines.append(pkg_parent)
    lines.append("import omlx_uplift.autopatch")
    return "\n".join(lines) + "\n"


def default_target_python(formula: str | None = None) -> str | None:
    """No --python given: prefer a Homebrew keg (the common case for tap
    users), else stay in the current interpreter. `formula` selects which
    keg (DEV-3: 'omlx-dev' mounts the dev keg too)."""
    keg = brew_formula_python(formula or "omlx")
    return str(keg) if keg else None


def mount_into_dev_keg() -> bool:
    """Drop the uplift .pth into the omlx-dev keg's python (own keg, so
    unsandboxed; same single-file contract as
    `omlx-uplift install --formula omlx-dev`)."""
    target = default_target_python("omlx-dev")
    if not target:
        return False
    sp = resolve_site_packages(target)
    sp.mkdir(parents=True, exist_ok=True)
    (sp / PTH_NAME).write_text(pth_content(Path(target)), encoding="utf-8")
    return True


def formula_keg_exists(formula: str) -> bool:
    import glob

    from . import paths as _paths

    prefix = _paths.brew_prefix()
    return bool(glob.glob(f"{prefix}/Cellar/{formula}/*"))


def brew_build_cmd(flags) -> list:
    """The brew command that builds omlx-dev (head-only formula).

    This brew version is inconsistent about --HEAD and both error paths
    are real (hit 2026-09-24): `install` REFUSES a head-only formula
    without --HEAD, `reinstall` REJECTS --HEAD outright. So: first build
    installs with the flag, every rebuild reinstalls without it. Neither
    is ever `brew upgrade` — it no-ops on branch heads."""
    if formula_keg_exists("omlx-dev"):
        return ["brew", "reinstall", *sorted(flags), "omlx-dev"]
    return ["brew", "install", "--HEAD", *sorted(flags), "omlx-dev"]


def receipt_used_options(formula: str) -> set:
    """used_options from the formula's own INSTALL_RECEIPT.json (empty when
    not installed)."""
    import glob
    import json as _json

    from . import paths as _paths

    prefix = _paths.brew_prefix()
    receipts = sorted(glob.glob(f"{prefix}/Cellar/{formula}/*/INSTALL_RECEIPT.json"))
    if not receipts:
        return set()
    try:
        with open(receipts[-1]) as fh:
            data = _json.load(fh)
    except (OSError, ValueError):
        return set()
    opts = set((data.get("used_options") or []))
    return opts
