/* HDR-TGS (user 2026-11-02): the live token-rate chip in the dashboard
   header (input = prefill.tokens_s, output = generation.tokens_s).
   tgsLiveMean / tgsChipText are sliced out of uplift_charts.js and executed
   (the statics are browser IIFEs; same pattern as chip-card-parity.test.cjs).
   The body concatenates ONLY the repository's own checked-in source, no
   external input. Everything the slice cannot reach (DOM order in the
   header, the boot timer, the idle CSS state, the export) is a shape pin. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_DIR } = require('./static-src.cjs');

const read = f => fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
const charts = read('uplift_charts.js');
const html = read('index.html');
const css = read('uplift.css');
const boot = read('uplift_boot.js');
const C = require(path.join(STATIC_DIR, 'core.js'));

// Braced markers: comments elsewhere in the file echo the un-braced form.
const PURE_START = charts.indexOf('function tgsLiveMean(col, k) {');
const PURE_END = charts.indexOf('async function tgsStoredFetch() {');
assert.ok(PURE_START > 0 && PURE_END > PURE_START, 'pure chip helpers slice found');
const body = charts.slice(PURE_START, PURE_END);
const { tgsLiveMean, tgsChipText } =
    new Function('C', body + '\nreturn { tgsLiveMean, tgsChipText };')(C);

const colOf = (...vs) => ({ ts: vs.map((_, i) => 1000 + i * 500), v: vs });

/* ---------- live smoothing: the last k samples, newest-LAST ---------- */

test('live readout = mean of the last k samples (1.5 s at k=3, 2 Hz)', () => {
    assert.equal(tgsLiveMean(colOf(10, 20, 30, 40, 60), 3), 43.333333333333336);
    assert.equal(tgsLiveMean(colOf(10, 20, 30, 40, 60), 1), 60, 'k=1 is raw');
});

test('k larger than the column averages what exists; junk is skipped', () => {
    assert.equal(tgsLiveMean(colOf(10, 20), 9), 15);
    // tail of 3 is [NaN, 20, 30]: the NaN leaves the mean, it does not pad it
    assert.equal(tgsLiveMean(colOf(10, null, NaN, 20, 30), 3), 25, 'non-finite never dilutes');
});

test('no usable column -> null (the caller falls back, never paints a stale number)', () => {
    assert.equal(tgsLiveMean(null, 3), null);
    assert.equal(tgsLiveMean({ ts: [], v: [] }, 3), null);
    assert.equal(tgsLiveMean(colOf(null, undefined), 3), null);
});

/* ---------- chip text ---------- */

test('both halves render with the compact formatter and the catalog unit', () => {
    const t = tgsChipText(12345, 42.17, 'in', 'out', 'tok/s', C.fmtCompact);
    assert.equal(t, 'in 12.3k · out 42.2 tok/s');
});

test('an idle engine still reads: 0 is a value, not an absence', () => {
    assert.equal(tgsChipText(0, 0, 'in', 'out', 'tok/s', C.fmtCompact), 'in 0 · out 0 tok/s');
});

test('neither half has a value -> empty string = no chip at all', () => {
    assert.equal(tgsChipText(null, null, 'in', 'out', 'tok/s', C.fmtCompact), '');
});

test('one half missing paints an em-dash so the other half still reads', () => {
    assert.equal(tgsChipText(null, 38, 'in', 'out', 'tok/s', C.fmtCompact), 'in — · out 38 tok/s');
    assert.equal(tgsChipText(9000, null, 'vstup', 'výstup', 'tok/s', C.fmtCompact),
        'vstup 9.0k · výstup — tok/s');
});

test('labels come from the catalog, so a translated board is not English-only', () => {
    const t = tgsChipText(100, 20, '入力', '出力', 'トークン/秒', C.fmtCompact);
    assert.equal(t, '入力 100 · 出力 20 トークン/秒');
});

/* ---------- the shipped wiring (shape pins) ---------- */

test('header carries the chip between temperature and uptime, hidden until data', () => {
    const temp = html.indexOf('id="chip-temp"');
    const tgs = html.indexOf('id="chip-tgs"');
    const up = html.indexOf('id="chip-uptime"');
    assert.ok(temp > 0 && tgs > temp && up > tgs, 'chip sits next to temp and uptime');
    const line = html.split('\n').find(l => l.includes('id="chip-tgs"'));
    assert.match(line, /class="chip" id="chip-tgs"/, 'a plain header chip, same chrome as its siblings');
    assert.match(line, /\shidden\s/, 'born hidden: silent absence until a rate lands');
    assert.match(line, /data-i18n-title="uplift\.chip\.tgs"/, 'tooltip is localized');
});

test('paint drivers: one immediate call plus a 1 s interval, hidden-tab gated', () => {
    assert.match(boot, /^CH\.refreshTgsChips\(\);$/m, 'painted at boot, not only on a tick');
    assert.match(boot, /setInterval\(\(\) => \{ if \(!document\.hidden\) CH\.refreshTgsChips\(\); \}, 1000\);/);
});

test('live lane is gated on liveUsable; the stored lane only fills a gap', () => {
    const fn = charts.slice(charts.indexOf('function refreshTgsChips() {'),
                            charts.indexOf('\nfunction pushStatusSample('));
    assert.ok(fn.length > 200, 'refreshTgsChips slice terminated at pushStatusSample');
    assert.match(fn, /LF\.liveUsable\(TGS_IN_KEY\) \? tgsLiveMean\(LF\.liveCol\(TGS_IN_KEY\), kS\) : null/);
    assert.match(fn, /LF\.liveUsable\(TGS_OUT_KEY\) \? tgsLiveMean\(LF\.liveCol\(TGS_OUT_KEY\), kS\) : null/);
    assert.match(fn, /if \(inp === null \|\| outp === null\) tgsStoredFetch\(\);/,
        'the fallback HTTP runs ONLY while a live value is missing');
    assert.match(fn, /if \(now - tgsPaintAt < TGS_PAINT_MS\) return;/,
        'throttled painter: the 2 Hz stream cannot jitter the header');
    assert.match(fn, /chip\.hidden = txt === '';/, 'absence is silent, never a dash-chip');
    assert.match(fn, /chip\.classList\.toggle\('chip-idle',\s*inp !== null && outp !== null && inp <= 0 && outp <= 0\);/,
        'quiet grey only when BOTH rates are zero');
});

test('fallback lane reads the stored 5 s tick and ages its own samples out', () => {
    const fn = charts.slice(charts.indexOf('async function tgsStoredFetch() {'),
                            charts.indexOf('\nfunction refreshTgsChips()'));
    assert.match(fn, /\/uplift\/api\/metrics\/latest\?keys=*/, 'same seam the Status charts use');
    assert.match(fn, /encodeURIComponent\(`\$\{TGS_IN_KEY\},\$\{TGS_OUT_KEY\}`\)/);
    assert.match(fn, /const next = \{\};[\s\S]*?tgsStored = next;/,
        'wholesale rebuild: a key that stopped ticking drops out');
    assert.match(fn, /TGS_STORED_MAX_AGE_S \* 1000\) next\[key\] = p\.v;/);
    assert.match(fn, /if \(tgsStoredFetching \|\| now - tgsStoredAt < TGS_STORED_MIN_MS\) return;/);
});

test('series keys match what the collector and the Throughput chart plot', () => {
    assert.match(charts, /const TGS_IN_KEY = 'prefill\.tokens_s';/);
    assert.match(charts, /const TGS_OUT_KEY = 'generation\.tokens_s';/);
    // the same keys the live feed owns and the throughput chart draws
    assert.match(charts, /const preL = liveOn && LF\.liveUsable\('prefill\.tokens_s'\)/);
    assert.match(charts, /const genL = liveOn && LF\.liveUsable\('generation\.tokens_s'\)/);
});

test('exported on window.Uplift.charts (the only door uplift_boot has)', () => {
    assert.match(charts, /^\s*refreshTgsChips: refreshTgsChips,/m);
});

test('idle state has its own CSS rule and derives from theme tokens', () => {
    assert.match(css, /^header\.top \.chip\.chip-idle \{ color: var\(--dim\); border-color: var\(--edge\); \}$/m,
        'new selector (css2-no-dup-selectors) and no literal colour');
});
