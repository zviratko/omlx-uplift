/* LEGEND-COMPACT (user 2026-10-10: "the values under the graphs for memory
   and mtp acceptance are outside of the boxes ... omit them for MTP
   acceptance and only show mean depth and MTP accepted tok/s").

   Contracts this pins:
   1. the MTP card def marks every series legendHide EXCEPT mtp.depth_avg
      and mtp.accepted_tokens_s (stacked bands + secondary stats drop out
      of the CARD legend; data columns stay — hover tooltip and popout
      keep the full story);
   2. the hide pass is DOM-post-processing (vendored uPlot has no
      per-series legend option) and runs on BOTH card build paths (create
      + theme/skin reinit) but NOT in the pop-out;
   3. fitMetricPlot carves the legend height out of the box (canvas +
      legend inside the host) and _neededUnits demands 96 + legend — the
      pair that keeps the legend pasted inside the card border. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const charts = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
const upjs = fs.readFileSync(path.join(STATIC_DIR, 'uplift.js'), 'utf8');
const C = require(path.join(STATIC_DIR, 'core.js'));

test('MTP card def: legend shows only mean depth + accepted tok/s', () => {
    const mtp = C.EXPLORE_METRICS.find(m => m.key === 'mtp.accept_pct');
    const vis = mtp.series.filter(s => !s.legendHide).map(s => s.key);
    assert.deepEqual(vis, ['mtp.depth_avg', 'mtp.accepted_tokens_s']);
    // the drawn stack keeps its columns — only the LEGEND rows hide
    const drawn = mtp.series.filter(s => !s.legendOnly).map(s => s.key);
    assert.equal(drawn.length, 4, 'depths 1..4+ still draw (cumulative columns intact); rejected band dropped');
});

test('hide pass is card-only, on both build paths, position-mapped', () => {
    assert.match(charts, /function applyCardLegendCompact\(chart, def\) \{/,
        'single helper owns the DOM hide');
    // both card build sites call it (definition line anchored away by the
    // required call-style prefix: a closing paren/comma + args)
    const calls = charts.match(/applyCardLegendCompact\((?:e\.chart|chart), (?:e\.def|def)\);/g) || [];
    assert.equal(calls.length, 2, 'create + reinit must both re-apply (popout must NOT)');
    const popout = fs.readFileSync(path.join(STATIC_DIR, 'uplift_popout.js'), 'utf8');
    assert.ok(!popout.includes('applyCardLegendCompact'),
        'the pop-out never compacts its legend');
    // Time-row probe keeps the row->series mapping identical to legendUpdater
    assert.match(charts, /function applyCardLegendCompact[\s\S]*?'Time'/);
});

test('legend height is carved from the box, and demanded from the row engine', () => {
    assert.match(charts, /h = Math\.max\(64, h - lgH\);[\s\S]*?host\.style\.height = \(h \+ lgH\) \+ 'px';/,
        'canvas shrinks by the legend, host carries canvas+legend inside the box');
    assert.match(upjs, /const floor = plot\.classList\.contains\('metric-plot'\) \? 96 \+ lgH/,
        'content demand includes the visible legend rows (hidden ones measure 0)');
});
