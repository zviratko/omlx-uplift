"""DEV surface (SPLIT-1): omlx-dev build-scope management
(DEV-5/6/7/11) + the uplift-side server restart. Server truth is
file-backed (dev.json + dev-src git state) by design (DEV-context 8);
all git/brew/cli work runs in the threadpool. `from . import cli` MUST
stay function-local: cli imports viewer imports router — a head import
here is a cycle."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from .base import (api_router, page_router, require_admin, _RedirectToLogin,
                   engine_pool, settings_manager, global_settings,
                   _require_settings_manager, STATIC_DIR, _no_api_cache)
from ..request_log import RING_LIMIT, get_request_tracker
from ..collector import get_collector
from .patches import patch_store   # sibling routers module, not ..patches the store


# --------------------------------------------------------------------------
# DEV (omlx-dev, DEV-5): build-scope patch management surface. Server truth
# is file-backed (dev.json + dev-src git state) — unlike the rest of the
# settings surface this IS server state, by design (DEV-context 8). Thin
# wrappers over devsrc/cli; all git/brew work runs in the threadpool.
# --------------------------------------------------------------------------

_DEV_BUILD = {"running": False, "log": [], "result": None}


_DEV_BOOT = {"running": False, "log": [], "result": None}


_DEV_BUILD_LOCK = threading.Lock()


def _dev_share_realized(cfg: dict) -> dict:
    """Per knob: what the dev base path actually holds vs the share map."""
    import os

    from .. import devsrc

    base = os.path.expanduser(devsrc.runtime_config(cfg)["base_path"])
    vanilla = devsrc.vanilla_base()
    out = {}
    for name, want in devsrc.share_map(cfg).items():
        fname = devsrc.SHARE_FILENAMES.get(name, name)
        target = os.path.join(base, fname)
        src = os.path.join(vanilla, fname)
        if os.path.islink(target):
            has = os.path.realpath(target) == os.path.realpath(src)
            kind = "symlink" if has else "foreign-symlink"
        elif os.path.exists(target):
            kind = "private"
        else:
            kind = "missing"
        out[name] = {"shared_wanted": bool(want), "actual": kind,
                     "ok": (kind == "symlink") == bool(want)}
    return out


def _iso_to_epoch(s: str) -> float:
    from datetime import datetime

    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return dt.timestamp()


def _dev_service_age(cfg: dict):
    """Seconds since the omlx-dev service process STARTED, or None when the
    service is not running. ps etime is locale-proof; a missing/unparseable
    value returns None (unknown, never a false 'fresh')."""
    import subprocess

    try:
        info = subprocess.run(["brew", "services", "info", "omlx-dev",
                               "--json"], capture_output=True, text=True,
                              timeout=30)
        data = json.loads(info.stdout or "[]")
        pid = (data[0].get("pid") if isinstance(data, list) and data
               else None)
        if not pid:
            return None
        out = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=10)
        et = out.stdout.strip()
        if not et:
            return None
        # [[dd-]hh:]mm:ss
        parts = et.split("-")
        days = int(parts[0]) if len(parts) == 2 else 0
        bits = [int(x) for x in (parts[-1] if len(parts) == 2 else et).split(":")]
        while len(bits) < 3:
            bits.insert(0, 0)
        h, m, s = bits[-3:]
        return days * 86400 + h * 3600 + m * 60 + s
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _dev_boot_state() -> dict:
    """DEV-7(d): bootstrap progress rides EVERY status path — the not-
    installed view is exactly where a dashboard bootstrap runs."""
    with _DEV_BUILD_LOCK:
        return dict(_DEV_BOOT, log=list(_DEV_BOOT["log"][-20:]))


def _dev_status_sync() -> dict:
    from .. import cli, devsrc, patchsource

    cfg = devsrc.load_config()
    if not cfg:
        return {"installed": False,
                "reason": "dev.json missing — run: omlx-uplift dev bootstrap",
                "bootstrap": _dev_boot_state()}
    import os

    clone_ok = os.path.isdir(os.path.join(devsrc.src_path(cfg), ".git"))
    build_patches = patchsource.enabled_build_patches(patch_store())
    out = devsrc.status(cfg, build_patches if clone_ok else None)
    if not clone_ok:
        out["installed"] = False
        out["bootstrap"] = _dev_boot_state()
        return out
    # staleness: built keg vs the tip the CURRENT patch set would produce
    # (expected_tip replays materialize in a throwaway worktree — git-only,
    # deterministic shas)
    exp = devsrc.expected_tip(build_patches, cfg)
    built = cfg.get("built_sha")
    out["built_sha"] = built
    out["expected_tip"] = exp.get("tip")
    out["stale"] = bool(exp.get("ok")) and built != exp.get("tip")
    # DEV-11: AUTO UPDATE — TRACK HEAD. The tip probe is LOCAL-only (rev-parse
    # of the already-fetched sync ref) — the boot hook fetches first, the
    # dashboard poll must never pay for network.
    out["auto_update"] = bool(cfg.get("auto_update"))
    try:
        out["sync_tip"] = devsrc.base_sha_of(cfg)
    except devsrc.DevsrcError:
        out["sync_tip"] = None
    out["update_available"] = bool(out["auto_update"] and out["sync_tip"]
                                   and cfg.get("built_base")
                                   and cfg["built_base"] != out["sync_tip"])
    out["service_running"] = cli._service_state("omlx-dev") in (
        "started", "running")
    # RESTART NEEDED (DEV-6): the keg exists at tip but the RUNNING process
    # booted before the build finished. Wall-clock compare: the service's
    # start time is derived from `ps etime`; unknown age => never claim fresh.
    built_at = cfg.get("built_at")
    started_wall = None
    if out["service_running"]:
        age = _dev_service_age(cfg)
        if age is not None:
            started_wall = time.time() - age
    out["restart_needed"] = bool(built_at and started_wall is not None
                                 and _iso_to_epoch(built_at) > started_wall)
    rt = devsrc.runtime_config(cfg)
    out["port"] = rt["port"]
    out["base_path"] = rt["base_path"]
    out["vanilla_port"] = devsrc.vanilla_port()
    out["vanilla_base_path"] = devsrc.vanilla_base()
    out["share_configured"] = devsrc.share_map(cfg)
    out["share_filenames"] = dict(devsrc.SHARE_FILENAMES)
    out["share_realized"] = _dev_share_realized(cfg)
    with _DEV_BUILD_LOCK:
        out["build"] = dict(_DEV_BUILD, log=list(_DEV_BUILD["log"][-20:]))
        out["bootstrap"] = dict(_DEV_BOOT, log=list(_DEV_BOOT["log"][-20:]))
    out["build_patches"] = [{"id": p["id"], "version": p.get("version")}
                            for p in build_patches]
    return out


@api_router.get("/dev/status")
async def dev_status(is_admin: bool = Depends(require_admin)):
    return await asyncio.to_thread(_dev_status_sync)


class DevBuildRequest(BaseModel):
    with_custom_kernel: Optional[bool] = None   # None = inherit receipt
    with_grammar: Optional[bool] = None
    restart_after: bool = False                  # DEV-6: REBUILD AND RESTART


def _dev_build_run(opts: dict) -> None:
    from types import SimpleNamespace

    from .. import cli

    try:
        # capture stdout+stderr so re-gate failures (needs_review lines,
        # DEV-context 9) reach the UI instead of dying in a terminal nobody
        # watches
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.cmd_dev_install(SimpleNamespace(
                with_custom_kernel=bool(opts.get("with_custom_kernel")),
                with_grammar=bool(opts.get("with_grammar")),
                dry_run=False))
        with _DEV_BUILD_LOCK:
            lines = (out.getvalue() + err.getvalue()).splitlines()
            # DEV-10: on failure the FULL tail matters — "materialize
            # FAILED: <patch> ..." is the answer to "why?", and the old
            # keyword filter dropped exactly that line.
            keep = [l.strip() for l in lines
                    if "re-gate FAILED" in l or "needs_review" in l
                    or "build FAILED" in l]
            if rc != 0:
                tail = [l.strip() for l in lines[-20:] if l.strip()]
                for l in tail:
                    if l not in keep:
                        keep.append(l)
                keep.append("the previous omlx-dev keg and branch are "
                            "intact — nothing to roll back; fix or disable "
                            "the named patch, then rebuild")
            _DEV_BUILD["log"].extend(keep)
    except Exception as exc:  # never leave the job stuck on "running"
        rc = 1
        with _DEV_BUILD_LOCK:
            _DEV_BUILD["log"].append(f"build crashed: {exc}")
    restart_after = bool(opts.get("restart_after")) and rc == 0
    with _DEV_BUILD_LOCK:
        _DEV_BUILD["running"] = False
        _DEV_BUILD["result"] = rc
    if restart_after:
        # detached (the builder thread's own server may be the dev service)
        import subprocess

        subprocess.Popen(
            ["sh", "-c", "sleep 1; brew services restart omlx-dev "
                         ">> /tmp/omlx-dev-restart.log 2>&1"],
            start_new_session=True)


@api_router.post("/dev/build")
async def dev_build(req: DevBuildRequest,
                    is_admin: bool = Depends(require_admin)):
    with _DEV_BUILD_LOCK:
        if _DEV_BUILD["running"]:
            return {"started": False, "running": True,
                    "reason": "a build is already running"}
        _DEV_BUILD["running"] = True
        _DEV_BUILD["result"] = None
        _DEV_BUILD["log"] = ["build started"]
    threading.Thread(target=_dev_build_run, daemon=True,
                     args=(req.model_dump(),)).start()
    return {"started": True}


class DevReconfigureRequest(BaseModel):
    port: Optional[int] = None
    base_path: Optional[str] = None
    share: Optional[list[str]] = None
    no_share: Optional[list[str]] = None


def _dev_reconfigure_sync(req: DevReconfigureRequest) -> dict:
    from types import SimpleNamespace

    from .. import cli

    rc = cli.cmd_dev_reconfigure(SimpleNamespace(
        port=req.port, base_path=req.base_path,
        share=req.share or [], no_share=req.no_share or [],
        interactive=False))
    return {"ok": rc == 0, "status": _dev_status_sync()}


class DevBaseRequest(BaseModel):
    # DEV-7 base-root chooser: None/"" clears the pin (= follow the sync
    # ref, dashboard wording "follow vanilla omlx keg"); otherwise a commit
    # sha/short sha from GET /dev/commits — validated against dev-src.
    pin: Optional[str] = None


@api_router.get("/dev/commits")
async def dev_commits(limit: int = 50,
                      is_admin: bool = Depends(require_admin)):
    """Bounded upstream commit list for the base-root chooser (DEV-7)."""
    from .. import devsrc

    def sync():
        cfg = devsrc.load_config()
        if not cfg:
            return {"installed": False, "commits": []}
        try:
            return {"installed": True,
                    "commits": devsrc.recent_commits(cfg, limit=limit),
                    "sync_ref": cfg.get("sync_ref")}
        except devsrc.DevsrcError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    return await asyncio.to_thread(sync)


@api_router.post("/dev/base")
async def dev_base(req: DevBaseRequest,
                   is_admin: bool = Depends(require_admin)):
    """Pin (or un-pin) the commit omlx-dev materializes from (DEV-7).
    Writing the pin alone changes nothing on disk — the next rebuild
    re-cuts uplift-dev from it, same as every other patch-set change."""
    from .. import devsrc

    def sync():
        cfg = devsrc.load_config()
        if not cfg:
            raise HTTPException(status_code=409,
                                detail="omlx-dev not bootstrapped — run "
                                       "omlx-uplift dev bootstrap first")
        pin = (req.pin or "").strip()
        if pin:
            try:
                resolved = devsrc.base_sha_of(dict(cfg, base_pin=pin))
            except devsrc.DevsrcError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            if not resolved:
                raise HTTPException(status_code=400,
                                    detail=f"{pin!r} is not a commit in dev-src")
            cfg["base_pin"] = resolved
            # DEV-11 invariant: pinned to a commit = never auto-updates.
            # Turn the flag off as part of the pin, not as a boot-time
            # secret override that contradicts what the UI shows.
            cfg["auto_update"] = False
        else:
            cfg.pop("base_pin", None)
        devsrc.save_config(cfg)
        return {"ok": True, "base_pin": cfg.get("base_pin"),
                "status": _dev_status_sync()}

    return await asyncio.to_thread(sync)


class DevBootstrapRequest(BaseModel):
    # DEV-7(d): bootstrap from the dashboard. All optional: omitted fields
    # take the same defaults as `omlx-uplift dev bootstrap --yes` (origin
    # from the installed omlx tap head, sync origin/main, port 8001).
    origin: Optional[str] = None
    sync_ref: Optional[str] = None
    port: Optional[int] = None


def _dev_boot_run(opts: dict) -> None:
    from .. import cli

    argv = ["bootstrap", "--yes"]
    if opts.get("origin"):
        argv += ["--origin", str(opts["origin"])]
    if opts.get("sync_ref"):
        argv += ["--sync-ref", str(opts["sync_ref"])]
    if opts.get("port"):
        argv += ["--port", str(int(opts["port"]))]
    rc = 1
    try:
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.cmd_dev(argv)
        lines = [l.strip() for l in (out.getvalue() + err.getvalue()).splitlines()
                 if l.strip()]
    except Exception as exc:  # never leave the job stuck on "running"
        lines = [f"bootstrap crashed: {exc}"]
    with _DEV_BUILD_LOCK:
        _DEV_BOOT["log"].extend(lines[-25:])
        _DEV_BOOT["running"] = False
        _DEV_BOOT["result"] = rc


@api_router.post("/dev/bootstrap")
async def dev_bootstrap(req: DevBootstrapRequest,
                        is_admin: bool = Depends(require_admin)):
    """Clone dev-src + create the formula branch (the CLI bootstrap, run
    detached). The brew build afterwards still needs `dev build` /
    Rebuild — and, first time only, Homebrew's own install step."""
    with _DEV_BUILD_LOCK:
        if _DEV_BOOT["running"] or _DEV_BUILD["running"]:
            return {"started": False, "running": True,
                    "reason": "a bootstrap or build is already running"}
        _DEV_BOOT["running"] = True
        _DEV_BOOT["result"] = None
        _DEV_BOOT["log"] = ["bootstrap started"]
    threading.Thread(target=_dev_boot_run, daemon=True,
                     args=(req.model_dump(),)).start()
    return {"started": True}


def _dev11_evaluate(cfg: dict) -> dict:
    """DEV-11: decide whether the boot auto-upgrade should run. Pure git +
    config, no brew — cheap enough for a boot thread, safe to unit-test.

    Invariants (ticket acceptance 5): the flag must be ON *and* the base
    un-pinned (tracking HEAD). A pinned base never auto-updates no matter
    what the flag says. 'HEAD moved' = sync-ref tip != base commit the
    current keg was cut from (built_base, written by cmd_dev_install).
    Kegs built before this field existed re-baseline silently: no
    auto-build from unknown provenance."""
    from .. import devsrc

    if not cfg.get("auto_update"):
        return {"run": False, "reason": "flag off"}
    if (cfg.get("base_pin") or "").strip():
        return {"run": False, "reason": "base pinned"}
    try:
        devsrc.fetch_sync_ref(cfg)      # network — boot thread only
        tip = devsrc.base_sha_of(cfg)   # sync-ref tip (no pin: the tip)
    except devsrc.DevsrcError as exc:
        return {"run": False, "reason": f"sync ref: {exc}"}
    if not tip:
        return {"run": False, "reason": "sync tip unknown"}
    built_base = cfg.get("built_base") or ""
    if not built_base:
        return {"run": False, "reason": "rebuilt once to record base",
                "rebaseline": tip}
    if built_base == tip:
        return {"run": False, "reason": "up to date"}
    return {"run": True, "reason": f"HEAD moved {built_base[:12]} -> "
                                   f"{tip[:12]}"}


def dev11_boot_check() -> None:
    """DEV-11 boot hook — runs in a daemon thread from the lifespan wrap.
    Flag ON + tracking HEAD + tip moved → runs the SAME manual build path
    (cmd_dev_install: stash → materialize → brew reinstall, DEV-10 keep-
    old-keg guarantees) in a detached subprocess. Never blocks or crashes
    serving; any surprise logs at debug and vanishes (a dev-box nicety,
    not a serving dependency)."""
    import logging
    import subprocess
    import sys

    log = logging.getLogger("omlx_uplift")
    try:
        from .. import devsrc

        # Only the DEV keg may auto-build omlx-dev. A vanilla-keg server
        # sharing this machine (or a foreign interpreter via the .pth)
        # must never trigger dev builds (DEV-6 scope discipline).
        probe = f"{sys.prefix} {sys.executable}".lower()
        if "/omlx-dev/" not in probe:
            return
        cfg = devsrc.load_config()
        if not cfg:
            return
        v = _dev11_evaluate(cfg)
        log.debug("dev-11 boot check: %s", v.get("reason"))
        if v.get("rebaseline"):
            fresh = devsrc.load_config() or cfg
            fresh["built_base"] = v["rebaseline"]
            devsrc.save_config(fresh)
            return
        if not v.get("run"):
            return
        # Detached like /dev/restart: a brew reinstall may replace THIS
        # process's own files (dev keg serving) — build outside, restart
        # after, and the new build answers the next load.
        subprocess.Popen(
            [sys.executable, "-m", "omlx_uplift.cli", "dev", "auto-build"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
    except Exception:
        log.debug("dev-11 boot check failed", exc_info=True)


class DevAutoUpdateRequest(BaseModel):
    enabled: bool


@api_router.post("/dev/auto-update")
async def dev_auto_update(req: DevAutoUpdateRequest,
                          is_admin: bool = Depends(require_admin)):
    """Toggle AUTO UPDATE — TRACK HEAD (DEV-11). Default OFF; persists in
    dev.json. Turning it ON while pinned is refused (the invariant is the
    UI's truth, not a boot-time secret)."""
    from .. import devsrc

    on = bool(req.enabled)

    def sync():
        cfg = devsrc.load_config()
        if not cfg:
            raise HTTPException(status_code=409,
                                detail="omlx-dev not bootstrapped — run "
                                       "omlx-uplift dev bootstrap first")
        if on and (cfg.get("base_pin") or "").strip():
            raise HTTPException(status_code=409,
                                detail="base is pinned — un-pin (follow "
                                       "HEAD) before enabling auto-update")
        cfg["auto_update"] = on
        devsrc.save_config(cfg)
        return {"ok": True, "auto_update": on,
                "status": _dev_status_sync()}

    return await asyncio.to_thread(sync)


@api_router.post("/dev/reconfigure")
async def dev_reconfigure(req: DevReconfigureRequest,
                          is_admin: bool = Depends(require_admin)):
    res = await asyncio.to_thread(_dev_reconfigure_sync, req)
    if not res["ok"]:
        raise HTTPException(status_code=422, detail="reconfigure failed")
    return res


@api_router.post("/dev/restart")
async def dev_restart(is_admin: bool = Depends(require_admin)):
    """brew services restart omlx-dev. When the dev dashboard calls this,
    ITS OWN server is the target — so the restart runs DETACHED after a
    short grace: the JSON response must leave the socket before launchd
    takes the process down."""
    import subprocess

    subprocess.Popen(
        ["sh", "-c", "sleep 2; brew services restart omlx-dev "
                     ">> /tmp/omlx-dev-restart.log 2>&1"],
        start_new_session=True)
    out = await asyncio.to_thread(_dev_status_sync)
    out["ok"] = True
    out["restarting"] = True
    return out


def _supervisor_kind(env: dict) -> Optional[str]:
    """Which watchdog respawns THIS process, or None when none is provable.

    Order = most specific marker first:
      OMLX_SUPERVISED   — set by the menubar app (vanilla contract).
      XPC_SERVICE_NAME  — launchd injects the job label into EVERY job's
                          environment (verified via `launchctl print`);
                          a terminal `omlx serve` never carries it. PPID
                          is deliberately NOT a signal: a reparented CLI
                          run looks identical to a launchd child.
    """
    if (env.get("OMLX_SUPERVISED") or "").strip():
        return "menubar"
    label = (env.get("XPC_SERVICE_NAME") or "").strip()
    if label:
        return f"launchd:{label}"
    return None


class ServerRestartRequest(BaseModel):
    force: bool = False


# Path deliberately avoids vanilla's /admin/api/server/restart: FastAPI
# matches duplicates in registration order and vanilla registers first, so
# a same-name route would still hit the OMLX_SUPERVISED gate — on the
# /admin/api alias AND through the viewer's /uplift/api→/admin/api proxy.
@api_router.post("/restart-server")
async def server_restart(req: ServerRestartRequest,
                         is_admin: bool = Depends(require_admin)):
    """Self-terminate so the supervisor restarts this server.

    Detection failure is a 200 {ok: false, supervised: false} — NOT an
    exception: the caller's next move (arm FORCE RESTART) is normal flow,
    not an error path. force=true kills regardless of detection.
    """
    import subprocess

    kind = _supervisor_kind(os.environ)
    if not kind and not req.force:
        return {"ok": False, "supervised": False,
                "detail": "no supervisor detected (not a launchd job, no "
                          "menubar) — a restart would end the server. "
                          "Use FORCE RESTART if you know it gets respawned."}

    # Detached, like /dev/restart: the kill must fire AFTER this JSON
    # leaves the socket. SIGTERM = uvicorn graceful shutdown; launchd /
    # menubar respawn with their usual ~5 s backoff.
    subprocess.Popen(
        ["sh", "-c", f"sleep 1.5; kill -TERM {os.getpid()}"],
        start_new_session=True)
    return {"ok": True, "restarting": True, "supervisor": kind,
            "forced": bool(req.force and not kind),
            "expected_downtime_seconds": 7}
