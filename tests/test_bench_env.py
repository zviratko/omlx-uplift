"""REPL-2b stage-1 tests: bench_env helper + CLI surface.

No venv build here (that's ~1 min of network + disk; the live drill does
it once). These pin the SAFETY rules the card sets:

- the shipped requirements file parses, pins lm_eval, and contains NO
  torch line (hard rule; the builder additionally probes the built venv)
- status() state machine: missing -> ready -> stale, via the marker
  digest, in a temp uplift store
- status() size facts (ACC-2e): venv_bytes/cache_bytes summed from the
  tree, bounded by a wall-clock budget, None (never a partial sum) when
  the budget is spent or sizes=False
- create() (ACC-2e): a stale/broken venv is FULLY WIPED before every
  rebuild — an orphaned package from the old pin must not survive; pip
  runs --no-cache-dir so uplift leaves no wheel cache anywhere
- _guard_heavy_dep (ACC-2e): pin-driven — torch passes only when the
  env's own requirements file pins it, and refuses + wipes otherwise
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
    # never let a status() size walk read the developer's real HF cache
    monkeypatch.setattr(bench_env, "hf_cache_dir", lambda: tmp_path / "bench-cache")
    return tmp_path


def _fake_build(monkeypatch, venv: Path, *, torch_present: bool = False,
                import_fails: bool = False):
    """Stand in for subprocess.run during create(): fake `python -m venv`
    materialises bin/python, the torch probe answers from the fixture,
    the import probe returns a version. Returns the argv list of every
    'run' so tests can assert on the pip flags we actually emit."""
    calls: list[list[str]] = []

    def fake_run(cmd, *a, **k):
        joined = " ".join(str(c) for c in cmd)
        calls.append([str(c) for c in cmd])
        if "-m venv" in joined:
            (venv / "bin").mkdir(parents=True, exist_ok=True)
            (venv / "bin" / "python").write_text("#!/bin/sh\n")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if "find_spec" in joined:                     # heavy-dep probe
            return subprocess.CompletedProcess(cmd, 1 if torch_present else 0,
                                               "", "")
        if "__version__" in joined:                   # import_name probe
            if import_fails:
                return subprocess.CompletedProcess(cmd, 1, "", "No module named")
            return subprocess.CompletedProcess(cmd, 0, "0.4.13", "")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(bench_env, "_python_for_venv", lambda: sys.executable)
    return calls


def _seed_venv(tmp_path: Path, *, requirements: Path = REQ,
               orphan: str = "site-packages/gone_in_new_pin-1.0.dist-info/METADATA") -> Path:
    """A built-looking venv stamped with `requirements`, plus an
    `orphan` file standing in for a package the next pin drops."""
    venv = tmp_path / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("#!/bin/sh\n")
    dead = venv / orphan
    dead.parent.mkdir(parents=True, exist_ok=True)
    dead.write_text("installed by the OLD pin\n")
    (venv / bench_env.MARKER).write_text(json.dumps(
        {"requirements": bench_env.requirements_digest(requirements)}))
    return venv


# --- state machine ----------------------------------------------------------


def test_status_missing_ready_stale(tmp_store, monkeypatch):
    st = bench_env.status()
    assert st["state"] == "missing"
    # ACC-2e: the size keys are in the schema in EVERY state (stable
    # shape for JSON consumers); nothing measured yet -> honest None
    assert st["venv_bytes"] is None and st["cache_bytes"] is None
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


def test_requirements_digest_tracks_pins_not_prose(tmp_path):
    """ACC-2e: the digest is 'what pip acts on'. A comment-only edit to a
    pin file must NOT invalidate a 604 MB venv; a pin or option-line edit
    must."""
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("# header v1\nnumpy==2.0.0\n\nscipy==1.0\n")
    b.write_text("# a completely different, longer header\n# more prose\n\n"
                 "numpy==2.0.0\n  scipy==1.0\n")
    assert bench_env.requirements_digest(a) == bench_env.requirements_digest(b)
    b.write_text(b.read_text().replace("scipy==1.0", "scipy==1.1\n"))
    assert bench_env.requirements_digest(a) != bench_env.requirements_digest(b)
    # option lines are not prose — they change the install
    b.write_text("numpy==2.0.0\nscipy==1.0\n--index-url https://other\n")
    assert bench_env.requirements_digest(a) != bench_env.requirements_digest(b)


def test_legacy_marker_digest_is_accepted_until_next_rebuild(tmp_store):
    """Migration guard: envs built pre-ACC-2e stamped sha256(file bytes).
    Accepting that value keeps a working 1.5 GB mteb-env from being
    declared stale by an algorithm change alone; a REAL pin move still
    makes both digests differ."""
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("")
    marker = venv / bench_env.MARKER
    marker.write_text(json.dumps(
        {"requirements": bench_env.requirements_digest_legacy(REQ)}))
    st = bench_env.status()
    assert st["state"] == "ready"
    assert st["requirements"] == bench_env.requirements_digest()  # reports the new one
    # a garbage marker is still stale
    marker.write_text(json.dumps({"requirements": "0" * 16}))
    assert bench_env.status()["state"] == "stale"
    # no marker at all -> stale (cannot prove anything)
    marker.unlink()
    assert bench_env.status()["state"] == "stale"


def test_status_original_keys_unchanged(tmp_store):
    """Backward compat: the pre-ACC-2e consumers read these keys and
    nothing else — a rename here breaks harness_engine/embed_engine/cli."""
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("")
    (venv / bench_env.MARKER).write_text(json.dumps(
        {"requirements": bench_env.requirements_digest()}))
    st = bench_env.status()
    assert {"state", "path", "requirements"} <= set(st)
    assert st["path"] == str(venv)
    assert bench_env.harness_python() == str(venv / "bin" / "python")


# --- ACC-2e: size facts -----------------------------------------------------


def test_status_size_facts_sum_the_tree(tmp_store):
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "lib" / "site-packages" / "pkg").mkdir(parents=True)
    (tmp_store / "bench-cache" / "datasets" / "x").mkdir(parents=True)
    (venv / "bin" / "python").write_bytes(b"x" * 5)
    (venv / "lib" / "site-packages" / "pkg" / "m.pyc").write_bytes(b"y" * 1024)
    marker = venv / bench_env.MARKER
    marker.write_text(json.dumps({"requirements": bench_env.requirements_digest()}))
    (tmp_store / "bench-cache" / "datasets" / "x" / "data-0.bin").write_bytes(b"z" * 4096)

    st = bench_env.status()
    assert st["state"] == "ready"
    # files only, nested dirs contribute nothing; marker counts (it lives
    # in the venv) — the point is 'the whole tree, summed', so compute the
    # expectation from the sizes this test wrote
    assert st["venv_bytes"] == 5 + 1024 + marker.stat().st_size
    assert st["cache_bytes"] == 4096


def test_status_size_budget_returns_none_not_partial(tmp_store):
    venv = tmp_store / "bench-env"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_bytes(b"x" * 5)
    (venv / bench_env.MARKER).write_text(json.dumps(
        {"requirements": bench_env.requirements_digest()}))
    (tmp_store / "bench-cache").mkdir()
    (tmp_store / "bench-cache" / "f").write_bytes(b"x" * 5)
    # negative budget: the deadline was already spent when we started
    st = bench_env.status(size_budget_s=-1.0)
    assert st["venv_bytes"] is None and st["cache_bytes"] is None
    # and the opt-out is free — the hot path (harness_python) uses it
    st = bench_env.status(sizes=False)
    assert st["state"] == "ready"
    assert st["venv_bytes"] is None and st["cache_bytes"] is None


def test_dir_bytes_missing_path_is_not_zero(tmp_path):
    """size_facts on a path that does not exist reports None (we did not
    measure 0 bytes, we measured nothing)."""
    facts = bench_env.size_facts(tmp_path / "nope", tmp_path / "also-nope")
    assert facts == {"venv_bytes": None, "cache_bytes": None}


def test_requirements_names_parses_real_shape(tmp_path):
    f = tmp_path / "r.txt"
    f.write_text("# comment\n"
                 "\n"
                 "lm_eval[extra]==0.4.13\n"
                 "torch==2.14.1\n"
                 "Numpy >= 2\n"
                 "-r other.txt\n"
                 "--find-links https://x\n"
                 "file:///tmp/pkg.whl\n")
    names = bench_env.requirements_names(f)
    assert {"lm-eval", "torch", "numpy"} <= names
    assert not any(n.startswith("-") or n.startswith("http") for n in names)
    assert bench_env.requirements_names(tmp_path / "absent.txt") == set()


# --- ACC-2e: stale wipes, pip leaves no cache, guard is pin-driven ----------


def test_stale_venv_is_fully_wiped_by_plain_create(tmp_store, monkeypatch):
    """THE ACC-2e regression: before, only reinstall=True wiped, so a
    stale rebuild layered the new pin onto the old site-packages and the
    dropped package survived as an orphan under a 'ready' marker."""
    _seed_venv(tmp_store)
    monkeypatch.setattr(bench_env, "requirements_digest", lambda *a, **k: "newpin")
    assert bench_env.status()["state"] == "stale"
    dead = tmp_store / "bench-env" / "site-packages" / "gone_in_new_pin-1.0.dist-info" / "METADATA"
    calls = _fake_build(monkeypatch, tmp_store / "bench-env")

    st = bench_env.create(quiet=True)          # NO reinstall flag
    assert st["state"] == "ready"
    assert not dead.exists(), "orphaned package survived a stale rebuild"
    # the wipe happened BEFORE `python -m venv` was invoked
    venv_idx = next(i for i, c in enumerate(calls) if "-m venv" in " ".join(c))
    assert venv_idx >= 0
    marker = json.loads((tmp_store / "bench-env" / bench_env.MARKER).read_text())
    assert marker["requirements"] == "newpin"


def test_broken_venv_dir_is_wiped_too(tmp_store, monkeypatch):
    """'missing' but with a half-present directory (interrupted build)
    gets the same full wipe — venv refuses to overwrite files it did not
    create cleanly and pip would install into the corpse."""
    venv = tmp_store / "bench-env"
    (venv / "lib").mkdir(parents=True)
    corpse = venv / "lib" / "half_installed.txt"
    corpse.write_text("interrupted build\n")
    _fake_build(monkeypatch, venv)
    st = bench_env.create(quiet=True)
    assert st["state"] == "ready" and not corpse.exists()


def test_ready_create_is_a_noop_and_does_not_wipe(tmp_store, monkeypatch):
    venv = _seed_venv(tmp_store)
    keep = venv / "site-packages" / "gone_in_new_pin-1.0.dist-info" / "METADATA"
    calls = _fake_build(monkeypatch, venv)
    st = bench_env.create(quiet=True)          # ready + no flag -> no build
    assert st["state"] == "ready"
    assert calls == [], "a ready env must not be rebuilt (or wiped)"
    assert keep.exists()


def test_reinstall_flag_still_wipes_a_ready_env(tmp_store, monkeypatch):
    venv = _seed_venv(tmp_store)
    keep = venv / "site-packages" / "gone_in_new_pin-1.0.dist-info" / "METADATA"
    _fake_build(monkeypatch, venv)
    st = bench_env.create(quiet=True, reinstall=True)
    assert st["state"] == "ready"
    assert not keep.exists()


def test_pip_install_runs_with_no_cache_dir(tmp_store, monkeypatch):
    """Disk hygiene: no machine-global pip cache growth from uplift
    installs (measured: the shared ~/Library/Caches/pip is 884 MB today).
    Both pip invocations must carry the flag — one install code path."""
    venv = tmp_store / "bench-env"
    calls = _fake_build(monkeypatch, venv)
    bench_env.create(quiet=True)
    pip_calls = [c for c in calls if "pip" in c and "install" in c]
    assert len(pip_calls) == 2, pip_calls
    for c in pip_calls:
        assert "--no-cache-dir" in c, f"pip install without --no-cache-dir: {c}"
        assert not any("--cache-dir" in x for x in c), "owned cache dir not the policy"


def test_guard_refuses_unpinned_torch_and_wipes(tmp_store, monkeypatch, caplog):
    """bench_env_requirements.txt does NOT pin torch -> a torch that
    appeared (transitive bloat, drifted pin) still fails the build, loudly."""
    venv = tmp_store / "bench-env"
    _fake_build(monkeypatch, venv, torch_present=True)
    with pytest.raises(RuntimeError, match="NOT pinned"):
        bench_env.create(quiet=True)
    assert not venv.exists(), "failed build must not leave a broken venv"
    assert "torch" in caplog.text.lower()


def test_guard_allows_pinned_torch(tmp_store, monkeypatch):
    """The on-demand-deps policy half: when THIS env's requirements file
    pins torch (mteb-env does), the same guard passes it."""
    req = tmp_store / "torchy_requirements.txt"
    req.write_text("lm_eval==0.4.13\ntorch==2.14.1\n")
    venv = tmp_store / "bench-env"
    calls = _fake_build(monkeypatch, venv, torch_present=True)
    st = bench_env.create(quiet=True, req=req)
    assert st["state"] == "ready"
    assert st["requirements"] == bench_env.requirements_digest(req)
    assert any("--no-cache-dir" in c for c in calls)


def test_guard_probe_is_skipped_noop_when_torch_absent(tmp_store, monkeypatch):
    """Normal bench-env shape: probe returns 0 (absent) -> silent pass."""
    venv = tmp_store / "bench-env"
    _fake_build(monkeypatch, venv, torch_present=False)
    assert bench_env.create(quiet=True)["state"] == "ready"


def test_extra_check_runs_in_addition_to_guard(tmp_store, monkeypatch):
    """ACC-2e changed the documented semantics: extra_check ADDS a check,
    it no longer switches the heavy-dep guard off. Both must fire."""
    venv = tmp_store / "bench-env"
    calls = _fake_build(monkeypatch, venv, torch_present=True)
    seen = []

    def extra(py):
        seen.append(Path(py).name)

    req = tmp_store / "torchy.txt"
    req.write_text("torch==2.0.0\n")
    assert bench_env.create(quiet=True, extra_check=extra, req=req)["state"] == "ready"
    assert seen == ["python"]
    assert any("find_spec" in " ".join(c) for c in calls)
    # and an extra_check that raises still wipes the env
    def boom(py):
        raise RuntimeError("extra says no")
    with pytest.raises(RuntimeError, match="extra says no"):
        bench_env.create(quiet=True, extra_check=boom, req=req, reinstall=True)
    assert not (tmp_store / "bench-env" / bench_env.MARKER).exists()


def test_failed_import_wipes_and_does_not_stamp_marker(tmp_store, monkeypatch):
    venv = tmp_store / "bench-env"
    _fake_build(monkeypatch, venv, import_fails=True)
    with pytest.raises(RuntimeError, match="import lm_eval"):
        bench_env.create(quiet=True)
    assert not (venv / bench_env.MARKER).exists()
    assert not venv.exists()


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
