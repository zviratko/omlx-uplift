/* TTS-1 — shared-editor voice defaults + manager VOICES chip.
   uplift_mmeditor.js / uplift_mmtable.js are browser IIFEs; same slicing
   pattern as u84-save-all-tabs — new Function runs ONLY this repository's
   own checked-in source (no external input reaches the body). Pinned:
   - seTtsAttach is SILENT unless the row is audio_tts AND the capabilities
     probe answers qwen3; probe failure stays silent, never throws;
   - controls appear exactly where the probe proves them: speaker select
     only for custom_voice with speakers, language combobox only with a
     language table, instruct textarea only when caps.instruct (the
     0.6B-CustomVoice checkpoint has NO instruction control — the field
     must not lie);
   - prefills ride the stored defaults; dirtying a control through its own
     onchange and committing POSTs {model, speaker, language, instructions}
     to /voices/tts/defaults and re-bases orig from the server answer;
   - the manager VOICES chip condenses to three names + ',+N', only on
     rows with stored voices, and survives a dead voice store.
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const EDIT = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmeditor.js'), 'utf8');
const TABLE = fs.readFileSync(path.join(STATIC_DIR, 'uplift_mmtable.js'), 'utf8');
function region(src, start, end, label) {
    const a = src.indexOf(start), b = src.indexOf(end, a);
    assert.ok(a > 0 && b > a, 'slice region missing: ' + label);
    return src.slice(a, b);
}
const TTS_CODE = [
    region(EDIT, 'let seTts = null;', 'function seTtsField', 'tts state trio'),
    region(EDIT, 'function seTtsField', '/* U2: roomy grammar', 'attach + fields'),
].join('\n');

function mkDom() {
    function mk(tag) {
        const set = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            parentNode: null, hidden: false, value: '', type: '', disabled: false,
            title: '', _text: '',
            get textContent() { return this._text; },
            set textContent(v) {
                (this.children || []).forEach(c => { c.parentNode = null; });
                this.children = []; this._text = String(v);
            },
            get className() { return [...set].join(' '); },
            set className(v) { set.clear(); String(v || '').split(/\s+/)
                .filter(Boolean).forEach(c => set.add(c)); },
            _classes: set,
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            append(...kids) { kids.forEach(c => {
                if (typeof c === 'string') return;
                c.parentNode = this; this.children.push(c); }); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            // TTS-2: chip / EDIT buttons are clicked in tests now — the same
            // contract the tts-tab harness uses
            click() { if (el.onclick) el.onclick({ stopPropagation() {} }); },
        };
        // control text can live in .value (textarea/input) — a serializer
        // that only reads _text hides prefills (live catch: an app-side
        // prefill asserted invisible while the app was right)
        el.selectedText = () => ([el._text, el.value].concat(el.children.map(
            c => c.selectedText ? c.selectedText() : ''))).join(' ').trim();
        return el;
    }
    const doc = { createElement: mk, body: mk('body'),
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    return { doc };
}

function editorHarness({ caps = null, defaults = {}, entry = null,
                         capsFail = false, store = null, storeFail = false } = {}) {
    const { doc } = mkDom();
    const scroll = doc.createElement('div');
    const calls = [];
    const D = {
        postJson: async (p, b) => { calls.push(['POST', p, b]);
            if (D.fail === p) throw new Error('boom');
            const map = {}; map[b.model] = {
                speaker: b.speaker || '', language: b.language || '',
                instructions: b.instructions || '' };
            return { ok: true, defaults: map }; },
        fetchJson: async (p) => { calls.push(['GET', p]);
            if (p.includes('capabilities')) { if (capsFail) throw new Error('down'); return caps; }
            if (p.includes('tts/defaults')) return { defaults };
            if (p.includes('/uplift/api/voices')) {
                if (storeFail) throw new Error('store down');
                return { voices: store || [] };
            }
            throw new Error('unstubbed ' + p); },
    };
    const MM_GLUE = { fetchJson: D.fetchJson, toast: () => {} };
    const C = { t: k => k, tf: (k, d) => d };
    const touch = [];
    const jumps = [];         // openVoices calls the EDIT buttons make
    let closed = 0;           // closeEditor calls
    const FN = new Function('D', 'MM_GLUE', 'C', 'API', 'window', 'document',
        'seModel', 'seFormModel', 'seUpdateSaveBtn', 'seIsBaseTab',
        'closeEditor',
        TTS_CODE + '\nreturn { attach: seTtsAttach, attachVoices: seVoicesAttach,'
            + ' isDirty: seTtsIsDirty, commit: seCommitTts };');
    const form = entry || { id: 'M1', engine_type: 'audio_tts' };
    const api = FN(D, MM_GLUE, C, '', {
        Uplift: { capsFor: async () => { if (capsFail) throw new Error('down'); return caps; },
                  voices: { openVoices: (...a) => jumps.push(a) } },
        UpliftDom: D,
    }, doc,
    // plain VALUES: the sliced code compares seModel against a captured
    // string; a getter function would never equal it (live catch)
    'M1', form,
    () => touch.push(1), () => true, () => { closed++; });
    return { api, doc, scroll, calls, touch, jumps,
             closed: () => closed };
}

const CAPS_CV = { qwen3: true, type: 'custom_voice', size: '1b7',
    languages: ['auto', 'en', 'cs'], speakers: ['Ava', 'Noah'], instruct: true };
const CAPS_CV06 = Object.assign({}, CAPS_CV, { size: '0b6', instruct: false });

test('attach renders exactly the probed controls (custom_voice 1b7)', async () => {
    const h = editorHarness({ caps: CAPS_CV,
        defaults: { M1: { speaker: 'Ava', instructions: 'Very happy.', language: '' } } });
    const scroll = h.scroll;
    await h.api.attach({ querySelector: s => (s === '.editor-scroll' ? scroll : null) });
    assert.equal(scroll.children.length, 1, 'one framed box appended');
    const box = scroll.children[0];
    assert.ok(box._classes.has('se-tts'), 'carries the se-tts hook class');
    const text = box.selectedText();
    assert.ok(text.includes('Speaker') && text.includes('Language')
              && text.includes('Instruct'), text);
    assert.ok(text.includes('Ava') && text.includes('Noah'), 'speakers listed');
    assert.ok(text.includes('Very happy.'), 'instructions prefilled');
});

test('attach is silent for non-TTS rows, non-qwen3 probes and probe failure', async () => {
    let h = editorHarness({ caps: CAPS_CV, entry: { id: 'M1', engine_type: 'batched' } });
    await h.api.attach({ querySelector: s => s === '.editor-scroll' ? h.scroll : null });
    assert.equal(h.scroll.children.length, 0, 'not audio_tts — no node at all');
    h = editorHarness({ caps: { qwen3: false, type: '', size: '', languages: [],
                                speakers: [], instruct: false } });
    await h.api.attach({ querySelector: s => s === '.editor-scroll' ? h.scroll : null });
    assert.equal(h.scroll.children.length, 0, 'probe says no — silent absence');
    h = editorHarness({ caps: CAPS_CV, capsFail: true });
    await h.api.attach({ querySelector: s => s === '.editor-scroll' ? h.scroll : null });
    assert.equal(h.scroll.children.length, 0, 'probe down — silent, never a throw');
});

test('0b6 custom_voice never gets the instruct textarea (no lying field)', async () => {
    const h = editorHarness({ caps: CAPS_CV06 });
    await h.api.attach({ querySelector: () => h.scroll });
    const text = h.scroll.children.map(c => c.selectedText()).join(' ');
    assert.ok(text, 'the box itself renders');
    assert.ok(!text.includes('Instruct'), 'instruct control absent');
    assert.ok(text.includes('Speaker'), 'speaker control still there');
});

test('dirty + commit: POST carries the model and the full 3-key entry', async () => {
    const h = editorHarness({ caps: CAPS_CV,
        defaults: { M1: { speaker: 'Ava', instructions: 'Very happy.', language: '' } } });
    await h.api.attach({ querySelector: () => h.scroll });
    assert.equal(h.api.isDirty(), false, 'prefilled state is clean');
    // no internals shortcut: dirty a field the way the user does — through
    // the select's own onchange handler found on the rendered box
    const box = h.scroll.children[0];
    const find = (el, tag) => {
        if (el.tagName === tag) return el;
        for (const c of el.children || []) { const r = find(c, tag); if (r) return r; }
        return null;
    };
    const sel = find(box, 'select');
    assert.ok(sel, 'speaker select exists');
    sel.value = 'Noah';
    sel.onchange();
    assert.equal(h.api.isDirty(), true, 'select change dirties the block');
    await h.api.commit();
    const post = h.calls.find(c => c[0] === 'POST');
    assert.ok(post[1].endsWith('/uplift/api/voices/tts/defaults'), post[1]);
    assert.deepEqual(post[2], { model: 'M1', speaker: 'Noah',
                               language: '', instructions: 'Very happy.' });
    assert.equal(h.api.isDirty(), false, 'commit re-bases orig from the server map');
});

/* ---------------- manager VOICES chip ---------------- */
const BADGE_CODE = region(TABLE, 'const VOICE_BADGE_TTL_S', 'function confirmDialog',
    'voice badge helpers');
function badgeHarness({ voices = null, fail = false, preload = true,
                        loadFail = false } = {}) {
    const { doc } = mkDom();
    const rows = {};
    const table = {
        querySelectorAll: sel => sel === '.urow.admin' ? Object.values(rows) : [],
    };
    function row(mid) {
        const r = doc.createElement('div');
        r.className = 'urow admin'; r.dataset.mid = mid;
        const lamps = doc.createElement('span'); lamps.className = 'lampstack';
        const n1 = doc.createElement('span'); n1.className = 'nrow1';
        n1.append(lamps);
        r.append(n1);
        r.querySelectorAll = s => s === '.lampstack' ? [lamps] :
            (s === '.nrow1' ? [n1] : []);
        r.querySelector = s => s === '.lampstack' ? lamps :
            (s === '.nrow1' ? n1 : null);
        rows[mid] = r;
        return r;
    }
    const MM_GLUE = { fetchJson: async () => {
        if (fail) throw new Error('store down');
        return { voices };
    }, toast: (m, c) => toasts.push([String(m), c]) };
    const C = { tf: (k, d) => d, t: (k) => k };
    const toasts = [];
    const jumps = [];
    const loads = [];
    const win = { Uplift: {} };
    if (preload) win.Uplift.voices = { openVoices: (...a) => jumps.push(a) };
    const D = { loadScript: (src) => {
        loads.push(src);
        if (loadFail) return Promise.reject(new Error('script load failed'));
        // the loaded script is what registers window.Uplift.voices IRL
        win.Uplift.voices = win.Uplift.voices || { openVoices: (...a) => jumps.push(a) };
        return Promise.resolve();
    } };
    const FN = new Function('MM_GLUE', 'API', 'C', 'document', 'window', 'D',
        BADGE_CODE + '\nreturn { attach: attachVoiceBadges };');
    const api = FN(MM_GLUE, '', C, doc, win, D);
    return { api, table, row, jumps, loads, toasts };
}

test('VOICES chip: condensed names, only on rows with stored voices', async () => {
    const h = badgeHarness({ voices: [
        { name: 'Zuzana', model: 'Qwen3-TTS' }, { name: 'Mila', model: 'Qwen3-TTS' },
        { name: 'a', model: 'Big' }, { name: 'b', model: 'Big' },
        { name: 'c', model: 'Big' }, { name: 'd', model: 'Big' },
    ] });
    const r1 = h.row('Qwen3-TTS'); const r2 = h.row('Big'); const r3 = h.row('Other');
    h.api.attach(h.table);
    await new Promise(r => setImmediate(() => setImmediate(r)));
    const chips1 = r1.querySelectorAll('.lampstack')[0].children;
    assert.equal(chips1.length, 1);
    assert.equal(chips1[0].textContent, 'VOICES:Zuzana,Mila');
    assert.ok(chips1[0]._classes.has('voices-lamp'), 'chip class hooks the style');
    const chips2 = r2.querySelectorAll('.lampstack')[0].children;
    assert.equal(chips2[0].textContent, 'VOICES:a,b,c,+1');
    assert.ok(chips2[0].title.includes('a, b, c, d'), 'full list in the title');
    assert.equal(r3.querySelectorAll('.lampstack')[0].children.length, 0);
});

test('VOICES chip survives a dead voice store', async () => {
    const h = badgeHarness({ fail: true });
    const r = h.row('Qwen3-TTS');
    h.api.attach(h.table);
    await new Promise(res => setImmediate(() => setImmediate(res)));
    assert.equal(r.querySelectorAll('.lampstack')[0].children.length, 0);
});

/* ---- TTS-2: the chip is a way IN + the editor's CUSTOM VOICES block ---- */
test('VOICES chip click opens the CLONED VOICES tab for that model', async () => {
    const h = badgeHarness({ voices: [{ name: 'Jake', model: 'Qwen3-TTS' }] });
    const r = h.row('Qwen3-TTS');
    h.api.attach(h.table);
    await new Promise(res => setImmediate(() => setImmediate(res)));
    const chip = r.querySelectorAll('.lampstack')[0].children[0];
    chip.click();
    assert.deepEqual(h.jumps, [['clone', 'Qwen3-TTS']],
        'one openVoices call: clone tab, this row\'s model');
    assert.deepEqual(h.loads, [], 'a loaded voices page is used directly');
});

test('VOICES chip lazy-loads the voices module when the page never opened', async () => {
    const h = badgeHarness({ voices: [{ name: 'Jake', model: 'Qwen3-TTS' }],
                             preload: false });
    const r = h.row('Qwen3-TTS');
    h.api.attach(h.table);
    await new Promise(res => setImmediate(() => setImmediate(res)));
    r.querySelectorAll('.lampstack')[0].children[0].click();
    assert.deepEqual(h.loads, ['./uplift_voices.js'], 'the SAME lazy path applyTab uses');
    await new Promise(res => setImmediate(() => setImmediate(res)));
    assert.deepEqual(h.jumps, [['clone', 'Qwen3-TTS']],
        'the jump lands once the script is in');
});

test('VOICES chip survives a failed voices-module load (toast, never a throw)', async () => {
    const h = badgeHarness({ voices: [{ name: 'Jake', model: 'Qwen3-TTS' }],
                             preload: false, loadFail: true });
    const r = h.row('Qwen3-TTS');
    h.api.attach(h.table);
    await new Promise(res => setImmediate(() => setImmediate(res)));
    const chip = r.querySelectorAll('.lampstack')[0].children[0];
    let err = null;
    try { chip.click(); await new Promise(res => setImmediate(() => setImmediate(res))); }
    catch (e) { err = e; }
    assert.equal(err && err.message, null, 'the dead seam must not break the table');
    assert.equal(h.jumps.length, 0, 'nothing was called on the missing module');
});

/* the editor block: silent-absence, filtering, base-tab gate, EDIT handoff */
const voicesBox = (h) => h.scroll.children.find(c => c._classes.has('se-voices'));
const findBtns = (el, out) => {
    out = out || [];
    if (el.tagName === 'button') out.push(el);
    for (const c of el.children || []) findBtns(c, out);
    return out;
};

test('editor CUSTOM VOICES block: this model\'s rows only', async () => {
    const h = editorHarness({ store: [
        { id: 'v1', name: 'Jake', model: 'M1' },
        { id: 'v2', name: 'Katka', model: 'M1' },
        { id: 'v3', name: 'Other', model: 'M2' },
        { id: 'v4', name: 'Zuzana', model: 'say:Zuzana' },
    ] });
    await h.api.attachVoices({ querySelector: () => h.scroll });
    const box = voicesBox(h);
    assert.ok(box, 'the block renders when the store has rows for this model');
    const text = box.selectedText();
    assert.ok(text.includes('Jake') && text.includes('Katka'), text);
    assert.ok(!text.includes('Other'), 'a foreign model\'s voice stays out');
    assert.ok(!text.includes('Zuzana'),
        'the say: system voice is not a custom clone — TTS tab owns it');
    assert.ok(text.includes('EDIT'), 'the only action is the handoff');
});

test('editor block EDIT: close the editor, hand the voice to the form', async () => {
    const h = editorHarness({ store: [{ id: 'v1', name: 'Jake', model: 'M1' }] });
    await h.api.attachVoices({ querySelector: () => h.scroll });
    const edit = findBtns(voicesBox(h))[0];
    edit.click();
    assert.equal(h.closed(), 1, 'the editor closed first — no modal behind the jump');
    assert.deepEqual(h.jumps, [['clone', 'M1', 'v1']],
        'openVoices(tab, model, editId): the existing form edits in place');
});

test('editor block is silent when nothing applies (no rows, dead store)', async () => {
    let h = editorHarness({ store: [] });
    await h.api.attachVoices({ querySelector: () => h.scroll });
    assert.equal(h.scroll.children.length, 0, 'no voices — no box (silent absence)');
    h = editorHarness({ store: [{ id: 'v', name: 'Other', model: 'M2' }] });
    await h.api.attachVoices({ querySelector: () => h.scroll });
    assert.equal(h.scroll.children.length, 0, 'only THIS model\'s voices frame a box');
    h = editorHarness({ store: null, storeFail: true });
    let err = null;
    try { await h.api.attachVoices({ querySelector: () => h.scroll }); }
    catch (e) { err = e; }
    assert.equal(err && err.message, null, 'a dead store must not throw from the editor');
    assert.equal(h.scroll.children.length, 0);
});
