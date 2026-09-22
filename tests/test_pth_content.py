# SPDX-License-Identifier: Apache-2.0
"""`_pth_content` regression tests.

The .pth body must ALWAYS carry the sys.path bootstrap line when a target
interpreter is given. The old code probed the target with
`python -c "import omlx_uplift"` and skipped the path line on success —
but a WORKING .pth already in the target's site-packages makes that probe
succeed by bootstrapping itself, so the rewrite dropped the very line that
makes the mount work. Result: install #1 on an already-mounted keg wrote an
import-only .pth (mount check FAILED, /uplift/ 404), install #2 "fixed" it.
"""
from pathlib import Path

from omlx_uplift import cli


def test_body_always_bootstraps_path_line_with_target(tmp_path, monkeypatch):
    # Even if the target could import omlx_uplift on its own, the path
    # line must stay: the probe result says nothing about boot startup.
    body = cli._pth_content(tmp_path / "python")
    lines = body.strip().splitlines()
    pkg_parent = str(Path(cli.__file__).resolve().parent.parent)
    assert lines[0] == pkg_parent, "path line must come first"
    assert lines[1] == "import omlx_uplift.autopatch"


def test_cellar_path_rewritten_to_stable_opt_symlink(tmp_path, monkeypatch):
    # Simulate running from a versioned Cellar dir; the .pth must point at
    # the stable opt/ symlink so `brew upgrade omlx-uplift` needs no remount.
    fake = (tmp_path / "Cellar" / "omlx-uplift" / "HEAD-abc123"
            / "libexec" / "lib" / "python3.11" / "site-packages"
            / "omlx_uplift" / "cli.py")
    fake.parent.mkdir(parents=True)
    fake.write_text("")
    monkeypatch.setattr(cli, "__file__", str(fake))
    body = cli._pth_content(tmp_path / "python")
    first = body.strip().splitlines()[0]
    assert "/Cellar/omlx-uplift/HEAD-abc123/" not in first
    assert first.endswith("/opt/omlx-uplift/libexec/lib/python3.11/site-packages")


def test_no_target_means_import_only(tmp_path):
    # No external target: we are the interpreter, sys.path is already right.
    body = cli._pth_content(None)
    assert body.strip().splitlines() == ["import omlx_uplift.autopatch"]
