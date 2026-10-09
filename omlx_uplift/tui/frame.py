"""Frame layout (TUI-3): Midnight-Commander structure.

The user's complaint about TUI-2 was fair — a list of screens is a launcher,
not a menu. MC's model is: a BAR of menus across the top, big bordered
panels that FILL the window, dropdowns with accelerator letters that act on
the panel selection, a function-key legend along the bottom. This module
turns that into lines.

A line is a list of (text, tone) SEGMENTS — usually one, more when a
dropdown splices its own colours over the base frame. The painter walks
segments left to right; everything else (fit, mouse hits) counts cells.
Tones survive every operation here (pad, clip, slice, splice) because a
flattened frame paints a selection bar in the wrong colour, which is worse
than a crooked one.

Two guarantees carried over from TUI-1/2, still load-bearing:
  * no line is wider than the terminal MINUS ONE cell (curses auto-wrap at
    the last column corrupts frames — the painter also clips to cols-1);
  * the frame is never taller than the terminal (addstr past the last cell
    throws).

Column model (width W): every box's right border lands at or before x=W-2.
  wide  (W >= MIN_WIDE): [rows box wL][1 gap][details box wR], wL+wR+1=W-1
  narrow:                [rows box W-1], details stacked under it when on
"""
from __future__ import annotations

from .model import (TONE_BAD, TONE_BOLD, TONE_DIM, TONE_OK, TONE_SEL,
                    TONE_TITLE, TONE_WARN, _line_window, _pad, _trunc,
                    _wrap)

# MC draws its frames with line-drawing glyphs; a non-UTF8 terminal gets a
# clean ASCII frame instead of mojibake (the operator's terminal has eaten
# fancy glyphs before — see terminal-glyph history).
BOX = {"tl": "┌", "tr": "┐", "bl": "└", "br": "┘", "h": "─", "v": "│",
       "lt": "┤", "rt": "├"}
ASCII = {"tl": "+", "tr": "+", "bl": "+", "br": "+", "h": "-", "v": "|",
         "lt": "|", "rt": "|"}

MIN_WIDE = 100            # at least this many columns to go two-column
DETAIL_FRACTION = 0.38    # right pane share when wide

SOFTKEYS = ("F1 help   F3 detail   F5 re-read   F9 menu   T theme   F10 quit")


def seg(text, tone=None):
    """one-line segment list (the painter and tests build lines with it)"""
    return [(text, tone)]


def line_text(line) -> str:
    return "".join(t for t, _ in line)


def line_len(line) -> int:
    return sum(len(t) for t, _ in line)


class Frame:
    """Rendered lines + click hit-regions. hits: (x0, x1, y0, y1, action)
    where action is ('menu', i) | ('item', i) | ('row', i) and x/y are cells
    in the painted frame (y counts from 0 = the bar line)."""

    __slots__ = ("lines", "hits")

    def __init__(self, lines, hits=None):
        self.lines = lines
        self.hits = hits or []


def _hline(g, w, left, right, title="", tone=None):
    """border line spanning w cells INCLUDING both corners."""
    inner = w - 2
    if title:
        t = _trunc(f" {title} ", max(0, inner - 2))
        body = g["h"] + t + g["h"] * (inner - 2 - len(t))
    else:
        body = g["h"] * inner
    return [(left, tone), (body, tone), (right, tone)]


def _box(title, inner_lines, w, g, active=True):
    """A framed box exactly w cells wide (borders included). inner_lines:
    str, (text, tone) or segment list — each padded/clipped to w-2 cells.
    Returns border + body + closing-border segment lines."""
    vt = TONE_TITLE if active else TONE_DIM
    out = [_hline(g, w, g["tl"], g["tr"], title=title, tone=vt)]
    for ln in inner_lines:
        if isinstance(ln, str):
            segs = [(ln, None)]
        elif isinstance(ln, tuple):
            segs = [ln]
        else:
            segs = list(ln)
        text, tone = line_text(segs), segs[0][1] if segs else None
        out.append([(g["v"], vt)] + _split_pad(text, w - 2, tone)
                   + [(g["v"], vt)])
    out.append(_hline(g, w, g["bl"], g["br"], tone=vt))
    return out


def _split_pad(text, w, tone):
    """clip to w cells then pad to w so the closing vertical aligns."""
    text = _trunc(text, w)
    return [(text, tone), (" " * (w - len(text)), None)]


def render_frame(screen, *, menus=None, bar_index=0, bar_open=False,
                 bar_focus=False, items=None, item_cursor=0, detail=None,
                 footers=None, prompt="", busy="", yes_line=None,
                 width, height, notice="", utf8=True):
    """Full MC-style frame. Returns Frame(lines, hits).

    menus: list[menus.Menu]; bar_index: focused slot (always valid, the bar
    is permanent); bar_open: draw its dropdown; items: that dropdown's
    list[Item] (SEP markers allowed) or None; detail: text for the details
    pane (None = hide the pane and let rows have the whole height).

    The returned hits are ordered TOPMOST FIRST — a dropdown is drawn over
    the rows, so an overlapping click must reach the menu, never the row
    underneath it (App.click() takes the first match)."""
    g = BOX if utf8 else ASCII
    width = max(40, int(width))
    height = max(6, int(height or 24))
    footers = footers or []
    hits, row_hits, item_hits = [], [], []

    # ---- vertical budget, bottom-up. Protected: the bar (1), the F-key
    # legend (1), and while a question is live: the busy line + prompt +
    # the typed-YES echo. Rows box, footers and details share what is left.
    prompt_lines = _wrap(prompt, width - 3) if prompt else []
    question = 0
    if prompt_lines or busy:
        question = len(prompt_lines) + 1 + (1 if yes_line is not None else 0)
    n_foot = min(len(footers), 2) if height >= 10 else 0
    body_h = max(3, height - 1 - 1 - n_foot - question)
    if body_h < 3:
        n_foot = 0
        body_h = max(3, height - 2 - question)

    bar, spans = _bar_line(g, menus, bar_index, bar_open, bar_focus, width,
                           notice)
    for i, (x0, x1) in enumerate(spans):
        hits.append((x0, x1, 0, 0, ("menu", i)))

    # ---- horizontal split
    if width >= MIN_WIDE and detail is not None:
        wL = int(width * (1 - DETAIL_FRACTION))
        wR = width - 1 - wL - 1
        inner_w = wL - 2
    else:
        wL = width - 1
        wR = 0
        inner_w = wL - 2

    rows_budget = max(2, body_h - 2)
    if wR == 0 and detail is not None:
        # narrow: the rows box shrinks so the details box fits UNDER it
        # (stacked like MC on a 25-row terminal) — but only when there is
        # something to say and the list is short enough to spare the room
        need = sum(r.line_count() for r in screen.rows) + 2
        if body_h >= 8 and 4 < need <= body_h - 3:
            rows_budget = need - 2

    row_lines, first_shown, shown_count = _rows_in_box(screen, inner_w,
                                                       rows_budget)
    left = _box(_trunc(screen.title, inner_w - 2), row_lines, wL, g,
                active=not bar_focus)
    # the box's top border is body line 0 = frame line 1, so painted row i
    # is frame line 2 + i — and only REAL rows get hits (padding must not
    # let a click select a row that is not there). Collected separately:
    # a dropdown spliced over these rows must win the click.
    row_hits = [(1, inner_w, 2 + i, 2 + i, ("row", first_shown + i))
                for i in range(shown_count)]

    right = []
    if wR:
        dl = _wrap(str(detail), wR - 2)[:rows_budget]
        while len(dl) < rows_budget:      # MC panels SHARE their height:
            dl.append("")                 # two boxes ending mid-screen
                                          # reads as broken, not tidy
        right = _box("Details", dl, wR, g, active=False)

    # ---- assemble body
    body = []
    if wR:
        for i in range(max(len(left), len(right))):
            lrow = left[i] if i < len(left) else seg(" " * wL)
            rrow = right[i] if i < len(right) else seg(" " * wR)
            body.append(lrow + [(" ", None)] + rrow)
    else:
        body = list(left)
        if detail is not None:
            room = body_h - len(body)
            if room >= 4:
                dl = _wrap(str(detail), width - 3)[:room - 2]
                body += _box("Details", dl, width - 1, g, active=False)

    filled = _pad_body(body, body_h, width, g)

    # ---- dropdown overlay, spliced over the body band
    if items is not None and menus and bar_open:
        dx0 = spans[bar_index][0] if bar_index < len(spans) else 1
        dw = min(64, width - 1 - dx0)
        # the dropdown hangs INSIDE the body band: borders + optional cut
        # marker must fit, or the bottom border eats a footer line
        max_body = max(1, body_h - 2)
        if len(items) > max_body:
            max_body = max(1, max_body - 1)
        if len(items) <= max_body:
            lo, hi = 0, len(items)
        else:
            lo = max(0, min(item_cursor - max_body // 2,
                            len(items) - max_body))
            hi = lo + max_body
        box_lines, rowmap = dropdown_lines(menus[bar_index].name,
                                           items[lo:hi], dw, g, item_cursor)
        cut = len(items) - hi
        if cut > 0:
            note, pad = _split_pad(f"    ... +{cut} more", dw - 2, TONE_DIM)
            box_lines.insert(-1, [(g["v"], TONE_TITLE), note, pad,
                                  (g["v"], TONE_TITLE)])
        for j, bl in enumerate(box_lines):
            if j >= len(filled):
                break
            filled[j] = _splice(filled[j], dx0, bl, width - 1)
        # box_lines[0] is the top border at body line 0 = frame line 1; item
        # row k is box_lines[1 + k] = frame line 2 + k
        item_hits = [(dx0 + 1, dx0 + dw - 2, 2 + k, 2 + k, ("item", it_idx))
                     for k, it_idx in enumerate(rowmap) if it_idx is not None]
        hits.extend(item_hits)

    hits.extend(row_hits)

    # ---- tail: busy line / prompt, footers, F-key legend
    tail = []
    if busy:
        tail.append(seg(_trunc(f"running: {busy} ... "
                               f"(Ctrl-C cancels a command)", width - 2),
                        TONE_WARN))
    for i, p in enumerate(prompt_lines):
        tail.append(seg(_trunc(("  > " if i == len(prompt_lines) - 1
                                else "    ") + p, width - 2), TONE_BAD))
    if yes_line is not None:
        tail.append(seg(_trunc(f"  type YES then enter -> {yes_line}_",
                               width - 2), TONE_BAD))
    for t, tone in footers[:n_foot]:
        tail.append(seg(_trunc(str(t), width - 2), tone))
    tail.append(seg(_pad(SOFTKEYS, width - 2), TONE_TITLE))

    out = [bar] + filled + tail
    out = [_clip_line(l, width - 1) for l in out]
    if len(out) > height:
        out = out[:height]
    return Frame(out, hits)


def _bar_line(g, menus, bar_index, bar_open, bar_focus, w, notice=""):
    """The MC menu bar: ╡Name╡ cells. The OPEN menu inverts its name box, a
    FOCUSED-but-closed menu inverts just as much, borders stay in title
    tone. Spans are inclusive cell ranges for mouse hits. The right side
    carries the app summary (theme, terminal size)."""
    out = []
    spans = []
    x = 0
    menus = menus or []
    for i, m in enumerate(menus):
        cell = f" {m.name} "
        is_this = (i == bar_index)
        tone = TONE_SEL if is_this and (bar_open or bar_focus) else None
        border = TONE_SEL if (is_this and bar_focus and not bar_open) \
            else TONE_TITLE
        out.append((g["lt"], border))
        out.append((cell, tone))
        out.append((g["rt"], border))
        spans.append((x, x + len(cell) + 1))
        x += len(cell) + 2
    if notice:
        right = _trunc(notice, max(0, w - 1 - x - 2))
        if right:
            out.append((" " * max(0, w - 1 - x - len(right)), None))
            out.append((right, TONE_WARN))
    return out, spans


def dropdown_lines(title, items, w, g, cursor):
    """items: list of menus.Item, with the 'sep' marker where a divider goes
    (a self-describing string sentinel, so this module never imports menus
    and cannot drift from it).

    One row per item: ' * a  Label   hint…' — accel bold, disabled rows dim
    with their REASON inline (MC greys and keeps visible rather than hiding
    a command), check marks for state. The LABEL owns the box: a hint only
    gets what labels leave over and disappears rather than eating a command
    name.

    Returns (lines, rowmap): rowmap maps body-line index -> item index
    (None for a divider) so cursor math and mouse hits agree with what is
    drawn even after the dropdown is scrolled to fit."""
    inner = w - 2
    lines, rowmap = [], []
    for i, it in enumerate(items):
        if isinstance(it, str):                     # separator — _box adds
            lines.append([((g["lt"] + g["h"] * (inner - 2) + g["rt"])
                           if inner >= 4 else g["h"] * inner, TONE_TITLE)])
            rowmap.append(None)
            continue
        # '*' not '√': the tick is not in the DEC Alternate Character Set,
        # and this operator's terminal has eaten exotic glyphs before
        mark = ("*" if it.checked is True
                else "-" if it.checked is False else " ")
        accel = it.accel or " "
        label = _trunc(it.label, max(4, inner - 8))
        hint = it.hint or ""
        if not it.enabled:
            hint = it.reason or "not available now"
        segs = [(f"{mark} ", TONE_OK if it.checked is True else None),
                (f"{accel} ", TONE_BOLD if it.enabled else TONE_DIM),
                (" " + label, None if it.enabled else TONE_DIM)]
        used = 4 + len(accel) + len(label)
        room = inner - used - 2
        if hint and room >= 12:
            segs.append(("  " + _trunc(hint, room), TONE_DIM))
        text = line_text(segs)
        if i == cursor:
            segs = [(_pad(text, inner), TONE_SEL)]
        else:
            segs = segs + [(" " * max(0, inner - len(text)), None)]
        lines.append(segs)
        rowmap.append(i)
    return _box(title, lines, w, g), rowmap


def _rows_in_box(screen, w, budget):
    """Rows trimmed to the panel width and the box height. Returns
    (lines, first_index, painted_row_count) — the hit list uses the count so
    blank padding can never select an invisible row."""
    n = len(screen.rows)
    if budget <= 0 or n == 0:
        screen.shown = (0, 0)
        return [], 0, 0
    sel = max(0, min(screen.selected, n - 1))
    counts = [r.line_count() for r in screen.rows]
    if sum(counts) <= budget:
        first, last = 0, n
    else:
        first, last = _line_window(counts, sel, max(1, budget - 1))
    screen.shown = (first, last)
    out = []
    for i in range(first, last):
        out.extend(_row_plain(screen.rows[i], w, selected=(i == sel)))
    painted = last - first
    if last < n and len(out) < budget:
        out.append((f"    ... +{n - last} more", TONE_DIM))
    while len(out) < budget:
        out.append(("", None))
    return out[:budget], first, min(painted, budget)


def _row_plain(row, width, selected=False):
    from .model import _row_lines
    return _row_lines(row, width, selected=selected)


def _pad_body(body, body_h, width, g):
    """Pad/truncate the body band to EXACTLY body_h lines, each padded with
    PLAIN spaces to width-1 cells. Two closed boxes need no wall between
    them; a flat canvas is also what the dropdown splice starts from. Tones
    are carried through untouched (the padding is the only thing added).
    (The old border-repeating filler is what drew a double wall where a
    stacked details box used to sit.)"""
    while len(body) > body_h:
        body.pop()
    canvas = []
    for ln in body:
        ln = _clip_line(ln, width - 1)
        used = line_len(ln)
        if used < width - 1:
            ln = ln + [(" " * (width - 1 - used), None)]
        canvas.append(ln)
    while len(canvas) < body_h:
        canvas.append([(" " * (width - 1), None)])
    return canvas


def _slice(line, start, end):
    """cells [start, end) of a segment line, tones preserved"""
    out, pos = [], 0
    for t, tone in line:
        t0, t1 = pos, pos + len(t)
        pos = t1
        if t1 <= start or t0 >= end:
            continue
        a, b = max(start, t0) - t0, min(end, t1) - t0
        if b > a:
            out.append((t[a:b], tone))
    return out


def _splice(base, x, overlay, width):
    """Replace cells [x, x+len(overlay)) of a line with overlay segments.
    Everything outside the overlay keeps ITS OWN tone — flattening the base
    here is what made a spliced frame lose its selection bar."""
    ot = line_len(overlay)
    out = _slice(base, 0, x) + list(overlay) + _slice(base, x + ot, width)
    return _clip_line(out, width)


def _clip_line(line, width):
    out, used = [], 0
    for t, tone in line:
        if used >= width:
            break
        if used + len(t) <= width:
            out.append((t, tone))
            used += len(t)
        else:
            out.append((t[:width - used], tone))
            used = width
    return out
