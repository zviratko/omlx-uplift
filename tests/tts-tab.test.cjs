/* TTS-1 lane B — the TEXT TO SPEECH tab in the Voices panel
   (uplift_voices.js). Harness copied from say1-macos-tab.test.cjs (the same
   vm + hand-rolled DOM, including its textContent-replacing setter, the
   append()-tolerates-strings stub and the byId registry).

   Pinned (TTS-2 updated the tab-order and grouping rows):
   - tab strip: TEXT TO SPEECH | CLONED VOICES | macOS VOICES — TTS is the
     FIRST tab and the default; the clone form renders on it ONLY while
     EDIT / SAVE AS is active (one form, one render path)
   - models sorted by name; ONE header row per audio_tts model with a SETTINGS
     button; built-in speaker rows ONLY where the caps probe proved them
     (qwen3 + non-empty speakers) — a foreign engine stays a bare model row
   - TTS-2: stored (custom) voices group under their model, indented like the
     speakers, as full voice rows; voices riding the macOS say engine get a
     'macOS system voices' group and are ABSENT from the CLONED list
   - openVoices(tab, modelId, editId) — the manager jump: selects the tab,
     flashes the first row of that model once, and can arm the edit form
   - the caps probe is the exported window.Uplift.capsFor (GET
     /voices/capabilities?model=), never re-implemented client-side
   - DEFAULT is one lamp per model: lit follows tts_defaults[model].speaker
     from the SERVER payload; clicking POSTs the FULL row (speaker plus the
     modal-only fields verbatim — the router replaces rows, omitting them
     would erase them); either way the
     panel re-GETs /voices/tts/defaults and repaints from it (the client
     never patches the cache itself)
   - the defaults map is fetched ONCE per visit, not once per model/row
   - PLAY posts /voices/tts/speak with exactly {model, speaker, input} and
     nothing else, then feeds the response to the shared blob player
   - SETTINGS is the model manager's own editor seam
     (window.Uplift.modelmgr.openEditor(model id)); a missing seam toasts and
     must not throw
   - no models at all -> the honest empty state (but a macOS-only store still
     renders its group instead)
   - the CLONED VOICES tab keeps the pre-TTS DOM byte-identical apart from
     the two declared TTS-2 deltas (tab-button order filtered out, the new
     data-model focus hook stripped)
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = path.join(STATIC_DIR, 'uplift_voices.js');

function makeDom() {
    const byId = {};
    const doc = {};
    function mk(tag) {
        const set = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            parentNode: null, hidden: false, value: '', type: '',
            disabled: false, title: '', _text: '',
            get textContent() { return this._text; },
            // DOM spec: assigning textContent REPLACES all children
            // (renderVoices clears the host this way — a property stub
            // that keeps children duplicates every re-render, live catch)
            set textContent(v) {
                (this.children || []).forEach(c => { c.parentNode = null; });
                this.children = [];
                this._text = String(v);
            },
            get className() { return [...set].join(' '); },
            set className(v) {
                set.clear();
                String(v || '').split(/\s+/).filter(Boolean).forEach(c => set.add(c));
            },
            _classes: set,
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            append(...kids) {
                // real DOM turns string args into text nodes; this stub
                // only needs them to not crash and not pollute children
                kids.forEach(c => {
                    if (typeof c === 'string') return;
                    c.parentNode = this; this.children.push(c);
                });
            },
            appendChild(k) { k.parentNode = this; this.children.push(k); return k; },
            // real DOM inserts the args, in order, at the FRONT (voiceForm
            // prepends the 'download a TTS model' link when none is installed)
            prepend(...kids) {
                const el = kids.filter(c => typeof c !== 'string');
                el.forEach(c => { c.parentNode = this; });
                this.children.unshift(...el);
            },
            insertBefore(k, ref) {
                const i = ref ? this.children.indexOf(ref) : -1;
                k.parentNode = this;
                if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
                return k;
            },
            removeChild(k) {
                const i = this.children.indexOf(k);
                if (i >= 0) { this.children.splice(i, 1); k.parentNode = null; }
                return k;
            },
            remove() {
                if (this.parentNode) this.parentNode.removeChild(this);
                else this.children = [];
            },
            addEventListener() {}, removeEventListener() {},
            focus() {}, blur() {},
            click() { if (el.onclick) el.onclick({ stopPropagation() {} }); },
            classList: {
                add(...c) { c.forEach(x => set.add(x)); },
                remove(...c) { set.delete(c); },
                contains(c) { return set.has(c); },
                toggle(c, on) {
                    if (on === undefined) on = !set.has(c);
                    if (on) set.add(c); else set.delete(c);
                    return on;
                },
            },
        };
        return el;
    }
    doc.createElement = mk;
    doc.body = mk('body');
    doc.getElementById = id => byId[id] || null;
    doc.documentElement = mk('html');
    // ONLY the class selectors this module actually issues are supported
    doc.querySelectorAll = sel => {
        const want = String(sel).replace(/^\./, '').split('.');
        const out = [];
        (function walk(n) {
            for (const c of n.children || []) {
                if (want.every(w => c._classes && c._classes.has(w))) out.push(c);
                walk(c);
            }
        })(doc.body);
        return out;
    };
    doc.addEventListener = () => {};
    return { doc, byId, mk };
}

function allText(n) {
    return (String(n.textContent || '') + ' ' +
        (n.children || []).map(allText).join(' ')).trim();
}
function classes(n, c, out) {
    out = out || [];
    for (const k of n.children || []) {
        if (k._classes && k._classes.has(c)) out.push(k);
        classes(k, c, out);
    }
    return out;
}
const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

/* Real admin-model shape (engine_type AND model_type present, id == the
   served model name), one Qwen3-TTS custom-voice checkpoint and one foreign
   engine — the exact pair that proves the caps gate. */
const MODELS = [
    { id: 'Qwen3-TTS-1.7B-CustomVoice', name: 'Qwen3-TTS-1.7B-CustomVoice',
      engine_type: 'audio_tts', model_type: 'audio_tts' },
    { id: 'kokoro-82m', name: 'Kokoro-82M',
      engine_type: 'audio_tts', model_type: 'audio_tts' },
];
const CAPS = {
    'Qwen3-TTS-1.7B-CustomVoice': {
        model: 'Qwen3-TTS-1.7B-CustomVoice', qwen3: true,
        type: 'custom_voice', languages: ['auto', 'en', 'cs'],
        speakers: ['Uncle_Fu', 'Vivian'] },
    'kokoro-82m': { model: 'kokoro-82m', qwen3: false, type: '',
                    languages: [], speakers: [] },
};

async function mount(opt) {
    const o = Object.assign({ models: MODELS, caps: CAPS, defaults: {},
                              store: [], src: null, editor: true,
                              // TTS-3: the tts tab now also reads /voices/say
                              // (the macOS engine card); fixtures default to
                              // a supported engine with an EMPTY catalog —
                              // legacy store rows then render exactly as the
                              // TTS-2 tests describe them
                              saySupported: true, sayVoices: [],
                              sysl: '', sysv: '' }, opt || {});
    const { doc, byId } = makeDom();
    const st = { posts: [], fetches: [], toasts: [], gets: [], editor: [],
                 deletes: [], audioPlays: 0 };
    // the SERVER's copy of voices.json > tts_defaults: postJson mutates it,
    // fetchJson hands out a fresh snapshot, so a repaint can only come from a
    // real re-GET (the client patching its own cache would still pass, but a
    // client that never re-reads could not).
    const live = { defaults: JSON.parse(JSON.stringify(o.defaults)) };
    byId['vc-body'] = doc.createElement('div');
    byId['vc-body'].id = 'vc-body';
    byId['vc-sub'] = doc.createElement('span');
    byId['vc-sub'].id = 'vc-sub';
    doc.body.append(byId['vc-body'], byId['vc-sub']);
    const mgr = { adminModels: o.models };
    if (o.editor) mgr.openEditor = (id) => { st.editor.push(id); };
    const win = {
        console, document: doc, Promise, JSON, Math, Object, Array, String,
        Number, Boolean, RegExp, Set, Map, Error, TypeError, isFinite, isNaN,
        parseInt, parseFloat, setTimeout, clearTimeout,
        scrollTo: () => {},       // voiceRow EDIT + SAVE AS scroll to the form
        confirm: () => true,      // TTS-3: merged-row DELETE is confirm-gated
        // the self-fetch fallback path in renderVoices uses the bare API global
        API: '',
        Intl: { DisplayNames: (globalThis.Intl || {}).DisplayNames },
        location: { hash: '#models/voices', pathname: '/uplift/', search: '' },
        navigator: {},
        localStorage: { getItem: () => null, setItem: () => {} },
        URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
        Audio: function () { return { play() { st.audioPlays++; },
                                      pause() {}, set src(v) {}, }; },
        fetch: async (u, init) => {
            st.fetches.push({ url: String(u), body: init && init.body });
            return { ok: true, blob: async () => ({ type: 'audio/wav' }) };
        },
        UpliftCore: {
            API: '',
            t: k => k,
            tf: (k, fb) => fb,
            normalize: x => x,
        },
        UpliftDom: {
            $: id => doc.getElementById(id),
            fetchJson: async (u) => {
                u = String(u); st.gets.push(u);
                if (u.includes('/voices/tts/defaults'))
                    return { defaults: JSON.parse(JSON.stringify(live.defaults)) };
                if (u.includes('/voices/capabilities')) {
                    const id = decodeURIComponent(
                        (u.match(/[?&]model=([^&]*)/) || [])[1] || '');
                    return o.caps[id] || { model: id, qwen3: false, type: '',
                                           languages: [], speakers: [] };
                }
                if (u.includes('/voices/say'))
                    return { supported: o.saySupported,
                             voices: o.sayVoices.map(v => Object.assign({}, v)),
                             system_language: o.sysl, system_voice: o.sysv };
                if (u.includes('/admin/api/models'))
                    return { models: o.models };
                return { voices: o.store };
            },
            postJson: async (u, b) => {
                u = String(u);
                st.posts.push({ url: u, body: b });
                if (u.includes('/voices/tts/defaults') && b && b.model) {
                    // POST semantics of the frozen contract: every field the
                    // request carries is written; all-empty drops the key
                    const cur = live.defaults[b.model]
                        || { speaker: '', instructions: '', language: '' };
                    for (const k of ['speaker', 'instructions', 'language'])
                        if (k in b) cur[k] = b[k];
                    if (cur.speaker || cur.instructions || cur.language)
                        live.defaults[b.model] = cur;
                    else delete live.defaults[b.model];
                }
                return { ok: true, defaults: live.defaults };
            },
            putJson: async () => ({}),
            deleteJson: async (u) => { st.deletes.push(String(u)); return {}; },
            toast: (msg, ms, cls) => st.toasts.push(
                { msg: String(msg), cls: typeof ms === 'string' ? ms : cls }),
            emptyMsg: (el, msg) => { el.textContent = msg; },
        },
        Uplift: { state: { API: '' }, modelmgr: mgr },
    };
    win.window = win; win.self = win;
    vm.runInContext(o.src || fs.readFileSync(SRC, 'utf8'),
                    vm.createContext(win), { filename: SRC });
    const V = win.Uplift.voices;
    await V.renderVoices();
    await settle(); await settle();
    const host = byId['vc-body'];
    const tabBtns = () => classes(host, 'vc-tab');
    const byText = (frag) => tabBtns().find(b =>
        String(b.textContent).includes(frag));
    const clickTab = async (frag) => {
        byText(frag).click();
        await settle(); await settle(); await settle();
        return tabBtns();
    };
    return { V, st, host, byId, doc, live, tabBtns, byText, clickTab,
             tClone: byText('CLONED'), tTts: byText('TEXT TO SPEECH'),
             tSay: byText('macOS') };
}

/* the rows the tts panel actually built, in document order */
const modelRows = (h) => classes(h.host, 'vc-tts-model');
const spkRows = (h) => classes(h.host, 'vc-tts-sp');
const rowName = (r) => String(r.children[0].textContent);
const defBtn = (r) => classes(r, 'vc-tts-def')[0];
const subCounter = (h) => String(h.byId['vc-sub'].textContent);

test('tab strip: TEXT TO SPEECH | CLONED | macOS, tts default', async () => {
    const h = await mount({});
    const btns = h.tabBtns();
    assert.deepEqual(btns.map(b => String(b.textContent)),
        ['TEXT TO SPEECH', 'CLONED VOICES', 'macOS VOICES'],
        'strip order is the frozen contract (TTS-2: TTS first)');
    assert.ok(h.tTts._classes.has('on'), 'tts is the default tab');
    assert.ok(!h.tClone._classes.has('on'), 'clone is NOT active on mount');
    assert.ok(!h.tSay._classes.has('on'));
    assert.equal(classes(h.host, 'vc-tts').length, 1,
                 'the tts box is what shows on mount');
    assert.ok(!classes(h.host, 'vc-add').length,
              'no voice form on the tts tab while nothing is being edited');
    assert.equal(h.st.gets.filter(u => u.includes('/voices/tts/defaults')).length, 1,
                 'the default tab reads its data once on mount');
});

test('tts tab: models sorted, speakers only where the probe proved them', async () => {
    const h = await mount({});
    await h.clickTab('TEXT TO SPEECH');
    const box = classes(h.host, 'vc-tts');
    assert.equal(box.length, 1, 'exactly one tts box');
    assert.ok(!classes(h.host, 'vc-add').length,
              'the clone form is off-tab — one box at a time');
    assert.ok(!classes(h.host, 'vc-say').length, 'no say panel either');
    assert.ok(allText(box[0]).includes('TTS MODELS'), 'title');
    assert.ok(allText(box[0]).includes(
        'SETTINGS opens the same editor as in the model manager'), 'hint');
    // TTS-3: the macOS engine line rides the model-row geometry too — the
    // MLX sort is asserted WITHOUT it (the card itself is pinned below)
    assert.deepEqual(modelRows(h).filter(r => !r._classes.has('vc-tts-mac'))
        .map(rowName),
        ['Kokoro-82M', 'Qwen3-TTS-1.7B-CustomVoice'], 'sorted by model name');
    // one SETTINGS per model, none on a speaker row
    assert.equal(classes(h.host, 'vc-tts-set').length, 2);
    const spks = spkRows(h);
    assert.deepEqual(spks.map(rowName), ['Uncle_Fu', 'Vivian'],
        'speaker rows only for the qwen3 custom-voice model, probe order');
    for (const r of spks) {
        assert.ok(r._classes.has('vc-row'), 'a speaker row is a voice row');
        assert.ok(!r.style.paddingLeft,
                  'indent is the stylesheet job — no inline style');
        assert.ok(r._classes.has('vc-tts-sp'),
                  'the class the CSS rule hooks on is present');
        assert.equal(classes(r, 'vc-tts-set').length, 0,
                     'a built-in speaker has no editor of its own');
    }
    // the caps probe ran once per model THROUGH the exported seam
    assert.deepEqual(h.st.gets.filter(u => u.includes('/voices/capabilities')).map(
        u => decodeURIComponent(u.match(/[?&]model=([^&]*)/)[1])),
        ['kokoro-82m', 'Qwen3-TTS-1.7B-CustomVoice'],
        'one GET /voices/capabilities per model');
    assert.equal(subCounter(h), '3 ×',
        'TTS-3: models PLUS the macOS engine card are what the tab offers '
        + '(the say engine is an engine — it gets a card whenever it is '
        + 'available, even with nothing picked yet)');
});

test('no TTS model, no say engine: the honest empty state, no rows', async () => {
    const h = await mount({ models: [], saySupported: false });
    await h.clickTab('TEXT TO SPEECH');
    const box = classes(h.host, 'vc-tts')[0];
    assert.ok(box, 'the box still frames the message');
    assert.ok(allText(box).includes(
        'No TTS model installed — download one in the model manager first.'),
        allText(box));
    assert.equal(classes(box, 'vc-row').length, 0);
    assert.equal(subCounter(h), '0 ×');
});

test('DEFAULT lamp follows the server payload; titles name the action', async () => {
    const h = await mount({
        defaults: { 'Qwen3-TTS-1.7B-CustomVoice':
                    { speaker: 'Vivian', instructions: '', language: '' } } });
    await h.clickTab('TEXT TO SPEECH');
    const [fu, viv] = spkRows(h).map(defBtn);
    assert.ok(!fu._classes.has('on'), 'uncle fu is not the default');
    assert.ok(viv._classes.has('on'), 'the stored speaker lights its lamp');
    assert.equal(viv.textContent, 'DEFAULT');
    assert.equal(viv.title, 'Clear the default voice for this model');
    assert.equal(fu.title,
        'Speak with this voice by default when a request names no voice');
    // a foreign engine's model row has no lamps at all
    assert.equal(spkRows(h).length, 2, 'kokoro contributes no speaker rows');
});

test('defaults: ONE read per page visit, not per model or per row', async () => {
    // _ttsDefaults is the _sayData pattern: read once, cached for the visit
    // (a DEFAULT click is the only thing that re-reads — pinned below)
    const h = await mount({});
    const reads = () => h.st.gets.filter(u => u.includes('/voices/tts/defaults')).length;
    await h.clickTab('TEXT TO SPEECH');
    assert.equal(reads(), 1, 'two models, two speaker rows — one GET');
    await h.clickTab('CLONED');
    await h.clickTab('TEXT TO SPEECH');
    assert.equal(reads(), 1, 're-entering the tab reuses the cached map');
    assert.ok(h.st.gets.some(u => /\/uplift\/api\/voices\/tts\/defaults$/.test(u)),
              'the read is on the uplift mount, like every sibling');
});

test('model row status names the answering voice or admits none', async () => {
    const h = await mount({ defaults: {
        'Qwen3-TTS-1.7B-CustomVoice':
            { speaker: 'Vivian', instructions: 'warm', language: 'cs' } } });
    await h.clickTab('TEXT TO SPEECH');
    const [kok, qwen] = modelRows(h);                 // sorted: K before Q
    assert.ok(allText(kok).includes('No default (each request decides)'),
              'a model with nothing stored admits it: ' + allText(kok));
    assert.ok(allText(qwen).includes('DEFAULT: Vivian'),
              'a stored speaker is named on the model header: ' + allText(qwen));
    assert.equal(classes(kok, 'vc-tts-stat').length, 1);
});

test('clicking an unlit DEFAULT posts the full row and re-reads', async () => {
    const h = await mount({
        defaults: { 'Qwen3-TTS-1.7B-CustomVoice':
                    { speaker: 'Vivian', instructions: '', language: '' } } });
    await h.clickTab('TEXT TO SPEECH');
    const before = h.st.gets.filter(u => u.includes('/voices/tts/defaults')).length;
    spkRows(h).map(defBtn)[0].click();       // Uncle_Fu over Vivian
    await settle(); await settle(); await settle();
    const post = h.st.posts.find(p => p.url.includes('/voices/tts/defaults'));
    assert.ok(post, 'the mark went to the defaults endpoint');
    assert.deepEqual(post.body,
        { model: 'Qwen3-TTS-1.7B-CustomVoice', speaker: 'Uncle_Fu',
          language: '', instructions: '' },
        'the FULL row goes out — the router replaces rows, so omitting '
        + 'the modal fields here would erase them');
    assert.ok(/\/uplift\/api\/voices\/tts\/defaults$/.test(post.url), post.url);
    assert.equal(h.st.gets.filter(u => u.includes('/voices/tts/defaults')).length,
        before + 1, 'the panel re-GETs the map instead of patching its cache');
    // ONE default per model: the repaint moves the lamp, nothing else
    const [fu, viv] = spkRows(h).map(defBtn);
    assert.ok(fu._classes.has('on'), 'the clicked speaker lights');
    assert.ok(!viv._classes.has('on'), 'the previous default is off');
    assert.equal(classes(h.host, 'vc-tts-def').filter(b => b._classes.has('on')).length, 1);
    assert.equal(h.st.posts.length, 1, 'one POST per click — no toast spam, no echo');
    assert.deepEqual(h.st.toasts, [], 'a successful mark is silent');
});

test('clicking the lit DEFAULT clears it (POST speaker "")', async () => {
    const h = await mount({
        defaults: { 'Qwen3-TTS-1.7B-CustomVoice':
                    { speaker: 'Vivian', instructions: 'warm', language: 'cs' } } });
    await h.clickTab('TEXT TO SPEECH');
    const viv = spkRows(h).map(defBtn)[1];
    assert.ok(viv._classes.has('on'));
    viv.click();
    await settle(); await settle(); await settle();
    const post = h.st.posts.find(p => p.url.includes('/voices/tts/defaults'));
    assert.deepEqual(post.body,
        { model: 'Qwen3-TTS-1.7B-CustomVoice', speaker: '',
          language: 'cs', instructions: 'warm' },
        'clearing the speaker re-sends the other row fields verbatim');
    assert.equal(spkRows(h).map(defBtn).filter(b => b._classes.has('on')).length, 0,
                 'cleared: no lamp lights');
    assert.deepEqual(h.live.defaults,
        { 'Qwen3-TTS-1.7B-CustomVoice':
          { speaker: '', instructions: 'warm', language: 'cs' } },
        'clearing the SPEAKER must not wipe the modal-only fields');
    // with nothing else stored the server drops the whole model key
    const h2 = await mount({
        defaults: { 'Qwen3-TTS-1.7B-CustomVoice':
                    { speaker: 'Vivian', instructions: '', language: '' } } });
    await h2.clickTab('TEXT TO SPEECH');
    spkRows(h2).map(defBtn)[1].click();
    await settle(); await settle(); await settle();
    assert.deepEqual(h2.live.defaults, {}, 'all-empty clears the key');
    assert.equal(spkRows(h2).map(defBtn).filter(b => b._classes.has('on')).length, 0);
});

test('PLAY speaks the built-in speaker with model+speaker, nothing stored', async () => {
    const h = await mount({});
    await h.clickTab('TEXT TO SPEECH');
    const fuRow = spkRows(h)[0];
    const play = classes(fuRow, 'vc-play')[0];
    const nFetch = h.st.fetches.length;
    play.click();
    await settle(); await settle(); await settle();
    assert.equal(h.st.fetches.length, nFetch + 1, 'exactly one request went out');
    const f = h.st.fetches[h.st.fetches.length - 1];
    assert.ok(/\/uplift\/api\/voices\/tts\/speak$/.test(f.url), f.url);
    const body = JSON.parse(f.body);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'speaker']);
    assert.equal(body.model, 'Qwen3-TTS-1.7B-CustomVoice');
    assert.equal(body.speaker, 'Uncle_Fu');
    assert.equal(body.input, 'Hello! My name is Uncle_Fu.');
    // 2 plays = the silent gesture-unlock frame + the real blob (VOICE-4)
    assert.equal(h.st.audioPlays, 2, 'the answer was handed to the shared player');
    assert.deepEqual(h.st.posts.filter(p => p.url.includes('/tts/defaults')), [],
        'auditioning never writes the store');
});

test('SETTINGS opens the MODEL MANAGER editor for that model id', async () => {
    const h = await mount({});
    await h.clickTab('TEXT TO SPEECH');
    const btns = classes(h.host, 'vc-tts-set');
    assert.deepEqual(btns.map(b => String(b.textContent)), ['SETTINGS', 'SETTINGS']);
    btns[1].click();                       // Qwen3-TTS row (sorted: kokoro first)
    await settle();
    assert.deepEqual(h.st.editor, ['Qwen3-TTS-1.7B-CustomVoice'],
        'the SAME seam the manager row uses, called with the model id');
    assert.deepEqual(h.st.posts, [], 'opening a modal posts nothing');
});

test('SETTINGS without the editor seam: a toast, never a throw', async () => {
    const h = await mount({ editor: false });
    await h.clickTab('TEXT TO SPEECH');
    let err = null;
    try { classes(h.host, 'vc-tts-set')[0].click(); } catch (e) { err = e; }
    assert.equal(err, null, 'the missing seam must not break the panel');
    assert.equal(h.st.toasts.length, 1, 'it says so once');
    assert.equal(h.st.toasts[0].cls, 'error');
});

/* ---- the clone tab keeps what it was ------------------------------------ */
const ser = (n) => {
    const ds = Object.keys(n.dataset || {}).sort()
        .map(k => 'data-' + k + '=' + n.dataset[k]);
    const at2 = Object.keys(n.attrs || {}).sort().map(k => k + '=' + n.attrs[k]);
    return '<' + n.tagName + ' id=' + (n.id || '') + ' class=' + n.className +
        ' type=' + n.type + ' value=' + n.value +
        ' hidden=' + (n.hidden ? 1 : 0) + ' ph=' + (n.placeholder || '') +
        ' title=' + (n.title || '') + ' open=' + (n.open ? 1 : 0) + ' ' +
        ds.concat(at2).join(',') + '>' + (n.textContent || '') +
        (n.children || []).map(ser).join('') + '</' + n.tagName + '>';
};
// the whole clone tab with the declared TTS-2 deltas stripped, so anything
// else that drifts is a regression: (1) the tab strip — TTS-2 moved TEXT TO
// SPEECH to the front, so the comparison drops that button and normalises
// the remaining two to the old order (the strip itself is pinned by the
// tab-strip test); (2) the data-model focus hook TTS-2 added to every voice
// row; (3) the macOS-voice filter — this fixture store holds no say: row so
// it is inert HERE, and pinned by its own TTS-2 test below; (4) TTS-3 —
// voiceRow dropped the 'urow' class: inside .admin-table it rendered the
// row as a display:grid column stack (the live defect the user reported)
const serCloneTab = (host) => host.children.map(kid => {
    if (kid._classes && kid._classes.has('vc-tabs')) {
        const keep = kid.children
            .filter(b => String(b.textContent).indexOf('TEXT TO SPEECH') < 0)
            .map(ser);
        return '<div class=vc-tabs>' + keep.join('') + '</div>';
    }
    return ser(kid);
}).join('\n').replace(/ data-model=[^ >]*/g, '')
   .replace(/class=urow vc-row/g, 'class=vc-row');

test('CLONED VOICES tab serializes byte-identical to the pre-TTS-1 build', async (t) => {
    let oldSrc = null;
    try {
        // fixed argv, no shell, no interpolation (execFile, not exec)
        oldSrc = require('node:child_process').execFileSync(
            'git', ['show', 'HEAD:omlx_uplift/static/uplift_voices.js'],
            { cwd: path.join(__dirname, '..'), maxBuffer: 64 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    } catch (e) { /* no git available (installed keg) — the residue test below */ }
    const now = await mount({});
    // TTS-2 moved the default tab to TEXT TO SPEECH — land on CLONED the way
    // a user would before comparing (a no-op click on the old baseline)
    now.clickTab && await now.clickTab('CLONED');
    const nowSer = serCloneTab(now.host);
    assert.ok(nowSer.length > 2000, 'the clone panel really did render');
    if (!oldSrc) { t.skip('no git baseline in this checkout'); return; }
    const before = await mount({ src: oldSrc });
    await before.clickTab('CLONED');
    assert.equal(nowSer, serCloneTab(before.host),
        'the clone panel changed only in the declared TTS-2 ways');
});

test('visiting the tts tab leaves ZERO residue in the clone panel', async () => {
    const fresh = await mount({});
    await fresh.clickTab('CLONED');
    const untouched = serCloneTab(fresh.host);
    await fresh.clickTab('TEXT TO SPEECH');
    await fresh.clickTab('CLONED');
    assert.equal(serCloneTab(fresh.host), untouched,
        'clone -> tts -> clone repaints the exact same DOM (no cache bleed)');
    assert.ok(!classes(fresh.host, 'vc-tts').length,
              'the tts box is gone with its tab');
});

test('frozen EN copy: the tf() fallbacks are the contract strings verbatim', async () => {
    // lane C ships these exact strings into 10 locales — a reworded fallback
    // is a silent drift between en.json and the panel
    const h = await mount({});
    await h.clickTab('TEXT TO SPEECH');
    const box = classes(h.host, 'vc-tts')[0];
    const title = box.children[0];
    const hint = box.children[1];
    assert.ok(title._classes.has('mk-title'), 'title uses the box title class');
    assert.ok(hint._classes.has('mk-desc'), 'hint uses the box description class');
    assert.equal(title.textContent, 'TTS MODELS');
    assert.equal(hint.textContent,
        'Every text-to-speech model installed on this server. Built-in '
        + "voices come from the model's own metadata; your custom voices "
        + 'are grouped under their model. SETTINGS opens the same editor '
        + 'as in the model manager.');
    assert.deepEqual(h.tabBtns().map(b => String(b.textContent))[0],
                     'TEXT TO SPEECH');
    const set = classes(h.host, 'vc-tts-set')[0];
    assert.equal(set.textContent, 'SETTINGS');
    const def = defBtn(spkRows(h)[0]);
    assert.equal(def.textContent, 'DEFAULT');
    assert.ok(def._classes.has('se-btn'), 'the lamp is a styled button, not a chip');
    const empty = await mount({ models: [], saySupported: false });
    await empty.clickTab('TEXT TO SPEECH');
    // TTS-3: the (empty) rows container sits between the hint and the
    // message — whitespace-normalised, the WORDING is the contract
    assert.equal(allText(classes(empty.host, 'vc-tts')[0]).trim()
        .replace(/\s+/g, ' '),
        'TTS MODELS Every text-to-speech model installed on this server. '
        + "Built-in voices come from the model's own metadata; your custom "
        + 'voices are grouped under their model. SETTINGS opens the same '
        + 'editor as in the model manager. No TTS model installed — '
        + 'download one in the model manager first.');
});

test('the panel never shows instructions or language (modal-only)', async () => {
    const h = await mount({
        defaults: { 'Qwen3-TTS-1.7B-CustomVoice':
                    { speaker: 'Vivian', instructions: 'read warm',
                      language: 'cs' } } });
    await h.clickTab('TEXT TO SPEECH');
    const text = allText(classes(h.host, 'vc-tts')[0]);
    assert.ok(text.indexOf('read warm') < 0, 'stored instructions stay in the modal');
    assert.equal(classes(h.host, 'vc-tts-sp').filter(
        r => /language|instruction/i.test(allText(r))).length, 0);
});

test('TTS-3: the card/tree geometry lives in uplift.css (CSS LANE closed)', () => {
    // say1's pattern: the row classes are JS, the geometry is the
    // stylesheet's — a re-inline would keep the panel looking right and
    // rot the pin. TTS-3 replaced the flat 38px indent (which .admin-table
    // .urow outranked in practice) with the model-manager card language.
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.ok(/\.vc-card \{ border: 1px solid var\(--edge\)/.test(css),
              '.vc-card frame rule missing from uplift.css');
    assert.ok(/\.vc-tree \{ margin: 2px 10px 8px 24px; \}/.test(css),
              '.vc-tree indent rule missing');
    assert.ok(/\.vc-kid::before \{[^}]*border-left: 3px solid var\(--dim\)/
        .test(css), 'the trunk riser must be 3px square wiring like the mm trunk');
    assert.ok(/\.vc-tree > \.vc-kid:first-child::before \{ top: -12px/.test(css),
              'the first segment stops under the engine line (no stub above)');
    assert.ok(!/\.vc-tts-sp \{ padding-left: 38px; \}/.test(css),
              'the superseded flat indent must not sneak back');
    assert.ok(!/ttsSpeakerRow[\s\S]{0,400}style\.paddingLeft/.test(
        fs.readFileSync(SRC, 'utf8')),
        'no inline paddingLeft crept back into ttsSpeakerRow');
});

/* ---- TTS-2: grouped custom voices, macOS placement, manager jump --------- */
const STORE = [
    { id: 'jake', name: 'Jake', model: 'Qwen3-TTS-1.7B-CustomVoice',
      ref_bytes: 200000, ref_text: 'hello there' },
    { id: 'katka', name: 'Katka', model: 'kokoro-82m', ref_bytes: 50000 },
    // a legacy say:<Name> entry: a SYSTEM voice the store still carries
    { id: 'zuzana', name: 'Zuzana', model: 'say:Zuzana', language: 'cs' },
];
const voiceRows = (h) => classes(h.host, 'vc-tts-voice');

test('tts tab: stored voices group under their model; macOS voices last', async () => {
    const h = await mount({ store: STORE });
    const rows = classes(h.host, 'vc-row');
    const names = rows.map(r => String(r.children[0].textContent));
    assert.deepEqual(names, [
        'Kokoro-82M', 'kokoro-82m:Katka',
        'Qwen3-TTS-1.7B-CustomVoice', 'Uncle_Fu', 'Vivian',
        'Qwen3-TTS-1.7B-CustomVoice:Jake',
        'macOS system voices', 'Zuzana (macOS)'],
        'document order: model, its speakers, its custom voices — then the '
        + 'macOS group (one store, two views: clones stay on their tab too)');
    // only the STORE rows carry the group indent, never the headers or the
    // built-in speakers (those keep vc-tts-sp)
    assert.equal(voiceRows(h).length, 3, 'Katka, Jake, Zuzana are store rows');
    for (const r of voiceRows(h))
        assert.ok(r._classes.has('vc-row'), 'a group voice row is a voice row');
    const mac = classes(h.host, 'vc-tts-mac');
    assert.equal(mac.length, 1, 'one macOS header');
    assert.ok(mac[0]._classes.has('vc-tts-model'),
              'the header rides the model-row geometry');
    assert.equal(classes(mac[0], 'vc-tts-set').length, 0,
                 'the macOS group has no model editor to open');
    // a stored voice row keeps the clone-tab action set, not the speaker one
    const jake = voiceRows(h)[2];
    assert.equal(classes(jake, 'vc-tts-def').length, 0,
                 'a custom voice never lights a DEFAULT speaker lamp');
    assert.equal(classes(jake, 'vc-play').length, 1);
    const labels = classes(jake, 'se-btn').map(b => String(b.textContent));
    assert.ok(labels.includes('EDIT') && labels.includes('DELETE'),
        'edit/delete work right from the group: ' + labels);
    assert.equal(subCounter(h), '3 ' + String.fromCharCode(215),
        'models + the macOS group are what the tab offers');
});

test('tts tab: no macOS group when the store rides no say voice', async () => {
    // TTS-3 SUPERSEDES the TTS-2 rule: the say engine is an ENGINE, so its
    // card rides whenever the server supports it — with an empty pick list
    // — and never otherwise. (The card's children are the per-language
    // defaults/preferreds, pinned in the TTS-3 block below.)
    const h = await mount({ store: STORE.slice(0, 2) });
    assert.equal(classes(h.host, 'vc-tts-mac').length, 1,
                 'a supported engine gets its card even with no rows');
    assert.ok(allText(classes(h.host, 'vc-tts-mac')[0]).includes(
        'No overrides — every language speaks with its macOS default'),
        'the empty card line says so honestly');
    assert.equal(voiceRows(h).length, 2);
    assert.equal(subCounter(h), '3 ' + String.fromCharCode(215));
    const off = await mount({ store: STORE.slice(0, 2), saySupported: false });
    assert.equal(classes(off.host, 'vc-tts-mac').length, 0,
                 'no say engine (Linux): no card, no promise');
    assert.equal(subCounter(off), '2 ' + String.fromCharCode(215));
});

test('CLONED VOICES lists the clones, never the macOS voice', async () => {
    const h = await mount({ store: STORE });
    await h.clickTab('CLONED');
    const text = allText(h.host);
    assert.ok(!/Zuzana/.test(text), 'the say: voice is absent from the clone list');
    assert.ok(text.includes('Qwen3-TTS-1.7B-CustomVoice:Jake'), 'Jake kept');
    assert.ok(text.includes('kokoro-82m:Katka'), 'Katka kept');
    assert.equal(subCounter(h), '2 ' + String.fromCharCode(215),
        'the counter counts what THIS tab lists');
    assert.equal(classes(h.host, 'vc-copy').length, 2,
                 'SAVE AS stays on the clone rows only');
});

test('EDIT from the tts tab opens the voice form above the grouped list', async () => {
    const h = await mount({ store: STORE });
    const jake = voiceRows(h)[2];
    const edit = classes(jake, 'se-btn').find(b => String(b.textContent) === 'EDIT');
    edit.click();
    await settle(); await settle();
    const onBtn = classes(h.host, 'vc-tab').find(b =>
        String(b.textContent).includes('CLONED'));
    assert.ok(!onBtn._classes.has('on'),
              'the tab did NOT flip — the form shows in place');
    const box = classes(h.host, 'vc-add')[0];
    assert.ok(box, 'one shared voiceForm renders atop the tts list');
    assert.ok(allText(box).includes('EDIT VOICE'), 'it opened in EDIT mode');
    assert.equal(classes(h.host, 'vc-tts').length, 1, 'the grouped list survives');
    const cancel = classes(box, 'se-btn').find(b => String(b.textContent) === 'Cancel');
    cancel.click();
    await settle(); await settle();
    assert.equal(classes(h.host, 'vc-add').length, 0, 'Cancel clears the form');
    assert.equal(classes(h.host, 'vc-tts').length, 1, 'the list stays');
});

test('openVoices: the manager jump selects the tab and flashes one row', async () => {
    const h = await mount({ store: STORE });
    h.V.openVoices('clone', 'Qwen3-TTS-1.7B-CustomVoice');
    await settle(); await settle();
    const on = classes(h.host, 'vc-tab').find(b => b._classes.has('on'));
    assert.equal(String(on.textContent), 'CLONED VOICES',
                 'the chip brings up the CUSTOM VOICES tab');
    const lit = classes(h.host, 'vc-row').filter(r => r._classes.has('vc-focus'));
    assert.equal(lit.length, 1, 'exactly the first row of the jumped model flashes');
    assert.ok(String(lit[0].children[0].textContent).includes('Jake'));
    // one-shot: the next repaint carries no stale flash
    h.V.openVoices('clone', null);
    await settle(); await settle();
    assert.equal(classes(h.host, 'vc-row').filter(
        r => r._classes.has('vc-focus')).length, 0);
});

test('openVoices with a voice id arms the edit form (editor EDIT jump)', async () => {
    const h = await mount({ store: STORE });
    h.V.openVoices('clone', 'kokoro-82m', 'katka');
    await settle(); await settle();
    const box = classes(h.host, 'vc-add')[0];
    assert.ok(box, 'the voices-page form opened');
    assert.ok(allText(box).includes('EDIT VOICE'), 'in edit mode for Katka');
    // prefills live in .value, invisible to allText (gate doctrine): walk
    // the inputs and read the field the form fills for an edit
    const inputs = [];
    (function walk(n) { (n.children || []).forEach(c => {
        if (c.tagName === 'input') inputs.push(c); walk(c); }); })(box);
    assert.ok(inputs.some(i => i.value === 'Katka'),
        'the name field is prefilled from the store row');
});

test('no models installed but a macOS voice stored: the TTS tab still lists it', async () => {
    const h = await mount({ models: [], store: [STORE[2]] });
    const box = classes(h.host, 'vc-tts')[0];
    assert.ok(box, 'the box renders — the store is not empty');
    assert.ok(!allText(box).includes('No TTS model installed'),
              'the empty message would be a lie with a row visible');
    assert.deepEqual(classes(box, 'vc-tts-model').map(
        r => String(r.children[0].textContent)), ['macOS system voices']);
    assert.equal(subCounter(h), '1 ' + String.fromCharCode(215));
});

/* ---- TTS-3: cards, the macOS engine card, the system-default chip ------- */
const SAY_VOICES = [
    { name: 'Laura', locale: 'sk-SK', quality: 'standard', installed: true,
      default: true, preferred_for: '', downloaded: false,
      identifier: 'com.apple.voice.compact.sk-SK.Laura' },
    { name: 'Zuzana', locale: 'cs-CZ', quality: 'standard', installed: true,
      default: true, preferred_for: 'cs-CZ', downloaded: false,
      identifier: 'com.apple.voice.super-compact.cs-CZ.Zuzana' },
    { name: 'Iveta', locale: 'cs-CZ', quality: 'enhanced', installed: false,
      default: false, preferred_for: '', downloaded: false, identifier: '' },
    { name: 'Samantha', locale: 'en-US', quality: 'standard', installed: true,
      default: true, preferred_for: '', downloaded: false,
      identifier: 'com.apple.voice.compact.en-US.Samantha' },
    { name: 'Novak', locale: 'fr-FR', quality: 'standard', installed: true,
      default: false, preferred_for: 'fr-FR', downloaded: false,
      identifier: 'com.apple.voice.compact.fr-FR.Thomas' },
];
const MAC_STORE = [
    { id: 'zuzana', name: 'Zuzana', model: 'say:Zuzana', language: 'cs' },
    { id: 'ghost', name: 'Ghost', model: 'say:Ghost', language: 'xx' },
];

test('TTS-3: every engine is a framed card; its voices hang in one tree', async () => {
    const h = await mount({ store: STORE });
    const cards = classes(h.host, 'vc-card');
    assert.equal(cards.length, 3, 'Kokoro, Qwen3 and the macOS engine cards');
    const kidsOf = (c) => classes(c, 'vc-kid');
    assert.equal(classes(cards[0], 'vc-tree').length, 1, 'kids live in THE tree');
    assert.deepEqual(kidsOf(cards[0]).map(r => String(r.children[0].textContent)),
        ['kokoro-82m:Katka'], 'the Kokoro card holds its one clone');
    assert.deepEqual(kidsOf(cards[1]).map(r => String(r.children[0].textContent)),
        ['Uncle_Fu', 'Vivian', 'Qwen3-TTS-1.7B-CustomVoice:Jake'],
        'speakers then clones, model order preserved');
    for (const c of cards)
        assert.ok(!c._classes.has('vc-kid')
                  && !c.children[0]._classes.has('vc-kid'),
                  'the engine line itself is never a kid');
});

test('TTS-3b: the macOS card lists ONLY overrides of the system defaults', async () => {
    // user: 'it should only show non-default settings, not the default
    // voices for the languages' — a default is what macOS already does,
    // not a setting; only a PREFERRED mark that picks a DIFFERENT voice
    // than the default belongs on this tree
    const h = await mount({ store: MAC_STORE, sayVoices: SAY_VOICES });
    const cards = classes(h.host, 'vc-card');
    const mac = cards[cards.length - 1];
    const kids = classes(mac, 'vc-kid');
    assert.deepEqual(kids.map(r => String(r.children[0].textContent)), [
        'Novak · fr-FR',        // the one real override: preferred, NOT the default
        'Zuzana (macOS)',       // her mark mirrors her own default — not a row;
        'Ghost (macOS)'],       // only her legacy STORE voice stands here
        'defaults are nobody\'s setting; Zuzana (default+preferred) and the '
        + 'not-installed Iveta never show — Laura/Samantha (pure defaults) '
        + 'are gone from this card');
    assert.ok(allText(mac).includes('Overrides of macOS defaults: 1'),
              'the header counts what it lists: ' + allText(mac).slice(0, 160));
    assert.ok(!allText(kids[0]).includes('macOS DEFAULT'),
              'an override row is by definition not a default');
    assert.ok(allText(kids[0]).includes('PREFERRED FOR fr-FR'));
});

test('TTS-3b: an override merged with a store row manages itself once', async () => {
    const store = [{ id: 'novak', name: 'Novak', model: 'say:Novak',
                     language: 'fr' }];
    const h = await mount({ store, sayVoices: SAY_VOICES });
    const cards = classes(h.host, 'vc-card');
    const kids = classes(cards[cards.length - 1], 'vc-kid');
    assert.deepEqual(kids.map(r => String(r.children[0].textContent)),
        ['Novak · fr-FR'], 'covered store row does NOT duplicate below');
    const novak = kids[0];
    assert.deepEqual(classes(novak, 'se-btn').map(b => String(b.textContent)),
        ['▶', 'Clear preferred', 'EDIT', 'DELETE'],
        'mark button (lit) plus the store management on ONE line');
    classes(novak, 'se-btn').find(b => String(b.textContent) === 'EDIT').click();
    await settle(); await settle();
    assert.ok(classes(h.host, 'vc-add').length,
              'EDIT opens the shared voice form atop this tab');
    assert.ok(allText(classes(h.host, 'vc-add')[0]).includes('EDIT VOICE'));
});

test('TTS-3b: DELETE on a merged row removes the STORE entry only', async () => {
    const store = [{ id: 'novak', name: 'Novak', model: 'say:Novak',
                     language: 'fr' }];
    const h = await mount({ store, sayVoices: SAY_VOICES });
    const kids = classes(classes(h.host, 'vc-card').pop(), 'vc-kid');
    classes(kids[0], 'se-btn').find(b => String(b.textContent) === 'DELETE')
        .click();
    await settle(); await settle();
    assert.deepEqual(h.st.deletes, ['/uplift/api/voices/novak'],
        'the store id goes to the store route — the system voice itself '
        + 'lives in macOS, not in the delete path');
    assert.equal(h.st.toasts.length, 1, 'one honest toast');
});

test('TTS-3b: no overrides at all: the header admits it, no rows', async () => {
    const h = await mount({ sayVoices: SAY_VOICES.filter(v => !v.preferred_for) });
    const cards = classes(h.host, 'vc-card');
    const mac = cards[cards.length - 1];
    assert.equal(classes(mac, 'vc-kid').length, 0);
    assert.ok(allText(mac).includes(
        'No overrides — every language speaks with its macOS default'),
        allText(mac).slice(0, 200));
});

test('TTS-3: the macOS card reads /voices/say ONCE per visit, like defaults', async () => {
    const h = await mount({});
    const reads = () => h.st.gets.filter(
        u => u.includes('/voices/say')).length;
    await h.clickTab('CLONED');
    await h.clickTab('TEXT TO SPEECH');
    assert.equal(reads(), 1, 're-entering the tab reuses the cached catalog');
});
