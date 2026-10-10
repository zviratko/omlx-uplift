# SPDX-License-Identifier: Apache-2.0
"""ZOMBIE-1 (user 2026-10-10: 'I see requests in queued state after
restart, historical ones, no activity').

Two defects let non-terminal rows survive into history as fake 'live'
requests:
1. request_log.sample() dropped stale active rows WITHOUT a terminal
   update — the store kept whatever state was last written ('queued'),
   the collector persists from the ring, and the feed painted the row as
   active after every restart (42-h-old row, live proof in the user DB).
2. The store never repaired rows its writer process had abandoned.

Fixes: the stale-drop path now persists an honest terminal (error /
'interrupted (engine gone)', _tick_final = resurrectable), and every
store open repairs non-terminal rows untouched for >15 min (no live
process can leave a row that stale — the collector re-upserts changed
rows each tick).
"""

import time
from types import SimpleNamespace

from omlx_uplift.request_log import ACTIVE_STALE_S, RequestTracker
from omlx_uplift.store import MetricsStore


def _req(rid, prompt=10, gen_at=None, out=0):
    return SimpleNamespace(
        request_id=rid, num_prompt_tokens=prompt,
        generation_started_at=gen_at, num_output_tokens=out,
    )


class FakeScheduler:
    def __init__(self, waiting=None, running=None):
        self.waiting = waiting or []
        self.running = running or {}
        self.all = {r.request_id: r
                    for r in list(waiting or []) + list((running or {}).values())}

    def snapshot_for_admin(self):
        return {"running_by_id": dict(self.running), "waiting": list(self.waiting)}

    def get_request(self, rid):
        return self.all.get(rid)


def _pool(schedulers):
    entries = {
        mid: SimpleNamespace(engine=SimpleNamespace(_engine=None, scheduler=s))
        for mid, s in schedulers.items()
    }
    return SimpleNamespace(_entries=entries)


def test_stale_active_drop_persists_terminal_error_row():
    sched_a = FakeScheduler(running={"a1": _req("a1", gen_at=time.monotonic())})
    t = RequestTracker()
    t.sample(_pool({"ma": sched_a}))
    # backdate the row past the stale window, then sample with its model
    # gone entirely (not sampled -> the departed path says nothing about it;
    # the stale branch must finalize it honestly)
    t._active["a1"]["ts"] = time.time() - ACTIVE_STALE_S - 1
    t.sample(_pool({"mb": FakeScheduler()}))

    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert "a1" in rows, "the row must stay in the ring (persisted by the collector)"
    row = rows["a1"]
    assert row["state"] == "error", f"zombie must not survive as {row['state']!r}"
    assert "interrupted" in (row.get("error") or "")
    assert row.get("_tick_final") is True, "a guessed death stays resurrectable"
    assert row.get("started_at") and row.get("ended_at")


def test_recent_stale_candidate_is_left_alone():
    """The stale window is unchanged: a young row from an unsampled model
    keeps its live state (engine reload mid-flight is recoverable)."""
    sched_a = FakeScheduler(running={"a1": _req("a1", gen_at=time.monotonic())})
    t = RequestTracker()
    t.sample(_pool({"ma": sched_a}))
    t.sample(_pool({"mb": FakeScheduler()}))
    rows = {r["id"]: r for r in t.list_rows(limit=5)}
    assert rows["a1"]["state"] == "generating"


def test_store_boot_repairs_abandoned_nonterminal_rows(tmp_path):
    p = tmp_path / "metrics.sqlite3"
    s = MetricsStore(path=p)
    now = time.time()
    # ended_at rides the row dict: upsert's ts_end fallback is WRITE time,
    # so an abandoned row's ts_end is its last-update stamp (RETENTION-1
    # liveness clock) — 42 h old means "nobody touched it since"
    s.upsert_request({"id": "z-old", "model": "m", "state": "queued",
                      "started_at": now - 42 * 3600, "ended_at": now - 42 * 3600})
    s.upsert_request({"id": "z-fresh", "model": "m", "state": "generating",
                      "started_at": now - 60, "ts": now - 60})
    s.close()

    s2 = MetricsStore(path=p)   # boot repair runs in _init_schema
    old = s2.request_by_id("z-old")
    assert old["state"] == "error"
    assert "interrupted" in (old["error"] or "")
    assert old["ts_end"], "a repaired row must carry an end stamp for purge/stats"
    fresh = s2.request_by_id("z-fresh")
    assert fresh["state"] == "generating", "a live session's rows are untouched"
    s2.close()
