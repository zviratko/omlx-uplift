/* CARD-1 (user 2026-10-09): model-card header order.
   The name leads line 1 (top-left, bigger), the type badge sits to its RIGHT
   and LEFT of the copy icon, and the FAVOURITE/PINNED/… lamps moved BELOW the
   name. Nothing else may move: the two-line pitch stays 2 x 22px + 4px, the
   action box keeps its geometry, and the alias trunk must follow the name's
   new left edge.

   Source-pattern gate (house style, cf. static-identifier-bindings): the
   geometry itself is asserted live in the browser; what rots silently in
   source is the ORDER of appends and the scope of the size bump, so that is
   what fails here. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const TABLE = read('uplift_mmtable.js');
const TPL = read('uplift_mmtemplates.js');
const CSS = read('uplift.css');

test('present-model row: name line leads the cell, badge sits before the copy icon', () => {
    const append = TABLE.match(/name\.append\(([^)]*)\);/);
    assert.ok(append, 'no name.append() found in the model row');
    assert.strictEqual(append[1].replace(/\s+/g, ' ').trim(), 'nmain, head1',
        'model cell must append the NAME line before the lamp/size/state line');

    // the badge + copy pair is appended together AFTER the uid
    const uidAt = TABLE.indexOf("uid.className = 'uid'");
    const pairAt = TABLE.indexOf("nmain.append(typeC, copyBtn(m.id");
    const uidOnly = TABLE.indexOf('nmain.append(uid);');
    assert.ok(uidAt >= 0 && pairAt > uidAt, 'badge/copy append must come after the name cell');
    assert.ok(uidOnly > 0 && uidOnly > uidAt && uidOnly < pairAt,
        'uid must be appended alone first — otherwise the copy icon lands LEFT of the badge');
});

test('missing-model row keeps the same line order (name first, alias lamp below)', () => {
    const appends = [...TABLE.matchAll(/name\.append\(([^)]*)\);/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
    assert.deepStrictEqual(appends, ['nmain, head1', 'nmain, head1'],
        'both model-row builders must lead with the name line');
});

test('CARD-1 scope: template rows are NOT model cards and keep badge-first', () => {
    assert.match(TPL, /nmain\.append\(badge, uid\)/,
        'global-template rows must keep the old order — the user asked for model cards only');
});

test('the size bump is scoped to model cards, never the settings editor', () => {
    const bumps = [...CSS.matchAll(/^([^@\n][^\n]*?)\{\n[^\n]*font: 500 13\.5px/gm)].map(m => m[1].trim());
    assert.ok(bumps.length, 'no 13.5px name font found — the bigger name went missing');
    for (const sel of bumps) {
        assert.match(sel, /#model-admin/, `name-size rule escapes its scope: ${sel}`);
        assert.doesNotMatch(sel, /\.urow\.settings/, `name-size rule hits the settings editor: ${sel}`);
    }
});

test('alias trunk follows the name (indentation the user asked for)', () => {
    const tree = CSS.match(/#model-admin \.alias-tree \{[^}]*\}/);
    assert.ok(tree, 'alias-tree rule vanished');
    const m = tree[0].match(/margin: 0 10px 6px (\d+)px/);
    assert.ok(m, 'alias-tree left margin not found');
    const left = +m[1];
    assert.ok(left >= 20 && left <= 32,
        `trunk indent ${left}px: tree + badge column moved to 24px (user round 4: 'a bit more indentation from the left'); 96px was pre-CARD-1, 16px was round-3`);
});

test('TREE-2d: the trunk is painted by the TREE as uniform-colour measured segments', () => {
    // user 2026-10-09 round 4: "the trunk segments now have a slightly
    // different colour" — risers drawn by the alias lines inherit the dim
    // line's opacity .75. Every segment must be a child of the tree.
    const chips = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmchips.js'), 'utf8');
    assert.match(chips, /className = 'trunk-seg'/,
        'align pass must append .trunk-seg elements to the tree (not ::before on the lines)');
    assert.match(chips, /querySelectorAll\('\.trunk-seg'\)\) s\.remove\(\)/,
        're-measure must clear old segments first (align runs on repaint/resize/fold)');
    assert.doesNotMatch(CSS, /\.alias-line::before \{ content: ""; position: absolute;\s*left: -16px/,
        'the lines must not draw the wire anymore — per-line risers pick up dim-line opacity');
    // the badge line is flush with the alias lines (tree 24 − row padding 2)
    assert.match(CSS, /#model-admin \.mbox \.urow\.admin \.nrow1 \{ padding-left: 22px; \}/,
        'lamps must slot right of the trunk, flush with the alias lines');
    // gap under the badges collapses to the 6px alias rhythm
    assert.match(chips, /lampRow\.getBoundingClientRect\(\)\.bottom \+ 6/,
        'first alias line must pin to badge-bottom + 6px (same gap as alias-to-alias)');
    assert.match(chips, /box\.getBoundingClientRect\(\)\.bottom\);/,
        'the tree must never rise into the settings box (fold-open overlap guard)');
});

test('TREE-1: a cached profile paint must show the tree (no hidden-until-mutation race)', () => {
    // user report 2026-10-09: "after scrolling for a bit, all the model
    // aliases disappear" — the profiles fetch caches 30 s, so aliasTree()
    // can receive an ALREADY-filled profHost; hiding it and waiting for a
    // childList mutation that already happened keeps the tree hidden forever.
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmchips.js'), 'utf8');
    const noAliasBranch = src.split('if (!lines.length) {')[1].split('}')[0];
    assert.match(noAliasBranch, /if \(!profHost\.children\.length\) \{\s*t\.hidden = true;/,
        'the tree may only hide when profHost is EMPTY at build time; the observer is the async fallback');
});
