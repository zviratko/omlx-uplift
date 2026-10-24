/* UP-35 gate: chat tool visibility — classic's web-tool SOURCE CARDS,
   per-round transcript SEGMENTS, and the live STATUS LINE.

   (vm sandbox, voice11/nat4-chat-mount harness pattern; the handler is
   driven END TO END with a scripted SSE stream + fake /v1/web/search, and
   a second harness wires a rich-enough shadow-DOM stub to prove the live
   DOM surgery: segment inserted, rendered text MOVED into it, thinking
   block frozen per round, card built with createElement, status painted
   while the tool runs and REMOVED when results land.)

   Pins:
   1. webCardSafeUrl / buildWebCard: the exact http(s)-only gate — an
      `evil` javascript: result and an ftp: result never reach the card.
   2. webCardEl: classic's card DOM — label ('Searched the web'), quoted
      query, result rows with title + hostname, rel="noopener noreferrer",
      target=_blank; the error state carries the payload message.
   3. cardMarkdown: the persisted form (rows survive reloads ONLY inside
      content — _clean_message whitelists keys) carries the gated links.
   4. toolStatusText: classic's catalog keys — searching_web / fetching_page
      for single web tools, calling_tools[_more] otherwise.
   5. nativeHandler, record level: two rounds -> onResponse stream shows
      the per-round reset marker ({text:'', overwrite:true}) BETWEEN the
      rounds' appends; the sealed round + final answer become TWO store
      rows in order; per-round thinking slices (r1 keeps 'r1 think', the
      final row keeps 'r2 think' — later rounds no longer overwrite);
      the status line is 'Searching the web' WHILE the tool fetch runs and
      empty after; the fallback drain flushes buffered rounds even when
      deep-chat never finalises a bubble (stop/error path).
   6. nativeHandler, live DOM level: a .chat-native-round segment is
      inserted before the streaming bubble's outer container, holding the
      FROZEN per-round thinking block, the bubble's rendered nodes (moved,
      not copied) and the tool card; the status element is replaced. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { URL } = require('node:url');
const { STATIC_DIR } = require('./static-src.cjs');

const tick = (n) => new Promise((r) => setTimeout(r, n || 1));
async function flush(rounds) {
    for (let i = 0; i < (rounds || 6); i++) await tick(1);
}

// ---- element stub with the surface UP-35 touches --------------------------
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
        classList: {
            add: (...cs) => cs.forEach((c) => classes.add(c)),
            remove: (...cs) => cs.forEach((c) => classes.delete(c)),
            contains: (c) => classes.has(c),
            toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f;
                                on ? classes.add(c) : classes.delete(c); return on; },
            __set: classes,
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
        removeChild(k) { const i = this.children.indexOf(k);
                         if (i >= 0) this.children.splice(i, 1); return k; },
        replaceChildren(...ks) { this.children = ks;
                                 ks.forEach((k) => { k.parentElement = this; }); },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
        cloneNode() {
            const c = mkEl(this.tagName);
            c.className = this.className;
            c.children = this.children.slice();   // SAME child objects (moved out)
            return c;
        },
        querySelector(sel) { return queryOne(this, sel); },
        querySelectorAll(sel) { return queryAll(this, sel); },
        addEventListener() {}, dispatch() {}, focus() {}, blur() {},
        closest() { return null; },
    };
    Object.defineProperty(el, 'childNodes', { get() { return this.children; } });
    return el;
}
function subMatches(el, sel) {
    // the classes UP-35's DOM surgery actually queries
    if (sel.includes('chat-native-think-body'))
        return el.className.includes('chat-native-think-body');
    if (sel.includes('chat-native-thinking'))
        return el.className.includes('chat-native-thinking');
    if (sel.includes('chat-native-msg-actions'))
        return el.className.includes('chat-native-msg-actions');
    return false;
}
function queryOne(root, sel) {
    for (const c of root.children || []) {
        if (subMatches(c, sel)) return c;
        const r = queryOne(c, sel);
        if (r) return r;
    }
    return null;
}
function queryAll(root, sel) {
    const out = [];
    (function walk(n) {
        for (const c of n.children || []) {
            if (subMatches(c, sel)) out.push(c);
            walk(c);
        }
    })(root);
    return out;
}

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
        getElementById(id) { return byId[id] || (byId[id] = mkEl('div')); },
        createElement(tag) {
            const e = mkEl(tag);
            if (tag === 'deep-chat') e.shadowRoot = shadow;
            return e;
        },
        createTextNode(s) { return { textContent: String(s), children: [] }; },
        querySelectorAll() { return []; },
        head: { appendChild() {} }, documentElement: { dataset: {} },
        body: mkEl('body'), addEventListener() {},
    };
    const convs = [{ id: 'c1', title: 'T', model: 'SmolLM2', systemPrompt: '',
                     messages: [] }];
    const posts = [];
    const win = {
        UpliftCore: { t: (k) => k },           // key-fallback: English literals
        UpliftDom: {
            fetchJson: async (u) => {
                u = String(u);
                if (u.endsWith('/models')) return { models: [
                    { id: 'SmolLM2', engine_type: 'batched', model_type: 'llm' }] };
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
            postJson: async (u, body) => { posts.push([String(u), body]); return { status: 'saved' }; },
            deleteJson: async () => ({ ok: 1 }),
            toast: () => {},
        },
        Uplift: { state: { API: '' } },
        document, URL,
        customElements: { get: () => function DeepChat() {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {},
        setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
        setInterval: () => 1, clearInterval: () => {},
        prompt: () => null, confirm: () => true,
        AbortController: function () { this.signal = { aborted: false };
                                       this.abort = function () {}; },
        TextDecoder: function () { this.decode = (v) => String(v); },
        FormData: undefined, File: undefined,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    // ---- scripted wire: chat rounds + /v1/web/search ----------------------
    const webSearchPayload = opts.searchPayload === undefined ? {
        ok: true, provider: 'kagi',
        results: [
            { title: 'MLX on Apple Silicon', url: 'https://mlx.app/' },
            { title: 'evil', url: 'javascript:alert(1)' },
            { title: '', url: 'https://blog.example/post' },
        ],
    } : opts.searchPayload;
    const probes = { statusDuringSearch: 'UNSET', searchCalls: 0 };
    function readerFor(frames) {
        const q = frames.slice();
        return { read() {
            return q.length ? Promise.resolve({ done: false, value: q.shift() })
                            : Promise.resolve({ done: true });
        } };
    }
    const f = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    const round1 = opts.round1 || [
        f({ choices: [{ delta: { reasoning_content: 'r1 think' } }] }),
        f({ choices: [{ delta: { content: 'Let me look that up. ' } }] }),
        f({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function',
            function: { name: 'web_search',
                        arguments: JSON.stringify({ query: 'mlx speed' }) } }] },
            finish_reason: 'tool_calls' }] }),
    ];
    const round2 = opts.round2 || [
        f({ choices: [{ delta: { reasoning_content: 'r2 think' } }] }),
        f({ choices: [{ delta: { content: 'Final answer.' } }] }),
        f({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    const rounds = [round1, round2];
    let roundIdx = 0;
    win.fetch = (url) => {
        url = String(url);
        if (url === '/v1/chat/completions') {
            const frames = rounds[Math.min(roundIdx++, rounds.length - 1)] || [];
            return Promise.resolve({ ok: true,
                                     body: { getReader: () => readerFor(frames) } });
        }
        if (url === '/v1/web/search' || url === '/v1/web/fetch') {
            probes.searchCalls++;
            probes.statusDuringSearch = win.UpliftNativeChat._state().toolStatus;
            return Promise.resolve({ ok: true,
                                     json: async () => webSearchPayload });
        }
        if (url === '/v1/mcp/tools' || url === '/v1/mcp/execute')
            return Promise.resolve({ ok: false });
        return Promise.reject(new Error('unexpected fetch: ' + url));
    };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    new vm.Script(fs.readFileSync(`${STATIC_DIR}/uplift_chat.js`, 'utf8'))
        .runInContext(ctx);
    return {
        win, byId, shadow, posts, probes, document, mkEl, convs,
        async booted() {
            win.UpliftNativeChat.mount();
            for (let i = 0; i < 12; i++) await tick(0);
            return this;
        },
    };
}

async function runTurn(h, extra) {
    const M = h.win.UpliftNativeChat;
    const st = M._state();
    st.conv.messages.push({ role: 'user', content: 'go' });
    if (extra) extra(st);
    M.toggleWeb();   // web tools on: the loop is armed (req.tools present)
    await M.shapeRequest({ body: { messages: [{ role: 'user', text: 'go' }] },
                           headers: {} });
    const responses = [];
    const signals = { responses,
                      onResponse(r) { this.responses.push(r); },
                      onClose() {}, stopClicked: { listener() {} } };
    await st.dc.connect.handler(null, signals);
    await flush(4);
    return { st, responses };
}

// ---- 1: the gate + the parsed card ----------------------------------------
test('UP-35: buildWebCard keeps classic\u2019s http(s)-only gate (unsafe urls dropped)', () => {
    const h = makeHarness();
    const U = h.win.UpliftNativeChat._u35;
    assert.equal(U.webCardSafeUrl('https://a.example/x'), 'https://a.example/x');
    assert.equal(U.webCardSafeUrl('http://a.example'), 'http://a.example');
    assert.equal(U.webCardSafeUrl('javascript:alert(1)'), '');
    assert.equal(U.webCardSafeUrl('data:text/html,<script>'), '');
    assert.equal(U.webCardSafeUrl('ftp://a/b'), '');
    assert.equal(U.webCardSafeUrl(null), '');
    assert.equal(U.webCardHost('https://www.mlx.app/roadmap'), 'mlx.app');

    const card = U.buildWebCard('web_search', { query: 'mlx speed' },
        { ok: true, results: [
            { title: 'MLX on Apple Silicon', url: 'https://mlx.app/' },
            { title: 'evil', url: 'javascript:alert(1)' },
            { title: 'file', url: 'file:///etc/passwd' },
            { title: 'blank', url: 'https://blog.example/post' },
        ] });
    assert.equal(card.ok, true);
    assert.equal(card.query, 'mlx speed');
    assert.equal(card.results.length, 2, 'the javascript: and file: rows never reach the card');
    assert.equal(card.results[0].url, 'https://mlx.app/');

    const err = U.buildWebCard('web_search', { query: 'q' },
        { ok: false, error: { message: 'provider quota exceeded' } });
    assert.equal(err.ok, false);
    assert.equal(err.error, 'provider quota exceeded');
    const noErr = U.buildWebCard('fetch_url', {}, {});
    assert.equal(noErr.error, 'failed', "classic's fallback word");
});

// ---- 2: the card DOM (createElement only, rel=noopener) --------------------
test('UP-35: webCardEl renders classic\u2019s card — label, query, title+host links', () => {
    const h = makeHarness();
    const U = h.win.UpliftNativeChat._u35;
    const card = U.buildWebCard('web_search', { query: 'mlx speed' },
        { ok: true, results: [
            { title: 'MLX on Apple Silicon', url: 'https://mlx.app/' },
            { title: '', url: 'https://blog.example/post' },
        ] });
    const d = U.webCardEl(card);
    assert.equal(d.className, 'chat-native-web-card');
    assert.equal(d.dataset.ok, '1');
    assert.equal(d.dataset.tool, 'web_search');
    const head = d.children[0];
    assert.equal(head.className, 'chat-native-web-card-head');
    const label = head.children[1];
    assert.equal(label.textContent, 'Searched the web');
    assert.equal(label.dataset.i18n, 'chat.web_card.searched');
    assert.equal(head.children[2].textContent, '\u201cmlx speed\u201d');
    const rows = d.children[1];
    assert.equal(rows.children.length, 2, 'safe results only');
    const a0 = rows.children[0];
    assert.equal(a0.href, 'https://mlx.app/');
    assert.equal(a0.target, '_blank');
    assert.equal(a0.rel, 'noopener noreferrer');
    assert.equal(a0.children[0].textContent, 'MLX on Apple Silicon');
    assert.equal(a0.children[1].textContent, 'mlx.app', 'hostname column');
    // titleless row: the host is the label (classic's r.title || webCardHost)
    assert.equal(rows.children[1].children[0].textContent, 'blog.example');

    const bad = U.webCardEl(U.buildWebCard('fetch_url',
        { url: 'https://example.com/p' },
        { ok: false, error: { message: 'HTTP 500' } }));
    assert.equal(bad.dataset.ok, '0');
    const errEl = bad.children[bad.children.length - 1];
    assert.equal(errEl.className, 'chat-native-web-card-error');
    assert.equal(errEl.textContent, 'HTTP 500');
});

// ---- 3: the persisted form --------------------------------------------------
test('UP-35: cardMarkdown persists the gated source rows inside content', () => {
    const h = makeHarness();
    const U = h.win.UpliftNativeChat._u35;
    const card = U.buildWebCard('web_search', { query: 'mlx speed' },
        { ok: true, results: [
            { title: 'A [weird] title', url: 'https://a.example/' },
            { title: 'evil', url: 'javascript:alert(1)' },
        ] });
    const md = U.cardMarkdown(card);
    assert.match(md, /^Searched the web \u201cmlx speed\u201d/);
    assert.ok(md.includes('- [A weird title](https://a.example/)'),
              'brackets escaped, gated link kept: ' + md);
    assert.ok(!md.includes('javascript'), 'no unsafe scheme in the persisted form');
    const fetch = U.cardMarkdown(U.buildWebCard('fetch_url', {},
        { ok: true, url: 'https://example.com/p', content: 'x' }));
    assert.ok(fetch.startsWith('Read page'), fetch);
    assert.ok(fetch.includes('[https://example.com/p](https://example.com/p)'));
});

// ---- 4: status labels (classic catalog keys) --------------------------------
test('UP-35: toolStatusText mirrors classic builtinToolStatusLabel + calling_tools', () => {
    const h = makeHarness();
    const U = h.win.UpliftNativeChat._u35;
    assert.equal(U.toolStatusText(['web_search']), 'Searching the web');
    assert.equal(U.toolStatusText(['fetch_url']), 'Fetching page');
    assert.equal(U.toolStatusText(['web_search', 'web_search']),
                 'Searching the web', 'unique names decide (classic)');
    assert.equal(U.toolStatusText(['srv__x']), 'Calling srv__x');
    assert.equal(U.toolStatusText(['a', 'b']), 'Calling a, b');
    assert.equal(U.toolStatusText(['a', 'b', 'c', 'd']), 'Calling a, b +2 more');
    assert.equal(U.toolStatusText([]), '');
});

// ---- 5: the handler end to end (record level) -------------------------------
test('UP-35: two rounds -> reset marker between them, TWO store rows, per-round thinking', async () => {
    const h = await makeHarness().booted();
    const { st, responses } = await runTurn(h);
    const texts = responses.map((r) => (r.overwrite ? 'RESET' : r.text));
    const resetAt = texts.indexOf('RESET');
    assert.ok(resetAt >= 0, 'the round boundary resets the streaming bubble');
    assert.ok(texts.slice(0, resetAt).join('').includes('Let me look that up.'),
              'round 1 streamed BEFORE the reset: ' + texts.join('|'));
    assert.ok(texts.slice(resetAt + 1).join('').includes('Final answer.'),
              'round 2 streams AFTER the reset: ' + texts.join('|'));
    assert.ok(!responses.some((r) => (r.text || '').includes('Tool calls')),
              'the old Tool-calls preview text is gone from the bubble');
    assert.ok(!responses.some((r) => (r.text || '').includes('![tool image]')),
              'no image markdown into the joined bubble either');

    // the live status line: classic\u2019s label WHILE the tool runs, gone after
    assert.equal(h.probes.statusDuringSearch, 'Searching the web');
    assert.equal(st.toolStatus, '', 'status cleared when the results landed');
    assert.equal(h.probes.searchCalls, 1);
    assert.deepEqual(h.win.UpliftNativeChat._state().toolsUsed,
                     [{ round: 1, calls: ['web_search'] }],
                     'the per-turn tool log is untouched (fresh _state(): '
                     + '_tools is re-assigned per turn)');

    // deep-chat finalises the bubble -> onMessage (drives the real seam)
    st.dc.onMessage({ isHistory: false, message: { role: 'ai', text: 'Final answer.' } });
    const ms = st.conv.messages;
    assert.equal(ms.length, 3, 'user + sealed round + final answer');
    assert.equal(ms[1].role, 'assistant');
    assert.equal(ms[2].content, 'Final answer.');
    const roundContent = ms[1].content;
    assert.ok(roundContent.startsWith('Let me look that up. '), roundContent);
    assert.ok(roundContent.includes('Searched the web \u201cmlx speed\u201d'), roundContent);
    assert.ok(roundContent.includes('[MLX on Apple Silicon](https://mlx.app/)'), roundContent);
    assert.ok(roundContent.includes('[blog.example](https://blog.example/post)'),
              'titleless row persists by host');
    assert.ok(!roundContent.includes('javascript'), 'the unsafe result never persisted');
    // per-round thinking: each row owns ITS slice (5c)
    assert.equal(ms[1].reasoning_content, 'r1 think');
    assert.equal(ms[2].reasoning_content, 'r2 think',
                 'round 2 no longer overwrites round 1\u2019s reasoning');
    assert.deepEqual(st.rounds, [], 'the buffer was drained by onMessage');
});

test('UP-35: fallback drain — rounds survive when deep-chat never finalises (stop/error)', async () => {
    const h = await makeHarness().booted();
    const { st } = await runTurn(h);
    assert.equal(st.rounds.length, 1, 'round buffered, waiting for the turn end');
    // NO onMessage call: the close() fallback must still persist the round
    await new Promise((r) => setTimeout(r, 90));
    const ms = st.conv.messages;
    assert.equal(ms.length, 2, 'user + flushed round row');
    assert.ok(ms[1].content.includes('Searched the web'), ms[1].content);
    assert.deepEqual(st.rounds, []);
    const again = st.conv.messages.length;
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(st.conv.messages.length, again, 'drain is one-shot (no double insert)');
});

// ---- 6: the live DOM surgery -------------------------------------------------
test('UP-35: sealed segment in the shadow DOM — text moved, thinking frozen, card + status replaced', async () => {
    const h = await makeHarness().booted();
    const M = h.win.UpliftNativeChat;
    // wire the shadow stub into the shape the surgery walks:
    // messagesRoot > outer > holder > bubble (deep-chat's real chain)
    const renderedP = h.mkEl('p');
    renderedP.className = ''; renderedP.textContent = 'Let me look that up.';
    const bubble = h.mkEl('div');
    bubble.className = 'message-bubble ai-message ai-message-text';
    bubble.classList.add('message-bubble', 'ai-message');
    bubble.children = [renderedP];
    const holder = h.mkEl('div');
    holder.className = 'inner-message-container';
    holder.appendChild(bubble);
    const outer = h.mkEl('div');
    outer.className = 'outer-message-container';
    outer.appendChild(holder);
    const msgsRoot = h.mkEl('div');
    msgsRoot.id = 'messages';
    msgsRoot.appendChild(outer);
    h.shadow.querySelectorAll = (sel) => {
        if (sel === '.message-bubble') return [bubble];
        if (sel.includes('data-live'))
            return queryAll(holder, '.chat-native-thinking[data-live="1"]')
                .filter((c) => c.dataset.live === '1');
        return [];   // schemeGuard sweeps
    };
    const turn = await runTurn(h, () => { h.__segWired = true; });
    const segs = msgsRoot.children.filter((c) => c.className === 'chat-native-round');
    assert.equal(segs.length, 1, 'ONE sealed segment for ONE tool round');
    assert.equal(msgsRoot.children.indexOf(segs[0]),
                 msgsRoot.children.indexOf(outer) - 1,
                 'the segment sits directly above the streaming bubble');
    const [frozenThink, txEl, toolsEl] = segs[0].children;
    assert.equal(frozenThink.className, 'chat-native-thinking');
    assert.equal(frozenThink.dataset.live, '', 'the block was FROZEN (no longer the live one)');
    assert.equal(frozenThink.open, false);
    assert.equal(frozenThink.querySelector('.chat-native-think-body').textContent,
                 'r1 think', 'the segment keeps round 1\u2019s own reasoning');
    assert.equal(txEl.children[0], renderedP,
                 'the rendered markdown MOVED from the bubble into the segment');
    assert.equal(renderedP.parentElement, txEl);
    // the status line was painted while the tool ran and removed when it landed
    assert.ok(!toolsEl.children.some((c) => c.className === 'chat-native-tool-status'),
              'status replaced by the results');
    const card = toolsEl.children.find((c) => c.className === 'chat-native-web-card');
    assert.ok(card, 'the source card lives inside the round segment');
    assert.equal(card.dataset.ok, '1');
    const link = card.children[1].children[0];
    assert.equal(link.href, 'https://mlx.app/');
    assert.equal(link.rel, 'noopener noreferrer');
    // and round 2 got a FRESH live thinking block (no clobber, no sharing)
    const liveThink = holder.children.find((c) => c.className === 'chat-native-thinking');
    assert.ok(liveThink && liveThink.dataset.live === '1',
              'a new live block anchored to the streaming bubble');
    assert.equal(liveThink.querySelector('.chat-native-think-body').textContent,
                 'r2 think');
    // flush through onMessage -> exactly two assistant rows (two rounds, two segments)
    turn.st.dc.onMessage({ isHistory: false,
                           message: { role: 'ai', text: 'Final answer.' } });
    assert.deepEqual(turn.st.conv.messages.map((m) => m.role),
                     ['user', 'assistant', 'assistant']);
});
