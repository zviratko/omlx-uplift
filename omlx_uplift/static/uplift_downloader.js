/* Uplift DOWNLOADER page + shared task-list helpers (PH2-1 stage 9a
   extraction from uplift.js): HF downloader tabs (trending/popular/search,
   paging, sort), the UP-14 file-pick download dialog, and the task-row
   renderer the quantizer/
   uploader pages share. Plain script; loads AFTER uplift_state.js, BEFORE
   uplift.js, which late-binds fetchJson/postJson/toast/emptyMsg/cell via
   window.UpliftDom (FE-1: no glue needed — all five were primitives). Exports
   window.Uplift.downloader {renderTasks, initDownloader}. UP-14 (2026-10-24):
   every download entry opens the classic-parity FILE-PICK DIALOG first and
   HF/mirror URLs normalize to owner/repo — see the UP-14 section. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const DG = D;   // FE-1: pure-primitive glue -> domkit itself
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
        // UP-14: the dialog's DOWNLOADED badge wants the newest task list —
        // classic isModelDownloaded keys on the LATEST match per repo
        if (kind === 'hf') DL.hfTasks = tasks;
        // ACHIEVEMENTS: seed silently on first sight, then judge transitions
        try {
            const AC = window.Uplift && window.Uplift.achv;
            if (AC) AC.announceTasks(kind, tasks);
        } catch (_) { /* verdicts never block the board */ }

        if (!tasks.length) { D.emptyMsg(host, C.t('uplift.dl.no_tasks')); return; }
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
                    .then(() => renderTasks(hostId, kind)).catch(e => DG.toast(C.tf('uplift.dl.cancel_fail', 'cancel: ') + e.message)));
                r.classList.add('with-acts'); r.append(acts);
            } else if (kind === 'hf' && ['failed', 'cancelled', 'canceled', 'error'].includes((t.status || '').toLowerCase())) {
                // U11 parity: classic offers retry (resumes partial files)
                mkAct('RETRY', 'Resume this download from existing files', () =>
                    DG.postJson(`${API}/admin/api/hf/retry/${tid}`,
                        { hf_token: ($('dl-token') ? $('dl-token').value.trim() : '') })
                        .then(() => renderTasks(hostId, kind)).catch(e => DG.toast(C.tf('uplift.dl.retry_fail', 'retry: ') + e.message)));
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
    gs: null,                    // global-settings cache (mirror endpoint, RAM size)
    hfModels: [],                // /admin/api/hf/models — DOWNLOADED badge
    hfTasks: [],                 // latest /admin/api/hf/tasks read (UP-14)
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
/* ---- UP-14 (FEAT-1 adoption, 2026-10-24): classic model-download dialog ----
   Every download entry opens this dialog first — the operator picks files
   (classic: "Every download picks its files in the detail modal first",
   dashboard.js:7770). The URL parse, the selection machine and the footer
   gating are ported from classic dashboard.js — hfRepoIdFromInput ~7045,
   resetHfSelection..hfFitsDisk ~8288-8360, isModelDownloaded ~7775,
   submitHFDownload ~7079 — keep them line-adjacent so drift syncs diff as
   parity. Labels are classic catalog keys: t() resolves the mounted classic
   catalog live, so this adds ZERO uplift locale churn. */

// Convert Hugging Face and configured mirror model URLs to owner/repo ids.
// Leave plain repository IDs and other input unchanged for model lookup.
function hfRepoIdFromInput(value, endpoint) {
    const raw = String(value ?? '').trim();
    const officialLink = /^(?:(?:https?:)?\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/?#\s]+\/[^/?#\s]+)/i;
    const officialMatch = raw.match(officialLink);
    if (officialMatch) return officialMatch[1];
    const ep = String(endpoint ?? '').trim();
    if (ep) {
        try {
            const mirror = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(ep) ? ep : `https://${ep}`);
            const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const prefix = mirror.pathname.split('/').filter(Boolean).map(escape).join('/');
            const pathPrefix = prefix ? `(?:${prefix}/)?` : '';
            const mirrorLink = new RegExp(
                `^(?:(?:https?:)?//)?(?:www\\.)?${escape(mirror.host)}/${pathPrefix}([^/?#\\s]+/[^/?#\\s]+)`,
                'i');
            const mirrorMatch = raw.match(mirrorLink);
            if (mirrorMatch) return mirrorMatch[1];
        } catch {
            // Ignore invalid mirror settings and keep the official hosts.
        }
    }
    return raw;
}

// Pure selection state machine over a /admin/api/hf/model-info payload
// (rows: name,size,local,required,preselected,group,mmproj,kind — the shape
// omlx/admin/hf_downloader.py ~700-760 builds). Tests drive this directly.
const HFS = {
    // A selection starts from what "download all" fetches; GGUF repos start empty.
    initial(detail) {
        const picked = {};
        for (const file of (detail && detail.files) || []) {
            if (file.preselected && !file.local) picked[file.name] = true;
        }
        return picked;
    },
    locked(file) { return !!file.required || !!file.local; },
    selected(file, picked) { return !file.local && (!!file.required || !!picked[file.name]); },
    // A split GGUF's parts toggle together; a GGUF brings its vision projector.
    toggle(detail, picked, file) {
        if (HFS.locked(file)) return picked;
        const files = detail.files || [];
        const on = !picked[file.name];
        const next = { ...picked };
        const members = file.group ? files.filter(f => f.group === file.group) : [file];
        for (const m of members) if (!m.local) next[m.name] = on;
        const projector = on && file.mmproj && files.find(f => f.name === file.mmproj);
        if (projector && !projector.local) next[projector.name] = true;
        return next;
    },
    names(detail, picked) {
        return ((detail && detail.files) || [])
            .filter(f => HFS.selected(f, picked)).map(f => f.name);
    },
    selSize(detail, picked) {
        return ((detail && detail.files) || [])
            .filter(f => HFS.selected(f, picked))
            .reduce((total, f) => total + (f.size || 0), 0);
    },
    // A split GGUF loads as one model: size the whole set.
    rowSize(detail, file) {
        if (!file.group) return file.size || 0;
        return (detail.files || []).filter(f => f.group === file.group)
            .reduce((total, f) => total + (f.size || 0), 0);
    },
    // What "download all" still has to fetch: its files not downloaded yet.
    allSize(detail) {
        const files = (detail && detail.files) || [];
        if (!files.length) return (detail && detail.download_all_size) || 0;
        const fetched = detail.layout === 'safetensors' ? (f => f.preselected) : (() => true);
        return files.filter(f => fetched(f) && !f.local)
            .reduce((total, f) => total + (f.size || 0), 0);
    },
    fits(detail, bytes) {
        const free = detail && detail.disk_free;
        return !free || bytes <= free;
    },
    // classic getMemoryFitStatus: GGUF size against installed RAM
    memFit(totalBytes, sizeBytes) {
        if (!totalBytes || !sizeBytes) return 'safe';
        const ratio = sizeBytes / totalBytes;
        if (ratio > 0.95) return 'danger';
        if (ratio > 0.80) return 'warning';
        return 'safe';
    },
    // classic isModelDownloaded — a cancelled or failed download keeps its
    // finished files for resume, so only the LATEST task can veto.
    downloaded(repoId, models, tasks) {
        if (!repoId) return false;
        const wanted = repoId.toLowerCase();
        const matches = it => String((it && it.repo_id) || '').toLowerCase() === wanted;
        let latest = null;
        for (const t of tasks || []) if (matches(t)) latest = t;
        const unfinished = !!latest && latest.status !== 'completed';
        return !unfinished && (models || []).some(matches);
    },
};

function dlToken() { return (D.$('dl-token') || {}).value?.trim() || ''; }

let DLGS = null;   // global-settings in-flight cache (mirror endpoint + total RAM)
function dlGlobalSettings() {
    if (!DLGS) DLGS = DG.fetchJson(`${API}/admin/api/global-settings`)
        .then(gs => gs || {})
        .catch(() => { DLGS = null; return {}; });
    return DLGS;
}

function directDownload() {
    const inp = D.$('dl-repo'); if (!inp) return;
    const ep = (DL.gs && DL.gs.huggingface && DL.gs.huggingface.endpoint) || '';
    const id = hfRepoIdFromInput(inp.value, ep);
    if (!id) { DG.toast(C.t('uplift.toast.repo_id_required')); return; }
    inp.value = id;                 // normalized id stays visible (classic)
    openModelFiles(id);
}

function dlBadge(kind, text) {
    const s = document.createElement('span');
    s.className = 'badge dl-b ' + kind; s.textContent = text;
    return s;
}

function openModelFiles(repoId) {
    if (!repoId) return;
    const token = dlToken();
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const box = document.createElement('div'); box.className = 'modal nasa dl-modal';
    const h = document.createElement('h3'); h.textContent = repoId;
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'icon-btn';
    close.setAttribute('aria-label', 'Close'); close.textContent = '×';
    close.onclick = () => overlay.remove();
    h.append(close);
    const body = document.createElement('div'); body.className = 'dl-body';
    const foot = document.createElement('div'); foot.className = 'dl-foot';
    const meta = document.createElement('div'); meta.className = 'dl-meta';
    box.append(h, meta, body, foot);
    overlay.append(box);
    // Backdrop click is the mouse twin of Esc — Escape itself rides the
    // GLOBAL .modal-overlay handler in uplift_state.js (modal-escape pin:
    // NO keydown listener here).
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.body.append(overlay);
    body.textContent = C.tf('models.detail.loading', 'Loading model info...');

    let detail = null, picked = {}, sending = false, tab = 'files';

    DG.fetchJson(`${API}/admin/api/hf/model-info?${new URLSearchParams({ repo_id: repoId })}`,
        token ? { headers: { 'X-HF-Token': token } } : undefined)
        .then(d => {
            detail = d || {};
            h.textContent = detail.repo_id || repoId;
            picked = HFS.initial(detail);
            renderMeta();
            refresh();
            // the DOWNLOADED badge reads the fresh repo list + latest tasks
            DG.fetchJson(`${API}/admin/api/hf/models`)
                .then(s => { DL.hfModels = (s && s.models) || []; if (detail) refresh(); })
                .catch(() => {});
        })
        .catch(e => {
            body.textContent = C.tf('uplift.dl.download_fail', 'download: ')
                + (e && e.message ? e.message : e);
        });
    dlGlobalSettings().then(gs => {
        if (!DL.gs && gs && Object.keys(gs).length) { DL.gs = gs; if (detail) refresh(); }
    });

    function mkBtn(cls, key, en, fn, dis) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = cls;
        b.textContent = C.tf(key, en);
        b.disabled = !!dis;
        if (fn) b.onclick = fn;
        return b;
    }

    function renderMeta() {
        meta.innerHTML = '';   // house container-clear (see refresh)
        const chip = txt => {
            const s = document.createElement('span'); s.className = 'dl-mchip';
            s.textContent = txt; meta.append(s);
        };
        if (detail.size > 0 && detail.size_formatted) chip(detail.size_formatted);
        chip('\u2b07 ' + (detail.downloads != null ? C.fmtNumber(detail.downloads) : '0'));
        chip('\u2665 ' + (detail.likes != null ? detail.likes : 0));
        if (detail.params && detail.params_formatted)
            chip(detail.params_formatted + ' ' + C.tf('models.browse.params_suffix', 'params'));
        if (detail.pipeline_tag) {
            const b = document.createElement('span'); b.className = 'badge dl-b dim';
            b.textContent = detail.pipeline_tag; meta.append(b);
        }
    }

    function filesPanel(host) {
        const files = detail.files || [];
        if (!files.length) {
            const p = document.createElement('div'); p.className = 'empty';
            p.textContent = detail.unavailable
                || C.tf('models.detail.no_files', 'No file information available.');
            host.append(p);
            return;
        }
        if (!detail.is_adapter && !detail.unsupported_reason && detail.layout !== 'other') {
            const note = document.createElement('div'); note.className = 'se-hint';
            note.textContent = detail.layout === 'safetensors'
                ? C.tf('models.detail.pick_files_checkpoint', 'Files the model needs stay checked. Uncheck the extras you do not want.')
                : C.tf('models.detail.pick_files_gguf', 'Check the GGUF files to download. A GGUF brings its vision projector with it.');
            host.append(note);
        }
        const ram = (DL.gs && DL.gs.system && DL.gs.system.total_memory_bytes) || 0;
        const list = document.createElement('div'); list.className = 'dl-files';
        for (const f of files) {
            const lb = document.createElement('label'); lb.className = 'dl-file';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!f.local || HFS.selected(f, picked);
            cb.disabled = HFS.locked(f) || sending;
            cb.onchange = () => { picked = HFS.toggle(detail, picked, f); refresh(); };
            const nm = document.createElement('span');
            nm.className = 'dl-fname'; nm.textContent = f.name; nm.title = f.name;
            lb.append(cb, nm);
            if (f.local) lb.append(dlBadge('ok', C.tf('models.detail.file_downloaded', 'Downloaded')));
            else if (f.required) lb.append(dlBadge('dim', C.tf('models.detail.required_file', 'Required')));
            if (f.kind === 'gguf' && !f.local) {
                const fit = HFS.memFit(ram, HFS.rowSize(detail, f));
                if (fit === 'warning') lb.append(dlBadge('warn', C.tf('models.browse.tight_fit', 'Tight fit')));
                else if (fit === 'danger') lb.append(dlBadge('bad', C.tf('models.browse.high_oom_risk', 'High OOM risk')));
            }
            const sz = document.createElement('span');
            sz.className = 'dl-fsize';
            sz.textContent = f.size ? C.fmtBytes(f.size) : '';
            lb.append(sz);
            list.append(lb);
        }
        host.append(list);
    }

    function cardPanel(host) {
        if (!detail.model_card) {
            const p = document.createElement('div'); p.className = 'empty';
            p.textContent = C.tf('models.detail.no_model_card', 'No model card available.');
            host.append(p);
            return;
        }
        const holder = document.createElement('div'); holder.className = 'dl-card';
        holder.textContent = detail.model_card;      // raw markdown until libs arrive
        host.append(holder);
        Promise.all([D.loadScript('./vendor/marked.umd.js'),
                     D.loadScript('./vendor/purify.min.js')])
            .then(() => {
                // The ONE sanctioned innerHTML sink: sanitized exactly like
                // classic — DOMPurify.sanitize(marked.parse(card)) over
                // untrusted remote markdown. Loader failure keeps the raw-text
                // fallback visible (never an unsanitized parse).
                try {
                    holder.innerHTML = window.DOMPurify.sanitize(
                        window.marked.parse(detail.model_card));
                } catch (_) { /* keep raw text */ }
            })
            .catch(() => { holder.classList.add('dl-card-raw'); });
    }

    function tagsPanel(host) {
        const tags = detail.tags || [];
        if (!tags.length) {
            const p = document.createElement('div'); p.className = 'empty';
            p.textContent = C.tf('models.detail.no_tags', 'No tags available.');
            host.append(p);
            return;
        }
        const wrap = document.createElement('div'); wrap.className = 'dl-tags';
        for (const t of tags) {
            const s = document.createElement('span'); s.className = 'dl-tag';
            s.textContent = t; wrap.append(s);
        }
        host.append(wrap);
    }

    function refresh() {
        if (!detail) return;
        // innerHTML='' is the house CONTAINER-CLEAR (text-only rebuild below;
        // every string enters via textContent — the sole HTML sink is the
        // DOMPurify-sanitized card in cardPanel, classic-identical)
        body.innerHTML = ''; foot.innerHTML = '';
        // Tabs mirror classic's dialog (Model Card | Files (n) | Tags); the
        // house segmented control is the .se-btn.seg + .on pattern.
        const n = (detail.files || []).length;
        const tabs = [['card', 'models.detail.tab.model_card', 'Model Card', ''],
                      ['files', 'models.detail.tab.files', 'Files', n ? ' (' + n + ')' : ''],
                      ['tags', 'models.detail.tab.tags', 'Tags', '']];
        const bar = document.createElement('div'); bar.className = 'dl-tabs';
        for (const [t, key, en, extra] of tabs) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'se-btn seg' + (tab === t ? ' on' : '');
            b.textContent = C.tf(key, en) + extra;
            b.onclick = () => { tab = t; refresh(); };
            bar.append(b);
        }
        body.append(bar);
        if (tab === 'files') filesPanel(body);
        else if (tab === 'card') cardPanel(body);
        else tagsPanel(body);
        // Footer gating mirrors classic: adapter / unsupported_reason swap
        // the action buttons for a warning chip; a fully-downloaded
        // non-GGUF repo shows the DOWNLOADED badge instead of buttons.
        const hf = document.createElement('a');
        hf.className = 'dl-hf'; hf.target = '_blank'; hf.rel = 'noopener noreferrer';
        hf.href = `https://huggingface.co/${detail.repo_id || repoId}`;
        hf.textContent = C.tf('models.detail.view_on_hf', 'View on HuggingFace');
        foot.append(hf);
        const bytes = HFS.selSize(detail, picked);
        if (!detail.is_adapter && !HFS.fits(detail, bytes)) {
            const w = document.createElement('span'); w.className = 'dl-space';
            w.textContent = C.tf('models.recommend.not_enough_space', 'Not enough free space in the model folder');
            foot.append(w);
        }
        foot.append(mkBtn('btn', 'models.detail.cancel', 'Cancel', () => overlay.remove()));
        if (detail.is_adapter) {
            foot.append(dlBadge('warn', C.tf('models.detail.lora_warning', 'LoRA adapter — not supported')));
        } else if (detail.unsupported_reason) {
            foot.append(dlBadge('warn', String(detail.unsupported_reason)));
        } else if (detail.layout === 'gguf'
                || !HFS.downloaded(detail.repo_id || repoId, DL.hfModels, DL.hfTasks)) {
            const allSz = HFS.allSize(detail);
            const all = mkBtn('btn', 'models.detail.download_all', 'Download all',
                () => submit(null), sending || !HFS.fits(detail, allSz));
            if (allSz) all.append(document.createTextNode(' ' + C.fmtBytes(allSz)));
            const names = HFS.names(detail, picked);
            const sel = mkBtn('btn primary', 'models.detail.download_selected', 'Download selected',
                () => submit(names), sending || !names.length || !HFS.fits(detail, bytes));
            if (bytes) sel.append(document.createTextNode(' ' + C.fmtBytes(bytes)));
            foot.append(all, sel);
        } else {
            foot.append(dlBadge('ok', C.tf('models.browse.downloaded', 'Downloaded')));
        }
    }

    function submit(files) {
        if (sending) return;
        const repo = detail.repo_id || repoId;
        sending = true; refresh();
        // files:null = classic 'download all' — the server default layout
        DG.postJson(`${API}/admin/api/hf/download`,
            { repo_id: repo, hf_token: token, files })
            .then(r => {
                // live: {success, task:{task_id}} · shadow: {task_id}
                const tid = (r.task && r.task.task_id) || r.task_id || r.id || '';
                DG.toast(C.t('uplift.toast.download_queued', { repo })
                    + (tid ? ` #${String(tid).slice(0, 8)}` : ''));
                overlay.remove();
                renderTasks('dl-tasks', 'hf');
            })
            .catch(e => {
                sending = false; refresh();
                DG.toast(C.tf('uplift.dl.download_fail', 'download: ')
                    + (e && e.message ? e.message : e));
            });
    }
}

function initDownloader() {
    function setTab(tab) {
        DL.tab = tab;
        for (const t of ['trending', 'popular', 'search']) {
            const b = D.$('dl-tab-' + t); if (b) b.classList.toggle('on', t === tab);
        }
        DL.page[tab] = DL.page[tab] || 1;
        if (tab === 'search' && !DL.search.length && DL.q) doSearch();
        renderDlPage();
    }
    function renderDlPage() {
        const host = D.$('dl-results'); if (!host) return;
        const sub = D.$('dl-sub');
        host.innerHTML = '';
        const list = DL.tab === 'search' ? DL.search : DL.rec[DL.tab];
        if (list == null) { D.emptyMsg(host, C.t('uplift.dl.loading')); return; }
        if (!list.length) {
            D.emptyMsg(host, DL.tab === 'search' ? 'No results — try another query.' : 'HF suggested models unavailable.');
            const pg = D.$('dl-pager'); if (pg) pg.innerHTML = '';
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
            b.onclick = () => openModelFiles(m.repo_id);   // UP-14: pick files first (classic)
            act.append(b); row.append(act);
            host.append(row);
        }
        if (sub) {
            const extra = DL.tab === 'search' ? `“${DL.q}”` : (DL.rec.trending && true ? 'suggested by HF' : '');
            const inv = (DL._invalid || DL.rec._invalid) ? ' · HF token rejected — listed anonymously' : '';
            sub.textContent = `${rows.length} results ${extra}${inv}`;
        }
        // pager
        const pg = D.$('dl-pager'); if (!pg) return;
        pg.innerHTML = '';
        if (pages <= 1) return;
        const mk = (label, page, dis) => {
            const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis;
            b.onclick = () => { DL.page[DL.tab] = page; renderDlPage();
                D.$('dl-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
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
        const host = D.$('dl-results'); if (!host) return;
        host.innerHTML = '';
        const d = document.createElement('div'); d.className = 'empty'; d.textContent = msg;
        host.append(d);
    }
    function loadRecommended(force) {
        if (DL.busy) return;
        const mlx = D.$('dl-mlx') ? D.$('dl-mlx').checked : true;
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
            const host = D.$('dl-results');
            if (host && DL.tab !== 'search') setEmpty('Suggestions failed: ' + e.message);
        });
    }
    function doSearch() {
        const q = (D.$('dl-q') || {}).value?.trim();
        if (!q) { DG.toast(C.t('uplift.toast.type_query')); return; }
        const sort = D.$('dl-sort').value || 'trending';
        const mlx = D.$('dl-mlx') ? D.$('dl-mlx').checked : true;
        DL.q = q; DL.busy = true;
        const sub = D.$('dl-sub'); if (sub) sub.textContent = 'searching…';
        const host = D.$('dl-results'); if (host) D.emptyMsg(host, C.t('uplift.dl.searching'));
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
        const tk = D.$('dl-token');
        try { tk.value = localStorage.getItem('uplift.hf_token') || ''; } catch (_) {}
        tk.addEventListener('change', () => {
            try { localStorage.setItem('uplift.hf_token', tk.value.trim()); } catch (_) {}
        });
        D.$('dl-go').onclick = doSearch;
        D.$('dl-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        D.$('dl-sort').onchange = () => { if (DL.tab === 'search' && DL.q) doSearch(); };
        D.$('dl-mlx').onchange = () => {
            if (DL.tab === 'search') doSearch(); else loadRecommended(true);
        };
        for (const t of ['trending', 'popular', 'search']) {
            const b = D.$('dl-tab-' + t);
            if (b) b.onclick = () => {
                if (t === 'search' && !DL.q) { DG.toast(C.t('uplift.toast.type_query_press_search')); D.$('dl-q').focus(); return; }
                setTab(t);
            };
        }
        D.$('dl-direct').onclick = directDownload;   // UP-14: URL-aware, dialog-first
        D.$('dl-repo').addEventListener('keydown', e => {
            if (e.key === 'Enter') directDownload(); });
        dlGlobalSettings().then(gs => { if (!DL.gs) DL.gs = gs; });
    }
    if (DL.tab === 'search' && DL.search.length) renderDlPage();
    else loadRecommended();
    renderTasks('dl-tasks', 'hf');
}

window.Uplift = window.Uplift || {};
window.Uplift.downloader = { renderTasks, initDownloader,
    _dl14: { hfRepoIdFromInput, HFS, directDownload } };
})();
