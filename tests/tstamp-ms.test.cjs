/* TSTAMP-MS (user 2026-10-07): bottom-axis tick labels periodically
   appeared and disappeared. Root cause: every chart feeds uPlot
   MILLISECOND x columns but no opts set `ms`, and uPlot's default is
   ms = 0.001 ("seconds"). A pinned 300 000 ms window therefore read as
   300 000 SECONDS (3.5 days): the tick chooser picked spacings from the
   seconds table (43.2 s on Throughput, 28.8 s on Memory — live probe
   `_found=[43200, 68.544]`) that do not divide the real window, so as
   the pinned range slid each draw the tick count flipped 6↔7 (10↔11 on
   the memory card). A/B on the running board: identical data, one chart
   with ms:1 — without: 8 tick-count state changes in 95 s; with: stable,
   ticks on clock 30 s boundaries.

   The unit fact is testable without a browser: the vendored build must
   keep reading opts.ms (default .001), the chartkit must export
   TSTAMP_MS = 1, and EVERY uPlot opts construction must carry it. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const KIT = require(path.join(STATIC_DIR, 'uplift_chartkit.js'));
const chartsSrc = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
const vendorSrc = fs.readFileSync(path.join(STATIC_DIR, 'vendor', 'uPlot.min.js'), 'utf8');

test('chartkit exports TSTAMP_MS = 1 (uPlot ms-timestamp unit)', () => {
    assert.strictEqual(KIT.TSTAMP_MS, 1,
        'uPlot opts.ms = 1 means the data columns are ms-epoch — the only ' +
        'unit our x columns are ever built in (ts * 1000 / Date.now())');
});

test('vendored uPlot still defaults ms to 0.001 (the trap stays live)', () => {
    // uPlot reads the option as `X = opts.ms || .001` (minified name may
    // drift; the literal is the contract). If the default ever becomes 1
    // upstream, this test says so — the TSTAMP_MS option stays correct either way.
    assert.match(vendorSrc, /\.ms\|\|\.001/,
        'vendor no longer shows the .001 default — re-check whether ms:1 ' +
        'is still required (or still harmless) on this uPlot version');
});

test('every uPlot opts in uplift_charts.js carries ms: KIT.TSTAMP_MS', () => {
    // Three opts BUILDERS own all five `new uPlot(` sites:
    //   baseOpts()   -> tpsChart, memChart
    //   metricOpts() -> metric cards (create + reinit)
    //   the usageChart literal in createUsageChart()
    const builders = [
        ['baseOpts',   /function baseOpts\(specs, axes, legendHook\) \{[\s\S]*?\n\}/],
        ['metricOpts', /function metricOpts\(id, def, col\) \{[\s\S]*?\n\}/],
        ['usageChart', /usageChart = new uPlot\(\{[\s\S]*?\}, \[\[\], \[\]\], el\)/],
    ];
    let carriers = 0;
    for (const [name, re] of builders) {
        const m = chartsSrc.match(re);
        assert.ok(m, `${name} builder not found — update this test with it`);
        assert.match(m[0], /ms:\s*KIT\.TSTAMP_MS/,
            `${name} must set ms: KIT.TSTAMP_MS — ms-epoch columns on the ` +
            `default 0.001 unit make the x-axis tick count flip as the ` +
            `pinned range slides (the 2026-10-07 flicker)`);
        carriers++;
    }
    // No new opts may appear outside the guarded builders: count the
    // construction sites and the carriers they must come from.
    const sites = (chartsSrc.match(/new uPlot\(/g) || []).length;
    assert.strictEqual(sites, 5,
        'five construction sites expected (tps, mem, metric create/reinit, usage); ' +
        'a sixth needs its own ms coverage — add its builder above');
    assert.strictEqual(carriers, 3, 'each guarded builder must contribute its ms');
    // every site takes opts from a guarded builder or the guarded literal
    const optsRefs = [...chartsSrc.matchAll(/new uPlot\(\s*([A-Za-z_][\w.]*)/g)].map(m => m[1]);
    for (const ref of optsRefs) {
        if (ref === 'usageChart') continue;                       // literal form (no identifier arg)
        assert.ok(/tpsOpts|memOpts|metricOpts/.test(ref),
            `new uPlot(${ref}) is not covered by a builder this test guards`);
    }
});
