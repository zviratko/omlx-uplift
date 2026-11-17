/* BENCH-CMP (user 2026-11-17) proofs — vm mount, no browser.
   Two shipped defects and one new feature:
   1. BUG: history cards called resultsHead WITHOUT a dl spec, so a past
      run's Copy was the legacy single plaintext button while the live panel
      offered Markdown/CSV/Table (text). Every history card now carries the
      same menu (+ Download JSON/CSV, the U70 availability rule).
   2. Feature: the History list lives in a bordered box, one row per run
      with a Compare checkbox, and 'Copy comparison' pastes the selected
      runs as ONE table (classic's intelligence-bench shape) in the three
      formats.
   3. Latent BUG fixed on the way: the live context panel's dl.rows()
      returned an OBJECT; toMarkdown/csvText iterate rows, so Copy >
      Markdown/CSV threw there. rows() is an array now.
   Harness = repl1-bench-mount's stub plus the pieces the menus need:
   setTimeout in the vm (dropMenu arms its document listener inside one),
   registry-backed document listeners, and a navigator.clipboard recorder
   (the skill's 'prove Copy output' rule). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR, runBench } = require('./static-src.cjs');

function makeHarness() {
    const byId = {};
    function makeEl(tag) {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            get className() { return [...(el._classes || [])].join(' '); },
            set className(v) {
                (v || '').split(/\s+/).filter(Boolean)
                    .forEach(c => el._classes && el._classes.add(c));
            },
            textContent: '', title: '', hidden: false,
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '', _attrs: {},
            setAttribute(k, v) { this._attrs[k] = String(v); },
            getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) {
                kids.forEach(k => {
                    if (typeof k === 'string') return;   // text node
                    k.parentNode = this; this.children.push(k);
                });
            },
            appendChild(k) {
                if (k && typeof k === 'object') k.parentNode = this;
                this.children.push(k); return k;
            },
            // the browser's Element.prepend - the ctx/ane history cards put
            // their Copy head above the content with it
            prepend(...kids) {
                kids.reverse().forEach(k => {
                    if (typeof k === 'string') return;
                    k.parentNode = this; this.children.unshift(k);
                });
            },
            removeChild(k) {
                const i = this.children.indexOf(k);
                if (i >= 0) this.children.splice(i, 1);
            },
            remove() {
                const p = this.parentNode;
                if (p) p.removeChild(this);
            },
            _lis: {},
            addEventListener(ty, fn) { (this._lis[ty] = this._lis[ty] || []).push(fn); },
            removeEventListener(ty, fn) {
                const a = this._lis[ty] || [];
                const i = a.indexOf(fn);
                if (i >= 0) a.splice(i, 1);
            },
            fire(ty, ev) {
                (this._lis[ty] || []).slice().forEach(fn => fn(ev || {
                    target: this, stopPropagation() {}, preventDefault() {},
                }));
            },
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            focus() {}, blur() {},
            classList: (() => {
                const set = new Set();
                return { _set: set,
                    add(...c) { c.forEach(x => set.add(x)); },
                    remove(...c) { c.forEach(x => set.delete(x)); },
                    contains(c) { return set.has(c); },
                    toggle(c, force) {
                        const want = force === undefined ? !set.has(c) : !!force;
                        if (want) set.add(c); else set.delete(c);
                        return want;
                    },
                };
            })(),
            oninput: null, onchange: null, onclick: null,
        };
        el._classes = el.classList._set;
        return el;
    }
    const docLis = {};
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
        addEventListener(ty, fn) { (docLis[ty] = docLis[ty] || []).push(fn); },
        removeEventListener(ty, fn) {
            const a = docLis[ty] || [];
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
        },
        fire(ty, ev) { (docLis[ty] || []).slice().forEach(fn => fn(ev || {})); },
    };
    return { byId, document, makeEl };
}

/* The classic catalog slice the TP tables need (values copied from
   omlx_web/i18n/en.json, same as repl1); everything else falls through to
   the shipped English fallback, which is what the assertions match. */
const CLS = {
    'bench.results.single.test': 'Test',
    'bench.results.single.ttft': 'TTFT (ms)',
    'bench.results.batch.batch_size': 'Batch Size',
};

function tick() { return new Promise(r => setTimeout(r, 5)); }

function mount(history) {
    const { byId, document, makeEl } = makeHarness();
    const clip = [];          // navigator.clipboard.writeText recorder
    const toasts = [];
    const win = {
        UpliftCore: { t: (k) => (CLS[k] == null ? k : CLS[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                const m = u.match(/\/bench\/history\?surface=(\w+)/);
                if (m) return { entries: (history || {})[m[1]] || [] };
                if (u.endsWith('/models')) return { models: [{ id: 'M1', model_type: 'llm' }] };
                if (u.endsWith('/bench/active')) return { running: false };
                throw new Error('no net: ' + u);
            },
            postJson: async () => ({}),
            toast: (m, k) => toasts.push([m, k]),
        },
        Uplift: { state: { API: '' } },
        document,
        navigator: { clipboard: { writeText: async (s) => { clip.push(s); } } },
        isSecureContext: true,
        requestAnimationFrame: (fn) => { fn(); return 1; },
        EventSource: function () { this.close = () => {}; },
        setInterval: () => 1, clearInterval: () => {},
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h),
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    runBench(ctx);
    return { win, byId, document, makeEl, clip, toasts, B: win.UpliftNativeBench };
}

const findCls = (n, cls, out) => {
    out = out || [];
    if (n && n._classes && n._classes.has(cls)) out.push(n);
    for (const k of (n && n.children) || []) findCls(k, cls, out);
    return out;
};
const allText = (el) => {
    let s = el.textContent || '';
    for (const k of el.children || []) s += ' ' + allText(k);
    return s;
};
const menuButtons = (host) => {
    const menus = findCls(host, 'bench-dl-menu');
    return menus.map(m => ({ menu: m, items: (m.children || []).map(b => b.textContent) }));
};
const clickMenu = (btn) => btn.fire('click', { stopPropagation() {} });

const ROW_A = [
    { test_type: 'single', pp: 1024, requested_pp: 1024, tg: 128,
      ttft_ms: 100, tpot_ms: 10, processing_tps: 8000, gen_tps: 100,
      total_throughput: 700, e2e_latency_s: 1.5,
      peak_memory_bytes: 2147483648, completion_tokens: 128 },
];
const ROW_B = [
    { test_type: 'single', pp: 1024, requested_pp: 1024, tg: 128,
      ttft_ms: 200, tpot_ms: 20, processing_tps: 7000, gen_tps: 90,
      total_throughput: 600, e2e_latency_s: 2.5,
      peak_memory_bytes: 1073741824, completion_tokens: 128 },
];
const label = (e) => new Date(e.ts * 1000).toLocaleString() + ' · ' + e.model_id;
const HIST = {
    throughput: [
        { id: 'hA', ts: 1760000000, model_id: 'M1', status: 'completed',
          rows: ROW_A, meta: {} },
        { id: 'hB', ts: 1760000001, model_id: 'M2', status: 'completed',
          rows: ROW_B, meta: {} },
        { id: 'hC', ts: 1760000002, model_id: 'M3', status: 'cancelled',
          rows: [], meta: {} },
    ],
};

// ---- 1. the bug: every history card's Copy is the 3-format menu ----

test('BENCH-CMP: a history card Copy opens Markdown/CSV/Table and copies the card table', async () => {
    const { win, byId, clip } = mount(HIST);
    win.UpliftNativeBench.mount();
    await tick();
    const host = byId['bench-tp-history'];
    const items = findCls(host, 'bench-history-item');
    assert.equal(items.length, 3, 'three runs listed (newest first)');
    // hA (oldest, model M1) is the card with the 100.0 TTFT row
    const card = items.find(it => (it.children[0] || {}).textContent
        && it.children[0].textContent.includes('M1')
        && findCls(it, 'bench-table').length);
    assert.ok(card, 'the finished M1 run card found');
    const heads = findCls(card, 'bench-results-head');
    assert.equal(heads.length, 1);
    const copyBtn = heads[0].children.find(b => b.textContent === 'Copy');
    assert.ok(copyBtn, 'Copy button present');
    clickMenu(copyBtn);
    const opened = menuButtons(heads[0]);
    assert.equal(opened.length, 1, 'one menu open');
    assert.deepEqual(opened[0].items, ['Markdown', 'CSV', 'Table (text)'],
        'the SAME three formats the live panel offers (was: bare Copy)');
    opened[0].menu.children[0].fire('click', { stopPropagation() {} });   // Markdown
    await tick();
    assert.equal(clip.length, 1, 'clipboard written');
    assert.ok(clip[0].startsWith('| Test | TTFT (ms)'), clip[0].split('\n')[0]);
    assert.ok(clip[0].includes('100.0'), 'row A value in the markdown');
    // Download rides the same dl (U70 availability rule)
    const dlBtn = heads[0].children.find(b => b.textContent === 'Download');
    assert.ok(dlBtn, 'history card also downloads');
});

// ---- 2. container + selection controls ----

test('BENCH-CMP: bordered box, one row per run, checkbox only where rows exist', async () => {
    const { win, byId } = mount(HIST);
    win.UpliftNativeBench.mount();
    await tick();
    const host = byId['bench-tp-history'];
    const box = findCls(host, 'bench-history-box');
    assert.equal(box.length, 1, 'the whole list sits in one container');
    assert.equal(box[0].parentNode, host, 'the box is the host child');
    const rows = findCls(box[0], 'bench-history-row');
    assert.equal(rows.length, 3, 'one row per run');
    // newest first: rows[0]=hC (cancelled, no rows), rows[1]=hB, rows[2]=hA
    assert.equal(findCls(rows[0], 'bench-check').length, 0,
        'a run without results offers nothing to compare');
    [rows[1], rows[2]].forEach((r, i) => {
        const picks = findCls(r, 'bench-check');
        assert.equal(picks.length, 1, 'a finished run offers Compare (#' + i + ')');
        assert.equal(picks[0].children[0].type, 'checkbox');
        assert.ok(allText(picks[0]).includes('Compare'));
        // THROUGH THE PARENT: the label is a sibling of the details,
        // never inside the <summary> (the toggle-fight trap)
        assert.equal(picks[0].parentNode, r);
        assert.equal(r.children.indexOf(picks[0]), 0, 'checkbox precedes the fold');
        assert.equal(findCls(r, 'bench-history-item').length, 1,
            'row carries exactly its own fold');
    });
    // the Copy comparison button sits in the history head, disabled at rest
    const head = findCls(box[0], 'bench-results-head')[0];
    const cmp = head.children.find(b => b.textContent === 'Copy comparison');
    const clear = head.children.find(b => b.textContent === 'Clear history');
    assert.ok(cmp, 'Copy comparison beside Clear history');
    assert.ok(clear && head.children.indexOf(cmp) < head.children.indexOf(clear),
        'comparison button precedes Clear');
    assert.equal(cmp.disabled, true, 'nothing picked yet');
    assert.equal(cmp.title, 'Select runs to compare first');
});

// ---- 3. the comparison copy: one merged table, three formats ----

test('BENCH-CMP: Copy comparison pastes the selected runs as ONE table', async () => {
    const { win, byId, clip } = mount(HIST);
    win.UpliftNativeBench.mount();
    await tick();
    const host = byId['bench-tp-history'];
    const rows = findCls(host, 'bench-history-row');
    // select hB and hA (the two finished runs; hC has no checkbox)
    const picks = rows.flatMap(r => findCls(r, 'bench-check'))
        .map(l => l.children[0]);
    assert.equal(picks.length, 2, 'only finished runs are pickable');
    picks.forEach(cb => { cb.checked = true; cb.fire('change', { target: cb }); });
    const head = findCls(host, 'bench-results-head')[0];
    const cmp = head.children.find(b => b.textContent === 'Copy comparison');
    assert.equal(cmp.disabled, false, 'picking arms the button');
    assert.equal(cmp.title, 'Copy the selected runs as one table');
    clickMenu(cmp);
    const opened = menuButtons(head);
    assert.deepEqual(opened[0].items, ['Markdown', 'CSV', 'Table (text)'],
        'the same format menu as every other Copy');
    const [hA, hB] = HIST.throughput;
    // Markdown
    opened[0].menu.children[0].fire('click', { stopPropagation() {} });
    await tick();
    const md = clip[clip.length - 1].split('\n');
    assert.ok(md[0].startsWith('| Run | Test |'), md[0]);
    assert.equal(md.length, 4, 'header + separator + one row per selected run');
    assert.ok(md[2].includes(label(hB)) && md[3].includes(label(hA)),
        'newest first, run label in column one: ' + md.join('\n'));
    assert.ok(md[2].includes('200.0') && md[3].includes('100.0'),
        'each row keeps ITS OWN values (getters do not leak across runs)');
    // CSV
    opened[0].menu.children[1].fire('click', { stopPropagation() {} });
    await tick();
    const csv = clip[clip.length - 1].split('\n');
    assert.ok(csv[0].startsWith('Run,Test,'), csv[0]);
    assert.equal(csv.length, 3);
    // Table (text)
    opened[0].menu.children[2].fire('click', { stopPropagation() {} });
    await tick();
    const txt = clip[clip.length - 1];
    assert.ok(txt.startsWith('Benchmark Comparison\n'), txt.split('\n')[0]);
    assert.ok(/RUN|Run/.test(txt.split('\n')[2]), 'header row carries the Run column');
    assert.ok(txt.includes(label(hB)) && txt.includes(label(hA)));
});

test('BENCH-CMP: one selected run still copies (and un-picking disarms again)', async () => {
    const { win, byId, clip } = mount(HIST);
    win.UpliftNativeBench.mount();
    await tick();
    const host = byId['bench-tp-history'];
    const head = findCls(host, 'bench-results-head')[0];
    const cmp = head.children.find(b => b.textContent === 'Copy comparison');
    const cb = findCls(host, 'bench-check')[0].children[0];
    cb.checked = true; cb.fire('change', { target: cb });
    assert.equal(cmp.disabled, false);
    cb.checked = false; cb.fire('change', { target: cb });
    assert.equal(cmp.disabled, true, 'no phantom copy when nothing is picked');
});

// ---- 4. selection survives a history reload (finish() re-loads) ----

test('BENCH-CMP: picks survive the reload a finished run triggers', async () => {
    const { win, byId, B } = mount(HIST);
    win.UpliftNativeBench.mount();
    await tick();
    const host = byId['bench-tp-history'];
    const cbs = findCls(host, 'bench-check').map(l => l.children[0]);
    cbs[0].checked = true; cbs[0].fire('change', { target: cbs[0] });
    await B.tp.loadHist();
    await tick();
    const cbs2 = findCls(byId['bench-tp-history'], 'bench-check').map(l => l.children[0]);
    assert.equal(cbs2[0].checked, true, 'the pick is still painted');
    const head = findCls(byId['bench-tp-history'], 'bench-results-head')[0];
    const cmp = head.children.find(b => b.textContent === 'Copy comparison');
    assert.equal(cmp.disabled, false, 'and the button is still armed');
});

// ---- 5. the same dl plumbing on the context + ANE history cards ----

const CTX_HIST = {
    context: [
        { id: 'cA', ts: 1760000000, model_id: 'M1', status: 'completed',
          rows: [{ model_id: 'M1', target_tokens: 32768, measured_tokens: 30000,
                   verified_tokens: 30000, applied_tokens: 30000,
                   capped_by: 'native', prefill_tps: 1200, duration_s: 4.2 }] },
        { id: 'cB', ts: 1760000001, model_id: 'M1', status: 'completed',
          rows: [{ model_id: 'M1', target_tokens: 65536, measured_tokens: 60000,
                   verified_tokens: 60000, applied_tokens: 60000,
                   capped_by: 'kv', prefill_tps: 1100, duration_s: 8.4 }] },
    ],
};
test('BENCH-CMP: context history cards carry the menu; comparison reads runs across the field columns', async () => {
    const { win, byId, clip } = mount(CTX_HIST);
    const CTX = win.UpliftNativeBench._panels.ctx;
    CTX.state = { running: false, benchId: null, result: null, models: [] };
    await CTX.loadHist();
    await tick();
    const host = byId['bench-ctx-history'];
    const heads = findCls(host, 'bench-results-head');
    const cardHead = heads.find(h => h.children.some(b => b.textContent === 'Copy'));
    assert.ok(cardHead, 'the card head (the history head has no bare Copy)');
    clickMenu(cardHead.children.find(b => b.textContent === 'Copy'));
    assert.deepEqual(menuButtons(cardHead)[0].items,
        ['Markdown', 'CSV', 'Table (text)']);
    const cbs = findCls(host, 'bench-check').map(l => l.children[0]);
    assert.equal(cbs.length, 2);
    cbs.forEach(cb => { cb.checked = true; cb.fire('change', { target: cb }); });
    const head = findCls(host, 'bench-results-head')[0];
    const cmp = head.children.find(b => b.textContent === 'Copy comparison');
    clickMenu(cmp);
    menuButtons(head)[0].menu.children[0].fire('click', { stopPropagation() {} });
    await tick();
    const md = clip[clip.length - 1].split('\n');
    assert.ok(md[0].includes('| Run | Model | Target |'), md[0]);
    assert.equal(md.length, 4, 'one row per run, fields across the header');
    assert.ok(md[2].includes('65,536 tokens') && md[3].includes('32,768 tokens'),
        'newest first, each row keeps its own measurement: ' + md.join('\n'));
});

const ANE_HIST = {
    ane: [
        { id: 'aA', ts: 1760000000, model_id: 'M1', status: 'completed',
          rows: [{ split: 'gate', state: 'ANE', processing_tps: 12345.6, latency_ms: 7.8 }] },
    ],
};
test('BENCH-CMP: ANE history card carries the menu too', async () => {
    const { win, byId } = mount(ANE_HIST);
    const ANE = win.UpliftNativeBench._panels.ane;
    ANE.state = { running: false, tuningId: null, snapshot: null };
    await ANE.loadHist();
    await tick();
    const host = byId['bench-ane-history'];
    const heads = findCls(host, 'bench-results-head');
    const cardHead = heads.find(h => h.children.some(b => b.textContent === 'Copy'));
    assert.ok(cardHead, 'the card head');
    clickMenu(cardHead.children.find(b => b.textContent === 'Copy'));
    assert.deepEqual(menuButtons(cardHead)[0].items,
        ['Markdown', 'CSV', 'Table (text)']);
});

// ---- 6. pure merge: a shorter later entry pads, never shifts values ----

test('BENCH-CMP: mergeRunTables pads missing columns instead of shifting', () => {
    const { win } = mount({});
    const { mergeRunTables } = win.UpliftNativeBench._u49;
    const cols2 = [{ head: 'A', get: (r) => r.a }, { head: 'B', get: (r) => r.b }];
    const m = mergeRunTables([
        { label: 'r1', cols: cols2, rows: [{ a: 1, b: 2 }] },
        { label: 'r2', cols: [{ head: 'A', get: (r) => r.a }], rows: [{ a: 3 }] },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(m.cols.map(c => c.head))),
        ['Run', 'A', 'B']);
    const cells = m.rows.map(r => r.cells);
    assert.deepEqual(JSON.parse(JSON.stringify(cells)), [[1, 2], [3, '']],
        'the second run leaves column B empty, not B=3 shifted');
    assert.deepEqual(m.rows.map(r => r.run), ['r1', 'r2']);
});

// ---- 7. gates that only source/CSS can hold ----

const SRC = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');
const CSS = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');

test('BENCH-CMP: the bare-list shape is gone (negative pins)', () => {
    assert.ok(SRC.includes("el('div', 'bench-history-box')"), 'box painted');
    assert.ok(!/host\.appendChild\(det\)/.test(SRC),
        'details never append straight to the host again');
    // the history card menus are wired through the shared dl spec
    assert.ok(/tpHistoryBody[\s\S]*?resultsHead\(function \(\) \{[\s\S]*?\}, null, null, tpHistoryDl\(e\)\)/.test(SRC),
        'tp history Copy carries tpHistoryDl');
});

test('BENCH-CMP: the history box CSS exists with house tokens', () => {
    const rule = CSS.match(/\.bench-history-box \{[^}]*\}/);
    assert.ok(rule, 'container rule shipped');
    assert.ok(/border:\s*1px solid var\(--edge\)/.test(rule[0]), 'bordered');
    assert.ok(/border-radius:\s*var\(--radius\)/.test(rule[0]), 'radius token, no literal');
    assert.ok(/\.bench-history-row \{[^}]*display:\s*flex/.test(CSS), 'row is a flex line');
    assert.ok(/\.bench-results-head \.btn:disabled \{[^}]*opacity/.test(CSS),
        'the disabled comparison button reads as disabled');
});

// ---- 8. locale self-pin: t(key, fb) call sites are invisible to the
//             pytest gate, so this file owns the whole family ----

test('BENCH-CMP: the six new keys ship in all 10 locales', () => {
    const keys = ['uplift.bench.history.compare',
                  'uplift.bench.history.copy_comparison',
                  'uplift.bench.history.copy_comparison_tip',
                  'uplift.bench.history.pick_first',
                  'uplift.bench.history.compare_title',
                  'uplift.bench.history.run'];
    const dir = path.join(STATIC_DIR, '..', 'locales');
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of keys) {
            assert.ok(typeof d[k] === 'string' && d[k].length, f + ' ' + k);
        }
        if (f === 'en.json') continue;
        const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
        for (const k of keys) {
            assert.notEqual(d[k], en[k], f + ' ' + k + ' must not stay English');
        }
    }
});
