/* U49 structural proof (card's Verify: 'advancedSection + copy helper used
   by each panel module — DOM assertion in the mount-test harness').
   Loads the module through the same UMD path the classic board uses and
   walks each panel's rendered subtree for the shared helpers' fingerprints:
     - results Copy button  -> class 'bench-results-head' + key
                               bench.results.text_export.copy
     - Advanced card        -> <details class=bench-advanced> (TP/ACC/ANE)
     - task-grid caption    -> key acc_bench.config.benchmarks
   Panel renderers are called directly (state injected) — no server, no
   net: the harness stubs fetchJson with the mount-test catalog. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

// DOM stub with class tracking (the mount harness drops className from
// the tree walk, and U49 fingerprints ARE classes)
function harness() {
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
        createTextNode(s) { return { textContent: String(s), children: [], className: '' }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    return { byId, document, makeEl };
}

const CAT = {
    'bench.results.text_export.copy': 'COPYBTN',
    'bench.config.advanced_options': 'ADVCARD',
    'modal.model_settings.qwen_ane_tune_overrides': 'SEARCHSPACE',
    'acc_bench.config.benchmarks': 'GRIDCAPTION',
};

function load() {
    const { byId, document } = harness();
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: {
            fetchJson: async () => { throw new Error('no net in tests'); },
            postJson: async () => { throw new Error('no net in tests'); },
            toast: () => {},
        },
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

function findAll(el, cls, out) {
    out = out || [];
    if (el && el.className && String(el.className).includes(cls)) out.push(el);
    for (const k of (el && el.children) || []) findAll(k, cls, out);
    return out;
}
function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children || []) s += ' ' + allText(k);
    return s;
}

// ---- Copy button present per panel (resultsHead fingerprints) ----

test('U49: CTX result card carries the shared Copy head', () => {
    const { win, byId } = load();
    const CTX = win.UpliftNativeBench._panels.ctx;
    CTX.state = { running: false, benchId: null, result: null, models: [] };
    CTX.renderResult({ model_id: 'M1', target_tokens: 32768, measured_tokens: 30000,
        verified_tokens: 30000, applied_tokens: 30000, capped_by: 'native',
        prefill_tps: 1200, duration_s: 4.2, applied: false });
    const wrap = byId['bench-ctx-results'];
    assert.equal(findAll(wrap, 'bench-results-head').length, 1, 'one Copy head');
    assert.ok(allText(wrap).includes('COPYBTN'), 'button label via export-copy key');
});

test('U49: ACC results carry the Copy head + grid caption', () => {
    const { win, byId } = load();
    const ACC = win.UpliftNativeBench._panels.acc;
    ACC.state = { results: [{ model_id: 'M', benchmark: 'mmlu', accuracy: 0.5,
        correct: 5, total: 10, time_s: 3, thinking_used: false, engine: 'classic' }],
        groups: [{ tasks: [{ key: 'mmlu', full_size: 14042 }] }] };
    ACC.renderResults();
    const wrap = byId['bench-acc-results'];
    assert.equal(findAll(wrap, 'bench-results-head').length, 1);
    assert.ok(allText(wrap).includes('COPYBTN'));
    const form = ACC.form();
    assert.ok(allText(form).includes('GRIDCAPTION'), 'task grid caption labeled');
});

test('U49: ANE results carry the Copy head', () => {
    const { win, byId } = load();
    const ANE = win.UpliftNativeBench._panels.ane;
    ANE.state = { running: false, tuningId: 'x', snapshot: null };
    ANE.renderResults({ status: 'completed', results: [
        { split: 'gate', state: 'ANE', processing_tps: 12345.6, latency_ms: 7.8 }],
        recommendation: { processing_tps: 13000 } });
    const wrap = byId['bench-ane-results'];
    assert.equal(findAll(wrap, 'bench-results-head').length, 1);
    assert.ok(allText(wrap).includes('COPYBTN'));
});

test('U49: DEC results carry the Copy head + grid caption', () => {
    const { win, byId } = load();
    const DEC = win.UpliftNativeBench._panels.dec;
    DEC.state = { running: false, runId: null, packs: {}, selected: {}, limit: 0,
        results: [{ model_id: 'c', pack: 'arc-choice', accuracy: 0.8571, brier: 0.05,
                    ece: 0.04, agreement: 0.96, ms_per_question: 480, items: 294,
                    ts: 1760000000 }] };
    DEC.renderResults();
    const wrap = byId['bench-dec-results'];
    assert.equal(findAll(wrap, 'bench-results-head').length, 1);
    assert.ok(allText(wrap).includes('COPYBTN'));
    assert.ok(allText(DEC.form()).includes('GRIDCAPTION'), 'pack grid caption labeled');
});

// ---- Advanced card present where the knobs live; absent where empty ----

test('U49: ANE search space uses the shared Advanced card', () => {
    const { win } = load();
    const ANE = win.UpliftNativeBench._panels.ane;
    ANE.state = { running: false, tuningId: null, snapshot: null };
    const form = ANE.form();
    const advs = findAll(form, 'bench-advanced');
    assert.equal(advs.length, 1, 'exactly one Advanced card');
    assert.equal(advs[0].tagName, 'details');
    assert.ok(allText(advs[0]).includes('SEARCHSPACE'), 'keeps classic label');
});

test('U49: CTX form deliberately has NO empty Advanced card', () => {
    const { win } = load();
    const CTX = win.UpliftNativeBench._panels.ctx;
    CTX.state = { running: false, benchId: null, result: null, models: [] };
    const form = CTX.form();
    assert.equal(findAll(form, 'bench-advanced').length, 0);
});

// ---- shared table-text builder shape (header + padded columns) ----

test('U49: buildTableText pads numeric columns and keeps header order', () => {
    const { win } = load();
    const { buildTableText } = win.UpliftNativeBench._u49;
    const text = buildTableText(
        ['Decision', ''],
        [{ label: 'Model', get: r => String(r.m) },
         { label: 'Score', numeric: true, get: r => String(r.s) }],
        [{ m: 'a-model', s: '0.5' }, { m: 'bb', s: '1.0000' }]);
    const lines = text.split('\n');
    assert.equal(lines[0], 'Decision');
    assert.equal(lines[2], 'Model     Score');
    assert.equal(lines[3], 'a-model     0.5');
    assert.equal(lines[4], 'bb       1.0000');
});

test('U49: ctx export includes the model row when the engine provides it', () => {
    const { win } = load();
    const { ctxResultPairs } = win.UpliftNativeBench._u49;
    const pairs = ctxResultPairs([], { model_id: 'M1', target_tokens: 4096,
        measured_tokens: 4000, verified_tokens: 4000, applied_tokens: 4000,
        capped_by: 'native', prefill_tps: 100, duration_s: 1 });
    assert.deepEqual(pairs[0], ['Model', 'M1']);
});

test('U49: buildAccuracyText mirrors classic matrix + detail block', () => {
    const { win } = load();
    const { buildAccuracyText } = win.UpliftNativeBench._u49;
    const rows = [
        { model_id: 'Alpha', benchmark: 'mmlu', accuracy: 0.65, correct: 65,
          total: 100, time_s: 42, thinking_used: false },
        { model_id: 'Beta', benchmark: 'mmlu', accuracy: 0.7, correct: 70,
          total: 100, time_s: 40, thinking_used: true },
        { model_id: 'Alpha', benchmark: 'boolq', accuracy: 0.8, correct: 80,
          total: 100, time_s: 10, thinking_used: false },
    ];
    const groups = [{ tasks: [{ key: 'mmlu', full_size: 100 },
                              { key: 'boolq', full_size: 3270 }] }];
    const text = buildAccuracyText(rows, groups);
    const lines = text.split('\n');
    assert.equal(lines[0], 'Intelligence Benchmark Comparison');
    assert.equal(lines[1], '');
    // exact classic padding (benchWidth 14 / modelWidth 12 / mode 8 / sampled 14)
    assert.equal(lines[2], '              Mode    Sampled              Alpha        Beta');
    assert.equal(lines[3], '-'.repeat(60));
    assert.equal(lines[4], 'MMLU          Full    100                  65.0%       70.0%');
    assert.equal(lines[5], 'BOOLQ         Sample  100/3270             80.0%           -');
    assert.equal(lines[6], '');
    assert.equal(lines[7], '--- Detail ---');
    assert.equal(lines[8], '');
    assert.equal(lines[9], 'Model: Alpha');
    assert.equal(lines[10], 'Benchmark         Accuracy   Correct   Total   Time(s)   Think');
    assert.equal(lines[11], '-'.repeat(62));
    assert.equal(lines[12], 'MMLU                 65.0%        65     100        42      No');
    assert.equal(lines[13], 'BOOLQ                80.0%        80     100        10      No');
    assert.ok(!text.includes('Valid responses'), 'no external detail for internal rows');
    const beta = text.split('Model: Beta')[1].split('\n');
    assert.equal(beta[3], 'MMLU                 70.0%        70     100        40     Yes');
});

test('U49: model id with $ patterns cannot corrupt the detail header', () => {
    const { win } = load();
    const { buildAccuracyText } = win.UpliftNativeBench._u49;
    const rows = [{ model_id: "m$'x", benchmark: 'mmlu', accuracy: 0.5,
                    correct: 1, total: 2, time_s: 1, thinking_used: false }];
    const text = buildAccuracyText(rows, []);
    assert.ok(text.includes("Model: m$'x"), "literal model id survives replace");
});
