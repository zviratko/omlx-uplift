/* CARD-IDLE (user 2026-11-02: browser energy). The live frame path asked
 * every placed metric card to redraw about once a second, including cards
 * scrolled out of view and cards whose data could not have changed (no
 * live column, same window cache). The idle path now skips both; every
 * other caller keeps the full redraw.
 *
 * Behavioural, not a text grep: the four functions that own the decision
 * (drawMetricChart, drawAllMetricCharts, drawWindow, _popOpen) are sliced
 * VERBATIM out of uplift_charts.js and run against stubs for everything
 * they call. The body concatenates only this repository's own checked-in
 * source, no external input.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STATIC_DIR } = require('./static-src.cjs');

const SRC = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');

function slice(name) {
    const at = SRC.indexOf('function ' + name + '(');
    assert.ok(at >= 0, 'function not found: ' + name);
    let depth = 0;
    for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
    }
    throw new Error('unterminated function ' + name);
}

function harness() {
    const body = `
        let _idleDraw = false, _drewSync = false;
        const metricCharts = new Map(), metricCache = {}, cardZoom = {};
        const popHooks = { ref: null };
        const WIN = {}, LIVE = new Set(), draws = [], fetches = [];
        const _gateHidden = () => false, _cardParked = () => false;
        const ensureMetricPlot = () => {};
        const windowParam = (s) => s + 's';
        const cardWindow = (id) => WIN[id];
        const LF = { liveForWindow: (w) => w <= 300,
                     liveUsable: (k) => LIVE.has(k),
                     liveCol: () => ({ ts: [Date.now()], v: [1] }) };
        const metricServes = (def) => def.series;
        const metricUnionCols = () => [[1], [2]];
        const C = { smoothKey: () => false, movingAverage: (c) => c, tf: (k, fb) => fb };
        const metricStackCount = () => 0;
        const KIT = {};
        const legendUpdater = () => () => {};
        const metricXAxis = () => ({});
        const chartColors = () => ({});
        const fmtLast = () => '1', fmtSpan = () => '1m';
        function metricFetch(id) { fetches.push(id); drawMetricChart(id); }
        ${slice('_popOpen')}
        ${slice('drawMetricChart')}
        ${slice('drawAllMetricCharts')}
        ${slice('drawWindow')}
        function card(id, win, opts) {
            WIN[id] = win;
            metricCharts.set(id, Object.assign({
                def: { key: 'k.' + id, series: [{ key: 'k.' + id }] },
                nowEl: {}, noteEl: {},
                chart: { axes: [], setData() { draws.push(id); } },
            }, opts || {}));
        }
        return { metricCharts, metricCache, popHooks, LIVE, draws, fetches, card,
                 drawAllMetricCharts, drawWindow,
                 idle: () => _idleDraw };
    `;
    return vm.runInNewContext('(() => {' + body + '})()', { Date, Object, Map, Set });
}

test('a card with no live column redraws on the idle path only when its data changed', () => {
    const h = harness();
    h.card('slow', 3600);
    h.drawAllMetricCharts(true);
    assert.deepEqual([...h.draws], ['slow'], 'the first idle pass must draw');
    h.drawAllMetricCharts(true);
    h.drawAllMetricCharts(true);
    assert.equal(h.draws.length, 1, 'unchanged data redrawn on the idle path');
    h.metricCache['3600s'] = { ver: 99, data: {}, bucket_s: 0 };   // a fetch landed
    h.drawAllMetricCharts(true);
    assert.equal(h.draws.length, 2, 'new data must redraw');
    h.drawAllMetricCharts();                                         // full path
    assert.equal(h.draws.length, 3, 'callers without the idle flag always redraw');
    assert.equal(h.idle(), false, 'the idle flag must not leak past the pass');
});

test('a card with a live column keeps drawing at the live cadence', () => {
    const h = harness();
    h.card('live', 300);
    h.LIVE.add('k.live');
    h.drawAllMetricCharts(true);
    h.drawAllMetricCharts(true);
    h.drawAllMetricCharts(true);
    assert.equal(h.draws.length, 3, 'live cards must draw every idle pass');
    h.LIVE.clear();                       // stream went stale: stored data only
    h.drawAllMetricCharts(true);
    h.drawAllMetricCharts(true);
    assert.equal(h.draws.length, 4, 'once the live column is gone, unchanged data stops redrawing');
});

test('off-screen cards are skipped on the idle path, drawn on the full path', () => {
    const h = harness();
    h.card('off', 300, { onScreen: false });
    h.LIVE.add('k.off');
    h.drawAllMetricCharts(true);
    assert.equal(h.draws.length, 0, 'off-screen card drawn on the idle path');
    assert.equal(h.fetches.length, 0, 'off-screen card must not even drive a fetch');
    h.drawWindow('300s');
    assert.equal(h.draws.length, 0, 'a landed fetch must not redraw an off-screen card');
    h.drawAllMetricCharts();
    assert.equal(h.draws.length, 1, 'the full path still draws it');
});

test('an open pop-out keeps its card drawing even off screen', () => {
    const h = harness();
    h.card('pop', 300, { onScreen: false });
    h.LIVE.add('k.pop');
    h.popHooks.ref = { isOpen: (id) => id === 'pop', onMetricDraw() {} };
    h.drawAllMetricCharts(true);
    h.drawWindow('300s');
    assert.equal(h.draws.length, 2, 'pop-out source card must keep feeding its pop-out');
});

test('the idle flag resets even when a draw throws', () => {
    const h = harness();
    h.card('bad', 3600);
    h.metricCharts.get('bad').chart.setData = () => { throw new Error('boom'); };
    assert.throws(() => h.drawAllMetricCharts(true));
    assert.equal(h.idle(), false);
});

test('wiring: the live frame path and the 60 s loop use the idle path', () => {
    const boot = fs.readFileSync(path.join(STATIC_DIR, 'uplift_boot.js'), 'utf8');
    assert.match(boot, /_lfCardsAt = now; CH\.drawAllMetricCharts\(true\);/);
    assert.match(boot, /currentTab\(\) === 'status'\) CH\.drawAllMetricCharts\(true\); \}, 60_000\);/);
    assert.match(SRC, /_observeCard\(sec\);/, 'cards must be registered with the viewport observer');
    const pop = fs.readFileSync(path.join(STATIC_DIR, 'uplift_popout.js'), 'utf8');
    assert.match(pop, /isOpen\(id\) \{ return !!\(popout && popout\.id === id\); \}/);
});
