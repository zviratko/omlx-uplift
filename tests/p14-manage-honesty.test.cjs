/* P1 + P4 render contract (stress harness 2026-10-31).
   The operator report this kills: a card stuck in NEEDS REVIEW after losing
   a boot conflict silently held a fetched v2 — the Manage candidate row was
   gated on state === 'update_available' and the state transition itself was
   refused server-side, so the Promote button did not exist. And there was
   no way to choose WHICH of two colliding patches applies first.

   Proof: vm-mount the REAL uplift_patches.js (fe1 harness — the body
   concatenates ONLY the repository's own checked-in source, no external
   input) and drive the MANAGE dialog. */
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
        className: '', _text: '', title: '',
        hidden: false, checked: false, disabled: false, value: '',
        get textContent() {
            return this._text + (this.children || [])
                .map(k => k.textContent || '').join(' ');
        },
        set textContent(v) { this._text = String(v); this.children.length = 0; },
        append(...kids) {
            for (const k of kids) {
                if (typeof k === 'string') { this.children.push({ textContent: k, children: [] }); continue; }
                if (k) k.parentNode = this;
                this.children.push(k);
            }
        },
        appendChild(k) { this.children.push(k); k.parentNode = this; return k; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        remove() {}, focus() {}, blur() {},
        setAttribute() {}, getAttribute() { return null; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        oninput: null, onchange: null, onclick: null,
    };
    return el;
}

function loadPatchesModule() {
    const byId = {};
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(t) {
            return { textContent: String(t), children: [], get parentNode() { return this._p; },
                     set parentNode(v) { this._p = v; } };
        },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}, hidden: false,
        documentElement: makeEl('html'), body: makeEl('body'),
    };
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
        // initPatchesPage arms an hourly setInterval that would keep the node
        // event loop alive forever; the test drives ptCheckNow directly.
        setInterval: () => 0, clearInterval: () => {},
        Error, Number, String, Object, Array, RegExp, Set, Map,
        encodeURIComponent, parseInt, isFinite, isNaN,
        fetch: async () => { throw new Error('no fetch in test'); },
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
    vm.runInContext(`window.Uplift = window.Uplift || {};
        window.Uplift.state = { API: '', PT_DATA: null, PT_DOCTOR: null, PT_BUSY: false };
        window.Uplift._patchesGlue = { currentTab: () => 'settings',
                                       currentSub: () => 'patches' };`, sandbox);
    vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8'),
                    sandbox, { filename: 'uplift_patches.js' });
    return sandbox;
}

const basePatch = (over = {}) => Object.assign({
    id: 'demo-patch', state: 'applied', enabled: true, scope: 'omlx',
    source: { kind: 'github_pr', repo: 'a/b', pr: 1 },
    versions: [], desired_version: 1, latest_v: 1, applied_v: 1, order: 100,
}, over);

const payload = (patches, extra = {}) => Object.assign(
    { patches, warning: false, kill_switch_active: false,
      config: { auto_update_check: false } }, extra);

function routeFetch(sb, routes) {
    sb.fetch = async (url, opts) => {
        const u = String(url);
        const calls = sb.__calls || (sb.__calls = []);
        calls.push({ url: u, body: opts && opts.body });
        const hit = Object.keys(routes).find(k => u.endsWith(k));
        if (!hit) return { ok: true, status: 200, text: async () => '',
                           json: async () => ({}), clone() { return this; } };
        return { ok: true, status: 200,
                 json: async () => JSON.parse(JSON.stringify(routes[hit])),
                 text: async () => '', clone() { return this; } };
    };
}

const btnIn = (el, label) => {
    for (const c of el.children || []) {
        if (typeof c.onclick === 'function'
            && String(c.textContent || '').includes(label)) return c;
        const hit = btnIn(c, label);
        if (hit) return hit;
    }
    return null;
};

function firstCard(sb) {
    return sb.document.getElementById('pt-list').children
        .find(c => (c.className || '').includes('pt-entry'));
}

function manageOverlay(sb) {
    return sb.document.body.children
        .filter(c => String(c.className || '').includes('modal-overlay')).slice(-1)[0];
}

async function openManage(sb, patchObj) {
    routeFetch(sb, {
        '/uplift/api/patches': payload([patchObj]),
        '/uplift/api/patches/order': { ok: true, order: 5,
            note: 'apply order changes from the next server restart' },
        '/uplift/api/patches/curated/sync': { report: {}, notes: [] },
        '/uplift/api/dev/status': { installed: false },
        '/uplift/api/doctor': { ok: true, skipped_reason: null,
                                n_checked: 1, unexpected: [] },
    });
    await vm.runInContext('window.Uplift.patches.pollPatches()', sb);
    await new Promise(r => setImmediate(r));
    await btnIn(firstCard(sb), 'MANAGE').onclick();
    await new Promise(r => setImmediate(r));
    return manageOverlay(sb);
}

/* ---- P1: the hidden candidate --------------------------------------- */

test('a needs_review card with a stored newer version shows the Apply candidate row', async () => {
    const sb = loadPatchesModule();
    const overlay = await openManage(sb, basePatch({
        state: 'needs_review', desired_version: 1, latest_v: 2,
        versions: [{ v: 1, fetched_at: 'x' }, { v: 2, fetched_at: 'y' }],
        state_detail: "apply failed: context mismatch — collides with 'aaa-say'",
    }));
    assert.ok(overlay, 'MANAGE opens');
    const txt = overlay.textContent;
    assert.ok(txt.includes('v2 fetched and validated'),
        'the waiting candidate is named: ' + txt.slice(0, 400));
    const apply = btnIn(overlay, 'Apply v2 now');
    assert.ok(apply, 'the Promote/Apply button EXISTS on a needs_review card');
});

test('a fully applied card keeps the candidate row away', async () => {
    const sb = loadPatchesModule();
    const overlay = await openManage(sb, basePatch({
        state: 'applied', desired_version: 2, latest_v: 2,
        versions: [{ v: 1 }, { v: 2 }],
    }));
    assert.ok(!overlay.textContent.includes('fetched and validated'),
        'no phantom candidate when desired IS the newest');
});

/* ---- P4: the apply-priority control --------------------------------- */

test('Manage carries the Apply priority row prefilled from the card', async () => {
    const sb = loadPatchesModule();
    const overlay = await openManage(sb, basePatch({ order: 50 }));
    const txt = overlay.textContent;
    assert.ok(txt.includes('Apply priority (lower applies first)'),
        'priority row renders: ' + txt.slice(0, 400));
    const inp = (function find(el) {
        if (el.tagName === 'input' && el.type === 'number') return el;
        for (const c of el.children || []) { const h = find(c); if (h) return h; }
        return null;
    })(overlay);
    assert.ok(inp, 'a number input exists');
    assert.equal(inp.value, '50', 'prefilled with the stored order');
});

test('Save posts the full {id, order} payload to /patches/order', async () => {
    const sb = loadPatchesModule();
    const overlay = await openManage(sb, basePatch());
    const inp = (function find(el) {
        if (el.tagName === 'input' && el.type === 'number') return el;
        for (const c of el.children || []) { const h = find(c); if (h) return h; }
        return null;
    })(overlay);
    inp.value = '5';
    // one button, one verb, unique label — no ambiguity with the version
    // row's generic Save inside the same dialog
    const save = btnIn(overlay, 'Set priority');
    assert.ok(save, 'the priority row has its own Set priority button');
    sb.__calls.length = 0;
    await save.onclick();
    await new Promise(r => setImmediate(r));
    const post = sb.__calls.find(c => c.url.endsWith('/uplift/api/patches/order'));
    assert.ok(post, 'the order POST landed');
    assert.deepEqual(JSON.parse(post.body), { id: 'demo-patch', order: 5 },
        'payload carries id AND the number — not a partial row');
    const toasts = sb.document.getElementById('toasts').children
        .map(t => t.textContent).join(' ');
    assert.ok(toasts.includes('Apply priority set to 5'), toasts);
});

/* ---- P1 check toast honesty ----------------------------------------- */

test('a check verdict that did not adopt explains itself in the toast', async () => {
    const sb = loadPatchesModule();
    routeFetch(sb, {
        '/uplift/api/patches': payload([basePatch()]),
        '/uplift/api/patches/check': { ok: true, reports: {
            'demo-patch': { check: 'update_available', v: 3, promoted: false,
                            reason: 'v3 is stored but not in use — press Promote' } } },
        '/uplift/api/patches/curated/sync': { report: {}, notes: [] },
        '/uplift/api/dev/status': { installed: false },
        '/uplift/api/doctor': { ok: true, skipped_reason: null,
                                n_checked: 1, unexpected: [] },
    });
    // the buttons are wired by the page init (index.html boot does this)
    vm.runInContext('window.Uplift.patches.initPatchesPage()', sb);
    await new Promise(r => setImmediate(r));
    const btn = sb.document.getElementById('pt-check-btn');
    assert.equal(typeof btn.onclick, 'function', 'Check for updates is wired');
    await btn.onclick();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const toasts = sb.document.getElementById('toasts').children
        .map(t => t.textContent).join(' ');
    assert.ok(toasts.includes('update available (v3)'), toasts);
    assert.ok(toasts.includes('press Promote'),
        'the WHY rides the toast — never a bare verdict over a dead card');
});

/* ---- locale self-pin (ptMsg keys are invisible to test_locale_sync) -- */

test('the uplift.patches.order_* keys exist in every locale with equal placeholders', () => {
    const keys = ['uplift.patches.order_label', 'uplift.patches.order_hint',
                  'uplift.patches.order_saved', 'uplift.patches.order_set'];
    const dir = path.join(STATIC_DIR, '..', 'locales');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 10, 'all ten locale files are checked');
    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
    for (const f of files) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of keys) {
            assert.ok(d[k] && d[k].trim().length, `${k} missing in ${f}`);
        }
    }
    const ph = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');
    assert.equal(ph(en['uplift.patches.order_saved']), '{n},{w}',
        'EN keeps both placeholders the JS substitutes');
    // the shipped JS fallbacks must match EN verbatim (ptMsg(key, fallback))
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_patches.js'), 'utf8');
    for (const k of keys) {
        const i = src.indexOf(`'${k}'`);
        assert.ok(i > -1, `key ${k} is actually used by the module`);
        // join the string-concatenated fallback pieces before comparing
        const tail = src.slice(i, i + 400)
            .replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
        assert.ok(tail.includes(en[k]), `JS fallback for ${k} drifted from en.json`);
    }
});
