/* DEC-GROUPS: the decision-bench model picker is driven by the SERVER's
   path groups (GET /bench/decision/models -> {generic_available,
   generic_reason, native[], generic[]}), not by client engine_type guessing.
   Same DOM-free harness as tests/repl1-bench-mount.test.cjs (vm sandbox +
   element stub, module loaded from the real static file, no server, no
   browser); DEC is reached through the file-end seam `_panels.dec` and
   driven directly: DEC.form() paints the <select>, DEC.loadModels() fills it.

   Pinned here:
   - two <optgroup>s, 'Decision models' first, 'Other models' second, labels
     through the catalog keys
   - group MEMBERSHIP comes from native/generic (no client engine_type guess:
     a generic id is offered even when /models calls it an llm, and one the
     manager does not have is dropped from the native group)
   - order inside a group is the SERVER's id order, never a client sort
   - generic_available:false -> every Other option disabled + a leading
     disabled note option (capability honesty: never offer a run that 404s)
   - generic_available:true with no chat models -> no empty group painted
     (the rule is symmetric: a group with no options labels nothing)
   - endpoint failure -> the pre-feature single-group picker (the panel never
     bricks on an older server)
   - the ' (decisions)' marker on generic result rows (table + export cols),
     legacy rows without `path` untouched                                          */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

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
            textContent: '', title: '', hidden: false, label: '',
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '', _attrs: {},
            setAttribute(k, v) { this._attrs[k] = String(v); },
            getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            addEventListener() {}, removeEventListener() {},
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {},
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
    return { byId, document };
}

const CAT = {
    'bench.config.model': 'LBLMODEL',
    'bench.config.model_placeholder': 'PHMODEL',
    'uplift.bench.decision': 'SUBDEC',
    'uplift.bench.decision_desc': 'DECDESC',
    'uplift.bench.dec_accuracy': 'DECACC',
    'uplift.bench.dec_brier': 'DECBRIER',
    'uplift.bench.dec_ece': 'DECECE',
    'uplift.bench.dec_agreement': 'DECAGREE',
    'uplift.bench.dec_latency': 'DECLS',
    'uplift.bench.dec_time': 'DECTIME',
    'uplift.bench.samples': 'DECSAMPLES',
    'uplift.bench.help_aria': 'HELPARIA',
    'uplift.bench.pack.arc_choice': 'PACKARC',
    'uplift.bench.help.accuracy': 'HELPACC',
    'uplift.bench.help.brier': 'HELPBRIER',
    'uplift.bench.help.ece': 'HELPECE',
    'uplift.bench.help.agreement': 'HELPAGREE',
    'uplift.bench.help.ms_question': 'HELPMS',
    'uplift.bench.help.time': 'HELPTIME',
    'uplift.bench.help.samples': 'HELPSAMPLES',
    'uplift.bench.dec_group_native': 'DECGRPNAT',
    'uplift.bench.dec_group_generic': 'DECRPOTHER',
    'uplift.bench.dec_generic_needs_newer': 'DECNEEDSNEWER',
    'acc_bench.config.benchmarks': 'GRIDCAP',
    'uplift.bench.sample_limit': 'LIMIT',
    'bench.config.run_button': 'BTNRUN',
    'bench.progress.cancel': 'BTNCANCEL',
    'acc_bench.results.clear': 'CLEAR',
    'acc_bench.results.text_export.full': 'FULL',
    'results.copy': 'COPYBTN',
};

const MODELS = { models: [
    { id: 'zzz-decision', engine_type: 'decision' },
    { id: 'aaa-decision', engine_type: 'decision' },
    { id: 'chat-gamma', engine_type: 'llm' },
    { id: 'chat-alpha', engine_type: 'llm' },
    { id: 'embed-x', engine_type: 'embedding' },
] };

/* load(opts): opts.groups     -> payload for /bench/decision/models;
                                 null throws (simulates a pre-feature 404)
              opts.modelsFail  -> GET /models throws as well            */
function load(opts) {
    opts = opts || {};
    const groups = ('groups' in opts)
        ? opts.groups
        : { generic_available: true, generic_reason: '',
            native: ['zzz-decision', 'aaa-decision'],
            generic: ['chat-gamma', 'chat-alpha'] };
    const { byId, document } = makeHarness();
    const net = { get: [] };
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                net.get.push(u);
                // ordering IS the contract: this URL also ends with /models
                if (u.includes('/bench/decision/models')) {
                    if (groups === null) throw new Error('404 Not Found: ' + u);
                    return groups;
                }
                if (u.endsWith('/models')) {
                    if (opts.modelsFail) throw new Error('500 boom');
                    return JSON.parse(JSON.stringify(MODELS));
                }
                throw new Error('no net in tests: ' + u);
            },
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
    new vm.Script(fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8'))
        .runInContext(ctx);
    const DEC = win.UpliftNativeBench._panels.dec;
    DEC.state = { running: false, runId: null, packs: {}, selected: {},
                  limit: 0, results: [] };
    DEC.form();                       // paints <select id="bench-dec-model">
    return { win, byId, net, DEC, sel: byId['bench-dec-model'] };
}

const settle = (ms) => new Promise(r => setTimeout(r, ms || 5));

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
const named = (picker, label) => picker.groups.find(g => g.label === label);

// ---- (1) the happy path: two server-owned groups --------------------------

test('DEC-GROUPS: two optgroups, membership from the server, order preserved', async () => {
    const { DEC, sel } = load();
    await DEC.loadModels();
    const p = decPicker(sel);
    assert.equal(p.groups.length, 2, 'exactly two optgroups');
    assert.deepEqual(p.groups.map(g => g.label), ['DECGRPNAT', 'DECRPOTHER'],
        'Decision models first, Other models second, labels via the catalog');
    assert.equal(p.loose.length, 1, 'only the placeholder sits outside the groups');
    assert.equal(p.loose[0].text, 'PHMODEL', 'placeholder key kept');
    assert.equal(p.loose[0].value, '', 'placeholder value stays empty');
    // SERVER order, not sorted and not /models order (/models lists the same
    // ids in a different sequence — a client sort would flip them)
    assert.deepEqual(named(p, 'DECGRPNAT').options.map(o => o.text),
        ['zzz-decision', 'aaa-decision'], 'native group in server id order');
    assert.deepEqual(named(p, 'DECRPOTHER').options.map(o => o.text),
        ['chat-gamma', 'chat-alpha'], 'generic group in server id order');
    assert.ok(!named(p, 'DECGRPNAT').options.some(o => o.disabled),
        'decision models selectable');
    assert.ok(!named(p, 'DECRPOTHER').options.some(o => o.disabled),
        'other models selectable when generic_available is true');
    // values ride the id, so start() posts exactly what the server offered
    assert.deepEqual(named(p, 'DECRPOTHER').options.map(o => o.value),
        ['chat-gamma', 'chat-alpha']);
});

test('DEC-GROUPS: membership is the server list, not client engine_type guessing', async () => {
    // chat-gamma is engine_type 'llm' in /models and still offered (the old
    // filter would have dropped it); 'ghost' is native per the server but the
    // model manager has no such row, so it must NOT be offered.
    const { DEC, sel } = load({ groups: {
        generic_available: true, generic_reason: '',
        native: ['aaa-decision', 'ghost-decision'],
        generic: ['chat-gamma'] } });
    await DEC.loadModels();
    const p = decPicker(sel);
    assert.deepEqual(named(p, 'DECGRPNAT').options.map(o => o.text), ['aaa-decision'],
        'native group = server list INTERSECTED with /models rows');
    assert.deepEqual(named(p, 'DECRPOTHER').options.map(o => o.text), ['chat-gamma'],
        'the llm is offered because the SERVER put it in generic');
    assert.ok(!p.groups.some(g => g.options.some(o => o.text === 'embed-x')),
        'a model in neither list is never offered');
});

test('DEC-GROUPS: reload is idempotent (no duplicated groups)', async () => {
    const { DEC, sel } = load();
    await DEC.loadModels();
    await DEC.loadModels();
    const p = decPicker(sel);
    assert.equal(p.groups.length, 2, 'still two groups');
    assert.equal(p.loose.length, 1, 'still one placeholder');
});

// ---- (2) capability honesty ------------------------------------------------

test('DEC-GROUPS: generic_available false disables the group, note first', async () => {
    const { DEC, sel } = load({ groups: {
        generic_available: false,
        generic_reason: 'this omlx build does not expose /v1/decisions',
        native: ['zzz-decision'], generic: ['chat-gamma', 'chat-alpha'] } });
    await DEC.loadModels();
    const p = decPicker(sel);
    const other = named(p, 'DECRPOTHER');
    assert.ok(other, 'the group stays visible — it explains itself');
    assert.deepEqual(other.options[0],
        { text: 'DECNEEDSNEWER', disabled: true, value: 'DECNEEDSNEWER' },
        'note is the FIRST entry, disabled, via its catalog key');
    assert.ok(other.options.every(o => o.disabled),
        'no Other model can be picked when the server cannot score it');
    assert.ok(!named(p, 'DECGRPNAT').options.some(o => o.disabled),
        'decision models unaffected');
});

test('DEC-GROUPS: available but no chat models -> no empty group painted', async () => {
    const { DEC, sel } = load({ groups: {
        generic_available: true, generic_reason: '',
        native: ['zzz-decision'], generic: [] } });
    await DEC.loadModels();
    const p = decPicker(sel);
    assert.deepEqual(p.groups.map(g => g.label), ['DECGRPNAT'],
        'nothing to show and nothing to explain -> the group is dropped');
});

test('DEC-GROUPS: no decision heads installed -> only the Other group shows', async () => {
    const { DEC, sel } = load({ groups: {
        generic_available: true, generic_reason: '',
        native: ['ghost-decision'], generic: ['chat-gamma'] } });
    await DEC.loadModels();
    const p = decPicker(sel);
    assert.deepEqual(p.groups.map(g => g.label), ['DECRPOTHER'],
        'an empty group labels nothing — the rule is symmetric, not generic-only');
    assert.deepEqual(p.groups[0].options.map(o => o.text), ['chat-gamma']);
});

// ---- (3) degrade: older server, dead endpoint -----------------------------

test('DEC-GROUPS: endpoint 404 falls back to the legacy single-group picker', async () => {
    const { DEC, sel, net } = load({ groups: null });
    await DEC.loadModels();
    const p = decPicker(sel);
    assert.equal(p.groups.length, 0, 'no optgroups on a pre-feature server');
    assert.deepEqual(p.loose.map(o => o.text),
        ['PHMODEL', 'zzz-decision', 'aaa-decision'],
        'the old engine_type decision filter still paints the panel');
    assert.ok(!p.loose.some(o => o.text === 'chat-gamma'),
        'legacy behaviour preserved: chat models were not offered');
    assert.ok(net.get.some(u => u.endsWith('/bench/decision/models')),
        'the new route was attempted before falling back');
    assert.ok(net.get.some(u => /\/uplift\/api\/models$/.test(u)),
        'the old /models fetch is kept');
});

test('DEC-GROUPS: /models dead too -> placeholder only, no throw, panel intact', async () => {
    const { DEC, sel } = load({ groups: null, modelsFail: true });
    await DEC.loadModels();          // both endpoints fail
    const p = decPicker(sel);
    assert.equal(p.groups.length, 0, 'no groups invented out of thin air');
    assert.deepEqual(p.loose.map(o => o.text), ['PHMODEL'],
        'the placeholder survives — the panel is usable, just empty');
});

// ---- (4) the ' (decisions)' marker on result rows -------------------------

function firstCol(byId) {
    const out = [];
    (function walk(n) {
        if (n && n.tagName === 'tr') {
            const td = (n.children || []).find(c => c.tagName === 'td');
            if (td) out.push(td.textContent);
        }
        for (const k of (n && n.children) || []) walk(k);
    })(byId['bench-dec-results']);
    return out;
}

test('DEC-API: generic rows get the (decisions) marker, legacy rows do not', () => {
    const { DEC, byId } = load();
    DEC.state.results = [
        { model_id: 'legacy-dec', pack: 'arc-choice', engine: 'systemone',
          accuracy: 0.8, brier: 0.05, ece: 0.04, agreement: 0.9,
          ms_per_question: 400, items: 10, ts: 1760000000 },
        { model_id: 'chat-a', pack: 'arc-choice', engine: 'decisions', path: 'generic',
          accuracy: 0.7, brier: 0.06, ece: 0.05, agreement: 0.9,
          ms_per_question: 900, items: 10, ts: 1760000001 },
        { model_id: 'native-b', pack: 'arc-choice', engine: 'systemone', path: 'native',
          accuracy: 0.9, brier: 0.03, ece: 0.02, agreement: 0.9,
          ms_per_question: 300, items: 10, ts: 1760000002 },
        { model_id: 'chat-b', pack: 'arc-choice', engine: 'decisions',
          accuracy: 0.6, brier: 0.07, ece: 0.06, agreement: 0.9,
          ms_per_question: 950, items: 10, ts: 1760000003 },
    ];
    DEC.renderResults();
    // rows render newest-first (the panel reverses the store)
    assert.deepEqual(firstCol(byId),
        ['chat-b (decisions)', 'native-b', 'chat-a (decisions)', 'legacy-dec'],
        'path:generic AND engine:decisions mark the row; missing path '
        + '(pre-feature row) and path:native render the bare id');
});

test('DEC-API: the marker reaches the Copy / Markdown / CSV Model column', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');
    const decBlock = src.slice(src.indexOf('DEC = {'),
        src.indexOf('function stopStream'));
    assert.ok(decBlock.length > 1000, 'DEC block located in the source');
    const uses = decBlock.match(/return decModelCell\(r\)/g) || [];
    assert.equal(uses.length, 2,
        'both export specs (buildTableText label:Model + download head:Model) '
        + 'route through decModelCell, plus the table cell = 3 sites');
    assert.equal((decBlock.match(/decModelCell\(r\)/g) || []).length, 3,
        'table cell + the two export column defs');
});


// ---- FORCED-1: the Answer-policy control -----------------------------------
// The mode select is driven ONLY by the server's groups payload: membership
// in `generic` enables it, forced_available enables the 'forced' option, the
// server's reason rides in the title, and a stale 'forced' selection snaps
// back the moment it would produce a run the server refuses.

const MODE_CAT = { 'uplift.bench.dec.mode_label': 'MODELBL',
                   'uplift.bench.dec.mode_gated': 'MODEGATED',
                   'uplift.bench.dec.mode_forced': 'MODEFORCED',
                   'uplift.bench.dec.mode_hint': 'MODEHINT' };
Object.assign(CAT, MODE_CAT);

function modeSel(byId) { return byId['bench-dec-mode']; }
function optsOf(s) {
    return (s.children || []).map(o => ({ text: o.textContent,
                                          value: o.value, disabled: !!o.disabled }));
}

test('FORCED-1: chat membership enables the control; forced option needs the flag',
async () => {
    // default groups payload has NO forced_available (pre-FORCED-1 server)
    const { DEC, sel, byId } = load();
    await DEC.loadModels();
    const m = modeSel(byId);
    assert.ok(m, 'the Answer-policy select exists');
    assert.deepEqual(optsOf(m).map(o => o.value), ['gated', 'forced']);
    assert.deepEqual(optsOf(m).map(o => o.text), ['MODEGATED', 'MODEFORCED'],
        'labels via the catalog');

    sel.value = ''; DEC._syncMode();
    assert.equal(m.disabled, true, 'no model -> control disabled');

    sel.value = 'zzz-decision'; DEC._syncMode();
    assert.equal(m.disabled, true, 'native model -> forced is meaningless');

    sel.value = 'chat-gamma'; DEC._syncMode();
    assert.equal(m.disabled, false, 'chat model -> control live');
    assert.deepEqual(optsOf(m).find(o => o.value === 'forced').disabled, true,
        'no forced_available -> option stays DISABLED with the reason, ' +
        'never hidden and never silently accepted');
    assert.equal(m.title, 'MODEHINT',
        'absent server reason -> honest generic hint, not an empty title');
});

test('FORCED-1: forced_available opens the option; a server reason titles it',
async () => {
    const { DEC, sel, byId } = load({ groups: {
        generic_available: true, generic_reason: '',
        forced_available: true, forced_reason: '',
        native: ['zzz-decision', 'aaa-decision'],
        generic: ['chat-gamma', 'chat-alpha'] } });
    await DEC.loadModels();
    sel.value = 'chat-alpha'; DEC._syncMode();
    assert.equal(optsOf(modeSel(byId)).find(o => o.value === 'forced').disabled,
        false, 'chat + capable base -> forced selectable');
    // switch to a native model while forced is SELECTED: snap back to gated
    modeSel(byId).value = 'forced';
    sel.value = 'aaa-decision'; DEC._syncMode();
    assert.equal(modeSel(byId).value, 'gated',
        'a stale forced choice can never ride onto a native model');
});

test('FORCED-1: the start body carries the mode explicitly (queue-safe)',
async () => {
    const { win, DEC, sel, byId, net } = load({ groups: {
        generic_available: true, generic_reason: '',
        forced_available: true, forced_reason: '',
        native: [], generic: ['chat-gamma'] } });
    net.posts = [];
    win.UpliftDom.postJson = async (u, body) => {
        net.posts.push([u, body]); throw new Error('recorded, stop here'); };
    await DEC.loadModels();
    sel.value = 'chat-gamma'; DEC._syncMode();
    modeSel(byId).value = 'forced';
    DEC.state.selected = { 'arc-choice': true };
    await DEC.start();
    assert.equal(net.posts.length, 1);
    assert.equal(net.posts[0][0], '/uplift/api/bench/decision/start');
    assert.equal(net.posts[0][1].mode, 'forced',
        'the chosen policy travels in the body (queue replays it verbatim)');
    // and gated stays explicit when the control is disabled again
    modeSel(byId).value = 'gated';
    await DEC.start();
    assert.equal(net.posts[1][1].mode, 'gated');
});

test('FORCED-1: forced rows carry the (forced) marker, legacy rows untouched',
() => {
    const { DEC, byId } = load();
    DEC.state.results = [
        { model_id: 'chat-a', pack: 'arc-choice',
          engine: 'decisions', path: 'generic', accuracy: 0.7, brier: 0.06,
          ece: 0.05, agreement: 0.9, ms_per_question: 900, items: 10,
          ts: 1760000001 },
        { model_id: 'chat-forced', pack: 'arc-choice',
          engine: 'systemone', path: 'forced', accuracy: 0.55, brier: 0.25,
          ece: 0.02, agreement: 0.8, ms_per_question: 900, items: 10,
          ts: 1760000004 },
    ];
    DEC.renderResults();
    assert.deepEqual(firstCol(byId),
        ['chat-forced (forced)', 'chat-a (decisions)'],
        'forced is its own marker — never blank, never (decisions)');
});
