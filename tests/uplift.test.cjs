/* Node unit tests for uplift core: node --test tests/uplift.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../omlx_uplift/static/core.js');
const { allStaticJs } = require('./static-src.cjs');

const snap = o => C.normalize(o);
const raw = extra => Object.assign({
    avg_generation_tps: 50, avg_prefill_tps: 3000, total_requests: 10,
    total_tokens_served: 1000, total_completion_tokens: 20, total_cached_tokens: 5,
    cache_efficiency: 55.5, uptime_seconds: 100,
    active_models: { models: [], model_memory_used: 8e9, model_memory_max: 16e9,
        memory_pressure: { pressure_level: 'ok' }, total_active_requests: 0, total_waiting_requests: 0 },
    runtime_cache: { total_size_bytes: 1e9, disk_max_bytes: 1e10 },
}, extra);

test('normalize: happy path', () => {
    const s = snap(raw());
    assert.strictEqual(s.genTps, 50);
    assert.strictEqual(s.requests, 10);
    assert.strictEqual(s.memPercent, 50);
    assert.strictEqual(s.pressure, 'ok');
    // U39: disk-cache fields dropped from normalize entirely
    assert.strictEqual(s.cacheBytes, undefined);
});
test('normalize: U25/U28 promptTokens + U29 global hot-cache totals', () => {
    const s = snap(raw({ total_prompt_tokens: 400,
        runtime_cache: { total_size_bytes: 1e9, disk_max_bytes: 1e10,
                         hot_cache_size_bytes: 5e8, hot_cache_max_bytes: 2e9 } }));
    assert.strictEqual(s.promptTokens, 400);
    assert.strictEqual(s.hotCacheBytes, 5e8);
    assert.strictEqual(s.hotCacheMaxBytes, 2e9);
    // absent = null, never 0 (honest absence on old payloads)
    const bare = snap(raw());
    assert.strictEqual(bare.promptTokens, null);
    assert.strictEqual(bare.hotCacheBytes, null);
});
test('normalize: garbage in, nulls out', () => {
    const s = snap({ avg_generation_tps: 'x', total_requests: -5, active_models: null });
    assert.strictEqual(s.genTps, null);
    assert.strictEqual(s.requests, null);
    assert.strictEqual(s.memPercent, null);
    assert.deepStrictEqual(s.models, []);
});
test('normalize: undefined payload does not throw', () => {
    assert.strictEqual(snap().requests, null);
});

test('modelState precedence', () => {
    assert.strictEqual(C.modelState({ is_loading: true, active_requests: 2 }), 'Loading');
    assert.strictEqual(C.modelState({ prefilling: [1] }), 'Prefilling');
    assert.strictEqual(C.modelState({ generating: [1] }), 'Generating');
    assert.strictEqual(C.modelState({ active_requests: 1 }), 'Active');
    assert.strictEqual(C.modelState({}), 'Idle');
});

const m = (id, state) => {
    const s = snap(raw({ active_models: { models: [{ id, actual_size: 1e9, active_requests: 0 }],
        model_memory_used: 0, model_memory_max: 1e9, memory_pressure: {} } }));
    s.models[0].state = state;
    return s;
};

test('eventsBetween: first snapshot is silent', () => {
    assert.deepStrictEqual(C.eventsBetween(null, m('a', 'Idle')), []);
});
test('eventsBetween: model appear / state change / disappear', () => {
    const evs = C.eventsBetween(m('a', 'Idle'), m('b', 'Generating'));
    const kinds = evs.map(e => e.kind).sort();
    assert.deepStrictEqual(kinds, ['model-add', 'model-remove']);
});
test('eventsBetween: request delta', () => {
    const a = snap(raw({ total_requests: 5 })), b = snap(raw({ total_requests: 8 }));
    const evs = C.eventsBetween(a, b);
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].delta, 3);
});
test('eventsBetween: counter regression => restart', () => {
    const a = snap(raw({ total_requests: 50 })), b = snap(raw({ total_requests: 2 }));
    const evs = C.eventsBetween(a, b);
    assert.ok(evs.some(e => e.kind === 'restart'));
});
test('eventsBetween: pressure change', () => {
    const a = snap(raw()), b = snap(raw());
    b.pressure = 'hard';
    assert.ok(C.eventsBetween(a, b).some(e => e.kind === 'pressure'));
});

test('milestonesBetween: crossings only', () => {
    const a = snap(raw({ total_requests: 999 })), b = snap(raw({ total_requests: 1001 }));
    assert.strictEqual(C.milestonesBetween(a, b).length, 1);
    const c = snap(raw({ total_requests: 1002 }));
    assert.strictEqual(C.milestonesBetween(b, c).length, 0);
    assert.strictEqual(C.milestonesBetween(null, b).length, 0);
});

test('milestone ladder: 1K..1M then powers of 2', () => {
    const L = C.MILESTONE_LADDER;
    assert.strictEqual(L[0], 1000);
    assert.ok(L.includes(10000) && L.includes(100000) && L.includes(1e6));
    assert.ok(L.includes(2e6) && L.includes(4e6) && L.includes(8e6) && L.includes(16e6));
    assert.ok(!L.includes(1500000) && !L.includes(3e6));   // no odd rungs
    // sorted, unique
    for (let i = 1; i < L.length; i++) assert.ok(L[i] > L[i - 1]);
    assert.strictEqual(C.nextMilestone(999), 1000);
    assert.strictEqual(C.nextMilestone(1000), 10000);
    assert.strictEqual(C.nextMilestone(1e6), 2e6);
    assert.strictEqual(C.nextMilestone(3e6), 4e6);
    assert.strictEqual(C.milestoneFloorOf(1500000), 1e6);
    assert.strictEqual(C.milestoneFloorOf(999), 0);
});

test('milestonesBetween: skipped rungs fire once at the top rung', () => {
    const a = snap(raw({ total_tokens_served: 500 }));
    const b = snap(raw({ total_tokens_served: 1500000 }));   // blew past 1K..1M
    const hits = C.milestonesBetween(a, b);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].rung, 1e6);   // highest rung actually reached
    const c = snap(raw({ total_tokens_served: 1600000 }));
    assert.strictEqual(C.milestonesBetween(b, c).length, 0);
});

test('appendSample bounds history', () => {
    const h = [];
    for (let i = 0; i < 150; i++) C.appendSample(h, { t: i }, 120);
    assert.strictEqual(h.length, 120);
    assert.strictEqual(h[0].t, 30);
});

test('prefs: corrupt storage falls back to defaults', () => {
    const items = {};
    const store = { getItem: k => items[k], setItem: (k, v) => items[k] = v };
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    items[C.PREFS_KEY] = '{oops';
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    items[C.PREFS_KEY] = JSON.stringify({ theme: 'NEON!', intervalMs: 7 });
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    C.savePrefs(store, { theme: 'light', motion: 'off', intervalMs: 2000, dense: true });
    assert.deepStrictEqual(C.loadPrefs(store), { theme: 'light', motion: 'off', intervalMs: 2000, dense: true });
    // Skin system: a well-formed skin selection survives the whitelist
    // (base name follows newest; suffixed name pins a version).
    C.savePrefs(store, { theme: 'night-watch' });
    assert.equal(C.loadPrefs(store).theme, 'night-watch');
    C.savePrefs(store, { theme: 'night-watch-1762070400' });
    assert.equal(C.loadPrefs(store).theme, 'night-watch-1762070400');
    items[C.PREFS_KEY] = JSON.stringify({ theme: '../evil' });
    assert.equal(C.loadPrefs(store).theme, 'auto');  // traversal-ish: rejected
});

// F-014: tableSort must survive the loadPrefs whitelist round-trip.
test('prefs: table sort persists across reload', () => {
    const items = {};
    const store = { getItem: k => items[k], setItem: (k, v) => items[k] = v };
    C.savePrefs(store, { theme: 'night', tableSort: { key: 'name', dir: -1 } });
    assert.deepStrictEqual(C.loadPrefs(store).tableSort, { key: 'name', dir: -1 });
    // garbage sort entries fall back to undefined (defaults take over)
    items[C.PREFS_KEY] = JSON.stringify({ tableSort: { key: 42, dir: 'up' } });
    assert.strictEqual(C.loadPrefs(store).tableSort, undefined);
    items[C.PREFS_KEY] = JSON.stringify({ tableSort: 'nope' });
    assert.strictEqual(C.loadPrefs(store).tableSort, undefined);
});

test('formatters', () => {
    assert.strictEqual(C.fmtCompact(1234567), '1.23M');
    assert.strictEqual(C.fmtCompact(999), '999');
    assert.strictEqual(C.fmtCompact(null), '—');
    assert.strictEqual(C.fmtBytes(8.34 * 2 ** 30), '8.34 GiB');
    assert.strictEqual(C.fmtBytes(500 * 2 ** 20), '500 MiB');
    assert.strictEqual(C.fmtBytes(12 * 2 ** 30), '12 GiB');
    // U40: smoothing helper — centered mean, nulls skipped not shifted
    assert.deepStrictEqual(C.movingAverage([0, 6, 0, 6, 0], 3),
                           [3, 2, 4, 2, 3]);
    assert.deepStrictEqual(C.movingAverage([null, 4, null], 3),
                           [4, 4, 4]);
    assert.deepStrictEqual(C.movingAverage([null, null], 3), [null, null]);
    assert.deepStrictEqual(C.movingAverage([1, 2], 3), [1, 2]);   // short col passthrough
    assert.ok(C.smoothKey('rate.requests_s') && C.smoothKey('queue.waiting')
              && C.smoothKey('engines.active_requests'));
    assert.ok(!C.smoothKey('avg_generation_tps') && !C.smoothKey('sys.used_bytes'));
    assert.strictEqual(C.fmtDuration(3725), '1h 2m');
    assert.strictEqual(C.fmtDuration(75), '1m 15s');
    assert.strictEqual(C.fmtNumber(1234567), '1,234,567');
});

test('pruneOlderThan drops stale samples', () => {
    const now = Date.now();
    const h = [{ time: now - 5000 }, { time: now - 2000 }, { time: now }];
    C.pruneOlderThan(h, now - 3000);
    assert.strictEqual(h.length, 2);
});

test('normalize keeps live request rows guarded', () => {
    const s = snap(raw({ active_models: { models: [{
        id: 'mm', actual_size: 1, active_requests: 1,
        prefilling: [{ request_id: 'p1', prompt_tokens: 120 }, { request_id: '', prompt_tokens: 5 }],
        generating: [{ request_id: 'g1', prompt_tokens: 50, generated_tokens: 9, tokens_per_second: 30.5, elapsed_seconds: 0.3 }],
    }], model_memory_used: 0, model_memory_max: 1, memory_pressure: {} } }));
    assert.strictEqual(s.models[0].prefilling.length, 1); // empty rid dropped
    assert.strictEqual(s.models[0].prefilling[0].prompt, 120);
    assert.strictEqual(s.models[0].generating[0].generated, 9);
    assert.strictEqual(s.models[0].generating[0].tps, 30.5);
});

test('normalize: per-request phase + dflash passthrough (U16-rework)', () => {
    const s = snap(raw({ active_models: { models: [{
        id: 'mm', actual_size: 1, active_requests: 1,
        dflash: { speculation: { last: { acceptance_ratio: 0.8 } },
                  pairing_warning: null },
        prefilling: [{ request_id: 'p1', phase: 'specprefill_scoring',
                       detail: 'scoring draft tokens', cached_tokens: 40,
                       processed: 10, total: 100 },
                     { request_id: 'p2' }],   // no phase: plain prefill
        generating: [],
    }], model_memory_used: 0, model_memory_max: 1, memory_pressure: {} } }));
    const m0 = s.models[0];
    assert.strictEqual(m0.dflash.speculation.last.acceptance_ratio, 0.8);
    assert.strictEqual(m0.prefilling[0].phase, 'specprefill_scoring');
    assert.strictEqual(m0.prefilling[0].detail, 'scoring draft tokens');
    assert.strictEqual(m0.prefilling[0].cached, 40);
    assert.strictEqual(m0.prefilling[1].phase, '');   // absent -> plain prefill
    const s2 = snap(raw());                            // no dflash key at all
    assert.strictEqual(s2.models.length, 0);
});

test('request tracker records finished requests', () => {
    const t = C.createRequestTracker(100);
    const row = rid => ({ rid, prompt: 100, generated: 5, tps: 10, elapsed: 0.5 });
    const snapWith = rows => ({ models: [{ id: 'm', prefilling: [], generating: rows }] });
    t.observe(snapWith([row('a'), row('b')]));
    assert.strictEqual(t.inflightCount(), 2);
    t.observe(snapWith([row('a')]));               // b finished
    assert.strictEqual(t.samples.completion.length, 1);
    assert.strictEqual(t.samples.prompt.length, 1);
    t.observe(snapWith([]));                        // a finished too
    assert.strictEqual(t.samples.completion.length, 2);
    assert.strictEqual(t.inflightCount(), 0);
});

test('percentile and mean', () => {
    const vals = [10, 20, 30, 40, 50];
    assert.strictEqual(C.percentile(vals, 0), 10);
    assert.strictEqual(C.percentile(vals, 100), 50);
    assert.strictEqual(C.percentile(vals, 50), 30);
    assert.strictEqual(Math.round(C.percentile(vals, 90)), 46);
    assert.strictEqual(C.percentile([], 50), null);
    assert.strictEqual(C.mean(vals), 30);
    assert.strictEqual(C.mean([]), null);
});

test('layout persistence and clamping', () => {
    const items = {};
    const store = { getItem: k => items[k], setItem: (k, v) => items[k] = v };
    assert.deepStrictEqual(C.loadLayout(store), C.LAYOUT_DEFAULTS);
    items[C.LAYOUT_KEY] = 'broken{';
    assert.deepStrictEqual(C.loadLayout(store), C.LAYOUT_DEFAULTS);
    items[C.LAYOUT_KEY] = JSON.stringify({ cols: 9, chartWindowSec: 123, intervalMs: 'x',
        logsHideDebug: false, percentile: 'p42', collapsed: { models: true } });
    const l = C.loadLayout(store);
    assert.strictEqual(l.cols, undefined);         // v2: cols is dead (GridStack owns width)
    assert.strictEqual(l.chartWindowSec, 300);
    assert.strictEqual(l.intervalMs, 1000);
    assert.strictEqual(l.logsHideDebug, false);    // valid override kept
    assert.strictEqual(l.percentile, 'p95');
    assert.strictEqual(l.collapsed.models, true);
    assert.strictEqual(C.clampSpan(2, 1), 1);
    assert.strictEqual(C.clampSpan(2, 5), 2);
    assert.strictEqual(C.clampSpan(5, 3), 3);
});

test('F-032: loadLayout passes mergedBlocks through (removed cards must not resurrect)', () => {
    const items = {};
    const store = { getItem: k => items[k], setItem: (k, v) => items[k] = v };
    // absent -> stays absent (defaults untouched)
    assert.strictEqual('mergedBlocks' in C.loadLayout(store), false);
    // garbage -> dropped
    items[C.LAYOUT_KEY] = JSON.stringify({ mergedBlocks: 'nope' });
    assert.strictEqual('mergedBlocks' in C.loadLayout(store), false);
    // array -> survives round-trip
    items[C.LAYOUT_KEY] = JSON.stringify({ blocks: [{ id: 'live', x: 0, y: 0, w: 8, h: 4 }],
        mergedBlocks: ['live', 'feed'] });
    const l = C.loadLayout(store);
    assert.deepStrictEqual(l.mergedBlocks, ['live', 'feed']);
});

// GridStack layout contract (uplift twin of classic dashboard_layout.js).
test('layout: every met-* block id matches a catalogue card', () => {
    for (const id of UPL.BLOCK_IDS.filter(i => i.startsWith('met-')))
        assert.ok(C.blockMetricKey(id), id + ' unknown to the metric catalogue');
    for (const def of C.EXPLORE_METRICS)
        assert.ok(UPL.BLOCK_IDS.includes(C.metricBlockId(def.key)),
            C.metricBlockId(def.key) + ' missing from BLOCK_IDS');
});

// The module attaches to globalThis in Node (no window), same as the page.
require('../omlx_uplift/static/uplift_layout.js');
const UPL = globalThis.UpliftLayout;
test('uplift layout: default layout covers every block once', () => {
    const d = UPL.defaultLayout();
    // U24: every block ships on the default board EXCEPT plain tray-only
    // ones; the gated macmon cards (GATED_IDS) are the exception — hidden
    // parked slots that reveal themselves on data. TRAY_ONLY_IDS means
    // "never auto-appended into a SAVED layout" — saved-layout rule only.
    const expected = UPL.BLOCK_IDS.filter(
        id => !UPL.TRAY_ONLY_IDS.includes(id) || UPL.GATED_IDS.includes(id));
    assert.deepStrictEqual(d.blocks.map(b => b.id).sort(), [...expected].sort());
    for (const id of ['met-pfx-token-hit-pct', 'met-pfx-lookup-hit-pct',
                      'met-spec-saved-tokens-min', 'met-queue-waiting'])
        assert.ok(!d.blocks.some(b => b.id === id), id + ' must stay tray-only');
    for (const b of d.blocks) {
        assert.ok(b.w >= UPL.minWFor(b.id) && b.w <= UPL.COLUMNS, b.id + ' w out of range');
        assert.ok(b.x >= 0 && b.x + b.w <= UPL.COLUMNS, b.id + ' exceeds grid');
    }
});
test('uplift layout: small stat tiles clamp to 4, others to 6', () => {
    assert.strictEqual(UPL.minWFor('gen'), 4);
    assert.strictEqual(UPL.minWFor('prefill'), 4);
    assert.strictEqual(UPL.minWFor('requests'), 4);
    assert.strictEqual(UPL.minWFor('tokens'), 4);
    assert.strictEqual(UPL.minWFor('cache'), 4);
    assert.strictEqual(UPL.minWFor('chart-tps'), 6);
    assert.strictEqual(UPL.minWFor('live'), 6);
    const n = UPL.normalizeLayout({ blocks: [
        { id: 'gen', x: 0, y: 0, w: 2 },       // below small floor -> 4
        { id: 'live', x: 8, y: 0, w: 2 },      // below big floor -> 6
    ] });
    assert.strictEqual(n.blocks[0].w, 4);
    assert.strictEqual(n.blocks[1].w, 6);
});
test('uplift layout: normalize resolves overlapping blocks deterministically', () => {
    // tokens and prefill both at 0,0 (the stale-storage case) — one must
    // be pushed down, and running normalize twice must not move anything
    // further (idempotent = Reset renders identically every time)
    const a = UPL.normalizeLayout({ blocks: [
        { id: 'prefill', x: 0, y: 0, w: 4, h: 20 },
        { id: 'tokens', x: 0, y: 0, w: 4, h: 20 },
        { id: 'gen', x: 4, y: 0, w: 4, h: 20 },
    ] });
    const placed = a.blocks;
    for (let i = 0; i < placed.length; i++)
        for (let j = i + 1; j < placed.length; j++) {
            const p = placed[i], q = placed[j];
            const hit = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
            assert.ok(!hit, `${p.id} overlaps ${q.id}`);
        }
    const b = UPL.normalizeLayout(a);
    assert.deepStrictEqual(b.blocks, a.blocks);
    // no overlap, no move
    const clean = UPL.normalizeLayout({ blocks: [
        { id: 'reqfeed', x: 0, y: 0, w: 24, h: 18 },
        { id: 'gen', x: 0, y: 18, w: 4, h: 20 },
    ] });
    assert.deepStrictEqual(clean.blocks.map(x => [x.id, x.y]), [['reqfeed', 0], ['gen', 18]]);
});
test('uplift layout: row-mates move as one band (staircase regression, 2026-09-29)', () => {
    // One block of a row pushed down must drag its row-mates with it, and
    // a drifted row (y differing by <=2 cells) snaps back to one band.
    // User repro: dropping temperature onto the top row skewed prefill/gen
    // against tokens/cache and every row below inherited a 1-cell drift —
    // the board rendered as a staircase of half-empty rows.
    const r = UPL.normalizeLayout({ blocks: [
        { id: 'prefill', x: 0, y: 10, w: 4, h: 20 },
        { id: 'gen', x: 4, y: 10, w: 4, h: 20 },          // row-mates, pushed together
        { id: 'tokens', x: 8, y: 0, w: 4, h: 20 },        // overlaps prefill's old slot
        { id: 'requests', x: 0, y: 31, w: 4, h: 20 },     // drifted 1 cell from row below
        { id: 'cache', x: 4, y: 32, w: 4, h: 20 },
    ] });
    const y = Object.fromEntries(r.blocks.map(b => [b.id, b.y]));
    assert.equal(y.prefill, y.gen);            // band moves as one
    assert.equal(y.requests, y.cache);         // 1-cell drift repaired
    // tokens owns x8..; prefill x0..4 touches nothing above, but lands ON
    // the (drifted) requests/cache row band, so that band shifts below it.
    assert.ok(y.prefill >= 10);
    assert.ok(y.requests >= y.prefill + 20);   // lower band clears the upper
    const r2 = UPL.normalizeLayout(r);         // idempotent
    assert.deepStrictEqual(r2.blocks, r.blocks);
    // a genuine freeform offset (3+ cells) stays untouched — no banding
    const free = UPL.normalizeLayout({ blocks: [
        { id: 'gen', x: 0, y: 0, w: 6, h: 20 },
        { id: 'live', x: 8, y: 4, w: 6, h: 20 },
    ] });
    assert.deepStrictEqual(free.blocks.map(b => b.y), [0, 4]);
});
test('uplift layout: normalize drops unknown/dup blocks, clamps geometry', () => {
    const n = UPL.normalizeLayout({ width: 'banana', blocks: [
        { id: 'gen', x: -3, y: -1, w: 99 },
        { id: 'gen', x: 0, y: 5, w: 6 },          // duplicate -> dropped
        { id: 'ghost', x: 0, y: 0, w: 24 },        // unknown -> dropped
        { id: 'reqfeed', x: 20, y: 2, w: 10 },     // x+w>24 -> x clamped
    ] });
    assert.strictEqual(n.width, 'default');
    assert.deepStrictEqual(n.blocks.map(b => b.id), ['gen', 'reqfeed']);
    assert.strictEqual(n.blocks[0].w, UPL.COLUMNS);
    assert.strictEqual(n.blocks[0].x, 0);
    assert.strictEqual(n.blocks[1].x, 14);
    assert.deepStrictEqual(UPL.normalizeLayout(null), UPL.defaultLayout());
    assert.strictEqual(UPL.widthClass('wider'), 'wider');
    assert.strictEqual(UPL.widthClass('zzz'), 'default');
});

test('normalize passes through server request_stats when present', () => {
    const s = snap(raw({ request_stats: { prompt_tokens: { avg: 10, p95: 20, n: 5 },
        first_token_ms: { avg: 300, n: 5 }, errors_total: 1, source: 'mock' } }));
    assert.ok(s.requestStats);
    assert.strictEqual(s.requestStats.prompt_tokens.p95, 20);
    assert.strictEqual(s.requestStats.errors_total, 1);
    const plain = snap(raw());
    assert.strictEqual(plain.requestStats, null);   // real backend: absent
});

test('normalize extracts per-model runtime cache rows', () => {
    const s = snap(raw({ runtime_cache: { models: [
        { id: 'm1', total_size_bytes: 5e9, hot_cache_size_bytes: 3e9, hot_cache_max_bytes: 10e9 },
        { id: 'm2' },
    ] } }));
    assert.equal(s.cacheModels.length, 2);
    assert.equal(s.cacheModels[0].hotBytes, 3e9);
    assert.equal(s.cacheModels[1].hotBytes, null);
});

// F-019: FastAPI 422 detail arrays must render as readable text, not "[object Object]".
test('errorText: string detail passes through', () => {
    assert.equal(C.errorText({ detail: 'boom' }), 'boom');
    assert.equal(C.errorText({ error: 'nope' }), 'nope');
});
test('errorText: 422 array flattened with loc', () => {
    const b = { detail: [{ type: 'missing', loc: ['body', 'display_name'], msg: 'Field required' }] };
    assert.equal(C.errorText(b), 'display_name: Field required');
});
test('errorText: empty/garbage bodies do not throw', () => {
    assert.equal(C.errorText({}), '');
    assert.equal(C.errorText(null), '');
    assert.equal(C.errorText({ detail: {} }), '{}');
});

// F-020: prefs and layout once shared the corrupted literal '***' storage key,
// so saving the theme wiped the layout blob (cols/order/collapsed lost).
test('keys: PREFS_KEY and LAYOUT_KEY are distinct well-formed keys', () => {
    assert.notEqual(C.PREFS_KEY, C.LAYOUT_KEY);
    assert.match(C.PREFS_KEY, /^omlx-uplift-prefs-v\d+$/);
    assert.match(C.LAYOUT_KEY, /^omlx-uplift-layout-v\d+$/);
});
test('prefs save does not clobber layout storage', () => {
    const items = {};
    const store = { getItem: k => items[k], setItem: (k, v) => items[k] = v };
    C.saveLayout(store, { ...C.LAYOUT_DEFAULTS, chartWindowSec: 900 });
    C.savePrefs(store, { theme: 'dark' });
    assert.equal(C.loadLayout(store).chartWindowSec, 900);
    assert.equal(C.loadPrefs(store).theme, 'dark');
});

/* ---------- mergeHistory: server history -> live chart columns ---------- */
const H = C.mergeHistory;
test('mergeHistory: backfills older history, keeps newer live points', () => {
    const now = 1_000_000;
    const hist = [{ ts: now - 5000, v: 10, res: 'fine' }, { ts: now - 3000, v: 12, res: 'fine' }];
    const liveTs = [now - 1000], liveV = [20];
    const m = H(hist, liveTs, liveV, 3600, now);
    assert.deepEqual(m.ts, [now - 5000, now - 3000, now - 1000]);
    assert.deepEqual(m.v, [10, 12, 20]);
});
test('mergeHistory: live points OLDER than newest history are dropped (dedupe)', () => {
    const now = 1_000_000;
    const hist = [{ ts: now - 2000, v: 9, res: 'hourly' }];
    const m = H(hist, [now - 9000, now - 2500], [1, 2], 3600, now);
    assert.deepEqual(m.ts, [now - 2000]);           // live covered by server
    assert.equal(m.boundary, now - 2000);           // coarse boundary reported
});
test('mergeHistory: window cutoff applied to both layers, future points dropped', () => {
    const now = 1_000_000;
    const hist = [{ ts: now - 9_999_999, v: 1, res: 'hourly' }, { ts: now + 60_000, v: 2, res: 'fine' }];
    const m = H(hist, [now - 9_999_999], [7], 3600, now);
    assert.deepEqual(m.ts, []);
});
test('mergeHistory: malformed points ignored; empty inputs safe', () => {
    const m = H([null, { ts: 'x' }, { v: 3 }, { ts: 5, v: 'z' }], [], [], 60, 10_000);
    assert.deepEqual(m.ts, []);
    const e = H([], [], [], 60, 10_000);
    assert.deepEqual(e.ts, []);
    assert.equal(e.boundary, 0);
});

/* ---------- i18n: t() catalog lookup + interpolation ---------- */
test('t(): fallback to key when missing, English default', () => {
    C.setLocale('en', {});
    assert.strictEqual(C.t('uplift.nope'), 'uplift.nope');
});
test('t(): direct lookup + interpolation', () => {
    C.setLocale('cs', { 'uplift.greet': 'Ahoj {name}', 'common.cancel': 'Zrušit' });
    assert.strictEqual(C.t('common.cancel'), 'Zrušit');
    assert.strictEqual(C.t('uplift.greet', { name: 'Petra' }), 'Ahoj Petra');
});
test('t(): missing interpolation var keeps placeholder; null vars ok', () => {
    C.setLocale('en', { k: 'a{b}c' });
    assert.strictEqual(C.t('k', {}), 'a{b}c');
    assert.strictEqual(C.t('k', { b: null }), 'a{b}c');
    assert.strictEqual(C.t('k', { b: 0 }), 'a0c');   // 0 is a legit value
});
test('setLocale(): bad args reset to en/{}; getLocale reflects last call', () => {
    C.setLocale('ja', { a: 'あ' });
    assert.strictEqual(C.getLocale().lang, 'ja');
    C.setLocale(null, undefined);
    assert.deepStrictEqual(C.getLocale(), { lang: 'en', strings: {} });
});

// ---- metric cards: per-card windows + catalogue ----
test('layout: 7d/30d windows accepted, junk rejected', () => {
    assert.ok(C.LAYOUT_WINDOWS.includes(604800));
    assert.ok(C.LAYOUT_WINDOWS.includes(2592000));
    const store = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
    store.setItem(C.LAYOUT_KEY, JSON.stringify({ chartWindowSec: 2592000 }));
    assert.strictEqual(C.loadLayout(store).chartWindowSec, 2592000);
    store.setItem(C.LAYOUT_KEY, JSON.stringify({ chartWindowSec: 12345 }));
    assert.strictEqual(C.loadLayout(store).chartWindowSec, C.LAYOUT_DEFAULTS.chartWindowSec);
});
test('layout: metricWin keeps valid per-card windows, drops junk', () => {
    const store = k => { const s = { _d: {}, getItem(x) { return this._d[x] ?? null; }, setItem(x, v) { this._d[x] = v; } };
        s._d[C.LAYOUT_KEY] = JSON.stringify(k); return s; };
    assert.deepStrictEqual(C.loadLayout(store({})).metricWin, {});
    const ok = { 'met-sys-used-bytes': 86400, 'chart-tps': 604800 };
    assert.deepStrictEqual(C.loadLayout(store({ metricWin: ok })).metricWin, ok);
    assert.deepStrictEqual(   // bogus block id / bogus window / wrong types
        C.loadLayout(store({ metricWin: { 'met-nope': 3600, 'met-gen-x': '1h', 'met-sys-used-bytes': 7 } })).metricWin,
        {});
});
test('metricBlockId maps every catalogue key to a legal block id and back', () => {
    for (const def of C.EXPLORE_METRICS) {
        const id = C.metricBlockId(def.key);
        assert.match(id, /^met-[a-z0-9-]+$/);
        assert.strictEqual(C.blockMetricKey(id), def.key, id + ' must round-trip');
    }
    assert.strictEqual(C.blockMetricKey('chart-tps'), null);
    assert.strictEqual(C.blockMetricKey('met-bogus'), null);
});
test('explore catalogue: unique keys, one fmt each, exports agree', () => {
    const keys = C.EXPLORE_METRICS.map(m => m.key);
    assert.strictEqual(new Set(keys).size, keys.length);
    // U19: EXPLORE_KEYS is the union of every series key (multi-series
    // defs list them in def.series); primaries must all be present.
    const union = Array.from(new Set(C.EXPLORE_METRICS.flatMap(
        m => m.series ? m.series.map(s => s.key) : [m.key])));
    assert.deepStrictEqual(C.EXPLORE_KEYS, union);
    for (const k of keys) assert.ok(union.includes(k), k + ' (primary) must be in EXPLORE_KEYS');
    for (const k of ['avg_generation_tps', 'sys.used_bytes', 'cache_efficiency'])
        assert.ok(keys.includes(k), k + ' must be selectable');
    // U31-U36: retired cards must NOT be selectable (removed from the tray
    // too); their collector keys stay in the store, the catalogue is gone.
    // U39: cache.total_bytes joined them — the collector stopped sampling it.
    for (const k of ['avg_prefill_tps', 'engines.active_requests',
                     'engines.loaded', 'sys.percent', 'sys.total_bytes',
                     'cache.total_bytes'])
        assert.ok(!keys.includes(k), k + ' card must stay retired');
});

/* F-035 drift test: restoring a block from the tray must rebuild the pill
   list, otherwise a stale pill lingers after its card is back on the board.
   Behavioral harness needs full GridStack; assert the call-order contract
   in _onTrayDrop instead (same style as globalspec.test.cjs source scans). */
test('F-035: _onTrayDrop calls renderTray after placing the card', () => {
    const fs = require('fs');
    const path = require('path');
    const src = allStaticJs();  // PH2-1 stage 0: whole static JS surface
    const m = src.match(/function _onTrayDrop\(node\) \{[\s\S]*?\n\}/);
    assert.ok(m, '_onTrayDrop function found');
    const place = m[0].indexOf('_placeCard(');
    const tray = m[0].indexOf('renderTray()');
    assert.ok(place >= 0, '_onTrayDrop places the card');
    assert.ok(tray >= 0, '_onTrayDrop refreshes the tray (F-035)');
    assert.ok(tray > place, 'renderTray runs AFTER the card is placed');
});

/* TRAY-1 + LAYOUT-SNAP drift test: re-adding a removed card must not
   exceed the width it had on the board, but the fitted drop placeholder
   (live gap) has final say when it is narrower. removeCard must stash
   gridstackNode.w/h and _onTrayDrop must cap with the stashed width. */
test('TRAY-1: tray re-add caps at the removed card width, gap can narrow it', () => {
    const fs = require('fs');
    const path = require('path');
    const src = allStaticJs();  // PH2-1 stage 0: whole static JS surface
    const rem = src.match(/function removeCard\(id\) \{[\s\S]*?\n\}/);
    assert.ok(rem, 'removeCard function found');
    assert.ok(/_trayGeo\.set\(id, \{ w: el\.gridstackNode\.w, h: el\.gridstackNode\.h \}\)/.test(rem[0]),
        'removeCard stashes the removed node width and height');
    const drop = src.match(/function _onTrayDrop\(node\) \{[\s\S]*?\n\}/);
    assert.ok(drop, '_onTrayDrop function found');
    assert.ok(/_trayGeo\.get\(id\)/.test(drop[0]), '_onTrayDrop reads the stashed width');
    assert.ok(/Math\.min\(geo\.w, node\.w\)/.test(drop[0]),
        'stashed width caps the drop, the fitted placeholder can narrow it');
    const place = drop[0].indexOf('_placeCard(');
    const stash = drop[0].indexOf('_trayGeo.delete(id)');
    assert.ok(stash >= 0 && stash < place, 'stash is consumed once, before placing');
});

/* LAYOUT-SNAP drift tests (user 2026-09-29):
   (a) the drop placeholder must carry the card's real geometry — pills ship
       data-gs-widget, not a fixed gs-w=12/gs-h=1 stub;
   (b) live drag over the board runs _fitDropPreview (shrink into narrow
       gaps + show real card contents);
   (c) view-mode rows pack with the cursor — no preserved gaps, no saved-h
       floor ("cards must snap together vertically"). */
test('LAYOUT-SNAP: pills ship real geometry, drags fit the placeholder live', () => {
    const src = allStaticJs();
    const tray = src.match(/function renderTray\(\) \{[\s\S]*?\n\}/);
    assert.ok(tray, 'renderTray function found');
    assert.ok(/setAttribute\('data-gs-widget'/.test(tray[0]),
        'pills carry data-gs-widget (GridStack sidebar contract)');
    const opts = src.match(/function _dragInOpts\(\) \{[\s\S]*?\n\}/);
    assert.ok(opts, '_dragInOpts found');
    assert.ok(/drag: \(\) => \{ if \(dashEditing && !dashApplying\) _fitDropPreview\(\); \}/.test(opts[0]),
        'dragIn drag callback fits the placeholder live');
    assert.ok(/function _fitDropPreview\(\)/.test(src), '_fitDropPreview defined');
    assert.ok(/_freeOf\(n, n\.x, n\.y, w, h\)/.test(src),
        'preview shrinks to widest collision-free width (down to minW)');
});
test('LAYOUT-SNAP: _rowAlign packs rows with the cursor (no kept gaps, no h floor)', () => {
    const src = allStaticJs();
    const m = src.match(/function _rowAlign\(\)[\s\S]*?\n}/);
    assert.ok(m, '_rowAlign found');
    assert.ok(!/Math\.max\(y, cursor\)/.test(m[0]), 'saved gaps are not preserved');
    assert.ok(!/cursor \+=/.test(m[0]), 'no single global stacking cursor (2D pack instead)');
    assert.ok(/UPL\.packRows\(/.test(m[0]), 'rows are packed by UpliftLayout.packRows');
    assert.ok(!/Math\.max\(m\.h, demand\)/.test(m[0]), 'saved height is no longer a floor');
});
/* PARTIAL-BAND regression (user 2026-09-29, second report): adding the
   temperature/power cards top-right still broke the whole board after a
   reload. resolveOverlaps (bf68bd3) fixed only saved overlaps; the real
   generator was _rowAlign's ONE global cursor — every band below a
   partial-width band stacked beneath its tallest neighbour (staircase +
   dead column gaps). packRows drops each band to the lowest y that clears
   ONLY what it horizontally overlaps. */
test('PACK-2D: partial-width band does not staircase the bands below it', () => {
    // Board shaped like the user repro: row0 = two half-width metric cards
    // (x0-12) beside a stat-tile band partner; below them independent rows.
    const plan = UPL.packRows([
        { members: [{ x: 0, w: 6 }, { x: 6, w: 6 }, { x: 12, w: 4 }, { x: 16, w: 8 }], h: 20 },
        { members: [{ x: 12, w: 12 }], h: 36 },          // right column: sits under the tiles
        { members: [{ x: 0, w: 12 }], h: 36 },           // left column: may sit beside chart-mem
        { members: [{ x: 0, w: 12 }, { x: 12, w: 12 }], h: 33 },
    ]);
    assert.equal(plan[0].y, 0);
    assert.equal(plan[1].y, 20);    // right row starts under its own column
    assert.equal(plan[2].y, 20);    // left row starts under ITS column, not behind chart-mem
    assert.equal(plan[3].y, 56);    // full-width row waits for both columns (20+36)
    // idempotent: re-feeding the placed bands yields identical y
    const again = UPL.packRows(plan.map(p => ({ members: p.members, h: p.h })));
    assert.deepStrictEqual(again.map(p => p.y), plan.map(p => p.y));
    // full-width bands still butt together exactly like the old cursor
    const stack = UPL.packRows([
        { members: [{ x: 0, w: 24 }], h: 10 },
        { members: [{ x: 0, w: 24 }], h: 15 },
        { members: [{ x: 0, w: 24 }], h: 8 },
    ]);
    assert.deepStrictEqual(stack.map(p => p.y), [0, 10, 25]);
    // narrow breakpoint: every card is x0 w1 — stacks sequentially
    const narrow = UPL.packRows([
        { members: [{ x: 0, w: 1 }], h: 10 },
        { members: [{ x: 0, w: 1 }], h: 15 },
    ]);
    assert.deepStrictEqual(narrow.map(p => p.y), [0, 10]);
});
/* ROWBAND-1 (user 2026-10-02): the late-reveal pile-up. Parked gated cards
   are NOT reserved during the boot pack, so the stat-tile row legally packs
   UP into their promised slot (an absent macmon must leave no dead band).
   When the probe later reveals power/temp at the contract y, the near-miss
   y (|dy| <= 2) plus horizontal overlap used to FUSE the two rows into one
   rigid band — seven cards sharing one rect, power/temp rendered on top of
   the tiles. Band membership must reject a candidate whose RECT collides
   with a member: true row-mates tile horizontally and can never rect-hit. */
test('ROWBAND-1: near-y rect collision splits bands instead of fusing them', () => {
    const src = allStaticJs();
    const m = src.match(/function _rowAlign\(\)[\s\S]*?\n}/);
    assert.ok(m, '_rowAlign found');
    assert.ok(/rectsTouch/.test(m[0]), 'band membership tests rect collision');
    // the collision reject must sit inside the band loop, before the merge
    const loop = m[0].slice(m[0].indexOf('for (const b of cand)'), m[0].indexOf('bands[idx].members.push'));
    assert.ok(/rectsTouch\(m, b\)/.test(loop),
        'a rect-colliding candidate is never merged into the band');
    assert.ok(/if \(idx < 0\) \{ bands\.push\(/.test(m[0]),
        'a rejected candidate opens its own band');
    // drift repair must SURVIVE the split: true row-mates tile
    // horizontally, so a |dy|<=2 pair with only x-adjacency still fuses
    // (rectsTouch is x-STRICT; packRows then gives the later band a lower y)
    const fused = UPL.packRows([
        { members: [{ x: 0, w: 12 }, { x: 12, w: 12 }], h: 18 },  // gated row
        { members: [{ x: 0, w: 4 }, { x: 4, w: 4 }, { x: 8, w: 4 },
                    { x: 12, w: 4 }, { x: 16, w: 8 }], h: 18 },   // tile row
    ]);
    assert.deepStrictEqual(fused.map(p => p.y), [0, 18],
        'the split bands pack as two stacked rows, not one');
});
test('DROP-REGISTRATION: tray drops join upLayout.blocks and Cancel reverts', () => {
    const src = allStaticJs();
    const drop = src.match(/function _onTrayDrop\(node\) \{[\s\S]*?\n\}/);
    assert.ok(drop, '_onTrayDrop found');
    assert.ok(/upLayout\.blocks\.push\(geoRec\)/.test(drop[0]),
        'dropped card is registered in the layout contract (row planner + watchdog see it)');
    const start = src.match(/function startDashEdit\(\) \{[\s\S]*?\n\}/);
    assert.ok(/dashPreEdit = JSON\.parse\(JSON\.stringify\(upLayout\)\)/.test(start[0]),
        'edit start snapshots the contract');
    const cancel = src.match(/function cancelDashEdit\(\) \{[\s\S]*?\n\}/);
    assert.ok(/upLayout = dashPreEdit/.test(cancel[0]),
        'Cancel restores the contract (dropped-only cards do not resurrect)');
});
/* U24 (user 2026-09-30): the power/temperature cards always exist — the
   default layout carries them in a dedicated row and boot creates their DOM.
   macmon presence is a data flag (the /metrics/latest probe, same pattern as
   the header chips), never a layout rewrite: unseen data = card born parked
   (hidden, no slot, no tray pill, no fetch), seen data = probe places it in
   its default slot. Saved custom layouts must keep the old rule: blocks are
   never auto-appended (TRAY_ONLY merge skip in currentBlockLayout). */
test('U24: gated cards ship on the default board, gated by a data flag', () => {
    const src = allStaticJs();
    const d = UPL.defaultLayout();
    for (const id of ['met-pwr-total-w', 'met-therm-cpu-temp-c'])
        assert.ok(d.blocks.some(b => b.id === id), id + ' must ship on the default board');
    // boot creates gated cards too, parked until their data has been seen
    assert.ok(/CH\.createMetricCard\(def, !!\(def\.gated && !CH\.gatedSeen\(def\.key\)\)\)/.test(src),
        'boot creates gated cards born parked when data unseen');
    // the probe REVEALS (never creates): flag flips on seen data
    assert.ok(/gateSeen\.add\(d\.key\)/.test(src) && /CH_GLUE\.revealGatedCard\(cid\)/.test(src),
        'probe flips the presence flag and reveals the parked card');
    // hidden gated cards cost nothing: no fetch, no draw
    assert.ok(/function metricFetch\(id, force\) \{[\s\S]*?_gateHidden\(e\.def\)/.test(src),
        'metricFetch skips an unrevealed gated card');
    // custom saved layouts unchanged: gated blocks still never auto-append
    assert.ok(/if \(UPL\.TRAY_ONLY_IDS\.includes\(def\.id\)\) continue;/.test(src),
        'saved-layout merge still skips tray-only/gated blocks');
});
/* GATED-EMPTY (user 2026-09-29): temperature/power cards load EMPTY after
   a refresh (readout '—' until a timeframe chip is clicked). The metric
   cache is keyed by WINDOW and shared across cards: the boot fetch fills
   1h with the always-on cards' keys, and the gated cards — whose plots are
   force-filled only when the macmon probe reveals them (U24) — were served
   from that "fresh" cache WITHOUT their own keys. metricFetch must treat a
   window missing one of the card's keys as not fresh, and must remember
   answered-but-absent keys as empty so a dead collector cannot pin the
   window to forever-refetching. */
test('GATED-EMPTY: metricFetch re-fetches a window missing the card keys', () => {
    const src = allStaticJs();
    const f = src.match(/function metricFetch\(id, force\) \{[\s\S]*?\n\}/);
    assert.ok(f, 'metricFetch found');
    assert.ok(/const missing = keys\.some\(k => !\(k in cache\.data\)\);/.test(f[0]),
        'fresh-cache shortcut requires every requested key present');
    assert.ok(/if \(!force && !stale && !missing\)/.test(f[0]),
        'missing keys override window freshness');
    assert.ok(/cache\.data\[k\] = \[\]/.test(f[0]),
        'answered-but-absent keys remembered as empty (no per-tick refetch storm)');
});
test('LAYOUT-SNAP: _snapUp runs after drops, removals and drags', () => {
    const src = allStaticJs();
    assert.ok(/function _snapUp\(\)/.test(src), '_snapUp defined');
    for (const re of [
        /function _onTrayDrop\(node\) \{[\s\S]*?_snapUp\(\);[\s\S]*?\n\}/,
        /function removeCard\(id\) \{[\s\S]*?_snapUp\(\);[\s\S]*?\n\}/,
        /dashGrid\.on\('dragstop resizestop'[\s\S]*?_snapUp\(\);/,
    ]) {
        assert.ok(re.test(src), 'gravity pass wired: ' + re);
    }
});

/* UPLOADER-1 drift test: mode badges (dl-mode/qz-mode/up-mode/hm-sub) are
   JS-built by updateModeLabels(); loadLocale re-translates everything else
   via applyI18n + relabelExplore, so it MUST re-run updateModeLabels too —
   otherwise the badges flash raw i18n keys until some unrelated re-render. */
test('UPLOADER-1: loadLocale re-labels JS-built mode badges', () => {
    const fs = require('fs');
    const path = require('path');
    const src = allStaticJs();  // PH2-1 stage 0: whole static JS surface
    const m = src.match(/async function loadLocale\(lang\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'loadLocale function found');
    const body = m[0];
    const relabel = body.indexOf('relabelExplore()');
    const mode = body.indexOf('updateModeLabels()');
    assert.ok(relabel >= 0, 'loadLocale re-labels explore chips (pre-existing contract)');
    assert.ok(mode >= 0, 'loadLocale re-labels mode badges (UPLOADER-1)');
    assert.ok(mode > relabel, 'mode badges relabel after the catalog swap');
});

/* GS-1 drift test: settings labels render before the locale fetch may
   resolve (settings poll vs locale fetch race), so they MUST use C.tf with
   an English fallback — bare C.t renders the raw key until the next poll. */
test('GS-1: global-settings labels use C.tf fallback, never bare C.t', () => {
    const fs = require('fs');
    const path = require('path');
    const src = allStaticJs();  // PH2-1 stage 0: whole static JS surface
    const bare = src.match(/C\.t\('uplift\.gs\.[^']*'\)/g) || [];
    assert.deepStrictEqual(bare, [], 'no bare C.t(uplift.gs.*) calls: ' + bare.join(', '));
});

/* F-035b drift test: tray pills are created AFTER grid init, so the one-time
   setupDragIn at boot can never bind them; renderTray must re-run it. */
test('F-035b: renderTray re-binds setupDragIn for late-created pills', () => {
    const fs = require('fs');
    const path = require('path');
    const src = allStaticJs();  // PH2-1 stage 0: whole static JS surface
    const m = src.match(/function renderTray\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'renderTray function found');
    assert.ok(/setupDragIn\('\.dash-tray-pill'/.test(m[0]),
        'renderTray calls GridStack.setupDragIn on .dash-tray-pill (F-035b)');
});

/* F-036 drift test: the three geometry writers must clamp to 1 column at
   the c=1 breakpoint, else saved 24-col widths overflow the viewport. */
test('F-036: all geometry writers clamp x/w at the 1-column breakpoint', () => {
    const fs = require('fs');
    const path = require('path');
    const src = allStaticJs();  // PH2-1 stage 0: whole static JS surface
    const clamp = /getColumn\(\) === 1/;
    for (const [name, re] of [
        ['applyUpliftLayout', /function applyUpliftLayout[\s\S]*?\n}/],
        ['_rowAlign', /function _rowAlign\(\)[\s\S]*?\n}/],
        ['watchdog', /if \(dashEditing \|\| dashApplying\) return;[\s\S]*?\n {8}\}/],
    ]) {
        const m = src.match(re);
        assert.ok(m, name + ' found');
        assert.ok(clamp.test(m[0]), name + ' clamps geometry at c=1 (F-036)');
    }
});
