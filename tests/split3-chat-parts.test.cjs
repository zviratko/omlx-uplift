/* SPLIT-3: the native chat is one core file plus part files.
   Pins the load contract so a new part cannot be added in one place only:
   - the browser loader (uplift.js CHAT_PARTS) loads every part, in the
     test helper's order, and loads the core AFTER them;
   - each part registers its factory on UpliftChatParts under the key the
     core asks for, in the browser AND through require();
   - none of the chat files loads synchronously from index.html. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR, CHAT_FILES, runChat } = require('./static-src.cjs');

const read = (f) => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const PARTS = CHAT_FILES.slice(0, -1);

test('the core is the last chat file and every part is on disk', () => {
    assert.strictEqual(CHAT_FILES[CHAT_FILES.length - 1], 'uplift_chat.js');
    for (const f of PARTS) {
        assert.match(f, /^uplift_chat_[a-z]+\.js$/);
        assert.ok(fs.existsSync(path.join(STATIC_DIR, f)), f + ' exists');
    }
    const onDisk = fs.readdirSync(STATIC_DIR).filter(f => /^uplift_chat_.*\.js$/.test(f)).sort();
    assert.deepStrictEqual(onDisk, PARTS.slice().sort(),
        'every uplift_chat_*.js file is listed in CHAT_FILES');
});

test('uplift.js loads the same parts, then the core', () => {
    const src = read('uplift.js');
    const m = src.match(/const CHAT_PARTS = \[([^\]]*)\];/);
    assert.ok(m, 'CHAT_PARTS list exists');
    const listed = [...m[1].matchAll(/'\.\/([\w.]+)'/g)].map(x => x[1]);
    assert.deepStrictEqual(listed, PARTS);
    assert.match(src, /\.\.\.CHAT_PARTS\.map\(f => D\.loadScript\(f\)\),\n\s*\]\)\.then\(\(\) => \(typeof UpliftNativeChat !== 'undefined'\n\s*\? null : D\.loadScript\('\.\/uplift_chat\.js'\)\)\)\.then\(runChat\);/,
        'the core loads only after every part has loaded');
});

test('no chat file loads synchronously from index.html', () => {
    const html = read('index.html');
    for (const f of CHAT_FILES) assert.ok(!html.includes(`src="./${f}`), f);
});

test('each part registers under the key the core asks for', () => {
    const core = read('uplift_chat.js');
    for (const f of PARTS) {
        const key = f.match(/^uplift_chat_([a-z]+)\.js$/)[1];
        assert.ok(read(f).includes(`(root.UpliftChatParts = root.UpliftChatParts || {}).${key} = factory;`),
            f + ' registers UpliftChatParts.' + key);
        assert.ok(core.includes(`PARTS.${key}({`), 'core calls PARTS.' + key);
        assert.ok(core.includes(`${key}: require('./${f}')`), 'core requires ' + f + ' under node');
    }
});

test('browser path: parts then core give a working UpliftNativeChat', () => {
    const win = { console };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    runChat(ctx);
    assert.strictEqual(typeof win.UpliftNativeChat.mount, 'function');
    assert.deepStrictEqual(Object.keys(win.UpliftChatParts).sort(),
        PARTS.map(f => f.match(/^uplift_chat_([a-z]+)\.js$/)[1]).sort());
});

test('node path: require() of the core pulls its parts in', () => {
    const chat = require(path.join(STATIC_DIR, 'uplift_chat.js'));
    assert.strictEqual(typeof chat.mount, 'function');
});
