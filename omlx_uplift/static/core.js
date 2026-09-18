/* Uplift core: pure, testable functions. No DOM, no network.
   Dual-export: browser global `UpliftCore`, Node module for tests. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const num = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0) ? x : null;
const r = (v, d) => v === null ? null : Math.round(v * 10 ** d) / 10 ** d;
const clampRatio = (a, b) => (a === null || !(b > 0)) ? null : Math.min(100, a / b * 100);

const PRESSURES = ['ok', 'soft', 'hard'];
const STATES = ['Idle', 'Loading', 'Prefilling', 'Generating', 'Active'];

function modelState(m) {
    if (m.is_loading) return 'Loading';
    if (Array.isArray(m.prefilling) && m.prefilling.length) return 'Prefilling';
    if (Array.isArray(m.generating) && m.generating.length) return 'Generating';
    if ((m.active_requests || 0) > 0) return 'Active';
    return 'Idle';
}

/* Normalize the raw /admin/api/stats payload into a flat snapshot.
   Every field is either a finite number/string or null — UI never has to guard. */
function normalize(raw) {
    raw = raw || {};
    const a = raw.active_models || {}, c = raw.runtime_cache || {}, p = a.memory_pressure || {};
    const memUsed = num(a.model_memory_used), memMax = num(a.model_memory_max);
    return {
        time: Date.now(),
        genTps: num(raw.avg_generation_tps),
        prefillTps: num(raw.avg_prefill_tps),
        requests: num(raw.total_requests),
        totalTokens: num(raw.total_tokens_served),
        completionTokens: num(raw.total_completion_tokens),
        cachedTokens: num(raw.total_cached_tokens),
        cacheEfficiency: num(raw.cache_efficiency),
        uptime: num(raw.uptime_seconds),
        active: num(a.total_active_requests),
        waiting: num(a.total_waiting_requests),
        memUsed: memUsed, memMax: memMax,
        memPercent: clampRatio(memUsed, memMax),
        pressure: PRESSURES.includes(p.pressure_level) ? p.pressure_level : null,
        cacheBytes: num(c.total_size_bytes), cacheMaxBytes: num(c.disk_max_bytes),
        cachePercent: clampRatio(num(c.total_size_bytes), num(c.disk_max_bytes)),
        // Per-model runtime cache rows (SSD cache + hot cache sizes).
        cacheModels: (Array.isArray(c.models) ? c.models : []).map(cm => ({
            id: String(cm.id || '?'),
            totalBytes: num(cm.total_size_bytes),
            hotBytes: num(cm.hot_cache_size_bytes),
            hotMaxBytes: num(cm.hot_cache_max_bytes),
        })),
        models: (Array.isArray(a.models) ? a.models : []).map(m => ({
            id: String(m.id || 'Unnamed model'),
            size: num(m.actual_size),
            sizeText: typeof m.actual_size_formatted === 'string' ? m.actual_size_formatted : '',
            pinned: m.pinned === true,
            active: num(m.active_requests) || 0,
            waiting: num(m.waiting_requests) || 0,
            idleSeconds: num(m.idle_seconds),
            state: STATES.includes(modelState(m)) ? modelState(m) : 'Idle',
            // Live per-request rows: kept raw-ish (guarded) for the request panel
            // and the client-side percentile tracker.
            prefilling: (Array.isArray(m.prefilling) ? m.prefilling : []).map(p => ({
                rid: String(p.request_id || ''),
                prompt: num(p.prompt_tokens ?? p.prompt_length ?? p.num_prompt_tokens),
                progress: p.progress >= 0 && p.progress <= 1 ? p.progress : null,
            })).filter(p => p.rid),
            generating: (Array.isArray(m.generating) ? m.generating : []).map(g => ({
                rid: String(g.request_id || ''),
                prompt: num(g.prompt_tokens),
                generated: num(g.generated_tokens) || 0,
                tps: num(g.tokens_per_second),
                elapsed: num(g.elapsed_seconds),
            })).filter(g => g.rid),
        })),
        // Server-side full-population request stats (mock / future backend).
        // Passed through guarded: unknown backends simply omit the key.
        requestStats: raw.request_stats && typeof raw.request_stats === 'object'
            ? raw.request_stats : null,
    };
}

function pruneOlderThan(history, cutoffMs) {
    let drop = 0;
    while (drop < history.length && history[drop].time < cutoffMs) drop++;
    if (drop) history.splice(0, drop);
    return history;
}

/* ---------------- per-request percentile tracker ----------------
   uPlot can only show what the server kept: hourly aggregates (averages).
   Percentiles of per-request sizes do not exist server-side, so we build
   them client-side from in-flight request rows while the page is open. */
function createRequestTracker(maxSamples) {
    const cap = maxSamples || 2000;
    const inflight = new Map();          // rid -> last observed {model, prompt, generated}
    const samples = { prompt: [], completion: [] };
    function record(metric, value) {
        if (value === null || value <= 0) return;
        samples[metric].push(value);
        if (samples[metric].length > cap) samples[metric].shift();
    }
    return {
        samples,
        observe(snapshot) {
            const seen = new Set();
            for (const m of snapshot.models) {
                for (const row of [...(m.prefilling || []), ...(m.generating || [])]) {
                    seen.add(row.rid);
                    const prev = inflight.get(row.rid) || {};
                    inflight.set(row.rid, {
                        model: m.id,
                        prompt: row.prompt ?? prev.prompt ?? null,
                        generated: row.generated ?? prev.generated ?? 0,
                    });
                }
            }
            // A rid that vanished finished between two polls: log its final size.
            for (const [rid, info] of inflight) {
                if (!seen.has(rid)) {
                    record('prompt', info.prompt);
                    record('completion', info.generated);
                    inflight.delete(rid);
                }
            }
        },
        inflightCount: () => inflight.size,
    };
}

/* Linear-interpolated percentile over an unsorted array. p in [0,100]. */
function percentile(values, p) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const idx = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function mean(values) {
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

/* ---------------- layout settings ---------------- */
/* v2 = the classic (#3694) GridStack era. The layout lives in a SEPARATE
   blob from the old v1 key (which held the dead order/cols model); v2
   holds { width, blocks } in grid units + the settings that survived the
   redesign. Old v1 blob is dead bytes (same no-migration tradeoff as
   F-020). */
const LAYOUT_KEY = 'omlx-uplift-layout-v2';
const LAYOUT_DEFAULTS = { chartWindowSec: 300, intervalMs: 1000, logsHideDebug: true, percentile: 'p95', collapsed: {} };
const LAYOUT_WINDOWS = [60, 300, 900, 3600, 21600, 86400];
const LAYOUT_INTERVALS = [500, 1000, 2000, 5000];
const LAYOUT_PERCENTILES = ['p50', 'p90', 'p95', 'p99'];
function loadLayout(storage) {
    let l = {};
    try { l = JSON.parse(storage.getItem(LAYOUT_KEY)) || {}; } catch (_) { /* denied storage */ }
    return {
        chartWindowSec: LAYOUT_WINDOWS.includes(l.chartWindowSec) ? l.chartWindowSec : LAYOUT_DEFAULTS.chartWindowSec,
        intervalMs: LAYOUT_INTERVALS.includes(l.intervalMs) ? l.intervalMs : LAYOUT_DEFAULTS.intervalMs,
        logsHideDebug: l.logsHideDebug !== false,
        percentile: LAYOUT_PERCENTILES.includes(l.percentile) ? l.percentile : LAYOUT_DEFAULTS.percentile,
        collapsed: (l.collapsed && typeof l.collapsed === 'object') ? { ...l.collapsed } : {},
        // GridStack board state — geometry validation lives in
        // uplift_layout.js normalizeLayout; here just shape-guard.
        ...(typeof l.width === 'string' ? { width: l.width } : {}),
        ...(Array.isArray(l.blocks) ? { blocks: l.blocks } : {}),
    };
}
function saveLayout(storage, layout) {
    try { storage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) { /* ignore */ }
}
/* A card never spans more than the grid has columns. */
function clampSpan(span, cols) { return Math.max(1, Math.min(span, cols)); }

/* Rolling time-window history of samples (ring semantics via splice). */
function appendSample(history, sample, max) {
    history.push(sample);
    if (history.length > (max || 120)) history.splice(0, history.length - (max || 120));
    return history;
}

/* Diff two snapshots into a list of {kind, text} events for UI reactions. */
function eventsBetween(prev, next) {
    if (!prev) return [];
    const events = [];
    // Counter regression => server (re)started.
    if ((next.uptime !== null && prev.uptime !== null && next.uptime < prev.uptime) ||
        (next.requests !== null && prev.requests !== null && next.requests < prev.requests)) {
        events.push({ kind: 'restart', text: 'Server counters reset — oMLX restarted' });
    }
    const old = new Map(prev.models.map(m => [m.id, m]));
    for (const m of next.models) {
        const before = old.get(m.id);
        if (!before) events.push({ kind: 'model-add', text: `${m.id} loaded`, model: m.id });
        else if (before.state !== m.state)
            events.push({ kind: 'model-state', text: `${m.id}: ${m.state}`, model: m.id, state: m.state });
        old.delete(m.id);
    }
    for (const id of old.keys()) events.push({ kind: 'model-remove', text: `${id} unloaded`, model: id });
    if (next.requests !== null && prev.requests !== null && next.requests > prev.requests)
        events.push({ kind: 'requests', delta: next.requests - prev.requests,
                      text: `${next.requests - prev.requests} request${next.requests - prev.requests === 1 ? '' : 's'} completed` });
    if (next.pressure && prev.pressure && next.pressure !== prev.pressure)
        events.push({ kind: 'pressure', text: `Memory pressure: ${next.pressure}` });
    return events;
}

/* Milestone events (confetti candidates) derived from counters crossing rounds. */
function milestonesBetween(prev, next) {
    const hits = [];
    if (!prev) return hits;
    for (const [key, label] of [['requests', 'requests served'], ['totalTokens', 'tokens served']]) {
        const a = prev[key], b = next[key];
        if (a === null || b === null || b <= a) continue;
        const step = key === 'requests' ? 1000 : 1000000;
        if (Math.floor(b / step) > Math.floor(a / step))
            hits.push({ key, label, value: b });
    }
    return hits;
}

/* Settings: validated against known-good values; corrupt/absent => defaults. */
const PREFS_KEY = 'omlx-uplift-prefs-v1';
const PREFS_DEFAULTS = { theme: 'auto', motion: 'auto', intervalMs: 1000, dense: false };
const THEMES = ['auto', 'light', 'dark', 'enhanced', 'cockpit'];
function loadPrefs(storage) {
    let p = {};
    try { p = JSON.parse(storage.getItem(PREFS_KEY)) || {}; } catch (_) { /* storage may be denied */ }
    const out = {
        theme: THEMES.includes(p.theme) ? p.theme : PREFS_DEFAULTS.theme,
        motion: ['auto', 'off'].includes(p.motion) ? p.motion : PREFS_DEFAULTS.motion,
        intervalMs: [500, 1000, 2000, 5000].includes(p.intervalMs) ? p.intervalMs : PREFS_DEFAULTS.intervalMs,
        dense: p.dense === true,
    };
    // F-014: tableSort was dropped by this whitelist, so a saved column
    // sort silently reset to ascending on every reload.
    if (p.tableSort && typeof p.tableSort.key === 'string'
        && (p.tableSort.dir === 1 || p.tableSort.dir === -1)) {
        out.tableSort = { key: p.tableSort.key, dir: p.tableSort.dir };
    }
    return out;
}
function savePrefs(storage, prefs) {
    try { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

/* Formatting (metric, human). */
function fmtCompact(n) {
    if (n === null) return '—';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n * 10) / 10);
}
function fmtBytes(n) {
    if (n === null) return '—';
    const g = n / 1e9;
    if (g >= 10) return g.toFixed(0) + ' GB';
    if (g >= 1) return g.toFixed(2) + ' GB';
    return (n / 1e6).toFixed(0) + ' MB';
}
function fmtDuration(s) {
    if (s === null) return '—';
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
}
function fmtNumber(n) { return n === null ? '—' : Math.round(n).toLocaleString('en-US'); }

/* ---------- i18n (classic pattern: catalog + t(key); {placeholder}
   interpolation; missing key falls back to the key itself, same as
   classic's window.t). Pure state — DOM application lives in uplift.js,
   bootstrap/fetch lives in uplift.js; core stays testable. ---------- */
let _locale = { lang: 'en', strings: {} };
function setLocale(lang, strings) {
    _locale = { lang: lang || 'en', strings: strings || {} };
    return _locale;
}
function getLocale() { return _locale; }
function t(key, vars) {
    let s = _locale.strings[key];
    if (typeof s !== 'string') return key;
    if (vars) {
        s = s.replace(/\{(\w+)\}/g, (m, k) =>
            vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m);
    }
    return s;
}
/* tf: t() with an English fallback instead of the raw key — for labels
   that live inline in JS. Missing key -> the literal you passed. */
function tf(key, fallback, vars) {
    let s = _locale.strings[key];
    if (typeof s !== 'string') return fallback;
    if (vars) {
        s = s.replace(/\{(\w+)\}/g, (m, k) =>
            vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m);
    }
    return s;
}

/* Backfill merge: server history points (res fine|hourly) into a live
   column pair [ts[], v[]]. Drops points outside (now-window, now+slack],
   drops older live points the server covers (hourly buckets supersede
   live-ticked values), keeps live points NEWER than the newest history
   point. Returns {merged, boundary} — boundary = ts of the coarsest
   trailing run (for honest 'hourly before here' labelling), or 0. */
function mergeHistory(history, liveTs, liveVal, windowSec, now) {
    const t0 = now - windowSec * 1000;
    const pts = history
        .filter(p => p && typeof p.ts === 'number' && typeof p.v === 'number'
                     && p.ts > t0 && p.ts <= now + 5000)
        .sort((a, b) => a.ts - b.ts);
    const lastHistTs = pts.length ? pts[pts.length - 1].ts : 0;
    const outTs = [], outVal = [];
    for (const p of pts) {
        if (outTs.length && outTs[outTs.length - 1] === p.ts) {
            outVal[outVal.length - 1] = p.v;   // same ts: history wins
            continue;
        }
        outTs.push(p.ts); outVal.push(p.v);
    }
    for (let i = 0; i < liveTs.length; i++) {
        if (liveTs[i] > lastHistTs && liveTs[i] > t0) {
            outTs.push(liveTs[i]); outVal.push(liveVal[i]);
        }
    }
    let boundary = 0;
    for (const p of pts) if (p.res === 'hourly') boundary = Math.max(boundary, p.ts);
    return { ts: outTs, v: outVal, boundary };
}

// FastAPI error bodies: `detail` is a string for HTTPException but an ARRAY
// of {loc,msg,...} for 422 validation errors. Stringifying the array gave
// "[object Object]" in toasts (F-019). Flatten to readable text.
function errorText(body) {
    const d = body && body.detail !== undefined ? body.detail : (body && body.error);
    if (typeof d === 'string') return d || '';
    if (Array.isArray(d)) {
        return d.map(e => {
            if (typeof e === 'string') return e;
            const loc = Array.isArray(e.loc) ? e.loc.filter(x => x !== 'body').join('.') : '';
            return (loc ? loc + ': ' : '') + (e.msg || 'invalid');
        }).join('; ');
    }
    if (d && typeof d === 'object') { try { return JSON.stringify(d); } catch (_) { return 'error'; } }
    return '';
}

return { num, r, normalize, modelState, appendSample, pruneOlderThan, eventsBetween, milestonesBetween,
         createRequestTracker, percentile, mean, mergeHistory,
         setLocale, getLocale, t, tf,
         PREFS_KEY, PREFS_DEFAULTS, THEMES, loadPrefs, savePrefs,
         LAYOUT_KEY, LAYOUT_DEFAULTS, LAYOUT_WINDOWS, LAYOUT_INTERVALS, LAYOUT_PERCENTILES, loadLayout, saveLayout, clampSpan,
         fmtCompact, fmtBytes, fmtDuration, fmtNumber, errorText };
});
