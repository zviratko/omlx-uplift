"""TUI curses loop (TUI-1, menu shell TUI-3).

Thin by design: read a key, ask App what to do, paint what the model rendered.
`App` holds every behaviour (navigation, the menu bar, the confirm gate, the
worker thread) and imports no curses, so it is testable headless; curses lives
only in the plumbing at the bottom of this file.

The shell is Midnight Commander's (TUI-3, on the user's request): a BAR of
menus along the top of every screen, dropdowns of commands with accelerator
letters, big panels that use the whole window, F-key legend at the bottom.
F9 (or Alt+letter) opens the bar; letters still run the printed shortcut of
the visible panel; panels switch with Tab.
"""
from __future__ import annotations

import queue
import threading
import time

from . import frame, menus, model, ops as ops_mod, themes
from .context import Context

REFRESH_SECS = 5.0      # the dashboard, a boot reconcile or another terminal
                        # can change the store while we sit here looking at it
PULSE_SECS = 1.5        # background collector tick (TUI-3): keeps the TTL
                        # caches warm OFF the UI thread
LOOP_TIMEOUT_MS = 60    # idle getch wait (repaint throttle, feels instant)
ESC_COMBINE_MS = 45     # getch window used to assemble ESC-prefixed keys

HELP_LINES = [
    "omlx-uplift tui — keys and rules",
    "",
    "  The bar along the top is the menu: F9 focuses it, Alt+first-letter",
    "  opens one, arrows walk it, Enter runs the highlighted command, Esc",
    "  backs out. Tab switches panels; 1-5 still jump. Every command in a",
    "  menu is also the printed letter shortcut on its panel — the CLI",
    "  twin is shown in the log either way.",
    "",
    "  Navigate with the arrows (or j/k). Enter opens what is highlighted:",
    "  a menu entry its commands, a patch its action list. PgUp/PgDn jump",
    "  by 8.  F3 toggles the detail pane.  F5 re-reads state.  T cycles",
    "  the colour theme.  ? this help.  q (or F10) quits.",
    "",
    "  Commands that cannot run right now stay visible and greyed with the",
    "  reason — a disabled command that explains itself teaches the tool",
    "  instead of hiding from you.",
    "",
    "  Every action is also a CLI command (shown in the action hint and in",
    "  the log). Write actions answer y/N; actions that touch tree bytes, a",
    "  keg or the running service ask you to type YES. Nothing is written",
    "  unless you confirm it.",
    "",
    "  omlx re-applies patches at every boot, so most patch changes land on",
    "  the next restart (or run 'reconcile now' from the Patches menu).",
    "",
    "  Ctrl-C cancels a running command (a build, a restart). An in-process",
    "  store write cannot be interrupted and simply finishes.",
    "",
    "  Themes: 'default' uses your terminal's own colours; P(DOOM) is the",
    "  SHODAN dashboard skin in the terminal (void black, laser crimson,",
    "  ember orange); 'phosphor' is a single-hue CRT; 'mono' is colour-free.",
    "  The choice is saved to ~/.omlx/uplift/tui.json.",
    "",
    "  press any key to continue",
]

ABOUT_LINES = [
    "omlx-uplift tui — what this tool is",
    "",
    "  A front end, not a second brain. Every command here calls the SAME",
    "  function the web dashboard and the CLI call — the patch store, the",
    "  curated catalog, the dev-keg stash, the kill switch. No policy lives",
    "  in this UI, so behaviour cannot drift from the documented CLI.",
    "",
    "  The patch store (~/.omlx/uplift/patches.json) is shared with the",
    "  dashboard; another terminal or a boot reconcile can change it while",
    "  you look at this screen. F5 re-reads; the log shows every result",
    "  with the CLI command that mirrors it.",
    "",
    "  The kill switch (Patches menu) needs no omlx tree on purpose: when",
    "  patches leave the package unbootable, that command is the way out.",
    "",
    "  press any key to continue",
]


class App:
    """All TUI behaviour except painting."""

    def __init__(self, ctx: Context | None = None):
        self.ctx = ctx or Context()
        self.screens: dict[str, model.Screen] = {}
        # boot on the panels, not a launcher screen (TUI-3): the BAR is the
        # menu now; 'menu' remains reachable (m, the Panel menu) for people
        # who want the list view
        self.current = "patches"
        self.actions_for: str | None = None   # submenu view of a panel
        self.detail_open = True
        self.footer_open = True
        self.notice = ""
        self.busy = ""
        self.pending: tuple | None = None     # (op, row) awaiting confirmation
        self.yes_line = ""
        self.worker: threading.Thread | None = None
        self.results: queue.Queue = queue.Queue()
        # menu-bar state (TUI-3): which dropdown is open (-1 = none, -2 = bar
        # focused but closed), the cursor inside it, and the sub-menu path
        self.bar_index = -1
        self.bar_focus = False
        self.item_cursor = 0
        self.sub_path: list[int] = []         # item indexes of open submenus
        self._menus_cache: list | None = None
        self._menus_stamp = 0.0
        # view state the painter reads: last Frame (for mouse hits)
        self._frame: frame.Frame | None = None
        # TUI-3: display collectors run on a background pulse thread so the
        # UI thread's build() is always a cache read.
        self._pulse_now = False
        self.proc = None
        self.proc_lock = threading.Lock()
        self.last_build = 0.0
        self.running = True
        self.show_help = False
        self.show_about = False
        # theme: persisted in ~/.omlx/uplift/tui.json, 'T' cycles it
        self.theme_name = themes.get_theme()
        self.attrs: dict = {}
        self.theme_info: dict = {"mode": "headless", "note": "", "pairs": 0,
                                 "label": themes.theme(self.theme_name)["label"]}
        self.theme_dirty = True
        self.ctx.on_process = self._note_process
        self.build(self.current)

    # ----------------------------------------------------------------- theme --
    @property
    def theme(self) -> dict:
        return themes.theme(self.theme_name)

    def cycle_theme(self, direction: int = 1) -> str:
        order = themes.names()
        i = order.index(themes.norm(self.theme_name))
        return self.set_theme(order[(i + direction) % len(order)])

    def set_theme(self, name: str) -> str:
        self.theme_name = themes.norm(name)
        themes.set_theme(self.theme_name)
        self.theme_dirty = True
        label = themes.theme(self.theme_name)["label"]
        self.ctx.log(f"theme -> {self.theme_name} ({label})")
        return self.theme_name

    # ------------------------------------------------------------------ menus --
    # menus_env contract (menus.py reads these; row_for(panel) is the MC
    # 'what the panel has selected' hook that makes commands target things)
    @property
    def tree_root(self):
        return self.ctx.tree_root

    @property
    def kill_switch(self) -> bool:
        """State of the boot-time kill switch — the Patches menu shows it as
        a check mark, so it must read the store like the overview does."""
        try:
            return bool(self.ctx.store.patches_disabled())
        except Exception:
            return False

    def row_for(self, panel: str) -> model.Row | None:
        """The row a menu command would act on. NEVER builds a panel that
        is not open yet: building 'catalog' means a network fetch and
        building 'dev' means git probes, and menus() runs on every frame —
        that is exactly the TUI-3a freeze the user complained about. An
        unvisited panel simply has no selection; its commands show greyed
        with that reason, and visiting it once lights them up."""
        s = self.screens.get(panel)
        if s is None:
            return None
        row = s.current()
        return row if row is not None and row.selectable else None

    def menus(self) -> list:
        """Rebuild the bar when anything it mirrors moved (panel switch,
        cursor move, store change). Cheap (data only) — the stamp keeps the
        per-frame path honest."""
        s = self.screens.get(self.current)
        # every panel's cursor belongs in the signature: a menu command can
        # target a panel the operator is NOT looking at (open Keg from the
        # patches screen), and its dropdown must carry the stash they just
        # moved to, not the one cached when the bar was first built
        sig = (self.current, id(s), s.selected if s else 0,
               self.detail_open, self.footer_open, self.theme_name,
               self.ctx.tree_root, self.last_build, self.kill_switch,
               tuple(p.selected if p is not None else -1
                     for p in (self.screens.get(n) for n in
                               menus.PANEL_NAMES)))
        if self._menus_cache is None or sig != self._menus_stamp:
            self._menus_cache = menus.build(self)
            self._menus_stamp = sig
        return self._menus_cache

    def open_menu(self, idx: int) -> None:
        ms = self.menus()
        if not ms:
            return
        self.bar_index = idx % len(ms)
        self.bar_focus = True
        self.sub_path = []
        self.item_cursor = self._first_item(self._level_items(self.bar_index))

    def close_menu(self) -> None:
        self.bar_index = -1
        self.sub_path = []
        self.bar_focus = False

    def _level_items(self, menu_idx: int | None = None) -> list:
        """The item list of the deepest open submenu (or a menu's top level).
        Separators are menus.SEP — the string 'sep' — which frame renders and
        navigation skips."""
        ms = self.menus()
        idx = self.bar_index if menu_idx is None else menu_idx
        if idx < 0 or idx >= len(ms):
            return []
        items = ms[idx].items
        for k in self.sub_path:
            it = items[k] if k < len(items) else None
            if it is None or isinstance(it, str) or it.kind != "sub":
                self.sub_path = self.sub_path[:self.sub_path.index(k)]
                break
            items = it.payload
        return items

    @staticmethod
    def _first_item(items: list) -> int:
        for i, it in enumerate(items):
            if not isinstance(it, str) and it.enabled:
                return i
        return 0

    def _move_item(self, delta: int) -> None:
        items = self._level_items()
        n = len(items)
        if not n:
            return
        i = self.item_cursor
        for _ in range(n):
            i = (i + delta) % n
            it = items[i]
            if not isinstance(it, str):        # land on any row, greyed too
                self.item_cursor = i          # (MC stops there to show why)
                return
        self.item_cursor = i

    def _activate_item(self) -> None:
        items = self._level_items()
        if not items or self.item_cursor >= len(items):
            return
        it = items[self.item_cursor]
        if isinstance(it, str):
            return
        if not it.enabled:
            self.notice = f"{it.label}: {it.reason or 'not available now'}"
            return
        if it.kind == "sub":
            self.sub_path.append(self.item_cursor)
            self.item_cursor = self._first_item(self._level_items())
            return
        self.close_menu()
        if it.kind == "op":
            self._guard_then_run(it.payload, it.target, it.accel)
            return
        if it.kind == "panel":
            self.goto(it.payload)
            return
        if it.kind == "cmd":
            self._run_cmd(it.payload)

    def _run_cmd(self, cmd: str) -> None:
        if cmd == "quit":
            self.running = False
        elif cmd == "refresh":
            self.on_key("n")
        elif cmd == "toggle_detail":
            self.detail_open = not self.detail_open
        elif cmd == "toggle_footer":
            self.footer_open = not self.footer_open
        elif cmd == "help":
            self.show_help = True
        elif cmd == "about":
            self.show_about = True
        elif cmd.startswith("theme:"):
            self.set_theme(cmd[6:])
            self.build()
        else:
            self.notice = f"unknown command '{cmd}'"

    # ------------------------------------------------------------- pulse ----
    def start_pulse(self) -> None:
        """Background collector thread (TUI-3). Touches ONLY the context's
        TTL caches and the _pulse_now flag — never a Screen — so it cannot
        race with a paint."""
        def loop():
            while self.running:
                force, self._pulse_now = self._pulse_now, False
                if force:
                    self.ctx.invalidate()
                try:
                    self.ctx.pulse(want_catalog=(self.current == "catalog"))
                except Exception:
                    pass
                end = time.monotonic() + PULSE_SECS
                while self.running and time.monotonic() < end \
                        and not self._pulse_now:
                    time.sleep(0.1)
        self.pulse_thread = threading.Thread(target=loop, daemon=True,
                                             name="uplift-tui-pulse")
        self.pulse_thread.start()

    # ------------------------------------------------------- child tracking --
    def _note_process(self, proc) -> None:
        with self.proc_lock:
            self.proc = proc

    # --------------------------------------------------------------- screens --
    @property
    def parent_screen(self) -> model.Screen | None:
        return self.screens.get(self.actions_for or self.current)

    def build(self, name: str | None = None) -> model.Screen:
        name = name or self.current
        old = self.screens.get(name)
        if old is not None and old.current() is not None:
            key = old.current().key
            screen = model.BUILDERS[name](self.ctx)
            screen.selected = next((i for i, r in enumerate(screen.rows)
                                    if r.key == key), old.first_selectable())
        else:
            screen = model.BUILDERS[name](self.ctx)
            screen.selected = screen.first_selectable()
        screen.clamp()
        screen.notice = self.notice
        self.screens[name] = screen
        self.last_build = time.monotonic()
        self._menus_cache = None         # rows/selection moved: rebuild the bar
        return screen

    def _submenu_name(self) -> str:
        return (self.actions_for or "") + ":actions"

    def _rebuild_submenu(self) -> None:
        parent = self.screens.get(self.actions_for or "")
        if parent is None:
            self.actions_for = None
            return
        old = self.screens.get(self._submenu_name())
        keep = old.current().key if (old and old.current()) else None
        sub = model.build_actions(parent)
        if keep:
            sub.selected = next((i for i, r_ in enumerate(sub.rows)
                                 if r_.key == keep), 0)
        self.screens[self._submenu_name()] = sub

    @property
    def screen(self) -> model.Screen:
        if self.show_help:
            return _static_screen("help", HELP_LINES)
        if self.show_about:
            return _static_screen("about", ABOUT_LINES)
        if self.in_actions:
            sub = self.screens.get(self._submenu_name())
            if sub is not None:
                return sub
            self._rebuild_submenu()
            sub = self.screens.get(self._submenu_name())
            if sub is not None:
                return sub
        return self.screens.get(self.current) or self.build()

    def _step_screen(self, direction: int) -> None:
        # left/right walk the panels. 'menu' (the launcher) is not a panel,
        # and it must not crash the walk: index() on a missing name is what
        # killed the TUI when the operator pressed an arrow on the launcher
        # screen once — an unknown current starts from the first panel.
        order = menus.PANEL_NAMES
        if self.in_actions:
            self.close_actions()          # arrow steps out of the submenu
            return
        i = order.index(self.current) if self.current in order else -1
        self.goto(order[(i + direction) % len(order)])

    def goto(self, name: str) -> None:
        if name not in model.BUILDERS:
            return
        self.current = name
        self.actions_for = None
        self.pending = None
        self.yes_line = ""
        self.build(name)

    # ------------------------------------------------------- action submenu --
    def open_actions(self) -> bool:
        s = self.screen
        row = s.current()
        if row is None or not (s.row_ops() or s.screen_ops()):
            return False
        self.actions_for = self.current
        submenu = model.build_actions(s)
        self.screens[self.current + ":actions"] = submenu
        self.pending = None
        self.yes_line = ""
        return True

    def close_actions(self) -> None:
        self.actions_for = None
        self.pending = None
        self.yes_line = ""
        self.build(self.current)

    @property
    def in_actions(self) -> bool:
        return self.actions_for is not None

    def refresh_if_stale(self) -> None:
        if (not self.pending and not self.busy
                and time.monotonic() - self.last_build > REFRESH_SECS):
            self.build()

    # ------------------------------------------------------------------ keys --
    def move(self, delta: int) -> None:
        s = self.screen
        order = [i for i, r in enumerate(s.rows) if r.kind != "header"]
        if not order:
            return
        if s.selected in order:
            pos = order.index(s.selected)
        else:
            pos = min(range(len(order)), key=lambda i: abs(order[i] - s.selected))
        s.selected = order[max(0, min(len(order) - 1,
                                      pos + (1 if delta > 0 else -1)))]

    def page(self, direction: int) -> None:
        for _ in range(8):
            self.move(direction)

    @property
    def awaiting_yes(self) -> bool:
        return bool(self.pending) and self.pending[0].danger == ops_mod.HIGH

    @property
    def prompt(self) -> str:
        if not self.pending:
            return ""
        op, row = self.pending
        note = ""
        if op.danger == ops_mod.HIGH and row is not None \
                and row.kind == ops_mod.KEG:
            note = f"keg {row.key}"
        return model.confirm_prompt(
            op, row.raw if row is not None else None, ctx_note=note,
            what=f"'{row.key}'" if row is not None else "this screen")

    @property
    def bar_open(self) -> bool:
        return self.bar_index >= 0

    def on_key(self, key: str) -> None:
        """Dispatch one logical key: letters/names, 'alt:x', 'yes:<text>'."""
        if self.pending:
            if key in ("q", "ctrl_c", "escape"):
                self.pending = None
                self.yes_line = ""
                self.notice = "cancelled"
                return
            if key.startswith("alt:"):
                return                      # Alt during a gate: swallow
            if key.startswith("yes:"):
                self._answer_yes(key[4:])
                return
            self._answer(key)
            return
        if self.show_help or self.show_about:
            self.show_help = self.show_about = False
            return
        if key.startswith("alt:"):
            for i, m in enumerate(self.menus()):
                if m.accel == key[4:].lower():
                    if self.bar_index == i:
                        self.close_menu()
                        self.bar_focus = False
                    else:
                        self.open_menu(i)
                    return
            self.notice = f"no menu starts with '{key[4:]}'"
            return
        if self.bar_open:
            self._bar_key(key)
            return
        if key == "f9":
            if self.bar_open:
                self.close_menu()
            else:
                self.bar_focus = not self.bar_focus
                if self.bar_focus:
                    self.open_menu(0)
            return
        if self.bar_focus:
            if key in ("left", "right"):
                self.open_menu(self.bar_index + (1 if key == "right" else -1))
                return
            if key in ("down", "enter"):
                self.open_menu(max(0, self.bar_index))
                return
            if key in ("up", "escape"):
                self.bar_focus = False
                return
        if key == "escape" or key == "backspace":
            if self.in_actions:
                self.notice = "back to the list"
                self.close_actions()
                return
            if self.current != "menu":
                self.goto("menu")
                return
            self.running = False
            return
        if key in ("q", "ctrl_c", "f10"):
            self.running = False
            return
        if key == "f1":
            self.show_help = True
            return
        if key == "f2":
            themes.set_theme(self.theme_name)
            self.notice = "view saved to tui.json"
            return
        if key == "f3":
            self.detail_open = not self.detail_open
            return
        if key == "f4":
            self.show_about = True
            return
        if key == "f5":
            self.ctx.invalidate()
            self._pulse_now = True
            self.build()
            self.notice = ""
            return
        if key == "tab":
            self._step_screen(+1)
            return
        if key == "m":
            self.goto("menu")
            self.notice = ""
            return
        if key == "left":
            self._step_screen(-1)
            return
        if key == "right":
            self._step_screen(+1)
            return
        if key == "space":
            self.detail_open = not self.detail_open
            return
        if key == "?":
            self.show_help = True
            return
        if key in ("T",):
            self.cycle_theme()
            self.notice = f"theme: {self.theme['label']}"
            self.build()
            return
        if key in model.SCREEN_KEYS:
            self.goto(model.SCREEN_KEYS[key])
            return
        if key == "n":
            self.ctx.invalidate()
            self._pulse_now = True
            self.build()
            self.notice = ""
            return
        if key in ("j", "down"):
            self.move(+1)
            return
        if key in ("k", "up"):
            self.move(-1)
            return
        if key == "pgdn":
            self.page(+1)
            return
        if key == "pgup":
            self.page(-1)
            return
        if key == "home":
            self.screen.selected = next(
                (i for i, r in enumerate(self.screen.rows)
                 if r.kind != "header"), 0)
            return
        if key == "end":
            self.screen.selected = len(self.screen.rows) - 1
            self.screen.clamp()
            return
        if key == "enter":
            if self.in_actions:
                self._run_submenu_choice()
                return
            if self.current == "menu":
                row = self.screen.current()
                if row is not None and row.kind == "menu":
                    self.goto(row.key)
                return
            if self.open_actions():
                return
            self.detail_open = not self.detail_open
            return
        if self.busy:
            self.notice = "an action is still running — Ctrl-C cancels a " \
                          "command"
            return
        self._run_or_ask(key)

    def _bar_key(self, key: str) -> None:
        """Keys while a dropdown is open: everything belongs to the menu."""
        if key in ("up", "k"):
            self._move_item(-1)
            return
        if key in ("down", "j"):
            self._move_item(+1)
            return
        if key == "home":
            self.item_cursor = 0
            return
        if key == "end":
            items = self._level_items()
            self.item_cursor = len(items) - 1 if items else 0
            return
        if key == "left":
            self.open_menu(self.bar_index - 1)
            return
        if key == "right":
            if self.sub_path:
                self.sub_path.pop()
                self.item_cursor = self._first_item(self._level_items())
                return
            self.open_menu(self.bar_index + 1)
            return
        if key in ("escape", "backspace"):
            if self.sub_path:
                self.sub_path.pop()
                self.item_cursor = self._first_item(self._level_items())
                return
            # MC: closing a dropdown leaves the BAR selected, so a second
            # Esc backs out of the panel and arrows can hop to another menu
            self.bar_index, self.sub_path = -1, []
            self.bar_focus = True
            return
        if key in ("q", "ctrl_c", "f10"):
            self.close_menu()
            self.running = False
            return
        if key == "f9":
            self.close_menu()
            return
        if key == "enter":
            self._activate_item()
            return
        if key in model.SCREEN_KEYS and not any(
                not isinstance(it, str) and it.accel == key
                for it in self._level_items()):
            self.close_menu()
            self.goto(model.SCREEN_KEYS[key])
            return
        if len(key) == 1:
            items = self._level_items()
            # exact-case FIRST: 'u' is update and 'U' is the kill switch on
            # the panels, and a dropdown must not make them ambiguous — the
            # case-insensitive fallback only fires when one item matches
            exact = [i for i, it in enumerate(items)
                     if not isinstance(it, str) and it.accel == key]
            loose = [i for i, it in enumerate(items)
                     if not isinstance(it, str) and it.accel
                     and it.accel.lower() == key.lower()]
            chosen = exact or (loose if len(loose) == 1 else [])
            if chosen:
                self.item_cursor = chosen[0]
                self._activate_item()
                return
            if len(loose) > 1:
                self.notice = ("press the letter exactly: "
                               + ", ".join(items[i].label for i in loose))
            else:
                self.notice = f"'{key}' is not a command in this menu"
            return
        self.notice = "Esc closes the menu"

    # ----------------------------------------------------------- op dispatch --
    def _pool(self) -> list:
        if self.in_actions:
            parent = self.screens.get(self.actions_for)
            if parent is None:
                return []
            return list(parent.row_ops()) + list(parent.screen_ops())
        s = self.screen
        return list(s.row_ops()) + list(s.screen_ops())

    def _run_submenu_choice(self) -> None:
        row = self.screen.current()
        if row is None or row.kind == "header":
            return
        op = (row.raw or {}).get("op")
        if op is None:
            self.close_actions()
            return
        self._guard_then_run(op, None if op.row_kinds is ops_mod.ANY
                             else self._target_row())

    def _target_row(self):
        if self.in_actions:
            parent = self.screens.get(self.actions_for or "")
            return parent.current() if parent else None
        return self.screen.current()

    def _run_or_ask(self, key: str) -> None:
        op = ops_mod.find(key, self._pool())
        if op is None:
            if self.in_actions:
                self.notice = f"'{key}' is not one of these actions"
                return
            self.notice = f"'{key}' does nothing on the {self.current} screen"
            return
        self._guard_then_run(op, self._target_row(), key)

    def _guard_then_run(self, op, row, key: str = "") -> None:
        if op.needs_tree and not self.ctx.tree_root:
            self.notice = ("no omlx package tree — install omlx or run "
                           "'omlx-uplift install' first")
            return
        if op.row_kinds is not ops_mod.ANY:
            if row is None or not op.applies_to(row.kind):
                self.notice = f"'{key or op.key}' needs a " \
                              f"{'/'.join(op.row_kinds)} row"
                return
        if op.danger == ops_mod.READ:
            self._launch(op, row)
            return
        self.pending = (op, row)
        self.yes_line = ""

    def _answer_yes(self, typed: str) -> None:
        pending, self.pending = self.pending, None
        self.yes_line = ""
        if pending is None:
            return
        op, row = pending
        if typed.strip().upper() == "YES":
            self._launch(op, row)
        else:
            self.notice = f"cancelled — {op.label} needs a typed YES"

    def _answer(self, key: str) -> None:
        """y/N gate for a WRITE op.

        A HIGH op NEVER launches from here. Its answer arrives as a whole line
        ('yes:<text>') from the curses line reader; a bare keystroke reaching
        this method while a HIGH op is armed means the operator pressed
        something else — that is a cancellation, never a confirmation."""
        op, row = self.pending
        self.pending = None
        if op.danger == ops_mod.HIGH:
            self.notice = f"cancelled — {op.label} needs a typed YES"
            return
        if key == "y":
            self._launch(op, row)
        else:
            self.notice = "cancelled"

    def _launch(self, op, row) -> None:
        self.busy = op.label
        self.notice = ""
        payload = row.raw if row is not None else None
        self.ctx.log(f"> {op.label}  {op.cli_line(payload)}")

        def work():
            try:
                res = (op.run(self.ctx, payload) if payload is not None
                       else op.run(self.ctx))
            except Exception as exc:            # an op must never kill the UI
                res = {"ok": False,
                       "reason": f"{type(exc).__name__}: {exc or 'no detail'}"}
            self.results.put((op, res))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def drain(self) -> bool:
        """Apply a finished op's result. True when it changed the screen."""
        try:
            op, res = self.results.get_nowait()
        except queue.Empty:
            return False
        self.busy = ""
        self.worker = None
        ok = bool(res.get("ok", True)) if isinstance(res, dict) else True
        for line in model.result_lines(res):
            self.ctx.log(f"   {line}")
        self.notice = ("done: " if ok else "FAILED: ") + op.label
        self.ctx.invalidate()
        self._pulse_now = True
        if self.in_actions:
            self.close_actions()
        else:
            self.build()
        return True

    def cancel(self) -> str:
        """Ctrl-C: kill a running child command."""
        with self.proc_lock:
            proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
                return "sent SIGKILL to the running command"
            except OSError as exc:
                return f"could not kill the command: {exc}"
        return "nothing to cancel (an in-process action cannot be stopped)"

    # ------------------------------------------------------------- mouse ----
    def click(self, x: int, y: int) -> None:
        """Turn a frame-coordinate click into behaviour via the last
        rendered Frame's hit list (bar names, dropdown items, panel rows)."""
        f = self._frame
        if f is None:
            return
        for x0, x1, y0, y1, action in f.hits:
            if not (y0 <= y <= y1 and x0 <= x <= x1):
                continue
            kind, idx = action
            if kind == "menu":
                if self.bar_index == idx:
                    self.close_menu()
                    self.bar_focus = False
                else:
                    self.open_menu(idx)
                return
            if kind == "item":
                items = self._level_items()
                if idx < len(items):
                    self.item_cursor = idx
                    self._activate_item()
                return
            if kind == "row":
                if self.bar_open:
                    self.close_menu()
                s = self.screen
                if idx < len(s.rows):
                    s.selected = idx
                return

    # ------------------------------------------------------------- rendering --
    def utf8(self) -> bool:
        import os
        enc = (os.environ.get("PYTHONIOENCODING", "")
               + os.environ.get("LC_ALL", "")
               + os.environ.get("LANG", "")).lower()
        return "utf" in enc or not enc

    def lines(self, width: int, height: int) -> list:
        """The whole frame as segment lines (frame.render_frame). The painter
        writes segments line by line; the model's plain-text path (model.render)
        is gone from the live screen but stays as the tested fallback."""
        s = self.screen
        notice = self.notice
        info = self.theme_info or {}
        head = (self.show_help or self.show_about)
        # the P(DOOM) persona keeps its on-screen signature: a theme that
        # declares a title_prefix shows it in the bar (TUI-2 put it in the
        # old title line; the bar line is the title now)
        prefix = self.theme.get("title_prefix") or ""
        bar_note = ((prefix + " :: " if prefix else "")
                    + f"theme {self.theme_name}  {width}x{height}")
        footers = [] if head else (list(s.footer) if self.footer_open else [])
        if notice and not self.busy:
            footers = [(notice, model.TONE_WARN)] + footers
        if info.get("note") and info.get("mode") != "truecolor-exact":
            footers = footers + [(f"palette: {info['note']}", model.TONE_DIM)]
        # F3 OFF means 'give the rows the whole window' — pass None so the
        # frame drops the pane entirely (side or stacked) instead of drawing
        # an empty one. F3 ON feeds it the SELECTED row's detail, which is
        # what the pane is for on a narrow terminal too.
        detail = None
        if self.detail_open and not head:
            row = s.current()
            detail = (row.detail if row is not None and row.detail
                      else "no extra detail for this entry")
        self._frame = frame.render_frame(
            s,
            # the bar is ALWAYS drawn (it is the shell); only the dropdown
            # opens and closes
            menus=self.menus(),
            bar_index=self.bar_index, bar_open=self.bar_open,
            bar_focus=self.bar_focus and not self.bar_open,
            items=(self._level_items() if self.bar_open else None),
            item_cursor=self.item_cursor,
            detail=detail,
            footers=footers,
            prompt=self.prompt,
            busy=self.busy,
            yes_line=self.yes_line if self.awaiting_yes else None,
            width=width, height=height or 24,
            notice=bar_note, utf8=self.utf8())
        return self._frame.lines


def _static_screen(name: str, lines: list) -> model.Screen:
    rows = [model.Row("info", "", [(t, model.TONE_TITLE if i == 0 else None)])
            for i, t in enumerate(lines)]
    return model.Screen(name, name.title(), rows=rows)


# ======================================================== curses plumbing ==
# Kept out of App so every behaviour above runs headless in the tests.

_SPECIAL = {}


def run_tui(argv=None) -> int:
    """Entry point for `omlx-uplift tui`: tty guard, then curses."""
    import os
    import sys

    if not sys.stdout.isatty() or not sys.stdin.isatty():
        print("omlx-uplift tui needs a terminal (stdin and stdout must be a "
              "tty).\nHeadless equivalents: omlx-uplift patch status | "
              "omlx-uplift dev status | the dashboard at /uplift/",
              file=sys.stderr)
        return 2
    term = os.environ.get("TERM", "")
    if term in ("", "dumb"):
        print(f"omlx-uplift tui needs a real terminal (TERM={term or 'unset'!r}). "
              "Use the CLI verbs instead.", file=sys.stderr)
        return 2
    try:
        import curses
    except ImportError as exc:                  # a few python builds omit it
        print(f"omlx-uplift tui needs the stdlib curses module ({exc})",
              file=sys.stderr)
        return 2
    app = App()
    app.start_pulse()
    try:
        return curses.wrapper(_curses_loop, app)
    except Exception as exc:                    # curses.wrapper already
        import traceback                        # restored the terminal here
        sys.stderr.write(f"tui failed: {type(exc).__name__}: {exc}\n"
                         + traceback.format_exc()[-1500:])
        app.cancel()
        return 1


def _key_name(ch):
    """curses key code -> the logical key name App.on_key speaks."""
    import curses

    if not _SPECIAL:
        _SPECIAL.update({27: "escape", 10: "enter", 13: "enter", 9: "tab",
                         32: "space",
                         127: "backspace", 8: "backspace", 3: "ctrl_c",
                         2: "ctrl_b"})
        for attr, name in (("KEY_UP", "up"), ("KEY_DOWN", "down"),
                           ("KEY_PPAGE", "pgup"), ("KEY_NPAGE", "pgdn"),
                           ("KEY_HOME", "home"), ("KEY_END", "end"),
                           ("KEY_LEFT", "left"), ("KEY_RIGHT", "right"),
                           ("KEY_F1", "f1"), ("KEY_F2", "f2"),
                           ("KEY_F3", "f3"), ("KEY_F4", "f4"),
                           ("KEY_F5", "f5"), ("KEY_F6", "f6"),
                           ("KEY_F7", "f7"), ("KEY_F8", "f8"),
                           ("KEY_F9", "f9"), ("KEY_F10", "f10"),
                           ("KEY_RESIZE", "resize"), ("KEY_MOUSE", "mouse")):
            code = getattr(curses, attr, None)
            if code is not None:
                _SPECIAL.setdefault(code, name)
    name = _SPECIAL.get(ch)
    if name is not None:
        return name
    if 32 < ch < 127:
        return chr(ch)
    return None


def _apply_theme(curses, app) -> None:
    """Build this theme's tone -> attribute map and remember it."""
    try:
        max_colors = curses.COLORS
        n_pairs = curses.COLOR_PAIRS
    except curses.error:
        max_colors, n_pairs = 8, 8
    try:
        can_change = bool(curses.can_change_color())
    except curses.error:
        can_change = False
    slot = [0]

    def alloc_pair(fg, bg):
        slot[0] += 1
        try:
            curses.init_pair(slot[0], fg, bg)
        except curses.error:
            return 0
        return curses.color_pair(slot[0])

    attrs, info = themes.palette(
        app.theme_name, max_colors, can_change=can_change,
        alloc_pair=alloc_pair,
        init_color=(curses.init_color if can_change else None),
        n_pairs=n_pairs, bold_attr=curses.A_BOLD,
        reverse_attr=curses.A_REVERSE)
    attrs[None] = curses.A_NORMAL
    app.attrs, app.theme_info = attrs, info
    app.ctx.log(f"theme {app.theme_name}: {info['mode']} / {info['note']} "
                f"({info['pairs']} colour pairs)")


def _curses_loop(stdscr, app) -> int:
    import curses

    try:
        curses.curs_set(0)
    except curses.error:
        pass
    try:
        curses.use_default_colors()
    except curses.error:
        pass
    try:
        curses.start_color()
    except curses.error:
        pass
    _apply_theme(curses, app)
    try:
        stdscr.bkgd(" ", app.theme_info.get("ground", 0))
    except curses.error:
        pass
    stdscr.timeout(LOOP_TIMEOUT_MS)
    stdscr.keypad(True)
    mask = getattr(curses, "ALL_MOUSE_EVENTS", None)
    if mask is not None and hasattr(curses, "mousemask"):
        try:
            curses.mousemask(mask)
        except curses.error:
            pass

    last_paint = 0.0
    size = (0, 0)
    dirty = True
    while app.running:
        app.drain()
        app.refresh_if_stale()
        rows, cols = stdscr.getmaxyx()
        if app.theme_dirty:
            _apply_theme(curses, app)
            app.theme_dirty = False
        if dirty or size != (rows, cols) or \
                time.monotonic() - last_paint > 0.15:
            _paint(stdscr, app, rows, cols)
            last_paint = time.monotonic()
            size = (rows, cols)
            dirty = False

        try:
            ch = stdscr.getch()
        except curses.error:
            ch = -1
        if ch == -1:
            continue                      # getch already waited up to 60 ms
        name = _read_key(stdscr, curses, ch)
        if name is None:
            continue
        dirty = True
        if name == "mouse":
            _click(stdscr, app)
            continue
        if name in ("resize", "ctrl_b"):
            continue
        if name == "ctrl_c":
            app.ctx.log(app.cancel())
            app.notice = "cancel requested"
            continue
        if app.awaiting_yes and name not in ("q", "escape", "ctrl_c"):
            _feed_yes(name, app)
            continue
        app.on_key(name)
    return 0


def _read_key(stdscr, curses, ch):
    """One logical key name, ESC-prefixed sequences assembled HERE rather
    than trusted to curses. macOS's ncurses hands an arrow over as three
    separate getch() results (escape, '[', 'D') whenever the terminal's
    timing splits the sequence — a plain timer-based Alt window then ate
    the Escape and orphaned the letters (found live: an arrow press backed
    out of the panel and typed '[' at the app). So: after a raw 27, wait a
    few ms for what follows and decode it ourselves; nothing follows in
    time, it really was Escape."""
    if ch != 27:
        return _key_name(ch)
    # macOS curses.timeout() returns None, not the old value — restore the
    # constant the loop set, never a captured 'previous'
    stdscr.timeout(ESC_COMBINE_MS)
    try:
        n2 = stdscr.getch()
        if n2 == -1:
            return "escape"                   # a real, lonely Escape
        if n2 == 27:
            return "escape"                   # double Esc: back out once
        if n2 == ord("[") or n2 == ord("O"):
            return _read_csi(stdscr, curses, n2)
        if 32 < n2 < 127:
            return "alt:" + chr(n2)           # Meta+letter, as terminals
        return None                           # Alt+something odd: ignore
    finally:
        stdscr.timeout(LOOP_TIMEOUT_MS)


def _read_csi(stdscr, curses, lead):
    """lead is '[' or 'O'; consume the rest of the sequence and name it."""
    if lead == ord("O"):
        n3 = stdscr.getch()
        return {ord("P"): "f1", ord("Q"): "f2", ord("R"): "f3",
                ord("S"): "f4", ord("A"): "up", ord("B"): "down",
                ord("C"): "right", ord("D"): "left",
                ord("M"): "enter"}.get(n3)
    buf = ""
    while len(buf) < 16:
        c = stdscr.getch()
        if c == -1:
            return None
        if 0x40 <= c <= 0x7E:                 # final byte ends the CSI
            break
        buf += chr(c)
    if buf.startswith("M") or buf.startswith("<"):
        # a mouse report reached us raw (curses did not translate it):
        # 'M' + 3 legacy bytes, or SGR '<' … m — swallow the payload so it
        # cannot leak as keys; the click is handled via the curses queue if
        # one is queued, otherwise this press is simply ignored
        if buf.startswith("M"):
            for _ in range(3):
                stdscr.getch()
        else:
            while True:
                c = stdscr.getch()
                if c in (-1, ord("m"), ord("M")):
                    break
        return "mouse"
    simple = {"A": "up", "B": "down", "C": "right", "D": "left",
              "H": "home", "F": "end",
              "1~": "home", "4~": "end", "5~": "pgup", "6~": "pgdn",
              "7~": "home", "8~": "end",
              "11~": "f1", "12~": "f2", "13~": "f3", "14~": "f4",
              "15~": "f5", "17~": "f6", "18~": "f7", "19~": "f8",
              "20~": "f9", "21~": "f10", "23~": "f11", "24~": "f12"}
    return simple.get(buf)


def _feed_yes(key: str, app) -> None:
    """A HIGH-danger confirmation reads a whole LINE: 'YES' + enter runs,
    anything else cancels — a stray 'y' can never arm a keg switch."""
    if key == "enter":
        answer, app.yes_line = app.yes_line, ""
        app.on_key("yes:" + answer)
        return
    if key == "backspace":
        app.yes_line = app.yes_line[:-1]
        return
    if key in ("escape", "ctrl_c", "q"):
        app.yes_line = ""
        app.on_key("yes:")                    # empty answer == cancel
        return
    if len(key) == 1:
        app.yes_line = (app.yes_line + key)[:24]


def _click(stdscr, app) -> None:
    """Route a mouse click through the last frame's hit list: the menu bar,
    a dropdown item, or a panel row."""
    import curses

    try:
        _, x, y, _z, _m = curses.getmouse()
    except curses.error:
        return
    app.click(int(x), int(y))


def _paint(stdscr, app, rows: int, cols: int) -> None:
    """Map the frame's tones to this theme's attributes and write the cells.
    stdscr.erase() + noutrefresh/doupdate means one clean swap per repaint.
    Every visible cell is written every frame — a line that SHRANK must not
    leak old text, and full-width bars make selections read as bars."""
    import curses

    attrs = app.attrs or {}
    attrs.setdefault(None, curses.A_NORMAL)
    stdscr.erase()
    lines = app.lines(cols, rows)
    app_lines = lines if lines else []

    def tone_attr(tone):
        return attrs.get(tone, curses.A_NORMAL)

    # every frame line gets painted, INCLUDING the last row: the frame
    # already clips every line to cols-1, so no write lands in the cell that
    # triggers auto-scroll. (The old loop stopped one short because the last
    # row used to hold the status line; the F-key legend lives there now.)
    for y in range(max(0, rows)):
        if y >= len(app_lines):
            break
        line = app_lines[y]
        if isinstance(line, str):               # legacy plain-text fallback
            line = [(line, None)]
        x = 0
        for text, tone in line:
            if not text or x >= cols - 1:
                break
            text = text[:cols - 1 - x]
            try:
                stdscr.addstr(y, x, text, tone_attr(tone))
            except curses.error:
                pass
            x += len(text)
        if x < cols - 1:
            try:
                stdscr.addstr(y, x, " " * (cols - 1 - x),
                              tone_attr(line[-1][1] if line else None))
            except curses.error:
                pass
    # theme quality and size live in the bar line (frame notice) now — the
    # bottom row belongs to the F-key legend, do not paint over it
    stdscr.noutrefresh()
    curses.doupdate()


def model_tones():
    from . import model as _m
    return (_m.TONE_OK, _m.TONE_BAD, _m.TONE_WARN, _m.TONE_DIM, _m.TONE_BOLD,
            _m.TONE_SEL, _m.TONE_TITLE, _m.TONE_PANE)
