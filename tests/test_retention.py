"""RL-0 acceptance: split/configurable retention + write hygiene.

1. purge keeps a 1.5-day-old request with log_days=2, deletes a 3-day-old
   one; samples survive to 30 d. Active-state rows never purge by age.
2. env override wins over meta; meta persists and survives reopen; clamps.
3. one collector tick = one COMMIT; an unchanged finished row is NOT
   re-written on the next tick.
4. write-connection pragmas: journal_mode=WAL, synchronous=NORMAL,
   journal_size_limit=4194304, busy_timeout=5000.
"""
import time

import pytest

from omlx_uplift.collector import Collector
from omlx_uplift.store import MetricsStore


@pytest.fixture()
def store(tmp_path):
    s = MetricsStore(path=tmp_path / "metrics.sqlite3")
    yield s
    s.close()


def _req(rid, state, age_s, **kw):
    row = {"id": rid, "model": "m", "state": state, "prompt_tokens": 1,
           "completion_tokens": 2, "tps": 10.0, "error": None,
           "ts_start": time.time() - age_s, "ts_end": time.time() - age_s}
    row.update(kw)
    return row


# -- 1. split purge ---------------------------------------------------------

def test_purge_split_retention(store):
    store.upsert_request(_req("fresh", "complete", 1.5 * 86400))
    store.upsert_request(_req("old", "complete", 3 * 86400))
    store.upsert_request(_req("ancient-active", "generating", 40 * 86400))
    store.write_sample("k", 1.0, ts=time.time() - 3 * 86400)   # log-age
    store.write_sample("k", 2.0, ts=time.time() - 31 * 86400)  # metrics-age

    store.purge()  # defaults: metrics 30 d, log 2 d

    ids = {r["id"] for r in store.recent_requests()}
    assert "fresh" in ids           # younger than log_days=2
    assert "old" not in ids         # finished + older than log window
    assert "ancient-active" in ids  # active state never purged by age
    pts = store.series("k", window_s=45 * 86400)
    assert len(pts) == 1 and pts[0]["v"] == 1.0  # 31 d sample purged, 3 d survives


# -- 2. resolution order + clamping -----------------------------------------

def test_retention_defaults(store):
    r = store.retention()
    assert r == {"metrics_days": 30, "log_days": 2, "source": "default"}


def test_retention_meta_persists_survives_reopen(store):
    out = store.set_retention(metrics_days=7, log_days=1)
    assert (out["metrics_days"], out["log_days"], out["source"]) == (7, 1, "meta")
    store.close()
    s2 = MetricsStore(path=store.path)
    try:
        r = s2.retention()
        assert (r["metrics_days"], r["log_days"], r["source"]) == (7, 1, "meta")
    finally:
        s2.close()


def test_retention_env_wins_over_meta(store, monkeypatch):
    store.set_retention(metrics_days=7, log_days=1)
    monkeypatch.setenv("OMLX_UPLIFT_RETENTION_METRICS_DAYS", "14")
    monkeypatch.setenv("OMLX_UPLIFT_RETENTION_LOG_DAYS", "3")
    r = store.retention()
    assert (r["metrics_days"], r["log_days"], r["source"]) == (14, 3, "env")


def test_retention_clamps(store):
    out = store.set_retention(metrics_days=9999, log_days=0)
    assert out["metrics_days"] == 365        # clamp to max
    # documented rule: 0/negative/invalid keeps PREVIOUS resolved value;
    # previous for log_days was the default 2 (never set before).
    assert out["log_days"] == 2
    out2 = store.set_retention(metrics_days=5, log_days=1)
    out3 = store.set_retention(metrics_days=-5, log_days="junk")
    assert (out3["metrics_days"], out3["log_days"]) == (5, 1)  # keeps previous


# -- 4. pragmas ---------------------------------------------------------------

def test_write_connection_pragmas(store):
    assert store._conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert store._conn.execute("PRAGMA synchronous").fetchone()[0] == 1  # NORMAL
    assert store._conn.execute("PRAGMA journal_size_limit").fetchone()[0] == 4194304
    assert store._conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000


# -- 3. one transaction per tick + changed-only re-persist --------------------

class FakeTracker:
    def __init__(self, rows):
        self.rows = rows

    def list_rows(self, limit=200):
        return [dict(r) for r in self.rows]


class RecordingConn:
    """Delegating proxy that records statements + commits (Python 3.11 has
    no sqlite3 Connection.settrace)."""

    def __init__(self, real):
        self._real = real
        self.stmts = []
        self.commits = 0

    def execute(self, sql, *a, **kw):
        self.stmts.append(sql)
        return self._real.execute(sql, *a, **kw)

    def executemany(self, sql, *a, **kw):
        self.stmts.append(sql)
        return self._real.executemany(sql, *a, **kw)

    def commit(self):
        self.commits += 1
        return self._real.commit()

    def __enter__(self):
        self._real.__enter__()
        return self

    def __exit__(self, *exc):
        # `with conn:` commits inside sqlite3 C code — count it here.
        self.commits += 1
        return self._real.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_tick_single_transaction_and_unchanged_row_not_rewritten(store, monkeypatch):
    import omlx_uplift.request_log as rl
    import omlx_uplift.router as rt

    monkeypatch.setattr(rt, "engine_pool", lambda: None)
    row = _req("r1", "complete", 10)
    monkeypatch.setattr(rl, "get_request_tracker", lambda: FakeTracker([row]))

    rec = RecordingConn(store._conn)
    store._conn = rec

    c = Collector(store=store)
    c._purged_day = int(time.time() // 86400)  # keep the daily purge out of this tick

    # tick 1: row appears; all writes share ONE transaction (one COMMIT)
    rec.stmts.clear(); rec.commits = 0
    c.sample_once()
    assert rec.commits == 1, f"one tick = one COMMIT, saw {rec.commits}"
    req = MetricsStore.__new__(MetricsStore)  # read via the real conn below
    got = rec.execute("SELECT id, state, ts_end FROM requests WHERE id='r1'").fetchone()
    assert got[0] == "r1" and got[1] == "complete"
    ts_end_v1 = got[2]

    # tick 2: identical row -> ZERO write statements touching requests,
    # still exactly one COMMIT (samples only)
    rec.stmts.clear(); rec.commits = 0
    c.sample_once()
    req_writes = [s for s in rec.stmts if "requests" in s
                  and s.strip().upper().startswith(("INSERT", "UPDATE"))]
    assert req_writes == [], f"unchanged finished row must not be re-written: {req_writes}"
    assert rec.commits == 1
    got = rec.execute("SELECT ts_end, state FROM requests WHERE id='r1'").fetchone()
    assert got[0] == ts_end_v1 and got[1] == "complete"

    # tick 3: state changes -> row persists again
    monkeypatch.setattr(rl, "get_request_tracker",
                        lambda: FakeTracker([_req("r1", "error", 10)]))
    rec.stmts.clear(); rec.commits = 0
    c.sample_once()
    assert any("requests" in s and s.strip().upper().startswith("INSERT")
               for s in rec.stmts)
    assert rec.commits == 1
    got = rec.execute("SELECT state FROM requests WHERE id='r1'").fetchone()
    assert got[0] == "error"


# -- RL-1 store migration + payload persistence -------------------------------

def test_v1_db_migrates_columns_once(tmp_path):
    import sqlite3
    p = tmp_path / "v1.sqlite3"
    # build a v1-shaped DB by hand (pre-payload schema)
    c = sqlite3.connect(p)
    c.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE samples(ts REAL, key TEXT, value REAL);
        CREATE TABLE requests(id TEXT PRIMARY KEY, model TEXT, state TEXT,
            prompt_tokens INTEGER, completion_tokens INTEGER, tps REAL,
            error TEXT, ts_start REAL, ts_end REAL);
        INSERT INTO meta VALUES('schema_version','1');
    """)
    c.close()

    s = MetricsStore(path=p)
    cols1 = {r[1] for r in s._conn.execute("PRAGMA table_info(requests)")}
    assert {"prompt", "prompt_trunc", "output", "output_trunc",
            "params", "finish"} <= cols1
    assert s.get_meta("schema_version") == "2"
    s.close()

    # second open: ALTER is a no-op (no duplicate-column error)
    s2 = MetricsStore(path=p)
    cols2 = {r[1] for r in s2._conn.execute("PRAGMA table_info(requests)")}
    assert cols2 == cols1
    s2.close()


def test_upsert_coalesce_keeps_earlier_payload(store):
    store.upsert_request({**_req("c1", "generating", 10),
                          "prompt": "PROMPT", "output": "TAIL",
                          "output_trunc": True, "params": '{"temperature": 1.0}'})
    # later sparse sample (no payload) must NOT null out stored payload
    store.upsert_request(_req("c1", "complete", 20))
    row = store.recent_requests()[0]
    assert row["prompt"] == "PROMPT" and row["output"] == "TAIL"
    assert row["output_trunc"] == 1 and row["params"] == '{"temperature": 1.0}'
    assert row["state"] == "complete"
