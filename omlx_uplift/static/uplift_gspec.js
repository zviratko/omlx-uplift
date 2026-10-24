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
    // SYNC-1 (upstream 3c39990): qwen4_gdn_decode_wide_proj left
    // GlobalSettingsRequest for ModelSettingsRequest (per-model now — see
    // modelspec.js / uplift_mmeditor.js). Sending it here is dead weight on a
    // tip server and must never come back.
    gpu_keep_warm_interval: ['server','gpu_keep_warm_interval'],
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
    // SYNC-1 (upstream 1c3adf2 #4528): keyless-inference toggle — flat in
    // GlobalSettingsRequest, nested under auth in the classic store.
    // Applies without restart (server reads it per-request), so no restart
    // badge, and enabling it asks for confirmation like classic does.
    allow_unauthenticated_inference: ['auth','allow_unauthenticated_inference'],
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
    // SYNC-1 (upstream f27ba3d #3592): Claude Desktop tier aliases — live-
    // applied like the rest of claude_code; the server auto-configures /
    // restores the Desktop JSON on the OFF->ON / ON->OFF edge.
    claude_code_desktop_enabled: ['claude_code','desktop_enabled'],
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
    'openclaw_model', 'hermes_model', 'pi_model', 'vibe_model', 'dsh_model',
    'openclaw_tools_profile']);

/* UP-19 (2): classic's host-loopback verdict (dashboard.js
   isLoopbackBindHost) — comma-separated multi-host bind lists count as
   loopback only when EVERY entry is localhost/127.x/::1 (incl. IPv4-mapped
   ::ffff:7f..). Drives the auth-skip force-off + key-required guard. */
function isLoopbackBindHost(value) {
    const hosts = String(value || '').split(',')
        .map(h => h.trim().toLowerCase()).filter(Boolean);
    if (hosts.length === 0) return false;
    return hosts.every(host => {
        if (host.replace(/\.+$/, '') === 'localhost') return true;
        if (!host.includes(':')) {
            const parts = host.split('.');
            return parts.length === 4 && parts[0] === '127'
                && parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
        }
        const [address, scope, extra] = host.split('%');
        if (extra !== undefined || scope === '') return false;
        if (!/^[0-9a-f:.]+$/.test(address)) return false;
        try {
            const normalized = new URL(`http://[${address}]/`).hostname;
            return normalized === '[::1]'
                || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
        } catch { return false; }
    });
}

/* UP-19 (2): classic saveGlobalSettings required-fields block
   (dashboard.js:1376-1390) — next-state aware (queued edits count).
   get(flat) resolves the value the save WOULD send; label(flat) renders
   the localized field name. Returns the classic joined error or null. */
const GS_REQUIRED_FLATS = ['host', 'port', 'max_audio_upload_size',
    'max_concurrent_requests', 'embedding_batch_size', 'ssd_cache_max_size',
    'sampling_max_context_window', 'sampling_max_tokens'];
function requiredFieldsError(get, label) {
    const missing = GS_REQUIRED_FLATS.filter(f => !get(f)).map(label);
    const dirs = get('model_dirs') || [];
    if (!dirs.length || !dirs.some(d => String(d).trim()))
        missing.push(label('model_dirs'));
    if (get('gdn_snapshot_storage') === 'ssd_sidecar' && get('hot_cache_only'))
        missing.push(label('gdn_hot_conflict'));
    if (!missing.length) return null;
    return { missing, joined: missing.join(', ') };
}

/* ---------------------------------------------------------------------------
   UP-41(10): cache-limit % <-> size-string machine.
   Verbatim port of classic dashboard.js parseCacheToPercent (6500),
   percentToCacheString (6520), _parseSettingsGB (6528),
   parseHotCacheToPercent (6736) and updateHotCacheFromSlider (6754).
   ALIGNMENT NOTE (card CAUTION): uplift historically left these fields
   blank meaning "OS default", while classic normalizes blank hot-cache to
   '0' on load (normalizeHotCacheMaxSize 6730) and treats '0' as DISABLED.
   We deliberately adopt the classic semantics here: ''/'auto' normalize to
   the same display state classic shows (hot: 0 = off; cold: percent 10 /
   Auto mode), and every edit the slider makes writes an explicit string
   ('auto', '0', '<n>GB') — a blank never survives a slider interaction. */
const SIZE_UNITS = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2 };
function sizeToBytes(str) {
    const m = String(str ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB|TB)?$/i);
    if (!m) return null;
    return parseFloat(m[1]) * (SIZE_UNITS[(m[2] || 'GB').toUpperCase()] || 1);
}
// classic _parseSettingsGB (6528): GB value or null (unparseable/empty)
function parseSettingsGB(val) {
    if (!val) return null;
    const m = String(val).trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB|TB)?$/i);
    if (!m) return null;
    const num = parseFloat(m[1]);
    const unit = (m[2] || 'GB').toUpperCase();
    if (unit === 'TB') return Math.round(num * 1024);
    if (unit === 'MB') return Math.round(num / 1024);
    return Math.round(num);
}
// classic parseCacheToPercent (6500): SSD percent, default 10, cap 100
function cachePercentOf(cacheStr, totalBytes) {
    const bytes = sizeToBytes(cacheStr);
    if (bytes === null || !totalBytes || totalBytes === 0) return 10;
    return Math.min(100, Math.round((bytes / totalBytes) * 100));
}
// classic percentToCacheString (6520): percent -> '<floor>GB' ('auto' when
// the disk size is unknown so a slider move cannot invent a number)
function percentToCacheString(percent, totalBytes) {
    if (!totalBytes || totalBytes === 0) return 'auto';
    const gb = Math.floor((percent / 100) * totalBytes / (1024 * 1024 * 1024));
    return `${gb}GB`;
}
// classic parseHotCacheToPercent (6736): RAM percent, 0 (off) default,
// cap 50 exactly like classic clamps it
function hotCachePercentOf(hotStr, totalBytes) {
    if (!hotStr || hotStr === '0' || hotStr === 'auto') return 0;
    const bytes = sizeToBytes(hotStr);
    if (bytes === null || !totalBytes || totalBytes === 0) return 0;
    return Math.min(50, Math.max(0, Math.round((bytes / totalBytes) * 100)));
}
// classic updateHotCacheFromSlider (6754): 0% -> '0' (disabled); sub-GB
// results TRUNCATE to '0' — classic's own edge (floor), kept verbatim so
// the two dashboards compute identical payloads.
function hotCacheStringFromPercent(percent, totalBytes) {
    if (!percent) return '0';
    const gb = Math.floor((percent / 100) * (totalBytes || 0) / (1024 * 1024 * 1024));
    return gb > 0 ? `${gb}GB` : '0';
}
// classic updateHotCacheFromInput (6679): GB typed -> percent for the slider
function hotCachePercentFromGB(gb, totalBytes) {
    const n = parseInt(gb, 10) || 0;
    if (n === 0) return 0;
    if (!totalBytes) return null;
    return Math.min(50, Math.max(1, Math.round(n * 1024 ** 3 / totalBytes * 100)));
}

/* UP-41(10): memory-guard readouts over system.memory_guard_preview
   (classic dashboard.js 6553-6663). Pure string/array builders — the DOM
   layer in uplift_gsys.js only renders what these return. */
// classic memoryGuardShowWiredLimitWarning (6553)
function wiredLimitWarned(sys) {
    const kernel = (sys || {}).iogpu_wired_limit_bytes || 0;
    const requested = (sys || {}).omlx_wired_limit_request_bytes || 0;
    return kernel > 0 && requested > 0 && kernel < requested;
}
// classic memoryGuardWiredLimitCommand (6575): the copyable sysctl fix
function wiredLimitCommand(sys) {
    if (!wiredLimitWarned(sys)) return '';
    return `sudo sysctl iogpu.wired_limit_mb=${Math.ceil((sys.omlx_wired_limit_request_bytes) / (1024 ** 2))}`;
}
// classic memoryGuardTierDescription (6605): {reserve}/{custom_gb} filled
// with '<n> GB' strings; tpl is the localized template from the caller
function guardTierText(tpl, tier, preview, customGB) {
    if (tier === 'custom')
        return String(tpl).replace('{custom_gb}', Number(customGB || 0).toFixed(1));
    const reserve = ((preview || {}).reserve_bytes || 0) / (1024 ** 3);
    return String(tpl).replace('{reserve}', reserve.toFixed(1) + ' GB');
}
// classic memoryGuardBreakdownHTML (6626) rebuilt as DOM-friendly SEGMENTS
// (house style: JS-built DOM, never innerHTML): tpl with {name} tokens and
// a values map name->string -> [{t, bold}] segments.
function templateSegments(tpl, values) {
    const out = [];
    const re = /\{([a-z_]+)\}/g;
    let last = 0, m;
    while ((m = re.exec(String(tpl))) !== null) {
        if (m.index > last) out.push({ t: String(tpl).slice(last, m.index) });
        out.push({ t: m[1] in values ? String(values[m[1]]) : m[0], bold: true });
        last = m.index + m[0].length;
    }
    if (last < String(tpl).length) out.push({ t: String(tpl).slice(last) });
    return out;
}
// custom-tier effective ceiling clamp (classic 6637): min(static, metal)
// over the positive limits; null when the preview carries none
function customGuardCeilingGB(customGB, preview) {
    const limits = [Number((preview || {}).static_bytes) || 0,
                    Number((preview || {}).metal_cap_bytes) || 0].filter(v => v > 0);
    if (!limits.length) return null;
    return Math.max(0, Math.min(Number(customGB || 0) * 1024 ** 3, ...limits)) / (1024 ** 3);
}

/* UP-41(8): classic host-preset mapping (_settings.html:311-321).
   '127.0.0.1' -> localhost, '0.0.0.0' -> public, anything else (incl.
   multi-host lists) -> custom. Choosing a preset writes classic's exact
   value; custom starts from blank so the user types their own. */
function hostPresetOf(host) {
    const h = String(host || '').trim();
    if (h === '127.0.0.1') return 'localhost';
    if (h === '0.0.0.0') return 'public';
    return 'custom';
}
function hostPresetValue(mode) {
    if (mode === 'localhost') return '127.0.0.1';
    if (mode === 'public') return '0.0.0.0';
    return '';
}

/* UP-41(11/12): section deep-links. Classic routes the settings page by
   #settings-<id> anchors (_settings.html:31-42). Uplift keeps its
   localStorage tab strip, so a link arrives as #settings-<slug> (classic
   shape, shared with people pasting classic-style links) and is normalized
   to the uplift-native two-segment #settings/<slug> BEFORE uplift.js's
   applyTab reads the hash ('/x' is not in SUBS.settings so the router
   still lands on the global sub and nothing else changes).
   classicToUpliftSection maps the twelve classic anchor ids onto uplift
   box slugs; unknown ids pass through so future uplift-only slugs work. */
const CLASSIC_SECTION_IDS = ['settings-language', 'settings-appearance', 'settings-auth',
    'settings-server', 'settings-model', 'settings-resource', 'settings-cache',
    'settings-generation', 'settings-mcp', 'settings-usage', 'settings-network',
    'settings-advanced'];
const CLASSIC_TO_UPLIFT = {
    'settings-language': 'server',        // uplift folds language rows into Server
    'settings-appearance': 'server',
    'settings-auth': 'auth',
    'settings-server': 'server',
    'settings-model': 'models',
    'settings-resource': 'resource_management',
    'settings-cache': 'resource_management',
    'settings-generation': 'models',
    'settings-mcp': 'integrations',
    'settings-usage': 'integrations',
    'settings-network': 'integrations',
    'settings-advanced': 'advanced',
};
function classicToUpliftSection(id) {
    // qualified classic id ('settings-resource') maps; anything else is
    // already an uplift slug and passes through
    return CLASSIC_TO_UPLIFT[id] || id;
}
// parse('#settings-advanced') / parse('#settings/advanced') -> 'advanced';
// '#settings-resource' (classic anchor tail) -> 'resource_management'.
// Anything else (or a non-string) -> null.
function parseGsDeepLink(hash) {
    const h = String(hash || '').replace(/^#/, '');
    let m = /^settings-(.+)$/.exec(h);
    // the captured tail may be a CLASSIC anchor tail ('resource') or an
    // uplift slug ('resource_management'): try the classic map on the
    // qualified form first, else treat the tail itself as the uplift slug
    if (m) return CLASSIC_TO_UPLIFT['settings-' + m[1]] || m[1].toLowerCase();
    m = /^settings\/([a-z0-9_]+)$/i.exec(h);
    if (m) return m[1].toLowerCase();
    return null;
}
// the anchor a copy-link button writes: classic #settings-<slug> shape
function gsSectionAnchor(slug) { return '#settings-' + slug; }

/* UP-26(2): Applications launch commands (classic _applications.html +
   dashboard.js shellQuote 3816 / _launchCmd 4230 / per-tool getters
   4236-4281). Pure templating so the wire shape is testable. */
function shellQuote(value) {
    const s = String(value ?? '');
    if (!s) return "''";
    return `'${s.replace(/'/g, `'"'"'`)}'`;
}
// classic formatDisplayHost (3655-3670)
function displayHostFor(host) {
    const value = String(host || '');
    if (!value) return '127.0.0.1';
    const unwrapped = value.startsWith('[') && value.endsWith(']')
        ? value.slice(1, -1) : value;
    if (unwrapped === '0.0.0.0' || unwrapped === '::') return 'your-ip-address';
    if (unwrapped === 'localhost') return '127.0.0.1';
    if (unwrapped.includes(':')) return `[${unwrapped}]`;
    return unwrapped;
}
// classic _launchCmd + openclaw --tools-profile (4260) + vibe --model (4273)
function launchCommand(tool, opts) {
    const o = opts || {};
    const raw = o.cliPrefix || 'omlx';
    const cli = raw === 'omlx' ? raw : shellQuote(raw);
    let cmd = `${cli} launch ${tool}`;
    if (tool === 'openclaw')
        cmd += ` --tools-profile ${o.toolsProfile || 'coding'}`;
    if (tool === 'vibe' && o.model)
        cmd += ` --model ${shellQuote(o.model)}`;
    return cmd;
}
// classic claudeCodeCommand (dashboard.js:3826): cloud unsets the env,
// local exports host/port + assigned opus/sonnet/haiku + the LSP deny
const CLAUDE_CLOUD_UNSET = 'env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN '
    + '-u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL '
    + '-u ANTHROPIC_DEFAULT_HAIKU_MODEL -u API_TIMEOUT_MS '
    + '-u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC claude';
function claudeCodeCommand(cc, conn) {
    if ((cc || {}).mode === 'cloud') return CLAUDE_CLOUD_UNSET;
    const c = conn || {};
    const port = c.port || 8000;
    const ph = 'select-a-model';
    const parts = [
        `${shellEnv('ANTHROPIC_BASE_URL', 'http://' + displayHostFor(c.host) + ':' + port)}`,
    ];
    if (c.apiKey) parts.push(shellEnv('ANTHROPIC_AUTH_TOKEN', c.apiKey));
    parts.push(shellEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', (cc || {}).opus_model || ph));
    parts.push(shellEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', (cc || {}).sonnet_model || ph));
    parts.push(shellEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL', (cc || {}).haiku_model || ph));
    parts.push('API_TIMEOUT_MS=3000000');
    parts.push('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    parts.push('claude --disallowedTools LSP');
    return parts.join(' ');
}
function shellEnv(name, value) { return `${name}=${shellQuote(value)}`; }

/* UP-26(3): the update-check verdict (classic dashboard.js:1163
   checkForUpdate over GET /admin/api/update-check). Pure so the nudge's
   show/hide logic is testable against real payloads. */
function updateNudge(d) {
    if (!d || !d.update_available) return null;
    return {
        version: d.latest_version || '',
        url: d.release_url || 'https://github.com/jundot/omlx',
    };
}

return { GS_MAP, GS_PAYLOAD_SKIP, INTEG_PREFIXED,
         isLoopbackBindHost, requiredFieldsError, GS_REQUIRED_FLATS,
         // UP-41 pure machine (cache limits, memory guard, host preset,
         // section deep-links) + UP-26 (launch commands, update nudge)
         sizeToBytes, parseSettingsGB, cachePercentOf, percentToCacheString,
         hotCachePercentOf, hotCacheStringFromPercent, hotCachePercentFromGB,
         wiredLimitWarned, wiredLimitCommand, guardTierText,
         templateSegments, customGuardCeilingGB,
         hostPresetOf, hostPresetValue,
         parseGsDeepLink, gsSectionAnchor, CLASSIC_SECTION_IDS, CLASSIC_TO_UPLIFT,
         shellQuote, displayHostFor, launchCommand, claudeCodeCommand,
         updateNudge };
});
