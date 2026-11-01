/* REMEMBER (user 2026-11-01): "intelligence benchmark should remember last
   used benchmarks". The Accuracy panel restores its suite picks and sample
   sizes from localStorage on every mount; picks whose suite left the
   server catalog are pruned before the grid paints (a stale key would
   otherwise reach collect() and the server would reject the whole run).
   Pure helpers ride the B._accPicks seam - the store contract is testable
   without a DOM, and the mount path is covered by the acc2a harness. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');
const B = require(path.join(STATIC_DIR, 'uplift_bench.js'));

const P = B._accPicks;
assert.ok(P && P.load && P.save && P.validate, 'the _accPicks seam exists');

/* map-backed store (a no-op stub makes persistence unprovable) */
function useStore() {
    const map = new Map();
    global.localStorage = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
    };
    return map;
}

test('save/load round-trips the picks and their sizes', () => {
    useStore();
    const st = { selected: { mmlu: true, gsm8k: true, arc: false },
                 sizes: { mmlu: 100, gsm8k: 0 } };   // 0 = classic 'Full'
    P.save(st);
    const back = P.load();
    assert.deepEqual(Object.keys(back.selected).sort(), ['gsm8k', 'mmlu'],
        'deselected cards are not stored');
    assert.equal(back.sizes.mmlu, 100);
    assert.equal(back.sizes.gsm8k, 0, 'Full (0) survives - it is a real size');
});

test('junk in the stored pref collapses to no pref, never a throw', () => {
    const map = useStore();
    map.set(P.KEY, '{not json');
    assert.deepEqual(P.load(), { selected: {}, sizes: {} });
    map.set(P.KEY, JSON.stringify({ selected: [7, null, 'mmlu'],
                                    sizes: { mmlu: 'x', arc: -3, bb: 50,
                                             nil: null, no: false, yes: true,
                                             empty: '', str: '25', full: 0 } }));
    const d = P.load();
    assert.deepEqual(Object.keys(d.selected), ['mmlu'], 'only real keys');
    assert.deepEqual(d.sizes, { bb: 50, full: 0 },
        'non-number and negative sizes dropped; numeric zero stays a real Full size. '
        + 'An orphan numeric survives but cannot reach the request '
        + '(collect reads SIZES of SELECTED)');
});

test('validate keeps keys the catalog offers and prunes the rest', () => {
    useStore();
    const acc = { state: {
        groups: [{ tasks: [{ key: 'mmlu' }, { key: 'gsm8k' }] }],
        harnessTasks: ['mmlu'],
        extraSuites: [{ key: 'ifeval' }],
        selected: { mmlu: true, 'mmlu|h': true, 'ifeval|h': true,
                    'gone|h': true, retired: true },
        sizes: { mmlu: 100, 'mmlu|h': 50, 'gone|h': 100, retired: 10 },
    } };
    P.save(acc.state);
    P.validate(acc);
    const st = acc.state;
    assert.deepEqual(Object.keys(st.selected).sort(),
        ['ifeval|h', 'mmlu', 'mmlu|h'], 'classic, twin and extra survive');
    assert.ok(!('retired' in st.sizes) && !('gone|h' in st.sizes),
        'sizes prune with their picks');
    // the pruned state lands back in the store (self-healing)
    assert.deepEqual(Object.keys(P.load().selected).sort(),
        ['ifeval|h', 'mmlu', 'mmlu|h'], 'prune is persisted');
});

test('validate is inert before the catalog lands (no groups: no prune)', () => {
    useStore();
    const acc = { state: { selected: { mmlu: true }, sizes: {}, groups: null } };
    P.validate(acc);
    assert.equal(acc.state.selected.mmlu, true,
        'a pre-fetch state is never stripped - the catalog owns the verdict');
});

/* Wiring pins: the seams the mount path uses. The stub cannot click the
   grid, so the call sites are shape-pinned (the store round-trip above is
   the behavioral proof of the helpers themselves). */
const fs = require('node:fs');
const bench = fs.readFileSync(path.join(STATIC_DIR, 'uplift_bench.js'), 'utf8');

test('the panel restores on mount, saves on every mutation, prunes pre-paint', () => {
    assert.match(bench, /var picks = accLoadPicks\(\);/,
        'render() seeds the fresh state from the store');
    assert.match(bench, /selected: picks\.selected, sizes: picks\.sizes,/,
        'the restored picks ARE the initial state (paint reads them)');
    assert.match(bench, /accSavePicks\(self\.state\); \/\/ REMEMBER \(user 2026-11-01\)\n\s*self\.applyEngineLabels\(\);   \/\/ U68: totals hint\n\s*\}, \{ d: tk\.desc \|\| null \}\);/,
        'the classic card toggle writes through');
    assert.ok((bench.match(/accSavePicks\(/g) || []).length >= 5,
        'every mutation path (toggle, size, extras pick, prune) saves');
    assert.match(bench, /accValidatePicks\(self\);\n\s*self\.renderGrid\(\);/,
        'prune runs BEFORE the grid paints (no stale ghost cards, no stale collect)');
    assert.match(bench,
        /if \(self\.state\.selected\[key\]\) \{\s*\n\s*card\.classList\.add\('on'\);/,
        'a restored pick paints its classic card selected');
    assert.match(bench,
        /var sz0 = self\.state\.sizes\[key\];/,
        'the saved sample size re-arms the select (option-matched)');
});

test('the fold carries a BIG expand chip (CSS-side, rotation stays state-keyed)', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.match(css,
        /\.acc-extras-head \.bench-adv-chev \{[^}]*width: 26px; height: 26px;[^}]*border: 1px solid var\(--accent\); border-radius: 50%;/,
        'a bordered round chip, not bare text');
    assert.match(css, /\.acc-extras-head \.bench-adv-chev \{[^}]*order: -1;/,
        'it rides the leading end of the strip (before the caption)');
    assert.match(css,
        /\.acc-extras\[open\] > \.acc-extras-head \.bench-adv-chev \{[^}]*rotate\(180deg\)/,
        'rotation still derives from the [open] state, never from JS text');
});
