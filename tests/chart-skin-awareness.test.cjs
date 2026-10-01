/* SPARK-1: charts must be fully skin-aware.

   Three verified gaps closed here, each with a behavioral assert:
   1. axis font came from a hardcoded constant -> now built from --mono.
   2. area fills used hex-alpha CONCATENATION (col + '22'). The skin
      validator accepts function colors (skins.py _FUNC_RE), so a crate with
      `chart-1: rgb(0 255 128)` produced 'rgb(0 255 128)22' — an invalid
      canvas fillStyle the browser silently ignores, leaving the path in the
      PREVIOUS fill. tint() keeps hex byte-identical and routes everything
      else through color-mix().
   3. the multi-series palette had 3 slots while the token set has more
      colors; seriesPalette() extends it AND de-dupes, because the default
      theme ships chart-2 == heat == accent (signal amber) — a naive 5-slot
      list re-wears colors while looking like it has five.

   Evaluates the REAL source region, same pattern as chart-zero-floor.test.cjs.
   node --test tests/chart-skin-awareness.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');

// Extract the self-contained skin-color region: AXIS_FONT_PX .. seriesPalette.
const start = src.indexOf('const AXIS_FONT_PX');
assert.ok(start >= 0, 'AXIS_FONT_PX must be defined in uplift_charts.js');
const palStart = src.indexOf('function seriesPalette');
assert.ok(palStart > start, 'seriesPalette() must follow the font/tint helpers');
const palEnd = src.indexOf('\n}\n', palStart);
assert.ok(palEnd > palStart, 'seriesPalette() body must terminate');
const region = src.slice(start, palEnd + 3);
assert.ok(region.includes('function chartColors') && region.includes('function tint'),
    'region must span chartColors + tint + seriesPalette (extraction moved — update this test)');

const ctx = {};
vm.runInNewContext(region + `
this.AXIS_FONT_PX = AXIS_FONT_PX;
this.AXIS_FONT_FALLBACK = AXIS_FONT_FALLBACK;
this.axisFont = axisFont;
this.tint = tint;
this.SERIES_PALETTE_ORDER = SERIES_PALETTE_ORDER;
this.seriesPalette = seriesPalette;`, ctx);

/* ---------------- gap 1: skin mono font into the axes ---------------- */

test('axisFont() uses the skin --mono when declared', () => {
    const f = ctx.axisFont({ font: '"IBM Plex Mono", monospace' });
    assert.equal(f, '9px "IBM Plex Mono", monospace');
    assert.match(f, /^9px\s/, 'canvas font shorthand must keep the px size');
});

test('axisFont() falls back to the old stack when --mono is unset', () => {
    assert.equal(ctx.axisFont({}), ctx.AXIS_FONT_PX + ' ' + ctx.AXIS_FONT_FALLBACK);
    assert.equal(ctx.axisFont({ font: '   ' }),
        ctx.AXIS_FONT_PX + ' ' + ctx.AXIS_FONT_FALLBACK);
    assert.equal(ctx.axisFont(undefined),
        ctx.AXIS_FONT_PX + ' ' + ctx.AXIS_FONT_FALLBACK);
});

test('every axis/legend font site goes through axisFont(col)', () => {
    // a surviving bare `font: axisFont` (no call) hands uPlot a FUNCTION as a
    // font string and silently loses the skin type — same bug, new shape.
    const bare = [...src.matchAll(/font:\s*axisFont(?!\s*\()/g)];
    assert.deepEqual(bare.map(m => m[0]), [], 'un-called axisFont reference left');
    assert.ok(!/labels:\s*\{\s*fontSize/.test(src),
        'legend.labels.fontSize is dead in vendored uPlot 1.6 — must not return');
});

/* ---------------- gap 2: non-hex tokens must not poison fills --------- */

test('tint() keeps pure hex byte-identical to the old behaviour', () => {
    assert.equal(ctx.tint('#f2f0ea', '22'), '#f2f0ea22');
    assert.equal(ctx.tint('#e8a020', '1c'), '#e8a0201c');
    assert.equal(ctx.tint('#abc', '22'), '#aabbcc22', '3-digit hex expands');
});

test('tint() turns function colors into rgba, never concatenation', () => {
    // rgb/hsl parse -> plain rgba(), alpha preserved (0x22 -> 0.13)
    assert.equal(ctx.tint('rgb(0 255 128)', '22'), 'rgba(0, 255, 128, 0.13)');
    assert.equal(ctx.tint('rgb(0 255 128)', '1c'), 'rgba(0, 255, 128, 0.11)');
    assert.equal(ctx.tint('rgba(0, 255, 128, 0.5)', '22'), 'rgba(0, 255, 128, 0.13)');
    assert.equal(ctx.tint('#abc', '22'), '#aabbcc22');
    const hsl = ctx.tint('hsl(120, 100%, 50%)', '22');
    assert.match(hsl, /^rgba\(\d+, \d+, \d+, 0\.13\)$/, 'hsl must become rgba: ' + hsl);
    for (const out of [hsl, 'rgba(0, 255, 128, 0.13)']) {
        assert.ok(!/\)[0-9a-fA-F]{2}\b/.test(out), 'no hex alpha glued to a color: ' + out);
    }
});

test('tint() falls back to color-mix for colors it cannot parse', () => {
    for (const c of ['transparent', 'currentcolor', 'rebeccapurple']) {
        const out = ctx.tint(c, '22');
        assert.ok(!out.startsWith(c + '22'), `${c}: must not be concatenated`);
        assert.match(out, /^color-mix\(in srgb, .+ 13%, transparent\)$/,
            `${c}: expected color-mix, got ${out}`);
    }
});

test('no hex-alpha concatenation survives in the chart source', () => {
    // comments describe the old bug; scan code only
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders = [...code.matchAll(/\b\w+\s*\+\s*'[0-9a-fA-F]{2}'/g)].map(m => m[0]);
    assert.deepEqual(offenders, [],
        'string-concat alpha is the SPARK-1 poisoning bug; route through tint()');
});

test('both fill sites call tint()', () => {
    assert.match(src, /fill:\s*fill\s*\?\s*tint\(col,\s*'22'\)/,
        'line() area fill must use tint()');
    assert.match(src, /fill:[^\n]*\?\s*tint\(c,\s*'1c'\)/,
        'metricOpts() area fill must use tint()');
});

/* ---------------- gap 3: multi-series palette ------------------------- */

test('seriesPalette() de-dupes identical token values', () => {
    // default theme reality: chart-2 == heat == accent (signal amber)
    const defaultish = { blue: '#f2f0ea', gold: '#e8a020', heat: '#e8a020',
                         accent: '#e8a020', dim: '#a5a096' };
    const p = ctx.seriesPalette(defaultish);
    // the three REAL token colours come first, in token order
    assert.deepEqual(p.slice(0, 3), ['#f2f0ea', '#e8a020', '#a5a096']);
    assert.equal(new Set(p.map(x => x.toLowerCase())).size, p.length,
        'palette must never hand two series the same colour');
});

test('seriesPalette() tops a collapsed theme up to 5 distinct slots', () => {
    const defaultish = { blue: '#f2f0ea', gold: '#e8a020', heat: '#e8a020',
                         accent: '#e8a020', dim: '#a5a096' };
    const p = ctx.seriesPalette(defaultish);
    assert.equal(p.length, 5, 'topped-up slots (midpoints) must reach 5');
    assert.match(p[3], /^#[0-9a-f]{6}$/, 'topped slot must be plain hex (canvas-safe)');
    const strokes = [0, 1, 2, 3].map(i => p[i % p.length]);
    assert.equal(new Set(strokes).size, 4, 'a 4-series card must draw 4 distinct strokes');
});

test('seriesPalette() returns exactly the token colours for a rich skin', () => {
    const rich = { blue: '#111111', gold: '#222222', heat: '#333333',
                   accent: '#444444', dim: '#555555' };
    const p = ctx.seriesPalette(rich);
    assert.equal(p.length, 5, 'order must be chart-1, chart-2, heat, accent, dim');
    assert.deepEqual(p, ['#111111', '#222222', '#333333', '#444444', '#555555']);
    const strokes = [0, 1, 2, 3].map(i => p[i % p.length]);
    assert.equal(new Set(strokes).size, 4);
});

test('seriesPalette() skips missing tokens and keeps dim in token order', () => {
    const noHeat = { blue: '#111111', gold: '#222222', heat: '', accent: '#444444', dim: '#555555' };
    const p = ctx.seriesPalette(noHeat);
    assert.deepEqual(p.slice(0, 4), ['#111111', '#222222', '#444444', '#555555']);
    const last = ctx.SERIES_PALETTE_ORDER[ctx.SERIES_PALETTE_ORDER.length - 1];
    assert.equal(last, 'dim', 'dim is the honest neutral and must trail state colours');
});

test('seriesPalette() never invents colour it cannot compute', () => {
    // named/unparseable colors: real slots only, no fabricated midpoint
    const named = { blue: 'white', gold: 'orange', heat: 'orange',
                    accent: 'orange', dim: 'gray' };
    const p = ctx.seriesPalette(named);
    assert.deepEqual(p, ['white', 'orange', 'gray']);
});

test('metricOpts() takes the palette from seriesPalette()', () => {
    assert.match(src, /const palette = seriesPalette\(col\);/);
    assert.ok(!/const palette = \[col\.blue, col\.gold, col\.dim\]/.test(src),
        'the 3-slot literal is the bug SPARK-1 fixes; it must stay gone');
});

/* ---------------- constraints the ticket set -------------------------- */

test('uPlot stays the vendored canvas renderer; single re-tint path', () => {
    // no SVG mode, no second theme listener added by this ticket
    assert.ok(!/mode:\s*['"]svg['"]/.test(src), 'SVG mode is off-limits');
    const vendor = fs.readFileSync(path.join(STATIC_DIR, 'vendor', 'uPlot.min.js'), 'utf8');
    assert.match(vendor, /v1\.6\.32/, 'vendor file must stay at 1.6.32');
    const listeners = [...src.matchAll(/addEventListener\(\s*['"]change['"]/g)].length;
    assert.equal(listeners, 0, 'rerenderChartsTheme() is the only re-tint path');
});
