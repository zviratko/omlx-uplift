/* BENCHQ: the global bench queue box (frontend half of the server-side
   bench queue). Same harness pattern as repl1-bench-mount / u49-panels-rollout
   (fe1-patches-render doctrine): vm sandbox + DOM stub, module loaded from
   the real static file, no server, no browser. The stub here additionally
   CAPTURES event handlers (the mount stub drops them, and the × button IS
   the contract), tracks classes (grid state), and fakes offsetParent so the
   'poll only while visible' doctrine is provable.

   Pinned:
   - mount() restructures the host into .bench-cols = [strip+panel column,
     queue box]; the box is hidden and the grid single-column while the
     queue is empty, i.e. today's markup is effectively unchanged
   - a queue payload renders one row per entry: kind badge (the subtab's own
     label), model id, task/pack names, status (Running / Queued <position>
     / Failed with the error in title), and the grid gains .has-q
   - × issues DELETE /bench/queue/<qid> for THAT qid, then re-reads
   - a POST that answers {queued:true} toasts + refreshes the box and does
     NOT enter running state nor open an EventSource
   - DEC/MTEB keep Run enabled while a run is live (a second click queues)
   - the 4s timer exists and issues zero requests while the tab is hidden
   - a queued->running transition hands the run back to the visible panel
   - the CSS grid contract (1 column, 250px with .has-q, 1100px breakpoint) */
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
            offsetParent: {},        // non-null = 'on screen' (poll gate)
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '', _attrs: {},
            setAttribute(k, v) { this._attrs[k] = String(v); },
            getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            // handlers are KEPT (the mount stub drops them): × / Run clicks
            addEventListener(t, fn) { (this._ev = this._ev || {})[t] = fn; },
            removeEventListener() {},
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {},
            // real class tracking, force-aware (BENCHQ toggles has-q)
            classList: (() => {
                const set = new Set();
                return { _set: set,
                    add(...c) { c.forEach(x => set.add(x)); },
                    remove(...c) { c.forEach(x => set.delete(x)); },
                    contains(c) { return set.has(c); },
                    toggle(c, force) {
                        const on = force === undefined ? !set.has(c) : !!force;
                        if (on) set.add(c); else set.delete(c);
                        return on;
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
    return { byId, document, makeEl };
}

const CAT = {   // fake merged catalog: classic + uplift keys, one marker lang
    'navbar.dropdown.performance': 'SUBTP',
    'navbar.dropdown.accuracy': 'SUBACC',
    'navbar.dropdown.context': 'SUBCTX',
    'uplift.bench.ane_tune': 'SUBANE',
    'uplift.bench.embeddings': 'SUBEMB',
    'uplift.bench.rerankers': 'SUBRRK',
    'uplift.bench.decision': 'SUBDEC',
    'uplift.bench.decision_desc': 'DECDESC',
    'uplift.bench.embed_desc': 'EMBDESC',
    'bench.config.model': 'LBLMODEL',
    'bench.config.run_button': 'BTNRUN',
    'bench.progress.cancel': 'BTNCANCEL',
    'bench.config.model_placeholder': 'PHMODEL',
    'acc_bench.config.benchmarks': 'GRIDCAP',
    'uplift.bench.sample_limit': 'LIMIT',
    'acc_bench.results.clear': 'CLEAR',
    // BENCHQ's own keys (new: exactly these four) + the two reused ones
    'uplift.bench.queued': 'TOASTQUEUED',
    'uplift.bench.queue_title': 'QHEAD',
    'uplift.bench.queue_running': 'QRUN',
    'uplift.bench.queue_queued': 'QQ',
    'uplift.bench.queue_failed': 'QFAIL',
    'models.queue.remove_tooltip': 'QRM',
};

const EMPTY = { entries: [], idle: true };

/* opts.queue   what GET /bench/queue answers (default: empty)
   opts.postReply  what a POST start route answers                  */
function load(opts) {
    opts = opts || {};
    const { byId, document } = makeHarness();
    const net = { get: [], post: [], del: [], toasts: [], es: [], ticks: [], ms: [] };
    const fixture = { queue: opts.queue || EMPTY };
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                net.get.push(u);
                if (u.endsWith('/models'))
                    return { models: [{ id: 'm1', engine_type: 'decision' },
                                      { id: 'e1', engine_type: 'embedding' }] };
                if (u.endsWith('/bench/decision/tasks'))
                    return { tasks: { a: { kind: 'decision', items: 10,
                                           license: 'CC', source: 's' } } };
                if (u.endsWith('/bench/embed/tasks'))
                    return { env: 'ready', tasks: {
                        T1: { kind: 'embed', group: 'sts', sizes: 10, cs: false } } };
                if (u.endsWith('/bench/queue'))
                    return JSON.parse(JSON.stringify(fixture.queue));
                if (u.endsWith('/results') || u.endsWith('/active'))
                    return { results: [], running: false };
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, body) => {
                net.post.push([String(u), body]);
                return opts.postReply ? opts.postReply(String(u)) : {};
            },
            deleteJson: async (u) => { net.del.push(String(u)); return { ok: true }; },
            toast: (msg, kind) => { net.toasts.push([msg, kind]); },
        },
        Uplift: { state: { API: '' } },
        document,
        requestAnimationFrame: () => {},
        EventSource: function (url) { net.es.push(String(url)); this.close = () => {}; },
        setInterval: (fn, ms) => { net.ticks.push(fn); net.ms.push(ms); return 1; },
        clearInterval: () => {},
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8')).runInContext(ctx);
    const B = win.UpliftNativeBench;
    return { win, byId, net, fixture, B, BQ: B.BENCHQ };
}

const settle = (ms) => new Promise(r => setTimeout(r, ms || 5));
function allText(el) {
    let s = el.textContent || '';
    for (const k of el.children || []) s += ' ' + allText(k);
    return s;
}
function findByClass(el, cls, out) {
    out = out || [];
    if (el && el._classes && el._classes.has(cls)) out.push(el);
    for (const k of (el && el.children) || []) findByClass(k, cls, out);
    return out;
}
function sub(el, cls) {
    const found = findByClass(el, cls);
    return found[0] || null;
}
// a row's OWN status span (depth-first would be fine here, the row is flat)
function rowStatus(row) { return sub(row, 'bench-queue-status'); }
function rows(BQ) { return findByClass(BQ.box, 'bench-queue-item'); }

const PAYLOAD = {
    idle: false,
    entries: [
        { qid: 'q-acc', kind: 'accuracy', status: 'running', run_id: 'r0',
          queued_at: 1, body: { model_id: 'm0', benchmarks: { mmlu: 30 } } },
        { qid: 'q-dec', kind: 'decision', status: 'queued', queued_at: 2,
          position: 1, body: { model_id: 'm1', packs: ['a'] } },
    ],
};

// ---- (1) mount: the grid + the hidden box ---------------------------------

test('BENCHQ mount: .bench-cols wraps strip+panel and carries a hidden queue box', () => {
    const { byId, B, BQ } = load();
    B.mount();
    const host = byId['bench-native'];
    assert.equal(host.children.length, 1, 'host has exactly the grid child');
    const cols = host.children[0];
    assert.ok(cols._classes.has('bench-cols'), 'grid wrapper mounted');
    assert.ok(!cols._classes.has('has-q'), 'no second column while the queue is empty');
    assert.equal(cols.children.length, 2, 'main column + queue column');
    const main = cols.children[0];
    assert.ok(main._classes.has('bench-col-main'), 'strip+panel column');
    assert.equal(main.children.length, 2, 'strip + panel inside it, same order');
    assert.ok(main.children[0]._classes.has('native-subtabs'), 'strip first');
    assert.equal(main.children[1].id, 'bench-subpanel', 'panel keeps its id');
    const box = cols.children[1];
    assert.ok(box._classes.has('bench-queue'), 'queue box is the sibling column');
    assert.equal(box.hidden, true, 'queue box hidden while empty');
    assert.equal(byId['bench-queue'], box, 'box is reachable by id');
    // the queue-empty path renders no rows: the box's own [hidden] rule is
    // display:none (pinned in the CSS test below), so the tab is pixel-
    // identical to the pre-BENCHQ markup
    assert.equal(BQ.list.children.length, 0, 'no queue rows while empty');
    assert.equal(findByClass(box, 'bench-queue-item').length, 0);
    // and the rest of the mount contract is untouched
    assert.ok(B.isMounted(), 'isMounted flips after mount');
    assert.ok(allText(main).includes('SUBTP'), 'panel painted inside the column');
});

// ---- (2) payload -> rows ---------------------------------------------------

test('BENCHQ render: one row per entry, kind badge + model + packs + status', async () => {
    const { B, BQ } = load({ queue: PAYLOAD });
    B.mount();
    await settle();                       // mount's first read paints the box
    const cols = BQ.cols;
    assert.ok(cols._classes.has('has-q'), 'grid gains the 250px queue column');
    assert.equal(BQ.box.hidden, false, 'box visible with entries');
    const r = rows(BQ);
    assert.equal(r.length, 2, 'one row per queue entry');
    assert.deepEqual(r.map(x => x.dataset.qid).sort(), ['q-acc', 'q-dec']);
    const acc = r.filter(x => x.dataset.qid === 'q-acc')[0];
    const dec = r.filter(x => x.dataset.qid === 'q-dec')[0];
    // status text: Running, and Queued + its position number
    assert.ok(allText(acc).includes('QRUN'), 'running status via the key');
    assert.equal(rowStatus(dec).textContent, 'QQ 1', 'queued + position');
    // kind badge = the subtab's own label (no new vocabulary)
    assert.ok(sub(acc, 'bench-queue-kind').textContent === 'SUBACC',
        'accuracy badge = the subtab label');
    assert.equal(sub(acc, 'bench-queue-kind').dataset.i18n, 'navbar.dropdown.accuracy',
        'badge carries its key (U59: a late catalog repairs it)');
    assert.equal(sub(BQ.box, 'bench-queue-head').dataset.i18n,
        'uplift.bench.queue_title', 'header carries its key');
    assert.equal(sub(BQ.box, 'acc-queue-remove').dataset.i18nTitle,
        'models.queue.remove_tooltip', 'tooltip carries its key');
    assert.equal(sub(dec, 'bench-queue-kind').textContent, 'SUBDEC',
        'decision badge is the Decision subtab label');
    // model id + task/pack names
    assert.ok(allText(dec).includes('m1'), 'model id shown');
    assert.equal(sub(dec, 'bench-queue-detail').textContent, 'a', 'pack name shown');
    assert.ok(allText(acc).includes('mmlu'), 'benchmark keys shown');
    // header renders, and no raw i18n key ever reaches the UI
    assert.ok(allText(BQ.box).trim().startsWith('QHEAD'), 'header above the rows');
    assert.ok(!allText(BQ.box).includes('uplift.bench.queue'), 'no raw key leaks');
    assert.ok(!allText(BQ.box).includes('models.queue.remove_tooltip'));
    // state class mirrors the status (the box colours the running row)
    assert.ok(acc._classes.has('running') && dec._classes.has('queued'),
        'row carries its status class');
});

test('BENCHQ render: a failed entry puts the error in the title attribute', () => {
    const { B, BQ } = load({ queue: { entries: [{ qid: 'q-x', kind: 'embed',
        status: 'failed', error: 'env build died', body: { model_id: 'm2' } }] } });
    B.mount();
    BQ.render({ entries: [{ qid: 'q-x', kind: 'embed', status: 'failed',
                            error: 'env build died', body: { model_id: 'm2' } }] });
    const row = rows(BQ)[0];
    assert.ok(row._classes.has('failed'), 'failed state class');
    assert.ok(allText(row).includes('QFAIL'), 'failed status via the key');
    assert.equal(rowStatus(row).title, 'env build died',
        'the error is a tooltip, not a wall of text');
    // and an emptying queue closes the column again
    BQ.render({ entries: [] });
    assert.equal(BQ.box.hidden, true, 'box hides when the queue drains');
    assert.ok(!BQ.cols._classes.has('has-q'), 'single column again');
});

test('BENCHQ render: an entry with only a label still reads (liberal shape)', () => {
    const { B, BQ } = load();
    B.mount();
    BQ.render({ entries: [{ qid: 'q9', kind: 'throughput', status: 'queued',
                            label: 'm9 — Throughput', body: { model_id: 'm9' } }] });
    const row = rows(BQ)[0];
    assert.equal(allText(row).trim().indexOf('m9 — Throughput') >= 0, true,
        'label string wins over composing from the body');
    assert.equal(rowStatus(row).textContent, 'QQ 1', 'position numbered');
    assert.equal(sub(row, 'bench-queue-kind').textContent, 'SUBTP',
        'unknown-body kinds still badge through the subtab label');
});

test('BENCHQ render: an unchanged queue repaints in place (hover + click survive)', () => {
    const { B, BQ } = load();
    B.mount();
    BQ.render(PAYLOAD);
    const before = rows(BQ);
    assert.equal(before.length, 2);
    const later = {
        entries: [
            Object.assign({}, PAYLOAD.entries[0]),
            Object.assign({}, PAYLOAD.entries[1], { status: 'running' }),
        ],
    };
    BQ.render(later);                     // same qids, same order
    const after = rows(BQ);
    assert.equal(after[0], before[0], 'row nodes are REUSED, not replaced');
    assert.equal(after[1], before[1]);
    assert.equal(rowStatus(after[1]).textContent, 'QRUN', 'its text did change');
    assert.ok(after[1]._classes.has('running') && !after[1]._classes.has('queued'),
        'state classes follow the status');
    // a different queue (added/removed entry) may rebuild the list
    BQ.render({ entries: [PAYLOAD.entries[1]] });
    assert.equal(rows(BQ).length, 1, 'a changed queue re-renders the rows');
});

// ---- (3) remove ------------------------------------------------------------

test('BENCHQ remove: × deletes that qid and re-reads the queue', async () => {
    const { net, B, BQ } = load({ queue: PAYLOAD });
    B.mount();
    await settle();
    const dec = rows(BQ).filter(r => r.dataset.qid === 'q-dec')[0];
    const rm = sub(dec, 'acc-queue-remove');
    assert.ok(rm, 'remove button reuses the accuracy queue class');
    assert.equal(rm.title, 'QRM', 'tooltip through the existing models key');
    const getsBefore = net.get.length;
    await rm._ev.click();
    await settle();
    assert.deepEqual(net.del, ['/uplift/api/bench/queue/q-dec'],
        'DELETE carries exactly that qid, nothing else');
    assert.ok(net.get.slice(getsBefore).some(u => u.endsWith('/bench/queue')),
        'the box re-reads the queue after the delete');
});

// ---- (4) panel start: queued=true must not fake a live run ----------------

test('DEC.start with queued=true: no running state, no EventSource, box refreshed', async () => {
    const { byId, net, B, BQ } = load({
        postReply: () => ({ queued: true, qid: 'q-new', position: 3 }),
    });
    B.mount();
    B.showSub('decision');
    await settle();
    const DEC = B._panels.dec;
    byId['bench-dec-model'].value = 'm1';
    DEC.state.selected = { a: true };
    const getsBefore = net.get.length;
    await DEC.start();
    await settle();
    assert.equal(DEC.state.running, false, 'queued is NOT running');
    assert.equal(DEC.state.runId, null, 'no run id claimed');
    assert.equal(net.es.length, 0, 'no EventSource attached to a queued entry');
    assert.ok(net.toasts.some(x => x[0] === 'TOASTQUEUED'),
        'toast reuses the existing uplift.bench.queued key');
    assert.ok(net.get.slice(getsBefore).some(u => u.endsWith('/bench/queue')),
        'BENCHQ refreshed right after the POST');
    assert.equal(byId['bench-dec-cancel'].hidden, true, 'cancel stays hidden');
    assert.deepEqual(net.post[0][0], '/uplift/api/bench/decision/start');
});

test('DEC.start with a live run still attaches the stream (behaviour unchanged)', async () => {
    const { byId, net, B } = load({ postReply: () => ({ run_id: 'r-1' }) });
    B.mount();
    B.showSub('decision');
    await settle();
    const DEC = B._panels.dec;
    byId['bench-dec-model'].value = 'm1';
    DEC.state.selected = { a: true };
    await DEC.start();
    await settle();
    assert.equal(DEC.state.running, true, 'the non-queued path is untouched');
    assert.deepEqual(net.es, ['/uplift/api/bench/decision/r-1/stream'],
        'EventSource opens for a run that actually started');
    assert.ok(!net.toasts.some(x => x[0] === 'TOASTQUEUED'), 'no false toast');
});

test('DEC + MTEB keep Run enabled while a run is live (a second click queues)', async () => {
    const { byId, B } = load({ postReply: () => ({ queued: true, qid: 'q', position: 2 }) });
    B.mount();
    B.showSub('decision');
    await settle();
    const DEC = B._panels.dec;
    DEC.state.running = true;
    DEC.setButtons();
    assert.equal(byId['bench-dec-run'].disabled, false,
        'DEC Run stays clickable so the next model/pack queues behind');
    assert.equal(byId['bench-dec-cancel'].hidden, false, 'Cancel still tracks running');
    B.showSub('embed');
    await settle();
    const EMB = B._panels.mteb('embed');
    EMB.state.running = true;
    EMB.setButtons();
    assert.equal(byId['bench-embed-run'].disabled, false, 'same for Embeddings');
    assert.equal(byId['bench-embed-cancel'].hidden, false, 'Cancel still tracks running');
});

test('TP + CTX + MTEB queued=true: no running state, no stream, box refreshed', async () => {
    const { byId, net, B } = load({
        postReply: () => ({ queued: true, qid: 'q-x', position: 2 }),
    });
    B.mount();                       // throughput is the default sub
    await settle();
    let getsBefore = net.get.length;
    byId['bench-tp-model'].value = 'm1';
    byId['bench-tp-pp'].querySelectorAll = () => [{ value: '1024' }];
    await B.tp.start();
    await settle();
    assert.equal(B.tp.state.running, false, 'TP queued is not running');
    assert.equal(B.tp.state.benchId, null, 'TP claims no bench id');
    assert.equal(net.es.length, 0, 'TP opened no EventSource');
    assert.ok(net.get.slice(getsBefore).some(u => u.endsWith('/bench/queue')),
        'TP refreshed the box');
    // --- context
    B.showSub('context');
    await settle();
    byId['bench-ctx-model'].value = 'm1';
    byId['bench-ctx-target'].value = '32768';
    getsBefore = net.get.length;
    await B._panels.ctx.start();
    await settle();
    assert.equal(B._panels.ctx.state.running, false, 'CTX queued is not running');
    assert.equal(B._panels.ctx.state.benchId, null, 'CTX claims no bench id');
    assert.equal(net.es.length, 0, 'CTX opened no EventSource');
    assert.ok(net.get.slice(getsBefore).some(u => u.endsWith('/bench/queue')),
        'CTX refreshed the box');
    // --- embeddings (shared MTEB factory instance)
    B.showSub('embed');
    await settle();
    const EMB = B._panels.mteb('embed');
    byId['bench-embed-model'].value = 'e1';
    EMB.state.selected = { T1: true };
    getsBefore = net.get.length;
    await EMB.start();
    await settle();
    assert.equal(EMB.state.running, false, 'MTEB queued is not running');
    assert.equal(EMB.state.runId, null, 'MTEB claims no run id');
    assert.equal(net.es.length, 0, 'MTEB opened no EventSource');
    assert.ok(net.get.slice(getsBefore).some(u => u.endsWith('/bench/queue')),
        'MTEB refreshed the box');
    assert.equal(net.toasts.filter(x => x[0] === 'TOASTQUEUED').length, 3,
        'one reused toast per queued click');
});

// ---- (5) the poll: exists, 4s cadence, silent while the tab is hidden -----

test('BENCHQ poll: one interval from mount, zero requests while off-screen', async () => {
    const { byId, net, B } = load({ queue: PAYLOAD });
    B.mount();
    assert.equal(net.ticks.length, 1, 'mount started exactly one timer');
    assert.equal(net.ms[0], 4000, 'the queue poll runs every 4000ms');
    assert.ok(net.get.some(u => u.endsWith('/bench/queue')),
        'the first paint reads the queue without waiting');
    const tick = net.ticks[0];
    byId['bench-native'].offsetParent = null;      // bench tab is not shown
    const before = net.get.length;
    tick(); tick(); tick();
    await settle();
    assert.equal(net.get.length, before, 'hidden surface issues zero requests');
    byId['bench-native'].offsetParent = {};        // back on screen
    tick();
    await settle();
    assert.equal(net.get.length, before + 1, 'visible surface polls for truth');
    assert.equal(rows(B.BENCHQ).length, 2, 'and the box keeps its rows');
});

// ---- (6) running hand-back ------------------------------------------------

test('BENCHQ hand-back: queued->running re-discovers the matching visible panel', () => {
    const { B, BQ } = load();
    B.mount();
    B.showSub('decision');
    const DEC = B._panels.dec;
    let calls = 0;
    DEC.discover = async () => { calls++; };
    const one = (status) => ({ entries: [{ qid: 'q1', kind: 'decision', status,
                                           body: { model_id: 'm1', packs: ['a'] } }] });
    BQ.render(one('queued'));
    assert.equal(calls, 0, 'a queued entry does not touch the panel');
    BQ.render(one('running'));
    assert.equal(calls, 1, 'the transition attaches the panel to a run it did not start');
    BQ.render(one('running'));
    assert.equal(calls, 1, 'idempotent while the status holds');
    // a run of ANOTHER kind stays in the box only
    BQ.render({ entries: [] });
    BQ.render({ entries: [{ qid: 'q2', kind: 'embed', status: 'queued', body: {} }] });
    BQ.render({ entries: [{ qid: 'q2', kind: 'embed', status: 'running', body: {} }] });
    assert.equal(calls, 1, 'wrong kind never disturbs the visible panel');
});

// ---- CSS contract the box depends on -------------------------------------

test('BENCHQ css: one column by default, 250px with has-q, sticky box', () => {
    const css = fs.readFileSync(`${STATIC_DIR}/uplift.css`, 'utf8');
    const cols = css.match(/\.bench-cols \{[^}]*\}/);
    assert.ok(cols, '.bench-cols exists');
    assert.match(cols[0], /display:\s*grid/);
    assert.match(cols[0], /grid-template-columns:\s*1fr/);
    assert.match(cols[0], /gap:\s*12px/);
    assert.match(cols[0], /align-items:\s*start/);
    assert.match(css, /\.bench-cols\.has-q \{[^}]*250px/,
        'the queue column is 250px and only with entries');
    assert.match(css, /@media \(max-width: 1100px\) \{ \.bench-cols\.has-q[^}]*\}/,
        'narrow viewports stay single column');
    const box = css.match(/\.bench-queue \{[^}]*\}/);
    assert.ok(box, '.bench-queue exists');
    assert.match(box[0], /position:\s*sticky/);
    assert.match(box[0], /top:/);
    assert.match(box[0], /border: 1px solid var\(--edge\)/, 'panel-card border language');
    assert.match(css, /\.bench-queue\[hidden\] \{ display: none; \}/,
        'display:flex would otherwise beat the hidden attribute (documented trap)');
});
