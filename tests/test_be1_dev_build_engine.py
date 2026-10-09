"""BE-1: devsrc.run_dev_build engine tests — the handler-leak regression
and the early-return stage contracts.

The old cli.cmd_dev_install added a logging.FileHandler and removed it
only on the LATE paths; every early return (not bootstrapped, clone
missing, dirty worktree, fetch error) leaked one handler into the
dashboard's long-running process per failed build. run_dev_build wraps
the whole pipeline in try/finally; these tests pin that.
"""
import logging
import os

import pytest

from omlx_uplift import devsrc


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLIFT_HOME", str(tmp_path / "uplift"))
    return tmp_path


def _cfg(tmp_path, monkeypatch, **over):
    cfg = {"src_path": str(tmp_path / "dev-src"), "sync_ref": "origin/main",
           "formula_branch": "uplift-dev"}
    cfg.update(over)
    monkeypatch.setattr(devsrc, "load_config", lambda *a, **k: dict(cfg))
    return cfg


def handler_count():
    return len(logging.getLogger("omlx_uplift").handlers)


def test_materialize_fail_leaks_no_handler(home, monkeypatch):
    """THE BE-1 regression: the old code added the patch FileHandler and
    removed it only on the two late paths; materialize-fail and dry-run
    returned early and leaked one handler per failed build into the
    dashboard process. Two failed builds, handler count unchanged."""
    _cfg(home, monkeypatch)
    (home / "dev-src" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "ensure_clone", lambda cfg: None)
    monkeypatch.setattr(devsrc, "worktree_clean", lambda p: True)
    monkeypatch.setattr(devsrc, "fetch_sync_ref", lambda cfg: None)
    from omlx_uplift import patchsource, curated
    monkeypatch.setattr(curated, "sync", lambda *a, **k: {"report": {}})
    monkeypatch.setattr(patchsource, "enabled_build_patches", lambda store: [])
    monkeypatch.setattr(devsrc, "materialize",
                        lambda patches, cfg: {"ok": False,
                                              "reason": "p-bad does not apply",
                                              "failed_patch": "p-bad"})
    before = handler_count()
    r1 = devsrc.run_dev_build()
    r2 = devsrc.run_dev_build()
    assert handler_count() == before, "FileHandler leaked into the process"
    assert r1.ok is False and r1.returncode == 1
    assert r1.stage == "materialize"
    assert any("does not apply" in t for _, t in r2.lines)
    assert any("patch disable p-bad" in t for _, t in r2.lines)


def test_log_handler_covers_the_source_refresh(home, monkeypatch):
    """LOG-2 (2026-10-09): the 'gate REJECTED' warning users are told to
    investigate in dev-install.log was emitted by _refresh_patch_sources —
    which ran BEFORE the FileHandler was attached. The console got the
    line, the named log stayed empty. The handler must cover the refresh:
    a warning logged during the refresh has to land in the file."""
    _cfg(home, monkeypatch)
    (home / "dev-src" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "ensure_clone", lambda cfg: None)
    monkeypatch.setattr(devsrc, "worktree_clean", lambda p: True)
    monkeypatch.setattr(devsrc, "fetch_sync_ref", lambda cfg: None)
    from omlx_uplift import patchsource

    def _refresh_side_effect(cfg, res):
        # the exact thing the real refresh does when a stored source has
        # drifted onto a tree it no longer matches
        logging.getLogger("omlx_uplift.patchsource").warning(
            "gate REJECTED fake-url (1/1 files failed): x: context mismatch")
        return {"catalog": {"report": {}}, "drift": None}

    monkeypatch.setattr(devsrc, "_refresh_patch_sources", _refresh_side_effect)
    monkeypatch.setattr(patchsource, "enabled_build_patches", lambda store: [])
    monkeypatch.setattr(devsrc, "materialize",
                        lambda patches, cfg: {"ok": True, "tip": "t" * 40,
                                              "base": "b" * 40,
                                              "commits": []})
    r = devsrc.run_dev_build(dry_run=True)
    assert r.ok, [(s, t) for s, t in r.lines]
    text = open(r.log_path).read()
    assert "gate REJECTED fake-url" in text, \
        "warning logged during the source refresh never reached the log"


def test_missing_config_stage_and_rc(home, monkeypatch):
    monkeypatch.setattr(devsrc, "load_config", lambda *a, **k: None)
    before = handler_count()
    r = devsrc.run_dev_build()
    assert handler_count() == before
    assert (r.ok, r.returncode, r.stage) == (False, 2, "config")
    assert any("bootstrap" in t for _, t in r.lines)


def test_dirty_worktree_early_return(home, monkeypatch):
    _cfg(home, monkeypatch)
    (home / "dev-src" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "ensure_clone", lambda cfg: None)
    monkeypatch.setattr(devsrc, "worktree_clean", lambda p: False)
    before = handler_count()
    r = devsrc.run_dev_build()
    assert handler_count() == before
    assert (r.ok, r.returncode, r.stage) == (False, 1, "worktree")


def test_dry_run_builds_branch_and_reports(home, monkeypatch):
    """Full happy path minus brew: real fixture repos, materialize runs,
    dry_run stops before the subprocess. The dashboard's build button
    lands here through the same engine the CLI uses."""
    import subprocess as sp

    origin = home / "origin.git"
    seed = home / "seed"
    seed.mkdir()
    sp.run(["git", "init", "-q", "--bare", str(origin)], check=True)
    sp.run(["git", "init", "-q", str(seed)], check=True)
    (seed / "hello.txt").write_text("base\n")
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    sp.run(["git", "-C", str(seed), "add", "-A"], check=True, env=env)
    sp.run(["git", "-C", str(seed), "commit", "-q", "-m", "base"], check=True, env=env)
    sp.run(["git", "-C", str(seed), "branch", "-M", "main"], check=True, env=env)
    sp.run(["git", "-C", str(seed), "remote", "add", "origin", str(origin)], check=True, env=env)
    sp.run(["git", "-C", str(seed), "push", "-q", "-u", "origin", "main"], check=True, env=env)

    clone = home / "dev-src"
    sp.run(["git", "clone", "-q", str(origin), str(clone)], check=True, env=env)
    sp.run(["git", "-C", str(clone), "remote", "set-url", "origin", str(origin)], check=True)

    cfg = _cfg(home, monkeypatch, origin=str(origin))
    # zero build patches: the engine's stores land in the tmp UPLIFT_HOME
    # (empty manifest), and the curated best-effort sync must not touch
    # the network here
    from omlx_uplift import patchsource, curated
    monkeypatch.setattr(curated, "sync", lambda *a, **k: {"report": {}})
    monkeypatch.setattr(devsrc, "fetch_sync_ref",
                        lambda c: sp.run(["git", "-C", str(clone), "fetch", "-q", "origin",
                                          "+main:refs/remotes/origin/main"], check=True))
    monkeypatch.setattr(patchsource, "enabled_build_patches", lambda store: [])

    r = devsrc.run_dev_build(dry_run=True)
    assert r.ok, [(s, t) for s, t in r.lines]
    assert r.stage == "dry-run"
    assert r.returncode == 0
    assert any(t.startswith("dry-run: would run:") for _, t in r.lines)
    assert r.tip and handler_count() == handler_count()  # handler closed
    names = [h.__class__.__name__ for h in logging.getLogger("omlx_uplift").handlers]
    assert "FileHandler" not in names


def test_cli_no_longer_reaches_devsrc_privates():
    """BE-1(4): the private-name edges in both directions are deleted."""
    from pathlib import Path
    repo = Path(__file__).resolve().parents[1]
    cli_src = (repo / "omlx_uplift" / "cli.py").read_text()
    dev_router = (repo / "omlx_uplift" / "routers" / "dev.py").read_text()
    for priv in ("_sync_parts", "_apply_one", "_regate_build_patches"):
        assert priv not in cli_src, f"cli still touches devsrc.{priv}"
    assert "cmd_dev_install" not in dev_router, "router must use the engine"
    assert "RESULT:" not in dev_router and "RESULT:" not in (repo / "omlx_uplift" / "static" / "uplift_devpanel.js").read_text()
