/* U83: accuracy queue board — the user reported, with 3 suites selected
   (MMLU classic, MMLU lm-eval, HumanEval classic):
     'Evaluating mmlu (28/300)... [0/2 suites · 28/300 q]'
   — 0 for a RUNNING suite (per-request 0-based counting), the q pair
   duplicating the suite counter instead of the queue total, and queued
   suites as invisible text lines. The board answers across BOTH engine
   queue entries (a mixed pick posts two; classic counts each alone — the
   user counts 3 benchmarks). Pure model + ACC event replay, no DOM. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function harness() {
    const byId = {};
    function makeEl(tag) {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            className: '', textContent: '', title: '', hidden: false,
            _id: '',
            get id() { return el._id; },
            set id(v) { el._id = v; if (v) byId[v] = el; },
            replaceChildren(...kids) { el.children = kids; },
            append(...kids) { el.children.push(...kids); },
            appendChild(k) { el.children.push(k); return k; },
            addEventListener() {}, removeEventListener() {},
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {}, setAttribute() {},
            getAttribute() { return null; },
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        };
        return el;
    }
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { return makeEl(tag); },
        createTextNode(s) { return { textContent: String(s) }; },
        querySelectorAll() { return []; },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    return { byId, document };
}
const GROUPS = [{
    group: 'g', tasks: [
        { key: 'mmlu', label: 'MMLU', full_size: 14042, sizes: [10, 50, 100, 300] },
        { key: 'humaneval', label: 'HumanEval', full_size: 164, sizes: [10, 50, 100, 300] },
    ],
}];
const HSIZE = { mmlu: 57 };    // harness --limit applies PER SUBTASK (U68)

function load() {
    const { byId, document } = harness();
    const win = {
        UpliftCore: { t: k => k },
        UpliftDom: { fetchJson: async () => { throw new Error('no net'); },
                     postJson: async () => {}, toast: () => {} },
        Uplift: { state: { API: '' } },
        document, requestAnimationFrame: () => {}, EventSource: undefined,
        location: { hash: '#bench/accuracy', pathname: '/uplift/', search: '' },
        history: { replaceState() {} },
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8')).runInContext(ctx);
    return { win, byId, B: win.UpliftNativeBench };
}

test('U83 board model: mixed pick = 3 suites across 2 queue entries', () => {
    const { B } = load();
    const st = {
        running: true, phase: 'evaluating', current_model: 'BigModel',
        current_bench_id: 'b1',
        running_entry: { model_id: 'BigModel', engine: 'classic',
                         sizes: { mmlu: 300, humaneval: 300 }, external: false },
        queue: [{ model_id: 'BigModel', engine: 'harness',
                  sizes: { mmlu: 300 }, external: false }],
    };
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true,
                  queue: st.queue, board: [] };
    ACC.syncBoard(st);
    const boxes = B._board.boardSuiteBoxes(ACC.state.board);
    assert.equal(boxes.length, 3, 'MMLU-c, HumanEval-c, MMLU-h all tracked');
    const c = B._board.boardCounters(ACC.state.board);
    assert.equal(c.total, 3);
    assert.equal(c.cur, 1, 'running suite is 1-based — never 0');
    // 300 + 300 + 300x57 harness math
    assert.equal(c.qTotal, 300 + 300 + 300 * 57);
    assert.equal(c.qDone, 0);
});

test('U83 event replay: the user\'s exact line reads [1/3 · 28/17700 q]', () => {
    const { B } = load();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true,
                  queue: [], board: [] };
    ACC.syncBoard({
        running: true, phase: 'evaluating', current_model: 'BigModel',
        current_bench_id: 'b1',
        running_entry: { model_id: 'BigModel', engine: 'classic',
                         sizes: { mmlu: 300, humaneval: 300 }, external: false },
        queue: [],
    });
    ACC.boardEvent({ type: 'progress', phase: 'eval', benchmark: 'mmlu',
                     current: 0, total: 2, bench_current: 28, bench_total: 300 });
    const txt = ACC.statusCounterText({ current: 0, total: 2 });
    assert.ok(/\[1\/2 suites/.test(txt), 'running suite = 1: ' + txt);
    assert.ok(/28\/600 q\]/.test(txt), 'q pair = done over queue total: ' + txt);
    // suite finished -> next suite counts 2/2, questions bank 300+
    ACC.boardEvent({ type: 'result', data: { benchmark: 'mmlu', total: 300 } });
    const c = B._board.boardCounters(ACC.state.board);
    assert.equal(c.cur, 2, 'humaneval now the running suite');
    assert.equal(c.qDone, 300, 'first suite fully banked');
});

test('U83 harness leaf bars: fill NEVER moves backwards across subtasks', () => {
    const { B } = load();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true,
                  queue: [], board: [] };
    ACC.syncBoard({
        running: true, current_model: 'M', current_bench_id: 'b',
        running_entry: { model_id: 'M', engine: 'harness',
                         sizes: { mmlu: 1 }, external: false },
        queue: [],
    });
    const seen = [];
    const push = (cur, tot) => {
        ACC.boardEvent({ type: 'progress', phase: 'eval', benchmark: 'mmlu',
                         current: 0, total: 1, bench_current: cur, bench_total: tot });
        seen.push(ACC.state.board[0].suiteDone.mmlu);
    };
    push(1, 30); push(30, 30);       // leaf 1 done (bar maxed)
    push(1, 30); push(15, 30);       // leaf 2 restarts at 1 — smaller than 30!
    for (let i = 1; i < seen.length; i++)
        assert.ok(seen[i] >= seen[i - 1], 'monotone fill, got ' + seen.join(','));
    assert.equal(seen[seen.length - 1], 45, 'leaf1 banked (30) + leaf2 current (15)');
});

test('U83 between-suites gap: no phantom 0 — first queued box is live', () => {
    const { B } = load();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true,
                  queue: [], board: [] };
    const st = {
        running: true, current_model: 'M', current_bench_id: 'b',
        running_entry: { model_id: 'M', engine: 'classic',
                         sizes: { mmlu: 300, humaneval: 300 }, external: false },
        queue: [],
    };
    ACC.syncBoard(st);                       // mmlu running, humaneval queued
    ACC.boardEvent({ type: 'result', data: { benchmark: 'mmlu', total: 300 } });
    // re-poll mid-transition (humaneval started, first event not seen yet)
    ACC.syncBoard(st);
    const c = B._board.boardCounters(ACC.state.board);
    assert.equal(c.cur, 2, 'never shows 0 while something runs');
});

test('U83 status text keeps the engine message; board adds the counters', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8');
    assert.ok(/st\.textContent = \(ev\.message \|\| ev\.phase \|\| ''\) \+\s*\n?\s*this\.statusCounterText\(ev\)/
        .test(src), 'onEvent composes message + counters');
    // the old duplicated per-suite pair must be gone
    assert.ok(!src.includes("' suites · '"), 'old [x/y suites · a/b q] format retired');
});

/* ==========================================================================
   ACC-STALL (user item 4): the Intelligence board froze at 1/164 while the
   server kept answering, because a half-open SSE socket stays technically
   OPEN — no error event, no data — and ACC had NO polling while streaming.
   The queue poll now runs alongside the stream and (a) forward-seeds the
   board from the payload's own last_progress, (b) restarts the stream when
   the server reports events we never consumed, (c) says so when even that
   stops moving. This harness adds what the plain u83 stub lacks: controllable
   timers, a scripted /bench/accuracy/queue, an EventSource recorder. */
function loadPoll(opts) {
    opts = opts || {};
    const { byId, document } = harness();
    const timers = { next: 1, live: new Map(), cleared: [] };
    const esList = [];
    const net = { get: [] };
    const queueScript = opts.queue || [];
    let queueN = 0;
    const win = {
        UpliftCore: { t: k => k },
        UpliftDom: {
            fetchJson: async (u) => {
                net.get.push(String(u));
                if (String(u).endsWith('/bench/accuracy/queue')) {
                    const p = queueScript[Math.min(queueN, queueScript.length - 1)];
                    queueN++;
                    if (p instanceof Error) throw p;
                    return p || { running: false, queue: [] };
                }
                if (String(u).endsWith('/bench/accuracy/results'))
                    return { results: [] };
                throw new Error('no net: ' + u);
            },
            postJson: async () => {}, deleteJson: async () => {}, toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document, requestAnimationFrame: () => {},
        setInterval: (fn) => { const id = timers.next++; timers.live.set(id, fn); return id; },
        clearInterval: (id) => { timers.live.delete(id); timers.cleared.push(id); },
        setTimeout: (fn) => 0, clearTimeout: () => {},
        location: { hash: '#bench/accuracy', pathname: '/uplift/', search: '' },
        history: { replaceState() {} },
        EventSource: function (url) {
            const self = this;
            this.url = url; this.closed = false;
            this.close = () => { self.closed = true; };
            esList.push(this);
        },
    };
    win.window = win; win.self = win;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem() {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8'))
        .runInContext(ctx);
    const tick = async (n) => {
        for (let i = 0; i < (n || 1); i++) {
            for (const fn of [...timers.live.values()]) await fn();
        }
    };
    const doc = { byId: (id) => document.getElementById(id) };
    return { win, byId, doc, B: win.UpliftNativeBench, timers, tick, esList, net };
}
const running = (extra) => Object.assign({
    running: true, phase: 'evaluating', current_bench_id: 'b1',
    current_model: 'BigModel',
    running_entry: { model_id: 'BigModel', engine: 'classic',
                     sizes: { mmlu: 300 }, external: false },
    queue: [],
}, extra || {});
const EV = (cur, tot, bench) => ({
    type: 'progress', phase: 'eval', benchmark: bench || 'mmlu',
    current: 0, total: 1, bench_current: cur, bench_total: tot,
    message: 'Evaluating ' + (bench || 'mmlu'),
});

test('ACC-STALL: needsStreamRestart truth table (hysteresis, not one-shot)', () => {
    const { B } = load();
    const f = B._board.needsStreamRestart;
    assert.equal(f(10, 4, null), false, 'first miss: the fetch/stream race is not proof');
    assert.equal(f(10, 4, 10), true, 'the SAME miss repeats -> restart');
    assert.equal(f(12, 4, 10), true,
        'backlog GROWS while the consumed count sits still: the miss repeated, restart');
    assert.equal(f(12, 10, 10), false,
        'caught up to what the last poll saw: a moment behind is not a stall');
    assert.equal(f(10, 10, 10), false, 'seen caught up -> no restart');
    assert.equal(f(10, 12, 10), false, 'stream ahead of the poll -> no restart');
    assert.equal(f(10, 10, null), false, 'event_count EQUALS seen is never a restart');
    assert.equal(f(undefined, 0, undefined), false, 'old server shape: never restart');
    assert.equal(f(10, 0, 10), true, 'silent stream, backlog twice -> restart');
});

test('ACC-STALL: resetBoardEntry rebuilds the accumulator, keeps identity', () => {
    const { B } = load();
    const entry = {
        key: 'M|classic|mmlu', model_id: 'M', engine: 'classic', running: true,
        sizes: { mmlu: 300, humaneval: 300 },
        meta: { mmlu: { label: 'MMLU' } },
        bar: { mmlu: { cur: 12, tot: 300, acc: 900 } },
        suiteDone: { mmlu: 912 }, suiteQuiet: { mmlu: 7 },
        suiteState: { mmlu: 'running', humaneval: 'queued' }, qper: { mmlu: 999 },
    };
    const out = B._board.resetBoardEntry(entry, null, GROUPS);
    assert.equal(out, entry, 'the SAME object survives (syncBoard merges by key)');
    assert.deepEqual(entry.bar, {}, 'leaf bank cleared (a replay must not re-bank)');
    assert.deepEqual(entry.suiteDone, {});
    assert.deepEqual(entry.suiteQuiet, {});
    assert.deepEqual(entry.suiteState, { mmlu: 'running', humaneval: 'queued' },
        'first suite live, the rest queued — syncBoard first-paint shape');
    assert.deepEqual(entry.qper, { mmlu: 300, humaneval: 300 },
        'totals recomputed from the sizes, not the stale 999');
    assert.equal(entry.key, 'M|classic|mmlu');
    assert.equal(entry.model_id, 'M');
    assert.equal(entry.engine, 'classic');
    assert.equal(entry.running, true);
    assert.deepEqual(entry.sizes, { mmlu: 300, humaneval: 300 });
    assert.deepEqual(entry.meta, { mmlu: { label: 'MMLU' } }, 'meta survives');
    // harness totals keep the per-subtask math
    const h = { key: 'k', engine: 'harness', running: true, sizes: { mmlu: 30 },
                bar: {}, suiteDone: {}, suiteQuiet: {}, suiteState: {}, qper: {} };
    B._board.resetBoardEntry(h, HSIZE, GROUPS);
    assert.deepEqual(h.qper, { mmlu: 30 * 57 }, 'harness limit x leaves');
    // a waiting entry never gets a running box
    const q = { key: 'k', engine: 'classic', running: false, sizes: { mmlu: 1 },
                bar: {}, suiteDone: {}, suiteQuiet: {}, suiteState: {}, qper: {} };
    B._board.resetBoardEntry(q, null, GROUPS);
    assert.deepEqual(q.suiteState, { mmlu: 'queued' });
});

test('ACC-STALL: replay after a reset banks every leaf total exactly once', () => {
    const { B } = load();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true,
                  queue: [], board: [], seenN: 0, pollN: null, lastAct: 0,
                  lastMsg: '' };
    const st = running({
        running_entry: { model_id: 'M', engine: 'harness',
                         sizes: { mmlu: 1 }, external: false },
    });
    ACC.syncBoard(st);
    // three leaves of one harness suite: 30, 30, 15 questions answered
    const leaf = (...curs) => curs.forEach(c => ACC.boardEvent(EV(c, 30)));
    const replay = () => { leaf(1, 15, 30); leaf(1, 15, 30); leaf(1, 8, 15); };
    replay();
    const first = ACC.state.board[0].suiteDone.mmlu;
    assert.equal(first, 30 + 30 + 15, 'two leaf boundaries banked');
    // the stall restart: reset, then the server replays the SAME log
    B._board.resetBoardEntry(ACC.state.board[0], HSIZE, GROUPS);
    assert.equal(ACC.state.board[0].suiteDone.mmlu, undefined, 'accumulator empty');
    replay();
    assert.equal(ACC.state.board[0].suiteDone.mmlu, first,
        'the replay re-banks to the SAME total — never double');
});

test('ACC-STALL: without the reset the same replay would bank the old total twice', () => {
    const { B } = load();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true,
                  queue: [], board: [], seenN: 0, pollN: null, lastAct: 0,
                  lastMsg: '' };
    ACC.syncBoard(running({
        running_entry: { model_id: 'M', engine: 'harness',
                         sizes: { mmlu: 1 }, external: false } }));
    const ev = () => { ACC.boardEvent(EV(1, 30)); ACC.boardEvent(EV(2, 30)); };
    ev();
    const after = ACC.state.board[0].suiteDone.mmlu;
    ev();       // reconnect replay into a NON-reset bar: cur 1 < 2 banks 30 again
    assert.ok(ACC.state.board[0].suiteDone.mmlu > after,
        'this is the corruption resetBoardEntry exists to stop');
});

test('ACC-STALL: startStream ALWAYS arms the 4s queue poll beside the stream', () => {
    const { B, timers, esList } = loadPoll({ queue: [running()] });
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 7, pollN: 3, lastAct: 0, lastMsg: '',
                  results: [] };
    ACC.startStream('b1');
    assert.equal(esList.length, 1, 'stream opened');
    assert.equal(timers.live.size, 1, 'the watchdog poll runs alongside it');
    assert.equal(ACC.state.seenN, 0, 'the consumed counter restarts with the replay');
    assert.equal(ACC.state.pollN, null, 'no stale previous count');
    ACC.startStream('b1');     // a restart must never double-arm
    assert.equal(timers.live.size, 1, 'one interval, not two');
    assert.equal(esList.length, 2);
    assert.equal(esList[0].closed, true, 'the dead stream was closed');
});

test('ACC-STALL: the done and error events clear the poll (no post-run traffic)', async () => {
    const { B, timers } = loadPoll({ queue: [{ running: false, queue: [] }] });
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '',
                  results: [] };
    ACC.startStream('b1');
    assert.equal(timers.live.size, 1);
    ACC.onEvent({ type: 'done' });
    await new Promise(r => setImmediate(r));
    assert.equal(timers.live.size, 0, 'done stops the watchdog');
    ACC.startStream('b1');
    assert.equal(timers.live.size, 1);
    ACC.onEvent({ type: 'error', message: 'boom' });
    assert.equal(timers.live.size, 0, 'error stops it too');
});

test('ACC-STALL: a poll paints the status line and advances the boxes', async () => {
    const lp = EV(42, 300);
    const { B, byId, tick } = loadPoll({ queue: [running({ last_progress: lp })] });
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: false, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '',
                  results: [] };
    await ACC.refreshQueue();           // discovers the run, opens stream + poll
    assert.ok(byId['bench-acc-status'].textContent.includes('Evaluating mmlu'),
        byId['bench-acc-status'].textContent);
    assert.ok(/\[1\/1 suites/.test(byId['bench-acc-status'].textContent),
        'counters ride the same shape the stream paints');
    assert.equal(ACC.state.board[0].suiteDone.mmlu, 42,
        'the queue box advanced from the POLL alone (no event ever arrived)');
});

test('ACC-STALL: the seed is forward-only — equal, behind and leaf drops never apply', () => {
    const { B } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '' };
    ACC.syncBoard(running({
        running_entry: { model_id: 'M', engine: 'harness',
                         sizes: { mmlu: 1 }, external: false } }));
    ACC.boardEvent(EV(30, 30));                     // leaf 1 maxed
    const e = ACC.state.board[0];
    const seed = (cur) => ACC.seedFromPoll({ last_progress: EV(cur, 30) });
    assert.equal(seed(30), false, 'the stream is already AT 30 — no seed');
    assert.equal(seed(12), false, 'behind the live bar — no seed');
    const after = e.suiteDone.mmlu;
    assert.equal(seed(1), false,
        'a harness LEAF restart (cur 1) is not a regression: never seeded');
    assert.equal(e.suiteDone.mmlu, after, 'no phantom bank from a leaf drop');
    assert.equal(seed(31), true, 'a strictly newer progress seeds');
    assert.equal(e.suiteDone.mmlu, after + 1, 'and it moves the box by exactly one');
    // the same snapshot twice must not double-count
    const before = e.suiteDone.mmlu;
    assert.equal(seed(31), false, 'seed applies ONCE per bar position');
    assert.equal(e.suiteDone.mmlu, before, 'no double-bank afterwards');
});

test('ACC-STALL: no seeding from a prepare/quiet or non-progress snapshot', () => {
    const { B } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '' };
    ACC.syncBoard(running());
    const e = ACC.state.board[0];
    assert.equal(ACC.seedFromPoll({ last_progress: { type: 'result', benchmark: 'mmlu' } }), false);
    assert.equal(ACC.seedFromPoll({ last_progress: { type: 'progress', phase: 'prepare', benchmark: 'mmlu', bench_current: 5 } }), false);
    assert.equal(ACC.seedFromPoll({ last_progress: { type: 'progress', phase: 'eval', bench_current: 5 } }), false,
        'no benchmark -> nothing to move');
    assert.equal(ACC.seedFromPoll({}), false, 'no last_progress at all');
    assert.equal(e.suiteDone.mmlu, undefined, 'the board stayed untouched');
});

test('ACC-STALL: event_count backlog twice -> reset + stream rebuild', async () => {
    const lp = EV(10, 300);
    const { B, esList, tick, ACC: _a } = loadPoll({
        queue: [running({ event_count: 12, last_progress: lp })],
    });
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: false, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '',
                  results: [] };
    await ACC.refreshQueue();                  // first poll: arms stream + watchdog
    assert.equal(esList.length, 1);
    ACC.state.seenN = 0;                       // the stream never delivered
    await ACC.refreshQueue();                  // miss #1 -> NO restart yet
    assert.equal(esList.length, 1, 'one miss is not proof');
    ACC.state.seenN = 0;
    await ACC.refreshQueue();                  // miss #2, same count -> restart
    assert.equal(esList.length, 2, 'the dead stream was rebuilt');
    assert.equal(ACC.state.board[0].bar && Object.keys(ACC.state.board[0].bar).length, 0,
        'the accumulator was reset BEFORE the replay');
});

test('ACC-STALL: a caught-up stream is left alone (no restart storm)', async () => {
    const { B, esList } = loadPoll({
        queue: [running({ event_count: 5, last_progress: EV(1, 300) })],
    });
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 5, pollN: 5, lastAct: Date.now(),
                  lastMsg: '', results: [] };
    await ACC.refreshQueue();
    await ACC.refreshQueue();
    assert.equal(esList.length, 0, 'event_count === seen -> never restart');
});

test('ACC-STALL: the stall note appears past the threshold and clears on activity', () => {
    const { B } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: Date.now(),
                  lastMsg: '' };
    assert.equal(ACC.stallSuffix(), '', 'fresh activity: no note');
    ACC.state.lastAct = Date.now() - 91000;
    const suff = ACC.stallSuffix();
    assert.ok(suff.indexOf(' — ') === 0, 'appended, never replaces: ' + suff);
    assert.ok(/9[0-9]s/.test(suff), 'the silent span is named: ' + suff);
    ACC.state.lastAct = Date.now();            // a newer poll message
    assert.equal(ACC.stallSuffix(), '', 'activity resumes -> the note is gone');
    ACC.state.running = false;
    ACC.state.lastAct = Date.now() - 10 * 60000;
    assert.equal(ACC.stallSuffix(), '', 'an idle board is not a stalled one');
});

test('ACC-STALL: the stall note lands on the status line without a data-i18n hook', () => {
    const { B, doc } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null,
                  lastAct: Date.now() - 120000, lastMsg: 'Evaluating mmlu' };
    ACC.syncBoard(running());
    ACC.pollStatus(running({ last_progress: EV(3, 300) }));
    const node = doc.byId('bench-acc-status');
    assert.ok(node.textContent.includes('Evaluating mmlu'), node.textContent);
    assert.ok(/No progress events for 12[0-9]s/.test(node.textContent),
        node.textContent);
    assert.equal(node.dataset.i18n, undefined,
        'a {placeholder} node must NOT carry data-i18n (applyI18n would repaint it raw)');
});

test('ACC-STALL: an errored status line is never overwritten by the poll', () => {
    const { B, doc } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: Date.now(),
                  lastMsg: '' };
    const node = doc.byId('bench-acc-status');   // create it before asserting
    // the u83 classList stub is inert, so drive the guard through its flag:
    const contains = node.classList.contains;
    node.classList.contains = (c) => c === 'bench-status-error';
    ACC.pollStatus(running({ last_progress: EV(9, 300) }));
    assert.equal(node.textContent, '',
        'the error text stays; the poll keeps out of the way');
    node.classList.contains = contains;
    ACC.pollStatus(running({ last_progress: EV(9, 300) }));
    assert.ok(node.textContent.includes('Evaluating mmlu'),
        'once the error class is gone the poll paints again');
});

test('ACC-STALL: a newer poll message counts as activity (no false stall)', () => {
    const { B, doc } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: Date.now() - 120000,
                  lastMsg: 'Evaluating gsm8k' };
    ACC.syncBoard(running());
    ACC.pollStatus(running({ last_progress: EV(12, 300) }));
    const t1 = ACC.state.lastAct;
    assert.ok(t1 > Date.now() - 2000, 'a NEWER message is activity: clock refreshed');
    assert.ok(!/No progress events/.test(doc.byId('bench-acc-status').textContent),
        'and the stall note is gone on that same paint');
    ACC.pollStatus(running({ last_progress: EV(12, 300) }));   // same message
    assert.equal(ACC.state.lastAct, t1, 'an unchanged message is NOT activity');
});

test('ACC-STALL: every stream event counts and refreshes the activity clock', () => {
    const { B } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '',
                  results: [] };
    ACC.syncBoard(running());
    ACC.onEvent(EV(1, 300));
    ACC.onEvent(EV(2, 300));
    assert.equal(ACC.state.seenN, 2, 'parsed events are counted');
    assert.ok(ACC.state.lastAct > 0);
    assert.equal(ACC.state.lastMsg, 'Evaluating mmlu',
        'the stream records what it painted so the poll can compare');
});

test('ACC-STALL: the 4s poll repaints in place, rebuilds only on a shape change', () => {
    const { B, byId } = loadPoll();
    const ACC = B._panels.acc;
    ACC.state = { groups: GROUPS, harnessSizes: HSIZE, running: true, queue: [],
                  board: [], seenN: 0, pollN: null, lastAct: 0, lastMsg: '' };
    ACC._qSig = null;      // a fresh mount forgets the previous shape
    ACC.syncBoard(running());
    ACC.renderQueue(running());
    const wrap = byId['bench-acc-queue'];   // gid created it on the paint
    const first = wrap.children.slice();
    assert.ok(first.length >= 2, 'caption + one entry row painted');
    ACC.syncBoard(running());
    ACC.renderQueue(running());
    assert.equal(wrap.children[0], first[0],
        'identical shape -> the SAME nodes (no rebuild under the pointer)');
    assert.equal(wrap.children[1], first[1]);
    const more = running({ queue: [{ model_id: 'Next', engine: 'classic',
                                     sizes: { humaneval: 300 } }] });
    ACC.syncBoard(more);
    ACC.renderQueue(more);
    assert.notEqual(wrap.children[0], first[0],
        'a new queue entry rebuilds: a stale board is worse than lost hover');
    assert.equal(wrap.children.length, first.length + 1, '+1 entry row');
    // a re-mount builds a FRESH wrap: ACC.render must FORGET the previous
    // shape, or the first renderQueue after the mount would paint nothing.
    // (Asserted on the source: calling ACC.render here would fire three
    // network promises this harness does not answer.)
    assert.ok(/this\._qSig = null;/.test(
        fs.readFileSync(`${STATIC_DIR}/uplift_bench.js`, 'utf8')),
        'ACC.render clears the shape signature for the new wrap');
    ACC._qSig = null;
    const prev0 = byId['bench-acc-queue'].children[0];
    ACC.syncBoard(running());
    ACC.renderQueue(running());
    assert.notEqual(byId['bench-acc-queue'].children[0], prev0,
        'a cleared signature repaints the rows from scratch');
});
