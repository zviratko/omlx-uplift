"""U19 — binary stash of omlx-dev kegs for rollback / switching.

brew's `reinstall` of a HEAD formula destroys the outgoing keg, so an
omlx-dev build you want to return to is gone for good. This module keeps
copies under ``<dev base_path>/uplift/kegs/omlx-dev/HEAD-<sha>/`` using
APFS clones (``cp -c``): near-zero disk cost on the user's volume,
plain-copy fallback elsewhere.

Switching preserves shebang integrity by CONSTRUCTION (U19 risk item):
every clone is stashed under the keg's own Cellar version name, and
``activate`` re-installs the clone at that exact ``Cellar/omlx-dev/<name>``
path before re-pointing the ``opt/omlx-dev`` symlink. Absolute shebangs
baked into ``bin/omlx-dev`` and the libexec venv therefore keep pointing
at files that exist again at the same address. No sed, no relocate.

Restarting the service stays user-driven (server_restart_control).
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import shutil
import subprocess

FORMULA = "omlx-dev"
DEFAULT_KEEP = 3
_META = "uplift-kegstash.json"


def _prefix() -> str:
    return os.environ.get("HOMEBREW_PREFIX", "/opt/homebrew")


def cellar_dir(formula: str = FORMULA) -> str:
    return os.path.join(_prefix(), "Cellar", formula)


def opt_link(formula: str = FORMULA) -> str:
    return os.path.join(_prefix(), "opt", formula)


def kegs_root(root: str | None = None) -> str:
    """Stash destination. Default: <dev base_path from dev.json or
    ~/.omlx-dev>/uplift/kegs. Tests pass an explicit root."""
    if root:
        return os.path.join(os.path.expanduser(root), "uplift", "kegs")
    base = os.path.expanduser("~/.omlx-dev")
    try:
        from . import devsrc

        cfg = devsrc.load_config() or {}
        base = os.path.expanduser(cfg.get("base_path") or base)
    except Exception:
        pass
    return os.path.join(base, "uplift", "kegs")


def active_keg(formula: str = FORMULA) -> str | None:
    """The Cellar version directory the opt symlink points at right now
    (None when the formula is not installed)."""
    link = opt_link(formula)
    try:
        target = os.path.realpath(link)
    except OSError:
        return None
    name = os.path.basename(target)
    return name if os.path.isdir(target) and name.startswith("HEAD-") else None


def installed_kegs(formula: str = FORMULA) -> list[str]:
    d = cellar_dir(formula)
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d) if n.startswith("HEAD-"))


def _clone(src: str, dst: str) -> str:
    """APFS clone when the volume supports it (cp -c), plain copy
    otherwise. Returns 'clone' or 'copy' for the meta record."""
    os.makedirs(os.path.dirname(dst.rstrip("/")), exist_ok=True)
    proc = subprocess.run(["cp", "-c", "-R", src, dst],
                          capture_output=True, text=True)
    if proc.returncode == 0:
        return "clone"
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    return "copy"


def _dir_size(path: str) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def stash(name: str | None = None, root: str | None = None,
          formula: str = FORMULA) -> dict:
    """Copy Cellar/<formula>/<name> into the stash. Idempotent: an
    existing stash of the same name is left alone (kegs are immutable)."""
    if name is None:
        name = active_keg(formula)
    if not name:
        raise FileNotFoundError(f"no active {formula} keg to stash")
    src = os.path.join(cellar_dir(formula), name)
    if not os.path.isdir(src):
        raise FileNotFoundError(f"keg not installed: {src}")
    dest_root = os.path.join(kegs_root(root), formula)
    dest = os.path.join(dest_root, name)
    if os.path.isdir(dest):
        return {"name": name, "path": dest, "method": "exists"}
    os.makedirs(dest_root, exist_ok=True)
    method = _clone(src, dest)
    meta = {
        "formula": formula,
        "name": name,
        "sha": name[len("HEAD-"):].split("_")[0],
        "stashed_at": _dt.datetime.now(_dt.timezone.utc)
                      .isoformat(timespec="seconds"),
        "method": method,
        "bytes": _dir_size(src),
    }
    with open(os.path.join(dest, _META), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return {"name": name, "path": dest, "method": method}


def list_stashes(root: str | None = None, formula: str = FORMULA) -> list[dict]:
    d = os.path.join(kegs_root(root), formula)
    if not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if not os.path.isdir(p):
            continue
        meta = {}
        try:
            with open(os.path.join(p, _META), encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            pass
        meta.setdefault("name", name)
        meta["path"] = p
        out.append(meta)
    out.sort(key=lambda m: m.get("stashed_at") or "", reverse=True)
    return out


def prune(root: str | None = None, keep: int = DEFAULT_KEEP,
          formula: str = FORMULA) -> list[str]:
    """Delete stashes older than the newest `keep` (never the active keg)."""
    removed = []
    for meta in list_stashes(root, formula)[keep:]:
        name = meta.get("name") or ""
        if name and name == active_keg(formula):
            continue
        shutil.rmtree(meta.get("path", ""), ignore_errors=True)
        removed.append(name)
    return removed


def running_pids(formula: str = FORMULA) -> list[int]:
    """PIDs serving from this formula's Cellar (switch guard)."""
    try:
        proc = subprocess.run(["pgrep", "-f", f"Cellar/{formula}"],
                              capture_output=True, text=True)
    except OSError:
        return []
    return [int(x) for x in proc.stdout.split() if x.strip().isdigit()]


def _shebang_ok(cellar_path: str, formula: str = FORMULA) -> bool:
    """The U19 VERIFY item: the keg's launcher shebang must resolve inside
    the very directory we are about to activate."""
    binp = os.path.join(cellar_path, "bin", formula)
    try:
        with open(binp, "r", encoding="utf-8", errors="replace") as fh:
            first = fh.readline()
    except OSError:
        return False
    return first.startswith("#!") and cellar_path in first


def activate(name: str, root: str | None = None,
             formula: str = FORMULA, force: bool = False) -> dict:
    """Re-point the active keg at a stashed build.

    Re-installs the clone at its original Cellar path (shebangs intact),
    moves the opt symlink, refreshes the uplift .pth mount. The service
    restart itself stays with the user (server_restart_control)."""
    m = re.fullmatch(r"(?:HEAD-)?([0-9a-f]{7,40})", name.strip())
    if m:
        d = os.path.join(kegs_root(root), formula)
        cands = [s for s in os.listdir(d)
                 if s.startswith("HEAD-" + m.group(1))] \
            if os.path.isdir(d) else []
        if len(cands) == 1:
            name = cands[0]
    stashed = os.path.join(kegs_root(root), formula, name)
    if not os.path.isdir(stashed):
        raise FileNotFoundError(
            f"no stashed keg {name!r} — see: omlx-uplift dev kegs")
    if not force and running_pids(formula):
        raise RuntimeError(
            f"a {formula} server is running from this keg family — stop it "
            "first (brew services stop omlx-dev), or pass --force")
    cellar = os.path.join(cellar_dir(formula), name)
    if not os.path.isdir(cellar):
        _clone(stashed, cellar)
    if not _shebang_ok(cellar, formula):
        raise RuntimeError(
            f"{name}: bin/{formula} shebang does not point inside "
            f"{cellar} — refusing to activate a keg that cannot start "
            "(pass --force only if you know why)")
    link = opt_link(formula)
    os.makedirs(os.path.dirname(link), exist_ok=True)
    rel = os.path.join("..", "Cellar", formula, name)
    if os.path.islink(link):
        os.unlink(link)
    elif os.path.isdir(link):
        raise RuntimeError(f"{link} is a real directory, not a symlink")
    os.symlink(rel, link)
    remounted = False
    try:
        from . import cli

        remounted = cli._mount_into_dev_keg()
    except Exception:
        remounted = False
    return {"name": name, "cellar": cellar, "link": link,
            "shebang_ok": True, "pth": remounted}
