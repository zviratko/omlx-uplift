"""DEV-5: /dev/status, /dev/build, /dev/reconfigure endpoints.

Unit-level over _dev_status_sync + the sync helpers the routes wrap — no
brew, no network. Real HTTP wiring is one-liner Depends wrappers; the
import of router.py proves FastAPI accepts the signatures.
"""
import json
import types

import pytest

# SPLIT-1: handlers resolve globals in their OWNING routers module; patch
# targets follow the code (the router.py facade keeps working for classes).
from omlx_uplift.routers import dev as dev_mod
from omlx_uplift.routers import patches as patches_mod


# --------------------------------------------------------------------------
# /dev/status
# --------------------------------------------------------------------------

def test_status_not_installed_without_config(tmp_path, monkeypatch):
    from omlx_uplift import devsrc, router

    monkeypatch.setattr(devsrc, "load_config", lambda: None)
    st = dev_mod._dev_status_sync()
    assert st["installed"] is False
    assert "dev bootstrap" in st["reason"]


def test_status_not_installed_when_clone_missing(tmp_path, monkeypatch):
    from omlx_uplift import devsrc, router

    cfg = {"src_dir": str(tmp_path / "nope"), "branch": "uplift-dev",
           "sync_ref": "origin/main", "base_sha": "x" * 40}
    monkeypatch.setattr(devsrc, "load_config", lambda: cfg)
    monkeypatch.setattr(patches_mod, "patch_store", lambda: None)
    monkeypatch.setattr("omlx_uplift.patchsource.enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(devsrc, "src_path", lambda c: str(tmp_path / "nope"))
    # status() itself would inspect the real clone — prove the router's own
    # clone-missing guard overrides whatever status() reports
    monkeypatch.setattr(devsrc, "status",
                        lambda c, p, **kw: {"installed": True, "branch": "x"})
    st = dev_mod._dev_status_sync()
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
    got = dev_mod._dev_share_realized(cfg)
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
    monkeypatch.setattr(patches_mod, "patch_store", lambda: None)
    monkeypatch.setattr("omlx_uplift.patchsource.enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr(devsrc, "src_path", lambda c: str(tmp_path / "nope"))
    (tmp_path / "nope" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "status",
                        lambda c, p, residue_patches=None:
                        {"installed": True, "branch": "uplift-dev",
                         "tip": "c" * 40, "drift": {"drift": False},
                         "ahead": 0, "behind": 0})
    monkeypatch.setattr(devsrc, "expected_tip",
                        lambda p, c: {"ok": True, "tip": "c" * 40})
    monkeypatch.setattr(devsrc, "runtime_config",
                        lambda c: {"port": 8001, "base_path": str(tmp_path)})
    monkeypatch.setattr(devsrc, "vanilla_port", lambda: 8000)
    monkeypatch.setattr(devsrc, "share_map", lambda c: {})
    monkeypatch.setattr(dev_mod, "_dev_share_realized", lambda c: {})
    import omlx_uplift.cli as cli
    monkeypatch.setattr(cli, "_service_state", lambda f: "stopped")

    st = dev_mod._dev_status_sync()
    assert st["installed"] is True
    # built b*40 vs expected c*40 -> stale
    assert st["stale"] is True
    assert st["expected_tip"] == "c" * 40
    assert st["port"] == 8001 and st["vanilla_port"] == 8000
    # BUILD-ZONE honesty fields exist even when the classify probe cannot
    # run (fake src path -> no git repo -> unknown built base -> strict
    # sha verdict, so the warning still lights — fail-safe, never silent)
    assert st["needs_rebuild"] is True
    assert st["build_ahead"] is False
    assert st["base_stale"] is False
    # the verdict explains itself (shown as a visible line + logged)
    assert st["build_reason"]


def test_build_state_transitions_log_once_not_per_poll(tmp_path, monkeypatch, caplog):
    # the dashboard polls every few seconds; a standing problem must log its
    # WARNING once on the transition (user: "this should be a warning in
    # there" — but a 5s flood would bury every other log line)
    import logging
    from omlx_uplift import devsrc, router
    cfg = {"src_dir": str(tmp_path / "nope"), "branch": "uplift-dev",
           "sync_ref": "origin/main", "base_sha": "a" * 40,
           "built_sha": "b" * 40}
    monkeypatch.setattr(devsrc, "load_config", lambda: cfg)
    monkeypatch.setattr(patches_mod, "patch_store", lambda: None)
    monkeypatch.setattr("omlx_uplift.patchsource.enabled_build_patches",
                        lambda store, with_bytes=True: [])
    monkeypatch.setattr("omlx_uplift.patchsource.build_residue_pool",
                        lambda store, enabled: [])
    monkeypatch.setattr(devsrc, "src_path", lambda c: str(tmp_path / "nope"))
    (tmp_path / "nope" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "status",
                        lambda c, p, **kw: {"installed": True, "branch": "x",
                                            "tip": "c" * 40,
                                            "drift": {"drift": False},
                                            "ahead": 0, "behind": 0})
    monkeypatch.setattr(devsrc, "expected_tip",
                        lambda p, c: {"ok": True, "tip": "c" * 40})
    monkeypatch.setattr(devsrc, "runtime_config",
                        lambda c: {"port": 8001, "base_path": str(tmp_path)})
    monkeypatch.setattr(devsrc, "vanilla_port", lambda: 8000)
    monkeypatch.setattr(devsrc, "share_map", lambda c: {})
    monkeypatch.setattr(dev_mod, "_dev_share_realized", lambda c: {})
    import omlx_uplift.cli as cli
    monkeypatch.setattr(cli, "_service_state", lambda f: "stopped")
    dev_mod._LAST_BUILD_STATE.clear()

    with caplog.at_level(logging.DEBUG, logger="omlx_uplift.dev"):
        for _ in range(3):
            dev_mod._dev_status_sync()
    warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warns) == 1, "transition must log exactly once"
    assert "build [" in warns[0].getMessage()


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
    monkeypatch.setattr(dev_mod, "_dev_status_sync", lambda: {"installed": True})
    req = dev_mod.DevReconfigureRequest(port=8010, share=["models"],
                                       no_share=["model_settings"])
    res = dev_mod._dev_reconfigure_sync(req)
    assert res["ok"] is True
    assert seen["port"] == 8010
    assert seen["share"] == ["models"] and seen["no_share"] == ["model_settings"]
    assert seen["interactive"] is False


def test_reconfigure_nonzero_maps_to_not_ok(tmp_path, monkeypatch):
    from omlx_uplift import cli, router

    monkeypatch.setattr(cli, "cmd_dev_reconfigure", lambda ns: 1)
    monkeypatch.setattr(dev_mod, "_dev_status_sync", lambda: {})
    res = dev_mod._dev_reconfigure_sync(dev_mod.DevReconfigureRequest(port=1))
    assert res["ok"] is False


# --------------------------------------------------------------------------
# /dev/build job guard
# --------------------------------------------------------------------------

def test_build_job_guard_blocks_second_start(monkeypatch):
    import threading
    from omlx_uplift import router  # SPLIT-1: facade for classes/api_router
    from omlx_uplift.routers import dev as dev_mod

    started = threading.Event()
    release = threading.Event()

    def slow(opts):
        started.set()
        release.wait(5)

    monkeypatch.setattr(dev_mod, "_dev_build_run", slow)
    with dev_mod._DEV_BUILD_LOCK:
        dev_mod._DEV_BUILD.update({"running": False, "result": None, "log": []})

    import asyncio
    req = dev_mod.DevBuildRequest()
    # dev_build is a coroutine fn w/ Depends; call it directly, is_admin patched in
    async def go():
        loop = asyncio.get_running_loop()
        first = await dev_mod.dev_build(req, True)
        await asyncio.wait_for(loop.run_in_executor(None, started.wait), 5)
        second = await dev_mod.dev_build(req, True)
        release.set()
        return first, second
    first, second = asyncio.run(go())
    try:
        assert first == {"started": True}
        assert second["started"] is False and second["running"] is True
    finally:
        with dev_mod._DEV_BUILD_LOCK:
            dev_mod._DEV_BUILD.update({"running": False, "result": None,
                                      "log": []})


def test_dev_build_run_reports_crash(monkeypatch):
    from omlx_uplift import devsrc, router

    def boom(**kw):
        raise RuntimeError("brew exploded")

    monkeypatch.setattr(devsrc, "run_dev_build", boom)
    with dev_mod._DEV_BUILD_LOCK:
        dev_mod._DEV_BUILD.update({"running": True, "result": None, "log": []})
    dev_mod._dev_build_run({})
    assert dev_mod._DEV_BUILD["running"] is False
    assert dev_mod._DEV_BUILD["result"] == 1
    assert "brew exploded" in dev_mod._DEV_BUILD["log"][-1]


# --------------------------------------------------------------------------
# static wiring: routes registered + UI keys shipped
# --------------------------------------------------------------------------

def test_dev_routes_registered():
    from omlx_uplift import router  # SPLIT-1: facade for classes/api_router
    from omlx_uplift.routers import dev as dev_mod

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


def test_failed_build_log_keeps_materialize_reason(monkeypatch):
    # DEV-10: the log must carry the engine's error lines AND the
    # intact-keg reassurance. BE-1: errors ride BuildResult.lines now —
    # no stdout capture, no scraping.
    from omlx_uplift import devsrc, router

    def fake_build(**kw):
        return devsrc.BuildResult(
            ok=False, stage="materialize", returncode=1,
            lines=[("err", "materialize FAILED: patch p-bad does not "
                           "apply cleanly"),
                   ("err", "fix or disable the named patch, then re-run")])

    monkeypatch.setattr(devsrc, "run_dev_build", fake_build)
    with dev_mod._DEV_BUILD_LOCK:
        dev_mod._DEV_BUILD.update({"running": False, "result": None, "log": []})
    dev_mod._dev_build_run({"restart_after": False})
    with dev_mod._DEV_BUILD_LOCK:
        log = list(dev_mod._DEV_BUILD["log"])
        assert dev_mod._DEV_BUILD["result"] == 1
    assert any("materialize FAILED" in l for l in log), log
    assert any("intact" in l for l in log), log


def test_successful_build_log_stays_quiet(monkeypatch):
    from omlx_uplift import devsrc, router

    def fake_build(**kw):
        return devsrc.BuildResult(ok=True, stage="ok", returncode=0,
                                  lines=[("out", "omlx-dev built")])

    monkeypatch.setattr(devsrc, "run_dev_build", fake_build)
    with dev_mod._DEV_BUILD_LOCK:
        dev_mod._DEV_BUILD.update({"running": False, "result": None, "log": []})
    dev_mod._dev_build_run({"restart_after": False})
    with dev_mod._DEV_BUILD_LOCK:
        log = list(dev_mod._DEV_BUILD["log"])
        assert dev_mod._DEV_BUILD["result"] == 0
    assert log == [], log   # success adds nothing


def _stub_dev_tree(tmp_path, monkeypatch, devsrc):
    """LANE P helper: the smallest /dev/status that reaches the runtime line
    (the shape test_status_stale_flag_matches_expected_tip builds)."""
    cfg = {"src_dir": str(tmp_path / "nope"), "branch": "uplift-dev",
           "sync_ref": "origin/main", "base_sha": "a" * 40,
           "built_sha": "c" * 40}
    monkeypatch.setattr(devsrc, "load_config", lambda: cfg)
    monkeypatch.setattr(patches_mod, "patch_store", lambda: None)
    monkeypatch.setattr("omlx_uplift.patchsource.enabled_build_patches",
                        lambda store: [])
    monkeypatch.setattr("omlx_uplift.patchsource.build_residue_pool",
                        lambda store, enabled: [])
    monkeypatch.setattr(devsrc, "src_path", lambda c: str(tmp_path / "nope"))
    (tmp_path / "nope" / ".git").mkdir(parents=True)
    monkeypatch.setattr(devsrc, "status",
                        lambda c, p, residue_patches=None:
                        {"installed": True, "branch": "uplift-dev",
                         "tip": "c" * 40, "drift": {"drift": False},
                         "ahead": 0, "behind": 0})
    monkeypatch.setattr(devsrc, "expected_tip",
                        lambda p, c: {"ok": True, "tip": "c" * 40})
    monkeypatch.setattr(devsrc, "runtime_config",
                        lambda c: {"port": 8001, "base_path": str(tmp_path)})
    monkeypatch.setattr(devsrc, "vanilla_port", lambda: 8000)
    monkeypatch.setattr(devsrc, "share_map", lambda c: {})
    monkeypatch.setattr(dev_mod, "_dev_share_realized", lambda c: {})
    return cfg


def test_status_reports_the_vanilla_service_state(tmp_path, monkeypatch):
    # LANE P (item 6c): the isolation strip prints BOTH services on one line,
    # so /dev/status answers for the vanilla `omlx` service as well as for
    # omlx-dev — and it must ask the SAME helper, by name, not guess.
    from omlx_uplift import cli, devsrc
    _stub_dev_tree(tmp_path, monkeypatch, devsrc)

    asked = []

    def fake_state(formula):
        asked.append(formula)
        return "started" if formula == "omlx" else "stopped"

    monkeypatch.setattr(cli, "_service_state", fake_state)
    st = dev_mod._dev_status_sync()
    assert asked.count("omlx") == 1, "the vanilla probe must name omlx"
    assert asked.count("omlx-dev") == 1, "the dev probe lost its own question"
    assert st["service_running"] is False
    assert st["vanilla_service_running"] is True

    def fake_down(formula):
        return "stopped"

    monkeypatch.setattr(cli, "_service_state", fake_down)
    assert dev_mod._dev_status_sync()["vanilla_service_running"] is False


def test_vanilla_service_probe_never_raises(monkeypatch):
    # LANE P: this feeds a POLL. brew missing, a timeout, junk json — 'cannot
    # tell' must land as False (not running), never as an exception that takes
    # the whole /dev/status response down with it.
    from omlx_uplift import cli

    def seam_looks_real(formula):        # module label of the real helper
        raise AssertionError("must not be reached")
    seam_looks_real.__module__ = "omlx_uplift.cli"
    monkeypatch.setattr(cli, "_service_state", seam_looks_real)

    def boom(formula="omlx-dev"):
        raise RuntimeError("brew exploded")
    monkeypatch.setattr(dev_mod, "_dev_service_info", boom)
    assert dev_mod._dev_service_up("omlx") is False

    def junk(formula="omlx-dev"):
        return {"status": None, "running": None}
    monkeypatch.setattr(dev_mod, "_dev_service_info", junk)
    assert dev_mod._dev_service_up("omlx") is False

    def up(formula="omlx-dev"):
        return {"status": "started", "pid": 42}
    monkeypatch.setattr(dev_mod, "_dev_service_info", up)
    assert dev_mod._dev_service_up("omlx") is True
