/* NAT-6 behavioural proof: the mode ladder is EXTRACTED FROM uplift.js and
   run (uplift.js is a browser IIFE that cannot be require()d whole, so the
   same slicing pattern as the U42/applyI18n tests applies). This checks
   behaviour, not just source shape — the structural pins live in
   nat6-classic-fallback.test.cjs. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift.js'), 'utf8');

function slice(start, end) {
    const a = js.indexOf(start);
    const b = js.indexOf(end, a);
    assert.ok(a > 0 && b > a, 'slice found: ' + start);
    return js.slice(a, b);
}

/* Build the router with a fake server flag, localStorage and hash. */
function makeRouter(nativeSurfaces, ls, hash) {
    const store = new Map(Object.entries(ls || {}));
    const sandbox = {
        documentElement: { dataset: { nativeSurfaces } },
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, v),
        },
        location: { hash: hash || '', pathname: '/uplift/', search: '' },
        history: { replaceState(_, __, url) { sandbox.location.hash = (url || '').split('#')[1] ? '#' + (url || '').split('#')[1] : ''; } },
    };
    const src =
        "const document = {documentElement: D.documentElement, querySelectorAll: () => []};" +
        "const localStorage = D.localStorage;" +
        "const location = D.location; const history = D.history;" +
        slice("const NATIVE_SURFACES =", "/* Cards that the bench/chat surface switch owns") +
        "\nreturn {surfaceMode, nativeAvailable, setClassicMode, syncClassicHash, classicTabs};";
    const f = new Function('D', src)(sandbox);
    f._store = store;
    return f;
}

test('NAT-6 behaviour: server flag off => classic for everything', () => {
    const r = makeRouter('off', {}, '#bench/throughput');
    assert.equal(r.surfaceMode('bench', 'throughput'), 'classic');
    assert.equal(r.surfaceMode('chat', 'chat'), 'classic');
});

test('NAT-6 behaviour: default (flag all, nothing chosen) => native', () => {
    const r = makeRouter('all', {}, '#bench/throughput');
    assert.equal(r.surfaceMode('bench', 'throughput'), 'native');
    assert.equal(r.surfaceMode('chat', 'chat'), 'native');
});

test('NAT-6 behaviour: per-surface classic choice from localStorage', () => {
    const r = makeRouter('all', { 'uplift-classic-embed': 'chat' }, '#chat/chat');
    assert.equal(r.surfaceMode('chat', 'chat'), 'classic');
    assert.equal(r.surfaceMode('bench', 'throughput'), 'native');
});

test('NAT-6 behaviour: the /classic hash leg outranks a stale LS ' + "choice (shared link lands embed)", () => {
    const r = makeRouter('all', { 'uplift-classic-embed': 'off-nothing' }, '#chat/chat/classic');
    assert.equal(r.surfaceMode('chat', 'chat'), 'classic');
});

test('NAT-6 behaviour: native-only subs (ane/embed/rerank/decision) can never be classic', () => {
    const r = makeRouter('all', { 'uplift-classic-embed': 'bench' }, '#bench/ane');
    assert.equal(r.surfaceMode('bench', 'ane'), 'native', 'ANE has no embed twin');
});

test('NAT-6 behaviour: setClassicMode round-trips through localStorage', () => {
    const r = makeRouter('all', {}, '#bench/throughput');
    r.setClassicMode('bench', true);
    assert.deepEqual(r.classicTabs(), ['bench']);
    r.setClassicMode('bench', false);
    assert.deepEqual(r.classicTabs(), []);
});

test('NAT-6 behaviour: syncClassicHash appends the /classic leg when mode is classic', () => {
    // source-sliced router (uplift.js is a browser IIFE; the new Function
    // pattern is the repo's established test harness — see the U42 test).
    const D = {
        documentElement: { dataset: { nativeSurfaces: 'all' } },
        store: new Map([['uplift-classic-embed', 'chat']]),
        location: { hash: '#chat/chat', pathname: '/uplift/', search: '' },
        history: { calls: [], replaceState(_, __, url) { this.calls.push(url); } },
    };
    const sandbox = {
        document: { documentElement: D.documentElement, querySelectorAll: () => [] },
        localStorage: {
            getItem: k => (D.store.has(k) ? D.store.get(k) : null),
            setItem: (k, v) => D.store.set(k, v),
        },
        location: D.location, history: D.history,
    };
    const src =
        "const document = S.document; const localStorage = S.localStorage;" +
        "const location = S.location; const history = S.history;" +
        slice("const NATIVE_SURFACES =", "/* Cards that the bench/chat surface switch owns") +
        slice("function syncClassicHash", "function nativeSurfaceOn") +
        "\nreturn {syncClassicHash};";
    const f = new Function('S', src)(sandbox);
    f.syncClassicHash('chat', 'chat');
    assert.deepEqual(D.history.calls, ['/uplift/#chat/chat/classic'],
        'the classic route got the shareable third leg');
});
