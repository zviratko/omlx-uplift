# Server-browser path perf fix (2026-10-21)

Symptoms (user): timeframe switches slow; Activity feed sometimes not
refreshing; i18n labels slow to resolve under load. Board: mruu browser
-> kocour:8001 (uvicorn h11, 6-conn budget per origin).

Measured (browser, authenticated, cache:no-store):
- series 24h (6 keys): 4.71 MB, 860 ms — raw, NO compression
- series 7d: 1.45 MB, 1846 ms (python re-aggregates 120k rows/key)
- hot 1h/24h: ~1.1 s each — `key LIKE 'hot.%'` full-index walk; 70 bytes
- locale: 251 KB uncompressed; statics uncompressed
- steady-state per tab: 2 SSE streams + full window re-fetch every 4.5-60 s

Root causes
1. No gzip anywhere on the uplift surface -> multi-MB JSON + 100-500 KB
   assets saturate the link and the 6-connection pool; every other request
   (SSE frames included) queues behind them.
2. Long windows pay the full row count twice: SQLite -> python dict list
   -> JSON (then uPlot draws 17k points/card).
3. Discovery (`keys_with_prefix`) walks the whole index on every call —
   a millisecond question asked as a minute-long one.

Fix (all inside omlx_uplift; no vanilla omlx touch, no new ports)
1. base.py: `gzip_or_json(payload, request)` — gzip when accepted and body
   >= 1 KiB; Cache-Control no-store + Vary kept; runs in to_thread.
   Applied to: /metrics/series, /metrics/hot, /locale.
2. store.py:
   - new `series_binned(key, window_s, bucket_s, instance)`: epoch-aligned
     AVG buckets computed IN SQL (returns <= window/bucket points).
   - `keys_with_prefix`: window-first scan on new covering index
     `ix_samples_ts_key (ts, key, instance)` + prefix range predicate
     (`key >= p AND key < p_upper`) instead of LIKE walk.
   - bucket ladder (derive.bucket_for): <=6h raw (ISSUE-7 fidelity kept),
     24h -> 60 s, 7d -> 600 s, 30d -> 1800 s. Max ~1440 pts/key.
3. pages.py: gzip compressible statics (html/css/js/json/svg, >= 1 KiB)
   through the same helper path; 304 handling unchanged.

Expected: 4.7 MB -> ~400-600 KB (gzip); 7d fetch 1.85 s -> <0.2 s;
hot ~1.1 s -> <0.05 s; label/locale loads ~5x faster; SSE no longer
queued behind megabyte transfers.

Tests: update tests/test_metrics_series.py (Response-returning routes,
binned shape, discovery index); add store unit for series_binned;
keep POP-PIN/HANG-1 contracts (client cadence unchanged; fetchJson
handles content-encoding transparently).

Deploy: push main -> brew HEAD install on kocour -> kickstart ->
verify gzip + latency via browser probes.
