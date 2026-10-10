/* SPLIT-2 stage 4 (uplift_modelmgr.js split): the Models table —
   sortable/filterable admin rows, optimistic flag overrides, confirm
   dialog. adminModels became a shared cell on window.Uplift.state (the
   settings editor reads it while open); editor-side calls late-bind
   through the modelmgr facade (MMF). Loads after uplift_mmchips.js and
   uplift_mmtemplates.js (row-chip utils + templates box), BEFORE
   uplift_modelmgr.js. Exports window.Uplift.mmTable. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const $ = D.$;
const S = window.Uplift.state;
const API = S.API;
const prefs = S.prefs;
const MM_GLUE = { toast: D.toast, fetchJson: D.fetchJson, cell: D.cell,
    get stats() { return window.Uplift._modelGlue.stats; },
    get SECRET_KEYS() { return window.Uplift._modelGlue.SECRET_KEYS; },
    get gsDisplay() { return window.Uplift._modelGlue.gsDisplay; },
    get putModelSettings() { return window.Uplift._modelGlue.putModelSettings; },
    get postModelAction() { return window.Uplift._modelGlue.postModelAction; } };
const CHIPS = window.Uplift.mmChips;
const tapBtn = CHIPS.tapBtn, copyText = CHIPS.copyText, copyBtn = CHIPS.copyBtn,
      labBreak = CHIPS.labBreak, appendChips = CHIPS.appendChips,
      aliasTree = CHIPS.aliasTree, foldHost = CHIPS.foldHost,
      scheduleAlign = CHIPS.scheduleAlign,
      deleteStoredSettings = CHIPS.deleteStoredSettings,
      deleteModelFromDisk = CHIPS.deleteModelFromDisk;
const MM_TPL = window.Uplift.mmTemplates;
const MMF = {
    get openEditor() { return (...a) => window.Uplift.modelmgr.openEditor(...a); },
    get closeEditor() { return (...a) => window.Uplift.modelmgr.closeEditor(...a); },
    get seModel() { return window.Uplift.modelmgr.seModel; },
};
/* pendingWrites lives in window.Uplift.state — S.trackWrite (uplift_state.js)
   inc/dec it; ticks here must not paint stale state during in-flight writes. */
/* The gateway's model snapshot refreshes on a poll (10 s live mode), so a
   successful flag write can briefly paint back the OLD value ("pin does not
   react"). Remember what we just wrote and overlay it until the fetched
   model agrees, then the override expires on its own. */
const flagOverrides = {};
function flagSet(mid, patch) {
    flagOverrides[mid] = Object.assign(flagOverrides[mid] || {}, patch);
}
async function flagWrite(mid, patch, write) {
    flagSet(mid, patch);
    try { await write(); }
    catch (e) { if (flagOverrides[mid]) for (const k of Object.keys(patch)) delete flagOverrides[mid][k]; throw e; }
}
/* S.trackWrite moved to uplift_state.js (MM_GLUE.putModelSettings/MM_GLUE.postModelAction
   in uplift.js share the pendingWrites counter with renderModelAdmin). */
/* ---------------- model manager table (sorting, filters, row chips) ------ */
let sortKey = (prefs.tableSort && prefs.tableSort.key) || 'name';
let sortDir = (prefs.tableSort && prefs.tableSort.dir) || 1;      // 1 asc, -1 desc

function saveTableSort() {
    prefs.tableSort = { key: sortKey, dir: sortDir };
    // FE-1: write through core.savePrefs — the raw setItem copy bypassed
    // the key constant and its storage-denied guard.
    C.savePrefs(localStorage, prefs);
}

function stateRank(m) { return m.loaded ? 0 : (m.is_loading ? 1 : 2); }
/* Optimistic LOADING paint for a click-fired load: swaps the live PRESENT
   pill for the amber segment (same markup as the server-driven branch) and
   returns an undo that puts the pill back when the load fails. Honest by
   construction — the engine IS loading the moment the POST is accepted, so
   this shows a state the server already holds, not a guess. */
function paintLoading(sw, title) {
    const pill = sw.querySelector('.lsw-seg.present');
    if (!pill) return () => {};
    const seg = document.createElement('span');
    seg.className = 'lsw-seg load';
    seg.textContent = 'LOADING';
    seg.title = title;
    pill.replaceWith(seg);
    return () => { seg.replaceWith(pill); };
}
function sortModels(rows) {
    // Match classic dashboard.js semantics (F-027/F-028): favorites pin
    // first regardless of column/direction; name keys are lowercased so
    // 'bge' and 'Ternary' interleave the way the column reads.
    const key = (a, b) => a.id.localeCompare(b.id);
    // uplift ids ARE the leaf names (display_name carries the owner/
    // prefix); the column shows the leaf, so lowerCase the id.
    const lo = m => (m.id || '').toLowerCase();
    const nameCmp = (a, b) => {
        const x = lo(a), y = lo(b);
        return x < y ? -1 : x > y ? 1 : key(a, b);
    };
    const cmp = {
        name: nameCmp,
        type: (a, b) => (a.model_type || '').toLowerCase().localeCompare((b.model_type || '').toLowerCase()) || nameCmp(a, b),
        state: (a, b) => stateRank(a) - stateRank(b) || nameCmp(a, b),
        size: (a, b) => ((a.actual_size || a.estimated_size || 0) - (b.actual_size || b.estimated_size || 0)),
    }[sortKey] || nameCmp;
    const favFirst = (a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0);
    return rows.sort((a, b) => favFirst(a, b) || (cmp(a, b) || 0) * sortDir || key(a, b));
}

async function renderModelAdmin(force) {
    let models;
    try { models = (await MM_GLUE.fetchJson(`${API}/admin/api/models`)).models; }
    catch (_) { D.emptyMsg($('model-admin'), C.t('uplift.mm.api_unreachable')); return; }
    S.adminModels = models;
    // expire/apply optimistic flag overrides against the fresh snapshot
    for (const m of models) {
        const ov = flagOverrides[m.id];
        if (!ov) continue;
        for (const [k, v] of Object.entries(ov)) {
            if (m[k] === v) delete ov[k]; else m[k] = v;
        }
        if (!Object.keys(ov).length) delete flagOverrides[m.id];
    }
    // editor open OR a write in flight: don't paint a possibly stale snapshot
    if ((MMF.seModel || S.pendingWrites) && !force) return;
    const filter = ($('ma-filter').value || '').toLowerCase().trim();
    const typeSel = $('ma-type');
    const type = typeSel.value || '';
    const onlyLoaded = $('ma-only-loaded').checked;
    const onlyFav = $('ma-only-fav') && $('ma-only-fav').checked;
    const presentOnly = $('ma-present-only').checked;
    let shown = models.filter(m =>
        (!filter || m.id.toLowerCase().includes(filter) ||
         (m.display_name || '').toLowerCase().includes(filter) ||
         (m.settings && m.settings.model_alias || '').toLowerCase().includes(filter)) &&
        (!type || (m.model_type || '') === type) &&
        (!onlyFav || m.is_favorite) &&
        (!onlyLoaded || m.loaded || m.is_loading));
    shown = sortModels(shown);
    // settings store drives the Missing section below the present rows
    const onManager = document.documentElement.dataset.tab === 'models'
        && document.documentElement.dataset.sub === 'manager'
        && !!$('ma-present-only');
    let idx = { stored: S.settingsIdx.stored, orphans: S.settingsIdx.orphans || [],
        entries: S.settingsIdx.entries || [], profiles: S.settingsIdx.profiles || [] };
    if (onManager) { try { idx = await MM_GLUE.fetchJson(`${API}/admin/api/model-settings-index`);
                            S.settingsIdx = idx; } catch (_) {} }
    const orphan = new Set(idx.orphans || []);
    const knownIds = new Set(models.map(m => m.id));
    const missingAll = (idx.entries || []).filter(e => !knownIds.has(e.id));
    let missing = missingAll.filter(e => !filter || e.id.toLowerCase().includes(filter) ||
        (e.alias || '').toLowerCase().includes(filter));
    if (presentOnly) missing = [];
    const loadedN = models.filter(m => m.loaded).length;
    if (onManager) MM_TPL.render();
    // stored/missing never follow the filters; shown counts every visible row
    $('models-admin-sub').textContent = `${loadedN}/${models.length} loaded \u00b7 `
        + `${idx.stored} stored \u00b7 ${shown.length + missing.length} shown`;
    // the counter lives UNDER the Prune button — it is that button's
    // subject, not a table stat (round 4); round 5: honest wording, it
    // counts stored records whose model is not on disk
    $('ma-missing-count').textContent = C.tf('uplift.ui.n_missing_records',
        '{n} models not present', { n: missingAll.length });
    const memUsed = MM_GLUE.stats ? MM_GLUE.stats.memUsed : null;
    $('ma-mem').textContent = memUsed !== null
        ? `memory ${C.fmtBytes(memUsed)} / ${C.fmtBytes(MM_GLUE.stats.memMax)}` : '';
    if (typeSel.dataset.built !== '1') {
        const types = [...new Set(models.map(m => m.model_type).filter(Boolean))].sort();
        for (const t of types) {
            const o = document.createElement('option');
            o.value = t; o.textContent = t;
            typeSel.append(o);
        }
        typeSel.dataset.built = '1';
    }

    const table = $('model-admin');
    table.innerHTML = '';
    if (!shown.length && !missing.length) {
        D.emptyMsg(table, C.t('uplift.mm.no_match')); return; }
    const head = document.createElement('div'); head.className = 'urow head admin';
    // meta columns (type/state/size) now live INSIDE the model MM_GLUE.cell's first
    // line, so their sort controls ride the header's left MM_GLUE.cell as chips
    const hcL = document.createElement('span'); hcL.className = 'head-left';
    // round 6 item 12: sort chips sit above the values they sort — model and
    // type label the LEFT edge (line-2 badge), size + state ride the MM_GLUE.cell's
    // right edge in the row's own order (size, then state)
    const leftChips = document.createElement('span'); leftChips.className = 'hchips';
    const rightChips = document.createElement('span'); rightChips.className = 'hchips right';
    const chip = (label, key) => {
        const c = document.createElement('span');
        c.textContent = label + (sortKey === key ? (sortDir === 1 ? ' \u25b2' : ' \u25bc') : '');
        if (key) {
            c.classList.add('sortable');
            c.onclick = () => {
                if (sortKey === key) sortDir = -sortDir;
                else { sortKey = key; sortDir = key === 'size' ? -1 : 1; }
                saveTableSort();
                renderModelAdmin(true);
            };
        }
        return c;
    };
    leftChips.append(chip('model', 'name'), chip('type', 'type'));
    rightChips.append(chip('size', 'size'), chip('state', 'state'));
    hcL.append(leftChips, rightChips);
    const hcR = document.createElement('span');
    head.append(hcL, hcR);
    table.append(head);
    for (const m of shown) {
        const mbox = document.createElement('div'); mbox.className = 'mbox';
        const row = document.createElement('div'); row.className = 'urow admin';
        row.dataset.mid = m.id;
        const name = document.createElement('span');
        name.className = 'uname'; name.title = m.model_path || m.id;
        /* CARD-1 (user 2026-10-09) row order: line 1 = model NAME (top-left,
           bigger) with the type badge to its right and the copy icon after the
           badge; line 2 = the lamps (FAVOURITE/PINNED/DEFAULT/ALIAS) below the
           name, then size + state pushed to the cell's right edge. The name
           line leads the cell so the alias trunk can hang below it at a fixed
           x (see the trunk CSS) and the alias lines stay on their grid. */
        const head1 = document.createElement('span'); head1.className = 'nrow1';
        const nmain = document.createElement('span'); nmain.className = 'nmain';
        const uid = MM_GLUE.cell(m.id); uid.className = 'uid';
        // CARD-1: the badge must sit BETWEEN name and copy icon, so the copy
        // button is appended after it (further down) rather than here.
        nmain.append(uid);
        // PINNED / DEFAULT / FAVOURITE cockpit lamps, then the model ALIAS as
        // its own lamp (round 4: an alias is not a profile — it must not
        // render as one; the lamp shows the served name and copies it).
        const lamps = document.createElement('span'); lamps.className = 'lampstack inline';
        const lamp = (label, lit, title, fn) => {
            const b = document.createElement('button');
            b.className = 'lamp' + (lit ? ' on' : '');
            b.textContent = label; b.title = title;
            tapBtn(b, fn);
            return b;
        };
        lamps.append(
            lamp('FAVOURITE', !!m.is_favorite, m.is_favorite ? 'Unfavorite' : 'Favorite',
                () => flagWrite(m.id, { is_favorite: !m.is_favorite },
                    () => MM_GLUE.putModelSettings(m.id, { is_favorite: !m.is_favorite }))
                    // ACHIEVEMENTS: only a successful write earns a verdict
                    .then(() => {
                        try {
                            const AC = window.Uplift && window.Uplift.achv;
                            if (AC && !m.is_favorite) {
                                const v = AC.flagReaction('favorite', true);
                                if (v) AC.announce([v]);
                            }
                        } catch (_) { /* verdicts never break the lamp */ }
                    })),

            lamp('PINNED', !!m.pinned, m.pinned ? 'Unpin (allow unload)' : 'Keep loaded (pin)',
                // R10-B1: classic-compat write path — is_pinned via PUT
                // settings (the pin/unpin POSTs were mock-only sugar)
                () => flagWrite(m.id, { pinned: !m.pinned },
                    () => MM_GLUE.putModelSettings(m.id, { is_pinned: !m.pinned }))),
            lamp('DEFAULT', !!m.is_default,
                m.is_default ? 'Clear default model' : 'Make default model',
                () => {
                    if (!m.is_default) for (const o of S.adminModels)
                        if (o.id !== m.id && o.is_default) flagSet(o.id, { is_default: false });
                    return flagWrite(m.id, { is_default: !m.is_default },
                        () => MM_GLUE.putModelSettings(m.id, { is_default: !m.is_default }));
                }));
        if (m.settings && m.settings.model_alias) {
            const a = m.settings.model_alias;
            const al = lamp('ALIAS:' + a, true, 'Serves this model on the API under the name "'
                + a + '" — click to copy', () => copyText(a));
            al.classList.add('alias-lamp');
            // round 6 item 9: the lamp itself copies on click, but it reads
            // as a status light — a visible copy icon makes it discoverable
            lamps.append(al, copyBtn(a, 'Copy alias "' + a + '"'));
        }
        // type badge: colour-coded, fixed-width like the lamps above, sits
        // left of the model name on line 2 (round 5). Unknown types stay
        // neutral — the badge never invents a category.
        const typeC = document.createElement('span');
        const tv = (m.model_type || '').toLowerCase();
        const tcls = /vlm|vision|whisper/.test(tv) ? 't-vlm'
            : /rerank|embed|bge/.test(tv) ? 't-embed'
            : tv ? 't-llm' : 't-none';
        typeC.className = 'typebadge ' + tcls;
        typeC.textContent = (m.model_type || '\u2014').toUpperCase();
        // State: LOADED models keep the LOADED/IDLE rocker (IDLE half =
        // unload). Present-but-unloaded show a single PRESENT pill that
        // loads on click (round 4: "IDLE" for an unloaded model was a lie).
        const state = document.createElement('span');
        state.className = 'statewrap';
        const sw = document.createElement('span'); sw.className = 'lsw';
        if (m.is_loading) {
            const seg = document.createElement('span');
            seg.className = 'lsw-seg load'; seg.textContent = 'LOADING';
            if (m.loading_remaining_seconds_estimate > 0)
                seg.textContent = 'LOADING ~' + Math.ceil(m.loading_remaining_seconds_estimate) + 's';
            sw.append(seg);
        } else if (m.loaded) {
            // round 6: the lone IDLE half is gone — LOADED itself is the
            // unload control (same pattern as PRESENT being the load control)
            const lo = document.createElement('button');
            lo.className = 'lsw-seg on'; lo.textContent = 'LOADED';
            lo.title = 'Model is loaded — click to unload';
            tapBtn(lo, () => MM_GLUE.postModelAction(m.id, 'unload'));
            sw.append(lo);
        } else {
            const pr = document.createElement('button');
            pr.className = 'lsw-seg present'; pr.textContent = 'PRESENT';
            pr.title = 'On disk, not loaded — click to load';
            tapBtn(pr, () => {
                // The native load POST BLOCKS until the engine is ready and it
                // runs inside S.trackWrite, so pendingWrites freezes the 8 s
                // repaint for the whole load: the server's is_loading=true can
                // never reach the row on a click-fired load. Paint LOADING
                // optimistically; PRESENT comes back if the load fails, the
                // forced re-render shows LOADED when it succeeds.
                const undoLoading = paintLoading(sw, `${m.id} is loading`);
                return MM_GLUE.postModelAction(m.id, 'load')
                    .catch(err => { undoLoading(); throw err; });
            });
            sw.append(pr);
        }
        state.append(sw);
        const size = document.createElement('span');
        size.textContent = m.loaded ? (m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size))
                        : C.fmtBytes(m.estimated_size);
        size.className = 'usize';
        // lamps left; size + state pushed to the MM_GLUE.cell's right edge (with the
        // action box at 50% that reads as "centre of the card")
        const gap5 = document.createElement('span'); gap5.className = 'nrow-gap';
        head1.append(lamps, gap5, size, state);
        // badge is EXACTLY the FAVOURITE lamp's size (round 6: max-of-lamps
        // made long types like RERANKER wider). Measured after layout; the
        // label ellipsises inside the fixed box rather than widening it.
        // CARD-1: badge sits between the name and its copy icon — the row's
        // first line reads NAME · TYPE · COPY, lamps moved below.
        nmain.append(typeC, copyBtn(m.id, 'Copy model id'));
        name.append(nmain, head1);
        requestAnimationFrame(() => {
            const fav = lamps.querySelector('.lamp');
            if (fav) { const w = fav.getBoundingClientRect().width;
                if (w) { typeC.style.minWidth = w + 'px'; typeC.style.width = w + 'px'; } }
        });
        // right group: one shaded box, exactly 2 lines tall (user round
        // 2026-09-20): deletes leftmost, effective-setting chips in the
        // middle (folded when they genuinely don't fit), HIDE+EDIT rightmost
        const box = document.createElement('span');
        box.className = 'settings-box hrow';
        const s = m.settings || {};
        // Show only settings that are EFFECTIVE — a set value, or a toggle ON.
        // Inherited/OFF rows were noise. Chips that exceed the box fold behind
        // a measured "and X more" pill (never shown when everything fits).
        const chips = foldHost(2);
        const bits = [];
        const val = (label, v) => { if (v === null || v === undefined) return;
            bits.push({ txt: label + ' ' + v, cls: '' }); };
        const tog = (label, on) => { if (!on) return;
            bits.push({ txt: label + ' ON', cls: 'on' }); };
        // MT-1: rows must not advertise settings the engine ignores — the
        // chip set follows the same type gate as the editor (a non-LLM
        // model row shows only HIDDEN, like classic badges only the type).
        // Guarded like mmchips' masterOff: render must never crash when
        // modelspec is not loaded in a host (test sandbox).
        const llmRow = window.UpliftModelSpec
            ? window.UpliftModelSpec.llmLike(m) : true;
        if (llmRow) {
            val('CTX', s.max_context_window);
            val('MAX', s.max_tokens);
            tog('THINK', !!s.enable_thinking);
            tog('MTP', !!(s.mtp_enabled || s.vlm_mtp_enabled));
            tog('GRAMMAR', !!s.guided_grammar_enabled);
            if (s.trust_remote_code) bits.push({ txt: 'TRC ON', cls: 'danger' });
            tog('SPECPREFILL', !!s.specprefill_enabled);
            tog('DFLASH', !!s.dflash_enabled);
        }
        if (m.is_hidden) bits.push({ txt: 'HIDDEN', cls: '' });
        appendChips(chips, bits);
        const btn = (label, fn, title, noRerender) => {
            const b = document.createElement('button');
            b.className = 'se-btn act';
            if (label.indexOf('DELETE') === 0) b.classList.add('danger');
            if (label === 'HIDE' || label === 'SHOW' || label === 'EDIT') b.classList.add('edit');
            b.textContent = label; b.title = title || label;
            b.onclick = async () => {
                b.disabled = true;    // no double-toggle while the write is in flight
                try { await fn(); } catch (err) {
                    console.error(`${label} failed:`, err);   // stack in devtools
                    MM_GLUE.toast(C.t('uplift.toast.action_failed', {action: label, msg: err.message})); b.disabled = false; return; }
                if (!noRerender) renderModelAdmin(true); else b.disabled = false;
            };
            return b;
        };
        // deletes: leftmost column, one per line; HIDE/EDIT: rightmost column
        const aDel = document.createElement('span'); aDel.className = 'act-col';
        const aEdit = document.createElement('span'); aEdit.className = 'act-col right';
        aDel.append(btn('DELETE SETTINGS', () => confirmDialog('Delete settings',
            `Remove the stored configuration of ${m.id}? The model stays on disk; its `
            + 'settings return to server defaults when saved again. This cannot be undone.',
            () => deleteStoredSettings(m.id), `Settings deleted: ${m.id}`),
            'Delete stored settings (model stays on disk)', true));
        aDel.append(btn('DELETE MODEL', () => confirmDialog('Delete model',
            `Delete ${m.id} from disk? A loaded instance is unloaded first, then the `
            + 'model directory and its stored settings are removed. This cannot be undone.',
            () => deleteModelFromDisk(m.id), `Deleted ${m.id}`), 'Delete model from disk'));
        aEdit.append(btn(m.is_hidden ? 'SHOW' : 'HIDE',
            () => flagWrite(m.id, { is_hidden: !m.is_hidden },
                () => MM_GLUE.putModelSettings(m.id, { is_hidden: !m.is_hidden })),
            m.is_hidden ? 'Unhide' : 'Hide from pickers'));
        aEdit.append(btn('EDIT', () => MMF.openEditor(m.id), 'Edit settings', true));
        box.append(aDel, chips, aEdit);
        row.append(name, box);
        mbox.append(row);
        const tree = aliasTree(m);       // aliases hang off the trunk below
        if (tree) mbox.append(tree);
        table.append(mbox);
    }
    if (missing.length) {
        const sep = MM_GLUE.cell(C.t('uplift.mm.missing_on_disk'));
        sep.className = 'sec-div';
        table.append(sep);
        for (const e of missing) {
            const mbox = document.createElement('div'); mbox.className = 'mbox missing';
            const row = document.createElement('div'); row.className = 'urow admin';
            row.dataset.mid = e.id;
            const name = document.createElement('span'); name.className = 'uname';
            const head1 = document.createElement('span'); head1.className = 'nrow1';
            const nmain = document.createElement('span'); nmain.className = 'nmain';
            const uid = MM_GLUE.cell(e.id); uid.className = 'uid';
            // CARD-1: name first; missing rows have no type badge to place
            // between the name and its copy icon.
            nmain.append(uid, copyBtn(e.id, 'Copy model id'));
            const st = document.createElement('span');
            st.textContent = orphan.has(e.id) ? 'MISSING' : 'EXTERNAL';
            st.className = orphan.has(e.id) ? 'spill miss' : 'dim umeta';  // caution amber
            // round 9 (user 2026-09-21): state label belongs in the RIGHT
            // box, aligned with DELETE SETTINGS — not at the right edge of
            // the left half (round 8 guess). It rides above the acts column
            // so both share the exact same left x.
            if (e.alias) {
                const al = document.createElement('button');
                al.className = 'lamp alias-lamp on'; al.textContent = 'ALIAS:' + e.alias;
                al.title = 'API name "' + e.alias + '" — click to copy';
                tapBtn(al, () => copyText(e.alias));
                head1.append(al, copyBtn(e.alias, 'Copy alias "' + e.alias + '"'));
            }
            const gap = document.createElement('span'); gap.className = 'nrow-gap';
            head1.append(gap);
            // CARD-1: same line order as present rows — name leads, lamp/alias
            // line below (missing rows have no type badge to place).
            name.append(nmain, head1);
            const box = document.createElement('span');
            box.className = 'settings-box hrow solo';   // solo: no chips — centre the acts column
            const acts = document.createElement('span'); acts.className = 'act-col';
            acts.append(st);                            // state above DELETE, same left x
            const ds = document.createElement('button');
            ds.className = 'se-btn act danger'; ds.textContent = 'DELETE SETTINGS';
            ds.title = C.tf('uplift.ui.delete_stored_settings_for_this_missing_model', 'Delete stored settings for this missing model');
            ds.onclick = () => confirmDialog('Delete settings',
                `Remove stored configuration for ${e.id}? The model is not on disk; `
                + 'its settings record is deleted. This cannot be undone.',
                async () => { await deleteStoredSettings(e.id); },
                `Deleted settings for ${e.id}`);
            acts.append(ds);
            const aEdit = document.createElement('span'); aEdit.className = 'act-col right';
            const ed = document.createElement('button');
            ed.className = 'se-btn act edit'; ed.textContent = 'EDIT';
            ed.title = C.tf('uplift.ui.edit_stored_settings_missing',
                'Edit the stored settings (the model is not on disk; nothing reloads)');
            ed.onclick = () => MMF.openEditor(e.id);
            aEdit.append(ed);
            box.append(acts, document.createElement('span'), aEdit);
            row.append(name, box);
            mbox.append(row);
            // stored profiles of a missing base model: same fold box, EDIT
            // opens them in the editor (round 4: missing settings editable)
            const profs = (idx.profiles || []).filter(p => p.base === e.id);
            if (profs.length) {
                const tree = document.createElement('div'); tree.className = 'alias-tree';
                for (const p of profs) {
                    const l = document.createElement('div');
                    l.className = 'alias-line dim-line';
                    const lab = document.createElement('span'); lab.className = 'alias-lab';
                    const pre = document.createElement('span');
                    pre.className = 'alias-name dim'; pre.textContent = e.id + ':';
                    const mk = MM_GLUE.cell(p.display_name || p.name); mk.className = 'alias-name';
                    const edit = document.createElement('button');
                    edit.type = 'button'; edit.className = 'se-btn act edit alias-edit';
                    edit.textContent = 'EDIT';
                    edit.title = C.tf('uplift.ui.edit_profile', 'Edit this profile');
                    edit.onclick = (ev) => { ev.stopPropagation(); MMF.openEditor(e.id, p.name); };
                    const copyT = e.id + ':' + (p.display_name || p.name);   // friendly, not slug
                    lab.append(pre, mk, copyBtn(copyT, 'Copy "' + copyT + '"'), labBreak(), edit);
                    l.append(lab, foldHost(2));
                    tree.append(l);
                }
                mbox.append(tree);
            }
            table.append(mbox);
        }
    }
    scheduleAlign();   // profile chips line up with the base box (rAF)
}

/* shared informed-confirmation modal; runs act() on confirm, then refreshes */
function confirmDialog(title, msg, act, okMsg) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3'); h.textContent = title;
    const sub = document.createElement('div'); sub.className = 'se-hint';
    sub.textContent = msg;
    const bar = document.createElement('div'); bar.className = 'row buttons';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    cancel.onclick = () => overlay.remove();
    const ok = document.createElement('button');
    ok.className = 'danger'; ok.textContent = 'Confirm';
    ok.onclick = async () => {
        ok.disabled = true; cancel.disabled = true;
        try {
            await act(); MM_GLUE.toast(okMsg || title); overlay.remove();
            if (MMF.seModel) MMF.closeEditor();
            renderModelAdmin(true);
        }
        catch (err) { ok.disabled = false; cancel.disabled = false; MM_GLUE.toast(C.t('uplift.toast.failed', {msg: err.message})); }
    };
    bar.append(document.createElement('span'), cancel, ok);
    box.append(h, sub, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    // Escape is handled by the global modal handler (uplift_state.js). The
    // z-order rules keep this 80 above the 70 editor it may sit on; equal-z
    // dialogs resolve by DOM order (see that handler).
    document.body.append(overlay);
    ok.focus();
}


/* ---- request-history search (RL-3): extracted to uplift_reqsearch.js
   (PH2-1 stage 4); reached from the feed through window.Uplift.reqSearch. ---- */

/* RL-2 request inspector: extracted to uplift_inspector.js (SPLIT-2
   stage 1); still re-exported below on window.Uplift.modelmgr. */


window.Uplift.mmTable = {
    render: renderModelAdmin,
    confirmDialog: confirmDialog,
};
})();
