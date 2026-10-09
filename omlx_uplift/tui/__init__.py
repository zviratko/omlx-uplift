"""omlx-uplift tui — menu-driven terminal manager (TUI-1).

A curses front-end for the verbs this project already ships: patch
enable/disable/promote/update/rollback/remove, the curated catalog, the kill
switch, omlx-dev keg stash/use/rollback/prune and service restart.

Layout (deliberate — the testable parts never touch a terminal):
  ops.py   what the UI may do (one table: key, label, danger, CLI twin)
  api.py   the action layer: calls patches/patchsource/curated/kegstash/devsrc
  model.py pure text: rows -> screen lines, confirm prompts
  app.py   the curses loop (keys, repaint, worker thread)

Rules the code enforces:
  * no logic of its own — every action is the same function the dashboard
    route or the CLI verb calls;
  * nothing writes without an explicit confirmation keystroke;
  * zero third-party dependencies (stdlib curses only).
"""
from __future__ import annotations


def run(argv=None) -> int:
    """Entry point for `omlx-uplift tui`. Import of curses happens here so
    that `import omlx_uplift.tui` (tests, CI, docs tooling) works headless."""
    from .app import run_tui

    return run_tui(argv)


__all__ = ["run"]
