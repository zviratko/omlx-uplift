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

/* SCALE-1 (user 2026-10-07): a zero floor is only honest where 0 is a
   meaningful reading. Temperature and resident-memory never approach 0 in
   normal operation — flooring them wastes the whole plot on dead space and
   flattens the line the user actually watches (measured on the live board:
   sys.memory pinned at the top edge of a 0..36 GB band). FLOAT_FLOOR_RANGE
   pads the data window by 12% and rounds outward so uPlot's nice-ticks
   land on whole numbers. Zero stays clamped as a floor: these units cannot
   go below it and a genuine 0 sample stays inside the band.
   PCT_FULL_RANGE pins percent cards to 0..100: efficiency at 3% must LOOK
   like 3% of the full scale, not 3/4 of an auto-fitted one.
   All three must return two FINITE numbers — a null bound leaves the uPlot
   scale unset and the series never draws (U8 regression, same trap). */
const FLOAT_PAD = 0.12;
function FLOAT_FLOOR_RANGE(u, dmin, dmax) {
    if (dmin == null || dmax == null) return [0, 1];
    if (dmax <= dmin) {
        if (dmax <= 0) return [0, 1];
        const half = Math.max(Math.abs(dmax) * 0.05, 1);
        return [Math.max(0, Math.floor(dmax - half)), Math.ceil(dmax + half)];
    }
    const pad = Math.max((dmax - dmin) * FLOAT_PAD, 1e-9);
    return [Math.max(0, Math.floor(dmin - pad)), Math.ceil(dmax + pad)];
}
const PCT_FULL_RANGE = () => [0, 100];

/* SCALE-1: the y-range policy for one metric card, decided from what the
   card's LEFT-axis keys can physically be (the right-hand y2 axis always
   carries a rate or a count and stays zero-floored at the call site).
   - every plotted series is fmt 'pct'  -> pinned 0..100 (cache efficiency,
     token-hit / lookup-hit %; legend-only series never draw and are out).
   - every key is a *_temp_c           -> floating (idle floor ~9..30 °C).
   - every key is sys/mem used|total_bytes -> floating (resident RAM never
     reads near 0; the ceiling line rides the same band).
   - anything else (rates, counts, tok/s, queue depth, per-rail watts that
     legitimately read 0 idle) -> the U8 zero floor.
   DOM-free by contract (TST-1): takes the crate def object, returns the
   range fn — the page and the node tests share this ONE decision. */
function metricYRange(def) {
    const sers = ((def.series && def.series.length) ? def.series : [def])
        .filter(s => !s.legendOnly && (!s.axis || s.axis === 'y'));
    if (!sers.length) return ZERO_FLOOR_RANGE;
    const keys = sers.map(s => s.key || '');
    const fmts = sers.map(s => s.fmt || def.fmt || '');
    if (fmts.every(f => f === 'pct')) return PCT_FULL_RANGE;
    if (keys.every(k => /_temp_c$/.test(k))) return FLOAT_FLOOR_RANGE;
    if (keys.every(k => /^(sys|mem)\.(used|total)_bytes$/.test(k))) return FLOAT_FLOOR_RANGE;
    return ZERO_FLOOR_RANGE;
}

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

/* LEGEND-1: last non-null value at or below `from` in a uPlot data column.
   The union x column (FAST-1) interleaves the 2 Hz live stamps and the 5 s
   stored stamps, so at any given row a series that did not sample at that
   stamp is null. Consumers with 'latest sample' semantics must scan to the
   column's OWN last non-null instead of reading one union row. */
function lastNonNull(col, from) {
    if (!col || !col.length) return null;
    let k = from === undefined ? col.length - 1 : Math.min(from, col.length - 1);
    for (; k >= 0; k--) if (col[k] !== null && col[k] !== undefined) return col[k];
    return null;
}

/* TSTAMP_MS: uPlot's opts.ms — the timestamp unit of the data columns
   (1 = milliseconds; its DEFAULT is 0.001 = seconds). Every x column we
   feed is ms-epoch (server ts * 1000, Date.now()), but with ms unset
   uPlot treats those stamps as SECONDS: a pinned 300 000 ms window reads
   as 300 000 s (3.5 days), the tick chooser picks spacings from the
   seconds table (43.2 s, 28.8 s...) that are NOT divisors of the real
   window, and as the pinned range slides every draw the tick count flips
   6↔7 — bottom-axis labels appear and disappear in a ~12-45 s cycle
   (live drill 2026-10-07: A/B on the running board, with ms:1 the tick
   set is stable and lands on clock 30 s boundaries). Reference this in
   EVERY uPlot opts; never hand-write ms: 1 at a call site. */
const TSTAMP_MS = 1;

return { AXIS_FONT_PX, AXIS_FONT_FALLBACK, axisFont, cssRgb, toHex2, tint,
         chartColors, SERIES_PALETTE_ORDER, SERIES_PALETTE_MAX, seriesPalette,
         ZERO_FLOOR_RANGE, FLOAT_FLOOR_RANGE, PCT_FULL_RANGE, metricYRange,
         GAP_BRIDGE_MS, gapBridge, TSTAMP_MS, lastNonNull };
});
