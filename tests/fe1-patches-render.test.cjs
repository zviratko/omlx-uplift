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
        className: '', textContent: '', title: '',
        hidden: false,   // index.html ships the banners hidden by attribute
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
        createTextNode(t) {
            return { textContent: String(t), children: [], className: '' };
        },
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
        window.Uplift.state = { API: '', PT_DATA: null, PT_DOCTOR: null, PT_BUSY: false };
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

async function runPoll(sandbox, payloadObj, doctorReport) {
    const routes = {
        '/uplift/api/patches': payloadObj,
        '/uplift/api/patches/curated/sync': { report: {}, notes: [] },
        '/uplift/api/dev/status': { installed: false, reason: 'test' },
    };
    if (doctorReport !== undefined) routes['/uplift/api/doctor'] = doctorReport;
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

/* KEGID-3: the drift banner is fed by pollDoctor() inside pollPatches()
   (fire-and-forget — flush two microtask rounds to see its verdict). */
const driftRep = (over = {}) => Object.assign({
    ok: false, skipped_reason: null, n_checked: 692, n_expected: 0,
    unexpected: [{ path: 'omlx/model_settings.py', kind: 'hash' }],
}, over);

test('drift banner: unexpected drift paints path + count, alarm copy', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]), driftRep({
        unexpected: [
            { path: 'omlx/a.py', kind: 'hash' },
            { path: 'omlx/b.py', kind: 'missing' },
        ] }));
    await new Promise(r => setImmediate(r));
    const el = sb.document.getElementById('pt-drift');
    assert.equal(el.hidden, false, 'banner shown on drift');
    assert.match(el.textContent, /TREE DRIFT/);
    assert.match(el.textContent, /2 installed oMLX files/);
    assert.match(el.textContent, /omlx\/a\.py/);
    assert.match(el.title, /missing omlx\/b\.py/, 'title lists every file');
});

test('drift banner: clean census stays hidden', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]), { ok: true, skipped_reason: null,
        n_checked: 692, unexpected: [] });
    await new Promise(r => setImmediate(r));
    assert.equal(sb.document.getElementById('pt-drift').hidden, true);
});

test('drift banner: doctor failure is silent, page unaffected', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]));   // no /doctor route -> 404
    await new Promise(r => setImmediate(r));
    const el = sb.document.getElementById('pt-drift');
    assert.equal(el.hidden, true, 'no alarm on a failed probe');
    // the patches page itself still rendered fine
    assert.match(sb.document.getElementById('pt-sub').textContent, /1 loaded/);
});

test('renderPatches: INSECURE chip appears exactly when source.insecure_tls', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([
        basePatch(),
        basePatch({ id: 'risky-patch', source: { kind: 'url', url: 'https://x/y.diff', insecure_tls: true } }),
    ]));
    const list = sb.document.getElementById('pt-list');
    const cards = list.children.filter(c => (c.className || '').includes('pt-entry'));
    assert.equal(cards.length, 2, 'two patch rows rendered');
    const texts = cards.map(c => allText(c));
    assert.ok(!texts[0].includes('INSECURE'), 'clean card has no INSECURE chip');
    assert.ok(texts[1].includes('INSECURE'), 'insecure card carries the chip');
    // counts line: 2 loaded, 2 active
    assert.match(sb.document.getElementById('pt-sub').textContent, /2 loaded · 2 active/);
});

test('renderPatches: keg_changed splits restart-fixes vs per-board failure', async () => {
    // RUNTIME-MOUNT: two boards share one store. A patch live elsewhere but
    // pending here is a restart away; a per-keg APPLY FAILURE must never
    // tell the operator to restart — restart is proven not to help.
    const sb = loadPatchesModule();
    await runPoll(sb, payload([
        basePatch({ id: 'pending-here', keg_changed: true }),
        basePatch({ id: 'failed-here', keg_changed: true, this_keg: 'error',
                    this_keg_detail: 'apply failed: context mismatch at hunk 2' }),
    ]));
    const cards = sb.document.getElementById('pt-list').children
        .filter(c => (c.className || '').includes('pt-entry'));
    assert.equal(cards.length, 2);
    const texts = cards.map(c => allText(c));
    const allTitles = (el) => (el.title ? el.title + ' ' : '') +
        el.children.map(allTitles).join(' ');
    const titles = cards.map(allTitles);
    assert.ok(texts[0].includes('NEEDS RE-APPLY'),
              'pending on this board asks for the restart that fixes it');
    assert.ok(!texts[0].includes('REVIEW'), '...not the failure chip');
    assert.ok(texts[1].includes('REVIEW'), 'per-board apply failure gets REVIEW');
    assert.ok(!texts[1].includes('NEEDS RE-APPLY'),
              'restart copy is withheld when restart cannot help');
    assert.ok(titles[1].includes('context mismatch'),
              'the real per-keg reason rides the tooltip');
});

test('renderPatches: warning banner + needs_review card class', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch({ state: 'needs_review', enabled: false })],
                              { warning: true }));
    assert.equal(sb.document.getElementById('pt-warn').hidden, false, 'banner shown');
    const card = sb.document.getElementById('pt-list').children
        .find(c => (c.className || '').includes('pt-entry'));
    assert.ok((card.className || '').includes('pt-entry-warn'), 'warn class on row');
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

/* PAT-TABLE (user ask 2026-10-19): ONE table, one row per patch,
   regardless of whether the omlx-dev carrier is present — the retired
   two-zone split could hide a 'both' card behind zone ownership; a row
   must never vanish or double. */
const rowsOf = (sb) => sb.document.getElementById('pt-list').children
    .filter(c => (c.className || '').includes('pt-entry'));

test('PAT-TABLE: one row per patch when the build carrier is present', async () => {
    const sb = loadPatchesModule();
    sb.Uplift.devpanel = { installed: () => true, renderDev: () => {} };
    await runPoll(sb, payload([
        basePatch({ id: 'rt-only', scope: 'omlx' }),
        basePatch({ id: 'baked', scope: 'both' }),
        basePatch({ id: 'build-only', scope: 'dev' }),
    ]));
    const rows = rowsOf(sb);
    assert.equal(rows.length, 3, 'every patch gets exactly one row');
    const t = rows.map(c => allText(c));
    assert.ok(t.every(x => !/RUNTIME|BUILD ONLY/.test(x)),
              'no zone headings left in the table');
    // counts line tracks the whole manifest now, not one zone
    assert.match(sb.document.getElementById('pt-sub').textContent,
                 /3 loaded · 3 active/);
});

test('PAT-TABLE: no carrier -> still one row per patch', async () => {
    const sb = loadPatchesModule();
    sb.Uplift.devpanel = { installed: () => false, renderDev: () => {} };
    await runPoll(sb, payload([
        basePatch({ id: 'rt-only', scope: 'omlx' }),
        basePatch({ id: 'baked', scope: 'both' }),
        basePatch({ id: 'build-only', scope: 'dev' }),
    ]));
    const rows = rowsOf(sb);
    assert.equal(rows.length, 3, 'all three render here; none vanishes');
});

test('patches export refill for the devpanel carrier-truth repaint', () => {
    const sb = loadPatchesModule();
    assert.equal(typeof sb.Uplift.patches.refill, 'function');
});

/* CARRIER-REFRESH (user report 2026-10-19): the DRIFT / NEEDS REBUILD
   chips (DRIFT / NEEDS REBUILD) ride /dev/status, which
   the patches page read ONLY at page load (DV_POLL runs just during a
   build). A Remove that emptied the drift set left the stale DRIFT chip
   lit until a full page refresh. Every store mutation must re-read the
   carrier the moment it lands. */
const btnIn = (el, label) => {
    for (const c of el.children || []) {
        if (typeof c.onclick === 'function'
            && String(c.textContent).includes(label)) return c;
        const hit = btnIn(c, label);
        if (hit) return hit;
    }
    return null;
};

async function removeFlow(sb) {
    const calls = { remove: 0, failedToast: '' };
    sb.confirm = () => true;
    sb.fetch = async (url) => {
        const u = String(url);
        let body = {};
        if (u.endsWith('/uplift/api/patches/remove')) { calls.remove++; body = { ok: true }; }
        else if (u.endsWith('/uplift/api/patches/curated/sync')) body = { report: {}, notes: [] };
        else if (u.endsWith('/uplift/api/patches')) body = payload([]);
        else if (u.endsWith('/uplift/api/dev/status')) body = { installed: true };
        else if (u.endsWith('/uplift/api/doctor')) body = { ok: true, skipped_reason: null, n_checked: 1, unexpected: [] };
        return { ok: true, status: 200,
                 json: async () => JSON.parse(JSON.stringify(body)),
                 text: async () => '', clone() { return this; } };
    };
    const card = sb.document.getElementById('pt-list').children
        .find(c => (c.className || '').includes('pt-entry'));
    assert.ok(card, 'a patch row is on screen to remove');
    // PAT-TABLE: Remove lives in the MANAGE dialog — open it first,
    // confirm() is auto-accepted by the harness
    await btnIn(card, 'MANAGE').onclick();
    const overlay = sb.document.body.children
        .filter(c => String(c.className || '').includes('modal-overlay')).slice(-1)[0];
    assert.ok(overlay, 'MANAGE opens a dialog');
    await btnIn(overlay, 'Remove').onclick();
    await new Promise(r => setImmediate(r));
    for (const t of sb.document.getElementById('toasts').children || [])
        if (/failed/i.test(t.textContent)) calls.failedToast = t.textContent;
    return calls;
}

test('remove re-reads /dev/status the moment it lands (stale DRIFT dies with the action)', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]));
    let devReads = 0;
    sb.Uplift.devpanel = { installed: () => true, renderDev: () => {},
                           pollDev: async () => { devReads++; } };
    const calls = await removeFlow(sb);
    assert.equal(calls.remove, 1, 'the Remove POST landed');
    assert.equal(devReads, 1, 'the carrier was re-read exactly once for the action');
    assert.equal(calls.failedToast, '');
});

test('an older devpanel bundle without pollDev never fails the action', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]));
    sb.Uplift.devpanel = { installed: () => true };   // pre-carrier-refresh seam
    const calls = await removeFlow(sb);
    assert.equal(calls.remove, 1, 'the remove still lands');
    assert.equal(calls.failedToast, '',
                 'a missing carrier read must not fail the action: '
                 + calls.failedToast);
});

test('a vanilla-only page (no devpanel file at all) removes cleanly', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]));
    assert.equal(sb.Uplift.devpanel, undefined, 'harness ships without the panel');
    const calls = await removeFlow(sb);
    assert.equal(calls.remove, 1);
    assert.equal(calls.failedToast, '');
});

test('MANAGE Test dry-run releases PT_BUSY in finally so later actions still fire', async () => {
    const sb = loadPatchesModule();
    await runPoll(sb, payload([basePatch()]));
    let tested = 0;
    sb.fetch = async (url) => {
        const u = String(url);
        let body = { ok: true, files: [] };
        if (u.endsWith('/uplift/api/patches/test')) tested++;
        else if (u.endsWith('/uplift/api/patches')) body = payload([basePatch()]);
        return { ok: true, status: 200,
                 json: async () => JSON.parse(JSON.stringify(body)),
                 text: async () => '', clone() { return this; } };
    };
    const card = sb.document.getElementById('pt-list').children
        .find(c => (c.className || '').includes('pt-entry'));
    await btnIn(card, 'MANAGE').onclick();
    const overlay = sb.document.body.children
        .filter(c => String(c.className || '').includes('modal-overlay')).slice(-1)[0];
    await btnIn(overlay, 'Test dry-run').onclick();
    assert.equal(tested, 1);
    assert.equal(sb.Uplift.state.PT_BUSY, false, 'PT_BUSY cleared after dry-run completes');
});
