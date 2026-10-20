# SPDX-License-Identifier: Apache-2.0
"""DEC-1: vanilla-keg decoupling.

Two resolvers must survive a machine that has ONLY the omlx-dev keg:

1. `brewutil.default_target_python()` picks the mount target for
   `omlx-uplift install` / `uninstall` — vanilla first (historic),
   else omlx-dev, else None (stay in the current interpreter).
2. `patches._omlx_root()` locates the live omlx tree for cross-process
   patch verbs (the uplift CLI venv cannot import omlx) — the keg-layout
   fallback must also find the omlx-dev keg.

Both must keep BOTH-keg machines resolving exactly as before: vanilla
wins when present.
"""
from pathlib import Path

import pytest


# ---- 1. default_target_python keg preference ------------------------------

def _fake_python_resolver(table):
    def resolver(formula):
        return table.get(formula)
    return resolver


def test_target_prefers_vanilla_when_both_kegs_exist(monkeypatch):
    from omlx_uplift import brewutil
    monkeypatch.setattr(brewutil, "brew_formula_python", _fake_python_resolver({
        "omlx": "/opt/homebrew/opt/omlx/libexec/bin/python",
        "omlx-dev": "/opt/homebrew/opt/omlx-dev/libexec/bin/python",
    }))
    assert brewutil.default_target_python().endswith("/opt/omlx/libexec/bin/python")


def test_target_falls_back_to_dev_keg_without_vanilla(monkeypatch):
    from omlx_uplift import brewutil
    monkeypatch.setattr(brewutil, "brew_formula_python", _fake_python_resolver({
        "omlx": None,
        "omlx-dev": "/opt/homebrew/opt/omlx-dev/libexec/bin/python",
    }))
    assert brewutil.default_target_python() == \
        "/opt/homebrew/opt/omlx-dev/libexec/bin/python"


def test_target_none_when_no_keg(monkeypatch):
    from omlx_uplift import brewutil
    monkeypatch.setattr(brewutil, "brew_formula_python", _fake_python_resolver({}))
    assert brewutil.default_target_python() is None


def test_explicit_formula_never_falls_back(monkeypatch):
    # --formula omlx must NOT silently mount into dev when vanilla absent:
    # the user named a keg that is not there (cmd_install then lands in
    # the current interpreter exactly like the pre-DEC-1 behaviour).
    from omlx_uplift import brewutil
    monkeypatch.setattr(brewutil, "brew_formula_python", _fake_python_resolver({
        "omlx": None,
        "omlx-dev": "/x/dev-python",
    }))
    assert brewutil.default_target_python("omlx") is None


# ---- 2. _omlx_root keg-layout fallback -------------------------------------

def _make_keg_tree(root: Path, keg: str, pyver: str = "python3.11") -> Path:
    sp = root / "opt" / keg / "libexec" / "lib" / pyver / "site-packages" / "omlx"
    sp.mkdir(parents=True)
    (sp / "__init__.py").write_text("")
    return sp


@pytest.fixture()
def no_importable_omlx(monkeypatch):
    monkeypatch.setattr("importlib.util.find_spec",
                        lambda name, *a, **k: None)


def test_omlx_root_finds_dev_keg_without_vanilla(tmp_path, monkeypatch,
                                                 no_importable_omlx):
    from omlx_uplift import patches, paths
    dev = _make_keg_tree(tmp_path, "omlx-dev")
    monkeypatch.setattr(paths, "brew_prefix_candidates", lambda: [str(tmp_path)])
    assert Path(patches._omlx_root()).resolve() == dev.resolve()


def test_omlx_root_vanilla_wins_when_both(tmp_path, monkeypatch,
                                          no_importable_omlx):
    from omlx_uplift import patches, paths
    vanilla = _make_keg_tree(tmp_path, "omlx")
    _make_keg_tree(tmp_path, "omlx-dev")
    monkeypatch.setattr(paths, "brew_prefix_candidates", lambda: [str(tmp_path)])
    assert Path(patches._omlx_root()).resolve() == vanilla.resolve()
