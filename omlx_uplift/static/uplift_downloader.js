/* Uplift DOWNLOADER page + shared task-list helpers (PH2-1 stage 9a
   extraction from uplift.js): HF downloader tabs (trending/popular/search,
   paging, sort), queueDownload, and the task-row renderer the quantizer/
   uploader pages share. Plain script; loads AFTER uplift_state.js, BEFORE
   uplift.js, which late-binds fetchJson/postJson/toast/emptyMsg/cell via
   window.Uplift._downloaderGlue (resolved at call time). Exports
   window.Uplift.downloader {renderTasks, initDownloader}. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const DG = {
    get fetchJson() { return window.Uplift._downloaderGlue.fetchJson; },
    get postJson() { return window.Uplift._downloaderGlue.postJson; },
    get toast() { return window.Uplift._downloaderGlue.toast; },
    get emptyMsg() { return window.Uplift._downloaderGlue.emptyMsg; },
    get cell() { return window.Uplift._downloaderGlue.cell; },
};
function taskRow(t) {
    const row = document.createElement('div'); row.className = 'urow usage';
    const st = (t.status || 'unknown').toUpperCase();
    // progress arrives as 0..100 already (hf/ms/oq task dicts) — classic does
    // Math.round(task.progress); the old x100 here showed "2280%"
    const pct = Math.round(t.progress || 0);
    const activeSt = ['downloading', 'quantizing', 'uploading'].includes((t.status || '').toLowerCase());
    // size column: downloaded/total while running (classic parity), final size when done
    const total = t.total_size || t.size || t.output_size || 0;
    const done = t.downloaded_size != null ? t.downloaded_size : (t.size || t.output_size || 0);
    const sizeTxt = activeSt && total
        ? `${C.fmtBytes(done)} / ${C.fmtBytes(total)}`
        : (t.size_formatted || C.fmtBytes(total));
    row.append(DG.cell(t.name || t.model_name || t.repo_id || t.model || t.model_path || '—'),
               DG.cell(t.dest || t.target_repo || ''),
               DG.cell(st + (activeSt ? ` ${Math.min(pct, 100)}%` : '')),
               DG.cell(t.error || sizeTxt));
    return row;
}
function renderTasks(hostId, kind) {
    DG.fetchJson(`${API}/admin/api/${kind}/tasks`).then(d => {
        const host = $(hostId);
        host.innerHTML = '';
        const tasks = d.tasks || [];
        if (!tasks.length) { host.innerHTML = '<div class="empty">No tasks</div>'; return; }
        let active = false;
        for (const t of tasks) {
            const r = taskRow(t);
            // API field is task_id (older mock data used id) — a wrong value
            // here POSTed /cancel/undefined and the control silently failed
            const tid = t.task_id || t.id;
            // controls render as real buttons in the house action column so
            // they align right with the other row actions (they used to be
            // bare spans wrapping onto a stray grid track at bottom-left)
            const acts = document.createElement('span'); acts.className = 'rowacts';
            const mkAct = (label, title, fn) => {
                const x = document.createElement('button');
                x.className = 'se-btn act'; x.textContent = label; x.title = title;
                x.onclick = fn; acts.append(x);
            };
            if (['downloading', 'quantizing', 'uploading', 'queued', 'pending'].includes(t.status)) {
                active = true;
                mkAct('CANCEL', 'Stop this task', () => DG.postJson(`${API}/admin/api/${kind}/cancel/${tid}`, {})
                    .then(() => renderTasks(hostId, kind)).catch(e => DG.toast('cancel: ' + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            } else if (kind === 'hf' && ['failed', 'cancelled', 'canceled', 'error'].includes((t.status || '').toLowerCase())) {
                // U11 parity: classic offers retry (resumes partial files)
                mkAct('RETRY', 'Resume this download from existing files', () =>
                    DG.postJson(`${API}/admin/api/hf/retry/${tid}`,
                        { hf_token: ($('dl-token') ? $('dl-token').value.trim() : '') })
                        .then(() => renderTasks(hostId, kind)).catch(e => DG.toast('retry: ' + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            }
            host.append(r);
        }
        if (active) {   // gentle live progress while an entry is still running
            setTimeout(() => {
                const card = host.closest('section');
                if (card && card.style.display !== 'none' && !document.hidden)
                    renderTasks(hostId, kind);
            }, 2000);
        }
    }).catch(e => DG.emptyMsg($(hostId), e.message));
}

let dlInit = false;
const DL = {
    tab: 'trending',                 // trending | popular | search
    rec: { trending: null, popular: null },   // cached suggested lists
    search: [],
    page: { trending: 1, popular: 1, search: 1 },
    size: 10,
    sort: { key: 'rank', dir: 1 },   // client column sort (classic parity)
    q: '',
    busy: false,
};
function dlPageSize() {
    // classic parity: fit ~10..30 rows in the available window height
    const h = window.innerHeight || 800;
    return Math.max(10, Math.min(30, Math.floor((h - 320) / 34 / 10) * 10 || 10));
}
function dlSortModels(list, key, dir, fallbackKey) {
    const rows = list.slice();
    if (key === 'rank' || !key) {
        if (fallbackKey) rows.sort((a, b) => (b[fallbackKey] || 0) - (a[fallbackKey] || 0));
        return rows;
    }
    rows.sort((a, b) => {
        let x = a[key], y = b[key];
        if (key === 'name') { x = (x || '').toLowerCase(); y = (y || '').toLowerCase();
            return dir * (x < y ? -1 : x > y ? 1 : 0); }
        if (key === 'size') { x = a.size || 0; y = b.size || 0; }
        if (key === 'params') { x = a.params || 0; y = b.params || 0; }
        if (x == null) x = -Infinity; if (y == null) y = -Infinity;
        return dir * (x - y);
    });
    return rows;
}
function initDownloader() {
    const $dl = id => document.getElementById(id);
    const token = () => ($dl('dl-token') || {}).value?.trim() || '';
    const queueDownload = (repoId, fromBtn) => {
        if (!repoId) { DG.toast(C.t('uplift.toast.repo_id_required')); return; }
        if (fromBtn) { fromBtn.disabled = true; fromBtn.textContent = 'queued…'; }
        DG.postJson(`${API}/admin/api/hf/download`,
            { repo_id: repoId, hf_token: token() }).then(r => {
                // live: {success, task:{task_id}} · shadow: {task_id}
                const tid = (r.task && r.task.task_id) || r.task_id || r.id || '';
                DG.toast(C.t('uplift.toast.download_queued', {repo: repoId}) + (tid ? ` #${String(tid).slice(0, 8)}` : ''));
                renderTasks('dl-tasks', 'hf');
            }).catch(e => { DG.toast('download: ' + e.message);
                if (fromBtn) { fromBtn.disabled = false; fromBtn.textContent = 'download'; } });
    };
    function setTab(tab) {
        DL.tab = tab;
        for (const t of ['trending', 'popular', 'search']) {
            const b = $dl('dl-tab-' + t); if (b) b.classList.toggle('on', t === tab);
        }
        DL.page[tab] = DL.page[tab] || 1;
        if (tab === 'search' && !DL.search.length && DL.q) doSearch();
        renderDlPage();
    }
    function renderDlPage() {
        const host = $dl('dl-results'); if (!host) return;
        const sub = $dl('dl-sub');
        host.innerHTML = '';
        const list = DL.tab === 'search' ? DL.search : DL.rec[DL.tab];
        if (list == null) { host.innerHTML = '<div class="empty">Loading suggestions…</div>'; return; }
        if (!list.length) {
            host.innerHTML = '<div class="empty">' + (DL.tab === 'search' ? 'No results — try another query.' : 'HF suggested models unavailable.') + '</div>';
            const pg = $dl('dl-pager'); if (pg) pg.innerHTML = '';
            return;
        }
        const fallback = DL.tab === 'popular' ? 'downloads' : 'trending_score';
        const rows = dlSortModels(list, DL.sort.key, DL.sort.dir, DL.tab === 'search' ? null : fallback);
        DL.size = dlPageSize();
        const pages = Math.max(1, Math.ceil(rows.length / DL.size));
        if (DL.page[DL.tab] > pages) DL.page[DL.tab] = pages;
        const start = (DL.page[DL.tab] - 1) * DL.size;
        // header (sortable, classic parity)
        const cols = [['rank', '#'], ['name', 'Model'], ['params', 'Params'],
                      ['size', 'Size'], ['downloads', 'Downloads'], ['likes', 'Likes'], [null, '']];
        const head = document.createElement('div'); head.className = 'urow usage head';
        for (const [key, label] of cols) {
            const s = DG.cell(label + (DL.sort.key === key && key ? (DL.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
            if (key) { s.className = 'sortable' + (DL.sort.key === key ? ' sorted' : '');
                s.onclick = () => {
                    if (DL.sort.key === key) DL.sort.dir = -DL.sort.dir;
                    else { DL.sort.key = key; DL.sort.dir = (key === 'name' || key === 'rank') ? 1 : -1; }
                    renderDlPage();
                };
            }
            head.append(s);
        }
        host.append(head);
        for (const m of rows.slice(start, start + DL.size)) {
            const row = document.createElement('div'); row.className = 'urow usage';
            const rank = DG.cell(m.rank ? '#' + m.rank : '');
            const name = DG.cell(m.name || m.repo_id); name.className = 'uname';
            name.title = m.repo_id;
            row.append(rank, name,
                DG.cell(m.params_formatted || (m.params ? C.fmtNumber(m.params) : '')),
                DG.cell(m.size_formatted || C.fmtBytes(m.size || 0)),
                DG.cell(m.downloads != null ? C.fmtNumber(m.downloads) : ''),
                DG.cell(m.likes != null ? C.fmtNumber(m.likes) : ''));
            const act = document.createElement('span'); act.className = 'rowacts';
            const b = document.createElement('button');
            b.className = 'se-btn act'; b.textContent = 'download';
            b.onclick = () => queueDownload(m.repo_id, b);
            act.append(b); row.append(act);
            host.append(row);
        }
        if (sub) {
            const extra = DL.tab === 'search' ? `“${DL.q}”` : (DL.rec.trending && true ? 'suggested by HF' : '');
            const inv = (DL._invalid || DL.rec._invalid) ? ' · HF token rejected — listed anonymously' : '';
            sub.textContent = `${rows.length} results ${extra}${inv}`;
        }
        // pager
        const pg = $dl('dl-pager'); if (!pg) return;
        pg.innerHTML = '';
        if (pages <= 1) return;
        const mk = (label, page, dis) => {
            const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis;
            b.onclick = () => { DL.page[DL.tab] = page; renderDlPage();
                $dl('dl-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
            pg.append(b);
        };
        mk('«', 1, DL.page[DL.tab] === 1);
        mk('‹', DL.page[DL.tab] - 1, DL.page[DL.tab] === 1);
        mk('›', DL.page[DL.tab] + 1, DL.page[DL.tab] === pages);
        mk('»', pages, DL.page[DL.tab] === pages);
        const info = document.createElement('span'); info.className = 'pinfo';
        info.textContent = `${DL.page[DL.tab]} / ${pages} · ${rows.length} models`;
        pg.append(info);
    }
    // safe empty-state (server error text goes through textContent, never innerHTML)
    function setEmpty(msg) {
        const host = $dl('dl-results'); if (!host) return;
        host.innerHTML = '';
        const d = document.createElement('div'); d.className = 'empty'; d.textContent = msg;
        host.append(d);
    }
    function loadRecommended(force) {
        if (DL.busy) return;
        const mlx = $dl('dl-mlx') ? $dl('dl-mlx').checked : true;
        if (!force && DL.rec.trending && DL.rec._mlx === mlx) { renderDlPage(); return; }
        DL.busy = true;
        DG.fetchJson(`${API}/admin/api/hf/recommended?mlx_only=${mlx}`).then(d => {
            DL.rec = {
                trending: (d.trending || []).map((m, i) => ({ ...m, rank: i + 1 })),
                popular: (d.popular || []).map((m, i) => ({ ...m, rank: i + 1 })),
                _mlx: mlx,
            };
            DL._invalid = !!d.hf_token_invalid;
            DL.busy = false;
            if (DL.tab !== 'search') { DL.page[DL.tab] = 1; DL.sort = { key: 'rank', dir: 1 }; }
            renderDlPage();
        }).catch(e => {
            DL.busy = false;
            DL.rec.trending = DL.rec.trending || [];
            DL.rec.popular = DL.rec.popular || [];
            const host = $dl('dl-results');
            if (host && DL.tab !== 'search') setEmpty('Suggestions failed: ' + e.message);
        });
    }
    function doSearch() {
        const q = ($dl('dl-q') || {}).value?.trim();
        if (!q) { DG.toast(C.t('uplift.toast.type_query')); return; }
        const sort = $dl('dl-sort').value || 'trending';
        const mlx = $dl('dl-mlx') ? $dl('dl-mlx').checked : true;
        DL.q = q; DL.busy = true;
        const sub = $dl('dl-sub'); if (sub) sub.textContent = 'searching…';
        const host = $dl('dl-results'); if (host) host.innerHTML = '<div class="empty">Searching huggingface.co…</div>';
        DG.fetchJson(`${API}/admin/api/hf/search?q=${encodeURIComponent(q)}&limit=100&sort=${sort}&mlx_only=${mlx}`).then(d => {
            DL.search = (d.models || []).map((m, i) => ({ ...m, rank: i + 1 }));
            DL._invalid = !!d.hf_token_invalid;
            DL.busy = false;
            DL.page.search = 1; DL.sort = { key: 'rank', dir: 1 };
            setTab('search');
        }).catch(e => {
            DL.busy = false; DL.search = [];
            if (sub) sub.textContent = '';
            setEmpty('Search failed: ' + e.message);
        });
    }
    if (!dlInit) {
        dlInit = true;
        // token: persisted in this browser only (user preference: localStorage)
        const tk = $dl('dl-token');
        try { tk.value = localStorage.getItem('uplift.hf_token') || ''; } catch (_) {}
        tk.addEventListener('change', () => {
            try { localStorage.setItem('uplift.hf_token', tk.value.trim()); } catch (_) {}
        });
        $dl('dl-go').onclick = doSearch;
        $dl('dl-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        $dl('dl-sort').onchange = () => { if (DL.tab === 'search' && DL.q) doSearch(); };
        $dl('dl-mlx').onchange = () => {
            if (DL.tab === 'search') doSearch(); else loadRecommended(true);
        };
        for (const t of ['trending', 'popular', 'search']) {
            const b = $dl('dl-tab-' + t);
            if (b) b.onclick = () => {
                if (t === 'search' && !DL.q) { DG.toast(C.t('uplift.toast.type_query_press_search')); $dl('dl-q').focus(); return; }
                setTab(t);
            };
        }
        $dl('dl-direct').onclick = () => queueDownload($dl('dl-repo').value.trim(), $dl('dl-direct'));
        $dl('dl-repo').addEventListener('keydown', e => {
            if (e.key === 'Enter') queueDownload($dl('dl-repo').value.trim()); });
    }
    if (DL.tab === 'search' && DL.search.length) renderDlPage();
    else loadRecommended();
    renderTasks('dl-tasks', 'hf');
}

window.Uplift = window.Uplift || {};
window.Uplift.downloader = { renderTasks, initDownloader };
})();
