/* Zero-floor y-scale contract (2026-09-25 regression; TST-1 module port;
   SCALE-1 policy split 2026-10-07).

   U8 floored throughput/rate chart axes at 0 with range (u,dmin,dmax) =>
   [0, null]. uPlot (vendored v1.6.32) assigns the range() return values
   to scale.min/max VERBATIM in setScale — a null upper leaves the scale
   unset and the series is NEVER DRAWN: blank charts with working
   hover/legend values on every floored card (generation/prefill tok/s,
   rate.*, active requests). TST-1: ZERO_FLOOR_RANGE now ships in the UMD
   uplift_chartkit.js and is require()d — no source regex, no vm slice.

   SCALE-1 (user 2026-10-07): a zero floor is a LIE for series that can
   never approach 0 — temperature idles at ~30 °C, resident memory at GiB
   — and the honest full scale is mandatory for percentages: cache
   efficiency at 3% must read as 3% of 100, not as the top half of the
   window. The policy is one pure DOM-free function, metricYRange(def),
   pinned here against the REAL EXPLORE_METRICS defs so a future card
   cannot silently inherit the wrong band. node --test tests/chart-zero-floor.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { STATIC_DIR } = require('./static-src.cjs');

const KIT = require(path.join(STATIC_DIR, 'uplift_chartkit.js'));
const { ZERO_FLOOR_RANGE, FLOAT_FLOOR_RANGE, PCT_FULL_RANGE, metricYRange } = KIT;
const C = require(path.join(STATIC_DIR, 'core.js'));
const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');

for (const [name, dmin, dmax] of [
    ['real data', 0, 56],
    ['all-zero idle window', 0, 0],
    ['no data yet', null, null],
    ['negative dip', -2, 12],
]) test(`ZERO_FLOOR_RANGE(${name}) returns two finite numbers`, () => {
    const [lo, hi] = ZERO_FLOOR_RANGE(null, dmin, dmax);
    // uPlot: scales.y.range = () => [lo, hi]; assigning a null bound
    // leaves the plot unpainted (blank-chart regression).
    assert.ok(Number.isFinite(lo), `lower bound must be finite, got ${lo}`);
    assert.ok(Number.isFinite(hi), `upper bound must be finite, got ${hi}`);
    assert.ok(lo === 0, `floor must stay at 0, got ${lo}`);
    assert.ok(hi > lo, 'upper bound must exceed the floor');
});

for (const [name, dmin, dmax] of [
    ['idle temp band', 29.4, 32.2],
    ['flat single value', 30, 30],
    ['all-zero idle window', 0, 0],
    ['no data yet', null, null],
    ['GiB-scale memory', 13.6e9, 13.7e9],
]) test(`FLOAT_FLOOR_RANGE(${name}) returns two finite, ordered numbers`, () => {
    const [lo, hi] = FLOAT_FLOOR_RANGE(null, dmin, dmax);
    assert.ok(Number.isFinite(lo) && Number.isFinite(hi),
        `both bounds must be finite, got [${lo}, ${hi}]`);
    assert.ok(hi > lo, `upper ${hi} must exceed lower ${lo}`);
    assert.ok(lo >= 0, `a physical floor of 0 must be clamped, got ${lo}`);
});

test('FLOAT_FLOOR_RANGE actually floats: a 29..32 °C window does NOT start at 0', () => {
    const [lo, hi] = FLOAT_FLOOR_RANGE(null, 29.4, 32.2);
    assert.ok(lo > 25 && lo < 30, `floor should hug the data, got ${lo}`);
    assert.ok(hi > 32 && hi < 36, `ceiling should pad the data, got ${hi}`);
});

test('PCT_FULL_RANGE is the flat 0..100 band', () => {
    assert.deepEqual(PCT_FULL_RANGE(null, 0, 0), [0, 100]);
    assert.deepEqual(PCT_FULL_RANGE(null, 41, 58), [0, 100]);
});

/* ---------------- SCALE-1: the per-card policy ---------------- */
const defByKey = new Map(C.EXPLORE_METRICS.map(m => [m.key, m]));
function band(key) { return metricYRange(defByKey.get(key)); }

test('every EXPLORE_METRICS card exists in the policy table', () => {
    for (const m of C.EXPLORE_METRICS) assert.ok(m.key, 'card def without key');
});

for (const key of ['cache_efficiency', 'pfx.token_hit_pct', 'pfx.lookup_hit_pct'])
    test(`percent card ${key} pins the full 0..100 scale`, () => {
        assert.equal(band(key), PCT_FULL_RANGE);
    });

for (const key of ['therm.cpu_temp_c', 'sys.used_bytes'])
    test(`card ${key} floats (0 is unreachable and wastes the plot)`, () => {
        assert.equal(band(key), FLOAT_FLOOR_RANGE);
    });

for (const key of ['avg_generation_tps', 'rate.completion_tokens_s', 'rate.prompt_tokens_s',
                   'rate.requests_s', 'spec.saved_tokens_min', 'queue.waiting', 'pwr.total_w'])
    test(`card ${key} keeps the U8 zero floor (0 is a real reading)`, () => {
        assert.equal(band(key), ZERO_FLOOR_RANGE);
    });

test('legendOnly and y2 series do not vote on the left-axis band', () => {
    // pfx.token_hit_pct card: pct area on y + tok/s rate on y2 + legend-only pct
    assert.equal(band('pfx.token_hit_pct'), PCT_FULL_RANGE,
        'the y2 tok/s line must not drag the pct card off 0..100');
    assert.equal(band('pfx.lookup_hit_pct'), PCT_FULL_RANGE,
        'restored_tokens_min on y2 is not a left-axis voter');
    // a card whose ONLY pct series is legend-only must not pin 0..100
    assert.equal(metricYRange({ key: 'x', series: [
        { key: 'rate.foo' }, { key: 'pfx.saved_tokens_min', fmt: 'pct', legendOnly: true },
    ] }), ZERO_FLOOR_RANGE);
});

test('the left axis routes through metricYRange and y2 keeps the floor (single source)', () => {
    assert.match(src, /y:\s*\{\s*auto:\s*true,\s*range:\s*metricYRange\(def\)\s*\}/,
        'metricOpts must route the LEFT axis through the chartkit policy');
    assert.match(src, /y2\s*=\s*\{\s*auto:\s*true,\s*range:\s*ZERO_FLOOR_RANGE\s*\}/,
        'y2 (rates/counts/RPM) stays zero-floored at the call site');
    assert.ok(!/metricZeroFloor/.test(src),
        'the old blanket metricZeroFloor gate must not return (it floored EVERYTHING)');
    assert.match(src, /range:\s*ZERO_FLOOR_RANGE/,
        'the big charts keep the U8 floor via ZERO_FLOOR_RANGE (blank-chart contract)');
});
