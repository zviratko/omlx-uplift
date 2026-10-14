"""REPL-2b: the bench venv (lm-evaluation-harness) — build, status, spawn.

Card rules implemented here (all deliberate, tests pin them):

- OWN venv under ~/.omlx/uplift/bench-env, lazily built by
  `omlx-uplift bench-env create`. NEVER inside the omlx/uplift kegs:
  no torch, no datasets, nothing entering constraints-stable.txt.
- Version PINNED from bench_env_requirements.txt (70-pkg freeze verified
  torch-free on the dev box, NAT-2 residual 3). A marker file records
  which requirements digest the venv was built from; a mismatched venv
  is 'stale', and accuracy runs refuse to use a stale venv (the
  alternative — silently running a different harness than the one the
  score labels claim — is dishonest). The digest is over what pip acts
  on, comments stripped (ACC-2e): prose in a pin file must not cost a
  rebuild, a pin change must.
- Stale ⇒ FULL WIPE (ACC-2e). create() removes the whole venv before
  every (re)build, whatever the reason for rebuilding — a pin bump only
  ADDS/UPDATES packages, so layering a new pin onto the old
  site-packages left the packages that dropped out of the file behind as
  orphans while the marker flipped the state back to 'ready'. The venv
  then lied about what it holds, which is the same dishonesty the
  staleness check exists to prevent. No flag needed at any call site.
- On-demand heavy deps (user policy 2026-10-14): a scoring dependency
  like torch MAY enter an env when a suite's scorer actually imports it
  — but only when that env's own requirements file PINS it. The builder
  still refuses an unpinned torch that snuck in transitively: the guard
  is pin-driven now, not absolute (see _guard_heavy_dep).
- Disk hygiene: pip runs --no-cache-dir, so an uplift build leaves no
  cache behind. Measured on kocour 2026-10-14 with the real 70-pin
  requirements file: install with NOTHING cached (what --no-cache-dir
  means here) 29 s, ~117 MB downloaded; the same install served from a
  warm uplift-owned cache dir 15 s. Buying those 14 s per pin bump with a
  wheel cache that passes a gigabyte the moment mteb-env's torch (587 MB)
  lands in it is the wrong trade under 'no gigabyte leftovers from stale
  versions' — and pip's default cache is machine-global (884 MB on this
  box today), so the alternative was an owned dir plus prune code we then
  have to keep honest. status() reports venv_bytes/cache_bytes walked
  in-process under a wall-clock budget — None means 'too slow to say',
  never a half-summed number.
- Auth: the harness gets the API key through OPENAI_API_KEY in the
  child env ONLY. It is never placed in argv (ps would leak it) and
  never logged; scrub_key() redacts the literal from any captured
  output before it reaches logs or SSE events.
- NLTK (ACC-2c): the corpora a scorer imports at MODULE LOAD (ifeval:
  punkt_tab, punkt) are pre-seeded into uplift's OWN nltk_data dir when
  the venv is built and handed to every child through NLTK_DATA — never
  ~/nltk_data, no network at run time, prunable with the rest of store.
- Lifecycle: the child runs in its own process group; stop = killpg
  TERM then KILL — the accuracy engine owns this and guarantees no
  orphan survives a server stop (restart-safety, card Verify).
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("uplift.bench_env")

REQUIREMENTS = Path(__file__).with_name("bench_env_requirements.txt")
VENV_DIRNAME = "bench-env"
MARKER = "uplift-bench-env.json"

# ACC-2e guard: the heavy dependency the card forbids by accident. It is
# ALLOWED when (and only when) the env's own requirements file pins it —
# the user's on-demand-deps policy (2026-10-14): torch may enter an env
# when a scorer actually imports it, measured minimal set, deliberately.
GUARD_MODULE = "torch"

# Wall-clock budget per size walk in status() (see _dir_bytes). Measured
# on kocour 2026-10-14 (warm FS cache, scandir): bench-env (604 MB / 33k
# files) 150-300 ms, mteb-env (1.5 GB / 47k files) 250-390 ms, the uplift
# HF dataset cache (614 MB / 5k files) 50-60 ms. 0.3 s is therefore
# 'always answers for bench-env, usually for mteb-env' while still
# capping a pathological tree; over budget the key is None, never a
# partial sum. Callers on a hot path pass sizes=False.
SIZE_BUDGET_S = 0.3


def bench_env_dir(dirname: str = VENV_DIRNAME) -> Path:
    from . import paths
    return paths.uplift_store_dir() / dirname


def requirements_digest(req: Path = REQUIREMENTS) -> str:
    """Digest of what pip ACTS ON — comment and blank lines are stripped
    first (ACC-2e). Rationale: the marker's whole job is to prove which
    PIN SET the venv was built from, and prose cannot change the
    installed tree; without this normalization a comment edit to a pin
    file declares a working 604 MB / 1.5 GB env stale and the user pays
    a rebuild to read a sentence. Any change to a pin, an option line
    (-r/-c/--index-url/...) or an extra still moves the digest, so the
    stale check keeps its teeth."""
    body = "\n".join(ln for ln in (raw.strip() for raw in
                                   req.read_text().splitlines())
                     if ln and not ln.startswith("#"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


_REQ_NAME_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)")


def requirements_digest_legacy(req: Path) -> str:
    """Pre-ACC-2e digest: sha256 over the WHOLE file, comments included.
    status() accepts it as current (see _digests_current) so the switch
    above does not by itself push every existing store env through a
    wipe+rebuild — a marker stamped with this value over an UNCHANGED
    file proves the same pin set. It is a migration accommodation, not a
    second source of truth: safe to delete one release after ACC-2e,
    once every env has been rebuilt at least once."""
    return hashlib.sha256(req.read_bytes()).hexdigest()[:16]


def _digests_current(built, req: Path) -> bool:
    """Marker value vs what `req` now pins (either digest algorithm)."""
    if built is None:
        return False
    try:
        legacy = requirements_digest_legacy(req)
    except OSError:
        legacy = None
    return built == requirements_digest(req) or built == legacy


def requirements_names(req: Path) -> set[str]:
    """Normalized distribution names pinned/listed in a requirements file
    (PEP 503-ish: lowercased, '_' -> '-'). Comment lines, option lines
    (-r/-c/--hashes) and blank lines are skipped; extras and version
    specifiers are cut off at the first delimiter, so 'lm_eval[xx]>=1'
    reports 'lm-eval'. Used by the pin-driven heavy-dep guard."""
    names: set[str] = set()
    try:
        text = Path(req).read_text()
    except OSError:
        return names
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        m = _REQ_NAME_RE.match(line)
        if m:
            names.add(m.group(1).lower().replace("_", "-"))
    return names


def _dir_bytes(root: Path, deadline: float) -> Optional[int]:
    """Sum of apparent file sizes under `root`, or None if the walk hits
    `deadline` (time.monotonic). scandir, in-process — NEVER `du`: a
    subprocess per status() call is a worse dashboard lag than the walk
    itself and a dependency on a coreutils whose output format we would
    then parse. Symlinks are measured as links (not followed), matching
    what a venv actually costs us on disk.
    NOTE: apparent bytes < `du -sh` blocks (measured 537.6 MB vs 604 MB
    for bench-env) — the key documents this; do not compare it to du."""
    total = 0
    stack = [str(root)]
    now = time.monotonic
    while stack:
        try:
            it = os.scandir(stack.pop())
        except OSError:                     # unreadable dir: skip, keep summing
            continue
        with it:
            for entry in it:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    else:
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:             # raced away mid-rebuild
                    continue
                if now() > deadline:
                    return None
    return total


def size_facts(venv: Path, cache: Optional[Path] = None, *,
               budget_s: float = SIZE_BUDGET_S) -> dict:
    """{'venv_bytes', 'cache_bytes'} — bounded by `budget_s` PER walk (so
    a status() call costs at most ~2x that, and typically 150+50 ms).
    None = not measured (budget spent, path missing, or sizes skipped).
    `cache` is uplift's OWN dataset cache (hf_cache_dir), the directory
    that actually grows while a user runs suites; there is deliberately
    no pip cache to report — installs run --no-cache-dir."""
    t0 = time.monotonic()
    out: dict = {"venv_bytes": None, "cache_bytes": None}
    try:
        if venv.is_dir():
            out["venv_bytes"] = _dir_bytes(venv, t0 + budget_s)
    except OSError:
        pass
    try:
        if cache is not None and cache.is_dir():
            out["cache_bytes"] = _dir_bytes(cache, t0 + 2 * budget_s)
    except OSError:
        pass
    return out


def _python_for_venv() -> str:
    """Prefer the interpreter that has the MLX stack? NO — the venv must
    stay independent. Use whichever python3 >= 3.10 is available:
    the keg python first (guaranteed present with omlx, exact 3.11),
    then PATH python3. lm-eval itself pulls no mlx dependency."""
    candidates = []
    try:
        import omlx  # noqa: F401
        candidates.append(sys.executable)
    except Exception:
        pass
    for name in ("python3.11", "python3.12", "python3"):
        p = shutil.which(name)
        if p:
            candidates.append(p)
    for c in candidates:
        try:
            out = subprocess.run(
                [c, "-c", "import sys; print(sys.version_info[0],"
                          "sys.version_info[1])"],
                capture_output=True, text=True, timeout=15)
            major, minor = (int(x) for x in out.stdout.split())
            if (major, minor) >= (3, 10):
                return c
        except Exception:
            continue
    raise RuntimeError("no python >= 3.10 found for the bench venv")


def status(*, dirname: str = VENV_DIRNAME, req: Path = REQUIREMENTS,
           marker: str = MARKER, sizes: bool = True,
           size_budget_s: float = SIZE_BUDGET_S) -> dict:
    """State of one uplift env (bench-env / mteb-env): missing|stale|ready.

    ACC-2e: every state also carries the honest disk facts —
      venv_bytes:  apparent bytes of the venv itself (None if not asked
                   for / the dir is gone / the walk spent its budget)
      cache_bytes: apparent bytes of uplift's OWN HF dataset cache
                   (hf_cache_dir) — the tree that grows as suites run.
    Both are bounded by `size_budget_s` per walk so no caller can be
    ambushed by a huge tree; None means 'did not measure', and a partial
    sum is never passed off as a size. Pass sizes=False on a hot path.
    Existing keys are unchanged (consumers: cli, harness_engine,
    embed_engine, mteb_env)."""
    venv = bench_env_dir(dirname)

    def _facts() -> dict:
        if not sizes:
            return {"venv_bytes": None, "cache_bytes": None}
        try:
            cache = hf_cache_dir()
        except Exception:               # config.json unreadable: venv only
            cache = None
        return size_facts(venv, cache, budget_s=size_budget_s)

    py = venv / "bin" / "python"
    marker_path = venv / marker
    if not py.exists():
        return {"state": "missing", "path": str(venv), **_facts()}
    digest = requirements_digest(req)
    if marker_path.exists():
        import json
        try:
            built = json.loads(marker_path.read_text()).get("requirements")
        except Exception:
            built = None
    else:
        built = None
    if not _digests_current(built, req):
        # 'built == legacy digest' is deliberate (see
        # requirements_digest_legacy): a comment-only edit to the pin
        # file must not send a working 604 MB / 1.5 GB env through a
        # wipe+rebuild.
        return {"state": "stale", "path": str(venv),
                "built_from": built, "wants": digest, **_facts()}
    return {"state": "ready", "path": str(venv), "requirements": digest,
            **_facts()}


def _guard_heavy_dep(py: Path, req: Path, *, quiet: bool = False) -> None:
    """Pin-driven heavy-dependency guard (ACC-2e; evolves the old absolute
    bench-env torch ban, it does not remove it).

    Behavior matrix, all four cells deliberate:
      torch pinned in `req`  + present  -> PASS, info log. The env asked
                                          for it in its own requirements
                                          file (mteb-env does; that is
                                          the on-demand-deps policy:
                                          measured minimal set, added
                                          deliberately, reviewed).
      torch NOT pinned       + present  -> RAISE + error log. Something
                                          pulled ~600 MB in transitively
                                          or a pin drifted; the accidental
                                          bloat guard still bites.
      anything               + absent   -> PASS silently (bench-env's
                                          normal shape; a pin that failed
                                          to install already died in pip).
    `req` is the file THIS env was built from, so the answer is per-env:
    bench-env refuses torch, mteb-env allows it, both by the same rule.
    """
    probe = subprocess.run(
        [str(py), "-c", f"import importlib.util, sys;"
         f"sys.exit(1 if importlib.util.find_spec({GUARD_MODULE!r}) else 0)"],
        capture_output=True)
    present = probe.returncode != 0        # exit 1 == find_spec found it
    if not present:
        return
    pinned = GUARD_MODULE in requirements_names(req)
    if pinned:
        msg = (f"{GUARD_MODULE} present in env built from {Path(req).name} "
               f"and pinned there — allowed (on-demand deps policy)")
        if not quiet:
            print(msg)
        logger.info("uplift bench_env: %s", msg)
        return
    msg = (f"{GUARD_MODULE} appeared in the venv but is NOT pinned in "
           f"{Path(req).name} — refusing (transitive bloat; if a scorer "
           f"genuinely needs {GUARD_MODULE}, pin it in that file "
           f"deliberately and rebuild)")
    logger.error("uplift bench_env: %s", msg)
    raise RuntimeError(msg)


def create(*, reinstall: bool = False, quiet: bool = False,
           dirname: str = VENV_DIRNAME, req: Path = REQUIREMENTS,
           marker: str = MARKER, import_name: str = "lm_eval",
           extra_check=None) -> dict:
    """Build (or rebuild) a pinned bench venv. Returns status() at the end.

    Two envs share this machinery (REPL-4 decision, recorded on the card):
    - bench-env: harness; the heavy-dep guard refuses torch unless that
      env's own requirements file pins it (today it does not — see
      _guard_heavy_dep for the matrix).
    - mteb-env: MTEB, which hard-requires torch>=2.0 and DOES pin it, so
      the guard passes it by the same rule. extra_check (a function that
      RAISES on a bad venv) runs IN ADDITION to the guard — it adds a
      check, it does not switch the guard off. The kegs stay
      torch-free either way; only /store envs carry evaluation
      dependencies.

    Rebuild semantics (ACC-2e): any build that is not a ready-no-op wipes
    the target venv first — stale pin bump, explicit --reinstall, or a
    half-present directory. pip cannot subtract, so a layered rebuild
    would keep whatever the old pin had and the new one dropped: an
    orphaned tree wearing a 'ready' marker.
    """
    st_kw = dict(dirname=dirname, req=req, marker=marker)
    # the probe does not need to touch the tree — sizes are for the
    # dict we RETURN, not for the decision we make here
    if status(sizes=False, **st_kw)["state"] == "ready" and not reinstall:
        return status(**st_kw)
    venv = bench_env_dir(dirname)
    if venv.exists():
        # rmtree ALWAYS before a build (ACC-2e) — previously only
        # reinstall=True wiped, which is how a stale rebuild silently
        # kept dropped packages. The failure path below still wipes the
        # half-built env, so no broken tree is ever left to be mistaken
        # for a working one.
        shutil.rmtree(venv)
    venv.parent.mkdir(parents=True, exist_ok=True)
    base = _python_for_venv()
    if not quiet:
        print(f"creating bench venv: {venv} (base: {base})")
    subprocess.run([base, "-m", "venv", str(venv)], check=True)
    py = venv / "bin" / "python"
    if not quiet:
        print("installing pinned bench requirements "
              "(--no-cache-dir; measured 29 s cold, ~1-3 min on a slow "
              "link — uplift keeps no pip cache, see module docstring)...")
    # --no-cache-dir is the disk-hygiene half of ACC-2e: pip's default
    # HTTP cache is machine-global (measured 884 MB on this box today)
    # and every uplift rebuild would feed it forever, which is exactly
    # the 'gigabyte leftovers' the on-demand-deps policy forbids. The
    # owned-bounded-cache alternative was measured too (15 s warm vs
    # 29 s cold) and rejected: 14 s saved per pin bump is not worth a
    # cache we would have to prune, and mteb-env's torch wheel would
    # have made it ~700 MB on its own.
    subprocess.run([str(py), "-m", "pip", "install", "--quiet",
                    "--no-cache-dir", "--upgrade", "pip"],
                   check=True)
    subprocess.run([str(py), "-m", "pip", "install", "--quiet",
                    "--no-cache-dir", "-r", str(req)], check=True)
    try:
        _guard_heavy_dep(py, req, quiet=quiet)
        if extra_check is not None:
            extra_check(py)
        ver = subprocess.run(
            [str(py), "-c",
             f"import {import_name}; print({import_name}.__version__)"],
            capture_output=True, text=True)
        if ver.returncode != 0:
            raise RuntimeError(
                f"venv built but 'import {import_name}' fails: "
                f"{ver.stderr.strip()[-200:]}")
    except Exception:
        shutil.rmtree(venv, ignore_errors=True)
        raise
    import json
    stamp = {"requirements": requirements_digest(req),
             import_name: ver.stdout.strip(),
             "created": int(__import__("time").time())}
    if dirname == VENV_DIRNAME:
        # ACC-2c: the venv is the thing that owns nltk, so the corpora are
        # seeded here — once, at build time, where the network is already in
        # use — instead of at a harness child's import time. Bench-env only:
        # mteb-env shares this machinery and no scorer there imports nltk.
        stamp["nltk"] = seed_nltk_data(py, quiet=quiet)
    (venv / marker).write_text(json.dumps(stamp, indent=1))
    if not quiet:
        print(f"bench venv ready: {import_name} {ver.stdout.strip()}")
    return status(**st_kw)


def harness_python() -> Optional[str]:
    st = status(sizes=False)   # hot path (every suite start): state only
    if st["state"] != "ready":
        return None
    py = Path(st["path"]) / "bin" / "python"
    return str(py)


def hf_cache_dir() -> Path:
    """Dataset cache dir, configurable in ~/.omlx/uplift/config.json
    ('bench_hf_cache', default ~/.omlx/uplift/bench-cache). Kept OUT of
    ~/.cache/huggingface so uplift owns and can prune it."""
    from . import paths
    cfg = paths.uplift_store_dir() / "config.json"
    default = paths.uplift_store_dir() / "bench-cache"
    try:
        import json
        if cfg.exists():
            v = json.loads(cfg.read_text()).get("bench_hf_cache")
            if v:
                return Path(os.path.expanduser(str(v)))
    except Exception:
        pass
    return default


# ---- ACC-2c: the NLTK corpora, uplift-owned and pre-seeded -----------------
# lm_eval's IFEval scorer calls nltk.download('punkt_tab') AT MODULE IMPORT
# (lm_eval/tasks/ifeval/instructions_util.py:36-52, verified against the
# installed 0.4.13) and its sentence counter loads
# 'nltk:tokenizers/punkt/english.pickle' while scoring (instructions_util.py
# :1689, reached from instructions.py:260). With no NLTK_DATA set, nltk
# resolves that download into the FIRST entry of its default search path —
# the user's home (~/nltk_data) — so a first IFEval run reaches the network,
# writes outside every uplift dir, and dies outright under bench_offline
# (HF_HUB_OFFLINE does not cover nltk; the corpus is not a hub asset).
#
# Fix at the right layer: uplift OWNS a corpus dir under its own store,
# fills it when the bench venv is BUILT (network there is already assumed —
# pip just used it), and points every harness child at it via NLTK_DATA.
# Consequences, all deliberate:
#   * offline-safe — nltk.data.find() hits before any download attempt, so
#     importing the scorer needs no network on later runs;
#   * prunable — one dir, `omlx-uplift bench-env`'s own store family, and
#     it is re-seeded by the next create();
#   * never ~/nltk_data — and if a user deletes our dir anyway, the
#     scorer's own nltk.download() lands in NLTK_DATA (nltk writes to the
#     FIRST path), so the worst case is a self-healing download in the
#     place we chose, not a stray home directory.
NLTK_DATA_DIRNAME = "nltk_data"
NLTK_PACKAGES = ("punkt_tab", "punkt")

# Runs IN the bench venv (it is the one that owns nltk). argv: target dir +
# JSON package list. Prints one 'UPLIFT_NLTK <json>' line and nothing else.
_NLTK_SEED_CODE = """
import json, os, sys
target, pkgs = sys.argv[1], json.loads(sys.argv[2])
import nltk
from nltk.downloader import Downloader
if target not in nltk.data.path:
    nltk.data.path.insert(0, target)
out = {}
dl = None
for pkg in pkgs:
    # Target-scoped check ONLY (2026-10-14 fix): nltk.data.find searches
    # every entry of nltk.data.path — a corpus sitting in ~/nltk_data made
    # this report 'present' while the uplift store stayed EMPTY, so the
    # marker lied and the offline promise rode on the user's home dir.
    # The seeded tree in `target` is what the promise is about.
    if os.path.isdir(os.path.join(target, "tokenizers", pkg)):
        out[pkg] = "present"
        continue
    try:
        if dl is None:
            dl = Downloader(download_dir=target)
        ok = dl.download(pkg, quiet=True)
        out[pkg] = "downloaded" if ok else "failed"
    except Exception as e:
        out[pkg] = "error:" + type(e).__name__
# ACC-2c hygiene: the downloader leaves the archive next to the tree it
# unpacked (measured: punkt 14 MB + punkt_tab 4 MB of dead .zip beside 47 MB
# of corpus). The tree is what nltk loads, so the zip goes.
dropped = 0
tok = os.path.join(target, "tokenizers")
if os.path.isdir(tok):
    for name in sorted(os.listdir(tok)):
        if not name.endswith(".zip"):
            continue
        if os.path.isdir(os.path.join(tok, name[:-4])):
            try:
                os.remove(os.path.join(tok, name))
                dropped += 1
            except OSError:
                pass
out["_zips_removed"] = dropped
print("UPLIFT_NLTK " + json.dumps(out), flush=True)
"""


def nltk_data_dir() -> Path:
    """The uplift-owned NLTK corpus dir (sibling of the venvs, so a test
    that redirects bench_env_dir() redirects the corpus with it — no path
    may ever reach the developer's real store)."""
    return bench_env_dir().parent / NLTK_DATA_DIRNAME


def seed_nltk_data(py: str | Path, *, packages: tuple[str, ...] = NLTK_PACKAGES,
                   quiet: bool = False, timeout: int = 600) -> dict:
    """Fill nltk_data_dir() with the corpora a harness child imports at
    module load. NEVER raises and NEVER fails a venv build: a missing
    corpus costs one suite at run time, a failed build costs the user their
    working board. The returned facts land in the env marker so 'did the
    offline gap actually get closed' is answerable without running anything.
    """
    target = nltk_data_dir()
    try:
        import json
        target.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([str(py), "-c", _NLTK_SEED_CODE, str(target),
                            json.dumps(list(packages))],
                           capture_output=True, text=True, timeout=timeout)
        for line in (r.stdout or "").splitlines():
            if line.startswith("UPLIFT_NLTK "):
                facts = json.loads(line[len("UPLIFT_NLTK "):])
                facts["dir"] = str(target)
                if not quiet:
                    print(f"nltk corpora: {facts}")
                return facts
        msg = (r.stderr or r.stdout or "").strip()[-200:]
        facts = {"state": "unresponsive", "detail": msg, "dir": str(target)}
    except Exception as e:                                # noqa: BLE001
        facts = {"state": "error", "detail": f"{type(e).__name__}: {e}",
                 "dir": str(target)}
    logger.warning("uplift bench_env: nltk pre-seed incomplete (%s) — "
                   "IFEval may need the network on its first run", facts)
    return facts


def offline_mode() -> bool:
    """'bench_offline': true in the same config -> HF_HUB_OFFLINE=1 for
    harness children (runs must then find every dataset pre-cached)."""
    from . import paths
    cfg = paths.uplift_store_dir() / "config.json"
    try:
        import json
        if cfg.exists():
            return bool(json.loads(cfg.read_text()).get("bench_offline"))
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# subprocess plumbing used by the accuracy harness engine (REPL-2b part 2)
# ---------------------------------------------------------------------------

def spawn(args: list[str], *, api_key: str, hf_cache: Optional[Path] = None,
          offline: bool = False, cwd: Optional[Path] = None,
          module: Optional[str] = "lm_eval",
          python: Optional[str] = None) -> subprocess.Popen:
    """Start a harness run in its own process group with the key ONLY in
    the environment (never argv, never logged). argv = python -m <module>
    args; module=None runs args directly (tests). python= overrides the
    interpreter (REPL-4: the mteb child uses the mteb-env venv; the key-
    env-only and process-group rules are identical)."""
    py = python or harness_python()
    if py is None:
        raise RuntimeError("bench venv not ready — run: omlx-uplift bench-env create")
    env = dict(os.environ)
    env["OPENAI_API_KEY"] = api_key
    env["PYTHONUNBUFFERED"] = "1"
    # ACC-2c: a harness child must find the NLTK corpora in the uplift dir
    # (see nltk_data_dir) — otherwise lm_eval's ifeval import reaches the
    # network. NLTK_DATA is PREPENDED to nltk's search path by nltk itself,
    # so a corpus the user already has elsewhere stays usable.
    env["NLTK_DATA"] = str(nltk_data_dir())
    if hf_cache:
        env["HF_HOME"] = str(hf_cache)
        env["HF_DATASETS_CACHE"] = str(Path(hf_cache) / "datasets")
    if offline:
        env["HF_HUB_OFFLINE"] = "1"
    argv = [py, *(["-m", module] if module else []), *args]
    return subprocess.Popen(argv,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, cwd=str(cwd) if cwd else None,
                            env=env, start_new_session=True)


def stop(proc: subprocess.Popen, *, grace_s: float = 5.0) -> None:
    """Terminate the whole process group (harness spawns worker threads /
    child fetches; killing only the parent orphans them onto the GPU)."""
    import signal
    import time
    if proc.poll() is not None:
        return
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return
    for sig, wait in ((signal.SIGTERM, grace_s), (signal.SIGKILL, 3.0)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            try:
                os.getpgid(proc.pid)
            except ProcessLookupError:
                return
            time.sleep(0.2)


def scrub_key(text: str, api_key: str) -> str:
    """Redact the literal key from any captured harness output before it
    reaches a log line or an SSE event (belt: the key was env-only)."""
    if api_key and api_key in text:
        return text.replace(api_key, "[REDACTED]")
    return text
