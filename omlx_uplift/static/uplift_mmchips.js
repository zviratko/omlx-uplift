/* SPLIT-2 stage 2 (uplift_modelmgr.js split): cockpit row controls —
   lamp/rocker tap handler, clipboard fallback, alias-tree lines and row
   chips, profile fold/align machinery, and the two DELETE ops. Self-
   contained except two late-bound calls back into the modelmgr facade
   (MMF getters resolve at click time, long after load). Loads after
   uplift_charts.js (CH for the resize handler) and BEFORE
   uplift_modelmgr.js. Exports window.Uplift.mmChips. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const $ = D.$;
const API = window.Uplift.state.API;
const CH = window.Uplift.charts;
const MM_GLUE = { toast: D.toast, fetchJson: D.fetchJson, cell: D.cell };
/* Late-bound facade: uplift_modelmgr.js defines window.Uplift.modelmgr
   AFTER this file loads; every MMF read happens at user-interaction time. */
const MMF = {
    get render() { return (...a) => window.Uplift.modelmgr.render(...a); },
    get openEditor() { return (...a) => window.Uplift.modelmgr.openEditor(...a); },
};
/* Cockpit row controls: lamp/rocker tap handler, clipboard fallback, alias
   tree lines, DELETE cover. "Reset settings" is gone — DELETE > SETTINGS
   (drops the record; behaviour returns to server defaults) covers it. */
function tapBtn(b, fn, noRerender) {
    b.onclick = async () => {
        b.disabled = true;    // no double-toggle while the write is in flight
        try { await fn(); } catch (err) {
            MM_GLUE.toast(C.t('uplift.toast.action_failed', {action: b.textContent || 'action', msg: err.message}));
            b.disabled = false; return;
        }
        if (!noRerender) MMF.render(true); else b.disabled = false;
    };
}
function copyText(t) {   // plain-http LAN origins lack navigator.clipboard
    if (navigator.clipboard && window.isSecureContext)
        return navigator.clipboard.writeText(t);
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
}
/* Properties of an alias/exposed profile that diverge from the model's own
   settings — rendered as indicator chips next to the alias tree line. */
/* cached per-model profile lists for the row alias tree (30 s TTL; editor
   writes invalidate immediately) */
const profilesCache = {};
function aliasDiffChips(prof, base) {
    const SHORT = { temperature: 'TEMP', top_p: 'TOP_P', top_k: 'TOP_K',
        max_tokens: 'MAX', max_context_window: 'CTX', enable_thinking: 'THINK',
        reasoning_effort: 'R', ttl_seconds: 'TTL', trust_remote_code: 'TRC' };
    // sub-settings that only take effect while their master switch is ON
    const GATED = {
        dflash: ['dflash_draft_model', 'dflash_draft_quant_enabled',
            'dflash_draft_quant_weight_bits', 'dflash_draft_quant_activation_bits',
            'dflash_draft_quant_group_size', 'dflash_max_ctx',
            'dflash_in_memory_cache', 'dflash_in_memory_cache_max_entries',
            'dflash_in_memory_cache_max_bytes'],
        specprefill: ['specprefill_draft_model', 'specprefill_num_draft_tokens'],
        mtp: ['mtp_adaptive_max_depth', 'mtp_fixed_depth'],
        vlm_mtp: ['vlm_mtp_draft_model', 'vlm_mtp_draft_block_size'],
    };
    const out = [];
    const b = base || {};
    const p = prof || {};
    const on = (key) => !!(p[key] !== undefined ? p[key] : b[key]);
    const enabled = {
        dflash: on('dflash_enabled'), specprefill: on('specprefill_enabled'),
        mtp: on('mtp_enabled') || on('vlm_mtp_enabled'),
        vlm_mtp: on('vlm_mtp_enabled'),
    };
    for (const [k, v] of Object.entries(p)) {
        if (v === null || v === undefined || v === false) continue;
        if (b[k] === v) continue;
        if (k === 'chat_template_kwargs' || k === 'forced_ct_kwargs') {
            out.push('CT_KWARGS');       // round 4: no "[object Object]" chips
            continue;
        }
        let gate = null;
        for (const [g, keys] of Object.entries(GATED))
            if (keys.includes(k) || k.startsWith(g + '_') && k !== g + '_enabled')
                gate = g;
        if (gate && !enabled[gate]) continue;   // master switch off: not effective
        const label = SHORT[k] || k.toUpperCase();
        out.push(label + (v === true ? '' : ' ' + v));
    }
    return out;
}
// ---------------------------------------------------------------------------
// Chip folding: chips live in a .chip-host box; when the host would wrap
// past the allowed number of rows, the tail is hidden and an "and X more"
// pill appears. The decision is MEASURED after layout (user 2026-09-20: a
// fixed cut-off showed the pill even when everything fit). Expanding unhides
// in place; the host grows vertically, never sideways. Re-measured on child
// changes (async profile lines), resize and tab show.
// ---------------------------------------------------------------------------

const foldSet = new Set();
let foldPending = null;

function scheduleFold(host) {
    if (!foldPending) {
        foldPending = new Set();
        requestAnimationFrame(() => {
            const hosts = foldPending; foldPending = null;
            for (const h of hosts) runFold(h);
        });
    }
    foldPending.add(host);
}
function foldAll() {
    for (const h of [...foldSet]) {
        if (!h.isConnected) { foldSet.delete(h); continue; }
        scheduleFold(h);
    }
}
window.addEventListener('resize', () => { foldAll(); scheduleAlign(); CH.renderCardTsRows(); });

// ---------------------------------------------------------------------------
// Profile-line column alignment: the diff chips of a profile/alias line must
// start at the SAME x as the first setting chip of the base model's right
// box (user 2026-09-20: "the leftmost profile setting aligned horizontally
// with the leftmost setting of the base model's right box"). The offset is
// not a constant — it depends on the DELETE SETTINGS button width, which
// follows the UI language, and on the window width — so MEASURE it and pin
// the label column to the resulting flex-basis.
// ---------------------------------------------------------------------------
let alignPending = false;
function scheduleAlign() {
    if (alignPending) return;
    alignPending = true;
    requestAnimationFrame(() => { alignPending = false; alignProfileRows(); });
}
function alignProfileRows() {
    let foldsDirty = false;
    for (const mbox of document.querySelectorAll('#model-admin .mbox')) {
        const lines = mbox.querySelectorAll(':scope > .alias-tree .alias-line, :scope > .prof-lines .alias-line');
        if (!lines.length) continue;
        const box = mbox.querySelector('.urow.admin .settings-box');
        if (!box) continue;
        const host = box.querySelector('.chip-host');
        const firstChip = host && host.querySelector('.schip:not(.more)');
        let targetX;
        if (firstChip) targetX = firstChip.getBoundingClientRect().left;
        else {   // no chips on the base row: align with its first button
            const b = box.querySelector('.se-btn');
            if (!b) continue;
            targetX = b.getBoundingClientRect().left;
        }
        for (const l of lines) {
            const lab = l.querySelector('.alias-lab');
            if (!lab) continue;
            lab.style.flex = '';                     // re-measure from free flow
            lab.style.maxWidth = '';
            const cs = getComputedStyle(l);
            const contentX = l.getBoundingClientRect().left
                + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
            const gap = parseFloat(cs.columnGap) || 0;
            const w = Math.round(targetX - gap - contentX);
            if (w > 60) { lab.style.flex = `0 0 ${w}px`;
                lab.style.maxWidth = 'none';         // the 42% cap fights the pin
                foldsDirty = true; }
        }
    }
    // pinned hosts changed width — their folds must re-measure (scheduleFold
    // batches in its own rAF, i.e. after the pin above is laid out)
    if (foldsDirty) for (const h of document.querySelectorAll(
            '#model-admin .alias-line .chip-host')) scheduleFold(h);
}

function foldHost(rows) {
    const host = document.createElement('span');
    host.className = 'chip-host';
    host.dataset.foldRows = String(rows);
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'schip more'; more.hidden = true;
    host.append(more);
    if (!foldSet.has(host)) {
        foldSet.add(host);
        new MutationObserver(() => scheduleFold(host))
            .observe(host, { childList: true });
    }
    more.onclick = (e) => {
        e.stopPropagation();
        host.dataset.open = host.dataset.open === '1' ? '0' : '1';
        scheduleFold(host);
    };
    return host;
}

function appendChips(host, bits) {
    const more = host.querySelector('.schip.more');
    for (const b of bits) {
        const chip = document.createElement('span');
        chip.className = 'schip ' + (b.cls || ''); chip.textContent = b.txt;
        host.insertBefore(chip, more);
    }
    scheduleFold(host);
}

function runFold(host) {
    if (!host.isConnected) { foldSet.delete(host); return; }
    const rows = +(host.dataset.foldRows || 2);
    const more = host.querySelector('.schip.more');
    const chips = [...host.querySelectorAll('.schip:not(.more)')];
    if (!chips.length) { more.hidden = true; return; }
    if (host.dataset.open === '1') {
        for (const c of chips) c.hidden = false;
        more.hidden = false;
        more.textContent = C.tf('uplift.ui.show_fewer', 'show fewer');
        more.title = C.tf('uplift.ui.collapse_settings', 'Collapse back');
        return;
    }
    for (const c of chips) c.hidden = false;
    more.hidden = true;
    const h1 = chips[0].offsetHeight;
    if (!h1) return;                     // not laid out yet (hidden tab):
                                        // refold fires on show/resize
    const gap = parseFloat(getComputedStyle(host).rowGap) || 0;
    const maxH = rows * h1 + (rows - 1) * gap + 2;
    if (host.scrollHeight <= maxH) {     // genuinely fits: no pill
        more.hidden = true;
        return;
    }
    // doesn't fit: the pill joins the measured flow, then hide the tail
    more.hidden = false;
    let n = 0;
    while (host.scrollHeight > maxH && n < chips.length - 1) {
        chips[chips.length - 1 - n++].hidden = true;
    }
    // round 8 item 1: if the loop hid nothing (a single long chip plus the
    // pill alone overflow), there is nothing to expand — kill the empty
    // dotted box instead of showing "and 0 more"
    if (!n) { more.hidden = true; return; }
    more.textContent = C.tf('uplift.ui.and_n_more', 'and {n} more', { n });
    more.title = C.tf('uplift.ui.expand_all_settings', 'Expand to show all settings');
}

function labBreak() {   // forces a line break inside .alias-lab (EDIT goes below)
    const b = document.createElement('span'); b.style.flex = '1 0 100%'; return b;
}
function copyBtn(textToCopy, title) {
    const b = document.createElement('button');
    b.className = 'copybtn'; b.textContent = '\u29c9'; b.title = title;
    b.onclick = async (e) => {
        e.stopPropagation();
        await copyText(textToCopy);
        b.textContent = '\u2713'; b.disabled = true;
        setTimeout(() => { b.textContent = '\u29c9'; b.disabled = false; }, 1200);
    };
    return b;
}
/* Aliases branch off the model on a visible trunk line: an .alias-tree box
   hanging below the main row inside the same model box. */
function aliasTree(m) {
    const lines = [];
    const line = (alias, chips, tip, profileName) => {
        const l = document.createElement('div'); l.className = 'alias-line';
        // left block: alias name + copy, EDIT button BELOW the name (user
        // round 2026-09-20 mock-up). Chips never sit under the name: they go
        // into a right-aligned box that keeps 2 rows until "and X more".
        const lab = document.createElement('span'); lab.className = 'alias-lab';
        const mk = MM_GLUE.cell(alias); mk.className = 'alias-name';
        mk.title = tip || ('Serves this model on the API under the name "' + alias + '"');
        const edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'se-btn act edit alias-edit';
        edit.textContent = 'EDIT';
        edit.title = profileName ? C.tf('uplift.ui.edit_profile', 'Edit this profile')
                                 : 'Edit settings';
        edit.onclick = (e) => { e.stopPropagation(); MMF.openEditor(m.id, profileName); };
        // profiles copy as "mainModel:profileName" using the FRIENDLY name
        // (what you actually serve), not the stored slug (round 5); profiles
        // also show "modelName:profileName", model part dim, profile part ink
        let lab0;
        if (profileName) {
            lab0 = document.createElement('span'); lab0.className = 'alias-name dim';
            lab0.textContent = m.id + ':';
            mk.textContent = alias;         // friendly name keeps its own span
        } else lab0 = null;
        const copyTarget = profileName ? m.id + ':' + alias : alias;
        if (lab0) lab.append(lab0, mk); else lab.append(mk);
        lab.append(copyBtn(copyTarget, 'Copy "' + copyTarget + '"'), labBreak(), edit);
        const host = foldHost(2);
        host.classList.add('alias-chips');
        appendChips(host, chips.map(t => ({ txt: t, cls: '' })));
        l.append(lab, host);
        lines.push(l);
    };
    // the base model_alias is NOT listed here (round 4): an alias is not a
    // profile — it shows as an ALIAS lamp next to FAVOURITE/PINNED/DEFAULT
    for (const p of (m.exposed_profiles || []))
        line(p.api_name || p.name, aliasDiffChips(p.settings, m.settings),
             'Serves this model on the API under the name "' + (p.api_name || p.name) + '"',
             p.name);
    // stored (not-yet-exposed) profiles: dim chips so they are not invisible.
    // Cached briefly; invalidated whenever the editor writes a profile.
    const profHost = document.createElement('div');
    profHost.className = 'prof-lines';
    profHost.dataset.mid = m.id;
    const renderProfiles = (profs) => {
        for (const p of profs) {
            if ((m.exposed_profiles || []).some(e => e.name === p.name)) continue;
            const l = document.createElement('div'); l.className = 'alias-line dim-line';
            const lab = document.createElement('span'); lab.className = 'alias-lab';
            const pre = document.createElement('span');
            pre.className = 'alias-name dim'; pre.textContent = m.id + ':';
            const mk = MM_GLUE.cell(p.display_name || p.name); mk.className = 'alias-name';
            mk.title = 'Stored profile — expose it as an API model from the editor to serve requests under its name';
            const edit = document.createElement('button');
            edit.type = 'button'; edit.className = 'se-btn act edit alias-edit';
            edit.textContent = 'EDIT';
            edit.title = C.tf('uplift.ui.edit_profile', 'Edit this profile');
            edit.onclick = (e) => { e.stopPropagation(); MMF.openEditor(m.id, p.name); };
            const copyT = m.id + ':' + (p.display_name || p.name);   // friendly, not slug
            lab.append(pre, mk, copyBtn(copyT, 'Copy "' + copyT + '"'), labBreak(), edit);
            const host = foldHost(2);
            host.classList.add('alias-chips');
            appendChips(host, aliasDiffChips(p.settings, m.settings).map(t => ({ txt: t, cls: '' })));
            l.append(lab, host);
            profHost.append(l);
        }
        if (!profHost.children.length) profHost.remove();
    };
    const c = profilesCache[m.id];
    if (c && Date.now() - c.t < 30000) { renderProfiles(c.profs); scheduleAlign(); }
    else MM_GLUE.fetchJson(`${API}/uplift/api/models/${encodeURIComponent(m.id)}/profiles`)
        .then(d => { profilesCache[m.id] = { t: Date.now(), profs: d.profiles || [] };
                     renderProfiles(d.profiles || []); scheduleAlign(); })
        .catch(() => profHost.remove());
    if (!lines.length) {
        // no aliases yet: the tree box appears only once profiles resolve
        const t = document.createElement('div'); t.className = 'alias-tree';
        t.append(profHost); t.hidden = true;
        profHost.dataset.needsShow = '1';
        const obs = new MutationObserver(() => {
            if (profHost.children.length) { t.hidden = false; obs.disconnect(); }
        });
        obs.observe(profHost, { childList: true });
        return t;
    }
    const t = document.createElement('div'); t.className = 'alias-tree';
    lines.forEach(l => t.append(l));
    t.append(profHost);
    return t;
}

async function deleteStoredSettings(model) {
    return S.trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`,
            { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail ? JSON.stringify(body.detail) : 'http ' + res.status);
        return body;
    });
}
async function deleteModelFromDisk(model) {
    return S.trackWrite(async () => {
        const res = await fetch(`${API}/admin/api/hf/models/${encodeURIComponent(model)}`,
            { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || 'http ' + res.status);
        return body;
    });
}

window.Uplift.mmChips = {
    tapBtn, copyText, copyBtn, labBreak, appendChips, aliasTree, aliasDiffChips,
    foldHost, scheduleFold, scheduleAlign,
    clearProfileCache: function (mid) { delete profilesCache[mid]; },
    deleteStoredSettings, deleteModelFromDisk,
};
})();
