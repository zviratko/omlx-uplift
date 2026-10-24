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
