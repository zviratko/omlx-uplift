/* UP-68 (option 5): the classic palette bridge. uplift_skinbridge.js is a
   UMD data module required directly (uplift_gspec.js pattern), so the page
   and this file read the same crosswalk. The classic-checkout block is the
   drift pin: an upstream token rename or a new token must fire HERE, because
   a stale name in our crosswalk fails silently (we would set a variable
   nothing reads and classic would keep its stock colour). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATIC_DIR = path.join(__dirname, '..', 'omlx_uplift', 'static');
const B = require(path.join(STATIC_DIR, 'uplift_skinbridge.js'));

/* ---- classic checkout discovery (globalspec.test.cjs form) ---- */
const CT_REL = ['apps', 'omlx-web', 'omlx_web', 'static', 'js', 'custom_theme.js'];
const CT_REL_OLD = ['omlx', 'admin', 'static', 'js', 'custom_theme.js'];
function classicRoot() {
    const cands = [process.env.OMLX_SRC,
        path.join(os.homedir(), 'git', 'omlx-upstream'),
        path.join(__dirname, '..', '..', '..')];
    for (const c of cands) {
        if (!c) continue;
        for (const rel of [CT_REL, CT_REL_OLD])
            if (fs.existsSync(path.join(c, ...rel))) return path.join(c, ...rel);
    }
    return null;
}
const CT_FILE = classicRoot();

/* ---- helpers ---- */
const FULL = { bg: '#101014', card: '#1a1a20', panel: '#141419',
               ink: '#f2f0ea', dim: '#a5a096', edge: '#3a3b40',
               accent: '#e8a020' };
const cls = (palette, extra) => Object.assign(
    { theme: 'dark', enhanced: false, colors: true, palette }, extra || {});

test('normalizeHex flattens to opaque #rrggbb and rejects alpha', () => {
    assert.strictEqual(B.normalizeHex('#abc'), '#aabbcc');
    assert.strictEqual(B.normalizeHex('#232427'), '#232427');
    assert.strictEqual(B.normalizeHex('#23242780'), null, 'hex+alpha');
    assert.strictEqual(B.normalizeHex('#2324'), null, 'short hex+alpha');
    assert.strictEqual(B.normalizeHex('rgb(35, 36, 39)'), '#232427');
    assert.strictEqual(B.normalizeHex('rgb(35 36 39)'), '#232427');
    assert.strictEqual(B.normalizeHex('rgba(35,36,39,1)'), '#232427');
    assert.strictEqual(B.normalizeHex('rgba(35,36,39,0.5)'), null);
    assert.strictEqual(B.normalizeHex('rgb(35 36 39 / 100%)'), '#232427');
    assert.strictEqual(B.normalizeHex('hsl(40, 90%, 50%)'), null, 'not a hex we can promise');
    assert.strictEqual(B.normalizeHex(''), null);
    assert.strictEqual(B.normalizeHex(null), null);
    assert.strictEqual(B.normalizeHex('#gg1122'), null);
});

test('contrast() is WCAG: 21:1 for black on white, 1:1 for identical', () => {
    assert.ok(Math.abs(B.contrast('#000000', '#ffffff') - 21) < 0.02);
    assert.ok(Math.abs(B.contrast('#123456', '#123456') - 1) < 1e-9);
});

test('filterContrast drops the failing foreground, keeps the grounds', () => {
    const r = B.filterContrast({ 'bg-primary': '#ffffff', 'bg-secondary': '#fafafa',
                                 'text-primary': '#eeeeee', 'link-color': '#2563eb' });
    assert.ok(!('text-primary' in r.vals), 'near-white ink on white must go');
    assert.deepStrictEqual(r.dropped, ['text-primary']);
    assert.strictEqual(r.vals['bg-primary'], '#ffffff', 'grounds are never dropped');
    assert.ok('link-color' in r.vals, 'a readable foreground stays');
});

test('filterContrast is a no-op on a readable set', () => {
    const vals = { 'bg-primary': '#101014', 'text-primary': '#f2f0ea',
                   'text-secondary': '#a5a096', 'link-color': '#e8a020' };
    const r = B.filterContrast(vals);
    assert.deepStrictEqual(r.dropped, []);
    assert.deepStrictEqual(Object.keys(r.vals).sort(), Object.keys(vals).sort());
});

test('userSetTokens reads what classic theme editor already committed', () => {
    const css = ':root { --bg-primary: #ffffff; --link-color: #123456; }\n'
              + '[data-theme="dark"] { --bg-primary: #000000; }';
    const s = B.userSetTokens(css);
    assert.ok(s.has('bg-primary') && s.has('link-color'));
    assert.ok(!s.has('text-primary'));
    assert.strictEqual(B.userSetTokens('').size, 0);
    assert.strictEqual(B.userSetTokens(null).size, 0);
});

test('userTokenValues keeps the values, for cross-ownership contrast', () => {
    const v = B.userTokenValues(':root[data-theme="light"] { --bg-primary: #334455;'
        + ' --surface-scale-white: 51 68 85; }');
    assert.deepStrictEqual(v, { 'bg-primary': '#334455' },
        'a token that is not a colour is not a token we can judge');
    assert.deepStrictEqual(B.userTokenValues(''), {});
});

test('bridge maps the full crosswalk from a full palette', () => {
    const r = B.bridge(cls(FULL), {});
    assert.ok(r.css.includes(':root[' + B.SCOPE_ATTR + ']'),
        'scope must outrank classic\'s [data-theme="dark"] block');
    for (const [ct] of B.CROSSWALK)
        assert.ok(r.css.includes('--' + ct + ':'), 'missing ' + ct);
    assert.strictEqual(r.dropped.length, 0);
});

test('bridge: a crate that declares nothing is left alone', () => {
    const r = B.bridge(cls({}), {});
    assert.strictEqual(r.css, '');
    assert.strictEqual(r.reason, 'empty');
});

test('bridge: only DECLARED tokens map (no inherited uplift defaults)', () => {
    const r = B.bridge(cls({ bg: '#101014', card: '#1a1a20' }), {});
    assert.deepStrictEqual(Object.keys(r.vals).sort(),
        ['bg-primary', 'bg-secondary']);
    assert.ok(!('text-primary' in r.vals),
        'ink undeclared -> classic keeps its own readable ink');
});

test('bridge: classic.colors false opts the crate out', () => {
    const r = B.bridge(cls(FULL, { colors: false }), {});
    assert.strictEqual(r.css, '');
    assert.strictEqual(r.reason, 'off');
});

test('bridge: a token the user set in classic wins', () => {
    const stock = B.userSetTokens(':root{--link-color:#123456;}');
    const r = B.bridge(cls(FULL), { stock });
    assert.ok(!('link-color' in r.vals), 'user edit must not be overwritten');
    assert.ok('timeline-accent' in r.vals,
        'a different classic token is still fair game');
});

/* The pair the reader sees is (their ground, our ink) as much as it is
   (our ground, our ink) — the live QA pass caught this on inkwell under an
   operator '#334455' ground: 1.7:1, and nothing flagged it. */
test('bridge: our ink is checked against the operator\'s ground', () => {
    const inkwell = { bg: '#f7f7f5', card: '#fdfdfb', panel: '#ececea',
                      ink: '#1a1a1a', dim: '#5f5f5c', edge: '#d2d2cc',
                      accent: '#14566b' };
    const r = B.bridge(cls(inkwell),
        { stockText: ':root[data-theme="light"] { --bg-primary: #334455;'
                   + ' --surface-scale-white: 51 68 85; }' });
    assert.ok(!('bg-primary' in r.vals), 'the operator owns that token');
    assert.ok(!('text-primary' in r.vals),
        'dark crate ink on the operator\'s dark ground is unreadable');
    assert.ok(r.dropped.includes('text-primary'));
    assert.ok('bg-secondary' in r.vals && 'border-faint' in r.vals,
        'the rest of the crate still ships');
});

test('bridge: our grounds are withdrawn under the operator\'s ink', () => {
    // light crate, light operator ink: the grounds are the half we own, so
    // they go and classic paints its own ground under the operator's text
    const light = { bg: '#f7f7f5', card: '#fdfdfb', panel: '#ececea',
                    ink: '#1a1a1a', dim: '#5f5f5c', edge: '#d2d2cc',
                    accent: '#14566b' };
    const r = B.bridge(cls(light),
        { stockText: ':root { --text-primary: #f0f0f0; }' });
    assert.ok(!('bg-primary' in r.vals),
        'a light ground under the operator\'s near-white ink is not ours to paint');
    assert.ok(!('bg-secondary' in r.vals) && !('bg-tertiary' in r.vals));
    assert.ok(!('text-primary' in r.vals), 'their token, never sent either way');
    assert.ok('border-faint' in r.vals, 'a token no rule covers still ships');
});

test('bridge: an unreadable skin ink falls back instead of poisoning classic', () => {
    // a dark crate worn with white grounds: every foreground we would carry
    // fails classic's floor, so classic keeps its OWN inks on the white ground
    const r = B.bridge(cls(Object.assign({}, FULL,
        { bg: '#ffffff', card: '#ffffff', panel: '#ffffff', ink: '#f4f4f4' })), {});
    assert.deepStrictEqual(r.dropped, ['text-primary', 'text-secondary', 'link-color']);
    assert.ok(!('text-primary' in r.vals) && !('link-color' in r.vals));
    assert.ok('bg-primary' in r.vals, 'the white ground still ships');
    assert.ok('border-faint' in r.vals, 'a non-text token is not gated');
});

test('bridge: alpha and junk token values are dropped, not injected', () => {
    const r = B.bridge(cls(Object.assign({}, FULL,
        { ink: 'rgba(242,240,234,0.6)', dim: 'var(--ink)' })), {});
    assert.ok(!('text-primary' in r.vals));
    assert.ok(!('text-secondary' in r.vals));
    assert.ok('bg-primary' in r.vals);
});

test('buildCss sorts declarations (stable text, no churn on re-sync)', () => {
    const css = B.buildCss({ 'text-primary': '#ffffff', 'bg-primary': '#000000' });
    assert.ok(css.indexOf('--bg-primary') < css.indexOf('--text-primary'));
    assert.strictEqual(B.buildCss({}), '');
});

test('crosswalk: targets are classic tokens, sources are uplift tokens', () => {
    for (const [ct, ut] of B.CROSSWALK) {
        assert.ok(B.CLASSIC_TOKENS.includes(ct), 'unknown classic token ' + ct);
        assert.ok(B.CLASSIC_BRIDGE_TOKENS.includes(ut), 'unpublished crate token ' + ut);
    }
});

test('crosswalk sources match the server-side list byte for byte', () => {
    // skins.py CLASSIC_BRIDGE_TOKENS is what classic_palette() publishes; the
    // JS list is what the bridge consumes. A pair out of sync = a token that
    // ships in the API and is never used, or one used and never published.
    const py = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'skins.py'), 'utf8');
    const m = py.match(/CLASSIC_BRIDGE_TOKENS = \(([^)]*)\)/);
    assert.ok(m, 'CLASSIC_BRIDGE_TOKENS not found in skins.py');
    const server = m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    assert.deepStrictEqual(B.CLASSIC_BRIDGE_TOKENS.slice().sort(), server.slice().sort());
    for (const [, ut] of B.CROSSWALK)
        assert.ok(server.includes(ut), 'crosswalk uses ' + ut + ' but the API never publishes it');
});

test('our token list does not collide with classic style ids', () => {
    assert.notStrictEqual(B.STYLE_ID, B.CLASSIC_STYLE_ID);
});

/* ---- the drift pin ---- */
test('classic still owns exactly the tokens our crosswalk names',
    { skip: CT_FILE ? false : 'no classic checkout (set OMLX_SRC)' }, () => {
    const src = fs.readFileSync(CT_FILE, 'utf8');
    const g = src.match(/const GROUPS = \[([\s\S]*?)\n\s*\];/);
    assert.ok(g, 'custom_theme.js GROUPS not found — the contract moved');
    const theirs = [];
    for (const m of g[1].matchAll(/tokens:\s*\[([^\]]*)\]/g))
        theirs.push(...m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    assert.ok(theirs.length >= 15, 'GROUPS parse went thin: ' + theirs.length);
    for (const t of theirs)
        assert.ok(B.CLASSIC_TOKENS.includes(t),
            'classic gained token ' + t + ' — decide whether to map it (UP-68)');
    for (const t of B.CLASSIC_TOKENS)
        assert.ok(theirs.includes(t),
            'classic dropped/renamed ' + t + ' — the crosswalk pair is now dead');
    for (const [ct] of B.CROSSWALK)
        assert.ok(theirs.includes(ct), 'crosswalk maps a token classic no longer has: ' + ct);
    // the surface we write into must still be the one classic honours
    assert.ok(src.includes("STYLE_ID = 'omlx-custom-theme'"),
        'classic changed its style id — re-check the bridge scope');
    assert.ok(/document\.head\.appendChild\(style\)/.test(src),
        'classic no longer paints via a <head> style node — the bridge mechanism is gone');
});
