"""U19 — binary stash of omlx-dev kegs for rollback / switching.

brew's `reinstall` of a HEAD formula destroys the outgoing keg, so an
omlx-dev build you want to return to is gone for good. This module keeps
copies under ``<dev base_path>/uplift/kegs/omlx-dev/`` using APFS clones
(``cp -c``): near-zero disk cost on the user's volume, plain-copy
fallback elsewhere.

DEV-13 (user 2026-10-07): stash entries are keyed per BUILD, not per
commit — the directory name is ``HEAD-<sha>_<UTC ts>``. A HEAD formula
reinstall at the SAME commit (different brew flags, re-materialized
patch content, or a plain "reinstall to be sure") produced the same
``HEAD-<sha>`` name before, and the name-idempotent stash no-op'd while
brew destroyed the outgoing bytes: the hole this closes. The Cellar
address itself stays ``HEAD-<sha>`` — brew's namespace and the shebang
anchor — so every entry records ``cellar_name`` and ``activate``
REPLACES whatever sits in that slot (two builds of one sha share the
address; silently keeping a stale different build was the second half
of the hole).

Switching preserves shebang integrity by CONSTRUCTION (U19 risk item):
every clone is re-installed at its recorded ``Cellar/omlx-dev/<cellar_name>``
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
# DEV-13: retention default 3 -> 5 builds, overridable per user via the
# `keg_stash_keep` key in dev.json (clamped 1..20 — see stash_keep()).
DEFAULT_KEEP = 5
_KEEP_MIN, _KEEP_MAX = 1, 20
_META = "uplift-kegstash.json"


def _prefix() -> str:
    # PATHS-1: single brew-prefix ladder (env -> Cellar probe covering
    # /usr/local on Intel -> default). Old code fell back to
    # /opt/homebrew only: on an Intel Mac without HOMEBREW_PREFIX set,
    # keg discovery silently answered 'not installed'.
    from . import paths as _paths

    return _paths.brew_prefix()


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


def stash_keep() -> int:
    """DEV-13: retention knob — `keg_stash_keep` from dev.json (user's
    call: the key lives with the rest of the dev-flow config, no new
    global settings file for one integer), clamped, else DEFAULT_KEEP."""
    try:
        from . import devsrc

        cfg = devsrc.load_config() or {}
        v = int(cfg.get("keg_stash_keep", DEFAULT_KEEP))
    except Exception:
        return DEFAULT_KEEP
    return max(_KEEP_MIN, min(_KEEP_MAX, v))


def _build_ts() -> str:
    # compact UTC: filesystem-safe, lexicographic == chronological
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def stash(name: str | None = None, root: str | None = None,
          formula: str = FORMULA) -> dict:
    """Copy Cellar/<formula>/<name> into the stash. DEV-13: the stash
    entry is keyed per BUILD — ``<keg name>_<UTC ts>`` (legacy name +
    ``cellar_name`` field), so a reinstall at the SAME commit still
    leaves a fresh rollback artifact. The 'exists' no-op path is gone:
    two kegs can share a name and differ in bytes (brew flags, patch
    materialization), and the outgoing bytes die with `brew reinstall`
    unless this call takes them."""
    if name is None:
        name = active_keg(formula)
    if not name:
        raise FileNotFoundError(f"no active {formula} keg to stash")
    src = os.path.join(cellar_dir(formula), name)
    if not os.path.isdir(src):
        raise FileNotFoundError(f"keg not installed: {src}")
    dest_root = os.path.join(kegs_root(root), formula)
    os.makedirs(dest_root, exist_ok=True)
    ts = _build_ts()
    dest_name = f"{name}_{ts}"
    # same-second double stash (drills, tests): keep names unique
    n = 1
    while os.path.isdir(os.path.join(dest_root, dest_name)):
        n += 1
        dest_name = f"{name}_{ts}.{n}"
    method = _clone(src, os.path.join(dest_root, dest_name))
    meta = {
        "formula": formula,
        "name": dest_name,
        # cellar_name = the Cellar address this build came from and must
        # return to (shebang anchor). stash name == cellar_name only for
        # legacy pre-DEV-13 entries.
        "cellar_name": name,
        "sha": name[len("HEAD-"):].split("_")[0],
        "stashed_at": _dt.datetime.now(_dt.timezone.utc)
                      .isoformat(timespec="seconds"),
        "method": method,
        "bytes": _dir_size(src),
    }
    with open(os.path.join(dest_root, dest_name, _META), "w",
              encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return {"name": dest_name, "cellar_name": name,
            "path": os.path.join(dest_root, dest_name), "method": method}


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


def prune(root: str | None = None, keep: int | None = None,
          formula: str = FORMULA) -> list[str]:
    """Delete stashes older than the newest `keep` builds. DEV-13: the
    default comes from stash_keep() (dev.json `keg_stash_keep`, else 5),
    and the active guard compares `cellar_name` — two stash entries can
    map to ONE Cellar address now, and whichever build occupies that
    address must never be pruned."""
    if keep is None:
        keep = stash_keep()
    act = active_keg(formula)
    removed = []
    for meta in list_stashes(root, formula)[keep:]:
        name = meta.get("name") or ""
        cellar = meta.get("cellar_name") or name
        if act and cellar == act:
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

    DEV-13 name resolution: an exact stash entry name (`HEAD-<sha>`
    legacy or `HEAD-<sha>_<ts>`) activates exactly it; a bare/HEAD sha
    activates the NEWEST stashed build of that commit (several builds
    can share one sha now). The clone is installed at its recorded
    `cellar_name` address, REPLACING whatever is in that Cellar slot —
    silently keeping a stale different build of the same sha was the
    second half of the DEV-13 hole. Then the opt symlink moves and the
    uplift .pth mount refreshes. The service restart itself stays with
    the user (server_restart_control)."""
    d = os.path.join(kegs_root(root), formula)
    m = re.fullmatch(r"(?:HEAD-)?([0-9a-f]{7,40})", name.strip())
    if m and not os.path.isdir(os.path.join(d, name.strip())):
        sha = m.group(1)
        rows = [s for s in list_stashes(root, formula)
                if (s.get("cellar_name") or s.get("name") or "")
                    .startswith("HEAD-" + sha)]
        if rows:
            # list_stashes is newest-first: bare sha = newest build of it
            name = rows[0].get("name")
    stashed = os.path.join(d, name)
    if not os.path.isdir(stashed):
        raise FileNotFoundError(
            f"no stashed keg {name!r} — see: omlx-uplift dev kegs")
    meta = {}
    try:
        with open(os.path.join(stashed, _META), encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        pass
    cellar_name = meta.get("cellar_name") or name
    if not force and running_pids(formula):
        raise RuntimeError(
            f"a {formula} server is running from this keg family — stop it "
            "first (brew services stop omlx-dev), or pass --force")
    cellar = os.path.join(cellar_dir(formula), cellar_name)
    if os.path.isdir(cellar):
        # DEV-13: the slot may hold a DIFFERENT build of the same sha —
        # replace it with the one being activated (running_pids guard
        # above means no process is serving from it).
        shutil.rmtree(cellar)
    _clone(stashed, cellar)
    if not _shebang_ok(cellar, formula):
        raise RuntimeError(
            f"{name}: bin/{formula} shebang does not point inside "
            f"{cellar} — refusing to activate a keg that cannot start "
            "(pass --force only if you know why)")
    link = opt_link(formula)
    os.makedirs(os.path.dirname(link), exist_ok=True)
    rel = os.path.join("..", "Cellar", formula, cellar_name)
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
    return {"name": name, "cellar_name": cellar_name,
            "cellar": cellar, "link": link,
            "shebang_ok": True, "pth": remounted}
