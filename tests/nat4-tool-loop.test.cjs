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
