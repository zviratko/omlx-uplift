'use strict';
// SYNC-1 run 39 (user request 2026-11-25): the login document used to load
// ./uplift.css?v=BUILD. That link could never work: `BUILD` is the dashboard's
// serve-time VSTAMP placeholder and the login document is built by a different
// code path that never substitutes it, and the Uplift static route sits behind
// the admin session gate - which a login page, by definition, has not passed.
// The stylesheet answered 401 signed in or out, so every var() in the inline
// rules resolved to nothing: the card lost its border, its background and the
// input outline. A live browser measured border '0px none' and background
// 'rgba(0, 0, 0, 0)'.
//
// The fix makes the page self-contained. These tests pin the two properties
// that keep it fixed: the dead link must stay gone, and the inlined tokens must
// stay equal to the app's real :root values (a copy that drifts is worse than
// no copy, because it looks themed and is not).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const PAGES = fs.readFileSync(
    path.join(__dirname, '..', 'omlx_uplift', 'routers', 'pages.py'), 'utf8');
const CSS = fs.readFileSync(path.join(STATIC, 'uplift.css'), 'utf8');

// ---- helpers ---------------------------------------------------------------
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function pythonBlock(name) {
    const m = new RegExp(name + '\\s*=\\s*"""([\\s\\S]*?)"""').exec(PAGES);
    assert.ok(m, `pages.py no longer defines ${name} as a triple-quoted string`);
    return m[1];
}

// token map from a CSS declaration block: name -> trimmed value.
// Split on ';' (not newlines): a compact block may pack several tokens per
// line, and the first token rides on the same chunk as the `:root {` selector.
function tokensFrom(declBlock) {
    const out = new Map();
    const flat = stripComments(declBlock).replace(/\s+/g, ' ');
    for (const decl of flat.split(';')) {
        const m = /(--[a-z0-9-]+)\s*:\s*([^;{}]+)$/.exec(decl.trim());
        if (m) out.set(m[1], m[2].trim());
    }
    return out;
}

const cssRoot = tokensFrom(/^\s*:root\s*\{([\s\S]*?)^\}/m.exec(stripComments(CSS))[1]);
assert.ok(cssRoot.size > 10, 'uplift.css :root block did not parse');

const LOGIN_STYLE = pythonBlock('_LOGIN_STYLE');
const loginRoot = tokensFrom(LOGIN_STYLE);

// the _login_doc body: from its def to the next top-level def
const loginDocSrc = /def _login_doc[\s\S]*?(?=\n[A-Za-z_]+ =|\ndef )/.exec(PAGES);
assert.ok(loginDocSrc, 'pages.py: _login_doc not found');

// ---- 1: the dead link is gone ---------------------------------------------
test('run 39: the login document no longer links the session-gated stylesheet',
    () => {
        // check the emitted tags, not the words: the source comment explaining
        // the removal names the file it removed
        const links = [...loginDocSrc[0].matchAll(/<link\b[^>]*>/g)].map(m => m[0]);
        assert.ok(links.length > 0, 'no <link> tag found in _login_doc');
        const sheets = links.filter(l => /stylesheet/.test(l));
        assert.deepStrictEqual(sheets, [],
            '_login_doc must not link a stylesheet: the Uplift static route ' +
            'requires an admin session, so a pre-auth page can never load it');
        // every remaining link must be the icon, and none may carry the
        // never-stamped query VER-1 (5f2286d) retired for the rest of the bundle
        for (const l of links) {
            assert.match(l, /rel=\\"icon\\"/, `unexpected link: ${l}`);
            assert.ok(!l.includes('?v='), `link carries a query stamp: ${l}`);
        }
        assert.ok(loginDocSrc[0].includes('<style>{_LOGIN_STYLE}</style>'),
            '_login_doc must inline _LOGIN_STYLE');
    });

// ---- 2: every var() the login rules use is declared in the same document --
test('run 39: every var() the login style consumes is declared by it', () => {
    const used = new Set();
    for (const m of LOGIN_STYLE.matchAll(/var\((--[a-z0-9-]+)[),]/g)) used.add(m[1]);
    assert.ok(used.size >= 6,
        `expected the login style to use its tokens, saw ${used.size}`);
    const missing = [...used].filter((t) => !loginRoot.has(t));
    assert.deepStrictEqual(missing, [],
        `login style uses undeclared token(s): ${missing.join(', ')} - ` +
        'an undeclared var() resolves to nothing and silently drops the rule');
});

// ---- 3: the inlined copies must not drift from the app's real values ------
test('run 39: the inlined login tokens equal uplift.css :root', () => {
    const drift = [];
    for (const [name, value] of loginRoot) {
        if (!cssRoot.has(name)) {
            drift.push(`${name}=${value} (no such token in uplift.css)`);
        } else if (cssRoot.get(name) !== value) {
            drift.push(`${name}: login '${value}' vs app '${cssRoot.get(name)}'`);
        }
    }
    assert.deepStrictEqual(drift, [],
        'the login page restates the base theme by hand, so it must match it:\n  ' +
        drift.join('\n  '));
});

// ---- 4: the rules the bug actually broke are present and token-based ------
test('run 39: the card and field rules the 401 flattened are still token-driven',
    () => {
        // these three are the declarations a live browser measured as '0px none'
        assert.match(LOGIN_STYLE,
            /\.login-card\s*\{[^}]*border:1px solid var\(--ink\)/,
            'the card border rule changed shape; re-measure the login page');
        assert.match(LOGIN_STYLE,
            /\.login-card\s*\{[^}]*background:var\(--card\)/,
            'the card background rule changed shape');
        assert.match(LOGIN_STYLE,
            /input[^{]*\{[^}]*border:1px solid var\(--edge\)/,
            'the field outline rule changed shape');
        // the page must still paint the ground, or a dark theme on a white
        // browser default is the original bug in a new costume
        assert.match(LOGIN_STYLE, /body\s*\{[^}]*background:var\(--bg\)/,
            'the login body must set its own ground colour');
    });

// ---- 5: VER-1's retirement of the dead query must stay complete ----------
test('run 39: no shipped asset ref carries the never-stamped BUILD query',
    () => {
        // _ASSET_URL_RE is rb'((?:src|href)="\./[^"?]+)(")' - a URL that
        // already carries a '?' is skipped, so a hand-written ?v= query does
        // not just look wrong, it actively opts the asset out of stamping.
        const haystacks = {
            'routers/pages.py': PAGES,
            'static/index.html': fs.readFileSync(
                path.join(STATIC, 'index.html'), 'utf8'),
        };
        const offenders = [];
        for (const [name, text] of Object.entries(haystacks)) {
            for (const raw of text.split('\n')) {
                const line = raw.trim();
                // a comment may describe the dead query; code may not emit it
                if (/v=BUILD/.test(line) && !/^(#|\/\/|\*)/.test(line)) {
                    offenders.push(`${name}: ${line}`);
                }
            }
        }
        assert.deepStrictEqual(offenders, [],
            'a live asset ref carries ?v=BUILD, which no code substitutes:\n  ' +
            offenders.join('\n  '));
        // the dashboard's own stylesheet link must stay stampable (no query)
        assert.match(haystacks['static/index.html'],
            /<link rel="stylesheet" href="\.\/uplift\.css">/,
            'index.html must link ./uplift.css with no query so the route ' +
            'can stamp it');
    });
