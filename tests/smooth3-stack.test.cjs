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

test('the MTP acceptance card is the stacked cycle-outcome distribution', () => {
    const mtp = C.EXPLORE_METRICS.find(m => m.key === 'mtp.accept_pct');
    assert.ok(mtp.stack, 'def must opt into stacked rendering');
    const drawn = mtp.series.filter(s => !s.legendOnly).map(s => s.key);
    assert.deepEqual(drawn, ['mtp.cyc0_pct', 'mtp.cyc1_pct', 'mtp.cyc2_pct',
                             'mtp.cyc3_pct', 'mtp.cyc4p_pct']);
    assert.ok(drawn.every(k => /^mtp\.cyc/.test(k)), 'only cycle-share keys draw');
    // SCALE-1: a pct card pins 0..100 — the cumulative stack tops at 100
    assert.equal(KIT.metricYRange(mtp), KIT.PCT_FULL_RANGE);
});
