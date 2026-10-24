/* UP-40 gate (chat lane) — item 4 of the card: the '?' keyboard-shortcut
   sheet. classic renders it as a fixed modal (chat.html:2728-2757), opens it
   with '?' in handleGlobalKeydown (:7906) and with the settings entry
   (:2514), and its Escape rule closes the sheet INSTEAD of stopping the
   stream (:7894).

   Uplift's list is this surface's real affordances: Enter send, Shift+Enter
   newline, Esc stop (UP-40 3), double-click rename (UP-39), the regenerate
   hub (UP-29), drop files and paste image (UP-43), '?' itself.

   Pins that matter beyond 'a modal exists':
   1. House modal pattern: .modal-overlay + .modal.nasa, and NO per-dialog
      Escape listener — the ONE global handler in uplift_state.js owns the
      key (modal-escape.test.cjs is the app-wide gate; this pins our share).
   2. '?' never fires while typing. deep-chat's composer is in a SHADOW ROOT,
      so a window-level listener sees the RETARGETED host as ev.target —
      `_isTypingTarget` must walk composedPath() or every '?' typed into the
      composer pops the sheet. Both shapes are driven below.
   3. Escape priority: sheet first, then stop; stop only while streaming and
      not typing (UP-34's settle, UP-40 3's rule — unchanged).
   4. One sheet, not a stack; the button entry opens the same one.
   5. Labels ride classic's catalog keys where they exist (chat.shortcut_*),
      uplift.chat.* with English fallbacks elsewhere — no raw key leaks.
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = fs.readFileSync(path.join(STATIC_DIR, 'uplift_chat.js'), 'utf8');

function mkEl(tag, reg) {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
        className: '', textContent: '', title: '', hidden: false, type: '',
        parentNode: null, isContentEditable: false, _value: '',
        get value() { return this._value; }, set value(v) { this._value = String(v == null ? '' : v); },
        get id() { return this._id; },
        set id(v) { this._id = v; if (v && reg) reg[v] = this; },
        replaceChildren(...ks) { this.children = ks; ks.forEach((k) => { k.parentNode = this; }); },
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
            (this._lis[t2] || []).forEach((fn) => fn(Object.assign(
                { stopPropagation() {}, preventDefault() {}, target: this }, ev)));
        },
        querySelector() { return mkEl('div', reg); },
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
const walk = (n, out) => {
    (n.children || []).forEach((c) => { out.push(c); walk(c, out); });
    return out;
};

function makeHarness() {
    const byId = {};
    const shadow = { children: [], appendChild(k) { this.children.push(k); return k; },
                     getElementById(id) { return this.children.find((c) => c.id === id) || null; },
                     // UP-34/40: stopAndSettle clicks the component's own stop
                     // (.input-button, last one) — the harness counts clicks
                     querySelectorAll(sel) {
                         return String(sel).includes('.input-button')
                             ? shadow.__stops : [];
                     },
                     querySelector() { return null; },
                     __stops: [] };
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
    const stops = [];
    const store = {};
    const win = {
        UpliftCore: { t: (k) => k },            // no catalog: fallbacks must show
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models'))
                    return { models: [{ id: 'M1', engine_type: 'batched', model_type: 'llm' }] };
                if (u.endsWith('/chat/key')) return { api_key: 'KEY' };
                if (u.endsWith('/chat/history')) return [];
                throw new Error('no net in tests: ' + u);
            },
            postJson: async (u, b) => { posts.push([String(u), b]); return { status: 'saved' }; },
            deleteJson: async () => ({ ok: 1 }), toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document, customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        __keys: keys, __posts: posts,
        addEventListener(t2, fn) { if (t2 === 'keydown') keys.push(fn); },
        removeEventListener() {},
        MutationObserver: function () { this.observe = () => {}; },
        prompt: () => null, confirm: () => true,
        setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
        setInterval: () => 1, clearInterval: () => {},
        localStorage: { getItem: (k) => (k in store ? store[k] : null),
                        setItem: (k, v) => { store[k] = v; },
                        removeItem: (k) => { delete store[k]; } },
    };
    win.window = win; win.self = win; win.__shadow = shadow;
    const ctx = vm.createContext(win);
    new vm.Script(SRC).runInContext(ctx);
    win.M = win.UpliftNativeChat;
    win.__stopCount = 0;
    // a key event as the window really receives it: a plain light-DOM target,
    // or (composer) the retargeted <deep-chat> host with a shadow path
    win.keyEv = (key, o) => Object.assign({
        key: key, preventDefault() { win.__pd = (win.__pd || 0) + 1; },
        stopPropagation() {},
    }, o || {});
    win.textarea = () => ({ tagName: 'TEXTAREA' });
    win.composerEv = (key) => ({
        key: key,
        target: { tagName: 'DEEP-CHAT' },          // retargeted host
        composedPath: () => [{ tagName: 'TEXTAREA' }, { tagName: 'DEEP-CHAT' }],
        preventDefault() { win.__pd = (win.__pd || 0) + 1; },
        stopPropagation() {},
    });
    return win;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function booted(win) {
    win.M.mount();
    for (let i = 0; i < 14; i++) await tick();
    assert.ok(win.__keys.length >= 1, 'mount registers the ONE global key handler');
    return win;
}
const press = (win, ev) => win.__keys.forEach((fn) => fn(ev));
const sheet = (win) => win.M._u40b.el();

test('? opens the sheet, and it is the house modal (not a bespoke layer)', async () => {
    const win = await booted(makeHarness());
    assert.equal(sheet(win), null, 'closed at rest');
    press(win, win.keyEv('?'));
    const ov = sheet(win);
    assert.ok(ov, '? opened it');
    assert.equal(ov.className, 'modal-overlay chat-help-overlay',
        '.modal-overlay = the global Escape handler + the backdrop style');
    const box = ov.children[0];
    assert.equal(box.className, 'modal nasa chat-help', '.modal.nasa = the house dialog');
    const texts = walk(box, []).map((n) => n.textContent).filter(Boolean);
    assert.ok(texts.includes('Keyboard shortcuts'), 'classic title key');
    ['Enter', 'Shift + Enter', 'Esc', '?'].forEach((k) =>
        assert.ok(texts.includes(k), 'kbd ' + k + ' listed'));
    assert.ok(texts.includes('Send message') && texts.includes('Newline in message')
              && texts.includes('Stop generating') && texts.includes('Show this help'),
              "classic's own four rows carry their catalog labels");
    ['Rename chat', 'Regenerate options', 'Attachments', 'Double-click',
     'Drop', 'Paste image']
        .forEach((r) => assert.ok(texts.includes(r), 'affordance listed: ' + r));
    assert.ok(walk(box, []).every((n) => !/^(chat|uplift)\.[a-z_.]+$/.test(n.textContent || '')),
        'no raw i18n key reaches the DOM');
});

test('? twice is not a stack; the backdrop and the button close the same sheet', async () => {
    const win = await booted(makeHarness());
    press(win, win.keyEv('?'));
    const first = sheet(win);
    press(win, win.keyEv('?'));
    assert.equal(sheet(win), first, 'one sheet');
    assert.equal(win.document.body.children.filter((c) => c === first).length, 1,
        'and exactly one in the DOM');
    first.dispatch('click', { target: first });              // backdrop
    assert.equal(sheet(win), null, 'backdrop click folds it');
    press(win, win.keyEv('?'));
    const again = sheet(win);
    assert.equal(again.parentNode, win.document.body, 'reopen re-attaches');
    const closeBtn = walk(again, []).find((n) => n.textContent === 'Close');
    closeBtn.dispatch('click');
    assert.equal(sheet(win), null, 'the Close button folds it too');
});

test('typing ? in an editor never opens it — light DOM AND through the shadow root', async () => {
    const win = await booted(makeHarness());
    // classic's case: focus sits in a real input
    press(win, win.keyEv('?', { target: win.textarea() }));
    assert.equal(sheet(win), null, 'TEXTAREA target: no sheet');
    // uplift's case: deep-chat's composer is inside a shadow root, so the
    // window sees the retargeted host. ev.target alone says 'not typing'.
    press(win, win.composerEv('?'));
    assert.equal(sheet(win), null,
        'a retargeted composer keypress must still count as typing');
    // with-modifier is classic-gated too (:7906 !mod) — Cmd+/ is someone else's
    press(win, win.keyEv('?', { metaKey: true }));
    press(win, win.keyEv('?', { ctrlKey: true }));
    assert.equal(sheet(win), null, 'no sheet behind a chord');
    press(win, win.keyEv('?'));
    assert.ok(sheet(win), 'the bare key still works');
});

test('Escape: the sheet first, THEN the stream — and never while typing', async () => {
    const win = await booted(makeHarness());
    let clicks = 0;
    const stopBtn = { click() { clicks++; } };
    // the <deep-chat> the module created carries THIS shadow object, so a
    // stop button here is what stopAndSettle finds through the shadow root
    win.__shadow.__stops.push(stopBtn);

    // 1. no stream, no sheet: Escape is nobody's business
    press(win, win.keyEv('Escape'));
    assert.equal(clicks, 0, 'Escape cannot stop a stream that is not running');
    assert.equal(sheet(win), null);

    // 2. the sheet owns Escape: it closes, the stop rule is never consulted
    //    (classic :2894 `if (this.showShortcutsHelp) { close; return; }`)
    press(win, win.keyEv('?'));
    const ov = sheet(win);
    assert.ok(ov, 'sheet open');
    assert.equal(typeof ov.__upliftModalClose, 'function',
        'teardown registered for the ONE global handler (modal-escape contract)');
    ov.__upliftModalClose();
    assert.equal(sheet(win), null, 'the global handler reaches our close');
    await tick();          // a SEPARATE keypress is a separate turn for the
                           // one-shot Escape handoff (see the pin below)
    press(win, win.keyEv('?'));
    press(win, win.keyEv('Escape'));
    assert.equal(sheet(win), null, 'Escape folded the sheet');
    assert.equal(clicks, 0, 'and did NOT touch the stream while it was open');

    // THE PROPAGATION CASE (the one a naive implementation loses): the
    // app-wide Escape handler lives on document and document is reached
    // BEFORE window in the bubble phase, so during one real keypress
    // uplift_state.js removes the sheet FIRST and our window listener then
    // sees nothing open. Without the handoff the same keypress would fall
    // through to the stop rule and cut the user's stream.
    await win.M.shapeRequest({ body: { messages: [] }, headers: {} });   // streaming
    press(win, win.keyEv('?'));
    const live = sheet(win);
    live.__upliftModalClose();      // what the document handler does
    assert.equal(sheet(win), null, 'the global handler really did close it');
    press(win, win.keyEv('Escape')); // ... and the SAME key reaches us next
    assert.equal(clicks, 0,
        'the borrowed Escape must NOT stop the stream (the classic :2894 rule)');
    // the flag is one-shot: the NEXT Escape stops normally
    press(win, win.keyEv('Escape'));
    assert.equal(clicks, 1, 'the handoff expires — Esc stops again after it');

    // 3. now a real stream: Esc stops through the component (UP-34 settle)
    await win.M.shapeRequest({ body: { messages: [] }, headers: {} });
    assert.equal(win.M._state().streaming, true, 'a turn is in flight');
    press(win, win.keyEv('Escape'));
    assert.equal(clicks, 2, 'Esc pressed the component stop button');

    // 4. deliberately UNCHANGED from UP-40(3): Escape is not a printable
    //    key, so it keeps stopping the stream even with the shadow composer
    //    focused (the window only ever sees the retargeted <deep-chat>).
    //    Only the PRINTABLE '?' walks the shadow root — that is the case
    //    where the sheet would otherwise interrupt typing.
    await win.M.shapeRequest({ body: { messages: [] }, headers: {} });
    press(win, win.composerEv('Escape'));
    assert.equal(clicks, 3, 'Esc-as-stop survives the shadow composer (landed rule)');
    press(win, win.composerEv('?'));
    assert.equal(sheet(win), null,
                 'but a ? typed INTO the composer never opens the sheet');
});

test('the key handler is ONE window listener and owns no per-dialog Escape', async () => {
    const win = await booted(makeHarness());
    assert.equal(win.__keys.length, 1,
        'exactly one global keydown listener from the chat surface');
    assert.match(SRC, /W\(\)\.addEventListener\('keydown', chatGlobalKey\)/,
        'the listener delegates to the module-scope router');
    assert.ok(!/document\.addEventListener\(\s*'keydown'[^)]{0,120}Escape/.test(SRC),
        'no per-dialog Escape listener (modal-escape gate)');
    assert.ok(!/window\.addEventListener\(\s*'keydown'[^)]{0,80}Escape/.test(SRC));
});

test('the rail carries classic s settings entry for the sheet', async () => {
    const win = await booted(makeHarness());
    const tools = win.document.getElementById('chat-native');
    const all = walk(tools, []);
    const btn = all.find((n) => n.id === 'chat-native-help');
    assert.ok(btn, 'the Shortcuts button exists (classic chat.html:2514 entry)');
    assert.equal(btn.title, 'View keyboard shortcuts', "classic's own key");
    assert.equal(sheet(win), null);
    btn.dispatch('click');
    assert.ok(sheet(win), 'and it opens the same sheet');
    assert.equal(sheet(win).children[0].className, 'modal nasa chat-help');
});

test('the stop rule keeps UP-34/40 semantics (settle, not silent abandon)', () => {
    // Escape is classic-rule EXACTLY as UP-40(3) landed it: ev.target only
    // (light DOM), so Esc keeps stopping the stream where it did before this
    // card — the sheet is the only thing allowed to preempt it.
    assert.match(SRC, /if \(!_streaming \|\| isTypingTarget\(ev, false\)\) return;\s*\n\s*stopAndSettle\(\);/);
    assert.match(SRC, /if \(closeShortcutsHelp\(\)\) return;/,
                 'classic :7894 — the sheet owns Escape first');
    // '?' is PRINTABLE, so it must see through the composer's shadow root
    // (a window-level listener only ever sees the retargeted <deep-chat>)
    assert.match(SRC, /&& !isTypingTarget\(ev, true\)\) \{/,
                 'the printable key takes the composedPath walk');
    assert.match(SRC, /function _typingNode\(n\) \{[\s\S]*?'input' \|\| tag === 'textarea'/);
    assert.match(SRC, /typeof ev\.composedPath === 'function'/);
});

test('CSS the lane owes: the sheet rows are styled by the lane file', () => {
    // no uplift.css edit in this lane — the classes the JS emits must be the
    // ones the scratch CSS defines (owner folds them into applyShadowTheme)
    assert.match(SRC, /'chat-help-row'/);
    assert.match(SRC, /'chat-help-kbd'/);
    const css = fs.readFileSync(path.join(process.env.HOME, 'hermes/TMP/lane-u37b.css'), 'utf8');
    ['.chat-help .chat-help-list', '.chat-help-row', '.chat-help-kbd'].forEach((sel) =>
        assert.ok(css.includes(sel), 'lane CSS defines ' + sel));
});
