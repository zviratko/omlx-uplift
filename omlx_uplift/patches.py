"""Patch manifest + state machine — the declarative desired state (PAT-1).

Storage: ``~/.omlx/uplift/patches.json`` (base dir overridable), written
atomically (tmp + rename) so a broken patch set stays editable by hand while
omlx is down. Diff bodies live under ``patches/``, pristine-original backups
under ``patches/backups/<id>.v<N>/<keg-id>/``.

State machine (PAT-0 design; WARNING badge lights for needs_review/failed):

    disabled  -> pending          (enable + validation gate passed)
    pending   -> applied          (reconcile wrote the files)
    pending   -> needs_review     (strict apply failed on live keg)
    applied   -> update_available (candidate version fetched + gated)
    update_available -> applied   (promote: desired_version swap + reconcile)
    applied   -> disabled         (disable; backup restore at next reconcile)
    applied   -> needs_review     (keg changed and re-validate failed)
    applied   -> obsolete         (dry-run: hunks already present upstream)
    *         -> failed           (post-check broke; auto-reverted)

Transitions never force a patch — a failed patch is MARKED, omlx stays vanilla.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone

MANIFEST_VERSION = 1
KILL_SWITCH_ENV = "OMLX_UPLIFT_NO_PATCHES"
SENTINEL_FILENAME = "patches.disabled"

STATES = (
    "applied", "pending", "update_available", "needs_review",
    "obsolete", "disabled", "failed",
)
WARNING_STATES = frozenset({"needs_review", "failed"})

# allowed (from -> to) transitions; enforced by set_state()
TRANSITIONS: dict[str, frozenset[str]] = {
    "pending": frozenset({"applied", "needs_review", "disabled", "obsolete",
                          "failed", "update_available"}),
    "applied": frozenset({"update_available", "disabled", "needs_review",
                          "obsolete", "failed", "pending"}),
    "update_available": frozenset({"applied", "pending", "disabled",
                                   "needs_review", "obsolete"}),
    "needs_review": frozenset({"pending", "applied", "disabled", "obsolete"}),
    "obsolete": frozenset({"pending", "disabled"}),
    "failed": frozenset({"pending", "needs_review", "disabled"}),
    "disabled": frozenset({"pending", "applied"}),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

def default_base_dir() -> str:
    env_base = os.environ.get("OMLX_BASE_PATH")
    if env_base:
        return os.path.join(env_base, "uplift")
    return os.path.expanduser(os.path.join("~", ".omlx", "uplift"))


class PatchStore:
    """Manifest + file layout for one uplift data dir. Pure filesystem,
    stdlib only — safe to use from the .pth startup path and the router."""

    def __init__(self, base_dir: str | None = None):
        self.base_dir = base_dir or default_base_dir()

    # -- layout -------------------------------------------------------------
    @property
    def manifest_path(self) -> str:
        return os.path.join(self.base_dir, "patches.json")

    @property
    def patches_dir(self) -> str:
        return os.path.join(self.base_dir, "patches")

    @property
    def backups_dir(self) -> str:
        return os.path.join(self.patches_dir, "backups")

    @property
    def lock_path(self) -> str:
        return os.path.join(self.base_dir, "patches.lock")

    @property
    def sentinel_path(self) -> str:
        return os.path.join(self.base_dir, SENTINEL_FILENAME)

    def patch_file(self, patch_id: str, version: int) -> str:
        return os.path.join(self.patches_dir, f"{patch_id}.v{version}.diff")

    def backup_dir(self, patch_id: str, version: int, keg_id: str) -> str:
        return os.path.join(self.backups_dir, f"{patch_id}.v{version}", keg_id)

    # -- kill switches --------------------------------------------------------
    def patches_disabled(self) -> bool:
        """True when a kill switch is active: env OMLX_UPLIFT_NO_PATCHES=1 or
        the sentinel file. Callers must then verify-only, never write."""
        if os.environ.get(KILL_SWITCH_ENV, "").strip() not in ("", "0"):
            return True
        return os.path.exists(self.sentinel_path)

    # -- manifest I/O ---------------------------------------------------------
    def load(self) -> dict:
        """Load the manifest; a missing/corrupt file yields a valid empty one
        (never raises — the .pth path and the UI both call this)."""
        try:
            with open(self.manifest_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if not isinstance(data, dict):
                raise ValueError("manifest root is not an object")
            data.setdefault("version", MANIFEST_VERSION)
            data.setdefault("config", {"auto_update_check": False})
            if not isinstance(data.get("patches"), list):
                data["patches"] = []
            return data
        except FileNotFoundError:
            return empty_manifest()
        except (OSError, ValueError):
            m = empty_manifest()
            m["load_error"] = "manifest unreadable or corrupt"
            return m

    def save(self, manifest: dict) -> None:
        """Atomic write: temp file in the same dir + rename, fsync first."""
        manifest.setdefault("version", MANIFEST_VERSION)
        os.makedirs(self.base_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="patches.", suffix=".tmp",
                                   dir=self.base_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2, sort_keys=False)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.manifest_path)
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    # -- patch access -----------------------------------------------------------
    def find(self, manifest: dict, patch_id: str) -> dict | None:
        for p in manifest.get("patches", []):
            if p.get("id") == patch_id:
                return p
        return None

    def get_version(self, patch: dict, v: int) -> dict | None:
        for ver in patch.get("versions", []):
            if ver.get("v") == v:
                return ver
        return None

    def next_version(self, patch: dict) -> int:
        vs = [ver.get("v", 0) for ver in patch.get("versions", [])]
        return (max(vs) + 1) if vs else 1

    def set_state(self, patch: dict, new_state: str, detail: str = "") -> bool:
        """State machine gate. Returns False (and does not change) on an
        illegal transition; legal transitions stamp state_detail."""
        cur = patch.get("state", "pending")
        if new_state not in STATES:
            return False
        if cur == new_state:
            patch["state_detail"] = detail
            return True
        if new_state not in TRANSITIONS.get(cur, frozenset()):
            return False
        patch["state"] = new_state
        patch["state_detail"] = detail
        patch["state_changed_at"] = now_iso()
        return True

    def set_state_if(self, patch: dict, new_state: str, detail: str = "") -> None:
        """Forced transition used by the reconcile engine only: the startup
        sync is the authoritative writer (e.g. needs_review -> applied after
        a keg upgrade fixes the conflict) and may bypass the UI gate."""
        patch["state"] = new_state
        patch["state_detail"] = detail
        patch["state_changed_at"] = now_iso()

    def warning_active(self, manifest: dict) -> bool:
        return any(p.get("state") in WARNING_STATES
                   for p in manifest.get("patches", []))


def empty_manifest() -> dict:
    return {
        "version": MANIFEST_VERSION,
        "config": {"auto_update_check": False},
        "patches": [],
    }


# --------------------------------------------------------------------------
# Keg identity
# --------------------------------------------------------------------------

def keg_id(omlx_root: str | None = None) -> str | None:
    """Identity of the target tree: the site-packages/omlx directory name
    plus the omlx version file hash. A `brew upgrade` builds a fresh keg ->
    new id -> every applied patch must re-validate (PAT-0 groundwork).

    Never imports omlx (safe at .pth time). Returns None when unresolvable.
    """
    root = omlx_root or _omlx_root()
    if not root:
        return None
    parent_name = os.path.basename(os.path.dirname(root)) or "tree"
    digest = hashlib.sha256()
    changed = False
    # version.py is the cheapest stable fingerprint of tree content identity
    ver = os.path.join(root, "version.py")
    try:
        with open(ver, "rb") as fh:
            digest.update(fh.read())
        changed = True
    except OSError:
        pass
    if not changed:
        digest.update(b"unversioned")
    return f"{parent_name}:{digest.hexdigest()[:16]}"


def _omlx_root() -> str | None:
    """Locate the installed omlx package dir without importing it."""
    import importlib.util

    try:
        spec = importlib.util.find_spec("omlx")
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.submodule_search_locations:
        return None
    try:
        return os.path.realpath(list(spec.submodule_search_locations)[0])
    except OSError:
        return None


# --------------------------------------------------------------------------
# Version retention (PAT-5 out-of-scope rule: keep newest 100, applied always)
# --------------------------------------------------------------------------

MAX_VERSIONS_PER_PATCH = 100


def prune_versions(manifest: dict, store: PatchStore) -> list[str]:
    """Drop each patch's versions beyond the newest MAX_VERSIONS_PER_PATCH,
    never the applied/desired one. Returns removed patch_file paths (already
    unlinked). Called ONCE when uplift starts work, not on every write."""
    removed: list[str] = []
    for patch in manifest.get("patches", []):
        versions = sorted(patch.get("versions", []),
                          key=lambda v: v.get("v", 0), reverse=True)
        keep_ids = {patch.get("desired_version")}
        keep_ids.update(
            v.get("v") for v in versions
            if (v.get("applied") or {}).get("keg_id")
        )
        kept = versions[:MAX_VERSIONS_PER_PATCH]
        kept_ids = {v.get("v") for v in kept} | {i for i in keep_ids if i is not None}
        kept_set = {v.get("v"): v for v in versions if v.get("v") in kept_ids}
        for v in versions:
            if v.get("v") not in kept_set:
                pf = v.get("patch_file")
                if pf:
                    path = pf if os.path.isabs(pf) else os.path.join(store.base_dir, pf)
                    try:
                        os.remove(path)
                        removed.append(path)
                    except OSError:
                        pass
                bd = v.get("backup_dir")
                if bd:
                    import shutil

                    path = bd if os.path.isabs(bd) else os.path.join(store.base_dir, bd)
                    shutil.rmtree(path, ignore_errors=True)
        patch["versions"] = sorted(kept_set.values(), key=lambda v: v.get("v", 0))
    return removed


def rel(path: str, base_dir: str) -> str:
    """Store manifest paths relative to base dir when possible."""
    try:
        r = os.path.relpath(path, base_dir)
        return r if not r.startswith("..") else path
    except ValueError:
        return path
