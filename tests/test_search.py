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
    for raw in ('quick', 'a "b"', 'AND OR NOT', 'x* y~', '"', '', '   ',
                'uni\u00e9\u010d 100%', ')))(((', 'phr"ase with "quotes'):
        store_q = fts_query(raw)
        assert isinstance(store_q, str) and store_q          # always usable
