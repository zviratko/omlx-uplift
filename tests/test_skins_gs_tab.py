"""GS-TAB palette contract (user 2026-10-11): the server-settings section
tabs must use an accent FROM THE SKIN PALETTE that is different from the
section-heading language. The headings paint three grounds: --ink (clean
slab), --accent (dirty), --red (restart) — so the tab ground must keep a
real distance from all three, and its text must clear AA on that ground.

The CSS default is derived (--gs-tab: var(--dim), --gs-tab-ink: var(--bg)
— dim/bg is symmetric: crates that pass the house rule 'dim is AA text on
every ground' pass the tab ink rule for free). A crate declares tokens
gs-tab / gs-tab-ink when its own --dim collides — single-hue palettes
(turbo-pascal: dim == accent), ember skins (shodan: dim ~= red) or a
muted slate that sits on the accent (kubus) burn exactly that case.

This test IS the contract over every surface: the four built-in themes —
parsed from uplift.css itself, so the test cannot drift from the sheet —
and every bundled crate. A new crate whose palette cannot derive a legal
pair fails here.
"""
import glob
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from omlx_uplift import skins  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE_DIR = os.path.join(ROOT, "omlx_uplift", "skins-example")
CSS = os.path.join(ROOT, "omlx_uplift", "static", "uplift.css")

# --gs-tab-ink CSS default (paired with --dim ground; symmetric contrast)
FALLBACK = {"bg": "#232427", "ink": "#f2f0ea", "dim": "#a5a096",
            "accent": "#e8a020", "red": "#c9243b"}
DIST_MIN = 40          # max-channel RGB distance from every heading anchor
AA_MIN = 4.5           # WCAG contrast of tab ink on tab ground
BG_MIN = 1.45          # the slab must not vanish into the page ground


def _rgb(c):
    c = c.strip().lstrip("#")
    if len(c) == 3:
        c = "".join(x * 2 for x in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _lum(c):
    v = _rgb(c)
    f = lambda x: (x / 255) / 12.92 if (x / 255) <= 0.03928 \
        else (((x / 255) + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2])


def _contrast(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _dist(a, b):
    va, vb = _rgb(a), _rgb(b)
    return max(abs(va[i] - vb[i]) for i in range(3))


def builtin_theme_tokens():
    """Parse the built-in theme blocks straight out of uplift.css so the
    gate measures the sheet, not a copy of it. A block applies to a theme
    when one of its comma-separated selectors is EXACTLY ':root' (every
    theme inherits it) or '[data-theme="<name>"]' (html prefix allowed);
    descendant-scoped selectors like '[data-theme="light"] .foo' do NOT
    count. Later blocks win — file order."""
    css = open(CSS).read()
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)   # comments lie as selectors
    TOKS = ("bg", "ink", "dim", "accent", "red", "gs-tab", "gs-tab-ink")
    part_re = re.compile(r'^(?:html)?(?::root|\[data-theme="(\w*)"\])$')
    blocks = []                       # [(set(names), {tok: hex})] in file order
    for m in re.finditer(r'([^{}@;]+)\{([^{}]*)\}', css):
        sel, body = m.group(1).strip(), m.group(2)
        names = set()
        for part in sel.split(','):
            mm = part_re.match(part.strip())
            if mm:
                names.add(mm.group(1) or 'root')
        if not names:
            continue
        d = {}
        for tok in TOKS:
            t = re.search(r'--%s:\s*(#[0-9a-fA-F]{3,8})\s*;' % re.escape(tok), body)
            if t:
                d[tok] = t.group(1)
        if d:
            blocks.append((names, d))
    out = {}
    for name in ("dark", "light", "enhanced", "cockpit"):
        t = dict(FALLBACK)
        for names, d in blocks:
            if name in names or 'root' in names:
                t.update(d)
        out[name] = t
    return out


def crate_surfaces():
    out = []
    for p in sorted(glob.glob(os.path.join(CRATE_DIR, "*.yml"))):
        meta, reason = skins.parse_crate(open(p, "rb").read())
        assert not reason, (p, reason)
        classic = meta.get("classic") or {}
        base = out_builtin = None
        b = builtin_theme_tokens()
        base = b["light"] if classic.get("theme") == "light" else b["dark"]
        if classic.get("enhanced"):
            base = b["enhanced"]
        t = dict(base)
        t.update({k: v for k, v in (meta.get("tokens") or {}).items()
                  if k in ("bg", "ink", "dim", "accent", "red",
                           "gs-tab", "gs-tab-ink")})
        out.append((os.path.basename(p), t))
    return out


def _resolve(name, t):
    ground = t.get("gs-tab") or t["dim"]
    ink = t.get("gs-tab-ink") or t["bg"]
    problems = []
    for a in ("ink", "accent", "red"):
        d = _dist(ground, t[a])
        if d < DIST_MIN:
            problems.append("ground %s within %d of heading --%s (%s)"
                            % (ground, d, a, t[a]))
    c = _contrast(ground, ink)
    if c < AA_MIN:
        problems.append("tab ink %s on ground %s only %.2f:1 (AA needs %.1f)"
                        % (ink, ground, c, AA_MIN))
    cbg = _contrast(ground, t["bg"])
    if cbg < BG_MIN:
        problems.append("ground %s vs page bg %s only %.2f:1 (slab invisible)"
                        % (ground, t["bg"], cbg))
    return problems


_surfaces = list(builtin_theme_tokens().items()) + crate_surfaces()
IDS = [n for n, _ in _surfaces]


@pytest.mark.parametrize("name", IDS)
def test_gs_tab_pair_is_legal(name):
    t = dict(_surfaces)[name]
    bad = _resolve(name, t)
    assert not bad, "%s: %s" % (name, "; ".join(bad))


def test_css_default_is_derived_not_hardcoded():
    """--gs-tab must resolve from the palette (dim default), no fixed hue
    in :root — the exact complaint that killed the steel-blue first pass
    ('blue doesn't really suit many of the skins')."""
    css = open(CSS).read()
    decls = [l for l in css.splitlines() if l.strip().startswith("--gs-tab:")]
    assert decls, "--gs-tab gone from uplift.css"
    assert all("var(--dim)" in l for l in decls), decls
    ink_decls = [l for l in css.splitlines()
                 if l.strip().startswith("--gs-tab-ink:")]
    assert all("var(--bg)" in l for l in ink_decls), ink_decls


def test_vocab_carries_the_pair():
    assert {"gs-tab", "gs-tab-ink"} <= skins.COLOR_TOKENS
