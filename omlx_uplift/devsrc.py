"""dev-src repository manager (DEV-2).

Uplift owns a local omlx clone at ``~/.omlx/uplift/dev-src`` plus config at
``~/.omlx/uplift/dev.json``. The ``uplift-dev`` branch carries the enabled
build-scope patch set as commits (one commit per patch) on top of the
configured ``sync_ref``; the omlx-dev Homebrew formula (DEV-3) builds from
that branch tip and nothing else — uncommitted changes are invisible to
brew by design (DEV-context decision 2).

Pure git + stdlib (subprocess), testable against tiny local fixture repos —
no Homebrew, no network needed by tests. Never fetch a URL not in config.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile

from . import patches as _patches

_log = logging.getLogger("omlx_uplift.devsrc")

DEV_BRANCH_DEFAULT = "uplift-dev"
ATTRIBUTION_LINE = ("Made under human guidelines with free tokens from "
                    "local oMLX inference server")
_PATCH_SUBJECT_RE = re.compile(r"^patch\(([^)]+)\): v(\d+)")


# ---------------------------------------------------------------------------
# Config (~/.omlx/uplift/dev.json)
# ---------------------------------------------------------------------------

def dev_json_path(base_dir: str | None = None) -> str:
    base = base_dir or _patches.default_base_dir()
    return os.path.join(base, "dev.json")


def load_config(base_dir: str | None = None) -> dict | None:
    """dev.json contents, or None when absent/unreadable (never raises)."""
    path = dev_json_path(base_dir)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save_config(cfg: dict, base_dir: str | None = None) -> str:
    """Atomic write; returns the path. Keys stay as given — DEV-3/DEV-4
    extend the same file (port, base_path, share, built_sha)."""
    base = base_dir or _patches.default_base_dir()
    os.makedirs(base, exist_ok=True)
    path = os.path.join(base, "dev.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# git plumbing (subprocess, stdlib-only)
# ---------------------------------------------------------------------------

class DevsrcError(RuntimeError):
    """A git operation failed or a safety guard refused to act."""


def _git(args: list[str], cwd: str | None = None,
        check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git"] + args, cwd=cwd,
                          capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise DevsrcError(
            f"git {' '.join(args)} failed ({proc.returncode}): "
            f"{proc.stderr.strip() or proc.stdout.strip()}")
    return proc


def _rev_parse(rev: str, cwd: str) -> str | None:
    proc = _git(["rev-parse", "--verify", "--quiet", rev], cwd=cwd,
                check=False)
    return proc.stdout.strip() or None


# ---------------------------------------------------------------------------
# Origin detection (DEV-context decision 5)
# ---------------------------------------------------------------------------

UPSTREAM_CANONICAL = "https://github.com/jundot/omlx.git"


def _normalize_git_url(url: str) -> str:
    url = url.strip()
    if url.endswith("/"):
        url = url[:-1]
    if not url.endswith(".git"):
        url += ".git"
    return url


def _same_url(a: str, b: str) -> bool:
    def canon(u: str) -> str:
        u = (u or "").strip().rstrip("/")
        if u.endswith(".git"):
            u = u[:-4]
        for prefix in ("https://", "http://", "ssh://", "git://", "git@"):
            if u.startswith(prefix):
                u = u[len(prefix):]
                break
        if u.startswith("github.com:"):
            u = "github.com/" + u[len("github.com:"):]
        return u.lower()
    return bool(a) and bool(b) and canon(a) == canon(b)


def detect_origin(src_hint: str | None = None) -> dict:
    """Best-effort origin URL, in priority order (DEV-context 5):
    1. origin of an existing omlx checkout (--src hint, or ~/git/omlx)
    2. head URL of the installed omlx keg formula (brew info --json)
    3. canonical jundot/omlx
    Returns {origin, source} — the caller CONFIRMS before storing."""
    candidates: list[tuple[str, str]] = []
    probes = []
    if src_hint:
        probes.append(src_hint)
    probes.append(os.path.expanduser(os.path.join("~", "git", "omlx")))
    for probe in probes:
        if probe and os.path.isdir(os.path.join(probe, ".git")):
            proc = _git(["remote", "get-url", "origin"], cwd=probe,
                        check=False)
            if proc.returncode == 0 and proc.stdout.strip():
                candidates.append((proc.stdout.strip(), f"checkout {probe}"))
                break
    if not candidates:
        try:
            proc = subprocess.run(
                ["brew", "info", "--json=v2", "--formula", "omlx"],
                capture_output=True, text=True, timeout=60)
            if proc.returncode == 0:
                info = json.loads(proc.stdout)
                f = (info.get("formulae") or [{}])[0]
                head = f.get("head")
                if isinstance(head, dict):
                    head = head.get("url")
                if isinstance(head, str) and head.startswith(("http", "git")):
                    candidates.append((head, "installed omlx formula head"))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    if not candidates:
        candidates.append((UPSTREAM_CANONICAL, "fallback (canonical upstream)"))
    origin, source = candidates[0]
    return {"origin": _normalize_git_url(origin), "source": source}


# ---------------------------------------------------------------------------
# Clone management
# ---------------------------------------------------------------------------

def src_path(cfg: dict) -> str:
    return os.path.expanduser(cfg.get("src_path")
                              or os.path.join(_patches.default_base_dir(),
                                              "dev-src"))


def ensure_clone(cfg: dict) -> str:
    """Create/validate the dev-src clone; remotes pinned to config.
    Drift guard: actual origin != config origin -> refuse (DEV-context 5).
    Returns the clone path."""
    path = src_path(cfg)
    if not os.path.isdir(os.path.join(path, ".git")):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _log.info("devsrc: cloning %s -> %s", cfg["origin"], path)
        _git(["clone", "--filter=blob:none", cfg["origin"], path])
    # drift guard BEFORE touching remotes: never fetch a URL not in config
    actual = _git(["remote", "get-url", "origin"], cwd=path,
                  check=False).stdout.strip()
    if actual and not _same_url(actual, cfg["origin"]):
        raise DevsrcError(
            f"dev-src origin drifted: the clone says {actual!r} but "
            f"dev.json says {cfg['origin']!r} — fix one of them; uplift "
            "refuses to fetch either")
    if not actual:
        _git(["remote", "add", "origin", cfg["origin"]], cwd=path)
    elif not _same_url(actual, cfg["origin"]):
        _git(["remote", "set-url", "origin", cfg["origin"]], cwd=path)
    up = cfg.get("upstream")
    if up:
        cur_up = _git(["remote", "get-url", "upstream"], cwd=path,
                      check=False).stdout.strip()
        if not cur_up:
            _git(["remote", "add", "upstream", up], cwd=path)
        elif not _same_url(cur_up, up):
            _git(["remote", "set-url", "upstream", up], cwd=path)
    return path


def worktree_clean(path: str) -> bool:
    proc = _git(["status", "--porcelain"], cwd=path, check=False)
    return not proc.stdout.strip()


def _sync_parts(cfg: dict) -> tuple[str, str]:
    remote, _, ref = (cfg.get("sync_ref") or "").partition("/")
    if not remote or not ref:
        raise DevsrcError(f"sync_ref must be <remote>/<ref>: "
                          f"{cfg.get('sync_ref')!r}")
    return remote, ref


def fetch_sync_ref(cfg: dict) -> None:
    """Fetch ONLY the configured sync ref (never arbitrary URLs)."""
    path = src_path(cfg)
    remote, ref = _sync_parts(cfg)
    remotes = _git(["remote"], cwd=path, check=False).stdout.split()
    if remote not in remotes:
        raise DevsrcError(f"sync_ref remote {remote!r} is not configured in "
                          "dev-src — run omlx-uplift dev reconfigure")
    _git(["fetch", "--quiet", remote, f"+{ref}:refs/remotes/{remote}/{ref}"],
         cwd=path)


# ---------------------------------------------------------------------------
# Materialization — enabled build patches -> commits on uplift-dev
# ---------------------------------------------------------------------------

def _commit_message(pid: str, v: int) -> str:
    return (f"patch({pid}): v{v} — uplift build-scope patch\n\n"
            f"{ATTRIBUTION_LINE}\n")


def _apply_one(path: str, pid: str, v: int, diff_bytes: bytes) -> None:
    """Apply one stored diff into the worktree (strict). Raises on failure;
    a throwaway backup dir keeps diffapply happy — git owns the originals."""
    from . import diffapply

    tmp = tempfile.mkdtemp(prefix="uplift-devsrc-bak-")
    try:
        res = diffapply.apply_diff(diff_bytes, path, tmp, reverse=False)
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
    if not res.get("ok"):
        fails = [f for f in res.get("files", []) if f.get("status") == "fail"]
        detail = "; ".join(f"{f['path']}" for f in fails[:5]) or res.get("reason")
        raise DevsrcError(f"build patch {pid} v{v} does not apply onto the "
                          f"sync base: {detail}")


def materialize(patches_to_apply: list[dict], cfg: dict) -> dict:
    """Re-cut the formula branch from the fetched sync ref and apply each
    enabled build-scope patch (stored UNPRUNED diff bytes) as one commit,
    in list order. patches_to_apply: [{"id", "version", "diff_bytes"}].

    All-or-nothing: a patch that fails aborts the whole pass and the branch
    returns to its previous tip — brew never sees a half-applied branch.
    A patch whose hunks are already on the base commits nothing (the commit
    would be empty) and reports skipped. Push is NOT automatic.
    Returns {ok, tip, base, branch, commits:[{id,v,sha}], reason?}.
    """
    path = src_path(cfg)
    branch = cfg.get("formula_branch") or DEV_BRANCH_DEFAULT
    remote, ref = _sync_parts(cfg)
    base_ref = f"refs/remotes/{remote}/{ref}"
    base_sha = _rev_parse(base_ref, path)
    if not base_sha:
        return {"ok": False,
                "reason": f"sync ref {cfg['sync_ref']} is not fetched — run "
                          "devsrc.fetch_sync_ref first"}
    prev_tip = _rev_parse(branch, path)
    cur_branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path,
                      check=False).stdout.strip()

    _git(["checkout", "-q", "-B", branch, base_sha], cwd=path)
    commits: list[dict] = []
    try:
        for p in patches_to_apply:
            pid, v = p["id"], p.get("version", 0)
            _apply_one(path, pid, v, p["diff_bytes"])
            _git(["add", "-A"], cwd=path)
            if _git(["diff", "--cached", "--quiet"], cwd=path,
                    check=False).returncode == 0:
                _log.info("devsrc: patch %s already present on base — no commit",
                          pid)
                commits.append({"id": pid, "v": v, "sha": None,
                                "skipped": "already-present"})
                continue
            env = dict(os.environ, GIT_AUTHOR_DATE="946684800 +0000",
                       GIT_COMMITTER_DATE="946684800 +0000")
            proc = subprocess.run(
                ["git", "-c", "user.name=omlx-uplift", "-c",
                 "user.email=uplift@localhost", "commit", "-q",
                 "-m", _commit_message(pid, v)],
                cwd=path, capture_output=True, text=True, env=env)
            if proc.returncode != 0:
                raise DevsrcError(f"git commit failed: "
                                  f"{proc.stderr.strip() or proc.stdout}")
            commits.append({"id": pid, "v": v,
                            "sha": _git(["rev-parse", "HEAD"],
                                        cwd=path).stdout.strip()})
        tip = _git(["rev-parse", "HEAD"], cwd=path).stdout.strip()
    except DevsrcError as exc:
        # abort: restore the branch to its previous tip (or drop a fresh one)
        if prev_tip:
            _git(["checkout", "-q", "-B", branch, prev_tip], cwd=path,
                 check=False)
        else:
            _git(["checkout", "-q", "-B", branch, base_sha], cwd=path,
                 check=False)
        _git(["clean", "-qffd"], cwd=path, check=False)
        _git(["reset", "--hard", "-q"], cwd=path, check=False)
        if cur_branch and cur_branch != branch:
            _git(["checkout", "-q", cur_branch], cwd=path, check=False)
        return {"ok": False, "reason": str(exc), "base": base_sha,
                "branch": branch}
    return {"ok": True, "tip": tip, "base": base_sha, "branch": branch,
            "commits": commits}


def expected_tip(patches_to_apply: list[dict], cfg: dict) -> dict:
    """Dry-run materialize into a throwaway worktree sharing the clone's
    object store. Commits use a fixed --date + identical tree/parent/message,
    so shas match a real materialize: {ok, tip} or {ok: False, reason}."""
    path = src_path(cfg)
    tmp = tempfile.mkdtemp(prefix="uplift-devsrc-exp-")
    try:
        _git(["worktree", "add", "--detach", "-q", tmp], cwd=path)
        # distinct branch name + worktree path: the real branch may be
        # checked out in the main clone, git forbids a double checkout
        cfg2 = dict(cfg, src_path=tmp,
                    formula_branch=DEV_BRANCH_DEFAULT + "-exp")
        r = materialize(patches_to_apply, cfg2)
        return r
    finally:
        _git(["worktree", "remove", "--force", tmp], cwd=path, check=False)


# ---------------------------------------------------------------------------
# Status + drift
# ---------------------------------------------------------------------------

def status(cfg: dict, patches_to_apply: list[dict] | None = None) -> dict:
    """Branch, tip, ahead/behind vs sync_ref, patch-commit list, and (when
    a patch set is given) materialization drift: someone committed to
    uplift-dev by hand, or the branch no longer matches the enabled set."""
    path = src_path(cfg)
    branch = cfg.get("formula_branch") or DEV_BRANCH_DEFAULT
    if not os.path.isdir(os.path.join(path, ".git")):
        return {"installed": False,
                "reason": "dev-src clone missing — run omlx-uplift dev install"}
    try:
        remote, ref = _sync_parts(cfg)
    except DevsrcError as exc:
        return {"installed": True, "branch": branch, "reason": str(exc)}
    base_ref = f"refs/remotes/{remote}/{ref}"
    base_sha = _rev_parse(base_ref, path)
    tip = _rev_parse(branch, path)
    out = {"installed": True, "branch": branch, "tip": tip,
           "base": base_sha, "sync_ref": cfg["sync_ref"]}
    if tip and base_sha:
        out["ahead"] = int(_git(["rev-list", "--count", f"{base_sha}..{tip}"],
                                cwd=path).stdout.strip() or 0)
        out["behind"] = int(_git(["rev-list", "--count", f"{tip}..{base_sha}"],
                                 cwd=path).stdout.strip() or 0)
        out["patch_commits"] = _patch_commits(path, base_sha, tip)
    if patches_to_apply is not None and tip and base_sha:
        out["drift"] = drift_check(path, base_sha, tip, patches_to_apply)
    return out


def _patch_commits(path: str, base_sha: str, tip: str) -> list[dict]:
    """The patch(id, v) set carried by base..tip (newest first)."""
    proc = _git(["log", "--reverse", "--format=%H%x00%s",
                 f"{base_sha}..{tip}"], cwd=path)
    out = []
    for line in proc.stdout.splitlines():
        sha, _, subject = line.partition("\x00")
        m = _PATCH_SUBJECT_RE.match(subject or "")
        if m:
            out.append({"sha": sha, "id": m.group(1), "v": int(m.group(2))})
    return out


def drift_check(path: str, base_sha: str, tip: str,
                patches_to_apply: list[dict]) -> dict:
    """Compare the branch content (base..tip) against the expected patch
    set. Content-level, so commit-date noise never false-alarms: a file or
    added-line the patches do not account for -> drift."""
    from . import diffapply

    diff = _git(["diff", f"{base_sha}..{tip}"], cwd=path).stdout.encode()
    expected: dict[str, set[str]] = {}
    for p in patches_to_apply:
        ep = diffapply.parse_diff(p["diff_bytes"])
        if not ep["ok"]:
            return {"drift": True, "detail": f"stored diff of {p['id']} is "
                                             "unparseable"}
        for fp in ep["files"]:
            expected.setdefault(fp["path"], set()).update(_added_lines(fp))
    actual = diffapply.parse_diff(diff) if diff.strip() else {"ok": True, "files": []}
    if not actual.get("ok"):
        return {"drift": True, "detail": f"branch diff unparseable: {actual.get('reason')}"}
    actual_map = {fp["path"]: set(_added_lines(fp)) for fp in actual["files"]}
    missing = sorted(set(expected) - set(actual_map))
    changed = sorted(p for p in set(expected) & set(actual_map)
                     if expected[p] - actual_map[p])
    extra = sorted(p for p in set(actual_map) - set(expected))
    # an unpatch commit that only DELETES adds no lines -> catch via paths too
    drift = bool(missing or changed or extra)
    detail = []
    if missing:
        detail.append("expected content missing from branch: "
                      + ", ".join(missing[:5]))
    if changed:
        detail.append("branch content differs from stored patches: "
                      + ", ".join(changed[:5]))
    if extra:
        detail.append("touched outside the patch set (hand commit?): "
                      + ", ".join(extra[:5]))
    return {"drift": drift, "detail": "; ".join(detail) or "clean"}


def _added_lines(filepatch: dict) -> set[str]:
    lines: set[str] = set()
    for hunk in filepatch.get("hunks", []):
        for op, text, _eol in hunk.get("lines", []):
            if op == "+":
                lines.add(text.strip())
    return lines


# ---------------------------------------------------------------------------
# install questionnaire (DEV-2 CLI) — repo part only; DEV-4 owns runtime
# ---------------------------------------------------------------------------

def install_config(src_hint: str | None = None, yes: bool = False,
                   origin: str | None = None, sync_ref: str | None = None,
                   base_dir: str | None = None) -> dict:
    """Interactive repo questionnaire + dev.json write (clone itself is
    ensure_clone's job). Plain stdin Q&A; --yes takes the defaults."""
    detected = detect_origin(src_hint=src_hint)
    chosen_origin = origin or detected["origin"]
    chosen_sync = sync_ref or "origin/main"
    if not yes and origin is None:
        print(f"Detected omlx origin: {detected['origin']} "
              f"(from: {detected['source']})")
        answer = input("Use this as dev-src origin? [Y/n] ").strip().lower()
        if answer and not answer.startswith("y"):
            chosen_origin = input("Origin URL: ").strip() or chosen_origin
        if sync_ref is None:
            chosen_sync = (input("Sync ref to track [origin/main]: ").strip()
                           or "origin/main")
    base = base_dir or _patches.default_base_dir()
    cfg = {
        "origin": _normalize_git_url(chosen_origin),
        "upstream": (UPSTREAM_CANONICAL if not _same_url(chosen_origin,
                                                         UPSTREAM_CANONICAL)
                     else _normalize_git_url(chosen_origin)),
        "sync_ref": chosen_sync,
        "formula_branch": DEV_BRANCH_DEFAULT,
        "src_path": os.path.join(base, "dev-src"),
    }
    save_config(cfg, base_dir=base)
    return cfg
