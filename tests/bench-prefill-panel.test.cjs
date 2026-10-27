/* PREFILL-4 (user item 4): the uplift-native prefill/parallel probe panel.
   repl1-bench-mount harness pattern — vm sandbox + hand-rolled DOM stub, no
   browser. What is pinned here:

   1. the block is really PAINTED inside the throughput form (asserted
      THROUGH the parent, by identity — a built-but-never-appended control
      passes a byId lookup and shows nothing in a browser)
   2. the client's bounds mirror the server's (1024 floor / no ceiling on
      prefill, 1..256 parallel, stagger >= 0, tg >= 1) via the pure pfBody
   3. THE VANILLA PATH IS UNTOUCHED: TP.collect() still produces exactly the
      classic payload, byte for byte, and /bench/start still receives it
   4. external-endpoint mode kills the whole block (same syncCacheOff rule)
      and relabels the hint through a LITERAL i18n key
   5. one progress affordance per panel: the probe drives the existing
      bench-tp-status box and adds no second bar
   6. the SSE shapes render: per-request rows, the aggregate summary, and an
      honest error line
   7. cancel posts to the probe's own route
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const EN = {
    'bench.config.model_placeholder': 'Select model\u2026',
    'uplift.bench.prefill.section': 'Advanced prefill and parallelism',
    'uplift.bench.prefill.tokens': 'Prefill tokens',
    'uplift.bench.prefill.parallel': 'Parallel requests',
    'uplift.bench.prefill.stagger': 'Stagger between starts (s)',
    'uplift.bench.prefill.generation': 'Generation tokens',
    'uplift.bench.prefill.run': 'Start custom benchmark',
    'uplift.bench.prefill.hint': 'Custom prompt sizes, request counts and start '
        + 'timing, measured outside the standard benchmark. The run ignores '
        + 'the server\'s concurrency limit while it is in flight and restores '
        + 'it when it ends. It refuses to start while another benchmark holds '
        + 'the engine; a benchmark started from the classic admin page during '
        + 'a custom benchmark is not blocked, and both results would be wrong.',
    'uplift.bench.prefill.local_only': 'Local models only: this benchmark '
        + 'measures the engine running in this server, not a remote endpoint.',
    'uplift.bench.prefill.tokens_ph': 'at least 1,024',
    'uplift.bench.prefill.summary': 'Benchmark result',
    'uplift.bench.prefill.per_request': 'Per request',
    'uplift.bench.prefill.col_start': 'Start (s)',
    'uplift.bench.prefill.col_ttft': 'TTFT (ms)',
    'uplift.bench.prefill.col_prefill': 'Prefill (tok/s)',
    'uplift.bench.prefill.col_decode': 'Decode (tok/s)',
    'uplift.bench.prefill.col_generated': 'Generated',
    'uplift.bench.prefill.col_e2e': 'Total (s)',
    'uplift.bench.prefill.sum_requests': 'Requests',
    'uplift.bench.prefill.sum_prefill': 'Combined prefill (tok/s)',
    'uplift.bench.prefill.sum_decode': 'Combined decode (tok/s)',
    'uplift.bench.prefill.sum_wall': 'Total wall time (s)',
    'uplift.bench.prefill.sum_ttft_avg': 'Average TTFT (ms)',
    'uplift.bench.prefill.sum_ttft_max': 'Slowest TTFT (ms)',
    'uplift.bench.prefill.bad_tokens': 'Prefill length must be a whole number '
        + 'of at least 1,024 tokens.',
    'uplift.bench.prefill.bad_parallel': 'Parallel requests must be a whole '
        + 'number between 1 and 256.',
    'uplift.bench.prefill.bad_stagger': 'Stagger must be a number of seconds, '
        + '0 or more.',
    'uplift.bench.prefill.bad_generation': 'Generation tokens must be a whole '
        + 'number of at least 1.',
    'uplift.bench.prefill.preparing': 'Preparing benchmark\u2026',
    'uplift.bench.prefill.panel_busy': 'The standard benchmark is running in this panel.',
    'uplift.bench.prefill.already_running': 'A custom benchmark is already running in this server.',
};

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
            textContent: '', title: '', hidden: false, placeholder: '',
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '', _attrs: {},
            setAttribute(k, v) { this._attrs[k] = String(v); },
            getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            get min() { return this._attrs.min; }, set min(v) { this._attrs.min = String(v); },
            get max() { return this._attrs.max; }, set max(v) { this._attrs.max = String(v); },
            get step() { return this._attrs.step; }, set step(v) { this._attrs.step = String(v); },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
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
            classList: (() => {
                const set = new Set();
                return { _set: set,
                    add(...c) { c.forEach(x => set.add(x)); },
                    remove(...c) { c.forEach(x => set.delete(x)); },
                    contains(c) { return set.has(c); },
                    // the real DOM honours the second (force) argument;
                    // a stub that ignores it makes every force-toggle wrong
                    toggle(c, force) {
                        const want = (force === undefined) ? !set.has(c) : !!force;
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
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    return { byId, document };
}

function allText(el) {
    let s = (el && el.textContent) || '';
    if (el && el.value) s += ' ' + el.value;
    for (const k of (el && el.children) || []) s += ' ' + allText(k);
    return s;
}
function findCls(node, cls, out = []) {
    if (node && node._classes && node._classes.has(cls)) out.push(node);
    for (const k of (node && node.children) || []) findCls(k, cls, out);
    return out;
}
function walkTag(node, tag, out = []) {
    if (node && node.tagName === tag) out.push(node);
    for (const k of (node && node.children) || []) walkTag(k, tag, out);
    return out;
}
function contains(root, node) {
    if (!root || !node) return false;
    if (root === node) return true;
    for (const k of root.children || []) if (contains(k, node)) return true;
    return false;
}

function mountLoad(opts) {
    opts = opts || {};
    const { byId, document } = makeHarness();
    const posts = [];
    const es = [];
    const toasts = [];
    const cat = Object.assign({
        'bench.heading': 'BENCHHEADING',
        'bench.config.run_button': 'BTNRUN',
        'bench.config.model': 'LBLMODEL',
        'bench.progress.cancel': 'CANCEL',
    }, EN);
    const win = {
        UpliftCore: { t: (k) => (cat[k] == null ? k : cat[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: [{ id: 'M1', model_type: 'llm' }] };
                if (u.endsWith('/bench/active')) return { running: false };
                if (u.endsWith('/bench/prefill/active'))
                    return opts.prefillActive || { running: false };
                if (u.includes('/bench/prefill/') && u.endsWith('/results'))
                    return opts.prefillResults || { status: 'running', results: [] };
                if (u.endsWith('/bench/history?surface=throughput'))
                    return { entries: [] };
                throw new Error('no net: ' + u);
            },
            postJson: async (u, body) => {
                posts.push({ url: String(u), body });
                if (String(u).endsWith('/bench/prefill/start'))
                    return { bench_id: 'pf-abc', status: 'started' };
                if (String(u).endsWith('/bench/start'))
                    return { bench_id: 'b-1', status: 'started' };
                return { status: 'cancelled' };
            },
            toast: (m, k) => toasts.push([m, k]),
            errText: (e) => String(e && e.message || e),
        },
        Uplift: { state: { API: '' } },
        document,
        requestAnimationFrame: (fn) => { fn(); return 1; },
        EventSource: function (url) {
            const s = this; this.url = url; this.closed = false;
            this.close = () => { s.closed = true; }; es.push(this);
        },
        setInterval: () => 1, clearInterval: () => {},
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8'))
        .runInContext(ctx);
    const B = win.UpliftNativeBench;
    B.mount();
    return { win, byId, B, PF: B.prefill, posts, es, toasts };
}

// ---------------------------------------------------------------------------
// painting
// ---------------------------------------------------------------------------

test('the probe block is painted inside the throughput form, through the parent', () => {
    const { byId, B } = mountLoad();
    const panel = byId['bench-subpanel'];
    const blocks = findCls(panel, 'bench-prefill');
    assert.equal(blocks.length, 1, 'exactly one probe block in the panel');
    const form = findCls(panel, 'bench-form')[0];
    assert.ok(contains(form, blocks[0]), 'the block lives INSIDE the bench form');
    const wrap = blocks[0];
    // the four asks the user wrote down, each a real number input
    const inputs = walkTag(wrap, 'input');
    const ids = inputs.map(i => i.id);
    for (const want of ['bench-tp-pf-pp', 'bench-tp-pf-parallel',
                        'bench-tp-pf-stagger', 'bench-tp-pf-tg'])
        assert.ok(ids.includes(want), 'input painted: ' + want);
    const pp = byId['bench-tp-pf-pp'];
    assert.equal(pp.type, 'number');
    assert.equal(pp.min, '1024', 'the server floor is declared on the input');
    assert.equal(pp.max, undefined,
        'NO ceiling attribute: the server has none (only the model window)');
    assert.equal(pp.value, '8192');
    const par = byId['bench-tp-pf-parallel'];
    assert.equal(par.min, '1'); assert.equal(par.max, '256');
    assert.equal(byId['bench-tp-pf-stagger'].min, '0');
    assert.equal(byId['bench-tp-pf-tg'].min, '1');
    // own run button, and the classic one is still there, untouched
    assert.equal(byId['bench-tp-pf-run'].textContent, 'Start custom benchmark');
    assert.equal(byId['bench-tp-run'].textContent, 'BTNRUN',
        'the classic Run Benchmark button is unchanged');
    // labels through the catalog, no raw keys
    const text = allText(wrap);
    for (const m of ['Advanced prefill and parallelism', 'Prefill tokens',
                     'Parallel requests', 'Stagger between starts (s)',
                     'Generation tokens'])
        assert.ok(text.includes(m), 'label rendered: ' + m);
    assert.ok(!/uplift\.bench\.prefill\./.test(allText(panel)),
        'no raw i18n key leaks to the UI');
    assert.ok(!/uplift\.bench\.prefill\./.test(allText(wrap)));
});

test('every probe label carries data-i18n + data-en (late catalog repair)', () => {
    const { byId, B } = mountLoad();
    const wrap = findCls(byId['bench-subpanel'], 'bench-prefill')[0];
    const labeled = findCls(wrap, 'bench-label');
    const keys = labeled.map(n => n.dataset.i18n).filter(Boolean);
    for (const k of ['uplift.bench.prefill.tokens', 'uplift.bench.prefill.parallel',
                     'uplift.bench.prefill.stagger', 'uplift.bench.prefill.generation',
                     'uplift.bench.prefill.section'])
        assert.ok(keys.includes(k), 're-resolvable label for ' + k);
    labeled.filter(n => n.dataset.i18n).forEach(n => {
        assert.equal(n.dataset.en, EN[n.dataset.i18n],
            n.dataset.i18n + ' fallback text must equal the catalog EN string');
    });
    assert.equal(byId['bench-tp-pf-pp'].dataset.i18nPh,
        'uplift.bench.prefill.tokens_ph');
});

// ---------------------------------------------------------------------------
// the pure collector: client bounds mirror the server's
// ---------------------------------------------------------------------------

test('pfBody: a valid form becomes exactly the server request body', () => {
    const { B } = mountLoad();
    const r = B._prefillBody({ model_id: 'M1', context_profile: 'novel_en',
        prefill_tokens: '131072', parallel: '8', stagger_seconds: '0.25',
        generation_tokens: '512' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.body, { model_id: 'M1', prefill_tokens: 131072,
        parallel: 8, stagger_seconds: 0.25, generation_tokens: 512,
        context_profile: 'novel_en' });
    // a blank stagger means simultaneous, not 'invalid'
    assert.equal(B._prefillBody({ model_id: 'M1', prefill_tokens: '1024',
        parallel: '1', stagger_seconds: '', generation_tokens: '1' })
        .body.stagger_seconds, 0);
});

test('pfBody: the client refuses what the server refuses', () => {
    const { B } = mountLoad();
    const bounds = B._prefillBounds;
    // these literals are bench_prefill.MIN_PREFILL_TOKENS / MAX_PARALLEL;
    // tests/test_bench_prefill.py pins the server side of the same numbers.
    assert.equal(bounds.MIN_TOKENS, 1024);
    assert.equal(bounds.MAX_PARALLEL, 256);
    const base = { model_id: 'M1', prefill_tokens: '8192', parallel: '4',
                   stagger_seconds: '0', generation_tokens: '32' };
    const reject = (over, key) => {
        const r = B._prefillBody(Object.assign({}, base, over));
        assert.equal(r.ok, false, 'must reject ' + JSON.stringify(over));
        assert.equal(r.key, key);
        assert.equal(r.en, EN[key], 'fallback text matches the catalog');
    };
    reject({ prefill_tokens: '1023' }, 'uplift.bench.prefill.bad_tokens');
    reject({ prefill_tokens: '8192.5' }, 'uplift.bench.prefill.bad_tokens');
    reject({ prefill_tokens: 'abc' }, 'uplift.bench.prefill.bad_tokens');
    reject({ parallel: '0' }, 'uplift.bench.prefill.bad_parallel');
    reject({ parallel: '-3' }, 'uplift.bench.prefill.bad_parallel');
    reject({ parallel: '257' }, 'uplift.bench.prefill.bad_parallel');
    reject({ stagger_seconds: '-0.5' }, 'uplift.bench.prefill.bad_stagger');
    reject({ stagger_seconds: 'soon' }, 'uplift.bench.prefill.bad_stagger');
    reject({ generation_tokens: '0' }, 'uplift.bench.prefill.bad_generation');
    reject({ model_id: '' }, 'bench.config.model_placeholder');
    // the sizes classic forbids ARE accepted here — that is the whole card
    assert.equal(B._prefillBody(Object.assign({}, base,
        { prefill_tokens: '5000', parallel: '3' })).ok, true);
    assert.equal(B._prefillBody(Object.assign({}, base,
        { prefill_tokens: '999999' })).ok, true, 'no ceiling');
});

// ---------------------------------------------------------------------------
// THE VANILLA PATH MUST NOT MOVE
// ---------------------------------------------------------------------------

test('the classic collect() payload is byte-identical (frozen)', () => {
    const { byId, B } = mountLoad();
    const TP = B.tp;
    byId['bench-tp-model'].value = 'M1';
    byId['bench-tp-profile'].value = 'code_python';
    byId['bench-tp-pp'].querySelectorAll = () => [{ value: '1024' }, { value: '4096' }];
    byId['bench-tp-bs'].querySelectorAll = () => [{ value: '2' }];
    byId['bench-tp-gen'].querySelector = () => ({ value: '128', checked: true });
    const body = TP.collect();
    assert.deepEqual(body, {
        model_id: 'M1',
        prompt_lengths: [1024, 4096],
        generation_length: 128,
        batch_sizes: [2],
        context_profile: 'code_python',
        warmup_mode: 'quick',
        align_prompt_to_ane: false,
        force_lm_engine: false,
        upload: false,
    }, 'the probe block must not add, rename or reorder a single key');
    // and the probe's own fields never leak into it
    assert.ok(!('prefill_tokens' in body) && !('parallel' in body));
});

test('the classic Run path still posts /bench/start only', async () => {
    const { byId, B, posts } = mountLoad();
    const TP = B.tp;
    byId['bench-tp-model'].value = 'M1';
    byId['bench-tp-profile'].value = 'code_python';
    byId['bench-tp-pp'].querySelectorAll = () => [{ value: '1024' }];
    byId['bench-tp-bs'].querySelectorAll = () => [];
    byId['bench-tp-gen'].querySelector = () => ({ value: '128', checked: true });
    await TP.start();
    assert.equal(posts.length, 1, 'one POST for a classic run');
    assert.equal(posts[0].url, '/uplift/api/bench/start');
    assert.equal(posts[0].body.prompt_lengths[0], 1024);
    assert.ok(!('prefill_tokens' in posts[0].body));
});

// ---------------------------------------------------------------------------
// external-endpoint mode
// ---------------------------------------------------------------------------

test('external mode disables every probe control and says why', () => {
    const { byId } = mountLoad();
    const wrap = findCls(byId['bench-subpanel'], 'bench-prefill')[0];
    const hint = byId['bench-tp-pf-hint'];
    const inputs = walkTag(wrap, 'input');
    assert.ok(inputs.every(i => i.disabled === false), 'local: all usable');
    assert.equal(hint.dataset.i18n, 'uplift.bench.prefill.hint');
    assert.ok(hint.textContent.includes('classic admin page'),
        'the limitation is stated up front, not discovered later');

    const ext = byId['bench-tp-ext'];
    ext.checked = true;
    ext.fire('change', { target: ext });       // the panel's own wiring
    assert.ok(inputs.every(i => i.disabled === true),
        'an external endpoint has no local engine to probe');
    assert.equal(byId['bench-tp-pf-run'].disabled, true, 'and no run button');
    assert.equal(hint.dataset.i18n, 'uplift.bench.prefill.local_only');
    assert.equal(hint.dataset.en, EN['uplift.bench.prefill.local_only']);
    assert.equal(hint.textContent, EN['uplift.bench.prefill.local_only']);

    ext.checked = false;
    ext.fire('change', { target: ext });
    assert.ok(inputs.every(i => i.disabled === false), 'local again: usable');
    assert.equal(byId['bench-tp-pf-run'].disabled, false);
    assert.equal(hint.dataset.i18n, 'uplift.bench.prefill.hint',
        'the hint comes back when the mode does');
    // the JS EN fallback must be BYTE-IDENTICAL to the catalog value — the
    // concatenated hint is exactly the string test_locale_sync can never see
    assert.equal(hint.dataset.en, EN['uplift.bench.prefill.hint']);
    assert.equal(hint.textContent, EN['uplift.bench.prefill.hint']);
});

test('a probe start against an unselected model never reaches the server', async () => {
    const { byId, B, posts, toasts } = mountLoad();
    byId['bench-tp-model'].value = '';
    await B.prefill.start();
    assert.equal(posts.length, 0, 'no POST without a model');
    assert.equal(toasts.length, 1);
    assert.equal(B.prefill.state.running, false);
});

// ---------------------------------------------------------------------------
// run / stream / render
// ---------------------------------------------------------------------------

test('the probe posts its own endpoint and drives the panel status box', async () => {
    const { byId, B, posts, es } = mountLoad();
    const PF = B.prefill;
    byId['bench-tp-model'].value = 'M1';
    byId['bench-tp-profile'].value = 'code_python';
    byId['bench-tp-pf-pp'].value = '32768';
    byId['bench-tp-pf-parallel'].value = '6';
    byId['bench-tp-pf-stagger'].value = '0.5';
    byId['bench-tp-pf-tg'].value = '256';
    await PF.start();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/uplift/api/bench/prefill/start');
    assert.deepEqual(posts[0].body, { model_id: 'M1', prefill_tokens: 32768,
        parallel: 6, stagger_seconds: 0.5, generation_tokens: 256,
        context_profile: 'code_python' });
    assert.equal(PF.state.running, true);
    assert.equal(PF.state.runId, 'pf-abc');
    assert.equal(es.length, 1, 'one stream attached');
    assert.equal(es[0].url, '/uplift/api/bench/prefill/pf-abc/stream');
    const bar = byId['bench-tp-status-bar-ascii'];
    assert.ok(bar.textContent.includes('0%'), 'the shared bar was reset');
    assert.equal(byId['bench-tp-status'].textContent, EN['uplift.bench.prefill.preparing']);
    assert.equal(byId['bench-tp-pf-cancel'].hidden, false);
    // while it runs the block is inert AND the classic run button is dead
    assert.equal(byId['bench-tp-pf-pp'].disabled, true);
    assert.equal(byId['bench-tp-run'].disabled, true,
        'no second run on the same engine from this panel');
});

test('the panel keeps exactly ONE progress affordance', () => {
    const { byId } = mountLoad();
    const bars = [];
    (function walk(n) {
        if (n && n._attrs && n._attrs.role === 'progressbar') bars.push(n);
        for (const k of (n && n.children) || []) walk(k);
    })(byId['bench-native']);
    assert.equal(bars.length, 1,
        'the probe reuses bench-tp-status instead of adding a bar: '
        + bars.map(b => b.id).join(','));
    assert.equal(bars[0].id, 'bench-tp-status-bar-ascii');
});

function feed(es, ev) { es[es.length - 1].onmessage({ data: JSON.stringify(ev) }); }

test('SSE events paint the aggregate first, then one row per request', async () => {
    const { byId, B, es } = mountLoad();
    const PF = B.prefill;
    byId['bench-tp-model'].value = 'M1';
    await PF.start();
    feed(es, { type: 'progress', phase: 'probe', message: 'Loading M1...',
               current: 0, total: 3 });
    assert.ok(byId['bench-tp-status'].textContent.includes('Loading M1'));
    // SUBMIT events keep the status box alive while long prefills run
    // (user fix 1: 'nothing seems to happen until the first request prefills')
    feed(es, { type: 'progress', phase: 'probe', total: 3, current: 0,
               message: 'Request 1/3 submitted (+0.0s)' });
    assert.ok(byId['bench-tp-status'].textContent.includes('submitted'),
        'the wave visibly ENTERS the engine request by request');
    feed(es, { type: 'progress', phase: 'probe', total: 3, current: 0,
               message: 'Request 2/3 submitted (+1.0s)' });
    feed(es, { type: 'result', data: { index: 0, start_offset_s: 0.0,
        submit_s: 1.25,
        ttft_ms: 1200.5, processing_tps: 2200.1, gen_tps: 41.2,
        completion_tokens: 256, prompt_tokens: 32768, e2e_latency_s: 17.5 } });
    feed(es, { type: 'result', data: { index: 1, start_offset_s: 0.5,
        ttft_ms: 1900.4, processing_tps: 1800.0, gen_tps: null,
        completion_tokens: 4, prompt_tokens: 32768, e2e_latency_s: 18.5 } });
    // replay-after-reconnect: the same index must not double the row
    feed(es, { type: 'result', data: { index: 0, start_offset_s: 0.0,
        submit_s: 1.25,
        ttft_ms: 1200.5, processing_tps: 2200.1, gen_tps: 41.2,
        completion_tokens: 256, prompt_tokens: 32768, e2e_latency_s: 17.5 } });
    assert.equal(PF.state.rows.length, 2, 'idempotent by index');
    feed(es, { type: 'aggregate', data: { requests: 2, prompt_tokens_each: 32768,
        total_prompt_tokens: 65536, total_completion_tokens: 260,
        wall_time_s: 20.25, prefill_wall_s: 2.4, generation_wall_s: 17.85,
        combined_prefill_tps: 27306.7, combined_decode_tps: 14.6,
        avg_ttft_ms: 1550.4, max_ttft_ms: 1900.3, min_ttft_ms: 1200.5 } });
    feed(es, { type: 'done', bench_id: 'pf-abc' });

    const host = byId['bench-tp-pf-results'];
    const text = allText(host);
    for (const m of ['Benchmark result', 'Per request', 'Combined prefill (tok/s)',
                     'Slowest TTFT (ms)', '27306.7', '20.250', '1550.4',
                     '1200.5', '1900.3'])
        assert.ok(text.includes(m), 'rendered: ' + m + ' — got ' + text);
    // an unmeasured decode rate stays N/A (classic's rule, not a fake 0.0)
    assert.ok(text.includes('N/A'), 'null gen_tps renders N/A');
    const tables = walkTag(host, 'table');
    assert.equal(tables.length, 1, 'one per-request table');
    const heads = tables[0].children[0].children.map(th => th.textContent);
    assert.deepEqual(heads, ['#', 'Start (s)', 'TTFT (ms)', 'Prefill (tok/s)',
                             'Decode (tok/s)', 'Generated', 'Total (s)']);
    // Start (s) prints the REAL submit offset (1.25), not the scheduled one
    // (0.00); a row without submit_s falls back to start_offset_s (0.50)
    const startCells = tables[0].children.slice(1)
        .map(tr => tr.children[1].textContent);
    assert.ok(startCells.includes('1.25'), 'submit_s leads: ' + startCells);
    assert.ok(startCells.includes('0.50'), 'fallback to start_offset_s');
    // headers carry the catalog datasets so a late locale repaints them
    tables[0].children[0].children.slice(1).forEach(th => {
        assert.ok(String(th.dataset.i18n).startsWith('uplift.bench.prefill.'),
            'th carries data-i18n: ' + th.textContent);
    });
    const rows = tables[0].children.slice(1).map(tr => tr.children.map(td => td.textContent));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].slice(0, 3), ['1', '1.25', '1200.5'],
        'Start (s) prints the REAL submit, not the scheduled slot');
    assert.deepEqual(rows[1].slice(0, 3), ['2', '0.50', '1900.4'],
        'a row without submit_s still shows its stagger slot');
    // the run is over: controls live again, the classic button too
    assert.equal(PF.state.running, false);
    assert.equal(byId['bench-tp-run'].disabled, false);
    assert.equal(byId['bench-tp-pf-cancel'].hidden, true);
    assert.ok(es[es.length - 1].closed, 'stream closed at the terminal event');
    assert.ok(byId['bench-tp-status'].textContent.includes('finished'));
});

test('an error event is a red status line, not a silent table', async () => {
    const { byId, B, es } = mountLoad();
    const PF = B.prefill;
    byId['bench-tp-model'].value = 'M1';
    await PF.start();
    feed(es, { type: 'error', message: 'the engine prefilled 512 tokens' });
    assert.equal(PF.state.running, false);
    assert.equal(PF.state.error, true);
    assert.equal(byId['bench-tp-status'].classList.contains('bench-status-error'), true);
    assert.ok(byId['bench-tp-status'].textContent.includes('512'));
    assert.equal(byId['bench-tp-pf-pp'].disabled, false, 'editable again');
    assert.ok(es[es.length - 1].closed);
});

test('a panel re-render while a probe runs repaints it as busy', async () => {
    const { byId, B } = mountLoad();
    const PF = B.prefill;
    byId['bench-tp-model'].value = 'M1';
    await PF.start();
    assert.equal(PF.state.running, true);
    // subtab switch / hash re-entry repaints the whole TP panel from scratch
    PF.tp.state = { running: false, results: [], total: 0, current: 0,
                    phase: '', benchId: null, ctx: {} };
    PF.tp.render(byId['bench-subpanel']);
    const wrap = findCls(byId['bench-subpanel'], 'bench-prefill')
        .slice(-1)[0];
    assert.ok(contains(byId['bench-subpanel'], wrap), 'block repainted');
    assert.ok(walkTag(wrap, 'input').every(i => i.disabled === true),
        'the rebuilt inputs know a probe is live');
    assert.equal(byId['bench-tp-pf-run'].disabled, true, 'no double start');
    assert.equal(byId['bench-tp-pf-cancel'].hidden, false, 'Cancel offered');
    PF.finish();     // settle so later tests in this file start clean
});

test('cancel posts to the probe route, never to the classic one', async () => {
    const { byId, B, posts } = mountLoad();
    const PF = B.prefill;
    byId['bench-tp-model'].value = 'M1';
    await PF.start();
    posts.length = 0;
    await PF.cancel();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/uplift/api/bench/prefill/pf-abc/cancel');
});

test('a reload reattaches to a probe that is already running', async () => {
    const { byId, B, es } = mountLoad({ prefillActive: {
        running: true, bench_id: 'pf-zz', model_id: 'M1', parallel: 4,
        prefill_tokens: 1024, stagger_seconds: 0.1, generation_tokens: 32 } });
    // mount() already ran TP.render -> PF.discover(); one tick lets it land
    await new Promise(r => setTimeout(r, 0));
    assert.equal(B.prefill.state.running, true, 'panel shows the live probe');
    assert.equal(B.prefill.state.total, 4);
    assert.equal(es.length, 1);
    assert.equal(es[0].url, '/uplift/api/bench/prefill/pf-zz/stream');
    assert.ok(byId['bench-tp-status'].textContent.includes('already running'));
    assert.ok(byId['bench-tp-status'].textContent.includes('M1'));
    B.prefill.state.running = false;
});
