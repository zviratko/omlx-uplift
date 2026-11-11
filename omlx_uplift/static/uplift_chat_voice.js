/* SPLIT-3: chat read-aloud (VOICE-1b, VOICE-11, VOICE-16): voice list and
   selection, auto-speak of live turns through the shared SpeechQueue,
   manual SPEAK, the per-message audio plans and memory cache, the
   waveform grid and the word highlight.
   Part of the native chat: uplift_chat.js calls this factory once with a
   bridge (CORE) to its helpers and live state, and uses the returned
   functions. Code moved from uplift_chat.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftChatParts = root.UpliftChatParts || {}).voice = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Chat-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, C = CORE.C, D = CORE.D, errText = CORE.errText, t = CORE.t,
    el = CORE.el, gid = CORE.gid, renderHistory = CORE.renderHistory,
    messageAt = CORE.messageAt, tf2 = CORE.tf2;
// late-bound: the voice-input part is created after this one
function rtSpeakEvent() { return CORE.rtSpeakEvent.apply(null, arguments); }

// ---- VOICE-1b: read-aloud state ------------------------------------------------
// Voices are stored server-side (routers/voices.py); this shell only caches
// the list and the selection. localStorage is the browser-preference
// mechanism (same rule as layout/theme), never a second source of truth.
var _voicesCache = null;        // null = not loaded yet

// ---- VOICE-11: auto-speak live turns -----------------------------------------
// The chunked engine (uplift_speechio.js) wired into the stream: one shared
// SpeechQueue serves BOTH live turns and manual SPEAK (whole-text push),
// so a new read always cuts the old one — the old _speakAbort busy token
// is replaced by the queue's own session token + stop().
var AUTO_KEY = 'omlx-uplift-autospeak';        // '1'/'0', default OFF
var CHUNK_KEY = 'omlx-uplift-speak-chunk';     // sentence|line|paragraph
var ROUTE_KEY = 'omlx-uplift-speak-route';     // 'uplift' (default) | 'vanilla'
var _speakQ = null;        // the ONE SpeechQueue (live + manual reads)
var _speakCtx = null;      // lazy shared AudioContext (gesture-created)
var _speakGen = 0;         // session id: cancel/end retire it, stale feeds die
var _speakZ = null;        // live-turn splitter   (per turn)
var _speakSan = null;      // live-turn sanitizer  (per turn, sentence mode)
var _speakBtn = null;      // manual SPEAK button currently reading
var _speakPushed = 0, _speakDropMark = 0, _speakPlayedMark = 0;

function lsGet(k) {
    try { return (W() && W().localStorage) ? W().localStorage.getItem(k) : null; }
    catch (_) { return null; }
}
function lsSet(k, v) {
    try { if (W() && W().localStorage) W().localStorage.setItem(k, v); }
    catch (_) { /* storage may be denied */ }
}
function autoSpeakOn() { return lsGet(AUTO_KEY) === '1'; }
function speakChunkMode() {
    var m = lsGet(CHUNK_KEY);
    return (m === 'line' || m === 'paragraph') ? m : 'sentence';
}
function speakRoute() {
    // Which server answers read-aloud. 'uplift' (default) is this board's own
    // voice engine: /uplift/api/voices/speech, with its audio cache, its
    // sanitizer and cloned-voice resolution. 'vanilla' asks the inference
    // server itself through POST /v1/audio/speech, the OpenAI-shaped API every
    // client uses - the same picker voice, a different door.
    var v = W() && W().localStorage;
    return (v && v.getItem(ROUTE_KEY)) === 'vanilla' ? 'vanilla' : 'uplift';
}
function SIO() { return W() && W().Uplift && W().Uplift.speechio; }
function speakCtx() {
    // queue NEVER creates/resumes a context (VOICE-10 contract): this is
    // the seam, called from the Send/SPEAK click gestures only
    if (!_speakCtx) {
        var AC = W() && (W().AudioContext || W().webkitAudioContext);
        if (!AC) return null;
        try { _speakCtx = new AC(); } catch (_) { return null; }
    }
    return _speakCtx;
}
function unlockSpeak() {
    // autoplay policy ties permission to the gesture: resume the shared
    // AudioContext INSIDE it; VOICE-1's silent-WAV unlock stays as the
    // fallback (iOS AudioSession rides any media played during the click)
    var c = speakCtx();
    if (c && c.state === 'suspended' && c.resume) { try { c.resume(); } catch (_) {} }
    var V = VOI();
    if (V && V.newPlayer) { try { V.newPlayer(null); } catch (_) {} }
}
function voiceRowById(id) {
    var list = _voicesCache || [];
    for (var i = 0; i < list.length; i++)
        if (list[i].id === id) return list[i];
    return null;
}
/* The vanilla door's macOS engine (SYNC-1 patch omlx-tts-macos-say, upstream
   PR #5076) knows ONE model id, 'macos-say', and takes the voice in the
   `voice` field. Uplift addresses the same voices with its own tokens
   ('say:<name>', 'say:<name>:<locale>', bare 'say'), which that door has
   never understood — until the swap it worked there only because our retired
   vendored patch spoke the same tokens. This maps a picker row onto the
   vanilla form; the chat's own door (the default) is untouched. */
function macosSayVoice(model) {
    var m = String(model || '');
    if (m !== 'say' && m.indexOf('say:') !== 0) return null;   // not a macOS row
    var tail = m.slice(4);
    if (!tail) return '';                       // bare 'say': let the server pick
    if (tail.indexOf(':') >= 0) tail = tail.split(':')[0];   // <name>:<locale>
    // A locale tail ('say:cs-CZ', SAY-2) names no voice. The OpenAI request
    // has no language field, so there is nothing to carry it in: send the
    // model bare and let autodetect or the configured default speak.
    if (/^[a-z]{2}([-_][A-Za-z0-9]{2,4}){0,2}$/.test(tail)) return '';
    return tail;                                // display name or full identifier
}
function vanillaSpeechCall(voiceId, chunk) {
    // The picker's row -> the vanilla server's call. A macOS row goes to the
    // engine's single model id with the voice name in `voice` (see
    // macosSayVoice); a stored or model voice splits into {model, voice}. A
    // row the catalog no longer has is sent as a model name and the server
    // answers honestly instead of the chat guessing.
    var r = voiceRowById(voiceId);
    var model = r && r.model ? String(r.model) : '';
    var ask = { input: chunk, response_format: 'wav' };
    // WAV at both doors: it is what the browser decode path already handles,
    // and it keeps the server out of a transcode hop per chunk
    var sayVoice = macosSayVoice(model);
    if (sayVoice !== null) {
        var body = Object.assign({ model: 'macos-say' }, ask);
        if (sayVoice) body.voice = sayVoice;
        return { url: '/v1/audio/speech', body: body };
    }
    if (model)
        return { url: '/v1/audio/speech',
                 body: Object.assign({ model: model, voice: (r.name || '') }, ask) };
    return { url: '/v1/audio/speech',
             body: Object.assign({ model: String(voiceId || 'macos-say') }, ask) };
}
async function vanillaSpeechFetch(url, body) {
    // /v1 takes the Bearer key, not the board session: the same credential the
    // chat already carries for /v1/chat/completions. Failures surface as the
    // server's own message, because the speech queue only ever looks at the
    // bytes - a 400 handed to it verbatim would decode as a broken clip.
    var r;
    try {
        r = await fetch(url, { method: 'POST',   // domkit-exempt: /v1 Bearer call, binary audio
            headers: { 'Content-Type': 'application/json',
                       'Authorization': 'Bearer ' + (CORE._key || '') },
            body: JSON.stringify(body) });
    } catch (e) {
        throw new Error(errText(e) || 'request failed');
    }
    if (!r.ok) {
        var msg = r.statusText || ('http ' + r.status), core = C();
        try {
            var j = await r.json();
            if (core && core.errorText) msg = core.errorText(j) || msg;
        } catch (_) { /* a non-JSON failure keeps the status text */ }
        throw new Error(msg);
    }
    return r;
}
function speakRequestFor(chunk) {
    // ONE request builder for both queues (the live turn and a replayed
    // bubble), so a route flip can never make them disagree mid-read
    if (speakRoute() === 'vanilla') return vanillaSpeechCall(chatVoiceId(), chunk);
    return { url: '/voices/speech', body: { voice: chatVoiceId(), input: chunk } };
}
function speakTransport(url, body) {
    // one transport seam for both doors; speechJson keeps its own watchdog and
    // error-text handling for the uplift mount
    if (String(url).indexOf('/v1/') === 0) return vanillaSpeechFetch(url, body);
    var V = VOI();
    if (!V || !V.speechJson) return Promise.reject(new Error('no voices module'));
    return V.speechJson(url, body);
}
function ensureSpeakQueue() {
    if (_speakQ) return _speakQ;
    var sio = SIO(), V = VOI();
    if (!sio || !V || !V.speechJson) return null;
    var ctx = speakCtx();
    if (!ctx) return null;
    _speakQ = sio.SpeechQueue({
        ctx: ctx,
        // the queue's default body is {input} alone; /voices/speech 404s
        // without a stored voice — the request seam adds the picker's
        // composite, and routes it to the door the Speak section picked.
        request: speakRequestFor,
        fetchLike: speakTransport,
    });
    return _speakQ;
}
function beginSpeakTurn() {
    if (!autoSpeakOn() || !hasVoices() || !SIO()) return null;
    var mode = speakChunkMode();
    // VOICE-16: the turn gets its OWN plan + queue before the first token, so
    // every chunk can raise its row the moment it is synthesized. The bubble
    // is not in the store yet (deep-chat appends the assistant row when the
    // stream closes), so the mid is minted HERE and stamped in onMessage —
    // that stamp is what binds the audio files to the bubble.
    _turnMid = newMid();
    _livePlan = { mid: _turnMid, conv: (CORE._conv || {}).id || '', mode: mode,
                  voice: chatVoiceId(), rev: 'r' + r6(), text: '', chunks: [],
                  rows: [], seqs: {}, planEl: null, bubble: null, live: true };
    // UP-65: a temporary chat leaves no audio files on the server either
    _livePlan.owner = (CORE._conv && CORE._conv.temporary) ? null
        : { conv: _livePlan.conv, msg: _turnMid, rev: _livePlan.rev };
    _plans[_turnMid] = _livePlan;
    var q = queueFor(_livePlan);
    if (!q) { _livePlan = null; _turnMid = ''; return null; }
    sayTake(q, _livePlan);
    _speakZ = SIO().createSpeechSplitter({ mode: mode });
    // the sanitizer flattens newlines; in line/paragraph modes the newline
    // IS the boundary, so only the prose (sentence) mode strips markdown.
    // VOICE-11a: it now hands over clean words as they arrive instead of
    // waiting for each line's newline, so a reply that is ONE long line still
    // gets its first SENTENCE synthesized while the model writes the second.
    _speakSan = mode === 'sentence' ? SIO().createSpeechSanitizer() : null;
    _speakDropMark = q.dropped().length;
    _speakPlayedMark = q.played();
    _speakPushed = 0;
    speakEvent(true);    // VOICE-13 echo guard: the mic stops listening NOW
    return ++_speakGen;
}
function speakFeed(delta, gen) {
    if (gen == null || gen !== _speakGen || !_speakZ) return;
    var p = _livePlan;
    var q = p && p.q ? p.q : ensureSpeakQueue();
    if (!q) return;
    var text = _speakSan ? _speakSan.push(delta) : delta;
    if (!text) return;
    var chunks = _speakZ.push(text);
    for (var i = 0; i < chunks.length; i++) {
        if (q.push({ text: chunks[i],
                     source: p ? chunkSource(p.owner, chunks[i]) : null }) >= 0) {
            _speakPushed++;
            q.__pushed = (q.__pushed || 0) + 1;
            if (p) { p.chunks.push(chunks[i]); sayGrow(p); }
        }
    }
}
/* a chunk arrived mid-stream: its row appears at once (synthesizing), then
   fills with the waveform when the bytes land */
function sayGrow(plan) {
    if (plan.planEl) sayStructure(plan, plan.bubble);
    var box = plan.box;
    if (box) sayInlinePaint(plan);
}
function endSpeakTurn(gen) {
    // turn end / error: flush the tail through the SAME queue and settle
    // once; the Stop path cancels via speakCancel (gen bump) and lands
    // silent here — cancelled audio never toasts
    if (gen == null || gen !== _speakGen) return;
    _speakGen++;
    var z = _speakZ, san = _speakSan, q = _speakQ;
    _speakZ = null; _speakSan = null;
    if (!z || !q) return;
    var chunks = [];
    if (san) { var last = san.flush(); if (last) chunks = z.push(last); }
    chunks = chunks.concat(z.flush());
    for (var i = 0; i < chunks.length; i++) {
        // the last sentence of a reply usually arrives HERE, not in the feed:
        // it has to join the plan as well, or it plays without a row or a number
        if (q.push({ text: chunks[i], source: _livePlan
                     ? chunkSource(_livePlan.owner, chunks[i]) : null }) >= 0) {
            _speakPushed++;
            q.__pushed = (q.__pushed || 0) + 1;
            if (_livePlan) { _livePlan.chunks.push(chunks[i]); sayGrow(_livePlan); }
        }
    }
    var pushed = _speakPushed, dropMark = _speakDropMark,
        playMark = _speakPlayedMark;
    q.drain().then(function (res) {
        speakEvent(false);           // VOICE-13: the mic may hear again
        if (res.stopped) return;     // cancelled mid-drain: stay silent
        speakToast(res, pushed, dropMark, playMark);
    });
}
function speakCancel() {
    // VOICE-11 cancel rules: Stop button, new user send, conversation
    // switch, New Chat, voice change, AUTO-SPEAK toggled off. Token bump:
    // late responses hit stale tokens and schedule nothing.
    var cp = _speakQ && _speakQ.__plan;
    _speakGen++;
    if (cp) {                         // VOICE-16: the rows stop mid-animation
        cp.playSeq = -1;
        cp.paused = false;
        sayHighlight(cp, -1);
        sayPaintAll(cp);
        sayInlinePaint(cp);
    }
    if (_speakQ && _livePlan && _speakQ === _livePlan.q) _livePlan.q = null;
    _sayPlan = null;
    _speakZ = null;
    _speakSan = null;
    if (_speakQ) _speakQ.stop();
    if (_speakBtn) { _speakBtn.classList.remove('playing'); _speakBtn = null; }
    speakEvent(false);   // VOICE-13: stop() cut the audio — the mic may hear
}
// VOICE-13 echo-guard seam (the half-duplex law: the listener never hears
// the assistant). ONE predicate + ONE event, wired into the settle points
// VOICE-11 already owns — begin/manual push = busy, drain/speakCancel = idle.
// No audio-clock polling: the queue itself says when it is done.
function speakBusy() {
    if (_speakZ || _speakBtn) return true;          // a turn feeding / reading
    var q = _speakQ;
    return !!(q && q.pending && q.pending() > 0);   // chunks unsettled
}
function speakEvent(busy) {
    try { rtSpeakEvent(!!busy); }
    catch (e) { /* the mic must never break a read-aloud */ }
}
function speakToast(res, pushed, dropMark, playMark) {
    // the ONE dropped-chunks toast of the ticket (engine only counts)
    var d = D();
    if (!d) return;
    var drops = res.dropped.length - (dropMark || 0);
    if (drops > 0) d.toast(t('uplift.chat.speak_dropped',
        '{n} audio chunks were skipped').replace('{n}', String(drops)), 'error');
    else if (pushed && (res.played - (playMark || 0)) <= 0)
        d.toast(t('uplift.chat.speak_failed',
            'No audio could be played for this reply.'), 'error');
}

function VOI() { return W() && W().Uplift && W().Uplift.voices; }
function hasVoices() { return !!(_voicesCache && _voicesCache.length); }
function chatVoiceId() {
    var v = W() && W().localStorage;
    var id = v ? (v.getItem('omlx-uplift-voice') || '') : '';
    if (_voicesCache && _voicesCache.length) {
        for (var i = 0; i < _voicesCache.length; i++)
            if (_voicesCache[i].id === id) return id;
        return _voicesCache[0].id;    // stored pick vanished -> first voice
    }
    return '';
}
function refreshVoices() {
    var V = VOI();
    if (!V) return;
    V.loadVoices().then(function (list) {
        _voicesCache = list || [];
        syncVoiceSelect();
        if (CORE._dc) renderHistory();     // bubbles re-attach: speak appears/disappears
    });
}
function syncVoiceSelect() {
    var sel = gid('chat-native-voice');
    if (!sel) return;
    var cur = chatVoiceId();
    sel.textContent = '';
    for (var i = 0; i < (_voicesCache || []).length; i++) {
        var o = document.createElement('option');
        o.value = _voicesCache[i].id;
        // VOICE-4 (user): read-aloud voices show as 'model:voice' — the
        // same composite the speech routes accept as an alias, and the
        // Voices page uses (Uplift.voices.voiceLabel is the single impl)
        var V = VOI();
        o.textContent = V && V.voiceLabel
            ? V.voiceLabel(_voicesCache[i]) : _voicesCache[i].name;
        sel.append(o);
    }
    if (!(_voicesCache || []).length) {
        sel.hidden = true;
        var g = sel.closest('.chat-native-group');
        if (g) g.hidden = true;
    } else {
        sel.hidden = false;
        sel.value = cur;
        var g2 = sel.closest('.chat-native-group');
        if (g2) g2.hidden = false;
    }
}
function msgSpeak(idx, btn) {
    // VOICE-16: the seam behind the transport row (and the old VOICE-11
    // tests). Manual read of a whole reply runs through the SAME plan the
    // auto-read uses — same chunk list, same cached audio, same numbers —
    // so speaking a bubble twice costs nothing and the two modes never
    // disagree about what chunk 3 is. A second click on the same button is
    // a stop; one read-aloud at a time across the page.
    var m = messageAt(idx);
    if (!m || !m.content) return;
    if (!VOI() || !SIO() || !hasVoices()) return;
    if (_speakBtn && _speakBtn === btn) { speakCancel(); return; }
    var plan = planFor(m);
    if (!plan || !plan.chunks.length) return;      // sanitised to nothing
    speakCancel();                      // supersede any live/manual read
    unlockSpeak();                      // THIS click is the gesture
    _speakBtn = btn || null;
    if (btn) btn.classList.add('playing');
    sayPlayAll(plan, plan.box || null);
}

// ---- VOICE-16: the bubble audio player ---------------------------------------
// One PLAN per spoken bubble: the exact chunk list the splitter produced (the
// same list a reload re-derives from the stored text), an opaque revision that
// ties those chunks to the audio files the bubble owns, and the rows the
// operator drives. The engine (uplift_speechio.js) owns the clock; this section
// owns the DOM, the in-page buffer cache in front of the server-side disk
// cache, and the number links between a row and the text it reads.
var _plans = {};                       // message mid -> plan
var _mem = new Map();                  // voice + US + chunk text -> AudioBuffer(s)
var _memBytes = 0;
var MEM_CAP = 64 * 1024 * 1024;        // one page session's replay budget
var _sayLoop = null;                   // the ONE rAF progress loop
var _sayPlan = null;                   // the plan that loop is painting
var _livePlan = null;                  // plan of the turn still streaming
var _turnMid = '';                     // mid the next assistant row will carry
var SAY_SEGS = 26;                     // waveform bars per row

function r6() { return Math.random().toString(36).slice(2, 8); }
function newMid() { return 'm' + Date.now().toString(36) + r6(); }
function ensureMid(m) { if (m && !m.mid) m.mid = newMid(); return m ? m.mid : ''; }
function sayRelease(mid) {
    // A bubble that is gone must not keep talking, keep its rows on screen, or
    // keep its identity in the plan map: that stale mid is what later grafted
    // the dead reply's chunk plan onto a NEW bubble (user: 'the new bubble
    // doesn't show chunks properly after delete + regenerate').
    var p = mid && _plans[mid];
    if (!p) return false;
    if (p.q) {
        if (_speakQ === p.q) { try { speakCancel(); } catch (e) { p.q.stop(); } }
        else { try { p.q.stop(); } catch (e) {} }
        p.q = null;
    }
    if (_livePlan === p) _livePlan = null;
    if (_turnMid === mid) _turnMid = '';
    if (p.planEl && p.planEl.remove) p.planEl.remove();
    p.planEl = null; p.bubble = null; p.box = null; p.rows = []; p.seqs = {};
    delete _plans[mid];
    return true;
}
function saySilence(mid) {
    // The plan map is keyed by mid and a mid can go missing (a row stored
    // before the identity was stamped, an aborted turn). The queue always knows
    // its own plan, so silence does not depend on the lookup succeeding.
    var hit = false;
    if (_speakQ && _speakQ.__plan && (!mid || _speakQ.__plan.mid === mid)) {
        speakCancel();
        hit = true;
    }
    if (mid && _plans[mid] && _plans[mid].q) { try { _plans[mid].q.stop(); } catch (e) {} }
    return sayRelease(mid) || hit;
}
function saySweepPlans() {
    // drop every plan whose bubble is no longer in the conversation: deletes and
    // regenerates go through paths that never knew about audio, and an orphaned
    // plan both keeps talking and lends its chunk lines to a later bubble
    var live = {}, ms = (CORE._conv && CORE._conv.messages) || [], i;
    for (i = 0; i < ms.length; i++) if (ms[i] && ms[i].mid) live[ms[i].mid] = 1;
    if (_turnMid) live[_turnMid] = 1;           // the reply still being streamed
    var orphans = [];
    for (var k in _plans) {
        if (Object.prototype.hasOwnProperty.call(_plans, k) && !live[k]) orphans.push(k);
    }
    for (i = 0; i < orphans.length; i++) saySilence(orphans[i]);
    return orphans.length;
}
// The door is part of the identity: the same voice and text synthesized by
// this board and by the vanilla server are different bytes, and a clip read
// through one must not answer a request made through the other.
function memKey(text) { return chatVoiceId() + speakRoute() + '\u001f' + text; }
function memGet(text) {
    var k = memKey(text), v = _mem.get(k);
    if (v) { _mem.delete(k); _mem.set(k, v); }        // LRU touch
    return v || null;
}
function memSize(bufs) {
    var list = (bufs && bufs.length !== undefined && !Array.isArray(bufs))
        ? [bufs] : (bufs || []);
    var n = 0;
    for (var i = 0; i < list.length; i++)
        n += (list[i] && list[i].length ? list[i].length * 4 : 0);
    return n;
}
function memPut(text, bufs) {
    var k = memKey(text), size = memSize(bufs);
    if (!size) return;
    if (_mem.has(k)) { _memBytes -= memSize(_mem.get(k)); _mem.delete(k); }
    _mem.set(k, bufs);
    _memBytes += size;
    while (_memBytes > MEM_CAP && _mem.size > 1) {
        var oldest = _mem.keys().next().value;
        _memBytes -= memSize(_mem.get(oldest));
        _mem.delete(oldest);
    }
}

/* the ONE chunk list of a bubble: identical for a live read, a manual read and
   the rebuild after a reload. Sentence mode runs the markdown sanitizer (whose
   streaming twin is byte-identical, pinned in voice10/VOICE-11a); line and
   paragraph modes stay RAW, because there the newline IS the boundary. */
/* The vanilla door refuses input over 4096 characters (OpenAI's own limit,
   which macos-say keeps). Uplift's door stitches longer text, but a plan is
   built once and a route flip mid-read must never hand the vanilla door a
   chunk it will reject, so the ceiling applies to both doors — one rule is
   cheaper than a route-dependent plan, and a 4096-char sentence is not a
   thing anyone wants read aloud in one breath anyway. */
function capChunks(list, max) {
    var LIMIT = 4096;                       // the vanilla door's input cap
    var cap = (typeof max === 'number' && max > 0) ? max : LIMIT;
    var out = [], i, c;
    for (i = 0; i < list.length; i++) {
        c = String(list[i] || '');
        while (c.length > cap) {
            var cut = c.lastIndexOf(' ', cap);
            if (cut < cap * 0.5) cut = cap;       // no word break: hard slice
            out.push(c.slice(0, cut));
            c = c.slice(cut).replace(/^\s+/, '');
        }
        if (c.trim()) out.push(c);
    }
    return out;
}
function planChunks(text, mode) {
    var S = SIO();
    if (!S) return [];
    var src = String(text || '');
    if (!src.trim()) return [];
    return capChunks(mode === 'sentence'
        ? S.splitSpeechChunks(src, 'sentence')
        : S.splitSpeechChunks(src, mode, undefined, { sanitize: false }));
}

function planOf(msg) {
    return (msg && msg.mid && _plans[msg.mid]) ? _plans[msg.mid] : null;
}

function makePlan(msg, text, mode, rev, voice) {
    var chunks = planChunks(text, mode);
    var p = { mid: ensureMid(msg), conv: (CORE._conv || {}).id || '', mode: mode,
              voice: voice || chatVoiceId(), rev: rev || ('r' + r6()),
              text: String(text || ''), chunks: chunks, rows: [],
              planEl: null, seqs: {} };
    p.owner = (CORE._conv && CORE._conv.temporary) ? null   // UP-65: no disk cache
        : { conv: p.conv, msg: p.mid, rev: p.rev };
    if (p.mid) _plans[p.mid] = p;
    if (msg) msg.speech = { mode: mode, n: chunks.length, rev: p.rev,
                            voice: p.voice, sum: sayDigest(text) };
    return p;
}
function sayDigest(s) {
    // djb2 over the text, just long enough to be a fingerprint: it answers ONE
    // question — has this bubble's text changed since its chunks were cut?
    var str = String(s || ''), h = 5381 >>> 0, g = 52711 >>> 0;
    for (var i = 0; i < str.length; i++) {
        h = (((h << 5) + h) >>> 0) ^ str.charCodeAt(i);
        g = (((g * 33) >>> 0) + str.charCodeAt(i)) >>> 0;
    }
    return 's' + (h >>> 0).toString(36) + (g >>> 0).toString(36);
}

/* The plan a bubble reads from. `rev` is only replaced when the plan itself
   changes (the text was edited, the mode or the voice moved), because the rev
   is what keeps the bubble's stored audio reachable — and dropping it is what
   frees those files again (routers/chat.py prunes by rev on every save). */
function planFor(msg) {
    var text = String((msg && msg.content) || '');
    if (!text.trim() || !SIO() || !hasVoices()) return null;
    var p = msg.mid ? _plans[msg.mid] : null;
    if (p && p.text === text) return p;
    // THE RULE (user, 2026-10-18): the chunk strategy is decided when a bubble
    // is born. Changing the setting affects NEW bubbles only — an existing one
    // keeps the lines it was cut into (and the audio recorded for them) until
    // its text is regenerated or edited, which is also the only case where its
    // revision moves and the old files are released.
    var s = (msg && msg.speech) || {};
    if (s.mode && s.sum === sayDigest(text) && s.rev) {
        return makePlan(msg, text, s.mode, s.rev, s.voice);
    }
    return makePlan(msg, text, speakChunkMode(), '', null);
}

// ---- byte source: memory cache, then the bubble-owned disk cache -------------
function chunkSource(owner, text) {
    return function () {
        var hit = memGet(text);
        if (hit) return hit;
        // Same source contract at both doors: a promise for an audio Response.
        // The vanilla endpoint has no cache field, so the in-page buffer cache
        // is what keeps a replay free of a second request.
        if (speakRoute() === 'vanilla') {
            var spec = vanillaSpeechCall(chatVoiceId(), text);
            return vanillaSpeechFetch(spec.url, spec.body)
                .then(function (r) { return rememberAudio(text, r); });
        }
        var V = VOI();
        if (!V || !V.speechJson) return Promise.reject(new Error('no voices module'));
        return Promise.resolve(V.speechJson('/voices/speech',
            { voice: chatVoiceId(), input: text, cache: owner }))
            .then(function (r) { return rememberAudio(text, r); });
    };
}
function rememberAudio(text, r) {
    // Cache what we can hold on to: decoded buffers replay with no request at
    // all. Anything this browser/environment will not hand us stays uncached
    // for this session — the server-side cache still answers it.
    if (!r || typeof r.arrayBuffer !== 'function') return r;
    var ctx = speakCtx();
    if (!ctx || typeof ctx.decodeAudioData !== 'function') return r;
    return r.arrayBuffer().then(function (ab) {
        return new Promise(function (res) {
            var done = false;
            function give(bufs) {
                if (done) return;
                done = true;
                var list = Array.isArray(bufs) ? bufs : [bufs];
                if (list.length && list[0]) memPut(text, list);
                res(list.length === 1 ? list[0] : list);
            }
            try {
                var p = ctx.decodeAudioData(ab, function (b) { give(b); },
                                            function () { give(null); });
                if (p && typeof p.then === 'function')
                    p.then(give, function () { give(null); });
            } catch (e) { give(null); }
        });
    });
}

// ---- the rows ---------------------------------------------------------------
function sayRow(plan, seq) {
    var row = el('div', 'chat-native-say-row');
    row.dataset.seq = String(seq);
    var pp = el('button', 'chat-native-say-pp'); pp.type = 'button';
    pp.textContent = '\u25b6';                       // ▶
    var n = el('span', 'chat-native-say-n', String(seq + 1));
    var wave = el('div', 'chat-native-say-wave');
    var cv = document.createElement('canvas');
    cv.className = 'chat-native-say-cv';
    var bar = el('div', 'chat-native-say-bar');
    bar.hidden = true;
    var fill = el('i');
    bar.appendChild(fill);
    wave.append(cv, bar);
    var re = el('button', 'chat-native-say-re'); re.type = 'button';
    re.textContent = '\u27f3';                       // ⟳
    re.title = tf2('uplift.chat.say_redo', 'Synthesize this line again');
    re.dataset.i18nTitle = 'uplift.chat.say_redo';
    re.dataset.enTitle = re.title;
    pp.title = tf2('uplift.chat.say_play', 'Play this line');
    pp.dataset.i18nTitle = 'uplift.chat.say_play';
    pp.dataset.enTitle = pp.title;
    row.append(pp, n, wave, re);
    row._n = n;
    row._pp = pp; row._cv = cv; row._fill = fill; row._bar = bar; row._re = re;
    pp.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sayToggle(plan, seq);
    });
    re.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sayReload(plan, seq);
    });
    row.addEventListener('mouseenter', function () { sayHover(plan, seq, true); });
    row.addEventListener('mouseleave', function () { sayHover(plan, seq, false); });
    plan.rows[seq] = row;
    return row;
}

/* paint one row from what the queue knows about that chunk.
   VOICE-17: a row reports on ITS OWN bubble's queue. This used to read the
   shared _speakQ (the single-queue days of VOICE-11), so playing one reply
   made the rows of every other reply paint 'loading'/'playing' — bubbles
   appeared to be generating audio that nobody asked for. */
function sayPaint(plan, seq) {
    var row = plan.rows[seq];
    if (!row) return;
    var q = plan.q, it = q && q.itemAt ? q.itemAt(seq) : null;
    var state = 'idle';
    if (it) state = it.state || 'idle';
    if (plan.playSeq === seq && (state === 'playing' || plan.paused)) state =
        plan.paused ? 'paused' : 'playing';
    row.className = 'chat-native-say-row ' + state +
        (plan.hot === seq ? ' hot' : '');
    row._pp.textContent = (state === 'playing') ? '\u23f8' : '\u25b6';  // ⏸ / ▶
    var dur = (it && it.duration) || 0;
    sayWave(row._cv, it && it.buffers, dur ? 0 : 0, state);
    if (state === 'playing' || state === 'paused') {
        var pos = q.position();
        var frac = pos.seq === seq && pos.duration
            ? pos.offset / pos.duration : (state === 'paused' ? -1 : 0);
        row._bar.hidden = false;
        row._fill.style.width = (frac >= 0 ? Math.round(frac * 100) : 
            Math.round((plan.pauseFrac || 0) * 100)) + '%';
    } else {
        row._bar.hidden = !(state === '' || state === 'loading');
        row._fill.style.width = state === 'played' ? '100%' : '0%';
    }
}
function sayPaintAll(plan) {
    if (!plan) return;
    for (var i = 0; i < plan.rows.length; i++) sayPaint(plan, i);
}
function sayStructure(plan, bubble) {
    if (!plan) return;
    var g = plan.planEl;
    if (g && g.appendChild) {
        while (plan.rows.length < plan.chunks.length)
            g.appendChild(sayRow(plan, plan.rows.length));
        // (the whole-reply pair is not part of this stack — it rides the
        // message action line, right-aligned, and appears with it)
    }
    sayAnnotate(plan, bubble);
    sayPaintAll(plan);
}

/* waveform: peaks straight off the decoded buffer — no server work, no extra
   request. Nothing to draw until the bytes exist (a plain bar covers that). */
function sayWave(cv, bufs, _unused, state) {
    if (!cv || !cv.getContext) return;
    var list = !bufs ? [] : (Array.isArray(bufs) ? bufs : [bufs]);
    var w = cv.clientWidth || 140, h = cv.clientHeight || 16;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    var g = cv.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    if (!list.length) return;
    var peaks = [], n = SAY_SEGS, i, k;
    for (i = 0; i < n; i++) peaks.push(0);
    var span = 0, off = [];
    for (i = 0; i < list.length; i++) {
        var ch = null;
        try { ch = list[i].getChannelData ? list[i].getChannelData(0) : null; }
        catch (e) { ch = null; }
        off.push(span);
        span += ch ? ch.length : 0;
    }
    if (!span) return;
    var idx = 0, acc = 0, seen = 0;
    for (var s = 0; s < n; s++) {
        var from = Math.floor(span * s / n), to = Math.max(from + 1, Math.floor(span * (s + 1) / n));
        while (idx < list.length - 1) {
            var c2 = list[idx];
            var len = (c2 && c2.length) || 0;
            if (from < off[idx] + len) break;
            idx++;
        }
        var peak = 0;
        for (var j = from; j < to; j += Math.max(1, Math.floor((to - from) / 64))) {
            var l2 = 0, cc = idx;
            while (cc < list.length) {
                var base = off[cc], arr = null;
                try { arr = list[cc].getChannelData ? list[cc].getChannelData(0) : null; }
                catch (e) { arr = null; }
                var ln = arr ? arr.length : 0;
                if (j - base < ln) { peak = Math.max(peak, Math.abs(arr[j - base] || 0)); break; }
                cc++;
            }
            if (peak > 0.98) break;
        }
        peaks[s] = peak;
        seen += peak;
    }
    var scale = seen ? Math.min(1, (n * 0.55) / (seen / n) * 0.55) : 1;
    var bw = Math.max(1, Math.floor(w / n) - 1);
    var css = getComputedStyle(cv);
    g.fillStyle = (state === 'failed') ? '#e05d5d'
        : (css.getPropertyValue('--dim') || '#8b98ab') ;
    for (i = 0; i < n; i++) {
        var amp = Math.max(0.06, Math.min(1, peaks[i] * scale * 2));
        var bh = Math.max(1, Math.round(amp * (h - 2)));
        g.fillRect(Math.round(i * w / n), Math.round((h - bh) / 2), bw, bh);
    }
}

// ---- play / pause / replay / re-synthesize ----------------------------------
// ---- play / pause / replay / re-synthesize ----------------------------------
/* ONE queue instance per plan: the queue owns its chunk list, so a fresh
   instance per bubble is what keeps plan index == queue sequence, and the
   previous read is cut by speakCancel() before the swap (VOICE-11 rule: one
   read-aloud at a time, a new one always wins). */
function queueFor(plan) {
    if (plan.q) return plan.q;
    var sio = SIO(), V = VOI();
    if (!sio || !V || !V.speechJson) return null;
    var ctx = speakCtx();
    if (!ctx) return null;
    plan.q = sio.SpeechQueue({
        ctx: ctx,
        onItem: function (it, st) { sayItemEvent(plan, it, st); },
        // the queue's own leg stays wired for a chunk with no cached source
        request: speakRequestFor,
        fetchLike: speakTransport,
    });
    plan.dropMark = plan.q.dropped().length;
    plan.playMark = plan.q.played();
    return plan.q;
}
function sayItemEvent(plan, it, st) {
    // NOTE: the engine marks a chunk 'playing' when it is SCHEDULED, which for
    // a gapless read happens while the PREVIOUS chunk is still sounding. The
    // highlight must therefore follow position(), never this event — otherwise
    // the first thing that lights is the second line.
    sayPaint(plan, it.seq);
    if (st === 'playing') sayWatch(plan);
    sayInlinePaint(plan);
}
function sayFeed(plan, q) {
    // The live turn already handed its chunks to this queue one by one; feeding
    // them a second time gave the queue TWO copies of the reply, which is why
    // play-all read everything twice (and why the second pass had no row to
    // light: rows are numbered by the plan, the queue was not). Count what the
    // queue owns and push only what is missing.
    var have = q.__pushed || 0;
    for (var i = have; i < plan.chunks.length; i++) {
        if (q.push({ text: plan.chunks[i],
                     source: chunkSource(plan.owner, plan.chunks[i]) }) >= 0) {
            q.__pushed = (q.__pushed || 0) + 1;
        }
    }
    if (!q.__pushed) q.__pushed = have;
    return q;
}
function sayToastNoAudio() {
    var d = D();
    if (d) d.toast(t('uplift.chat.speak_failed',
        'No audio could be played for this reply.'), 'error');
}
function sayTake(q, plan) {
    if (_speakQ && _speakQ !== q) speakCancel();
    _speakQ = q;
    q.__plan = plan;
    return q;
}
function sayStart(plan, seq, solo) {
    if (!plan || !plan.chunks.length) return null;
    var q = queueFor(plan);
    if (!q) { sayToastNoAudio(); return null; }
    sayTake(q, plan);
    // VOICE-17 (user: 'a fragment play should only generate the fragment'):
    // declare the byte window BEFORE the chunk list is fed, so pushing the
    // other lines costs nothing. One line = one synthesis; the whole read =
    // everything from here on.
    if (q.loadWindow) q.loadWindow(seq, solo ? seq : -1);
    sayFeed(plan, q);
    plan.playSeq = seq;
    plan.paused = false;
    speakEvent(true);                       // VOICE-13: the mic stops listening
    q.seek(seq, 0, solo ? { solo: true } : null);
    sayWatch(plan);
    return q;
}
function sayToggle(plan, seq) {
    var q = plan ? plan.q : null;
    if (q && !q.paused()) {
        var pos = q.position();
        if (pos.seq === seq && pos.state === 'playing' && q.pause()) {
            plan.paused = true;
            sayPaint(plan, seq);
            sayInlinePaint(plan);
            return;
        }
    }
    if (q && q.paused() && plan.playSeq === seq) {
        q.resume();
        plan.paused = false;
        sayWatch(plan);
        sayPaint(plan, seq);
        return;
    }
    sayStart(plan, seq, true);              // this line, from its top
}
function sayReload(plan, seq) {
    if (!plan || !plan.chunks.length) return;
    var q = queueFor(plan);
    if (!q) { sayToastNoAudio(); return; }
    sayTake(q, plan);
    // VOICE-17: ⟳ on one line re-records THAT line — the rest of the bubble
    // stays untouched (and unsynthesized) even though the queue owns its whole
    // chunk list for the row numbering.
    if (q.loadWindow) q.loadWindow(seq, seq);
    sayFeed(plan, q);
    plan.playSeq = seq;
    speakEvent(true);
    // ⟳ on a row means: THIS line again, freshly recorded — not the rest
    q.reload(seq, chunkSource(plan.owner, plan.chunks[seq]),
             { play: true, solo: true });
    sayWatch(plan);
}

/* one rAF loop, for the plan that holds the queue: it moves the bars and
   follows the playhead; the row STATES come from onItem instead */
function sayWatch(plan) {
    _sayPlan = plan;
    if (_sayLoop) return;
    var raf = (W() && W().requestAnimationFrame)
        ? function (f) { return W().requestAnimationFrame(f); }
        : function (f) { return setTimeout(f, 16); };
    var tick = function () {
        var p = _sayPlan, q = p && p.q;
        _sayLoop = null;
        if (!p || !q) return;
        var pos = q.position();
        sayPaintAll(p);
        sayInlinePaint(p);
        if (pos.seq !== p.marked) { p.marked = pos.seq; sayHighlight(p, pos.seq); }
        if (pos.state === 'playing' || q.paused()) {
            _sayLoop = raf(tick);
        } else if (pos.state !== 'loading' && p.playSeq >= 0 && q.pending() > 0) {
            _sayLoop = raf(tick);           // bytes still arriving
        } else {
            p.playSeq = -1;
            sayHighlight(p, -1);
            sayPaintAll(p);
            sayInlinePaint(p);
        }
    };
    if (!_sayLoop) _sayLoop = raf(tick);
}

/* a read-aloud is over: the mic may hear again and a manual read toasts once
   (the live turn keeps its own settle path in endSpeakTurn) */
function saySettle(plan, res) {
    if (_speakBtn) { _speakBtn.classList.remove('playing'); _speakBtn = null; }
    speakEvent(false);
    if (plan && plan !== _livePlan && res && !res.stopped)
        speakToast(res, plan.chunks.length, plan.dropMark || 0,
                   plan.playMark || 0);
}

// ---- the number links inside the bubble ------------------------------------
/* A chunk is located by its WORDS, not by offsets: the bubble is rendered
   markdown, so the syntax, the whitespace and the punctuation are gone on both
   sides and the word run is the only stable handle. Blocks are walked in order
   and the cursor only moves forward — which also makes a repeated call cheap.
   A chunk whose words cannot be found (the sanitizer deleted a construct it
   spans) is still NUMBERED, at the end of the bubble: a row must never be the
   only place a chunk exists, and an unlinked number is honest. */
function sayWords(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9\u00c0-\uffff]+/)
        .filter(function (w) { return w.length > 0; });
}
function sayBlocks(bubble) {
    if (!bubble || !bubble.querySelectorAll) return [];
    var found = [];
    try {
        found = Array.prototype.slice.call(
            bubble.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th'));
    } catch (e) { found = []; }
    return found.length ? found : [bubble];
}
function sayBlockText(block) {
    var out = '';
    var kids = (block && block.childNodes) || [];
    for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (!k) continue;
        if (k.nodeType === 3) out += k.nodeValue || '';
        else if (k.nodeType === 1 &&
                 String(k.className || '').indexOf('chat-native-say-ref') < 0)
            out += k.textContent || '';
    }
    return out;
}
/* the words of one block WITH their positions: text node + offset in it, so a
   number can be put after the exact word its chunk ended on, and the chunk's
   own span can be wrapped and lit. Text we inserted ourselves is skipped, so a
   repeated pass sees the same words it saw the first time. */
function sayCollect(block, nodes) {
    var kids = (block && block.childNodes) || [];
    for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (!k) continue;
        if (k.nodeType === 3) {
            var par = String((k.parentNode && k.parentNode.className) || '');
            if (par.indexOf('chat-native-say-seg') >= 0) continue;
            nodes.push(k);
        } else if (k.nodeType === 1) {
            var cls = String(k.className || '');
            if (cls.indexOf('chat-native-say-ref') >= 0) continue;
            if (k.tagName === 'SCRIPT' || k.tagName === 'STYLE') continue;
            sayCollect(k, nodes);              // inline markup rides along
        }
    }
    return nodes;
}
function sayBlockWords(block, b) {
    var toks = [], nodes = [];
    sayCollect(block, nodes);
    for (var n = 0; n < nodes.length; n++) {
        var s = String(nodes[n].nodeValue || '');
        var re = /[a-z0-9\u00c0-\uffff]+/g, m;
        while ((m = re.exec(s.toLowerCase()))) {
            toks.push({ b: b, node: nodes[n], off: m.index, w: m[0],
                        len: m[0].length });
        }
    }
    return { toks: toks, nodes: nodes.length };
}
function sayMatch(plan, bubble) {
    var blocks = sayBlocks(bubble), stream = [], i, j, spans = [];
    for (i = 0; i < blocks.length; i++) {
        var bw = sayBlockWords(blocks[i], i);
        spans.push(bw.nodes);
        for (j = 0; j < bw.toks.length; j++) stream.push(bw.toks[j]);
    }
    var marks = [], cursor = 0;
    for (i = 0; i < plan.chunks.length; i++) {
        var words = sayWords(plan.chunks[i]);
        var best = { end: -1, len: 0 };
        for (var at = cursor; at < Math.min(stream.length, cursor + 24); at++) {
            var run = 0;
            while (run < words.length && at + run < stream.length &&
                   stream[at + run].w === words[run]) run++;
            if (run > best.len) best = { start: at, end: at + run - 1, len: run };
            if (run === words.length) break;
        }
        if (!words.length || best.len < Math.min(2, words.length)) {
            marks.push({ seq: i, b: blocks.length - 1, linked: false });
            continue;
        }
        cursor = best.end + 1;
        marks.push({ seq: i, b: stream[best.end].b, linked: true,
                     toks: stream.slice(best.start, best.end + 1) });
    }
    return { marks: marks, blocks: blocks, nodesPerBlock: spans };
}
/* strip our own marks before re-measuring, so a repeated pass sees the words
   it saw the first time (numbers never stack, spans never nest) */
/* splitText leaves empty text nodes behind; between two spans they are pure
   clutter (and every later sibling count trips over them) */
function saySweep(bubble) {
    if (!bubble) return;
    var hosts = [bubble].concat(Array.prototype.slice.call(
        bubble.querySelectorAll ? bubble.querySelectorAll('*') : []));
    for (var hi = 0; hi < hosts.length; hi++) {
        var kids = (hosts[hi].childNodes || []);
        for (var ki = kids.length - 1; ki >= 0; ki--) {
            var kn = kids[ki];
            if (kn && kn.nodeType === 3 && !(kn.nodeValue || '').length)
                hosts[hi].removeChild(kn);
        }
    }
}
function sayClean(bubble) {
    if (!bubble || !bubble.querySelectorAll) return;
    saySweep(bubble);
    var i, j, list;
    list = Array.prototype.slice.call(bubble.querySelectorAll('.chat-native-say-ref'));
    for (i = 0; i < list.length; i++) { if (list[i].remove) list[i].remove(); }
    list = Array.prototype.slice.call(bubble.querySelectorAll('.chat-native-say-seg'));
    for (i = 0; i < list.length; i++) {
        var seg = list[i], par = seg.parentNode;
        if (!par || !seg.childNodes) continue;
        while (seg.firstChild) par.insertBefore(seg.firstChild, seg);
        par.removeChild(seg);
    }
}
function saySeg(plan, seq) {
    var seg = el('span', 'chat-native-say-seg');
    seg.dataset.seq = String(seq);
    seg.addEventListener('mouseenter', function () { sayHover(plan, seq, true); });
    seg.addEventListener('mouseleave', function () { sayHover(plan, seq, false); });
    seg.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sayToggle(plan, seq);
    });
    return seg;
}
function sayRefEl(plan, seq) {
    var ref = el('sup', 'chat-native-say-ref', String(seq + 1));
    ref.dataset.seq = String(seq);
    ref.title = tf2('uplift.chat.say_line', 'Line {n} of the spoken reply')
        .replace('{n}', String(seq + 1));
    ref.addEventListener('mouseenter', function () { sayHover(plan, seq, true); });
    ref.addEventListener('mouseleave', function () { sayHover(plan, seq, false); });
    ref.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sayToggle(plan, seq);
    });
    return ref;
}
/* wrap the words of ONE chunk: each touched text node is split at the word
   boundaries and the covered part goes into a span. A chunk that runs across
   inline markup lights every piece it actually reads. */
function sayWrap(plan, mark) {
    var toks = mark.toks || [], out = [], i;
    if (!toks.length) return out;
    var runs = [];
    for (i = 0; i < toks.length; i++) {
        var t = toks[i], node = t.node;
        if (!node || !node.parentNode || typeof node.splitText !== 'function') continue;
        var last = runs[runs.length - 1];
        if (last && last.node === node) { last.to = t.off + t.len; continue; }
        runs.push({ par: node.parentNode, node: node,
                    from: t.off, to: t.off + t.len });
    }
    if (runs.length) {
        var lr = runs[runs.length - 1];
        var txt = lr.node.nodeValue || '';
        // '...sentence.' — the mark that ends the chunk ends with it
        while (lr.to < txt.length && !/\s/.test(txt.charAt(lr.to))) lr.to++;
        var fr = runs[0];
        var ftxt = fr.node.nodeValue || '';
        // and the gap in front of it belongs to the chunk too, so two spans
        // never sit next to each other with a loose space between them
        while (fr.from > 0 && /\s/.test(ftxt.charAt(fr.from - 1))) fr.from--;
    }
    for (var i = runs.length - 1; i >= 0; i--) {
        var r = runs[i];
        if (r.node.parentNode !== r.par) continue;         // already moved
        var from = Math.max(0, Math.min(r.from, (r.node.nodeValue || '').length));
        var coveredLen = Math.max(0, Math.min(r.to, (r.node.nodeValue || '').length) - from);
        if (!coveredLen) continue;
        var before = from ? r.node.splitText(from) : r.node;
        var after = before.splitText ? before.splitText(coveredLen) : null;
        if (before === r.node && r.node.parentNode === r.par) {
            // nothing was left in front: the whole node is covered
        }
        var seg = saySeg(plan, mark.seq);
        r.par.insertBefore(seg, after || null);
        seg.appendChild(before);
        out.push(seg);
    }
    return out;
}
function sayAnnotate(plan, bubbleEl) {
    var bubble = bubbleEl || plan.bubble;
    if (!bubble || !bubble.appendChild) return;
    plan.bubble = bubble;
    sayClean(bubble);
    sayFitGrid(plan, bubble);
    var m = sayMatch(plan, bubble);
    plan._match = m;
    plan.refs = {};
    plan.segs = {};
    // LAST chunk first: splitting a text node for an earlier chunk would move
    // the words of a later one out from under the offsets we already measured
    for (var i = m.marks.length - 1; i >= 0; i--) {
        var mark = m.marks[i];
        var segs = mark.linked ? sayWrap(plan, mark) : [];
        var ref = sayRefEl(plan, mark.seq);
        var host = segs.length ? segs[0].parentNode : null;
        if (host) host.insertBefore(ref, segs[0].nextSibling);
        else (m.blocks[mark.b] || bubble).appendChild(ref);
        plan.refs[mark.seq] = ref;
        plan.segs[mark.seq] = segs;
    }
    saySweep(bubble);
    sayHighlight(plan, plan.marked != null ? plan.marked : -1);
}
function sayHover(plan, seq, on) {
    if (!plan) return;
    plan.hot = on ? seq : -1;
    sayPaint(plan, seq);                                  // row carries .hot
    sayHighlight(plan, on ? seq
                          : (plan.marked != null ? plan.marked : -1));
}
/* one class on both sides of the pair: the row and the words it reads — now the
   EXACT span of that chunk, not the whole block it sits in */
function sayHighlight(plan, seq) {
    if (!plan || !plan.bubble || !plan.bubble.querySelectorAll) return;
    var segs = plan.bubble.querySelectorAll('.chat-native-say-seg');
    for (var i = 0; i < segs.length; i++) {
        segs[i].className = 'chat-native-say-seg' +
            (String(segs[i].dataset.seq) === String(seq) ? ' chat-native-say-here' : '');
    }
    var refs = plan.bubble.querySelectorAll('.chat-native-say-ref');
    for (var r = 0; r < refs.length; r++) {
        refs[r].className = 'chat-native-say-ref' +
            (String(refs[r].dataset.seq) === String(seq) ? ' hot' : '');
    }
}

// ---- the two track shapes --------------------------------------------------
/* Ad-hoc (AUTO-SPEAK off): ONE transport row on the action line, right
   aligned — play/pause left, progress middle, ⟳ right.
   AUTO-SPEAK on: one row per chunk under the bubble, always visible, each with
   its own number, bar and ⟳. */
function sayTrackEl(idx) {
    var box = el('div', 'chat-native-say-all');
    box.dataset.idx = String(idx);
    var pp = el('button', 'chat-native-say-pp'); pp.type = 'button';
    pp.textContent = '\u25b6';
    pp.title = tf2('uplift.chat.say_read', 'Read the whole reply aloud');
    pp.dataset.i18nTitle = 'uplift.chat.say_read';
    pp.dataset.enTitle = pp.title;
    var bar = el('div', 'chat-native-say-bar');
    var fill = el('i');
    bar.appendChild(fill);
    bar.hidden = true;
    var re = el('button', 'chat-native-say-re'); re.type = 'button';
    re.textContent = '\u27f3';
    re.title = tf2('uplift.chat.say_reread', 'Record the whole reply again');
    re.dataset.i18nTitle = 'uplift.chat.say_reread';
    re.dataset.enTitle = re.title;
    box.append(pp, bar, re);
    box._pp = pp; box._fill = fill; box._bar = bar; box._re = re;
    box._idx = idx;
    pp.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sayInlineToggle(box);
    });
    re.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sayRerecord(box);
    });
    return box;
}
function sayAdoptTrack(plan, holder, idx) {
    // the action line may be built before or after the plan exists; either way
    // the plan ends up holding the one pair that belongs to its bubble
    if (!plan || plan.box) return;
    var a = holder && holder.querySelector
        ? holder.querySelector('.chat-native-say-all') : null;
    // the action line is rebuilt whenever the message is re-attached, so an
    // adopted pair that is no longer in the document must be replaced — else
    // progress paints into a detached node and the control looks dead
    if (a && (!plan.box || plan.box.isConnected === false)) plan.box = a;
}
function sayPlanOfBox(box) {
    var msg = messageAt(box._idx);
    if (!msg || !String(msg.content || '').trim()) return null;
    return planOf(msg) || planFor(msg);
}
function sayInlinePaint(plan) {
    var box = plan && plan.box;
    if (!box || !box._fill) return;
    var q = plan.q;
    // the line count rides the tooltip: it says what this control covers
    box.title = tf2('uplift.chat.say_lines', '{n} lines')
        .replace('{n}', String(plan.chunks.length));
    if (!q) { box._bar.hidden = true; return; }
    var pos = q.position();
    var done = 0, i;
    for (i = 0; i < plan.chunks.length; i++)
        if (q.itemAt(i) && q.itemAt(i).state === 'played') done++;
    var frac = plan.chunks.length
        ? (done + (pos.seq >= 0 && pos.duration ? pos.offset / pos.duration : 0))
          / plan.chunks.length : 0;
    box._bar.hidden = false;
    box._fill.style.width = Math.round(Math.min(1, frac) * 100) + '%';
    box._pp.textContent = pos.state === 'playing' ? '\u23f8' : '\u25b6';
}
function sayInlineToggle(box) {
    var plan = sayPlanOfBox(box);
    if (!plan) return;
    plan.box = box;
    var q = plan.q;
    if (q && !q.paused() && q.position().state === 'playing' && q.pause()) {
        plan.paused = true;
        box._pp.textContent = '\u25b6';
        return;
    }
    if (q && q.paused() && q.resume()) {
        plan.paused = false;
        box._pp.textContent = '\u23f8';
        sayWatch(plan);
        return;
    }
    sayPlayAll(plan, box);
}
function sayPlayAll(plan, box) {
    if (box) plan.box = box;
    var q = sayStart(plan, 0, false);
    if (!q) return;
    if (plan.box) plan.box._pp.textContent = '\u23f8';
    q.drain().then(function (res) {
        if (plan.box) plan.box._pp.textContent = '\u25b6';
        saySettle(plan, res);
    });
}
function sayRerecord(box) {
    var msg = messageAt(box._idx);
    if (!msg || !String(msg.content || '').trim()) return;
    unlockSpeak();
    // a fresh rev on the same bubble: the chat save releases the old take
    var fresh = makePlan(msg, String(msg.content || ''), speakChunkMode(), '');
    sayPlayAll(fresh, box);
}

function sayGridEl(plan, idx) {
    var g = el('div', 'chat-native-say-grid');
    g.dataset.idx = String(idx);
    g.__plan = plan;
    plan.planEl = g;
    for (var i = 0; i < plan.chunks.length; i++) g.appendChild(sayRow(plan, i));
    return g;
}
function sayFindGrid(holder) {
    var kids = (holder && holder.children) || [];
    for (var i = 0; i < kids.length; i++)
        if (kids[i] && String(kids[i].className || '').indexOf('chat-native-say-grid') >= 0)
            return kids[i];
    return null;
}
function sayGrid(holder, plan, idx, bubble) {
    var grid = sayFindGrid(holder);
    if (!grid || grid.__plan !== plan) {
        if (grid) grid.remove();
        grid = sayGridEl(plan, idx);
        holder.appendChild(grid);
    }
    plan.bubble = bubble;
    sayAdoptTrack(plan, holder, idx);
    sayStructure(plan, bubble);
    return grid;
}
function sayFitGrid(plan, bubble) {
    // measured, not guessed: the stack stops at the bubble's own right edge
    var g = plan.planEl, rect = bubble && bubble.getBoundingClientRect
        ? bubble.getBoundingClientRect() : null;
    if (!g || !g.style) return;
    if (rect && isFinite(rect.width) && rect.width > 40) {
        g.style.maxWidth = Math.round(rect.width) + 'px';
    }
}
/* per-bubble refresh (idempotent: attach runs on every render tick) */
function sayDetach(holder, bubble, msg) {
    // VOICE-17: with AUTO-SPEAK off a bubble keeps NOTHING of the player but
    // its one whole-reply play row on the action line. Drop the chunk stack and
    // the numbers inside the text, and forget the DOM the plan was painting, so
    // a later toggle rebuilds both from scratch.
    var grid = sayFindGrid(holder);
    if (grid) grid.remove();
    var p = msg && planOf(msg);
    if (p) { p.planEl = null; p.rows = []; p.seqs = {}; p.bubble = null; }
    sayClean(bubble);
}
function sayAttach(holder, idx, role, bubble) {
    var msg = role === 'assistant' ? messageAt(idx) : null;
    var grid = sayFindGrid(holder);
    if (!msg || !hasVoices() || !SIO()) {
        if (grid) grid.remove();
        return;
    }
    if (!autoSpeakOn()) { sayDetach(holder, bubble, msg); return; }
    // planned on sight: the chunk lines come from the text, so they exist
    // before a single byte of audio does
    var plan = planOf(msg) || planFor(msg);
    // an empty stack is worse than none: a turn that produced no chunk (or a
    // plan that sanitized to nothing) must not leave a visible empty shelf
    // Every assistant bubble shows its lines from the start: the chunks are
    // known from the text and the bubble's own strategy, so a row exists before
    // anything was synthesized — empty waveform, waiting to be played.
    if (!plan || !plan.chunks.length) {
        if (grid) grid.remove();
        if (plan) { plan.planEl = null; }
        return;
    }
    sayGrid(holder, plan, idx, bubble);
}

return {
    AUTO_KEY: AUTO_KEY,
    CHUNK_KEY: CHUNK_KEY,
    ROUTE_KEY: ROUTE_KEY,
    get _speakQ() { return _speakQ; }, set _speakQ(v) { _speakQ = v; },
    get _speakGen() { return _speakGen; },
    get _speakZ() { return _speakZ; },
    lsGet: lsGet,
    lsSet: lsSet,
    autoSpeakOn: autoSpeakOn,
    speakChunkMode: speakChunkMode,
    speakRoute: speakRoute,
    unlockSpeak: unlockSpeak,
    beginSpeakTurn: beginSpeakTurn,
    speakFeed: speakFeed,
    endSpeakTurn: endSpeakTurn,
    speakCancel: speakCancel,
    speakBusy: speakBusy,
    speakEvent: speakEvent,
    hasVoices: hasVoices,
    chatVoiceId: chatVoiceId,
    refreshVoices: refreshVoices,
    msgSpeak: msgSpeak,
    _plans: _plans,
    get _livePlan() { return _livePlan; }, set _livePlan(v) { _livePlan = v; },
    get _turnMid() { return _turnMid; }, set _turnMid(v) { _turnMid = v; },
    newMid: newMid,
    sayRelease: sayRelease,
    saySilence: saySilence,
    saySweepPlans: saySweepPlans,
    sayTrackEl: sayTrackEl,
    sayGrid: sayGrid,
    sayAttach: sayAttach
};
});
