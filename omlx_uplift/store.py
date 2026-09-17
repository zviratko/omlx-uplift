"""Uplift metrics store — SQLite in ~/.omlx/uplift/ (owned by Uplift).

Vanilla omlx writes its OWN ~/.omlx/usage.sqlite3 (hourly rollups, see
omlx/usage_history.py); we never write that file — the viewer opens it
READ-ONLY (mode=ro) and merges it as the coarse history layer.

Our file adds sub-hour samples and per-request rows:
  samples(ts, key, value)      interval metrics (tokens/s, cache hit %,
                               loaded models, active requests, totals)
  requests(id PK, model, state, prompt_tokens, completion_tokens, tps,
           error, ts_start, ts_end)   per-request lifecycle rows
Retention: rows older than RETENTION_DAYS are purged on every write pass.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path

RETENTION_DAYS = 30
_SCHEMA_VERSION = 1


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
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else default_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
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
            self._conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)",
                (str(_SCHEMA_VERSION),),
            )

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

    def upsert_request(self, row: dict):
        """Insert-or-update one request row from tracker fields."""
        with self._lock, self._conn:
            self._conn.execute(
                """INSERT INTO requests(id, model, state, prompt_tokens,
                       completion_tokens, tps, error, ts_start, ts_end)
                   VALUES(:id, :model, :state, :prompt_tokens,
                       :completion_tokens, :tps, :error, :ts_start, :ts_end)
                   ON CONFLICT(id) DO UPDATE SET
                     state=excluded.state,
                     prompt_tokens=COALESCE(excluded.prompt_tokens, prompt_tokens),
                     completion_tokens=COALESCE(excluded.completion_tokens, completion_tokens),
                     tps=COALESCE(excluded.tps, tps),
                     error=COALESCE(excluded.error, error),
                     ts_end=excluded.ts_end""",
                {
                    "id": row["id"],
                    "model": row.get("model", ""),
                    "state": row.get("state", ""),
                    "prompt_tokens": row.get("prompt_tokens"),
                    "completion_tokens": row.get("completion_tokens"),
                    "tps": row.get("tps"),
                    "error": row.get("error"),
                    "ts_start": row.get("ts_start") or row.get("ts") or time.time(),
                    "ts_end": row.get("ts_end") or time.time(),
                },
            )

    def purge(self, days: int = RETENTION_DAYS):
        cutoff = time.time() - days * 86400
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            self._conn.execute(
                "DELETE FROM requests WHERE ts_start < ? "
                "AND state IN ('complete','error')",
                (cutoff,),
            )

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
