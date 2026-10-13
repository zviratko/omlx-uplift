/* U-DL (2026-10-13) regression pins — embed bench "Download does nothing".

   Three silent killers, all text-level provable without a DOM:
   1. dropMenu/dlMenu entry handlers must DETACH the menu BEFORE running
      the action. The action (dlFile anchor click) bubbles to the
      document-level dismiss listener which nulls `open`; a stale
      `open.remove()` after it threw 'Cannot read properties of null'
      after EVERY download.
   2. dlFile must not revoke the blob URL (or detach the anchor)
      synchronously after click() — Safari/Firefox read it asynchronously
      and the download silently vanished. Revoke must live in setTimeout.
   3. results-head menus need a positioned ancestor or they pin to the
      page's initial containing block (opened ~400px from the button). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const JS = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');
const CSS = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

test('U-DL: both menu factories detach the open menu before the action', () => {
    const closes = JS.match(/var o = open; open = null;\s*\n\s*if \(o\) o\.remove\(\);/g) || [];
    assert.ok(closes.length >= 2,
        'dropMenu AND dlMenu must close-before-action (found ' + closes.length + ')');
    // and no handler may remove `open` AFTER invoking the action
    assert.ok(!/f\[\d\]\([^)]*\);\s*\n\s*open\.remove\(\); open = null;/.test(JS),
        'stale open.remove() after the action call is the crash we fixed');
});

test('U-DL: dlFile revokes the blob URL only inside a setTimeout', () => {
    const m = JS.match(/function dlFile[\s\S]*?\n}/);
    assert.ok(m, 'dlFile still exists');
    const body = m[0];
    const afterClick = body.slice(body.indexOf('a.click();'));
    assert.ok(afterClick.includes('setTimeout'),
        'nothing may be torn down synchronously after a.click()');
    assert.ok(afterClick.indexOf('setTimeout') < afterClick.indexOf('revokeObjectURL'),
        'anchor detach + revoke must be deferred (Safari async blob read)');
    assert.ok(/setTimeout\(function \(\) \{[\s\S]*?revokeObjectURL\(url\)/.test(afterClick),
        'the deferred block must do both a.remove() and the revoke');
});

test('U-DL: results-head menus anchor to the head, right-aligned', () => {
    const headRule = CSS.match(/\.bench-results-head \{[^}]*\}/);
    assert.ok(headRule && /position:\s*relative/.test(headRule[0]),
        '.bench-results-head must be positioned');
    assert.ok(/\.bench-results-head \.bench-dl-menu \{[^}]*left:\s*auto;[^}]*right:\s*0/.test(CSS),
        'menu must open under the (right-aligned) buttons, not at left:0 of the page');
});
