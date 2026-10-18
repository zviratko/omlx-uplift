/* SAY-1/SAY-2 — the macOS voices tab in the Voices panel
   (uplift_voices.js). Same vm + hand-rolled DOM pattern as
   voice-record.test.cjs (that harness is recorder-shaped; this panel
   needs no MediaDevices at all).

   Pinned:
   - the tab strip renders above the existing ADD form; TTS-2 made TEXT TO
     SPEECH the default — the clone tab opens on click and keeps its panel
   - GET /voices/say powers the list; supported:false answers with the
     honest note and NOTHING else (no filter box, no rows)
   - grouping: languages sorted by language NAME (Czech before English),
     inside a language Premium > Enhanced > standard, then alphabetical
   - chips: tier labels, ADDITIONAL only when the server proved a bundle
   - BUTTON (SAY-2 replaced USE with a star; SAY-2c the star with TEXT):
     exact POST /voices/say/preferred payload {locale, identifier}; a
     preferred_for row shows the PREFERRED FOR chip + lit button reading
     'Clear preferred', its click posts the CLEAR (empty identifier);
     marking repaints from a fresh GET — the client never patches
     preferred_for locally; no pseudo-model voice is ever posted
   - OVERRIDE label (SAY-2c): rows the server flags answers_default get
     'Override macOS default ({voice})' naming the detected default
     voice; a marked one 'Clear override';
     the panel names the detected default (system_voice/system_language)
     and shows NOTHING of the sort when the server could not detect one
   - PLAY: hits /voices/say/speech with only {name} (the greeting text is
     the server's choice — the client never invents sample copy)
   - filter: matches name, raw locale AND language name; no-match message
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = path.join(STATIC_DIR, 'uplift_voices.js');

function makeDom() {
    const byId = {};
    const doc = {};
    function mk(tag) {
        const set = new Set();
        const el = {
            tagName: tag, children: [], style: {}, dataset: {}, attrs: {},
            parentNode: null, hidden: false, value: '', type: '',
            disabled: false, title: '', _text: '',
            get textContent() { return this._text; },
            // DOM spec: assigning textContent REPLACES all children
            // (renderVoices clears the host this way — a property stub
            // that keeps children duplicates every re-render, live catch)
            set textContent(v) {
                (this.children || []).forEach(c => { c.parentNode = null; });
                this.children = [];
                this._text = String(v);
            },
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
            append(...kids) {
                // real DOM turns string args into text nodes; this stub
                // only needs them to not crash and not pollute children
                kids.forEach(c => {
                    if (typeof c === 'string') return;
                    c.parentNode = this; this.children.push(c);
                });
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
            addEventListener() {}, removeEventListener() {},
            focus() {}, blur() {},
            click() { if (el.onclick) el.onclick({ stopPropagation() {} }); },
            classList: {
                add(...c) { c.forEach(x => set.add(x)); },
                remove(...c) { set.delete(c); },
                contains(c) { return set.has(c); },
                toggle(c, on) {
                    if (on === undefined) on = !set.has(c);
                    if (on) set.add(c); else set.delete(c);
                    return on;
                },
            },
        };
        return el;
    }
    doc.createElement = mk;
    doc.body = mk('body');
    doc.getElementById = id => byId[id] || null;
    doc.documentElement = mk('html');
    // ONLY the class selectors this module actually issues are supported
    doc.querySelectorAll = sel => {
        const want = String(sel).replace(/^\./, '').split('.');
        const out = [];
        (function walk(n) {
            for (const c of n.children || []) {
                if (want.every(w => c._classes && c._classes.has(w))) out.push(c);
                walk(c);
            }
        })(doc.body);
        return out;
    };
    doc.addEventListener = () => {};
    return { doc, byId, mk };
}

function allText(n) {
    return (String(n.textContent || '') + ' ' +
        (n.children || []).map(allText).join(' ')).trim();
}
function classes(n, c, out) {
    out = out || [];
    for (const k of n.children || []) {
        if (k._classes && k._classes.has(c)) out.push(k);
        classes(k, c, out);
    }
    return out;
}
const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

const ROSTER = [
    { name: 'Zuzana', locale: 'cs_CZ', quality: 'standard', downloaded: true,
      sample: 'Ahoj! Já jsem Zuzana.' },
    { name: 'Albert', locale: 'en_US', quality: 'standard', downloaded: false,
      sample: 'Hello! My name is Albert.' },
    { name: 'Samantha', locale: 'en_US', quality: 'standard',
      downloaded: false, sample: 'Hello! My name is Samantha.' },
    { name: 'Ava (Enhanced)', locale: 'en_US', quality: 'enhanced',
      downloaded: false, sample: 'Hello, I am Ava.' },
    { name: 'Ava (Premium)', locale: 'en_US', quality: 'premium',
      downloaded: false, sample: 'Hello, I am Ava.' },
    { name: 'Anna', locale: 'de_DE', quality: 'standard', downloaded: false,
      sample: 'Hallo! Ich bin Anna.' },
    // the SERVER normalises every locale to BCP-47 hyphens; fixtures here
    // mirror the delivered shape (en_US stands for the normalised form)
    { name: 'Allison (Enhanced)', locale: 'en_US', quality: 'enhanced',
      downloaded: false, sample: '', identifier: '', installed: false },
];

async function mount(opt) {
    const o = Object.assign({ supported: true, voices: ROSTER, store: [],
                              ls: {} }, opt || {});
    const { doc, byId } = makeDom();
    const st = { posts: [], fetches: [], toasts: [], gets: [] };
    byId['vc-body'] = doc.createElement('div');
    byId['vc-body'].id = 'vc-body';
    byId['vc-sub'] = doc.createElement('span');
    byId['vc-sub'].id = 'vc-sub';
    doc.body.append(byId['vc-body'], byId['vc-sub']);
    let sayCalls = 0;
    const win = {
        console, document: doc, Promise, JSON, Math, Object, Array, String,
        Number, Boolean, RegExp, Set, Map, Error, TypeError, isFinite, isNaN,
        parseInt, parseFloat, setTimeout, clearTimeout,
        Intl: { DisplayNames: (globalThis.Intl || {}).DisplayNames },
        location: { hash: '#models/voices', pathname: '/uplift/', search: '' },
        navigator: {},
        localStorage: {
            getItem: k => (k in o.ls ? o.ls[k] : null),
            setItem: (k, v) => { o.ls[k] = String(v); },
        },
        URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
        Audio: function () { return { play() { st.audioPlays = (st.audioPlays || 0) + 1; },
                                      pause() {}, set src(v) {}, }; },
        fetch: async (u, init) => {
            st.fetches.push({ url: String(u), body: init && init.body });
            return { ok: true, blob: async () => ({ type: 'audio/wav' }) };
        },
        UpliftCore: {
            API: '',
            t: k => k,
            tf: (k, fb) => fb,
            normalize: x => x,
        },
        UpliftDom: {
            $: id => doc.getElementById(id),
            fetchJson: async (u) => {
                u = String(u); st.gets.push(u);
                if (u.includes('/voices/say')) return { supported: o.supported,
                                                        voices: o.voices,
                                                        system_language: o.sysl || '',
                                                        system_voice: o.sysv || '' };
                return { voices: o.store };
            },
            postJson: async (u, b) => { st.posts.push({ url: String(u), body: b });
                                         return {}; },
            putJson: async () => ({}), deleteJson: async () => ({}),
            toast: (msg, ms, cls) => st.toasts.push(
                { msg: String(msg), cls: typeof ms === 'string' ? ms : cls }),
            emptyMsg: (el, msg) => { el.textContent = msg; },
        },
        Uplift: {
            state: { API: '' },
            modelmgr: { adminModels: [
                { id: 'qwen3-tts', name: 'Qwen3-TTS', engine_type: 'audio_tts' },
            ] },
        },
    };
    win.window = win; win.self = win;
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), vm.createContext(win),
                    { filename: SRC });
    const V = win.Uplift.voices;
    await V.renderVoices();
    await settle();
    const host = byId['vc-body'];
    const tabs = classes(host, 'vc-tabs')[0];
    assert.ok(tabs, 'tab strip renders above everything');
    // TTS-1 inserted TEXT TO SPEECH between clone and say: the say tab is
    // picked by its LABEL, never by its index (an index pin silently
    // re-points every test at the wrong tab the moment the strip grows).
    const tabBtns = classes(tabs, 'vc-tab');
    const byText = (frag) => tabBtns.find(b => String(b.textContent).includes(frag));
    const tClone = byText('CLONED');
    const tSay = byText('macOS');
    assert.ok(tClone && tSay, 'clone + macOS tabs exist by name');
    const sayClick = async () => { tSay.click(); await settle(); await settle(); };
    return { V, st, host, tClone, tSay, tTts: byText('TEXT TO SPEECH'),
             sayClick, byId, doc };
}

test('tab strip defaults to TEXT TO SPEECH; clone keeps the add form', async () => {
    // TTS-2 (user): TEXT TO SPEECH became the first/default tab — the clone
    // panel is one click away and unchanged
    const h = await mount({});
    assert.ok(h.tTts._classes.has('on'), 'tts tab active by default');
    assert.ok(!h.tClone._classes.has('on'), 'clone is no longer the default');
    assert.ok(!h.tSay._classes.has('on'));
    assert.ok(!classes(h.host, 'vc-say').length, 'no say panel on the tts tab');
    h.tClone.click();
    await settle(); await settle();
    // the click RE-RENDERS the strip — assert on the fresh buttons
    const fresh = classes(h.host, 'vc-tab');
    const onClone = fresh.find(b => String(b.textContent).includes('CLONED'));
    assert.ok(onClone._classes.has('on'), 'clone opens on its click');
    assert.ok(classes(h.host, 'vc-add').length, 'existing ADD box untouched');
});

test('say tab lists groups by language name, quality inside', async () => {
    const h = await mount({});
    await h.sayClick();
    // the click RE-RENDERS the panel — assert on the fresh buttons
    const fresh = classes(h.host, 'vc-tab');
    const onOf = (frag) => fresh.find(b => String(b.textContent).includes(frag));
    assert.ok(onOf('macOS')._classes.has('on') && !onOf('CLONED')._classes.has('on'));
    // folded by default: rows exist in the DOM but every group is hidden
    for (const g of classes(h.host, 'vc-say-grp')) {
        assert.equal(g.hidden, true, 'groups collapse by default');
    }
    assert.ok(!classes(h.host, 'vc-add').length,
              'the clone form is off-tab — one box at a time');
    const heads = classes(h.host, 'vc-say-label').map(n => n.textContent);
    // English / Czech / German by language NAME (Czech < English < German)
    assert.deepEqual(heads, ['Czech · cs_CZ', 'English · en_US',
                             'German · de_DE'], heads);
    // depth-first walk keeps document order: rows follow their header
    const names = classes(h.host, 'vc-row').map(r => String(r.children[0].textContent));
    // tier first, then alphabetical (Allison precedes Ava inside Enhanced)
    assert.deepEqual(names, ['Zuzana', 'Ava (Premium)', 'Allison (Enhanced)',
                             'Ava (Enhanced)', 'Albert', 'Samantha',
                             'Anna'], JSON.stringify(names));
});

test('catalog rows: greyed, no buttons, NOT DOWNLOADED, split counts', async () => {
    const h = await mount({});
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const ab = rows.find(r => String(r.children[0].textContent)
        === 'Allison (Enhanced)');
    assert.ok(ab, 'the downloadable-but-absent voice is listed');
    assert.ok(ab._classes.has('vc-say-off'), 'rendered dimmed');
    assert.ok(allText(ab).includes('NOT DOWNLOADED'), allText(ab));
    assert.equal(classes(ab, 'se-btn').length, 0,
                 'no PLAY/mark button on a voice this Mac cannot speak yet');
    const heads = classes(h.host, 'vc-say-head');
    const counts = heads.map(n => n.children[2].textContent);
    assert.deepEqual(counts, ['1', '4/5', '1'], counts);
    const enHead = heads[1];
    assert.ok(enHead.children[2].title.includes('speakable now'),
              'the split count explains itself');
});

test('chips: tier labels and ADDITIONAL only when proven', async () => {
    const h = await mount({});
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const byName = {};
    for (const r of rows) byName[String(r.children[0].textContent)] = r;
    assert.ok(allText(byName['Ava (Premium)']).includes('PREMIUM'));
    assert.ok(allText(byName['Ava (Enhanced)']).includes('ENHANCED'));
    assert.ok(!allText(byName['Albert']).includes('PREMIUM'));
    assert.ok(allText(byName['Zuzana']).includes('DOWNLOADED'),
              'downloaded bundle proven by the server -> badged');
    assert.ok(!allText(byName['Albert']).includes('DOWNLOADED'),
              'unproven -> NO badge at all (never claim System)');
});

/* TTS-3 (user): the voice macOS ALREADY uses for a language was invisible
   — the server has always carried the per-language isDefault fact ('default'
   on the row) and only ever surfaced the SYSTEM-language override wording. */
test('DEFAULT chip: the row that is already the macOS default says so', async () => {
    const voices = ROSTER.map(v => Object.assign({}, v));
    voices[0].default = true;              // Zuzana: cs_CZ
    voices[2].default = true;              // Samantha: en_US
    voices[2].identifier = 'com.apple.voice.compact.en-US.Samantha';
    const h = await mount({ voices });
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const find = (name) => rows.find(r =>
        String(r.children[0].textContent) === name);
    assert.ok(allText(find('Zuzana')).includes('macOS DEFAULT'));
    assert.ok(allText(find('Samantha')).includes('macOS DEFAULT'));
    assert.ok(!allText(find('Albert')).includes('DEFAULT'),
              'a row that is nobody\'s default carries no chip');
    const chip = classes(find('Zuzana'), 'vc-chip-def')[0];
    assert.ok(chip.title.includes('cs_CZ'),
              'the tooltip names which language: ' + chip.title);
    // the chip is a FACT about the system: neutral chip ground, never the
    // amber user-mark styling (vc-chip-pref stays the mark's alone)
    assert.ok(!chip._classes.has('vc-chip-pref'));
    // TTS-3b (user): an UNMARKED default row gets no mark button — marking
    // the default as preferred for its own language changes nothing
    assert.equal(classes(find('Zuzana'), 'vc-pref').length, 0,
                 'Samantha-style rows no longer offer to override themselves');
    assert.equal(classes(find('Albert'), 'vc-pref').length, 1,
                 'non-default rows keep the button');
    // a default row carrying a STALE redundant mark keeps 'Clear
    // preferred' — the mark must stay removable from the UI
    const dv = ROSTER.map(v => Object.assign({}, v));
    dv[0].default = true;
    dv[0].preferred_for = 'cs_CZ';
    const h2 = await mount({ voices: dv });
    await h2.sayClick();
    const rows2 = classes(h2.host, 'vc-row');
    const zu2 = rows2.find(r => String(r.children[0].textContent) === 'Zuzana');
    assert.equal(classes(zu2, 'vc-pref')[0].textContent, 'Clear preferred');
});

test('BUTTON posts the preferred mark; label text, PREFERRED FOR chip reflect the server', async () => {
    const voices = ROSTER.map(v => Object.assign({}, v));
    voices[0].preferred_for = 'cs_CZ';      // Zuzana answers say+cs-CZ
    voices[0].identifier = 'com.apple.voice.compact.cs-CZ.Zuzana';
    const h = await mount({ voices });
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const find = (name) => rows.find(r => String(r.children[0].textContent) === name);
    const zu = find('Zuzana');
    assert.ok(allText(zu).includes('PREFERRED FOR cs_CZ'), allText(zu));
    const zuBtn = classes(zu, 'vc-pref')[0];
    assert.ok(zuBtn._classes.has('on'), 'marked row shows the lit button');
    assert.equal(zuBtn.textContent, 'Clear preferred',
                 'SAY-2c: the star is a TEXT button now');
    const al = find('Albert');
    const alBtn = classes(al, 'vc-pref')[0];
    assert.ok(!alBtn._classes.has('on'));
    assert.equal(alBtn.textContent, 'Mark preferred');
    assert.ok(!('i18n' in alBtn.dataset),
              'placeholder label: no dataset.i18n (applyI18n could not repaint it)');
    // marking Albert for English: exact payload, routed to the map endpoint
    alBtn.click();
    await settle(); await settle();
    const post = h.st.posts.find(p => p.url.includes('/voices/say/preferred'));
    assert.deepEqual(post.body, { locale: 'en_US', identifier: 'Albert' });
    // repaint comes from a FRESH GET (server owns preferred_for), not a
    // local patch — and nothing ever posts a pseudo-model voice
    assert.ok(!h.st.posts.some(p => /\/voices$/.test(p.url)),
              'SAY-2: the tab never creates stored say voices');
    assert.ok(h.st.gets.filter(u => u.includes('/voices/say')).length >= 2,
              'the catalogue was re-read after the mark');
    assert.ok(classes(h.host, 'vc-say').length, 'still on the say tab');
    // clicking the lit button CLEARS the mark for its language
    const rows2 = classes(h.host, 'vc-row');
    const zuBtn2 = classes(rows2.find(r =>
        String(r.children[0].textContent) === 'Zuzana'), 'vc-pref')[0];
    zuBtn2.click();
    await settle(); await settle();
    const clr = h.st.posts.filter(p => p.url.includes('/voices/say/preferred'))[1];
    assert.deepEqual(clr.body,
        { locale: 'cs_CZ', identifier: '' });
});

test('OVERRIDE label (SAY-2c): default-language rows say what they override', async () => {
    const voices = ROSTER.map(v => Object.assign({}, v));
    for (const v of voices) {
        if (v.locale === 'en_US') v.answers_default = true;
    }
    voices[1].preferred_for = 'en_US';      // Albert already overrides
    const h = await mount({ voices, sysl: 'en_US', sysv: 'Samantha' });
    await h.sayClick();
    // the panel names the default it speaks of
    const sys = classes(h.host, 'vc-say-sys')[0];
    assert.ok(sys, 'the system-default line renders when the server detected one');
    assert.ok(String(sys.textContent).includes('Samantha (en_US)'),
              sys.textContent);
    const rows = classes(h.host, 'vc-row');
    const find = (name) => rows.find(r => String(r.children[0].textContent) === name);
    const alBtn = classes(find('Albert'), 'vc-pref')[0];
    assert.ok(alBtn._classes.has('on'));
    assert.equal(alBtn.textContent, 'Clear override (Samantha)',
                 'the button names the default VOICE it overrides, not the locale');
    const saBtn = classes(find('Samantha'), 'vc-pref')[0];
    assert.equal(saBtn.textContent, 'Override macOS default (Samantha)');
    // the Czech rows stay plain favourites
    assert.equal(classes(find('Zuzana'), 'vc-pref')[0].textContent,
                 'Mark preferred');
    // marking the override row posts the SAME payload (one endpoint, one map)
    saBtn.click();
    await settle(); await settle();
    const post = h.st.posts.find(p => p.url.includes('/voices/say/preferred'));
    assert.deepEqual(post.body,
        { locale: 'en_US', identifier: 'Samantha' });
});

test('undetected system language: no default line, no override promise', async () => {
    const voices = ROSTER.map(v => Object.assign({}, v));
    const h = await mount({ voices });        // sysl '' — Linux/unknown
    await h.sayClick();
    assert.equal(classes(h.host, 'vc-say-sys').length, 0);
    for (const b of classes(h.host, 'vc-pref')) {
        assert.ok(String(b.textContent).indexOf('Override') < 0,
                  'no button may promise an override without a detected default');
    }
});

test('mark buttons survive the clone-store: stored voices are irrelevant', async () => {
    // SAY-1 stored say voices must NOT dim or disable anything: the mark
    // button is the language map, independent of the voice store
    const store = [{ id: 'zuzana', name: 'Zuzana', model: 'say:Zuzana' }];
    const h = await mount({ store });
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const zu = rows.find(r => String(r.children[0].textContent) === 'Zuzana');
    const btn = classes(zu, 'vc-pref')[0];
    assert.equal(btn.disabled, false);
    assert.ok(!allText(zu).includes('IN USE'), 'IN USE is gone with USE');
});

test('PLAY auditions with the roster greeting chosen by the SERVER', async () => {
    const h = await mount({});
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const zu = rows.find(r => String(r.children[0].textContent) === 'Zuzana');
    const play = classes(zu, 'vc-play')[0];
    play.click();
    await settle(); await settle();
    const f = h.st.fetches.find(x => x.url.includes('/voices/say/speech'));
    assert.ok(f, 'speech request went out');
    const body = JSON.parse(f.body);
    assert.deepEqual(Object.keys(body), ['name']);
    assert.equal(body.name, 'Zuzana');
});

test('unsupported server: the honest note, nothing else', async () => {
    const h = await mount({ supported: false, voices: [] });
    await h.sayClick();
    const box = classes(h.host, 'vc-say')[0];
    const text = allText(box);
    assert.ok(text.includes('not available on this server'), text);
    assert.equal(classes(box, 'vc-row').length, 0);
    assert.equal(classes(box, 'vc-say-filter').length, 0);
});

test('filter matches name, locale AND language name', async () => {
    const h = await mount({});
    await h.sayClick();
    const input = classes(h.host, 'vc-say-filter')[0];
    const rowsBox = classes(h.host, 'vc-list')[0];
    input.value = 'german';
    input.oninput();
    let names = classes(rowsBox, 'vc-name').map(n => String(n.textContent));
    assert.deepEqual(names, ['Anna'], JSON.stringify(names));
    input.value = 'cs';
    input.oninput();
    names = classes(rowsBox, 'vc-name').map(n => String(n.textContent));
    assert.deepEqual(names, ['Zuzana'], JSON.stringify(names));
    input.value = 'zzzz';
    input.oninput();
    assert.equal(classes(rowsBox, 'vc-row').length, 0);
    assert.ok(allText(rowsBox).includes('No macOS voice matches'),
              'empty state is translated, not blank');
});

test('folds: collapsed by default, click expands, choice is remembered', async () => {
    const ls = {};
    const h = await mount({ ls });
    await h.sayClick();
    const heads = classes(h.host, 'vc-say-head');
    const grps = classes(h.host, 'vc-say-grp');
    assert.equal(heads.length, 3);
    assert.ok(grps.every(g => g.hidden), 'all folded on first visit');
    assert.equal(allText(heads[0]).includes('▸'), true, 'closed arrow');
    heads[0].click();                       // open Czech
    assert.equal(grps[0].hidden, false);
    assert.ok(allText(heads[0]).includes('▾'), 'open arrow');
    assert.equal(JSON.parse(ls['uplift.vcSayOpen']).cs_CZ, true,
                 'click persists the choice');
    assert.ok(!('en_US' in JSON.parse(ls['uplift.vcSayOpen'])),
              'groups the user never touched stay unrecorded (default closed)');
    // REOPEN the page with the saved map: only Czech greets you open
    const h2 = await mount({ ls });
    await h2.sayClick();
    const grps2 = classes(h2.host, 'vc-say-grp');
    assert.equal(grps2[0].hidden, false, 'remembered open survives a reload');
    assert.ok(grps2.slice(1).every(g => g.hidden), 'others stay folded');
    // and clicking again CLOSES + records that too
    classes(h2.host, 'vc-say-head')[0].click();
    assert.equal(JSON.parse(ls['uplift.vcSayOpen']).cs_CZ, false);
});

test('filter reveals matches WITHOUT rewriting the remembered folds', async () => {
    const ls = { 'uplift.vcSayOpen': JSON.stringify({ de_DE: true }) };
    const h = await mount({ ls });
    await h.sayClick();
    const heads = classes(h.host, 'vc-say-head');
    const grps = classes(h.host, 'vc-say-grp');
    assert.equal(grps[0].hidden, true);            // cs folded (unrecorded)
    assert.equal(grps[2].hidden, false);           // de open (remembered)
    const input = classes(h.host, 'vc-say-filter')[0];
    input.value = 'zuzana';
    input.oninput();
    const g2 = classes(h.host, 'vc-say-grp');
    assert.ok(g2.every(g => g.hidden === false),
              'matched groups show while filtering, folded or not');
    assert.deepEqual(JSON.parse(ls['uplift.vcSayOpen']), { de_DE: true },
                     'filtering wrote nothing to the remembered folds');
    input.value = '';
    input.oninput();
    const g3 = classes(h.host, 'vc-say-grp');
    assert.equal(g3[0].hidden, true, 'the fold returns with the filter');
    assert.equal(g3[2].hidden, false);
});

test('hidden-state CSS guard exists (a display rule could outspec [hidden])', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.ok(/\.vc-say-grp\[hidden\]\s*\{\s*display:\s*none/.test(css),
              '.vc-say-grp[hidden]{display:none} must ride alongside the fold');
    // rows indent under their language header (user: 'add some
    // indentation after the language is expanded')
    assert.ok(/\.vc-say-grp \.vc-row \{ padding-left: 38px; \}/.test(css),
              'voice rows indent inside the expanded group');
    // the header speaks at the same size as the voices below it
    const head = css.match(/\.vc-say-head \{[^}]*font: ([^;]+);/);
    const name = css.match(/^\.vc-name \{[^}]*font: ([^;]+);/m);
    assert.ok(head && name && head[1] === name[1],
              'language header font == voice name font ('
              + (head && head[1]) + ' vs ' + (name && name[1]) + ')');
});

test('voiceLabel hides the marker behind a macOS tag', async () => {
    const h = await mount({});
    assert.equal(h.V.constructor === Object ? 1 : 1, 1);   // keep lint calm
    // the export carries voiceLabel; verify both shapes through it
    const label = h.V.voiceLabel;
    assert.equal(label({ name: 'Zuzana', model: 'say:Zuzana' }),
                 'Zuzana (macOS)');
    assert.equal(label({ name: 'Jake', model: 'Qwen3-TTS' }),
                 'Qwen3-TTS:Jake');
    assert.equal(label({ name: 'Solo', model: '' }), 'Solo');
});
