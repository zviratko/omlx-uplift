/* UP-26 items 2+3 (FEAT-1 parity): Applications launch commands + the
   new-omlx-release nudge. Command templating and the update-check verdict
   are pure (uplift_gspec.js, required directly); the rendering/clipboard
   half in uplift_helper.js is source-shape-pinned. Classic refs:
   templates/dashboard/blocks/_applications.html, dashboard.js:3816-3849
   (shellQuote/claudeCodeCommand), 4230-4281 (_launchCmd + getters),
   1163-1186 (checkForUpdate + hourly timer), _navbar.html:11-22 (badge). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const G = require(path.join(STATIC_DIR, 'uplift_gspec.js'));
const helper = fs.readFileSync(path.join(STATIC_DIR, 'uplift_helper.js'), 'utf8');

/* ---- item 2: shellQuote / launch templating (classic 3816/4230) ------- */
test('shellQuote is POSIX-safe (classic verbatim)', () => {
    assert.strictEqual(G.shellQuote('plain'), "'plain'");
    assert.strictEqual(G.shellQuote(''), "''");
    assert.strictEqual(G.shellQuote(null), "''");
    assert.strictEqual(G.shellQuote("it's"), `'it'"'"'s'`);
    assert.strictEqual(G.shellQuote('a/b c'), "'a/b c'");
});
test('launchCommand: omlx prefix unquoted, custom prefix quoted', () => {
    assert.strictEqual(G.launchCommand('claude', {}), 'omlx launch claude');
    assert.strictEqual(G.launchCommand('codex'), 'omlx launch codex');
    assert.strictEqual(G.launchCommand('codex_app', {}), 'omlx launch codex_app');
    assert.strictEqual(
        G.launchCommand('hermes', { cliPrefix: '/usr/local/bin/omlx dev' }),
        "'/usr/local/bin/omlx dev' launch hermes");
});
test('launchCommand: openclaw rides the tools profile, vibe the model', () => {
    assert.strictEqual(G.launchCommand('openclaw', {}),
        'omlx launch openclaw --tools-profile coding');       // classic default
    assert.strictEqual(G.launchCommand('openclaw', { toolsProfile: 'messaging' }),
        'omlx launch openclaw --tools-profile messaging');
    assert.strictEqual(G.launchCommand('vibe', {}), 'omlx launch vibe'); // no model
    assert.strictEqual(G.launchCommand('vibe', { model: "big'model" }),
        `omlx launch vibe --model 'big'"'"'model'`);
});

/* ---- item 2: claudeCodeCommand (classic dashboard.js:3826) ------------ */
test('claudeCodeCommand cloud mode unsets the env (classic literal)', () => {
    const c = G.claudeCodeCommand({ mode: 'cloud' }, {});
    assert.ok(c.startsWith('env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN'));
    assert.ok(c.endsWith('-u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC claude'));
});
test('claudeCodeCommand local mode: host/port + assigned models + LSP deny', () => {
    const c = G.claudeCodeCommand(
        { mode: 'local', opus_model: 'o', sonnet_model: 's', haiku_model: 'h' },
        { host: '192.168.1.10', port: 8000, apiKey: 'omlx-key' });
    assert.ok(c.includes("ANTHROPIC_BASE_URL='http://192.168.1.10:8000'"), c);
    assert.ok(c.includes("ANTHROPIC_AUTH_TOKEN='omlx-key'"));
    assert.ok(c.includes("ANTHROPIC_DEFAULT_OPUS_MODEL='o'"));
    assert.ok(c.includes("ANTHROPIC_DEFAULT_SONNET_MODEL='s'"));
    assert.ok(c.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL='h'"));
    assert.ok(c.includes('API_TIMEOUT_MS=3000000'));
    assert.ok(c.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'));
    assert.ok(c.endsWith('claude --disallowedTools LSP'));    // #2349 deny
});
test('claudeCodeCommand edges: default port, model placeholders, no key', () => {
    const c = G.claudeCodeCommand({}, { host: '0.0.0.0' });
    // 0.0.0.0 bind -> classic's displayHost placeholder (dashboard.js:3666)
    assert.ok(c.includes("ANTHROPIC_BASE_URL='http://your-ip-address:8000'"));
    assert.ok(c.includes("ANTHROPIC_DEFAULT_OPUS_MODEL='select-a-model'"));
    assert.ok(!c.includes('ANTHROPIC_AUTH_TOKEN'), 'unset key is omitted');
});
test('displayHostFor mirrors classic formatDisplayHost (dashboard.js:3655)', () => {
    assert.strictEqual(G.displayHostFor(''), '127.0.0.1');
    assert.strictEqual(G.displayHostFor('0.0.0.0'), 'your-ip-address');
    assert.strictEqual(G.displayHostFor('::'), 'your-ip-address');
    assert.strictEqual(G.displayHostFor('localhost'), '127.0.0.1');
    assert.strictEqual(G.displayHostFor('::1'), '[::1]');
    assert.strictEqual(G.displayHostFor('[::1]'), '[::1]');
    assert.strictEqual(G.displayHostFor('192.168.1.5'), '192.168.1.5');
});

/* ---- item 3: update-check verdict (classic dashboard.js:1163) --------- */
test('updateNudge maps the payload honestly, falls back to the repo URL', () => {
    assert.strictEqual(G.updateNudge(null), null);
    assert.strictEqual(G.updateNudge({ update_available: false }), null);
    const n = G.updateNudge({ update_available: true, latest_version: '0.9.9',
                              release_url: 'https://gh/releases/0.9.9' });
    assert.deepStrictEqual(n, { version: '0.9.9', url: 'https://gh/releases/0.9.9' });
    const f = G.updateNudge({ update_available: true });
    assert.strictEqual(f.version, '');
    assert.strictEqual(f.url, 'https://github.com/jundot/omlx');  // navbar fallback
});

/* ---- source pins: helper rendering + nudge boot ------------------------ */
test('helper renders per-row copy commands for the classic app set', () => {
    for (const tool of ['claude', 'codex', 'codex_app', 'opencode', 'openclaw',
                        'hermes', 'pi', 'vibe', 'copilot', 'dsh'])
        assert.ok(helper.includes(`launchCommand('${tool}'`), tool + ' row');
    assert.ok(helper.includes('claudeCodeCommand(ccSec'), 'env-form row');
    assert.ok(helper.includes("C.tf('status.integrations.copy_command_tooltip'"));
    assert.ok(helper.includes("C.tf('status.integrations.section_label'"));
    // the model-assignment half already existed; commands feed off it
    assert.ok(helper.includes('cliPrefix: stats.cli_prefix'));
    assert.ok(helper.includes('toolsProfile: integ.openclaw_tools_profile'));
    assert.ok(helper.includes('model: integ.vibe_model'));
});
test('helper fetches the command inputs from the classic endpoints', () => {
    assert.match(helper, /HG\.fetchJson\(`\$\{API\}\/admin\/api\/stats`\)/);
    // claude_code section is kept alongside integrations (not dropped)
    assert.match(helper, /ccSec = gs\.claude_code \|\| \{\}/);
});
test('update nudge: hourly recheck, release link, separate from the build chip', () => {
    assert.match(helper, /HG\.fetchJson\(`\$\{API\}\/admin\/api\/update-check`\)/);
    assert.match(helper, /setInterval\(upUpdateCheck, 3600000\)/);   // classic 1178
    assert.ok(helper.includes("C.tf('navbar.update_available'"));
    assert.match(helper, /chip\.href = n\.url/);
    assert.match(helper, /chip\.hidden = true/);       // silent on no-update/error
    // own-build chip (uplift_boot.js #logo-build) is NOT touched here
    assert.ok(!/getElementById\(['"]logo-build|'logo-build'\)/.test(helper),
        'dev-keg flag stays separate');
    // kit fetchJson, not a bare fetch — the raw-fetch gate does not apply
    assert.ok(!/(^|[^.\w])fetch\(/.test(helper), 'no raw fetch() in helper');
});
test('nudge anchors into the header chips and survives a missing header', () => {
    assert.match(helper, /document\.getElementById\('chip-uptime'\)/);
    assert.match(helper, /if \(!host\) return;   \/\/ no header chips/);
    assert.match(helper, /insertAdjacentElement\('afterend', chip\)/);
});
