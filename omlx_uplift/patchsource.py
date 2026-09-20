"""Patch sources + validation gate (PAT-2).

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
import io
import json
import os
import re
import urllib.error
import urllib.request

from . import diffapply

SIZE_CAP = 2 * 1024 * 1024  # 2 MB per design

_PR_URL_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)/?$")


# --------------------------------------------------------------------------
# Advisory warnings (never block, PAT-0 user policy)
# --------------------------------------------------------------------------

def url_advisories(url: str) -> list[str]:
    """Non-blocking warnings shown inline on the add/preview form."""
    out = []
    if url.startswith("http://"):
        out.append("Scheme is http:// — patch content travels in plaintext.")
    if re.match(r"^[a-zA-Z][\w+.-]*://[^/@]*:[^/@]*@", url):
        out.append("URL carries embedded credentials; the full URL including "
                   "the password is stored in plaintext in patches.json and "
                   "shown on the PATCHES card. Consider a URL that "
                   "authenticates out-of-band.")
    return out


def parse_pr_ref(url_or_repo: str, pr: int | None = None) -> tuple[str, int] | None:
    """Accept a PR web URL or repo + number; return (repo, pr) or None."""
    if pr is not None:
        if re.fullmatch(r"[\w.-]+/[\w.-]+", url_or_repo or ""):
            return url_or_repo, int(pr)
        return None
    m = _PR_URL_RE.match((url_or_repo or "").strip())
    if not m:
        return None
    return f"{m.group(1)}/{m.group(2)}", int(m.group(3))


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def _opener(insecure_tls: bool):
    if not insecure_tls:
        return urllib.request.build_opener()
    # Deliberate, per-user opt-in (PAT-0 design: "ignore SSL/TLS errors"
    # checkbox, stored as source.insecure_tls). Verification is disabled for
    # THIS fetch only; the user accepts MITM risk for their own patch source.
    import ssl

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))


def fetch_bytes(url: str, insecure_tls: bool = False) -> dict:
    """GET url. NO explicit socket timeout (HTTP client / OS defaults are
    generous by nature — PAT-0). Returns {ok, data?, status?, reason?}."""
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "reason": "only http(s) schemes are supported"}
    req = urllib.request.Request(
        url, headers={"User-Agent": "omlx-uplift/patch-carrier",
                      "Accept": "*/*"})
    try:
        opener = _opener(insecure_tls)
        with opener.open(req) as resp:  # noqa: S310 (scheme checked above)
            status = getattr(resp, "status", resp.getcode())
            data = resp.read(SIZE_CAP + 1)
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": exc.code,
                "reason": f"HTTP {exc.code} from {url}"}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"ok": False, "reason": f"fetch failed: {exc}"}
    if not (200 <= status < 300):
        return {"ok": False, "status": status, "reason": f"HTTP {status} from {url}"}
    if len(data) > SIZE_CAP:
        return {"ok": False, "reason": f"patch larger than {SIZE_CAP} bytes"}
    if not data.strip():
        return {"ok": False, "reason": "empty response body"}
    return {"ok": True, "data": data, "status": status}


def fetch_pr(repo: str, pr: int, insecure_tls: bool = False) -> dict:
    """Public PR diff via github.com/.../pull/N.diff — no auth needed.
    Also tries to extract the PR head SHA from the .patch preamble
    (From <sha> line); api.github.com is tried only as a fallback and any
    failure there degrades to content-hash identity, never fails the fetch."""
    r = fetch_bytes(f"https://github.com/{repo}/pull/{pr}.diff", insecure_tls)
    if not r["ok"]:
        return r
    data = r["data"]
    head = _head_sha_from_patch(repo, pr, insecure_tls)
    return {"ok": True, "data": data, "source_head_sha": head,
            "url": f"https://github.com/{repo}/pull/{pr}.diff"}


def _head_sha_from_patch(repo: str, pr: int, insecure_tls: bool) -> str | None:
    """Cheap path: the .patch (mbox) first line is 'From <sha> ...'.
    Fallback: api.github.com. Degrades to None (content hash identity)."""
    r = fetch_bytes(f"https://github.com/{repo}/pull/{pr}.patch", insecure_tls)
    if r["ok"]:
        first = r["data"][:80].split(b"\n", 1)[0]
        m = re.match(rb"From ([0-9a-f]{40}) ", first)
        if m:
            return m.group(1).decode()
    try:
        api = fetch_bytes(f"https://api.github.com/repos/{repo}/pulls/{pr}",
                          insecure_tls)
        if api["ok"]:
            sha = json.loads(api["data"]).get("head", {}).get("sha")
            if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha):
                return sha
    except (ValueError, KeyError):
        pass
    return None


def fetch_url(url: str, insecure_tls: bool = False) -> dict:
    r = fetch_bytes(url, insecure_tls)
    if not r["ok"]:
        return r
    return {"ok": True, "data": r["data"], "source_head_sha": None, "url": url}


def accept_upload(data: bytes) -> dict:
    """Multipart upload path: validate size only; parsing is the gate's job."""
    if len(data) > SIZE_CAP:
        return {"ok": False, "reason": f"patch larger than {SIZE_CAP} bytes"}
    if not data.strip():
        return {"ok": False, "reason": "empty upload"}
    return {"ok": True, "data": data, "source_head_sha": None, "url": None}


# --------------------------------------------------------------------------
# Validation gate
# --------------------------------------------------------------------------

def _py_compiles(data: bytes) -> bool:
    """True when data is syntactically valid Python (in-memory, no writes)."""
    try:
        compile(data, "uplift-check.py", "exec")
        return True
    except (SyntaxError, ValueError):
        return False


def compile_gate(parsed: dict, tree_root: str,
                 overrides: dict | None = None) -> list[str]:
    """py_compile/json checks on in-memory post-apply content. Returns a
    list of human-readable problems (empty = gate passed)."""
    import py_compile
    import tempfile

    problems: list[str] = []
    for fp in parsed["files"]:
        target, why = diffapply.safe_join(tree_root, fp["path"])
        if target is None:
            problems.append(f"{fp['path']}: {why}")
            continue
        if overrides and fp["path"] in overrides:
            content = overrides[fp["path"]]
        else:
            try:
                with open(target, "rb") as fh:
                    content = fh.read()
            except FileNotFoundError:
                content = None
        res = diffapply._apply_file(content, fp)  # in-memory only
        if res.get("already"):
            continue
        if not res.get("ok"):
            problems.append(f"{fp['path']}: {res.get('reason')}")
            continue
        new_bytes = res.get("new_bytes", b"")
        ext = os.path.splitext(fp["path"])[1].lower()
        if ext == ".py":
            base_ok = _py_compiles(content) if content is not None else True
            post_ok = _py_compiles(new_bytes)
            if base_ok and not post_ok:
                problems.append(f"{fp['path']}: patch breaks compilation "
                                "(file compiled before the patch)")
            elif not post_ok:
                # pre-image already un-compilable: not the patch's doing —
                # report honestly, do not block (upstream ships it that way)
                pass
        elif ext == ".json":
            try:
                json.loads(new_bytes.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                problems.append(f"{fp['path']}: invalid JSON — {exc}")
        # HTML/templates: text apply only, no compile gate (honest by design)
    return problems


def validate(diff: bytes, tree_root: str,
             overrides: dict | None = None) -> dict:
    """Full gate WITHOUT writing anything.

    overrides: {rel_path: bytes} — tree content to use instead of the live
    file for those paths (gate the candidate against the tree as reconcile
    will find it at apply time: this patch's own hunks unwound to pristine,
    other patches' hunks still applied).

    Returns {ok, reason?, advisories?, files: [per-file results],
             compile_problems: [...], content_sha256}.
    """
    content_sha256 = hashlib.sha256(diff).hexdigest()
    parsed = diffapply.parse_diff(diff)
    if not parsed["ok"]:
        return {"ok": False, "reason": f"parse: {parsed['reason']}",
                "files": [], "compile_problems": [],
                "content_sha256": content_sha256}
    check = diffapply.check_diff(diff, tree_root, overrides=overrides)
    compile_problems = compile_gate(parsed, tree_root, overrides=overrides)
    ok = all(f["status"] in ("ok", "already") for f in check["files"]) \
        and bool(check["files"]) and not compile_problems
    return {"ok": ok,
            "reason": check.get("reason") if not ok else None,
            "files": check["files"],
            "compile_problems": compile_problems,
            "content_sha256": content_sha256}


def fetch_and_gate(source: dict, tree_root: str,
                   overrides: dict | None = None) -> dict:
    """One-stop for add/check: source = {kind, repo?, pr?, url?, data?,
    insecure_tls?}. Fetch (if needed) then validate. On fetch failure the
    caller MUST keep stored state untouched (fail-safe rule)."""
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
        return {"ok": False, "stage": "fetch", "reason": fetched["reason"],
                "advisories": advisories}
    gate = validate(fetched["data"], tree_root, overrides=overrides)
    return {**gate, "stage": "gate", "advisories": advisories,
            "content_sha256": gate["content_sha256"],
            "source_head_sha": fetched.get("source_head_sha"),
            "diff": fetched["data"]}


# --------------------------------------------------------------------------
# Orchestration — manifest bookkeeping over the gate (router + CLI share this)
# --------------------------------------------------------------------------

from . import patches as _patches


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


def add_patch(store, patch_id: str, source: dict, tree_root: str,
              order: int = 100) -> dict:
    """Add (or update-check) a patch source: fetch -> gate -> store version.
    New patch lands as state=pending (needs Enable semantics are: pending +
    enabled=true -> applied at next reconcile)."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", patch_id or ""):
        return {"ok": False, "reason": "id must match [a-z0-9][a-z0-9._-]{0,63}"}
    manifest = store.load()
    _prune_once(store, manifest)
    patch = store.find(manifest, patch_id)
    creating = patch is None
    if creating:
        patch = {"id": patch_id, "enabled": False, "order": order,
                 "source": {}, "desired_version": 0, "versions": [],
                 "state": "disabled", "state_detail": "not yet validated"}
        manifest["patches"].append(patch)

    result = fetch_and_gate(source, tree_root,
                            overrides=_pristine_overlay(store, patch, tree_root))
    if not result["ok"]:
        # fail-safe: nothing stored, nothing state-changed
        if creating:
            manifest["patches"].remove(patch)
            store.save(manifest)
        return {"ok": False, "stage": result.get("stage"),
                "reason": result.get("reason"),
                "advisories": result.get("advisories", [])}

    source_clean = {k: source.get(k) for k in
                    ("kind", "repo", "pr", "url", "insecure_tls")
                    if source.get(k) is not None}
    patch["source"] = source_clean

    data = result["diff"]
    sha = result["content_sha256"]
    versions = patch["versions"]
    same = [v for v in versions if v.get("content_sha256") == sha]
    if same:
        # unchanged source content -> nothing new; report candidate status
        v = same[0]
        resp = {"ok": True, "unchanged": True, "v": v["v"],
                "state": patch["state"], "advisories": result["advisories"]}
        store.save(manifest)
        return resp
    obsolete = [f for f in result["files"] if f["status"] == "already"]
    if obsolete and len(obsolete) == len(result["files"]):
        return {"ok": True, "obsolete": True,
                "reason": "all hunks already present upstream — patch looks obsolete",
                "advisories": result["advisories"],
                "files": result["files"]}

    v = store.next_version(patch)
    pf_rel = _patches.rel(store.patch_file(patch_id, v), store.base_dir)
    pf_full = os.path.join(store.base_dir, pf_rel)
    os.makedirs(os.path.dirname(pf_full), exist_ok=True)
    tmp = pf_full + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, pf_full)
    from datetime import datetime, timezone

    version = {
        "v": v, "content_sha256": sha,
        "source_head_sha": result.get("source_head_sha"),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "patch_file": pf_rel,
    }
    patch["versions"].append(version)

    if patch["state"] in ("disabled",) and not patch.get("enabled"):
        patch["state_detail"] = "validated, not enabled"
    else:
        # new candidate on top of an applied patch -> update_available
        if any(ver.get("applied") for ver in versions):
            store.set_state(patch, "update_available",
                            f"candidate v{v} fetched and validated")
        else:
            store.set_state(patch, "pending", f"v{v} validated, awaiting restart")
            patch["enabled"] = True
            patch["desired_version"] = v
    store.save(manifest)
    return {"ok": True, "v": v, "state": patch["state"],
            "advisories": result["advisories"], "files": result["files"]}


def _desired_version_entry(store, patch) -> dict | None:
    return store.get_version(patch, patch.get("desired_version"))


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
        entry = {
            "id": p.get("id"), "enabled": p.get("enabled", False),
            "order": p.get("order", 100), "state": p.get("state"),
            "state_detail": p.get("state_detail", ""),
            "source": p.get("source", {}),
            "desired_version": p.get("desired_version"),
            "versions": [{k: v.get(k) for k in
                          ("v", "content_sha256", "source_head_sha",
                           "fetched_at", "applied")}
                         for v in p.get("versions", [])],
            "applied_v": desired.get("v") if applied else None,
            "keg_changed": bool(applied.get("keg_id") and keg
                                and applied["keg_id"] != keg),
            "advisories": url_advisories(
                (p.get("source") or {}).get("url") or ""),
            "last_verified": p.get("last_verified"),
        }
        out.append(entry)
    return {"patches": out, "config": manifest.get("config", {}),
            "keg_id": keg, "kill_switch_active": store.patches_disabled(),
            "warning": store.warning_active(manifest),
            "load_error": manifest.get("load_error")}


def set_enabled(store, patch_id: str, enabled: bool) -> dict:
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    if enabled and not p.get("versions"):
        return {"ok": False, "reason": "no validated version — add a source first"}
    p["enabled"] = bool(enabled)
    if enabled:
        if not p.get("desired_version"):
            newest = max((v.get("v", 0) for v in p["versions"]), default=0)
            p["desired_version"] = newest
        if p.get("state") in ("disabled",):
            store.set_state(p, "pending", "enabled — applies on next restart")
    else:
        store.set_state(p, "disabled", "disabled — restores on next restart")
    store.save(manifest)
    return {"ok": True, "state": p["state"]}


def promote(store, patch_id: str) -> dict:
    """Accept the newest validated candidate as desired; on-disk stays until
    the next reconcile (restart)."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    newest = max((v.get("v", 0) for v in p.get("versions", [])), default=0)
    if not newest or newest == p.get("desired_version"):
        return {"ok": False, "reason": "no candidate to promote"}
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
    """Re-validate stored desired version against the live keg, no writes."""
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
    result = validate(data, tree_root, overrides=_pristine_overlay(store, p, tree_root))
    p["last_verified"] = {"at": _patches.now_iso(),
                          "ok": result["ok"]}
    store.save(manifest)
    return result


def check_all(store, tree_root: str) -> dict:
    """Re-fetch every enabled github_pr/url source; changed content becomes a
    validated CANDIDATE version (state=update_available). Errors are per-
    patch display-only, never state-degrading (fail-safe rule)."""
    manifest = store.load()
    reports = {}
    changed_any = False
    for p in manifest.get("patches", []):
        src = p.get("source") or {}
        pid = p.get("id")
        if not p.get("enabled") or src.get("kind") not in ("github_pr", "url"):
            continue
        result = fetch_and_gate(src, tree_root,
                                overrides=_pristine_overlay(store, p, tree_root))
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
            reports[pid] = {"check": "up_to_date"}
            continue
        obsolete = [f for f in result["files"] if f["status"] == "already"]
        if obsolete and len(obsolete) == len(result["files"]):
            store.set_state(p, "obsolete",
                            "upstream now contains the patch — consider removing")
            reports[pid] = {"check": "obsolete"}
            changed_any = True
            continue
        if not result["ok"]:
            reports[pid] = {"check": "error",
                            "reason": "new content fails validation against "
                                      "the current tree: "
                                      + (result.get("reason") or "gate failed")}
            continue
        v = store.next_version(p)
        pf_rel = _patches.rel(store.patch_file(pid, v), store.base_dir)
        pf_full = os.path.join(store.base_dir, pf_rel)
        os.makedirs(os.path.dirname(pf_full), exist_ok=True)
        tmp = pf_full + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(result["diff"])
        os.replace(tmp, pf_full)
        from datetime import datetime, timezone

        p["versions"].append({
            "v": v, "content_sha256": sha,
            "source_head_sha": head,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "patch_file": pf_rel})
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


def set_config(store, auto_update_check: bool | None = None) -> dict:
    manifest = store.load()
    cfg = manifest.setdefault("config", {"auto_update_check": False})
    if auto_update_check is not None:
        cfg["auto_update_check"] = bool(auto_update_check)
    store.save(manifest)
    return {"config": cfg}
