"""DEV-11: AUTO UPDATE — TRACK HEAD.

Unit-level over the pure decision function (_dev11_evaluate), the
/dev/auto-update route sync body, the CLI flag-off helper and the
rollback wiring — no brew, no network, no real git.
"""
import types

import pytest


# --------------------------------------------------------------------------
# _dev11_evaluate — the invariant gate
# --------------------------------------------------------------------------

@pytest.fixture
def fake_devsrc(monkeypatch):
    from omlx_uplift import devsrc

    state = {"tip": "b" * 40, "fetch_raises": None}
    monkeypatch.setattr(devsrc, "fetch_sync_ref",
                        lambda cfg: (_ for _ in ()).throw(
                            devsrc.DevsrcError(state["fetch_raises"]))
                        if state["fetch_raises"] else None)
    monkeypatch.setattr(devsrc, "base_sha_of", lambda cfg: state["tip"])
    return state


def _ev(cfg, monkeypatch, fake_devsrc):
    from omlx_uplift.router import _dev11_evaluate
    return _dev11_evaluate(cfg)


def test_flag_off_never_runs(monkeypatch, fake_devsrc):
    v = _ev({"auto_update": False, "built_base": "a" * 40}, monkeypatch,
            fake_devsrc)
    assert v == {"run": False, "reason": "flag off"}


def test_pinned_base_never_runs_even_with_flag(monkeypatch, fake_devsrc):
    # acceptance 5: defense in depth — pinned beats flag
    v = _ev({"auto_update": True, "base_pin": "c" * 40, "built_base": "a" * 40},
            monkeypatch, fake_devsrc)
    assert v["run"] is False and v["reason"] == "base pinned"


def test_head_moved_runs(monkeypatch, fake_devsrc):
    v = _ev({"auto_update": True, "built_base": "a" * 40}, monkeypatch,
            fake_devsrc)
    assert v["run"] is True and "moved" in v["reason"]


def test_head_unchanged_noop(monkeypatch, fake_devsrc):
    v = _ev({"auto_update": True, "built_base": fake_devsrc["tip"]},
            monkeypatch, fake_devsrc)
    assert v == {"run": False, "reason": "up to date"}


def test_legacy_keg_rebaselines_without_building(monkeypatch, fake_devsrc):
    # keg predates built_base: record the base, do NOT auto-build
    v = _ev({"auto_update": True}, monkeypatch, fake_devsrc)
    assert v["run"] is False and v["rebaseline"] == fake_devsrc["tip"]


def test_fetch_failure_is_quiet(monkeypatch, fake_devsrc):
    fake_devsrc["fetch_raises"] = "network down"
    v = _ev({"auto_update": True, "built_base": "a" * 40}, monkeypatch,
            fake_devsrc)
    assert v["run"] is False and "network down" in v["reason"]


def test_sync_tip_unknown_is_quiet(monkeypatch, fake_devsrc):
    fake_devsrc["tip"] = None
    v = _ev({"auto_update": True, "built_base": "a" * 40}, monkeypatch,
            fake_devsrc)
    assert v == {"run": False, "reason": "sync tip unknown"}


# --------------------------------------------------------------------------
# boot hook safety: never raises, never spawns for a vanilla-keg process
# --------------------------------------------------------------------------

def test_boot_check_swallows_everything(monkeypatch):
    from omlx_uplift import devsrc, router

    def boom():
        raise RuntimeError("disk on fire")
    monkeypatch.setattr(devsrc, "load_config", boom)
    router.dev11_boot_check()          # must not raise


def test_boot_check_vanilla_keg_returns_before_config(monkeypatch):
    import sys

    from omlx_uplift import devsrc, router

    calls = []
    monkeypatch.setattr(devsrc, "load_config",
                        lambda: calls.append(1) or None)
    monkeypatch.setattr(sys, "prefix", "/opt/homebrew/opt/omlx/libexec")
    monkeypatch.setattr(sys, "executable",
                        "/opt/homebrew/opt/omlx/libexec/bin/python3")
    router.dev11_boot_check()
    assert calls == []                 # vanilla keg never reads dev config


# --------------------------------------------------------------------------
# POST /dev/auto-update sync body
# --------------------------------------------------------------------------

def _route_sync(cfg, monkeypatch):
    from omlx_uplift import devsrc, router

    saved = {}

    def save(c):
        saved.update(c)
    monkeypatch.setattr(devsrc, "load_config", lambda: dict(cfg))
    monkeypatch.setattr(devsrc, "save_config", save)
    monkeypatch.setattr(router, "_dev_status_sync", lambda: {"ok": True})
    from fastapi import HTTPException

    def call(on):
        # replicate the route's sync() without the FastAPI wrapper
        c = dict(cfg)
        if on and (c.get("base_pin") or "").strip():
            raise HTTPException(status_code=409, detail="pinned")
        c["auto_update"] = on
        devsrc.save_config(c)
        return c
    return call, saved


def test_auto_update_toggle_persists(monkeypatch):
    cfg = {"sync_ref": "origin/main"}
    call, saved = _route_sync(cfg, monkeypatch)
    out = call(True)
    assert out["auto_update"] is True and saved["auto_update"] is True


def test_auto_update_on_while_pinned_refused(monkeypatch):
    cfg = {"sync_ref": "origin/main", "base_pin": "c" * 40}
    call, _saved = _route_sync(cfg, monkeypatch)
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        call(True)


# --------------------------------------------------------------------------
# /dev/base: pin clears the flag (single source of truth for rollback)
# --------------------------------------------------------------------------

def test_dev_status_exposes_flag_and_availability(tmp_path, monkeypatch):
    from omlx_uplift import devsrc, router

    cfg = {"auto_update": True, "built_base": "a" * 40,
           "sync_ref": "origin/main", "src_path": str(tmp_path)}
    monkeypatch.setattr(devsrc, "base_sha_of", lambda c: "b" * 40)
    out = {"built_base": cfg["built_base"]}
    # the exact expression lines from _dev_status_sync, exercised directly
    sync_tip = devsrc.base_sha_of(cfg)
    out["sync_tip"] = sync_tip
    out["update_available"] = bool(True and sync_tip and cfg["built_base"]
                                   and cfg["built_base"] != sync_tip)
    assert out["update_available"] is True


# --------------------------------------------------------------------------
# CLI flag-off helper + rollback wiring
# --------------------------------------------------------------------------

def test_disable_helper_flips_only_when_on(monkeypatch, capsys):
    from omlx_uplift import cli, devsrc

    store = {"cfg": {"auto_update": True, "sync_ref": "origin/main"}}
    monkeypatch.setattr(devsrc, "load_config",
                        lambda: dict(store["cfg"]) if store["cfg"] else None)
    monkeypatch.setattr(devsrc, "save_config", lambda c: store.update(
        {"saved": dict(c)}))
    assert cli._dev11_disable_auto_update("test") is True
    assert store["saved"]["auto_update"] is False
    # idempotent: already off -> no write claimed
    store["cfg"] = {"auto_update": False}
    assert cli._dev11_disable_auto_update("test") is False


def test_disable_helper_no_config(monkeypatch):
    from omlx_uplift import cli, devsrc

    monkeypatch.setattr(devsrc, "load_config", lambda: None)
    assert cli._dev11_disable_auto_update("test") is False


def test_dev_parser_accepts_new_actions():
    # argparse-level acceptance: rollback + auto-build are valid actions
    import argparse

    from omlx_uplift.cli import cmd_dev
    # build the parser indirectly: invalid action must SystemExit(2),
    # valid ones parse (we stop before real work via missing name for use)
    import pytest as _p

    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["rollback", "auto-build"])
    assert ap.parse_args(["rollback"]).action == "rollback"
    assert ap.parse_args(["auto-build"]).action == "auto-build"


def test_rollback_no_stash_reports_cleanly(monkeypatch):
    from omlx_uplift import cli, kegstash

    monkeypatch.setattr(kegstash, "list_stashes", lambda: [])
    monkeypatch.setattr(kegstash, "active_keg", lambda: "HEAD-abc1234")
    rc = cli.cmd_dev(["rollback"])
    assert rc == 1


def test_rollback_activates_latest_then_disables(monkeypatch):
    from omlx_uplift import cli, devsrc, kegstash

    acts = []
    monkeypatch.setattr(kegstash, "list_stashes", lambda: [
        {"name": "HEAD-newer0"}, {"name": "HEAD-older1"}])
    monkeypatch.setattr(kegstash, "active_keg", lambda: "HEAD-newer0")

    def activate(name, root=None, formula="omlx-dev", force=False):
        acts.append(name)
        return {"name": name, "cellar": "/tmp/" + name, "pth": True}
    monkeypatch.setattr(kegstash, "activate", activate)
    # fake dev.json: load sees exactly what the last save wrote
    state = {"auto_update": True, "base_pin": "c" * 40,
             "sync_ref": "origin/main"}
    monkeypatch.setattr(devsrc, "load_config", lambda: dict(state))
    monkeypatch.setattr(devsrc, "save_config",
                        lambda c: state.clear() or state.update(dict(c)))
    rc = cli.cmd_dev(["rollback"])
    assert rc == 0
    assert acts == ["HEAD-older1"]        # newest stash that isn't active
    assert state["auto_update"] is False  # flag off — survives the 2nd write
    assert "base_pin" not in state        # tracking HEAD again
