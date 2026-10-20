/* U47: the text export must match classic's benchBuildText byte-shape —
   users paste native-board output next to classic's into the same
   threads. Format pinned here against omlx/admin/static/js/dashboard.js
   (benchBuildText/benchFmtNum/benchFormatMemory read 2026-10-08):
   title/tagline line, repo URL, model line, engine line, context line,
   '=' x80, then the two sections with the exact column widths. The module
   is UMD and its builders are pure (t() falls back to the English default
   without UpliftCore) — so no DOM stub is needed for the format itself. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { STATIC_DIR } = require('./static-src.cjs');

const B = require(`${STATIC_DIR}/uplift_bench.js`);
const { buildThroughputText, fmtNum, fmtMemory, singleTestLabel,
        outTokens, outCell } = B._benchText;

const single = { test_type: 'single', pp: 1024, requested_pp: 1024, tg: 128,
    ttft_ms: 123.456, tpot_ms: 7.891, processing_tps: 8304.12, gen_tps: 126.78,
    total_throughput: 901.23, e2e_latency_s: 1.2345, peak_memory_bytes: 3221225472 };
const single4k = Object.assign({}, single, { pp: 4096, requested_pp: 4096,
    gen_tps: 120.0, e2e_latency_s: 4.5678, peak_memory_bytes: 524288 });
const batch2 = { test_type: 'batch', batch_size: 2, tg: 128, tg_tps: 240.5,
    pp_tps: 15000.0, avg_ttft_ms: 250.0, e2e_latency_s: 1.1,
    requested_pp: 1024, prompt_tokens_min: 1024, prompt_tokens_max: 1024 };

test('U47: header block mirrors classic line-for-line', () => {
    const text = buildThroughputText(
        { model: 'TestModel', profile: 'code_python', forceLm: false, external: null },
        [single]);
    const lines = text.split('\n');
    assert.equal(lines[0], 'oMLX - LLM inference, optimized for your Mac');
    assert.equal(lines[1], 'https://github.com/jundot/omlx');
    assert.equal(lines[2], 'Benchmark Model: TestModel');
    assert.equal(lines[3], 'Engine: Auto');
    assert.equal(lines[4], 'Context: Code (Python)');
    assert.equal(lines[5], '='.repeat(80));
    assert.equal(lines[7], 'Single Request Results');
    assert.equal(lines[8], '-'.repeat(80));
});

test('U47: force-lm and external runs label like classic (url never printed)', () => {
    const lm = buildThroughputText(
        { model: 'M', profile: 'novel_en', forceLm: true, external: null }, []);
    assert.ok(lm.includes('Engine: Force mlx-lm'));
    assert.ok(lm.includes('Context: Novel (English)'));
    const ex = buildThroughputText(
        { model: 'ignored', profile: 'code_python', forceLm: false,
          external: { model: 'gpt-x' } }, []);
    assert.ok(ex.includes('Benchmark Model: gpt-x'));
    assert.ok(ex.includes('Engine: External OpenAI-compatible endpoint'));
    // the ONLY http line is the repo URL (classic prints it too); the
    // endpoint base_url must never appear
    const urls = ex.split('\n').filter(l => l.includes('http'));
    assert.deepEqual(urls, ['https://github.com/jundot/omlx']);
});

test('U47: single rows use classic padding and N/A dash policy', () => {
    const text = buildThroughputText(
        { model: 'M', profile: 'code_python', forceLm: false, external: null },
        [single]);
    const hdr = text.split('\n').find(l => l.startsWith('Test'));
    assert.ok(hdr.includes('TTFT(ms)') && hdr.includes('TPOT(ms)') &&
        hdr.includes('pp TPS') && hdr.includes('tg TPS') && hdr.includes('E2E(s)') &&
        hdr.includes('Throughput') && hdr.includes('Peak Mem'));
    const row = text.split('\n').find(l => l.startsWith('pp1024/tg128'));
    // label padded to 32, then two-space joins; values right-padded columns
    assert.equal(row.slice(0, 32), 'pp1024/tg128'.padEnd(32));
    assert.ok(row.includes('123.5'.padStart(10)), 'TTFT 1 decimal, padStart 10');
    assert.ok(row.includes('7.89'.padStart(10)), 'TPOT 2 decimals');
    assert.ok(row.includes('8304.1 tok/s'.padStart(12)));
    assert.ok(row.includes('126.8 tok/s'.padStart(12)));
    assert.ok(row.includes((1.2345).toFixed(3).padStart(10)),
        'E2E keeps classic toFixed(3) float-rounding behaviour');
    assert.ok(row.includes('3.00 GB'.padStart(10)));
    const nulls = buildThroughputText({ model: 'M', profile: 'code_python' },
        [Object.assign({}, single, { gen_tps: null, tpot_ms: null,
            peak_memory_bytes: 0 })]);
    const nrow = nulls.split('\n').find(l => l.startsWith('pp1024'));
    assert.ok(nrow.includes('N/A'), 'unmeasured -> N/A (classic benchFmtNum)');
    assert.ok(nrow.includes('-'.padStart(10)), 'zero memory -> dash');
});

test('U47: batch section reproduces classic baseline + speedup math', () => {
    const text = buildThroughputText(
        { model: 'M', profile: 'code_python', forceLm: false, external: null },
        [single, batch2]);
    const batchIdx = text.split('\n').indexOf('Continuous Batching');
    assert.ok(batchIdx > 0);
    const sec = text.split('\n').slice(batchIdx);
    assert.equal(sec[1], 'requested pp1024 / actual pp1024 / tg128');
    assert.ok(sec[3].startsWith('Batch   '.padEnd(8)) || sec[3].includes('pp TPS/req'));
    assert.ok(sec.some(l => l.startsWith('1x      ') && l.includes('1.00x')),
        'baseline row from the pp1024 single run');
    const brow = sec.find(l => l.startsWith('2x'));
    assert.ok(brow.includes((240.5 / 126.78).toFixed(2) + 'x'), 'speedup vs baseline');
    assert.ok(brow.includes('7500.0 tok/s'), 'pp TPS/req = pp_tps / batch_size');
});

test('U47: helpers match classic edge cases', () => {
    assert.equal(fmtNum(null, 1), 'N/A');
    assert.equal(fmtNum(undefined, 2), 'N/A');
    assert.equal(fmtNum(0, 1), '0.0');           // 0 is a value, not missing
    assert.equal(fmtMemory(null), '-');
    assert.equal(fmtMemory(1024 * 1024 * 1024), '1.00 GB');
    assert.equal(fmtMemory(1500 * 1024 * 1024), '1.46 GB');   // >=1GB -> GB (classic)
    assert.equal(fmtMemory(524288), '1 MB');
    assert.equal(singleTestLabel({ pp: 999, requested_pp: 1024, tg: 128 }),
        'pp999 (requested pp1024)/tg128');
    assert.equal(singleTestLabel({ pp: 1024, tg: 128 }), 'pp1024/tg128');
    assert.ok(buildThroughputText({ model: 'M', profile: 'code_python' }, [])
        .endsWith('='.repeat(80)), 'no results -> header block only (button is hidden anyway)');
});

/* TG-BENCH: the tg label is what was REQUESTED; the out column reports
   what was GENERATED (completion_tokens; batch total_gen_tokens/size).
   Early-stopping rows (external endpoints, spec-decode engines — paths
   the force-tg patch cannot cover) print the fraction instead of letting
   a tg1024 row hide a 21-token decode. The classic byte-format text
   export above stays untouched on purpose (side-by-side paste contract). */
test('TG-BENCH: outTokens reads measured decode from single and batch rows', () => {
    assert.equal(outTokens({ completion_tokens: 128 }), 128);
    assert.equal(outTokens({ total_gen_tokens: 63, batch_size: 3 }), 21);
    assert.equal(outTokens({ total_gen_tokens: 63 }), 63, 'bs missing -> per-request as-is');
    assert.equal(outTokens({}), null);
});
test('TG-BENCH: outCell shows truth, fraction on shortfall, dash on unknown', () => {
    assert.equal(outCell({ tg: 128, completion_tokens: 128 }), '128');
    assert.equal(outCell({ tg: 1024, completion_tokens: 21 }), '21/1024');
    assert.equal(outCell({ tg: 1024, total_gen_tokens: 3072, batch_size: 3 }), '1024');
    assert.equal(outCell({ tg: 1024, total_gen_tokens: 63, batch_size: 3 }), '21/1024');
    assert.equal(outCell({ tg: 1024 }), '\u2014',
        'row without measured counts (older history) stays honest-empty');
});

/* U50: context-target option builder (native window default, hide-above-
   native ladder, honest floor label past the accepted ceiling, Custom). */
const { ctxTargetOptions } = B._benchText;
test('U50: native window is the first + selected option (off-whitelist ok)', () => {
    const opts = ctxTargetOptions(135168);
    assert.equal(opts[0].value, '135168');
    assert.equal(opts[0].native, true);
    // ladder entries strictly below native, none above
    assert.deepEqual(opts.slice(1, -1).map(o => Number(o.value)),
        [16384, 32768, 65536, 131072]);
    assert.equal(opts[opts.length - 1].custom, true);
});

test('no ceiling: native past the old ceiling is offered verbatim', () => {
    const opts = ctxTargetOptions(1048576);
    assert.equal(opts[0].value, '1048576');
    assert.equal(opts[0].label, '1,048,576');
    assert.ok(!opts[0].label.includes('\u2192'), 'no floored-to-ceiling arrow');
    assert.equal(opts[0].native, true);
    // full ladder below native + custom
    assert.deepEqual(opts.slice(1, -1).map(o => Number(o.value)),
        [16384, 32768, 65536, 131072, 262144, 524288]);
    assert.equal(opts[opts.length - 1].custom, true);
});

test('U50: unknown native keeps the plain ladder (classic shape) + Custom', () => {
    const opts = ctxTargetOptions(0);
    assert.equal(opts.length, 7);   // 6 ladder + custom
    assert.ok(opts.every(o => !o.native));
});

/* ==========================================================================
   TP-TABLES (user items 2 + 5): classic reports throughput as TWO tables —
   'Single Request Results' and 'Continuous Batching' — with its own column
   order, header names and header tooltips (its bench_th() puts the
   bench.metrics.*.tooltip text on the th). The pins below load the module in
   a vm whose catalog serves the REAL classic strings (copied verbatim from
   omlx_web/i18n/en.json) so a renamed header or a dropped tooltip cannot
   pass on an English fallback alone. */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const CLASSIC_CAT = {
    'bench.results.single.section_label': 'Single Request Results',
    'bench.results.single.test': 'Test',
    'bench.results.single.ttft': 'TTFT (ms)',
    'bench.results.single.tpot': 'TPOT (ms/tok)',
    'bench.results.single.pp_tps': 'PP TPS',
    'bench.results.single.tg_tps': 'TG TPS',
    'bench.results.single.e2e_latency': 'E2E Latency',
    'bench.results.single.throughput': 'Throughput',
    'bench.results.single.peak_mem': 'Peak MLX',
    'bench.results.batch.section_label': 'Continuous Batching',
    'bench.results.batch.batch_size': 'Batch Size',
    'bench.results.batch.tg_tps': 'TG TPS',
    'bench.results.batch.speedup': 'Speedup',
    'bench.results.batch.pp_tps': 'PP TPS',
    'bench.results.batch.pp_tps_req': 'PP TPS/req',
    'bench.results.batch.avg_ttft': 'Avg TTFT (ms)',
    'bench.results.batch.e2e_latency': 'E2E Latency',
    'bench.results.batch.baseline': '1x (baseline)',
    'bench.results.text_export.not_available': 'N/A',
    'bench.metrics.test.tooltip': 'Test case label in the format ppN/tgM.',
    'bench.metrics.ttft.tooltip': 'Time to First Token — how long the user waits.',
    'bench.metrics.tpot.tooltip': 'Time Per Output Token — average interval.',
    'bench.metrics.pp_tps.tooltip': 'Prompt Processing TPS — input tokens per second.',
    'bench.metrics.tg_tps.tooltip': 'Token Generation TPS — output tokens per second.',
    'bench.metrics.e2e.tooltip': 'End-to-End Latency — total wall-clock time.',
    'bench.metrics.throughput.tooltip': 'Total Throughput — combined input and output.',
    'bench.metrics.peak_mem.tooltip': 'Peak active MLX allocations during this test.',
    'bench.metrics.batch_size.tooltip': 'Batch Size — number of requests processed simultaneously.',
    'bench.metrics.speedup.tooltip': 'Speedup — how much faster token generation is.',
    'bench.metrics.pp_tps_req.tooltip': "Per-Request Prompt Processing TPS — the PP TPS divided by the batch size.",
    'bench.metrics.avg_ttft.tooltip': 'Average Time to First Token across all requests in the batch.',
};

function loadVm(cat) {
    const byId = {};
    const mk = (tag) => {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            className: '', textContent: '', title: '', hidden: false,
            checked: false, disabled: false, value: '', type: '', _id: '',
            get id() { return el._id; },
            set id(v) { el._id = v; if (v) byId[v] = el; },
            setAttribute(k, v) { el.attrs[k] = String(v); },
            getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
            replaceChildren(...k) { el.children = k; },
            append(...k) { el.children.push(...k); },
            appendChild(k) { el.children.push(k); return k; },
            addEventListener() {}, removeEventListener() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        };
        return el;
    };
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = mk('div')); },
        createElement: mk,
        createTextNode: (s) => ({ textContent: String(s), children: [] }),
        querySelectorAll: () => [],
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    const merged = Object.assign({}, CLASSIC_CAT, cat || {});
    const win = {
        UpliftCore: { t: (k) => (merged[k] == null ? k : merged[k]) },
        UpliftDom: { fetchJson: async () => { throw new Error('no net'); },
                     postJson: async () => {}, toast: () => {},
                     deleteJson: async () => {} },
        Uplift: { state: { API: '' } },
        document, navigator: {}, requestAnimationFrame: () => {},
        setTimeout: (f) => 1, clearTimeout: () => {},
        setInterval: () => 1, clearInterval: () => {},
        EventSource: undefined,
        location: { hash: '', pathname: '/uplift/', search: '' },
        history: { replaceState() {} },
    };
    win.window = win; win.self = win; win.navigator.clipboard = null;
    win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8'))
        .runInContext(ctx);
    return { win, byId, B: win.UpliftNativeBench };
}

const TP1K = { test_type: 'single', pp: 1024, requested_pp: 1024, tg: 128,
    ttft_ms: 123.456, tpot_ms: 7.891, processing_tps: 8304.12, gen_tps: 100,
    total_throughput: 901.23, e2e_latency_s: 1.2345,
    peak_memory_bytes: 3221225472, completion_tokens: 128 };
const TP4K = Object.assign({}, TP1K, { pp: 4096, requested_pp: 4096 });
const TPB2 = { test_type: 'batch', batch_size: 2, tg: 128, tg_tps: 180,
    pp_tps: 15000, avg_ttft_ms: 250, e2e_latency_s: 1.1,
    total_gen_tokens: 256, requested_pp: 1024,
    prompt_tokens_min: 1024, prompt_tokens_max: 1024 };

test('TP-TABLES: two classic-ordered tables, single first', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TP4K, TP1K, TPB2]);
    assert.equal(specs.length, 2, 'single section + batch section');
    assert.equal(specs[0].key, 'bench.results.single.section_label');
    assert.equal(specs[0].en, 'Single Request Results');
    assert.equal(specs[1].key, 'bench.results.batch.section_label');
    assert.equal(specs[1].en, 'Continuous Batching');
    assert.deepEqual(specs[0].defs.map(d => d.head),
        ['Test', 'TTFT (ms)', 'TPOT (ms/tok)', 'PP TPS', 'TG TPS',
         'E2E Latency', 'Throughput', 'Peak MLX', 'out'],
        'classic column order, native out LAST');
    assert.deepEqual(specs[1].defs.map(d => d.head),
        ['Batch Size', 'TG TPS', 'Speedup', 'PP TPS', 'PP TPS/req',
         'Avg TTFT (ms)', 'E2E Latency', 'out'],
        'classic batch column order, native out LAST');
});

test('TP-TABLES: every header carries classic tooltip text on the th', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TP1K, TPB2]);
    const TIP = {
        Test: 'bench.metrics.test.tooltip',
        'TTFT (ms)': 'bench.metrics.ttft.tooltip',
        'TPOT (ms/tok)': 'bench.metrics.tpot.tooltip',
        'PP TPS': 'bench.metrics.pp_tps.tooltip',
        'TG TPS': 'bench.metrics.tg_tps.tooltip',
        'E2E Latency': 'bench.metrics.e2e.tooltip',
        Throughput: 'bench.metrics.throughput.tooltip',
        'Peak MLX': 'bench.metrics.peak_mem.tooltip',
        'Batch Size': 'bench.metrics.batch_size.tooltip',
        Speedup: 'bench.metrics.speedup.tooltip',
        'PP TPS/req': 'bench.metrics.pp_tps_req.tooltip',
        'Avg TTFT (ms)': 'bench.metrics.avg_ttft.tooltip',
        out: 'uplift.bench.tp.out_hint',
    };
    specs.forEach(s => s.defs.forEach(d => {
        assert.equal(d.tipKey, TIP[d.head], `tooltip key for ${d.head}`);
        assert.ok(d.tip && d.tip !== d.tipKey,
            `tooltip text resolved for ${d.head}`);
    }));
    // the one native tooltip: a NEW key, so it must carry the frozen fallback
    const out = specs[0].defs[specs[0].defs.length - 1];
    assert.equal(out.tip, 'Measured output tokens vs the requested tg length.',
        'out_hint fallback ships verbatim until the locales carry the key');
});

test('TP-TABLES: headers/tooltips land on the painted th (title attr)', () => {
    const { B } = loadVm();
    const nodes = B._u49.buildTpTables([TP1K, TPB2]);
    const tables = nodes.filter(n => n.tagName === 'table');
    assert.equal(tables.length, 2, 'two tables painted');
    assert.ok(tables[0].className.includes('tp-table'), 'parity class');
    const ths = tables[0].children[0].children;
    assert.equal(ths[7].textContent, 'Peak MLX');
    assert.equal(ths[7].title, CLASSIC_CAT['bench.metrics.peak_mem.tooltip']);
    assert.equal(ths[7].dataset.i18n, 'bench.results.single.peak_mem');
    assert.equal(ths[7].dataset.i18nTitle, 'bench.metrics.peak_mem.tooltip');
    assert.equal(ths[7].dataset.enTitle,
        CLASSIC_CAT['bench.metrics.peak_mem.tooltip']);
    const bths = tables[1].children[0].children;
    assert.equal(bths[0].textContent, 'Batch Size');
    assert.equal(bths[0].title, CLASSIC_CAT['bench.metrics.batch_size.tooltip']);
    // section titles carry their catalog key (U59 late-catalog repair)
    const labels = nodes.filter(n => n.tagName === 'div');
    assert.equal(labels[0].children[0].dataset.i18n,
        'bench.results.single.section_label');
});

test('TP-TABLES: the Peak MLX cell rides fmtMemory, dash when absent', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TP1K]);
    const peak = specs[0].defs.find(d => d.headKey === 'bench.results.single.peak_mem');
    assert.equal(peak.key, 'peak_memory_bytes', 'classic value path');
    assert.equal(peak.get(TP1K), '3.00 GB');
    assert.equal(peak.get(Object.assign({}, TP1K, { peak_memory_bytes: 0 })), '-');
    assert.equal(peak.get({}), '-', 'absent memory mirrors classic falsy dash');
});

test('TP-TABLES: batch rows read batch keys, no dash off single-only ones', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TP1K, TPB2]);
    const row = specs[1].rows[1];                      // the 2x row
    const cell = h => specs[1].defs.find(d => d.head === h).get(row);
    assert.equal(cell('TG TPS'), '180.0 tok/s');
    assert.equal(cell('PP TPS'), '15000.0 tok/s');
    assert.equal(cell('PP TPS/req'), '7500.0 tok/s');
    assert.equal(cell('Avg TTFT (ms)'), '250.0');
    assert.equal(cell('E2E Latency'), '1.100s');
    assert.equal(cell('Speedup'), '1.80x', 'tg_tps / baseline gen_tps');
    assert.equal(cell('out'), '128', 'total_gen_tokens / batch_size');
});

test('TP-TABLES: the 1x baseline row is the pp1024 single, like classic', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TP4K, TP1K, TPB2]);
    const batch = specs[1];
    assert.equal(batch.rows[0].__baseline, true);
    const cell = h => batch.defs.find(d => d.head === h).get(batch.rows[0]);
    assert.equal(cell('Batch Size'), '1x (baseline)', 'classic baseline label');
    assert.equal(cell('TG TPS'), '100.0 tok/s');
    assert.equal(cell('Speedup'), '1.00x');
    assert.equal(cell('PP TPS'), '8304.1 tok/s');
    assert.equal(cell('PP TPS/req'), '8304.1 tok/s',
        'classic prints the baseline PP TPS in the per-req cell too');
    assert.equal(cell('Avg TTFT (ms)'), '123.5');
});

test('TP-TABLES: no baseline single -> speedup N/A, still no fake row', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TPB2]);
    assert.equal(specs.length, 1, 'batch only when no singles exist');
    assert.equal(specs[0].kind, 'batch');
    assert.ok(!specs[0].rows.some(r => r.__baseline), 'no invented baseline row');
    const sp = specs[0].defs.find(d => d.head === 'Speedup');
    assert.equal(sp.get(TPB2), 'N/A', 'classic not_available key');
});

test('TP-TABLES: single-only rows never paint the batch table', () => {
    const { B } = loadVm();
    const specs = B._benchText.tpTableSpecs([TP1K]);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].kind, 'single');
});

test('TP-TABLES: CSV export concatenates BOTH tables under classic heads', () => {
    const { B } = loadVm();
    const cols = B._benchText.tpDlCols([TP1K, TPB2]);
    assert.deepEqual(cols.map(c => c.head), [
        'Test', 'TTFT (ms)', 'TPOT (ms/tok)', 'PP TPS', 'TG TPS',
        'E2E Latency', 'Throughput', 'Peak MLX',
        'Batch Size', 'TG TPS', 'Speedup', 'PP TPS', 'PP TPS/req',
        'Avg TTFT (ms)', 'E2E Latency', 'out',
    ], "both tables' columns, out once at the end");
    // each row fills only its own table's columns
    assert.equal(cols[0].get(TP1K), 'pp1024/tg128');
    assert.equal(cols[0].get(TPB2), '', 'a batch row is not a Test cell');
    assert.equal(cols[8].get(TPB2), '2x');
    assert.equal(cols[8].get(TP1K), '');
    assert.equal(cols[15].get(TP1K), '128', 'out rides both row kinds');
});

test('TP-TABLES: history notes the cache-off run under its title', () => {
    const { B } = loadVm();
    const withNote = B._benchText.tpCacheOffNote({ meta: { cache_off: ['hot'] } });
    assert.ok(withNote, 'the note exists when the snapshot says so');
    assert.equal(withNote.textContent, 'Cache disabled during this run');
    assert.equal(withNote.dataset.i18n, 'uplift.bench.tp.cache_off');
    assert.equal(withNote.dataset.en, 'Cache disabled during this run');
    assert.equal(B._benchText.tpCacheOffNote({ meta: {} }), null,
        'no cache_off -> no note');
    assert.equal(B._benchText.tpCacheOffNote({}), null, 'no meta at all');
    assert.equal(B._benchText.tpCacheOffNote({ meta: { cache_off: [] } }), null,
        'empty array is not a disabled cache');
});

test('TP-TABLES: the live table and the history card paint the same spec', () => {
    const { B } = loadVm();
    const live = B._u49.buildTpTables([TP1K, TPB2]);
    const hist = B._u49.buildTpTables([TP1K, TPB2]);
    const heads = ns => ns.filter(n => n.tagName === 'table')
        .map(t => t.children[0].children.map(th => th.textContent).join('|'));
    assert.deepEqual(heads(hist), heads(live), 'one painter, no drift');
});

/* FROZEN KEY CONTRACT (orchestrator mirror): the strings this batch adds are
   shipped into all 11 locale files verbatim, so a reword or a new key is a
   cross-lane break. Pin each key + its English fallback as ONE literal after
   collapsing the source's string-concatenation seams. */
const NEW_KEYS = {
    'uplift.bench.tp.out_hint':
        'Measured output tokens vs the requested tg length.',
    'uplift.bench.tp.cache_off': 'Cache disabled during this run',
    'uplift.bench.tp.no_hot_cache': 'Hot cache off for this run',
    'uplift.bench.tp.no_hot_cache_hint':
        'Sets the in-memory Hot Cache limit to 0 while this benchmark runs, '
        + 'then restores your setting. Loaded models are reloaded at run '
        + 'start and finish.',
    'uplift.bench.tp.no_ssd_cache': 'SSD cache off for this run',
    'uplift.bench.tp.no_ssd_cache_hint':
        'Enables Hot Cache Only (no SSD reads, writes or background writer) '
        + 'while this benchmark runs, then restores your setting. Loaded '
        + 'models are reloaded at run start and finish.',
    'uplift.bench.tp.cache_off_local': 'Applies to local models only.',
    'uplift.bench.board_stalled': 'No progress events for {n}s',
};
test('FROZEN: every new key ships with its exact English fallback', () => {
    const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'),
        'utf8')
        // "a" + \n   "b"  ->  "ab"   (the hints are wrapped over lines)
        .replace(/'\s*\+\s*'/g, '');
    for (const [key, en] of Object.entries(NEW_KEYS)) {
        assert.ok(src.includes("'" + key + "'"), key + ' referenced');
        assert.ok(src.includes("'" + en + "'"),
            key + ' fallback reworded: expected ' + JSON.stringify(en));
    }
    // classic's own keys are NOT re-minted here (zero locale churn): assert
    // the table headers ride the bench.results.* family
    for (const k of ['bench.results.single.peak_mem', 'bench.results.batch.baseline',
                     'bench.metrics.peak_mem.tooltip', 'bench.results.batch.pp_tps_req'])
        assert.ok(src.includes("'" + k + "'"), k + ' reused from the classic catalog');
});
