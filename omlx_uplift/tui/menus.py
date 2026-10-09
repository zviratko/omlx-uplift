"""Menu bar + dropdown specification (TUI-3).

Midnight-Commander structure, the shape the user asked for: a bar of menu
names across the top of every screen, dropdown boxes of commands with
accelerator letters, and (like MC) commands that act on the panel selection.
This module is PURE DATA + eligibility logic: it turns 'what the app is
looking at right now' into menu items and nothing else. No curses, no state
changes, no policy — an item either carries an existing ops.Op (dispatched by
App through the usual gates), navigates to a panel, or names an app command.

MC parity that matters here:
  * every command is reachable from the bar AND by its accelerator/letter;
  * items that cannot run now are shown greyed with the REASON (MC greys
    exactly this way — a disabled item that stays visible teaches the
    interface instead of hiding it);
  * arrows walk menus, Esc backs out, F9 focuses the bar.
"""
from __future__ import annotations

from . import ops as ops_mod

# one menu-bar entry
class Menu:
    __slots__ = ("name", "accel", "items")

    def __init__(self, name, accel, items):
        self.name = name          # label shown in the bar
        self.accel = accel        # Alt+letter opens it
        self.items = items        # list[Item]


SEP = "sep"                       # separator marker in an item list


class Item:
    """One dropdown row. kind:
       'op'      — payload is an ops.Op; runs through the normal gates
       'panel'   — payload is a screen name; switches the left panel
       'cmd'     — payload is a command word handled by App
       'sub'     — payload is a nested list[Item] (opened sideways)
       'toggle'  — like cmd but shows its current state (check marks)"""

    __slots__ = ("kind", "label", "accel", "hint", "payload", "enabled",
                 "reason", "checked", "target")

    def __init__(self, kind, label, accel="", hint="", payload=None,
                 enabled=True, reason="", checked=None, target=None):
        self.kind = kind
        self.label = label
        self.accel = accel or (label[:1].lower() if label else "")
        self.hint = hint
        self.payload = payload
        self.enabled = enabled
        self.reason = reason          # shown when greyed: WHY not now
        self.checked = checked        # None = no marker; True/False = state
        # the model.Row an op command will act on — the ROW object, not its
        # raw dict: the App's gates read row.kind/row.key and pass row.raw to
        # the op. A dict here crashed the first dropdown run of a row command.
        self.target = target

    @staticmethod
    def separator():
        return SEP

PANEL_NAMES = ("overview", "patches", "catalog", "dev", "log")
PANEL_LABELS = {"overview": "Overview", "patches": "Patches",
                "catalog": "Curated catalog", "dev": "omlx-dev keg",
                "log": "Session log"}
PANEL_DESCS = {
    "overview": "the machine at a glance",
    "patches": "every patch, enable / promote / roll back / remove",
    "catalog": "ready-made patches published in the repo",
    "dev": "the patched build, its stashes and carrier",
    "log": "what you ran this session, with CLI twins",
}
PANEL_KEYS = {"1": "overview", "2": "patches", "3": "catalog",
              "4": "dev", "5": "log"}


def op_item(op, enabled=True, reason="", target=None):
    """Wrap an existing ops.Op as a dropdown item. The accelerator is the
    op's letter — the SAME letter the key bar and the CLI-mirroring use — so
    bar, letter and shell never diverge."""
    # keep the op's OWN key as accelerator, case included: 'K' is the kill
    # switch everywhere (panel, CLI twin, menu) — lowercasing it here would
    # break the one promise the bar makes
    return Item("op", op.label, op.key,
                op.hint, op, enabled=enabled, reason=reason,
                target=target)


def _panel_items(env):
    out = []
    for name in PANEL_NAMES:
        out.append(Item("panel", PANEL_LABELS[name],
                        accel=str(PANEL_NAMES.index(name) + 1),
                        hint=PANEL_DESCS[name], payload=name,
                        checked=(name == env.current)))
    out.append(SEP)
    out.append(Item("cmd", "Re-read state now", "n",
                    "drop display caches and probe again", "refresh"))
    out.append(SEP)
    out.append(Item("cmd", "Quit", "q", "same as F10", "quit"))
    return out


# a menu's row commands act on THAT kind's panel, whichever is on screen —
# so opening 'Keg' from the patches panel still lists activate/rollback with
# the stash that panel has selected (MC: menu commands act on the panel they
# belong to, not wherever the cursor happens to be)
KIND_PANEL = {ops_mod.PATCH: "patches", ops_mod.CATALOG: "catalog",
              ops_mod.KEG: "dev", ops_mod.SERVER: "overview"}


def _ops_for(env, kind):
    """Row-scoped ops for the panel's selected row, MC-style: the menu shows
    them whether or not the row can run them, with the reason when it can't
    (MC greys 'Copy' on an unmarked file rather than hiding the command)."""
    pool = [o for o in ops_mod.ALL_OPS if o.row_kinds is not None
            and kind in o.row_kinds]
    out = []
    row = env.row_for(KIND_PANEL.get(kind, env.current))
    for op in pool:
        enabled, reason = True, ""
        if row is None:
            enabled, reason = False, "nothing selected on that panel"
        elif op.needs_tree and not env.tree_root:
            enabled, reason = False, "needs the omlx package tree"
        out.append(op_item(op, enabled, reason, target=row))
    return out


def _kill_items(env):
    on = bool(getattr(env, "kill_switch", False))
    return [
        Item("op", "Kill switch ON", "K",
             "boot unpatched until cleared",
             ops_mod.find("K", ops_mod.ALL_OPS), checked=on),
        Item("op", "Kill switch OFF", "U",
             "restore exactly what ON recorded",
             ops_mod.find("U", ops_mod.ALL_OPS), checked=not on),
    ]


def _screen_ops(env, keys):
    out = []
    for k in keys:
        op = ops_mod.find(k, ops_mod.ALL_OPS)
        if op is None:
            continue
        enabled, reason = True, ""
        if op.needs_tree and not env.tree_root:
            enabled, reason = False, "needs the omlx package tree"
        out.append(op_item(op, enabled, reason))
    return out


def _view_items(env):
    return [
        Item("cmd", "Detail pane", "d", "show the explanation panel on the "
                                        "right (or bottom on narrow "
                                        "terminals)", "toggle_detail",
             checked=env.detail_open),
        Item("cmd", "Status lines", "s", "footer notes (warnings, paths)",
             "toggle_footer", checked=env.footer_open),
        SEP,
        _theme_submenu(env),
    ]


def _theme_submenu(env):
    from . import themes
    items = [Item("cmd", themes.theme(n)["label"], n[:1],
                  themes.theme(n).get("note", ""), "theme:" + n,
                  checked=(n == env.theme_name))
             for n in themes.names()]
    return Item("sub", "Colour theme", "t", "T cycles", items)


def _help_items(env):
    return [
        Item("cmd", "Keys and rules", "?", "what every key does", "help"),
        Item("cmd", "About this TUI", "a", "what the tool is and is not",
             "about"),
    ]


def build(env) -> list:
    """The whole bar for one app state. env exposes: current (panel name),
    tree_root, detail_open, footer_open, theme_name, row_for(kind) -> Row|None,
    services list, dev installed flag."""
    menus = [
        Menu("Go", "g", _panel_items(env)),
        Menu("Patches", "p", [
            *_ops_for(env, ops_mod.PATCH),
            SEP,
            *_screen_ops(env, ("c", "y")),        # drift check, reconcile
            SEP,
            # the kill switch: store-only, deliberately never greyed (TUI-1
            # rule: the rescue command answers even with no tree); the tick
            # shows which side is armed right now
            *_kill_items(env),
        ]),
        Menu("Catalog", "c", [
            *_ops_for(env, ops_mod.CATALOG),
            SEP,
            *_screen_ops(env, ("c",)),            # sync catalog
        ]),
        Menu("Keg", "k", [
            *_ops_for(env, ops_mod.KEG),
            SEP,
            *_screen_ops(env, ("t", "r", "z", "b", "f")),
        ]),
        Menu("Services", "s", _ops_for(env, ops_mod.SERVER)),
        Menu("View", "v", _view_items(env)),
        Menu("Help", "h", _help_items(env)),
    ]
    _dedupe_accels(menus)
    return menus


def _dedupe_accels(menus) -> None:
    """Accelerators must be unique INSIDE a dropdown: 'Alt+C' may open only
    one command. First claim wins the lowercase letter; a collision moves to
    the op's own key (usually the uppercase shortcut), and only if THAT
    collides too does the item lose its accelerator (Enter still works)."""
    for m in menus:
        _dedupe_items(m.items)


def _dedupe_items(items) -> None:
    used = set()
    for it in items:
        if it is SEP:
            continue
        if it.kind == "sub":
            _dedupe_items(it.payload)
        a = it.accel
        # case-SENSITIVE here: 'u' (update) and 'U' (kill OFF) are distinct
        # commands and the App dispatches accelerators exact-first; a real
        # same-letter collision moves to the op's own key or loses the
        # accelerator (Enter still works)
        if a and a in used:
            key = getattr(it.payload, "key", "")
            a = key if key and key not in used else ""
            it.accel = a
        if a:
            used.add(a)
