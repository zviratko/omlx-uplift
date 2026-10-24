/* VOICE-11 auto-speak live turns (vm sandbox, nat4-chat-mount harness
   pattern + dispatchable DOM events, the REAL uplift_speechio.js engine,
   fake AudioContext + fake SSE stream; the voices module is stubbed at
   its speechJson/loadVoices seam — that is the chunk source contract).
   Proves:
   - the first /voices/speech POST fires after the first completed SENTENCE of
     a reply that is ONE long line (VOICE-11a), while the stream is still open
     — and not at turn end, which is all the old line-buffering sanitizer gave
   - chunk mode switches move the boundaries (sentence vs paragraph)
   - every cancel rule bumps the queue token and stale pushes/late
     responses schedule nothing
   - AUTO-SPEAK off issues zero TTS requests (and creates no AudioContext)
     while the manual SPEAK button still reads the whole reply
   - dropped chunks surface the single toast; persistence round-trips */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const VOICE_ID = 'Qwen3-TTS-1.7B:Ana';
const VOICE_ID2 = 'Qwen3-TTS-1.7B:Bo';
const tick = (n) => new Promise((r) => setTimeout(r, n || 1));
async function flush(rounds) {
    for (let i = 0; i < (rounds || 6); i++) await tick(1);
}

function makeHarness(opts) {
    opts = opts || {};
    const byId = {};
    const shadow = { children: [], appendChild(k) { this.children.push(k); return k; },
                     getElementById(id) { return this.children.find(c => c.id === id) || null; } };
    function makeEl(tag) {
        const listeners = {};
        const classes = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            className: '', textContent: '', title: '', hidden: false,
            value: '', type: '', disabled: false, _id: '',
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
                __set: classes,
            },
            addEventListener(t2, fn) { (listeners[t2] = listeners[t2] || []).push(fn); },
            removeEventListener() {},
            dispatch(t2, ev) {
                (listeners[t2] || []).forEach((fn) =>
                    fn.call(el, ev || { target: el, stopPropagation() {} }));
            },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            insertBefore(k) { this.children.unshift(k); return k; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; },
            remove() {}, focus() {}, blur() {},
            setAttribute(k, v) { this['__attr_' + k] = v; },
            getAttribute(k) { return this['__attr_' + k] == null ? null : this['__attr_' + k]; },
        };
        return el;
    }
    const document = {
        __shadow: shadow,
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) {
            const e = makeEl(tag);
            if (tag === 'deep-chat') e.shadowRoot = shadow;
            return e;
        },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        head: { appendChild() {} },
        documentElement: { dataset: {} },
        body: { appendChild() {}, removeChild() {} },
        addEventListener() {},
    };
    const posts = [], dels = [], toasts = [];
    const convs = (opts.convs === undefined
        ? [{ id: 'c1', title: 'T', model: 'SmolLM2', systemPrompt: '', messages: [] },
           { id: 'c2', title: 'Other', model: 'SmolLM2', systemPrompt: '', messages: [] }]
        : opts.convs);
    // ---- chunk source: the voices module stubbed at speechJson/loadVoices
    const speechCalls = [], speechPend = [];
    const voices = {
        loadVoices: async () => [{ id: VOICE_ID, name: 'Ana', model: 'Qwen3-TTS-1.7B' },
                                 { id: VOICE_ID2, name: 'Bo', model: 'Qwen3-TTS-1.7B' }],
        voiceLabel: (v) => v.id,
        speechJson(url, body) {
            const rec = { url, body, done: false };
            speechCalls.push(rec);
            let resolve, reject;
            rec.promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            rec.resolve = (x) => { rec.done = true; resolve(x == null ? { duration: 0.25 } : x); };
            rec.reject = (e) => { rec.done = true; reject(e); };
            speechPend.push(rec);
            if (opts.autoResolve) setImmediate(() => rec.resolve());
            return rec.promise;
        },
    };
    // ---- fake AudioContext: the queue's only playback world
    const ctxInstances = [];
    function FakeCtx() {
        const self = { state: 'suspended', currentTime: 0, sources: [], resumes: 0,
                       destination: { connect() {} } };
        ctxInstances.push(self);
        self.resume = () => { self.state = 'running'; self.resumes++; return Promise.resolve(); };
        self.createBufferSource = () => {
            const src = { buffer: null, started: null, ended: false, stopped: false,
                          onended: null, connect() {}, disconnect() {},
                          start(at) { src.started = at;
                              if (opts.autoEnd !== false)
                                  setTimeout(() => { src.ended = true; if (src.onended) src.onended(); }, 0);
                          },
                          stop() { src.stopped = true; } };
            self.sources.push(src);
            return src;
        };
        return self;
    }
    // ---- fake SSE stream for /v1/chat/completions (test-released frames)
    const frames = [], readWaiters = [];
    let streamEnded = false;
    const stream = {
        push(s) {
            if (readWaiters.length) readWaiters.shift()({ done: false, value: s });
            else frames.push(s);
        },
        end() {
            streamEnded = true;
            while (readWaiters.length) readWaiters.shift()({ done: true });
        },
    };
    function makeReader() {
        return {
            read() {
                if (frames.length) return Promise.resolve({ done: false, value: frames.shift() });
                if (streamEnded) return Promise.resolve({ done: true });
                return new Promise((res) => readWaiters.push(res));
            },
        };
    }
    const win = {
        UpliftCore: { t: (k) => (opts.CAT && opts.CAT[k] != null ? opts.CAT[k] : k) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: [
                    { id: 'SmolLM2', engine_type: 'batched', model_type: 'llm' }] };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history'))
                    return convs.map((c) => ({ id: c.id, title: c.title, model: c.model,
                                               message_count: (c.messages || []).length, updated: 1 }));
                const m = u.match(/\/chat\/history\/(.+)$/);
                if (m) { const c = convs.find((x) => x.id === m[1]); if (c) return c; throw new Error('404'); }
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, body) => { posts.push([String(u), body]); return { status: 'saved' }; },
            deleteJson: async (u) => { dels.push(String(u)); return { ok: 1 }; },
            toast: (text, kind) => { toasts.push([String(text), kind]); },
        },
        Uplift: { state: { API: '' }, voices },
        document,
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {},
        setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
        setInterval: () => 1, clearInterval: () => {},
        prompt: () => null, confirm: () => true,
        AudioContext: FakeCtx,
        AbortController: function () { this.signal = { aborted: false };
                                       const s = this.signal;
                                       this.abort = function () { s.aborted = true; }; },
        TextDecoder: function () { this.decode = (v) => String(v); },
        fetch: (url) => {
            if (String(url) === '/v1/chat/completions')
                return Promise.resolve({ ok: true, body: { getReader: makeReader } });
            return Promise.reject(new Error('unexpected fetch: ' + url));
        },
    };
    win.window = win; win.self = win;
    const store = Object.assign({ 'omlx-uplift-voice': VOICE_ID }, opts.localStorage || {});
    win.localStorage = { getItem: (k) => (k in store ? store[k] : null),
                         setItem: (k, v) => { store[k] = String(v); },
                         removeItem: (k) => { delete store[k]; } };
    const ctx = vm.createContext(win);
    // the REAL VOICE-10 engine first (its UMD tail hangs window.Uplift.speechio)
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_speechio.js`, 'utf8')).runInContext(ctx);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8')).runInContext(ctx);
    return { win, byId, posts, dels, toasts, voices, speechCalls, speechPend,
             ctxInstances, store, stream,
             async booted() {
                 win.UpliftNativeChat.mount();
                 for (let i = 0; i < 12; i++) await tick(0);
                 return this;
             } };
}

// ---- stream helpers ---------------------------------------------------------
const S1 = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo mike one.';
const S2 = 'Lima november oscar papa quebec romeo sierra tango uniform victor whiskey two.';
const S3 = 'Xray yankee zulu alpha bravo charlie delta echo foxtrot golf hotel three.';
function frame(content) {
    return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
}
const REPLY = S1 + '\n' + S2 + '\n\n' + S3;   // two paragraphs, three sentences

async function startTurn(h) {
    const M = h.win.UpliftNativeChat;
    const st = M._state();
    st.conv.messages.push({ role: 'user', content: 'go' });
    await M.shapeRequest({ body: { messages: [{ role: 'user', text: 'go' }] }, headers: {} });
    const signals = { responses: [], closed: 0, stopFns: [],
                      onResponse(r) { this.responses.push(r); },
                      onClose() { this.closed++; },
                      stopClicked: { listener(fn) { signals.stopFns.push(fn); } } };
    let turnDone = false;
    const p = st.dc.connect.handler(null, signals).then(() => { turnDone = true; });
    return { p, signals, done: () => turnDone };
}

// ---- (a) first POST before the turn completes --------------------------------
test('VOICE-11a: TTS fires after the first SENTENCE of a ONE-LINE reply', async () => {
    // VOICE-11a pin, FLIPPED. It used to prove the first boundary on a reply
    // that carried newlines, because createSpeechSanitizer held every line
    // until its '\n' arrived — so the most common short answer, ONE long line,
    // got its first audio at TURN END. Sentence mode promises the first
    // sentence while the model is still writing the second: that is what is
    // asserted here, word-delta by word-delta, with no newline in the reply.
    const h = await makeHarness({
        localStorage: { 'omlx-uplift-autospeak': '1' } }).booted();
    assert.ok(h.byId['chat-native-autospeak'], 'AUTO-SPEAK toggle rendered');
    assert.ok(h.byId['chat-native-speak-chunk'], 'chunk mode select rendered');
    const turn = await startTurn(h);
    const w1 = S1.split(' '), w2 = S2.split(' '), w3 = S3.split(' ');
    for (const w of w1) h.stream.push(frame(w + ' '));
    await flush(10);
    assert.equal(turn.done(), false, 'the stream is still open');
    assert.equal(h.speechCalls.length, 0,
                 'the first sentence is complete on screen but unconfirmed: a '
                 + 'boundary is only honoured once one character past it arrives');
    h.stream.push(frame(w2[0] + ' '));
    await flush();
    assert.equal(turn.done(), false, 'the turn is still streaming');
    assert.equal(h.speechCalls.length, 1, 'first chunk POSTed at the first SENTENCE');
    assert.equal(h.speechCalls[0].url, '/voices/speech');
    assert.equal(h.speechCalls[0].body.voice, VOICE_ID, 'saved composite voice rides the body');
    assert.equal(h.speechCalls[0].body.input, S1, 'exactly the completed sentence, floor honoured');
    for (const w of w2.slice(1)) h.stream.push(frame(w + ' '));
    h.stream.push(frame(w3[0] + ' '));
    await flush(10);
    assert.equal(turn.done(), false, 'still streaming when the second chunk fires');
    assert.equal(h.speechCalls.length, 2, 'the second sentence cuts the same way');
    assert.equal(h.speechCalls[1].body.input, S2, 'no overlap, no gap');
    for (const w of w3.slice(1)) h.stream.push(frame(w + ' '));
    h.stream.end();
    await turn.p;
    await flush(10);
    assert.deepEqual(h.speechCalls.map((c) => c.body.input), [S1, S2, S3],
                     'one chunk per sentence; only the tail waits for turn end');
    assert.deepEqual(h.toasts, [], 'clean read: no toast');
});

// ---- (a2) suppression survives the live wiring ------------------------------
test('VOICE-11a2: a fenced reply streams its prose and never a line of code', async () => {
    // the fence body carries sentence ends ('note. more.') and the prose is one
    // line per sentence: the provisional cut must consult the fence state, so
    // the first SENTENCE goes out while not one CODE WORD ever does.
    const h = await makeHarness({
        localStorage: { 'omlx-uplift-autospeak': '1' } }).booted();
    const turn = await startTurn(h);
    const code = 'print("zebra_secret = 1.5; # note. more.")';
    for (const w of S1.split(' ')) h.stream.push(frame(w + ' '));
    h.stream.push(frame('\n\n```python\n' + code + '\n```\n\n'));
    for (const w of S2.split(' ')) h.stream.push(frame(w + ' '));
    await flush(10);
    assert.equal(turn.done(), false, 'still streaming');
    assert.ok(h.speechCalls.length >= 1, 'the prose cut mid-stream anyway');
    const said = h.speechCalls.map((c) => c.body.input).join(' ');
    assert.ok(!/zebra_secret|print\(|```/.test(said), 'no code reached the TTS: ' + said);
    h.stream.end();
    await turn.p;
    await flush(10);
    const all = h.speechCalls.map((c) => c.body.input).join(' ');
    assert.ok(!/zebra_secret|print\(|```/.test(all), 'and none after the flush either');
    assert.ok(all.indexOf(S1) >= 0 && all.indexOf(S2) >= 0, 'both prose sentences spoken');
});

// ---- (b) chunk mode changes the boundaries -----------------------------------
test('VOICE-11b: paragraph mode cuts at the blank line, sentence at the period', async () => {
    // sentence mode (see 11a): chunk1 = S1 alone.
    // paragraph mode: chunk1 = S1 + S2, cut only where the blank line is.
    const h = await makeHarness({
        localStorage: { 'omlx-uplift-autospeak': '1', 'omlx-uplift-speak-chunk': 'paragraph' },
        autoEnd: false }).booted();
    assert.equal(h.win.UpliftNativeChat._speak().chunk, 'paragraph', 'persisted mode read back');
    const turn = await startTurn(h);
    h.stream.push(frame(S1 + '\n' + S2 + '\n'));
    await flush();
    assert.equal(h.speechCalls.length, 0, 'a single newline is NOT a paragraph boundary');
    h.stream.push(frame('\n' + S3));
    await flush();
    assert.equal(h.speechCalls.length, 1, 'blank-line run cuts mid-turn');
    assert.equal(h.speechCalls[0].body.input, S1 + ' ' + S2,
                 'paragraph chunk joins its wrapped line');
    h.stream.end();
    await turn.p;
    await flush(10);
    assert.equal(h.speechCalls.length, 2, 'tail = the last paragraph');
    assert.equal(h.speechCalls[1].body.input, S3);
});

// ---- (c) every cancel rule stops the queue; stale work schedules nothing -----
function pendingPlaybackHarness() {
    return makeHarness({
        localStorage: { 'omlx-uplift-autospeak': '1', 'omlx-uplift-speak-chunk': 'paragraph' },
        autoEnd: false });   // nothing auto-ends: a live source stays live
}
async function armSpeech(h, turn) {
    // get one chunk LOADED (POST pending) + the session live
    h.stream.push(frame(S1 + '\n' + S2 + '\n\n' + S3));
    await flush();
    assert.equal(h.speechCalls.length, 1, 'chunk POST in flight');
    const q = h.win.UpliftNativeChat._speak().q;
    return { q, token0: q.token() };
}

const CANCEL_RULES = {
    'stop button': async (h) => {
        (await h.__turn).signals.stopFns.forEach((fn) => fn());
    },
    'new user message': async (h) => {
        h.win.UpliftNativeChat._state().dc.onMessage({ message: { role: 'user', text: 'next' } });
    },
    'conversation switch': async (h) => {
        // CHAT-3R: the picker became the left history LIST — switching is a
        // click on the conversation row (dataset.id), not a select change.
        const item = (h.byId['chat-native-convs'].children || [])
            .find(c => c.dataset && c.dataset.id === 'c1');
        item.dispatch('click');
        // UP-34: switch settles the live stream (80ms) before the cancel body
        await new Promise((r) => setTimeout(r, 150));
        await flush();
    },
    'new chat button': async (h) => {
        h.byId['chat-native-new'].dispatch('click');   // CHAT-3R: stable id
        await new Promise((r) => setTimeout(r, 150));   // UP-34 settle
        await flush();
    },
    'voice picker change': async (h) => {
        const sel = h.byId['chat-native-voice'];
        sel.value = VOICE_ID2;
        sel.dispatch('change');
    },
    'autospeak toggled off': async (h) => {
        h.byId['chat-native-autospeak'].dispatch('click');
        assert.equal(h.store['omlx-uplift-autospeak'], '0', 'toggle persists off');
    },
};
for (const name of Object.keys(CANCEL_RULES)) {
    test('VOICE-11c cancel rule: ' + name, async () => {
        const h = pendingPlaybackHarness();
        await h.booted();
        const turn = await startTurn(h);
        h.__turn = turn;
        const { q, token0 } = await armSpeech(h, turn);
        await CANCEL_RULES[name](h);
        assert.equal(q.token(), token0 + 1, 'cancel bumped the queue token');
        // late server response for the pre-cancel chunk: stale -> schedules nothing
        h.speechPend[0].resolve();
        await flush(10);
        assert.equal(h.ctxInstances[0].sources.length, 0,
                     'a late chunk never reaches the audio graph');
        // stale pushes after the cancel schedule nothing
        h.stream.push(frame(S3 + ' more.'));
        await flush();
        assert.equal(h.speechCalls.length, 1, 'post-cancel deltas issue no new TTS request');
        h.stream.end();
        await turn.p;
        await flush(10);
        assert.deepEqual(h.toasts, [], 'cancelled speech never toasts');
    });
}

// ---- (d) toggle off: no requests at all; manual SPEAK still works ------------
test('VOICE-11d: AUTO-SPEAK off streams silently, manual SPEAK reads the reply', async () => {
    const h = await makeHarness({}).booted();      // default OFF
    const turn = await startTurn(h);
    h.stream.push(frame(S1 + '\n' + S2 + '\n'));
    await flush();
    h.stream.end();
    await turn.p;
    await flush(10);
    assert.equal(h.speechCalls.length, 0, 'no TTS requests while off');
    assert.equal(h.ctxInstances.length, 0, 'no AudioContext is even built while off');
    // the per-message SPEAK bubble button follows the chunk strategy too:
    // default sentence mode cuts the reply like the auto-read does
    const M = h.win.UpliftNativeChat;
    const st = M._state();
    st.conv.messages.push({ role: 'assistant', content: REPLY });
    const btn = { classList: { add() {}, remove() {} } };
    M._msgActions.speak(st.conv.messages.length - 1, btn);
    assert.deepEqual(h.speechCalls.map((c) => c.body.input), [S1, S2, S3],
                     'manual SPEAK follows the configured sentence chunking');
    assert.equal(h.ctxInstances.length, 1, 'the queue built its context on the click');
    assert.equal(h.ctxInstances[0].resumes, 1, 'resume ran inside the gesture');
});

test('VOICE-14: manual SPEAK honours the paragraph strategy (was one blob)', async () => {
    const h = await makeHarness({
        localStorage: { 'omlx-uplift-speak-chunk': 'paragraph' } }).booted();
    const M = h.win.UpliftNativeChat;
    const st = M._state();
    st.conv.messages.push({ role: 'assistant', content: REPLY });
    const btn = { classList: { add() {}, remove() {} } };
    M._msgActions.speak(st.conv.messages.length - 1, btn);
    assert.equal(h.speechCalls.length, 2, 'two paragraphs, two synthesize steps');
    assert.equal(h.speechCalls[0].body.input, S1 + ' ' + S2,
                 'first paragraph is POSTed while the second still queues');
    assert.equal(h.speechCalls[1].body.input, S3);
});

// ---- (d2) failed chunks: one retry, skip, the single toast --------------------
test('VOICE-11d2: dropped chunks surface the single toast (played:0 not silent)', async () => {
    const h = await makeHarness({
        localStorage: { 'omlx-uplift-autospeak': '1', 'omlx-uplift-speak-chunk': 'paragraph' },
        autoEnd: false }).booted();
    const turn = await startTurn(h);
    h.stream.push(frame(S1 + '\n' + S2 + '\n\n' + S3));
    await flush();
    assert.equal(h.speechCalls.length, 1);
    h.speechPend[0].reject(new Error('synth down'));
    await flush();
    assert.equal(h.speechCalls.length, 2, 'failed chunk retried exactly once');
    h.speechPend[1].reject(new Error('synth down'));
    await flush();
    assert.equal(h.speechCalls.length, 2, 'second failure = skip, no third try');
    h.stream.end();
    await turn.p;
    await flush();
    assert.equal(h.speechCalls.length, 3, 'flushed tail went through the same queue');
    h.speechPend[2].reject(new Error('synth down'));
    await flush();
    h.speechPend[3].reject(new Error('synth down'));
    await flush(10);
    const failToasts = h.toasts.filter((x) => /chunks were skipped/.test(x[0]));
    assert.equal(failToasts.length, 1, 'exactly one dropped toast: ' + JSON.stringify(h.toasts));
    assert.equal(failToasts[0][0], '2 audio chunks were skipped');
});

// ---- (e) persistence round-trip ----------------------------------------------
test('VOICE-11e: toggle + chunk mode persist and restore', async () => {
    const h = await makeHarness({}).booted();
    const btn = h.byId['chat-native-autospeak'];
    const sel = h.byId['chat-native-speak-chunk'];
    assert.ok(!btn.classList.contains('on'), 'off by default');
    assert.equal(sel.value, 'sentence', 'default mode selected (first-option fallback)');
    btn.dispatch('click');
    sel.value = 'line';
    sel.dispatch('change');
    assert.equal(h.store['omlx-uplift-autospeak'], '1');
    assert.equal(h.store['omlx-uplift-speak-chunk'], 'line');
    const h2 = await makeHarness({ localStorage: {
        'omlx-uplift-autospeak': '1', 'omlx-uplift-speak-chunk': 'line' } }).booted();
    assert.ok(h2.byId['chat-native-autospeak'].classList.contains('on'), 'on-state restored');
    assert.equal(h2.byId['chat-native-speak-chunk'].value, 'line', 'mode restored');
    assert.deepEqual(h2.win.UpliftNativeChat._speak(), { gen: 0, q: null, mode: null,
                                                          on: true, chunk: 'line' });
});

// ---- i18n re-resolution contract (U59) ----------------------------------------
test('VOICE-11: new toolbar labels carry the dataset.i18n + dataset.en markers', async () => {
    const h = await makeHarness({}).booted();     // identity t(): fallbacks render
    const btn = h.byId['chat-native-autospeak'];
    // ROUND 14: the toggle shrank to 'Auto' — it shares the 'Speak' line
    // with the voice picker now; the meaning stays in the title hint.
    assert.equal(btn.textContent, 'Auto');
    assert.equal(btn.dataset.i18n, 'uplift.chat.auto');
    assert.equal(btn.dataset.en, 'Auto', 'repair marker = the rendered fallback');
    const sel = h.byId['chat-native-speak-chunk'];
    const opt = (sel.children || [])
        .find((o) => o.dataset.i18n === 'uplift.chat.speak_chunk_paragraph');
    assert.ok(opt && opt.dataset.en === 'Paragraph', 'option carries the repair marker');
    assert.equal(sel.dataset.i18nTitle, 'uplift.chat.speak_chunk_hint',
                 'tooltip follows the i18n-title contract');
    assert.equal(btn.dataset.i18nTitle, 'uplift.chat.autospeak_hint');
});
