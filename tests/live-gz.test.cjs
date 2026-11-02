/* LIVE-GZ (user 2026-11-02): the metrics stream's first frame replays the
 * whole 2 Hz ring (~250 KB). Boot also fetched the same ring through the
 * one-shot /metrics/live snapshot, so every page load parsed it twice. The
 * snapshot is now only the fallback for browsers without EventSource.
 *
 * Structural pins on purpose: uplift_boot.js runs the whole board at load
 * and has no vm harness (same rule as the other boot interval pins); the
 * Live-feed toggle lives in the uplift.js monolith, which cannot be
 * vm-loaded either.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const read = (f) => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');

test('boot opens the stream and probes the snapshot only without EventSource', () => {
    const src = read('uplift_boot.js');
    const at = src.indexOf('if (layout.liveFeed) {');
    assert.ok(at > 0, 'boot live-feed block not found');
    const block = src.slice(at, src.indexOf('\n}', at) + 2);
    assert.match(block, /if \(window\.EventSource\) LF\.connect\(\);\s*else LF\.probe\(fetchJson\);/,
        'probe must be the else-branch of the EventSource check:\n' + block);
    assert.equal((block.match(/LF\.probe\(/g) || []).length, 1, 'one probe site only');
});

test('re-enabling the Live feed toggle re-arms the feed and uses the same choice', () => {
    const src = read('uplift.js');
    const at = src.indexOf("$('opt-live-feed').onchange");
    assert.ok(at > 0, 'live-feed toggle handler not found');
    const body = src.slice(at, src.indexOf('};', at));
    assert.match(body, /LF\.enable\(\);\s*if \(window\.EventSource\) LF\.connect\(\); else LF\.probe\(fetchJson\);/,
        'toggle must call enable() (disable() latches the feed off) and pick stream OR snapshot:\n' + body);
});

test('the livefeed module still exports enable() for the toggle', () => {
    const src = read('uplift_livefeed.js');
    assert.match(src, /function enable\(\) \{ disabled = false; \}/);
    assert.match(src, /disable, enable,/);
});
