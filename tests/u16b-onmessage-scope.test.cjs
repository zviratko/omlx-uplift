// U16-B (live-board regression guard): the onMessage handler runs in the
// mount() closure; the ctx ring renderer lives in the rail-builder
// closure. A direct cross-closure call threw inside onMessage and killed
// the assistant row push (usage block) — found live 2026-10-24, invisible
// to fixtures that never set _turnUsage. This test both PINS the holder
// pattern and EXERCISES onMessage with usage set through a built rail.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'), 'utf8');

test('onMessage never calls ctxRender directly — only the _ctxRender holder', () => {
    const i = SRC.indexOf('dc.onMessage = function');
    assert.ok(i > 0, 'onMessage present');
    // function body region: up to the matching end (brace-walk)
    let depth = 0, j = SRC.indexOf('{', i), end = j;
    for (let k = j; k < SRC.length; k++) {
        if (SRC[k] === '{') depth++;
        else if (SRC[k] === '}') { depth--; if (!depth) { end = k; break; } }
    }
    const body = SRC.slice(j, end);
    const bare = body.match(/(^|[^.\w$])ctxRender\(\)/);
    assert.ok(!bare, 'bare ctxRender() call inside onMessage crosses closures');
    assert.match(body, /if \(_ctxRender\) _ctxRender\(\);/);
});

test('openConv uses the holder too', () => {
    const i = SRC.indexOf('async function openConv');
    const seg = SRC.slice(i, i + 1200);
    assert.match(seg, /if \(_ctxRender\) _ctxRender\(\);/);
});

test('the rail builder publishes the holder where it defines ctxRender', () => {
    const def = SRC.indexOf('function ctxRender()');
    assert.ok(def > 0);
    const after = SRC.slice(def, def + 4000);
    assert.match(after, /_ctxRender = ctxRender;/);
});
