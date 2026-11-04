/* UP-68 (option 5): feed classic's palette tokens from the skin you picked
   for the uplift board, so the embedded Chat / Bench / Cluster tabs stop
   showing classic's stock slate while the board wears a skin.

   Nothing in classic changes. Its own theme editor already works by writing
   a <style> of '--bg-primary: #rrggbb' declarations into <head>
   (custom_theme.js, STYLE_ID 'omlx-custom-theme'), and its theme.css reads
   those names off :root. We use that same supported surface, from the parent
   document into the frame document, which syncEmbedTheme() already reaches
   into for data-theme / data-enhanced-readability.

   Three rules keep it honest:
   - a token the USER set in classic's own theme editor wins; we never
     overwrite what <style id="omlx-custom-theme"> already declares;
   - a token the crate does not DECLARE is skipped, so classic keeps its
     stock value. This matters: uplift.css's default --good is near-white
     ink, not green, so inheriting an undeclared token would repaint classic
     with a colour the crate author never chose;
   - classic's own 4.5:1 floor is re-checked on the mapped set and a failing
     foreground is dropped. A skin ground paired with classic-derived ink can
     pass uplift's gates and still be unreadable on classic's surfaces.

   The VALUES come from the skins API entry (server-read from the crate),
   never from getComputedStyle: that is the SHEET-1 trap (a preview sheet
   that is live for 200ms then replaced), and it also means the bridge cannot
   freeze one skin's tokens into another skin's classic page.

   Pure data + pure functions (uplift_gspec.js pattern): the page and the
   node tests read the same definitions. DOM writes live in uplift.js. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftSkinBridge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* classic's editable tokens (custom_theme.js GROUPS, 6 groups). Pinned
   against a classic checkout by tests/skin-bridge.test.cjs — an upstream
   rename must fire THERE, not quietly drop a pair in here. */
const CLASSIC_TOKENS = [
    'bg-primary', 'bg-secondary', 'bg-tertiary',
    'text-primary', 'text-secondary', 'text-tertiary', 'text-muted',
    'border-faint', 'border-normal',
    'btn-primary', 'btn-primary-hover', 'btn-primary-text', 'switch-on',
    'focus-ring-color',
    'success', 'warning', 'danger', 'info',
    'timeline-accent', 'link-color', 'code-bg', 'text-danger',
];

/* [classic token, uplift crate token]. Deliberately only ground, ink,
   borders and the accent — the seam you actually see when a tab opens.
   Left stock on purpose:
   - success/warning/danger/info: classic means green/amber/red; uplift's
     --good/--warn/--bad are status GLYPH colours on the board and a crate may
     wear near-white or a franchise colour for them;
   - btn-primary / -hover / -text, switch-on, focus-ring-color: classic's
     action colour. A skin's accent is not necessarily a button ground, and
     the -text pair has to stay readable on whatever we pick;
   - text-tertiary / text-muted / text-danger / code-bg: uplift has no
     one-to-one counterpart, and flattening three ink steps into two reads
     worse in classic's dense tables than leaving the ladder alone. */
const CROSSWALK = [
    ['bg-primary', 'bg'],
    ['bg-secondary', 'card'],
    ['bg-tertiary', 'panel'],
    ['text-primary', 'ink'],
    ['text-secondary', 'dim'],
    ['border-faint', 'edge'],
    ['border-normal', 'edge'],
    ['link-color', 'accent'],
    ['timeline-accent', 'accent'],
];

/* Crate tokens the bridge may consume — must equal skins.py
   CLASSIC_BRIDGE_TOKENS, i.e. exactly what classic_palette() publishes into
   the API entry (tests/skin-bridge.test.cjs pins the pair). */
const CLASSIC_BRIDGE_TOKENS = ['bg', 'card', 'panel', 'ink', 'dim', 'edge', 'accent'];

/* classic's own floor (custom_theme.js CONTRAST_RULES), narrowed to the
   pairs this crosswalk can actually produce. */
const MIN_CONTRAST = 4.5;
const CONTRAST_RULES = [
    ['text-primary', ['bg-primary', 'bg-secondary', 'bg-tertiary']],
    ['text-secondary', ['bg-primary', 'bg-secondary', 'bg-tertiary']],
    ['link-color', ['bg-primary', 'bg-secondary', 'bg-tertiary']],
];

/* Our node + attribute. The scope selector is :root[<attr>] (specificity
   0,2,0) so it beats both classic's ':root' and its '[data-theme="dark"]'
   block (0,1,0 each) no matter where the node lands in <head>. */
const STYLE_ID = 'uplift-skin-bridge';
const SCOPE_ATTR = 'data-uplift-skin';
const CLASSIC_STYLE_ID = 'omlx-custom-theme';

/* -> '#rrggbb', or null when we cannot flatten to an OPAQUE hex. classic's
   sanitizer only accepts #rgb/#rrggbb, and an alpha ground over classic's
   own page is not a colour we can reason about, so alpha is dropped, not
   composited. */
function normalizeHex(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    let m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{8}$/.test(s)) return null;          // hex with alpha
    m = s.match(/^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
    if (!m) return null;
    if (m[4] !== undefined) {
        let a = parseFloat(m[4]);
        if (m[4].endsWith('%')) a /= 100;
        if (!(a >= 0.999)) return null;
    }
    const byte = x => {
        const n = Math.round(parseFloat(x));
        return (n < 0 ? 0 : n > 255 ? 255 : n).toString(16).padStart(2, '0');
    };
    return '#' + byte(m[1]) + byte(m[2]) + byte(m[3]);
}

function toRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)];
}

/* WCAG relative luminance — same math classic's sanitizer runs. */
function luminance(hex) {
    const lin = toRgb(hex).map(c => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* Which tokens the user already set in classic's own editor — parsed from
   the frame's <style id="omlx-custom-theme"> text, which is the single
   place classic commits them. */
function userSetTokens(cssText) {
    return new Set(Object.keys(userTokenValues(cssText)));
}

/* Same parse, keeping the VALUES: they take part in the contrast check
   below. A ground the operator owns and an ink we ship are one pair as far
   as the reader is concerned, so the pair has to clear the floor even
   though only one side came from us (live QA 2026-11-04: an operator
   '#334455' ground under a dark crate's ink measured 2.4:1 and nothing
   flagged it while the check only saw our own tokens). */
function userTokenValues(cssText) {
    const out = {};
    const s = String(cssText || '');
    const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(s))) {
        const hex = normalizeHex(m[2]);
        if (hex) out[m[1]] = hex;
        else if (!(m[1] in out)) out[m[1]] = null;   // set, but not a colour we can judge
    }
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
}

/* Drop anything that would fail classic's floor. Foregrounds go first: the
   grounds define the page, and a dropped ink falls back to classic's own
   readable value. A ground only goes when the failing foreground is the
   OPERATOR's, since that is the half we are allowed to withdraw. */
function filterContrast(vals, theirs) {
    const out = Object.assign({}, vals), other = theirs || {}, dropped = [];
    const eff = k => (k in out ? out[k] : (k in other ? other[k] : null));
    for (const [fg, grounds] of CONTRAST_RULES) {
        for (const g of grounds) {
            const a = eff(fg), b = eff(g);
            if (!a || !b) continue;
            const fgOurs = fg in out, gOurs = g in out;
            if (!fgOurs && !gOurs) continue;   // both the operator's: not ours to police
            if (contrast(a, b) + 1e-9 < MIN_CONTRAST) {
                const victim = fgOurs ? fg : g;
                delete out[victim];
                if (dropped.indexOf(victim) < 0) dropped.push(victim);
            }
        }
    }
    return { vals: out, dropped };
}

function buildCss(vals) {
    const decls = Object.keys(vals).sort()
        .map(k => '  --' + k + ': ' + vals[k] + ';').join('\n');
    if (!decls) return '';
    return ':root[' + SCOPE_ATTR + '] {\n' + decls + '\n}';
}

/* cls = the skins API entry's `classic` object ({theme, enhanced, colors,
   palette}). opts.stockText = the frame's <style id="omlx-custom-theme">
   text (the normal call: it gives both the skip list and the values the
   contrast check needs); opts.stock = a pre-parsed Set, for callers that
   only know which tokens are taken. */
function bridge(cls, opts) {
    const o = opts || {};
    if (!cls || cls.colors === false)
        return { css: '', vals: {}, dropped: [], reason: 'off' };
    const theirs = o.stockText != null ? userTokenValues(o.stockText)
                 : (o.theirs || {});
    let stock = o.stock;
    if (!(stock instanceof Set)) stock = new Set(Object.keys(theirs));
    const pal = cls.palette || {};
    const vals = {};
    for (const [ct, ut] of CROSSWALK) {
        if (ct in vals) continue;
        if (stock.has(ct)) continue;
        const hex = normalizeHex(pal[ut]);
        if (hex) vals[ct] = hex;
    }
    const r = filterContrast(vals, theirs);
    const css = buildCss(r.vals);
    return { css, vals: r.vals, dropped: r.dropped,
             reason: css ? '' : 'empty' };
}

return { CLASSIC_TOKENS, CROSSWALK, CLASSIC_BRIDGE_TOKENS, CONTRAST_RULES,
         MIN_CONTRAST,
         STYLE_ID, SCOPE_ATTR, CLASSIC_STYLE_ID,
         normalizeHex, toRgb, luminance, contrast, filterContrast,
         userSetTokens, userTokenValues, buildCss, bridge };
});
