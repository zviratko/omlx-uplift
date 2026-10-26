/* VOICE-13 — continuous listening over the realtime transcription WebSocket
   (vm sandbox; harness pattern from voice12-stt-settings/nat4-chat-mount +
   the SAME virtual clock, plus a FAKE WEBSOCKET standing in for the omlx
   realtime endpoint and a hand-driven ScriptProcessor tap).
   Proves (card's Verify list):
   - handshake frame shape: {type:'start', model, api_key} with language
     OMITTED on Auto and SENT on 'cs'; binaryType arraybuffer; wss url
   - 16 kHz s16le conversion is byte-exact and clamped (pure function)
   - ~100 ms binary frames flow while armed (10 per second of 48 kHz audio)
   - transcript.delta -> provisional line rendered into the composer
   - >=1 delta + 1.2 s silence -> {type:'stop'} -> transcript.done -> the
     utterance goes through sttDeliver -> a FRESH session reopens after 300 ms
   - a server 'error' frame (model cannot stream) -> SEGMENTED fallback: the
     POST /v1/audio/transcriptions path, never the socket again
   - no 'ready' inside the handshake budget -> ONE notice, NO retry storm
   - echo guard: speak queue busy -> frames dropped + chip steady 'paused',
     resume on drain (+300 ms tail) on a new session
   - teardown: mic toggle, mode change, conversation switch and page unload
     all close the socket; sttDeliver stays the ONE result sink (auto-send
     included)
   - the stuck-engine escape (6 s voiced, zero deltas) restarts, then gives up
     into the segmented fallback instead of looping
   - the 120 s utterance cap forces stop + deliver
   - VOICE-13a(a0): whisper large-class ids NEVER open the realtime socket —
     straight to segmented, one notice
   - VOICE-13a(c): the first ~500 ms calibrate the endpoint gate
     (3x floor, clamped 0.004..0.03); a room above the old fixed 0.01 endpoints
   - PTT (VOICE-12) stop semantics untouched — same suite, same button
   Stub traps honoured: no cross-realm instanceof on binary parts (bytes are
   read with Array.from), and the composer is asserted through the vendor
   shadow #text-input seam exactly like VOICE-12 does. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

// VOICE-13a(a0): realtime tests must run on a tiny-class fixture — the
// client now (correctly!) declines the socket for large-v3-class models,
// exactly the id the pre-13a suite used. LARGE_ID stays for the a0 test.
const STT_ID = 'mlx-community/whisper-tiny-mlx';
const LARGE_ID = 'mlx-community/whisper-large-v3-turbo-4bit';
const CONT = { 'omlx-uplift-stt-model': STT_ID, 'omlx-uplift-stt-mode': 'continuous' };

const CAT = {
    'uplift.chat.stt_listening': 'STTLISTEN',
    'uplift.chat.stt_transcribing': 'STTTRANS',
    'uplift.chat.stt_wait_reply': 'STTWAIT',
    'uplift.chat.stt_headphone_hint': 'HPHINT',
    'uplift.chat.stt_connecting': 'CONNECTING',
    'uplift.chat.stt_paused_echo': 'PAUSEDECHO',
    'uplift.chat.stt_segmented': 'SEGMENTED',
    'uplift.chat.stt_lost': 'LOST',
    'chat.record_audio': 'RECAUDIO',
};

function makeHarness(opts) {
    opts = opts || {};
    const RATE = opts.sampleRate || 48000;
    const byId = {};
    const shadow = { children: [], appendChild(k) { this.children.push(k); return k; },
                     getElementById(id) { return this.children.find(c => c.id === id) || null; } };
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
            dispatch(t2) {
                (listeners[t2] || []).slice().forEach((fn) =>
                    fn.call(el, { target: el, stopPropagation() {} }));
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
        __doc: {},
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
    // ---- VIRTUAL CLOCK: every endpoint / reopen / handshake window is
    // driven by advance(), never by wall time (fake-timer drivable per ticket)
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
            if (++guard > 20000) throw new Error('timer storm');
        }
        now = target;
    }
    function flushTimers() { advance(0); }
    // ---- fake media: ScriptProcessor blocks are fed BY HAND (say())
    const procs = [];
    let gumCalls = 0;
    const fakeStream = { getTracks: () => [{ stop() {} }] };
    function FakeAudioContext() {
        this.sampleRate = RATE;
        this.destination = { connect() {}, disconnect() {} };
        this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
        this.createScriptProcessor = () => {
            const p = { connect() {}, disconnect() {}, onaudioprocess: null };
            procs.push(p);
            return p;
        };
        this.close = () => {};
    }
    // ---- FAKE WEBSOCKET: a scripted realtime server. Records what the
    // client sent (text frames vs BINARY audio frames, kept apart) and lets
    // the test speak as the server on demand.
    const sockets = [];
    function FakeWebSocket(url) {
        const ws = this;
        this.url = url; this.text = []; this.binary = [];
        this.closed = false; this.readyState = 0; this.binaryType = 'blob';
        this.onopen = null; this.onmessage = null; this.onerror = null;
        this.onclose = null;
        sockets.push(ws);
    }
    FakeWebSocket.prototype.send = function (data) {
        if (typeof data === 'string') this.text.push(data);
        else this.binary.push(data);            // Uint8Array audio frame
    };
    FakeWebSocket.prototype.close = function () { this.closed = true; };
    FakeWebSocket.prototype.open = function () {        // transport up
        this.readyState = 1; if (this.onopen) this.onopen(); };
    FakeWebSocket.prototype.msg = function (obj) {      // server speaks
        if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); };
    FakeWebSocket.prototype.ready = function () { this.msg({ type: 'ready' }); };
    FakeWebSocket.prototype.err = function (detail) { this.msg({ type: 'error', detail }); };
    FakeWebSocket.prototype.delta = function (d) { this.msg({ type: 'transcript.delta', delta: d }); };
    FakeWebSocket.prototype.done = function (t) { this.msg({ type: 'transcript.done', text: t }); };
    FakeWebSocket.prototype.drop = function () {        // server died mid-session
        this.readyState = 3; if (this.onclose) this.onclose(); };
    FakeWebSocket.prototype.json = function (i) {       // parsed client frame
        return JSON.parse(this.text[i == null ? 0 : i]); };
    FakeWebSocket.prototype.count = function (obj) {    // client frames like obj
        return this.text.filter(s => {
            try { return JSON.stringify(JSON.parse(s)) === JSON.stringify(obj); }
            catch (e) { return false; }
        }).length;
    };
    // ---- fake SSE stream for the SEGMENTED fallback (VOICE-12 transport)
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
                      name: 'Whisper Tiny' }] };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history'))
                    return [{ id: 'c1', title: 'One', model: 'SmolLM2',
                               message_count: 0, updated: 1 },
                            { id: 'c2', title: 'Two', model: 'SmolLM2',
                               message_count: 0, updated: 2 }];
                const m = u.match(/\/chat\/history\/(.+)$/);
                if (m) return { id: m[1], title: 'T', model: 'SmolLM2',
                                systemPrompt: '', messages: [] };
                throw new Error('no net in tests: ' + u);
            },
            postJson: async () => ({ status: 'saved' }),
            deleteJson: async () => ({ ok: 1 }),
            toast: (text, kind) => { toasts.push(String(text)); },
        },
        Uplift: { state: { API: '' } },
        document,
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const l = winListeners[type] || [];
            const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
        navigator: { mediaDevices: {
            getUserMedia() { gumCalls++; return Promise.resolve(fakeStream); } } },
        AudioContext: FakeAudioContext,
        location: { protocol: opts.protocol || 'https:', host: 'box.test:8011' },
        WebSocket: FakeWebSocket,
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
                forms.push(d.body);
                return Promise.resolve({ ok: true, status: 200,
                                         body: { getReader: makeReader } });
            }
            return Promise.reject(new Error('unexpected fetch: ' + url));
        },
    };
    const toasts = [], forms = [], winListeners = {};
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
        win, byId, store, toasts, forms, textInput, shadow, procs, stream,
        sockets, rate: RATE,
        get gumCalls() { return gumCalls; },
        advance, flushTimers,
        M: () => win.UpliftNativeChat,
        async booted() {
            win.UpliftNativeChat.mount();
            for (let i = 0; i < 14; i++) await tick(0);
            return this;
        },
        async flush(n) { for (let i = 0; i < (n || 8); i++) await tick(1); },
        stt() { return win.UpliftNativeChat.stt.settings(); },
        winListeners,
        mic() { return byId['chat-native-mic']; },
        probe() { return win.UpliftNativeChat.stt.listen.state(); },
        ws(i) { return i == null ? sockets[sockets.length - 1] : sockets[i]; },
        // arm the LISTENER and wait for getUserMedia -> handshake
        async listen() {
            win.UpliftNativeChat.stt.listen.start();
            await this.flush();
            return this.ws();
        },
        // drive the ScriptProcessor tap: `seconds` of constant-amplitude
        // audio at the device rate (0.2 = voiced, 0 = silence under the gate)
        say(seconds, amp) {
            const p = this.procs[this.procs.length - 1];
            assert.ok(p && p.onaudioprocess, 'capture tap wired');
            const n = Math.round(RATE * (seconds || 1));
            const samples = new Float32Array(n).fill(amp == null ? 0.2 : amp);
            p.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
        },
    };
    return h;
}

const sseDelta = (d) => 'data: ' + JSON.stringify({ type: 'transcript.text.delta', delta: d }) + '\n\n';
const sseDone = (t) => 'data: ' + JSON.stringify({ type: 'transcript.text.done', text: t }) + '\n\n';
function formFields(form) {
    const out = {};
    form.entries.forEach(e => { out[e.name] = e; });
    return out;
}

// ---- (1) the pure capture tap ----------------------------------------------
test('VOICE-13: float -> 16 kHz s16le conversion is byte-exact and clamped', async () => {
    const h = await makeHarness({}).booted();
    const pcm = h.M().stt.pcm;
    const in_ = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2, 0.25]);
    const bytes = Array.from(pcm.s16le(in_));
    assert.deepEqual(bytes, [
        0x00, 0x00,             //  0     ->      0
        0xFF, 0x3F,             //  0.5   ->  32767/2 = 16383 (0x3FFF) LE
        0x00, 0xC0,             // -0.5   -> -32768      (0xC000) LE
        0xFF, 0x7F,             //  1     ->  32767      (0x7FFF) LE
        0x00, 0x80,             // -1     -> -32768      (0x8000) LE
        0xFF, 0x7F,             //  2     -> CLAMPED to +1
        0x00, 0x80,             // -2     -> CLAMPED to -1
        0xFF, 0x1F,             //  0.25  ->   8191      (0x1FFF) LE
    ], 'little-endian Int16, same scale as encodeWav');
    // a ramp stays monotonic (the decimator must not fold or skip)
    const n = 48000, ramp = new Float32Array(n);
    for (let i = 0; i < n; i++) ramp[i] = (i / n) * 2 - 1;   // -1 .. +1
    const tap = pcm.tap(48000, 16000, 1600);
    const out = tap.push(ramp);
    assert.equal(out.length, 10, '48000 samples -> exactly ten 100 ms frames');
    assert.equal(out[0].length, 1600);
    assert.equal(out[9][1599] === out[9][1599], true, 'no NaN at the frame edge');
    assert.ok(out[9][1599] > out[0][0], 'the ramp survives the resample');
    let mono = true;
    for (let k = 1; k < out[0].length; k++) if (out[0][k] < out[0][k - 1]) mono = false;
    assert.ok(mono, 'frames are in time order');
    assert.equal(pcm.rms(new Float32Array(0), 0), 0, 'empty frame = silent');
    assert.ok(pcm.rms(new Float32Array(1600).fill(0.2)) > pcm.silenceRms,
              '0.2 amplitude is VOICED against the chosen gate');
    assert.ok(pcm.rms(new Float32Array(1600).fill(0.002)) < pcm.silenceRms,
              'room tone is SILENT against the chosen gate');
});

test('VOICE-13: the tap carries leftovers AND phase across uneven blocks', async () => {
    const h = await makeHarness({}).booted();
    const tap = h.M().stt.pcm.tap(48000, 16000, 1600);
    let got = 0, nan = 0;
    for (let i = 0; i < 15; i++) {                      // 15 x 4096 = 61440
        const fr = tap.push(new Float32Array(4096).fill(1));
        got += fr.length;
        fr.forEach(f => { for (let k = 0; k < f.length; k++)
            if (f[k] !== f[k]) nan++; });
    }
    assert.equal(got, 12, '61440 samples = 1280 ms -> 12 whole frames; the '
        + 'sub-frame remainder and the interpolation phase carry to the next push');
    assert.equal(nan, 0,
        'no frame reads past the buffer — a NaN sample would reach the wire as garbage');
});

// ---- (2) handshake ---------------------------------------------------------
test('VOICE-13: realtime handshake — start frame shape, Auto OMITS language', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    assert.ok(ws, 'a socket was opened');
    assert.equal(ws.url, 'wss://box.test:8011/v1/audio/transcriptions/realtime',
                 'same-origin wss on https, the omlx API mount (not /admin/api)');
    assert.equal(ws.binaryType, 'arraybuffer', 'binary frames = PCM');
    assert.equal(h.probe().state, 'connecting', 'chip: connecting before ready');
    assert.ok(h.mic().title.includes('CONNECTING'), 'chip says Connecting…');
    ws.open();
    const start = ws.json(0);
    assert.equal(start.type, 'start');
    assert.equal(start.model, STT_ID, 'model from the voice-input SETTINGS');
    assert.equal(start.api_key, 'KEY', 'the /chat/key Bearer key rides in-band');
    assert.ok(!('language' in start),
              'Auto = the language FIELD IS ABSENT (VOICE-5 doctrine)');
    ws.ready();
    assert.equal(h.probe().state, 'listening');
    assert.equal(h.mic().classList.contains('rt'), true, 'pulsing chip');
    assert.ok(h.mic().title.includes('STTLISTEN'), 'chip says Listening…');
});

test('VOICE-13: language cs rides the start frame', async () => {
    const h = await makeHarness({ localStorage: Object.assign({ 'omlx-uplift-stt-lang': 'cs' }, CONT) }).booted();
    const ws = await h.listen();
    ws.open();
    assert.deepEqual(ws.json(0),
        { type: 'start', model: STT_ID, api_key: 'KEY', language: 'cs' });
});

test('VOICE-13: ~100 ms binary frames flow while armed', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(1, 0.2);
    assert.equal(ws.binary.length, 10, 'one second of audio = ten frames');
    assert.equal(Array.from(ws.binary[0]).length, 3200, '1600 samples x int16');
    h.say(1, 0);
    assert.equal(ws.binary.length, 20, 'silence is still streamed (the engine decides)');
});

// ---- (3) deltas, endpointing, reopen ---------------------------------------
test('VOICE-13: delta renders a provisional line; silence endpoints -> stop -> done -> deliver -> reopen', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    h.textInput.textContent = 'draft note';      // unsent user text must survive
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(1, 0.2);
    ws.delta('Hello');
    assert.equal(h.probe().prov, 'Hello', 'provisional sink got the delta');
    const span = h.textInput.children.find(c => c.className === 'chat-native-stt-prov');
    assert.ok(span, 'the provisional line is a node in the composer');
    assert.equal(h.textInput.textContent, 'draft note',
                 'the user draft is NOT rewritten by provisional text');
    ws.delta(' there');
    assert.equal(h.probe().prov, 'Hello there');
    // 1.2 s of silence after >=1 delta -> endpoint
    h.say(1, 0);
    assert.equal(ws.count({ type: 'stop' }), 0, '1.0 s is not an endpoint yet');
    h.say(0.2, 0);
    assert.equal(ws.count({ type: 'stop' }), 1, 'silence >= 1.2 s sends stop');
    assert.equal(h.probe().phase, 'finishing');
    ws.done('Hello there general');
    await h.flush();
    assert.equal(h.textInput.textContent, 'draft note Hello there general',
                 'committed text lands through sttDeliver (the single sink)');
    assert.equal(h.probe().prov, '', 'the provisional node is gone after commit');
    assert.equal(ws.closed, true, 'the finished session is closed (engine slot freed)');
    h.advance(300);
    assert.equal(h.sockets.length, 2, 'a FRESH session reopened after ~300 ms');
    assert.equal(h.probe().state, 'connecting');
});

test('VOICE-13: voiced audio with ZERO deltas for ~6 s restarts the session', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(5, 0.2);                          // 50 frames of voice, engine silent
    assert.equal(h.probe().frames, 50, 'one 48 kHz second = ten 100 ms frames');
    assert.equal(h.sockets.length, 1, '5 s is not yet the escape');
    h.say(1, 0.2);                          // the 60th frame trips it
    assert.equal(ws.closed, true, 'stuck engine: its session is dropped');
    assert.equal(h.probe().restarts, 1);
    assert.equal(h.probe().frames, 0, 'the new utterance starts counted fresh');
    h.advance(300);
    assert.equal(h.sockets.length, 2, 'a new session was opened');
    assert.equal(h.probe().text, '', 'the stuck utterance is not half-committed');
    // and it does not restart-loop forever: 4 escapes then the fallback
    const ws2 = h.ws();
    ws2.open(); ws2.ready();
    for (let i = 0; i < 4; i++) { h.say(6, 0.2); h.advance(300); }
    assert.equal(h.stt().transport, 'segmented',
        'a persistently silent engine gets segmented capture, not a restart storm');
    assert.equal(h.sockets.length, 4, 'the socket was abandoned for good: '
        + h.sockets.length + ' sockets for 3 restarts');
});

test('VOICE-13: a 120 s utterance is force-closed and delivered', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('word');                     // got=true: the stuck escape is off
    for (let i = 0; i < 15 && ws.count({ type: 'stop' }) === 0; i++) {
        h.say(10, 0.2);                   // 150 s of unbroken speech
        ws.delta('looooooong-ish word!!');// healthy commit rate (>1 char/s)
    }
    assert.equal(ws.count({ type: 'stop' }), 1, 'the cap forced stop');
    assert.equal(h.probe().frames >= 1200, true, 'capped at ~120 s');
    assert.equal(h.stt().transport, 'realtime',
        'a fast-committing session never sees the UP-9 rate guard');
    ws.done('word');
    await h.flush();
    assert.ok(h.textInput.textContent.includes('word'), 'capped utterance landed');
});

test('UP-9: a committing-but-slowed session is demoted to segmented once', async () => {
    // measured large-v3 cadence ("The" after ~20 s) behind a name the a0
    // regex cannot match: the rate guard must land what was heard and move
    // the whole LISTEN run to segmented — no restart loop, no silence tax
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('The');
    h.say(11, 0.2);
    assert.equal(h.stt().transport, 'realtime', '11 s voiced is still under the window');
    h.say(2, 0.2);                        // 13 s voiced, 3 chars: 0.23 cps
    assert.equal(h.stt().transport, 'segmented', 'the slow-commit guard demotes');
    assert.equal(ws.closed, true, 'the stalled realtime socket is gone for good');
    assert.equal(h.textInput.textContent.includes('The'), true,
        'what was heard is not thrown away on demotion');
    assert.equal(h.probe().restarts, 0, 'a demotion is not a restart');
});

test('VOICE-13: the socket dying mid-session is honest and never retried', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('half a sentence');
    ws.drop();
    assert.equal(h.probe(), null, 'the listener stopped');
    assert.equal(h.toasts.length, 1, 'ONE toast');
    assert.ok(h.toasts[0].includes('LOST'), h.toasts[0]);
    assert.ok(h.textInput.textContent.includes('half a sentence'),
              'already-committed deltas are NOT thrown away');
    assert.equal(h.stt().live, 'idle');
    assert.equal(h.mic().classList.contains('rt'), false, 'chip cleared');
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'no reconnect storm');
});

// ---- (4) segmented fallback -------------------------------------------------
test('VOICE-13: server rejects realtime -> SEGMENTED fallback uses sttTranscribe, not the socket', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open();
    ws.err('Model \'qwen3-asr\' does not support realtime transcription. '
         + 'Use POST /v1/audio/transcriptions with a complete audio file.');
    assert.equal(h.toasts.length, 1, 'the refusal is surfaced once');
    assert.ok(h.toasts[0].includes('SEGMENTED'), h.toasts[0]);
    assert.ok(h.toasts[0].includes('does not support realtime'),
              'the SERVER detail rides the notice (no capability matrix client-side)');
    assert.equal(h.stt().transport, 'segmented');
    assert.equal(ws.closed, true, 'the rejected socket is closed');
    h.say(1, 0.2);                          // speech
    h.say(1, 0);                            // >= 0.8 s silence closes it
    assert.equal(ws.binary.length, 0, 'NO audio over the websocket any more');
    assert.equal(h.forms.length, 1, 'the utterance went to POST /v1/audio/transcriptions');
    const f = formFields(h.forms[0]);
    assert.equal(f.model.value, STT_ID);
    assert.equal(f.stream.value, 'true');
    assert.ok(!('language' in f), 'Auto still omits the field on the fallback too');
    assert.equal(f.file.filename, 'microphone-recording.wav', 'VOICE-12 WAV path reused');
    h.stream.push(sseDone('segment text')); h.stream.end();
    await h.flush();
    assert.ok(h.textInput.textContent.includes('segment text'),
              'the segmented transcript lands in the same composer sink');
    assert.equal(h.stt().busy, false, 'the transcribing interim state ended');
    // and the listener keeps cutting further utterances without a socket
    h.say(1, 0.2); h.say(1, 0);
    assert.equal(h.forms.length, 2, 'next segment captured too');
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'the realtime socket is NEVER reopened after a refusal');
});

test('VOICE-13: no ready inside the handshake budget -> one notice, no retry storm', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open();                       // transport up, server never answers
    assert.equal(h.probe().state, 'connecting');
    h.advance(10000);
    assert.equal(h.toasts.length, 1, 'exactly ONE honest notice');
    assert.ok(h.toasts[0].includes('SEGMENTED'), h.toasts[0]);
    assert.equal(h.stt().transport, 'segmented');
    assert.equal(ws.closed, true);
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'no retry loop against a silent server');
    assert.equal(h.toasts.length, 1, 'still one toast');
});

// ---- (5) echo guard ---------------------------------------------------------
test('VOICE-13: speak queue busy -> frames dropped, chip steady, resume on drain', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const M = h.M();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(1, 0.2);
    ws.delta('dictated bit');
    const before = ws.binary.length;
    let pending = 1;
    const q = { pending: () => pending, played: () => 0, dropped: () => [] };
    assert.equal(M.stt.speakBusy(), false, 'idle queue is not busy');
    M.stt.queueSpeak(q);
    assert.equal(M.stt.speakBusy(), true, 'unsettled chunks = busy');
    h.say(1, 0.2);                   // the frame that notices it
    assert.equal(h.probe().state, 'paused', 'echo guard: paused');
    assert.equal(h.mic().classList.contains('rt'), false, 'chip NOT pulsing');
    assert.equal(h.mic().classList.contains('paused'), true, 'chip steady paused');
    assert.ok(h.mic().title.includes('PAUSEDECHO'), h.mic().title);
    assert.ok(h.textInput.textContent.includes('dictated bit'),
              'the provisional line was committed as-is on pause');
    assert.equal(h.probe().paused, true);
    const framesAtPause = ws.binary.length;
    h.say(2, 0.2); h.say(2, 0.2);
    assert.equal(ws.binary.length, framesAtPause, 'the assistant is NOT transcribed');
    assert.equal(h.sockets.length, 1, 'still one session while paused');
    // queue drains -> resume after the +300 ms tail, on a FRESH session
    pending = 0;
    M.stt.queueSpeak(q);
    h.advance(299);
    assert.equal(h.sockets.length, 1, 'not before the tail elapsed');
    h.advance(1);
    assert.equal(h.sockets.length, 2, 'resumed on a new realtime session');
    const ws2 = h.ws();
    assert.equal(ws.closed, true, 'the paused session was freed for the engine');
    ws2.open(); ws2.ready();
    h.say(1, 0.2);
    assert.equal(ws2.binary.length, 10, 'audio flows again after the resume');
    assert.equal(h.probe().state, 'listening');
});

test('VOICE-13: recording while a reply streams is refused (guard extended)', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const M = h.M();
    await M.shapeRequest({ body: { messages: [{ role: 'user', text: 'x' }] }, headers: {} });
    await h.listen();
    assert.equal(h.gumCalls, 0, 'no capture permission requested');
    assert.equal(h.probe(), null, 'no listener armed');
    assert.equal(h.toasts.length, 1, 'exactly ONE toast');
    assert.ok(h.toasts[0].includes('STTWAIT'), h.toasts[0]);
});

test('VOICE-13: a transport error falls back to segments and never kills the listener', async () => {
    // browsers fire error THEN close; the close of a socket we already
    // replaced must not read as a dropped session (that would stop the mic)
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(1, 0.2);
    ws.onerror();
    ws.drop();                                   // close, as every browser does
    assert.notEqual(h.probe(), null, 'still armed — the listener survived');
    assert.equal(h.stt().transport, 'segmented', 'the socket is not retried');
    assert.equal(h.toasts.length, 1, 'ONE notice for the broken transport');
    h.say(1, 0.2); h.say(1, 0);                  // speak, then pause
    assert.equal(h.forms.length, 1, 'dictation continues over the WAV route');
    h.stream.push(sseDone('still heard')); h.stream.end();
    await h.flush();
    assert.ok(h.textInput.textContent.includes('still heard'));
});

test('VOICE-13: the bare "ready" spelling is accepted too', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open();
    ws.onmessage({ data: 'ready' });              // not {"type":"ready"}
    assert.equal(h.probe().state, 'listening');
    assert.equal(h.toasts.length, 0, 'no false fallback alarm');
});

// ---- (7) settings surface + auto-send ---------------------------------------
test('VOICE-13: the headphones hint is the Continuous row\'s; a mode change tears the listener down', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.byId['chat-native-stt'].dispatch('click');       // open the popover
    h.flushTimers();
    let hint = null;
    const radios = [];
    (function walk(e) {
        if (e.className === 'chat-native-pop-hint') hint = e;
        if (e.type === 'radio') radios.push(e);
        (e.children || []).forEach(walk);
    })(h.byId['chat-native']);
    assert.ok(hint, 'hint row exists');
    assert.equal(hint.hidden, false, 'Continuous SHOWS the headphones line');
    assert.ok(String(hint.textContent).includes('HPHINT'),
              'the VOICE-12 key is reused, no new string for the same advice');
    assert.equal(radios.length, 3, 'Off / Push to talk / Continuous');
    const ptt = radios.find(r => r.value === 'ptt');
    ptt.checked = true; ptt.dispatch('change');
    assert.equal(hint.hidden, true, 'the line is the continuous row\'s, not furniture');
    assert.equal(ws.closed, true, 'mode change closed the realtime socket');
    assert.equal(h.probe(), null, 'and stopped the listener');
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'no reopen under the new mode');
});

test('VOICE-13: auto-send submits the committed utterance through the real send path', async () => {
    const h = await makeHarness({ localStorage: Object.assign(
        { 'omlx-uplift-stt-autosend': '1' }, CONT) }).booted();
    const sent = [];
    h.M()._state().dc.submitUserMessage = (m) => sent.push(m);
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(1, 0.2);
    ws.delta('send this');
    h.say(1.5, 0);                           // endpoint
    assert.equal(ws.count({ type: 'stop' }), 1);
    ws.done('send this');
    await h.flush();
    assert.equal(sent.length, 1,
        'sttDeliver is THE sink — VOICE-12\'s auto-send rule applies verbatim');
    assert.equal(sent[0].text, 'send this');
});

// ---- (8) teardown + PTT untouched ------------------------------------------
test('VOICE-13: conversation switch closes the socket and clears the chip', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('still talking when I left');
    const kids = h.byId['chat-native-convs'].children || [];
    const c1 = kids.flatMap(k => (k.dataset && k.dataset.id !== undefined) ? [k] : (k.children || []))
        .find(c => c.dataset && c.dataset.id === 'c1');
    c1.dispatch('click');   // CHAT-3R: history rows are buttons now
    await h.flush(10);
    assert.equal(ws.closed, true, 'the realtime socket closed on the switch');
    assert.equal(h.probe(), null, 'listener idle again');
    assert.equal(h.stt().live, 'idle');
    assert.equal(h.mic().classList.contains('rt'), false, 'chip cleared');
    assert.equal(h.gumCalls, 1, 'the mic stream was opened once');
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'no ghost reopen after teardown');
});

test('VOICE-13: the mic button toggles off through a FLUSH, then commits', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('one more line');
    h.mic().dispatch('click');           // toggleMic -> listener stop (flush-first)
    assert.ok(ws.count({ type: 'stop' }) === 1,
              'stop rides the LIVE socket so the server flushes the tail');
    assert.equal(h.sockets.length, 1, 'the socket survives just for the flush');
    assert.equal(h.probe().phase, 'finishing', 'the session rides its flush');
    ws.done('one more line');            // the server's flush answer
    assert.equal(h.probe(), null);
    assert.equal(ws.closed, true);
    assert.ok(h.textInput.textContent.includes('one more line'),
              'a deliberate stop keeps the words the user already saw');
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'and nothing reopens behind it');
});

test('VOICE-14 stop-flush: toggling off mid-utterance keeps the tail (mruu report)', async () => {
    // A whole-buffer backend commits ONLY after a pause. The user stops
    // before any pause ever happened: the OLD client halted the socket here
    // and the just-spoken sentence vanished. Now: stop frame -> server
    // close_sync answers -> deliver -> tear down.
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(2, 0.2);                       // speech, no pause: nothing committed yet
    assert.equal(h.probe().text, '', 'no delta before the server endpoint');
    h.mic().dispatch('click');
    assert.equal(ws.count({ type: 'stop' }), 1);
    ws.done('the tail survives');        // close_sync flush over the live socket
    await h.flush();
    assert.equal(h.probe(), null);
    assert.ok(h.textInput.textContent.includes('the tail survives'),
              'the flush result lands through the single sink');
});

test('VOICE-14 stop-flush: a dead server cannot strand the listener', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('heard so far');
    h.mic().dispatch('click');           // stop sent...
    ws.drop();                           // ...but the answer never comes
    assert.equal(h.probe(), null, 'the socket dying mid-flush still tears down');
    assert.ok(h.textInput.textContent.includes('heard so far'),
              'committed deltas survive a flush that dies');
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'no ghost reopen');
});

test('VOICE-14 mruu: the stop-flush wait covers a whole-buffer decode', async () => {
    // Server-side endpointing means a qwen3 answer can arrive seconds after
    // the client's stop frame. The OLD 5 s streaming-tuned wait tore the
    // session down mid-decode and the commit hit a dead socket (mruu field
    // report: fans spinning, dashboard 'transcribing', nothing ever landed).
    const h = await makeHarness({ localStorage: Object.assign({}, CONT,
        { 'omlx-uplift-stt-model': 'mlx-community/Qwen3-ASR-0.6B-6bit' }) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(2, 0.2);
    h.mic().dispatch('click');           // stop sent, server starts decoding
    h.advance(5000);
    assert.notEqual(h.probe(), null,
                    'a whole-buffer session is NOT torn down at the old 5 s mark');
    ws.done('late but landed');          // capped decode answers inside the window
    await h.flush();
    assert.ok(h.textInput.textContent.includes('late but landed'),
              'the slow flush still reaches the composer');
});

test('VOICE-14 mruu: a silent 30 s stalls honestly and tears down', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT,
        { 'omlx-uplift-stt-model': 'mlx-community/Qwen3-ASR-0.6B-6bit' }) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(2, 0.2);
    h.mic().dispatch('click');
    h.advance(29000);
    assert.notEqual(h.probe(), null, 'still waiting at 29 s');
    h.advance(2000);                     // the WB budget expires
    assert.equal(h.probe(), null, 'listener stops — no ghost session, no reopen');
    assert.equal(h.textInput.textContent, '', 'nothing fabricated on timeout');
});

test('VOICE-13: the streaming stop-flush keeps its 5 s budget', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('heard before stop');
    h.mic().dispatch('click');
    h.advance(5000);                     // non-WB: the ORIGINAL short budget
    assert.equal(h.probe(), null, 'streaming models do not inherit the WB wait');
    assert.ok(h.textInput.textContent.includes('heard before stop'));
});

test('VOICE-14: whole-buffer models ride the cap, never the 6 s restart ladder', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT,
        { 'omlx-uplift-stt-model': 'mlx-community/Qwen3-ASR-0.6B-6bit' }) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(8, 0.2);                       // 8 s voiced, zero deltas: tiny would restart
    assert.equal(h.sockets.length, 1, 'no stuck-restart against a whole-buffer backend');
    assert.equal(h.probe().restarts, 0);
    h.say(2, 0);                         // the speaker pauses: server will commit
    ws.delta('after the pause');         // ...and does
    h.say(2, 0);                         // 1.2 s silence after a delta -> endpoint
    assert.equal(ws.count({ type: 'stop' }), 1, 'normal endpointing still works');
});

test('VOICE-13: page unload closes the socket', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    ws.delta('words at unload time');
    assert.ok(h.winListeners.beforeunload, 'beforeunload registered');
    assert.ok(h.winListeners.pagehide, 'pagehide too (iOS Safari does not promise beforeunload)');
    h.winListeners.beforeunload.forEach((fn) => fn({ type: 'beforeunload' }));
    h.winListeners.pagehide.forEach((fn) => fn({ type: 'pagehide' }));
    assert.equal(ws.closed, true, 'the engine session is not orphaned by a closed tab');
    assert.equal(h.probe(), null);
    h.advance(60000);
    assert.equal(h.sockets.length, 1, 'no reopen from a page that is going away');
});

test('VOICE-12 REGRESSION: PTT stop semantics unchanged (continuous OFF)', async () => {
    const h = await makeHarness({ localStorage: { 'omlx-uplift-stt-model': STT_ID } }).booted();
    assert.equal(h.stt().mode, 'ptt', 'default mode is still push to talk');
    h.M().stt.start();
    await h.flush();
    const p = h.procs[h.procs.length - 1];
    p.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(48000 * 2).fill(0.2) } });
    h.M().stt.stop();
    assert.equal(h.sockets.length, 0, 'PTT never touches the realtime socket');
    assert.equal(h.forms.length, 1, 'PTT still POSTs the WAV');
    h.stream.push(sseDone('ptt text')); h.stream.end();
    await h.flush(10);
    assert.equal(h.textInput.textContent, 'ptt text', 'PTT delivers as before');
});

// ---- (9) VOICE-13a: known-broken transport declined + calibrated gate -------
test('VOICE-13a(a0): the transport heuristic names the UP-9 class, nothing else', () => {
    const d = makeHarness({}).M().stt.listen.discouraged;
    assert.equal(d(LARGE_ID), true, 'the measured v3-turbo row');
    assert.equal(d('mlx-community/whisper-large-v3-mlx-4bit'), true, 'the measured v3 row');
    assert.equal(d('whisper-large-v2-8bit'), true, 'same 1280-dim decoder class');
    assert.equal(d('mlx-community/whisper-tiny-mlx'), false, 'tiny streams fine (UP-9)');
    assert.equal(d('Qwen3-ASR-0.6B-MLX-6bit'), false, 'unknown models keep realtime');
    assert.equal(d(''), false); assert.equal(d(undefined), false);
});

test('VOICE-13a(a0): large-class model goes straight to SEGMENTED — no socket, no ladder', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT,
        { 'omlx-uplift-stt-model': LARGE_ID }) }).booted();
    h.M().stt.listen.start();
    await h.flush();
    assert.equal(h.sockets.length, 0,
        'UP-9: the handshake succeeds and then commits nothing — never ask');
    assert.equal(h.stt().transport, 'segmented');
    assert.equal(h.gumCalls, 1, 'the mic still armed: only the transport changed');
    assert.equal(h.toasts.length, 1, 'one honest notice');
    assert.ok(h.toasts[0].includes('SEGMENTED'), h.toasts[0]);
    h.advance(60000);
    assert.equal(h.sockets.length, 0, 'no realtime retry for a discouraged model');
    h.say(1, 0.2); h.say(1, 0);
    assert.equal(h.forms.length, 1, 'the utterance is captured as a segment');
    assert.equal(formFields(h.forms[0]).model.value, LARGE_ID, 'on the chosen model');
});

test('VOICE-13a(c): the room floor calibrates the endpoint gate (3x, clamped)', async () => {
    const mk = async () => {
        const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
        const ws = await h.listen();
        ws.open(); ws.ready();
        return h;
    };
    let h = await mk();
    assert.equal(h.probe().silenceRms, 0.01, 'fixed default until the room is measured');
    h.say(1, 0.005);
    assert.ok(Math.abs(h.probe().silenceRms - 0.015) < 1e-9, '3x the floor');
    h = await mk();
    h.say(1, 0.02);                       // 3x = 0.06 -> clamp
    assert.ok(Math.abs(h.probe().silenceRms - 0.03) < 1e-9, 'gate clamped to 0.03');
    h = await mk();
    h.say(1, 0);                          // dead-quiet room still gets a real gate
    assert.ok(Math.abs(h.probe().silenceRms - 0.004) < 1e-9, 'gate clamped to 0.004');
    h = await mk();
    h.say(0.2, 0.005);                    // sub-window blocks accumulate
    assert.equal(h.probe().silenceRms, 0.01, 'gate unchanged before 500 ms');
    h.say(0.4, 0.005);
    assert.ok(Math.abs(h.probe().silenceRms - 0.015) < 1e-9, 'calibrated once past 500 ms');
});

test('VOICE-13a(c): a room hissing above the old fixed 0.01 gate still endpoints', async () => {
    const h = await makeHarness({ localStorage: Object.assign({}, CONT) }).booted();
    const ws = await h.listen();
    ws.open(); ws.ready();
    h.say(1, 0.015);                      // floor 0.015 -> gate 0.045 -> clamped 0.03
    h.say(1, 0.2);                        // real speech: voiced against 0.03
    ws.delta('hello');
    h.say(2, 0.015);                      // back to ROOM level: silence now —
    assert.equal(ws.count({ type: 'stop' }), 1,  // at the fixed 0.01 gate this was
        'the blob killer: room hiss no longer reads as endless speech');
});
