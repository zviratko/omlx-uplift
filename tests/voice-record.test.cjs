/* VOICE-9 — in-browser microphone recorder + per-language read-aloud sample
   in the Voices panel. uplift_voices.js has no module.exports (plain script
   loaded by index.html), so — exactly like acc2a-extras.test.cjs — the file
   runs inside a vm context over a hand-rolled DOM stub, with the recorder's
   capabilities stubbed (MediaRecorder, getUserMedia, AudioContext.decodeAudioData,
   Blob/File/FileReader/URL/Audio) so the real wiring is driven, not guessed.

   Pinned here:
   - capability gate: no MediaRecorder/getUserMedia/AudioContext -> the clip
     field gains NOT ONE node (zero DOM delta, silent-absence doctrine)
   - insecure origin: RECORD renders DISABLED with the honest reason in title
   - pcmToWavMono: pure WAV container (RIFF/WAVE/fmt /data, PCM 1, mono,
     16-bit, byteRate, chunk sizes, clamping) — no AudioContext needed
   - normLang/promptFor: names, native names (accented), codes, uiLang
     fallback (pt-BR -> pt, zh-TW -> zh), unknown -> en
   - SUGGEST: exactly the 11 contracted codes, every passage a real text
   - happy path end to end: RECORD -> getUserMedia constraints -> STOP ->
     decode -> downmix -> WAV -> form-local file/b64 -> AUTO-TRANSCRIBE
     enabled -> transcript pre-filled -> SAVE ships the recorded WAV
   - mic tracks stopped on EVERY exit path (success, denial, too-short,
     auto-stop, decode failure), re-entry lock, play-back independent of the
     module _player, clear drops the clip but keeps the transcript */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');
const fs = require('node:fs');

const SRC = path.join(STATIC_DIR, 'uplift_voices.js');

/* ---- DOM stub (same shape as acc2a-extras.test.cjs) -------------------- */
function makeDom() {
    const byId = {};
    function mk(tag) {
        const set = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            _lis: {}, parentNode: null, hidden: false, open: true, value: '',
            type: '', checked: false, disabled: false, title: '',
            textContent: '', _id: '',
            get className() { return [...set].join(' '); },
            set className(v) {
                set.clear();
                String(v || '').split(/\s+/).filter(Boolean).forEach(c => set.add(c));
            },
            _classes: set,
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            get id() { return this._id; },
            set id(v) { this._id = v; if (v) byId[v] = this; },
            replaceChildren(...kids) {
                this.children.forEach(c => { c.parentNode = null; });
                this.children = kids; kids.forEach(c => { c.parentNode = this; });
            },
            append(...kids) {
                kids.forEach(c => { c.parentNode = this; this.children.push(c); });
            },
            appendChild(k) { k.parentNode = this; this.children.push(k); return k; },
            insertBefore(k, ref) {
                const i = ref ? this.children.indexOf(ref) : -1;
                k.parentNode = this;
                if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
                return k;
            },
            removeChild(k) {
                const i = this.children.indexOf(k);
                if (i >= 0) { this.children.splice(i, 1); k.parentNode = null; }
                return k;
            },
            remove() {
                if (this.parentNode) this.parentNode.removeChild(this);
                else this.children = [];
            },
            addEventListener(t, fn) { (this._lis[t] = this._lis[t] || []).push(fn); },
            removeEventListener() {},
            querySelector(s) { return this.querySelectorAll(s)[0] || null; },
            querySelectorAll(s) { return queryAll(this, s); },
            focus() {}, blur() {},
            click() { click(el); },
            classList: {
                add(...c) { c.forEach(x => set.add(x)); },
                remove(...c) { c.forEach(x => set.delete(x)); },
                contains(c) { return set.has(c); },
                toggle(c) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; },
            },
        };
        if (tag === 'select') {
            let v = '';
            Object.defineProperty(el, 'value', {
                configurable: true,
                get() {
                    if (v) return v;
                    const o = (el.children || []).filter(c => c.tagName === 'option')[0];
                    return o ? o.value : '';
                },
                set(x) { v = String(x); },
            });
        }
        return el;
    }
    function matchCompound(node, part) {
        const m = part.match(/^(?:(#([\w-]+))|(?:([\w-]+))?)(?:\.([\w-]+))?$/);
        if (!m) return false;
        if (m[1] && node.id !== m[2]) return false;
        if (m[3] && node.tagName !== m[3]) return false;
        if (m[4] && !(node._classes && node._classes.has(m[4]))) return false;
        if (!m[1] && !m[3] && !m[4]) return false;
        return true;
    }
    function walk(node, out) {
        for (const c of node.children || []) { out.push(c); walk(c, out); }
        return out;
    }
    function queryAll(root, sel) {
        const all = walk(root, []);
        const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
        const hit = [];
        for (const g of groups) {
            const parts = g.split(/\s+/);
            const last = parts[parts.length - 1];
            for (const n of all) {
                if (!matchCompound(n, last) || hit.includes(n)) continue;
                let ok = true, p = n.parentNode, i = parts.length - 2;
                while (i >= 0 && p) { if (matchCompound(p, parts[i])) i--; p = p.parentNode; }
                if (i < 0) hit.push(n);
                else if (parts.length === 1) hit.push(n);
                else ok = false;
                if (parts.length === 1) break;
                if (!ok) hit.pop();
            }
        }
        return hit;
    }
    const doc = mk('#document');
    doc.createElement = t => mk(t);
    doc.createTextNode = s => ({ textContent: String(s), children: [] });
    doc.getElementById = id => byId[id] || (byId[id] = mk('div'));
    doc.documentElement = mk('html');
    doc.documentElement.lang = '';
    return { doc, byId, mk, walk, click, change };

    // uplift_voices wires handlers as PROPERTIES (.onclick), not listeners:
    // click() drives both shapes so a later refactor stays testable
    function click(el, ev) {
        const e = Object.assign({ target: el, stopPropagation() {}, preventDefault() {} }, ev || {});
        if (typeof el.onclick === 'function') el.onclick(e);
        (el._lis.click || []).forEach(fn => fn(e));
    }
    function change(el) {
        const e = { target: el, stopPropagation() {}, preventDefault() {} };
        if (typeof el.onchange === 'function') el.onchange(e);
        (el._lis.change || []).forEach(fn => fn(e));
    }
}
function classes(n, c, out) {
    out = out || [];
    if (n._classes && n._classes.has(c)) out.push(n);
    (n.children || []).forEach(k => classes(k, c, out));
    return out;
}
const buttonsOf = n => classes(n, 'se-btn');
const btnText = (n, txt) =>
    buttonsOf(n).filter(b => String(b.textContent || '').trim() === txt)[0] || null;
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = (n) => new Promise(async r => { for (let i = 0; i < (n || 10); i++) await tick(); r(); });
/* ---- web-API stubs ----------------------------------------------------- */
function makeApis(o, st) {
    class FakeBlob {
        constructor(parts, opts) {
            const bufs = [];
            for (const p of parts || []) {
                if (p instanceof FakeBlob) bufs.push(p._b);
                // ArrayBuffer.isView, NOT instanceof: the module builds its
                // Uint8Array in the vm realm, so the host intrinsic never
                // matches (an instanceof test silently stringifies the lot)
                else if (ArrayBuffer.isView(p))
                    bufs.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
                else if (p instanceof ArrayBuffer) bufs.push(Buffer.from(p));
                else if (typeof p === 'string') bufs.push(Buffer.from(p, 'utf8'));
                else bufs.push(Buffer.from(String(p), 'utf8'));
            }
            this._b = Buffer.concat(bufs);
            this.type = (opts && opts.type) || '';
            this.size = this._b.length;
        }
        _bytes() { return this._b; }
        arrayBuffer() {
            const c = Buffer.alloc(this._b.length); this._b.copy(c);
            return Promise.resolve(c.buffer);
        }
    }
    class FakeFile extends FakeBlob {
        constructor(parts, name, opts) { super(parts, opts); this.name = String(name); }
    }
    class FakeFileReader {
        readAsDataURL(blob) {
            this.result = 'data:' + ((blob && blob.type) || 'application/octet-stream')
                + ';base64,' + blob._bytes().toString('base64');
            setTimeout(() => { if (this.onload) this.onload({ target: this }); }, 0);
        }
    }
    class FakeAudioContext {
        decodeAudioData(buf) {
            st.decodeCalls.push(buf);
            if (o.decodeFails) return Promise.reject(new Error('decode exploded'));
            const n = Math.round(o.duration * o.sampleRate);
            const chans = [];
            for (let c = 0; c < o.channels; c++) chans.push(new Float32Array(n).fill(0.25));
            return Promise.resolve({
                sampleRate: o.sampleRate, length: n, duration: n / o.sampleRate,
                numberOfChannels: o.channels, getChannelData: i => chans[i],
            });
        }
    }
    class FakeAudio {
        constructor(url) { this.src = url || ''; this.paused = true; st.audios.push(this); }
        play() { this.paused = false; st.plays++; return Promise.resolve(); }
        pause() { this.paused = true; st.pauses++; }
    }
    class FakeMediaRecorder {
        constructor(stream, opts) {
            this.stream = stream;
            this.mimeType = (opts && opts.mimeType) || 'audio/webm';
            this.state = 'inactive';
            this.onstop = this.onerror = this.ondataavailable = null;
            st.recs.push(this);
        }
        static isTypeSupported(t) { return (o.supported || []).indexOf(t) >= 0; }
        start() { this.state = 'recording'; st.starts++; }
        stop() {
            if (o.stopThrows) { throw new Error('recorder stopped working'); }
            this.state = 'inactive';
            for (const c of o.chunks) if (this.ondataavailable) this.ondataavailable({ data: c });
            setTimeout(() => { if (this.onstop) this.onstop(); }, 0);
        }
    }
    return { FakeBlob, FakeFile, FakeFileReader, FakeAudioContext, FakeAudio, FakeMediaRecorder };
}

/* ---- sandbox + mount --------------------------------------------------- */
async function mount(opt) {
    const o = Object.assign({
        cap: 'full',                 // 'none' | 'insecure' | 'full'
        uiLang: 'en', docLang: '',
        duration: 6, sampleRate: 48000, channels: 2,
        supported: ['audio/webm;codecs=opus', 'audio/webm'],
        deny: null, decodeFails: false, stopThrows: false, chunks: null,
        strings: null, caps: null, webkit: false, miss: null,
    }, opt || {});
    const { doc, byId, click, change } = makeDom();
    doc.documentElement.lang = o.docLang;
    const tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; } }];
    const stream = { getTracks: () => tracks };
    const st = { toasts: [], posts: [], gumCalls: [], decodeCalls: [], audios: [],
                 recs: [], starts: 0, plays: 0, pauses: 0, gum: 0, capCalls: [],
                 intervals: [], created: 0, revoked: 0 };
    const K = makeApis(o, st);
    if (!o.chunks)
        o.chunks = [new K.FakeBlob(['fake-opus-bytes'], { type: 'audio/webm;codecs=opus' })];
    const cap = o.cap !== 'none';
    let clock = 1000000;
    const RealDate = Date;
    function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(clock); }
    FakeDate.now = () => clock;
    FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
    const win = {
        console, Date: FakeDate, Blob: K.FakeBlob, File: K.FakeFile,
        FileReader: K.FakeFileReader, Audio: K.FakeAudio, Error, TypeError,
        Promise, JSON, Math, Object, Array, String, Number, Boolean, RegExp,
        Set, Map, isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
        MediaRecorder: cap ? K.FakeMediaRecorder : undefined,
        // Safari still ships only the prefixed AudioContext — the gate must
        // accept either spelling (and the test says which one is present)
        AudioContext: cap && !o.webkit ? K.FakeAudioContext : undefined,
        webkitAudioContext: cap && o.webkit ? K.FakeAudioContext : undefined,
        isSecureContext: o.cap === 'full',
        navigator: cap ? { mediaDevices: { getUserMedia: (c) => {
            st.gum++; st.gumCalls.push(c);
            if (o.deny) {
                const e = new Error(o.deny.message || 'Permission denied');
                e.name = o.deny.name || 'NotAllowedError';
                return Promise.reject(e);
            }
            return Promise.resolve(stream);
        } } } : undefined,
        URL: { createObjectURL: () => 'blob:fake/' + (++st.created),
               revokeObjectURL: () => { st.revoked++; } },
        document: doc,
        location: { hash: '#models/voices', pathname: '/uplift/', search: '' },
        UpliftCore: {
            API: '',
            t: k => k,
            tf: (k, fb) => (o.strings && o.strings[k]) || fb,
            getLocale: () => ({ lang: o.uiLang, strings: o.strings || {} }),
            fmtBytes: n => n + ' B',
            errorText: j => (j && (j.detail || j.error)) || '',
        },
        UpliftDom: {
            $: id => doc.getElementById(id),
            fetchJson: async (u) => String(u).includes('/capabilities')
                ? (st.capCalls.push(String(u)), (o.caps || {})) : { voices: [] },
            postJson: async (u, b) => { st.posts.push({ url: String(u), body: b }); return {}; },
            putJson: async (u, b) => { st.posts.push({ url: String(u), body: b }); return {}; },
            deleteJson: async () => ({}),
            toast: (msg, ms, cls) => st.toasts.push(
                { msg: String(msg), cls: typeof ms === 'string' ? ms : cls }),
            emptyMsg: (hostEl, msg) => { hostEl.textContent = msg; },
        },
        Uplift: {
            state: { API: '' },
            modelmgr: { adminModels: [
                { id: 'qwen3-tts', name: 'Qwen3-TTS', engine_type: 'audio_tts' },
                { id: 'whisper', name: 'Whisper', engine_type: 'audio_stt' }] },
        },
    };
    win.window = win; win.self = win;
    // surgical capability removal: drop ONE piece of the puzzle at a time
    for (const m of (o.miss || [])) {
        if (m === 'getUserMedia') win.navigator.mediaDevices.getUserMedia = undefined;
        else if (m === 'mediaDevices') win.navigator.mediaDevices = undefined;
        else win[m] = undefined;
    }
    win.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false }; st.intervals.push(h); return h; };
    win.clearInterval = (h) => { if (h) h.cleared = true; };
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), vm.createContext(win), { filename: SRC });
    const V = win.Uplift.voices;
    await V.renderVoices();
    await settle();
    const host = byId['vc-body'];
    assert.ok(host && host.children.length, 'the voices panel rendered');
    const form = classes(host, 'vc-add')[0];
    const clipF = classes(form, 'vc-field').find(f =>
        (f.children || []).some(c => c.tagName === 'input' && c.type === 'file'));
    const refF = classes(form, 'vc-field').filter(f =>
        (f.children || []).some(c => c.tagName === 'div' && c._classes.has('vc-refwrap')))[0];
    const refWrap = classes(form, 'vc-refwrap')[0];
    const refT = classes(refWrap, '')[0] || (refWrap.children || []).find(c => c.tagName === 'textarea');
    const h = { win, V, st, doc, byId, host, form, clipF, refF, refWrap, click, change,
                tracks, stream, form_ : form,
                ta: (refWrap.children || []).find(c => c.tagName === 'textarea'),
                fileI: (clipF.children || []).find(c => c.tagName === 'input' && c.type === 'file'),
                nameI: (classes(form, 'vc-field')[0].children || []).find(c => c.tagName === 'input'),
                sttS: classes(form, 'vc-stt-sel')[0],
                langS: (classes(form, 'vc-field').filter(f =>
                    (f.children || []).some(c => c.tagName === 'div' &&
                        (c.children || []).some(k => k.tagName === 'input')))[0].children || [])
                    .find(c => c.tagName === 'div').children[0],
                trB: null, recB: null, recSt: null, recPlay: null, recClear: null,
                promptB: null };
    // Labels are translated, so the two reference-area buttons are found
    // STRUCTURALLY: 'use suggested text' is the first button in the ref
    // stack, AUTO-TRANSCRIBE shares its row with the STT picker.
    h.promptB = buttonsOf(h.refWrap)[0] || null;
    h.trB = h.sttS ? buttonsOf(h.sttS.parentNode)[0] || null : null;
    // A real <select> reports its FIRST option as the value until the user
    // (or code) picks another — sttS/spkS gates depend on it, so the stub
    // above mirrors that; the recorder row is found by CLASS because its
    // button label is itself translated.
    const recRow = classes(h.clipF, 'vc-trrow')[0];
    if (recRow) {
        const bs = buttonsOf(recRow);
        h.recRow = recRow;
        h.recSt = classes(recRow, 'native-stub-note')[0];
        h.recB = bs[0]; h.recPlay = bs[1]; h.recClear = bs[2];
    }
    h.tickN = (n) => { clock += n * 1000; };
    h.runIntervals = () => st.intervals.filter(i => !i.cleared).forEach(i => i.fn());
    h.toastMsgs = () => st.toasts.map(t => t.msg);
    h.startRecord = async () => { h.click(h.recB); await settle(); };
    h.stopRecord = async () => { h.click(h.recB); await settle(); };
    return h;
}
/* ---- 1. capability gate: absence is silent ----------------------------- */
test('VOICE-9: no MediaRecorder/getUserMedia/AudioContext -> zero DOM delta',
    async () => {
        const h = await mount({ cap: 'none' });
        assert.equal(h.recRow, undefined, 'no recorder row was built');
        assert.equal(h.clipF.children.length, 2,
            'the clip field still holds EXACTLY its label span + file input');
        assert.deepEqual(classes(h.clipF, 'vc-trrow'), [],
            'not one node added inside the Reference-clip field');
        assert.ok(!btnText(h.host, 'RECORD'), 'no RECORD button anywhere');
        assert.equal(classes(h.host, 'native-stub-note').length, 0, 'no status span');
        // the read-aloud sample is plain text: never capability-gated
        assert.ok(h.promptB, "'use suggested text' works without a mic");
        h.click(h.promptB);
        assert.equal(h.ta.value, h.V._rec.SUGGEST.en, 'and it still fills the text');
    });

test('VOICE-9: insecure origin -> RECORD renders DISABLED with the honest reason',
    async () => {
        const h = await mount({ cap: 'insecure' });   // stubs, isSecureContext false
        assert.ok(h.recB, 'the affordance exists');
        assert.equal(h.recB.textContent, 'RECORD');
        assert.equal(h.recB.disabled, true, 'a button that cannot work is disabled');
        assert.match(h.recB.title, /https or localhost/);
        assert.match(h.recB.title, /localhost tunnel/);
        assert.match(h.recB.title, /upload a saved audio file/);
        h.click(h.recB);                              // a disabled button must not
        await settle();                               // secretly work
        assert.equal(h.st.gum, 0, 'no getUserMedia call behind the disabled button');
    });

/* ---- 2. the pure test seam --------------------------------------------- */
const ascii = (u8, o, l) => String.fromCharCode(...u8.slice(o, o + l));

test('VOICE-9: pcmToWavMono writes a canonical 16-bit mono PCM WAV', async () => {
    const R = (await mount({ cap: 'none' })).V._rec;
    assert.equal(typeof R.pcmToWavMono, 'function');
    assert.equal(R.MIN_SECONDS, 3);
    assert.equal(R.MAX_SECONDS, 90);
    const s = Float32Array.of(-1.5, 2.0, 0.5, 0, -0.5, NaN);
    const wav = R.pcmToWavMono(s, 48000);
    // the module runs in a vm realm, so its Uint8Array is not OUR intrinsic
    assert.equal(wav.constructor.name, 'Uint8Array', 'pure bytes out, no AudioContext');
    assert.equal(Object.prototype.toString.call(wav), '[object Uint8Array]');
    assert.equal(wav.byteLength, 44 + s.length * 2);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(ascii(wav, 0, 4), 'RIFF');
    assert.equal(ascii(wav, 8, 4), 'WAVE');
    assert.equal(ascii(wav, 12, 4), 'fmt ');
    assert.equal(ascii(wav, 36, 4), 'data');
    assert.equal(dv.getUint32(4, true), wav.length - 8, 'RIFF size = file-8');
    assert.equal(dv.getUint32(16, true), 16, 'fmt chunk is 16 bytes');
    assert.equal(dv.getUint16(20, true), 1, 'audioFormat PCM');
    assert.equal(dv.getUint16(22, true), 1, 'mono');
    assert.equal(dv.getUint32(24, true), 48000, 'sampleRate honoured');
    assert.equal(dv.getUint32(28, true), 48000 * 2, 'byteRate = rate*2');
    assert.equal(dv.getUint16(32, true), 2, 'blockAlign = 2');
    assert.equal(dv.getUint16(34, true), 16, 'bits');
    assert.equal(dv.getUint32(40, true), s.length * 2, 'data chunk size = 2n');
    assert.equal(dv.getInt16(44, true), -32768, 'below -1 clamps to the floor');
    assert.equal(dv.getInt16(46, true), 32767, 'above +1 clamps to the ceiling');
    assert.equal(dv.getInt16(48, true), 16384, '0.5 scales to +full*0.5');
    assert.equal(dv.getInt16(50, true), 0);
    assert.equal(dv.getInt16(52, true), -16384, '-0.5 scales to the negative rail');
    assert.equal(dv.getInt16(54, true), 0, 'NaN becomes silence, never garbage');
    const empty = R.pcmToWavMono(new Float32Array(0), 24000);
    assert.equal(empty.length, 44, 'a zero-sample encode is a header');
    assert.equal(new DataView(empty.buffer).getUint32(4, true), 36);
});

test('VOICE-9: normLang maps names/native names/codes, uiLang fills the gap',
    async () => {
        const R = (await mount({ cap: 'none' })).V._rec;
        assert.equal(R.normLang('Czech', 'en'), 'cs');
        assert.equal(R.normLang('čeština', 'en'), 'cs', 'accented native name');
        assert.equal(R.normLang('česky', 'en'), 'cs');
        assert.equal(R.normLang('cs', 'en'), 'cs');
        assert.equal(R.normLang('ENGLISH', 'en'), 'en', 'case-insensitive');
        assert.equal(R.normLang('English', 'cs'), 'en', 'explicit raw beats uiLang');
        assert.equal(R.normLang('Deutsch', 'en'), 'de');
        assert.equal(R.normLang('español', 'en'), 'es');
        assert.equal(R.normLang('日本語', 'en'), 'ja', 'native CJK name');
        assert.equal(R.normLang('한국어', 'en'), 'ko');
        assert.equal(R.normLang('中文', 'en'), 'zh');
        assert.equal(R.normLang('русский', 'en'), 'ru');
        assert.equal(R.normLang('pt-BR', 'en'), 'pt', 'regional code folds');
        // empty raw -> the board's own locale
        assert.equal(R.normLang('', 'pt-BR'), 'pt');
        assert.equal(R.normLang('', 'zh-TW'), 'zh');
        assert.equal(R.normLang('   ', 'cs'), 'cs');
        assert.equal(R.normLang(null, 'ja'), 'ja');
        assert.equal(R.normLang(undefined, 'en'), 'en');
        // unknown -> 'en' (never a crash, never an empty textarea)
        assert.equal(R.normLang('klingon', 'en'), 'en');
        assert.equal(R.normLang('', 'xhosa'), 'en');
        assert.equal(R.normLang('', ''), 'en');
        assert.equal(R.normLang('constructor', 'en'), 'en',
            'prototype keys must not resolve to an Object');
        // promptFor = the passage for the resolved code
        assert.equal(R.promptFor('Czech', 'en'), R.SUGGEST.cs);
        assert.equal(R.promptFor('', 'pt-BR'), R.SUGGEST.pt);
        assert.equal(R.promptFor('klingon', 'ja'), R.SUGGEST.en);
    });

test('VOICE-9: SUGGEST carries exactly the 11 contracted languages', async () => {
    const R = (await mount({ cap: 'none' })).V._rec;
    assert.deepEqual(Object.keys(R.SUGGEST).sort(),
        ['cs', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh']);
    // verbatim contract: every passage opens on the rainbow and closes on
    // the old teacher / river / songs scene (pinning head + tail catches the
    // multi-line concatenation dropping a space or a whole clause)
    const SCENE = {
        en: ['When the sunlight strikes raindrops', 'prism and form a rainbow',
             'beside the river, quietly talking about strange ideas and forgotten songs.'],
        cs: ['Příliš žluťoučký kůň úpěl ďábelské ódy.', 'objeví duha',
             'podél řeky a tiše vyprávěl o divných nápadech a zapomenutých písních.'],
        de: ['Wenn die Sonne auf die Regentropfen scheint', 'ein Regenbogen',
             'verschneite Tal und sang dabei leise ein vertrautes Lied.'],
        es: ['Cuando la luz del sol atraviesa las gotas de lluvia', 'forma un arcoíris',
             'junto al río, hablando en voz baja de historias raras y canciones antiguas.'],
        fr: ['Quand la lumière du soleil traverse les gouttes de pluie', 'arc-en-ciel',
             'au bord de la rivière en chantant doucement de vieilles chansons.'],
        it: ['Quando la luce del sole attraversa le gocce di pioggia', 'arcobaleno',
             'lungo il fiume con un cane magro, cantando piano vecchie canzoni.'],
        pt: ['Quando a luz do sol atravessa as gotas de chuva', 'forma um arco-íris',
             'à beira do rio com um cão magro, cantando baixinho antigas canções.'],
        ru: ['Когда солнечный свет проходит сквозь капли дождя', 'рождает радугу',
             'вдоль быстрой реки с худым серым псом и тихо напевал забытые песни.'],
        ja: ['雨上がりの空に、七色の虹がゆったりとかかりました。', '川沿いを歩きながら',
             '昔の歌を静かに口ずさんでいました。'],
        zh: ['雨停以后，太阳的光穿过空中的水滴', '一道美丽的彩虹', '嘴里轻轻哼着古老的歌。'],
        ko: ['비가 그친 뒤 햇빛이 물방울을 통과하면 무지개가 뜹니다.', '조용한 강가를',
             '옛 노래를 나직이 흥얼거렸습니다.'],
    };
    assert.deepEqual(Object.keys(SCENE).sort(), Object.keys(R.SUGGEST).sort());
    for (const k of Object.keys(R.SUGGEST)) {
        const v = R.SUGGEST[k];
        assert.equal(typeof v, 'string', k + ' must be text');
        for (const frag of SCENE[k])
            assert.ok(v.indexOf(frag) >= 0, k + ' lost its contract text: ' + frag);
        assert.ok(v === v.trim(), k + ' has stray edge whitespace (concat drift)');
        assert.ok(!/  /.test(v), k + ' has a doubled space (concat drift)');
        const bytes = Buffer.byteLength(v, 'utf8');
        assert.ok(bytes >= 120, k + ' is too thin to be a 10-20 s read');
        // DEVIATION from the literal '>= 120 characters' floor, recorded in
        // the test so it cannot rot: ja/zh/ko are mora-dense scripts — one
        // glyph is one spoken syllable, so the spec's OWN verbatim passages
        // are 71/72/93 glyphs (= 213-229 bytes, the same 10-20 s of speech
        // as the 209-296-character European ones; 120 Japanese glyphs would
        // be a ~40 s reading nobody records). The European set keeps the
        // literal 120-character floor; the dense set gets 60 glyphs.
        const DENSE = { ja: 1, zh: 1, ko: 1 };
        if (DENSE[k]) {
            assert.ok(v.length >= 60, k + ' too short for a 10-20 s read');
            assert.ok(bytes >= 180, k + ' too little actual speech per read');
        } else {
            assert.ok(v.length >= 120, k + ' is a readable passage, not a stub');
        }
        assert.ok(v.indexOf('<') < 0, k + ' is plain text (textContent-fed)');
    }
    assert.notEqual(R.SUGGEST.ja, R.SUGGEST.zh, 'CJK passages differ');
    assert.match(R.promptFor('czech', 'en'), /žluťoučký/);
});
/* ---- 3. the record flow, driven through the real wiring ---------------- */
test('VOICE-9: RECORD → STOP decodes to a mono WAV that the SAVE path ships',
    async () => {
        const h = await mount({ cap: 'full', duration: 6, sampleRate: 48000, channels: 2 });
        assert.ok(h.recB && !h.recB.disabled, 'secure origin + caps → live button');
        assert.equal(h.recB.textContent, 'RECORD');
        assert.match(h.recB.title, /read the suggested text aloud/);
        assert.equal(h.recSt.hidden, true, 'the status span sleeps until it talks');
        assert.equal(h.recPlay.hidden, true, 'no play-back before a take exists');
        assert.equal(h.recB.textContent, 'RECORD');
        assert.equal(h.recClear.hidden, true);
        assert.equal(h.sttS.value, 'whisper',
            'the stub select defaults like a browser one');
        assert.equal(h.trB.disabled, true, 'no clip yet -> AUTO-TRANSCRIBE sleeps');
        h.fileI.value = 'C:/fakepath/old.wav';   // an upload the take replaces
        h.nameI.value = 'Jake';
        await h.startRecord();
        // ---- the microphone ask is the contracted one
        assert.equal(h.st.gum, 1);
        assert.deepEqual(h.st.gumCalls[0],
            { audio: { echoCancellation: true, noiseSuppression: true } });
        assert.equal(h.st.starts, 1, 'MediaRecorder.start ran');
        assert.equal(h.st.recs[0].mimeType, 'audio/webm;codecs=opus',
            'the first SUPPORTED mime wins');
        assert.equal(h.recB.textContent, 'STOP', 'the same button stops');
        assert.equal(h.recSt.hidden, false);
        assert.equal(h.st.intervals.length, 1);
        assert.equal(h.st.intervals[0].ms, 200, 'the timer is the 200 ms one');
        h.tickN(5); h.runIntervals();
        assert.equal(h.recSt.textContent, 'recording… 5s', 'live seconds, no lie');
        h.tickN(2); h.runIntervals();
        assert.equal(h.recSt.textContent, 'recording… 7s');
        await h.stopRecord();
        // ---- decode + encode happened once, on the captured bytes
        assert.equal(h.st.decodeCalls.length, 1);
        assert.ok(Buffer.from(h.st.decodeCalls[0]).subarray(0, 15).toString()
            .startsWith('fake-opus-bytes'), 'the webm chunks were handed to the decoder');
        // ---- the mic is OFF. Non-negotiable.
        assert.equal(h.tracks[0].stopped, true);
        assert.equal(h.st.intervals[0].cleared, true, 'no orphan 200 ms timer');
        // ---- form state: the take IS the clip
        assert.equal(h.fileI.value, '', 'the two inputs never disagree');
        assert.equal(h.recB.textContent, 'RECORD', 'button is armed for another take');
        assert.equal(h.recB.disabled, false);
        assert.equal(h.recSt.hidden, true);
        assert.equal(h.trB.disabled, false, 'AUTO-TRANSCRIBE unlocked exactly like an upload');
        assert.equal(h.recPlay.hidden, false, 'play-back appeared');
        assert.equal(h.recClear.hidden, false, 'clear appeared');
        assert.equal(h.ta.value, h.V._rec.SUGGEST.en,
            'an EMPTY transcript is filled with the text they just read');
        assert.equal(h.st.plays, 0, 'nothing autoplays');
        assert.equal(h.st.audios.length, 0);
        assert.deepEqual(h.toastMsgs().slice(-1),
            ['Clip recorded — check the transcript before saving']);
        // ---- SAVE ships the recording: WAV header + mono downmix survive
        const saveB = buttonsOf(h.form).filter(b => b.textContent === 'SAVE VOICE')[0];
        h.click(saveB);
        await settle();
        assert.equal(h.st.posts.length, 1, 'the save POST ran');
        const body = h.st.posts[0].body;
        assert.equal(body.ref_name, 'recording.wav');
        assert.equal(body.ref_text, h.V._rec.SUGGEST.en);
        const wav = Buffer.from(body.ref_audio_b64, 'base64');
        assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
        assert.equal(wav.subarray(36, 40).toString(), 'data');
        assert.equal(wav.readUInt32LE(4), wav.length - 8, 'base64 survived intact');
        assert.equal(wav.readUInt32LE(24), 48000);
        assert.equal(wav.readUInt16LE(22), 1, 'downmixed to mono');
        assert.equal(wav.readUInt32LE(40), 6 * 48000 * 2, 'data size = seconds*rate*2');
        assert.equal(wav.readInt16LE(44), 8192, 'mean of the two 0.25 channels');
        // the browser's own 14 MiB cap still applies (readFileB64 path)
        assert.ok(wav.length < 14 * 1024 * 1024);
    });

test('VOICE-9: re-entry is locked while starting and while decoding',
    async () => {
        const h = await mount({ cap: 'full' });
        h.click(h.recB);
        h.click(h.recB);                  // second click inside the same gesture
        await settle();
        assert.equal(h.st.gum, 1, 'getUserMedia asked once, not twice');
        h.click(h.recB);                  // STOP
        h.click(h.recB);                  // and an ignored click while decoding
        await settle();
        assert.equal(h.st.gum, 1, 'decoding cannot be interrupted by a new take');
        assert.equal(h.st.recs.length, 1, 'one MediaRecorder for the whole session');
        assert.equal(h.tracks[0].stopped, true);
        assert.equal(h.toastMsgs().filter(m => m.indexOf('failed') >= 0).length, 0);
    });

test('VOICE-9: a 90 s take stops itself and says so', async () => {
    // 8 kHz keeps the 90 s WAV at 1.4 MB instead of 8.6 MB of base64 per test
    const h = await mount({ cap: 'full', duration: 90, sampleRate: 8000 });
    h.sttS.value = 'whisper';
    await h.startRecord();
    h.tickN(89); h.runIntervals();
    assert.equal(h.recSt.textContent, 'recording… 89s');
    assert.deepEqual(h.toastMsgs(), [], 'nothing to report at 89 s');
    h.tickN(1); h.runIntervals();
    assert.deepEqual(h.toastMsgs(), ['Recording auto-stopped at 90 s']);
    await settle();
    assert.equal(h.tracks[0].stopped, true, 'the auto-stop releases the mic');
    assert.equal(h.st.intervals[0].cleared, true);
    assert.equal(h.trB.disabled, false, 'the auto-stopped take is a real clip');
    assert.ok(h.toastMsgs().indexOf('Clip recorded — check the transcript before saving') >= 0);
    assert.equal(h.recB.textContent, 'RECORD');
});

test('VOICE-9: too short is refused honestly, not silently accepted',
    async () => {
        const h = await mount({ cap: 'full', duration: 1.2 });
        h.sttS.value = 'whisper';
        await h.startRecord();
        await h.stopRecord();
        assert.deepEqual(h.toastMsgs(),
            ['Only 1 s recorded — too short for a good clone']);
        assert.equal(h.st.toasts[0].cls, 'error');
        assert.equal(h.trB.disabled, true, 'no clip → no auto-transcribe');
        assert.equal(h.recPlay.hidden, true, 'nothing to play back');
        assert.equal(h.ta.value, '', 'a rejected take never writes the transcript');
        assert.equal(h.tracks[0].stopped, true, 'and never leaves the mic open');
        assert.equal(h.recB.textContent, 'RECORD');
        assert.equal(h.recB.disabled, false, 'the user may try again');
    });

test('VOICE-9: a denied microphone says exactly that', async () => {
    const h = await mount({ cap: 'full', deny: { name: 'NotAllowedError' } });
    await h.startRecord();
    assert.deepEqual(h.toastMsgs(), ['Microphone access was denied']);
    assert.equal(h.st.toasts[0].cls, 'error');
    assert.equal(h.st.recs.length, 0, 'no recorder was built behind the refusal');
    assert.equal(h.recB.textContent, 'RECORD', 'the button is not stuck on STOP');
    assert.equal(h.recB.disabled, false);
    assert.equal(h.recSt.hidden, true);
    assert.equal(h.st.intervals.length, 0, 'no timer armed');
});

test('VOICE-9: a failed decode reports the real reason and frees the mic',
    async () => {
        const h = await mount({ cap: 'full', decodeFails: true });
        await h.startRecord();
        await h.stopRecord();
        assert.deepEqual(h.toastMsgs(), ['Recording failed: decode exploded']);
        assert.equal(h.trB.disabled, true);
        assert.equal(h.recPlay.hidden, true);
        assert.equal(h.tracks[0].stopped, true, 'finally-block, not best effort');
        assert.equal(h.recB.textContent, 'RECORD');
    });

test('VOICE-9: a recorder that throws on stop leaves no armed state behind',
    async () => {
        const h = await mount({ cap: 'full', stopThrows: true });
        await h.startRecord();
        h.click(h.recB);
        await settle();
        assert.match(h.toastMsgs().join('|'), /Recording failed: recorder stopped working/);
        assert.equal(h.tracks[0].stopped, true);
        assert.equal(h.recB.textContent, 'RECORD');
        assert.equal(h.recB.disabled, false);
    });
/* ---- 4. play-back, clear, suggested text ------------------------------- */
async function recorded(o) {
    const h = await mount(Object.assign({ cap: 'full', duration: 6 }, o || {}));
    h.sttS.value = 'whisper';
    await h.startRecord();
    await h.stopRecord();
    assert.equal(h.trB.disabled, false, 'setup: a take exists');
    return h;
}

test('VOICE-9: play-back toggles a LOCAL Audio, never the server _player',
    async () => {
        const h = await recorded();
        assert.equal(h.st.created, 0, 'no object URL before the click');
        h.click(h.recPlay);
        assert.equal(h.st.audios.length, 1, 'one Audio element for the take');
        assert.equal(h.st.plays, 1, 'play() ran inside the user gesture');
        assert.match(h.recPlay.textContent, /■/, 'the button became a stop glyph');
        const a = h.st.audios[0];
        assert.equal(a.paused, false);
        // the module's server-synth stopper must NOT touch the mic preview
        h.V.stopPlayback();
        assert.equal(a.paused, false, 'playBack and the take are independent players');
        assert.equal(h.st.pauses, 0);
        h.click(h.recPlay);                            // second click stops it
        assert.equal(a.paused, true);
        assert.equal(h.st.pauses, 1);
        assert.equal(h.st.revoked, 1, 'the finished object URL was revoked');
        h.click(h.recPlay);                            // play again → fresh URL
        assert.equal(h.st.audios.length, 2);
        assert.equal(h.st.created, 2);
        // a new take drops the old preview instead of leaking its URL
        await h.startRecord();
        await h.stopRecord();
        assert.ok(h.st.revoked >= 2, 'revoke old, create new — no URL pile-up');
        assert.equal(h.st.audios[h.st.audios.length - 1].paused, true);
    });

test('VOICE-9: an ended take resets the play-back button by itself',
    async () => {
        const h = await recorded();
        h.click(h.recPlay);
        const a = h.st.audios[0];
        a.onended();                       // browser fires this, nobody clicks
        assert.equal(h.st.pauses, 1);
        assert.match(h.recPlay.textContent, /▶/);
        assert.equal(h.st.revoked, 1);
    });

test('VOICE-9: clear drops the clip but keeps the transcript', async () => {
    const h = await recorded();
    const words = h.ta.value;
    h.click(h.recClear);
    assert.equal(h.trB.disabled, true, 'no clip → AUTO-TRANSCRIBE sleeps again');
    assert.equal(h.recPlay.hidden, true, 'nothing left to play');
    assert.equal(h.recClear.hidden, true);
    assert.equal(h.ta.value, words, 'the transcript survives their own edit or ours');
    h.ta.value = 'typed by hand';
    h.click(h.recClear);                   // clearing twice must not throw
    assert.equal(h.ta.value, 'typed by hand');
    // and a SAVE after clear is refused honestly: no clip in the form
    h.nameI.value = 'Jake';
    const saveB = buttonsOf(h.form).filter(b => b.textContent === 'SAVE VOICE')[0];
    h.click(saveB);
    await settle();
    assert.equal(h.st.posts.length, 0,
        'a cleared take is really gone — nothing half-recorded gets posted');
    assert.match(h.toastMsgs().join('|'), /clip and transcript are all required/);
});

test('VOICE-9: a second take replaces the first and the LAST one saves',
    async () => {
        const h = await mount({ cap: 'full' });
        h.sttS.value = 'whisper';
        await h.startRecord();
        await h.stopRecord();
        assert.equal(h.st.posts.length, 0, 'recording alone posts nothing');
        assert.equal(h.recB.textContent, 'RECORD', 'ready for take two');
        await h.startRecord();                // second take replaces the first
        assert.equal(h.st.gum, 2);
        await h.stopRecord();
        assert.equal(h.st.recs.length, 2);
        assert.equal(h.tracks[0].stopped, true, 'both takes released the mic');
        assert.equal(h.toastMsgs().filter(m => /Clip recorded/.test(m)).length, 2);
        h.nameI.value = 'Jake';
        h.click(buttonsOf(h.form).filter(b => b.textContent === 'SAVE VOICE')[0]);
        await settle();
        assert.equal(h.st.posts.length, 1, 'exactly one voice is created');
        assert.equal(h.st.posts[0].body.ref_name, 'recording.wav');
    });

test('VOICE-9: suggested text — language-aware, replacing, still editable',
    async () => {
        const h = await mount({ cap: 'full' });
        assert.ok(h.promptB, "the 'use suggested text' button lives in the ref area");
        assert.match(h.promptB.title, /sample text for the selected language/);
        assert.equal(h.ta.value, '');
        h.click(h.promptB);
        assert.equal(h.ta.value, h.V._rec.SUGGEST.en, 'en locale, empty Language field');
        h.langS.value = 'Czech';
        h.click(h.promptB);
        assert.equal(h.ta.value, h.V._rec.SUGGEST.cs, 'REPLACES, and follows Language');
        h.ta.value = h.ta.value + ' — my own tail';
        assert.equal(h.ta.readOnly, undefined, 'the textarea is never locked');
        // locale-only resolution (documentElement.lang as the fallback path)
        const k = await mount({ cap: 'none', uiLang: '', docLang: 'de' });
        k.click(k.promptB);
        assert.equal(k.ta.value, k.V._rec.SUGGEST.de,
            'no getLocale lang → document.documentElement.lang');
        const p = await mount({ cap: 'none', uiLang: 'pt-BR' });
        p.click(p.promptB);
        assert.equal(p.ta.value, p.V._rec.SUGGEST.pt);
    });

test('VOICE-9: a partially-capable engine gets silence, not a broken button',
    async () => {
        // drop exactly one leg of the capability stool: MediaRecorder AND
        // getUserMedia AND (webkit)AudioContext must ALL be there to build
        for (const miss of [['MediaRecorder'], ['AudioContext'],
                            ['webkitAudioContext'], ['mediaDevices'],
                            ['getUserMedia'], ['navigator']]) {
            const h = await mount({ cap: 'full', miss: miss,
                                    webkit: miss[0] === 'webkitAudioContext' });
            assert.equal(h.recRow, undefined,
                miss[0] + ' absent → the recorder row is not built at all');
            assert.equal(h.clipF.children.length, 2,
                miss[0] + ' absent → zero DOM delta in the clip field');
            assert.ok(!btnText(h.host, 'RECORD'), miss[0] + ' absent → no RECORD button');
        }
        // ...and with BOTH AudioContext spellings it is still silent-free: builds
        const w = await mount({ cap: 'full', webkit: true });
        assert.ok(w.recB, 'webkitAudioContext (Safari) counts as a capability');
        assert.equal(w.recB.disabled, false);
        await w.startRecord();
        assert.equal(w.st.decodeCalls.length, 0, 'not decoded yet');
        await w.stopRecord();
        assert.equal(w.st.decodeCalls.length, 1, 'prefixed context decodes');
        assert.equal(w.trB.disabled, false);
        assert.equal(w.tracks[0].stopped, true);
    });

test('VOICE-9: a take never overwrites a transcript that already has text',
    async () => {
        const h = await mount({ cap: 'full', uiLang: 'cs' });
        h.ta.value = 'Slova, co jsem napsal sám.';
        h.sttS.value = 'whisper';
        await h.startRecord();
        await h.stopRecord();
        assert.equal(h.ta.value, 'Slova, co jsem napsal sám.',
            'hand-written text outranks our guess, even when we know the sample');
        assert.equal(h.trB.disabled, false, 'the clip itself is still wired in');
    });

test('VOICE-9: the row hides with the clip field for voice_design models',
    async () => {
        // silent-absence doctrine for Qwen3 VoiceDesign: clipF is hidden and
        // the recorder lives INSIDE it, so it hides without its own rule
        const h = await mount({ cap: 'full',
            caps: { qwen3: true, type: 'voice_design', languages: ['english'] } });
        await settle();
        assert.equal(h.clipF.hidden, true, 'the clip field is hidden for design');
        assert.ok(classes(h.clipF, 'vc-trrow').length === 1,
            'the recorder row is still a child of that field — hidden with it');
        assert.ok(h.recB, 'built once, hidden by containment (no second rule)');
    });

test('VOICE-9: a browser that only supports audio/mp4 gets that mime',
    async () => {
        const h = await mount({ cap: 'full', supported: ['audio/mp4'] });
        await h.startRecord();
        assert.equal(h.st.recs[0].mimeType, 'audio/mp4');
        await h.stopRecord();
        assert.equal(h.trB.disabled, false, 'the mp4 take decoded fine');
        assert.equal(h.tracks[0].stopped, true);
        // and with NO advertised mime at all the default container is used
        const g = await mount({ cap: 'full', supported: [] });
        await g.startRecord();
        assert.equal(g.st.recs[0].mimeType, 'audio/webm',
            'no candidate supported → MediaRecorder default, still records');
        await g.stopRecord();
        assert.equal(g.tracks[0].stopped, true);
    });

test('VOICE-9: the recorder strings all go through tf() with EN fallbacks',
    async () => {
        // a Czech catalog must re-label the affordance, not crash on a key
        const h = await mount({ cap: 'full', strings: {
            'uplift.voices.record': 'NAHRÁT',
            'uplift.voices.record_stop': 'STOP',
            'uplift.voices.recording': 'nahrávání… {n}s',
            'uplift.voices.record_insecure': 'https nebo localhost',
            'uplift.voices.prompt_insert': 'použít návrh textu',
        } });
        assert.equal(h.recB.textContent, 'NAHRÁT', 'textContent via tf, translated');
        assert.equal(h.promptB.textContent, 'použít návrh textu');
        await h.startRecord();
        assert.equal(h.recB.textContent, 'STOP');
        h.tickN(3); h.runIntervals();
        assert.equal(h.recSt.textContent, 'nahrávání… 3s', '{n} substituted');
        await h.stopRecord();
        const s = await mount({ cap: 'none' });   // untranslated → EN fallback
        assert.equal(s.promptB.textContent, 'use suggested text');
    });

/* ---- 5. the bug this ticket surfaced in shared voices code ------------ */
test('VOICE-9: re-rendering the form keeps the capability probe a Promise',
    async () => {
        // capsFor() used to store its PROMISE in the cache and then overwrite
        // that entry with the resolved value, so every second voiceForm for
        // the same model (i.e. after each SAVE) died with
        // 'capsFor(...).then is not a function' and the Qwen3 fields stayed
        // hidden forever. The recorder's SAVE flow re-renders, so it is
        // pinned here: value and promise are cached apart.
        const h = await mount({ cap: 'full', caps: { qwen3: true, type: 'base',
                                                     languages: ['english'] } });
        await settle();
        assert.equal(h.langS.parentNode.parentNode.hidden, false,
            'first render revealed the Qwen3 language field');
        const calls = h.st.capCalls.length;
        assert.ok(calls >= 1, 'the probe really ran');
        const p = h.win.Uplift.capsFor('qwen3-tts');
        assert.equal(typeof p.then, 'function', 'cached or not: always a Promise');
        assert.deepEqual(await p, { qwen3: true, type: 'base', languages: ['english'] });
        assert.equal(h.st.capCalls.length, calls, 'the answer is cached, not refetched');
        let err = null;
        try { await h.V.renderVoices(); await settle(); } catch (e) { err = e; }
        assert.equal(err && err.message, null, 're-render must not throw');
        const form2 = classes(h.byId['vc-body'], 'vc-add')[0];
        assert.ok(form2, 'the form rebuilt');
        assert.equal(h.st.capCalls.length, calls, 'still one fetch for the same model');
    });
