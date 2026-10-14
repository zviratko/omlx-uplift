/* HANG-1 (user report 2026-10-08, measured): every visible dashboard tab
   held TWO forever SSE streams (requests + 2 Hz metrics). Browsers cap
   HTTP/1.1 at ~6 concurrent connections PER ORIGIN (uvicorn serves h11),
   so 3 visible tabs = 6 = the 4th tab's page load starves (cliff test:
   tab 4-7 loads stalled >25 s while earlier tabs streamed).
   Fix: forever-streams belong to the FOCUSED tab only; unfocused tabs
   fall back to the FEED-1 2 s poll / 5 s stored redraw. These pins stop
   a 'cleanup' from re-permanentising background streams. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const feed = read('uplift_feed.js');
const lf = read('uplift_livefeed.js');

test('HANG-1: request-feed connect gates on hidden AND focus', () => {
    const fn = feed.slice(feed.indexOf('function connectEventStream'),
        feed.indexOf("/* SSE-PAUSE-1"));
    assert.ok(/document\.hidden \|\| !document\.hasFocus\(\)/.test(fn),
        'connectEventStream must refuse unfocused visible tabs');
});

test('LIVE-FOCUS-1: live-feed connect gates on HIDDEN only (stats lane)', () => {
    // Revised 2026-10-14: the stats payload now rides this stream, and the
    // focus gate made boards poll at full rate EXACTLY while the user had
    // DevTools open (the inspector steals focus). A visible tab keeps its
    // ONE forever stream regardless of focus; hidden tabs still release.
    const fn = lf.slice(lf.indexOf('function connect()'), lf.indexOf('function close()'));
    assert.ok(/document\.hidden\) return;/.test(fn) && !/hasFocus/.test(fn),
        'livefeed connect refuses HIDDEN tabs only');
});

test('HANG-1 (kept for the request stream): focus/blur listeners hand its slot over', () => {
    assert.ok(/addEventListener\('focus'/.test(feed) && /addEventListener\('blur'/.test(feed),
        'request feed reopens on focus, releases on blur');
    assert.ok(/addEventListener\('focus', \(\) => connect\(\)\)/.test(lf),
        'live feed reopens on focus (resume path)');
    assert.ok(!/addEventListener\('blur', \(\) => close\(\)\)/.test(lf),
        'LIVE-FOCUS-1: live feed NO LONGER closes on blur');
});

test('FEED-1: the unfocused fallback poll survives, slowed to 10 s', () => {
    const boot = read('uplift_boot.js');
    assert.ok(/FE\.pollRequests\(\); \}, 10000\)/.test(boot),
        'unfocused tabs catch events on a 10 s background cadence; the ring replays on focus');
});
