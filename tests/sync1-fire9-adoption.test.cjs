/* SYNC-1 fire 9 adoption cards UP-54/UP-55/UP-56.
   UP-54 gets a BEHAVIOR pin: modelspec is pure and the payload strip is the
   contract the server sees. UP-55/UP-56 machinery is hand-built DOM wired
   through editor/bench panel state that no vm harness mounts (the bench
   panels fetch live model rows; the fit block fires network reads) — those
   are SOURCE-SHAPE pins: the gating expressions and payload/param sites are
   the drift-sensitive parts a future classic move would silently break. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'omlx_uplift', 'static', 'modelspec.js'));
const STATIC = p => fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', p), 'utf8');

/* ---- UP-54 (upstream 153aaee #4826): per-model context window ---- */
test('UP-54: embedding/reranker keep max_context_window in the PUT; audio/decision strip', () => {
    for (const ty of ['embedding', 'reranker']) {
        const m = { id: 'x', model_type: ty };
        const p = S.buildPayload(S.buildState(m, { max_context_window: 8192 }), m);
        assert.strictEqual(p.max_context_window, 8192, ty + ' must carry the row value');
    }
    for (const ty of ['audio_stt', 'decision']) {
        const m = { id: 'x', model_type: ty };
        const p = S.buildPayload(S.buildState(m, { max_context_window: 8192 }), m);
        assert.ok(!('max_context_window' in p), ty + ' must not carry it');
    }
    // the EFFECTIVE type rules: a vlm flipped to reranker keeps the row live
    const m = { id: 'x', model_type: 'vlm' };
    const p = S.buildPayload(S.buildState(m,
        { model_type_override: 'reranker', max_context_window: 4096 }), m);
    assert.strictEqual(p.max_context_window, 4096);
});
test('UP-54 shape: the non-llm editor renders the ctx row for exactly the two families', () => {
    const src = STATIC('uplift_mmeditor.js');
    assert.match(src,
        /if \(effT === 'embedding' \|\| effT === 'reranker'\)\s*\n\s*g\.append\(seBind\('number', 'max_context_window'/);
    assert.match(src, /embedding_context_window_hint/);
    assert.match(src, /reranker_context_window_hint/);
});

/* ---- UP-55 (upstream d520df3 #4858): offload fit suggestion ---- */
test('UP-55 shape: fit query params, status handling, one-click apply, stale guards', () => {
    const src = STATIC('uplift_mmeditor.js');
    assert.match(src, /\/moe-offload-fit\?\$\{q\}/);
    assert.match(src, /for \(const k of \['mtp_enabled', 'qwen4_ple_ssd_offload',\s*\n\s*'deepseek_v41_engram_ssd_offload'\]\)/);
    assert.match(src, /new Set\(\['mtp_enabled', 'qwen4_ple_ssd_offload',\s*\n\s*'deepseek_v41_engram_ssd_offload'\]\)/);
    assert.match(src, /modal\.model_settings\.moe_expert_offload_fit'/);
    assert.match(src, /modal\.model_settings\.moe_expert_offload_no_fit'/);
    for (const ph of ['{percent}', '{size}', '{reserve}'])
        assert.ok(src.includes(".replace('" + ph + "'"), 'placeholder ' + ph);
    // one-click apply drives the SAME input event the user would
    assert.match(src, /wi\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
    // classic's refetch guard (url-equality) mirrored
    assert.match(src, /if \(fitUrl !== url \|\| !fitP\.isConnected\) return;/);
    // unknown/resident stay silent
    assert.match(src, /'unknown' \/ 'resident' stay silent/);
});

/* ---- UP-56 (upstream d59d797 #4855): bench GPU-cap note ---- */
test('UP-56 shape: both bench panels carry the note, tp honors the external gate', () => {
    const src = STATIC('uplift_bench.js');
    assert.match(src, /bench\.config\.gpu_power_limit_note/);
    assert.match(src, /\.replace\('\{watts\}', String\(w\)\)/);
    assert.match(src, /m\.settings && m\.settings\.gpu_power_limit_w/);
    // throughput panel: row position + external gating + loadModels stash
    assert.match(src, /f\.append\(row1, tpGpuNote, row2, row3, adv, actions\)/);
    assert.match(src, /self\.isExternal\(\) \? 0\s*\n\s*: benchGpuWatts\(self\.state && self\.state\.modelRows/);
    assert.match(src, /this\.state\.modelRows = usable;/);
    // ctx panel: change wiring + loadModels re-sync (no external condition)
    assert.match(src, /modelSel\.addEventListener\('change', syncCtxGpuNote\)/);
    assert.match(src, /if \(this\._syncCtxGpuNote\) this\._syncCtxGpuNote\(\)/);
    // SAY-2c: placeholder-substituted text must NEVER ride data-i18n
    assert.ok(!/GpuNote\.dataset\.i18n/.test(src), 'gpuNote set data-i18n');
});
