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

test('HANG-1: live-feed connect gates on hidden AND focus', () => {
    const fn = lf.slice(lf.indexOf('function connect()'), lf.indexOf('function close()'));
    assert.ok(/document\.hidden \|\| !document\.hasFocus\(\)/.test(fn),
        'livefeed connect must refuse unfocused visible tabs');
});

test('HANG-1: focus/blur listeners hand the slots over', () => {
    assert.ok(/addEventListener\('focus'/.test(feed) && /addEventListener\('blur'/.test(feed),
        'request feed reopens on focus, releases on blur');
    assert.ok(/addEventListener\('focus', \(\) => connect\(\)\)/.test(lf)
        && /addEventListener\('blur', \(\) => close\(\)\)/.test(lf),
        'live feed reopens on focus, releases on blur');
});

test('HANG-1: FEED-1 poll stays the unfocused-tab fallback', () => {
    const boot = read('uplift_boot.js');
    assert.ok(/!document\.hidden && !FE\.sseOpen\(\)\) FE\.pollRequests\(\); \}, 2000\)/.test(boot)
        || /FE\.pollRequests\(\); \}, 2000\)/.test(boot),
        'the 2 s fallback poll must survive — it is what feeds unfocused tabs');
});
