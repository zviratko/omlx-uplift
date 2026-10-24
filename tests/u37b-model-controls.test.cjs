/* UP-37 gate (chat lane) — items 1 + 3 of the card:
   1. PER-MODEL REASONING STOPS. classic chat.html:3062-3095: the thinking
      control's stops come from the server row's reasoning_levels
      ('off' only where the template has a switch, then 'auto', then 'on' or
      the effort levels), and a model that declares NOTHING gets no control
      (:2177). The chosen stop rides conv.thinking (BUG-7 semantics kept) and
      an EFFORT stop ships TOP-LEVEL reasoning_effort exactly like classic's
      snapshotGenerationSettings (:3780-3782) — with enable_thinking derived
      the way setReasoningLevel derives it (:3113-3116: ON only where an
      'off' stop proves the switch; a forced/K2 model gets no switch).
   3. PER-MODEL SETTINGS MEMORY. classic modelSettingsByModel (:3146-3202,
      selectModel :5656-5687): leaving a model captures its knob set, coming
      back restores it. ONE deliberate divergence, documented in place: a
      FIRST visit to a model keeps the live page instead of blanking it,
      because classic seeds that reset from an /api/models/<id>/settings
      fetch (ensureSessionModelSettings :5326) that this lane does not own —
      clearing without it would be data loss, not defaults. The per-model
      separation the card asks for is intact either way.

   (vm sandbox + DOM stub, nat4-chat-mount pattern. TWO deliberate stub
   upgrades over nat4: append() records parentNode (the picker's group hides
   through it) and a <select> IGNORES a value with no matching option, like a
   real browser — that is precisely the trap the stop-list rebuild has to
   survive.)

   SERVER FOLLOW-UP (owner lands; routers/chat.py is NOT in this lane):
   the conv save whitelist pins `thinking` to ("auto","off","on","limit"),
   so an EFFORT stop and the per-model map do not survive a reload. The exact
   addition in `save_conversation` (omlx_uplift/routers/chat.py, the
   `"thinking":` entry at :352-359):

       # UP-37: the reasoning stop is the model's own vocabulary (classic
       # reasoningStops): auto/off/on/limit plus an effort level the row
       # declares. Shape-checked here; the picker decides legality.
       "thinking": (body.get("thinking") if isinstance(body.get("thinking"), str)
                    and _STOP_RE.fullmatch(body.get("thinking") or "") else "auto"),
       # UP-37: per-model knob sets {model: {thinking, thinkingBudget,
       # generation}} — one entry per model, keys capped hard.
       "modelSettingsByModel": _clean_by_model(body.get("modelSettingsByModel")),

   with, at module level:

       _STOP_RE = re.compile(r"[a-z][a-z0-9_-]{0,15}")

       def _clean_by_model(raw):
           if not isinstance(raw, dict):
               return {}
           out = {}
           for k, v in list(raw.items())[:16]:
               key = str(k or "")[:120]
               if not key or not isinstance(v, dict):
                   continue
               th = v.get("thinking")
               gen = _clean_generation(v.get("generation"))
               tb = v.get("thinkingBudget")
               out[key] = {
                   "thinking": th if isinstance(th, str) and _STOP_RE.fullmatch(th)
                               else "auto",
                   "thinkingBudget": tb if isinstance(tb, int)
                                     and not isinstance(tb, bool) and tb >= 0 else None,
                   "generation": gen,
               }
           return out

   Third whitelist in the same file, same relaxation — `_clean_message`'s
   per-turn `params` block (:207-219) keeps GEN_KEYS + enable_thinking +
   thinking_budget, so the U78 provenance chip LOSES the effort bit on
   reload while it shows live. Add beside the thinking_budget line:

       re = raw_p.get("reasoning_effort")
       if isinstance(re, str) and _STOP_RE.fullmatch(re):
           clean_p["reasoning_effort"] = re

   plus a pytest roundtrip in test_nat4_chat_backend.py: POST a conv with
   thinking='high' and modelSettingsByModel={'A': {...}, 'B': {...}}, GET it
   back, assert BOTH survived (and a 5 KB junk blob collapses to the pinned
   defaults, never a 500). `_clean_state`'s profile whitelist (:93-95) takes
   the same _STOP_RE relaxation so a preset can carry an effort stop.
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = fs.readFileSync(path.join(STATIC_DIR, 'uplift_chat.js'), 'utf8');

// ---- DOM stub ---------------------------------------------------------------
function mkEl(tag, byId) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
        className: '', textContent: '', title: '', hidden: false, type: '',
        parentNode: null, isContentEditable: false,
        _value: '',
        get value() {
            if (tag === 'option' && this._value === '') return this.textContent;
            return this._value == null ? '' : this._value;
        },
        // REAL <select> semantics: assigning a value no option carries is a
        // NO-OP that leaves the control unselected. A naive stub hides the
        // whole class of stop-list bugs.
        set value(v) {
            const s = String(v == null ? '' : v);
            if (tag === 'select' && this.children.length &&
                !this.children.some((o) => o.value === s)) { this._value = ''; return; }
            this._value = (tag === 'input') ? s.replace(/[\r\n]/g, '') : s;
        },
        get id() { return this._id; },
        set id(v) { this._id = v; if (v && byId) byId[v] = this; },
        replaceChildren(...ks) {
            this.children = ks;
            ks.forEach((k) => { k.parentNode = this; });
        },
        append(...ks) { ks.forEach((k) => this.appendChild(k)); },
        appendChild(k) {
            if (k.parentNode) {
                const i = k.parentNode.children.indexOf(k);
                if (i >= 0) k.parentNode.children.splice(i, 1);
            }
            this.children.push(k); k.parentNode = this; return k;
        },
        insertBefore(k) { this.children.unshift(k); k.parentNode = this; return k; },
        _lis: {},
        addEventListener(t2, fn) { (this._lis[t2] = this._lis[t2] || []).push(fn); },
        removeEventListener() {},
        dispatch(t2, ev) {
            (this._lis[t2] || []).forEach((fn) => fn(
                Object.assign({ stopPropagation() {}, preventDefault() {}, target: this }, ev)));
        },
        querySelector() { return mkEl('div', byId); },
        querySelectorAll() { return []; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
        remove() {
            const p = this.parentNode;
            if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); }
            this.parentNode = null;
        },
        focus() {}, blur() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        oninput: null, onchange: null, onclick: null,
    };
    return el;
}

const CAT = {};                       // no catalog: every label must fall back

function makeHarness(opts) {
    opts = opts || {};
    const byId = {};
    const shadow = {
        children: [],
        appendChild(k) { this.children.push(k); return k; },
        getElementById(id) { return this.children.find((c) => c.id === id) || null; },
        querySelectorAll() { return []; },
    };
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = mkEl('div', byId)); },
        createElement(tag) {
            const e = mkEl(tag, byId);
            if (tag === 'deep-chat') e.shadowRoot = shadow;
            return e;
        },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        head: { appendChild() {} },
        documentElement: { dataset: { nativeSurfaces: 'all' } },
        body: mkEl('body', byId),
        addEventListener() {},
    };
    const posts = [];
    const keys = [];
    const store = Object.assign({}, opts.localStorage || {});
    const win = {
        UpliftCore: { t: (k) => (CAT[k] == null ? k : CAT[k]) },
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: opts.models || MODELS };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history'))
                    return (opts.convs || []).map((c) => ({ id: c.id, title: c.title,
                        model: c.model, message_count: (c.messages || []).length,
                        updated: 1 }));
                const m = u.match(/\/chat\/history\/(.+)$/);
                if (m) {
                    const c = (opts.convs || []).find((x) => x.id === m[1]);
                    if (c) return c;
                    throw new Error('404');
                }
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, body) => { posts.push([String(u), body]); return { status: 'saved', kb: 1 }; },
            deleteJson: async () => ({ ok: 1 }),
            toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document,
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        __posts: posts, __keys: keys,
        addEventListener(t2, fn) { if (t2 === 'keydown') keys.push(fn); },
        removeEventListener() {},
        MutationObserver: function () { this.observe = () => {}; },
        prompt: () => null, confirm: () => true,
        setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
        setInterval: () => 1, clearInterval: () => {},
        __store: store,
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
            removeItem: (k) => { delete store[k]; },
        },
    };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    new vm.Script(SRC).runInContext(ctx);
    win.M = win.UpliftNativeChat;
    return win;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function booted(win) {
    win.M.mount();
    for (let i = 0; i < 14; i++) await tick();
    return win;
}

// Rows in the shapes the vanilla admin route really emits
// (omlx/admin/routes.py:_reasoning_levels / _model_options).
const MODELS = [
    // toggle model: a thinking switch, no effort levels
    { id: 'SW', engine_type: 'batched', model_type: 'llm',
      reasoning_levels: ['off', 'on'] },
    // effort model WITH a switch (deepseek-v4 family + thinking_default)
    { id: 'EFF', engine_type: 'batched', model_type: 'llm',
      reasoning_levels: ['off', 'low', 'medium', 'high'],
      thinking_modes: ['auto', 'on_unlimit', 'on_limit', 'off'] },
    // K2: forced thinking, efforts, NO off stop, on_limit only. NOTE the
    // two type fields (CHAT-FILTER): model_type is the CAPABILITY the chat
    // picker filters on — a K2 chat model is still 'llm'; k2_horizon is the
    // config_model_type the SERVER used to build these fields.
    { id: 'K2', engine_type: 'batched', model_type: 'llm',
      reasoning_levels: ['low', 'medium', 'high'], thinking_forced: true,
      thinking_modes: ['auto', 'on_limit'] },
    // plain instruct model: declares nothing
    { id: 'PLAIN', engine_type: 'batched', model_type: 'llm' },
    // a row that says thinking is auto-only: no budget stop either
    { id: 'NOBUDGET', engine_type: 'batched', model_type: 'llm',
      reasoning_levels: ['off', 'on'], thinking_modes: ['auto', 'off'] },
];

// ---- 1: classic's stop math --------------------------------------------------
test('stops come from the row: off only with a switch, auto always, then the levels', () => {
    const S = makeHarness().M._u37b;
    assert.deepEqual(S.reasoningStops({ reasoning_levels: ['off', 'on'] }),
                     ['off', 'auto', 'on'], 'classic :3068-3073 order');
    assert.deepEqual(S.reasoningStops({ reasoning_levels: ['low', 'medium', 'high'] }),
                     ['auto', 'low', 'medium', 'high'], 'no off stop declared -> no off stop');
    assert.deepEqual(S.reasoningStops({}), [], 'a model with no levels has NO control');
    assert.deepEqual(S.reasoningLevels({ reasoning_levels: 'junk' }), [],
                     'a non-array levels field is no levels');
});

test('the budget stop joins where classic offers on_limit — and only there', () => {
    const S = makeHarness().M._u37b;
    assert.deepEqual(S.thinkingStops({ reasoning_levels: ['off', 'on'] }),
                     ['off', 'auto', 'on', 'limit'],
                     'a row that predates thinking_modes keeps the budget');
    const eff = S.thinkingStops(MODELS[1]);
    assert.deepEqual(eff, ['off', 'auto', 'low', 'medium', 'high', 'limit'],
                     'limit sits beside On, the efforts after it');
    assert.deepEqual(S.thinkingStops(MODELS[2]), ['auto', 'low', 'medium', 'high', 'limit'],
                     'K2: no off stop, budget stays (its only limit)');
    assert.deepEqual(S.thinkingStops(MODELS[3]), [], 'no control at all');
    assert.deepEqual(S.thinkingStops(MODELS[4]), ['off', 'auto', 'on'],
                     'thinking_modes without on_limit removes the budget stop');
});

// ---- 2: the picker is rebuilt per model --------------------------------------
test('the think picker offers EXACTLY the selected model stops — never a static list', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    const think = win.document.getElementById('chat-native-think-mode');
    assert.deepEqual(think.children.map((o) => o.value),
                     ['off', 'auto', 'low', 'medium', 'high', 'limit'],
                     'effort stops replace the static auto/on/limit/off four');
    // labels: the legacy four keep classic's thinking_mode keys, the efforts
    // go through chat.reasoning.level.<level> (classic :3085)
    assert.equal(think.children[0].textContent, 'Off');
    assert.equal(think.children[3].textContent, 'Medium',
                 'an effort stop renders its classic level label, not the raw token');
    assert.equal(think.parentNode.hidden, false, 'a model WITH stops shows the control');
    assert.equal(think.value, 'auto', 'a fresh conv sits on Auto');
});

test('a model that declares no reasoning control gets NO thinking control', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'PLAIN', systemPrompt: '', messages: [] }],
    }));
    const think = win.document.getElementById('chat-native-think-mode');
    assert.equal(think.children.length, 0, 'no stops to offer');
    assert.equal(think.parentNode.hidden, true,
                 'classic :2177 hides the pill when reasoningStops() is empty');
});

test('a stored stop the new model lacks clamps to auto (select would drop it anyway)', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'SW', thinking: 'limit',
                  systemPrompt: '', messages: [] }],
    }));
    const st = win.M._state();
    const think = win.document.getElementById('chat-native-think-mode');
    win.M._u37b.switchChatModel('NOBUDGET');   // SW has the budget; NOBUDGET does not
    assert.equal(st.conv.thinking, 'auto', 'the illegal limit stop is gone from state');
    assert.equal(think.value, 'auto', 'and the picker says the same — no blank select');
});

// ---- 3: the wire --------------------------------------------------------------
async function bodyFor(win, model, thinking, budget) {
    const st = win.M._state();
    st.conv.model = model;
    st.conv.thinking = thinking;
    st.conv.thinkingBudget = (budget === undefined ? null : budget);
    const d = await win.M.shapeRequest({ body: { messages: [] }, headers: {} });
    return (typeof d.body === 'string' ? JSON.parse(d.body) : d.body);
}
const ctk = (b) => b.chat_template_kwargs && b.chat_template_kwargs.enable_thinking;

test('an effort stop ships TOP-LEVEL reasoning_effort (classic :3780-3782)', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    let b = await bodyFor(win, 'EFF', 'medium');
    assert.equal(b.reasoning_effort, 'medium', 'the level travels as its own field');
    assert.equal(ctk(b), true,
                 'and thinking is switched ON because an off stop proves a template switch');
    assert.ok(!('thinking_budget' in b), 'no budget without the limit stop');
    b = await bodyFor(win, 'EFF', 'high');
    assert.equal(b.reasoning_effort, 'high');
    b = await bodyFor(win, 'EFF', 'auto');
    assert.ok(!('reasoning_effort' in b) && !ctk(b), 'Auto ships nothing (model default)');
    b = await bodyFor(win, 'EFF', 'off');
    assert.equal(ctk(b), false, 'the off stop keeps UP-37(2) semantics');
    assert.ok(!('reasoning_effort' in b), 'off carries no level');
});

test('K2 (forced thinking): the level ships, the template switch does NOT', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'K2', systemPrompt: '', messages: [] }],
    }));
    const b = await bodyFor(win, 'K2', 'high');
    assert.equal(b.reasoning_effort, 'high');
    assert.ok(!('chat_template_kwargs' in b),
              'classic: a forced model has no switch to set (:3116 + :3774)');
    const lim = await bodyFor(win, 'K2', 'limit', 3000);
    assert.equal(lim.thinking_budget, 3000, 'the budget is K2 s only limit');
    assert.ok(!('chat_template_kwargs' in lim));
});

test('a level the model never declares cannot reach the wire', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'SW', systemPrompt: '', messages: [] }],
    }));
    // SW declares only off/on; a stale 'high' (another model's stop) is inert
    const b = await bodyFor(win, 'SW', 'high');
    assert.ok(!('reasoning_effort' in b), 'no effort for a model without levels');
    assert.ok(!ctk(b), 'and no enable_thinking either — it is Auto, not On');
});

test('the effort enters the U78 turn snapshot and the provenance chip', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    // _turnParams copies every body key except model/messages/stream/tools/
    // stream_options, so an effort stop lands in the PER-TURN snapshot the
    // bubble chip reads — it must not need a filter (paramsLabel prints only
    // known keys, so nothing unknown can leak as junk).
    const b = await bodyFor(win, 'EFF', 'medium');
    assert.equal(b.reasoning_effort, 'medium');
    // drive the component's commit order (bubble recorded, stream closed) and
    // the ANSWER row must carry the effort it was sampled with — the U78 chip
    // reads row.params, so this is the whole provenance path.
    const st = win.M._state();
    st.dc.onMessage({ isHistory: false, message: { role: 'user', text: 'go' } });
    st.dc.onMessage({ isHistory: false, message: { role: 'ai', text: 'ok' } });
    await tick();
    const rows = st.conv.messages;
    const ai = rows[rows.length - 1];
    assert.equal(ai.role, 'assistant', 'the turn committed');
    assert.equal(ai.params && ai.params.reasoning_effort, 'medium',
                 'effort rides the per-turn provenance snapshot');
    // classic prints effort in the per-turn summary (chat.html:7144)
    assert.match(SRC, /bits\.push\('effort ' \+ pp\.reasoning_effort\)/);
    assert.match(SRC, /if \(effort\) body\.reasoning_effort = effort;/);
});

// ---- 4: per-model settings memory (classic modelSettingsByModel) --------------
test('switching models keeps each model its OWN knob set', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    const st = win.M._state();
    st.conv.thinking = 'medium';
    st.conv.thinkingBudget = null;
    st.conv.generation = { temperature: 0.3, top_k: 20 };
    win.M._u37b.saveModelSettingsForModel(st.conv, st.conv.model);

    // to K2 — a FIRST visit inherits the page (classic would seed that
    // model's admin defaults from /api/models/<id>/settings, a fetch this
    // lane does not own; see loadModelSettingsForModel) and immediately owns it
    assert.equal(win.M._u37b.switchChatModel('K2'), true);
    assert.equal(st.conv.thinking, 'medium', 'nothing is destroyed on the way in');
    assert.equal(st.conv.modelSettingsByModel.K2.thinking, 'medium',
                 'K2 already owns a snapshot of its own');

    // K2 changes its OWN knobs...
    st.conv.thinking = 'low';
    st.conv.generation = { temperature: 1.9 };
    // ...and coming back restores EFF exactly (classic loadModel... :3167)
    win.M._u37b.switchChatModel('EFF');
    assert.equal(st.conv.thinking, 'medium', 'the effort stop is EFF s again');
    assert.deepEqual(st.conv.generation, { temperature: 0.3, top_k: 20 },
                     'the sampling overrides return with the model');
    assert.equal(st.conv.modelSettingsByModel.EFF.thinking, 'medium',
                 'classic s per-model map is the store');
    // and the pair stayed separate: K2 kept what EFF does not have
    assert.equal(st.conv.modelSettingsByModel.K2.thinking, 'low',
                 'the model being LEFT kept what it was changed to');
    win.M._u37b.switchChatModel('K2');
    assert.equal(st.conv.thinking, 'low', 'K2 returns to K2 s own set');
    assert.deepEqual(st.conv.generation, { temperature: 1.9 });
});

test('the picker AND the sampling inputs follow the switch (no lying UI)', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    const st = win.M._state();
    st.conv.thinking = 'high';
    st.conv.generation = { temperature: 0.9 };
    win.M._u37b.saveModelSettingsForModel(st.conv, 'EFF');
    const think = win.document.getElementById('chat-native-think-mode');
    const temp = win.document.getElementById('chat-native-gen-temperature');
    win.M._u37b.switchChatModel('K2');
    assert.deepEqual(think.children.map((o) => o.value),
                     ['auto', 'low', 'medium', 'high', 'limit'], 'K2 stops painted');
    assert.equal(think.value, 'high', 'K2 keeps the page on the way in (nothing lost)');
    assert.equal(temp.value, '0.9', 'and the input still shows the live value');
    // EFF s own set is untouched by anything K2 does afterwards
    st.conv.thinking = 'auto';
    st.conv.generation = null;
    win.M._u37b.switchChatModel('EFF');
    assert.equal(think.value, 'high', 'EFF s stop back in the picker');
    assert.equal(temp.value, '0.9', 'EFF s temperature back in its input');
});

test('the picker s own change event runs the capture/restore, and saves', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    const st = win.M._state();
    st.conv.thinking = 'low';
    st.conv.generation = { min_p: 0.1 };
    const picker = win.document.getElementById('chat-native-model');
    picker.value = 'K2';
    picker.dispatch('change');
    await tick();
    assert.equal(st.conv.model, 'K2', 'the switch happened');
    assert.equal(st.conv.modelSettingsByModel.EFF.thinking, 'low',
                 'the model being LEFT was captured (classic selectModel :5660-5662)');
    const saved = win.__posts.filter((p) => /\/chat\/history$/.test(p[0])).pop();
    assert.equal(saved[1].model, 'K2', 'BUG-7: the switch persists with the conversation');
    assert.ok(saved[1].modelSettingsByModel.EFF,
              'the map rides the save body (server whitelist = the follow-up above)');
});

test('a legacy conversation seeds its flat knobs into its model entry', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', thinking: 'medium',
                  thinkingBudget: 1024, generation: { top_p: 0.5 },
                  systemPrompt: '', messages: [] }],
    }));
    const st = win.M._state();
    assert.equal(st.conv.modelSettingsByModel.EFF.thinking, 'medium',
                 'classic :5876-5883: the pre-map state becomes the model s entry');
    assert.equal(st.conv.modelSettingsByModel.EFF.thinkingBudget, 1024);
    win.M._u37b.switchChatModel('SW');
    win.M._u37b.switchChatModel('EFF');
    assert.equal(st.conv.thinking, 'medium', 'so the first round-trip does not lose it');
    assert.deepEqual(st.conv.generation, { top_p: 0.5 });
});

test('branch inherits the map as a DEEP copy (classic branchChat :7406)', () => {
    const S = makeHarness().M;
    // newConv mints a fresh map per conversation — never a shared object
    const a = S.newConv(), b = S.newConv();
    assert.deepEqual(a.modelSettingsByModel, {}, 'a new chat starts with an empty map');
    assert.notEqual(a.modelSettingsByModel, b.modelSettingsByModel,
                    'two chats never share the map object (the variants bug class)');
    // the branch path carries it through JSON (the full branch drill is
    // u29's gate; this is the pin for the new field)
    assert.match(SRC, /b\.modelSettingsByModel = src\.modelSettingsByModel\s*\n?\s*\? JSON\.parse\(JSON\.stringify\(src\.modelSettingsByModel\)\) : \{\}/);
});

test('picking an effort stop in the UI: state, save body and profile snapshot', async () => {
    const win = await booted(makeHarness({
        convs: [{ id: 'c1', title: 'T', model: 'EFF', systemPrompt: '', messages: [] }],
    }));
    const st = win.M._state();
    const think = win.document.getElementById('chat-native-think-mode');
    think.value = 'medium';
    think.dispatch('change');
    await tick();
    assert.equal(st.conv.thinking, 'medium', 'BUG-7: the CHOSEN STOP is the stored value');
    const saved = win.__posts.filter((p) => /\/chat\/history$/.test(p[0])).pop();
    assert.equal(saved[1].thinking, 'medium',
                 'the client sends it (the server whitelist is the documented follow-up)');
    assert.equal(win.M.chatSettingsSnapshot().thinking, 'medium',
                 'a preset captures the effort stop, not a collapsed auto');
    // and it survives a preset round-trip: apply writes back through the picker
    st.conv.thinking = 'auto';
    win.M._u37b.syncThinkOptions(think);
    assert.equal(think.value, 'auto');
    assert.equal(win.M.chatSettingsSnapshot().thinking, 'auto',
                 'auto stays distinct from a level — no false "same as preset"');
});

// ---- 5: profiles stay model-agnostic -----------------------------------------
test('a preset still captures the stop as text — the model is not in the blob', async () => {
    const win = makeHarness();
    const snap = win.M.chatSettingsSnapshot();
    assert.ok('thinking' in snap && !('model' in snap),
              'the profile blob owns the stop, never the model (round 9 doctrine)');
    assert.equal(win.M._u37b.normThinkValue('High'), 'auto',
                 'stops are lowercase tokens; junk normalises to auto');
    assert.equal(win.M._u37b.normThinkValue(null), 'auto');
    assert.equal(win.M._u37b.normThinkValue('x'.repeat(30)), 'auto', 'capped');
});

test('the static option list is GONE from the source (no regression path)', () => {
    assert.ok(!/\[\['auto', 'chat\.thinking_mode\.auto', 'Auto'\]/.test(SRC),
              'the four hardcoded stops must not come back');
    assert.match(SRC, /syncThinkOptions\(think\)/,
                  'the toolbar builds its picker from the model row');
});
