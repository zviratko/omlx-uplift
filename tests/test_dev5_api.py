"""DEV-5: /dev/status, /dev/build, /dev/reconfigure endpoints.

Unit-level over _dev_status_sync + the sync helpers the routes wrap — no
brew, no network. Real HTTP wiring is one-liner Depends wrappers; the
import of router.py proves FastAPI accepts the signatures.
"""
import json
import types

import pytest


# --------------------------------------------------------------------------
# /dev/status
# --------------------------------------------------------------------------

def test_status_not_installed_without_config(tmp_path, monkeypatch):
    from omlx_uplift import devsrc, router

    monkeypatch.setattr(devsrc, "load_config", lambda: None)
    st = router._dev_status_sync()
    assert st["installed"] is False
    assert "dev install" in st["reason"]


def test_status_not_installed_when_clone_missing(tmp_path, monkeypatch):
    from omlx_uplift import devsrc, router

    cfg = {"src_dir": str(tmp_path / "nope"), "branch": "uplift-dev",
           "sync_ref": "origin/main", "base_sha": "x" * 40}
    monkeypatch.setattr(devsrc, "load_config", lambda: cfg)
    monkeypatch.setattr(router, "patch_store", lambda: None)
    monkeypatch.setattr("omlx_uplift.patchsource.enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(devsrc, "src_path", lambda c: str(tmp_path / "nope"))
    # status() itself would inspect the real clone — prove the router's own
    # clone-missing guard overrides whatever status() reports
    monkeypatch.setattr(devsrc, "status",
                        lambda c, p: {"installed": True, "branch": "x"})
    st = router._dev_status_sync()
    assert st["installed"] is False


def test_share_realized_detects_symlink_vs_private(tmp_path, monkeypatch):
    import os

    from omlx_uplift import devsrc, router

    vanilla = tmp_path / "vanilla"
    dev = tmp_path / "dev"
    vanilla.mkdir(); dev.mkdir()
    (vanilla / "model_settings.json").write_text("{}")
    # models dir: dev points at vanilla (shared); settings: private file
    (vanilla / "models").mkdir()
    (dev / "models").symlink_to(vanilla / "models")
    (dev / "model_settings.json").write_text("{}")

    monkeypatch.setattr(devsrc, "vanilla_base", lambda: str(vanilla))
    cfg = {"port": 8001, "base_path": str(dev),
           "share": {"models": True, "model_settings": True,
                     "model_profiles": False}}
    got = router._dev_share_realized(cfg)
    assert got["models"]["ok"] and got["models"]["actual"] == "symlink"
    # wants model_settings shared but it's a private file -> OUT OF SYNC
    assert got["model_settings"]["ok"] is False
    assert got["model_settings"]["actual"] == "private"
    # wants profiles private, it IS absent -> ok
    assert got["model_profiles"]["ok"] is True


def test_status_stale_flag_matches_expected_tip(tmp_path, monkeypatch):
    from omlx_uplift import devsrc, router

    cfg = {"src_dir": str(tmp_path / "nope"), "branch": "uplift-dev",
           "sync_ref": "origin/main", "base_sha": "a" * 40,
           "built_sha": "b" * 40}
    monkeypatch.setattr(devsrc, "load_config", lambda: cfg)
    monkeypatch.setattr(router, "patch_store", lambda: None)
    monkeypatch.setattr("omlx_uplift.patchsource.enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(devsrc, "src_path", lambda c: str(tmp_path / "nope"))
    (tmp_path / "nope" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "status",
                        lambda c, p: {"installed": True, "branch": "uplift-dev",
                                      "tip": "c" * 40, "drift": {"drift": False},
                                      "ahead": 0, "behind": 0})
    monkeypatch.setattr(devsrc, "expected_tip",
                        lambda p, c: {"ok": True, "tip": "c" * 40})
    monkeypatch.setattr(devsrc, "runtime_config",
                        lambda c: {"port": 8001, "base_path": str(tmp_path)})
    monkeypatch.setattr(devsrc, "vanilla_port", lambda: 8000)
    monkeypatch.setattr(devsrc, "share_map", lambda c: {})
    monkeypatch.setattr(router, "_dev_share_realized", lambda c: {})
    import omlx_uplift.cli as cli
    monkeypatch.setattr(cli, "_service_state", lambda f: "stopped")

    st = router._dev_status_sync()
    assert st["installed"] is True
    # built b*40 vs expected c*40 -> stale
    assert st["stale"] is True
    assert st["expected_tip"] == "c" * 40
    assert st["port"] == 8001 and st["vanilla_port"] == 8000


# --------------------------------------------------------------------------
# /dev/reconfigure wrapper
# --------------------------------------------------------------------------

def test_reconfigure_passes_options_through(tmp_path, monkeypatch):
    from omlx_uplift import cli, router

    seen = {}

    def fake_reconf(ns):
        seen.update(vars(ns))
        return 0

    monkeypatch.setattr(cli, "cmd_dev_reconfigure", fake_reconf)
    monkeypatch.setattr(router, "_dev_status_sync", lambda: {"installed": True})
    req = router.DevReconfigureRequest(port=8010, share=["models"],
                                       no_share=["model_settings"])
    res = router._dev_reconfigure_sync(req)
    assert res["ok"] is True
    assert seen["port"] == 8010
    assert seen["share"] == ["models"] and seen["no_share"] == ["model_settings"]
    assert seen["interactive"] is False


def test_reconfigure_nonzero_maps_to_not_ok(tmp_path, monkeypatch):
    from omlx_uplift import cli, router

    monkeypatch.setattr(cli, "cmd_dev_reconfigure", lambda ns: 1)
    monkeypatch.setattr(router, "_dev_status_sync", lambda: {})
    res = router._dev_reconfigure_sync(router.DevReconfigureRequest(port=1))
    assert res["ok"] is False


# --------------------------------------------------------------------------
# /dev/build job guard
# --------------------------------------------------------------------------

def test_build_job_guard_blocks_second_start(monkeypatch):
    import threading
    from omlx_uplift import router

    started = threading.Event()
    release = threading.Event()

    def slow(opts):
        started.set()
        release.wait(5)

    monkeypatch.setattr(router, "_dev_build_run", slow)
    with router._DEV_BUILD_LOCK:
        router._DEV_BUILD.update({"running": False, "result": None, "log": []})

    import asyncio
    req = router.DevBuildRequest()
    # dev_build is a coroutine fn w/ Depends; call it directly, is_admin patched in
    async def go():
        loop = asyncio.get_running_loop()
        first = await router.dev_build(req, True)
        await asyncio.wait_for(loop.run_in_executor(None, started.wait), 5)
        second = await router.dev_build(req, True)
        release.set()
        return first, second
    first, second = asyncio.run(go())
    try:
        assert first == {"started": True}
        assert second["started"] is False and second["running"] is True
    finally:
        with router._DEV_BUILD_LOCK:
            router._DEV_BUILD.update({"running": False, "result": None,
                                      "log": []})


def test_dev_build_run_reports_crash(monkeypatch):
    from omlx_uplift import cli, router

    def boom(ns):
        raise RuntimeError("brew exploded")

    monkeypatch.setattr(cli, "cmd_dev_upgrade", boom)
    with router._DEV_BUILD_LOCK:
        router._DEV_BUILD.update({"running": True, "result": None, "log": []})
    router._dev_build_run({})
    assert router._DEV_BUILD["running"] is False
    assert router._DEV_BUILD["result"] == 1
    assert "brew exploded" in router._DEV_BUILD["log"][-1]


# --------------------------------------------------------------------------
# static wiring: routes registered + UI keys shipped
# --------------------------------------------------------------------------

def test_dev_routes_registered():
    from omlx_uplift import router

    paths = {r.path for r in router.api_router.routes}
    assert {"/dev/status", "/dev/build", "/dev/reconfigure"} <= paths


def test_locale_gate_covers_dev_keys():
    import re
    from pathlib import Path

    static = Path(__file__).resolve().parents[1] / "omlx_uplift" / "static"
    locales = Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"
    src = "\n".join(p.read_text(encoding="utf-8")
                    for p in static.glob("*.js")) + \
        (static / "index.html").read_text(encoding="utf-8")
    dev_keys = set(re.findall(r"uplift\.patches\.dev_[a-z_]+", src))
    dev_keys |= set(re.findall(r"uplift\.patches\.(?:lbl_scope|scope_[a-z_]+)", src))
    assert dev_keys, "no DEV-5 keys found — wiring lost?"
    for lang in ["en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-TW", "zh", "cs"]:
        d = json.loads((locales / f"{lang}.json").read_text(encoding="utf-8"))
        missing = {k for k in dev_keys if k not in d}
        assert not missing, f"{lang}: {sorted(missing)}"
