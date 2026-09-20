"""RL-3 acceptance: fulltext + timespan search over the stored requests.

1. FTS path finds a phrase inside a captured prompt; excerpt surrounds it.
2. LIKE fallback (force via store._has_fts = False) finds the same row;
   mode advertises 'like'.
3. Timespan edges: from/to are inclusive-ish boundaries (>= and <=).
4. LIKE escaping: '%', '_', quotes, backslashes search literally, never
   match-everything.
5. purge removes FTS rows together with the data rows (no orphans).
6. Model filter + scan mode (empty q).
"""
import time

import pytest

from omlx_uplift.store import MetricsStore, fts_query


@pytest.fixture()
def store(tmp_path):
    s = MetricsStore(path=tmp_path / "metrics.sqlite3")
    yield s
    s.close()


def _row(rid, prompt="hello world", output="ok", age_s=60, model="m", **kw):
    row = {"id": rid, "model": model, "state": "complete",
           "prompt_tokens": 1, "completion_tokens": 2, "tps": 10.0,
           "error": None,
           "ts_start": time.time() - age_s, "ts_end": time.time() - age_s,
           "prompt": prompt, "output": output}
    row.update(kw)
    return row


def test_fts_finds_phrase_with_excerpt(store):
    store.upsert_request(_row("s1", prompt="the QUICK brown fox jumped", age_s=100))
    store.upsert_request(_row("s2", prompt="boring unrelated text", age_s=50))
    assert store._has_fts, "FTS5 expected on this sqlite build"

    r = store.search_requests(q="quick brown")
    assert r["mode"] == "fts"
    assert [h["id"] for h in r["results"]] == ["s1"]
    assert "QUICK" in r["results"][0]["excerpt"]


def test_like_fallback_same_result(store):
    store.upsert_request(_row("s1", prompt="the QUICK brown fox jumped"))
    store._has_fts = False                      # simulate no-FTS build
    r = store.search_requests(q="quick brown")
    assert r["mode"] == "like"
    assert [h["id"] for h in r["results"]] == ["s1"]


def test_output_text_searched_too(store):
    store.upsert_request(_row("s3", prompt="prompt here", output="needle in output"))
    for force_like in (False, True):
        if force_like:
            store._has_fts = False
        hits = store.search_requests(q="needle in output")
        assert [h["id"] for h in hits["results"]] == ["s3"], force_like


def test_timespan_window(store):
    now = time.time()
    store.upsert_request(_row("old", prompt="alpha", age_s=7200))
    store.upsert_request(_row("new", prompt="alpha", age_s=60))
    r = store.search_requests(q="alpha", ts_from=now - 3600)
    assert [h["id"] for h in r["results"]] == ["new"]
    r2 = store.search_requests(q="alpha", ts_to=now - 3600)
    assert [h["id"] for h in r2["results"]] == ["old"]
    # boundary-inclusive
    r3 = store.search_requests(q="alpha", ts_from=now - 60, ts_to=now + 10)
    assert [h["id"] for h in r3["results"]] == ["new"]


def test_like_escaping_literal(store):
    store.upsert_request(_row("e1", prompt="100% pure_value here"))
    store._has_fts = False
    assert [h["id"] for h in store.search_requests(q="100%")["results"]] == ["e1"]
    # '_' must not act as single-char wildcard: 'pure-value' != 'pure_value'
    assert store.search_requests(q="pure-value")["results"] == []
    # a bare '%' matches only rows that literally contain one
    store.upsert_request(_row("e2", prompt="fifty percent sign: % end"))
    ids = [h["id"] for h in store.search_requests(q="%")["results"]]
    assert set(ids) == {"e1", "e2"}


def test_scan_mode_and_model_filter(store):
    store.upsert_request(_row("m1", model="alpha-model"))
    store.upsert_request(_row("m2", model="beta-model"))
    r = store.search_requests(model="alpha-model")
    assert r["mode"] == "scan"
    assert [h["id"] for h in r["results"]] == ["m1"]


def test_purge_removes_fts_rows(store):
    store.upsert_request(_row("p1", prompt="temporary phrase", age_s=3 * 86400))
    assert store.search_requests(q="temporary phrase")["results"]
    store.purge(log_days=2)
    assert store.search_requests(q="temporary phrase")["results"] == []
    # and the data row itself is gone from LIKE mode too (no phantom hits)
    store._has_fts = False
    assert store.search_requests(q="temporary phrase")["results"] == []


def test_fts_query_never_raises_on_junk():
    for raw in ('quick', 'a "b"', 'AND OR NOT', 'x* y~',
                'uni\u00e9\u010d 100%', 'phr"ase with "quotes'):
        store_q = fts_query(raw)
        assert isinstance(store_q, str) and store_q          # usable MATCH
    # PUNCT-1: punctuation-only / empty inputs have nothing FTS can match;
    # fts_query says None so the caller answers with LIKE instead.
    for raw in ('"', '', '   ', ')))(((', '\\', '%'):
        assert fts_query(raw) is None, raw


def test_punctuation_query_answers_via_like(store):
    """PUNCT-1: a backslash in the query poisoned the FTS AND-chain (0 hits
    even for queries whose words matched). Now: punctuation tokens are
    dropped from MATCH; all-punctuation queries go to LIKE."""
    store.upsert_request(_row("pu1", prompt="path C:\\tmp\\x probe token",
                              age_s=40))
    # mixed query: words drive MATCH, punctuation token no longer poisons it
    res = store.search_requests(q="probe token", limit=10)
    assert res["mode"] == "fts" and len(res["results"]) == 1
    # same words + backslash-bearing tokens: word chars let MATCH proceed
    # (punctuation inside a token is tokenized away, not poison)
    res = store.search_requests(q="probe token C:\\tmp\\x", limit=10)
    assert [r["id"] for r in res["results"]] == ["pu1"]
    # punctuation-ONLY query: LIKE substring answer, not a false 'no match'
    res = store.search_requests(q="\\", limit=10)
    assert res["mode"] == "like"
    assert [r["id"] for r in res["results"]] == ["pu1"]


def test_backfill_indexes_pre_fts_rows(tmp_path):
    """SEARCH-1: rows written before request_fts existed must become
    searchable after a reopen (one-time backfill at init)."""
    p = tmp_path / "metrics.sqlite3"
    s = MetricsStore(path=p)
    s.upsert_request(_row("old1", prompt="legacy ALPHA record", age_s=8000))
    # simulate the pre-RL-3 state: data rows present, index empty
    with s._lock, s._conn:
        s._conn.execute("DELETE FROM request_fts")
        s._conn.execute("DELETE FROM meta WHERE key='fts_backfilled'")
    s.close()

    s2 = MetricsStore(path=p)          # boot performs the backfill
    assert s2._has_fts
    res = s2.search_requests(q="ALPHA", limit=10)
    assert res["mode"] == "fts"
    assert [r["id"] for r in res["results"]] == ["old1"]

    # idempotent: second reopen must not duplicate index entries
    s2.close()
    s3 = MetricsStore(path=p)
    n = s3._conn.execute(
        "SELECT count(*) FROM request_fts WHERE id='old1'").fetchone()[0]
    assert n == 1, "backfill duplicated entries"
    # and text-less rows stay out of the index (matches _fts_sync policy)
    s3.upsert_request(_row("bare", prompt=None, output=None, age_s=10))
    n_bare = s3._conn.execute(
        "SELECT count(*) FROM request_fts WHERE id='bare'").fetchone()[0]
    assert n_bare == 0
    s3.close()


def test_sparse_upsert_never_blanks_index(store):
    """SEARCH-1b: a later upsert with no text (harvest pass, drained
    collector) must not wipe the already-indexed prompt."""
    store.upsert_request(_row("sp1", prompt="GAMMA payload", age_s=200))
    # second pass: same id, no text at all (sparse finalize sample)
    store.upsert_request({"id": "sp1", "model": "m", "state": "complete",
                          "prompt_tokens": 1, "completion_tokens": 9,
                          "tps": 12.0, "error": None,
                          "ts_start": time.time() - 190,
                          "ts_end": time.time() - 180})
    res = store.search_requests(q="GAMMA", limit=10)
    assert res["mode"] == "fts"
    assert [r["id"] for r in res["results"]] == ["sp1"]
    # empty-string harvest is equally harmless (NULLIF treats '' as "no
    # new text", the data path and index both keep the earlier capture)
    store.upsert_request(_row("sp1", prompt="", output="", age_s=100))
    res = store.search_requests(q="GAMMA", limit=10)
    assert [r["id"] for r in res["results"]] == ["sp1"]


def test_boot_repairs_blank_index_pairs(tmp_path):
    """SEARCH-1c: legacy rows whose index pair is blank but whose data row
    carries text get repaired at boot even after the one-time backfill."""
    p = tmp_path / "metrics.sqlite3"
    s = MetricsStore(path=p)
    s.upsert_request(_row("br1", prompt="OMEGA text in row", age_s=300))
    with s._lock, s._conn:
        s._conn.execute(
            "UPDATE request_fts SET prompt='', output='' WHERE id='br1'")
    s.close()
    s2 = MetricsStore(path=p)
    res = s2.search_requests(q="OMEGA", limit=10)
    assert res["mode"] == "fts"
    assert [r["id"] for r in res["results"]] == ["br1"]
    s2.close()


def test_cjk_query_routes_to_like(store):
    """CJK-1: unicode61 indexes a CJK run as one token; substring queries
    must still find the row (LIKE path), never silently return nothing."""
    store.upsert_request(_row("cj1", prompt="今天天气很好，请简单回复。",
                              age_s=60))
    for q in ("天气", "天气很好", "很好"):
        res = store.search_requests(q=q, limit=10)
        assert res["mode"] == "like", q
        assert [r["id"] for r in res["results"]] == ["cj1"], q
    # mixed CJK+ASCII also routes to LIKE (substring truth wins over a
    # guaranteed-MISS MATCH)
    store.upsert_request(_row("cj2", prompt="hello 世界 world", age_s=50))
    res = store.search_requests(q="世界 hello", limit=10)
    assert res["mode"] == "like"
    assert [r["id"] for r in res["results"]] == ["cj2"]
    # pure-ASCII queries keep the FTS path
    res = store.search_requests(q="hello", limit=10)
    assert res["mode"] == "fts"
