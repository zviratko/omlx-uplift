/* FE-1 (SWEEP183 H) proof-of-door: an extracted UI module is now unit-
   testable in node without a browser. domkit.js (the primitives that used
   to leak through 11 late-bound glues) is a dual-export UMD; a small vm
   sandbox — core + domkit + state + a ~60-line DOM stub — is enough to
   run the REAL uplift_patches.js render pipeline and assert on rendered
   chips. This is the door the glue consolidation opened; extend it to
   more modules rather than re-inventing harnesses.

   Contract under test (UX-1 + card basics):
   - source.insecure_tls=true   -> INSECURE chip on the card head
   - source.insecure_tls absent -> no INSECURE chip
   - state/enabled counts land in the status line
   - a 401 from the API renders the sign-in copy, not 'API unavailable' */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function makeEl(tag) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {},
        className: '', textContent: '', title: '', hidden: false,
        innerHTML: '', checked: false, disabled: false, value: '',
        append(...kids) { this.children.push(...kids); },
        appendChild(k) { this.children.push(k); return k; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return makeEl('div'); },
        querySelectorAll() { return []; },
        remove() {}, focus() {}, blur() {}, setAttribute() {},
        getAttribute() { return null; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        oninput: null, onchange: null, onclick: null,
    };
    return el;
}
function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children) s += ' ' + allText(k);
    return s;
}

function loadPatchesModule({ patchesPayload, fetchImpl } = {}) {
    const byId = {};
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        querySelector() { return makeEl('div'); },
        querySelectorAll() { return []; },
        addEventListener() {}, hidden: false,
        documentElement: makeEl('html'),
        body: makeEl('body'),
    };
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
        Error, Number, String, Object, Array, RegExp, Set, Map, encodeURIComponent,
        fetch: fetchImpl || (async () => { throw new Error('no fetch in test'); }),
        document,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['core.js', 'domkit.js']) {
        vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'),
                        sandbox, { filename: f });
    }
    // minimal state stand-in (uplift_state.js needs more of the browser)
    vm.runInContext(`window.Uplift = window.Uplift || {};
        window.Uplift.state = { API: '', PT_DATA: null, PT_BUSY: false };
        window.Uplift._patchesGlue = { currentTab: () => 'settings',
                                       currentSub: () => 'patches' };`, sandbox);
    vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8'),
                    sandbox, { filename: 'uplift_patches.js' });
    if (patchesPayload !== undefined) sandbox.__payload = patchesPayload;
    return sandbox;
}

const basePatch = (over = {}) => Object.assign({
    id: 'demo-patch', state: 'applied', enabled: true, scope: 'omlx',
    source: { kind: 'github_pr', repo: 'a/b', pr: 1 },
    versions: [], applied_v: 1,
}, over);

function payload(patches, extra = {}) {
    return Object.assign({ patches, warning: false, kill_switch_active: false,
                           config: { auto_update_check: false } }, extra);
}

async function runPoll(sandbox, payloadObj) {
    const routes = {
        '/uplift/api/patches': payloadObj,
        '/uplift/api/patches/curated/sync': { report: {}, notes: [] },
        '/uplift/api/dev/status': { installed: false, reason: 'test' },
    };
    sandbox.fetch = async (url) => {
        const key = Object.keys(routes).find(k => String(url).endsWith(k));
        if (!key) return { ok: false, status: 404, statusText: 'nf',
                           json: async () => ({}), text: async () => 'nf',
                           clone() { return this; } };
        const body = routes[key];
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)),
                 clone() { return this; }, text: async () => '' };
    };
    await vm.runInContext('window.Uplift.patches.pollPatches()', sandbox);
    await new Promise(r => setImmediate(r));
}

test('renderPatches: INSECURE chip appears exactly when source.insecure_tls', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([
        basePatch(),
        basePatch({ id: 'risky-patch', source: { kind: 'url', url: 'https://x/y.diff', insecure_tls: true } }),
    ]));
    const list = sb.document.getElementById('pt-list');
    const cards = list.children.filter(c => (c.className || '').includes('pt-card'));
    assert.equal(cards.length, 2, 'two runtime cards rendered');
    const texts = cards.map(c => allText(c));
    assert.ok(!texts[0].includes('INSECURE'), 'clean card has no INSECURE chip');
    assert.ok(texts[1].includes('INSECURE'), 'insecure card carries the chip');
    // counts line: 2 loaded, 2 active
    assert.match(sb.document.getElementById('pt-sub').textContent, /2 loaded · 2 active/);
});

test('renderPatches: warning banner + needs_review card class', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch({ state: 'needs_review', enabled: false })],
                              { warning: true }));
    assert.equal(sb.document.getElementById('pt-warn').hidden, false, 'banner shown');
    const card = sb.document.getElementById('pt-list').children
        .find(c => (c.className || '').includes('pt-card'));
    assert.ok((card.className || '').includes('pt-card-warn'), 'warn class on card');
    assert.match(sb.document.getElementById('pt-sub').textContent, /1 loaded · 0 active/);
});

test('pollPatches: 401 renders sign-in copy, not generic API failure', async () => {
    const sb = loadPatchesModule();
    sb.fetch = async (url) => ({
        ok: false, status: 401, statusText: 'Unauthorized',
        json: async () => ({ detail: 'admin session required' }),
        clone() { return this; }, text: async () => 'unauthorized',
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    const txt = allText(sb.document.getElementById('pt-list'));
    assert.match(txt, /Sign in required/);
    assert.ok(!/API unavailable/.test(txt), 'generic copy must not win on 401');
});

test('domkit is require()able in node (dual export)', () => {
    const D = require(path.join(STATIC_DIR, 'domkit.js'));
    for (const fn of ['$', 'fetchJson', 'postJson', 'putJson', 'deleteJson', 'toast', 'cell', 'emptyMsg'])
        assert.equal(typeof D[fn], 'function', `domkit.${fn} missing`);
});
