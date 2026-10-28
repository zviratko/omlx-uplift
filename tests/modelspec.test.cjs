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

/* SYNC-1 (upstream 7a4ea39): exactly the 8 fields deleted from
   ModelSettingsRequest (omlx/admin/routes.py, class has extra='forbid').
   None of them may reach the PUT body, the form state or the signature. */
const DEAD_DFLASH_KEYS = [
    'dflash_draft_quant_activation_bits', 'dflash_draft_sink_size',
    'dflash_in_memory_cache', 'dflash_in_memory_cache_max_entries',
    'dflash_in_memory_cache_max_bytes', 'dflash_max_ctx',
    'dflash_ssd_cache', 'dflash_ssd_cache_max_bytes',
];

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
test('validate: MoE fraction bounds (UP-18: classic 5..95 percent band)', () => {
    const st = S.buildState(base({ moe_expert_offload_supported: true }),
        { moe_expert_offload_enabled: true, moe_expert_offload_resident_fraction: 1.5 });
    assert.match(ok(st).join('|'), /resident experts must be between 5% and 95%/);
});
test('validate: specprefill keep range', () => {
    const st = S.buildState(base(), { specprefill_enabled: true, specprefill_keep_pct: '0.9' });
    assert.match(ok(st).join('|'), /between 0.1 and 0.5/);
});
// SYNC-1 (upstream d59d797 #4855 + 95e0fd6 #4819): GPU power cap + fp16 recast
test('state: enableGpuPowerLimit mirrors classic helper semantics (stored cap > 0)', () => {
    const st = S.buildState(base({ gpu_power_limit_supported: true }), { gpu_power_limit_w: 10 });
    assert.strictEqual(st.enableGpuPowerLimit, true);
    assert.strictEqual(S.buildState(base(), {}).gpu_power_limit_supported, false);
    const off = S.buildState(base({ activation_fp16_supported: true }), {});
    assert.strictEqual(off.activation_fp16_enabled, false);
    assert.strictEqual(off.activation_fp16_supported, true);
});
test('payload: gpu_power_limit_w carries 0 when off, watts when on; fp16 always', () => {
    const p = S.buildPayload(S.buildState(base(), {}), base());
    assert.strictEqual(p.gpu_power_limit_w, 0);
    assert.strictEqual(p.activation_fp16_enabled, false);
    const on = S.buildPayload(S.buildState(base({ gpu_power_limit_supported: true }),
        { gpu_power_limit_w: 25 }), base());
    assert.strictEqual(on.gpu_power_limit_w, 25);
    assert.strictEqual(on.activation_fp16_enabled, false);
    const fp = S.buildPayload(S.buildState(base({ activation_fp16_supported: true }),
        { activation_fp16_enabled: true }), base({ activation_fp16_supported: true }));
    assert.strictEqual(fp.activation_fp16_enabled, true);
});
test('payload: non-llm type flip strips the Advanced-column keys (SYNC-1)', () => {
    const emb = base({ model_type: 'embedding', config_model_type: 'embedding' });
    const p = S.buildPayload(S.buildState(emb, { gpu_power_limit_w: 30,
        activation_fp16_enabled: true }), emb);
    assert.ok(!('gpu_power_limit_w' in p), 'gpu key survived non-llm strip');
    assert.ok(!('activation_fp16_enabled' in p), 'fp16 key survived non-llm strip');
});
test('validate: offload x recast pair 400s server-side, watts ladder 2..1000', () => {
    const pair = S.buildState(base({ moe_expert_offload_supported: true,
        activation_fp16_supported: true }),
        { moe_expert_offload_enabled: true, activation_fp16_enabled: true });
    assert.match(ok(pair).join('|'), /float16 activation recast/);
    const bad = S.buildState(base({ gpu_power_limit_supported: true }),
        { enableGpuPowerLimit: true, gpu_power_limit_w: 1 });
    assert.match(ok(bad).join('|'), /whole number from 2 to 1000 W/);
    assert.deepStrictEqual(ok(S.buildState(base({ gpu_power_limit_supported: true }),
        { enableGpuPowerLimit: true, gpu_power_limit_w: 10 })), []);
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
    // SYNC-1 (upstream 7a4ea39): the 8 dflash cache/context fields are DELETED
    // from ModelSettingsRequest (extra='forbid') — buildPayload must never
    // emit them, or the whole save 422s.
    for (const dead of DEAD_DFLASH_KEYS)
        assert.ok(!(dead in p), 'dead dflash key in payload: ' + dead);
    // what survives at tip
    for (const live of ['dflash_enabled', 'dflash_draft_model',
                        'dflash_draft_quant_enabled',
                        'dflash_draft_quant_weight_bits',
                        'dflash_draft_quant_group_size',
                        'dflash_draft_window_size', 'dflash_block_size',
                        'dflash_verify_mode'])
        assert.ok(live in p, 'surviving dflash key missing: ' + live);
});
test('buildPayload: dflash ON still omits every dead field', () => {
    // the deletion is schema-side, not UI-side: even with the feature fully
    // configured (and a legacy stored value present in the state) the PUT
    // body must not carry a removed key.
    const st = S.buildState(base(), { dflash_enabled: true,
        dflash_draft_model: 'd1', dflash_draft_quant_enabled: true });
    st.dflash_ssd_cache = true;            // stale state from an old profile
    st.dflash_in_memory_cache_max_gib = 8;
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.dflash_enabled, true);
    assert.strictEqual(p.dflash_verify_mode, 'adaptive');
    assert.strictEqual(p.dflash_draft_quant_weight_bits, 4);
    assert.strictEqual(p.dflash_draft_quant_group_size, 64);
    for (const dead of DEAD_DFLASH_KEYS)
        assert.ok(!(dead in p), 'dead dflash key in payload: ' + dead);
});
test('buildState: legacy dflash cache fields and the ssd DTO flag are gone', () => {
    const st = S.buildState(base(), { dflash_ssd_cache: true,
        dflash_max_ctx: 4096, dflash_in_memory_cache_max_bytes: 8 * S.GiB });
    for (const dead of DEAD_DFLASH_KEYS.concat(['dflash_in_memory_cache_max_gib',
                                                'dflash_ssd_cache_max_gib']))
        assert.ok(!(dead in st), 'dead dflash field still in state: ' + dead);
    assert.ok(!('dflash_ssd_cache_available' in st),
        'tip deleted the dflash_ssd_cache_available DTO field — no reader');
});
test('buildState/buildPayload: dflash_verify_mode enum is adaptive|dflash|off', () => {
    // tip model_settings.py:429; a stored legacy 'ddtree' normalizes to
    // 'adaptive' exactly like the server's own validator (model_settings:495)
    assert.strictEqual(S.buildState(base(),
        { dflash_enabled: true, dflash_verify_mode: 'ddtree' }).dflash_verify_mode,
        'adaptive');
    assert.strictEqual(S.buildState(base(),
        { dflash_enabled: true, dflash_verify_mode: 'off' }).dflash_verify_mode,
        'off');
    const p = S.buildPayload(S.buildState(base(),
        { dflash_enabled: true, dflash_verify_mode: 'ddtree' }), base());
    assert.strictEqual(p.dflash_verify_mode, 'adaptive');
});
test('model editor verify-mode options match the tip enum (no ddtree)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..',
        'omlx_uplift', 'static', 'uplift_mmeditor.js'), 'utf8');
    assert.ok(!/value:\s*'ddtree'/.test(src), "'ddtree' option must be gone");
    assert.ok(/dflash_verify_mode[\s\S]{0,400}value:\s*'off'/.test(src),
        "the 'off' option classic renders must be offered");
});
test('buildPayload: alias blank -> null', () => {
    const st = S.buildState(base(), {});
    st.model_alias = '   ';
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.model_alias, null);
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

/* ---- upstream 62171bdf: adaptive MTP depth semantics ---- */
test('buildState: mtp_adaptive_max_depth is a 3/4/5/6 string, default 3', () => {
    assert.strictEqual(S.buildState(base(), {}).mtp_adaptive_max_depth, '3');
    assert.strictEqual(S.buildState(base(), { mtp_adaptive_max_depth: 5 }).mtp_adaptive_max_depth, '5');
    assert.strictEqual(S.buildState(base(), { mtp_adaptive_max_depth: 99 }).mtp_adaptive_max_depth, '3');
});
test('buildState: legacy mtp_num_draft_tokens reads as the same depth', () => {
    // servers older than 62171bdf store the adaptive ceiling under the
    // legacy name (Save failed: extra_forbidden regression, 2026-09-27)
    assert.strictEqual(S.buildState(base(), { mtp_num_draft_tokens: 4 }).mtp_adaptive_max_depth, '4');
    assert.strictEqual(S.buildState(base(), { mtp_adaptive_max_depth: 5,
        mtp_num_draft_tokens: 4 }).mtp_adaptive_max_depth, '5');
    assert.strictEqual(S.buildState(base(), { mtp_num_draft_tokens: 99 }).mtp_adaptive_max_depth, '3');
});
test('buildPayload: depth rides mtp_adaptive_max_depth; fixed depth cleared', () => {
    const p = S.buildPayload(S.buildState(base(), { mtp_enabled: true, mtp_adaptive_max_depth: '4' }), base());
    assert.strictEqual(p.mtp_adaptive_max_depth, 4);
    assert.strictEqual(p.mtp_fixed_depth, null);
    const off = S.buildPayload(S.buildState(base(), { mtp_enabled: false, mtp_adaptive_max_depth: '4' }), base());
    assert.strictEqual(off.mtp_adaptive_max_depth, null);
});
/* ---- server payload adaptation (version skew: keg predates 62171bdf) ---- */
test('adaptToServerPayload: old server gets the legacy mtp key back', () => {
    const oldFields = new Set(['mtp_enabled', 'mtp_num_draft_tokens']);
    const out = S.adaptToServerPayload(
        { mtp_enabled: true, mtp_adaptive_max_depth: 4, mtp_fixed_depth: null },
        oldFields);
    assert.strictEqual(out.mtp_num_draft_tokens, 4);
    assert.ok(!('mtp_adaptive_max_depth' in out));
    assert.ok(!('mtp_fixed_depth' in out));
});
test('adaptToServerPayload: new server keeps the modeled keys untouched', () => {
    const newFields = new Set(['mtp_enabled', 'mtp_adaptive_max_depth', 'mtp_fixed_depth']);
    const p = { mtp_enabled: true, mtp_adaptive_max_depth: 4, mtp_fixed_depth: null };
    assert.strictEqual(S.adaptToServerPayload(p, newFields), p);
});
test('adaptToServerPayload: unknown schema sends as modeled', () => {
    const p = { mtp_adaptive_max_depth: 4, mtp_fixed_depth: null };
    assert.strictEqual(S.adaptToServerPayload(p, null), p);
});
/* ---- profile-override adaptation (editor-state shape: select strings) ---- */
test('adaptToServerSettings: old server gets legacy key, string coerced', () => {
    const oldFields = new Set(['mtp_enabled', 'mtp_num_draft_tokens']);
    const out = S.adaptToServerSettings(
        { mtp_enabled: 'true', mtp_adaptive_max_depth: '4', mtp_fixed_depth: null },
        oldFields);
    assert.strictEqual(out.mtp_num_draft_tokens, 4);
    assert.ok(!('mtp_adaptive_max_depth' in out));
    assert.ok(!('mtp_fixed_depth' in out));
});
test('adaptToServerSettings: unset depth stays unset', () => {
    const oldFields = new Set(['mtp_num_draft_tokens']);
    const out = S.adaptToServerSettings({ temperature: '0.7' }, oldFields);
    assert.ok(!('mtp_num_draft_tokens' in out));
    assert.strictEqual(out.temperature, '0.7');
});
test('adaptToServerSettings: new server + unknown schema pass through', () => {
    const newFields = new Set(['mtp_adaptive_max_depth']);
    const s = { mtp_adaptive_max_depth: '4' };
    assert.strictEqual(S.adaptToServerSettings(s, newFields), s);
    assert.strictEqual(S.adaptToServerSettings(s, null), s);
});

/* ---- runtime signature replica (engine_pool._engine_runtime_signature) ---- */
const rt = (over = {}) => S.buildPayload(S.buildState(base(), over), base());
test('runtimeDiff: identical settings do not diverge', () => {
    assert.deepStrictEqual(S.runtimeDiff(rt(), rt()), []);
});
test('runtimeDiff: turboquant bits diverge only while the feature is on', () => {
    const d = S.runtimeDiff(rt({ turboquant_kv_enabled: true, turboquant_kv_bits: 4 }),
                            rt({ turboquant_kv_enabled: true, turboquant_kv_bits: 2 }));
    assert.deepStrictEqual(d.map(r => r.key), ['turboquant_kv_bits']);
    const off = S.runtimeDiff(rt({ turboquant_kv_bits: 4 }), rt({ turboquant_kv_bits: 2 }));
    assert.deepStrictEqual(off, [], 'stale bits with the feature off must not diverge');
});
test('runtimeDiff: mtp depth diverges while mtp is on', () => {
    const d = S.runtimeDiff(rt({ mtp_enabled: true, mtp_adaptive_max_depth: '3' }),
                            rt({ mtp_enabled: true, mtp_adaptive_max_depth: '5' }));
    assert.deepStrictEqual(d.map(r => r.key), ['mtp_adaptive_max_depth']);
});
test('runtimeDiff: a profile enabling a whole feature diverges on its key', () => {
    const d = S.runtimeDiff(rt(), rt({ specprefill_enabled: true, specprefill_draft_model: 'd' }));
    assert.ok(d.some(r => r.key === 'specprefill_enabled'));
});
test('runtimeDiff: sampling-only differences never diverge', () => {
    assert.deepStrictEqual(S.runtimeDiff(rt({ temperature: 0.2 }), rt({ temperature: 1.1 })), []);
});

/* ---- SPEC-1: SpecPrefill activation split (our omlx branch patch) ----
   specprefill_auto_enabled is the model/alias "active for every request"
   switch: request-time only. It must NEVER be engine material (the whole
   point is that aliases differ on it without a reload), it sends classic's
   fold (false = idle, anything else = null/unset), and it rides type flips
   with its SpecPrefill siblings. */
test('SPEC-1 buildState: unset reads active; stored false reads idle', () => {
    assert.strictEqual(S.buildState(base(), {}).specprefill_auto_enabled, true);
    assert.strictEqual(S.buildState(base(), { specprefill_auto_enabled: false })
        .specprefill_auto_enabled, false);
    assert.strictEqual(S.buildState(base(), { specprefill_auto_enabled: true })
        .specprefill_auto_enabled, true);
});
test('SPEC-1 buildPayload: false persists, true sends null (= unset)', () => {
    const st = S.buildState(base(), { specprefill_enabled: true,
                                      specprefill_draft_model: 'd' });
    st.specprefill_auto_enabled = false;
    assert.strictEqual(S.buildPayload(st, base()).specprefill_auto_enabled, false);
    st.specprefill_auto_enabled = true;
    assert.strictEqual(S.buildPayload(st, base()).specprefill_auto_enabled, null);
});
test('SPEC-1: activation is never engine material', () => {
    assert.ok(!S.RUNTIME_SETTING_KEYS.has('specprefill_auto_enabled'));
    assert.strictEqual(S.sigMasterKey('specprefill_auto_enabled'), '');
    const on = rt({ specprefill_enabled: true, specprefill_draft_model: 'd',
                    specprefill_auto_enabled: true });
    const off = rt({ specprefill_enabled: true, specprefill_draft_model: 'd',
                     specprefill_auto_enabled: false });
    assert.deepStrictEqual(S.runtimeDiff(on, off), [],
        'an alias flipping activation must never demand a reload');
});
test('SPEC-1 requestDiff: idle override on an active base diverges', () => {
    const d = S.requestDiff({ specprefill_enabled: true, specprefill_auto_enabled: true },
                            { specprefill_auto_enabled: false });
    assert.deepStrictEqual(d.map(r => r.key), ['specprefill_auto_enabled']);
    // dead knob both sides: master off everywhere -> no row (DIV-1)
    const dead = S.requestDiff({ specprefill_enabled: false, specprefill_auto_enabled: true },
                               { specprefill_auto_enabled: false });
    assert.deepStrictEqual(dead, []);
});
test('SPEC-1 type flip strips the activation payload key like its family', () => {
    assert.ok(S.TYPE_ONLY_KEYS.has('specprefill_auto_enabled'));
    const embModel = base({ id: 'e1', model_type: 'embedding' });
    const st = S.buildState(embModel, { specprefill_enabled: true,
                                        specprefill_draft_model: 'd' });
    st.specprefill_auto_enabled = false;
    assert.ok(!('specprefill_auto_enabled' in S.buildPayload(st, embModel)),
        'non-LLM save must not carry the activation flag');
});
test('SPEC-1: SpecPrefill profile classification after v3', () => {
    // master + drafter: not profile fields anymore (server EXCLUDED).
    for (const k of ['specprefill_enabled', 'specprefill_draft_model'])
        assert.ok(!S.DIFFUSION_UNSUPPORTED_PROFILE_FIELDS.has(k), k + ' must be absent');
    // keep/threshold: model-specific profile fields again — spec-decode is
    // inert on the diffusion lane, so they stay in the unsupported set.
    for (const k of ['specprefill_keep_pct', 'specprefill_threshold'])
        assert.ok(S.DIFFUSION_UNSUPPORTED_PROFILE_FIELDS.has(k), k + ' must be listed');
    // activation: universal but inert without the master — classic leaves it out.
    assert.ok(!S.DIFFUSION_UNSUPPORTED_PROFILE_FIELDS.has('specprefill_auto_enabled'));
});
test('SPEC-1 v3: keep/threshold left the runtime badge and signature', () => {
    assert.ok(!S.RUNTIME_SETTING_KEYS.has('specprefill_keep_pct'));
    assert.ok(!S.RUNTIME_SETTING_KEYS.has('specprefill_threshold'));
    assert.ok(S.RUNTIME_SETTING_KEYS.has('specprefill_enabled'));
    assert.ok(S.RUNTIME_SETTING_KEYS.has('specprefill_draft_model'));
    const a = rt({ specprefill_enabled: true, specprefill_draft_model: 'd',
                   specprefill_keep_pct: 0.2, specprefill_threshold: 1024 });
    const b = rt({ specprefill_enabled: true, specprefill_draft_model: 'd',
                   specprefill_keep_pct: 0.5, specprefill_threshold: 65536 });
    assert.deepStrictEqual(S.runtimeDiff(a, b), [],
        'an alias tuning keep/threshold must never demand a reload');
    const c = rt({ specprefill_enabled: true, specprefill_draft_model: 'other' });
    assert.ok(S.runtimeDiff(a, c).length > 0, 'a different drafter still forks');
});

/* ---- MT-1: model-type family (classic's llm/vlm gate) ----------------- */
const emb = (over = {}) => Object.assign({
    id: 'e1', model_type: 'embedding', config_model_type: 'qwen3',
}, over);
test('llmLike: llm/vlm/empty are generation families', () => {
    assert.strictEqual(S.llmLike(base()), true);
    assert.strictEqual(S.llmLike(base({ model_type: 'vlm' })), true);
    assert.strictEqual(S.llmLike(base({ model_type: '' })), true);
    assert.strictEqual(S.llmLike(base({ model_type: null })), true);
    assert.strictEqual(S.llmLike({}), true);          // unknown -> classic shows all
});
test('llmLike: non-generation types are hidden from the LLM form', () => {
    for (const t of ['embedding', 'reranker', 'audio_stt', 'audio_tts',
                     'audio_sts', 'decision'])
        assert.strictEqual(S.llmLike(emb({ model_type: t })), false, t);
});
test('llmLike: model_type_override decides — both directions', () => {
    // the server rewrites entry.model_type from the override at discovery,
    // so the editor gate must follow the override, not the checkpoint
    assert.strictEqual(S.llmLike(base({ model_type_override: 'embedding' })), false);
    assert.strictEqual(S.llmLike(emb({ model_type_override: 'llm' })), true);
});
test('buildPayload: non-LLM type strips every type-only key', () => {
    const st = S.buildState(emb(), { temperature: 0.7, mtp_enabled: true,
        trust_remote_code: true, guided_grammar_enabled: true,
        max_context_window: 4096, enable_thinking: true });
    const p = S.buildPayload(st, emb());
    for (const k of S.TYPE_ONLY_KEYS)
        if (k !== 'max_context_window')                 // UP-54 carve-out below
            assert.ok(!(k in p), 'stripped key leaked into payload: ' + k);
    // UP-54 (upstream 153aaee #4826): classic's ms-basic rows the context
    // window for embedding/reranker too — the ONE type-only key that
    // survives for exactly those families (audio/decision strip it, pinned
    // in sync1-fire9-adoption.test.cjs).
    assert.strictEqual(p.max_context_window, 4096);
    // universal keys classic keeps for every type survive
    assert.strictEqual(p.ttl_seconds, null);
    assert.strictEqual(p.model_type_override, null);
});
test('buildPayload: override flip strips, override to llm keeps', () => {
    const st = S.buildState(base(), { temperature: 0.7 });
    const llm = S.buildPayload(st, base());
    assert.strictEqual(llm.temperature, 0.7);
    const flipped = S.buildPayload(Object.assign({}, st,
        { model_type_override: 'embedding' }), base());
    assert.ok(!('temperature' in flipped));
    assert.strictEqual(flipped.model_type_override, 'embedding');
    const backToLlm = S.buildPayload(Object.assign({}, st,
        { model_type_override: 'vlm' }), emb());
    assert.strictEqual(backToLlm.temperature, 0.7);
});
test('buildPayload: reasoning_parser and ttl stay for all types', () => {
    // classic renders Row 1 (alias/type/reasoning parser) and TTL outside
    // the llm/vlm gate — a reranker keeps its parser setting
    const st = S.buildState(emb(), { reasoning_parser: 'qwen', ttl_seconds: 60 });
    const p = S.buildPayload(st, emb());
    assert.strictEqual(p.reasoning_parser, 'qwen');
    assert.strictEqual(p.ttl_seconds, 60);
});
test('buildPayload: embedding audio pair only for supported models', () => {
    const st = S.buildState(emb(), { embedding_audio_enabled: true,
                                     embedding_audio_max_seconds: 45 });
    const p = S.buildPayload(st, emb({ embedding_audio_supported: true }));
    assert.strictEqual(p.embedding_audio_enabled, true);
    assert.strictEqual(p.embedding_audio_max_seconds, 45);
    const p2 = S.buildPayload(st, emb({ model_type_override: 'llm',
                                        embedding_audio_supported: true }));
    assert.strictEqual(p2.embedding_audio_max_seconds, 45); // llm gate must not eat it
    const q = S.buildPayload(st, emb());
    assert.ok(!('embedding_audio_enabled' in q), 'unsupported model: key not sent');
});
test('validate: non-LLM model skips hidden-family rules', () => {
    const st = S.buildState(emb(), { mtp_enabled: true, dflash_enabled: true,
        specprefill_enabled: true, temperature: 99 });
    assert.deepStrictEqual(S.validate(st, emb()), [],
        'stale LLM values must not block a reranker save');
    assert.ok(S.validate(st, base()).length > 0, 'same values DO validate as llm');
});
test('stickyForType: only masters that are ON are named', () => {
    assert.deepStrictEqual(S.stickyForType({ temperature: 1, top_p: 0.9 }), []);
    assert.deepStrictEqual(S.stickyForType({ trust_remote_code: true,
        thinking_budget_tokens: 512 }), ['trust_remote_code']);
    const s = S.stickyForType({ mtp_enabled: true, dflash_enabled: false,
        chat_template_kwargs: { x: 1 } });
    assert.deepStrictEqual(s, ['mtp_enabled', 'chat_template_kwargs']);
});
test('runtimeSignature: embedding audio mirrors engine_pool gating', () => {
    const rtA = (over = {}) => S.buildPayload(
        S.buildState(emb({ embedding_audio_supported: true }), over),
        emb({ embedding_audio_supported: true }));
    const on = rtA({ embedding_audio_enabled: true, embedding_audio_max_seconds: 45 });
    const off = rtA({ embedding_audio_enabled: false, embedding_audio_max_seconds: 10 });
    // length counts only while the tower is loaded
    assert.deepStrictEqual(S.runtimeDiff(off, rtA({ embedding_audio_max_seconds: 99 })), []);
    const d = S.runtimeDiff(on, rtA({ embedding_audio_enabled: true,
                                      embedding_audio_max_seconds: 10 }));
    assert.deepStrictEqual(d.map(r => r.key), ['embedding_audio_max_seconds']);
});

/* SYNC-1 2026-10-13: upstream external_engine (splash). engine_pool lists it
   in _engine_runtime_signature, so the editor must treat it as deferred
   runtime material — never a live classic PUT key (auto-unload doctrine). */
test('external_engine: round-trips state<->payload and diffs as runtime key', () => {
    const on = S.buildPayload(S.buildState(base(), { external_engine: 'splash' }), base());
    assert.strictEqual(on.external_engine, 'splash');
    const off = S.buildPayload(S.buildState(base(), {}), base());
    assert.strictEqual(off.external_engine, null);
    assert.ok(S.RUNTIME_SETTING_KEYS.has('external_engine'),
        'signed by engine_pool — must ride the deferred store + RELOAD badge');
    const d = S.runtimeDiff(off, on);
    assert.deepStrictEqual(d.map(r => r.key), ['external_engine']);
});
test('external_engine: off by default; non-LLM payloads must not carry it', () => {
    assert.strictEqual(S.buildState(base(), {}).external_engine, '');
    // TYPE_ONLY_KEYS: classic renders the row only under its llm/vlm gate,
    // so a non-LLM save must not touch the key. (Diffusion: the mmeditor
    // hides the row and the classic PUT itself forces None server-side.)
    assert.ok(S.RUNTIME_SETTING_KEYS.has('external_engine'));
    const nonLlm = base({ model_type: 'embedding', config_model_type: '' });
    const p = S.buildPayload(S.buildState(nonLlm, {}), nonLlm);
    assert.ok(!('external_engine' in p),
        'buildPayload must strip TYPE_ONLY keys for non-LLM models');
});

/* ================= SYNC-1: qwen4_gdn_decode_wide_proj global -> model =====
   Upstream 3c39990 removed it from GlobalSettingsRequest and added it to
   ModelSettingsRequest (routes.py:365; default False, model_settings.py:344;
   the server clamps it to config_model_type == 'qwen4_exp' at routes.py:2833,
   and classic gates the row on the same test — dashboard.js:2152). The
   RUNNING keg may still be pre-move, so the key is emitted ONLY for a
   supported model and adaptToServer* strips it whenever the live schema
   lacks it. */
const qwen4Exp = (over = {}) => base(Object.assign(
    { config_model_type: 'qwen4_exp' }, over));
test('qwen4_gdn: support flag mirrors classic (config_model_type qwen4_exp)', () => {
    assert.strictEqual(S.buildState(qwen4Exp(), {}).qwen4_gdn_decode_wide_proj_supported, true);
    assert.strictEqual(S.buildState(base(), {}).qwen4_gdn_decode_wide_proj_supported, false,
        'qwen3_5 must not show the row');
    assert.strictEqual(S.buildState(base({ config_model_type: 'Qwen4-Exp' }), {})
        .qwen4_gdn_decode_wide_proj_supported, true, 'normalized like classic');
});
test('qwen4_gdn: payload key ONLY when the row is supported', () => {
    const off = S.buildPayload(S.buildState(qwen4Exp(), {}), qwen4Exp());
    assert.strictEqual(off.qwen4_gdn_decode_wide_proj, false);
    const on = S.buildPayload(S.buildState(qwen4Exp(),
        { qwen4_gdn_decode_wide_proj: true }), qwen4Exp());
    assert.strictEqual(on.qwen4_gdn_decode_wide_proj, true);
    const foreign = S.buildPayload(S.buildState(base(),
        { qwen4_gdn_decode_wide_proj: true }), base());
    assert.ok(!('qwen4_gdn_decode_wide_proj' in foreign),
        'unsupported model: key must be ABSENT (old keg forbids it, 422 else)');
});
test('qwen4_gdn: non-LLM type strips it like the other Advanced rows', () => {
    const m = qwen4Exp({ model_type: 'embedding' });
    const p = S.buildPayload(S.buildState(m, { qwen4_gdn_decode_wide_proj: true }), m);
    assert.ok(!('qwen4_gdn_decode_wide_proj' in p));
    assert.ok(S.TYPE_ONLY_KEYS.has('qwen4_gdn_decode_wide_proj'));
});
test('qwen4_gdn: engine-reload material, so the editor badges RELOAD', () => {
    // tip engine_pool:1118-1122 adds it to _engine_runtime_signature
    assert.ok(S.RUNTIME_SETTING_KEYS.has('qwen4_gdn_decode_wide_proj'));
    const a = S.buildPayload(S.buildState(qwen4Exp(), {}), qwen4Exp());
    const b = S.buildPayload(S.buildState(qwen4Exp(),
        { qwen4_gdn_decode_wide_proj: true }), qwen4Exp());
    assert.deepStrictEqual(S.runtimeDiff(a, b).map(r => r.key),
        ['qwen4_gdn_decode_wide_proj']);
    assert.deepStrictEqual(S.runtimeDiff(a, a), [], 'identical values do not diverge');
});
test('qwen4_gdn: adaptToServer drops it for a pre-3c39990 keg, keeps otherwise', () => {
    const oldSchema = new Set(['mtp_adaptive_max_depth', 'dflash_enabled']);
    const newSchema = new Set([...oldSchema, 'qwen4_gdn_decode_wide_proj']);
    const body = { temperature: 0.7, qwen4_gdn_decode_wide_proj: true };
    assert.ok(!('qwen4_gdn_decode_wide_proj' in
        S.adaptToServerPayload(body, oldSchema)), 'old keg: never PUT the key');
    assert.strictEqual(S.adaptToServerPayload(body, newSchema), body,
        'new keg + no dead key: payload passes through by identity');
    assert.strictEqual(S.adaptToServerPayload(body, null), body,
        'unknown schema: send as modeled');
    // profile overrides ride the same gate
    assert.ok(!('qwen4_gdn_decode_wide_proj' in
        S.adaptToServerSettings(body, oldSchema)), 'old keg: profile write too');
    assert.strictEqual(S.adaptToServerSettings(body, newSchema), body);
});
test('qwen4_gdn: sticky when a profile flips the model to a non-LLM type', () => {
    assert.deepStrictEqual(S.stickyForType({ qwen4_gdn_decode_wide_proj: true }),
        ['qwen4_gdn_decode_wide_proj']);
});
test('qwen4_gdn: NOT a global setting anymore (GS_MAP dropped the row)', () => {
    const GS = require('../omlx_uplift/static/uplift_gspec.js');
    assert.ok(!('qwen4_gdn_decode_wide_proj' in GS.GS_MAP),
        'tip GlobalSettingsRequest has no such field — the global save must not send it');
    const gsys = require('fs').readFileSync(require('path').join(__dirname, '..',
        'omlx_uplift', 'static', 'uplift_gsys.js'), 'utf8');
    assert.ok(!/field:\s*'qwen4_gdn_decode_wide_proj'/.test(gsys),
        'the global toggle row must be gone from the Server tab');
});
/* SYNC-1 (7a4ea39): dead dflash fields must not survive on ANY modelspec
   surface — the lists, the state, the payload, the signature. */
test('dflash: no dead field name is left anywhere in modelspec.js', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..',
        'omlx_uplift', 'static', 'modelspec.js'), 'utf8');
    for (const dead of DEAD_DFLASH_KEYS.concat(['dflash_ssd_cache_available'])) {
        const re = new RegExp("'" + dead + "'");
        assert.ok(!re.test(src), 'modelspec.js still names ' + dead);
    }
});
test('dflash: surviving family keeps its payload + signature semantics', () => {
    const st = S.buildState(base(), { dflash_enabled: true, dflash_draft_model: 'd1',
        dflash_draft_window_size: 1024, dflash_block_size: 8, dflash_verify_mode: 'dflash' });
    const p = S.buildPayload(st, base());
    assert.strictEqual(p.dflash_draft_window_size, 1024);
    assert.strictEqual(p.dflash_block_size, 8);
    assert.strictEqual(p.dflash_verify_mode, 'dflash');
    const off = S.buildPayload(S.buildState(base(), { dflash_enabled: false,
        dflash_draft_model: 'd1', dflash_block_size: 8 }), base());
    assert.strictEqual(off.dflash_block_size, null);
    assert.strictEqual(off.dflash_verify_mode, null);
    for (const k of ['dflash_draft_window_size', 'dflash_block_size', 'dflash_verify_mode']) {
        assert.ok(S.RUNTIME_SETTING_KEYS.has(k), k + ' is engine_pool signature material');
        assert.strictEqual(S.sigMasterKey(k), 'dflash_enabled', k + ' gated by dflash');
    }
});



/* ---- UP-18: capability gating + validation depth (classic parity) ---- */
test('UP-18(1): MoE offload x MTP follows the server verdict moe_offload_allows_mtp', () => {
    const mk = (allows) => S.buildState(
        base({ moe_expert_offload_supported: true, moe_offload_allows_mtp: allows }),
        { moe_expert_offload_enabled: true, mtp_enabled: true });
    const stYes = mk(true);
    assert.strictEqual(stYes.moe_offload_allows_mtp, true);
    assert.ok(!S.validate(stYes, base({ moe_offload_allows_mtp: true }))
        .some(e => /Lightning MTP/i.test(e)), 'allowed pairing must not error');
    const stNo = mk(false);
    assert.ok(S.validate(stNo, base()).some(e => /Lightning MTP on this model/i.test(e)),
        'disallowed pairing still errors');
    // VLM MTP / DFlash stay blocked with offload regardless of the flag
    const stVlm = S.buildState(base({ moe_expert_offload_supported: true,
        moe_offload_allows_mtp: true }),
        { moe_expert_offload_enabled: true, vlm_mtp_enabled: true });
    assert.ok(S.validate(stVlm, base()).some(e => /VLM MTP or DFlash/.test(e)));
});
test('UP-18(2): paroquant zeroes KV compression at load and blocks the family in validate', () => {
    const st = S.buildState(base({ is_paroquant: true, paroquant_reason: 'pq packed format' }),
        { turboquant_kv_enabled: true, turboquant_kv_scheme: 'affine4', turboquant_kv_bits: 8 });
    assert.strictEqual(st.turboquant_kv_enabled, false);
    assert.strictEqual(st.turboquant_kv_scheme, 'turboquant');
    assert.strictEqual(st.turboquant_kv_bits, 4);
    st.specprefill_enabled = true;
    const errs = S.validate(st, base({ is_paroquant: true }));
    assert.ok(errs.some(e => e === 'pq packed format'), 'server reason surfaces verbatim: ' + errs);
});
test('UP-18(4): index-cache frequency rides the classic 2..16 ladder', () => {
    const st = S.buildState(base(), { index_cache_freq: 40 });
    assert.ok(S.validate(st, base()).some(e => /between 2 and 16/.test(e)));
    const ok = S.buildState(base(), { index_cache_freq: 4 });
    assert.strictEqual(S.validate(ok, base()).length, 0);
});
test('UP-18(7): resident experts keep the classic 5..95 percent band', () => {
    const st = S.buildState(base({ moe_expert_offload_supported: true }),
        { moe_expert_offload_enabled: true, moe_expert_offload_resident_fraction: 0.02 });
    assert.ok(S.validate(st, base()).some(e => /between 5% and 95%/.test(e)));
});
test('UP-18(5): oQ A8 family includes qwen4_exp; the row honors the server verdict', () => {
    assert.ok(S.isQwenOqA8(base({ config_model_type: 'qwen4_exp' })));
    assert.ok(S.isQwenOqA8(base({ config_model_type: 'qwen3_6_moe' })));
    assert.ok(!S.isQwenOqA8(base({ config_model_type: 'llama' })));
    assert.ok(!S.showsQwenOqA8(base({ config_model_type: 'qwen4_exp' })),
        'family alone does NOT show the row (pre-M5 hardware)');
    assert.ok(S.showsQwenOqA8(base({ config_model_type: 'qwen4_exp',
        qwen35_oq_a8_supported: true })));
    assert.ok(S.showsQwenOqA8(base({ config_model_type: 'qwen3_5',
        settings: { qwen35_oq_a8_enabled: true } })), 'a saved-on keeps the row to allow off');
});
test('UP-18(4): DSA_MODEL_TYPES exported exactly like classic', () => {
    assert.deepStrictEqual([...S.DSA_MODEL_TYPES].sort(), ['deepseek_v32', 'glm_moe_dsa']);
});
