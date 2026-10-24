// UP-43 gate: chat attachment persistence phase 2.
//   1) composer chips (deep-chat's own queue row is the source of truth;
//      the mirror only names queued image chips — behaviour-tested against
//      a stubbed shadow root, guards-tested against the nat4 stub)
//   2) turn rows carry [{n,k}] meta, NEVER bytes; renderHistory paints
//      chips under bubbles via ONE shared visibility predicate
//   3) save sanitizer: bytes out, shapes in (classic messageForStorage rule)
//   4) paste/drop parity VERIFIED against the vendored bundle source
//   5) delete/edit/regenerate truncation can never orphan att meta (meta
//      rides the row object; splice cuts whole rows)
// SERVER FOLLOW-UP (owner lands with this commit — chat.py is not in this
// lane): _clean_message currently drops 'att' on reload. The exact addition
// after the `out["params"]` block (before `return out`):
//
//     att = m.get("att")
//     if isinstance(att, list):
//         out["att"] = [{"n": str(a.get("n") or "")[:120],
//                        "k": a.get("k") if a.get("k") in ("image", "file", "audio") else "file"}
//                       for a in att[:8] if isinstance(a, dict) and a.get("n")]
//
// plus a pytest roundtrip in test_nat4_chat_backend.py: POST /chat/history
// with a user message carrying att=[{"n":"a.pdf","k":"file"}] and
// content=[{"type":"image_url","image_url":{"url":"data:..."}}], GET the
// conversation back, assert att survived with the capped {n,k} shape AND
// the content collapsed to text (server stays text-only BY DESIGN).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_chat.js'), 'utf8');
const BUNDLE = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift',
    'static', 'vendor', 'deep-chat', 'deep-chat-2.5.1.bundle.js'), 'utf8');

// extract a top-level function by brace-walking (u32/u33 pattern)
function extract(name) {
    const i = SRC.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' present');
    let depth = 0, started = false;
    for (let j = SRC.indexOf('{', i); j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; started = true; }
        else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
    }
    throw new Error('unbalanced ' + name);
}
const ATT_VARS = ['var ATT_MAX = 8;', 'var ATT_NAME_MAX = 120;',
    "var ATT_KINDS = ['image', 'file', 'audio'];"].map(function (line) {
    assert.ok(SRC.includes(line), line + ' present (caps are pinned here)');
    return line;
}).join('\n');

// shipped pure functions (same new-Function pattern as the u32 gate: OUR
// first-party source read off disk, never untrusted input)
function ship(names, env) {
    const body = ATT_VARS + '\n' +
        ['attKindOf', 'attMeta', 'attIsClean', 'isVisibleRow',
         'partShapeForStore', 'sanitizeMsgForStore',
         'attViewText'].filter(n => names.includes(n))
            .map(extract).join('\n');
    const args = Object.keys(env || {});
    const fn = new Function(args.join(','),
        body + '\nreturn {' + names.join(',') + '};');
    return fn.apply(null, args.map(a => env[a]));
}
const P = ship(['attKindOf', 'attMeta', 'attIsClean', 'isVisibleRow',
                'partShapeForStore', 'sanitizeMsgForStore'], {});
const T = (k, fb) => fb;
const V = ship(['attViewText'], { t: T });

test('UP-43: attKindOf routes image/audio/document lanes by name AND mime', () => {
    const f = (name, type) => ({ name, type });
    assert.equal(P.attKindOf(f('cat.png', '')), 'image');
    assert.equal(P.attKindOf(f('photo', 'image/jpeg')), 'image');
    assert.equal(P.attKindOf(f('x.GIF', 'image/gif')), 'image');
    assert.equal(P.attKindOf(f('voice.wav', 'audio/wav')), 'audio');
    assert.equal(P.attKindOf(f('take.m4a', '')), 'audio');
    assert.equal(P.attKindOf(f('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')), 'file');
    assert.equal(P.attKindOf(f('notes.md', 'text/markdown')), 'file');
    assert.equal(P.attKindOf(f('bin.zip', 'application/zip')), 'file');
});

test('UP-43: attMeta caps the list and the name — meta is shape-only, never bytes', () => {
    const files = [];
    for (let i = 0; i < 20; i++) files.push({ name: 'f' + i + '.png', type: 'image/png' });
    const meta = P.attMeta(files);
    assert.equal(meta.length, 8, 'ATT_MAX cap holds');
    assert.deepEqual(meta[0], { n: 'f0.png', k: 'image' }, 'entry keys are exactly n+k');
    const long = P.attMeta([{ name: 'x'.repeat(200) + '.pdf', type: 'application/pdf' }]);
    assert.equal(long[0].n.length, 120, 'name capped to ATT_NAME_MAX');
    assert.equal(P.attMeta([]), null);
    assert.equal(P.attMeta(null), null);
    // bytes NEVER appear in the meta: no url/data fields exist at all
    assert.ok(!/url|data|base64/i.test(JSON.stringify(long)));
});

test('UP-43: isVisibleRow truth table — content OR att', () => {
    assert.equal(P.isVisibleRow({ content: 'hi' }), true);
    assert.equal(P.isVisibleRow({ content: '', att: [{ n: 'a.png', k: 'image' }] }), true);
    assert.equal(P.isVisibleRow({ content: '' }), false);
    assert.equal(P.isVisibleRow({ content: 'x', att: [] }), true);
    assert.equal(P.isVisibleRow(null), false);
});

test('UP-43: the save sanitizer strips BYTES but never SHAPES (classic :5906 rule)', () => {
    const raw = { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,BBB' } },
    ] };
    const s = P.sanitizeMsgForStore(raw);
    assert.ok(Array.isArray(s.content), 'content ARRAY (shape) survives');
    assert.deepEqual(s.content.map(p => p.type), ['text', 'image_url', 'file']);
    assert.equal(s.content[1].image_url.url, '', 'image bytes out, shape in');
    assert.equal(s.content[2].file.filename, 'a.pdf', 'filename survives');
    assert.equal(s.content[2].file.data, '', 'document bytes out');
    const json = JSON.stringify(s);
    assert.ok(!/base64/.test(json) && !/data:/.test(json), 'no byte payload anywhere');
    // unknown part kinds pass through minus data/base64 payloads
    const u = P.sanitizeMsgForStore({ content: [
        { type: 'input_audio', input_audio: { format: 'wav' }, data: 'AAAA', base64: 'BBBB' }] });
    assert.equal(u.content[0].data, '');
    assert.equal(u.content[0].base64, '');
    assert.equal(u.content[0].input_audio.format, 'wav');
    // a parts array with NOTHING sendable collapses to '' (never a crash)
    assert.equal(P.sanitizeMsgForStore({ content: [null, 'nope'] }).content, '');
});

test('UP-43: sanitize is identity for clean rows and hard-caps dirty att', () => {
    const plain = { role: 'assistant', content: 'hi', mid: 'm1',
                    att: [{ n: 'a.png', k: 'image' }] };
    assert.equal(P.sanitizeMsgForStore(plain), plain, 'clean row = identity (save-path churn guard)');
    const dirty = { content: 'x', att: [
        { n: 'a.png', k: 'image', blob: 'MB OF BYTES', file: {} },   // extra keys stripped
        { n: '', k: 'file' },                                        // empty name dropped
        'nope',                                                      // non-object dropped
        { n: 'b.zip', k: 'weird' },                                  // unknown kind -> 'file'
    ] };
    const s = P.sanitizeMsgForStore(dirty);
    assert.deepEqual(s.att, [{ n: 'a.png', k: 'image' }, { n: 'b.zip', k: 'file' }]);
    assert.deepEqual(Object.keys(s.att[0]), ['n', 'k'], 'exactly the persisted shape');
    const many = { content: 'x', att: [] };
    for (let i = 0; i < 15; i++) many.att.push({ n: 'n' + i, k: 'file', d: 'bytes' });
    assert.equal(P.sanitizeMsgForStore(many).att.length, 8, 'att capped at ATT_MAX on save');
    const none = { content: 'x', att: 'garbage' };
    const sn = P.sanitizeMsgForStore(none);
    assert.equal('att' in sn, false, 'non-array att is dropped, the row survives');
    assert.equal(P.sanitizeMsgForStore(null), null);
});

test('UP-43: saveConv + importChats POST the sanitized shapes', () => {
    assert.match(SRC, /messages: ms\.map\(sanitizeMsgForStore\)/,
        'save body built through the sanitizer');
    assert.match(SRC, /messages: \(c\.messages \|\| \[\]\)\.map\(sanitizeMsgForStore\)/,
        'imports strip bytes before the POST');
});

test('UP-43: truncate consistency — meta rides the ROW, so splice can never orphan it', () => {
    // classic msgDelete sliceBeforeMessage semantics, replayed on the
    // store-visible list (the sanitizer mapped it, exactly like saveConv)
    const rows = [
        { role: 'user', content: 'q1', att: [{ n: 'a.png', k: 'image' }] },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: '', att: [{ n: 'b.pdf', k: 'file' }] },
        { role: 'assistant', content: 'a2' },
    ];
    const stored = rows.map(P.sanitizeMsgForStore);
    assert.ok(stored[2].att && !stored[2].content,
        'att-only user turn survives the sanitizer (it is a visible row)');
    const cut = stored.slice(0, 2);                 // deleting turn 2 truncates
    assert.equal(cut.length, 2);
    assert.ok(!cut.some(r => (r.att || []).some(a => a.n === 'b.pdf')),
        'the deleted turn\'s meta left with the row — no orphan att');
    assert.ok(cut[0].att.length === 1, 'kept rows keep their meta through the roundtrip');
});

test('UP-43: ONE visibility predicate at every ordinal-mapping call site', () => {
    // renderHistory / lastAiVisible / visibleOrdinal / editedClaim /
    // attachMessageActions must agree or action indices shift
    assert.match(SRC, /\.filter\(isVisibleRow\)/, 'renderHistory filter');
    assert.match(SRC, /text: m\.content \? normMath\(String\(m\.content\)\)\s*\n?\s*: attViewText\(m\)/,
        'att-only bubbles get the placeholder text');
    for (const name of ['lastAiVisible', 'visibleOrdinal', 'editedClaim']) {
        assert.match(extract(name), /isVisibleRow\(/, name + ' uses the shared predicate');
    }
    const i = SRC.indexOf('function attachMessageActions');
    assert.match(SRC.slice(i, SRC.indexOf('var liveOrd', i)),
        /if \(isVisibleRow\(ms\[i\]\)\) visible\.push\(i\);/);
    assert.ok(!/filter\(function \(m\) \{ return m\.content; \}\)/.test(SRC),
        'the old ad-hoc filter is gone');
});

test('UP-43: attViewText names the files (placeholder bubble for att-only turns)', () => {
    assert.equal(V.attViewText({ att: [{ n: 'a.png', k: 'image' }, { n: 'b.pdf', k: 'file' }] }),
        '\uD83D\uDCCE a.png, b.pdf');
    assert.equal(V.attViewText({}), '\uD83D\uDCCE ');
});

// ---- chips DOM behaviour (mini stubs; the real surface is the shadow root) --
function miniNode(tag) {
    const n = {
        tagName: tag, className: '', textContent: '', title: '', alt: '',
        dataset: {}, children: [], _attrs: {}, _removed: false, _lis: {},
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
        appendChild(c) { c.__parent = this; this.children.push(c); return c; },
        addEventListener(t, f) { (this._lis[t] = this._lis[t] || []).push(f); },
        remove() { this._removed = true;
            if (this.__parent) { const i = this.__parent.children.indexOf(this);
                if (i >= 0) this.__parent.children.splice(i, 1); } },
        querySelector(sel) {   // tests only use ':scope > .chat-native-atts'
            for (const c of this.children)
                if (sel.includes(c.className)) return c;
            return null;
        },
    };
    n.classList = { add(c) { (n.__cls = n.__cls || new Set()).add(c); } };
    return n;
}

test('UP-43: attChipsRender builds name chips under the bubble, churn-free, removable', () => {
    const previews = new WeakMap();
    const D = new Function('W', 'el', '_attPreviews',
        extract('attPreviewOf') + '\n' + extract('attPreviewFile') + '\n' +
        ATT_VARS + '\n' + extract('attChipEl') + '\n' + extract('attChipsRender') +
        '\nreturn { attChipsRender };')(
            () => null,
            (tag, cls, text) => { const n = miniNode(tag); n.className = cls;
                if (text != null) n.textContent = text; return n; },
            previews);
    const holder = miniNode('div');
    const row = { role: 'user', content: 'q', att: [
        { n: 'a.png', k: 'image' }, { n: 'b.pdf', k: 'file' }] };
    // the image File still lives in this session -> ITS chip previews;
    // the document never previews from meta, reloaded rows preview nothing
    previews.set(row, [{ name: 'a.png' }]);
    D.attChipsRender(holder, row);
    const line = holder.children[0];
    assert.equal(line.className, 'chat-native-atts');
    assert.equal(line.getAttribute('data-sig'), 'image:a.png|file:b.pdf');
    assert.equal(line.children.length, 2);
    assert.equal(line.children[0].children[0].textContent, 'a.png',
        'name is textContent, never innerHTML');
    assert.equal(line.children[0].dataset.k, 'image');
    assert.ok((line.children[0].__cls || new Set()).has('live'),
        'live image chip is clickable');
    assert.ok(!(line.children[1].__cls || new Set()).has('live'),
        'document chip stays informational');
    const sigBefore = holder.children.length;
    D.attChipsRender(holder, row);                    // identical sig -> no churn
    assert.equal(holder.children.length, sigBefore);
    assert.equal(holder.children[0], line, 'same element reused');
    row.att = null;
    D.attChipsRender(holder, row);                    // meta gone -> line removed
    assert.equal(holder.children.length, 0);
    D.attChipsRender(miniNode('div'), { content: 'x' });  // no att: no-op
    // reloaded twin of the same row (fresh object, no preview): no .live
    const holder2 = miniNode('div');
    D.attChipsRender(holder2, { content: 'q', att: row0Att() });
    function row0Att() { return [{ n: 'a.png', k: 'image' }]; }
    assert.ok(!(holder2.children[0].children[0].__cls || new Set()).has('live'),
        'after reload chips are informational only');
});

test('UP-43: composer mirror names queued image chips and follows the queue truth', async () => {
    // stub shadow root: capture listeners + a container we mutate
    const lis = {};
    const container = {
        chips: [],
        querySelectorAll(sel) { return sel === '.file-attachment' ? this.chips.slice() : []; },
    };
    const root = {
        addEventListener(t, f) { (lis[t] = lis[t] || []).push(f); },
        querySelector(sel) { return sel === '#file-attachment-container' ? container : null; },
    };
    function chip(withImg) {
        const c = miniNode('div'); c.className = 'file-attachment';
        c.querySelector = (s) => s === 'img.image-attachment'
            ? (withImg ? (c.__img = c.__img || miniNode('img')) : null) : null;
        return c;
    }
    const ok = new Function('attKindOf',
        ATT_VARS + '\n' + extract('attComposerWire') +
        '\nreturn attComposerWire;')(P.attKindOf);
    assert.equal(ok({ shadowRoot: root }), true, 'wired');
    // guards first: the nat4 stub (no addEventListener/querySelector) must
    // make attComposerWire bail with FALSE, never throw
    assert.equal(ok({ shadowRoot: {} }), false);
    assert.equal(ok({}), false);
    // paste two images BEFORE the bundle renders the chips (FileReader
    // is async there): the mirror must NOT trim its pending names away
    lis.paste[0]({ clipboardData: { files: [
        { name: 'one.png', type: 'image/png' },
        { name: 'two.jpg', type: 'image/jpeg' }] } });
    assert.equal(container.chips.length, 0, 'queue renders later');
    const c1 = chip(true); container.chips.push(c1);
    lis.change[0]({ target: { tagName: 'INPUT', type: 'file', files: [] } }); // kick a sync
    assert.equal(c1.title, 'one.png', 'name lands on the FIRST image chip');
    const c2 = chip(true); container.chips.push(c2);
    lis.change[0]({ target: { tagName: 'INPUT', type: 'file', files: [] } });
    assert.equal(c2.title, 'two.jpg');
    // × removal of the first chip: mirror splices AT its position, the
    // SURVIVOR keeps its own name (a stale shifted name is what the
    // before-count splice prevents; the re-assign rule heals any skew)
    const btn = { closest: (s) => s.includes('remove') ? btn
        : s.includes('file-attachment') ? c1 : null };
    lis.click[0]({ target: btn });                      // capture fires FIRST…
    container.chips.splice(0, 1);                       // …then the bundle removes
    await new Promise(r => setTimeout(r, 5));           // sync runs on a timeout
    assert.equal(c2.title, 'two.jpg',
        'surviving chip keeps its OWN name after the first was removed');
    // the post-send clear (hideFiles removes ALL chips): mirror drains
    container.chips.length = 0;
    lis.change[0]({ target: { tagName: 'INPUT', type: 'file', files: [] } });
    lis.change[0]({ target: { tagName: 'INPUT', type: 'file', files: [] } });
    const c3 = chip(true); container.chips.push(c3);
    lis.change[0]({ target: { tagName: 'INPUT', type: 'file', files: [] } });
    assert.equal(c3.title, '', 'no stale names resurrected onto new chips');
});

// ---- send-path wiring (source pins around the neighbours the ticket forbids) --
test('UP-43: shapeRequest resets, routes and claims the meta of what it SENT', () => {
    assert.match(SRC, /_turnAtt = null;     \/\/ UP-43: attachment stash starts per send/);
    // routing: documents keep the file lane, images the image_url lane,
    // anything else is SKIPPED with an alert (never a fake image part)
    const i = SRC.indexOf('var docs = 0, warn = \'\', sentFiles = [];');
    assert.ok(i > 0, 'sentFiles accumulates ONLY what entered the wire');
    const seg = SRC.slice(i, SRC.indexOf('cur.content = parts;', i));
    assert.match(seg, /sentFiles\.push\(f\);\s*\n\s*parts\.push\(\{ type: 'file'/);
    assert.match(seg, /sentFiles\.push\(f\);\s*\n\s*parts\.push\(\{ type: 'image_url'/);
    assert.match(seg, /} else \{\n\s*\/\/ UP-43[\s\S]*unsupported_files_skipped/);
    // claim: sent files (or the STT _lastFiles set) -> tail row, guarded
    assert.match(SRC, /var claimFiles = \(typeof sentFiles !== 'undefined' && sentFiles\.length\)/);
    assert.match(SRC, /tail && tail\.role === 'user' && !tail\.att/);
    assert.match(SRC, /String\(tail\.content \|\| ''\) === String\(lastUser\)/,
        'content equality stops an older failed-send orphan being tagged');
    assert.match(SRC, /tail\.att = att;/);
    assert.match(SRC, /attKeepPreview\(tail, claimFiles\);/);
});

test('UP-43: onMessage claims the stash in the reversed order; regen/edit replay live files', () => {
    const oi = SRC.indexOf('dc.onMessage = function');
    const seg = SRC.slice(oi, SRC.indexOf("if (role === 'assistant' && _thinkLive", oi));
    assert.match(seg, /if \(role === 'user' && _turnAtt\) \{\s*\n\s*\/\/ UP-43/);
    assert.match(seg, /row\.att = _turnAtt;/);
    assert.match(seg, /_turnAtt = null;/, 'the stash is consumed once');
    // regenerate + edit replay the SESSION files through submitUserMessage
    // (bundle: programmaticSubmit maps files -> FormData 'files' entries)
    assert.equal((SRC.match(/submit\.files = replay;/g) || []).length, 2,
        'msgRegenerate AND commitEdit replay the live preview files');
    assert.match(extract('msgRegenerate'), /var replay = attPreviewOf\(prev\);/);
    assert.match(extract('commitEdit'), /var replay = attPreviewOf\(_conv\.messages\[idx\]\);/);
    // classic's audio-regen refusal is untouched (UP-32-era code path)
    assert.match(SRC, /\^\\\[audio\\\] \//);
});

test('UP-43: chips render from the sweep; mount arms the drop gate + composer mirror', () => {
    const ai = SRC.indexOf('function attachMessageActions');
    assert.ok(SRC.slice(ai, ai + 9000).includes('attChipsRender(holder, ms[storeIdx]);'),
        'chip pass rides the existing post-render sweep (no new observer on bubbles)');
    assert.match(SRC, /dc\.dragAndDrop = true;/, 'drop gate pinned explicitly');
    assert.match(SRC, /try \{ attComposerWire\(dc\); \}/);
});

test('UP-43: shadow-theme ships the chip + queue-row + drop-overlay CSS (light DOM cannot reach)', () => {
    const theme = extract('applyShadowTheme');
    for (const sel of ['.chat-native-atts', '.chat-native-att', '.chat-native-att-n',
                       '#file-attachment-container', '.file-attachment',
                       '.remove-file-attachment-button', '#drag-and-drop']) {
        assert.ok(theme.includes(sel), sel + ' themed inside the shadow tag');
    }
    assert.match(theme, /#drag-and-drop \{ background: color-mix/);
    assert.match(theme, /border: 3px dashed var\(--accent/);
});

// ---- scope item 3 VERIFICATION: paste/drop parity through the bundle ----------
// These pins document the vendored behavior UP-43 relies on; if a deep-chat
// upgrade moves any of it, this gate fails LOUD instead of shipping a silent
// paste regression (classic has explicit handlePaste; uplift goes native —
// the interceptor path never sees paste, the QUEUE does).
test('UP-43 VERIFIED: deep-chat 2.5.1 paste -> queue -> FormData (interceptor untouched)', () => {
    const pi = BUNDLE.indexOf('addEventListener("paste",t=>{var e;t.preventDefault()');
    assert.ok(pi > 0, 'text-input installs a paste listener that preventDefaults');
    assert.ok(BUNDLE.indexOf('addFilesToAnyType', pi) - pi < 200,
        'pasted FILES route to addFilesToAnyType');
    // drop routes the same way
    const di = BUNDLE.indexOf('static uploadFile(t,e)');
    assert.ok(di > 0 && BUNDLE.indexOf('addFilesToAnyType', di) - di < 200,
        'dropped FILES route to addFilesToAnyType');
    // and every add path validates per-queue acceptedFormats
    assert.match(BUNDLE, /attemptAddFile\(t,e\)\{var s;return!!el\.isFileTypeValid\(t,this\._acceptedFormat\)/,
        'queue adds are format-validated (a pasted .zip cannot enter the images or the document queue)');
    // drop overlay exists whenever a queue exists (the gate we pin true)
    assert.match(BUNDLE, /isEnabled\(t,e\)\{return\(void 0===e\|\|!1!==e\)&&\(!!e\|\|t\.getNumberOfTypes\(\)>0\)\}/);
    // post-send the bundle clears the queue row (hideFiles) — the mirror's
    // shrink-trim follows it
    assert.match(BUNDLE, /callAPI\(l,this\._messages\),null==\(o=this\._fileAttachments\)\|\|o\.hideFiles\(\)/);
    // submitUserMessage({text, files}) is the regen-replay contract
    assert.match(BUNDLE, /programmaticSubmit\(t\)\{/,
        'programmatic submit exists for the file replay msgRegenerate/commitEdit use');
    assert.ok(BUNDLE.includes('t[A]&&(e[A]=Array.from(t[A]).map(t=>({file:t,[x]:el.getTypeFromBlob(t)})))'),
        'programmatic files ride the submit as {file,type} — shapeRequest reads them off the FormData');
});
