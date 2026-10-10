/* EMBED-1: the Throughput chart must carry an embedding line.
   The bug (user 2026-10-10): embedding traffic moved NEITHER existing
   line — encoder forwards run on MLXEmbeddingModel, invisible to the
   LLM-core hooks. The fix adds embedding.tokens_s as the 5th drawn
   series on the right (prefill) axis, on the same two independent data
   paths (live push + history backfill) — both must carry it or the
   chart breaks silently (multi-line chart doctrine). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const charts = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
const livefeed = fs.readFileSync(path.join(STATIC_DIR, 'uplift_livefeed.js'), 'utf8');

test('tpsSpecs draws five series and the embedding line is on y2', () => {
    const body = charts.slice(charts.indexOf('function tpsSpecs(col)'),
                              charts.indexOf('function tpsBaseOpts'));
    assert.ok(body.includes('uplift.metric.embedding.tokens_s'),
        'embedding line must exist in the series builder');
    assert.equal((body.match(/specs\.push/g) || []).length, 3,
        'gen+prefill from the literal array, then cached, mtp, embedding pushed');
    const el = body.indexOf('uplift.metric.embedding.tokens_s');
    assert.ok(body.slice(el, el + 300).includes("'y2'"),
        'embedding rides the prefill axis (same magnitude family)');
});

test('tpsWindowed builds and aligns the embedding column', () => {
    const body = charts.slice(charts.indexOf('function tpsWindowed()'),
                              charts.indexOf('function memWindowed'));
    assert.ok(body.includes('chartHist.embed'),
        'history path: the embedding series must be merged (backfill)');
    assert.ok(body.includes("LF.liveUsable('embedding.tokens_s')"),
        'live path: the 2 Hz twin must be preferred when usable');
    assert.ok(body.includes('tpsData[5]'),
        'the 5 s fallback column (metrics/latest) feeds the embedding line');
    assert.ok(body.includes('eb.ts'))  ,
        'union x column must include the embedding timestamps';
});

test('both fetch sites request the embedding key', () => {
    // series backfill AND the /metrics/latest 5 s poll — a key missing
    // from either path draws null there (the two-path break doctrine).
    assert.equal((charts.match(/embedding\.tokens_s/g) || []).length >= 4, true,
        'series fetch + latest fetch + chartHist + livefeed wiring');
    assert.ok(livefeed.includes("'embedding.tokens_s': 'embedding.tokens_s'"),
        'LIVE_KEYS must list it or the live twin can never activate');
});

test('the collector tick writes the key even with no pool', () => {
    const collector = fs.readFileSync(path.join(STATIC_DIR, '..', 'collector.py'), 'utf8');
    // Indentation is the placement proof: 8 spaces = tick-level statement
    // (sample_once body), 12 = nested inside `if pool is not None:`. The
    // embedding family must NEVER hide behind the pool guard — a failed
    // probe must not truncate the series (zeros are data).
    assert.match(collector,
        /^ {8}try:\n {12}pairs\.update\(collectors\.collect_embedding\(now=now\)\)/m,
        'embedding drain must sit at tick level in its own try');
});
