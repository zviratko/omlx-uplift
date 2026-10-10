/* Item 5 (user 2026-10-10): the Request feed is a popup opened from the
   Activity card header, not a board block. Text-level drift test (same
   approach as modal-escape.test.cjs): the contracts that silently break
   in the browser if edited wrong.

   1. #reqfeed-pop must NOT carry modal-overlay statically in index.html —
      the global Escape handler in uplift_state.js removes EVERY open
      .modal-overlay; a static class would let the first stray Escape
      destroy the popup DOM for the whole session. openFeed() adds the
      class while open and closeFeed() takes it off.
   2. The popup lives OUTSIDE #grid (GridStack claims any .card inside it
      and the `cards` bind loop expects a .card-remove per board card).
   3. renderReqFeed is a no-op while the popup is closed (the boot cost
      the user complained about) — the data path (reqFeedRows, SSE/poll,
      the in-flight card's terminal labels) must stay untouched.
   4. The Activity header carries the opener; the feed module binds it.
   5. First-open lazy boot: openFeed calls reqSearch.ensureBooted (or a
      refresh run), and the reqsearch boot at DOMContentLoaded binds the
      controls WITHOUT fetching anything.
   6. Item 7: the stored-history default window is 2 h (chip ladder +
      chip-selection fallback), a remembered chip still wins. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
const feed = fs.readFileSync(path.join(STATIC_DIR, 'uplift_feed.js'), 'utf8');
const rs = fs.readFileSync(path.join(STATIC_DIR, 'uplift_reqsearch.js'), 'utf8');

test('popup wrapper carries no static modal-overlay class and sits outside #grid', () => {
    const pop = html.match(/<div id="reqfeed-pop"[^>]*>/);
    assert.ok(pop, '#reqfeed-pop exists');
    assert.ok(!/modal-overlay/.test(pop[0]),
        'modal-overlay must be added only while OPEN (global Escape handler ' +
        'removes every open overlay — a static class = destroyed popup)');
    const gridStart = html.indexOf('<main id="grid"');
    const gridEnd = html.indexOf('</main>');
    const popPos = html.indexOf('id="reqfeed-pop"');
    assert.ok(gridStart >= 0 && gridEnd > gridStart);
    assert.ok(popPos > gridEnd,
        'the popup must live outside #grid (GridStack would claim its .card)');
});

test('feed renders only while the popup is open; data path untouched', () => {
    assert.match(feed, /if \(!feedOpen\) return;[^\n]*\n\s*const list = \$\('reqfeed'\);/,
        'renderReqFeed must no-op while closed');
    assert.match(feed, /feedOpen = true;\n\s*pop\.classList\.add\('modal-overlay'\)/,
        'openFeed adds the dialog class + routes Escape through closeFeed');
    assert.match(feed, /pop\.__upliftModalClose = closeFeed/,
        'Escape must reach the real teardown (hide, not remove)');
    // the Map/poll/SSE paths never check feedOpen (in-flight card needs them)
    assert.match(feed, /function upsertReq\(id, patch\) \{[\s\S]*?reqFeedRows\.set\(/);
});

test('Activity header owns the opener; the feed module binds it once', () => {
    assert.match(html, /id="btn-reqfeed"[^>]*data-i18n="uplift\.req\.feed_btn"/);
    assert.match(feed, /function bindFeedOpener\(\)[\s\S]*?\$\('btn-reqfeed'\)/);
    assert.match(feed, /btn\.dataset\.bound/);
});

test('stored-history boot is lazy and refreshes on reopen', () => {
    assert.match(rs, /function ensureBooted\(\) \{[\s\S]*?initReqSearch\(\)\.then\(\(\) => runReqSearch\(\)\)/);
    // DOMContentLoaded path binds controls only — no fetches behind the flag
    assert.match(rs, /function bootReqSearch\(\) \{\s*\n\s*bindReqSearchControls\(\);/);
    // openFeed: first open boots, later opens refresh an active search
    assert.match(feed, /if \(RS\.searchOn\) RS\.run\(\);[\s\S]*?else RS\.ensureBooted\(\);/);
});

test('default history window is 2h; remembered chip still wins', () => {
    assert.match(rs, /const REQ_DEFAULT_WIN = 7200;/);
    assert.match(rs, /\['2h', 7200\]/, 'the 2h chip must exist in the ladder');
    assert.match(rs, /kids\.find\(x => \+x\.dataset\.secs === REQ_DEFAULT_WIN\)/,
        'fresh default = the 2h chip, not the last (retention-wide) chip');
    assert.match(rs, /const want = loadReqWinPref\(\);[\s\S]*?kids\.find\(x => \+\w+\.dataset\.secs === want\)/,
        'U14: the remembered window keeps priority');
});
