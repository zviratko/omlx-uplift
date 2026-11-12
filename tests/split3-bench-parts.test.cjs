/* SPLIT-3: the native bench is one core file plus one part file per bench
   panel. Pins the load contract so a new part cannot be added in one place
   only:
   - the browser loader (uplift.js BENCH_PARTS) loads every part, in the
     test helper's order, and loads the core AFTER them;
   - each part registers its factory on UpliftBenchParts under the key the
     core asks for, in the browser AND through require();
   - none of the bench files loads synchronously from index.html. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR, BENCH_FILES, runBench } = require('./static-src.cjs');

const read = (f) => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const PARTS = BENCH_FILES.slice(0, -1);
const keyOf = (f) => f.match(/^uplift_bench_([a-z]+)\.js$/)[1];

test('the core is the last bench file and every part is on disk', () => {
    assert.strictEqual(BENCH_FILES[BENCH_FILES.length - 1], 'uplift_bench.js');
    for (const f of PARTS) {
        assert.match(f, /^uplift_bench_[a-z]+\.js$/);
        assert.ok(fs.existsSync(path.join(STATIC_DIR, f)), f + ' exists');
    }
    const onDisk = fs.readdirSync(STATIC_DIR).filter(f => /^uplift_bench_.*\.js$/.test(f)).sort();
    assert.deepStrictEqual(onDisk, PARTS.slice().sort(),
        'every uplift_bench_*.js file is listed in BENCH_FILES');
});

test('uplift.js loads the same parts, then the core', () => {
    const src = read('uplift.js');
    const m = src.match(/const BENCH_PARTS = \[([^\]]*)\];/);
    assert.ok(m, 'BENCH_PARTS list exists');
    const listed = [...m[1].matchAll(/'\.\/([\w.]+)'/g)].map(x => x[1]);
    assert.deepStrictEqual(listed, PARTS);
    assert.match(src, /else Promise\.all\(BENCH_PARTS\.map\(f => D\.loadScript\(f\)\)\)\n\s*\.then\(\(\) => \(typeof UpliftNativeBench !== 'undefined'\n\s*\? null : D\.loadScript\('\.\/uplift_bench\.js'\)\)\)\.then\(runBench\);/,
        'the core loads only after every part has loaded');
});

test('no bench file loads synchronously from index.html', () => {
    const html = read('index.html');
    for (const f of BENCH_FILES) assert.ok(!html.includes(`src="./${f}`), f);
});

test('each part registers under the key the core asks for', () => {
    const core = read('uplift_bench.js');
    for (const f of PARTS) {
        const key = keyOf(f);
        assert.ok(read(f).includes(`(root.UpliftBenchParts = root.UpliftBenchParts || {}).${key} = factory;`),
            f + ' registers UpliftBenchParts.' + key);
        assert.ok(core.includes(`PARTS.${key}({`), 'core calls PARTS.' + key);
        assert.ok(core.includes(`${key}: require('./${f}')`), 'core requires ' + f + ' under node');
    }
});

test('browser path: parts then core give a working UpliftNativeBench', () => {
    const win = { console };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    runBench(ctx);
    assert.strictEqual(typeof win.UpliftNativeBench.mount, 'function');
    assert.deepStrictEqual(Object.keys(win.UpliftBenchParts).sort(), PARTS.map(keyOf).sort());
});

test('node path: require() of the core pulls its parts in', () => {
    const bench = require(path.join(STATIC_DIR, 'uplift_bench.js'));
    assert.strictEqual(typeof bench.mount, 'function');
});
