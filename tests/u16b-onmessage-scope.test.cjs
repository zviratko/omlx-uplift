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

test('the rail builder publishes the holder in the closure that defines ctxRender', () => {
    const def = SRC.indexOf('function ctxRender()');
    assert.ok(def > 0, 'ctxRender defined');
    // The invariant U16-B needs is SAME-CLOSURE, not "within N characters":
    // a fixed slice was stale the moment the mount moved (QA 2026-10-25), so
    // walk the enclosing builder body by braces and check inside it instead.
    const head = SRC.lastIndexOf('\nfunction toolbar(');
    assert.ok(head > 0 && head < def, 'ctxRender lives in toolbar()');
    let depth = 0, end = SRC.indexOf('{', head);
    for (let k = end; k < SRC.length; k++) {
        if (SRC[k] === '{') depth++;
        else if (SRC[k] === '}') { depth--; if (!depth) { end = k; break; } }
    }
    assert.match(SRC.slice(head, end), /_ctxRender = ctxRender;/,
        'holder published in the defining closure (never cross-closure)');
});

test('UP-16: the ring mounts on the assembled node, never on a document lookup', () => {
    // WHY: the ring was built and then mounted through
    // gid('chat-native-model') — looked up while the whole top bar was still a
    // DETACHED tree. The lookup found nothing, the guard skipped it quietly and
    // the gauge never appeared in a live browser for its entire life. The mount
    // must therefore use the local group node and have no skip path at all.
    const mount = SRC.indexOf('modelGroup.append(ctxWrap, ctxPend)');
    assert.ok(mount > 0, 'ring mounts onto the model group node');
    assert.ok(SRC.indexOf('var modelGroup = group(') < mount,
        'the group node exists before the mount uses it');
    assert.ok(SRC.indexOf('top.append(') < mount,
        'mount happens during bar assembly, after the group is built');
    // the OLD shape must be gone for good: re-lookup, then append through the
    // parent. (gid() itself stays legal elsewhere — after mount(), the bar IS
    // attached and four later call sites read the picker by id.)
    assert.ok(!/modelSel/.test(SRC), 'the detached-lookup intermediary is gone');
    assert.ok(!/parentNode\.append\(ctxWrap/.test(SRC),
        'the ring is never mounted through a re-found parent');
});

test('UP-16: a missing arc cannot throw through the bar build', () => {
    // ctxWrap fills its <svg> via innerHTML, so a renderer that trusts the arc
    // to exist dies on it — and ctxRender runs inside the toolbar build AND
    // inside onMessage, where a throw costs the assistant row (the U16-B loss).
    const i = SRC.indexOf('function ctxRender()');
    const body = SRC.slice(i, SRC.indexOf('\n    }', i));
    assert.match(body, /if \(!arc\) return;/,
        'the gauge bails instead of throwing when its markup is absent');
});
