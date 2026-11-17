/* SYNC-1 run 26 mirror (upstream 9304457 #5338 + ed045bb): the server now
   skips the community leaderboard upload for a non-default generation
   length, and the upload_skipped event carries {reason, features}. The
   uplift Throughput lane offers generation lengths and its own upload
   opt-out, so a checked Upload box plus a silent finish reads as a lost
   upload — the panel must name the reason like classic's amber banner.
   Labels are classic's own catalog keys (bench.upload_skipped.*), resolved
   through the merged locale; uplift keeps no copies to maintain.
   TP.onEvent is driven with a fake `this` — the upload_skipped branch only
   touches state/renderStatus/finish/uploadSkippedLabel, so no DOM is needed. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tpFactory = require(path.join(__dirname, '..', 'omlx_uplift', 'static', 'uplift_bench_tp.js'));

function makeCore(t) {
    const noop = () => {};
    return {
        W: () => ({}), dom: {}, errText: String, api: () => '',
        t: t, ta: (k, en) => ({ k: k, en: en, s: t(k, en) }),
        benchGpuWatts: noop, gpuNoteText: () => '', el: noop, busyLabel: () => '',
        labeled: noop, check: noop, checkI18n: noop, gid: () => null,
        streamInterrupted: noop, statusLine: noop, setBar: noop,
        advancedSection: noop, checkedVals: () => [], fmtNum: String,
        fmtMemory: String, buildThroughputText: () => '', simpleTable: noop,
        loadHistory: async () => {}, resultsHead: () => [], tpTip: () => '',
        tpDlCols: () => [], buildTpTables: () => ({}), tpHistoryBody: () => [],
        tpHistoryDl: () => {}, stopStream: noop,
    };
}

function drive(ev, t) {
    const TP = tpFactory(makeCore(t)).TP;
    const calls = [];
    const self = {
        state: {},
        renderStatus: (msg, isErr) => calls.push(['status', msg, !!isErr]),
        finish: (err) => calls.push(['finish', err]),
        uploadSkippedLabel: TP.uploadSkippedLabel,
    };
    TP.onEvent.call(self, ev);
    return calls;
}

/* catalog-miss stub: t() returns the EN fallback, so assertions read the
   fallback texts and a catalog-hit stub returns the key, so assertions
   prove WHICH classic key each reason resolves through. */
const asKey = (k, fb) => k;
const asFb = (k, fb) => fb;

test('s26: a server skip reason renders classic\'s banner title plus the reason label', () => {
    const calls = drive({ type: 'upload_skipped', reason: 'custom_generation_length' }, asKey);
    assert.deepStrictEqual(calls[0], ['status',
        'bench.upload_skipped.title: bench.upload_skipped.reason_custom_generation_length', false]);
    assert.deepStrictEqual(calls[1], ['finish', undefined]);
});

test('s26: every classic reason maps to its catalog key, unknown falls back to default', () => {
    const TP = tpFactory(makeCore(asKey)).TP;
    assert.strictEqual(TP.uploadSkippedLabel('external_endpoint'),
        'bench.upload_skipped.reason_external');
    assert.strictEqual(TP.uploadSkippedLabel('splash'),
        'bench.upload_skipped.reason_splash');
    assert.strictEqual(TP.uploadSkippedLabel('ane_aligned_prompt'),
        'bench.upload_skipped.reason_ane_aligned_prompt');
    assert.strictEqual(TP.uploadSkippedLabel('custom_generation_length'),
        'bench.upload_skipped.reason_custom_generation_length');
    assert.strictEqual(TP.uploadSkippedLabel('anything-else'),
        'bench.upload_skipped.reason_default');
    // catalog miss: EN fallbacks keep the shell honest
    const TP2 = tpFactory(makeCore(asFb)).TP;
    assert.match(TP2.uploadSkippedLabel('custom_generation_length'),
        /generation length other than 128 tokens/);
});

test('s26: the operator\'s own opt-out (Upload box unchecked) stays silent', () => {
    // bench_engine emits reason=uplift_opt_out for EVERY default run —
    // banner-ing it would train the user to ignore the real skips.
    const calls = drive({ type: 'upload_skipped', reason: 'uplift_opt_out' }, asKey);
    assert.deepStrictEqual(calls, [['finish', undefined]]);
});

test('s26: a skip event without a reason field still finishes (old keg stream)', () => {
    const calls = drive({ type: 'upload_skipped' }, asKey);
    assert.deepStrictEqual(calls, [['finish', undefined]]);
});

test('s26: the classic catalog at the mirror tip carries every key used', () => {
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const mirror = process.env.OMLX_SRC || path.join(os.homedir(), 'git', 'omlx-upstream');
    if (!fs.existsSync(path.join(mirror, 'omlx', 'admin', 'routes.py'))) return; // no checkout
    // execFileSync with an arg array: no shell, no interpolation risk.
    const en = JSON.parse(execFileSync('git',
        ['-C', mirror, 'show', 'HEAD:apps/omlx-web/omlx_web/i18n/en.json']).toString());
    for (const k of ['bench.upload_skipped.title',
        'bench.upload_skipped.reason_external', 'bench.upload_skipped.reason_splash',
        'bench.upload_skipped.reason_ane_aligned_prompt',
        'bench.upload_skipped.reason_custom_generation_length',
        'bench.upload_skipped.reason_default']) {
        assert.ok(typeof en[k] === 'string' && en[k].length > 0, k + ' present in classic en.json');
    }
});
