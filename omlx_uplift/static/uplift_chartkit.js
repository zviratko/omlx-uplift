/* TST-1: chart color/font/palette utilities as a UMD module (domkit/core
   pattern: module.exports in node, window global in the page). They used to
   live inside uplift_charts.js's IIFE, which forced tests to SLICE THE
   SOURCE TEXT between markers and vm-eval the region — every rename or
   reorder there broke a test that never tested behavior. Now tests
   require() this file and assert the functions directly.

   DOM-free on purpose: chartColors takes an optional token reader so node
   tests can feed CSS custom properties without a document. In the page,
   uplift_charts.js loads after this file and aliases the same names. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftChartkit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* Axis/legend type comes from the skin: chartColors() reads --mono and the
   axis helpers build canvas font strings from it, so a skin that ships a
   webfont restyles chart text too. The px size lives in ONE place; uPlot
   wants a full canvas font shorthand, a bare family would break it. */
const AXIS_FONT_PX = '9px';
const AXIS_FONT_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';
function axisFont(col) {
    const fam = (col && typeof col.font === 'string') ? col.font.trim() : '';
    return AXIS_FONT_PX + ' ' + (fam || AXIS_FONT_FALLBACK);
}
/* Skin tokens are CSS colors (skins.py accepts rgb()/hsl()/named values), so
   hex-alpha concatenation (col + '22') silently poisons canvas fillStyle and
   the path keeps the PREVIOUS fill. Parsed colors become rgba() with the same
   effective alpha (0x22 -> 13%, 0x1c -> 11%); pure hex keeps its exact old
   byte so no shipped skin shifts a single pixel. Unparseable values (named
   colors) fall back to color-mix() — modern canvas parses it, and it is
   never WORSE than the concatenation it replaces. */
function cssRgb(color) {
    if (typeof color !== 'string') return null;
    const c = color.trim();
    let m = c.match(/^#([0-9a-fA-F]{3})$/);
    if (m) { const h = m[1].split('').map(x => x + x);
             return [parseInt(h[0], 16), parseInt(h[1], 16), parseInt(h[2], 16), 1]; }
    m = c.match(/^#([0-9a-fA-F]{6})$/);
    if (m) { const h = m[1];
             return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
                     parseInt(h.slice(4, 6), 16), 1]; }
    m = c.match(/^(?:rgb|rgba)\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)(?:[,/\s]+([\d.]+%?))?\s*\)$/i);
    if (m) {
        const num = (v, max) => v.endsWith('%') ? parseFloat(v) / 100 * max : parseFloat(v);
        const a = m[4] === undefined ? 1 : num(m[4], 1);
        return [num(m[1], 255), num(m[2], 255), num(m[3], 255), Math.min(1, Math.max(0, a))];
    }
    m = c.match(/^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%(?:[,/\s]+([\d.]+%?))?\s*\)$/i);
    if (m) {
        const h = ((parseFloat(m[1]) % 360) + 360) % 360 / 360,
              s = Math.min(1, parseFloat(m[2]) / 100), l = Math.min(1, parseFloat(m[3]) / 100);
        const f = n => { const k = (n + h * 12) % 12;
            const a = s * Math.min(l, 1 - l);
            return 255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))); };
        const a = m[4] === undefined ? 1
            : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        return [f(0), f(8), f(4), Math.min(1, Math.max(0, a))];
    }
    return null;
}
const toHex2 = n => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
function tint(color, alphaHex) {
    if (!color) return color;
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color + alphaHex;
    if (/^#[0-9a-fA-F]{3}$/.test(color)) {
        const h = color.slice(1);
        return '#' + h.split('').map(c => c + c).join('') + alphaHex;
    }
    const rgb = cssRgb(color);
    if (rgb) {
        const a = (Math.round(parseInt(alphaHex, 16) / 255 * 100) / 100).toFixed(2);
        return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${a})`;
    }
    const pct = Math.round(parseInt(alphaHex, 16) / 2.55) + '%';
    return `color-mix(in srgb, ${color} ${pct}, transparent)`;
}
/* Skin token readout. In the page the reader is getComputedStyle on the
   root; tests pass their own map. --mono drives axis + legend text: a skin
   that ships a webfont and sets the mono token must restyle chart text too
   (it restyles everything else already). Unset -> '' and axisFont falls
   back to the fixed stack. */
function chartColors(read) {
    let v = read;
    if (!v) {
        if (typeof document === 'undefined') v = () => '';
        else {
            const cs = getComputedStyle(document.documentElement);
            v = n => cs.getPropertyValue(n).trim();
        }
    }
    return { dim: v('--dim') || '#a5a096',
             grid: v('--grid') || '#3a3b40',
             blue: v('--chart-1') || '#f2f0ea',
             gold: v('--chart-2') || '#e8a020',
             heat: v('--heat'),
             accent: v('--accent'),
             font: v('--mono') };   /* '' when unset -> axisFont() falls back */
}
/* Multi-series colour slots (U19/U20 cycle with i % length). The token set
   behind these is the skin's, so several often resolve to ONE value — the
   default theme ships chart-2 == heat == accent (signal amber) and nerv sets
   heat == chart-2 — so a naive 5-slot list re-wears colours while LOOKING
   like it has five. De-dupe, then top up with sRGB midpoints of slots already
   in play (plain hex output, no canvas feature needed): a 4-series card draws
   4 distinct strokes even on a collapsed-token theme, and every added colour
   is still a pure function of the skin, so it re-tints on skin change. `dim`
   trails the state colours as the honest neutral. A skin whose values cannot
   be parsed numerically keeps its smaller real palette — inventing contrast
   the skin refused to declare would be a lie. */
const SERIES_PALETTE_ORDER = ['blue', 'gold', 'heat', 'accent', 'dim'];
const SERIES_PALETTE_MAX = 5;
function seriesPalette(col) {
    const out = [];
    for (const k of SERIES_PALETTE_ORDER) {
        const c = col[k];
        if (!c) continue;
        if (!out.some(x => x.toLowerCase() === c.toLowerCase())) out.push(c);
    }
    const mid = (a, b) => {   // null when either side is opaque to us
        const x = cssRgb(a), y = cssRgb(b);
        if (!x || !y) return null;
        return '#' + [0, 1, 2].map(i => toHex2((x[i] + y[i]) / 2)).join('');
    };
    for (const [ai, bi] of [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]]) {
        if (out.length >= SERIES_PALETTE_MAX) break;
        if (out.length <= ai || out.length <= bi) continue;
        const c = mid(out[ai], out[bi]);
        if (c && !out.some(x => x.toLowerCase() === c)) out.push(c);
    }
    return out;
}
/* U8: throughput/counter axes start at 0. Auto-scaling to the data window
   exaggerated tiny wiggles; a zero floor is honest for rate/count units.
   NOT applied to memory % (already 0-100) or cache GB (auto remains
   useful — values legitimately sit far from 0). */
// uPlot assigns the range() return values to scale.min/max VERBATIM
// (setScale does e.max=n[1]) — a null upper means "unbounded" to nothing
// here: the scale stays null and the line is never drawn (2026-09-25:
// U8 shipped [0, null] and every floored chart drew grid-less blank
// while the legend/hover still showed values). Upper must be concrete;
// idle all-zero windows get a readable 0..1 band.
const ZERO_FLOOR_RANGE = (u, dmin, dmax) =>
    [0, (dmax == null || dmax <= 0) ? 1 : dmax * 1.05];

/* BUG-4 (user 2026-10-07: "holes in the graphs after our 2hz tick change"):
   FAST-1's union x column mixes ~500 ms live stamps with 5 s stored ones,
   so every 5 s-path series is ~10 nulls deep between its real points —
   and uPlot clips its (otherwise continuous) stroke at every null run.
   The fix bridges only CADENCE-sized holes: v1.6.32 hands the gap rects to
   a per-series gaps(self, si, i0, i1, gaps) callback before building the
   clip; we merge the chained [i0,i1] pairs into whole-hole spans and drop
   the SHORT ones, so the stroke survives across them. A hole longer than
   the cap keeps its clip rect — a stalled sampler or a metric that truly
   stopped being reported still shows a break (honest-absence doctrine:
   spanGaps:true would fabricate the same straight line across real
   outages, and nulls stay nulls — nothing is interpolated or forward-
   filled; the straight segment just joins two genuine samples). Cap:
   3 stored intervals + slack. */
const GAP_BRIDGE_MS = 12_000;
function gapBridge(maxGapMs) {
    const cap = Number.isFinite(maxGapMs) ? maxGapMs : GAP_BRIDGE_MS;
    return function (self, si, i0, i1, gaps) {
        if (!gaps || !gaps.length) return gaps;
        const xs = self && self.data && self.data[0];
        if (!xs || !xs.length) return gaps;
        const merged = [];
        for (const g of gaps) {
            const last = merged[merged.length - 1];
            if (last && g[0] === last[1]) last[1] = g[1];
            else merged.push([g[0], g[1]]);
        }
        // KEEP only spans we can MEASURE and that exceed the cap. Live
        // drill (2026-10-07) proved uPlot also calls this hook from draws
        // whose gap indices no longer fit self.data[0] (deferred path
        // rebuild after a setData swap) — those are unmeasurable, and
        // clipping them made the fix a no-op on the running board. An
        // out-of-range span drops for THIS draw only: the hole itself is
        // data, and the next consistent redraw re-derives it in range.
        return merged.filter(g => {
            const a = g[0], b = g[1];
            if (!(a >= 0 && b > a && b < xs.length)) return false;
            const ta = xs[a], tb = xs[b];
            if (!(Number.isFinite(ta) && Number.isFinite(tb))) return false;
            return tb - ta > cap;
        });
    };
}

return { AXIS_FONT_PX, AXIS_FONT_FALLBACK, axisFont, cssRgb, toHex2, tint,
         chartColors, SERIES_PALETTE_ORDER, SERIES_PALETTE_MAX, seriesPalette,
         ZERO_FLOOR_RANGE, GAP_BRIDGE_MS, gapBridge };
});
