"""REPL-4a/4b: native embeddings/rerankers bench (MTEB engine, subprocess).

Reuse doctrine (same shape the harness engine proved in REPL-2b):
- The EVAL is delegated: mteb runs as a subprocess of the pinned
  mteb-env venv (separate from bench-env by the recorded REPL-4
  decision — mteb hard-requires torch; bench-env stays torch-free and
  the kegs never gain a dependency). Runner script: bench_tasks/
  mteb_run.py, spawned with OPENAI_API_KEY in env only (never argv).
- omlx scores through the PUBLIC serving path (/v1/embeddings,
  /v1/rerank) as an ordinary client — the wrapper talks to the server
  root; NAT-6 S3 pinned both the endpoint_url=ROOT convention and the
  auth-patched _verify_server (now productized in the runner).
- Lease: classic get_engine(_lease=True) like the harness path, so the
  embedding engine cannot be unloaded mid-run; released (and verified
  released) when the child exits.
- Progress: per TASK granularity is the real granularity mteb gives us
  over the API (NAT-2 residual finding — no per-question SSE exists);
  within a task the child's phase lines stream as progress messages.
  Nothing is fabricated.
- Upload: NONE for this class (card: leaderboard server has no table;
  finding, don't invent an endpoint). Results persist only to the
  uplift store (accumulated JSON, same pattern as accuracy).
- Task set: curated laptop-sized shortlist (REPL-4 card; probe 2026-10-08:
  mteb 2.24 has 1492 tasks — full MTEB is hours on this box). Sizes are
  mteb n_samples at curation time; the drift test re-checks membership
  against the live venv's registry, not against these numbers.

Cancellation = killpg of the child group (bench_env.stop). Restart
safety inherits the harness lesson: the parent NEVER blocks a default-
executor thread on proc.wait — cooperative poll loop + atexit killset.
"""
from __future__ import annotations

import asyncio
import atexit
import json
import logging
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from . import paths

logger = logging.getLogger("omlx.uplift.embed")

KINDS = ("embed", "rerank")

# ---- curated shortlist (see module docstring; card 4a/4b) -----------------
# key = mteb task name. 'sizes' = mteb n_samples at curation (UI shows it;
# run accepts a sample limit for the big ones). 'cs'=Czech-language task.
EMBED_TASKS: dict[str, dict[str, Any]] = {
    "STS12":       {"kind": "embed", "group": "sts",   "sizes": 3108,   "cs": False},
    "BIOSSES":     {"kind": "embed", "group": "sts",   "sizes": 100,    "cs": False},
    "NFCorpus":    {"kind": "embed", "group": "retrieval", "sizes": 3956, "cs": False},
    "SciFact":     {"kind": "embed", "group": "retrieval", "sizes": 5483, "cs": False},
    "ToxicConversationsClassification.v2": {"kind": "embed", "group": "class", "sizes": 2048, "cs": False},
    "RTE3":        {"kind": "embed", "group": "pair",  "sizes": 1923,   "cs": False},
    "CTKFactsNLI": {"kind": "embed", "group": "pair",  "sizes": 680,    "cs": True},
    "CzechSoMeSentimentClassification.v2": {"kind": "embed", "group": "class", "sizes": 932, "cs": True},
    "WikipediaSpecialtiesInChemistryClustering": {"kind": "embed", "group": "cluster", "sizes": 617, "cs": False},
    "Tatoeba":     {"kind": "embed", "group": "bitext", "sizes": 88877, "cs": True, "cap": 5000},
    # rerank (4b) — smallest instruction-reranking sets per probe
    "HUMECore17InstructionReranking": {"kind": "rerank", "group": "rerank", "sizes": 160, "cs": False},
    "HUMENews21InstructionReranking": {"kind": "rerank", "group": "rerank", "sizes": 248, "cs": False},
}


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


class BadInput(Exception):
    pass


class NotRunning(Exception):
    pass


class EmbedRun:
    """One benchmark run: a task list executed serially in child procs."""

    def __init__(self, run_id: str, model_id: str, kind: str,
                 tasks: list[str], limit: int):
        self.run_id = run_id
        self.model_id = model_id
        self.kind = kind
        self.tasks = tasks
        self.limit = limit
        self.status = "running"          # running|completed|cancelled|failed
        self.phase = "starting"
        self.events: list[dict] = []
        self.results: list[dict] = []
        self.error_message: Optional[str] = None
        self.terminal = False
        self.cond = asyncio.Condition()
        self.task: Optional[asyncio.Task] = None
        self.proc: Optional[subprocess.Popen] = None
        self.cancelled = False
        self.started_at = time.time()

    async def send(self, ev: dict) -> None:
        async with self.cond:
            self.events.append(ev)
            self.cond.notify_all()


_active: Optional[EmbedRun] = None
_live_procs: set[subprocess.Popen] = set()


def _kill_live() -> None:
    for p in list(_live_procs):
        try:
            from . import bench_env
            bench_env.stop(p, grace_s=1.0)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


_atexit_registered = False


def _ensure_atexit() -> None:
    global _atexit_registered
    if not _atexit_registered:
        atexit.register(_kill_live)
        _atexit_registered = True


def active_run() -> Optional[EmbedRun]:
    return _active if (_active and not _active.terminal) else None


def env_python() -> Optional[str]:
    st = _mteb_env().mteb_status()
    if st["state"] != "ready":
        return None
    return str(Path(st["path"]) / "bin" / "python")


def _bench_env():
    from . import bench_env
    return bench_env


def _mteb_env():
    from . import mteb_env
    return mteb_env


def tasks_payload() -> dict:
    return {
        "tasks": {k: {"kind": v["kind"], "group": v["group"],
                      "sizes": v["sizes"], "cs": v["cs"],
                      "cap": v.get("cap")}
                  for k, v in EMBED_TASKS.items()},
        "env": _mteb_env().mteb_status()["state"],
    }


def validate_body(body: dict) -> tuple[str, str, list[str], int]:
    model_id = str(body.get("model_id") or "").strip()
    kind = str(body.get("kind") or "").strip()
    if kind not in KINDS:
        raise BadInput(f"kind must be one of {KINDS}")
    tasks = body.get("tasks") or []
    if not isinstance(tasks, list) or not tasks:
        raise BadInput("tasks: non-empty list required")
    want = "embed" if kind == "embed" else "rerank"
    for t in tasks:
        meta = EMBED_TASKS.get(str(t))
        if meta is None:
            raise BadInput(f"unknown task: {t}")
        if meta["kind"] != want:
            raise BadInput(f"task {t} is a {meta['kind']} task, not {kind}")
    limit = int(body.get("limit") or 0)
    if limit < 0 or limit > 100_000:
        raise BadInput("limit must be 0 (full) .. 100000")
    return model_id, kind, [str(t) for t in tasks], limit


async def start(body: dict, pool: Any) -> dict:
    global _active
    if active_run() is not None:
        raise Conflict("an embeddings benchmark is already running")
    if env_python() is None:
        raise BadInput("mteb-env is not ready — run: omlx-uplift mteb-env create")
    model_id, kind, tasks, limit = validate_body(body)
    run = EmbedRun(f"mteb-{uuid.uuid4().hex[:12]}", model_id, kind,
                   tasks, limit)
    _ensure_atexit()
    _active = run
    run.task = asyncio.create_task(_runner(run, pool))
    return {"run_id": run.run_id, "status": "running",
            "model_id": model_id, "kind": kind, "tasks": tasks}


def _api_key() -> str:
    import json as _json
    cfg = Path.home() / ".omlx" / "settings.json"
    return _json.loads(cfg.read_text())["auth"]["api_key"]


def _base_root() -> str:
    """Server root for the mteb wrapper (endpoint_url convention, S3):
    uplift runs inside the same omlx process; ask it for its bind port."""
    try:
        from omlx import server as _srv
        st = getattr(_srv, "_server_state", None)
        port = getattr(st, "port", None) if st else None
        if port:
            return f"http://127.0.0.1:{port}"
    except Exception:
        pass
    return "http://127.0.0.1:8001"


def _parse_child_line(line: str, key: str) -> Optional[dict]:
    from .bench_env import scrub_key
    line = scrub_key(line.rstrip("\n"), key)
    if line.startswith("UPLIFT_RESULT "):
        try:
            return json.loads(line[len("UPLIFT_RESULT "):])
        except json.JSONDecodeError:
            return None
    if line.startswith("UPLIFT "):
        try:
            return json.loads(line[len("UPLIFT "):])
        except json.JSONDecodeError:
            return None
    return None


async def _run_one(run: EmbedRun, task: str, i: int, n: int, pool: Any) -> None:
    from . import bench_env
    py = env_python()
    if py is None:
        raise RuntimeError("mteb-env disappeared mid-run")
    key = _api_key()
    runner = Path(__file__).with_name("bench_tasks") / "mteb_run.py"
    outdir = results_root() / run.run_id / task
    # module=None: bench_env.spawn places args right after the
    # interpreter, so the script path MUST be args[0] (pinned by test —
    # a usage-error rc=2 in 50 ms was this exact bug)
    args = [str(runner), "--root", _base_root(), "--model", run.model_id,
            "--task", task, "--kind", EMBED_TASKS[task]["kind"],
            "--outdir", str(outdir)]
    if run.limit:
        args += ["--limit", str(run.limit)]
    await run.send({"type": "progress", "phase": "task", "task": task,
                    "current": i, "total": n,
                    "message": f"{task} ({i + 1}/{n})"})
    # dedicated reader thread + queue — the harness engine's proven
    # pattern. (wait_for(to_thread(readline), 0.5) DROPS lines: when the
    # timeout fires the abandoned thread still consumes the next line
    # into a dead future — first live BIOSSES run exited rc=0 with no
    # result visible for exactly that reason.)
    proc = bench_env.spawn(args, api_key=key,
                           hf_cache=bench_env.hf_cache_dir(),
                           offline=bench_env.offline_mode(),
                           module=None, python=py, cwd=runner.parent)
    run.proc = proc
    _live_procs.add(proc)
    payload: Optional[dict] = None
    try:
        loop = asyncio.get_running_loop()
        lines: asyncio.Queue = asyncio.Queue()

        def _reader() -> None:
            try:
                for raw in proc.stdout:
                    lines.put_nowait(raw)
            except Exception:
                pass
            finally:
                lines.put_nowait(None)

        reader = loop.run_in_executor(None, _reader)
        while True:
            line = await lines.get()
            if line is None:
                break
            parsed = _parse_child_line(line, key)
            if parsed is None:
                continue
            if "task" in parsed and "scores" in parsed:
                payload = parsed
            else:
                await run.send({"type": "progress", "phase": "task",
                                "task": task, "current": i, "total": n,
                                "message": parsed.get("phase", "")})
        # poll, never executor-blocked wait: cancellation must unwind
        while proc.poll() is None:
            await asyncio.sleep(0.5)
            if run.cancelled:
                break
        await reader
        rc = proc.poll()
    finally:
        _live_procs.discard(proc)
        run.proc = None
    if run.cancelled:
        return
    if payload is None:
        raise RuntimeError(f"mteb child failed rc={rc} task={task}")
    row = _finite({"task": task, "kind": run.kind, "model_id": run.model_id,
                   "scores": payload.get("scores"), "limit": payload.get("limit"),
                   "engine": "mteb", "ts": int(time.time())})
    run.results.append(row)
    get_accumulated().append(row)
    _save_accum()  # write-through: a crash mid-run keeps finished tasks
    await run.send({"type": "result", "data": row})


async def _runner(run: EmbedRun, pool: Any) -> None:
    leased = False
    try:
        # lease the engine through classic's own pool call — same seam
        # the harness dispatcher uses (settings saves / TTL eviction
        # cannot unload the model mid-run)
        await pool.get_engine(run.model_id, force_lm=False, _lease=True)
        leased = True
        n = len(run.tasks)
        for i, task in enumerate(run.tasks):
            if run.cancelled:
                break
            await _run_one(run, task, i, n, pool)
        if run.cancelled:
            run.status = "cancelled"
            run.error_message = "Benchmark cancelled by user"
            await run.send({"type": "error", "message": run.error_message})
        else:
            run.status = "completed"
            run.phase = "completed"
            await run.send({"type": "done", "summary": {
                "model_id": run.model_id, "kind": run.kind,
                "tasks": len(run.results)}})
    except asyncio.CancelledError:
        run.status = "cancelled"
        run.error_message = "Benchmark cancelled by user"
        await run.send({"type": "error", "message": run.error_message})
    except Exception as e:
        run.status = "failed"
        run.error_message = str(e)
        logger.warning(f"embed run {run.run_id} failed: {e}")
        await run.send({"type": "error", "message": run.error_message})
    finally:
        if leased:
            try:
                rel = pool.release_engine(run.model_id)
                if asyncio.iscoroutine(rel):
                    await rel
            except Exception as e:
                logger.warning(f"embed release failed: {e}")
        run.terminal = True
        async with run.cond:
            run.cond.notify_all()


async def cancel(run: EmbedRun) -> dict:
    if run.terminal:
        raise NotRunning(run.status)
    run.cancelled = True
    if run.proc is not None:
        from . import bench_env
        bench_env.stop(run.proc)
    if run.task and not run.task.done():
        run.task.cancel()
    return {"status": "cancelled", "run_id": run.run_id}


def get(run_id: str) -> Optional[EmbedRun]:
    return _active if (_active and _active.run_id == run_id) else None


# ---- accumulated results + SSE --------------------------------------------

def results_root() -> Path:
    return paths.uplift_store_dir() / "bench-embed"


def _acc_file() -> Path:
    return results_root() / "accumulated.json"


_accum: Optional[list[dict]] = None


def _finite(v):
    """Parent-side defense (the child sanitizes too): NaN/Inf from a
    mteb metric would 500 the JSON route — map them to None."""
    import math
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


def get_accumulated() -> list[dict]:
    global _accum
    if _accum is None:
        try:
            _accum = _finite(json.loads(_acc_file().read_text()))
            if not isinstance(_accum, list):
                _accum = []
        except Exception:
            _accum = []
    return _accum


def _save_accum() -> None:
    f = _acc_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(get_accumulated(), indent=1))


def results_payload() -> dict:
    run = active_run()
    out = {"results": get_accumulated()}
    if run is not None:
        out["active"] = {"run_id": run.run_id, "status": run.status,
                         "model_id": run.model_id, "kind": run.kind,
                         "tasks": run.tasks, "done": len(run.results)}
    return out


def reset_results() -> dict:
    global _accum
    _accum = []
    _save_accum()
    return {"status": "reset"}


async def event_stream(run: EmbedRun, *, keepalive_s: float = 60.0
                       ) -> AsyncIterator[str]:
    seen = 0
    try:
        while True:
            async with run.cond:
                while seen >= len(run.events) and not run.terminal:
                    try:
                        async with asyncio.timeout(keepalive_s):
                            await run.cond.wait()
                    except TimeoutError:
                        break
                new = list(run.events[seen:])
                seen = len(run.events)
                done = run.terminal
            for ev in new:
                yield f"data: {json.dumps(ev, default=str)}\n\n"
            if not new and not done:
                yield ": keepalive\n\n"
            if done:
                break
    except asyncio.CancelledError:
        pass


# persist results whenever a run reaches terminal state — cheap hook from
# the router's stream generator end (no background poller)
def persist_done() -> None:
    _save_accum()
