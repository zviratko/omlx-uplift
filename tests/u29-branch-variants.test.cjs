/* UP-29 gate: chat branch + regenerate variants + regenerate options —
   ONE rework on _conv storage (classic chat.html branchChat :7365-7410,
   regenerateMessage :7199 + options :7218-7233, variant tabs :3440-3510).

   Coverage (ticket gates):
   1. branch slice correctness — up to and INCLUDING the user row, deep
      copies (no shared row objects between chats), inheritance of
      model/systemPrompt/activeProfile/customPrompt/thinking/generation/
      variants(+customState), title 'Branch of <t>', pinned:false, the
      switch lands via the EXISTING server save + openConv; streaming
      refusal (after stopAndSettle, UP-34 doctrine); user-row guard.
   2. variant append/switch/delete invariants — parked-chain merge after
      the regenerate's answer lands (order: user, older hidden chain,
      newer shown chain), the store-visible ordinals (isVisibleRow, incl.
      UP-43 att placeholder rows) stay 1:1 with bubbles, select flips
      vsel only, delete-one drops the chain, collapses to a PLAIN turn
      (markers cleared) and refuses to remove the last reply, msgDelete
      on the chain takes the hidden siblings with it (truncation rule),
      and a stream that produced NOTHING restores the parked chain.
   3. creative temp math (classic :7218-7223 mirrored: base+0.4 capped
      at 2, 1.2 when no sane base) — and the one-shot travels shapeRequest
      exactly ONCE, visible in the U78 body snapshot.
   4. model-list filter parity: the 'Regenerate with…' picker is built
      from _models — the SAME filtered list as the header select (STT /
      embedding rows can never appear in either).
   5. the wire: hidden variants never enter the model context
      (classic getApiTurnMessages :3440 sends the ACTIVE chain only).

   SERVER FOLLOW-UP (owner lands; chat.py is NOT in this lane):
   _clean_message currently drops the vg/vid/vsel/rmodel keys on reload.
   The exact addition — inside _clean_message (omlx_uplift/routers/
   chat.py), immediately AFTER the att block (:225-229) and BEFORE
   `return out`:

       # UP-29: regenerate variants. vg = group id (one per regenerated
       # user turn), vid = chain id (rows sharing vg+vid are ONE reply),
       # vsel = 1 shown / 0 hidden sibling. Client-minted opaque tokens,
       # capped hard; assistant rows only (the send path mints them).
       if role == "assistant":
           vg = m.get("vg")
           if isinstance(vg, str) and 0 < len(vg) <= 40:
               out["vg"] = vg
               vid = m.get("vid")
               if isinstance(vid, str) and 0 < len(vid) <= 40:
                   out["vid"] = vid
               if m.get("vsel") in (0, 1):
                   out["vsel"] = int(m.get("vsel"))
           rm = m.get("rmodel")
           if isinstance(rm, str) and rm:
               out["rmodel"] = rm[:120]   # variant tab label (display)

   plus this pytest roundtrip for tests/test_nat4_chat_backend.py:

       def test_u29_variant_markers_roundtrip(client):
           """UP-29: vg/vid/vsel/rmodel survive save+load. Until this
           lands the FE degrades to no-strip consecutive replies (the
           markers are dropped), never a loss."""
           conv = {"id": "cv29", "title": "T", "model": "M", "messages": [
               {"role": "user", "content": "go"},
               {"role": "assistant", "content": "one", "vg": "g1",
                "vid": "v1", "vsel": 0, "rmodel": "ModelA"},
               {"role": "assistant", "content": "two", "vg": "g1",
                "vid": "v2", "vsel": 1, "rmodel": "ModelB" * 1},
               {"role": "assistant", "content": "junk", "vg": "x" * 60,
                "vid": 7, "vsel": 5},
               {"role": "user", "content": "user marker ignored",
                "vg": "g2", "vid": "v9", "vsel": 1},
           ]}
           assert client.post("/uplift/api/chat/history",
                              json=conv).status_code == 200
           got = client.get("/uplift/api/chat/history/cv29").json()["messages"]
           assert got[1]["vg"] == "g1" and got[1]["vid"] == "v1"
           assert got[1]["vsel"] == 0 and got[1]["rmodel"] == "ModelA"
           assert got[2]["vid"] == "v2" and got[2]["vsel"] == 1
           assert "vg" not in got[3]            # over-cap vg drops the trio
           assert "vid" not in got[3] and "vsel" not in got[3]
           for k in ("vg", "vid", "vsel"):
               assert k not in got[3] and k not in got[4]  # users: never

   Until that lands: reload drops the markers, every sibling renders as
   an ordinary consecutive assistant bubble (newest LAST = the ticket's
   'newest variant wins' degradation) and the tab strip is gone for the
   reloaded session. Stated on the card, not hidden.
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'),
    'utf8');

const tick = (n) => new Promise((r) => setTimeout(r, n || 1));
async function flush(rounds) {
    for (let i = 0; i < (rounds || 6); i++) await tick(1);
}

// ---- element stub: u35's shape PLUS dispatchable listeners ----------------
function detach(k) {
    const p = k && (k.parentElement || k.parentNode);
    if (p && p.children) { const i = p.children.indexOf(k);
                           if (i >= 0) p.children.splice(i, 1); }
}
function mkEl(tag) {
    const classes = new Set();
    const el = {
        tagName: tag, className: '', textContent: '', children: [],
        dataset: {}, style: {}, attrs: {}, hidden: false,
        parentElement: null, parentNode: null,
        _lis: {}, value: '',
        classList: {
            add: (...cs) => cs.forEach((c) => classes.add(c)),
            remove: (...cs) => cs.forEach((c) => classes.delete(c)),
            contains: (c) => classes.has(c),
        },
        appendChild(k) { detach(k); this.children.push(k);
                         k.parentElement = this;
                         k.parentNode = this; return k; },
        append(...ks) { ks.forEach((k) => this.appendChild(k)); },
        insertBefore(k, ref) {
            detach(k);
            const i = this.children.indexOf(ref);
            this.children.splice(i < 0 ? this.children.length : i, 0, k);
            k.parentElement = this; k.parentNode = this; return k;
        },
        remove() {
            const p = this.parentElement || this.parentNode;
            if (p) { const i = p.children.indexOf(this);
                     if (i >= 0) p.children.splice(i, 1); }
        },
        replaceChildren(...ks) { this.children = ks;
                                 ks.forEach((k) => { k.parentElement = this; }); },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
        cloneNode() { const c = mkEl(this.tagName); c.children = []; return c; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(t, f) { (this._lis[t] = this._lis[t] || []).push(f); },
        removeEventListener() {},
        focus() {}, select() {}, blur() {}, closest() { return null; },
        contains(k) {
            for (const c of this.children)
                if (c === k || (c.contains && c.contains(k))) return true;
            return false;
        },
    };
    Object.defineProperty(el, 'childNodes', { get() { return this.children; } });
    return el;
}
function fire(el, type) {
    (el._lis[type] || []).forEach((f) =>
        f({ stopPropagation() {}, preventDefault() {}, target: el }));
}

// ---- vm harness (u35 pattern; stateful /chat/history for branch) ----------
function makeHarness(opts) {
    opts = opts || {};
    const byId = {};
    const created = [];
    const shadow = {
        children: [],
        appendChild(k) { this.children.push(k); return k; },
        getElementById(id) { return this.children.find((c) => c.id === id) || null; },
        querySelectorAll() { return []; },
    };
    const document = {
        getElementById(id) { return byId[id] || (byId[id] = mkEl('div')); },
        createElement(tag) {
            const e = mkEl(tag);
            if (tag === 'deep-chat') e.shadowRoot = shadow;
            created.push(e);
            return e;
        },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        head: { appendChild() {} }, documentElement: { dataset: {} },
        body: mkEl('body'), addEventListener() {}, removeEventListener() {},
    };
    const convs = (opts.convs || [{
        id: 'c1', title: 'T', model: 'M1', systemPrompt: 'SP',
        activeProfile: 'P', customPrompt: 'CP',
        thinking: 'on', thinkingBudget: 512,
        generation: { temperature: 0.7 },
        messages: [],
    }]).map((c) => Object.assign({
        variants: {}, customState: null, pinned: false }, c));
    const posts = [];
    const upsert = (b) => {
        const i = convs.findIndex((c) => c.id === b.id);
        if (i >= 0) convs[i] = b; else convs.push(b);
    };
    // CHAT-FILTER population: llm + vlm + batched are chat; audio_stt and
    // embedding are NOT (the picker parity test needs both kinds present)
    const modelRows = opts.models || [
        { id: 'M1', model_type: 'llm' },
        { id: 'V1', model_type: 'vlm' },
        { id: 'B1', engine_type: 'batched' },
        { id: 'ASR', model_type: 'audio_stt' },
        { id: 'EMB', model_type: 'embedding' },
    ];
    const win = {
        UpliftCore: { t: (k) => k },           // key-fallback: English literals
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: modelRows };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history'))
                    return convs.map((c) => ({ id: c.id, title: c.title,
                        model: c.model, message_count: (c.messages || []).length,
                        updated: 1 }));
                const m = u.match(/\/chat\/history\/(.+)$/);
                if (m) { const c = convs.find((x) => x.id === m[1]);
                         if (c) return c; throw new Error('404'); }
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, body) => {
                posts.push([String(u), body]);
                if (/\/chat\/history$/.test(String(u)) && body && body.id)
                    upsert(body);
                return { status: 'saved', kb: 0 };
            },
            deleteJson: async () => ({ ok: 1 }),
            toast: () => {},
            alert: () => {},
        },
        Uplift: { state: { API: '' } },
        document, URL,
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {}, removeEventListener() {},
        setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
        setInterval: () => 1, clearInterval: () => {},
        prompt: () => null, confirm: () => true, alert: () => {},
        AbortController: function () { this.signal = { aborted: false };
                                       this.abort = function () {}; },
        TextDecoder: function () { this.decode = (v) => String(v); },
        FormData: undefined, File: undefined,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    win.fetch = () => Promise.reject(new Error('no wire in u29 tests'));
    win.window = win; win.self = win; win.alert = () => {};
    win.navigator = {};
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8'))
        .runInContext(ctx);
    const h = {
        win, byId, shadow, posts, document, convs,
        async booted() {
            win.UpliftNativeChat.mount();
            for (let i = 0; i < 12; i++) await tick(0);
            // boot opens the LAST conversation with EMPTY messages; the
            // gate sets the store through the live reference afterwards
            this.st = win.UpliftNativeChat._state();
            this.M = win.UpliftNativeChat;
            // the mount-built model picker (a real created element; the
            // module's own gid() had made a phantom during boot — adopt
            // the real one so later writes land where the test can see)
            this.picker = created.find((e) => e.id === 'chat-native-model');
            if (this.picker) {
                byId['chat-native-model'] = this.picker;
                this.picker.value = this.st.conv.model || '';
            }
            return this;
        },
    };
    return h;
}

// simulate deep-chat's commit order: the component records the user bubble,
// the request runs (shapeRequest — sets _turnModel/_streaming), the stream
// closes with the final assistant row (onMessage).
async function commitTurn(h, promptText, answerText, reqOpts) {
    const M = h.M;
    await M.shapeRequest({ body: { messages: [{ role: 'user',
        text: promptText }] }, headers: {} }, reqOpts);
    h.st.dc.onMessage({ isHistory: false, message: { role: 'user', text: promptText } });
    h.st.dc.onMessage({ isHistory: false,
                        message: { role: 'ai', text: answerText } });
    await flush(2);
}

function setStore(h, rows) {
    h.st.conv.messages = rows;
    return rows;
}
const vis = (rows) => rows.filter((r) =>
    r && (r.content || (r.att && r.att.length)) && !(r.vg && r.vsel === 0));

// ---- 1: branch -------------------------------------------------------------
test('UP-29: branch duplicates up to AND INCLUDING the user row, deep-copied, inheriting the conv bindings', async () => {
    const h = await makeHarness().booted();
    const rows = setStore(h, [
        { role: 'user', content: 'q1', mid: 'm1' },
        { role: 'assistant', content: 'a1', mid: 'm2' },
        { role: 'user', content: '', att: [{ n: 'a.png', k: 'image' }], mid: 'm3' },
        { role: 'assistant', content: 'a2', mid: 'm4' },
    ]);
    h.st.conv.systemPrompt = 'SP';
    h.st.conv.activeProfile = 'P';
    h.st.conv.customPrompt = 'CP';
    h.st.conv.thinking = 'on';
    h.st.conv.thinkingBudget = 512;
    h.st.conv.generation = { temperature: 0.7 };
    h.st.conv.variants = { P: { prompt: 'pp', settings: null } };
    h.st.conv.pinned = true;
    const before = h.posts.length;
    await h.M._msgActions.branch(0);            // branch at the FIRST prompt
    const bp = h.posts.slice(before).find(([u, b]) => b && b.id !== 'c1');
    assert.ok(bp, 'branch POSTed a NEW conversation via /chat/history');
    const body = bp[1];
    assert.equal(body.id !== 'c1', true, 'fresh id');
    assert.deepEqual(body.messages.map((m) => m.content), ['q1'],
        'slice is up to and INCLUDING the user row — the reply after it is not');
    assert.notEqual(body.messages[0], rows[0], 'deep copy: rows are NOT shared');
    body.messages[0].content = 'mutated';
    assert.equal(rows[0].content, 'q1', 'mutating the branch never rewrites the original');
    assert.equal(body.title, 'Branch of T', "classic's 'Branch of <title>'");
    assert.equal(body.model, 'M1', 'model inherited');
    assert.equal(body.systemPrompt, 'SP', 'systemPrompt inherited');
    assert.equal(body.activeProfile, 'P', 'profile binding cloned (ticket: clone it like classic inherits systemPrompt)');
    assert.equal(body.customPrompt, 'CP', 'stashed custom prompt cloned');
    assert.deepEqual(body.generation, { temperature: 0.7 }, 'sampling overrides cloned');
    assert.deepEqual(body.variants, { P: { prompt: 'pp', settings: null } },
        'per-profile working copies cloned');
    assert.equal(body.pinned, false, 'a branch starts unpinned (classic)');
    // switched to the branch via the existing openConv path
    assert.equal(h.st.conv.id, body.id, 'openConv switched');
    assert.equal(h.M._state().convs.some((c) => c.id === body.id), true,
        'the summary list carries the branch');
});

test('UP-29: att-only user rows branch with their meta; branch on an assistant row is a no-op', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: '', att: [{ n: 'b.pdf', k: 'file' }], mid: 'm9' },
    ]);
    const before = h.posts.length;
    await h.M._msgActions.branch(1);   // assistant — not a branch point
    assert.equal(h.posts.slice(before).find(([u, b]) => b && b.id !== 'c1'),
        undefined, 'no branch POST from an assistant row');
    await h.M._msgActions.branch(2);   // the att-only user row IS
    const bp = h.posts.slice(before).find(([u, b]) => b && b.id !== 'c1');
    assert.ok(bp, 'att-only user row branches');
    assert.deepEqual(bp[1].messages[2].att, [{ n: 'b.pdf', k: 'file' }],
        'UP-43 meta rides the cloned row (bytes never would)');
});

test('UP-29: branch refuses while streaming (stopAndSettle first, classic rule) and keeps the store intact', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
    ]);
    // arm the streaming flag through the real path (shapeRequest fires on
    // every submit; there is no setter — same drill as the U45 pins)
    await h.M.shapeRequest({ body: { messages: [{ role: 'user',
        text: 'q1' }] }, headers: {} });
    assert.equal(h.M._state().streaming, true, 'flag armed');
    const before = h.posts.length;
    await h.M._msgActions.branch(0);
    assert.equal(h.posts.slice(before).find(([u, b]) => b && b.id !== 'c1'),
        undefined, 'no branch was created while the stream refused to settle');
    assert.equal(h.st.conv.id, 'c1', 'still on the original conversation');
    assert.equal(h.st.conv.messages.length, 2, 'store untouched');
});

// ---- 2: variant append / switch / delete -----------------------------------
test('UP-29: regenerate parks the old chain and merges it back as a HIDDEN older variant', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: '', att: [{ n: 'a.png', k: 'image' }] },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'first' },
    ]);
    const sent = [];
    h.st.dc.submitUserMessage = (m) => sent.push(m.text);
    h.M._msgActions.regenerate(3);
    assert.deepEqual(sent, ['go'], 'the prompt replays through the live send path');
    assert.deepEqual(h.st.conv.messages.map((m) => m.role),
        ['user', 'assistant'],
        'truncate BELOW the prompt (U45 semantics kept — the replayed user row re-enters via onMessage)');
    const stash = h.st.variantStash;
    assert.ok(stash && stash.rows.length === 1 && stash.rows[0].content === 'first',
        'the old reply PARKED, not destroyed');
    assert.equal(stash.rows[0].vg, stash.gid, 'parked rows join the group');
    await commitTurn(h, 'go', 'second');
    const ms = h.st.conv.messages;
    assert.deepEqual(ms.map((m) => m.content),
        ['', 'ack', 'go', 'first', 'second'],
        'merge order: prompt, OLDER chain, NEW chain (newest last — the reload degradation keeps the newest adjacent to the continuation)');
    assert.equal(ms[3].vsel, 0, 'older variant hidden');
    assert.equal(ms[4].vsel, 1, 'new variant shown');
    assert.equal(ms[3].vg, ms[4].vg, 'one group');
    assert.notEqual(ms[3].vid, ms[4].vid, 'two chains');
    // ordinals: the store-visible list matches the view exactly — the att
    // placeholder row stays visible, the hidden variant disappears from
    // BOTH (one predicate, five call sites — u43 doctrine)
    assert.deepEqual(h.st.dc.history.map((x) => x.text),
        vis(ms).map((m) => m.content ? m.content : '📎 a.png'),
        'bubbles == visible rows == ordinals');
    assert.ok(!h.st.dc.history.some((x) => x.text === 'first'),
        'hidden variant is not a bubble');
});

test('UP-29: second regenerate groups THREE chains; select switches view; hidden never reaches the wire', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
    ]);
    h.st.dc.submitUserMessage = () => {};
    h.M._msgActions.regenerate(1);
    await commitTurn(h, 'go', 'v2');
    h.M._msgActions.regenerate(2);             // regenerate on the NEWEST
    await commitTurn(h, 'go', 'v3');
    const ms = h.st.conv.messages;
    assert.deepEqual(ms.map((m) => m.content), ['go', 'v1', 'v2', 'v3']);
    const g = h.M._u29.variantGroup(ms, ms[1].vg);
    assert.equal(g.vids.length, 3, 'three chains in one group');
    assert.equal(g.activeVid, ms[3].vid, 'newest is active');
    // switch to the FIRST variant through the seam
    assert.equal(h.M._msgActions.variantSelect(3, g.vids[0]), true);
    assert.equal(ms[1].vsel, 1, 'chosen chain shown');
    assert.equal(ms[2].vsel, 0);
    assert.equal(ms[3].vsel, 0, 'the rest hidden');
    assert.deepEqual(h.st.dc.history.map((x) => x.text), ['go', 'v1'],
        'switching re-renders the whole turn (content/thinking/usage ride the rows)');
    // the wire: the next request carries the ACTIVE chain only (classic
    // getApiTurnMessages :3440) — hidden siblings are display history
    const d = await h.M.shapeRequest({ body: { messages: [
        { role: 'user', text: 'next' }] }, headers: {} });
    const wire = d.body.messages.map((m) => m.content);
    assert.ok(wire.includes('v1'), 'active chain travels');
    assert.ok(!wire.includes('v2') && !wire.includes('v3'),
        'hidden variants never poison the model context');
});

test('UP-29: delete-one drops the chain, keeps the group, collapses to a PLAIN turn, and can never delete the last reply', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
    ]);
    h.st.dc.submitUserMessage = () => {};
    h.M._msgActions.regenerate(1);
    await commitTurn(h, 'go', 'v2');
    h.M._msgActions.regenerate(2);
    await commitTurn(h, 'go', 'v3');
    let ms = h.st.conv.messages;
    const gid = ms[1].vg;
    let g = h.M._u29.variantGroup(ms, gid);
    const anchor = 3;                            // last row of the active chain
    // delete the ACTIVE (v3) chain
    assert.equal(h.M._msgActions.variantDelete(anchor, g.vids[2]), true);
    ms = h.st.conv.messages;
    assert.deepEqual(ms.map((m) => m.content), ['go', 'v1', 'v2'],
        'deleted chain is gone whole');
    g = h.M._u29.variantGroup(ms, gid);
    assert.equal(g.vids.length, 2);
    assert.equal(g.activeVid, g.vids[1], 'falls back to the newest survivor');
    assert.equal(ms[2].vsel, 1, 'survivor shown');
    assert.equal(ms[1].vsel, 0, 'still hidden');
    // delete the NON-active survivor -> one chain remains -> plain turn
    g = h.M._u29.variantGroup(ms, gid);
    assert.equal(h.M._msgActions.variantDelete(2, g.vids[0]), true);
    ms = h.st.conv.messages;
    assert.deepEqual(ms.map((m) => m.content), ['go', 'v2']);
    assert.equal(ms[1].vg, undefined, 'markers cleared — no vestigial tabs');
    assert.equal(ms[1].vid, undefined);
    assert.equal(ms[1].vsel, undefined);
    // a plain turn has nothing to delete (classic keeps the last reply)
    assert.equal(h.M._msgActions.variantDelete(1, 'nope'), false);
    assert.equal(h.st.dc.history.length, 2, 'the plain reply still renders');
});

test('UP-29: msgDelete on a variant truncates classic-style — the hidden siblings leave with the turn', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'q0' },
        { role: 'assistant', content: 'a0' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
        { role: 'assistant', content: 'v2' },
    ]);
    // mark the group by hand (storage contract)
    h.st.conv.messages[3].vg = h.st.conv.messages[4].vg = 'g';
    h.st.conv.messages[3].vid = 'x'; h.st.conv.messages[3].vsel = 0;
    h.st.conv.messages[4].vid = 'y'; h.st.conv.messages[4].vsel = 1;
    h.M._msgActions.delete(4);
    // classic deleteMessage on an assistant row keeps the PROMPT and drops
    // the answer (unchanged UP-34 semantics) — the whole variant group,
    // hidden siblings included, leaves with it: no vg-marked row survives
    assert.deepEqual(h.st.conv.messages.map((m) => m.content), ['q0', 'a0', 'go']);
    assert.ok(!h.st.conv.messages.some((m) => m.vg),
        'no orphaned hidden variant rows');
});

test('UP-29: a regenerate stream that produced NOTHING restores the parked chain (abort costs nothing)', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'only' },
    ]);
    h.st.dc.submitUserMessage = () => {};
    h.M._msgActions.regenerate(1);
    h.st.dc.onMessage({ isHistory: false, message: { role: 'user', text: 'go' } });
    // the stream dies (stop/error): NO assistant onMessage — the close()
    // fallback drain runs the merge; drive the seam the drain drives
    assert.equal(h.M._u29.mergeVariantChain(), true);
    const ms = h.st.conv.messages;
    assert.deepEqual(ms.map((m) => m.content), ['go', 'only'],
        'the old answer is back');
    assert.equal(ms[1].vsel, 1, 'restored as SHOWN (nothing replaced it)');
    assert.deepEqual(h.st.dc.history.map((x) => x.text), ['go', 'only'],
        'the view kept the reply — no bubble-less row, no ordinal shift');
    // and the group did not materialize (one chain = no tab machinery)
    assert.equal(h.M._u29.variantStripEl(1), null);
});

test('UP-29: the close() drain and the final onMessage both own a merge hook, first caller wins', () => {
    const oi = SRC.indexOf('dc.onMessage = function');
    assert.ok(oi > 0);
    const seg = SRC.slice(oi, oi + 9000);
    assert.match(seg, /if \(role === 'assistant' && _variantStash\) mergeVariantChain\(\);/,
        'the normal close merges right where the answer row lands');
    const hi = SRC.indexOf('function nativeHandler');
    const drain = SRC.slice(hi, SRC.indexOf('if (!req || !req.model)', hi));
    assert.match(drain, /if \(_variantStash && _conv && _conv\.id === cid\) mergeVariantChain\(\);/,
        'the stop/error fallback drains the stash under the SAME abandoned-view guard as the UP-35 round drain');
});

// ---- 3: creative temp + one-shot travel ------------------------------------
test('UP-29: creative temp mirrors classic :7218-7223 (base+0.4 cap 2, sane-base gate, 1.2 floor)', async () => {
    const h = await makeHarness().booted();
    h.st.conv.model = 'M1';
    h.st.conv.generation = { temperature: 0.7 };
    assert.equal(h.M._u29.creativeTemp(), 1.1, '0.7 -> 1.1');
    h.st.conv.generation = { temperature: 1.8 };
    assert.equal(h.M._u29.creativeTemp(), 2, 'capped at 2 (classic)');
    h.st.conv.generation = { temperature: 0 };
    // 0 IS a valid base (greedy) but classic's gate requires base > 0 for
    // the +0.4 walk — greedy jumps to the 1.2 'no sane base' arm
    assert.equal(h.M._u29.creativeTemp(), 1.2);
    h.st.conv.generation = null;
    assert.equal(h.M._u29.creativeTemp(), 1.2, 'nothing set -> 1.2');
});

test('UP-29: the Creative option stamps a ONE-request temperature into the wire (and the U78 chip sees it)', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
    ]);
    h.st.conv.generation = { temperature: 0.7 };
    const sent = [];
    h.st.dc.submitUserMessage = (m) => sent.push(m.text);
    h.M._msgActions.regenerate(1, { creative: true });
    assert.deepEqual(sent, ['go']);
    const d = await h.M.shapeRequest({ body: { messages: [
        { role: 'user', text: 'go' }] }, headers: {} });
    assert.equal(d.body.temperature, 1.1, 'the creative call runs at 0.7+0.4');
    // one-shot: the NEXT request falls back to the stored 0.7
    h.st.dc.onMessage({ isHistory: false, message: { role: 'user', text: 'go' } });
    h.st.dc.onMessage({ isHistory: false, message: { role: 'ai', text: 'v2' } });
    h.M._msgActions.regenerate(3);
    const d2 = await h.M.shapeRequest({ body: { messages: [
        { role: 'user', text: 'go' }] }, headers: {} });
    assert.equal(d2.body.temperature, 0.7, 'plain regenerate does NOT stay creative');
});

// ---- 4: the options hub (menu) + model picker parity ------------------------
test('UP-29: the regen button opens the hub; its model picker equals the header picker (CHAT-FILTER parity)', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
    ]);
    // the header picker the boot built (chat-capable rows only)
    const picker = h.picker;
    const pickerIds = picker.children
        .filter((o) => o.value).map((o) => o.value);
    assert.deepEqual(pickerIds, ['M1', 'V1', 'B1'],
        'sanity: llm+vlm+batched in, audio_stt+embedding out');
    // drive the BUTTON path: msgActionsEl -> openRegenMenu(idx, btn)
    const box = mkEl('div');
    const btn = mkEl('button');
    box.appendChild(btn);
    h.M._msgActions.regenMenu(1, btn);          // hub (no stream)
    const menu = box.children.find((c) => c.className === 'chat-native-regen-menu');
    assert.ok(menu, 'hub mounted on its own action bar');
    const labels = menu.children
        .filter((c) => c.className === 'chat-native-regen-item')
        .map((c) => c.textContent);
    assert.deepEqual(labels, ['Regenerate', 'Creative (+0.4 temp)'],
        'classic :7218-7233 options: plain + creative');
    const sel = menu.children.find((c) => c.tagName === 'select');
    assert.ok(sel, 'Regenerate with… picker present');
    assert.deepEqual(sel.children.filter((o) => o.value).map((o) => o.value),
        pickerIds, 'PARITY: the menu lists exactly what the picker lists');
    assert.ok(!sel.children.some((o) => o.value === 'ASR'),
        'an STT row can never be chosen as a reply model');
    // 'Regenerate with…' switches the conversation's model, sticky —
    // classic selectModel(opts.model) :7226 — and replays the prompt
    const sent = [];
    h.st.dc.submitUserMessage = (m) => sent.push(m.text);
    sel.value = 'V1';
    fire(menu.children.find((c) => c.className === 'chat-native-regen-go'), 'click');
    assert.deepEqual(sent, ['go'], 'the chosen option regenerates');
    assert.equal(h.st.conv.model, 'V1', 'model switched (classic sticky)');
    assert.equal(picker.value, 'V1', 'header select follows — the UI never lies');
    assert.equal(box.children.some((c) => c.className === 'chat-native-regen-menu'),
        false, 'choosing closes the hub');
});

test('UP-29: the hub guards — no menu while streaming, second click on the same row toggles it shut', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
    ]);
    const box = mkEl('div');
    const btn = mkEl('button');
    box.appendChild(btn);
    h.M._msgActions.regenMenu(1, btn);
    assert.ok(box.children.some((c) => c.className === 'chat-native-regen-menu'));
    h.M._msgActions.regenMenu(1, btn);
    assert.equal(box.children.filter((c) => c.className === 'chat-native-regen-menu').length,
        0, 'toggle: the same button closes its own menu');
});

// ---- 5: the tab strip (rendering + two-step delete doctrine) ---------------
test('UP-29: the strip anchors on the LAST row of the ACTIVE chain, numbers chains, and delete is two-step', async () => {
    const h = await makeHarness().booted();
    setStore(h, [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'v1' },
    ]);
    h.st.dc.submitUserMessage = () => {};
    h.M._msgActions.regenerate(1);
    await commitTurn(h, 'go', 'v2');
    const ms = h.st.conv.messages;
    assert.equal(h.M._u29.variantStripEl(1), null,
        'mid-chain and hidden rows never carry the strip');
    const wrap = h.M._u29.variantStripEl(2);
    assert.ok(wrap, 'the active chain\u2019s last row carries it');
    const tabs = wrap.children.filter((c) => c.className.startsWith('chat-native-vartab'));
    assert.deepEqual(tabs.map((c) => c.textContent), ['1', '2'],
        'classic Response tabs, numbered by creation order');
    assert.ok(tabs[1].className.includes('active'), 'the newest is active');
    // switching through the DOM path
    fire(tabs[0], 'click');
    assert.equal(h.st.conv.messages[1].vsel, 1, 'tab click selected chain 1');
    // the per-tab trash: FIRST click arms, it does NOT delete (file's own
    // doctrine — inline confirmation, never window.confirm on the bar)
    const wrap2 = h.M._u29.variantStripEl(1);   // anchor moved with the active chain
    assert.ok(wrap2, 'anchor follows the ACTIVE chain, not the array tail');
    const dels = wrap2.children.filter((c) => c.className === 'chat-native-vardel');
    const del = dels[dels.length - 1];          // the non-active (v2) chain
    fire(del, 'click');
    assert.equal(h.st.conv.messages.length, 3, 'one click: armed, nothing deleted');
    assert.equal(del.textContent, '?', 'armed state is visible on the button itself');
    fire(del, 'click');
    assert.deepEqual(h.st.conv.messages.map((m) => m.content), ['go', 'v1'],
        'two-step: the second click deletes ONE variant (v2), keeping the rest');
});

// ---- 6: degradation honesty (pre-whitelist reload) --------------------------
test('UP-29: markers stripped by the server whitelist degrade to plain consecutive bubbles; a regen then collapses them into ONE historical chain', async () => {
    const h = await makeHarness().booted();
    // a conversation COMING BACK from the server: _clean_message kept role/
    // content/mid only — vg/vid/vsel are gone (today's reality)
    setStore(h, [
        { role: 'user', content: 'go', mid: 'u1' },
        { role: 'assistant', content: 'v1', mid: 'a1' },
        { role: 'assistant', content: 'v2', mid: 'a2' },
    ]);
    assert.equal(h.M._u29.variantGroup(h.st.conv.messages, 'g-any'), null,
        'no markers -> no group');
    assert.equal(h.M._u29.variantStripEl(2), null, 'no strip without markers');
    // every sibling renders as an ordinary consecutive bubble (isVisibleRow
    // hides nothing without vsel) — the newest sits LAST, adjacent to the
    // continuation: the ticket's 'newest variant wins' degradation
    h.st.dc.submitUserMessage = () => {};
    h.M._msgActions.regenerate(2);              // regen off the LAST bubble
    await commitTurn(h, 'go', 'v3');
    const ms = h.st.conv.messages;
    assert.deepEqual(ms.map((m) => m.content), ['go', 'v1', 'v2', 'v3']);
    assert.equal(ms[1].vid, ms[2].vid,
        'marker-less siblings merge into ONE historical chain (honest: the old selection is unknowable)');
    assert.equal(ms[1].vsel, 0, 'history hidden once a real chain exists');
    assert.equal(ms[3].vsel, 1, 'the new answer is the shown reply');
    assert.deepEqual(h.st.dc.history.map((x) => x.text), ['go', 'v3']);
});
