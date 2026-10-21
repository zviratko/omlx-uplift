"""Uplift metrics store — SQLite in ~/.omlx/uplift/ (owned by Uplift).

Vanilla omlx writes its OWN ~/.omlx/usage.sqlite3 (hourly rollups, see
omlx/usage_history.py); we never write that file — the viewer opens it
READ-ONLY (mode=ro) and merges it as the coarse history layer.

Our file adds sub-hour samples and per-request rows:
  samples(ts, key, value, instance)   interval metrics (tokens/s, cache
                               hit %, loaded models, active requests,
                               totals) tagged with the server that wrote
                               them (see server_instance_id). Reads under
                               the HIST-1 policy hide only LIVE co-tenant
                               writers — history from dead PIDs and old
                               kegs stays visible (see _hidden_tags)
  requests(id PK, model, state, prompt_tokens, completion_tokens, tps,
           error, ts_start, ts_end)   per-request lifecycle rows
Retention (RL-0, split + configurable): metrics samples are purged after
RETENTION_METRICS_DAYS (default 30), finished request-log rows after
RETENTION_LOG_DAYS (default 2). Resolution per value: env override
(OMLX_UPLIFT_RETENTION_METRICS_DAYS / OMLX_UPLIFT_RETENTION_LOG_DAYS) >
meta-table keys (retention_metrics_days / retention_log_days, set via
GET/POST /uplift/api/retention) > defaults. Values clamp to 1..365; a
0/negative/invalid keeps the previous value. ACTIVE-state request rows
are never purged by age.

Write hygiene (NVMe wear): WAL + synchronous=NORMAL (fsync once per WAL
checkpoint, not per COMMIT; a power loss loses at most the last WAL ticks
of telemetry — acceptable for dashboard metrics), journal_size_limit caps
the WAL between checkpoints, one COMMIT per collector tick via
write_tick(), and a wal_checkpoint(TRUNCATE) inside the daily purge pass.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from . import paths as _paths

RETENTION_METRICS_DAYS = 30
RETENTION_LOG_DAYS = 2
_RET_CLAMP = (1, 365)
_SCHEMA_VERSION = 3
# v1 -> v2 (RL-1): payload columns on `requests`. Migration is idempotent:
# ALTER TABLE ADD COLUMN runs once per column, guarded by PRAGMA table_info.
# v2 -> v3: samples.instance (co-tenant collector tagging, see
# server_instance_id) — migrated in _init_schema next to this block.
_NEW_COLUMNS = {
    "prompt": "TEXT", "prompt_trunc": "INTEGER",
    "output": "TEXT", "output_trunc": "INTEGER",
    "params": "TEXT", "finish": "TEXT",
    # ISSUE-3: token-id prompt sample (JSON array of ids, head+tail) so the
    # inspector can decode what was actually sent for tokenized prompts.
    "prompt_ids": "TEXT", "prompt_ids_trunc": "INTEGER",
    # U17: queue->first-token latency (ms), derived once per request from
    # the scheduler's monotonic arrival_time / generation_started_at.
    "first_token_ms": "REAL",
}


def _clamp_days(raw, default: int) -> int:
    """Clamp a retention value to _RET_CLAMP; invalid/0/negative keeps default."""
    try:
        v = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return default
    if v < _RET_CLAMP[0]:
        return default if v <= 0 else _RET_CLAMP[0]
    return min(v, _RET_CLAMP[1])


def _excerpt(prompt, output, q, width=200):
    """Manual window around the first case-insensitive hit in either text
    (LIKE path and scan path). Falls back to the head of the prompt."""
    texts = [t for t in (prompt, output) if t]
    if not texts:
        return ""
    if q:
        ql = q.lower()
        for t in texts:
            i = t.lower().find(ql)
            if i >= 0:
                start = max(0, i - width // 2)
                return ("…" if start else "") + t[start:start + width] + "…"
    head = texts[0][:width]
    return head + ("…" if len(texts[0]) > width else "")


_CJK_RE = re.compile(
    "[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]")


def fts_query(raw: str):
    """Make arbitrary user text safe for FTS5 MATCH: one quoted phrase per
    word-ish token, ANDed. Quotes inside tokens are doubled (FTS rule).

    PUNCT-1: tokens with no word character ('\\', '%', '---') index to zero
    FTS tokens, so a quoted phrase of them can never MATCH and would poison
    the whole AND chain. They are dropped; if NOTHING survives, returns
    None and the caller answers with the LIKE substring path instead."""
    toks = re.findall(r"[^\s]+", raw)
    out = []
    for t in toks:
        if not re.search(r"\w", t, re.UNICODE):
            continue        # punctuation-only: unmatchable, honest skip
        out.append('"' + t.replace('"', '""') + '"')
    return " AND ".join(out) or None


def _where_clause(parts):
    return ("WHERE " + " AND ".join(parts)) if parts else ""


def _and(parts):
    return ("AND " + " AND ".join(parts)) if parts else ""


def default_db_path() -> Path:
    # PATHS-1: ladder lives in paths.server_base_dir (family A:
    # server_state -> OMLX_BASE_PATH -> ~/.omlx). Wrapper kept: tests
    # and callers monkeypatch/import this name.
    return _paths.metrics_db_path()


_inst_cache: str | None = None


def server_instance_id() -> str:
    """Identity of the process writing/reading samples: its omlx package
    location (keg) + PID — unique per process, which is the one key that
    survives every co-tenant scenario (same keg, same port, one shared DB).

    WHY: every omlx instance shares ONE metrics DB, but ServerMetrics is
    per-process and resets at startup. Twice we caught two live servers
    (a service restart that left the old process lingering / a duplicate
    dev launch) interleaving samples into one series every tick: tok/s
    sawtoothed between real values and 0, rate.* pinned at 0 (each
    writer's delta lands on the other's totals). The collector and the
    API live in the SAME process, so writes are tagged with this id and
    reads keep only this process's rows plus untagged legacy rows — each
    dashboard shows exactly its own server's numbers. After a restart
    the fine layer starts fresh by design (session metrics reset on a
    restart anyway); long windows still backfill from the hourly layer.
    """
    global _inst_cache
    if _inst_cache is None:
        keg = ""
        try:
            import omlx

            keg = str(Path(omlx.__file__).resolve().parent)
        except Exception:
            keg = os.environ.get("OMLX_INSTANCE_ROOT", "") or "unknown"
        _inst_cache = f"{keg}\x1f{os.getpid()}"
    return _inst_cache


def _split_instance(tag: str) -> tuple[str, int | None]:
    """Split an instance tag into (keg, pid). Malformed/legacy tags degrade
    to (tag, None) — an unparseable tag can never be proven dead, so the
    visibility policy treats it like a live writer's row and keeps hiding
    it: exactly the pre-HIST-1 behavior for that row, and no crash path."""
    keg, _, pid_s = tag.rpartition("\x1f")
    if not keg:
        return tag, None
    try:
        return keg, int(pid_s)
    except ValueError:
        return keg, None


def _pid_alive(pid: int) -> bool:
    """True when PID exists. EPERM counts as alive (a foreign-uid process
    is real and its rows are still live data). PID-reuse collision (a dead
    session's PID reused by an unrelated process) misclassifies that old
    tag as live and keeps it hidden — conservative, bounded to one session,
    and still strictly better than the pre-HIST-1 exact-tag filter."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        # EINVAL: not a valid PID number on this system (e.g. beyond
        # kern.maxproc) — such a writer cannot exist. Any other errno is
        # conservative (treat as alive, keep the row hidden).
        import errno as _errno
        return exc.errno != _errno.EINVAL
    return True


# HIST-1 (user: "every time I upgrade uplift I lose all historical data").
# The v3 exact-instance read filter (89bd701) fixed real co-tenant graph
# corruption but threw the baby out with the bathwater: BOTH halves of the
# tag — keg path AND PID — change at every restart, and the keg half
# changes at every `brew reinstall`, so a fresh process matched ZERO old
# rows and the entire fine (5 s) layer vanished from the dashboard even
# though 10 M rows sat in the DB. The corruption case was never "old rows
# exist", it was "another LIVE server interleaves its deltas with ours".
# Correct policy, therefore: hide only foreign tags whose writer PID is
# ALIVE; own tag, untagged legacy rows and dead tags (previous sessions,
# previous kegs) are all visible history.
VISIBLE_INSTANCES = "visible"

# Freshness for the live-alien probe (per store, see _live_alien_tags): a
# recompute when the tag LIST changed would have to SCAN THE WHOLE INDEX to
# learn the list — on a 13.2 M-row samples table that costs 0.65 s per read
# (measured, 2026-10-14). The probe is therefore once per TTL, full stop;
# a just-started co-tenant hides within one tick+TTL at worst, which is the
# same bound a dead writer already had.
_VISIBLE_TTL_S = 30.0

# PERF-1 (user 2026-10-21): shared TTL for key discovery — see
# keys_with_prefix. The walk is window-scoped now (index-backed), the cache
# makes it once-per-TTL across all tabs instead of once-per-request.
_KEYS_TTL_S = 30.0


def _distinct_tags(conn) -> list[str]:
    """All distinct non-NULL sample instance tags (one index-backed scan)."""
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT instance FROM samples WHERE instance IS NOT NULL")]


def open_usage_ro(path: Path | None = None) -> sqlite3.Connection:
    """Open vanilla's usage.sqlite3 strictly READ-ONLY."""
    p = path or (default_db_path().parent.parent / "usage.sqlite3")
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


log = logging.getLogger("omlx_uplift.store")


class MetricsStore:
    def __init__(self, path: Path | None = None, read_only: bool = False):
        self.path = Path(path) if path else default_db_path()
        # RLock (not Lock): the read path holds _rlock while
        # _instance_sql may cold-start the tag probe re-entering it, and
        # write helpers occasionally re-enter through meta getters.
        self._lock = threading.RLock()
        self._has_fts = False   # _init_schema flips it when FTS5 is usable
        # HIST-1: cache this process's instance tag. server_instance_id()
        # itself is already memoised module-wide, but keeping the value on
        # the store means a test that patches it gets a stable identity for
        # the store's lifetime, and the read path does one attribute load
        # per query instead of a function call.
        self._own_instance = server_instance_id()
        # (tag_list_snapshot, monotonic_deadline, hidden_tags) for the
        # visible-instances policy — see _hidden_tags().
        self._alien_cache: tuple[frozenset[str], float, tuple[str, ...]] | None = None
        # PERF-1: shared TTL cache for key discovery (keys_with_prefix) —
        # (prefix, window) -> (monotonic_deadline, keys). One walk per TTL
        # serves every tab.
        self._keys_lock = threading.Lock()
        self._keys_cache: dict[tuple[str, int], tuple[float, list[str]]] = {}
        self._rlocal = threading.local()
        self._rconns_lock = threading.Lock()
        self._rconns: list[sqlite3.Connection] = []
        self._1m_ready = False
        if read_only:
            if not self.path.exists():
                raise FileNotFoundError(self.path)
            self._conn = sqlite3.connect(
                f"file:{self.path}?mode=ro", uri=True, check_same_thread=False
            )
            self._rlock = self._lock
            self._alien_refreshing = False
            # read-only viewer: FTS and 1m rollups are usable iff already built
            try:
                self._has_fts = bool(self._conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='request_fts'"
                ).fetchone())
                r1m = self._conn.execute(
                    "SELECT value FROM meta WHERE key='samples_1m_backfilled'"
                ).fetchone()
                self._1m_ready = bool(r1m and r1m[0] == "1")
            except sqlite3.Error:
                pass
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(
                str(self.path), check_same_thread=False
            )
            # Write hygiene (RL-0): WAL with synchronous=NORMAL fsyncs once
            # per WAL checkpoint instead of per COMMIT; worst case after a
            # power loss is losing the last few telemetry ticks. The WAL is
            # capped at 4 MB between checkpoints and truncated once per day
            # inside purge(). busy_timeout guards the rare writer clash
            # (viewer opens read-only; WAL readers never block).
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA journal_size_limit=4194304")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._init_schema()
            # SPLIT-READ + THREAD-LOCAL (user 2026-10-21): WAL gives each
            # read-only connection lock-free snapshot isolation (readers
            # never block the writer or each other, and never see an
            # uncommitted tick because write_tick commits atomically). The
            # old single _rconn + _rlock serialized parallel worker threads
            # one-by-one; _get_rconn() gives each thread its own ro handle
            # via threading.local(), so reads need no Python lock at all.
            self._rlock = threading.RLock()
            self._alien_refreshing = False

    def _get_rconn(self) -> sqlite3.Connection:
        if str(self.path) == ":memory:":
            return self._conn
        conn = getattr(self._rlocal, "conn", None)
        if conn is None:
            conn = sqlite3.connect(
                f"file:{self.path}?mode=ro", uri=True,
                check_same_thread=False, timeout=2.0,
            )
            self._rlocal.conn = conn
            with self._rconns_lock:
                self._rconns.append(conn)
        return conn

    @property
    def _rconn(self) -> sqlite3.Connection:
        return self._get_rconn()

    def _init_schema(self):
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS samples (
                    ts REAL NOT NULL, key TEXT NOT NULL, value REAL NOT NULL);
                -- SQUEEZE-LATEST-2: the samples index is built AFTER the
                -- instance ALTER below (fresh DBs start v1-shape!).
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, model TEXT, state TEXT,
                    prompt_tokens INTEGER, completion_tokens INTEGER,
                    tps REAL, error TEXT, ts_start REAL, ts_end REAL);
                CREATE INDEX IF NOT EXISTS ix_requests_ts_start
                    ON requests(ts_start);
                """
            )
            # Idempotent v1 -> v2 migration (RL-1 payload columns): ALTER
            # TABLE has no IF NOT EXISTS, so check table_info first. A fresh
            # DB already created the columns above? No — the CREATE above is
            # v1 shape for max compat; new columns always arrive here.
            have = {r[1] for r in self._conn.execute(
                "PRAGMA table_info(requests)")}
            for col, typ in _NEW_COLUMNS.items():
                if col not in have:
                    self._conn.execute(
                        f"ALTER TABLE requests ADD COLUMN {col} {typ}")
            # v2 -> v3 (co-tenant sample tagging): same idempotent ALTER
            # pattern as _NEW_COLUMNS. Legacy rows keep instance NULL and
            # stay readable by every server (see server_instance_id).
            if "instance" not in {r[1] for r in self._conn.execute(
                    "PRAGMA table_info(samples)")}:
                self._conn.execute(
                    "ALTER TABLE samples ADD COLUMN instance TEXT")
            # SQUEEZE-LATEST-2: /metrics/latest asks for the NEWEST visible
            # row per key. With only (key, ts), every instance filter is a
            # per-row table lookup, so a miss (own writer gone after a
            # restart — the normal state for non-hot keys) walks the whole
            # key range: measured 311 ms on a 326 K-row key, ~1.2 s per
            # 4-key request. A covering (key, instance, ts) index lets both
            # query shapes walk-and-stop. Migrate once: create the new
            # index, then DROP the old one (SQLite keeps preferring the old
            # index while it exists — verified on the live DB).
            # Column ORDER matters twice over: (key, ts) prefix drives the
            # window scans and ORDER BY ts of series(); a third `instance`
            # column lets latest()'s own/visible filters read from the
            # index instead of per-row table lookups. An intermediate
            # release built (key, instance, ts) — that cannot order by ts
            # and forced a temp B-tree over the whole key range (verified
            # via EXPLAIN QUERY PLAN); rebuilding here once fixes those DBs.
            order = [r[0] for r in self._conn.execute(
                "SELECT name FROM pragma_index_info('ix_samples_latest') "
                "ORDER BY seqno")]
            if order != ["key", "ts", "instance"]:
                self._conn.execute("DROP INDEX IF EXISTS ix_samples_latest")
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS ix_samples_latest "
                    "ON samples(key, ts, instance)")
            self._conn.execute("DROP INDEX IF EXISTS ix_samples_key_ts")
            self._conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(_SCHEMA_VERSION),),
            )
            # HIST-1: the visible-instances probe scans DISTINCT instance
            # tags per (cached) recompute; without an index that is a full
            # scan of a 10 M-row table holding _lock. Low-cardinality index
            # -> index-only scan in milliseconds. Idempotent CREATE.
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_samples_instance "
                "ON samples(instance)")
            # PERF-1 (user 2026-10-21): key discovery over a time window
            # (keys_with_prefix: 'hot.<model>' / 'uplift.*' names the client
            # cannot know) must never walk the whole table: covering index
            # (ts, key, instance) lets the window-scoped DISTINCT answer
            # from the index alone. Built AFTER the instance ALTER (a
            # fresh DB starts v1-shape, same rule as ix_samples_latest).
            # Creation on a live 15 M-row table is a one-time ~20-40 s
            # boot cost; every later open is IF-EXISTS instant.
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_samples_ts_key "
                "ON samples(ts, key, instance)")
            # ROLLUP-1 (user 2026-10-21): 1-minute rollup table so long
            # windows (24h, 7d, 30d) scan 12x fewer rows than raw 5 s
            # samples. Maintained in-transaction via an AFTER INSERT
            # trigger on `samples` (zero extra Python round-trips or
            # commits; raw INSERTs in tests stay in sync too). instance
            # stores '' for NULL so ON CONFLICT(key, ts, instance) always
            # matches (SQLite treats NULL != NULL in UNIQUE indexes).
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS samples_1m (
                    ts REAL NOT NULL,
                    key TEXT NOT NULL,
                    value REAL NOT NULL,
                    n INTEGER NOT NULL DEFAULT 1,
                    instance TEXT NOT NULL DEFAULT ''
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ix_samples_1m_pk
                    ON samples_1m(key, ts, instance);
                CREATE TRIGGER IF NOT EXISTS tr_samples_1m
                AFTER INSERT ON samples
                BEGIN
                    INSERT INTO samples_1m(ts, key, value, n, instance)
                    VALUES (CAST(NEW.ts / 60 AS INTEGER) * 60, NEW.key,
                            NEW.value, 1, COALESCE(NEW.instance, ''))
                    ON CONFLICT(key, ts, instance) DO UPDATE SET
                        value = (samples_1m.value * samples_1m.n + excluded.value)
                                / (samples_1m.n + 1),
                        n = samples_1m.n + 1;
                END;
                """
            )
            done_1m = self._conn.execute(
                "SELECT value FROM meta WHERE key='samples_1m_backfilled'"
            ).fetchone()
            if done_1m and done_1m[0] == "1":
                self._1m_ready = True
            else:
                bounds = self._conn.execute(
                    "SELECT MIN(ts), MAX(ts) FROM samples"
                ).fetchone()
                lo, hi = (bounds[0], bounds[1]) if bounds else (None, None)
                if lo is None or hi is None:
                    self._conn.execute(
                        "INSERT INTO meta(key, value) VALUES"
                        "('samples_1m_backfilled','1') "
                        "ON CONFLICT(key) DO UPDATE SET value='1'"
                    )
                    self._1m_ready = True
                elif hi - lo <= 7200:
                    self._backfill_1m_range(float(lo), float(hi) + 60.0)
                    self._conn.execute(
                        "INSERT INTO meta(key, value) VALUES"
                        "('samples_1m_backfilled','1') "
                        "ON CONFLICT(key) DO UPDATE SET value='1'"
                    )
                    self._1m_ready = True
                else:
                    self._1m_ready = False
                    threading.Thread(
                        target=self._backfill_1m_bg,
                        args=(float(lo), float(hi)),
                        daemon=True,
                        name="uplift-1m-backfill",
                    ).start()
            # ZOMBIE-1 boot repair (see request_log stale-drop): rows the
            # OLD tracker code abandoned mid-flight were persisted without
            # a terminal update — a 42-h 'queued' row survived in the live
            # store and the feed painted it as an active request after
            # every restart. One-time per boot, bounded and honest: no
            # process on this machine can have a request untouched in the
            # table for 15 minutes and still be alive (the collector
            # re-upserts every changed row each tick, and a live
            # never-progressing queued row was ALREADY age-exempt by
            # design — the live feed reads the tracker, not this table).
            # Terminal labels keep search/stats honest.
            try:
                self._conn.execute(
                    "UPDATE requests SET state='error', "
                    "error=COALESCE(error,'interrupted (engine gone)'), "
                    "ts_end=COALESCE(ts_end, ts_start) "
                    "WHERE state IN ('queued','prefilling','generating',"
                    "                'cancelling') "
                    "AND COALESCE(ts_end, ts_start) < ?",
                    (time.time() - 900,))
            except sqlite3.Error as exc:   # repair must never block boot
                log.warning("uplift store: zombie repair failed: %s", exc)
            # RL-3: FTS5 index over prompt+output, best-effort — Homebrew
            # python sqlite usually ships it, but on failure everything
            # falls back to LIKE (advertised per-response as mode).
            # Plain (non-external-content) table: upsert re-syncs by
            # id inside the same transaction; purge deletes both sides.
            self._has_fts = False
            try:
                self._conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS request_fts "
                    "USING fts5(id UNINDEXED, prompt, output)")
                self._has_fts = True
            except sqlite3.OperationalError:
                pass
            # SEARCH-1: rows written before this index existed are invisible
            # to MATCH (the search JOINs through request_fts). One-time
            # backfill (meta key keeps later restarts free of the full scan)
            # plus a cheap every-boot repair: any indexed pair whose stored
            # text is empty while the data row has text was written by an
            # early _fts_sync that trusted the sparse upsert params (the
            # data path COALESCEs, the index must mirror the MERGED row).
            if self._has_fts:
                try:
                    # raw SQL: _init_schema already holds self._lock and
                    # threading.Lock is not reentrant (get_meta would dead-
                    # lock the whole process at boot)
                    done = self._conn.execute(
                        "SELECT value FROM meta WHERE key='fts_backfilled'"
                    ).fetchone()
                    if not done or done[0] != "1":
                        self._conn.execute(
                            """INSERT INTO request_fts(id, prompt, output)
                               SELECT r.id, COALESCE(r.prompt,''),
                                      COALESCE(r.output,'')
                                 FROM requests r
                                WHERE (r.prompt IS NOT NULL
                                        OR r.output IS NOT NULL)
                                  AND NOT EXISTS
                                      (SELECT 1 FROM request_fts f
                                        WHERE f.id = r.id)""")
                        self._conn.execute(
                            "INSERT INTO meta(key, value) VALUES"
                            "('fts_backfilled','1') "
                            "ON CONFLICT(key) DO UPDATE SET value='1'")
                    # field-wise repair: an index column blanked by an
                    # early writer while the data row has text there
                    for col in ("prompt", "output"):
                        self._conn.execute(
                            f"""UPDATE request_fts SET {col} = (
                                    SELECT COALESCE(r.{col}, '')
                                      FROM requests r
                                     WHERE r.id = request_fts.id)
                                 WHERE {col} = ''
                                   AND EXISTS (
                                       SELECT 1 FROM requests r
                                        WHERE r.id = request_fts.id
                                          AND COALESCE(r.{col}, '') <> '')"""
                        )
                except sqlite3.Error:
                    self._has_fts = False

    # -- retention policy (RL-0) -------------------------------------------

    def get_meta(self, key: str) -> str | None:
        with self._lock:
            cur = self._conn.execute(
                "SELECT value FROM meta WHERE key=?", (key,))
            r = cur.fetchone()
            return r[0] if r else None

    def set_meta(self, key: str, value: str):
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO meta(key, value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )

    def retention(self) -> dict:
        """Resolve {metrics_days, log_days, source} per the RL-0 order:
        env > meta > default. 'source' reports which layer won for the
        metrics value (env|meta|default); each value resolves separately."""
        out = {}
        src = "default"
        for kind, env_key, meta_key, default in (
            ("metrics_days", "OMLX_UPLIFT_RETENTION_METRICS_DAYS",
             "retention_metrics_days", RETENTION_METRICS_DAYS),
            ("log_days", "OMLX_UPLIFT_RETENTION_LOG_DAYS",
             "retention_log_days", RETENTION_LOG_DAYS),
        ):
            env_raw = os.environ.get(env_key)
            if env_raw is not None and str(env_raw).strip():
                out[kind] = _clamp_days(env_raw, default)
                if kind == "metrics_days":
                    src = "env"
                continue
            meta_raw = self.get_meta(meta_key)
            if meta_raw is not None:
                out[kind] = _clamp_days(meta_raw, default)
                if kind == "metrics_days" and src == "default":
                    src = "meta"
                continue
            out[kind] = default
        out["source"] = src
        return out

    def set_retention(self, metrics_days=None, log_days=None) -> dict:
        """Persist into meta (takes effect next purge pass). Invalid or
        <=0 keeps the previous resolved value (documented clamping rule)."""
        cur = self.retention()
        if metrics_days is not None:
            prev = cur["metrics_days"]
            self.set_meta("retention_metrics_days",
                          str(_clamp_days(metrics_days, prev)))
        if log_days is not None:
            prev = cur["log_days"]
            self.set_meta("retention_log_days", str(_clamp_days(log_days, prev)))
        return self.retention()

    # -- deferred model settings (two-phase save) --------------------------
    # U41: phase 1 of the editor's honest save persists engine-rebuild
    # settings here (classic PUT auto-unloads a loaded engine when those
    # keys are present, so they cannot ride the live save). Phase 2 (the
    # editor's RESTART MODEL) pushes them through the classic PUT and
    # clears the record. Only accessed via get_*_deferred_settings below —
    # the whole-table VACUUM must not treat these as retention config.

    _DEFER_PREFIX = "deferred_settings:"

    def get_deferred_settings(self, model_id: str) -> dict:
        raw = self.get_meta(self._DEFER_PREFIX + model_id)
        if not raw:
            return {}
        try:
            d = json.loads(raw)
        except ValueError:
            return {}
        return d if isinstance(d, dict) else {}

    def set_deferred_settings(self, model_id: str, settings: dict):
        self.set_meta(self._DEFER_PREFIX + model_id,
                      json.dumps(settings if isinstance(settings, dict) else {}))

    def clear_deferred_settings(self, model_id: str):
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM meta WHERE key=?",
                               (self._DEFER_PREFIX + model_id,))

    # -- write side (collector) ------------------------------------------

    def write_sample(self, key: str, value: float, ts: float | None = None):
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO samples(ts, key, value, instance) VALUES(?,?,?,?)",
                (ts or time.time(), key, float(value), server_instance_id()),
            )

    def write_samples(self, pairs: dict[str, float], ts: float | None = None):
        t = ts or time.time()
        inst = server_instance_id()
        with self._lock, self._conn:
            self._conn.executemany(
                "INSERT INTO samples(ts, key, value, instance) VALUES(?,?,?,?)",
                [(t, k, float(v), inst) for k, v in pairs.items()],
            )

    def upsert_request(self, row: dict, in_tx: bool = False):
        """Insert-or-update one request row from tracker fields.

        in_tx=True runs the statement inside the caller's transaction
        (write_tick) — no COMMIT of its own."""
        params = {
            "id": row["id"],
            "model": row.get("model", ""),
            "state": row.get("state", ""),
            "prompt_tokens": row.get("prompt_tokens"),
            "completion_tokens": row.get("completion_tokens"),
            "tps": row.get("tps"),
            "error": row.get("error"),
            # ISSUE-8: prefer the tracker's explicit lifecycle stamps; ts
            # remains the last-update fallback for old/odd rows.
            "ts_start": row.get("started_at") or row.get("ts_start") or row.get("ts") or time.time(),
            "ts_end": row.get("ended_at") or row.get("ts_end") or time.time(),
            # RL-1 payload fields — COALESCE below keeps earlier captures
            # when a later sparse sample has none (never overwrite with NULL)
            "prompt": row.get("prompt"),
            "prompt_trunc": 1 if row.get("prompt_trunc") else None,
            "output": row.get("output"),
            "output_trunc": 1 if row.get("output_trunc") else None,
            "params": row.get("params"),
            "finish": row.get("finish"),
            "prompt_ids": row.get("prompt_ids"),
            "prompt_ids_trunc": 1 if row.get("prompt_ids_trunc") else None,
            "first_token_ms": row.get("first_token_ms"),
        }
        sql = """INSERT INTO requests(id, model, state, prompt_tokens,
                   completion_tokens, tps, error, ts_start, ts_end,
                   prompt, prompt_trunc, output, output_trunc, params, finish,
                   prompt_ids, prompt_ids_trunc, first_token_ms)
               VALUES(:id, :model, :state, :prompt_tokens,
                   :completion_tokens, :tps, :error, :ts_start, :ts_end,
                   :prompt, :prompt_trunc, :output, :output_trunc, :params, :finish,
                   :prompt_ids, :prompt_ids_trunc, :first_token_ms)
               ON CONFLICT(id) DO UPDATE SET
                 state=excluded.state,
                 prompt_tokens=COALESCE(excluded.prompt_tokens, prompt_tokens),
                 completion_tokens=COALESCE(excluded.completion_tokens, completion_tokens),
                 tps=COALESCE(excluded.tps, tps),
                 error=COALESCE(excluded.error, error),
                 prompt=COALESCE(NULLIF(excluded.prompt, ''), prompt),
                 prompt_trunc=COALESCE(excluded.prompt_trunc, prompt_trunc),
                 output=COALESCE(NULLIF(excluded.output, ''), output),
                 output_trunc=COALESCE(excluded.output_trunc, output_trunc),
                 params=COALESCE(excluded.params, params),
                 finish=COALESCE(excluded.finish, finish),
                 prompt_ids=COALESCE(NULLIF(excluded.prompt_ids, ''), prompt_ids),
                 prompt_ids_trunc=COALESCE(excluded.prompt_ids_trunc, prompt_ids_trunc),
                 first_token_ms=COALESCE(excluded.first_token_ms, first_token_ms),
                 ts_end=excluded.ts_end"""
        if in_tx:
            self._conn.execute(sql, params)
            self._fts_sync(params)
            return
        with self._lock, self._conn:
            self._conn.execute(sql, params)
            self._fts_sync(params)

    def _fts_sync(self, params: dict):
        """Keep request_fts in step with the row just upserted (same tx).

        SEARCH-1: the data path COALESCEs text across upserts, so the
        index must mirror the MERGED stored row, not this call's sparse
        params (a finalize pass with no text would otherwise blank an
        already-indexed prompt). Read the row back inside the same tx.
        Only rows that end up carrying text stay in the index."""
        if not getattr(self, "_has_fts", False):
            return
        try:
            stored = self._conn.execute(
                "SELECT COALESCE(prompt,''), COALESCE(output,'') "
                "FROM requests WHERE id = ?", (params["id"],)).fetchone()
            self._conn.execute(
                "DELETE FROM request_fts WHERE id = ?", (params["id"],))
            if stored and (stored[0] or stored[1]):
                self._conn.execute(
                    "INSERT INTO request_fts(id, prompt, output) "
                    "VALUES(?,?,?)", (params["id"], stored[0], stored[1]))
        except sqlite3.Error:
            # index drift must never break the data path; rebuild on next
            # search miss is not attempted — LIKE fallback still covers us
            self._has_fts = False

    def write_tick(self, pairs: dict[str, float], request_rows: list[dict],
                   ts: float | None = None):
        """ONE transaction per collector tick (RL-0 write hygiene): all
        samples + changed request rows in a single COMMIT. Samples carry
        this server's instance id so co-tenant servers sharing the DB
        cannot poison each other's series (see server_instance_id)."""
        t = ts or time.time()
        inst = server_instance_id()
        with self._lock, self._conn:
            self._conn.executemany(
                "INSERT INTO samples(ts, key, value, instance) VALUES(?,?,?,?)",
                [(t, k, float(v), inst) for k, v in pairs.items()],
            )
            for row in request_rows:
                self.upsert_request(row, in_tx=True)

    def _backfill_1m_range(self, t_from: float, t_to: float):
        b_from = int(t_from // 60) * 60
        b_to = int(t_to // 60) * 60 + 60
        self._conn.execute(
            """INSERT INTO samples_1m(ts, key, value, n, instance)
               SELECT CAST(ts / 60 AS INTEGER) * 60 AS b,
                      key, AVG(value), COUNT(*), COALESCE(instance, '')
                 FROM samples
                WHERE ts >= ? AND ts < ?
                GROUP BY key, b, COALESCE(instance, '')
               ON CONFLICT(key, ts, instance) DO UPDATE SET
                   value = excluded.value,
                   n = excluded.n""",
            (b_from, b_to),
        )

    def _backfill_1m_bg(self, lo: float, hi: float):
        step = 6 * 3600.0
        cur = float(int(lo // 60) * 60)
        end = float(int(hi // 60) * 60 + 60)
        try:
            while cur < end:
                nxt = min(cur + step, end)
                with self._lock, self._conn:
                    self._backfill_1m_range(cur, nxt)
                cur = nxt
            with self._lock, self._conn:
                self._conn.execute(
                    "INSERT INTO meta(key, value) VALUES"
                    "('samples_1m_backfilled','1') "
                    "ON CONFLICT(key) DO UPDATE SET value='1'"
                )
            self._1m_ready = True
            log.info("uplift store: samples_1m backfill complete")
        except sqlite3.Error as exc:
            log.warning("uplift store: samples_1m backfill stopped: %s", exc)

    def purge(self, metrics_days: int | None = None,
              log_days: int | None = None):
        """Split retention: samples age out at metrics_days, request rows
        at log_days.

        RETENTION-1: a server restart orphans in-flight rows FOREVER — the
        tracker rebuilds its _active set from the live engine pool only, so
        a row whose engine is gone can never be finalised, and the old
        "active rows are age-exempt" rule let zombies pile up (72 'queued'
        rows, 9 days old, live proof 2026-10-01). They polluted search and
        the models dropdown. The exemption exists so live rows don't vanish
        mid-flight — the liveness clock is ts_end (upsert stamps it with
        time.time() on every WRITE of the row). One honest caveat: the
        collector skips rows whose signature is unchanged, so a queued row
        that never progresses is written once — after log_days it drops
        from history even if still truly queued, and re-inserts when it
        finally completes. That flicker costs nothing (the live feed reads
        the tracker, not this table) and is far cheaper than the unbounded
        zombie leak the old blanket exemption allowed.

        Runs wal_checkpoint(TRUNCATE) so the WAL file itself gets recycled
        once per day (journal_size_limit keeps it capped between runs).
        VACUUM policy lives in maybe_vacuum() (G2)."""
        ret = self.retention()
        mdays = metrics_days if metrics_days is not None else ret["metrics_days"]
        ldays = log_days if log_days is not None else ret["log_days"]
        cutoff_m = time.time() - mdays * 86400
        cutoff_l = time.time() - ldays * 86400
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff_m,))
            self._conn.execute("DELETE FROM samples_1m WHERE ts < ?", (cutoff_m,))
            gone = self._conn.execute(
                "SELECT id FROM requests "
                "WHERE COALESCE(ts_end, ts_start) < ?",
                (cutoff_l,),
            ).fetchall()
            self._conn.execute(
                "DELETE FROM requests WHERE COALESCE(ts_end, ts_start) < ?",
                (cutoff_l,))
            if gone and self._has_fts:
                ids = [r[0] for r in gone]
                self._conn.executemany(
                    "DELETE FROM request_fts WHERE id = ?", [(i,) for i in ids])
        # Checkpoint OUTSIDE the transaction — TRUNCATE on an open write
        # transaction fails with 'database table is locked'.
        with self._lock:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.maybe_vacuum()

    # -- space reclaim (RETENTION-1 G2) --------------------------------------
    # DELETE frees pages INSIDE the file only; nothing here ever shrank it
    # (587 MB after 13 days, freelist 0 — the space is held for reuse, so a
    # size-only trigger would VACUUM forever and reclaim nothing). The honest
    # measure of 'this store grew to a high-water mark it no longer needs'
    # is page_count - freelist_count (pages holding live rows) versus the
    # file's peak. VACUUM when that live footprint dropped to half the peak
    # AND still leaves a floor big enough to bother (a VACUUM rewrites the
    # whole DB: seconds per 100 MB, one-off).

    VACUUM_MIN_PAGES = 20000      # ~80 MB at 4 KiB pages: below = never worth it
    VACUUM_SHRINK_RATIO = 2.0     # peak at least 2x the live footprint
    VACUUM_MIN_INTERVAL_S = 6 * 3600

    def maybe_vacuum(self) -> bool:
        """Reclaim file space when the DB shrank hard below its high-water
        mark. Runs inside the daily purge pass (collector thread — off the
        event loop); re-runs are rate-limited via meta. Returns True when a
        VACUUM actually executed."""
        try:
            with self._lock:
                pages = self._conn.execute("PRAGMA page_count").fetchone()[0]
                free = self._conn.execute("PRAGMA freelist_count").fetchone()[0]
        except sqlite3.Error:
            return False
        live = max(1, pages - free)
        peak = max(pages, int(self.get_meta("db_peak_pages") or 0))
        now = time.time()
        last = float(self.get_meta("db_last_vacuum") or 0)
        self.set_meta("db_peak_pages", str(peak))
        if pages < self.VACUUM_MIN_PAGES:
            return False
        if peak < live * self.VACUUM_SHRINK_RATIO:
            return False
        if now - last < self.VACUUM_MIN_INTERVAL_S:
            return False
        log.info("uplift store: VACUUM %d pages -> ~%d live", pages, live)
        try:
            with self._lock:
                # VACUUM must run outside any transaction. sqlite3's legacy
                # mode opens one implicitly before DML only, and every write
                # in this class takes _lock — holding it here means no other
                # thread can have a transaction open on this connection.
                self._conn.isolation_level = None
                try:
                    self._conn.execute("VACUUM")
                finally:
                    self._conn.isolation_level = ""
            after = self._conn.execute("PRAGMA page_count").fetchone()[0]
        except sqlite3.Error as exc:   # e.g. disk full: keep old stats, retry tomorrow
            log.warning("uplift store: VACUUM failed: %s", exc)
            return False
        self.set_meta("db_peak_pages", str(after))
        self.set_meta("db_last_vacuum", str(now))
        log.info("uplift store: VACUUM done %d -> %d pages", pages, after)
        return True

    # -- HIST-1 visibility policy ------------------------------------------

    def _hidden_tags(self) -> tuple[str, ...]:
        """Foreign instance tags whose writer process is STILL ALIVE — the
        only rows a filtered read must exclude (their collector
        interleaves deltas with ours: the v3 corruption bug). Dead foreign
        tags and untagged legacy rows are history and stay visible; our own
        tag is never in this set.

        STALE-WHILE-REVALIDATE (SPLIT-READ, 2026-10-14): the tag-set probe
        is a full covering-index scan over `samples` — measured 0.65 s
        native on a 13.2 M-row table. It must never land on a request:
        after the cold-start inline probe the cache is always served
        (stale is fine: it only decides which FOREIGN tags to hide, and a
        just-started co-tenant is filtered within one TTL+scan of its
        first write), while a daemon thread refreshes an expired cache.
        """
        now = time.monotonic()
        cached = self._alien_cache
        if cached is None:
            return self._refresh_hidden()          # cold start: once, inline
        if cached[1] > now:
            return cached[2]
        if not self._alien_refreshing:
            self._alien_refreshing = True
            threading.Thread(target=self._refresh_hidden, daemon=True,
                             name="uplift-alien-probe").start()
        return cached[2]

    def _refresh_hidden(self) -> tuple[str, ...]:
        try:
            # OWN throwaway ro connection: the covering-index scan costs
            # ~0.6 s on a big table — taking _rlock for it would make every
            # reader convoy behind the background refresher (the exact bug
            # SPLIT-READ exists to kill). WAL readers need no lock.
            conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True,
                                   timeout=2.0)
            try:
                tags = frozenset(_distinct_tags(conn))
            finally:
                conn.close()
            hidden = []
            for t in tags:
                if t == self._own_instance:
                    continue
                _keg, pid = _split_instance(t)
                if pid is None or _pid_alive(pid):
                    hidden.append(t)   # live co-tenant or unprovable: hide
            result = tuple(sorted(hidden))
            self._alien_cache = (tags, time.monotonic() + _VISIBLE_TTL_S,
                                 result)
            return result
        finally:
            self._alien_refreshing = False

    def visible_instances(self) -> str:
        """Sentinel for the API layer: read under the HIST-1 visibility
        policy (own rows + history, live co-tenants hidden). The store
        computes the tag set itself — callers must not snapshot it."""
        return VISIBLE_INSTANCES

    def _instance_sql(self, instance: str | None) -> tuple[str, list]:
        """(sql fragment, args) restricting a `samples` read to INSTANCE.
        None: no filter (viewer/CLI browse — everything by design).
        VISIBLE_INSTANCES: exclude live-alien writers (HIST-1).
        Anything else: legacy exact match plus untagged rows, unchanged."""
        if instance is None:
            return "", []
        if instance == VISIBLE_INSTANCES:
            hidden = self._hidden_tags()
            if not hidden:
                return "", []     # nobody to hide: own+dead+NULL is everything
            # (own + dead + NULL visible) == NOT IN (live aliens)
            ph = ",".join("?" * len(hidden))
            return f" AND (instance IS NULL OR instance NOT IN ({ph}))", list(hidden)
        return " AND (instance IS NULL OR instance=?)", [instance]

    def _instance_sql_1m(self, instance: str | None) -> tuple[str, list]:
        """Instance filter for `samples_1m` (untagged legacy rows store ''
        instead of NULL so the unique PK works)."""
        if instance is None:
            return "", []
        if instance == VISIBLE_INSTANCES:
            hidden = self._hidden_tags()
            if not hidden:
                return "", []
            ph = ",".join("?" * len(hidden))
            return f" AND instance NOT IN ({ph})", list(hidden)
        return " AND instance IN ('', ?)", [instance]

    # -- read side (API/viewer, lock-free via per-thread ro WAL handles) ---

    def series(self, key: str, window_s: float, now: float | None = None,
               instance: str | None = None,
               since: float | None = None) -> list[dict]:
        """Samples for KEY over the window. INSTANCE (when given) restricts
        the read: an exact tag keeps that writer's rows plus untagged legacy
        rows (co-tenant isolation, v3); the VISIBLE_INSTANCES sentinel keeps
        history from dead writers too and hides only live co-tenants
        (HIST-1). See _instance_sql."""
        t0 = (now or time.time()) - window_s
        # TAIL-1: SINCE clamps the low edge — the client's incremental
        # "give me everything after the newest point I hold" fetch. The
        # (key, ts) index prefix turns it into a seek, not a filter.
        if since is not None and since > t0:
            t0 = since
        frag, args = self._instance_sql(instance)
        cur = self._get_rconn().execute(
            "SELECT ts, value FROM samples WHERE key=? AND ts>=?" + frag
            + " ORDER BY ts",
            [key, t0] + args,
        )
        return [{"ts": r[0], "v": r[1]} for r in cur.fetchall()]

    def series_multi(self, keys: list[str], window_s: float,
                     now: float | None = None,
                     instance: str | None = None,
                     since: float | None = None) -> dict[str, list[dict]]:
        """Batch read for multiple KEYS in a single SQL statement."""
        if not keys:
            return {}
        if len(keys) == 1:
            k = keys[0]
            return {k: self.series(k, window_s, now, instance, since)}
        t0 = (now or time.time()) - window_s
        if since is not None and since > t0:
            t0 = since
        ph = ",".join("?" * len(keys))
        frag, args = self._instance_sql(instance)
        cur = self._get_rconn().execute(
            f"SELECT key, ts, value FROM samples"
            f" WHERE key IN ({ph}) AND ts>=?{frag}"
            f" ORDER BY key, ts",
            list(keys) + [t0] + args,
        )
        out: dict[str, list[dict]] = {k: [] for k in keys}
        for k, ts, v in cur.fetchall():
            out[k].append({"ts": ts, "v": v})
        return out

    def series_binned(self, key: str, window_s: float, bucket_s: int,
                      instance: str | None = None,
                      since: float | None = None) -> list[dict]:
        """KEY over the window aggregated into equal-width, epoch-aligned
        buckets (PERF-1): AVG computed INSIDE SQLite, one row per bucket
        back. ROLLUP-1 reads from `samples_1m` (12x fewer rows than 5 s
        samples) whenever the 1-minute rollup table is ready and the
        bucket is a whole multiple of 60 s."""
        t0 = time.time() - window_s
        if since is not None and since > t0:
            t0 = since
        conn = self._get_rconn()
        if self._1m_ready and since is None and bucket_s >= 60 and bucket_s % 60 == 0:
            t0_m = int(t0 // 60) * 60
            frag, args = self._instance_sql_1m(instance)
            if bucket_s == 60:
                cur = conn.execute(
                    "SELECT ts, SUM(value * n) / SUM(n)"
                    " FROM samples_1m WHERE key=? AND ts>=?" + frag +
                    " GROUP BY ts ORDER BY ts",
                    [key, t0_m] + args,
                )
            else:
                cur = conn.execute(
                    "SELECT CAST(ts / ? AS INTEGER) * ? AS b,"
                    " SUM(value * n) / SUM(n)"
                    " FROM samples_1m WHERE key=? AND ts>=?" + frag +
                    " GROUP BY b ORDER BY b",
                    [bucket_s, bucket_s, key, t0_m] + args,
                )
            return [{"ts": float(r[0]), "v": float(r[1])}
                    for r in cur.fetchall() if r[1] is not None]
        frag, args = self._instance_sql(instance)
        cur = conn.execute(
            "SELECT CAST(ts / ? AS INTEGER) * ? AS b, AVG(value)"
            " FROM samples WHERE key=? AND ts>=?" + frag +
            " GROUP BY b ORDER BY b",
            [bucket_s, bucket_s, key, t0] + args,
        )
        return [{"ts": float(r[0]), "v": float(r[1])}
                for r in cur.fetchall() if r[1] is not None]

    def series_binned_multi(self, keys: list[str], window_s: float,
                            bucket_s: int, instance: str | None = None,
                            since: float | None = None) -> dict[str, list[dict]]:
        """Batch bucketed read for multiple KEYS in a single SQL statement."""
        if not keys:
            return {}
        if len(keys) == 1:
            k = keys[0]
            return {k: self.series_binned(k, window_s, bucket_s, instance, since)}
        t0 = time.time() - window_s
        if since is not None and since > t0:
            t0 = since
        ph = ",".join("?" * len(keys))
        conn = self._get_rconn()
        out: dict[str, list[dict]] = {k: [] for k in keys}
        if self._1m_ready and since is None and bucket_s >= 60 and bucket_s % 60 == 0:
            t0_m = int(t0 // 60) * 60
            frag, args = self._instance_sql_1m(instance)
            if bucket_s == 60:
                cur = conn.execute(
                    f"SELECT key, ts, SUM(value * n) / SUM(n)"
                    f" FROM samples_1m WHERE key IN ({ph}) AND ts>=?{frag}"
                    f" GROUP BY key, ts ORDER BY key, ts",
                    list(keys) + [t0_m] + args,
                )
            else:
                cur = conn.execute(
                    f"SELECT key, CAST(ts / ? AS INTEGER) * ? AS b,"
                    f" SUM(value * n) / SUM(n)"
                    f" FROM samples_1m WHERE key IN ({ph}) AND ts>=?{frag}"
                    f" GROUP BY key, b ORDER BY key, b",
                    [bucket_s, bucket_s] + list(keys) + [t0_m] + args,
                )
        else:
            frag, args = self._instance_sql(instance)
            cur = conn.execute(
                f"SELECT key, CAST(ts / ? AS INTEGER) * ? AS b, AVG(value)"
                f" FROM samples WHERE key IN ({ph}) AND ts>=?{frag}"
                f" GROUP BY key, b ORDER BY key, b",
                [bucket_s, bucket_s] + list(keys) + [t0] + args,
            )
        for k, b, v in cur.fetchall():
            if v is not None:
                out[k].append({"ts": float(b), "v": float(v)})
        return out

    def latest(self, key: str, instance: str | None = None) -> dict | None:
        """Newest stored point for KEY (U11: live chart pushes read the
        collector's sample instead of re-deriving it client-side).
        INSTANCE filtering works as in series(). Under VISIBLE_INSTANCES a
        hidden live co-tenant's newer point must never drive our live line,
        so own-tag rows sort first and history only fills gaps (own writer
        stops on restart; the newest own point then wins)."""
        conn = self._get_rconn()
        frag, args = self._instance_sql(instance)
        if instance == VISIBLE_INSTANCES:
            # SQUEEZE-LATEST: the original single query ordered by the
            # COMPUTED key (instance=own) DESC, ts DESC — which defeats
            # the (key, ts) index and scanned every row of the key
            # (468 K on a bench day => 0.49 s per call, measured). Same
            # semantics from two index-fast queries: own-tag newest
            # first (the live line follows OUR collector whenever its
            # rows exist), then any visible newest as history backfill
            # (own writer stopped after a restart; the newest foreign/
            # legacy point then fills the gap).
            cur = conn.execute(
                "SELECT ts, value FROM samples WHERE key=?" + frag
                + " AND instance=? ORDER BY ts DESC LIMIT 1",
                [key] + args + [self._own_instance])
            row = cur.fetchone()
            if row is None:
                cur = conn.execute(
                    "SELECT ts, value FROM samples WHERE key=?" + frag
                    + " ORDER BY ts DESC LIMIT 1",
                    [key] + args)
                row = cur.fetchone()
        else:
            cur = conn.execute(
                "SELECT ts, value FROM samples WHERE key=?" + frag
                + " ORDER BY ts DESC LIMIT 1",
                [key] + args)
            row = cur.fetchone()
        return {"ts": row[0], "v": row[1]} if row else None

    def recent_requests(self, limit: int = 200) -> list[dict]:
        cur = self._get_rconn().execute(
            "SELECT * FROM requests ORDER BY ts_start DESC LIMIT ?", (limit,)
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def distinct_models(self, ts_from: float | None = None) -> list[str]:
        """Models that have stored request history (issue 4: the search
        model dropdown must offer what actually has history, not just what
        this browser tab happened to see live)."""
        q = "SELECT DISTINCT model FROM requests WHERE model IS NOT NULL AND model != ''"
        args: list = []
        if ts_from is not None:
            q += " AND ts_start >= ?"
            args.append(float(ts_from))
        q += " ORDER BY model"
        return [r[0] for r in self._get_rconn().execute(q, args).fetchall()]

    def keys_with_prefix(self, prefix: str, window_s: float,
                         instance: str | None = None) -> list[str]:
        """Metric keys with stored samples in KEY LIKE PREFIX+'%' over the
        window. Discovery for series whose key names the client cannot know
        (per-model hot-cache keys carry the model id). INSTANCE filtering as
        in series(): under VISIBLE_INSTANCES a co-tenant's model list stays
        out but drained models from dead sessions backfill (HIST-1).

        PERF-1 (user 2026-10-21): the old `key LIKE 'prefix%' AND ts>=?`
        had no index path — LIKE with a free-form prefix cannot use
        (key, ts) as a range, so every call walked the whole covering
        index (15.7 M rows, ~1.1 s measured) just to answer a question
        whose honest answer changes at most as often as the collector
        discovers a new model. Now: window-first scan on the new covering
        index ix_samples_ts_key (ts, key, instance) with a prefix RANGE
        predicate (key >= p AND key < p_upper), and a small shared TTL
        cache so N tabs polling the same window pay the walk ONCE per
        TTL. A just-loaded model appears within one TTL+tick, same bound
        the HIST-1 alien cache already carries."""
        t0 = time.time() - window_s
        ck = (prefix, round(window_s))
        now = time.monotonic()
        with self._keys_lock:
            ent = self._keys_cache.get(ck)
            if ent and ent[0] > now:
                return ent[1]
        upper = prefix[:-1] + chr(ord(prefix[-1]) + 1) if prefix else prefix
        q = ("SELECT DISTINCT key FROM samples"
             " WHERE ts >= ? AND key >= ? AND key < ?")
        args = [t0, prefix, upper]
        frag, extra = self._instance_sql(instance)
        q += frag
        args += extra
        q += " ORDER BY key"
        keys = [r[0] for r in self._get_rconn().execute(q, args).fetchall()]
        with self._keys_lock:
            self._keys_cache[ck] = (now + _KEYS_TTL_S, keys)
        return keys

    def request_by_id(self, request_id: str) -> dict | None:
        cur = self._get_rconn().execute(
            "SELECT * FROM requests WHERE id = ?", (request_id,)
        )
        row = cur.fetchone()
        if row is None:
            return None
        return dict(zip((d[0] for d in cur.description), row))

    # -- RL-3 fulltext + timespan search ------------------------------------

    def search_requests(self, q: str = "", model: str = "",
                        ts_from: float | None = None,
                        ts_to: float | None = None,
                        limit: int = 50) -> dict:
        """Server-side search over the stored `requests` table.

        Returns {results: [{row fields..., excerpt}], mode: 'fts'|'like'}.
        One query, no N+1: hits come back with a ~200-char excerpt built
        server-side. FTS5 when available (MATCH + snippet()); LIKE with
        escaped wildcards otherwise. Empty q = pure timespan/model scan.
        """
        limit = max(1, min(int(limit or 50), 200))
        where, args = [], []
        if ts_from is not None:
            where.append("r.ts_start >= ?"); args.append(float(ts_from))
        if ts_to is not None:
            where.append("r.ts_start <= ?"); args.append(float(ts_to))
        if model:
            where.append("r.model = ?"); args.append(model)

        q = (q or "").strip()
        # CJK-1: unicode61 indexes an unbroken CJK run as ONE token, so any
        # CJK substring query can never MATCH — route queries containing CJK
        # (incl. mixed ones) to LIKE, whose substring semantics fit natively.
        cjk = _CJK_RE.search(q) is not None
        use_fts = bool(q) and self._has_fts and not cjk
        mode = "fts" if use_fts else ("like" if q else "scan")
        sel = ("r.id, r.model, r.state, r.prompt_tokens, r.completion_tokens,"
               " r.tps, r.error, r.finish, r.ts_start, r.ts_end")
        cols = ["id", "model", "state", "prompt_tokens", "completion_tokens",
                "tps", "error", "finish", "ts_start", "ts_end"]

        conn = self._get_rconn()
        match_expr = fts_query(q) if use_fts else None
        if use_fts and match_expr is None:
            # PUNCT-1: only punctuation tokens — MATCH can never hit;
            # answer via LIKE (escaped substring handles them fine)
            use_fts = False
            mode = "like"
        if use_fts:
            try:
                cur = conn.execute(
                    f"""SELECT {sel},
                               snippet(request_fts, 1, '[', ']', '...', 24) AS ex
                        FROM request_fts f JOIN requests r ON r.id = f.id
                        WHERE request_fts MATCH ? {_and(where)}
                        ORDER BY r.ts_start DESC LIMIT ?""",
                    [match_expr] + args + [limit])
                results = []
                for row in cur.fetchall():
                    d = dict(zip(cols + ["excerpt"], row))
                    results.append(d)
                return {"results": results, "mode": "fts", "q": q}
            except sqlite3.OperationalError:
                # MATCH syntax/index hiccup: answer THIS query with
                # LIKE; do not flip _has_fts (a probe error would
                # degrade every later search — _fts_sync owns that).
                mode = "like"

        if q:
            # token-AND like the FTS path: every whitespace-separated
            # token must appear (in prompt or output). Whole-query
            # LIKE fails mixed scripts / word order (CJK-1 tests).
            for tok in re.findall(r"\S+", q):
                pat = ("%" + tok.replace("\\", "\\\\").replace("%", "\\%")
                       .replace("_", "\\_") + "%")
                where.append("(r.prompt LIKE ? ESCAPE '\\' "
                             "OR r.output LIKE ? ESCAPE '\\')")
                args += [pat, pat]

        cur = conn.execute(
            f"""SELECT {sel}, r.prompt, r.output
                FROM requests r {_where_clause(where)}
                ORDER BY r.ts_start DESC LIMIT ?""",
            args + [limit])
        results = []
        for row in cur.fetchall():
            d = dict(zip(cols + ["_prompt", "_output"], row))
            d["excerpt"] = _excerpt(d.pop("_prompt"), d.pop("_output"), q)
            results.append(d)
        return {"results": results, "mode": mode, "q": q}

    def close(self):
        with self._rconns_lock:
            conns = list(self._rconns)
            self._rconns.clear()
        for c in conns:
            if c is not self._conn:
                try:
                    c.close()
                except sqlite3.Error:
                    pass
        self._rlocal = threading.local()
        with self._lock:
            self._conn.close()


_store: MetricsStore | None = None
_store_lock = threading.Lock()


def get_store() -> MetricsStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = MetricsStore()
        return _store
