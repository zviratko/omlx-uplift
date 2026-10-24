/* UP-22 (FEAT-1 parity): the ModelScope half of the downloader.
   The pure parts (msRepoId / msTotalPages / msHistoryPush / msStatus /
   msDownload) are driven in a vm sandbox against REAL /admin/api/ms/*
   payload shapes (omlx/admin/ms_downloader.py _parse_ms_model_entry +
   DownloadTask.to_dict, routes.py:8434-8620). The injected chrome and the
   lists are exercised through initDownloader with an id-registered DOM
   stub; the wire shapes stay source-pinned where the harness cannot see
   them (the dl1-fileselect precedent). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const SRC = fs.readFileSync(path.join(STATIC, 'uplift_downloader.js'), 'utf8');
// cross-realm values: compare JSON shapes, never identity (dl1 precedent)
const J = v => JSON.stringify(v);
const tick = () => new Promise(r => setImmediate(r));

/* ---- a DOM stub with the pieces the injector + boards need ------------ */
function makeEl(tag, reg) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
        _cn: '', _text: '', title: '', value: '', checked: false,
        type: '', disabled: false, placeholder: '', parentNode: null, _id: '',
        // the house sets className wholesale; mirror it into classList so the
        // assertions can walk the built tree the way CSS would match it
        get className() { return this._cn; },
        set className(v) {
            this._cn = String(v);
            this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
        },
        get id() { return this._id; },
        set id(v) { this._id = v; if (reg) reg[v] = this; },
        get textContent() { return this._text; },
        set textContent(v) { this._text = String(v); this.children.length = 0; },
        set innerHTML(v) {
            assert.strictEqual(v, '', 'innerHTML use must be the container-clear');
            this.children.length = 0;
        },
        get innerHTML() { return ''; },
        // the boards gate on childNodes (the house append model keeps both)
        get childNodes() { return this.children; },
        get nextSibling() {
            if (!this.parentNode) return null;
            const i = this.parentNode.children.indexOf(this);
            return this.parentNode.children[i + 1] || null;
        },
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            toggle(c, force) {
                const on = force === undefined ? !this._s.has(c) : !!force;
                if (on) this._s.add(c); else this._s.delete(c);
                return on;
            },
            contains(c) { return this._s.has(c); },
        },
        append(...cs) {
            for (const c of cs) if (c) { this.children.push(c); c.parentNode = this; }
        },
        insertBefore(node, ref) {
            const i = ref ? this.children.indexOf(ref) : this.children.length;
            if (i < 0) this.children.push(node);
            else this.children.splice(i, 0, node);
            node.parentNode = this;
            return node;
        },
        remove() {}, setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] ?? null; },
        addEventListener(t, fn) { (this._ev = this._ev || {})[t] = fn; },
        focus() {}, blur() {}, scrollIntoView() {}, closest() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        // tree readers the assertions use instead of scraping the wire
        dump() {
            return [this._text || '', ...this.children.map(c => c.dump && c.dump() || '')]
                .filter(Boolean).join(' ');
        },
        all(cls, out) {
            out = out || [];
            if (this.classList && this.classList.contains(cls)) out.push(this);
            for (const c of this.children) if (c.all) c.all(cls, out);
            return out;
        },
    };
    return el;
}

function load(opts) {
    opts = opts || {};
    const byId = {};
    const doc = {
        body: makeEl('body', byId),
        createElement: tag => makeEl(tag, byId),
        createTextNode: t => ({ _text: String(t) }),
        addEventListener() {}, querySelectorAll: () => [], hidden: false,
        documentElement: { dataset: {} },
        // browser-true: an id the markup does not ship is null, so the
        // inject-if-missing contract (ensureDlChrome) is actually exercised
        getElementById: id => byId[id] || null,
    };
    const store = Object.assign({}, opts.storage);
    const storage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
    };
    const gets = [], posts = [], dels = [], toasts = [];
    const win = { Uplift: {} };
    win.UpliftCore = {
        t: (k, v) => k, tf: (k, en) => (en === undefined ? k : en),
        fmtBytes: n => n + 'B', fmtNumber: String, errorText: x => String(x),
    };
    const data = opts.data || {};
    win.UpliftDom = {
        $: id => doc.getElementById(id),
        fetchJson: async url => {
            gets.push(String(url));
            const hit = Object.keys(data).find(k => String(url).includes(k));
            if (!hit) throw new Error('unexpected fetch ' + url);
            const v = data[hit];
            return typeof v === 'function' ? v(url) : v;
        },
        postJson: async (url, body) => { posts.push([String(url), body]); return {}; },
        deleteJson: async url => { dels.push(String(url)); return {}; },
        toast: m => toasts.push(m),
        emptyMsg(host, msg) {
            host.children.length = 0;
            const d = doc.createElement('div'); d.className = 'empty';
            d.textContent = msg; host.append(d);
        },
        cell(t) { const s = doc.createElement('span'); s.textContent = t; return s; },
        loadScript: () => Promise.resolve(),
    };
    win.Uplift.state = { API: '' };
    const sandbox = {
        window: win, document: doc, URL, URLSearchParams, console,
        localStorage: storage, navigator: opts.navigator,
        setTimeout: () => 0, clearTimeout: () => {},
    };
    vm.runInNewContext(SRC, sandbox);
    const seam = win.Uplift.downloader;
    const el = id => byId[id] || Object.assign(makeEl('div', byId), { id }); // setter registers
    seam._t = { byId, doc, gets, posts, dels, toasts, store, win, el };
    return seam;
}

// the ids the shipped dl-page card carries (index.html) — the harness builds
// the same tree so ensureDlChrome injects where a browser would
function dlPage(S) {
    const tabs = S._t.el('dl-tab-trending');
    const bar = tabs.parentNode = makeEl('div');
    bar.className = 'filterbar';
    for (const id of ['dl-q', 'dl-sort', 'dl-mlx', 'dl-go']) {
        const e = S._t.el(id);
        e.parentNode = bar;
        bar.children.push(e);
    }
    const trending = S._t.el('dl-tab-trending'); trending.parentNode = bar;
    const popular = S._t.el('dl-tab-popular'); popular.parentNode = bar;
    const search = S._t.el('dl-tab-search'); search.parentNode = bar;
    bar.append(trending, popular, search);
    const entry = makeEl('div'); entry.className = 'filterbar';
    for (const id of ['dl-repo', 'dl-token', 'dl-direct']) {
        const e = S._t.el(id); e.parentNode = entry; entry.children.push(e);
    }
    const body = S._t.doc.body;
    body.append(bar, entry);
    for (const id of ['dl-results', 'dl-pager', 'dl-tasks', 'dl-sub']) {
        const e = S._t.el(id); e.className = 'admin-table'; body.append(e);
    }
    S._t.el('dl-sort').value = 'trending';
    S._t.el('dl-mlx').checked = true;
    S._t.el('dl-repo').value = '';
    S._t.el('dl-token').value = '';
    return body;
}

// real /admin/api/ms/recommended + /ms/search shapes (_parse_ms_model_entry)
const msRec = {
    trending: [{
        repo_id: 'mlx-community/Qwen2.5-7B-Instruct-MLX', name: 'Qwen2.5-7B-Instruct-MLX',
        downloads: 1200, likes: 9, size: 8e9, size_formatted: '8.0 GB',
        params: 7.6e9, params_formatted: '7.6B', trending_score: 0,
    }],
    popular: [],
};
const MS_DATA = {
    '/admin/api/ms/status': { available: true },
    '/admin/api/ms/recommended': msRec,
    '/admin/api/ms/search': { models: [], total: 0 },
    '/admin/api/ms/tasks': { tasks: [] },
    '/admin/api/hf/models': { models: [] },
    '/admin/api/hf/tasks': { tasks: [] },
    '/admin/api/global-settings': { system: { total_memory_bytes: 16e9 } },
};

/* ---- pure helpers ------------------------------------------------------ */
test('msRepoId: a bare model id lands on the mlx-community owner', () => {
    const U = load()._up22;
    assert.strictEqual(U.msRepoId('Qwen2.5-7B'), 'mlx-community/Qwen2.5-7B');
    assert.strictEqual(U.msRepoId('  Qwen2.5-7B  '), 'mlx-community/Qwen2.5-7B', 'trimmed first');
    assert.strictEqual(U.msRepoId('qwen/Qwen2.5-7B'), 'qwen/Qwen2.5-7B', 'owner kept');
    assert.strictEqual(U.msRepoId(''), '', 'empty stays empty — never a bare owner');
    assert.strictEqual(U.msRepoId(null), '');
});
test('msTotalPages: classic caps the MS pager at 5 (10 on search)', () => {
    const U = load()._up22;
    assert.strictEqual(U.msTotalPages(50, 10, 'trending'), 5);
    assert.strictEqual(U.msTotalPages(500, 10, 'trending'), 5, 'browse cap holds');
    assert.strictEqual(U.msTotalPages(500, 10, 'search'), 10, 'search cap');
    assert.strictEqual(U.msTotalPages(8, 10, 'popular'), 1);
    assert.strictEqual(U.msTotalPages(0, 10, 'popular'), 0);
});
test('msHistoryPush: newest first, deduped, 10 deep (classic rule)', () => {
    const U = load()._up22;
    assert.strictEqual(J(U.msHistoryPush([], 'qwen')), '["qwen"]');
    assert.strictEqual(J(U.msHistoryPush(['a', 'b'], 'a')), '["a","b"]', 're-run moves it up');
    assert.strictEqual(U.msHistoryPush(['a'], ' a ').length, 1, 'trimmed');
    assert.strictEqual(J(U.msHistoryPush(['a'], '')), '["a"]', 'empty query: no-op');
    const big = U.msHistoryPush(['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'new');
    assert.strictEqual(big.length, 10, 'classic cap of 10');
    assert.strictEqual(big[0], 'new');
    assert.strictEqual(J(U.msHistoryPush(null, 'x')), '["x"]', 'junk history tolerated');
});
test('msHistoryLoad: a junk localStorage value starts over empty', () => {
    const H = o => load({ storage: o })._up22.msHistoryLoad();
    assert.strictEqual(J(H({ msSearchHistory: '["a","b"]' })), '["a","b"]');
    assert.strictEqual(J(H({ msSearchHistory: '{oops' })), '[]');
    assert.strictEqual(J(H({ msSearchHistory: '{"a":1}' })), '[]');
    assert.strictEqual(J(H({ msSearchHistory: '["a",3,"b"]' })), '["a","b"]', 'non-strings dropped');
});

/* ---- status probe + download wire ------------------------------------- */
test('msStatus: available ONLY on available===true, cached, never throws', async () => {
    const A = load({ data: { '/admin/api/ms/status': { available: true } } });
    assert.strictEqual(await A._up22.msStatus(), true);
    assert.strictEqual(A._up22.MS.available, true);
    const B = load({ data: { '/admin/api/ms/status': { available: 'yes' } } });
    assert.strictEqual(await B._up22.msStatus(), false, 'truthy-but-not-true is not available');
    const C = load({ data: { '/admin/api/ms/status': () => { throw new Error('404'); } } });
    assert.strictEqual(await C._up22.msStatus(), false, 'a missing endpoint is an offline source');
    const n = C._t.gets.length;
    await C._up22.msStatus();
    assert.strictEqual(C._t.gets.length, n, 'one probe only (classic msInitialized)');
});
test('msDownload: POST /admin/api/ms/download {model_id, ms_token}', async () => {
    const S = load({ data: MS_DATA });
    dlPage(S);                       // the board + entry hosts exist
    // the UI only offers ms/download while the ModelScope source is active,
    // and the shared board re-reads the ACTIVE provider (UP-22)
    S._up22.DL.provider = 'ms';
    S._t.el('dl-ms-token').value = ' ms-secret ';
    assert.strictEqual(await S._up22.msDownload('Qwen2.5-7B'), true);
    const [url, body] = S._t.posts[0];
    assert.strictEqual(url, '/admin/api/ms/download');
    assert.strictEqual(body.model_id, 'mlx-community/Qwen2.5-7B', 'owner defaulted');
    assert.strictEqual(body.ms_token, 'ms-secret', 'trimmed, never the HF token');
    assert.ok(S._t.toasts.some(t => /Qwen/.test(t)), 'classic download_started toast');
    assert.ok(S._t.gets.some(u => u.includes('/admin/api/ms/tasks')), 'the board re-reads');
    S._t.posts.length = 0;
    assert.strictEqual(await S._up22.msDownload('   '), false);
    assert.strictEqual(S._t.posts.length, 0, 'an empty repo id never reaches the wire');
});
test('msDownload: a refused endpoint reports, it does not throw', async () => {
    const S = load({ data: MS_DATA });
    dlPage(S);
    S._t.win.UpliftDom.postJson = async () => { throw new Error('503: not initialized'); };
    assert.strictEqual(await S._up22.msDownload('a/b'), false);
    assert.ok(S._t.toasts.some(t => /503/.test(t)), 'the server reason reaches the toast');
});

/* ---- chrome injection (no index.html dependency) ---------------------- */
test('ensureDlChrome: HF|ModelScope + RECOMMENDED lead the strip, idempotently', () => {
    const S = load();
    const reg = S._t.byId;
    dlPage(S);
    const bar = reg['dl-tab-trending'].parentNode;
    S._up22.ensureDlChrome();
    // flatten: the source pair rides a wrapper span (a segmented control)
    const kids = bar.children.flatMap(c => c.children && !c.id
        ? c.children.map(x => x.id) : [c.id]);
    assert.ok(kids.indexOf('dl-src-hf') < kids.indexOf('dl-src-ms'), kids.join(','));
    assert.ok(kids.indexOf('dl-src-ms') < kids.indexOf('dl-tab-recos'), kids.join(','));
    assert.ok(kids.indexOf('dl-tab-recos') < kids.indexOf('dl-tab-trending'),
        'RECOMMENDED is the FIRST tab (UP-23): ' + kids.join(','));
    assert.ok(kids.includes('dl-tab-popular'), 'existing tabs untouched');
    assert.strictEqual(reg['dl-ms-token'].type, 'password', 'ModelScope token field');
    assert.ok(reg['dl-hist'], 'the recent-searches host exists');
    const n = bar.children.length;
    S._up22.ensureDlChrome();
    assert.strictEqual(bar.children.length, n, 'idempotent: the ids are the contract');
});
test('swapProviderInputs: the MS field is ModelScope-only, the HF key survives', () => {
    const S = load({ storage: { 'uplift.hf_token': 'hf-1', 'uplift.ms_token': 'ms-1' } });
    const tk = S._t.el('dl-ms-token');
    S._up22.swapProviderInputs('ms');
    assert.strictEqual(tk.value, 'ms-1', 'the ModelScope key fills its own field');
    assert.match(tk.placeholder, /your_token/, 'MS placeholder (classic key)');
    assert.match(tk.title, /MS Token/, 'classic field label');
    assert.strictEqual(S._t.store['uplift.hf_token'], 'hf-1', 'switching never rewrites HF');
    tk.value = 'ms-typed';
    S._up22.swapProviderInputs('hf');
    assert.strictEqual(S._t.store['uplift.ms_token'], 'ms-typed', 'typed MS key is kept');
    assert.strictEqual(S._t.store['uplift.hf_token'], 'hf-1',
        'and it is stored under the MS key, never the HF one');
    assert.strictEqual(S._up22.dlMsToken ? 'pinned' : 'missing', 'pinned');
});
/* ---- the board + the grid, driven through initDownloader -------------- */
test('ms task board: cancel/retry/remove ride the kind prefix', async () => {
    const tasks = { tasks: [
        { task_id: 't1', repo_id: 'mlx-community/A', status: 'downloading',
          progress: 40, total_size: 100, downloaded_size: 40 },
        { task_id: 't2', repo_id: 'mlx-community/B', status: 'failed', error: 'boom' },
        { task_id: 't3', repo_id: 'mlx-community/C', status: 'completed' },
    ] };
    const S = load({ data: Object.assign({}, MS_DATA, { '/admin/api/ms/tasks': tasks }) });
    const host = S._t.el('dl-tasks-ms');
    // the retry body is built when the row renders, so set the token first
    S._t.el('dl-ms-token').value = 'tok-9';
    S.renderTasks('dl-tasks-ms', 'ms');
    await tick();
    const rows = host.children.filter(c => c.classList.contains('urow'));
    assert.strictEqual(rows.length, 3, 'three ms rows');
    const btns = c => c.all('act');
    assert.deepStrictEqual(btns(rows[0]).map(b => b.textContent), ['CANCEL']);
    btns(rows[0])[0].onclick();
    await tick();
    assert.strictEqual(J(S._t.posts[S._t.posts.length - 1]), J(['/admin/api/ms/cancel/t1', {}]));
    const b2 = btns(rows[1]).map(b => b.textContent);
    assert.ok(b2.includes('REMOVE') && b2.includes('RETRY'), b2.join(','));
    btns(rows[1]).find(b => b.textContent === 'RETRY').onclick();
    await tick();
    assert.strictEqual(J(S._t.posts[S._t.posts.length - 1]),
        J(['/admin/api/ms/retry/t2', { ms_token: 'tok-9' }]),
        'classic retryMSDownload carries ms_token');
    btns(rows[2]).find(b => b.textContent === 'REMOVE').onclick();
    await tick();
    assert.strictEqual(S._t.dels[S._t.dels.length - 1], '/admin/api/ms/task/t3');
    assert.strictEqual(S._up22.MS.tasks.length, 3, 'the ms read feeds the badge veto');
});
test('the trending tab reads ModelScope through the shared grid', async () => {
    const S = load({
        storage: { msSearchHistory: '["qwen"]' },
        data: Object.assign({}, MS_DATA, {
            // classic isModelDownloaded: the repo is on disk and the LATEST
            // task for it completed -> the row shows the badge, no button
            '/admin/api/hf/models': { models: [{ repo_id: 'mlx-community/Qwen2.5-7B-Instruct-MLX' }] },
            '/admin/api/ms/tasks': { tasks: [{ repo_id: 'mlx-community/Qwen2.5-7B-Instruct-MLX',
                status: 'completed', progress: 100 }] },
        }),
    });
    dlPage(S);
    S._up22.DL.provider = 'ms';
    S._up22.MS.available = true; S._up22.MS.checked = true;
    S._up22.MS.history = S._up22.msHistoryLoad();
    S.initDownloader();
    await tick(); await tick();
    assert.ok(S._t.gets.some(u => u.includes('/admin/api/ms/recommended?mlx_only=true')),
        'the MS pane reads ms/recommended: ' + S._t.gets.join(' '));
    const txt = S._t.el('dl-results').dump();
    assert.match(txt, /Qwen2\.5-7B-Instruct-MLX/, txt);
    const acts = S._t.el('dl-results').all('dl-b');
    assert.ok(acts.some(b => b.textContent === 'Downloaded'),
        'an installed repo shows the classic DOWNLOADED badge');
    assert.strictEqual(S._t.el('dl-results').all('act').length, 0,
        'and no download button');
    assert.match(S._t.el('dl-hist').dump(), /qwen/, 'the recent-search chip row shows on MS');
});
test('HF stays the default source and keeps the UP-14 dialog-first rows', async () => {
    const S = load({ data: MS_DATA });
    dlPage(S);
    S.initDownloader();
    await tick(); await tick();
    assert.strictEqual(S._up22.DL.provider, 'hf');
    assert.ok(S._t.gets.some(u => u.includes('/admin/api/hf/recommended?mlx_only=true')));
    assert.ok(!S._t.gets.some(u => u.includes('/admin/api/ms/recommended')),
        'ms/recommended is not fetched until the source is switched');
    assert.match(S._t.el('dl-hist').dump(), /^\s*$/, 'no MS history row on the HF source');
});
test('setProvider(ms): the board, the tabs and the pane all follow the source', async () => {
    const S = load({ data: MS_DATA });
    dlPage(S);
    S.initDownloader();
    await tick(); await tick();
    await S._up22.DLX.setProvider('ms');
    await tick(); await tick();
    assert.strictEqual(S._up22.DL.provider, 'ms');
    assert.ok(S._t.gets.some(u => u.includes('/admin/api/ms/tasks')),
        'the task board re-reads on the active provider');
    assert.strictEqual(S._t.el('dl-tab-recos').style.display, 'none',
        'the hardware picks are an HF-only surface');
    assert.ok(S._t.el('dl-ms-token').style.display !== 'none', 'the MS token row is shown');
    assert.ok(S._t.el('dl-src-ms').classList.contains('on'), 'toggle paints the source');
    assert.ok(!S._t.el('dl-src-hf').classList.contains('on'));
});

/* ---- the injected chrome survives a language switch ------------------- */
test('relabelDlChrome + data-i18n-ph: the locale pass reaches the JS chrome', () => {
    const S = load();
    const reg = S._t.byId;
    dlPage(S);
    S._up22.ensureDlChrome();
    // the pair is built once; a later catalog must still move the labels
    S._t.win.UpliftCore.tf = (k, en) => (en === undefined ? k : '[' + k + ']');
    S._up22.relabelDlChrome();
    assert.strictEqual(reg['dl-src-ms'].textContent, '[models.downloader.source.ms]');
    assert.strictEqual(reg['dl-tab-recos'].textContent,
        '[models.downloader.source.recommended]');
    assert.strictEqual(reg['dl-src-hf'].textContent, '[models.downloader.source.hf]');
    // placeholders: applyI18n reads [data-i18n-ph], so the swap must move the
    // KEY and not only the resolved text (a locale load after the swap would
    // otherwise paste the HuggingFace hint back over a ModelScope row)
    S._up22.swapProviderInputs('ms');
    assert.strictEqual(reg['dl-q'].dataset.i18nPh, 'models.search.ms_placeholder');
    assert.strictEqual(reg['dl-repo'].dataset.i18nPh, 'models.downloader.ms_repo_placeholder');
    S._up22.swapProviderInputs('hf');
    assert.strictEqual(reg['dl-q'].dataset.i18nPh, 'uplift.dl.search_ph');
    assert.strictEqual(reg['dl-repo'].dataset.i18nPh, 'uplift.dl.repo_ph');
    // the MS field ships with its own key + English, hidden at boot
    assert.strictEqual(reg['dl-ms-token'].dataset.i18nPh,
        'models.downloader.ms_token_placeholder');
    assert.strictEqual(reg['dl-ms-token'].dataset.enPh, 'your_token...');
});

/* ---- the shared board follows the ACTIVE source ----------------------- */
test('renderTasks("dl-tasks", "hf") follows the provider, not the caller', async () => {
    const S = load({ data: Object.assign({}, MS_DATA, { '/admin/api/oq/tasks': { tasks: [] } }) });
    dlPage(S);
    S._up22.DL.provider = 'ms';
    // uplift_boot's visibility kick hardcodes ['dl-tasks','hf'] (uplift_boot
    // .js:126); with ModelScope showing, that read must NOT paint the HF board
    S.renderTasks('dl-tasks', 'hf');
    await tick();
    assert.ok(S._t.gets.some(u => u === '/admin/api/ms/tasks'),
        'the board read goes to the active source: ' + S._t.gets.join(' '));
    assert.ok(!S._t.gets.some(u => u === '/admin/api/hf/tasks'),
        'the HF list is not fetched behind the switch');
    // ...and the OTHER hosts are untouched by the rule
    S._t.gets.length = 0;
    S._t.el('qz-tasks');                      // the quantizer page's own board
    S.renderTasks('qz-tasks', 'oq');
    await tick();
    assert.ok(S._t.gets.some(u => u === '/admin/api/oq/tasks'),
        'quantizer/uploader boards keep their own kind: ' + S._t.gets.join(' '));
});

/* ---- source pins: the wiring the harness cannot reach ----------------- */
test('wire shape + classic parity pins (source)', () => {
    for (const u of ['/admin/api/ms/status', '/admin/api/ms/download',
        '/admin/api/ms/recommended', '/admin/api/ms/search',
        '${API}/admin/api/${kind}/tasks', '${API}/admin/api/${kind}/cancel/${tid}',
        '${API}/admin/api/${kind}/retry/${tid}', '${API}/admin/api/${kind}/task/${tid}'])
        assert.ok(SRC.includes(u), 'endpoint wired: ' + u);
    // ModelScope has no FILE PICK: its rows and entry row never open the
    // UP-14 dialog — they post the whole repo (classic downloadMsModel).
    // Classic's MS row-name DETAIL modal (dashboard.js:8659) is DEFERRED for
    // this lane — see the UP-22 header note and the lane report.
    assert.match(SRC, /b\.onclick = \(\) => msDownload\(m\.repo_id\);/);
    assert.match(SRC, /if \(DL\.provider === 'ms'\) \{ msDownload\(inp\.value\); return; \}/);
    assert.match(SRC, /if \(DL\.provider === 'ms'\) \{ loadMsRecommended\(force\); return; \}/);
    assert.match(SRC, /if \(DL\.provider === 'ms'\) \{ doMsSearch\(\); return; \}/);
    // the ms task read feeds the same DOWNLOADED veto classic uses
    assert.match(SRC, /if \(kind === 'ms'\) MS\.tasks = tasks;/);
    assert.match(SRC, /\{ ms_token: dlMsToken\(\) \|\| null \}/);
    assert.match(SRC, /\{ model_id: id, ms_token: dlMsToken\(\) \|\| '' \}/);
    // search carries sort + mlx_only + the classic limit
    assert.match(SRC, /new URLSearchParams\(\{ q, sort: MS\.sort, limit: '50', mlx_only: String\(mlx\) \}\)/);
    // history persists under the SAME localStorage key classic writes
    assert.match(SRC, /localStorage\.setItem\('msSearchHistory'/);
    // the board follows the source
    assert.match(SRC, /renderTasks\('dl-tasks', DL\.provider\);/);
    // labels reuse the mounted classic catalog — no invented uplift.* keys
    for (const key of ['models.downloader.source.hf', 'models.downloader.source.ms',
        'models.downloader.source.recommended', 'models.downloader.ms_unavailable',
        'models.downloader.ms_token', 'models.downloader.ms_repo_placeholder',
        'models.downloader.ms_token_placeholder', 'models.search.ms_placeholder',
        'models.search.recent_searches', 'models.browse.no_trending',
        'models.browse.tight_fit', 'models.browse.downloaded',
        'models.downloader.download_button', 'js.success.download_started',
        'js.error.start_download_failed', 'js.error.ms_connect_failed',
        'js.error.search_failed'])
        assert.ok(SRC.includes(`'${key}'`), 'classic key used: ' + key);
    for (const dead of ['ms/model-info', 'msModelDetail', 'dl-flash'])
        assert.ok(!SRC.includes(dead), 'MS offers no file-pick/detail upstream: ' + dead);
});
