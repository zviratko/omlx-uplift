/* Uplift GLOBAL SETTINGS (PH2-1 stage 6 extraction from uplift.js): Settings
   tab server form — GS_LABELS/GS_MAP schema mirror, dirty queue, save +
   restart flow, env tunables, cluster gate sync, secret masking. Plain
   script; loads AFTER uplift_state.js and BEFORE uplift.js, which
   late-binds shared helpers (toast/fetchJson/postJson/cell/emptyMsg/
   loadLocale/currentTab and the mutable GW_LIVE flag) through
   window.Uplift._gsysGlue — resolved at call time, never at load time.
   gsSavedAt is a shared state cell (S) — updateModeLabels in uplift.js
   reads it. Exports window.Uplift.gsys; applyTab, loadLocale, boot and
   uplift.js's _modelGlue (SECRET_KEYS/gsDisplay) consume it. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const GLUE = {
    get toast() { return window.Uplift._gsysGlue.toast; },
    get fetchJson() { return window.Uplift._gsysGlue.fetchJson; },
    get postJson() { return window.Uplift._gsysGlue.postJson; },
    get emptyMsg() { return window.Uplift._gsysGlue.emptyMsg; },
    get loadLocale() { return window.Uplift._gsysGlue.loadLocale; },
    get currentTab() { return window.Uplift._gsysGlue.currentTab; },
    get cell() { return window.Uplift._gsysGlue.cell; },
    get GW_LIVE() { return window.Uplift._gsysGlue.GW_LIVE; },
};
/* ---------------- settings (Settings tab: read-only server preview) ------ */
/* ---- Server settings: editable form mirroring the classic Settings page.
   Same 11 sections, same fields, labels, hints, restart badges and
   conditional visibility (i18n strings copied from the original catalog).
   Saves replicate classic saveGlobalSettings(): full flat payload POSTed to
   global-settings — the gateway shadows it, real oMLX is never modified. */
/* ---------------- global-settings labels i18n ----------------
   GS_LABELS holds the English literals. When a non-en catalog lands we
   overwrite in place (deep walk; keys = 'uplift.gs.' + dotted path;
   option arrays localize their second element). Missing key -> the
   English literal stays (same fallback semantics as C.tf). Language
   self-names and path placeholders are never translated. */
const GS_EN = JSON.parse(JSON.stringify({}));   // filled on first localize: pristine EN
function gsLocalize() {
    const strings = C.getLocale().strings;
    if (!Object.keys(GS_EN).length) Object.assign(GS_EN, JSON.parse(JSON.stringify(GS_LABELS)));
    (function walk(en, cur, prefix) {
        for (const k of Object.keys(en)) {
            const ev = en[k], cv = cur[k];
            const path = prefix + k;
            if (ev && typeof ev === 'object' && !Array.isArray(ev)) { walk(ev, cv, path + '.'); continue; }
            if (/^lang\.|_placeholder$/.test(path)) continue;
            if (typeof ev === 'string') {
                const s = strings['uplift.gs.' + path];
                cur[k] = (typeof s === 'string' && s) ? s : ev;      // restore-or-translate, idempotent
            } else if (Array.isArray(ev) && Array.isArray(ev[0])) {  // [[value,label],…]
                cur[k] = ev.map(([v, lbl]) => {
                    const s = strings['uplift.gs.' + path + '.' + v];
                    return [v, (typeof s === 'string' && s) ? s : lbl];
                });
            }
        }
    })(GS_EN, GS_LABELS, '');
}

const GS_LABELS = {
    lang: { en: 'English', zh: '中文（简体）', 'zh-TW': '中文（繁體）', ko: '한국어',
            ja: '日本語', ru: 'Русский', es: 'Español', fr: 'Français',
            'pt-BR': 'Português (Brasil)', cs: 'Čeština' },
    auth: { api_key: 'API Key',
        api_key_hint: 'Clients must send this key in the Authorization header.',
        api_key_placeholder: C.tf('uplift.ui.enter_new_api_key', 'Enter new API key'),
        base_path: 'Base Path',
        base_path_hint: 'URL prefix when served behind a reverse proxy (e.g. /omlx).',
        skip: 'Skip API key verification',
        skip_hint: 'Disable authentication for local development.',
        skip_warning: 'Anyone on the network can call this server.' },
    server: { host: 'Host', host_placeholder: '127.0.0.1',
        port: 'Port', log_level: 'Log level',
        auto_start: 'Start on Login', auto_start_hint: 'Launch oMLX automatically when this Mac signs in.',
        aliases: 'Server Aliases',
        aliases_hint: 'Names this server answers to (one per line).',
        levels: [['error','Error'],['warning','Warning'],['info','Info'],
                 ['debug','Debug'],['trace','Trace']] },
    model: { dirs: 'Model Directories', ph_primary: '/path/to/models',
        ph_additional: 'Additional directory…',
        fallback: 'Model Fallback', fallback_desc: C.tf('uplift.ui.alias_to_use_when_the_requested_model_is_unavail', 'Alias to use when the requested model is unavailable.'),
        hide_helper: 'Hide helper models', hide_helper_desc: C.tf('uplift.ui.keep_drafters_and_assistants_out_of_model_lists', 'Keep drafters and assistants out of model lists.'),
        hf_cache: 'Hugging Face cache', hf_cache_desc: C.tf('uplift.ui.reuse_downloaded_models_from_the_local_hf_cache', 'Reuse downloaded models from the local HF cache.'),
        idle: 'Idle Timeout', idle_desc: C.tf('uplift.ui.unload_a_model_after_it_has_been_unused_for_this', 'Unload a model after it has been unused for this long.'),
        idle_opts: [['','Never'],['900','15 minutes'],['1800','30 minutes'],
                    ['3600','1 hour'],['7200','2 hours'],['28800','8 hours'],
                    ['86400','24 hours']] },
    res: { max_conc: 'Max Concurrent Requests',
        max_conc_hint: 'Requests admitted at once; others queue.',
        batch: 'Embedding Batch Size',
        batch_hint: 'Texts encoded per embedding forward pass.',
        chunked: 'Chunked Prefill', chunked_desc: C.tf('uplift.ui.split_long_prompts_to_interleave_with_decode', 'Split long prompts to interleave with decode.'),
        fairness: 'Decode Fairness', fairness_desc: C.tf('uplift.ui.round_robin_decode_slots_across_requests', 'Round-robin decode slots across requests.'),
        prio: 'Prefill Priority', prio_speed: 'Speed', prio_context: 'Max Context',
        guard: 'Prefill Memory Guard',
        guard_desc: C.tf('uplift.ui.refuse_prefill_when_free_memory_is_below_the_gua', 'Refuse prefill when free memory is below the guard.'),
        tier: 'Memory Guard Tier',
        tiers: [['safe','Safe'],['balanced','Balanced'],['aggressive','Aggressive'],
                ['custom','Custom']],
        custom: 'Custom Ceiling (GB)',
        custom_ph: 'e.g. 48',
        cold: 'Cold Cache Limit',
        cold_desc: C.tf('uplift.ui.cap_on_non_hot_kv_cache_blocks', 'Cap on non-hot KV cache blocks.'),
        hot: 'Hot Cache Limit' },
    cache: { enabled: 'KV Cache', enabled_hint: 'Keep KV blocks between requests.',
        hot_only: 'Hot Cache Only',
        hot_only_hint: 'Never spill cached KV to SSD.',
        ssd_dir: 'SSD Cache Directory',
        ssd_max: 'SSD Cache Max Size',
        ssd_max_hint: 'Example: 64GB (blank = OS default).',
        hot_max: 'Hot Cache Max Size',
        hot_max_hint: '"0" disables, example: 8GB.',
        gdn_split: 'GDN SSD Split',
        gdn_split_hint: 'Split GDN snapshots to SSD next to the pending limit.' },
    cc: { mode: 'Mode', mode_hint: 'Local routes Claude Code through this server; cloud uses Anthropic directly.',
        local: 'Local', cloud: 'Cloud',
        opus: 'Opus Model', sonnet: 'Sonnet Model', haiku: 'Haiku Model',
        ph: 'Pick or type a model' },
    gen: { max_ctx: 'Max Context Window',
        max_ctx_hint: 'Largest context a request may claim.',
        max_policy: 'Max Context Policy',
        max_policy_hint: 'Override applied to model default (blank = model decides).',
        max_tokens: 'Max Tokens',
        temperature: 'Temperature', temperature_hint: 'Sampling randomness (0 = greedy).',
        top_p: 'Top-P (Nucleus)', top_p_hint: 'Cumulative probability mass kept.',
        top_k: 'Top-K', top_k_hint: '0 disables top-K.',
        rep_pen: 'Repetition Penalty', rep_pen_hint: 'Penalty for reusing recent tokens (1 = off).' },
    mcp: { path: 'MCP Config Path',
        ph: '~/.mcp.json',
        expose: 'Expose MCP Tools',
        expose_hint: 'Serve built-in tools over Model Context Protocol.' },
    usage: { history: 'Usage History',
        history_hint: 'Record per-model token usage for the Usage tab.' },
    net: { http_proxy: 'HTTP Proxy', proxy_hint: 'Example: http://proxy.company.com:8080',
        hf_ep: 'Hugging Face Endpoint',
        hf_ep_hint: 'Mirror or Hub instance used for downloads (blank = huggingface.co).',
        ms_ep: 'ModelScope Endpoint',
        ms_ep_hint: 'ModelScope mirror for downloads (blank = modelscope.cn).',
        https_proxy: 'HTTPS Proxy',
        no_proxy: 'No Proxy', no_proxy_hint: 'Comma-separated hosts to bypass proxy',
        ca_bundle: 'CA Bundle',
        ca_hint: 'Path to PEM file for corporate TLS interception' },
    adv: { distributed: 'Distributed Inference',
        distributed_enabled: 'Enable distributed inference',
        distributed_hint: 'Split layers across multiple machines (experimental).',
        perf: 'Performance', streaming: 'Streaming', uploads: 'Uploads',
        burst: 'Burst Decode',
        burst_hint: 'Speculative decode aggressiveness for burst throughput.',
        burst_opts: [['off','Off'],['light','Light'],['balanced','Balanced'],
                     ['aggressive','Aggressive']],
        sse: 'SSE Keepalive Mode',
        sse_hint: 'How keepalives are emitted on streaming responses.',
        sse_opts: [['chunk','Chunk'],['comment','Comment'],['off','Off']],
        mid_sys: 'Preserve Mid-System Cache',
        mid_sys_hint: 'Keep cached KV for system prompts placed mid-conversation.',
        wide_proj: 'Qwen4 Wide-Proj GDN Decode',
        wide_proj_hint: 'Wider projection in fused Qwen4 GDN decode (experimental).',
        audio: 'Maximum Audio Upload Size (MB)',
        audio_hint: 'Reject audio attachments above this size.',
        ane: 'ANE Compile Cache',
        ane_hint: 'Cache CoreML compiled graphs on the Neural Engine.',
        wt: 'Hot Cache Write-Through',
        wt_hint: 'Write hot blocks to SSD immediately.',
        blocks: 'Initial Cache Blocks',
        blocks_hint: 'KV blocks allocated at startup.',
        gdn_store: 'GDN Snapshot Storage',
        gdn_store_hint: 'Where Gated-DeltaNet state snapshots go.',
        gdn_store_opts: [['auto','Auto'],['ssd_sidecar','SSD Sidecar'],
                         ['embedded','Embedded']],
        gdn_pend: 'GDN Pending Write Limit',
        gdn_pend_hint: 'Max queued SSD writes before backpressure.',
        gdn_prec: 'GDN Sidecar State Precision',
        gdn_prec_hint: 'Quantisation of sidecar-held recurrent state.',
        gdn_prec_opts: [['fp32','FP32'],['rht_int16','RHT INT16'],['bf16','BF16'],
                        ['int8','INT8'],['rht_int8','RHT INT8']],
        gdn_prec_warning: 'INT8/RHT INT8 state precision may degrade long-context quality.' },
    badge: 'RESTART REQUIRED',
    restart_notice: 'Host and port changes take effect after a restart.',
};

// shadow key -> nested [section, field] map (mirrors GlobalSettingsRequest)
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
const GS_PAYLOAD_SKIP = new Set(['base_path', 'api_key', 'ui_dashboard_layout']);

let GS = null;   // merged working copy (upstream + shadow)
/* Dirty tracking for the deferred-SAVE flow: GS_ORIG is the snapshot at page
   load / last save; gsDirty holds queued-but-unsaved flat->value edits.
   Fields whose change only takes effect after a server restart are flagged
   red (!) and force the sticky SAVE button into RESTART SERVER once the
   queue is saved. Which fields restart: mirrors the classic template's
   restart badges (server host/port/auto-start, max concurrent requests,
   cache enable, MCP config, distributed + CA bundle, proxy endpoints). */
let GS_ORIG = {};
const gsDirty = {};
let gsRestartPending = false;   // queued edits were saved; server restart still owed
const GS_RESTART_FIELDS = new Set([
    'host', 'port', 'auto_start_on_launch', 'max_concurrent_requests',
    'cache_enabled', 'mcp_config', 'distributed_inference_enabled',
    'network_ca_bundle', 'hf_endpoint', 'ms_endpoint']);
function gsQueueSave(flat, val) {           // edit -> queue, no fetch yet
    markFieldDirty(flat, val);
    if (['custom_model_prefixes'].includes(flat)) renderGlobalSettings();
}
function gsOrigFlat(flat) {
    const map = GS_MAP[flat];
    if (map) return (GS_ORIG[map[0]] || {})[map[1]];
    // env tunables: baseline is the uplift-stored value (they never live
    // in GS/GS_ORIG; isEnvFlat + ENV_VALUES are the source of truth).
    // unset normalises to null so clearing an empty row is not dirty.
    if (typeof isEnvFlat === 'function' && isEnvFlat(flat))
        return ENV_VALUES[flat] != null ? ENV_VALUES[flat] : null;
    return GS_ORIG[flat];
}
function gsValFlat(flat) {
    const map = GS_MAP[flat];
    if (map) return gsGet(map[0], map[1]);
    if (typeof isEnvFlat === 'function' && isEnvFlat(flat))
        return ENV_VALUES[flat] !== undefined ? ENV_VALUES[flat] : undefined;
    return GS._shadow ? GS._shadow[flat] : undefined;
}
function gsDisplay(v) {
    if (v === null || v === undefined || v === '') return '(unset)';
    return String(Array.isArray(v) ? v.join(',') : v);
}
/* fields whose values are secrets: diff chips and the CHANGES list say
   CHANGED instead of printing the value (API key stays masked everywhere) */
const SECRET_KEYS = new Set(['api_key', 'cloud_token', 'hf_token']);
function markFieldDirty(flat, val) {
    const orig = gsOrigFlat(flat);
    const cur = val === undefined ? gsValFlat(flat) : val;
    const changed = JSON.stringify(orig) !== JSON.stringify(cur);
    if (changed) gsDirty[flat] = cur;
    else delete gsDirty[flat];               // edited back = no longer queued
    const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
    if (row) {
        row.classList.toggle('dirty', changed);
        row.classList.toggle('restartq', changed && GS_RESTART_FIELDS.has(flat));
        const rd = row.querySelector('.diff-out');
        if (rd) {
            rd.hidden = !changed;
            if (changed && SECRET_KEYS.has(flat)) {
                // masked field (API key): indicate the change, not the value
                rd.classList.add('masked');
                rd.querySelector('.diff-o').textContent = '••• CHANGED';
            } else if (changed) {
                rd.classList.remove('masked');
                rd.querySelector('.diff-o').textContent = gsDisplay(orig);
            }
        }
    }
    gsUpdateSaveBtn();
    gsMarkSections();
    renderDirtyList();
}
function revertField(flat) {                // click on |original| chip
    delete gsDirty[flat];
    renderGlobalSettings();                 // inputs rebuild from the baseline
    renderDirtyList();
}
function gsMarkSections() {
    for (const box of document.querySelectorAll('#gs-body .gs-box')) {
        const rows = [...box.querySelectorAll('[data-flat].dirty')];
        const head = box.querySelector('.gs-box-title');
        if (!head) continue;
        const anyRestart = rows.some(r => r.classList.contains('restartq'));
        head.classList.toggle('sec-dirty', rows.length > 0 && !anyRestart);
        head.classList.toggle('sec-restart', anyRestart);
        let warn = head.querySelector('.rqnow');
        if (!warn) { warn = document.createElement('span'); warn.className = 'rqnow'; head.append(warn); }
        // U8 (user round): amber hot-apply banner for queued-but-hot edits;
        // red restart banner takes precedence
        warn.textContent = anyRestart ? ' RESTART REQUIRED ' : ' ⚡ HOT APPLY ON SAVE ';
        warn.style.display = rows.length ? '' : 'none';
    }
}
function renderDirtyList() {
    const box = document.getElementById('gs-changes');
    if (!box) return;
    const keys = Object.keys(gsDirty);
    box.hidden = !keys.length;
    box.textContent = '';
    if (!keys.length) return;
    const head = document.createElement('div'); head.className = 'ch-head';
    head.textContent = C.tf('uplift.ui.changes', 'CHANGES (') + keys.length + ')';
    box.append(head);
    for (const k of keys) {
        const line = document.createElement('div'); line.className = 'ch-line';
        const secret = SECRET_KEYS.has(k);
        const a = document.createElement('span'); a.textContent = k + ': ' + (secret ? '•••' : gsDisplay(gsOrigFlat(k)));
        const arrow = document.createTextNode(' → ');
        const b2 = document.createElement('span'); b2.textContent = k + ': ' + (secret ? '••• CHANGED' : gsDisplay(gsDirty[k]));
        b2.className = 'ch-new';
        line.append(a, arrow, b2);
        box.append(line);
    }
}
function gsSaveBtn() { return document.getElementById('gs-save'); }
function gsUpdateSaveBtn() {
    const b = gsSaveBtn(); if (!b) return;
    const n = Object.keys(gsDirty).length;
    const restartQ = gsRestartPending ||
        Object.keys(gsDirty).some(k => GS_RESTART_FIELDS.has(k));
    b.classList.toggle('queued', n > 0);
    // the red RESTART state only arms after a save that left a restart owed;
    // while edits are merely queued the button stays amber SAVE (user's flow:
    // click SAVE -> saved -> button becomes RESTART SERVER)
    b.classList.toggle('restart-mode', gsRestartPending);
    b.textContent = n
        ? (restartQ ? '▶ SAVE + RESTART (' + n + ')' : 'SAVE (' + n + ')')
        : (gsRestartPending ? '▶ RESTART SERVER' : 'SAVE');
    b.title = n ? (restartQ
        ? 'Some queued changes need a server restart to take effect. First click saves; the button then becomes RESTART SERVER.'
        : 'Apply ' + n + ' queued change' + (n > 1 ? 's' : ''))
        : 'No queued changes';
}
async function gsCommit() {
    const fields = Object.assign({}, gsDirty);
    // env tunables ride a different endpoint; classic fields keep the
    // full-payload global-settings save (P1A-6 semantics unchanged)
    const envFields = {}, classicFields = {};
    for (const [k, v] of Object.entries(fields))
        (isEnvFlat(k) ? envFields : classicFields)[k] = v;
    let okAll = true;
    if (Object.keys(classicFields).length) okAll = await gsSaveNow(classicFields);
    if (okAll && Object.keys(envFields).length) okAll = await envSave(envFields);
    if (okAll) {
        Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
        // a save that touched restart-requiring fields leaves the server
        // owing a restart: arm the red RESTART SERVER button (user flow)
        if (Object.keys(fields).some(k => GS_RESTART_FIELDS.has(k))) gsRestartPending = true;
    }
    // re-render inputs from the new baseline; keeps still-queued edits shown
    renderGlobalSettings();
    gsUpdateSaveBtn();
    renderDirtyList();
}
async function gsRestartServer() {
    const b = gsSaveBtn(); if (!b) return;
    b.disabled = true;
    try {
        const d = await GLUE.postJson(`${API}/admin/api/server/restart`, {});
        gsRestartPending = false;   // restart requested; button goes back to SAVE
        GLUE.toast(d.restarting === false && d.detail
            ? ('restart: ' + d.detail) : 'Restart requested — server respawns in ~5 s');
        $('banner').classList.add('show');
        $('banner-text').textContent = C.tf('uplift.ui.server_restarting_dashboard_reconnecting', 'Server restarting — dashboard reconnecting…');
    } catch (e) { GLUE.toast(C.t('uplift.toast.restart_failed', {msg: e.message})); }
    b.disabled = false;
    gsUpdateSaveBtn();
}
function gsSaveOrRestart() {                 // one button, two states
    const b = gsSaveBtn(); if (!b) return;
    if (b.classList.contains('restart-mode')) {
        if (Object.keys(gsDirty).length) { gsCommit().then(gsUpdateSaveBtn); return; }
        gsRestartServer();
    } else gsCommit();
}
async function gsSaveNow(fields) {
    // classic saveGlobalSettings(): send the FULL mapped payload built from
    // the working copy (GET response + shadow), not just changed fields —
    // omitted keys would never be written by a live save (P1A-6).
    const body = {};
    for (const flat of Object.keys(GS_MAP)) {
        if (GS_PAYLOAD_SKIP.has(flat)) continue;
        const [sec, field] = GS_MAP[flat];
        const v = gsGet(sec, field);
        if (v !== undefined) body[flat] = v;
    }
    Object.assign(body, GS._shadow || {}, fields);
    // env tunables never belong in the global-settings payload (gsCommit
    // routes them to PUT /env-overrides; strip any residue defensively)
    for (const k of Object.keys(body)) if (isEnvFlat(k)) delete body[k];
    try {
        const r = await fetch(`${API}/admin/api/global-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) { GLUE.toast(C.t('uplift.toast.save_failed_http', {status: r.status})); return false; }
        GS._shadow = body;
        for (const k of Object.keys(fields)) {
            const map = GS_MAP[k];
            if (map) GS[map[0]][map[1]] = fields[k];
        }
        // saved: the response values become the new baseline
        GS_ORIG = JSON.parse(JSON.stringify(GS));
        if (GS._shadow) GS_ORIG._shadow = body;
        S.gsSavedAt = Date.now();
        // Language change -> hot-reload our catalog (classic refreshes
        // its Jinja globals on language change; our endpoint re-reads
        // files per request, so just re-fetch + re-apply).
        if ('ui_language' in fields) GLUE.loadLocale(fields.ui_language);
        $('gs-sub').textContent = GLUE.GW_LIVE
            ? 'saved ✓'
            : 'saved ✓ (shadow — real oMLX untouched)';
        GLUE.toast(C.t('uplift.toast.settings_saved_n', {n: Object.keys(fields).length}));
        return true;
    } catch (err) { GLUE.toast(C.t('uplift.toast.save_failed', {msg: err.message})); return false; }
}

function gsGet(sec, field) {
    const sh = GS._shadow || {};
    const flat = Object.keys(GS_MAP).find(k =>
        GS_MAP[k][0] === sec && GS_MAP[k][1] === field);
    if (flat && flat in sh) return sh[flat];
    const v = (GS[sec] || {})[field];
    return v;
}


function gsBadge() {
    const b = document.createElement('span');
    // unified indicator-chip geometry (.rqchip matches the cockpit lamps:
    // same height/stroke everywhere), never clipped by the label cell
    b.className = 'rqchip';
    const bang = document.createElement('span');
    bang.className = 'rqmark'; bang.textContent = '!';
    b.append(bang, document.createTextNode(' ' + GS_LABELS.badge));
    b.title = C.tf('uplift.ui.applied_after_omlx_restart', 'Applied after oMLX restart');
    return b;
}

function gsRow(sec, labelTxt, hint, control, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'urow settings';
    if (opts.flat) row.dataset.flat = opts.flat;
    const lab = GLUE.cell(labelTxt); lab.className = 'uname';
    // The restart warning sits immediately RIGHT OF THE TITLE (user), the
    // description follows after it — previously the chip was appended after
    // the hint and wrapped onto a line below the description.
    if (opts.badge) lab.append(gsBadge());
    else if (opts.flat && GS_RESTART_FIELDS.has(opts.flat)) {
        // permanent red ! on fields whose change needs a server restart
        const m = document.createElement('span');
        m.className = 'rqmark'; m.textContent = '!';
        m.title = C.tf('uplift.ui.applied_after_omlx_restart', 'Applied after oMLX restart');
        lab.append(m);
    }
    if (hint) {
        const h = document.createElement('small');
        h.className = 'dim'; h.textContent = hint;   // sits beside the name
        lab.append(h);
    }
    // fixed 3-column layout: name+hint | diff slot (reserved, never moves
    // the control) | control — the input keeps its place when it goes dirty
    const slot = document.createElement('span'); slot.className = 'diffslot';
    const rd = document.createElement('span'); rd.className = 'diff-out'; rd.hidden = true;
    const o = document.createElement('span'); o.className = 'diff-o';
    o.title = C.tf('uplift.ui.click_to_revert_to_the_original_value', 'Click to revert to the original value');
    o.onclick = () => { if (opts.flat) revertField(opts.flat); };
    // the new value is the live control itself; slot shows |original| → only
    rd.append(o, document.createTextNode('→'));
    slot.append(rd);
    const ctl = GLUE.cell(''); ctl.className = 'gctl';
    ctl.append(control);
    row.append(lab, slot, ctl);
    return row;
}

function gsText(sec, field, flat, L, extra) {
    const inp = document.createElement('input');
    inp.type = (extra && extra.type) || 'text';
    if (extra && extra.placeholder) inp.placeholder = extra.placeholder;
    if (extra && extra.list) inp.setAttribute('list', extra.list);
    if (extra && extra.min !== undefined) inp.min = extra.min;
    if (extra && extra.max !== undefined) inp.max = extra.max;
    if (extra && extra.step !== undefined) inp.step = extra.step;
    const v = gsGet(sec, field);
    inp.value = v == null ? '' : v;
    if (extra && extra.range) {
        // R10-1: the old readout span duplicated the value in a second
        // bordered box that looked like another input. The control itself
        // shows the value; a number input gives the native stepper instead.
        inp.type = 'number';
        const queueRange = () => gsQueueSave(flat, inp.value === '' ? null : Number(inp.value));
        inp.oninput = queueRange;
        inp.onchange = queueRange;
        return inp;
    }
    const queue = (ev) => {
        let val = inp.value;
        if (extra && extra.number) val = val === '' ? null : Number(val);
        if (extra && extra.bool) val = inp.checked;
        gsQueueSave(flat, val);
        // conditional-row refresh only on commit (blur/change): a full
        // re-render on every keystroke would steal the input's focus
        if (extra && extra.reload && (!ev || ev.type === 'change')) renderGlobalSettings();
    };
    inp.addEventListener('input', queue);
    inp.addEventListener('change', queue);
    return inp;
}

function gsToggle(flat, on) {
    const t = document.createElement('input');
    t.type = 'checkbox'; t.checked = !!on;
    t.onchange = () => gsQueueSave(flat, t.checked);
    return t;
}

function gsSelect(flat, options, cur) {
    const sel = document.createElement('select');
    for (const [v, t] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t; sel.append(o);
    }
    sel.value = cur == null ? '' : String(cur);
    sel.onchange = () => {
        // numeric baseline (e.g. idle_timeout_seconds): keep the payload numeric
        let v = sel.value === '' ? null : sel.value;
        if (v !== null && typeof cur === 'number') v = Number(v);
        gsQueueSave(flat, v);
        renderGlobalSettings();       // refresh conditional rows (x-show parity)
    };
    return sel;
}

function gsTitle(t) {
    const h = document.createElement('div');
    // section titles localize via slug key; English literal is fallback
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    h.className = 'gs-title'; h.textContent = C.tf('uplift.gs.title.' + slug, t);
    return h;
}

async function pollGlobalSettings() {
    let d;
    try { d = await GLUE.fetchJson(`${API}/admin/api/global-settings`); }
    catch (err) { GLUE.emptyMsg($('gs-body'), 'global-settings not served (' + err.message + ')'); return; }
    // never clobber queued edits with a background poll; merge server state
    // under the dirty overrides so inputs stay put until SAVE
    if (Object.keys(gsDirty).length) {
        for (const [flat, val] of Object.entries(gsDirty)) {
            const map = GS_MAP[flat];
            if (map && d[map[0]]) d[map[0]][map[1]] = val;
            if (d._shadow) d._shadow[flat] = val;
        }
    }
    GS = d;   // gateway already overlaid the shadow; resave accumulates
    if (!Object.keys(gsDirty).length) GS_ORIG = JSON.parse(JSON.stringify(d));
    syncClusterGate(d);
    renderGlobalSettings();
}

// Classic shows the Cluster tab only while distributed_inference_active;
// same gate here, refreshed from any global-settings GET (and at boot).
function syncClusterGate(gs) {
    const active = !!(gs && gs.server && gs.server.distributed_inference_active);
    const nav = $('nav-cluster');
    if (nav) nav.hidden = !active;
    if (!active && GLUE.currentTab() === 'cluster') location.hash = '#status';
}
async function gateClusterFromServer() {
    try { syncClusterGate(await GLUE.fetchJson(`${API}/admin/api/global-settings`)); }
    catch (_) { /* dormant by default; the settings poll retries */ }
}

// ---------------------------------------------------------------------------
// ENV-2: experimental env tunables — uplift-owned OMLX_* overrides rendered
// as ordinary rows INSIDE the existing settings sections (scheduler/memory ->
// Resource Management, mtp -> Generation Defaults, engine -> Advanced).
// Each row: readable label + EXPERIMENTAL chip, description with [VAR] and
// the honest effect below. Edits queue into the same gsDirty/savebar flow as
// every other setting; gsCommit splits env keys onto PUT /env-overrides and
// the rest onto global-settings. Genuine launch env always wins (shadowed
// rows carry an amber warning; the stored value waits for the launch env to
// change).
// ---------------------------------------------------------------------------

let ENV_SPEC = [];        // allow-list from the server (single source of truth)
let ENV_VALUES = {};      // stored values (server view)
let ENV_SHADOW = {};      // name -> value_masked for genuine launch env

function envByName(flat) {
    return ENV_SPEC.find(a => a.name === flat) || null;
}
function isEnvFlat(flat) {
    return !!envByName(flat);
}

async function pollEnvTunables() {
    try {
        const d = await GLUE.fetchJson(`${API}/uplift/api/env-overrides`);
        ENV_SPEC = d.allowed || [];
        ENV_VALUES = d.values || {};
        ENV_SHADOW = {};
        for (const s of (d.shadowed || [])) ENV_SHADOW[s.name] = s.value_masked;
        // rows appear once the spec lands, even if settings already rendered
        if (GS) renderGlobalSettings();
    } catch (_) { /* endpoint missing (old server): rows simply absent */ }
}

function envRows(...groups) {
    return ENV_SPEC.filter(a => groups.includes(a.group)).map(envRow);
}

function envRow(a) {
    const label = a.label || a.name;
    let hint = a.desc + ' \u2014 [' + a.name + '] \u00b7 ' +
        (a.effect === 'immediate'
            ? C.tf('uplift.env.applies_next_request', 'applies on next request')
            : a.effect === 'model'
                ? C.tf('uplift.env.restart_model', 'RESTART MODEL to apply')
                : C.tf('uplift.env.restart_server', 'RESTART SERVER to apply'));
    if (a.default) hint += ' \u00b7 ' + C.tf('uplift.env.stock_default', 'stock default') + ': ' + a.default;
    if (a.name in ENV_SHADOW) {
        hint += ' \u26a0 ' + C.tf('uplift.env.shadow_warn',
            'environment variable already set — it takes precedence until removed from the launch environment')
            + ' (' + ENV_SHADOW[a.name] + ')';
    }
    const cur = ENV_VALUES[a.name] != null ? ENV_VALUES[a.name] : '';
    let ctl;
    if (a.type === 'bool') {
        ctl = document.createElement('select');
        for (const [v, t] of [['', '\u2014'], ['1', C.tf('uplift.env.on', 'On')],
                               ['0', C.tf('uplift.env.off', 'Off')]]) {
            const o = document.createElement('option');
            o.value = v; o.textContent = t; ctl.append(o);
        }
        ctl.value = cur;
        ctl.onchange = () => gsQueueSave(a.name, ctl.value === '' ? null : ctl.value);
    } else {
        ctl = document.createElement('input');
        ctl.type = (a.type === 'int' || a.type === 'float') ? 'number' : 'text';
        if (a.min !== undefined) ctl.min = a.min;
        if (a.max !== undefined) ctl.max = a.max;
        if (a.type === 'float') ctl.step = 'any';
        if (a.default) ctl.placeholder = a.default;
        ctl.value = cur;
        const queue = () => gsQueueSave(a.name, ctl.value === '' ? null : ctl.value);
        ctl.addEventListener('input', queue);
        ctl.addEventListener('change', queue);
    }
    const row = gsRow('env', label, hint, ctl, { flat: a.name });
    // EXPERIMENTAL signage right of the label, same slot as the restart chip
    const lab = row.querySelector('.uname');
    const chip = document.createElement('span');
    chip.className = 'rqchip env-badge';
    chip.textContent = C.tf('uplift.env.badge', 'EXPERIMENTAL');
    chip.title = C.tf('uplift.env.badge_hint',
        'Uplift-owned environment override; not part of oMLX settings');
    lab.insertBefore(chip, lab.querySelector('small'));
    if (a.name in ENV_SHADOW) row.classList.add('env-shadowed');
    return row;
}

async function envSave(fields) {
    try {
        const r = await GLUE.fetchJson(`${API}/uplift/api/env-overrides`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fields) });
        for (const [name, outcome] of Object.entries(r.results || {})) {
            if (outcome === 'applied_live')
                GLUE.toast(C.tf('uplift.env.applied_live', 'Applied on next request') + ': ' + name, 3000);
            else if (outcome === 'restart_model')
                GLUE.toast(C.tf('uplift.env.stored_restart_model', 'Saved — RESTART MODEL to apply') + ': ' + name, 4000);
            else if (outcome === 'restart_server')
                GLUE.toast(C.tf('uplift.env.stored_restart_server', 'Saved — RESTART SERVER to apply') + ': ' + name, 4000);
            else if (outcome === 'shadowed')
                GLUE.toast(C.tf('uplift.env.shadowed_saved', 'Saved for later — the launch environment variable takes precedence') + ': ' + name, 5000);
        }
        // server-effect vars leave the restart owed: arm the same
        // RESTART SERVER button the classic fields use
        if (Object.values(r.results || {}).includes('restart_server'))
            gsRestartPending = true;
        ENV_VALUES = r.values || {};
        ENV_SHADOW = {};
        for (const s of (r.shadowed || [])) ENV_SHADOW[s.name] = s.value_masked;
        return true;
    } catch (err) {
        GLUE.toast('env tunables: ' + err.message, 5000);
        return false;
    }
}



function renderGlobalSettings() {
    const body = document.createElement('div');   // staged; grouped into boxes below
    body.textContent = '';
    const L = GS_LABELS;

    // (the old "Global" restart-notice box was removed; the RESTART chip,
    //  red field marks and the RESTART SERVER button carry that meaning now)

    // ---- Language
    body.append(gsTitle('Language'));
    body.append(gsRow('ui', C.tf('uplift.gs.ui.interface_language', 'Interface language'), '',
        gsSelect('ui_language', Object.entries(L.lang), gsGet('ui','language')),
        { flat: 'ui_language' }));

    // ---- Claude Code (classic renders this on Status; Uplift keeps it with settings)
    body.append(gsTitle('Claude Code'));
    const ccLocal = (gsGet('claude_code','mode') || 'local') !== 'cloud';
    body.append(gsRow('claude_code', L.cc.mode, L.cc.mode_hint,
        gsSelect('claude_code_mode', [['local', L.cc.local], ['cloud', L.cc.cloud]],
                 ccLocal ? 'local' : 'cloud'), { flat: 'claude_code_mode' }));
    if (ccLocal) {
        const dl = document.createElement('datalist'); dl.id = 'cc-models';
        body.append(dl);
        GLUE.fetchJson(`${API}/admin/api/models`).then(d => {
            for (const m of d.models || []) {
                const o2 = document.createElement('option');
                o2.value = m.name || m.id || ''; dl.append(o2);
            }
        }).catch(() => { /* picker list optional */ });
        body.append(gsRow('claude_code', L.cc.opus, '',
            gsText('claude_code','opus_model','claude_code_opus_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_opus_model' }));
        body.append(gsRow('claude_code', L.cc.sonnet, '',
            gsText('claude_code','sonnet_model','claude_code_sonnet_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_sonnet_model' }));
        body.append(gsRow('claude_code', L.cc.haiku, '',
            gsText('claude_code','haiku_model','claude_code_haiku_model', L,
                   { placeholder: L.cc.ph, list: 'cc-models' }),
            { flat: 'claude_code_haiku_model' }));
    }

    // ---- Auth
    body.append(gsTitle('Auth'));
    body.append(gsRow('auth', L.auth.api_key, L.auth.api_key_hint,
        gsText('auth','api_key','api_key', L, { type: 'password',
            placeholder: L.auth.api_key_placeholder, reload: true }),
        { flat: 'api_key' }));
    const bpIn = document.createElement('input');
    bpIn.type = 'text'; bpIn.value = GS.base_path || '';
    bpIn.disabled = true;
    bpIn.title = C.tf('uplift.ui.set_at_launch_base_path_read_only', 'Set at launch (--base-path); read-only');
    body.append(gsRow('auth', L.auth.base_path, L.auth.base_path_hint, bpIn));
    body.append(gsRow('auth', L.auth.skip, L.auth.skip_hint + ' ' + L.auth.skip_warning,
        gsToggle('skip_api_key_verification', gsGet('auth','skip_api_key_verification')),
        { flat: 'skip_api_key_verification' }));

    // ---- Server
    body.append(gsTitle('Server'));
    body.append(gsRow('server', L.server.host, '',
        gsText('server','host','host', L, { placeholder: L.server.host_placeholder }),
        { badge: true, flat: 'host' }));
    body.append(gsRow('server', L.server.port, '',
        gsText('server','port','port', L, { number: true }), { badge: true, flat: 'port' }));
    body.append(gsRow('server', L.server.log_level, '',
        gsSelect('log_level', L.server.levels, gsGet('server','log_level')),
        { flat: 'log_level' }));
    body.append(gsRow('server', L.server.auto_start, L.server.auto_start_hint,
        gsToggle('auto_start_on_launch', gsGet('server','auto_start_on_launch')),
        { badge: true, flat: 'auto_start_on_launch' }));
    // server_aliases: one alias per line (classic editor keeps a list; same payload)
    const aliasInp = document.createElement('textarea');
    aliasInp.rows = 2; aliasInp.spellcheck = false;
    aliasInp.value = (gsGet('server','server_aliases') || []).join('\n');
    aliasInp.onchange = () => gsQueueSave('server_aliases',
        aliasInp.value.split('\n').map(s => s.trim()).filter(Boolean));
    body.append(gsRow('server', L.server.aliases, L.server.aliases_hint, aliasInp,
        { flat: 'server_aliases' }));

    // ---- Model
    body.append(gsTitle('Model'));
    const dirs = gsGet('model','model_dirs') || [];
    const dl = document.createElement('div');
    dl.className = 'gs-dirs';
    dirs.forEach((d, i) => {
        const one = document.createElement('div');
        one.className = 'gs-dir';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = d;
        inp.placeholder = i === 0 ? L.model.ph_primary : L.model.ph_additional;
        const rm = document.createElement('button');
        rm.className = 'se-btn act'; rm.textContent = '×';
        rm.style.display = dirs.length > 1 ? '' : 'none';
        rm.onclick = async () => {
            const nd = dirs.filter((_, j) => j !== i);
            if (await gsSaveNow({ model_dirs: nd })) renderGlobalSettings();
        };
        inp.onchange = async () => {
            const nd = dirs.slice(); nd[i] = inp.value;
            if (await gsSaveNow({ model_dirs: nd })) renderGlobalSettings();
        };
        one.append(inp, rm);
        dl.append(one);
    });
    const add = document.createElement('button');
    add.className = 'se-btn act'; add.textContent = C.tf('uplift.gs.model.add_directory', '+ add directory');
    add.onclick = async () => {
        if (await gsSaveNow({ model_dirs: dirs.concat('') })) renderGlobalSettings();
    };
    dl.append(add);
    body.append(gsRow('model', L.model.dirs, '', dl));
    body.append(gsRow('model', L.model.fallback, L.model.fallback_desc,
        gsText('model','model_fallback','model_fallback', L),
        { flat: 'model_fallback' }));
    body.append(gsRow('model', L.model.hide_helper, L.model.hide_helper_desc,
        gsToggle('hide_helper_models', gsGet('model','hide_helper_models')),
        { flat: 'hide_helper_models' }));
    body.append(gsRow('model', L.model.hf_cache, L.model.hf_cache_desc,
        gsToggle('hf_cache_enabled', gsGet('huggingface','hf_cache_enabled')),
        { flat: 'hf_cache_enabled' }));
    const hfp = GLUE.cell((GS.huggingface || {}).hf_cache_path || '—');
    hfp.className = 'dim';
    body.append(gsRow('model', C.tf('uplift.gs.model.hf_path_label', 'HF cache path'), '', hfp));
    body.append(gsRow('model', L.model.idle, L.model.idle_desc,
        gsSelect('idle_timeout_seconds', L.model.idle_opts,
                 gsGet('idle_timeout','idle_timeout_seconds') ?? ''),
        { flat: 'idle_timeout_seconds' }));

    // ---- Generation Defaults
    body.append(gsTitle('Generation Defaults'));
    const temp = gsText('sampling','temperature','sampling_temperature', L,
        { range: true, min: 0, max: 2, step: 0.1 });
    body.append(gsRow('gen', L.gen.temperature, L.gen.temperature_hint, temp,
        { flat: 'sampling_temperature' }));
    const topp = gsText('sampling','top_p','sampling_top_p', L,
        { range: true, min: 0, max: 1, step: 0.05 });
    body.append(gsRow('gen', L.gen.top_p, L.gen.top_p_hint, topp,
        { flat: 'sampling_top_p' }));
    body.append(gsRow('gen', L.gen.top_k, L.gen.top_k_hint,
        gsText('sampling','top_k','sampling_top_k', L, { number: true, min: 0 }),
        { flat: 'sampling_top_k' }));
    body.append(gsRow('gen', L.gen.max_tokens, '',
        gsText('sampling','max_tokens','sampling_max_tokens', L,
               { number: true, min: 1, max: 131072 }),
        { flat: 'sampling_max_tokens' }));
    body.append(gsRow('gen', L.gen.max_ctx, L.gen.max_ctx_hint,
        gsText('sampling','max_context_window','sampling_max_context_window', L,
               { number: true, min: 1, max: 2097152 }),
        { flat: 'sampling_max_context_window' }));
    body.append(gsRow('gen', L.gen.max_policy, L.gen.max_policy_hint,
        gsText('sampling','max_context_window_policy',
               'sampling_max_context_window_policy', L,
               { number: true, min: 1, max: 2097152, placeholder: 'None' }),
        { flat: 'sampling_max_context_window_policy' }));
    body.append(gsRow('gen', L.gen.rep_pen, L.gen.rep_pen_hint,
        gsText('sampling','repetition_penalty','sampling_repetition_penalty', L,
               { number: true, min: 1, step: 0.05 }),
        { flat: 'sampling_repetition_penalty' }));
    // ENV-2: MTP experimental tunables join their semantic group
    for (const r of envRows('mtp')) body.append(r);

    // ---- Resource Management
    body.append(gsTitle('Resource Management'));
    body.append(gsRow('res', L.res.max_conc, L.res.max_conc_hint,
        gsText('scheduler','max_concurrent_requests','max_concurrent_requests', L,
               { number: true, min: 1 }),
        // U7: it is in GS_RESTART_FIELDS (the scheduler pool size is read at
        // boot) but only showed a bare "!" — the server routes say so too.
        // Full badge with text, same as host/port.
        { flat: 'max_concurrent_requests', badge: true }));
    body.append(gsRow('res', L.res.batch, L.res.batch_hint,
        gsText('scheduler','embedding_batch_size','embedding_batch_size', L,
               { number: true, min: 1 }),
        { flat: 'embedding_batch_size' }));
    body.append(gsRow('res', L.res.chunked, L.res.chunked_desc,
        gsToggle('chunked_prefill', gsGet('scheduler','chunked_prefill')),
        { flat: 'chunked_prefill' }));
    body.append(gsRow('res', L.res.prio, '',
        gsSelect('prefill_priority', [['speed', L.res.prio_speed],
                                      ['context', L.res.prio_context]],
                 gsGet('scheduler','prefill_priority')),
        { flat: 'prefill_priority' }));
    body.append(gsRow('res', L.res.fairness, L.res.fairness_desc,
        gsToggle('decode_fairness', gsGet('scheduler','decode_fairness')),
        { flat: 'decode_fairness' }));
    body.append(gsRow('res', L.res.guard, L.res.guard_desc,
        gsToggle('memory_prefill_memory_guard', gsGet('memory','prefill_memory_guard')),
        { flat: 'memory_prefill_memory_guard' }));
    const tierSel = gsSelect('memory_guard_tier', L.res.tiers,
                             gsGet('memory','memory_guard_tier'));
    body.append(gsRow('res', L.res.tier, '', tierSel, { flat: 'memory_guard_tier' }));
    if (gsGet('memory','memory_guard_tier') === 'custom') {
        body.append(gsRow('res', L.res.custom, '',
            gsText('memory','memory_guard_custom_ceiling_gb',
                   'memory_guard_custom_ceiling_gb', L,
                   { number: true, min: 1, step: 1, placeholder: L.res.custom_ph }),
            { flat: 'memory_guard_custom_ceiling_gb' }));
    }
    // ENV-2: scheduler/memory experimental tunables join their semantic group
    for (const r of envRows('scheduler', 'memory')) body.append(r);

    // ---- Cache
    body.append(gsTitle('Cache'));
    body.append(gsRow('cache', L.cache.enabled, L.cache.enabled_hint,
        gsToggle('cache_enabled', gsGet('cache','enabled')),
        { flat: 'cache_enabled', badge: true }));
    body.append(gsRow('cache', L.cache.hot_only, L.cache.hot_only_hint,
        gsToggle('hot_cache_only', gsGet('cache','hot_cache_only')),
        { flat: 'hot_cache_only' }));
    body.append(gsRow('cache', L.cache.ssd_dir, '',
        gsText('cache','ssd_cache_dir','ssd_cache_dir', L),
        { flat: 'ssd_cache_dir' }));
    body.append(gsRow('cache', L.cache.ssd_max, L.cache.ssd_max_hint,
        gsText('cache','ssd_cache_max_size','ssd_cache_max_size', L,
               { placeholder: '64GB' }),
        { flat: 'ssd_cache_max_size' }));
    body.append(gsRow('cache', L.cache.hot_max, L.cache.hot_max_hint,
        gsText('cache','hot_cache_max_size','hot_cache_max_size', L,
               { placeholder: '8GB' }),
        { flat: 'hot_cache_max_size' }));

    // ---- MCP
    body.append(gsTitle('MCP'));
    body.append(gsRow('mcp', L.mcp.path, '',
        gsText('mcp','config_path','mcp_config', L, { placeholder: L.mcp.ph }),
        { badge: true, flat: 'mcp_config' }));
    body.append(gsRow('mcp', L.mcp.expose, L.mcp.expose_hint,
        gsToggle('mcp_expose_tools', gsGet('mcp','expose_tools')),
        { flat: 'mcp_expose_tools' }));

    // ---- Usage & Network
    body.append(gsTitle('Usage & Network'));
    body.append(gsRow('usage', L.usage.history, L.usage.history_hint,
        gsToggle('usage_history', gsGet('usage','usage_history')),
        { flat: 'usage_history' }));
    body.append(gsRow('net', L.net.hf_ep, L.net.hf_ep_hint,
        gsText('huggingface','endpoint','hf_endpoint', L,
               { placeholder: 'https://huggingface.co' }),
        { flat: 'hf_endpoint', badge: true }));
    body.append(gsRow('net', L.net.ms_ep, L.net.ms_ep_hint,
        gsText('modelscope','endpoint','ms_endpoint', L,
               { placeholder: 'https://www.modelscope.cn' }),
        { flat: 'ms_endpoint', badge: true }));
    body.append(gsRow('net', L.net.http_proxy, L.net.proxy_hint,
        gsText('network','http_proxy','network_http_proxy', L),
        { flat: 'network_http_proxy' }));
    body.append(gsRow('net', L.net.https_proxy, L.net.proxy_hint,
        gsText('network','https_proxy','network_https_proxy', L),
        { flat: 'network_https_proxy' }));
    body.append(gsRow('net', L.net.no_proxy, L.net.no_proxy_hint,
        gsText('network','no_proxy','network_no_proxy', L),
        { flat: 'network_no_proxy' }));
    body.append(gsRow('net', L.net.ca_bundle, L.net.ca_hint,
        gsText('network','ca_bundle','network_ca_bundle', L),
        { flat: 'network_ca_bundle', badge: true }));

    // ---- Advanced
    body.append(gsTitle('Advanced'));
    body.append(gsRow('adv', L.adv.distributed_enabled, L.adv.distributed_hint,
        gsToggle('distributed_inference_enabled',
                 gsGet('server','distributed_inference_enabled')),
        { flat: 'distributed_inference_enabled', badge: true }));
    body.append(gsRow('adv', L.adv.burst, L.adv.burst_hint,
        gsSelect('burst_decode_mode', L.adv.burst_opts,
                 gsGet('server','burst_decode_mode')),
        { flat: 'burst_decode_mode' }));
    body.append(gsRow('adv', L.adv.sse, L.adv.sse_hint,
        gsSelect('sse_keepalive_mode', L.adv.sse_opts,
                 gsGet('server','sse_keepalive_mode')),
        { flat: 'sse_keepalive_mode' }));
    body.append(gsRow('adv', L.adv.mid_sys, L.adv.mid_sys_hint,
        gsToggle('preserve_mid_system_cache', gsGet('server','preserve_mid_system_cache')),
        { flat: 'preserve_mid_system_cache' }));
    body.append(gsRow('adv', L.adv.wide_proj, L.adv.wide_proj_hint,
        gsToggle('qwen4_gdn_decode_wide_proj', gsGet('server','qwen4_gdn_decode_wide_proj')),
        { flat: 'qwen4_gdn_decode_wide_proj' }));
    body.append(gsRow('adv', L.adv.audio, L.adv.audio_hint,
        gsText('server','max_audio_upload_size','max_audio_upload_size', L,
               { number: true, min: 1 }),
        { flat: 'max_audio_upload_size' }));
    body.append(gsRow('adv', L.adv.ane, L.adv.ane_hint,
        gsToggle('ane_compile_cache', gsGet('cache','ane_compile_cache')),
        { flat: 'ane_compile_cache' }));
    body.append(gsRow('adv', L.adv.wt, L.adv.wt_hint,
        gsToggle('hot_cache_write_through', gsGet('cache','hot_cache_write_through')),
        { flat: 'hot_cache_write_through' }));
    body.append(gsRow('adv', L.adv.blocks, L.adv.blocks_hint,
        gsText('cache','initial_cache_blocks','initial_cache_blocks', L,
               { number: true, min: 1 }),
        { flat: 'initial_cache_blocks' }));
    const gsel = gsSelect('gdn_snapshot_storage', L.adv.gdn_store_opts,
                          gsGet('cache','gdn_snapshot_storage'));
    body.append(gsRow('adv', L.adv.gdn_store, L.adv.gdn_store_hint, gsel,
        { flat: 'gdn_snapshot_storage' }));
    if (gsGet('cache','gdn_snapshot_storage') === 'ssd_sidecar') {
        body.append(gsRow('adv', L.adv.gdn_pend, L.adv.gdn_pend_hint,
            gsText('cache','gdn_ssd_pending_max_size','gdn_ssd_pending_max_size', L,
                   { placeholder: '512MB' }),
            { flat: 'gdn_ssd_pending_max_size' }));
        const prow = gsRow('adv', L.adv.gdn_prec, L.adv.gdn_prec_hint,
            gsSelect('gdn_sidecar_precision', L.adv.gdn_prec_opts,
                     gsGet('cache','gdn_sidecar_precision')),
            { flat: 'gdn_sidecar_precision' });
        if (['int8','rht_int8'].includes(gsGet('cache','gdn_sidecar_precision'))) {
            const w = document.createElement('small');
            w.className = 'fhint warn'; w.textContent = L.adv.gdn_prec_warning;
            prow.querySelector('.uname').append(w);
        }
        body.append(prow);
    }
    // ENV-2: engine experimental tunables join Advanced (burst / batching)
    for (const r of envRows('engine')) body.append(r);

    // group staged children into bordered section boxes; each gs-title
    // starts a new box. U5 fix (user round): the old CSS multicol
    // (column-width masonry) tore tall boxes apart — the fragment landed at
    // the top of the next column and pushed its boxes down (staggered column
    // tops that looked like a leftover banner). Boxes are now distributed by
    // JS into equal flex columns: balanced fill order is preserved (same
    // reading flow as column-fill:balance) but every column starts flush and
    // a box is never split.
    const wrap = $('gs-body');
    const wasDirty = Object.assign({}, gsDirty);
    wrap.textContent = '';
    wrap.classList.add('gs-wrap');
    const items = [];   // gs-boxes (and stray nodes) in document order
    let box = null, bbody = null, ord = 0;
    for (const n of Array.from(body.childNodes)) {
        if (n.nodeType === 1 && n.classList.contains('gs-title')) {
            box = document.createElement('div');
            box.className = 'gs-box';
            box.dataset.ord = ord++;   // stable order for resize re-layout
            const h = document.createElement('div');
            h.className = 'gs-box-title';
            h.textContent = n.textContent;
            bbody = document.createElement('div');
            bbody.className = 'gs-box-body';
            box.append(h, bbody);
            items.push(box);
        } else if (bbody) {
            bbody.append(n);
        } else {
            items.push(n);
        }
    }
    // column layout: JS-distributed flex columns (U5 fix — see above).
    gsLayoutColumns(items);
    // section header click scrolls to the SAVE bar (item 10); header also
    // carries the section dirty/restart state color (item 8)
    for (const h of wrap.querySelectorAll('.gs-box-title')) {
        h.classList.add('clickable');
        h.onclick = () => {
            const bar = document.getElementById('gs-savebar');
            if (bar) { bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                       const b = gsSaveBtn(); if (b) b.focus(); }
        };
    }
    // persistent SAVE / RESTART SERVER bar below the form (item 9/10)
    let bar = document.getElementById('gs-savebar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gs-savebar';
        bar.className = 'savebar';
        const changes = document.createElement('div');
        changes.id = 'gs-changes'; changes.className = 'changelist'; changes.hidden = true;
        const rowb = document.createElement('div'); rowb.className = 'savebar-row';
        const b = document.createElement('button');
        b.id = 'gs-save'; b.className = 'se-btn savebtn'; b.textContent = 'SAVE';
        b.onclick = gsSaveOrRestart;
        const clr = document.createElement('button');
        clr.id = 'gs-discard'; clr.className = 'se-btn'; clr.textContent = 'DISCARD';
        clr.onclick = () => {
            Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
            renderGlobalSettings(); gsUpdateSaveBtn(); renderDirtyList();
        };
        rowb.append(clr, b);
        bar.append(changes, rowb);
        wrap.parentElement.append(bar);
    }
    // re-apply still-queued dirty marks after re-render
    for (const flat of Object.keys(wasDirty)) {
        markFieldDirty(flat, wasDirty[flat]);
        // re-render rebuilds inputs from the server baseline; put the
        // queued (unsaved) value back so the edit stays visible while typing
        const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
        const ctl = row && (row.querySelector('input[type=checkbox]') || row.querySelector('select') || row.querySelector('input'));
        if (ctl) {
            if (ctl.type === 'checkbox') ctl.checked = !!wasDirty[flat];
            else ctl.value = wasDirty[flat] == null ? '' : wasDirty[flat];
        }
    }
    gsMarkSections();
    gsUpdateSaveBtn();
    renderDirtyList();
    const clrB = document.getElementById('gs-discard');
    if (clrB) clrB.style.display = Object.keys(gsDirty).length ? '' : 'none';
}

function gsLayoutColumns(forced) {
    // U5 fix: distribute section boxes into equal-width flex columns.
    // Balanced sequential fill reproduces the old column-fill:balance reading
    // order, but boxes never split and every column top is flush.
    const wrap = document.getElementById('gs-body');
    if (!wrap) return;
    let items = (forced && forced.length) ? forced.slice()
        : [...wrap.querySelectorAll('.gs-box')].sort((a, b) => (a.dataset.ord | 0) - (b.dataset.ord | 0));
    if (!items.length) return;
    // alternate box shading by GLOBAL index (nth-of-type restarts per column)
    items.forEach((it, i) => it.classList.toggle('alt', i % 2 === 1));
    for (const c of wrap.querySelectorAll('.gs-col')) c.remove();
    const gap = 14, cw = 380;
    const avail = wrap.clientWidth || (document.documentElement.clientWidth - 48);
    let nCols = Math.max(1, Math.floor((avail + gap) / (cw + gap)));
    nCols = Math.min(nCols, items.length);
    const colW = Math.floor((Math.min(avail, 1500) - gap * (nCols - 1)) / nCols);
    const cols = [];
    for (let i = 0; i < nCols; i++) {
        const d = document.createElement('div');
        d.className = 'gs-col'; d.style.width = colW + 'px';
        cols.push(d);
    }
    wrap.append(...cols);
    // measure pass: all boxes in col 0 — every column has the same width so
    // heights measured here are the heights they'll have in their final column
    for (const it of items) cols[0].append(it);
    const hs = items.map(it => it.offsetHeight + gap);
    const target = hs.reduce((a, b) => a + b, 0) / nCols;
    let ci = 0, acc = 0;
    for (let i = 0; i < items.length; i++) {
        cols[ci].append(items[i]);
        acc += hs[i];
        if (acc >= target && ci < nCols - 1 && i < items.length - (nCols - 1 - ci)) { ci++; acc = 0; }
    }
    if (!window.__gsResizeHooked) {
        window.__gsResizeHooked = true;
        let t = 0;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                if (document.querySelector('#gs-body.gs-wrap .gs-col')) gsLayoutColumns();
            }, 150);
        });
    }
}

window.Uplift = window.Uplift || {};
window.Uplift.gsys = {
    gsLocalize, gsDisplay, SECRET_KEYS,
    pollGlobalSettings, pollEnvTunables, gateClusterFromServer,
};
})();
