/* PAGES-CONTAINMENT (user 2026-10-11: "I am seeing all the sections on one
   page, menu does nothing") — applyTab() hides page cards through the
   `#pages .card` collection; any section.page-card that ends up OUTSIDE
   #pages is invisible to it and renders under EVERY tab. The VOICE-1
   splice shipped exactly that: one stray </div> closed #pages after 8 of
   19 cards and stranded settings/bench/chat/… under the Status board.
   Layout-suite runs could not catch it (the tab-switch assertions used
   the same selector applyTab does, and both sides agreed on the shrunken
   container). This test parses index.html structurally — no browser —
   and is the only gate that can see the containment itself.

   Doctrine: walk tags with a real stack; void elements never push; a
   close-tag that does not match the top unwinds to the match (browsers
   do the same) — the walk must report a well-formed document AND every
   page-card inside #pages. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function walk(html) {
    // same tolerant unwind policy as html.parser/browser: close tags pop
    // until their match; unmatched closes are ignored
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    const stack = [];
    let pagesDepth = null;
    const cards = [];        // {id, insidePages, depth, pagesClosed}
    let m;
    while ((m = re.exec(html))) {
        const [, slash, tagRaw, attrs, selfClose] = m;
        const tag = tagRaw.toLowerCase();
        if (slash) {
            const idx = stack.lastIndexOf(tag);
            if (idx >= 0) stack.length = idx;      // unwind through the match
            continue;
        }
        if (VOID.has(tag) || selfClose) continue;
        stack.push(tag);
        const a = {};
        (attrs.match(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g) || [])
            .forEach(kv => {
                const i = kv.indexOf('=');
                a[kv.slice(0, i).trim()] = kv.slice(i + 1).replace(/^"|"$/g, '');
            });
        if (tag === 'div' && a.id === 'pages') pagesDepth = stack.length;
        if (tag === 'section' && /(^|\s)page-card(\s|$)/.test(a.class || ''))
            cards.push({ id: a['data-id'] || '(no data-id)',
                insidePages: pagesDepth !== null && stack.length > pagesDepth,
                depth: stack.length });
    }
    return { cards, unclosed: stack.filter(t => t !== 'html' && t !== 'body') };
}

test('every section.page-card is inside #pages (applyTab visibility set)', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const { cards } = walk(html);
    assert.ok(cards.length >= 15, 'sanity: the page-card census found '
        + cards.length + ' — the file shape changed beyond this test');
    const stray = cards.filter(c => !c.insidePages).map(c => c.id);
    assert.deepStrictEqual(stray, [],
        'these page-cards sit OUTSIDE #pages and would show under every tab');
});

test('#pages opens exactly once and every page-card shares one depth', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const { cards } = walk(html);
    const depths = [...new Set(cards.map(c => c.depth))];
    assert.strictEqual(depths.length, 1,
        'page-cards live at mixed depths: ' + depths.join(','));
});

test('the page-card census covers every tab (nav parity smoke)', () => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    const { cards } = walk(html);
    const tabs = new Set();
    const re = /data-tab="([a-z-]+)"/g;
    // tabs are carried on the card tags themselves — recapture via attrs
    (html.match(/<section class="[^"]*page-card[^"]*"[^>]*>/g) || [])
        .forEach(t => {
            const m = t.match(/data-tab="([a-z-]+)"/);
            if (m) tabs.add(m[1]);
        });
    // 'status' deliberately has NO page-card: it is the GridStack board
    ['models', 'bench', 'chat', 'usage', 'logs', 'settings']
        .forEach(t => assert.ok(tabs.has(t), 'no page-card carries tab ' + t));
    void cards;
});
