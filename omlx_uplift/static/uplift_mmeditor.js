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
    // UP-20 fix: the landed MTPLX-import and preset-refresh call sites already
    // call MM_GLUE.postJson but the kit members were never wired here — every
    // click threw "MM_GLUE.postJson is not a function". postJson/putJson/
    // deleteJson join fetchJson straight from domkit (pinned by
    // tests/u20-snapshot-actions.test.cjs).
    postJson: D.postJson,
    putJson: D.putJson,
    deleteJson: D.deleteJson,
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
/* UP-20 (1,2): snapshot-apply modal state — one at a time; the machine is
   pure (SETTINGS_APPLY), the modal keeps the state object + node refs here.
   seApplyBusy = the editor-head action buttons (greyed during 'loading').
   seReloadAfterApply = editor-reload seam shared by the snapshot-apply flow
   and the UP-30 RESYNC verb (a recorder replaces it headless; the default
   is a full openEditor). */
let seApplyOverlay = null;
let seApplyBusy = [];
let seReloadAfterApply = null;
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
// dirty state keys -> the payload keys they own (some are derived). One map
// for the base save AND the U85 edit-sync (shared site on purpose).
const SE_KEY_MAP = {
    enableThinkingBudget: ['thinking_budget_enabled', 'thinking_budget_tokens'],
    enableIndexCache: ['index_cache_freq'],
    enableToolResultLimit: ['max_tool_result_tokens'],
    // SYNC-1 (upstream d59d797): classic's UI helper owns the watts payload
    enableGpuPowerLimit: ['gpu_power_limit_w'],
};
// the runtimeDiff keys speak the payload shape; old servers store the
// legacy twin name in the profile (adaptToServerSettings renames)
const SE_LEGACY_TWINS = { mtp_adaptive_max_depth: ['mtp_num_draft_tokens'],
                          mtp_fixed_depth: ['mtp_num_draft_tokens'] };
/* U85 (user 2026-10-12): the keys JUST EDITED on the base tab, in payload
   shape (KEY_MAP resolved + kwargs handled via their entry list). These,
   and ONLY these, are what "APPLY BASE EDITS → PROFILES" pushes — the old
   full-reset SYNC wiped every deliberate divergence, which defeats the
   point of profiles. Returns null when the base tab holds no edit to apply
   (the button must not offer an empty write). Unsaved-and-then-applied
   values are the editor's queued state — honest wording: apply pushes the
   CURRENT base values, it does not save the base itself. */
function seBaseEditKeys() {
    const bt = seTabs.find(z => z.id === 'base');
    if (!bt) return null;
    const out = new Set();
    for (const k of (bt.dirty || []))
        for (const pk of (SE_KEY_MAP[k] || [k])) out.add(pk);
    const vals = seIsBaseTab() ? seValues : (bt.workVals || {});
    if (JSON.stringify((vals || {}).ctKwargEntries || []) !==
        JSON.stringify((bt.origVals || {}).ctKwargEntries || [])) {
        out.add('chat_template_kwargs'); out.add('forced_ct_kwargs');
    }
    return out.size ? out : null;
}
function seModelIsLoaded() {
    return !!(seFormModel && !seFormModel._missing &&
              (seFormModel.loaded || seFormModel.is_loading));
}
/* ---- EFF-1: effective (fallback) values -------------------------------
   An EMPTY settings field is not "nothing" — the server falls back to a
   reported default (global sampling section, the model's native context,
   the global idle timeout / pin). Classic shows this for TTL only; uplift
   shows it for every key the API actually reports, as the input's dim
   placeholder. Values come from ONE global-settings GET per editor open
   (cached across opens) — modelspec.effDefault re-exports the tiers, this
   host only localizes and refreshes the placeholder live while typing.
   Keys the server does not report (min_p, presence_penalty) keep the bare
   '(default)'; nothing is ever invented here. */
let SE_GS = null;            // cached global-settings payload
let SE_GS_FOR = null;        // model id the cache was fetched for (pin/native)

async function seLoadGs() {
    try {
        SE_GS = await MM_GLUE.fetchJson(`${API}/admin/api/global-settings`);
    } catch (_) { SE_GS = null; }
}

function seEffHint(key) {
    if (seFormModel && seFormModel._template) return '';   // bundles: no server context
    const d = window.UpliftModelSpec.effDefault(key, seFormModel, SE_GS);
    if (!d) return '';
    if (d.kind === 'pinned')
        return C.tf('modal.model_settings.ttl_pinned', 'Pinned');
    if (d.kind === 'no_ttl')
        return C.tf('modal.model_settings.ttl_no_ttl', 'No TTL');
    if (d.kind === 'global_ttl')
        return C.tf('modal.model_settings.ttl_global_fallback', 'Global default: {seconds}s')
            .replace('{seconds}', d.seconds);
    const val = String(d.value);
    const tag = d.kind === 'model_config'
        ? C.tf('uplift.se.eff.model_config', 'model config')
        : d.kind === 'policy_clamp'   // CW-1: value bound by the global policy.
        // NOT a cap here: a per-model value (THIS very field) wins over the
        // policy upstream (tier 1 in get_max_context_window), so what the
        // policy decides is the DEFAULT applied when the field stays empty.
        ? C.tf('uplift.se.eff.policy_clamp', 'policy default')
        : C.tf('uplift.se.eff.global_default', 'global default');
    return val + ' \u00b7 ' + tag;
}

/* The placeholder IS the effective-value display: empty input shows the
   fallback, any stored/typed value hides it (native placeholder behavior).
   On a profile tab an empty field inherits the BASE first — when the base
   has a value that is the honest placeholder; the fallback only surfaces
   when the base is empty too (same precedence the widget uses at build). */
function seEffLive(key, input) {
    // number widgets ONLY: text/checkbox inputs own their placeholder
    if (!input || input.type !== 'number') return;
    const v = seValues[key];
    if (v !== null && v !== undefined && v !== '') { input.placeholder = ''; return; }
    const bv = seBaseVals ? seBaseVals[key] : undefined;
    if (seTab() && seTab().id !== 'base' && bv != null && bv !== '') {
        input.placeholder = bv + ' (inherited)';
        return;
    }
    input.placeholder = seEffHint(key) || '(default)';
}

function seUpdateSaveBtn() {
    const b = document.getElementById('se-save'); if (!b) return;
    const rb = document.getElementById('se-restart');
    const n = seDirtyKeys().length + (seTtsIsDirty() ? 1 : 0);
    // U84: the label counts changes across ALL tabs (one press commits
    // every one of them). The active tab's own change count (dirty keys +
    // kwargs + expose/api flips — seTabChangeCount) decides the single-tab
    // wording; it also FIXED a dead end: an expose/api_name flip alone now
    // enables SAVE instead of leaving a CHANGES entry nobody could commit.
    const all = seTabs.reduce((s, t) => s + seTabChangeCount(t), 0)
        + (seTtsIsDirty() ? 1 : 0);
    const at = seTab();
    const activeN = at ? seTabChangeCount(at) : 0;
    const multi = all > activeN;
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
    const shown = multi ? all : n;
    const tabTxt = multi ? ' ALL' : (onProfile ? ' PROFILE' : '');
    b.textContent = shown
        ? ('SAVE' + tabTxt + ' (' + shown + ')')
        : (multi ? 'SAVE ALL' : (onProfile ? 'SAVE PROFILE' : 'SAVE'));
    b.title = multi
        ? C.tf('uplift.se.save_all_title',
            'Saves the base model and every profile tab with unsaved changes in one go (base first)')
        : (runtimeDirty || pending
            ? C.tf('uplift.se.save_split_title',
                'SAVE stores everything now; settings that rebuild the engine apply when you press RESTART MODEL.')
            : '');
    b.disabled = shown === 0;
    if (rb) {
        rb.hidden = awaitingReload === 0;
        // unloaded base tab: SAVE already stores everything, RESTART MODEL
        // additionally loads the engine with them now
        rb.textContent = (loaded ? '▶ RESTART MODEL (' : '▶ LOAD MODEL (') + awaitingReload + ')';
        rb.title = C.tf('uplift.se.restart_title',
            'Applies the stored settings by reloading the model now');
    }
    seUpdateRailBadges();   // SPL-RAIL: badges re-derive from state
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
    if (seTts) {           // TTS-1: voice defaults ride the same CHANGES list
        for (const k of ['speaker', 'language', 'instructions'])
            if (seTts.vals[k] !== seTts.orig[k])
                entries.push({ key: 'voice_' + k, orig: seTts.orig[k] || '',
                               cur: seTts.vals[k] || '', isSecret: false,
                               display: disp });
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
    templates: MM_STATE._mmTemplates || [],     // profile-templates (renderTemplatesBox also fills)
    divergence: [],    // [{name, display_name, api_name, diff:[…]}]
    reqDivergence: [], // REQ-DIV: same shape, request-time keys
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
        seEffLive(key, input);   // EFF-1: typed value hides the fallback hint
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
        seEffLive(key, input);   // EFF-1: reverting to empty re-shows the hint
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
/* SPEC-1 (user 2026-10-28): model-load knobs are not profile fields — the
   server strips them from profile settings, so editing one on an alias tab
   silently saves nothing. Keep them VISIBLE greyed (the alias reads what it
   inherits) but LOCKED; mark the row and let seGateEnabled() honour it.
   Locking a row never propagates to siblings or children: the activation
   row lives under a locked master and stays editable, because family
   gating reads seValues[masterKey], not the master's DOM input. */
function seLockOnProfile(rowEl, key, why) {
    if (!rowEl || seIsBaseTab()) return;
    rowEl.dataset.lockProf = key;
    rowEl.classList.add('se-off');
    rowEl.title = why;
    const i = rowEl.querySelector('input, select, textarea');
    if (i) i.disabled = true;
}
function seGateEnabled(host) {
    for (let n = host.closest('[data-gate]') || host.closest('[data-lock-prof]');
            n; n = n.parentElement &&
            (n.parentElement.closest('[data-gate]') || n.parentElement.closest('[data-lock-prof]'))) {
        if (n.dataset.lockProf) return false;
        if (n.dataset.gate && seValues[n.dataset.gate] !== true) return false;
    }
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
    // SPL-RAIL (upstream parity #4415, user 2026-10-11): the LLM form shows
    // ONE section at a time as a vertical tab; hidden boxes stay in the DOM
    // (classic parity: every row is always RENDERED, visibility drives the
    // grey-out — so row lookup, gate refresh and dirty marks never change).
    const box = document.createElement('div');
    box.className = 'se-box';
    const h = document.createElement('h5');
    h.className = 'se-section';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    box.dataset.sect = slug;
    // UP-20 (3): the label lives in its own span so header-side buttons
    // (Load Defaults) can ride the h5 without leaking into the rail nav
    // label (seRailBuild reads .se-section-t).
    const lab = document.createElement('span');
    lab.className = 'se-section-t';
    lab.textContent = C.tf('uplift.se.section.' + slug, title);
    h.append(lab);
    box.__head = h;
    const body = document.createElement('div');
    body.className = 'se-box-body';
    box.append(h, body);
    box.__body = body;
    return box;
}

/* ---- SPL-RAIL: vertical section tabs (classic #4415's rail, uplift form) ----
   The nav is a column of .editor-body (built once by editorNode) — rebuilds
   of #se-fields never touch it, only its items get refilled here. Boxes all
   stay RENDERED; activation toggles [hidden] so row lookup, gate refresh and
   dirty marks never change (classic renders every row and greys; uplift
   additionally pages them behind tabs at the user's request). Badges:
   amber number = queued changes in that section, red ⟳ = one needs reload. */
let seActiveSect = null;
let SE_RAIL_HOST = null;    // cached during construction (panel may be detached)

function seRailHost(container) {
    const fields = container || document.getElementById('se-fields');
    if (!fields) return SE_RAIL_HOST;
    const body = fields.closest('.editor-body');
    if (!body) return null;
    SE_RAIL_HOST = { body: body, nav: body.querySelector('.se-rail'), fields: fields };
    return SE_RAIL_HOST;
}

function seRailBuild(container) {
    const h = seRailHost(container); if (!h) return;
    const boxes = [...container.querySelectorAll('.se-box[data-sect]')];
    if (boxes.length < 2) {
        h.body.classList.remove('has-rail');
        h.nav.textContent = ''; h.nav.hidden = true;
        return;
    }
    h.body.classList.add('has-rail');
    h.nav.hidden = false;
    h.nav.textContent = '';
    h.nav.setAttribute('aria-label', C.tf('uplift.se.rail.label', 'Sections'));
    for (const b of boxes) {
        const slug = b.dataset.sect;
        const title = b.querySelector('.se-section');
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'se-rail-item';
        it.dataset.sect = slug;
        const t = document.createElement('span');
        t.className = 'se-rail-t';
        // UP-20 (3): prefer the label span (header buttons no longer pollute
        // h5.textContent); fall back to the raw header for any box built
        // without the span.
        const lab = title && title.querySelector
            ? title.querySelector('.se-section-t') : null;
        t.textContent = lab ? lab.textContent : (title ? title.textContent : slug);
        const badge = document.createElement('span');
        badge.className = 'se-rail-badge'; badge.hidden = true;
        it.append(t, badge);
        it.onclick = () => seActivateSection(slug);
        h.nav.append(it);
    }
    const live = boxes.some(b => b.dataset.sect === seActiveSect);
    seActivateSection(live ? seActiveSect : boxes[0].dataset.sect);
}

function seActivateSection(slug) {
    seActiveSect = slug;
    const h = seRailHost(); if (!h) return;
    for (const b of h.fields.querySelectorAll('.se-box[data-sect]'))
        b.hidden = b.dataset.sect !== slug;
    for (const it of h.nav.querySelectorAll('.se-rail-item')) {
        const on = it.dataset.sect === slug;
        it.classList.toggle('active', on);
        it.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const sc = h.fields.closest('.editor-scroll');
    if (sc) sc.scrollTop = 0;
}

/* Section badges re-derive from state, like every other dirty visual.
   A key whose row is not rendered (gated off this model) simply carries no
   badge — the CHANGES rail stays the full truth. */
function seUpdateRailBadges() {
    const h = seRailHost();
    if (!h || !h.body.classList.contains('has-rail')) return;
    const t = seTab(); if (!t) return;
    const counts = {};
    const flag = {};
    const bucket = (k) => {
        const row = h.fields.querySelector('[data-key="' + k + '"]');
        const box = row && row.closest('.se-box[data-sect]');
        return box ? box.dataset.sect : null;
    };
    for (const k of t.dirty) {
        const s = bucket(k); if (!s) continue;
        counts[s] = (counts[s] || 0) + 1;
        if (seIsRuntimeKey(k)) flag[s] = true;
    }
    // deferred (saved, pending restart) keys: the section awaits the reload
    for (const k of Object.keys(seDeferred || {})) {
        const s = bucket(k); if (!s) continue;
        flag[s] = true;
        counts[s] = counts[s] || 1;
    }
    for (const it of h.nav.querySelectorAll('.se-rail-item')) {
        const b = it.querySelector('.se-rail-badge');
        const n = counts[it.dataset.sect] || 0;
        const restart = !!flag[it.dataset.sect];
        b.hidden = !n;
        b.classList.toggle('restart', restart);
        b.textContent = n ? (restart ? '\u27F3' : String(n)) : '';
        b.title = restart
            ? C.tf('uplift.se.rail.restart', 'Changes here need a model reload')
            : C.tf('uplift.se.rail.pending', 'Queued changes in this section');
    }
}

function seRail(container) {
    seRailBuild(container);
    seUpdateRailBadges();
}

/* ---- MT-1: model-type family ------------------------------------------
   Classic hides its sampling rows and the whole Advanced column behind
   `!model_type || llm || vlm` (four sites in _modal_model_settings.html).
   The uplift editor mirrors that MECHANISM at section level: an embedding/
   reranker/audio/decision model has no temperature, no thinking, no
   grammar, no spec-decode — those settings make no sense for its engine.
   The gate reads the EFFECTIVE type (a live model_type_override flip
   re-shapes the form; the server picks the engine from the override).
   The gated sections are SKIPPED, not greyed: UX-2's render-always rule
   protects discoverability WITHIN the model's family; classic itself
   removes the nodes for other types (template x-if / whole-column x-show),
   and keeping 60 dead rows would bury the few settings that DO apply. */

/* seModelEntry: the editor's view of the model as the SERVER sees it —
   model_type rewritten by the override, exactly like
   engine_pool.apply_settings_overrides does at discovery. buildState /
   buildPayload / llmLike must all see this, or the form gates on the
   checkpoint type while the engine runs the overridden one. */
function seModelEntry() {
    const m = seFormModel || {};
    const ov = seValues && seValues.model_type_override;
    return (ov && m.model_type !== ov)
        ? Object.assign({}, m, { model_type: ov }) : m;
}
function seIsLlmFamily() {
    // a global template is a type-agnostic settings bundle — never gate it
    if (seFormModel && seFormModel._template) return true;
    return window.UpliftModelSpec.llmLike(seModelEntry());
}

/* seTypeNote: banner above the form when the type gate hid fields.
   Honest in both directions — what the user sees is a subset BY DESIGN
   (classic parity), and what a type flip would do to hidden values. */
function seTypeNote(container) {
    const S = window.UpliftModelSpec;
    const m = seFormModel || {};
    const isTemplate = !!m._template;
    const llm = seIsLlmFamily();
    const overridePending = !!(seValues && seValues.model_type_override
        && seValues.model_type_override !== (m.model_type || ''));
    let note = container.querySelector('.se-typenote');
    if (note) note.remove();
    const showType = isTemplate || !llm || overridePending;
    if (!showType) return;
    note = document.createElement('div');
    // OWN class — never reuse .se-pending: seMarkPendingRows() wipes every
    // .se-pending host when no deferred keys exist (skill rule: a refresh
    // renderer that deletes 'any element with class X' steals shared ones)
    note.className = 'se-typenote';
    const line = document.createElement('div');
    if (isTemplate) {
        // A global template is a bundle of UNIVERSAL settings applied to
        // real models of any type — the template editor never type-gates
        // its form; this strip explains what a template may carry.
        line.textContent = C.tf('uplift.se.typenote.template',
            'Global templates can carry every setting; each model applies only the keys that fit its type.');
    } else if (!llm) {
        const eff = S.normType(seValues && seValues.model_type_override
            || m.model_type || '');
        // .replace after tf (house pattern of the pending banner): tf only
        // interpolates a FOUND key — the English fallback needs the manual
        // substitution until en.json carries the key
        line.textContent = C.tf('uplift.se.typenote.hidden',
            'Generation settings (sampling, thinking, grammar, speculative decoding) do not apply to the {type} engine and are hidden here, exactly as in the classic dashboard.')
            .replace('{type}', (eff || 'non-LLM').toUpperCase());
    } else {
        line.textContent = C.tf('uplift.se.typenote.flip',
            'The type override switches this form to the {type} family. The server rebuilds the engine with the override on the next load.')
            .replace('{type}', S.normType(seValues.model_type_override).toUpperCase());
    }
    note.append(line);
    // sticky warning: the type gate HIDES rows, it cannot clear stored
    // values (the classic PUT merges — omitted fields are not touched),
    // and some load-time keys (trust_remote_code) still take effect for
    // non-LLM engines. Name them so nobody believes the model is clean.
    if (!isTemplate && !llm) {
        const sticky = S.stickyForType(seBaseRaw).filter(
            k => !seDirtyKeys().includes(k));
        if (sticky.length) {
            const warn = document.createElement('div');
            warn.className = 'se-typenote-sticky';
            warn.textContent = C.tf('uplift.se.typenote.sticky',
                'Stored settings from the hidden families are NOT cleared by the type gate and keep their listed effect: {keys}.')
                .replace('{keys}', sticky.join(', '));
            note.append(warn);
        }
    }
    container.prepend(note);
}

/* seReapplyMarks: renderEditorFields rebuilds nodes, losing the dirty
   visuals applyRowState put on them and the amber pending-restart marks.
   Re-derive BOTH from state (never cached): dirty rows from the active
   tab's dirty set against its frozen original, pending rows from
   seDeferred. The old pattern (U3 chip work) hit exactly this trap —
   a re-render (kwargs add/remove, tab switch, type flip) silently
   un-dirtied the CHANGES rail for rows whose value was still changed. */
/* ---- REQ-DIV display: snapshot-equals-base tagging ----------------------
   A profile is a snapshot, but a stored value that EQUALS the base's
   current effective value behaves exactly like inheritance today. Those
   rows carry a dim '(= base)' tag; the moment a base edit (queued or
   saved) breaks the equality the tag lifts and REQUEST DIVERGENCE names
   the row — the user sees the snapshot turn stale instead of discovering
   it at request time. Server-key -> editor-state-key twins for the few
   renamed fields; everything else is name-identical. */
const SE_REQ_TWINS = { thinking_budget_enabled: 'enableThinkingBudget',
                       max_tool_result_tokens: 'enableToolResultLimit',
                       gpu_power_limit_w: 'enableGpuPowerLimit' };
function seReqBaseVals() {
    // base tab's CURRENT state: frozen snapshot + queued (dirty) edits
    const t0 = seTabs.find(z => z.id === 'base');
    if (!t0) return seBaseVals;
    const out = Object.assign({}, seBaseVals, t0.workVals);
    if (seActiveTab === 'base') Object.assign(out, seValues);
    return out;
}
function seTagInheritedRows() {
    const fields = document.getElementById('se-fields');
    if (!fields || !seModel || (seFormModel && seFormModel._template)) return;
    const t = seTab(); if (!t || t.id === 'base') return;
    const base = seReqBaseVals();
    const S = window.UpliftModelSpec;
    // stored = the profile's OWN overrides ONLY (never the merged workVals:
    // an inherited key already reads as such via the placeholder; tagging
    // it '(= base)' would claim a stored snapshot that does not exist).
    // Fresh tabs carry server keys (p.settings), captured tabs editor keys.
    const stored = t.overrides || {};
    for (const k of S.REQUEST_DIFF_KEYS) {
        const sk = SE_REQ_TWINS[k] || k;
        const row = fields.querySelector('[data-key="' + sk + '"]');
        if (!row) continue;
        const has = (k in stored) || (sk in stored);
        if (!has) { const old0 = row.querySelector('.se-req-tag');
                    if (old0) old0.remove(); row.classList.remove('se-req-eq');
                    continue; }
        const val = stored[sk] !== undefined ? stored[sk] : stored[k];
        const bval = base[sk] !== undefined ? base[sk] : base[k];
        let eq = S.eqBase(val, bval, k, seFormModel, SE_GS);
        // a row the user is actively editing is never 'equal to base'
        if (t.dirty.has(sk) || t.dirty.has(k)) eq = false;
        row.classList.toggle('se-req-eq', eq);
        let tag = row.querySelector('.se-req-tag');
        if (eq && !tag) {
            tag = document.createElement('small');
            tag.className = 'se-req-tag';
            tag.textContent = C.tf('uplift.se.reqdivergence.equal',
                '(= base)');
            tag.title = C.tf('uplift.se.reqdivergence.equal.title',
                'The profile stores this value itself; it only matches the base right now. A base change makes it stale — the REQUEST DIVERGENCE banner names it.');
            row.querySelector('span:first-child').append(' ', tag);
        } else if (!eq && tag) tag.remove();
    }
}

function seReapplyMarks() {
    const t = seTab(); if (!t) return;
    for (const k of t.dirty) {
        const row = document.querySelector(`#se-fields [data-key="${k}"]`);
        if (!row) continue;
        const orig = (t.id !== 'base' && SE_INHERIT_KEYS.has(k))
            ? seOvSnap(t)[k] : ((t.origVals || seOrig)[k]);
        window.UpliftDirty.applyRowState({
            orig, cur: seValues[k], row,
            isSecret: MM_GLUE.SECRET_KEYS.has(k),
            isRestart: seIsRuntimeKey(k),
            display: MM_GLUE.gsDisplay });
    }
    seMarkPendingRows();
    seTagInheritedRows();   // REQ-DIV: (= base) tags from current state
    seUpdateSaveBtn();   // rail + SAVE label refresh after the rebuild
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
    const section = (title) => { sect = seSection(title);
        container.append(sect); return sect.__body; };
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
    /* ---- MT-1 type gate: classic renders the identity row + TTL for EVERY
       model type and hides sampling/thinking/acceleration/spec-decode/
       grammar/kwargs plus trust_remote_code behind `llm || vlm`. Mirror the
       mechanism (see helper comment above seModelEntry). ---- */
    const llm = seIsLlmFamily();
    let g;
    // MT-1 follow-up (user 2026-10-10): classic's 'Model Alias' — the value
    // is API-routable (engine_pool resolves model_id_or_alias), so calling
    // it 'Display Name' suggested a cosmetic rename; the earlier rename was
    // reverted. Locales carry classic's own translations verbatim.
    // UP-18 (3): classic isGgufModel — the server 400s a type override on a
    // GGUF (routes.py:2853), so classic hides the Model Type row there.
    const gguf = !!(m && m.model_format === 'gguf');
    // UP-18 (3): classic effectiveExternalEngine — a GGUF runs on an
    // external engine even when its setting picks none (dashboard.js:4358).
    const eeEngines = (m && m.external_engines) || [];
    const extEngActive = () => !!seValues.external_engine
        || (gguf && eeEngines.length > 0);
    const aliasRow = () => seBind('text', 'model_alias', { label: 'Model Alias' });
    const typeRow = () => seBind('select', 'model_type_override', {
        label: 'Model Type',
        // the override IS the type gate: re-shape the form live (classic's
        // reactive x-show equivalent)
        onChange: () => {
            const root = document.getElementById('se-fields');
            if (seFormModel && seFormModel._template) {
                seRefreshGates(root || document);   // templates never gate
                return;
            }
            if (!root) return;
            if (!S.llmLike(seModelEntry())) {
                // queued edits to rows the new family hides cannot be
                // reviewed anymore — revert them (silent drops out of a
                // CHANGES rail are what DIV-2 lessons call a lie)
                const t = seTab();
                if (t) {
                    for (const k of [...t.dirty]) {
                        if (!S.TYPE_ONLY_KEYS.has(k)) continue;
                        const orig = (t.id !== 'base' && SE_INHERIT_KEYS.has(k))
                            ? seOvSnap(t)[k] : ((t.origVals || seOrig)[k]);
                        seValues[k] = orig === undefined
                            ? (t.id !== 'base' ? undefined : seOrig[k]) : orig;
                        t.dirty.delete(k);
                        if (t.id !== 'base' && orig === undefined)
                            delete t.overrides[k];
                    }
                    if (seIsBaseTab()) t.workVals = Object.assign({}, seValues);
                }
            }
            renderEditorFields(root);
        },
        options: [{ value: '', label: 'Auto-detect' },
                  ...S.MODEL_TYPE_OPTIONS.map(v => ({ value: v }))] });

    if (!llm) {
        /* Non-LLM engine (embedding / reranker / audio / decision):
           classic's ungated fields only — alias, type, reasoning parser,
           TTL — plus the embedding audio block where the server flags it.
           Title follows the seSection literal convention (uplift.se.section.*
           keys carry no translations, like every other section here). */
        section('Basic Settings');
        g = grid();
        if (seIsBaseTab() || !seTab().template) g.append(aliasRow());
        if (!gguf) g.append(typeRow());   // UP-18 (3): GGUF hides Model Type
        if (seValues.reasoning_parser !== undefined || m.reasoning_parsers) {
            const seen = new Set();
            const rp = [{ value: '', label: 'None' }];
            const addp = (value, label) => {
                if (!value || seen.has(value)) return;
                seen.add(value); rp.push({ value, label: label != null ? label : value });
            };
            (GRAMMAR_PARSERS || []).forEach(p => addp(p.value,
                p.label + (p.models && p.models.length ? ' (' + p.models.join(', ') + ')' : '')));
            (m.reasoning_parsers || []).forEach(v => addp(v));
            addp(seValues.reasoning_parser || '');
            g.append(seBind('select', 'reasoning_parser', { label: 'Reasoning Parser', options: rp }));
        }
        // UP-54 (upstream 153aaee #4826 + its older embedding twin): classic's
        // ms-basic rows the per-model context window for embedding AND
        // reranker engines between Model Type and TTL — each with its own
        // hint. modelspec's CTX_WINDOW_TYPES carve-out keeps the key alive
        // in the payload for exactly these two families.
        const effT = String(m.model_type_override || m.model_type || '');
        if (effT === 'embedding' || effT === 'reranker')
            g.append(seBind('number', 'max_context_window', {
                label: C.tf('modal.model_settings.max_context_window', 'Context Window'),
                hint: C.tf(effT === 'embedding'
                        ? 'modal.model_settings.embedding_context_window_hint'
                        : 'modal.model_settings.reranker_context_window_hint',
                    effT === 'embedding'
                        ? 'Longer inputs are truncated to this length when a request does not set max_length.'
                        : 'Used when a request does not set max_length. Jina rerankers read documents together up to this many tokens, other rerankers cut each query-document pair to this length.'),
                min: 1, step: 1, effHint: seEffHint('max_context_window') }));
        g.append(seBind('number', 'ttl_seconds', { label: 'TTL (Seconds)',
            min: 0, step: 60, disabled: !!(m && m.pinned),   // UP-18 (6)
            effHint: seEffHint('ttl_seconds') }));
        if (m.embedding_audio_supported) {
            seFam(g, 'embedding_audio_enabled',
                seBind('bool', 'embedding_audio_enabled', { label: 'Audio Input',
                    hint: 'Load the audio encoder so /v1/embeddings accepts audio items. Uses more memory even for text-only requests. Applies after the model reloads.' }),
                [seBind('number', 'embedding_audio_max_seconds',
                    { label: 'Max Audio Length (s)', min: 1, step: 1,
                      hint: 'Longer audio is cut at this length. Leave empty for 30 s. The model context caps it at about 5 minutes.' })]);
        }
        seTypeNote(container);
        seRefreshGates(container);
        { const h = seRailHost(container);       // SPL-RAIL: one box = no nav
          if (h) { h.body.classList.remove('has-rail'); h.nav.textContent = ''; h.nav.hidden = true; } }
        seReapplyMarks();
        return;
    }

    /* ---- SPL-RAIL (upstream #4415, user 2026-10-11): the form mirrors
       classic's section split — Basic / Generation Defaults /
       Acceleration / Memory Saving / Advanced / Experimental — shown
       as vertical tabs (one box visible; hidden boxes stay RENDERED so
       row lookup, gate refresh and dirty marks never change). Field
       membership follows classic _modal_model_settings.html exactly. ---- */

    /* ---- basic: identity + thinking switch + TTL (classic ms-basic) ---- */
    section('Basic Settings');
    g = grid();
    if (seIsBaseTab() || !seTab().template)
        g.append(aliasRow());
    if (!gguf) g.append(typeRow());   // UP-18 (3): GGUF hides Model Type
    if (!S.isDiffusion(m))
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
    g.append(seBind('number', 'ttl_seconds', { label: 'TTL (Seconds)',
        min: 0, step: 60, disabled: !!(m && m.pinned),   // UP-18 (6): classic MO:385
        effHint: seEffHint('ttl_seconds'),
        hint: 'Unloads the model automatically after it stays idle this long.' }));

    /* ---- generation defaults: context, length, sampling (classic ms-generation) ---- */
    section('Generation Defaults');
    // UP-20 (3): classic's Load Defaults button on the section header
    // (_modal_model_settings.html:429-433, dashboard.js:3571). Model-scoped
    // only: the template editor has no generation config to read.
    if (seModel && !m._template) seGenDefaultsBtn(sect);
    g = grid();
    g.append(seBind('number', 'max_context_window', { label: 'Context Window', step: 1,
        effHint: seEffHint('max_context_window'),
        hint: 'Sets the total context size the model can handle. Longer prompts are rejected.' }));
    g.append(seBind('number', 'max_tokens', { label: 'Max Tokens', min: 1, step: 1,
        effHint: seEffHint('max_tokens'),
        hint: 'Limits how many tokens the model generates in one turn when the request does not set max_tokens.' }));
    const sampling = [
        ['temperature', 0, 2, 0.05, 'Temperature'], ['top_p', 0, 1, 0.05, 'Top P'],
        ['top_k', 0, null, 1, 'Top K'], ['repetition_penalty', 0.5, 2, 0.01, 'Repetition Penalty'],
        ['min_p', 0, 1, 0.01, 'Min P'], ['presence_penalty', -2, 2, 0.05, 'Presence Penalty']];
    const inheritOn = !seIsBaseTab();
    if (!S.isDiffusion(m)) for (const [k, mn, mx, st, lab] of sampling) {
        if (inheritOn) {
            // EFF-1: an empty inheritable field shows its BASE value as
            // '(inherited)' (richer than any fallback); the fallback hint
            // only reaches base-tab empties via effHint below
            g.append(seBind('inheritable-number', k, { label: lab, min: mn, max: mx, step: st,
                effHint: seEffHint(k) }));
            continue;
        }
        g.append(seBind('number', k, { label: lab, min: mn, max: mx, step: st,
            effHint: seEffHint(k) }));
    }
    g.append(seBind('bool', 'force_sampling', { label: 'Force Sampling',
        hint: 'Override request sampling parameters with configured values' }));

    /* ---- acceleration: the whole speculative-decode stack + prefill
       engines (classic ms-acceleration; absorbs the old Speculative
       Decoding and DFlash sections) ---- */
    section('Acceleration');
    if (extEngActive()) sect.__body.append(eeNote());   // UP-18 (3), classic MO:515
    g = grid();
    const models = MM_STATE.adminModels.length ? MM_STATE.adminModels : [];
    const S_ = window.UpliftModelSpec;
    if (!S_.isDiffusion(m)) {
        // round 6 item 4: DFlash keeps its band header INSIDE the
        // Acceleration box (classic moved it here); a fresh grid below a
        // subhead never breaks the pair tracks (UX-5 rule).
            if (seValues.mtp_enabled !== undefined) {
                // UX-5: one band [toggle | depth] (both keys share reload
                // semantics); no re-render, no reflow
                // MTP-HEAD (user 2026-10-21): a model WITHOUT an MTP head
                // cannot turn Lightning MTP on — classic's modal disables
                // the toggle under exactly (!mtp_compatible && !mtp_enabled),
                // so the hint no longer contradicts a clickable control.
                // A stored enable stays togglable TO OFF (legacy/removed-head
                // escape). The lock fires on the EXPLICIT server verdict
                // (mtp_compatible === false): a row without the field (an
                // older keg that still renders the row) stays clickable —
                // absent data is never treated as a refusal.
                const mtpNoHead = m && !m._template && !m._missing
                    && m.mtp_compatible === false;
                const mtpCompat = !(m && m.mtp_compatible === false);
                // UP-18 (1): classic MO:538 — expert offload locks MTP only
                // when the server says this model cannot pair them.
                const mtpOffloadLock = !!seValues.moe_expert_offload_enabled
                    && !(m && m.moe_offload_allows_mtp === true);
                // SYNC-1 (upstream 95e0fd6 #4819): classic MO:854 adds the
                // fp16 recast to the MTP lock — the recast owns the
                // activation path this model drafts through.
                const mtpFp16Lock = seValues.activation_fp16_enabled === true;
                const mtpLock = (mtpNoHead || mtpOffloadLock || mtpFp16Lock)
                    && seValues.mtp_enabled !== true;
                const mtpWhy = mtpNoHead
                    ? (m.mtp_compatibility_reason || 'Not compatible with this model')
                    : mtpFp16Lock
                        ? 'Float16 activations are on — Lightning MTP cannot pair with the recast.'
                        : 'MoE expert offload is on — this model cannot pair it with Lightning MTP.';
                const mtpRow = seBind('bool', 'mtp_enabled', {
                    label: 'Lightning MTP',
                    disabled: mtpLock,
                    hint: mtpCompat
                        ? "Drafts several tokens per step with the model's built-in MTP head."
                        : mtpWhy });
                if (mtpLock) {
                    // a disabled input swallows hover tooltips in some
                    // engines — title the WHOLE row, like classic titles
                    // the toggle wrapper
                    mtpRow.title = mtpWhy;
                    const mi = mtpRow.querySelector('input');
                    if (mi) mi.title = mtpWhy;
                    // UP-20 (4): classic's one-click fix when the refusal IS
                    // a missing side-car import — the button appears exactly
                    // when the server reason names the MTPLX side-car (same
                    // condition as classic modal :526); POST import-mtplx,
                    // then reopen the editor so mtp_compatible refreshes.
                    if (mtpNoHead && /MTPLX side-car/.test(m.mtp_compatibility_reason || '')) {
                        const ib = document.createElement('button');
                        ib.type = 'button'; ib.className = 'se-btn act';
                        ib.textContent = C.tf('modal.model_settings.mtplx_import', 'Import MTP side-car');
                        ib.onclick = () => {
                            ib.disabled = true;
                            ib.textContent = C.tf('modal.model_settings.mtplx_importing', 'Importing...');
                            MM_GLUE.postJson(`${API}/admin/api/models/${encodeURIComponent(seModel)}/import-mtplx`, null)
                                .then(d => {
                                    if (d && d.message) MM_GLUE.toast(d.message);
                                    return openEditor(seModel, seWantProfile);
                                })
                                .catch(e => {
                                    MM_GLUE.toast(String((e && e.detail) || D.errText(e)) ||
                                        C.tf('js.error.mtplx_import_failed', 'MTPLX side-car import failed'), 'error');
                                    ib.disabled = false;
                                    ib.textContent = C.tf('modal.model_settings.mtplx_import', 'Import MTP side-car');
                                });
                        };
                        mtpRow.append(ib);
                    }
                }
                seFam(g, 'mtp_enabled', mtpRow,
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
                // UP-18 (2): classic MO:692-697 — VLM MTP is locked for a
                // PAROQUANT checkpoint (reason tooltip) and while offload,
                // DFlash or SpecPrefill occupy the spec slot.
                const pq = !!seValues.is_paroquant;
                const vlmLock = pq || !!seValues.moe_expert_offload_enabled
                    || !!seValues.dflash_enabled || !!seValues.specprefill_enabled;
                const vlmRow = seBind('bool', 'vlm_mtp_enabled', { label: 'VLM MTP',
                    disabled: vlmLock,
                    hint: 'Uses an external drafter from mlx-vlm (Gemma 4 assistant or Qwen MTP) instead of the built-in Lightning MTP drafter.' });
                if (vlmLock) vlmRow.title = pq ? (seValues.paroquant_reason || 'Paroquant checkpoint')
                    : 'Another offload or speculative path is enabled.';
                g.append(vlmRow);
                const sb = seGate(sub(g), 'vlm_mtp_enabled');
                const pool = S_.vlmMtpDrafters(models, m.id).map(x => ({ value: x.id }));
                sb.append(seBind('select', 'vlm_mtp_draft_model', { label: 'Drafter model', options: [
                    { value: '', label: 'Select an assistant or MTP drafter…' }, ...pool], picker: true }));
                sb.append(seBind('number', 'vlm_mtp_draft_block_size',
                    { label: C.tf('uplift.ui.draft_block_size_tokens_per_round_blank_4', 'Draft block size (tokens per round, blank = 4)'), step: 1 }));
            }

        const dfh = document.createElement('div');
        dfh.className = 'se-subhead'; dfh.textContent = 'DFlash';
        sect.__body.append(dfh);
        g = grid();
            if (seValues.dflash_enabled !== undefined) {
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
                    seBind('number', 'dflash_draft_quant_group_size', { label: 'Group Size', min: 16, max: 256, step: 16 }));
                sb.append(quantBox);
                // SYNC-1 (upstream 7a4ea39): activation bits, max ctx, the
                // in-memory/SSD cache rows and the draft-sink row are DELETED
                // from ModelSettingsRequest (extra='forbid') — classic's modal
                // dropped them too; what survives is window/block/verify.
                sb.append(seBind('number', 'dflash_draft_window_size', { label: 'Draft window size' }));
                sb.append(seBind('number', 'dflash_block_size', { label: 'Runtime block size', step: 1 }));
                sb.append(seBind('select', 'dflash_verify_mode', { label: 'Verify mode', options: [
                    { value: 'adaptive', label: 'adaptive (default)' },
                    { value: 'dflash', label: 'dflash' },
                    { value: 'off', label: 'off' }], picker: true }));
            }
    }
    if (seValues.deepseek_v41_ced_prefill_supported)
        g.append(seBind('bool', 'deepseek_v41_ced_prefill_enabled',
            { label: C.tf('uplift.ui.ced_prefill_acceleration_deepseek_v4_1', 'CED Prefill Acceleration (DeepSeek V4.1)'),
              hint: 'Improves prefill speed by approximately 74-79% in tested configuration.' }));
    // SYNC-1 (upstream 3c39990): qwen4_gdn_decode_wide_proj moved from the
    // SERVER settings to per-model settings — the row left the global page and
    // lives here now, classic's model-level capability gate (dashboard.js:2152:
    // config_model_type === 'qwen4_exp'; the server clamps it the same way at
    // routes.py:2833). A model row without the input (an older keg) leaves the
    // row hidden AND buildPayload omits the key, so a pre-move server never
    // sees it. Labels reuse the keys the global row already ships.
    if (seValues.qwen4_gdn_decode_wide_proj_supported)
        g.append(seBind('bool', 'qwen4_gdn_decode_wide_proj',
            { label: C.tf('uplift.gs.adv.wide_proj', 'Qwen4 Wide-Proj GDN Decode'),
              hint: C.tf('uplift.gs.adv.wide_proj_hint',
                  'Wider projection in fused Qwen4 GDN decode (experimental).') }));
    if (S.showsQwenOqA8(m)) {
        seFam(g, 'qwen35_oq_a8_enabled',
            seBind('bool', 'qwen35_oq_a8_enabled', { label: 'Qwen INT8 Activation Prefill',
                hint: 'Experimental GPU INT8 activation quantization for supported Q4/Q5/Q8 prefill.' }),
            [seBind('number', 'qwen35_oq_a8_min_tokens',
                { label: C.tf('uplift.ui.minimum_prompt_tokens', 'Minimum prompt tokens'), min: 1, step: 1 })]);
    }

    /* ---- memory saving (classic ms-memory): offload + KV quantization ---- */
    section('Memory Saving');
    if (extEngActive()) sect.__body.append(eeNote());   // UP-18 (3), classic MO:803
    g = grid();
    if (m.qwen4_ple_ssd_offload_supported || m.deepseek_v41_engram_ssd_offload_supported
            || seValues.qwen4_ple_ssd_offload || seValues.deepseek_v41_engram_ssd_offload) {
        // classic #4415 merged the two per-family rows into ONE 'SSD
        // N-gram Offload' (ssdNgramOffloadKey): the server keeps both
        // keys, a model exposes at most one family — resolve the same way.
        const isQwen = m.qwen4_ple_ssd_offload_supported || !!seValues.qwen4_ple_ssd_offload;
        const k = isQwen ? 'qwen4_ple_ssd_offload' : 'deepseek_v41_engram_ssd_offload';
        const forced = isQwen ? m.qwen4_ple_ssd_offload_forced
                              : m.deepseek_v41_engram_ssd_offload_forced;
        g.append(seBind('bool', k, { label: 'SSD N-gram Offload',
            hint: forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keeps the large N-gram table (Qwen4 PLE or DeepSeek V4.1 Engram) on SSD and reads only the rows it needs. Saves memory, but speed depends on SSD reads. Changing this setting reloads the model.',
            disabled: !!forced }));
    }
    if (m.moe_expert_offload_supported && !S.isDiffusion(m)) {
        // UP-18 (1): classic MO:845 — the OFFLOAD toggle is locked while an
        // incompatible spec path is on (MTP only when the model disallows).
        const offLock = (!!seValues.mtp_enabled && !(m.moe_offload_allows_mtp === true))
            || !!seValues.vlm_mtp_enabled || !!seValues.dflash_enabled
            // SYNC-1 (upstream 95e0fd6 #4819, MO:857): mutual lock with the
            // fp16 recast — the server 400s the pair (validate mirrors it).
            || seValues.activation_fp16_enabled === true;
        const offRow = seBind('bool', 'moe_expert_offload_enabled', {
            label: 'MoE Expert Offload',
            disabled: offLock,
            hint: C.tf(m.moe_offload_allows_mtp === true
                    ? 'modal.model_settings.moe_expert_offload_speculative_hint_v41'
                    : 'modal.model_settings.moe_expert_offload_speculative_hint',
                m.moe_offload_allows_mtp === true
                    ? 'This model pairs expert offload with Lightning MTP.'
                    : 'Speculative decoding (MTP/DFlash) needs the experts resident.') });
        if (offLock) offRow.title = 'Disable the active speculative-decoding path first.';
        // UP-18 (7): classic's 5..95 % ladder (MOE_EXPERT_OFFLOAD_MIN/
        // MAX_PERCENT, dashboard.js:12-13) on the fraction mirror
        const fracRow = seBind('number', 'moe_expert_offload_resident_fraction',
            { label: C.tf('uplift.ui.resident_experts_fraction', 'Resident experts (fraction)'), min: 0.05, max: 0.95, step: 0.05 });
        const offFam = seFam(g, 'moe_expert_offload_enabled', offRow, [fracRow]);
        // UP-55 (upstream d520df3 #4858): classic sizes the residency
        // against this Mac's prompt reserve and offers a one-click apply —
        // GET models/<id>/moe-offload-fit, re-queried only when a flag that
        // changes the estimate moves (mtp / the two ssd offloads).
        {
            const fitP = document.createElement('p');
            fitP.className = 'se-hint';
            fitP.hidden = true;
            offFam.append(fitP);
            const fmtB = n => C.fmtBytes ? C.fmtBytes(n) : String(n);
            const fitTxt = (key, en, fit) => C.tf(key, en)
                .replace('{percent}', fit.max_percent)
                .replace('{size}', fmtB(fit.bytes))
                .replace('{reserve}', fmtB(fit.reserve_bytes));
            let fitUrl = null;
            const loadFit = () => {
                const p = S.buildPayload(seValues, seModelEntry());
                const q = new URLSearchParams();
                for (const k of ['mtp_enabled', 'qwen4_ple_ssd_offload',
                                 'deepseek_v41_engram_ssd_offload'])
                    q.set(k, String(!!p[k]));
                const url = `${API}/admin/api/models/${encodeURIComponent(m.id)}/moe-offload-fit?${q}`;
                if (url === fitUrl) return;
                fitUrl = url;
                MM_GLUE.fetchJson(url).then(fit => {
                    // a late answer for a superseded request or a closed
                    // editor writes nothing (classic's url-guard, mirrored)
                    if (fitUrl !== url || !fitP.isConnected) return;
                    const st = fit && fit.status;
                    fitP.textContent = '';
                    if (st === 'fit') {
                        const b = document.createElement('button');
                        b.type = 'button'; b.className = 'se-btn act';
                        b.textContent = fitTxt('modal.model_settings.moe_expert_offload_fit',
                            'Fit to memory: {percent}% resident (~{size}) leaves about {reserve} for prompts',
                            fit);
                        // classic writes the percent ladder then re-clamps
                        // through its own handler — we drive the SAME input
                        // event the user would, so dirty/save stay honest
                        b.onclick = () => {
                            const wi = fracRow.querySelector('input');
                            if (!wi) return;
                            wi.value = String(Math.max(0.05,
                                Math.min(0.95, (fit.max_percent || 5) / 100)));
                            wi.dispatchEvent(new Event('input', { bubbles: true }));
                        };
                        fitP.append(b);
                        fitP.hidden = false;
                    } else if (st === 'no_fit') {
                        fitP.textContent = fitTxt('modal.model_settings.moe_expert_offload_no_fit',
                            "Even 5% resident leaves less than {reserve} for prompts under this Mac's memory limit.",
                            fit);
                        fitP.hidden = false;
                    }
                    // 'unknown' / 'resident' stay silent, like classic
                }).catch(() => { /* older keg without the endpoint: silent */ });
            };
            const fitKeys = new Set(['mtp_enabled', 'qwen4_ple_ssd_offload',
                                     'deepseek_v41_engram_ssd_offload']);
            const fitHost = document.getElementById('se-fields') || g;
            if (fitHost.__fitLis) fitHost.removeEventListener('change', fitHost.__fitLis);
            fitHost.__fitLis = ev => {
                const r = ev.target && ev.target.closest && ev.target.closest('[data-key]');
                if (r && fitKeys.has(r.dataset.key)) {
                    clearTimeout(fitHost.__fitTid);
                    fitHost.__fitTid = setTimeout(loadFit, 250);
                }
            };
            fitHost.addEventListener('change', fitHost.__fitLis);
            loadFit();
        }
    }
    if (seValues.turboquant_kv_enabled !== undefined) {
        // U41: no diffusion gate — classic shows TurboQuant for every model
        // (parity, user: "turboquant toggle is missing in model settings")
        // U41: classic's fixed ladder, not a 0.25-step free number
        // (user: bits can't be quarters)
        // UX-5 (user): ONE band [toggle | scheme | bits] — grouped, on the
        // shared column tracks, bits greyed + disabled until the toggle is on
        // SYNC-1 (upstream 7ffa8d4 #4659): classic renamed the family to
        // 'KV cache compression' and added a Format select; affine4/affine8
        // pin bits to 4/8 (the server 400s on any other pair). data-gate
        // only speaks bool, so the scheme->bits pin is wired by hand below.
        const tqSchemeRow = seBind('select', 'turboquant_kv_scheme', {
            label: 'Format',
            options: ['turboquant', 'affine4', 'affine8'].map(v => ({
                value: v, label: v === 'turboquant' ? 'TurboQuant'
                    : (v === 'affine4' ? 'Affine4 (4-bit)' : 'Affine8 (8-bit)') })) });
        const tqBitsRow = seBind('select', 'turboquant_kv_bits',
            { label: C.tf('uplift.ui.bits_per_channel', 'Bits per channel'),
              options: [2, 2.5, 3, 3.5, 4, 6, 8].map(v => ({ value: String(v), label: v + '-bit' })) });
        const tqBoolRow = seBind('bool', 'turboquant_kv_enabled', { label: 'KV cache compression',
            // UP-18 (2): classic MO:881-886 — a PAROQUANT checkpoint
            // cannot carry a quantized KV cache (reason tooltip); VLM
            // MTP also owns the memory/spec slot.
            disabled: !!seValues.is_paroquant || !!seValues.vlm_mtp_enabled,
            hint: 'Reduce KV cache memory using the selected format. TurboQuant supports 2 to 8 bits; Affine4 and Affine8 use 4-bit and 8-bit affine quantization.' });
        if (seValues.is_paroquant || seValues.vlm_mtp_enabled)
            tqBoolRow.title = seValues.is_paroquant
                ? (seValues.paroquant_reason || 'Paroquant checkpoint')
                : 'VLM MTP cannot be combined with KV cache compression.';
        const tqFam = seFam(g, 'turboquant_kv_enabled', tqBoolRow,
            [tqSchemeRow, tqBitsRow]);
        const tqBitsCtl = tqBitsRow.querySelector('select');
        const kvSchemeSync = () => {
            const s = seValues.turboquant_kv_scheme || 'turboquant';
            const pin = s === 'affine4' ? 4 : s === 'affine8' ? 8 : null;
            // UX-Z (user 2026-10-20): an affine format IS its bit depth —
            // classic hides the ladder under affine (x-show scheme ===
            // 'turboquant'); a greyed but visible Bits row read as a second
            // setting ('Affine8 turns into two settings').
            tqBitsRow.hidden = pin !== null;
            if (pin !== null && Number(seValues.turboquant_kv_bits) !== pin) {
                tqBitsCtl.value = String(pin);
                tqBitsCtl.dispatchEvent(new Event('change'));   // normal write path (dirty + save state)
            }
            // re-assert AFTER the dispatch: the bits change runs
            // seRefreshGates, which re-enables every active-gate control
            tqBitsCtl.disabled = pin !== null || seValues.turboquant_kv_enabled !== true;
        };
        // bubble listener on the band: covers scheme changes, master
        // re-enables and bits edits alike (seRefreshGates from unrelated
        // fields re-enables bits; the next edit or save re-pins it)
        tqFam.addEventListener('change', kvSchemeSync);
        kvSchemeSync();   // an already-affine stored state renders pinned
    }

    /* ---- advanced (classic ms-advanced): security, reasoning, limits,
       grammar, parser, chat-template kwargs ---- */
    section('Advanced Settings');
    if (extEngActive()) sect.__body.append(eeNote());   // UP-18 (3), classic MO:1230
    g = grid();
    g.append(seBind('bool', 'trust_remote_code', { label: 'Trust Remote Code',
        hint: 'Lets the model repo run arbitrary Python at load. Only enable for trusted repos.' }));
    // SYNC-1 2026-10-13 (upstream external_engine, splash): serve the model
    // from another engine's process. Classic renders it inside the Advanced
    // block, hidden for diffusion and when the model has no candidate
    // engines; the choice is engine-load material (engine_pool signature)
    // -> RUNTIME_SETTING_KEYS routes it through the deferred store, so the
    // classic PUT never sees it and a loaded model is not auto-unloaded.
    const eeList = (m && m.external_engines) || [];
    if (!S.isDiffusion(m) && eeList.length) {
        const cur = seValues.external_engine || '';
        const eeOpts = [{ value: '', label: 'Native oMLX engine' }].concat(
            eeList.filter(e => e.compatible || e.id === cur)
                .map(e => ({ value: e.id,
                    label: e.compatible ? e.label : (e.label + ' — unavailable') })));
        g.append(seBind('select', 'external_engine', {
            label: 'External Engine',
            // UP-18 (3): a GGUF carries no native engine — an empty pick
            // still runs externally (classic effectiveExternalEngine +
            // external_engine_gguf hint, MO:938)
            hint: gguf
                ? C.tf('modal.model_settings.external_engine_gguf',
                    'GGUF models always run through an external engine.')
                : (eeList.some(e => e.compatible)
                ? 'Run this model inside another installed engine (takes effect on model reload).'
                : (eeList[0].reason || 'No external engine available.')),
            options: eeOpts, picker: true }));
    }
    if (!S.isDiffusion(m)) {
        // NOTE: preserve_thinking has NO widget in the classic modal (it
        // only appears in the diffusion unsupported-field lists) — parity:
        // none here.
            seFam(g, 'enableThinkingBudget',
                seBind('bool', 'enableThinkingBudget', { label: 'Thinking Budget',
                    hint: 'Limit thinking tokens for reasoning models.' }),
                [seBind('number', 'thinking_budget_tokens',
                    { label: C.tf('uplift.ui.thinking_budget_tokens', 'Thinking budget (tokens)'), min: 1, step: 1 })]);

        // cache_reasoning_output: tri-state (null = auto: cache when
        // history preserves think-tags). Upstream #3525; additive,
        // same keys as the API.
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

    }

    /* ---- SYNC-1 (upstream d59d797 #4855 + 95e0fd6 #4819): GPU Power
       Limit and Float16 Activations join the Advanced column after the
       thinking rows, matching classic's template order (Thinking 1005 →
       GPU 1028 → FP16 1083 → Tool Result 1105). Classic gates the whole
       column on llm/vlm — the uplift non-llm branch never reaches this
       code — and puts NO diffusion gate on these two rows, so they live
       BETWEEN the diffusion-gated blocks. ---- */
    {
        const gpuSup = seValues.gpu_power_limit_supported === true;
        const gpuOn = seValues.enableGpuPowerLimit === true;
        const gpuWattsRow = seBind('number', 'gpu_power_limit_w', {
            label: C.tf('uplift.ui.gpu_power_limit_watts', 'Power limit (W)'),
            min: 2, max: 1000, step: 1 });
        const gpuFam = seFam(g, 'enableGpuPowerLimit',
            seBind('bool', 'enableGpuPowerLimit', {
                label: C.tf('modal.model_settings.gpu_power_limit', 'GPU Power Limit'),
                hint: C.tf('modal.model_settings.gpu_power_limit_hint',
                    'Caps GPU power for the whole Mac while this model generates, from 2 to 1000 W. It only helps below the usual draw. For example, an M5 Max uses about 25 W to generate an answer: 10 W saves about 40% energy per token and 5 W about half.'),
                // classic: the switch is clickable only when this Mac can
                // cap — or to turn OFF a limit a newer server stored
                disabled: !gpuSup && !gpuOn,
                // classic's click seeds 10 W when enabling an empty input.
                // NOTE: seBind's listener does onChange OR seRefreshGates —
                // carrying onChange means we must run the gate refresh
                // ourselves or the watts input stays disabled (live-caught
                // on the board, fire 9).
                onChange: vals => {
                    if (vals.enableGpuPowerLimit && !vals.gpu_power_limit_w) {
                        vals.gpu_power_limit_w = 10;
                        const wi = gpuWattsRow.querySelector('input');
                        if (wi) wi.value = '10';
                    }
                    seRefreshGates(document.getElementById('se-fields') || document);
                } }),
            [gpuWattsRow]);
        if (!gpuSup) {
            const warn = document.createElement('p');
            warn.className = 'se-hint';
            warn.textContent = C.tf('modal.model_settings.gpu_power_limit_unsupported',
                "This Mac's GPU does not support a power limit.");
            gpuFam.append(warn);
        }
        // classic's measured-cost guide (MO:1060-1080) — same static table
        const det = document.createElement('details');
        det.className = 'se-sub';
        const sum = document.createElement('summary');
        sum.textContent = C.tf('modal.model_settings.gpu_power_limit_guide_title',
            'Measured on M5 Max (other chips differ)');
        det.append(sum);
        const gt = document.createElement('table');
        const ghead = document.createElement('tr');
        [['Limit', 'gpu_power_limit_guide_limit'],
         ['Answer speed', 'gpu_power_limit_guide_answer'],
         ['Energy per token', 'gpu_power_limit_guide_energy'],
         ['Prompt speed', 'gpu_power_limit_guide_prompt']].forEach(([en, k]) => {
            const th = document.createElement('th');
            th.textContent = C.tf('modal.model_settings.' + k, en);
            ghead.append(th);
        });
        gt.append(ghead);
        [[C.tf('modal.model_settings.gpu_power_limit_guide_none', 'No limit'),
          'GPU 23-27 W', '-', 'GPU 67-76 W'],
        ['30-40 W', '0%', '0%', '-14 ~ -30%'],
        ['20 W', '-3 ~ -4%', '-11 ~ -12%', '-38 ~ -44%'],
        ['15 W', '-6 ~ -7%', '-25 ~ -29%', '-49 ~ -53%'],
        ['10 W', '-14 ~ -18%', '-37 ~ -43%', '-59 ~ -64%'],
        ['5 W', '-36 ~ -48%', '-49 ~ -52%', '-75 ~ -78%'],
        ['2 W', '-67 ~ -78%', '-47 ~ -52%', '-90 ~ -91%'],
        ].forEach(cells => {
            const tr = document.createElement('tr');
            cells.forEach(c => {
                const td = document.createElement('td');
                td.textContent = c;
                tr.append(td);
            });
            gt.append(tr);
        });
        det.append(gt);
        const gnote = document.createElement('p');
        gnote.textContent = C.tf('modal.model_settings.gpu_power_limit_guide_note',
            '30 W or more barely changes answer speed. Below 5 W, energy per token stops falling and answers only get slower. The minimum is 2 W. Other requests and apps also slow down while the limit is active. Benchmarks run without it.');
        det.append(gnote);
        gpuFam.append(det);
    }
    if (seValues.activation_fp16_supported) {
        // classic MO:1095: offload locks the recast (and the recast locks
        // offload); the row renders only when the server says this GPU
        // generation + checkpoint bf16 leaves can take it
        const fpLock = seValues.moe_expert_offload_enabled === true;
        const fpRow = seBind('bool', 'activation_fp16_enabled', {
            label: C.tf('modal.model_settings.activation_fp16', 'Float16 Activations'),
            hint: C.tf('modal.model_settings.activation_fp16_hint',
                "Converts the bfloat16 scales, norms and embeddings of this model to float16 at load. M1 and M2 GPUs emulate bfloat16, so prefill and decode run faster. Output can differ slightly from bfloat16. Not available with MoE expert offload."),
            disabled: fpLock && !seValues.activation_fp16_enabled });
        if (fpLock) {
            fpRow.title = 'MoE expert offload is on — disable it before the float16 recast.';
            const fi = fpRow.querySelector('input');
            if (fi) fi.title = fpRow.title;
        }
        g.append(fpRow);
    }
    if (!S.isDiffusion(m)) {
        seFam(g, 'enableToolResultLimit',
            seBind('bool', 'enableToolResultLimit', { label: 'Limit Tool Result Tokens',
                hint: 'Truncate large tool results (e.g. file reads) to a token limit.' }),
            [seBind('number', 'max_tool_result_tokens',
                { label: C.tf('uplift.ui.tool_result_token_limit', 'Tool result token limit'), min: 1, step: 1 })]);
    }
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

    if (!S.isDiffusion(m))
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

    /* chat-template kwargs: classic ms-advanced — join the open box */
    if (!S.isDiffusion(m)) {
        const kwh = document.createElement('div');
        kwh.className = 'se-subhead'; kwh.textContent = 'Chat Template Kwargs';
        sect.__body.append(kwh);
        renderCtKwargs(sect.__body);
    }

    /* ---- experimental (classic ms-experimental): ANE + index cache + SpecPrefill ---- */
    section('Experimental Features');
    g = grid();
    // UP-18 (4): classic MO:1538 — the Index Cache row exists only for the
    // DSA families (deepseek_v32 / glm_moe_dsa); its frequency rides the
    // 2..16 ladder and clears on disable (buildPayload sends 0).
    if (!S.isDiffusion(m) &&
            S.DSA_MODEL_TYPES.has(S.normType(m && m.config_model_type)))
            seFam(g, 'enableIndexCache',
                (() => {
                    const icBool = seBind('bool', 'enableIndexCache', { label: 'Index Cache',
                        disabled: !!seValues.is_paroquant,   // UP-18 (2), MO:1546-1551
                        hint: 'Skip redundant indexer computation in DSA layers (DeepSeek V3/GLM-5).' });
                    if (seValues.is_paroquant)
                        icBool.title = seValues.paroquant_reason || 'Paroquant checkpoint';
                    return icBool;
                })(),
                [seBind('number', 'index_cache_freq',
                    { label: C.tf('uplift.ui.frequency_every_nth_layer_keeps_indexer', 'Frequency (every Nth layer keeps indexer)'), min: 2, max: 16, step: 1 })]);
    // ANE prompt processing lives in the same section as classic
    const gAne = document.createElement('div');
    gAne.className = 'pair'; sect.__body.append(gAne);
    if (m.ane_prefill_backend && !S.isDiffusion(m)) renderAne(container, gAne);
    if (!S_.isDiffusion(m)) {
        const sph = document.createElement('div');
        sph.className = 'se-subhead'; sph.textContent = 'SpecPrefill';
        sect.__body.append(sph);
        g = grid();
            if (seValues.specprefill_enabled !== undefined) {
                const pool = S_.specprefillCandidates(models, m.id).map(x => ({ value: x.id }));
                // UX-5 (user): ONE band, four cells, TWO balanced lines —
                // [toggle | draft model] then [keep rate | threshold]
                // UP-18 (2): classic MO:1576-1581 — SpecPrefill is off
                // limits for PAROQUANT checkpoints; VLM MTP takes the slot.
                const spBool = seBind('bool', 'specprefill_enabled', { label: 'SpecPrefill',
                    disabled: !!seValues.is_paroquant || !!seValues.vlm_mtp_enabled });
                if (seValues.is_paroquant || seValues.vlm_mtp_enabled)
                    spBool.title = seValues.is_paroquant
                        ? (seValues.paroquant_reason || 'Paroquant checkpoint')
                        : 'VLM MTP cannot be combined with SpecPrefill.';
                const spAuto = seBind('bool', 'specprefill_auto_enabled', {
                    // SPEC-1: reuses classic's modal keys — translated in
                    // every locale through the mounted catalog.
                    label: C.tf('modal.model_settings.specprefill_auto',
                        'Active for Every Request'),
                    hint: C.tf('modal.model_settings.specprefill_auto_hint',
                        'Use SpecPrefill on every request above the threshold. When off, the drafter stays loaded but idle — requests can opt in individually and model aliases can turn it on.') });
                const spDraft = seBind('select', 'specprefill_draft_model',
                    { label: C.tf('uplift.ui.draft_model', 'Draft Model'), options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true });
                const spKeep = seBind('select', 'specprefill_keep_pct', { label: 'Keep Rate', options: [
                    { value: '0.1', label: '10% — Aggressive (~5-7x, some quality loss)' },
                    { value: '0.2', label: '20% — Balanced (~3x, recommended)' },
                    { value: '0.25', label: '25% — Conservative+ (~2.5x)' },
                    { value: '0.3', label: '30% — Conservative (~2.2x)' },
                    { value: '0.4', label: '40% — Mild (~1.8x)' },
                    { value: '0.5', label: '50% — Minimal (~1.5x)' }], picker: true });
                const spThr = seBind('number', 'specprefill_threshold',
                    { label: C.tf('uplift.ui.threshold_tokens', 'Threshold (tokens)'), min: 1024, max: 131072, step: 1024 });
                // SPEC-1: the four load knobs ride the model (excluded from
                // profile settings server-side); only the activation row is
                // alias-selectable. Lock them visibly greyed on profile tabs.
                const spWhy = C.tf('uplift.se.specprefill.load_locked',
                    'Tied to the model load — edit it on the BASE tab. An alias can only differ on activation.');
                seLockOnProfile(spBool, 'specprefill_enabled', spWhy);
                seLockOnProfile(spDraft, 'specprefill_draft_model', spWhy);
                seLockOnProfile(spKeep, 'specprefill_keep_pct', spWhy);
                seLockOnProfile(spThr, 'specprefill_threshold', spWhy);
                seFam(g, 'specprefill_enabled', spBool, [spAuto, spDraft, spKeep, spThr]);
            }
    }

    // MT-1: explain the gate when an override flips an LLM to another family
    seTypeNote(container);
    // UX-2: grey out every gated family whose master switch is off
    seRefreshGates(container);
    seReapplyMarks();
    seRail(container);   // SPL-RAIL: rebuild section nav after the boxes
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
        // BUG-FORCE (user 2026-10-14): forced entries used to render as a
        // dead read-only row — no way to edit the value, un-force, or even
        // remove it. Every entry is now a regular editable row with a
        // 'force' checkbox; buildPayload already splits e.force into
        // forced_ct_kwargs.
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
        // BUG-FORCE: the force flag is now a first-class editable control.
        const fkLbl = document.createElement('label');
        fkLbl.className = 'se-kwforce';
        const fkBox = document.createElement('input');
        fkBox.type = 'checkbox'; fkBox.checked = !!e.force;
        fkBox.title = C.tf('uplift.ui.kwarg_force_hint',
            'API requests cannot override this value');
        fkBox.addEventListener('change', () => {
            e.force = fkBox.checked;
            seSyncKwEntries();
        });
        const fkTxt = document.createElement('span');
        fkTxt.textContent = C.tf('uplift.ui.kwarg_force', 'force');
        fkTxt.dataset.i18n = 'uplift.ui.kwarg_force'; fkTxt.dataset.en = 'force';
        fkLbl.append(fkBox, fkTxt);
        if (!row.children.length) row.append(key, val);
        row.append(fkLbl, rm);
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
    // SPL-RAIL: vertical section tabs, a column left of the form (classic
    // #4415's settings-rail pattern in uplift shape); built once per editor
    const nav = document.createElement('nav');
    nav.className = 'se-rail'; nav.hidden = true;
    const changes = document.createElement('div');
    changes.id = 'se-changes'; changes.className = 'changelist ed'; changes.hidden = true;
    bodyRow.append(nav, scroll, changes);
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
/* ---- TTS-1: per-model voice defaults INSIDE the shared editor ----------
   The TEXT TO SPEECH tab's SETTINGS button and the manager's EDIT open the
   SAME editor (openEditor), so these fields exist in exactly one place.
   Honest by construction: the section renders only for audio_tts models
   whose CAPABILITIES PROBE proves the support (Qwen3-TTS checkpoints
   declare tts_model_type/size + spk_id in config.json — never guessed
   from names); every other engine sees NOTHING (silent-absence doctrine).
   What is set here is applied by uplift's OWN speech paths (stored-voice
   synthesis, the /uplift/v1 standard route, chat read-aloud) as
   request > voice > model-default per field; vanilla /v1 semantics are
   untouched. Storage is the uplift voice store (tts_defaults map), not
   classic model settings — a dirty TTS block counts like any other change
   and commits through POST /voices/tts/defaults inside the same SAVE. */
let seTts = null;             // {host, vals, orig, fields} | null
let seTtsGen = 0;             // editor-instance token (async attach race)
const TTS_EMPTY = { speaker: '', language: '', instructions: '' };

function seTtsIsDirty() {
    return !!seTts && JSON.stringify(seTts.vals) !== JSON.stringify(seTts.orig);
}

async function seCommitTts() {
    // the whole 3-key entry is (re)written: a control this model cannot
    // show keeps orig == vals, so it can never be dirtied by accident
    const d = await D.postJson(`${API}/uplift/api/voices/tts/defaults`,
        Object.assign({ model: seModel }, seTts.vals));
    const stored = (d && d.defaults && d.defaults[seModel]) || {};
    seTts.orig = Object.assign({}, TTS_EMPTY, stored);
}

function seTtsField(body, labelText, ctl) {
    const row = document.createElement('label');
    row.className = 'se-row';
    const cap = document.createElement('span');
    cap.textContent = labelText;
    row.append(cap, ctl);
    body.append(row);
    return row;
}

async function seTtsAttach(panel) {
    seTts = null;
    const gen = ++seTtsGen;
    const m = seFormModel || {};
    if ((m.engine_type || m.model_type) !== 'audio_tts') return;
    const model = seModel;
    // caps: reuse the voices-page probe cache when that module is loaded,
    // fetch directly otherwise (the editor may open before the Voices
    // page ever rendered); both answer the same shape
    let caps = null;
    try {
        caps = window.Uplift && window.Uplift.capsFor
            ? await window.Uplift.capsFor(model)
            : await MM_GLUE.fetchJson(`${API}/uplift/api/voices/capabilities`
                + `?model=${encodeURIComponent(model)}`);
    } catch (_) { return; }
    if (gen !== seTtsGen || !caps || !caps.qwen3) return;   // stale / silent
    let defaults = {};
    try {
        const d = await MM_GLUE.fetchJson(`${API}/uplift/api/voices/tts/defaults`);
        defaults = (d && d.defaults) || {};
    } catch (_) { defaults = {}; }
    if (gen !== seTtsGen || seModel !== model) return;
    const cur = Object.assign({}, TTS_EMPTY, defaults[model] || {});
    const vals = Object.assign({}, TTS_EMPTY, cur);

    const box = document.createElement('div');
    box.className = 'se-box se-tts';
    const h = document.createElement('h5');
    h.className = 'se-section';
    h.textContent = C.tf('uplift.voices.tts_section', 'TTS voice defaults');
    const body = document.createElement('div');
    body.className = 'se-box-body';
    const note = document.createElement('div');
    note.className = 'se-typenote';
    note.textContent = C.tf('uplift.voices.tts_section_note',
        'Used by every reading and voice output this dashboard produces with '
        + 'this model, unless the voice or the request says otherwise.');
    body.append(note);
    box.append(h, body);
    const touch = () => seUpdateSaveBtn();
    if (caps.type === 'custom_voice' && (caps.speakers || []).length) {
        const sel = document.createElement('select');
        const o0 = document.createElement('option');
        o0.value = '';
        o0.textContent = C.tf('uplift.voices.tts_no_default',
            'No default (each request decides)');
        sel.append(o0);
        for (const s of caps.speakers) {
            const o = document.createElement('option');
            o.value = s; o.textContent = s;
            sel.append(o);
        }
        sel.value = vals.speaker = cur.speaker || '';
        sel.onchange = () => { vals.speaker = sel.value; touch(); };
        seTtsField(body, C.tf('uplift.voices.speaker', 'Speaker'), sel);
    }
    if ((caps.languages || []).length) {
        const dl = document.createElement('datalist');
        dl.id = 'se-tts-lang-dl';
        for (const l of caps.languages) {
            const o = document.createElement('option'); o.value = l; dl.append(o);
        }
        const inp = document.createElement('input');
        inp.type = 'text'; inp.setAttribute('list', 'se-tts-lang-dl');
        inp.autocomplete = 'off';
        inp.placeholder = C.tf('uplift.voices.lang_auto', 'Auto (adaptive)');
        inp.value = vals.language = cur.language || '';
        inp.oninput = () => { vals.language = inp.value; touch(); };
        const wrap = document.createElement('span');
        wrap.append(inp, dl);
        seTtsField(body, C.tf('uplift.voices.language', 'Language'), wrap);
    }
    if (caps.instruct) {
        const ta = document.createElement('textarea');
        ta.rows = 2;
        ta.placeholder = C.tf('uplift.voices.instruct_ph',
            "e.g. Very happy. — tone, emotion, speaking rate in plain words");
        ta.value = vals.instructions = cur.instructions || '';
        ta.oninput = () => { vals.instructions = ta.value; touch(); };
        seTtsField(body, C.tf('uplift.voices.instruct', 'Instruct'), ta);
    }
    const orig = JSON.parse(JSON.stringify(vals));
    seTts = { host: box, vals, orig,
        labels: { speaker: 'speaker', language: 'language',
                  instructions: 'instruction' } };
    const scroll = panel.querySelector('.editor-scroll');
    if (!scroll) { seTts = null; return; }
    scroll.append(box);
    box.hidden = !seIsBaseTab();
}
/* ---- TTS-2: the editor's CUSTOM VOICES block ---------------------------
   The manager's EDIT SETTINGS presents the stored voices cloned on THIS
   model. Read-only list + EDIT: the click closes the editor and hands the
   voice to the voices page's own edit form (window.Uplift.voices.openVoices
   with the voice id) — one voice form in the app, zero duplication here.
   Silent-absence doctrine as with seTtsAttach: no rows, no box. Base tab
   only: voices belong to the model, not to a profile. */
let seVoicesGen = 0;              // editor-instance token (async attach race)
let seVoicesBox = null;

async function seVoicesAttach(panel) {
    const gen = ++seVoicesGen;
    seVoicesBox = null;
    const model = seModel;
    let d = null;
    try {
        d = await MM_GLUE.fetchJson(`${API}/uplift/api/voices`);
    } catch (_) { return; }        // a dead store keeps the form untouched
    if (gen !== seVoicesGen || seModel !== model) return;   // stale editor
    const own = ((d && d.voices) || []).filter(v =>
        String((v && v.model) || '') === model
        && String(v.model || '').indexOf('say:') !== 0);
    if (!own.length) return;
    const box = document.createElement('div');
    box.className = 'se-box se-voices';
    const h = document.createElement('h5');
    h.className = 'se-section';
    h.textContent = C.tf('uplift.voices.editor_title',
        'Custom voices on this model');
    const body = document.createElement('div');
    body.className = 'se-box-body';
    const note = document.createElement('div');
    note.className = 'se-typenote';
    note.textContent = C.tf('uplift.voices.editor_hint',
        'EDIT closes this dialog and opens the voice in TTS & Voices, '
        + 'where its reference clip, transcript and settings live.');
    body.append(note);
    for (const v of own) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'se-btn';
        edit.textContent = C.tf('uplift.voices.edit', 'EDIT');
        edit.onclick = () => {
            closeEditor();
            const go = () => window.Uplift.voices.openVoices(
                'clone', model, v.id);
            if (window.Uplift.voices) go();
            else D.loadScript('./uplift_voices.js')
                .then(go, () => MM_GLUE.toast(C.t('uplift.toast.failed',
                    { msg: 'voices page unavailable' }), 'error'));
        };
        seTtsField(body, String(v.name || v.id || ''), edit);
    }
    box.append(h, body);
    const scroll = panel.querySelector('.editor-scroll');
    if (!scroll) return;
    scroll.append(box);
    seVoicesBox = box;
    box.hidden = !seIsBaseTab();
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
    seTts = null; seTtsGen++;   // TTS-1: a stale probe must not attach here
    seVoicesBox = null; seVoicesGen++;   // TTS-2: same token rule for voices
    seModel = null; seFormModel = null;
    seActiveSect = null; SE_RAIL_HOST = null;
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
    // EFF-1: one global-settings read per editor open feeds the
    // dim effective-value placeholders (cheap, cache-busted on model change)
    if (SE_GS_FOR !== model) { SE_GS_FOR = model; await seLoadGs(); }
    // U41 phase-1 survivors: settings already stored but not yet applied by
    // a reload. They are SAVED, so they seed the form baseline (not dirty)
    // and get an amber pending-restart mark until phase 2 consumes them.
    await seLoadDeferred(model);
    seValues = window.UpliftModelSpec.buildState(seFormModel,
        Object.assign({}, settings, seDeferred));
    seOrig = JSON.parse(JSON.stringify(seValues));
    seBaseVals = JSON.parse(JSON.stringify(seValues));
    seTabs = [{ id: 'base', dirty: new Set(), origVals: JSON.parse(JSON.stringify(seOrig)) }];
    seActiveSect = null; SE_RAIL_HOST = null;   // SPL-RAIL: fresh editor, fresh tab state
    seActiveTab = 'base';
    window.__seDeferred = () => seDeferred;   // debug handle (__upLayout pattern)
    // is_hidden/is_favorite/is_default/pinned are toggled from the models ROW
    // (classic _models.html), never in the settings modal — parity: not here.
    // popup modal, not an inline accordion: stable size for long forms
    const panel = editorNode();
    // UP-20 (1,2): classic's title-bar snapshot actions
    // (_modal_model_settings.html:24-30): reset / optimal / recipe. Model
    // rows only — openTemplateEditor never reaches this line.
    panel.querySelector('.editor-head').append(seSnapshotActions());
    renderEditorFields(panel.querySelector('#se-fields'));
    seTtsAttach(panel).then(() => seVoicesAttach(panel));
    // TTS-1: silent unless this is a probed TTS model; TTS-2 chained AFTER
    // it so the CUSTOM VOICES box always lands below the voice defaults —
    // two racing async appends would shuffle with every warm cache flip
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
    seActiveSect = null; SE_RAIL_HOST = null;   // SPL-RAIL: fresh editor, fresh tab state
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
    const errors = window.UpliftModelSpec.validate(seValues, seFormModel);
    if (errors.length) { msg.textContent = errors[0]; MM_GLUE.toast(errors[0]); return; }
    // BUG-6 doctrine: no intermediate label; the button carries busy state
    const sb = document.getElementById('se-save');
    if (sb) sb.disabled = true;
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
        MM_TPL.render(true);
        setTimeout(closeEditor, 1000);
    } catch (err) {
        msg.textContent = 'error: ' + D.errText(err);
        MM_GLUE.toast(C.tf('uplift.mm.tpl_save_fail', 'Template save failed: ') + D.errText(err));
        if (sb) sb.disabled = false;   // reactivates for a retry
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
            : (t.template ? '\u25f1 ' : '') + (t.display_name || t.name || t.id);
        b.textContent = nm + mark;
        b.title = t.id === 'base' ? 'Model settings (base)'
            : (t.template ? 'Global template (copy, unsaved)' : 'Profile: ' + (t.name || ''));
        // UP-30 (classic pill :276-332): an exposed profile carries the API
        // badge on its pill — AMBER when the profile also holds engine-
        // (load-time) fields, green for a request-time-only one. The server
        // answers has_engine_fields per row (model_settings.py:1389).
        const sp = t.profileId
            && (MM_DATA.profiles || []).find(x => x.name === t.profileId);
        if (sp && sp.expose_as_model) {
            const badge = document.createElement('span');
            badge.className = 'se-tab-api ' + (sp.has_engine_fields ? 'api-eng' : 'api-ok');
            badge.textContent = 'API';
            if (sp.has_engine_fields)
                badge.title = C.tf('modal.model_settings.profiles.expose_engine_fields_hint',
                    "Engine-level settings in this profile only take effect when it is applied to the base model \u2014 they don't change the exposed model.");
            b.append(badge);
        }
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
                .catch(e => MM_GLUE.toast(C.tf('uplift.mm.load_fail', 'Load failed: ') + D.errText(e)));
        } else if (kind === 'msp') {
            const mid = decodeURIComponent(id.slice(0, id.indexOf('|')));
            const pname = id.slice(id.indexOf('|') + 1);
            MM_GLUE.fetchJson(`${API}/uplift/api/models/${encodeURIComponent(mid)}/profiles`)
                .then(d => {
                    const p = (d.profiles || []).find(x => x.name === pname);
                    if (p) seApplyIntoActiveTab(p.settings || {}, mid + ':' + pname + ' (missing)');
                    else MM_GLUE.toast(C.tf('uplift.mm.profile_missing', 'profile not found: ') + pname);
                })
                .catch(e => MM_GLUE.toast(C.tf('uplift.mm.load_fail', 'Load failed: ') + D.errText(e)));
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
                .catch(e => MM_GLUE.toast(C.tf('uplift.mm.load_fail', 'Load failed: ') + D.errText(e)));
        }
    };
    // UP-20 (5): classic refreshPresets (dashboard.js:94690) — POST the
    // admin refresh, repopulate the preset group and the 1-day cache.
    const rfb = document.createElement('button');
    rfb.type = 'button'; rfb.className = 'se-btn'; rfb.textContent = '\u21bb';
    rfb.title = C.tf('uplift.se.refresh_presets', 'Fetch latest presets');
    rfb.onclick = () => {
        rfb.disabled = true;
        MM_GLUE.postJson(`${API}/admin/api/presets/refresh`, null)
            .then(d => {
                MM_DATA.presets = (d && d.presets) || [];
                try { localStorage.setItem('omlx_preset_cache', JSON.stringify(d)); } catch (_) {}
                g1.replaceChildren();
                for (const p2 of MM_DATA.presets) {
                    const o2 = document.createElement('option'); o2.value = 'pre:' + p2.name;
                    o2.textContent = '\u25A7 ' + (p2.display_name || p2.name); g1.append(o2);
                }
                if (g1.children.length && !g1.parentElement) drop.append(g1);
            })
            .catch(e => MM_GLUE.toast(D.errText(e), 'error'))
            .finally(() => { rfb.disabled = false; });
    };
    strip.append(drop, rfb);
    // UP-30: the picker-row drift dot (classic active-profile dot, :276-332)
    // rides the same dirty truth the tab badges just recomputed — refresh it
    // here so it stays live while the user types on the profile's tab.
    const profHost = panel.querySelector && panel.querySelector('.se-profs');
    if (profHost && profHost._syncDrift) profHost._syncDrift();
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
    // REQ-DIV: the same preview for request-time keys. baseP is built from
    // the base tab's QUEUED state, so a not-yet-saved base edit that WOULD
    // make a snapshot stale warns before the SAVE, not after.
    const reqOut = [];
    for (const p of (MM_DATA.profiles || [])) {
        const diff = S.requestDiff(baseP, p.settings || {}, seFormModel, SE_GS);
        if (diff.length)
            reqOut.push({ name: p.name, display_name: p.display_name || p.name,
                          api_name: p.api_name || null, diff });
    }
    MM_DATA.reqDivergence = reqOut;
    renderDivergenceBanner();
    renderReqDivergenceBanner();
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
    // U85: the PRIMARY verb is applying just the queued base edits; the
    // full reset stays reachable but secondary.
    const apply = seDivergenceEditApplyBtn(panel);
    if (apply) line.append(apply);
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
function renderReqDivergenceBanner() {
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    let host = panel.querySelector('.se-reqdivergence');
    const fields = panel.querySelector('#se-fields');
    if (!fields) return;
    const diverging = MM_DATA.reqDivergence || [];
    if (!diverging.length) { if (host) host.remove(); return; }
    if (!host) {
        host = document.createElement('div');
        host.className = 'se-reqdivergence';
        fields.prepend(host);
    }
    host.textContent = '';
    const line = document.createElement('div');
    line.className = 'se-div-head';
    const names = diverging.map(d => d.api_name || d.display_name).join(', ');
    line.textContent = '⚠ REQUEST DIVERGENCE — ';
    const b = document.createElement('b');
    b.textContent = diverging.length === 1
        ? C.tf('uplift.se.divergence.one', 'profile ') + names
        : C.tf('uplift.se.divergence.many', 'profiles ') + names;
    const expl = document.createElement('span');
    expl.textContent = C.tf('uplift.se.reqdivergence.expl',
        ': request-time values stored there differ from the base model\'s current ones. A profile is a snapshot — it keeps its own value; the change shown reflects the base settings as queued right now.');
    const show = document.createElement('button');
    show.type = 'button'; show.className = 'se-btn se-div-show';
    show.textContent = C.tf('uplift.se.divergence.show', '(show)');
    show.onclick = () => {
        const det = host.querySelector('.se-div-detail');
        if (det) { det.remove(); show.textContent = C.tf('uplift.se.divergence.show', '(show)'); return; }
        show.textContent = C.tf('uplift.se.divergence.hide', '(hide)');
        host.append(seDivergenceDetail(diverging));
    };
    line.append(b, expl, show);
    const applyR = seDivergenceEditApplyBtn(panel);
    if (applyR) line.append(applyR);
    line.append(seDivergenceSyncBtn(diverging, panel, true));
    host.append(line);
}
function seDivergenceSyncBtn(diverging, panel, isReq) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'se-btn se-div-show se-div-sync';
    const label = () => C.tf('uplift.se.divergence.sync', 'SYNC BASE → PROFILES');
    let armed = false, timer = null;
    const disarm = () => { armed = false; btn.textContent = label();
                           btn.classList.remove('restart');
                           if (timer) { clearTimeout(timer); timer = null; } };
    btn.textContent = label();
    btn.title = C.tf('uplift.se.divergence.sync.title',
        'Reset the diverging load-time settings of these profiles to the base model\'s current values (they inherit them again). Each profile\'s other overrides stay as they are. RESETS ALL DIVERGING VALUES, not just your current base edits — for a single edited key use APPLY BASE EDITS instead.');
    if (isReq) btn.title = C.tf('uplift.se.reqdivergence.sync.title',
        'Drop the diverging request-time values from these profiles so they truly inherit the base model again. Each profile\'s other settings stay as they are; base edits still pending in the editor are NOT saved by this. RESETS ALL DIVERGING VALUES, not just your current base edits.');
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
            const n = await seSyncBaseToProfiles(diverging, isReq);
            if (n) MM_GLUE.toast(C.tf(isReq ? 'uplift.se.reqdivergence.synced'
                                            : 'uplift.se.divergence.synced',
                isReq ? 'Base request-time settings synced to '
                      : 'Base load-time settings synced to ') + n + ' profile(s): ' + names);
            else MM_GLUE.toast(C.tf('uplift.se.divergence.sync.none',
                'Nothing to sync — profiles already match the base'));
        } catch (err) {
            MM_GLUE.toast(C.tf('uplift.toast.action_failed',
                { action: 'sync profiles', msg: D.errText(err) }));
        }
        btn.disabled = false;
        refreshDivergence();
        seRenderTabs(panel);
        seUpdateSaveBtn();
    };
    return btn;
}
async function seSyncBaseToProfiles(diverging, isReq) {
    if (!seModel) throw new Error('no model loaded in editor');
    const fields = await MM_GLUE.modelSettingsFields();
    let n = 0;
    for (const d of diverging) {
        const p = (MM_DATA.profiles || []).find(x => x.name === d.name);
        if (!p) continue;
        // sparse overrides minus the diverging load-time keys = inherit base
        const ov = JSON.parse(JSON.stringify(p.settings || {}));
        for (const row of d.diff) {
            delete ov[row.key];
            for (const t of (SE_LEGACY_TWINS[row.key] || [])) delete ov[t];
        }
        n += await seWriteProfileSettings(d.name, d.display_name, ov, fields) ? 1 : 0;
    }
    CHIPS.clearProfileCache(seModel);   // alias-tree chips must re-fetch
    return n;
}
/* U85 (user 2026-10-12): profiles are MEANT to diverge — that is their
   point — so the full RESET sync above is demoted (secondary button, its
   title says plainly that it resets ALL diverging values). This is the
   verb the user actually wants: take ONLY the keys just edited on the
   base and push their current values into the chosen profiles. The write
   is an explicit override (not inheritance): a profile keeps tracking
   deliberately — divergence stays possible; the user diverges a value
   again on the profile tab whenever they want. */
async function seApplyBaseEditsToProfiles(edits, vals, targets) {
    if (!seModel) throw new Error('no model loaded in editor');
    const fields = await MM_GLUE.modelSettingsFields();
    const full = window.UpliftModelSpec.buildPayload(vals || seValues, seFormModel);
    const kwargsEdited = edits.has('chat_template_kwargs');
    let n = 0;
    for (const p of targets) {
        const ov = JSON.parse(JSON.stringify(p.settings || {}));
        for (const k of edits) {
            if (k === 'chat_template_kwargs' || k === 'forced_ct_kwargs') continue;
            if (full[k] === undefined) continue;
            if (full[k] === null) { delete ov[k];
                for (const t of (SE_LEGACY_TWINS[k] || [])) delete ov[t]; }
            else ov[k] = full[k];
        }
        if (kwargsEdited) {
            if (full.chat_template_kwargs == null) delete ov.chat_template_kwargs;
            else ov.chat_template_kwargs = full.chat_template_kwargs;
            if (full.forced_ct_kwargs == null) delete ov.forced_ct_kwargs;
            else ov.forced_ct_kwargs = full.forced_ct_kwargs;
        }
        n += await seWriteProfileSettings(p.name, p.display_name || p.name, ov, fields) ? 1 : 0;
    }
    CHIPS.clearProfileCache(seModel);
    return n;
}
/* One profile settings write + open-tab re-base, shared by BOTH sync
   verbs (U85: 'if U84 landed first, reuse its per-tab commit helper' —
   this is that shared commit seam). The PUT carries the profile's other
   fields unchanged; 404 (no engine entry) falls back to uplift upsert
   exactly like saveProfileCommit. */
async function seWriteProfileSettings(name, display_name, ov, fields) {
    const body = window.UpliftModelSpec.adaptToServerSettings(ov, fields);
    const p = (MM_DATA.profiles || []).find(x => x.name === name);
    const req = { settings: body, display_name: display_name || (p && p.display_name) || name,
        expose_as_model: !!(p && p.expose_as_model), api_name: (p && p.api_name) || null };
    try {
        await D.putJson(`${API}/admin/api/models/${encodeURIComponent(seModel)}`
            + `/profiles/${encodeURIComponent(name)}`, req);
    } catch (e) {
        if (e.status !== 404) throw e;
        // missing base model: classic PUT 404s; uplift upserts (same
        // fallback saveProfileTab uses)
        await D.postJson(`${API}/uplift/api/models/${encodeURIComponent(seModel)}/profiles`,
            Object.assign({ name }, req));
    }
    if (p) p.settings = body;
    // an open tab of this profile must not re-save the stale overrides:
    // re-base it on the written record. If that tab is ACTIVE (visible
    // widgets holding possibly-unsaved edits), re-render it from the
    // re-based values — both sync verbs confirm by name first, so trading
    // that tab's unsaved edits for an honest display is the informed
    // outcome. Other tabs re-base silently (not displayed).
    const t = seTabs.find(z => z.profileId === name);
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
    return true;
}
/* The primary U85 verb, rendered in BOTH divergence banners whenever the
   base tab holds queued edits: click opens a checkbox list of the stored
   profiles (default: EVERY profile ticked — follow-up user report
   2026-10-12: a profile appearing pre-deselected read as "not targeted";
   the verb's subject is all profiles of this base, untick to exclude),
   the key list in the confirm tooltip (write-before-confirm honesty:
   nothing is written until CONFIRM in the picker), then APPLY. */
function seDivergenceEditApplyBtn(panel) {
    const edits = seBaseEditKeys();
    if (!edits || !(MM_DATA.profiles || []).length) return null;
    const wrap = document.createElement('span');
    wrap.className = 'se-div-apply';
    const keyList = [...edits].join(', ');
    const mkBtn = () => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'se-btn se-div-show';
        btn.textContent = C.tf('uplift.se.editsync.apply', 'APPLY BASE EDITS \u2192 PROFILES');
        btn.title = C.tf('uplift.se.editsync.apply.title',
            'Push ONLY the values you just edited on the base model into the ticked profiles as explicit overrides. Every other profile setting stays exactly as it is — divergence survives.')
            + ' [' + keyList + ']';
        btn.onclick = openPicker;
        return btn;
    };
    const close = () => { wrap.textContent = ''; wrap.append(mkBtn()); };
    const openPicker = () => {
        wrap.textContent = '';
        const det = document.createElement('span');
        det.className = 'se-div-apply-pick';
        const boxes = [];
        for (const p of (MM_DATA.profiles || [])) {
            const l = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.value = p.name;
            cb.checked = true;   // default: every profile ticked; untick to exclude
            l.append(cb, ' ' + (p.api_name || p.display_name || p.name));
            det.append(l); boxes.push(cb);
        }
        const ok = document.createElement('button');
        ok.type = 'button'; ok.className = 'se-btn restart';
        ok.textContent = C.tf('uplift.se.editsync.confirm',
            'CONFIRM \u2014 apply these base values to the ticked profiles');
        ok.title = C.tf('uplift.se.editsync.keys', 'Keys: ') + keyList;
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'se-btn se-div-show';
        cancel.textContent = C.tf('uplift.se.editsync.cancel', '(cancel)');
        ok.onclick = async () => {
            const names = boxes.filter(c => c.checked).map(c => c.value);
            if (!names.length) { MM_GLUE.toast(C.tf('uplift.se.editsync.none',
                'tick at least one profile')); return; }
            ok.disabled = true; cancel.disabled = true;
            const targets = (MM_DATA.profiles || []).filter(p => names.includes(p.name));
            try {
                seCaptureTab();   // the queued base edits must be current
                const bt = seTabs.find(z => z.id === 'base');
                const vals = seIsBaseTab() ? seValues : (bt && bt.workVals) || seValues;
                const n = await seApplyBaseEditsToProfiles(edits, vals, targets);
                MM_GLUE.toast(C.tf('uplift.se.editsync.applied',
                    'Base edits applied to ') + n + ' profile(s): ' + names.join(', ')
                    + ' \u00b7 ' + keyList);
            } catch (err) {
                MM_GLUE.toast(C.tf('uplift.toast.action_failed',
                    { action: 'apply base edits to profiles', msg: D.errText(err) }));
            }
            refreshDivergence();
            seRenderTabs(panel);
            seUpdateSaveBtn();
            if (panel.isConnected) renderDivergenceBanner();
        };
        cancel.onclick = close;
        det.append(ok, cancel);
        wrap.append(det);
    };
    wrap.append(mkBtn());
    return wrap;
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
    // UP-30 (classic pill :276-332): exposed profiles read as API pills, an
    // engine-field one carrying the amber ⚠ warning instead of the green
    // plain-API — the server computes has_engine_fields on every row
    // (omlx/model_settings.py:1389), so no client diff is needed.
    const optsByName = new Map();
    const mkOpt = p => {
        const o = document.createElement('option');
        o.value = p.name;
        optsByName.set(p.name, o);
        return o;
    };
    sel.append(none, ...profs.map(mkOpt));
    function paintPicker() {
        // UP-30: re-label the classic pills from the store — ⚠ once the
        // runtime-divergence pass ran, API⚠ amber per has_engine_fields
        const div = new Set((MM_DATA.divergence || []).map(d => d.name));
        for (const p of profs) {
            const o = optsByName.get(p.name);
            if (!o) continue;
            o.textContent = profileOptionLabel(p, div.has(p.name))
                + (p.expose_as_model
                    ? (p.has_engine_fields ? ' (API\u26a0)' : ' (API)') : '');
            o.title = profileOptionTitle(p);
        }
        syncDriftDot();
    }
    // U4: no Apply button here — applying values lives in the 'apply from…'
    // dropdown (client-side, into the active tab). This row manages profiles.
    // UP-30: management = EDIT (classic pencil dialog :202-235) + two-step
    // delete (never window.confirm) + the classic drift dot for the profile
    // whose tab is open with unsaved changes.
    const editB = document.createElement('button');
    editB.className = 'se-btn'; editB.textContent = 'Edit';
    const delB = document.createElement('button'); delB.className = 'se-btn'; delB.textContent = 'Delete';
    const noB = document.createElement('button'); noB.className = 'se-btn';
    noB.textContent = C.tf('models.manager.delete_no', 'No'); noB.hidden = true;
    const driftDot = document.createElement('span');
    driftDot.className = 'se-drift-dot'; driftDot.hidden = true;
    driftDot.title = C.tf('modal.model_settings.profiles.drift_hint',
        'Form has unsaved changes vs. profile');
    let armed = null;                                   // classic profileDeleteConfirm
    function paintArm() {
        delB.textContent = armed
            ? C.tf('models.manager.delete_yes', 'Yes')
            : 'Delete';
        delB.classList.toggle('danger', !!armed);
        noB.hidden = !armed;
    }
    delB.onclick = async () => {
        if (!sel.value) return;
        const next = nextDeleteState(armed, sel.value, armed ? 'yes' : 'ask');
        if (next !== 'FIRE') { armed = next; paintArm(); return; }
        armed = null; paintArm();
        try {
            await D.deleteJson(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(sel.value)}`);
            MM_GLUE.toast(C.t('uplift.toast.deleted_profile', {name: sel.value}));
            seLoadProfiles(model, host);
        } catch (e) { MM_GLUE.toast(C.t('uplift.toast.delete_failed', {msg: D.errText(e)})); }
    };
    noB.onclick = () => { armed = null; paintArm(); };
    // classic drift dot: the SELECTED profile owns unsaved edits in its tab
    function syncDriftDot() {
        let drift = false;
        if (sel.value) {
            const t = seTabs.find(z => z.profileId === sel.value);
            drift = !!t && seTabChangeCount(t) > 0;
        }
        driftDot.hidden = !drift;
    }
    host._syncDrift = paintPicker;
    sel.onchange = syncDriftDot;
    paintPicker();
    const dlg = document.createElement('div');
    dlg.className = 'se-pedit'; dlg.hidden = true;
    editB.onclick = () => seProfileEditDialog(dlg, model, host, sel.value);
    const saveAs = document.createElement('input');
    saveAs.type = 'text'; saveAs.placeholder = 'save current as…'; saveAs.className = 'se-prof-name';
    const saveB = document.createElement('button'); saveB.className = 'se-btn'; saveB.textContent = 'Save';
    // FE-2: private `write` closure deleted — it was a fetchJson clone
    // with worse error messages (no url, no err.status). All five call
    // sites pass explicit method/headers/body opts straight to fetchJson.
    const write = D.fetchJson;
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
        } catch (e) { MM_GLUE.toast(C.t('uplift.toast.profile_error', {msg: D.errText(e)})); }
    };
    row.append(sel, driftDot, editB, delB, noB, saveAs, saveB);
    host.append(row, dlg);
    syncDriftDot();
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
                // UP-30: the two writes moved into seApplyTemplateUpsert so
                // the RESYNC verb shares this exact path.
                const tpl = tpls.find(t => t.name === tsel.value) || {};
                await seApplyTemplateUpsert(model, tpl);
                MM_GLUE.toast(C.t('uplift.toast.applied_template', {name: tpl.name}));
                openEditor(model);
            } catch (e) { MM_GLUE.toast(C.t('uplift.toast.template_apply_failed', {msg: D.errText(e)})); }
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
                const _tp = window.Uplift.mmTemplates;
                if (_tp && _tp.invalidate) _tp.invalidate();   // POLL-BATCH
                seLoadProfiles(model, host);
            } catch (e) { MM_GLUE.toast(C.t('uplift.toast.template_error', {msg: D.errText(e)})); }
        };
        const tt = document.createElement('div');
        tt.className = 'se-hint'; tt.textContent = 'Templates (global)';
        host.append(tt);
        trow.append(tsel, tApply, tSnap);
        host.append(trow);
    }
}

/* ---- UP-20 (1,2,3): snapshot actions + Load Generation Defaults --------
   Classic's three title-bar buttons (_modal_model_settings.html:24-30) and
   the Load Defaults header button (:429). The phase machine is extracted
   PURE (classic: dashboard.js:3416-3547 settingsApply + _modal_settings_
   apply.html), so tests/u20-snapshot-actions.test.cjs drives every phase
   over server-shaped fixtures without a DOM; the modal below is only its
   render shell. Verified classic routes (omlx/admin/routes.py):
     POST /admin/api/models/{id}/settings/reset     (:4122, no body)
     POST /admin/api/models/{id}/settings/recipe    (:4132, {recipe})
     GET  /admin/api/models/{id}/settings/optimal   (:4147, candidates)
     POST /admin/api/models/{id}/settings/optimal   (:4205, {benchmark_id})
     GET  /admin/api/models/{id}/generation_config  (:4337)                */
const SETTINGS_APPLY = {
    /* Pure machine — every method takes (and returns) the state object;
       the DOM shell and the tests drive the SAME transitions. */
    open(mode) {
        // classic openSettingsApply (dashboard.js:3416): recipe starts at
        // the paste box, reset at the confirmation, optimal fetches at once
        return { mode, phase: mode === 'recipe' ? 'input'
                       : (mode === 'reset' ? 'confirm' : 'loading'),
                 recipeText: '', result: null, candidates: null, error: '' };
    },
    canClose(st) { return st.phase !== 'loading'; },
    beginLoading(st) { st.phase = 'loading'; st.error = ''; return st; },
    recipeBody(st) { return { recipe: (st.recipeText || '').trim() }; },
    onCandidates(st, data) {
        st.result = data;
        if (!data || !data.found) { st.phase = 'none'; return st; }
        st.candidates = data;
        st.phase = 'choose';
        return st;
    },
    onApplied(st, data) { st.result = data; st.phase = 'done'; return st; },
    onError(st, msg) { st.error = msg || C.tf('js.error.settings_apply_failed',
        'Failed to apply settings'); st.phase = 'error'; return st; },
    canBack(st) {
        // classic error phase: BACK only when there is somewhere to go
        return st.mode === 'recipe' || (st.mode === 'optimal' && !!st.candidates);
    },
    back(st) { st.phase = st.mode === 'recipe' ? 'input' : 'choose'; return st; },
    title(st) {
        return st.mode === 'reset'
            ? C.tf('modal.model_settings.actions.reset', 'Reset defaults')
            : st.mode === 'recipe'
                ? C.tf('modal.model_settings.actions.apply_title_recipe',
                       'Apply custom recipe')
                : C.tf('modal.model_settings.actions.apply_title_optimal',
                       'Optimal settings from omlx.ai');
    },
    loadingText(st) {
        if (st.mode === 'reset')
            return C.tf('modal.model_settings.actions.loading_reset',
                        'Resetting settings...');
        if (st.mode === 'recipe')
            return C.tf('modal.model_settings.actions.loading_recipe',
                        'Applying the recipe...');
        return st.candidates
            ? C.tf('modal.model_settings.actions.loading_apply',
                   'Applying the benchmark settings...')
            : C.tf('modal.model_settings.actions.loading_optimal',
                   'Fetching the best benchmark results from omlx.ai...');
    },
    doneText(st) {
        if (st.mode === 'reset')
            return C.tf('modal.model_settings.actions.done_reset',
                'All settings were reset to their defaults.');
        if (st.result && st.result.changed === false)
            return C.tf('modal.model_settings.actions.no_change',
                'Settings already matched; nothing changed.');
        return st.mode === 'recipe'
            ? C.tf('modal.model_settings.actions.done_recipe',
                   'The settings below were applied from the recipe!')
            : C.tf('modal.model_settings.actions.done_optimal',
                   'The settings below were applied from the selected benchmark!');
    },
    groups(st) {
        const c = st.candidates;
        if (!c) return [];
        return [
            { key: 'pp', label: C.tf('modal.model_settings.actions.group_pp',
                                      'Best prompt processing (PP)'),
              items: c.by_pp || [] },
            { key: 'tg', label: C.tf('modal.model_settings.actions.group_tg',
                                      'Best token generation (TG)'),
              items: c.by_tg || [] },
        ].filter(g => g.items.length);
    },
    appliedJson(st) {
        const r = st.result;
        return r && r.applied ? JSON.stringify(r.applied, null, 2) : '';
    },
    stats(item) {
        // classic settingsApplyStats (dashboard.js:3536): PP/TG tok/s,
        // memory GB, quantization, oMLX version, date
        if (!item || item.pp_tps == null) return '';
        const parts = ['PP ' + Number(item.pp_tps).toFixed(1) + ' tok/s'];
        if (item.tg_tps != null) parts.push('TG ' + Number(item.tg_tps).toFixed(1) + ' tok/s');
        if (item.memory_gb != null) parts.push(item.memory_gb + ' GB');
        if (item.quantization) parts.push(item.quantization);
        if (item.omlx_version) parts.push('oMLX ' + item.omlx_version);
        if (item.created_at) parts.push(String(item.created_at).slice(0, 10));
        return parts.join(' \u00b7 ');
    },
};

/* classic loadGenerationDefaults (dashboard.js:3571-3646): five keys are
   SET from the model's own /generation_config answer (a missing one falls
   back to null), every other key in the list below is HARD-CLEARED to the
   literal classic default. The list is copied key-for-key and order-for-
   order; completeness is pinned against this classic fixture by
   tests/u20-snapshot-actions.test.cjs. */
const SE_GEN_SET_KEYS = ['max_context_window', 'temperature', 'top_p',
    'top_k', 'repetition_penalty'];
const SE_GEN_CLEAR = [
    ['max_tokens', null], ['min_p', null], ['presence_penalty', null],
    ['force_sampling', false], ['reasoning_parser', null],
    ['guided_grammar_enabled', false], ['guided_grammar', ''],
    ['ttl_seconds', null], ['enableIndexCache', false], ['index_cache_freq', 0],
    ['enable_thinking', false], ['enableThinkingBudget', false],
    ['thinking_budget_tokens', 0],
    // SYNC-1 (upstream d59d797): classic's clear-generation also drops the
    // power cap (dashboard.js:3674-3675), between the thinking pair and the
    // tool-result pair; the fp16 recast is NOT in that list — classic leaves
    // it alone.
    ['enableGpuPowerLimit', false], ['gpu_power_limit_w', null],
    ['enableToolResultLimit', false],
    ['max_tool_result_tokens', 0], ['ctKwargEntries', []],
    ['turboquant_kv_enabled', false], ['turboquant_kv_scheme', 'turboquant'],
    ['turboquant_kv_bits', 4],
    ['qwen35_ane_prefill_enabled', false],
    ['qwen35_ane_prefill_sequence_length', 2048],
    ['qwen35_ane_prefill_tail_padding_min_tokens', 0],
    ['qwen35_ane_prefill_fraction', 0.53],      // model row may override
    ['qwen35_ane_prefill_max_layers', 64],
    ['qwen35_ane_prefill_dual_ane', true],
    ['qwen35_ane_prefill_gdn', true],
    ['qwen35_ane_prefill_gdn_fraction', 0.5],
    ['qwen35_ane_prefill_gdn_max_layers', 48],
    ['qwen35_ane_prefill_cpu_enabled', false],
    ['qwen35_ane_prefill_cpu_fraction', 0.135],
    ['qwen35_ane_prefill_cpu_down_fraction', 0],
    ['qwen35_ane_prefill_cpu_gdn_fraction', 0],
    ['qwen35_ane_prefill_cpu_threads', 8],
    ['qwen35_ane_prefill_cpu_shared_resource', true],
    ['specprefill_enabled', false], ['specprefill_draft_model', null],
    ['specprefill_keep_pct', 0.2], ['specprefill_threshold', null],
    // SPEC-1: classic's clear-on-master-off resets the activation flag to
    // its form default (active) — state shape.
    ['specprefill_auto_enabled', true],
    ['dflash_enabled', false], ['dflash_draft_model', null],
    ['dflash_draft_quant_enabled', false],
    ['dflash_draft_quant_weight_bits', null],
    ['dflash_draft_quant_group_size', null],
    ['dflash_draft_window_size', null], ['dflash_block_size', null],
    ['dflash_verify_mode', 'adaptive'],
    ['mtp_enabled', false], ['mtp_adaptive_max_depth', '3'],
    ['trust_remote_code', false],
];
function genDefaultsPatch(data, modelRow, state) {
    /* Pure core. `state` (the live seValues) filters the write: a key the
       uplift modelspec does not carry is skipped, so clearing can never
       inject foreign keys into the save payload. */
    const out = {};
    const has = k => !state || Object.prototype.hasOwnProperty.call(state, k);
    for (const k of SE_GEN_SET_KEYS)
        if (has(k)) out[k] = (data && data[k] != null) ? data[k] : null;
    for (const [k, v] of SE_GEN_CLEAR) {
        if (!has(k)) continue;
        if (k === 'qwen35_ane_prefill_fraction')
            out[k] = (modelRow && modelRow.ane_prefill_default_fraction != null)
                ? modelRow.ane_prefill_default_fraction : v;
        else out[k] = Array.isArray(v) ? v.slice() : v;
    }
    return out;
}

function seGenDefaultsBtn(sect) {
    // classic header row: the button sits at the section-header right edge
    if (!sect || !sect.__head) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'se-btn se-gen-load';
    b.textContent = C.tf('modal.model_settings.load_defaults', 'Load Defaults');
    b.onclick = () => seGenDefaultsLoad(b);
    sect.__head.append(b);
}
function seGenDefaultsLoad(b) {
    if (!seModel) return;
    b.disabled = true;
    b.textContent = C.tf('modal.model_settings.loading_defaults', 'Loading...');
    MM_GLUE.fetchJson(
        `${API}/admin/api/models/${encodeURIComponent(seModel)}/generation_config`)
        .then(data => { seApplyGenDefaults(data || {}); })
        .catch(e => {
            // classic: 404 -> no_config_defaults, anything else -> the
            // generic load_generation_config_failed (dashboard.js:3632-3644)
            MM_GLUE.toast(e && e.status === 404
                ? C.tf('js.error.no_config_defaults',
                       'No config defaults found for this model')
                : D.errText(e)
                          || C.tf('js.error.load_generation_config_failed',
                                  'Failed to load generation config'), 'error');
            b.disabled = false;
            b.textContent = C.tf('modal.model_settings.load_defaults', 'Load Defaults');
        });
}
function seApplyGenDefaults(data) {
    /* Form-side only, classic parity: the patch lands on the base model's
       form as queued edits — classic drops its profile link (activeProfile-
       Name=null, dashboard.js:3646), so the edit always targets the base
       tab; nothing is written to the server until SAVE. */
    seCaptureTab();
    const t0 = seTabs.find(z => z.id === 'base');
    if (!t0) return;
    if (seActiveTab !== 'base') {
        seActiveTab = 'base';
        seValues = Object.assign({}, t0.workVals || seBaseVals);
        seOrig = t0.origVals || seOrig;
    }
    const patch = genDefaultsPatch(data, seFormModel || {}, seValues);
    for (const [k, v] of Object.entries(patch)) {
        seValues[k] = v;
        const orig = (t0.origVals || seOrig)[k];
        if (JSON.stringify(orig) === JSON.stringify(v)) t0.dirty.delete(k);
        else t0.dirty.add(k);
    }
    t0.workVals = Object.assign({}, seValues);
    const root = document.getElementById('se-fields');
    if (root) renderEditorFields(root);
    const panel = document.querySelector('.modal.editor');
    if (panel) seRenderTabs(panel);
    seUpdateSaveBtn();
}

function seSnapshotActions() {
    const wrap = document.createElement('span');
    wrap.className = 'se-snap-actions';
    seApplyBusy = [];                     // a reopened editor owns fresh refs
    for (const [mode, key, en] of [
        ['reset', 'modal.model_settings.actions.reset', 'Reset defaults'],
        ['optimal', 'modal.model_settings.actions.optimal', 'Apply optimal settings'],
        ['recipe', 'modal.model_settings.actions.recipe', 'Apply custom recipe'],
    ]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'se-btn sa-head-btn';
        b.textContent = C.tf(key, en);
        b.onclick = () => openSettingsApply(mode);
        seApplyBusy.push(b);
        wrap.append(b);
    }
    return wrap;
}
function _saMk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}
function openSettingsApply(mode) {
    if (!seModel || seApplyOverlay) return;
    const model = seModel;      // the editor reloads behind us; stay bound
    const st = SETTINGS_APPLY.open(mode);
    const overlay = _saMk('div', 'modal-overlay sa-overlay');
    overlay.style.zIndex = '80';            // above the editor modal (70), below a grammar pop (90)
    const box = _saMk('div', 'modal nasa sa-box');
    const head = _saMk('h3', 'sa-head');
    const titleSp = _saMk('span', 'sa-title', SETTINGS_APPLY.title(st));
    const closeB = _saMk('button', 'icon-btn sa-x', '\u00d7');
    closeB.type = 'button';
    closeB.onclick = () => closeSettingsApply();
    head.append(titleSp, closeB);
    const body = _saMk('div', 'sa-body');
    box.append(head, body);
    overlay.append(box);
    document.body.append(overlay);
    seApplyOverlay = { overlay, titleSp, closeB, body, st, model };
    overlay.__upliftModalClose = () => closeSettingsApply();
    overlay.onclick = (e) => { if (e.target === overlay) closeSettingsApply(); };
    renderSettingsApply();
    if (mode === 'optimal') loadOptimalCandidates();
}
function closeSettingsApply() {
    const A = seApplyOverlay;
    if (!A || !SETTINGS_APPLY.canClose(A.st)) return;   // classic: no close mid-flight
    seApplyOverlay = null;
    A.overlay.remove();
}
function _saUrl(path) {
    const model = (seApplyOverlay && seApplyOverlay.model) || seModel;
    return `${API}/admin/api/models/${encodeURIComponent(model)}/settings/${path}`;
}
function renderSettingsApply() {
    const A = seApplyOverlay; if (!A) return;
    const st = A.st;
    A.titleSp.textContent = SETTINGS_APPLY.title(st);
    A.closeB.disabled = st.phase === 'loading';
    for (const b of seApplyBusy) b.disabled = st.phase === 'loading';
    const b = A.body;
    b.textContent = '';    // container-clear only; every string enters via textContent
    const actRow = () => { const r = _saMk('div', 'sa-actions'); b.append(r); return r; };
    const btn = (cls, key, en, fn) => {
        const n = _saMk('button', cls, C.tf(key, en));
        n.type = 'button'; n.onclick = fn; return n;
    };
    if (st.phase === 'confirm') {
        // classic reset-confirm copy verbatim (_modal_settings_apply.html)
        b.append(_saMk('p', 'sa-msg', C.tf('modal.model_settings.actions.reset_confirm',
            'Reset every setting of this model? Sampling, acceleration, pinned/default flags, aliases and the display name all return to their defaults.')));
        actRow().append(
            btn('se-btn', 'models.manager.delete_no', 'No', () => closeSettingsApply()),
            btn('se-btn danger sa-yes', 'models.manager.delete_yes', 'Yes', () => runSettingsApply()));
    } else if (st.phase === 'input') {
        b.append(_saMk('p', 'sa-msg', C.tf('modal.model_settings.actions.recipe_hint',
            'Paste a recipe copied from the Recipe row of a benchmark detail page on omlx.ai.')));
        const link = _saMk('a', 'sa-link', C.tf('modal.model_settings.actions.none_link',
            'Open community benchmarks'));
        link.href = 'https://omlx.ai/benchmarks/performance';
        link.target = '_blank'; link.rel = 'noopener';
        b.append(link);
        const ta = _saMk('textarea', 'sa-recipe');
        ta.rows = 5; ta.spellcheck = false;
        ta.placeholder = C.tf('modal.model_settings.actions.recipe_placeholder', 'omlx-recipe:1:...');
        ta.value = st.recipeText || '';
        b.append(ta);
        const row = actRow();
        const ap = btn('se-btn sa-apply', 'modal.model_settings.actions.apply', 'Apply', () => runSettingsApply());
        ta.oninput = () => { st.recipeText = ta.value; ap.disabled = !ta.value.trim(); };
        ap.disabled = !String(st.recipeText || '').trim();
        row.append(
            btn('se-btn', 'modal.model_settings.cancel', 'Cancel', () => closeSettingsApply()),
            ap);
    } else if (st.phase === 'loading') {
        b.append(_saMk('p', 'sa-msg sa-loading', '\u27f3 ' + SETTINGS_APPLY.loadingText(st)));
    } else if (st.phase === 'choose') {
        b.append(_saMk('p', 'sa-msg', C.tf('modal.model_settings.actions.choose_hint',
            'Pick a benchmark result to apply its settings. Rows are the best matches for this chip and model with the same or less memory, at a 4k prompt.')));
        for (const g of SETTINGS_APPLY.groups(st)) {
            b.append(_saMk('div', 'sa-group-label', g.label));
            for (const item of g.items) {
                const cand = _saMk('div', 'sa-cand');
                const info = _saMk('div', 'sa-cand-info');
                const a = _saMk('a', 'sa-link sa-cand-url', item.benchmark_url || item.benchmark_id);
                if (item.benchmark_url) { a.href = item.benchmark_url; a.target = '_blank'; a.rel = 'noopener'; }
                info.append(a, _saMk('div', 'sa-cand-stats', SETTINGS_APPLY.stats(item)));
                cand.append(info, btn('se-btn sa-apply', 'modal.model_settings.actions.apply',
                    'Apply', () => applyOptimalCandidate(item.benchmark_id)));
                b.append(cand);
            }
        }
        actRow().append(btn('se-btn', 'modal.model_settings.actions.close', 'Close',
            () => closeSettingsApply()));
    } else if (st.phase === 'done') {
        b.append(_saMk('p', 'sa-msg sa-done', SETTINGS_APPLY.doneText(st)));
        if (st.result && st.result.benchmark_url) {
            const p = _saMk('p', 'sa-cand-done');
            const a = _saMk('a', 'sa-link', st.result.benchmark_url);
            a.href = st.result.benchmark_url; a.target = '_blank'; a.rel = 'noopener';
            p.append(a, _saMk('div', 'sa-cand-stats', SETTINGS_APPLY.stats(st.result)));
            b.append(p);
        }
        const skipped = (st.result && st.result.skipped) || [];
        if (skipped.length) {
            // classic amber box: features this install cannot run, dropped
            const box2 = _saMk('div', 'sa-skipped');
            box2.append(_saMk('div', 'sa-skipped-title',
                C.tf('modal.model_settings.actions.skipped_title', 'Skipped on this machine')));
            const ul = _saMk('ul', 'sa-skipped-list');
            for (const s of skipped) ul.append(_saMk('li', null, s.feature + ': ' + s.reason));
            box2.append(ul);
            b.append(box2);
        }
        if (st.mode !== 'reset') {
            // readonly applied-JSON preview (classic skips it for reset —
            // there is nothing interesting to show for 'back to defaults')
            b.append(_saMk('label', 'sa-applied-label',
                C.tf('modal.model_settings.actions.applied_settings', 'Applied settings')));
            const ta = _saMk('textarea', 'sa-applied');
            ta.readOnly = true; ta.rows = 10; ta.spellcheck = false;
            ta.value = SETTINGS_APPLY.appliedJson(st);
            b.append(ta);
        }
        actRow().append(btn('se-btn', 'modal.model_settings.actions.close', 'Close',
            () => closeSettingsApply()));
    } else if (st.phase === 'none') {
        b.append(_saMk('p', 'sa-msg', C.tf('modal.model_settings.actions.none_title',
            'No benchmark result matches this device and model.')));
        b.append(_saMk('p', 'sa-sub', C.tf('modal.model_settings.actions.none_body',
            'Find a similar model on the community benchmarks and apply its recipe with Apply custom recipe.')));
        const link = _saMk('a', 'sa-link', C.tf('modal.model_settings.actions.none_link',
            'Open community benchmarks'));
        link.href = (st.result && st.result.search_url)
            || 'https://omlx.ai/benchmarks/performance';
        link.target = '_blank'; link.rel = 'noopener';
        b.append(link);
        actRow().append(btn('se-btn', 'modal.model_settings.actions.close', 'Close',
            () => closeSettingsApply()));
    } else if (st.phase === 'error') {
        b.append(_saMk('p', 'sa-msg', C.tf('modal.model_settings.actions.error_title',
            'Could not apply settings')));
        b.append(_saMk('p', 'sa-error', st.error));
        const row = actRow();
        if (SETTINGS_APPLY.canBack(st))
            row.append(btn('se-btn', 'modal.model_settings.actions.back', 'Back',
                () => { SETTINGS_APPLY.back(st); renderSettingsApply(); }));
        row.append(btn('se-btn', 'modal.model_settings.actions.close', 'Close',
            () => closeSettingsApply()));
    }
}
async function loadOptimalCandidates() {
    const A = seApplyOverlay; if (!A) return;
    try {
        const data = await MM_GLUE.fetchJson(_saUrl('optimal'));
        if (seApplyOverlay !== A) return;                 // closed mid-flight
        SETTINGS_APPLY.onCandidates(A.st, data);
    } catch (e) {
        if (seApplyOverlay !== A) return;
        SETTINGS_APPLY.onError(A.st, D.errText(e));
    }
    if (seApplyOverlay === A) renderSettingsApply();
}
async function applyOptimalCandidate(benchmarkId) {
    const A = seApplyOverlay; if (!A) return;
    SETTINGS_APPLY.beginLoading(A.st); renderSettingsApply();
    try {
        const data = await MM_GLUE.postJson(_saUrl('optimal'), { benchmark_id: benchmarkId });
        SETTINGS_APPLY.onApplied(A.st, data);
        renderSettingsApply();
        await seOnSettingsApplied(data);
    } catch (e) {
        SETTINGS_APPLY.onError(A.st, D.errText(e));
        renderSettingsApply();
    }
}
async function runSettingsApply() {
    const A = seApplyOverlay; if (!A) return;
    SETTINGS_APPLY.beginLoading(A.st); renderSettingsApply();
    try {
        const data = A.st.mode === 'recipe'
            ? await MM_GLUE.postJson(_saUrl('recipe'), SETTINGS_APPLY.recipeBody(A.st))
            : await MM_GLUE.postJson(_saUrl('reset'), null);   // classic sends a bodyless POST
        SETTINGS_APPLY.onApplied(A.st, data);
        renderSettingsApply();
        await seOnSettingsApplied(data);
    } catch (e) {
        SETTINGS_APPLY.onError(A.st, D.errText(e));
        renderSettingsApply();
    }
}
async function seOnSettingsApplied(data) {
    /* classic _applySettingsResponse (dashboard.js:3548): rebuild the form
       from the server answer, refresh the model rows, then name the reload
       consequence. Uplift rebuild = a full openEditor (settings + deferred
       + profiles + divergence all moved server-side); alerts become toasts. */
    const A = seApplyOverlay;
    const model = (A && A.model) || seModel;
    try {
        if (seReloadAfterApply) await seReloadAfterApply(model);
        else if (model) await openEditor(model, seWantProfile);
    } catch (_) { /* the toast below still tells the truth about the write */ }
    if (data && data.requires_reload) {
        if (data.auto_reloaded)
            MM_GLUE.toast(C.tf('js.info.model_settings_auto_reloaded',
                'Settings saved. The pinned model was reloaded with the new settings.'));
        else if (data.auto_unloaded)
            MM_GLUE.toast(C.tf('js.info.model_settings_auto_unloaded',
                'Settings saved. The model was unloaded and will reload with the new settings on next use.'));
        else if (data.reload_deferred)
            MM_GLUE.toast(C.tf('js.info.model_settings_reload_deferred',
                'Settings saved. The model is busy, so it will unload after its current work finishes and reload with the new settings on next use.'));
        else
            MM_GLUE.toast(C.tf('js.info.model_type_reload_required',
                'Model type changed. Unload and reload the model for the change to take effect.'));
    }
}

/* ---- UP-30: profile-management depth (classic modal :202-235, :276-332) --
   Pure helpers first (tests/u30-profile-management.test.cjs drives them over
   classic-shaped rows), then the picker-row wiring that replaces the old
   unconfirmed one-click delete.                                            ---- */
const SE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;  // classic isValidProfileName (dashboard.js:2338)
function isValidProfileName(name) {
    return SE_PROFILE_NAME_RE.test((name || '').trim());
}
function profileFieldsPatch(f) {
    /* classic updateProfileFromEdit (dashboard.js:2472): the internal name
       stays stable, the PUT carries exactly these four fields (a server PUT
       keeps None-valued siblings, so '' for description really clears it). */
    const displayName = String(f.display_name == null ? '' : f.display_name).trim();
    const apiName = String((f.api_name == null || f.api_name === '')
        ? (f.name || '') : f.api_name).trim();
    const description = String(f.description == null ? '' : f.description).trim();
    const exposeAsModel = !!f.expose_as_model;
    if (!displayName)
        return { error: C.tf('js.error.name_required', 'Name required') };
    if (!isValidProfileName(apiName))
        return { error: C.tf('modal.model_settings.profiles.invalid_name',
            'API name must be lowercase letters, digits, underscore, or dash (1-32 chars)') };
    return { patch: { display_name: displayName, api_name: apiName,
                      description: description, expose_as_model: exposeAsModel } };
}
function nextDeleteState(cur, name, ev) {
    /* Two-step inline delete (classic profileDeleteConfirm + delete_yes/
       delete_no buttons, never window.confirm): 'ask' arms one row, 'no'
       disarms, 'yes' fires ONLY while that same row is armed. */
    if (ev === 'ask') return name;
    if (ev === 'no') return null;
    if (ev === 'yes') return cur === name ? 'FIRE' : null;
    return cur;
}
function resyncTargetTemplate(p, templates) {
    /* classic RESYNC button (:276-332) renders only for a profile that
       names a source_template; a template the store lost is a no-op. */
    if (!p || !p.source_template) return null;
    return (templates || []).find(t => t.name === p.source_template) || null;
}
function profileOptionLabel(p, diverging) {
    return (p.display_name || p.name) + (diverging ? ' \u26a0' : '');
}
function profileOptionTitle(p) {
    /* classic pill tooltip (profileTooltip dashboard.js:1822) + the amber
       engine-field warning (:276-332 API badge: has_engine_fields reads as
       a warning, plain expose reads green). */
    const lines = [];
    if (p.expose_as_model && p.model_id) lines.push(p.model_id);
    const d = (p.description || '').trim();
    if (d) lines.push(d);
    if (p.expose_as_model)
        lines.push(C.tf('modal.model_settings.profiles.'
            + (p.has_engine_fields ? 'expose_engine_fields_hint' : 'expose_as_model'),
            p.has_engine_fields
                ? "Engine-level settings in this profile only take effect when it is applied to the base model \u2014 they don't change the exposed model."
                : 'Use as API model'));
    return lines.join('\n');
}
async function seApplyTemplateUpsert(model, tpl) {
    // Classic applyTemplateToForm: template is source of truth — upsert the
    // model profile from it, then apply the profile. Shared by the
    // templates row and the UP-30 RESYNC FROM TEMPLATE verb.
    const prof = `${API}/admin/api/models/${encodeURIComponent(model)}/profiles`;
    await MM_GLUE.postJson(prof,
        { name: tpl.name, display_name: tpl.display_name || tpl.name,
          description: tpl.description || null,
          settings: tpl.settings || {}, source_template: tpl.name });
    await MM_GLUE.postJson(`${prof}/${encodeURIComponent(tpl.name)}/apply`, null);
}
function seProfileEditDialog(dlg, model, host, name) {
    /* classic 'Edit profile inline dialog' (_modal_model_settings.html:202-235):
       display_name / api_name + expose / description, and the three verbs —
       SAVE fields (updateProfileFromEdit), UPDATE SETTINGS FROM FORM
       (updateProfileSettingsFromForm, dashboard.js:2496), RESYNC FROM
       TEMPLATE (only while p.source_template names a live template).
       The internal profile name stays stable — api_name is the exposed
       suffix, classic comment dashboard.js:2473. */
    const p = (MM_DATA.profiles || []).find(x => x.name === name);
    if (!p) { MM_GLUE.toast(C.tf('uplift.mm.profile_missing', 'profile not found: ') + name); return; }
    dlg.hidden = false;
    dlg.textContent = '';   // container-clear only; every string enters via textContent
    const cap = document.createElement('div');
    cap.className = 'se-pedit-cap dim';
    cap.textContent = p.name;                 // the stable internal id
    dlg.append(cap);
    const mkRow = (key, en, val) => {
        const lab = document.createElement('label'); lab.className = 'se-row pedit-row';
        const cp = document.createElement('span'); cp.textContent = C.tf(key, en);
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = val == null ? '' : val;
        lab.append(cp, inp); dlg.append(lab);
        return inp;
    };
    const dIn = mkRow('modal.model_settings.profiles.display_name_label',
        'Display name', p.display_name || p.name);
    const aIn = mkRow('modal.model_settings.profiles.name_placeholder',
        'API name e.g. coding-v1', p.api_name || p.name);
    const expLab = document.createElement('label'); expLab.className = 'se-row pedit-row';
    const expBox = document.createElement('input');
    expBox.type = 'checkbox'; expBox.checked = !!p.expose_as_model;
    const expTxt = document.createElement('span');
    expTxt.textContent = ' ' + C.tf('modal.model_settings.profiles.expose_as_model',
        'Use as API model');
    expLab.append(expBox, expTxt); dlg.append(expLab);
    const descIn = mkRow('modal.model_settings.profiles.description_label',
        'Description (optional)', p.description || '');
    const err = document.createElement('div');
    err.className = 'se-pedit-err'; err.hidden = true;
    dlg.append(err);
    const showErr = msg => { err.textContent = msg || ''; err.hidden = !msg; };
    const row = document.createElement('div'); row.className = 'se-pedit-actions';
    const btn = (key, en, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'se-btn'; b.textContent = C.tf(key, en);
        b.onclick = fn; row.append(b); return b;
    };
    btn('modal.model_settings.profiles.save', 'Save', saveFields);
    btn('modal.model_settings.profiles.update_from_form',
        'Update to current form values', saveSettingsFromForm);
    if (resyncTargetTemplate(p, MM_DATA.templates))
        btn('modal.model_settings.profiles.resync_template',
            'Re-sync from template', resync);
    btn('modal.model_settings.profiles.cancel', 'Cancel',
        () => { dlg.hidden = true; dlg.textContent = ''; });
    dlg.append(row);
    async function saveFields() {
        const res = profileFieldsPatch({ display_name: dIn.value,
            api_name: aIn.value, description: descIn.value,
            expose_as_model: expBox.checked, name: p.name });
        if (res.error) { showErr(res.error); return; }
        showErr('');
        try {
            await MM_GLUE.putJson(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(p.name)}`, res.patch);
            MM_GLUE.toast(C.t('uplift.toast.saved_profile',
                { name: res.patch.display_name }));
            // the tab owning this profile mirrors the stored truth (its
            // label/badges repaint from the store on the reload below)
            const t = seTabs.find(z => z.profileId === p.name);
            if (t) {
                t.display_name = res.patch.display_name;
                t.api_name = res.patch.api_name;
                t.expose_as_model = res.patch.expose_as_model;
            }
            dlg.hidden = true;
            seLoadProfiles(model, host);
        } catch (e) { showErr(D.errText(e)); }
    }
    async function saveSettingsFromForm() {
        showErr('');
        try {
            seCaptureTab();
            const t = seTab();
            let vals = (t && (t.workVals || seValues)) || seValues;
            if (vals.ctKwargEntries) {   // kwargs ride the payload shape (same rule as saveProfileCommit)
                const kw = window.UpliftModelSpec.buildPayload(vals, seFormModel);
                vals = Object.assign({}, vals, { chat_template_kwargs: kw.chat_template_kwargs,
                                                 forced_ct_kwargs: kw.forced_ct_kwargs });
            }
            let ov = seProfileSettingsFrom(vals);
            ov = window.UpliftModelSpec.adaptToServerSettings(
                ov, await MM_GLUE.modelSettingsFields());
            await MM_GLUE.putJson(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(p.name)}`,
                { settings: ov });
            MM_GLUE.toast(C.t('uplift.toast.saved_profile',
                { name: p.display_name || p.name }));
            dlg.hidden = true;
            seLoadProfiles(model, host);
        } catch (e) { showErr(D.errText(e)); }
    }
    async function resync() {
        const tpl = resyncTargetTemplate(p, MM_DATA.templates);
        if (!tpl) return;
        showErr('');
        try {
            await seApplyTemplateUpsert(model, tpl);
            MM_GLUE.toast(C.t('uplift.toast.applied_template',
                { name: tpl.display_name || tpl.name }));
            dlg.hidden = true;
            // the server moved active_profile_name — full refresh (the same
            // injectable reload seam the snapshot-apply flow uses)
            if (seReloadAfterApply) await seReloadAfterApply(model);
            else openEditor(model);
        } catch (e) { showErr(D.errText(e)); }
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

/* U84 (user 2026-10-12): one SAVE commits EVERY dirty tab — base and the
   profiles edited in the same session. Tab change accounting: the dirty
   set (widgets) plus the chat-template kwargs list (bypasses the dirty set
   everywhere — R10-6 design) plus the expose/api_name flips on profiles
   (the CHANGES box already counts them; the button used to ignore them, a
   dead end). Order is load-bearing: the base goes FIRST — profile
   overrides are a sparse diff against seBaseVals, and seCommitSaved
   advances those; committing profiles later makes values that just became
   equal to the base drop out as pure inheritance. Partial failure stays
   honest: tabs commit independently, a failed tab keeps its dirty state
   and its reason in the summary (no blanket success). */
function seTabChangeCount(t) {
    let n = t.dirty.size;
    // live kwargs: for the ACTIVE base tab seValues is the live state (its
    // workVals copy only refreshes on capture); every other tab owns a live
    // workVals reference (seSyncKwEntries + in-place entry mutation share it)
    const cur = (seTab() === t && t.id === 'base') ? seValues : (t.workVals || {});
    if (JSON.stringify(cur.ctKwargEntries || []) !==
        JSON.stringify((t.origVals || {}).ctKwargEntries || [])) n++;
    if (t.id !== 'base') {
        if ((t._origExpose || false) !== !!t.expose_as_model) n++;
        if ((t._origApi || '') !== (t.api_name || '')) n++;
    }
    return n;
}
function seTabHasChanges(t) { return seTabChangeCount(t) > 0; }
function seTabLabel(t) { return t.id === 'base' ? 'BASE' : (t.display_name || t.name || t.id); }
function seActivateTab(panel, t) {
    // the tab-click activation, shared with the U84 save loop so a
    // not-currently-shown tab can be committed through the very same
    // globals the single-tab flows expect
    seCaptureTab();
    seActiveTab = t.id;
    if (t.id !== 'base') seRestoreTab(t);
    else { seValues = Object.assign({}, t.workVals || seBaseVals);
           seOrig = t.origVals || seOrig; }
    renderEditorFields(document.getElementById('se-fields'));
    // TTS-1: voice defaults are model-wide (base scope) — the block rides
    // the base tab only; its dirty state still commits from any tab
    if (seTts && seTts.host) seTts.host.hidden = t.id !== 'base';
    // TTS-2: same base-only rule for the custom-voices block
    if (seVoicesBox) seVoicesBox.hidden = t.id !== 'base';
    seRenderTabs(panel); seUpdateSaveBtn();
}
async function commitBaseTab(panel, msg) {
    // the ACTIVE tab must be the base (seActivateTab) — this is the old
    // saveEditor body, minus the close decision (the orchestrator owns it)
    const errors = window.UpliftModelSpec.validate(seValues, seModelEntry());
    if (errors.length) {
        msg.textContent = errors[0];
        MM_GLUE.toast(errors[0]);
        return { ok: false, validation: true, error: errors[0] };
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
    const t0 = seTabs.find(z => z.id === 'base');
    const achvOld = t0 && t0.origVals ? Object.assign({}, t0.origVals) : null;
    const announce = () => {
        try {
            const AC = window.Uplift && window.Uplift.achv;
            if (AC && achvOld) AC.announce(AC.modelSavedReaction(achvOld, seValues));
        } catch (_) { /* a verdict must never break the save */ }
    };
    // UP-18 (10): classic reads the PUT verdict (dashboard.js:3388-3398) —
    // the server knows whether the engine auto-reloaded, unloaded, deferred,
    // or still needs a manual restart. Uplift's own reload guess stays for
    // the deferred-store flow; this surfaces the SERVER truth when it answers.
    const seReloadVerdict = (data) => {
        if (!data || !data.requires_reload) return;
        MM_GLUE.toast(data.auto_reloaded
            ? C.tf('js.info.model_settings_auto_reloaded',
                   'Model reloaded automatically to apply the new settings.')
            : data.auto_unloaded
            ? C.tf('js.info.model_settings_auto_unloaded',
                   'Model was unloaded to apply the new settings; it loads with them next time.')
            : data.reload_deferred
            ? C.tf('js.info.model_settings_reload_deferred',
                   'Reload deferred — the new settings apply when the model restarts.')
            : C.tf('js.info.model_type_reload_required',
                   'Restart the model to apply the new settings.'), 'info');
    };
    let payload = full, reloadStep = false;
    if (loaded) {
        const plain = sePlainDirtyKeys();
        const runtime = seRuntimeDirtyKeys();
        // dirty state keys -> the payload keys they own (some are derived)
        const KEY_MAP = SE_KEY_MAP;
        payload = {};
        for (const k of plain) {
            for (const pk of (KEY_MAP[k] || [k])) if (pk in full) payload[pk] = full[pk];
        }
        // chat-template kwargs bypass the dirty set (entries list) — include
        // them whenever they differ from the tab's saved baseline
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
        // live keys ride the sparse classic PUT (empty payload = nothing
        // live changed; skip it so we never touch the engine path)
        if (Object.keys(payload).length)
            seReloadVerdict(await MM_GLUE.putModelSettings(seModel, payload));
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
        announce();
        // restart still pending: editor stays open, RESTART MODEL visible
        return { ok: true, reloadStep };
    }
    // no engine running: the full PUT stores everything classic-side —
    // a leftover deferred record is redundant, drop it
    seReloadVerdict(await MM_GLUE.putModelSettings(seModel, payload));
    await seClearDeferred(seModel);
    seCommitSaved(t0, []);
    msg.textContent = 'saved ✓';
    MM_GLUE.toast(C.t('uplift.toast.settings_saved_model', {model: seModel}));
    seUpdateSaveBtn();
    refreshDivergence();
    announce();
    return { ok: true, reloadStep: false };
}
async function saveEditor() {
    if (!seModel) return;
    const panel = document.querySelector('.modal.editor');
    if (!panel) return;
    seCaptureTab();
    const msg = panel.querySelector('#se-msg');
    const baseTab = seTabs.find(z => z.id === 'base');
    const changed = seTabs.filter(seTabHasChanges);
    // single dirty profile tab, base untouched: the BUG-6-pinned wrapper
    // carries the busy state + rejection handling — behavior unchanged
    const ttsDirty = seTtsIsDirty();   // TTS-1: independent store, one SAVE
    if (changed.length === 1 && changed[0].id !== 'base' && !seIsBaseTab()
        && !ttsDirty)
        return saveProfileTab(panel);
    if (!changed.length && !ttsDirty) return;
    // base FIRST when it carries changes (sparse-diff ordering, see header)
    const targets = [];
    if (baseTab && seTabHasChanges(baseTab)) targets.push(baseTab);
    for (const t of changed) if (t.id !== 'base') targets.push(t);
    const btn = document.getElementById('se-save');
    if (btn) btn.disabled = true;
    const saved = [], failed = [];
    let baseReload = false;
    try {
        for (const t of targets) {
            if (seTab() !== t) seActivateTab(panel, t);
            const label = seTabLabel(t);
            try {
                if (t.id === 'base') {
                    const r = await commitBaseTab(panel, msg);
                    if (r.ok) saved.push(label);
                    else failed.push([label, r.error]);
                    baseReload = baseReload || !!r.reloadStep;
                } else {
                    const nm = (t.name || '').trim();
                    if (!nm) {
                        failed.push([label, C.t('uplift.toast.profile_name_required')]);
                        MM_GLUE.toast(C.t('uplift.toast.profile_name_required'));
                        continue;
                    }
                    const st = await saveProfileCommit(panel, t, nm, msg);
                    if (st === 'saved') saved.push(label);
                    else failed.push([label, msg.textContent || 'invalid']);
                }
            } catch (e) {
                failed.push([label, D.errText(e)]);
                MM_GLUE.toast(t.id === 'base'
                    ? C.t('uplift.toast.save_failed', {msg: D.errText(e)})
                    : C.t('uplift.toast.profile_save_failed', {msg: D.errText(e)}));
            }
        }
        // TTS-1: commit the voice-defaults block through the same SAVE press
        let ttsAttempted = false;
        if (ttsDirty) {
            ttsAttempted = true;
            const lab = C.tf('uplift.voices.tts_section', 'TTS voice defaults');
            try { await seCommitTts(); saved.push(lab); }
            catch (e) { failed.push([lab, D.errText(e)]); MM_GLUE.toast(D.errText(e)); }
        }
        if (targets.length > 1 || (ttsAttempted && (targets.length >= 1 || failed.length))) {
            // per-tab honest summary (BUG-6 doctrine: final state only)
            const parts = [];
            if (saved.length) parts.push(C.tf('uplift.se.saved_all', 'saved') + ': ' + saved.join(', '));
            if (failed.length) parts.push(C.tf('uplift.se.failed_suffix', 'failed') + ': '
                + failed.map(x => x[0] + ' (' + x[1] + ')').join(', '));
            msg.textContent = parts.join(' — ');
            if (baseReload && Object.keys(seDeferred).length)
                msg.textContent += ' · ' + Object.keys(seDeferred).length
                    + ' setting(s) apply on RESTART MODEL';
            if (baseReload && baseTab) seActivateTab(panel, baseTab);  // RESTART lives on the base tab
            seRenderTabs(panel); seUpdateSaveBtn();
        } else if (failed.length === 1) {
            // single target that failed via a soft path (validation short-
            // circuit already wrote its message) — keep the old bare-error
            // label shape, no 'failed: X ()' wrapper
            if (!/^error: |^saved/i.test(msg.textContent || ''))
                msg.textContent = 'error: ' + failed[0][1];
        } else if (!ttsAttempted && saved.length === 1 && targets[0].id === 'base'
                   && !baseReload && seTabs.every(t => !seTabHasChanges(t))) {
            setTimeout(closeEditor, 1200);   // old single-base close behavior
        }
    } finally {
        // recompute from tab state: clean tabs leave the button disabled,
        // a failed one re-enables it for a retry (BUG-6 doctrine)
        if (btn) btn.disabled = !seTabs.some(seTabHasChanges) && !seTtsIsDirty();
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
        msg.textContent = 'error: ' + D.errText(e);
        MM_GLUE.toast(C.t('uplift.toast.reload_failed', {msg: D.errText(e)}));
        if (b) b.disabled = false;
    }
}
async function saveProfileTab(panel) {
    const msg = panel.querySelector('#se-msg');
    const t = seTab();
    const name = (t.name || '').trim();
    if (!name) { MM_GLUE.toast(C.t('uplift.toast.profile_name_required')); return; }
    // BUG-6 (user doctrine): NO intermediate "saving…" label — the label
    // shows only saved ✓ or the error; the button carries the busy state
    // (disabled while the request is in flight) and reactivates when the
    // write truly finished. The save call site must also catch rejections
    // — an uncaught async error used to strand both label and button.
    const btn = document.getElementById('se-save');
    if (btn) btn.disabled = true;
    try {
        await saveProfileCommit(panel, t, name, msg);
    } catch (e) {
        msg.textContent = 'error: ' + D.errText(e);
        MM_GLUE.toast(C.t('uplift.toast.profile_save_failed', {msg: D.errText(e)}));
    } finally {
        if (btn) btn.disabled = seDirtyKeys().length === 0;
    }
}
function seProfileSettingsFrom(vals) {
    // only keys that differ from base persist (inheritance semantics) —
    // the same diff saveProfileCommit runs, shared so the UP-30
    // 'update to current form values' verb cannot drift from the save path.
    // Lives INSIDE the saveProfileTab..exports region: the sliced harnesses
    // (bug6-profile-save, u84-save-all-tabs) run that block in their own
    // sandbox and must find this helper in scope.
    const ov = {};
    for (const [k, v] of Object.entries(vals || {})) {
        if (k === 'ctKwargEntries' || k === 'model_alias') continue;
        if (v === undefined) continue;
        if (JSON.stringify(v) !== JSON.stringify(seBaseVals[k])) ov[k] = v;
    }
    return ov;
}
async function saveProfileCommit(panel, t, name, msg) {
    // full modelspec-shaped settings + inheritable validation via base merge
    const mergedForValidate = Object.assign({}, seBaseVals,
        JSON.parse(JSON.stringify(t.workVals || {})));
    seNormalizeKwargs(mergedForValidate);   // R10-6
    const errors = window.UpliftModelSpec.validate(mergedForValidate, seModelEntry());
    if (errors.length) { msg.textContent = errors[0]; MM_GLUE.toast(errors[0]); return 'invalid'; }
    // R10-6: convert the tab's edited kwargs entries back to the raw
    // settings shape so the inheritance diff below can persist them
    if (t.workVals && t.workVals.ctKwargEntries) {
        const kw = window.UpliftModelSpec.buildPayload(t.workVals, seFormModel);
        t.workVals.chat_template_kwargs = kw.chat_template_kwargs;
        t.workVals.forced_ct_kwargs = kw.forced_ct_kwargs;
    }
    // only keys that differ from base persist (inheritance semantics) —
    // UP-30: the diff loop now lives in seProfileSettingsFrom, shared with
    // the 'Update to current form values' verb (same semantics, one code
    // path; pinned by tests/u30-profile-management.test.cjs)
    let ov = seProfileSettingsFrom(t.workVals);
    // version adaptation: an older server drops unknown keys from profile
    // settings (silent mis-save) — translate renamed fields first.
    // BUG-6 root cause: `ov` used to be const and reassigned here — a
    // runtime TypeError that killed EVERY profile save before the request
    // was issued (node --check parses sloppy mode, so the gate could not
    // see it; pinned behaviourally in bug6-profile-save.test.cjs).
    ov = window.UpliftModelSpec.adaptToServerSettings(
        ov, await MM_GLUE.modelSettingsFields());
    const body = { name, display_name: t.display_name || name, settings: ov,
        expose_as_model: !!t.expose_as_model, api_name: t.api_name || null };
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
    return 'saved';
}


window.Uplift.mmEditor = {
    openEditor: openEditor,
    closeEditor: closeEditor,
    get seModel() { return seModel; },
    data: MM_DATA,          // FE-6: shared store (was window.__se*)
    /* UP-20/UP-30 test seams (the _dl14/_up22 pattern from the downloader):
       the vm harnesses drive the pure machine + the modal/picker shells;
       no runtime consumer outside this file. */
    _u20: {
        SETTINGS_APPLY, genDefaultsPatch, SE_GEN_SET_KEYS, SE_GEN_CLEAR,
        seApplyGenDefaults, openSettingsApply, closeSettingsApply,
        renderSettingsApply, runSettingsApply, applyOptimalCandidate,
        loadOptimalCandidates, seOnSettingsApplied, seSnapshotActions,
        // install/inspect editor state headless (openEditor is a full page
        // fetch chain a vm cannot drive); assignment only — no logic here
        inject(o) {
            if ('seModel' in o) seModel = o.seModel;
            if ('seValues' in o) seValues = o.seValues;
            if ('seOrig' in o) seOrig = o.seOrig;
            if ('seBaseVals' in o) seBaseVals = o.seBaseVals;
            if ('seTabs' in o) seTabs = o.seTabs;
            if ('seActiveTab' in o) seActiveTab = o.seActiveTab;
            if ('seFormModel' in o) seFormModel = o.seFormModel;
        },
        get live() {
            return { seModel, seValues, seOrig, seBaseVals,
                     seTabs, seActiveTab };
        },
        get state() { return seApplyOverlay && seApplyOverlay.st; },
        // a full openEditor is un-driveable headless; tests install a
        // recorder here and assert the post-apply reload fires on it
        get reloadHook() { return seReloadAfterApply; },
        set reloadHook(fn) { seReloadAfterApply = fn; },
        get MM_GLUE_kit() {   // proves the MM_GLUE.postJson wiring fix
            return { postJson: MM_GLUE.postJson, putJson: MM_GLUE.putJson,
                     deleteJson: MM_GLUE.deleteJson }; },
    },
    _u30: {
        isValidProfileName, profileFieldsPatch, nextDeleteState,
        resyncTargetTemplate, profileOptionLabel, profileOptionTitle,
        seProfileSettingsFrom, seApplyTemplateUpsert, seProfileEditDialog,
        seLoadProfiles,
    },
};
window.Uplift.mmData = MM_DATA;   // loaded early; mmtemplates fills .templates
})();
