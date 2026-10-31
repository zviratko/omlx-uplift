/* Uplift DOWNLOADER page + shared task-list helpers (PH2-1 stage 9a
   extraction from uplift.js): HF downloader tabs (trending/popular/search,
   paging, sort), the UP-14 file-pick download dialog, and the task-row
   renderer the quantizer/
   uploader pages share. Plain script; loads AFTER uplift_state.js, BEFORE
   uplift.js, which late-binds fetchJson/postJson/toast/emptyMsg/cell via
   window.UpliftDom (FE-1: no glue needed — all five were primitives). Exports
   window.Uplift.downloader {renderTasks, initDownloader}. UP-14 (2026-10-24):
   every download entry opens the classic-parity FILE-PICK DIALOG first and
   HF/mirror URLs normalize to owner/repo — see the UP-14 section.
   UP-22 (2026-10-24): the DOWNLOAD surface got its second provider — a
   HF | ModelScope toggle drives the same tabs/pager/task board through
   /admin/api/ms/* (see the UP-22 section). UP-23: 'Recommended for this
   Mac' is the first tab — per-Mac oQ picks from /admin/api/hf/
   recommendations, priced against this machine's RAM and disk. */
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
    // UP-22: the downloader board is ONE host with TWO sources. uplift_boot's
    // visibility kick still passes the hardcoded ['dl-tasks','hf'] pair, and a
    // refresh loop started under one source keeps its captured kind — either
    // way it would repaint the HF board while the operator reads ModelScope
    // (and feed the wrong list into the DOWNLOADED veto). The board always
    // follows the ACTIVE provider; other hosts (qz/up) are untouched.
    if (hostId === 'dl-tasks') kind = DL.provider;
    DG.fetchJson(`${API}/admin/api/${kind}/tasks`).then(d => {
        const host = $(hostId);
        host.innerHTML = '';
        const tasks = d.tasks || [];
        // UP-14: the dialog's DOWNLOADED badge wants the newest task list —
        // classic isModelDownloaded keys on the LATEST match per repo
        if (kind === 'hf') DL.hfTasks = tasks;
        // UP-22: the same badge rule walks the ModelScope board too
        if (kind === 'ms') MS.tasks = tasks;
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
                    .then(() => renderTasks(hostId, kind)).catch(e => DG.toast(C.tf('uplift.dl.cancel_fail', 'cancel: ') + D.errText(e))));
                r.classList.add('with-acts'); r.append(acts);
            } else {
                const failed = ['failed', 'cancelled', 'canceled', 'error'].includes((t.status || '').toLowerCase());
                const done = ['completed', 'complete', 'done', 'finished'].includes((t.status || '').toLowerCase());
                // UP-24: classic removes terminal rows (files untouched, no
                // confirm — dashboard.js removeHFTask/oq/upload/ms DELETE
                // /admin/api/{kind}/task/{id}); the ms board inherits this
                // render when UP-22 lands.
                if (done || failed) {
                    mkAct('REMOVE', C.tf('uplift.dl.remove_task_tip',
                            'Remove this finished task from the list (files are kept)'),
                        () => DG.deleteJson(`${API}/admin/api/${kind}/task/${tid}`)
                            .then(() => renderTasks(hostId, kind))
                            .catch(e => DG.toast(C.tf('uplift.dl.remove_fail', 'remove: ') + D.errText(e))));
                }
                if ((kind === 'hf' || kind === 'ms') && failed) {
                    // U11 parity: classic offers retry (resumes partial
                    // files). UP-22: the ms twin (dashboard.js:8488
                    // retryMSDownload) carries ms_token instead of hf_token.
                    // The token is read AT CLICK TIME — a board painted
                    // before the operator pasted a key must not send an empty one
                    mkAct('RETRY', 'Resume this download from existing files', () => {
                        const body = kind === 'ms'
                            ? { ms_token: dlMsToken() || null }
                            : { hf_token: ($('dl-token') ? $('dl-token').value.trim() : '') };
                        return DG.postJson(`${API}/admin/api/${kind}/retry/${tid}`, body)
                            .then(() => renderTasks(hostId, kind)).catch(e => DG.toast(C.tf('uplift.dl.retry_fail', 'retry: ') + D.errText(e)));
                    });
                }
                if (acts.childNodes.length) { r.classList.add('with-acts'); r.append(acts); }
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
    }).catch(e => DG.emptyMsg($(hostId), D.errText(e)));
}

let dlInit = false;
const DL = {
    tab: 'trending',                 // recos | trending | popular | search
    provider: 'hf',                  // UP-22: hf | ms (classic downloaderSource)
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
// initDownloader publishes its closures: the provider toggle, the injected
// recent-search chips and the UP-23 recommendation rows all re-enter the
// page from module scope, where the tab/pager state is a local.
const DLX = {};
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
            // classic dashboard.js:8430 (fire 13, 78f00e4): changed files
            // re-fetch by default alongside the preselected set
            if ((file.preselected || file.outdated) && !file.local) picked[file.name] = true;
        }
        return picked;
    },
    locked(file) { return !!file.required || !!file.local; },
    selected(file, picked) { return !file.local && (!!file.required || !!file.outdated || !!picked[file.name]); },
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
    // What "download all" still has to fetch: a whole-repo download minus
    // local files. 73e5465 (#4967) moved the rule to the server:
    // download_all_size now sums exactly those rows, and multi-precision
    // repos need the server's checkpoint scoping to get it right - the old
    // client-side preselected walk would keep counting sibling-precision
    // folders. classic hfDownloadAllSize is now this same pass-through.
    allSize(detail) {
        return (detail && detail.download_all_size) || 0;
    },
    // UP-64 dialog lane (classic hfShowsUpdate, 78f00e4 #4949): a downloaded
    // non-GGUF checkpoint with Hub changes offers UPDATE instead of the
    // download buttons; the server lists the replacing files in update_files.
    showsUpdate(detail, downloaded) {
        return !!(detail && !detail.is_adapter && !detail.unsupported_reason
            && detail.layout !== 'gguf'
            && ((detail.update_files || []).length) && downloaded);
    },
    updateSize(detail) {
        const names = new Set((detail && detail.update_files) || []);
        return ((detail && detail.files) || [])
            .filter(f => names.has(f.name))
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
    // finished files for resume, so only the LATEST match per list can veto.
    // UP-22: classic walks [hfTasks, msTasks] (dashboard.js:7775-7785), so a
    // queued ModelScope download vetoes the HF board's badge too.
    downloadedAny(repoId, models, lists) {
        if (!repoId) return false;
        const wanted = String(repoId).toLowerCase();
        const matches = it => String((it && it.repo_id) || '').toLowerCase() === wanted;
        for (const tasks of lists || []) {
            let latest = null;
            for (const t of tasks || []) if (matches(t)) latest = t;
            if (latest && latest.status !== 'completed') return false;
        }
        return (models || []).some(matches);
    },
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

// classic formatFileSize tiers (rows never read '0 MiB' for a 200-byte
// file); large sizes keep the house binary-unit fmtBytes (GiB doctrine)
function dlSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return C.fmtBytes(bytes);
}

let DLGS = null;   // global-settings in-flight cache (mirror endpoint + total RAM)
function dlGlobalSettings() {
    if (!DLGS) DLGS = DG.fetchJson(`${API}/admin/api/global-settings`)
        .then(gs => gs || {})
        .catch(() => { DLGS = null; return {}; });
    return DLGS;
}
// UP-23: flipping the memory-guard tier changes the answer — drop the cache
// so the RAM math and the mirror endpoint re-read the server
function dlGlobalSettingsReset() {
    DLGS = null;
    DL.gs = null;
    return dlGlobalSettings().then(gs => { DL.gs = gs || {}; return DL.gs; });
}

// classic catalog key with an English fallback that ALSO substitutes
// placeholders when the catalog has no entry — core.tf hands the raw
// fallback back untouched, which would leak '{repo_id}' into the UI
function rtxt(key, en, vars) {
    const got = C.tf(key, key, vars);
    if (got !== key) return got;
    return String(en).replace(/\{(\w+)\}/g, (m, k) =>
        vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m);
}

// The DOWNLOADED badge (UP-14 dialog, UP-22 MS rows, UP-23 recos rows) reads
// the installed-repo list; one cached GET instead of a fetch per surface.
let DLMODELS = null;
function ensureHfModels(force) {
    if (DLMODELS && !force) return DLMODELS;
    DLMODELS = DG.fetchJson(`${API}/admin/api/hf/models`)
        .then(s => { DL.hfModels = (s && s.models) || []; return DL.hfModels; })
        .catch(() => { DLMODELS = null; return DL.hfModels; });
    return DLMODELS;
}
// classic isModelDownloaded:7775 — the veto walks BOTH task lists
function dlDownloaded(repoId) {
    return HFS.downloadedAny(repoId, DL.hfModels, [DL.hfTasks, MS.tasks]);
}

function directDownload() {
    const inp = D.$('dl-repo'); if (!inp) return;
    // UP-22: ModelScope has neither the mirror-URL rule nor a file pick —
    // the entry row posts the (owner-defaulted) repo id straight to ms/download
    if (DL.provider === 'ms') { msDownload(inp.value); return; }
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
            ensureHfModels(true).then(() => { if (detail) refresh(); });
        })
        .catch(e => {
            body.textContent = C.tf('uplift.dl.download_fail', 'download: ')
                + D.errText(e);
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
            // classic _models.html:2184 (78f00e4 #4949): a changed copy is
            // badged on its own; Required shows only for a file that is
            // neither local nor outdated
            if (f.outdated) lb.append(dlBadge('warn', C.tf('models.detail.file_outdated', 'Changed')));
            else if (!f.local && f.required) lb.append(dlBadge('dim', C.tf('models.detail.required_file', 'Required')));
            if (f.kind === 'gguf' && !f.local) {
                const fit = HFS.memFit(ram, HFS.rowSize(detail, f));
                if (fit === 'warning') lb.append(dlBadge('warn', C.tf('models.browse.tight_fit', 'Tight fit')));
                else if (fit === 'danger') lb.append(dlBadge('bad', C.tf('models.browse.high_oom_risk', 'High OOM risk')));
            }
            const sz = document.createElement('span');
            sz.className = 'dl-fsize';
            sz.textContent = dlSize(f.size);
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
        const updating = HFS.showsUpdate(detail, dlDownloaded(detail.repo_id || repoId));
        const spaceBytes = updating ? HFS.updateSize(detail) : bytes;
        if (!detail.is_adapter && !HFS.fits(detail, spaceBytes)) {
            const w = document.createElement('span'); w.className = 'dl-space';
            w.textContent = C.tf('models.recommend.not_enough_space', 'Not enough free space in the model folder');
            foot.append(w);
        }
        foot.append(mkBtn('btn', 'models.detail.cancel', 'Cancel', () => overlay.remove()));
        if (detail.is_adapter) {
            foot.append(dlBadge('warn', C.tf('models.detail.lora_warning', 'LoRA adapter — not supported')));
        } else if (detail.unsupported_reason) {
            foot.append(dlBadge('warn', String(detail.unsupported_reason)));
        } else if (updating) {
            const upSz = HFS.updateSize(detail);
            const up = mkBtn('btn primary', 'models.detail.update', 'Update',
                () => submit(detail.update_files), sending || !HFS.fits(detail, upSz));
            if (upSz) up.append(document.createTextNode(' ' + dlSize(upSz)));
            foot.append(up);
        } else if (detail.layout === 'gguf'
                || !dlDownloaded(detail.repo_id || repoId)) {
            const allSz = HFS.allSize(detail);
            const all = mkBtn('btn', 'models.detail.download_all', 'Download all',
                () => submit(null), sending || !HFS.fits(detail, allSz));
            if (allSz) all.append(document.createTextNode(' ' + dlSize(allSz)));
            const names = HFS.names(detail, picked);
            const sel = mkBtn('btn primary', 'models.detail.download_selected', 'Download selected',
                () => submit(names), sending || !names.length || !HFS.fits(detail, bytes));
            if (bytes) sel.append(document.createTextNode(' ' + dlSize(bytes)));
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
                    + D.errText(e));
            });
    }
}

/* ---- UP-22 (FEAT-1 parity, 2026-10-24): the ModelScope provider -------
   Classic ships a SECOND downloader source behind GET /admin/api/ms/status
   (state dashboard.js:550-582, flow dashboard.js:8372-8536, card
   _models.html:891+): repo-id download (a bare id defaults to the
   mlx-community owner), an optional MS token, trending/popular + search with
   sort, pagination and a localStorage history, and its own task board.
   Uplift mirrors exactly that on ONE surface: the HF | ModelScope toggle
   re-drives the existing tab strip, results grid, pager, entry row and task
   board. ModelScope has NO file-pick upstream, so an MS row posts the WHOLE
   repo and never opens the UP-14 dialog (classic dashboard.js:8450
   downloadMsModel -> startMSDownload). DEFERRED: classic also wires the MS
   row NAME to its own detail modal (dashboard.js:8659 — card, tags and a
   whole-repo download); that modal is not rebuilt in this lane.
   Labels are classic catalog keys. */
const MS_OWNER = 'mlx-community';       // classic startMSDownload:8389
// classic getMsTotalPages:8574 — MS caps the pager (5 browse / 10 search)
const MS_PAGE_CAP = { trending: 5, popular: 5, search: 10 };
const MS = {
    available: null,        // null = /ms/status has not answered yet
    checked: false,
    busy: false,
    downloading: false,
    rec: { trending: null, popular: null },  // same null=not-loaded shape as DL.rec
    loaded: false,
    search: [], q: '', sort: 'trending',
    page: { trending: 1, popular: 1, search: 1 },
    history: [],            // classic localStorage key 'msSearchHistory'
    tasks: [],              // last /admin/api/ms/tasks read (badge veto)
};

// classic startMSDownload:8389 — a bare model id belongs to the MLX
// community owner. Pure (tests/u22); NOT hfRepoIdFromInput: ModelScope has
// no URL or mirror rule upstream.
function msRepoId(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    return raw.includes('/') ? raw : `${MS_OWNER}/${raw}`;
}

// classic getMsTotalPages:8574 — page count under the per-tab cap
function msTotalPages(total, size, tab) {
    const cap = MS_PAGE_CAP[tab] || 5;
    return Math.min(Math.ceil((total || 0) / (size || 10)), cap);
}

// classic mImmediateSearch:8625 — newest first, deduped, 10 deep. Pure.
function msHistoryPush(history, query) {
    const list = Array.isArray(history) ? history.slice() : [];
    const q = String(query == null ? '' : query).trim();
    if (!q) return list;
    return [q, ...list.filter(h => h !== q)].slice(0, 10);
}
// classic msSearchHistory boot read (dashboard.js:571) — never trust the
// localStorage shape: anything but a list of strings starts over empty
function msHistoryLoad() {
    try {
        const raw = JSON.parse(localStorage.getItem('msSearchHistory') || '[]');
        return Array.isArray(raw) ? raw.filter(h => typeof h === 'string') : [];
    } catch (_) { return []; }
}
function msHistorySave(list) {
    try { localStorage.setItem('msSearchHistory', JSON.stringify(list)); } catch (_) {}
}

function dlMsToken() { return (D.$('dl-ms-token') || {}).value?.trim() || ''; }

// classic initMsDownloader:8372 — ONE status probe gates the whole source;
// a refused or missing endpoint reads as 'not available', never as an error
function msStatus() {
    if (MS.checked) return Promise.resolve(MS.available);
    MS.checked = true;
    return DG.fetchJson(`${API}/admin/api/ms/status`)
        .then(d => { MS.available = !!(d && d.available === true); })
        .catch(() => { MS.available = false; })
        .then(() => MS.available);
}

// classic startMSDownload:8389 + downloadMsModel:8450 — the whole repo, no
// picker. The wire shape is pinned by tests/u22: {model_id, ms_token}.
function msDownload(repoId) {
    const id = msRepoId(repoId);
    if (!id) { DG.toast(C.t('uplift.toast.repo_id_required')); return Promise.resolve(false); }
    if (MS.downloading) return Promise.resolve(false);
    MS.downloading = true;
    return DG.postJson(`${API}/admin/api/ms/download`,
        { model_id: id, ms_token: dlMsToken() || '' })
        .then(r => {
            const tid = (r && r.task && r.task.task_id) || (r && r.task_id) || '';
            DG.toast(rtxt('js.success.download_started',
                'Download started: {repo_id}', { repo_id: id })
                + (tid ? ` #${String(tid).slice(0, 8)}` : ''));
            const inp = D.$('dl-repo');
            if (inp && String(inp.value || '').trim()) inp.value = '';   // classic clears the card
            ensureHfModels(true);           // the DOWNLOADED badge follows the queue
            renderTasks('dl-tasks', 'ms');
            MS.downloading = false;
            return true;
        })
        .catch(e => {
            MS.downloading = false;
            DG.toast(C.tf('js.error.start_download_failed', 'Failed to start download')
                + ': ' + D.errText(e));
            return false;
        });
}

// classic loadMsRecommendedModels:8496 — trending + popular in one call
function loadMsRecommended(force) {
    if (MS.busy) return;
    const mlx = (D.$('dl-mlx') || {}).checked !== false;
    if (!force && MS.loaded && MS._mlx === mlx) { if (DLX.render) DLX.render(); return; }
    MS.busy = true;
    DG.fetchJson(`${API}/admin/api/ms/recommended?mlx_only=${mlx}`).then(d => {
        MS.rec = {
            trending: ((d && d.trending) || []).map((m, i) => ({ ...m, rank: i + 1 })),
            popular: ((d && d.popular) || []).map((m, i) => ({ ...m, rank: i + 1 })),
        };
        MS.loaded = true; MS._mlx = mlx; MS.busy = false;
        if (DL.tab !== 'search') MS.page[DL.tab] = 1;
        if (DLX.render) DLX.render(); else renderMsHistory();
    }).catch(e => {
        MS.busy = false;
        MS.rec = { trending: MS.rec.trending || [], popular: MS.rec.popular || [] };
        if (DLX.empty)
            DLX.empty(C.tf('js.error.ms_connect_failed', 'Failed to connect to ModelScope.')
                + ' ' + D.errText(e));
    });
}

// classic searchMSModels:8586 + mImmediateSearch:8625 (history write)
function doMsSearch() {
    const box = D.$('dl-q');
    const q = String((box && box.value) || '').trim();
    if (!q) { DG.toast(C.t('uplift.toast.type_query')); return; }
    MS.q = q; MS.busy = true;
    MS.sort = (D.$('dl-sort') || {}).value || 'trending';
    MS.history = msHistoryPush(MS.history, q);
    msHistorySave(MS.history);
    const mlx = (D.$('dl-mlx') || {}).checked !== false;
    const sub = D.$('dl-sub'); if (sub) sub.textContent = C.tf('models.browse.searching', 'Searching...');
    const p = new URLSearchParams({ q, sort: MS.sort, limit: '50', mlx_only: String(mlx) });
    DG.fetchJson(`${API}/admin/api/ms/search?${p}`).then(d => {
        MS.search = ((d && d.models) || []).map((m, i) => ({ ...m, rank: i + 1 }));
        MS.busy = false; MS.page.search = 1;
        if (DLX.setTab) DLX.setTab('search'); else renderMsHistory();
    }).catch(e => {
        MS.busy = false; MS.search = [];
        if (DLX.empty)
            DLX.empty(C.tf('js.error.search_failed', 'Search failed') + ': '
                + D.errText(e));
    });
}

// The single entry row serves BOTH sources (classic ships two cards; uplift
// has one filterbar). Switching swaps the per-source token the browser
// holds and the placeholders, so an HF token is never sent to ModelScope.
const TOKEN_KEYS = { hf: 'uplift.hf_token', ms: 'uplift.ms_token' };
function swapProviderInputs(p) {
    const tk = D.$('dl-ms-token');
    if (tk) {
        // The field belongs to ModelScope and only to ModelScope: the shipped
        // #dl-token (and its uplift.hf_token key) is NEVER written from here,
        // so a key typed for one source can never ride along to the other.
        try {
            if (p === 'ms') tk.value = localStorage.getItem(TOKEN_KEYS.ms) || '';
            else localStorage.setItem(TOKEN_KEYS.ms, String(tk.value || '').trim());
        } catch (_) {}
        tk.placeholder = C.tf('models.downloader.ms_token_placeholder', 'your_token...');
        tk.title = rtxt('models.downloader.ms_token', 'MS Token') + ' '
            + C.tf('models.downloader.ms_token_optional', '(optional)');
        // the injected field speaks the global i18n pass too: applyI18n
        // (uplift.js) rewrites [data-i18n-ph] on every locale load, and an
        // unsolicited HF placeholder would otherwise win after a mid-session
        // language switch. Same rule for the two shared entry inputs below.
        tk.dataset.i18nPh = 'models.downloader.ms_token_placeholder';
    }
    const repo = D.$('dl-repo');
    if (repo) {
        repo.placeholder = C.tf(p === 'ms' ? 'models.downloader.ms_repo_placeholder'
            : 'uplift.dl.repo_ph', p === 'ms' ? 'qwen/Qwen2.5-7B-Instruct-MLX'
                : 'direct repo id, e.g. mlx-community/Llama-3-8B-4bit');
        repo.dataset.i18nPh = p === 'ms' ? 'models.downloader.ms_repo_placeholder'
            : 'uplift.dl.repo_ph';
    }
    const q = D.$('dl-q');
    if (q) {
        q.placeholder = C.tf(p === 'ms' ? 'models.search.ms_placeholder'
            : 'uplift.dl.search_ph', p === 'ms' ? 'Search models on ModelScope...'
                : 'search models on huggingface.co…');
        q.dataset.i18nPh = p === 'ms' ? 'models.search.ms_placeholder'
            : 'uplift.dl.search_ph';
    }
}

// JS-built chrome, zero index.html dependency: the HF | ModelScope pair and
// the RECOMMENDED tab are injected next to the existing tab strip (and the
// ModelScope token field next to the entry row). If the owner later ships
// the equivalent markup with the same ids, ensureDlChrome() finds it and
// builds nothing — the ids are the contract.
function ensureDlChrome() {
    const anchor = D.$('dl-tab-trending');
    const bar = anchor && anchor.parentNode ? anchor.parentNode : null;
    if (!bar || !bar.insertBefore) return;
    if (!D.$('dl-src-hf')) {
        const grp = document.createElement('span');
        grp.className = 'dl-src';
        grp.append(segBtn('dl-src-hf', 'models.downloader.source.hf', 'HuggingFace'),
                   segBtn('dl-src-ms', 'models.downloader.source.ms', 'ModelScope'));
        bar.insertBefore(grp, anchor);
    }
    if (!D.$('dl-tab-recos'))
        bar.insertBefore(segBtn('dl-tab-recos', 'models.downloader.source.recommended',
            'Recommended'), anchor);
    if (!D.$('dl-ms-token')) {
        const tk = document.createElement('input');
        tk.type = 'password'; tk.id = 'dl-ms-token'; tk.className = 'tok-w240';
        // hidden on HF, so swapProviderInputs never runs for it at boot —
        // give applyI18n BOTH the key and its true English, so a locale load
        // fills the field and a later switch back to English restores it
        tk.dataset.i18nPh = 'models.downloader.ms_token_placeholder';
        tk.dataset.enPh = 'your_token...';
        const ref = D.$('dl-direct');
        // the entry row when it exists; the tab strip is the honest fallback
        const host = (ref && ref.parentNode) || bar;
        if (host.insertBefore && ref) host.insertBefore(tk, ref);
        else host.append(tk);
    }
    if (!D.$('dl-hist') && bar.parentNode && bar.parentNode.insertBefore) {
        const h = document.createElement('div');
        h.className = 'dl-hist'; h.id = 'dl-hist'; h.style.display = 'none';
        bar.parentNode.insertBefore(h, bar.nextSibling);
    }
}
function segBtn(id, key, en) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'se-btn seg'; b.id = id;
    b.textContent = C.tf(key, en);
    // NO data-i18n: the shipped strip (#dl-tab-trending & co.) is untranslated
    // chrome and applyI18n would fight the per-source relabel below. The key +
    // English are remembered instead, so paintProvider() — which runs on every
    // downloader render, i.e. right after a locale load — re-labels the pair.
    b.dataset.segKey = key; b.dataset.segEn = en;
    return b;
}
// the injected labels are built ONCE (ids are the contract), so a mid-session
// language switch cannot reach them through ensureDlChrome; relabel them here
// instead of leaving stale text in the strip.
function relabelDlChrome() {
    for (const id of ['dl-src-hf', 'dl-src-ms', 'dl-tab-recos']) {
        const b = D.$(id);
        if (b && b.dataset.segKey) b.textContent = C.tf(b.dataset.segKey, b.dataset.segEn);
    }
}
// ModelScope recent searches (classic history dropdown, uplift house chips
// row): only shown on the MS source, newest first, click re-runs the search
function renderMsHistory() {
    const host = D.$('dl-hist');
    if (!host) return;
    host.innerHTML = '';
    if (DL.provider !== 'ms' || !MS.history.length) { host.style.display = 'none'; return; }
    host.style.display = '';
    const lab = document.createElement('span');
    lab.className = 'dl-hist-lab';
    lab.textContent = C.tf('models.search.recent_searches', 'Recent searches');
    host.append(lab);
    for (const h of MS.history) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'se-btn act'; b.textContent = h;
        b.onclick = () => { const q = D.$('dl-q'); if (q) q.value = h; doMsSearch(); };
        host.append(b);
    }
}

/* ---- UP-23 (FEAT-1 parity, 2026-10-24): 'Recommended for this Mac' -----
   Classic's flagship downloader surface (dashboard.js:7811-8030 plus the
   _recommendations.html template): oQ builds priced against THIS machine's
   RAM and disk from GET /admin/api/hf/recommendations, with smarts/speed dot
   meters, vision/audio/MTP/n-gram badges, a per-row downloaded/downloading
   state, the memory-budget breakdown bar, a stale-catalogue banner and the
   'unlock bigger models' flow. Function names follow classic
   (recGB/recDots/recNote/recUnlockGain...) so a drift sync diffs them
   line-adjacent; the payload rides in as an argument instead of
   `this.recommendations`. Labels are classic catalog keys — zero new locale
   churn. */
const REC = {
    data: null,
    loading: false,
    error: '',
    unlockOpen: null,      // null = follow classic's rule (open above 16 GB)
    applying: false,
};

// classic recGB:7975 — but the house unit doctrine (core.fmtBytes) is that
// 1024^3 RAM figures are GiB, not the GB classic labels them. Same numbers,
// honest suffix.
function recGB(bytes) {
    const g = (bytes || 0) / 1024 ** 3;
    return (g >= 100 ? String(Math.round(g)) : g.toFixed(1)) + ' GiB';
}
// classic recContext:7980 / recParams:7985 — verbatim
function recContext(tokens) {
    if (tokens >= 1024 * 1024) return Math.round(tokens / (1024 * 1024)) + 'M';
    return Math.round((tokens || 0) / 1024) + 'K';
}
function recParams(count) {
    const b = (count || 0) / 1e9;
    return (b >= 10 ? String(Math.round(b)) : b.toFixed(1)) + 'B';
}
// classic recDots:7998 — a half level (3.5) paints one half dot
function recDots(level) {
    return [1, 2, 3, 4, 5].map(i => (i <= level ? 'full'
        : (i - 0.5 === level ? 'half' : 'empty')));
}
function recScenarios(rec) {
    return (rec && rec.memory && rec.memory.scenarios) || {};
}
// classic recArch:7990 — MoE names both the total and the active half
function recArch(item) {
    if (!item.moe)
        return rtxt('models.recommend.arch.dense', 'Dense {total}',
            { total: recParams(item.total_params) });
    return rtxt('models.recommend.arch.moe', 'MoE {total} · {active} active',
        { total: recParams(item.total_params), active: recParams(item.active_params) });
}
function recDownloadsText(item) {
    return rtxt('models.recommend.meta.downloads', '{count} downloads',
        { count: C.fmtNumber(item.downloads || 0) });
}
// classic recSpeedVs:8009 — the reference build's name plus a 1-decimal ratio
function recSpeedVs(item) {
    const ratio = item.relative_speed;
    const fmt = r => (r >= 10 ? r.toFixed(0) : r.toFixed(1));
    if (ratio > 1.1)
        return rtxt('models.recommend.relative.faster', '{ratio}x faster than {name}',
            { ratio: fmt(ratio), name: item.base_name });
    if (ratio < 0.9)
        return rtxt('models.recommend.relative.slower', '{ratio}x slower than {name}',
            { ratio: fmt(1 / (ratio || 1e-6)), name: item.base_name });
    return rtxt('models.recommend.relative.similar', 'about as fast as {name}',
        { name: item.base_name });
}
// classic recNote:8024 — why this row is in this group
function recNote(rec, group, item) {
    if (group === 'bigger')
        return rtxt('models.recommend.note.bigger',
            '{total} parameters packed into fewer bits · {speed}',
            { total: recParams(item.total_params), speed: recSpeedVs(item) });
    if (group === 'precise')
        return rtxt('models.recommend.note.precise',
            'same model with more bits · {speed} · usually a small quality gain',
            { speed: recSpeedVs(item) });
    if (group === 'faster')
        return rtxt('models.recommend.note.faster',
            '{speed} · more room for long chats and other apps',
            { speed: recSpeedVs(item) });
    if (item.kind === 'table_in_memory')
        return rtxt('models.recommend.note.table_in_memory',
            'keeps its n-gram table in memory · {speed}', { speed: recSpeedVs(item) });
    const best = (rec.sections || {}).best || [];
    const smartest = Math.max(-Infinity, ...best.map(b => b.smarts));
    return C.tf(item.smarts > smartest ? 'models.recommend.note.smarter_than_best'
        : 'models.recommend.note.larger_build',
        item.smarts > smartest ? 'smarter than the recommended models'
            : 'a larger or more precise build than what fits now');
}
// classic recMemoryShare:8003 — unlock rows are priced against the RAISED
// budget (they only load there), everything else against the current one
function recMemoryShare(rec, item) {
    const usable = ((item.kind ? recScenarios(rec).both : recScenarios(rec).now)
        || {}).usable_bytes || 0;
    return usable > 0 ? Math.min(100, Math.round((item.resident_bytes || 0) / usable * 100)) : 100;
}
// classic recMemoryBarClass:8010 (roomy / getting full / tight) — house
// modifier names instead of the Tailwind trio, same 85/60 thresholds
function recMemoryBarClass(share) {
    if (share >= 85) return 'bad';
    if (share >= 60) return 'warn';
    return 'ok';
}
// classic recMemorySegments:8060 — the total-RAM breakdown. A 64 MiB floor
// keeps slivers the eye cannot see out of the bar and the legend.
function recMemorySegments(memory) {
    const now = ((memory || {}).scenarios || {}).now || {};
    const total = (memory && memory.total_bytes) || 0;
    return [
        { key: 'usable', bytes: now.usable_bytes || 0, cls: 'ok',
          label: 'models.recommend.bar.usable' },
        { key: 'headroom', bytes: (now.ceiling_bytes || 0) - (now.usable_bytes || 0), cls: 'soft',
          label: 'models.recommend.bar.headroom' },
        { key: 'gpu', bytes: ((memory && memory.static_ceiling_bytes) || 0) - (now.ceiling_bytes || 0), cls: 'warn',
          label: 'models.recommend.bar.gpu_limit' },
        // A custom memory guard ceiling below what the tier reserve allows.
        { key: 'custom', bytes: total - ((memory && memory.reserve_bytes) || 0)
            - ((memory && memory.static_ceiling_bytes) || 0), cls: 'dim',
          label: 'models.recommend.bar.custom_limit' },
        { key: 'reserve', bytes: (memory && memory.reserve_bytes) || 0, cls: 'edge',
          label: 'models.recommend.bar.reserve' },
    ].filter(s => s.bytes > 64 * 1024 ** 2)
        .map(s => ({ ...s, percent: total > 0 ? s.bytes / total * 100 : 0 }));
}
// classic recUnlockOpen:7979 — an explicit operator choice wins; otherwise
// the panel opens unless this is a 16 GB (or smaller) Mac
function recUnlockOpen(rec, pref) {
    if (pref !== null && pref !== undefined) return !!pref;
    return ((rec && rec.memory && rec.memory.total_bytes) || 0) > 16 * 1024 ** 3;
}
// classic recUnlockGain:7984 — under a quarter of a GiB is not worth a
// risk warning, so it reads as no gain at all
function recUnlockGain(rec, key) {
    const s = recScenarios(rec);
    const gain = (((s || {})[key] || {}).usable_bytes || 0) - ((s.now || {}).usable_bytes || 0);
    return gain > 256 * 1024 ** 2 ? gain : 0;
}
function recAggressiveReserve(rec) {
    return (rec && rec.memory && rec.memory.aggressive_reserve_bytes) || 0;
}
function recMetalPercent(rec) {
    const m = (rec && rec.memory) || {};
    const cap = ((m.scenarios || {}).now || {}).metal_cap_bytes || 0;
    return Math.round(cap / ((m.total_bytes || 1)) * 100);
}
// classic recWiredCommand:8075 — only offer the sysctl while it is actually
// above the ceiling the guard already grants
function recWiredCommand(rec) {
    const m = (rec && rec.memory) || {};
    const mb = m.suggested_wired_limit_mb;
    const cap = ((m.scenarios || {}).now || {}).metal_cap_bytes || 0;
    if (!m.guard_enabled || !(mb > 0) || mb * 1024 ** 2 <= cap) return '';
    return `sudo sysctl iogpu.wired_limit_mb=${mb}`;
}
// classic recUnlockSummary:8088
function recUnlockSummary(rec) {
    const m = (rec && rec.memory) || {};
    const both = (m.scenarios || {}).both || {};
    return rtxt('models.recommend.unlock.summary',
        'With both, models can use up to {usable} (now {now}). Only {free} stays'
        + ' free for other apps, so they may slow down while a large model runs.',
        { usable: recGB(both.usable_bytes),
          now: recGB(((m.scenarios || {}).now || {}).usable_bytes),
          free: recGB((m.total_bytes || 0) - (both.ceiling_bytes || 0)) });
}
// classic recChipLine:8043 / recMemoryLine:8047 / recGpuLimitText:8053
function recChipLine(device) {
    const d = device || {};
    if (!d.gpu_cores) return d.chip || '';
    return d.chip + ' · ' + rtxt('models.recommend.gpu_cores', '{cores}-core GPU',
        { cores: d.gpu_cores });
}
function recMemoryLine(rec) {
    const m = (rec && rec.memory) || {};
    return rtxt('models.recommend.memory_line',
        '{memory} unified memory · {bandwidth} GB/s memory bandwidth',
        { memory: recGB(m.total_bytes),
          bandwidth: ((rec && rec.device) || {}).bandwidth_gbps });
}
function recGpuLimitText(rec) {
    const m = (rec && rec.memory) || {};
    const cap = ((m.scenarios || {}).now || {}).metal_cap_bytes || 0;
    return rtxt(m.wired_limit_set ? 'models.recommend.chip.gpu_limit_set'
        : 'models.recommend.chip.gpu_limit_default',
        m.wired_limit_set ? 'GPU memory limit: {size}'
            : 'GPU memory limit: macOS default {size}',
        { size: recGB(cap) });
}
// classic recBiggerEmptyText:8032 — name what WOULD fit after the unlock
function recBiggerEmpty(rec) {
    const best = ((rec && rec.sections) || {}).best || [];
    const smartest = Math.max(-Infinity, ...best.map(b => b.smarts));
    const names = (((rec && rec.sections) || {}).unlock || [])
        .filter(u => u.kind === 'fits' && u.smarts > smartest
            && !best.some(b => b.name === u.name))
        .map(u => `${u.name} oQ${u.level}e`);
    if (!names.length) return C.tf('models.recommend.bigger.empty', 'No bigger model fits right now.');
    return rtxt('models.recommend.bigger.empty_unlock',
        'No bigger model fits right now. {models} would fit after “Unlock bigger'
        + ' models” below.', { models: names.join(', ') });
}
// classic recTask:8040 — the LATEST task for a repo decides the row state
function recTaskOf(repoId, tasks) {
    const wanted = String(repoId || '').toLowerCase();
    let latest = null;
    for (const t of tasks || [])
        if (String((t && t.repo_id) || '').toLowerCase() === wanted) latest = t;
    return latest;
}
// classic recState:8044 — downloading beats downloaded beats idle
function recStateOf(repoId, tasks, models) {
    const t = recTaskOf(repoId, tasks);
    if (t && (t.status === 'pending' || t.status === 'downloading')) return 'downloading';
    return dlDownloaded(repoId) ? 'downloaded' : 'idle';
}
// classic recDiskShort:8052
function recDiskShort(rec, item) {
    const free = ((rec && rec.disk) || {}).free_bytes || 0;
    return free > 0 && (item.download_bytes || 0) > free;
}

function recEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
}
function recBtn(cls, key, en, fn, dis) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls;
    b.textContent = C.tf(key, en);
    b.disabled = !!dis;
    if (fn) b.onclick = fn;
    return b;
}
// classic badges(item): the oQ build plus capability chips
function recBadges(item) {
    const wrap = recEl('span', 'rec-badges');
    wrap.append(dlBadge('dim', 'oQ' + item.level + 'e'));
    if (item.vision) wrap.append(dlBadge('info', C.tf('models.recommend.badge.vision', 'Vision')));
    if (item.audio) wrap.append(dlBadge('info', C.tf('models.recommend.badge.audio', 'Audio')));
    if (item.mtp) wrap.append(dlBadge('info', C.tf('models.recommend.badge.mtp', 'Lightning MTP')));
    if (item.table_on_ssd)
        wrap.append(dlBadge('warn', C.tf('models.recommend.badge.table_on_ssd', 'N-gram on SSD')));
    for (const need of item.needs || [])
        wrap.append(dlBadge('warn', rtxt('models.recommend.unlock.needs_' + need,
            'Needs ' + need, {})));
    return wrap;
}
// classic meters(item): five-dot smarts + speed with the word label
function recMeters(item) {
    const wrap = recEl('div', 'rec-meters');
    for (const [key, labKey, en, level] of [
        ['smarts', 'models.recommend.smarts', 'Smarts', item.smarts_level],
        ['speed', 'models.recommend.speed', 'Speed', item.speed_level]]) {
        const box = recEl('div', 'rec-meter');
        const head = recEl('div', 'rec-meter-lab', C.tf(labKey, en));
        if (key === 'speed')
            head.append(recEl('span', 'rec-meter-word',
                rtxt('models.recommend.speed_level.' + item.speed_level, '', {})));
        const dots = recEl('div', 'rec-dots');
        for (const d of recDots(level)) dots.append(recEl('span', 'rec-dot ' + d));
        box.append(head, dots);
        wrap.append(box);
    }
    return wrap;
}
// classic model_row memory column: GB + ~context over the share bar
function recMemBar(rec, item, labLeft, labRight) {
    const box = recEl('div', 'rec-mem');
    const share = recMemoryShare(rec, item);
    box.append(recEl('div', 'rec-mem-top', labLeft + ' ' + labRight));
    const track = recEl('div', 'rec-track');
    const fill = recEl('div', 'rec-fill ' + recMemoryBarClass(share));
    fill.style.width = Math.max(2, Math.min(100, share)) + '%';
    track.append(fill);
    box.append(track);
    box.title = rtxt('models.recommend.memory_use', 'Memory {size} of {usable}',
        { size: recGB(item.resident_bytes),
          usable: recGB((((recScenarios(rec)[item.kind ? 'both' : 'now']) || {}).usable_bytes) || 0) });
    return box;
}
// classic download_action(item): downloaded badge / live bar / pick files
function recAction(rec, item) {
    const box = recEl('div', 'rec-act');
    const state = recStateOf(item.repo_id, DL.hfTasks, DL.hfModels);
    if (state === 'downloaded') {
        box.append(dlBadge('ok', C.tf('models.recommend.downloaded', 'Downloaded')));
        return box;
    }
    if (state === 'downloading') {
        const t = recTaskOf(item.repo_id, DL.hfTasks) || {};
        const pct = Math.max(0, Math.min(100, Math.round(t.progress || 0)));
        const wrap = recEl('div', 'rec-prog');
        wrap.append(recEl('div', 'rec-prog-top',
            C.tf('models.recommend.downloading', 'Downloading') + ' ' + pct + '%'));
        const track = recEl('div', 'rec-track');
        const fill = recEl('div', 'rec-fill ok');
        fill.style.width = pct + '%';
        track.append(fill);
        wrap.append(track);
        box.append(wrap);
        return box;
    }
    const short = recDiskShort(rec, item);
    const b = recBtn('se-btn act', 'models.recommend.download', 'Download',
        // classic downloadRecommended:7771 — the picks happen in the dialog
        () => openModelFiles(item.repo_id), short);
    if (short) b.title = C.tf('models.recommend.not_enough_space',
        'Not enough free space in the model folder');
    box.append(b);
    return box;
}
function recSectionHead(icon, titleKey, titleEn, subKey, subEn) {
    const head = recEl('div', 'rec-head');
    head.append(recEl('span', 'rec-ico', icon), recEl('h3', 'rec-h3', C.tf(titleKey, titleEn)));
    const box = recEl('section', 'rec-sec');
    box.append(head);
    if (subKey) box.append(recEl('p', 'rec-sub', C.tf(subKey, subEn)));
    return box;
}
// classic model_row: name + badges, the why-note, meters, memory, action
function recRow(rec, group, item) {
    const row = recEl('div', 'rec-row');
    const id = recEl('div', 'rec-id');
    const line = recEl('div', 'rec-line');
    line.append(recEl('span', 'rec-name', item.name || item.repo_id), recBadges(item));
    id.append(line);
    id.append(recEl('p', 'rec-note',
        recArch(item) + ' · ' + recDownloadsText(item) + ' · ' + recNote(rec, group, item)));
    const mem = recMemBar(rec, item, recGB(item.resident_bytes), '~' + recContext(item.max_context));
    row.append(id, recMeters(item), mem, recAction(rec, item));
    return row;
}
// classic 'best' card: the same facts, stacked
function recCard(rec, item, first) {
    const card = recEl('div', 'rec-card' + (first ? ' first' : ''));
    if (first) card.append(recEl('span', 'badge dl-b ok rec-best',
        C.tf('models.recommend.best.badge', 'Best match')));
    const head = recEl('div', 'rec-card-head');
    head.append(recEl('h4', 'rec-name', item.name || item.repo_id));
    head.append(recEl('p', 'rec-note',
        recArch(item) + ' · ' + rtxt('models.recommend.meta.context', 'up to {context} context',
            { context: recContext(item.model_max_context) })
        + ' · ' + recDownloadsText(item)));
    head.append(recBadges(item));
    card.append(head, recMeters(item));
    const mem = recEl('div', 'rec-card-mem');
    const memTop = rtxt('models.recommend.memory_use', 'Memory {size} of {usable}',
        { size: recGB(item.resident_bytes),
          usable: recGB(((recScenarios(rec).now || {}).usable_bytes) || 0) })
        + ' · ' + rtxt('models.recommend.chat_tokens', '~{tokens} tokens of chat',
            { tokens: recContext(item.max_context) });
    mem.append(recEl('div', 'rec-mem-top', memTop));
    const share = recMemoryShare(rec, item);
    const track = recEl('div', 'rec-track');
    const fill = recEl('div', 'rec-fill ' + recMemoryBarClass(share));
    fill.style.width = Math.max(2, Math.min(100, share)) + '%';
    track.append(fill);
    mem.append(track);
    if (item.table_on_ssd)
        mem.append(recEl('p', 'rec-warn-text',
            rtxt('models.recommend.table_on_ssd', 'Reads its {size} n-gram table from SSD to save memory.',
                { size: recGB(item.table_bytes) })));
    card.append(mem);
    const foot = recEl('div', 'rec-card-foot');
    foot.append(recEl('span', 'rec-dl-size',
        rtxt('models.recommend.download_size', '{size} download', { size: recGB(item.download_bytes) })));
    foot.append(recAction(rec, item));
    card.append(foot);
    return card;
}
// classic 'Your Mac' panel: chip, RAM, bandwidth, the budget breakdown bar
function recMacPanel(rec) {
    const box = recEl('section', 'rec-mac');
    const head = recEl('div', 'rec-mac-head');
    const who = recEl('div', 'rec-mac-who');
    who.append(recEl('div', 'rec-kicker', C.tf('models.recommend.your_mac', 'Your Mac')));
    who.append(recEl('div', 'rec-chip', recChipLine(rec.device)));
    who.append(recEl('div', 'rec-dim', recMemoryLine(rec)));
    const usable = recEl('div', 'rec-mac-usable');
    usable.append(recEl('div', 'rec-kicker', C.tf('models.recommend.usable_label',
        'Memory for models and chat')));
    usable.append(recEl('div', 'rec-bignum',
        recGB(((recScenarios(rec).now || {}).usable_bytes) || 0)));
    head.append(who, usable);
    box.append(head);
    const bar = recEl('div', 'rec-segbar');
    const legend = recEl('div', 'rec-legend');
    for (const seg of recMemorySegments(rec.memory)) {
        const s = recEl('div', 'rec-seg ' + seg.cls);
        s.style.width = seg.percent.toFixed(2) + '%';
        s.title = C.tf(seg.label, seg.key) + ' ' + recGB(seg.bytes);
        bar.append(s);
        const l = recEl('span', 'rec-leg');
        l.append(recEl('i', 'rec-leg-swatch ' + seg.cls));
        l.append(recEl('span', null, C.tf(seg.label, seg.key)));
        l.append(recEl('b', null, recGB(seg.bytes)));
        legend.append(l);
    }
    box.append(bar, legend);
    const m = rec.memory || {};
    const chips = recEl('div', 'rec-chips');
    const guard = dlBadge('dim', rtxt('models.recommend.chip.memory_guard', 'Memory guard: {tier}',
        { tier: C.tf('settings.resource.guard_tier.' + (m.tier || 'balanced'), m.tier || 'balanced') }));
    // UP-19(10) cross-ref: the tier sentence is the GS page's own key
    guard.title = C.tf('settings.resource.guard_tier.description.' + (m.tier || 'balanced'), '');
    chips.append(guard, dlBadge('dim', recGpuLimitText(rec)));
    chips.append(dlBadge('dim', rtxt('models.recommend.chip.free_space',
        'Free space in model folder: {size}',
        { size: recGB(((rec.disk || {}).free_bytes) || 0) })));
    chips.append(recEl('span', 'rec-dim', C.tf('models.recommend.estimates_note',
        'Estimates. Real speed depends on chat length and concurrent requests.')));
    box.append(chips);
    return box;
}
// classic 'Unlock bigger models' section — the tier flip is the one WRITE
function recUnlockPanel(rec) {
    const box = recEl('section', 'rec-unlock');
    const open = recUnlockOpen(rec, REC.unlockOpen);
    const head = recBtn('rec-unlock-head', 'models.recommend.unlock.title',
        'Unlock bigger models', () => {
            REC.unlockOpen = !open;
            paintRecos();
        });
    head.append(recEl('span', 'badge dl-b warn rec-badge-adv',
        C.tf('models.recommend.unlock.badge', 'Advanced')));
    head.append(recEl('span', 'rec-unlock-toggle',
        C.tf(open ? 'models.recommend.unlock.hide' : 'models.recommend.unlock.show',
            open ? 'Hide' : 'Show')));
    box.append(head);
    box.append(recEl('p', 'rec-sub', C.tf('models.recommend.unlock.subtitle',
        'Everything above loads with your current settings. Raising the memory'
        + ' limits lets larger models fit.')));
    if (!open) return box;
    const gain = recUnlockGain(rec, 'both');
    if (!gain) {
        box.append(recEl('p', 'rec-dim', C.tf('models.recommend.unlock.max',
            "You're already on the highest settings.")));
        return box;
    }
    if (((rec.memory || {}).total_bytes || 0) <= 16 * 1024 ** 3)
        box.append(recEl('p', 'rec-bad-text',
            rtxt('models.recommend.unlock.small_mac',
                'Not recommended on a {memory} Mac. macOS and your browser would be'
                + ' left with almost no memory.',
                { memory: recGB((rec.memory || {}).total_bytes) })));
    const grid = recEl('div', 'rec-unlock-grid');
    // ① the memory guard tier — the only POST on this surface
    const g = recEl('div', 'rec-ucard');
    const gHead = recEl('div', 'rec-uhead');
    gHead.append(recEl('b', null, C.tf('models.recommend.unlock.guard.title',
        '① Set Memory Guard to Aggressive')));
    const gGain = recUnlockGain(rec, 'memory_guard');
    gHead.append(recEl('span', gGain ? 'rec-good' : 'rec-dim',
        gGain ? '+' + recGB(gGain)
            : C.tf('models.recommend.unlock.no_gain', 'No effect on its own')));
    g.append(gHead);
    const m = rec.memory || {};
    if (m.tier !== 'aggressive') {
        g.append(recEl('p', 'rec-note', m.tier === 'custom'
            ? rtxt('models.recommend.unlock.guard.body_custom',
                'Your custom limit holds models to {size}. Aggressive keeps only {to}'
                + ' for macOS and other apps instead.',
                { size: recGB(m.static_ceiling_bytes), to: recGB(recAggressiveReserve(rec)) })
            : rtxt('models.recommend.unlock.guard.body',
                'Shrinks the share kept for macOS and other apps from {from} to {to}.',
                { from: recGB(m.reserve_bytes), to: recGB(recAggressiveReserve(rec)) })));
        g.append(recBtn('se-btn', 'models.recommend.unlock.guard.button', 'Switch to Aggressive',
            () => recSetAggressive(rec), REC.applying));
    } else {
        g.append(recEl('p', 'rec-note', C.tf('models.recommend.unlock.guard.done',
            'Memory guard is already set to Aggressive.')));
    }
    // ② the kernel wired limit — a Terminal command, never a write from here
    const w = recEl('div', 'rec-ucard');
    const wHead = recEl('div', 'rec-uhead');
    wHead.append(recEl('b', null, C.tf('models.recommend.unlock.wired.title',
        '② Raise the GPU memory limit')));
    const wGain = recUnlockGain(rec, 'wired_limit');
    wHead.append(recEl('span', wGain ? 'rec-good' : 'rec-dim',
        wGain ? '+' + recGB(wGain)
            : C.tf('models.recommend.unlock.no_gain', 'No effect on its own')));
    w.append(wHead);
    const cmd = recWiredCommand(rec);
    if (cmd) {
        w.append(recEl('p', 'rec-note', rtxt('models.recommend.unlock.wired.body',
            'By default macOS lets the GPU use about {percent}% of memory. Run this in'
            + ' Terminal. It asks for your password and resets on reboot.',
            { percent: recMetalPercent(rec) })));
        const line = recEl('div', 'rec-cmdline');
        line.append(recEl('code', 'rec-cmd', cmd));
        line.append(recBtn('se-btn act', 'models.recommend.unlock.copy', 'Copy',
            () => recCopyCmd(cmd)));
        w.append(line);
    } else {
        w.append(recEl('p', 'rec-note', C.tf('models.recommend.unlock.wired.done',
            'The GPU memory limit is already raised.')));
    }
    grid.append(g, w);
    box.append(grid);
    box.append(recEl('p', 'rec-note', recUnlockSummary(rec)));
    const rows = recEl('div', 'rec-rows');
    for (const item of ((rec.sections || {}).unlock) || [])
        rows.append(recRow(rec, 'unlock', item));
    if (!rows.children.length)
        rows.append(recEl('p', 'rec-dim', C.tf('models.recommend.unlock.none',
            'Raising the limits does not unlock a better model on this Mac.')));
    box.append(rows);
    return box;
}
// classic copyWiredLimitCommand:6587 — clipboard only, no fallback hack
function recCopyCmd(cmd) {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || !nav.clipboard || !nav.clipboard.writeText) return;
    nav.clipboard.writeText(cmd).then(
        () => DG.toast(C.tf('models.recommend.unlock.copied', 'Copied')),
        () => {});
}
// classic recSetAggressive:8015 — POST the single flat key, then re-price.
// Uplift adds the confirm the house requires for every settings write
// (UP-25 precedent: window.confirm(C.tf(key…)) before the POST).
function recSetAggressive(rec) {
    if (REC.applying) return Promise.resolve(false);
    const m = (rec && rec.memory) || {};
    const body = m.tier === 'custom'
        ? rtxt('models.recommend.unlock.guard.body_custom',
            'Your custom limit holds models to {size}. Aggressive keeps only {to} for'
            + ' macOS and other apps instead.',
            { size: recGB(m.static_ceiling_bytes), to: recGB(recAggressiveReserve(rec)) })
        : rtxt('models.recommend.unlock.guard.body',
            'Shrinks the share kept for macOS and other apps from {from} to {to}.',
            { from: recGB(m.reserve_bytes), to: recGB(recAggressiveReserve(rec)) });
    const ask = C.tf('models.recommend.unlock.guard.button', 'Switch to Aggressive')
        + '\n\n' + body + '\n\n' + recUnlockSummary(rec);
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(ask))
        return Promise.resolve(false);
    REC.applying = true;
    paintRecos();
    // classic payload (dashboard.js:8015): the flat key on global-settings
    return DG.postJson(`${API}/admin/api/global-settings`, { memory_guard_tier: 'aggressive' })
        .then(() => dlGlobalSettingsReset())
        .then(() => loadRecommendations(true))
        .catch(e => {
            DG.toast(C.tf('models.recommend.error', 'Could not load recommendations.')
                + ' ' + D.errText(e));
        })
        .then(() => { REC.applying = false; paintRecos(); return true; });
}

function paintRecos() {
    if (DL.tab === 'recos') renderRecos(D.$('dl-results'));
}

// classic loadRecommendations:7816 — one cached fetch behind a loading line
function loadRecommendations(force) {
    if (REC.loading) return Promise.resolve();
    if (REC.data && !force) { paintRecos(); return Promise.resolve(); }
    REC.loading = true; REC.error = '';
    paintRecos();
    return DG.fetchJson(`${API}/admin/api/hf/recommendations`).then(d => {
        REC.data = d || null;
        REC.loading = false;
        // the per-row DOWNLOADED / DOWNLOADING state reads the local inventory
        return ensureHfModels(true).then(() => { paintRecos(); });
    }, e => {
        REC.loading = false;
        REC.error = D.errText(e);
        paintRecos();
    });
}

// The whole surface: stale banner, Your Mac, best cards, the two trade-off
// groups, the faster group, the unlock panel, the author footer.
function renderRecos(host) {
    if (!host) return;
    host.innerHTML = '';        // house container-clear (text-only rebuild)
    host.classList.add('recos');
    const rec = REC.data;
    if (!rec) {
        if (REC.error) {
            host.append(recEl('p', 'rec-bad-text', C.tf('models.recommend.error',
                'Could not load recommendations.') + ' ' + REC.error));
            host.append(recBtn('se-btn', 'models.recommend.retry', 'Try again',
                () => loadRecommendations(true)));
            return;
        }
        host.append(recEl('p', 'empty',
            C.tf('models.recommend.loading', 'Checking which models fit this Mac…')));
        if (!REC.loading) loadRecommendations();   // a blank first paint kicks it
        return;
    }
    if (rec.stale)
        host.append(recEl('p', 'rec-warn-text rec-banner',
            C.tf('models.recommend.stale',
                'Showing the last list. Hugging Face could not be reached.')));
    host.append(recMacPanel(rec));
    const best = (rec.sections || {}).best || [];
    const secBest = recSectionHead('★', 'models.recommend.best.title', 'Best for your Mac',
        'models.recommend.best.subtitle',
        'Builds that load with your current settings and leave room for at least 32K'
        + ' tokens of chat. Models of similar smarts are ordered by downloads.');
    if (!best.length) {
        secBest.append(recEl('p', 'rec-dim', C.tf('models.recommend.best.empty',
            'Nothing fits with the current settings. See “Unlock bigger models” below.')));
    } else {
        const cards = recEl('div', 'rec-cards');
        best.forEach((item, i) => cards.append(recCard(rec, item, i === 0)));
        secBest.append(cards);
    }
    host.append(secBest);
    if (best.length) {
        const smart = recSectionHead('◆', 'models.recommend.smarter.title',
            'Smarter, but slower', 'models.recommend.smarter.subtitle',
            'When answer quality matters more than speed.');
        const groups = recEl('div', 'rec-rows');
        for (const [key, tk, ten] of [
            ['bigger', 'models.recommend.bigger.title', 'Bigger model, fewer bits'],
            ['precise', 'models.recommend.precise.title', 'Same model, more bits']]) {
            groups.append(recEl('div', 'rec-group', C.tf(tk, ten)));
            const list = (rec.sections || {})[key] || [];
            if (!list.length) {
                groups.append(recEl('p', 'rec-dim', key === 'bigger'
                    ? recBiggerEmpty(rec)
                    : C.tf('models.recommend.precise.empty',
                        'No higher-precision build of the recommended models fits right now.')));
            }
            for (const item of list) groups.append(recRow(rec, key, item));
        }
        smart.append(groups);
        host.append(smart);
        const fast = recSectionHead('»', 'models.recommend.faster.title',
            'Faster, but less capable', 'models.recommend.faster.subtitle',
            'Quick replies, very long chats, or running alongside other apps.');
        const flist = (rec.sections || {}).faster || [];
        if (!flist.length) {
            fast.append(recEl('p', 'rec-dim', C.tf('models.recommend.faster.empty',
                'No clearly faster alternative.')));
        }
        for (const item of flist) fast.append(recRow(rec, 'faster', item));
        host.append(fast);
    }
    host.append(recUnlockPanel(rec));
    host.append(recEl('p', 'rec-dim rec-footer',
        rtxt('models.recommend.footer',
            'Models from huggingface.co/{author}. oQ is oMLX quantization; higher'
            + ' numbers are more precise and larger.', { author: rec.author })));
}

function initDownloader() {
    const TABS = ['recos', 'trending', 'popular', 'search'];
    // The results/page state the ACTIVE provider owns. UP-22: one surface,
    // two sources — classic keeps downloaderSource and msRecommendedTab
    // apart; uplift re-drives the SAME tab strip, grid, pager and task board.
    function pane() { return DL.provider === 'ms' ? MS : DL; }
    function setTab(tab) {
        if (tab === 'recos' && DL.provider === 'ms') return;      // UP-23 is HF-only
        DL.tab = tab;
        for (const t of TABS) {
            const b = D.$('dl-tab-' + t); if (b) b.classList.toggle('on', t === tab);
        }
        const s = pane();
        s.page[tab] = s.page[tab] || 1;
        if (tab === 'search' && !s.search.length && s.q) doSearch();
        renderDlPage();
    }
    function renderDlPage() {
        const host = D.$('dl-results'); if (!host) return;
        const sub = D.$('dl-sub');
        const pg = D.$('dl-pager');
        if (DL.tab === 'recos') {                    // UP-23: its own surface
            renderRecos(host);
            if (pg) pg.innerHTML = '';
            if (sub) sub.textContent = '';
            return;
        }
        host.classList.remove('recos');
        host.innerHTML = '';
        if (DL.provider === 'ms' && MS.available === false) {
            // classic _models.html:895 — the source stays selectable, the pane
            // says WHY it has nothing to show
            setEmpty(C.tf('models.downloader.ms_unavailable',
                'ModelScope SDK not installed. Install with: pip install "omlx[modelscope]"'));
            if (pg) pg.innerHTML = '';
            renderMsHistory();
            return;
        }
        const s = pane();
        const list = DL.tab === 'search' ? s.search : s.rec[DL.tab];
        if (list == null) {
            D.emptyMsg(host, C.t('uplift.dl.loading'));
            if (DL.provider === 'ms') loadMsRecommended();
            return;
        }
        if (!list.length) {
            D.emptyMsg(host, DL.tab === 'search'
                ? C.tf('uplift.dl.no_results', 'No results — try another query.')
                : DL.provider === 'ms'
                    ? C.tf('models.browse.no_trending', 'No trending models found for your system.')
                    : C.tf('uplift.dl.hf_unavailable',
                        'Hugging Face suggested models unavailable.'));
            if (pg) pg.innerHTML = '';
            renderMsHistory();
            return;
        }
        const fallback = DL.tab === 'popular' ? 'downloads' : 'trending_score';
        const rows = dlSortModels(list, DL.sort.key, DL.sort.dir, DL.tab === 'search' ? null : fallback);
        DL.size = dlPageSize();
        const pages = DL.provider === 'ms'
            ? Math.max(1, msTotalPages(rows.length, DL.size, DL.tab))
            : Math.max(1, Math.ceil(rows.length / DL.size));
        if (s.page[DL.tab] > pages) s.page[DL.tab] = pages;
        const start = (s.page[DL.tab] - 1) * DL.size;
        // header (sortable, classic parity)
        const cols = [['rank', '#'], ['name', 'Model'], ['params', 'Params'],
                      ['size', 'Size'], ['downloads', 'Downloads'], ['likes', 'Likes'], [null, '']];
        const head = document.createElement('div'); head.className = 'urow usage head';
        for (const [key, label] of cols) {
            const arrow = DL.sort.key === key && key ? (DL.sort.dir === 1 ? ' ▲' : ' ▼') : '';
            const t = DG.cell(label + arrow);
            if (key) { t.className = 'sortable' + (DL.sort.key === key ? ' sorted' : '');
                t.onclick = () => {
                    if (DL.sort.key === key) DL.sort.dir = -DL.sort.dir;
                    else { DL.sort.key = key; DL.sort.dir = (key === 'name' || key === 'rank') ? 1 : -1; }
                    renderDlPage();
                };
            }
            head.append(t);
        }
        host.append(head);
        const ram = (DL.gs && DL.gs.system && DL.gs.system.total_memory_bytes) || 0;
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
            if (DL.provider === 'ms') {
                // classic MS rows (_models.html:1100-1114): a repo that is
                // already on disk shows the badge and no button, and a row
                // whose weights exceed installed RAM warns 'Tight fit'.
                // NO file-pick dialog: ModelScope has none upstream.
                if (dlDownloaded(m.repo_id)) {
                    act.append(dlBadge('ok', C.tf('models.browse.downloaded', 'Downloaded')));
                } else {
                    if (HFS.memFit(ram, m.size || 0) === 'warning')
                        act.append(dlBadge('warn', C.tf('models.browse.tight_fit', 'Tight fit')));
                    const b = document.createElement('button');
                    b.className = 'se-btn act';
                    b.textContent = C.tf('models.downloader.download_button', 'download');
                    b.disabled = !!MS.downloading;
                    b.onclick = () => msDownload(m.repo_id);
                    act.append(b);
                }
            } else {
                const b = document.createElement('button');
                b.className = 'se-btn act'; b.textContent = 'download';
                b.onclick = () => openModelFiles(m.repo_id);   // UP-14: pick files first (classic)
                act.append(b);
            }
            row.append(act);
            host.append(row);
        }
        if (sub) {
            /* One keyed sentence per case. The old shape was
               `${rows.length} results ${extra}${inv}` with two English
               literals spliced in, which no locale can reorder or decline —
               'suggested by HF' shipped untranslated in every language.
               Provider names stay literal (product names, per the helper-page
               precedent). */
            const prov = DL.provider === 'ms' ? 'ModelScope' : 'Hugging Face';
            const bits = [DL.tab === 'search'
                ? C.tf('uplift.dl.results_for', '{n} results matching “{q}”',
                    { n: rows.length, q: s.q || DL.q })
                : C.tf('uplift.dl.results_suggested',
                    '{n} results suggested by {provider}',
                    { n: rows.length, provider: prov })];
            if (DL._invalid || DL.rec._invalid)
                bits.push(C.tf('uplift.dl.token_rejected',
                    'HF token rejected — listed anonymously'));
            sub.textContent = bits.join(' · ');
        }
        // pager
        if (!pg) { renderMsHistory(); return; }
        pg.innerHTML = '';
        if (pages <= 1) { renderMsHistory(); return; }
        const mk = (label, page, dis) => {
            const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis;
            b.onclick = () => { s.page[DL.tab] = page; renderDlPage();
                D.$('dl-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
            pg.append(b);
        };
        mk('«', 1, s.page[DL.tab] === 1);
        mk('‹', s.page[DL.tab] - 1, s.page[DL.tab] === 1);
        mk('›', s.page[DL.tab] + 1, s.page[DL.tab] === pages);
        mk('»', pages, s.page[DL.tab] === pages);
        const info = document.createElement('span'); info.className = 'pinfo';
        info.textContent = `${s.page[DL.tab]} / ${pages} · ${rows.length} models`;
        pg.append(info);
        renderMsHistory();
    }
    // safe empty-state (server error text goes through textContent, never innerHTML)
    function setEmpty(msg) {
        const host = D.$('dl-results'); if (!host) return;
        host.innerHTML = '';
        const d = document.createElement('div'); d.className = 'empty'; d.textContent = msg;
        host.append(d);
    }
    function loadRecommended(force) {
        if (DL.provider === 'ms') { loadMsRecommended(force); return; }   // UP-22
        if (DL.tab === 'recos') { loadRecommendations(force); return; }   // UP-23
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
            if (host && DL.tab !== 'search')
                setEmpty(C.tf('uplift.dl.suggestions_failed', 'Suggestions failed: {err}', { err: D.errText(e) }));
        });
    }
    function doSearch() {
        if (DL.provider === 'ms') { doMsSearch(); return; }   // UP-22
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
            setEmpty(C.tf('uplift.dl.search_failed', 'Search failed: {err}', { err: D.errText(e) }));
        });
    }
    // UP-22: the source switch. Entry row, tabs, grid, pager AND the task
    // board all re-read the active pane; the hardware picks are an HF-only
    // surface, so they step aside while ModelScope is showing.
    function setProvider(p) {
        if (p !== 'hf' && p !== 'ms') return Promise.resolve();
        if (p === DL.provider) return Promise.resolve();
        swapProviderInputs(p);
        DL.provider = p;
        if (p === 'ms' && DL.tab === 'recos') DL.tab = 'trending';
        paintProvider();
        renderTasks('dl-tasks', p);
        return (p === 'ms' ? msStatus() : Promise.resolve(true)).then(() => {
            paintProvider();
            renderMsHistory();
            renderDlPage();
            loadRecommended(false);
        });
    }
    function paintProvider() {
        relabelDlChrome();
        for (const p of ['hf', 'ms']) {
            const b = D.$('dl-src-' + p);
            if (b) b.classList.toggle('on', p === DL.provider);
        }
        for (const t of TABS) {
            const b = D.$('dl-tab-' + t);
            if (b) b.classList.toggle('on', t === DL.tab);
        }
        const recos = D.$('dl-tab-recos');
        if (recos) recos.style.display = DL.provider === 'ms' ? 'none' : '';
        const ms = D.$('dl-src-ms');
        if (ms)
            ms.title = MS.available === false
                ? C.tf('models.downloader.ms_unavailable',
                    'ModelScope SDK not installed. Install with: pip install "omlx[modelscope]"')
                : C.tf('models.downloader.source.ms', 'ModelScope');
        const tk = D.$('dl-ms-token');
        if (tk) tk.style.display = DL.provider === 'ms' ? '' : 'none';
    }
    // Publish the closures module scope cannot see: the MS loaders, the
    // injected history chips and the recs rows all re-enter the page here.
    DLX.render = renderDlPage;
    DLX.setTab = setTab;
    DLX.empty = setEmpty;
    DLX.search = doSearch;
    DLX.setProvider = setProvider;
    ensureDlChrome();
    if (!dlInit) {
        dlInit = true;
        // token: persisted in this browser only (user preference: localStorage)
        const tk = D.$('dl-token');
        try { tk.value = localStorage.getItem('uplift.hf_token') || ''; } catch (_) {}
        tk.addEventListener('change', () => {
            try { localStorage.setItem('uplift.hf_token', tk.value.trim()); } catch (_) {}
        });
        // UP-22: the ModelScope token is its own value under its own key —
        // an HF token is never carried across to ms/download
        const mtk = D.$('dl-ms-token');
        if (mtk) {
            try { mtk.value = localStorage.getItem('uplift.ms_token') || ''; } catch (_) {}
            mtk.addEventListener('change', () => {
                try { localStorage.setItem('uplift.ms_token', mtk.value.trim()); } catch (_) {}
            });
        }
        D.$('dl-go').onclick = doSearch;
        D.$('dl-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        D.$('dl-sort').onchange = () => { if (DL.tab === 'search' && pane().q) doSearch(); };
        D.$('dl-mlx').onchange = () => {
            if (DL.tab === 'search') doSearch(); else loadRecommended(true);
        };
        for (const t of TABS) {
            const b = D.$('dl-tab-' + t);
            if (b) b.onclick = () => {
                if (t === 'search' && !pane().q) { DG.toast(C.t('uplift.toast.type_query_press_search')); D.$('dl-q').focus(); return; }
                setTab(t);
            };
        }
        for (const p of ['hf', 'ms']) {
            const b = D.$('dl-src-' + p);
            if (b) b.onclick = () => setProvider(p);
        }
        D.$('dl-direct').onclick = directDownload;   // UP-14: URL-aware, dialog-first
        D.$('dl-repo').addEventListener('keydown', e => {
            if (e.key === 'Enter') directDownload(); });
        dlGlobalSettings().then(gs => { if (!DL.gs) DL.gs = gs; });
        MS.history = msHistoryLoad();
        ensureHfModels();      // DOWNLOADED badges (MS rows, recs rows) need it
        msStatus().then(() => { paintProvider(); renderMsHistory(); });
    }
    paintProvider();
    if (DL.tab === 'search' && pane().search.length) renderDlPage();
    else if (DL.tab === 'recos') { renderDlPage(); loadRecommended(); }
    else loadRecommended();
    renderTasks('dl-tasks', DL.provider);
    renderMsHistory();
}

window.Uplift = window.Uplift || {};
window.Uplift.downloader = { renderTasks, initDownloader,
    _dl14: { hfRepoIdFromInput, HFS, directDownload },
    // UP-22 ModelScope half + UP-23 hardware picks (tests/u22, tests/u23)
    _up22: { MS, DL, DLX, msRepoId, msTotalPages, msHistoryPush, msHistoryLoad, dlMsToken,
        msHistorySave, msStatus, msDownload, segBtn, ensureDlChrome, relabelDlChrome,
        swapProviderInputs, renderMsHistory },
    _up23: { REC, DL, rtxt, recGB, recContext, recParams, recDots, recScenarios,
        recArch, recDownloadsText, recSpeedVs, recNote, recMemoryShare,
        recMemoryBarClass, recMemorySegments, recUnlockOpen, recUnlockGain,
        recAggressiveReserve, recMetalPercent, recWiredCommand, recUnlockSummary,
        recChipLine, recMemoryLine, recGpuLimitText, recBiggerEmpty, recTaskOf,
        recStateOf, recDiskShort, recEl, recBtn, recBadges, recMeters, recMemBar,
        recAction, recRow, recCard, recMacPanel, recUnlockPanel, recCopyCmd,
        recSetAggressive, renderRecos, loadRecommendations, paintRecos, dlDownloaded } };
})();
