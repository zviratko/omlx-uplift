// CHAT-SPEAK-ROUTE (user 2026-10-28): the native chat's read-aloud can now
// ask the VANILLA server (POST /v1/audio/speech) instead of uplift's own voice
// engine, selected per chat page next to the Chunk control.
// Pins: the stored default, the picker-row -> OpenAI-shaped call mapping for a
// macOS row / a model row / a row the catalog lost, the single transport seam
// for both doors, and that BOTH queues share one request builder so a route
// flip can never make the live turn and a replayed bubble disagree.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chatSource } = require('./static-src.cjs');

const SRC = chatSource();
function grab(start, end) {
    const a = SRC.indexOf(start);
    assert.ok(a >= 0, 'missing ' + start);
    const b = SRC.indexOf(end, a);
    assert.ok(b > a, 'missing end ' + end);
    return SRC.slice(a, b);
}

const CODE = [
    'var ROUTE_KEY = "omlx-uplift-speak-route";',
    'var _key = "", _voicesCache = [], _currentVoice = "", _V = null;',
    // SPLIT-3: the read-aloud part reads core state through CORE getters
    'var CORE = { get _key() { return _key; } };',
    'var _store = {};',
    'var W = () => ({ localStorage: { getItem: k => (k in _store ? _store[k] : null) } });',
    'function chatVoiceId() { return _currentVoice; }',
    'function VOI() { return _V; }',
    'var _calls = [];',
    'var _fetchImpl = function (u, o) { _calls.push([u, o]);'
        + ' return Promise.resolve("fetched"); };',
    'function fetch(u, o) { return _fetchImpl(u, o); }',
    grab('function speakRoute()', 'function SIO()'),
    grab('function voiceRowById', 'function ensureSpeakQueue'),
    // the 4096 ceiling the plan applies before either door sees a chunk
    grab('function capChunks', 'function planChunks'),
    // chunkSource's own seams, stubbed: this test is about which door it asks
    'function memGet() { return null; }',
    'function rememberAudio(text, r) { return r; }',
    'function errText(e) { return (e && e.name) ? String(e.name) : ""; }',
    'function C() { return { errorText: function (j) {'
        + ' return (j && j.error && j.error.message) || \'\'; } }; }',
    grab('function chunkSource', 'function rememberAudio'),
    grab('function memKey', 'function memGet'),
].join('\n');

const ROUTE = 'omlx-uplift-speak-route';
const sandbox = { JSON, Math, Date, String, Number, Object, Array, Promise,
    Error, exports: {} };
vm.createContext(sandbox);
vm.runInContext(CODE + '\nexports.api = () => ({ speakRoute, voiceRowById, '
    + 'vanillaSpeechCall, vanillaSpeechFetch, speakRequestFor, speakTransport, '
    + 'chunkSource, memKey, capChunks, macosSayVoice });',
    sandbox);
const api = vm.runInContext('exports.api()', sandbox);
const _calls = () => vm.runInContext('_calls', sandbox);
const set = (src) => vm.runInContext(src, sandbox);
const store = (v) => set('_store = ' + JSON.stringify(v));
const voices = (list, picked) =>
    set('_voicesCache = ' + JSON.stringify(list) + '; _currentVoice = '
        + JSON.stringify(picked || (list[0] || {}).id || '') + ';');

const SAY_ROW = { id: 'zuzana', name: 'Zuzana',
    model: 'say:com.apple.voice.premium.cs-CZ.Zuzana' };
const MODEL_ROW = { id: 'aiden', name: 'aiden', model: 'mlx-community--Qwen3-TTS' };

test('route defaults to uplift and only reads "vanilla" from storage', () => {
    store({});                       assert.strictEqual(api.speakRoute(), 'uplift');
    store({ [ROUTE]: 'vanilla' });   assert.strictEqual(api.speakRoute(), 'vanilla');
    store({ [ROUTE]: 'nonsense' });  assert.strictEqual(api.speakRoute(), 'uplift');
});

/* The swap (omlx-tts-say retired, upstream PR #5076 vendored as
   omlx-tts-macos-say) means the vanilla door no longer understands uplift's
   'say:<tail>' token: it has ONE model id and takes the voice in `voice`.
   These rows are the real store shapes on the devbox, not invented ones. */
test('a macOS row maps onto the vanilla engine\'s single model id', () => {
    store({ [ROUTE]: 'vanilla' });
    voices([{ id: 'zuzana', name: 'Zuzana', model: 'say:Zuzana' }]);
    const call = api.vanillaSpeechCall('zuzana', 'Ahoj.');
    assert.strictEqual(call.url, '/v1/audio/speech');
    assert.strictEqual(call.body.model, 'macos-say');
    assert.strictEqual(call.body.voice, 'Zuzana');
    assert.strictEqual(call.body.input, 'Ahoj.');
    assert.strictEqual(call.body.response_format, 'wav');
});

test('a full AV identifier travels intact (say accepts it like a name)', () => {
    voices([SAY_ROW]);
    const call = api.vanillaSpeechCall('zuzana', 'Ahoj.');
    assert.strictEqual(call.body.model, 'macos-say');
    assert.strictEqual(call.body.voice, 'com.apple.voice.premium.cs-CZ.Zuzana');
});

test('a locale cannot travel on that door, so no voice is claimed', () => {
    // 'say:<name>:<locale>' is uplift addressing; the OpenAI request has no
    // language field, so the name goes and the engine's own autodetect decides
    voices([{ id: 'e', name: 'Eloquence', model: 'say:Eloquence:cs-CZ' }]);
    assert.strictEqual(api.vanillaSpeechCall('e', 'Čau.').body.voice, 'Eloquence');
    // a locale-only tail names no voice at all -> bare model, never a 400
    voices([{ id: 'cs', name: 'Czech', model: 'say:cs-CZ' }]);
    const bare = api.vanillaSpeechCall('cs', 'Čau.');
    assert.strictEqual(bare.body.model, 'macos-say');
    assert.ok(!('voice' in bare.body), 'a locale is not a voice name');
    // bare 'say' (SAY-2) likewise
    voices([{ id: 's', name: 'System', model: 'say' }]);
    assert.ok(!('voice' in api.vanillaSpeechCall('s', 'Hi').body));
});

test('a model row is unaffected by the macOS mapping', () => {
    voices([MODEL_ROW]);
    const call = api.vanillaSpeechCall('aiden', 'Hello.');
    assert.strictEqual(call.body.model, 'mlx-community--Qwen3-TTS');
    assert.strictEqual(call.body.voice, 'aiden');
    assert.notStrictEqual(call.body.model, 'macos-say');
});

/* The vanilla door rejects input over 4096 characters; the plan is built once
   and a route flip mid-read must never hand it an oversized chunk. */
test('plan chunks stay under the vanilla door\'s input cap', () => {
    const long = 'word '.repeat(1500);            // 7500 chars, one 'sentence'
    const out = api.capChunks([long]);            // no arg = the door's own cap
    assert.ok(out.length >= 2, 'a 7500-char chunk is split, not sent');
    assert.ok(out.every(c => c.length <= 4096), out.map(c => c.length).join(','));
    assert.strictEqual(out.join(' ').replace(/\s+/g, ' ').trim(),
        long.trim(), 'nothing is lost or duplicated by the split');
    // Array.from: capChunks returns a cross-realm Array from the vm sandbox,
    // and deepStrictEqual compares prototypes, so the vm's [] !== the test's []
    assert.deepStrictEqual(Array.from(api.capChunks(['short one.', 'two.'], 4096)),
        ['short one.', 'two.'], 'normal chunks pass through untouched');
    const nospace = 'x'.repeat(9000);
    assert.ok(api.capChunks([nospace], 4096).every(c => c.length <= 4096),
        'no word break still cannot exceed the cap');
});

test('a stored or model row splits into {model, voice}', () => {
    voices([MODEL_ROW]);
    const call = api.vanillaSpeechCall('aiden', 'Hello.');
    assert.strictEqual(call.body.model, 'mlx-community--Qwen3-TTS');
    assert.strictEqual(call.body.voice, 'aiden');
});

test('a row the catalog lost is sent as named, never guessed', () => {
    voices([SAY_ROW]);
    const call = api.vanillaSpeechCall('vanished', 'Hello.');
    assert.strictEqual(call.body.model, 'vanished');
    assert.ok(!('voice' in call.body));
});

test('one request builder answers for both doors', () => {
    voices([SAY_ROW]);
    store({});
    // (the vm hands back its own objects, so compare plain data)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(api.speakRequestFor('chunk A'))),
        { url: '/voices/speech', body: { voice: 'zuzana', input: 'chunk A' } });
    store({ [ROUTE]: 'vanilla' });
    assert.strictEqual(api.speakRequestFor('chunk A').url, '/v1/audio/speech');
});

test('the transport adds the Bearer key only on the /v1 door', async () => {
    set('_key = "sk-test"; _calls = [];');
    set('_fetchImpl = function (u, o) { _calls.push([u, o]);'
        + ' return Promise.resolve({ ok: true, status: 200 }); };');
    await api.speakTransport('/v1/audio/speech', { model: 'say', input: 'x' });
    assert.strictEqual(_calls().length, 1);
    const [url, opts] = _calls()[0];
    assert.strictEqual(url, '/v1/audio/speech');
    assert.strictEqual(opts.headers.Authorization, 'Bearer sk-test');
    assert.strictEqual(JSON.parse(opts.body).model, 'say');
    voices([SAY_ROW]);
    store({});
    set('_V = { speechJson: (u) => { return "uplift:" + u; } };');
    assert.strictEqual(api.speakTransport('/voices/speech', {}), 'uplift:/voices/speech');
});

test('the primary per-chunk path honours the door too', async () => {
    set(`_fetchImpl = function (u, o) { _calls.push([u, o]);
        return Promise.resolve({ ok: true, status: 200 }); };`);
    // chunkSource is what actually feeds a streamed turn (the queue legs are
    // the fallback); a route that only moved the fallback would be a lie
    voices([SAY_ROW]);
    set('_calls = [];');
    store({});
    await api.chunkSource({ conv: 'c1', msg: 'm1' }, 'uplift chunk')();
    assert.strictEqual(_calls().length, 0, 'uplift door never hits fetch here');
    store({ [ROUTE]: 'vanilla' });
    const src = api.chunkSource({ conv: 'c1', msg: 'm1' }, 'vanilla chunk');
    const res = await src();
    assert.strictEqual(_calls().length, 1, 'vanilla door issues the request');
    const [url, opts] = _calls()[0];
    assert.strictEqual(url, '/v1/audio/speech');
    assert.strictEqual(JSON.parse(opts.body).input, 'vanilla chunk');
    assert.strictEqual(res.ok, true, 'the source keeps the Response contract');
});

test('the vanilla call pins WAV, the format both doors already speak', () => {
    voices([SAY_ROW]);
    const body = api.vanillaSpeechCall('zuzana', 'x').body;
    assert.strictEqual(body.response_format, 'wav');
    voices([MODEL_ROW]);
    assert.strictEqual(api.vanillaSpeechCall('aiden', 'x').body.response_format, 'wav');
});

test('a refusal at the vanilla door surfaces as the server message', async () => {
    // the speech queue only ever looks at bytes: hand it a 400 body and the
    // listener gets a broken clip instead of the reason
    set(`_fetchImpl = async () => ({ ok: false, status: 400, statusText: 'Bad Request',
        json: async () => ({ error: { message: 'macOS speech is switched off' } }) });`);
    await assert.rejects(() => api.vanillaSpeechFetch('/v1/audio/speech', {}),
        /macOS speech is switched off/);
});

test('the audio cache never replays across doors', () => {
    voices([SAY_ROW]);
    store({});
    const up = api.memKey('same sentence');
    store({ [ROUTE]: 'vanilla' });
    assert.notStrictEqual(api.memKey('same sentence'), up,
        'the same text at the other door is different bytes');
});

test('both queues share the request builder and the transport', () => {
    const blocks = SRC.split('sio.SpeechQueue({').slice(1);
    assert.strictEqual(blocks.length, 2, 'the chat builds two queues');
    blocks.forEach((b, i) => {
        const body = b.slice(0, b.indexOf('});'));
        assert.match(body, /request:\s*speakRequestFor/, 'queue ' + i + ' request seam');
        assert.match(body, /fetchLike:\s*speakTransport/, 'queue ' + i + ' transport seam');
    });
});

test('the control is labelled, translated, and cuts the live read on change', () => {
    assert.match(SRC, /routeSel\.id = 'chat-native-speak-route'/);
    ["uplift.chat.speak_route", "uplift.chat.speak_route_uplift",
     "uplift.chat.speak_route_vanilla", "uplift.chat.speak_route_hint"
    ].forEach(k => assert.ok(SRC.includes("'" + k + "'"), 'JS uses ' + k));
    const handler = grab("routeSel.addEventListener('change'", "secVoice = section");
    assert.match(handler, /lsSet\(ROUTE_KEY/);
    assert.match(handler, /speakCancel\(\)/, 'a route change cuts the live read');
});

test('presets carry the route: snapshot, normaliser, apply', () => {
    assert.match(SRC, /out\.speakRoute = ls\.getItem\(ROUTE_KEY\)/);
    assert.match(SRC, /speakRoute: s\.speakRoute === 'vanilla'/);
    const apply = grab('lsSet(CHUNK_KEY, n.chunk);', 'syncAudioMode()');
    assert.match(apply, /lsSet\(ROUTE_KEY, n\.speakRoute\)/);
    assert.match(apply, /gid\('chat-native-speak-route'\)/);
});

test('every locale got a real translation, not the English string', () => {
    const dir = path.join(__dirname, '../omlx_uplift/locales');
    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
    const keys = ['uplift.chat.speak_route', 'uplift.chat.speak_route_uplift',
                  'uplift.chat.speak_route_vanilla', 'uplift.chat.speak_route_hint'];
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        keys.forEach(k => {
            assert.ok(d[k], f + ' is missing ' + k);
            // the two route names are product + API acronym (U87 P10):
            // several locales keep 'Uplift API' / 'oMLX API' verbatim
            if (f !== 'en.json' && k !== 'uplift.chat.speak_route_vanilla'
                && k !== 'uplift.chat.speak_route_uplift')
                assert.notStrictEqual(d[k], en[k], f + ' copies en for ' + k);
        });
    });
});
