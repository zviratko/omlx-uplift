/* NAT-4 (3/6) native Chat mount + request-shaping proof (vm sandbox +
   DOM stub, repl1-bench-mount pattern — no browser):
   - module surface mounts, toolbar labels come through UpliftCore.t
   - shapeRequest: system prompt + full store history + dedup (the
     component records the user message before connect; the outgoing
     body must carry it exactly once) + Bearer from the key handout
   - (5/6 note: chunk parsing moved from shapeResponse to the native
     handler's parseChunk — covered in nat4-tool-loop.test.cjs)
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
    'chat.active_profile': 'APROF',
    'chat.save_settings': 'SAVESET',
};

function makeHarness(opts = {}) {
    const byId = {};
    const shadow = { children: [], appendChild(k) { this.children.push(k); return k; },
                     getElementById(id) {
                         return this.children.find(c => c.id === id) || null; } };
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
        __listeners: {},
        addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
        __fire(type, detail) { (this.__listeners[type] || []).forEach(f => f({ detail })); },
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
    for (const marker of ['NEWCHAT', 'PICKMODEL', 'PICKER', 'DEL'])
        assert.ok(all.includes(marker), `label ${marker} rendered`);
    // U45: the last-turn COPY/REGEN trio left the toolbar; every control
    // carries a caption instead (classic sidebar mirror) and per-message
    // actions live on the bubbles.
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

/* ---- 6/6c prompt profiles + enhanced readability (mirror doctrine) ---- */

const PROFILE_LS = 'omlx_chat_prompt_profiles';

function optionTexts(sel) {
    return (sel.children || []).map((o) => o.textContent);
}

test('profiles: picker renders store contents, restores activeProfile', async () => {
    const h = makeHarness({
        localStorage: { [PROFILE_LS]: JSON.stringify([
            { name: 'System Default', content: '' },
            { name: 'Coder', content: 'write code' }]) },
        convs: [{ id: 'c9', title: 'T', model: 'SmolLM2-360M-Instruct-oQ4',
                  systemPrompt: 'write code', activeProfile: 'Coder',
                  messages: [] }],
    });
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.ok(sel, 'profile picker in the toolbar');
    assert.deepEqual(optionTexts(sel), ['APROF', 'System Default', 'Coder'],
        'blank first option via classic key + store names, textContent not HTML');
    assert.equal(sel.value, 'Coder', 'active profile restored from the conv');
    assert.equal(h.byId['chat-native-sys'].value, 'write code',
        'prompt text matches the profile content');
});

test('profiles: stale activeProfile name degrades to blank, never a fake option', async () => {
    const h = makeHarness({
        localStorage: { [PROFILE_LS]: JSON.stringify(
            [{ name: 'System Default', content: '' }]) },
        convs: [{ id: 'c9', title: 'T', model: 'x', systemPrompt: 'keep me',
                  activeProfile: 'Ghost', messages: [] }],
    });
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.equal(sel.value, '', 'unknown name -> blank (classic Custom)');
    assert.ok(optionTexts(sel).indexOf('Ghost') < 0, 'ghost not injected into list');
    assert.equal(h.byId['chat-native-sys'].value, 'keep me',
        'text survives losing its association');
});

test('profiles: corrupt store is a silent empty list (classic catch parity)', async () => {
    const h = makeHarness({ localStorage: { [PROFILE_LS]: '{not json' } });
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.deepEqual(optionTexts(sel), ['APROF'], 'only the blank option');
});

test('readability: boot state applies the shadow block; board event restyles live', async () => {
    const h = makeHarness({ localStorage: { 'omlx-enhanced-readability': 'on' } });
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const shadow = h.win.document.__shadow;
    const style = shadow.children.find((c) => c.id === 'uplift-chat-theme');
    assert.ok(style, 'theme style owns the shadow root');
    assert.ok(style.textContent.includes('font-size: max(12px'),
        'classic 12px floor mirrored into the shadow DOM');
    assert.ok(style.textContent.includes('!important'),
        'gray->primary block baked in while enhanced');
    h.win.document.__fire('uplift:embed-theme', { theme: 'dark', enhanced: false });
    assert.ok(!style.textContent.includes('font-size: max(12px'),
        'switching enhanced off removes the block WITHOUT a reload');
    h.win.document.__fire('uplift:embed-theme', { theme: 'dark', enhanced: true });
    assert.ok(style.textContent.includes('font-size: max(12px'), 'and back on');
});

/* U43: dark-on-dark regression pin. The bundle's adopted sheets carry
   .ai-message-text{color:#000} ON the bubble element and
   #text-input-container{background:#fff} — an in-tree <style> at equal
   specificity LOSES to adopted sheets, so the theme tag must outrank
   them by specificity (two classes / two IDs), never by luck of order. */
test('U43: shadow theme outranks the bundle hard-coded colors', async () => {
    const h = makeHarness();
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const style = h.win.document.__shadow.children
        .find((c) => c.id === 'uplift-chat-theme');
    const css = style.textContent;
    // pill rules must carry BOTH bubble + text classes (0,2,0) and set
    // BOTH properties — color:var(--ink) beats #000/#fff text, the
    // background keeps the pill distinction.
    assert.ok(/\.message-bubble\.ai-message-text\s*{[^}]*color:\s*var\(--ink/.test(css),
        'ai pill color is themed at 0,2,0');
    assert.ok(/\.message-bubble\.ai-message-text\s*{[^}]*background:\s*var\(/.test(css),
        'ai pill background stays themed');
    assert.ok(/\.message-bubble\.user-message-text\s*{[^}]*color:\s*var\(--ink/.test(css),
        'user pill color is themed at 0,2,0');
    assert.ok(/\.message-bubble\.user-message-text\s*{[^}]*background:\s*(var|color-mix)\(/.test(css),
        'user pill background stays themed (U75: accent color-mix tint)');
    // the white input well needs TWO ids (bundle rule is #id alone)
    assert.ok(/#chat-view\s+#text-input-container\s*{[^}]*background:\s*var\(--field/.test(css),
        'input well background beats the #id rule');
    // streaming dots: the bundle sets --loading-message-color INLINE per
    // container, so only a direct !important declaration wins
    assert.ok(/\.loading-message-dots[^{]*{[^}]*background-color:\s*var\(--dim[^}]*!important/.test(css),
        'loading dots beat the inline var with !important');
    assert.ok(/::-webkit-scrollbar-thumb/.test(css),
        'shadow scrollbars themed (bundle paints #d0d0d0)');
});

/* U45: index-based message actions (classic parity semantics, driven
   through the test seams; the overlay binds them to per-bubble buttons
   in the shadow DOM — proven live in the browser drill). */
test('U45: regenerate at index truncates to the prompt and replays it', async () => {
    const h = makeHarness({ convs: [{ id: 'c1', title: 'T', model: 'M', messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'second answer' }] }] });
    h.win.UpliftNativeChat.mount();
    await booted(h);
    const st = h.win.UpliftNativeChat._state();
    const sent = [];
    st.dc.submitUserMessage = (m) => sent.push(m.text);
    h.win.UpliftNativeChat._msgActions.regenerate(1);   // first answer
    assert.deepEqual(sent, ['first question'], 'replays the prompt before idx');
    assert.deepEqual(st.conv.messages.map(m => m.content), [],
        'store = history before the prompt; the replayed user turn and the ' +
        'new answer re-enter via onMessage (live path, not stubbed here)');
});

test('U45: transcription turns refuse regenerate without touching the store', async () => {
    const h = makeHarness({ convs: [{ id: 'c1', title: 'T', model: 'M', messages: [
        { role: 'user', content: '[audio] microphone recording' },
        { role: 'assistant', content: 'transcript text' }] }] });
    h.win.UpliftNativeChat.mount();
    await booted(h);
    const st = h.win.UpliftNativeChat._state();
    const sent = [];
    st.dc.submitUserMessage = (m) => sent.push(m.text);
    h.win.UpliftNativeChat._msgActions.regenerate(1);
    assert.deepEqual(sent, [], 'no prose label goes out as a prompt');
    assert.equal(st.conv.messages.length, 2, 'store untouched');
});

test('U45: edit truncates at the user index; delete removes exactly one row', async () => {
    const convs = [{ id: 'c1', title: 'T', model: 'M', messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'A' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'B' }] }];
    const h = makeHarness({ convs });
    h.win.UpliftNativeChat.mount();
    await booted(h);
    const st = h.win.UpliftNativeChat._state();
    const sent = [];
    st.dc.submitUserMessage = (m) => sent.push(m.text);
    // U73: edit() now opens an INLINE editor (needs real bubbles); the
    // truncate-and-replay semantics moved to commitEdit — same contract
    h.win.UpliftNativeChat._msgActions.editCommit(2, 'two edited');
    assert.deepEqual(sent, ['two edited'], 'edited text replays from that index');
    st.conv.messages = convs[0].messages.slice();
    h.win.UpliftNativeChat._msgActions.delete(1);
    assert.deepEqual(st.conv.messages.map(m => m.content), ['one', 'two', 'B'],
        'delete removes exactly the row under the button');
});

test('U45: copy splits plain vs markdown; stripMarkdown keeps code content', () => {
    const strip = require('node:vm');   // seam reachable without a mount
    void strip;
    // Pure-function check via a fresh harness (module-level export):
    const h = makeHarness();
    const fn = h.win.UpliftNativeChat._msgActions.stripMarkdown;
    assert.equal(fn('**bold** and `code`'), 'bold and code');
    assert.equal(fn('[label](http://x)'), 'label');
    assert.equal(fn('# Head\n- item'), 'Head\nitem');
    assert.equal(fn('```py\nprint(1)\n```'), 'print(1)',
        'fence info string is not prose (classic copy parity)');
    assert.equal(fn('<b>raw</b>'), 'raw');
});

/* U46: sampling overrides ride the request only when set; 0 is a value. */
test('U46: shapeRequest spreads generation; unset adds nothing', async () => {
    const h = makeHarness({ convs: [{ id: 'c1', title: 'T', model: 'M', messages: [
        { role: 'user', content: 'hi' }] }] });
    h.win.UpliftNativeChat.mount();
    await booted(h);
    const st = h.win.UpliftNativeChat._state();
    const mk = () => ({ headers: {}, body: { messages: [{ role: 'text', text: 'again' }] } });
    let req = await h.win.UpliftNativeChat.shapeRequest(mk());
    assert.ok(!('temperature' in req.body) && !('top_p' in req.body),
        'blank generation = absent from the wire (engine default)');
    st.conv.generation = { temperature: 0, max_tokens: 128, presence_penalty: -0.5 };
    req = await h.win.UpliftNativeChat.shapeRequest(mk());
    assert.equal(req.body.temperature, 0, 'temperature 0.0 reaches the wire (greedy is valid)');
    assert.equal(req.body.max_tokens, 128);
    assert.equal(req.body.presence_penalty, -0.5);
});

test('U46: inputs parse honoring zero; blank and junk are unset', async () => {
    const h = makeHarness();
    h.win.UpliftNativeChat.mount();
    await booted(h);
    const N = h.win.UpliftNativeChat;
    h.byId[N.genInputId('temperature')].value = '0';
    h.byId[N.genInputId('top_p')].value = '0.8';
    h.byId[N.genInputId('min_p')].value = '';
    h.byId[N.genInputId('top_k')].value = 'abc';
    const g = N.readGenerationInputs();
    assert.deepEqual(g, { temperature: 0, top_p: 0.8 },
        '0 parses, empty/NaN drop out');
    h.byId[N.genInputId('temperature')].value = '';
    h.byId[N.genInputId('top_p')].value = '';
    assert.equal(N.readGenerationInputs(), null, 'all blank -> null (unset)');
});

test('U71: thinking anchors ABOVE each reply, not at the top of the chat', () => {
    // user bug: the NAT-4 hybrid kept one fixed panel above the whole
    // conversation; classic shows the block per assistant message. Pins:
    // no light-DOM panel element, blocks built only inside the shadow
    // root, and inserted BEFORE the bubble element.
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(!/tp\.id = 'chat-native-think'/.test(src),
        'fixed thinking panel element is gone');
    assert.ok(/holder\.insertBefore\(thinkEl, b\)/.test(src),
        'persisted block goes above the bubble');
    assert.ok(/h0\.insertBefore\(target, t0\)/.test(src),
        'live stream block goes above the in-flight bubble');
    assert.ok(/\.chat-native-thinking \{/.test(src),
        'shadow-root CSS ships for the block (light DOM cannot reach)');
    assert.ok(/_lastAiVisible|lastAiVisible\(\)/.test(src),
        'store-derived anchor helper in use');
    // classic parity: finished blocks default closed, live one open
    assert.ok(/thinkingBlockEl\(txt, isLive\)/.test(src),
        'open state follows live-vs-persisted');
});

test('U72: injected children stack ABOVE the bubble, hover never moves it', () => {
    // user bug: row-flex made thinking sit NEXT to the reply and the
    // hover actions row reflowed (moved) the message
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(/\.inner-message-container \{['\"]?,?\s*'?\s*flex-direction: column/.test(src),
        'inner message container forced to column');
    assert.ok(/\.chat-native-msg-actions \{ visibility: hidden; display: flex/.test(src),
        'actions row reserves space (visibility, not display:none)');
    assert.ok(/background: transparent/.test(src),
        'thinking body beats the bundle dark pre card');
    // live block anchors ONLY ai bubbles (right after send the last
    // bubble is the user's own message)
    assert.ok(/contains\('ai-message'\)/.test(src),
        'streaming anchor is AI-bubble-only');
});

test('U73: message edit is INLINE (no window.prompt); thinking collapses quiet', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(!/window\.prompt/.test(src),
        'the prompt() edit dialog is gone for good');
    assert.ok(/class(Name)? = 'chat-native-edit'|className = "chat-native-edit"/.test(src)
        || /'chat-native-edit'/.test(src), 'inline editor element');
    assert.ok(/commitEdit/.test(src), 'truncate-and-replay split from the UI');
    assert.ok(/bub\.style\.display = 'none'/.test(src),
        'the bubble swaps to the editor in place');
    // look pass: collapsed state must be borderless text, card only [open]
    assert.ok(/\.chat-native-thinking\[open\]/.test(src),
        'card shape follows open state');
});

test('U74: reply + reasoning edits commit IN PLACE; edited rows ride the wire', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    // assistant edits never truncate/replay — they condition the next ctx
    assert.ok(/function commitEditedInPlace/.test(src), 'in-place commit exists');
    assert.ok(/commitEditedInPlace\(idx, taC\.value,/.test(src),
        'assistant unified save goes in-place, user still replays');
    // the Edited mark distinguishes the two honest states
    assert.ok(/uplift\.chat\.edited_next_reply/.test(src)
        && /uplift\.chat\.edited'/.test(src), 'both mark labels exist');
    assert.ok(/function editedClaim/.test(src),
        'claim rule centralized (last row + edited assistant = next)');
    // U75: ONE Edit per row — the header affordance is gone, the unified
    // editor carries reasoning + reply in one form
    assert.ok(!/chat-native-think-edit/.test(src),
        'no second edit affordance (user: one Edit button)');
    assert.ok(/mkTa\('reasoning'/.test(src)
        && /class(Name)? = 'chat-native-edit' \+ \(cls \? ' ' \+ cls : ''\)/.test(src),
        'unified form carries the reasoning field with its class');
    // wire: ONLY edited assistant rows carry reasoning back (classic parity)
    assert.ok(/m\.edited && m\.role === 'assistant' && m\.reasoning_content/
        .test(src), 'reasoning rides the wire only after a user edit');
});

test('U79: toolbar rows regrouped by concern', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    // row membership is the contract: lifecycle together, prompt+Save together
    assert.ok(/rowConv\.append\([\s\S]*?newBtn, expBtn, impBtn, fileIn, del\);/.test(src),
        'conversation row: picker, new, export, import, DELETE in one place');
    assert.ok(/rowPrompt\.append\([\s\S]*?profSave\);/.test(src)
        && /group\(t\('chat\.system_prompt\.title'/.test(src)
        && src.indexOf("'chat.system_prompt.title'") < src.indexOf('profSave);'),
        'Save Settings sits directly after the System Prompt it saves into');
    assert.ok(!/chat-native-pickers/.test(src),
        'the accretion-era pickers row is gone');
    assert.ok(/budGroup/.test(src), 'thinking budget carries a caption group');
});

test('U76-U78: web label, export/import buttons, sampling provenance chip', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(/uplift\.chat\.web_search/.test(src),
        'web toggle carries a descriptive resting label');
    assert.ok(/chat\.download_chats/.test(src) && /chat\.import_chats/.test(src),
        'export/import use the classic catalog keys (zero new i18n)');
    assert.ok(/\/chat\/history\/export/.test(src),
        'export pulls the FULL store, not the summaries list');
    // classic's merge rules: open chat never overwritten, stale loses
    assert.ok(/c\.id === _conv\.id/.test(src) && /<= local\[c\.id\]/.test(src),
        'import merge keeps classic safety rules');
    // U78: the snapshot rides the assistant row and renders as a chip
    assert.ok(/row\.params = Object\.assign\(\{\}, _turnParams\)/.test(src),
        'per-turn sampling snapshot persists on the assistant row');
    assert.ok(/paramsLabel\(ms\[storeIdx\]\.params\)/.test(src),
        'chip renders from the stored row (survives reload)');
    assert.ok(/chat-native-params/.test(src)
        && /'.chat-native-params \{ visibility: visible/.test(src),
        'chip CSS ships in the SHADOW sheet, visible without hover');
});

test('U80: one box height for all text-family controls (doctrine)', () => {
    const css = fs.readFileSync(`${STATIC_DIR}/uplift.css`, 'utf8');
    // the global parity rule must EXCLUDE non-box input types by name
    // (attribute selectors miss type-less <input>; the :not(...) form
    // catches every current and future text input)
    assert.ok(/input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)/.test(css),
        'global box-height rule present');
    assert.ok(/height: 32px; box-sizing: border-box/.test(css),
        'box inputs join the 32px design height');
    assert.ok(/textarea \{ min-height: 32px/.test(css),
        'textareas floor at the row height');
});
