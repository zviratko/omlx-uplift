"""NAT-6: native + classic embed ship side by side, native is the default.

The kill-switch default moved 'off' -> 'all' so a nav click opens the native
surface, while the classic embed stays reachable per viewer (navbar
"Classic (Embed)" + the switch badge in each embed card). These tests pin the
server contract the frontend fallback relies on; the UI wiring itself is
tests/nat6-classic-fallback.test.cjs.
"""
import json

from omlx_uplift import native_surfaces


def _point(monkeypatch, tmp_path):
    monkeypatch.setattr(native_surfaces, "config_path", lambda: tmp_path / "config.json")


def test_default_is_all(monkeypatch, tmp_path):
    _point(monkeypatch, tmp_path)
    assert native_surfaces.DEFAULT == "all"
    assert native_surfaces.server_value() == "all"
    assert native_surfaces.resolve(None) == "all"
    assert native_surfaces.enabled("all", "bench") and native_surfaces.enabled("all", "chat")


def test_off_still_selects_embed_default(monkeypatch, tmp_path):
    """A server can still opt every surface out — the embed path is intact,
    it is no longer what ships by default."""
    _point(monkeypatch, tmp_path)
    native_surfaces.write_config("off")
    assert native_surfaces.server_value() == "off"
    assert native_surfaces.enabled("off", "bench") is False


def test_per_surface_values_unchanged(monkeypatch, tmp_path):
    _point(monkeypatch, tmp_path)
    for v in ("bench", "chat"):
        native_surfaces.write_config(v)
        assert native_surfaces.enabled(v, v) is True
        assert native_surfaces.enabled(v, "bench" if v == "chat" else "chat") is False


def test_unknown_config_falls_back_to_default(monkeypatch, tmp_path):
    """A corrupt/hand-edited value must land on the SHIPPED surface (all),
    not a dead one."""
    _point(monkeypatch, tmp_path)
    (tmp_path / "config.json").write_text(
        json.dumps({native_surfaces.CONFIG_KEY: "garbage"}), encoding="utf-8")
    assert native_surfaces.server_value() == native_surfaces.DEFAULT
    assert native_surfaces.resolve(None) == native_surfaces.DEFAULT
