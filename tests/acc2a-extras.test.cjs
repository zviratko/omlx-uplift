/* ACC-2a + ACC-2b — the 'Additional suites' section.

   Frozen user contract this file guards:
     (2) the classic grid (#bench-acc-tasks) shows oMLX CLASSIC cards ONLY —
         every LM-Eval card, both the twin of a classic suite and the
         expanded catalog, lives inside the section;
     (3) the section is a <details> fold, COLLAPSED until the user clicks it,
         framed stronger than the Advanced block (accent spine + row ground)
         with a header summary: title + suite count + chevron.

   Behavioural proofs run through the vm sandbox + a DOM stub strong enough
   to express the real interactions (parent/child splice via insertBefore +
   remove, per-element listener registries fired with fire(), a working
   localStorage map, and a querySelectorAll that implements the
   '#id .class' descendant selectors AND the comma list the module now uses).

   Pinned here:
   - the section exists as soon as a harness card exists (a twin OR an extra
     suite); with neither, zero DOM delta
   - no '|h' card may stay in the classic grid, ever
   - the size chip does the honest U68 math (rows · ×leaves · LM-Eval) and
     omits a part it does not know — never a guessed number
   - 6-card family cap + 'show all (N)' / 'hide' — for the core family too
   - the section fold, the family folds and show-all persist under
     'uplift.bench.extras.v1' and are restored; aria-expanded is honest
   - the LM-Eval request total stays OUTSIDE the fold
   - the search box filters the section INCLUDING the twins; the classic
     grid is untouched
   - a local-only pick never travels with the leaderboard upload flag, and
     the twin that moved into the fold still rides the uploadable entry
   - structural: one IIFE, the extras code is its own module block, the
     classic grid paints no variant card, and every new
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
        // A comma list ('#a .x, #b .x') is ONE query: every group is
        // matched, the union deduped — the shape applyEngineLabels needs
        // now that the harness cards live in a second container.
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
// a 16-suite classic catalog whose every key has a harness twin: the core
// family must obey the SAME per-family cap the extras families always did
const TASKS16 = [{
    group: 'acc_bench.benchmarks.group_all',
    tasks: Array.from({ length: 16 }, (_, i) => ({
        key: 'k' + i, label: 'Suite ' + i, desc: 'acc_bench.benchmarks.k_desc',
        full_size: 1000 + i, sizes: [30, 50, 100],
    })),
}];
const KEYS16 = TASKS16[0].tasks.map(t => t.key);

function load(opts) {
    const o = opts || {};
    const { doc, byId, fire } = makeDom();
    const store = o.store || {};
    const posts = [];
    const win = {
        // t(): the real module resolves through UpliftCore.t(key) and keeps
        // its own EN fallback when the answer is the bare key. `tr` lets a
        // test answer for one key so a {n} substitution can be pinned.
        UpliftCore: { t: k => (o.tr && o.tr[k]) || k },
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
    // STUB EXTENSION (ACC-2b): the stub's document root had no children at
    // all (mount attaches to #bench-native, which only lived in the byId
    // registry), so a document-wide querySelectorAll could never resolve
    // ANY descendant selector and the module's new
    // '#bench-acc-tasks .acc-task, #bench-acc-extras .acc-task' list was
    // untestable. Hanging the real mount point under the root BEFORE the
    // fetches settle makes the lookup behave like the browser's.
    const host = h.byId['bench-native'];
    if (host && h.doc.children.indexOf(host) < 0) h.doc.appendChild(host);
    h.B.showSub('accuracy');
    await tick(); await tick();
    h.panel = h.byId['bench-subpanel'];
    // the form is taken from where it is really attached
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
function famOf(sec, family) {
    return famsOf(sec).filter(f => f.dataset.family === family)[0] || null;
}
function cards(sec) { return classes(sec, 'acc-task'); }
function headOf(sec) { return classes(sec, 'acc-extras-head')[0] || null; }
function countOf(sec) { return classes(sec, 'acc-extras-count')[0] || null; }
function bodyOf(sec) { return classes(sec, 'acc-extras-body')[0] || null; }
function texts(n) {
    let s = n.textContent || '';
    (n.children || []).forEach(c => { s += ' ' + texts(c); });
    return s;
}
function classicGrid(h) { return h.byId['bench-acc-tasks']; }
function gridKeys(h) { return cards(classicGrid(h)).map(c => c.dataset.key).sort(); }
function findCard(sec, key) {
    return cards(sec).filter(c => c.dataset && c.dataset.key === key)[0] || null;
}
function selectOf(card) { return (card.children.filter(c => c.tagName === 'select'))[0]; }
function chipOf(card) {
    return texts(card.children.filter(c => c._classes.has('acc-task-chip'))[0]);
}
// direct-children index of the form (-1 when absent)
function at(h, pred) { return h.form.children.findIndex(pred); }

/* ---- 1. who owns which card ------------------------------------------- */
test('ACC-2b: the classic grid shows CLASSIC cards only — no |h card survives',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        assert.deepEqual(gridKeys(h), ['gsm8k', 'mmlu'],
            'the twin left the grid: mmlu|h is not a classic-grid card anymore');
        assert.ok(!gridKeys(h).some(k => k.indexOf('|h') > 0),
            'NOT ONE harness card may stay inside #bench-acc-tasks');
    });

test('ACC-2b: the twin of a classic suite lives in the fold, family core',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const sec = extrasSec(h)[0];
        assert.ok(famOf(sec, 'core'), 'a core family exists for the classic twins');
        const twin = findCard(famOf(sec, 'core'), 'mmlu|h');
        assert.ok(twin, 'the twin renders inside its own family group');
        // it is the REAL taskRowEl card: same key, its own size select, the
        // LM-Eval engine caption — only its HOME moved
        assert.equal(twin.getAttribute('role'), 'button');
        assert.equal(twin.classList.contains('acc-task-harness'), true);
        assert.equal(selectOf(twin).dataset.key, 'mmlu|h',
            'the size select still carries the |h key (collect() is unchanged)');
        assert.equal(classes(twin, 'acc-task-engine').length, 1,
            'and its engine caption is the LM-Eval one');
        assert.equal(twin.dataset.localOnly, undefined,
            'a classic twin is NOT a local-only suite');
    });

test('ACC-2b: a twin alone builds the section (no extra_suites needed)',
    async () => {
        const h = await accuracy({});                      // key absent
        const sec = extrasSec(h);
        assert.equal(sec.length, 1, 'harness_tasks alone is enough');
        assert.equal(cards(sec[0]).length, 1, 'and it holds the one twin');
        assert.equal(famOf(sec[0], 'core').dataset.family, 'core',
            'the twin lands in the core family, not a bare list');
    });

test('ACC-2b: no twin AND no extra suite -> the section does not exist at all',
    async () => {
        const h = await accuracy({ tasks: { harness_tasks: [], extra_suites: [] } });
        assert.deepEqual(extrasSec(h), [], 'no .acc-extras node may be built');
        assert.ok(!h.byId['bench-acc-extras'],
            'the section id was never even allocated: zero DOM delta');
        assert.deepEqual(gridKeys(h), ['gsm8k', 'mmlu'],
            'a pre-ACC-2b server keeps the plain classic grid');
    });

test('ACC-2b: the fold sits under the grid and ABOVE the LM-Eval total',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const kids = h.form.children;
        const gi = at(h, k => k.id === 'bench-acc-tasks');
        const hi = at(h, k => k.id === 'bench-acc-engine-hint');
        const ei = at(h, k => k._classes && k._classes.has('acc-extras'));
        const ti = at(h, k => k.id === 'bench-acc-engine-total');
        const ai = at(h, k => k._classes && k._classes.has('bench-advanced'));
        assert.ok(gi >= 0, 'the grid exists');
        assert.equal(hi, gi + 1, 'the engine hint stays right under the grid');
        assert.equal(ei, hi + 1, 'the fold is the next block');
        assert.equal(ti, ei + 1,
            'the request total is a SIBLING below the fold, not inside it: '
            + 'it must stay readable while the section is collapsed');
        assert.ok(ai > ti, 'and the fold never sits after Advanced / the run buttons');
        assert.equal(kids[ei].id, 'bench-acc-extras');
    });

test('ACC-2b: the section carries no upload affordance of its own',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const sec = extrasSec(h)[0];
        assert.deepEqual(classes(sec, 'bench-check'), [],
            'no checkbox may live inside the extras section');
        assert.ok(!texts(sec).includes('uplift.bench.upload'),
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
            const at2 = Object.keys(n.attrs || {}).sort().map(k => k + '=' + n.attrs[k]);
            return '<' + n.tagName + ' id=' + (n.id || '') +
                ' class=' + n.className + ' type=' + n.type + ' value=' + n.value +
                ' hidden=' + (n.hidden ? 1 : 0) + ' ph=' + (n.placeholder || '') +
                ' title=' + (n.title || '') + ' open=' + (n.open ? 1 : 0) + ' ' +
                ds.concat(at2).join(',') + '>' + (n.textContent || '') +
                (n.children || []).map(ser).join('') + '</' + n.tagName + '>';
        };
        const panel = async (tasks) => {
            const h = await accuracy({ tasks });
            return h.form.children.filter(n => !(n._classes && n._classes.has('acc-extras')))
                .map(ser).join('\n');
        };
        const without = await panel({ harness_tasks: [], extra_suites: [] });
        const empty = await panel({ harness_tasks: [], extra_suites: [] });
        const twins = await panel(undefined);            // a twin, no extras
        const withExtras = await panel({ extra_suites: EXTRAS_FIX });
        assert.ok(without.length > 500, 'the classic panel really did render');
        assert.equal(withExtras, without,
            'extras present must not perturb ONE node of the classic panel');
        assert.equal(empty, without, 'an empty list is identical too');
        assert.equal(twins, without,
            'a twin moved into the fold: the grid outside it is untouched');
        // the grid itself loses its twin on every server that has one, so
        // the zero-delta reading applies to a plain classic server only
        assert.deepEqual(gridKeys(await accuracy({ tasks: { harness_tasks: [] } })),
            ['gsm8k', 'mmlu'], 'classic-only, always');
    });

/* ---- 2. chip math (U68 honesty) --------------------------------------- */
test('ACC-2a: size chip is rows · ×leaves · LM-Eval, omitting what is unknown',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const sec = extrasSec(h)[0];
        const chip = k => chipOf(findCard(sec, k + '|h'));
        assert.equal(chip('ifeval'), (541).toLocaleString() + ' rows · LM-Eval',
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
        assert.equal(chipOf(findCard(sec, 'bbh_cot_fewshot|h')),
            (6500).toLocaleString() + ' rows · LM-Eval',
            'no harness-sizes map -> no ×leaves part, never a guessed ×1 lie');
    });

test('ACC-2b: the twin renders the classic card shape, not a chip card',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const twin = findCard(extrasSec(h)[0], 'mmlu|h');
        assert.deepEqual(classes(twin, 'acc-task-chip'), [],
            'taskRowEl has no chip: its cost reads on the size options instead');
    });

/* ---- 3. family cap + show all ----------------------------------------- */
test('ACC-2a: 6-card cap per family + show all (N) then hide', async () => {
    const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
    const sec = extrasSec(h)[0];
    const reasoning = famOf(sec, 'reasoning');
    assert.equal(cards(reasoning).length, 6, 'the family shows CAP=6 cards');
    const more = classes(reasoning, 'acc-extras-more')[0];
    assert.ok(more, 'a show-all toggle exists for a capped family');
    assert.equal(texts(more), 'show all (10)',
        'the toggle counts EVERY suite of the family, not the hidden tail');
    h.fire(more, 'click');
    const r2 = famOf(extrasSec(h)[0], 'reasoning');
    assert.equal(cards(r2).length, 10, 'show all reveals the whole family');
    const hide = classes(r2, 'acc-extras-more')[0];
    assert.equal(texts(hide), 'hide');
    h.fire(hide, 'click');
    assert.equal(cards(famOf(extrasSec(h)[0], 'reasoning')).length, 6, 'hide re-caps at 6');
    // the instruction family (1 card) must carry NO toggle
    const instr = famOf(extrasSec(h)[0], 'instruction');
    assert.equal(cards(instr).length, 1);
    assert.deepEqual(classes(instr, 'acc-extras-more'), [],
        'a family under the cap gets no toggle');
});

test('ACC-2b: the core family obeys the same cap (16 twins -> 6 + show all)',
    async () => {
        const h = await accuracy({ tasks: { tasks: TASKS16, harness_tasks: KEYS16,
                                            extra_suites: [] } });
        const sec = extrasSec(h)[0];
        assert.equal(famsOf(sec).length, 1, 'only the core family exists here');
        assert.equal(famsOf(sec)[0].dataset.family, 'core',
            'and it leads the section (FAMILIES order is a contract)');
        const core = famOf(sec, 'core');
        assert.equal(cards(core).length, 6, 'the twins are capped like any family');
        const more = classes(core, 'acc-extras-more')[0];
        assert.equal(texts(more), 'show all (16)');
        h.fire(more, 'click');
        assert.equal(cards(famOf(extrasSec(h)[0], 'core')).length, 16);
        // the grid keeps all 16 CLASSIC cards regardless
        assert.equal(cards(classicGrid(h)).length, 16);
        assert.ok(!gridKeys(h).some(k => k.indexOf('|h') > 0));
    });

/* ---- 4. the SECTION fold (collapsed by default) ------------------------ */
test('ACC-2b: the section is a <details> fold, collapsed until clicked',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const sec = extrasSec(h)[0];
        assert.equal(sec.tagName, 'details', 'the section root is a real fold');
        assert.equal(sec.id, 'bench-acc-extras');
        assert.equal(sec.open, false, 'COLLAPSED by default — nothing to click past');
        const head = headOf(sec);
        assert.ok(head, 'the fold has its own header');
        assert.equal(head.tagName, 'summary');
        assert.equal(head.getAttribute('aria-expanded'), 'false',
            'aria-expanded is honest on the FIRST paint (U51)');
        // title + count + chevron, in that shape
        assert.ok(classes(head, 'acc-extras-cap')[0], 'the caption lives in the header');
        assert.ok(countOf(sec), 'the header carries a suite count');
        assert.ok(classes(head, 'bench-adv-chev')[0], 'and a chevron');
        // everything that belongs to the fold is INSIDE the details, and
        // the header is its only always-visible part
        const body = bodyOf(sec);
        assert.ok(body, 'the fold has a body wrapper');
        assert.ok(classes(body, 'acc-extras-search')[0]);
        assert.ok(classes(body, 'acc-extras-fams')[0]);
        assert.equal(body.parentNode, sec);
        assert.equal(sec.children[0], head, 'summary first, body second');
        assert.equal(sec.children.length, 2);
    });

test('ACC-2b: opening the fold persists open:true and is restored on reopen',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const sec = extrasSec(h)[0];
        assert.ok(!('uplift.bench.extras.v1' in store),
            'an untouched section writes no pref at all');
        sec.open = true;
        h.fire(sec, 'toggle');
        assert.equal(headOf(extrasSec(h)[0]).getAttribute('aria-expanded'), 'true');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).open, true,
            'the section fold lives in the SAME localStorage object');
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        assert.equal(extrasSec(h2)[0].open, true, 'the opened fold is restored');
        assert.equal(headOf(extrasSec(h2)[0]).getAttribute('aria-expanded'), 'true',
            'and aria-expanded is restored with it');
        const reopened = extrasSec(h2)[0];
        reopened.open = false;
        h2.fire(reopened, 'toggle');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).open, false,
            'closing it again is remembered too');
        const h3 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        assert.equal(extrasSec(h3)[0].open, false, 'collapsed again on the next visit');
    });

test('ACC-2b: the families INSIDE the fold keep their own prefs',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const sec = extrasSec(h)[0];
        assert.equal(sec.open, false, 'the section is folded...');
        assert.equal(famOf(sec, 'instruction').open, true,
            '...while the families inside still default open (unchanged)');
        famOf(sec, 'instruction').open = false;
        h.fire(famOf(sec, 'instruction'), 'toggle');
        const saved = JSON.parse(store['uplift.bench.extras.v1']);
        assert.equal(saved.fold.instruction, false, 'the family fold is persisted');
        assert.equal(saved.open, false, 'the section fold is NOT flipped by it');
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const s2 = extrasSec(h2)[0];
        assert.equal(s2.open, false, 'the section reopened collapsed');
        assert.equal(famOf(s2, 'instruction').open, false, 'the family reopened folded');
        // ...and the show-all choice persists the same way
        h2.fire(classes(famOf(s2, 'reasoning'), 'acc-extras-more')[0], 'click');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).all.reasoning, true);
        const h3 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        assert.equal(cards(famOf(extrasSec(h3)[0], 'reasoning')).length, 10,
            'show-all survives the reopen');
    });

test('ACC-2a: fold state persists under uplift.bench.extras.v1 and restores',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const instr = famOf(extrasSec(h)[0], 'instruction');
        assert.equal(instr.open, true, 'families start open');
        instr.open = false;
        h.fire(instr, 'toggle');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).fold.instruction, false);
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        assert.equal(famOf(extrasSec(h2)[0], 'instruction').open, false,
            'a fresh panel with the same storage starts folded');
    });

test('ACC-2a: a corrupt pref is no pref (defaults, never a throw)', async () => {
    const store = { 'uplift.bench.extras.v1': '{not json' };
    const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
    const sec = extrasSec(h)[0];
    // core (the mmlu twin) + instruction + reasoning + locale
    assert.equal(famsOf(sec).length, 4, 'families still render from defaults');
    assert.equal(famsOf(sec)[0].open, true, 'families default open');
    assert.equal(sec.open, false, 'the SECTION defaults collapsed');
});

/* ---- 5. selection auto-reveals the folded family ---------------------- */
test('ACC-2a: selecting in a folded family auto-reveals it (and persists)',
    async () => {
        const store = {};
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const instr = famOf(extrasSec(h)[0], 'instruction');
        instr.open = false; h.fire(instr, 'toggle');
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const sec = extrasSec(h2)[0];
        const fam = famOf(sec, 'instruction');
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

/* ---- 6. the header count ---------------------------------------------- */
test('ACC-2b: the header shows the suite count, with its i18n repair attrs',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX },
            tr: { 'uplift.bench.extras_count': '{n} suites' } });
        const sec = extrasSec(h)[0];
        const cnt = countOf(sec);
        // 1 core twin + 3 named extras + 9 BBH leaves
        assert.equal(cnt.textContent, '13 suites',
            'the count answers how much is behind the fold');
        assert.equal(cnt.dataset.i18n, 'uplift.bench.extras_count');
        assert.equal(cnt.dataset.en, '13 suites',
            'U59: data-en carries the RENDERED text (like the cap), never a '
            + "raw '{n}' template");
        // a search filters the LIST, not what the section holds
        const search = h.byId['bench-acc-extras-search'];
        search.value = 'prox'; h.fire(search, 'input');
        assert.equal(countOf(extrasSec(h)[0]).textContent, '13 suites');
        // and the count is right when a twin alone opens the section
        const h2 = await accuracy({ tr: { 'uplift.bench.extras_count': '{n} suites' } });
        assert.equal(countOf(extrasSec(h2)[0]).textContent, '1 suites',
            'no invented singular: the {n} key owns its own plural shape');
    });

/* ---- 7. search filters the section (twins included) -------------------- */
test('ACC-2a: search filters inside the section; the classic grid never moves',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const before = gridKeys(h);
        const search = h.byId['bench-acc-extras-search'];
        search.value = 'prox';
        h.fire(search, 'input');
        const fam = famsOf(extrasSec(h)[0]);
        assert.equal(fam.length, 1, 'only the matching family is left');
        assert.equal(fam[0].dataset.family, 'locale');
        assert.equal(cards(extrasSec(h)[0]).length, 1);
        assert.deepEqual(gridKeys(h), before,
            'THE CLASSIC GRID IS NOT FILTERED — separation is the point');
        // a match beyond the CAP is shown: capping search hits would hide
        // the very suite the user typed for
        search.value = 'BBH Leaf'; h.fire(search, 'input');
        assert.equal(cards(extrasSec(h)[0]).length, 9, 'every search hit renders');
        // THE TWIN IS SEARCHABLE NOW TOO — it left the grid, so a search
        // that does not reach it would simply lose MMLU's harness card
        search.value = 'mmlu'; h.fire(search, 'input');
        const sec = extrasSec(h)[0];
        assert.ok(findCard(sec, 'mmlu|h'), 'the twin matches its own key/label');
        assert.ok(famOf(sec, 'core'), 'and its family stays in the section');
        assert.deepEqual(gridKeys(h), before, 'the grid is STILL not filtered');
        // a folded family's MATCH must not stay hidden behind the fold
        const store = {};
        const h2 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        const i0 = famOf(extrasSec(h2)[0], 'instruction');
        i0.open = false; h2.fire(i0, 'toggle');
        const h3 = await accuracy({ tasks: { extra_suites: EXTRAS_FIX }, store });
        assert.equal(famOf(extrasSec(h3)[0], 'instruction').open, false,
            'the family fold is restored from the pref');
        const s3 = h3.byId['bench-acc-extras-search'];
        s3.value = 'ifeval'; h3.fire(s3, 'input');
        assert.equal(famOf(extrasSec(h3)[0], 'instruction').open, true,
            'a search match reveals the folded family');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).fold.instruction, false,
            'revealing for a search does NOT overwrite the stored preference');
        assert.equal(JSON.parse(store['uplift.bench.extras.v1']).open, false,
            'and it does not blow the section fold open either');
        s3.value = ''; h3.fire(s3, 'input');
        assert.equal(famOf(extrasSec(h3)[0], 'instruction').open, false,
            'clearing the search puts the fold back');
        search.value = 'zzz'; h.fire(search, 'input');
        assert.ok(texts(extrasSec(h)[0]).includes('No additional suite matches'),
            'an honest empty line, not a silent blank panel');
        assert.deepEqual(gridKeys(h), before,
            'classic still untouched while the search matches nothing');
    });

/* ---- 8. upload can never reach a local-only suite ---------------------- */
test('ACC-2a: a local-only pick leaves in its own entry with upload off',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const ACC = h.B._panels.acc;
        const sec = extrasSec(h)[0];
        h.byId['bench-acc-model'].value = 'm1';
        h.byId['bench-acc-upload'].checked = true;     // user opts into the leaderboard
        h.fire(findCard(sec, 'ifeval|h'), 'click');           // local-only suite
        h.fire(findCard(sec, 'mmlu|h'), 'click');     // the twin, now in the fold
        const body = ACC.collect();
        assert.ok(body.upload, 'the classic entry keeps the opt-in');
        assert.ok(body._harness && body._harness.benchmarks.mmlu,
            "the twin still rides the UPLOADABLE harness entry from its new home");
        assert.equal(body._harness.upload, true, 'and keeps the flag with it');
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

test('ACC-2b: picking only the twin posts one uploadable harness entry',
    async () => {
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const ACC = h.B._panels.acc;
        h.byId['bench-acc-model'].value = 'm1';
        h.byId['bench-acc-upload'].checked = true;
        h.fire(findCard(extrasSec(h)[0], 'mmlu|h'), 'click');
        await ACC.add();
        await tick();
        assert.equal(h.posts.length, 1, 'the twin is not an extra: one entry');
        assert.equal(h.posts[0].body.engine, 'harness');
        assert.equal(h.posts[0].body.upload, true,
            'a classic suite keeps its leaderboard right after the move');
        assert.equal(h.posts[0].body.benchmarks.mmlu, ACC.defaultSize('mmlu|h'),
            'and the size default resolves through the |h key');
    });

test('ACC-2a: the U68 request total counts an extras pick honestly',
    async () => {
        // sizes map: ifeval x1, bbh_cot_fewshot x27; every extras pick
        // carries the harness sample limit -> 100 + 2700 = 2800 requests
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const sec = extrasSec(h)[0];
        const tot = h.byId['bench-acc-engine-total'];
        assert.equal(tot.hidden, true, 'no pick -> the line stays hidden');
        h.fire(findCard(sec, 'ifeval|h'), 'click');
        h.fire(findCard(sec, 'bbh_cot_fewshot|h'), 'click');
        assert.equal(tot.hidden, false, 'an LM-Eval pick reveals the total');
        assert.ok(texts(tot).includes((2800).toLocaleString()),
            'the total must multiply by the leaf count, got: ' + texts(tot));
    });

test('ACC-2b: the size-option multiplier follows the twin into the fold',
    async () => {
        // applyEngineLabels() queries '#bench-acc-tasks .acc-task,
        // #bench-acc-extras .acc-task' — the comma list is what keeps the
        // '30 ×57' truth alive after the move, so it must resolve here.
        const h = await accuracy({ tasks: { extra_suites: EXTRAS_FIX } });
        const twin = findCard(extrasSec(h)[0], 'mmlu|h');
        assert.deepEqual(selectOf(twin).children.map(o => o.textContent),
            ['30 \u00d757', '50 \u00d757', '100 \u00d757'],
            'the harness twin multiplies its own options');
        assert.deepEqual(selectOf(twin).children.map(o => o.dataset.base),
            ['30', '50', '100'], 'the base text is kept (idempotent repaint)');
        const classic = findCard(classicGrid(h), 'mmlu');
        assert.deepEqual(selectOf(classic).children.map(o => o.textContent),
            ['30', '50', '100', 'Full (14,042)'],
            'a classic card is never multiplied, and keeps its Full option');
        // an extras LIMIT card has no select at all: it must skip, not throw
        assert.ok(!selectOf(findCard(extrasSec(h)[0], 'ifeval|h')),
            'the extras card carries no size select');
    });

/* ---- 9. structural pins ----------------------------------------------- */
test('ACC-2a: the extras module is a section of the existing IIFE, not a new one',
    () => {
        const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');
        const iifes = src.match(/^\(function \(root, factory\)/gm) || [];
        assert.equal(iifes.length, 1, 'uplift_bench.js stays ONE IIFE');
        assert.match(src, /^var EXTRAS = \{$/m, 'extras is a module-scope object');
        assert.match(src, /KEY: 'uplift\.bench\.extras\.v1'/, 'the LS key is exact');
        assert.match(src, /CAP: 6,/, 'the family cap is 6');
        assert.match(src, /buildExtras: function \(st\) \{/,
            'the section owns ONE merged item list (twins + extra suites)');
        // the classic grid path must not gain a single extras reference,
        // and must not paint a variant card either
        const g = src.slice(src.indexOf('renderGrid: function () {'));
        const body = g.slice(0, g.indexOf('\n    },'));
        assert.ok(body.includes('renderGrid'), 'renderGrid found');
        assert.ok(!/EXTRAS/.test(body), 'renderGrid stays extras-free');
        assert.ok(!/taskRowEl\(\s*\w+\s*,\s*true\s*\)/.test(body),
            'the twin-card branch is GONE: the grid paints classic cards only');
        assert.match(body, /self\.taskRowEl\(tk, false\)/, 'once per classic task');
        assert.match(src, /self\.state\.extrasAnchor = totNote;/,
            'the anchor keeps the section between the grid and the total');
        assert.match(src, /self\.state\.extraSuites = ACC\._extrasCache;/,
            'loadTasks feeds the section from the harness-tasks response');
        assert.match(src, /'#bench-acc-tasks \.acc-task, #bench-acc-extras \.acc-task'/,
            'the engine labels cover BOTH containers now');
    });

test('ACC-2b: the engine hint points at the section instead of at the grid',
    async () => {
        const h = await accuracy({});
        const hint = h.byId['bench-acc-engine-hint'];
        assert.equal(hint.id, 'bench-acc-engine-hint', 'the id is untouched');
        assert.match(hint.textContent,
            /The LM-Eval suites live in the Additional suites section below/,
            'the EN fallback sends the reader to the fold: ' + hint.textContent);
        assert.ok(hint.textContent.indexOf('1710') > 0,
            'and keeps the per-subtask math that justifies the fold');
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
        // ACC-2b adds exactly two: the 'core' family caption and the
        // header's suite count. The orchestrator lands them in locales/ in
        // its own lane — until then THIS pin is the expected red.
        for (const k of ['uplift.bench.extras_family_core',
                         'uplift.bench.extras_count'])
            assert.ok(keys.includes(k), 'the gate must cover the new key ' + k);
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
    // the family contract: 'core' LEADS, unknown families render after it
    assert.deepEqual(X.FAMILIES, ['core', 'instruction', 'reasoning', 'locale']);
    assert.deepEqual(X.FAM_KEYS,
        ['core', 'instruction', 'reasoning', 'locale', 'other']);
    // norm: a malformed entry is dropped, a null/0 rows count is NOT a number
    assert.deepEqual(X.norm([{ key: 'a', rows: 5 }, null, {}, { rows: 9 }]),
        [{ key: 'a', label: 'a', family: 'other', rows: 5, upload_ok: false }]);
    assert.equal(X.norm([{ key: 'a', rows: 0 }])[0].rows, null,
        'rows 0 is not a dataset fact -> null -> the chip omits it');
    // buildExtras: the twins come FIRST, in server/catalog order, and carry
    // their task object so the real card can be painted
    const items = X.buildExtras({ groups: CLASSIC.tasks,
                                  harnessTasks: ['mmlu'], extraSuites: EXTRAS_FIX });
    assert.equal(items[0].family, 'core');
    assert.equal(items[0].key, 'mmlu');
    assert.equal(items[0].rows, 14042, 'the classic full_size is the row truth');
    assert.equal(items[0].upload_ok, true, 'a twin is NOT local-only');
    assert.equal(items[0].task.key, 'mmlu', 'and it carries the task object');
    assert.equal(items[1].key, 'ifeval', 'the extra suites follow in server order');
    assert.equal(items.length, 1 + EXTRAS_FIX.length);
    assert.deepEqual(X.buildExtras({ groups: null, harnessTasks: [], extraSuites: [] }),
        [], 'nothing known -> nothing rendered');
    assert.deepEqual(X.buildExtras({ groups: CLASSIC.tasks, harnessTasks: ['gsm8k'],
                                    extraSuites: [] }).map(i => i.key), ['gsm8k'],
        'a twin is built for every advertised harness key, in catalog order');
    // families: the known ones in contract order, unknown AFTER them
    assert.deepEqual(X.groups(X.norm([
        { key: 'z', family: 'arcade' }, { key: 'l', family: 'locale' },
        { key: 'i', family: 'instruction' }, { key: 'r', family: 'reasoning' },
    ])).map(g => g.family), ['instruction', 'reasoning', 'locale', 'arcade'],
        'an unknown family renders, never disappears');
    assert.deepEqual(X.groups(items).map(g => g.family),
        ['core', 'instruction', 'reasoning', 'locale'],
        'core leads a real section');
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
    assert.equal(X.isExtra(st, 'mmlu'), false,
        'the twin in the section is STILL not an extra — its entry stays uploadable');
    // the section fold rides the SAME pref object
    assert.equal(X.ui().open, false, 'collapsed by default');
});

test('ACC-2a: a suite the seam ships WITHOUT a family still lands somewhere named',
    async () => {
        // harness_engine.extra_suites() reads family straight off the spec
        // (spec.get('family') -> null when ACC-2c forgets it). Such a suite
        // must never vanish from the picker or caption itself with 'null'.
        const h = await accuracy({ tasks: { harness_tasks: [], extra_suites: [
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

test('ACC-2b: uplift.css styles the fold, with no re-opened selector', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    for (const sel of ['.acc-extras', '.acc-extras-cap', '.acc-extras-search',
        '.acc-extras-fams', '.acc-extras-more', '.acc-task-chip',
        // the fold's own shape (ACC-2b)
        '.acc-extras-head', '.acc-extras-count', '.acc-extras-body']) {
        const n = (css.match(new RegExp('\\n' + sel.replace(/[.-]/g, '\\$&') +
            '\\s*[,{> ]', 'g')) || []).length;
        assert.ok(n >= 1, sel + ' must be styled');
        assert.ok(n <= 2, sel + ' appears ' + n + 'x — do not re-open a selector');
    }
    // prominent, and honest about the fold
    assert.match(css, /\.acc-extras \{[^}]*border-left:\s*3px solid var\(--accent\)/,
        'the accent spine is what makes it read stronger than Advanced');
    assert.match(css, /\.acc-extras \{[^}]*var\(--row2\)/,
        'the ground is a token, so skins keep working');
    assert.match(css, /\.acc-extras-head \{[^}]*list-style:\s*none/,
        'the native <details> marker is hidden on the header');
    assert.match(css, /\.acc-extras-head::-webkit-details-marker \{ display: none/,
        'including in webkit');
    assert.match(css,
        /\.acc-extras\[open\] > \.acc-extras-head \.bench-adv-chev \{[^}]*rotate\(180deg\)/,
        'the chevron turns with the section fold (the .bench-advanced rule cannot)');
    assert.ok(!/\.acc-extras \{[^}]*padding-top/.test(css),
        'a CLOSED fold may not carry stray padding — the body owns its padding');
});
