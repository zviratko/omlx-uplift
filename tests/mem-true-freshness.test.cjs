/* MEM-TRUE / MEM-TRUE-2 (user 2026-10-19: "memory & cache doesn't show
   actual memory usage, I can see sane (real) numbers in the smaller memory
   graph as memory in use").

   Two separate lies on one card:
   1. The collector's mem.used_bytes rode pool.current_model_memory — the sum
      of model FILE estimates — because the guard gate probed
      `enf.enabled()`, an attribute upstream never had (the real shapes are
      the `is_running` property and the `enabled` key of get_status()).
      Server side, pinned in tests/test_collector_sources.py.
   2. The card header (#mem-label) and the chart's live columns stamped all
      THREE figures with the footprint's timestamp, so a ceiling the
      collector stopped writing stayed "fresh" forever. Measured on kocour:
      "iogpu wired limit 28" rendered off a row from 6 days earlier
      (/metrics/latest answers the newest row per key regardless of age).

   Contracts (text-level; the module is a browser IIFE):
   - every live memory figure is read through sysGiB(key), which ages on
     that key's OWN sample stamp — one shared ts is the bug;
   - the poll rebuilds the map per key so a vanished key drops out;
   - no code path may read the old single-timestamp sysLive fields. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const charts = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');

test('MEM-TRUE-2: sysGiB ages each key on its own sample time', () => {
    const m = charts.match(/function sysGiB\(key\) \{([\s\S]*?)\n\}/);
    assert.ok(m, 'sysGiB(key) must exist — it is the only live memory reader');
    const body = m[1];
    assert.match(body, /sysLive\[key\]/, 'must look the value up per key');
    assert.match(body, /Date\.now\(\) - p\.ts < SYS_STALE_MS/,
        'freshness must be judged against the row ts of THIS key');
});

test('MEM-TRUE-2: the poll stamps each key with its own row time', () => {
    const fn = charts.slice(charts.indexOf('async function refreshSysPct'),
                            charts.indexOf('function renderMemLabel'));
    assert.match(fn, /for \(const k of SYS_LIVE_KEYS\)/,
        'all three memory keys must be read, not just the footprint');
    assert.match(fn, /ts: \(p\.ts \|\| 0\) \* 1000/,
        'the GiB value must carry the stored sample timestamp');
    assert.match(fn, /sysLive = next;/,
        'the map must be rebuilt so a key that stopped being collected clears');
});

test('MEM-TRUE-2: header and live columns read through sysGiB only', () => {
    const header = charts.slice(charts.indexOf('function renderMemLabel'),
                                charts.indexOf('/* U20 header chips'));
    for (const key of ['mem.used_bytes', 'mem.custom_ceiling_bytes',
                       'mem.iogpu_limit_bytes'])
        assert.ok(header.includes(`sysGiB('${key}')`),
            `header must show ${key} through its own freshness gate`);
    const push = charts.slice(charts.indexOf('function pushStatusSample'),
                              charts.indexOf('window.Uplift.charts ='));
    for (const i of [1, 2, 3])
        assert.ok(push.includes(`memData[${i}].push(sysGiB(`),
            `memData[${i}] must be gated per key, not by a shared stamp`);
});

test('MEM-TRUE-2: the single-timestamp shape cannot come back', () => {
    // The old bug was one ts for three values; a reintroduction would read
    // sysLive.usedGB / ceilGB / iogpuGB or compare sysLive.ts.
    for (const dead of ['usedGB', 'ceilGB', 'iogpuGB', 'sysLive.ts'])
        assert.ok(!charts.includes(dead),
            `${dead} is the retired single-timestamp shape — it stamped a ` +
            `dead ceiling with the footprint's fresh time`);
});
