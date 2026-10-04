"""KEGID-2 — omlx tree drift detection (RECORD census).

KEGID-1 (commit 4db2f60) fixed keg identity so patch backups can no longer
be restored into the WRONG keg. This module covers every OTHER way the
installed tree can end up not matching its wheel: manual edits, aborted
reinstalls, tooling bugs. The wheel's ``RECORD`` (dist-info) is the
install-time content manifest — a file on disk that differs from RECORD
and is NOT explained by an applied uplift patch is drift, full stop.

The KEGID-1 incident tree (6 files from 5 upstream commits, every model
load broken for 3 days) would have failed this census on its first boot.

Contract:
- READ-ONLY. Never writes to the omlx tree (the repair story stays
  `brew reinstall omlx`; auto-restoring from backups is exactly what
  caused the incident).
- Stdlib only; the boot path (autopatch) must not import anything heavy.
- custom_kernels binaries (.so/.dylib under omlx/custom_kernels/) are
  EXCLUDED: `brew reinstall` legitimately rebuilds them post-install, so
  RECORD cannot match them on a healthy keg either (measured on a fresh
  HEAD-68c8c09 install: 10 such mismatches, all kernel artifacts).
- Files touched by a patch version that is `applied` for the CURRENT keg
  are EXPECTED drift (informational, never an alarm).

Exit codes (CLI): 0 clean or expected-only, 1 unexpected drift, 2 the
census could not run (no tree / no RECORD).
"""

from __future__ import annotations

import base64
import csv
import hashlib
import json
import os

__all__ = ["census", "record_drift", "boot_check", "format_report"]

_KERNEL_PREFIX = "omlx/custom_kernels/"
_KERNEL_EXT = (".so", ".dylib", ".dll")


def _site_packages_of(tree_root: str) -> str:
    """tree_root is the dir CONTAINING the omlx package (= site-packages)."""
    return tree_root


def _record_path(tree_root: str) -> str | None:
    import glob

    hits = sorted(glob.glob(os.path.join(
        _site_packages_of(tree_root), "omlx-*.dist-info", "RECORD")))
    return hits[0] if hits else None


def record_files(tree_root: str) -> dict[str, str] | None:
    """{path: 'sha256=<b64url>'} from the wheel RECORD; None if no RECORD.

    Entries without a hash (directories, dist-info metadata lines are
    commonly empty-sha) are skipped. Paths are RECORD-relative, '/'-joined.
    """
    rec = _record_path(tree_root)
    if not rec:
        return None
    out: dict[str, str] = {}
    with open(rec, newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 2:
                continue
            path, sha = row[0], row[1]
            if not path or not sha.startswith("sha256="):
                continue
            out[path] = sha
    return out


def _is_kernel_artifact(rel: str) -> bool:
    return rel.startswith(_KERNEL_PREFIX) and rel.endswith(_KERNEL_EXT)


def _sha_line(line: str) -> str:
    return base64.urlsafe_b64encode(
        hashlib.sha256(line.encode()).digest()).decode().rstrip("=")


def census(tree_root: str, expected: set[str] | None = None) -> dict:
    """Compare every RECORD-listed omlx file against its install-time hash.

    Returns {ok, skipped_reason?, n_checked, n_expected,
             unexpected: [{path, kind: missing|hash}],
             expected: [paths]}. ok=False only for UNEXPECTED drift.
    """
    expected = expected or set()
    files = record_files(tree_root)
    if files is None:
        return {"ok": True, "skipped_reason": "no wheel RECORD (source tree?)",
                "n_checked": 0, "n_expected": 0, "unexpected": [],
                "expected": []}
    sp = _site_packages_of(tree_root)
    unexpected: list[dict] = []
    seen_expected: list[str] = []
    n = 0
    for rel, sha in sorted(files.items()):
        if not rel.startswith("omlx/") or _is_kernel_artifact(rel):
            continue
        n += 1
        full = os.path.join(sp, *rel.split("/"))
        try:
            with open(full, "rb") as fh:
                got = hashlib.sha256(fh.read()).hexdigest()
        except OSError:
            if rel in expected:
                seen_expected.append(rel)
            else:
                unexpected.append({"path": rel, "kind": "missing"})
            continue
        want = sha.split("=", 1)[1]
        got_b64 = base64.urlsafe_b64encode(
            bytes.fromhex(got)).decode().rstrip("=")
        if got_b64 != want:
            if rel in expected:
                seen_expected.append(rel)
            else:
                unexpected.append({"path": rel, "kind": "hash"})
    return {"ok": not unexpected, "skipped_reason": None,
            "n_checked": n, "n_expected": len(seen_expected),
            "unexpected": unexpected, "expected": sorted(seen_expected)}


def expected_drift(store, tree_root: str, keg: str | None) -> set[str]:
    """Files an APPLIED patch version (for THIS keg) legitimately owns.

    Walks the manifest; for every patch whose desired version records
    applied.keg_id == keg, reads that version's backup meta and adds its
    file list. A restored-then-purged patch keeps nothing here — that is
    correct: once the patch is gone the file must be back at pristine.
    """
    paths: set[str] = set()
    if keg is None:
        return paths
    try:
        manifest = store.load()
    except Exception:
        return paths
    for patch in manifest.get("patches", []):
        if patch.get("state") not in ("applied", "update_available"):
            continue
        for ver in patch.get("versions", []):
            applied = ver.get("applied") or {}
            if applied.get("keg_id") != keg:
                continue
            bd = ver.get("backup_dir")
            if not bd:
                continue
            # same rule as patchsync._abs (kept local: import order)
            full = bd if os.path.isabs(bd) else os.path.join(
                store.base_dir, bd)
            meta = os.path.join(full, "meta.json")
            try:
                with open(meta) as fh:
                    data = json.load(fh)
                paths.update((data.get("files") or {}).keys())
            except (OSError, ValueError):
                continue
    return paths


def run(store=None, tree_root: str | None = None) -> dict:
    """Full census against the live tree (or explicit tree_root)."""
    from . import patches as _patches

    if tree_root is None:
        root = _patches._omlx_root()
        if not root:
            return {"ok": True, "skipped_reason": "omlx tree not found",
                    "n_checked": 0, "n_expected": 0, "unexpected": [],
                    "expected": []}
        tree_root = os.path.dirname(root)
    store = store or _patches.PatchStore()
    keg = _patches.keg_id(os.path.join(tree_root, "omlx"))
    exp = expected_drift(store, tree_root, keg)
    rep = census(tree_root, expected=exp)
    rep["keg_id"] = keg
    return rep


_STATE_FILE = ".treedoctor.json"


def _state_path(store) -> str:
    return os.path.join(store.base_dir, _STATE_FILE)


def _manifest_fp(store) -> str:
    """Cheap fingerprint of everything the census classification depends
    on: keg identity is checked separately; here it is WHICH patches are
    applied for which keg (the expected-drift set). Cache invalidates when
    a patch is applied, removed, or re-promoted."""
    try:
        manifest = store.load()
    except Exception:
        return "unloadable"
    rows = []
    for patch in manifest.get("patches", []):
        kegs = sorted((v.get("applied") or {}).get("keg_id", "")
                      for v in patch.get("versions", []))
        rows.append(f"{patch.get('id')}|{patch.get('state')}"
                    f"|{patch.get('desired_version')}|{','.join(kegs)}")
    blob = ";".join(sorted(rows))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def boot_check(store=None) -> dict | None:
    """autopatch hook: warn (NEVER block, NEVER raise) on unexpected drift.

    The full census (~0.2 s warm) runs ONCE per keg identity — exactly the
    moment an upgrade or a restore could have corrupted the tree. Every
    later boot replays the cached verdict, so the steady-state boot cost is
    one small json read (< 1 ms). Returns the report actually used, or
    None when the check itself failed.
    """
    try:
        from . import patches as _patches

        store = store or _patches.PatchStore()
        if store.patches_disabled():
            return None          # kill switch: stay completely out of the way
        root = _patches._omlx_root()
        if not root:
            return None
        tree_root = os.path.dirname(root)
        keg = _patches.keg_id(root)
        if not keg:
            return None
        fp = _manifest_fp(store)
        rep = None
        try:
            with open(_state_path(store)) as fh:
                st = json.load(fh)
            # cache valid only while BOTH the keg identity and the
            # applied-patch fingerprint are unchanged: a patch removal
            # shrinks the expected set and must re-run the census.
            # Drift verdicts are ignored on read (never trusted from a
            # cache; older builds may have written one).
            cached = st.get("report")
            if (st.get("keg_id") == keg and st.get("manifest_fp") == fp
                    and isinstance(cached, dict) and cached.get("ok")):
                rep = cached
        except (OSError, ValueError):
            rep = None
        if rep is None:
            exp = expected_drift(store, tree_root, keg)
            rep = census(tree_root, expected=exp)
            rep["keg_id"] = keg
            # Only CLEAN verdicts are cached. A drift verdict cached here
            # would replay as a false alarm after a manual repair (the
            # tree healed, both fingerprints unchanged — boot would keep
            # warning until the next keg/manifest move). Re-censusing on
            # drift costs ~0.14 s per boot; drift is the rare, loud case.
            if rep.get("ok"):
                try:
                    tmp = _state_path(store) + ".tmp"
                    with open(tmp, "w") as fh:
                        json.dump({"keg_id": keg, "manifest_fp": fp,
                                   "report": rep}, fh)
                    os.replace(tmp, _state_path(store))
                except OSError:
                    pass
        if rep.get("skipped_reason") or rep.get("ok"):
            return rep
        worst = ", ".join(
            f"{e['path']} ({e['kind']})"
            for e in rep.get("unexpected", [])[:8])
        n = len(rep.get("unexpected", []))
        more = "" if n <= 8 else f" (+{n - 8} more)"
        try:
            import logging

            logging.getLogger("omlx_uplift").warning(
                "TREE DRIFT: %d/%d omlx files differ from the wheel RECORD "
                "with no applied patch to explain them: %s%s. The tree no "
                "longer matches its build — repair with `brew reinstall "
                "omlx` (details: `omlx-uplift doctor`).",
                n, rep.get("n_checked", 0), worst, more)
        except Exception:
            pass
        return rep
    except Exception:  # the doctor must never be the reason a boot fails
        return None


def format_report(rep: dict) -> str:
    if rep.get("skipped_reason"):
        return f"tree doctor: skipped ({rep['skipped_reason']})"
    lines = [f"tree doctor: {rep['n_checked']} RECORD files checked "
             f"(keg {rep.get('keg_id') or '?'})"]
    if rep["unexpected"]:
        lines.append(f"UNEXPECTED DRIFT ({len(rep['unexpected'])}):")
        for e in rep["unexpected"]:
            lines.append(f"  {e['kind']:8s} {e['path']}")
    if rep["expected"]:
        lines.append(f"expected drift from applied patches "
                     f"({len(rep['expected'])}): "
                     + ", ".join(rep["expected"]))
    if rep["ok"]:
        lines.append("OK: tree matches its wheel"
                     + (" (applied-patch files excepted)"
                        if rep["expected"] else ""))
    else:
        lines.append("repair: brew reinstall omlx")
    return "\n".join(lines)
