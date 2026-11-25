'use strict';
// SYNC-1 run 39 (upstream range 67890e3d..9ff073ce). Two mirrors:
//
// (a) b1fbfff3 (#5496) stopped sending the master API key on polled GETs:
//     /admin/api/stats now reports only `api_key_set`, and the secret comes
//     from POST /admin/api/auth/api-key when the operator actually copies.
//     Uplift's helper card read `stats.api_key`, so after that commit the
//     Claude Code line lost its ANTHROPIC_AUTH_TOKEN on copy AND its bullets on
//     screen - a command that silently does not authenticate.
//
// (b) 0de7c92f (#5566) taught GET /admin/api/oq/estimate to price an export
//     with text_only, dtype and mtp_assistant_model_path. Uplift's quantizer
//     preview kept sending the three old params, so its `est:` line quietly
//     disagreed with the Start payload the same form sends.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.join(__dirname, '..', 'omlx_uplift', 'static');
const GSPEC = require(path.join(STATIC, 'uplift_gspec.js'));
const read = (n) => fs.readFileSync(path.join(STATIC, n), 'utf8');
const HELPER = read('uplift_helper.js');
const MODELSOPS = read('uplift_modelsops.js');

const CLOUD = { mode: 'cloud' };
const LOCAL = { mode: 'local' };
const BULLETS = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

// ---- (a) the masked line must not need the secret -------------------------
test('run 39: the masked Claude Code line renders bullets from apiKeySet alone',
    () => {
        // classic's display value is `_claudeCodeCommand(stats.api_key_set ?
        // '••••••••' : '')` (dashboard.js:4327) - the flag, never the token
        const masked = GSPEC.claudeCodeCommand(LOCAL,
            { host: 'h', port: 8001, apiKeySet: true }, { mask: true });
        // shellQuote wraps the value, so match the token with or without quotes
        assert.match(masked, /ANTHROPIC_AUTH_TOKEN='?\u2022{8}'?/,
            'a caller that only knows api_key_set must still get bullets: ' + masked);
        assert.ok(masked.includes('ANTHROPIC_BASE_URL'),
            'the masked line must stay a complete command');
    });

test('run 39: no key set means no token half at all, masked or real', () => {
    for (const opts of [{ mask: true }, {}]) {
        const out = GSPEC.claudeCodeCommand(LOCAL, { port: 8001 }, opts);
        assert.ok(!out.includes('ANTHROPIC_AUTH_TOKEN'),
            `empty flag leaked a token field (mask=${!!opts.mask}): ${out}`);
    }
});

test('run 39: the real copy still carries the fetched secret verbatim', () => {
    const real = GSPEC.claudeCodeCommand(LOCAL,
        { host: 'h', port: 8001, apiKey: 'sk-secret' });
    assert.match(real, /ANTHROPIC_AUTH_TOKEN='?sk-secret'?/, real);
    assert.ok(!real.includes(BULLETS), 'the real command must not be masked');
    // a fetched secret must not override the mask into leaking
    const masked = GSPEC.claudeCodeCommand(LOCAL,
        { port: 8001, apiKey: 'sk-secret' }, { mask: true });
    assert.ok(!masked.includes('sk-secret'), 'the masked line leaked the secret');
});

test('run 39: cloud mode needs no token, so the helper must not fetch one',
    () => {
        assert.match(GSPEC.claudeCodeCommand(CLOUD, { apiKeySet: true }, { mask: true }),
            /^env -u ANTHROPIC_BASE_URL .* claude$/,
            'classic returns the bare unset-env line in cloud mode');
        // and the caller must honour that: no POST when the mode is cloud
        assert.match(HELPER, /if \(\(ccSec \|\| \{\}\)\.mode === 'cloud'\)\s*\n\s*return Promise\.resolve/,
            'the helper must short-circuit the key fetch in cloud mode');
    });

// ---- (a) the caller side --------------------------------------------------
test('run 39: the helper reads api_key_set, never the retired api_key field',
    () => {
        assert.match(HELPER, /apiKeySet: !!stats\.api_key_set/,
            'the card must build its connection from the flag');
        assert.ok(!/apiKey: stats\.api_key\b/.test(HELPER),
            'stats.api_key no longer exists upstream (b1fbfff3) - reading it ' +
            'yields undefined and the command silently loses its token');
        assert.match(HELPER,
            /HG\.postJson\(`\$\{API\}\/admin\/api\/auth\/api-key`, \{\}\)/,
            'the secret must come from the explicit POST, on copy');
    });

test('run 39: cmdLine accepts a thunk and never marks copied on a failed fetch',
    () => {
        assert.match(HELPER, /const thunk = typeof cmd === 'function';/,
            'cmdLine must resolve a deferred command at click time');
        assert.match(HELPER,
            /Promise\.resolve\(\)\.then\(cmd\)\.then\(text => \{ if \(text\) copy\(text\); \}/,
            'a thunk must be awaited, and an empty result must not be copied');
        // classic's contract: the copied tick means the clipboard really got
        // the command, so a rejected fetch must not flash it
        const onclick = /cp\.onclick = \(\) => \{[\s\S]*?\n        \};/.exec(HELPER);
        assert.ok(onclick, 'cp.onclick not found inside cmdLine');
        // fulfil arm copies, rejection arm does nothing
        assert.match(onclick[0],
            /\.then\(text => \{ if \(text\) copy\(text\); \},\s*\n\s*\(\) => \{\}\);/,
            'the thunk call must pass a copying fulfil arm and a no-op rejection ' +
            'arm: no copied mark on failure, and no new locale key invented for ' +
            'a silent failure');
    });

// ---- (a3) the settings eye must reveal a key the GET no longer returns ---
test('run 39: the API-key row reveals the stored key on demand, then drops it',
    () => {
        const gsys = read('uplift_gsys.js');
        const fn = /function gsBodySanitize\(\) \{[\s\S]*?\n\}/.exec(gsys);
        assert.ok(fn, 'gsBodySanitize not found');
        const src = fn[0];
        assert.match(src, /\/admin\/api\/auth\/api-key/,
            'the eye must fetch the stored key: the settings GET now returns ' +
            'only auth.api_key_set, so flipping the type shows an empty box on ' +
            'a server that has a key');
        assert.match(src, /api_key_set/, 'the flag gates the fetch');
        assert.match(src, /dataset\.flat === 'api_key'/,
            'only the stored-key row may fetch; other password rows are the ' +
            "operator's own text");
        assert.match(src, /if \(inp\.__revealedKey\) \{ inp\.value = '';/,
            'hiding must drop the fetched secret from the DOM');
        // a programmatic value set must not mark the row dirty: the save reads
        // GS and gsDirty, never the input, so a reveal can never write the key
        assert.ok(!/dispatchEvent|new Event/.test(src),
            'the reveal must not fire input/change - that would queue a save ' +
            'and could write the key back on an unrelated commit');
    });

// ---- (b) the oQ estimate must price the same export Start will build ------
test('run 39: the estimate request carries every option the Start payload sends',
    () => {
        const fn = /function refreshEst\(\) \{[\s\S]*?\n        \}/.exec(MODELSOPS);
        assert.ok(fn, 'refreshEst not found in uplift_modelsops.js');
        const src = fn[0];
        // classic's oqOutputOptions() is the single source of truth for both
        // the estimate and the export (0de7c92f); these three are what it added
        for (const key of ['text_only', 'dtype', 'mtp_assistant_model_path',
            'preserve_mtp', 'preserve_ngram_table', 'oq_level', 'model_path']) {
            assert.ok(new RegExp(`\\b${key}:`).test(src),
                `the estimate no longer sends ${key} - the preview would price ` +
                'a different export than Start builds');
        }
        assert.match(src, /dtype: dtype\.v/, 'dtype must ride the toggle state');
        assert.match(src, /text_only: cbText\.checked/, 'text_only must ride the checkbox');
        assert.match(src, /selCombine\.value \|\| ''/,
            'the donor must come from the picker, empty for None (classic sends "")');
    });

test('run 39: every option that prices the estimate re-arms it', () => {
    const arms = MODELSOPS.match(/refreshEst\(\)|refreshEst;/g) || [];
    assert.ok(arms.length >= 7,
        `expected the estimate to re-arm on level, sensitivity, MTP, n-gram, ` +
        `text-only, dtype and donor; found ${arms.length} arm sites`);
    // the two that this run added, pinned by their handler sites
    const dtypeBlock = /b\.onclick = \(\) => \{[\s\S]*?\n        \};/.exec(MODELSOPS);
    assert.ok(dtypeBlock && /refreshEst\(\);/.test(dtypeBlock[0]),
        'the dtype toggle must refresh the estimate (it changed the price)');
    assert.match(MODELSOPS, /selCombine\.onchange = refreshEst;/,
        'the MTP donor must refresh the estimate (it changed the price)');
});

test('run 39: a stale estimate response cannot overwrite a newer one', () => {
    // classic guards with _oqEstimateRevision; without it a slow response for
    // the old selection lands on top of the new one
    assert.match(MODELSOPS, /let estRev = 0;/, 'no revision counter');
    assert.match(MODELSOPS, /const rev = \+\+estRev;/, 'the request must claim a revision');
    const then = /\.then\(e => \{([\s\S]{0,80})/.exec(MODELSOPS);
    assert.ok(then && /if \(rev !== estRev\) return;/.test(then[1]),
        'the fulfil arm must drop a superseded response');
    assert.match(MODELSOPS, /\.catch\(err => \{\s*\n\s*if \(rev !== estRev\) return;/,
        'the reject arm must drop a superseded failure');
});

test('run 39: moving an option blanks the stale number instead of keeping it',
    () => {
        const fn = /function refreshEst\(\) \{[\s\S]*?\n        \}/.exec(MODELSOPS)[0];
        const blankAt = fn.indexOf("est.textContent = '\\u2014'");
        const timerAt = fn.indexOf('estTimer = setTimeout');
        assert.ok(blankAt > 0, 'the estimate must clear on every option change');
        assert.ok(blankAt < timerAt,
            'the clear must happen before the debounce, not inside the response');
    });
