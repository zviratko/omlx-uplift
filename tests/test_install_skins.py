# SPDX-License-Identifier: Apache-2.0
"""`omlx-uplift install` example-skin distribution tests.

install_example_skins: fresh install copies crates; identical files are
left alone; a differing file is replaced only when force allows and the
previous version is ALWAYS kept as <name>.yml.<timestamp>~ (never deleted);
non-interactive 'ask' never overwrites.
"""
from pathlib import Path

import pytest

from omlx_uplift import cli, skins


@pytest.fixture
def bundled(tmp_path, monkeypatch):
    """A fake package skins-example/ dir with one crate."""
    src = tmp_path / "bundled"
    src.mkdir()
    (src / "demo.yml").write_text("skin_version: 1\nlabel: New\n")
    monkeypatch.setattr(cli, "_example_skins_dir", lambda: src)
    return src


@pytest.fixture
def root(tmp_path, monkeypatch):
    d = tmp_path / "skins"          # does not exist yet: install creates it
    monkeypatch.setattr(skins, "skins_root", lambda base=None: d)
    return d


def test_fresh_install_creates_dir_and_copies(root, bundled):
    import io
    buf = io.StringIO()
    cli.install_example_skins(stream=buf, force="ask")
    assert (root / "demo.yml").read_text() == "skin_version: 1\nlabel: New\n"
    assert "installed" in buf.getvalue()


def test_identical_file_left_untouched(root, bundled):
    root.mkdir()
    (root / "demo.yml").write_text("skin_version: 1\nlabel: New\n")
    before = (root / "demo.yml").stat().st_mtime_ns
    import io
    buf = io.StringIO()
    cli.install_example_skins(stream=buf, force="yes")
    assert (root / "demo.yml").stat().st_mtime_ns == before
    assert "already current" in buf.getvalue()
    assert not list(root.glob("*.~"))


def test_replace_keeps_timestamp_backup(root, bundled):
    root.mkdir()
    (root / "demo.yml").write_text("skin_version: 1\nlabel: Mine\n")
    import io
    buf = io.StringIO()
    cli.install_example_skins(stream=buf, force="yes")
    assert "label: New" in (root / "demo.yml").read_text()
    backups = list(root.glob("demo.yml.*~"))
    assert len(backups) == 1
    assert backups[0].read_text() == "skin_version: 1\nlabel: Mine\n"
    assert str(backups[0]) in buf.getvalue()       # path disclosed


def test_ask_non_interactive_never_overwrites(root, bundled, monkeypatch):
    root.mkdir()
    (root / "demo.yml").write_text("skin_version: 1\nlabel: Mine\n")
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: False)
    import io
    buf = io.StringIO()
    cli.install_example_skins(stream=buf, force="ask")
    assert (root / "demo.yml").read_text() == "skin_version: 1\nlabel: Mine\n"
    assert "kept" in buf.getvalue()


def test_ask_interactive_no_answer_keeps(root, bundled, monkeypatch):
    root.mkdir()
    (root / "demo.yml").write_text("skin_version: 1\nlabel: Mine\n")
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda *a: "\n")
    import io
    buf = io.StringIO()
    cli.install_example_skins(stream=buf, force="ask")
    assert (root / "demo.yml").read_text() == "skin_version: 1\nlabel: Mine\n"
    assert not list(root.glob("*.~"))


def test_ask_interactive_yes_backups_then_replaces(root, bundled, monkeypatch):
    root.mkdir()
    (root / "demo.yml").write_text("skin_version: 1\nlabel: Mine\n")
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda *a: "y")
    import io
    buf = io.StringIO()
    cli.install_example_skins(stream=buf, force="ask")
    assert "label: New" in (root / "demo.yml").read_text()
    assert len(list(root.glob("demo.yml.*~"))) == 1
