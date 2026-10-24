// UP-34 gate: chat stream-integrity + delete-semantics pins (static source
// contract — the live behaviors were reproduced in the board 2026-10-24).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'), 'utf8');

function section(startMark, endMark) {
    const a = SRC.indexOf(startMark);
    assert.notStrictEqual(a, -1, 'missing start mark: ' + startMark);
    const b = SRC.indexOf(endMark, a);
    assert.notStrictEqual(b, -1, 'missing end mark: ' + endMark);
    return SRC.slice(a, b);
}

test('stopAndSettle exists and is guarded by _streaming', () => {
    const s = section('function stopAndSettle()', 'async function openConv');
    assert.match(s, /if \(!_streaming \|\| !_dc\) return Promise\.resolve\(\);/);
    assert.match(s, /querySelectorAll\('\.input-button'\)/);
    assert.match(s, /btns\[btns\.length - 1\]/);   // outside-end stop button
    assert.match(s, /setTimeout\(res, 80\)/);      // one settle tick
});

test('9b: BOTH conversation-change paths settle the live stream first', () => {
    const oc = section('async function openConv(id) {', 'function refreshConvList');
    assert.match(oc, /if \(id === \(_conv && _conv\.id\)\) return;\s*\n\s*await stopAndSettle\(\);/);
    const nc = section("newBtn.addEventListener('click'", "var top = el('div'");
    assert.match(nc, /stopAndSettle\(\)\.then\(function \(\) \{/);
    assert.ok(nc.indexOf('stopAndSettle') < nc.indexOf('_conv = newConv()'),
        'settle must run before the _conv swap');
});

test('9d: stop cancels the in-flight reader before aborting (classic cancelStreamTransport)', () => {
    const h = section('var liveReader = null;', 'var msgs = req.messages.slice();');
    assert.match(h, /liveReader\.cancel\('Stopped by user'\)/);
    const cancelAt = h.indexOf('liveReader.cancel');
    const abortAt = h.indexOf('controller.abort()');
    assert.ok(cancelAt !== -1 && abortAt > cancelAt, 'cancel must precede abort');
    const once = section("fetch('/v1/chat/completions', {   // domkit-exempt", 'function pump() {');
    assert.match(once, /liveReader = reader;/);   // every round re-tracks its reader
});

test('1d: msgDelete truncates classic-style and auto-deletes an emptied chat', () => {
    const s = section('function msgDelete(idx) {', '\n}');
    assert.match(s, /if \(_streaming\) return;/);
    // user row -> drop from index; assistant row -> back to (and including)
    // its user turn: the reverse scan for role 'user' is the sliceToUserTurn port
    assert.match(s, /if \(m\.role !== 'user'\)/);
    assert.match(s, /ms\[i\]\.role === 'user'\) \{ from = i \+ 1; break; \}/);
    assert.match(s, /ms\.splice\(from\);/);
    assert.doesNotMatch(s, /_conv\.messages\.splice\(idx, 1\)/);   // old one-row splice retired
    assert.match(s, /if \(!ms\.length\)/);
    assert.match(s, /deleteJson\(api\(\) \+ '\/chat\/history\//);  // emptied chat deleted
});

test('5e: tool timeout matches classic chat.html TOOL_TIMEOUT_MS (30s)', () => {
    const m = SRC.match(/var TOOL_TIMEOUT_MS = (\d+);/);
    assert.ok(m, 'TOOL_TIMEOUT_MS present');
    assert.strictEqual(m[1], '30000');
    // classic source of truth (mirror repo may be absent in CI — pin skips then)
    const classic = path.join(__dirname, '..', '..', 'omlx-upstream',
        'apps', 'omlx-web', 'omlx_web', 'templates', 'chat.html');
    if (fs.existsSync(classic)) {
        assert.match(fs.readFileSync(classic, 'utf8'), /TOOL_TIMEOUT_MS: 30000,/);
    }
});
