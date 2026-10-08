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
const { buildThroughputText, fmtNum, fmtMemory, singleTestLabel } = B._benchText;

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

test('U50: native past the ceiling is floored and labelled honestly', () => {
    const opts = ctxTargetOptions(1048576);
    assert.equal(opts[0].value, '524288');
    assert.ok(opts[0].label.includes('1,048,576') && opts[0].label.includes('524,288'),
        'label shows native -> tested, never silent rounding');
    assert.equal(opts[0].native, true);
});

test('U50: unknown native keeps the plain ladder (classic shape) + Custom', () => {
    const opts = ctxTargetOptions(0);
    assert.equal(opts.length, 7);   // 6 ladder + custom
    assert.ok(opts.every(o => !o.native));
});
