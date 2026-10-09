"""TUI screen model (TUI-1) — pure text, no curses, no I/O.

build_*() read live state through the context and return a Screen: title,
rows, footer, and the op pool its keys come from. render() turns a Screen into
[(text, tone)] lines that the curses painter colors and the unit tests assert
on. This module stays curses-free on purpose: that is what makes the whole
display logic testable without a terminal.
"""
from __future__ import annotations

from . import ops as ops_mod

# tones the painter maps to attribute pairs via a palette (see themes.py);
# an unknown tone paints as normal. A tone names what a line MEANS, never a
# colour — that is what lets a theme be pure data.
TONE_OK, TONE_BAD, TONE_WARN, TONE_DIM, TONE_BOLD = (
    "ok", "bad", "warn", "dim", "bold")
TONE_SEL = "sel"          # the highlighted row (reverse video / colour bar)
TONE_TITLE = "title"      # the top bar
TONE_PANE = "pane"        # the detail text under the rows

# The tone vocabulary this module may emit. It is defined HERE because the
# model is what assigns meaning to a line; themes.py consumes the list and a
# palette must cover all of it (test_tui_themes pins that).
TONES = (TONE_TITLE, TONE_OK, TONE_BAD, TONE_WARN, TONE_DIM, TONE_BOLD,
         TONE_SEL, TONE_PANE)

SCREEN_KEYS = {"1": "overview", "2": "patches", "3": "catalog",
               "4": "dev", "5": "log"}
NAV_KEYS = [("1", "overview"), ("2", "patches"), ("3", "catalog"),
            ("4", "dev-keg"), ("5", "log")]
MAX_ROWS = 12


class Row:
    """One selectable line: `cols` paint, `detail` fills the info pane."""

    __slots__ = ("kind", "key", "cols", "detail", "raw")

    def __init__(self, kind, key, cols, detail="", raw=None):
        self.kind = kind
        self.key = key
        self.cols = cols
        self.detail = detail
        self.raw = raw if raw is not None else {}

    def text(self) -> str:
        return "  ".join(t for t, _ in self.cols)

    @property
    def selectable(self) -> bool:
        return self.kind not in ("header", "empty", "info")


class Screen:
    __slots__ = ("name", "title", "rows", "footer", "ops_pool", "selected",
                 "notice", "shown")

    def __init__(self, name, title, rows=None, footer=None, ops_pool=None,
                 notice=""):
        self.name = name
        self.title = title
        self.rows = rows or []
        self.footer = footer or []
        self.ops_pool = ops_pool if ops_pool is not None else []
        self.selected = 0
        self.notice = notice
        # (first, last) row index the last render() painted — the mouse
        # handler needs it to turn a screen line into a row index
        self.shown = (0, 0)

    def clamp(self) -> None:
        if not self.rows:
            self.selected = 0
            return
        self.selected = max(0, min(self.selected, len(self.rows) - 1))

    def first_selectable(self) -> int:
        """Index of the first row an action could apply to — 0 when the list
        is all headers or empty, so an unknown store still renders."""
        for i, row in enumerate(self.rows):
            if row.selectable:
                return i
        return 0

    def current(self) -> Row | None:
        if not self.rows:
            return None
        return self.rows[min(self.selected, len(self.rows) - 1)]

    def row_ops(self) -> list:
        row = self.current()
        return ops_mod.ops_for(row.kind, self.ops_pool) if row else []

    def screen_ops(self) -> list:
        return [o for o in self.ops_pool if o.row_kinds is ops_mod.ANY]

    def keymap(self) -> list:
        """Key bar: navigation, then what is available on the current row,
        then screen actions. Deduped by key so a row op wins over a screen op
        that shares its letter (the screen list is only shown when no row op
        claims the key)."""
        out, seen = [], set(k for k, _ in NAV_KEYS)
        for op in self.row_ops() + self.screen_ops():
            if op.key in seen:
                continue
            seen.add(op.key)
            out.append((op.key, op.label))
        return out


# ----------------------------------------------------------------- helpers --
def _trunc(text, width: int) -> str:
    text = str(text)
    return text if len(text) <= width else text[:max(1, width - 1)] + "~"


def _pad(text, width: int) -> str:
    return f"{str(text):<{width}}"


def _state_tone(state) -> str:
    return {"applied": TONE_OK, "pending": TONE_WARN,
            "needs_review": TONE_BAD, "disabled": TONE_DIM,
            "obsolete": TONE_DIM, "installed": TONE_OK}.get(state or "",
                                                            TONE_WARN)


def _source_label(src: dict) -> str:
    kind = (src or {}).get("kind")
    if kind == "github_pr":
        return f"PR {(src.get('repo') or '?')}/#{src.get('pr', '?')}"
    if kind == "url":
        return f"url {src.get('url', '?')}"
    if kind == "file":
        return f"file {src.get('path') or src.get('url') or '?'}"
    if kind == "upload":
        return "upload (local diff)"
    return kind or "(no source)"


def _patch_detail(p: dict) -> str:
    lines = []
    if p.get("description"):
        lines.append(str(p["description"]))
    lines.append(f"source:   {_source_label(p.get('source') or {})}")
    lines.append(f"state:    {p.get('state')}"
                 + (f" — {p['state_detail']}" if p.get("state_detail") else ""))
    lines.append(f"enabled:  {'yes' if p.get('enabled') else 'no'}"
                 f"   scope: {p.get('scope')}"
                 f"   desired: v{p.get('desired_version')}")
    if p.get("inactive_reason"):
        lines.append(f"inert:    {p['inactive_reason']}")
    if p.get("requires_approval"):
        lines.append("HELD: safeguard approval required — press 'a' to approve "
                     "once, or: omlx-uplift patch approve "
                     f"{p.get('id')} --approve always")
    if p.get("kernel_rebuild_hint"):
        lines.append(f"kernel:   {p['kernel_rebuild_hint']}")
    versions = p.get("versions") or []
    if versions:
        lines.append(f"versions: {len(versions)} stored — " + ", ".join(
            f"v{v.get('v')}"
            f"{'*' if v.get('v') == p.get('desired_version') else ''}"
            f" ({(v.get('fetched_at') or '?')[:10]})"
            for v in versions[-6:]))
    if p.get("keg_changed"):
        lines.append("KEG CHANGED — applied on a different keg; the next "
                     "reconcile re-validates against this one")
    lv = p.get("last_verified")
    if lv:
        lines.append(f"last test: {lv.get('at', '?')} "
                     f"{'OK' if lv.get('ok') else 'FAILED'}")
    tags = []
    if p.get("curated"):
        tags.append(f"bundled ({p['curated']})")
    if p.get("curated_adopted"):
        tags.append("adopted")
    if p.get("reversal"):
        tags.append("reversal")
    if tags:
        lines.append("tags:     " + ", ".join(tags))
    return "\n".join(lines)


def _patch_row(p: dict, kind: str) -> Row:
    marks = "".join(m for m, on in (
        ("!", p.get("requires_approval")),
        ("B", p.get("curated")),
        ("R", p.get("reversal")),
        ("K", p.get("keg_changed"))) if on)
    desired = p.get("desired_version")
    cols = [
        (_pad(marks or ".", 3), TONE_WARN if "!" in marks else TONE_DIM),
        (_pad("on" if p.get("enabled") else "off", 4),
         TONE_OK if p.get("enabled") else TONE_DIM),
        (_pad(str(p.get("state") or "?"), 12), _state_tone(p.get("state"))),
        (_pad(str(p.get("scope") or "?"), 5), TONE_DIM),
        (_pad(f"v{desired}" if desired is not None else "-", 4), TONE_DIM),
        (_trunc(p.get("id") or "?", 30), None),
        (_trunc((p.get("description") or "")[:40], 40), TONE_DIM),
    ]
    return Row(kind, p.get("id") or "?", cols, _patch_detail(p), raw=p)


# ---------------------------------------------------------------- screens --
def build_overview(ctx) -> Screen:
    view = ctx.patches_view()
    all_patches = view.get("patches") or []
    enabled = [p for p in all_patches if p.get("enabled")]
    held = [p for p in all_patches if p.get("requires_approval")]
    broken = [p for p in all_patches if p.get("state") == "needs_review"]
    kill = view.get("kill_switch_active")
    rows = [Row("info", "patches", [
        (_pad("patches", 9), TONE_BOLD),
        (_pad(f"{len(all_patches)} total", 11), None),
        (_pad(f"{len(enabled)} enabled", 12),
         TONE_OK if enabled else TONE_DIM),
        (_pad(f"{len(held)} held", 9), TONE_WARN if held else TONE_DIM),
        (_pad(f"{len(broken)} to review", 13),
         TONE_BAD if broken else TONE_DIM),
        (_pad("kill switch: " + ("ARMED" if kill else "off"), 17),
         TONE_BAD if kill else TONE_DIM),
        (_pad(view.get("load_error") or "", 20), TONE_BAD),
    ], f"store:  {ctx.store.manifest_path}\n"
       f"tree:   {ctx.tree_root or '(omlx package tree not found)'}\n"
       f"keg id: {view.get('keg_id') or '?'}"
       + (f"\nload error: {view['load_error']}" if view.get("load_error") else "")
       + ("\nKILL SWITCH ARMED — omlx boots unpatched. Patches screen: 'U' "
          "restores the flags the switch recorded." if kill else ""))]

    for s in ctx.services():
        state = s.get("state") or "unknown"
        rows.append(Row(ops_mod.SERVER, s.get("formula"), [
            (_pad(s.get("label", ""), 9), TONE_BOLD),
            (_pad(state, 11),
             TONE_OK if state in ("started", "running") else TONE_DIM),
            (_pad(f"port {s.get('port', '?')}", 11), TONE_DIM),
            (_pad(f"{s.get('patched', '?')} applied", 12), TONE_DIM),
            (_trunc(s.get("keg") or "", 44), TONE_DIM),
        ], f"service '{s.get('formula')}': {state}\n"
           f"port: {s.get('port')}\n"
           f"keg: {s.get('keg') or '?'}\n"
           f"enabled patches applied in this tree: {s.get('patched')}\n"
           f"restart: brew services restart {s.get('formula')}\n"
           "(restart is a HIGH action — it takes the inference server down "
           "for a few seconds)"))

    dev = ctx.dev_summary()
    if dev.get("installed"):
        rows.append(Row("info", "dev", [
            (_pad("omlx-dev", 9), TONE_BOLD),
            (_pad(str(dev.get("branch") or "?"), 12), None),
            (_pad(f"tip {str(dev.get('tip') or '?')[:9]}", 15), None),
            (_pad(f"+{dev.get('ahead', 0)}/-{dev.get('behind', 0)} "
                  f"{dev.get('sync_ref')}", 26),
             TONE_WARN if dev.get("behind") else TONE_DIM),
            (_pad(f"{len(dev.get('patch_commits') or [])} commits", 11),
             TONE_DIM),
            (_trunc(dev.get("drift_note") or "", 20),
             TONE_BAD if dev.get("drift") else TONE_DIM),
        ], "\n".join(dev.get("detail") or [])))
    else:
        rows.append(Row("info", "dev", [
            (_pad("omlx-dev", 9), TONE_BOLD),
            (_trunc(dev.get("reason") or "not bootstrapped", 66), TONE_DIM),
        ], "run: omlx-uplift dev bootstrap"))

    footer = []
    if view.get("load_error"):
        footer.append((str(view["load_error"]), TONE_BAD))
    for p in broken:
        footer.append((f"needs review: {p.get('id')} — "
                       f"{p.get('state_detail') or 'apply failed'}", TONE_BAD))
    for p in held:
        footer.append((f"held: {p.get('id')} — approval required", TONE_WARN))
    if ctx.pth_missing():
        footer.append(("uplift .pth NOT mounted in the dev keg — run: "
                       "omlx-uplift install --formula omlx-dev", TONE_BAD))
    return Screen("overview", f"omlx-uplift  |  {ctx.store.base_dir}", rows,
                  footer, ops_mod.SERVER_ROW_OPS)


def build_patches(ctx) -> Screen:
    view = ctx.patches_view()
    rows = [_patch_row(p, ops_mod.PATCH) for p in view.get("patches") or []]
    err = view.get("load_error")
    if err:
        # a missing tree or an unreadable manifest explains an empty list far
        # better than 'no patches stored' does, and the difference matters:
        # one is fixed by installing omlx, the other by adding a patch
        rows.insert(0, Row("empty", "", [(_trunc(str(err), 96), TONE_BAD)],
                           "nothing here can run until that is resolved — the "
                           "store file on disk is untouched"))
    if not rows:
        rows = [Row("empty", "", [(_trunc(
            "no patches stored — press 3 for the curated catalog", 70),
            TONE_DIM)], "")]
    kill = view.get("kill_switch_active")
    cfg = view.get("config") or {}
    footer = []
    if kill:
        footer.append(("KILL SWITCH ARMED — omlx boots unpatched. 'U' restores "
                       "the flags the switch recorded", TONE_BAD))
    footer.append((f"store {ctx.store.manifest_path}  |  tree "
                   f"{ctx.tree_root or '(not found)'}  |  keg "
                   f"{str(view.get('keg_id') or '?')[:12]}  |  auto-check "
                   f"{'on' if cfg.get('auto_update_check') else 'off'}",
                   TONE_DIM))
    footer.append(("marks: ! held  B bundled  R reversal  K keg changed",
                   TONE_DIM))
    return Screen("patches", "patches", rows, footer,
                  ops_mod.PATCH_ROW_OPS + ops_mod.PATCH_SCREEN_OPS)


def build_catalog(ctx) -> Screen:
    res = ctx.catalog()
    rows = []
    for err_tier, reason in (res.get("errors") or {}).items():
        rows.append(Row("empty", "", [(
            f"{err_tier} tier unavailable: {_trunc(reason, 60)}", TONE_WARN)],
            "offline is fine — the local store stays authoritative"))
    if not res.get("ok", True) and not (res.get("tiers") or {}):
        rows.append(Row("empty", "", [(
            f"catalog unavailable: {res.get('reason', 'no reason given')}",
            TONE_BAD)], "the store on disk is untouched"))
    for tier, entries in (res.get("tiers") or {}).items():
        rows.append(Row("header", tier, [
            (f"{tier} ({len(entries)})", TONE_BOLD),
            (_trunc("installs ENABLED by default" if tier == "default"
                    else "installs disabled — enable by hand", 46), TONE_DIM),
        ], ""))
        for e in entries:
            row = _patch_row({**e,
                              "enabled": e.get("installed"),
                              "state": "installed" if e.get("installed")
                              else "not installed"}, ops_mod.CATALOG)
            row.raw = {**e, "entry": e}
            if e.get("installed"):
                row.cols[5] = (_trunc(f"{e.get('under_id') or e['id']}", 30),
                               TONE_OK)
            detail = _patch_detail(e)
            if e.get("source_ok") is False:
                detail += "\nINCOMPLETE manifest — this entry cannot install"
            if e.get("installed"):
                detail += (f"\nalready in the store as "
                           f"'{e.get('under_id') or e['id']}'"
                           + (" (adopted — catalog updates stop here)"
                              if e.get("adopted") else ""))
            else:
                detail += "\npress i to fetch, gate and store it"
            row.detail = detail
            rows.append(row)
    footer = [("i installs the selected entry  c syncs the whole catalog  "
               "o adopts an installed catalog patch as local", TONE_DIM),
              ("the catalog is served from GitHub — 'c' needs network",
               TONE_DIM)]
    return Screen("catalog", "curated catalog", rows, footer,
                  ops_mod.CATALOG_ROW_OPS + ops_mod.CATALOG_SCREEN_OPS)


def build_dev(ctx) -> Screen:
    dev = ctx.dev_summary()
    rows = []
    if not dev.get("installed"):
        rows.append(Row("empty", "", [(
            _trunc(dev.get("reason") or "dev not bootstrapped", 70),
            TONE_WARN)], "run: omlx-uplift dev bootstrap"))
    else:
        rows.append(Row("info", "dev-src", [
            (_pad("dev-src", 9), TONE_BOLD),
            (_pad(str(dev.get("branch") or "?"), 12), None),
            (_pad(f"tip {str(dev.get('tip') or '?')[:9]}", 15), None),
            (_pad(f"base {str(dev.get('base') or '?')[:9]}", 16), TONE_DIM),
            (_pad(f"pin {str(dev.get('base_pin') or 'HEAD')[:9]}", 13),
             TONE_WARN if dev.get("base_pin") else TONE_DIM),
            (_trunc(dev.get("auto_note") or "", 28),
             TONE_DIM if dev.get("auto_update") else TONE_WARN),
        ], "\n".join(dev.get("detail") or [])))
        for note in (dev.get("drift") or []):
            rows.append(Row("empty", "", [
                (_pad("DRIFT", 9), TONE_BAD),
                (_trunc(note, 78), None)], ""))
        if dev.get("reason"):
            rows.append(Row("empty", "", [
                (_pad("?", 9), TONE_WARN),
                (_trunc(dev["reason"], 78), None)], ""))

    stashes = ctx.stashes()
    active = ctx.active_keg()
    for m in stashes:
        name = m.get("name") or "?"
        is_active = (m.get("cellar_name") or name) == active
        rows.append(Row(ops_mod.KEG, name, [
            (_pad(">" if is_active else ".", 3),
             TONE_OK if is_active else TONE_DIM),
            (_pad(str(m.get("stashed_at") or "?")[:19], 21), None),
            (_pad(f"{(m.get('bytes') or 0) / 2 ** 30:.1f} GiB", 9), TONE_DIM),
            (_pad(str(m.get("method") or "?"), 9), TONE_DIM),
            (_trunc(name, 44), TONE_OK if is_active else None),
        ], f"keg stash: {name}\n"
           f"path:   {m.get('path')}\n"
           f"cellar: {m.get('cellar_name') or '?'}\n"
           + ("ACTIVE — 's' on another keg switches back; restart the service "
              "afterwards" if is_active else
              "activate: 's' here   (CLI: omlx-uplift dev use " + name + ")")
           + ("\nNOTE: several stashed builds share this Cellar address "
              "(DEV-13) — prune keeps the newest"
              if m.get("shared_cellar") else "")))
    if dev.get("installed") and not stashes:
        rows.append(Row("empty", "", [(_trunc(
            "no stashed kegs — 'dev install' stashes automatically", 60),
            TONE_DIM)], ""))

    footer = []
    if ctx.pth_missing():
        footer.append(("uplift .pth NOT mounted in the active dev keg — run: "
                       "omlx-uplift install --formula omlx-dev", TONE_BAD))
    footer.append(("switching or rolling back a keg turns auto-build OFF "
                   "(DEV-11) and rewrites brew's link record — restart the "
                   "service to load the new keg", TONE_DIM))
    return Screen("dev", "omlx-dev keg", rows, footer,
                  ops_mod.KEG_ROW_OPS + ops_mod.KEG_SCREEN_OPS)


def build_log(ctx) -> Screen:
    lines = ctx.log_lines()[-200:]
    rows = [Row("empty", "", [(_trunc(line, 110), TONE_DIM)], "")
            for line in reversed(lines)]
    if not rows:
        rows = [Row("empty", "", [("nothing has run in this session",
                                   TONE_DIM)], "")]
    return Screen("log", "session log", rows,
                  [("in-memory only — every action also logged the CLI command "
                    "it mirrors", TONE_DIM)], [])


BUILDERS = {"overview": build_overview, "patches": build_patches,
            "catalog": build_catalog, "dev": build_dev, "log": build_log}


# ---------------------------------------------------------------- renderer --
KEYBAR_LINES = 4        # nav line + up to 2 action lines + help/quit line


def render(screen: Screen, width: int, detail=None, prompt: str = "",
           busy: str = "", height: int = 0, yes_line: str | None = None,
           theme: dict | None = None) -> list:
    """Screen -> [(text, tone)].

    Two guarantees the painter relies on:
      * every line is truncated to `width`, so a narrow terminal can never
        auto-wrap and corrupt the frame;
      * the frame never exceeds `height` lines.
    Space is claimed from the bottom up: the title and the key bar (or the
    live confirmation question, which may use more lines because the operator
    has to be able to read what they are agreeing to) are mandatory; the
    footer keeps as many of its FIRST lines as the window allows, because the
    builders put the urgent warning first; the row window takes what the
    footer left and reports the rows it hid; the detail pane gets the
    remainder and truncates with a marker rather than vanishing.
    `detail=None` means 'show the selected row's detail'; '' hides it.
    """
    width = max(40, int(width))
    height = max(0, int(height or 0))
    pal = theme or {}
    prefix = (pal.get("title_prefix") + " :: ") if pal.get("title_prefix") \
        else ""
    title = f" {prefix}{screen.title} " + (f"[{screen.notice}] "
                                           if screen.notice else "")
    head = [(_pad(title[:width - 1], width), TONE_TITLE)]
    foot = [(_trunc(t, width), tone) for t, tone in screen.footer]
    # The bottom block is sized first because everything else is measured
    # against it. A live question may use more lines than the key bar: reading
    # what you are about to approve outranks listing the other keys.
    cap = KEYBAR_LINES if not prompt else 6
    kb0 = cap if not height else max(1, min(cap, height - 2))
    tail = _tail(screen, prompt, busy, yes_line, width, kb0)
    body = detail if detail is not None else (
        screen.current().detail if screen.current() else "")
    pane = [(_trunc(line, width), TONE_PANE)
            for line in str(body).splitlines()] if body else []

    if not height:                    # no window size given: no clipping
        rows_out = _rows_block(screen, width, MAX_ROWS)
        pane_out = (([(_trunc("-" * 100, width), TONE_PANE)] + pane)
                    if pane else [])
        return head + rows_out + foot + pane_out + tail

    avail = height - len(head) - len(tail)
    if avail < 1:
        out = (head + tail)[:height]
        if len(out) == height:
            out[-1] = (_trunc("    ... window too short for this question — "
                              "widen it", width), TONE_WARN)
        return out

    # footer: keep the FIRST lines — the builders put the urgent warning
    # first, so it is the tail of the footer that gets dropped
    keep_foot = 0
    for i, (_text, _tone) in enumerate(foot, start=1):
        if avail - i < 1:                    # a row must stay visible
            break
        keep_foot = i
    foot = foot[:keep_foot]
    room = avail - keep_foot                 # lines left for rows + pane

    rows_out = _rows_block(screen, width, min(MAX_ROWS, room))
    if not rows_out and screen.rows:
        rows_out = [(_trunc(f"    ({len(screen.rows)} row(s) hidden — widen "
                            f"the window)", width), TONE_DIM)]
    spare = room - len(rows_out)

    pane_out = []
    if pane and spare >= 2:
        shown = spare - 1                    # -1 for the separator line
        pane_out = [(_trunc("-" * 100, width), TONE_PANE)]
        if shown >= len(pane):
            pane_out += pane
        elif shown >= 2:
            pane_out += pane[:shown - 1]
            pane_out.append((_trunc(f"    ... {len(pane) - (shown - 1)} more "
                                    f"detail line(s) — 'enter' closes the "
                                    f"pane", width), TONE_PANE))
        else:
            pane_out.append((_trunc(f"    ({len(pane)} detail line(s) hidden "
                                    f"— widen the window)", width),
                            TONE_PANE))

    out = head + rows_out + foot + pane_out + tail
    if len(out) > height:                    # arithmetic guard
        out = out[:height]
    return out


def _rows_block(screen: Screen, width: int, limit: int) -> list:
    """At most `limit` painted lines, the '... more rows' marker included —
    that is what makes the frame budget in render() exact."""
    n = len(screen.rows)
    if limit <= 0 or n == 0:
        screen.shown = (0, 0)
        return []
    inline_hidden = 0
    if n <= limit:
        first, last, marker = 0, n, False
    elif limit == 1:
        # a second line would overflow the budget, so the hidden count rides
        # on the row line itself — never silently drop rows
        first, last = _window(n, screen.selected, 1)
        marker = False
        inline_hidden = n - last
    else:
        cap = max(1, limit - 1)            # the marker costs a line
        first, last = _window(n, screen.selected, cap)
        marker = True
    screen.shown = (first, last)
    out = []
    for i in range(first, last):
        row = screen.rows[i]
        sel = (i == screen.selected)
        tone = (TONE_SEL if sel and row.selectable else
                TONE_BOLD if sel else
                TONE_DIM if row.kind in ("header", "empty", "info") else None)
        text = _row_text(row, width - 1, selected=sel)
        if inline_hidden and i == last - 1:
            note = f"   …+{inline_hidden} row(s)"
            text = _trunc(text, max(4, width - 1 - len(note))) + note
        out.append((_trunc(text, width - 1), tone))
    if marker:
        out.append((_trunc(f"    ... {n - last} more row(s)", width),
                    TONE_DIM))
    return out


def _tail(screen: Screen, prompt: str, busy: str, yes_line,
          width: int, budget: int = 4) -> list:
    """Bottom of the frame: the busy line, then either the confirmation
    question or the key bar. Returns AT MOST `budget` lines (always at least
    one) — the fit loop in render() shrinks the budget step by step and would
    spin forever if this block could refuse to get smaller. Anything that does
    not fit is folded into a marker on the last kept line instead of adding
    one."""
    budget = max(1, int(budget))
    lines = []
    if busy:
        lines.append((_trunc(f"running: {busy} ... "
                             "(Ctrl-C cancels a command)", width), TONE_WARN))
    if prompt:
        wrapped = _wrap(prompt, width)
        echo = yes_line is not None
        room = max(0, budget - len(lines) - (1 if echo else 0))
        body = wrapped[:room]
        if len(body) < len(wrapped):
            note = f"  …(+{len(wrapped) - len(body)} more line(s), widen " \
                   f"the window)"
            if body:
                body[-1] = body[-1].rstrip() + note
            else:
                body = [_trunc(wrapped[0][:max(0, width - len(note))] + note,
                        width)]
        lines.extend((_trunc(l, width), TONE_BAD) for l in body)
        if echo:
            if len(lines) < budget:
                lines.append((_trunc(f"  > {yes_line}_   (type YES then "
                                     f"enter)", width), TONE_BAD))
            elif lines:               # no room: fold the caret into the last
                t, tn = lines[-1]
                lines[-1] = (_trunc(f"{t.rstrip()}  >{yes_line}_", width), tn)
        return lines[:budget] or [(_trunc("(window too short for the "
                                          "question)", width), TONE_BAD)]
    room = max(1, budget - len(lines))
    lines.extend((_trunc(l, width), TONE_DIM)
                 for l in _keybar(screen, width, maxlines=room))
    return lines[:budget]


def _pack(items: list, width: int, nlines: int) -> list:
    """Pack short strings into at most `nlines` lines of `width`, each item on
    a line if it fits. Items that had to be dropped become one marker on the
    last line — a hidden key is a wart, a frame that wraps is a crash."""
    nlines = max(1, int(nlines))
    out, cur, hidden = [], "", 0
    for item in (_trunc(x, width) for x in items):
        cand = f"{cur}  {item}" if cur else item
        if len(cand) <= width:
            cur = cand
            continue
        if len(out) < nlines - 1:
            if cur:
                out.append(cur)
            cur = item
        else:
            hidden += 1
    if cur and len(out) < nlines:
        out.append(cur)
    if hidden:
        note = f"  …+{hidden} key(s) hidden — widen the window"
        if out:
            last = out[-1]
            if len(last) + len(note) > width:
                last = _trunc(last, max(4, width - len(note)))
            out[-1] = last.rstrip() + note
        else:
            out = [_trunc(note, width)]
    return out[:nlines]


def _keybar(screen: Screen, width: int, maxlines: int = 3) -> list:
    """Navigation line + the actions available on the current row/screen,
    wrapped into at most `maxlines` lines TOTAL (nav line included)."""
    maxlines = max(1, int(maxlines))
    nav = "[" + "] [".join(f"{k} {v}" for k, v in NAV_KEYS) + "]"
    if maxlines == 1:
        return [_trunc(nav + "  [T] theme  [?] help  [q] quit", width)]
    chunks = [f"[{k}] {v}" for k, v in screen.keymap()]
    out = _pack(chunks, width, maxlines - 1)
    # quit/theme/help are the escape hatch: they must never be the items a
    # narrow window drops, so they go on their own line (or inline if the
    # packed lines left room on the last one)
    escape = "[T] theme  [?] help  [q] quit"
    if out and len(out[-1]) + len(escape) + 2 <= width:
        out[-1] = f"{out[-1]}  {escape}"
    else:
        out = (out + [escape])[-(maxlines - 1):]
    return [_trunc(nav, width)] + out


def _row_text(row: Row, width: int, selected: bool = False) -> str:
    return _trunc(f"{'> ' if selected else '  '}"
                  f"{'  '.join(t for t, _ in row.cols)}", width)


def _window(n: int, sel: int, limit: int = MAX_ROWS) -> tuple:
    """Visible row window around the selection."""
    if n <= limit:
        return 0, n
    first = max(0, min(sel - limit // 2, n - limit))
    return first, first + limit


def _wrap(text: str, width: int) -> list:
    out = []
    for para in str(text).splitlines() or [""]:
        while len(para) > width:
            cut = para.rfind(" ", 0, width)
            cut = cut if cut > 20 else width
            out.append(para[:cut])
            para = para[cut:].lstrip()
        out.append(para)
    return out


# ----------------------------------------------------------------- confirm --
def confirm_prompt(op: ops_mod.Op, raw=None, ctx_note: str = "",
                   what: str = "this screen") -> str:
    """The question the operator answers. HIGH-danger ops need a typed YES,
    WRITE ops a 'y' — and the text always shows the CLI command it mirrors.
    `raw` is the selected row's payload dict, `what` names the target."""
    cli = op.cli_line(raw)
    return (f"{op.label.upper()}  {what}"
            + (f"   [{ctx_note}]" if ctx_note else "")
            + (f"\n         mirrors: {cli}" if cli else "")
            + (f"\n         {op.hint}" if op.hint else "")
            + ("\n         this is a HIGH action: type YES to run it, "
               "anything else cancels" if op.danger == ops_mod.HIGH
               else "\n         press y to run, any other key cancels"))


def result_lines(res) -> list:
    """A short, honest summary of an op result for the log and the notice."""
    if res is None:
        return ["cancelled — nothing changed"]
    if not isinstance(res, dict):
        return [str(res)]
    bits = []
    for key in ("reason", "state", "desired_version", "keg", "name", "removed",
                "restored", "sentinel", "promoted", "verdict", "rc", "ok"):
        val = res.get(key)
        if val in (None, "", [], {}, True, False):
            continue
        if isinstance(val, list):
            val = ", ".join(str(x) for x in val[:8]) or "nothing"
        bits.append(f"{key}={val}")
    if not bits:
        extra = {k: v for k, v in res.items()
                 if k in ("files", "report", "patches", "output", "summary")
                 and v}
        bits = [f"{k}={_brief(v)}" for k, v in extra.items()]
    return [("OK    " if res.get("ok", True) else "FAILED ")
            + ("  ".join(bits) or "done")]


def _brief(val) -> str:
    if isinstance(val, list):
        return f"{len(val)} item(s)"
    if isinstance(val, dict):
        if "ok" in val:
            return ("ok" if val.get("ok") else "failed") + " " + str(
                val.get("reason") or val.get("state") or "").strip()
        return f"{len(val)} key(s)"
    return _trunc(val, 80)
