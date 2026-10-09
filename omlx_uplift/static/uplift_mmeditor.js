/* SPLIT-2 stage 5 (uplift_modelmgr.js split): the spec-driven settings
   editor — profile tabs, kwargs, grammar parsers, runtime divergence,
   deferred runtime settings, save/restart flows. All se* state is
   editor-private; the facade in uplift_modelmgr.js re-exports
   openEditor/closeEditor/seModel for the table, chips and templates
   files (MMF getters resolve at call time). Loads after
   uplift_mmtable.js, BEFORE uplift_modelmgr.js. Exports
   window.Uplift.mmEditor. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const API = S.API;
const MM_GLUE = {
    toast: D.toast,
    fetchJson: D.fetchJson,
    get stats() { return window.Uplift._modelGlue.stats; },
    get SECRET_KEYS() { return window.Uplift._modelGlue.SECRET_KEYS; },
    get gsDisplay() { return window.Uplift._modelGlue.gsDisplay; },
    cell: D.cell,
    get putModelSettings() { return window.Uplift._modelGlue.putModelSettings; },
    get modelSettingsFields() { return window.Uplift._modelGlue.modelSettingsFields; },
    get postModelAction() { return window.Uplift._modelGlue.postModelAction; },
    emptyMsg: D.emptyMsg,
};
const MM_STATE = window.Uplift.state;   // 'S' is shadowed by UpliftModelSpec in editor funcs
const CHIPS = window.Uplift.mmChips;
const MM_TABLE = window.Uplift.mmTable;
const renderModelAdmin = (...a) => MM_TABLE.render(...a);
const confirmDialog = (...a) => MM_TABLE.confirmDialog(...a);
const MM_TPL = window.Uplift.mmTemplates;
/* ---------------- model manager (Models tab) ---------------- */
/* S.settingsIdx lives in window.Uplift.state: the stored-settings page in
   uplift.js refreshes it after writes (PH2-1 stage 5). Survives MM_STATE.adminModels
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
/* U41 two-phase save (user design): phase 1 SAVE persists EVERYTHING —
   live keys go through the classic sparse PUT, engine-rebuild keys cannot
   (the server auto-unloads on their mere presence) so they persist in the
   uplift deferred-settings store; phase 2 RESTART MODEL pushes the full
   payload (classic auto-unload fires) and clears the deferred record. */
let seDeferred = {};                 // stored runtime payload awaiting phase 2 (open model)
const seDeferKeys = () => new Set([...window.UpliftModelSpec.RUNTIME_SETTING_KEYS,
                                   'model_type_override']);
async function seLoadDeferred(model) {
    try {
        seDeferred = (await MM_GLUE.fetchJson(
            `${API}/uplift/api/models/${encodeURIComponent(model)}/deferred-settings`)).settings || {};
    } catch (_) { seDeferred = {}; }
}
async function sePersistDeferred(model, settings) {
    // FE-2: postJson — the old fire-and-forget POST showed 'saved ✓' even
    // when the deferred write failed; the caller's catch now sees it.
    await D.postJson(`${API}/uplift/api/models/${encodeURIComponent(model)}/deferred-settings`,
        { settings });
    seDeferred = settings;
}
async function seClearDeferred(model) {
    if (!Object.keys(seDeferred).length) return;
    seDeferred = {};
    try {
        await D.deleteJson(`${API}/uplift/api/models/${encodeURIComponent(model)}/deferred-settings`);
    } catch (_) { /* best-effort; next load re-syncs from server */ }
}
function seDirtyKeys() {                     // dirty keys of the ACTIVE tab
    const t = seTab();
    return t ? [...t.dirty] : [];
}
/* item 3: honest save. Keys that would rebuild a loaded engine (runtime
   signature, replica in modelspec) or flip the engine type. Everything else
   saves live — no reload, no lie. */
function seIsRuntimeKey(k) {
    return k === 'model_type_override' ||
        window.UpliftModelSpec.RUNTIME_SETTING_KEYS.has(k);
}
function seRuntimeDirtyKeys() { return seDirtyKeys().filter(seIsRuntimeKey); }
function sePlainDirtyKeys() { return seDirtyKeys().filter(k => !seIsRuntimeKey(k)); }
function seModelIsLoaded() {
    return !!(seFormModel && !seFormModel._missing &&
              (seFormModel.loaded || seFormModel.is_loading));
}
function seUpdateSaveBtn() {
    const b = document.getElementById('se-save'); if (!b) return;
    const rb = document.getElementById('se-restart');
    const n = seDirtyKeys().length;
    const onProfile = !seIsBaseTab();
    // U41 two-phase (user design): SAVE commits EVERY dirty key — live keys
    // via the sparse classic PUT, runtime keys via the uplift deferred
    // store (the classic PUT auto-unloads on their presence). It is never
    // blocked. RESTART MODEL is phase 2: push everything and reload; it is
    // offered while anything waits for a reload — deferred (saved) or dirty.
    const loaded = seModelIsLoaded();
    const pending = onProfile ? 0 : Object.keys(seDeferred).length;
    const runtimeDirty = !onProfile && loaded ? seRuntimeDirtyKeys().length : 0;
    const awaitingReload = pending + runtimeDirty;
    b.classList.toggle('queued', n > 0);
    b.classList.toggle('restart-mode', false);
    const tabTxt = onProfile ? ' PROFILE' : '';
    b.textContent = n
        ? ('SAVE' + tabTxt + ' (' + n + ')')
        : (onProfile ? 'SAVE PROFILE' : 'SAVE');
    b.title = runtimeDirty || pending
        ? C.tf('uplift.se.save_split_title',
            'SAVE stores everything now; settings that rebuild the engine apply when you press RESTART MODEL.')
        : '';
    b.disabled = n === 0;
    if (rb) {
        rb.hidden = awaitingReload === 0;
        // unloaded base tab: SAVE already stores everything, RESTART MODEL
        // additionally loads the engine with them now
        rb.textContent = (loaded ? '▶ RESTART MODEL (' : '▶ LOAD MODEL (') + awaitingReload + ')';
        rb.title = C.tf('uplift.se.restart_title',
            'Applies the stored settings by reloading the model now');
    }
    renderEdChanges();
    refreshDivergence();
}
/* CHANGES box above the editor buttons: yaml-style key: old -> key: new,
   including inherit flips for profile tabs and the expose/api lines */
function renderEdChanges() {
    /* FE-4: line FORMAT + box come from uplift_dirty.js (shared with the
       global settings tab); the entries (inherit-snapshot orig resolution,
       expose/api flips) stay here — this editor's state model. Canonical
       rendering picks gsys's richer form (.ch-new accent half, secret old
       side '•••', new side '••• CHANGED'). */
    const box = document.getElementById('se-changes'); if (!box) return;
    const t = seTab();
    const entries = [];
    const disp = MM_GLUE.gsDisplay;
    const sec = k => MM_GLUE.SECRET_KEYS.has(k);
    if (seIsBaseTab()) {
        for (const k of t.dirty)
            entries.push({ key: k, orig: seOrig[k], cur: seValues[k], isSecret: sec(k), display: disp });
    } else {
        for (const k of t.dirty) {
            const o = SE_INHERIT_KEYS.has(k) ? seOvSnap(t)[k] : t.origVals[k];
            entries.push({ key: k, orig: o, cur: seValues[k], isSecret: sec(k), display: disp });
        }
    }
    if (!seIsBaseTab()) {
        if ((t._origExpose || false) !== !!t.expose_as_model)
            entries.unshift({ key: 'expose_as_model', orig: !!t._origExpose,
                              cur: !!t.expose_as_model, isSecret: false, display: disp });
        if ((t._origApi || '') !== (t.api_name || ''))
            entries.unshift({ key: 'api_name', orig: t._origApi, cur: t.api_name || '',
                              isSecret: false, display: disp });
    }
    window.UpliftDirty.renderChangesBox(box, entries, C.tf);
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
let seBaseRaw = {};         // raw stored base settings dict (fetched in openEditor)
/* FE-6 step 4: one module store for the data that travelled on
   window globals (__seProfiles / __sePresets / __seTemplates /
   __seProfileDivergence) —
   globals were the only channel between functions 1000 lines apart.
   Exposed as Uplift.mmData (mmtemplates writes templates into it). */
const MM_DATA = {
    profiles: [],      // stored profiles of seModel (fetched in openEditor)
    presets: null,     // bundled global presets, lazily fetched + cached
    templates: [],     // profile-templates (renderTemplatesBox also fills)
    divergence: [],    // [{name, display_name, api_name, diff:[…]}]
};
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
    // FE-6 step 1: DOM shapes come from uplift_widgets.js (golden-pinned
    // by tests/widgets-registry.test.cjs); kind normalization + event name
    // ride back from the builder. Host keeps ALL state rules below.
    const w = window.UpliftWidgets.build(kind, {
        // inheritable kinds read the tab's OVERRIDES map, not seValues —
        // same source v1's three inheritable branches used
        value: kind.startsWith('inheritable-')
            ? (seTab() && seTab().overrides[key])
            : seValues[key],
        options: opts && opts.options
            ? opts.options.map(o => ({ value: o.value,
                text: C.tf('uplift.se.' + key + '.opt.' + o.value,
                           o.label != null ? o.label : o.value) }))
            : null,
        selected: seValues[key],
        picker: (opts && opts.picker) ? seValues[key] : null,
        min: opts && opts.min, max: opts && opts.max, step: opts && opts.step,
        checked: seValues[key] === true,
        baseVal: seBaseVals ? seBaseVals[key] : undefined,
        // mmeditor numbers ALWAYS carry the U3 hint (v1): pass '' to opt
        // into the '(default)' fallback, never leave the rule un-armed
        effHint: (opts && opts.effHint !== undefined) ? opts.effHint : '',
    });
    let input = w.el;
    kind = w.kind;                      // inheritable-* normalize like v1
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
        else if (kind === 'select') {
            // U41: numeric selects (turboquant bits) must store numbers —
            // the runtime signature compares values, not strings. Model ids
            // and '' are not finite numbers and stay strings.
            const nv = Number(input.value);
            seValues[key] = input.value !== '' && Number.isFinite(nv) ? nv : input.value;
        }
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
            // FE-4: visuals via the shared dirty machine (uplift_dirty.js)
            const changed = window.UpliftDirty.applyRowState({
                orig, cur: seValues[key], row: lab2,
                isSecret: MM_GLUE.SECRET_KEYS.has(key),
                isRestart: seIsRuntimeKey(key),
                display: MM_GLUE.gsDisplay });
            if (changed) t && t.dirty.add(key); else t && t.dirty.delete(key);
        }
        seUpdateSaveBtn();
        if (opts && opts.onChange) opts.onChange(seValues);
        // UX-2: a master toggle flips its gated subtree live — no form
        // re-render, every control keeps its slot
        else seRefreshGates(document.getElementById('se-fields') || document);
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
        // FE-6 step 3: write the reverted value back into THIS control and
        // clear this row's marks — v1 rebuilt every field (scroll jump, and
        // any other half-typed value re-rendered from stale tab state).
        if (input.type === 'checkbox') input.checked = !!seValues[key];
        else input.value = seValues[key] == null ? '' : seValues[key];
        window.UpliftDirty.applyRowState({
            orig: origV, cur: seValues[key], row: label,
            isSecret: MM_GLUE.SECRET_KEYS.has(key),
            isRestart: seIsRuntimeKey(key),
            display: MM_GLUE.gsDisplay });
        // UX-2: a revert of a master switch must re-grey its gated family
        seRefreshGates(document.getElementById('se-fields') || document);
        seUpdateSaveBtn();
    };
    // the NEW value is the live input itself; the slot only carries the
    // |original| chip pointing at it, so the input never jumps
    rd.append(o, document.createTextNode('→'));
    // ...except checkboxes: an unchecked box reads as NOTHING, so the user
    // saw 'true → ⍰' on every toggle. Give checkbox rows an explicit
    // new-value chip (filled by UpliftDirty.applyRowState via .diff-n).
    if (input.type === 'checkbox') {
        const n = document.createElement('span'); n.className = 'diff-n';
        rd.append(n);
    }
    slot.append(rd);
    const ctlBox = document.createElement('span'); ctlBox.className = 'se-ctl';
    ctlBox.append(input);
    label.append(name, slot, ctlBox);
    // item 8: every control whose key feeds the engine runtime signature is a
    // reload trigger on a loaded model — badge it at definition, all fields.
    if (key === 'model_type_override' || window.UpliftModelSpec.RUNTIME_SETTING_KEYS.has(key))
        name.append(' ', seReloadBadge([key]));
    if (opts && opts.hint) {
        const h = document.createElement('small');
        h.className = 'se-hint';
        h.textContent = C.tf('uplift.se.' + key + '.hint', opts.hint);
        label.append(h);
    }
    return label;
}

/* UX-2 (user 2026-10-03): dependent controls are ALWAYS rendered and
   greyed while their master switch is off — never popped into existence.
   The old pattern re-rendered the whole form on every master toggle: the
   checkbox jumped into a different box ('the section insides change
   places'), a full-width row2 shoved its neighbour to the next line
   (TurboQuant vs 'SSD n-gram offload'), and on a profile tab the
   re-render rebuilt from a stale workVals snapshot, so the toggle snapped
   back (DFlash bug). Mark the host subtree with its master key instead;
   seRefreshGates() enables/disables it in place. */
function seGate(host, key) {
    host.dataset.gate = key;
    return host;
}
/* UX-5 (user 2026-10-03): a master toggle and its dependent knobs are ONE
   family band. The band spans the pair grid and reuses the parent's column
   tracks via subgrid, so the knob sits on the master's line in exactly the
   column every other row aligns to, and auto-flow can never scatter them
   diagonally (UX-4's loose cells did). Tint + accent trunk carry the
   grouping distinction (UX-3 destroyed the child rows and broke the grid;
   do not resurrect either). Knobs keep their own .se-row: own label, hint,
   |original| chip and reload badge; data-gate lets seRefreshGates() grey +
   disable them in place. */
function seFam(grid, masterKey, masterRow, kids) {
    const fam = document.createElement('div');
    fam.className = 'se-fam';
    fam.dataset.fam = masterKey;
    fam.append(masterRow);
    for (const kid of kids) fam.append(seGate(kid, masterKey));
    grid.append(fam);
    return fam;
}

function seGatedDiv(cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    return d;
}
function seGateEnabled(host) {
    for (let n = host.closest('[data-gate]'); n;
            n = n.parentElement && n.parentElement.closest('[data-gate]'))
        if (seValues[n.dataset.gate] !== true) return false;
    return true;
}
function seRefreshGates(root) {
    root.querySelectorAll('[data-gate]').forEach(host => {
        const on = seGateEnabled(host);
        host.classList.toggle('se-off', !on);
        host.querySelectorAll('input, select, textarea, button').forEach(i => {
            i.disabled = !on;
        });
    });
}

/* UX-2 (user 2026-10-03): row2() retired — the toggle+dependent pair box
   it built reflowed the form when a master switch flipped. Dependent
   controls now live in gated sub-blocks that are always rendered. */

function seReloadBadge(keys) {
    // item 8: a settings control that feeds the engine runtime signature
    // reloads a loaded model on change — badge it.
    const b = document.createElement('span');
    b.className = 'se-reload-badge';
    b.textContent = '⟳ RELOAD';
    b.title = C.tf('uplift.se.reload_badge.title',
        'Changing this setting rebuilds the loaded engine (model reload).');
    return b;
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
    // UX-1 (user 2026-10-03): pull live values into the tab BEFORE reading
    // it back. workVals used to refresh only on tab switch, so every
    // in-place rebuild (kwargs add/remove, profile/template apply) merged
    // from a stale snapshot and the control the user just changed snapped
    // back (DFlash toggle 'does nothing' on a profile tab).
    seCaptureTab();
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
    /* ---- context & limits (R10-5: pulled out of Basic/Advanced) ---- */
    section('Context & Limits');
    let g = grid();
    g.append(seBind('number', 'max_context_window', { label: 'Ctx Window', step: 1 }));
    g.append(seBind('number', 'max_tokens', { label: 'Max Tokens', step: 1 }));
    g.append(seBind('number', 'ttl_seconds', { label: 'TTL (Seconds)', step: 1 }));
    g.append(seBind('bool', 'trust_remote_code', { label: 'Trust Remote Code',
        hint: 'Lets the model repo run arbitrary Python at load. Only enable for trusted repos.' }));

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
        seFam(g, 'enableThinkingBudget',
            seBind('bool', 'enableThinkingBudget', { label: 'Thinking Budget',
                hint: 'Limit thinking tokens for reasoning models.' }),
            [seBind('number', 'thinking_budget_tokens',
                { label: C.tf('uplift.ui.thinking_budget_tokens', 'Thinking budget (tokens)'), min: 1, step: 1 })]);
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
        seFam(g, 'enableToolResultLimit',
            seBind('bool', 'enableToolResultLimit', { label: 'Limit Tool Result Tokens',
                hint: 'Truncate large tool results (e.g. file reads) to a token limit.' }),
            [seBind('number', 'max_tool_result_tokens',
                { label: C.tf('uplift.ui.tool_result_token_limit', 'Tool result token limit'), min: 1, step: 1 })]);
    }

    section('Sampling');
    g = grid();
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

    /* ---- acceleration (kept: engine-level, not spec decode) ---- */
    section('Acceleration');
    g = grid();
    if (!S.isDiffusion(m)) {
        // UX-5: one family band [toggle | frequency]; the knob keeps its
        // own ⟳RELOAD badge — hot-apply master, reload-triggered child.
        seFam(g, 'enableIndexCache',
            seBind('bool', 'enableIndexCache', { label: 'Index Cache',
                hint: 'Skip redundant indexer computation in DSA layers (DeepSeek V3/GLM-5).' }),
            [seBind('number', 'index_cache_freq',
                { label: C.tf('uplift.ui.frequency_every_nth_layer_keeps_indexer', 'Frequency (every Nth layer keeps indexer)'), min: 1, step: 1 })]);
    }
    if (seValues.turboquant_kv_enabled !== undefined) {
        // U41: no diffusion gate — classic shows TurboQuant for every model
        // (parity, user: "turboquant toggle is missing in model settings")
        // U41: classic's fixed ladder, not a 0.25-step free number
        // (user: bits can't be quarters)
        // UX-5 (user): ONE band [toggle | bits] — grouped, on the shared
        // column tracks, bits greyed + disabled until the toggle is on
        seFam(g, 'turboquant_kv_enabled',
            seBind('bool', 'turboquant_kv_enabled', { label: 'TurboQuant KV Cache',
                hint: 'Compress KV cache using vector quantization. Lower bits = more compression.' }),
            [seBind('select', 'turboquant_kv_bits',
                { label: C.tf('uplift.ui.bits_per_channel', 'Bits per channel'),
                  options: [2, 2.5, 3, 3.5, 4, 6, 8].map(v => ({ value: String(v), label: v + '-bit' })) })]);
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
        seFam(g, 'moe_expert_offload_enabled',
            seBind('bool', 'moe_expert_offload_enabled', { label: 'MoE Expert Offload',
                hint: 'Stream Mixture-of-Experts weights from the checkpoint on demand, keeping only part resident.' }),
            [seBind('number', 'moe_expert_offload_resident_fraction',
                { label: C.tf('uplift.ui.resident_experts_fraction', 'Resident experts (fraction)'), min: 0.01, max: 1, step: 0.01 })]);
    }
    if (S.isQwenOqA8(m)) {
        seFam(g, 'qwen35_oq_a8_enabled',
            seBind('bool', 'qwen35_oq_a8_enabled', { label: 'Qwen INT8 Activation Prefill',
                hint: 'Experimental GPU INT8 activation quantization for supported Q4/Q5/Q8 prefill.' }),
            [seBind('number', 'qwen35_oq_a8_min_tokens',
                { label: C.tf('uplift.ui.minimum_prompt_tokens', 'Minimum prompt tokens'), min: 1, step: 1 })]);
    }
    if (m.ane_prefill_backend && !S.isDiffusion(m)) renderAne(container, g);

    /* ---- speculative decode (R10-5 rename) ---- */
    section('Speculative Decoding');
    g = grid();
    const models = MM_STATE.adminModels.length ? MM_STATE.adminModels : [];
    const S_ = window.UpliftModelSpec;
    if (!S_.isDiffusion(m)) {
        if (seValues.specprefill_enabled !== undefined) {
            const pool = S_.specprefillCandidates(models, m.id).map(x => ({ value: x.id }));
            // UX-5 (user): ONE band, four cells, TWO balanced lines —
            // [toggle | draft model] then [keep rate | threshold]
            seFam(g, 'specprefill_enabled',
                seBind('bool', 'specprefill_enabled', { label: 'SpecPrefill' }),
                [seBind('select', 'specprefill_draft_model',
                    { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }),
                 seBind('select', 'specprefill_keep_pct', { label: 'Keep Rate', options: [
                    { value: '0.1', label: '10% — Aggressive (~5-7x, some quality loss)' },
                    { value: '0.2', label: '20% — Balanced (~3x, recommended)' },
                    { value: '0.25', label: '25% — Conservative+ (~2.5x)' },
                    { value: '0.3', label: '30% — Conservative (~2.2x)' },
                    { value: '0.4', label: '40% — Mild (~1.8x)' },
                    { value: '0.5', label: '50% — Minimal (~1.5x)' }], picker: true }),
                 seBind('number', 'specprefill_threshold',
                    { label: C.tf('uplift.ui.threshold_tokens', 'Threshold (tokens)'), min: 1024, max: 131072, step: 1024 })]);
        }
        if (seValues.mtp_enabled !== undefined) {
            // UX-5: one band [toggle | depth] (both keys share reload
            // semantics); no re-render, no reflow
            seFam(g, 'mtp_enabled',
                seBind('bool', 'mtp_enabled', { label: 'Lightning MTP',
                    hint: m.mtp_compatible
                        ? "Drafts several tokens per step with the model's built-in MTP head."
                        : (m.mtp_compatibility_reason || 'Not compatible with this model') }),
                [seBind('select', 'mtp_adaptive_max_depth', {
                    label: C.tf('uplift.se.mtp_depth', 'Adaptive max depth'),
                    hint: C.tf('uplift.se.mtp_depth.hint',
                        'Automatically adjusts the draft depth up to the selected maximum.'),
                    options: [{ value: '3', label: '3 tokens (Default)' },
                              ...[4, 5, 6].map(n => ({ value: String(n),
                                  label: C.tf('uplift.se.mtp_depth.opt.' + n, n + ' tokens')}))]})]);
        }
        const drafterType = (m.config_model_type || '').toLowerCase().replace(/-/g, '_');
        if (seValues.vlm_mtp_enabled !== undefined &&
            S_.VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES.has(drafterType)) {
            g.append(seBind('bool', 'vlm_mtp_enabled', { label: 'VLM MTP',
                hint: 'Speculative decoding via an external MTP drafter model.' }));
            const sb = seGate(sub(g), 'vlm_mtp_enabled');
            const pool = S_.vlmMtpDrafters(models, m.id).map(x => ({ value: x.id }));
            sb.append(seBind('select', 'vlm_mtp_draft_model', { label: 'Drafter model', options: [
                { value: '', label: 'Select an assistant or MTP drafter…' }, ...pool], picker: true }));
            sb.append(seBind('number', 'vlm_mtp_draft_block_size',
                { label: C.tf('uplift.ui.draft_block_size_tokens_per_round_blank_4', 'Draft block size (tokens per round, blank = 4)'), step: 1 }));
        }
        // round 6 item 4: DFlash is its own section, not grouped under
        // Speculative Decoding (different mechanism — block diffusion).
        // Header only when the field set actually exists for this model.
        if (seValues.dflash_enabled !== undefined) {
            section('DFlash');
            g = grid();
            // UX-2: the whole knob family is always rendered and greyed
            // while DFlash is off (old reflow popped it into existence,
            // and on a profile tab the toggle snapped back — stale workVals)
            g.append(seBind('bool', 'dflash_enabled', { label: 'DFlash',
                hint: m.dflash_compatible === false ? (m.dflash_compatibility_reason || 'not compatible') : '' }));
            const sb = seGate(sub(g), 'dflash_enabled');
            const pool = S_.dflashCandidates(models, m.id).map(x => ({ value: x.id }));
            sb.append(seBind('select', 'dflash_draft_model',
                { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
            sb.append(seBind('bool', 'dflash_draft_quant_enabled', { label: 'Quantization' }));
            const quantBox = seGate(seGatedDiv('se-sub'), 'dflash_draft_quant_enabled');
            quantBox.append(
                seBind('select', 'dflash_draft_quant_weight_bits', { label: 'Weight Bits', options: [
                    { value: 2, label: '2-bit' }, { value: 4, label: '4-bit' }, { value: 8, label: '8-bit' }], picker: true }),
                seBind('select', 'dflash_draft_quant_activation_bits', { label: 'Activation Bits', options: [
                    { value: 16, label: '16-bit' }, { value: 32, label: '32-bit' }], picker: true }),
                seBind('number', 'dflash_draft_quant_group_size', { label: 'Group Size', min: 16, max: 256, step: 16 }));
            sb.append(quantBox);
            sb.append(seBind('number', 'dflash_max_ctx', { label: 'Max Context (fallback threshold)', step: 1 }));
            sb.append(seBind('bool', 'dflash_in_memory_cache', { label: 'In-memory cache' }));
            const cacheBox = seGate(seGatedDiv('se-sub'), 'dflash_in_memory_cache');
            cacheBox.append(
                seBind('number', 'dflash_in_memory_cache_max_entries',
                    { label: C.tf('uplift.ui.in_memory_cache_max_entries', 'In-memory cache max entries'), min: 1, step: 1 }),
                seBind('number', 'dflash_in_memory_cache_max_gib',
                    { label: C.tf('uplift.ui.in_memory_cache_size_gib', 'In-memory cache size (GiB)'), min: 1, step: 1,
                      hint: 'Byte budget for L1 snapshots; LRU evicts when exceeded.' }));
            if (seValues.dflash_ssd_cache_available) {
                cacheBox.append(seBind('bool', 'dflash_ssd_cache', { label: 'SSD cache',
                    hint: 'Requires in-memory cache to be enabled.' }));
                seGate(seGatedDiv(), 'dflash_ssd_cache').append(
                    seBind('number', 'dflash_ssd_cache_max_gib',
                        { label: C.tf('uplift.ui.ssd_cache_size_gib', 'SSD cache size (GiB)'), min: 1, step: 1 }));
                cacheBox.appendChild(cacheBox.lastChild);
            }
            sb.append(cacheBox);
            sb.append(seBind('number', 'dflash_draft_window_size', { label: 'Draft window size' }));
            sb.append(seBind('number', 'dflash_draft_sink_size', { label: 'Draft sink size', min: 0, step: 1 }));
            sb.append(seBind('number', 'dflash_block_size', { label: 'Runtime block size', step: 1 }));
            sb.append(seBind('select', 'dflash_verify_mode', { label: 'Verify mode', options: [
                { value: 'adaptive', label: 'adaptive (default)' },
                { value: 'dflash', label: 'dflash' },
                { value: 'ddtree', label: 'ddtree' }], picker: true }));
        }
    }

    /* ---- grammar (R10-5: own section, wide mono textarea) ---- */
    section('Grammar');
    g = grid();
    if (!S.isDiffusion(m)) {
        const ggWrap = seBind('textarea', 'guided_grammar', {
            // FE-7: label key, NOT uplift.ui.guided_grammar — that one is
            // the banner string 'GUIDED GRAMMAR — ' built for the expand
            // head (:1014); as a field label it hung the em-dash off every
            // non-EN locale.
            label: C.tf('uplift.se.guided_grammar', 'Guided Grammar'),
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
            hint: 'Apply an EBNF grammar by default for this model.'
            // UX-5: no manual enable dance anymore — the well below is a
            // gated box and the default seRefreshGates() path handles it
            }));
        // UX-6 (user 2026-10-03): the example dropdown and EXPAND sat in the
        // textarea's own flex ROW — three side-by-side items squeezed the
        // EBNF well to a third of its box and nothing lined up. Now: textarea
        // full width on its own line, example + EXPAND in an action row
        // BELOW it (UX-6c: example at the left edge, EXPAND at the right
        // edge — under the textarea's bottom-right corner).
        const ggActions = document.createElement('div');
        ggActions.className = 'grammar-actions';
        ggActions.append(presetSel, expandB);
        ggWrap.querySelector('.se-ctl').append(ggActions);
        // UX-5 (user): the whole grammar well (textarea + presets + EXPAND)
        // greys AND disables until the toggle is on; the toggle itself
        // stays live — the gate box wraps only the children
        const ggGate = seGate(seGatedDiv('se-grammar'), 'guided_grammar_enabled');
        ggGate.append(ggWrap);
        gsb.append(ggGate);
    }

    /* chat-template kwargs (subset: key/value rows, add/remove) */
    if (!S.isDiffusion(m)) renderCtKwargs(section('Chat Template Kwargs'));

    // UX-2: grey out every gated family whose master switch is off
    seRefreshGates(container);
}

/* ANE prompt processing (classic modal renders a Qwen variant and, for
   ane_prefill_backend === 'k2', a K2 variant with different labels). */
function renderAne(container, g) {
    const k2 = (seFormModel && seFormModel.ane_prefill_backend) === 'k2';
    // UX-2: the whole ANE family is always rendered, greyed until its
    // master switch flips — no re-render, controls keep their places
    g.append(seBind('bool', 'qwen35_ane_prefill_enabled', {
        label: k2 ? 'K2 ANE Prompt Processing' : 'Qwen ANE Prompt Processing',
        hint: k2 ? 'Use ANE for K2 prompt processing, including MoVA. Decode stays on GPU.'
                 : 'Split eligible Qwen 3.5/3.6/3.8 prompt-processing work across both ANEs and the GPU.' }));
    const sbA = seGate(seGatedDiv('se-sub'), 'qwen35_ane_prefill_enabled');
    g.append(sbA);
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
        { label: C.tf('uplift.ui.accelerate_gdn', 'Accelerate GDN'), hint: 'Also split eligible GDN input projections across the ANEs and GPU.' }));
    const gdnBox = seGate(seGatedDiv('se-sub'), 'qwen35_ane_prefill_gdn');
    gdnBox.append(
        seBind('number', 'qwen35_ane_prefill_gdn_fraction',
            { label: C.tf('uplift.ui.gdn_on_ane_fraction', 'GDN on ANE (fraction)'), min: 0, max: 1, step: 0.01 }),
        seBind('number', 'qwen35_ane_prefill_gdn_max_layers',
            { label: C.tf('uplift.ui.gdn_layer_limit', 'GDN layer limit'), min: 0, step: 1 }));
    sbA.append(gdnBox);
    sbA.append(seBind('bool', 'qwen35_ane_prefill_cpu_enabled',
        { label: C.tf('uplift.ui.share_mlp_work_with_cpu', 'Share MLP work with CPU'),
          hint: 'Requires a separate Qwen q4 checkpoint clone with floating tensors converted.' }));
    const sbC = seGate(seGatedDiv('se-sub'), 'qwen35_ane_prefill_cpu_enabled');
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
    sbA.append(sbC);
    refreshDivergence();   // the fields wipe removed the banner — re-attach
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
    // BUG-1: the re-render callbacks below must target the EDITOR ROOT, not
    // this section body — renderEditorFields() wipes its container and
    // rebuilds every section inside it, so passing the body nested all
    // following sections inside the Chat Template Kwargs box.
    const editorRoot = container.closest('#se-fields') || container;
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
        // BUG-1: typed entries (reasoning_effort, enable_thinking) have no
        // editable key — an empty text box read as a broken field. Show the
        // key as a read-only label instead; only 'custom' gets an editable one.
        const typed = e.type !== 'custom';
        let key;
        if (typed) {
            key = document.createElement('span');
            key.className = 'se-kwarg-key';
            key.textContent = e.type;
        } else {
            key = document.createElement('input');
            key.type = 'text'; key.value = e.key || ''; key.placeholder = 'key';
            key.addEventListener('input', () => { e.key = key.value; });
        }
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
                renderEditorFields(editorRoot);
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
            renderEditorFields(editorRoot);
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
            renderEditorFields(editorRoot);
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
    // item 3: separate honest reload action — hidden until runtime-signature
    // settings are actually queued on the base tab of a loaded model
    const restart = document.createElement('button');
    restart.className = 'se-btn restart'; restart.id = 'se-restart';
    restart.hidden = true;
    restart.onclick = () => restartModel();
    const close = document.createElement('button');
    close.className = 'se-btn'; close.textContent = 'Close'; close.id = 'se-cancel';
    const msg = document.createElement('span');
    msg.className = 'stat-sub'; msg.id = 'se-msg';
    bar.append(save, restart, close, msg);
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
    // Escape is handled by the global modal handler (uplift_state.js)
    document.body.append(overlay);
    ta.focus();
}
function closeEditor() {
    if (seModel) CHIPS.clearProfileCache(seModel);   // tree must show new profiles
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
        const list = MM_STATE.adminModels.length ? MM_STATE.adminModels
            : (await MM_GLUE.fetchJson(`${API}/admin/api/models`)).models;
        entry = list.find(x => x.id === model) || null;
    } catch (_) { entry = null; }
    seFormModel = entry || { id: model, _missing: !entry };
    seBaseRaw = JSON.parse(JSON.stringify(settings));
    // U41 phase-1 survivors: settings already stored but not yet applied by
    // a reload. They are SAVED, so they seed the form baseline (not dirty)
    // and get an amber pending-restart mark until phase 2 consumes them.
    await seLoadDeferred(model);
    seValues = window.UpliftModelSpec.buildState(seFormModel,
        Object.assign({}, settings, seDeferred));
    seOrig = JSON.parse(JSON.stringify(seValues));
    seBaseVals = JSON.parse(JSON.stringify(seValues));
    seTabs = [{ id: 'base', dirty: new Set(), origVals: JSON.parse(JSON.stringify(seOrig)) }];
    seActiveTab = 'base';
    window.__seDeferred = () => seDeferred;   // debug handle (__upLayout pattern)
    // is_hidden/is_favorite/is_default/pinned are toggled from the models ROW
    // (classic _models.html), never in the settings modal — parity: not here.
    // popup modal, not an inline accordion: stable size for long forms
    const panel = editorNode();
    renderEditorFields(panel.querySelector('#se-fields'));
    seLoadProfiles(model, panel.querySelector('.se-profs')).then(() => {
        // item 2: existing profiles are prominent top tabs, each showing
        // that profile's merged values (item 1: values are visible)
        for (const p of (MM_DATA.profiles || [])) seAddProfileTab(p);
        refreshDivergence();
        seRenderTabs(panel);
        // alias/profile EDIT button: land directly on that profile's tab
        if (seWantProfile) { const w = seWantProfile; seWantProfile = null;
                             seOpenProfileTab(panel, w); }
    });
    panel._reRender = () => {
        renderEditorFields(panel.querySelector('#se-fields'));
        seMarkPendingRows();
        seRenderTabs(panel);
        seUpdateSaveBtn();
    };
    if (!row) $('se-msg') && ($('se-msg').textContent = `Model ${model} not listed`);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay editor-overlay';
    overlay.append(panel);
    document.body.append(overlay);
    // deferred settings surface only once the panel lives in the document
    // (seMarkPendingRows locates it via document.querySelector)
    seMarkPendingRows();
    seUpdateSaveBtn();   // deferred-only reopen: RESTART must already show
    panel.tabIndex = -1;
    panel.focus();
    // Escape is handled globally (uplift_state.js); closeEditor does the
    // teardown (row unfreeze, editor removal) the old local listener did.
    overlay.__upliftModalClose = closeEditor;
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
    seDeferred = {};   // templates never have deferred engine settings
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
    overlay.__upliftModalClose = closeEditor;   // Escape via global handler
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
        await D.putJson(`${API}/admin/api/profile-templates/${encodeURIComponent(tpl.name)}`,
            { settings });   // putJson throws with the flattened detail on !ok
        msg.textContent = 'saved ✓';
        MM_GLUE.toast(C.tf('uplift.mm.tpl_saved', 'Template saved: ') + (tpl.display_name || tpl.name));
        seOrig = JSON.parse(JSON.stringify(seValues));
        seUpdateSaveBtn();
        MM_TPL.render();
        setTimeout(closeEditor, 1000);
    } catch (err) {
        msg.textContent = 'error: ' + err.message;
        MM_GLUE.toast(C.tf('uplift.mm.tpl_save_fail', 'Template save failed: ') + err.message);
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
        // item 4: a stored profile whose effective load-time settings differ
        // from base reloads the model when its alias is hit — mark its tab
        if (t.profileId && (MM_DATA.divergence || [])
                .some(d => d.name === t.profileId))
            mark += ' ⚠';
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
    for (const p of (MM_DATA.presets || [])) {
        const o = document.createElement('option'); o.value = 'pre:' + p.name;
        o.textContent = '◧ ' + (p.display_name || p.name); g1.append(o);
    }
    if (g1.children.length) drop.append(g1);
    const g2 = document.createElement('optgroup'); g2.label = 'Model profiles (this model)';
    // U4: this model's own stored profiles live HERE now (apply values into
    // the active tab, no tab of their own). seLoadProfiles fills the list
    // async and re-renders the strip once loaded.
    for (const p of (MM_DATA.profiles || [])) {
        const o = document.createElement('option'); o.value = 'own:' + p.name;
        o.textContent = '◧ ' + (p.display_name || p.name) + ' (profile)'; g2.append(o);
    }
    for (const t of (MM_DATA.templates || [])) {
        const o = document.createElement('option'); o.value = 'tpl:' + t.name;
        o.textContent = '◱ ' + (t.display_name || t.name) + ' (template)'; g2.append(o);
    }
    if (g2.children.length) drop.append(g2);
    const g3 = document.createElement('optgroup'); g3.label = 'Copy settings from model';
    for (const mm of (MM_STATE.adminModels || [])) {
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
    const present = new Set((MM_STATE.adminModels || []).map(x => x.id));
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
                .catch(e => MM_GLUE.toast(C.tf('uplift.mm.load_fail', 'Load failed: ') + e.message));
        } else if (kind === 'msp') {
            const mid = decodeURIComponent(id.slice(0, id.indexOf('|')));
            const pname = id.slice(id.indexOf('|') + 1);
            MM_GLUE.fetchJson(`${API}/uplift/api/models/${encodeURIComponent(mid)}/profiles`)
                .then(d => {
                    const p = (d.profiles || []).find(x => x.name === pname);
                    if (p) seApplyIntoActiveTab(p.settings || {}, mid + ':' + pname + ' (missing)');
                    else MM_GLUE.toast(C.tf('uplift.mm.profile_missing', 'profile not found: ') + pname);
                })
                .catch(e => MM_GLUE.toast(C.tf('uplift.mm.load_fail', 'Load failed: ') + e.message));
        } else if (kind === 'own') {
            const p = (MM_DATA.profiles || []).find(x => x.name === id);
            if (p) seApplyIntoActiveTab(p.settings || {}, p.display_name || p.name);
        } else if (kind === 'mpr') {
            // U4: model profile -> apply values into the ACTIVE tab, no new
            // tab. Settings are already local in adminModels.
            const mid = decodeURIComponent(id.slice(0, id.indexOf('|')));
            const pname = id.slice(id.indexOf('|') + 1);
            const mm = (MM_STATE.adminModels || []).find(x => x.id === mid);
            const ep = mm && (mm.exposed_profiles || []).find(x => x.name === pname);
            if (ep) seApplyIntoActiveTab(ep.settings || {}, mid + ' ▸ ' + pname);
        } else if (kind === 'pre') {
            const pre = (MM_DATA.presets || []).find(x => x.name === id);
            if (pre) seApplyIntoActiveTab(pre.settings || {}, pre.display_name || pre.name);
        } else if (kind === 'tpl') {
            const tpl = (MM_DATA.templates || []).find(x => x.name === id);
            if (tpl) seApplyIntoActiveTab(tpl.settings || {}, tpl.display_name || tpl.name);
        } else {
            MM_GLUE.toast(C.t('uplift.toast.loading_settings', {id: id}));
            MM_GLUE.fetchJson(`${API}/admin/api/models/${encodeURIComponent(id)}/settings`)
                .then(d => seApplyIntoActiveTab(d.settings || {}, id))
                .catch(e => MM_GLUE.toast(C.tf('uplift.mm.load_fail', 'Load failed: ') + e.message));
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
/* ---- item 4: RUNTIME DIVERGENCE ----------------------------------------
   A profile whose effective settings (base merged with the profile's
   overrides) have a runtime signature different from the base's forces a
   model reload whenever its alias / exposed API name is hit. Compute the
   diff for every stored profile and show a banner with a (show) expander. ---- */
function seBasePayload() {
    // the CURRENT base state (unsaved edits on the base tab included) as a
    // payload
    if (seIsBaseTab())
        return window.UpliftModelSpec.buildPayload(seValues, seFormModel);
    const baseTab = seTabs.find(z => z.id === 'base');
    const vals = baseTab && baseTab.workVals ? baseTab.workVals : seBaseVals;
    return window.UpliftModelSpec.buildPayload(vals || seValues, seFormModel);
}
function seProfilePayload(p) {
    // profile settings are sparse RAW overrides on the stored base; merge
    // in raw shape, then convert through the same spec path as the editor
    const merged = Object.assign({}, seBaseRaw || {},
        JSON.parse(JSON.stringify(p.settings || {})));
    const st = window.UpliftModelSpec.buildState(seFormModel || { id: seModel }, merged);
    return window.UpliftModelSpec.buildPayload(st, seFormModel);
}
function refreshDivergence() {
    const S = window.UpliftModelSpec;
    const baseP = seBasePayload();
    const out = [];
    for (const p of (MM_DATA.profiles || [])) {
        const diff = S.runtimeDiff(baseP, seProfilePayload(p));
        if (diff.length)
            out.push({ name: p.name, display_name: p.display_name || p.name,
                       api_name: p.api_name || null, diff });
    }
    MM_DATA.divergence = out;
    renderDivergenceBanner();
}
function renderDivergenceBanner() {
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    let host = panel.querySelector('.se-divergence');
    const fields = panel.querySelector('#se-fields');
    if (!fields) return;
    const diverging = MM_DATA.divergence || [];
    if (!diverging.length) { if (host) host.remove(); return; }
    if (!host) {
        host = document.createElement('div');
        host.className = 'se-divergence';
        fields.prepend(host);
    }
    host.textContent = '';
    const line = document.createElement('div');
    line.className = 'se-div-head';
    const names = diverging.map(d => d.api_name || d.display_name).join(', ');
    line.textContent = '⚠ RUNTIME DIVERGENCE — ';
    const b = document.createElement('b');
    b.textContent = diverging.length === 1
        ? C.tf('uplift.se.divergence.one', 'profile ') + names
        : C.tf('uplift.se.divergence.many', 'profiles ') + names;
    const expl = document.createElement('span');
    expl.textContent = C.tf('uplift.se.divergence.expl',
        ' differ from the base model in load-time settings. Calling their API name reloads the model.');
    const show = document.createElement('button');
    show.type = 'button'; show.className = 'se-btn se-div-show';
    show.textContent = C.tf('uplift.se.divergence.show', '(show)');
    show.onclick = () => {
        const det = panel.querySelector('.se-div-detail');
        if (det) { det.remove(); show.textContent = C.tf('uplift.se.divergence.show', '(show)'); return; }
        show.textContent = C.tf('uplift.se.divergence.hide', '(hide)');
        panel.querySelector('.se-divergence').append(seDivergenceDetail(diverging));
    };
    line.append(b, expl, show);
    // DIV-3 (user 2026-10-09): offer to eliminate the divergence the other
    // way around — adopt the base model's load-time values in every
    // diverging profile — instead of only warning about it.
    line.append(seDivergenceSyncBtn(diverging, panel));
    host.append(line);
}
/* Two-step arm/confirm button (the write overwrites stored profile
   settings, so it needs an informed confirmation naming what it touches;
   confirmDialog cannot host it — its OK handler closes the editor).
   The sync deletes the diverging load-time keys from each profile's
   SPARSE overrides, i.e. the profile INHERITS them from the base again —
   the same mechanic as reverting a field on a profile tab, and exactly
   why the divergence disappears (effective value = base value). Keys a
   profile keeps because they do not feed the runtime signature (sampling,
   thinking, ...) are untouched; a profile deliberately differing in a
   load-time value is served by NOT clicking this. */
function seDivergenceSyncBtn(diverging, panel) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'se-btn se-div-show se-div-sync';
    const label = () => C.tf('uplift.se.divergence.sync', 'SYNC BASE → PROFILES');
    let armed = false, timer = null;
    const disarm = () => { armed = false; btn.textContent = label();
                           btn.classList.remove('restart');
                           if (timer) { clearTimeout(timer); timer = null; } };
    btn.textContent = label();
    btn.title = C.tf('uplift.se.divergence.sync.title',
        'Reset the diverging load-time settings of these profiles to the base model\'s current values (they inherit them again). Each profile\'s other overrides stay as they are.');
    btn.onclick = async () => {
        if (!armed) {
            armed = true;
            btn.classList.add('restart');
            btn.textContent = C.tf('uplift.se.divergence.sync.confirm',
                'CONFIRM — sync ') + diverging.map(d => d.api_name || d.display_name).join(', ');
            timer = setTimeout(disarm, 6000);
            return;
        }
        disarm();
        btn.disabled = true;
        const names = diverging.map(d => d.api_name || d.display_name).join(', ');
        try {
            const n = await seSyncBaseToProfiles(diverging);
            if (n) MM_GLUE.toast(C.tf('uplift.se.divergence.synced',
                'Base load-time settings synced to ') + n + ' profile(s): ' + names);
            else MM_GLUE.toast(C.tf('uplift.se.divergence.sync.none',
                'Nothing to sync — profiles already match the base'));
        } catch (err) {
            MM_GLUE.toast(C.tf('uplift.toast.action_failed',
                { action: 'sync profiles', msg: err.message }));
        }
        btn.disabled = false;
        refreshDivergence();
        seRenderTabs(panel);
        seUpdateSaveBtn();
    };
    return btn;
}
async function seSyncBaseToProfiles(diverging) {
    if (!seModel) throw new Error('no model loaded in editor');
    const fields = await MM_GLUE.modelSettingsFields();
    // the runtimeDiff keys speak the payload shape; old servers store the
    // legacy twin name in the profile (adaptToServerSettings renames)
    const LEGACY_TWINS = { mtp_adaptive_max_depth: ['mtp_num_draft_tokens'],
                           mtp_fixed_depth: ['mtp_num_draft_tokens'] };
    let n = 0;
    for (const d of diverging) {
        const p = (MM_DATA.profiles || []).find(x => x.name === d.name);
        if (!p) continue;
        // sparse overrides minus the diverging load-time keys = inherit base
        const ov = JSON.parse(JSON.stringify(p.settings || {}));
        for (const row of d.diff) {
            delete ov[row.key];
            for (const t of (LEGACY_TWINS[row.key] || [])) delete ov[t];
        }
        const body = window.UpliftModelSpec.adaptToServerSettings(ov, fields);
        const req = { settings: body, display_name: p.display_name || d.display_name,
            expose_as_model: !!p.expose_as_model, api_name: p.api_name || null };
        try {
            await D.putJson(`${API}/admin/api/models/${encodeURIComponent(seModel)}`
                + `/profiles/${encodeURIComponent(d.name)}`, req);
        } catch (e) {
            if (e.status !== 404) throw e;
            // missing base model: classic PUT 404s; uplift upserts (same
            // fallback saveProfileTab uses)
            await D.postJson(`${API}/uplift/api/models/${encodeURIComponent(seModel)}/profiles`,
                Object.assign({ name: d.name }, req));
        }
        p.settings = body;
        // an open tab of this profile must not re-save the stale overrides:
        // re-base it on the synced record. If that tab is ACTIVE (visible
        // widgets holding possibly-unsaved edits), re-render it from the
        // re-based values — the sync confirmation names the profile, so
        // trading that tab's unsaved edits for an honest display is the
        // informed outcome. Other tabs re-base silently (not displayed).
        const t = seTabs.find(z => z.profileId === d.name);
        if (t) {
            t.overrides = JSON.parse(JSON.stringify(body));
            t._ovSnap = JSON.parse(JSON.stringify(body));
            t.workVals = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(body)));
            t.origVals = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(body)));
            t.dirty = new Set();
            if (t.id === seActiveTab) {
                seRestoreTab(t);
                renderEditorFields(document.getElementById('se-fields'));
            }
        }
        n++;
    }
    CHIPS.clearProfileCache(seModel);   // alias-tree chips must re-fetch
    return n;
}
function seDivergenceDetail(diverging) {
    const det = document.createElement('div');
    det.className = 'se-div-detail';
    for (const d of diverging) {
        const h = document.createElement('div');
        h.className = 'se-div-prof';
        h.textContent = (d.api_name ? d.api_name + ' — ' : '') + d.display_name;
        det.append(h);
        for (const row of d.diff) {
            const r = document.createElement('div');
            r.className = 'se-div-row';
            const k = document.createElement('span'); k.className = 'se-div-k';
            k.textContent = row.key;
            const v1 = document.createElement('span'); v1.textContent = MM_GLUE.gsDisplay(row.base);
            const arrow = document.createElement('span'); arrow.textContent = ' → ';
            const v2 = document.createElement('span'); v2.className = 'se-div-new';
            v2.textContent = MM_GLUE.gsDisplay(row.other);
            r.append(k, v1, arrow, v2);
            det.append(r);
        }
    }
    return det;
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
    // CT-1: raw kwargs present: they win over entries built from base;
    // base entries for keys the raw payload doesn't mention are kept —
    // merged BY IDENTITY (modelspec.mergeRawKwargs). The old filter used
    // `!(e.key in raw)`, but typed rows have no e.key, so the base
    // reasoning_effort/enable_thinking row always survived the merge on
    // top of its rebuilt twin: duplicated kwargs rows in the editor.
    // (After the first kwargs render, seSyncKwEntries has removed the raw
    // twins from workVals, so re-renders keep the user's edited entries.)
    vals.ctKwargEntries = window.UpliftModelSpec.mergeRawKwargs(
        vals.chat_template_kwargs || {}, vals.forced_ct_kwargs,
        vals.ctKwargEntries || [], false);
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
function seAddProfileTab(p) {
    // Build (once) a working tab for a stored profile. Tab click shows the
    // profile's merged values; saving PUTs to /profiles/<name>, never POSTs.
    let t = seTabs.find(z => z.profileId === p.name || z.name === p.name);
    if (t) return t;
    const ov = JSON.parse(JSON.stringify(p.settings || {}));
    t = seInitSnap({ id: 'prof' + Date.now() + Math.random().toString(36).slice(2, 5),
        name: p.name,
        display_name: p.display_name || p.name,
        expose_as_model: !!p.expose_as_model, api_name: p.api_name || '',
        profileId: p.name, overrides: ov,
        workVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
        origVals: Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(ov))),
        dirty: new Set(), _origExpose: !!p.expose_as_model, _origApi: p.api_name || '' });
    seTabs.push(t);
    return t;
}
function seOpenProfileTab(panel, name) {
    // Open (or reuse) + activate the tab for a stored profile so the
    // alias-line EDIT button lands directly on the thing it edits.
    const p = (MM_DATA.profiles || []).find(x => x.name === name);
    if (!p) { MM_GLUE.toast('profile "' + name + '" not found'); return; }
    const t = seAddProfileTab(p);
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
    MM_DATA.profiles = profs;
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
    // FE-2: private `write` closure deleted — it was a fetchJson clone
    // with worse error messages (no url, no err.status). All five call
    // sites pass explicit method/headers/body opts straight to fetchJson.
    const write = D.fetchJson;
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
    if (stripPanel) {
        // tabs follow the store: drop tabs of deleted profiles, add new ones
        const names = new Set(profs.map(p => p.name));
        const wasActive = seTabs.find(z => z.id === seActiveTab);
        seTabs = seTabs.filter(z => !z.profileId || names.has(z.profileId));
        if (wasActive && !seTabs.includes(wasActive)) {
            seActiveTab = 'base';
            seValues = JSON.parse(JSON.stringify(seBaseVals));
            seOrig = JSON.parse(JSON.stringify(seBaseVals));
        }
        for (const p of profs) seAddProfileTab(p);   // item 2: tabs follow the store
        refreshDivergence();
        seRenderTabs(stripPanel);
    }
    // Global templates (global_templates.json): apply or snapshot into a template.
    let tpls = [];
    try { tpls = (await MM_GLUE.fetchJson(`${API}/admin/api/profile-templates`)).templates || []; } catch (_) {}
    MM_DATA.templates = tpls;
    // Bundled global presets (same source as the classic editor's preset
    // menu: /admin/static/omlx_preset.json), cached 1 day like classic does.
    if (!MM_DATA.presets) {
        try {
            const cached = JSON.parse(localStorage.getItem('omlx_preset_cache') || 'null');
            if (cached && cached.presets) MM_DATA.presets = cached.presets;
            else {
                const d = await MM_GLUE.fetchJson(`${API}/admin/static/omlx_preset.json`);
                MM_DATA.presets = d.presets || [];
                localStorage.setItem('omlx_preset_cache', JSON.stringify(d));
            }
        } catch (_) { MM_DATA.presets = []; }
    }
    /* Templates row ALWAYS renders (no length gate): 'Snapshot as' is how
       the FIRST template gets created. The `|| true` this replaces was a
       deliberate always-run written as a tautology — unreadable, but the
       behavior stays: empty tpls must not hide the row. */
    {
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

/* After a successful phase-1 save every dirty key is persisted (live keys
   in the classic store, runtime keys in the deferred store), so the tab's
   baseline moves to the current values and the fields stop reading dirty.
   deferredKeys additionally get a pending-restart mark (amber, not the red
   dirty tint) that only phase 2 clears. */
function seCommitSaved(t0, deferredKeys) {
    const kwChanged = JSON.stringify(seValues.ctKwargEntries || [])
        !== JSON.stringify((t0 && t0.origVals || {}).ctKwargEntries || []);
    for (const k of [...(t0 ? t0.dirty : seDirtyKeys())]) {
        seOrig[k] = seValues[k];
        seBaseVals[k] = seValues[k];
    }
    if (kwChanged) {
        seOrig.ctKwargEntries = seValues.ctKwargEntries;
        seBaseVals.ctKwargEntries = seValues.ctKwargEntries;
    }
    if (t0) { t0.dirty.clear(); t0.origVals = Object.assign({}, seBaseVals); }
    for (const el of document.querySelectorAll('#se-fields .se-row.dirty'))
        el.classList.remove('dirty');
    for (const k of (deferredKeys || [])) {
        const row = document.querySelector(`#se-fields [data-key="${k}"]`);
        if (row) row.classList.add('pending-restart');
    }
}

/* Pending-restart surfacing (U41): rows holding a deferred value get an
   amber .pending-restart tint plus a banner that names the wait and offers
   DISCARD (drop the stored values, back to what the engine runs). */
function seMarkPendingRows() {
    for (const el of document.querySelectorAll('#se-fields .se-row.pending-restart'))
        el.classList.remove('pending-restart');
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    const keys = Object.keys(seDeferred);
    for (const k of keys) {
        const row = document.querySelector(`#se-fields [data-key="${k}"]`);
        if (row) row.classList.add('pending-restart');
    }
    let host = panel.querySelector('.se-pending');
    const fields = panel.querySelector('#se-fields');
    if (!fields) return;
    if (!keys.length) { if (host) host.remove(); return; }
    if (!host) {
        host = document.createElement('div');
        host.className = 'se-pending';   // NOT .se-divergence: that banner's
        fields.prepend(host);            // renderer would steal and remove it
    }
    host.textContent = '';
    const line = document.createElement('div');
    line.textContent = C.tf('uplift.se.pending.banner',
        'PENDING RESTART — {n} saved setting(s) apply the next time the model reloads').replace('{n}', keys.length);
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'se-btn tiny';
    discard.textContent = C.tf('uplift.se.pending.discard', 'DISCARD');
    discard.onclick = async () => {
        // revert each deferred key to the classic-store value (seOrig was
        // seeded WITH the deferred values, so consult seBaseRaw instead)
        const baseState = window.UpliftModelSpec.buildState(seFormModel, seBaseRaw);
        for (const k of keys) {
            if (k in baseState) seValues[k] = baseState[k];
            const t0 = seTabs.find(z => z.id === 'base');
            if (t0) { delete t0.origVals[k]; }
            delete seOrig[k]; delete seBaseVals[k];
        }
        await seClearDeferred(seModel);
        renderEditorFields(fields);
        seUpdateSaveBtn();
    };
    line.append(discard);
    host.append(line);
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
    const full = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
    // boolean management flags ride the same PUT (real API accepts them too)
    if ('is_hidden' in seValues) full.is_hidden = !!seValues.is_hidden;
    if ('is_favorite' in seValues) full.is_favorite = !!seValues.is_favorite;
    // item 3: the server auto-unloads a loaded engine whenever a reload-key
    // is PRESENT in the PUT payload — the old full-payload save therefore
    // reloaded the model even for sampling tweaks. SAVE-now sends only the
    // dirty keys that apply live (sparse PUT; the server treats "not sent"
    // as "don't touch"). Runtime keys stay queued for RESTART MODEL.
    const loaded = seModelIsLoaded();
    let payload = full, reloadStep = false;
    if (loaded) {
        const plain = sePlainDirtyKeys();
        const runtime = seRuntimeDirtyKeys();
        // dirty state keys -> the payload keys they own (some are derived)
        const KEY_MAP = {
            enableThinkingBudget: ['thinking_budget_enabled', 'thinking_budget_tokens'],
            enableIndexCache: ['index_cache_freq'],
            enableToolResultLimit: ['max_tool_result_tokens'],
        };
        payload = {};
        for (const k of plain) {
            for (const pk of (KEY_MAP[k] || [k])) if (pk in full) payload[pk] = full[pk];
        }
        // chat-template kwargs bypass the dirty set (entries list) — include
        // them whenever they differ from the tab's saved baseline
        const t0 = seTabs.find(z => z.id === 'base');
        const kwNow = JSON.stringify(seValues.ctKwargEntries || []);
        const kwWas = JSON.stringify((t0 && t0.origVals || {}).ctKwargEntries || []);
        if (kwNow !== kwWas) {
            payload.chat_template_kwargs = full.chat_template_kwargs;
            payload.forced_ct_kwargs = full.forced_ct_kwargs;
        }
        // U41 phase 1 (user design): runtime keys are STORED too, never
        // blocked — they go to the uplift deferred-settings store and apply
        // on phase 2 (RESTART MODEL). Only keys dirty NOW are written, so a
        // previously-deferred value survives an unrelated later save.
        const deferAdd = {};
        if (runtime.length) {
            const ks = seDeferKeys();
            for (const k of runtime) {
                const pk = (KEY_MAP[k] || [k]).find(x => ks.has(x)) || k;
                if (pk in full) deferAdd[pk] = full[pk];
            }
        }
        const deferred = Object.keys(deferAdd).length
            ? Object.assign({}, seDeferred, deferAdd) : seDeferred;
        reloadStep = Object.keys(deferred).length > 0;
        msg.textContent = 'saving…';
        const achvOld = t0 && t0.origVals ? Object.assign({}, t0.origVals) : null;
        try {
            // live keys ride the sparse classic PUT (empty payload = nothing
            // live changed; skip it so we never touch the engine path)
            if (Object.keys(payload).length)
                await MM_GLUE.putModelSettings(seModel, payload);
            if (Object.keys(deferAdd).length) await sePersistDeferred(seModel, deferred);
            else seDeferred = deferred;
            // the classic store now holds the live keys: keep the raw base
            // (divergence merge baseline for profiles) honest — DIV-3
            Object.assign(seBaseRaw, JSON.parse(JSON.stringify(payload)));
            // mark every committed key saved (baseline moves to current), so
            // the deferred set no longer reads as dirty-but-unsaved
            seCommitSaved(t0, Object.keys(deferAdd));
            seMarkPendingRows();
            msg.textContent = reloadStep
                ? 'saved ✓ — ' + Object.keys(seDeferred).length + ' setting(s) apply on RESTART MODEL'
                : 'saved ✓';
            MM_GLUE.toast(C.t('uplift.toast.settings_saved_model', {model: seModel}));
            seUpdateSaveBtn();
            refreshDivergence();
            if (!reloadStep) setTimeout(closeEditor, 1200);
            // ACHIEVEMENTS: judge what this save did to the machine
            try {
                const AC = window.Uplift && window.Uplift.achv;
                if (AC && achvOld) AC.announce(AC.modelSavedReaction(achvOld, seValues));
            } catch (_) { /* a verdict must never break the save */ }
            // restart still pending: editor stays open, RESTART MODEL visible
        } catch (err) {
            msg.textContent = `error: ${err.message}`;
            MM_GLUE.toast(C.t('uplift.toast.save_failed', {msg: err.message}));
        }
        return;
    }
    msg.textContent = 'saving…';
    const achvOldBase = (() => { const z = seTabs.find(q => q.id === 'base');
        return z && z.origVals ? Object.assign({}, z.origVals) : null; })();
    try {
        const r = await MM_GLUE.putModelSettings(seModel, payload);
        // no engine running: the full PUT stored everything classic-side —
        // a leftover deferred record is redundant, drop it
        await seClearDeferred(seModel);
        seCommitSaved(seTabs.find(z => z.id === 'base'), []);
        msg.textContent = 'saved ✓';
        MM_GLUE.toast(C.t('uplift.toast.settings_saved_model', {model: seModel}));
        seUpdateSaveBtn();
        refreshDivergence();
        setTimeout(closeEditor, 1200);
        try {
            const AC = window.Uplift && window.Uplift.achv;
            if (AC && achvOldBase) AC.announce(AC.modelSavedReaction(achvOldBase, seValues));
        } catch (_) { /* a verdict must never break the save */ }
    } catch (err) {
        msg.textContent = `error: ${err.message}`;
        MM_GLUE.toast(C.t('uplift.toast.save_failed', {msg: err.message}));
    }
}
/* RESTART MODEL (phase 2): push EVERYTHING — deferred values are already in
   seValues, so the full classic PUT carries them and the server's
   auto-unload fires; then load. The deferred record is cleared. A failed
   LOAD is fatal; the unload 400 ("not loaded" — the server already
   unloaded on save) is expected and tolerated. */
async function restartModel(msg) {
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    seCaptureTab();
    const b = document.getElementById('se-restart');
    if (b) b.disabled = true;
    const full = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
    msg = msg || panel.querySelector('#se-msg');
    msg.textContent = 'saving + reloading…';
    try {
        await MM_GLUE.putModelSettings(seModel, full);
        try { await MM_GLUE.postModelAction(seModel, 'unload'); }
        catch (_) { /* already unloaded by the server on save */ }
        await MM_GLUE.postModelAction(seModel, 'load');
        await seClearDeferred(seModel);
        MM_GLUE.toast(C.t('uplift.toast.reloaded_with_settings', {model: seModel}));
        closeEditor();
    } catch (e) {
        msg.textContent = 'error: ' + e.message;
        MM_GLUE.toast(C.t('uplift.toast.reload_failed', {msg: e.message}));
        if (b) b.disabled = false;
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
    // version adaptation: an older server drops unknown keys from profile
    // settings (silent mis-save) — translate renamed fields first
    ov = window.UpliftModelSpec.adaptToServerSettings(
        ov, await MM_GLUE.modelSettingsFields());
    const body = { name, display_name: t.display_name || name, settings: ov,
        expose_as_model: !!t.expose_as_model, api_name: t.api_name || null };
    try {
        const path = `${API}/admin/api/models/${encodeURIComponent(seModel)}/profiles` +
            (t.profileId ? '/' + encodeURIComponent(t.profileId) : '');
        try {
            if (t.profileId) {
                await D.putJson(path, { settings: ov, display_name: t.display_name || name,
                    expose_as_model: !!t.expose_as_model, api_name: t.api_name || null });
            } else {
                await D.postJson(path, body);
            }
        } catch (e) {
            if (e.status !== 404) throw e;
            // missing base model: classic routes 404 (no engine entry);
            // uplift's upsert create-or-updates the stored profile instead
            await D.postJson(`${API}/uplift/api/models/${encodeURIComponent(seModel)}/profiles`, body);
        }
        MM_GLUE.toast(C.t('uplift.toast.saved_profile', {name: name}));
        t.profileId = name; t.dirty = new Set();
        t._origExpose = !!t.expose_as_model; t._origApi = t.api_name || '';
        t.name = name; t.display_name = name;
        t.origVals = Object.assign({}, seBaseVals, JSON.parse(JSON.stringify(t.workVals || {})));
        t._ovSnap = JSON.parse(JSON.stringify(ov));   // saved overrides are the new original
        const mirror = (MM_DATA.profiles || []).find(x => x.name === name);
        if (mirror) mirror.settings = JSON.parse(JSON.stringify(ov));
        msg.textContent = 'saved ✓';
        seRenderTabs(panel); seUpdateSaveBtn();
    } catch (e) {
        msg.textContent = 'error: ' + e.message;
        MM_GLUE.toast(C.t('uplift.toast.profile_save_failed', {msg: e.message}));
    }
}


window.Uplift.mmEditor = {
    openEditor: openEditor,
    closeEditor: closeEditor,
    get seModel() { return seModel; },
    data: MM_DATA,          // FE-6: shared store (was window.__se*)
};
window.Uplift.mmData = MM_DATA;   // loaded early; mmtemplates fills .templates
})();
