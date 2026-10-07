/* LEGEND-1 (user 2026-10-07): the Memory & Cache legend row blinked —
   '0.8 | — | — | —' alternating with '— | — | 28 | 0' about once a
   second, on reload and forever after. Root cause: FAST-1's union x
   column interleaves the 2 Hz live stamps with the 5 s stored stamps, so
   the LAST ROW belongs to whichever stream sampled last; the idle legend
   read colData[src.length-1] verbatim, and a series without a stamp at
   that exact row rendered '—'. 'Latest sample' semantics must scan each
   column to its OWN last non-null — the same rule the metric cards' big
   readout already uses. The hovered branch must KEEP the shared row (the
   crosshair shows one instant; null there is honest).

   chartkit (UMD, TST-1 pattern) exports lastNonNull; uplift_charts.js
   uses it in legendUpdater's idle path only. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const { lastNonNull } = require(path.join(STATIC_DIR, 'uplift_chartkit.js'));

test('lastNonNull: returns the column\'s own latest value through trailing nulls', () => {
    // The blink itself: mem samples at 2 Hz, iogpu/hot at 5 s — when the
    // final union row is a live stamp, the stored columns trail nulls.
    assert.strictEqual(lastNonNull([1, 2, null, null, null]), 2);
    assert.strictEqual(lastNonNull([1, 2, 3]), 3);
    assert.strictEqual(lastNonNull([null, 7, null]), 7);
    // 0 is a VALUE, not absence — must not be skipped
    assert.strictEqual(lastNonNull([5, 0, null]), 0);
});

test('lastNonNull: bounded scan, all-null and empty columns read as absent', () => {
    assert.strictEqual(lastNonNull([1, 2, 3], 1), 2);       // 'from' clamps the scan
    assert.strictEqual(lastNonNull([1, 2, 3], 99), 3);      // oversized from = whole column
    assert.strictEqual(lastNonNull([null, null, null]), null);
    assert.strictEqual(lastNonNull([]), null);
    assert.strictEqual(lastNonNull(undefined), null);
});

test('legendUpdater: idle branch resolves lastNonNull; hovered branch untouched', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
    const m = src.match(/function legendUpdater\(\)[\s\S]*?\n}/);
    assert.ok(m, 'legendUpdater not found');
    const body = m[0];
    // 'idle' must be MOUSE state, not idx===null: mouseleave re-pins idx to
    // the last row, so an idx-based test would blink again after any hover.
    assert.match(body, /const hovering = c\.cursor\.left >= 0 && idx !== null/,
        'idle vs hovered must key on cursor presence, not idx alone');
    assert.match(body, /KIT\.lastNonNull\(colData, i\)/,
        'idle legend cells must fall through to the column\'s own last non-null');
    assert.match(body, /const v = hovering \? raw/,
        'hovered cells must keep the shared crosshair row (null stays null)');
});
