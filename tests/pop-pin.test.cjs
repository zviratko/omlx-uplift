/* POP-PIN (user 2026-10-10: "values in some graphs do not draw current
   value for a while, then it pops into place - probably those that don't
   have a 2hz refresh?"). Correct diagnosis: cards OUTSIDE the 2 Hz live
   ring (rate.*, and everything on >5m windows) draw from the stored
   series fetch, and two cache bugs made that path batch:

   1. TTL 10 s > the 5 s collector tick -> every refetch landed TWO new
      samples at once: the drawn tail sat up to 10 s in the past under a
      pinned [now-window, now] x-range, drifted, then JUMPED.
   2. freshness stamped at RESPONSE time -> a slow query re-added its RTT
      to every cycle (measured 6.9 s fetch gaps even at TTL 4.5 s).

   Contracts (text-level, the module is a browser IIFE):
   - short-window TTL stays STRICTLY BELOW the 5 s collector tick;
   - cache.at is stamped before fetchJson fires, and the success handler
     no longer re-stamps it;
   - the failure handler keeps its backoff stamp (fails>2 -> 30 s). */
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
    const fetchSite = src.slice(src.indexOf('_fetching.add(sk);'),
                                src.indexOf('_fetching.add(sk);') + 1500);
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
