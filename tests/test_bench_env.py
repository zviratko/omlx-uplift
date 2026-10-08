"""REPL-2b stage-1 tests: bench_env helper + CLI surface.

No venv build here (that's ~1 min of network + disk; the live drill does
it once). These pin the SAFETY rules the card sets:

- the shipped requirements file parses, pins lm_eval, and contains NO
  torch line (hard rule; the builder additionally probes the built venv)
- status() state machine: missing -> ready -> stale, via the marker
  digest, in a temp uplift store
- spawn(): the API key appears ONLY in the child env, never in argv;
  start_new_session set (killpg works); HF_HOME/offline honored
- stop(): process group dies, no orphan from a child shell loop
- scrub_key(): literal key redacted from captured output
- CLI: bench-env dispatches, unknown actions rejected, status --json
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from omlx_uplift import bench_env


REQ = Path(bench_env.__file__).with_name("bench_env_requirements.txt")


def test_requirements_file_pins_and_is_torch_free():
    text = REQ.read_text()
    pins = {}
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        name, _, ver = ln.partition("==")
        assert ver, f"unpinned line in requirements: {ln!r}"
        pins[name.lower().replace("_", "-")] = ver
    assert pins.get("lm-eval") == "0.4.13", "harness pin drifted from NAT-2"
    assert not any(n.startswith("torch") for n in pins), "torch in requirements"
    # datasets/evaluate must be exact pins too (reproducibility contract)
    assert pins["datasets"] and pins["evaluate"]


@pytest.fixture()
def tmp_store(monkeypatch, tmp_path):
    monkeypatch.setattr(bench_env, "bench_env_dir", lambda *a, **k: tmp_path / "bench-env")
    return tmp_path


def test_status_missing_ready_stale(tmp_store, monkeypatch):
    assert bench_env.status()["state"] == "missing"
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("#!/bin/sh\n")
    # no marker -> stale (cannot prove which requirements it holds)
    assert bench_env.status()["state"] == "stale"
    (venv / bench_env.MARKER).write_text(json.dumps(
        {"requirements": bench_env.requirements_digest(), "lm_eval": "0.4.13"}))
    st = bench_env.status()
    assert st["state"] == "ready"
    # touch the requirements digest -> stale again
    monkeypatch.setattr(bench_env, "requirements_digest", lambda *a, **k: "deadbeef")
    st = bench_env.status()
    assert st["state"] == "stale" and st["built_from"] != "deadbeef"


def test_spawn_key_never_in_argv(tmp_store, monkeypatch):
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    py = venv / "bin" / "python"
    py.write_text("")  # existence check passes; real exec is sys.executable below
    monkeypatch.setattr(bench_env, "harness_python", lambda: sys.executable)
    # a command that prints its own argv+env marker and exits
    proc = bench_env.spawn(["-c", "print('SPAWNED')"],
                           api_key="SEKRET-KEY",
                           hf_cache=tmp_store / "hfcache", offline=True,
                           module=None)
    out, _ = proc.communicate(timeout=20)
    assert out.strip() == "SPAWNED"
    # argv carried only -c and the script — never the key
    # (Popen rewrites args with the python path; check the full record)
    cmdline = " ".join(proc.args)
    assert "SEKRET-KEY" not in cmdline
    # os.getpgrp: start_new_session -> child pgid differed from ours
    # (verify via /bin/ps-free method: re-spawn and print getpgid)
    proc = bench_env.spawn(["-c", "import os;print(os.getpgid(0)==os.getpid(),"
                                  "os.environ['OPENAI_API_KEY'],os.environ.get('HF_HUB_OFFLINE'))"],
                           api_key="SEKRET-KEY",
                           hf_cache=tmp_store / "hfcache", offline=True,
                           module=None)
    out, _ = proc.communicate(timeout=20)
    own_pg, key_in_env, offline = out.split()
    assert own_pg == "True", "child must lead its own process group (killpg)"
    assert key_in_env == "SEKRET-KEY" and offline == "1"


def test_stop_kills_whole_group(tmp_store, monkeypatch):
    monkeypatch.setattr(bench_env, "harness_python", lambda: sys.executable)
    proc = bench_env.spawn(["-c", "import time,subprocess;"
                             "p=subprocess.Popen(['sleep','31']);"
                             "print(p.pid, flush=True);time.sleep(31)"],
                           api_key="k", module=None)
    line = proc.stdout.readline().strip()
    grandchild = int(line)
    bench_env.stop(proc, grace_s=2.0)
    # stop()'s early-return paths (already-exited / pgid gone) do not
    # reap; give the parent a bounded window to observe the death — the
    # contract is 'dead within the grace', not 'reaped atomically'.
    _dl = __import__("time").monotonic() + 3.0
    while proc.poll() is None and __import__("time").monotonic() < _dl:
        __import__("time").sleep(0.05)
    assert proc.poll() is not None and proc.returncode is not None
    # grandchild shared the group -> killpg took it too; os.kill on a dead
    # (and launchd-reaped) pid must raise
    deadline = __import__("time").monotonic() + 3.0
    while __import__("time").monotonic() < deadline:
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            break
        __import__("time").sleep(0.1)
    else:
        pytest.fail(f"orphaned grandchild {grandchild} survived stop()")


def test_scrub_key():
    assert bench_env.scrub_key("fail https://u?key=ABC123 x", "ABC123") \
        == "fail https://u?key=[REDACTED] x"
    assert bench_env.scrub_key("clean", "ABC123") == "clean"
    assert bench_env.scrub_key("no key here", "") == "no key here"


def test_cli_dispatch_and_json(tmp_store, monkeypatch, capsys):
    from omlx_uplift import cli
    monkeypatch.setattr(bench_env, "bench_env_dir", lambda *a, **k: tmp_store / "bench-env")
    # main() reads sys.argv; drive it directly
    old = sys.argv
    try:
        sys.argv = ["omlx-uplift", "bench-env", "status", "--json"]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cli.main()
    finally:
        sys.argv = old
    assert rc == 1  # missing -> nonzero exit (CI gate friendly)
    assert json.loads(buf.getvalue())["state"] == "missing"
    old = sys.argv
    try:
        sys.argv = ["omlx-uplift", "bench-env", "bogus"]
        with pytest.raises(SystemExit):
            cli.main()
    finally:
        sys.argv = old
