"""Uplift metrics store — SQLite in ~/.omlx/uplift/ (owned by Uplift).

Vanilla omlx writes its OWN ~/.omlx/usage.sqlite3 (hourly rollups, see
omlx/usage_history.py); we never write that file — the viewer opens it
READ-ONLY (mode=ro) and merges it as the coarse history layer.

Our file adds sub-hour samples and per-request rows:
  samples(ts, key, value)      interval metrics (tokens/s, cache hit %,
                               loaded models, active requests, totals)
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

import os
import re
import sqlite3
import threading
import time
from pathlib import Path

RETENTION_METRICS_DAYS = 30
RETENTION_LOG_DAYS = 2
_RET_CLAMP = (1, 365)
_SCHEMA_VERSION = 2
# v1 -> v2 (RL-1): payload columns on `requests`. Migration is idempotent:
# ALTER TABLE ADD COLUMN runs once per column, guarded by PRAGMA table_info.
_NEW_COLUMNS = {
    "prompt": "TEXT", "prompt_trunc": "INTEGER",
    "output": "TEXT", "output_trunc": "INTEGER",
    "params": "TEXT", "finish": "TEXT",
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
    # Same resolution priority omlx uses for its own base dir
    # (omlx.settings.resolve_default_base_path), with env fallback for
    # standalone usage (viewer/CLI without a running server).
    base = None
    try:
        from omlx.server import _server_state

        gs = getattr(_server_state, "global_settings", None)
        bp = getattr(gs, "base_path", None) if gs else None
        if bp:
            base = Path(bp)
    except Exception:
        pass
    if base is None:
        env = os.environ.get("OMLX_BASE_PATH")
        base = Path(env) if env else Path(os.path.expanduser("~/.omlx"))
    return base / "uplift" / "metrics.sqlite3"


def open_usage_ro(path: Path | None = None) -> sqlite3.Connection:
    """Open vanilla's usage.sqlite3 strictly READ-ONLY."""
    p = path or (default_db_path().parent.parent / "usage.sqlite3")
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


class MetricsStore:
    def __init__(self, path: Path | None = None, read_only: bool = False):
        self.path = Path(path) if path else default_db_path()
        self._lock = threading.Lock()
        self._has_fts = False   # _init_schema flips it when FTS5 is usable
        if read_only:
            if not self.path.exists():
                raise FileNotFoundError(self.path)
            self._conn = sqlite3.connect(
                f"file:{self.path}?mode=ro", uri=True, check_same_thread=False
            )
            # read-only viewer: FTS is usable iff the table already exists
            try:
                self._has_fts = bool(self._conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='request_fts'"
                ).fetchone())
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

    def _init_schema(self):
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS samples (
                    ts REAL NOT NULL, key TEXT NOT NULL, value REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS ix_samples_key_ts
                    ON samples(key, ts);
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
            self._conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(_SCHEMA_VERSION),),
            )
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

    # -- write side (collector) ------------------------------------------

    def write_sample(self, key: str, value: float, ts: float | None = None):
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO samples(ts, key, value) VALUES(?,?,?)",
                (ts or time.time(), key, float(value)),
            )

    def write_samples(self, pairs: dict[str, float], ts: float | None = None):
        t = ts or time.time()
        with self._lock, self._conn:
            self._conn.executemany(
                "INSERT INTO samples(ts, key, value) VALUES(?,?,?)",
                [(t, k, float(v)) for k, v in pairs.items()],
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
            "ts_start": row.get("ts_start") or row.get("ts") or time.time(),
            "ts_end": row.get("ts_end") or time.time(),
            # RL-1 payload fields — COALESCE below keeps earlier captures
            # when a later sparse sample has none (never overwrite with NULL)
            "prompt": row.get("prompt"),
            "prompt_trunc": 1 if row.get("prompt_trunc") else None,
            "output": row.get("output"),
            "output_trunc": 1 if row.get("output_trunc") else None,
            "params": row.get("params"),
            "finish": row.get("finish"),
        }
        sql = """INSERT INTO requests(id, model, state, prompt_tokens,
                   completion_tokens, tps, error, ts_start, ts_end,
                   prompt, prompt_trunc, output, output_trunc, params, finish)
               VALUES(:id, :model, :state, :prompt_tokens,
                   :completion_tokens, :tps, :error, :ts_start, :ts_end,
                   :prompt, :prompt_trunc, :output, :output_trunc, :params, :finish)
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
        samples + changed request rows in a single COMMIT."""
        t = ts or time.time()
        with self._lock, self._conn:
            self._conn.executemany(
                "INSERT INTO samples(ts, key, value) VALUES(?,?,?)",
                [(t, k, float(v)) for k, v in pairs.items()],
            )
            for row in request_rows:
                self.upsert_request(row, in_tx=True)

    def purge(self, metrics_days: int | None = None,
              log_days: int | None = None):
        """Split retention: samples age out at metrics_days, FINISHED
        request rows at log_days (active rows never purge by age — they
        would otherwise vanish mid-flight and orphan their updates).
        Runs wal_checkpoint(TRUNCATE) so the WAL file itself gets recycled
        once per day (journal_size_limit keeps it capped between runs)."""
        ret = self.retention()
        mdays = metrics_days if metrics_days is not None else ret["metrics_days"]
        ldays = log_days if log_days is not None else ret["log_days"]
        cutoff_m = time.time() - mdays * 86400
        cutoff_l = time.time() - ldays * 86400
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff_m,))
            gone = self._conn.execute(
                "SELECT id FROM requests WHERE ts_start < ? "
                "AND state IN ('complete','error')",
                (cutoff_l,),
            ).fetchall()
            self._conn.execute(
                "DELETE FROM requests WHERE ts_start < ? "
                "AND state IN ('complete','error')",
                (cutoff_l,),
            )
            if gone and self._has_fts:
                ids = [r[0] for r in gone]
                self._conn.executemany(
                    "DELETE FROM request_fts WHERE id = ?", [(i,) for i in ids])
        # Checkpoint OUTSIDE the transaction — TRUNCATE on an open write
        # transaction fails with 'database table is locked'.
        with self._lock:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # -- read side (API/viewer) -------------------------------------------

    def series(self, key: str, window_s: float, now: float | None = None) -> list[dict]:
        t0 = (now or time.time()) - window_s
        with self._lock:
            cur = self._conn.execute(
                "SELECT ts, value FROM samples WHERE key=? AND ts>=? ORDER BY ts",
                (key, t0),
            )
            return [{"ts": r[0], "v": r[1]} for r in cur.fetchall()]

    def recent_requests(self, limit: int = 200) -> list[dict]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM requests ORDER BY ts_start DESC LIMIT ?", (limit,)
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def request_by_id(self, request_id: str) -> dict | None:
        with self._lock:
            cur = self._conn.execute(
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

        with self._lock:
            match_expr = fts_query(q) if use_fts else None
            if use_fts and match_expr is None:
                # PUNCT-1: only punctuation tokens — MATCH can never hit;
                # answer via LIKE (escaped substring handles them fine)
                use_fts = False
                mode = "like"
            if use_fts:
                try:
                    cur = self._conn.execute(
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

            cur = self._conn.execute(
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
