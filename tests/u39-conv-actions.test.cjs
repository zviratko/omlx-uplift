// UP-39 gate: conversation-list actions wired (pin-first sort, title
// filter, pin toggle, inline rename, per-row stop). Pattern pins on the
// shipped source — doctrine of the other u3x gates.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'), 'utf8');

test('pinned-first sort keeps newest-first inside each group', () => {
    assert.match(SRC, /shown = shown\.filter\(function \(s\) \{ return s\.pinned; \}\)/);
    assert.match(SRC, /\.concat\(shown\.filter\(function \(s\) \{ return !s\.pinned; \}\)\)/);
});

test('title filter box drives _convSearch + rerenders', () => {
    assert.match(SRC, /sch = document\.createElement\('input'\)/);
    assert.match(SRC, /_convSearch = sch\.value \|\| ''; refreshConvList\(\);/);
    assert.match(SRC, /indexOf\(q\) >= 0/);
});

test('pin toggle: active chat via saveConv, others via full fetch + POST', () => {
    assert.match(SRC, /_conv\.pinned = !s\.pinned;\s*\n\s*saveConv\(\); refreshConvList\(\); return;/);
    assert.match(SRC, /full\.pinned = !full\.pinned;/);
    assert.match(SRC, /postJson\(api\(\) \+ '\/chat\/history', full\)/);
});

test('rename is inline dblclick with Enter-save / Escape-cancel', () => {
    assert.match(SRC, /b\.addEventListener\('dblclick', function \(\) \{ convRename\(s, b\); \}\)/);
    assert.match(SRC, /key === 'Enter'.*done\(true\)/s);
    assert.match(SRC, /key === 'Escape'\) done\(false\)/);
    assert.match(SRC, /title = v;\s*\n\s*return D\(\)\.postJson/);
});

test('stop button only on the active row while streaming', () => {
    assert.match(SRC, /_conv && s\.id === _conv\.id && _streaming/);
    assert.match(SRC, /stop\.addEventListener\('click', function \(ev\) \{\s*\n\s*ev\.stopPropagation\(\); stopAndSettle\(\); \}\)/);
});

/* ---- UP-39b (classic ce43187): compact rows + '...' actions menu ----
   Shape pins (this file's established pattern): the menu, its dismiss
   contract, per-row delete semantics, and the locale coverage of the
   one NEW uplift key. Menu labels reuse classic catalog keys and are
   pinned here on the call shape instead. */
const LOCALES = path.join(__dirname, '..', 'omlx_uplift', 'locales');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift.css'), 'utf8');

test('row carries a \'...\' button appended beside the pin', () => {
    assert.match(SRC, /var more = el\('button', 'chat-conv-more', '⋯'\);/);
    assert.match(SRC, /more\.title = t\('uplift\.chat\.more_actions', 'More actions'\);/);
    // parent-edge chain WITH order: stop (streaming only) -> pin -> more
    assert.match(SRC, /row\.appendChild\(stop\);\s*\}\s*\n\s*row\.appendChild\(pin\);\s*\n\s*row\.appendChild\(more\);/);
});

test('menu offers classic\'s rename + delete with catalog keys', () => {
    assert.match(SRC, /item\('chat\.rename_tooltip', 'Rename chat', null,\s*\n\s*function \(\) \{ convRename\(s, btn\); \}\);/);
    assert.match(SRC, /item\('chat\.delete_tooltip', 'Delete chat', 'danger',\s*\n\s*function \(\) \{ convDelete\(s\); \}\);/);
    // one menu at a time; toggling the same row closes it
    assert.match(SRC, /if \(_convMenu && _convMenu\.s === s\) \{ convMenuClose\(\); return; \}/);
});

test('menu is fixed-position and flips up near the list bottom (classic chatMenuUp)', () => {
    assert.match(CSS, /\.chat-conv-menu \{ position: fixed;/);
    assert.ok(!/\.chat-conv-menu \{[^}]*position: absolute/.test(CSS),
              'absolute would be clipped by the scrolling rail');
    assert.match(SRC, /if \(r\.bottom \+ 4 \+ mh > Math\.min\(lb, vh\)\) top = r\.top - 4 - mh;/);
});

test('delete works on ANY row: confirm first, settle only the live stream', () => {
    // active row: confirm -> stopAndSettle -> reset the page
    assert.match(SRC, /stopAndSettle\(\)\.then\(function \(\) \{ doConvDelete\(s, true\); \}\);/);
    // other rows: plain delete, page untouched
    assert.match(SRC, /doConvDelete\(s, false\);/);
    assert.match(SRC, /if \(wasCurrent\) \{[\s\S]{0,200}?_conv = newConv\(\);/);
    // confirm precedes BOTH paths (two sites inside convDelete)
    const cd = SRC.slice(SRC.indexOf('function convDelete(s) {'), SRC.indexOf('function doConvDelete(s'));
    assert.ok(/var CONFIRM = t\('chat\.confirm_delete_chat'/.test(cd));
    assert.equal(cd.split('window.confirm(CONFIRM)').length - 1, 2);
});

test('dismiss contract: deferred doc click, capture Escape with stopPropagation, scroll closes, listeners detach', () => {
    assert.match(SRC, /setTimeout\(function \(\) \{[\s\S]{0,150}?d\.addEventListener\('click', convMenuClose\);[\s\S]{0,340}?\}, 0\);/);
    assert.match(SRC, /d\.addEventListener\('keydown', m\._dismiss, true\);/);
    assert.match(SRC, /document\.removeEventListener\('keydown', m\._dismiss, true\);/);
    assert.match(SRC, /d\.addEventListener\('scroll', m\._dismissScroll, true\);/);
    const dis = SRC.slice(SRC.indexOf('m._dismiss = function'), SRC.indexOf('m._dismissScroll ='));
    assert.match(dis, /ev\.stopPropagation\(\);/);   // borrowed-Escape: never also cuts the stream
});

test('uplift.chat.more_actions exists in every locale, translated', () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en.json'), 'utf8'));
    assert.equal(en['uplift.chat.more_actions'], 'More actions');
    const files = fs.readdirSync(LOCALES).filter(f => f.endsWith('.json'));
    assert.ok(files.length >= 10, 'expected the full locale set');
    for (const f of files) {
        if (f === 'en.json') continue;
        const d = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));
        assert.ok(d['uplift.chat.more_actions'], f + ' missing key');
        assert.notEqual(d['uplift.chat.more_actions'], 'More actions', f + ' untranslated');
    }
});

test('rows are compacted like classic (4px -> 3px row pad)', () => {
    assert.match(CSS, /\.chat-native-conv \{ text-align: left; font-size: 11px; padding: 3px 6px;/);
});
