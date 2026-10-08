/* NAT-4 (5/6) tool-loop unit proofs (vm sandbox, nat4-chat-mount harness):
   the native connect.handler machinery is pure-function-testable —
   parseChunk (delta shapes incl. the live-verified single-frame
   tool_calls), accumulateToolCall (index merge, argument concat),
   toolRequest (classic's BUILTIN_WEB_TOOL_ROUTES mapping), and
   shapeRequest's tools attach only while the web toggle is on. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

function baseWin() {
    const win = {
        UpliftCore: { t: (k) => k },
        UpliftDom: { fetchJson: async () => { throw new Error('no net'); },
                     postJson: async () => ({}), deleteJson: async () => ({}),
                     toast: () => {} },
        Uplift: { state: { API: '' } },
        document: { getElementById: () => null, createElement: () => ({
            style: {}, dataset: {}, classList: { toggle() {}, add() {} },
            appendChild() {}, replaceChildren() {}, addEventListener() {} }) },
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {}, MutationObserver: function () { this.observe = () => {}; },
        setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
        setInterval: () => 1, clearInterval: () => {},
        prompt: () => null, confirm: () => true,
        FormData: undefined, File: undefined,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8'))
        .runInContext(ctx);
    return win;
}

test('parseChunk: content / reasoning / tool_calls / finish, live shapes', () => {
    const M = baseWin().UpliftNativeChat;
    let c = M.parseChunk({ choices: [{ delta: { content: 'tok' } }] });
    assert.equal(c.text, 'tok'); assert.equal(c.reasoning, '');
    c = M.parseChunk({ choices: [{ delta: { reasoning_content: 'think' } }] });
    assert.equal(c.reasoning, 'think');
    // single-frame tool_calls exactly as the dev keg streamed 2026-10-08
    c = M.parseChunk({ choices: [{ delta: { tool_calls: [{ index: 0,
        id: 'call_x', type: 'function',
        function: { name: 'web_search', arguments: '{"query": "a"}' } }] },
        finish_reason: 'tool_calls' }] });
    assert.equal(c.toolCalls.length, 1);
    assert.equal(c.finish, 'tool_calls');
    assert.equal(M.parseChunk(null), null);
    assert.equal(M.parseChunk('ping'), null);
});

test('accumulateToolCall: index merge + argument concatenation', () => {
    const M = baseWin().UpliftNativeChat;
    const map = {};
    M.accumulateToolCall(map, { index: 0, id: 'c1',
        function: { name: 'web_search', arguments: '{"qu' } });
    M.accumulateToolCall(map, { index: 0, function: { arguments: 'ery": "x"}' } });
    M.accumulateToolCall(map, { index: 1, id: 'c2',
        function: { name: 'fetch_url', arguments: '{}' } });
    assert.equal(map[0].function.name, 'web_search');
    assert.equal(map[0].function.arguments, '{"query": "x"}');
    assert.equal(map[0].id, 'c1', 'id survives later index frames');
    assert.equal(Object.keys(map).length, 2, 'parallel calls kept separate');
});

test('toolRequest: web routes get raw args, everything else the MCP envelope', () => {
    const M = baseWin().UpliftNativeChat;
    let r = M.toolRequest({ function: { name: 'web_search' }, _args: { query: 'a' } });
    assert.deepEqual(r, { url: '/v1/web/search', payload: { query: 'a' } });
    r = M.toolRequest({ function: { name: 'fetch_url' }, _args: { url: 'u' } });
    assert.equal(r.url, '/v1/web/fetch');
    r = M.toolRequest({ function: { name: 'srv__tool' }, _args: { x: 1 } });
    assert.equal(r.url, '/v1/mcp/execute');
    assert.deepEqual(r.payload, { tool_name: 'srv__tool', arguments: { x: 1 } });
    r = M.toolRequest({ function: { name: 'web_search' } });   // no args parsed yet
    assert.deepEqual(r.payload, {}, 'missing _args -> {} (classic parse-fail path)');
});

test('isSttModel: engine_type classification off the /models rows', () => {
    const win = baseWin();
    const M = win.UpliftNativeChat;
    const st = M._state();
    st.models = [
        { id: 'llm1', engine_type: 'llm' },
        { id: 'vlm1', model_type: 'vlm' },
        { id: 'whisper-tiny-mlx-4bit', engine_type: 'audio_stt' },
    ];
    assert.equal(M.isSttModel('whisper-tiny-mlx-4bit'), true);
    assert.equal(M.isSttModel('llm1'), false);
    assert.equal(M.isSttModel('vlm1'), false);
    assert.equal(M.isSttModel('nope'), false, 'unknown id is never STT');
    assert.equal(M.isSttModel(''), false);
});

test('encodeWav: 44-byte RIFF header + 16-bit mono PCM, clamped', () => {
    const M = baseWin().UpliftNativeChat;
    const chunks = [new Float32Array([0, 0.5, -0.5]),
                    new Float32Array([1.5, -2, 0])];   // out-of-range clamp
    const buf = M.encodeWav(chunks, 16000);
    const dv = new DataView(buf);
    const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
    assert.equal(str(0, 4), 'RIFF');
    assert.equal(str(8, 4), 'WAVE');
    assert.equal(str(12, 4), 'fmt ');
    assert.equal(dv.getUint32(16, true), 16);
    assert.equal(dv.getUint16(20, true), 1, 'PCM format');
    assert.equal(dv.getUint16(22, true), 1, 'mono');
    assert.equal(dv.getUint32(24, true), 16000, 'sample rate');
    assert.equal(dv.getUint32(28, true), 32000, 'byte rate = rate*2');
    assert.equal(dv.getUint16(32, true), 2, 'block align');
    assert.equal(dv.getUint16(34, true), 16, 'bits');
    assert.equal(str(36, 4), 'data');
    assert.equal(buf.byteLength, 44 + 6 * 2);
    assert.equal(dv.getUint32(40, true), 12, 'data length');
    assert.equal(dv.getInt16(44, true), 0);
    assert.equal(dv.getInt16(46, true), 16383, '0.5 -> ~0x3FFF');
    assert.equal(dv.getInt16(48, true), -16384, '-0.5 -> ~-0x4000');
    assert.equal(dv.getInt16(50, true), 32767, '1.5 clamps to +1.0');
    assert.equal(dv.getInt16(52, true), -32768, '-2 clamps to -1.0');
});

test('WEB tools attach to the request only while the toggle is on', async () => {
    const win = baseWin();
    const M = win.UpliftNativeChat;
    const st = M._state();
    st.conv = Object.assign(M.newConv(), { model: 'M', messages: [] });
    let d = await M.shapeRequest({ body: { messages: [] }, headers: {} });
    let body = (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
    assert.ok(!body.tools, 'off by default — classic embed parity unchanged');
    assert.equal(st.webSearch, false);
    assert.equal(M.toggleWeb(), true, 'toggle flips + reports state');
    d = await M.shapeRequest({ body: { messages: [] }, headers: {} });
    body = (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
    assert.equal(body.tools.length, 2, 'web_search + fetch_url');
    assert.deepEqual(body.tools.map(x => x.function.name), ['web_search', 'fetch_url']);
    M.toggleWeb();
    d = await M.shapeRequest({ body: { messages: [] }, headers: {} });
    body = (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
    assert.ok(!body.tools, 'toggle off removes them again');
});
