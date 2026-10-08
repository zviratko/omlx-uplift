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
