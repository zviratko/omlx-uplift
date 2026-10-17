/* VOICE-12 — voice-input settings + push-to-talk decoupled from the chat
   model (vm sandbox, nat4-chat-mount/voice11 harness pattern + VIRTUAL
   CLOCK for the watchdog, fake getUserMedia/AudioContext, fake multipart
   FormData + fake SSE /v1/audio/transcriptions stream).
   Proves (card's Verify list):
   - no input model -> zero mic affordances (optional-surface silence)
   - input model set -> mic visible; mode Off hides it again
   - the settings popover: rows exist, persistence lands in localStorage,
     dropMenu dismiss contract (deferred doc-click re-check, Escape,
     listeners removed on close)
   - language Auto OMITS the form field, 'cs' SENDS it
   - transcript is APPENDED to the composer (read back through the vendor
     shadow #text-input seam), never replacing unsent text
   - auto-send submits through the REAL send path (dc.submitUserMessage
     spy — the same programmaticSubmit the Send button/regenerate use)
   - recording while a reply streams is refused with one toast
   - the 240 s watchdog ends the 'transcribing…' state HONESTLY when the
     transcribe fetch hangs (VOICE-3 doctrine)
   Stub traps honoured: <select> keeps no derived default (the code sets
   .value explicitly — tests assert exactly that value); NO cross-realm
   instanceof on binary parts (the FormData stub stores whatever it gets). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const STT_ID = 'whisper-large-v3-turbo-oQ8';

const CAT = {
    'uplift.chat.stt_title': 'STTTITLE',
    'uplift.chat.stt_input_model': 'INPUTMODEL',
    'uplift.chat.stt_none': 'NONE',
    'uplift.chat.stt_language': 'STTLANG',
    'uplift.chat.stt_auto': 'AUTO',
    'uplift.chat.stt_lang_hint': 'LANGHINT',
    'uplift.chat.stt_autosend': 'STTAUTOSEND',
    'uplift.chat.stt_mode': 'STTMODE',
    'uplift.chat.stt_mode_off': 'MODEOFF',
    'uplift.chat.stt_mode_ptt': 'MODEPTT',
    'uplift.chat.stt_mode_cont': 'MODECONT',
    'uplift.chat.stt_headphone_hint': 'HPHINT',
    'uplift.chat.stt_listening': 'STTLISTEN',
    'uplift.chat.stt_transcribing': 'STTTRANS',
    'uplift.chat.stt_wait_reply': 'STTWAIT',
    'chat.record_audio': 'RECAUDIO',
    'uplift.voices.timeout': 'no answer in {n}s abandoned',
};

function makeHarness(opts) {
    opts = opts || {};
    const byId = {};
    const shadow = { children: [], appendChild(k) { this.children.push(k); return k; },
                     getElementById(id) { return this.children.find(c => c.id === id) || null; } };
    // the vendor composer seam: deep-chat 2.5.1's contenteditable #text-input
    const textInput = mkRaw('div'); textInput.id = 'text-input';
    shadow.appendChild(textInput);
    function mkRaw(tag) {
        const listeners = {};
        const classes = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            className: '', textContent: '', title: '', hidden: false,
            value: '', type: '', name: '', checked: false, disabled: false, _id: '',
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, force) => {
                    const on = force === undefined ? !classes.has(c) : !!force;
                    if (on) classes.add(c); else classes.delete(c);
                    return on;
                },
                contains: (c) => classes.has(c),
            },
            addEventListener(t2, fn) { (listeners[t2] = listeners[t2] || []).push(fn); },
            removeEventListener(t2, fn) {
                const l = listeners[t2] || []; const i = l.indexOf(fn);
                if (i >= 0) l.splice(i, 1);
            },
            dispatch(t2, ev) {
                (listeners[t2] || []).slice().forEach((fn) =>
                    fn.call(el, ev || { target: el, stopPropagation() {} }));
            },
            dispatchEvent(ev) { ev.target = ev.target || el;
                (listeners[ev.type] || []).slice().forEach((fn) => fn.call(el, ev)); },
            replaceChildren(...kids) { this.children = kids; link(this); },
            append(...kids) { kids.forEach(k => { this.children.push(k); }); link(this); },
            appendChild(k) { this.children.push(k); link(this); return k; },
            insertBefore(k) { this.children.unshift(k); link(this); return k; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; },
            remove() { if (this.parentElement) {
                const i = this.parentElement.children.indexOf(this);
                if (i >= 0) this.parentElement.children.splice(i, 1); } },
            focus() {}, blur() {},
            setAttribute(k, v) { this['__attr_' + k] = v; },
            getAttribute(k) { return this['__attr_' + k] == null ? null : this['__attr_' + k]; },
        };
        return el;
    }
    function link(parent) {
        (parent.children || []).forEach(c => { if (c && typeof c === 'object') c.parentElement = parent; });
    }
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = mkRaw('div')); },
        createElement(tag) {
            const e = mkRaw(tag);
            if (tag === 'deep-chat') e.shadowRoot = shadow;
            return e;
        },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        head: { appendChild() {} },
        documentElement: { dataset: {} },
        body: { appendChild() {}, removeChild() {} },
        __doc: {},   // type -> [fn]
        addEventListener(t2, fn) { (this.__doc[t2] = this.__doc[t2] || []).push(fn); },
        removeEventListener(t2, fn) {
            const l = this.__doc[t2] || []; const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        },
        __fire(t2, ev) {
            (this.__doc[t2] || []).slice().forEach(f =>
                f(ev || { type: t2, stopPropagation() {} }));
        },
    };
    // ---- VIRTUAL CLOCK: the watchdog (240 s) and the 60 s record cap are
    // driven by advance(), never by wall time
    let now = 0, seq = 0;
    const timers = new Map();
    function setTimeoutV(fn, ms) {
        const id = ++seq;
        timers.set(id, { at: now + (ms || 0), fn });
        return id;
    }
    function advance(ms) {
        const target = now + ms;
        let guard = 0;
        for (;;) {
            let next = null;
            for (const [id, t] of timers)
                if (t.at <= target && (next === null || t.at < timers.get(next).at)) next = id;
            if (next === null) break;
            const t = timers.get(next);
            timers.delete(next);
            now = Math.max(now, t.at);
            t.fn();
            if (++guard > 5000) throw new Error('timer storm');
        }
        now = target;
    }
    function flushTimers() {   // run every 0-ms timer the realm queued
        advance(0);
    }
    // ---- fake media + transport
    const posts = [], dels = [], toasts = [], sent = [], forms = [];
    let gumCalls = 0;
    const procs = [];
    function FakeAudioContext() {
        this.sampleRate = 48000;
        this.destination = { connect() {}, disconnect() {} };
        this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
        this.createScriptProcessor = () => {
            const p = { connect() {}, disconnect() {}, onaudioprocess: null };
            procs.push(p);
            return p;
        };
        this.close = () => {};
    }
    const fakeStream = { getTracks: () => [{ stop() {} }] };
    // ---- fake SSE stream for /v1/audio/transcriptions (test-released)
    const frames = [], readWaiters = [];
    let streamEnded = false;
    const stream = {
        push(s) { if (readWaiters.length) readWaiters.shift()({ done: false, value: s });
                  else frames.push(s); },
        end() { streamEnded = true; while (readWaiters.length) readWaiters.shift()({ done: true }); },
    };
    function makeReader() {
        return { read() {
            if (frames.length) return Promise.resolve({ done: false, value: frames.shift() });
            if (streamEnded) return Promise.resolve({ done: true });
            return new Promise((res) => readWaiters.push(res));
        } };
    }
    function FormDataStub() {
        const entries = [];
        this.entries = entries;
        this.append = (name, value, filename) =>
            entries.push({ name, value, filename: filename || null });
    }
    function BlobStub(parts, o) { this.parts = parts; this.type = (o || {}).type || ''; }
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: [
                    { id: 'SmolLM2-360M-Instruct-oQ4',
                      engine_type: 'batched', model_type: 'llm' },
                    { id: STT_ID, engine_type: 'audio_stt', model_type: 'audio_stt',
                      name: 'Whisper Large v3 Turbo' },
                    { id: 'whisper-tiny', engine_type: 'audio_stt',
                      model_type: 'audio_stt' }] };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history'))
                    return [{ id: 'c1', title: 'T', model: 'SmolLM2',
                               message_count: 0, updated: 1 }];
                const m = u.match(/\/chat\/history\/(.+)$/);
                if (m) return { id: 'c1', title: 'T', model: 'SmolLM2',
                                systemPrompt: '', messages: [] };
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, body) => { posts.push([String(u), body]); return { status: 'saved' }; },
            deleteJson: async (u) => { dels.push(String(u)); return { ok: 1 }; },
            toast: (text, kind) => { toasts.push([String(text), kind]); },
        },
        Uplift: { state: { API: '' } },
        document,
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {},
        navigator: { mediaDevices: {
            getUserMedia() { gumCalls++; return Promise.resolve(fakeStream); } } },
        AudioContext: FakeAudioContext,
        setTimeout: setTimeoutV,
        clearTimeout: (id) => { timers.delete(id); },
        setInterval: () => 1, clearInterval: () => {},
        prompt: () => null, confirm: () => true,
        AbortController: function () {
            const s = { aborted: false };
            this.signal = s;
            this.abort = () => { s.aborted = true; };
        },
        TextDecoder: function () { this.decode = (v) => String(v); },
        FormData: FormDataStub,
        Blob: BlobStub,
        Event: function (type, o) { this.type = type; Object.assign(this, o || {}); },
        fetch: (url, d) => {
            if (String(url) === '/v1/audio/transcriptions') {
                forms.push(d.body);          // FormDataStub instance (cross-realm safe)
                if (opts.sttHang) return new Promise(() => {});   // never settles
                return Promise.resolve({ ok: true, status: 200,
                                         body: { getReader: makeReader } });
            }
            return Promise.reject(new Error('unexpected fetch: ' + url));
        },
    };
    win.window = win; win.self = win;
    const store = Object.assign({}, opts.localStorage || {});
    win.localStorage = { getItem: (k) => (k in store ? store[k] : null),
                         setItem: (k, v) => { store[k] = String(v); },
                         removeItem: (k) => { delete store[k]; } };
    win.__store = store;
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8'))
        .runInContext(ctx);
    const tick = (n) => new Promise((r) => setTimeout(r, n || 1));
    const h = {
        win, byId, store, posts, toasts, sent, forms, textInput,
        procs, stream, shadow,
        get gumCalls() { return gumCalls; },
        advance, flushTimers,
        async booted() {
            win.UpliftNativeChat.mount();
            for (let i = 0; i < 14; i++) await tick(0);
            return this;
        },
        async flush(n) { for (let i = 0; i < (n || 8); i++) await tick(1); },
        stt() { return win.UpliftNativeChat.stt.settings(); },
        mic() { return byId['chat-native-mic']; },
        // record >=1 s of stubbed mic audio, then arm/disarm the PTT button
        async record(seconds) {
            const M = win.UpliftNativeChat;
            M.stt.start();
            await this.flush();
            const p = this.procs[this.procs.length - 1];
            assert.ok(p && p.onaudioprocess, 'script processor wired');
            const samples = new Float32Array(48000 * (seconds || 2));  // realm-agnostic feed
            p.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
            M.stt.stop();
        },
    };
    return h;
}

const delta = (d) => 'data: ' + JSON.stringify({ type: 'transcript.text.delta', delta: d }) + '\n\n';
const done = (t) => 'data: ' + JSON.stringify({ type: 'transcript.text.done', text: t }) + '\n\n';
function formFields(form) {
    const out = {};
    form.entries.forEach(e => { out[e.name] = e; });
    return out;
}

// ---- (1) optional-surface silence -------------------------------------------
test('VOICE-12: no input model -> zero mic affordances', async () => {
    const h = await makeHarness({}).booted();
    assert.ok(h.byId['chat-native-stt'], 'settings entry exists');
    assert.equal(h.mic().hidden, true, 'mic button stays hidden');
    assert.equal(h.stt().model, '', 'no model persisted');
    assert.equal(h.stt().popen, false, 'no popover open at boot');
    // boot collected the FULL STT rows (id + name) for the select — while
    // the CHAT picker stays text-only (ae5647c, nat4 pins the picker side)
    assert.deepEqual(h.stt().rows, [
        { id: STT_ID, name: 'Whisper Large v3 Turbo' },
        { id: 'whisper-tiny', name: 'whisper-tiny' }]);
});

test('VOICE-12: input model set -> mic visible; mode off hides it', async () => {
    const h = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID } }).booted();
    assert.equal(h.mic().hidden, false, 'mic shows when INPUT MODEL configured');
    const h2 = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID,
                                                   'omlx-uplift-stt-mode': 'off' } }).booted();
    assert.equal(h2.mic().hidden, true, 'mode Off = silent again');
    const h3 = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID,
                                                   'omlx-uplift-stt-mode': 'continuous' } }).booted();
    assert.equal(h3.mic().hidden, false, 'Continuous shows the mic (behaves PTT until VOICE-13)');
});

// ---- (2) popover: rows, persistence, dismiss contract ------------------------
test('VOICE-12: settings popover rows persist and dismiss (dropMenu contract)', async () => {
    const h = await makeHarness({}).booted();
    h.byId['chat-native-stt'].dispatch('click');
    assert.equal(h.stt().popen, true, 'popover opened');
    h.flushTimers();   // the deferred document-dismiss arm
    const ms = h.byId['chat-native-stt-model'];
    const vals = ms.children.map(c => c.value);
    assert.deepEqual(vals, ['', STT_ID, 'whisper-tiny'], 'None + audio_stt rows');
    assert.equal(ms.children[0].textContent, 'NONE', 'None label translated');
    assert.equal(ms.children[1].textContent, 'Whisper Large v3 Turbo', 'display NAME');
    assert.equal(ms.value, '', 'stub-select trap: code sets the value explicitly');
    const ls = h.byId['chat-native-stt-lang'];
    assert.deepEqual(ls.children.map(c => c.value),
        ['', 'en', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh'],
        'Auto + the fixed whisper code list');
    assert.ok(String(ls.parentElement.children[0].title)
              .includes('LANGHINT'), 'language quality hint on the row label');
    assert.equal(h.byId['chat-native-stt-autosend'].checked, false, 'auto-send OFF by default');
    // choosing a model persists + flips the mic gate live
    ms.value = STT_ID; ms.dispatch('change');
    assert.equal(h.store['omlx-uplift-stt-model'], STT_ID, 'key omlx-uplift-stt-model');
    assert.equal(h.mic().hidden, false, 'mic appears without a reload');
    // Escape closes + removes its listeners
    h.win.document.__fire('keydown', { key: 'Escape', stopPropagation() {} });
    assert.equal(h.stt().popen, false, 'Escape closed the popover');
    assert.deepEqual(h.win.document.__doc['click'] || [], [], 'doc click listener removed');
    assert.deepEqual(h.win.document.__doc['keydown'] || [], [], 'doc keydown listener removed');
    // reopen + outside click closes
    h.byId['chat-native-stt'].dispatch('click');
    h.flushTimers();
    h.win.document.__fire('click');
    assert.equal(h.stt().popen, false, 'outside click closed');
    // language + mode + autosend persistence through their controls
    h.byId['chat-native-stt'].dispatch('click');
    h.byId['chat-native-stt-lang'].value = 'cs';
    h.byId['chat-native-stt-lang'].dispatch('change');
    assert.equal(h.store['omlx-uplift-stt-lang'], 'cs', 'key omlx-uplift-stt-lang');
    const as = h.byId['chat-native-stt-autosend'];
    as.checked = true; as.dispatch('change');
    assert.equal(h.store['omlx-uplift-stt-autosend'], '1', 'key omlx-uplift-stt-autosend');
    // mode radios: find the one whose value is 'continuous' by walking the pop
    let radio = null;
    (function walk(e) { if (e.type === 'radio' && e.value === 'continuous') radio = e;
        (e.children || []).forEach(walk); })(h.byId['chat-native']);
    assert.ok(radio, 'Continuous radio exists');
    radio.checked = true; radio.dispatch('change');
    assert.equal(h.store['omlx-uplift-stt-mode'], 'continuous', 'key omlx-uplift-stt-mode');
});

// ---- (3) PTT pipeline ----------------------------------------------------------
test('VOICE-12: PTT -> transcribe(cs) -> transcript APPENDED to composer', async () => {
    const h = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID,
                                                  'omlx-uplift-stt-lang': 'cs' } }).booted();
    h.textInput.textContent = 'draft note';   // unsent user text must survive
    await h.record(2);
    assert.equal(h.forms.length, 1, 'transcription POST fired');
    const f = formFields(h.forms[0]);
    assert.equal(f.model.value, STT_ID, 'model from SETTINGS');
    assert.equal(f.language.value, 'cs', 'language from SETTINGS rides the field');
    const wavPart = f.file.value;            // BlobStub — NO cross-realm instanceof
    assert.equal(f.file.filename, 'microphone-recording.wav');
    assert.equal(wavPart.type, 'audio/wav');
    assert.ok(wavPart.parts[0].byteLength > 44, 'WAV bytes (header + PCM) shipped');
    assert.equal(f.stream.value, 'true', 'SSE stream requested');
    const mic = h.mic();
    assert.equal(mic.classList.contains('busy'), true, 'interim transcribing state');
    assert.ok(mic.title.includes('STTTRANS'), 'button says Transcribing…');
    h.stream.push(delta('Hello there'));
    h.stream.push(done('Hello there general'));
    h.stream.end();
    await h.flush(10);
    assert.equal(h.textInput.textContent, 'draft note Hello there general',
                 'appended after existing text with one space, done-text wins');
    assert.equal(mic.classList.contains('busy'), false, 'interim state ENDED');
    assert.ok(mic.title.includes('RECAUDIO'), 'idle title restored');
    assert.deepEqual(h.sent, [], 'auto-send OFF: nothing submitted');
});

test('VOICE-12: language Auto omits the form field entirely', async () => {
    const h = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID } }).booted();
    await h.record(1);
    const f = formFields(h.forms[0]);
    assert.ok(!('language' in f), 'Auto = no language field (VOICE-5 doctrine)');
    h.stream.push(done('plain')); h.stream.end();
    await h.flush(10);
    assert.equal(h.textInput.textContent, 'plain');
});

test('VOICE-12: auto-send submits through the REAL send path (spy)', async () => {
    const h = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID,
                                                  'omlx-uplift-stt-autosend': '1' } }).booted();
    const sent = [];
    h.win.UpliftNativeChat._state().dc.submitUserMessage = (m) => sent.push(m);
    await h.record(1);
    h.stream.push(done('send me now')); h.stream.end();
    await h.flush(10);
    assert.equal(sent.length, 1,
        'submitUserMessage — programmaticSubmit -> attemptSubmit, the Send '
        + 'button route (same seam regenerate uses)');
    assert.equal(sent[0].text, 'send me now', 'composer content rides the submit');
    assert.equal(h.stt().busy, false, 'busy settled on the done path');
});

test('VOICE-12: recording while a reply streams is refused (half-duplex)', async () => {
    const h = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID } }).booted();
    const M = h.win.UpliftNativeChat;
    await M.shapeRequest({ body: { messages: [{ role: 'user', text: 'x' }] }, headers: {} });
    M.stt.start();
    await h.flush();
    assert.equal(h.gumCalls, 0, 'no capture permission requested');
    assert.equal(h.stt().recording, false, 'mic not armed');
    assert.equal(h.toasts.length, 1, 'exactly ONE toast');
    assert.ok(String(h.toasts[0][0]).includes('STTWAIT'), 'honest refusal');
    assert.equal(h.toasts[0][1], 'error');
});

test('VOICE-12: 240 s watchdog ends the stuck transcribing state honestly', async () => {
    const h = await makeHarness({ sttHang: true,
                                  localStorage: { 'omlx-uplift-stt-model': STT_ID } }).booted();
    await h.record(1);
    assert.equal(h.stt().busy, true, 'hung fetch -> button stuck busy (yet)');
    h.advance(240000);
    assert.equal(h.stt().busy, false, 'watchdog cleared the interim state');
    assert.equal(h.mic().classList.contains('busy'), false, 'live class dropped');
    assert.ok(h.mic().title.includes('RECAUDIO'), 'title back to idle');
    assert.equal(h.toasts.length, 1, 'one honest abandonment toast');
    assert.ok(String(h.toasts[0][0]).includes('240'),
              'timeout budget stated: ' + h.toasts[0][0]);
});
