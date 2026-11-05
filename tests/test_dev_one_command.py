"""One-command dev lane (user 2026-11-05).

`dev install` sets the lane up itself on a fresh box: questions on a TTY,
documented defaults with --yes, refusal when scripted without either (a
silent Xcode-grade kernel build + ~2 GB torch belongs to a human or to an
explicit --yes). The build close now proves the Uplift mount the way the
trailing `omlx-uplift install` used to, and the patch preview mirrors the
RUNTIME-MOUNT doctrine instead of printing the dev-carrier false
'reverts cleanly' warnings.
"""
import io
import os
import shutil
import sys
from types import SimpleNamespace

import pytest

from omlx_uplift import cli, devsrc

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")


def _dev_args(**kw):
    base = dict(action="install", name=None, keep=None, force=False,
                scope=None, yes=False, src=None, origin=None,
                sync_ref=None, fetch=False, with_custom_kernel=False,
                with_grammar=False, with_python312=False, dry_run=False,
                restart=False, port=None, base_path=None, share=[],
                no_share=[], interactive=False)
    base.update(kw)
    return SimpleNamespace(**base)


class _TTY(io.StringIO):
    def isatty(self):
        return True


def _ok_build():
    return SimpleNamespace(ok=True, stage="ok", returncode=0, lines=[],
                           materialize={}, upstreamed={},
                           sync_ref="origin/main", base_sha="a" * 40,
                           n_applied=0, tip="b" * 40, cfg={})


def _wire_fresh_box(monkeypatch, *, tty=False, port_free=True):
    """No dev.json at entry, one after setup; the build is a recorder."""
    cfg = {"origin": "https://x/omlx.git", "sync_ref": "origin/main"}
    seq = [None, cfg]
    monkeypatch.setattr(devsrc, "load_config", lambda *a, **k: seq.pop(0))
    monkeypatch.setattr(sys, "stdin", _TTY() if tty else io.StringIO(""))
    setup_calls = []

    def fake_setup(args):
        setup_calls.append(getattr(args, "yes", False))
        return 0

    monkeypatch.setattr(cli, "cmd_dev_setup", fake_setup)
    monkeypatch.setattr(devsrc, "runtime_config",
                        lambda c: {"port": 8001, "base_path": "~/.omlx-dev"})
    monkeypatch.setattr(devsrc, "vanilla_port", lambda: 8000)
    monkeypatch.setattr(devsrc, "port_in_use", lambda p: not port_free)
    builds = []
    monkeypatch.setattr(devsrc, "run_dev_build",
                        lambda **kw: builds.append(1) or _ok_build())
    return setup_calls, builds


# ---- auto-bootstrap policy --------------------------------------------------

def test_scripted_fresh_box_refuses_and_points_at_setup(monkeypatch, capsys):
    setup_calls, builds = _wire_fresh_box(monkeypatch)
    rc = cli.cmd_dev_install(_dev_args())
    assert rc == 2
    assert setup_calls == [] and builds == [], "refusal must touch nothing"
    err = capsys.readouterr().err
    assert "dev setup" in err and "--yes" in err


def test_scripted_yes_bootstraps_defaults_then_builds(monkeypatch):
    setup_calls, builds = _wire_fresh_box(monkeypatch)
    rc = cli.cmd_dev_install(_dev_args(yes=True))
    assert rc == 0
    assert setup_calls == [True] and builds == [1]


def test_tty_fresh_box_asks_then_builds(monkeypatch):
    setup_calls, builds = _wire_fresh_box(monkeypatch, tty=True)
    rc = cli.cmd_dev_install(_dev_args())
    assert rc == 0
    assert setup_calls == [False] and builds == [1]


def test_port_collision_after_setup_aborts_before_build(monkeypatch, capsys):
    setup_calls, builds = _wire_fresh_box(monkeypatch, port_free=False)
    rc = cli.cmd_dev_install(_dev_args(yes=True))
    assert rc == 1
    assert setup_calls == [True], "setup ran, the gate caught it before build"
    assert builds == []
    assert "dev setup --port" in capsys.readouterr().err


def test_existing_lane_never_touches_setup(monkeypatch):
    monkeypatch.setattr(devsrc, "load_config",
                        lambda *a, **k: {"origin": "x"})
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(cli, "cmd_dev_setup",
                        lambda args: pytest.fail("must not re-setup"))
    monkeypatch.setattr(devsrc, "run_dev_build", lambda **kw: _ok_build())
    assert cli.cmd_dev_install(_dev_args()) == 0


def test_dev_verbs_accept_setup_and_configure_aliases(monkeypatch):
    seen = []
    monkeypatch.setattr(cli, "cmd_dev_setup",
                        lambda args: seen.append(args.action) or 0)
    for verb in ("setup", "configure", "bootstrap"):
        assert cli.cmd_dev([verb]) == 0
    assert seen == ["setup", "configure", "bootstrap"]


# ---- mount proof at build close ---------------------------------------------

class _BU:
    def __init__(self, py="/keg/bin/python", mounts=True):
        self.py = py
        self.mounts = mounts

    def default_target_python(self, formula):
        return self.py

    def mount_into_dev_keg(self):
        return self.mounts


def _collect():
    seen = []
    return seen, (lambda s, t: seen.append((s, t)))


def test_mount_proof_ok(monkeypatch):
    monkeypatch.setattr(cli, "_verify_mount", lambda exe: (True, ""))
    seen, emit = _collect()
    assert devsrc._mount_proof(_BU(), emit) is True
    assert any("mount check: OK" in t for _, t in seen)


def test_mount_proof_skips_without_keg_python():
    # test/CI harnesses have no resolvable keg: warn, never fail the build
    seen, emit = _collect()
    assert devsrc._mount_proof(_BU(py=None), emit) is None
    assert any("proof skipped" in t for _, t in seen)


def test_mount_proof_failure_names_the_fix(monkeypatch):
    monkeypatch.setattr(cli, "_verify_mount", lambda exe: (False, "boom"))
    seen, emit = _collect()
    assert devsrc._mount_proof(_BU(), emit) is False
    assert any("MOUNT PROOF FAILED" in t for _, t in seen)
    assert any("--formula omlx-dev" in t for _, t in seen)


def test_mount_proof_unmounted_after_carry():
    seen, emit = _collect()
    assert devsrc._mount_proof(_BU(mounts=False), emit) is False
    assert any("NOT mounted" in t for _, t in seen)


# ---- honest preview on the dev carrier ---------------------------------------

def test_preview_dev_tree_marks_both_scope_as_branch_ride(tmp_path):
    from omlx_uplift import patchsource, patches
    pr = open(os.path.join(FIX, "pr3764.diff"), "rb").read()

    def _tree(base):
        root = base / "site-packages"
        root.mkdir(parents=True)
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        root / "omlx")
        return str(root)

    dev_root = _tree(tmp_path / "Cellar" / "omlx-dev" / "1" / "libexec")
    store = patches.PatchStore(str(tmp_path / "data"))
    assert patchsource.add_patch(store, "demo",
                                 {"kind": "upload", "data": pr},
                                 dev_root)["ok"]
    m = store.load()
    store.find(m, "demo")["scope"] = "both"
    store.save(m)
    rows = {r["id"]: r for r in cli.patch_preview(store, dev_root, None)}
    assert rows["demo"]["verdict"] == "applied"
    assert "branch" in rows["demo"]["detail"], \
        "the dev tree row must say the patch rides the branch build"
    # control: the same entry on a vanilla path still previews overlay work
    plain_root = _tree(tmp_path / "plain")
    rows2 = {r["id"]: r for r in cli.patch_preview(store, plain_root, None)}
    assert rows2["demo"]["verdict"] == "success"
