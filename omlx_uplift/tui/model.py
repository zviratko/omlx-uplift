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

# The screens in menu order. The number keys still jump straight to a
# screen (TUI-1 muscle memory, and scripts/tests), but the primary way to
# move is the main menu: a visible list you arrow through (TUI-2, user
# request: "instead of numbers I wanted menus").
SCREEN_ORDER = ("menu", "overview", "patches", "catalog", "dev", "log")
SCREEN_KEYS = {"1": "overview", "2": "patches", "3": "catalog",
               "4": "dev", "5": "log"}
MENU_LABELS = {"overview": "Overview", "patches": "Patches",
               "catalog": "Curated catalog", "dev": "omlx-dev keg",
               "log": "Session log"}
# row budget for the renderer, in LINES (rows are one or two lines each)
MAX_ROWS = 14


class Row:
    """One selectable entry. `cols` is the main line (name, one-line
    description); `cols2` is an optional status line painted indented below
    it in plain words — TUI-2 replaced the terse column grid and its mark
    legend with these, because an operator reading a recovery tool at 2 a.m.
    should not have to decode '! B R K' first. `detail` still fills the info
    pane under both."""

    __slots__ = ("kind", "key", "cols", "detail", "raw", "cols2")

    def __init__(self, kind, key, cols, detail="", raw=None, cols2=None):
        self.kind = kind
        self.key = key
        self.cols = cols
        self.cols2 = cols2 or []
        self.detail = detail
        self.raw = raw if raw is not None else {}

    def text(self) -> str:
        return "  ".join(t for t, _ in self.cols)

    def text2(self) -> str:
        return " ".join(t for t, _ in self.cols2).strip()

    def line_count(self) -> int:
        return 2 if self.cols2 else 1

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
        # 'm' and the space key belong to the loop itself (menu, detail
        # toggle) — an op label must never shadow them in the bar
        out, seen = [], set(ops_mod.RESERVED_KEYS)
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
    detail_reason = str(p.get("state_detail") or "").strip()
    if detail_reason.lower() == str(p.get("state") or "").lower():
        detail_reason = ""            # 'disabled — disabled' reads like a bug
    lines.append(f"state:    {p.get('state')}"
                 + (f" — {detail_reason}" if detail_reason else ""))
    dv = p.get("desired_version")
    lines.append(f"enabled:  {'yes' if p.get('enabled') else 'no'}"
                 f"   scope: {p.get('scope') or '?'}"
                 f"   desired: {('v' + str(dv)) if dv is not None else '-'}")
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


def _state_words(p: dict) -> list:
    """Plain-language status fragments for a patch/catalog row's second line.
    Words, not marks: 'needs review' beats '!' and needs no legend (TUI-2,
    user: 'more descriptive, less terse')."""
    out = []
    state = str(p.get("state") or "?")
    if state == "installed":
        out.append(("in your store", TONE_OK))
    elif state == "not installed":
        out.append(("not installed yet", TONE_DIM))
    else:
        out.append((state, _state_tone(state)))
        # 'disabled | disabled' reads like a bug: when the state already IS
        # the flag, say it once
        if state != "disabled":
            out.append(("enabled" if p.get("enabled") else "disabled",
                        TONE_OK if p.get("enabled") else TONE_DIM))
    if p.get("scope"):
        out.append((f"scope {p['scope']}", TONE_DIM))
    desired = p.get("desired_version")
    out.append((f"desired v{desired}" if desired is not None
                else "no version stored", TONE_DIM))
    if p.get("curated"):
        out.append((f"bundled ({p['curated']})", TONE_DIM))
    if p.get("curated_adopted"):
        out.append(("adopted as local", TONE_DIM))
    if p.get("reversal"):
        out.append(("reversal patch", TONE_DIM))
    if p.get("keg_changed"):
        out.append(("KEG CHANGED — re-validates on next reconcile", TONE_WARN))
    if p.get("requires_approval"):
        out.append(("HELD — approval needed to enable", TONE_BAD))
    if p.get("state_detail") and state in ("needs_review", "failed"):
        out.append((str(p["state_detail"]), TONE_BAD))
    return out


def _flow(frag: list, indent: str = "      ") -> list:
    """(text, tone) fragments -> one [(text, tone)] line, joined with '  |  '
    so each fragment keeps its own tone for the painter. One line, always:
    rows claim a fixed number of screen lines and the fit arithmetic depends
    on it, so overflow fragments fold into the detail pane instead — the row
    says how many were folded. ASCII separator on purpose: this operator's
    terminal has eaten fancy glyphs before."""
    parts = []
    for text, tone in frag:
        if not text:
            continue                     # an optional fragment that is off
        if parts:
            parts.append(("  |  ", TONE_DIM))
        parts.append((text, tone))
    return [(indent, TONE_DIM)] + parts if parts else [(indent.strip(), TONE_DIM)]


def _patch_row(p: dict, kind: str) -> Row:
    """One patch as two lines: name + description, then the state in words."""
    pid = _trunc(p.get("id") or "?", 34)
    desc = _trunc((p.get("description") or "").strip(), 52)
    cols = [(pid, TONE_BOLD if desc else None)]
    if desc:
        cols.append(("  " + desc, TONE_DIM))
    return Row(kind, p.get("id") or "?", cols, _patch_detail(p), raw=p,
               cols2=_flow(_state_words(p)))


# ---------------------------------------------------------------- screens --
def build_overview(ctx) -> Screen:
    view = ctx.patches_view()
    all_patches = view.get("patches") or []
    enabled = [p for p in all_patches if p.get("enabled")]
    held = [p for p in all_patches if p.get("requires_approval")]
    broken = [p for p in all_patches if p.get("state") == "needs_review"]
    kill = view.get("kill_switch_active")
    rows = [Row("info", "patches", [
        ("The patch store", TONE_BOLD),
        (f"   {len(all_patches)} stored  |  {len(enabled)} enabled"
         f"  |  {len(held)} held  |  {len(broken)} to review"
         f"  |  kill switch {'ARMED' if kill else 'off'}",
         TONE_BAD if (kill or broken) else TONE_DIM),
    ], f"store:  {ctx.store.manifest_path}\n"
       f"tree:   {ctx.tree_root or '(omlx package tree not found)'}\n"
       f"keg id: {view.get('keg_id') or '?'}"
       + (f"\nload error: {view['load_error']}" if view.get("load_error") else "")
       + ("\nKILL SWITCH ARMED — omlx boots unpatched. Patches screen: 'U' "
          "restores the flags the switch recorded." if kill else ""))]

    for s in ctx.services():
        state = s.get("state") or "unknown"
        up = state in ("started", "running")
        rows.append(Row(ops_mod.SERVER, s.get("formula"), [
            (f"Service {s.get('label') or s.get('formula')}", TONE_BOLD),
            (f"   {state} on port {s.get('port', '?')}"
             f"  |  {s.get('patched', '?')} enabled patches applied",
             TONE_OK if up else TONE_DIM),
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
            ("The omlx-dev carrier", TONE_BOLD),
            (f"   branch {dev.get('branch') or '?'} at "
             f"{str(dev.get('tip') or '?')[:9]}"
             f"  |  +{dev.get('ahead', 0)}/-{dev.get('behind', 0)} "
             f"{dev.get('sync_ref')}"
             f"  |  {len(dev.get('patch_commits') or [])} patch commits",
             TONE_WARN if dev.get("behind") else TONE_DIM),
        ], "\n".join(dev.get("detail") or [])))
    else:
        rows.append(Row("info", "dev", [
            ("The omlx-dev carrier", TONE_BOLD),
            (_trunc("not set up — " + (dev.get("reason")
                                       or "run 'omlx-uplift dev bootstrap'"),
                    60), TONE_DIM),
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
    return Screen("overview",
                  f"Overview  -  {ctx.store.base_dir}", rows, footer,
                  ops_mod.SERVER_ROW_OPS)


def build_patches(ctx) -> Screen:
    view = ctx.patches_view()
    all_patches = view.get("patches") or []
    enabled = [p for p in all_patches if p.get("enabled")]
    held = [p for p in all_patches if p.get("requires_approval")]
    broken = [p for p in all_patches if p.get("state") == "needs_review"]
    rows = [_patch_row(p, ops_mod.PATCH) for p in all_patches]
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
            "no patches stored - open the Curated catalog (m -> catalog) "
            "and press Enter on an entry to install it", 90),
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
    title = (f"Patches  -  {len(all_patches)} stored"
             f"  |  {len(enabled)} enabled")
    if kill:
        title += "  |  KILL SWITCH ARMED"
    if held:
        title += f"  |  {len(held)} held"
    if broken:
        title += f"  |  {len(broken)} to review"
    return Screen("patches", title, rows, footer,
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
            (f"{tier.capitalize()} tier ({len(entries)})", TONE_BOLD),
            (("  installed by default when you add it" if tier == "default"
              else "  installed switched off — enable it by hand"), TONE_DIM),
        ], ""))
        for e in entries:
            row = _patch_row({**e,
                              "id": e.get("under_id") or e.get("id"),
                              "enabled": e.get("installed"),
                              "state": "installed" if e.get("installed")
                              else "not installed"}, ops_mod.CATALOG)
            row.raw = {**e, "entry": e}
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
    footer = [("the catalog is published in the omlx-uplift repo on GitHub; "
               "'sync' and 'install' need network. A failed fetch never "
               "touches your store.", TONE_DIM)]
    return Screen("catalog", "Curated catalog", rows, footer,
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
            ("Source carrier  dev-src", TONE_BOLD),
        ], "\n".join(dev.get("detail") or []),
            cols2=_flow([
                (f"branch {dev.get('branch') or '?'}", None),
                (f"tip {str(dev.get('tip') or '?')[:9]}", None),
                (f"base {str(dev.get('base') or '?')[:9]}", TONE_DIM),
                (f"pinned at {str(dev.get('base_pin') or 'HEAD')[:9]}"
                 if dev.get("base_pin") else "follows HEAD (not pinned)",
                 TONE_WARN if dev.get("base_pin") else TONE_DIM),
                (dev.get("auto_note") or
                 ("auto-build on" if dev.get("auto_update")
                  else "auto-build off — builds happen on demand"),
                 TONE_DIM if dev.get("auto_update") else TONE_WARN),
            ])))
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
            (("Active keg  " if is_active else "Keg stash   ")
             + _trunc(name, 40), TONE_OK if is_active else TONE_BOLD),
        ], f"keg stash: {name}\n"
           f"path:   {m.get('path')}\n"
           f"cellar: {m.get('cellar_name') or '?'}\n"
           + ("ACTIVE — 's' on another keg switches back; restart the service "
              "afterwards" if is_active else
              "activate: 's' here   (CLI: omlx-uplift dev use " + name + ")")
           + ("\nNOTE: several stashed builds share this Cellar address "
              "(DEV-13) — prune keeps the newest"
              if m.get("shared_cellar") else ""),
            cols2=_flow([
                ("stashed " + str(m.get("stashed_at") or "?")[:19], TONE_DIM),
                (f"{(m.get('bytes') or 0) / 2 ** 30:.1f} GiB", TONE_DIM),
                (f"by {m.get('method') or '?'}", TONE_DIM),
                ("ACTIVE — the keg the service runs from right now", TONE_OK)
                if is_active else
                ("press Enter for actions", TONE_DIM),
                ("shares a Cellar address (DEV-13)", TONE_WARN)
                if m.get("shared_cellar") else ("", TONE_DIM),
            ])))
    if dev.get("installed") and not stashes:
        rows.append(Row("empty", "", [(_trunc(
            "no stashed kegs — 'dev install' stashes automatically", 60),
            TONE_DIM)], ""))

    footer = []
    if ctx.pth_missing():
        footer.append(("uplift .pth NOT mounted in the active dev keg — run: "
                       "omlx-uplift install --formula omlx-dev", TONE_BAD))
    footer.append(("brew keeps one keg address per formula: activating a "
                   "stash swaps the physical keg and turns auto-build off "
                   "(DEV-11), so what runs next is exactly this build. "
                   "Restart the service afterwards to load it.", TONE_DIM))
    n_stash = len(stashes)
    return Screen("dev",
                  f"omlx-dev keg  -  {n_stash} stash(es)"
                  + (f"  |  active: {active}" if active else ""),
                  rows, footer,
                  ops_mod.KEG_ROW_OPS + ops_mod.KEG_SCREEN_OPS)


def build_log(ctx) -> Screen:
    lines = ctx.log_lines()[-200:]
    rows = [Row("empty", "", [(_trunc(line, 110), TONE_DIM)], "")
            for line in reversed(lines)]
    if not rows:
        rows = [Row("empty", "", [("nothing has run in this session",
                                   TONE_DIM)], "")]
    return Screen("log",
                  f"Session log  -  {len(lines)} line(s), newest first",
                  rows,
                  [("what you did in this TUI session, newest first. Every "
                    "line names the CLI command the action mirrored, so the "
                    "log doubles as the recipe to do it by hand. In-memory "
                    "only — it is gone when you quit.", TONE_DIM)], [])


def build_menu(ctx) -> Screen:
    """The front door (TUI-2). The operator asked for menus, not number
    keys: every destination is one arrow-press and Enter away, each entry
    says what lives there, and its status line carries live state so the
    menu doubles as the first-glance overview. 'm' from any screen comes
    back here; Esc backs out one step; the number keys still jump."""
    view = ctx.patches_view()
    all_patches = view.get("patches") or []
    enabled = [p for p in all_patches if p.get("enabled")]
    held = [p for p in all_patches if p.get("requires_approval")]
    kill = view.get("kill_switch_active")
    broken = [p for p in all_patches if p.get("state") == "needs_review"]
    services = ctx.services()
    dev = ctx.dev_summary()

    svc_bits = [((s.get("label") or s.get("formula"))
                 + " " + (s.get("state") or "?"),
                 TONE_OK if (s.get("state") or "") in ("started", "running")
                 else TONE_DIM)
                for s in services]

    rows = [
        Row("menu", "overview",
            [("Overview", TONE_BOLD),
             ("   the machine at a glance", TONE_DIM)],
            detail="Start here: the patch store roll-up, both services ("
                   "omlx on :8000, omlx-dev on :8001) and the dev carrier "
                   "with its drift notes. A selected service row can be "
                   "restarted with Enter, after a typed YES.",
            cols2=_flow([(f"{len(all_patches)} patches stored",
                          TONE_DIM if all_patches else TONE_WARN)]
                        + svc_bits)),
        Row("menu", "patches",
            [("Patches", TONE_BOLD),
             ("   enable, promote, roll back, remove", TONE_DIM)],
            detail="Every patch in the store with its live state. Enter on "
                   "a patch opens its actions; the letters (e d p u v a t x) "
                   "still work directly. 'reconcile now' applies the desired "
                   "state to the tree without a restart; otherwise changes "
                   "land at the next boot. The kill switch (K/U) boots omlx "
                   "completely unpatched until cleared.",
            cols2=_flow([
                (f"{len(enabled)} of {len(all_patches)} enabled", TONE_DIM),
                (f"{len(held)} held for approval", TONE_WARN) if held
                else ("none held", TONE_DIM),
                (f"{len(broken)} to review" if len(broken) != 1
             else "1 to review", TONE_BAD) if broken
                else ("none to review", TONE_DIM),
                ("KILL SWITCH ARMED - boots unpatched", TONE_BAD) if kill
                else ("kill switch off", TONE_DIM),
            ])),
        Row("menu", "catalog",
            [("Curated catalog", TONE_BOLD),
             ("   ready-made patches from the repo", TONE_DIM)],
            detail="Patches published under curated_patches/ in the public "
                   "repo. The default tier installs enabled; the optional "
                   "tier installs switched off. Install fetches, gates and "
                   "stores one entry; sync re-reads the whole catalog; "
                   "'adopt as local' detaches an installed entry so future "
                   "syncs leave your decisions alone. Needs network - a "
                   "failed fetch never touches your store.",
            cols2=_flow([("served from GitHub", TONE_DIM),
                         ("re-reads when you open it", TONE_DIM)])),
        Row("menu", "dev",
            [("omlx-dev keg", TONE_BOLD),
             ("   the patched build and its stash", TONE_DIM)],
            detail="The omlx-dev carrier: which branch and tip it sits on, "
                   "and every stashed keg build. Activate switches the "
                   "running keg (HIGH - brew's link record moves and "
                   "auto-build turns off, DEV-11); rollback restores the "
                   "newest stash; prune drops old ones; dev install rebuilds "
                   "from the current patched source. Restart the service "
                   "after any keg change.",
            cols2=_flow([
                (f"branch {dev.get('branch') or '?'} at "
                 f"{str(dev.get('tip') or '?')[:9]}", TONE_DIM)
                if dev.get("installed")
                else ("not bootstrapped - 'omlx-uplift dev bootstrap' "
                      "sets it up", TONE_WARN),
            ])),
        Row("menu", "log",
            [("Session log", TONE_BOLD),
             ("   what you ran, with its CLI twin", TONE_DIM)],
            detail="Every action this session performed, newest first. Each "
                   "line names the exact CLI command it mirrored, so the "
                   "log doubles as the recipe for doing the same by hand. "
                   "In-memory only - quitting clears it.",
            ),
    ]
    footer = [("Enter opens the highlighted item; arrows or j/k move. "
               "Number keys 1-5 still jump straight to a screen.", TONE_DIM)]
    return Screen("menu", "Uplift control menu", rows, footer, [])


def build_actions(screen: Screen) -> "Screen":
    """The action menu for the selected row (TUI-2). Enter on a patch, keg,
    catalog or service row lands here instead of expecting a remembered
    letter: one line per action with its description, then the actions the
    screen itself offers, and what each mirrors on the CLI. Letters stay
    armed — pressing 'x' here runs the same 'remove' the list screen's 'x'
    would. This is a VIEW of the same op pool: it dispatches the identical
    Op objects through the identical confirm gates, so it cannot invent a
    second policy."""
    row = screen.current()
    if row is None:
        return screen
    pool = ops_mod.ops_for(row.kind, screen.ops_pool)
    body = row.raw or {}
    rows = []

    def op_rows(ops_list, target_row):
        out = []
        for op in ops_list:
            cols = [(f"[{op.key}] {op.label}",
                     TONE_BAD if op.danger == ops_mod.HIGH else None)]
            if op.hint:
                cols.append(("   " + _trunc(op.hint, 60), TONE_DIM))
            detail = op.hint or ""
            cli = op.cli_line(body if target_row is not None else None)
            if cli and not cli.startswith("("):
                detail += ("\n\nCLI equivalent:\n  " + cli) if detail \
                          else ("CLI equivalent:\n  " + cli)
            detail += ("\n\nneeds a typed YES (it changes tree bytes, a keg "
                       "or a running service)" if op.danger == ops_mod.HIGH
                       else "\n\nasks for one 'y' before anything is "
                            "written" if op.danger == ops_mod.WRITE
                       else "\n\nread-only — changes nothing")
            if op.needs_tree:
                detail += "\n\n(needs the omlx package tree to be visible)"
            out.append(Row("action", op.key, cols, detail.strip(),
                           raw={"op": op}))
        return out

    rows.extend(op_rows(pool, row))
    screen_ops = screen.screen_ops()
    if screen_ops:
        rows.append(Row("header", "screen",
                        [("Screen actions  (apply to the whole screen, "
                          "not to this row)", TONE_DIM)], ""))
        rows.extend(op_rows(screen_ops, None))
    back = Row("action", "", [("  (Esc goes back)", TONE_DIM)],
               "Go back to the list without running anything. The parent "
               "screen re-reads its state, so whatever happened is visible.")
    rows.append(back)
    # an 'empty' or error row still has the SCREEN's actions (the kill
    # switch must stay reachable with no tree), so the title names the row
    # when it has one and the screen when it does not
    what = (f" for '{row.key}'" if row.key
            else f" on {MENU_LABELS.get(screen.name, screen.name)}")
    return Screen(screen.name + ":actions",
                  f"Actions{what}", rows,
                  [("arrows choose, Enter runs (then the usual confirmation). "
                    "The letters work from the list screen too — this menu "
                    "lists the same commands, it adds none.", TONE_DIM)],
                  [])


BUILDERS = {"menu": build_menu,
            "overview": build_overview, "patches": build_patches,
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
    # the pane is prose, not a table: wrap it to the window instead of
    # cutting each source line, so a long explanation stays readable
    pane = [(_trunc(line, width), TONE_PANE)
            for line in _wrap(str(body), width)] if body else []

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


def _line_window(counts: list, sel: int, budget: int) -> tuple:
    """(first, last) half-open range of rows whose combined LINES fit
    `budget`. The selected row always makes it in (it was asked for); the
    window then grows one row above, one below, alternating, so the cursor
    stays roughly centred the way the old row-unit window did."""
    if counts[sel] > budget:
        return sel, sel + 1
    first, last = sel, sel + 1
    used = counts[sel]
    below = True
    while True:
        placed = False
        if below and last < len(counts) and used + counts[last] <= budget:
            used += counts[last]
            last += 1
            placed = True
        elif not below and first > 0 and used + counts[first - 1] <= budget:
            first -= 1
            used += counts[first]
            placed = True
        elif last < len(counts) and used + counts[last] <= budget:
            used += counts[last]
            last += 1
            placed = True
        elif first > 0 and used + counts[first - 1] <= budget:
            first -= 1
            used += counts[first]
            placed = True
        if not placed:
            return first, last
        below = not below


def _rows_block(screen: Screen, width: int, limit: int) -> list:
    """At most `limit` painted LINES — a descriptive row is one or two lines,
    so the frame budget is counted in lines, never in rows. The hidden-count
    marker shares the same budget; if the window is down to a single cramped
    line the marker rides on that line instead of overflowing the frame
    (curses throws on a write past the last cell — same rule as always)."""
    n = len(screen.rows)
    if limit <= 0 or n == 0:
        screen.shown = (0, 0)
        return []
    sel = max(0, min(screen.selected, n - 1))
    counts = [r.line_count() for r in screen.rows]
    if sum(counts) <= limit:
        first, last, marker = 0, n, False
    else:
        first, last = _line_window(counts, sel, max(1, limit - 1))
        marker = (last < n) or (first > 0)
    out = []
    for i in range(first, last):
        for line in _row_lines(screen.rows[i], width,
                               selected=(i == screen.selected)):
            if len(out) >= limit:
                break               # cramped: drop trailing status lines
            out.append((_trunc(line[0], width - 1), line[1]))
    hidden = (n - last) + (first if marker else 0)
    if hidden:
        note = f"    ... +{hidden} more row(s)"
        if len(out) < limit:
            out.append((_trunc(note, width), TONE_DIM))
        elif out:
            t, tn = out[-1]
            out[-1] = (_trunc(t, max(4, width - 1 - len(note))) + note, tn)
    screen.shown = (first, last)
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


# one-line legend of the keys that work EVERYWHERE, so a new operator sees
# the vocabulary before the verbs (TUI-2: menus are the primary path; the
# letters stay as the fast path)
# must stay under 80 cols — the legend line may never truncate on a plain
# terminal, and T (theme) belongs here because it is advertised on every
# screen, not only where an op lists it
NAV_LEGEND = ("arrows/j-k move  Enter actions  m menu  T theme  "
              "? help  q quit")


def _keybar(screen: Screen, width: int, maxlines: int = 3) -> list:
    """Legend line + the letter shortcuts available on the current row or
    screen, wrapped into at most `maxlines` lines TOTAL."""
    maxlines = max(1, int(maxlines))
    if maxlines == 1:
        return [_trunc(NAV_LEGEND, width)]
    chunks = [f"[{k}] {_trunc(v, 34)}" for k, v in screen.keymap()]
    out = _pack(chunks, width, maxlines - 1)
    return [_trunc(NAV_LEGEND, width)] + out


def _row_text(row: Row, width: int, selected: bool = False) -> str:
    return _trunc(f"{'> ' if selected else '  '}"
                  f"{'  '.join(t for t, _ in row.cols)}", width)


# how urgent each tone is, for the "paint the whole status line in the
# worst tone it contains" rule below
_TONE_RANK = {TONE_BAD: 3, TONE_WARN: 2, TONE_OK: 1, TONE_DIM: 0, None: 0}


def _row_lines(row: Row, width: int, selected: bool = False) -> list:
    """[(text, tone)] for one row: the name line, then the status line.
    curses paints one attribute per addstr, so the status line takes the
    WORST tone its fragments carry — a line containing 'HELD' or
    'needs review' must not wash out to dim just because most of it is
    ordinary. The status line never uses the selection tone: a selected row
    should still read as a sentence, not turn into a solid block."""
    name_tone = (TONE_SEL if selected and row.selectable else
                 TONE_BOLD if selected else
                 TONE_DIM if row.kind in ("header", "empty") else None)
    out = [(_row_text(row, width - 1, selected), name_tone)]
    if not row.cols2:
        return out
    prefix = "      " if not selected else "      > "
    chunks = [c for c in row.cols2 if c[0] != "      "]
    line, worst = prefix, 0
    for text, tone in chunks:
        if len(line) + len(text) > width - 1:
            break
        line += text
        worst = max(worst, _TONE_RANK.get(tone, 0))
    # a line cut by the width must not end on a dangling separator
    line = line.rstrip()
    while line.endswith("|"):
        line = line[:-1].rstrip()
    status_tone = {3: TONE_BAD, 2: TONE_WARN, 1: TONE_OK}.get(worst, TONE_DIM)
    out.append((_trunc(line, width - 1), status_tone))
    return out


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
