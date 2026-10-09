"""TUI op catalog (TUI-1) — pure data, no curses, no I/O.

One row per action the terminal UI may offer, grouped by the screen and the
row kind it applies to. Every entry names the CLI verb it mirrors so the
screen can show the human the exact command it is about to run, and every run
callable points at the SAME function the dashboard route uses. Nothing here
implements behaviour — it wires the UI to existing verbs.

Keys are single characters (shift letters allowed) so the loop dispatches on
one dict lookup. Reserved and never usable as an op key: 1-5 (screens), j/k
(up/down), h/l, g/G, n (refresh), enter, ?, q, and 'y' is only a screen op on
screens that have no row bound to it.

danger (drives the confirm gate):
  read   no writes at all — runs immediately
  write  changes the patch store or a config file — needs 'y'
  high   touches tree bytes, a keg, or a running service — needs typed YES
"""
from __future__ import annotations

READ, WRITE, HIGH = "read", "write", "high"

# row kinds an op can act on
PATCH = "patch"        # a patch entry from patchsource.view()
KEG = "keg"            # a stashed omlx-dev keg (kegstash.list_stashes)
CATALOG = "catalog"    # a curated catalog entry (curated.list_remote)
SERVER = "server"      # a service row (omlx / omlx-dev)
ANY = None             # screen-level action (no row needed)


class Op:
    __slots__ = ("key", "label", "run", "row_kinds", "danger", "cli", "hint",
                 "needs_tree")

    def __init__(self, key, label, run, row_kinds=ANY, danger=WRITE,
                 cli="", hint="", needs_tree=False):
        self.key = key
        self.label = label
        self.run = run
        self.row_kinds = row_kinds
        self.danger = danger
        self.cli = cli
        self.hint = hint
        # True when the action acts on the omlx source/keg tree: the App then
        # refuses with a clear reason if the package cannot be imported,
        # instead of letting a write aim at an empty path.
        self.needs_tree = needs_tree

    def applies_to(self, kind) -> bool:
        """Row-scoped ops match their kinds. Screen ops (row_kinds is ANY) are
        deliberately NOT row ops — a screen lists them explicitly, so the same
        letter can mean 'check' on patches and 'sync' on the catalog."""
        if self.row_kinds is ANY:
            return False
        return kind in self.row_kinds

    def cli_line(self, row=None) -> str:
        """The command a human could type by hand — printed in the confirm bar
        and the log so nothing the TUI does is a mystery."""
        cli = self.cli(_d(row) if row is not None else None) \
            if callable(self.cli) else self.cli
        if not cli:
            return ""
        return cli if cli.startswith("(") else f"omlx-uplift {cli}"


def _d(row) -> dict:
    """Ops receive the selected row's payload dict (patchsource/curated all
    take dicts). App passes row.raw; a bare dict also works so an op stays
    callable straight from a test or a script."""
    if row is None:
        return {}
    return getattr(row, "raw", row) or {}


def _pid(row) -> str:
    d = _d(row)
    return d.get("id") or d.get("key") or "?"


def _name(row) -> str:
    d = _d(row)
    return d.get("name") or d.get("key") or "?"


# --------------------------------------------------------------- patches ---
def _enable(ctx, row, approve=None):
    return ctx.patchsource.set_enabled(ctx.store, _pid(row), True,
                                       approve=approve)


def _disable(ctx, row, approve=None):
    return ctx.patchsource.set_enabled(ctx.store, _pid(row), False)


def _promote(ctx, row, approve=None):
    return ctx.patchsource.promote(ctx.store, _pid(row), approve=approve)


def _update(ctx, row, approve=None):
    return ctx.patchsource.update_patch(ctx.store, _pid(row), ctx.tree_root,
                                        build_root=ctx.build_root(),
                                        approve=approve)


def _rollback(ctx, row, approve=None):
    return ctx.patchsource.rollback(ctx.store, _pid(row))


def _approve(ctx, row, approve=None):
    return ctx.patchsource.approve(ctx.store, _pid(row),
                                   mode=approve or "once")


def _remove(ctx, row, approve=None):
    return ctx.patchsource.remove_patch(ctx.store, _pid(row), ctx.tree_root)


def _test(ctx, row, approve=None):
    return ctx.patchsource.test_dry_run(ctx.store, _pid(row), ctx.tree_root)


def _check(ctx, row=None, approve=None):
    return ctx.patchsource.check_all(ctx.store, ctx.tree_root)


def _apply(ctx, row=None, approve=None):
    # the same reconcile the server runs at boot, with allow_reexec off: a
    # CLI/TUI process must not re-exec itself behind the operator
    return ctx.patchsync.reconcile(ctx.store, ctx.tree_root,
                                   allow_reexec=False)


def _kill_on(ctx, row=None, approve=None):
    """Arms the boot kill switch: sentinel plus every patch off, recording
    what the switch itself switched off. Routed through the CLI verb on
    purpose — the stamping rules (first-armed wins, a manual disable stays
    off) live in cmd_patches and must not have a second copy."""
    return ctx.cli_patch_verb("disable-all")


def _kill_off(ctx, row=None, approve=None):
    return ctx.cli_patch_verb("enable-all")


def _catalog_sync(ctx, row=None, approve=None):
    return ctx.curated.sync(ctx.store, ctx.tree_root,
                            build_root=ctx.build_root())


def _catalog_install(ctx, row, approve=None):
    """Add one catalog entry to the store (not a whole-tier sync): the same
    add_patch the 'patch add' verb and POST /patches use."""
    entry = _d(row).get("entry") or _d(row)
    source = entry.get("source")
    if not source:
        return {"ok": False,
                "reason": "catalog entry has no usable source (incomplete "
                          "manifest)"}
    return ctx.patchsource.add_patch(ctx.store, entry.get("id") or _pid(row),
                                     source, ctx.tree_root,
                                     build_root=ctx.build_root())


def _catalog_adopt(ctx, row, approve=None):
    # the store entry can live under a different id than the catalog slug
    # (legacy prXXXX ids predate source dedupe) — adopt what is on disk
    pid = _d(row).get("under_id") or _pid(row)
    return ctx.curated.adopt(ctx.store, pid)


# ---------------------------------------------------------------- dev keg ---
def _keg_use(ctx, row, approve=None):
    # through the CLI verb, NOT kegstash.activate directly: 'dev use' carries
    # the DEV-11 invariant (switching kegs returns the box to manual mode by
    # turning auto-build off), the brew link-record sync and the .pth remount
    # report. A second implementation here would drift from all three.
    return ctx.cli_dev_verb("use", _name(row))


def _keg_stash(ctx, row=None, approve=None):
    return ctx.kegstash.stash()


def _keg_rollback(ctx, row=None, approve=None):
    """Newest stash that is not the active keg, auto-update off, base pin
    cleared — all three live in the CLI verb, so the TUI calls it."""
    return ctx.cli_dev_verb("rollback")


def _keg_prune(ctx, row=None, approve=None):
    removed = ctx.kegstash.prune()
    return {"ok": True, "removed": removed,
            "kept": ctx.kegstash.stash_keep()}


def _dev_install(ctx, row=None, approve=None):
    # a subprocess, not in-process: brew must not run inside the interpreter
    # that owns the terminal, and the output is what makes Ctrl-C meaningful.
    return ctx.subprocess_runner(["omlx-uplift", "dev", "install"])


def _dev_fetch(ctx, row=None, approve=None):
    return ctx.cli_dev_verb("status", "--fetch")


def _service_restart(ctx, row, approve=None):
    formula = _d(row).get("formula") or _name(row)
    if formula not in ("omlx", "omlx-dev"):
        return {"ok": False, "reason": f"unknown formula {formula!r}"}
    return ctx.subprocess_runner(["brew", "services", "restart", formula])


# ------------------------------------------------------------- the tables ---
PATCH_ROW_OPS = [
    Op("e", "enable", _enable, (PATCH,), WRITE, needs_tree=True,
       cli=lambda r: f"patch enable {_pid(r)}",
       hint="lands at the next restart (press 'y' to reconcile now)"),
    Op("d", "disable", _disable, (PATCH,), WRITE, needs_tree=True,
       cli=lambda r: f"patch disable {_pid(r)}",
       hint="restores the patch's files on the next reconcile"),
    Op("p", "promote", _promote, (PATCH,), WRITE, needs_tree=True,
       cli=lambda r: f"patch promote {_pid(r)}",
       hint="accepts the newest validated candidate as desired"),
    Op("u", "update", _update, (PATCH,), WRITE, needs_tree=True,
       cli=lambda r: f"patch update {_pid(r)}",
       hint="needs network — re-fetches, gates, stores and adopts"),
    Op("v", "rollback version", _rollback, (PATCH,), WRITE, needs_tree=True,
       cli=lambda r: f"patch rollback {_pid(r)}",
       hint="points desired_version at the previous stored version"),
    Op("a", "approve once", _approve, (PATCH,), WRITE, needs_tree=True,
       cli=lambda r: f"patch approve {_pid(r)} --approve once",
       hint="lets auto-apply pass the held safeguard codes (bound to this "
            "content sha)"),
    Op("t", "dry-run test", _test, (PATCH,), READ, needs_tree=True,
       cli="(no CLI verb — same call as the dashboard's test button)"),
    Op("x", "remove patch", _remove, (PATCH,), HIGH, needs_tree=True,
       cli=lambda r: f"patch remove {_pid(r)}",
       hint="restores pristine files NOW, then deletes the stored diff, "
            "backups and the manifest entry"),
]

PATCH_SCREEN_OPS = [
    Op("c", "check drift", _check, ANY, READ, needs_tree=True,
       cli="patch check",
       hint="re-fetches every source (enabled AND disabled)"),
    Op("y", "reconcile now", _apply, ANY, WRITE, needs_tree=True,
       cli="patch apply",
       hint="the same pass the server runs at boot"),
    Op("K", "kill switch ON", _kill_on, ANY, HIGH, needs_tree=True,
       cli="patch disable-all",
       hint="omlx boots completely unpatched until you turn it off"),
    Op("U", "kill switch OFF", _kill_off, ANY, HIGH, needs_tree=True,
       cli="patch enable-all",
       hint="removes the sentinel and restores exactly the flags the switch "
            "recorded (a patch you had disabled by hand stays off)"),
]

CATALOG_ROW_OPS = [
    Op("i", "install", _catalog_install, (CATALOG,), WRITE, needs_tree=True,
       cli=lambda r: f"patch add {_pid(r)} <source>",
       hint="fetch + gate + store; the tier decides the initial state "
            "(default=enabled, optional=disabled)"),
    Op("o", "adopt as local", _catalog_adopt, (CATALOG,), WRITE,
       needs_tree=True,
       cli=lambda r: f"patch adopt {_d(r).get('under_id') or _pid(r)}",
       hint="drops the bundled tag — catalog updates never touch it again"),
]

CATALOG_SCREEN_OPS = [
    Op("c", "sync catalog", _catalog_sync, ANY, WRITE, needs_tree=True,
       cli="patch curated --sync",
       hint="idempotent; never overwrites your decisions"),
]

KEG_ROW_OPS = [
    Op("s", "activate keg", _keg_use, (KEG,), HIGH,
       cli=lambda r: f"dev use {_name(r)}",
       hint="switches the omlx-dev keg and brew's link record, turns "
            "auto-build off — restart the service to load it"),
]

KEG_SCREEN_OPS = [
    Op("t", "stash current keg", _keg_stash, ANY, WRITE, cli="dev stash-keg"),
    Op("r", "rollback to newest stash", _keg_rollback, ANY, HIGH,
       cli="dev rollback",
       hint="also turns TRACK HEAD (auto-build) OFF and clears the base pin"),
    Op("z", "prune old stashes", _keg_prune, ANY, HIGH, cli="dev prune",
       hint="keeps the newest N (dev.json keg_stash_keep, default 5) and "
            "never the active keg"),
    Op("b", "dev install (build)", _dev_install, ANY, HIGH, cli="dev install",
       hint="materializes the patch commits and runs brew — minutes; Ctrl-C "
            "cancels"),
    Op("f", "refresh (+fetch)", _dev_fetch, ANY, READ, cli="dev status --fetch"),
]

SERVER_ROW_OPS = [
    Op("s", "restart service", _service_restart, (SERVER,), HIGH,
       cli=lambda r: f"(brew services restart {_d(r).get('formula', 'omlx')})"),
]

ALL_OPS = (PATCH_ROW_OPS + PATCH_SCREEN_OPS + CATALOG_ROW_OPS
           + CATALOG_SCREEN_OPS + KEG_ROW_OPS + KEG_SCREEN_OPS
           + SERVER_ROW_OPS)

# keys the loop reserves for itself — an op must never claim one
RESERVED_KEYS = frozenset("12345n?q") | {"enter", "escape", "tab", "up",
                                         "down", "left", "right", "pgup",
                                         "pgdn", "home", "end", "f5",
                                         "ctrl_c"}


def find(key: str, pool: list) -> Op | None:
    for op in pool:
        if op.key == key:
            return op
    return None


def ops_for(kind: str, pool: list | None = None) -> list:
    """Ops that may act on a row of this kind."""
    return [o for o in (pool if pool is not None else ALL_OPS)
            if o.applies_to(kind)]


def duplicate_keys(pools: dict) -> list:
    """[(screen, key, labels)] — a screen must never bind one key twice. The
    unit test calls this over the real pools so a new op cannot silently
    shadow another."""
    out = []
    for name, pool in pools.items():
        seen: dict[str, list] = {}
        for op in pool:
            seen.setdefault(op.key, []).append(op.label)
        for key, labels in seen.items():
            if len(labels) > 1:
                out.append((name, key, labels))
    return out
