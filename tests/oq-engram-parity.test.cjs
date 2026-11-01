/* SYNC-1 fire 2026-10-22: upstream #4758 added the DeepSeek V4.1
   'Keep original Engram tables' (preserve_ngram_table) switch to the classic
   quantizer. The uplift port (uplift_modelsops.js) must mirror the same
   shape: switch visible for deepseek_v41 sources only, the flag gated by
   model type in BOTH the estimate params and the start payload, and a toggle
   re-arms the estimate. Pinned by source shape — the panel's payload code
   has no vm harness and the server accepts defaults either way, so a silent
   future drop is exactly what this test is for. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_modelsops.js'),
    'utf8');

test('quantizer carries the Engram-tables switch', () => {
    assert.match(src, /Keep original Engram tables/,
        'checkbox row label must match the classic EN value');
});

test('estimate params send preserve_ngram_table gated by model type', () => {
    assert.match(
        src,
        /preserve_ngram_table:\s*\(m\.model_type === 'deepseek_v41' && cbNgram\.checked\)\s*\?\s*'true'\s*:\s*'false'/,
        'GET /oq/estimate param must be the type-gated true/false string');
});

test('start payload sends preserve_ngram_table gated by model type', () => {
    assert.match(
        src,
        /preserve_ngram_table:\s*m\.model_type === 'deepseek_v41' && cbNgram\.checked\b(?!\s*\?)/,
        'POST /oq/start body must carry the type-gated boolean');
});

test('row gates off for non-deepseek_v41 sources and the switch resets', () => {
    // WIDE-QA 2026-11-01: the fold moved from display:none (which re-stacked
    // the whole grid when a model was picked) to a gated slot: dimmed and
    // disabled in place, reason in the hint line. Gate OFF + stale-check
    // clear is the same contract, pinned on the new shape.
    assert.match(
        src,
        /const isV41 = !!\(m && m\.model_type === 'deepseek_v41'\);\s*qzGate\(rowNgram, isV41, 'DeepSeek V4\.1 models only\.'\);\s*if \(!isV41\) cbNgram\.checked = false;/,
        'updateConditional must gate the row by model type and clear a stale check');
    assert.doesNotMatch(src, /rowNgram\.hidden/,
        'negative pin: the Engram row must never go back to hidden (reflow)');
});

test('toggling the switch re-arms the estimate (classic x-effect parity)', () => {
    assert.match(src, /cbNgram\.onchange = refreshEst;/,
        'estimate must refresh when the switch flips, like the classic page');
});
