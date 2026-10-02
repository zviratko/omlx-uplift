"""PATHS-1: the single home for base-dir and Homebrew-prefix policy.

Before this module existed, four independent copies of the base-dir
ladder lived in store.py, env_tunables.py, autopatch.py and skins.py,
while patches.py deliberately used a DIFFERENT policy — and four
HOMEBREW_PREFIX spellings disagreed on whether /usr/local counts. That
is exactly how the DEV-6 split-store bug happened: equivalent code with
unEquivalent semantics, no single place to read the rules.

Two families, deliberately different — keep it that way:

  A) PER-INSTANCE base (~ where the running omlx keeps its data):
     server_state.global_settings.base_path  ->  $OMLX_BASE_PATH  ->  ~/.omlx
     Use for anything the server itself reads/writes for ITS instance:
     metrics.sqlite3, env_overrides.json, skins dir.
       - server_base_dir()        full ladder (omlx already imported)
       - startup_base_dir()       interpreter-startup-safe subset (NEVER
                                  imports omlx — autopatch runs from a
                                  .pth before omlx.server exists; a lazy
                                  import there would re-enter the target
                                  module mid-boot)

  B) THE CANONICAL SHARED uplift store (patch manifest + diffs):
     $UPLIFT_HOME  ->  ~/.omlx/uplift
     Deliberately INDEPENDENT of family A: pointing OMLX_BASE_PATH at
     ~/.omlx-dev for the dev service must not fork one patch set into
     two manifests (that was the DEV-6 incident — patches visibly
     vanished between the CLI and the dev dashboard).
       - uplift_store_dir()

Homebrew discovery:
       - brew_prefix()            $HOMEBREW_PREFIX -> first prefix with a
                                  Cellar dir -> candidates[0]
       - brew_prefix_candidates() ordered, de-duplicated list (Apple
                                  Silicon before Intel)
     patches.py used to probe /usr/local too while cli.py and kegstash.py
     fell back to /opt/homebrew only: on an Intel Mac without the env var
     set, keg discovery silently returned "not installed". One ladder,
     both prefixes, fixes the divergence.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

_log = logging.getLogger("omlx_uplift.paths")

UPLIFT_SUBDIR = "uplift"

# Apple Silicon first: the dominant install, and keeps behaviour
# byte-identical there when neither env nor Cellar probing decides.
_BREW_CANDIDATES = ("/opt/homebrew", "/usr/local")


def server_base_dir() -> Path:
    """Family A full ladder: live server state, then env, then ~/.omlx.

    Only call after omlx is imported (router/collector context). The
    except leg logs at debug level: the fallback is legitimate, the
    silence was not (LOG-SILENT-1).
    """
    base = None
    try:
        from omlx.server import _server_state

        gs = getattr(_server_state, "global_settings", None)
        bp = getattr(gs, "base_path", None) if gs else None
        if bp:
            base = Path(bp)
    except Exception as exc:  # noqa: BLE001 — env/home fallback is the point
        # LOG-SILENT-1: the fallback is legitimate, the silence was not.
        _log.debug("base dir: server_state unavailable (%s); "
                   "falling back to env/home", exc)
    if base is None:
        env = os.environ.get("OMLX_BASE_PATH")
        base = Path(env) if env else Path(os.path.expanduser("~/.omlx"))
    return base


def startup_base_dir() -> Path | None:
    """Family A, interpreter-startup-safe: env + home only, never imports
    omlx. Returns None when neither is a usable dir (callers decide)."""
    env = os.environ.get("OMLX_BASE_PATH")
    if env:
        return Path(env)
    home = Path(os.path.expanduser("~/.omlx"))
    return home if home.is_dir() else None


def uplift_store_dir() -> Path:
    """Family B: THE canonical shared uplift data dir (patch manifest,
    diffs, kegs, kernel backups). NEVER consults server_state or
    OMLX_BASE_PATH — see module docstring (DEV-6)."""
    env_home = os.environ.get("UPLIFT_HOME")
    if env_home:
        return Path(os.path.expanduser(env_home))
    return Path(os.path.expanduser("~/.omlx")) / UPLIFT_SUBDIR


def metrics_db_path() -> Path:
    """Family A + uplift subdir — the one sqlite every sample lands in."""
    return server_base_dir() / UPLIFT_SUBDIR / "metrics.sqlite3"


def brew_prefix_candidates() -> list[str]:
    out = []
    env = os.environ.get("HOMEBREW_PREFIX")
    if env:
        out.append(env)
    out.extend(_BREW_CANDIDATES)
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def brew_prefix() -> str:
    """One usable prefix: env, else the first candidate whose Cellar
    exists, else the default (so 'not installed' answers keep their
    shape on machines with no brew at all)."""
    env = os.environ.get("HOMEBREW_PREFIX")
    if env:
        return env
    for cand in _BREW_CANDIDATES:
        if os.path.isdir(os.path.join(cand, "Cellar")):
            return cand
    return _BREW_CANDIDATES[0]
