"""REPL-4a/4b: native embeddings/rerankers bench (MTEB) — engine tests.

Doctrine matches test_repl2a/test_repl2b: fake seams for everything that
would need the real venv or server, snapshot/restore every touched
sys.modules entry (the order-dependency lesson from REPL-1), and NO
network, NO venv, NO mteb import here. Registry membership of the
curated EMBED_TASKS names was verified once by LIVE PROBE against
mteb 2.24 (recorded on the card); these tests pin the INVARIANTS the
UI and the child runner rely on.
"""
from __future__ import annotations

import asyncio
import json
import sys
import types

import pytest

from omlx_uplift import embed_engine as EE


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch, tmp_path):
    # NO sys.modules snapshot here (the REPL-1 lesson was for fakes that
    # REPLACE real modules): these seams are patched with
    # monkeypatch.setattr on the real modules, which restores itself.
    EE._active = None
    EE._accum = []
    monkeypatch.setattr(EE.paths, "uplift_store_dir", lambda: tmp_path)
    yield
    EE._active = None
    EE._accum = []


def _fake_bench_env(monkeypatch, *, mteb_state="ready"):
    """Patch the REAL bench_env/mteb_env modules (embed_engine's
    `from . import bench_env` resolves the package attribute first, so a
    sys.modules swap would be silently bypassed — the exact bug this
    comment exists to prevent)."""
    calls = {"spawn": [], "stop": []}
    from omlx_uplift import bench_env as real_be, mteb_env as real_me

    class P:
        stdout = iter([])

        def poll(self):
            return 0

    monkeypatch.setattr(real_be, "status",
                        lambda **kw: {"state": mteb_state, "path": "/fake/mteb-env"})
    monkeypatch.setattr(real_be, "spawn",
                        lambda args, **kw: calls["spawn"].append((args, kw)) or P())
    monkeypatch.setattr(real_be, "stop", lambda p, **kw: calls["stop"].append(p))
    monkeypatch.setattr(real_be, "hf_cache_dir",
                        lambda: __import__("pathlib").Path("/tmp/hf"))
    monkeypatch.setattr(real_be, "offline_mode", lambda: False)
    monkeypatch.setattr(real_me, "mteb_status",
                        lambda **kw: {"state": mteb_state, "path": "/fake/mteb-env"})
    return calls


# ---- curated task table invariants ----------------------------------------

def test_task_table_invariants():
    for name, meta in EE.EMBED_TASKS.items():
        assert meta["kind"] in ("embed", "rerank"), name
        assert isinstance(meta["sizes"], int) and meta["sizes"] > 0, name
        assert isinstance(meta["cs"], bool), name
        if meta.get("cap") is not None:
            assert meta["cap"] <= meta["sizes"], name  # cap only trims big sets
    kinds = {m["kind"] for m in EE.EMBED_TASKS.values()}
    assert kinds == {"embed", "rerank"}  # both card sections are represented
    assert any(m["cs"] for m in EE.EMBED_TASKS.values())  # Czech presence (card)


def test_rerank_tasks_are_rerank_kind():
    # the two 4b tasks must NOT be silently embed-typed
    for n in ("HUMECore17InstructionReranking", "HUMENews21InstructionReranking"):
        assert EE.EMBED_TASKS[n]["kind"] == "rerank"


def test_tasks_payload_shape(monkeypatch):
    _fake_bench_env(monkeypatch)
    p = EE.tasks_payload()
    assert set(p) == {"tasks", "env"}
    assert p["env"] == "ready"
    assert p["tasks"]["STS12"]["group"] == "sts"


# ---- validation ------------------------------------------------------------

def test_validate_body_rules():
    m, k, t, lim = EE.validate_body(
        {"model_id": "M", "kind": "embed", "tasks": ["STS12"], "limit": 5})
    assert (m, k, t, lim) == ("M", "embed", ["STS12"], 5)
    with pytest.raises(EE.BadInput):
        EE.validate_body({"model_id": "M", "kind": "nope", "tasks": ["STS12"]})
    with pytest.raises(EE.BadInput):
        EE.validate_body({"model_id": "M", "kind": "embed", "tasks": []})
    with pytest.raises(EE.BadInput):
        EE.validate_body({"model_id": "M", "kind": "embed", "tasks": ["Nope"]})
    # a rerank task asked under kind=embed is a mix the child can't serve
    with pytest.raises(EE.BadInput):
        EE.validate_body({"model_id": "M", "kind": "embed",
                          "tasks": ["HUMECore17InstructionReranking"]})
    with pytest.raises(EE.BadInput):
        EE.validate_body({"model_id": "M", "kind": "embed", "tasks": ["STS12"],
                          "limit": 10**9})


# ---- start gates -----------------------------------------------------------

@pytest.mark.asyncio
async def test_start_requires_env_ready(monkeypatch):
    _fake_bench_env(monkeypatch, mteb_state="missing")
    with pytest.raises(EE.BadInput, match="mteb-env"):
        await EE.start({"model_id": "M", "kind": "embed", "tasks": ["STS12"]},
                       pool=object())


@pytest.mark.asyncio
async def test_start_conflict_one_run_rule(monkeypatch):
    _fake_bench_env(monkeypatch)

    class Pool:
        async def get_engine(self, *a, **k):
            raise RuntimeError("stop here")

    run = EE.EmbedRun("mteb-x", "M", "embed", ["STS12"], 0)
    run.terminal = False
    EE._active = run
    with pytest.raises(EE.Conflict):
        await EE.start({"model_id": "M", "kind": "embed", "tasks": ["STS12"]},
                       pool=Pool())


# ---- child line protocol -----------------------------------------------------

def test_parse_child_lines(monkeypatch):
    _fake_bench_env(monkeypatch)
    res = EE._parse_child_line('UPLIFT_RESULT {"task": "T", "scores": {}}', "K")
    assert res == {"task": "T", "scores": {}}
    ph = EE._parse_child_line('UPLIFT {"phase": "running"}', "K")
    assert ph == {"phase": "running"}
    assert EE._parse_child_line("noise", "K") is None
    assert EE._parse_child_line("UPLIFT_RESULT {broken", "K") is None
    # scrubbing applies BEFORE parse (key must never reach events even in
    # a mangled result line)
    s = EE._parse_child_line('UPLIFT {"phase": "SECRETKEY here"}', "SECRETKEY")
    assert s["phase"] == "[REDACTED] here"


class _FakeProc:
    """Minimal stand-in: iterating stdout yields pre-set lines then EOF;
    poll() reports the exit code only after the reader drained output."""

    def __init__(self, lines, rc=0):
        self._lines = list(lines)
        self._rc = rc
        self.stdout = self

    def __iter__(self):
        while self._lines:
            yield self._lines.pop(0)

    def poll(self):
        return None if self._lines else self._rc


@pytest.mark.asyncio
async def test_run_one_success_row(monkeypatch, tmp_path):
    _fake_bench_env(monkeypatch)
    monkeypatch.setattr(EE, "env_python", lambda: "/fake/py")
    from omlx_uplift import bench_env as be
    seen = {}

    def cap_spawn(args, **kw):
        seen["args"] = args
        seen["kw"] = kw
        return _FakeProc([
            'UPLIFT {"phase": "loading", "task": "BIOSSES"}\n',
            'UPLIFT {"phase": "running", "task": "BIOSSES"}\n',
            'UPLIFT_RESULT {"task": "BIOSSES", "kind": "embed", "model": "M",'
            ' "limit": null, "scores": {"test": {"main_score": 0.9,'
            ' "main_metric": "cosine-spearman", "all": {"x": 1}}}}\n',
        ], rc=0)

    monkeypatch.setattr(be, "spawn", cap_spawn)
    run = EE.EmbedRun("mteb-r1", "M", "embed", ["BIOSSES"], 0)
    await EE._run_one(run, "BIOSSES", 0, 1, pool=None)
    # argv discipline: script path FIRST (module=None children), task and
    # kind flags present, key never in argv (spawn's own env rule)
    assert seen["args"][0].endswith("bench_tasks/mteb_run.py")
    assert "--kind" in seen["args"] and "embed" in seen["args"]
    assert not any("OPENAI" in a or "api" in a.lower() for a in seen["args"])
    assert seen["kw"].get("module") is None
    assert seen["kw"].get("python") == "/fake/py"
    assert len(run.results) == 1
    row = run.results[0]
    assert row["engine"] == "mteb" and row["task"] == "BIOSSES"
    assert row["scores"]["test"]["main_score"] == 0.9
    # write-through persistence
    acc = json.loads((tmp_path / "bench-embed" / "accumulated.json").read_text())
    assert acc[0]["task"] == "BIOSSES"
    types_ = [e["type"] for e in run.events]
    assert "progress" in types_ and "result" in types_


@pytest.mark.asyncio
async def test_run_one_child_failure_raises(monkeypatch):
    _fake_bench_env(monkeypatch)
    monkeypatch.setattr(EE, "env_python", lambda: "/fake/py")
    from omlx_uplift import bench_env as be
    monkeypatch.setattr(be, "spawn", lambda args, **kw: _FakeProc([], rc=3))
    run = EE.EmbedRun("mteb-f", "M", "embed", ["STS12"], 0)
    with pytest.raises(RuntimeError, match="rc=3"):
        await EE._run_one(run, "STS12", 0, 1, pool=None)


@pytest.mark.asyncio
async def test_run_one_cancellation_short_circuits(monkeypatch):
    # a cancelled run must NOT append a result row even if the child
    # somehow emitted one
    _fake_bench_env(monkeypatch)
    monkeypatch.setattr(EE, "env_python", lambda: "/fake/py")
    from omlx_uplift import bench_env as be
    monkeypatch.setattr(be, "spawn", lambda args, **kw: _FakeProc([
        'UPLIFT_RESULT {"task": "STS12", "kind": "embed", "model": "M",'
        ' "limit": null, "scores": {}}\n'], rc=0))
    run = EE.EmbedRun("mteb-cn", "M", "embed", ["STS12"], 0)
    run.cancelled = True
    await EE._run_one(run, "STS12", 0, 1, pool=None)
    assert run.results == []


# ---- accumulated + reset ---------------------------------------------------

def test_accumulated_roundtrip(monkeypatch):
    _fake_bench_env(monkeypatch)
    EE.get_accumulated().append({"task": "STS12", "scores": {}})
    EE._save_accum()
    EE._accum = None
    assert EE.get_accumulated()[0]["task"] == "STS12"
    out = EE.results_payload()
    assert out["results"][0]["task"] == "STS12"
    EE.reset_results()
    assert EE.results_payload()["results"] == []


def test_nan_metrics_sanitized(monkeypatch, tmp_path):
    # mteb emits NaN for degenerate metrics under --limit; Python's
    # json DUMP writes the NaN literal (load accepts it) but FastAPI's
    # strict renderer 500s. The store roundtrip must come back clean.
    import json as _json
    _fake_bench_env(monkeypatch)
    raw = tmp_path / "bench-embed"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "accumulated.json").write_text(
        '[{"task": "X", "scores": {"test": {"main_score": NaN}}}]')
    EE._accum = None  # force re-read from the (poisoned) store
    rows = EE.get_accumulated()
    assert rows[0]["scores"]["test"]["main_score"] is None
    _json.dumps(EE.results_payload(), allow_nan=False)  # must not raise


@pytest.mark.asyncio
async def test_cancel_terminal_raises_notrunning():
    run = EE.EmbedRun("mteb-c", "M", "embed", ["STS12"], 0)
    run.terminal = True
    with pytest.raises(EE.NotRunning):
        await EE.cancel(run)


@pytest.mark.asyncio
async def test_event_stream_replays_then_terminates():
    run = EE.EmbedRun("mteb-s", "M", "embed", ["STS12"], 0)
    await run.send({"type": "progress", "phase": "task", "task": "STS12",
                    "current": 0, "total": 1, "message": "STS12 (1/1)"})
    run.terminal = True
    async with run.cond:
        run.cond.notify_all()
    chunks = [c async for c in EE.event_stream(run, keepalive_s=0.2)]
    assert any('"type": "progress"' in c for c in chunks)


# ---- runner script protocol (static, no mteb import) ----------------------

def test_child_runner_requires_key_and_root():
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "omlx_uplift" / "bench_tasks" / "mteb_run.py")
    text = src.read_text()
    assert "--root" in text and "OPENAI_API_KEY" in text
    assert "_verify_server" in text  # NAT-6 S3 auth fix is productized
    assert "UPLIFT_RESULT" in text
