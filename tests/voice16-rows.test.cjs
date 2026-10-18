/* VOICE-16 chat-player gates that do NOT need a browser:
   (1) the chunk→text matcher (sayWords / sayBlockText / sayMatch) sliced
       VERBATIM out of uplift_chat.js and run against a stub bubble — this is
       the code that decides where each superscript number lands;
   (2) the plan rules: chunk list per mode, and when a revision is kept vs
       replaced (the rev is what binds a bubble to its audio files);
   (3) the i18n family self-pin (tf2 keys are invisible to test_locale_sync.py);
   (4) CSS/structure pins: the old speaker button is gone, the grid is a
       3-column stack capped at five visible rows, and every foldable class
       carries its [hidden] guard.
   Justification for the vm slices: the bodies concatenate ONLY the
   repository's own checked-in source, no external input. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = fs.readFileSync(path.join(STATIC_DIR, 'uplift_chat.js'), 'utf8');
const IO = require(path.join(STATIC_DIR, 'uplift_speechio.js'));
const LOCALE_DIR = path.join(__dirname, '..', 'omlx_uplift', 'locales');

/* ---- the slicer --------------------------------------------------------- */
function slice(name) {
    const re = new RegExp('(?:^|\\n)function ' + name + '\\s*\\(', 'm');
    const m = re.exec(SRC);
    assert.ok(m, 'function ' + name + ' exists in uplift_chat.js');
    let i = SRC.indexOf('{', m.index);
    let depth = 0, out = null;
    for (let j = i; j < SRC.length; j++) {
        const c = SRC[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) { out = SRC.slice(m.index, j + 1); break; } }
    }
    assert.ok(out, 'slice of ' + name + ' terminates on a brace');
    return out;
}
function load(names, extra) {
    const ctx = Object.assign({
        String: String, Array: Array, Math: Math, JSON: JSON, RegExp: RegExp,
        Object: Object, Number: Number, Boolean: Boolean, Date: Date,
    }, extra || {});
    ctx.window = ctx;
    vm.createContext(ctx);
    const script = '(function () {' + names.map(slice).join('\n')
        + '\nreturn {' + names.join(',') + '};})();';
    ctx.API = new vm.Script(script).runInContext(ctx);
    return ctx.API;
}

// (1) the matcher -----------------------------------------------------------
const M = load(['sayWords', 'sayBlocks', 'sayBlockText', 'sayBlockWords', 'sayCollect',
                'sayMatch']);

function block(text) {
    return {
        className: '', _text: text, childNodes: [{ nodeType: 3, nodeValue: text }],
        appendChild() {}, querySelectorAll() { return []; },
    };
}
function bubble(blocks) {
    return { querySelectorAll: () => blocks, childNodes: blocks, appendChild() {} };
}
const planOfChunks = (chunks) => ({ chunks });

test('matcher: each number lands after the block its chunk ends in', () => {
    const b = [block('First sentence here.'), block('Second one follows.'),
               block('And a third that is quite long indeed.')];
    const m = M.sayMatch(planOfChunks(
        ['First sentence here.', 'Second one follows.',
         'And a third that is quite long indeed.']), bubble(b));
    assert.deepEqual(m.marks.map(x => [x.seq, x.b, x.linked]),
                     [[0, 0, true], [1, 1, true], [2, 2, true]]);
});

test('matcher: markdown syntax never breaks a link (bold, list, link label)', () => {
    const b = [block('Do this now.'), block('See the docs for details.')];
    const m = M.sayMatch(planOfChunks(
        ['**Do this** now.', '[See the docs](https://example.com) for details.']),
        bubble(b));
    assert.deepEqual(m.marks.map(x => [x.b, x.linked]), [[0, true], [1, true]]);
});

test('matcher: two chunks ending in one line keep their own order', () => {
    const b = [block('One, two, three and four.')];
    const m = M.sayMatch(planOfChunks(['One, two,', 'three and four.']), bubble(b));
    assert.deepEqual(m.marks.map(x => [x.seq, x.b, x.linked]),
                     [[0, 0, true], [1, 0, true]]);
    assert.ok(m.marks[0].b <= m.marks[1].b, 'the cursor only moves forward');
});

test('matcher: an unfindable chunk is still numbered, at the end (never silent)', () => {
    const b = [block('Nothing of the sort here.')];
    const m = M.sayMatch(planOfChunks(['zzz qqq www eee']), bubble(b));
    assert.equal(m.marks[0].linked, false, 'reported as unlinked');
    assert.equal(m.marks[0].b, 0, 'and parked on the last block that exists');
});

test('matcher: a chunk spanning lines links to the line it ENDS on', () => {
    const b = [block('Alpha beta.'), block('gamma delta end.')];
    const m = M.sayMatch(planOfChunks(['Alpha beta gamma delta end.']), bubble(b));
    assert.deepEqual([m.marks[0].b, m.marks[0].linked], [1, true]);
});

// (2) the plan rules --------------------------------------------------------
test('planChunks: sentence mode sanitizes, line and paragraph stay raw', () => {
    const S = load(['planChunks'], {
        SIO: () => IO,
    });
    // (the splitter's floor merges short sentences, so these stand alone)
    const A = 'The quick brown fox jumps over the lazy dog near the riverbank.';
    const B = 'Pack my box with five dozen liquor jugs before the meeting ends.';
    const md = '# Heading\n\n**' + A + '** ' + B + '\n\n' + A;
    // the modes differ in ONE thing the rows depend on: sentence mode speaks
    // cleaned prose, the other two keep the raw text (and its newlines, which
    // ARE their boundaries). Chunk COUNTS follow the splitter's floor and are
    // deliberately not pinned here — voice10 owns that arithmetic.
    const sent = S.planChunks(md, 'sentence');
    assert.ok(sent.length >= 1, 'sentences: ' + JSON.stringify(sent));
    sent.forEach((c) => assert.ok(!/[*#]/.test(c), 'markdown stripped: ' + c));
    const line = S.planChunks(md, 'line');
    assert.ok(line.some(c => c.includes('**')), 'line mode keeps the syntax');
    // chunk text is whitespace-normalised in EVERY mode (the newline is a
    // boundary, never content), so the modes differ only in the syntax they
    // keep: paragraph mode still speaks the markdown as written
    const para = S.planChunks(md, 'paragraph');
    assert.ok(para.some(c => c.includes('**')),
              'paragraph mode keeps the syntax: ' + JSON.stringify(para));
    assert.ok(para.length <= line.length,
              'coarser mode, no more chunks than line mode');
});

test('planChunks: a streamed plan and a rebuilt one are the same list', () => {
    // the invariant the rows depend on: reload re-derives the SAME chunks, so
    // the stored numbers still point at the stored audio
    const S = load(['planChunks'], { SIO: () => IO });
    const REPLY = 'Alpha one two three. Beta four five six.\n\nGamma seven eight.\n';
    const streamed = [];
    const z = IO.createSpeechSplitter({ mode: 'sentence' });
    const san = IO.createSpeechSanitizer();
    for (const ch of REPLY) {
        const t = san.push(ch);
        if (t) streamed.push(...z.push(t));
    }
    const tail = san.flush();
    streamed.push(...z.push(tail), ...z.flush());
    assert.deepEqual(S.planChunks(REPLY, 'sentence'),
                     streamed.filter(s => s && s.trim()),
                     'one-shot rebuild == what streamed');
});

// (3) i18n self-pin ---------------------------------------------------------
const FAM = ['say_read', 'say_reread', 'say_redo', 'say_play', 'say_line',
             'say_lines', 'cache_hint', 'cache_check', 'cache_cleanup',
             'cache_none', 'cache_found', 'cache_confirm', 'cache_cleaned'];
const FILES = fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json'));

test('i18n: every VOICE-16 key exists in all locales, translated', () => {
    assert.equal(FILES.length, 10, 'all ten catalogs present: ' + FILES);
    const en = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'en.json')));
    for (const key of FAM) {
        const full = 'uplift.chat.' + key;
        assert.ok(en[full], 'en carries ' + full);
        const want = (String(en[full]).match(/\{\w+\}/g) || []).sort();
        for (const f of FILES) {
            const d = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f)));
            assert.ok(d[full], full + ' missing from ' + f);
            const got = (String(d[full]).match(/\{\w+\}/g) || []).sort();
            assert.deepEqual(got, want, 'placeholder set differs in ' + f);
            if (f !== 'en.json')
                assert.notEqual(d[full], en[full], full + ' untranslated in ' + f);
        }
    }
});

test('i18n: every VOICE-16 key is actually reached from the chat module', () => {
    for (const key of FAM) {
        const full = "'uplift.chat." + key + "'";
        assert.ok(SRC.includes(full), full + ' is declared but never used');
    }
});

// (4) structure + CSS pins --------------------------------------------------
test('structure: the speaker button is replaced by the transport row', () => {
    assert.ok(!/chat-native-msg-action speak/.test(SRC),
              'the old per-bubble speaker button is gone');
    // the pair rides the MESSAGE ACTION line, as its last control
    const actions = slice('msgActionsEl');
    assert.match(actions, /var track = sayTrackEl\(idx\);\n        box\.appendChild\(track\);/,
                 'the whole-reply pair is appended to the action line');
    assert.match(actions, /role === 'assistant' && hasVoices\(\)/,
                 'and only where there is audio to control');
    const grid = slice('sayGridEl');
    assert.ok(!/sayTrackEl/.test(grid),
              'it is NOT another row in the chunk stack');
    assert.match(slice('sayTrackEl'), /el\('div', 'chat-native-say-all'\)/,
                 'the pair is not styled as a chunk row');
    assert.ok(/sayAttach\(holder, storeIdx, role, b\)/.test(SRC),
              'rows refresh on every attach pass');
    assert.ok(/row\.mid = _turnMid/.test(SRC),
              'the streamed turn binds its plan to the assistant row');
});

// the shadow-DOM theme is a JS array of quoted lines: rejoin them into CSS text
function themeCss() {
    const lines = SRC.split('\n');
    const start = lines.findIndex(l => /\bvar css = \[/.test(l));
    assert.ok(start >= 0, 'the chat theme block exists');
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\];\s*$/.test(lines[i])) break;
        const m = /^\s*'(.*)'[,?]?$/.exec(lines[i]);
        if (m) out.push(m[1]);
    }
    return out.join(' ');
}
function cssRule(sel, css) {
    const re = new RegExp(sel.replace(/[[\]()*+{}|^$.?\\/]/g, '\\$&')
        + '\\s*\\{[^}]*\\}');
    const m = re.exec(css);
    return m ? m[0] : '';
}

test('css: the stack is a 3-column grid capped at five visible rows', () => {
    const CSS = themeCss();
    const grid = cssRule('.chat-native-say-grid', CSS);
    assert.ok(grid.includes('display: flex') && grid.includes('flex-wrap: wrap'),
              'a wrapping LINE of controls, not a table: ' + grid.slice(0, 80));
    assert.match(grid, /max-height:\s*118px/);
    assert.match(grid, /overflow-y:\s*auto/);
    const row = cssRule('.chat-native-say-row', CSS);
    assert.match(row, /box-sizing:\s*border-box/,
                 'padding must sit inside the basis or the line overflows by 6px');
    assert.match(row, /flex:\s*1 1 calc\(\(100% - 20px\) \/ 3\)/,
                 'three equal chunk controls per line');
    const all = cssRule('.chat-native-say-all', CSS);
    assert.match(all, /margin-left:\s*auto/, 'aligned to the right end of the line');
    assert.ok(!/visibility/.test(all),
              'no reveal rule of its own — it follows the action line');
    // the pair rule comes first in the sheet, so match the standalone one
    assert.match(CSS, /\.chat-native-say-re \{ font-size: 17px; \}/,
                 'the reload glyph is sized to read as big as play');
    assert.match(CSS, /\.outer-message-container \.message-bubble \{ max-width: 80%; \}/,
                 'a reply may use 80% of the chat box');
    const guard = cssRule('.chat-native-say-all[hidden], .chat-native-say-grid[hidden]', CSS);
    assert.match(guard, /display:\s*none/,
                 'author display beats [hidden] without this guard: ' + guard);
    // no rule re-opens the same selector (the css2 doctrine, applied to the
    // shadow-DOM block where uplift.css cannot reach): compare FULL selectors
    const sels = [];
    const re = /([^{}]+)\{/g;
    let m;
    while ((m = re.exec(CSS))) {
        const s = m[1].trim().replace(/\s+/g, ' ');
        if (s.includes('chat-native-say')) sels.push(s);
    }
    const dupes = sels.filter((s, i) => sels.indexOf(s) !== i);
    assert.deepEqual(dupes, [], 'a selector may only be opened once: '
        + JSON.stringify(dupes));
    assert.ok(sels.length >= 10, 'the player brings its own rules: ' + sels.length);
});

test('rows: a chunk row is built from real parts, not just wired ones', () => {
    // the append-omission class: a control built, wired and never appended
    // passes every byId probe and shows up EMPTY in the browser
    const pp = cssRule('.chat-native-say-pp, .chat-native-say-re', themeCss());
    assert.match(pp, /font: inherit;\s*font-size: 15px/,
                 'transport glyphs are set AFTER the shorthand or they stay small');
    const body = slice('sayRow');
    assert.match(body, /row\.append\(pp, n, wave, re\)/,
                 'play, number, waveform and reload all ride the row');
    assert.match(body, /row\._pp = pp/, 'the row keeps its own handles');
    assert.match(SRC, /g\.appendChild\(sayRow\(plan, i\)\)/,
                 'the stack appends every row it builds');
});

test('play-all: a chunk already handed to the queue is never pushed twice', () => {
    // the live turn pushes chunk by chunk; play-all then feeds the SAME plan.
    // Without the counter the queue got a second copy and read the reply twice.
    const feed = slice('sayFeed');
    assert.match(feed, /var have = q\.__pushed \|\| 0;/, 'it asks what the queue owns');
    assert.match(feed, /for \(var i = have; i < plan\.chunks\.length; i\+\+\)/,
                 'and pushes only the missing tail');
    assert.match(SRC, /q\.__pushed = \(q\.__pushed \|\| 0\) \+ 1;/,
                 'every live-path push counts too');
    // the highlight follows the measured playhead, never the schedule event
    const ev = slice('sayItemEvent');
    assert.ok(!/sayHighlight\(plan, it\.seq\)/.test(ev),
        'a SCHEDULED chunk must not steal the highlight');
});

test('release: a deleted or regenerated bubble stops talking and loses its mid', () => {
    const rel = slice('sayRelease');
    assert.match(rel, /_plans\[mid\]/, 'it finds the plan by the bubble identity');
    assert.match(rel, /speakCancel\(\)/, 'the active read is cancelled');
    assert.match(rel, /p\.q\.stop\(\)/, 'a background read is stopped too');
    assert.match(rel, /_turnMid === mid\) _turnMid = ''/,
                 'the minted mid is not left behind for the next reply');
    assert.match(rel, /delete _plans\[mid\]/, 'and the plan itself goes');
    assert.match(slice('msgDelete'), /sayRelease\(m\.mid\);/,
                 'Delete silences that bubble');
    const regen = slice('msgRegenerate');
    assert.match(regen, /role === 'assistant'\) sayRelease\(ms\[k\]\.mid\)/,
                 'Regenerate silences every reply it cuts away');
});

test('identity: a stale turn mid cannot lend its chunks to a new reply', () => {
    // deep-chat keeps the minted mid from the turn start; an aborted or deleted
    // turn must not have it stamped onto the next answer (that is what made a
    // regenerated bubble show the dead one's chunk lines)
    const stamp = SRC.slice(SRC.indexOf('VOICE-16: bind the plan'),
                            SRC.indexOf('VOICE-16: bind the plan') + 1400);
    assert.match(stamp, /var carry = _plans\[_turnMid\];/);
    assert.match(stamp, /now\.slice\(0, 24\) !== spoke\.slice\(0, 24\)/,
                 'text is compared before the plan is reused');
    assert.match(stamp, /sayRelease\(_turnMid\);/);
});

test('pair: the action line binds by mid, never by row position', () => {
    const acts = slice('msgActionsEl');
    assert.match(acts, /var owner = messageAt\(idx\);\n        if \(owner && owner\.mid && _plans\[owner\.mid\]\)/,
                 'plans are keyed by mid; an index shifts when a row is deleted');
});

test('track: a rebuilt action line does not orphan the pair', () => {
    const adopt = slice('sayAdoptTrack');
    assert.match(adopt, /plan\.box\.isConnected === false/,
                 'a detached pair is replaced, not painted into');
    assert.match(SRC, /sayAdoptTrack\(plan, holder, idx\);\n    sayStructure/,
                 'adopted before every structure pass');
});

test('stack: the controls stop at the bubble edge', () => {
    const fit = slice('sayFitGrid');
    assert.match(fit, /getBoundingClientRect\(\)/, 'measured, not guessed');
    assert.match(fit, /g\.style\.maxWidth = Math\.round\(rect\.width\)/);
    assert.match(SRC, /sayFitGrid\(plan, bubble\);\n    var m = sayMatch/,
                 'every annotate pass re-fits the stack');
});

test('waveform: peaks come off the decoded buffer, nothing else', () => {
    const say = fs.readFileSync(path.join(STATIC_DIR, 'uplift_speechio.js'), 'utf8');
    assert.match(say, /onItem\(item, state\)/, 'the row ladder is an engine seam');
    assert.match(SRC, /getChannelData/, 'peaks read the decoded samples');
    assert.ok(!/wavesurfer|<audio|new Audio\(/.test(SRC),
              'no parallel audio element path was invented beside the queue');
});

// ---- exact placement inside the bubble (real text-node surgery) ------------
function mkText(v, parent) {
    const t = {
        nodeType: 3, nodeValue: v, parentNode: parent,
        splitText(off) {
            const rest = t.nodeValue.slice(off);
            t.nodeValue = t.nodeValue.slice(0, off);
            const sib = mkText(rest, null);
            if (parent) {
                const i = parent.children.indexOf(t);
                sib.parentNode = parent;
                parent.children.splice(i + 1, 0, sib);
            }
            return sib;
        },
    };
    return t;
}
function mkEl(tag, cls) {
    const e = {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(), className: cls || '',
        children: [], parentNode: null, dataset: {}, style: {},
        addEventListener() {}, remove() { if (e.parentNode) e.parentNode.removeChild(e); },
        get childNodes() { return e.children; },
        get firstChild() { return e.children[0] || null; },
        get nextSibling() {
            const p = e.parentNode; if (!p) return null;
            return p.children[p.children.indexOf(e) + 1] || null;
        },
        get textContent() {
            return (e._text || '') + e.children.map(c => c.nodeType === 3
                ? c.nodeValue : c.textContent).join('');
        },
        appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n);
            n.parentNode = e; e.children.push(n); return n; },
        insertBefore(n, ref) { if (n.parentNode) n.parentNode.removeChild(n);
            n.parentNode = e;
            const i = ref ? e.children.indexOf(ref) : -1;
            if (i < 0) e.children.push(n); else e.children.splice(i, 0, n);
            return n; },
        removeChild(n) { const i = e.children.indexOf(n);
            if (i >= 0) e.children.splice(i, 1); n.parentNode = null; return n; },
        querySelectorAll(sel) {
            const want = String(sel).replace(/^\./, '');
            const out = [];
            (function walk(node) {
                (node.children || []).forEach(c => {
                    if (c.nodeType === 1 && String(c.className).includes(want)) out.push(c);
                    if (c.children) walk(c);
                });
            })(e);
            return out;
        },
    };
    return e;
}
function para(text) {
    const p = mkEl('p');
    p.appendChild(mkText(text, p));
    return p;
}
function bubbleOf(blocks) {
    const b = mkEl('div');
    blocks.forEach(x => b.appendChild(x));
    b.querySelectorAll = (sel) => {
        const want = String(sel).split(',')[0].trim();
        if (want === '*') {                                  // every descendant
            const all = [];
            (function walk(node) {
                (node.children || []).forEach(c => {
                    if (c.nodeType === 1) { all.push(c); walk(c); }
                });
            })(b);
            return all;
        }
        const out = [];
        (function walk(node) {
            (node.children || []).forEach(c => {
                if (c.nodeType === 1) {
                    if (c.tagName === want.toUpperCase() ||
                        (want.startsWith('.') && String(c.className).includes(want.slice(1))))
                        out.push(c);
                    walk(c);
                }
            });
        })(b);
        return out;
    };
    return b;
}
const A = load(['sayWords', 'sayBlocks', 'sayBlockWords', 'sayCollect',
                'sayMatch', 'saySweep', 'sayClean', 'sayFitGrid',
                'saySeg', 'sayRefEl', 'sayWrap', 'sayAnnotate', 'sayHighlight',
                'sayHover'], {
    el: (tag, cls, text) => { const e = mkEl(tag, cls); if (text) e._text = text; return e; },
    tf2: (k, fb) => fb,
    document: { createElement: (t) => mkEl(t) },
});
// sayAnnotate calls sayHover/sayToggle indirectly; stub the missing collaborator
A.sayToggle = () => {};

test('placement: the number lands after ITS chunk, not after the message', () => {
    const p = para('First sentence here. Second one follows.');
    const bubble = bubbleOf([p]);
    const plan = { chunks: ['First sentence here.', 'Second one follows.'], rows: [] };
    A.sayAnnotate(plan, bubble);

    const segs = p.children.filter(c => String(c.className).includes('say-seg'));
    const refs = p.children.filter(c => String(c.className).includes('say-ref'));
    assert.equal(segs.length, 2, 'one span per chunk: ' + JSON.stringify(
        p.children.map(c => c.className || c.nodeValue)));
    assert.equal(segs[0].textContent.trim(), 'First sentence here.');
    assert.equal(segs[1].textContent.trim(), 'Second one follows.');
    assert.equal(refs.length, 2, 'both numbers live inside the paragraph');
    // order in the text: [chunk1][1][chunk2][2] — not [chunk1][chunk2][1][2]
    const order = p.children.map(c => c.nodeType === 3 ? 'text'
        : (String(c.className).includes('say-ref') ? 'ref' + c._text : 'seg' + c.dataset.seq));
    assert.deepEqual(order, ['seg0', 'ref1', 'seg1', 'ref2'], order.join(','));
});

test('placement: only the playing chunk lights', () => {
    const p = para('Alpha one two. Alpha three four.');
    const bubble = bubbleOf([p]);
    const plan = { chunks: ['Alpha one two.', 'Alpha three four.'], rows: [] };
    A.sayAnnotate(plan, bubble);
    A.sayHighlight(plan, 1);
    const segs = p.children.filter(c => String(c.className).includes('say-seg'));
    assert.ok(!/say-here/.test(segs[0].className), 'chunk 1 stays dark');
    assert.match(segs[1].className, /say-here/, 'chunk 2 is lit');
    const refs = p.children.filter(c => String(c.className).includes('say-ref'));
    assert.match(refs[1].className, /hot/);
    assert.ok(!/hot/.test(refs[0].className), 'the other number stays quiet');
});

test('placement: re-annotating does not stack numbers or nest spans', () => {
    const p = para('One sentence. Two sentence.');
    const bubble = bubbleOf([p]);
    const plan = { chunks: ['One sentence.', 'Two sentence.'], rows: [] };
    A.sayAnnotate(plan, bubble);
    const first = p.children.length;
    A.sayAnnotate(plan, bubble);
    assert.equal(p.children.length, first, 'idempotent: ' + JSON.stringify(
        p.children.map(c => c.className || c.nodeValue)));
    const prose = p.children.filter(c => c.nodeType === 3 ||
        String(c.className).includes('say-seg'))
        .map(c => c.nodeType === 3 ? c.nodeValue : c.textContent).join('');
    assert.equal(prose.replace(/\s+/g, ' ').trim(),
                 'One sentence. Two sentence.', 'the prose itself is untouched');
});

test('placement: a chunk that crosses inline markup lights both pieces', () => {
    const p = mkEl('p');
    p.appendChild(mkText('Read the ', p));
    const strong = mkEl('strong');
    strong.appendChild(mkText('manual', strong));
    p.appendChild(strong);
    p.appendChild(mkText(' now and again.', p));
    const bubble = bubbleOf([p]);
    const plan = { chunks: ['Read the manual now and again.'], rows: [] };
    A.sayAnnotate(plan, bubble);
    const segs = p.querySelectorAll('.chat-native-say-seg');
    assert.ok(segs.length >= 2, 'both the plain text and the bold word are covered');
    A.sayHighlight(plan, 0);
    const lit = segs.filter(s => s.className.includes('say-here'));
    assert.equal(lit.length, segs.length, 'every piece lights together');
});
