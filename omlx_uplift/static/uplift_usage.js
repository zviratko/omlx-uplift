/* Uplift usage + logs tabs (PH2-1 stage 3 extraction from uplift.js):
   Usage tab polling/heatmap/table and the Logs tab tail with level/grep
   filters. Loads AFTER uplift_state.js (usageRange/usageAvg/logsFollow live
   in the shared state cell) and BEFORE uplift.js, which exposes hoisted
   helpers (fetchJson/setCounter/...) via window.Uplift._usageGlue.
   Exports window.Uplift.usage. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const layout = S.layout;
const CH = window.Uplift.charts;
/* UP-5: the sub-line ("N req · M tok · cached K") was literal English. The
   translation lives on the #usage-sub span (data-i18n + applyI18n relabel
   on locale load); last render's numbers live in state so relabeling can
   re-fill them without a refetch. */
S.usageTotals = null;
function renderUsageSub() {
    const el = $('usage-sub');
    if (!el || !S.usageTotals) return;
    const t = S.usageTotals;
    const vars = { req: C.fmtNumber(t.requests),
                   tok: C.fmtCompact(t.total_tokens),
                   cached: C.fmtCompact(t.cached_tokens) };
    let s = C.t('uplift.usage.sub', vars);
    if (s === 'uplift.usage.sub')      // locale not loaded yet: English literal
        s = `${vars.req} req · ${vars.tok} tok · cached ${vars.cached}`;
    el.textContent = s;
}
/* ---------------- usage (Usage tab) ---------------- */
/* createUsageChart lives in uplift_charts.js (CH.createUsageChart). */
async function pollUsage() {
    if (document.hidden) return;
    try {
        const u = await D.fetchJson(`${API}/admin/api/usage?range=${S.usageRange}`);
        const tot = u.totals || {};
        window.Uplift._usageGlue.setCounter('v-u-req', tot.requests ?? null);
        window.Uplift._usageGlue.setCounter('v-u-tok', tot.total_tokens ?? null);
        window.Uplift._usageGlue.setCounter('v-u-prompt', tot.prompt_tokens ?? null);
        window.Uplift._usageGlue.setCounter('v-u-compl', tot.completion_tokens ?? null);
        S.usageAvg = tot.requests > 0
            ? { prompt: tot.prompt_tokens / tot.requests, completion: tot.completion_tokens / tot.requests }
            : null;
        S.usageRange = u.range || S.usageRange;

        // Heatmap: single row for day ranges, full day×hour grid for 7d+.
        const hm = u.heatmap || [];
        const heat = $('heat');
        const multi = hm.length > 1;
        heat.classList.toggle('multi', multi);
        heat.style.gridTemplateRows = multi ? `repeat(${hm.length}, auto)` : '';
        const want = hm.length * 24;
        if (heat.children.length !== want) {
            heat.innerHTML = '';
            for (let i = 0; i < want; i++) heat.append(document.createElement('i'));
        }
        const allMax = Math.max(1, ...hm.flatMap(d => d.tokens || [0]));
        let cells = [...heat.children];
        hm.forEach((day, dIdx) => {
            (day.tokens || []).slice(0, 24).forEach((v, hIdx) => {
                const c = cells[dIdx * 24 + hIdx];
                if (!c) return;
                const a = v > 0 ? 0.15 + 0.85 * Math.sqrt(v / allMax) : 0;
                c.style.background = v > 0 ? `color-mix(in oklab, var(--heat) ${Math.round(a * 100)}%, transparent)` : '';
                c.title = `${day.date || ''} ${String(hIdx).padStart(2, '0')}:00 — ${C.fmtCompact(v)} tokens`;
            });
        });
        if (tot.requests !== undefined) { S.usageTotals = tot; renderUsageSub(); }
        else $('usage-sub').textContent = '';

        // Hourly tokens chart (last day of the range).
        if (!CH.usageChart) CH.createUsageChart();
        const lastDay = hm[hm.length - 1];
        const hours = lastDay ? (lastDay.tokens || []).slice(0, 24) : [];
        const uc = CH.usageChart;
        if (uc && hours.length === 24) {
            const base = new Date(); base.setHours(0, 0, 0, 0);
            const ts = hours.map((_, i) => base.getTime() + i * 3600e3);
            uc.setData([ts, hours.slice()]);
        }

        // Per-model table (all, sorted by tokens).
        const table = $('usage-models');
        table.innerHTML = '';
        const models = (u.models || []).slice()
            .sort((a, b) => (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
        if (models.length) {
            const head = document.createElement('div'); head.className = 'urow head admin';
            for (const h of ['model', 'req', 'prompt', 'completion', 'cached', 'avg t/req']) head.append(D.cell(h));
            table.append(head);
            for (const m of models) {
                const row = document.createElement('div'); row.className = 'urow admin';
                const name = D.cell(m.model_id); name.className = 'uname'; name.title = m.model_id;
                row.append(name, D.cell(C.fmtNumber(m.requests)), D.cell(C.fmtCompact(m.prompt_tokens)),
                           D.cell(C.fmtCompact(m.completion_tokens)), D.cell(C.fmtCompact(m.cached_tokens)),
                           D.cell(m.requests ? C.fmtCompact((m.prompt_tokens + m.completion_tokens) / m.requests) : '—'));
                table.append(row);
            }
        }
        if (window.Uplift._usageGlue.currentTab() === 'status') window.Uplift._usageGlue.renderRequestStats(window.Uplift._usageGlue.stats());
    } catch (_) { /* usage may be disabled; keep last data */ }
}
/* PH2-1 stage 3: fillSelect lives in uplift.js (loads later) — defer the
   select seeding to initUsageRange(), which the uplift.js boot tail calls. */
let usageRangeSeeded = false;
/* UP-5: option labels + summary sub-line were literal English. Range names
   reuse classic's own usage.* keys (same concepts, already translated in
   the base catalog); relabelUsageRange() runs on every locale load like
   CH.relabelExplore does for chart chips. */
const USAGE_RANGE_KEYS = [['today', 'usage.today'], ['yesterday', 'usage.yesterday'],
                          ['7d', 'usage.7d'], ['30d', 'usage.30d'], ['90d', 'usage.90d']];
function initUsageRange() { relabelUsageRange(); }
function relabelUsageRange() {
    // build on first call, rewrite labels in place afterwards (selection
    // untouched) — same relabel contract as CH.relabelExplore for chips.
    const sel = $('opt-usage-range');
    if (!sel) return;
    const want = Object.fromEntries(USAGE_RANGE_KEYS.map(([v, k]) => [v, C.t(k)]));
    if (!sel.options.length) {
        window.Uplift._usageGlue.fillSelect(sel,
            USAGE_RANGE_KEYS.map(([v, k]) => [v, want[k]]), S.usageRange);
        usageRangeSeeded = true;
        return;
    }
    for (const o of sel.options) if (want[o.value] !== undefined) o.textContent = want[o.value];
}
$('opt-usage-range').onchange = e => { S.usageRange = e.target.value; pollUsage(); };

/* ---------------- logs (Logs tab) ---------------- */
/* UP-31: the classic viewer's pure core (admin logs.js:17-175) ported
   verbatim — header-line records with continuation joins (tracebacks),
   consecutive WARNING-or-above collapses into one counted row, and the
   memory-guard advisories detected by the server's own number shapes.
   Classic parses FIRST and level-filters during aggregation, so
   continuation lines survive the filter; uplift's old flat filter did
   not, this now matches classic exactly. */
const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
const LOG_AGG_FROM = LOG_LEVELS.indexOf('WARNING');
const LOG_HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) - (.*?) - (TRACE|DEBUG|INFO|WARNING|ERROR|CRITICAL) - (?:\[.*?\] - )?([\s\S]*)$/;
const LOG_MEMORY_GUARD = [
    /process memory limit exceeded/,
    /Prefill would require/,
    /Hard memory pressure/,
    /Aborted \d+ requests? due to memory pressure/,
    /raise memory_guard_tier/,
];
function logLevelRank(level) {
    return LOG_LEVELS.indexOf(String(level == null ? '' : level).toUpperCase());
}
function parseLogText(text, totalLines) {
    const lines = String(text == null ? '' : text).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const first = Math.max(0, (totalLines || 0) - lines.length);
    const records = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        const match = LOG_HEADER.exec(line);
        const open = records[records.length - 1];
        if (!match && open) { open.message += '\n' + line; open.lines += 1; continue; }
        records.push({
            key: 'L' + (first + i),
            time: match ? match[1] : '',
            module: match ? match[2] : '',
            level: match ? match[3] : '',
            message: match ? match[4] : line,
            lines: 1,
            continuation: !match,
        });
    }
    return records;
}
function logNumberField(text, pattern) {
    const match = text.match(pattern);
    return match ? { value: parseFloat(match[1]), text: match[1] } : null;
}
function memoryGuardFor(message) {
    const text = String(message == null ? '' : message);
    if (!LOG_MEMORY_GUARD.some(p => p.test(text))) return null;
    const current = logNumberField(text, /\(current ([\d.]+) GB/);
    const ceiling = text.match(/\b[a-z_/]+ ceiling (?:is )?([\d.]+) GB/);
    return {
        usage: logNumberField(text, /\(usage ([\d.]+) GB/) || current,
        watermark: logNumberField(text, /abort threshold \(hard watermark\) ([\d.]+) GB/),
        ceiling: ceiling ? { value: parseFloat(ceiling[1]), text: ceiling[1] } : null,
        peak: logNumberField(text, /require ~?([\d.]+) GB peak/),
    };
}
function aggregateLogRows(records, minLevel) {
    const minimum = logLevelRank(minLevel);
    const rows = [];
    let run = null, times = null;
    const closeRun = () => {
        if (!run) return;
        if (run.count !== times.length) run.count = times.length;
    };
    for (const record of records || []) {
        const rank = logLevelRank(record.level);
        if (minimum > 0 && rank >= 0 && rank < minimum) { closeRun(); run = null; continue; }
        if (run && rank >= LOG_AGG_FROM && run.rank === rank
            && record.module === run.module && record.message === run.message) {
            times.push(record.time);
            continue;
        }
        closeRun();
        run = Object.assign({}, record, { rank, count: 1,
            memory: memoryGuardFor(record.message) });
        times = [record.time];
        rows.push(run);
    }
    closeRun();
    return rows;
}
let logsFilesLoaded = false, logsFollow = true;
async function pollLogs() {
    if (document.hidden && !logsFollow) return;
    try {
        const lines = Number($('logs-lines').value || 300);
        const file = $('logs-file').value;
        let url = `${API}/admin/api/logs?lines=${lines}`;
        if (file) url += `&file=${encodeURIComponent(file)}`;
        const d = await D.fetchJson(url);
        if (!logsFilesLoaded && Array.isArray(d.available_files)) {
            window.Uplift._usageGlue.fillSelect($('logs-file'), d.available_files.map(f => [f, f]), d.log_file || d.available_files[0]);
            logsFilesLoaded = true;
        }
        const level = $('logs-level').value;
        const grep = ($('logs-grep').value || '').toLowerCase();
        const minLevel = level || (layout.logsHideDebug ? 'INFO' : '');
        let rows = aggregateLogRows(parseLogText(String(d.logs || ''), lines), minLevel);
        if (grep) rows = rows.filter(r => String(r.message).toLowerCase().includes(grep));
        const pre = $('logs');
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const row of rows.slice(-800)) {
            const el = document.createElement('div');
            el.className = 'logrow' + (row.level ? ` lv-${row.level}` : '')
                + (row.memory ? ' lg-mem' : '');
            el.textContent = '';
            const f = (cls, txt) => { const s = document.createElement('span');
                s.className = cls; s.textContent = txt; el.append(s); };
            f('lt', row.time ? row.time.slice(11, 19) : '');
            f('ll', row.level || '');
            f('lm', row.module || '');
            f('lx', row.message + (row.count > 1
                ? ` \u00d7${row.count} (${row.time ? row.time.slice(11, 19) : ''}\u2026)` : ''));
            if (row.memory) {
                const chips = ['usage', 'watermark', 'ceiling', 'peak']
                    .filter(n => row.memory[n])
                    .map(n => `${n} ${row.memory[n].text} GB`);
                if (chips.length) f('lgv', chips.join(' \u00b7 '));
            }
            el.onclick = () => el.classList.toggle('open');
            frag.append(el);
        }
        pre.append(frag);
        if (logsFollow || atBottom) pre.scrollTop = pre.scrollHeight;
        $('logs-sub').textContent = `${rows.length} records${d.log_file ? ' \u00b7 ' + d.log_file : ''}`;
    } catch (_) { /* keep tail */ }
}
$('logs-level').onchange = () => pollLogs();
$('logs-lines').onchange = () => pollLogs();
$('logs-file').onchange = () => pollLogs();
$('logs-grep').oninput = C.debounce ? C.debounce(pollLogs, 300) : (() => { let t; return () => { clearTimeout(t); t = setTimeout(pollLogs, 300); }; })();
$('logs-follow').onchange = e => { logsFollow = e.target.checked; };
$('logs-dl').onclick = () => {
    const blob = new Blob([$('logs').textContent], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uplift-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
};

/* UP-25 (classic parity): confirm-gated clear buttons — session/all-time
   usage stats (dashboard.js:4546-4566) and the hot/SSD cache purges
   (:4568-4590). Labels + confirms reuse classic's own catalog keys.
   Built in JS so no new uplift locale keys are minted. */
(function () {
    const mk = (host, label, title, confirmKey, confirmDef, url) => {
        if (!host) return;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'se-btn act'; b.textContent = label;
        b.title = title;
        b.onclick = () => {
            if (!window.confirm(C.tf(confirmKey, confirmDef))) return;
            D.postJson(`${API}/admin/api/` + url, {})
             .catch(e => D.toast(D.errText(e), 'error'))
             .then(() => { try { window.Uplift._usageGlue.pollStats(); } catch (_) {} });
        };
        host.append(b);
    };
    const ua = $('usage-actions'), ca = $('cache-actions');
    mk(ua, C.tf('status.clear', 'Clear'),
       C.tf('status.clear_tooltip', 'Clear session metrics'),
       'status.clear_confirm', 'Are you sure?', 'stats/clear');
    mk(ua, C.tf('status.clear_alltime', 'Clear'),
       C.tf('status.clear_alltime_tooltip', 'Clear all-time metrics'),
       'status.clear_confirm', 'Are you sure?', 'stats/clear-alltime');
    mk(ca, 'SSD purge',
       C.tf('status.clear_ssd_cache_tooltip', 'Delete all SSD cache'),
       'status.clear_ssd_cache_confirm', 'Delete all SSD cache?',
       'ssd-cache/clear');
    mk(ca, 'Hot purge',
       C.tf('status.runtime_cache.clear_memory_tooltip', 'Clear memory cache'),
       'status.runtime_cache.clear_memory_confirm', 'Clear memory cache?',
       'hot-cache/clear');
})();

window.Uplift.usage = {
    pollUsage: pollUsage, pollLogs: pollLogs, initUsageRange: initUsageRange,
    relabelUsageRange: relabelUsageRange, renderUsageSub: renderUsageSub,
    get logsFollow() { return logsFollow; },
};
})();
