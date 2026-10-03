"""Patch sources + validation gate (PAT-2) — orchestration layer.

BE-3 split: the fetch layer lives in patchfetch.py, the gate in
patchgate.py; both are re-exported here (seam compatibility). What stays:
fetch_and_gate (the fetch|gate composition), manifest CRUD (add_patch,
set_enabled, promote, rollback, remove), the upstreamed/base-gate probes
and the materializer feed.

Fetch patch bodies from GitHub PRs, plain URLs, or UI uploads; run the
validation gate BEFORE anything becomes 'pending':

    fetch (2xx, non-empty, parses, >=1 hunk, <= SIZE_CAP)
      -> diffapply.parse (binary/mode/rename/unsafe paths rejected)
      -> strict dry-run against the LIVE keg
      -> py_compile each touched .py on the in-memory post-apply bytes
      -> json.load each touched .json
    only then: store as version, state=pending.

Fetch fail-safe (PAT-0): a failed fetch is display-only — stored version,
state and source_head_sha stay untouched. A network outage must never
degrade a healthy applied patch toward needs_review.

Stdlib only (urllib) — usable from the router AND the .pth startup path.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field

from . import diffapply
from . import safeguards as _safeguards

# Propagates to the root logger — omlx's logging_config puts its stderr/
# file handler there, so these lines land in the omlx server log and obey
# the omlx log level (TRACE=5 down to CRITICAL) with no extra wiring.
_log = logging.getLogger("omlx_uplift.patchsource")

# --------------------------------------------------------------------------
# BE-3 step 1: fetch + gate logic moved verbatim to patchfetch.py /
# patchgate.py. Re-exported here so every existing seam keeps working:
# tests monkeypatch patchsource.fetch_pr/fetch_url/validate and the
# internal call sites below resolve the SAME module-global names, so a
# patch on patchsource still intercepts them (pure move, zero behavior
# change — the acceptance criterion for this step).
# --------------------------------------------------------------------------
from .patchfetch import (          # noqa: F401  (re-export seam)
    SIZE_CAP, _PR_URL_RE, _opener, _head_sha_from_patch,
    url_advisories, parse_pr_ref, fetch_bytes, fetch_pr, fetch_url,
    accept_upload,
)
from .patchgate import (           # noqa: F401  (re-export seam)
    _py_compiles, compile_gate, validate, gate_all_already,
)



def fetch_and_gate(source: dict, tree_root: str,
                   overrides: dict | None = None,
                   reverse: bool = False,
                   skip_patterns: list[str] | None = None,
                   tree_kind: str = "keg") -> dict:
    """One-stop for add/check: source = {kind, repo?, pr?, url?, data?,
    insecure_tls?}. Fetch (if needed) then validate. On fetch failure the
    caller MUST keep stored state untouched (fail-safe rule).
    reverse: True gates the fetched diff as a REVERSAL patch.
    skip_patterns: prune non-installable file sections (see validate).
    Build-scope gating passes skip_patterns=None and a source-checkout
    tree_root — the stored diff bytes are then UNPRUNED, which is what
    the dev-src materializer (DEV-2) applies as commits.
    tree_kind: 'keg' (default) or 'src' — what tree_root IS, for the
    safeguards heuristics only (advisory; never touches verdicts/bytes)."""
    kind = source.get("kind")
    tls = bool(source.get("insecure_tls"))
    if kind == "github_pr":
        ref = None
        if source.get("repo") and source.get("pr"):
            ref = (source["repo"], int(source["pr"]))
        elif source.get("url"):
            ref = parse_pr_ref(source["url"])
        if not ref:
            return {"ok": False, "stage": "source",
                    "reason": "invalid GitHub PR reference"}
        fetched = fetch_pr(ref[0], ref[1], tls)
        advisories = url_advisories(fetched.get("url", ""))
    elif kind == "url":
        url = source.get("url") or ""
        fetched = fetch_url(url, tls)
        advisories = url_advisories(url)
    elif kind == "upload":
        fetched = accept_upload(source.get("data") or b"")
        advisories = []
    else:
        return {"ok": False, "stage": "source", "reason": f"unknown kind: {kind}"}
    if not fetched["ok"]:
        _log.warning("fetch FAILED for %s: %s", source.get("url") or
                     f"{source.get('repo', '')}#{source.get('pr', '')}",
                     fetched["reason"])
        return {"ok": False, "stage": "fetch", "reason": fetched["reason"],
                "advisories": advisories}
    gate = validate(fetched["data"], tree_root, overrides=overrides,
                    reverse=reverse, skip_patterns=skip_patterns,
                    tree_kind=tree_kind)
    ref = (fetched.get("url") or source.get("kind") or "?")
    if gate.get("skipped"):
        advisories = list(advisories) + [
            f"skipped {len(gate['skipped'])} file(s) not present in an "
            "installed keg: " + ", ".join(gate["skipped"][:10])
            + ("…" if len(gate["skipped"]) > 10 else "")]
        _log.info("pruned %d non-installable file(s) from %s: %s",
                  len(gate["skipped"]), ref, ", ".join(gate["skipped"]))
    if not gate["ok"]:
        # one warning with the REAL per-file verdicts — this is what the
        # HTTP response truncates to "one or more files failed"
        fails = [f for f in gate.get("files", []) if f["status"] == "fail"]
        detail = "; ".join(f"{f['path']}: {f.get('reason')}" for f in fails[:20])
        _log.warning("gate REJECTED %s (%d/%d files failed): %s", ref,
                     len(fails), len(gate.get("files", [])),
                     detail or gate.get("reason") or "no per-file detail")
    else:
        _log.debug("gate passed %s (%d files, sha %s)", ref,
                   len(gate.get("files", [])), gate["content_sha256"][:12])
    return {**gate, "stage": "gate", "advisories": advisories,
            "content_sha256": gate["content_sha256"],
            "source_head_sha": fetched.get("source_head_sha")}


# --------------------------------------------------------------------------
# Orchestration — manifest bookkeeping over the gate (router + CLI share this)
# --------------------------------------------------------------------------

from . import patches as _patches


def dev_build_root() -> str | None:
    """Root of the clean dev-src checkout used to gate build-scope patches,
    or None when omlx-dev is not set up. dev.json's src_path is the single
    source of truth (the same one `dev status` reads) — a hardcoded
    <base>/dev-src guess broke whenever OMLX_BASE_PATH differed between
    the server process and the shell that ran bootstrap. Both candidate
    data dirs are checked (env base first, then canonical ~/.omlx/uplift):
    the bootstrap that created dev-src may have run under either. Kept
    tiny and import-safe — DEV-2/DEV-5 read the full config from dev.json."""
    from . import devsrc

    bases = []
    env_base = os.environ.get("OMLX_BASE_PATH")
    if env_base:
        bases.append(os.path.join(env_base, "uplift"))
    bases.append(os.path.expanduser(os.path.join("~", ".omlx", "uplift")))
    # the standard coexistence layout: bootstrap may have run inside a
    # shell that exported OMLX_BASE_PATH=~/.omlx-dev while the server does
    # not (or vice versa) — that split is exactly what rejected adds
    bases.append(os.path.join(os.path.expanduser(devsrc.RUNTIME_DEFAULTS["base_path"]),
                              "uplift"))
    for base in dict.fromkeys(bases):
        cfg = devsrc.load_config(base)
        cand = (devsrc.src_path(cfg) if cfg
                else os.path.join(base, "dev-src"))
        if os.path.isdir(os.path.join(cand, ".git")):
            return cand
    return None


def _read_patch_file(store, version: dict) -> bytes | None:
    pf = version.get("patch_file") or ""
    path = pf if os.path.isabs(pf) else os.path.join(store.base_dir, pf)
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def _prune_once(store, manifest) -> None:
    """Retention cap runs once when uplift starts work (PAT-5 rule)."""
    try:
        _patches.prune_versions(manifest, store)
    except OSError:
        pass


def _ui_files(result: dict) -> list[dict]:
    """Gate files plus SKIPPED rows for pruned paths — display-only: the
    gate's own all-'already'/all-'ok' logic must keep seeing the real
    check results without the pruned noise."""
    return list(result.get("files", [])) + [
        {"path": p, "status": "skipped", "reason": "matches skip pattern"}
        for p in result.get("skipped", [])]


# --------------------------------------------------------------------------
# BE-3 step 5: add_patch as PHASES returning ONE response shape.
# The old version was 275 lines with 33 branches and 12 non-uniform dict
# returns; UI/CLI/tests depend on a stable subset. PatchOpResult is that
# subset; `extras` carries the gate payloads (files/compile_problems/
# advisories/safeguards/needs_build_scope) that some verdicts include.
# render() reproduces the historical wire format key-for-key.
# --------------------------------------------------------------------------

@dataclass
class PatchOpResult:
    ok: bool
    stage: str = ""            # config|gate|gate-both|classification|stored|adopted|unchanged|obsolete-held
    reason: str | None = None
    v: int | None = None
    state: str | None = None
    reversal: bool = False
    unchanged: bool = False
    adopted: bool | None = None
    obsolete: bool | None = None     # per-verdict key presence is decided
                                     # by render() (v1 emitted it only on
                                     # obsolete/adopted verdicts)
    requires_approval: list = field(default_factory=list)
    note: str | None = None
    extras: dict = field(default_factory=dict)

    def render(self) -> dict:
        """The wire dict, verdict by verdict — the EXACT key sets of the
        twelve v1 returns this replaced (tests and the UI read: config ->
        reason only; gate failures -> stage/reason/files/compile_problems/
        advisories; unchanged -> unchanged/v/state/advisories; obsolete-
        held -> obsolete/reason/advisories/files/safeguards/
        requires_approval; adopted -> adopted+obsolete/reversal/...;
        stored -> reversal/requires_approval/safeguards/note always)."""
        e = self.extras
        if self.stage == "config":
            return {"ok": False, "reason": self.reason}
        if self.stage in ("gate", "fetch", "source", "keg-gate"):
            d = {"ok": False, "stage": self.stage, "reason": self.reason}
            d["files"] = e.get("files", [])
            d["compile_problems"] = e.get("compile_problems", [])
            d["advisories"] = e.get("advisories", [])
            return d
        if self.stage == "classification":
            return {"ok": False, "stage": "classification",
                    "reason": self.reason,
                    "needs_build_scope": e.get("needs_build_scope"),
                    "files": e.get("files", []),
                    "compile_problems": e.get("compile_problems", []),
                    "advisories": e.get("advisories", [])}
        if self.stage == "unchanged":
            return {"ok": True, "unchanged": True, "v": self.v,
                    "state": self.state,
                    "advisories": e.get("advisories", [])}
        if self.stage == "obsolete-held":
            return {"ok": True, "obsolete": True, "reason": self.reason,
                    "advisories": e.get("advisories", []),
                    "files": e.get("files", []),
                    "safeguards": e.get("safeguards", {}),
                    "requires_approval": self.requires_approval}
        if self.stage == "adopted":
            # v1: key ALWAYS present — None when adopted, True when the
            # hunks were already upstream but nothing was adopted
            return {"ok": True, "v": self.v, "adopted": self.adopted,
                    "obsolete": None if self.adopted else True,
                    "reversal": self.reversal,
                    "state": self.state, "reason": self.reason,
                    "advisories": e.get("advisories", []),
                    "files": e.get("files", [])}
        # 'stored' (and anything else): the v1 stored verdict — the note
        # key is ALWAYS present (v1 dict literal carried result.get('note'),
        # null when no root normalization happened)
        return {"ok": True, "v": self.v, "state": self.state,
                "reversal": self.reversal,
                "advisories": e.get("advisories", []),
                "files": e.get("files", []),
                "safeguards": e.get("safeguards", {}),
                "requires_approval": self.requires_approval,
                "note": self.note}


def _add_reject(reason: str) -> PatchOpResult:
    return PatchOpResult(ok=False, stage="config", reason=reason)


def _add_gate(store, manifest, patch, creating: bool, patch_id: str,
              source: dict, tree_root: str, effective_scope: str,
              build_root: str | None) -> tuple[PatchOpResult | None, dict | None]:
    """Fetch + gate for the add/update flow. Returns (failure, result).

    'both' scope double-gates: clean on the FULL diff at the dev root,
    AND clean as the PRUNED overlay at the keg — a 'both' patch must never
    store something the vanilla keg cannot host. A failed keg gate may be
    a scope signal: when the failing/pruned sections exist only in a
    source checkout (DEV-1 classification), name them so the caller can
    offer scope=both instead of a bare rejection."""
    gate_root, gate_overrides, patterns, gate_kind = _gate_root_selection(
        store, manifest, patch, tree_root, scope=effective_scope,
        dev_root=build_root)          # add_patch gates the CALLER's root
    is_dev = _patches.scope_touches_dev(effective_scope)
    result = fetch_and_gate(source, gate_root, overrides=gate_overrides,
                            reverse=bool(patch.get("reversal")),
                            skip_patterns=patterns, tree_kind=gate_kind)
    if result["ok"] and effective_scope == _patches.SCOPE_BOTH:
        keg_res = fetch_and_gate(source, tree_root,
                                 overrides=_pristine_overlay(store, patch, tree_root),
                                 reverse=bool(patch.get("reversal")),
                                 skip_patterns=_patches.skip_patterns(manifest))
        if not keg_res["ok"]:
            fail = PatchOpResult(
                ok=False, stage="keg-gate",
                reason=("the dev side gates clean but the pruned keg "
                        "overlay does not — use scope=dev: "
                        + str(keg_res.get("reason"))),
                extras={"files": _ui_files(keg_res),
                        "compile_problems": keg_res.get("compile_problems", []),
                        "advisories": keg_res.get("advisories", [])})
            _discard_patch(store, manifest, patch, creating)
            return fail, None
        # both stores the SRC-gate report, but the keg half carries its own
        # real hazard (a pruned overlay can still land custom_kernels/*.py
        # wrappers next to stale compiled artifacts). The keg gate just ran
        # and passed — adopt ITS problems as the blocking set and keep the
        # src advisories for display, so 'both' never loses kernel hold.
        result["safeguards"] = {
            "problems": (keg_res.get("safeguards") or {}).get("problems", []),
            "codes": (keg_res.get("safeguards") or {}).get("codes", []),
            "advisories": (result.get("safeguards") or {}).get("advisories", []),
            "truncated": (keg_res.get("safeguards") or {}).get("truncated", False)}
    if not result["ok"]:
        if not is_dev:
            fails = [f for f in result.get("files", []) if f["status"] == "fail"]
            missing = [f["path"] for f in fails
                       if (f.get("reason") or "").startswith("target file missing")]
            pruned = list(result.get("skipped", []))
            build_only = sorted(set(pruned) | set(missing))
            if build_only and build_root:
                verdict = fetch_and_gate(source, build_root, reverse=
                                         bool(patch.get("reversal")),
                                         skip_patterns=None)
                if verdict.get("ok"):
                    fail = PatchOpResult(
                        ok=False, stage="classification",
                        reason=(f"{len(build_only)} section(s) exist only "
                                "in a source checkout — add with "
                                "scope=both (or scope=dev to skip "
                                "the keg)"),
                        extras={"needs_build_scope": build_only,
                                "files": _ui_files(result),
                                "compile_problems": result.get("compile_problems", []),
                                "advisories": result.get("advisories", [])})
                    _discard_patch(store, manifest, patch, creating)
                    return fail, None
        # files/compile_problems ride along so the UI per-file gate table
        # can show WHY (the top-level reason is only "one or more files failed").
        # stage passes through: 'fetch'/'source' failures keep their identity
        # (the router answers 422 for exactly those two).
        fail = PatchOpResult(
            ok=False, stage=result.get("stage", "gate"),
            reason=result.get("reason"),
            extras={"files": _ui_files(result),
                    "compile_problems": result.get("compile_problems", []),
                    "advisories": result.get("advisories", [])})
        _discard_patch(store, manifest, patch, creating)
        return fail, None
    return None, result


def _discard_patch(store, manifest, patch, creating: bool) -> None:
    """A failed add of a NEW patch leaves no trace (updates keep the old
    manifest untouched — nothing was appended)."""
    if creating:
        manifest["patches"].remove(patch)
        store.save(manifest)


def _add_store_version(store, manifest, patch, creating: bool,
                       result: dict) -> tuple[PatchOpResult, dict | None]:
    """Source/scope recorded, version written (or verdict: unchanged /
    obsolete-but-held). Returns (result, version_entry|None)."""
    source_clean = {k: result.get("source_" + k) or result.get(k)
                    for k in ("kind", "repo", "pr", "url", "insecure_tls")
                    if (result.get("source_" + k) or result.get(k)) is not None}
    data = result["diff"]
    sha = result["content_sha256"]
    same = [v for v in patch["versions"] if v.get("content_sha256") == sha]
    if same:
        # unchanged source content -> nothing new; report candidate status
        v = same[0]
        return (PatchOpResult(ok=True, stage="unchanged", v=v["v"],
                              state=patch["state"],
                              unchanged=True,
                              extras={"advisories": result.get("advisories", [])}),
                None)
    held = _safeguards.held(result.get("safeguards", {}).get("codes", []),
                            patch.get("safeguard_always"),
                            patch.get("safeguard_once"), sha)
    obsolete = [f for f in result["files"] if f["status"] == "already"]
    if obsolete and len(obsolete) == len(result["files"]) and held:
        # all hunks already present but safeguards need approval: refuse to
        # adopt silently — nothing stored, the user approves from the
        # preview (same gate as a normal pending patch). v1 removed a
        # newly-created entry here BEFORE saving:
        if creating:
            manifest["patches"].remove(patch)
        return (PatchOpResult(
            ok=True, stage="obsolete-held",
            reason="all hunks already present upstream — patch looks obsolete",
            obsolete=True, requires_approval=held,
            extras={"advisories": result.get("advisories", []),
                    "files": _ui_files(result),
                    "safeguards": result.get("safeguards", {})}), None)
    version = _store_version(store, patch, result)
    return (PatchOpResult(ok=True, stage="stored", v=version["v"],
                          requires_approval=held), version)


def _add_adopt(store, manifest, patch, creating: bool, patch_id: str,
               tree_root: str, result: dict, version: dict,
               is_dev: bool, held: list) -> PatchOpResult | None:
    """ADOPT phase: every hunk is already present in the live tree (the
    user patched by hand or a previous omlx merged it) and no safeguard is
    outstanding. Store the version, record it as applied on THIS keg and
    keep byte-exact backups — so it shows APPLIED and reconcile re-applies
    it automatically after a keg upgrade, or restores the originals on
    disable/remove. The user patched first, persisted later: that is a
    supported flow, not an error.
    For a REVERSAL 'already' means the tree is already at the PRE-image
    (the merged change is gone); its disable-restore target is the MERGED
    image, so the backup records the forward-applied bytes instead.
    Returns a verdict (always ok=True) when the adopt path ran."""
    all_already = result["files"] and all(
        f["status"] == "already" for f in result["files"])
    if not (all_already and not held and not is_dev):
        return None
    v = version["v"]
    keg = _patches.keg_id(os.path.join(tree_root, "omlx"))
    adopted = False
    if keg:
        backup_dir = store.backup_dir(patch_id, v, keg)
        try:
            res = diffapply.apply_diff(result["diff"], tree_root, backup_dir,
                                       reverse=bool(patch.get("reversal")))
        except OSError as exc:
            _log.warning("adopt backup write failed for %s v%d: %s",
                         patch_id, v, exc)
            res = {"ok": False}
        if res.get("ok"):
            applied_files = []
            for f in res["files"]:
                target, _why = diffapply.safe_join(tree_root, f["path"])
                try:
                    with open(target, "rb") as fh:
                        cur = fh.read()
                except OSError:
                    cur = None
                applied_files.append(
                    {"path": f["path"],
                     "sha256": (hashlib.sha256(cur).hexdigest()
                                if cur is not None else None),
                     "status": f["status"]})
            # apply_diff only backs up files it WRITES; on an all-already
            # adopt it wrote nothing. Revert the patch in memory (reverse
            # hunks -> vanilla pre-image) and store that as the backup,
            # so disable/remove restore byte-exact originals without the
            # tree ever going unpatched on disk. A reversal inverts the
            # direction: its backup holds the merged (forward-applied)
            # image, because that is what disable must bring back.
            if patch.get("reversal"):
                diffapply.record_merged_backup(result["diff"], tree_root, backup_dir)
            else:
                diffapply.record_pristine_backup(result["diff"], tree_root, backup_dir)
            from datetime import datetime as _dt, timezone as _tz
            version["applied"] = {"keg_id": keg,
                                  "at": _dt.now(_tz.utc).isoformat(
                                      timespec="seconds"),
                                  "files": applied_files}
            version["backup_dir"] = _patches.rel(backup_dir, store.base_dir)
            version["adopted"] = True
            patch["enabled"] = True
            patch["desired_version"] = v
            store.set_state_if(patch, "applied",
                               "adopted — hunks already present in the "
                               "live tree")
            patch["last_verified"] = {"keg_id": keg,
                                      "at": _patches.now_iso()}
            adopted = True
    _log.info("patch %s v%d ADOPTED as applied (%d files already "
              "present, keg %s)", patch_id, v, len(result["files"]), keg)
    store.save(manifest)
    rev = bool(patch.get("reversal"))
    reason = (("reversal already in effect — stored; reverts "
               "again after an omlx update, disable restores the "
               "merged bytes" if adopted else
               "reversal has nothing to undo on this tree")
              if rev else
              ("already applied — stored; re-applies after an "
               "omlx update, disable restores the originals"
               if adopted else
               "all hunks already present upstream — patch looks "
               "obsolete"))
    return PatchOpResult(
        ok=True, stage="adopted", v=v, state=patch["state"], reversal=rev,
        adopted=adopted, obsolete=not adopted, reason=reason,
        extras={"advisories": result.get("advisories", []),
                "files": _ui_files(result)})


def _add_transition(store, manifest, patch, patch_id: str, version: dict,
                    result: dict, held: list) -> PatchOpResult:
    """STATE phase: what the stored version means for the patch now
    (validated-not-enabled / awaiting approval / update candidate /
    pending-new)."""
    v = version["v"]
    if patch["state"] in ("disabled",) and not patch.get("enabled"):
        patch["state_detail"] = ("validated, safeguards need approval" if held
                                 else "validated, not enabled")
    elif held:
        # auto-apply is refused by reconcile until each code is approved
        store.set_state(patch, "pending",
                        "safeguards need approval: " + ", ".join(held))
    else:
        # new candidate on top of an applied patch -> update_available
        if any(ver.get("applied") for ver in patch["versions"]):
            store.set_state(patch, "update_available",
                            f"candidate v{v} fetched and validated")
        else:
            store.set_state(patch, "pending", f"v{v} validated, awaiting restart")
            patch["enabled"] = True
            patch["desired_version"] = v
    store.save(manifest)
    _log.info("patch %s stored as v%d state=%s (sha %s, reversal=%s)",
              patch_id, v, patch["state"], result["content_sha256"][:12],
              bool(patch.get("reversal")))
    return PatchOpResult(
        ok=True, stage="stored", v=v, state=patch["state"],
        reversal=bool(patch.get("reversal")), requires_approval=held,
        note=result.get("note"),
        extras={"advisories": result.get("advisories", []),
                "files": _ui_files(result),
                "safeguards": result.get("safeguards", {})})


def add_patch(store, patch_id: str, source: dict, tree_root: str,
              order: int = 100, reversal: bool = False,
              scope: str | None = None, build_root: str | None = None) -> dict:
    """Add (or update-check) a patch source: fetch -> gate -> store version.
    New patch lands as state=pending (needs Enable semantics are: pending +
    enabled=true -> applied at next reconcile).

    reversal: True records the patch as a REVERSAL — the stored diff stays
    the forward (merged) diff, everything downstream evaluates it in the
    un-apply direction. Used to undo a PR upstream already merged.

    scope (DEV-1): None = auto-classify — gate against the keg first, and
    when sections exist only in a full source checkout (csrc/, tests/,
    build files) return a verdict naming them so the caller can offer the
    'build' scope for the WHOLE patch. 'build' gates the UNPRUNED diff
    against build_root (a clean checkout of the dev-src sync ref) and the
    patch never touches the keg; requires build_root. 'runtime' forces the
    existing keg behaviour (pruned diff). The whole diff is one scope —
    no mixed patches.

    BE-3 step 5: thin orchestrator over the phases (_add_gate,
    _add_store_version, _add_adopt, _add_transition); every verdict is a
    PatchOpResult rendered to the historical dict shape — one contract for
    CLI, router and JS instead of 12 ad-hoc dicts."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", patch_id or ""):
        return _add_reject("name must match [a-z0-9][a-z0-9._-]{0,63}").render()
    if scope is not None:
        scope = _patches._LEGACY_SCOPE_NAMES.get(scope, scope)
        if scope not in _patches.SCOPES:
            return _add_reject(
                f"scope must be one of {list(_patches.SCOPES)}").render()
    if scope in (_patches.SCOPE_DEV, _patches.SCOPE_BOTH) and not build_root:
        return _add_reject(
            f"scope={scope} needs a source checkout: bootstrap omlx-dev "
            "(omlx-uplift dev bootstrap) or pass --build-root").render()
    manifest = store.load()
    _prune_once(store, manifest)
    patch = store.find(manifest, patch_id)
    creating = patch is None
    if not creating and bool(patch.get("reversal")) != bool(reversal):
        return _add_reject(
            ("this patch is recorded as a REVERSAL — keep "
             "'reverse a merged change' checked to update it"
             if patch.get("reversal") else
             "this patch applies forward — to reverse a merged "
             "PR, remove it and re-add with 'reverse' checked")
            + " (direction is fixed per patch)").render()
    cur_scope = _patches.patch_scope(patch) if not creating else None
    if not creating and scope is not None and scope != cur_scope:
        return _add_reject(
            f"this patch is recorded as scope={cur_scope} — "
            "scope is fixed per patch; remove and re-add to "
            "change it").render()
    effective_scope = scope or cur_scope or _patches.SCOPE_RUNTIME
    if creating:
        patch = {"id": patch_id, "enabled": False, "order": order,
                 "source": {}, "desired_version": 0, "versions": [],
                 "state": "disabled", "state_detail": "not yet validated"}
        manifest["patches"].append(patch)
    if reversal:
        patch["reversal"] = True

    is_dev = _patches.scope_touches_dev(effective_scope)
    fail, result = _add_gate(store, manifest, patch, creating, patch_id,
                             source, tree_root, effective_scope, build_root)
    if fail is not None:
        return fail.render()

    # v1 order kept: a PASSED gate rewrites the source record + scope
    # before any verdict (even 'unchanged' persists a changed source URL —
    # the last verified origin wins, source_clean never carries the data
    # blob).
    patch["source"] = {k: source.get(k) for k in
                       ("kind", "repo", "pr", "url", "insecure_tls")
                       if source.get(k) is not None}
    if effective_scope != _patches.SCOPE_OMLX:
        # record only the non-default scope so omlx manifests keep the
        # exact v1 shape (no-migration pattern); legacy runtime/build
        # normalize on read (DEV-6)
        patch["scope"] = effective_scope

    stored, version = _add_store_version(store, manifest, patch, creating,
                                         result)
    if version is None:
        store.save(manifest)
        return stored.render()

    held = stored.requires_approval
    adopt = _add_adopt(store, manifest, patch, creating, patch_id, tree_root,
                       result, version, is_dev, held)
    if adopt is not None:
        return adopt.render()
    return _add_transition(store, manifest, patch, patch_id, version,
                           result, held).render()


def _desired_version_entry(store, patch) -> dict | None:
    return store.get_version(patch, patch.get("desired_version"))


# --------------------------------------------------------------------------
# BE-3 step 2: ONE gate-root rule. Three call sites (add_patch,
# test_dry_run, check_all) each spelled "dev scope -> clean dev checkout
# with the FULL unpruned diff; keg -> live tree with the pristine overlay
# and manifest skip patterns"; check_all's copy silently omitted future
# drift. Selection returns (root, overrides, skip_patterns); a falsy root
# for a dev-touching scope means dev-src is missing and the CALLER owns
# the error wording (each site has its own UI/CLI contract).
# --------------------------------------------------------------------------

_DEV_ROOT_DEFAULT = object()


def _gate_root_selection(store, manifest, patch, tree_root: str, *,
                         scope: str | None = None,
                         dev_root=_DEV_ROOT_DEFAULT):
    """(root, overrides, skip_patterns, tree_kind) for gating this patch.
    tree_kind tells the safeguards heuristics WHAT the root is ('src'
    checkout vs installed 'keg'); verdicts and bytes are unaffected."""
    scope = scope or _patches.patch_scope(patch)
    if _patches.scope_touches_dev(scope):
        root = dev_build_root() if dev_root is _DEV_ROOT_DEFAULT else dev_root
        # 'both' ALSO runs a keg overlay gate in _add_gate — that pass
        # passes tree_kind='keg' explicitly, so the kernel heuristic is
        # still heard for the overlay half.
        return root, None, None, "src"
    return (tree_root, _pristine_overlay(store, patch, tree_root),
            _patches.skip_patterns(manifest), "keg")


def _store_version(store, patch: dict, result: dict) -> dict:
    """BE-3 step 2: write the gated diff to the patch store and append the
    version entry — ONE schema everywhere (add_patch and check_all's drift
    detector previously carried near-copies, and the check_all one lacked
    safeguards/root_note, so update candidates silently lost the fields
    the pending path enforced. Superset schema now: both paths record
    them). Returns the version dict (appended, not yet saved)."""
    from datetime import datetime, timezone

    v = store.next_version(patch)
    data = result["diff"]
    pf_rel = _patches.rel(store.patch_file(patch["id"], v), store.base_dir)
    pf_full = os.path.join(store.base_dir, pf_rel)
    os.makedirs(os.path.dirname(pf_full), exist_ok=True)
    tmp = pf_full + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, pf_full)
    version = {
        "v": v, "content_sha256": result["content_sha256"],
        "source_head_sha": result.get("source_head_sha"),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "patch_file": pf_rel,
    }
    sg = result.get("safeguards") or {}
    if sg.get("problems") or sg.get("advisories"):
        # one schema: problems block auto-apply, advisories are display-only
        # (e.g. native kernel paths on a dev carrier — stored so the card
        # shows its one honest line after a restart). 'both' carries both:
        # the keg overlay's hold AND the src-side advisory.
        version["safeguards"] = {
            "problems": sg.get("problems", []),
            "codes": sg.get("codes", []),
            "advisories": sg.get("advisories", []),
        }
        if sg.get("truncated"):
            version["safeguards"]["truncated"] = True
    if result.get("note"):
        version["root_note"] = result["note"]
    patch["versions"].append(version)
    return version


def _pristine_overlay(store, patch, tree_root: str) -> dict | None:
    """{rel_path: pristine_bytes} for files the patch currently has applied
    against the LIVE keg — the backup copies are byte-exact pre-apply state.
    Gating a fresh (vanilla-based) candidate must see the tree WITHOUT this
    patch's own hunks, the way reconcile unwinds them before (re)applying.
    None when the patch has nothing applied -> gate against the live tree."""
    keg = _patches.keg_id(os.path.join(tree_root, "omlx"))
    overlay: dict[str, bytes] = {}
    seen = False
    vers = sorted(patch.get("versions", []),
                  key=lambda v: ((v.get("applied") or {}).get("at") or "",
                                 v.get("v", 0)))
    for v in vers:
        applied = v.get("applied") or {}
        if not applied or applied.get("keg_id") != keg:
            continue
        bd = v.get("backup_dir")
        if not bd:
            continue
        seen = True
        bd_full = bd if os.path.isabs(bd) else os.path.join(store.base_dir, bd)
        meta_path = os.path.join(bd_full, "meta.json")
        meta = diffapply._load_backup_meta(meta_path)
        for rel_key, info in meta.get("files", {}).items():
            if rel_key in overlay:
                continue  # oldest backup wins: newest-first unwind restores it last
            if info.get("existed"):
                try:
                    with open(diffapply._backup_path(bd_full, rel_key), "rb") as fh:
                        overlay[rel_key] = fh.read()
                except OSError:
                    overlay.pop(rel_key, None)
            else:
                overlay[rel_key] = None  # file was created by the patch
    return (overlay or None) if seen else None


def view(store, tree_root: str, keg: str | None) -> dict:
    """Manifest view + live verification snapshot for GET /patches."""
    manifest = store.load()
    out = []
    for p in manifest.get("patches", []):
        desired = _desired_version_entry(store, p) or {}
        applied = desired.get("applied") or {}
        scope = _patches.patch_scope(p)
        # approvals are evaluated against the desired version; a never-
        # enabled patch has no desired yet -> judge its newest candidate so
        # the UI can show what Enable would require
        gate_ver = desired or (p.get("versions", [])[-1] if p.get("versions") else {})
        inactive_reason = None
        target = _patches.detect_patch_target()
        if not _patches.scope_touches_keg(scope) and target != "dev":
            # dev-scope patches are inert on a vanilla keg by design
            # (DEV-context 1): the dev-src materializer owns them
            inactive_reason = ("dev scope — materialized on the omlx-dev "
                               "branch, never applied to the keg")
        elif target == "dev" and scope == _patches.SCOPE_OMLX:
            inactive_reason = ("running inside the omlx-dev keg — its source "
                               "already carries dev patches; omlx-scope "
                               "overlays mount on the vanilla keg only")
        if target == "dev" and _patches.scope_touches_dev(scope):
            active = bool(p.get("enabled")) and p.get("state") == "applied"
        else:
            active = (_patches.scope_touches_keg(scope)
                      and bool(p.get("enabled")) and target != "dev")
        entry = {
            "id": p.get("id"), "enabled": p.get("enabled", False),
            "scope": scope,
            "active": active,
            "inactive_reason": inactive_reason,
            "reversal": bool(p.get("reversal")),
            "order": p.get("order", 100), "state": p.get("state"),
            "state_detail": p.get("state_detail", ""),
            "source": p.get("source", {}),
            "desired_version": p.get("desired_version"),
            "versions": [{k: v.get(k) for k in
                          ("v", "content_sha256", "source_head_sha",
                           "fetched_at", "applied", "safeguards",
                           "root_note", "adopted")}
                         for v in p.get("versions", [])],
            "safeguard_always": p.get("safeguard_always") or [],
            "safeguard_once": p.get("safeguard_once"),
            "requires_approval": _safeguards.held(
                (gate_ver.get("safeguards") or {}).get("codes", []),
                p.get("safeguard_always"), p.get("safeguard_once"),
                gate_ver.get("content_sha256")),
            "kernel_rebuild_hint": (_safeguards.KERNEL_REBUILD_HINT
                                    if "kernel_source" in
                                    (gate_ver.get("safeguards") or {}).get("codes", [])
                                    else None),
            "applied_v": desired.get("v") if applied else None,
            "keg_changed": bool(applied.get("keg_id") and keg
                                and applied["keg_id"] != keg),
            "advisories": url_advisories(
                (p.get("source") or {}).get("url") or ""),
            "last_verified": p.get("last_verified"),
            "description": p.get("description") or "",
            "curated": p.get("curated"),
            "curated_adopted": bool(p.get("curated_adopted")),
        }
        out.append(entry)
    return {"patches": out, "config": manifest.get("config", {}),
            "keg_id": keg, "kill_switch_active": store.patches_disabled(),
            "warning": store.warning_active(manifest),
            "load_error": manifest.get("load_error")}


# --------------------------------------------------------------------------
# BE-3 step 3: ONE safeguard-approval machine for enable and promote.
# Both entry points used to carry their own copy of {held? -> require
# approve once|always -> record safeguard_always/once}; the copies had
# DRIFTED: set_enabled re-checked coverage after recording ('codes raced'),
# promote did not, so a 'once' approval recorded from promote could silently
# leave codes uncovered (the exact 'once' is sha-bound security property
# STATE-GATE-1 made loud). Single-sourced: same validation, same recording,
# same post-check, same approved list.
# Returns (ok, approved_now, error_dict|None).
# --------------------------------------------------------------------------

def _apply_approval(patch: dict, version: dict, approve: str | None):
    codes = (version.get("safeguards") or {}).get("codes", [])
    held = _safeguards.held(codes, patch.get("safeguard_always"),
                            patch.get("safeguard_once"),
                            version.get("content_sha256"))
    if not held:
        return True, [], None
    if approve not in ("once", "always"):
        return False, [], {"ok": False,
                           "reason": "safeguards need approval: " + ", ".join(held),
                           "requires_approval": held}
    if approve == "always":
        patch["safeguard_always"] = sorted(set(patch.get("safeguard_always") or [])
                                           | set(held))
    else:
        patch["safeguard_once"] = {"sha": version.get("content_sha256"),
                                   "codes": sorted(held)}
    still = _safeguards.held(codes, patch.get("safeguard_always"),
                             patch.get("safeguard_once"),
                             version.get("content_sha256"))
    if still:  # approval did not cover everything (codes raced)
        return False, [], {"ok": False,
                           "reason": "still needs approval: " + ", ".join(still),
                           "requires_approval": still}
    return True, sorted(held), None


def set_enabled(store, patch_id: str, enabled: bool,
                approve: str | None = None) -> dict:
    """Enable/disable a patch. 'approve' ("once"|"always") explicitly
    accepts the safeguard codes of the desired version so auto-apply is
    allowed; the approval is recorded PER CODE — it never silences
    safeguards that do not apply to this patch. 'once' is bound to the
    exact content sha (a new version needs a fresh approval); 'always'
    covers the same codes on future versions."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    if enabled and not p.get("versions"):
        return {"ok": False, "reason": "no validated version — add a source first"}
    target_v = p.get("desired_version") or max(
        (v.get("v", 0) for v in p["versions"]), default=0)
    desired = store.get_version(p, target_v) or {}
    approved_now: list[str] = []
    if enabled:
        ok, approved_now, err = _apply_approval(p, desired, approve)
        if not ok:
            return err
    p["enabled"] = bool(enabled)
    if enabled:
        if not p.get("desired_version"):
            p["desired_version"] = target_v
        if p.get("state") in ("disabled",):
            store.set_state(p, "pending", "enabled — applies on next restart")
    else:
        store.set_state(p, "disabled", "disabled — restores on next restart")
    store.save(manifest)
    return {"ok": True, "state": p["state"], "approved": approved_now}


def promote(store, patch_id: str, approve: str | None = None) -> dict:
    """Accept the newest validated candidate as desired; on-disk stays until
    the next reconcile (restart). A candidate whose safeguards are not yet
    approved needs the same explicit 'once'/'always' approval as enable."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    newest = max((v.get("v", 0) for v in p.get("versions", [])), default=0)
    if not newest or newest == p.get("desired_version"):
        return {"ok": False, "reason": "no candidate to promote"}
    cand = store.get_version(p, newest) or {}
    # BE-3 step 3: promote now ALSO re-checks coverage after recording
    # (the drifted copy skipped it; the once-sha binding is the point).
    ok, _approved, err = _apply_approval(p, cand, approve)
    if not ok:
        return err
    p["desired_version"] = newest
    store.set_state(p, "pending", f"promoted to v{newest} — applies on next restart")
    p["enabled"] = True
    store.save(manifest)
    return {"ok": True, "state": p["state"], "desired_version": newest}


def rollback(store, patch_id: str, to_v: int | None = None) -> dict:
    """Point desired_version at a previous stored version; reconcile will
    restore its backup and re-apply those bytes at next restart."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    vs = sorted(v.get("v", 0) for v in p.get("versions", []))
    if to_v is None:
        older = [v for v in vs if v < p.get("desired_version", 0)]
        if not older:
            return {"ok": False, "reason": "no previous version to roll back to"}
        to_v = older[-1]
    if store.get_version(p, to_v) is None:
        return {"ok": False, "reason": f"version v{to_v} not stored"}
    p["desired_version"] = to_v
    store.set_state(p, "pending", f"rolled back to v{to_v} — applies on next restart")
    p["enabled"] = True
    store.save(manifest)
    return {"ok": True, "state": p["state"], "desired_version": to_v}


def remove_patch(store, patch_id: str, tree_root: str) -> dict:
    """Remove a patch: restore its pristine files NOW if it is applied, then
    drop manifest entry + stored files (backups included). Unwinds EVERY
    applied version's backup for the live keg (a version cycle leaves a
    chain; restoring only one link does not reach vanilla bytes)."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    restore_report = {"ok": True, "reason": None, "files": []}
    keg = _patches.keg_id(os.path.join(tree_root, "omlx"))
    chain = [v for v in p.get("versions", [])
             if (v.get("applied") or {}).get("keg_id") == keg]
    chain.sort(key=lambda v: ((v["applied"] or {}).get("at") or "", v.get("v", 0)),
               reverse=True)
    for v in chain:
        bd = v.get("backup_dir")
        if not bd:
            continue
        bd_full = bd if os.path.isabs(bd) else os.path.join(store.base_dir, bd)
        one = diffapply.restore_backup(bd_full, tree_root)
        for key in ("files",):
            restore_report[key] = restore_report[key] + one.get(key, [])
        if not one["ok"]:
            restore_report["ok"] = False
            restore_report["reason"] = one["reason"]
            break
    if chain:
        import shutil

        for v in chain:
            bd = v.get("backup_dir")
            if bd:
                bd_full = (bd if os.path.isabs(bd)
                           else os.path.join(store.base_dir, bd))
                shutil.rmtree(os.path.dirname(bd_full), ignore_errors=True)
    for ver in p.get("versions", []):
        pf = ver.get("patch_file")
        if pf:
            path = pf if os.path.isabs(pf) else os.path.join(store.base_dir, pf)
            try:
                os.remove(path)
            except OSError:
                pass
    manifest["patches"].remove(p)
    store.save(manifest)
    return {"ok": True, "restored": restore_report}


def test_dry_run(store, patch_id: str, tree_root: str) -> dict:
    """Re-validate stored desired version against the live keg, no writes.
    Build-scope patches re-validate against the dev-src checkout UNPRUNED
    (their gate tree by contract — the same bytes, sha-consistency rule)."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    desired = _desired_version_entry(store, p)
    if desired is None:
        return {"ok": False, "reason": "no desired version stored"}
    data = _read_patch_file(store, desired)
    if data is None:
        return {"ok": False, "reason": "stored patch file missing"}
    root, overrides, skip, kind = _gate_root_selection(store, manifest, p, tree_root)
    if not root:
        return {"ok": False,
                "reason": "dev-src checkout not found — dev patch "
                          "cannot re-gate (omlx-uplift dev bootstrap)"}
    result = validate(data, root, overrides=overrides,
                      reverse=bool(p.get("reversal")), skip_patterns=skip,
                      tree_kind=kind)
    result.pop("diff", None)  # bytes are not JSON-serialisable; caller has the id
    p["last_verified"] = {"at": _patches.now_iso(),
                          "ok": result["ok"]}
    store.save(manifest)
    return result


def _gate_all_already(result: dict) -> bool:
    """BE-3: moved to patchgate.gate_all_already; alias kept for the
    module-internal name."""
    return gate_all_already(result)


def _pr_merged_into_base(src: dict, diff_bytes: bytes | None,
                         reverse: bool = False) -> bool | None:
    """For a github_pr source with state='applied' but no content drift:
    is the PR's CONTENT already in our dev base commit?
    True = upstreamed, False = definitely not, None = inconclusive (no PR
    ref, network/API/git failure — the caller keeps up_to_date).

    Two rules learned the hard way (2026-09-29, live probe with merged
    jundot/omlx#3874):
      * GitHub REST reports merged PRs as state='closed' with merged_at
        set — state=='merged' is GraphQL-only and NEVER fires here.
      * jundot/omlx squash-merges: merge_commit_sha is a dangling commit
        that exists on neither local objects nor main, so ancestry can
        never prove content-in-base. The ancestry check stays as a fast
        path (rc 0 -> True), but the decisive test is gating the stored
        diff against a clean worktree at the base commit — exactly what
        materialize would see. Works for merge, squash and rebase flows.
    """
    ref = None
    if src.get("repo") and src.get("pr"):
        ref = (src["repo"], int(src["pr"]))
    elif src.get("url"):
        ref = parse_pr_ref(src["url"])
    if not ref or src.get("kind") != "github_pr":
        return None
    tls = bool(src.get("insecure_tls"))
    try:
        import subprocess
        api = fetch_bytes(
            f"https://api.github.com/repos/{ref[0]}/pulls/{ref[1]}", tls)
        if not api["ok"]:
            return None
        meta = json.loads(api["data"])
        if not meta.get("merged_at"):
            return False                      # open/closed-unmerged: needed
        merge_sha = meta.get("merge_commit_sha")
        from . import devsrc
        cfg = devsrc.load_config()
        if not cfg:
            return None
        root = devsrc.src_path(cfg)
        base = devsrc.base_sha_of(cfg)
        if not base or not os.path.isdir(os.path.join(root, ".git")):
            return None
        if isinstance(merge_sha, str) and re.fullmatch(r"[0-9a-f]{40}", merge_sha):
            proc = devsrc._git(["merge-base", "--is-ancestor", merge_sha, base],
                               cwd=root, check=False)
            if proc.returncode == 0:
                return True                   # true merge-commit flow, done
        if not diff_bytes:
            return None                       # nothing to content-gate with
        import tempfile
        wt = tempfile.mkdtemp(prefix="uplift-base-gate-")
        os.rmdir(wt)                          # worktree add wants it absent
        try:
            add = devsrc._git(["worktree", "add", "--detach", "--force",
                               wt, base], cwd=root, check=False)
            if add.returncode != 0:
                return None                   # objects not fetched yet
            res = fetch_and_gate({"kind": "upload", "data": diff_bytes}, wt,
                                 reverse=reverse, skip_patterns=None)
            return _gate_all_already(res) if res.get("ok") else False
        finally:
            devsrc._git(["worktree", "remove", "--force", wt], cwd=root,
                        check=False)
            subprocess.run(["rm", "-rf", wt], check=False)
    except Exception as exc:                         # noqa: BLE001 — fail soft
        # LOG-SILENT-1: fail-soft stays (None = inconclusive), but a
        # NameError or corrupt manifest used to read exactly like 'cannot
        # prove' — merged PRs sat at up_to_date forever with no trace.
        _log.warning("merged-into-base probe errored (treated as "
                     "inconclusive): %s", exc, exc_info=True)
        return None


def check_all(store, tree_root: str) -> dict:
    """Re-fetch every github_pr/url source — ENABLED AND DISABLED alike.
    A user who disabled a broken patch still wants to know when upstream
    fixes it (an update_available chip is the cue to re-enable). Changed
    content becomes a validated CANDIDATE version (state=update_available).
    Errors are per-patch display-only, never state-degrading (fail-safe
    rule). Disabled patches only ever get the candidate stored — nothing
    auto-applies to the tree for them (apply stays an enabled-patch act)."""
    manifest = store.load()
    reports = {}
    changed_any = False
    for p in manifest.get("patches", []):
        src = p.get("source") or {}
        pid = p.get("id")
        if src.get("kind") not in ("github_pr", "url"):
            continue
        root, overrides, skip, kind = _gate_root_selection(store, manifest, p, tree_root)
        if not root:
            reports[pid] = {"check": "error",
                            "reason": "dev-src checkout not found — "
                                      "cannot re-gate a dev patch"}
            continue
        result = fetch_and_gate(src, root, overrides=overrides,
                                reverse=bool(p.get("reversal")),
                                skip_patterns=skip, tree_kind=kind)
        if not result["ok"]:
            reports[pid] = {"check": "error", "reason": result.get("reason")}
            continue
        sha = result["content_sha256"]
        newest = max((v.get("v", 0) for v in p["versions"]), default=0)
        latest = store.get_version(p, newest) if newest else None
        head = result.get("source_head_sha")
        drifted = (latest is not None and (
            latest.get("content_sha256") != sha or
            (head and latest.get("source_head_sha") and
             latest.get("source_head_sha") != head)))
        if not drifted:
            # An upstream-MERGED PR stops drifting but also stops being
            # needed: the code is in upstream now. Detect that here — the
            # drifted path above already had an obsolete check; without it
            # a merged PR stays state='applied' forever.
            if p.get("state") == "applied":
                scope = _patches.patch_scope(p)
                if _patches.scope_touches_dev(scope):
                    # the dev gate ran against the uplift worktree which
                    # carries uplift's OWN commits — 'already' there means
                    # nothing; ask GitHub merged_at + content-gate the
                    # stored diff against a clean base checkout instead
                    newest0 = max((v.get("v", 0) for v in p["versions"]),
                                  default=0)
                    cur_v = store.get_version(p, newest0) if newest0 else None
                    diff_b = _read_patch_file(store, cur_v) if cur_v else None
                    verdict = _pr_merged_into_base(
                        src, diff_b, reverse=bool(p.get("reversal")))
                    if verdict is None and _patches.scope_touches_keg(scope):
                        # ancestry inconclusive: all-'already' across the
                        # pruned KEG gate is a strong signal too
                        keg_res = fetch_and_gate(
                            src, tree_root,
                            overrides=_pristine_overlay(store, p, tree_root),
                            reverse=bool(p.get("reversal")),
                            skip_patterns=_patches.skip_patterns(manifest))
                        upstreamed = (keg_res.get("ok")
                                      and _gate_all_already(keg_res))
                    else:
                        upstreamed = verdict is True
                else:
                    # runtime gate against the real tree already ran above
                    upstreamed = _gate_all_already(result)
                if upstreamed and store.set_state(
                        p, "obsolete",
                        "upstream now contains the patch — consider removing"):
                    reports[pid] = {"check": "obsolete"}
                    changed_any = True
                    continue
            reports[pid] = {"check": "up_to_date"}
            continue
        obsolete = [f for f in result["files"] if f["status"] == "already"]
        if obsolete and len(obsolete) == len(result["files"]) \
                and not _patches.scope_touches_dev(_patches.patch_scope(p)):
            store.set_state(p, "obsolete",
                            "upstream now contains the patch — consider removing")
            reports[pid] = {"check": "obsolete"}
            changed_any = True
            continue
        if p.get("state") == "applied" and _patches.scope_touches_dev(
                _patches.patch_scope(p)):
            # drifted dev/both patch: the dev-tree gate above says nothing
            # (the checkout carries uplift's OWN commits), so a merged PR
            # whose head merely MOVED would land a useless update_available
            # candidate instead of the honest obsolete verdict. Ask GitHub.
            newest1 = max((v.get("v", 0) for v in p["versions"]), default=0)
            cur_v1 = store.get_version(p, newest1) if newest1 else None
            diff_b1 = _read_patch_file(store, cur_v1) if cur_v1 else None
            if _pr_merged_into_base(src, diff_b1,
                                    reverse=bool(p.get("reversal"))) is True:
                store.set_state(
                    p, "obsolete",
                    "upstream now contains the patch — consider removing")
                reports[pid] = {"check": "obsolete"}
                changed_any = True
                continue
        # (BE-3 step 5: the old unreachable `if not result["ok"]` guard
        # lived here — result.ok was already required right after the
        # first gate in this loop, and nothing reassigned `result` since.)
        # BE-3 step 2 behavior fix: drift candidates now carry the SAME
        # schema as add_patch (safeguards/root_note were silently dropped).
        if _patches.patch_scope(p) == _patches.SCOPE_BOTH:
            # a drifted 'both' candidate stores the SRC-gate report; the
            # keg overlay has its own real hazard (custom_kernels/*.py
            # wrapper landing next to stale compiled artifacts). Re-run
            # the keg gate (cheap, already the pattern above) and adopt
            # ITS problems — same merge _add_gate does at add time. When
            # the keg re-gate cannot answer (fetch dead), keep the src
            # report untouched: a lost hold is worse than an over-strict
            # one (the pre-change behaviour).
            keg_res = fetch_and_gate(
                src, tree_root,
                overrides=_pristine_overlay(store, p, tree_root),
                reverse=bool(p.get("reversal")),
                skip_patterns=_patches.skip_patterns(manifest))
            keg_sg = keg_res.get("safeguards")
            if keg_sg is not None:
                result["safeguards"] = {
                    "problems": keg_sg.get("problems", []),
                    "codes": keg_sg.get("codes", []),
                    "advisories": (result.get("safeguards") or {}).get("advisories", []),
                    "truncated": keg_sg.get("truncated", False)}
        version = _store_version(store, p, result)
        v = version["v"]
        store.set_state(p, "update_available", f"v{v} available from source")
        reports[pid] = {"check": "update_available", "v": v}
        changed_any = True
    if changed_any:
        store.save(manifest)
    return {"ok": True, "reports": reports}


def get_diff(store, patch_id: str, v: int) -> bytes | None:
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return None
    ver = store.get_version(p, v)
    if ver is None:
        return None
    return _read_patch_file(store, ver)


def mark_dev_applied(store, commits: list[dict]) -> None:
    """DEV-6: the uplift-dev branch IS the apply target for dev/both
    scopes — after a successful materialize, record each committed patch's
    desired version as applied on the branch so dashboards show 'applied'
    instead of a pending state that reconcile (which ignores these) will
    never clear."""
    manifest = store.load()
    by_id = {c["id"]: c for c in commits if c.get("sha")}
    changed = False
    for p in manifest.get("patches", []):
        c = by_id.get(p.get("id"))
        if c is None or not _patches.scope_touches_dev(_patches.patch_scope(p)):
            continue
        desired = store.get_version(p, p.get("desired_version"))
        if desired is None:
            continue
        desired["dev_applied"] = {"at": _patches.now_iso(), "sha": c["sha"]}
        if p.get("enabled"):
            p["state"] = "applied"
            p["state_detail"] = "materialized on uplift-dev"
            p["state_changed_at"] = _patches.now_iso()
        changed = True
    if changed:
        store.save(manifest)


def mark_upstreamed_if_merged(store, commits: list[dict]) -> dict:
    """Skipped-as-already-present at materialize usually means the patch's
    PR was MERGED upstream: the base grew the code, the patch is no longer
    needed, yet its state would sit 'applied' forever. Ask GitHub (merged_at
    + content gate on a clean base — the _pr_merged_into_base rules) and
    stamp obsolete where proven. Best-effort: a dead network or an
    inconclusive verdict changes nothing (fail-safe rule — a check never
    degrades state). Returns {patch_id: detail} for the caller's table."""
    marked: dict[str, str] = {}
    skipped = [c for c in commits if c.get("skipped") == "already-present"]
    if not skipped:
        return marked
    by_id = {c["id"]: c for c in skipped}
    manifest = store.load()
    changed = False
    for p in manifest.get("patches", []):
        c = by_id.get(p.get("id"))
        if c is None:
            continue
        src = p.get("source") or {}
        if src.get("kind") != "github_pr":
            continue
        ver = store.get_version(p, c.get("v", p.get("desired_version")))
        diff_b = _read_patch_file(store, ver) if ver else None
        verdict = _pr_merged_into_base(
            src, diff_b, reverse=bool(p.get("reversal")))
        if verdict is not True:
            continue
        detail = "upstream merged the PR — patch no longer needed " \
                 "(disable/remove)"
        if store.set_state(p, "obsolete", detail):
            marked[p["id"]] = detail
            changed = True
    if changed:
        store.save(manifest)
    return marked


def enabled_build_patches(store) -> list[dict]:
    """The materialization input for devsrc (DEV-2): every ENABLED
    build-scope patch as {id, version, diff_bytes} in manifest order
    (order, id). Bytes are the stored UNPRUNED diffs — exactly what the
    gate accepted, sha-consistent."""
    manifest = store.load()
    out: list[dict] = []
    for p in sorted(manifest.get("patches", []),
                    key=lambda q: (q.get("order", 100), q.get("id", ""))):
        if not _patches.scope_touches_dev(_patches.patch_scope(p)):
            continue
        if not p.get("enabled"):
            continue
        ver = _desired_version_entry(store, p)
        if ver is None:
            continue
        data = _read_patch_file(store, ver)
        if data is None:
            continue
        out.append({"id": p.get("id"), "version": ver.get("v", 0),
                    "diff_bytes": data})
    return out


def set_config(store, auto_update_check: bool | None = None) -> dict:
    manifest = store.load()
    cfg = manifest.setdefault("config", {"auto_update_check": False})
    if auto_update_check is not None:
        cfg["auto_update_check"] = bool(auto_update_check)
    store.save(manifest)
    return {"config": cfg}
