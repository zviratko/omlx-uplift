/* POP-PIN + STALL-FREEZE (user 2026-10-10).

   POP-PIN ("values in some graphs do not draw current value for a while,
   then it pops into place - probably those that don't have a 2hz refresh?").
   Correct diagnosis: cards OUTSIDE the 2 Hz live ring (rate.*, and
   everything on >5m windows) draw from the stored series fetch, and two
   cache bugs made that path batch:

   1. TTL 10 s > the 5 s collector tick -> every refetch landed TWO new
      samples at once: the drawn tail sat up to 10 s in the past under a
      pinned x-range, drifted, then JUMPED.
   2. freshness stamped at RESPONSE time -> a slow query re-added its RTT
      to every cycle (measured 6.9 s fetch gaps even at TTL 4.5 s).
   3. (found by the 21:05 live case) a fetch whose promise never settles
      held the _fetching dedupe slot forever: cards froze at one tail for
      12+ minutes in a VISIBLE tab. Lease now carries a timestamp + seq.

   STALL-FREEZE (user 2026-10-10: "it would be better for the graphs not
   to move if they don't have data"): the x-range right edge and the
   union cutoff anchor to the NEWEST DRAWN point, not to Date.now().
   Motion only ever means "new data arrived"; a stalled chart holds
   still instead of sliding left into emptiness.

   Contracts (text-level, the module is a browser IIFE):
   - short-window TTL stays STRICTLY BELOW the 5 s collector tick;
   - cache.at is stamped before fetchJson fires; the success handler does
     not re-stamp; the failure handler keeps its response-time backoff;
   - the in-flight lease is timestamped (retriable after 20 s) and the
     release is ownership-checked (l.seq === seq);
   - pinnedXRange reads u.data (the instance uPlot passes to range
     callbacks), falling back to Date.now() only with no columns;
   - metricUnionCols derives its cutoff from the newest sample (seconds
     -> ms conversion present) and filters NON-destructively. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static-src.cjs');

const src = fs.readFileSync(path.join(STATIC_DIR, 'uplift_charts.js'), 'utf8');
const TICK_MS = 5000;   // collector.py TICK_S

test('metric cache TTL stays below the collector tick (no 2-sample batches)', () => {
    const m = src.match(/const ttl = cardWindow\(id\) >= 604800 \? (\d+) : (\d+);/);
    assert.ok(m, 'ttl line present');
    assert.ok(Number(m[2]) < TICK_MS,
        `short-window TTL ${m[2]} must be < the ${TICK_MS}ms source period`);
    assert.ok(Number(m[1]) >= 60000, 'week/month windows keep the 60 s TTL (60 s buckets)');
});

test('freshness stamps at REQUEST issue, not at response', () => {
    const fetchSite = src.slice(src.indexOf('_fetching.set(sk, { t: Date.now(), seq });'),
                                src.indexOf('_fetching.set(sk, { t: Date.now(), seq });') + 1500);
    assert.ok(fetchSite.indexOf('cache.at = Date.now();')
              < fetchSite.indexOf('fetchJson('),
        'cache.at must be stamped BEFORE the request fires');
    const okHandler = fetchSite.slice(fetchSite.indexOf('.then('),
                                      fetchSite.indexOf('.catch('));
    assert.ok(!okHandler.includes('cache.at'),
        'the success handler must not re-stamp (that re-adds the RTT)');
    const catchHandler = fetchSite.slice(fetchSite.indexOf('.catch('));
    assert.match(catchHandler, /cache\.fails\+\+; cache\.at = Date\.now\(\);/,
        'failures still back off from the RESPONSE time (retry gap is real)');
});

test('in-flight lease is timestamped and ownership-released (STALE-LEASE)', () => {
    assert.match(src, /const _fetching = new Map\(\)/,
        '_fetching must be a Map (a bare Set cannot carry a lease time)');
    assert.match(src, /Date\.now\(\) - inflight\.t < \d+/,
        'an old lease must stop blocking retries');
    assert.match(src, /if \(l && l\.seq === seq\) _fetching\.delete\(sk\)/,
        'finally must release only its OWN lease');
});

test('pinnedXRange anchors on the newest DRAWN point, not the clock', () => {
    const m = src.match(/function pinnedXRange\(cardId\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'pinnedXRange present');
    const body = m[0];
    assert.ok(body.includes('(u)'), 'range callback must take the uPlot instance');
    assert.ok(/u\.data/.test(body), 'must read u.data for the edge');
    assert.ok(body.indexOf('Date.now()') < body.indexOf('edge = d[d.length - 1]'),
        'Date.now() is the fallback; the drawn tail is the anchor');
    assert.ok(/return \[edge - w, edge\]/.test(body),
        'window keeps its width; only the edge moves');
});

test('metricUnionCols cutoff anchors on data and filters non-destructively', () => {
    const m = src.match(/function metricUnionCols\(def, data, winMs\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'metricUnionCols present');
    const body = m[0];
    assert.match(body, /Math\.min\(newest \* 1000, Date\.now\(\)\)/,
        'edge = newest sample in MS (the s->ms conversion is the whole point)');
    assert.ok(!body.includes('.shift('),
        'cache arrays are SHARED across cards of one window group — no in-place trim');
    assert.match(body, /const cut = cols0\.map\(c => c\.filter/,
        'filter into a fresh array');
});
