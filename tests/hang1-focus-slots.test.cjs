/* HANG-1 (user report 2026-10-08, measured): every visible dashboard tab
   held TWO forever SSE streams (requests + 2 Hz metrics). Browsers cap
   HTTP/1.1 at ~6 concurrent connections PER ORIGIN (uvicorn serves h11),
   so 3 visible tabs = 6 = the 4th tab's page load starves (cliff test:
   tab 4-7 loads stalled >25 s while earlier tabs streamed).
   Fix: forever-streams belong to the ATTENDED tab only; unattended tabs
   fall back to the FEED-1 poll / 5 s stored redraw. These pins stop a
   'cleanup' from re-permanentising background streams.

   ACT-SLEEP-1 (user report 2026-10-19: "Activity looks like it sleeps even
   when the tab is focused"): the budget stays, the PREDICATE changed.
   "Focused" was read via document.hasFocus() + an unconditional blur
   release — but clicking into an embedded classic page (Chat/Bench iframe)
   fires the same window blur while the user is unmistakably still in the
   tab (measured live: blur fired, activeElement became IFRAME), which
   killed the requests stream and left Activity on the slow poll. Presence
   is now audienceHere(): visible AND (document focused OR an embed iframe
   holding focus). Blur releases only when the audience actually left, and
   a watchdog (act-sleep1-feed-watchdog.test.cjs owns its behavior pins)
   repairs links the browser still believes: a half-open OPEN-but-silent
   stream and one EventSource gave up on permanently. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const feed = read('uplift_feed.js');
const lf = read('uplift_livefeed.js');

test('ACT-SLEEP-1: audienceHere() is the single presence question (hidden / focus / iframe)', () => {
    const fn = feed.slice(feed.indexOf('function audienceHere'),
        feed.indexOf('function connectEventStream'));
    assert.ok(/document\.hidden\) return false/.test(fn), 'hidden tab has no audience');
    assert.ok(/document\.hasFocus\(\)\) return true/.test(fn), 'focused doc = audience');
    assert.ok(/tagName === 'IFRAME'/.test(fn),
        'focus inside an embedded classic page still counts as an audience');
});

test('HANG-1+ACT-SLEEP-1: request-feed connect gates on the audience', () => {
    const fn = feed.slice(feed.indexOf('function connectEventStream'),
        feed.indexOf('/* SSE-PAUSE-1'));
    assert.ok(/if \(!audienceHere\(\)\) return;/.test(fn),
        'connectEventStream must refuse tabs WITHOUT an audience');
    assert.ok(!/!document\.hasFocus\(\)/.test(fn),
        'ACT-SLEEP-1: raw hasFocus() gate is wrong inside an embed — replaced by audienceHere()');
});

test('ACT-SLEEP-1: the stream stamps frame liveness and catch-up polls on open', () => {
    const fn = feed.slice(feed.indexOf('function connectEventStream'),
        feed.indexOf('/* SSE-PAUSE-1'));
    assert.ok(/onopen = \(\) => \{ lastFrameAt = Date\.now\(\); pollRequests\(\); \}/.test(fn),
        'open/reopen = stamp + ring catch-up (covers EventSource internal retries)');
    assert.ok(/onmessage = e => \{\s*lastFrameAt = Date\.now\(\);/.test(fn),
        'every received frame re-stamps liveness');
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

test('HANG-1 (audience check added by ACT-SLEEP-1): focus/blur listeners hand the slot over', () => {
    assert.ok(/addEventListener\('focus'/.test(feed) && /addEventListener\('blur'/.test(feed),
        'request feed reopens on focus, releases on blur');
    const blur = feed.slice(feed.indexOf("addEventListener('blur'"),
        feed.indexOf('/* FEED-1:'));
    assert.ok(/audienceHere\(\)/.test(blur),
        'blur releases ONLY when the audience left — iframe focus is not a departure');
    assert.ok(/addEventListener\('focus', \(\) => connect\(\)\)/.test(lf),
        'live feed reopens on focus (resume path)');
    assert.ok(!/addEventListener\('blur', \(\) => close\(\)\)/.test(lf),
        'LIVE-FOCUS-1: live feed NO LONGER closes on blur');
});

test('FEED-1 + ACT-SLEEP-1: the boot chain runs the watchdog; the fallback poll stays 10 s', () => {
    const boot = read('uplift_boot.js');
    assert.ok(/setInterval\(\(\) => FE\.feedWatchdog\(\), 5000\)/.test(boot),
        'boot ticks the watchdog (repair is cheap; it replaces the bare poll interval)');
    assert.ok(!/FE\.pollRequests\(\); \}, 10000\)/.test(boot),
        'the old bare-poll interval is gone — the watchdog owns the fallback path');
    const wd = feed.slice(feed.indexOf('function feedWatchdog'),
        feed.indexOf('async function pollRequests'));
    assert.ok(/lastPollAt >= 10_000|Date\.now\(\) - lastPollAt >= 10_000/.test(wd),
        'POLL-BATCH-2 cadence preserved: unattended tabs poll at 10 s, not per watchdog tick');
});
