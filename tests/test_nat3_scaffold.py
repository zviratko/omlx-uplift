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
    # U64: history literals lead the /bench band — the only dynamics that
    # could shadow them are 3-segment /bench/{run_id}/... shapes, and a
    # 2-segment literal can never collide; registration at the top keeps
    # the file's literal-before-dynamic discipline visible.
    ("GET", "/bench/history"),
    ("POST", "/bench/history/clear"),
    ("GET", "/bench/flag"),
    ("GET", "/bench/accuracy/tasks"),
    ("GET", "/bench/accuracy/harness-sizes"),   # U68 (literal, in-band)
    ("POST", "/bench/accuracy/add"),
    ("GET", "/bench/accuracy/queue"),
    ("DELETE", "/bench/accuracy/queue/{idx}"),
    ("GET", "/bench/accuracy/results"),
    ("POST", "/bench/accuracy/results/reset"),
    ("POST", "/bench/accuracy/cancel"),
    ("POST", "/bench/context/start"),
    ("GET", "/bench/context/active"),
    ("POST", "/bench/ane-tune/start"),
    ("GET", "/bench/ane-tune/results"),
    ("POST", "/bench/ane-tune/{tuning_id}/apply"),
    # REPL-4: embed literals + dynamics sit BEFORE the throughput 3-segment
    # dynamics — GET /bench/{run_id}/results would otherwise swallow
    # /bench/embed/results (run_id='embed'). Order is load-bearing.
    ("GET", "/bench/embed/tasks"),
    ("POST", "/bench/embed/start"),
    ("GET", "/bench/embed/active"),
    ("GET", "/bench/embed/results"),
    ("POST", "/bench/embed/results/reset"),
    ("POST", "/bench/embed/{run_id}/cancel"),
    ("GET", "/bench/embed/{run_id}/stream"),
    # REPL-4c: decision literals sit in the same literal-before-dynamic
    # band (GET /bench/{run_id}/results would otherwise swallow
    # /bench/decision/results); dynamics are 4-segment, immune anyway.
    ("GET", "/bench/decision/tasks"),
    ("POST", "/bench/decision/start"),
    ("GET", "/bench/decision/active"),
    ("GET", "/bench/decision/results"),
    ("POST", "/bench/decision/results/reset"),
    ("POST", "/bench/decision/{run_id}/cancel"),
    ("GET", "/bench/decision/{run_id}/stream"),
    ("POST", "/bench/start"),
    ("GET", "/bench/active"),
    ("GET", "/bench/{run_id}/stream"),
    ("POST", "/bench/{run_id}/cancel"),
    ("GET", "/bench/{run_id}/results"),
    # REPL-3 dynamics: 4-segment shapes — structurally immune to the
    # 3-segment /bench/{run_id}/... swallow; registered after them anyway.
    ("GET", "/bench/context/{bench_id}/stream"),
    ("POST", "/bench/context/{bench_id}/cancel"),
    ("GET", "/bench/context/{bench_id}/results"),
    ("GET", "/bench/ane-tune/{tuning_id}/results"),
    ("POST", "/bench/ane-tune/{tuning_id}/cancel"),
    ("GET", "/bench/accuracy/{bench_id}/stream"),
    ("GET", "/chat/key"),
    ("GET", "/chat/history"),
    ("GET", "/chat/history/export"),        # U77 literal BEFORE the dynamic
    ("GET", "/chat/history/{conv_id}"),
    ("POST", "/chat/history"),
    ("DELETE", "/chat/history/{conv_id}"),
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
    """GET /bench/accuracy/results must hit bench_accuracy_results (live
    since REPL-2a), not be swallowed by /bench/{run_id}/results — proven
    via engine identity: the dynamic handler gets called with
    run_id='accuracy' if shadowing regresses."""
    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base

    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True

    client = TestClient(app)
    # literal must NOT be swallowed by the dynamic /bench/{run_id}/results
    from omlx_uplift.routers import bench as bench_mod
    called = {}
    bench_mod.accuracy_engine.results_payload = lambda: called.setdefault("literal", True) or {"results": []}
    try:
        r = client.get("/uplift/api/bench/accuracy/results")
        assert r.status_code == 200 and called.get("literal")
    finally:
        del bench_mod.accuracy_engine.results_payload
    # dynamic shape resolves to the live bench_results handler (REPL-1):
    # monkeypatched engine -> unknown-id 404 proves identity (a stubbed
    # route would answer 501; a shadowed literal would hit this too)
    from omlx_uplift.routers import bench as bench_mod
    import types
    called = {}
    def _fake_get(run_id):
        called['id'] = run_id
        return None
    _orig_get = bench_mod.bench_engine.get
    bench_mod.bench_engine.get = _fake_get
    try:
        r = client.get("/uplift/api/bench/whatever123/results")
        assert r.status_code == 404
        assert called.get('id') == 'whatever123'
    finally:
        bench_mod.bench_engine.get = _orig_get


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


def test_u78_clean_message_params_sanitized():
    from omlx_uplift.routers.chat import _clean_message
    m = _clean_message({
        "role": "assistant", "content": "hi",
        "params": {"temperature": 0.3, "top_p": 0, "max_tokens": True,
                   "evil": {"nested": 1}, "enable_thinking": True,
                   "thinking_budget": 64}})
    assert m["params"] == {"temperature": 0.3, "top_p": 0,
                           "enable_thinking": True, "thinking_budget": 64}
    # bool excluded from numerics (True would sneak past isinstance int);
    # unknown keys and nested junk never persist; user rows carry none
    mu = _clean_message({"role": "user", "content": "x",
                         "params": {"temperature": 1}})
    assert "params" not in mu


def test_u77_export_route_precedes_dynamic():
    # the golden ORDER list pins it; this is the shadowing proof itself:
    # Starlette matches registration order, so /chat/history/export must
    # resolve to the export handler, never to conv_id='export'.
    from omlx_uplift.routers import chat as ch
    import inspect
    src = inspect.getsource(ch)
    assert src.index('"/chat/history/export"') < src.index('"/chat/history/{conv_id}"')
