"""Startup patch reconcile (PAT-3) — the .pth-side engine.

Runs from autopatch BEFORE omlx is imported (stdlib + own package only —
never imports omlx, never raises to the host interpreter). Order per
PAT-0 restart semantics (option B):

  1. kill switches first (env OMLX_UPLIFT_NO_PATCHES=1 or sentinel file)
     -> verify only, never write, boot clean.
  2. fcntl.flock on patches.lock, non-blocking. Busy -> verify only, boot.
  3. applied + keg unchanged + file hashes match -> skip (microseconds).
  4. apply pending / promoted, restore disabled — IN ORDER, strict applier.
     Failure -> needs_review with detail, keep earlier successes, continue.
  5. if files really changed on disk: ONE os.execv re-exec (marker/env
     guard: at most one per boot; a second pending change just boots).
     Re-exec happens before omlx.server imports, so the server effectively
     restarts itself before engines start.
  6. every exception path logs and boots unpatched (never break omlx).

Time box: the whole sync must finish within 60 s or remaining work is
deferred (states stay pending) — boot never stalls indefinitely.

The re-exec contract also serves `omlx-uplift patch apply` (CLI): that
command calls sync_at_startup(allow_reexec=False) and reports the result.
"""

from __future__ import annotations

import fcntl
import hashlib
import logging
import os
import time

from . import diffapply, patches as _patches
from . import safeguards as _safeguards

_log = logging.getLogger("omlx_uplift.patchsync")

REEXEC_ENV = "OMLX_UPLIFT_REEXEC"       # set once before os.execv (env survives execv)
NO_REEXEC_ENV = "OMLX_UPLIFT_NO_REEXEC"  # tests / CLI: boot pending instead of exec
TIME_BUDGET_S = 60.0


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read(path: str) -> bytes | None:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def _abs(store, rel_or_abs: str) -> str:
    return (rel_or_abs if os.path.isabs(rel_or_abs)
            else os.path.join(store.base_dir, rel_or_abs))


def _files_match(tree_root: str, applied_files: list) -> bool:
    """Fast verify path: every recorded file still has the applied bytes."""
    for entry in applied_files:
        target, why = diffapply.safe_join(tree_root, entry.get("path", ""))
        if target is None:
            return False
        data = _read(target)
        if data is None or _sha(data) != entry.get("sha256"):
            return False
    return True


def _stamp_failure(store, tree_root, keg, patch, version, prefix, reason):
    """Per-keg failure record. The GLOBAL state only drops to needs_review
    when no other tree still carries the version applied — a dev keg whose
    build moved on must not put the vanilla board's chip in doubt."""
    rec = {"status": "error", "at": _patches.now_iso(), "files": [],
           "backup_dir": None, "tree_root": tree_root, "detail": reason}
    recs = dict(version.get("kegs") or {})
    legacy = version.get("applied") or {}
    if not recs and legacy.get("keg_id") and legacy["keg_id"] != keg:
        # pre-migration store: keep the other tree's truth in the map
        recs[legacy["keg_id"]] = {"status": "applied",
                                  "at": legacy.get("at"),
                                  "files": legacy.get("files") or [],
                                  "backup_dir": version.get("backup_dir")}
    recs[keg] = rec
    version["kegs"] = recs
    if not _patches.keg_applied_elsewhere(version, except_keg=keg):
        patch["state"] = "needs_review"
        patch["state_detail"] = f"{prefix}: {reason}"
        patch["state_changed_at"] = _patches.now_iso()


def _apply_patch(store, tree_root, keg, patch, version, deadline) -> dict:
    """Strict-apply one stored version. Returns report dict; mutates patch."""
    pid = patch["id"]
    data = _read(_abs(store, version.get("patch_file", "")))
    if data is None:
        _stamp_failure(store, tree_root, keg, patch, version,
                       "apply failed", "stored diff file missing")
        _log.warning("patch %s: stored diff file missing (%s) -> needs_review",
                     pid, version.get("patch_file"))
        return {"id": pid, "action": "needs_review", "reason": "diff file missing"}
    if time.monotonic() > deadline:
        return {"id": pid, "action": "deferred", "reason": "time budget"}
    if _patches.scope_touches_dev(_patches.patch_scope(patch)):
        # scope=both stores the FULL diff (dev-src needs tests/csrc); the
        # keg overlay is the same bytes minus non-installable files —
        # pruned here, the one place both scopes converge on the keg path
        data, _skipped = diffapply.prune_sections(
            data, _patches.skip_patterns(store.load()))
    backup_dir = store.backup_dir(pid, version["v"], keg)
    reverse = bool(patch.get("reversal"))
    result = diffapply.apply_diff(data, tree_root, backup_dir, reverse=reverse)
    if not result["ok"]:
        _stamp_failure(store, tree_root, keg, patch, version,
                       "reversal failed" if reverse else "apply failed",
                       result["reason"])
        fails = [f for f in result.get("files", []) if f["status"] == "fail"]
        _log.warning("patch %s v%d %s: %s | %s", pid, version["v"],
                     "reversal FAILED" if reverse else "apply FAILED",
                     result["reason"],
                     "; ".join(f"{f['path']}: {f.get('reason')}"
                               for f in fails[:20]))
        return {"id": pid, "action": "needs_review", "reason": result["reason"],
                "reversal": reverse}

    applied_files = []
    for f in result["files"]:
        target, _why = diffapply.safe_join(tree_root, f["path"])
        data_now = _read(target) if target else None
        applied_files.append({"path": f["path"],
                              "sha256": _sha(data_now) if data_now is not None else None,
                              "status": f["status"]})
    at = _patches.now_iso()
    _patches.set_keg_record(version, keg, at=at, files=applied_files,
                            backup_dir=_patches.rel(backup_dir, store.base_dir),
                            tree_root=tree_root)
    patch["state"] = "applied"
    patch["state_detail"] = ""
    patch["state_changed_at"] = at
    patch["last_verified"] = {"keg_id": keg, "at": at}
    changed = any(f["status"] == "applied" for f in result["files"])
    return {"id": pid, "action": "applied", "v": version["v"],
            "changed_on_disk": changed}


def _unwind_applied(store, tree_root, keg, patch, skip_v=None):
    """Restore the backups of every applied version of this patch for THIS
    keg, newest first, until the tree is back at pristine vanilla. PR diffs
    are always vanilla-based, so a (re)apply must start from unwound bytes —
    stacking v2 on v1-patched files is not the declarative contract.
    Returns False (patch marked needs_review) on a failed restore."""
    pid = patch["id"]
    vers = [v for v in patch.get("versions", [])
            if _patches.keg_record(v, keg)
            and _patches.keg_record(v, keg).get("status") == "applied"
            and v.get("v") != skip_v]
    vers.sort(key=lambda v: ((_patches.keg_record(v, keg) or {}).get("at") or "",
                             v.get("v", 0)),
              reverse=True)
    for v in vers:
        bd = (_patches.keg_record(v, keg) or {}).get("backup_dir")
        if bd:
            result = diffapply.restore_backup(_abs(store, bd), tree_root)
            if not result["ok"]:
                _stamp_failure(store, tree_root, keg, patch, v,
                               "restore failed", result["reason"])
                _log.warning("patch %s: backup restore FAILED (v%d, %s): %s",
                             pid, v.get("v"), bd, result["reason"])
                return False
        _patches.clear_keg_record(v, keg)
    return True


def _restore_patch(store, tree_root, keg, patch, version) -> dict:
    """Restore pristine bytes: unwind the whole applied chain for this keg
    (a version cycle v1->v2 leaves backups that must rewind newest-first)."""
    pid = patch["id"]
    rec = _patches.keg_record(version, keg)
    if rec is None or not rec.get("backup_dir") or rec.get("status") != "applied":
        # nothing on disk for THIS keg (fresh upgrade) — already pristine
        _patches.clear_keg_record(version, keg)
        patch["state"] = "disabled"
        patch["state_detail"] = "disabled"
        return {"id": pid, "action": "already-clean"}
    if not _unwind_applied(store, tree_root, keg, patch):
        return {"id": pid, "action": "needs_review",
                "reason": patch["state_detail"]}
    patch["state"] = "disabled"
    patch["state_detail"] = "disabled — files restored"
    patch["state_changed_at"] = _patches.now_iso()
    return {"id": pid, "action": "restored"}


def _restore_dropped_surface(store, tree_root, keg, patch) -> list[dict]:
    """PAT-TABLE: restore vanilla bytes when this tree no longer mounts the
    patch — the VANILLA box was unchecked (scope narrowed to dev), the entry
    was widened so the dev keg copy belongs on the branch now, or a dev/
    scoped patch carries a legacy applied record on this keg. No-op when
    nothing is applied HERE, so the historic 'dev-scope is invisible to
    reconcile' behaviour stays byte-identical (no extra writes, no spam).
    Unlike _restore_patch (the disable path) this must NOT stamp the patch
    'disabled' while it is still enabled for the other surface — the honest
    shared state then is 'pending', pointing at the next build."""
    pid = patch.get("id")
    applied_here = [v for v in patch.get("versions", [])
                    if (_patches.keg_record(v, keg) or {}).get("status")
                    == "applied"]
    if not applied_here:
        return []
    if not _unwind_applied(store, tree_root, keg, patch):
        return [{"id": pid, "action": "needs_review",
                 "reason": patch.get("state_detail")}]
    at = _patches.now_iso()
    if patch.get("enabled"):
        patch["state"] = "pending"
        patch["state_detail"] = ("vanilla bytes restored here — the "
                                 "omlx-dev branch carries it at the next "
                                 "build")
    else:
        patch["state"] = "disabled"
        patch["state_detail"] = "disabled — files restored"
    patch["state_changed_at"] = at
    _log.info("patch %s: surface unselected — restored vanilla bytes on "
              "keg %s", pid, keg)
    return [{"id": pid, "action": "restored",
             "reason": "surface no longer selected here"}]


def reconcile(store, tree_root: str, allow_reexec: bool = True,
              deadline: float | None = None) -> dict:
    """Core pass over the manifest against a concrete tree root.
    Returns {skipped_reason?, verify_only, changed, reports, reexec}.
    Never raises for patch-level failures; callers still guard."""
    deadline = deadline if deadline is not None else time.monotonic() + TIME_BUDGET_S
    report = {"verify_only": False, "changed": False, "reports": [],
              "reexec": False}

    manifest = store.load()
    plist = manifest.get("patches", [])
    if not plist:
        return report

    if store.patches_disabled():
        report["verify_only"] = True
        report["skipped_reason"] = "kill switch"
        _log.info("reconcile SKIPPED: kill switch active")
        return report

    keg = _patches.keg_id(os.path.join(tree_root, "omlx"))
    if not keg:
        report["verify_only"] = True
        report["skipped_reason"] = "keg id unresolvable"
        _log.warning("reconcile SKIPPED: keg id unresolvable under %s",
                     tree_root)
        return report

    lock_fh = None
    try:
        os.makedirs(store.base_dir, exist_ok=True)
        lock_fh = open(store.lock_path, "a+")
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        report["verify_only"] = True
        report["skipped_reason"] = "lock busy"
        _log.info("reconcile SKIPPED: lock busy (another process reconciles)")
        if lock_fh is not None:
            lock_fh.close()
        return report

    try:
        ordered = sorted(plist, key=lambda p: (p.get("order", 100), p.get("id", "")))
        deferred = False
        # TARGET FROM THE TREE, not the process: the boot pass is unchanged
        # (tree_root IS the process tree there), but the CLI may now drive
        # reconcile against the OTHER board's keg (patch apply --target dev)
        # and the RUNTIME-MOUNT gate must follow the tree being mounted.
        on_dev_keg = (_patches.detect_patch_target(
            os.path.join(tree_root, "omlx")) == "dev")
        for patch in ordered:
            scope = _patches.patch_scope(patch)
            enabled = bool(patch.get("enabled"))
            if (on_dev_keg and scope != _patches.SCOPE_OMLX) \
                    or not _patches.scope_touches_keg(scope):
                # RUNTIME-MOUNT doctrine (2026-10-18): a dev keg mounts the
                # runtime (omlx) overlays just like the vanilla keg — patching
                # without a rebuild. dev/both diffs ride the uplift-dev branch
                # instead; their keg halves would collide with the branch-
                # baked hunks or carry files the keg does not own.
                # PAT-TABLE: 'invisible to reconcile' must not mean 'frozen
                # patched'. When the VANILLA box is unchecked (or the entry
                # was just widened so its keg copy belongs on the branch
                # now), the still-applied bytes here restore THIS restart —
                # otherwise the unchecked box lies until remove. No record
                # here (the historic dev-scope case): stays a pure skip.
                for rep in _restore_dropped_surface(
                        store, tree_root, keg, patch):
                    report["reports"].append(rep)
                    if rep.get("action") in ("restored", "needs_review"):
                        report["changed"] = True
                continue
            desired = None
            target_v = _patches.version_target(patch, "runtime")
            if target_v:
                # PAT-TABLE: the pin (Manage) wins over the shared desired
                # version — two surfaces can sit on different copies.
                desired = store.get_version(patch, target_v)
            state = patch.get("state")

            if enabled and desired is not None:
                held = _safeguards.held(
                    (desired.get("safeguards") or {}).get("codes", []),
                    patch.get("safeguard_always"), patch.get("safeguard_once"),
                    desired.get("content_sha256"))
                if held:
                    # explicit approval missing: auto-apply is refused, the
                    # patch stays pending until the user approves per code
                    if patch.get("state") != "pending":
                        patch["state"] = "pending"
                    patch["state_detail"] = ("auto-apply held — safeguards "
                                             "need approval: " + ", ".join(held))
                    report["reports"].append(
                        {"id": patch["id"], "action": "approval_required",
                         "codes": held})
                    continue
                applied = _patches.keg_record(desired, keg)
                if (state == "applied" and applied
                        and applied.get("status") == "applied"
                        and _files_match(tree_root, applied.get("files", []))):
                    # desired is live; still unwind any stale earlier-version
                    # backups so a later disable/remove has a clean chain
                    patch["last_verified"] = {"keg_id": keg,
                                              "at": _patches.now_iso()}
                    if any(_patches.keg_record(v, keg)
                           and v.get("v") != desired.get("v")
                           for v in patch.get("versions", [])):
                        _unwind_applied(store, tree_root, keg, patch,
                                        skip_v=desired.get("v"))
                        report["changed"] = True
                    continue  # fast verify-only path
                # (re)apply always starts from pristine bytes: unwind every
                # other applied version of this patch first (version cycle)
                if not _unwind_applied(store, tree_root, keg, patch,
                                       skip_v=desired.get("v")):
                    report["reports"].append(
                        {"id": patch["id"], "action": "needs_review",
                         "reason": patch.get("state_detail")})
                    continue
                res = _apply_patch(store, tree_root, keg, patch, desired, deadline)
                if res["action"] == "deferred":
                    deferred = True
                report["changed"] |= bool(res.get("changed_on_disk"))
                report["reports"].append(res)
            elif not enabled:
                applied_v = None
                for ver in patch.get("versions", []):
                    if _patches.keg_record(ver, keg):
                        applied_v = ver
                        break
                if applied_v is not None:
                    res = _restore_patch(store, tree_root, keg, patch, applied_v)
                    report["changed"] |= res["action"] == "restored"
                    report["reports"].append(res)
                elif state in ("pending", "update_available", "needs_review"):
                    patch["state"] = "disabled"
                    patch["state_detail"] = "disabled"
        if deferred:
            report["deferred"] = True
            report["changed"] = True  # pending work remains -> honest flag
        if report["changed"] and allow_reexec:
            report["reexec"] = True
    finally:
        try:
            store.save(manifest)
        except OSError as exc:
            _log.error("reconcile: manifest save FAILED — state changes from "
                       "this pass are lost: %s", exc)
        lock_fh.close()
    for rep in report["reports"]:
        if rep.get("action") in ("needs_review", "deferred"):
            _log.info("reconcile: patch %s -> %s (%s)", rep.get("id"),
                      rep.get("action"), rep.get("reason"))
        elif rep.get("action") == "approval_required":
            _log.info("reconcile: patch %s held for safeguard approval: %s",
                      rep.get("id"), ", ".join(rep.get("codes", [])))
    if report["reports"]:
        _log.info("reconcile done: %d report(s), changed=%s reexec=%s",
                  len(report["reports"]), report["changed"],
                  report.get("reexec", False))
    return report


def _want_reexec(report: dict) -> bool:
    return report.get("reexec") and not os.environ.get(NO_REEXEC_ENV)


_post_reexec_boot = False


def sync_at_startup(store=None, tree_root: str | None = None,
                    allow_reexec: bool = True) -> dict:
    """.pth entry point. Reconcile, then re-exec ONCE if files changed.
    Never raises. Returns the report (useful for the CLI; the .pth path
    ignores it because a re-exec or exec completion replaces the process)."""
    global _post_reexec_boot
    started = time.monotonic()
    store = store or _patches.PatchStore()
    # Loop guard, checked FIRST every boot: an env marker means a re-exec
    # already happened in this process chain -> clean it (marker file +
    # env token, so server children never inherit it) and never exec again.
    marker = os.environ.get(REEXEC_ENV)
    if marker:
        try:
            os.remove(marker)
        except (OSError, TypeError):
            pass
        os.environ.pop(REEXEC_ENV, None)
        _post_reexec_boot = True
    else:
        # stale marker file from a boot that took the fast path
        try:
            os.remove(os.path.join(store.base_dir, ".reexec-marker"))
        except OSError:
            pass
    if tree_root is None:
        root = _patches._omlx_root()
        if not root:
            _log.warning("uplift boot sync skipped: omlx not importable")
            return {"skipped_reason": "omlx not importable", "verify_only": True,
                    "changed": False, "reports": [], "reexec": False}
        tree_root = os.path.dirname(root)

    report = reconcile(store, tree_root, allow_reexec=allow_reexec)
    # BUILD-STAMP self-heal (user report 2026-10-19): on the dev board the
    # branch is the apply target, so a stamp whose commit a later build cut
    # away has no reconcile lane to clear it. Verify the stamps against the
    # branch here — store-only, never a file write, never a rebuild.
    if _patches.detect_patch_target() == "dev":
        try:
            from . import devsrc

            healed = devsrc.prune_stale_build_stamps(store)
            stale = [k for k, v in healed.items() if v == "stale"]
            if stale:
                _log.warning(
                    "uplift: omlx-dev build stamps pruned — %s is/are not on "
                    "the branch anymore (the running build does not contain "
                    "them)", ", ".join(stale))
        except Exception as exc:                    # noqa: BLE001 — repair
            _log.debug("devsrc stamp check skipped: %s", exc)
    report["sync_seconds"] = round(time.monotonic() - started, 3)
    _log.info("uplift boot sync: %.3fs, %d report(s), changed=%s",
              report["sync_seconds"], len(report.get("reports", [])),
              report.get("changed"))
    if report.get("reexec") and not _want_reexec(report):
        # NO_REEXEC env: caller wants boot-with-pending, not a restart
        report["reexec"] = False
        report["reexec_suppressed"] = True

    if _want_reexec(report):
        if _post_reexec_boot:
            # already re-execed once in this chain (guard detected above):
            # boot with whatever state remains; no second exec, no loop
            report["reexec"] = False
            report["loop_guard"] = True
        else:
            import sys as _sys

            argv = list(_sys.argv)
            if argv and argv[0] and os.path.isfile(argv[0]):
                mk_path = os.path.join(store.base_dir, ".reexec-marker")
                try:
                    with open(mk_path, "w") as fh:
                        fh.write(_patches.now_iso())
                except OSError:
                    mk_path = None
                env_token = mk_path or "1"
                os.environ[REEXEC_ENV] = env_token
                report["reexec_at"] = _patches.now_iso()
                _log.warning("uplift: patch files changed on disk — "
                             "re-execing process once to load them")
                # exec replaces this process: python <original script> <args...>
                # (environment, incl. the one-shot marker token, survives)
                try:
                    os.execv(_sys.executable,
                             [_sys.executable] + argv)
                except OSError as exc:  # pragma: no cover
                    _log.error("patchsync re-exec failed: %s", exc)
                    report["reexec"] = False
                    if mk_path:
                        os.environ.pop(REEXEC_ENV, None)
            else:
                # argv[0] not a script file (python -c / -m): re-exec would
                # not reconstruct the command line — boot with pending state
                report["reexec"] = False
                report["skipped_reason"] = "argv not re-execable"
    return report
