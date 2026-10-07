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
  score labels claim — is dishonest).
- Auth: the harness gets the API key through OPENAI_API_KEY in the
  child env ONLY. It is never placed in argv (ps would leak it) and
  never logged; scrub_key() redacts the literal from any captured
  output before it reaches logs or SSE events.
- Lifecycle: the child runs in its own process group; stop = killpg
  TERM then KILL — the accuracy engine owns this and guarantees no
  orphan survives a server stop (restart-safety, card Verify).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

REQUIREMENTS = Path(__file__).with_name("bench_env_requirements.txt")
VENV_DIRNAME = "bench-env"
MARKER = "uplift-bench-env.json"


def bench_env_dir() -> Path:
    from . import paths
    return paths.uplift_store_dir() / VENV_DIRNAME


def requirements_digest() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()[:16]


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


def status() -> dict:
    venv = bench_env_dir()
    py = venv / "bin" / "python"
    marker = venv / MARKER
    if not py.exists():
        return {"state": "missing", "path": str(venv)}
    digest = requirements_digest()
    if marker.exists():
        import json
        try:
            built = json.loads(marker.read_text()).get("requirements")
        except Exception:
            built = None
    else:
        built = None
    if built != digest:
        return {"state": "stale", "path": str(venv),
                "built_from": built, "wants": digest}
    return {"state": "ready", "path": str(venv), "requirements": digest}


def create(*, reinstall: bool = False, quiet: bool = False) -> dict:
    """Build (or rebuild) the pinned venv. Returns status() at the end."""
    venv = bench_env_dir()
    if status()["state"] == "ready" and not reinstall:
        return status()
    if venv.exists() and reinstall:
        shutil.rmtree(venv)
    venv.parent.mkdir(parents=True, exist_ok=True)
    base = _python_for_venv()
    if not quiet:
        print(f"creating bench venv: {venv} (base: {base})")
    subprocess.run([base, "-m", "venv", str(venv)], check=True)
    py = venv / "bin" / "python"
    if not quiet:
        print("installing pinned harness requirements (first run ~1 min)...")
    subprocess.run([str(py), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
                   check=True)
    subprocess.run([str(py), "-m", "pip", "install", "--quiet",
                    "-r", str(REQUIREMENTS)], check=True)
    # HARD RULE check: torch must not have snuck in as a transitive dep.
    # exit 1 == find_spec found torch (see the sys.exit polarity below).
    probe = subprocess.run(
        [str(py), "-c", "import importlib.util, sys;"
         "sys.exit(1 if importlib.util.find_spec('torch') else 0)"],
        capture_output=True)
    if probe.returncode != 0:
        shutil.rmtree(venv, ignore_errors=True)
        raise RuntimeError("torch appeared in the bench venv — refusing "
                           "(card hard rule: no torch anywhere uplift owns)")
    ver = subprocess.run([str(py), "-c",
                          "import lm_eval; print(lm_eval.__version__)"],
                         capture_output=True, text=True, check=True).stdout.strip()
    import json
    (venv / MARKER).write_text(json.dumps(
        {"requirements": requirements_digest(), "lm_eval": ver,
         "created": int(__import__("time").time())}, indent=1))
    if not quiet:
        print(f"bench venv ready: lm_eval {ver}")
    return status()


def harness_python() -> Optional[str]:
    st = status()
    if st["state"] != "ready":
        return None
    py = Path(st["path"]) / "bin" / "python"
    return str(py)


# ---------------------------------------------------------------------------
# subprocess plumbing used by the accuracy harness engine (REPL-2b part 2)
# ---------------------------------------------------------------------------

def spawn(args: list[str], *, api_key: str, hf_cache: Optional[Path] = None,
          offline: bool = False, cwd: Optional[Path] = None,
          module: Optional[str] = "lm_eval") -> subprocess.Popen:
    """Start a harness run in its own process group with the key ONLY in
    the environment (never argv, never logged). argv = python -m <module>
    args; module=None runs args directly (tests)."""
    py = harness_python()
    if py is None:
        raise RuntimeError("bench venv not ready — run: omlx-uplift bench-env create")
    env = dict(os.environ)
    env["OPENAI_API_KEY"] = api_key
    env["PYTHONUNBUFFERED"] = "1"
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
