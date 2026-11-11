/* UP-64 (user 2026-11-11): model updates on the Downloads page.
   Pins the rules the user named: the list shows what can be updated,
   ignored updates and ignored models stay listed but out of the way, and
   "Update all" never touches an ignored row or a row already downloading.
   vm sandbox + a small DOM stub (u22 precedent); the wire is recorded. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const SRC = fs.readFileSync(path.join(STATIC, 'uplift_downloader.js'), 'utf8');
const J = v => JSON.stringify(v);

function makeEl(tag, reg) {
    const el = {
        tagName: tag, children: [], dataset: {}, style: {}, attrs: {}, parentNode: null,
        className: '', _text: '', title: '', disabled: false, type: '', onclick: null, _id: '',
        get id() { return this._id; },
        set id(v) { this._id = v; if (reg) reg[v] = this; },
        get textContent() { return this._text; },
        set textContent(v) { this._text = String(v); this.children.length = 0; },
        get firstChild() { return this.children[0] || null; },
        append(...cs) { for (const c of cs) if (c) { this.children.push(c); c.parentNode = this; } },
        insertBefore(n, ref) {
            const i = ref ? this.children.indexOf(ref) : -1;
            if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
            n.parentNode = this; return n;
        },
        replaceChildren(...cs) { this.children.length = 0; this.append(...cs); },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        addEventListener() {}, remove() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        text() { return [this._text, ...this.children.map(c => c.text ? c.text() : '')]
            .filter(Boolean).join(' '); },
        find(pred, out) {
            out = out || [];
            if (pred(this)) out.push(this);
            for (const c of this.children) if (c.find) c.find(pred, out);
            return out;
        },
    };
    return el;
}

function load(view, info) {
    const byId = {};
    const doc = {
        body: makeEl('body', byId),
        createElement: tag => makeEl(tag, byId),
        getElementById: id => byId[id] || null,
        addEventListener() {}, querySelectorAll: () => [],
        documentElement: { dataset: {} },
    };
    const gets = [], posts = [], toasts = [];
    const win = { Uplift: {}, confirm: () => true };
    win.UpliftCore = {
        t: k => k, tf: (k, en, vars) => String(en === undefined ? k : en)
            .replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] != null ? String(vars[x]) : m)),
        fmtBytes: n => n + 'B', fmtNumber: String, errorText: String,
    };
    win.UpliftDom = {
        $: id => doc.getElementById(id),
        fetchJson: async url => {
            gets.push(String(url));
            const repo = new URL('http://x' + url).searchParams.get('repo_id');
            if (repo && info[repo]) return info[repo];
            if (String(url).includes('/hf/tasks')) return { tasks: [] };
            throw new Error('unexpected fetch ' + url);
        },
        postJson: async (url, body) => { posts.push([String(url), body]); return view; },
        toast: m => toasts.push(m),
        errText: e => String((e && e.message) || e),
        emptyMsg() {}, cell(t) { const s = makeEl('span'); s.textContent = t; return s; },
        loadScript: () => Promise.resolve(),
    };
    win.Uplift.state = { API: '' };
    let current = view;
    win.Uplift.modelUpdates = { get view() { return current; },
        set(v) { current = v; }, refresh() { return Promise.resolve(current); } };
    vm.runInNewContext(SRC, { window: win, document: doc, URL, URLSearchParams, console,
        localStorage: { getItem: () => null, setItem() {} },
        setTimeout: () => 0, clearTimeout() {} });
    // the dl-page card body the section is injected into
    const body = makeEl('div', byId);
    const results = makeEl('div', byId); results.id = 'dl-results';
    body.append(results);
    return { S: win.Uplift.downloader._up64, byId, gets, posts, toasts };
}

const VIEW = {
    checked_at: 1700000000, checked: 5, running: false, error: null, available: true,
    failed: ['org/gated'], pending: 2, ignored_models: ['org/never', 'org/never-listed'],
    updates: [
        { repo_id: 'org/z', files: 2, size: 10, sha: 's1', ignored: null, downloading: false },
        { repo_id: 'org/skip', files: 1, size: 5, sha: 's2', ignored: 'version', downloading: false },
        { repo_id: 'org/a', files: 3, size: 7, sha: 's3', ignored: null, downloading: false },
        { repo_id: 'org/busy', files: 1, size: 1, sha: 's4', ignored: null, downloading: true },
        { repo_id: 'org/never', files: 1, size: 1, sha: 's5', ignored: 'model', downloading: false },
    ],
};

test('UP-64: rows list open updates first, then ignored ones and ignored models', () => {
    const { S } = load(VIEW, {});
    const rows = S.updRows(VIEW).map(r => [r.repo_id, r.ignored]);
    assert.strictEqual(J(rows), J([
        ['org/a', null], ['org/busy', null], ['org/z', null],
        ['org/never', 'model'], ['org/skip', 'version'], ['org/never-listed', 'model']]));
});

test('UP-64: status line names the count, the partial failure and the check time', () => {
    const { S } = load(VIEW, {});
    const txt = S.updStatusText(VIEW);
    assert.match(txt, /Last check: /);
    assert.match(txt, /Updates available: 2/);
    assert.match(txt, /1 could not be checked/);
    assert.strictEqual(S.updStatusText(Object.assign({}, VIEW, { running: true })), 'Checking...');
});

test('UP-64: Update all skips ignored and downloading rows and sends only changed files', async () => {
    const info = {
        'org/z': { repo_id: 'org/z', update_files: ['model.safetensors', 'config.json'] },
        'org/a': { repo_id: 'org/a', update_files: [] },        // current since the check
    };
    const h = load(VIEW, info);
    h.S.renderUpdates();
    assert.strictEqual(h.byId['dl-upd-all'].disabled, false);
    await h.S.updAll();
    const looked = h.gets.filter(u => u.includes('model-info'))
        .map(u => new URL('http://x' + u).searchParams.get('repo_id'));
    assert.strictEqual(J(looked.sort()), J(['org/a', 'org/z']), 'no lookup for ignored/busy rows');
    const dls = h.posts.filter(p => p[0].endsWith('/admin/api/hf/download'));
    assert.strictEqual(J(dls.map(p => [p[1].repo_id, p[1].files])),
        J([['org/z', ['model.safetensors', 'config.json']]]));
    assert.match(h.toasts.join(' '), /Updates queued: 1/);
});

test('UP-64: Update all is disabled when every update is ignored or downloading', () => {
    const v = Object.assign({}, VIEW, { pending: 0, updates: VIEW.updates.filter(
        u => u.ignored || u.downloading) });
    const h = load(v, {});
    h.S.renderUpdates();
    assert.strictEqual(h.byId['dl-upd-all'].disabled, true);
    const rows = h.byId['dl-updates'].find(e => (e.className || '').includes('dl-upd-row'));
    assert.strictEqual(rows.length, 4, 'ignored rows, busy rows and ignored models stay visible');
});

test('UP-64: ignore buttons post the repo and the mode', async () => {
    const h = load(VIEW, {});
    h.S.updIgnore('org/z', 'version');
    h.S.updIgnore('org/never', 'none');
    assert.strictEqual(J(h.posts.map(p => [p[0], p[1]])), J([
        ['/uplift/api/model-updates/ignore', { repo_id: 'org/z', mode: 'version' }],
        ['/uplift/api/model-updates/ignore', { repo_id: 'org/never', mode: 'none' }]]));
});
