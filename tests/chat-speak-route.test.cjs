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

const SRC = fs.readFileSync(path.join(__dirname,
    '../omlx_uplift/static/uplift_chat.js'), 'utf8');
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
    'var _store = {};',
    'var W = () => ({ localStorage: { getItem: k => (k in _store ? _store[k] : null) } });',
    'function chatVoiceId() { return _currentVoice; }',
    'function VOI() { return _V; }',
    'var _calls = [];',
    'function fetch(u, o) { _calls.push([u, o]); return Promise.resolve("fetched"); }',
    grab('function speakRoute()', 'function SIO()'),
    grab('function voiceRowById', 'function ensureSpeakQueue'),
].join('\n');

const ROUTE = 'omlx-uplift-speak-route';
const sandbox = { JSON, Math, Date, String, Number, Object, Array, Promise,
    Error, exports: {} };
vm.createContext(sandbox);
vm.runInContext(CODE + '\nexports.api = () => ({ speakRoute, voiceRowById, '
    + 'vanillaSpeechCall, vanillaSpeechFetch, speakRequestFor, speakTransport });',
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

test('a macOS row crosses over as the model token that engine addresses', () => {
    store({ [ROUTE]: 'vanilla' });
    voices([SAY_ROW]);
    const call = api.vanillaSpeechCall('zuzana', 'Ahoj.');
    assert.strictEqual(call.url, '/v1/audio/speech');
    assert.strictEqual(call.body.model, 'say:com.apple.voice.premium.cs-CZ.Zuzana');
    assert.strictEqual(call.body.input, 'Ahoj.');
    assert.ok(!('voice' in call.body), 'the say model token carries the voice');
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

test('the transport adds the Bearer key only on the /v1 door', () => {
    set('_key = "sk-test"; _calls = [];');
    api.speakTransport('/v1/audio/speech', { model: 'say', input: 'x' });
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
            if (f !== 'en.json' && k !== 'uplift.chat.speak_route_vanilla')
                assert.notStrictEqual(d[k], en[k], f + ' copies en for ' + k);
        });
    });
});
