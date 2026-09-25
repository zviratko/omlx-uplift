# SPDX-License-Identifier: Apache-2.0
"""Bundled-skin sync tests (search-path rework, 2026-09-25).

Crates ship in the package (keg) and are NEVER installed as .yml into a
user dir any more; sync_bundled unpacks working copies into the skins
root at server startup, marks them (.bundled marker + .bundled- dir
prefix) and prunes the engine copies its update superseded. install is a
no-op for skins. User dirs shadow bundled skins and are never deleted.
"""
import pytest

from omlx_uplift import cli, skins

CRATE_V1 = "skin_version: 1\nlabel: Demo Old\n"
CRATE_V2 = "skin_version: 1\nlabel: Demo New\n"


@pytest.fixture(autouse=True)
def _no_cache():
    skins.invalidate_caches()
    skins._package_crates_cache.clear()
    yield
    skins.invalidate_caches()
    skins._package_crates_cache.clear()


@pytest.fixture
def pkg(tmp_path, monkeypatch):
    """A fake package crate dir with one skin; rewrite() simulates an update."""
    src = tmp_path / "pkg-skins"
    src.mkdir()
    (src / "demo.yml").write_text(CRATE_V1)
    monkeypatch.setattr(skins, "bundled_package_dir", lambda: src)
    return src


@pytest.fixture
def root(tmp_path):
    d = tmp_path / "skins"          # does not exist yet: sync creates it
    return d


def rewrite(pkg, text):
    (pkg / "demo.yml").write_text(text)
    skins._package_crates_cache.clear()


# ---------------------------------------------------------------- unpack

def test_sync_creates_root_and_unpacks_marked_dir(pkg, root):
    res = skins.sync_bundled(root)
    assert len(res["installed"]) == 1
    dir_name = res["installed"][0]
    assert dir_name.startswith(skins.BUNDLED_PREFIX)
    d = root / dir_name
    assert (d / "skin.yml").read_text() == CRATE_V1
    assert (d / ".bundled").is_file()          # cleanup marker
    assert not list(root.glob("*.yml"))        # no crate copied out


def test_sync_is_idempotent_and_content_stable(pkg, root):
    first = skins.sync_bundled(root)
    again = skins.sync_bundled(root)
    assert again["installed"] == []
    assert again["pruned"] == []
    # stamp is content-addressed: dir name stable across syncs
    assert [p.name for p in root.iterdir() if p.is_dir()] == first["installed"]


def test_update_prunes_superseded_bundled_dir(pkg, root):
    old = skins.sync_bundled(root)["installed"][0]
    rewrite(pkg, CRATE_V2)
    res = skins.sync_bundled(root)
    new = res["installed"][0]
    assert new != old
    assert old in res["pruned"]
    assert not (root / old).exists()
    assert (root / new / "skin.yml").read_text() == CRATE_V2


def test_prune_never_touches_user_dirs(pkg, root):
    old = skins.sync_bundled(root)["installed"][0]
    mine = root / "mine-1762070400"
    mine.mkdir()
    (mine / "skin.yml").write_text(CRATE_V1)
    # a hand-made dir inside the root that merely LOOKS bundled-ish
    clashing = root / "demo-1762070400"
    clashing.mkdir()
    (clashing / "skin.yml").write_text("skin_version: 1\nlabel: Hand\n")
    rewrite(pkg, CRATE_V2)
    res = skins.sync_bundled(root)
    assert old in res["pruned"]
    assert mine.exists() and clashing.exists()
    assert (root / res["installed"][0]).is_dir()


# ---------------------------------------------------------------- listing

def test_list_skins_shadows_bundled_with_user_copy(pkg, root):
    skins.sync_bundled(root)
    mine = root / "demo-1762070400"            # user working copy wins
    mine.mkdir()
    (mine / "skin.yml").write_text("skin_version: 1\nlabel: Mine\n")
    entries = skins.list_skins(root)
    demo = [e for e in entries if e["name"] == "demo"]
    assert len(demo) == 1
    assert demo[0]["dir"] == "demo-1762070400"
    assert demo[0]["label"] == "Mine"


def test_list_skins_user_crate_shadows_bundled(pkg, root):
    skins.sync_bundled(root)
    (root / "demo.yml").write_text("skin_version: 1\nlabel: Mine Crate\n")
    entries = skins.list_skins(root)
    demo = [e for e in entries if e["name"] == "demo"]
    assert len(demo) == 1
    assert not demo[0]["bundled"]


def test_list_skins_shows_bundled_entry(pkg, root):
    dir_name = skins.sync_bundled(root)["installed"][0]
    entries = skins.list_skins(root)
    demo = [x for x in entries if x["name"] == "demo"]
    assert len(demo) == 1
    e = demo[0]
    assert e["dir"] == dir_name and e["bundled"] is True
    assert e["label"] == "Demo Old"
    # resolvable like any skin (pinned selection uses the dir name)
    assert skins.resolve_sel(entries, dir_name)["dir"] == dir_name


# ------------------------------------------------------------ legacy yml

def test_legacy_identical_yml_is_cleaned_up(pkg, root):
    # pre-rework state: install had copied the crate + its working copy in
    root.mkdir()
    (root / "demo.yml").write_text(CRATE_V1)
    import os
    mt = 1_762_070_400
    os.utime(root / "demo.yml", (mt, mt))
    d = root / f"demo-{mt}"
    d.mkdir()
    (d / "skin.yml").write_text(CRATE_V1)
    res = skins.sync_bundled(root)
    assert not (root / "demo.yml").exists()
    assert not d.exists()
    assert res["installed"]                      # bundled copy unpacked too


def test_legacy_hand_edited_yml_is_kept_and_shadows(pkg, root):
    root.mkdir()
    (root / "demo.yml").write_text("skin_version: 1\nlabel: Mine\n")
    res = skins.sync_bundled(root)
    assert (root / "demo.yml").read_text() == "skin_version: 1\nlabel: Mine\n"
    assert res["pruned"] == []


# ---------------------------------------------------------------- install

def test_install_does_not_copy_skins_anymore(tmp_path, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(cli, "install_example_skins",
                        lambda **kw: calls.append(kw))
    monkeypatch.setattr(cli, "_resolve_site_packages",
                        lambda t: tmp_path)
    monkeypatch.setattr(cli, "_default_target_python",
                        lambda formula=None: str(tmp_path / "python"))
    monkeypatch.setattr(cli, "_verify_mount", lambda exe: (True, "stub"))
    monkeypatch.setattr(cli, "print_patch_preview", lambda store: None)
    monkeypatch.setattr(cli, "_mount_into_dev_keg", lambda: (False))
    assert cli.cmd_install([]) == 0
    assert calls == [], "install must not touch bundled skins at all"
