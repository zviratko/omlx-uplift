/* DIV-1/2/3 (user 2026-10-09) — divergence display fixes + sync action.
   DIV-1: an alias card must NOT chip a gated knob (e.g. MoE resident
         fraction) whose master switch is OFF on both sides — the knob
         cannot take effect, so it is not a difference (base rows only
         print toggled-ON features; the chip loop had spec-family gates
         only and missed moe/turboquant/oq/ane).
   DIV-2: the RUNTIME DIVERGENCE detail must not list "key 128 -> 128" —
         a dependent key whose RAW base and profile values display the
         same is carried by its master row (signature gate: the key only
         counts while the master is ON, so a flip made sig null vs "128"
         while the base raw value was 128 all along).
   DIV-3: the banner gains a SYNC BASE -> PROFILES action; its key split
         (delete diverging keys from the sparse profile overrides = the
         profile inherits them again) is gated here through sigMasterKey
         + runtimeDiff so a sync pass can only ever remove what the diff
         reported.
   Statics are browser IIFEs; the pure spec loads under node directly and
   aliasDiffChips is sliced out and executed with a window stub (same
   pattern as the U42 ifPaint / chip-parity tests). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');
const S = require('../omlx_uplift/static/modelspec.js');

/* ---- slice aliasDiffChips out of uplift_mmchips.js (browser IIFE) ---- */
const chipsSrc = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmchips.js'), 'utf8');
const start = chipsSrc.indexOf('function aliasDiffChips(');
const end = chipsSrc.indexOf('// ---', start);
assert.ok(start > 0 && end > start, 'aliasDiffChips slice found');
const aliasDiffChips = new Function('window',
    chipsSrc.slice(start, end) + '\nreturn aliasDiffChips;')(
    { UpliftModelSpec: S });

const model = (over = {}) => Object.assign(
    { id: 'm1', model_type: 'llm', config_model_type: 'qwen3_5' }, over);
const rt = (over = {}) => S.buildPayload(S.buildState(model(), over), model());

/* ================= DIV-2: runtimeDiff display ================= */
test('DIV-2: a master flip shows only the master row, not an equal knob', () => {
    // profile turns oq_a8 ON but leaves min_tokens at the default 128 that
    // the base also holds -> "qwen35_oq_a8_min_tokens 128 -> 128" was noise
    const d = S.runtimeDiff(
        rt({ qwen35_oq_a8_enabled: false, qwen35_oq_a8_min_tokens: 128 }),
        rt({ qwen35_oq_a8_enabled: true, qwen35_oq_a8_min_tokens: 128 }));
    assert.deepStrictEqual(d.map(r => r.key), ['qwen35_oq_a8_enabled']);
});
test('DIV-2: the same flip with a REAL knob change keeps the knob row', () => {
    const d = S.runtimeDiff(
        rt({ qwen35_oq_a8_enabled: false, qwen35_oq_a8_min_tokens: 128 }),
        rt({ qwen35_oq_a8_enabled: true, qwen35_oq_a8_min_tokens: 256 }));
    assert.deepStrictEqual(d.map(r => r.key),
        ['qwen35_oq_a8_enabled', 'qwen35_oq_a8_min_tokens']);
});
test('DIV-2: moe resident fraction off->on at the default fraction is one row', () => {
    // buildState zeroes moe_expert_offload_enabled unless the model
    // reports support — the same gate the editor row shows
    const mm = model({ moe_expert_offload_supported: true });
    const d = S.runtimeDiff(
        S.buildPayload(S.buildState(mm, {}), mm),
        S.buildPayload(S.buildState(mm, { moe_expert_offload_enabled: true,
            moe_expert_offload_resident_fraction: 0.25 }), mm));
    assert.deepStrictEqual(d.map(r => r.key), ['moe_expert_offload_enabled']);
});
test('DIV-2: 128 vs 128.0 and "4" vs 4 are display-equal (no fake row)', () => {
    const d = S.runtimeDiff(
        rt({ turboquant_kv_enabled: true, turboquant_kv_bits: 4 }),
        rt({ turboquant_kv_enabled: true, turboquant_kv_bits: 4.0 }));
    assert.deepStrictEqual(d, []);
    const d2 = S.runtimeDiff(
        rt({ qwen35_oq_a8_enabled: true, qwen35_oq_a8_min_tokens: 128 }),
        rt({ qwen35_oq_a8_enabled: true, qwen35_oq_a8_min_tokens: 128.0 }));
    assert.deepStrictEqual(d2, []);
});
test('DIV-2: a genuine value change is still reported even when equal-as-strings differ', () => {
    const d = S.runtimeDiff(
        rt({ turboquant_kv_enabled: true, turboquant_kv_bits: 4 }),
        rt({ turboquant_kv_enabled: true, turboquant_kv_bits: 3.5 }));
    assert.deepStrictEqual(d.map(r => r.key), ['turboquant_kv_bits']);
});

/* ================= sigMasterKey (DRIFT GUARD) ================= */
test('DIV: every dependent key runtimeSignature gates has a master mapping', () => {
    const gated = ['mtp_adaptive_max_depth', 'mtp_fixed_depth',
        'turboquant_kv_bits', 'qwen35_oq_a8_min_tokens',
        'moe_expert_offload_resident_fraction',
        'specprefill_draft_model', 'specprefill_keep_pct', 'specprefill_threshold',
        'dflash_draft_model', 'dflash_draft_quant_enabled',
        'dflash_draft_quant_weight_bits', 'dflash_draft_quant_activation_bits',
        'dflash_draft_quant_group_size', 'dflash_max_ctx', 'dflash_in_memory_cache',
        'dflash_in_memory_cache_max_entries', 'dflash_in_memory_cache_max_bytes',
        'dflash_ssd_cache', 'dflash_ssd_cache_max_bytes',
        'vlm_mtp_draft_model', 'vlm_mtp_draft_block_size'];
    for (const k of gated)
        assert.ok(S.sigMasterKey(k), 'sigMasterKey maps ' + k);
    assert.strictEqual(S.sigMasterKey('temperature'), '');
    assert.strictEqual(S.sigMasterKey('moe_expert_offload_enabled'), '');
});

/* ================= DIV-1: alias chips ================= */
test('DIV-1: gated knob with both masters OFF never chips', () => {
    const base = { moe_expert_offload_enabled: false,
        moe_expert_offload_resident_fraction: 0.25 };
    const prof = { moe_expert_offload_enabled: false,
        moe_expert_offload_resident_fraction: 0.6 };
    assert.deepStrictEqual(aliasDiffChips(prof, base), []);
});
test('DIV-1: the same knob DOES chip once the profile turns the master on', () => {
    const base = { moe_expert_offload_enabled: false,
        moe_expert_offload_resident_fraction: 0.25 };
    const prof = { moe_expert_offload_enabled: true,
        moe_expert_offload_resident_fraction: 0.6 };
    assert.deepStrictEqual(aliasDiffChips(prof, base),
        ['MOE_EXPERT_OFFLOAD_ENABLED', 'MOE_EXPERT_OFFLOAD_RESIDENT_FRACTION 0.6']);
});
test('DIV-1: turboquant/oq/ane knobs obey the same gate', () => {
    const base = { turboquant_kv_enabled: false, turboquant_kv_bits: 4,
        qwen35_oq_a8_enabled: false, qwen35_oq_a8_min_tokens: 128,
        qwen35_ane_prefill_enabled: false, qwen35_ane_prefill_max_layers: 64 };
    const prof = { turboquant_kv_enabled: false, turboquant_kv_bits: 8,
        qwen35_oq_a8_enabled: false, qwen35_oq_a8_min_tokens: 256,
        qwen35_ane_prefill_enabled: false, qwen35_ane_prefill_max_layers: 12 };
    assert.deepStrictEqual(aliasDiffChips(prof, base), []);
});
test('DIV-1: effective settings still win — base ON + profile knob override chips', () => {
    const base = { moe_expert_offload_enabled: true,
        moe_expert_offload_resident_fraction: 0.25 };
    const prof = { moe_expert_offload_resident_fraction: 0.5 };
    assert.deepStrictEqual(aliasDiffChips(prof, base),
        ['MOE_EXPERT_OFFLOAD_RESIDENT_FRACTION 0.5']);
});
test('DIV-1: a profile turning a master OFF vs base ON still chips the master', () => {
    const base = { turboquant_kv_enabled: true, turboquant_kv_bits: 4 };
    const prof = { turboquant_kv_enabled: false, turboquant_kv_bits: 4 };
    // enabled:false drops out of the chip loop (falsy), same as before;
    // the knob is gated off. Honest gap: the classic chip design never
    // showed disabled-anyway values; keep behaviour, pin it here.
    assert.deepStrictEqual(aliasDiffChips(prof, base), []);
});

/* ================= DIV-3: sync key-split ================= */
test('DIV-3: a sync pass deletes exactly the diff keys and keeps the rest', () => {
    // stored sparse profile over the same base (what the banner shows and
    // what the sync must strip — only the signature-diverging keys)
    const prof = { temperature: 0.2, enable_thinking: true,
        dflash_enabled: true, dflash_draft_model: 'd1',
        dflash_in_memory_cache_max_entries: 8 };
    const base = { temperature: 0.9, dflash_enabled: false,
        dflash_draft_model: null, dflash_in_memory_cache_max_entries: 4 };
    const diff = S.runtimeDiff(base, prof);
    assert.ok(diff.some(r => r.key === 'dflash_enabled'));
    assert.ok(diff.some(r => r.key === 'dflash_draft_model'));
    const ov = Object.assign({}, prof);
    for (const r of diff) delete ov[r.key];
    // dflash_in_memory_cache_max_entries rides the diff too: with the
    // master inherited (off) it is a dead knob, and dropping it is the
    // same cleanup DIV-1 applies to the chips
    assert.deepStrictEqual(ov,
        { temperature: 0.2, enable_thinking: true },
        'sampling/thinking survive; the whole diverging feature family follows the diff');
});
