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
// UP-48 (2026-10-26): --fs-meta/--line/--rule are now declared in :root as
// house aliases (user delegated the visual call to the designer; feedback
// route = look for the patches-table frame, row separators and 11px meta
// text). The ratchet holds a genuinely clean sheet from here.
const BASELINE = [];

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
 * carries three claimants: the wordmark plus a skin's `.logo::after` tagline
 * (INLINE, so it starts right of the stamp), and the DEV stamp + version pair
 * (`.logo-build` / `.logo-base`, absolutely positioned in the same band).
 * With the pair present and a skin painting a tagline, the version line's
 * 200px allowance reached under the suffix and the two overlapped by 9x7px
 * (' // H-A-L 9000' over 'omlx v0.7.3.dev2 · 78fa08b').
 * The bound lives in uplift_boot.js, where the stamp's real width is
 * measurable; a `vertical-align` change here was tried first and is a NO-OP,
 * because `.logo.has-build-lines::after` sets a 16px line-height equal to the
 * wordmark's line box, so top and bottom alignment coincide. These assertions
 * keep both facts honest.
 */
test('logo-band: version line is bounded when a skin paints a tagline', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const boot = fs.readFileSync(path.join(STATIC_DIR, 'uplift_boot.js'), 'utf8');

    // the pair paints a suffix hook; the version line must stay clip-capable
    const baseRule = /\.logo\.logo-build \.logo-base\s*\{([^}]*)\}/.exec(css)
        || /\.logo-base\s*\{([^}]*)\}/.exec(css);
    assert.ok(baseRule && /max-width:/.test(baseRule[1]),
        '.logo-base lost its max-width — without a cap nothing can absorb the '
        + 'tagline collision and the strings overlap again');
    assert.ok(/text-overflow:\s*ellipsis/.test(css),
        'the version line must truncate with an ellipsis, not spill ink');

    // and the runtime bound must exist: read ::after content, narrow line 2
    assert.ok(/getComputedStyle\([^)]*'::after'\)/.test(boot),
        'uplift_boot.js no longer inspects the skin tagline (.logo::after) — '
        + 'the version line will run under it again');
    assert.ok(/maxWidth/.test(boot) && /getBoundingClientRect\(\)/.test(boot),
        'uplift_boot.js no longer bounds the version line to the stamp column');
});

/* THE COLUMN MUST EXIST (user, 2026-10-25: "there are no version strings and
 * timestamps visible at all now — not good"). Two separate causes hid them:
 *   1. the runtime width cap was computed before layout existed, so it set
 *      max-width to the bare gutter (16px) and clipped line 2 to a stub;
 *   2. `@media (max-width: 1140px)` hid the WHOLE column, which was over-cautious:
 *      measured across 931..1600px the column keeps a constant 27px clearance to
 *      the tabs strip, clips no tab label and never grows the header.
 * Both are cheap to reintroduce, so both are pinned.
 */
test('logo-band: build column stays visible at ordinary window widths', () => {
    const css = fs.readFileSync(path.join(STATIC_DIR, 'uplift.css'), 'utf8');
    const boot = fs.readFileSync(path.join(STATIC_DIR, 'uplift_boot.js'), 'utf8');

    let worst = 0;
    for (const m of css.matchAll(/@media[^{]*\(max-width:\s*(\d+)px\)\s*\{([^}]*)\}/g)) {
        if (/\.logo-(build|base)\b[^;]*\{?[^}]*display:\s*none/.test(m[2])
            || (/\.logo-(build|base)/.test(m[2]) && /display:\s*none/.test(m[2]))) {
            worst = Math.max(worst, parseInt(m[1], 10));
        }
    }
    assert.ok(worst <= 930,
        `the build column is hidden up to ${worst}px — a 1280px laptop with a `
        + 'side panel is under 1141px and loses its only version readout');

    // the cap may only be applied from a real measurement
    assert.ok(/getBoundingClientRect\(\)\.width/.test(boot)
        && /if \(w < /.test(boot),
        'the version-line cap no longer checks the measured width — a pre-layout '
        + 'read of 0 collapses the line to an invisible stub');
    assert.ok(/requestAnimationFrame\(cap\)|fonts\.ready/.test(boot),
        'the cap should be applied after layout, not synchronously at build time');
});
