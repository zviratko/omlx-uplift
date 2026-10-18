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
const M = load(['sayWords', 'sayBlocks', 'sayBlockText', 'sayMatch']);

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
    assert.ok(/box\.appendChild\(sayTrackEl\(idx\)\)/.test(SRC),
              'the action line carries the audio transport instead');
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
    assert.ok(grid.includes('display: grid'), 'grid rule found: ' + grid.slice(0, 60));
    assert.match(grid, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(grid, /max-height:\s*118px/);
    assert.match(grid, /overflow-y:\s*auto/);
    const guard = cssRule('.chat-native-say-inline[hidden], .chat-native-say-grid[hidden]', CSS);
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
    const body = slice('sayRow');
    assert.match(body, /row\.append\(pp, n, wave, re\)/,
                 'play, number, waveform and reload all ride the row');
    assert.match(body, /row\._pp = pp/, 'the row keeps its own handles');
    assert.match(SRC, /g\.appendChild\(sayRow\(plan, i\)\)/,
                 'the stack appends every row it builds');
});

test('waveform: peaks come off the decoded buffer, nothing else', () => {
    const say = fs.readFileSync(path.join(STATIC_DIR, 'uplift_speechio.js'), 'utf8');
    assert.match(say, /onItem\(item, state\)/, 'the row ladder is an engine seam');
    assert.match(SRC, /getChannelData/, 'peaks read the decoded samples');
    assert.ok(!/wavesurfer|<audio|new Audio\(/.test(SRC),
              'no parallel audio element path was invented beside the queue');
});
