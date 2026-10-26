/* U49 — internal routes must not reach a human's eyes.
 *
 * Measured on the live board: an unreachable ModelScope printed
 *   'Failed to connect to ModelScope. /admin/api/ms/recommended?mlx_only=true
 *    -> 503 Service Unavailable'
 * into a panel banner — our URL layout, query string and all, served to the
 * operator. The shape came from ONE place (domkit.kitError) and was pasted into
 * visible text by 13 sites in the downloader.
 *
 * Contract now:
 *   * kitError keeps the full `${url} -> ${status}: reason` on `.message`
 *     (console, dev panel, tests) and adds `.userMessage` = 'reason (status)'.
 *   * anything a human reads goes through D.errText(e).
 *   * uplift_downloader.js may not touch `.message` at all — it is clean.
 *   * every other file is RATCHETED at its current count: a new raw read fails,
 *     cleaning one up only lowers the number. Tracker UP-52 holds the rest.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../omlx_uplift/static/domkit.js');
const { STATIC_DIR, staticFiles } = require('./static-src.cjs');

test('kitError carries a route-free userMessage beside the dev message', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'domkit.js'), 'utf8');
    assert.ok(/e\.userMessage = /.test(src),
        'kitError no longer sets userMessage — banners will paste the raw route again');
});

test('errText never returns our internal route shape', () => {
    const kitLike = new Error('/admin/api/ms/recommended?mlx_only=true -> 503: down');
    kitLike.userMessage = 'down (503)';
    assert.equal(D.errText(kitLike), 'down (503)');

    // an error from any other seam, still shaped '<url> -> <status>: <text>'
    const raw = new Error('/uplift/api/chat/save -> 500: boom');
    assert.equal(D.errText(raw), '500: boom');

    // bare strings and plain messages pass through untouched
    assert.equal(D.errText('Failed to fetch'), 'Failed to fetch');
    assert.equal(D.errText(new TypeError('Failed to fetch')), 'Failed to fetch');
    assert.equal(D.errText(null), '');

    // and the leak itself, as the panel showed it
    const leaky = new Error('/admin/api/ms/recommended?mlx_only=true -> 503 Service Unavailable');
    assert.ok(!D.errText(leaky).includes('/admin/api/'),
        'errText leaked an internal route: ' + D.errText(leaky));
});

test('uplift_downloader.js reads no raw error message', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_downloader.js'), 'utf8');
    const needle = /(?:^|[^\w.])(?:e|err|error|exc)\.message\b/;
    const hits = src.split('\n')
        .map((l, i) => [i + 1, l]).filter(([, l]) => needle.test(l));
    assert.deepEqual(hits, [],
        'use D.errText(e) — e.message holds the internal route (see UP-49): '
        + hits.map(([n, l]) => n + ': ' + l.trim()).join(' | '));
});

// Frozen 2026-10-25. Lower these as surfaces get cleaned; never raise one.
const ERR_READ = /(?:^|[^\w.])(?:e|err|error|exc)\.message\b/g;
const BASELINE = {
    'uplift_patches.js': 18,
    'uplift_voices.js': 16,
    'domkit.js': 1,               // the kit builds the dev-side message itself
};

test('raw .message reads are ratcheted per file (UP-52 lowers these)', () => {
    const worse = [];
    for (const f of staticFiles()) {
        if (!f.endsWith('.js')) continue;
        ERR_READ.lastIndex = 0;
        const n = (fs.readFileSync(path.join(STATIC_DIR, f), 'utf8').match(ERR_READ) || []).length;
        const cap = BASELINE[f] === undefined ? 0 : BASELINE[f];
        if (n > cap) worse.push(`${f}: ${n} > ${cap}`);
        // a file that reached zero must be dropped from the baseline entirely
        if (n === 0 && BASELINE[f] !== undefined) worse.push(`${f}: now clean, remove from BASELINE`);
    }
    assert.deepEqual(worse, [], 'raw error text grew (use D.errText): ' + worse.join(' | '));
});
