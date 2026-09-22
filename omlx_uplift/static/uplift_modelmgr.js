/* Uplift MODEL MANAGER (PH2-1 stage 5 extraction from uplift.js): Models
   tab — spec-driven settings editor (profiles, templates, kwargs, grammar
   parsers), the sortable model table with row chips, and the request
   inspector (RL-2). Plain script; loads AFTER uplift_state.js and
   uplift_charts.js, BEFORE uplift.js, which late-binds helpers via
   window.Uplift._modelGlue (hoisted declarations / live getters — resolved
   at call time). Exports window.Uplift.modelmgr; applyTab, the prune dialog
   and the helper page consume it. */
(function () {
'use strict';
const C = window.UpliftCore;
const S = window.Uplift.state;
const $ = id => document.getElementById(id);
const API = S.API;
const CH = window.Uplift.charts;
const prefs = S.prefs;
const MM_GLUE = {
    get toast() { return window.Uplift._modelGlue.toast; },
    get fetchJson() { return window.Uplift._modelGlue.fetchJson; },
    get stats() { return window.Uplift._modelGlue.stats; },
    get SECRET_KEYS() { return window.Uplift._modelGlue.SECRET_KEYS; },
    get gsDisplay() { return window.Uplift._modelGlue.gsDisplay; },
    get cell() { return window.Uplift._modelGlue.cell; },
    get putModelSettings() { return window.Uplift._modelGlue.putModelSettings; },
    get postModelAction() { return window.Uplift._modelGlue.postModelAction; },
    get emptyMsg() { return window.Uplift._modelGlue.emptyMsg; },
};
/* ---------------- model manager (Models tab) ---------------- */
/* S.settingsIdx lives in window.Uplift.state: the stored-settings page in
   uplift.js refreshes it after writes (PH2-1 stage 5). Survives adminModels
   refreshes while the editor is open. */
let seModel = null, seValues = {};   // seValues = live form state (modelspec shape)
let seWantProfile = null;            // openEditor(model, name): land on this profile's tab
let GRAMMAR_PARSERS = null;          // R10-7: cached /admin/api/grammar/parsers payload
async function loadGrammarParsers() {
    if (GRAMMAR_PARSERS) return;
    try {
        const d = await MM_GLUE.fetchJson(`${API}/admin/api/grammar/parsers`);
        if (Array.isArray(d)) GRAMMAR_PARSERS = d;
    } catch (_) { /* offline/upstream missing: fall back to model-reported list */ }
}
let seOrig = {};                     // baseline snapshot for dirty tracking
/* Fields that only take effect when the engine is (re)built: changing one
   of these on a LOADED model shows RESTART MODEL in the editor Save button
   (server semantics: PUT replies requires_reload for exactly these). */
const SE_RESTART_KEYS = new Set([
    'model_type_override', 'index_cache_freq', 'dflash_enabled',
    'dflash_draft_model', 'dflash_draft_quant_enabled',
    'dflash_draft_quant_weight_bits', 'dflash_draft_quant_activation_bits',
    'dflash_draft_quant_group_size', 'dflash_max_ctx', 'dflash_in_memory_cache',
    'dflash_in_memory_cache_max_entries', 'dflash_in_memory_cache_max_bytes',
    'dflash_ssd_cache', 'dflash_ssd_cache_max_bytes', 'trust_remote_code',
    'mtp_enabled', 'mtp_num_draft_tokens',
    'vlm_mtp_enabled', 'vlm_mtp_draft_model',
    'vlm_mtp_draft_block_size']);
function seDirtyKeys() {                     // dirty keys of the ACTIVE tab
    const t = seTab();
    return t ? [...t.dirty] : [];
}
function seNeedsRestart() {
    return seDirtyKeys().some(k => SE_RESTART_KEYS.has(k));
}
function seUpdateSaveBtn() {
    const b = document.getElementById('se-save'); if (!b) return;
    const n = seDirtyKeys().length;
    const restart = seNeedsRestart() && isBaseTabActive() &&
        !!(seFormModel && (seFormModel.loaded || seFormModel.is_loading));
    function isBaseTabActive() { return seIsBaseTab(); }
    b.classList.toggle('queued', n > 0);
    b.classList.toggle('restart-mode', restart);
    const tabTxt = seIsBaseTab() ? '' : ' PROFILE';
    b.textContent = n ? (restart ? '▶ RESTART MODEL (' + n + ')'
                                 : 'SAVE' + tabTxt + ' (' + n + ')')
                      : (seIsBaseTab() ? 'SAVE' : 'SAVE PROFILE');
    b.title = restart
        ? C.t('uplift.se.restart_title') : '';
    renderEdChanges();
}
/* CHANGES box above the editor buttons: yaml-style key: old -> key: new,
   including inherit flips for profile tabs and the expose/api lines */
function renderEdChanges() {
    const box = document.getElementById('se-changes'); if (!box) return;
    const t = seTab();
    const lines = [];
    const shown = new Set();
    if (seIsBaseTab()) {
        for (const k of t.dirty) {
            const sec = MM_GLUE.SECRET_KEYS.has(k) ? '••• CHANGED' : null;
            lines.push(k + ': ' + (sec || MM_GLUE.gsDisplay(seOrig[k])) + ' → ' +
                       k + ': ' + (sec || MM_GLUE.gsDisplay(seValues[k])));
            shown.add(k);
        }
    } else {
        for (const k of t.dirty) {
            const sec = MM_GLUE.SECRET_KEYS.has(k) ? '••• CHANGED' : null;
            const o = SE_INHERIT_KEYS.has(k) ? seOvSnap(t)[k] : t.origVals[k];
            lines.push(k + ': ' + (sec || MM_GLUE.gsDisplay(o)) + ' \u2192 ' +
                       k + ': ' + (sec || MM_GLUE.gsDisplay(seValues[k])));
            shown.add(k);
        }
    }
    // edited-back fields whose diff lives only in widgets: drop from box too
    for (const el of document.querySelectorAll('#se-fields .diff-out')) {
        const key = el.closest('label.se-row')?.dataset.key;
        if (!key || shown.has(key)) continue;
    }
    if (!seIsBaseTab()) {
        if ((t._origExpose || false) !== !!t.expose_as_model)
            lines.unshift('expose_as_model: ' + MM_GLUE.gsDisplay(!!t._origExpose) +
                          ' → expose_as_model: ' + MM_GLUE.gsDisplay(!!t.expose_as_model));
        if ((t._origApi || '') !== (t.api_name || ''))
            lines.unshift('api_name: ' + MM_GLUE.gsDisplay(t._origApi) +
                          ' → api_name: ' + MM_GLUE.gsDisplay(t.api_name));
    }
    box.hidden = !lines.length;
    box.textContent = '';
    if (!lines.length) return;
    const head = document.createElement('div'); head.className = 'ch-head';
    head.textContent = C.tf('uplift.ui.changes', 'CHANGES (') + lines.length + ')';
    box.append(head);
    for (const ln of lines) {
        const d = document.createElement('div'); d.className = 'ch-line';
        d.textContent = ln;
        box.append(d);
    }
}

/* ---- spec-driven settings form (parity with classic _modal_model_settings) ---- */
/* seValues holds the modelspec form state (UpliftModelSpec.buildState shape).
   Widgets write straight into seValues and re-run renderEditorFields() so the
   same conditional visibility the classic modal uses (x-show rules) applies. */
let seFormModel = null;      // the /admin/api/models entry this editor is for

/* ---- editor profile tabs -------------------------------------------------
   The editor edits a STACK of targets: the Base model settings plus one tab
   per model profile. Profile tabs hold sparse overrides: keys absent from a
   profile are INHERITED from the base at request time (server does exactly
   this: merged = base.to_dict(); merged.update(profile.settings)). The UI
   mirrors that — an empty input shows the base value as placeholder
   "value (inherited)", a filled input is an override. Only overrides are
   persisted, so changing the base never needs manual syncing. */
let seTabs = [];            // [{id:'base',dirty:Set}|{id,name,display_name,
                            //   expose_as_model,api_name,overrides:{},base?,
                            //   template?,dirty:Set}]
let seActiveTab = 'base';
let seBaseVals = null;      // base modelspec-shape state (source of inherit display)
/* Sampling keys are inheritable on profile tabs (empty = follow base). */
const SE_INHERIT_KEYS = new Set(['temperature', 'top_p', 'top_k',
    'repetition_penalty', 'min_p', 'presence_penalty']);
function seOvSnap(t) {                       // frozen stored-override snapshot
    if (!t._ovSnap) t._ovSnap = JSON.parse(JSON.stringify(t.overrides || {}));
    return t._ovSnap;
}
function seInitSnap(t) { t._ovSnap = JSON.parse(JSON.stringify(t.overrides || {})); return t; }
function seTab() { return seTabs.find(t => t.id === seActiveTab) || seTabs[0]; }
function seIsBaseTab() { return seTab().id === 'base'; }

function seBind(kind, key, opts) {
    /* one labeled field bound to seValues[key]; matches classic addRow() but
       writes the modelspec state shape and supports selects/options/text */
    const label = document.createElement('label');
    label.className = 'se-row';
    const name = document.createElement('span');
    // localize by field key; the passed literal is the English fallback
    name.textContent = C.tf('uplift.se.' + key, opts && opts.label ? opts.label : key);
    let input;
    if (kind === 'select') {
        input = document.createElement('select');
        for (const o of (opts.options || [])) {
            const el = document.createElement('option');
            el.value = o.value;
            el.textContent = C.tf('uplift.se.' + key + '.opt.' + o.value,
                                   o.label != null ? o.label : o.value);
            if (String(seValues[key]) === String(o.value)) el.selected = true;
            input.append(el);
        }
        if (opts.picker) {              // draft-model picker: selected value may not be in pool
            const cur = seValues[key];
            if (cur && ![...input.options].some(el => el.value === cur)) {
                const el = document.createElement('option');
                el.value = cur; el.textContent = cur + ' (current)'; el.selected = true;
                input.prepend(el);
            }
        }
    } else if (kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = seValues[key] === true;
    } else if (kind === 'text') {
        input = document.createElement('input');
        input.type = 'text';
        input.value = seValues[key] == null ? '' : seValues[key];
    } else if (kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = seValues[key] == null ? '' : seValues[key];
    } else if (kind === 'inheritable-number') {
        // profile-tab number: value comes from the tab's OVERRIDES only;
        // empty = inherit, placeholder shows the base value
        kind = 'number';
        input = document.createElement('input');
        input.type = 'number';
        const bv = seBaseVals ? seBaseVals[key] : undefined;
        if (opts && opts.min != null) input.min = opts.min;
        if (opts && opts.max != null) input.max = opts.max;
        if (opts && opts.step != null) input.step = opts.step;
        const cur = seTab() && seTab().overrides[key];
        input.value = cur == null || cur === '' ? '' : cur;
        // U3: never a blind empty — base value, else the server's own default
        if (bv != null) input.placeholder = String(bv) + ' (inherited)';
        else input.placeholder = (opts && opts.effHint) || '(default)';
    } else if (kind === 'inheritable-text') {
        kind = 'text';
        input = document.createElement('input');
        input.type = 'text';
        const bv = seBaseVals ? seBaseVals[key] : undefined;
        const cur = seTab() && seTab().overrides[key];
        input.value = cur == null ? '' : cur;
        if (bv != null && bv !== '') input.placeholder = String(bv) + ' (inherited)';
        else input.placeholder = (opts && opts.effHint) || '(default)';
    } else if (kind === 'inheritable-bool') {
        // three-state: override-on / override-off / inherit (empty)
        input = document.createElement('select');
        const cur = seTab() && seTab().overrides[key];
        const on = document.createElement('option');
        on.value = 'true';  on.textContent = 'Yes (override)';
        const off = document.createElement('option');
        off.value = 'false'; off.textContent = 'No (override)';
        const inh = document.createElement('option');
        const bv = seBaseVals ? seBaseVals[key] : undefined;
        inh.value = ''; inh.textContent = 'Inherited: ' + (bv === true ? 'Yes' : bv === false ? 'No' : '—');
        input.append(inh, on, off);
        input.value = cur === true || cur === 'true' ? 'true' : cur === false || cur === 'false' ? 'false' : '';
    } else {
        input = document.createElement('input');
        input.type = 'number';
        if (opts) { if (opts.min != null) input.min = opts.min;
                    if (opts.max != null) input.max = opts.max;
                    if (opts.step != null) input.step = opts.step; }
        const cur = seValues[key];
        input.value = (cur === null || cur === undefined) ? '' : cur;
        // U3: an empty number is NOT zero — the server falls back to the
        // model's own default (generation_config.json / builtin). We do not
        // read those files, so say so honestly instead of showing nothing.
        if (input.value === '') input.placeholder = (opts && opts.effHint) || '(default)';
    }
    if (opts && opts.disabled) input.disabled = true;
    const evt = (kind === 'textarea' || kind === 'text' || kind === 'number') ? 'input' : 'change';
    input.addEventListener(evt, () => {
        const t = seTab();
        if (kind === 'bool') seValues[key] = input.checked;
        else if (kind === 'number') {
            // inheritable numbers keep "" = inherit (undefined), otherwise value
            if (input.value === '') seValues[key] = (t && t.id !== 'base') ? undefined : null;
            else seValues[key] = Number(input.value);
        }
        else if (kind === 'select') seValues[key] = input.value;
        else seValues[key] = input.value;
        // inherited-bool tri-state maps '' -> undefined (inherit)
        if (input.tagName === 'SELECT' && input.dataset.inherit === '1')
            seValues[key] = input.value === '' ? undefined : input.value === 'true';
        // keep the tab override map live so re-renders show typed values
        if (t && t.id !== 'base') {
            if (seValues[key] === undefined) delete t.overrides[key];
            else t.overrides[key] = seValues[key];
        }
        // dirty marking against the tab's ORIGINAL baseline (for inheritable
        // profile fields the original is the STORED override, possibly absent)
        const lab2 = input.closest('label.se-row');
        if (lab2) {
            const orig = (t && t.id !== 'base' && SE_INHERIT_KEYS.has(key))
                ? seOvSnap(t)[key]
                : (t && t.origVals ? t.origVals[key] : seOrig[key]);
            const changed = JSON.stringify(seValues[key]) !== JSON.stringify(orig);
            if (changed) t && t.dirty.add(key); else t && t.dirty.delete(key);
            lab2.classList.toggle('dirty', changed);
            lab2.classList.toggle('restartq', changed && SE_RESTART_KEYS.has(key));
            const rd = lab2.querySelector('.diff-out');
            if (rd) {
                rd.hidden = !changed;
                if (changed && MM_GLUE.SECRET_KEYS.has(key)) {
                    // secret stays masked: only say that it changed
                    rd.classList.add('masked');
                    rd.querySelector('.diff-o').textContent = '••• CHANGED';
                } else if (changed) {
                    rd.classList.remove('masked');
                    rd.querySelector('.diff-o').textContent = MM_GLUE.gsDisplay(orig);
                }
            }
        }
        seUpdateSaveBtn();
        if (opts && opts.onChange) opts.onChange(seValues);
    });
    label.dataset.key = key;
    if (input.tagName === 'SELECT' && ['true','false',''].includes(input.value)
        && opts && opts.inherit) input.dataset.inherit = '1';
    const slot = document.createElement('span'); slot.className = 'se-slot';
    const rd = document.createElement('span'); rd.className = 'diff-out'; rd.hidden = true;
    const o = document.createElement('span'); o.className = 'diff-o';
    o.title = C.tf('uplift.ui.click_to_revert', 'Click to revert');
    o.onclick = (ev) => {
        ev.preventDefault();
        const t = seTab(); if (!t) return;
        const origV = (t.id !== 'base' && SE_INHERIT_KEYS.has(key))
            ? seOvSnap(t)[key]
            : ((t.origVals || seOrig)[key]);
        seValues[key] = origV === undefined ? (t.id !== 'base' ? undefined : seOrig[key]) : origV;
        t.dirty.delete(key);
        if (t.id !== 'base') {
            // revert an override back to inherit/original override
            if (origV === undefined) delete t.overrides[key];
            else t.overrides[key] = origV;
        }
        renderEditorFields(document.getElementById('se-fields'));
        seUpdateSaveBtn();
    };
    // the NEW value is the live input itself; the slot only carries the
    // |original| chip pointing at it, so the input never jumps
    rd.append(o, document.createTextNode('→'));
    slot.append(rd);
    const ctlBox = document.createElement('span'); ctlBox.className = 'se-ctl';
    ctlBox.append(input);
    label.append(name, slot, ctlBox);
    if (opts && opts.hint) {
        const h = document.createElement('small');
        h.className = 'se-hint';
        h.textContent = C.tf('uplift.se.' + key + '.hint', opts.hint);
        label.append(h);
    }
    return label;
}

function seSection(title) {
    // R10-5: sections read as framed boxes (same language as the settings
    // page gs-boxes / model list rows): inverted header strip, tinted body.
    const box = document.createElement('div');
    box.className = 'se-box';
    const h = document.createElement('h5');
    h.className = 'se-section';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    h.textContent = C.tf('uplift.se.section.' + slug, title);
    const body = document.createElement('div');
    body.className = 'se-box-body';
    box.append(h, body);
    box.__body = body;
    return box;
}

function renderEditorFields(container) {
    const S = window.UpliftModelSpec;
    const m = seFormModel || {};
    // profile tabs edit overrides-on-base; base tab edits the model itself
    const tab = seTab();
    if (tab && tab.id !== 'base' && seBaseVals) {
        const mergedState = Object.assign({}, seBaseVals,
            JSON.parse(JSON.stringify(tab.workVals || {})));
        seNormalizeKwargs(mergedState);   // R10-6: raw kwargs shape -> editor entries
        seValues = mergedState;
        seOrig = tab.origVals || Object.assign({}, seBaseVals);
    }
    container.textContent = '';
    let sect = null;
    // R10-5: sections are framed boxes; grid() appends into the open one.
    const section = (title) => { sect = seSection(title); container.append(sect); return sect.__body; };
    const grid = () => { const g = document.createElement('div'); g.className = 'pair';
        (sect ? sect.__body : container).append(g); return g; };
    // R10-14: a toggle's child controls go into an indented sub-block so
    // the parent/child relationship reads visually; nestable.
    const sub = (parent) => { const d = document.createElement('div');
        d.className = 'se-sub'; parent.append(d); return d; };

    /* ---- basic ---- */
    if (!seIsBaseTab()) {
        const ban = document.createElement('div'); ban.className = 'se-profile-banner';
        const t = seTab();
        const exp = document.createElement('label'); exp.className = 'se-prof-expose';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = !!t.expose_as_model;
        const lbl = document.createElement('span'); lbl.textContent = ' EXPOSE AS API MODEL ';
        cb.onchange = () => { t.expose_as_model = cb.checked; seUpdateSaveBtn(); };
        const api = document.createElement('input'); api.type = 'text';
        api.placeholder = 'api_name'; api.value = t.api_name || '';
        api.style.width = '180px';
        api.oninput = () => { t.api_name = api.value.trim(); seUpdateSaveBtn(); };
        exp.append(cb, lbl, api);
        ban.append(exp);
        if (t._new || !t.profileId) {
            const nmIn = document.createElement('input');
            nmIn.type = 'text'; nmIn.className = 'se-newname';
            nmIn.value = t.display_name || t.name || '';
            nmIn.style.width = '200px';
            nmIn.oninput = () => { t.name = nmIn.value.trim(); t.display_name = t.name;
                seUpdateSaveBtn();
                const strip = document.querySelector('.se-tabs');
                if (strip) seRenderTabs(document.querySelector('.modal.editor')); };
            exp.prepend(nmIn);
        }
        const hint = document.createElement('small'); hint.className = 'dim';
        hint.textContent = t.template
            ? 'Global template copy: applies to this model only when saved as a profile.'
            : 'Empty fields inherit the base model (shown greyed as "value (inherited)").';
        ban.append(hint);
        container.append(ban);
    }
    section('Sampling');
    let g = grid();
    if (seIsBaseTab() || !seTab().template)
        g.append(seBind('text', 'model_alias', { label: 'Display Name' }));
    g.append(seBind('select', 'model_type_override', {
        label: 'Model Type',
        options: [{ value: '', label: 'Auto-detect' },
                  ...S.MODEL_TYPE_OPTIONS.map(v => ({ value: v }))] }));
    const sampling = [
        ['temperature', 0, 2, 0.05, 'Temperature'], ['top_p', 0, 1, 0.05, 'Top P'],
        ['top_k', 0, null, 1, 'Top K'], ['repetition_penalty', 0.5, 2, 0.01, 'Repetition Penalty'],
        ['min_p', 0, 1, 0.01, 'Min P'], ['presence_penalty', -2, 2, 0.05, 'Presence Penalty']];
    const inheritOn = !seIsBaseTab();
    if (!S.isDiffusion(m)) for (const [k, mn, mx, st, lab] of sampling) {
        if (inheritOn) {
            g.append(seBind('inheritable-number', k, { label: lab, min: mn, max: mx, step: st }));
            continue;
        }
        g.append(seBind('number', k, { label: lab, min: mn, max: mx, step: st }));
    }
    g.append(seBind('bool', 'force_sampling', { label: 'Force Sampling',
        hint: 'Override request sampling parameters with configured values' }));

    /* ---- thinking & reasoning (R10-5 split out of Advanced) ---- */
    section('Thinking & Reasoning');
    g = grid();
    if (!S.isDiffusion(m)) {
        if (m.thinking_default !== undefined && m.thinking_default !== null || seValues.enable_thinking != null) {
            const tv = seValues.enable_thinking;
            g.append(seBind('select', 'enable_thinking', {
                label: C.tf('uplift.ui.enable_thinking', 'Enable Thinking'), disabled: !!m.thinking_forced,
                hint: 'Enable reasoning/thinking mode for this model.',
                options: [{ value: '', label: m.thinking_default === true
                               ? 'Using model default (on)' : 'Using model default (off)' },
                          { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }],
            }));
            // select needs string values; store real bool/null back
            const sel = g.lastChild.querySelector('select');
            sel.value = tv === true ? 'true' : tv === false ? 'false' : '';
            sel.addEventListener('change', () => {
                seValues.enable_thinking = sel.value === '' ? null : sel.value === 'true'; });
        }
        // NOTE: preserve_thinking has NO widget in the classic modal (it only
        // appears in the diffusion unsupported-field lists) — parity: none here.
        if (seValues.reasoning_parser !== undefined || m.reasoning_parsers) {
            // R10-7: classic fills this list from /admin/api/grammar/parsers
            // (xgrammar builtin registry); model-reported list is usually empty.
            const seen = new Set();
            const rp = [{ value: '', label: 'None' }];
            const add = (value, label) => {
                if (!value || seen.has(value)) return;
                seen.add(value); rp.push({ value, label: label != null ? label : value });
            };
            (GRAMMAR_PARSERS || []).forEach(p => add(p.value,
                p.label + (p.models && p.models.length ? ' (' + p.models.join(', ') + ')' : '')));
            (m.reasoning_parsers || []).forEach(v => add(v));
            add(seValues.reasoning_parser || '');
            g.append(seBind('select', 'reasoning_parser', { label: 'Reasoning Parser', options: rp }));
        }
        g.append(seBind('bool', 'enableThinkingBudget', { label: 'Thinking Budget',
            hint: 'Limit thinking tokens for reasoning models.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableThinkingBudget)
            sub(g).append(seBind('number', 'thinking_budget_tokens',
                { label: C.tf('uplift.ui.thinking_budget_tokens', 'Thinking budget (tokens)'), min: 1, step: 1 }));
        // cache_reasoning_output: tri-state (null = auto: cache when history
        // preserves <think>). Upstream #3525; classic modal has no widget —
        // additive, same keys as the API.
        {
            const cv = seValues.cache_reasoning_output;
            g.append(seBind('select', 'cache_reasoning_output', {
                label: C.tf('uplift.ui.cache_reasoning_output', 'Cache Reasoning Output'),
                hint: 'Cache <think> output for the next turn. Auto = only when history keeps it.',
                options: [{ value: '', label: 'Auto' },
                          { value: 'true', label: 'Always' },
                          { value: 'false', label: 'Never' }],
            }));
            const sel = g.lastChild.querySelector('select');
            sel.value = cv === true ? 'true' : cv === false ? 'false' : '';
            sel.addEventListener('change', () => {
                seValues.cache_reasoning_output =
                    sel.value === '' ? null : sel.value === 'true'; });
        }
        g.append(seBind('bool', 'enableToolResultLimit', { label: 'Limit Tool Result Tokens',
            hint: 'Truncate large tool results (e.g. file reads) to a token limit.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableToolResultLimit)
            sub(g).append(seBind('number', 'max_tool_result_tokens',
                { label: C.tf('uplift.ui.tool_result_token_limit', 'Tool result token limit'), min: 1, step: 1 }));
    }
    /* ---- grammar (R10-5: own section, wide mono textarea) ---- */
    section('Grammar');
    g = grid();
    if (!S.isDiffusion(m)) {
        const ggWrap = seBind('textarea', 'guided_grammar', {
            label: C.tf('uplift.ui.guided_grammar', 'Guided Grammar'),
            hint: 'EBNF / regex / JSON-schema grammar applied to generation when enabled.' });
        ggWrap.classList.add('se-wide');
        const ggInp = ggWrap.querySelector('textarea');
        // U2: EBNF in a 3-row box is unworkable — EXPAND opens a roomy
        // full-width grammar well. Edits flow back through the textarea's
        // own input event so dirty-marking and tab bookkeeping stay exact.
        const expandB = document.createElement('button');
        expandB.type = 'button'; expandB.className = 'se-btn act';
        expandB.textContent = 'EXPAND ⤢'; expandB.title = C.tf('uplift.ui.edit_the_grammar_in_a_larger_window', 'Edit the grammar in a larger window');
        expandB.onclick = () => openGrammarPop(ggInp, expandB);
        // R10-9: preset examples. Shape is server-pluggable later: keep it
        // a list of {id, display_name, grammar} so a route can replace this.
        const GRAMMAR_PRESETS = [
            { id: 'json-object', display_name: 'JSON object envelope', grammar:
                'root   ::= "{" ws "\\"name\\"" ws ":" ws string ws "," ws "score" ws ":" ws number ws "}"\n'
              + 'string ::= "\\"" [^"\\\\]* "\\"\\" | "\\\\" any "\\\\" any\n'
              + 'number ::= "-"? [0-9]+ ("." [0-9]+)?\nws       ::= " "*' },
            { id: 'regex-date', display_name: 'Regex: ISO date', grammar:
                'root ::= [0-9] [0-9] [0-9] [0-9] "-" [0-1] [0-9] "-" [0-3] [0-9]' },
            { id: 'ebnf-calc', display_name: 'EBNF: math expression', grammar:
                'root     ::= expr\nexpr     ::= term (("+" / "-") term)*\nterm     ::= atom (("*" / "/") atom)*\natom     ::= [0-9]+ / "(" expr ")"' },
        ];
        const presetSel = document.createElement('select');
        presetSel.title = C.tf('uplift.ui.insert_an_example_grammar', 'Insert an example grammar');
        const ph = document.createElement('option');
        ph.value = ''; ph.textContent = 'Insert example…';
        presetSel.append(ph, ...GRAMMAR_PRESETS.map(p => {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = p.display_name; return o; }));
        presetSel.onchange = () => {
            const p = GRAMMAR_PRESETS.find(x => x.id === presetSel.value);
            presetSel.value = '';
            if (!p) return;
            // go through the widgets' own events so dirty-marking and tab
            // override bookkeeping happen exactly like manual editing
            if (ggInp.disabled) {
                const en = document.querySelector(
                    '#se-fields [data-key="guided_grammar_enabled"] input[type=checkbox]');
                if (en && !en.checked) en.click();   // flips seValues + enables textarea
            }
            ggInp.value = p.grammar;
            ggInp.dispatchEvent(new Event('input', { bubbles: true }));
        };
        // R10-14: grammar toggle + textarea + preset dropdown form one
        // framed unit; the box is always present, visibly disabled when off
        const gsb = sub(g);
        gsb.classList.add('se-sub-keep');
        gsb.append(seBind('bool', 'guided_grammar_enabled', { label: 'Guided Grammar',
            hint: 'Apply an EBNF grammar by default for this model.',
            // toggle must NOT reflow the form: the grammar box is always
            // present, just visibly disabled while the feature is off
            onChange: v => { ggInp.disabled = !v.guided_grammar_enabled; } }));
        ggInp.disabled = !seValues.guided_grammar_enabled;
        // R10-9: example dropdown docks inside the grammar field's control
        // box (below the textarea) so toggle + textarea + presets read as one unit
        ggWrap.querySelector('.se-ctl').append(presetSel, expandB);
        gsb.append(ggWrap);
    }

    /* chat-template kwargs (subset: key/value rows, add/remove) */
    if (!S.isDiffusion(m)) renderCtKwargs(section('Chat Template Kwargs'));

    /* ---- acceleration (kept: engine-level, not spec decode) ---- */
    section('Acceleration');
    g = grid();
    if (!S.isDiffusion(m)) {
        g.append(seBind('bool', 'enableIndexCache', { label: 'Index Cache',
            hint: 'Skip redundant indexer computation in DSA layers (DeepSeek V3/GLM-5).',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableIndexCache)
            sub(g).append(seBind('number', 'index_cache_freq',
                { label: C.tf('uplift.ui.frequency_every_nth_layer_keeps_indexer', 'Frequency (every Nth layer keeps indexer)'), min: 1, step: 1 }));
    }
    if (seValues.turboquant_kv_enabled !== undefined && !S.isDiffusion(m)) {
        g.append(seBind('bool', 'turboquant_kv_enabled', { label: 'TurboQuant KV Cache',
            hint: 'Compress KV cache using vector quantization. Lower bits = more compression.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.turboquant_kv_enabled)
            sub(g).append(seBind('number', 'turboquant_kv_bits',
                { label: C.tf('uplift.ui.bits_per_channel', 'Bits per channel'), min: 2, max: 8, step: 0.25 }));
    }
    if (m.qwen4_ple_ssd_offload_supported || seValues.qwen4_ple_ssd_offload)
        g.append(seBind('bool', 'qwen4_ple_ssd_offload', { label: 'SSD N-gram Offload (Qwen4 only)',
            hint: m.qwen4_ple_ssd_offload_forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keep the large PLE N-gram table on SSD and read only the required rows.',
            disabled: !!m.qwen4_ple_ssd_offload_forced }));
    if (seValues.deepseek_v41_ced_prefill_supported)
        g.append(seBind('bool', 'deepseek_v41_ced_prefill_enabled',
            { label: C.tf('uplift.ui.ced_prefill_acceleration_deepseek_v4_1', 'CED Prefill Acceleration (DeepSeek V4.1)'),
              hint: 'Improves prefill speed by approximately 74-79% in tested configuration.' }));
    if (m.deepseek_v41_engram_ssd_offload_supported)
        g.append(seBind('bool', 'deepseek_v41_engram_ssd_offload', {
            label: C.tf('uplift.ui.ssd_n_gram_offload_deepseek_v4_1', 'SSD N-gram Offload (DeepSeek V4.1)'),
            hint: m.deepseek_v41_engram_ssd_offload_forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keep Engram tables on SSD and prefetch required rows. Saves memory; speed depends on storage.',
            disabled: !!m.deepseek_v41_engram_ssd_offload_forced }));
    if (m.moe_expert_offload_supported && !S.isDiffusion(m)) {
        g.append(seBind('bool', 'moe_expert_offload_enabled', { label: 'MoE Expert Offload',
            hint: 'Stream Mixture-of-Experts weights from the checkpoint on demand, keeping only part resident.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.moe_expert_offload_enabled)
            sub(g).append(seBind('number', 'moe_expert_offload_resident_fraction',
                { label: C.tf('uplift.ui.resident_experts_fraction', 'Resident experts (fraction)'), min: 0.01, max: 1, step: 0.01 }));
    }
    if (S.isQwenOqA8(m)) {
        g.append(seBind('bool', 'qwen35_oq_a8_enabled', { label: 'Qwen INT8 Activation Prefill',
            hint: 'Experimental GPU INT8 activation quantization for supported Q4/Q5 prefill.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.qwen35_oq_a8_enabled)
            sub(g).append(seBind('number', 'qwen35_oq_a8_min_tokens',
                { label: C.tf('uplift.ui.minimum_prompt_tokens', 'Minimum prompt tokens'), min: 1, step: 1 }));
    }
    if (m.ane_prefill_backend && !S.isDiffusion(m)) renderAne(container, g);

    /* ---- speculative decode (R10-5 rename) ---- */
    section('Speculative Decoding');
    g = grid();
    const models = adminModels.length ? adminModels : [];
    const S_ = window.UpliftModelSpec;
    if (!S_.isDiffusion(m)) {
        if (seValues.specprefill_enabled !== undefined) {
            g.append(seBind('bool', 'specprefill_enabled', { label: 'SpecPrefill',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.specprefill_enabled) {
                const sb = sub(g);
                const pool = S_.specprefillCandidates(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'specprefill_draft_model',
                    { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
                sb.append(seBind('select', 'specprefill_keep_pct', { label: 'Keep Rate', options: [
                    { value: '0.1', label: '10% — Aggressive (~5-7x, some quality loss)' },
                    { value: '0.2', label: '20% — Balanced (~3x, recommended)' },
                    { value: '0.25', label: '25% — Conservative+ (~2.5x)' },
                    { value: '0.3', label: '30% — Conservative (~2.2x)' },
                    { value: '0.4', label: '40% — Mild (~1.8x)' },
                    { value: '0.5', label: '50% — Minimal (~1.5x)' }], picker: true }));
                sb.append(seBind('number', 'specprefill_threshold',
                    { label: C.tf('uplift.ui.threshold_tokens', 'Threshold (tokens)'), min: 1024, max: 131072, step: 1024 }));
            }
        }
        if (seValues.mtp_enabled !== undefined) {
            g.append(seBind('bool', 'mtp_enabled', { label: 'Lightning MTP',
                hint: m.mtp_compatible
                    ? "Drafts several tokens per step with the model's built-in MTP head."
                    : (m.mtp_compatibility_reason || 'Not compatible with this model'),
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.mtp_enabled)
                sub(g).append(seBind('number', 'mtp_num_draft_tokens', {
                    label: C.tf('uplift.ui.max_draft_tokens_per_cycle', 'Max draft tokens per cycle'), min: 1, step: 1,
                    hint: 'Speculative depth. Empty = model default (usually 3); '
                        + 'an adaptive controller picks 1..max from acceptance rates. '
                        + 'Set 1 to fix depth-1 cycles.' }));
        }
        const drafterType = (m.config_model_type || '').toLowerCase().replace(/-/g, '_');
        if (seValues.vlm_mtp_enabled !== undefined &&
            S_.VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES.has(drafterType)) {
            g.append(seBind('bool', 'vlm_mtp_enabled', { label: 'VLM MTP',
                hint: 'Speculative decoding via an external MTP drafter model.',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.vlm_mtp_enabled) {
                const sb = sub(g);
                const pool = S_.vlmMtpDrafters(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'vlm_mtp_draft_model', { label: 'Drafter model', options: [
                    { value: '', label: 'Select an assistant or MTP drafter…' }, ...pool], picker: true }));
                sb.append(seBind('number', 'vlm_mtp_draft_block_size',
                    { label: C.tf('uplift.ui.draft_block_size_tokens_per_round_blank_4', 'Draft block size (tokens per round, blank = 4)'), step: 1 }));
            }
        }
        // round 6 item 4: DFlash is its own section, not grouped under
        // Speculative Decoding (different mechanism — block diffusion).
        // Header only when the field set actually exists for this model.
        if (seValues.dflash_enabled !== undefined) {
            section('DFlash');
            g = grid();
            g.append(seBind('bool', 'dflash_enabled', { label: 'DFlash',
                hint: m.dflash_compatible === false ? (m.dflash_compatibility_reason || 'not compatible') : '',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.dflash_enabled) {
                const sb = sub(g);
                const pool = S_.dflashCandidates(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'dflash_draft_model',
                    { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
                sb.append(seBind('bool', 'dflash_draft_quant_enabled', { label: 'Quantization',
                    onChange: renderEditorFields.bind(null, container) }));
                if (seValues.dflash_draft_quant_enabled) {
                    sb.append(seBind('select', 'dflash_draft_quant_weight_bits', { label: 'Weight Bits', options: [
                        { value: 2, label: '2-bit' }, { value: 4, label: '4-bit' }, { value: 8, label: '8-bit' }], picker: true }));
                    sb.append(seBind('select', 'dflash_draft_quant_activation_bits', { label: 'Activation Bits', options: [
                        { value: 16, label: '16-bit' }, { value: 32, label: '32-bit' }], picker: true }));
                    sb.append(seBind('number', 'dflash_draft_quant_group_size', { label: 'Group Size', min: 16, max: 256, step: 16 }));
                }
                sb.append(seBind('number', 'dflash_max_ctx', { label: 'Max Context (fallback threshold)', step: 1 }));
                sb.append(seBind('bool', 'dflash_in_memory_cache', { label: 'In-memory cache',
                    onChange: renderEditorFields.bind(null, container) }));
                if (seValues.dflash_in_memory_cache) {
                    sb.append(seBind('number', 'dflash_in_memory_cache_max_entries',
                        { label: C.tf('uplift.ui.in_memory_cache_max_entries', 'In-memory cache max entries'), min: 1, step: 1 }));
                    sb.append(seBind('number', 'dflash_in_memory_cache_max_gib',
                        { label: C.tf('uplift.ui.in_memory_cache_size_gib', 'In-memory cache size (GiB)'), min: 1, step: 1,
                          hint: 'Byte budget for L1 snapshots; LRU evicts when exceeded.' }));
                    if (seValues.dflash_ssd_cache_available) {
                        sb.append(seBind('bool', 'dflash_ssd_cache', { label: 'SSD cache',
                            hint: 'Requires in-memory cache to be enabled.' }));
                        if (seValues.dflash_ssd_cache)
                            sb.append(seBind('number', 'dflash_ssd_cache_max_gib',
                                { label: C.tf('uplift.ui.ssd_cache_size_gib', 'SSD cache size (GiB)'), min: 1, step: 1 }));
                    }
                }
                sb.append(seBind('number', 'dflash_draft_window_size', { label: 'Draft window size' }));
                sb.append(seBind('number', 'dflash_draft_sink_size', { label: 'Draft sink size', min: 0, step: 1 }));
                sb.append(seBind('number', 'dflash_block_size', { label: 'Runtime block size', step: 1 }));
                sb.append(seBind('select', 'dflash_verify_mode', { label: 'Verify mode', options: [
                    { value: 'adaptive', label: 'adaptive (default)' },
                    { value: 'dflash', label: 'dflash' },
                    { value: 'ddtree', label: 'ddtree' }], picker: true }));
            }
        }
    }

    /* ---- context & limits (R10-5: pulled out of Basic/Advanced) ---- */
    section('Context & Limits');
    g = grid();
    g.append(seBind('number', 'max_context_window', { label: 'Ctx Window', step: 1 }));
    g.append(seBind('number', 'max_tokens', { label: 'Max Tokens', step: 1 }));
    g.append(seBind('number', 'ttl_seconds', { label: 'TTL (Seconds)', step: 1 }));
    g.append(seBind('bool', 'trust_remote_code', { label: 'Trust Remote Code',
        hint: 'Lets the model repo run arbitrary Python at load. Only enable for trusted repos.' }));
}

/* ANE prompt processing (classic modal renders a Qwen variant and, for
   ane_prefill_backend === 'k2', a K2 variant with different labels). */
function renderAne(container, g) {
    const k2 = (seFormModel && seFormModel.ane_prefill_backend) === 'k2';
    g.append(seBind('bool', 'qwen35_ane_prefill_enabled', {
        label: k2 ? 'K2 ANE Prompt Processing' : 'Qwen ANE Prompt Processing',
        hint: k2 ? 'Use ANE for K2 prompt processing, including MoVA. Decode stays on GPU.'
                 : 'Split eligible Qwen 3.5/3.6/3.8 prompt-processing work across both ANEs and the GPU.',
        onChange: renderEditorFields.bind(null, container) }));
    if (!seValues.qwen35_ane_prefill_enabled) return;
    const sbA = (function () { const d = document.createElement('div');
        d.className = 'se-sub'; g.append(d); return d; })();
    sbA.append(seBind('number', 'qwen35_ane_prefill_sequence_length',
        { label: C.tf('uplift.ui.prompt_block', 'Prompt block'), min: 1024, step: 64 }));
    if (!k2) sbA.append(seBind('number', 'qwen35_ane_prefill_tail_padding_min_tokens',
        { label: C.tf('uplift.ui.pad_tails_from', 'Pad tails from'), min: 0, step: 1 }));
    sbA.append(seBind('number', 'qwen35_ane_prefill_fraction',
        { label: C.tf('uplift.ui.mlp_on_ane', 'MLP on ANE'), min: 0, max: 1, step: 0.01 }));
    sbA.append(seBind('number', 'qwen35_ane_prefill_shared_fraction',
        { label: C.tf('uplift.ui.shared_mlp_on_ane', 'Shared MLP on ANE'), min: 0, max: 1, step: 0.01 }));
    if (!k2) {
        sbA.append(seBind('number', 'qwen35_ane_prefill_max_layers',
            { label: C.tf('uplift.ui.mlp_layer_limit', 'MLP layer limit'), min: 1, step: 1 }));
        sbA.append(seBind('bool', 'qwen35_ane_prefill_dual_ane',
            { label: C.tf('uplift.ui.use_both_anes', 'Use both ANEs'), hint: 'Pin one resident program to each physical ANE instance.' }));
    }
    sbA.append(seBind('bool', 'qwen35_ane_prefill_gdn',
        { label: C.tf('uplift.ui.accelerate_gdn', 'Accelerate GDN'), hint: 'Also split eligible GDN input projections across the ANEs and GPU.',
          onChange: renderEditorFields.bind(null, container) }));
    if (seValues.qwen35_ane_prefill_gdn) {
        sbA.append(seBind('number', 'qwen35_ane_prefill_gdn_fraction',
            { label: C.tf('uplift.ui.gdn_on_ane_fraction', 'GDN on ANE (fraction)'), min: 0, max: 1, step: 0.01 }));
        sbA.append(seBind('number', 'qwen35_ane_prefill_gdn_max_layers',
            { label: C.tf('uplift.ui.gdn_layer_limit', 'GDN layer limit'), min: 0, step: 1 }));
    }
    sbA.append(seBind('bool', 'qwen35_ane_prefill_cpu_enabled',
        { label: C.tf('uplift.ui.share_mlp_work_with_cpu', 'Share MLP work with CPU'),
          hint: 'Requires a separate Qwen q4 checkpoint clone with floating tensors converted.',
          onChange: renderEditorFields.bind(null, container) }));
    if (seValues.qwen35_ane_prefill_cpu_enabled) {
        const sbC = (function () { const d = document.createElement('div');
            d.className = 'se-sub'; sbA.append(d); return d; })();
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_fraction',
            { label: C.tf('uplift.ui.mlp_on_cpu_fraction', 'MLP on CPU (fraction)'), min: 0, max: 1, step: 0.001 }));
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_down_fraction',
            { label: C.tf('uplift.ui.down_projection_on_cpu_fraction_0_disabled', 'Down projection on CPU (fraction, 0 = disabled)'), min: 0, max: 1, step: 0.001 }));
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_gdn_fraction',
            { label: C.tf('uplift.ui.gdn_on_cpu_fraction', 'GDN on CPU (fraction)'), min: 0, max: 1, step: 0.001 }));
        sbC.append(seBind('number', 'qwen35_ane_prefill_cpu_threads',
            { label: C.tf('uplift.ui.cpu_workers_0_automatic', 'CPU workers (0 = automatic)'), min: 0, step: 1 }));
        sbC.append(seBind('bool', 'qwen35_ane_prefill_cpu_shared_resource',
            { label: C.tf('uplift.ui.performance_aware_scheduling', 'Performance-aware scheduling'),
              hint: "Uses Apple's shared-resource scheduler hint and falls back automatically." }));
    }
}

/* chat_template_kwargs editor: value kinds per classic modal */
/* R10-6: renderCtKwargs mutates entry objects; push the list back to the
   active tab's workVals so re-renders (conditional toggles, tab switches)
   show the edits instead of rebuilding from a stale clone. */
function seSyncKwEntries() {
    const t = seTab();
    if (!t) return;
    t.workVals = t.workVals || {};
    t.workVals.ctKwargEntries = seValues.ctKwargEntries;
    // entries are now the single source of truth for this tab
    delete t.workVals.chat_template_kwargs;
    delete t.workVals.forced_ct_kwargs;
}

function renderCtKwargs(container) {   // R10-5: container is the section body
    const S = window.UpliftModelSpec;
    const hint = document.createElement('div');
    hint.className = 'se-hint';
    hint.textContent = C.tf('uplift.ui.parameters_passed_to_chat_template_force_api_req', 'Parameters passed to chat template. Force: API requests cannot override this value.');
    container.append(hint);
    const g = document.createElement('div');
    g.className = 'pair'; container.append(g);
    const entries = seValues.ctKwargEntries || [];
    entries.forEach((e, idx) => {
        if (e.force) {
            const l = document.createElement('label'); l.className = 'se-row';
            const fk = document.createElement('span'); fk.textContent = `${e.key} (forced)`;
            const fv = document.createElement('span'); fv.className = 'stat-sub'; fv.textContent = String(e.value);
            l.append(fk, fv);
            g.append(l); return;
        }
        const row = document.createElement('div');
        row.className = 'se-row se-kwarg';
        const key = document.createElement('input');
        key.type = 'text'; key.value = e.key || ''; key.placeholder = 'key';
        key.addEventListener('input', () => { e.key = key.value; });
        let val;
        if (e.type === 'enable_thinking') {
            val = document.createElement('select');
            ['true', 'false'].forEach(v => { const o = document.createElement('option'); o.value = v; val.append(o); });
            val.value = String(e.value);
            val.addEventListener('change', () => { e.value = val.value; });
        } else if (e.type === 'reasoning_effort') {
            val = document.createElement('select');
            // R10-10: offer the model-reported effort options; fall back to
            // the standard preset list, current value always selectable
            const opts = ((seFormModel || {}).reasoning_effort_options || []).length
                ? [...seFormModel.reasoning_effort_options]
                : ['low', 'medium', 'high', 'xhigh', 'max'];
            if (!e.custom && !opts.includes(e.value)) opts.unshift(e.value);
            opts.concat(['__custom__']).forEach(v => {
                const o = document.createElement('option');
                o.value = v; o.textContent = v === '__custom__' ? 'custom…' : v; val.append(o); });
            val.value = e.custom ? '__custom__' : e.value;
            val.addEventListener('change', () => {
                if (val.value === '__custom__') { e.custom = true; } else { e.custom = false; e.value = val.value; }
                renderEditorFields(container);
            });
            if (e.custom) {
                const cv = document.createElement('input');
                cv.type = 'text'; cv.value = e.customValue || '';
                cv.addEventListener('input', () => { e.customValue = cv.value; });
                row.append(key, val, cv);
            }
        } else {
            val = document.createElement('input');
            val.type = 'text'; val.placeholder = 'value';
            val.value = String(e.value == null ? '' : e.value);
            val.addEventListener('input', () => { e.value = val.value; });
        }
        const rm = document.createElement('button');
        rm.className = 'se-btn'; rm.textContent = '×';
        rm.addEventListener('click', () => {
            seValues.ctKwargEntries.splice(idx, 1);
            renderEditorFields(container);
        });
        if (!row.children.length) row.append(key, val);
        row.append(rm);
        g.append(row);
    });
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'se-hint'; empty.textContent = 'No kwargs configured';
        g.append(empty);
    }
    const add = document.createElement('button');
    add.className = 'se-btn'; add.textContent = '+ Add';
    // R10-10: classic's Add menu — offer typed defaults, not just a blank row
    const addMenu = document.createElement('span');
    addMenu.className = 'se-addmenu'; addMenu.hidden = true;
    const mkItem = (label, make, show) => {
        if (!show) return;
        const it = document.createElement('button');
        it.className = 'se-btn'; it.textContent = label;
        it.onclick = () => {
            seValues.ctKwargEntries.push(make());
            seSyncKwEntries();
            addMenu.hidden = true;
            renderEditorFields(container);
        };
        addMenu.append(it);
    };
    const m = seFormModel || {};
    mkItem('Enable Thinking', () => ({ type: 'enable_thinking', value: 'true', force: false }),
        !S.isDiffusion(m) && !m.thinking_forced
        && !entries.some(e => e.type === 'enable_thinking'));
    mkItem('Reasoning Effort', () => ({ type: 'reasoning_effort',
        value: (m.reasoning_effort_default || 'low'), custom: false, customValue: '', force: false }),
        !S.isDiffusion(m)
        && !entries.some(e => e.type === 'reasoning_effort'
            || (e.type === 'custom' && (e.key || '').trim() === 'reasoning_effort')));
    mkItem('Custom', () => ({ type: 'custom', key: '', value: '', force: false }), true);
    add.addEventListener('click', () => { addMenu.hidden = !addMenu.hidden; });
    g.append(add, addMenu);
    seSyncKwEntries();   // R10-6: keep the edited list live on the tab
}

function editorNode() {
    const panel = document.createElement('div');
    panel.className = 'modal nasa editor';
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.textContent = (seFormModel && seFormModel.model_alias ? seFormModel.model_alias + ' \u2192 ' : '')
        + seModel + (seFormModel && seFormModel._missing ? '  (missing — stored settings only)' : '');
    const tabsRow = document.createElement('div');
    tabsRow.className = 'se-tabs';
    // F-013: profile/template management rows need their own container —
    // seRenderTabs() wipes .se-tabs on every tab switch and used to erase them.
    const profsRow = document.createElement('div');
    profsRow.className = 'se-profs';
    const scroll = document.createElement('div');
    scroll.className = 'editor-scroll';
    const fields = document.createElement('div');
    fields.id = 'se-fields';
    scroll.append(fields);
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    // CHANGES lives to the RIGHT of the form, not below it: when changes are
    // queued the panel widens and the box appears as a side rail
    const bodyRow = document.createElement('div');
    bodyRow.className = 'editor-body';
    const changes = document.createElement('div');
    changes.id = 'se-changes'; changes.className = 'changelist ed'; changes.hidden = true;
    bodyRow.append(scroll, changes);
    const save = document.createElement('button');
    save.className = 'se-btn'; save.textContent = 'Save'; save.id = 'se-save';
    const close = document.createElement('button');
    close.className = 'se-btn'; close.textContent = 'Close'; close.id = 'se-cancel';
    const msg = document.createElement('span');
    msg.className = 'stat-sub'; msg.id = 'se-msg';
    bar.append(save, close, msg);
    panel.append(head, tabsRow, profsRow, bodyRow, bar);
    save.onclick = saveEditor;
    close.onclick = () => closeEditor();
    return panel;
}
/* U2: roomy grammar editing pop-out over the model editor. OK copies the
   text back into the small textarea through its own 'input' event, so the
   bound listener does dirty-marking / override bookkeeping exactly as if
   the user typed it there. Cancel discards the draft. */
function openGrammarPop(srcTa, btn) {
    const existing = document.querySelector('.grammar-pop-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay grammar-pop-overlay';
    overlay.style.zIndex = '90';                 // above the editor modal (70)
    const panel = document.createElement('div');
    panel.className = 'modal nasa grammar-pop';
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.textContent = C.tf('uplift.ui.guided_grammar', 'GUIDED GRAMMAR — ') + seModel;
    const ta = document.createElement('textarea');
    ta.value = srcTa.value;
    ta.spellcheck = false;
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    const ok = document.createElement('button');
    ok.className = 'se-btn'; ok.textContent = 'OK';
    const cancel = document.createElement('button');
    cancel.className = 'se-btn'; cancel.textContent = 'Cancel';
    const stat = document.createElement('span'); stat.className = 'stat-sub';
    const count = () => { stat.textContent = ta.value.split('\n').length + ' lines · '
                                   + ta.value.length + ' chars'; };
    ta.addEventListener('input', count); count();
    ok.onclick = () => {
        srcTa.value = ta.value;
        srcTa.dispatchEvent(new Event('input', { bubbles: true }));
        overlay.remove();
    };
    cancel.onclick = () => overlay.remove();
    bar.append(ok, cancel, stat);
    panel.append(head, ta, bar);
    overlay.append(panel);
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); });
    document.body.append(overlay);
    ta.focus();
}
function closeEditor() {
    if (seModel) delete profilesCache[seModel];   // tree must show new profiles
    seModel = null; seFormModel = null;
    renderModelAdmin(); // rows were frozen while the editor was open
    document.querySelectorAll('.editor-overlay').forEach(n => n.remove());
    document.querySelectorAll('.row-editor').forEach(n => n.remove());
    document.querySelectorAll('.urow.expanded').forEach(r => r.classList.remove('expanded'));
    const fb = $('model-editor-fallback');
    if (fb) { fb.hidden = true; fb.querySelector('.row-editor')?.remove(); }
}
async function openEditor(model, profileName, templateName) {
    closeEditor();
    if (templateName) { return openTemplateEditor(templateName); }
    seModel = model;
    seWantProfile = profileName || null;   // alias/profile EDIT lands on that tab
    await loadGrammarParsers().catch(() => {});   // R10-7: fill the reasoning-parser list (classic does the same)
    let row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
        .find(r => r.dataset.mid === model);
    if (!row) { await renderModelAdmin(true);
        row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
            .find(r => r.dataset.mid === model); }
    let settings = {}, entry = null;
    try {
        const d = await MM_GLUE.fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`);
        settings = d.settings || {};
    } catch (_) { settings = {}; }
    try {
        const list = adminModels.length ? adminModels
            : (await MM_GLUE.fetchJson(`${API}/admin/api/models`)).models;
        entry = list.find(x => x.id === model) || null;
    } catch (_) { entry = null; }
    seFormModel = entry || { id: model, _missing: !entry };
    seValues = window.UpliftModelSpec.buildState(seFormModel, settings);
    seOrig = JSON.parse(JSON.stringify(seValues));
    seBaseVals = JSON.parse(JSON.stringify(seValues));
    seTabs = [{ id: 'base', dirty: new Set(), origVals: JSON.parse(JSON.stringify(seOrig)) }];
    seActiveTab = 'base';
    // is_hidden/is_favorite/is_default/pinned are toggled from the models ROW
    // (classic _models.html), never in the settings modal — parity: not here.
    // popup modal, not an inline accordion: stable size for long forms
    const panel = editorNode();
    renderEditorFields(panel.querySelector('#se-fields'));
    seLoadProfiles(model, panel.querySelector('.se-profs')).then(() => {
        seRenderTabs(panel);
        // alias/profile EDIT button: land directly on that profile's tab
        if (seWantProfile) { const w = seWantProfile; seWantProfile = null;
                             seOpenProfileTab(panel, w); }
    });
    panel._reRender = () => {
        renderEditorFields(panel.querySelector('#se-fields'));
        seRenderTabs(panel);
        seUpdateSaveBtn();
    };
    if (!row) $('se-msg') && ($('se-msg').textContent = `Model ${model} not listed`);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay editor-overlay';
    overlay.append(panel);
    document.body.append(overlay);
    panel.tabIndex = -1;
    panel.focus();
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeEditor();
    });
}

/* ---- global-template editor (round 5): a template is a universal-settings
   bundle; the model editor's fields are built from buildState(model, stored),
   so the trick is to build state from the TEMPLATE with a neutral pseudo-model
   and PUT back only the universal keys (same filter tSnap uses) ------------ */
async function openTemplateEditor(name) {
    let tpl = null;
    try {
        const d = await MM_GLUE.fetchJson(`${API}/admin/api/profile-templates`);
        tpl = (d.templates || []).find(t => t.name === name) || null;
    } catch (_) {}
    if (!tpl) { MM_GLUE.toast('template "' + name + '" not found'); return; }
    seModel = null;
    seFormModel = { id: name, _template: true };
    seValues = window.UpliftModelSpec.buildState(seFormModel, tpl.settings || {});
    seOrig = JSON.parse(JSON.stringify(seValues));
    seBaseVals = JSON.parse(JSON.stringify(seValues));
    seTabs = [{ id: 'base', dirty: new Set(), origVals: JSON.parse(JSON.stringify(seOrig)) }];
    seActiveTab = 'base';
    const panel = editorNode();
    panel.querySelector('.editor-head').textContent =
        'GLOBAL TEMPLATE  ' + (tpl.display_name || tpl.name);
    const pr = panel.querySelector('.se-profs'); if (pr) pr.hidden = true;
    const tabs = panel.querySelector('.se-tabs'); if (tabs) tabs.hidden = true;
    renderEditorFields(panel.querySelector('#se-fields'));
    seRenderTabs(panel);
    const save = panel.querySelector('#se-save');
    if (save) save.onclick = () => saveTemplateEditor(tpl, panel);
    seUpdateSaveBtn();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay editor-overlay';
    overlay.append(panel);
    document.body.append(overlay);
    panel.tabIndex = -1; panel.focus();
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditor(); });
}
async function saveTemplateEditor(tpl, panel) {
    const msg = panel.querySelector('#se-msg');
    const errors = window.UpliftModelSpec.validate(seValues);
    if (errors.length) { msg.textContent = errors[0]; MM_GLUE.toast(errors[0]); return; }
    msg.textContent = 'saving…';
    try {
        const full = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
        let uni = [];
        try { uni = (await MM_GLUE.fetchJson(`${API}/admin/api/profile-fields`)).universal || []; } catch (_) {}
        const allowed = new Set(uni);
        const settings = {};
        for (const [k, v] of Object.entries(full))
            if (allowed.has(k) && v !== null && v !== undefined) settings[k] = v;
        const r = await fetch(`${API}/admin/api/profile-templates/${encodeURIComponent(tpl.name)}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings }) });
        if (!r.ok) { const d = await r.json().catch(() => ({}));
            throw new Error(d.detail || String(r.status)); }
        msg.textContent = 'saved ✓';
        MM_GLUE.toast('Template saved: ' + (tpl.display_name || tpl.name));
        seOrig = JSON.parse(JSON.stringify(seValues));
        seUpdateSaveBtn();
        renderTemplatesBox();
        setTimeout(closeEditor, 1000);
    } catch (err) {
        msg.textContent = 'error: ' + err.message;
        MM_GLUE.toast('Template save failed: ' + err.message);
    }
}

function seRenderTabs(panel) {
    const strip = panel.querySelector('.se-tabs');
    if (!strip) return;
    strip.textContent = '';
    for (const t of seTabs) {
        const b = document.createElement('button');
        b.className = 'se-tab' + (t.id === seActiveTab ? ' active' : '');
        let mark = '';
        const nameChanged = t.id !== 'base' &&
            ((t._origExpose || false) !== !!t.expose_as_model ||
             (t._origApi || '') !== (t.api_name || ''));
        if (t.dirty.size || nameChanged) mark = ' ●';
        const nm = t.id === 'base' ? 'BASE'
            : (t.template ? '◱ ' : '') + (t.display_name || t.name || t.id);
        b.textContent = nm + mark;
        b.title = t.id === 'base' ? 'Model settings (base)'
            : (t.template ? 'Global template (copy, unsaved)' : 'Profile: ' + (t.name || ''));
        b.onclick = () => {
            seCaptureTab();                 // save edits of the tab we leave
            seActiveTab = t.id;
            if (t.id !== 'base') seRestoreTab(t);
            else { seValues = Object.assign({}, t.workVals || seBaseVals);
                   seOrig = t.origVals || seOrig; }
            renderEditorFields(document.getElementById('se-fields'));
            seRenderTabs(panel);
            seUpdateSaveBtn();
        };
        if (t.id !== 'base' && !t.template) {
            const x = document.createElement('span');
            x.className = 'se-tab-x'; x.textContent = '✕'; x.title = 'Close this tab (profile stays on server)';
            x.onclick = (ev) => {
                ev.stopPropagation();
                seTabs = seTabs.filter(z => z.id !== t.id);
                if (seActiveTab === t.id) { seActiveTab = 'base';
                    seValues = JSON.parse(JSON.stringify(seBaseVals));
                    seOrig = JSON.parse(JSON.stringify(seTabs[0].origVals)); }
                renderEditorFields(document.getElementById('se-fields'));
                seRenderTabs(panel); seUpdateSaveBtn();
            };
            b.append(x);
        }
        strip.append(b);
    }
    // New profile: focused input with incremental "Model profile X", values
    // inherited from the tab we were on, dropdown of global templates + models
    const nb = document.createElement('button');
    nb.className = 'se-tab se-new'; nb.textContent = '+ NEW PROFILE';
    nb.onclick = () => seNewProfile(panel);
    strip.append(nb);
    const drop = document.createElement('select');
    drop.className = 'se-tab-drop';
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'apply from…';
    drop.append(ph);
    // grouped: bundled GLOBAL PRESETS (qwen3.5/…, gemma4, llama4 …), then
    // user templates, then copy-from-other-model
    const g1 = document.createElement('optgroup'); g1.label = 'Global presets';
    for (const p of (window.__sePresets || [])) {
        const o = document.createElement('option'); o.value = 'pre:' + p.name;
        o.textContent = '◧ ' + (p.display_name || p.name); g1.append(o);
    }
    if (g1.children.length) drop.append(g1);
    const g2 = document.createElement('optgroup'); g2.label = 'Model profiles (this model)';
    // U4: this model's own stored profiles live HERE now (apply values into
    // the active tab, no tab of their own). seLoadProfiles fills the list
    // async and re-renders the strip once loaded.
    for (const p of (window.__seProfiles || [])) {
        const o = document.createElement('option'); o.value = 'own:' + p.name;
        o.textContent = '◧ ' + (p.display_name || p.name) + ' (profile)'; g2.append(o);
    }
    for (const t of (window.__seTemplates || [])) {
        const o = document.createElement('option'); o.value = 'tpl:' + t.name;
        o.textContent = '◱ ' + (t.display_name || t.name) + ' (template)'; g2.append(o);
    }
    if (g2.children.length) drop.append(g2);
    const g3 = document.createElement('optgroup'); g3.label = 'Copy settings from model';
    for (const mm of (adminModels || [])) {
        if (mm.id === seModel) continue;
        const o = document.createElement('option'); o.value = 'mdl:' + mm.id;
        o.textContent = '⊕ ' + (mm.display_name || mm.id); g3.append(o);
        // the model's aliases/profiles carry their own settings — copyable too
        for (const ep of (mm.exposed_profiles || [])) {
            const po = document.createElement('option');
            po.value = 'mpr:' + encodeURIComponent(mm.id) + '|' + ep.name;
            po.textContent = '⊕ ' + (mm.display_name || mm.id) + ' ▸ ' + (ep.api_name || ep.name);
            g3.append(po);
        }
    }
    if (g3.children.length) drop.append(g3);
    // missing (stored-only) models + their profiles — round 4: the stored
    // records are copy sources too, marked (missing) in the dropdown
    const present = new Set((adminModels || []).map(x => x.id));
    const idxM = S.settingsIdx || {};
    const missingEnt = (idxM.entries || []).filter(e => !present.has(e.id));
    const g4 = document.createElement('optgroup');
    g4.label = 'Copy settings from missing model';
    for (const e of missingEnt) {
        const o = document.createElement('option'); o.value = 'msm:' + e.id;
        o.textContent = '⊕ ' + e.id + ' (missing)'; g4.append(o);
    }
    for (const p of (idxM.profiles || [])) {
        if (!missingEnt.some(e => e.id === p.base)) continue;  // present bases: own-profile group covers them
        const o = document.createElement('option');
        o.value = 'msp:' + encodeURIComponent(p.base) + '|' + p.name;
        o.textContent = '⊕ ' + p.base + ':' + (p.display_name || p.name) + ' (missing)';
        g4.append(o);
    }
    if (g4.children.length) drop.append(g4);
    drop.onchange = () => {
        const v = drop.value; if (!v) return;
        drop.value = '';
        const kind = v.slice(0, 3), id = v.slice(4);
        if (kind === 'msm') {
            MM_GLUE.fetchJson(`${API}/admin/api/models/${encodeURIComponent(id)}/settings`)
                .then(d => seApplyIntoActiveTab(d.settings || {}, id + ' (missing)'))
                .catch(e => MM_GLUE.toast('Load failed: ' + e.message));
        } else if (kind === 'msp') {
            const mid = decodeURIComponent(id.slice(0, id.indexOf('|')));
            const pname = id.slice(id.indexOf('|') + 1);
            MM_GLUE.fetchJson(`${API}/uplift/api/models/${encodeURIComponent(mid)}/profiles`)
                .then(d => {
                    const p = (d.profiles || []).find(x => x.name === pname);
                    if (p) seApplyIntoActiveTab(p.settings || {}, mid + ':' + pname + ' (missing)');
                    else MM_GLUE.toast('profile not found: ' + pname);
                })
                .catch(e => MM_GLUE.toast('Load failed: ' + e.message));
        } else if (kind === 'own') {
            const p = (window.__seProfiles || []).find(x => x.name === id);
            if (p) seApplyIntoActiveTab(p.settings || {}, p.display_name || p.name);
        } else if (kind === 'mpr') {
            // U4: model profile -> apply values into the ACTIVE tab, no new
            // tab. Settings are already local in adminModels.
            const mid = decodeURIComponent(id.slice(0, id.indexOf('|')));
            const pname = id.slice(id.indexOf('|') + 1);
            const mm = (adminModels || []).find(x => x.id === mid);
            const ep = mm && (mm.exposed_profiles || []).find(x => x.name === pname);
            if (ep) seApplyIntoActiveTab(ep.settings || {}, mid + ' ▸ ' + pname);
        } else if (kind === 'pre') {
            const pre = (window.__sePresets || []).find(x => x.name === id);
            if (pre) seApplyIntoActiveTab(pre.settings || {}, pre.display_name || pre.name);
        } else if (kind === 'tpl') {
            const tpl = (window.__seTemplates || []).find(x => x.name === id);
            if (tpl) seApplyIntoActiveTab(tpl.settings || {}, tpl.display_name || tpl.name);
        } else {
            MM_GLUE.toast(C.t('uplift.toast.loading_settings', {id: id}));
            MM_GLUE.fetchJson(`${API}/admin/api/models/${encodeURIComponent(id)}/settings`)
                .then(d => seApplyIntoActiveTab(d.settings || {}, id))
                .catch(e => MM_GLUE.toast('Load failed: ' + e.message));
        }
    };
    strip.append(drop);
}
/* U4: merge a settings blob INTO the active tab as unsaved edits —
   profile tabs receive overrides (empty-able via inherit), the base tab
   receives plain values. Dirty bookkeeping mirrors the widgets' own logic
   so SAVE counts, the CHANGES rail and revert all stay exact. */
function seApplyIntoActiveTab(rawSettings, sourceLabel) {
    const t = seTab();
    const st = window.UpliftModelSpec.buildState(seFormModel || { id: seModel },
        JSON.parse(JSON.stringify(rawSettings || {})));
    const base = seIsBaseTab() ? seOrig : (t.id !== 'base' ? t.origVals : seOrig);
    const ovSnap = !seIsBaseTab() && SE_INHERIT_KEYS.size ? seOvSnap(t) : null;
    let n = 0;
    for (const [k, v] of Object.entries(st)) {
        if (k === 'ctKwargEntries' || k === 'model_alias' || v === undefined) continue;
        const origV = (t.id !== 'base' && SE_INHERIT_KEYS.has(k)) ? ovSnap[k] : base[k];
        const changed = JSON.stringify(origV) !== JSON.stringify(v);
        if (changed) { t.dirty.add(k); n++; } else t.dirty.delete(k);
        if (t.id !== 'base') {
            // inheritable key applied with the base value == inherit (drop override)
            const inheritVal = seBaseVals ? seBaseVals[k] : undefined;
            if (SE_INHERIT_KEYS.has(k) && JSON.stringify(v) === JSON.stringify(inheritVal)) {
                delete t.overrides[k];
                continue;
            }
            t.overrides[k] = v;
        }
    }
    // chat-template kwargs ride the entries list; replace it wholesale when
    // the source defines any (classic apply is a full-merge too)
    if (st.ctKwargEntries && st.ctKwargEntries.length) {
        seValues.ctKwargEntries = st.ctKwargEntries;
        if (t.id !== 'base') t.overrides.ctKwargEntries = st.ctKwargEntries;
        if (!t._origKwargs) t._origKwargs = JSON.parse(JSON.stringify(seValues.ctKwargEntries));
    }
    Object.assign(seValues, st, { ctKwargEntries: seValues.ctKwargEntries });
    seNormalizeKwargs(seValues);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(document.querySelector('.modal.editor'));
    seUpdateSaveBtn();
    MM_GLUE.toast(n ? C.t('uplift.toast.applied_review', {source: sourceLabel, target: seIsBaseTab() ? 'BASE' : (t.display_name || t.name), n: n})
            : `${sourceLabel}: nothing to change on this tab`);
}
function seCaptureTab() {
    // pull live widget values into the active tab before switching
    const t = seTab(); if (!t) return;
    if (t.id === 'base') { t.workVals = Object.assign({}, seValues); return; }
    t.workVals = Object.assign({}, seValues);
    for (const k of Object.keys(seValues)) {
        if (seValues[k] === undefined) delete t.workVals[k];
    }
    // overrides = keys whose value differs from base. R10-6: ctKwargEntries
    // and model_alias are UI/internal fields, never real profile settings —
    // persisting them corrupts the kwargs editor after a tab switch.
    const ov = {};
    for (const [k, v] of Object.entries(t.workVals)) {
        if (k === 'ctKwargEntries' || k === 'model_alias') continue;
        if (JSON.stringify(v) !== JSON.stringify(seBaseVals[k])) ov[k] = v;
    }
    // keep overrides that were captured but reverted-to-inherit out
    for (const k of Object.keys(t.overrides)) if (!(k in ov)) delete t.overrides[k];
    t.overrides = Object.assign({}, t.overrides, ov);
    seNormalizeKwargs(t.overrides);
}
function seNormalizeKwargs(vals) {
    // R10-6: raw settings payloads (profiles/templates) carry
    // chat_template_kwargs + forced_ct_kwargs; the editor works on the
    // modelspec ctKwargEntries shape. Convert so kwargs render editable;
    // when entries already exist, drop the raw twins so a save can't write
    // a stale chat_template_kwargs alongside the edited entries.
    if (!vals) return;
    const hasRaw = vals.chat_template_kwargs || vals.forced_ct_kwargs;
    if (vals.ctKwargEntries && vals.ctKwargEntries.length && !hasRaw) return;
    if (!hasRaw) return;
    // raw kwargs present: they win over entries built from base;
    // base entries for keys the raw payload doesn't mention are kept.
    // (After the first kwargs render, seSyncKwEntries has removed the raw
    // twins from workVals, so re-renders keep the user's edited entries.)
    const raw = vals.chat_template_kwargs || {};
    const rebuilt = window.UpliftModelSpec.buildCtKwargEntries(raw, vals.forced_ct_kwargs, false);
    const keep = (vals.ctKwargEntries || []).filter(e => !(e.key in raw));
    vals.ctKwargEntries = rebuilt.concat(keep);
    delete vals.chat_template_kwargs;
    delete vals.forced_ct_kwargs;
}
function seRestoreTab(t) {
    seValues = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(t.workVals || t.overrides || {})));
    seNormalizeKwargs(seValues);
}
function seNextAutoName() {
    let i = 1;
    const used = new Set(seTabs.filter(t => t.name).map(t => (t.name || '').toLowerCase()));
    while (used.has('model-profile-' + i)) i++;
    // Must satisfy server validate_profile_name ^[a-z0-9][a-z0-9_-]{0,31}$ —
    // "Model profile 1" (space + caps) was rejected on save.
    return 'model-profile-' + i;
}
function seNewProfile(panel) {
    seCaptureTab();
    const from = seValues;                   // inherited from current tab
    const name = seNextAutoName();
    const ov = {};
    if (seActiveTab !== 'base') {
        const src = seTab();
        Object.assign(ov, JSON.parse(JSON.stringify(src.overrides || {})));
    }
    const t = { id: 'new' + Date.now(), name, display_name: name,
        expose_as_model: false, api_name: '', overrides: ov,
        workVals: JSON.parse(JSON.stringify(from)),
        origVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
        dirty: new Set(), _new: true, _origExpose: false, _origApi: '' };
    seInitSnap(t);
    seTabs.push(t);
    seActiveTab = t.id;
    seRestoreTab(t);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(panel); seUpdateSaveBtn();
    // focus the name input for incremental rename
    const inp = panel.querySelector('.se-newname');
    if (inp) { inp.focus(); inp.select(); }
}
function seOpenProfileTab(panel, name) {
    // Open (or reuse) a working tab for an existing stored profile so the
    // alias-line EDIT button lands directly on the thing it edits. Saving
    // such a tab PUTs to /profiles/<name> (profileId set), never POSTs a new.
    let t = seTabs.find(z => z.profileId === name || z.name === name);
    if (!t) {
        const p = (window.__seProfiles || []).find(x => x.name === name);
        if (!p) { MM_GLUE.toast('profile "' + name + '" not found'); return; }
        seCaptureTab();
        const ov = JSON.parse(JSON.stringify(p.settings || {}));
        t = seInitSnap({ id: 'prof' + Date.now(), name: p.name,
            display_name: p.display_name || p.name,
            expose_as_model: !!p.expose_as_model, api_name: p.api_name || '',
            profileId: p.name, overrides: ov,
            workVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
            origVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
            dirty: new Set(), _origExpose: !!p.expose_as_model, _origApi: p.api_name || '' });
        seTabs.push(t);
    }
    seCaptureTab();
    seActiveTab = t.id;
    seRestoreTab(t);
    renderEditorFields(document.getElementById('se-fields'));
    seRenderTabs(panel); seUpdateSaveBtn();
}


/* ---- per-model profiles (sidebar of the classic editor) ----
   U4 (user round): selecting a profile must NOT open a tab (the classic
   quirk duplicated tabs and looked like "create new profile"). Profiles
   live in the editor's 'apply from…' dropdown and apply their values into
   the ACTIVE tab as unsaved edits; a new profile is created only through
   '+ NEW PROFILE'. This host keeps management rows only (delete / save
   current as). */
async function seLoadProfiles(model, host) {
    let profs = [];
    try { profs = (await MM_GLUE.fetchJson(`${API}/uplift/api/models/${encodeURIComponent(model)}/profiles`)).profiles || []; } catch (_) {}
    host.textContent = '';
    window.__seProfiles = profs;
    const oldPt = null;
    const row = document.createElement('div');
    row.className = 'se-prof-row';
    const sel = document.createElement('select');
    const none = document.createElement('option'); none.value = ''; none.textContent = 'profiles…';
    sel.append(none, ...profs.map(p => { const o = document.createElement('option');
        o.value = p.name; o.textContent = p.display_name || p.name; return o; }));
    // U4: no Apply button here — applying values lives in the 'apply from…'
    // dropdown (client-side, into the active tab). This row manages profiles.
    const delB = document.createElement('button'); delB.className = 'se-btn'; delB.textContent = 'Delete';
    const saveAs = document.createElement('input');
    saveAs.type = 'text'; saveAs.placeholder = 'save current as…'; saveAs.className = 'se-prof-name';
    const saveB = document.createElement('button'); saveB.className = 'se-btn'; saveB.textContent = 'Save';
    const write = async (path, opts) => {          // detail-aware JSON call
        const res = await fetch(path, Object.assign({ cache: 'no-store' }, opts));
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(C.errorText(body) || String(res.status));
        return body;
    };
    delB.onclick = async () => {
        if (!sel.value) return;
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(sel.value)}`,
                { method: 'DELETE' });
            MM_GLUE.toast(C.t('uplift.toast.deleted_profile', {name: sel.value}));
            seLoadProfiles(model, host);
        } catch (e) { MM_GLUE.toast(C.t('uplift.toast.delete_failed', {msg: e.message})); }
    };
    saveB.onclick = async () => {
        const name = saveAs.value.trim();
        if (!name) { MM_GLUE.toast(C.t('uplift.toast.profile_name_required')); return; }
        const payload = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  // F-033: API schema requires display_name (FastAPI 422);
                  // this strip-path omitted it while saveProfileTab sent it.
                  body: JSON.stringify({ name, display_name: name, settings: payload }) });
            MM_GLUE.toast(C.t('uplift.toast.saved_profile', {name: name}));
            seLoadProfiles(model, host);
        } catch (e) { MM_GLUE.toast(C.t('uplift.toast.profile_error', {msg: e.message})); }
    };
    row.append(sel, delB, saveAs, saveB);
    host.append(row);
    // keep the 'apply from…' strip in sync: own-profile options were just
    // (re)loaded or changed
    const stripPanel = document.querySelector('.modal.editor');
    if (stripPanel) seRenderTabs(stripPanel);
    // Global templates (global_templates.json): apply or snapshot into a template.
    let tpls = [];
    try { tpls = (await MM_GLUE.fetchJson(`${API}/admin/api/profile-templates`)).templates || []; } catch (_) {}
    window.__seTemplates = tpls;
    // Bundled global presets (same source as the classic editor's preset
    // menu: /admin/static/omlx_preset.json), cached 1 day like classic does.
    if (!window.__sePresets) {
        try {
            const cached = JSON.parse(localStorage.getItem('omlx_preset_cache') || 'null');
            if (cached && cached.presets) window.__sePresets = cached.presets;
            else {
                const d = await MM_GLUE.fetchJson(`${API}/admin/static/omlx_preset.json`);
                window.__sePresets = d.presets || [];
                localStorage.setItem('omlx_preset_cache', JSON.stringify(d));
            }
        } catch (_) { window.__sePresets = []; }
    }
    if (tpls.length || true) {
        const trow = document.createElement('div');
        trow.className = 'se-prof-row';
        const tsel = document.createElement('select');
        const tnone = document.createElement('option'); tnone.value = ''; tnone.textContent = 'templates…';
        tsel.append(tnone, ...tpls.map(t => { const o = document.createElement('option');
            o.value = t.name; o.textContent = t.display_name || t.name; return o; }));
        const tApply = document.createElement('button'); tApply.className = 'se-btn'; tApply.textContent = 'Apply';
        const tSnap = document.createElement('button'); tSnap.className = 'se-btn'; tSnap.textContent = 'Snapshot as';
        const uniFields = async () => {
            try { return (await MM_GLUE.fetchJson(`${API}/admin/api/profile-fields`)).universal || []; } catch (_) { return []; }
        };
        tApply.onclick = async () => {
            if (!tsel.value) return;
            try {
                // Classic applyTemplateToForm: template is source of truth —
                // upsert the model profile from it, then apply the profile.
                const tpl = tpls.find(t => t.name === tsel.value) || {};
                const prof = `${API}/admin/api/models/${encodeURIComponent(model)}/profiles`;
                let pname = tpl.name;
                await write(prof, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: pname, display_name: tpl.display_name || tpl.name,
                                           description: tpl.description || null,
                                           settings: tpl.settings || {}, source_template: tpl.name }) });
                await write(`${prof}/${encodeURIComponent(pname)}/apply`, { method: 'POST' });
                MM_GLUE.toast(C.t('uplift.toast.applied_template', {name: pname}));
                openEditor(model);
            } catch (e) { MM_GLUE.toast(C.t('uplift.toast.template_apply_failed', {msg: e.message})); }
        };
        tSnap.onclick = async () => {
            const typed = saveAs.value.trim() || tsel.value;
            if (!typed) { MM_GLUE.toast(C.t('uplift.toast.type_save_name_first')); return; }
            // Classic contract (dashboard.js createTemplate): `name` is the
            // machine slug, `display_name` the human text — POST 422s without
            // display_name (F-019). Slug must match ^[a-z0-9][a-z0-9_-]{0,31}$.
            const slug = typed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
            const name = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(slug)
                ? slug : 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
            const full = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
            const uni = new Set(await uniFields());
            const settings = {};
            for (const [k, v] of Object.entries(full)) if (uni.has(k)) settings[k] = v;
            try {
                await write(`${API}/admin/api/profile-templates`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name, display_name: typed, description: null, settings }) });
                MM_GLUE.toast(C.t('uplift.toast.saved_template', {name: typed}));
                seLoadProfiles(model, host);
            } catch (e) { MM_GLUE.toast(C.t('uplift.toast.template_error', {msg: e.message})); }
        };
        const tt = document.createElement('div');
        tt.className = 'se-hint'; tt.textContent = 'Templates (global)';
        host.append(tt);
        trow.append(tsel, tApply, tSnap);
        host.append(trow);
    }
}

async function saveEditor() {
    if (!seModel) return;
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    seCaptureTab();
    if (!seIsBaseTab()) return saveProfileTab(panel);
    const msg = panel.querySelector('#se-msg');
    const errors = window.UpliftModelSpec.validate(seValues);
    if (errors.length) {
        msg.textContent = errors[0];
        MM_GLUE.toast(errors[0]);
        return;
    }
    const payload = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
    // boolean management flags ride the same PUT (real API accepts them too)
    if ('is_hidden' in seValues) payload.is_hidden = !!seValues.is_hidden;
    if ('is_favorite' in seValues) payload.is_favorite = !!seValues.is_favorite;
    msg.textContent = 'saving…';
    try {
        const r = await MM_GLUE.putModelSettings(seModel, payload);
        const savedNote = r._shadow ? 'saved ✓ (shadow)' : 'saved ✓';
        const note = r.requires_reload ? 'saved ✓ reload required' : savedNote;
        msg.textContent = note;
        MM_GLUE.toast(C.t('uplift.toast.settings_saved_model', {model: seModel}));
        if (r.requires_reload) {
            // same flow as Server Settings: SAVE becomes the reload action
            seOrig = JSON.parse(JSON.stringify(seValues));
            if (seFormModel) seFormModel.loaded = true;
            const b = document.getElementById('se-save');
            if (b) { b.classList.add('restart-mode'); b.classList.remove('queued');
                     b.textContent = '▶ RESTART MODEL';
                     b.onclick = async () => {
                        b.disabled = true;
                        // The server auto-unloads on save of a reload-key
                        // field, so the unload here usually 400s ("Model
                        // not loaded"). That is expected — tolerate it and
                        // go straight to load; only a failed LOAD is fatal.
                        try { await MM_GLUE.postModelAction(seModel, 'unload'); }
                        catch (_) { /* already unloaded by the server */ }
                        try { await MM_GLUE.postModelAction(seModel, 'load');
                              MM_GLUE.toast(C.t('uplift.toast.reloaded_with_settings', {model: seModel}));
                              closeEditor(); }
                        catch (e) { MM_GLUE.toast(C.t('uplift.toast.reload_failed', {msg: e.message})); b.disabled = false; }
                     }; }
            return;   // keep the popup open so RESTART MODEL stays visible
        }
        setTimeout(closeEditor, 1200);
    } catch (err) {
        msg.textContent = `error: ${err.message}`;
        MM_GLUE.toast(C.t('uplift.toast.save_failed', {msg: err.message}));
    }
}
async function saveProfileTab(panel) {
    const msg = panel.querySelector('#se-msg');
    const t = seTab();
    const name = (t.name || '').trim();
    if (!name) { MM_GLUE.toast(C.t('uplift.toast.profile_name_required')); return; }
    // full modelspec-shaped settings + inheritable validation via base merge
    const mergedForValidate = Object.assign({}, seBaseVals,
        JSON.parse(JSON.stringify(t.workVals || {})));
    seNormalizeKwargs(mergedForValidate);   // R10-6
    const errors = window.UpliftModelSpec.validate(mergedForValidate);
    if (errors.length) { msg.textContent = errors[0]; MM_GLUE.toast(errors[0]); return; }
    // R10-6: convert the tab's edited kwargs entries back to the raw
    // settings shape so the inheritance diff below can persist them
    if (t.workVals && t.workVals.ctKwargEntries) {
        const kw = window.UpliftModelSpec.buildPayload(t.workVals, seFormModel);
        t.workVals.chat_template_kwargs = kw.chat_template_kwargs;
        t.workVals.forced_ct_kwargs = kw.forced_ct_kwargs;
    }
    // only keys that differ from base persist (inheritance semantics)
    const ov = {};
    for (const [k, v] of Object.entries(t.workVals || {})) {
        if (k === 'ctKwargEntries' || k === 'model_alias') continue;
        if (v === undefined) continue;
        if (JSON.stringify(v) !== JSON.stringify(seBaseVals[k])) ov[k] = v;
    }
    msg.textContent = 'saving profile…';
    const body = { name, display_name: t.display_name || name, settings: ov,
        expose_as_model: !!t.expose_as_model, api_name: t.api_name || null };
    try {
        const path = `${API}/admin/api/models/${encodeURIComponent(seModel)}/profiles` +
            (t.profileId ? '/' + encodeURIComponent(t.profileId) : '');
        const r = await fetch(path, { method: t.profileId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t.profileId
                ? { settings: ov, display_name: t.display_name || name,
                    expose_as_model: !!t.expose_as_model, api_name: t.api_name || null }
                : body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok && /not found/i.test(String(d.detail || ''))) {
            // missing base model: classic routes 404 (no engine entry);
            // uplift's upsert create-or-updates the stored profile instead
            const r2 = await fetch(`${API}/uplift/api/models/${encodeURIComponent(seModel)}/profiles`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body) });
            const d2 = await r2.json().catch(() => ({}));
            if (!r2.ok) throw new Error(d2.detail || d2.error || String(r2.status));
        } else if (!r.ok) {
            throw new Error(d.detail || d.error || String(r.status));
        }
        MM_GLUE.toast(C.t('uplift.toast.saved_profile', {name: name}));
        t.profileId = name; t.dirty = new Set();
        t._origExpose = !!t.expose_as_model; t._origApi = t.api_name || '';
        t.name = name; t.display_name = name;
        t.origVals = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(t.workVals || {})));
        t._ovSnap = JSON.parse(JSON.stringify(ov));   // saved overrides are the new original
        msg.textContent = 'saved ✓';
        seRenderTabs(panel); seUpdateSaveBtn();
    } catch (e) {
        msg.textContent = 'error: ' + e.message;
        MM_GLUE.toast(C.t('uplift.toast.profile_save_failed', {msg: e.message}));
    }
}

let adminModels = [];
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
    localStorage.setItem('omlx-uplift-prefs-v1', JSON.stringify(prefs));
}

function stateRank(m) { return m.loaded ? 0 : (m.is_loading ? 1 : 2); }
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
    catch (_) { $('model-admin').innerHTML = '<div class="empty">API unreachable</div>'; return; }
    adminModels = models;
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
    if ((seModel || S.pendingWrites) && !force) return;
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
    if (onManager) renderTemplatesBox();
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
        table.innerHTML = '<div class="empty">No match</div>'; return; }
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
        // line 1: lamps left, then size + state pushed to the MM_GLUE.cell's right
        // edge — which is the card's middle line since the action box now
        // takes the right 50% (round 5). line 2: [type badge] + model id.
        const head1 = document.createElement('span'); head1.className = 'nrow1';
        const nmain = document.createElement('span'); nmain.className = 'nmain';
        const uid = MM_GLUE.cell(m.id); uid.className = 'uid';
        nmain.append(uid, copyBtn(m.id, 'Copy model id'));
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
                    () => MM_GLUE.putModelSettings(m.id, { is_favorite: !m.is_favorite }))),
            lamp('PINNED', !!m.pinned, m.pinned ? 'Unpin (allow unload)' : 'Keep loaded (pin)',
                // R10-B1: classic-compat write path — is_pinned via PUT
                // settings (the pin/unpin POSTs were mock-only sugar)
                () => flagWrite(m.id, { pinned: !m.pinned },
                    () => MM_GLUE.putModelSettings(m.id, { is_pinned: !m.pinned }))),
            lamp('DEFAULT', !!m.is_default,
                m.is_default ? 'Clear default model' : 'Make default model',
                () => {
                    if (!m.is_default) for (const o of adminModels)
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
            tapBtn(pr, () => MM_GLUE.postModelAction(m.id, 'load'));
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
        nmain.prepend(typeC);
        name.append(head1, nmain);
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
        val('CTX', s.max_context_window);
        val('MAX', s.max_tokens);
        tog('THINK', !!s.enable_thinking);
        tog('MTP', !!(s.mtp_enabled || s.vlm_mtp_enabled));
        tog('GRAMMAR', !!s.guided_grammar_enabled);
        if (s.trust_remote_code) bits.push({ txt: 'TRC ON', cls: 'danger' });
        tog('SPECPREFILL', !!s.specprefill_enabled);
        tog('DFLASH', !!s.dflash_enabled);
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
        aEdit.append(btn('EDIT', () => openEditor(m.id), 'Edit settings', true));
        box.append(aDel, chips, aEdit);
        row.append(name, box);
        mbox.append(row);
        const tree = aliasTree(m);       // aliases hang off the trunk below
        if (tree) mbox.append(tree);
        table.append(mbox);
    }
    if (missing.length) {
        const sep = MM_GLUE.cell('Missing \u2014 stored settings, model not on disk');
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
            name.append(head1, nmain);
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
            ed.onclick = () => openEditor(e.id);
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
                    edit.onclick = (ev) => { ev.stopPropagation(); openEditor(e.id, p.name); };
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
            if (seModel) closeEditor();
            renderModelAdmin(true);
        }
        catch (err) { ok.disabled = false; cancel.disabled = false; MM_GLUE.toast(C.t('uplift.toast.failed', {msg: err.message})); }
    };
    bar.append(document.createElement('span'), cancel, ok);
    box.append(h, sub, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.append(overlay);
    ok.focus();
}

/* RL-2 request inspector: detail modal with live tail. Timers run only
   while the modal is open; closed modal == no background polling. */
let inspectorOverlay = null;
async function openInspector(reqId) {
    if (inspectorOverlay) inspectorOverlay.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa'; box.style.minWidth = '560px';
    overlay.append(box);
    let timer = null, follow = true, closed = false;

    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function close() {
        if (closed) return; closed = true;
        stop(); overlay.remove();
        document.removeEventListener('keydown', esc);
        if (inspectorOverlay === overlay) inspectorOverlay = null;
    }
    function esc(e) { if (e.key === 'Escape') close(); }

    const h = document.createElement('h3');
    const head = document.createElement('div');   // header line: chips + counters
    head.className = 'se-hint';
    const loopBanner = document.createElement('div');   // RL-4 caution banner
    loopBanner.className = 'se-hint';
    loopBanner.style.cssText = 'color:var(--accent);display:none;margin:2px 0';
    loopBanner.textContent = '⚠ ' + C.t('uplift.req.loop_hint');
    const promptBox = document.createElement('div');
    const outputBox = document.createElement('div');
    const paramsBox = document.createElement('div');
    paramsBox.className = 'se-hint';
    const outPre = document.createElement('pre');
    outPre.style.cssText = 'max-height:240px;overflow:auto;white-space:pre-wrap;margin:4px 0;background:var(--panel);padding:6px';
    const promptPre = document.createElement('pre');
    promptPre.style.cssText = 'max-height:140px;overflow:auto;white-space:pre-wrap;margin:4px 0;background:var(--panel);padding:6px';
    // ISSUE-3: prompts used to dump 32 KB of head — the tail (what the
    // model actually answers) was off-screen. Default view = last ~1K chars
    // + a SHOW FULL toggle; token-id prompts render their decoded text.
    const PROMPT_TAIL_CHARS = 1000;
    let promptFull = false, promptText = '';
    const promptToggle = document.createElement('button');
    promptToggle.type = 'button'; promptToggle.className = 'se-btn';
    promptToggle.style.cssText = 'font-size:10px;padding:1px 6px;margin-left:6px';
    promptToggle.onclick = () => { promptFull = !promptFull; paintPrompt(); };
    function paintPrompt() {
        if (!promptText) { promptPre.textContent = ''; return; }
        const long = promptText.length > PROMPT_TAIL_CHARS;
        promptPre.textContent = (long && !promptFull)
            ? '…\n' + promptText.slice(promptText.length - PROMPT_TAIL_CHARS)
            : promptText;
        promptToggle.textContent = long
            ? (promptFull ? C.t('uplift.req.show_tail') : C.t('uplift.req.show_full'))
            : '';
        promptToggle.style.display = long ? '' : 'none';
        promptPre.scrollTop = (long && !promptFull) ? 0 : promptPre.scrollHeight;
    }
    const followLbl = document.createElement('label');
    followLbl.style.cssText = 'font-size:10px;color:var(--dim);user-select:none';
    const followChk = document.createElement('input');
    followChk.type = 'checkbox'; followChk.checked = true;
    followLbl.append(followChk, ' ' + C.t('uplift.req.follow'));
    // ISSUE-3: the label alone was cryptic — say what it actually does.
    followLbl.title = C.t('uplift.req.follow_title');
    followChk.onchange = () => { follow = followChk.checked; };
    // user scrolls up -> stop following automatically (reader, not robot)
    outPre.onscroll = () => {
        const atBottom = outPre.scrollHeight - outPre.scrollTop - outPre.clientHeight < 24;
        if (!atBottom && follow) { follow = false; followChk.checked = false; }
    };
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'se-btn act danger'; cancelBtn.textContent = C.t('uplift.req.cancel');
    cancelBtn.style.display = 'none';
    cancelBtn.onclick = async () => {
        cancelBtn.disabled = true;
        try {
            const res = await fetch(`${API}/admin/api/requests/${encodeURIComponent(reqId)}/cancel`, { method: 'POST' });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
            MM_GLUE.toast(C.t('uplift.toast.cancelled', { id: reqId.slice(0, 6) }));
        } catch (err) { MM_GLUE.toast(C.t('uplift.toast.cancel_failed', { msg: err.message })); }
        cancelBtn.disabled = false;
        refresh();
    };
    const closeBtn = document.createElement('button');
    closeBtn.className = 'se-btn act'; closeBtn.textContent = C.t('uplift.req.close');
    closeBtn.onclick = close;
    const bar = document.createElement('div'); bar.className = 'row buttons';
    bar.append(document.createElement('span'), cancelBtn, closeBtn);

    h.textContent = C.t('uplift.req.title', { id: reqId.slice(0, 8) });
    h.style.wordBreak = 'break-all';
    box.append(h, head, loopBanner);
    const pLabel = document.createElement('div'); pLabel.className = 'se-hint'; pLabel.textContent = C.t('uplift.req.prompt');
    const oLabel = document.createElement('div'); oLabel.className = 'se-hint';
    oLabel.textContent = C.t('uplift.req.output');
    box.append(pLabel, promptBox, oLabel, outputBox, paramsBox, bar);
    pLabel.append(promptToggle);
    promptBox.append(promptPre); outputBox.append(followLbl, outPre);

    function setBlock(pre, block, truncLabel) {
        if (!block) { pre.textContent = C.t('uplift.req.none'); return; }
        pre.textContent = block.text + (block.truncated ? `\n… ${truncLabel}` : '');
    }
    /* ISSUE-3 prompt pick: decoded token text wins when the server decoded
       the stored id sample; otherwise the raw captured string. A tail-
       sampled decode says so honestly (the middle of a long prompt is not
       shown, only head+tail were kept). */
    function setPrompt(d) {
        const dec = d.prompt_decoded;
        promptFull = false;
        if (dec && dec.text) {
            const bits = [];
            if (dec.sample_truncated) bits.push(C.t('uplift.req.decoded_gap'));
            if (d.prompt && d.prompt.truncated) bits.push(C.t('uplift.req.truncated'));
            promptText = dec.text + (bits.length ? `\n… ${bits.join(' · ')}` : '');
            paintPrompt();
            return;
        }
        if (dec && dec.note) {
            promptText = (d.prompt && d.prompt.text) || '';
            paintPrompt();
            const n = document.createElement('div');
            n.className = 'se-hint'; n.textContent = dec.note;
            promptBox.replaceChildren(promptPre, n);
            return;
        }
        const b = d.prompt;
        promptText = (b && b.text) || '';
        if (!promptText) {
            promptPre.textContent = C.t('uplift.req.none');
            promptToggle.style.display = 'none';
            return;
        }
        promptText += (b.truncated ? `\n… ${C.t('uplift.req.truncated')}` : '');
        paintPrompt();
    }
    async function refresh() {
        if (closed) return;
        let d;
        try {
            d = await MM_GLUE.fetchJson(`${API}/admin/api/requests/${encodeURIComponent(reqId)}`);
        } catch (err) { head.textContent = C.t('uplift.req.load_failed', { msg: err.message }); return; }
        if (closed) return;
        if (!d.found) {
            head.textContent = C.t('uplift.req.not_found');
            outPre.textContent = d.note || ''; promptPre.textContent = '—';
            promptText = ''; promptToggle.style.display = 'none';
            paramsBox.textContent = ''; cancelBtn.style.display = 'none';
            stop();   // honest empty state, never a spinner forever
            return;
        }
        const r = d.row || {};
        const bits = [r.model, r.state];
        if (r.prompt_tokens) bits.push(`in ${C.fmtCompact(r.prompt_tokens)}`);
        if (r.completion_tokens) bits.push(`out ${C.fmtCompact(r.completion_tokens)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(1)} t/s`);
        if (d.timings && d.timings.total_s !== undefined) bits.push(`${d.timings.total_s.toFixed(1)}s`);
        if (r.error) bits.push(`error: ${r.error}`);
        if (r.finish) bits.push(`finish: ${r.finish}`);
        if (d.source) bits.push(C.t('uplift.req.source.' + d.source));
        head.textContent = bits.filter(Boolean).join(' · ');
        setPrompt(d);
        setBlock(outPre, d.output, C.t('uplift.req.truncated'));
        if (follow && d.output) outPre.scrollTop = outPre.scrollHeight;
        paramsBox.textContent = d.params ? C.t('uplift.req.params') + ': ' + JSON.stringify(d.params) : '';
        loopBanner.style.display = r.loop_hint ? '' : 'none';
        cancelBtn.style.display = d.live ? '' : 'none';
        if (timer && !d.live) stop();   // request ended; keep last render visible
    }

    document.addEventListener('keydown', esc);
    overlay.onclick = e => { if (e.target === overlay) close(); };
    document.body.append(overlay);
    inspectorOverlay = overlay;
    await refresh();
    timer = setInterval(refresh, 2000);   // only while open AND live
}

/* ---- request-history search (RL-3): extracted to uplift_reqsearch.js
   (PH2-1 stage 4); reached from the feed through window.Uplift.reqSearch. ---- */

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
        if (!noRerender) renderModelAdmin(true); else b.disabled = false;
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
        mtp: ['mtp_num_draft_tokens'],
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
        edit.onclick = (e) => { e.stopPropagation(); openEditor(m.id, profileName); };
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
            edit.onclick = (e) => { e.stopPropagation(); openEditor(m.id, p.name); };
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
/* Global templates (global_templates.json): slim model-style rows. The old
   description+date view said nothing useful (round 5) — a template is a
   settings bundle, so the row gets EDIT (opens the same editor on the
   template) and DELETE SETTINGS (removes the stored bundle). */
function renderTemplatesBox() {
    const host = $('ms-templates');
    if (!host) return;
    MM_GLUE.fetchJson(`${API}/admin/api/profile-templates`)
        .then(d => d.templates || []).catch(() => []).then(templates => {
        host.innerHTML = '';   // empty string + static markup only, no user data
        if (!templates.length) { host.innerHTML = '<div class="empty">No global templates</div>'; return; }
        window.__seTemplates = templates;
        for (const t of templates) {
            const row = document.createElement('div'); row.className = 'urow admin tpl';
            const name = document.createElement('span'); name.className = 'uname';
            const head1 = document.createElement('span'); head1.className = 'nrow1';
            const badge = document.createElement('span');
            badge.className = 'typebadge t-tpl'; badge.textContent = 'TEMPLATE';
            const nmain = document.createElement('span'); nmain.className = 'nmain';
            const uid = MM_GLUE.cell(t.display_name || t.name); uid.className = 'uid';
            // round 8 item 4: show the friendly name like models do — the
            // raw t-… id is an internal key (shown in EDIT/delete dialogs)
            uid.title = t.name;
            nmain.append(badge, uid);   // round 6 item 10: no copy icon for the internal id
            const desc = MM_GLUE.cell(t.description || ''); desc.className = 'dim umeta tpl-desc';
            head1.append(desc);
            name.append(nmain, head1);
            const box = document.createElement('span');
            box.className = 'settings-box hrow tpl-box solo';
            const aDel = document.createElement('span'); aDel.className = 'act-col';
            const del = document.createElement('button');
            del.className = 'se-btn act danger'; del.textContent = 'DELETE SETTINGS';
            del.title = C.tf('uplift.ui.delete_global_template',
                'Delete this global template (stored settings bundle)');
            del.onclick = () => confirmDialog('Delete template',
                `Delete the global template "${t.display_name || t.name}"? Models and profiles already created from it keep their own settings.`,
                async () => {
                    const r = await fetch(`${API}/admin/api/profile-templates/${encodeURIComponent(t.name)}`,
                        { method: 'DELETE' });
                    if (!r.ok) { const d = await r.json().catch(() => ({}));
                        throw new Error(d.detail || String(r.status)); }
                }, `Deleted template: ${t.display_name || t.name}`);
            aDel.append(del);
            const aEdit = document.createElement('span'); aEdit.className = 'act-col right';
            const ed = document.createElement('button');
            ed.className = 'se-btn act edit'; ed.textContent = 'EDIT';
            ed.title = C.tf('uplift.ui.edit_global_template', 'Edit this template');
            ed.onclick = () => openEditor(null, null, t.name);
            aEdit.append(ed);
            box.append(aDel, document.createElement('span'), aEdit);
            row.append(name, box);
            host.append(row);
        }
    });
}
$('ma-filter').oninput = () => {
    // the filter felt dead while the editor was open: close the editor on filter
    if (seModel) closeEditor();
    renderModelAdmin(true);
};
$('ma-type').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };
$('ma-only-loaded').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };
$('ma-only-fav').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };
$('ma-present-only').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };

window.Uplift.modelmgr = {
    render: renderModelAdmin,
    renderTemplates: renderTemplatesBox,
    openInspector: openInspector,
    get adminModels() { return adminModels; },
    get seModel() { return seModel; },
};
})();
