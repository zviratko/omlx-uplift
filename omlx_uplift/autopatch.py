"""Auto-patch hook — the robust mount path for pip/brew installs.

Installed as a .pth line (`import omlx_uplift.autopatch`) in the target
venv. Bare `omlx serve`, launchd respawns and any fresh interpreter that
imports omlx.server get Uplift mounted without a wrapper command; DMG
installs never load this file, so they stay untouched.

The hook must not import omlx (it runs at interpreter startup) — it only
arms a post-import observer for `omlx.server`.
"""

import sys

_TARGET = "omlx.server"


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
    """meta_path sentinel: let the real import run, then mount."""

    def find_module(self, fullname, path=None):  # pragma: no cover (py2 API)
        return None

    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET:
            return None
        # Remove self first so the real import isn't re-observed.
        sys.meta_path.remove(self)
        module = sys.modules.get(fullname)
        if module is None:
            # Import normally via the remaining finders, then mount.
            import importlib

            module = importlib.import_module(fullname)
        _mount(module)
        return None  # we never provide the spec ourselves


def install() -> None:
    if _TARGET in sys.modules:
        _mount(sys.modules[_TARGET])
        return
    for f in sys.meta_path:
        if isinstance(f, _PostImportFinder):
            return
    sys.meta_path.insert(0, _PostImportFinder())


install()
