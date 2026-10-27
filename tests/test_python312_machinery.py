"""python312-trial machinery (2026-10-27): the --with-python312 flag
plumbing and the mount's python-minor guards. CI-safe: no omlx import
at module level (collection rule), no real kegs touched."""
import sys


from omlx_uplift import brewutil, cli, devsrc


def test_explicit_flags_carry_python312():
    assert "--with-python312" in devsrc._explicit_flags(False, False, True)
    assert "--with-python312" not in devsrc._explicit_flags(True, True)
    # existing two unchanged
    f = devsrc._explicit_flags(True, False, True)
    assert f == {"--with-custom-kernel", "--with-python312"}


def test_effective_flags_python312_wins_over_saved():
    eff = devsrc._effective_build_flags(
        {"build_options": []},
        devsrc._explicit_flags(False, False, True), brewutil)
    assert eff == {"--with-python312"}


def test_python_minor_probe():
    assert brewutil.python_minor(sys.executable) == (
        sys.version_info[0], sys.version_info[1])
    assert brewutil.python_minor("/nonexistent/python3.99") is None
    # a real binary that is NOT python: non-zero exit -> None, no raise
    assert brewutil.python_minor("/bin/pwd") is None


def test_cmd_install_refuses_minor_mismatch(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(brewutil, "python_minor",
                        lambda py: (3, 99))  # pretend engine is 3.99
    monkeypatch.setattr(cli, "_resolve_site_packages", lambda py: tmp_path)
    rc = cli.cmd_install(["--python", sys.executable])
    assert rc == 1
    err = capsys.readouterr().err
    assert "python minor mismatch" in err
    assert not (tmp_path / brewutil.PTH_NAME).exists()  # refused BEFORE write


def test_cmd_install_allows_matching_minor(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(brewutil, "python_minor",
                        lambda py: (sys.version_info[0], sys.version_info[1]))
    monkeypatch.setattr(cli, "_resolve_site_packages", lambda py: tmp_path)
    # stop after the mount write: proof-of-boot needs omlx, out of scope here
    monkeypatch.setattr(cli, "_verify_mount",
                        lambda py: (True, "stubbed"))
    monkeypatch.setattr(cli, "print_patch_preview", lambda _: None)
    monkeypatch.setattr(cli, "_install_default_target", lambda a: None)
    rc = cli.cmd_install(["--python", sys.executable])
    assert rc == 0
    assert (tmp_path / brewutil.PTH_NAME).exists()


def test_dev_comount_skips_across_minors(monkeypatch, capsys):
    monkeypatch.setattr(brewutil, "default_target_python",
                        lambda formula="/x": "/x")
    monkeypatch.setattr(brewutil, "python_minor", lambda py: (3, 42))
    assert brewutil.mount_into_dev_keg() is False
    assert "co-mount skipped" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# uplift carry (one-command dev install across engine python minors)

class _R:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def test_carry_needed_only_on_known_mismatch(monkeypatch):
    calls = {"eng": "/eng/python", "up": "/up/python",
             "minors": {"/eng/python": (3, 12), "/up/python": (3, 11)}}
    stub = type("BU", (), {})()
    stub.default_target_python = lambda f: calls["eng"]
    stub.brew_formula_python = lambda f: calls["up"]
    stub.python_minor = lambda p: calls["minors"].get(p)
    assert devsrc._uplift_carry_needed(stub) == ((3, 12), (3, 11))
    calls["minors"]["/up/python"] = (3, 12)
    assert devsrc._uplift_carry_needed(stub) is None      # match: skip
    calls["up"] = None
    assert devsrc._uplift_carry_needed(stub) is None      # no keg: skip


def test_carry_steps_shape():
    steps = devsrc._carry_steps()
    flat = [" ".join(c) for c, _ in steps]
    assert flat[0].startswith("brew fetch --HEAD")           # stale-clone trap
    assert "uninstall" in flat[1] and "install --HEAD" in flat[2]
    assert flat[3] == "omlx-uplift install"                  # remount


def test_carry_worker_ok_and_tolerates_not_installed():
    seen = []

    def runner(cmd, **kw):
        seen.append(cmd)
        if cmd[:2] == ["brew", "uninstall"]:
            return _R(1, "", "Error: No such keg: omlx-uplift not installed")
        return _R(0, "ok")

    assert devsrc._do_carry_uplift_keg(runner=runner) is True
    assert len(seen) == 4  # uninstall failure with 'not installed' continues


def test_carry_worker_fails_loud_on_real_error():
    def runner(cmd, **kw):
        return _R(1, "", "boom: compile died") if "install" in cmd else _R(0)

    assert devsrc._do_carry_uplift_keg(runner=runner) is False


def test_carry_parent_delegates_to_child_interpreter():
    outs = []

    def runner(cmd, **kw):
        assert cmd[0] == sys.executable and "-c" in cmd[1:3]
        assert "_do_carry_uplift_keg" in cmd[2]  # swap runs in the CHILD
        return _R(0, "uplift carry: done")

    ok = devsrc._carry_uplift_keg(lambda s, t: outs.append((s, t)),
                                  runner=runner)
    assert ok and outs == [("out", "uplift carry: done")]
