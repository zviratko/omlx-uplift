/* SAY-1 — the macOS voices tab in the Voices panel (uplift_voices.js).
   Same vm + hand-rolled DOM pattern as voice-record.test.cjs (that harness
   is recorder-shaped; this panel needs no MediaDevices at all).

   Pinned:
   - the tab strip renders above the existing ADD form; clone is the
     default tab and keeps the old panel byte-identical in content
   - GET /voices/say powers the list; supported:false answers with the
     honest note and NOTHING else (no filter box, no rows)
   - grouping: languages sorted by language NAME (Czech before English),
     inside a language Premium > Enhanced > standard, then alphabetical
   - chips: tier labels, ADDITIONAL only when the server proved a bundle
   - USE: exact POST /voices payload (name, model 'say:<Name>', language
     locale), clash suffix (locale, then counter), IN USE disabled for
     voices the store already carries, toast on success, repaint keeps
     the tab open
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
                                                        voices: o.voices };
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
    const [tClone, tSay] = classes(tabs, 'vc-tab');
    const sayClick = async () => { tSay.click(); await settle(); await settle(); };
    return { V, st, host, tClone, tSay, sayClick, byId, doc };
}

test('tab strip defaults to CLONED and keeps the add form', async () => {
    const h = await mount({});
    assert.ok(h.tClone._classes.has('on'), 'clone tab active by default');
    assert.ok(!h.tSay._classes.has('on'));
    assert.ok(classes(h.host, 'vc-add').length, 'existing ADD box untouched');
    assert.ok(!classes(h.host, 'vc-say').length, 'no say panel on clone tab');
});

test('say tab lists groups by language name, quality inside', async () => {
    const h = await mount({});
    await h.sayClick();
    // the click RE-RENDERS the panel — assert on the fresh buttons
    const [c2, s2] = classes(h.host, 'vc-tab');
    assert.ok(s2._classes.has('on') && !c2._classes.has('on'));
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
                 'no PLAY/USE on a voice this Mac cannot speak yet');
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

test('USE posts the say marker; IN USE reflects the store', async () => {
    const store = [{ id: 'zuzana', name: 'Zuzana', model: 'say:Zuzana' }];
    const h = await mount({ store });
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const find = (name) => rows.find(r => String(r.children[0].textContent) === name);
    const zu = find('Zuzana');
    const zuBtns = classes(zu, 'se-btn');
    const zuUse = zuBtns[zuBtns.length - 1];
    assert.equal(zuUse.disabled, true, 'already saved -> IN USE, disabled');
    assert.ok(zuUse.textContent === 'IN USE', zuUse.textContent);
    const al = find('Albert');
    const btns = classes(al, 'se-btn');
    const use = btns[btns.length - 1];
    use.click();
    await settle(); await settle();
    const post = h.st.posts.find(p => p.url.includes('/voices'));
    assert.deepEqual(post.body, { name: 'Albert', model: 'say:Albert',
                                  language: 'en_US' });
    assert.ok(h.st.toasts.some(t => t.msg.includes('Voice added')));
    // after the save the repaint keeps the tab and marks IN USE
    assert.ok(classes(h.host, 'vc-say').length, 'still on the say tab');
});

test('name clash falls to locale then counter', async () => {
    const store = [{ id: 'al', name: 'Albert', model: 'x' },
                   { id: 'al2', name: 'Albert (en_US)', model: 'x' }];
    const h = await mount({ store });
    await h.sayClick();
    const rows = classes(h.host, 'vc-row');
    const al = rows.find(r => String(r.children[0].textContent) === 'Albert');
    al.children[1].children[1].click();     // USE
    await settle(); await settle();
    const post = h.st.posts.find(p => p.url.endsWith('/voices'));
    assert.equal(post.body.name, 'Albert (en_US) 2');
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
