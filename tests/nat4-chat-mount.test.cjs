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
const LOCALES_DIR = `${STATIC_DIR}/../locales`;   // CHAT-3R locale parity pins

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
    'uplift.chat.preset_unsaved': 'MODDED',
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
            innerHTML: '', checked: false, disabled: false, type: '', name: '',
            _value: '',
            // FAITHFUL <input> semantics: assigning value to a single-line
            // input STRIPS newlines (HTML spec). The round-7 bug only fires
            // in a browser — a raw-value stub would ship it green.
            get value() {
                if (tag === 'option' && this._value === '') {
                    return this.textContent;   // browser: value falls back to text
                }
                return this._value === undefined ? '' : this._value;
            },
            set value(v) {
                this._value = tag === 'input'
                    ? String(v == null ? '' : v).replace(/[\r\n]/g, '') : v;
            },
            get selectedIndex() {
                if (tag !== 'select') return -1;
                return this.children.findIndex((o) => o.value === this._value);
            },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) { this.children = kids; },
            append(...kids) { this.children.push(...kids); },
            appendChild(k) { this.children.push(k); return k; },
            insertBefore(k) { this.children.unshift(k); return k; },
            _lis: {},
            addEventListener(t2, fn) { (this._lis[t2] = this._lis[t2] || []).push(fn); },
            removeEventListener() {},
            dispatch(t2, ev) { (this._lis[t2] || []).forEach((fn) => fn(
                Object.assign({ stopPropagation() {}, target: this }, ev))); },
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
                    // REAL row shapes (vanilla admin routes): text LLM =
                    // engine 'batched' + model_type 'llm'; engine_type is
                    // never 'llm' — the old stub hid the filter bug
                    { id: 'SmolLM2-360M-Instruct-oQ4',
                      engine_type: 'batched', model_type: 'llm' },
                    // UP-37(2): the chat's test conv model — with the
                    // thinking capability the server declares for it
                    { id: 'M1', engine_type: 'batched', model_type: 'llm',
                      reasoning_levels: ['off', 'on'] },
                    { id: 'M2', engine_type: 'batched', model_type: 'llm' },
                    { id: 'Qwen3.5-9B-mtp',
                      engine_type: 'vlm', model_type: 'vlm' },
                    { id: 'Qwen3-Embedding-0.6B-4bit-DWQ',
                      engine_type: 'embedding', model_type: 'embedding' },
                    { id: 'whisper-large-v3-turbo-oQ8',
                      engine_type: 'audio_stt', model_type: 'audio_stt' }] };
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
        addEventListener() {}, removeEventListener() {}, MutationObserver: function () {
            this.observe = () => {}; },
        prompt: () => null, confirm: () => true,
        setTimeout: (f, ms) => setTimeout(f, ms),   // tryTheme retry loop
        setInterval: () => 1, clearInterval: () => {},  // un-wedge watch
        clearTimeout: (id) => clearTimeout(id),
    };
    win.window = win; win.self = win;
    // MATH: fake a preloaded KaTeX (mount arms dc.remarkable only when
    // window.katex exists at element-creation time; the loader itself is
    // a no-op in this stub — head has no querySelector)
    if (opts.katexPresent)
        win.katex = { version: '0.19.0-test', renderToString: () => '<math/>' };
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
    // embedding + ASR models are filtered out of the chat picker;
    // a batched-engine TEXT model must be selectable (2026-10-17 bug:
    // the filter compared engine_type to 'llm' — a value it never takes
    // — hiding every text model)
    const selTexts = [];
    (function walk(e) { selTexts.push(e.value || ''); (e.children || []).forEach(walk); })(
        h.byId['chat-native-model']);
    assert.ok(selTexts.includes('SmolLM2-360M-Instruct-oQ4'), 'text llm selectable');
    assert.ok(selTexts.includes('Qwen3.5-9B-mtp'), 'vlm selectable');
    assert.ok(!selTexts.includes('Qwen3-Embedding-0.6B-4bit-DWQ'), 'embedding filtered');
    assert.ok(!selTexts.includes('whisper-large-v3-turbo-oQ8'), 'audio_stt filtered');
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

test('thinking modes map to classic wire fields (chat_template_kwargs, UP-37(2))',
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
    const ctk = (b) => b.chat_template_kwargs && b.chat_template_kwargs.enable_thinking;
    let b = await bodyFor('auto', null);
    assert.ok(!ctk(b) && !('thinking_budget' in b) && !('enable_thinking' in b),
              'auto ships nothing — model/template default (classic parity)');
    b = await bodyFor('off', null);
    assert.equal(ctk(b), false, 'off rides chat_template_kwargs (classic :194728)');
    assert.ok(!('thinking_budget' in b));
    b = await bodyFor('on', null);
    assert.equal(ctk(b), true);
    b = await bodyFor('limit', 2048);
    assert.equal(ctk(b), true);
    assert.equal(b.thinking_budget, 2048);
    b = await bodyFor('limit', null);
    assert.equal(ctk(b), true);
    assert.equal(b.thinking_budget, 1024, 'limit without budget clamps to the classic default');
    b = await bodyFor('limit', 0);
    assert.equal(b.thinking_budget, 1024, 'budget < 1 never ships (classic normalize)');
    // a model without a reasoning control drops every override (classic:
    // levels [] -> mode auto; forced models are decided server-side)
    st.conv.model = 'M2';
    b = await bodyFor('off', null);
    assert.ok(!('chat_template_kwargs' in b) && !('enable_thinking' in b),
              'no declared levels -> no thinking wire');
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
    assert.ok(sel, 'preset picker in the rail');
    assert.deepEqual(optionTexts(sel), ['System Default', 'Coder'],
        'store names, textContent not HTML (CHAT-3R); NO state marker — '
        + 'the clean selection IS the state (round 8)');
    assert.equal(sel.value, 'Coder', 'clean bound preset shows its NAME');
    assert.equal(h.byId['chat-native-sys'].value, 'write code',
        'prompt text matches the profile content');
});

test('profiles: stale activeProfile name degrades to the marker, never a fake option', async () => {
    const h = makeHarness({
        localStorage: { [PROFILE_LS]: JSON.stringify(
            [{ name: 'System Default', content: '' }]) },
        convs: [{ id: 'c9', title: 'T', model: 'x', systemPrompt: 'keep me',
                  activeProfile: 'Ghost', messages: [] }],
    });
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.equal(sel.value, '__modified',
        'unknown name + real text -> Modified (unsaved) marker');
    assert.ok(optionTexts(sel).indexOf('Ghost') < 0, 'ghost not injected into list');
    assert.equal(h.byId['chat-native-sys'].value, 'keep me',
        'text survives losing its association');
});

test('profiles: corrupt store is a silent empty list (classic catch parity)', async () => {
    const h = makeHarness({ localStorage: { [PROFILE_LS]: '{not json' } });
    h.win.UpliftNativeChat.mount();
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.deepEqual(optionTexts(sel), [],
        'corrupt store + empty unmodified field => NO marker row (round 8)');
});

/* ---- CHAT-3R presets: state marker, New/Delete, safe-go-back stash ---- */

function bootPreset(convOver, profiles) {
    const h = makeHarness({
        localStorage: { [PROFILE_LS]: JSON.stringify(profiles) },
        convs: [Object.assign({ id: 'c9', title: 'T',
            model: 'SmolLM2-360M-Instruct-oQ4', messages: [] }, convOver)],
    });
    h.win.UpliftNativeChat.mount();
    return h;
}

function presetRow(h) {
    // TREE access, not byId: the id registry exists even if the module
    // forgets to append a control. Round 6: the naming row is a MODAL —
    // collect the subtree, locate controls by id through it.
    const row = h.byId['chat-native-preset-row'];
    assert.ok(row, 'name modal in the DOM');
    const all = [];
    (function walk(n) { all.push(n); (n.children || []).forEach(walk); })(row);
    const by = (id) => all.find((e) => e.id === id);
    const inp = by('chat-native-preset-name');
    const add = by('chat-native-preset-add');
    const cancel = by('chat-native-preset-cancel');
    assert.ok(inp && add && cancel, 'modal holds input + both buttons');
    return { row, inp, add, cancel };
}

test('preset: a bound edit creates the profile\'s MODIFIED VARIANT (round 11)', async () => {
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const sys = h.byId['chat-native-sys'];
    assert.equal(sel.value, 'Coder', 'clean start: name visible');
    sys.value = 'write code, but terse';
    sys.dispatch('input');
    assert.equal(sel.value, '__variant:Coder',
        'T01: the edit belongs to CODER — row is "Coder (modified)"');
    const row = sel.children.find((o) => o.value === '__variant:Coder');
    assert.equal(row.textContent, 'Coder (modified)', 'labeled with the name');
    assert.equal(sel.children.map((o) => o.value).indexOf('__modified'), -1,
        'T01b: NO anonymous "Modified (unsaved)" row in a bound flow');
    assert.equal(h.byId['chat-native-preset-del'].disabled, false,
        'the variant row is deletable (= discard back to the base)');
    const posts = h.posts.filter((p) => String(p[0]).endsWith('/chat/history'));
    const last = posts[posts.length - 1][1];
    assert.ok(last.variants && last.variants.Coder,
        'the working copy rides the conversation (server-persisted)');
    assert.equal(last.variants.Coder.prompt, 'write code, but terse');
});

test('variant: two modified profiles are INDEPENDENT (single-slot bug)', async () => {
    // ROUND 11 core: the old design had ONE global stash — edit A, switch
    // B, edit B and A's work was overwritten. Variants are per profile.
    const h = bootPreset({ systemPrompt: 'aaa', activeProfile: 'A' },
        [{ name: 'System Default', content: 'sd text' },
         { name: 'A', content: 'aaa' },
         { name: 'B', content: 'bbb' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const sys = h.byId['chat-native-sys'];
    sys.value = 'aaa edited'; sys.dispatch('input');       // A diverges
    sel.value = 'B'; sel.dispatch('change'); await tick();
    assert.equal(sys.value, 'bbb', 'B loads its own base');
    sys.value = 'bbb edited'; sys.dispatch('input');       // B diverges
    assert.deepEqual(
        sel.children.filter((o) => o.value.indexOf('__variant:') === 0)
            .map((o) => o.textContent).sort(),
        ['A (modified)', 'B (modified)'],
        'T04: BOTH profiles carry their own unsaved copy');
    sel.value = '__variant:A'; sel.dispatch('change'); await tick();
    assert.equal(sys.value, 'aaa edited',
        'T03: A\'s edit SURVIVED the detour through B (the regression)');
    sel.value = '__variant:B'; sel.dispatch('change'); await tick();
    assert.equal(sys.value, 'bbb edited', 'B\'s copy is its own too');
});

test('preset: multi-line content from classic stays CLEAN on selection', async () => {
    // ROUND 7 BUG: classic stores profiles from a TEXTAREA (may carry
    // \\r\\n); our field is a single-line <input> that STRIPS newlines on
    // assignment, so the raw compare flagged every such preset 'modified'
    // the instant you picked it: picker showed Modified (unsaved), Delete
    // went dark, and Save prefilled the 'wrong' (hidden-binding) name.
    const h = bootPreset({ systemPrompt: 'line one\nline two', activeProfile: 'ML' },
        [{ name: 'System Default', content: '' },
         { name: 'ML', content: 'line one\nline two' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.equal(sel.value, 'ML',
        'field holds what the browser CAN hold — that IS the content');
    assert.equal(h.byId['chat-native-preset-del'].disabled, false,
        'a freshly selected preset is deletable');
    // switching TO it from elsewhere also lands clean:
    sel.value = 'System Default'; sel.dispatch('change'); await tick();
    sel.value = 'ML'; sel.dispatch('change'); await tick();
    assert.equal(h.byId['chat-native-sys'].value, 'line one\nline two',
        'round 13: the textarea KEEPS classic newlines (stripNL era over)');
    assert.equal(sel.value, 'ML', 'still clean after the switch round-trip');
});

test('marker: is a STATE, not a permanent row; Delete on it discards', async () => {
    const h = bootPreset({ systemPrompt: '' },
        [{ name: 'System Default', content: 'sd base' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const sys = h.byId['chat-native-sys'];
    const del = h.byId['chat-native-preset-del'];
    assert.deepEqual(sel.children.map((o) => o.value), ['System Default'],
        'nothing modified => NO Modified (unsaved) row at all (round 8)');
    assert.equal(sel.value, 'System Default');
    assert.equal(del.disabled, true, 'System Default stays forbidden');
    sys.value = 'scratch note'; sys.dispatch('input');
    assert.ok(sel.children.some((o) => o.value === '__modified'),
        'an unsaved change REAPPEARS the marker');
    assert.equal(sel.value, '__modified');
    assert.equal(del.disabled, false, 'the marker is now deletable');
    h.win.confirm = () => true;
    del.dispatch('click');
    assert.equal(sys.value, '', 'deleting the marker DISCARDS the text');
    assert.equal(sel.children.map((o) => o.value).indexOf('__modified'), -1,
        'and the state (and its stash) is gone for good');
    assert.equal(sel.value, 'System Default');
});

test('variant: Delete on "Name (modified)" DISCARDS back to the base', async () => {
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const sys = h.byId['chat-native-sys'];
    sys.value = 'write code but sloppier'; sys.dispatch('input');
    assert.equal(sel.value, '__variant:Coder');
    h.win.confirm = () => true;
    h.byId['chat-native-preset-del'].dispatch('click');
    assert.equal(sys.value, 'write code', 'page reverted to the saved base');
    assert.equal(sel.value, 'Coder', 'row cleaned; the preset still exists');
    assert.equal(sel.children.map((o) => o.value).indexOf('__variant:Coder'), -1,
        'no variant row left anywhere');
    // T07b: an INACTIVE profile's variant is discarded too, page untouched
    sys.value = 'edit again'; sys.dispatch('input');
    sel.value = 'System Default'; sel.dispatch('change'); await tick();
    h.byId['chat-native-preset-del'].dispatch('click');   // 'System Default' clean -> dark
    assert.equal(h.byId['chat-native-preset-del'].disabled, true,
        'T09: a cleanly selected System Default is STILL not deletable');
    const vrow = sel.children.find((o) => o.value === '__variant:Coder');
    assert.ok(vrow, 'Coder still shows (modified) while you sit on SD');
    sel.value = '__variant:Coder'; sel.dispatch('change'); await tick();
    h.byId['chat-native-preset-del'].dispatch('click');
    assert.equal(sys.value, 'write code', 'discard from afar reverts on arrival');
    assert.equal(sel.value, 'Coder');
});

test('variant: edits back to the saved text clean themselves; drafts stay special', async () => {
    // T11
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const sys = h.byId['chat-native-sys'];
    sys.value = 'who knows'; sys.dispatch('input');
    assert.equal(sel.value, '__variant:Coder');
    sys.value = 'write code'; sys.dispatch('input');
    assert.equal(sel.value, 'Coder',
        'T11: back to the base text => the working copy DROPS itself');
    assert.equal(sel.children.map((o) => o.value).indexOf('__variant:Coder'), -1);
});

test('variant: legacy single-stash migrates into the bound profile', async () => {
    // T13: conversations saved by the old rounds carry customPrompt while
    // bound; boot must NOT pop the anonymous row — attribute the stash.
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder',
                           customPrompt: 'my old draft' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    assert.equal(sel.children.map((o) => o.value).indexOf('__modified'), -1,
        'no anonymous row for a BOUND conversation anymore');
    assert.equal(sel.value, '__variant:Coder', 'the draft became Coder\'s copy');
    assert.equal(h.byId['chat-native-sys'].value, 'my old draft',
        'the variant is the page again — nothing lost in the migration');
});

test('variant: model changes NEVER mark anything (the one exception)', async () => {
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const model = h.byId['chat-native-model'];
    model.value = model.children[1] ? model.children[1].value : model.value;
    model.dispatch('change');
    await tick();
    assert.equal(sel.value, 'Coder', 'T14: swapping the model is not a persona edit');
    assert.equal(sel.children.map((o) => o.value).indexOf('__variant:Coder'), -1);
});

test('profile: round 9 — captures the WHOLE page, model excluded', async () => {
    const h = bootPreset({ systemPrompt: 'persona', activeProfile: 'P1' },
        [{ name: 'System Default', content: '' },
         { name: 'P1', content: 'persona' }]);
    for (let i = 0; i < 12; i++) await tick();
    // drive real page state: thinking+budget, one sampling override,
    // web search, voice-out picker
    const think = h.byId['chat-native-think-mode'];
    think.value = 'limit'; think.dispatch('change');
    const bud = h.byId['chat-native-think-budget'];
    bud.value = '400'; bud.dispatch('change');
    const temp = h.byId[h.win.UpliftNativeChat.genInputId('temperature')];
    temp.value = '0.7'; temp.dispatch('change');
    h.byId['chat-native-web'].dispatch('click');           // toggleWeb
    h.win.__store['omlx-uplift-voice'] = 'zuzana';
    await tick();
    assert.equal(h.byId['chat-native-profile'].value, '__variant:P1',
        'a settings change under ANY profile diverges IT (round 11: '
        + 'even a classic-era entry gains a working copy, never a ghost)');
    const sel = h.byId['chat-native-profile'];
    h.byId['chat-native-profile-save'].dispatch('click');
    const { inp, add } = presetRow(h);
    inp.value = 'Setup'; add.dispatch('click');
    const store = JSON.parse(h.win.__store[PROFILE_LS]);
    const setup = store.find((p) => p.name === 'Setup');
    assert.equal(setup.settings.thinking, 'limit');
    assert.equal(setup.settings.thinkingBudget, 400);
    assert.deepEqual(setup.settings.generation, { temperature: 0.7 });
    assert.equal(setup.settings.webSearch, true);
    assert.equal(setup.settings.voice, 'zuzana');
    assert.ok(!('model' in setup.settings),
        'the model is the ONE exception (user: Exception - the model used)');
    assert.equal(sel.value, 'Setup', 'committing snapshots => clean');
    // flip one setting -> the marker is BACK without touching the prompt
    think.value = 'off'; think.dispatch('change');
    assert.equal(sel.value, '__variant:Setup',
        'a settings-only change diverges the profile (round 11)');
    // discard reverts the WHOLE page, not just the prompt
    h.win.confirm = () => true;
    h.byId['chat-native-preset-del'].dispatch('click');
    assert.equal(think.value, 'limit', 'thinking reverted to the snapshot');
    assert.equal(bud.value, '400', 'budget reverted');
    assert.equal(temp.value, '0.7', 'sampling reverted');
    assert.equal(sel.value, 'Setup');
    // switching profiles APPLIES the other page state
    const sys = h.byId['chat-native-sys'];
    sel.value = 'System Default'; sel.dispatch('change'); await tick();
    assert.equal(sys.value, '');
    assert.equal(think.value, 'auto', 'apply = whole-page re-provision');
    assert.equal(h.win.__store['omlx-uplift-voice'] || '', '',
        'voice key follows the profile (unmanaged SD => defaults)');
});

test('variant: BOTH rows show while modified — the saved one REVERTS (round 12)', async () => {
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const sys = h.byId['chat-native-sys'];
    sys.value = 'my precious edit'; sys.dispatch('input');
    assert.equal(sel.value, '__variant:Coder');
    assert.deepEqual(sel.children.map((o) => o.value),
        ['System Default', 'Coder', '__variant:Coder'],
        'T15: the saved preset stays selectable BESIDE its copy');
    // cancelling the revert keeps everything (no silent destruction)
    h.win.confirm = () => false;
    sel.value = 'Coder'; sel.dispatch('change');
    await tick();
    assert.equal(sys.value, 'my precious edit', 'cancel keeps the edits');
    assert.equal(sel.value, '__variant:Coder', 'selection snapped back');
    assert.ok(sel.children.some((o) => o.value === '__variant:Coder'));
    // confirming REVERTS to the saved preset and the rows collapse
    h.win.confirm = () => true;
    sel.value = 'Coder'; sel.dispatch('change');
    await tick();
    assert.equal(sys.value, 'write code', 'reverted to the saved base');
    assert.equal(sel.value, 'Coder');
    assert.deepEqual(sel.children.map((o) => o.value),
        ['System Default', 'Coder'], 'copy dropped, one row again');
    const posts = h.posts.filter((p) => String(p[0]).endsWith('/chat/history'));
    assert.deepEqual(posts[posts.length - 1][1].variants, {},
        'the revert persisted to the conversation');
});

test('variant: settings copies round-trip across switches', async () => {
    const h = bootPreset({ systemPrompt: '', activeProfile: '' },
        [{ name: 'System Default', content: '' },
         { name: 'Setup', content: 'persona',
           settings: { thinking: 'on', webSearch: false } }]);
    for (let i = 0; i < 12; i++) await tick();
    const sel = h.byId['chat-native-profile'];
    const think = h.byId['chat-native-think-mode'];
    // select Setup: its saved page state applies
    sel.value = 'Setup'; sel.dispatch('change'); await tick();
    assert.equal(think.value, 'on', 'Setup applied');
    // diverge its SETTINGS only -> working copy tracks the whole page
    think.value = 'off'; think.dispatch('change'); await tick();
    assert.equal(sel.value, '__variant:Setup');
    // leave and come back: the VARIANT returns, not the base
    sel.value = 'System Default'; sel.dispatch('change'); await tick();
    assert.equal(think.value, 'auto', 'SD re-provisions defaults');
    sel.value = '__variant:Setup'; sel.dispatch('change'); await tick();
    assert.equal(think.value, 'off', 'Setup\'s unsaved settings came back');
    assert.equal(h.byId['chat-native-sys'].value, 'persona');
    const posts = h.posts.filter((p) => String(p[0]).endsWith('/chat/history'));
    const last = posts[posts.length - 1][1];
    assert.equal(last.variants.Setup.settings.thinking, 'off',
        'the copy persisted WITH the conversation (server field)');
});

test('preset: Save prefills the name — keeping it UPDATES, retyping CREATES', async () => {
    const h = bootPreset({ systemPrompt: 'write code', activeProfile: 'Coder' },
        [{ name: 'System Default', content: '' },
         { name: 'Coder', content: 'write code' }]);
    for (let i = 0; i < 12; i++) await tick();
    const sys = h.byId['chat-native-sys'];
    const { row, inp, add } = presetRow(h);
    sys.value = 'write terse code';
    sys.dispatch('input');
    h.byId['chat-native-profile-save'].dispatch('click');
    assert.equal(row.hidden, false, 'Save opens the name row');
    assert.equal(inp.value, 'Coder', 'prefilled with the bound name');
    // (a) keep the name -> update in place
    add.dispatch('click');
    let store = JSON.parse(h.win.__store[PROFILE_LS]);
    assert.deepEqual(store.map((p) => p.name), ['System Default', 'Coder']);
    assert.equal(store[1].content, 'write terse code', 'updated in place');
    assert.equal(h.byId['chat-native-profile'].value, 'Coder',
        'clean again immediately');
    // (b) a different name -> create, the old preset survives intact
    sys.value = 'pirate voice';
    sys.dispatch('input');
    h.byId['chat-native-profile-save'].dispatch('click');
    assert.equal(inp.value, 'Coder', 'prefill always starts from the bound name');
    inp.value = 'Pirate';
    add.dispatch('click');
    store = JSON.parse(h.win.__store[PROFILE_LS]);
    assert.deepEqual(store.map((p) => p.name), ['System Default', 'Coder', 'Pirate']);
    assert.equal(store[1].content, 'write terse code', 'Coder NOT clobbered');
    assert.equal(store[2].content, 'pirate voice');
    assert.equal(h.byId['chat-native-profile'].value, 'Pirate');
    assert.equal(row.hidden, true, 'the row folds after commit');
});

test('preset: unbound draft starts with an empty name; Enter commits, Cancel abandons', async () => {
    const h = bootPreset({ systemPrompt: 'persona X' },
        [{ name: 'System Default', content: '' }]);
    for (let i = 0; i < 12; i++) await tick();
    assert.equal(h.byId['chat-native-profile'].value, '__modified',
        'unbound text with content is custom by definition');
    const { inp, cancel } = presetRow(h);
    h.byId['chat-native-profile-save'].dispatch('click');
    assert.equal(inp.value, '', 'no bound name -> blank draft, not a lie');
    inp.value = 'Typed';
    inp.dispatch('keydown', { key: 'Enter' });
    let store = JSON.parse(h.win.__store[PROFILE_LS]);
    assert.deepEqual(store.map((p) => p.name), ['System Default', 'Typed'],
        'Enter is the commit key (classic rename-row parity)');
    h.byId['chat-native-profile-save'].dispatch('click');
    inp.value = 'Nope';
    cancel.dispatch('click');
    assert.equal(inp.value, '', 'Cancel clears the draft name');
    store = JSON.parse(h.win.__store[PROFILE_LS]);
    assert.equal(store.map((p) => p.name).indexOf('Nope'), -1, 'nothing written');
    assert.equal(h.byId['chat-native-profile'].value, 'Typed',
        'Cancel never changes the binding');
});

test('preset: Delete drops the name but keeps the text; System Default is guarded', async () => {
    const h = bootPreset({ systemPrompt: 'temp text', activeProfile: 'Temp' },
        [{ name: 'System Default', content: 'sd' },
         { name: 'Temp', content: 'temp text' }]);
    for (let i = 0; i < 12; i++) await tick();
    h.win.confirm = () => true;
    h.byId['chat-native-preset-del'].dispatch('click');
    const store = JSON.parse(h.win.__store[PROFILE_LS]);
    assert.equal(store.map((p) => p.name).indexOf('Temp'), -1, 'gone from the store');
    assert.equal(h.byId['chat-native-sys'].value, 'temp text',
        'the prompt text SURVIVES deleting its preset (nothing is lost)');
    assert.equal(h.byId['chat-native-profile'].value, '__modified');
    // bind System Default -> the delete button must go dark (loadProfiles
    // would resurrect it EMPTY: silent content loss, so we forbid it)
    const sel = h.byId['chat-native-profile'];
    sel.value = 'System Default';
    sel.dispatch('change');
    await tick();
    assert.equal(h.byId['chat-native-preset-del'].disabled, true,
        'System Default is not deletable');
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
    assert.ok(/\.message-bubble\.ai-message-text\s*{[^}]*background:\s*(var|color-mix)\(/.test(css),
        'ai pill background stays themed (U81: dim color-mix tint)');
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

test('U45: edit truncates at the user index; delete truncates classic turn-pair style', async () => {
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
    // UP-34 (1d): classic sliceBeforeMessage — deleting an assistant row
    // cuts back to just before ITS user row (the whole turn goes); deleting
    // a user row truncates everything from it on; emptying deletes the chat
    h.win.UpliftNativeChat._msgActions.delete(3);
    assert.deepEqual(st.conv.messages.map(m => m.content), ['one', 'A', 'two'],
        'assistant delete drops its reply and everything after');
    h.win.UpliftNativeChat._msgActions.delete(1);
    assert.deepEqual(st.conv.messages.map(m => m.content), ['one'],
        'cut keeps the question, drops answer onward');
    h.win.UpliftNativeChat._msgActions.delete(0);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(st.conv.messages, [], 'user delete truncates from its index');
    assert.deepEqual(h.dels.map(u => u.split('/').pop()), ['c1'],
        'emptied chat auto-deletes server-side (classic skipConfirm)');
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

test('CHAT-3R: three-region layout — histories left, model/profile top, controls right', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(/layout\.append\(hist, mainCol, side\)/.test(src),
        'hist LEFT | chat column | control rail RIGHT');
    // VOICE-16: the audio-cache pair joins the rail BELOW Delete chat —
    // the user asked for exactly that spot, and both are chat-store hygiene.
    assert.ok(/hist\.append\(histTitle, newBtn, rowIO, sch, list, del,\s*cacheChk, cacheClr\)/.test(src),
        'history rail: caption, new, export+import row, the list, DELETE, cache check+cleanup in-region');
    assert.ok(/cacheChk\.id = 'chat-native-cache-check'/.test(src)
        && /cacheClr\.id = 'chat-native-cache-cleanup'/.test(src),
        'cache buttons are addressable (ids) and never automatic');
    assert.ok(/secModel\.append\(thinkGroup, budGroup\)/.test(src),
        'Model Settings = thinking + budget (round 13)');
    assert.ok(/secVoice\.append\(\s*sttGroup, mic, speakHead, speakRow,/.test(src)
        && /speakRow\.append\(voiceSel, autoBtn\)/.test(src),
        'ROUND 14: one Speak line under the Voice caption — picker + Auto');
    assert.ok(/secSamp\.append\(genRow\)/.test(src)
        && /secTools\.append\(web, helpButtonEl\(\)\)/.test(src),
        'Sampling owns the grid; Tools owns web search + the UP-40 shortcut '
        + 'entry at the bottom (helpButtonEl joins web, nothing moves)');
    assert.ok(/top\.append\(\s*group\(t\('chat\.active_model'[\s\S]*?group\(t\('uplift\.chat\.preset_title'[\s\S]*?profSave, presetDel, nameRow\);/.test(src),
        'top row: Model | Preset | Save | Delete, name row folds below (round 5)');
    assert.ok(!/secPreset|presetActions/.test(src),
        'the rail preset section is gone — nothing left behind');
    assert.ok(!/preset_new|presetNew/.test(src),
        'the New/Save distinction is gone (round 3: one Save button)');
    assert.ok(/side\.append\(secModel, secSys, secSamp, secVoice, secTools\)/.test(src),
        'rail order round 13: Model | System Prompt | Sampling | Voice | Tools');
    assert.ok(/secSys\.append\(sys\)/.test(src)
        && /el\('textarea'\); sys\.id = 'chat-native-sys'/.test(src),
        'System Prompt is the multiline textarea (round 13)');
    assert.ok(!/rowConv|rowPrompt\b|rowGen\b/.test(src),
        'the stacked-rows era is gone (U79 contract moved into the rail)');
    assert.ok(/budGroup/.test(src), 'thinking budget carries a caption group');
    const css = fs.readFileSync(`${STATIC_DIR}/uplift.css`, 'utf8');
    assert.ok(/\.chat-native-layout \{/.test(css) && /\.chat-native-convlist \{/.test(css),
        'layout + history-list CSS shipped');
    assert.ok(/sttPopPlace/.test(src),
        'the voice-input pop is placed by real rects (viewport-aware)');
    assert.ok(/\.chat-native-sec-row\[hidden\] \{ display: none;/.test(css),
        'folded name row must actually collapse (author display beats UA hidden)');
    assert.ok(/\.chat-native-modal \{ position: fixed; inset: 0/.test(css)
        && /\.chat-native-modal-box \{/.test(css),
        'naming row is a fixed modal overlay (round 6), not a bar expander');
    assert.ok(!/chat-native-toprow #chat-native-preset-row/.test(css),
        'the second-line-of-the-bar rule is gone');
    // CHAT-3R bug fix pins: the rail is an overflow scroller — a pop
    // absolutely positioned inside it gets CLIPPED (user: invisible
    // behind the chat box). fixed + real-rect placement + close-on-scroll.
    assert.ok(/\.chat-native-pop \{ position: fixed/.test(css),
        'the voice-input pop escapes the rail clip (fixed)');
    assert.ok(!/\.chat-native-pop \{[^}]*position: absolute/.test(css),
        'no absolute positioning remains on the rail pop');
    assert.ok(/window\.addEventListener\('scroll', sttPopFollow, true\)/.test(src),
        'scroll REPOSITIONS the fixed pop (follow, not close: late-event race)');
    assert.ok(/requestAnimationFrame/.test(src),
        'follow is rAF-coalesced — one placement per frame');
    assert.ok(/\.chat-native-side \{[^}]*overflow-y: auto/.test(css) ||
        /\.chat-native-side \{[^}]*overflow: auto/.test(css),
        'the rail scrolls INTERNALLY (classic drawer), the page does not');
    // regression pin (user report): .chat-native-bar's flex-wrap:wrap is a
    // ROW idiom; in the COLUMN rails surplus content wrapped SIDEWAYS into
    // the chat box. Both rails must be nowrap.
    assert.ok(/\.chat-native-hist\.chat-native-bar \{[^}]*flex-wrap: nowrap/.test(css),
        'history rail never wraps sideways');
    assert.ok(/\.chat-native-side\.chat-native-bar \{[^}]*flex-wrap: nowrap/.test(css),
        'control rail never wraps sideways');
    // CHAT-3R preset keys: ten locales, real translations, matching
    // {name} placeholder multisets (dynamic t() usage is gate-invisible,
    // so this file is the self-pin per the doctrine)
    const PRESET_KEYS = ['preset_title', 'preset_save', 'preset_delete',
        'preset_unsaved', 'preset_modified',
        'preset_delete_confirm', 'preset_discard_confirm', 'preset_created'];
    const en = JSON.parse(fs.readFileSync(`${LOCALES_DIR}/en.json`, 'utf8'));
    const marks = (s) => (String(s).match(/\{name\}/g) || []).length;
    for (const loc of ['en', 'cs', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW']) {
        const d = JSON.parse(fs.readFileSync(`${LOCALES_DIR}/${loc}.json`, 'utf8'));
        for (const name of PRESET_KEYS) {
            const key = `uplift.chat.${name}`;
            const v = d[key];
            assert.ok(v && v.length, `${key} present in ${loc}`);
            assert.equal(marks(v), marks(en[key]),
                `${key} keeps the {name} placeholders in ${loc}`);
            if (loc !== 'en') assert.notEqual(v, en[key],
                `${key} translated in ${loc}, not an EN fill`);
        }
    }
    // ROUND 13/14 section captions: present in all ten; cs keeps the
    // established term 'Sampling' in ENGLISH (user terminology policy) —
    // everything else must read as a real translation
    const R13_KEYS = { stt_settings: 'Input settings', voice_section: 'Voice',
        tools: 'Tools', sampling: 'Sampling', speak_header: 'Speak',
        auto: 'Auto' };
    // words that legitimately stay EN in some locales (terminology policy)
    const SAME_EN = { sampling: ['cs'], auto: ['cs', 'es', 'fr', 'pt-BR'] };
    for (const loc of ['en', 'cs', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW']) {
        const d = JSON.parse(fs.readFileSync(`${LOCALES_DIR}/${loc}.json`, 'utf8'));
        for (const [k, enV] of Object.entries(R13_KEYS)) {
            const v = d[`uplift.chat.${k}`];
            assert.ok(v && v.length, `uplift.chat.${k} present in ${loc}`);
            if (loc !== 'en' && !(SAME_EN[k] || []).includes(loc))
                assert.notEqual(v, enV, `uplift.chat.${k} translated in ${loc}`);
        }
        // captions folded away for good: split voice titles (round 13)
        // and the tall Voice/Auto-speak group stack (round 14 one-liner)
        for (const dead of ['stt_title', 'tts_title', 'autospeak', 'voice'])
            assert.ok(!(`uplift.chat.${dead}` in d),
                `uplift.chat.${dead} pruned from ${loc}`);
    }
});

test('U79-era doctrine: destructive action inside its region (moved to the history rail)', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    // the delete button lives in the HISTORY rail now, right where the
    // conversation being deleted is selected — same intent, new geometry
    assert.ok(/hist\.append\([\s\S]*?del\)/.test(src),
        'DELETE stays inside its group rather than orphaned at a screen edge');
    assert.ok(!/chat-native-pickers/.test(src),
        'the accretion-era pickers row is gone');
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

test('U82: single --radius shape knob; row bands reverted (user dislike)', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    const css = fs.readFileSync(`${STATIC_DIR}/uplift.css`, 'utf8');
    // U82-follow-up (user: 'that background does not look good at all,
    // revert that (just the background)'): NO role-row band painting may
    // come back, in either sheet — the thread rides the plain card ground.
    assert.ok(!/--chat-band-/.test(src) && !/--chat-band-/.test(css),
        'chat band tokens must stay reverted');
    assert.ok(!/outer-message-container[^\n]*role-(user|ai)[^\n]*{[\s\S]{0,40}background/.test(src),
        'no background painting on the full-width message rows');
    // bubble corners ride the knob at 0,2,0 (adopted sheets beat equal specificity)
    assert.ok(/\.message-bubble\.user-message-text,[\s\S]{0,40}\.message-bubble\.ai-message-text\s*{[\s\S]{0,40}border-radius: var\(--radius/.test(src),
        'shadow bubble radius is the knob, not the bundle 10px');
    // the knob is a :root token and the ONLY rectangular radius source
    assert.ok(/--radius: 0px;/.test(css), 'house default is sharp');
    // (comments stripped first: 'border-radius:0' inside a prose comment
    //  matched as a stray value — the U73 comment-vs-code trap)
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stray = [...cssCode.matchAll(/border-radius:\s*([^;}]+)/g)]
        .map(m => m[1].trim())
        .filter(v => !v.includes('var(--radius)') && v !== '50%' && !v.includes('999'));
    assert.deepEqual(stray, [], 'every rectangular radius derives from --radius (circles/pills excepted)');
    // selects are flat house boxes with a drawn caret (the macOS bezel fix)
    assert.ok(/select\s*\{\s*-webkit-appearance: none; appearance: none;/.test(css),
        'global appearance:none — no native bezel anywhere');
    assert.ok(/background-image: linear-gradient\(45deg, transparent 50%, var\(--dim\) 50%\)/.test(css),
        'house caret replaces the native arrow');
});

test('NEW-CHAT-1: a new chat inherits the model on screen, not row one', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(/model: preferredModel\(\)/.test(src), 'newConv takes the resolved model');
    assert.ok(!/model: \(_models\[0\] \|\| \{\}\)\.id/.test(src),
        'the first row of the list is not the answer');
    const body = /function preferredModel\(\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(body, 'preferredModel exists');
    assert.ok(/sel && sel\.value/.test(body[0]), 'the picker value wins');
    assert.ok(/_conv && known\[_conv\.model\]/.test(body[0]),
        'then the model of the chat being replaced');
});

/* ---- MATH (KaTeX vendored 2026-10-19): $ / $$ formulas render through
   deep-chat's built-in hook (window.katex, MathML output); \( \) and
   \[ \] normalize at the DISPLAY layer, the store keeps raw markdown. -- */

test('MATH: the vendored KaTeX ships and renders MathML', () => {
    const f = `${STATIC_DIR}/vendor/katex/katex.min.js`;
    assert.ok(fs.existsSync(f), 'katex.min.js is vendored');
    const k = require(f);   // UMD under node; repo's own checked-in vendor file
    assert.equal(typeof k.renderToString, 'function', 'renderToString present');
    const out = k.renderToString('x^2', { displayMode: false,
                                          throwOnError: false, output: 'mathml' });
    assert.ok(out.includes('<math'), 'mathml output renders');
    // the exact formula class that produced the user bug report
    const doom = k.renderToString('B\\left(P(\\text{doom}) = 1.0\\right)',
        { displayMode: true, throwOnError: false, output: 'mathml' });
    assert.ok(doom.includes('display="block"'), 'block form gets display=block');
});

test('MATH: katex present arms the element; absent leaves literal text', async () => {
    const h = await booted(makeHarness({ katexPresent: true }));
    const M = h.win.UpliftNativeChat;
    M.mount(); await booted(h);
    assert.deepEqual(M._state().dc.remarkable, { math: true },
        'remarkable.math armed at creation (before append)');
    // failure path: no library -> the option must NOT be set, because the
    // hook renders math as the EMPTY string when window.katex is missing —
    // worse than today's literal text
    const h2 = await booted(makeHarness());
    const M2 = h2.win.UpliftNativeChat;
    M2.mount(); await booted(h2);
    assert.equal(M2._state().dc.remarkable, undefined,
        'no katex -> no arming; boot never stalls on the loader');
});

test('MATH: normMath rewrites only the alt delimiters', () => {
    const M = makeHarness().win.UpliftNativeChat;
    const N = M._normMath;
    assert.equal(N('solve \\[x^2\\] now'), 'solve $$x^2$$ now');
    assert.equal(N('so \\(a+b\\) holds'), 'so $a+b$ holds');
    assert.equal(N('$x$ and $$y$$ stay'), '$x$ and $$y$$ stay');
    assert.equal(N('no math \\[ here'), 'no math \\[ here');  // unclosed untouched
    assert.equal(N('a \\+ b'), 'a \\+ b');
    assert.equal(N(null), null);
});

test('MATH: both render paths normalize, the store stays raw', () => {
    const src = fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8');
    assert.ok(/signals\.onResponse\(\{ text: normMath\(c\.text\) \}\)/.test(src),
        'stream leg normalizes before the bubble sees it');
    assert.ok(/text \+= c\.text;/.test(src),
        'accumulated (stored) text remains the RAW chunk');
    // UP-43 forced edit (intent preserved, mechanism adapted): the reload
    // path still normalizes STRING content at render time — the pin now
    // matches the ternary that added the attachment-only placeholder arm.
    assert.ok(/text: m\.content \? normMath\(String\(m\.content\)\)\s*\n?\s*: attViewText\(m\)/.test(src),
        'reload path normalizes at render time');
    assert.ok(!/speakFeed\(normMath/.test(src),
        'voice feed keeps its own sanitizer path untouched');
});

test('BUG-7: switching conversations restores thinking mode, budget and clean preset settings', async () => {
    const h = makeHarness({
        localStorage: { [PROFILE_LS]: JSON.stringify([
            { name: 'System Default', content: '' },
            { name: 'Fast', content: 'be fast',
              settings: { thinking: 'off', thinkingBudget: null, webSearch: false } },
            { name: 'Deep', content: 'think hard',
              settings: { thinking: 'limit', thinkingBudget: 2048, webSearch: true } },
        ]) },
        convs: [
            { id: 'c1', title: 'One', model: 'M1',
              systemPrompt: 'be fast', activeProfile: 'Fast',
              thinking: 'off', thinkingBudget: null, messages: [{ role: 'user', content: 'hi' }] },
            { id: 'c2', title: 'Two', model: 'M1',
              systemPrompt: 'think hard', activeProfile: 'Deep',
              thinking: 'limit', thinkingBudget: 2048, messages: [{ role: 'user', content: 'yo' }] },
            { id: 'c3', title: 'LegacyBool', model: 'M1',
              systemPrompt: '', activeProfile: '',
              thinking: true, thinkingBudget: null, messages: [{ role: 'user', content: 'old' }] },
        ],
    });
    const M = h.win.UpliftNativeChat;
    M.mount();
    for (let i = 0; i < 12; i++) await tick();
    const think = h.byId['chat-native-think-mode'];
    const bud = h.byId['chat-native-think-budget'];
    const list = h.byId['chat-native-convs'];
    const btnFor = (id) => [...list.children].flatMap((n) =>
        (n.dataset && n.dataset.id !== undefined) || String(n.tagName).toLowerCase() === 'button'
            ? [n] : [...(n.children || [])]).find((x) => x.dataset && x.dataset.id === id);

    // Switch to c1 (clean preset 'Fast' -> thinking 'off')
    btnFor('c1').dispatch('click');
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(think.value, 'off', 'c1 restores Fast preset thinking=off');
    assert.equal(M._state().conv.thinking, 'off');
    let req = (await M.shapeRequest({
        body: { messages: [{ role: 'user', text: 'q' }] }, headers: {} })).body;
    assert.equal(req.chat_template_kwargs.enable_thinking, false,
                 'shapeRequest honours restored off mode (chat_template_kwargs, classic spelling)');

    // Switch to c2 (clean preset 'Deep' -> thinking 'limit', budget 2048)
    btnFor('c2').dispatch('click');
    // UP-34: the shapeRequest above left _streaming set (no turn completion in
    // this harness), so openConv now settles it (80ms) before swapping
    await new Promise(r => setTimeout(r, 150));
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(think.value, 'limit', 'c2 restores Deep preset thinking=limit');
    assert.equal(bud.value, '2048', 'c2 restores budget input');
    assert.equal(bud.hidden, false, 'budget input unhidden on limit');
    req = (await M.shapeRequest({
        body: { messages: [{ role: 'user', text: 'q' }] }, headers: {} })).body;
    assert.equal(req.chat_template_kwargs.enable_thinking, true);
    assert.equal(req.thinking_budget, 2048);

    // Switch to c3 (legacy boolean thinking:true in store -> coerced to 'auto')
    btnFor('c3').dispatch('click');
    await new Promise(r => setTimeout(r, 150));   // UP-34 settle (see c2 note)
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(M._state().conv.thinking, 'auto', 'legacy boolean thinking coerced to auto');
    assert.equal(think.value, 'auto', 'select synced back to auto');
    assert.equal(bud.hidden, true, 'budget hidden again when leaving limit');
});
