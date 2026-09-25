/* Uplift usage + logs tabs (PH2-1 stage 3 extraction from uplift.js):
   Usage tab polling/heatmap/table and the Logs tab tail with level/grep
   filters. Loads AFTER uplift_state.js (usageRange/usageAvg/logsFollow live
   in the shared state cell) and BEFORE uplift.js, which exposes hoisted
   helpers (fetchJson/setCounter/...) via window.Uplift._usageGlue.
   Exports window.Uplift.usage. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
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
        const u = await window.Uplift._usageGlue.fetchJson(`${API}/admin/api/usage?range=${S.usageRange}`);
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
            for (const h of ['model', 'req', 'prompt', 'completion', 'cached', 'avg t/req']) head.append(window.Uplift._usageGlue.cell(h));
            table.append(head);
            for (const m of models) {
                const row = document.createElement('div'); row.className = 'urow admin';
                const name = window.Uplift._usageGlue.cell(m.model_id); name.className = 'uname'; name.title = m.model_id;
                row.append(name, window.Uplift._usageGlue.cell(C.fmtNumber(m.requests)), window.Uplift._usageGlue.cell(C.fmtCompact(m.prompt_tokens)),
                           window.Uplift._usageGlue.cell(C.fmtCompact(m.completion_tokens)), window.Uplift._usageGlue.cell(C.fmtCompact(m.cached_tokens)),
                           window.Uplift._usageGlue.cell(m.requests ? C.fmtCompact((m.prompt_tokens + m.completion_tokens) / m.requests) : '—'));
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
let logsFilesLoaded = false, logsFollow = true;
async function pollLogs() {
    if (document.hidden && !logsFollow) return;
    try {
        const lines = Number($('logs-lines').value || 300);
        const file = $('logs-file').value;
        let url = `${API}/admin/api/logs?lines=${lines}`;
        if (file) url += `&file=${encodeURIComponent(file)}`;
        const d = await window.Uplift._usageGlue.fetchJson(url);
        if (!logsFilesLoaded && Array.isArray(d.available_files)) {
            window.Uplift._usageGlue.fillSelect($('logs-file'), d.available_files.map(f => [f, f]), d.log_file || d.available_files[0]);
            logsFilesLoaded = true;
        }
        let rows = String(d.logs || '').split('\n').filter(Boolean);
        const level = $('logs-level').value;
        const grep = ($('logs-grep').value || '').toLowerCase();
        rows = rows.filter(l => {
            if (level && !l.includes(` - ${level} - `)) return false;
            if (!level && layout.logsHideDebug && / - (DEBUG|TRACE) - /.test(l)) return false;
            if (grep && !l.toLowerCase().includes(grep)) return false;
            return true;
        });
        const pre = $('logs');
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const line of rows.slice(-800)) {
            const span = document.createElement('span');
            const lv = / - (ERROR|WARNING|TRACE|DEBUG) - /.exec(line);
            if (lv) span.className = `lv-${lv[1]}`;
            span.textContent = line + '\n';
            frag.append(span);
        }
        pre.append(frag);
        if (logsFollow || atBottom) pre.scrollTop = pre.scrollHeight;
        $('logs-sub').textContent = `${rows.length} lines${d.log_file ? ' · ' + d.log_file : ''}`;
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

window.Uplift.usage = {
    pollUsage: pollUsage, pollLogs: pollLogs, initUsageRange: initUsageRange,
    relabelUsageRange: relabelUsageRange, renderUsageSub: renderUsageSub,
    get logsFollow() { return logsFollow; },
};
})();
