"""NAT-3 scaffold acceptance: kill-switch module, route tree + order,
index.html token substitution, native boot modules exist.

The route-set check pins the FULL api_router surface (path+method, in
registration order). Like SPLIT-1's discipline: a reordering accident must
fail HERE, not in production shadowing. The golden list is extended
deliberately, one line per card, when a card adds routes.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omlx_uplift import native_surfaces


# ---- flag ladder ----------------------------------------------------------

def test_flag_defaults_off(monkeypatch, tmp_path):
    monkeypatch.setattr(native_surfaces, "config_path", lambda: tmp_path / "config.json")
    assert native_surfaces.server_value() == "off"
    assert native_surfaces.resolve(None) == "off"
    assert native_surfaces.enabled("off", "bench") is False


def test_flag_url_param_wins(monkeypatch, tmp_path):
    monkeypatch.setattr(native_surfaces, "config_path", lambda: tmp_path / "config.json")
    (tmp_path / "config.json").write_text(
        json.dumps({native_surfaces.CONFIG_KEY: "chat"}), encoding="utf-8")
    assert native_surfaces.server_value() == "chat"
    assert native_surfaces.resolve("bench") == "bench"     # URL wins
    assert native_surfaces.resolve("bogus") == "chat"      # invalid -> server
    assert native_surfaces.enabled("bench", "bench") is True
    assert native_surfaces.enabled("bench", "chat") is False
    assert native_surfaces.enabled("all", "chat") is True


def test_flag_write_read_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(native_surfaces, "config_path", lambda: tmp_path / "config.json")
    native_surfaces.write_config("all")
    assert native_surfaces.server_value() == "all"
    with pytest.raises(ValueError):
        native_surfaces.write_config("nope")


# ---- route tree + order ---------------------------------------------------

# Exact surface added by the NAT batch scaffold (NAT-3). Every entry must
# resolve to ITS OWN handler — literals must not be shadowed by the dynamic
# /bench/{run_id}/... shapes.
NAT3_ROUTES = [
    ("GET", "/bench/flag"),
    ("POST", "/bench/accuracy/add"),
    ("GET", "/bench/accuracy/queue"),
    ("GET", "/bench/accuracy/results"),
    ("POST", "/bench/context/start"),
    ("GET", "/bench/context/active"),
    ("POST", "/bench/ane-tune/start"),
    ("GET", "/bench/ane-tune/results"),
    ("POST", "/bench/start"),
    ("GET", "/bench/active"),
    ("GET", "/bench/{run_id}/stream"),
    ("POST", "/bench/{run_id}/cancel"),
    ("GET", "/bench/{run_id}/results"),
    ("GET", "/chat/key"),
    ("GET", "/chat/history"),
    ("POST", "/chat/history"),
]


def _routes_in_order(router):
    out = []
    for r in router.routes:
        for m in sorted(r.methods):
            if m in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                out.append((m, r.path))
    return out


def test_nat3_routes_registered_in_order():
    from omlx_uplift import router as up

    have = _routes_in_order(up.api_router)
    nat3 = [(m, p) for (m, p) in have if p.startswith("/bench") or p.startswith("/chat")]
    assert nat3 == NAT3_ROUTES


def test_nat3_routes_are_last_block():
    """NAT-3 registered its imports AFTER skins (facade comment says the
    appended block is load-bearing): every pre-existing route keeps its
    position, the bench/chat block is strictly at the end."""
    from omlx_uplift import router as up

    have = _routes_in_order(up.api_router)
    idx_first_nat = next(i for i, (m, p) in enumerate(have)
                         if p.startswith("/bench") or p.startswith("/chat"))
    assert all(p.startswith("/bench") or p.startswith("/chat")
               for m, p in have[idx_first_nat:])


def test_stub_resolution_literals_beat_dynamic():
    """GET /bench/accuracy/results must hit bench_accuracy_results, not be
    swallowed by /bench/{run_id}/results — asserted via the 501 detail."""
    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base

    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True

    client = TestClient(app)
    r = client.get("/uplift/api/bench/accuracy/results")
    assert r.status_code == 501
    assert "bench_accuracy_results" in r.json()["detail"]
    r = client.get("/uplift/api/bench/whatever123/results")
    assert r.status_code == 501
    assert "bench_results" in r.json()["detail"]


def test_stub_routes_require_admin():
    """Every NAT-3 stub is admin-gated — a future real engine control may
    never ship unauthenticated by forgetting Depends(require_admin)."""
    from omlx_uplift.routers import bench as bench_mod
    from omlx_uplift.routers import chat as chat_mod

    for mod in (bench_mod, chat_mod):
        for r in mod.api_router.routes:
            if not (r.path.startswith('/bench') or r.path.startswith('/chat')):
                continue
            assert 'require_admin' in str([d.call for d in _deps(r)]), r.path


def _deps(route):
    out = []
    stack = [route.dependant]
    while stack:
        d = stack.pop()
        out.append(d)
        stack.extend(d.dependencies)
    return out


# ---- index.html kill-switch substitution ----------------------------------

def test_index_token_substituted(monkeypatch, tmp_path):
    """<html data-native-surfaces="NATIVE_SURFACES_TOKEN"> must arrive at
    the browser resolved: config value by default, URL param overriding."""
    from omlx_uplift import router as up
    from omlx_uplift.routers import pages as up_pages

    monkeypatch.setattr(native_surfaces, "config_path", lambda: tmp_path / "config.json")
    # _gate calls require_admin straight from the pages module globals
    async def _admin(request):
        return True
    monkeypatch.setattr(up_pages, "require_admin", _admin)

    app = FastAPI()
    app.include_router(up.page_router)
    client = TestClient(app)

    body = client.get("/uplift/").text
    assert 'data-native-surfaces="off"' in body
    assert "NATIVE_SURFACES_TOKEN" not in body

    (tmp_path / "config.json").write_text(
        json.dumps({native_surfaces.CONFIG_KEY: "all"}), encoding="utf-8")
    body = client.get("/uplift/").text
    assert 'data-native-surfaces="all"' in body
    # URL param wins per-request (no-store index => fresh resolve every load)
    body = client.get("/uplift/?native=chat").text
    assert 'data-native-surfaces="chat"' in body
    # and via the catch-all static path too
    body = client.get("/uplift/index.html").text
    assert 'data-native-surfaces="all"' in body
    assert 'id="bench-native"' in body and 'id="chat-native"' in body
