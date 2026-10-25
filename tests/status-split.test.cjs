/* STATUS-SPLIT (user 2026-10-25): the Status tab carries three views —
   Status (compact board), Status extended (the full board) and About.
   These gates pin what the split must never lose: the two boards stay
   independent, the shared cards keep identical geometry, an existing
   hand-tuned board survives the blob upgrade, and the localStorage
   whitelist keeps carrying the board map. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

require('../omlx_uplift/static/uplift_layout.js');
const UPL = globalThis.UpliftLayout;
const C = require('../omlx_uplift/static/core.js');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const html = read('index.html');
const upSrc = read('uplift.js');

const COMPACT_SET = ['live', 'chart-mem', 'met-pwr-total-w', 'met-therm-cpu-temp-c',
                     'prefill', 'gen', 'requests', 'tokens', 'cache'];

test('the two board views exist and About is not a board', () => {
    assert.deepStrictEqual(UPL.BOARD_VIEWS, ['status', 'extended']);
    assert.match(upSrc, /status: \['status', 'extended', 'about'\]/,
        'SUBS.status owns exactly the three views, compact first');
});

test('compact board = Activity + Memory & cache + gated row + stat tiles, nothing else', () => {
    const ids = UPL.defaultLayoutFor('status').blocks.map(b => b.id);
    assert.deepStrictEqual(ids.slice().sort(), COMPACT_SET.slice().sort(),
        'the shipped compact board is the cards the user listed (plus the macmon pair)');
    // No throughput/req-size/metric card may leak into the compact default.
    assert.ok(!ids.includes('chart-tps') && !ids.includes('reqstats'));
    assert.ok(!ids.some(id => id.startsWith('met-') && !COMPACT_SET.includes(id)));
});

test('shared cards carry IDENTICAL geometry in both boards', () => {
    const ext = new Map(UPL.defaultLayoutFor('extended').blocks.map(b => [b.id, b]));
    for (const b of UPL.defaultLayoutFor('status').blocks) {
        const z = ext.get(b.id);
        assert.ok(z, `${b.id} is not on the extended board`);
        assert.deepStrictEqual([b.x, b.y, b.w, b.h], [z.x, z.y, z.w, z.h],
            `${b.id} changed size/position between views — a card must not jump when the user switches views`);
    }
});

test('defaultLayout() still answers with the full board (back-compat)', () => {
    assert.deepStrictEqual(UPL.defaultLayout().blocks.map(b => b.id),
        UPL.defaultLayoutFor('extended').blocks.map(b => b.id));
    assert.ok(UPL.defaultLayout().blocks.length > UPL.defaultLayoutFor('status').blocks.length);
});

test('migrateBoards moves the saved board into extended untouched', () => {
    const saved = {
        chartWindowSec: 900,
        width: 'wide',
        blocks: [{ id: 'live', x: 0, y: 0, w: 12, h: 30 },
                 { id: 'chart-tps', x: 0, y: 30, w: 24, h: 34 }],
        mergedBlocks: ['live', 'chart-tps', 'cache'],
    };
    const before = JSON.parse(JSON.stringify(saved.blocks));
    UPL.migrateBoards(saved);
    assert.deepStrictEqual(saved.boards.extended.blocks, before,
        'a hand-tuned board must survive the upgrade byte-for-byte');
    assert.strictEqual(saved.boards.extended.width, 'wide', 'the saved page width rides along');
    assert.deepStrictEqual(saved.boards.extended.mergedBlocks, ['live', 'chart-tps', 'cache'],
        'the one-shot merge memo must not reset — removed cards would resurrect');
    assert.deepStrictEqual(saved.boards.status.blocks.map(b => b.id).sort(), COMPACT_SET.slice().sort());
    assert.strictEqual(saved.lastStatusView, 'extended',
        'a user who had a board lands on the view that still holds it');
    assert.ok(!('blocks' in saved) && !('mergedBlocks' in saved),
        'the legacy top-level board is gone (one source of truth per view)');
    // idempotent
    const once = JSON.parse(JSON.stringify(saved));
    UPL.migrateBoards(saved);
    assert.deepStrictEqual(saved, once);
});

test('migrateBoards handles a fresh board and starts compact', () => {
    const saved = { chartWindowSec: 300 };
    UPL.migrateBoards(saved);
    assert.strictEqual(saved.lastStatusView, 'status', 'a first visit gets the compact view');
    // Nothing saved => the extended record carries NO blocks on purpose: the
    // layout then resolves to the shipped default (normalizeLayout(null)) and
    // the mergedBlocks memo stays empty, so a card added by a later release
    // still auto-appends to a fresh board.
    assert.strictEqual(saved.boards.extended.blocks, null);
    assert.strictEqual(saved.boards.extended.mergedBlocks, null);
    assert.deepStrictEqual(UPL.normalizeLayout(null).blocks.map(b => b.id),
        UPL.defaultLayoutFor('extended').blocks.map(b => b.id),
        'the null record must resolve to exactly the shipped extended board');
    assert.deepStrictEqual(saved.boards.status.blocks.map(b => b.id).sort(),
        COMPACT_SET.slice().sort());
});

test('boardBlob hands back the LIVE record so saves cannot cross boards', () => {
    const saved = { };
    UPL.migrateBoards(saved);
    const a = UPL.boardBlob(saved, 'status');
    a.blocks = [{ id: 'live', x: 0, y: 0, w: 24, h: 10 }];
    assert.deepStrictEqual(UPL.boardBlob(saved, 'status').blocks, a.blocks);
    const ext = UPL.boardBlob(saved, 'extended');
    ext.blocks = UPL.defaultLayoutFor('extended').blocks.map(b => ({ ...b }));
    assert.ok(ext.blocks.length > a.blocks.length,
        'writing one view must not touch the other');
    // an unknown view falls back to extended, never to the compact board
    assert.strictEqual(UPL.boardBlob(saved, 'about'), ext);
});

test('loadLayout carries the boards map through its whitelist', () => {
    const blob = {
        chartWindowSec: 300, intervalMs: 1000, logsHideDebug: true, liveFeed: true,
        percentile: 'p95', tpsSmooth: 3, collapsed: {}, metricWin: {},
        boardsV1: 1, lastStatusView: 'status',
        boards: { status: { width: 'default', blocks: [{ id: 'live', x: 0, y: 0, w: 12, h: 30 }] } },
    };
    const storage = { getItem: () => JSON.stringify(blob), setItem: () => {} };
    const out = C.loadLayout(storage);
    assert.ok(out.boards, 'boards dropped by the whitelist = both boards deleted on the next save');
    assert.strictEqual(out.boardsV1, 1);
    assert.strictEqual(out.lastStatusView, 'status');
    assert.strictEqual(out.boards.status.blocks[0].id, 'live');
});

test('nav: Status is a dropdown with three rows and About is a page card', () => {
    assert.match(html, /<span class="dd" id="dd-status">/, 'Status is a dropdown like Models/Bench');
    assert.match(html, /class="dd-btn" data-tab="status" id="dd-status-btn"/, 'the dd button carries the tab');
    assert.match(html, /id="dd-status-menu"/, 'the menu needs its id for DD_PAIRS');
    for (const sub of ['status', 'extended', 'about'])
        assert.ok(html.includes(`data-sub="${sub}"`), `missing menu row ${sub}`);
    assert.match(html, /data-id="about-page" data-tab="status" data-sub="about"/,
        'About is a page card under the Status tab');
    // the relocated endpoints/engines ids: uplift.js's renderer still owns them
    for (const id of ['api-openai', 'api-claude', 'api-alias', 'api-copy-openai', 'api-copy-claude', 'api-engines'])
        assert.ok(html.includes(`"${id}"`), `moved markup lost #${id}`);
    for (const id of ['about-software', 'about-host', 'about-credits'])
        assert.ok(html.includes(`"${id}"`), `About lost #${id}`);
    assert.match(html, /<script src="\.\/uplift_about\.js"><\/script>/);
});

test('applyTab keeps the board and Customize off About, and remembers the view', () => {
    const body = upSrc.slice(upSrc.indexOf('function applyTab()'),
                             upSrc.indexOf("addEventListener('hashchange', applyTab)"));
    assert.match(body, /const onBoard = tab === 'status' && sub !== 'about';/);
    assert.match(body, /\$\('grid'\)\.style\.display = onBoard \? '' : 'none';/);
    assert.match(body, /\$\('btn-customize'\)\.hidden = !onBoard \|\| dashEditing;/);
    assert.match(body, /if \(!onBoard && dashEditing\) cancelDashEdit\(\);/,
        'an open edit session cannot outlive the board it edits');
    assert.match(body, /rememberStatusView\(sub\);\s*applyStatusBoard\(sub\);/,
        'a board view entry remembers the view AND applies its geometry');
});

test('board saves write through the active view, never to the legacy keys', () => {
    assert.match(upSrc, /function persistBoardLayout\(next\)/);
    assert.match(upSrc, /persistBoardLayout\(next\);\s*C\.saveLayout\(localStorage, layout\);/,
        'save-dash-layout persists the edited view');
    // the legacy top-level write survives ONLY as boardBlob's no-boards
    // fallback (one occurrence); every real save goes through the view map
    assert.strictEqual((upSrc.match(/layout\.blocks =/g) || []).length, 1,
        'a second top-level board write would let one view overwrite the other');
    assert.match(upSrc, /UPL\.defaultLayoutFor\(appliedBoardView\)/,
        'the in-edit Reset restores the view being edited');
    assert.match(upSrc, /delete layout\.boards; delete layout\.boardsV1;/,
        'the global Layout reset recreates BOTH boards from their defaults');
    assert.match(upSrc, /window\.confirm && !window\.confirm\(ask\)/,
        'a reset that clears a view the user is not looking at must confirm first');
});

test('bare #status normalises to the resolved view (shareable link, live row highlight)', () => {
    assert.match(upSrc, /split\('\/'\)\.length < 2\)\s*history\.replaceState\(null, '', location\.pathname \+ location\.search \+ '#status\/' \+ sub\);/,
        'replaceState, never location.hash (that re-fires hashchange -> applyTab twice)');
});
