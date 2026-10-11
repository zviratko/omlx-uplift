/* LIVE-UNION-1 (user 2026-10-11: MTP card "it updates at 2hz but doesn't
   have 2hz samples... it moves but doesn't draw any datapoints, the line
   showing 0 only appears after I refresh the browser").

   Mechanism proven on the running board: drawMetricChart overlaid the
   live column of EVERY series into the union x — including legendOnly
   keys, which draw no path at all. The MTP card's only live key
   (mtp.accepted_tokens_s) is legendOnly, so its 2 Hz stamps extended the
   union x past the last stored 5 s sample. In the live-only tail every
   stacked band column is null, and uPlot's gap-clip dropped the whole
   band render (pixel A/B: tail present 192 px, tail trimmed 820 px).
   At boot the ring is empty, so the first draws are stored-only and the
   line appears — the exact refresh-dependent symptom.

   Contracts (text-level; the module is a browser IIFE):
   - the live overlay loop iterates only NON-legendOnly series;
   - the loop still guards every series key with LF.liveUsable;
   - the Throughput card's drawn live lines (generation/prefill/embed/
     mtp rate) keep their explicit livePair paths — untouched. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const charts = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');

test('LIVE-UNION-1: metric-card live overlay skips legendOnly series', () => {
    const m = charts.match(/if \(liveOn\) \{([\s\S]*?)const cols = metricUnionCols/);
    assert.ok(m, 'drawMetricChart live-overlay block found');
    const block = m[1];
    assert.ok(block.includes('.filter(s => !s.legendOnly)'),
        'the overlay must iterate only DRAWN (non-legendOnly) series');
    assert.ok(block.includes('LF.liveUsable(s.key)'),
        'per-series freshness gate stays (liveUsable)');
    // the overlay source must be the FILTERED list, never metricServes raw
    const src = /const sers = metricServes\(e\.def\)(\.)?/.exec(block);
    assert.ok(!src || block.includes('metricServes(e.def).filter'),
        'live overlay must build from filtered series only');
});

test('LIVE-UNION-1: Throughput drawn lines keep their live pairs', () => {
    // the big chart paths name their keys explicitly and stay live-capable
    for (const k of ['generation.tokens_s', 'prefill.tokens_s',
                     'embedding.tokens_s', 'mtp.accepted_tokens_s'])
        assert.ok(charts.includes(`LF.liveUsable('${k}')`),
            `throughput live twin for ${k} must remain wired`);
});
