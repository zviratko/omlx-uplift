/* CSS-3 (dead-token ratchet): a var(--x) with NO fallback resolves to nothing
 * if nothing declares --x, and the damage is not limited to that one property —
 * an invalid value inside a shorthand drops the WHOLE declaration. Measured on
 * the live board on 2026-10-25: a table frame collapsed to border-width: 0 and
 * meta text rendered at 14px instead of 11px, both from one undefined token.
 *
 * This gate is a RATCHET, not a clean bill of health. Six tokens are used
 * without a fallback and are not declared anywhere in uplift's own surface;
 * some of them resolve at runtime because the classic dashboard CSS or an
 * installed skin declares them, which a repo-only test cannot see. So the set
 * is frozen: adding a new one fails, fixing one fails until it is removed from
 * the baseline below, and resolving the runtime question for each is separate
 * work (tracker D8) that needs the user's call because it changes how pages
 * look.
 *
 * --ok was in this list and is now declared in :root: 10 of its uses carried an
 * inline var(--ok, #2e8b57) fallback and looked correct by accident, while
 * .envcat-chip.ok and .se-tab-api.api-ok had none and silently inherited ink.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

// frozen 2026-10-25, see the header: may only SHRINK.
// Three of the original six were the context ring's strokes; they were dead in
// a way this scan could see but nobody could — see the attribute test below.
const BASELINE = [
    '--fs-meta',
    '--line',
    '--rule',
];

function scan() {
    const declared = new Set();
    const unbacked = new Map();          // token -> Set(files)
    for (const f of fs.readdirSync(STATIC_DIR)) {
        if (!/\.(css|html|js)$/.test(f)) continue;
        let s = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
        s = s.replace(/\/\*[\s\S]*?\*\//g, '');
        if (f.endsWith('.js')) s = s.replace(/\/\/[^\n]*/g, '');
        for (const m of s.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
        // var(--x) ONLY — var(--x, fallback) can never break, by definition
        for (const m of s.matchAll(/var\((--[\w-]+)\)/g)) {
            if (!unbacked.has(m[1])) unbacked.set(m[1], new Set());
            unbacked.get(m[1]).add(f);
        }
    }
    const dead = [...unbacked.keys()]
        .filter((t) => !declared.has(t))
        .sort();
    return { dead, unbacked };
}

test('CSS-3: no new token is used without a fallback and without a declaration', () => {
    const { dead, unbacked } = scan();
    const added = dead.filter((t) => !BASELINE.includes(t));
    assert.deepEqual(added, [], 'undeclared var() uses without fallback: '
        + added.map((t) => `${t} (${[...unbacked.get(t)].join(',')})`).join('; ')
        + ' — declare it in :root or write var(--x, #literal)');
});

test('CSS-3: the baseline shrinks when a dead token is fixed (no stale ratchet)', () => {
    const { dead } = scan();
    const stale = BASELINE.filter((t) => !dead.includes(t));
    assert.deepEqual(stale, [], 'these tokens are now declared — remove them from '
        + `BASELINE so the ratchet keeps its teeth: ${stale.join(', ')}`);
});

test('CSS-3: --ok is declared (it was borrowed by 13 rules and defined by none)', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    assert.ok(/--ok\s*:/.test(css),
        '--ok must be a real token: without it .envcat-chip.ok and '
        + '.se-tab-api.api-ok paint plain ink instead of green');
    assert.ok(!/--ok\s*:\s*var\(/.test(css),
        '--ok must not be defined in terms of another token that may itself be missing');
});

test('CSS-3: var() is never used in an SVG presentation attribute', () => {
    // Different trap from the undeclared-token check: a presentation attribute
    // is parsed as an SVG paint value, NOT as a CSS declaration, so var() is
    // not substituted there even when the token IS defined — stroke="var(--x)"
    // computes to `none` and the shape is simply invisible. That is what hid
    // the context ring after it finally mounted (live 2026-10-25:
    // getComputedStyle(arc).stroke === 'none'); the token scan above could see
    // the three names were undeclared but not that the mechanism itself never
    // worked. Paint goes in a rule or in element.style, never in the markup.
    const offenders = [];
    for (const f of fs.readdirSync(STATIC_DIR)) {
        if (!/\.(js|html)$/.test(f)) continue;
        const s = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
        const rx = /(?:stroke|fill|stop-color)\s*(?:=\s*["']var\(|,\s*['"]var\()/g;
        for (const m of s.matchAll(rx)) {
            const line = s.slice(0, m.index).split('\n').length;
            offenders.push(`${f}:${line} ${s.slice(m.index, m.index + 40).split('\n')[0].trim()}`);
        }
    }
    assert.deepEqual(offenders, [], 'var() in a presentation attribute never '
        + `resolves: ${offenders.join(' | ')}`);
});

test('CSS-3: the context ring paints through CSS, not through its markup', () => {
    // Guards the fix as a contract: if someone moves the stroke back into the
    // scaffold or into setAttribute, the ring goes invisible again.
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const js = fs.readFileSync(path.join(STATIC_DIR, 'uplift_chat.js'), 'utf8');
    assert.ok(/\.chat-ctx \.ctx-arc\s*{\s*stroke:\s*var\(--ok\)/.test(css),
        'the arc stroke must be a CSS rule on a declared token');
    assert.ok(/\.chat-ctx\.ctx-hot \.ctx-arc\s*{\s*stroke:\s*var\(--bad\)/.test(css),
        'the near-limit state must be a class rule too');
    assert.ok(/classList\.toggle\('ctx-hot'/.test(js),
        'ctxRender must switch that class, not set a stroke attribute');
});

/* LOGO-BAND contract (measured 2026-10-25). The header row is 16px tall and
 * holds three claimants: the wordmark + a skin's `.logo::after` suffix (in
 * flow), and the DEV stamp + version pair (`.logo-build` / `.logo-base`,
 * raised absolutely alongside). The suffix rule uses `vertical-align: bottom`,
 * which drops a 9px skin tagline's ink to y93..102 — the same band the second
 * version line paints (y95..103). With the DEV pair present that collided:
 * ' // H-A-L 9000' over 'omlx v0.7.3.dev2 · 78fa08b', 9x7px of ink on ink.
 * The `.has-build-lines` hook must therefore lift the suffix onto the wordmark
 * row. Clip or reflow alternatives were rejected: they cost information or
 * move the header, both of which the geometry contract forbids.
 */
test('logo-band: skin suffix rides the wordmark row when the DEV pair paints', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const rule = /\.logo\.has-build-lines::after\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, '.logo.has-build-lines::after rule is gone — the skin '
        + 'suffix will drop into the DEV version line and overlap it');
    const va = /vertical-align:\s*([a-z-]+)/.exec(rule[1]);
    assert.ok(va, 'the pair rule must pin vertical-align; without it the base '
        + '.logo::after bottom alignment puts skin ink on the version band');
    assert.equal(va[1], 'top',
        `logo suffix vertical-align is '${va[1]}'; only 'top' keeps a 9px skin `
        + 'suffix out of the y95..103 version band (measured, discovery-one skin)');
});
