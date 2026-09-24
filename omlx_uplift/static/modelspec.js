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
        'index_cache_freq', 'turboquant_kv_enabled', 'turboquant_kv_bits',
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
        'specprefill_enabled', 'specprefill_draft_model', 'specprefill_keep_pct',
        'specprefill_threshold', 'dflash_enabled', 'dflash_draft_model',
        'dflash_draft_quant_enabled', 'dflash_draft_quant_weight_bits',
        'dflash_draft_quant_activation_bits', 'dflash_draft_quant_group_size',
        'dflash_max_ctx', 'dflash_in_memory_cache',
        'dflash_in_memory_cache_max_entries', 'dflash_in_memory_cache_max_bytes',
        'dflash_ssd_cache', 'dflash_ssd_cache_max_bytes',
        'dflash_draft_window_size', 'dflash_draft_sink_size', 'dflash_block_size',
        'dflash_verify_mode', 'mtp_enabled', 'mtp_adaptive_max_depth',
        'mtp_fixed_depth', 'qwen35_ane_prefill_shared_fraction',
        'vlm_mtp_enabled', 'vlm_mtp_draft_model', 'vlm_mtp_draft_block_size',
    ]);
    const DIFFUSION_UNSUPPORTED_CT_KWARGS = new Set([
        'enable_thinking', 'reasoning_effort', 'preserve_thinking',
    ]);
    const REASONING_EFFORT_PRESETS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    const MODEL_TYPE_OPTIONS = ['llm', 'vlm', 'embedding', 'reranker',
                                'audio_stt', 'audio_tts', 'audio_sts'];
    const VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES = new Set([
        'gemma4_assistant', 'gemma4_unified_assistant', 'qwen3_5_mtp',
    ]);
    const SAMPLING_TYPES = new Set([null, undefined, '', 'llm', 'vlm']);
    const GiB = 1024 ** 3;

    const normType = t => String(t || '').toLowerCase().replace(/-/g, '_');
    const isDiffusion = m => DIFFUSION_CONFIG_MODEL_TYPES.has(normType(m && m.config_model_type));
    const isQwenOqA8 = m => ['qwen3_5', 'qwen3_6', 'qwen3_8'].some(p => normType(m && m.config_model_type).startsWith(p));

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

    function buildState(model, s) {
        s = s || {};
        const diffusion = isDiffusion(model);
        const isOcr = normType(model && model.config_model_type).includes('ocr');
        return {
            model_alias: s.model_alias || '',
            model_type_override: s.model_type_override || '',
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
            deepseek_v41_engram_ssd_offload: (model && model.deepseek_v41_engram_ssd_offload_forced === true) || s.deepseek_v41_engram_ssd_offload === true,
            deepseek_v41_engram_ssd_offload_requested: s.deepseek_v41_engram_ssd_offload === true,
            deepseek_v41_engram_ssd_offload_supported: !!(model && model.deepseek_v41_engram_ssd_offload_supported === true),
            deepseek_v41_engram_ssd_offload_forced: !!(model && model.deepseek_v41_engram_ssd_offload_forced === true),
            enableThinkingBudget: !!s.thinking_budget_tokens,
            thinking_budget_tokens: s.thinking_budget_tokens || null,
            guided_grammar_enabled: s.guided_grammar_enabled || false,
            guided_grammar: s.guided_grammar || '',
            enableToolResultLimit: !!s.max_tool_result_tokens,
            max_tool_result_tokens: s.max_tool_result_tokens || null,
            reasoning_parser: s.reasoning_parser || '',
            cache_reasoning_output: s.cache_reasoning_output ?? null,
            ttl_seconds: s.ttl_seconds ?? null,
            enableIndexCache: !!s.index_cache_freq,
            index_cache_freq: s.index_cache_freq || null,
            turboquant_kv_enabled: s.turboquant_kv_enabled || false,
            turboquant_kv_bits: s.turboquant_kv_bits || 4,
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
            dflash_enabled: s.dflash_enabled || false,
            dflash_draft_model: s.dflash_draft_model || '',
            dflash_draft_quant_enabled: s.dflash_draft_quant_enabled || false,
            dflash_draft_quant_weight_bits: s.dflash_draft_quant_weight_bits || 4,
            dflash_draft_quant_activation_bits: s.dflash_draft_quant_activation_bits || 16,
            dflash_draft_quant_group_size: s.dflash_draft_quant_group_size || 64,
            dflash_max_ctx: s.dflash_max_ctx ?? null,
            dflash_in_memory_cache: s.dflash_in_memory_cache !== false,
            dflash_in_memory_cache_max_entries: s.dflash_in_memory_cache_max_entries || 4,
            dflash_in_memory_cache_max_gib: s.dflash_in_memory_cache_max_bytes
                ? Math.round(s.dflash_in_memory_cache_max_bytes / GiB) : 8,
            dflash_ssd_cache: s.dflash_ssd_cache || false,
            dflash_ssd_cache_max_gib: s.dflash_ssd_cache_max_bytes
                ? Math.round(s.dflash_ssd_cache_max_bytes / GiB) : 20,
            dflash_draft_window_size: s.dflash_draft_window_size ?? null,
            dflash_draft_sink_size: s.dflash_draft_sink_size ?? 0,
            dflash_block_size: s.dflash_block_size ?? null,
            dflash_verify_mode: s.dflash_verify_mode || 'adaptive',
            dflash_compatible: !(model && model.dflash_compatible === false),
            dflash_compatibility_reason: (model && model.dflash_compatibility_reason) || '',
            dflash_ssd_cache_available: !!(model && model.dflash_ssd_cache_available),
            mtp_enabled: s.mtp_enabled || false,
            mtp_compatible: !!(model && model.mtp_compatible === true),
            mtp_compatibility_reason: (model && model.mtp_compatibility_reason) || '',
            is_paroquant: !!(model && model.is_paroquant === true),
            paroquant_reason: (model && model.paroquant_reason) || '',
            vlm_mtp_enabled: s.vlm_mtp_enabled || false,
            vlm_mtp_draft_model: s.vlm_mtp_draft_model || '',
            vlm_mtp_draft_block_size: s.vlm_mtp_draft_block_size ?? null,
            mtp_adaptive_max_depth: s.mtp_adaptive_max_depth ?? null,
            mtp_fixed_depth: s.mtp_fixed_depth ? String(s.mtp_fixed_depth) : '',
            trust_remote_code: s.trust_remote_code || false,
            ctKwargEntries: buildCtKwargEntries(s.chat_template_kwargs, s.forced_ct_kwargs, diffusion),
            is_diffusion_model: diffusion,
        };
    }

    /* ---- client-side validation (mirrors validateQwenOqA8Settings /
       validateQwenAneSettings + server __post_init__ conflicts) ---- */
    const num = v => Number(v);
    function validate(ms) {
        const errors = [];
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
        if (ms.vlm_mtp_enabled) {
            for (const [label, on] of [['DFlash', ms.dflash_enabled], ['SpecPrefill', ms.specprefill_enabled],
                                       ['Lightning MTP', ms.mtp_enabled], ['TurboQuant KV', ms.turboquant_kv_enabled]])
                if (on) errors.push(`VLM MTP and ${label} cannot both be enabled; choose one speculative path per model.`);
            if (ms.guided_grammar_enabled || ms.repetition_penalty != null || ms.presence_penalty != null)
                errors.push('VLM MTP cannot be combined with guided grammar or repetition/presence penalties (per-request logits processors).');
        }
        if (ms.moe_expert_offload_enabled && (ms.mtp_enabled || ms.vlm_mtp_enabled || ms.dflash_enabled))
            errors.push('MoE expert offload cannot be combined with Lightning MTP, VLM MTP, or DFlash; disable speculative decoding first.');
        const frac = num(ms.moe_expert_offload_resident_fraction);
        if (!(frac > 0 && frac <= 1)) errors.push('MoE resident fraction must be in (0, 1].');
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
            deepseek_v41_engram_ssd_offload: ms.deepseek_v41_engram_ssd_offload_forced
                ? !!ms.deepseek_v41_engram_ssd_offload_requested
                : !!ms.deepseek_v41_engram_ssd_offload,
            thinking_budget_enabled: !!ms.enableThinkingBudget,
            thinking_budget_tokens: ms.enableThinkingBudget ? (ms.thinking_budget_tokens || null) : 0,
            cache_reasoning_output: ms.cache_reasoning_output ?? null,
            guided_grammar_enabled: !!ms.guided_grammar_enabled,
            guided_grammar: ms.guided_grammar_enabled ? (ms.guided_grammar || null) : null,
            max_tool_result_tokens: ms.enableToolResultLimit ? (ms.max_tool_result_tokens || null) : 0,
            chat_template_kwargs: Object.keys(chatTemplateKwargs).length > 0 ? chatTemplateKwargs : null,
            forced_ct_kwargs: forcedCtKwargs.length > 0 ? forcedCtKwargs : null,
            turboquant_kv_enabled: !!ms.turboquant_kv_enabled,
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
            dflash_enabled: !!ms.dflash_enabled,
            dflash_draft_model: ms.dflash_draft_model || null,
            dflash_draft_quant_enabled: !!ms.dflash_enabled && !!ms.dflash_draft_quant_enabled,
            dflash_draft_quant_weight_bits: ms.dflash_enabled && ms.dflash_draft_quant_enabled
                ? parseInt(ms.dflash_draft_quant_weight_bits) : null,
            dflash_draft_quant_activation_bits: ms.dflash_enabled && ms.dflash_draft_quant_enabled
                ? parseInt(ms.dflash_draft_quant_activation_bits) : null,
            dflash_draft_quant_group_size: ms.dflash_enabled && ms.dflash_draft_quant_enabled
                ? parseInt(ms.dflash_draft_quant_group_size) : null,
            dflash_max_ctx: ms.dflash_enabled && ms.dflash_max_ctx ? parseInt(ms.dflash_max_ctx) : null,
            dflash_in_memory_cache: ms.dflash_enabled ? !!ms.dflash_in_memory_cache : true,
            dflash_in_memory_cache_max_entries: ms.dflash_enabled
                ? (parseInt(ms.dflash_in_memory_cache_max_entries) || 4) : 4,
            dflash_in_memory_cache_max_bytes: ms.dflash_enabled
                ? Math.max(1, parseInt(ms.dflash_in_memory_cache_max_gib) || 8) * GiB : 8 * GiB,
            dflash_ssd_cache: !!ms.dflash_enabled && !!ms.dflash_in_memory_cache
                && !!ms.dflash_ssd_cache_available && !!ms.dflash_ssd_cache,
            dflash_ssd_cache_max_bytes: ms.dflash_enabled
                ? Math.max(1, parseInt(ms.dflash_ssd_cache_max_gib) || 20) * GiB : 20 * GiB,
            dflash_draft_window_size: ms.dflash_enabled && ms.dflash_draft_window_size
                ? parseInt(ms.dflash_draft_window_size) : null,
            dflash_draft_sink_size: ms.dflash_enabled && ms.dflash_draft_sink_size !== null
                && ms.dflash_draft_sink_size !== undefined && ms.dflash_draft_sink_size !== ''
                ? parseInt(ms.dflash_draft_sink_size) : 0,
            dflash_block_size: ms.dflash_enabled && ms.dflash_block_size
                ? parseInt(ms.dflash_block_size) : null,
            dflash_verify_mode: ms.dflash_enabled ? (ms.dflash_verify_mode || 'adaptive') : null,
            mtp_enabled: !!ms.mtp_enabled,
            mtp_adaptive_max_depth: ms.mtp_enabled && ms.mtp_adaptive_max_depth
                ? Math.max(1, parseInt(ms.mtp_adaptive_max_depth) || 1) : null,
            mtp_fixed_depth: ms.mtp_enabled && ms.mtp_fixed_depth
                ? parseInt(ms.mtp_fixed_depth) : null,
            vlm_mtp_enabled: !!ms.vlm_mtp_enabled,
            vlm_mtp_draft_model: ms.vlm_mtp_enabled ? (ms.vlm_mtp_draft_model || null) : null,
            vlm_mtp_draft_block_size: ms.vlm_mtp_enabled && ms.vlm_mtp_draft_block_size
                ? parseInt(ms.vlm_mtp_draft_block_size) : null,
            trust_remote_code: !!ms.trust_remote_code,
        };
        if (diffusion) {
            Object.assign(payload, {
                top_p: null, top_k: null, repetition_penalty: null, min_p: null,
                presence_penalty: null, force_sampling: false, reasoning_parser: null,
                index_cache_freq: 0, enable_thinking: null,
                thinking_budget_enabled: false, thinking_budget_tokens: 0,
                cache_reasoning_output: null,
                guided_grammar_enabled: false, guided_grammar: null,
                max_tool_result_tokens: 0, turboquant_kv_enabled: false,
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
                dflash_enabled: false, mtp_enabled: false,
                vlm_mtp_enabled: false, vlm_mtp_draft_model: null,
                moe_expert_offload_enabled: false,
                qwen35_oq_a8_enabled: false,
            });
        }
        return payload;
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

    return { DIFFUSION_CONFIG_MODEL_TYPES, DIFFUSION_UNSUPPORTED_PROFILE_FIELDS,
             DIFFUSION_UNSUPPORTED_CT_KWARGS, REASONING_EFFORT_PRESETS,
             MODEL_TYPE_OPTIONS, VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES,
             DFLASH_DRAFTER_CONFIG_MODEL_TYPES,
             isDiffusion, isQwenOqA8, coerceKwargValue, buildCtKwargEntries,
             buildState, validate, buildPayload,
             isDflashDraftModel, isVlmMtpDraftModel, isSpecPrefillDraftModel,
             specprefillCandidates, dflashCandidates, vlmMtpDrafters,
             profileRecord, GiB };
});
