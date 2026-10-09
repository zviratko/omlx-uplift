"""TUI curses loop (TUI-1).

Thin by design: read a key, ask App what to do, paint what the model rendered.
`App` holds every behaviour (navigation, the confirm gate, the worker thread)
and imports no curses, so it is testable headless; curses lives only in the
plumbing at the bottom of this file.

Keys:  1..5 screens | j/k or arrows move | PgUp/PgDn jump | enter detail
       n re-read | ? help | q quit | a letter runs the op printed in the key bar
WRITE ops answer y/N; HIGH ops need a typed YES on its own line, so a stray
'y' can never arm a keg switch or a restart. One op runs at a time.
"""
from __future__ import annotations

import queue
import threading
import time

from . import model
from . import ops as ops_mod
from . import themes
from .context import Context

REFRESH_SECS = 5.0      # the dashboard, a boot reconcile or another terminal
                        # can change the store while we sit here looking at it
YES_PROMPT_SUFFIX = "(type YES, then enter)"

HELP_LINES = [
    "omlx-uplift tui — keys and rules",
    "",
    "  1 overview   2 patches   3 catalog   4 dev keg   5 session log",
    "  j/k or up/down  move     PgUp/PgDn  jump by 8    enter  detail pane",
    "  n  re-read live state    T  cycle colour theme    ?  this help",
    "  q  quit",
    "",
    "  A letter runs the action printed above it in the key bar. Write",
    "  actions answer y/N; actions that touch tree bytes, a keg or the",
    "  running service ask you to type YES. Every action shows the CLI",
    "  command it mirrors, so nothing here is hidden from the shell — you",
    "  can always do the same thing by hand.",
    "",
    "  Nothing is written unless you confirm it. The store on disk is the",
    "  same one the dashboard and the CLI use, and omlx re-applies patches",
    "  at every boot, so most patch changes land on the next restart (or",
    "  press 'y' on the patches screen to reconcile right now).",
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


class App:
    """All TUI behaviour except painting."""

    def __init__(self, ctx: Context | None = None):
        self.ctx = ctx or Context()
        self.screens: dict[str, model.Screen] = {}
        self.current = "overview"
        self.detail_open = True
        self.notice = ""
        self.busy = ""
        self.pending: tuple | None = None   # (op, row) awaiting confirmation
        self.yes_line = ""
        self.worker: threading.Thread | None = None
        self.results: queue.Queue = queue.Queue()
        self.proc = None
        self.proc_lock = threading.Lock()
        self.last_build = 0.0
        self.running = True
        self.show_help = False
        # theme: persisted in ~/.omlx/uplift/tui.json, 'T' cycles it. The
        # painter replaces this dict with curses-backed attrs once the screen
        # is up; until then the model still renders (tests, headless).
        self.theme_name = themes.get_theme()
        # painter state: set by _apply_theme once curses is up; headless the
        # model tones paint as plain text, which is what the tests assert on
        self.attrs: dict = {}
        self.theme_info: dict = {"mode": "headless", "note": "", "pairs": 0,
                                 "label": themes.theme(self.theme_name)["label"]}
        self.theme_dirty = True         # (re)build colour pairs before paint
        self.ctx.on_process = self._note_process
        self.build(self.current)

    # ----------------------------------------------------------------- theme --
    @property
    def theme(self) -> dict:
        return themes.theme(self.theme_name)

    def cycle_theme(self, direction: int = 1) -> str:
        """Next/previous palette, remembered at once — a cosmetic choice the
        operator just made should not need a save step."""
        order = themes.names()
        i = order.index(themes.norm(self.theme_name))
        self.theme_name = order[(i + direction) % len(order)]
        themes.set_theme(self.theme_name)
        self.theme_dirty = True         # the curses loop re-maps the palette
        label = themes.theme(self.theme_name)["label"]
        self.ctx.log(f"theme -> {self.theme_name} ({label})")
        return self.theme_name

    # ------------------------------------------------------- child tracking --
    def _note_process(self, proc) -> None:
        with self.proc_lock:
            self.proc = proc

    # --------------------------------------------------------------- screens --
    def build(self, name: str | None = None) -> model.Screen:
        name = name or self.current
        old = self.screens.get(name)
        if old is not None and old.current() is not None:
            # stay on the same entry across a rebuild (state changed under
            # us: a patch appeared, a keg was stashed); fall back to position
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
        return screen

    @property
    def screen(self) -> model.Screen:
        return self.screens.get(self.current) or self.build()

    def goto(self, name: str) -> None:
        if name not in model.BUILDERS:
            return
        self.current = name
        self.pending = None
        self.yes_line = ""
        self.build(name)

    def refresh_if_stale(self) -> None:
        """Re-read state between actions. The catalog screen costs a network
        fetch, so it only refreshes on 'n'."""
        if (not self.pending and not self.busy
                and self.current != "catalog"
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

    def on_key(self, key: str) -> None:
        """Dispatch one logical key ('q', 'enter', 'down', 'y', ...)."""
        if self.pending:
            # q must stay a way out; Ctrl-C too. Everything else while a
            # HIGH op is pending feeds the typed-YES line (the curses layer
            # buffers that line and hands the finished answer here as
            # 'yes:<text>').
            if key in ("q", "ctrl_c", "escape"):
                self.pending = None
                self.yes_line = ""
                self.notice = "cancelled"
                return
            if key.startswith("yes:"):
                self._answer_yes(key[4:])
                return
            self._answer(key)
            return
        if self.show_help:
            self.show_help = False
            return
        if key in ("q", "escape", "ctrl_c"):
            self.running = False
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
        if key in ("n", "f5"):
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
            self.detail_open = not self.detail_open
            return
        if self.busy:
            self.notice = "an action is still running — Ctrl-C cancels a " \
                          "command"
            return
        self._run_or_ask(key)

    # ----------------------------------------------------------- op dispatch --
    def _pool(self) -> list:
        s = self.screen
        return list(s.row_ops()) + list(s.screen_ops())

    def _run_or_ask(self, key: str) -> None:
        op = ops_mod.find(key, self._pool())
        if op is None:
            self.notice = f"'{key}' does nothing on the {self.current} screen"
            return
        # the tree check runs BEFORE the row check: with no omlx tree every
        # one of these actions is unavailable, and 'select a patch row' would
        # send the operator looking for the wrong thing entirely
        if op.needs_tree and not self.ctx.tree_root:
            self.notice = ("no omlx package tree — install omlx or run "
                           "'omlx-uplift install' first")
            return
        row = None
        if op.row_kinds is not ops_mod.ANY:
            row = self.screen.current()
            if row is None or not op.applies_to(row.kind):
                self.notice = f"'{key}' needs a {'/'.join(op.row_kinds)} row"
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
        something else (a screen key, a stray letter) — that is a cancellation,
        never a confirmation. Keeping this branch incapable of launching is the
        property that makes 'q/1/j during a YES prompt' safe."""
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
        self.build()
        return True

    def cancel(self) -> str:
        """Ctrl-C: kill a running child command. An in-process store write
        cannot be interrupted safely, so say so instead of pretending."""
        with self.proc_lock:
            proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
                return "sent SIGKILL to the running command"
            except OSError as exc:
                return f"could not kill the command: {exc}"
        return "nothing to cancel (an in-process action cannot be stopped)"

    # ------------------------------------------------------------- rendering --
    def lines(self, width: int, height: int) -> list:
        if self.show_help:
            # the help text is longer than a small window: paint what fits and
            # say the rest is one key away, instead of erroring on addstr
            room = max(3, (height or 24) - 1)
            lines = [(model._trunc(t, width),
                      model.TONE_TITLE if i == 0 else None)
                     for i, t in enumerate(HELP_LINES[:room])]
            if len(HELP_LINES) > room:
                lines.append((model._trunc(
                    f"  ... {len(HELP_LINES) - room} more line(s) — widen the "
                    f"window", width), model.TONE_WARN))
            return lines
        self.screen.notice = self.notice      # a notice must show at once,
        detail = None if self.detail_open else ""   # not after the next build
        return model.render(self.screen, width, detail=detail,
                            prompt=self.prompt, busy=self.busy, height=height,
                            yes_line=self.yes_line if self.awaiting_yes
                            else None, theme=self.theme)


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
    try:
        return curses.wrapper(_curses_loop, app)
    except Exception as exc:                    # curses.wrapper already
        import traceback                        # restored the terminal here
        sys.stderr.write(f"tui failed: {type(exc).__name__}: {exc}\n"
                         + traceback.format_exc()[-1500:])
        app.cancel()
        return 1


def _key_name(ch):
    """curses key code -> the logical key name App.on_key speaks. Built once:
    the KEY_* constants only exist after curses is imported, so the table
    cannot be a module literal."""
    import curses

    if not _SPECIAL:
        _SPECIAL.update({27: "escape", 10: "enter", 13: "enter", 9: "enter",
                         127: "backspace", 8: "backspace", 3: "ctrl_c",
                         2: "ctrl_b"})
        # named KEY_* constants are not guaranteed on every platform (a
        # minimal ncurses build can omit KEY_MOUSE or KEY_RESIZE), and one
        # missing attribute must not kill the TUI at boot
        for attr, name in (("KEY_UP", "up"), ("KEY_DOWN", "down"),
                           ("KEY_PPAGE", "pgup"), ("KEY_NPAGE", "pgdn"),
                           ("KEY_HOME", "home"), ("KEY_END", "end"),
                           ("KEY_LEFT", "left"), ("KEY_RIGHT", "right"),
                           ("KEY_F5", "f5"), ("KEY_RESIZE", "resize"),
                           ("KEY_MOUSE", "mouse")):
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
    """Build this theme's tone -> attribute map and remember it, plus the
    theme name it was built for. Re-runs whenever the operator presses 'T':
    colour pairs are cheap to re-init and the alternative (a second set of
    pairs per theme) wastes slots on terminals that only have 64 or 32."""
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
        """init_pair + color_pair(pair number). The default colour is -1,
        which use_default_colors() maps to the terminal's own background."""
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

    try:                                  # not every terminal can hide it
        curses.curs_set(0)
    except curses.error:
        pass
    try:
        curses.use_default_colors()       # lets a pair keep the terminal's bg
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
        pass                            # no colour capability: plain ground
    stdscr.nodelay(True)
    stdscr.keypad(True)
    # mouse reporting is a convenience; a minimal ncurses build may not
    # expose it at all (AttributeError, not curses.error) and that must not
    # stop the TUI from starting
    mask = getattr(curses, "ALL_MOUSE_EVENTS", None)
    if mask is not None and hasattr(curses, "mousemask"):
        try:
            curses.mousemask(mask)
        except curses.error:
            pass

    last_paint = 0.0
    size = (0, 0)
    while app.running:
        app.drain()
        app.refresh_if_stale()
        rows, cols = stdscr.getmaxyx()
        if app.theme_dirty:
            _apply_theme(curses, app)
            app.theme_dirty = False
        if time.monotonic() - last_paint > 0.15 or size != (rows, cols):
            _paint(stdscr, app, rows, cols)
            last_paint = time.monotonic()
            size = (rows, cols)

        try:
            ch = stdscr.getch()
        except curses.error:
            ch = -1
        if ch == -1:
            time.sleep(0.05)
            continue
        name = _key_name(ch)
        if name == "mouse":
            _click(stdscr, app, rows)
            continue
        if name in (None, "resize", "left", "right", "ctrl_b"):
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


def _feed_yes(key: str, app) -> None:
    """A HIGH-danger confirmation reads a whole LINE, not a key: 'YES' +
    enter runs, anything else cancels — so a stray 'y' can never arm a keg
    switch. The buffer echoes on the prompt row while it is typed."""
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


def _click(stdscr, app, rows: int) -> None:
    """Map a mouse row to a list row using the window the last render chose."""
    import curses

    try:
        _, _x, y, _z, _m = curses.getmouse()
    except curses.error:
        return
    s = app.screen
    if not s.rows:
        return
    first, last = s.shown
    idx = first + (y - 1)                    # line 0 is the title
    if first <= idx < last:
        s.selected = min(idx, len(s.rows) - 1)


def _paint(stdscr, app, rows: int, cols: int) -> None:
    """Map the model's tone names to this theme's attributes and write the
    frame. stdscr.erase() + noutrefresh/doupdate means one clean swap per
    repaint — no per-cell diffing, which is what keeps a 5 Hz refresh cheap
    over ssh."""
    import curses

    attrs = app.attrs or {t: curses.A_NORMAL for t in model_tones()}
    attrs.setdefault(None, curses.A_NORMAL)
    stdscr.erase()
    lines = app.lines(cols, rows)
    for y, (text, tone) in enumerate(lines[:max(0, rows - 1)]):
        try:
            stdscr.addstr(y, 0, str(text)[:cols - 1],
                          attrs.get(tone, curses.A_NORMAL))
        except curses.error:
            pass                             # tiny terminal / last cell
    # bottom line: theme + terminal capability, so a degraded palette is
    # visible instead of silently mis-coloured
    info = app.theme_info or {}
    # name what the terminal actually delivered: an approximated palette is
    # worth telling the operator about, a theme that ASKS for the terminal's
    # own basic colours ('default') is not a degradation
    quality = {"exact RGB": "exact RGB",
               "xterm-256 approximation": "256-colour approx",
               "16 basic colours": "16 basic colours",
               "bold/reverse only": "no colour"}.get(info.get("note"),
                                                     info.get("note") or "?")
    status = f" theme {app.theme_name} [{quality}]  {cols}x{rows}"
    try:
        stdscr.addstr(max(0, rows - 1), 0, model._trunc(status, cols - 1),
                      attrs.get(model.TONE_DIM, curses.A_NORMAL))
    except curses.error:
        pass
    stdscr.noutrefresh()
    curses.doupdate()


def model_tones():
    from . import model as _m
    return (_m.TONE_OK, _m.TONE_BAD, _m.TONE_WARN, _m.TONE_DIM, _m.TONE_BOLD,
            _m.TONE_SEL, _m.TONE_TITLE, _m.TONE_PANE)
