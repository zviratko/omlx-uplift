"""SYNC-1 2026-10-22: formula build options are a first-class choice.

Fresh boxes have no vanilla omlx receipt to inherit --with-* options from,
so: bootstrap asks (custom kernels default ON, Metal toolchain named),
the answer is saved as dev.json 'build_options', the build resolves
explicit flag > saved answer > receipt inheritance, and an explicit flag
re-saves (sticky).
"""
import pytest

from omlx_uplift import devsrc


# ---- questionnaire parsing -------------------------------------------------

@pytest.fixture()
def answers(monkeypatch):
    def _feed(text):
        monkeypatch.setattr("builtins.input", lambda prompt="": text)
    return _feed


def test_ask_build_options_default_is_custom_kernel(answers, capsys):
    answers("")
    assert devsrc._ask_build_options() == ["--with-custom-kernel"]
    out = capsys.readouterr().out
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
    answers("1")
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
