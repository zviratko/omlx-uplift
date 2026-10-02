/* TST-1: global-settings save-payload contract as a UMD data module
   (modelspec.js pattern). GS_MAP (flat form field -> [section, key]),
   GS_PAYLOAD_SKIP (keys the classic full payload must not round-trip) and
   INTEG_PREFIXED (integration keys saved with the integrations_ prefix)
   used to be IIFE-locals that tests brace-walked out of the source text.
   Pure data — no DOM, no state — so both the page and node tests read the
   same single definition. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftGSpec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const GS_MAP = {
    host: ['server','host'], port: ['server','port'],
    log_level: ['server','log_level'],
    sse_keepalive_mode: ['server','sse_keepalive_mode'],
    burst_decode_mode: ['server','burst_decode_mode'],
    preserve_mid_system_cache: ['server','preserve_mid_system_cache'],
    qwen4_gdn_decode_wide_proj: ['server','qwen4_gdn_decode_wide_proj'],
    distributed_inference_enabled: ['server','distributed_inference_enabled'],
    max_audio_upload_size: ['server','max_audio_upload_size'],
    model_dirs: ['model','model_dirs'], model_fallback: ['model','model_fallback'],
    hide_helper_models: ['model','hide_helper_models'],
    idle_timeout_seconds: ['idle_timeout','idle_timeout_seconds'],
    hf_cache_enabled: ['huggingface','hf_cache_enabled'],
    memory_prefill_memory_guard: ['memory','prefill_memory_guard'],
    memory_guard_tier: ['memory','memory_guard_tier'],
    memory_guard_custom_ceiling_gb: ['memory','memory_guard_custom_ceiling_gb'],
    max_concurrent_requests: ['scheduler','max_concurrent_requests'],
    embedding_batch_size: ['scheduler','embedding_batch_size'],
    chunked_prefill: ['scheduler','chunked_prefill'],
    prefill_priority: ['scheduler','prefill_priority'],
    decode_fairness: ['scheduler','decode_fairness'],
    cache_enabled: ['cache','enabled'],
    ssd_cache_dir: ['cache','ssd_cache_dir'],
    hot_cache_only: ['cache','hot_cache_only'],
    hot_cache_write_through: ['cache','hot_cache_write_through'],
    ane_compile_cache: ['cache','ane_compile_cache'],
    initial_cache_blocks: ['cache','initial_cache_blocks'],
    gdn_snapshot_storage: ['cache','gdn_snapshot_storage'],
    gdn_ssd_pending_max_size: ['cache','gdn_ssd_pending_max_size'],
    gdn_sidecar_precision: ['cache','gdn_sidecar_precision'],
    sampling_max_context_window: ['sampling','max_context_window'],
    sampling_max_context_window_policy: ['sampling','max_context_window_policy'],
    sampling_max_tokens: ['sampling','max_tokens'],
    sampling_temperature: ['sampling','temperature'],
    sampling_top_p: ['sampling','top_p'], sampling_top_k: ['sampling','top_k'],
    sampling_repetition_penalty: ['sampling','repetition_penalty'],
    mcp_config: ['mcp','config_path'], mcp_expose_tools: ['mcp','expose_tools'],
    usage_history: ['usage','usage_history'],
    network_http_proxy: ['network','http_proxy'],
    network_https_proxy: ['network','https_proxy'],
    network_no_proxy: ['network','no_proxy'],
    network_ca_bundle: ['network','ca_bundle'],
    ui_language: ['ui','language'],
    api_key: ['auth','api_key'],
    skip_api_key_verification: ['auth','skip_api_key_verification'],
    // P1A parity with classic GlobalSettingsRequest (79 keys)
    server_aliases: ['server','server_aliases'],
    auto_start_on_launch: ['server','auto_start_on_launch'],
    hf_endpoint: ['huggingface','endpoint'],
    ms_endpoint: ['modelscope','endpoint'],
    ssd_cache_max_size: ['cache','ssd_cache_max_size'],
    hot_cache_max_size: ['cache','hot_cache_max_size'],
    // gdn_ssd_split_enabled is legacy: upstream 400s when sent together with
    // gdn_snapshot_storage (always in the full payload, classic parity), so
    // it is intentionally not mapped or saved.
    claude_code_mode: ['claude_code','mode'],
    claude_code_opus_model: ['claude_code','opus_model'],
    claude_code_sonnet_model: ['claude_code','sonnet_model'],
    claude_code_haiku_model: ['claude_code','haiku_model'],
};
/* Keys the classic saveGlobalSettings() includes in its full payload.
   base_path is launch-time only (read-only row); api_key is sent masked and
   skipped upstream when unchanged — sending the masked value would corrupt it. */
/* ui_dashboard_layout is the CLASSIC dashboard's saved block layout —
   Uplift has its own localStorage layout and must never round-trip or
   clobber the classic one. Omitting it from the payload means "keep"
   (routes.py only applies keys present in model_fields_set). */

/* Keys the classic saveGlobalSettings() includes in its full payload.
   base_path is launch-time only (read-only row); api_key is sent masked and
   skipped upstream when unchanged — sending the masked value would corrupt
   it. ui_dashboard_layout is the CLASSIC dashboard's saved block layout —
   Uplift has its own localStorage layout and must never round-trip or
   clobber the classic one. Omitting a key means "keep" server-side
   (routes.py only applies keys present in model_fields_set). */
const GS_PAYLOAD_SKIP = new Set(['base_path', 'api_key', 'ui_dashboard_layout']);

/* Integration keys whose save payload carries the integrations_ prefix;
   the others (markitdown_*, web_search_*) save bare — classic parity,
   upstream drops unknown fields with a silent success:true. */
const INTEG_PREFIXED = new Set(['copilot_model', 'codex_model', 'opencode_model',
    'openclaw_model', 'hermes_model', 'pi_model', 'openclaw_tools_profile']);

return { GS_MAP, GS_PAYLOAD_SKIP, INTEG_PREFIXED };
});
