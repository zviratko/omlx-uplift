/* Uplift model-settings specification — a faithful client reimplementation of
   the classic dashboard's model settings editor (dashboard.js +
   _modal_model_settings.html) and the server schema (model_settings.py,
   model_profiles.py, admin/routes.py update_model_settings).

   Kept UI-free (pure data + validation) so it is unit-testable under Node.
   Field names, option lists, defaults, visibility rules, cross-field
   validation and the exact PUT payload shape mirror the originals; when the
   server schema changes, update this file AND its twin checks in
   tests/uplift.test.cjs. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftModelSpec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ---- constants copied from the originals ---- */
    const DIFFUSION_CONFIG_MODEL_TYPES = new Set(['diffusion_gemma']);
    const DIFFUSION_UNSUPPORTED_PROFILE_FIELDS = new Set([
        'top_p', 'top_k', 'min_p', 'repetition_penalty', 'presence_penalty',
        'force_sampling', 'enable_thinking', 'preserve_thinking',
        'cache_reasoning_output',
        'thinking_budget_enabled', 'thinking_budget_tokens', 'reasoning_parser',
        'guided_grammar_enabled', 'guided_grammar', 'max_tool_result_tokens',
        'index_cache_freq', 'turboquant_kv_enabled', 'turboquant_kv_scheme',
        'turboquant_kv_bits',
        'turboquant_skip_last', 'qwen35_ane_prefill_enabled',
        'qwen35_ane_prefill_sequence_length',
        'qwen35_ane_prefill_tail_padding_min_tokens', 'qwen35_ane_prefill_fraction',
        'qwen35_ane_prefill_fused_down', 'qwen35_ane_prefill_max_layers',
        'qwen35_ane_prefill_dual_ane', 'qwen35_ane_prefill_gdn',
        'qwen35_ane_prefill_gdn_fraction', 'qwen35_ane_prefill_gdn_max_layers',
        'qwen35_ane_prefill_cpu_enabled', 'qwen35_ane_prefill_cpu_fraction',
        'qwen35_ane_prefill_cpu_down_fraction', 'qwen35_ane_prefill_cpu_gdn_fraction',
        'qwen35_ane_prefill_cpu_threads', 'qwen35_ane_prefill_cpu_shared_resource',
        'moe_expert_offload_enabled', 'moe_expert_offload_resident_fraction',
        'qwen35_oq_a8_enabled', 'qwen35_oq_a8_min_tokens',
        'external_engine',
        'specprefill_enabled', 'specprefill_draft_model', 'specprefill_keep_pct',
        // SYNC-1 (upstream 7a4ea39): the dflash cache/context knobs are gone
        // from ModelSettingsRequest (extra='forbid'); only these survive.
        'specprefill_threshold', 'dflash_enabled', 'dflash_draft_model',
        'dflash_draft_quant_enabled', 'dflash_draft_quant_weight_bits',
        'dflash_draft_quant_group_size', 'dflash_draft_window_size',
        'dflash_block_size', 'dflash_verify_mode', 'mtp_enabled', 'mtp_adaptive_max_depth',
        'mtp_fixed_depth', 'qwen35_ane_prefill_shared_fraction',
        'vlm_mtp_enabled', 'vlm_mtp_draft_model', 'vlm_mtp_draft_block_size',
    ]);
    const DIFFUSION_UNSUPPORTED_CT_KWARGS = new Set([
        'enable_thinking', 'reasoning_effort', 'preserve_thinking',
    ]);
    const REASONING_EFFORT_PRESETS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    const MODEL_TYPE_OPTIONS = ['llm', 'vlm', 'embedding', 'reranker',
                                'audio_stt', 'audio_tts', 'audio_sts',
                                'decision'];
    const VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES = new Set([
        'gemma4_assistant', 'gemma4_unified_assistant', 'qwen3_5_mtp',
    ]);
    const SAMPLING_TYPES = new Set(['llm', 'vlm']);
    const GiB = 1024 ** 3;

    /* ---- MT-1: model-type family (parity with classic's four
       `!selectedModel?.model_type || model_type === 'llm' || 'vlm'` gates
       in _modal_model_settings.html). Non-LLM engines (embedding, reranker,
       audio_stt/tts/sts, decision) run a different API surface: sampling,
       thinking, grammar, spec-decode and chat-template kwargs do not exist
       there, so classic hides them. The gate tests the EFFECTIVE type —
       engine_pool.apply_settings_overrides rewrites entry.model_type from
       model_type_override before any engine is chosen — so a live override
       flip in the editor must re-shape the form exactly like a real type. ---- */
    function llmLike(m) {
        const t = normType((m && (m.model_type_override || m.model_type)) || '');
        return t === '' || SAMPLING_TYPES.has(t);
    }
    /* Payload keys classic hides behind the llm/vlm gate — everything in
       its Advanced column plus the ctx/max-tokens/temperature rows. The
       editor must not let a flip save these to a non-LLM model.
       NOT included: model_alias, model_type_override, reasoning_parser and
       ttl_seconds — classic renders those for every type (Row 1 + TTL). */
    const TYPE_ONLY_KEYS = new Set([
        'max_context_window', 'max_tokens', 'temperature', 'top_p', 'top_k',
        'repetition_penalty', 'min_p', 'presence_penalty', 'force_sampling',
        'enable_thinking', 'thinking_budget_enabled',
        'thinking_budget_tokens', 'cache_reasoning_output',
        // SYNC-1 (upstream d59d797 #4855 + 95e0fd6 #4819): GPU power cap and
        // the fp16 recast rows join the classic Advanced column — the whole
        // column sits behind the llm/vlm gate, so the type flip must strip
        // them like its neighbours.
        'gpu_power_limit_w', 'activation_fp16_enabled',
        'guided_grammar_enabled', 'guided_grammar',
        'max_tool_result_tokens', 'chat_template_kwargs', 'forced_ct_kwargs',
        'trust_remote_code', 'index_cache_freq', 'turboquant_kv_enabled',
        'turboquant_kv_scheme', 'turboquant_kv_bits', 'moe_expert_offload_enabled',
        'moe_expert_offload_resident_fraction', 'qwen4_ple_ssd_offload',
        // SYNC-1 (upstream 3c39990): model-level, not server-level
        'qwen4_gdn_decode_wide_proj',
        'deepseek_v41_ced_prefill_enabled', 'deepseek_v41_engram_ssd_offload',
        'qwen35_oq_a8_enabled', 'qwen35_oq_a8_min_tokens',
        'external_engine',
        'specprefill_enabled', 'specprefill_draft_model', 'specprefill_keep_pct',
        // SYNC-1 (upstream 7a4ea39): surviving dflash family only.
        'specprefill_threshold', 'dflash_enabled', 'dflash_draft_model',
        'dflash_draft_quant_enabled', 'dflash_draft_quant_weight_bits',
        'dflash_draft_quant_group_size', 'dflash_draft_window_size',
        'dflash_block_size', 'dflash_verify_mode', 'mtp_enabled',
        'mtp_adaptive_max_depth', 'mtp_fixed_depth', 'vlm_mtp_enabled',
        'vlm_mtp_draft_model', 'vlm_mtp_draft_block_size',
        'qwen35_ane_prefill_enabled', 'qwen35_ane_prefill_sequence_length',
        'qwen35_ane_prefill_tail_padding_min_tokens', 'qwen35_ane_prefill_fraction',
        'qwen35_ane_prefill_shared_fraction', 'qwen35_ane_prefill_fused_down',
        'qwen35_ane_prefill_max_layers', 'qwen35_ane_prefill_dual_ane',
        'qwen35_ane_prefill_gdn', 'qwen35_ane_prefill_gdn_fraction',
        'qwen35_ane_prefill_gdn_max_layers', 'qwen35_ane_prefill_cpu_enabled',
        'qwen35_ane_prefill_cpu_fraction', 'qwen35_ane_prefill_cpu_down_fraction',
        'qwen35_ane_prefill_cpu_gdn_fraction', 'qwen35_ane_prefill_cpu_threads',
        'qwen35_ane_prefill_cpu_shared_resource',
    ]);
    /* Hidden-family masters whose non-default stored values survive a flip
       to a non-LLM type (the classic PUT merges — omitted fields are not
       cleared). stickyForType lists the ones actually ON; the editor warns. */
    function stickyForType(settings) {
        // stored settings dict (server shape) -> hidden-family masters that
        // are actually ON (a knob alone is noise — its master names the
        // feature). These keys survive a type flip: the PUT merges.
        const s = settings || {};
        const on = v => v === true;
        const out = [];
        if (on(s.trust_remote_code)) out.push('trust_remote_code');
        if (on(s.enable_thinking)) out.push('enable_thinking');
        if (on(s.thinking_budget_enabled)) out.push('thinking_budget_enabled');
        if (on(s.cache_reasoning_output)) out.push('cache_reasoning_output');
        if (on(s.guided_grammar_enabled) || s.guided_grammar) out.push('guided_grammar');
        if (on(s.turboquant_kv_enabled)) out.push('turboquant_kv_enabled');
        if (on(s.mtp_enabled)) out.push('mtp_enabled');
        if (on(s.vlm_mtp_enabled)) out.push('vlm_mtp_enabled');
        if (on(s.specprefill_enabled)) out.push('specprefill_enabled');
        if (on(s.dflash_enabled)) out.push('dflash_enabled');
        if (on(s.qwen35_ane_prefill_enabled)) out.push('qwen35_ane_prefill_enabled');
        if (on(s.qwen35_oq_a8_enabled)) out.push('qwen35_oq_a8_enabled');
        if (on(s.moe_expert_offload_enabled)) out.push('moe_expert_offload_enabled');
        if (on(s.qwen4_ple_ssd_offload)) out.push('qwen4_ple_ssd_offload');
        if (on(s.qwen4_gdn_decode_wide_proj)) out.push('qwen4_gdn_decode_wide_proj');
        if (on(s.deepseek_v41_ced_prefill_enabled)) out.push('deepseek_v41_ced_prefill_enabled');
        if (on(s.deepseek_v41_engram_ssd_offload)) out.push('deepseek_v41_engram_ssd_offload');
        if (s.chat_template_kwargs && Object.keys(s.chat_template_kwargs).length)
            out.push('chat_template_kwargs');
        return out;
    }

    const normType = t => String(t || '').toLowerCase().replace(/-/g, '_');
    const isDiffusion = m => DIFFUSION_CONFIG_MODEL_TYPES.has(normType(m && m.config_model_type));
    // UP-18 (5): the classic family (dashboard.js isQwenOqA8Model) — routed-
    // expert A8 lives on qwen4_exp too, not only the qwen3_5/6/8 prefixes.
    const isQwenOqA8 = m => {
        const t = normType(m && m.config_model_type);
        return t === 'qwen4_exp'
            || ['qwen3_5', 'qwen3_6', 'qwen3_8'].some(p => t.startsWith(p));
    };
    // UP-18 (5): classic showsQwenOqA8 — the kernels need native INT8
    // tensor ops (M5-series or newer, server verdict qwen35_oq_a8_supported);
    // a saved "on" keeps the row so it can be turned off.
    const showsQwenOqA8 = m => isQwenOqA8(m)
        && (m && m.qwen35_oq_a8_supported === true
            || !!((m && m.settings) && m.settings.qwen35_oq_a8_enabled === true));
    // UP-18 (4): classic DSA_MODEL_TYPES — the Index Cache row exists only
    // for sparse-attention models (DeepSeek V3.2 / GLM DSA).
    const DSA_MODEL_TYPES = new Set(['deepseek_v32', 'glm_moe_dsa']);

    /* ---- form state (mirrors buildModelSettingsState) ---- */
    function coerceKwargValue(v) {
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (String(v).trim() !== '') {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        return v;
    }

    function buildCtKwargEntries(chatTemplateKwargs, forcedCtKwargs, diffusion) {
        const ctk = chatTemplateKwargs || {};
        const forced = new Set(forcedCtKwargs || []);
        const entries = [];
        for (const [key, value] of Object.entries(ctk)) {
            if (diffusion && DIFFUSION_UNSUPPORTED_CT_KWARGS.has(key)) continue;
            if (key === 'enable_thinking') {
                entries.push({ type: 'enable_thinking', value: String(value), force: forced.has(key) });
            } else if (key === 'reasoning_effort') {
                const asStr = String(value);
                const preset = REASONING_EFFORT_PRESETS.has(asStr);
                entries.push({ type: 'reasoning_effort', value: preset ? asStr : REASONING_EFFORT_PRESETS.values().next().value,
                               custom: !preset, customValue: preset ? '' : asStr, force: forced.has(key) });
            } else {
                entries.push({ type: 'custom', key, value: String(value), force: forced.has(key) });
            }
        }
        return entries;
    }

    /* The identity a kwargs row occupies in the settings dict. Typed kinds
       map to a fixed key; a 'custom' row carries its own. Empty-string key
       (untitled custom row mid-typing) is NOT an identity: it can never
       collide, matching buildPayload which drops it. */
    function kwargIdentity(e) {
        if (!e) return null;
        if (e.type === 'enable_thinking') return 'enable_thinking';
        if (e.type === 'reasoning_effort') return 'reasoning_effort';
        if (e.type === 'custom' && e.key != null && String(e.key).trim() !== '') {
            return String(e.key).trim();
        }
        return null;
    }

    /* CT-1 root cause: the old keep-filter in the editor compared
       `!(e.key in raw)`. Typed entries have no e.key, so `undefined in raw`
       was always false and a base typed row survived the merge on top of
       the identical row rebuilt from the raw payload — two 'reasoning_effort'
       rows. Merge BY IDENTITY instead: raw wins on collision, rows it does
       not mention are kept, untitled custom rows are kept. */
    function mergeRawKwargs(rawKwargs, forced, existing, diffusion) {
        const rebuilt = buildCtKwargEntries(rawKwargs, forced, diffusion);
        const ids = new Set(rebuilt.map(kwargIdentity).filter(Boolean));
        const keep = (existing || []).filter(e => {
            const id = kwargIdentity(e);
            return id === null || !ids.has(id);
        });
        return rebuilt.concat(keep);
    }

    // Lightning MTP depth: one adaptive ceiling. New servers carry it as
    // mtp_adaptive_max_depth (62171bdf); older ones store the same value as
    // mtp_num_draft_tokens. Accept either name, clamp to the modeled set.
    function mtpDepthOf(s) {
        const raw = s.mtp_adaptive_max_depth != null ? s.mtp_adaptive_max_depth
            : s.mtp_num_draft_tokens;
        return [3, 4, 5, 6].includes(Number(raw)) ? String(Number(raw)) : '3';
    }

    function buildState(model, s) {
        s = s || {};
        const diffusion = isDiffusion(model);
        const isOcr = normType(model && model.config_model_type).includes('ocr');
        return {
            model_alias: s.model_alias || '',
            model_type_override: s.model_type_override || '',
            // MT-1: EmbeddingGemma-2 audio input (classic modal's own gate:
            // entry.embedding_audio_supported — server computes it from
            // config_model_type == 'embedding_gemma2', routes.py:2228)
            embedding_audio_enabled: s.embedding_audio_enabled === true,
            embedding_audio_max_seconds: s.embedding_audio_max_seconds ?? null,
            max_context_window: s.max_context_window || null,
            max_tokens: s.max_tokens || null,
            temperature: isOcr ? 0.0 : (s.temperature ?? null),
            top_p: s.top_p ?? null,
            top_k: s.top_k ?? null,
            repetition_penalty: s.repetition_penalty ?? null,
            min_p: s.min_p ?? null,
            presence_penalty: s.presence_penalty ?? null,
            force_sampling: s.force_sampling || false,
            enable_thinking: s.enable_thinking ?? null,
            thinking_default: model && model.thinking_default != null ? model.thinking_default : null,
            // uplift legacy field (classic modal has no widget; keep round-trip)
            preserve_thinking: s.preserve_thinking ?? null,
            qwen4_ple_ssd_offload: (model && model.qwen4_ple_ssd_offload_forced === true) || s.qwen4_ple_ssd_offload === true,
            qwen4_ple_ssd_offload_supported: !!(model && model.qwen4_ple_ssd_offload_supported === true),
            qwen4_ple_ssd_offload_forced: !!(model && model.qwen4_ple_ssd_offload_forced === true),
            deepseek_v41_ced_prefill_enabled: s.deepseek_v41_ced_prefill_enabled === true,
            deepseek_v41_ced_prefill_supported: normType(model && model.config_model_type) === 'deepseek_v41',
            // SYNC-1 (upstream 3c39990): qwen4_gdn_decode_wide_proj moved from
            // GlobalSettingsRequest to ModelSettingsRequest. Classic computes
            // the row gate from the /models row's config_model_type
            // (dashboard.js:2152 — 'qwen4_exp', server clamp routes.py:2833);
            // mirror it, so on a server that never sends the field the row
            // simply stays hidden and the key is never PUT (old keg forbids it).
            qwen4_gdn_decode_wide_proj: s.qwen4_gdn_decode_wide_proj === true,
            qwen4_gdn_decode_wide_proj_supported:
                normType(model && model.config_model_type) === 'qwen4_exp',
            deepseek_v41_engram_ssd_offload: (model && model.deepseek_v41_engram_ssd_offload_forced === true) || s.deepseek_v41_engram_ssd_offload === true,
            deepseek_v41_engram_ssd_offload_requested: s.deepseek_v41_engram_ssd_offload === true,
            deepseek_v41_engram_ssd_offload_supported: !!(model && model.deepseek_v41_engram_ssd_offload_supported === true),
            deepseek_v41_engram_ssd_offload_forced: !!(model && model.deepseek_v41_engram_ssd_offload_forced === true),
            enableThinkingBudget: !!s.thinking_budget_tokens,
            thinking_budget_tokens: s.thinking_budget_tokens || null,
            // SYNC-1 (upstream d59d797 #4855 + 95e0fd6 #4819): classic's
            // enableGpuPowerLimit is a UI helper — on = stored cap > 0
            // (dashboard.js:2174). The supported verdicts ride the model
            // DTO: gpu_power_limit_supported via _model_options (machine
            // capability), activation_fp16_supported per checkpoint + M1/M2
            // GPU (routes.py:2437). Absent on an older keg = both false =
            // rows hidden, keys omitted client-side AND by adaptToServer.
            enableGpuPowerLimit: !!s.gpu_power_limit_w,
            gpu_power_limit_w: s.gpu_power_limit_w || null,
            gpu_power_limit_supported: !!(model && model.gpu_power_limit_supported === true),
            activation_fp16_enabled: s.activation_fp16_enabled === true,
            activation_fp16_supported: !!(model && model.activation_fp16_supported === true),
            guided_grammar_enabled: s.guided_grammar_enabled || false,
            guided_grammar: s.guided_grammar || '',
            enableToolResultLimit: !!s.max_tool_result_tokens,
            max_tool_result_tokens: s.max_tool_result_tokens || null,
            reasoning_parser: s.reasoning_parser || '',
            cache_reasoning_output: s.cache_reasoning_output ?? null,
            ttl_seconds: s.ttl_seconds ?? null,
            enableIndexCache: !!s.index_cache_freq,
            index_cache_freq: s.index_cache_freq || null,
            // UP-18 (2): classic zeroes the KV-compression family on a
            // PAROQUANT checkpoint at load (dashboard.js:2172-2177) — the
            // packed format cannot carry a quantized KV cache.
            turboquant_kv_enabled: !diffusion && !(model && model.is_paroquant === true)
                && (s.turboquant_kv_enabled || false),
            // SYNC-1 (upstream 7ffa8d4 #4659): KV compression format;
            // server default when the field is absent is 'turboquant'.
            turboquant_kv_scheme: diffusion || (model && model.is_paroquant === true)
                ? 'turboquant' : (s.turboquant_kv_scheme || 'turboquant'),
            turboquant_kv_bits: diffusion || (model && model.is_paroquant === true)
                ? 4 : (s.turboquant_kv_bits || 4),
            moe_expert_offload_enabled: !diffusion && !!(model && model.moe_expert_offload_supported === true) && !!s.moe_expert_offload_enabled,
            moe_expert_offload_resident_fraction: s.moe_expert_offload_resident_fraction ?? 0.25,
            qwen35_oq_a8_enabled: s.qwen35_oq_a8_enabled || false,
            qwen35_oq_a8_min_tokens: s.qwen35_oq_a8_min_tokens ?? 128,
            qwen35_ane_prefill_enabled: s.qwen35_ane_prefill_enabled || false,
            qwen35_ane_prefill_sequence_length: s.qwen35_ane_prefill_sequence_length || 2048,
            qwen35_ane_prefill_tail_padding_min_tokens: s.qwen35_ane_prefill_tail_padding_min_tokens ?? 0,
            qwen35_ane_prefill_fraction: s.qwen35_ane_prefill_fraction ?? (model && model.ane_prefill_default_fraction) ?? 0.53,
            qwen35_ane_prefill_fused_down: s.qwen35_ane_prefill_fused_down || false,
            qwen35_ane_prefill_max_layers: s.qwen35_ane_prefill_max_layers || 64,
            qwen35_ane_prefill_dual_ane: s.qwen35_ane_prefill_dual_ane !== false,
            qwen35_ane_prefill_gdn: s.qwen35_ane_prefill_gdn !== false,
            qwen35_ane_prefill_gdn_fraction: s.qwen35_ane_prefill_gdn_fraction ?? 0.5,
            qwen35_ane_prefill_gdn_max_layers: s.qwen35_ane_prefill_gdn_max_layers ?? 48,
            qwen35_ane_prefill_shared_fraction: s.qwen35_ane_prefill_shared_fraction ?? 1,
            qwen35_ane_prefill_cpu_enabled: s.qwen35_ane_prefill_cpu_enabled || false,
            qwen35_ane_prefill_cpu_fraction: s.qwen35_ane_prefill_cpu_fraction ?? 0.135,
            qwen35_ane_prefill_cpu_down_fraction: s.qwen35_ane_prefill_cpu_down_fraction ?? 0,
            qwen35_ane_prefill_cpu_gdn_fraction: s.qwen35_ane_prefill_cpu_gdn_fraction ?? 0,
            qwen35_ane_prefill_cpu_threads: s.qwen35_ane_prefill_cpu_threads ?? 8,
            qwen35_ane_prefill_cpu_shared_resource: s.qwen35_ane_prefill_cpu_shared_resource !== false,
            specprefill_enabled: s.specprefill_enabled || false,
            specprefill_draft_model: s.specprefill_draft_model || '',
            specprefill_keep_pct: s.specprefill_keep_pct ? String(s.specprefill_keep_pct) : '0.2',
            specprefill_threshold: s.specprefill_threshold || null,
            external_engine: s.external_engine || '',
            dflash_enabled: s.dflash_enabled || false,
            dflash_draft_model: s.dflash_draft_model || '',
            dflash_draft_quant_enabled: s.dflash_draft_quant_enabled || false,
            dflash_draft_quant_weight_bits: s.dflash_draft_quant_weight_bits || 4,
            dflash_draft_quant_group_size: s.dflash_draft_quant_group_size || 64,
            dflash_draft_window_size: s.dflash_draft_window_size ?? null,
            dflash_block_size: s.dflash_block_size ?? null,
            // SYNC-1 (upstream tip model_settings.py:429/495): the enum is
            // adaptive|dflash|off — a legacy stored 'ddtree' normalizes to
            // 'adaptive' exactly like the server's own validator does.
            dflash_verify_mode: s.dflash_verify_mode === 'ddtree'
                ? 'adaptive' : (s.dflash_verify_mode || 'adaptive'),
            dflash_compatible: !(model && model.dflash_compatible === false),
            dflash_compatibility_reason: (model && model.dflash_compatibility_reason) || '',
            mtp_enabled: s.mtp_enabled || false,
            mtp_compatible: !!(model && model.mtp_compatible === true),
            mtp_compatibility_reason: (model && model.mtp_compatibility_reason) || '',
            is_paroquant: !!(model && model.is_paroquant === true),
            paroquant_reason: (model && model.paroquant_reason) || '',
            // UP-18 (1): server verdict — deepseek_v41/glm5_next/qwen4_exp
            // run MTP heads alongside expert offload (model_settings.py
            // MOE_OFFLOAD_MTP_MODEL_TYPES); classic consumes this flag
            // (dashboard.js:2182) instead of the old blanket block.
            moe_offload_allows_mtp: !!(model && model.moe_offload_allows_mtp === true),
            vlm_mtp_enabled: s.vlm_mtp_enabled || false,
            vlm_mtp_draft_model: s.vlm_mtp_draft_model || '',
            vlm_mtp_draft_block_size: s.vlm_mtp_draft_block_size ?? null,
            // upstream 62171bdf: the fixed-depth select is gone; depth is a
            // single adaptive-max ceiling. 3 = default adaptive.
            // Servers older than 62171bdf store the same value under the
            // legacy name mtp_num_draft_tokens (identical semantics — both
            // docstrings describe one adaptive draft-depth ceiling).
            mtp_adaptive_max_depth: mtpDepthOf(s),
            mtp_fixed_depth: s.mtp_fixed_depth ? String(s.mtp_fixed_depth) : '',
            trust_remote_code: s.trust_remote_code || false,
            ctKwargEntries: buildCtKwargEntries(s.chat_template_kwargs, s.forced_ct_kwargs, diffusion),
            is_diffusion_model: diffusion,
        };
    }

    /* ---- client-side validation (mirrors validateQwenOqA8Settings /
       validateQwenAneSettings + server __post_init__ conflicts) ---- */
    const num = v => Number(v);
    function validate(ms, model) {
        const errors = [];
        // MT-1: every check below validates a type-gated (LLM/VLM) family.
        // A non-LLM model's stale hidden values must not block an unrelated
        // save (e.g. TTL on an embedding model); buildPayload strips the
        // family from the PUT anyway.
        if (model && !llmLike(Object.assign({}, model,
                { model_type_override: ms.model_type_override })))
            return errors;
        // sweep 1.3a: sampling ranges (classic's input bounds; server has
        // none, so an unvalidated UI happily stores temperature 99)
        const rng = (label, v, lo, hi) => {
            if (v === null || v === undefined || v === '') return;
            const n = num(v);
            if (!Number.isFinite(n) || n < lo || n > hi)
                errors.push(label + ' must be between ' + lo + ' and ' + hi + '.');
        };
        rng('Temperature', ms.temperature, 0, 2);
        rng('Top P', ms.top_p, 0, 1);
        rng('Min P', ms.min_p, 0, 1);
        rng('Repetition Penalty', ms.repetition_penalty, 0.5, 2);
        rng('Presence Penalty', ms.presence_penalty, -2, 2);
        if (ms.top_k !== null && ms.top_k !== undefined && ms.top_k !== '') {
            const n = num(ms.top_k);
            if (!Number.isInteger(n) || n < 0)
                errors.push('Top K must be an integer of at least 0.');
        }
        if (ms.qwen35_oq_a8_enabled) {
            if (ms.qwen35_ane_prefill_enabled)
                errors.push('ANE prefill and INT8 activation prefill cannot both be enabled; they accelerate the same projections. Turn one off.');
            const mt = num(ms.qwen35_oq_a8_min_tokens);
            if (!Number.isInteger(mt) || mt < 1) errors.push('oQ A8 minimum prompt tokens must be a positive integer.');
        }
        if (ms.mtp_enabled && ms.dflash_enabled)
            errors.push('Lightning MTP and DFlash cannot both be enabled; choose one speculative-decoding path.');
        // MTP-HEAD (user 2026-10-21): the editor locks the toggle when the
        // DTO says the model has no MTP head; this mirror stops a stale/
        // hand-crafted state from ever PUTting it. Only the EXPLICIT false
        // verdict errors (absent field on an older DTO is not a refusal);
        // synthetic entries (global templates, unknown models) carry no
        // server verdict — exempt.
        if (ms.mtp_enabled && model && !model._template && !model._missing
                && model.mtp_compatible === false)
            errors.push(model.mtp_compatibility_reason
                || 'Lightning MTP is not compatible with this model — it has no built-in MTP head.');
        if (ms.vlm_mtp_enabled) {
            for (const [label, on] of [['DFlash', ms.dflash_enabled], ['SpecPrefill', ms.specprefill_enabled],
                                       ['Lightning MTP', ms.mtp_enabled], ['KV cache compression', ms.turboquant_kv_enabled]])
                if (on) errors.push(`VLM MTP and ${label} cannot both be enabled; choose one speculative path per model.`);
            if (ms.guided_grammar_enabled || ms.repetition_penalty != null || ms.presence_penalty != null)
                errors.push('VLM MTP cannot be combined with guided grammar or repetition/presence penalties (per-request logits processors).');
        }
        if (ms.moe_expert_offload_enabled && (ms.vlm_mtp_enabled || ms.dflash_enabled))
            errors.push('MoE expert offload cannot be combined with VLM MTP or DFlash; disable speculative decoding first.');
        // UP-18 (1): Lightning MTP rides MoE offload on models the server
        // vouches for (moe_offload_allows_mtp — deepseek_v41/glm5_next/
        // qwen4_exp). The old blanket block falsely denied those.
        if (ms.moe_expert_offload_enabled && ms.mtp_enabled && !ms.moe_offload_allows_mtp)
            errors.push('MoE expert offload cannot be combined with Lightning MTP on this model; disable one of them.');
        // SYNC-1 (upstream 95e0fd6 #4819): offload slots live outside the
        // module tree, so the recast leaves them bf16 — the server refuses
        // the pair outright (model_settings.py validate_moe_expert_offload).
        if (ms.moe_expert_offload_enabled && ms.activation_fp16_enabled)
            errors.push('MoE expert offload cannot be combined with the float16 activation recast; disable one of them first.');
        // SYNC-1 (upstream d59d797 #4855): classic's save-time range check
        // (validateGpuPowerLimit) — the server clamps <=0 to None, and the
        // 2..1000 W ladder is the UI contract.
        if (ms.enableGpuPowerLimit) {
            const gw = num(ms.gpu_power_limit_w);
            if (!Number.isInteger(gw) || gw < 2 || gw > 1000)
                errors.push('GPU power limit must be a whole number from 2 to 1000 W.');
        }
        // UP-18 (2): a PAROQUANT checkpoint cannot carry KV compression,
        // VLM MTP, SpecPrefill or Index Cache (classic disables the rows).
        if (ms.is_paroquant && (ms.turboquant_kv_enabled || ms.vlm_mtp_enabled
                || ms.specprefill_enabled || ms.enableIndexCache))
            errors.push(ms.paroquant_reason
                || 'Paroquant checkpoint: KV compression, VLM MTP, SpecPrefill and Index Cache are unavailable.');
        // UP-18 (7): classic keeps resident experts in 5..95 % (the API
        // accepts fractions outside; the UI ladder does not ship them)
        const frac = num(ms.moe_expert_offload_resident_fraction);
        if (!(frac >= 0.05 && frac <= 0.95))
            errors.push('MoE resident experts must be between 5% and 95%.');
        // UP-18 (4): classic's index-cache frequency ladder (min 2, max 16)
        if (ms.enableIndexCache) {
            const f = num(ms.index_cache_freq);
            if (!Number.isInteger(f) || f < 2 || f > 16)
                errors.push('Index Cache frequency must be an integer between 2 and 16.');
        }
        if (ms.qwen35_ane_prefill_enabled) {
            const seq = num(ms.qwen35_ane_prefill_sequence_length);
            if (!Number.isInteger(seq) || seq < 1024) errors.push('ANE prompt block must be an integer of at least 1024.');
            else if (seq % 64 !== 0) errors.push('ANE prompt block must be a multiple of 64.');
            const tp = num(ms.qwen35_ane_prefill_tail_padding_min_tokens);
            if (!Number.isInteger(tp) || tp < 0) errors.push('ANE tail padding threshold must be an integer of at least 0.');
            if (ms.qwen35_ane_prefill_gdn) {
                const gf = num(ms.qwen35_ane_prefill_gdn_fraction);
                if (!(gf > 0 && gf <= 1)) errors.push('ANE GDN fraction must be in (0, 1].');
            }
        }
        if (ms.specprefill_enabled) {
            const keep = num(ms.specprefill_keep_pct);
            if (!(keep >= 0.1 && keep <= 0.5)) errors.push('SpecPrefill keep percentage must be between 0.1 and 0.5.');
        }
        return errors;
    }

    /* ---- PUT payload (mirrors saveModelSettings exactly, including the
       diffusion block and the 0/null clear conventions) ---- */
    function buildPayload(ms, model) {
        const diffusion = !!ms.is_diffusion_model;
        const chatTemplateKwargs = {};
        const forcedCtKwargs = [];
        for (const e of ms.ctKwargEntries || []) {
            if (e.type === 'enable_thinking') {
                if (diffusion) continue;
                chatTemplateKwargs.enable_thinking = e.value === 'true';
                if (e.force) forcedCtKwargs.push('enable_thinking');
            } else if (e.type === 'reasoning_effort') {
                if (diffusion) continue;
                const raw = e.custom ? e.customValue : e.value;
                const effort = coerceKwargValue(raw);
                if (String(effort).trim() !== '') {
                    chatTemplateKwargs.reasoning_effort = effort;
                    if (e.force) forcedCtKwargs.push('reasoning_effort');
                }
            } else if (e.type === 'custom' && e.key && e.key.trim()) {
                const key = e.key.trim();
                if (diffusion && DIFFUSION_UNSUPPORTED_CT_KWARGS.has(key)) continue;
                chatTemplateKwargs[key] = coerceKwargValue(e.value);
                if (e.force) forcedCtKwargs.push(key);
            }
        }
        const fin = v => Number.isFinite(v) ? v : null;
        const payload = {
            model_alias: (ms.model_alias && ms.model_alias.trim()) || null,
            model_type_override: ms.model_type_override || null,
            max_context_window: ms.max_context_window || null,
            max_tokens: ms.max_tokens || null,
            temperature: fin(ms.temperature),
            top_p: fin(ms.top_p),
            top_k: fin(ms.top_k),
            repetition_penalty: fin(ms.repetition_penalty),
            min_p: fin(ms.min_p),
            presence_penalty: fin(ms.presence_penalty),
            force_sampling: !!ms.force_sampling,
            reasoning_parser: ms.reasoning_parser || null,
            ttl_seconds: ms.ttl_seconds || null,
            index_cache_freq: ms.enableIndexCache ? (ms.index_cache_freq || 4) : 0,
            enable_thinking: model && model.thinking_forced ? null : ms.enable_thinking,
            qwen4_ple_ssd_offload: !!ms.qwen4_ple_ssd_offload,
            deepseek_v41_ced_prefill_enabled: !!ms.deepseek_v41_ced_prefill_enabled,
            // SYNC-1 (upstream 3c39990 + tip routes.py:2833): model-level key,
            // sent ONLY when the row is supported. The running keg may still
            // be pre-3c39990, whose ModelSettingsRequest has no such field and
            // extra='forbid' — an unknown key 422s the whole save, so the
            // safe shape is omission (adaptToServerPayload double-gates it).
            ...(ms.qwen4_gdn_decode_wide_proj_supported
                ? { qwen4_gdn_decode_wide_proj: !!ms.qwen4_gdn_decode_wide_proj }
                : {}),
            deepseek_v41_engram_ssd_offload: ms.deepseek_v41_engram_ssd_offload_forced
                ? !!ms.deepseek_v41_engram_ssd_offload_requested
                : !!ms.deepseek_v41_engram_ssd_offload,
            thinking_budget_enabled: !!ms.enableThinkingBudget,
            thinking_budget_tokens: ms.enableThinkingBudget ? (ms.thinking_budget_tokens || null) : 0,
            // SYNC-1: classic sends both keys unconditionally
            // (dashboard.js:3241/3250); the server folds <=0/None to no-cap.
            gpu_power_limit_w: ms.enableGpuPowerLimit ? (Number(ms.gpu_power_limit_w) || 0) : 0,
            activation_fp16_enabled: !!ms.activation_fp16_enabled,
            cache_reasoning_output: ms.cache_reasoning_output ?? null,
            guided_grammar_enabled: !!ms.guided_grammar_enabled,
            guided_grammar: ms.guided_grammar_enabled ? (ms.guided_grammar || null) : null,
            max_tool_result_tokens: ms.enableToolResultLimit ? (ms.max_tool_result_tokens || null) : 0,
            chat_template_kwargs: Object.keys(chatTemplateKwargs).length > 0 ? chatTemplateKwargs : null,
            forced_ct_kwargs: forcedCtKwargs.length > 0 ? forcedCtKwargs : null,
            turboquant_kv_enabled: !!ms.turboquant_kv_enabled,
            turboquant_kv_scheme: ms.turboquant_kv_scheme || 'turboquant',
            turboquant_kv_bits: ms.turboquant_kv_enabled ? (parseFloat(ms.turboquant_kv_bits) || 4) : 4,
            moe_expert_offload_enabled: !diffusion && !!(model && model.moe_expert_offload_supported === true) && !!ms.moe_expert_offload_enabled,
            moe_expert_offload_resident_fraction: ms.moe_expert_offload_resident_fraction ?? 0.25,
            qwen35_oq_a8_enabled: !!ms.qwen35_oq_a8_enabled,
            qwen35_oq_a8_min_tokens: Number(ms.qwen35_oq_a8_min_tokens) || 128,
            qwen35_ane_prefill_enabled: !!ms.qwen35_ane_prefill_enabled,
            qwen35_ane_prefill_sequence_length: Number(ms.qwen35_ane_prefill_sequence_length) || 2048,
            qwen35_ane_prefill_tail_padding_min_tokens: Number.isFinite(Number(ms.qwen35_ane_prefill_tail_padding_min_tokens))
                ? Number(ms.qwen35_ane_prefill_tail_padding_min_tokens) : 0,
            qwen35_ane_prefill_fraction: Number(ms.qwen35_ane_prefill_fraction),
            qwen35_ane_prefill_shared_fraction: Number(ms.qwen35_ane_prefill_shared_fraction),
            qwen35_ane_prefill_fused_down: !!ms.qwen35_ane_prefill_fused_down,
            qwen35_ane_prefill_max_layers: Number(ms.qwen35_ane_prefill_max_layers) || 64,
            qwen35_ane_prefill_dual_ane: ms.qwen35_ane_prefill_dual_ane !== false,
            qwen35_ane_prefill_gdn: ms.qwen35_ane_prefill_gdn !== false,
            qwen35_ane_prefill_gdn_fraction: Number(ms.qwen35_ane_prefill_gdn_fraction) || 0.5,
            qwen35_ane_prefill_gdn_max_layers: Number.isFinite(Number(ms.qwen35_ane_prefill_gdn_max_layers))
                ? Number(ms.qwen35_ane_prefill_gdn_max_layers) : 48,
            qwen35_ane_prefill_cpu_enabled: !!ms.qwen35_ane_prefill_cpu_enabled,
            qwen35_ane_prefill_cpu_fraction: Number(ms.qwen35_ane_prefill_cpu_fraction),
            qwen35_ane_prefill_cpu_down_fraction: Number.isFinite(Number(ms.qwen35_ane_prefill_cpu_down_fraction))
                ? Number(ms.qwen35_ane_prefill_cpu_down_fraction) : 0,
            qwen35_ane_prefill_cpu_gdn_fraction: Number.isFinite(Number(ms.qwen35_ane_prefill_cpu_gdn_fraction))
                ? Number(ms.qwen35_ane_prefill_cpu_gdn_fraction) : 0,
            qwen35_ane_prefill_cpu_threads: Number.isFinite(Number(ms.qwen35_ane_prefill_cpu_threads))
                ? Number(ms.qwen35_ane_prefill_cpu_threads) : 8,
            qwen35_ane_prefill_cpu_shared_resource: ms.qwen35_ane_prefill_cpu_shared_resource !== false,
            specprefill_enabled: !!ms.specprefill_enabled,
            specprefill_draft_model: ms.specprefill_draft_model || null,
            specprefill_keep_pct: ms.specprefill_enabled ? (parseFloat(ms.specprefill_keep_pct) || 0.2) : null,
            specprefill_threshold: ms.specprefill_enabled ? (ms.specprefill_threshold || null) : null,
            external_engine: ms.external_engine || null,
            // SYNC-1 (upstream 7a4ea39): the cache/context knobs (activation
            // bits, max_ctx, in-memory cache + entries + bytes, ssd cache +
            // bytes, sink size) are deleted from ModelSettingsRequest — they
            // must never appear in the PUT body (extra='forbid' 422s).
            dflash_enabled: !!ms.dflash_enabled,
            dflash_draft_model: ms.dflash_draft_model || null,
            dflash_draft_quant_enabled: !!ms.dflash_enabled && !!ms.dflash_draft_quant_enabled,
            dflash_draft_quant_weight_bits: ms.dflash_enabled && ms.dflash_draft_quant_enabled
                ? parseInt(ms.dflash_draft_quant_weight_bits) : null,
            dflash_draft_quant_group_size: ms.dflash_enabled && ms.dflash_draft_quant_enabled
                ? parseInt(ms.dflash_draft_quant_group_size) : null,
            dflash_draft_window_size: ms.dflash_enabled && ms.dflash_draft_window_size
                ? parseInt(ms.dflash_draft_window_size) : null,
            dflash_block_size: ms.dflash_enabled && ms.dflash_block_size
                ? parseInt(ms.dflash_block_size) : null,
            dflash_verify_mode: ms.dflash_enabled
                ? (ms.dflash_verify_mode === 'ddtree' ? 'adaptive'
                   : (ms.dflash_verify_mode || 'adaptive')) : null,
            mtp_enabled: !!ms.mtp_enabled,
            // upstream 62171bdf: depth rides mtp_adaptive_max_depth only;
            // the legacy fixed depth is cleared on every save.
            mtp_adaptive_max_depth: ms.mtp_enabled
                ? Math.max(1, parseInt(ms.mtp_adaptive_max_depth || '3', 10) || 3) : null,
            mtp_fixed_depth: null,
            vlm_mtp_enabled: !!ms.vlm_mtp_enabled,
            vlm_mtp_draft_model: ms.vlm_mtp_enabled ? (ms.vlm_mtp_draft_model || null) : null,
            vlm_mtp_draft_block_size: ms.vlm_mtp_enabled && ms.vlm_mtp_draft_block_size
                ? parseInt(ms.vlm_mtp_draft_block_size) : null,
            trust_remote_code: !!ms.trust_remote_code,
        };
        // MT-1: classic sends the embedding-audio pair ONLY for models the
        // server flags embedding_audio_supported (PUT writes any key it
        // receives, so an unconditional pair would pollute other engines)
        if (model && model.embedding_audio_supported) {
            const sec = Number(ms.embedding_audio_max_seconds);
            payload.embedding_audio_enabled = !!ms.embedding_audio_enabled;
            payload.embedding_audio_max_seconds = sec > 0 ? sec : null;
        }
        // MT-1: a non-LLM effective type must not carry LLM-family values.
        // Reached via a model_type_override flip: the editor hid those rows,
        // but buildPayload would otherwise write the stale LLM values back
        // (PUTs merge — a flipped-away family must never be re-applied).
        // llmLike prefers model_type_override, so pass the EDITOR state in.
        const effective = model
            ? Object.assign({}, model, { model_type_override: ms.model_type_override })
            : { model_type_override: ms.model_type_override };
        if (!llmLike(effective)) {
            for (const k of Object.keys(payload))
                if (TYPE_ONLY_KEYS.has(k)) delete payload[k];
        }
        if (diffusion) {
            Object.assign(payload, {
                top_p: null, top_k: null, repetition_penalty: null, min_p: null,
                presence_penalty: null, force_sampling: false, reasoning_parser: null,
                index_cache_freq: 0, enable_thinking: null,
                thinking_budget_enabled: false, thinking_budget_tokens: 0,
                cache_reasoning_output: null,
                guided_grammar_enabled: false, guided_grammar: null,
                max_tool_result_tokens: 0, turboquant_kv_enabled: false,
                turboquant_kv_scheme: 'turboquant',
                turboquant_kv_bits: 4, qwen35_ane_prefill_enabled: false,
                qwen35_ane_prefill_sequence_length: 2048,
                qwen35_ane_prefill_tail_padding_min_tokens: 0,
                qwen35_ane_prefill_fraction: 0.53, qwen35_ane_prefill_max_layers: 64,
                qwen35_ane_prefill_dual_ane: true, qwen35_ane_prefill_gdn: true,
                qwen35_ane_prefill_gdn_fraction: 0.5,
                qwen35_ane_prefill_cpu_enabled: false, qwen35_ane_prefill_cpu_fraction: 0.135,
                qwen35_ane_prefill_cpu_down_fraction: 0, qwen35_ane_prefill_cpu_gdn_fraction: 0,
                qwen35_ane_prefill_cpu_threads: 8, qwen35_ane_prefill_cpu_shared_resource: true,
                specprefill_enabled: false, specprefill_draft_model: null,
                specprefill_keep_pct: null, specprefill_threshold: null,
                external_engine: '',
                dflash_enabled: false, mtp_enabled: false,
                mtp_adaptive_max_depth: null, mtp_fixed_depth: null,
                vlm_mtp_enabled: false, vlm_mtp_draft_model: null,
                moe_expert_offload_enabled: false,
                qwen35_oq_a8_enabled: false,
            });
        }
        return payload;
    }

    /* ---- runtime-signature replica (engine_pool._engine_runtime_signature)
       A setting change reloads a loaded engine exactly when the signature of
       the effective settings differs (or model_type_override flips). Used by
       the editor for the RELOAD field badges and the RUNTIME DIVERGENCE
       warning between base and profiles. Field presence matters here, not
       value dirtiness: dependent fields count only while their feature is on. ---- */
    function runtimeSignature(payload) {
        const d = payload || {};
        const has = v => v !== null && v !== undefined && v !== '';
        const sig = {};
        const add = (k, v) => { sig[k] = JSON.stringify(v === undefined ? null : v); };
        const freq = parseInt(d.index_cache_freq, 10);
        add('trust_remote_code', !!d.trust_remote_code);
        add('index_cache_freq', Number.isFinite(freq) && freq >= 2 ? freq : null);
        // MT-1: embedding audio tower — engine_pool only counts the length
        // knob while the tower is loaded (engine_pool.py:1058-1061)
        const audioOn = !!d.embedding_audio_enabled;
        add('embedding_audio_enabled', audioOn);
        if (audioOn) add('embedding_audio_max_seconds', d.embedding_audio_max_seconds ?? null);
        const mtpOn = !!d.mtp_enabled;
        add('mtp_enabled', mtpOn);
        if (mtpOn) {
            add('mtp_adaptive_max_depth', d.mtp_adaptive_max_depth ?? null);
            add('mtp_fixed_depth', d.mtp_fixed_depth ?? null);
        }
        const tqOn = !!d.turboquant_kv_enabled;
        add('turboquant_kv_enabled', tqOn);
        if (tqOn) {
            // SYNC-1 (upstream 7ffa8d4 #4659): mirror
            // validate_kv_compression_settings — affine4/affine8 pin the
            // bit ladder to 4/8; a mismatched pair 400s at tip. Clamp here
            // so a stale editor state can never send one.
            const kvScheme = d.turboquant_kv_scheme || 'turboquant';
            const kvPin = kvScheme === 'affine4' ? 4 : kvScheme === 'affine8' ? 8 : null;
            add('turboquant_kv_scheme', kvScheme);
            add('turboquant_kv_bits', kvPin !== null ? kvPin : (d.turboquant_kv_bits ?? 4));
        }
        const oqOn = !!d.qwen35_oq_a8_enabled;
        add('qwen35_oq_a8_enabled', oqOn);
        if (oqOn) add('qwen35_oq_a8_min_tokens', d.qwen35_oq_a8_min_tokens ?? 128);
        const aneOn = !!d.qwen35_ane_prefill_enabled;
        add('qwen35_ane_prefill_enabled', aneOn);
        if (aneOn) {
            add('qwen35_ane_prefill_sequence_length', d.qwen35_ane_prefill_sequence_length ?? 2048);
            add('qwen35_ane_prefill_fraction', d.qwen35_ane_prefill_fraction ?? 0.53);
            add('qwen35_ane_prefill_tail_padding_min_tokens', d.qwen35_ane_prefill_tail_padding_min_tokens ?? 0);
            add('qwen35_ane_prefill_fused_down', !!d.qwen35_ane_prefill_fused_down);
            add('qwen35_ane_prefill_max_layers', d.qwen35_ane_prefill_max_layers ?? 64);
            add('qwen35_ane_prefill_dual_ane', d.qwen35_ane_prefill_dual_ane !== false);
            add('qwen35_ane_prefill_gdn', d.qwen35_ane_prefill_gdn !== false);
            if (d.qwen35_ane_prefill_gdn !== false) {
                add('qwen35_ane_prefill_gdn_fraction', d.qwen35_ane_prefill_gdn_fraction ?? 0.5);
                add('qwen35_ane_prefill_gdn_max_layers', d.qwen35_ane_prefill_gdn_max_layers ?? 48);
            }
            const cpuOn = !!d.qwen35_ane_prefill_cpu_enabled;
            add('qwen35_ane_prefill_cpu_enabled', cpuOn);
            if (cpuOn) {
                add('qwen35_ane_prefill_cpu_fraction', d.qwen35_ane_prefill_cpu_fraction ?? 0.135);
                add('qwen35_ane_prefill_cpu_down_fraction', d.qwen35_ane_prefill_cpu_down_fraction ?? 0);
                add('qwen35_ane_prefill_cpu_gdn_fraction', d.qwen35_ane_prefill_cpu_gdn_fraction ?? 0);
                add('qwen35_ane_prefill_cpu_threads', d.qwen35_ane_prefill_cpu_threads ?? 8);
                add('qwen35_ane_prefill_cpu_shared_resource', d.qwen35_ane_prefill_cpu_shared_resource !== false);
            }
        }
        const moeOn = !!d.moe_expert_offload_enabled;
        add('moe_expert_offload_enabled', moeOn);
        if (moeOn) add('moe_expert_offload_resident_fraction', d.moe_expert_offload_resident_fraction ?? 0.25);
        // load-time offload/prefill variants (server derives status from the
        // entry too — forced values can only make these ON, approximation is
        // conservative for the divergence warning)
        add('qwen4_ple_ssd_offload', !!d.qwen4_ple_ssd_offload);
        // SYNC-1 (3c39990): model-level now — engine_pool:1118-1122 adds it to
        // the signature unconditionally next to the PLE offload.
        add('qwen4_gdn_decode_wide_proj', !!d.qwen4_gdn_decode_wide_proj);
        add('deepseek_v41_engram_ssd_offload', !!d.deepseek_v41_engram_ssd_offload);
        add('deepseek_v41_ced_prefill_enabled', !!d.deepseek_v41_ced_prefill_enabled);
        const spOn = !!d.specprefill_enabled && has(d.specprefill_draft_model);
        add('specprefill_enabled', spOn);
        if (spOn) {
            add('specprefill_draft_model', d.specprefill_draft_model);
            add('specprefill_keep_pct', d.specprefill_keep_pct ?? 0.2);
            add('specprefill_threshold', d.specprefill_threshold ?? null);
        }
        // SYNC-1 2026-10-13: engine_pool._engine_runtime_signature adds
        // ('external_engine', value or None) UNCONDITIONALLY under its
        // security/load gates — mirror the same shape so runtimeDiff and
        // the deferred split agree with the server, key present or not.
        add('external_engine', d.external_engine || null);
        const dfOn = !!d.dflash_enabled && has(d.dflash_draft_model);
        add('dflash_enabled', dfOn);
        if (dfOn) {
            // SYNC-1: tip engine_pool._engine_runtime_signature (1243-1261) —
            // quant pair + window/block/verify; the cache knobs are gone.
            add('dflash_draft_model', d.dflash_draft_model);
            const dqOn = !!d.dflash_draft_quant_enabled;
            add('dflash_draft_quant_enabled', dqOn);
            if (dqOn) {
                add('dflash_draft_quant_weight_bits', d.dflash_draft_quant_weight_bits ?? 4);
                add('dflash_draft_quant_group_size', d.dflash_draft_quant_group_size ?? 64);
            }
            add('dflash_draft_window_size', d.dflash_draft_window_size ?? null);
            add('dflash_block_size', d.dflash_block_size ?? null);
            add('dflash_verify_mode', d.dflash_verify_mode ?? null);
        }
        const vlmOn = !!d.vlm_mtp_enabled && has(d.vlm_mtp_draft_model);
        add('vlm_mtp_enabled', vlmOn);
        if (vlmOn) {
            add('vlm_mtp_draft_model', d.vlm_mtp_draft_model);
            add('vlm_mtp_draft_block_size', d.vlm_mtp_draft_block_size ?? null);
        }
        return sig;
    }
    /* Keys that feed the runtime signature (drives the per-field RELOAD
       badge and the sparse-save split in the editor). */
    const RUNTIME_SETTING_KEYS = new Set([
        'trust_remote_code', 'index_cache_freq',
        // MT-1 parity: the embedding audio tower is engine_pool signature
        // material (engine_pool.py add('embedding_audio_enabled', …))
        'embedding_audio_enabled', 'embedding_audio_max_seconds',
        'mtp_enabled', 'mtp_adaptive_max_depth', 'mtp_fixed_depth',
        'turboquant_kv_enabled', 'turboquant_kv_scheme', 'turboquant_kv_bits',
        'qwen35_oq_a8_enabled', 'qwen35_oq_a8_min_tokens',
        'qwen35_ane_prefill_enabled', 'qwen35_ane_prefill_sequence_length',
        'qwen35_ane_prefill_tail_padding_min_tokens', 'qwen35_ane_prefill_fraction',
        'qwen35_ane_prefill_fused_down', 'qwen35_ane_prefill_max_layers',
        'qwen35_ane_prefill_dual_ane', 'qwen35_ane_prefill_gdn',
        'qwen35_ane_prefill_gdn_fraction', 'qwen35_ane_prefill_gdn_max_layers',
        'qwen35_ane_prefill_shared_fraction',
        'qwen35_ane_prefill_cpu_enabled', 'qwen35_ane_prefill_cpu_fraction',
        'qwen35_ane_prefill_cpu_down_fraction', 'qwen35_ane_prefill_cpu_gdn_fraction',
        'qwen35_ane_prefill_cpu_threads', 'qwen35_ane_prefill_cpu_shared_resource',
        'moe_expert_offload_enabled', 'moe_expert_offload_resident_fraction',
        'qwen4_ple_ssd_offload', 'deepseek_v41_engram_ssd_offload',
        'deepseek_v41_ced_prefill_enabled',
        // SYNC-1 (3c39990): model-level + engine_pool signature material → the
        // editor must badge it RELOAD, exactly like the PLE offload row.
        'qwen4_gdn_decode_wide_proj',
        'specprefill_enabled', 'specprefill_draft_model', 'specprefill_keep_pct',
        'specprefill_threshold',
        'external_engine',
        // SYNC-1 (7a4ea39): surviving dflash family only — the cache/context
        // knobs no longer exist server-side, so they cannot be runtime material.
        'dflash_enabled', 'dflash_draft_model', 'dflash_draft_quant_enabled',
        'dflash_draft_quant_weight_bits', 'dflash_draft_quant_group_size',
        'dflash_draft_window_size', 'dflash_block_size', 'dflash_verify_mode',
        'mtp_enabled', 'vlm_mtp_enabled', 'vlm_mtp_draft_model',
        'vlm_mtp_draft_block_size',
    ]);
    /* Diff two settings payloads (payload shape) through the signature:
       returns [{key, base, other}] of settings-signature entries that differ.
       DIV-2 (user 2026-10-09): gated dependent keys whose RAW display values
       are numerically identical ("qwen35_oq_a8_min_tokens 128 -> 128") never
       surface as their own row. buildPayload always writes a default for
       every field, but the signature only carries a dependent key while its
       master switch is ON — so a master flip (off -> on) made the signature
       pair `null` vs `"128"` while the RAW base value was 128 all along: a
       reload IS forced (the master row says it), the knob row was noise. */
    function runtimeDiff(basePayload, otherPayload) {
        const a = runtimeSignature(basePayload), b = runtimeSignature(otherPayload);
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        const out = [];
        for (const k of [...keys].sort()) {
            if (a[k] === b[k]) continue;
            const av = _sigRaw(basePayload, k), bv = _sigRaw(otherPayload, k);
            const dependent = !!sigMasterKey(k);
            if (dependent && _rawEq(av, bv)) continue;   // display-equal knob: master row carries it
            out.push({ key: k, base: av, other: bv });
        }
        return out;
    }
    function _rawEq(x, y) {
        if (x === y) return true;
        if (x === null || x === undefined || y === null || y === undefined
            || y === '' || x === '') return false;
        const nx = Number(x), ny = Number(y);
        return Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
    }
    /* The master switch that gates a dependent signature key ('' = none).
       Mirrors the if-gates in runtimeSignature. Only false-defaulted
       masters get mapped: `qwen35_ane_prefill_gdn` gates on `!== false`
       (effective default TRUE when absent), so its children keep their
       parent `qwen35_ane_prefill_enabled` as the mapping master — a knob
       is dead whenever the whole ANE prefill is off on both sides. */
    function sigMasterKey(k) {
        const EXPLICIT = {
            mtp_adaptive_max_depth: 'mtp_enabled', mtp_fixed_depth: 'mtp_enabled',
            embedding_audio_max_seconds: 'embedding_audio_enabled',
            turboquant_kv_bits: 'turboquant_kv_enabled',
            turboquant_kv_scheme: 'turboquant_kv_enabled',
            qwen35_oq_a8_min_tokens: 'qwen35_oq_a8_enabled',
            moe_expert_offload_resident_fraction: 'moe_expert_offload_enabled',
            specprefill_draft_model: 'specprefill_enabled',
            specprefill_keep_pct: 'specprefill_enabled',
            specprefill_threshold: 'specprefill_enabled',
            dflash_draft_model: 'dflash_enabled',
            dflash_draft_quant_enabled: 'dflash_enabled',
            dflash_draft_quant_weight_bits: 'dflash_enabled',
            dflash_draft_quant_group_size: 'dflash_enabled',
            dflash_draft_window_size: 'dflash_enabled',
            dflash_block_size: 'dflash_enabled',
            dflash_verify_mode: 'dflash_enabled',
            vlm_mtp_draft_model: 'vlm_mtp_enabled',
            vlm_mtp_draft_block_size: 'vlm_mtp_enabled',
        };
        if (EXPLICIT[k]) return EXPLICIT[k];
        if (k === 'qwen35_ane_prefill_enabled' || k === 'qwen35_ane_prefill_cpu_enabled')
            return '';                                     // the masters themselves
        if (k.indexOf('qwen35_ane_prefill_cpu_') === 0) return 'qwen35_ane_prefill_cpu_enabled';
        if (k.indexOf('qwen35_ane_prefill_') === 0) return 'qwen35_ane_prefill_enabled';
        return '';
    }
    function _sigRaw(d, key) {
        // map signature names back to a displayable raw value
        if (key === 'ane_prefill_backend') return d.ane_prefill_backend;
        return d[key];
    }

    /* ---- draft-model option pools (exact replica of dashboard.js) ---- */
    const DFLASH_DRAFTER_CONFIG_MODEL_TYPES = new Set(['muse_glimmer_assistant']);
    function draftModelSearchText(m) {
        return [m && m.id, m && m.name, m && m.model_path, m && m.source_repo_id,
                m && m.config_model_type].filter(Boolean).join(' ').toLowerCase();
    }
    function isDraftModelBaseCandidate(m, selectedId) {
        if (!m || m.virtual) return false;
        if (m.id === selectedId) return false;
        return m.model_type === 'llm' || m.model_type === 'vlm' || !m.model_type;
    }
    function isDflashDraftModel(m) {
        const configType = String(m && m.config_model_type || '').toLowerCase();
        if (DFLASH_DRAFTER_CONFIG_MODEL_TYPES.has(configType)) return true;
        return /(^|[-_/\s])dflash[0-9]*($|[-_/\s])/i.test(draftModelSearchText(m));
    }
    function isVlmMtpDraftModel(m) {
        const configType = String(m && m.config_model_type || '').toLowerCase();
        if (configType) return VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES.has(configType);
        return /assistant|(^|[-_/\s])mtp($|[-_/\s])/i.test(draftModelSearchText(m));
    }
    function isSpecPrefillDraftModel(m) {
        return !isDflashDraftModel(m) && !isVlmMtpDraftModel(m);
    }
    function draftCandidates(models, selectedId, filterFn) {
        const base = (models || []).filter(m => isDraftModelBaseCandidate(m, selectedId));
        const filtered = base.filter(filterFn);
        return filtered.length > 0 ? filtered : base;   // fallbackToBase default
    }
    const specprefillCandidates = (models, selectedId) =>
        draftCandidates(models, selectedId, isSpecPrefillDraftModel);
    const dflashCandidates = (models, selectedId) =>
        draftCandidates(models, selectedId, isDflashDraftModel);
    const vlmMtpDrafters = (models, selectedId) =>
        draftCandidates(models, selectedId, isVlmMtpDraftModel);

    /* ---- profile file emulation: model_profiles.json + model_settings.json
       and global_templates.json layout, matching what the real server writes
       (version+profiles{model_id:{name:{...}}} / version+models{id:{...}}). */
    function profileRecord(name, displayName, description, settings, sourceTemplate, exposeAsModel, apiName, now) {
        const ts = now || new Date().toISOString();
        return { name, display_name: displayName || name, api_name: apiName || null,
                 description: description || '', created_at: ts, updated_at: ts,
                 settings, source_template: sourceTemplate || null,
                 expose_as_model: !!exposeAsModel };
    }

    /* ---- server payload adaptation ----
       The editor models the CURRENT upstream schema (62171bdf renamed
       mtp_num_draft_tokens -> mtp_adaptive_max_depth + mtp_fixed_depth),
       but the RUNNING omlx may predate that rename and its PUT body model
       is extra='forbid' — an unknown key 422s the whole save. When the
       server does not know the new name, translate back to the legacy one
       (identical semantics: both are the adaptive draft-depth ceiling).
       fields = accepted ModelSettingsRequest property names, or null when
       the server schema is unknown (then send as modeled). */
    function adaptToServerPayload(payload, fields) {
        let out = payload;
        if (fields && !fields.has('mtp_adaptive_max_depth')) {
            out = Object.assign({}, out);
            if ('mtp_adaptive_max_depth' in out) {
                out.mtp_num_draft_tokens = out.mtp_adaptive_max_depth;
                delete out.mtp_adaptive_max_depth;
            }
            // fixed depth has no legacy equivalent — drop it (null anyway:
            // 62171bdf retired the fixed-depth select, buildPayload clears it)
            delete out.mtp_fixed_depth;
        }
        return dropPostTipKeys(out, fields);
    }
    /* SYNC-1 (upstream 3c39990): a key the editor models that only the NEW
       ModelSettingsRequest accepts. The running keg may predate it and its
       body model is extra='forbid' — the mere key 422s the save. When the
       live schema is known and lacks it, omit (omission = "keep"). The
       payload shape AND the profile-override shape both pass through here. */
    const POST_TIP_MSR_KEYS = ['qwen4_gdn_decode_wide_proj'];
    function dropPostTipKeys(obj, fields) {
        if (!fields) return obj;
        let out = obj;
        for (const k of POST_TIP_MSR_KEYS) {
            if ((k in out) && !fields.has(k)) {
                if (out === obj) out = Object.assign({}, out);
                delete out[k];
            }
        }
        return out;
    }
    // The same rename seen through the EDITOR STATE shape (profile
    // overrides hold select strings like '4', not payload ints). The old
    // server's ModelSettings.from_dict silently DROPS the unknown key —
    // without this translation a profile's MTP depth would never apply.
    function adaptToServerSettings(settings, fields) {
        if (!fields) return settings;
        if (fields.has('mtp_adaptive_max_depth'))
            return dropPostTipKeys(settings, fields);   // only the qwen4 gate
        const out = Object.assign({}, settings);
        if (out.mtp_adaptive_max_depth != null) {
            out.mtp_num_draft_tokens = Math.max(1,
                parseInt(out.mtp_adaptive_max_depth, 10) || 3);
        }
        delete out.mtp_adaptive_max_depth;
        delete out.mtp_fixed_depth;
        return dropPostTipKeys(out, fields);
    }

    /* REQ-DIV: request-time settings a profile snapshot can carry (classic's
       UNIVERSAL_PROFILE_FIELDS — the server merges exactly these per request;
       engine keys belong to runtimeDiff instead). A profile is a SNAPSHOT:
       it does NOT follow the base. Inheritance semantics decide the rows:
       - a key the profile does NOT store is truly inherited from the base —
         it can never diverge, whatever the base holds;
       - a key the profile DOES stores diverges when it differs from the
         base's EFFECTIVE value: the stored base value, else the
         server-reported fallback (effDefault: global sampling / native ctx /
         thinking_default); when even that cannot say (min_p,
         presence_penalty), claim nothing;
       - a gated knob whose master switch is off on BOTH sides does nothing
         anywhere — no row (DIV-1 rule, request edition);
       - numeric equality is display equality (0 vs 0.0 is not drift).
       basePayload is the modelspec payload of the base tab's CURRENT
       (queued) state, so the host previews divergence BEFORE the save that
       would make it real. profSettings is the profile's raw stored dict. */
    const REQUEST_DIFF_KEYS = [
        'max_context_window', 'max_tokens', 'temperature', 'top_p', 'top_k',
        'min_p', 'repetition_penalty', 'presence_penalty', 'force_sampling',
        'enable_thinking', 'cache_reasoning_output',
        'thinking_budget_enabled', 'thinking_budget_tokens',
        'reasoning_parser', 'guided_grammar_enabled', 'guided_grammar',
        'max_tool_result_tokens',
    ];
    const REQ_CHILD_MASTER = {
        thinking_budget_tokens: 'thinking_budget_enabled',
        guided_grammar: 'guided_grammar_enabled',
    };
    function _reqNullish(v) { return v === null || v === undefined || v === ''; }
    function _reqEq(a, b) {
        if (a === b) return true;
        if (typeof a === 'number' || typeof b === 'number') return _rawEq(a, b);
        if (typeof a === 'object' && typeof b === 'object')
            return _stable(a) === _stable(b);
        return false;
    }
    // JSON.stringify keeps insertion order — kwargs dicts written by
    // different code paths would compare unequal on key order alone
    function _stable(v) {
        if (v === null || v === undefined) return 'null';
        if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
        if (typeof v === 'object')
            return '{' + Object.keys(v).sort().map(k =>
                JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
        return JSON.stringify(v);
    }
    /* The value a settings key EFFECTIVELY holds: the stored value, else the
       server-reported fallback (effDefault) when model+gs are given. null =
       'cannot say' — callers must then claim nothing. */
    function _reqEff(v, k, model, gs) {
        if (!_reqNullish(v)) return v;
        if (!model && !gs) return null;
        const d = effDefault(k, model, gs);
        return d && d.value !== undefined && d.value !== null ? d.value : null;
    }
    function requestDiff(basePayload, profSettings, model, gs) {
        const prof = profSettings || {};
        const base = basePayload || {};
        const out = [];
        for (const k of REQUEST_DIFF_KEYS) {
            if (_reqNullish(prof[k])) continue;       // inherited: cannot diverge
            const eb = _reqEff(base[k], k, model, gs);
            if (eb === null) continue;                // base value unreportable
            if (_reqEq(eb, prof[k])) continue;
            const m = REQ_CHILD_MASTER[k];
            if (m) {
                const off = v => v === undefined || v === null || v === false || v === '' || v === 0;
                if (off(prof[m]) && off(base[m])) continue;   // dead knob both sides
            }
            out.push({ key: k, base: eb, other: prof[k] });
        }
        // kwargs dicts: one honest lump row each, like the manager chips
        for (const k of ['chat_template_kwargs', 'forced_ct_kwargs']) {
            const ov = prof[k];
            if (ov === null || ov === undefined) continue;
            if (Array.isArray(ov) && !ov.length) continue;
            if (typeof ov === 'object' && !Array.isArray(ov) && !Object.keys(ov).length) continue;
            if (!_reqEq(base[k] === undefined ? null : base[k], ov))
                out.push({ key: k, base: base[k] === undefined ? null : base[k], other: ov });
        }
        return out;
    }
    /* REQ-DIV display: does a profile's STORED value equal the base's
       EFFECTIVE value (i.e. the snapshot currently behaves like
       inheritance)? Strict rule without server data (stored-vs-stored);
       with model+gs the base side may resolve through effDefault. Equal
       snapshot rows are dimmed with an '(inherited)' tag — when base moves,
       requestDiff starts reporting the row and the tag lifts (it compares
       against the ORIGINAL base, so the queued edit shows the drift). */
    function eqBase(val, baseVal, k, model, gs) {
        if (_reqNullish(val)) return false;
        if (!_reqNullish(baseVal)) return _reqEq(val, baseVal);
        const e = _reqEff(baseVal, k, model, gs);
        return e !== null && _reqEq(val, e);
    }

    /* EFF-1 (upstream #4416 era): the value a field FALLS BACK to when the
       model has none stored — pure re-export of what the server already
       reports (admin model entry + global-settings). Never a JS-side
       re-implementation of engine logic: keys the API does not report
       (min_p, presence_penalty) return null and keep the bare '(default)'
       placeholder. Returns {kind, ...payload} so the host localizes. */
    function effDefault(key, model, gs) {
        const s = (gs && gs.sampling) || {};
        // The engine has an OCR defaults tier between model settings and
        // global that the API does NOT expose. #4416 seeds
        // temperature/top_p/top_k/repetition_penalty into stored settings at
        // discovery (SAMPLING_SETTING_KEYS), so those never reach the OCR
        // tier — but max_tokens is NOT seeded, so an OCR model can be
        // silently clamped there. Claim nothing for max_tokens on OCR
        // models; the bare '(default)' placeholder stays.
        const ocr = ((model && model.config_model_type) || '')
            .toLowerCase().replace(/-/g, '_').includes('ocr');
        if (key === 'max_context_window') {
            const native = model && model.model_context_length;
            const policy = Number(s.max_context_window_policy) || 0;
            if (native != null)
                // CW-1 (user 2026-10-14): when the POLICY is the binding tier
                // the number comes from the server's global setting, not the
                // model's config.json — labelling it 'model config' was a lie
                // (config.json said 262144, the clamp showed 256000). Same
                // value the server computes (min(native, policy)); only the
                // HONEST KIND changes.
                return policy > 0 && policy < native
                    ? { kind: 'policy_clamp', value: policy }
                    : { kind: 'model_config', value: native };
            if (s.max_context_window != null)
                return { kind: 'global_default', value: s.max_context_window };
            return null;
        }
        if (key === 'max_tokens')
            return (!ocr && s.max_tokens != null)
                ? { kind: 'global_default', value: s.max_tokens } : null;
        if (key === 'ttl_seconds') {
            if (model && model.pinned) return { kind: 'pinned' };
            const t = gs && gs.idle_timeout && gs.idle_timeout.idle_timeout_seconds;
            return t ? { kind: 'global_ttl', seconds: t } : { kind: 'no_ttl' };
        }
        // REQ-DIV support: an unset enable_thinking falls back to the model's
        // OWN default, which the admin entry reports (thinking_default) —
        // resolve it when present, claim nothing when absent.
        if (key === 'enable_thinking') {
            const td = model && model.thinking_default;
            return td === true || td === false
                ? { kind: 'model_config', value: td } : null;
        }
        if (['temperature', 'top_p', 'top_k', 'repetition_penalty'].includes(key)
                && s[key] != null)
            return { kind: 'global_default', value: s[key] };
        return null;    // not reported by the server — no claim made
    }

    return { DIFFUSION_CONFIG_MODEL_TYPES, DIFFUSION_UNSUPPORTED_PROFILE_FIELDS,
             DIFFUSION_UNSUPPORTED_CT_KWARGS, REASONING_EFFORT_PRESETS,
             MODEL_TYPE_OPTIONS, VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES,
             DFLASH_DRAFTER_CONFIG_MODEL_TYPES,
             llmLike, TYPE_ONLY_KEYS, stickyForType,
             normType,
             isDiffusion, isQwenOqA8, showsQwenOqA8, DSA_MODEL_TYPES,
             coerceKwargValue, buildCtKwargEntries,
             kwargIdentity, mergeRawKwargs,
             buildState, validate, buildPayload, adaptToServerPayload,
             adaptToServerSettings,
             runtimeSignature, runtimeDiff, sigMasterKey, RUNTIME_SETTING_KEYS,
             effDefault, requestDiff, eqBase, REQUEST_DIFF_KEYS,
             isDflashDraftModel, isVlmMtpDraftModel, isSpecPrefillDraftModel,
             specprefillCandidates, dflashCandidates, vlmMtpDrafters,
             profileRecord, GiB };
});
