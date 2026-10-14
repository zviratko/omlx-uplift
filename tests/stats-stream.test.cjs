/* STATS-SSE (client lane): the vanilla /admin/api/stats payload rides the
   existing 2 Hz livefeed frames as 's' (+ all-time 'sa'), and the HTTP poll
   becomes a stream-gated fallback with a tab-aware cadence.

   Frozen contract pins:
   (a) livefeed frame split — a frame carrying 's'/'sa' dispatches to onStats
       ONLY (chart onFrame listeners never fire for a pure stats frame, and
       an m-only frame behaves exactly as before); a frame may carry both;
       stats arrive even under live:false (the stats lane is independent of
       the fast sampler's health).
   (b) statsFresh() — true only with an OPEN source + a recent statsAt;
       false when disabled, after close/visibilitychange-hidden, once the
       120 s window lapses, or before the first stats frame.
   (c) uplift.js stats lane — sliced VERBATIM from the shipped source and
       run in a vm sandbox (uplift.js itself is the app monolith and cannot
       boot headless; this is the same slice-the-real-code bar FE-3 sets for
       glue): intervalForTab (status = layout.intervalMs, else 20000), the
       self-rescheduling setTimeout chain, pollStats/pollAlltime ZERO fetches
       while the stream is fresh, statsBusy overlap guard, the stale-banner
       error path unchanged, and consumeRaw-from-a-frame clearing stale/fail.
   (d) boot poller gates — structural: the 8 s MM.render interval is Models
       only (every S.adminModels reader renders there: mmtable/mmeditor/
       voices/helper; applyTab paints on entry), the 60 s CH.loadChartHistory
       interval is Status only with the age-based refresh on entry living in
       applyTab. No full-boot vm harness exists (boot needs every module +
       the DOM), so text pins are the honest floor here.
   (e) 'sa'-without-'s' policy (the picked rule): update alltimeRequests +
       alltimeAt immediately and repaint ONLY the v-requests-sub node — no
       full render() is faked without a snapshot; a frame with BOTH lets
       consumeRaw's render() paint it (render calls paintAlltimeSub). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');
const C = require('../omlx_uplift/static/core.js');   // the REAL normalize

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const lfSrc = read('uplift_livefeed.js');
const upSrc = read('uplift.js');
const bootSrc = read('uplift_boot.js');

/* vanilla /admin/api/stats subset — same fixture shape uplift.test.cjs uses */
const raw = (extra) => Object.assign({
    avg_generation_tps: 50, avg_prefill_tps: 3000, total_requests: 10,
    total_tokens_served: 1000, total_completion_tokens: 20, total_cached_tokens: 5,
    cache_efficiency: 55.5, uptime_seconds: 100,
    active_models: { models: [], model_memory_used: 8e9, model_memory_max: 16e9,
        memory_pressure: { pressure_level: 'ok' }, total_active_requests: 0, total_waiting_requests: 0 },
    runtime_cache: { total_size_bytes: 1e9, disk_max_bytes: 1e10 },
}, extra || {});

/* ---------------- (1) livefeed: real module in a vm sandbox -------------- */

function loadLivefeed() {
    const winListeners = {};
    class FakeES {
        constructor(url) { this.url = url; this.readyState = FakeES.CONNECTING; FakeES.instances.push(this); }
        close() { this.readyState = FakeES.CLOSED; }
    }
    FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2; FakeES.instances = [];
    const clock = { t: 1_000_000_000 };
    const doc = { hidden: false, hasFocus: () => true, addEventListener() {} };
    const win = {
        console, JSON, Math, Object, Array, Number, String, Boolean, Promise,
        isFinite, Date: { now: () => clock.t },
        document: doc,
        EventSource: FakeES,
        addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
        Uplift: { state: { API: '' } },
    };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(lfSrc, win, { filename: 'uplift_livefeed.js' });
    const LF = win.Uplift.livefeed;
    return {
        LF, FakeES, doc, clock,
        connect() { LF.connect(); const es = FakeES.instances[FakeES.instances.length - 1]; es.readyState = FakeES.OPEN; return es; },
        push(es, frame) { es.onmessage({ data: JSON.stringify(frame) }); },
        fire: (t) => (winListeners[t] || []).forEach(fn => fn()),
    };
}

test('(a) livefeed: stats-only frame -> onStats only; m-only unchanged; both -> both', () => {
    const h = loadLivefeed();
    const chartFires = [], statsFrames = [];
    h.LF.onFrame(() => chartFires.push(1));
    h.LF.onStats(f => statsFrames.push(f));
    const es = h.connect();
    assert.strictEqual(h.LF.statsFresh(), false, 'no frames yet -> not fresh');

    h.push(es, { m: { 'queue.waiting': [h.clock.t / 1000, 3] } });   // m-only
    assert.strictEqual(chartFires.length, 1, 'm frame redraws charts (old behavior)');
    assert.strictEqual(statsFrames.length, 0, 'm frame must not touch the stats lane');
    assert.strictEqual(h.LF.statsFresh(), false, 'm-only frame does not feed statsFresh');
    assert.ok(h.LF.liveUsable('queue.waiting'), 'm column still folds');

    h.push(es, { s: raw(), sa: 42 });                                // stats-only
    assert.strictEqual(chartFires.length, 1, 'stats-only frame fires NO chart listener');
    assert.strictEqual(statsFrames.length, 1, 'stats frame reaches onStats');
    assert.strictEqual(statsFrames[0].sa, 42, 'the whole frame is handed to the consumer');
    assert.strictEqual(h.LF.statsFresh(), true, 'OPEN source + stats frame -> fresh');

    h.push(es, { m: { 'queue.waiting': [h.clock.t / 1000 + 1, 4] }, s: raw() });  // both
    assert.strictEqual(chartFires.length, 2, 'a frame with both fires charts too');
    assert.strictEqual(statsFrames.length, 2, '... and stats');
});

test('(a) livefeed: stats dispatch even under live:false; sampler-freeze keeps its meaning', () => {
    const h = loadLivefeed();
    const chartFires = [], statsFrames = [];
    h.LF.onFrame(() => chartFires.push(1));
    h.LF.onStats(f => statsFrames.push(f));
    const es = h.connect();
    h.push(es, { live: false, s: raw() });
    assert.strictEqual(statsFrames.length, 1, 'stats lane is independent of the sampler');
    assert.strictEqual(chartFires.length, 0, 'frozen sampler: no chart dispatch, no columns');
    assert.strictEqual(h.LF.statsFresh(), true, 'the stats frame counts for freshness');
    assert.strictEqual(h.LF.isLive(), false, 'a stats-only frame never claims the sampler is alive');
});

test('(b) statsFresh: window, disable, close, hidden, CONNECTING', () => {
    const h = loadLivefeed();
    h.LF.onStats(() => {});
    const es = h.connect();
    h.push(es, { s: raw() });
    assert.strictEqual(h.LF.statsFresh(), true);

    es.readyState = h.FakeES.CONNECTING;
    assert.strictEqual(h.LF.statsFresh(), false, 'reconnecting (CONNECTING) stream is not fresh');
    es.readyState = h.FakeES.OPEN;
    assert.strictEqual(h.LF.statsFresh(), true, 'back OPEN within the window -> fresh again');

    h.clock.t += 121_000;                       // idle server missed two ~1/min pushes
    assert.strictEqual(h.LF.statsFresh(), false, 'statsAt older than 120 s -> poll takes over');
    h.clock.t -= 121_000;

    h.push(es, { s: raw() });
    h.doc.hidden = true;
    h.fire('visibilitychange');                 // module closes the stream while hidden
    assert.strictEqual(h.LF.statsFresh(), false, 'hidden -> closed source -> not fresh');

    // disable() zeroes the lane even for an OPEN source with a fresh stamp
    const h2 = loadLivefeed();
    const es2 = h2.connect();
    h2.push(es2, { s: raw() });
    assert.strictEqual(h2.LF.statsFresh(), true);
    h2.LF.disable();
    assert.strictEqual(h2.LF.statsFresh(), false, 'disabled feed is never a stats source');
});

test('livefeed still tolerates ZERO onStats registrations (module alone)', () => {
    const h = loadLivefeed();
    const es = h.connect();
    assert.doesNotThrow(() => h.push(es, { s: raw(), sa: 1 }));
    assert.doesNotThrow(() => h.push(es, { m: { 'queue.waiting': [h.clock.t / 1000, 1] } }));
});

/* ---------------- (2) uplift.js stats lane: slice the real code ---------- */

/* Brace-walk from `function NAME` / `async function NAME` to the closing
   brace. All sliced bodies keep braces inside strings/templates balanced
   (`${...}`, no lone '{' literals) — the assert on the tail proves it. */
function sliceFn(name) {
    const re = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`);
    const m = re.exec(upSrc);
    assert.ok(m, `uplift.js must define ${name}`);
    let i = upSrc.indexOf('{', m.index);
    let depth = 0, j = i;
    for (; j < upSrc.length; j++) {
        const ch = upSrc[j];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (!depth) break; }
    }
    const body = upSrc.slice(m.index, j + 1);
    assert.ok(body.trimEnd().endsWith('}'), `${name}: brace walk terminated cleanly`);
    assert.ok(body.includes('\n') && body.length < 5000, `${name}: slice looks like one function`);
    return body;
}

function loadStatsLane(opts) {
    opts = opts || {};
    const calls = { fetch: [], render: [], observe: 0, react: 0, scheduled: [], cleared: 0, celebrate: 0 };
    const els = {};
    function el(id) {
        if (!els[id]) els[id] = {
            id, textContent: '',
            classes: new Set(),
            classList: {
                add: (...c) => c.forEach(x => els[id].classes.add(x)),
                remove: (...c) => c.forEach(x => els[id].classes.delete(x)),
                contains: c => els[id].classes.has(c),
                toggle: () => {},
            },
        };
        return els[id];
    }
    const st = {
        hidden: false, tab: 'status', intervalMs: 1000, fresh: false,
        pending: null, tid: 0, paint: null,
    };
    const sandbox = {
        console, JSON, Math, Number, String, Object, Array, Boolean, Promise, Error,
        Date, isFinite, encodeURIComponent,
        document: { hidden: false, body: el('body') },
        location: { origin: 'http://test' },
        $: el,
        API: '',
        C,                                        // the REAL core.js normalize/events
        S: { milestoneFloor: {} },
        tracker: { observe() { calls.observe++; } },
        FE: {
            reactTo(e) { calls.react += e.length; },
            gateMilestones: m => m, celebrate() { calls.celebrate++; }, milestoneQuip: () => 'q',
        },
        layout: { get intervalMs() { return st.intervalMs; } },
        currentTab: () => st.tab,
        render: s => { calls.render.push(s); if (st.paint) st.paint(); },   // real render ends by painting the all-time sub-line
        fetchJson: async url => {
            calls.fetch.push(String(url));
            if (opts.failFetch) throw new Error('down');
            if (String(url).includes('scope=alltime'))
                return opts.alltime === undefined ? { total_requests: 1234 } : opts.alltime;
            return raw(opts.stats);
        },
        setTimeout: (fn, ms) => { st.pending = { fn, ms }; calls.scheduled.push(ms); return ++st.tid; },
        clearTimeout: () => { calls.cleared++; st.pending = null; },
    };
    sandbox.window = sandbox;
    sandbox.Uplift = { livefeed: { statsFresh: () => st.fresh } };
    // Mirror of uplift.js's OWN module-level `let` lines (pinned below that
    // this mirror stays in sync); the sliced functions close over these.
    const preamble = `
let stats = null, prevStats = null, failCount = 0, timer = null;
let statsBusy = false;
let alltimeRequests = null, alltimeAt = 0, alltimeFetching = false;
`;
    const slowConst = /const STATS_SLOW_MS = (\d+);/.exec(upSrc);
    assert.ok(slowConst, 'uplift.js declares STATS_SLOW_MS');
    const names = ['statsStreamFresh', 'consumeRaw', 'pollStats', 'pollAlltime',
                   'paintAlltimeSub', 'consumeStreamStats', 'intervalForTab',
                   'scheduleStats', 'restartPolling'];
    // vm Scripts reject a top-level `return` — the whole lane runs inside a
    // wrapper arrow; the returned API closes over the mirrored `let`s.
    const script = '(() => {' + preamble + `const STATS_SLOW_MS = ${slowConst[1]};\n`
        + names.map(sliceFn).join('\n')
        + `\nreturn {\n`
        + names.map(n => `${n},`).join('')
        + `get: () => ({ stats, prevStats, failCount, statsBusy, alltimeRequests, alltimeAt, timer }),\n`
        + `set: (k, v) => { if (k === 'failCount') failCount = v; else if (k === 'statsBusy') statsBusy = v;`
        + ` else if (k === 'alltimeAt') alltimeAt = v; else if (k === 'alltimeRequests') alltimeRequests = v; },\n};\n})()`;
    vm.createContext(sandbox);
    const api = vm.runInContext(script, sandbox, { filename: 'uplift-stats-lane.js' });
    st.paint = api.paintAlltimeSub;
    const tick = () => new Promise(r => setImmediate(r));
    const h = { api, calls, st, el, sandbox, tick };
    h.statsFetches = () => h.calls.fetch.filter(u => u === '/admin/api/stats');
    h.alltimeFetches = () => h.calls.fetch.filter(u => u.includes('scope=alltime'));
    return h;
}

test('harness mirror stays honest: uplift.js still declares the let lines we mirror', () => {
    assert.ok(/let stats = null, prevStats = null, failCount = 0, timer = null;/.test(upSrc));
    assert.ok(/let statsBusy = false;/.test(upSrc));
    assert.ok(/let alltimeRequests = null, alltimeAt = 0, alltimeFetching = false;/.test(upSrc));
});

test('(c) intervalForTab: status = user interval, anything else = STATS_SLOW_MS 20000', () => {
    const h = loadStatsLane();
    assert.match(upSrc, /const STATS_SLOW_MS = 20000;/, 'slow rate is the frozen 20 s');
    h.st.intervalMs = 1000;
    h.st.tab = 'status';
    assert.strictEqual(h.api.intervalForTab(), 1000);
    for (const tab of ['models', 'settings', 'bench', 'usage', 'logs', 'chat']) {
        h.st.tab = tab;
        assert.strictEqual(h.api.intervalForTab(), 20000, `off-Status (${tab}) runs slow`);
    }
});

test('(c) scheduleStats: self-rescheduling setTimeout chain at the tab rate', async () => {
    const h = loadStatsLane();
    h.st.tab = 'settings';
    h.api.scheduleStats();
    assert.deepStrictEqual(h.calls.scheduled, [20000], 'scheduled with intervalForTab()');
    assert.strictEqual(h.calls.fetch.length, 0, 'scheduling alone never polls');

    // tick: pollStats runs, then the chain re-reads the (changed) rate
    h.st.tab = 'status';
    h.st.pending.fn();
    await h.tick();
    assert.strictEqual(h.calls.scheduled.length, 2);
    assert.strictEqual(h.calls.scheduled[1], 1000, 'delay is re-read per tick — a tab switch retunes instantly');
    assert.strictEqual(h.statsFetches().length, 1, 'the tick polled once');
    assert.ok(h.calls.cleared >= 2, 'each schedule clears the previous timer (no chain forks)');
});

test('(c) restartPolling = immediate poll + fresh chain (no setInterval remnant)', async () => {
    const h = loadStatsLane();
    h.api.restartPolling();
    await h.tick();
    assert.strictEqual(h.statsFetches().length, 1, 'pollStats fired immediately');
    assert.deepStrictEqual(h.calls.scheduled, [1000], 'status chain on the user interval');
    assert.ok(!/setInterval\(pollStats/.test(upSrc), 'the fixed-interval chain is gone');
});

test('(c) pollStats: ZERO fetches while the stream is fresh; fetch + consume otherwise', async () => {
    const h = loadStatsLane();
    h.st.fresh = true;
    await h.api.pollStats();
    assert.strictEqual(h.calls.fetch.length, 0, 'fresh stream = the frames ARE the poll (stats AND alltime)');
    assert.strictEqual(h.calls.render.length, 0);

    h.st.fresh = false;
    await h.api.pollStats();
    assert.strictEqual(h.statsFetches().length, 1, 'stream dead -> fallback GET /admin/api/stats');
    assert.strictEqual(h.alltimeFetches().length, 1, 'and the alltime lane took over too');
    assert.strictEqual(h.calls.render.length, 1, 'snapshot painted');
    assert.strictEqual(h.api.get().statsBusy, false, 'busy flag released');
    assert.strictEqual(h.calls.scheduled.length, 0, 'pollStats itself never schedules');

    // statsBusy overlap guard
    h.api.set('statsBusy', true);
    const before = h.calls.fetch.length;
    await h.api.pollStats();
    assert.strictEqual(h.calls.fetch.length, before, 'a poll already in flight is never doubled');
    h.api.set('statsBusy', false);

    // hidden guard (unchanged)
    h.sandbox.document.hidden = true;
    await h.api.pollStats();
    assert.strictEqual(h.calls.fetch.length, before + 0, 'hidden tab: no poll (chain keeps ticking)');
});

test('(c) pollStats error path: stale banner after 2 fails, silent on 1', async () => {
    const h = loadStatsLane({ failFetch: true });
    await h.api.pollStats();
    assert.strictEqual(h.api.get().failCount, 1);
    assert.ok(!h.el('banner').classes.has('show'), 'one failure stays quiet (same as before)');
    await h.api.pollStats();
    assert.strictEqual(h.api.get().failCount, 2);
    assert.ok(h.el('banner').classes.has('show'), 'two failures raise the banner');
    assert.ok(h.sandbox.document.body.classes.has('stale'));
});

test('(e) consumeRaw from a stream frame clears stale/failCount (reachability proven)', async () => {
    const h = loadStatsLane();
    // pre-poison: two fetch failures raised the banner
    h.sandbox.document.body.classes.add('stale');
    h.el('banner').classes.add('show');
    h.api.set('failCount', 5);
    h.api.consumeStreamStats({ s: raw({ total_requests: 7 }) });
    await h.tick();
    assert.strictEqual(h.api.get().failCount, 0, 'a stats frame resets the fail counter');
    assert.ok(!h.sandbox.document.body.classes.has('stale'), 'stale class cleared');
    assert.ok(!h.el('banner').classes.has('show'), 'banner hidden');
    assert.strictEqual(h.calls.render.length, 1, 'painted through the normal render path');
    assert.strictEqual(h.calls.observe, 1, 'dirty tracker observed the snapshot');
    // milestone floor seeds on first snapshot (unchanged consumeRaw body)
    assert.strictEqual(h.sandbox.S.milestoneFloor.requests, 0);
});

test('(e) sa policy: sa-without-s repaints ONLY the sub-line; sa-with-s rides render()', async () => {
    const h = loadStatsLane();
    h.api.consumeStreamStats({ sa: 42 });
    await h.tick();
    assert.strictEqual(h.calls.render.length, 0, 'no full render without a stats snapshot');
    assert.strictEqual(h.api.get().alltimeRequests, 42);
    assert.ok(h.api.get().alltimeAt > 0, 'throttle clock stamped (30 s poll skipped too)');
    assert.strictEqual(h.el('v-requests-sub').textContent, 'all-time 42',
        'the ONE sub-node the value lives on is repainted');

    h.api.consumeStreamStats({ s: raw(), sa: 99 });
    await h.tick();
    assert.strictEqual(h.calls.render.length, 1, 'with s the snapshot paints through render()');
    assert.strictEqual(h.api.get().alltimeRequests, 99);
    assert.strictEqual(h.el('v-requests-sub').textContent, 'all-time 99',
        'render -> paintAlltimeSub shows the SAME frame sa (single paint path)');

    h.api.consumeStreamStats({ sa: 42.7 });
    assert.strictEqual(h.api.get().alltimeRequests, 43, 'rounded like the fetch path');
    h.api.consumeStreamStats({ sa: -5 });
    assert.strictEqual(h.api.get().alltimeRequests, 43, 'garbage (negative) never lands');
    h.api.consumeStreamStats({});
    h.api.consumeStreamStats(null);   // tolerated, nothing thrown
});

test('(c) pollAlltime: skipped while fresh; 30 s throttle intact when not', async () => {
    const h = loadStatsLane();
    h.st.fresh = true;
    await h.api.pollAlltime();
    assert.strictEqual(h.calls.fetch.length, 0, "'sa' rides the stream — zero requests");

    h.st.fresh = false;
    await h.api.pollAlltime();
    assert.deepStrictEqual(h.calls.fetch, ['/admin/api/stats?scope=alltime']);
    assert.strictEqual(h.api.get().alltimeRequests, 1234);
    await h.api.pollAlltime();
    assert.strictEqual(h.calls.fetch.length, 1, 'second call inside 30 s stays throttled');
});

/* ---------------- (3) wiring + structural gates -------------------------- */

test('uplift.js registers the stats consumer on the livefeed at load', () => {
    assert.ok(/window\.Uplift\.livefeed\.onStats\(consumeStreamStats\)/.test(upSrc),
        'uplift.js (DOM owner) wires consumeStreamStats into livefeed.onStats');
    assert.ok(/onStats\(fn\)/.test(lfSrc) && /statsFresh,/.test(lfSrc),
        'livefeed exports the onStats/statsFresh pair');
    // pollStats checks freshness BEFORE the fetch (order pin on the real slice)
    const fn = sliceFn('pollStats');
    assert.ok(fn.indexOf('statsStreamFresh()') < fn.indexOf('fetchJson'),
        'the fresh-stream guard must precede the request');
});

test('applyTab: tab-change retunes the stats chain; Status entry refreshes stale history', () => {
    const body = upSrc.slice(upSrc.indexOf('function applyTab()'),
                             upSrc.indexOf("addEventListener('hashchange', applyTab)"));
    assert.match(body, /if \(tab !== appliedTab\) \{[\s\S]*?clearTimeout\(timer\);\s*pollStats\(\);\s*scheduleStats\(\);/,
        'any tab change: clear + immediate catch-up poll + reschedule');
    assert.ok(body.indexOf('appliedTab') < body.indexOf("if (tab === 'usage')"),
        'the retune sits at the tab-switch core, next to resizeCharts');
    assert.match(body, /if \(tab === 'status'\) \{[\s\S]*?CH\.historyAge\(\) > 60_000\) CH\.loadChartHistory\(\);/,
        'Status entry refreshes chart history when older than 60 s');
});

test('(d) boot: 8 s model-table poll is Models-tab-only; 60 s history poll is Status-only', () => {
    const mm = /setInterval\(\(\) => \{[^\n]*MM\.render\(\); \}, 8000\);/.exec(bootSrc);
    assert.ok(mm, 'the 8 s MM.render interval still exists (its data lane is needed)');
    assert.ok(mm[0].includes("currentTab() === 'models'"),
        'gated to Models: every S.adminModels reader (mmtable/mmeditor/voices/helper) renders there; applyTab paints on entry');
    assert.ok(mm[0].includes('!MM.seModel'), 'editor-open guard unchanged');
    const hist = /setInterval\(\(\) => \{[^\n]*CH\.loadChartHistory\(\); \}, 60000\);/.exec(bootSrc);
    assert.ok(hist, 'the 60 s history interval still exists');
    assert.ok(hist[0].includes("currentTab() === 'status'"),
        'gated to Status — the only consumer is the Status chart pair');
});

test('charts age hook is additive: historyAt stamps only an ADOPTED load', () => {
    const charts = read('uplift_charts.js');
    assert.match(charts, /function historyAge\(\) \{ return historyAt \? Date\.now\(\) - historyAt : Infinity; \}/);
    const adopted = charts.indexOf('historyDirty = false;');
    assert.ok(adopted > 0);
    assert.ok(charts.slice(adopted, adopted + 160).includes('historyAt = Date.now();'),
        'a completed, adopted history load stamps the age');
    const rejected = charts.indexOf('} else {\n            historyDirty = true;');
    assert.ok(rejected > 0 && !charts.slice(rejected, rejected + 80).includes('historyAt'),
        'a stale-window (rejected) load never stamps it — the Status entry retries');
    assert.ok(/historyAge: historyAge,/.test(charts), 'exported on window.Uplift.charts');
});

test('no regressions against the frozen lane contract: unknown m-only frames, exports', () => {
    // livefeed ingest still folds samples/m frames exactly as before (the
    // behavioural pins above run the REAL module; this guards the text seam
    // the (b) server lane will extend): s/sa dispatch precedes the sampler gate.
    const ingest = lfSrc.slice(lfSrc.indexOf('function ingest(d)'), lfSrc.indexOf('const listeners'));
    assert.ok(ingest.indexOf('statsCbs') < ingest.indexOf('d.live === false'),
        'stats frames land even when the fast sampler is declared dead');
    assert.ok(/if \(!d\.samples && !d\.m\) return;/.test(ingest),
        'a stats-only frame never touches columns or chart listeners');
});
