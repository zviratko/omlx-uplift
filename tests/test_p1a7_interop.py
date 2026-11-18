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
    # SYNC-1 run 27: the failure report names section.key, not just the
    # section - the materialization exception needs the finer granularity.
    assert "integrations.say_voices changed or removed" in out
    assert "secret-api-key" not in out
    assert "secret-signing-key" not in out
    assert "Old Voice" not in out
    assert "BEFORE was" not in out


def _drive_round_trip(tmp_path, monkeypatch, capsys, original, get_payload, apply_post):
    """Run interop.main() against a fake server; apply_post mutates the
    settings file the way the server's save() would. Returns (rc, out)."""
    settings = tmp_path / "settings.json"
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
            return Response(get_payload)
        apply_post(settings)
        return Response({})

    monkeypatch.setattr(interop, "req", fake_req)
    rc = interop.main()
    return rc, capsys.readouterr().out, settings


def test_materialized_server_default_passes_with_note(tmp_path, monkeypatch, capsys):
    # SYNC-1 run 27 (upstream c8213a1 #5337): save() serializes the FULL
    # effective settings, so the first save after an upgrade ADDS a key the
    # file never carried, with the value the GET reported as effective.
    # Classic's own saves do the same; the round-trip must accept it, name
    # it, and keep the materialized file (no restore on pass).
    original = json.dumps({"integrations": {"splash_kv_format": "int8"}}).encode()
    got = {"integrations": {"splash_kv_format": "int8", "splash_activations": "bf16"}}

    def apply_post(settings):
        d = json.loads(settings.read_text())
        d["integrations"]["splash_activations"] = "bf16"
        settings.write_text(json.dumps(d))

    rc, out, settings = _drive_round_trip(tmp_path, monkeypatch, capsys,
                                          original, got, apply_post)
    assert rc == 0
    assert "materialized server defaults" in out
    assert "integrations.splash_activations" in out
    assert json.loads(settings.read_text())["integrations"]["splash_activations"] == "bf16"


def test_added_key_with_foreign_value_still_fails(tmp_path, monkeypatch, capsys):
    # The exception is ONLY for the server's own reported effective value:
    # a key that appears with something the GET never said is payload drift.
    original = json.dumps({"integrations": {"splash_kv_format": "int8"}}).encode()
    got = {"integrations": {"splash_kv_format": "int8", "splash_activations": "bf16"}}

    def apply_post(settings):
        d = json.loads(settings.read_text())
        d["integrations"]["splash_activations"] = "auto"
        settings.write_text(json.dumps(d))

    rc, out, settings = _drive_round_trip(tmp_path, monkeypatch, capsys,
                                          original, got, apply_post)
    assert rc == 1
    assert "integrations.splash_activations changed or removed" in out
    assert settings.read_bytes() == original
