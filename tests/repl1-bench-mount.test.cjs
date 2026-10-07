/* REPL-1 mount proof (fe1-patches-render harness pattern): the native
   Bench bootstrap really paints into #bench-native — the exact thing the
   first browser probe could not confirm (stale server, not the module).
   vm sandbox + DOM stub, no browser:
   - mount() renders the 4-subtab strip and the throughput panel once
   - labels come through UpliftCore.t (i18n doctrine: no raw key, no
     hardcoded English when a translation exists)
   - showSub('accuracy') swaps in the stub card
   - double mount is a no-op (host keeps its children)

   The stub registers ids on assignment so getElementById('bench-subpanel')
   inside the module returns the very object mount() appended — that
   id-identity is exactly what showSub relies on in a real browser. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function makeHarness() {
    const byId = {};
    function makeEl(tag) {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            className: '', textContent: '', title: '', hidden: false,
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '',
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
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
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    return { byId, document, makeEl };
}

function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children) s += ' ' + allText(k);
    return s;
}

const CAT = {   // fake merged catalog: classic + uplift keys, one marker lang
    'bench.heading': 'BENCHHEADING',
    'navbar.dropdown.performance': 'SUBTP',
    'navbar.dropdown.accuracy': 'SUBACC',
    'navbar.dropdown.context': 'SUBCTX',
    'uplift.bench.ane_tune': 'SUBANE',
    'uplift.bench.native_stub': 'STUBNOTE',
    'bench.config.model': 'LBLMODEL',
    'bench.config.run_button': 'BTNRUN',
    'acc_bench.heading': 'ACCHEADING',
    'acc_bench.config.add_run': 'ACCADD',
    'acc_bench.benchmarks.group_knowledge': 'GRPKNOW',
    'acc_bench.benchmarks.mmlu_desc': 'GRPMMLUDESC',
    'uplift.bench.engine': 'ENGINEFIELD',
    'uplift.bench.engine_classic': 'ENGC',
    'uplift.bench.engine_harness': 'ENGH',
    'ctx_bench.heading': 'CTXHEADING',
    'ctx_bench.start': 'CTXSTART',
    'ctx_bench.result.section_label': 'CTXRESULT',
    'modal.model_settings.qwen_ane_tune': 'ANEHEADING',
    'modal.model_settings.qwen_ane_tune_start': 'ANESTART',
};

function load() {
    const { byId, document } = makeHarness();
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: { fetchJson: async (u) => {
                    if (String(u).endsWith('/bench/accuracy/tasks')) {
                        return { tasks: [{ group: 'acc_bench.benchmarks.group_knowledge',
                            tasks: [{ key: 'mmlu', label: 'MMLU',
                                      desc: 'acc_bench.benchmarks.mmlu_desc',
                                      full_size: 14042, sizes: [30, 50, 100] }] }],
                                 valid: ['mmlu'] };
                    }
                    throw new Error('no net in tests');
                },
                     postJson: async () => { throw new Error('no net in tests'); },
                     toast: () => {} },
        Uplift: { state: { API: '' } },
        document,
        requestAnimationFrame: () => {},
        EventSource: undefined,
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8');
    new vm.Script(src).runInContext(ctx);
    return { win, byId };
}

test('mount paints subtabs + throughput form through the catalog', () => {
    const { win, byId } = load();
    assert.ok(win.UpliftNativeBench, 'module global exported on window');
    win.UpliftNativeBench.mount();
    const host = byId['bench-native'];
    assert.ok(host.children.length >= 2, 'strip + panel mounted');
    const text = allText(host);
    for (const marker of ['SUBTP', 'SUBACC', 'SUBCTX', 'SUBANE'])
        assert.ok(text.includes(marker), `subtab label ${marker} rendered`);
    assert.ok(text.includes('BENCHHEADING'), 'heading via C.t, not raw key');
    assert.ok(text.includes('LBLMODEL'), 'model label translated');
    assert.ok(text.includes('BTNRUN'), 'run button translated');
    assert.ok(!text.includes('bench.heading'), 'no raw i18n key leaks to UI');
    assert.ok(win.UpliftNativeBench.isMounted(), 'isMounted flips after mount');
});

test('showSub with an unknown key falls back to the honest stub card', () => {
    // every real subtab is live now (REPL-1/2a/3) — the stub path stays
    // as the safe fallback for unknown keys, not as a parked feature
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('not-a-surface');
    const text = allText(byId['bench-subpanel']);
    assert.ok(text.includes('STUBNOTE'), 'stub note translated');
});

test('REPL-3: context subtab renders the native probe form', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('context');
    const text = allText(byId['bench-subpanel']);
    assert.ok(text.includes('CTXHEADING'), 'ctx heading via classic key');
    assert.ok(text.includes('CTXSTART'), 'start button via classic key');
    assert.ok(!text.includes('ctx_bench.'), 'no raw ctx key leaks');
});

test('REPL-3: ANE subtab renders the tuning form', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('ane');
    const text = allText(byId['bench-subpanel']);
    assert.ok(text.includes('ANEHEADING'), 'ane title via classic key');
    assert.ok(text.includes('ANESTART'), 'start button via classic key');
    assert.ok(!text.includes('modal.model_settings.'), 'no raw ane key leaks');
});

test('REPL-2a: accuracy subtab renders form + server task grid', async () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('accuracy');
    await new Promise(r => setTimeout(r, 0));  // let loadTasks promise settle
    const panel = byId['bench-subpanel'];
    const text = allText(panel);
    assert.ok(text.includes('ACCHEADING'), 'acc heading via classic key');
    assert.ok(text.includes('ACCADD'), 'add button via classic key');
    assert.ok(text.includes('GRPKNOW'), 'group header via classic key');
    assert.ok(text.includes('GRPMMLUDESC'), 'task desc via classic key (from /tasks)');
    assert.ok(text.includes('MMLU'), 'task label passthrough');
    assert.ok(!text.includes('acc_bench.'), 'no raw acc key leaks');
    // REPL-2b: engine selector (classic default, harness alternative)
    assert.ok(text.includes('ENGC') && text.includes('ENGH'), 'engine radios translated');
    const radios = [];
    (function walk(n) {
        if (n && n.tagName === 'input' && n.name === 'bench-acc-engine') radios.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(panel);
    assert.equal(radios.length, 2, 'two engine choices');
    const checked = radios.filter(r => r.checked).map(r => r.value);
    assert.deepEqual(checked, ['classic'], 'default engine = classic');
});

test('second mount is a no-op (no double paint)', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    const first = byId['bench-native'].children.length;
    win.UpliftNativeBench.mount();
    assert.equal(byId['bench-native'].children.length, first);
});
