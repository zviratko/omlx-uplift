"""CONDITIONAL UPGRADE + --restart (user 2026-10-20).

'dev upgrade' runs the SAME deterministic materialize as install, then
skips the multi-minute brew build when nothing moved: the cut tip equals
dev.json built_sha AND that keg is still on disk. Anything else (HEAD
moved, patch set changed, keg pruned/rolled-back-away, first run) builds
exactly like before. 'dev install' and 'dev upgrade --force' stay
unconditional. --restart kickstarts the launchd service after a run that
ended ok — including a skipped one, so the running server can never drift
from the current keg without the operator noticing.
"""
import os
import pytest

from omlx_uplift import cli, devsrc

TIP = "a" * 40
BASE = "b" * 40
BVER = "20261020.120000.aaaaaaa"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLIFT_HOME", str(tmp_path / "uplift"))
    return tmp_path


def _stubs(home, monkeypatch, *, tip=TIP, built_sha=TIP, keg_exists=True,
           cellar=None):
    """Full pre-brew seam stack (be1 pattern): the pipeline runs for real
    until the gate, then either skips or reaches _stream_build."""
    cfg = {"src_path": str(home / "dev-src"), "sync_ref": "origin/main",
           "formula_branch": "uplift-dev"}
    if built_sha:
        cfg["built_sha"] = built_sha
        cfg["built_version"] = BVER
    monkeypatch.setattr(devsrc, "load_config", lambda *a, **k: dict(cfg))
    (home / "dev-src" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "ensure_clone", lambda c: None)
    monkeypatch.setattr(devsrc, "worktree_clean", lambda p: True)
    monkeypatch.setattr(devsrc, "fetch_sync_ref", lambda c: None)
    from omlx_uplift import patchsource, curated
    monkeypatch.setattr(curated, "sync", lambda *a, **k: {"report": {}})
    monkeypatch.setattr(devsrc, "_refresh_patch_sources",
                        lambda c, r: {"catalog": {"report": {}},
                                      "drift": None})
    monkeypatch.setattr(patchsource, "enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(
        devsrc, "materialize",
        lambda patches, cfg, **kw: {"ok": True, "tip": tip, "base": BASE,
                                    "commits": [], "branch": "uplift-dev",
                                    "skipped_patches": []})
    from omlx_uplift import kegstash
    cellar = cellar or str(home / "Cellar" / "omlx-dev")
    monkeypatch.setattr(kegstash, "cellar_dir", lambda *a, **k: cellar)
    monkeypatch.setattr(kegstash, "active_keg", lambda: BVER)
    if keg_exists:
        os.makedirs(os.path.join(cellar, BVER), exist_ok=True)
    return cellar


def test_upgrade_skips_when_head_and_patches_unchanged(home, monkeypatch):
    _stubs(home, monkeypatch)
    monkeypatch.setattr(
        devsrc, "_stream_build",
        lambda *a, **k: pytest.fail("brew must NOT run when up to date"))
    r = devsrc.run_dev_build(conditional=True)
    assert (r.ok, r.returncode, r.stage) == (True, 0, "up-to-date")
    assert any(t.startswith("up to date —") for _, t in r.lines), r.lines
    # the header trigger the CLI keys on
    assert any("neither omlx HEAD nor the patch set moved" in t
               for _, t in r.lines)


def test_upgrade_notes_a_rollback_is_active(home, monkeypatch):
    _stubs(home, monkeypatch)
    from omlx_uplift import kegstash
    monkeypatch.setattr(kegstash, "active_keg", lambda: "20261019.100000.zzzzzzz")
    r = devsrc.run_dev_build(conditional=True)
    assert r.stage == "up-to-date"
    assert any("ACTIVE keg is '20261019.100000.zzzzzzz'" in t
               for _, t in r.lines), r.lines


def test_upgrade_builds_when_head_moved(home, monkeypatch):
    _stubs(home, monkeypatch, tip="c" * 40)  # cut tip != built_sha
    monkeypatch.setattr(
        devsrc, "_stream_build",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("REACHED-BREW")))
    with pytest.raises(RuntimeError, match="REACHED-BREW"):
        devsrc.run_dev_build(conditional=True)


def test_upgrade_builds_when_keg_missing(home, monkeypatch):
    _stubs(home, monkeypatch, keg_exists=False)  # pruned / never installed
    monkeypatch.setattr(
        devsrc, "_stream_build",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("REACHED-BREW")))
    with pytest.raises(RuntimeError, match="REACHED-BREW"):
        devsrc.run_dev_build(conditional=True)


def test_first_upgrade_without_stamp_builds(home, monkeypatch):
    _stubs(home, monkeypatch, built_sha=None)  # pre-KEG-VERSIONED config
    monkeypatch.setattr(
        devsrc, "_stream_build",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("REACHED-BREW")))
    with pytest.raises(RuntimeError, match="REACHED-BREW"):
        devsrc.run_dev_build(conditional=True)


def test_install_never_skips(home, monkeypatch):
    _stubs(home, monkeypatch)  # everything identical to the skip case...
    monkeypatch.setattr(
        devsrc, "_stream_build",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("REACHED-BREW")))
    with pytest.raises(RuntimeError, match="REACHED-BREW"):
        devsrc.run_dev_build()  # conditional=False (install)


# --- CLI wiring -----------------------------------------------------------

def _cli_capture(monkeypatch, result=None):
    seen = {}

    def fake_build(**kw):
        seen.update(kw)
        return result or devsrc.BuildResult(ok=True, stage="ok",
                                            returncode=0, lines=[],
                                            tip=TIP, sync_ref="origin/main",
                                            base_sha=BASE, cfg={})
    monkeypatch.setattr(devsrc, "run_dev_build", fake_build)
    monkeypatch.setattr(cli, "_dev_next_steps", lambda *a, **k: None)
    restarts = []
    monkeypatch.setattr(cli, "_dev_restart",
                        lambda: (restarts.append(1), 0)[1])
    return seen, restarts


def test_cli_upgrade_is_conditional_and_install_is_not(monkeypatch):
    seen, restarts = _cli_capture(monkeypatch)
    assert cli.cmd_dev(["upgrade"]) == 0
    assert seen["conditional"] is True
    assert restarts == []
    seen, restarts = _cli_capture(monkeypatch)
    assert cli.cmd_dev(["install"]) == 0
    assert seen["conditional"] is False
    seen, restarts = _cli_capture(monkeypatch)
    assert cli.cmd_dev(["upgrade", "--force"]) == 0
    assert seen["conditional"] is False


def test_cli_restart_kickstarts_after_ok_and_after_skip(monkeypatch):
    seen, restarts = _cli_capture(monkeypatch)
    assert cli.cmd_dev(["install", "--restart"]) == 0
    assert restarts == [1]
    # a SKIPPED build with --restart still kickstarts: the running server
    # is pointed at the current keg either way
    skip = devsrc.BuildResult(ok=True, stage="up-to-date", returncode=0,
                              lines=[("out", "up to date —")])
    seen, restarts = _cli_capture(monkeypatch, result=skip)
    assert cli.cmd_dev(["upgrade", "--restart"]) == 0
    assert restarts == [1]
    # failure never restarts
    bad = devsrc.BuildResult(ok=False, stage="brew", returncode=1, lines=[])
    seen, restarts = _cli_capture(monkeypatch, result=bad)
    assert cli.cmd_dev(["upgrade", "--restart"]) == 1
    assert restarts == []


def test_dev_restart_uses_launchctl_kickstart(monkeypatch, capsys):
    calls = []

    class R:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return R()
    import subprocess
    monkeypatch.setattr(subprocess, "run", fake_run)
    assert cli._dev_restart() == 0
    assert calls[0] == ["launchctl", "kickstart", "-k",
                        f"gui/{os.getuid()}/sh.brew.omlx-dev"]
    assert "restarted" in capsys.readouterr().out
