/* BUG-4 (user 2026-10-07): after FAST-1 the chart x column is the UNION of
   the 2 Hz live stamps and the 5 s stored stamps, so a 5 s-path series
   (cached tok/s, memory ceilings, hot cache, un-live'd metric-card keys)
   sits ~10 nulls deep between its real points — uPlot clipped a visible
   break at every run (browser drill: cached line 142/205 nulls, max run
   112 ≈ 70 s of nothing but cadence). The gapBridge() uPlot gaps-callback
   merges chained [i0,i1] pairs into whole-hole spans and drops the SHORT
   ones from the clip list, so the stroke bridges cadence holes; a hole
   longer than the cap keeps its clip (a real stall must still break).
   The chartkit is a require()-able UMD (TST-1) — assert the function
   directly. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { gapBridge, GAP_BRIDGE_MS } =
    require(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chartkit.js'));

/* uPlot calls gaps(self, si, i0, i1, gaps) with chained [i0,i1] PAIRS per
   index inside the hole (live spy on the running board, 2026-10-07):
   [[494,495],[495,496],[496,498],...] */
function chainedNullRun(xs, runs) {
    // runs: [startIdx, endIdxInclusiveNulls] pairs -> uPlot-style pairs
    const out = [];
    for (const [a, b] of runs)
        for (let i = a; i < b; i++) out.push([i, i + 1]);
    return out;
}

test('gapBridge: cadence run (5 s points on a ~0.6 s column) bridges', () => {
    const step = 600, gap = 10;          // 10 x 600 ms ≈ 6 s hole in stamps
    const xs = [], vals = [];
    for (let i = 0; i < 200; i++) xs.push(i * step);
    for (let i = 0; i < 200; i++) vals.push(Math.floor(i / (gap + 1)) * (gap + 1) === i ? 1 : null);
    const self = { data: [xs, vals] };
    const gaps = chainedNullRun(xs, [[1, 11], [12, 22], [23, 33]]);
    const kept = gapBridge(GAP_BRIDGE_MS)(self, 1, 0, 199, gaps);
    assert.deepStrictEqual(kept, [], 'all three ~6 s cadence holes bridged');
});

test('gapBridge: a genuine stall keeps its clip rect', () => {
    const step = 600;
    const xs = [];
    for (let i = 0; i < 400; i++) xs.push(i * step);
    const self = { data: [xs, []] };
    // one hole 20..120 = 100 steps × 0.6 s = 60 s ≫ cap
    const gaps = chainedNullRun(xs, [[20, 120]]);
    const kept = gapBridge(GAP_BRIDGE_MS)(self, 1, 0, 399, gaps);
    assert.strictEqual(kept.length, 1, 'long stall survives the filter');
    assert.deepStrictEqual(kept[0], [20, 120], 'merged span kept whole');
});

test('gapBridge: mixed cadence + stall — only the stall clips', () => {
    const step = 600;
    const xs = [];
    for (let i = 0; i < 400; i++) xs.push(i * step);
    const self = { data: [xs, []] };
    const gaps = chainedNullRun(xs, [[10, 20],        // 6 s cadence
                                     [50, 150],       // 60 s stall
                                     [200, 208]]);    // ~4.8 s cadence
    const kept = gapBridge(GAP_BRIDGE_MS)(self, 1, 0, 399, gaps);
    assert.deepStrictEqual(kept, [[50, 150]], 'only the stall keeps its clip');
});

test('gapBridge: custom cap via argument; default exported', () => {
    const xs = [0, 5000, 10000, 15000, 20000];
    const self = { data: [xs, []] };
    const gaps = [[0, 1], [1, 2], [2, 3]];           // one merged 15 s span
    assert.deepStrictEqual(gapBridge(12000)(self, 1, 0, 4, gaps), [[0, 3]]);
    assert.deepStrictEqual(gapBridge(30000)(self, 1, 0, 4, gaps), [], 'above cap: bridged');
    assert.strictEqual(GAP_BRIDGE_MS, 12000);
});

test('gapBridge: empty/absent gap lists pass through; unmeasurable stays clipped', () => {
    const noop = gapBridge();
    assert.deepStrictEqual(noop({ data: [[0], []] }, 1, 0, 0, []), []);
    assert.strictEqual(noop({ data: [[0], []] }, 1, 0, 0, null), null);
    // x column shorter than the span indices → cannot size the hole → clip
    const self = { data: [[0, 1000], []] };
    assert.deepStrictEqual(noop(self, 1, 0, 5, [[1, 9]]), [[1, 9]]);
});
