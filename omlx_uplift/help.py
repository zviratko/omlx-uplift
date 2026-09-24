"""omlx-uplift CLI help surface (slim --help + man page).

--help on a dashboard tool should be readable in one screen; the long-form
documentation ships as a real roff man page (man/omlx-uplift.1, installed
as package data) and is reachable via `omlx-uplift man` on every install
type — pip placement of data_files varies, so the page travels INSIDE the
package instead of relying on share/man/.

Colors follow the existing rule: tty + no NO_COLOR (see cli._paint).
"""
from __future__ import annotations

import os
import subprocess
import sys

# (command, one-line summary) — the whole point is ONE line per command.
COMMANDS = [
    ("serve", "run oMLX + Uplift (wrapper around 'omlx serve', same args)"),
    ("view", "standalone viewer for installs that cannot load Python (DMG)"),
    ("install", "mount uplift into an omlx python (REQUIRED after every"
                " 'brew upgrade omlx')"),
    ("uninstall", "remove the mount (.pth) again"),
    ("patches", "status|apply|check|disable-all — patch recovery without"
                " the dashboard"),
    ("kernel", "list|rebuild <name> — rebuild ONE native kernel in the keg"),
    ("skin", "compile <dir>|decompile <yml> — pack/unpack skin crates"),
    ("dev", "omlx-dev: install|status|upgrade|reconfigure — build-scope"
            " patches in a separate keg"),
]

_TOP_USAGE = """\
usage: omlx-uplift <command> [args]
"""

# per-command one-screen usage (what argparse would say, without the wall)
COMMAND_USAGE = {
    "serve": "omlx-uplift serve [oMLX serve args...]   (--port, --model-dir, …)",
    "view": "omlx-uplift view [--api URL] [--port N]",
    "install": ("omlx-uplift install [--python PATH] [--yes|--keep-skins]"
                " [--formula NAME]"),
    "uninstall": "omlx-uplift uninstall [--python PATH]",
    "patches": ("omlx-uplift patches status|apply|check|disable-all"
                " [--json]\n"
                "                 add --id ID (--repo R --pr N | --url U |"
                " --file F) [--scope runtime|build]\n"
                "                 enable|disable --id ID [--approve"
                " once|always]"),
    "kernel": ("omlx-uplift kernel list\n"
               "                 kernel rebuild <name> [--src PATH]"),
    "skin": ("omlx-uplift skin compile <dir> [-o out.yml]\n"
             "                 skin decompile <yml> [-C skins-dir]"),
    "dev": ("omlx-uplift dev install [--yes] [--src PATH] [--origin URL]"
            " [--sync-ref REF]\n"
            "                 dev status [--fetch]\n"
            "                 dev upgrade [--with-custom-kernel]"
            " [--with-grammar] [--dry-run]\n"
            "                 dev reconfigure [--port N] [--base-path P]"
            " [--share K,...] [--no-share K,...] [--interactive]"),
}

_CONFIG_FILES = [
    ("metrics.sqlite3", "uplift's own metrics database"),
    ("env_overrides.json", "stored experimental OMLX_* tunables"),
    ("patches.json", "patch manifest (desired state per patch)"),
    ("patches/", "stored diffs + byte-exact pre-apply backups"),
    ("patches.lock", "reconcile lock (startup and CLI share it)"),
    ("patches.disabled", "kill switch: boot unpatched when present"),
    ("kernel-backups/", "byte-exact originals behind 'kernel rebuild'"),
    ("dev.json", "omlx-dev config (origin, sync_ref, port, sharing)"),
    ("dev-src/", "the omlx checkout build patches materialize in"),
]


def _paint_cmd(name: str) -> str:
    from .cli import _paint
    return _paint(sys.stdout, name, "1;36")


def _paint_head(text: str) -> str:
    from .cli import _paint
    return _paint(sys.stdout, text, "1")


def print_help(cmd: str | None = None) -> int:
    """Slim top-level or per-command help. Colors degrade to plain when
    stdout is not a tty (pipes, logs) — same rule as the install preview."""
    out = sys.stdout
    if cmd:
        usage = COMMAND_USAGE.get(cmd)
        if not usage:
            print(f"no usage for '{cmd}'", file=sys.stderr)
            return 1
        print(_paint_head(f"usage ({cmd}):"))
        print(usage)
        return 0
    print(_paint_head(_TOP_USAGE.rstrip()))
    print()
    print(_paint_head("commands:"))
    width = max(len(c) for c, _ in COMMANDS)
    for name, summary in COMMANDS:
        print(f"  {_paint_cmd(name.ljust(width))}  {summary}")
    print()
    print("details: 'omlx-uplift help <command>' (usage) or 'omlx-uplift man'"
          " (full documentation).")
    out.flush()
    return 0


def man_path() -> str:
    """Absolute path of the bundled roff man page (None if not shipped)."""
    import pkgutil

    # package-relative: man/omlx-uplift.1 lives next to this module
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.join(here, "man", "omlx-uplift.1")
    return cand if os.path.isfile(cand) else None


def show_man() -> int:
    """Render the bundled man page: real `man -l` when available, pager
    fallback, plain stdout otherwise."""
    path = man_path()
    if not path:
        print("man page not shipped with this install", file=sys.stderr)
        return 1
    man = _which("man")
    if man and sys.stdout.isatty():
        return subprocess.run([man, "-l", path]).returncode
    if sys.stdout.isatty():
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        pager = _which(os.environ.get("PAGER", "less"))
        if pager:
            return subprocess.run([pager], input=text.encode()).returncode
    else:
        # piped/redirected: render with mandoc when present, raw roff else
        mandoc = _which("mandoc")
        if mandoc:
            return subprocess.run([mandoc, "-Tutf8", path]).returncode
        with open(path, encoding="utf-8") as fh:
            sys.stdout.write(fh.read())
        return 0
    sys.stdout.write(text)
    return 0


def _which(name: str) -> str | None:
    import shutil

    return shutil.which(name) if name else None
