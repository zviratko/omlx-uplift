/* NAT-4 (3/6) native Chat mount + request-shaping proof (vm sandbox +
   DOM stub, repl1-bench-mount pattern — no browser):
   - module surface mounts, toolbar labels come through UpliftCore.t
   - shapeRequest: system prompt + full store history + dedup (the
     component records the user message before connect; the outgoing
     body must carry it exactly once) + Bearer from the key handout
   - shapeResponse: delta.content passes, reasoning/tool deltas are
     silent in 3/6 (4/6 renders them)
   - migrateLegacy: one-shot import of classic's localStorage store,
     key consumed ONLY after every POST succeeded; corrupt JSON is a
     silent no-op (never deletes legacy data); transport failure keeps
     the legacy key for the next boot. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const CAT = {
    'chat.new_chat': 'NEWCHAT',
    'chat.select_model': 'PICKMODEL',
    'chat.system_prompt.placeholder': 'SYSPH',
    'chat.input_placeholder': 'INPUTPH',
    'chat.copy_tooltip': 'COPY',
    'chat.regenerate_tooltip': 'REGEN',
    'chat.edit_tooltip': 'EDIT',
    'chat.delete_tooltip': 'DEL',
    'chat.chat_history_label': 'PICKER',
    'uplift.chat.booting': 'BOOTING',
};

function makeHarness(opts = {}) {
    const byId = {};
    const shadow = { children: [], appendChild(k) { this.children.push(k); return k; },
                     getElementById() { return null; } };
    function makeEl(tag) {
        const el = {
            tagName: tag, children: [], style: {}, dataset: {},
            className: '', textContent: '', title: '', hidden: false,
            innerHTML: '', checked: false, disabled: false, value: '', type: '', name: '',
            _id: '',
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            insertBefore(k) { this.children.unshift(k); return k; },
            addEventListener() {}, removeEventListener() {},
            querySelector() { return makeEl('div'); },
            querySelectorAll() { return []; },
            remove() {}, focus() {}, blur() {}, setAttribute() {},
            getAttribute() { return null; },
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            oninput: null, onchange: null, onclick: null,
        };
        return el;
    }
    const document = {
        __shadow: shadow,
        getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
        createElement(tag) { const e = makeEl(tag); if (tag === "deep-chat") e.shadowRoot = shadow; return e; },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        head: { appendChild() {} },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
    };
    const posts = [], dels = [];
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: [
                    { id: 'SmolLM2-360M-Instruct-oQ4', engine_type: 'llm' },
                    { id: 'Qwen3-Embedding-0.6B-4bit-DWQ', engine_type: 'embedding' }] };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history'))
                    return (opts.convs || []).map((c) => ({ id: c.id,
                        title: c.title, model: c.model,
                        message_count: (c.messages || []).length, updated: 1 }));
                const m = u.match(/\/chat\/history\/(.+)$/);
                if (m) {
                    const c = (opts.convs || []).find((x) => x.id === m[1]);
                    if (!c) throw new Error('404');
                    return c;
                }
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, body) => { posts.push([String(u), body]);
                return { status: 'saved', kb: 1 }; },
            deleteJson: async (u) => { dels.push(String(u)); return { ok: 1 }; },
            toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document,
        customElements: { get: () => function DeepChat() {} },  // vendor 'loaded'
        // createElement('deep-chat') must surface a shadowRoot right away
        // (upgraded component): tag the el when the module asks for one
        __shadowReady: true,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {}, MutationObserver: function () {
            this.observe = () => {}; },
        prompt: () => null, confirm: () => true,
        setTimeout: (f, ms) => setTimeout(f, ms),   // tryTheme retry loop
        setInterval: () => 1, clearInterval: () => {},  // un-wedge watch
        clearTimeout: (id) => clearTimeout(id),
    };
    win.window = win; win.self = win;
    const store = Object.assign({}, opts.localStorage || {});
    win.localStorage = { getItem: (k) => (k in store ? store[k] : null),
                         setItem: (k, v) => { store[k] = v; },
                         removeItem: (k) => { delete store[k]; } };
    win.__store = store;
    const ctx = vm.createContext(win);
    // Promise/FormData/File exist per-context or absent — code paths that
    // need FormData instanceof File are exercised via the text path here.
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8'))
        .runInContext(ctx);
    return { win, byId, posts, dels };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function booted(h) {   // let the mount promise chain settle
    for (let i = 0; i < 12; i++) await tick();
    return h;
}

test('module exports + mount paints toolbar through the catalog', async () => {
    const h = makeHarness();
    assert.ok(h.win.UpliftNativeChat, 'global exported');
    h.win.UpliftNativeChat.mount();
    await booted(h);
    assert.ok(h.win.UpliftNativeChat.isMounted(), 'isMounted flips');
    const host = h.byId['chat-native'];
    const texts = [];
    (function walk(e) { texts.push(e.textContent || '');
        (e.children || []).forEach(walk); })(host);
    const all = texts.join(' ');
    for (const marker of ['NEWCHAT', 'PICKMODEL', 'PICKER', 'COPY', 'REGEN', 'DEL'])
        assert.ok(all.includes(marker), `label ${marker} rendered`);
    assert.ok(!all.includes('chat.new_chat'), 'no raw i18n key leaks');
    // embedding models are filtered out of the chat picker
    const selTexts = [];
    (function walk(e) { selTexts.push(e.value || ''); (e.children || []).forEach(walk); })(
        h.byId['chat-native-model']);
    assert.ok(selTexts.includes('SmolLM2-360M-Instruct-oQ4'), 'llm selectable');
    assert.ok(!selTexts.includes('Qwen3-Embedding-0.6B-4bit-DWQ'), 'embedding filtered');
});

test('shapeRequest: system prompt, full history, dedup, auth header', async () => {
    const convs = [{ id: 'c1', title: 'T', model: 'M1', systemPrompt: 'BE NICE',
                     messages: [{ role: 'user', content: 'old' },
                                { role: 'assistant', content: 'anc' }] }];
    const h = await booted(makeHarness({ convs }));
    const M = h.win.UpliftNativeChat;
    M.mount();
    await booted(h);
    const st = M._state();
    assert.equal(st.conv.id, 'c1', 'latest conversation opened');
    assert.equal(st.conv.messages.length, 2, 'full messages loaded, not summaries');
    // component recorded the new user message BEFORE connect (real order)
    st.conv.messages.push({ role: 'user', content: 'hello' });
    const d = await M.shapeRequest({ body: { messages: [{ role: 'user', text: 'hello' }] },
                                     headers: {} });
    const body = JSON.parse(typeof d.body === 'string' ? d.body : JSON.stringify(d.body));
    assert.equal(body.model, 'M1');
    assert.equal(body.stream, true);
    assert.equal(d.headers.Authorization, 'Bearer KEY');
    assert.deepEqual(body.messages.map((m) => m.role),
                     ['system', 'user', 'assistant', 'user']);
    assert.equal(body.messages[0].content, 'BE NICE');
    const users = body.messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 2, 'old user + hello, never hello twice');
    assert.equal(users[1].content, 'hello');
});

test('shapeRequest regenerate path: popped tail still sends the message', async () => {
    const convs = [{ id: 'c1', title: 'T', model: 'M1', systemPrompt: '',
                     messages: [{ role: 'user', content: 'hi' },
                                { role: 'assistant', content: 'yo' }] }];
    const h = await booted(makeHarness({ convs }));
    const M = h.win.UpliftNativeChat;
    M.mount();
    await booted(h);
    const st = M._state();
    st.conv.messages.pop();                    // regen pops the assistant
    const last = st.conv.messages[st.conv.messages.length - 1];
    st.conv.messages.pop();                    // then the user message
    const d = await M.shapeRequest({ body: { messages: [{ role: 'user',
                                                          text: last.content }] },
                                     headers: {} });
    const body = (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
    assert.deepEqual(body.messages.map((m) => m.content), ['hi'],
                     'resend goes out after the store was rewound');
});

test('shapeRequest strips an orphan user turn left by a failed send', async () => {
    // forced-failure drill (live 2026-10-08): a send that dies before any
    // chunk leaves the user row in the store; templates reject user/user
    // ('Conversation roles must alternate'), so the NEXT request must be
    // healed request-locally — cur is the only user turn that ships.
    const convs = [{ id: 'c1', title: 'T', model: 'M1', systemPrompt: '',
                     messages: [{ role: 'user', content: 'orphan from failed send' }] }];
    const h = await booted(makeHarness({ convs }));
    const M = h.win.UpliftNativeChat;
    M.mount();
    await booted(h);
    const st = M._state();
    st.conv.messages.push({ role: 'user', content: 'retry' });   // pre-connect record
    const d = await M.shapeRequest({ body: { messages: [{ role: 'user', text: 'retry' }] },
                                     headers: {} });
    const body = (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'retry' }],
                     'orphan dropped, exactly one user turn ships');
});

test('thinking modes map to classic wire fields (enable_thinking / thinking_budget)',
     async () => {
    const convs = [{ id: 'c1', title: 'T', model: 'M1', systemPrompt: '',
                     messages: [] }];
    const h = await booted(makeHarness({ convs }));
    const M = h.win.UpliftNativeChat;
    M.mount();
    await booted(h);
    const st = M._state();
    async function bodyFor(thinking, budget) {
        st.conv.thinking = thinking; st.conv.thinkingBudget = budget;
        const d = await M.shapeRequest({ body: { messages: [] }, headers: {} });
        return (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
    }
    let b = await bodyFor('auto', null);
    assert.ok(!('enable_thinking' in b) && !('thinking_budget' in b),
              'auto ships nothing — model/template default (classic parity)');
    b = await bodyFor('off', null);
    assert.equal(b.enable_thinking, false);
    assert.ok(!('thinking_budget' in b));
    b = await bodyFor('on', null);
    assert.equal(b.enable_thinking, true);
    b = await bodyFor('limit', 2048);
    assert.equal(b.enable_thinking, true);
    assert.equal(b.thinking_budget, 2048);
    b = await bodyFor('limit', null);
    assert.equal(b.enable_thinking, true);
    assert.ok(!('thinking_budget' in b), 'no budget -> unlimited thinking');
});

test('shapeResponse accumulates reasoning_content for the thinking panel', () => {
    const M = makeHarness().win.UpliftNativeChat;
    assert.equal(M._state().thinkingLive, '');
    M.shapeResponse({ choices: [{ delta: { reasoning_content: 'step 1 ' } }] });
    M.shapeResponse({ choices: [{ delta: { reasoning_content: 'step 2' } }] });
    M.shapeResponse({ choices: [{ delta: { content: 'answer' } }] });
    assert.equal(M._state().thinkingLive, 'step 1 step 2',
                 'reasoning deltas buffer while content passes through');
});

test('shapeResponse: content passes, thinking/tool deltas silent in 3/6', () => {
    const M = makeHarness().win.UpliftNativeChat;
    assert.deepEqual(M.shapeResponse({ choices: [{ delta: { content: 'tok' } }] }),
                     { text: 'tok' });
    assert.deepEqual(M.shapeResponse({ choices: [{ delta:
        { reasoning_content: 'hmm' } }] }), { text: '' });
    assert.deepEqual(M.shapeResponse({ choices: [{ delta:
        { tool_calls: [{ index: 0 }] } }] }), { text: '' });
    assert.deepEqual(M.shapeResponse(null), { text: '' });
    assert.deepEqual(M.shapeResponse('ping'), { text: '' });
});

test('migrateLegacy imports classic store and consumes key only on full success',
     async () => {
    const legacy = JSON.stringify([
        { id: 'L1', title: 'keep', model: 'Mx', systemPrompt: 'sp',
          messages: [{ role: 'user', content: 'a' },
                     { role: 'assistant', content: 'b' }] },
        { id: 'L2', title: 'skip-empty', model: 'Mx', messages: [] },
    ]);
    const h = makeHarness({ localStorage: { omlx_chat_history: legacy } });
    const n = await h.win.UpliftNativeChat.migrateLegacy();
    await booted(h);
    assert.equal(n, 1, 'empty conversation skipped');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0][1].id, 'L1');
    assert.equal(h.posts[0][1].systemPrompt, 'sp', 'classic fields carried over');
    assert.equal(h.win.__store.omlx_chat_history, undefined, 'key consumed');
});

test('migrateLegacy: corrupt JSON is a silent no-op, transport failure keeps data',
     async () => {
    const bad = makeHarness({ localStorage: { omlx_chat_history: '{oops' } });
    assert.equal(await bad.win.UpliftNativeChat.migrateLegacy(), 0);
    assert.equal(bad.win.__store.omlx_chat_history, '{oops', 'corrupt left alone');

    const h = makeHarness({ localStorage: { omlx_chat_history:
        JSON.stringify([{ id: 'X', messages: [{ role: 'user', content: 'q' }] }]) } });
    h.win.UpliftDom.postJson = async () => { throw new Error('offline'); };
    assert.equal(await h.win.UpliftNativeChat.migrateLegacy(), 0);
    assert.ok(h.win.__store.omlx_chat_history, 'legacy kept for the next boot');
});
