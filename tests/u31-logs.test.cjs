// UP-31 gate: classic logs.js parser core ported into uplift_usage.js.
// Pure functions extracted from the shipped source by brace-walk — the
// same doctrine as tests/dl1-fileselect.test.cjs (first-party repo code).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_usage.js'), 'utf8');

function grab(name) {
    const i = SRC.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' shipped in uplift_usage.js');
    let depth = 0, j = SRC.indexOf('{', i);
    for (let k = j; k < SRC.length; k++) {
        if (SRC[k] === '{') depth++;
        else if (SRC[k] === '}') { depth--; if (!depth) return SRC.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
}
const constNames = ['LOG_LEVELS', 'LOG_AGG_FROM', 'LOG_HEADER', 'LOG_MEMORY_GUARD'];
let prelude = '';
for (const cn of constNames) {
    const m = new RegExp('const ' + cn + ' = [^;]+;').exec(SRC);
    assert.ok(m, cn + ' shipped');
    prelude += m[0] + '\n';
}
const ctx = {};
// Safety: every body below is first-party repo source read from this
// project's own tree (same extraction the u32/u33 gates use), never
// external data.
new Function('exports', prelude + '\n' +
    ['logLevelRank', 'parseLogText', 'logNumberField', 'memoryGuardFor']
        .map(grab).join('\n') + '\n' +
    'exports.logLevelRank=logLevelRank;exports.parseLogText=parseLogText;' +
    'exports.memoryGuardFor=memoryGuardFor;'
)(ctx);
const aggSrc = grab('aggregateLogRows');
const agg = new Function('logLevelRank', 'LOG_LEVELS', 'LOG_AGG_FROM', 'memoryGuardFor',
    aggSrc + '\nreturn aggregateLogRows;')(ctx.logLevelRank,
    ['TRACE', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], 3, ctx.memoryGuardFor);

const H = (ts, mod, lvl, msg, rid) =>
    `${ts} - ${mod} - ${lvl} - ${rid ? `[${rid}] - ` : ''}${msg}`;

test('header lines become records; tracebacks join the record above', () => {
    const text = [
        H('2026-10-24 10:00:00,100', 'omlx.server', 'INFO', 'boot ok'),
        H('2026-10-24 10:00:01,200', 'omlx.engine', 'ERROR', 'boom'),
        'Traceback (most recent call last):',
        '  File "x.py", line 1',
        H('2026-10-24 10:00:02,300', 'omlx.server', 'INFO', 'back'),
    ].join('\n') + '\n';
    const recs = ctx.parseLogText(text, 5);
    assert.equal(recs.length, 3);
    assert.equal(recs[1].message.split('\n').length, 3, 'continuation joined');
    assert.equal(recs[1].lines, 3);
    assert.equal(recs[2].message, 'back');
    assert.equal(recs[0].module, 'omlx.server');
});

test('request-id segment parses out (classic regex shape)', () => {
    const rec = ctx.parseLogText(H('2026-10-24 10:00:00,100', 'omlx.req', 'WARNING', 'slow', 'abc123'), 1);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].message, 'slow');
});

test('consecutive WARNING+ collapse with count; INFO never collapses', () => {
    const lines = [];
    for (let i = 0; i < 3; i++) lines.push(H('2026-10-24 10:00:0' + i + ',000', 'omlx.mem', 'WARNING', 'repeat me'));
    lines.push(H('2026-10-24 10:00:09,000', 'omlx.a', 'INFO', 'x'));
    lines.push(H('2026-10-24 10:00:09,100', 'omlx.b', 'INFO', 'x'));
    const rows = agg(ctx.parseLogText(lines.join('\n') + '\n', 5), '');
    assert.equal(rows.length, 3, 'one warning row + two info rows');
    assert.equal(rows[0].count, 3);
    assert.ok(rows[1].count <= 1, 'INFO never collapses');
});

test('min level filters by rank but keeps continuation under the row', () => {
    const text = [
        H('2026-10-24 10:00:00,000', 'm', 'DEBUG', 'noise'),
        'continued noise',
        H('2026-10-24 10:00:01,000', 'm', 'ERROR', 'real'),
    ].join('\n') + '\n';
    const rows = agg(ctx.parseLogText(text, 3), 'INFO');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, 'ERROR');
});

test('memory-guard advisories flag the row with the server\'s own numbers', () => {
    const g = ctx.memoryGuardFor('Prefill would require ~25.5 GB peak (usage 12.3 GB) vs attention ceiling 30.0 GB');
    assert.ok(g);
    assert.equal(g.usage.text, '12.3');
    assert.equal(g.ceiling.text, '30.0');
    assert.equal(g.peak.text, '25.5');
    assert.equal(ctx.memoryGuardFor('unrelated line'), null);
});

test('renderer wiring: rows are divs with lv class, click toggles open', () => {
    assert.match(SRC, /el\.className = 'logrow' \+ \(row\.level \? ` lv-\$\{row\.level\}` : ''\)/);
    assert.match(SRC, /el\.onclick = \(\) => el\.classList\.toggle\('open'\)/);
    assert.match(SRC, /records\$\{d\.log_file/);
});
