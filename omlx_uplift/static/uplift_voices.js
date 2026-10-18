/* Uplift VOICES page (VOICE-1): named voice-cloning voices for TTS.
   Vanilla /v1/audio/speech already clones voices from ref_audio+ref_text
   per request; this page owns the NAMES: upload a reference clip once,
   type its transcript, then any client (and the chat read-aloud button)
   addresses it by name. Plain script; loads AFTER uplift_state.js +
   uplift_modelmgr.js (adminModels feed the TTS model select), BEFORE
   uplift.js, which calls VOI.renderVoices() on #models/voices. Exports
   window.Uplift.voices {renderVoices, voices, loadVoices, ttsModels};
   uplift_chat.js consumes the same export for its speaker buttons.
   Storage + format + size rules are the SERVER's (routers/voices.py);
   this module only mirrors the accepted extensions for a client-side
   hint and surfaces honest errors — it enforces nothing. */
(function () {
'use strict';
const C = window.UpliftCore;
const D = window.UpliftDom;
const S = window.Uplift.state;
const $ = D.$;
const VAPI = S.API + '/uplift/api';   // uplift mount (patcher precedent):
// S.API alone would hit /admin/api where the VANILLA routes win, and vanilla
// has no /voices — the router is registered on both mounts, the explicit
// /uplift/api leg is the only one that reaches our handlers.
const MM = window.Uplift.modelmgr;

const AUDIO_EXTS = ['wav', 'mp3', 'flac'];   // server whitelist (no ffmpeg)
const MAX_BYTES = 14 * 1024 * 1024;          // server cap, mirrored as a hint
let _voices = [];
let _player = null, _playerUrl = null;

function tf(k, d) { return C.tf(k, d); }

async function loadVoices() {
    try {
        const d = await D.fetchJson(`${VAPI}/voices`);
        _voices = d.voices || [];
    } catch (e) { _voices = []; }
    return _voices;
}

function ttsModels() {
    // adminModels arrive with engine_type/model_type; discovery labels
    // the Qwen3-TTS/Kokoro/... family audio_tts
    return (MM.adminModels || []).filter(m =>
        (m.engine_type || m.model_type) === 'audio_tts');
}

function sttModels() {
    // VOICE-2: audio_stt (whisper/Qwen3-ASR/...) powers auto-transcribe;
    // same catalog + same engine_type convention as ttsModels()
    return (MM.adminModels || []).filter(m =>
        (m.engine_type || m.model_type) === 'audio_stt');
}

/* VOICE-4 (user): saved voices present as 'model:voice' EVERYWHERE the
   user picks or sees one (Voices rows, chat selector) — the exact
   composite the speech routes accept as an alias (VOICE-1c parses it
   back), so what you read is literally what you could send. */
function voiceLabel(v) {
    // SAY-1: the 'say:<Name>' marker is store plumbing — in the picker a
    // system voice reads as its name + a 'macOS' tag, never as a fake model.
    if (v.model && String(v.model).indexOf('say:') === 0) {
        return v.name + ' (macOS)';
    }
    return (v.model ? v.model + ':' : '') + v.name;
}

function stopPlayback() {
    if (_player) { _player.pause(); _player = null; }
    if (_playerUrl) { URL.revokeObjectURL(_playerUrl); _playerUrl = null; }
    for (const b of document.querySelectorAll('.vc-play.playing')) {
        b.classList.remove('playing');
        b.textContent = b.dataset.en || '▶';
    }
}

const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKw'
    + 'AAIJsAABEqAAsbm90ZWFkAAAA';
/* Browsers tie autoplay permission to the CLICKING gesture, and TTS
   synthesis (multi-second) outlives it — calling play() AFTER the blob
   arrives fails with 'user didn't interact' (live QA, real-sounding but
   synthetic clicks). The standard fix: unlock the element with a silent
   one-frame WAV DURING the click, swap the real src in later — the
   unlocked element keeps its right to play. */
function newPlayer(btn) {
    stopPlayback();
    _player = new Audio(SILENT_WAV);
    _player._vcBtn = btn;
    _player.onended = () => { if (btn) btn.classList.remove('playing'); };
    if (btn) btn.classList.add('playing');
    const p = _player.play();
    if (p && p.catch) p.catch(() => {});    // unlock attempt; swap follows
    return _player;
}
function playInto(player, blob) {
    if (!player || player !== _player) return player;   // superseded/stopped
    if (_playerUrl) URL.revokeObjectURL(_playerUrl);
    _playerUrl = URL.createObjectURL(blob);
    player.src = _playerUrl;
    // the silent unlock frame fires 'ended' instantly and clears the
    // highlight — re-arm it alongside the real playback
    const btn = player._vcBtn;
    if (btn) btn.classList.add('playing');
    const p = player.play();
    if (p && p.catch) p.catch(e => D.toast(String(e && e.message || e), 'error'));
    return player;
}
async function playBlob(resp, btn) {
    const player = newPlayer(btn);
    const blob = await resp.blob();
    return playInto(player, blob);
}

/* speech POST returns raw audio BYTES (JSON only on error) — no domkit
   JSON helper fits; D.postJson would choke trying to parse the WAV. */
// Engine-side watchdog (mruu incident 2026-10-11): an STT load that
// dies inside the engine pool can strand the REQUEST forever — no
// response, no error — leaving AUTO-TRANSCRIBE stuck on 'transcribing…'
// while the whole board rots behind the pool lock. The client cannot
// heal a wedged server, but it must never lie about it: after
// VOICE_TIMEOUT_S every voice synth/transcribe call is abandoned with
// an honest toast. Cold model loads are legitimately slow, so the
// budget bounds a HANG, not a busy server.
const VOICE_TIMEOUT_S = 240;

function voiceSignal() {
    // AbortSignal.timeout: Safari 16+/Chrome 103+ (app's existing fetch
    // floor); guarded so an older engine degrades to no-watchdog, not
    // no-feature.
    return (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
        ? AbortSignal.timeout(VOICE_TIMEOUT_S * 1000) : undefined;
}
function voiceErrText(e) {
    // fetch rejects a timeout with DOMException TimeoutError (name) —
    // translate it, pass anything else through unchanged
    const nm = String((e && (e.name || e.message)) || e);
    return /TimeoutError/.test(nm)
        ? tf('uplift.voices.timeout',
            'the server did not answer in {n}s — model load may be stuck; '
            + 'request abandoned (restart the server to clear it)',
            { n: VOICE_TIMEOUT_S })
        : String((e && e.message) || e);
}
async function voiceFetch(path, body) {
    // the ONLY voice POST path (binary + JSON responses share the watchdog)
    let r;
    try {
        r = await fetch(`${VAPI}${path}`, {  // domkit-exempt: binary audio
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: voiceSignal(), body: JSON.stringify(body) });
    } catch (e) { throw new Error(voiceErrText(e)); }
    if (!r.ok) {
        let msg = r.statusText;
        try { msg = C.errorText(await r.json()) || msg; } catch (_) {}
        throw new Error(msg);
    }
    return r;
}

async function speechJson(path, body) { return voiceFetch(path, body); }

async function transcribeClip(model, audioB64, name) {
    const r = await voiceFetch('/voices/transcribe',
        { model: model, ref_audio_b64: audioB64, ref_name: name });
    return r.json();
}

function readFileB64(file) {
    return new Promise((res, rej) => {
        if (file.size > MAX_BYTES)
            return rej(new Error(tf('uplift.voices.too_large',
                'reference audio exceeds 14 MiB')));
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1] || '');
        fr.onerror = () => rej(new Error('read failed'));
        fr.readAsDataURL(file);
    });
}

/* VOICE-5/6/7: per-checkpoint capabilities from the SERVER (it reads the
   model's config.json — the honest source for language/speaker tables;
   the UI must not guess them from model names). Fetched once per model id
   (static metadata, safe to cache for the page lifetime). Non-Qwen3-TTS
   engines answer qwen3:false and the language/speaker/instruct fields
   stay SILENT — those controls are Qwen3-TTS specific (user doctrine). */
const _capsCache = {};        // model -> resolved capabilities (page lifetime)
const _capsPending = {};      // model -> the in-flight promise ONLY
function capsFor(model) {
    if (!model) return Promise.resolve(null);
    // VOICE-9 fix (found by tests/voice-record.test.cjs): the promise used to
    // be stored IN _capsCache and then overwritten by its resolved value, so
    // the SECOND voiceForm for the same model (i.e. every SAVE/DELETE
    // re-render) handed back a plain object and probeModel died on
    // 'capsFor(...).then is not a function' — the Qwen3 fields never
    // appeared again. Cache the value and the promise separately; the
    // contract is always a Promise.
    if (_owns(_capsCache, model)) return Promise.resolve(_capsCache[model]);
    if (!_capsPending[model]) {
        _capsPending[model] = D.fetchJson(
            `${VAPI}/voices/capabilities?model=${encodeURIComponent(model)}`)
            .then(c => { _capsCache[model] = c; delete _capsPending[model]; return c; })
            .catch(() => { delete _capsPending[model]; return null; });
    }
    return _capsPending[model];
}
window.Uplift = window.Uplift || {};
window.Uplift.capsFor = capsFor;   // VOICE-8 (design flow) reuses the probe

/* ---- VOICE-9: record the reference clip IN the board -------------------
   A clone needs a clip AND the exact words in it. Uploading a file gets a
   clip; holding the microphone to the machine gets a clip AND — because the
   user was reading a sample text we supplied — a transcript known by
   construction, which beats an STT guess. Everything mic-related is
   CAPABILITY-GATED (doctrine): a browser without MediaRecorder/getUserMedia/
   AudioContext gets not one extra node (silent absence, same rule as the
   Qwen3 fields); an insecure origin (the board is normally served over
   http://LAN-ip, where browsers refuse getUserMedia) gets a DISABLED button
   whose title states the reason and the workaround. The WAV encoder and the
   language resolver are pure and exported under Uplift.voices._rec so node
   tests drive them without an AudioContext. */
const MIN_SECONDS = 3;      // below this the clip is not a usable clone
const MAX_SECONDS = 90;     // auto-stop: longer clips only cost VRAM per synth
const REC_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

/* Read-aloud samples: 10-20 s, phonetically varied, deliberately NOT the
   sterile 'This is a test' — cs opens with the classic all-letters pangram.
   The SAME scene (rainbow + old teacher walking by the river) in every
   language, so switching language reads the same thing. Arbitrary text stays
   possible: this only fills an editable textarea. */
const SUGGEST = {
    en: 'When the sunlight strikes raindrops in the air, they act like a '
        + 'prism and form a rainbow. The rainbow is a division of white '
        + 'light into many beautiful colors. Last autumn our old English '
        + 'teacher walked along a narrow path beside the river, quietly '
        + 'talking about strange ideas and forgotten songs.',
    cs: 'Příliš žluťoučký kůň úpěl ďábelské ódy. Když slunce svítí na '
        + 'kapky deště, lámou světlo a na obloze se objeví duha. Minulý '
        + 'podzim náš starý učitel kráčel úzkou cestičkou podél řeky a '
        + 'tiše vyprávěl o divných nápadech a zapomenutých písních.',
    de: 'Wenn die Sonne auf die Regentropfen scheint, bricht sich das '
        + 'Licht und am Himmel erscheint ein Regenbogen. Letzte Woche '
        + 'fuhr der alte Förster mit seinem braunen Hund quer durch das '
        + 'verschneite Tal und sang dabei leise ein vertrautes Lied.',
    es: 'Cuando la luz del sol atraviesa las gotas de lluvia, se '
        + 'descompone en muchos colores y forma un arcoíris. La semana '
        + 'pasada el viejo profesor paseó un perro flaco junto al río, '
        + 'hablando en voz baja de historias raras y canciones antiguas.',
    fr: 'Quand la lumière du soleil traverse les gouttes de pluie, elle '
        + 'se décompose en mille couleurs et forme un arc-en-ciel. La '
        + 'semaine dernière, le vieux professeur du village se promenait '
        + 'au bord de la rivière en chantant doucement de vieilles chansons.',
    it: 'Quando la luce del sole attraversa le gocce di pioggia, si '
        + 'scompone in tanti colori e forma un arcobaleno. La settimana '
        + 'scorsa il vecchio professore passeggiava lungo il fiume con un '
        + 'cane magro, cantando piano vecchie canzoni.',
    pt: 'Quando a luz do sol atravessa as gotas de chuva, ela se decompõe '
        + 'em muitas cores e forma um arco-íris. Na semana passada, o '
        + 'velho professor caminhava à beira do rio com um cão magro, '
        + 'cantando baixinho antigas canções.',
    ru: 'Когда солнечный свет проходит сквозь капли дождя, он распадается '
        + 'на множество цветов и рождает радугу. На прошлой неделе старый '
        + 'учитель гулял вдоль быстрой реки с худым серым псом и тихо '
        + 'напевал забытые песни.',
    ja: '雨上がりの空に、七色の虹がゆったりとかかりました。先週の金曜日、'
        + '古い先生のそばで痩せた犬が川沿いを歩きながら、昔の歌を静かに'
        + '口ずさんでいました。',
    zh: '雨停以后，太阳的光穿过空中的水滴，折射出一道美丽的彩虹。上星期'
        + '五，年迈的老师带着一只瘦瘦的黄狗，沿着安静的河边慢慢散步，嘴'
        + '里轻轻哼着古老的歌。',
    ko: '비가 그친 뒤 햇빛이 물방울을 통과하면 무지개가 뜹니다. 지난 금요'
        + '일에 늙은 선생님은 마른 개 한 마리를 데리고 조용한 강가를 걸으'
        + '며 옛 노래를 나직이 흥얼거렸습니다.',
};
/* The Language combobox holds free text (server-declared names, 'czech',
   whatever the user typed). Map the names a human or a model card actually
   uses — English name, native name (accented AND ascii-folded spellings,
   because nothing here strips diacritics), ISO code — onto a SUGGEST code. */
const LANG_ALIAS = {
    en: ['english', 'angle', 'en'],
    cs: ['czech', 'cetina', 'čeština', 'cesky', 'česky', 'cs'],
    de: ['german', 'deutsch', 'de'],
    es: ['spanish', 'espanol', 'español', 'es'],
    fr: ['french', 'francais', 'français', 'fr'],
    it: ['italian', 'italiano', 'it'],
    pt: ['portuguese', 'portugues', 'português', 'pt-br', 'pt'],
    ru: ['russian', 'rossijskiy', 'русский', 'ru'],
    ja: ['japanese', 'nihongo', '日本語', 'ja'],
    zh: ['chinese', 'mandarin', '中文', '普通话', 'zh-cn', 'zh-tw', 'zh'],
    ko: ['korean', 'hangugeo', '한국어', 'ko'],
};
const _langTo = Object.create(null);   // null-proto: 'constructor' is not a language
for (const _c in LANG_ALIAS) {
    for (const _a of LANG_ALIAS[_c]) _langTo[String(_a).toLowerCase()] = _c;
}
const _owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* normLang: raw = whatever the Language field says, uiLang = the board's own
   locale. Empty raw → derive from uiLang (pt-BR → pt, zh-TW → zh, else the
   first two letters); unknown raw or unknown locale → 'en' (honest default,
   never a crash and never an empty textarea). */
function normLang(raw, uiLang) {
    const key = String(raw == null ? '' : raw).trim().toLowerCase();
    if (key) {
        if (_owns(SUGGEST, key)) return key;
        if (Object.prototype.hasOwnProperty.call(_langTo, key)) return _langTo[key];
        const leg = key.split(/[-_]/)[0];        // 'pt-br' → 'pt'
        if (_owns(SUGGEST, leg)) return leg;
        if (Object.prototype.hasOwnProperty.call(_langTo, leg)) return _langTo[leg];
        return 'en';
    }
    const ui = String(uiLang == null ? '' : uiLang).trim().toLowerCase();
    if (_owns(SUGGEST, ui)) return ui;
    const base = ui.split(/[-_]/)[0];
    if (_owns(SUGGEST, base)) return base;
    if (Object.prototype.hasOwnProperty.call(_langTo, base)) return _langTo[base];
    const two = base.slice(0, 2);
    if (_owns(SUGGEST, two)) return two;
    return 'en';
}
function promptFor(raw, uiLang) { return SUGGEST[normLang(raw, uiLang)]; }

function currentUiLang() {
    try {
        return (C.getLocale && C.getLocale().lang)
            || (document.documentElement && document.documentElement.lang)
            || 'en';
    } catch (e) { return 'en'; }
}

/* pcmToWavMono: the ONLY encoder here — pure, so the container bytes are
   node-testable. The engine takes ref_audio as WAV/MP3/FLAC and mic capture
   hands back webm/mp4-opus, so the browser decodes and we re-pack: 44-byte
   canonical header, PCM (1), mono, 16-bit little-endian, clamped samples. */
function pcmToWavMono(samples, sampleRate) {
    const n = (samples && samples.length) || 0;
    const rate = Math.round(Number(sampleRate) || 0) || 24000;
    const bytes = n * 2;
    const out = new Uint8Array(44 + bytes);
    const dv = new DataView(out.buffer);
    const str = (off, s) => {
        for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);                       // PCM
    dv.setUint16(22, 1, true);                       // mono
    dv.setUint32(24, rate, true);                    // sampleRate
    dv.setUint32(28, rate * 2, true);                // byteRate
    dv.setUint16(32, 2, true);                       // blockAlign
    dv.setUint16(34, 16, true);                      // bits
    str(36, 'data'); dv.setUint32(40, bytes, true);
    for (let i = 0; i < n; i++) {
        let v = Number(samples[i]);
        if (!isFinite(v)) v = 0;
        v = v < -1 ? -1 : (v > 1 ? 1 : v);
        dv.setInt16(44 + i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
    }
    return out;
}

// recorder capability (see the gate doctrine at the top of this block)
function recCapability() {
    let nav = {};
    try { nav = (typeof navigator !== 'undefined' && navigator) || {}; }
    catch (e) { nav = {}; }
    const has = !!(window.MediaRecorder && nav.mediaDevices
        && nav.mediaDevices.getUserMedia
        && (window.AudioContext || window.webkitAudioContext));
    // 'dev' keeps mediaDevices as the receiver — getUserMedia is a method of
    // mediaDevices (Chrome throws 'Illegal invocation' on a detached call)
    return { has: has, secure: !!window.isSecureContext, dev: nav.mediaDevices };
}
function recPickMime() {
    for (const m of REC_MIMES) {
        try {
            if (window.MediaRecorder.isTypeSupported
                && window.MediaRecorder.isTypeSupported(m)) return m;
        } catch (e) { /* a lying engine: try the next candidate */ }
    }
    return '';        // '' → MediaRecorder's own default container
}
/* One AudioContext for the page: browsers cap the live count (and Safari
   counts a leaked one forever), so decode never builds a fresh context per
   recording. Created lazily — an AudioContext must not exist before the
   user actually records. */
let _recAC = null;
function recAudioCtx() {
    if (!_recAC) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) _recAC = new AC();
    }
    return _recAC;
}
function recToMono(buf) {
    const n = (buf && buf.length) | 0;
    const ch = Math.max(1, (buf && buf.numberOfChannels) || 1);
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
        const d = (buf.getChannelData && buf.getChannelData(c)) || [];
        for (let i = 0; i < n; i++) out[i] += Number(d[i]) || 0;
    }
    if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;   // mean, no clipping
    return out;
}
function recStopTracks(stream) {
    // every exit path runs this: a live mic track is a recording light the
    // user cannot turn off
    if (!stream || !stream.getTracks) return;
    try { stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); }
    catch (e) {}
}
function recErrText(e) { return String((e && e.message) || (e && e.name) || e || ''); }

function voiceRow(v) {
    const row = document.createElement('div');
    row.className = 'urow vc-row';
    const lab = document.createElement('div');
    lab.className = 'vc-name';
    lab.textContent = voiceLabel(v);
    const sub = document.createElement('div');
    sub.className = 'vc-sub';
    // fmtBytes floors at MiB — reference clips are ~100 KB and would all
    // read '0 MiB'; show KiB under a MiB, MiB above (user size-honesty)
    const size = v.ref_bytes ? (v.ref_bytes < 1048576
        ? Math.round(v.ref_bytes / 1024) + ' KiB' : C.fmtBytes(v.ref_bytes)) : '—';
    // VOICE-7: a preset-speaker voice carries NO clip — the row says what
    // it actually is instead of the misleading 'clip —'
    sub.textContent = v.speaker
        ? tf('uplift.voices.speaker_tag', 'speaker') + ' ' + v.speaker
        : tf('uplift.voices.clip', 'clip') + ' ' + size;
    sub.title = v.ref_text || '';
    lab.append(sub);
    const act = document.createElement('div');
    act.className = 'vc-actions';
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'se-btn vc-play';
    play.dataset.en = '▶'; play.textContent = '▶';
    play.title = tf('uplift.voices.play', 'Speak a sample with this voice');
    play.onclick = async () => {
        if (play.classList.contains('playing')) return stopPlayback();
        play.disabled = true;
        try {
            const r = await speechJson('/voices/speech', { voice: v.id,
                input: tf('uplift.voices.sample_text',
                          'Hello! This is how I sound.') });
            play.disabled = false;
            await playBlob(r, play);
        } catch (e) {
            play.disabled = false;
            D.toast(String(e && e.message || e), 'error');
        }
    };
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'se-btn';
    edit.textContent = tf('uplift.voices.edit', 'EDIT');
    edit.onclick = () => {
        _editing = v.id;
        window.scrollTo(0, 0);
        renderVoices();
    };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'se-btn danger';
    del.textContent = tf('uplift.voices.delete', 'DELETE');
    del.onclick = async () => {
        // destructive-action rule: name the record in the confirm
        if (!confirm(tf('uplift.voices.delete_confirm', 'Delete voice')
                     + ' "' + v.name + '"? '
                     + tf('uplift.voices.delete_confirm2',
                          'The reference clip is removed too.'))) return;
        try {
            await D.deleteJson(`${VAPI}/voices/${encodeURIComponent(v.id)}`);
            D.toast(tf('uplift.voices.deleted', 'Voice deleted') + ': ' + v.name);
            renderVoices();
        } catch (e) { D.toast(String(e && e.message || e), 'error'); }
    };
    act.append(play, edit, del);
    row.append(lab, act);
    return row;
}

let _editing = null;      // voice id while the form edits an existing one
let _saveAs = null;       // voice id whose clip feeds a SAVE-AS copy

function voiceForm(models, sttSelf) {
    const editing = _editing
        ? _voices.find(x => x.id === _editing) || null : null;
    // modes: null = ADD (new clip), 'edit' = mutate in place,
    // 'saveas' = new voice reusing another voice's clip (the 'clone it
    // onto a different model' flow — no audio re-upload)
    const saveAs = !editing && _saveAs
        ? _voices.find(x => x.id === _saveAs) || null : null;
    const mode = editing ? 'edit' : (saveAs ? 'saveas' : 'add');
    const src = editing || saveAs;
    const box = document.createElement('div');
    box.className = 'mk-box vc-add';
    const head = document.createElement('div');
    head.className = 'mk-title';
    head.textContent = mode === 'edit'
        ? tf('uplift.voices.edit_title', 'EDIT VOICE')
        : tf('uplift.voices.add_title', 'ADD VOICE');
    const hint = document.createElement('div');
    hint.className = 'mk-desc';
    hint.textContent = mode === 'edit'
        ? tf('uplift.voices.edit_hint',
            'Change the model to re-clone the SAME voice elsewhere, edit '
            + 'the transcript, or upload a new reference clip.')
        : mode === 'saveas'
        ? tf('uplift.voices.saveas_hint',
            'Saving creates a NEW voice with the same reference clip — '
            + 'nothing stored is modified.')
        : tf('uplift.voices.add_hint',
            'Upload a short reference clip (a few seconds of clean speech) '
            + 'and type exactly what it says. The TTS model copies that '
            + 'speaking style for any text you send to this voice.');
    const grid = document.createElement('div');
    grid.className = 'vc-grid';
    function field(label, ctl) {
        const f = document.createElement('label');
        f.className = 'vc-field';
        const l = document.createElement('span');
        l.textContent = label; f.append(l, ctl);
        return f;
    }
    const nameI = document.createElement('input');
    nameI.type = 'text'; nameI.placeholder = 'Jake';
    const modelS = document.createElement('select');
    for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id; o.textContent = m.name || m.id; modelS.append(o);
    }
    if (!models.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = tf('uplift.voices.no_tts',
            'no TTS model installed');
        modelS.append(o); modelS.disabled = true;
    }
    // a stored voice's model may not be in the catalog anymore (deleted
    // after download) — keep the select honest by adding it back
    if (src && models.length && !models.some(m => m.id === src.model)) {
        const o = document.createElement('option');
        o.value = src.model; o.textContent = src.model; modelS.append(o);
    }
    const fileI = document.createElement('input');
    fileI.type = 'file'; fileI.accept = AUDIO_EXTS.map(e => '.' + e).join(',');
    if (mode !== 'add') {
        fileI.placeholder = '';
        fileI.title = tf('uplift.voices.clip_keep',
            'leave empty to keep the current clip');
    }
    const refT = document.createElement('textarea');
    refT.rows = 2;
    refT.placeholder = tf('uplift.voices.ref_text_ph',
        'Transcript of the reference clip — exactly what is said in it.');
    if (src) { nameI.value = src.name; modelS.value = src.model;
               refT.value = src.ref_text || ''; }
    if (saveAs) nameI.value = saveAs.name + ' 2';   // a copy, not a clash
    let file = null, b64 = '';
    // hasClip: an uploaded file now, OR a stored clip behind the edit
    const hasClip = () => !!b64 || (mode !== 'add' && !!src && !!src.ref_bytes);
    // VOICE-2: AUTO-TRANSCRIBE = model picker + button beside the field.
    // Whisper runs locally in seconds; the result only FILLS the textarea
    // — the user confirms it, because the clone quality lives in the
    // transcript matching the clip word-for-word (vanilla rule: ref_text
    // ships on every synth request).
    const sttS = document.createElement('select');
    sttS.className = 'vc-stt-sel';
    const stts = sttModels().length ? sttModels() : (sttSelf || []);
    for (const m of stts) {
        const o = document.createElement('option');
        o.value = m.id; o.textContent = m.name || m.id; sttS.append(o);
    }
    if (!stts.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = tf('uplift.voices.no_stt',
            'no STT model installed');
        sttS.append(o); sttS.disabled = true;
    }
    const trB = document.createElement('button');
    trB.type = 'button'; trB.className = 'se-btn';
    trB.textContent = tf('uplift.voices.transcribe', 'AUTO-TRANSCRIBE');
    trB.title = tf('uplift.voices.transcribe_title',
        'Transcribe the selected clip with a local speech-to-text model; '
        + 'check the result — the transcript must match the clip exactly.');
    fileI.onchange = async () => {
        file = fileI.files && fileI.files[0]; b64 = '';
        if (!file) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (AUDIO_EXTS.indexOf(ext) < 0) {
            D.toast(tf('uplift.voices.bad_ext',
                'Reference audio must be WAV, MP3 or FLAC'), 'error');
            file = null; fileI.value = ''; return;
        }
        try { b64 = await readFileB64(file); }
        catch (e) { D.toast(String(e && e.message || e), 'error');
                    file = null; fileI.value = ''; }
        // a fresh clip invalidates a previous auto-transcription guess
        trB.disabled = !b64 || !sttS.value;
    };
    trB.disabled = true;
    trB.onclick = async () => {
        if (!file || !b64) return D.toast(
            tf('uplift.voices.need_clip', 'pick a reference clip first'), 'error');
        if (!sttS.value) return D.toast(
            tf('uplift.voices.need_stt', 'pick an STT model first'), 'error');
        trB.disabled = true;
        const old = trB.textContent;
        trB.textContent = tf('uplift.voices.transcribing', 'transcribing…');
        try {
            const d = await transcribeClip(sttS.value, b64, file.name);
            const txt = String(d && d.text || '').trim();
            if (!txt) throw new Error(tf('uplift.voices.transcribe_empty',
                'the model heard no speech'));
            refT.value = txt;
            D.toast(tf('uplift.voices.transcribed', 'Transcript filled — review it') );
        } catch (e) { D.toast(String(e && e.message || e), 'error'); }
        trB.textContent = old;
        trB.disabled = !b64 || !sttS.value;
    };
    sttS.onchange = () => { trB.disabled = !b64 || !sttS.value; };
    const refWrap = document.createElement('div');
    refWrap.className = 'vc-refwrap';
    refWrap.append(refT);
    const trRow = document.createElement('div');
    trRow.className = 'vc-trrow';
    if (stts.length) trRow.append(sttS, trB);
    else trRow.append(trB);      // honest: button visible, picker says why not
    refWrap.append(trRow);
    grid.append(
        field(tf('uplift.voices.name', 'Voice name'), nameI),
        field(tf('uplift.voices.model', 'TTS model'), modelS));
    // ---- VOICE-5/6/7: Qwen3-TTS extras, gated by the server capability
    // probe. Hidden for engines without the data (silent-absence doctrine
    // — these fields are Qwen3-TTS specific per the user). Reveal order =
    // build order; the probes answer async and applyCaps() toggles.
    // U-LANG (user 2026-10-12): editable combobox — pick one of the
    // model's declared languages or type any other language string;
    // empty = Auto (the model adapts to the text). Czech ships in the
    // list by request; Qwen3-TTS tables do not list it, the engine maps
    // free-text language names best-effort.
    const langDL = document.createElement('datalist');
    langDL.id = 'vc-lang-dl';
    const langS = document.createElement('input');
    langS.type = 'text';
    langS.setAttribute('list', 'vc-lang-dl');
    langS.autocomplete = 'off';
    langS.placeholder = tf('uplift.voices.lang_auto', 'Auto (adaptive)');
    langS.title = tf('uplift.voices.language_title',
        'Force the output language, or Auto to let the model adapt to the text.');
    const langVal = () => (langS.value || '').trim().toLowerCase();
    const spkS = document.createElement('select');
    spkS.title = tf('uplift.voices.speaker_title',
        'Preset speaker of this CustomVoice model — no reference clip needed. '
        + 'Each speaker is strongest in its native language.');
    const instrT = document.createElement('textarea');
    instrT.rows = 2;
    instrT.placeholder = tf('uplift.voices.instruct_ph',
        'e.g. Very happy. — tone, emotion, speaking rate in plain words');
    instrT.title = tf('uplift.voices.instruct_title',
        'Style instruction (Qwen3-TTS CustomVoice/VoiceDesign): natural-language '
        + 'control over tone, emotion and speaking rate. Empty = neutral.');
    const langCtl = document.createElement('div');
    langCtl.append(langS, langDL);
    const langF = field(tf('uplift.voices.language', 'Language'), langCtl);
    const spkF = field(tf('uplift.voices.speaker', 'Speaker'), spkS);
    const instrF = field(tf('uplift.voices.instruct', 'Instruct'), instrT);
    const clipF = field(tf('uplift.voices.clip_file', 'Reference clip'), fileI);
    /* ---- VOICE-9a: 'use suggested text' (never capability-gated — plain
       text, works everywhere, and a clip typed by hand stays possible) ---- */
    const promptRow = document.createElement('div');
    promptRow.className = 'vc-trrow';
    const promptB = document.createElement('button');
    promptB.type = 'button'; promptB.className = 'se-btn';
    promptB.textContent = tf('uplift.voices.prompt_insert', 'use suggested text');
    promptB.title = tf('uplift.voices.prompt_title',
        'Fills the transcript with a sample text for the selected language. '
        + 'Read it aloud while recording; edit it freely afterwards.');
    promptB.onclick = () => {
        // REPLACES the text (the sample is meant to be read verbatim) and
        // the textarea stays editable — arbitrary text is never locked out
        refT.value = promptFor(langS.value, currentUiLang());
    };
    promptRow.append(promptB);
    refWrap.insertBefore(promptRow, trRow);
    /* ---- VOICE-9b: the recorder, capability-gated (see doctrine at the
       top of the VOICE-9 block): no MediaRecorder/getUserMedia/AudioContext
       → build NOTHING (zero DOM delta, like the silent Qwen3 fields). ---- */
    const REC = recCapability();
    if (REC.has) {
        let recBlob = null, recUrl = null, recAudio = null;   // local preview
        let recState = 'idle';   // idle|starting|recording|decoding = lock
        let recTimer = null, recT0 = 0, recMR = null, recStream = null;
        let recChunks = null, recAuto = 0;
        const recRow = document.createElement('div');
        recRow.className = 'vc-trrow';
        const recB = document.createElement('button');
        recB.type = 'button'; recB.className = 'se-btn';
        recB.textContent = tf('uplift.voices.record', 'RECORD');
        const recSt = document.createElement('span');
        recSt.className = 'native-stub-note';
        recSt.hidden = true;                    // silent until something happens
        const recPlay = document.createElement('button');
        recPlay.type = 'button'; recPlay.className = 'se-btn';
        recPlay.textContent = '▶'; recPlay.hidden = true;
        recPlay.title = tf('uplift.voices.record_listen', 'play back');
        const recClear = document.createElement('button');
        recClear.type = 'button'; recClear.className = 'se-btn';
        recClear.textContent = '✕'; recClear.hidden = true;
        recClear.title = tf('uplift.voices.record_clear', 'clear');
        recRow.append(recB, recSt, recPlay, recClear);
        // INSIDE the clip field: voice_design hides clipF and the recorder
        // disappears with it — no second hiding rule to forget
        clipF.append(recRow);
        if (!REC.secure) {
            // http://LAN-ip: browsers refuse the mic here. Render the button
            // DISABLED with the reason (capability-gate doctrine: never a
            // control that fails silently on click, never a fake one either).
            recB.disabled = true;
            recB.title = tf('uplift.voices.record_insecure',
                'The browser only allows microphone capture on https or '
                + 'localhost — open the dashboard through a localhost tunnel, '
                + 'or upload a saved audio file.');
        } else {
            recB.title = tf('uplift.voices.record_title',
                'Record a reference clip right here — read the suggested text '
                + 'aloud for 10-30 s in a quiet room.');
            recB.onclick = () => (recState === 'recording' ? recStop() : recStart());
        }
        const recSecs = () => Math.max(0, (Date.now() - recT0) / 1000);
        const recLabel = (txt) => { recB.textContent = txt; };
        /* the preview player is LOCAL on purpose: the module _player owns
           server-synth playback (stopPlayback/playInto) and mixing a mic
           preview into that machinery would let a row's PLAY kill a take. */
        const recDropPreview = () => {
            if (recAudio) { try { recAudio.pause(); } catch (e) {} recAudio = null; }
            if (recUrl) { URL.revokeObjectURL(recUrl); recUrl = null; }
            recPlay.textContent = '▶';
            recPlay.classList.remove('playing');
        };
        const recIdle = () => {
            if (recTimer) { clearInterval(recTimer); recTimer = null; }
            recState = 'idle';
            recLabel(tf('uplift.voices.record', 'RECORD'));
            recB.disabled = false;
            recSt.hidden = true;
            recSt.textContent = '';
        };
        const recTick = () => {
            const n = Math.floor(recSecs());
            recSt.textContent = tf('uplift.voices.recording', 'recording… {n}s')
                .replace('{n}', String(n));
            if (n >= MAX_SECONDS && !recAuto) {
                recAuto = n;                    // one toast, then stop
                D.toast(tf('uplift.voices.record_max',
                    'Recording auto-stopped at {n} s').replace('{n}', String(n)));
                recStop();
            }
        };
        const recStop = () => {
            if (recState !== 'recording') return;
            recState = 'decoding';              // re-entry lock for the decode
            if (recTimer) { clearInterval(recTimer); recTimer = null; }
            recB.disabled = true;
            recSt.hidden = false;
            recSt.textContent = tf('uplift.voices.record_decode', 'processing…');
            try { recMR.stop(); }               // onstop → recFinish
            catch (e) {
                recStopTracks(recStream);
                D.toast(tf('uplift.voices.record_failed', 'Recording failed')
                        + ': ' + recErrText(e), 'error');
                recStream = null; recMR = null; recChunks = null; recAuto = 0;
                recIdle();
            }
        };
        const recFinish = async () => {
            const chunks = recChunks || [];
            const stream = recStream;           // released in EVERY exit path
            const secs = recAuto || recSecs();
            recMR = null; recChunks = null; recStream = null; recAuto = 0;
            try {
                recState = 'decoding';
                if (recTimer) { clearInterval(recTimer); recTimer = null; }
                recB.disabled = true;
                recSt.hidden = false;
                recSt.textContent = tf('uplift.voices.record_decode', 'processing…');
                recDropPreview();               // the old take is gone now
                if (!chunks.length) {
                    file = null; b64 = '';
                    trB.disabled = !b64 || !sttS.value;
                    throw new Error(tf('uplift.voices.record_failed',
                        'Recording failed'));
                }
                const raw = new Blob(chunks,
                    { type: (chunks[0] && chunks[0].type) || 'audio/webm' });
                const ac = recAudioCtx();
                const dec = ac && ac.decodeAudioData
                    ? await ac.decodeAudioData(await raw.arrayBuffer()) : null;
                if (!dec) throw new Error(tf('uplift.voices.record_failed',
                    'Recording failed'));
                const rate = dec.sampleRate || 48000;
                const heard = Number(dec.duration)
                    || ((dec.length || 0) / rate) || secs;
                if (heard < MIN_SECONDS) {
                    // honest refusal: a 1 s cough is not a voice clone
                    file = null; b64 = '';
                    trB.disabled = !b64 || !sttS.value;
                    D.toast(tf('uplift.voices.record_short',
                        'Only {n} s recorded — too short for a good clone')
                        .replace('{n}', String(Math.round(heard))), 'error');
                    recPlay.hidden = recClear.hidden = true;
                    recBlob = null;
                    return;
                }
                const wav = new Blob([pcmToWavMono(recToMono(dec), rate)],
                    { type: 'audio/wav' });
                recBlob = wav;
                file = new File([wav], 'recording.wav', { type: 'audio/wav' });
                b64 = await readFileB64(file);      // 14 MiB cap lives there
                fileI.value = '';                   // inputs never disagree
                trB.disabled = !b64 || !sttS.value; // exactly the upload rule
                if (!refT.value)
                    // they just READ the sample: the transcript is known
                    // exactly — better ground truth than an STT guess, and
                    // a non-empty transcript is never overwritten
                    refT.value = promptFor(langS.value, currentUiLang());
                recPlay.hidden = false; recClear.hidden = false;
                D.toast(tf('uplift.voices.record_done',
                    'Clip recorded — check the transcript before saving'));
            } catch (e) {
                file = null; b64 = ''; recBlob = null;
                trB.disabled = !b64 || !sttS.value;
                recPlay.hidden = recClear.hidden = true;
                D.toast(tf('uplift.voices.record_failed', 'Recording failed')
                        + ': ' + recErrText(e), 'error');
            } finally {
                recStopTracks(stream);
                recIdle();
            }
        };
        const recStart = async () => {
            if (recState !== 'idle') return;    // one gesture at a time
            recState = 'starting';
            recB.disabled = true;
            recSt.hidden = false;
            recSt.textContent = tf('uplift.voices.record_decode', 'processing…');
            let stream = null;
            try {
                stream = await REC.dev.getUserMedia({ audio: {
                    echoCancellation: true, noiseSuppression: true } });
                recStream = stream;
                const mt = recPickMime();
                recMR = mt ? new window.MediaRecorder(stream, { mimeType: mt })
                           : new window.MediaRecorder(stream);
                recChunks = [];
                recAuto = 0;
                recMR.ondataavailable = ev => {
                    if (ev && ev.data && ev.data.size) recChunks.push(ev.data);
                };
                recMR.onstop = () => { recFinish(); };
                recMR.onerror = () => {
                    recStopTracks(recStream);
                    D.toast(tf('uplift.voices.record_failed', 'Recording failed'),
                        'error');
                    recIdle();
                };
                recMR.start();
                recT0 = Date.now();
                recState = 'recording';
                recB.disabled = false;          // it is the STOP button now
                recLabel(tf('uplift.voices.record_stop', 'STOP'));
                recSt.textContent = tf('uplift.voices.recording', 'recording… {n}s')
                    .replace('{n}', '0');
                recTimer = setInterval(recTick, 200);
            } catch (e) {
                recStopTracks(stream);
                recStopTracks(recStream);
                recStream = null; recMR = null; recChunks = null;
                const denied = e && e.name === 'NotAllowedError';
                D.toast(denied
                    ? tf('uplift.voices.record_denied',
                        'Microphone access was denied')
                    : tf('uplift.voices.record_failed', 'Recording failed')
                        + ': ' + recErrText(e), 'error');
                recIdle();
            }
        };
        recPlay.onclick = () => {
            if (!recBlob) return;
            if (recAudio && recPlay.classList.contains('playing')) {
                recDropPreview(); return;
            }
            recDropPreview();
            recUrl = URL.createObjectURL(recBlob);
            const a = new Audio(recUrl);
            recAudio = a;
            a.onended = () => { if (recAudio === a) recDropPreview(); };
            a.onerror = () => { if (recAudio === a) recDropPreview(); };
            recPlay.textContent = '■';
            recPlay.classList.add('playing');   // user gesture: never autoplay
            const p = a.play && a.play();
            if (p && p.catch) p.catch(() => recDropPreview());
        };
        recClear.onclick = () => {
            recDropPreview();
            recBlob = null;
            file = null; b64 = '';              // the clip is gone
            trB.disabled = !b64 || !sttS.value;
            recPlay.hidden = recClear.hidden = true;
            recSt.hidden = true;
            // refT stays: they may still type (or keep the sample) by hand
        };
    }
    const refF = field(tf('uplift.voices.ref_text', 'Reference text'), refWrap);
    for (const f of [langF, spkF, instrF]) { f.hidden = true; grid.append(f); }
    grid.append(clipF, refF);
    let caps = null;
    const fillSel = (sel, items, firstLabel) => {
        sel.textContent = '';
        if (firstLabel !== null) {
            const o = document.createElement('option');
            o.value = ''; o.textContent = firstLabel; sel.append(o);
        }
        for (const it of items) {
            const o = document.createElement('option');
            o.value = it; o.textContent = it; sel.append(o);
        }
    };
    const fillDL = (dl, items) => {
        dl.textContent = '';
        for (const it of items) {
            const o = document.createElement('option');
            o.value = it; dl.append(o);
        }
    };
    const applyCaps = c => {
        caps = c;
        const q3 = !!(c && c.qwen3);
        if (!q3) {
            // foreign engine / unknown: the classic clone form, extras SILENT
            langF.hidden = spkF.hidden = instrF.hidden = true;
            clipF.hidden = refF.hidden = false;
            return;
        }
        // U-LANG: datalist = model's declared languages + Czech (explicit
        // request); the combobox accepts ANY other language string typed in
        const lset = (c.languages || []).filter(l => l !== 'auto');
        if (lset.indexOf('czech') < 0) lset.push('czech');
        fillDL(langDL, lset);
        langS.value = (src && src.language) || '';
        langF.hidden = false;
        if (c.type === 'custom_voice' && (c.speakers || []).length) {
            fillSel(spkS, c.speakers,
                tf('uplift.voices.spk_clone', '— clone from the reference clip —'));
            spkS.value = (src && src.speaker) || '';
            spkF.hidden = false;
        } else spkF.hidden = true;
        // base checkpoints ignore instruct (model card) — field hidden there
        instrF.hidden = c.type === 'base';
        if (src && src.instructions) instrT.value = src.instructions;
        // VoiceDesign: the description IS the voice — no clip, no transcript
        clipF.hidden = refF.hidden = (c.type === 'voice_design');
        if (c.type === 'voice_design' && !instrT.value && src && src.ref_text)
            instrT.value = src.ref_text;   // (defensive: design voices store none)
    };
    const probeModel = () => { capsFor(modelS.value).then(applyCaps); };
    modelS.onchange = probeModel;
    probeModel();
    const acts = document.createElement('div');
    acts.className = 'vc-acts';
    const prevB = document.createElement('button');
    prevB.type = 'button'; prevB.className = 'se-btn';
    prevB.textContent = tf('uplift.voices.preview', 'PREVIEW');
    prevB.onclick = async () => {
        const design = caps && caps.type === 'voice_design';
        if (!design && !hasClip()) return D.toast(
            tf('uplift.voices.need_clip', 'pick a reference clip first'), 'error');
        if (!design && !refT.value.trim()) return D.toast(
            tf('uplift.voices.need_ref_text', 'type the reference transcript'), 'error');
        if (design && !instrT.value.trim()) return D.toast(
            tf('uplift.voices.need_instruct', 'describe the voice first'), 'error');
        prevB.disabled = true;
        try {
            let r;
            const extras = {};
            if (caps && caps.qwen3) {
                if (langVal()) extras.language = langVal();
                if (!spkF.hidden && spkS.value) extras.speaker = spkS.value;
                if (!instrF.hidden && instrT.value.trim())
                    extras.instructions = instrT.value.trim();
            }
            if (design) {
                // VOICE-8: the design model speaks the sample FROM the
                // description — preview IS the design step
                r = await speechJson('/voices/design', Object.assign({
                    model: modelS.value,
                    input: tf('uplift.voices.sample_text',
                              'Hello! This is how I sound.'),
                    instruct: instrT.value.trim() },
                    langVal() ? { language: langVal() } : {}));
            } else if (b64 || mode === 'add') {
                r = await speechJson('/voices/preview', Object.assign({
                    model: modelS.value, ref_audio_b64: b64,
                    ref_name: (file && file.name) || 'r.wav',
                    ref_text: refT.value.trim(),
                    input: tf('uplift.voices.sample_text',
                              'Hello! This is how I sound.') }, extras));
            } else {
                // edit without a new clip: the STORED clip speaks, the
                // typed transcript overrides at synth time — exactly the
                // sentence SAVE would store (server ref_text override)
                r = await speechJson('/voices/speech', Object.assign({
                    voice: editing.id, model: modelS.value,
                    ref_text: refT.value.trim(),
                    input: tf('uplift.voices.sample_text',
                              'Hello! This is how I sound.') }, extras));
            }
            await playBlob(r, prevB);
        } catch (e) { D.toast(String(e && e.message || e), 'error'); }
        prevB.disabled = false;
    };
    const addB = document.createElement('button');
    addB.type = 'button'; addB.className = 'se-btn savebtn';
    addB.textContent = mode === 'edit'
        ? tf('uplift.voices.save_changes', 'SAVE CHANGES')
        : tf('uplift.voices.save', 'SAVE VOICE');
    addB.onclick = async () => {
        const nm = nameI.value.trim();
        const design = caps && caps.type === 'voice_design';
        const needText = !design && (!refT.value.trim() || !hasClip())
            && !(caps && caps.qwen3 && !spkF.hidden && spkS.value);
        if (!nm || !modelS.value || needText)
            return D.toast(tf('uplift.voices.need_all',
                'name, model, clip and transcript are all required'), 'error');
        if (design && !instrT.value.trim())
            return D.toast(tf('uplift.voices.need_instruct',
                'describe the voice first'), 'error');
        // VOICE-8 (design flow): saving runs the design synth ONCE and
        // stores its WAV as the reference clip — from then on the voice
        // behaves like any uploaded-clip clone, no second model load per
        // speech. The design model must be LOADED (the server answers a
        // clear 400/503 otherwise — surfaced as an error toast).
        const extras = {};
        if (caps && caps.qwen3) {
            if (langVal()) extras.language = langVal();
            if (!spkF.hidden && spkS.value) extras.speaker = spkS.value;
            if (!instrF.hidden && instrT.value.trim())
                extras.instructions = instrT.value.trim();
        }
        addB.disabled = true;
        try {
            if (design) {
                const sample = tf('uplift.voices.sample_text',
                    'Hello! This is how I sound.');
                const blob = await (await speechJson('/voices/design',
                    Object.assign({ model: modelS.value, input: sample,
                                    instruct: instrT.value.trim() },
                        langVal() ? { language: langVal() } : {}))).blob();
                const fr = new FileReader();
                await new Promise((res, rej) => {
                    fr.onload = () => res(); fr.onerror = () => rej(new Error('read failed'));
                    fr.readAsDataURL(blob);
                });
                extras.ref_audio_b64 = String(fr.result).split(',')[1] || '';
                extras.ref_name = 'designed.wav';
                extras.ref_text = sample;      // we AUTHORED the transcript — exact by construction
                extras.designed_from = instrT.value.trim();
                if (mode === 'edit') {
                    await D.putJson(`${VAPI}/voices/${encodeURIComponent(editing.id)}`,
                        Object.assign({ name: nm, model: modelS.value }, extras));
                } else {
                    await D.postJson(`${VAPI}/voices`,
                        Object.assign({ name: nm, model: modelS.value }, extras));
                }
                D.toast(tf('uplift.voices.designed', 'Voice designed and saved') + ': ' + nm);
            } else if (mode === 'edit') {
                const body = Object.assign({ name: nm, model: modelS.value,
                    ref_text: refT.value.trim() }, extras);
                // carry fields the form does not expose when the engine
                // hides them: the server's _sanitize pops whatever a PUT
                // omits — edit must not lose API-set values
                if (!(caps && caps.qwen3)) {
                    if (editing.language) body.language = editing.language;
                    if (editing.speed) body.speed = editing.speed;
                    if (editing.instructions) body.instructions = editing.instructions;
                    if (editing.speaker) body.speaker = editing.speaker;
                }
                if (b64) { body.ref_audio_b64 = b64; body.ref_name = file.name; }
                await D.putJson(`${VAPI}/voices/${encodeURIComponent(editing.id)}`,
                    body);
                D.toast(tf('uplift.voices.saved', 'Voice saved') + ': '
                        + nm + ' (' + modelS.value + ')');
            } else {
                const body = Object.assign({ name: nm, model: modelS.value,
                    ref_text: refT.value.trim() }, extras);
                // a COPY keeps the source's non-rendered fields too
                if (saveAs && !(caps && caps.qwen3)) {
                    if (saveAs.language) body.language = saveAs.language;
                    if (saveAs.speed) body.speed = saveAs.speed;
                    if (saveAs.instructions) body.instructions = saveAs.instructions;
                    if (saveAs.speaker) body.speaker = saveAs.speaker;
                }
                if (b64) { body.ref_audio_b64 = b64; body.ref_name = file.name; }
                else if (saveAs && !body.speaker) body.from_voice = saveAs.id;
                await D.postJson(`${VAPI}/voices`, body);
                D.toast((saveAs
                        ? tf('uplift.voices.saved_as', 'Voice saved as a copy')
                        : tf('uplift.voices.saved', 'Voice saved'))
                        + ': ' + nm + ' (' + modelS.value + ')');
            }
            _editing = null; _saveAs = null;
            renderVoices();
        } catch (e) { D.toast(String(e && e.message || e), 'error'); }
        addB.disabled = false;
    };
    acts.append(prevB, addB);
    if (mode !== 'add') {
        const cx = document.createElement('button');
        cx.type = 'button'; cx.className = 'se-btn';
        cx.textContent = C.tf('uplift.layout.cancel', 'Cancel');
        cx.onclick = () => { _editing = null; _saveAs = null; renderVoices(); };
        acts.append(cx);
    }
    if (!models.length) {
        const link = document.createElement('a');
        link.href = '#models/downloader'; link.className = 'vc-dl';
        link.textContent = tf('uplift.voices.get_tts',
            'Download a TTS model (Qwen3-TTS)…');
        acts.prepend(link);
    }
    box.append(head, hint, grid, acts);
    return box;
}

let _modelsSelf = null;   // self-fetched fallback (see renderVoices)
let _sttSelf = null;
/* ---- SAY-1: the macOS system-voice tab ----------------------------------
   Catalog of the voices the server's `say` binary can actually speak
   (GET /voices/say). SAY-2 replaced the 'USE' button with a per-voice
   star: "Mark preferred for: cs-CZ" records the voice that answers a
   `say` request carrying that language (POST /voices/say/preferred ->
   the store's language map). No pseudo-model voice is created — the
   tab only marks favourites. Explicit selection keeps working at the
   API: 'say:<identifier>' (or the display name) addresses that exact
   voice, 'say:<locale>' routes like a language-carrying request. The
   star rides the row's own language; one voice per language, marking
   a second replaces the first, marking again clears. Ordering is a
   quality promise: within a language the better recordings first
   (Premium > Enhanced > Personal > standard); languages sorted by
   name. The ADDITIONAL chip appears only for voices whose bundle sits
   in the download folders — shown when proven, never guessed. */
const SAY_TIERS = { premium: ['uplift.voices.say_tier_premium', 'PREMIUM', 0],
                    enhanced: ['uplift.voices.say_tier_enhanced', 'ENHANCED', 1],
                    personal: ['uplift.voices.say_tier_personal', 'PERSONAL', 2] };
let _sayData = null;        // last /voices/say payload (per page visit)
let _sayFilter = '';
const SAY_OPEN_KEY = 'uplift.vcSayOpen';    // remembered per-locale folds

function _sayOpenMap() {
    try { return JSON.parse(localStorage.getItem(SAY_OPEN_KEY)) || {}; }
    catch (e) { return {}; }
}
function _sayOpenSet(loc, v) {
    const m = _sayOpenMap();
    m[loc] = !!v;
    try { localStorage.setItem(SAY_OPEN_KEY, JSON.stringify(m)); } catch (e) {}
}

function _langName(locale) {
    try {
        if (!window.Intl || !Intl.DisplayNames) return locale;
        return new Intl.DisplayNames(['en'], { type: 'language' })
            .of(String(locale).split(/[-_]/)[0]) || locale;
    } catch (e) { return locale; }
}

async function _sayReload(rowsBox) {
    // fresh catalogue after a mark/clear: the server owns preferred_for,
    // the client never patches it locally (one truth, one repaint)
    try {
        const d = await D.fetchJson(`${VAPI}/voices/say`);
        if (d && d.supported) _sayData = d;
    } catch (e) { /* keep the stale frame; the rows below repaint anyway */ }
    _sayRows(rowsBox, _sayData.voices || []);
}

function sayRow(v, repaint) {
    const addr = v.identifier || v.name;   // exact OS handle when present
    const inst = v.installed !== false;
    const marked = !!v.preferred_for;
    const row = document.createElement('div');
    row.className = 'vc-row' + (inst ? '' : ' vc-say-off');
    const lab = document.createElement('div');
    lab.className = 'vc-name';
    lab.textContent = v.name;
    const q = SAY_TIERS[v.quality];
    if (q) {
        const c = document.createElement('span');
        c.className = 'vc-chip vc-chip-tier';
        c.textContent = tf(q[0], q[1]);
        lab.append(' ', c);
    }
    if (!inst) {
        // downloadable per Apple's catalogs, absent on this Mac: the
        // engine cannot speak it — no buttons, just the way to get it
        const c = document.createElement('span');
        c.className = 'vc-chip';
        c.textContent = tf('uplift.voices.say_not_downloaded',
                           'NOT DOWNLOADED');
        c.title = tf('uplift.voices.say_not_downloaded_hint',
                     'Not on this Mac yet — download it in System '
                     + 'Settings under Accessibility > Spoken Content > '
                     + 'Voices.');
        lab.append(' ', c);
        row.append(lab);
        return row;
    }
    if (marked) {
        // SAY-2: this voice answers `say` requests for that language
        const c = document.createElement('span');
        c.className = 'vc-chip vc-chip-pref';
        c.textContent = tf('uplift.voices.say_preferred_for',
                           'PREFERRED FOR {locale}')
                        .replace('{locale}', v.preferred_for);
        lab.append(' ', c);
    }
    if (v.downloaded) {
        const c = document.createElement('span');
        c.className = 'vc-chip';
        c.textContent = tf('uplift.voices.say_additional', 'DOWNLOADED');
        c.title = tf('uplift.voices.say_additional_hint',
                     'Installed on this Mac beyond the factory set — downloaded via System Settings.');
        lab.append(' ', c);
    }
    const act = document.createElement('div');
    act.className = 'vc-actions';
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'se-btn vc-play';
    play.dataset.en = '▶'; play.textContent = '▶';
    play.title = tf('uplift.voices.play', 'Speak a sample with this voice');
    play.onclick = async () => {
        if (play.classList.contains('playing')) return stopPlayback();
        play.disabled = true;
        try {
            // no input: the server answers with the voice's own greeting
            const r = await speechJson('/voices/say/speech', { name: addr });
            play.disabled = false;
            await playBlob(r, play);
        } catch (e) {
            play.disabled = false;
            D.toast(String(e && e.message || e), 'error');
        }
    };
    // SAY-2 star: the row's favourite marker for ITS language. Marking
    // replaces the previous voice for that language (one per language);
    // clicking the lit star clears it and the language falls back to its
    // default voice. No stored pseudo-model is created — ever.
    const pref = document.createElement('button');
    pref.type = 'button';
    pref.className = 'se-btn vc-pref' + (marked ? ' on' : '');
    pref.textContent = '★';
    pref.dataset.i18n = marked ? 'uplift.voices.say_unmark'
                               : 'uplift.voices.say_mark';
    pref.title = tf(pref.dataset.i18n,
                    marked ? 'Not preferred for: {locale}'
                           : 'Mark preferred for: {locale}')
                   .replace('{locale}', marked ? v.preferred_for : v.locale);
    pref.onclick = async () => {
        pref.disabled = true;
        try {
            await D.postJson(`${VAPI}/voices/say/preferred`,
                { locale: marked ? v.preferred_for : v.locale,
                  identifier: marked ? '' : addr });
            await repaint();
        } catch (e) {
            pref.disabled = false;
            D.toast(String(e && e.message || e), 'error');
        }
    };
    act.append(play, pref);
    row.append(lab, act);
    return row;
}

function _sayRows(rowsBox, voices) {
    rowsBox.textContent = '';
    const repaint = () => _sayReload(rowsBox);
    const needle = _sayFilter.trim().toLowerCase();
    const match = (v) => !needle
        || v.name.toLowerCase().indexOf(needle) >= 0
        || String(v.locale).toLowerCase().indexOf(needle) >= 0
        || _langName(v.locale).toLowerCase().indexOf(needle) >= 0;
    const groups = {};
    for (const v of voices) {
        if (!match(v)) continue;
        (groups[v.locale] = groups[v.locale] || []).push(v);
    }
    const locs = Object.keys(groups).sort(
        (a, b) => _langName(a).localeCompare(_langName(b)) || a.localeCompare(b));
    const openMap = _sayOpenMap();
    let shown = 0;
    for (const loc of locs) {
        const list = groups[loc];
        // quality promise: the better recording of a voice wins the top
        list.sort((a, b) =>
            ((SAY_TIERS[a.quality] || [0, 0, 3])[2]
                - (SAY_TIERS[b.quality] || [0, 0, 3])[2])
            || a.name.localeCompare(b.name));
        // A filter must SHOW what it matched even inside a folded group;
        // that reveal is display-only — the remembered fold is untouched
        // (nothing writes localStorage here but a user click).
        const grp = document.createElement('div');
        grp.className = 'vc-say-grp';
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'vc-say-head';
        const arrow = document.createElement('span');
        arrow.className = 'vc-say-arrow';
        const lab = document.createElement('span');
        lab.className = 'vc-say-label';
        lab.textContent = _langName(loc) + ' · ' + loc;
        const cnt = document.createElement('span');
        cnt.className = 'vc-say-count';
        const ready = list.filter(v => v.installed !== false).length;
        cnt.textContent = ready === list.length ? String(list.length)
                          : ready + '/' + list.length;
        if (ready !== list.length) {
            cnt.title = tf('uplift.voices.say_count_hint',
                           '{n} speakable now, {t} offered for download '
                           + 'by this macOS').replace('{n}', ready)
                                   .replace('{t}', list.length);
        }
        const paint = (open) => {
            grp.hidden = !open;
            head.classList.toggle('open', open);
            arrow.textContent = open ? '▾' : '▸';
            lab.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        head.append(arrow, lab, cnt);
        head.onclick = () => {
            const now = grp.hidden;         // hidden -> clicking opens
            paint(now);
            _sayOpenSet(loc, now);
        };
        const open = !!needle || openMap[loc] === true;
        for (const v of list) { grp.append(sayRow(v, repaint)); shown++; }
        rowsBox.append(head, grp);
        paint(open);
    }
    if (!shown) {
        const none = document.createElement('div');
        D.emptyMsg(none, tf('uplift.voices.say_nomatch',
                            'No macOS voice matches that filter.'));
        rowsBox.append(none);
    }
}

async function sayPanel(host) {
    const box = document.createElement('div');
    box.className = 'mk-box vc-say';
    const title = document.createElement('div');
    title.className = 'mk-title';
    title.textContent = tf('uplift.voices.say_title', 'macOS SYSTEM VOICES');
    const hint = document.createElement('div');
    hint.className = 'mk-desc';
    hint.textContent = tf('uplift.voices.say_hint',
        'Every voice this macOS offers. Installed voices speak instantly '
        + '— no model to load; greyed rows need a download '
        + 'first in System Settings under Accessibility > Spoken Content '
        + '> Voices. ★ marks the voice that answers `say` requests in '
        + 'that language; requests can also name a voice (say:<voice>) '
        + 'or a language (say:<locale>) explicitly.');
    box.append(title, hint);
    host.append(box);
    if (!_sayData) {
        const load = document.createElement('div');
        load.className = 'mk-desc';
        load.textContent = tf('uplift.voices.say_loading', 'Reading voices…');
        box.append(load);
        try {
            _sayData = await D.fetchJson(`${VAPI}/voices/say`);
        } catch (e) {
            _sayData = { supported: false, voices: [] };
        }
        load.remove();
    }
    if (!_sayData.supported) {
        const off = document.createElement('div');
        off.className = 'mk-desc';
        off.textContent = tf('uplift.voices.say_unsupported',
            'The macOS say engine is not available on this server.');
        box.append(off);
        return;
    }
    const filter = document.createElement('input');
    filter.type = 'text'; filter.className = 'vc-say-filter';
    filter.placeholder = tf('uplift.voices.say_filter_ph',
                            'Filter by name or language…');
    const rows = document.createElement('div');
    rows.className = 'vc-list';
    filter.oninput = () => { _sayFilter = filter.value; _sayRows(rows, _sayData.voices); };
    box.append(filter, rows);
    _sayRows(rows, _sayData.voices);
}

let _vcTab = 'clone';

function vcTabBtn(key, en, id) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'se-btn vc-tab' + (_vcTab === id ? ' on' : '');
    b.textContent = tf(key, en);
    b.dataset.i18n = key; b.dataset.en = en;
    b.onclick = () => { if (_vcTab !== id) { _vcTab = id; renderVoices(); } };
    return b;
}

async function renderVoices() {
    const host = $('vc-body');
    if (!host) return;
    await loadVoices();
    stopPlayback();
    host.textContent = '';
    let models = ttsModels();
    if (!models.length && !_modelsSelf) {
        // applyTab runs MM.render() concurrently — adminModels may still
        // be the empty first frame; fetch the catalog ourselves ONCE so a
        // direct #models/voices landing does not falsely claim 'no TTS
        // model installed'
        try {
            const d = await D.fetchJson(`${API}/admin/api/models`);
            const all = d.models || [];
            _modelsSelf = all.filter(m =>
                (m.engine_type || m.model_type) === 'audio_tts');
            _sttSelf = all.filter(m =>
                (m.engine_type || m.model_type) === 'audio_stt');
            models = _modelsSelf;
        } catch (e) { /* leave the empty-state hint honest */ }
    } else if (!models.length && _modelsSelf) {
        models = _modelsSelf;
    }
    const tabs = document.createElement('div');
    tabs.className = 'vc-tabs';
    tabs.append(vcTabBtn('uplift.voices.tab_clone', 'CLONED VOICES', 'clone'),
                vcTabBtn('uplift.voices.tab_say', 'macOS VOICES', 'say'));
    host.append(tabs);
    if (_vcTab === 'say') {
        // one panel per visit; the ADD form (clone flow) stays on its tab
        await sayPanel(host);
        const sub = $('vc-sub');
        if (sub) sub.textContent = _voices.length + ' ×';
        return;
    }
    host.append(voiceForm(models, _sttSelf));
    const list = document.createElement('div');
    list.className = 'vc-list';
    if (_voices.length) {
        for (const v of _voices) {
            if (_saveAs && _saveAs === v.id) { list.append(voiceRow(v)); continue; }
            const holder = document.createElement('div');
            holder.className = 'vc-rowwrap';
            holder.append(voiceRow(v));
            // 'save it onto a DIFFERENT model' = a NEW voice reusing this
            // clip (from_voice server-side); the original stays untouched
            const cp = document.createElement('button');
            cp.type = 'button'; cp.className = 'se-btn vc-copy';
            cp.textContent = tf('uplift.voices.save_as', 'SAVE AS…');
            cp.onclick = () => { _saveAs = v.id; _editing = null;
                                 window.scrollTo(0, 0); renderVoices(); };
            holder.append(cp);
            list.append(holder);
        }
    } else {
        const none = document.createElement('div');
        D.emptyMsg(none, tf('uplift.voices.none',
            'No voices yet — add a reference clip above.'));
        list.append(none);
    }
    host.append(list);
    const sub = $('vc-sub');
    if (sub) sub.textContent = _voices.length + ' ×';
}

window.Uplift = window.Uplift || {};
window.Uplift.voices = { renderVoices, voices: () => _voices,
                        loadVoices, ttsModels, speechJson, playBlob,
                        stopPlayback, newPlayer, playInto, voiceFetch, transcribeClip,
                        voiceLabel,
                        // VOICE-9 test seam: the recorder's pure half (the
                        // WAV container, the language resolver) — no
                        // AudioContext, no DOM, node-drivable.
                        _rec: { pcmToWavMono, normLang, promptFor, SUGGEST,
                                MIN_SECONDS, MAX_SECONDS },
                        // SAY-1 test seams: the pure half of the macOS tab
                        // (tier table, language label, row builder).
                        // SAY-2 dropped storeName: the tab stores no
                        // pseudo-model voices any more.
                        _say: { SAY_TIERS, langName: _langName,
                                rows: _sayRows } };
})();
