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

function voiceRow(v) {
    const row = document.createElement('div');
    row.className = 'urow vc-row';
    const lab = document.createElement('div');
    lab.className = 'vc-name';
    lab.textContent = v.name;
    const sub = document.createElement('div');
    sub.className = 'vc-sub';
    // fmtBytes floors at MiB — reference clips are ~100 KB and would all
    // read '0 MiB'; show KiB under a MiB, MiB above (user size-honesty)
    const size = v.ref_bytes ? (v.ref_bytes < 1048576
        ? Math.round(v.ref_bytes / 1024) + ' KiB' : C.fmtBytes(v.ref_bytes)) : '—';
    sub.textContent = v.model + ' · ' +
        tf('uplift.voices.clip', 'clip') + ' ' + size;
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
    act.append(play, del);
    row.append(lab, act);
    return row;
}

function addForm(models, sttSelf) {
    const box = document.createElement('div');
    box.className = 'mk-box vc-add';
    const head = document.createElement('div');
    head.className = 'mk-title';
    head.textContent = tf('uplift.voices.add_title', 'ADD VOICE');
    const hint = document.createElement('div');
    hint.className = 'mk-desc';
    hint.textContent = tf('uplift.voices.add_hint',
        'Upload a short reference clip (a few seconds of clean speech) and '
        + 'type exactly what it says. The TTS model copies that speaking '
        + 'style for any text you send to this voice.');
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
    const fileI = document.createElement('input');
    fileI.type = 'file'; fileI.accept = AUDIO_EXTS.map(e => '.' + e).join(',');
    const refT = document.createElement('textarea');
    refT.rows = 2;
    refT.placeholder = tf('uplift.voices.ref_text_ph',
        'Transcript of the reference clip — exactly what is said in it.');
    let file = null, b64 = '';
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
        field(tf('uplift.voices.model', 'TTS model'), modelS),
        field(tf('uplift.voices.clip_file', 'Reference clip'), fileI),
        field(tf('uplift.voices.ref_text', 'Reference text'), refWrap));
    const acts = document.createElement('div');
    acts.className = 'vc-acts';
    const prevB = document.createElement('button');
    prevB.type = 'button'; prevB.className = 'se-btn';
    prevB.textContent = tf('uplift.voices.preview', 'PREVIEW');
    prevB.onclick = async () => {
        if (!file || !b64) return D.toast(
            tf('uplift.voices.need_clip', 'pick a reference clip first'), 'error');
        if (!refT.value.trim()) return D.toast(
            tf('uplift.voices.need_ref_text', 'type the reference transcript'), 'error');
        prevB.disabled = true;
        try {
            const r = await speechJson('/voices/preview', {
                model: modelS.value, ref_audio_b64: b64, ref_name: file.name,
                ref_text: refT.value.trim(),
                input: tf('uplift.voices.sample_text',
                          'Hello! This is how I sound.') });
            await playBlob(r, prevB);
        } catch (e) { D.toast(String(e && e.message || e), 'error'); }
        prevB.disabled = false;
    };
    const addB = document.createElement('button');
    addB.type = 'button'; addB.className = 'se-btn savebtn';
    addB.textContent = tf('uplift.voices.save', 'SAVE VOICE');
    addB.onclick = async () => {
        if (!nameI.value.trim() || !modelS.value || !b64 || !refT.value.trim())
            return D.toast(tf('uplift.voices.need_all',
                'name, model, clip and transcript are all required'), 'error');
        addB.disabled = true;
        try {
            await D.postJson(`${VAPI}/voices`,
                { name: nameI.value.trim(), model: modelS.value,
                  ref_audio_b64: b64, ref_name: file.name,
                  ref_text: refT.value.trim() });
            D.toast(tf('uplift.voices.saved', 'Voice saved') + ': ' + nameI.value.trim());
            renderVoices();
        } catch (e) { D.toast(String(e && e.message || e), 'error'); }
        addB.disabled = false;
    };
    acts.append(prevB, addB);
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
    host.append(addForm(models, _sttSelf));
    const list = document.createElement('div');
    list.className = 'vc-list';
    if (_voices.length) {
        for (const v of _voices) list.append(voiceRow(v));
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
                        stopPlayback, newPlayer, playInto, voiceFetch, transcribeClip };
})();
