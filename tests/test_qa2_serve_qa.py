"""QA-2: `omlx-uplift serve --qa` isolation semantics.

The seed is a pure file function — testable without booting omlx. The
guard against pointing the QA base at the production base is tested
through cmd_serve's early-return path (it fires before any omlx import).
"""

import json
from pathlib import Path

from omlx_uplift.cli import _qa_seed_settings, cmd_serve


def _mk_real(tmp: Path, port=8011) -> Path:
    real = tmp / "real" / "settings.json"
    real.parent.mkdir(parents=True)
    real.write_text(json.dumps({
        "server": {"port": port, "host": "0.0.0.0"},
        "auth": {"api_key": "secret-key-do-not-log"},
        "models": {"a": {"model_directory": "/x"}, "b": {"model_directory": "/y"}},
    }, indent=2), encoding="utf-8")
    return real


def test_seed_rewrites_port_keeps_key_and_never_touches_real(tmp_path):
    real = _mk_real(tmp_path)
    before = real.read_bytes()
    qa = tmp_path / "qa" / "settings.json"
    info = _qa_seed_settings(real, qa, 8099)
    assert info == {"models": 2, "port": 8099}
    data = json.loads(qa.read_text())
    assert data["server"]["port"] == 8099          # QA port wins
    assert data["auth"]["api_key"] == "secret-key-do-not-log"  # editor login works
    assert set(data["models"]) == {"a", "b"}
    assert real.read_bytes() == before             # production file untouched


def test_seed_creates_missing_parent_dirs(tmp_path):
    real = _mk_real(tmp_path)
    qa = tmp_path / "deep" / "nested" / "settings.json"
    _qa_seed_settings(real, qa, 8099)
    assert qa.is_file()


def test_qa_refuses_production_base(tmp_path, monkeypatch):
    # cmd_serve must exit 2 BEFORE importing omlx when the QA base
    # resolves to the production base. Point HOME at a tmp tree where
    # .omlx exists, then ask for exactly that base.
    (tmp_path / ".omlx").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    rc = cmd_serve(["--qa", "--qa-base", str(tmp_path / ".omlx")])
    assert rc == 2


def test_qa_refuses_when_nothing_to_seed(tmp_path, monkeypatch):
    # no real settings AND no qa settings -> clear failure, no half-state
    (tmp_path / ".omlx").mkdir()
    qa = tmp_path / "qa-base"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    rc = cmd_serve(["--qa", "--qa-base", str(qa)])
    assert rc == 2
    assert not (qa / "settings.json").exists()
