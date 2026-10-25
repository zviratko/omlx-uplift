/* UP-23 (FEAT-1 parity): 'Recommended for this Mac'.
   The surface is pure pricing math over ONE GET /admin/api/hf/recommendations
   payload (omlx/admin/model_recommender.py recommendations(): device /
   memory{scenarios.now|memory_guard|wired_limit|both} / sections
   {best|bigger|precise|faster|unlock} / disk / stale / author, and
   _serialize() per item). The fixture below is that shape; every helper is
   driven against it, then renderRecos builds the panel in a DOM stub so the
   meters, badges, per-row states and the unlock flow are proven end-to-end —
   including the single WRITE (memory_guard_tier=aggressive), which must sit
   behind a confirm. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const SRC = fs.readFileSync(path.join(STATIC, 'uplift_downloader.js'), 'utf8');
const G = 1024 ** 3, M = 1024 ** 2;
const tick = () => new Promise(r => setImmediate(r));
// cross-realm values: compare JSON shapes, never identity (dl1 precedent)
const J = v => JSON.stringify(v);

/* ---- the classic 32 GB / balanced fixture ------------------------------ */
function item(o) {
    return Object.assign({
        repo_id: 'mlx-community/Qwen3-4B-mlx-oQ4.5e', name: 'Qwen3-4B',
        model_type: 'qwen3', level: 4.5, fp16: false, mtp: false,
        vision: false, audio: false, moe: false,
        total_params: 4e9, active_params: 4e9, downloads: 12000,
        download_bytes: 2.6 * G, resident_bytes: 3.1 * G,
        table_on_ssd: false, table_bytes: 0,
        max_context: 40960, model_max_context: 40960,
        smarts: 0.61, smarts_level: 3, speed_level: 4,
        tokens_per_second: 26, base_name: 'Qwen3-4B', relative_speed: 1,
    }, o || {});
}
const budget = (tier, metal, ceiling, usable) => ({
    tier, metal_cap_bytes: metal, ceiling_bytes: ceiling, usable_bytes: usable });
function rec(o) {
    return Object.assign({
        device: { chip: 'M4 Pro', generation: 'M4', variant: 'Pro', gpu_cores: 20,
            memory_bytes: 32 * G, bandwidth_gbps: 273, prefers_fp16: false },
        memory: {
            total_bytes: 32 * G, tier: 'balanced', guard_enabled: true,
            reserve_bytes: 6 * G, aggressive_reserve_bytes: 3 * G,
            static_ceiling_bytes: 22 * G, wired_limit_set: false, binding: 'static',
            suggested_wired_limit_mb: 24576,
            scenarios: {
                now: budget('balanced', 16 * G, 20 * G, 18 * G),
                memory_guard: budget('aggressive', 16 * G, 25 * G, 21 * G),
                wired_limit: budget('balanced', 24 * G, 20 * G, 18.5 * G),
                both: budget('aggressive', 24 * G, 25 * G, 21.5 * G),
            },
        },
        sections: {
            best: [item({}), item({ repo_id: 'mlx-community/Gemma-12B-oQ4e', name: 'Gemma-12B',
                level: 4, total_params: 12e9, resident_bytes: 7.2 * G, vision: true,
                smarts: 0.66, smarts_level: 4, speed_level: 3, relative_speed: 0.8,
                base_name: 'Qwen3-4B' })],
            bigger: [item({ repo_id: 'mlx-community/Llama-70B-oQ3e', name: 'Llama-70B',
                level: 3, total_params: 70e9, resident_bytes: 15 * G,
                smarts: 0.8, smarts_level: 5, speed_level: 2, relative_speed: 0.4,
                base_name: 'Qwen3-4B', mtp: true })],
            precise: [item({ repo_id: 'mlx-community/Qwen3-4B-oQ6e', name: 'Qwen3-4B',
                level: 6, resident_bytes: 4 * G, smarts: 0.64, speed_level: 3,
                relative_speed: 1.4, base_name: 'Qwen3-4B' })],
            faster: [item({ repo_id: 'mlx-community/Smol-1.7B-oQ4e', name: 'Smol-1.7B',
                level: 4, total_params: 1.7e9, resident_bytes: 1.2 * G, smarts: 0.4,
                audio: true, relative_speed: 2.2, base_name: 'Qwen3-4B' })],
            unlock: [item({ repo_id: 'mlx-community/DeepSeek-r1-oQ3e', name: 'DeepSeek-r1',
                level: 3, kind: 'fits', needs: ['memory_guard', 'wired_limit'], moe: true,
                total_params: 671e9, active_params: 37e9, resident_bytes: 24 * G,
                smarts: 0.9, table_on_ssd: true, table_bytes: 4 * G })],
        },
        author: 'bleakus', fetched_at: 1, stale: false,
        disk: { model_dir: '~/.omlx/models', free_bytes: 80 * G },
    }, o || {});
}

/* ---- DOM stub ---------------------------------------------------------- */
function makeEl(tag, reg) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
        _cn: '', _text: '', title: '', value: '', checked: false,
        type: '', disabled: false, placeholder: '', parentNode: null, _id: '',
        get id() { return this._id; },
        set id(v) { this._id = v; if (reg) reg[v] = this; },
        // the house sets className wholesale; mirror it into classList so the
        // assertions walk the tree the way CSS would match it
        get className() { return this._cn; },
        set className(v) {
            this._cn = String(v);
            this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
        },
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
            return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
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
        append(...cs) { for (const c of cs) if (c) { this.children.push(c); c.parentNode = this; } },
        insertBefore(n, r) {
            const i = r ? this.children.indexOf(r) : -1;
            if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
            n.parentNode = this; return n;
        },
        remove() {}, setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] ?? null; },
        addEventListener(t, fn) { (this._ev = this._ev || {})[t] = fn; },
        focus() {}, blur() {}, scrollIntoView() {}, closest() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        dump() {
            return [this._text || '', ...this.children.map(c => c.dump && c.dump() || '')]
                .filter(Boolean).join(' ');
        },
        find(cls) {
            if (this.classList && this.classList.contains(cls)) return this;
            for (const c of this.children) if (c.find) { const h = c.find(cls); if (h) return h; }
            return null;
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
        // browser-true: a missing id is null, so inject-if-missing is real
        getElementById: id => byId[id] || null,
    };
    const store = Object.assign({}, opts.storage);
    const gets = [], posts = [], toasts = [], confirms = [];
    const win = { Uplift: {} };
    win.UpliftCore = {
        t: k => k, tf: (k, en) => (en === undefined ? k : en),
        fmtBytes: n => n + 'B', fmtNumber: n => String(n), errorText: x => String(x),
    };
    const data = opts.data || {};
    win.UpliftDom = {
        $: id => byId[id] || null,
        fetchJson: async url => {
            gets.push(String(url));
            const hit = Object.keys(data).find(k => String(url).includes(k));
            if (!hit) throw new Error('unexpected fetch ' + url);
            const v = data[hit];
            return typeof v === 'function' ? v(url) : v;
        },
        postJson: async (url, body) => { posts.push([String(url), body]); return {}; },
        deleteJson: async () => ({}),
        toast: m => toasts.push(m),
        // kit seam added by UP-49 (mirrors domkit.errText)
        errText(e) { if (e == null) return ''; if (typeof e === 'string') return e.includes(' -> ') ? e.split(' -> ')[1] : e; if (e.userMessage) return e.userMessage; const m = e.message || String(e); return m.includes(' -> ') ? m.split(' -> ')[1] : m; },
        emptyMsg(host, msg) {
            host.children.length = 0;
            const d = doc.createElement('div'); d.className = 'empty';
            d.textContent = msg; host.append(d);
        },
        cell(t) { const s = doc.createElement('span'); s.textContent = t; return s; },
        loadScript: () => Promise.resolve(),
    };
    win.Uplift.state = { API: '' };
    win.confirm = q => { confirms.push(q); return opts.confirm === undefined ? true : opts.confirm; };
    const clipboard = { last: null, writeText: async t2 => { clipboard.last = t2; } };
    const sandbox = {
        window: win, document: doc, URL, URLSearchParams, console,
        localStorage: { getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} },
        navigator: opts.noClipboard ? {} : { clipboard },
        setTimeout: () => 0, clearTimeout: () => {},
    };
    vm.runInNewContext(SRC, sandbox);
    const seam = win.Uplift.downloader;
    const el = id => byId[id] || Object.assign(makeEl('div', byId), { id });
    seam._t = { byId, doc, gets, posts, toasts, confirms, store, win, el, clipboard };
    return seam;
}
// the ids the shipped dl-page card carries (index.html)
function dlPage(S) {
    const bar = makeEl('div'); bar.className = 'filterbar';
    for (const id of ['dl-q', 'dl-sort', 'dl-mlx', 'dl-go', 'dl-tab-trending',
        'dl-tab-popular', 'dl-tab-search']) {
        const e = S._t.el(id); e.parentNode = bar; bar.children.push(e);
    }
    const entry = makeEl('div'); entry.className = 'filterbar';
    for (const id of ['dl-repo', 'dl-token', 'dl-direct']) {
        const e = S._t.el(id); e.parentNode = entry; entry.children.push(e);
    }
    S._t.doc.body.append(bar, entry);
    for (const id of ['dl-results', 'dl-pager', 'dl-tasks', 'dl-sub']) {
        const e = S._t.el(id); e.className = 'admin-table'; S._t.doc.body.append(e);
    }
    S._t.el('dl-sort').value = 'trending';
    S._t.el('dl-mlx').checked = true;
    S._t.el('dl-token').value = '';
    S._t.el('dl-repo').value = '';
}
const recData = () => ({
    '/admin/api/hf/recommendations': rec(),
    '/admin/api/hf/models': { models: [{ repo_id: 'mlx-community/Qwen3-4B-oQ6e' }] },
    '/admin/api/hf/tasks': { tasks: [] },
    '/admin/api/ms/tasks': { tasks: [] },
    '/admin/api/ms/status': { available: false },
    '/admin/api/hf/recommended': { trending: [], popular: [] },
    '/admin/api/global-settings': { system: { total_memory_bytes: 32 * G } },
});

/* ---- the RAM / disk pricing (classic parity) --------------------------- */
test('units: GiB tiers, K/M context, B params — classic math', () => {
    const R = load()._up23;
    assert.strictEqual(R.recGB(32 * G), '32.0 GiB');
    assert.strictEqual(R.recGB(128 * G), '128 GiB', 'the >=100 tier drops the decimal');
    assert.strictEqual(R.recGB(0), '0.0 GiB');
    assert.strictEqual(R.recContext(40960), '40K');
    assert.strictEqual(R.recContext(1024 * 1024), '1M');
    assert.strictEqual(R.recParams(4e9), '4.0B');
    assert.strictEqual(R.recParams(70e9), '70B');
    assert.strictEqual(J(R.recDots(4)), '["full","full","full","full","empty"]');
    assert.strictEqual(J(R.recDots(3.5)), '["full","full","full","half","empty"]',
        'a half level paints exactly one half dot (classic recDots)');
});
test('arch + speed note: MoE names both halves, ratios read like classic', () => {
    const R = load()._up23;
    assert.match(R.recArch(item({ moe: false, total_params: 4e9 })), /Dense 4\.0B/);
    const moe = R.recArch(item({ moe: true, total_params: 671e9, active_params: 37e9 }));
    assert.match(moe, /MoE 671B/); assert.match(moe, /37B active/);
    assert.match(R.recSpeedVs(item({ relative_speed: 1.4, base_name: 'Qwen3-4B' })),
        /1\.4x faster than Qwen3-4B/);
    assert.match(R.recSpeedVs(item({ relative_speed: 0.4, base_name: 'Qwen3-4B' })),
        /2\.5x slower than Qwen3-4B/, 'the slower branch inverts the ratio');
    assert.match(R.recSpeedVs(item({ relative_speed: 1.05, base_name: 'X' })),
        /about as fast as X/);
    assert.match(R.recSpeedVs(item({ relative_speed: 12, base_name: 'X' })), /12x faster/);
});
test('memory share: rows price against now, unlock rows against the raised budget', () => {
    const R = load()._up23;
    const d = rec();
    assert.strictEqual(R.recMemoryShare(d, item({ resident_bytes: 9 * G })), 50,
        '9 GiB of the 18 GiB usable NOW');
    assert.strictEqual(R.recMemoryShare(d, item({ resident_bytes: 10.75 * G, kind: 'fits' })), 50,
        'unlock rows divide by scenarios.both (21.5 GiB), not by now');
    assert.strictEqual(R.recMemoryShare(d, item({ resident_bytes: 40 * G })), 100, 'clamped');
    assert.strictEqual(R.recMemoryShare({ memory: { scenarios: {} } }, item({})), 100,
        'an unusable budget reads as full, never as free');
    assert.strictEqual(R.recMemoryBarClass(90), 'bad');
    assert.strictEqual(R.recMemoryBarClass(70), 'warn');
    assert.strictEqual(R.recMemoryBarClass(30), 'ok');
});
test('the RAM breakdown: segments, 64 MiB floor, percentages', () => {
    const R = load()._up23;
    const segs = R.recMemorySegments(rec().memory);
    assert.strictEqual(J(segs.map(s => s.key)),
        J(['usable', 'headroom', 'gpu', 'custom', 'reserve']), 'classic segment order');
    assert.ok(Math.abs(segs.reduce((a, s) => a + s.percent, 0) - 100) < 0.001,
        'the bar accounts for the whole stick');
    const tiny = R.recMemorySegments(Object.assign({}, rec().memory, {
        scenarios: { now: budget('balanced', 16 * G, 16.02 * G, 16 * G) } }));
    assert.ok(!tiny.some(s => s.bytes < 64 * M), 'sub-64 MiB slivers stay out');
});
test('unlock math: the 16 GB rule, the 256 MiB floor, the sysctl gate', () => {
    const R = load()._up23;
    const d = rec();
    assert.strictEqual(R.recUnlockOpen(d, null), true, 'a 32 GB Mac opens it');
    assert.strictEqual(R.recUnlockOpen(rec({ memory: Object.assign({}, d.memory,
        { total_bytes: 16 * G }) }), null), false, 'a 16 GB Mac starts closed');
    assert.strictEqual(R.recUnlockOpen(d, false), false, 'an explicit choice wins');
    assert.strictEqual(R.recUnlockGain(d, 'memory_guard'), 3 * G);
    assert.strictEqual(R.recUnlockGain(d, 'both'), 3.5 * G);
    assert.strictEqual(R.recUnlockGain({ memory: { scenarios: {
        now: budget('a', 1, 1, 10 * G), both: budget('b', 1, 1, 10 * G + 200 * M) } } }, 'both'), 0,
        'under a quarter GiB is no gain at all');
    assert.strictEqual(R.recMetalPercent(d), 50);
    assert.strictEqual(R.recWiredCommand(d), 'sudo sysctl iogpu.wired_limit_mb=24576');
    const m = d.memory;
    assert.strictEqual(R.recWiredCommand({ memory: Object.assign({}, m, { guard_enabled: false }) }),
        '', 'a disabled guard gets no command');
    assert.strictEqual(R.recWiredCommand({ memory: Object.assign({}, m,
        { suggested_wired_limit_mb: 0 }) }), '', 'junk suggestion: no command');
    assert.strictEqual(R.recWiredCommand({ memory: Object.assign({}, m,
        { suggested_wired_limit_mb: 8192 }) }), '', 'below the granted cap: nothing to raise');
    const s = R.recUnlockSummary(d);
    assert.match(s, /21\.5 GiB/); assert.match(s, /18\.0 GiB/); assert.match(s, /7\.0 GiB/);
    assert.ok(!/\{\w+\}/.test(s), 'no raw placeholder survives the fallback path');
});
test('row state + disk veto', () => {
    const S = load({ data: recData() });
    const R = S._up23;
    const d = rec();
    S._up22.DL.hfModels = [{ repo_id: 'mlx-community/Qwen3-4B-mlx-oQ4.5e' }];
    S._up22.DL.hfTasks = [];
    assert.strictEqual(R.recStateOf('mlx-community/Qwen3-4B-mlx-oQ4.5e'), 'downloaded');
    assert.strictEqual(R.recStateOf('a/b', [{ repo_id: 'a/b', status: 'downloading', progress: 3 }]),
        'downloading');
    assert.strictEqual(R.recStateOf('a/b', [{ repo_id: 'a/b', status: 'completed' }]), 'idle');
    assert.strictEqual(R.recTaskOf('a/b', [{ repo_id: 'a/b', status: 'failed' },
        { repo_id: 'a/b', status: 'downloading' }]).status, 'downloading', 'latest wins');
    assert.strictEqual(R.recDiskShort(d, item({ download_bytes: 100 * G })), true);
    assert.strictEqual(R.recDiskShort({ disk: { free_bytes: 0 } }, item({ download_bytes: 9e18 })),
        false, 'unknown free space never blocks');
    assert.match(R.recBiggerEmpty(d), /DeepSeek-r1 oQ3e/, 'names what the unlock would free');
    assert.strictEqual(R.recBiggerEmpty(Object.assign({}, d, { sections: { best: [], unlock: [] } })),
        'No bigger model fits right now.');
});

/* ---- the rendered panel ------------------------------------------------ */
test('renderRecos: your Mac, dot meters, badges, per-row state', () => {
    const S = load({ data: recData() });
    S._up23.DL.tab = 'recos';
    S._up23.REC.data = rec();
    const host = S._t.el('dl-results');
    S._up23.renderRecos(host);
    assert.ok(host.find('rec-mac'), 'the Your Mac panel is built');
    assert.match(host.dump(), /M4 Pro/, 'the chip line names the machine');
    assert.match(host.dump(), /273 GB\/s memory bandwidth/);
    assert.match(host.dump(), /18\.0 GiB/, 'the usable figure is the CURRENT scenario');
    assert.ok(host.all('rec-seg').length >= 3, 'the budget bar is segmented');
    assert.match(host.all('rec-seg')[0].style.width, /%/, 'segments carry widths');
    const card = host.all('rec-card')[0];
    const dots = card.all('rec-dot');
    assert.strictEqual(dots.length, 10, 'smarts + speed rows of dots');
    assert.ok(dots.some(d => d.classList.contains('full'))
        && dots.some(d => d.classList.contains('empty')));
    const badges = host.all('dl-b').map(b => b.textContent);
    assert.ok(badges.some(b => /oQ4\.5e/.test(b)), badges.join(','));
    assert.ok(badges.includes('Vision'), 'vision badge: ' + badges.join(','));
    assert.ok(badges.includes('Audio'), 'audio badge: ' + badges.join(','));
    assert.ok(badges.includes('Lightning MTP'), 'MTP badge: ' + badges.join(','));
    assert.ok(badges.includes('N-gram on SSD'), 'table-on-SSD badge: ' + badges.join(','));
    // the leading card is the best match (classic index===0 badge)
    assert.match(host.all('rec-card')[0].dump(), /Best match/);
    assert.ok(!/Best match/.test(host.all('rec-card')[1].dump()));
    assert.match(host.dump(), /Bigger model, fewer bits/);
    assert.match(host.dump(), /Same model, more bits/);
    assert.match(host.dump(), /Faster, but less capable/);
    assert.match(host.dump(), /Needs memory_guard/, 'classic unlock needs badge');
    assert.match(host.dump(), /bleakus/, 'the author footer names the catalogue');
});
test('renderRecos: stale banner, downloaded badge, disk veto', () => {
    const S = load({ data: recData() });
    S._up22.DL.hfModels = [{ repo_id: 'mlx-community/Qwen3-4B-oQ6e' }];
    S._up22.DL.hfTasks = [{ repo_id: 'mlx-community/Qwen3-4B-mlx-oQ4.5e',
        status: 'downloading', progress: 42 }];
    S._up23.REC.data = rec({ stale: true,
        disk: { model_dir: '~/.omlx/models', free_bytes: 1 * G } });
    const host = S._t.el('dl-results');
    S._up23.renderRecos(host);
    assert.ok(host.find('rec-banner'), 'the stale banner shows');
    assert.match(host.dump(), /Showing the last list/);
    assert.match(host.dump(), /Downloaded/, 'an installed build shows the badge');
    assert.match(host.dump(), /Downloading 42%/, 'a live task paints its progress');
    // 1 GiB free against multi-GB weights: every button is refused, with a why
    const btns = host.all('act').filter(b => b.textContent === 'Download');
    assert.ok(btns.length, 'rows still render their action column');
    assert.ok(btns.every(b => b.disabled === true), 'classic recDiskShort gates the button');
    assert.match(btns[0].title, /Not enough free space/, 'the refusal says why');
});
test('the empty payload degrades honestly: loading line, then a retry', () => {
    const S = load({ data: {} });
    const host = S._t.el('dl-results');
    S._up23.REC.data = null; S._up23.REC.loading = false; S._up23.REC.error = 'boom';
    S._up23.renderRecos(host);
    assert.match(host.dump(), /Could not load recommendations\. boom/);
    assert.ok(host.all('se-btn').some(b => b.textContent === 'Try again'), 'retry offered');
    S._up23.REC.error = '';
    S._up23.renderRecos(host);
    assert.match(host.dump(), /Checking which models fit this Mac/, 'loading line, not a blank');
});

/* ---- the one WRITE: unlock bigger models ------------------------------ */
test('recSetAggressive: confirm gates the POST, then the picks re-price', async () => {
    const S = load({ data: recData() });
    S._up23.REC.data = rec();
    const ok = await S._up23.recSetAggressive(rec());
    assert.strictEqual(ok, true);
    assert.strictEqual(S._t.confirms.length, 1, 'the tier flip asks first');
    assert.match(S._t.confirms[0], /Switch to Aggressive/);
    assert.match(S._t.confirms[0], /from 6\.0 GiB to 3\.0 GiB/, 'the classic body states the trade');
    assert.match(S._t.confirms[0], /21\.5 GiB/, 'the summary states the risk');
    const [url, body] = S._t.posts[0];
    assert.strictEqual(url, '/admin/api/global-settings');
    assert.strictEqual(J(body), J({ memory_guard_tier: 'aggressive' }),
        'classic payload: the single flat key');
    assert.ok(S._t.gets.some(u => u.includes('/admin/api/hf/recommendations')),
        'the picks are re-priced after the flip');
    assert.strictEqual(S._up23.REC.applying, false, 'the write is single-flight released');
});
test('recSetAggressive: a declined confirm posts nothing', async () => {
    const S = load({ confirm: false, data: recData() });
    assert.strictEqual(await S._up23.recSetAggressive(rec()), false);
    assert.strictEqual(S._t.posts.length, 0, 'no write without the operator');
});
test('the unlock toggle is operator state, not a re-fetch', () => {
    const S = load({ data: recData() });
    const R = S._up23;
    R.DL.tab = 'recos';            // paintRecos only repaints a visible tab
    R.REC.data = rec(); R.REC.unlockOpen = null;
    const host = S._t.el('dl-results');
    R.renderRecos(host);
    const head = host.find('rec-unlock-head');
    assert.match(head.dump(), /Hide/, 'a 32 GB Mac opens it');
    const n = S._t.gets.length;
    head.onclick();
    assert.strictEqual(R.REC.unlockOpen, false);
    assert.match(host.find('rec-unlock-head').dump(), /Show/);
    assert.ok(!host.find('rec-unlock-grid'), 'collapsed: the cards are gone');
    assert.strictEqual(S._t.gets.length, n, 'and nothing was re-fetched');
});
test('the wired-limit command copies through the clipboard, never a fetch', async () => {
    const S = load({ data: recData() });
    S._up23.recCopyCmd('sudo sysctl iogpu.wired_limit_mb=24576');
    await tick();
    assert.strictEqual(S._t.clipboard.last, 'sudo sysctl iogpu.wired_limit_mb=24576');
    assert.strictEqual(S._t.posts.length, 0, 'copy is a clipboard write only');
    const S2 = load({ noClipboard: true, data: recData() });
    S2._up23.recCopyCmd('x');    // a browser without clipboard.writeText must not throw
});

/* ---- integration: it is the FIRST tab and it owns the pane ------------ */
test('the RECOMMENDED tab leads the strip and drives the pane', async () => {
    const S = load({ data: recData() });
    dlPage(S);
    S.initDownloader();
    await tick(); await tick();
    const tab = S._t.el('dl-tab-recos');
    assert.match(tab.textContent, /Recommended/);
    const bar = S._t.el('dl-tab-trending').parentNode;
    const kids = bar.children.flatMap(c => (c.children.length && !c.id)
        ? c.children.map(x => x.id) : [c.id]);
    assert.ok(kids.indexOf('dl-tab-recos') < kids.indexOf('dl-tab-trending'),
        'hardware picks lead the tab strip: ' + kids.join(','));
    tab.onclick();
    assert.strictEqual(S._up23.DL.tab, 'recos');
    await tick(); await tick();
    assert.ok(S._t.gets.some(u => u.includes('/admin/api/hf/recommendations')),
        'opening the tab fetches the hardware picks');
    assert.ok(S._t.el('dl-results').find('rec-mac'), 'the panel replaced the flat list');
    assert.strictEqual(S._t.el('dl-pager').children.length, 0, 'no pager on a card surface');
});
test('trending/popular keep working and the recos tab steps aside on MS', async () => {
    const S = load({ data: recData() });
    dlPage(S);
    S.initDownloader();
    await tick(); await tick();
    S._t.el('dl-tab-trending').onclick();
    assert.strictEqual(S._up23.DL.tab, 'trending');
    await tick();
    assert.match(S._t.el('dl-results').dump(), /available|results|Loading/i,
        'the classic list tabs are untouched');
    await S._up22.DLX.setProvider('ms');
    await tick(); await tick();
    assert.strictEqual(S._t.el('dl-tab-recos').style.display, 'none',
        'ModelScope has no hardware picks upstream');
    S._t.el('dl-tab-recos').onclick();
    assert.strictEqual(S._up22.DL.tab, 'trending', 'and the tab refuses to open there');
});

/* ---- catalog + sink pins ---------------------------------------------- */
test('classic catalog only: no invented uplift keys, one innerHTML sink', () => {
    const keys = [...SRC.matchAll(/'(models\.recommend\.[\w._]+)'/g)].map(m => m[1]);
    assert.ok(keys.length > 40, 'the recos surface rides the classic catalog: ' + keys.length);
    // the guard-tier chip shares the GS page's tier keys (UP-19(10) cross-ref)
    for (const k of ['settings.resource.guard_tier.', 'settings.resource.guard_tier.description.'])
        assert.ok(SRC.includes(`'${k}'`), 'shared tier vocabulary: ' + k);
    assert.ok(!/C\.t(?:f)?\('uplift\.(rec|recommend)/.test(SRC), 'no new uplift recos keys');
    // every data-bearing string still enters through textContent
    const sinks = SRC.split(/\r?\n/).map(l => l.trim())
        .filter(l => l.includes('.innerHTML') && !l.startsWith('//') && !/= ''/.test(l));
    assert.strictEqual(sinks.length, 1, 'single innerHTML sink: ' + J(sinks));
    assert.ok(sinks[0].includes('window.DOMPurify.sanitize('));
    // the endpoint + payload this ticket sanctions
    assert.ok(SRC.includes('${API}/admin/api/hf/recommendations'));
    assert.ok(SRC.includes("{ memory_guard_tier: 'aggressive' }"));
    assert.match(SRC, /window\.confirm\(ask\)/, 'the tier flip confirms before it posts');
});
