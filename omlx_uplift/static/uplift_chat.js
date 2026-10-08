/* NAT-4 3/6: native Chat core — vendored deep-chat, streaming, stop,
   model picker, system prompt, copy/regenerate/edit, history (server
   store + first-boot migration), admin-gated key handout.
   Proven seams only (NAT-6 S1 drill + bundle contract):
   - connect={url:'/v1/chat/completions', stream:true} — the component
     parses SSE frames and skips [DONE] itself.
   - requestInterceptor receives {body, headers}: the TEXT path body is
     {messages:[{role,text}]} built from component history, the FILES
     path is FormData; we REPLACE the body with a full OpenAI request
     built from OUR conversation state (system prompt + history +
     thinking fields), which sidesteps the history-in-body trap (NAT-1
     item 7) entirely: our store is the source, never component limits.
   - responseInterceptor receives each parsed chunk object; returns
     {text} (raw3 proof). reasoning_content/tool_calls deltas map to
     '' here — the collapsible thinking + tool render is commit 4/6.
   - ESM bundle: plain <script> cannot load it (file ends in `export`);
     injected as a module at mount only. Kill-switch off: the small
     bootstrap loads but fetches NOTHING — verified zero vendor requests
     via performance entries (the 387 KB bundle never hits the wire).
   - key handout via /uplift/api/chat/key (NAT-1 auth verdict), held in
     this module's memory only — never written to localStorage; classic's
     own key flow (template injection) is untouched on the embed path.
   i18n: labels reuse classic chat.* keys where they exist; new
   uplift.chat.* keys added to all 10 locales in this commit. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftNativeChat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var _mounted = false, _dc = null, _key = null, _convs = [], _conv = null,
    _models = [], _vendorPromise = null, _streaming = false,
    _thinkLive = '';   // reasoning deltas of the in-flight turn (live-only)

function W() { return (typeof window !== 'undefined') ? window : null; }
function C() { return W() && W().UpliftCore ? W().UpliftCore : null; }
function D() { return W() && W().UpliftDom ? W().UpliftDom : null; }
function api() {
    var st = W() && W().Uplift && W().Uplift.state;
    return ((st && st.API) || '') + '/uplift/api';
}
function base() {
    var st = W() && W().Uplift && W().Uplift.state;
    return ((st && st.API) || '') + '/uplift';
}
function t(key, fb) {
    var c = C();
    var v = (c && c.t) ? c.t(key) : key;
    return v === key ? (fb || key) : v;
}
function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function gid(id) { return document.getElementById(id); }

// ---- conversation state (server-backed) ----------------------------------

function newConv() {
    return { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
             title: t('chat.new_chat', 'New Chat'),
             model: (_models[0] || {}).id || '', systemPrompt: '',
             // thinking: 'auto'|'off'|'on'|'limit' — classic's select, same
             // wire semantics (openai_models.py: enable_thinking,
             // thinking_budget). Live-only: the history store keeps
             // model/systemPrompt/messages; thinking settings re-default
             // to auto on reload (stated on the NAT-4 card, 4/6).
             thinking: 'auto', thinkingBudget: null, messages: [] };
}
function saveConv() {
    if (!_conv) return;
    // keep the summary list in sync (picker + boot ordering): upsert
    var sum = { id: _conv.id, title: _conv.title, model: _conv.model,
                message_count: (_conv.messages || []).length,
                updated: Date.now() };
    for (var i = 0; i < _convs.length; i++) {
        if (_convs[i].id === _conv.id) { _convs[i] = sum; break; }
        if (i === _convs.length - 1) _convs.push(sum);
    }
    if (!_convs.length) _convs.push(sum);
    var d = D();
    d.postJson(api() + '/chat/history', _conv).then(function (r) {
        var warn = gid('chat-native-warn');
        if (warn) warn.hidden = !(r && r.kb && r.kb > 512);
    }).catch(function (e) {
        d.toast(String((e && e.message) || e), 'error');
    });
    refreshConvList();
}
function renderHistory() {
    // classic persists thinking per message; the single live panel shows
    // the most recent assistant turn's (older ones stay in the store —
    // per-message bubbles inside deep-chat need wrappers the bundle does
    // not expose; stated limitation on the card)
    var ms = (_conv && _conv.messages) || [];
    _thinkLive = '';
    for (var i = ms.length - 1; i >= 0; i--) {
        if (ms[i].role === 'assistant') {
            _thinkLive = String(ms[i].reasoning_content || '');
            break;
        }
    }
    setTimeout(paintThinking, 0);
    if (!_dc) return;
    _dc.history = (_conv.messages || []).filter(function (m) { return m.content; })
        .map(function (m) {
            return { role: m.role === 'assistant' ? 'ai' : (m.role || 'user'),
                     text: String(m.content) };
        });
}
async function openConv(id) {
    if (id === (_conv && _conv.id)) return;
    var d = D();
    var full = await d.fetchJson(api() + '/chat/history/' + encodeURIComponent(id));
    _conv = Object.assign(newConv(), full);
    renderHistory();
    var sel = gid('chat-native-model');
    if (sel) sel.value = _conv.model || '';
    var sys = gid('chat-native-sys');
    if (sys) sys.value = _conv.systemPrompt || '';
    refreshConvList();
}
function refreshConvList() {
    var list = gid('chat-native-convs');
    if (!list) return;
    var ph = el('option', null, t('chat.chat_history_label', 'Chat History'));
    ph.value = '';
    list.replaceChildren(ph);
    _convs.slice().reverse().forEach(function (s) {
        var o = el('option', null, (s.title || s.id).slice(0, 40));
        o.value = s.id;
        if (_conv && s.id === _conv.id) o.selected = true;
        list.appendChild(o);
    });
}

async function migrateLegacy() {
    /* NAT-1 item 7: one-shot import of classic's localStorage store
       ('omlx_chat_history'); consumed (old key removed) only after the
       server accepted everything. The mirror-back half of the verdict
       is NOT done: dual-writing history on every save would double the
       classic quota risk this migration exists to escape; recorded on
       the card as the accepted tradeoff until NAT-5. */
    var raw = null;
    try { raw = localStorage.getItem('omlx_chat_history'); } catch (e) { return 0; }
    if (!raw) return 0;
    var parsed = [];
    try { parsed = JSON.parse(raw) || []; } catch (e) { return 0; }
    var d = D(), n = 0;
    try {
        for (var i = 0; i < parsed.length; i++) {
            var e2 = parsed[i];
            if (!e2 || !Array.isArray(e2.messages) || !e2.messages.length) continue;
            await d.postJson(api() + '/chat/history', {
                id: String(e2.id || ('mig' + i)),
                title: e2.title || t('chat.untitled_title', 'Untitled'),
                model: e2.model || '', systemPrompt: e2.systemPrompt || '',
                messages: e2.messages });   // backend strips image data-URLs
            n++;
        }
        localStorage.removeItem('omlx_chat_history');
    } catch (e) { return 0; }   // keep legacy untouched for next boot
    return n;
}

// ---- request/response shaping (proven S1 interceptor path) ---------------

function fileToDataURL(f) {
    return new Promise(function (res, rej) {
        var r = new FileReader();
        r.onload = function () { res(r.result); };
        r.onerror = rej;
        r.readAsDataURL(f);
    });
}

async function shapeRequest(d) {
    d.headers = d.headers || {};
    d.headers['Authorization'] = 'Bearer ' + _key;
    _streaming = true;   // fires on every submit path (button, enter,
                         // programmatic) — the reliable streaming start
    _thinkLive = '';     // new turn: reasoning panel restarts empty
    if (typeof paintThinking === 'function') setTimeout(paintThinking, 0);
    var raw = Array.isArray(d.body) ? d.body
        : (d.body && d.body.messages) ? d.body.messages : [];
    var files = [], lastUser = '';
    if (typeof FormData !== 'undefined' && d.body instanceof FormData) {
        var entries = Array.from(d.body.entries());
        entries.forEach(function (e) {
            if (e[1] instanceof File) { files.push(e[1]); return; }
            try {
                var m = typeof e[1] === 'string' ? JSON.parse(e[1]) : e[1];
                if (m && m.text) lastUser = m.text;
            } catch (err) { /* non-json entry */ }
        });
    } else if (raw.length) {
        lastUser = String((raw[raw.length - 1] || {}).text || '');
    }
    var msgs = [];
    var sp = (_conv && _conv.systemPrompt) || '';
    if (sp) msgs.push({ role: 'system', content: sp });
    (_conv ? _conv.messages : []).forEach(function (m) {
        if (m.role === 'system') return;
        msgs.push({ role: m.role, content: m.content });
    });
    // A trailing user turn in the store is EITHER the submission the
    // component just recorded (re-built below from cur, the authoritative
    // copy) OR an orphan of a failed send whose onError pop arrived late.
    // Chat templates reject user/user sequences (proven live: 400
    // 'Conversation roles must alternate'), so strip all trailing users
    // REQUEST-LOCALLY before appending cur — the next send must work no
    // matter what a previous failure left behind. The store keeps the
    // orphan row (onError normally pops it; a persisted leftover is
    // cosmetic history only, never poisons requests again).
    while (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
    var cur = { role: 'user', content: lastUser };
    if (files.length) {
        var parts = lastUser ? [{ type: 'text', text: lastUser }] : [];
        for (var i = 0; i < files.length; i++) {
            parts.push({ type: 'image_url',
                         image_url: { url: await fileToDataURL(files[i]) } });
        }
        cur.content = parts;
    }
    msgs.push(cur);
    var body = { model: (_conv && _conv.model) || '', messages: msgs, stream: true };
    var mode = (_conv && _conv.thinking) || 'auto';
    if (mode === 'off') body.enable_thinking = false;
    else if (mode === 'on') body.enable_thinking = true;
    else if (mode === 'limit') {
        body.enable_thinking = true;
        var b = parseInt(_conv.thinkingBudget, 10);
        if (isFinite(b) && b >= 0) body.thinking_budget = b;
    }
    // 'auto': send NOTHING — model/template default (classic parity)
    // NAT-6 S1 proven trap: deep-chat stringifies the interceptor body on
    // the TEXT path only; the FILES path sends it raw -> omlx sees
    // multipart FormData and 422s. Files path must hand a JSON string and
    // set the content type itself.
    if (typeof FormData !== 'undefined' && d.body instanceof FormData) {
        d.headers['Content-Type'] = 'application/json';
        d.body = JSON.stringify(body);
    } else {
        d.body = body;
    }
    return d;
}

function shapeResponse(r) {
    if (!r || typeof r !== 'object') return { text: '' };
    var ch = (r.choices && r.choices[0]) || {};
    var delta = ch.delta || ch.message || {};
    // reasoning arrives as delta.reasoning_content (live-verified against
    // the dev keg, 4/6 drill); deep-chat has NO thinking support (zero
    // 'thinking' tokens in the bundle) -> hybrid: we buffer it and render
    // our own collapsible panel above the component (card Rules allow
    // this; silent feature drop does not). tool_calls still land in 5/6.
    var rc = delta.reasoning_content;
    if (typeof rc === 'string' && rc) {
        _thinkLive += rc;
        paintThinking();
    }
    return { text: delta.content || '' };
}

function paintThinking() {
    var panel = gid('chat-native-think');
    if (!panel) return;
    // classic hides the whole thinking block when the model produced no
    // visible reasoning (hasVisibleThinking) — same rule here: no text,
    // no panel, regardless of the mode selection
    var body = panel.querySelector('.chat-native-think-body');
    if (body) body.textContent = _thinkLive;
    panel.hidden = !_thinkLive || !_thinkLive.trim();
}

// ---- vendor (ESM, loaded once at mount, never on the embed path) ---------

function ensureVendor() {
    if (_vendorPromise) return _vendorPromise;
    _vendorPromise = new Promise(function (res, rej) {
        if (W().customElements && W().customElements.get('deep-chat')) return res();
        var m = document.createElement('script');
        m.type = 'module';
        m.textContent = "import '" + base() +
            "/vendor/deep-chat/deep-chat-2.5.1.bundle.js';" +
            "window.dispatchEvent(new Event('uplift-deepchat-ready'));";
        m.onerror = function () { rej(new Error('deep-chat module failed')); };
        document.head.appendChild(m);
        W().addEventListener('uplift-deepchat-ready', function () { res(); },
                             { once: true });
        setTimeout(function () { rej(new Error('deep-chat load timeout')); }, 10000);
    });
    return _vendorPromise;
}

// ---- UI -------------------------------------------------------------------

function toolbar() {
    var bar = el('div', 'chat-native-bar');
    var list = el('select'); list.id = 'chat-native-convs';
    list.addEventListener('change', function () {
        if (list.value) openConv(list.value).catch(function (e) {
            D().toast(String((e && e.message) || e), 'error'); });
    });
    var newBtn = el('button', 'btn', t('chat.new_chat', 'New Chat'));
    newBtn.type = 'button';
    newBtn.addEventListener('click', function () {
        _conv = newConv();
        if (_dc) _dc.history = [];
        refreshConvList();
    });
    var sel = el('select'); sel.id = 'chat-native-model';
    var ph = el('option', null, t('chat.select_model', 'Select Model'));
    ph.value = ''; sel.appendChild(ph);
    _models.forEach(function (m) {
        var o = el('option', null, m.id); o.value = m.id; sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
        if (_conv) { _conv.model = sel.value; saveConv(); }
    });
    var sys = el('input'); sys.id = 'chat-native-sys'; sys.type = 'text';
    sys.placeholder = t('chat.system_prompt.placeholder',
                        'e.g. You are a helpful assistant. Be concise.');
    sys.addEventListener('change', function () {
        if (_conv) { _conv.systemPrompt = sys.value; saveConv(); }
    });
    function toolBtn(label, title, fn) {
        var b = el('button', 'btn', label);
        b.type = 'button'; b.title = title;
        b.addEventListener('click', fn);
        return b;
    }
    var think = el('select'); think.id = 'chat-native-think-mode';
    [['auto', 'chat.thinking_mode.auto', 'Auto'],
     ['on', 'chat.thinking_mode.on_unlimited', 'On (Unlimited)'],
     ['limit', 'chat.thinking_mode.on_limited', 'On (Limit)'],
     ['off', 'chat.thinking_mode.off', 'Off']].forEach(function (o) {
        var e2 = el('option', null, t(o[1], o[2])); e2.value = o[0];
        think.appendChild(e2);
    });
    think.value = (_conv && _conv.thinking) || 'auto';
    var budget = el('input'); budget.id = 'chat-native-think-budget';
    budget.type = 'number'; budget.min = '0'; budget.step = '1024';
    budget.placeholder = t('modal.model_settings.thinking_budget_placeholder',
                           'e.g. 4096');
    budget.value = (_conv && _conv.thinkingBudget) || '';
    budget.hidden = think.value !== 'limit';
    function saveThinking() {
        if (!_conv) return;
        _conv.thinking = think.value;
        var b = parseInt(budget.value, 10);
        _conv.thinkingBudget = (isFinite(b) && b >= 0) ? b : null;
        budget.hidden = think.value !== 'limit';
        saveConv();   // fields themselves are live-only (store drops them)
    }
    think.addEventListener('change', saveThinking);
    budget.addEventListener('change', saveThinking);
    var copy = toolBtn(t('chat.copy_tooltip', 'Copy'),
                       t('uplift.chat.copy_last', 'Copy last reply'),
                       function () {
        var ms = _conv && _conv.messages || [];
        for (var i = ms.length - 1; i >= 0; i--) {
            if (ms[i].role === 'assistant') {
                (W().navigator.clipboard
                    ? W().navigator.clipboard.writeText(ms[i].content)
                    : Promise.reject(new Error('no clipboard')))
                    .then(function () { D().toast(t('chat.copy_tooltip', 'Copy'), 'ok'); },
                          function (e) { D().toast(String((e && e.message) || e), 'error'); });
                return;
            }
        }
    });
    var regen = toolBtn(t('chat.regenerate_tooltip', 'Regenerate'),
                        t('uplift.chat.regenerate', 'Regenerate last reply'),
                        function () {
        if (_streaming || !_conv) return;
        var ms = _conv.messages;
        while (ms.length && ms[ms.length - 1].role === 'assistant') ms.pop();
        if (!ms.length) return;
        var lastUser = ms[ms.length - 1];
        if (lastUser.role !== 'user') return;
        ms.pop();
        renderHistory();
        saveConv();
        _dc.submitUserMessage({ text: String(lastUser.content) });
    });
    var edit = toolBtn(t('chat.edit_tooltip', 'Edit message'),
                       t('uplift.chat.edit_resend', 'Edit & resend last message'),
                       function () {
        if (_streaming || !_conv) return;
        var ms = _conv.messages, ui = -1;
        for (var i = ms.length - 1; i >= 0; i--) {
            if (ms[i].role === 'user') { ui = i; break; }
        }
        if (ui < 0) return;
        var nv = window.prompt(t('chat.edit_tooltip', 'Edit message'),
                               String(ms[ui].content));
        if (nv == null) return;
        _conv.messages = ms.slice(0, ui);
        renderHistory();
        saveConv();
        _dc.submitUserMessage({ text: nv });
    });
    var del = toolBtn(t('chat.delete_tooltip', 'Delete'),
                      t('chat.delete_tooltip', 'Delete chat'),
                      async function () {
        if (!_conv || !_conv.messages.length) return;
        if (!window.confirm(t('chat.confirm_delete_chat',
                              'Are you sure you want to delete this chat?'))) return;
        var d = D();
        try {
            await d.deleteJson(api() + '/chat/history/' + encodeURIComponent(_conv.id));
            _convs = _convs.filter(function (c) { return c.id !== _conv.id; });
            _conv = newConv();
            if (_dc) _dc.history = [];
            refreshConvList();
        } catch (e) { d.toast(String((e && e.message) || e), 'error'); }
    });
    bar.append(list, newBtn, sel, sys, think, budget, copy, regen, edit, del);
    return bar;
}

function applyShadowTheme(dc) {
    /* live restyle hook: deep-chat config styles apply ONCE at render
       (NAT-1 item 9), so skin colors are pushed into the open shadowRoot
       as our own <style>. Full skin-matrix drill is card feature 6. */
    var root = dc && dc.shadowRoot;
    if (!root) return false;
    var s = W().getComputedStyle(document.documentElement);
    function v(n, fb) { return (s.getPropertyValue(n).trim()) || fb; }
    var css = [
        '.deep-chat-outer-container, #chat-view, .input-container,',
        '.text-input { background:', v('--card', '#141a24'), ';color:', v("--ink", "#e6edf3"), '; }',
        '.user-message, .user-message-container { background:', v('--accent', '#4c8dff') + '33;',
        'color:', v("--ink", "#e6edf3"), '; }',
        'a { color:', v('--accent', '#4c8dff'), '; }',
    ].join(' ');
    var st = root.getElementById ? root.getElementById('uplift-chat-theme') : null;
    if (!st) { st = el('style'); st.id = 'uplift-chat-theme'; root.appendChild(st); }
    st.textContent = css;
    return true;
}

function mount() {
    var host = gid('chat-native');
    if (!host || _mounted) return;
    _mounted = true;
    host.replaceChildren();
    var wrap = el('div', 'chat-native-wrap');
    var warn = el('div', 'native-stub-note'); warn.id = 'chat-native-warn';
    warn.hidden = true;
    warn.textContent = t('uplift.chat.history_warn',
        'This conversation is large; older turns may hit model limits.');
    var boot = el('div', 'native-stub-note'); boot.id = 'chat-native-boot';
    boot.textContent = t('uplift.chat.booting', 'Loading chat…');
    wrap.append(warn, boot);
    host.appendChild(wrap);

    Promise.all([
        ensureVendor(),
        D().fetchJson(api() + '/models'),
        D().fetchJson(api() + '/chat/key').then(function (k) { _key = k.api_key; }),
        D().fetchJson(api() + '/chat/history'),
    ]).then(function (res) {
        _models = ((res[1] && res[1].models) || []).filter(function (m) {
            var ty = m.engine_type || m.model_type;
            return ty === 'llm' || ty === 'vlm';
        });
        _convs = res[3] || [];
        if (!_convs.length) {
            return migrateLegacy().then(function (n) {
                return D().fetchJson(api() + '/chat/history');
            }).then(function (l) { _convs = l || []; });
        }
    }).then(function () {
        _conv = _convs.length
            ? Object.assign(newConv(), _convs[_convs.length - 1], { messages: [] })
            : newConv();
        var b = gid('chat-native-boot'); if (b) b.remove();
        wrap.insertBefore(toolbar(), wrap.firstChild);
        var tp = el('details'); tp.id = 'chat-native-think';
        tp.className = 'chat-native-think'; tp.hidden = true; tp.open = true;
        var th = el('summary'); th.textContent = t('chat.thinking_label', 'Thinking');
        var tb = el('pre'); tb.className = 'chat-native-think-body';
        tp.append(th, tb);
        var dcHost = gid('chat-native-dc');
        if (!dcHost) { dcHost = el('div'); dcHost.id = 'chat-native-dc'; }
        wrap.append(tp, dcHost);
        // summary rows carry no messages — open the latest conversation
        // fully before rendering (the picker is summaries by design)
        return _convs.length
            ? D().fetchJson(api() + '/chat/history/' +
                            encodeURIComponent(_conv.id))
                .then(function (full) {
                    if (full && Array.isArray(full.messages)) {
                        _conv = Object.assign(_conv, full);
                    }
                }).catch(function () { /* empty conv is fine */ })
            : null;
    }).then(function () {
        var dc = document.createElement('deep-chat');
        _dc = dc;
        dc.style.height = '62vh';
        dc.connect = { url: '/v1/chat/completions', stream: true, headers: {} };
        dc.requestInterceptor = shapeRequest;
        dc.responseInterceptor = shapeResponse;
        dc.errorMessages = { displayServiceErrorMessages: true };
        dc.textInput = { placeholder: {
            text: t('chat.input_placeholder', 'Type a message...') } };
        dc.images = true;           // card feature 3 base (vision drill 4/6)
        dc.onMessage = function (body) {
            var m = body.message;
            if (!m || body.isHistory) return;
            var role = m.role === 'ai' ? 'assistant' : (m.role || 'user');
            if (role === 'assistant') _streaming = false;
            if (_conv) {
                var row = { role: role,
                    content: typeof m.text === 'string' ? m.text : '' };
                if (role === 'assistant' && _thinkLive) {
                    row.reasoning_content = _thinkLive;  // persisted (4/6)
                }
                _conv.messages.push(row);
                if (role === 'user' && _conv.messages.filter(function (x) {
                        return x.role === 'user'; }).length === 1) {
                    _conv.title = String(m.text || '').slice(0, 48)
                        || _conv.title;
                }
                saveConv();
            }
        };
        // streaming flag for the regen/edit guards: the component fires a
        // final ai onMessage when the stream closes; onError resets it so
        // a failed stream never wedges the flag. Submit-side flagging is
        // NOT wrapped here — the bundle installs submitUserMessage in a
        // setTimeout after connect (proven in the bundle source), so any
        // wrap at creation time is silently overwritten; onMessage +
        // onError cover every real path (button, enter, programmatic).
        dc.onError = function () {
            // The failed user turn STAYS in store and view (classic
            // behavior: the error bubble sits under the message you
            // typed). The poison it could cause — a stored user/user
            // sequence — is neutralised request-locally in
            // shapeRequest, proven live 2026-10-08; popping here was
            // tried first and lost typed input on transient errors.
            _streaming = false;
            paintThinking();
        };
        // un-wedge watch: abort/error before the first chunk removes the
        // loading bubble WITHOUT any onMessage (proven in bundle: stop
        // runs attemptToFinaliseStream -> removeLastMessage), so the
        // streaming flag could stick true and silently block regen/edit.
        // Live-stream truth from the bundle: '.deep-chat-loading-message-
        // bubble' (pre-first-token) then '.streamed-message' (added on
        // the ai bubble, removed by finaliseStreamedMessage). Three-cycle
        // grace: a stalled model can be between submit and bubble
        // creation; a wrong-early reset only opens regen/edit for one
        // tick, a stuck flag wedges the panel until reload.
        var _watch = 0;
        setInterval(function () {
            if (!_streaming) { _watch = 0; return; }
            var root = dc.shadowRoot;
            if (!root) return;
            if (root.querySelector('.deep-chat-loading-message-bubble, .streamed-message'))
                _watch = 0;
            else if (++_watch >= 3) _streaming = false;
        }, 700);
        gid('chat-native-dc').appendChild(dc);
        renderHistory();
        // bounded shadow-theme wait: deep-chat upgrades async; if it never
        // does (stub env / broken vendor) stop after ~6s, don't spin
        var tries = 0;
        var tryTheme = function () {
            if (!applyShadowTheme(dc) && ++tries < 100) setTimeout(tryTheme, 60);
        };
        tryTheme();
        var mo = new MutationObserver(function () { applyShadowTheme(dc); });
        mo.observe(document.documentElement, { attributes: true,
            attributeFilter: ['class', 'data-g1', 'data-g2', 'data-g3'] });
        var sel = gid('chat-native-model');
        if (sel) sel.value = _conv.model || '';
        var sys = gid('chat-native-sys');
        if (sys) sys.value = _conv.systemPrompt || '';
        refreshConvList();
        if (!_models.length) {
            D().toast(t('chat.no_models', 'No models available'), 'error');
        }
    }).catch(function (e) {
        var b = gid('chat-native-boot');
        if (b) b.textContent = 'chat: ' + String((e && e.message) || e);
    });
}

return { mount: mount, isMounted: function () { return _mounted; },
         shapeRequest: shapeRequest, shapeResponse: shapeResponse,
         newConv: newConv, migrateLegacy: migrateLegacy,
         _state: function () { return { conv: _conv, convs: _convs,
                                        models: _models,
                                        streaming: _streaming,
                                        thinkingLive: _thinkLive }; } };
});
