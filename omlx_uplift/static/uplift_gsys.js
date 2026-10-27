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
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const UDirty = window.UpliftDirty;   // FE-4 shared dirty/CHANGES machine
const GLUE = {
    toast: D.toast,
    fetchJson: D.fetchJson,
    postJson: D.postJson,
    emptyMsg: D.emptyMsg,
    get loadLocale() { return window.Uplift._gsysGlue.loadLocale; },
    get currentTab() { return window.Uplift._gsysGlue.currentTab; },
    cell: D.cell,
    get GW_LIVE() { return window.Uplift._gsysGlue.GW_LIVE; },
};
/* ---------------- settings (Settings tab: read-only server preview) ------ */
/* ---- Server settings: editable form mirroring the classic Settings page.
   Same 11 sections, same fields, labels, hints and conditional visibility
   (i18n strings copied from the original catalog); restart badges follow the
   runtime truth instead — see GS_RESTART_FIELDS. Saves replicate classic
   saveGlobalSettings(): full flat payload POSTed to global-settings. */
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
        skip_warning: 'Anyone on the network can call this server.',
        // SYNC-1 keyless-inference row (classic settings.auth.keyless_inference*):
        // GS_LABELS is the label source for the spec rows — a missing entry
        // renders a labelless row AND turns the enable-confirmation into a
        // silent no-op (gsToggle skips empty confirmMsg).
        keyless: 'Allow inference without API key',
        keyless_hint: 'Anyone who can reach this server can use inference, MCP tools, and web search without a key. Admin still requires authentication.',
        keyless_confirm: 'Anyone who can reach this server will be able to use inference APIs, MCP tools, and web search without an API key.\n\nBy turning this on, you acknowledge that the server will be exposed to attacks from the network, that you understand you are removing this security protection, and that you have put appropriate security measures in place.\n\nSelect OK only if you understand and accept this.' },
    server: { host: 'Host', host_placeholder: '127.0.0.1',
        port: 'Port', log_level: 'Log level',
        auto_start: 'Start on Login', auto_start_hint: 'Launch oMLX automatically when this Mac signs in.',
        aliases: 'Server Aliases',
        aliases_hint: 'Names this server answers to, separated by spaces or new lines.',
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
        custom: 'Custom Ceiling (GiB)',
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
        hot_max_hint: '"0" disables, example: 8GiB.',
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
        // SYNC-1 (3c39990): no global row uses these two anymore — the toggle
        // moved to the per-model editor, which reuses the SAME locale keys
        // (uplift.gs.adv.wide_proj[_hint]) via C.tf. Kept as the English
        // fallback pair; the locale files are owned elsewhere.
        wide_proj: 'Qwen4 Wide-Proj GDN Decode',
        wide_proj_hint: 'Wider projection in fused Qwen4 GDN decode (experimental).',
        keep_warm: 'GPU Keep-Warm Interval (s)',
        keep_warm_hint: 'Seconds between trivial GPU kernels while a model is loaded but idle, keeping the GPU out of its idle power state (the first command buffer after an idle stall can take seconds on large models). Ticks stop after 5 minutes without requests; 0 disables.',
        audio: 'Maximum Audio Upload Size (MB)',
        audio_hint: 'Reject audio attachments above this size.',
        ane: 'ANE Compile Cache',
        ane_hint: 'Cache CoreML compiled graphs on the Neural Engine.',
        wt: 'Hot Cache Write-Through',
        wt_hint: 'Write hot blocks to SSD immediately.',
        blocks: 'Initial Cache Blocks',
        blocks_hint: 'KV blocks allocated at startup.',
        gdn_store: 'Snapshot Storage',
        gdn_store_hint: 'Auto uses separate SSD files when SSD cache is enabled; otherwise it stores snapshots with the KV cache. With KV Cache follows the same RAM or SSD tier as KV blocks. Enable Hot Cache Only to keep it in RAM.',
        gdn_store_opts: [['auto','Auto (recommended)'],['ssd_sidecar','Dedicated SSD Sidecar'],
                         ['embedded','With KV Cache']],
        gdn_pend: 'SSD Write Buffer',
        gdn_pend_hint: 'Maximum RAM used by encoded snapshots waiting to be written to SSD. When the buffer is full, cache writes pause until space is available.',
        gdn_prec: 'SSD Snapshot Precision',
        gdn_prec_hint: 'Controls GDN state stored in SSD sidecars only. FP32 is the exact default. Reduced-precision modes use less space but introduce reconstruction error. Restored state always runs in FP32.',
        gdn_prec_opts: [['fp32','FP32 (exact, recommended)'],['rht_int16','RHT + int16'],
                        ['bf16','BF16'],['int8','Int8 (row-wise)'],
                        ['rht_int8','RHT + int8 (row-wise)']],
        gdn_prec_warning: 'Reduced-precision GDN cache storage can change greedy outputs, break bit-level reproducibility, and reduce output quality. Use FP32 unless you explicitly accept this trade-off.' },
    badge: 'RESTART REQUIRED',
    restart_notice: 'Host and port changes take effect after a restart.',
};

// shadow key -> nested [section, field] map (mirrors GlobalSettingsRequest)
/* TST-1: the payload contract lives in uplift_gspec.js (UMD); aliased so
   the save/queue code keeps the bare names. */
const GS_MAP = window.UpliftGSpec.GS_MAP;
const GS_PAYLOAD_SKIP = window.UpliftGSpec.GS_PAYLOAD_SKIP;
let GS = null;   // merged working copy (upstream + shadow)
/* Dirty tracking for the deferred-SAVE flow: GS_ORIG is the snapshot at page
   load / last save; gsDirty holds queued-but-unsaved flat->value edits.
   Fields whose change only takes effect after a server restart are flagged
   red (!) and force the sticky SAVE button into RESTART SERVER once the
   queue is saved. This set follows the RUNTIME TRUTH (upstream
   runtime_applied + the live-apply bodies in update_global_settings),
   deliberately NOT classic's template badges — the two disagree, see
   tracker UP-6. Dropped here as live-applied: cache_enabled (the cache
   save hot-swaps the pool config and reloads ENGINES, not the server),
   auto_start_on_launch (persist only; the mac app owns the login item),
   hf_endpoint / ms_endpoint / network_ca_bundle (env rewritten on save,
   per-call download clients re-read it). max_concurrent_requests is a
   conditional: upstream 024ead20 (#3765) live-applies it; the badge rides
   distributed_inference_active only (cluster ranks own their schedulers
   and pick the limit up on reload). */
let GS_ORIG = {};
const gsDirty = {};
let gsRestartPending = false;   // queued edits were saved; server restart still owed
let gsForceArmed = false;       // detection said "no supervisor"; next click = FORCE
const GS_RESTART_FIELDS = new Set([
    'host', 'port',
    'max_concurrent_requests',   // conditional — gsRestartField()
    'mcp_config', 'distributed_inference_enabled']);
// SYNC-1: classic-parity restart semantics for one conditional member.
function gsDistributedActive() {
    return !!(GS && GS.server && GS.server.distributed_inference_active);
}
function gsRestartField(flat) {
    if (!GS_RESTART_FIELDS.has(flat)) return false;
    if (flat === 'max_concurrent_requests') return gsDistributedActive();
    return true;
}
function gsQueueSave(flat, val) {           // edit -> queue, no fetch yet
    // FE-6 step 3: the row marks itself dirty IN PLACE (markFieldDirty).
    // The dead custom_model_prefixes re-render (no such field exists) is
    // gone; the keystroke re-render that stole focus died with `reload`.
    markFieldDirty(flat, val);
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
/* FE-4: dirty marking + row visuals come from uplift_dirty.js (shared with
   the model editor); gsDirty stays the payload map the save path reads. */
function markFieldDirty(flat, val) {
    const orig = gsOrigFlat(flat);
    const cur = val === undefined ? gsValFlat(flat) : val;
    const changed = UDirty.applyRowState({
        orig, cur,
        row: document.querySelector('#gs-body [data-flat="' + flat + '"]'),
        isSecret: SECRET_KEYS.has(flat),
        isRestart: gsRestartField(flat),
        display: gsDisplay });
    if (changed) gsDirty[flat] = cur;
    else delete gsDirty[flat];               // edited back = no longer queued
    if (flat === 'cache_enabled' || flat === 'hot_cache_only'
        || flat === 'gdn_snapshot_storage'
        || flat === 'host')                    // UP-19 (7): skip row follows the bind
        gsDisabledSync();                    // SSD rows follow the effective mode
    gsGuardSync();                           // UP-41(10): tier/ceiling edits refresh live
    gsUpdateSaveBtn();
    gsMarkSections();
    renderDirtyList();
}
function revertField(flat) {                // click on |original| chip
    delete gsDirty[flat];
    // FE-6 step 3: put the current baseline value back into THIS row only —
    // the full-page rebuild lost scroll position and other in-progress
    // edits. gsValFlat mirrors what v1's rebuild rendered (shadow overlay
    // wins, same as gsGet), then the row's dirty marks are recomputed.
    gsSetControlValue(flat, gsValFlat(flat));
    markFieldDirty(flat, gsValFlat(flat));
    gsDisabledSync();                        // reverted cache toggles restore SSD rows
    gsUpdateSaveBtn();
    gsMarkSections();
    renderDirtyList();
}
function gsSetControlValue(flat, val) {
    const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
    // UP-41 composite rows (host preset, cache sliders) own their controls:
    // one repaint call beats picking a first-input child that only shows
    // part of the state.
    if (row && row.__gsApply) { row.__gsApply(val); return true; }
    const ctl = row && (row.querySelector('input[type=checkbox]') || row.querySelector('select')
        || row.querySelector('textarea') || row.querySelector('input'));
    if (!ctl) return false;
    if (ctl.type === 'checkbox') ctl.checked = !!val;
    else ctl.value = val == null ? '' : val;
    return true;
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
    gsTabBadges();   // GS-TAB: same dirty truth feeds the section tabs
}
function renderDirtyList() {
    UDirty.renderChangesBox(
        document.getElementById('gs-changes'),
        Object.keys(gsDirty).map(k => ({
            key: k, orig: gsOrigFlat(k), cur: gsDirty[k],
            isSecret: SECRET_KEYS.has(k), display: gsDisplay })),
        C.tf);
}
function gsSaveBtn() { return document.getElementById('gs-save'); }
function gsUpdateSaveBtn() {
    const b = gsSaveBtn(); if (!b) return;
    const n = Object.keys(gsDirty).length;
    const restartQ = gsRestartPending ||
        Object.keys(gsDirty).some(k => gsRestartField(k));
    b.classList.toggle('queued', n > 0);
    // the red RESTART state only arms after a save that left a restart owed;
    // while edits are merely queued the button stays amber SAVE (user's flow:
    // click SAVE -> saved -> button becomes RESTART SERVER). A detection miss
    // on the restart attempt escalates to the orange FORCE RESTART state.
    b.classList.toggle('restart-mode', gsRestartPending && !gsForceArmed);
    b.classList.toggle('force-mode', gsForceArmed);
    b.textContent = n
        ? (restartQ ? '▶ SAVE + RESTART (' + n + ')' : 'SAVE (' + n + ')')
        : (gsForceArmed ? '⚠ FORCE RESTART'
           : (gsRestartPending ? '▶ RESTART SERVER' : 'SAVE'));
    b.title = n ? (restartQ
        ? 'Some queued changes need a server restart to take effect. First click saves; the button then becomes RESTART SERVER.'
        : 'Apply ' + n + ' queued change' + (n > 1 ? 's' : ''))
        : (gsForceArmed
            ? 'No supervisor was detected — this shuts omlx down and relies on your watchdog (launchd/menubar) to bring it back.'
            : 'No queued changes');
}
let gsSaving = false;      // UP-19 (5): one save in flight; classic disables SAVE
async function gsCommit() {
    if (gsSaving) return;
    const fields = Object.assign({}, gsDirty);
    // env tunables ride a different endpoint; classic fields keep the
    // full-payload global-settings save (P1A-6 semantics unchanged)
    const envFields = {}, classicFields = {};
    for (const [k, v] of Object.entries(fields))
        (isEnvFlat(k) ? envFields : classicFields)[k] = v;
    // UP-19 (2): classic validates BEFORE posting (required-fields block,
    // dashboard.js:1376-1418). next(flat) reads the value the save sends.
    const next = f => (f in gsDirty) ? gsDirty[f] : gsValFlat(f);
    const label = f => f === 'model_dirs'
        ? C.tf('js.error.model_directory', 'model directory')
        : f === 'gdn_hot_conflict'
        ? C.tf('js.error.gdn_sidecar_hot_cache_conflict',
               'GDN sidecar storage cannot be combined with hot-cache-only mode')
        : C.tf('settings.' + f.replace(/_/g, '.'), f);
    const req = window.UpliftGSpec.requiredFieldsError(next, label);
    const errs = [];
    if (req) errs.push(C.tf('js.error.required_fields', 'Please fill in: {fields}')
        .replace('{fields}', req.joined));
    // UP-19 (7): non-loopback bind forces key verification OFF the table and
    // requires a key — classic mutates then refuses (auth lockout guard).
    if (!window.UpliftGSpec.isLoopbackBindHost(next('host') || '')) {
        classicFields.skip_api_key_verification = false;   // classic forces it
        delete gsDirty.skip_api_key_verification;
        if (!next('api_key') && !(GS.auth && GS.auth.api_key_set))
            errs.push(C.tf('js.error.api_key_required_network',
                'An API key is required when the server is reachable beyond localhost.'));
    }
    const key = next('api_key');
    if (key) {
        if (String(key).length < 4) errs.push(C.tf('js.error.api_key_min_length',
            'API key must be at least 4 characters.'));
        if (/\s/.test(String(key))) errs.push(C.tf('js.error.api_key_no_whitespace',
            'API key must not contain whitespace.'));
    }
    if (errs.length) {
        errs.forEach(e => GLUE.toast(e, 'error'));
        const sub = $('gs-sub'); if (sub) sub.textContent = errs[0];
        return;
    }
    gsSaving = true;
    const sb = gsSaveBtn(); if (sb) sb.disabled = true;
    let okAll = true;
    try {
        if (Object.keys(classicFields).length) okAll = await gsSaveNow(classicFields);
        if (okAll && Object.keys(envFields).length) okAll = await envSave(envFields);
    } finally {
        gsSaving = false;
        if (sb) sb.disabled = false;
    }
    if (okAll) {
        Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
        // a save that touched restart-requiring fields leaves the server
        // owing a restart: arm the red RESTART SERVER button (user flow)
        if (Object.keys(fields).some(k => gsRestartField(k))) gsRestartPending = true;
        try { sessionStorage.setItem('uplift.gs.restartPending',
            gsRestartPending ? '1' : ''); } catch (_) {}   // UP-19 (4)
    }
    // re-render inputs from the new baseline; keeps still-queued edits shown
    renderGlobalSettings();
    gsUpdateSaveBtn();
    renderDirtyList();
}
async function gsRestartServer(forced) {
    const b = gsSaveBtn(); if (!b) return;
    // UP-19 (4): classic confirms before killing the server
    // (restart_confirm) — a running chat/bench dies with it.
    if (!window.confirm(C.tf('settings.server.restart_confirm',
            'Restart the oMLX server? Running requests and benchmarks will be interrupted.')))
        return;
    b.disabled = true;
    try {
        // uplift's own endpoint (not vanilla's /server/restart, which only
        // knows the menubar): detects launchd/brew-services/menubar, and
        // on a detection MISS re-arms the button as FORCE RESTART (3rd
        // click) which shuts the server down regardless.
        const d = await GLUE.postJson(`${API}/uplift/api/restart-server`,
            {force: !!forced});
        if (d.ok === false && !d.supervised) {
            gsForceArmed = true;
            GLUE.toast(C.tf('uplift.toast.restart_no_supervisor',
                'No supervisor detected — press FORCE RESTART if something else respawns omlx.'), 6000);
        } else {
            gsRestartPending = false;   // restart requested; button goes back to SAVE
            gsForceArmed = false;
            try { sessionStorage.setItem('uplift.gs.restartPending', ''); } catch (_) {}
            GLUE.toast(C.tf('uplift.toast.restart_requested', 'Restart requested — server respawns in ~5 s'));
            // UP-19 (4): classic polls /health down-then-up before declaring
            // success, so a slow supervisor cannot fake an instant OK.
            gsRestartWatch();
        }
        $('banner').classList.add('show');
        $('banner-text').textContent = C.tf('uplift.ui.server_restarting_dashboard_reconnecting', 'Server restarting — dashboard reconnecting…');
    } catch (e) {
        gsForceArmed = !!forced;   // a failed FORCE stays armed for retry; a failed plain restart falls back to RESTART SERVER
        GLUE.toast(C.t('uplift.toast.restart_failed', {msg: D.errText(e)}));
    }
    b.disabled = false;
    gsUpdateSaveBtn();
}
function gsRestartWatch() {
    const deadline = Date.now() + 60000;    // classic's 60 s ceiling
    let sawDownAt = 0;
    const tick = async () => {
        if (Date.now() > deadline) {
            const bn = $('banner');
            if (bn) bn.classList.add('show');
            const bt = $('banner-text');
            if (bt) bt.textContent = C.tf('settings.server.restart_status_timeout',
                'Restart timed out — check the server process.');
            return;
        }
        let alive = false;
        try {
            // domkit-exempt: unauthenticated liveness probe, no kit error mapping
            alive = (await fetch('/health', { cache: 'no-store' })).ok; // domkit-exempt
        }
        catch (_) { alive = false; }
        if (!alive) {
            if (!sawDownAt) sawDownAt = Date.now();
            setTimeout(tick, 1000);
            return;
        }
        // classic requires down-then-up; if the supervisor was fast we may
        // never catch the down — after 3 consecutive alives past 5 s, call
        // it done rather than hang for the full deadline.
        if (!sawDownAt && Date.now() - started < 5000) { setTimeout(tick, 800); return; }
        if (sawDownAt && Date.now() - sawDownAt < 1500) { setTimeout(tick, 800); return; }
        const bn = $('banner');
        if (bn) bn.classList.remove('show');
        gsRestartPending = false;
        try { sessionStorage.setItem('uplift.gs.restartPending', ''); } catch (_) {}
        pollGlobalSettings();
        gsUpdateSaveBtn();
    };
    const started = Date.now();
    setTimeout(tick, 1200);
}
function gsSaveOrRestart() {                 // one button, three states
    const b = gsSaveBtn(); if (!b) return;
    if (gsForceArmed) {
        if (Object.keys(gsDirty).length) { gsCommit().then(gsUpdateSaveBtn); return; }
        gsRestartServer(true); return;
    }
    if (b.classList.contains('restart-mode')) {
        if (Object.keys(gsDirty).length) { gsCommit().then(gsUpdateSaveBtn); return; }
        gsRestartServer(false);
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
        try {
            await GLUE.postJson(`${API}/admin/api/global-settings`, body);
        } catch (e) {
            // UP-19 (1): FE-2 used to swallow the body here ('save failed:
            // HTTP 422'); domkit's kitError already flattens the server's
            // detail into the text we show — render it through D.errText, like
            // the model editor does.
            if (e.status) { GLUE.toast(D.errText(e)
                || C.t('uplift.toast.save_failed_http', {status: e.status}), 'error');
                return false; }
            throw e;
        }
        GS._shadow = body;
        // ACHIEVEMENTS: this save committed; judge what changed against the
        // PRE-save baseline (GS_ORIG is about to move). flat -> section.field
        // read so old values come from the same nested map GS_MAP describes.
        try {
            const AC = window.Uplift && window.Uplift.achv;
            if (AC) {
                const oldFlat = {};
                for (const k of Object.keys(fields)) {
                    const map = GS_MAP[k]; if (!map) continue;
                    const sec = (GS_ORIG || {})[map[0]];
                    if (sec && map[1] in sec) oldFlat[k] = sec[map[1]];
                }
                AC.announce(AC.settingsReaction(oldFlat, fields));
            }
        } catch (_) { /* a verdict must never break the save */ }
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
    } catch (err) { GLUE.toast(C.t('uplift.toast.save_failed', {msg: D.errText(err)})); return false; }
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
    // SYNC-1: `badge` may be a predicate — classic x-shows the conditional
    // restart chips (max concurrent requests: only while cluster engines
    // run). renderGlobalSettings re-runs on every poll/save, so the
    // predicate is evaluated fresh, same as Alpine.
    if (opts.badge && (typeof opts.badge !== 'function' || opts.badge())) lab.append(gsBadge());
    else if (opts.flat && gsRestartField(opts.flat)) {
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
    // ...except checkboxes: an unchecked box reads as NOTHING, so the user
    // saw 'true → ⍰' on every toggle. Give checkbox rows an explicit
    // new-value chip (filled by UpliftDirty.applyRowState via .diff-n).
    if (control && control.type === 'checkbox') {
        const n = document.createElement('span'); n.className = 'diff-n';
        rd.append(n);
    }
    slot.append(rd);
    const ctl = GLUE.cell(''); ctl.className = 'gctl';
    ctl.append(control);
    row.append(lab, slot, ctl);
    return row;
}

function gsText(sec, field, flat, L, extra) {
    /* FE-6 step 1: the control shape comes from uplift_widgets.js (shared
       with the model editor); the queueing rules below are unchanged. */
    extra = extra || {};
    const v = gsGet(sec, field);
    if (extra.range) {
        // R10-1: the old readout span duplicated the value in a second
        // bordered box that looked like another input. The control itself
        // shows the value; a number input gives the native stepper instead.
        const inp = window.UpliftWidgets.build('range', { value: v, min: extra.min,
            max: extra.max, step: extra.step, placeholder: extra.placeholder }).el;
        const queueRange = () => gsQueueSave(flat, inp.value === '' ? null : Number(inp.value));
        inp.oninput = queueRange;
        inp.onchange = queueRange;
        return inp;
    }
    // v1 DOM truth: a gsys 'number' field WAS a text input — but only
    // because k:'text' rows like ssd_cache_max_size legitimately hold
    // '64GB'-shaped values. UP-19 (3): rows the spec declares k:'num' get
    // REAL number inputs so their min/max/step actually bind (classic does).
    const kind = extra.bool ? 'bool' : extra.number ? 'number' : 'text';
    const inp = window.UpliftWidgets.build(kind, {
        value: v, checked: !!v, type: extra.type, placeholder: extra.placeholder,
        min: kind === 'number' ? extra.min : undefined,
        max: kind === 'number' ? extra.max : undefined,
        step: kind === 'number' ? (extra.step !== undefined ? extra.step : 1) : undefined,
    }).el;
    // v1 set these unconditionally (inert on a text input, real on range)
    if (extra.min !== undefined) inp.min = extra.min;
    if (extra.max !== undefined) inp.max = extra.max;
    if (extra.step !== undefined) inp.step = extra.step;
    if (extra.list) inp.setAttribute('list', extra.list);
    const queue = (ev) => {
        let val = inp.value;
        if (extra.number) val = val === '' ? null : Number(val);
        if (extra.bool) val = inp.checked;
        gsQueueSave(flat, val);
        // FE-6 step 3: the old `reload` escape hatch rebuilt the WHOLE page
        // on commit (api_key). No conditional row reads api_key; the focus
        // bug class this workaround papered over cannot be re-introduced.
    };
    inp.addEventListener('input', queue);
    inp.addEventListener('change', queue);
    return inp;
}   // (gsText)

function gsToggle(flat, on, confirmMsg) {
    // SYNC-1 (upstream 1c3adf2): destructive toggles carry a classic-style
    // confirmation on the OFF->ON edge only; turning off is never blocked.
    const t = window.UpliftWidgets.build('bool', { checked: on }).el;
    t.onchange = () => {
        if (confirmMsg && t.checked && !window.confirm(confirmMsg)) { t.checked = false; return; }
        gsQueueSave(flat, t.checked);
    };
    return t;
}

function gsSelect(flat, options, cur) {
    // FE-6: shape via the registry; gsys does not localize option labels
    const sel = window.UpliftWidgets.build('select', {
        selected: cur,
        options: options.map(([v, t]) => ({ value: v, text: t })),
    }).el;
    sel.value = cur == null ? '' : String(cur);
    sel.onchange = () => {
        // numeric baseline (e.g. idle_timeout_seconds): keep the payload numeric
        let v = sel.value === '' ? null : sel.value;
        if (v !== null && typeof cur === 'number') v = Number(v);
        gsQueueSave(flat, v);
        // UP-19 (9): language and idle-timeout commit live, classic-style
        // (no SAVE round-trip); everything else stays queue-based.
        if (flat === 'ui_language' || flat === 'idle_timeout_seconds') gsCommit();
        // FE-6 step 3: conditional visibility updated SURGICALLY (below);
        // structural cases (Claude-Code mode flip: 3 rows + a datalist, or
        // a box left without its header) keep the honest full rebuild.
        gsVisibilitySync(flat);
    };
    return sel;
}

function gsTitle(t) {
    const h = document.createElement('div');
    // section titles localize via slug key; English literal is fallback
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    h.className = 'gs-title'; h.textContent = C.tf('uplift.gs.title.' + slug, t);
    h.dataset.slug = slug;    // GS-TAB: stable tab key (locale-proof)
    return h;
}

/* ---------------- GS-TAB: ALL / per-section tab strip (classic #4364 split)
   Top tabs over the section boxes: ALL shows today's balanced multi-column
   page; a section tab shows only that box. Boxes STAY RENDERED (hidden attr
   only) so the dirty queue, FE-6 surgical insertion (rowHostBox finds hidden
   boxes) and the savebar never change. Selection persists in localStorage —
   a browser layout preference, same rule as skins/columns. */
const GS_TAB_LS = 'uplift.gs.tab';
let gsTab = 'all';
try { gsTab = localStorage.getItem(GS_TAB_LS) || 'all'; } catch (e) { /* private mode */ }
function gsTabSet(slug) {
    // UP-41(12): entering Advanced (tab strip OR deep link) opens it —
    // classic's settings-open-section event (_settings.html:1002)
    if (slug === 'advanced') gsAdvSetOpen(true);
    if (gsTab === slug) return;
    gsTab = slug;
    try { localStorage.setItem(GS_TAB_LS, slug); } catch (e) { /* ignore */ }
    renderGlobalSettings();
}
function gsBuildTabs(wrap) {
    let bar = document.getElementById('gs-tabs');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gs-tabs'; bar.className = 'gs-tabs';
        wrap.parentElement.insertBefore(bar, wrap);
    }
    bar.textContent = '';
    const mk = (slug, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'se-tab' + (gsTab === slug ? ' active' : '');
        b.dataset.gstab = slug;
        const t = document.createElement('span'); t.textContent = label;
        b.append(t);
        if (slug !== 'all') {
            const badge = document.createElement('span');
            badge.className = 'gs-tab-badge'; badge.hidden = true;
            b.append(badge);
        }
        b.onclick = () => gsTabSet(slug);
        bar.append(b);
    };
    mk('all', C.tf('uplift.gs.tab.all', 'ALL'));
    // CANONICAL order: in section mode the hidden boxes are parked on the
    // wrap (before the columns), so DOM order alone shuffles the strip
    const boxes = [...wrap.querySelectorAll('.gs-box')]
        .sort((a, b) => (a.dataset.ord | 0) - (b.dataset.ord | 0));
    for (const box of boxes) {
        const slug = box.dataset.slug;
        if (!slug) continue;
        const title = box.querySelector('.gs-box-title');
        mk(slug, title ? title.textContent : slug);
    }
    gsTabBadges();
}
function gsTabValid() {
    // a stored tab whose section no longer exists (spec change, gated
    // rebuild) must never land the user on an empty page
    if (gsTab === 'all') return;
    for (const it of GS_SPEC) {
        if (!it.t) continue;
        const slug = it.t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (slug === gsTab) return;
    }
    gsTab = 'all';
    try { localStorage.setItem(GS_TAB_LS, 'all'); } catch (e) {}
}
function gsTabBadges() {
    const bar = document.getElementById('gs-tabs');
    if (!bar) return;
    const cnt = {}, restart = {};
    for (const box of document.querySelectorAll('#gs-body .gs-box')) {
        const slug = box.dataset.slug; if (!slug) continue;
        const rows = [...box.querySelectorAll('[data-flat].dirty')];
        cnt[slug] = (cnt[slug] || 0) + rows.length;
        if (rows.some(r => r.classList.contains('restartq'))) restart[slug] = true;
    }
    for (const b of bar.querySelectorAll('[data-gstab]')) {
        const badge = b.querySelector('.gs-tab-badge');
        if (!badge) continue;
        const slug = b.dataset.gstab, n = cnt[slug] || 0;
        badge.hidden = !n;
        badge.textContent = n > 9 ? '9+' : String(n);
        badge.classList.toggle('restart', !!restart[slug]);
        badge.title = restart[slug]
            ? C.tf('uplift.gs.tab.badge_restart',
                   'Includes changes that need a server restart') : '';
    }
}

/* ---------------- UP-41(11/12): section deep-links + Advanced disclosure.
   Classic routes settings by #settings-<id> anchors (_settings.html:31-42
   rail + copy-link, dashboard.js settingsGoToSection:1026 /
   settingsCopyAnchor:1125 / settings-open-section:1030, Advanced collapsed
   by default at _settings.html:999-1017 and auto-opened by that event).
   Uplift keeps the localStorage section-tab strip, so a deep link SELECTS
   the strip tab; the hash form stays classic-compatible (#settings-x) and
   is normalized to the uplift two-segment route BEFORE uplift.js's applyTab
   reads it (gsys loads first, so our listener runs first; replaceState does
   not re-fire hashchange). The second segment is not in SUBS.settings, so
   applyTab lands on tab=settings sub=global exactly like a plain link. */
const GS_NUMSCALE_LS = 'omlx-number-scale';   // shared with classic count_format.js:8
const GS_ADV_LS = 'uplift.gs.advOpen';       // PER-BROWSER choice, survives a
//   reload (user 2026-10-27: 'advanced session should remember the state').
//   Same home as the number-scale switch; the DEFAULT when nothing is stored
//   stays collapsed, so a first visit still sees the short page.
function gsAdvOpen() {
    try { return localStorage.getItem(GS_ADV_LS) === '1'; } catch (_) { return false; }
}
function gsAdvSetOpen(v) {
    try { localStorage.setItem(GS_ADV_LS, v ? '1' : ''); } catch (_) {}
}
/* Land a section just BELOW the sticky board header. A plain
   scrollIntoView({block:'start'}) parks the section title under
   header.top (position:sticky) — measured: the first expanded row was cut
   off and the header itself never appeared, which reads as 'nothing
   happened'. */
function gsScrollBoxIntoView(box) {
    if (!box || !box.getBoundingClientRect) return;
    const hdr = document.querySelector('header.top');
    const off = (hdr ? hdr.getBoundingClientRect().height : 0) + 10;
    window.scrollTo({
        top: Math.max(0, window.scrollY + box.getBoundingClientRect().top - off),
        behavior: 'smooth',
    });
}
function gsSpecSlugs() {
    const out = [];
    for (const it of GS_SPEC) {
        if (!it.t) continue;
        out.push(it.t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    }
    return out;
}
function gsDeepApply(slug) {
    if (!slug) return;
    if (slug === 'advanced') gsAdvSetOpen(true);   // classic settings-open-section (1030)
    if (!gsSpecSlugs().includes(slug)) return;     // unknown section: strip stays
    if (gsTab !== slug) {
        gsTab = slug;
        try { localStorage.setItem(GS_TAB_LS, slug); } catch (_) {}
        if (GS) renderGlobalSettings();
    }
}
function gsDeepNormalize() {
    const slug = window.UpliftGSpec.parseGsDeepLink(location.hash);
    if (slug && /^#settings-/i.test(location.hash)) {
        // classic anchor shape -> uplift route, without firing hashchange
        try {
            history.replaceState(null, '', location.pathname + location.search +
                '#settings/' + slug);
        } catch (_) {}
    }
    return slug;
}
// boot: normalize + apply a link present BEFORE the first render. Kept
// GS_SPEC-free on purpose (this runs while the module is still evaluating
// — gsSpecSlugs() would hit the const TDZ): an unknown slug is sanitized
// later by gsTabValid() inside renderGlobalSettings, and GS is null here
// so nothing re-renders yet. The hashchange listener is registered at
// eval time = BEFORE uplift.js's hashchange->applyTab, which is what the
// normalization above depends on.
const gsDeepBoot = gsDeepNormalize();
if (gsDeepBoot) {
    if (gsDeepBoot === 'advanced') gsAdvSetOpen(true);
    gsTab = gsDeepBoot;
    try { localStorage.setItem(GS_TAB_LS, gsDeepBoot); } catch (_) {}
}
addEventListener('hashchange', () => {
    try { gsDeepApply(gsDeepNormalize()); } catch (_) {}
});
// classic settingsCopyAnchor (dashboard.js:1125): copy origin+path+#settings-x
function gsCopySectionLink(btn, slug) {
    const url = window.location.origin + window.location.pathname +
        window.UpliftGSpec.gsSectionAnchor(slug);
    const flash = () => {
        btn.textContent = '\u2713';
        btn.title = C.tf('cluster.v2.common.copied', 'Copied!');
        setTimeout(() => {
            btn.textContent = '\u29C9';
            btn.title = C.tf('settings.sections.copy_link',
                'Copy link to this section');
        }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(url).then(flash).catch(flash);
    else flash();
}

/* ---------------- UP-41(8): classic host-preset row (_settings.html:305-342).
   Localhost/Public/Custom selector over the raw host field: presets write
   127.0.0.1 / 0.0.0.0, Custom blanks the value and reveals the text input
   with classic's multi-host hint. The row keeps data-flat='host', so the
   UP-19(7) loopback forcing (markFieldDirty -> gsDisabledSync) and the
   restart badge ride it unchanged. */
function gsHostRow(body, L) {
    const GSPEC = window.UpliftGSpec;
    const wrap = document.createElement('span');
    wrap.className = 'gs-hostrow';
    const sel = document.createElement('select');
    sel.className = 'gs-hostpreset';
    for (const [v, k, d] of [
        ['localhost', 'settings.server.host_localhost', 'Localhost only (127.0.0.1)'],
        ['public', 'settings.server.host_public', 'Open to all (0.0.0.0)'],
        ['custom', 'settings.server.host_custom', 'Custom (caution)']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = C.tf(k, d);
        sel.append(o);
    }
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = L.server.host_placeholder;
    inp.spellcheck = false; inp.autocomplete = 'off';
    const hint = document.createElement('small');
    hint.className = 'dim gs-hosthint';
    hint.textContent = C.tf('settings.server.host_multi_hint',
        'Separate multiple addresses with commas');
    wrap.append(sel, inp, hint);
    const cur = () => {
        const v = gsEffFlat('host');
        return v == null ? '' : String(v);
    };
    const paint = () => {
        const v = cur();
        const mode = GSPEC.hostPresetOf(v);
        sel.value = mode;
        inp.value = v;
        const custom = mode === 'custom';
        inp.style.display = custom ? '' : 'none';
        hint.style.display = custom ? '' : 'none';
    };
    sel.onchange = () => {
        // classic _setHostMode (_settings.html:318-321): presets write their
        // bind, Custom starts from blank (the user types the list)
        gsQueueSave('host', GSPEC.hostPresetValue(sel.value));
        paint();
    };
    const queue = () => {
        // NO full repaint here: writing inp.value on every keystroke moves
        // the caret. Only the preset select follows the typed value live
        // (classic's reactive hostMode getter did exactly that).
        gsQueueSave('host', inp.value.trim());
        sel.value = GSPEC.hostPresetOf(inp.value);
    };
    inp.addEventListener('input', queue);
    inp.addEventListener('change', queue);
    const row = gsRow('server', L.server.host, '', wrap,
        { badge: true, flat: 'host' });
    row.__gsApply = paint;   // dirty-revert/re-render plumbing feeds the composite
    paint();
    body.append(row);
}

/* ---------------- UP-41(10): cache-limit % sliders over size strings
   (classic _settings.html:543-615 + dashboard.js 6499-6772, pure halves in
   uplift_gspec.js). SEMANTICS (card CAUTION — aligned deliberately):
   uplift used to leave these fields blank ('= OS default' per the old
   hint); classic normalizes blank/'auto' hot-cache to '0' (= DISABLED) on
   load and persists explicit strings ('auto', '0', '<n>GB'). We adopt the
   classic model: the controls below always queue an explicit string, and
   a legacy blank renders as classic renders it (cold -> Auto, hot -> Off).
   Missing system sizes (old payload) hide the % half honestly — the GB
   number input keeps working. */
function gsSizeRow(opts) {
    // shared shell for the cold/hot rows: label + seg buttons | slider +
    // readout | GB number input; opts.{flat,label,hint} + pure callbacks
    const wrap = document.createElement('span');
    wrap.className = 'gs-sizerow';
    const left = document.createElement('span'); left.className = 'gs-sizeseg';
    const mid = document.createElement('span'); mid.className = 'gs-sizeslider';
    const range = document.createElement('input');
    range.type = 'range'; range.min = 0; range.max = opts.maxPct; range.step = 1;
    range.className = 'gs-sizepct';
    const read = document.createElement('span'); read.className = 'gs-sizeread dim';
    const gb = document.createElement('input');
    gb.type = 'number'; gb.min = 0; gb.step = 1; gb.className = 'gs-sizegb';
    const gbl = document.createElement('span'); gbl.textContent = 'GB';
    mid.append(range, read);
    const right = document.createElement('span'); right.className = 'gs-sizegbcell';
    right.append(gb, gbl);
    wrap.append(left, mid, right);
    const row = gsRow('cache', opts.label, opts.hint, wrap, { flat: opts.flat });
    row.__gsComposite = true;
    return { row, wrap, left, mid, range, read, gb,
             // 1 GiB readout helper: bytes -> whole-GB string
             gbOf: b => Math.round((b || 0) / (1024 ** 3)) };
}
function gsColdCacheRow(body, L) {
    const GSPEC = window.UpliftGSpec;
    const sys = () => (GS && GS.system) || {};
    const ui = gsSizeRow({
        flat: 'ssd_cache_max_size',
        label: C.tf('settings.resource.cold_cache_limit', L.cache.ssd_max),
        hint: L.cache.ssd_max_hint + ' \u2014 ' +
            C.tf('settings.resource.cold_cache_description',
                 'Persistent SSD storage for evicted KV cache blocks.'),
        maxPct: 100,
    });
    const seg = (label, on, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'se-btn gs-seg' + (on ? ' on' : '');
        b.textContent = label; b.onclick = fn;
        return b;
    };
    const eff = () => {
        const v = gsEffFlat('ssd_cache_max_size');
        return v == null ? '' : String(v).trim();
    };
    const autoGB = () => Math.round(
        Number((GS && GS.cache && GS.cache.ssd_cache_auto_size_bytes) || 0) / (1024 ** 3));
    const paint = () => {
        const v = eff();
        const mode = (v === '' || v === 'auto') ? 'auto' : 'fixed';
        const total = Number(sys().ssd_total_bytes) || 0;
        ui.left.replaceChildren(
            seg(C.tf('settings.resource.cold_cache_auto', 'Auto'), mode === 'auto',
                () => { gsQueueSave('ssd_cache_max_size', 'auto'); paint(); }),
            seg(C.tf('settings.resource.cold_cache_fixed', 'Fixed'), mode === 'fixed',
                () => {
                    if (mode === 'auto') {
                        // classic _settings.html:591 — Fixed starts from the
                        // auto size (floor 1 GB), not from 0
                        gsQueueSave('ssd_cache_max_size',
                            `${Math.max(1, autoGB() || GSPEC.parseSettingsGB(v) || 1)}GB`);
                        paint();
                    }
                }));
        ui.mid.style.display = total ? '' : 'none';
        if (total) {
            ui.range.value = GSPEC.cachePercentOf(mode === 'auto' ? '' : v, total);
            const gbv = mode === 'auto' ? autoGB()
                : (GSPEC.parseSettingsGB(v) ?? ui.gbOf(ui.range.value / 100 * total));
            ui.read.textContent = ui.range.value + '% \u00b7 ' +
                gbv + ' / ' + ui.gbOf(total) + ' GB' +
                (mode === 'auto' ? ' \u2014 ' + C.tf(
                    'settings.resource.cold_cache_auto_description',
                    'Current limit is 50% of the sum of free disk space and existing SSD cache. Edit the GB value to set a fixed limit.') : '');
        }
        ui.gb.value = mode === 'auto' ? (autoGB() || '')
            : (GSPEC.parseSettingsGB(v) ?? 0);
    };
    ui.range.oninput = () => {
        gsQueueSave('ssd_cache_max_size',
            GSPEC.percentToCacheString(Number(ui.range.value), Number(sys().ssd_total_bytes) || 0));
        paint();
    };
    ui.gb.onchange = () => {
        gsQueueSave('ssd_cache_max_size', `${parseInt(ui.gb.value, 10) || 0}GB`);
        paint();
    };
    ui.row.__gsApply = paint;
    paint();
    body.append(ui.row);
}
function gsHotCacheRow(body, L) {
    const GSPEC = window.UpliftGSpec;
    const total = () => Number(((GS && GS.system) || {}).total_memory_bytes) || 0;
    const ui = gsSizeRow({
        flat: 'hot_cache_max_size',
        label: C.tf('settings.resource.hot_cache_limit', L.cache.hot_max),
        // classic words the zero semantics (_settings.html:547-549)
        hint: L.cache.hot_max_hint + ' ' +
            C.tf('settings.resource.hot_cache_zero_note',
                 'Reduces SSD I/O latency for repeated prompts.') + ' ' +
            C.tf('settings.resource.hot_cache_disabled', '0') + ' ' +
            C.tf('settings.resource.hot_cache_disabled_label', '= disabled.'),
        maxPct: 50,
    });
    const eff = () => {
        // ALIGNMENT: blank/'auto' normalize to '0' exactly like classic
        // normalizeHotCacheMaxSize (dashboard.js:6730) — legacy uplift
        // blanks therefore render OFF, same as classic shows them.
        const v = String(gsEffFlat('hot_cache_max_size') ?? '').trim();
        return (!v || v.toLowerCase() === 'auto') ? '0' : v;
    };
    const paint = () => {
        const v = eff();
        const t = total();
        ui.mid.style.display = t ? '' : 'none';
        const pct = GSPEC.hotCachePercentOf(v, t);
        if (t) ui.range.value = pct;
        const gbv = v === '0' ? 0 : (GSPEC.parseSettingsGB(v) ?? 0);
        ui.read.textContent = (pct === 0
            ? C.tf('settings.resource.off', 'Off') : pct + '%') +
            ' \u00b7 ' + gbv + ' GB';
        ui.gb.value = gbv;
    };
    ui.range.oninput = () => {
        gsQueueSave('hot_cache_max_size',
            GSPEC.hotCacheStringFromPercent(Number(ui.range.value), total()));
        paint();
    };
    ui.gb.onchange = () => {
        // classic updateHotCacheFromInput (6679): 0 -> '0' (disabled)
        const g = parseInt(ui.gb.value, 10) || 0;
        gsQueueSave('hot_cache_max_size', g === 0 ? '0' : `${g}GB`);
        paint();
    };
    ui.row.__gsApply = paint;
    paint();
    body.append(ui.row);
}

/* ---------------- UP-41(10): memory-guard readout block (classic
   _settings.html:485-510 + dashboard.js 6553-6663). The GS payload already
   carries system.memory_guard_preview; this renders tier description,
   ceiling breakdown and the wired-limit red warning + copyable sysctl fix.
   Always in the DOM, synced (visibility + contents) by gsGuardSync after
   every render / queued edit — the classic x-show bindings as imperative
   updates, so tier picking shows the new ceiling without a SAVE. */
function gsGuardBlock(body) {
    const box = document.createElement('div');
    box.className = 'gs-guardinfo'; box.id = 'gs-guardinfo';
    body.append(box);
}
function gsGuardSync() {
    const GSPEC = window.UpliftGSpec;
    const box = document.getElementById('gs-guardinfo');
    if (!box || !GS) return;
    box.replaceChildren();
    const sys = GS.system || {};
    const guardOn = !!gsEffFlat('memory_prefill_memory_guard');
    const tier = gsEffFlat('memory_guard_tier') || 'balanced';
    const preview = (sys.memory_guard_preview || {})[tier];
    const add = (cls, segs) => {
        const p = document.createElement('div');
        p.className = cls;
        for (const s of segs) {
            if (typeof s === 'string') { p.append(document.createTextNode(s)); continue; }
            const b = document.createElement('strong');
            b.textContent = s.t; p.append(b);
        }
        box.append(p);
    };
    let any = false;
    if (guardOn) {
        if (preview || tier === 'custom') {
            // tier description (classic memoryGuardTierDescription 6605)
            const tpl = tier === 'custom'
                ? C.tf('settings.resource.guard_tier.description_custom',
                       'Custom: oMLX uses your specified ceiling of {custom_gb} GB.')
                : C.tf('settings.resource.guard_tier.description.' + tier,
                       tier + ' keeps {reserve} free for other apps.');
            add('gs-guard-desc dim', [GSPEC.guardTierText(tpl, tier, preview,
                gsEffFlat('memory_guard_custom_ceiling_gb'))]);
            any = true;
        }
        if (preview && preview.ceiling_bytes != null) {
            // ceiling breakdown (classic memoryGuardBreakdownHTML 6626);
            // classic ships <strong> fields via x-html — templateSegments
            // gives the same emphasis through JS-built DOM
            const GB = 1024 ** 3;
            const b = v => ({ t: Number((v || 0) / GB).toFixed(1) + ' GB' });
            let segs = [];
            if (tier === 'custom') {
                const custom = Number(gsEffFlat('memory_guard_custom_ceiling_gb') || 0);
                const ceiling = GSPEC.customGuardCeilingGB(custom, preview);
                const kernelBinds = ceiling !== null &&
                    preview.metal_cap_bytes > 0 &&
                    Math.abs(ceiling * GB - preview.metal_cap_bytes) < 1 &&
                    ceiling < custom;
                const tpl = C.tf(kernelBinds
                    ? 'settings.resource.guard_tier.breakdown_custom_kernel_limit'
                    : 'settings.resource.guard_tier.breakdown_custom',
                    kernelBinds
                    ? '* Custom ceiling {custom_gb} GB / effective ceiling {ceiling} (kernel limit)'
                    : '* Custom ceiling {custom_gb} GB \u2192 effective ceiling {ceiling}');
                segs = GSPEC.templateSegments(tpl, {
                    custom_gb: custom.toFixed(1),
                    ceiling: ceiling === null ? '?' : ceiling.toFixed(1),
                });
            } else {
                const kernelBinds = preview.binding === 'metal_cap';
                const tpl = C.tf(kernelBinds
                    ? 'settings.resource.guard_tier.breakdown_kernel_limit'
                    : 'settings.resource.guard_tier.breakdown',
                    kernelBinds
                    ? '* Free {free} + inactive {inactive} + other apps\u2019 compressible {other} / effective ceiling {ceiling} (kernel limit)'
                    : '* Free {free} + inactive {inactive} + other apps\u2019 compressible {other} \u2212 reserve {reserve} \u2192 ceiling {ceiling}');
                segs = GSPEC.templateSegments(tpl, {
                    free: b(preview.free_bytes).t, inactive: b(preview.inactive_bytes).t,
                    other: b(preview.other_apps_bytes).t,
                    reserve: b(preview.reserve_bytes).t, ceiling: b(preview.ceiling_bytes).t,
                });
            }
            add('gs-guard-break dim', segs);
            any = true;
        }
        if (GSPEC.wiredLimitWarned(sys)) {
            // red warning + copyable sysctl fix (classic 6561-6600): the
            // kernel iogpu.wired_limit_mb caps oMLX below its request.
            // CLASSIC'S STRUCTURE IS THE POINT: the sentence is a BLOCK line
            // and only the command + its copy button share a flex row. Mixed
            // text runs inside a flex container each become a flex ITEM — the
            // sentence then shatters across lines with hard gaps and a line
            // that starts with ';' (the defect this shape removes, and no
            // node stub geometry can see it).
            const warn = document.createElement('div');
            warn.className = 'gs-guard-wired';
            const line = document.createElement('div');
            line.className = 'gs-guard-wired-line';
            warn.append(line);
            const tpl = C.tf('settings.resource.guard_tier.wired_limit_warning',
                'Kernel iogpu.wired_limit_mb is only {kernel}; oMLX can only allocate up to {kernel}. Raise it in Terminal:');
            const ktxt = (sys.iogpu_wired_limit_bytes / (1024 ** 3)).toFixed(1) + ' GB';
            const pieces = String(tpl).split('{kernel}');
            pieces.forEach((piece, i) => {
                if (piece) line.append(document.createTextNode(piece));
                // classic bolds EVERY {kernel} occurrence — strong between
                // pieces, never trailing
                if (i < pieces.length - 1) line.append(
                    Object.assign(document.createElement('strong'), { textContent: ktxt }));
            });
            const cmd = GSPEC.wiredLimitCommand(sys);
            // the command + copy button are ONE row (classic's
            // flex items-center div); the sentence above stays a block
            const fix = document.createElement('div');
            fix.className = 'gs-guard-fix';
            const code = document.createElement('code');
            code.className = 'gs-guard-sysctl'; code.textContent = cmd;
            const cp = document.createElement('button');
            // NOT 'act' — that is the admin-table action-column class and it
            // carries a 74px min-width meant for WORDS ('RETRY'). This is an
            // icon button, shaped like the section copy-link.
            cp.type = 'button'; cp.className = 'se-btn gs-guard-copy';
            cp.textContent = '\u29C9';
            cp.title = C.tf('status.integrations.copy_command_tooltip', 'Copy command');
            cp.setAttribute('aria-label', cp.title);
            cp.onclick = () => {
                const flash = () => { cp.textContent = '\u2713';
                    setTimeout(() => { cp.textContent = '\u29C9'; }, 2000); };
                if (navigator.clipboard && navigator.clipboard.writeText)
                    navigator.clipboard.writeText(cmd).then(flash).catch(flash);
                else flash();
            };
            fix.append(code, cp);
            warn.append(fix);
            box.append(warn);
            any = true;
        }
    }
    box.hidden = !any;
}

/* ---------------- UP-41(13): compact-vs-exact number scale switch
   (classic _settings.html:112-118 + omlxCount setScale, count_format.js).
   Classic persists it client-side in localStorage 'omlx-number-scale' —
   NOT a server setting — so this row keeps the exact same key (a browser
   shared between the dashboards carries one truth). It writes through to
   window.omlxCount when the classic count lib is present and fires
   'uplift-number-scale' so uplift renderers can adopt it live; the compact
   formatter itself lives in UpliftCore. */
function gsNumberScaleRow(body) {
    const cur = (() => {
        try { return localStorage.getItem(GS_NUMSCALE_LS) === 'exact' ? 'exact' : 'compact'; }
        catch (_) { return 'compact'; }
    })();
    const sel = document.createElement('select');
    for (const [v, k, d] of [['compact', 'settings.appearance.number_scale_compact', 'Higher units'],
                             ['exact', 'settings.appearance.number_scale_exact', 'Exact digits']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = C.tf(k, d);
        sel.append(o);
    }
    sel.value = cur;
    sel.onchange = () => {
        const v = sel.value === 'exact' ? 'exact' : 'compact';
        try { localStorage.setItem(GS_NUMSCALE_LS, v); } catch (_) {}
        // classic setStatsNumberScale (dashboard.js:4615) -> omlxCount.setScale
        try { window.omlxCount && window.omlxCount.setScale && window.omlxCount.setScale(v); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('uplift-number-scale',
                { detail: { scale: v } }));
        } catch (_) {}
    };
    body.append(gsRow('ui', C.tf('settings.appearance.number_scale', 'Number scale'),
        C.tf('uplift.gs.appearance.number_scale_hint',
             'Per-browser display choice: compact rounds to higher units, exact shows every digit.'),
        sel));
}

async function pollGlobalSettings() {
    let d;
    try { d = await GLUE.fetchJson(`${API}/admin/api/global-settings`); }
    catch (err) { GLUE.emptyMsg($('gs-body'), C.tf('uplift.gsys.not_served', 'global-settings not served (') + D.errText(err) + ')'); return; }
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
        // same truthy spelling the modal uses: vanilla compares some flags
        // against the word "true", so 1/0 would be read as OFF
        const on = a.truthy === 'true' ? 'true' : '1';
        const off = a.truthy === 'true' ? 'false' : '0';
        ctl = document.createElement('select');
        for (const [v, t] of [['', '\u2014'], [on, C.tf('uplift.env.on', 'On')],
                               [off, C.tf('uplift.env.off', 'Off')]]) {
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
        GLUE.toast(C.tf('uplift.gsys.env_fail', 'env tunables: ') + D.errText(err), 5000);
        return false;
    }
}

// ---------------------------------------------------------------------------
// ENV-3: environment variables reference — button in the Server settings
// save bar opens a searchable modal documenting every env-only omlx knob
// (no settings.json field, invisible to both dashboards otherwise). Rows
// carry the verified apply-class badge (live / RESTART MODEL / RESTART
// SERVER), the stock default, and the live state: SET (present in the
// server process env; secret values masked server-side), STORED (an uplift
// override awaiting its restart), LAUNCH ENV (genuine launch variable wins
// over anything uplift stores), MANAGED (vanilla owns the var — documented
// only). Settable rows carry a control + APPLY that PUTs /env-overrides
// directly, outside the gsDirty queue.
//
// ENV-4: the editable surface opened up from ten variables to every
// documented one vanilla does not own or alias — but ONLY on omlx-dev. On
// the vanilla `omlx` service the store is never seeded, so the server answers
// settable=false for every row and the modal is a pure reference with an
// explanatory banner; PUT /env-overrides 403s there. Chip tooltips and the
// legend line say what MANAGED and the left border mean, which ENV-3 shipped
// without ever stating.
// ---------------------------------------------------------------------------

const ENV_CAT_GROUPS = ['scheduler', 'memory', 'engine', 'attention', 'prefill',
    'quantization', 'moe', 'mtp', 'cluster', 'server', 'integrations'];
let ENV_CAT = null;   // last /env-catalog payload (refreshed on each open)

function envCatEffectLabel(e) {
    return e === 'immediate'
        ? C.tf('uplift.envcat.e_live', 'LIVE')
        : e === 'model'
            ? C.tf('uplift.envcat.e_model', 'RESTART MODEL')
            : C.tf('uplift.envcat.e_server', 'RESTART SERVER');
}

function envCatChip(text, cls) {
    const s = document.createElement('span');
    s.className = 'rqchip envcat-chip' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
}

function envCatRow(r) {
    const row = document.createElement('div');
    // 'on' = the variable currently carries a value in the server process.
    // ENV-4: that is what the coloured left border means, and it used to be
    // the one signal in this modal with no explanation anywhere.
    row.className = 'envcat-row' + (r.present ? ' on' : '') + (r.managed ? ' managed' : '');
    if (r.present)
        row.title = C.tf('uplift.envcat.border_hint',
            'Left border: this variable currently has a value in the running oMLX process');
    const head = document.createElement('div'); head.className = 'envcat-head';
    const nm = document.createElement('code'); nm.className = 'envcat-name'; nm.textContent = r.name;
    head.append(nm);
    if (r.settable) {
        const c = envCatChip(C.tf('uplift.env.badge', 'EXPERIMENTAL'), 'set');
        c.title = C.tf('uplift.envcat.settable_hint',
            'Editable here. Uplift stores the value and seeds it when the dev server starts; '
            + 'an unknown or wrong value can change engine behaviour, so it is labelled experimental.');
        head.append(c);
    }
    if (r.managed) {
        const c = envCatChip(C.tf('uplift.envcat.managed', 'MANAGED'), 'dim');
        c.title = C.tf('uplift.envcat.managed_hint',
            'Not editable: vanilla oMLX owns this variable. It either writes the value itself at '
            + 'runtime (a setting the dashboard already exposes drives it), or the variable is the '
            + 'environment fallback of an exposed setting — editing it here would conflict with that owner. '
            + 'Shown for reference only.');
        head.append(c);
    }
    if (r.dead) {
        const c = envCatChip(C.tf('uplift.envcat.dead', 'NO EFFECT'), 'dim');
        c.title = C.tf('uplift.envcat.dead_hint',
            'Not editable: no live oMLX code path reads this variable any more, so any value set '
            + 'here would do nothing. Documented so the name is not lost.');
        head.append(c);
    }
    if (r.secret) {
        const c = envCatChip(C.tf('uplift.envcat.secret', 'SECRET'), 'dim');
        c.title = C.tf('uplift.envcat.secret_hint',
            'A credential or key. Uplift never edits it and masks its value wherever it appears.');
        head.append(c);
    }
    if (r.name in ENV_SHADOW) {
        const c = envCatChip(C.tf('uplift.envcat.launch_env', 'LAUNCH ENV') +
            ' (' + ENV_SHADOW[r.name] + ')', 'warn');
        c.title = C.tf('uplift.env.shadow_warn',
            'environment variable already set — it takes precedence until removed from the launch environment');
        head.append(c);
    } else if (r.present) {
        const c = envCatChip(C.tf('uplift.envcat.set', 'SET') +
            (r.live ? ' = ' + r.live : ''), 'ok');
        c.title = C.tf('uplift.envcat.set_hint',
            'Currently set in the running oMLX process environment');
        head.append(c);
    } else if (r.stored != null && r.stored !== '') {
        const c = envCatChip(C.tf('uplift.envcat.stored', 'STORED'), 'stored');
        c.title = C.tf('uplift.envcat.stored_hint',
            'Stored by Uplift, not yet in the process environment — apply it with the restart the '
            + 'badge above names');
        head.append(c);
    }
    const e = envCatChip(envCatEffectLabel(r.effect),
        r.effect === 'immediate' ? 'ok' : (r.effect === 'model' ? 'stored' : 'dim'));
    e.title = C.tf('uplift.envcat.effect_hint',
        'When a new value actually takes effect: immediately (oMLX reads it per request), on the '
        + 'next model load, or only after the server restarts');
    head.append(e);
    row.append(head);

    const desc = document.createElement('div'); desc.className = 'envcat-desc';
    let d = r.desc || '';
    if (r.default) d += ' · ' + C.tf('uplift.env.stock_default', 'stock default') + ': ' + r.default;
    desc.textContent = d;
    row.append(desc);

    if (r.settable) {
        const spec = ENV_SPEC.find(a => a.name === r.name) || {};
        const act = document.createElement('div'); act.className = 'envcat-act';
        let ctl;
        if (spec.type === 'bool') {
            // The option VALUES are what vanilla compares against, not a
            // uniform 1/0: TRUTHY_WORD vars only fire on the word "true", so
            // a stored "true" also has to select the right option here (with
            // hardcoded 1/0 it matched nothing and the row silently read as
            // unset — the value was there, the control just lied).
            const on = spec.truthy === 'true' ? 'true' : '1';
            const off = spec.truthy === 'true' ? 'false' : '0';
            ctl = document.createElement('select');
            for (const [v, t] of [['', '\u2014'], [on, C.tf('uplift.env.on', 'On')],
                                   [off, C.tf('uplift.env.off', 'Off')]]) {
                const o = document.createElement('option');
                o.value = v; o.textContent = t; ctl.append(o);
            }
            const cur = ENV_VALUES[r.name] != null ? String(ENV_VALUES[r.name]) : '';
            ctl.value = (cur === 'yes' || cur === 'on') ? on
                : (cur === 'no' || cur === 'off') ? off : cur;
        } else {
            ctl = document.createElement('input');
            ctl.type = (spec.type === 'int' || spec.type === 'float') ? 'number' : 'text';
            if (spec.min !== undefined) ctl.min = spec.min;
            if (spec.max !== undefined) ctl.max = spec.max;
            if (spec.type === 'float') ctl.step = 'any';
            if (spec.default) ctl.placeholder = spec.default;
            ctl.value = ENV_VALUES[r.name] != null ? ENV_VALUES[r.name] : '';
        }
        const apply = document.createElement('button');
        apply.type = 'button'; apply.className = 'se-btn';
        apply.textContent = C.tf('uplift.env.apply', 'APPLY');
        apply.title = C.tf('uplift.envcat.apply_hint',
            'Apply this value now. Leave the field empty to reset: the stored override is '
            + 'deleted and oMLX returns to its stock default on the next restart.');
        apply.onclick = async () => {
            apply.disabled = true;
            const ok = await envSave({ [r.name]: ctl.value === '' ? null : ctl.value });
            apply.disabled = false;
            if (!ok) return;
            // the queued-form copy of this key is now stale — the direct
            // apply already committed it; keep the main row in sync
            if (r.name in gsDirty) {
                delete gsDirty[r.name];
                if (document.getElementById('gs-body')) renderGlobalSettings();
            }
            ENV_CAT = null;
            await openEnvCatalog(true);
        };
        act.append(ctl, apply);
        row.append(act);
    }
    return row;
}

function envCatRenderList(list, query, filt) {
    list.textContent = '';
    const q = (query || '').trim().toLowerCase();
    const match = r => (!q || r.name.toLowerCase().includes(q) ||
        (r.desc || '').toLowerCase().includes(q)) && envCatFiltOk(r, filt);
    const rows = (ENV_CAT.vars || []).filter(match);
    let shown = 0;
    for (const g of ENV_CAT_GROUPS) {
        const gr = rows.filter(r => r.group === g);
        if (!gr.length) continue;
        const h = document.createElement('div'); h.className = 'envcat-g';
        h.textContent = C.tf('uplift.envcat.group.' + g, g);
        list.append(h);
        for (const r of gr.sort((a, b) => a.name.localeCompare(b.name))) list.append(envCatRow(r));
        shown += gr.length;
    }
    return shown;
}

// ENV-4 filters: with 136 editable rows and 11 documented-only ones in one
// list, 'which of these can I actually change' needs to be one click away
// rather than a scroll through eleven groups.
const ENV_CAT_FILTERS = ['all', 'settable', 'readonly', 'set'];

function envCatFiltOk(r, filt) {
    if (filt === 'settable') return !!r.settable;
    if (filt === 'readonly') return !r.settable;
    if (filt === 'set') return !!r.present;
    return true;
}

async function openEnvCatalog(reopen) {
    if (!ENV_CAT) {
        try {
            ENV_CAT = await GLUE.fetchJson(`${API}/uplift/api/env-catalog`);
        } catch (err) {
            GLUE.toast(C.tf('uplift.envcat.load_fail', 'environment catalog: ') + D.errText(err), 5000);
            return;
        }
    }
    // refresh the shadow view so LAUNCH ENV chips are current
    try {
        const d = await GLUE.fetchJson(`${API}/uplift/api/env-overrides`);
        ENV_VALUES = d.values || ENV_VALUES;
        ENV_SHADOW = {};
        for (const s of (d.shadowed || [])) ENV_SHADOW[s.name] = s.value_masked;
    } catch (_) { /* keep whatever the settings poll last saw */ }

    let prev = document.querySelector('.modal-overlay.envcat-overlay');
    if (prev) prev.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay envcat-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa envcat';
    const head = document.createElement('div'); head.className = 'envcat-hrow';
    const h = document.createElement('h3');
    h.textContent = C.tf('uplift.envcat.title', 'Environment variables');
    const cnt = document.createElement('span'); cnt.className = 'envcat-count';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'se-btn envcat-x'; x.textContent = '\u00d7';
    x.onclick = () => overlay.remove();
    head.append(h, cnt, x);
    const intro = document.createElement('div'); intro.className = 'se-hint';
    intro.textContent = ENV_CAT.dev
        ? C.tf('uplift.envcat.intro',
            'Expert knobs oMLX reads from the environment only — no settings.json field exists. '
            + 'Settable rows store the value in Uplift and seed it at server start; a variable '
            + 'already set in the launch environment always wins.')
        : C.tf('uplift.envcat.intro_readonly',
            'Reference only: this is the vanilla oMLX service. Uplift stores and seeds these '
            + 'overrides on omlx-dev only, so no value here can take effect on this server.');
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'envcat-search';
    search.placeholder = C.tf('uplift.envcat.search', 'Search variable name or description\u2026');
    // ENV-4: one click to answer 'which of these can I change' (dev) or
    // 'which are actually live right now' (both runtimes).
    const filters = document.createElement('div'); filters.className = 'envcat-filters';
    let filt = 'all';
    const btns = ENV_CAT_FILTERS.map(f => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'se-btn envcat-filt';
        b.textContent = C.tf('uplift.envcat.filt.' + f, f);
        b.onclick = () => { filt = f; paintFilt(); paint(); };
        return [f, b];
    });
    const paintFilt = () => {
        for (const [f, b] of btns) b.classList.toggle('on', f === filt);
    };
    for (const [, b] of btns) filters.append(b);
    if (!ENV_CAT.dev) {
        // 'settable' is meaningless on the vanilla runtime; drop the tab
        const [, b] = btns.find(([f]) => f === 'settable');
        if (b) b.style.display = 'none';
    }
    // ENV-4 legend: the left border and MANAGED both carried meaning that
    // nothing on screen ever explained.
    const legend = document.createElement('div'); legend.className = 'envcat-legend';
    legend.append(Object.assign(document.createElement('span'), {
        className: 'envcat-legend-border',
    }));
    legend.append(Object.assign(document.createElement('span'), {
        textContent: C.tf('uplift.envcat.legend_border',
            'coloured left border = currently set in the running server'),
    }));
    // each legend entry QUOTES the live chip word (from the same locale key
    // the chip renders) followed by a short gloss, so the legend can never
    // name a badge differently than the badge beside it — a hardcoded
    // 'MANAGED = ...' would have said MANAGED next to a chip reading
    // 'SPRAVUJE omlx' in Czech and '即時反映' style words elsewhere.
    const legendItem = (chipLabel, glossKey, glossDef, hintKey) => {
        const i = document.createElement('span');
        i.className = 'envcat-legend-item';
        i.textContent = chipLabel + ' \u2014 ' + C.tf(glossKey, glossDef);
        i.title = C.tf(hintKey, glossDef);
        return i;
    };
    legend.append(legendItem(
        C.tf('uplift.envcat.managed', 'MANAGED'),
        'uplift.envcat.legend_managed', 'vanilla oMLX owns this variable',
        'uplift.envcat.managed_hint'));
    // On the read-only runtime nothing carries the EXPERIMENTAL chip, so a
    // legend line calling it "editable here" would contradict the banner
    // above it — the line only earns its place where the chip can appear.
    if (ENV_CAT.dev) {
        legend.append(legendItem(
            C.tf('uplift.env.badge', 'EXPERIMENTAL'),
            'uplift.envcat.legend_editable', 'editable here',
            'uplift.envcat.settable_hint'));
    }
    legend.append(legendItem(
        [C.tf('uplift.envcat.e_live', 'LIVE'),
         C.tf('uplift.envcat.e_model', 'RESTART MODEL'),
         C.tf('uplift.envcat.e_server', 'RESTART SERVER')].join(' / '),
        'uplift.envcat.legend_effect', 'when a value takes effect',
        'uplift.envcat.effect_hint'));
    const list = document.createElement('div'); list.className = 'envcat-list';
    const paint = () => {
        const n = envCatRenderList(list, search.value, filt);
        cnt.textContent = C.tf('uplift.envcat.showing', '{n} of {total} variables',
            { n: n, total: (ENV_CAT.vars || []).length });
    };
    search.oninput = paint;
    box.append(head, intro, search, filters, legend, list);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    // Escape closes via the global handler (uplift_state.js) — no local listener
    document.body.append(overlay);
    paintFilt();
    paint();
    if (!reopen) search.focus();
}



/* FE-6 step 2: the settings page is DATA. Each item is one of:
     {t: 'Title'}                        — section header (starts a box)
     {sec, lab, hint, ctl, opts, show?}  — one row (see gsSpecRow below)
     {env: ['group',...]}                — envRows() experimental block
     {x: (body, L, ctx) => {...}}        — bespoke block (dirs, cc datalist…)
   lab/hint are dotted paths into GS_LABELS (L.auth.api_key style) or
   (L, ctx) => string for the few computed strings; `ctl` describes the
   control: {k:'text'|'num'|'range'|'tog'|'sel', sec?, field?, flat, ...}.
   `show` is the conditional-visibility predicate (ctx.tier etc.), so the
   old if-scatter lives in the data next to the row it gates.
   Row ORDER below is the page's reading order — do not sort. */
function gsRef(L, path) {
    if (!path) return '';
    if (typeof path === 'function') return path(L);
    let v = L;
    for (const k of path.split('.')) { v = (v == null) ? undefined : v[k]; }
    return v == null ? '' : v;
}

function gsSpecRow(it, L, ctx) {
    const c = it.ctl;
    const sec = c.sec || it.sec;
    const flat = c.flat || it.flat;
    let control;
    if (c.k === 'sel') {
        const cur = (c.curFn ? c.curFn(ctx) : gsGet(sec, c.field)) ?? (c.nullTo !== undefined ? c.nullTo : undefined);
        control = gsSelect(flat, gsRef(L, c.opts) || [], cur);
    } else if (c.k === 'tog') {
        control = gsToggle(flat, gsGet(sec, c.field), c.confirm ? gsRef(L, c.confirm) : null);
    } else if (c.k === 'range') {
        control = gsText(sec, c.field, flat, L,
            { range: true, min: c.min, max: c.max, step: c.step });
    } else {
        control = gsText(sec, c.field, flat, L, {
            number: c.k === 'num', bool: c.checked, type: c.type,
            placeholder: gsRef(L, c.ph), list: c.list,
            min: c.min, max: c.max, step: c.step,
        });
    }
    if (c.attach) c.attach(control, L, ctx);
    const opts = Object.assign({}, it.opts);
    if (flat && opts.flat === undefined) opts.flat = flat;   // one place, no repeats
    return gsRow(it.sec, gsRef(L, it.lab), gsRef(L, it.hint), control, opts);
}

const GS_SPEC = [
    {t: 'Server'},
    {sec: 'ui', lab: () => C.tf('uplift.gs.ui.interface_language', 'Interface language'), ctl: {
        k: 'sel', sec: 'ui', field: 'language', flat: 'ui_language', opts: () => Object.entries(GS_LABELS.lang)}},
    // UP-41(13): classic Appearance section's compact/exact number-scale
    // switch (_settings.html:112-118). Client-side preference, lives beside
    // the language row — uplift folds appearance into Server.
    {x: gsNumberScaleRow},

    // UP-41(8): classic's Localhost/Public/Custom preset over the raw host
    // field (_settings.html:305-342); composite row keeps data-flat='host'
    // so the restart badge + UP-19(7) loopback forcing ride it unchanged.
    {x: gsHostRow},
    {sec: 'server', lab: 'server.port', ctl: {k: 'num', field: 'port', flat: 'port'},
     opts: {badge: true, flat: 'port'}},
    {sec: 'server', lab: 'server.log_level', ctl: {
        k: 'sel', field: 'log_level', flat: 'log_level', opts: 'server.levels'}},
    {sec: 'server', lab: 'server.auto_start', hint: 'server.auto_start_hint', ctl: {
        k: 'tog', field: 'auto_start_on_launch', flat: 'auto_start_on_launch'}},
    {x: (body, L) => {   // classic editor keeps a list; same payload. Aliases are
        // hostnames, so ANY whitespace separates them (user 2026-10-27: the box
        // was narrow and 'one per line' read as the only way in).
        const aliasInp = document.createElement('textarea');
        aliasInp.rows = 2; aliasInp.spellcheck = false;
        aliasInp.classList.add('gs-alias-ta');
        aliasInp.value = (gsGet('server', 'server_aliases') || []).join(' ');
        aliasInp.onchange = () => gsQueueSave('server_aliases',
            aliasInp.value.split(/\s+/).map(s => s.trim()).filter(Boolean));
        const aliasRow = gsRow('server', L.server.aliases, L.server.aliases_hint, aliasInp,
            { flat: 'server_aliases' });
        aliasRow.classList.add('gs-alias-row');
        body.append(aliasRow);
    }},

    {t: 'Auth'},
    {sec: 'auth', lab: 'auth.api_key', hint: 'auth.api_key_hint', ctl: {
        k: 'text', field: 'api_key', flat: 'api_key', type: 'password',
        ph: 'auth.api_key_placeholder'}},
    {x: (body, L) => {
        const bpIn = document.createElement('input');
        bpIn.type = 'text'; bpIn.value = GS.base_path || '';
        bpIn.disabled = true;
        bpIn.title = C.tf('uplift.ui.set_at_launch_base_path_read_only', 'Set at launch (--base-path); read-only');
        body.append(gsRow('auth', L.auth.base_path, L.auth.base_path_hint, bpIn));
    }},
    {sec: 'auth', lab: 'auth.skip', hint: (L) => L.auth.skip_hint + ' ' + L.auth.skip_warning, ctl: {
        k: 'tog', field: 'skip_api_key_verification', flat: 'skip_api_key_verification'}},
    // SYNC-1 (upstream 1c3adf2 #4528): keyless inference — classic parity row,
    // red in classic because it opens /v1 to the network; confirm on enable.
    {sec: 'auth', lab: 'auth.keyless', hint: 'auth.keyless_hint', ctl: {
        k: 'tog', field: 'allow_unauthenticated_inference', flat: 'allow_unauthenticated_inference',
        confirm: 'auth.keyless_confirm'}},
    // UP-21: classic sub-API-key management (_settings.html:213-288,
    // dashboard.js generateSubKey/createSubKey/deleteSubKey). Named
    // inference-only keys on top of the master key; POST/DELETE
    // /admin/api/sub-keys persist server-side immediately, so this block
    // bypasses the dirty-queue and edits GS.auth.sub_keys in place.
    {x: (body, L) => {
        // FIRST-PAINT SAFETY (live QA 2026-10-25): this block used to build its
        // labels with `k.split('.').pop().replace(/_/g,' ')`, so whenever the
        // merged locale catalog had not resolved yet the panel printed the
        // fallback — i.e. developer scaffolding ('sub keys add', 'sub keys name
        // placeholder'). Every key below IS in the catalog; the strings were
        // only painted too early and the nodes were never registered, so
        // applyI18n could not repair them. Real English + the data-i18n hooks
        // (uplift.js repairs textContent, title and placeholder) fix both.
        // NEVER derive a fallback from a key name.
        const EN = {
            'settings.auth.sub_keys_label': 'Additional API Keys',
            'settings.auth.sub_keys_hint':
                'API-only keys. Cannot be used for admin login.',
            'settings.auth.sub_keys_add': 'Add',
            'settings.auth.sub_keys_create': 'Create',
            'settings.auth.sub_keys_cancel': 'Cancel',
            'settings.auth.sub_keys_delete': 'Delete',
            'settings.auth.sub_keys_delete_confirm':
                'Are you sure you want to delete this sub key?',
            'settings.auth.sub_keys_empty': 'No sub keys configured',
            'settings.auth.sub_keys_unnamed': 'Unnamed',
            'settings.auth.sub_keys_name_placeholder': 'Name (optional)',
            'settings.auth.sub_keys_key_placeholder': 'API key value',
            'settings.auth.sub_keys_generate_tooltip': 'Generate random key',
            'uplift.gs.sub_keys_generate': 'Generate',
            'js.error.api_key_min_length': 'API key must be at least 4 characters.',
            'js.error.api_key_no_whitespace': 'API key must not contain whitespace.',
        };
        const t = k => C.tf(k, EN[k] || k);
        // register a node for late catalog/locale re-resolution
        const reg = (node, key, kind) => {
            if (!node || !key) return node;
            if (kind === 'title') { node.dataset.i18nTitle = key; node.dataset.enTitle = EN[key] || ''; }
            else if (kind === 'ph') { node.dataset.i18nPh = key; node.dataset.enPh = EN[key] || ''; }
            else { node.dataset.i18n = key; node.dataset.en = EN[key] || ''; }
            return node;
        };
        const mk = (label, cls, fn, title, key) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'se-btn ' + (cls || ''); b.textContent = label;
            if (key) reg(b, key, 'text');
            if (title) b.title = title;
            if (fn) b.onclick = fn; return b; };
        const list = document.createElement('div'); list.className = 'gs-subkeys';
        const form = document.createElement('div');
        form.className = 'gs-subkey-form'; form.hidden = true;
        const nameIn = document.createElement('input');
        nameIn.type = 'text';
        nameIn.placeholder = t('settings.auth.sub_keys_name_placeholder');
        reg(nameIn, 'settings.auth.sub_keys_name_placeholder', 'ph');
        const keyIn = document.createElement('input');
        keyIn.type = 'text';
        keyIn.placeholder = t('settings.auth.sub_keys_key_placeholder');
        reg(keyIn, 'settings.auth.sub_keys_key_placeholder', 'ph');
        const err = document.createElement('span'); err.className = 'gs-err';
        // USER 2026-10-27 (item 1): the die-face glyph ('⚄') at se-btn size
        // read as a speck — an unreadable icon where classic uses a labelled
        // affordance. A plain text button is the honest fix; the tooltip
        // keeps the classic string.
        const genB = mk(t('uplift.gs.sub_keys_generate'), 'act gs-genkey', () => {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            keyIn.value = 'omlx-' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
                .map(b => chars[b % chars.length]).join('');
        }, t('settings.auth.sub_keys_generate_tooltip'));
        reg(genB, 'settings.auth.sub_keys_generate_tooltip', 'title');
        reg(genB, 'uplift.gs.sub_keys_generate', 'text');
        const closeForm = () => { form.hidden = true; keyIn.value = nameIn.value = ''; err.textContent = ''; };
        const createB = mk(t('settings.auth.sub_keys_create'), 'act', () => {
            err.textContent = '';
            const v = keyIn.value || '';
            if (v.length < 4) { err.textContent = t('js.error.api_key_min_length'); return; }
            if (/\s/.test(v)) { err.textContent = t('js.error.api_key_no_whitespace'); return; }
            GLUE.postJson(`${API}/admin/api/sub-keys`, { key: v, name: nameIn.value.trim() })
                .then(d => {
                    const arr = (GS.auth && GS.auth.sub_keys) || (GS.auth.sub_keys = []);
                    if (d && d.sub_key) arr.push(d.sub_key);
                    closeForm(); render();
                })
                .catch(e => { err.textContent = D.errText(e); });
        });
        const cancelB = mk(t('settings.auth.sub_keys_cancel'), '', closeForm,
            null, 'settings.auth.sub_keys_cancel');
        createB.dataset.i18n = 'settings.auth.sub_keys_create';
        createB.dataset.en = EN['settings.auth.sub_keys_create'];
        form.append(nameIn, keyIn, genB, createB, cancelB, err);
        const addB = mk(t('settings.auth.sub_keys_add'), 'act', () => { form.hidden = false; keyIn.focus(); },
            null, 'settings.auth.sub_keys_add');
        const mask = () => '*****';   // fixed-width mask (user 2026-10-27):
        // the old per-key-length mask wrapped long omlx- keys onto 3 lines
        // and printed SHORT keys (<=8) in FULL. Always five bullets, whatever
        // the value; the eye still reveals the real key on demand.
        function render() {
            list.replaceChildren();
            const keys = (GS.auth && GS.auth.sub_keys) || [];
            if (!keys.length) {
                const e2 = document.createElement('div'); e2.className = 'dim';
                e2.textContent = t('settings.auth.sub_keys_empty');
                reg(e2, 'settings.auth.sub_keys_empty', 'text');
                list.append(e2);
            }
            for (const sk of keys) {
                const row = document.createElement('div'); row.className = 'urow settings';
                const nm = GLUE.cell(sk.name || t('settings.auth.sub_keys_unnamed'));
                nm.className = 'uname';
                const when = GLUE.cell(sk.created_at
                    ? new Date(sk.created_at).toLocaleDateString() : '');
                when.className = 'diffslot';
                const ctl = GLUE.cell(''); ctl.className = 'gctl';
                const val = document.createElement('code'); val.textContent = mask(sk.key);
                let shown = false;
                const eye = mk('\uD83D\uDC41', '', () => {
                    shown = !shown; val.textContent = shown ? sk.key : mask(sk.key); });
                const del = mk(t('settings.auth.sub_keys_delete'), 'warn', () => {
                    if (!window.confirm(t('settings.auth.sub_keys_delete_confirm'))) return;
                    // DELETE with a JSON body - classic's deleteSubKey
                    // payload; GLUE.deleteJson takes no body.
                    fetch(`${API}/admin/api/sub-keys`, { // domkit-exempt
                        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: sk.key }) })
                        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                        .then(() => {
                            const arr = (GS.auth && GS.auth.sub_keys) || [];
                            const i = arr.indexOf(sk); if (i >= 0) arr.splice(i, 1);
                            render();
                        })
                        .catch(e => GLUE.toast(D.errText(e), 'error'));
                });
                ctl.append(val, eye, reg(del, 'settings.auth.sub_keys_delete', 'text'));
                row.append(nm, when, ctl);
                list.append(row);
            }
        }
        const skRow = gsRow('auth', t('settings.auth.sub_keys_label'),
            t('settings.auth.sub_keys_hint'), addB);
        // no key on the 'Unnamed' cell: a real name would be overwritten by
        // the re-resolution pass, and that cell shows data, not chrome
        reg(skRow.querySelector('.uname'), 'settings.auth.sub_keys_label', 'text');
        reg(skRow.querySelector('small'), 'settings.auth.sub_keys_hint', 'text');
        body.append(skRow);
        render();
        body.append(list, form);
    }},

    {t: 'Models'},
    {x: (body, L) => {
        const dirs = gsGet('model', 'model_dirs') || [];
        const dl = document.createElement('div');
        dl.className = 'gs-dirs';
        dirs.forEach((d, i) => {
            const one = document.createElement('div');
            one.className = 'gs-dir';
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = d;
            inp.placeholder = i === 0 ? L.model.ph_primary : L.model.ph_additional;
            const rm = document.createElement('button');
            rm.className = 'se-btn act'; rm.textContent = '\u00d7';
            rm.style.display = dirs.length > 1 ? '' : 'none';
            rm.onclick = async () => {
                const nd = dirs.filter((_, j) => j !== i);
                gsQueueSave('model_dirs', nd);
            };
            inp.onchange = async () => {
                const nd = dirs.slice(); nd[i] = inp.value;
                gsQueueSave('model_dirs', nd);
            };
            one.append(inp, rm);
            dl.append(one);
        });
        const add = document.createElement('button');
        add.className = 'se-btn act'; add.textContent = C.tf('uplift.gs.model.add_directory', '+ add directory');
        add.onclick = async () => {
            gsQueueSave('model_dirs', dirs.concat(''));
        };
        dl.append(add);
        body.append(gsRow('model', L.model.dirs, '', dl));
    }},
    {sec: 'model', lab: 'model.fallback', hint: 'model.fallback_desc', ctl: {
        // bool in the server schema — a checkbox like every binary option
        // (audit 2026-10-02: this was the only bool left as text input)
        k: 'tog', field: 'model_fallback', flat: 'model_fallback'}},
    {sec: 'model', lab: 'model.hide_helper', hint: 'model.hide_helper_desc', ctl: {
        k: 'tog', field: 'hide_helper_models', flat: 'hide_helper_models'}},
    {sec: 'model', lab: 'model.hf_cache', hint: 'model.hf_cache_desc', ctl: {
        k: 'tog', sec: 'huggingface', field: 'hf_cache_enabled', flat: 'hf_cache_enabled'}},
    {x: (body, L) => {
        const hfp = GLUE.cell((GS.huggingface || {}).hf_cache_path || '\u2014');
        hfp.className = 'dim gs-roval';
        // gs-roval = read-only value: the cell right-justifies and clips, so a
        // long cache path lost its BEGINNING; the rule lets it wrap instead
        body.append(gsRow('model', C.tf('uplift.gs.model.hf_path_label', 'HF cache path'), '', hfp));
    }},
    {sec: 'model', lab: 'model.idle', hint: 'model.idle_desc', ctl: {
        k: 'sel', sec: 'idle_timeout', field: 'idle_timeout_seconds', nullTo: '',
        flat: 'idle_timeout_seconds', opts: 'model.idle_opts'}},

    {sec: 'gen', lab: 'gen.temperature', hint: 'gen.temperature_hint', ctl: {
        k: 'range', sec: 'sampling', field: 'temperature', flat: 'sampling_temperature',
        min: 0, max: 2, step: 0.1}},
    {sec: 'gen', lab: 'gen.top_p', hint: 'gen.top_p_hint', ctl: {
        k: 'range', sec: 'sampling', field: 'top_p', flat: 'sampling_top_p',
        min: 0, max: 1, step: 0.05}},
    {sec: 'gen', lab: 'gen.top_k', hint: 'gen.top_k_hint', ctl: {
        k: 'num', sec: 'sampling', field: 'top_k', flat: 'sampling_top_k', min: 0}},
    {sec: 'gen', lab: 'gen.max_tokens', ctl: {
        k: 'num', sec: 'sampling', field: 'max_tokens', flat: 'sampling_max_tokens',
        min: 1, max: 131072}},
    {sec: 'gen', lab: 'gen.max_ctx', hint: 'gen.max_ctx_hint', ctl: {
        k: 'num', sec: 'sampling', field: 'max_context_window', flat: 'sampling_max_context_window',
        min: 1, max: 2097152}},
    {sec: 'gen', lab: 'gen.max_policy', hint: 'gen.max_policy_hint', ctl: {
        k: 'num', sec: 'sampling', field: 'max_context_window_policy',
        flat: 'sampling_max_context_window_policy', min: 1, max: 2097152, ph: 'None'}},
    {sec: 'gen', lab: 'gen.rep_pen', hint: 'gen.rep_pen_hint', ctl: {
        k: 'num', sec: 'sampling', field: 'repetition_penalty', flat: 'sampling_repetition_penalty',
        min: 1, step: 0.05}},
    {env: ['mtp']},        // ENV-2: MTP experimental tunables join their group

    {t: 'Resource Management'},
    {sec: 'res', lab: 'res.max_conc', hint: 'res.max_conc_hint', ctl: {
        // U7: in GS_RESTART_FIELDS but only showed a bare '!' — full badge.
        // #3765 live-apply: the badge rides distributed_inference_active,
        // exactly like classic's x-show (cluster ranks reload themselves).
        k: 'num', sec: 'scheduler', field: 'max_concurrent_requests',
        flat: 'max_concurrent_requests', min: 1},
     opts: {flat: 'max_concurrent_requests', badge: () => gsDistributedActive()}},
    {sec: 'res', lab: 'res.batch', hint: 'res.batch_hint', ctl: {
        k: 'num', sec: 'scheduler', field: 'embedding_batch_size',
        flat: 'embedding_batch_size', min: 1}},
    {sec: 'res', lab: 'res.chunked', hint: 'res.chunked_desc', ctl: {
        k: 'tog', sec: 'scheduler', field: 'chunked_prefill', flat: 'chunked_prefill'}},
    {sec: 'res', lab: 'res.prio', ctl: {
        k: 'sel', sec: 'scheduler', field: 'prefill_priority', flat: 'prefill_priority',
        opts: () => [['speed', GS_LABELS.res.prio_speed], ['context', GS_LABELS.res.prio_context]]}},
    {sec: 'res', lab: 'res.fairness', hint: 'res.fairness_desc', ctl: {
        k: 'tog', sec: 'scheduler', field: 'decode_fairness', flat: 'decode_fairness'}},
    {sec: 'res', lab: 'res.guard', hint: 'res.guard_desc', ctl: {
        k: 'tog', sec: 'memory', field: 'prefill_memory_guard', flat: 'memory_prefill_memory_guard'}},
    {sec: 'res', lab: 'res.tier', ctl: {
        k: 'sel', sec: 'memory', field: 'memory_guard_tier', flat: 'memory_guard_tier',
        opts: 'res.tiers'}},
    // UP-41(10): tier description / ceiling breakdown / wired-limit warning
    // over system.memory_guard_preview (classic _settings.html:485-510);
    // contents + visibility refresh via gsGuardSync on every edit.
    {x: gsGuardBlock},
    {sec: 'res', lab: 'res.custom', show: (ctx) => ctx.tier === 'custom', ctl: {
        k: 'num', sec: 'memory', field: 'memory_guard_custom_ceiling_gb',
        flat: 'memory_guard_custom_ceiling_gb', min: 1, step: 1, ph: 'res.custom_ph',
        attach: gsCeilingSeed}},
    {env: ['scheduler', 'memory']},

    {sec: 'cache', lab: 'cache.enabled', hint: 'cache.enabled_hint', ctl: {
        k: 'tog', sec: 'cache', field: 'enabled', flat: 'cache_enabled'}},
    {sec: 'cache', lab: 'cache.hot_only', hint: 'cache.hot_only_hint', ctl: {
        k: 'tog', field: 'hot_cache_only', flat: 'hot_cache_only'}},
    {sec: 'cache', lab: 'cache.ssd_dir', ctl: {k: 'text', field: 'ssd_cache_dir', flat: 'ssd_cache_dir'}},
    // UP-41(10): classic's % sliders with Auto|Fixed cold-cache modes and
    // the '0 = disabled' hot semantics (see the ALIGNMENT comments in the
    // builders — blank inputs are normalized, every edit writes an
    // explicit 'auto' / '0' / '<n>GB' string).
    {x: gsColdCacheRow},
    {x: gsHotCacheRow},

    {t: 'Integrations'},
    {sec: 'claude_code', lab: 'cc.mode', hint: 'cc.mode_hint', ctl: {
        k: 'sel', sec: 'claude_code', field: 'mode', flat: 'claude_code_mode',
        curFn: (ctx) => ctx.ccLocal ? 'local' : 'cloud',
        opts: () => [['local', GS_LABELS.cc.local], ['cloud', GS_LABELS.cc.cloud]]}},
    {x: (body, L, ctx) => {
        if (!ctx.ccLocal) return;
        const dl = document.createElement('datalist'); dl.id = 'cc-models';
        body.append(dl);
        GLUE.fetchJson(`${API}/admin/api/models`).then(d => {
            for (const m of d.models || []) {
                const o2 = document.createElement('option');
                o2.value = m.name || m.id || ''; dl.append(o2);
            }
        }).catch(() => { /* picker list optional */ });
        for (const [lab, field] of [['opus', 'opus_model'], ['sonnet', 'sonnet_model'], ['haiku', 'haiku_model']]) {
            body.append(gsRow('claude_code', L.cc[lab], '',
                gsText('claude_code', field, 'claude_code_' + lab, L,
                       { placeholder: L.cc.ph, list: 'cc-models' }),
                { flat: 'claude_code_' + lab }));
        }
        // SYNC-1 (upstream f27ba3d #3592): Claude Desktop toggle — classic
        // nests it INSIDE the local-mode branch (blocks/_claude_code.html
        // x-show mode==='local'), hence it lives in this gated builder.
        // No confirm: classic warns inline (desktop_side_effect) instead.
        // The Reapply/Restore command buttons are a dedicated endpoint
        // surface (/admin/api/claude-desktop/*) — not mirrored yet (finding
        // recorded in the SYNC-1 Run log).
        body.append(gsRow('claude_code', L.cc.desktop, L.cc.desktop_hint,
            gsToggle('claude_code_desktop_enabled', !!gsGet('claude_code', 'desktop_enabled')),
            { flat: 'claude_code_desktop_enabled' }));
        // UP-28: classic's Claude Desktop command surface
        // (dashboard.js:4167-4210) — configured-status line + Re-apply
        // (configure while enabled, restore otherwise) + explicit Restore,
        // with classic's working labels and no confirm dialogs (parity).
        const cdRow = document.createElement('div');
        cdRow.className = 'urow settings';
        const cdLab = GLUE.cell(C.tf('status.claude_code.desktop', 'Claude Desktop'));
        cdLab.className = 'uname';
        const cdSlot = document.createElement('span'); cdSlot.className = 'diffslot';
        const cdCtl = GLUE.cell(''); cdCtl.className = 'gctl';
        const cdStatus = document.createElement('span');
        cdStatus.className = 'dim'; cdStatus.style.marginRight = '8px';
        const cdBtn = (label, title) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'se-btn act';
            b.textContent = label; b.title = title; return b;
        };
        const busy = (btn, txt) => { btn.disabled = !txt; if (txt) btn.dataset.was = btn.textContent, btn.textContent = txt; else if (btn.dataset.was) btn.textContent = btn.dataset.was; };
        const reapply = cdBtn(C.tf('status.claude_code.desktop_reapply', 'Re-apply configuration'), '');
        const restore = cdBtn(C.tf('status.claude_code.desktop_restore', 'Restore configuration'), '');
        const setStat = ok => { cdStatus.textContent = ok
            ? C.tf('status.claude_code.desktop_configured', 'Configured')
            : C.tf('status.claude_code.desktop_not_configured', 'Not configured'); };
        // classic updates the status silently on re-apply (no toast);
        // only the explicit Restore carries success/failure messages.
        reapply.onclick = () => {
            busy(reapply, C.tf('status.claude_code.desktop_working', 'Applying...'));
            GLUE.postJson(`${API}/admin/api/claude-desktop/` +
                (gsGet('claude_code', 'desktop_enabled') ? 'configure' : 'restore'), {})
                .then(d => setStat(!!(d && d.configured)))
                .catch(e => GLUE.toast(D.errText(e), 'error'))
                .finally(() => busy(reapply, ''));
        };
        restore.onclick = () => {
            busy(restore, C.tf('status.claude_code.desktop_restoring', 'Restoring...'));
            GLUE.postJson(`${API}/admin/api/claude-desktop/restore`, {})
                .then(d => { setStat(!!(d && d.configured));
                    GLUE.toast(C.tf('status.claude_code.desktop_restore_success', 'Configuration restored')); })
                .catch(() => GLUE.toast(C.tf('status.claude_code.desktop_restore_error', 'Restore failed'), 'error'))
                .finally(() => busy(restore, ''));
        };
        cdCtl.append(cdStatus, reapply, restore);
        cdRow.append(cdLab, cdSlot, cdCtl);
        body.append(cdRow);
        GLUE.fetchJson(`${API}/admin/api/claude-desktop/status`)
            .then(d => setStat(!!(d && d.configured))).catch(() => {});
    }},

    {sec: 'mcp', lab: 'mcp.path', ctl: {k: 'text', field: 'config_path', flat: 'mcp_config', ph: 'mcp.ph'},
     opts: {badge: true, flat: 'mcp_config'}},
    {sec: 'mcp', lab: 'mcp.expose', hint: 'mcp.expose_hint', ctl: {
        k: 'tog', field: 'expose_tools', flat: 'mcp_expose_tools'}},

    {sec: 'usage', lab: 'usage.history', hint: 'usage.history_hint', ctl: {
        k: 'tog', field: 'usage_history', flat: 'usage_history'}},
    {sec: 'net', lab: 'net.hf_ep', hint: 'net.hf_ep_hint', ctl: {
        k: 'text', sec: 'huggingface', field: 'endpoint', flat: 'hf_endpoint', ph: 'https://huggingface.co'}},
    {sec: 'net', lab: 'net.ms_ep', hint: 'net.ms_ep_hint', ctl: {
        k: 'text', sec: 'modelscope', field: 'endpoint', flat: 'ms_endpoint', ph: 'https://www.modelscope.cn'}},
    {sec: 'net', lab: 'net.http_proxy', hint: 'net.proxy_hint', ctl: {
        k: 'text', sec: 'network', field: 'http_proxy', flat: 'network_http_proxy'}},
    {sec: 'net', lab: 'net.https_proxy', hint: 'net.proxy_hint', ctl: {
        k: 'text', sec: 'network', field: 'https_proxy', flat: 'network_https_proxy'}},
    {sec: 'net', lab: 'net.no_proxy', hint: 'net.no_proxy_hint', ctl: {
        k: 'text', sec: 'network', field: 'no_proxy', flat: 'network_no_proxy'}},
    {sec: 'net', lab: 'net.ca_bundle', hint: 'net.ca_hint', ctl: {
        k: 'text', sec: 'network', field: 'ca_bundle', flat: 'network_ca_bundle'}},

    {t: 'Advanced'},
    {sec: 'adv', lab: 'adv.distributed_enabled', hint: 'adv.distributed_hint', ctl: {
        k: 'tog', sec: 'server', field: 'distributed_inference_enabled',
        flat: 'distributed_inference_enabled'}, opts: {flat: 'distributed_inference_enabled', badge: true}},
    {sec: 'adv', lab: 'adv.burst', hint: 'adv.burst_hint', ctl: {
        k: 'sel', sec: 'server', field: 'burst_decode_mode', flat: 'burst_decode_mode', opts: 'adv.burst_opts'}},
    {sec: 'adv', lab: 'adv.sse', hint: 'adv.sse_hint', ctl: {
        k: 'sel', sec: 'server', field: 'sse_keepalive_mode', flat: 'sse_keepalive_mode', opts: 'adv.sse_opts'}},
    {sec: 'adv', lab: 'adv.mid_sys', hint: 'adv.mid_sys_hint', ctl: {
        k: 'tog', sec: 'server', field: 'preserve_mid_system_cache', flat: 'preserve_mid_system_cache'}},
    // SYNC-1 (upstream 3c39990): the 'adv.wide_proj' row is GONE from this
    // page — qwen4_gdn_decode_wide_proj moved out of GlobalSettingsRequest
    // into ModelSettingsRequest, so it is a per-model Advanced row now
    // (uplift_mmeditor.js, classic _modal_model_settings.html:726-735). The
    // adv.wide_proj / adv.wide_proj_hint locale keys stay and are reused
    // there; not sending the global key means "keep" server-side.
    // SYNC-1: upstream server.gpu_keep_warm_interval (live-applied on save,
    // no restart badge — classic runtime_applied). Not on the classic page;
    // uplift exposes it because users tune it (settings.json carries it).
    {sec: 'adv', lab: 'adv.keep_warm', hint: 'adv.keep_warm_hint', ctl: {
        k: 'num', sec: 'server', field: 'gpu_keep_warm_interval',
        flat: 'gpu_keep_warm_interval', min: 0, step: 0.1}},
    {sec: 'adv', lab: 'adv.audio', hint: 'adv.audio_hint', ctl: {
        k: 'num', sec: 'server', field: 'max_audio_upload_size', flat: 'max_audio_upload_size', min: 1}},
    {sec: 'adv', lab: 'adv.ane', hint: 'adv.ane_hint', ctl: {
        k: 'tog', sec: 'cache', field: 'ane_compile_cache', flat: 'ane_compile_cache'}},
    {sec: 'adv', lab: 'adv.wt', hint: 'adv.wt_hint', ctl: {
        k: 'tog', sec: 'cache', field: 'hot_cache_write_through', flat: 'hot_cache_write_through'}},
    {sec: 'adv', lab: 'adv.blocks', hint: 'adv.blocks_hint', ctl: {
        k: 'num', sec: 'cache', field: 'initial_cache_blocks', flat: 'initial_cache_blocks', min: 1}},
    {sec: 'adv', lab: 'adv.gdn_store', hint: 'adv.gdn_store_hint', ctl: {
        k: 'sel', sec: 'cache', field: 'gdn_snapshot_storage', flat: 'gdn_snapshot_storage',
        opts: 'adv.gdn_store_opts'}},
    // Classic parity (user round): the SSD write-buffer and precision rows
    // are ALWAYS visible; classic disables the control (embedded storage,
    // hot-cache-only, or cache off) instead of hiding the row. gsDisabledSync
    // below mirrors classic's :disabled expression.
    {sec: 'adv', lab: 'adv.gdn_pend', hint: 'adv.gdn_pend_hint', ctl: {
        k: 'text', sec: 'cache', field: 'gdn_ssd_pending_max_size',
        flat: 'gdn_ssd_pending_max_size', ph: '512MB'}},
    {sec: 'adv', lab: 'adv.gdn_prec', hint: 'adv.gdn_prec_hint', ctl: {
        k: 'sel', sec: 'cache', field: 'gdn_sidecar_precision', flat: 'gdn_sidecar_precision',
        opts: 'adv.gdn_prec_opts',
}},
    {env: ['engine']},     // ENV-2: engine tunables join Advanced
];

/* FE-6 step 3: one show-predicate pass. Compares the rendered gated rows
   against GS_SPEC truth and applies the SMALLEST update:
     - exactly one gated row appears/disappears AND its section box is
       not left headerless -> add/remove that row in place
     - anything else structural (cc mode, box emptied) -> full rebuild
   The page is still a staged DOM in v1 order, so the anchor for a gated
   row is 'the last rendered gated row before it' (spec rows append in
   order; ungated rows are never toggled). */
const GS_GATED = ['memory_guard_custom_ceiling_gb', 'gdn_ssd_pending_max_size',
                  'gdn_sidecar_precision'];
/* queued-but-unsaved edits win over the server baseline (gsDirty holds the
   pending value; gsGet reads GS + shadow but not the dirty queue) */
function gsEffFlat(flat) {
    if (flat in gsDirty) return gsDirty[flat];
    const map = GS_MAP[flat];
    return map ? gsGet(map[0], map[1]) : undefined;
}
/* classic config.effective_gdn_ssd_split_enabled: auto resolves to SSD
   sidecar when the SSD cache is on and hot-cache-only is off */
function gsGdnEff() {
    const gdn = gsEffFlat('gdn_snapshot_storage');
    if (gdn === 'embedded' || gdn === 'ssd_sidecar') return gdn;
    return (gsEffFlat('cache_enabled') && !gsEffFlat('hot_cache_only'))
        ? 'ssd_sidecar' : 'embedded';
}
/* Classic shows the two SSD rows ALWAYS and disables the control when
   storage is embedded / hot-cache-only / cache off (the :disabled binding).
   Re-run after every render, queued edit, revert and select change. */
function gsDisabledSync() {
    const dis = gsGdnEff() === 'embedded';
    for (const f of ['gdn_ssd_pending_max_size', 'gdn_sidecar_precision']) {
        const row = document.querySelector('#gs-body [data-flat="' + f + '"]');
        const ctl = row && row.querySelector('input,select');
        if (ctl) ctl.disabled = dis;
    }
    // UP-19 (7): classic refuses skip-api-key-verification whenever the bind
    // leaves localhost — lock the row (with the reason) instead of shipping
    // a guaranteed-400/ignored edit.
    const srow = document.querySelector('#gs-body [data-flat="skip_api_key_verification"]');
    const sctl = srow && srow.querySelector('input');
    if (sctl) {
        const loop = window.UpliftGSpec.isLoopbackBindHost(gsValFlat('host') || '');
        sctl.disabled = !loop;
        srow.title = loop ? '' : C.tf('js.error.api_key_required_network',
            'An API key is required when the server is reachable beyond localhost.');
    }
}
function gsBodySanitize() {
    // UP-19 (6): classic gives the API-key row an eye button. Uplift keeps
    // its stricter diff-masking (the CHANGES rail never prints the value);
    // this only reveals the field the user is typing into.
    for (const inp of document.querySelectorAll('#gs-body input[type=password]')) {
        if (inp.__revealDone) continue;
        inp.__revealDone = true;
        const eye = document.createElement('button');
        eye.type = 'button'; eye.className = 'se-btn gs-eye'; eye.textContent = '👁';
        eye.title = 'Show / hide the value';
        eye.onclick = () => { inp.type = inp.type === 'password' ? 'text' : 'password'; };
        const cell = inp.closest('.gctl') || inp.parentElement;
        if (cell) cell.append(eye);
    }
}
function gsCtxNow() {
    // MGC-1 (user 2026-10-21): gated rows follow the QUEUED edit, not the
    // server baseline — picking a tier is the moment its child row must
    // appear. (The ceiling used to read the saved value only, so Custom +
    // ceiling was unreachable: the row stayed hidden until save, and the
    // save itself 400s because the ceiling cannot be sent unset.)
    return {
        ccLocal: (gsEffFlat('claude_code_mode') || 'local') !== 'cloud',
        tier: gsEffFlat('memory_guard_tier'),
        gdn: gsEffFlat('gdn_snapshot_storage'),
        gdnEff: gsGdnEff(),
        prec: gsEffFlat('gdn_sidecar_precision'),
    };
}
/* MGC-1: the Custom ceiling starts at the server's own auto policy —
   80% of physical RAM (system.total_memory_bytes rides this same payload;
   vanilla derives auto_limit_bytes exactly this way). Returns GiB, or null
   when the box reports no memory size (stay honest-empty, never guess). */
function gsCeilingDefault() {
    const total = Number((GS.system || {}).total_memory_bytes);
    if (!(total > 0)) return null;
    return Math.max(1, Math.floor(total * 0.8 / (1024 * 1024 * 1024)));
}
/* Seed an UNSET ceiling the moment the row materializes: queued as an
   ordinary staged edit (dirty chip '0 → N', revert stays reachable), so
   the first SAVE after picking Custom carries a real number and the
   custom-with-zero 400 cannot happen. A value the user typed or the server
   stored is never overwritten. */
function gsCeilingSeed(ctl) {
    const f = 'memory_guard_custom_ceiling_gb';
    if (f in gsDirty) return;
    const cur = gsEffFlat(f);
    if (cur !== null && cur !== undefined && cur !== '' && Number(cur) > 0) return;
    const d = gsCeilingDefault();
    if (d === null) return;
    if (ctl) ctl.value = String(d);
    gsQueueSave(f, d);
}
function gsVisibilitySync(changedFlat) {
    const ctx = gsCtxNow();
    const want = {}, have = {};
    for (const f of GS_GATED) {
        const item = GS_SPEC.find(i => i.ctl && i.ctl.flat === f);
        want[f] = !!(item && (!item.show || item.show(ctx)));
        have[f] = !!document.querySelector('#gs-body [data-flat="' + f + '"]');
    }
    const toAdd = GS_GATED.filter(f => want[f] && !have[f]);
    const toDel = GS_GATED.filter(f => !want[f] && have[f]);
    gsDisabledSync();   // storage/cache toggles move the SSD rows' disabled state
    if (!toAdd.length && !toDel.length) return;
    if (changedFlat === 'claude_code_mode' || toAdd.length + toDel.length > 1) {
        renderGlobalSettings();   // structural or ambiguous: rebuild, it is honest
        return;
    }
    if (toDel.length === 1) {
        document.querySelector('#gs-body [data-flat="' + toDel[0] + '"]').remove();
    } else {
        const f = toAdd[0];
        const item = GS_SPEC.find(i => i.ctl && i.ctl.flat === f);
        const row = gsSpecRow(item, GS_LABELS, ctx);
        const i = GS_GATED.indexOf(f);
        let anchor = null;
        for (let j = i - 1; j >= 0; j--) {
            const a = document.querySelector('#gs-body [data-flat="' + GS_GATED[j] + '"]');
            if (a) { anchor = a; break; }
        }
        const host = anchor ? anchor.parentNode : rowHostBox(gsSpecTitleOf(f));
        if (!host) { renderGlobalSettings(); return; }
        if (anchor) anchor.insertAdjacentElement('afterend', row);
        else host.append(row);
        // queued edits still apply to a freshly materialized row
        if (f in gsDirty) markFieldDirty(f, gsDirty[f]);
    }
    gsMarkSections();
}
function gsSpecTitleOf(flat) {
    const idx = GS_SPEC.findIndex(i => i.ctl && i.ctl.flat === flat);
    for (let j = idx; j >= 0; j--) if (GS_SPEC[j].t) return GS_SPEC[j].t;
    return null;
}
function rowHostBox(title) {
    for (const box of document.querySelectorAll('#gs-body .gs-box')) {
        if (box.dataset.sec === title) return box.querySelector('.gs-box-body');
    }
    return null;
}

function renderGlobalSettings() {
    // UP-19 (4): a restart still owed survives a page reload (classic loses
    // it too; uplift's button flow depends on it)
    try {
        if (!gsRestartPending && sessionStorage.getItem('uplift.gs.restartPending') === '1')
            gsRestartPending = true;
    } catch (_) {}
    gsTabValid();
    const body = document.createElement('div');   // staged; grouped into boxes below
    body.textContent = '';
    const L = GS_LABELS;
    // MGC-1: ONE context source — the surgical path (gsVisibilitySync) and
    // this full rebuild must gate rows on the identical effective values,
    // or a queued tier flips the row in one path and not the other.
    const ctx = gsCtxNow();
    // (the old "Global" restart-notice box was removed; the RESTART chip,
    //  red field marks and the RESTART SERVER button carry that meaning now)
    let pendingWarnRow = null;
    for (const item of GS_SPEC) {
        if (item.t) { body.append(gsTitle(item.t)); continue; }
        if (item.x) { item.x(body, L, ctx); continue; }
        if (item.env) { for (const r of envRows(...item.env)) body.append(r); continue; }
        if (item.show && !item.show(ctx)) continue;
        const row = gsSpecRow(item, L, ctx);
        body.append(row);
    }
    // gdn precision warning: attach after the row exists (needs .uname).
    // Effective mode (auto + SSD cache resolves to sidecar), not just the
    // explicit ssd_sidecar label — precision only bites when sidecars exist.
    if (ctx.gdnEff === 'ssd_sidecar' && ['int8', 'rht_int8'].includes(ctx.prec)) {
        const prow = body.querySelector('[data-flat="gdn_sidecar_precision"]');
        if (prow) {
            const w = document.createElement('small');
            w.className = 'fhint warn'; w.textContent = L.adv.gdn_prec_warning;
            prow.querySelector('.uname').append(w);
        }
    }

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
            box.dataset.sec = n.textContent.trim();   // FE-6: target for surgical updates
            box.dataset.slug = n.dataset.slug || '';  // GS-TAB: filter key
            box.hidden = gsTab !== 'all' && box.dataset.slug !== gsTab;
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
    // GS-TAB: ALL / section strip (built AFTER boxes carry slugs, BEFORE the
    // first badge pass; clicking a tab re-enters this render with the queue
    // re-applied, so dirty edits survive a tab switch)
    gsBuildTabs(wrap);
    // section header click scrolls to the SAVE bar (item 10); header also
    // carries the section dirty/restart state color (item 8).
    // UP-41(11): every header gets classic's copy-link button
    // (_settings.html:61-66 settingsCopyAnchor -> #settings-x anchor).
    // UP-41(12): the Advanced header is a disclosure instead of a scroll
    // target — collapsed by default, chevron flips, rows stay in the DOM
    // (dirty queue untouched; same doctrine as the hidden GS-TAB boxes).
    for (const h of wrap.querySelectorAll('.gs-box-title')) {
        h.classList.add('clickable');
        const box = h.parentElement;
        const slug = box.dataset.slug || '';
        const cp = document.createElement('button');
        cp.type = 'button'; cp.className = 'se-btn gs-copylink';
        cp.textContent = '\u29C9';   // ⧉
        cp.title = C.tf('settings.sections.copy_link', 'Copy link to this section');
        cp.setAttribute('aria-label', cp.title);
        cp.onclick = (e) => { e.stopPropagation(); gsCopySectionLink(cp, slug); };
        h.append(cp);
        if (slug === 'advanced') {
            const chev = document.createElement('span');
            chev.className = 'gs-advchev';
            h.append(chev);
            const bbody = box.querySelector('.gs-box-body');
            const paintAdv = () => {
                const collapsed = gsTab === 'all' && !gsAdvOpen();
                if (bbody) bbody.hidden = collapsed;
                h.classList.toggle('gs-adv-closed', collapsed);
                // USER 2026-10-27 (item 3): the glyph + its flip moved to CSS
                // (::before content + .gs-adv-closed rotation) so the chevron
                // reads as a disclosure control and cannot desync from the
                // fold state; JS only toggles the class now.
                h.title = collapsed
                    ? C.tf('uplift.gs.adv.open', 'Expand Advanced settings')
                    : C.tf('uplift.gs.adv.close', 'Collapse Advanced settings');
            };
            h.onclick = () => {
                const opening = !gsAdvOpen();
                gsAdvSetOpen(opening);
                paintAdv();
                if (opening) {
                    // The rows materialise at the bottom of the last column,
                    // off-screen: an expand that does not move the view reads
                    // as a dead button (user 2026-10-27). Bring the ADVANCED
                    // BOX under the sticky header — the savebar is further
                    // down the page and centering it still left the header and
                    // the first rows above the fold. Collapsing moves nothing.
                    gsScrollBoxIntoView(box);
                }
            };
            paintAdv();
        } else {
            h.onclick = () => {
                const bar = document.getElementById('gs-savebar');
                if (bar) { bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                           const b = gsSaveBtn(); if (b) b.focus(); }
            };
        }
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
        // ENV-3: reference button at the left end of the bottom-right bar —
        // documents every env-only omlx knob in a searchable modal
        const envb = document.createElement('button');
        envb.id = 'gs-envcat'; envb.className = 'se-btn';
        envb.style.marginRight = 'auto';   // row is flex-end: pin this one left
        envb.textContent = C.tf('uplift.envcat.button', 'ENVIRONMENT VARIABLES');
        envb.title = C.tf('uplift.envcat.button_hint',
            'Environment-only omlx knobs, what they do, and which are set');
        envb.onclick = () => openEnvCatalog(false);
        const b = document.createElement('button');
        b.id = 'gs-save'; b.className = 'se-btn savebtn'; b.textContent = 'SAVE';
        b.onclick = gsSaveOrRestart;
        const clr = document.createElement('button');
        clr.id = 'gs-discard'; clr.className = 'se-btn'; clr.textContent = 'DISCARD';
        clr.onclick = () => {
            Object.keys(gsDirty).forEach(k => delete gsDirty[k]);
            renderGlobalSettings(); gsUpdateSaveBtn(); renderDirtyList();
        };
        rowb.append(envb, clr, b);
        bar.append(changes, rowb);
        wrap.parentElement.append(bar);
    }
    // re-apply still-queued dirty marks after re-render
    for (const flat of Object.keys(wasDirty)) {
        markFieldDirty(flat, wasDirty[flat]);
        // re-render rebuilds inputs from the server baseline; put the
        // queued (unsaved) value back so the edit stays visible while typing
        const row = document.querySelector('#gs-body [data-flat="' + flat + '"]');
        if (row && row.__gsApply) { row.__gsApply(wasDirty[flat]); continue; }
        const ctl = row && (row.querySelector('input[type=checkbox]') || row.querySelector('select')
            || row.querySelector('textarea') || row.querySelector('input'));
        if (ctl) {
            if (ctl.type === 'checkbox') ctl.checked = !!wasDirty[flat];
            else ctl.value = wasDirty[flat] == null ? '' : wasDirty[flat];
        }
    }
    gsDisabledSync();   // classic-parity :disabled on the two SSD rows
    gsBodySanitize();   // UP-19 (6): password rows get the classic eye toggle
    gsGuardSync();      // UP-41(10): memory-guard readout over the new DOM
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
    // GS-TAB: a filtered-out box must not consume a column slot — keep it
    // parked on the wrap (display:none) and lay out only what is visible
    const filtered = items.filter(it => !(it.classList && it.classList.contains('gs-box') && it.hidden));
    for (const it of items) if (filtered.indexOf(it) < 0) wrap.append(it);
    items = filtered;
    if (!items.length) return;
    // alternate box shading by GLOBAL index (nth-of-type restarts per column)
    items.forEach((it, i) => it.classList.toggle('alt', i % 2 === 1));
    for (const c of wrap.querySelectorAll('.gs-col')) c.remove();
    // TWO columns at most (user 2026-10-27). The old 380px target packed
    // three columns into the 1342px wrap, but a settings row is
    // name+hint | diff chip | value box: at 358px the value cell fell to its
    // 150px floor, so selects clipped their own text and long readouts
    // overflowed into the neighbour column. 520px keeps a row on one line.
    const gap = 14, cw = 520, MAX_COLS = 2;
    const avail = wrap.clientWidth || (document.documentElement.clientWidth - 48);
    let nCols = Math.max(1, Math.floor((avail + gap) / (cw + gap)));
    nCols = Math.min(nCols, items.length, MAX_COLS);
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
        // Balance point is the MIDDLE of the box: start the next column when
        // this box would carry the current one past the target by more than it
        // closes the gap. The old order (append, then test) had to place a
        // 1480px 'Resource Management' box before switching, which left one
        // column 3593px tall against 1642px next to it.
        const enoughLeft = items.length - 1 - i >= nCols - 1 - ci;
        if (ci < nCols - 1 && acc > 0 && acc + hs[i] / 2 > target && enoughLeft) {
            ci++; acc = 0;
        }
        cols[ci].append(items[i]);
        acc += hs[i];
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
