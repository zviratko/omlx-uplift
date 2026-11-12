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

# (command, one-line summary) - the whole point is ONE line per command.
# CLI-REVIEW (user 2026-11-12): every verb the command accepts is named,
# no em dashes, no internal nouns; details live in `help <command>`.
COMMANDS = [
    ("serve", "run oMLX with Uplift (same arguments as 'omlx serve'; "
              "--qa = separate test instance)"),
    ("view", "standalone viewer for an oMLX that cannot load Uplift (DMG)"),
    ("install", "connect Uplift to an omlx install (needed after every "
                "'brew upgrade omlx')"),
    ("uninstall", "disconnect Uplift from an omlx install"),
    ("patch", "status, check, add, update, update-all, rebase, enable, remove "
              "and more: manage omlx patches"),
    ("dev", "install, upgrade, status, kegs, use, rollback and more: the "
            "omlx-dev build with your patches"),
    ("env", "list, set, reset: omlx-dev environment variables"),
    ("skin", "compile, decompile: pack and unpack dashboard skins"),
    ("doctor", "compare the installed omlx files with the release "
               "(read-only)"),
    ("bench-env", "status, create: Python environment for accuracy "
                  "benchmarks"),
    ("mteb-env", "status, create: Python environment for embedding "
                 "benchmarks"),
]

_TOP_USAGE = """\
usage: omlx-uplift <command> [args]
"""

_P = "  omlx-uplift "
# per-command usage: one full command per line, notes indented below it
COMMAND_USAGE = {
    "serve": (_P + "serve [omlx serve args...]\n"
              + _P + "serve --qa [--port N] [--qa-base DIR]\n"
              "      --qa: separate test instance (base ~/.omlx-qa, port "
              "8099),\n"
              "      seeded once from your settings; never touches ~/.omlx"),
    "view": _P + "view [--api URL] [--port N]",
    "install": (_P + "install [--python PATH] [--formula NAME] [--yes | "
                "--keep-skins]\n"
                "                      [--default-target omlx|dev]"),
    "uninstall": _P + "uninstall [--python PATH]",
    "patch": (
        "show and check (add --json to any patch command for the raw result):\n"
        + _P + "patch status [--target omlx|dev|both]\n"
        + _P + "patch check   [--target ...]   look for new versions\n"
        + _P + "patch apply   [--target ...]   write enabled patches into the install now\n"
        + _P + "patch curated [--sync]         the published catalog\n"
        "add and update:\n"
        + _P + "patch add ID (--pr REPO/N | --url URL | --file FILE) "
        "[--scope omlx|dev|both]\n"
        + _P + "patch update ID [--pr REPO/N | --url URL | --file FILE] "
        "[--approve once|always]\n"
        + _P + "patch update-all\n"
        + _P + "patch rebase ID [--continue]   carry your own build patch "
        "onto the new base\n"
        "one patch:\n"
        + _P + "patch enable|disable ID [--approve once|always]\n"
        + _P + "patch promote ID [--approve once|always]   use the newest "
        "stored version\n"
        + _P + "patch rollback ID [--to-v N]\n"
        + _P + "patch approve ID [--approve once|always]\n"
        + _P + "patch order ID N               lower N applies first\n"
        + _P + "patch adopt ID                 own a catalog patch\n"
        + _P + "patch remove ID\n"
        "all patches:\n"
        + _P + "patch disable-all | enable-all   kill switch and its undo\n"
        "('patches' works as another name for 'patch')"),
    "skin": (_P + "skin compile DIR [-o OUT.yml]\n"
             + _P + "skin decompile FILE.yml [-C SKINS-DIR]"),
    "dev": (
        "build:\n"
        + _P + "dev install [--yes] [--with-custom-kernel] [--with-grammar] "
        "[--dry-run] [--restart]\n"
        "      always rebuilds; on a new machine it asks the setup "
        "questions first\n"
        + _P + "dev upgrade [--force] [--restart]\n"
        "      rebuilds only when upstream or your patches moved\n"
        + _P + "dev status [--fetch] [--json]\n"
        + _P + "dev patches [--scope omlx|dev|both] [--json]\n"
        "builds on disk:\n"
        + _P + "dev kegs [--json]\n"
        + _P + "dev use BUILD [--force] [--restart]\n"
        + _P + "dev rollback [--restart]       back to the previous build\n"
        + _P + "dev prune [--keep N]\n"
        + _P + "dev stash-keg\n"
        "setup:\n"
        + _P + "dev setup [--yes] [--src PATH] [--origin URL] "
        "[--sync-ref REF] [--port N]\n"
        "      (dev bootstrap and dev configure are other names for it)\n"
        + _P + "dev reconfigure [--port N] [--base-path P] [--share K,...] "
        "[--no-share K,...] [--interactive]"),
    "bench-env": (_P + "bench-env [status] [--json]\n"
                  + _P + "bench-env create [--reinstall]\n"
                  "      lm-eval environment in ~/.omlx/uplift/bench-env "
                  "(no torch)"),
    "mteb-env": (_P + "mteb-env [status] [--json]\n"
                 + _P + "mteb-env create [--reinstall]\n"
                 "      MTEB environment in ~/.omlx/uplift/mteb-env "
                 "(carries torch)"),
    "env": (_P + "env [list] [--json]\n"
            + _P + "env set NAME VALUE\n"
            + _P + "env reset NAME\n"
            + _P + "env disable-all | enable-all\n"
            "      omlx-dev only; values apply at the next omlx-dev start"),
    "doctor": (_P + "doctor [--json]\n"
               "      read-only: every omlx file against the release file "
               "list;\n"
               "      files that an applied patch changes are expected"),
}

_CONFIG_FILES = [
    ("metrics.sqlite3", "uplift's own metrics database"),
    ("env.json", "stored experimental env overrides - omlx-dev only (ENV-4)"),
    ("patches.json", "patch manifest (desired state per patch)"),
    ("patches/", "stored diffs + byte-exact pre-apply backups"),
    ("patches.lock", "reconcile lock (startup and CLI share it)"),
    ("patches.disabled", "kill switch: boot unpatched when present"),
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
        usage = COMMAND_USAGE.get(cmd) or COMMAND_USAGE.get(
            "patch" if cmd == "patches" else "")
        if not usage:
            print(f"no usage for '{cmd}'", file=sys.stderr)
            return 1
        print(_paint_head(f"usage: omlx-uplift {cmd}"))
        print(usage)
        return 0
    print(_paint_head(_TOP_USAGE.rstrip()))
    print()
    print(_paint_head("commands:"))
    width = max(len(c) for c, _ in COMMANDS)
    for name, summary in COMMANDS:
        print(f"  {_paint_cmd(name.ljust(width))}  {summary}")
    print()
    print("more: omlx-uplift help <command>   (usage of one command)")
    print("      omlx-uplift man              (full manual)")
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
