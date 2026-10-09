/* LOAD-1: a click-fired model load must paint LOADING, not sit on PRESENT.

   Root cause (user report 2026-10-09): the native POST /admin/api/models/
   {id}/load BLOCKS until the engine is ready and it runs inside
   S.trackWrite, so renderModelAdmin's pendingWrites guard freezes the 8 s
   repaint for the whole load — the server's is_loading=true can never
   reach the row while the user watches PRESENT. The fix paints LOADING
   optimistically in uplift_mmtable.js paintLoading() and reverts it when
   the load fails (the success path re-renders from the fresh snapshot).

   The test runs the REAL render pipeline in a vm sandbox (the FE-1 door):
   core + domkit + state stub + chips + table, then clicks the PRESENT
   pill and asserts what the row paints WHILE the POST is still in flight. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

/* ---- minimal DOM stub with real parent/child identity ------------------ */
function makeEl(tag) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {},
        className: '', textContent: '', title: '', hidden: false,
        checked: false, disabled: false, value: '', type: '',
        isConnected: true, parent: null,
        append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } },
        appendChild(k) { k.parent = this; this.children.push(k); return k; },
        insertBefore(k, ref) {
            k.parent = this;
            const i = this.children.indexOf(ref);
            this.children.splice(i < 0 ? this.children.length : i, 0, k);
        },
        prepend(...kids) { this.children.unshift(...kids); for (const k of kids) k.parent = this; },
        replaceWith(n) {
            const p = this.parent; if (!p) return;
            const i = p.children.indexOf(this);
            if (i >= 0) p.children[i] = n;
            n.parent = p;
        },
        remove() {
            const p = this.parent; if (!p) return;
            const i = p.children.indexOf(this);
            if (i >= 0) p.children.splice(i, 1);
            this.parent = null;
        },
        addEventListener() {}, removeEventListener() {},
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        querySelectorAll(sel) {
            // class-only matcher: 'a.b' / '.a b' flattened to one AND-set —
            // enough for the hooks the render path actually uses
            const want = sel.split(/\s+/).flatMap(s => s.split('.')).filter(Boolean);
            const out = [];
            const walk = (e) => {
                for (const k of e.children) {
                    const cls = String(k.className || '').split(/\s+/);
                    if (want.every(w => cls.includes(w))) out.push(k);
                    walk(k);
                }
            };
            walk(this);
            return out;
        },
        focus() {}, blur() {}, setAttribute() {}, getAttribute() { return null; },
        getBoundingClientRect() { return { width: 0, height: 0, x: 0, y: 0, left: 0 }; },
        classList: {
            _set() { return new Set(String(this._el.className || '').split(/\s+/).filter(Boolean)); },
            _put(s) { this._el.className = [...s].join(' '); },
            add(...c) { const s = this._set(); c.forEach(x => s.add(x)); this._put(s); },
            remove(...c) { const s = this._set(); c.forEach(x => s.delete(x)); this._put(s); },
            toggle(c) { const s = this._set(); s.has(c) ? s.delete(c) : s.add(c); this._put(s); },
            contains(c) { return this._set().has(c); },
        },
        oninput: null, onchange: null, onclick: null,
    };
    el.classList._el = el;
    // innerHTML = '' must actually CLEAR children: the table re-renders by
    // emptying the node, and a stub that ignores it double-paints rows
    let _html = '';
    Object.defineProperty(el, 'innerHTML', {
        get: () => _html,
        set: (v) => {
            if (v === '') { for (const k of el.children) k.parent = null; el.children = []; }
            _html = v;
        },
    });
    return el;
}
const segs = root => root.querySelectorAll('lsw-seg').map(s => String(s.textContent).trim());

/* ---- sandbox: the real core + domkit + mmchips + mmtable --------------- */
function loadTableModule(state) {
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
    document.documentElement.dataset.tab = 'status';   // skip the settings-index refetch
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
        Error, Number, String, Object, Array, RegExp, Set, Map, Boolean,
        encodeURIComponent, decodeURIComponent,
        document,
        requestAnimationFrame: fn => setTimeout(fn, 0),
        getComputedStyle: () => ({}),
        MutationObserver: class { observe() {} disconnect() {} },
        addEventListener() {}, removeEventListener() {},
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        fetch: (u, o) => state.fetch(u, o),
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['core.js', 'domkit.js'])
        vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'),
                        sandbox, { filename: f });
    vm.runInContext(`window.Uplift = window.Uplift || {};
        window.Uplift.state = {
            API: '', prefs: {}, settingsIdx: { stored: 0, orphans: [], entries: [], profiles: [] },
            adminModels: null, pendingWrites: 0,
            trackWrite: async function (fn) { window.Uplift.state.pendingWrites++;
                try { return await fn(); } finally { window.Uplift.state.pendingWrites--; } },
        };
        window.Uplift._modelGlue = {};`, sandbox);
    for (const f of ['uplift_mmchips.js', 'uplift_mmtable.js'])
        vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'),
                        sandbox, { filename: f });
    // uplift.js is the app monolith and cannot load here; mirror its
    // postModelAction glue VERBATIM (uplift.js: `S.trackWrite(() =>
    // fetchJson(`${API}/admin/api/models/${enc(model)}/${action}`, POST))`).
    // The trackWrite pass-through is the point: it is what raises
    // pendingWrites and freezes the background repaint during the load.
    vm.runInContext(`window.Uplift._modelGlue.postModelAction = (model, action) =>
        window.Uplift.state.trackWrite(() => window.UpliftDom.fetchJson(
            window.Uplift.state.API + '/admin/api/models/' +
            encodeURIComponent(model) + '/' + action, { method: 'POST' }));`, sandbox);
    // the facade stand-in: tapBtn's post-write MMF.render(true) lands back
    // on the real table renderer (modelmgr.js itself is a pure aggregator)
    vm.runInContext(`window.Uplift.modelmgr = {
        render: (...a) => window.Uplift.mmTable.render(...a),
        get seModel() { return null; } };`, sandbox);
    return { sandbox, document };
}

const present = () => ({ id: 'MyModel-9B', loaded: false, is_loading: false,
                         estimated_size: 1, settings: {} });

/* route only what this render path fetches: snapshot + load POST */
function mkFetch(state, { failLoad } = {}) {
    const resp = (ok, obj, status) => ({ ok, status: status || (ok ? 200 : 500),
        json: async () => obj, clone() { return this; }, text: async () => 'boom' });
    state.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith('/load')) {
            if (state.onLoad) await state.onLoad;      // blocks like the real route
            if (failLoad) return resp(false, { detail: 'engine exploded' }, 500);
            return resp(true, { status: 'ok', model_id: 'MyModel-9B' });
        }
        if (u.endsWith('/profiles')) return resp(true, { profiles: [] });
        if (u.includes('/admin/api/models')) return resp(true, { models: state.models });
        throw new Error('unrouted ' + u);
    };
}

test('click PRESENT paints LOADING while the blocking load POST is in flight', async () => {
    const state = { models: [present()] };
    let release;
    state.onLoad = new Promise(res => { release = res; });
    mkFetch(state);
    const { sandbox, document } = loadTableModule(state);
    await sandbox.window.Uplift.mmTable.render(true);
    const table = document.getElementById('model-admin');
    assert.ok(segs(table).some(s => s.includes('PRESENT')), 'row starts PRESENT');

    const pill = table.querySelectorAll('lsw-seg present')[0];
    const click = pill.onclick();          // fires; the POST stays in flight

    const now = segs(table);
    assert.ok(now.some(s => s.startsWith('LOADING')),
        'LOADING must replace PRESENT while the load runs, got: ' + JSON.stringify(now));
    assert.ok(!now.some(s => s.includes('PRESENT')), 'PRESENT is gone during the load');
    assert.strictEqual(sandbox.window.Uplift.state.pendingWrites, 1,
        'the load POST is still in flight (this is what froze the old repaint)');

    // the model finishes loading: the snapshot flips, the write settles,
    // tapBtn's forced re-render paints the truth
    state.models = [Object.assign({}, present(), { loaded: true, actual_size: 1 })];
    release();
    await click;
    // tapBtn fires the post-write MMF.render(true) without awaiting it —
    // flush the re-render's snapshot fetch before asserting
    await new Promise(r => setTimeout(r, 20));
    const done = segs(document.getElementById('model-admin'));
    assert.ok(done.some(s => s.includes('LOADED')), 'after load: LOADED, got ' + JSON.stringify(done));
    assert.ok(!done.some(s => s.startsWith('LOADING')), 'LOADING cleared once loaded');
    assert.strictEqual(sandbox.window.Uplift.state.pendingWrites, 0);
});

test('a failed load reverts the optimistic LOADING back to PRESENT', async () => {
    const state = { models: [present()] };
    mkFetch(state, { failLoad: true });
    const { sandbox, document } = loadTableModule(state);
    await sandbox.window.Uplift.mmTable.render(true);
    const table = document.getElementById('model-admin');
    const pill = table.querySelectorAll('lsw-seg present')[0];
    await pill.onclick();                  // tapBtn swallows the error into a toast

    const now = segs(document.getElementById('model-admin'));
    assert.ok(now.some(s => s.includes('PRESENT')),
        'a failed load must not leave the row stuck on LOADING, got: ' + JSON.stringify(now));
    assert.ok(!now.some(s => s.startsWith('LOADING')));
    assert.strictEqual(sandbox.window.Uplift.state.pendingWrites, 0,
        'the write counter unwinds on the failure path');
});

test('the server-driven LOADING branch still paints from the snapshot', async () => {
    const state = { models: [Object.assign(present(), { is_loading: true })] };
    mkFetch(state);
    const { sandbox, document } = loadTableModule(state);
    await sandbox.window.Uplift.mmTable.render(true);
    const now = segs(document.getElementById('model-admin'));
    assert.ok(now.some(s => s.startsWith('LOADING')) && !now.some(s => s.includes('PRESENT')),
        JSON.stringify(now));
});
