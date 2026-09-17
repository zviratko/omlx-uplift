/* Node unit tests for the settings-parity spec: node --test tests/modelspec.test.cjs
   These mirror the invariants of omlx/model_settings.py, omlx/model_profiles.py
   and the classic dashboard.js save path. When upstream schema changes, keep
   this file and scripts/omlx_settings_store.py in sync. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../omlx_uplift/static/modelspec.js');

const base = (over = {}) => Object.assign({
    id: 'm1', model_type: 'llm', config_model_type: 'qwen3_5',
}, over);

/* ---- buildState ---- */
test('buildState: sane defaults for a plain LLM', () => {
    const st = S.buildState(base(), {});
    assert.strictEqual(st.model_alias, '');
    assert.strictEqual(st.temperature, null);
    assert.strictEqual(st.moe_expert_offload_enabled, false);
    assert.deepStrictEqual(st.ctKwargEntries, []);
    assert.strictEqual(st.is_diffusion_model, false);
});
test('buildState: diffusion model is detected from config_model_type', () => {
    const st = S.buildState(base({ config_model_type: 'diffusion-gemma' }), {});
    assert.strictEqual(st.is_diffusion_model, true);
});
test('buildState: forced PLE offload reads as on+locked', () => {
    const st = S.buildState(base({ qwen4_ple_ssd_offload_forced: true }), {});
    assert.strictEqual(st.qwen4_ple_ssd_offload, true);
    assert.strictEqual(st.qwen4_ple_ssd_offload_forced, true);
});
test('buildState: ct kwargs split into typed entries; presets vs custom', () => {
    const st = S.buildState(base(), {
        chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'high',
                                reasoning_split: true, custom_num: 5 },
        forced_ct_kwargs: ['enable_thinking'],
    });
    const by = {};
    for (const e of st.ctKwargEntries) by[e.type === 'custom' ? e.key : e.type] = e;
    assert.strictEqual(by.enable_thinking.value, 'true');
    assert.strictEqual(by.enable_thinking.force, true);
    assert.strictEqual(by.reasoning_effort.value, 'high');
    assert.strictEqual(by.reasoning_effort.custom, false);
    assert.strictEqual(by.custom_num.type, 'custom');
    assert.strictEqual(by.reasoning_split.value, 'true');
});
test('buildState: diffusion hides unsupported ct kwargs', () => {
    const st = S.buildState(base({ config_model_type: 'diffusion_gemma' }),
        { chat_template_kwargs: { enable_thinking: true, my_key: 1 } });
    assert.strictEqual(st.ctKwargEntries.length, 1);
    assert.strictEqual(st.ctKwargEntries[0].key, 'my_key');
});
test('buildState: MoE offload stays off when hardware unsupported', () => {
    const st = S.buildState(base({ moe_expert_offload_supported: false }),
        { moe_expert_offload_enabled: true });
    assert.strictEqual(st.moe_expert_offload_enabled, false);
});

/* ---- validate (server __post_init__ mirrors) ---- */
const ok = st => S.validate(st);
test('validate: sampling range checks (sweep 1.3a)', () => {
    const st = S.buildState(base(), {});
    assert.deepStrictEqual(ok(st), []);              // nulls inherit, no errors
    st.temperature = 99;
    assert.match(ok(st).join('|'), /Temperature must be between 0 and 2/);
    st.temperature = 1.5; st.top_p = 1.4; st.presence_penalty = -3;
    st.top_k = 2.5;
    const errs = ok(st).join('|');
    assert.match(errs, /Top P/); assert.match(errs, /Presence Penalty/);
    assert.match(errs, /Top K/);
});
test('validate: mtp + dflash conflict', () => {
    const st = S.buildState(base(), { mtp_enabled: true, dflash_enabled: true });
    assert.match(ok(st).join('|'), /Lightning MTP and DFlash/);
});
test('validate: oq A8 vs ANE conflict + min tokens', () => {
    const st = S.buildState(base(), { qwen35_oq_a8_enabled: true,
        qwen35_ane_prefill_enabled: true, qwen35_oq_a8_min_tokens: 0 });
    const errs = ok(st);
    assert.strictEqual(errs.length, 2);
});
test('validate: ANE prompt block multiple of 64', () => {
    const st = S.buildState(base(), { qwen35_ane_prefill_enabled: true,
        qwen35_ane_prefill_sequence_length: 1088 });   // 1088 % 64 === 0 but server wants >=1024 AND %64 — classic wants a multiple of 64, so test the real violation: 1056
    assert.deepStrictEqual(ok(st), []);   // 1088 = 17*64, valid
    st.qwen35_ane_prefill_sequence_length = 1056;   // 16.5*64 -> invalid
    assert.match(ok(st).join('|'), /multiple of 64/);
});
test('validate: MoE fraction bounds', () => {
    const st = S.buildState(base({ moe_expert_offload_supported: true }),
        { moe_expert_offload_enabled: true, moe_expert_offload_resident_fraction: 1.5 });
    assert.match(ok(st).join('|'), /resident fraction/);
});
test('validate: specprefill keep range', () => {
    const st = S.buildState(base(), { specprefill_enabled: true, specprefill_keep_pct: '0.9' });
    assert.match(ok(st).join('|'), /between 0.1 and 0.5/);
});
test('validate: clean state passes', () => {
    assert.deepStrictEqual(ok(S.buildState(base(), {})), []);
});

/* ---- buildPayload (classic saveModelSettings conventions) ---- */
test('buildPayload: full key set, null for unset numerics', () => {
    const p = S.buildPayload(S.buildState(base(), {}), base());
    assert.strictEqual(p.model_alias, null);
    assert.strictEqual(p.temperature, null);
    assert.strictEqual(p.max_tokens, null);
    assert.strictEqual(p.index_cache_freq, 0);           // 0 = disabled convention
    assert.strictEqual(p.thinking_budget_tokens, 0);
    assert.strictEqual(p.max_tool_result_tokens, 0);
    assert.strictEqual(p.turboquant_kv_bits, 4);
    assert.strictEqual(p.dflash_ssd_cache_max_bytes, 20 * S.GiB);
});
test('buildPayload: alias blank -> null; Gibbs -> bytes', () => {
    const st = S.buildState(base(), {});
    st.model_alias = '   ';
    st.dflash_enabled = true;
    st.dflash_ssd_cache_max_gib = 30;
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.model_alias, null);
    assert.strictEqual(p.dflash_ssd_cache_max_bytes, 30 * S.GiB);
});
test('buildPayload: ct kwargs coerce + forced list tracks force', () => {
    const st = S.buildState(base(), {
        chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'weird',
                                n: '10' },
        forced_ct_kwargs: ['n'],
    });
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.chat_template_kwargs.enable_thinking, false);
    assert.strictEqual(p.chat_template_kwargs.reasoning_effort, 'weird');
    assert.strictEqual(p.chat_template_kwargs.n, 10);     // numeric string coerced
    assert.deepStrictEqual(p.forced_ct_kwargs, ['n']);
});
test('buildPayload: guided grammar cleared when disabled', () => {
    const st = S.buildState(base(), {});
    st.guided_grammar_enabled = false; st.guided_grammar = '{"json":1}';
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.guided_grammar, null);
    assert.strictEqual(p.guided_grammar_enabled, false);
});
test('buildPayload: thinking-forced model sends enable_thinking null', () => {
    const m = base({ thinking_forced: true });
    const st = S.buildState(m, { enable_thinking: false });
    const p = S.buildPayload(st, m);
    assert.strictEqual(p.enable_thinking, null);
});
test('buildPayload: diffusion block zeroes sampling/spec fields', () => {
    const m = base({ config_model_type: 'diffusion_gemma' });
    const st = S.buildState(m, { top_p: 0.9, mtp_enabled: true, dflash_enabled: true,
                                 turboquant_kv_enabled: true });
    const p = S.buildPayload(st, m);
    assert.strictEqual(p.top_p, null);
    assert.strictEqual(p.mtp_enabled, false);
    assert.strictEqual(p.dflash_enabled, false);
    assert.strictEqual(p.turboquant_kv_enabled, false);
});
test('buildPayload: vlm_mtp drafter fields null unless enabled', () => {
    const st = S.buildState(base(), { vlm_mtp_enabled: false, vlm_mtp_draft_model: 'x' });
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.vlm_mtp_draft_model, null);
});

/* ---- draft candidate pools (classic filter+fallback semantics) ---- */
const models = [
    { id: 'Base-32B', model_type: 'llm', config_model_type: 'llama' },
    { id: 'DFlash-drafter', model_type: 'llm', config_model_type: 'muse_glimmer_assistant' },
    { id: 'gemma4-assistant', model_type: 'vlm', config_model_type: 'gemma4_assistant' },
    { id: 'random-mtp-thing', model_type: 'llm', config_model_type: '' },
    { id: 'virtual-p', model_type: 'llm', virtual: true },
];
test('draft pools: dflash matches drafter config types + name pattern', () => {
    const ids = S.dflashCandidates(models, 'Base-32B').map(m => m.id);
    assert.ok(ids.includes('DFlash-drafter'));
    assert.ok(!ids.includes('Base-32B'));
    assert.ok(!ids.some(i => i.startsWith('virtual')), 'virtual models excluded');
});
test('draft pools: vlm mtp uses config types or assistant/mtp name', () => {
    const ids = S.vlmMtpDrafters(models, 'Base-32B').map(m => m.id);
    assert.ok(ids.includes('gemma4-assistant'));
    assert.ok(ids.includes('random-mtp-thing'));
    assert.ok(!ids.includes('DFlash-drafter'));
});
test('draft pools: fallback to base set when filter empty', () => {
    const few = [{ id: 'plain', model_type: 'llm', config_model_type: 'llama' },
                 { id: 'other', model_type: 'llm', config_model_type: 'llama' }];
    const got = S.dflashCandidates(few, 'plain');
    assert.deepStrictEqual(got.map(m => m.id), ['other']);  // fallback = base minus selected
});
test('draft pools: current model excluded', () => {
    const got = S.specprefillCandidates(models, 'Base-32B').map(m => m.id);
    assert.ok(!got.includes('Base-32B'));
});
