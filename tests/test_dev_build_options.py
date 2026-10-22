"""SYNC-1 2026-10-22: formula build options are a first-class choice.

Fresh boxes have no vanilla omlx receipt to inherit --with-* options from,
so: bootstrap asks (custom kernels default ON, Metal toolchain named),
the answer is saved as dev.json 'build_options', the build resolves
explicit flag > saved answer > receipt inheritance, and an explicit flag
re-saves (sticky).
"""
import pytest
from types import SimpleNamespace

from omlx_uplift import devsrc


# ---- questionnaire parsing -------------------------------------------------

@pytest.fixture()
def answers(monkeypatch):
    # the kernel branch now offers toolchain setup — silent unless the
    # offer itself is under test
    monkeypatch.setattr(devsrc, "_offer_metal_toolchain", lambda: True)

    def _feed(text):
        monkeypatch.setattr("builtins.input", lambda prompt="": text)
    return _feed


def test_ask_build_options_default_is_custom_kernel(answers, capsys):
    answers("")
    assert devsrc._ask_build_options() == ["--with-custom-kernel"]
    out = capsys.readouterr().out
    assert "RECOMMENDED, you almost certainly" in out, \
        "kernels must be worded as the choice the user wants"
    assert "MetalToolchain" in out, "the Xcode download must be named up front"


def test_ask_build_options_combines_and_dedupes(answers):
    answers("1,2 1")
    assert devsrc._ask_build_options() == ["--with-custom-kernel",
                                           "--with-grammar"]


def test_ask_build_options_plain_zero(answers):
    answers("0")
    assert devsrc._ask_build_options() == []
    answers("none")
    assert devsrc._ask_build_options() == []


def test_ask_build_options_custom_flag_passes_through(answers):
    answers("--with-future-thing")
    assert devsrc._ask_build_options() == ["--with-future-thing"]


def test_ask_build_options_junk_is_reported_not_stored(answers, capsys):
    answers("1 bananas 2")
    assert devsrc._ask_build_options() == ["--with-custom-kernel",
                                           "--with-grammar"]
    assert "ignoring 'bananas'" in capsys.readouterr().out


# ---- install_config stores the answer --------------------------------------

def test_install_config_saves_answer(tmp_path, monkeypatch, answers):
    monkeypatch.setattr(devsrc, "detect_origin",
                        lambda src_hint=None: {"origin": "https://x/omlx.git",
                                               "source": "test"})
    # origin question: default Y; sync ref: default; options: fed above
    seq = iter(["", "", "1"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(seq))
    cfg = devsrc.install_config(base_dir=str(tmp_path))
    assert cfg["build_options"] == ["--with-custom-kernel"]


def test_install_config_yes_saves_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(devsrc, "detect_origin",
                        lambda src_hint=None: {"origin": "https://x/omlx.git",
                                               "source": "test"})
    cfg = devsrc.install_config(yes=True, base_dir=str(tmp_path))
    # never asked => never stored => the box keeps receipt inheritance
    assert "build_options" not in cfg


# ---- build-time resolution -------------------------------------------------

class _StubBrew:
    def __init__(self, dev=None, vanilla=None):
        self.calls = []
        self._r = {"omlx-dev": set(dev or []), "omlx": set(vanilla or [])}

    def receipt_used_options(self, formula):
        self.calls.append(formula)
        return self._r[formula]


def test_explicit_flag_wins_over_saved():
    b = _StubBrew(dev=["--with-grammar"])
    flags = devsrc._effective_build_flags(
        {"build_options": ["--with-custom-kernel"]},
        devsrc._explicit_flags(False, True), b)
    assert flags == {"--with-grammar"}
    assert not b.calls, "receipt must not be read when a flag or answer exists"


def test_saved_answer_used_without_flags():
    b = _StubBrew(vanilla=["--with-grammar"])
    flags = devsrc._effective_build_flags(
        {"build_options": ["--with-custom-kernel"]}, set(), b)
    assert flags == {"--with-custom-kernel"}
    assert not b.calls


def test_empty_saved_answer_means_plain_build():
    b = _StubBrew(dev=["--with-custom-kernel"])
    flags = devsrc._effective_build_flags({"build_options": []}, set(), b)
    assert flags == set(), "[] is a choice, not 'never asked'"


def test_receipt_inheritance_only_without_saved_answer():
    b = _StubBrew(dev=["--with-grammar"])
    flags = devsrc._effective_build_flags({"origin": "x"}, set(), b)
    assert flags == {"--with-grammar"}
    assert b.calls == ["omlx-dev"]


def test_dry_run_uses_saved_answer_in_command(home_cfg_dry, capsys):
    """End-to-end through run_dev_build (be1 harness pattern): the printed
    brew command carries the saved build_options."""
    devsrc_mod, res = home_cfg_dry
    line = " ".join(t for _, t in res.lines)
    assert "brew install --skip-link --with-custom-kernel omlx-dev" in line


@pytest.fixture()
def home_cfg_dry(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLIFT_HOME", str(tmp_path / "uplift"))
    cfg = {"src_path": str(tmp_path / "dev-src"), "sync_ref": "origin/main",
           "formula_branch": "uplift-dev",
           "build_options": ["--with-custom-kernel"]}
    monkeypatch.setattr(devsrc, "load_config", lambda *a, **k: dict(cfg))
    (tmp_path / "dev-src" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "ensure_clone", lambda cfg: None)
    monkeypatch.setattr(devsrc, "worktree_clean", lambda p: True)
    monkeypatch.setattr(devsrc, "fetch_sync_ref", lambda cfg: None)
    from omlx_uplift import patchsource, curated
    monkeypatch.setattr(curated, "sync", lambda *a, **k: {"report": {}})
    monkeypatch.setattr(patchsource, "enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(devsrc, "materialize",
                        lambda patches, cfg, **kw: {"ok": True,
                                                    "tip": "t" * 40,
                                                    "base": "b" * 40,
                                                    "commits": []})
    monkeypatch.setattr(devsrc, "recheck_build_patches", lambda gated: {})
    return devsrc, devsrc.run_dev_build(dry_run=True)


# ---- toolchain offer --------------------------------------------------------

def _no_compiler(monkeypatch):
    monkeypatch.setattr(devsrc, "_metal_compiler_ok", lambda: False)


def test_offer_ready_compiler_is_quiet_yes(monkeypatch, capsys):
    monkeypatch.setattr(devsrc, "_metal_compiler_ok", lambda: True)
    assert devsrc._offer_metal_toolchain() is True
    assert "found on this Mac" in capsys.readouterr().out


def test_offer_declined(monkeypatch, capsys):
    _no_compiler(monkeypatch)
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    assert devsrc._offer_metal_toolchain() is False
    assert "cannot succeed" in capsys.readouterr().out


def test_offer_with_xcode_downloads_component(monkeypatch, capsys):
    _no_compiler(monkeypatch)
    monkeypatch.setattr(devsrc, "_xcode_usable", lambda: True)
    calls = []
    inputs = iter(["y"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(inputs))
    import subprocess as sp
    monkeypatch.setattr(sp, "run", lambda cmd, **kw: calls.append(cmd) or 0)
    # re-check after the download now passes
    monkeypatch.setattr(devsrc, "_metal_compiler_ok",
                        lambda: len(calls) > 0)
    assert devsrc._offer_metal_toolchain() is True
    assert ["xcodebuild", "-downloadComponent", "MetalToolchain"] in calls
    assert "kernels will build" in capsys.readouterr().out


def test_offer_without_xcode_opens_app_store(monkeypatch, capsys):
    _no_compiler(monkeypatch)
    monkeypatch.setattr(devsrc, "_xcode_usable", lambda: False)
    calls = []
    inputs = iter(["y", "y"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(inputs))
    import subprocess as sp
    monkeypatch.setattr(sp, "run",
                        lambda cmd, **kw: calls.append(cmd) or 0)
    assert devsrc._offer_metal_toolchain() is False
    assert any(c[0] == "open" and "macappstore" in c[1] for c in calls), \
        "must offer the App Store page — Xcode cannot be fetched via CLI"
    out = capsys.readouterr().out
    assert "downloadComponent" in out, "the follow-up command must be printed"


# ---- build-start preflight --------------------------------------------------

def test_build_stops_before_brew_when_toolchain_missing(home_cfg_plain,
                                                        monkeypatch):
    """The preflight must fire on the SAVED kernel answer too (not only
    the explicit flag) and return the 'toolchain' stage without ever
    reaching the brew subprocess / version stamping."""
    import sys as _sys

    monkeypatch.setattr(_sys, "stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr(devsrc, "_offer_metal_toolchain", lambda: False)
    res = home_cfg_plain()
    assert (res.ok, res.returncode, res.stage) == (False, 2, "toolchain")
    assert any("stopped BEFORE the build" in t for _, t in res.lines)


def test_build_preflight_skipped_when_not_a_tty(home_cfg_plain, monkeypatch):
    """Non-interactive runs must not block on the offer: they fall through
    to the formula guard instead (the fixture detonates at the stamp step
    right after the gate to prove flow continued without touching brew)."""
    import sys as _sys

    monkeypatch.setattr(_sys, "stdin", SimpleNamespace(isatty=lambda: False))
    called = []
    monkeypatch.setattr(devsrc, "_offer_metal_toolchain",
                        lambda: called.append(1) or True)

    with pytest.raises(AssertionError, match="reached the stamp step"):
        home_cfg_plain(break_after_preflight=True)
    assert not called, "the tty offer must not run headless"


@pytest.fixture()
def home_cfg_plain(tmp_path, monkeypatch):
    """run_dev_build harness (be1 pattern) with build_options = kernels,
    reaching the real build path unless a stage stops it first."""
    monkeypatch.setenv("UPLIFT_HOME", str(tmp_path / "uplift"))
    cfg = {"src_path": str(tmp_path / "dev-src"), "sync_ref": "origin/main",
           "formula_branch": "uplift-dev",
           "build_options": ["--with-custom-kernel"]}

    def _factory(break_after_preflight=False):
        monkeypatch.setattr(devsrc, "load_config",
                            lambda *a, **k: dict(cfg))
        (tmp_path / "dev-src" / ".git").mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(devsrc, "ensure_clone", lambda cfg: None)
        monkeypatch.setattr(devsrc, "worktree_clean", lambda p: True)
        monkeypatch.setattr(devsrc, "fetch_sync_ref", lambda cfg: None)
        from omlx_uplift import patchsource, curated
        monkeypatch.setattr(curated, "sync", lambda *a, **k: {"report": {}})
        monkeypatch.setattr(patchsource, "enabled_build_patches",
                            lambda store: [])
        monkeypatch.setattr(devsrc, "materialize",
                            lambda patches, cfg, **kw: {"ok": True,
                                                        "tip": "t" * 40,
                                                        "base": "b" * 40,
                                                        "commits": []})
        monkeypatch.setattr(devsrc, "recheck_build_patches",
                            lambda gated: {})
        if break_after_preflight:
            # stop at the stamp step: never let the test touch brew/git
            monkeypatch.setattr(
                devsrc, "_ensure_versioned_formula",
                lambda: (_ for _ in ()).throw(
                    AssertionError("reached the stamp step")))
        return devsrc.run_dev_build()

    return _factory
