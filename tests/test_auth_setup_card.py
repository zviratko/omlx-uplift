"""AUTH-SETUP (SYNC-1 2026-10-22): first-run API key handling.

A fresh server has no auth.api_key; vanilla's login page then shows a
CREATE-key form (POSTing to /admin/api/setup-api-key, loopback-only,
one-time) instead of a login that can never succeed. The uplift wall must
mirror that mode and must never answer the un-matchable state with a false
'Invalid API key' that feeds the brute-force throttle.
"""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omlx_uplift.routers import pages


@pytest.fixture()
def client():
    pages._login_fails.clear()
    app = FastAPI()
    app.include_router(pages.page_router)
    yield TestClient(app)
    pages._login_fails.clear()


def _set_key(monkeypatch, key):
    gs = SimpleNamespace(auth=SimpleNamespace(api_key=key))
    monkeypatch.setattr(pages, "global_settings", lambda: gs)


def test_login_get_shows_setup_card_when_no_key(client, monkeypatch):
    _set_key(monkeypatch, None)
    body = client.get("/uplift/login").text
    assert "Set Up API Key" in body
    assert "/admin/api/setup-api-key" in body
    # NOT the login card
    assert "Admin Login" not in body


def test_login_get_shows_setup_card_for_empty_key(client, monkeypatch):
    _set_key(monkeypatch, "")
    assert "Set Up API Key" in client.get("/uplift/login").text


def test_login_get_shows_login_card_when_key_set(client, monkeypatch):
    _set_key(monkeypatch, "sekrit")
    body = client.get("/uplift/login").text
    assert "Admin Login" in body
    assert "Set Up API Key" not in body
    assert "setup-api-key" not in body


def test_login_get_fail_open_without_server(client, monkeypatch):
    """Viewer/standalone (no vanilla settings reachable): keep the login
    card — do not advertise a setup flow nobody can complete."""
    def boom():
        raise RuntimeError("no server state")
    monkeypatch.setattr(pages, "global_settings", boom)
    assert "Admin Login" in client.get("/uplift/login").text

    monkeypatch.setattr(pages, "global_settings", lambda: None)
    assert "Admin Login" in client.get("/uplift/login").text


def test_admin_key_configured_shape_tolerant(monkeypatch):
    _set_key(monkeypatch, "k")
    assert pages._admin_key_configured() is True
    # a settings object without .auth must not crash the wall
    monkeypatch.setattr(pages, "global_settings",
                        lambda: SimpleNamespace())
    assert pages._admin_key_configured() is True


def test_post_no_key_state_is_400_and_not_throttled(client, monkeypatch):
    _set_key(monkeypatch, None)
    r = client.post("/uplift/login", json={"api_key": "whatever"})
    assert r.status_code == 400
    assert "no API key configured" in r.json()["detail"]
    # a state error must not burn the 5-tries lockout
    assert not pages._login_fails


def test_post_wrong_key_still_401_and_counts(client, monkeypatch):
    _set_key(monkeypatch, "sekrit")
    r = client.post("/uplift/login", json={"api_key": "nope"})
    assert r.status_code == 401
    assert pages._login_fails, "wrong keys must keep feeding the throttle"
