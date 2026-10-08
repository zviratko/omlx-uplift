"""REPL-4 mteb_env tests — status/create parameterize bench_env correctly."""
from __future__ import annotations

import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

from omlx_uplift import bench_env, mteb_env


@pytest.fixture(autouse=True)
def tmp_store(monkeypatch, tmp_path):
    monkeypatch.setattr(bench_env, "bench_env_dir",
                        lambda *a, **k: tmp_path / (a[0] if a else "bench-env"))
    return tmp_path


def test_status_missing_then_stale_then_ready(tmp_store, monkeypatch):
    st = mteb_env.mteb_status()
    assert st["state"] == "missing"
    venv = tmp_store / "mteb-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("")
    st = mteb_env.mteb_status()
    assert st["state"] == "stale"  # marker missing
    (venv / mteb_env.MTEB_MARKER).write_text(json.dumps(
        {"requirements": bench_env.requirements_digest(mteb_env.MTEB_REQUIREMENTS),
         "mteb": "2.24.0"}))
    assert mteb_env.mteb_status()["state"] == "ready"


def test_requirements_file_ships_pinned_mteb():
    text = mteb_env.MTEB_REQUIREMENTS.read_text()
    assert "mteb==" in text
    assert "torch==" in text  # decision: this env DOES carry torch
    # every line pinned: name==version
    for line in text.splitlines():
        if line.strip():
            assert "==" in line, f"unpinned line: {line}"


def test_create_uses_mteb_names(tmp_store, monkeypatch):
    calls = []

    def fake_run(cmd, *a, **k):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(bench_env, "_python_for_venv", lambda: sys.executable)
    with pytest.raises(Exception):
        # fake run never creates bin/python, so status stays missing and
        # create's final status() reports missing — the point is WHICH
        # paths the venv/pip invocations touched
        mteb_env.mteb_create(quiet=True)
    joined = [" ".join(c) if isinstance(c, list) else str(c) for c in calls]
    assert any("mteb-env" in j for j in joined)
    assert any("mteb_env_requirements.txt" in j for j in joined)


def test_cli_mteb_env_status_json(tmp_store, monkeypatch, capsys):
    """`omlx-uplift mteb-env status --json` — missing env exits 1 (same
    contract as bench-env; the embed start route's error text points here)."""
    from omlx_uplift import cli
    old = sys.argv
    try:
        sys.argv = ["omlx-uplift", "mteb-env", "status", "--json"]
        rc = cli.main()
    finally:
        sys.argv = old
    assert rc == 1
    out = capsys.readouterr().out.strip()
    assert json.loads(out)["state"] == "missing"
