/* SMOOTH-3: the stacked-MTP rendering contract (user 2026-10-10).
   The vendored uPlot has no native stack: a def with stack:true feeds
   CUMULATIVE columns and fills opts.bands between them. This pins the
   two pure helpers (chartkit) and the card def they serve. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const KIT = require(path.join(STATIC_DIR, 'uplift_chartkit.js'));
const C = require(path.join(STATIC_DIR, 'core.js'));
const { stackCumulative, stackBands } = KIT;

test('stackCumulative sums band-wise and keeps the top at the total', () => {
    const cum = stackCumulative([[20, 0], [40, 30], [30, 60], [0, 10], [10, 0]]);
    assert.deepEqual(cum[0], [20, 0]);
    assert.deepEqual(cum[1], [60, 30]);
    assert.deepEqual(cum[2], [90, 90]);
    assert.deepEqual(cum[3], [90, 100]);
    assert.deepEqual(cum[4], [100, 100]);
});

test('stackCumulative treats absence honestly at every level', () => {
    const cum = stackCumulative([[10, null, 5], [10, 20, null]]);
    assert.deepEqual(cum[0], [10, null, 5]);
    // col 1, row 1: the band above is 20 tall but the band below is
    // unknown at this x — it draws from the floor (run restarts at the
    // null), never from a fabricated partial sum.
    // col 2, row 2: this band is itself missing -> null.
    assert.deepEqual(cum[1], [20, 20, null]);
});

test('stackBands pairs consecutive uPlot series 1-based', () => {
    assert.deepEqual(stackBands(1), []);
    assert.deepEqual(stackBands(3), [{ series: [1, 2], dir: 1 }, { series: [2, 3], dir: 1 }]);
    assert.equal(stackBands(5).length, 4);
});

test('the MTP acceptance card is a floating stacked-depth ladder', () => {
    const mtp = C.EXPLORE_METRICS.find(m => m.key === 'mtp.accept_pct');
    assert.ok(mtp.stack, 'def must opt into stacked rendering');
    const drawn = mtp.series.filter(s => !s.legendOnly).map(s => mtp.series.indexOf(s));
    // NO cyc0 (rejected) band: with it the stack is a full partition of
    // cycles glued to 100% forever (user: 'it shouldn't always add to
    // 100%'). The drawn bands are the accepted DEPTHS only.
    const drawnKeys = mtp.series.filter(s => !s.legendOnly && /^mtp\.cyc/.test(s.key)).map(s => s.key);
    assert.deepEqual(drawnKeys, ['mtp.cyc1_pct', 'mtp.cyc2_pct',
                                  'mtp.cyc3_pct', 'mtp.cyc4p_pct'],
        'depths 1..4+ stack; rejected band dropped so top edge floats');
    // SCALE-1: a pct card pins 0..100 — the stack floats BELOW 100 inside
    // that band (top edge = acceptance), never glues to the ceiling.
    assert.equal(KIT.metricYRange(mtp), KIT.PCT_FULL_RANGE);
    // top edge (last drawn band) is the acceptance ceiling = top cumulative
    assert.ok(mtp.series.some(s => s.key === 'mtp.cyc4p_pct'), 'top band present');
});

/* LIVE-READ + COLOR-1 (user 2026-10-10): the stacked card must show
   values anywhere the mouse sits, and the bands must be a readable ramp.
   The helpers are chartkit-pure (DOM-free) — same contract as the stack
   ones; the last test pins the static call sites in uplift_charts.js. */
test('nearestSample bridges cadence nulls within the cap', () => {
    const ts = [0, 500, 1000, 1500, 2000, 2500];   // ms stamps
    // a 5 s series on a 2 Hz union column: value at row 0, null after
    const col = [42, null, null, null, null, null];
    assert.equal(KIT.nearestSample(col, ts, 0), 42);
    assert.equal(KIT.nearestSample(col, ts, 1), 42);    // 0.5 s back: take it
    assert.equal(KIT.nearestSample(col, ts, 2), 42);    // 1.0 s: inside cap
    assert.equal(KIT.nearestSample(col, ts, 3), 42);    // 1.5 s: inside cap
    assert.equal(KIT.nearestSample(col, ts, 5, 12_000), 42);   // 2.5 s: < 12 s
    // same column under a tight cap: beyond 1.5 s the hole is REAL
    assert.equal(KIT.nearestSample(col, ts, 5, 1_000), null);
});

test('nearestSample snaps forward too, and honits its guards', () => {
    const ts = [0, 1_000, 2_000];
    assert.equal(KIT.nearestSample([null, null, 9], ts, 1, 12_000), 9);
    assert.equal(KIT.nearestSample(null, ts, 0), null);
    assert.equal(KIT.nearestSample([1], ts, null), null);
    assert.equal(KIT.nearestSample([1], ts, 5), null);   // idx out of range
});

test('rampColor is a strong→light skin ramp of the band slot', () => {
    // dark card ground, amber slot: bottom band = slot at full strength
    const a = KIT.rampColor('#e8a020', '#2b2c30', 5, 0);
    assert.equal(a, 'rgba(232,160,32,0.80)', 'band 0 = raw slot, alpha 0.80');
    const alpha = s => parseFloat(s.match(/,(0\.\d+)\)$/)[1]);
    const b = KIT.rampColor('#e8a020', '#2b2c30', 5, 2);
    const c = KIT.rampColor('#e8a020', '#2b2c30', 5, 4);
    assert.ok(alpha(b) < alpha(a) && alpha(c) < alpha(b), 'alpha steps down');
    // later bands mix toward the ground: brightness follows the GROUND,
    // never a fixed bias (light grounds must not invert the ramp)
    const rgbSum = s => s.match(/\d+/g).slice(0, 3).reduce((x, y) => x + +y, 0);
    assert.ok(rgbSum(KIT.rampColor('#e8a020', '#ffffff', 5, 4))
              > rgbSum(KIT.rampColor('#e8a020', '#ffffff', 5, 0)),
        'on a light ground upper bands brighten toward white');
    assert.ok(rgbSum(KIT.rampColor('#e8a020', '#0a0a0a', 5, 4))
              < rgbSum(KIT.rampColor('#e8a020', '#0a0a0a', 5, 0)),
        'on a dark ground upper bands darken toward the ground');
    // unparseable slot: honest passthrough, never a crash
    assert.equal(KIT.rampColor('currentColor', '#2b2c30', 5, 1), 'currentColor');
});

test('COLOR-1/LIVE-READ call sites are wired in uplift_charts.js', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
    assert.match(src, /\?\s*rampAt\(0\)/, 'bottom band uses the ramp');
    assert.match(src, /fill:\s*rampAt\(i \+ 1\)/, 'upper bands use the ramp');
    assert.match(src, /KIT\.nearestSample\(colData, src, i\)/,
        'legendUpdater snaps a null hovered row to the nearest sample');
    assert.match(src, /KIT\.nearestSample\(scol, c\.data\[0\], i\)/,
        'the hover tip does the same');
});
