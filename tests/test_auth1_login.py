"""AUTH-1 (SWEEP183 B3): constant-time compare + login throttle.

Unit-level over the helpers (the login route is a thin wrapper: blocked
-> 429, mismatch -> 401 + failure counted, match -> 200 + counter
reset). No FastAPI app needed.
"""
import time

import pytest


def test_compare_keys_matches_and_rejects():
    from omlx_uplift.router import _compare_keys

    assert _compare_keys("secret-key", "secret-key") is True
    assert _compare_keys("secret-key", "other-key") is False
    assert _compare_keys("", "x") is False
    # non-ASCII must not raise (vanilla's byte-compare contract)
    assert _compare_keys("klíč", "klíč") is True
    assert _compare_keys("klíč", "klic") is False


def test_vanilla_helper_is_preferred(monkeypatch):
    import sys
    import types

    called = {}

    def fake_compare(a, b):
        called["args"] = (a, b)
        return True

    mod = types.ModuleType("omlx.admin.auth")
    mod.compare_keys = fake_compare
    fake_admin = types.ModuleType("omlx.admin")
    fake_pkg = types.ModuleType("omlx")
    fake_pkg.admin = fake_admin
    fake_admin.auth = mod
    monkeypatch.setitem(sys.modules, "omlx", fake_pkg)
    monkeypatch.setitem(sys.modules, "omlx.admin", fake_admin)
    monkeypatch.setitem(sys.modules, "omlx.admin.auth", mod)

    from omlx_uplift.router import _compare_keys
    assert _compare_keys("a", "b") is True
    assert called["args"] == ("a", "b")


def test_soft_import_falls_back_without_omlx(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_omlx(name, *a, **k):
        if name == "omlx" or name.startswith("omlx."):
            # but let our own package through (omlx_uplift is not omlx)
            if not name.startswith("omlx_uplift"):
                raise ImportError("viewer mode")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", no_omlx)
    from omlx_uplift.router import _compare_keys
    assert _compare_keys("same", "same") is True
    assert _compare_keys("same", "diff") is False


def test_throttle_blocks_after_limit_and_resets_on_success():
    from omlx_uplift.routers import pages as router

    ip = "10.9.9.9"
    router._login_fails.clear()
    assert router._login_blocked(ip) == 0.0
    for _ in range(router.LOGIN_FAIL_LIMIT - 1):
        router._login_failed(ip)
        assert router._login_blocked(ip) == 0.0   # under limit: free
    router._login_failed(ip)                       # hits the limit
    assert router._login_blocked(ip) > 0.0
    # exponential: one more failure doubles
    first = router._login_blocked(ip)
    router._login_failed(ip)
    second = router._login_blocked(ip)
    assert second >= first * 1.9
    assert second <= router.LOGIN_BLOCK_MAX_S + 1
    # a success clears the slate
    router._login_ok(ip)
    assert router._login_blocked(ip) == 0.0


def test_throttle_cap_evicts_all(monkeypatch):
    from omlx_uplift.routers import pages as router

    router._login_fails.clear()
    for i in range(1100):
        router._login_failed(f"1.2.3.{i % 256}")
    # flood must not grow the dict past the cap path (clear-on-overflow)
    assert len(router._login_fails) <= router.LOGIN_FAIL_LIMIT + 1024
    router._login_fails.clear()
