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
import sys
import tempfile
from dataclasses import dataclass, field

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
    """dev.json contents, or None when absent/unreadable (never raises).

    With an explicit base_dir, reads exactly that dir. Without one, the
    env/canonical base is tried first, then the standard coexistence
    layout (~/.omlx-dev/uplift): bootstrap may have run in a shell whose
    OMLX_BASE_PATH differed from this process's — dev.json must still be
    found (mruu split, 2026-09-24)."""
    if base_dir is not None:
        try:
            with open(dev_json_path(base_dir), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None
    bases = [None]  # default: _patches.default_base_dir() (env-aware)
    env_base = os.environ.get("OMLX_BASE_PATH")
    if env_base:
        # a bare shell run wrote it under the canonical dir
        bases.append(os.path.expanduser(os.path.join("~", ".omlx", "uplift")))
    else:
        # a bootstrap inside the dev env wrote it under the dev base
        bases.append(os.path.join(
            os.path.expanduser(RUNTIME_DEFAULTS["base_path"]), "uplift"))
    for b in bases:
        try:
            with open(dev_json_path(b), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            continue
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


# GIT-1: git in a server-started process must NEVER wait on a human.
# A credential-protected origin whose agent can't answer makes git prompt
# (terminal or askpass), and in a daemon with no usable tty that hangs the
# calling thread indefinitely. GIT_TERMINAL_PROMPT=0 turns the prompt into
# an instant failure; GIT_ASKPASS=echo kills helper popups the same way.
# The timeout is generous — clone/fetch of the real omlx history is
# minutes on first bootstrap — but finite.
GIT_TIMEOUT_S = 900.0


def _git(args: list[str], cwd: str | None = None,
        check: bool = True,
        timeout: float | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="echo")
    tmo = timeout if timeout is not None else GIT_TIMEOUT_S
    try:
        proc = subprocess.run(["git"] + args, cwd=cwd,
                              capture_output=True, text=True,
                              timeout=tmo, env=env)
    except subprocess.TimeoutExpired as exc:
        detail = f"git {' '.join(args)} timed out after {tmo:.0f}s"
        if check:
            raise DevsrcError(detail) from exc
        return subprocess.CompletedProcess(["git"] + args, returncode=124,
                                           stdout="", stderr=detail)
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


def _tap_abs_path(rel: str, tap: str) -> str | None:
    """ruby_source_path is relative to the tap clone — resolve it.
    'jundot/omlx' -> <brew --repository>/Library/Taps/jundot/homebrew-omlx"""
    if not rel or not tap or os.path.isabs(rel):
        return rel or None
    user, _, name = tap.partition("/")
    if not name:
        return None
    try:
        repo = subprocess.run(["brew", "--repository"], capture_output=True,
                              text=True, timeout=15).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not repo:
        return None
    return os.path.join(repo, "Library", "Taps", user, f"homebrew-{name}", rel)


def _formula_head_url(formula: str = "omlx") -> tuple[str, str] | None:
    """head URL of an installed formula AS WRITTEN IN ITS TAP. This brew
    version's `info --json` omits the 'head' field entirely, so ask the
    JSON only WHERE the ruby source lives (ruby_source_path) and read the
    head line from the file — no shell, no eval of ruby."""
    try:
        proc = subprocess.run(
            ["brew", "info", "--json=v2", "--formula", formula],
            capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            return None
        f = (json.loads(proc.stdout).get("formulae") or [{}])[0]
        src = f.get("ruby_source_path") or ""
        tap = f.get("tap") or "installed formula"
        src = _tap_abs_path(src, f.get("tap") or "")
        if not src or not os.path.isfile(src):
            return None
        with open(src, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r'\s*head\s+"([^"]+)"', line)
                if m:
                    return (m.group(1), f"installed formula {formula} "
                                        f"(tap {tap})")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def detect_origin(src_hint: str | None = None) -> dict:
    """Best-effort origin URL, in priority order (user rule 2026-09-24):
    1. --src checkout, ONLY when explicitly given
    2. head URL of the installed omlx formula, read from its tap source
    3. canonical jundot/omlx
    A checkout in $HOME is deliberately NEVER probed implicitly: the tap
    is where omlx was installed FROM, random clones in the user's home are
    not the upstream default.
    Returns {origin, source} — the caller CONFIRMS before storing."""
    if src_hint and os.path.isdir(os.path.join(src_hint, ".git")):
        proc = _git(["remote", "get-url", "origin"], cwd=src_hint,
                    check=False)
        if proc.returncode == 0 and proc.stdout.strip():
            return {"origin": _normalize_git_url(proc.stdout.strip()),
                    "source": f"checkout {src_hint}"}
    found = _formula_head_url("omlx")
    if found:
        return {"origin": _normalize_git_url(found[0]), "source": found[1]}
    return {"origin": _normalize_git_url(UPSTREAM_CANONICAL),
            "source": "fallback (canonical upstream)"}


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
        # FULL clone, deliberately NOT --filter=blob:none: brew clones
        # this repo over file:// and a local promisor cannot lazy-serve
        # missing blobs (git: 'lazy fetching disabled' -> clone exit 128).
        _git(["clone", cfg["origin"], path])
    # self-heal an earlier blobless clone in place (uplift <DEV-3 created
    # those): drop the filter, refetch complete objects, then brew can clone
    promisor = _git(["config", "--local", "remote.origin.promisor"],
                    cwd=path, check=False).stdout.strip()
    if promisor == "true":
        _log.info("devsrc: converting blobless clone to full clone")
        _git(["config", "--local", "--unset-all", "remote.origin.promisor"],
             cwd=path)
        _git(["config", "--local", "--unset-all",
              "remote.origin.partialclonefilter"], cwd=path)
        _git(["fetch", "--refetch", "origin"], cwd=path)
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
# Base pin (DEV-7): what omlx-dev re-cuts uplift-dev FROM
# ---------------------------------------------------------------------------

def base_sha_of(cfg: dict) -> str | None:
    """The commit the materializer must use as base. Default (no pin):
    tip of the sync ref — 'follow vanilla omlx keg' in dashboard wording
    (the keg is built from that same upstream line; when the pin is unset
    a sync-ref fetch refreshes it). With cfg['base_pin'] set, that exact
    commit is the base until the pin is cleared."""
    pin = (cfg.get("base_pin") or "").strip()
    path = src_path(cfg)
    if pin:
        # ^{commit}: rev-parse of a well-formed but absent 40-char hex
        # returns the string itself — peel to a real commit object or fail
        sha = _rev_parse(pin + "^{commit}", path)
        if not sha:
            raise DevsrcError(
                f"base pin {pin!r} is not a commit in dev-src — fetch it "
                "(the dashboard commit list is bounded; older commits may "
                "need: git -C <dev-src> fetch)")
        return sha
    remote, ref = _sync_parts(cfg)
    return _rev_parse(f"refs/remotes/{remote}/{ref}", path)


def recent_commits(cfg: dict, limit: int = 50) -> list[dict]:
    """Bounded `git log` for the base-root chooser (DEV-7): short hash +
    subject, newest first, from the sync ref (the line the user follows).
    Falls back to HEAD when the sync ref was never fetched so the chooser
    is never empty."""
    path = src_path(cfg)
    try:
        remote, ref = _sync_parts(cfg)
        refname = f"refs/remotes/{remote}/{ref}"
    except DevsrcError:
        refname = "HEAD"
    if not _rev_parse(refname, path):
        refname = "HEAD"
    proc = _git(["log", f"--max-count={max(1, min(int(limit), 200))}",
                 "--format=%H%x00%h%x00%s", refname], cwd=path, check=False)
    out = []
    for line in proc.stdout.splitlines():
        sha, _, rest = line.partition("\x00")
        short, _, subject = rest.partition("\x00")
        if sha:
            out.append({"sha": sha, "short": short, "subject": subject})
    return out


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


def base_distance(repo: str, a: str | None, b: str | None) -> int | None:
    """VER-1: commit distance between two shas in one repo (ahead+behind,
    symmetric). None when either side is unknown (missing stamp, gc'd
    commit, shallow clone) — callers rank unknown as 'furthest', never
    as an error."""
    if not a or not b:
        return None
    if a == b:
        return 0
    r1 = _git(["rev-list", "--count", f"{a}..{b}"], cwd=repo, check=False)
    r2 = _git(["rev-list", "--count", f"{b}..{a}"], cwd=repo, check=False)
    if r1.returncode or r2.returncode:
        return None
    try:
        return int(r1.stdout.strip()) + int(r2.stdout.strip())
    except ValueError:
        return None


def _alternate_versions(store, pid: str, wanted_v: int, base_sha: str,
                        repo: str) -> list[dict]:
    """VER-1 (user 2026-10-10): the versions to TRY when the desired one
    does not apply onto the current base — every OTHER stored version of
    this patch, ranked by commit distance from the base each was tested
    against (versions carry a tested_base stamp since VER-1; pre-VER-1
    versions rank last, by version number). Capped at MAX_ALTERNATES: the
    user asked for 'the two closest versions', not a full search.
    Returns [{v, diff_bytes, distance}] best-first; [] when nothing else
    is stored."""
    MAX_ALTERNATES = 2
    manifest = store.load()
    entry = store.find(manifest, pid)
    if not entry:
        return []
    from . import diffapply  # noqa: F401 — parity import guard (bytes shape)
    out = []
    for ver in entry.get("versions", []):
        v = ver.get("v")
        if v == wanted_v:
            continue
        data = _read_stored_diff(store, ver)
        if data is None:
            continue
        dist = base_distance(repo, base_sha, ver.get("tested_base"))
        out.append({"v": v, "diff_bytes": data, "distance": dist})
    # known distances first (nearest base), then untagged versions by
    # number (the newest older one is the likeliest fit); newest-first
    # inside each band
    def rank(c):
        d = c["distance"]
        return (0 if d is not None else 1,
                d if d is not None else 0,
                -c["v"])
    out.sort(key=rank)
    return out[:MAX_ALTERNATES]


def _read_stored_diff(store, version: dict) -> bytes | None:
    pf = version.get("patch_file") or ""
    path = pf if os.path.isabs(pf) else os.path.join(store.base_dir, pf)
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


class _PatchSkip(Exception):
    """Internal control flow: the resolver said 'build without this
    patch'. Carries the honest record materialize() returns."""

    def __init__(self, record: dict):
        super().__init__(record.get("reason") or "")
        self.record = record


def _apply_with_ladder(path, store, pid, wanted_v, wanted_bytes, base_sha,
                       on_patch_failure):
    """VER-1 ladder for ONE patch onto the current base. Returns
    (v, diff_bytes, fallback_from, tried) — the applied version and, when
    an alternate carried the build, the version the user actually wanted
    (reported, never hidden). Raises _PatchSkip when the resolver chose
    to build without the patch, DevsrcError to abort the whole pass.

    Order: desired version first; then stored alternates ranked nearest-
    tested-base first (cap in _alternate_versions); then the resolver —
    no resolver (dashboard/dry-run/scripted) means abort, never a silent
    skip. A failed apply never writes (diffapply checks everything
    first), so each trial starts from the same clean tree."""
    tried = [wanted_v]
    try:
        _apply_one(path, pid, wanted_v, wanted_bytes)
        return wanted_v, wanted_bytes, None, tried
    except DevsrcError as exc:
        first_exc = exc
    for a in _alternate_versions(store, pid, wanted_v, base_sha, path):
        if a["v"] in tried:
            continue
        tried.append(a["v"])
        try:
            _apply_one(path, pid, a["v"], a["diff_bytes"])
        except DevsrcError:
            _log.warning("devsrc: %s v%s also fails onto base %s",
                         pid, a["v"], base_sha[:12])
            continue
        _log.warning(
            "devsrc: %s v%s does not apply onto base %s — building v%s "
            "instead (tested %s%s)", pid, wanted_v, base_sha[:12], a["v"],
            (a.get("tested_base") or "?")[:12],
            "" if a.get("distance") is None
            else f", {a['distance']} commits away")
        return a["v"], a["diff_bytes"], wanted_v, tried
    # ladder exhausted: ask the human (CLI only), else abort the pass
    decision = None
    if on_patch_failure:
        decision = on_patch_failure(pid, str(first_exc), tried)
    if decision == "skip":
        _log.warning("devsrc: %s SKIPPED this build — no stored version "
                     "applies onto base %s (tried %s)", pid, base_sha[:12],
                     ", ".join(f"v{t}" for t in tried))
        raise _PatchSkip({"id": pid, "reason": str(first_exc),
                          "tried": tried})
    raise first_exc


def materialize(patches_to_apply: list[dict], cfg: dict,
                on_patch_failure=None) -> dict:
    """Re-cut the formula branch from the fetched sync ref and apply each
    enabled build-scope patch (stored UNPRUNED diff bytes) as one commit,
    in list order. patches_to_apply: [{"id", "version", "diff_bytes"}].

    All-or-nothing per PASS (not per patch): a patch that fails aborts the
    whole pass and the branch returns to its previous tip — brew never
    sees a half-applied branch. A patch whose hunks are already on the
    base commits nothing (the commit would be empty) and reports skipped.
    Push is NOT automatic.

    VER-1 (user 2026-10-10) graceful ladder when the DESIRED version does
    not apply onto the user's base:
      1. try up to MAX_ALTERNATES other stored versions, nearest-tested-
         base first — used only if one applies cleanly (a downgrade is
         reported honestly via commit['fallback_from']);
      2. still failing: ask on_patch_failure(pid, reason, tried_versions)
         — a CLI resolver returns 'skip' (build WITHOUT this patch; the
         honest record lands in result['skipped_patches']) or anything
         else aborts the pass. No resolver (dashboard, dry-run, scripted
         use) = abort: the pre-VER-1 behavior, never a silent skip.
    Returns {ok, tip, base, branch, commits:[{id,v,sha,fallback_from?}],
             skipped_patches?:[{id,reason,tried}], reason?, failed_patch?}.
    """
    from . import patches as _patches_mod

    path = src_path(cfg)
    branch = cfg.get("formula_branch") or DEV_BRANCH_DEFAULT
    try:
        # DEV-7: base is the pin when set, else the sync-ref tip
        base_sha = base_sha_of(cfg)
    except DevsrcError as exc:
        return {"ok": False, "reason": str(exc)}
    if not base_sha:
        return {"ok": False,
                "reason": f"sync ref {cfg['sync_ref']} is not fetched — run "
                          "devsrc.fetch_sync_ref first"}
    prev_tip = _rev_parse(branch, path)
    cur_branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path,
                      check=False).stdout.strip()

    _git(["checkout", "-q", "-B", branch, base_sha], cwd=path)
    commits: list[dict] = []
    skipped: list[dict] = []
    failed_pid = None   # patch whose apply/commit aborted the pass
    store = _patches_mod.PatchStore()
    try:
        for p in patches_to_apply:
            pid, v = p["id"], p.get("version", 0)
            failed_pid = pid
            try:
                v, diff_bytes, fallback_from, tried = _apply_with_ladder(
                    path, store, pid, v, p["diff_bytes"], base_sha,
                    on_patch_failure)
            except _PatchSkip as sk:
                skipped.append(sk.record)
                continue           # resolver said 'skip this build'
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
            c = {"id": pid, "v": v,
                 "sha": _git(["rev-parse", "HEAD"], cwd=path).stdout.strip()}
            if fallback_from is not None:
                c["fallback_from"] = fallback_from
                c["tried"] = tried
            commits.append(c)
        tip = _git(["rev-parse", "HEAD"], cwd=path).stdout.strip()
    except DevsrcError as exc:
        # abort: restore the branch to its previous tip (or drop a fresh one)
        # LOG-2: the abort reason went only into the returned dict (console);
        # the dev-install.log the CLI points at for 'investigation' stayed
        # empty for the one failure class that matters most.
        _log.warning("devsrc: materialize aborted: %s", exc)
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
                "branch": branch, "failed_patch": failed_pid,
                "skipped_patches": skipped}
    return {"ok": True, "tip": tip, "base": base_sha, "branch": branch,
            "commits": commits,
            "skipped_patches": skipped}


def ensure_formula_branch(cfg: dict) -> str | None:
    """Create the formula branch at the fetched sync-ref tip if it does not
    exist yet. bootstrap runs this so a bare `brew install omlx-dev` (which
    clones the branch by name straight from dev-src) works even before the
    first materialize. Returns the branch sha, or None when it already
    exists (never re-cut — that is materialize's job)."""
    path = src_path(cfg)
    branch = cfg.get("formula_branch") or DEV_BRANCH_DEFAULT
    if _rev_parse(branch, path):
        return None
    # DEV-7: honor a base pin at bootstrap seed time too (materialize owns
    # every later re-cut)
    base_sha = base_sha_of(cfg)
    if not base_sha:
        raise DevsrcError(f"sync ref {cfg.get('sync_ref')!r} is not fetched")
    _git(["branch", branch, base_sha], cwd=path)
    return base_sha


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
                "reason": "dev-src clone missing — run omlx-uplift dev bootstrap"}
    try:
        base_sha = base_sha_of(cfg)   # DEV-7: pin-aware
    except DevsrcError as exc:
        return {"installed": True, "branch": branch, "reason": str(exc)}
    tip = _rev_parse(branch, path)
    out = {"installed": True, "branch": branch, "tip": tip,
           "base": base_sha, "sync_ref": cfg["sync_ref"],
           "base_pin": (cfg.get("base_pin") or "").strip() or None}
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


def _merge_base(a: str, b: str, cwd: str) -> str | None:
    proc = _git(["merge-base", a, b], cwd=cwd, check=False)
    sha = proc.stdout.strip()
    if proc.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha or ""):
        return sha
    return None


def _patch_in_base(path: str, cut: str, files: list[dict]) -> bool:
    """True when EVERY added line of the parsed patch already exists in
    the tree at `cut` — the content-level mirror of materialize's 'no
    diff after apply -> skip' (a since-merged patch). Deliberately
    conservative: any missing line or unreadable file -> False (expect it,
    keep drift honest)."""
    cache: dict[str, set[str] | None] = {}
    any_file = False
    for fp in files:
        rel = fp["path"]
        if rel not in cache:
            proc = _git(["show", f"{cut}:{rel}"], cwd=path, check=False)
            cache[rel] = (set(proc.stdout.splitlines())
                          if proc.returncode == 0 else None)
        base_lines = cache[rel]
        if base_lines is None:
            return False
        any_file = True
        added = _added_lines(fp)
        if not added or not added <= base_lines:
            return False
    return any_file


def drift_check(path: str, base_sha: str, tip: str,
                patches_to_apply: list[dict]) -> dict:
    """Compare the branch content (base..tip) against the expected patch
    set. Content-level, so commit-date noise never false-alarms: a file or
    added-line the patches do not account for -> drift.

    The diff base is merge-base(base, tip), NOT base itself: once the sync
    ref moves past the commit the branch was cut from (auto-update pulled,
    or just time passing before a rebuild), diffing the NEW tip against the
    OLD branch tip shows every upstream commit in between as 'touched
    outside the patch set' — a false DRIFT on a perfectly clean branch.
    merge-base IS the commit the branch actually grew from, so the diff
    contains exactly the patch commits + any hand commits.

    A patch whose ADDED lines already exist in the cut base is also excluded
    from the expectation: materialize commits nothing for it (an upstream-
    merged patch lands as skipped/already-present), so expecting its lines
    on the branch would false-alarm 'expected content missing'."""
    from . import diffapply

    cut = _merge_base(base_sha, tip, path) or base_sha
    diff = _git(["diff", f"{cut}..{tip}"], cwd=path).stdout.encode()
    expected: dict[str, set[str]] = {}
    for p in patches_to_apply:
        ep = diffapply.parse_diff(p["diff_bytes"])
        if not ep["ok"]:
            return {"drift": True, "detail": f"stored diff of {p['id']} is "
                                             "unparseable"}
        if _patch_in_base(path, cut, ep["files"]):
            continue
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


# ---------------------------------------------------------------------------
# Coexistence config + sharing (DEV-4, DEV-context decision 6)
# ---------------------------------------------------------------------------

RUNTIME_DEFAULTS = {"port": 8001, "base_path": "~/.omlx-dev"}
SHARE_DEFAULTS = {"models": True, "settings": False,
                  "model_settings": False, "model_profiles": False}
# knob name -> path under the base dirs (knob names omit the .json suffix)
SHARE_FILENAMES = {"models": "models",
                   "settings": "settings.json",
                   "model_settings": "model_settings.json",
                   "model_profiles": "model_profiles.json"}
# never symlinked even if asked — the server would fight over live state.
# settings.json is NOT here: private = copied once from vanilla (the
# "dev replaces vanilla" setup); shared = symlink, safe for config values
# because each service block injects its own OMLX_PORT/OMLX_BASE_PATH,
# which override the file (verified omlx/config.py:204). Two running
# servers can still clobber each other's admin saves — symlink is opt-in.
NEVER_SHARE = ("usage.sqlite3", "cluster", "logs", "uplift")


def runtime_config(cfg: dict) -> dict:
    """port/base_path with defaults applied (dev.json may predate DEV-4)."""
    out = dict(RUNTIME_DEFAULTS)
    out.update({k: cfg[k] for k in RUNTIME_DEFAULTS if cfg.get(k)})
    return out


def share_map(cfg: dict) -> dict:
    out = dict(SHARE_DEFAULTS)
    out.update(cfg.get("share") or {})
    return out


def vanilla_base() -> str:
    return os.path.expanduser("~/.omlx")


def realize_share(cfg: dict, vanilla: str | None = None) -> list[dict]:
    """Make <base_path>/<name> match the share map. Shared: a symlink into
    the vanilla base. Unshared: a real file/dir seeded ONCE from vanilla
    (copy, never move; an existing real path is left alone — data safety).
    Returns per-name actions for CLI/JSON output."""
    import shutil

    vanilla = vanilla or vanilla_base()
    base = os.path.expanduser(runtime_config(cfg)["base_path"])
    os.makedirs(base, exist_ok=True)
    actions: list[dict] = []
    for name, shared in sorted(share_map(cfg).items()):
        if name in NEVER_SHARE:
            actions.append({"name": name, "action": "refused",
                            "reason": f"{name} is never shareable while "
                                      "both servers run (live write race)"})
            continue
        fname = SHARE_FILENAMES.get(name, name)
        target = os.path.join(base, fname)
        src = os.path.join(vanilla, fname)
        cur = None
        if os.path.islink(target):
            cur = "link"
        elif os.path.exists(target):
            cur = "real"
        if shared:
            if cur == "link" and os.path.realpath(target) == os.path.realpath(src):
                actions.append({"name": name, "action": "unchanged"})
                continue
            if cur == "real":
                # an EMPTY server-created dir is not data — safe to flip
                if (os.path.isdir(target)
                        and not os.listdir(target)
                        and os.path.isdir(src)):
                    os.rmdir(target)
                    cur = None
                else:
                    # flipping a private copy back to shared would hide
                    # dev-side data behind a symlink — keep the copy, say
                    # so (never destroy data)
                    actions.append({"name": name, "action": "kept-private",
                                    "reason": "dev copy exists; refusing to "
                                              "replace real data with a "
                                              "symlink"})
                    continue
            if not os.path.exists(src):
                actions.append({"name": name, "action": "skipped",
                                "reason": f"{src} does not exist yet"})
                continue
            if cur:
                os.unlink(target)
            os.symlink(src, target)
            actions.append({"name": name, "action": "shared"})
        else:
            if cur == "real":
                actions.append({"name": name, "action": "unchanged"})
                continue
            if not os.path.exists(src):
                # seed placeholder so the server starts with its own state
                if fname.endswith(".json"):
                    with open(target, "w") as fh:
                        fh.write("{}\n")
                else:
                    os.makedirs(target, exist_ok=True)
                actions.append({"name": name, "action": "seeded-empty"})
                continue
            if cur == "link":
                os.unlink(target)
            if os.path.isdir(src):
                shutil.copytree(src, target)
            else:
                shutil.copy2(src, target)
            actions.append({"name": name, "action": "seeded-from-vanilla"})
    return actions


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def vanilla_port() -> int:
    try:
        with open(os.path.join(vanilla_base(), "settings.json")) as fh:
            return int(json.load(fh).get("port", 8000))
    except (OSError, ValueError):
        return 8000


# ---------------------------------------------------------------------------
# BE-1: the real dev-build engine (was cli.cmd_dev_install's body, which the
# dashboard executed in-process as print code + 'RESULT:' scraping). Pure
# data in/out: messages ride BuildResult.lines, callers decide what to
# print (CLI) or what to surface (dashboard). The patch FileHandler is
# added/removed around the whole pipeline in try/finally — the old early
# returns leaked a handler into the long-running server per failed build.
# ---------------------------------------------------------------------------

@dataclass
class BuildResult:
    ok: bool
    stage: str                       # config|clone|worktree|fetch|curated-
                                     # sync|log|materialize|dry-run|build|ok
    returncode: int
    lines: list = field(default_factory=list)   # [(out|err, text)]
    log_path: str | None = None
    materialize: dict | None = None  # materialize() result dict
    regate_failures: dict | None = None
    upstreamed: dict | None = None
    tip: str | None = None
    sync_ref: str | None = None
    base_sha: str | None = None
    n_applied: int = 0
    n_skipped: int = 0
    cfg: dict | None = None      # refreshed dev.json after a successful build
    on_line: object = None       # optional (stream, text) progress callback


def _emit(res: BuildResult, stream: str, text: str) -> None:
    res.lines.append((stream, text))
    if res.on_line:
        try:
            res.on_line(res, stream, text)
        except Exception:                        # noqa: BLE001 — progress only
            pass


def _stream_build(res: BuildResult, cmd: list) -> int:
    """BUILD-PROGRESS-1 (user 2026-10-10: "omlx-dev (re)build from the
    dashboard should log the progress"): run brew with its output piped
    and merged, forwarding every line through _emit as it arrives. The
    old subprocess.run inherited the SERVER's stdout — brew's output went
    to the omlx log, invisible to the dashboard, which sat on 'BUILDING'
    with an empty log for minutes. on_line (set by the CLI and the
    dashboard router) streams the same lines live.

    Lines carry a [mm:ss] elapsed stamp: brew's quiet-mode progress is
    sparse, and the timestamps are what make 'stuck' visible as such.
    A reader exception never kills the build — fall through to wait().
    Returns the process exit code."""
    import time as _time

    t0 = _time.monotonic()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True,
                                errors="replace", bufsize=1)
    except OSError as exc:
        _emit(res, "err", f"brew could not start: {exc}")
        return 127
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            el = int(_time.monotonic() - t0)
            _emit(res, "out", f"[{el // 60:02d}:{el % 60:02d}] {line}")
    except Exception as exc:                    # noqa: BLE001 — progress only
        _emit(res, "err", f"build output reader stopped: {exc}")
    return proc.wait()


def run_dev_build(*, with_custom_kernel: bool = False,
                  with_grammar: bool = False, dry_run: bool = False,
                  warn=None, on_line=None, on_patch_failure=None) -> BuildResult:
    """One rebuild path (DEV-context decision 3): re-cut uplift-dev from
    the synced base with one commit per enabled build patch, then
    `brew install` (first build) or `brew reinstall` (rebuild). Both always
    re-stage the branch tip (`brew upgrade` would no-op on a head).

    warn: optional callable printing the DEV-context-7 coexistence warning
    just before the brew subprocess (CLI passes its printer; the dashboard
    passes None — the service restart it manages itself).
    on_line: optional callback (result, stream, text) fired as each line
    is emitted — the CLI streams progress live instead of waiting for the
    engine to return. The result is the in-flight BuildResult (fields set
    so far).
    Returns BuildResult; never raises for expected failure stages."""
    import logging as _logging

    from . import brewutil, patchsource
    from . import patches as _patches_mod

    res = BuildResult(ok=False, stage="config", returncode=2, lines=[],
                      on_line=on_line)
    cfg = load_config()
    if not cfg:
        _emit(res, "err", "omlx-dev is not bootstrapped yet — run: "
                          "omlx-uplift dev bootstrap")
        return res
    path = src_path(cfg)
    if not os.path.isdir(os.path.join(path, ".git")):
        _emit(res, "err", f"dev-src clone missing ({path}) — run: "
                          "omlx-uplift dev bootstrap")
        res.stage, res.returncode = "clone", 2
        return res
    try:
        ensure_clone(cfg)            # drift guard before any fetch
        if not worktree_clean(path):
            _emit(res, "err", f"dev-src worktree is dirty: {path}\n"
                              "uplift refuses to re-cut the branch over "
                              "local edits — commit or discard them first.")
            res.stage, res.returncode = "worktree", 1
            return res
        fetch_sync_ref(cfg)
    except DevsrcError as exc:
        _emit(res, "err", f"dev-src: {exc}")
        res.stage, res.returncode = "fetch", 1
        return res

    # patch process log: devsrc/patchsource/diffapply log their decisions
    # on the shared "omlx_uplift" logger — a FileHandler here makes the
    # patch pass auditable after the fact. try/finally: the OLD early
    # returns skipped removeHandler and leaked one handler per failed
    # build into the dashboard's process (LOG-1 family).
    #
    # LOG-2 (2026-10-09): the handler must be attached BEFORE the source
    # refresh, not after it. The refresh's curated sync + drift check are
    # exactly what emits the 'gate REJECTED' warning the user sees on the
    # console — attached late, that line printed to stderr, the log the
    # CLI points at for 'investigation' stayed empty, and a user who
    # disabled the offending patch saw the (now harmless) rejection echo
    # with no way to tell it apart from the failure that had stopped the
    # build. The printed hint stays truthful only if the log holds it.
    log_dir = os.path.join(_patches.default_base_dir(), "logs")
    os.makedirs(log_dir, exist_ok=True)
    res.log_path = os.path.join(log_dir, "dev-install.log")
    _ph = _logging.FileHandler(res.log_path)
    _ph.setFormatter(_logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"))
    _root = _logging.getLogger("omlx_uplift")
    _root.addHandler(_ph)
    _root.setLevel(min(_root.level or _logging.INFO, _logging.INFO))
    try:
        # source refresh BEFORE collecting build patches (user policy
        # 2026-10-09): curated catalog (every build, not only a first one)
        # + drift check; an auto-promoted curated candidate must be part of
        # THIS build. Best-effort: a dead network never blocks a build.
        _refresh_patch_sources(cfg, res)

        build_patches = patchsource.enabled_build_patches(
            _patches_mod.PatchStore())
        return _run_dev_build_body(res, cfg, build_patches, patchsource,
                                   brewutil, with_custom_kernel,
                                   with_grammar, dry_run, warn,
                                   on_patch_failure)
    finally:
        _root.removeHandler(_ph)
        _ph.close()


def _vanilla_keg_site_packages() -> str | None:
    """site-packages of the VANILLA omlx keg (the runtime overlay tree),
    or None. The dev-build paths run inside the omlx-dev interpreter,
    where importing omlx resolves to the dev keg — asking IT for a root
    would gate overlays against patched dev source. probe via subprocess
    so the current process never imports the wrong omlx; a machine with
    no vanilla keg gets None (the runtime half is simply skipped)."""
    import os as _os
    import subprocess

    from . import brewutil
    from . import patches as _patches_mod

    root = _patches_mod._omlx_root()
    if root and "omlx-dev" not in _os.path.normpath(root):
        return _os.path.dirname(root)
    py = brewutil.brew_formula_python("omlx")
    if not py:
        return None
    try:
        out = subprocess.run(
            [str(py), "-c",
             "import omlx, os; print(os.path.dirname(os.path.dirname(omlx.__file__)))"],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    cand = out.stdout.strip()
    return cand if out.returncode == 0 and _os.path.isdir(cand) else None


def _refresh_patch_sources(cfg: dict, res) -> dict:
    """One source refresh before a dev build (user policy 2026-10-09):

    1. curated catalog sync — previously ran only when the store carried
       ZERO curated patches, so a published NEW VERSION of a bundled patch
       never reached the machine ('already_present' forever). Now every
       build runs it (network best-effort: any failure logs and the build
       continues; the store stays authoritative).
    2. drift check over github_pr/url sources against the CLEAN base
       checkout. For catalog-owned (not adopted) patches a validated
       candidate with no new safeguard hold auto-promotes inside
       check_all; user patches only light the update_available chip.

    Without a vanilla keg on this machine even step 1 runs: add_patch
    falls back to the dev carrier when a keg gate errors (tree_root=''
    fails the gate, not the add — a scope=omlx catalog entry then reports
    a gate failure and the store is untouched)."""
    import tempfile

    from . import patchsource
    from . import patches as _patches_mod

    summary = {"catalog": None, "drift": None}
    store = _patches_mod.PatchStore()
    keg_sp = _vanilla_keg_site_packages() or ""
    try:
        from . import curated as _curated

        cs = _curated.sync(store, keg_sp, build_root=src_path(cfg))
        summary["catalog"] = cs
        changed = [k for k, v in cs["report"].items()
                   if not str(v.get("sync", "")).endswith("already_present")
                   and not str(v.get("sync", "")).startswith("skipped")]
        if changed:
            _emit(res, "out", "curated: " + ", ".join(sorted(changed))
                  + (" — store updated" if cs.get("ok") else " (sync had errors)"))
        for note in cs.get("notes", []):
            _log.info("curated sync note: %s", note)
    except Exception as exc:                    # noqa: BLE001 — best-effort
        _emit(res, "err", f"curated sync skipped: {exc}")
    tmp = None
    try:
        tmp = tempfile.mkdtemp(prefix="uplift-drift-")
        wt = detached_base_worktree(cfg, tmp)
        dr = patchsource.check_all(store, keg_sp, dev_root=wt)
        summary["drift"] = dr
        for pid, rep in (dr.get("reports") or {}).items():
            if rep.get("check") == "update_available" and rep.get("promoted"):
                _emit(res, "out", f"{pid}: curated update v{rep['v']} "
                                  "auto-promoted — materialized in this build")
            elif rep.get("check") == "update_available":
                _emit(res, "out", f"{pid}: update v{rep['v']} available "
                                  "(Promote in the dashboard to adopt)")
            elif rep.get("check") == "obsolete":
                _emit(res, "out", f"{pid}: upstream now carries the patch "
                                  "(marked obsolete)")
            elif rep.get("check") == "error":
                # LOG-2: the drift gate's failure used to vanish here while
                # fetch_and_gate printed an unattributed 'gate REJECTED' —
                # users read it as the build failing (it was not; the
                # candidate simply cannot be stored). Name the patch.
                _emit(res, "out", f"{pid}: source re-gate failed — "
                                  f"{str(rep.get('reason') or '')[:160]} "
                                  "(stored version unchanged)")
    except Exception as exc:                    # noqa: BLE001 — best-effort
        _emit(res, "err", f"drift check skipped: {exc}")
    finally:
        if tmp:
            import shutil

            try:
                _git(["worktree", "remove", "--force", tmp],
                     cwd=src_path(cfg), check=False)
            except DevsrcError:
                pass
            shutil.rmtree(tmp, ignore_errors=True)
    return summary


def _run_dev_build_body(res, cfg, build_patches, patchsource, brewutil,
                        with_custom_kernel, with_grammar, dry_run, warn,
                        on_patch_failure=None):
    import subprocess

    _emit(res, "out", f"patch process log: {res.log_path}")
    res.stage = "materialize"
    mres = materialize(build_patches, cfg, on_patch_failure=on_patch_failure)
    res.materialize = mres
    # VER-1: the resolver said 'build without it' — loud, honest lines;
    # these patches are NOT in the keg this build ships.
    for sk in mres.get("skipped_patches") or []:
        _emit(res, "err", f"{sk['id']}: SKIPPED this build — no stored "
                          f"version applies (tried "
                          + ", ".join(f"v{t}" for t in sk.get("tried", [])) + ")")
    for c in mres.get("commits") or []:
        if c.get("fallback_from"):
            _emit(res, "out", f"{c['id']}: v{c['fallback_from']} does not "
                              f"apply onto this base — built v{c['v']} "
                              "(nearest tested version) instead")
    if not mres.get("ok"):
        _emit(res, "err", f"materialize FAILED: {mres.get('reason')}")
        for c in mres.get("commits", []):
            _emit(res, "err", f"  applied before failure: {c['id']} "
                              f"v{c.get('v')}")
        _emit(res, "err", "fix or disable the named patch, then re-run")
        if mres.get("failed_patch"):
            _emit(res, "err", "  one way out — disable it and re-run:")
            _emit(res, "err", f"    omlx-uplift patch disable "
                              f"{mres['failed_patch']}")
        _emit(res, "err", f"  investigation: {res.log_path}")
        res.ok, res.returncode = False, 1
        return res

    tip = mres["tip"]
    res.tip = tip
    res.sync_ref = cfg.get("sync_ref")
    res.base_sha = mres.get("base") or ""
    commits = mres.get("commits", [])
    res.n_applied = len([c for c in commits if c.get("sha")])
    res.n_skipped = len([c for c in commits
                         if c.get("skipped") == "already-present"])
    # a materialize skip means the base already carries the patch — when
    # the patch is a since-MERGED PR that means it is no longer needed, so
    # stamp it obsolete NOW (best-effort network). Must run BEFORE
    # mark_dev_applied (which saves its own manifest reload — store-write
    # ordering rule).
    from . import patches as _patches_mod
    store = _patches_mod.PatchStore()
    res.upstreamed = patchsource.mark_upstreamed_if_merged(store, commits)
    # the branch IS the apply step for dev/both scopes — record it so the
    # dashboard stops showing 'pending' forever (reconcile never sees these)
    patchsource.mark_dev_applied(store, commits)

    # re-gate BEFORE the rebuild (DEV-context decision 9) — failures mark
    # needs_review per patch, never silently skipped. VER-1: re-gate what
    # ACTUALLY got built (commits carry the fallback versions; resolver-
    # skipped patches built nothing and must not light a needs_review the
    # user already chose — they are reported via skipped_patches).
    built = [c for c in commits if c.get("sha") or c.get("skipped")]
    gated = _build_patches_from_commits(built, patchsource) if built else []
    res.regate_failures = recheck_build_patches(gated) if gated else {}
    for pid, why in (res.regate_failures or {}).items():
        _emit(res, "err", f"{pid}: RE-GATE FAILED (needs_review): {why}")
        _emit(res, "err", "  one way out — disable it and re-run:")
        _emit(res, "err", "    omlx-uplift patch disable " + pid)
        _emit(res, "err", f"  investigation: {res.log_path}")

    flags = set()
    if with_custom_kernel:
        flags.add("--with-custom-kernel")
    if with_grammar:
        flags.add("--with-grammar")
    if not flags:
        # user decision 2026-09-24: preserve custom-kernel + grammar from
        # the user's build — dev receipt first, else the vanilla omlx one
        flags = (brewutil.receipt_used_options("omlx-dev")
                 or brewutil.receipt_used_options("omlx"))
    cmd = brewutil.brew_build_cmd(flags)
    if dry_run:
        res.ok, res.returncode, res.stage = True, 0, "dry-run"
        _emit(res, "out", "dry-run: would run: " + " ".join(cmd))
        return res
    if warn:
        warn()
    res.stage = "build"
    # U19: brew reinstall DESTROYS the outgoing keg — clone it into the
    # stash first so `dev use <old-sha>` stays possible. Best-effort: a
    # failed stash must never block the rebuild.
    try:
        from . import kegstash

        if kegstash.active_keg():
            r = kegstash.stash()
            _emit(res, "out", f"previous keg stashed: {r['name']} "
                              f"({r['method']}) — rollback: omlx-uplift "
                              f"dev use {r['name'][5:12]}")
            # DEV-13: retention is a policy, not a chore — best-effort
            # prune right after the build-path stash (dev.json
            # keg_stash_keep, default 5 builds; never prunes the slot
            # the active keg occupies). Failure here must never block
            # the rebuild.
            try:
                gone = kegstash.prune()
                if gone:
                    _emit(res, "out", f"keg stash pruned: {', '.join(gone)}")
            except Exception:
                pass
    except Exception as exc:
        _emit(res, "err", f"keg stash skipped: {exc}")
    # install owns the pin (decision 3): brew refuses to reinstall a pinned
    # formula, so lift it for this one rebuild and restore it afterwards —
    # on success AND on failure (the pin must never silently disappear)
    subprocess.run(["brew", "unpin", "omlx-dev"], capture_output=True)
    # LINK-RECORD: heal a brew linked-keg record left pointing at another
    # keg (stale after `dev use`/`rollback`, or dangling) — `brew
    # reinstall` aborts its link step on it and `brew unlink` cannot
    # clear it. Best-effort: must never block the rebuild.
    try:
        from . import kegstash

        healed = kegstash.repair_link_record()
        if healed:
            _emit(res, "out", f"self-heal: {healed}")
    except Exception as exc:
        _emit(res, "err", f"link-record repair skipped: {exc}")
    _emit(res, "out", "running: " + " ".join(cmd))
    # --quiet skips brew's caveats entirely (formula_installer: return if
    # quiet?) — the restart hint we print after RESULT replaces them
    rc = _stream_build(res, [*cmd, "--quiet"])
    if rc != 0:
        subprocess.run(["brew", "pin", "omlx-dev"], capture_output=True)
        _emit(res, "err", "brew build FAILED — dev keg untouched "
                          "(pin restored)")
        _emit(res, "err", f"  investigation: {res.log_path}")
        res.ok, res.returncode = False, rc
        return res
    subprocess.run(["brew", "pin", "omlx-dev"], capture_output=True)
    cfg = load_config() or cfg
    cfg["built_sha"] = tip
    # DEV-11: the base commit this keg was cut from — the boot hook
    # compares the CURRENT sync-ref tip against it to decide "HEAD moved"
    # without re-running materialize.
    cfg["built_base"] = res.base_sha
    # wall-clock build completion: the dashboard compares it against the
    # running service's start time to show RESTART NEEDED (DEV-6)
    cfg["built_at"] = _patches.now_iso()
    save_config(cfg)
    res.cfg = cfg
    brewutil.mount_into_dev_keg()
    _emit(res, "out", f"omlx-dev built from {tip[:12]}; .pth mount "
                      "refreshed")
    res.ok, res.returncode, res.stage = True, 0, "ok"
    return res


def _build_patches_from_commits(commits: list[dict], patchsource) -> list[dict]:
    """VER-1: the enabled_build_patches shape ({id, version, diff_bytes})
    for versions that ACTUALLY materialized (commits carry the fallback v
    when the desired one did not apply) — the re-gate must judge what the
    brew build sees, not what the store wanted. 'already-present' commits
    carry no new bytes (base has them); they gate from the stored file too
    so the loop keeps its per-patch order signal."""
    from . import patches as _patches_mod

    store = _patches_mod.PatchStore()
    manifest = store.load()
    out = []
    for c in commits:
        entry = store.find(manifest, c["id"])
        if not entry:
            continue
        ver = store.get_version(entry, c.get("v")) or {}
        data = _read_stored_diff(store, ver) if ver.get("patch_file") else None
        if data is None:
            continue
        out.append({"id": c["id"], "version": c.get("v"), "diff_bytes": data})
    return out


def recheck_build_patches(build_patches: list[dict]) -> dict:
    """BE-1(4): public re-gate of every enabled build patch against the
    freshly checked-out base — the loop that cli._regate_build_patches used
    to reimplement from devsrc PRIVATES. Gated against a detached worktree
    at the pristine base, each patch applied in materialization order so
    the next gates against the tree materialize actually built.
    Returns {patch_id: reason} for failures (state=needs_review stamped,
    store saved once, only on failures)."""
    from . import patchsource

    cfg = load_config() or {}
    from . import patches as _patches_mod
    store = _patches_mod.PatchStore()
    failures: dict[str, str] = {}
    if not build_patches or not cfg.get("src_path"):
        return failures
    path = src_path(cfg)
    tmp = tempfile.mkdtemp(prefix="uplift-regate-")
    try:
        wt = detached_base_worktree(cfg, tmp)
    except DevsrcError as exc:
        _log.warning("re-gate skipped (worktree at base failed): %s", exc)
        return failures
    try:
        manifest = store.load()
        for p in build_patches:
            # gate against the tree as the NEXT patch will find it: base +
            # all earlier patches in materialization order
            entry = store.find(manifest, p["id"])
            if entry is None:
                continue
            result = patchsource.validate(
                p["diff_bytes"], wt,
                reverse=bool(entry.get("reversal")), skip_patterns=None,
                tree_kind="src")     # detached base worktree, not a keg
            if not result["ok"]:
                entry["state"] = "needs_review"
                entry["state_detail"] = ("re-gate after dev install failed: "
                                         + (result.get("reason")
                                            or "one or more files failed"))
                failures[p["id"]] = result.get("reason") or "gate failed"
                # still apply so later patches gate against the same tree
                # materialize actually built (materialize committed them)
            try:
                apply_one(wt, p["id"], p.get("version", 0), p["diff_bytes"])
            except DevsrcError:
                pass
        if failures:
            store.save(manifest)
    finally:
        _git(["worktree", "remove", "--force", tmp], cwd=path, check=False)
    return failures


def detached_base_worktree(cfg: dict, target: str) -> str:
    """Public wrapper: detached git worktree of the pristine sync base at
    `target`. Was private _sync_parts/_git usage from cli's copy."""
    path = src_path(cfg)
    remote, ref = _sync_parts(cfg)
    base = f"refs/remotes/{remote}/{ref}"
    _git(["worktree", "add", "--detach", "-q", target, base], cwd=path)
    return target


def apply_one(path: str, pid: str, v: int, diff_bytes: bytes) -> None:
    """Public alias of the materialize-internal single-patch apply (BE-1(4):
    cli must not call _apply_one)."""
    return _apply_one(path, pid, v, diff_bytes)
