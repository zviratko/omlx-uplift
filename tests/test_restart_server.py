"""Uplift-side /restart-server: supervisor detection + force pass.

Vanilla's /admin/api/server/restart knows only OMLX_SUPERVISED (menubar);
under `brew services` (launchd KeepAlive) it 503s although launchd WILL
respawn. The uplift endpoint detects the launchd job via XPC_SERVICE_NAME
and self-terminates; an undetectable supervisor arms the client's FORCE
path instead of raising.
"""
import pytest


# --------------------------------------------------------------------------
# _supervisor_kind
# --------------------------------------------------------------------------

def test_menubar_marker_wins_over_launchd():
    from omlx_uplift.routers.dev import _supervisor_kind

    k = _supervisor_kind({"OMLX_SUPERVISED": "menubar",
                          "XPC_SERVICE_NAME": "sh.brew.omlx"})
    assert k == "menubar"


def test_launchd_job_detected_by_xpc_service_name():
    from omlx_uplift.routers.dev import _supervisor_kind

    # the real value launchd injects for a `brew services` job
    assert _supervisor_kind({"XPC_SERVICE_NAME": "sh.brew.omlx"}) \
        == "launchd:sh.brew.omlx"


def test_blank_values_are_not_supervisors():
    from omlx_uplift.routers.dev import _supervisor_kind

    assert _supervisor_kind({"OMLX_SUPERVISED": "  ",
                             "XPC_SERVICE_NAME": ""}) is None


def test_plain_terminal_serve_is_unsupervised():
    from omlx_uplift.routers.dev import _supervisor_kind

    assert _supervisor_kind({"PATH": "/usr/bin", "HOME": "/u/x"}) is None


# --------------------------------------------------------------------------
# POST /restart-server handler
# --------------------------------------------------------------------------

@pytest.fixture
def restart_route(monkeypatch):
    """The handler with auth unwrapped and the detached kill captured."""
    from omlx_uplift.routers import dev as dev_mod

    launched = []

    class FakePopen:
        def __init__(self, argv, **kw):
            launched.append(argv)

    import subprocess
    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    monkeypatch.setattr(dev_mod, "require_admin", lambda request=None: True)
    return dev_mod.server_restart, launched


async def _call(handler, monkeypatch, env, force):
    from omlx_uplift.routers.dev import ServerRestartRequest

    monkeypatch.setenv("OMLX_SUPERVISED", "")  # absent-ish
    monkeypatch.delenv("OMLX_SUPERVISED", raising=False)
    for k in ("OMLX_SUPERVISED", "XPC_SERVICE_NAME"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return await handler(ServerRestartRequest(force=force), is_admin=True)


async def test_launchd_job_restarts_without_force(restart_route, monkeypatch):
    handler, launched = restart_route
    d = await _call(handler, monkeypatch,
                    {"XPC_SERVICE_NAME": "sh.brew.omlx"}, force=False)
    assert d["ok"] is True and d["restarting"] is True
    assert d["supervisor"] == "launchd:sh.brew.omlx"
    assert len(launched) == 1 and "kill -TERM" in launched[0][2]


async def test_menubar_restart_matches_vanilla_semantics(restart_route,
                                                         monkeypatch):
    handler, launched = restart_route
    d = await _call(handler, monkeypatch,
                    {"OMLX_SUPERVISED": "menubar"}, force=False)
    assert d["ok"] is True and d["supervisor"] == "menubar"


async def test_unsupervised_detection_miss_is_not_an_error(restart_route,
                                                           monkeypatch):
    handler, launched = restart_route
    d = await _call(handler, monkeypatch, {}, force=False)
    assert d["ok"] is False and d["supervised"] is False
    assert "FORCE" in d["detail"]
    assert launched == []          # nothing killed


async def test_force_kills_even_without_a_detectable_supervisor(
        restart_route, monkeypatch):
    handler, launched = restart_route
    d = await _call(handler, monkeypatch, {}, force=True)
    assert d["ok"] is True and d["forced"] is True
    assert len(launched) == 1


async def test_force_on_supervised_is_not_marked_forced(restart_route,
                                                        monkeypatch):
    # a force click when detection DID work stays an honest restart report
    handler, launched = restart_route
    d = await _call(handler, monkeypatch,
                    {"XPC_SERVICE_NAME": "sh.brew.omlx"}, force=True)
    assert d["ok"] is True and d["forced"] is False
