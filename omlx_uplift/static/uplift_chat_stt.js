/* SPLIT-3: chat voice input (VOICE-12, VOICE-13): the input-model setting
   and its popover, push-to-talk record and transcribe, and continuous
   listening over the realtime socket with its HTTP segment fallback.
   Part of the native chat: uplift_chat.js calls this factory once with a
   bridge (CORE) to its helpers and live state, and uses the returned
   functions. Code moved from uplift_chat.js without behaviour change. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory;
    else (root.UpliftChatParts = root.UpliftChatParts || {}).stt = factory;
})(typeof self !== 'undefined' ? self : this, function (CORE) {
'use strict';

// Chat-core helpers (plain functions, bound once). Live core state is read
// through CORE.<name> getters at call time, never copied.
var W = CORE.W, D = CORE.D, errText = CORE.errText, t = CORE.t,
    el = CORE.el, gid = CORE.gid, onPageEdited = CORE.onPageEdited,
    encodeWav = CORE.encodeWav, tf2 = CORE.tf2;

// ---- VOICE-12: voice INPUT as a setting (model/language/auto-send/mode) ----
// Decoupled from the chat model (policy ae5647c moved audio_stt rows OUT of
// the picker; this completes the move). localStorage carries the browser
// preference — same key style as omlx-uplift-voice / omlx-uplift-autospeak.
// 'None' input model = the whole surface stays SILENT (optional-surface
// doctrine: no mic button, no hints, zero noise when unset).
var STT_MODEL_KEY = 'omlx-uplift-stt-model';
var STT_LANG_KEY = 'omlx-uplift-stt-lang';        // '' = Auto (field omitted)
var STT_MODE_KEY = 'omlx-uplift-stt-mode';        // 'off'|'ptt'|'continuous'
var STT_LANGS = ['en', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'ru',
                 'ja', 'ko', 'zh'];   // OpenAI whisper language convention
var STT_TIMEOUT_MS = 240000;   // VOICE-3 watchdog doctrine (uplift_voices
                               // voiceSignal/240 s): the budget bounds a
                               // HANG, not a busy server; the interim
                               // button state must END HONESTLY on every
                               // outcome — a stuck 'transcribing…' is a
                               // protocol violation.

var _mic = null,       // 6/6b: live mic recording session
    _sttPop = null,    // VOICE-12: open voice-input popover
    _sttXfer = null;   // VOICE-12: live transcribe session

function sttModel() { return CORE.lsGet(STT_MODEL_KEY) || ''; }
function sttLang() { return CORE.lsGet(STT_LANG_KEY) || ''; }
// RETIRED CONTROL (user 2026-10-18): the point of the mic is hands-free —
// every spoken utterance goes straight to the chat model. The Auto-send
// row is gone from the Voice input popover; a stale localStorage key left
// by an old profile is deliberately ignored.
function sttAutoSend() { return true; }
function sttMode() {
    var m = CORE.lsGet(STT_MODE_KEY);
    return (m === 'off' || m === 'continuous') ? m : 'ptt';
}
function syncSttMic() {
    // VOICE-12 visibility gate: an input model is configured and the mode
    // is not Off. VOICE-13: 'continuous' is now the LISTENER, not PTT.
    var mic = gid('chat-native-mic');
    if (mic) mic.hidden = !(sttModel() && sttMode() !== 'off');
}

function sttSettingsBtn() {
    var btn = el('button', 'btn', tf2('uplift.chat.stt_settings', 'Input settings'));
    btn.type = 'button'; btn.id = 'chat-native-stt';
    btn.dataset.i18n = 'uplift.chat.stt_settings';           // U59 marker
    btn.dataset.en = btn.textContent;
    btn.addEventListener('click', function (ev) {
        // dropMenu dismiss contract: the opener stops propagation so the
        // deferred document-dismiss cannot eat the opening click
        ev.stopPropagation();
        if (_sttPop) { closeSttPop(); return; }   // the button toggles
        openSttPop(btn.parentElement || btn);
    });
    return btn;
}
function sttPopKey(ev) { if (ev.key === 'Escape') closeSttPop(); }
var _sttPopAnchor = null, _sttPopFrame = 0;
function sttPopEscape() { closeSttPop(); }   // resize: geometry assumptions
// die — closing is honest
function sttPopFollow() {
    // LIVE QA race: scroll events land a frame AFTER the wheel/programmatic
    // scroll, so a click that follows a scroll by milliseconds used to see
    // its freshly-opened pop closed by the late event. A fixed pop that
    // knows its anchor just REPOSITIONS (rAF-coalesced) — the pop stays
    // glued to the button instead of vanishing on the user's hands.
    if (!_sttPop || !_sttPopAnchor) return;
    if (typeof requestAnimationFrame === 'function') {
        if (_sttPopFrame) return;
        _sttPopFrame = requestAnimationFrame(function () {
            _sttPopFrame = 0;
            if (_sttPop) sttPopPlace(_sttPop, _sttPopAnchor);
        });
    } else sttPopPlace(_sttPop, _sttPopAnchor);
}
function closeSttPop() {
    if (!_sttPop) return;
    var p = _sttPop; _sttPop = null; _sttPopAnchor = null;
    p.remove();
    // own listeners, removed on close (helpPop pattern, uplift_bench)
    document.removeEventListener('click', closeSttPop);
    document.removeEventListener('keydown', sttPopKey);
    window.removeEventListener('scroll', sttPopFollow, true);
    window.removeEventListener('resize', sttPopEscape);
}
function sttPopPlace(pop, anchor) {
    // CHAT-3R bug (user: 'Voice input settings end up invisible behind
    // the chat box'): the pop is a child of the rail, and the rail is an
    // overflow:auto scroller — an ABSOLUTE pop gets clipped by it. fixed
    // positioning escapes the clip; the pop is placed by real rects and
    // FLIPS above the anchor when the viewport bottom is tight.
    var vw = window.innerWidth || 1200;
    var vh = window.innerHeight || 800;
    var pw = pop.offsetWidth || 250;
    var ph = pop.offsetHeight || 260;
    var ar = anchor && anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect() : null;
    var left = ar ? Math.min(Math.max(8, ar.right - pw), vw - pw - 8) : 8;
    var top = ar ? ar.bottom + 4 : 8;
    if (ar && top + ph > vh - 8) top = Math.max(8, ar.top - ph - 4);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
}
function openSttPop(host) {
    var pop = el('div', 'chat-native-pop'); pop.id = 'chat-native-stt-pop';
    function row(labelKey, labelFb, control, titleKey, titleFb) {
        var r = el('div', 'chat-native-pop-row');
        var lab = el('span', 'chat-native-group-label', tf2(labelKey, labelFb));
        lab.dataset.i18n = labelKey; lab.dataset.en = labelFb;
        if (titleKey) {
            lab.title = tf2(titleKey, titleFb);
            lab.dataset.i18nTitle = titleKey; lab.dataset.enTitle = lab.title;
        }
        r.append(lab, control);
        pop.appendChild(r);
        return r;
    }
    // row 1 — INPUT MODEL: the audio_stt rows collected at boot; 'None'
    // (value '') = feature fully silent.
    var ms = el('select'); ms.id = 'chat-native-stt-model';
    var oNone = el('option', null, tf2('uplift.chat.stt_none', 'None'));
    oNone.value = '';
    oNone.dataset.i18n = 'uplift.chat.stt_none'; oNone.dataset.en = 'None';
    ms.appendChild(oNone);
    CORE._sttModels.forEach(function (m) {
        var o = el('option', null, m.name || m.id);   // name-ish display, id value
        o.value = m.id;
        ms.appendChild(o);
    });
    ms.value = sttModel();
    ms.addEventListener('change', function () {
        CORE.lsSet(STT_MODEL_KEY, ms.value || '');
        sttListenerStop(false);   // VOICE-13: a live session on the OLD model
                                  // must release the engine's one realtime slot
        syncSttMic();
        onPageEdited();           // ROUND 11
    });
    row('uplift.chat.stt_input_model', 'Input model', ms);
    // row 2 — LANGUAGE: Auto = omit the form field entirely (VOICE-5
    // doctrine); the fixed code list is the whisper convention.
    var lsel = el('select'); lsel.id = 'chat-native-stt-lang';
    var oAuto = el('option', null, tf2('uplift.chat.stt_auto', 'Auto'));
    oAuto.value = '';
    oAuto.dataset.i18n = 'uplift.chat.stt_auto'; oAuto.dataset.en = 'Auto';
    lsel.appendChild(oAuto);
    STT_LANGS.forEach(function (code) {
        var o = el('option', null, code); o.value = code; lsel.appendChild(o);
    });
    lsel.value = sttLang();
    lsel.addEventListener('change', function () {
        CORE.lsSet(STT_LANG_KEY, lsel.value || '');
        onPageEdited();        // ROUND 11
    });
    row('uplift.chat.stt_language', 'Language', lsel,
        'uplift.chat.stt_lang_hint',
        'Auto detects the language per request; transcription quality '
        + 'varies by model family');
    // AUTO-SEND row REMOVED (user 2026-10-18): spoken = sent.
    // row 3 — MODE radios. VOICE-13: 'continuous' IS the live listener now
    // (realtime WS + segmented fallback); 'ptt' keeps its record-stop-send.
    var r4 = el('div', 'chat-native-pop-row modes');
    var lab4 = el('span', 'chat-native-group-label',
                  tf2('uplift.chat.stt_mode', 'Mode'));
    lab4.dataset.i18n = 'uplift.chat.stt_mode'; lab4.dataset.en = 'Mode';
    r4.appendChild(lab4);
    // VOICE-13: the headphones line is the CONTINUOUS row's hint (the card:
    // echo is what the listener cannot survive) — existing VOICE-12 key, no
    // new string, shown only where it applies.
    var hint = el('div', 'chat-native-pop-hint',
        tf2('uplift.chat.stt_headphone_hint',
            'Use headphones in continuous mode to avoid echo.'));
    hint.dataset.i18n = 'uplift.chat.stt_headphone_hint';
    hint.dataset.en = hint.textContent;
    [['off', 'uplift.chat.stt_mode_off', 'Off'],
     ['ptt', 'uplift.chat.stt_mode_ptt', 'Push to talk'],
     ['continuous', 'uplift.chat.stt_mode_cont', 'Continuous']
    ].forEach(function (mo) {
        var rb = el('input'); rb.type = 'radio';
        rb.name = 'chat-native-stt-mode'; rb.value = mo[0];
        rb.checked = sttMode() === mo[0];
        rb.addEventListener('change', function () {
            CORE.lsSet(STT_MODE_KEY, mo[0]);
            // mode change is a teardown point: a listener armed under the old
            // mode would keep the engine's one realtime slot open forever
            sttListenerStop(false);
            hint.hidden = mo[0] !== 'continuous';
            syncSttMic();        // Off hides the mic; the hint follows the mode
            onPageEdited();      // ROUND 11
        });
        var lb = el('span', null, tf2(mo[1], mo[2]));
        lb.dataset.i18n = mo[1]; lb.dataset.en = mo[2];
        r4.append(rb, lb);
    });
    pop.appendChild(r4);
    hint.hidden = sttMode() !== 'continuous';
    pop.appendChild(hint);
    pop.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();   // in-panel stays open
    });
    host.appendChild(pop);
    _sttPop = pop;
    _sttPopAnchor = host;
    sttPopPlace(pop, host);   // fixed placement (rail clipping, see above)
    setTimeout(function () {
        // deferred arm RE-CHECKS the identity: a fast toggle can close this
        // pop before the timer runs, and a stale document listener would
        // then hang around for the life of the page (dropMenu lesson)
        if (_sttPop !== pop) return;
        document.addEventListener('click', closeSttPop);
        document.addEventListener('keydown', sttPopKey);
        window.addEventListener('scroll', sttPopFollow, true);   // capture:
        window.addEventListener('resize', sttPopEscape);         // any scroll
    }, 0);
}

function toggleMic() {
    // VOICE-12: the mic is push-to-talk INTO THE COMPOSER now, gated by the
    // INPUT MODEL setting — no longer a chat-turn recorder (restored STT
    // conversations still transcribe ATTACHED files through nativeHandler).
    // VOICE-13: Continuous arms the LISTENER instead — same button, and its
    // second click closes the session (committing what was heard).
    if (_rt) { sttListenerStop(true); return; }
    if (sttMode() === 'continuous') { sttListenerStart(); return; }
    if (_mic) { sttCaptureStop(); return; }
    sttCaptureStart();
}

function sttCaptureStart(opts) {
    // WAV via AudioContext PCM, NOT MediaRecorder webm: this keg decodes
    // webm/ogg only through ffmpeg which is not a keg dependency — a webm
    // upload 400s on ffmpeg-less boxes (verified mlx_audio audio_io:533).
    // WAV decodes everywhere via miniaudio. 60 s cap.
    // VOICE-13 opts = {onFrame(Float32Array), onReady(rate), onFail()}:
    // continuous mode TAPS the same mic path frame-by-frame and keeps NO
    // growing WAV (the listener owns the audio's lifetime, so the 60 s PTT
    // cap does not apply — the listener tears down). Returns true when the
    // capture was actually armed (false = refused by a guard).
    if (_sttXfer || !sttModel() || sttMode() === 'off') return false;
    if (CORE._streaming) {
        // half-duplex (the VOICE-13 seed): never record over a streaming
        // reply — one honest toast, no queueing
        D().toast(tf2('uplift.chat.stt_wait_reply',
                      'Wait for the reply to finish before recording.'),
                  'error');
        return false;
    }
    var btn = gid('chat-native-mic');
    if (!W() || !W().navigator.mediaDevices || !W().navigator.mediaDevices.getUserMedia) {
        D().toast(t('chat.error.mic_unavailable',
                    'Microphone unavailable. Check browser permission and use localhost or HTTPS.'), 'error');
        return false;
    }
    var AC = W().AudioContext || W().webkitAudioContext;
    var tap = !!(opts && opts.onFrame);
    var snapModel = sttModel(), snapLang = sttLang();  // settings snapshot
    W().navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var ac = new AC();
        var src = ac.createMediaStreamSource(stream);
        var proc = ac.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        src.connect(proc); proc.connect(ac.destination);
        proc.onaudioprocess = function (e) {
            var f = new Float32Array(e.inputBuffer.getChannelData(0));
            if (!tap) chunks.push(f);        // PTT keeps the whole recording
            if (tap) { try { opts.onFrame(f); } catch (x) {} }
        };
        // the 60 s PTT cap has no meaning for a tap: the listener stops the
        // stream itself (utterance cap / endpoint / teardown paths)
        var timer = tap ? 0 : setTimeout(sttCaptureStop, 60000);
        _mic = { stream: stream, ac: ac, proc: proc, chunks: chunks,
                 timer: timer, btn: btn, model: snapModel, lang: snapLang,
                 tap: tap };
        if (btn && !tap) { btn.classList.add('rec');
            btn.title = tf2('uplift.chat.stt_listening', 'Listening…'); }
        if (tap && opts.onReady) {
            try { opts.onReady(ac.sampleRate || 48000); } catch (x) {}
        }
    }).catch(function (e) {
        D().toast(t('chat.error.mic_unavailable',
                    'Microphone unavailable. Check browser permission and use localhost or HTTPS.'), 'error');
        if (tap && opts.onFail) { try { opts.onFail(e); } catch (x) {} }
    });
    return true;
}

function sttCaptureStop() {
    var m = _mic; if (!m) return;
    _mic = null;
    clearTimeout(m.timer);
    try { m.proc.disconnect(); m.stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    var rate = m.ac.sampleRate || 48000;
    try { m.ac.close(); } catch (e) {}
    if (m.btn && !m.tap) { m.btn.classList.remove('rec');
        m.btn.title = tf2('chat.record_audio', 'Record audio'); }
    if (m.tap) return;   // VOICE-13: the LISTENER owns this stream — no WAV,
                         // no POST, no deliver here (it delivers per utterance)
    var seconds = Math.round(m.chunks.reduce(function (a, c) { return a + c.length; }, 0) / rate);
    if (seconds < 1) return;   // nothing meaningful captured, classic no-op
    var wav = encodeWav(m.chunks, rate);
    sttSetBusy(true);
    sttTranscribe(new Blob([wav], { type: 'audio/wav' }), {
        model: m.model, language: m.lang,
        onDone: function (text) {
            sttSetBusy(false);
            sttDeliver(text);   // result -> composer (NOT a chat turn)
        },
        onErr: function (err) {
            sttSetBusy(false);
            D().toast(errText(err), 'error');
        } });
}

function sttSetBusy(on) {
    // the transcribing interim state rides the mic button and MUST end on
    // every outcome — done, error, or watchdog (VOICE-3 doctrine)
    _sttXfer = on ? Date.now() : null;
    var btn = gid('chat-native-mic');
    if (!btn) return;
    btn.classList.toggle('busy', !!on);
    btn.title = on ? tf2('uplift.chat.stt_transcribing', 'Transcribing…')
                   : tf2('chat.record_audio', 'Record audio');
}

function sttTranscribe(wavBlob, opts) {
    // VOICE-12 transport, named small on purpose: VOICE-13's WS client
    // reuses THIS and sttDeliver without copy-paste. opts =
    // {model, language, onDelta(text), onDone(fullText), onErr(err)};
    // returns a cancel() handle. multipart stream=true -> SSE
    // transcript.text.delta/.done (the wire 6/6b proved live).
    opts = opts || {};
    var form = new FormData();
    form.append('file', wavBlob, 'microphone-recording.wav');
    form.append('model', opts.model || sttModel());
    form.append('stream', 'true');
    if (opts.language) form.append('language', opts.language);  // Auto=omit
    var controller = new AbortController();
    var settled = false, text = '';
    function settle(err) {
        clearTimeout(watchdog);
        if (settled) return;      // the watchdog already told the truth
        settled = true;
        if (err) { if (opts.onErr) opts.onErr(err); return; }
        if (opts.onDone) opts.onDone(text);
    }
    var watchdog = setTimeout(function () {
        // abandon a HUNG request honestly (voiceSignal's client-side twin:
        // the server may stay stuck, the button must not lie)
        try { controller.abort(); } catch (e) {}
        settle(new Error(tf2('uplift.voices.timeout',
            'the server did not answer in {n}s — model load may be stuck; '
            + 'request abandoned (restart the server to clear it)')
            .replace('{n}', String(Math.round(STT_TIMEOUT_MS / 1000)))));
    }, STT_TIMEOUT_MS);
    fetch('/v1/audio/transcriptions', {   // domkit-exempt: SSE + multipart
        method: 'POST',
        // NO Content-Type: the browser must set the multipart boundary
        // (classic's comment at chat.html:5635 — a trap, not a style note)
        headers: { 'Authorization': 'Bearer ' + CORE._key },
        body: form, signal: controller.signal })
    .then(function (resp) {
        if (resp.status === 404) {
            throw new Error(t('chat.error.asr_not_available',
                'Audio transcription is not available on this server.'));
        }
        if (!resp.ok) {
            return resp.text().then(function (bd) {
                var detail = null;
                try {
                    var j = JSON.parse(bd);
                    detail = (j.error && j.error.message) || j.detail;
                } catch (e) { /* plain text */ }
                throw new Error(detail || bd || ('Error: ' + resp.status));
            });
        }
        var reader = resp.body.getReader(), dec = new TextDecoder();
        var buf = '';
        function pump() {
            return reader.read().then(function (res) {
                if (res.done) return;
                buf += dec.decode(res.value, { stream: true });
                var lines = buf.split('\n'); buf = lines.pop();
                lines.forEach(function (ln) {
                    if (ln.indexOf('data: ') !== 0) return;
                    if (ln.trim() === 'data: [DONE]') return;
                    var d;
                    try { d = JSON.parse(ln.slice(6)); } catch (e) { return; }
                    if (d.type === 'transcript.text.delta' && d.delta) {
                        text += d.delta;
                        if (opts.onDelta) opts.onDelta(d.delta);
                    } else if (d.type === 'transcript.text.done') {
                        var fin = d.text == null ? text : d.text;
                        if (fin.length > text.length) {
                            if (opts.onDelta) opts.onDelta(fin.slice(text.length));
                            text = fin;
                        }
                    }
                });
                return pump();
            });
        }
        return pump();
    }).then(function () { settle(null); }, function (e) { settle(e); });
    return function cancel() {
        settled = true;
        clearTimeout(watchdog);
        try { controller.abort(); } catch (e) {}
    };
}

function sttComposerAppend(text) {
    // COMPOSER SEAM (bundle audit 2026-10-17, deep-chat 2.5.1): the input
    // is the contenteditable #text-input inside the OPEN shadowRoot
    // (TextInputService.createInputElement: u.id=TEXT_INPUT_ID='text-input',
    // class text-input-styling; NO textarea, and 2.5.1 exposes no
    // textInputService/setInputText property). submitFromInput reads its
    // innerText, attemptSubmit clears it — so writing textContent here IS
    // what the Send button will send. Never clobber unsent user text:
    // append after it with one space, focus, caret kept at end.
    var root = CORE._dc && CORE._dc.shadowRoot;
    var inp = (root && root.getElementById)
        ? root.getElementById('text-input') : null;
    if (!inp) return text;      // component absent (stub env): pass through
    var cur = inp.textContent || '';
    inp.textContent = (cur ? cur + ' ' : '') + text;
    try {
        // keep the component's placeholder/tracking logic in the loop
        inp.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) { /* no Event ctor in the node stub — value still set */ }
    inp.focus();
    try {
        var r = document.createRange();
        r.selectNodeContents(inp); r.collapse(false);
        var sel = W() && W().getSelection && W().getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(r); }
    } catch (e) { /* contenteditable caret is best-effort (vendor does the same) */ }
    return inp.textContent;
}

function sttDeliver(text) {
    // THE result sink (VOICE-13's WS client reuses this one function):
    // transcript -> composer for review; AUTO-SEND ON submits it through
    // the component's real send route — dc.submitUserMessage is
    // programmaticSubmit -> attemptSubmit, the SAME path the Send button
    // and regenerate/edit take (onMessage pump + nativeHandler included).
    var s = String(text == null ? '' : text).replace(/\s+$/, '');
    if (!s.trim()) return '';               // silence: silent no-op
    var full = sttComposerAppend(s);
    if (sttAutoSend() && CORE._dc && CORE._dc.submitUserMessage) {
        CORE._dc.submitUserMessage({ text: full });   // attemptSubmit clears the box
    }
    return full;
}

// ---- VOICE-13: continuous listening ---------------------------------------
// Hands-free mode next to push-to-talk: the mic stays open, deltas render
// into the composer live, silence lands the utterance, a fresh session
// reopens. Wire VERBATIM from omlx audio_routes.py:644 realtime_transcription
// (read 2026-10-17, same origin as the dashboard, api_key in the start frame
// because a browser WS cannot carry an Authorization header):
//   client {"type":"start","model":..,"api_key":..,"language"?}  (Auto OMITS
//          language — VOICE-5 doctrine, same as the multipart path)
//   server {"type":"ready"} | {"type":"error","detail":..} then close
//   client BINARY frames = 16 kHz mono little-endian Int16 PCM
//   server {"type":"transcript.delta","delta":..} per text commit
//   client {"type":"stop"} -> server flushes deltas,
//   {"type":"transcript.done","text":..}, closes 1000.
// Capability is decided SERVER-SIDE. Since jundot/omlx 2792f06cb363 every
// audio_stt model claims realtime: streaming families keep their incremental
// backends and everything else (Qwen3-ASR included) is served by the server's
// segmented backend — whole-buffer decode per closed utterance. Before that
// commit Qwen3-ASR was refused and we relied on our own voice14 patch, since
// dropped. A rejection still arrives as a clean error frame and the listener
// drops to SEGMENTED capture. ONE realtime session per engine, so a refusal
// or a drop is surfaced ONCE and never retried in a loop.
// Measured on omlx HEAD-c3595bc (devbox, Qwen3-ASR-1.7B-8bit, 16k s16le):
// ready 0.1s, first commit 10.4s into a paced 16s dictation (delta arrives
// WHILE the mic is still feeding), Czech auto-language 5.1s end-to-end, text
// identical to POST /v1/audio/transcriptions, and a stop with no silence tail
// flushes the unclosed utterance (the commit=true contract).
var RT_PATH = '/v1/audio/transcriptions/realtime';
var RT_RATE = 16000;                         // the wire rate
var RT_FRAME_MS = 100;                       // ~100 ms binary frames
var RT_FRAME_SAMPLES = RT_RATE * RT_FRAME_MS / 1000;   // 1600 smp = 3200 B
var RT_SILENCE_RMS = 0.01;   // endpoint gate DEFAULT until the room is measured
var RT_CAL_MS = 500;         // VOICE-13a(c): first ~500 ms estimate the noise floor
var RT_CAL_FACTOR = 3;       //   gate = 3x floor
var RT_GATE_MIN = 0.004;     //   clamped: a dead-quiet room still gets a real gate
var RT_GATE_MAX = 0.03;      //   a loud room must not deafen the endpointer
var RT_SILENCE_MS = 1200;    // endpoint: >=1 delta AND this much silence
var RT_STUCK_MS = 6000;      // escape: voiced audio, ZERO deltas -> restart
var RT_MAX_RESTARTS = 3;     // ...and after that the engine is not coming back
var RT_SLOW_VOICED_MS = 12000;  // guard: the UP-9 large-model cadence behind a
var RT_SLOW_CPS = 0.5;          // name a0's heuristic cannot see -> demote once
var RT_MAX_MS = 120000;      // hard utterance cap -> force stop + deliver
// VOICE-14: whole-buffer backends (Qwen3-ASR via the server's segmented
// realtime backend) cannot commit before a real pause — their first delta
// arrives only after the server's 0.7 s endpoint + decode. The 6 s
// zero-delta stuck-escape assumes
// true-streaming cadence and would restart-loop mid-sentence, discarding
// every uncommitted buffer each time (user-machine report: nothing transcribed,
// engine forever busy). Such models ride the 120 s cap instead.
var RT_WB_ID = /qwen3[-_. ]?asr/i;
var RT_GAP_MS = 300;         // session reopen / echo-guard resume tail
var RT_HANDSHAKE_MS = 10000; // the server's OWN handshake budget, client copy
var RT_DONE_MS = 5000;       // bounded wait for transcript.done after stop
var RT_DONE_WB_MS = 30000;   // whole-buffer models decode AFTER the server's
                             // own endpoint; a streaming-tuned 5 s wait aborts
                             // mid-decode and commits to a dead socket (user-machine
                             // field report) — cover the capped decode instead
// segmented fallback windows (the card's numbers, client VAD over the tap)
var RT_SEG_PREROLL_MS = 300;   // speech started before the first voiced frame
var RT_SEG_SILENCE_MS = 800;   // silence that closes a segment
var RT_SEG_MIN_MS = 400;       // shorter than this is a cough, not an utterance
var RT_SEG_MAX_MS = 60000;     // VOICE-12's PTT capture cap, per segment

var _rt = null;    // the ONE live listener (continuous mode), null = idle

// -- pure capture-tap helpers (no AudioContext, so node can drive them) ----
function rtRms(f) {
    // RMS of a float frame — the silence gate reads the SAME frames the
    // endpointer counts, never a second tap.
    if (!f || !f.length) return 0;
    var s = 0;
    for (var i = 0; i < f.length; i++) s += f[i] * f[i];
    return Math.sqrt(s / f.length);
}
function rtS16le(floats) {
    // Float32 -> Int16 little-endian, clamped to [-1,1] with encodeWav's EXACT
    // scale (-1 -> -0x8000, +1 -> +0x7FFF) — one conversion doctrine for both
    // transports, so a byte the WAV path would have sent is a byte the WS
    // sends. Pure: the node test feeds a ramp and asserts the bytes.
    var out = new Uint8Array(floats.length * 2);
    var dv = new DataView(out.buffer);
    for (var i = 0; i < floats.length; i++) {
        var s = Math.max(-1, Math.min(1, floats[i]));
        dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return out;
}
function rtTap(srcRate, dstRate, frameSamples) {
    // Linear decimate device-rate blocks into whole dstRate frames. The
    // ScriptProcessor hands over 4096-sample blocks that are NOT a multiple
    // of the 100 ms/16 kHz frame, so BOTH the leftover samples and the
    // interpolation phase carry across pushes — restarting the phase per
    // block is a periodic resample wobble (and 16k from 44.1/48k deserves
    // better than that). MEASUREMENT CALL from the card: ScriptProcessor +
    // this decimator ships now; AudioWorklet is the recorded follow-up (the
    // worklet module needs a real, non-cookie-gated URL on Safari).
    var step = srcRate / dstRate, acc = [], pos = 0;
    return {
        push: function (floats) {
            var frames = [], i;
            for (i = 0; i < floats.length; i++) acc.push(floats[i]);
            // indices below are all relative to THIS acc[0]: the buffer is
            // compacted ONCE per push, never per frame (a per-frame slice of
            // a multi-second backlog is quadratic)
            for (;;) {
                var last = pos + (frameSamples - 1) * step;
                // +2: interpolation reads the sample AFTER the last one
                if (Math.floor(last) + 2 > acc.length) break;
                var out = new Float32Array(frameSamples);
                for (var k = 0; k < frameSamples; k++) {
                    var p = pos + k * step, i0 = Math.floor(p), fr = p - i0;
                    var a = acc[i0], b = acc[i0 + 1];
                    out[k] = a + ((b === undefined ? a : b) - a) * fr;
                }
                pos = last + step;               // phase continues, never resets
                frames.push(out);
            }
            var drop = Math.floor(pos);          // release the consumed prefix
            if (drop > 0) { acc = acc.slice(drop); pos -= drop; }
            return frames;
        },
    };
}

// -- listener ---------------------------------------------------------------
function rtNew() {
    return { state: 'connecting', transport: 'realtime', phase: 'up',
             ws: null, wsOpen: false, paused: false, dead: false, told: false,
             model: sttModel(), lang: sttLang(), rate: 48000, tap: null,
             wb: RT_WB_ID.test(sttModel()), closing: false,
             text: '', got: false, frames: 0, voiced: 0, silent: 0,
             restarts: 0, seg: null, segMs: 0, segSilent: 0,
             // VOICE-13a(c): noise-floor calibration, ONCE per listener run
             // (the room does not change between utterances; recalibrating
             // after a mid-speech reopen would take shouting for the floor)
             silenceRms: RT_SILENCE_RMS, floorMs: 0, floor: 0, floorN: 0,
             preroll: [], prerollMs: 0, provEl: null, cancel: null,
             hsTimer: 0, doneTimer: 0, reopenTimer: 0, resumeTimer: 0 };
}
function sttListenerStart() {
    if (_rt || _mic || !sttModel() || sttMode() !== 'continuous') return;
    if (CORE._streaming) {
        // VOICE-12's half-duplex guard, extended to continuous: one honest
        // toast, no queueing, no silent retry
        var d0 = D();
        if (d0) d0.toast(tf2('uplift.chat.stt_wait_reply',
            'Wait for the reply to finish before recording.'), 'error');
        return;
    }
    _rt = rtNew();
    // the handshake waits for audio: the engine holds ONE realtime session,
    // so it must not be spent while getUserMedia is still prompting the user
    if (!sttCaptureStart({
        onFrame: rtFrame,
        onReady: function (rate) {
            var s = _rt; if (!s) return;
            s.rate = rate || 48000;
            s.tap = rtTap(s.rate, RT_RATE, RT_FRAME_SAMPLES);
            if (rtDiscouraged(s.model)) { rtFallback(s, ''); return; }
            rtOpen(s);
        },
        onFail: function () { sttListenerStop(false); },
    })) { _rt = null; return; }
    rtChip();
}
function sttListenerStop(commit) {
    // teardown discipline: mic off / mode change / input-model change /
    // conversation switch / New Chat / unload ALL close the socket, or the
    // engine keeps a session no browser owns (an engine leak is worse than a
    // UI leak). commit=true (the user's own click) FIRST FLUSHES the tail:
    // the server only closes uncommitted audio over a LIVE socket (the
    // segmented backend commits whole utterances after a pause), so halting
    // straight away silently ate the words spoken since the last pause
    // (user-machine report).
    // commit=false (context switched under the user) drops the provisional
    // line instead — never flush what the user no longer owns.
    var s = _rt;
    if (!s) return;
    if (commit && !s.dead && !s.closing && !s.paused
        && s.transport === 'realtime' && s.wsOpen && s.phase === 'up') {
        s.closing = true;
        rtEndpoint(s);            // stop -> done/timeout -> rtFinish -> teardown
        return;
    }
    if (commit && !s.dead && !s.closing && s.transport === 'segmented'
        && s.seg && s.segMs >= RT_SEG_MIN_MS && !_sttXfer) {
        rtSegmentClose(s, true);  // detached POST: outlives the teardown
    }
    _rt = null;
    s.dead = true;
    s.paused = false;
    s.state = 'idle';
    clearTimeout(s.hsTimer); clearTimeout(s.doneTimer);
    clearTimeout(s.reopenTimer); clearTimeout(s.resumeTimer);
    s.hsTimer = s.doneTimer = s.reopenTimer = s.resumeTimer = 0;
    rtHaltSocket(s);
    if (s.cancel) { try { s.cancel(); } catch (e) {} s.cancel = null; }
    if (commit) rtCommit(s);
    else { rtProvisional(s, ''); s.text = ''; s.got = false; }
    if (_mic && _mic.tap) sttCaptureStop();   // tap stop: no WAV, no POST
    rtChip();
}
function rtUrl() {
    // same-origin wss://host/v1/... on https, ws:// on http — the WS lives on
    // the omlx API mount, NOT /admin/api, so no cookie is involved
    var loc = W() && W().location;
    if (!loc || !loc.host) return '';
    var secure = String(loc.protocol || 'http:').indexOf('s') > 0;
    return (secure ? 'wss://' : 'ws://') + loc.host + RT_PATH;
}
// VOICE-13a(a0): UP-9 MEASURED that whisper large-v3-class checkpoints ACCEPT
// the realtime handshake and then commit ~one token per ~20 s window
// (AlignAtt cannot keep the 1 s cadence on 1280-dim decoders) — worse than
// segmented, and the stuck-escape ladder may never fire because a late delta
// keeps resetting it. The engine still reports these models SUPPORTED, so the
// client declines the known-broken transport up front: no handshake, no
// ladder, straight to segments. tiny-class and unknown models keep realtime.
// REMOVE THIS WHEN UP-9 IS FIXED UPSTREAM — do not let it rot. Models under
// custom names that slip past this regex are caught later by the commit-rate
// guard (RT_SLOW_*): same destination, measured instead of guessed.
function rtDiscouraged(id) {
    var m = String(id || '').toLowerCase();
    return /whisper[-_ ]?large|large[-_ ]?v[23]/.test(m);
}
function rtSendText(s, obj) {
    if (!s || !s.ws) return;
    try { s.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
    catch (e) {}
}
function rtHaltSocket(s) {
    // detach the handlers FIRST: our own close() must not read as a drop
    var ws = s.ws;
    s.ws = null; s.wsOpen = false;
    clearTimeout(s.hsTimer); s.hsTimer = 0;
    if (!ws) return;
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch (e) {}
    try { ws.close(); } catch (e) {}
}
function rtOpen(s) {
    if (!s || s.dead || _rt !== s || s.transport !== 'realtime') return;
    clearTimeout(s.reopenTimer); s.reopenTimer = 0;
    var WS = W() && W().WebSocket, url = rtUrl();
    if (!WS || !url) { rtFallback(s, ''); return; }   // no transport at all
    s.state = 'connecting'; s.phase = 'up'; s.wsOpen = false;
    rtChip();
    var ws = null;
    try { ws = new WS(url); } catch (e) { rtFallback(s, errText(e)); return; }
    s.ws = ws;
    try { ws.binaryType = 'arraybuffer'; } catch (e) {}
    ws.onopen = function () {
        if (_rt !== s || s.dead || s.ws !== ws) return;
        var frame = { type: 'start', model: s.model, api_key: CORE._key };
        if (s.lang) frame.language = s.lang;   // Auto = field OMITTED
        rtSendText(s, frame);
    };
    // s.ws !== ws is the guard that makes our OWN close (and any late frame
    // from a socket already replaced) inert — rtHaltSocket nulls s.ws first
    ws.onmessage = function (ev) {
        if (_rt === s && !s.dead && s.ws === ws) rtMessage(s, ev && ev.data);
    };
    ws.onerror = function () {
        if (_rt !== s || s.dead || s.ws !== ws) return;
        rtFallback(s, tf2('uplift.chat.stt_lost', 'The listening session closed.'));
    };
    ws.onclose = function () {
        if (_rt === s && !s.dead && s.ws === ws) rtClosed(s);
    };
    clearTimeout(s.hsTimer);
    s.hsTimer = setTimeout(function () {
        s.hsTimer = 0;
        if (_rt !== s || s.dead || s.wsOpen) return;
        // the server answers 'ready' inside its own 10 s budget; silence is
        // an answer too — say it ONCE and fall back, never reconnect-loop
        rtFallback(s, '');
    }, RT_HANDSHAKE_MS);
}
function rtMessage(s, data) {
    var m = data;
    if (typeof data === 'string') {
        // the upstream answer is a JSON object, {"type":"ready"}; the ticket
        // short-hand writes it as bare 'ready' — accept that spelling too
        // rather than inventing a third one
        if (data.trim() === 'ready') m = { type: 'ready' };
        else { try { m = JSON.parse(data); } catch (e) { return; } }
    }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') {
        clearTimeout(s.hsTimer); s.hsTimer = 0;
        s.wsOpen = true; s.phase = 'up';
        s.state = s.paused ? 'paused' : 'listening';
        rtChip();
        return;
    }
    if (m.type === 'error') { rtFallback(s, String(m.detail || '')); return; }
    if (m.type === 'transcript.delta') {
        if (!m.delta) return;
        s.text += m.delta;
        s.got = true;
        s.silent = 0;                 // speech resumed: the window restarts
        rtProvisional(s, s.text);
        return;
    }
    if (m.type === 'transcript.done') {
        rtFinish(s, m.text == null ? s.text : m.text);
    }
}
function rtFrame(floats) {
    // THE capture tap — one device-rate block per ScriptProcessor callback.
    var s = _rt;
    if (!s || s.dead || !floats || !floats.length) return;
    if (s.paused) {
        // echo guard: frames are DROPPED while the assistant talks (nothing
        // of its voice may reach the engine). The drain event resumes; this
        // check is the state-sync twin in case the queue settled first.
        if (!CORE.speakBusy()) rtResumeSoon(s);
        return;
    }
    if (CORE.speakBusy()) { rtPause(s); return; }
    if (s.floorMs < RT_CAL_MS) {
        // VOICE-13a(c): estimate the room floor from the first ~500 ms of
        // live frames and set the session's endpoint gate to 3x it (clamped
        // 0.004..0.03). The old fixed 0.01 never sees silence in a room that
        // hisses above it — the whole session then lands as one blob
        // (observed). Runs for BOTH transports; frames still flow while the
        // estimate collects.
        s.floor += rtRms(floats); s.floorN++;
        s.floorMs += floats.length / (s.rate || 48000) * 1000;
        if (s.floorMs >= RT_CAL_MS) {
            s.silenceRms = Math.min(RT_GATE_MAX,
                Math.max(RT_GATE_MIN, s.floor / s.floorN * RT_CAL_FACTOR));
        }
    }
    if (s.transport === 'segmented') { rtSegment(s, floats); return; }
    if (!s.tap) return;
    var fr = s.tap.push(floats);
    for (var i = 0; i < fr.length; i++) rtFeed(s, fr[i]);
}
function rtFeed(s, f16) {
    if (s.phase !== 'up') return;   // stop sent: the utterance is already closed
    var silent = rtRms(f16) < s.silenceRms;   // VOICE-13a(c): calibrated gate
    s.frames++;
    s.silent = silent ? s.silent + 1 : 0;
    if (!silent) s.voiced++;
    if (s.wsOpen && s.ws) {
        try { s.ws.send(rtS16le(f16)); } catch (e) {}
    }
    // windows count 100 ms FRAMES, not wall time: fake-timer deterministic and
    // identical to what the engine actually received
    if (s.got && s.silent * RT_FRAME_MS >= RT_SILENCE_MS) { rtEndpoint(s); return; }
    if (!s.got && !s.wb && s.voiced * RT_FRAME_MS >= RT_STUCK_MS) { rtRestart(s); return; }
    // UP-9 hardening: a session that is technically alive but commits under
    // half a character per voiced second is losing every word to the
    // AlignAtt lag (measured on large-v3-class: "The" in 20 s). The name
    // heuristic above cannot see custom model ids; the rate can.
    if (s.got && !s.wb && s.voiced * RT_FRAME_MS >= RT_SLOW_VOICED_MS &&
        s.text.length < s.voiced * RT_FRAME_MS / 1000 * RT_SLOW_CPS) {
        rtSlowDemote(s); return;
    }
    if (s.frames * RT_FRAME_MS >= RT_MAX_MS) rtEndpoint(s);
}
function rtEndpoint(s) {
    // >=1 delta + 1.2 s of silence (or the 120 s cap): ask the engine to
    // flush, land the utterance on transcript.done, reopen a FRESH session.
    if (s.phase !== 'up') return;
    s.phase = 'finishing';
    rtSendText(s, { type: 'stop' });
    clearTimeout(s.doneTimer);
    s.doneTimer = setTimeout(function () {
        s.doneTimer = 0;
        if (_rt !== s || s.dead) return;
        rtFinish(s, s.text);      // the flush stalled: keep what we heard
    }, s.wb ? RT_DONE_WB_MS : RT_DONE_MS);
}
function rtRestart(s) {
    // stuck-engine escape: ~6 s of VOICED audio produced ZERO deltas. Drop
    // the session, keep listening on a new one; after RT_MAX_RESTARTS the
    // engine has said all it is going to say — go segmented.
    if (s.reopenTimer || s.dead) return;
    rtResetUtterance(s);
    rtHaltSocket(s);
    s.restarts++;
    if (s.restarts > RT_MAX_RESTARTS) { rtFallback(s, ''); return; }
    s.state = 'connecting';
    rtChip();
    rtReopenLater(s);
}
function rtSlowDemote(s) {
    // UP-9: restarts do not help a session that IS committing, just far
    // slower than speech — that is the transport losing to the decoder.
    // What was heard is the user's words: land it, then demote the whole
    // LISTEN run to segmented for good (same terminal move the restart
    // ladder makes, one rung earlier).
    if (s.closing) { sttListenerStop(false); return; }
    clearTimeout(s.doneTimer); s.doneTimer = 0;
    s.phase = 'idle';
    rtHaltSocket(s);
    rtCommit(s);
    rtFallback(s, tf2('uplift.chat.stt_slow',
        'Realtime transcription is too slow — switched to segmented capture.'));
}
function rtFinish(s, text) {
    clearTimeout(s.doneTimer); s.doneTimer = 0;
    s.phase = 'idle';
    s.text = String(text == null ? '' : text);
    rtHaltSocket(s);
    rtCommit(s);
    if (s.closing) { sttListenerStop(false); return; }   // flush done -> real stop
    if (s.dead || _rt !== s || s.paused || s.transport !== 'realtime') return;
    rtReopenLater(s);
}
function rtClosed(s) {
    // the socket went away without a done frame (server died, engine was
    // freed, another tab took the session). Honest chip, ONE toast, and NO
    // reconnect storm: the listener stops, the user re-arms it.
    clearTimeout(s.doneTimer); s.doneTimer = 0;
    var finishing = s.phase === 'finishing';
    rtHaltSocket(s);
    // deltas the engine already committed are the user's words — land them,
    // lose nothing, whatever killed the socket
    rtCommit(s);
    if (s.closing) { sttListenerStop(false); return; }   // flush was in flight
    if (finishing) {
        if (!_rt || _rt !== s || s.dead || s.paused) return;
        rtReopenLater(s);              // the utterance closed; keep listening
        return;
    }
    var d = D();
    if (d) d.toast(tf2('uplift.chat.stt_lost', 'The listening session closed.'),
                   'error');
    sttListenerStop(false);
}
function rtReopenLater(s) {
    if (s.reopenTimer || s.dead || _rt !== s) return;
    s.reopenTimer = setTimeout(function () {
        s.reopenTimer = 0;
        if (_rt !== s || s.dead || s.paused || s.transport !== 'realtime') return;
        rtOpen(s);
    }, RT_GAP_MS);
}
function rtResetUtterance(s) {
    s.text = ''; s.got = false;
    s.frames = 0; s.voiced = 0; s.silent = 0;
    s.seg = null; s.segMs = 0; s.segSilent = 0;
    s.preroll = []; s.prerollMs = 0;
    s.phase = 'up';
    if (s.tap) s.tap = rtTap(s.rate, RT_RATE, RT_FRAME_SAMPLES);   // phase-clean
}
function rtCommit(s) {
    // provisional line -> plain text through sttDeliver, THE single result
    // sink (append + auto-send decision). The span is stripped FIRST:
    // sttComposerAppend reads the live textContent and would double the text.
    var text = s.text;
    rtResetUtterance(s);
    rtProvisional(s, '');
    if (text && String(text).trim()) sttDeliver(text);
}
function rtProvisional(s, text) {
    // live deltas render as a MUTED span inside the vendor composer (its
    // styling ships in applyShadowTheme — the light-DOM sheet cannot cross
    // the shadow boundary). A child node, not a textContent rewrite, so the
    // user's own unsent draft is never touched; the send button does not see
    // provisional text because no input event fires for it.
    var root = CORE._dc && CORE._dc.shadowRoot;
    var inp = (root && root.getElementById)
        ? root.getElementById('text-input') : null;
    if (!inp) return;
    try {
        if (!text) {
            if (s.provEl) { s.provEl.remove(); s.provEl = null; }
            return;
        }
        if (s.provEl && s.provEl.parentNode !== inp
                       && s.provEl.parentElement !== inp) {
            s.provEl = null;    // the vendor rebuilt the composer (submit,
                                // history render): never write into a
                                // detached node, attach a fresh one
        }
        if (!s.provEl) {
            s.provEl = el('span', 'chat-native-stt-prov');
            inp.appendChild(s.provEl);
        }
        s.provEl.textContent = String(text);
    } catch (e) {
        s.provEl = null;    // a styling seam must never cost the user words
    }
}
// -- segmented fallback (model rejected realtime / no WS / handshake stall) --
function rtFallback(s, detail) {
    // Same UX above the transport line: client VAD cuts utterances out of the
    // SAME live tap and hands them to VOICE-12's record->encodeWav->
    // sttTranscribe->sttDeliver path. Decided by the server's first answer;
    // told ONCE; the realtime socket is never opened again this run.
    if (s.closing) { sttListenerStop(false); return; }   // user already stopped
    if (s.transport === 'segmented') return;
    rtResetUtterance(s);
    rtHaltSocket(s);
    s.transport = 'segmented';
    s.state = s.paused ? 'paused' : 'listening';
    if (!s.told) {
        s.told = true;
        var d = D();
        if (d) d.toast(tf2('uplift.chat.stt_segmented',
            'Realtime listening unavailable — capturing in segments instead.')
            + (detail ? ' (' + detail + ')' : ''), 'error');
    }
    rtChip();
}
function rtSegment(s, floats) {
    var rate = s.rate || 48000;
    if (_sttXfer) return;    // one transcribe in flight (VOICE-12 doctrine):
                             // drop, do not grow an unbounded queue
    var ms = floats.length / rate * 1000;
    var voiced = rtRms(floats) >= s.silenceRms;   // calibrated gate (both paths)
    if (voiced) {
        s.segSilent = 0;
        if (!s.seg) {
            s.seg = s.preroll.slice();     // speech started ~300 ms earlier
            s.segMs = s.prerollMs;
        }
    }
    if (!voiced && !s.seg) {
        s.preroll.push(floats); s.prerollMs += ms;
        while (s.preroll.length > 1 &&
               s.prerollMs > RT_SEG_PREROLL_MS) {
            var d = s.preroll.shift();
            s.prerollMs -= d.length / rate * 1000;
        }
        return;
    }
    s.preroll = []; s.prerollMs = 0;
    s.seg.push(floats); s.segMs += ms;
    if (!voiced) s.segSilent += ms;
    if ((s.segSilent >= RT_SEG_SILENCE_MS || s.segMs >= RT_SEG_MAX_MS) &&
        !_sttXfer) rtSegmentClose(s);
}
function rtSegmentClose(s, keepAlive) {
    var chunks = s.seg || [];
    var ms = s.segMs;
    s.seg = null; s.segMs = 0; s.segSilent = 0;
    if (ms < RT_SEG_MIN_MS || !chunks.length) return;   // a cough is not speech
    var wav = encodeWav(chunks, s.rate || 48000);
    sttSetBusy(true);
    // keepAlive: the STOP flush detaches the POST from the dying session —
    // teardown must not cancel the user's own words. The result may land
    // AFTER the listener is gone, so the guards below only drop it when a
    // SUCCESSOR context exists (_rt moved on), never because this session ended.
    var handle = sttTranscribe(new Blob([wav], { type: 'audio/wav' }), {
        model: s.model, language: s.lang,
        onDone: function (text) {
            if (!keepAlive) s.cancel = null;
            sttSetBusy(false); rtChip();
            // keepAlive (stop flush) may only be dropped by a SUCCESSOR
            // context; the live-session path keeps the original discipline
            // (a teardown mid-POST means the result is no longer wanted —
            // and never leaks words into a conversation the user switched to)
            if (keepAlive ? !!(_rt && _rt !== s) : (s.dead || _rt !== s)) return;
            sttDeliver(text);
        },
        onErr: function (err) {
            if (!keepAlive) s.cancel = null;
            sttSetBusy(false); rtChip();
            if (keepAlive ? !!(_rt && _rt !== s) : (s.dead || _rt !== s)) return;
            var d = D();
            if (d) d.toast(errText(err), 'error');
        } });
    if (!keepAlive) s.cancel = handle;
}
// -- echo guard (half-duplex vs the VOICE-11 speak queue) -------------------
function rtSpeakEvent(busy) {
    // the ONE call speakBusy()/speakEvent() reaches: wired to the queue's own
    // start/drain/cancel points, never to an audio-clock poll
    var s = _rt;
    if (!s || s.dead) return;
    if (busy) rtPause(s);
    else rtResumeSoon(s);
}
function rtPause(s) {
    if (s.paused || s.state === 'idle' || s.closing) return;
    s.paused = true;
    s.state = 'paused';
    clearTimeout(s.reopenTimer); s.reopenTimer = 0;
    clearTimeout(s.doneTimer); s.doneTimer = 0;
    // the assistant's voice must not reach the engine, so the frames stop AND
    // the engine's single slot is freed while we are deaf. What was already
    // heard is committed as-is (provisional -> text) rather than thrown away.
    if (s.transport === 'realtime') { rtCommit(s); rtHaltSocket(s); }
    else { s.seg = null; s.segMs = 0; s.segSilent = 0; s.preroll = [];
           s.prerollMs = 0; }
    rtChip();
}
function rtResumeSoon(s) {
    if (!s.paused || s.resumeTimer || s.dead) return;
    s.resumeTimer = setTimeout(function () {
        s.resumeTimer = 0;
        if (_rt !== s || s.dead || !s.paused) return;
        if (CORE.speakBusy() || CORE._streaming) { rtResumeSoon(s); return; }
        s.paused = false;
        rtResetUtterance(s);
        if (s.transport === 'realtime') rtOpen(s);
        else { s.state = 'listening'; rtChip(); }
    }, RT_GAP_MS);
}
function rtChip() {
    // the mic button IS the chip (no new toolbar element to crowd the row):
    // 'rt' pulses while listening, 'connecting'/'paused' stay steady.
    var btn = gid('chat-native-mic');
    if (!btn || !btn.classList) return;
    var s = _rt, st = s ? s.state : 'idle';
    var live = st === 'listening' || st === 'connecting';
    btn.classList.toggle('rt', live);
    btn.classList.toggle('connecting', st === 'connecting');
    btn.classList.toggle('paused', st === 'paused');
    btn.title = st === 'connecting'
        ? tf2('uplift.chat.stt_connecting', 'Connecting…')
        : (st === 'paused'
            ? tf2('uplift.chat.stt_paused_echo',
                  'Paused while the assistant speaks')
            : (st === 'idle' ? tf2('chat.record_audio', 'Record audio')
               : tf2('uplift.chat.stt_listening', 'Listening…')));
}

return {
    STT_MODEL_KEY: STT_MODEL_KEY,
    STT_LANG_KEY: STT_LANG_KEY,
    STT_MODE_KEY: STT_MODE_KEY,
    get _mic() { return _mic; },
    get _sttPop() { return _sttPop; },
    get _sttXfer() { return _sttXfer; },
    sttModel: sttModel,
    sttLang: sttLang,
    sttAutoSend: sttAutoSend,
    sttMode: sttMode,
    syncSttMic: syncSttMic,
    sttSettingsBtn: sttSettingsBtn,
    toggleMic: toggleMic,
    sttCaptureStart: sttCaptureStart,
    sttCaptureStop: sttCaptureStop,
    sttTranscribe: sttTranscribe,
    sttComposerAppend: sttComposerAppend,
    sttDeliver: sttDeliver,
    RT_RATE: RT_RATE,
    RT_FRAME_MS: RT_FRAME_MS,
    RT_FRAME_SAMPLES: RT_FRAME_SAMPLES,
    RT_SILENCE_RMS: RT_SILENCE_RMS,
    get _rt() { return _rt; },
    rtRms: rtRms,
    rtS16le: rtS16le,
    rtTap: rtTap,
    sttListenerStart: sttListenerStart,
    sttListenerStop: sttListenerStop,
    rtUrl: rtUrl,
    rtDiscouraged: rtDiscouraged,
    rtFrame: rtFrame,
    rtSpeakEvent: rtSpeakEvent
};
});
