/* Zero-floor y-scale contract (2026-09-25 regression; TST-1 module port).

   U8 floored throughput/rate chart axes at 0 with range (u,dmin,dmax) =>
   [0, null]. uPlot (vendored v1.6.32) assigns the range() return values
   to scale.min/max VERBATIM in setScale — a null upper leaves the scale
   unset and the series is NEVER DRAWN: blank charts with working
   hover/legend values on every floored card (generation/prefill tok/s,
   rate.*, active requests). TST-1: ZERO_FLOOR_RANGE now ships in the UMD
   uplift_chartkit.js and is require()d — no source regex, no vm slice. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { STATIC_DIR } = require('./static-src.cjs');

const { ZERO_FLOOR_RANGE } = require(path.join(STATIC_DIR, 'uplift_chartkit.js'));
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

test('floored keys and metricZeroFloor stay in sync (no silent scope creep)', () => {
    // tps chart uses ZERO_FLOOR_RANGE directly; metric cards gate via
    // metricZeroFloor. Both were the regression surface — keep the gate.
    assert.match(src, /range:\s*ZERO_FLOOR_RANGE/,
        'y-range floor must ride through ZERO_FLOOR_RANGE (single point of truth)');
});
