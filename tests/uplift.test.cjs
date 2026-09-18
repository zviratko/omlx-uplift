/* Node unit tests for uplift core: node --test tests/uplift.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../omlx_uplift/static/core.js');

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
    assert.strictEqual(s.cachePercent, 10);
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
    items[C.PREFS_KEY] = JSON.stringify({ theme: 'neon', intervalMs: 7 });
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    C.savePrefs(store, { theme: 'light', motion: 'off', intervalMs: 2000, dense: true });
    assert.deepStrictEqual(C.loadPrefs(store), { theme: 'light', motion: 'off', intervalMs: 2000, dense: true });
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
    assert.strictEqual(C.fmtBytes(8.34e9), '8.34 GB');
    assert.strictEqual(C.fmtBytes(500e6), '500 MB');
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

// GridStack layout contract (uplift twin of classic dashboard_layout.js).
// The module attaches to globalThis in Node (no window), same as the page.
require('../omlx_uplift/static/uplift_layout.js');
const UPL = globalThis.UpliftLayout;
test('uplift layout: default layout covers every block once', () => {
    const d = UPL.defaultLayout();
    assert.deepStrictEqual(d.blocks.map(b => b.id).sort(), [...UPL.BLOCK_IDS].sort());
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
test('uplift layout: normalize drops unknown/dup blocks, clamps geometry', () => {
    const n = UPL.normalizeLayout({ width: 'banana', blocks: [
        { id: 'gen', x: -3, y: -1, w: 99 },
        { id: 'gen', x: 0, y: 5, w: 6 },          // duplicate -> dropped
        { id: 'ghost', x: 0, y: 0, w: 24 },        // unknown -> dropped
        { id: 'feed', x: 20, y: 2, w: 10 },        // x+w>24 -> x clamped
    ] });
    assert.strictEqual(n.width, 'default');
    assert.deepStrictEqual(n.blocks.map(b => b.id), ['gen', 'feed']);
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
