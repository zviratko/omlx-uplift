// UP-24/25/27 gate: task REMOVE, clear/purge buttons, shell logout.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = f => fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', f), 'utf8');

test('UP-24: terminal task rows get REMOVE on every board kind', () => {
    const d = S('uplift_downloader.js');
    const i = d.indexOf("if (['downloading', 'quantizing'");
    const seg = d.slice(i, d.indexOf('host.append(r);', i));
    assert.match(seg, /mkAct\('REMOVE'/);
    assert.match(seg, /DG\.deleteJson\(`\$\{API\}\/admin\/api\/\$\{kind\}\/task\/\$\{tid\}`\)/);
    // REMOVE lives on the terminal branch, NOT the active one
    const activeEnd = seg.indexOf("r.classList.add('with-acts'); r.append(acts);\n            } else {");
    assert.ok(activeEnd > 0, 'active branch closes before the terminal else');
    assert.ok(seg.indexOf("mkAct('REMOVE'") > activeEnd);
    assert.ok(seg.indexOf("'RETRY'") > seg.indexOf('mkAct(\'REMOVE\''), 'retry still offered for hf failures');
    assert.match(seg, /if \(acts\.childNodes\.length\)/);   // one append, no dupes
});

test('UP-25: session/all-time clear + cache purges wired with classic confirms', () => {
    const u = S('uplift_usage.js');
    for (const [mount, url] of [['usage-actions', 'stats/clear'],
        ['usage-actions', 'stats/clear-alltime'],
        ['cache-actions', 'ssd-cache/clear'], ['cache-actions', 'hot-cache/clear']]) {
        assert.ok(u.includes(`'${url}'`), url);
    }
    assert.match(u, /window\.confirm\(C\.tf\(confirmKey/);
    assert.match(u, /'status\.clear_confirm'/);
    assert.match(u, /'status\.clear_ssd_cache_confirm'/);
    assert.match(u, /'status\.runtime_cache\.clear_memory_confirm'/);
    assert.match(u, /window\.Uplift\._usageGlue\.pollStats\(\)/);
    assert.match(S('uplift.js'), /get pollStats\(\) \{ return pollStats; \}/);
    const h = S('index.html');
    assert.match(h, /id="usage-actions"/);
    assert.match(h, /id="cache-actions"/);
});

test('UP-27: shell logout posts classic endpoint and returns to the wall', () => {
    const u = S('uplift.js');
    assert.match(u, /#nav-logout/);
    assert.match(u, /fetchJson\(`\$\{API\}\/admin\/api\/logout`, \{ method: 'POST' \}\)/);
    assert.match(u, /location\.href = '\/uplift\/'/);
    const h = S('index.html');
    assert.match(h, /<a href="#" id="nav-logout" data-i18n="navbar\.logout">Logout<\/a>/);
});
