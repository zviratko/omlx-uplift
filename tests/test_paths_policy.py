"""PATHS-1: pin the two base-dir families and the brew-prefix ladder.

The DEV-6 incident (one patch store forked into two manifests because
OMLX_BASE_PATH leaked into the patch-store resolution) is encoded here
as a permanent invariant, together with the Intel-Mac brew discovery bug
(HOMEBREW_PREFIX fallback that ignored /usr/local).
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from omlx_uplift import env_tunables, kegstash, patches, paths, store


@pytest.fixture()
def clean_env(monkeypatch):
    monkeypatch.delenv("OMLX_BASE_PATH", raising=False)
    monkeypatch.delenv("UPLIFT_HOME", raising=False)
    monkeypatch.delenv("HOMEBREW_PREFIX", raising=False)
    monkeypatch.setattr(env_tunables, "_BASE_DIR", None)


# ---- family B: the shared uplift store NEVER follows OMLX_BASE_PATH ----

def test_store_dir_ignores_omlx_base_path(clean_env, monkeypatch):
    monkeypatch.setenv("OMLX_BASE_PATH", "/tmp/other-instance")
    assert paths.uplift_store_dir() == Path("~/.omlx/uplift").expanduser()
    assert patches.default_base_dir() == str(paths.uplift_store_dir())


def test_store_dir_honours_uplift_home(clean_env, monkeypatch):
    monkeypatch.setenv("UPLIFT_HOME", "~/somewhere/else")
    assert paths.uplift_store_dir() == Path("~/somewhere/else").expanduser()


# ---- family A: per-instance data follows server_state -> env -> home ----

def test_metrics_db_follows_env_base(clean_env, monkeypatch):
    monkeypatch.setenv("OMLX_BASE_PATH", "/tmp/instance-x")
    assert store.default_db_path() == Path(
        "/tmp/instance-x/uplift/metrics.sqlite3")
    assert env_tunables.overrides_path() == Path(
        "/tmp/instance-x/uplift/env_overrides.json")


def test_metrics_db_default_home(clean_env):
    assert store.default_db_path() == Path(
        "~/.omlx/uplift/metrics.sqlite3").expanduser()


def test_set_base_dir_seam_wins(clean_env, monkeypatch):
    env_tunables.set_base_dir("/tmp/seeded")
    try:
        assert env_tunables.overrides_path() == Path(
            "/tmp/seeded/env_overrides.json")
    finally:
        monkeypatch.setattr(env_tunables, "_BASE_DIR", None)


# ---- brew prefix: env first, BOTH install layouts, de-duplicated ----

def test_brew_candidates_env_first_deduped(clean_env, monkeypatch):
    monkeypatch.setenv("HOMEBREW_PREFIX", "/opt/homebrew")
    assert paths.brew_prefix_candidates() == ["/opt/homebrew", "/usr/local"]
    monkeypatch.setenv("HOMEBREW_PREFIX", "/custom/brew")
    assert paths.brew_prefix_candidates() == [
        "/custom/brew", "/opt/homebrew", "/usr/local"]
    assert paths.brew_prefix() == "/custom/brew"


def test_brew_prefix_probe_covers_usr_local(clean_env, monkeypatch):
    calls = []

    def fake_isdir(p):
        calls.append(p)
        return p == "/usr/local/Cellar"

    monkeypatch.setattr(paths.os.path, "isdir", fake_isdir)
    assert paths.brew_prefix() == "/usr/local"


def test_kegstash_uses_shared_ladder(clean_env, monkeypatch):
    monkeypatch.setenv("HOMEBREW_PREFIX", "/custom/brew")
    assert kegstash.cellar_dir("omlx-dev") == "/custom/brew/Cellar/omlx-dev"
    assert kegstash.opt_link("omlx-dev") == "/custom/brew/opt/omlx-dev"


def test_startup_base_dir_never_imports_omlx(clean_env, monkeypatch):
    # autopatch runs from a .pth before omlx exists: startup_base_dir
    # must not be the full ladder. Block the import and call it anyway.
    import sys

    class _Block:
        def find_module(self, name, path=None):
            if name == "omlx.server":
                raise ImportError("omlx.server blocked (test)")
            return None

    monkeypatch.setenv("OMLX_BASE_PATH", "/tmp/instance-y")
    blocker = _Block()
    monkeypatch.setenv("OMLX_BASE_PATH", "/tmp/instance-y")
    sys.meta_path.insert(0, blocker)
    try:
        assert paths.startup_base_dir() == Path("/tmp/instance-y")
    finally:
        sys.meta_path.remove(blocker)
