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
