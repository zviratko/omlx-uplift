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
        assert.ok(!(k in p), 'stripped key leaked into payload: ' + k);
    // universal keys classic keeps for every type survive
    assert.strictEqual(p.max_context_window, undefined);
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
