"""Settings discovery and failure safety for the live settings round-trip."""
import importlib.util
import json
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "p1a7_interop", Path(__file__).parent / "ui" / "p1a7_interop.py")
interop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(interop)


def test_vanilla_settings_win_when_both_exist(tmp_path):
    vanilla = tmp_path / ".omlx" / "settings.json"
    dev = tmp_path / ".omlx-dev" / "settings.json"
    vanilla.parent.mkdir()
    dev.parent.mkdir()
    vanilla.touch()
    dev.touch()
    assert interop.default_settings(tmp_path) == vanilla


def test_dev_settings_are_the_live_fallback(tmp_path):
    dev = tmp_path / ".omlx-dev" / "settings.json"
    dev.parent.mkdir()
    dev.touch()
    assert interop.default_settings(tmp_path) == dev


def test_missing_configs_still_point_at_the_dev_attempt(tmp_path):
    # main() must report one honest skip for this path, never silently pass.
    assert interop.default_settings(tmp_path) == tmp_path / ".omlx-dev" / "settings.json"


def test_failed_round_trip_restores_bytes_and_redacts_secrets(tmp_path, monkeypatch, capsys):
    settings = tmp_path / "settings.json"
    original = json.dumps({
        "auth": {"api_key": "secret-api-key", "secret_key": "secret-signing-key"},
        "integrations": {"say_voices": {"en-US": "Old Voice"}},
    }).encode()
    settings.write_bytes(original)
    monkeypatch.setattr("sys.argv", ["p1a7_interop.py", "--settings", str(settings),
                                    "--base", "http://qa.invalid"])

    class Response:
        status = 200
        def __init__(self, payload):
            self.payload = payload
        def read(self):
            return json.dumps(self.payload).encode()

    def fake_req(opener, url, data=None, headers=None, method=None):
        if url.endswith("/login"):
            return Response({})
        if data is None:
            return Response({"integrations": {"say_voices": {"en-US": "Old Voice"}}})
        # Simulate a server that normalizes a persisted value during POST.
        changed = json.loads(settings.read_text())
        changed["integrations"]["say_voices"] = {}
        settings.write_text(json.dumps(changed))
        return Response({})

    monkeypatch.setattr(interop, "req", fake_req)
    assert interop.main() == 1
    assert settings.read_bytes() == original
    out = capsys.readouterr().out
    assert "changed sections: integrations" in out
    assert "secret-api-key" not in out
    assert "secret-signing-key" not in out
    assert "Old Voice" not in out
    assert "BEFORE was" not in out
