"""ABOUT-1: GET /uplift/api/about — the admin-only environment card.

The frontend renders this contract verbatim, so the KEY SET is the
load-bearing thing under test (extra keys are fine, a renamed or missing
one is a broken panel):

    omlx_version str|None | uplift_version str | dev bool | keg str|None
    python_version str | macos_version str | arch str
    chip str|None | ram_bytes int|None | model_dir str|None

Pinned here:
  * the route exists on api_router and is admin-gated (dependency graph,
    the same check NAT-3 uses — it holds with AND without omlx);
  * unauthenticated rejection matches an existing admin route's answer
    (needs the real omlx.admin.auth, so it skips on CI like the rest of
    the omlx-bound legs);
  * the authenticated shape: every key present, every type right, and the
    no-secrets rule (keg/model_dir paths are deliberate, an api_key is not);
  * HARDWARE PROBE discipline: sysctl/system_profiler run at most ONCE per
    process for all requests combined, and a probe failure answers null
    instead of a 500;
  * model_dir answers from the paths.py family-A ladder when the server
    state is not reachable (the no-omlx/CI shape).
"""
from __future__ import annotations

import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift.routers import apiinfo as A

CONTRACT = {
    "omlx_version": (str, type(None)),
    "uplift_version": (str,),
    "dev": (bool,),
    "keg": (str, type(None)),
    "python_version": (str,),
    "macos_version": (str,),
    "arch": (str,),
    "chip": (str, type(None)),
    "ram_bytes": (int, type(None)),
    "model_dir": (str, type(None)),
}


def _deps(route):
    out = []
    stack = [route.dependant]
    while stack:
        d = stack.pop()
        out.append(d)
        stack.extend(d.dependencies)
    return out


@pytest.fixture()
def client(monkeypatch):
    """Admin granted (the shared dependency-overrides harness) and the
    hardware cache pre-armed, so no test ever shells out to sysctl or
    system_profiler behind the suite's back."""
    from omlx_uplift.routers import base as up_base

    monkeypatch.setattr(A, "_HW_CACHE",
                        {"chip": "Apple M3 Ultra", "ram_bytes": 51539607552})
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture()
def bare_client():
    """NO dependency override: the real require_admin decides (macOS keg
    python only — CI has no omlx, see conftest)."""
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    return TestClient(app, raise_server_exceptions=False)


# ------------------------------------------------------- registration/gating

def test_about_route_is_registered():
    paths = {(m, r.path) for r in _up.api_router.routes for m in r.methods}
    assert ("GET", "/about") in paths


def test_about_route_is_admin_gated():
    """The keg path carries the username, so this route must never be
    reachable unauthenticated the way the public /identity is."""
    route = next(r for r in _up.api_router.routes
                 if r.path == "/about" and "GET" in r.methods)
    assert "require_admin" in str([d.call for d in _deps(route)])
    identity = next(r for r in _up.api_router.routes if r.path == "/identity")
    assert "require_admin" not in str([d.call for d in _deps(identity)])


def test_about_unauthenticated_matches_other_admin_routes(bare_client):
    pytest.importorskip("omlx.admin.auth")   # CI: no omlx -> skip, never red
    mine = bare_client.get("/uplift/api/about")
    theirs = bare_client.get("/uplift/api/retention")   # existing admin GET
    assert mine.status_code == theirs.status_code, (mine.status_code,
                                                    theirs.status_code)
    assert mine.status_code in (401, 403), mine.status_code
    assert "chip" not in mine.text


# ------------------------------------------------------------- contract shape

def test_about_answers_every_contract_key_with_the_right_type(client):
    r = client.get("/uplift/api/about")
    assert r.status_code == 200, r.text
    body = r.json()
    missing = [k for k in CONTRACT if k not in body]
    assert not missing, f"contract keys dropped: {missing}"
    for key, types in CONTRACT.items():
        assert isinstance(body[key], types), (key, type(body[key]), types)
    assert isinstance(body["dev"], bool)      # bool, not a truthy string
    assert not isinstance(body["ram_bytes"], bool)


def test_about_answers_from_the_serving_process(client):
    """U10/BUILD-1 doctrine: the answers describe THIS interpreter — dev and
    keg must agree with the serving prefix, uplift_version with our package."""
    import platform
    import sys as _sys

    from omlx_uplift import __version__ as uplift_v
    from omlx_uplift import paths as _paths

    body = client.get("/uplift/api/about").json()
    assert body["keg"] == _sys.prefix
    assert body["dev"] == bool(
        _paths.is_dev_prefix(_sys.prefix, _sys.executable))
    assert body["uplift_version"] == uplift_v
    assert body["python_version"] == platform.python_version()
    assert body["arch"] == platform.machine()


def test_about_carries_no_secrets(client):
    body = client.get("/uplift/api/about").json()
    flat = " ".join(f"{k} {v}" for k, v in body.items()).lower()
    for banned in ("api_key", "apikey", "serial", "password", "token"):
        assert banned not in flat, banned


# ------------------------------------------------------------ probe discipline

def test_hardware_probe_runs_once_for_all_requests(client, monkeypatch):
    """"Never run it per request after the first success" — proven with
    counters on the two probe functions (the route calls them through the
    module globals, so the stubs are what the handler sees)."""
    calls = {"chip": 0, "ram_bytes": 0}

    def chip():
        calls["chip"] += 1
        return "Apple M1 Max"

    def ram():
        calls["ram_bytes"] += 1
        return 34359738368

    monkeypatch.setattr(A, "_HW_CACHE", {})
    monkeypatch.setattr(A, "_chip_sync", chip)
    monkeypatch.setattr(A, "_ram_bytes_sync", ram)
    for _ in range(3):
        body = client.get("/uplift/api/about").json()
        assert body["chip"] == "Apple M1 Max"
        assert body["ram_bytes"] == 34359738368
    assert calls == {"chip": 1, "ram_bytes": 1}


def test_probe_failure_answers_null_not_500(client, monkeypatch):
    """A broken/absent binary must cost a line on the card, never the card."""
    def boom():
        raise RuntimeError("no system_profiler here")

    monkeypatch.setattr(A, "_HW_CACHE", {})
    monkeypatch.setattr(A, "_chip_sync", boom)
    monkeypatch.setattr(A, "_ram_bytes_sync", boom)
    r = client.get("/uplift/api/about")
    assert r.status_code == 200, r.text
    assert r.json()["chip"] is None
    assert r.json()["ram_bytes"] is None


@pytest.mark.skipif(not sys.platform.startswith("darwin"),
                    reason="needs the macOS probe binaries")
def test_real_probe_shape_on_macos():
    """Drift guard for the REAL binaries (the stubs above cannot catch a
    renamed sysctl key): chip is a string that names silicon, ram is a
    plausible byte count."""
    chip = A._chip_sync()
    assert isinstance(chip, str) and chip, chip
    ram = A._ram_bytes_sync()
    assert isinstance(ram, int) and not isinstance(ram, bool)
    assert 1 << 30 <= ram < 1 << 44, ram


# ------------------------------------------------------- loop discipline (PERF-1)

async def test_hardware_probe_does_not_starve_the_event_loop(monkeypatch):
    """PERF-1 harness shape (see test_perf1_event_loop.py): the probe waits
    on an Event nobody sets; work run straight on the loop starves the
    heartbeat, work in asyncio.to_thread does not. This is the ONLY thing
    that pins 'system_profiler never runs on the event loop' — a stubbed
    count test cannot see the thread it happened on."""
    import asyncio
    import threading

    ev = threading.Event()
    monkeypatch.setattr(A, "_HW_CACHE", {})
    monkeypatch.setattr(A, "_chip_sync", lambda: (ev.wait(5), "Apple M3 Ultra")[1])
    monkeypatch.setattr(A, "_ram_bytes_sync", lambda: 1)

    ticks = []

    async def heartbeat(stop):
        while not stop.is_set():
            await asyncio.sleep(0.01)
            ticks.append(1)

    stop = asyncio.Event()
    hb = asyncio.create_task(heartbeat(stop))
    await asyncio.sleep(0.05)
    before = len(ticks)
    task = asyncio.create_task(A._hardware_facts())
    await asyncio.sleep(0.08)
    alive = len(ticks) - before
    ev.set()                     # release the pool thread (teardown joins it)
    await asyncio.wait_for(task, 5)
    stop.set()
    await hb
    assert alive >= 3, (
        f"event loop starved while the hardware probe blocked ({alive} ticks "
        "in 130 ms) — the probe must run via asyncio.to_thread")


async def test_a_hanging_probe_times_out_to_null_not_a_hung_request(monkeypatch):
    """The probe leg carries a hard ceiling: a slow/blocked system_profiler
    costs a null line on the card, never a request that never answers."""
    import time

    monkeypatch.setattr(A, "_HW_CACHE", {})
    monkeypatch.setattr(A, "_HW_PROBE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(A, "_chip_sync",
                        lambda: (time.sleep(0.4), "slow")[1])
    monkeypatch.setattr(A, "_ram_bytes_sync",
                        lambda: (time.sleep(0.4), 1)[1])
    started = time.monotonic()
    chip, ram = await A._hardware_facts()
    elapsed = time.monotonic() - started
    assert chip is None and ram is None
    assert elapsed < 1.0, f"the probe timeout is not enforced ({elapsed:.2f}s)"


def test_probe_ceiling_is_short():
    """Structural pin for the line above: a ceiling longer than a few seconds
    is a frozen About panel waiting to happen."""
    assert 0 < A._HW_PROBE_TIMEOUT_S <= 10.0


# ------------------------------------------------------------------- model_dir

def test_model_dir_falls_back_to_the_paths_ladder(monkeypatch, tmp_path):
    """No reachable server state (viewer mode / CI without omlx): the answer
    comes from the SAME base-dir ladder paths.py uses for the running server
    ($OMLX_BASE_PATH -> ~/.omlx), never from a hardcoded guess."""
    def no_server():
        raise ModuleNotFoundError("No module named 'omlx'", name="omlx")

    monkeypatch.setattr(A, "global_settings", no_server)
    monkeypatch.setattr("omlx_uplift.paths.server_base_dir", lambda: tmp_path)
    assert A._model_dir_sync() == str(tmp_path / "models")


def test_model_dir_without_omlx_is_a_real_models_path(monkeypatch):
    """The no-omlx shape CI takes: global_settings() is None (module imports,
    server never initialised) and the env/home ladder answers. Type + shape
    only — the exact base is machine state the test must not assert."""
    from pathlib import Path as _P

    monkeypatch.setattr(A, "global_settings", lambda: None)
    got = A._model_dir_sync()
    assert isinstance(got, str) and got
    assert _P(got).name == "models", got


def test_model_dir_honours_the_running_servers_setting(monkeypatch):
    """Classic's own resolver wins when the server answers: a configured
    model_dirs list outranks base_path/models."""
    from pathlib import Path as _P

    class Model:
        def get_model_dirs(self, base):
            return [_P("/models/first"), _P("/models/second")]

    class GS:
        base_path = _P("/srv/.omlx")
        model = Model()

    monkeypatch.setattr(A, "global_settings", lambda: GS)
    assert A._model_dir_sync() == "/models/first"


def test_model_dir_never_raises(monkeypatch):
    def boom():
        raise RuntimeError("server state exploded")

    monkeypatch.setattr(A, "global_settings", boom)
    monkeypatch.setattr("omlx_uplift.paths.server_base_dir", boom)
    assert A._model_dir_sync() is None
