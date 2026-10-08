/* NAT-6 (user, 2026-10-08): the native Bench/Chat surfaces AND the classic
   embeds ship side by side. This file pins the fallback wiring the shape
   depends on — the same structural-test style as u51-sweep-structure:

   1) index.html: bench items carry a .dd-classic "Classic (Embed)" twin in
      a .dd-item row; Chat is a dropdown whose menu has Native + classic
      rows; every bench/chat embed card header carries an .embed-mode-switch
      (the way back); the cluster embed is NOT swept into the switch.
   2) uplift.js: the routing contract — hashClassicLeg outranks localStorage,
      surfaceMode never returns classic for native-only subs, the dd item
      handler persists the mode, the chat button navigates on click, the
      touch exception keeps the menu reachable, applyTab re-syncs hash and
      badges, and the card-paint loop hides the embed twin in native mode.
   3) uplift.css: the flyout cascades to the RIGHT of the menu, is hidden
      until the row is hovered, has a no-hover fallback, and no stray radii.
   4) locales: uplift.nav.* keys exist in every locale (owned-prefix sync is
   test_locale_sync's job; here we only prove the keys the markup uses). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift.js'), 'utf8');
const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

// ---- 1) markup ------------------------------------------------------------

test('NAT-6 markup: every bench option has a Classic (Embed) flyout twin', () => {
    for (const sub of ['throughput', 'accuracy', 'context']) {
        const row = new RegExp(
            '<span class="dd-item"><a [^>]*data-sub="' + sub +
            '"(?![^>]*data-mode)[^>]*>[^<]*</a><a [^>]*data-sub="' + sub +
            '"[^>]*data-mode="classic"[^>]*class="dd-classic"');
        assert.ok(row.test(html), 'bench/' + sub + ' row = native link + classic twin');
    }
    const classics = html.match(/class="dd-classic"/g) || [];
    assert.equal(classics.length, 3, 'exactly three bench flyouts');
});

test('NAT-6 markup: Chat is a dropdown with Native + Classic (Embed) rows', () => {
    assert.ok(html.includes('id="dd-chat-btn"') && html.includes('id="dd-chat-menu"'),
        'chat nav item became a .dd (was a plain <a>)');
    const menu = html.match(/<span class="dd-menu" id="dd-chat-menu"[\s\S]*?<\/span>/);
    assert.ok(menu, 'chat menu present');
    assert.ok(/data-sub="chat"[^>]*data-mode="native"/.test(menu[0]), 'Native row');
    assert.ok(/data-sub="chat"[^>]*data-mode="classic"/.test(menu[0]), 'Classic row');
    assert.ok(!/<a href="#chat" data-tab="chat"/.test(html),
        'no stale plain Chat link left beside the dropdown');
});

test('NAT-6 markup: bench/chat embed cards carry the Native switch badge; cluster does not', () => {
    for (const id of ['bench-tp-page', 'bench-acc-page', 'bench-ctx-page', 'chat-page']) {
        const b = html.match(new RegExp(
            '<a data-mode="native"[^>]*class="embed-mode-switch" data-for="' + id +
            '"[^>]*>[^<]*<\\/a>'));
        assert.ok(b, id + ' embed card has the switch badge');
        assert.ok(/hidden>Native<\/a>$/.test(b[0]),
            id + ' badge starts hidden (JS reveals it only when native exists)');
    }
    assert.ok(!/data-for="cluster-page"/.test(html),
        'cluster embed is out of the surface switch (no native twin)');
});

// ---- 2) routing contract ----------------------------------------------------

test('NAT-6 routing: surfaceMode ladder (flag > native-only sub > hash > localStorage)', () => {
    const slice = (start, end) => {
        const a = js.indexOf(start), b = js.indexOf(end, a);
        assert.ok(a > 0 && b > a, 'slice found: ' + start);
        return js.slice(a, b);
    };
    const body = slice('function surfaceMode(tab, sub)', '/* Rewrites the classic leg');
    // order inside the function is the ladder — assert it, not just presence
    const offIdx = body.indexOf('nativeAvailable(tab)');
    const onlyIdx = body.indexOf('CLASSIC_SUBS[tab]');
    const hashIdx = body.indexOf('hashClassicLeg(tab)');
    const lsIdx = body.indexOf('classicTabs().includes(tab)');
    assert.ok(offIdx >= 0 && offIdx < onlyIdx && onlyIdx < hashIdx && hashIdx < lsIdx,
        'ladder: server flag, then native-only sub, then hash leg, then localStorage');
    assert.ok(slice('function hashClassicLeg', 'function surfaceMode')
        .includes("parts[2] === 'classic'"), 'hash leg = 3rd part');
});

test('NAT-6 routing: dd item clicks persist the mode and keep the hash in sync', () => {
    assert.ok(/if \(tab === 'bench' \|\| tab === 'chat'\) setClassicMode\(tab, classic\);/.test(js),
        'menu item click writes the per-viewer mode');
    assert.ok(/'#' \+ tab \+ '\/' \+ a\.dataset\.sub \+ \(classic \? '\/classic' : ''\)/.test(js),
        'menu item click carries the hash leg');
    assert.ok(js.includes("const CLASSIC_LS_KEY = 'uplift-classic-embed'"),
        'viewer choice lives in localStorage under the documented key');
});

test('NAT-6 routing: Chat button click opens the native chat; touch keeps the menu', () => {
    assert.ok(/navigateOnClick: true, hashSub: 'chat'/.test(js),
        'chat dropdown registered click-navigates');
    assert.ok(/if \(opts\.navigateOnClick && !ddTouchHover\(\)\)/.test(js),
        'touch devices still toggle the menu — fallback stays reachable');
});

test('NAT-6 routing: applyTab syncs the hash leg and the card-paint hides the embed twin in native mode', () => {
    const a = js.indexOf('function applyTab()');
    const b = js.indexOf("addEventListener('hashchange', applyTab)");
    assert.ok(a > 0 && b > a);
    const body = js.slice(a, b);
    assert.ok(body.includes('syncClassicHash(tab, sub);'), 'hash normalized on every route');
    assert.ok(body.includes('syncEmbedSwitches();'), 'badges follow the server flag');
    assert.ok(body.includes('SURFACE_EMBED_IDS.has(card.dataset.id) && natOn'),
        'embed twins hide exactly when native paints');
});

// ---- 3) style ---------------------------------------------------------------

test('NAT-6 style: flyout cascades right of the menu, hover-revealed, no-hover fallback', () => {
    assert.ok(/\.dd-menu \.dd-classic\s*{[^}]*left: 100%/.test(css),
        'classic twin opens OUTSIDE the menu to the right (user shape)');
    assert.ok(css.includes('.dd-menu .dd-item:hover .dd-classic:not([hidden]) { display: block; }'),
        'revealed on row hover, JS [hidden] keeps veto power');
    assert.ok(/@media \(hover: none\)[\s\S]{0,300}\.dd-classic\s*\{\s*position: static/.test(css),
        'touch devices get a plain indented sub-entry instead of a cascade');
    /* Hover-ONLY regression (user, 2026-10-08: "it looks weird when all 3
       are visible"). The flyout base MUST beat the row rule that makes the
       primary link block — both links are direct children of .dd-item, so
       '.dd-menu .dd-item > a { display:block }' (0,2,1) outranked the twin's
       '.dd-menu .dd-classic { display:none }' (0,2,0) and painted all three
       twins into the open menu. The row rule must exclude .dd-classic, and
       a row-scoped display:none with equal-or-higher specificity must hold. */
    assert.ok(/\.dd-menu \.dd-item > a:not\(\.dd-classic\)\s*\{\s*display: block/.test(css),
        'row block-link rule must EXCLUDE the flyout twin');
    const rowHide = css.match(/\.dd-menu \.dd-item( > a)?(\.dd-classic|:has[^{]*)?[^{]*\.dd-classic[^{]*\{[^}]*display: none/);
    assert.ok(rowHide, 'a .dd-item-scoped display:none guards the flyout base');
});

// ---- 4) locales ---------------------------------------------------------------

test('NAT-6 i18n: nav fallback keys exist in every locale', () => {
    const dir = path.join(__dirname, '..', 'omlx_uplift', 'locales');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of ['uplift.nav.native', 'uplift.nav.native_hint',
                         'uplift.nav.classic_embed'])
            assert.ok(typeof d[k] === 'string' && d[k].length, f + ' missing ' + k);
    }
    // the markup references exactly these keys through data-i18n
    for (const k of ['uplift.nav.native', 'uplift.nav.classic_embed'])
        assert.ok(html.includes('data-i18n="' + k + '"'), 'markup uses ' + k);
});
