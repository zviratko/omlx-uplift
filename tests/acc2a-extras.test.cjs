/* ACC-2a — the 'Additional suites' section (harness-only suites kept in
   their OWN block under the classic grid; the user's hard constraint is
   that whoever ignores the expanded catalog sees the classic picker
   unchanged). Behavioural proofs run through the vm sandbox + a DOM stub
   strong enough to express the real interactions (parent/child splice via
   insertBefore + remove, per-element listener registries fired with fire(),
   a working localStorage map, and a querySelectorAll that implements the
   '#id .class' descendant selectors the module uses).

   Pinned here:
   - the section exists ONLY when the server sends a non-empty extra_suites
     (absent key and empty list both mean zero DOM delta)
   - the size chip does the honest U68 math (rows · ×leaves · LM-Eval) and
     omits a part it does not know — never a guessed number
   - 6-card family cap + 'show all (N)' / 'hide'
   - fold + show-all persisted under 'uplift.bench.extras.v1' and restored
   - selecting a suite in a folded family auto-reveals it
   - the search box filters the extras ONLY; the classic grid is untouched
   - a local-only pick never travels with the leaderboard upload flag
   - structural: one IIFE, extras code is its own module block, every new
     uplift.bench.extras_* key lives in all 10 locales (test_locale_sync
     cannot see the t(key, fallback) call style, so this closes that gap) */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const LOCALES = path.join(__dirname, '..', 'omlx_uplift', 'locales');

/* ---- DOM stub ---------------------------------------------------------- */
function makeDom() {
    const byId = {};
    function mk(tag) {
        const set = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            _lis: {}, parentNode: null, hidden: false, open: true, value: '',
            type: '', checked: false, disabled: false, title: '',
            textContent: '', _id: '',
            get className() { return [...set].join(' '); },
            set className(v) {
                set.clear();
                String(v || '').split(/\s+/).filter(Boolean).forEach(c => set.add(c));
            },
            _classes: set,
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) {
                this.children.forEach(c => { c.parentNode = null; });
                this.children = kids; kids.forEach(c => { c.parentNode = this; });
            },
            append(...kids) {
                kids.forEach(c => { c.parentNode = this; this.children.push(c); });
            },
            appendChild(k) { k.parentNode = this; this.children.push(k); return k; },
            insertBefore(k, ref) {
                const i = ref ? this.children.indexOf(ref) : -1;
                k.parentNode = this;
                if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
                return k;
            },
            removeChild(k) {
                const i = this.children.indexOf(k);
                if (i >= 0) { this.children.splice(i, 1); k.parentNode = null; }
                return k;
            },
            remove() {
                if (this.parentNode) this.parentNode.removeChild(this);
                else this.children = [];
            },
            addEventListener(t, fn) { (this._lis[t] = this._lis[t] || []).push(fn); },
            removeEventListener() {},
            querySelector(s) { return this.querySelectorAll(s)[0] || null; },
            querySelectorAll(s) { return queryAll(this, s); },
            focus() {}, blur() {},
            classList: {
                add(...c) { c.forEach(x => set.add(x)); },
                remove(...c) { c.forEach(x => set.delete(x)); },
                contains(c) { return set.has(c); },
                toggle(c) {
                    if (set.has(c)) { set.delete(c); return false; }
                    set.add(c); return true;
                },
            },
        };
        return el;
    }
    // '#id .class', '.a .b', '.a', 'tag' — the shapes this module uses
    function matchCompound(node, part) {
        const m = part.match(/^(?:(#([\w-]+))|(?:([\w-]+))?)(?:\.([\w-]+))?$/);
        if (!m) return false;
        if (m[1] && node.id !== m[2]) return false;
        if (m[3] && node.tagName !== m[3]) return false;
        if (m[4] && !(node._classes && node._classes.has(m[4]))) return false;
        if (!m[1] && !m[3] && !m[4]) return false;
        return true;
    }
    function walk(node, out) {
        for (const c of node.children || []) { out.push(c); walk(c, out); }
        return out;
    }
    function queryAll(root, sel) {
        const all = walk(root, []);
        const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
        const hit = [];
        for (const g of groups) {
            const parts = g.split(/\s+/);
            const last = parts[parts.length - 1];
            for (const n of all) {
                if (!matchCompound(n, last) || hit.includes(n)) continue;
                let ok = true, p = n.parentNode, i = parts.length - 2;
                while (i >= 0 && p) {
                    if (matchCompound(p, parts[i])) i--;
                    p = p.parentNode;
                }
                if (i < 0) hit.push(n);
                else if (parts.length === 1) hit.push(n);
                else ok = false;
                if (parts.length === 1) break;
                if (!ok) hit.pop();
            }
        }
        return hit;
    }
    const doc = mk('#document');
    doc.createElement = t => mk(t);
    doc.createTextNode = s => ({ textContent: String(s), children: [] });
    doc.getElementById = id => byId[id] || (byId[id] = mk('div'));
    doc.documentElement = mk('html');
    doc.documentElement.dataset = { nativeSurfaces: 'all' };
    return { doc, byId, mk, fire, queryAll };

    function fire(el, type, ev) {
        const e = Object.assign({
            target: el, stopPropagation() {}, preventDefault() {},
        }, ev || {});
        (el._lis[type] || []).forEach(fn => fn(e));
    }
}

/* ---- fixtures ---------------------------------------------------------- */
const CLASSIC = {
    tasks: [{
        group: 'acc_bench.benchmarks.group_knowledge',
        tasks: [
            { key: 'mmlu', label: 'MMLU', desc: 'acc_bench.benchmarks.mmlu_desc',
              full_size: 14042, sizes: [30, 50, 100] },
        ],
    }, {
        group: 'acc_bench.benchmarks.group_math',
        tasks: [{ key: 'gsm8k', label: 'GSM8K', desc: 'acc_bench.benchmarks.gsm8k_desc',
                  full_size: 1319, sizes: [30, 50, 100] }],
    }],
    valid: ['mmlu', 'gsm8k'],
    harness_tasks: ['mmlu'],
};
const EXTRA9 = Array.from({ length: 9 }, (_, i) => ({
    key: 'bbh_leaf_' + i, label: 'BBH Leaf ' + i, family: 'reasoning',
    rows: 250, upload_ok: false,
}));
const EXTRAS_FIX = [
    { key: 'ifeval', label: 'IFEval', family: 'instruction', rows: 541,
      upload_ok: false },
    { key: 'bbh_cot_fewshot', label: 'BBH CoT', family: 'reasoning',
      rows: 6500, upload_ok: false },
    { key: 'mmlu_prox_lite_cs', label: 'MMLU-Prox Lite CS', family: 'locale',
      rows: null, upload_ok: false },
    ...EXTRA9,
];
const SIZES = { mmlu: 57, ifeval: 1, bbh_cot_fewshot: 27 };

function load(opts) {
    const o = opts || {};
    const { doc, byId, fire } = makeDom();
    const store = o.store || {};
    const posts = [];
    const win = {
        UpliftCore: { t: k => k },
        UpliftDom: {
            fetchJson: async (u) => {
                if (String(u).endsWith('/models')) return { models: [{ id: 'm1' }] };
                if (String(u).endsWith('/bench/accuracy/tasks')) {
                    if (o.tasks === null) throw new Error('no tasks');
                    return Object.assign({}, CLASSIC, o.tasks || {});
                }
                if (String(u).endsWith('/bench/accuracy/harness-sizes'))
                    return o.sizes === null ? {} : { sizes: SIZES };
                if (String(u).endsWith('/bench/accuracy/queue'))
                    return { queue: [], running: false };
                return {};
            },
            postJson: async (u, b) => { posts.push({ url: String(u), body: b }); return {}; },
            toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document: doc,
        requestAnimationFrame: () => {},
        setTimeout: (fn) => fn && undefined,
        EventSource: undefined,
        location: { hash: '#bench/accuracy', pathname: '/uplift/', search: '' },
        history: { replaceState() {} },
    };
    win.window = win; win.self = win;
    win.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
    };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8'))
        .runInContext(ctx);
    return { win, byId, doc, store, posts, fire, B: win.UpliftNativeBench };
}

const tick = () => new Promise(r => setTimeout(r, 0));
async function accuracy(opts) {
    const h = load(opts);
    h.B.mount();
    h.B.showSub('accuracy');
    await tick(); await tick();
    h.panel = h.byId['bench-subpanel'];
    // the stub document root holds nothing (mount attaches to #bench-native
    // by id), so the form is taken from where it is really attached
    h.form = classes(h.panel, 'bench-form')[0];
    return h;
}
function classes(n, c, out) {
    out = out || [];
    if (n._classes && n._classes.has(c)) out.push(n);
    (n.children || []).forEach(k => classes(k, c, out));
    return out;
}
function extrasSec(h) { return classes(h.panel, 'acc-extras'); }
function famsOf(sec) { return classes(sec, 'acc-extras-fam'); }
function cards(sec) { return classes(sec, 'acc-task'); }
function texts(n) {
    let s = n.textContent || '';
    (n.children || []).forEach(c => { s += ' ' + texts(c); });
    return s;
}
function classicGrid(h) { return h.byId['bench-acc-tasks']; }
function findCard(sec, key) {
    return cards(sec).filter(c => c.dataset && c.dataset.key === key)[0] || null;
}

/* ---- 1. the section exists ONLY when the server offers extras ---------- */
test('ACC-2a: no extra_suites key at all -> the section does not exist',
    async () => {
        const h = await accuracy({});                        // key absent
        assert.deepEqual(extrasSec(h), [], 'no .acc-extras node may be built');
        assert.ok(!h.byId['bench-acc-extras'],
            'the section id was never even allocated: zero DOM delta');
        // classic grid still owns both groups + the one LM-Eval twin
        assert.equal(cards(classicGrid(h)).length, 3,
            'classic grid keeps its own 3 cards (mmlu, mmlu|h, gsm8k)');
    });

test('ACC-2a: extra_suites: [] -> the section does not exist either',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: [] } });
        assert.deepEqual(extrasSec(h), [], 'an empty list is as silent as no key');
    });

test('ACC-2a: non-empty extra_suites -> one separate section, classic grid untouched',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const sec = extrasSec(h);
        assert.equal(sec.length, 1, 'exactly one extras section');
        // separation is the whole point: the classic grid has no extras card
        const inGrid = cards(classicGrid(h)).map(c => c.dataset.key);
        assert.deepEqual(inGrid.sort(), ['gsm8k', 'mmlu', 'mmlu|h'],
            'the classic grid keeps EXACTLY its own cards');
        // ...and the section sits below the grid, above the Advanced block
        const kids = h.form.children;
        const gi = kids.findIndex(k => k.id === 'bench-acc-tasks');
        const ei = kids.findIndex(k => k._classes && k._classes.has('acc-extras'));
        const ai = kids.findIndex(k => k.tagName === 'details');
        assert.ok(gi >= 0 && ei > gi, 'extras render BELOW the classic grid');
        assert.ok(ai < 0 || ei < ai, 'extras render ABOVE the Advanced block');
        // and it never carries an upload/leaderboard affordance
        assert.deepEqual(classes(sec[0], 'bench-check'), [],
            'no checkbox may live inside the extras section');
        assert.ok(!texts(sec[0]).includes('uplift.bench.upload'),
            'no upload control or raw key in the extras DOM');
    });

test('ACC-2a: with extras present, the CLASSIC panel still serializes byte-identical',
    async () => {
        // The strongest reading of the user's constraint: strip the extras
        // node out of the form and the rest of the panel must be the exact
        // DOM the pre-ACC-2a build produced — same tags, classes, ids,
        // datasets, attributes, text and order.
        const ser = (n) => {
            const ds = Object.keys(n.dataset || {}).sort()
                .map(k => 'data-' + k + '=' + n.dataset[k]);
            const at = Object.keys(n.attrs || {}).sort().map(k => k + '=' + n.attrs[k]);
            return '<' + n.tagName + ' id=' + (n.id || '') +
                ' class=' + n.className + ' type=' + n.type + ' value=' + n.value +
                ' hidden=' + (n.hidden ? 1 : 0) + ' ph=' + (n.placeholder || '') +
                ' title=' + (n.title || '') + ' open=' + (n.open ? 1 : 0) + ' ' +
                ds.concat(at).join(',') + '>' + (n.textContent || '') +
                (n.children || []).map(ser).join('') + '</' + n.tagName + '>';
        };
        const panel = async (tasks) => {
            const h = await accuracy({ tasks });
            return h.form.children.filter(n => !(n._classes && n._classes.has('acc-extras')))
                .map(ser).join('\n');
        };
        const without = await panel(undefined);
        const empty = await panel({ extra_suites: [] });
        const withExtras = await panel({ extra_suites: EXTRAS_FIX });
        assert.ok(without.length > 500, 'the classic panel really did render');
        assert.equal(withExtras, without,
            'extras present must not perturb ONE node of the classic panel');
        assert.equal(empty, without, 'an empty list is identical too');
    });

/* ---- 2. chip math (U68 honesty) --------------------------------------- */
test('ACC-2a: size chip is rows · ×leaves · LM-Eval, omitting what is unknown',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const sec = extrasSec(h)[0];
        const chip = k => texts(findCard(sec, k + '|h').children
            .filter(c => c._classes.has('acc-task-chip'))[0]);
        assert.equal(chip('ifeval'), '1 rows · LM-Eval'.replace('1 rows', (541).toLocaleString() + ' rows'),
            'a known leaf count of 1 is still honest: ×1 is noise, so only rows+engine');
        assert.equal(chip('bbh_cot_fewshot'),
            (6500).toLocaleString() + ' rows · ×27 · LM-Eval');
        assert.equal(chip('mmlu_prox_lite_cs'), 'LM-Eval',
            'rows null AND leaves unknown -> no number is invented at all');
    });

test('ACC-2a: chip keeps the honest omission when the probe has no leaf count',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, sizes: null });
        const sec = extrasSec(h)[0];
        const c = findCard(sec, 'bbh_cot_fewshot|h');
        assert.equal(texts(c.children.filter(x => x._classes.has('acc-task-chip'))[0]),
            (6500).toLocaleString() + ' rows · LM-Eval',
            'no harness-sizes map -> no ×leaves part, never a guessed ×1 lie');
    });

/* ---- 3. family cap + show all ----------------------------------------- */
test('ACC-2a: 6-card cap per family + show all (N) then hide', async () => {
    const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
    const sec = extrasSec(h)[0];
    const reasoning = famsOf(sec).filter(f => f.dataset.family === 'reasoning')[0];
    assert.equal(cards(reasoning).length, 6, 'the family shows CAP=6 cards');
    const more = classes(reasoning, 'acc-extras-more')[0];
    assert.ok(more, 'a show-all toggle exists for a capped family');
    assert.equal(texts(more), 'show all (10)',
        'the toggle counts EVERY suite of the family, not the hidden tail');
    h.fire(more, 'click');
    const r2 = famsOf(extrasSec(h)[0]).filter(f => f.dataset.family === 'reasoning')[0];
    assert.equal(cards(r2).length, 10, 'show all reveals the whole family');
    const hide = classes(r2, 'acc-extras-more')[0];
    assert.equal(texts(hide), 'hide');
    h.fire(hide, 'click');
    const r3 = famsOf(extrasSec(h)[0]).filter(f => f.dataset.family === 'reasoning')[0];
    assert.equal(cards(r3).length, 6, 'hide re-caps at 6');
    // the instruction family (1 card) must carry NO toggle
    const instr = famsOf(extrasSec(h)[0]).filter(f => f.dataset.family === 'instruction')[0];
    assert.equal(cards(instr).length, 1);
    assert.deepEqual(classes(instr, 'acc-extras-more'), [],
        'a family under the cap gets no toggle');
});

/* ---- 4. fold persistence ---------------------------------------------- */
test('ACC-2a: fold state persists under uplift.bench.extras.v1 and restores',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const sec = extrasSec(h)[0];
        const instr = famsOf(sec).filter(f => f.dataset.family === 'instruction')[0];
        assert.equal(instr.open, true, 'families start open');
        instr.open = false;
        h.fire(instr, 'toggle');
        const saved = JSON.parse(store['uplift.bench.extras.v1']);
        assert.equal(saved.fold.instruction, false, 'the fold is persisted');
        // a fresh panel with the same storage starts folded
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const i2 = famsOf(extrasSec(h2)[0]).filter(f => f.dataset.family === 'instruction')[0];
        assert.equal(i2.open, false, 'the restored family is folded');
        // ...and the show-all choice persists the same way
        const r = famsOf(extrasSec(h2)[0]).filter(f => f.dataset.family === 'reasoning')[0];
        h.fire(classes(r, 'acc-extras-more')[0], 'click');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).all.reasoning, true);
        const h3 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const r3 = famsOf(extrasSec(h3)[0]).filter(f => f.dataset.family === 'reasoning')[0];
        assert.equal(cards(r3).length, 10, 'show-all survives the reopen');
    });

test('ACC-2a: a corrupt pref is no pref (defaults, never a throw)', async () => {
    const store = { 'uplift.bench.extras.v1': '{not json' };
    const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
    const sec = extrasSec(h)[0];
    assert.equal(famsOf(sec).length, 3, 'families still render from defaults');
    assert.equal(famsOf(sec)[0].open, true);
});

/* ---- 5. selection auto-reveals the folded family ---------------------- */
test('ACC-2a: selecting in a folded family auto-reveals it (and persists)',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const instr = famsOf(extrasSec(h)[0]).filter(f => f.dataset.family === 'instruction')[0];
        instr.open = false; h.fire(instr, 'toggle');
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const sec = extrasSec(h2)[0];
        const fam = famsOf(sec).filter(f => f.dataset.family === 'instruction')[0];
        assert.equal(fam.open, false, 'restored folded');
        const card = findCard(sec, 'ifeval|h');
        h2.fire(card, 'click');
        assert.equal(fam.open, true, 'the pick revealed the folded family');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).fold.instruction, true,
            'the reveal is persisted, not just painted');
        assert.ok(card._classes.has('on'), 'the card is selected');
        assert.equal(card.getAttribute('aria-pressed'), 'true',
            'aria-pressed mirrors the selection (U51)');
        const ACC = h2.B._panels.acc;
        assert.equal(ACC.state.selected['ifeval|h'], true, 'state tracks the pick');
        assert.equal(ACC.state.sizes['ifeval|h'], 100, 'the pick carries a sample limit');
    });

/* ---- 6. search filters the extras ONLY -------------------------------- */
test('ACC-2a: search filters inside the section; the classic grid never moves',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const before = cards(classicGrid(h)).map(c => c.dataset.key).sort();
        const search = h.byId['bench-acc-extras-search'];
        search.value = 'prox';
        h.fire(search, 'input');
        const sec = extrasSec(h)[0];
        const fam = famsOf(sec);
        assert.equal(fam.length, 1, 'only the matching family is left');
        assert.equal(fam[0].dataset.family, 'locale');
        assert.equal(cards(sec).length, 1);
        assert.deepEqual(cards(classicGrid(h)).map(c => c.dataset.key).sort(), before,
            'THE CLASSIC GRID IS NOT FILTERED — separation is the point');
        // a match beyond the CAP is shown: capping search hits would hide
        // the very suite the user typed for
        search.value = 'BBH Leaf'; h.fire(search, 'input');
        assert.equal(cards(extrasSec(h)[0]).length, 9, 'every search hit renders');
        // a folded family's MATCH must not stay hidden behind the fold
        const store = {};
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const i0 = famsOf(extrasSec(h2)[0]).filter(f => f.dataset.family === 'instruction')[0];
        i0.open = false; h2.fire(i0, 'toggle');
        const h3 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const s2 = extrasSec(h3)[0];
        assert.equal(famsOf(s2).filter(f => f.dataset.family === 'instruction')[0].open,
            false, 'the fold is restored from the pref');
        const s3 = h3.byId['bench-acc-extras-search'];
        s3.value = 'ifeval'; h3.fire(s3, 'input');
        const i1 = famsOf(extrasSec(h3)[0]).filter(f => f.dataset.family === 'instruction')[0];
        assert.equal(i1.open, true, 'a search match reveals the folded family');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).fold.instruction, false,
            'revealing for a search does NOT overwrite the stored preference');
        s3.value = ''; h3.fire(s3, 'input');
        assert.equal(famsOf(extrasSec(h3)[0])
            .filter(f => f.dataset.family === 'instruction')[0].open, false,
            'clearing the search puts the fold back');

        search.value = 'zzz'; h.fire(search, 'input');
        assert.ok(texts(extrasSec(h)[0]).includes('No additional suite matches'),
            'an honest empty line, not a silent blank panel');
        assert.deepEqual(cards(classicGrid(h)).map(c => c.dataset.key).sort(), before,
            'classic still untouched while the search matches nothing');
    });

/* ---- 7. upload can never reach a local-only suite --------------------- */
test('ACC-2a: a local-only pick leaves in its own entry with upload off',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const ACC = h.B._panels.acc;
        const sec = extrasSec(h)[0];
        h.byId['bench-acc-model'].value = 'm1';
        h.byId['bench-acc-upload'].checked = true;     // user opts into the leaderboard
        h.fire(findCard(sec, 'ifeval|h'), 'click');           // local-only suite
        h.fire(findCard(classicGrid(h), 'mmlu|h'), 'click');  // its uploadable twin
        const body = ACC.collect();
        assert.ok(body.upload, 'the classic entry keeps the opt-in');
        assert.ok(body._harness && body._harness.benchmarks.mmlu,
            'the classic harness twin still rides the uploadable entry');
        assert.ok(!('mmlu' in (body.benchmarks || {})), 'mmlu moved to the harness entry');
        assert.ok(body._extras, 'the extras entry is its own request');
        assert.deepEqual(Object.keys(body._extras.benchmarks), ['ifeval']);
        assert.equal(body._extras.upload, false,
            'THE LEADERBOARD FLAG IS NEVER SET FOR A LOCAL-ONLY SUITE');
        assert.equal(body._extras.engine, 'harness');
    });

test('ACC-2a: add() posts the extras entry too, after the other two',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const ACC = h.B._panels.acc;
        h.byId['bench-acc-model'].value = 'm1';
        h.fire(findCard(extrasSec(h)[0], 'ifeval|h'), 'click');
        await ACC.add();
        await tick();
        assert.equal(h.posts.length, 1, 'one POST for the extras-only pick');
        assert.equal(h.posts[0].body.engine, 'harness');
        assert.equal(h.posts[0].body.upload, false);
        assert.deepEqual(Object.keys(h.posts[0].body.benchmarks), ['ifeval']);
    });

test('ACC-2a: the U68 request total counts an extras pick honestly',
    async () => {
        // sizes map: ifeval x1, bbh_cot_fewshot x27; every extras pick
        // carries the harness sample limit -> 100 + 2700 = 2800 requests
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const ACC = h.B._panels.acc;
        const sec = extrasSec(h)[0];
        const tot = h.byId['bench-acc-engine-total'];
        assert.equal(tot.hidden, true, 'no pick -> the line stays hidden');
        h.fire(findCard(sec, 'ifeval|h'), 'click');
        h.fire(findCard(sec, 'bbh_cot_fewshot|h'), 'click');
        assert.equal(tot.hidden, false, 'an LM-Eval pick reveals the total');
        assert.ok(texts(tot).includes((2800).toLocaleString()),
            'the total must multiply by the leaf count, got: ' + texts(tot));
    });

/* ---- 8. structural pins ---------------------------------------------- */
test('ACC-2a: the extras module is a section of the existing IIFE, not a new one',
    () => {
        const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');
        const iifes = src.match(/^\(function \(root, factory\)/gm) || [];
        assert.equal(iifes.length, 1, 'uplift_bench.js stays ONE IIFE');
        assert.match(src, /^var EXTRAS = \{$/m, 'extras is a module-scope object');
        assert.match(src, /KEY: 'uplift\.bench\.extras\.v1'/, 'the LS key is exact');
        assert.match(src, /CAP: 6,/, 'the family cap is 6');
        // the classic grid path must not gain a single extras reference
        const g = src.slice(src.indexOf('renderGrid: function () {'));
        const body = g.slice(0, g.indexOf('\n    },'));
        assert.ok(body.includes('renderGrid'), 'renderGrid found');
        assert.ok(!/EXTRAS/.test(body), 'renderGrid stays extras-free');
        assert.match(src, /self\.state\.extrasAnchor = adv;/,
            'the anchor keeps the section between the grid and Advanced');
        assert.match(src, /self\.state\.extraSuites = ACC\._extrasCache;/,
            'loadTasks feeds the section from the harness-tasks response');
    });

test('ACC-2a: every extras key exists in all 10 locales with the EN placeholder set',
    () => {
        const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');
        const used = [...src.matchAll(/t\('(uplift\.bench\.extras_[a-z_]+)'/g)]
            .map(m => m[1]).filter(k => !k.endsWith('_'));
        // 'uplift.bench.extras_family_' + family is assembled at runtime
        // (the same dynamic-key family test_locale_sync cannot see), so
        // the gate walks the module's OWN family list — not a hardcoded
        // triple — and every caption it can ever show must be translated
        const { B } = load({});
        const fams = B._extras.FAM_KEYS
            .map(f => 'uplift.bench.extras_family_' + f);
        const keys = [...new Set(used.concat(fams))];
        assert.ok(keys.length >= 10, 'the section must be fully i18n-driven');
        const langs = fs.readdirSync(LOCALES).filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
        assert.equal(langs.length, 10, 'all 10 locales are on disk');
        const vars = v => (String(v).match(/\{\w+\}/g) || []).sort();
        const en = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en.json'), 'utf8'));
        for (const k of keys) assert.ok(en[k], 'en.json missing ' + k);
        for (const lang of langs) {
            const d = JSON.parse(fs.readFileSync(path.join(LOCALES, lang + '.json'), 'utf8'));
            for (const k of keys) {
                assert.ok(typeof d[k] === 'string' && d[k].trim(), lang + ': empty ' + k);
                assert.deepEqual(vars(d[k]), vars(en[k]),
                    `${lang}:${k} placeholder drift vs en`);
                if (lang !== 'en') {
                    // 'LM-Eval'/'IFEval' are names; prose strings must move
                    assert.notEqual(d[k], en[k], `${lang}:${k} left untranslated`);
                }
            }
        }
    });

test('ACC-2a: a queued local-only suite still gets its LABEL on the U83 board',
    () => {
        const { B } = load({});
        const meta = B._board.boardSuiteMeta(CLASSIC.tasks, 'ifeval', EXTRAS_FIX);
        assert.equal(meta.label, 'IFEval', 'the extras catalog answers the label');
        assert.equal(meta.full, 541, 'and its rows answer the Full-dataset size');
        // the classic answer wins for a classic key, extras never shadow it
        assert.equal(B._board.boardSuiteMeta(CLASSIC.tasks, 'mmlu',
            [{ key: 'mmlu', label: 'HIJACK', rows: 1 }]).label, 'MMLU');
        // unknown key: the pre-existing honest fallback stays
        assert.deepEqual(B._board.boardSuiteMeta(CLASSIC.tasks, 'nope', EXTRAS_FIX),
            { label: 'nope', full: 0 });
        // and a panel with no extras at all behaves exactly as before
        assert.deepEqual(B._board.boardSuiteMeta(CLASSIC.tasks, 'nope', undefined),
            { label: 'nope', full: 0 });
    });

test('ACC-2a: the extras module seam exposes honest pure helpers', () => {
    const { B } = load({});
    const X = B._extras;
    assert.equal(X.CAP, 6);
    assert.equal(X.KEY, 'uplift.bench.extras.v1');
    // norm: a malformed entry is dropped, a null/0 rows count is NOT a number
    assert.deepEqual(X.norm([{ key: 'a', rows: 5 }, null, {}, { rows: 9 }]),
        [{ key: 'a', label: 'a', family: 'other', rows: 5, upload_ok: false }]);
    assert.equal(X.norm([{ key: 'a', rows: 0 }])[0].rows, null,
        'rows 0 is not a dataset fact -> null -> the chip omits it');
    // families: the three known ones in contract order, unknown AFTER them
    assert.deepEqual(X.groups(X.norm([
        { key: 'z', family: 'arcade' }, { key: 'l', family: 'locale' },
        { key: 'i', family: 'instruction' }, { key: 'r', family: 'reasoning' },
    ])).map(g => g.family), ['instruction', 'reasoning', 'locale', 'arcade'],
        'an unknown family renders, never disappears');
    // chip math through the seam (the catalog is identity here: t -> key)
    assert.equal(X.chip(6500, 27), (6500).toLocaleString() + ' rows · \u00d727 · LM-Eval');
    assert.equal(X.chip(null, 27), '\u00d727 · LM-Eval');
    assert.equal(X.chip(541, 1), '541 rows · LM-Eval', '\u00d71 is never printed');
    assert.equal(X.chip(null, null), 'LM-Eval', 'nothing known -> nothing numeric');
    // upload truth: only an advertised upload_ok:true ever earns the flag
    const st = { extraSuites: [{ key: 'ifeval', upload_ok: false },
                               { key: 'maybe', upload_ok: true }] };
    assert.equal(X.uploadOk(st, 'ifeval'), false);
    assert.equal(X.uploadOk(st, 'maybe'), true);
    assert.equal(X.uploadOk(st, 'mmlu'), true, 'a classic twin is unaffected');
    assert.equal(X.isExtra(st, 'mmlu'), false);
});

test('ACC-2a: a suite the seam ships WITHOUT a family still lands somewhere named',
    async () => {
        // harness_engine.extra_suites() reads family straight off the spec
        // (spec.get('family') -> null when ACC-2c forgets it). Such a suite
        // must never vanish from the picker or caption itself with 'null'.
        const h = await accuracy({ tasks: { extra_suites: [
            { key: 'orphan', label: 'Orphan Suite', family: null,
              rows: 10, upload_ok: false }] } });
        const sec = extrasSec(h)[0];
        const fam = famsOf(sec);
        assert.equal(fam.length, 1, 'the orphan still renders in a family');
        assert.equal(fam[0].dataset.family, 'other');
        const cap = texts(fam[0].children[0]);
        assert.ok(cap.includes('Other'), 'translated caption, not a raw null: ' + cap);
        assert.ok(!/null|undefined/.test(texts(sec)), 'no null leaks into the DOM');
        assert.equal(cards(sec).length, 1);
    });

test('ACC-2a: uplift.css adds the extras block with no re-opened selector', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    for (const sel of ['.acc-extras', '.acc-extras-cap', '.acc-extras-search',
        '.acc-extras-fams', '.acc-extras-more', '.acc-task-chip']) {
        const n = (css.match(new RegExp('\\n' + sel.replace(/[.-]/g, '\\$&') +
            '\\s*[,{> ]', 'g')) || []).length;
        assert.ok(n >= 1, sel + ' must be styled');
        assert.ok(n <= 2, sel + ' appears ' + n + 'x — do not re-open a selector');
    }
});
