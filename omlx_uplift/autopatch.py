"""Auto-patch hook — the robust mount path for pip/brew installs.

Installed as a .pth line (`import omlx_uplift.autopatch`) in the target
venv. Bare `omlx serve`, launchd respawns and any fresh interpreter that
imports omlx.server get Uplift mounted without a wrapper command; DMG
installs never load this file, so they stay untouched.

The hook must not import omlx (it runs at interpreter startup) — it only
arms a post-import observer for `omlx.server`.

ENV-1/ENV-4: before arming the observer, uplift-stored experimental OMLX_*
tunables are seeded into os.environ (genuine launch env always wins; see
env_tunables.seed_environ). ENV-4 restricts that to the omlx-dev keg: on the
vanilla `omlx` service the seed is a no-op, so production's environment stays
exactly as launchd left it. stdlib only, never raises.
"""

import os
import sys

_TARGET = "omlx.server"


def _seed_env_tunables() -> None:
    try:
        from . import env_tunables, paths

        base = paths.startup_base_dir()
        if base:
            env_tunables.set_base_dir(str(base / paths.UPLIFT_SUBDIR))
        env_tunables.seed_environ()
    except Exception as exc:  # never break the server for a dashboard feature
        # LOG-SILENT-1: silent here meant env tunables (UPLIFT_* etc.)
        # quietly stopped seeding and nobody could tell why. This runs at
        # interpreter startup, before logging is configured — stderr is
        # the only channel that reliably exists.
        print(f"omlx-uplift: env-tunable seed skipped: {exc}",
              file=sys.stderr)


def _mount(module) -> None:
    app = getattr(module, "app", None)
    if app is None or getattr(app, "_omlx_uplift_mounted", False):
        return
    try:
        from . import register

        register(app)
    except Exception:  # never break the server for a dashboard failure
        import logging

        logging.getLogger("omlx_uplift").exception(
            "Uplift auto-mount failed (continuing without it)"
        )


class _PostImportFinder:
    """meta_path sentinel. Wraps the REAL loader's exec_module so the
    mount runs exactly once, after the module body executed, on the very
    module object that lands in sys.modules. (Returning None from
    find_spec after importing ourselves would make the machinery re-execute
    the module a second time and discard the mounted one.)"""

    def find_module(self, fullname, path=None):  # pragma: no cover (py2 API)
        return None

    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET:
            return None
        # Remove self first so the real import isn't re-observed.
        sys.meta_path.remove(self)
        import importlib.util

        spec = importlib.util.find_spec(fullname)
        if spec is None or spec.loader is None:
            return None
        real_exec = spec.loader.exec_module

        def exec_module(module):
            real_exec(module)
            _mount(module)

        spec.loader.exec_module = exec_module
        return spec


def _reconcile_patches() -> None:
    """PAT-3: apply pending patch-set changes BEFORE anything imports omlx.
    May os.execv (replaces this process) when files really changed — that is
    why it runs first. stdlib + own package only; never raises."""
    try:
        from . import patchsync

        patchsync.sync_at_startup()
    except Exception:  # never break the server for the patch carrier
        try:
            import logging

            logging.getLogger("omlx_uplift").exception(
                "patch reconcile failed (booting anyway)")
        except Exception:
            pass


def _tree_drift_check() -> None:
    """KEGID-2: warn (never block, never raise) when the installed omlx
    tree no longer matches its wheel RECORD. The census runs once per keg
    identity (cached verdict replayed after that), so a normal boot pays
    one small json read. Runs AFTER _reconcile_patches: applied patches
    own expected drift, and reconcile may have just re-exec'd the
    process — this hook only sees a settled tree."""
    try:
        from . import treedoctor

        treedoctor.boot_check()
    except Exception:  # the doctor must never be the reason a boot fails
        pass


def install() -> None:
    # UP-3: buffer patchsync/boot INFO lines until Uplift mounts (logging
    # is unconfigured this early; register() flushes into server.log).
    try:
        from . import bootlog

        bootlog.install()
    except Exception:
        pass
    _reconcile_patches()
    _tree_drift_check()
    _seed_env_tunables()
    if _TARGET in sys.modules:
        _mount(sys.modules[_TARGET])
        return
    for f in sys.meta_path:
        if isinstance(f, _PostImportFinder):
            return
    sys.meta_path.insert(0, _PostImportFinder())


install()
