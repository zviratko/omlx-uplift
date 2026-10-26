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
        const el = {   // self-reference: the className getter reads _classes
        
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
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            // CACHE-OFF/TP-TABLES: registry-backed listeners, so a test can
            // actually fire the change events the panel wires (a no-op stub
            // proves nothing about the handler)
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
            remove() {}, focus() {}, blur() {},
            // U69: real class tracking — structural tests now inspect
            // per-card state (acc-task on/off, variant keys), the old
            // always-false stub made those assertions impossible
            classList: (() => {
                const set = new Set();
                return { _set: set,
                    add(...c) { c.forEach(x => set.add(x)); },
                    remove(...c) { c.forEach(x => set.delete(x)); },
                    contains(c) { return set.has(c); },
                    toggle(c) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; },
                };
            })(),
            oninput: null, onchange: null, onclick: null,
        };
        el._classes = el.classList._set;
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

/* DEC-GROUPS: read the model picker back out of the DOM stub.
   { groups: [{label, options:[{text, disabled}]}], loose: [option...] } —
   'loose' is what the pre-feature (and the fallback) picker produces, so a
   test can prove WHICH shape the panel painted, not just which ids are in it. */
function decPicker(sel) {
    const groups = [];
    const loose = [];
    const opt = (o) => ({ text: o.textContent, disabled: !!o.disabled,
                          value: o.value });
    for (const kid of (sel && sel.children) || []) {
        if (kid.tagName === 'optgroup')
            groups.push({ label: kid.label, options: (kid.children || []).map(opt) });
        else if (kid.tagName === 'option') loose.push(opt(kid));
    }
    return { groups, loose };
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
    'uplift.bench.embeddings': 'SUBEMB',
    'uplift.bench.rerankers': 'SUBRRK',
    'uplift.bench.decision': 'SUBDEC',
    'uplift.bench.decision_desc': 'DECDESC',
    'uplift.bench.dec_accuracy': 'DECACC',
    // DEC-GROUPS: the two picker optgroups + the capability note
    'uplift.bench.dec_group_native': 'DECGRPNAT',
    'uplift.bench.dec_group_generic': 'DECRPOTHER',
    'uplift.bench.dec_generic_needs_newer': 'DECNEEDSNEWER',
    'uplift.bench.pack.arc_choice': 'PACKARC',
    'uplift.bench.pack.bbq_choice': 'PACKBBQ',
    'uplift.bench.pack.tqa_choice': 'PACKTQA',
    'modal.model_settings.qwen_ane_tune': 'ANEHEADING',
    'modal.model_settings.qwen_ane_tune_start': 'ANESTART',
};

function load(opts) {
    opts = opts || {};
    const { byId, document } = makeHarness();
    // DEC-GROUPS: the server-owned picker groups (frozen contract: ids only,
    // already sorted server-side). Override per-test to drive the disabled /
    // fallback states.
    const decModels = opts.decModels === null ? null : (opts.decModels || {
        generic_available: true, generic_reason: '',
        native: ['clef-flash-4bit'], generic: ['SmolLM2-360M-Instruct-oQ4'] });
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: { fetchJson: async (u) => {
                    u = String(u);
                    // BEFORE the /models branch: this URL ENDS with
                    // '/models' too, so ordering is the whole stub contract
                    if (u.includes('/bench/decision/models')) {
                        if (decModels === null) throw new Error('404');
                        return decModels;
                    }
                    if (u.endsWith('/models')) {
                        return { models: [
                            { id: 'Qwen3-Embedding-0.6B-4bit-DWQ', engine_type: 'embedding' },
                            { id: 'jina-reranker-v3.5-mlx-q8', engine_type: 'reranker' },
                            { id: 'clef-flash-4bit', engine_type: 'decision' },
                            { id: 'SmolLM2-360M-Instruct-oQ4', engine_type: 'llm' }] };
                    }
                    if (String(u).endsWith('/bench/embed/tasks')) {
                        return { env: 'ready', tasks: {
                            'STS12': { kind: 'embed', group: 'sts', sizes: 3108, cs: false },
                            'CTKFactsNLI': { kind: 'embed', group: 'pair', sizes: 680, cs: true },
                            'HUMECore17InstructionReranking': { kind: 'rerank', group: 'rerank', sizes: 160, cs: false } } };
                    }
                    if (String(u).endsWith('/bench/decision/tasks')) {
                        return { tasks: {
                            'arc-choice': { kind: 'decision', items: 294, license: 'CC-BY-SA-4.0',
                                            source: 'allenai/ai2_arc (ARC-Challenge) split=test' },
                            'bbq-choice': { kind: 'decision', items: 300, license: 'CC-BY-4.0',
                                            source: 'oskarvanderwal/bbq (All) split=test' },
                            'tqa-choice': { kind: 'decision', items: 400, license: 'Apache-2.0',
                                            source: 'truthfulqa/truthful_qa (multiple_choice) split=validation' } } };
                    }
                    if (String(u).endsWith('/bench/decision/results')
                        || String(u).endsWith('/bench/decision/active')) {
                        return String(u).endsWith('/results')
                            ? { results: [{ pack: 'arc-choice', model_id: 'clef-flash-4bit',
                                            accuracy: 0.8571, brier: 0.05, ece: 0.04,
                                            agreement: 0.96, ms_per_question: 480,
                                            items: 294, skipped: 0, ts: 1760000000 }] }
                            : { running: false };
                    }
                    if (String(u).endsWith('/bench/accuracy/tasks')) {
                        return { tasks: [{ group: 'acc_bench.benchmarks.group_knowledge',
                            tasks: [{ key: 'mmlu', label: 'MMLU',
                                      desc: 'acc_bench.benchmarks.mmlu_desc',
                                      full_size: 14042, sizes: [30, 50, 100] }] }],
                                 valid: ['mmlu'],
                                 harness_tasks: ['mmlu'] };
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
    // BENCHQ: host children legitimately moved — strip+panel now live in
    // .bench-col-main inside the .bench-cols grid (queue box = column 2).
    // Same two nodes, one level down; everything below still walks them.
    assert.equal(host.children.length, 1, 'one host child: the cols grid');
    const cols = host.children[0];
    assert.ok(String(cols.className).includes('bench-cols'), 'cols wrapper mounted');
    const main = cols.children[0];
    assert.ok(String(main.className).includes('bench-col-main'), 'strip+panel column');
    assert.equal(main.children.length, 2, 'strip + panel inside the column');
    assert.ok(String(cols.children[1].className).includes('bench-queue'),
        'queue box is the sibling column');
    assert.equal(cols.children[1].hidden, true, 'queue box hidden while empty');
    assert.ok(!String(cols.className).includes('has-q'), 'no 2nd column when empty');
    const text = allText(host);
    for (const marker of ['SUBTP', 'SUBACC', 'SUBCTX', 'SUBANE'])
        assert.ok(text.includes(marker), `subtab label ${marker} rendered`);
    assert.ok(text.includes('BENCHHEADING'), 'heading via C.t, not raw key');
    assert.ok(text.includes('LBLMODEL'), 'model label translated');
    assert.ok(text.includes('BTNRUN'), 'run button translated');
    assert.ok(!text.includes('bench.heading'), 'no raw i18n key leaks to UI');
    assert.ok(win.UpliftNativeBench.isMounted(), 'isMounted flips after mount');
});

test('U60: showSub mirrors the panel into the URL hash (replaceState)', () => {
    const { win } = load();
    let last = null;
    win.location = { hash: '#bench/throughput', pathname: '/uplift/', search: '?native=all' };
    win.history = { replaceState: (_s, _t, url) => { last = url; win.location.hash = url.split('#')[1] ? '#' + url.split('#')[1] : ''; } };
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('decision');
    assert.equal(last, '/uplift/?native=all#bench/decision', 'hash mirrors the strip');
    const before = last;
    win.UpliftNativeBench.showSub('decision');
    assert.equal(last, before, 'idempotent: same sub does not rewrite');
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
    // U69: NO engine radios — the engine is a per-card caption, and the
    // harness-mapped suite appears a SECOND time as an LM-Eval card
    const inputs = [];
    (function walk(n) {
        if (n && n.tagName === 'input') inputs.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(panel);
    assert.ok(!inputs.some(i => i.name === 'bench-acc-engine'),
        'engine toggle removed (merged list)');
    const cards = [];
    (function walk(n) {
        if (n && n._classes && n._classes.has('acc-task')) cards.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(panel);
    assert.equal(cards.length, 2, 'mmlu once classic, once LM-Eval');
    const keys = cards.map(c => c.dataset.key).sort();
    assert.deepEqual(keys, ['mmlu', 'mmlu|h'], 'variant card keys |h');
    assert.ok(text.includes('ENGC') && text.includes('ENGH'),
        'both engine captions via catalog keys');
});

test('REPL-4: subtab strip carries Embeddings + Rerankers through the catalog', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    const strip = allText(byId['bench-native']).split('BENCHHEADING')[0];
    assert.ok(strip.includes('SUBEMB') && strip.includes('SUBRRK'),
        'embed/rerank subtab labels present');
});

test('REPL-4c: decision subtab paints pack grid + model filter + results table', async () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    assert.ok(allText(byId['bench-native']).split('BENCHHEADING')[0]
        .includes('SUBDEC'), 'decision subtab label present');
    win.UpliftNativeBench.showSub('decision');
    await new Promise(r => setTimeout(r, 15));
    const panel = byId['bench-subpanel'];
    const text = allText(panel);
    assert.ok(text.includes('DECDESC'), 'panel desc via uplift key');
    // pack names come from the catalog, not raw fixture ids
    assert.ok(text.includes('PACKARC') && text.includes('PACKBBQ')
        && text.includes('PACKTQA'), 'pack cards translated');
    assert.ok(!text.includes('arc-choice'), 'no raw pack id leaks to UI');
    // model picker: TWO server-owned groups, decision models in the first
    const picker = decPicker(byId['bench-dec-model']);
    const nat = picker.groups.find(g => g.label === 'DECGRPNAT');
    const oth = picker.groups.find(g => g.label === 'DECRPOTHER');
    assert.ok(nat && oth, 'two optgroups (Decision models / Other models) '
        + 'with labels through the catalog');
    assert.deepEqual(picker.groups.map(g => g.label), ['DECGRPNAT', 'DECRPOTHER'],
        'decision group first, other models second');
    assert.deepEqual(nat.options.map(o => o.text), ['clef-flash-4bit'],
        'decision model in the native group');
    assert.ok(!nat.options.some(o => o.disabled), 'native group selectable');
    // REPL-4C PIN INVERTED: a chat model (engine_type 'llm' in /models) is
    // now a legal decision-bench target — scored through /v1/decisions — and
    // appears under 'Other models'. The group comes from the SERVER's
    // native/generic lists, not from client engine_type guessing.
    assert.deepEqual(oth.options.map(o => o.text), ['SmolLM2-360M-Instruct-oQ4'],
        'LLM is selectable on the decision tab, in the Other models group');
    assert.ok(!oth.options.some(o => o.disabled),
        'Other models enabled when generic_available is true');
    assert.ok(!allText(panel).includes('uplift.bench.dec_group')
        && !allText(panel).includes('dec_generic_needs_newer'),
        'no raw picker key leaks');
    // results roundtrip: accumulated row rendered through the table
    assert.ok(text.includes('DECACC'), 'translated score column header');
    assert.ok(text.includes('0.8571') && text.includes('clef-flash-4bit'),
        'accumulated result row rendered');
});

test('DEC-GROUPS: generic_available:false disables Other models and says why', async () => {
    const { win, byId } = load({ decModels: {
        generic_available: false,
        generic_reason: 'this omlx build does not expose /v1/decisions',
        native: ['clef-flash-4bit'],
        generic: ['SmolLM2-360M-Instruct-oQ4'] } });
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('decision');
    await new Promise(r => setTimeout(r, 15));
    const picker = decPicker(byId['bench-dec-model']);
    const nat = picker.groups.find(g => g.label === 'DECGRPNAT');
    const oth = picker.groups.find(g => g.label === 'DECRPOTHER');
    assert.ok(oth, 'the group stays visible — a greyed group that explains '
        + 'itself beats a silent omission');
    assert.equal(oth.options[0].text, 'DECNEEDSNEWER',
        'capability note is the FIRST entry of the group, via its catalog key');
    assert.equal(oth.options[0].disabled, true, 'the note is not selectable');
    assert.deepEqual(oth.options.slice(1).map(o => o.text),
        ['SmolLM2-360M-Instruct-oQ4'], 'the models are still listed');
    assert.ok(oth.options.every(o => o.disabled),
        'every Other model is DISABLED while the server cannot score it');
    assert.ok(!nat.options.some(o => o.disabled),
        'decision models stay selectable when the generic path is missing');
});

test('REPL-4: embed subtab paints model filter + task grid from the server', async () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('embed');
    await new Promise(r => setTimeout(r, 15));
    const panel = byId['bench-subpanel'];
    const text = allText(panel);
    assert.ok(text.includes('SUBEMB'), 'panel heading uses the embeddings key');
    assert.ok(text.includes('STS12') && text.includes('CTKFactsNLI'),
        'embed-kind tasks rendered from /bench/embed/tasks');
    assert.ok(!text.includes('HUMECore17'), 'rerank-kind task hidden on the embed tab');
    assert.ok(text.includes('[CZ]'), 'Czech task flagged');
    const sel = byId['bench-embed-model'];
    const opts = sel.children.map(o => o.textContent);
    assert.ok(opts.includes('Qwen3-Embedding-0.6B-4bit-DWQ'),
        'model picker filtered to embedding engine_type');
    assert.ok(!opts.includes('SmolLM2-360M-Instruct-oQ4'), 'LLMs excluded');
    const note = byId['bench-embed-envnote'];
    assert.equal(note.hidden, true, 'env note hidden when mteb-env ready');
});

test('REPL-4: rerank subtab paints the rerank-kind task only', async () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    win.UpliftNativeBench.showSub('rerank');
    await new Promise(r => setTimeout(r, 15));
    const text = allText(byId['bench-subpanel']);
    assert.ok(text.includes('HUMECore17InstructionReranking'), 'rerank task rendered');
    assert.ok(!text.includes('STS12'), 'embed task hidden on the rerank tab');
    const sel = byId['bench-rerank-model'];
    const opts = sel.children.map(o => o.textContent);
    assert.ok(opts.includes('jina-reranker-v3.5-mlx-q8'), 'reranker model offered');
});

test('second mount is a no-op (no double paint)', () => {
    const { win, byId } = load();
    win.UpliftNativeBench.mount();
    const first = byId['bench-native'].children.length;
    win.UpliftNativeBench.mount();
    assert.equal(byId['bench-native'].children.length, first);
});

/* ==========================================================================
   TP-CLASSIC + CACHE-OFF (user items 2, 3, 5) through the real mount path:
   the throughput panel paints classic's TWO tables, the history card carries
   the cache-off note, and the Advanced section's two new checkboxes are
   unchecked by default and reach the start body only when checked.
   The stub is the mount-test one plus the pieces these pins need: a REAL
   classic catalog (values copied verbatim from omlx_web/i18n/en.json), an
   EventSource recorder, controllable timers, and a fetchJson that answers
   /bench/history. Inputs also expose .checked/.value the way the panel reads
   them (fill_input is not involved — this is the DOM, not a browser). */
const CLS = {
    'bench.results.single.section_label': 'Single Request Results',
    'bench.results.single.test': 'Test',
    'bench.results.single.ttft': 'TTFT (ms)',
    'bench.results.single.tpot': 'TPOT (ms/tok)',
    'bench.results.single.pp_tps': 'PP TPS',
    'bench.results.single.tg_tps': 'TG TPS',
    'bench.results.single.e2e_latency': 'E2E Latency',
    'bench.results.single.throughput': 'Throughput',
    'bench.results.single.peak_mem': 'Peak MLX',
    'bench.results.batch.section_label': 'Continuous Batching',
    'bench.results.batch.batch_size': 'Batch Size',
    'bench.results.batch.tg_tps': 'TG TPS',
    'bench.results.batch.speedup': 'Speedup',
    'bench.results.batch.pp_tps': 'PP TPS',
    'bench.results.batch.pp_tps_req': 'PP TPS/req',
    'bench.results.batch.avg_ttft': 'Avg TTFT (ms)',
    'bench.results.batch.e2e_latency': 'E2E Latency',
    'bench.results.batch.baseline': '1x (baseline)',
    'bench.results.text_export.not_available': 'N/A',
    'bench.metrics.ttft.tooltip': 'Time to First Token.',
    'bench.metrics.peak_mem.tooltip': 'Peak active MLX allocations during this test.',
    'bench.metrics.batch_size.tooltip': 'Batch Size — requests at once.',
};

function mountLoad(history) {
    const { byId, document, makeEl } = makeHarness();
    const es = [];
    const win = {
        UpliftCore: { t: (k) => (CLS[k] == null ? k : CLS[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/bench/history?surface=throughput'))
                    return { entries: history || [] };
                if (u.endsWith('/models')) return { models: [{ id: 'M1', model_type: 'llm' }] };
                if (u.endsWith('/bench/active')) return { running: false };
                throw new Error('no net: ' + u);
            },
            postJson: async () => { throw new Error('no net'); },
            toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document,
        requestAnimationFrame: (fn) => { fn(); return 1; },   // wire the form now
        EventSource: function (url) { const s = this; this.url = url;
            this.close = () => { s.closed = true; }; es.push(this); },
        setInterval: () => 1, clearInterval: () => {},
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8'))
        .runInContext(ctx);
    return { win, byId, es, B: win.UpliftNativeBench };
}

const ROWS = [
    { test_type: 'single', pp: 1024, requested_pp: 1024, tg: 128,
      ttft_ms: 100, tpot_ms: 10, processing_tps: 8000, gen_tps: 100,
      total_throughput: 700, e2e_latency_s: 1.5,
      peak_memory_bytes: 2147483648, completion_tokens: 128 },
    { test_type: 'batch', batch_size: 2, tg: 128, tg_tps: 170, pp_tps: 12000,
      avg_ttft_ms: 200, e2e_latency_s: 2, total_gen_tokens: 256,
      requested_pp: 1024, prompt_tokens_min: 1024, prompt_tokens_max: 1024 },
];
const tables = (node, out) => {
    out = out || [];
    if (node && node.tagName === 'table') out.push(node);
    for (const k of (node && node.children) || []) tables(k, out);
    return out;
};
const heads = (t) => t.children[0].children.map(th => th.textContent);
const cells = (t, i) => t.children[i].children.map(td => td.textContent);

test('CACHE-OFF: the Advanced section carries both boxes, unchecked', () => {
    const { win, byId } = mountLoad();
    win.UpliftNativeBench.mount();
    const hot = byId['bench-tp-no-hot'], ssd = byId['bench-tp-no-ssd'];
    assert.equal(hot.type, 'checkbox', 'hot cache box is a real checkbox');
    assert.equal(ssd.type, 'checkbox');
    assert.equal(hot.checked, false, 'off by default — the run must not touch my settings');
    assert.equal(ssd.checked, false);
    // reached THROUGH THE PARENT: a control built but never appended would
    // pass a byId lookup and show nothing in the browser
    const panel = byId['bench-subpanel'];
    const adv = [];
    (function walk(n) {
        if (n && n._classes && n._classes.has('bench-adv-body')) adv.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(panel);
    assert.equal(adv.length, 1, 'one Advanced body');
    const rows = (adv[0].children || []).filter(b => b._classes
        && b._classes.has('bench-check'));
    const labels = rows.map(r => allText(r));
    assert.ok(labels.some(l => l.includes('Hot cache off for this run')),
        'hot label rendered inside Advanced: ' + JSON.stringify(labels));
    assert.ok(labels.some(l => l.includes('SSD cache off for this run')),
        'ssd label rendered inside Advanced');
    // the hints are title attributes on the row, and re-resolvable
    const row = rows.find(b => allText(b).includes('Hot cache off'));
    assert.ok(row.title.startsWith('Sets the in-memory Hot Cache limit to 0'),
        row.title);
    assert.equal(row.dataset.i18nTitle, 'uplift.bench.tp.no_hot_cache_hint');
    assert.equal(row.dataset.enTitle,
        'Sets the in-memory Hot Cache limit to 0 while this benchmark runs, '
        + 'then restores your setting. Loaded models are reloaded at run '
        + 'start and finish.');
    assert.ok(row.children.some(c => c.dataset
        && c.dataset.i18n === 'uplift.bench.tp.no_hot_cache'),
        'the label text node carries its key (applyI18n cannot wipe the input)');
    const ssdRow = rows.find(b => allText(b).includes('SSD cache off'));
    assert.ok(ssdRow.title.startsWith('Enables Hot Cache Only'), ssdRow.title);
    assert.equal(ssdRow.dataset.i18nTitle, 'uplift.bench.tp.no_ssd_cache_hint');
});

test('CACHE-OFF: the start body carries the flags only when checked', () => {
    const { win, byId } = mountLoad();
    win.UpliftNativeBench.mount();
    const TP = win.UpliftNativeBench.tp;
    byId['bench-tp-model'].value = 'M1';
    assert.deepEqual(
        Object.keys(TP.collect()).filter(k => k.indexOf('no_') === 0), [],
        'neither key exists while both boxes are off (absent = leave my setting)');
    byId['bench-tp-no-hot'].checked = true;
    let body = TP.collect();
    assert.equal(body.no_hot_cache, true);
    assert.equal('no_ssd_cache' in body, false, 'only the checked one rides');
    byId['bench-tp-no-ssd'].checked = true;
    body = TP.collect();
    assert.equal(body.no_hot_cache, true);
    assert.equal(body.no_ssd_cache, true);
});

test('CACHE-OFF: an external endpoint kills both knobs and says why', () => {
    const { win, byId } = mountLoad();
    win.UpliftNativeBench.mount();
    const panel = byId['bench-subpanel'];
    const hot = byId['bench-tp-no-hot'], ssd = byId['bench-tp-no-ssd'];
    // the ROW a checkbox lives in, found by identity (the stub has no
    // parentNode bookkeeping, and byId alone cannot prove the append)
    const rows = [];
    (function walk(n) {
        if (n && n._classes && n._classes.has('bench-check')) rows.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(panel);
    const rowOf = (input) => rows.find(r => (r.children || []).indexOf(input) >= 0);
    const hotRow = rowOf(hot), ssdRow = rowOf(ssd);
    assert.ok(hotRow && ssdRow, 'both inputs are inside their labels');
    assert.equal(hot.disabled, false, 'local: usable');
    hot.checked = true;
    const ext = byId['bench-tp-ext'];
    ext.checked = true;
    ext.fire('change', { target: ext });      // the panel's own wiring
    assert.equal(hot.disabled, true, 'an external endpoint has no local cache');
    assert.equal(ssd.disabled, true);
    assert.equal(hot.checked, false, 'a dead knob is cleared, never sent');
    assert.equal(hotRow.dataset.i18nTitle, 'uplift.bench.tp.cache_off_local');
    assert.equal(hotRow.dataset.enTitle, 'Applies to local models only.');
    assert.equal(hotRow.title, 'Applies to local models only.',
        'the title says WHY the box is dead');
    assert.equal(ssdRow.title, 'Applies to local models only.');
    ext.checked = false;
    ext.fire('change', { target: ext });
    assert.equal(hot.disabled, false, 'local again: usable');
    assert.equal(hotRow.dataset.i18nTitle, 'uplift.bench.tp.no_hot_cache_hint',
        'the hint comes back when the mode does');
    assert.ok(hotRow.title.startsWith('Sets the in-memory Hot Cache limit'));
});

test('TP-TABLES: the live panel paints classic two tables', () => {
    const { win, byId, B } = mountLoad();
    win.UpliftNativeBench.mount();
    const TP = B.tp;
    TP.state.results = ROWS;
    TP.state.ctx = { model: 'M1', profile: 'code_python', forceLm: false,
                     external: null };
    TP.renderTable();
    const tbl = tables(byId['bench-tp-results']);
    assert.equal(tbl.length, 2, 'single + batch, like classic');
    assert.deepEqual(heads(tbl[0]),
        ['Test', 'TTFT (ms)', 'TPOT (ms/tok)', 'PP TPS', 'TG TPS',
         'E2E Latency', 'Throughput', 'Peak MLX', 'out']);
    assert.deepEqual(heads(tbl[1]),
        ['Batch Size', 'TG TPS', 'Speedup', 'PP TPS', 'PP TPS/req',
         'Avg TTFT (ms)', 'E2E Latency', 'out']);
    assert.deepEqual(cells(tbl[0], 1),
        ['pp1024/tg128', '100.0', '10.00', '8000.0 tok/s', '100.0 tok/s',
         '1.500s', '700.0 tok/s', '2.00 GB', '128']);
    // the batch row no longer misreads the single-only keys
    assert.deepEqual(cells(tbl[1], 2),
        ['2x', '170.0 tok/s', '1.70x', '12000.0 tok/s', '6000.0 tok/s',
         '200.0', '2.000s', '128']);
    assert.equal(cells(tbl[1], 1)[0], '1x (baseline)', 'classic baseline first');
    assert.equal(tbl[0].children[0].children[7].title,
        CLS['bench.metrics.peak_mem.tooltip'], 'th tooltip rides through');
    const sections = allText(byId['bench-tp-results']);
    assert.ok(sections.includes('Single Request Results'), sections);
    assert.ok(sections.includes('Continuous Batching'), sections);
    // Copy text is still classic's whole-set format
    assert.ok(TP.state.results.length === 2);
});

test('TP-TABLES: history renders the same tables plus the cache-off note', async () => {
    const hist = [
        { id: 'h1', ts: 1760000000, model_id: 'M1', rows: ROWS,
          meta: { cache_off: ['hot', 'ssd'] } },
        { id: 'h2', ts: 1760000001, model_id: 'M1', rows: ROWS, meta: {} },
    ];
    const { win, byId } = mountLoad(hist);
    win.UpliftNativeBench.mount();
    await new Promise(r => setTimeout(r, 5));
    const host = byId['bench-tp-history'];
    const items = [];
    (function walk(n) {
        if (n && n._classes && n._classes.has('bench-result')) items.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(host);
    assert.equal(items.length, 2, 'both history runs rendered');
    // loadHistory lists NEWEST FIRST: items[0] = h2 (no cache_off),
    // items[1] = h1 (cache_off: ['hot','ssd'])
    const findCls = (n, cls, out) => {
        out = out || [];
        if (n && n._classes && n._classes.has(cls)) out.push(n);
        for (const k of (n && n.children) || []) findCls(k, cls, out);
        return out;
    };
    assert.equal(findCls(items[1], 'bench-tp-note').length, 1,
        'the cache_off run says so');
    const note = findCls(items[1], 'bench-tp-note')[0];
    assert.equal(note.textContent, 'Cache disabled during this run');
    assert.equal(note.dataset.i18n, 'uplift.bench.tp.cache_off');
    assert.equal(note.dataset.en, 'Cache disabled during this run');
    assert.equal(findCls(items[0], 'bench-tp-note').length, 0,
        'a normal run says nothing');
    assert.equal(tables(items[1]).length, 2, 'history = the same classic tables');
    assert.deepEqual(heads(tables(items[1])[0]),
        ['Test', 'TTFT (ms)', 'TPOT (ms/tok)', 'PP TPS', 'TG TPS',
         'E2E Latency', 'Throughput', 'Peak MLX', 'out'],
        'live and history cannot drift: one painter');
});

test('TP-TABLES: the results head still offers Copy + Download for both tables', () => {
    const { win, byId, B } = mountLoad();
    win.UpliftNativeBench.mount();
    const TP = B.tp;
    TP.state.results = ROWS;
    TP.state.ctx = { model: 'M1', profile: 'code_python', forceLm: false,
                     external: null };
    TP.renderTable();
    const headsEl = [];
    (function walk(n) {
        if (n && n._classes && n._classes.has('bench-results-head')) headsEl.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(byId['bench-tp-results']);
    assert.equal(headsEl.length, 1, 'one Copy/Download head per result set');
    const btns = [];
    (function walk(n) {
        if (n && n.tagName === 'button') btns.push(n.textContent);
        for (const k of (n && n.children) || []) walk(k);
    })(headsEl[0]);
    assert.ok(btns.includes('Copy'), JSON.stringify(btns));
    assert.ok(btns.includes('Download'), JSON.stringify(btns));
    // the CSV column list covers BOTH tables (classic header names)
    const cols = B._benchText.tpDlCols(ROWS);
    assert.equal(cols.length, 16, '8 single + 7 batch + shared out');
    assert.ok(cols.some(c => c.head === 'Peak MLX'), 'memory column exported');
    assert.ok(cols.some(c => c.head === 'PP TPS/req'), 'batch column exported');
});

/* UP-57: the three late listeners (external-row reveal, batch-hint
   relabel, model-change cache sync) moved from gid()+requestAnimationFrame
   to direct element references. This harness stubs rAF as a NO-OP —
   exactly the dead-wiring condition that broke external mode on the live
   board when the rAF beat the async view mount. Every assertion below can
   only pass through reference-bound listeners. */
test('UP-57: tp external row reveals without any rAF, knobs follow', () => {
    const { win, byId } = mountLoad();
    win.UpliftNativeBench.mount();
    const ext = byId['bench-tp-ext'], row = byId['bench-tp-ext-row'];
    const hot = byId['bench-tp-no-hot'], ssd = byId['bench-tp-no-ssd'];
    assert.equal(row.hidden, true, 'external inputs start hidden');
    ext.checked = true;
    ext.fire('change', { target: ext });
    assert.equal(row.hidden, false, 'reveal rides the element reference');
    assert.equal(hot.disabled, true, 'the same event synced the knobs');
    assert.equal(ssd.disabled, true);
    ext.checked = false;
    ext.fire('change', { target: ext });
    assert.equal(row.hidden, true, 'toggling back re-hides');
    assert.equal(hot.disabled, false);
});
test('UP-57: batch hint relabels from the genBox reference listener', () => {
    const { win, byId } = mountLoad();
    win.UpliftNativeBench.mount();
    const gen = byId['bench-tp-gen'];
    const radios = [];
    (function walk(n) {
        if (!n) return;
        if (n.tagName === 'input') radios.push(n);
        for (const k of n.children || []) walk(k);
    })(gen);
    assert.ok(radios.length >= 2, 'gen radios exist');
    const r = radios.find(x => String(x.value) === '256') || radios[1];
    r.checked = true;
    gen.fire('change', { target: r });
    // find the batch-hint p by identity: the ONLY panel text carrying tg<N>
    let hit = null;
    (function walk(n) {
        if (!n || hit) return;
        const s = String(n.textContent || '');
        if (/Batch tests use pp1024\/? \/ tg\d+/.test(s) || /tg\d+/.test(s) && /Batch tests/.test(s)) hit = s;
        for (const k of n.children || []) walk(k);
    })(byId['bench-subpanel']);
    assert.ok(hit && hit.includes('tg' + Number(r.value)),
        'hint followed the selected length, got: ' + hit);
});
test('UP-57: model change reaches syncCacheOff on the select reference', () => {
    const { win, byId } = mountLoad();
    win.UpliftNativeBench.mount();
    const ext = byId['bench-tp-ext'];
    ext.checked = true;                       // flip state WITHOUT an event
    const hot = byId['bench-tp-no-hot'];
    assert.equal(hot.disabled, false, 'nothing synced yet');
    const sel = byId['bench-tp-model'];
    sel.fire('change', { target: sel });      // model change → cache sync
    assert.equal(hot.disabled, true,
        'the dead gid+rAF path could never deliver this');
});
