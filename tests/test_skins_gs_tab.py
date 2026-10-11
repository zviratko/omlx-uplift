"""GS-TAB palette contract (user 2026-10-11, rework 2): the server-settings
tab accent IS the skin's accent — --gs-tab defaults to var(--accent), the
slab text to var(--bg). What the tabs must never do is be confusable with
a SECTION HEADING: the headings paint their clean state as an --ink slab,
so the contract is distance(ground, --ink) >= 40 plus AA text on the slab.
A ground equal to the page bg would erase the slab entirely — also gated.

Sharing color with the transient dirty (accent) / restart (red) heading
states is accepted by design: the user asked for the skin's accent family
('red in discovery one'), and a tab is nav while a heading strip is state —
different shape and position carry the meaning.

Crates that fail the default declare tokens gs-tab / gs-tab-ink (a step of
their own hue — nerv brightens MAGI red for AA, artelight deepens the
sodium amber, inkwell-noir's duotone accent IS the ink so the slab steps
to graphite, aperture keeps the orange and swaps the ink). This test is
the contract over EVERY surface: the four built-in themes parsed straight
from uplift.css (a copy in this file could drift and lie) and every
bundled crate.
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

# :root fallbacks mirroring uplift.css (the parser below reads the sheet;
# these only cover a token the sheet forgot to set)
FALLBACK = {"bg": "#232427", "ink": "#f2f0ea", "dim": "#a5a096",
            "accent": "#e8a020", "red": "#c9243b"}
DIST_MIN = 40          # vs the clean heading slab (--ink ground)
AA_MIN = 4.5           # tab ink on tab ground
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
    gate measures the sheet, not a copy of it. A block applies when one of
    its comma selectors is EXACTLY ':root' (all themes) or
    '[data-theme="<name>"]'; later blocks win. var() defaults resolve here:
    --gs-tab -> --accent, --gs-tab-ink -> --bg."""
    css = open(CSS).read()
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)   # comments lie as selectors
    TOKS = ("bg", "ink", "dim", "accent", "red", "gs-tab", "gs-tab-ink")
    part_re = re.compile(r'^(?:html)?(?::root|\[data-theme="(\w*)"\])$')
    blocks = []
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
    b = builtin_theme_tokens()
    out = []
    for p in sorted(glob.glob(os.path.join(CRATE_DIR, "*.yml"))):
        meta, reason = skins.parse_crate(open(p, "rb").read())
        assert not reason, (p, reason)
        classic = meta.get("classic") or {}
        base = b["light"] if classic.get("theme") == "light" else b["dark"]
        if classic.get("enhanced"):
            base = b["enhanced"]
        t = dict(base)
        t.update({k: v for k, v in (meta.get("tokens") or {}).items()
                  if k in ("bg", "ink", "dim", "accent", "red",
                           "gs-tab", "gs-tab-ink")})
        out.append((os.path.basename(p), t))
    return out


def _resolve(t):
    ground = t.get("gs-tab") or t["accent"]
    ink = t.get("gs-tab-ink") or t["bg"]
    problems = []
    d = _dist(ground, t["ink"])
    if d < DIST_MIN:
        problems.append("ground %s within %d of the CLEAN heading slab "
                        "--ink (%s) — tab and header would blur"
                        % (ground, d, t["ink"]))
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
    bad = _resolve(t)
    assert not bad, "%s: %s" % (name, "; ".join(bad))


def test_default_is_the_accent_derived():
    """--gs-tab must resolve from the palette (accent default), no fixed
    hue anywhere — 'the accent colour needs to be from the skin's
    palette'. Declaration allowed only per-crate, never per-theme block."""
    css = open(CSS).read()
    decls = [l for l in css.splitlines() if l.strip().startswith("--gs-tab:")]
    assert decls and all("var(--accent)" in l for l in decls), decls
    ink_decls = [l for l in css.splitlines()
                 if l.strip().startswith("--gs-tab-ink:")]
    assert all("var(--bg)" in l for l in ink_decls), ink_decls


def test_vocab_carries_the_pair():
    assert {"gs-tab", "gs-tab-ink"} <= skins.COLOR_TOKENS


def test_section_titles_current():
    """GS-TAB grouping (user 2026-10-11): Server / Auth / Models / Resource
    Management / Integrations / Advanced — the spec titles and the en
    locale must agree, or tabs render stale labels."""
    js = open(os.path.join(ROOT, "omlx_uplift", "static",
                           "uplift_gsys.js")).read()
    heads = re.findall(r"\{t: '([^']+)'\}", js)
    heads = [h for h in heads if h != "Title"]          # doc-comment example
    want = ["Server", "Auth", "Models", "Resource Management",
            "Integrations", "Advanced"]
    assert heads == want, heads
    import json
    en = json.load(open(os.path.join(ROOT, "omlx_uplift", "locales",
                                     "en.json")))
    for h in want:
        slug = re.sub(r'^_|_$', '', re.sub(r'[^a-z0-9]+', '_', h.lower()))
        assert en.get("uplift.gs.title." + slug), "en.json missing title." + slug
