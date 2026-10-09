"""TUI themes (TUI-1) — palettes as data, plus the curses colour plumbing.

A theme maps the model's semantic TONES (ok / bad / warn / dim / bold / sel /
title / pane) onto terminal colours. The model and the painter never name a
colour; they name what a line MEANS, so a new palette is one dict.

Colours are written as hex to match the dashboard skin crates (the P(DOOM)
palette is the SHODAN skin's own token set — same void black, laser crimson
and ember orange the browser UI uses), and are resolved down at runtime to
what the terminal can actually do:

  256 colours + can_change_color -> exact RGB
  256 colours                    -> nearest xterm-256 cube entry
  8/16 colours                   -> nearest basic colour
  mono                           -> attributes only (bold / reverse)

The choice is stored in ~/.omlx/uplift/tui.json, next to the other uplift
state. Deliberately NOT in patches.json: that file is the patch manifest with
approvals and desired versions in it, and a UI preference has no business
riding along with it.
"""
from __future__ import annotations

import json
import os

from .model import TONES          # the model owns the tone vocabulary

# basic ANSI colours for the fallback ladder: name -> (r, g, b)
_ANSI = {
    0: (0, 0, 0), 1: (170, 0, 0), 2: (0, 170, 0), 3: (170, 85, 0),
    4: (0, 0, 170), 5: (170, 0, 170), 6: (0, 170, 170), 7: (170, 170, 170),
    8: (85, 85, 85), 9: (255, 85, 85), 10: (85, 255, 85), 11: (255, 255, 85),
    12: (85, 85, 255), 13: (255, 85, 255), 14: (85, 255, 255),
    15: (255, 255, 255),
}

DEFAULT = "default"

THEMES: dict[str, dict] = {
    # the terminal's own look: uplift only adds emphasis, never colour
    "default": {
        "label": "terminal default",
        "note": "no palette imposed — uses your terminal's colours",
        "title_prefix": "",
        "bg": None,
        "fg": None,
        "tones": {
            "title": ("CYAN", "bg", "bold"),
            "ok": ("GREEN", "bg", ""),
            "bad": ("RED", "bg", "bold"),
            "warn": ("YELLOW", "bg", ""),
            "dim": ("BLUE", "bg", ""),
            "bold": ("CYAN", "bg", "bold"),
            "sel": ("BLACK", "CYAN", "bold"),
            "pane": ("BLUE", "bg", ""),
        },
    },
    # P(DOOM) — the SHODAN skin (System Shock / TriOptimum diagnostics) in
    # the terminal: void black hull, laser crimson signage, ember-lit readout.
    "p(doom)": {
        "label": "P(DOOM) — SHODAN",
        "note": "TriOptimum diagnostics: void black, laser crimson, ember "
                "orange (matches the SHODAN dashboard skin)",
        "title_prefix": "SHODAN",
        "bg": "#1a0d0a",
        "fg": "#f2e9e1",
        "tones": {
            "title": ("#ff4136", "#2a0f0a", "bold"),   # crimson nav signage
            "ok": ("#ffb14a", "bg", ""),               # nominal = ember-lit
            "bad": ("#ff4136", "bg", "bold"),          # hot laser
            "warn": ("#ffb14a", "bg", "bold"),         # ember
            "dim": ("#d8443a", "bg", ""),              # laser crimson, small text
            "bold": ("#f2e9e1", "bg", "bold"),         # bone
            "sel": ("#1a0d0a", "#ff4136", "bold"),     # inverted laser bar
            "pane": ("#e8a39a", "bg", ""),             # readout glass
        },
    },
    "phosphor": {
        "label": "phosphor amber",
        "note": "single-hue CRT: amber on near-black, no colour coding — "
                "state reads from the words, not the hue",
        "title_prefix": "",
        "bg": "#0a0805",
        "fg": "#ffb14a",
        "tones": {
            "title": ("#ffb14a", "#1a1208", "bold"),
            "ok": ("#ffd9a0", "bg", "bold"),
            "bad": ("#ff7a4a", "bg", "bold"),
            "warn": ("#ffb14a", "bg", "bold"),
            "dim": ("#a06a2a", "bg", ""),
            "bold": ("#ffe4c0", "bg", "bold"),
            "sel": ("#0a0805", "#ffb14a", "bold"),
            "pane": ("#c88a3a", "bg", ""),
        },
    },
    "mono": {
        "label": "mono",
        "note": "no colour at all — bold and reverse only, safe on any "
                "terminal and readable in a screenshot",
        "title_prefix": "",
        "bg": None,
        "fg": None,
        "mono": True,
        "tones": {t: (None, None, ("bold" if t in ("title", "bold", "bad",
                                                   "warn", "sel") else ""))
                  for t in TONES},
    },
}

ALIAS = {"doom": "p(doom)", "shodan": "p(doom)", "pd": "p(doom)"}


def norm(name) -> str:
    key = (name or DEFAULT).strip().lower()
    key = ALIAS.get(key, key)
    return key if key in THEMES else DEFAULT


def theme(name) -> dict:
    return THEMES[norm(name)]


def names() -> list:
    return list(THEMES)


def describe(name) -> str:
    t = theme(name)
    return f"{t['label']} — {t['note']}"


def resolve(name: str):
    """'#rrggbb' -> (r, g, b) 0..255, or None for a named/basic colour."""
    s = (name or "").strip()
    if not s.startswith("#"):
        return None
    s = s[1:]
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return None
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def _dist(a, b) -> int:
    return sum((x - y) ** 2 for x, y in zip(a, b))


def basic_index(rgb) -> int:
    """Nearest of the 16 basic ANSI colours (the floor every terminal has)."""
    if rgb is None:
        return -1
    return min(_ANSI, key=lambda i: _dist(_ANSI[i], rgb))


def cube_index(rgb) -> int:
    """Nearest xterm-256 colour-cube entry (16..231)."""
    if rgb is None:
        return -1
    best, idx = None, 16
    for i in range(216):
        r, g, b = (i // 36), ((i // 6) % 6), (i % 6)
        col = tuple(round(c * 255 / 5) for c in (r, g, b))
        d = _dist(col, rgb)
        if best is None or d < best:
            best, idx = d, 16 + i
    return idx


def gray_index(rgb) -> int:
    """Nearest of the 24 greyscale ramp entries (232..255), if closer than
    the cube would give."""
    if rgb is None:
        return -1
    if not (abs(rgb[0] - rgb[1]) < 12 and abs(rgb[1] - rgb[2]) < 12):
        return -1
    lum = sum(rgb) // 3
    step = max(0, min(23, round((lum - 8) / 10.0)))
    return 232 + step


def xterm256_rgb(i: int) -> tuple:
    """The RGB a xterm-256 colour number stands for (cube 16..231, grey
    ramp 232..255). The 16 basics come from _ANSI."""
    if 0 <= i <= 15:
        return _ANSI[i]
    if i <= 231:
        j = i - 16
        return tuple(round(c * 255 / 5) for c in
                     (j // 36, (j // 6) % 6, j % 6))
    lum = 8 + (i - 232) * 10
    return (lum, lum, lum)


def color_index(rgb, mode: str) -> int:
    """Nearest terminal colour number for `rgb` under `mode`
    ('256' | '16'). -1 means 'no colour available'."""
    if rgb is None:
        return -1
    if mode == "16":
        return basic_index(rgb)
    cube = cube_index(rgb)
    gray = gray_index(rgb)
    if gray >= 0 and _dist(xterm256_rgb(gray), rgb) < _dist(
            xterm256_rgb(cube), rgb):
        return gray
    return cube


# ------------------------------------------------------------- persistence --
def config_path(base_dir: str | None = None) -> str:
    from .. import patches

    return os.path.join(base_dir or patches.default_base_dir(), "tui.json")


def load(base_dir: str | None = None) -> dict:
    """Read the TUI prefs. A missing or broken file is the normal case (first
    run, or a hand-edited file) and must never stop the UI from starting."""
    try:
        with open(config_path(base_dir), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save(cfg: dict, base_dir: str | None = None) -> str:
    path = config_path(base_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)
    return path


def get_theme(base_dir: str | None = None) -> str:
    return norm(load(base_dir).get("theme"))


def set_theme(name: str, base_dir: str | None = None) -> str:
    """Persist the choice. Reload-and-write, the way every other store writer
    in this package does, so a stamp set on a stale copy is not lost."""
    key = norm(name)
    cfg = load(base_dir)
    cfg["theme"] = key
    save(cfg, base_dir)
    return key


# ------------------------------------------------------------ curses bridge --
# basic ANSI colours by name, for themes that want "the terminal's RED"
# rather than a fixed hex value (the 'default' theme is one of those).
_BASIC = {"BLACK": 0, "RED": 1, "GREEN": 2, "YELLOW": 3, "BLUE": 4,
          "MAGENTA": 5, "CYAN": 6, "WHITE": 7,
          "BRBLACK": 8, "BRRED": 9, "BRGREEN": 10, "BRYELLOW": 11,
          "BRBLUE": 12, "BRMAGENTA": 13, "BRCYAN": 14, "BRWHITE": 15}


def terminal_mode(max_colors: int) -> str:
    """What the terminal can do: '16' or '256'.

    Truecolour is deliberately not used: it looks right on a real xterm and
    turns into unreadable noise through a remote tmux/screen or an ssh hop,
    and this is exactly the tool people run on the dev box over ssh. The
    256-colour cube reproduces these palettes within a few units per channel
    and works everywhere curses does.
    """
    return "256" if int(max_colors or 0) >= 256 else "16"


def _split_spec(spec):
    """A tone colour spec -> (rgb or None, basic index or None).
    'bg'/'fg' resolve to the theme ground/cursor; a NAME picks that basic
    colour so the terminal's own palette shows through; '#rrggbb' is exact."""
    if spec is None:
        return None, None
    s = str(spec).strip()
    if not s:
        return None, None
    up = s.upper()
    if up in _BASIC:
        idx = _BASIC[up]
        return _ANSI[idx], idx
    return resolve(s), None


def palette(name: str, max_colors: int, can_change: bool = False,
            alloc_pair=None, init_color=None, n_pairs: int = 64,
            bold_attr: int = 1, reverse_attr: int = 2):
    """Map a theme's tones to curses attributes.

    name         theme key ('p(doom)', 'default', ...)
    max_colors   curses.COLORS
    can_change   curses.can_change_color() — allows exact RGB in free slots
    color_pair   callable(fg, bg) -> attr   (curses.color_pair)
    init_color   callable(idx, r, g, b)     (curses.init_color, 0..1000)
    n_pairs      how many pairs may be allocated

    alloc_pair(fg, bg) -> attribute is the only way to get a colour attribute
    (the caller wraps curses.init_pair + curses.color_pair — colour_pair takes
    a PAIR NUMBER, not two colours, so it cannot be passed directly);
    init_color(idx, r, g, b) writes an exact slot when the terminal allows it.
    Passing these in instead of importing curses keeps this testable headless.
    Returns (attrs, info): attrs maps a tone name to an attribute int, info
    says what was actually achievable, so the UI can tell the operator when the
    terminal degraded the palette instead of silently lying about the colours.
    """
    th = theme(name)
    mode = "mono" if th.get("mono") else terminal_mode(max_colors)
    bg_rgb, _ = _split_spec(th.get("bg"))
    fg_rgb, _ = _split_spec(th.get("fg"))
    alloc_pair = alloc_pair or (lambda f, b: 0)

    cache: dict = {}
    # 0..15 are the basic colours, so 16 is the first slot a theme may
    # repaint in either mode
    alloc = [16]
    stats = {"exact": 0, "approx": 0, "basic": 0, "default": 0}

    def index_for(rgb, basic_idx, want_default):
        if want_default:
            stats["default"] += 1
            return -1
        if rgb is None:
            stats["default"] += 1
            return -1
        if rgb in cache:
            return cache[rgb]
        if basic_idx is not None:
            # the theme named a BASIC colour on purpose (the 'default' theme
            # does this so the terminal's own palette shows through) — keep
            # that index even on a 256-colour terminal, never replace it with
            # a re-mixed exact slot
            got = basic_idx
            stats["basic"] += 1
        elif mode == "16":
            got = basic_index(rgb)
            stats["basic"] += 1
        elif can_change and alloc[0] <= 255:
            got = alloc[0]
            try:
                if init_color:
                    # curses wants 0..1000; round, do not floor — flooring
                    # 0xFF sends 996 and makes every 'full' channel dim
                    init_color(got, *(round(c * 1000 / 255) for c in rgb))
                alloc[0] += 1
                stats["exact"] += 1
            except Exception:
                got = color_index(rgb, "256")
                stats["approx"] += 1
        else:
            got = color_index(rgb, "256")
            stats["approx"] += 1
        cache[rgb] = got
        return got

    attrs: dict = {}
    used = 0

    def take(fg_idx, bg_idx):
        nonlocal used
        if used >= max(0, int(n_pairs) - 1):
            return 0
        used += 1
        return alloc_pair(fg_idx, bg_idx)

    for tone in TONES:
        spec = th["tones"].get(tone) or (None, None, "")
        f_raw, b_raw, mods = (list(spec) + ["", ""])[:3]
        b_is_default = str(b_raw).lower() in ("", "bg")
        f_is_default = str(f_raw).lower() in ("", "fg")
        b_rgb, b_idx = _split_spec(None if b_is_default else b_raw)
        f_rgb, f_idx = _split_spec(None if f_is_default else f_raw)
        if b_is_default and str(b_raw).lower() == "bg":
            b_rgb, b_idx = bg_rgb, None
        if f_is_default and str(f_raw).lower() == "fg":
            f_rgb, f_idx = fg_rgb, None

        attr = 0
        if mode == "mono":
            if "bold" in mods:
                attr |= bold_attr
            attrs[tone] = attr
            continue
        fi = index_for(f_rgb, f_idx, f_is_default and str(f_raw).lower() != "fg")
        bi = index_for(b_rgb, b_idx, b_is_default and str(b_raw).lower() != "bg")
        attr |= take(fi, bi)
        if "bold" in mods:
            attr |= bold_attr
        attrs[tone] = attr
    # honest about WHAT was delivered: a theme that names basic colours on
    # purpose (the 'default' theme) is not 'approximated', it is the terminal
    # showing through — the status line must not imply a loss that did not
    # happen
    # the ground fill (bkgd): ONLY a theme that declares its own background
    # repaints the screen. Doing it from a tone instead would tint every
    # plain line with that tone's foreground — under 'default' that turns the
    # whole UI blue, which is the opposite of "uses your terminal's colours".
    ground = 0
    if mode != "mono" and bg_rgb is not None:
        ground = take(index_for(fg_rgb, None, fg_rgb is None),
                      index_for(bg_rgb, None, False))

    if mode == "mono":
        note = "bold/reverse only"
    elif stats["exact"]:
        note = "exact RGB"
    elif stats["approx"]:
        note = "xterm-256 approximation"
    else:
        note = "terminal's own colours" if mode == "256" \
            else "16 basic colours"
    return attrs, {"mode": mode, "pairs": used, "note": note,
                   "label": th["label"], "stats": stats, "ground": ground}


