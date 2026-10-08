"""U64: bench run history — every surface keeps its results until cleared.

Scope split (grounded in code, card U64):
- accuracy / embed / decision already ACCUMULATE across runs (classic's
  in-memory list / accumulated.json); accuracy's list was the only one that
  died with the process. accuracy_engine persists it to this store now.
- throughput / context / ANE produce ONE run's result each; classic keeps
  runs only in memory. This module snapshots a finished run as one history
  entry (keyed by bench/tuning id, so repeated polls of the same run are
  idempotent writes).

Storage: ~/.omlx/uplift/bench-history/<surface>/history.json (atomic-ish
write-through; JSON list, newest appended last). Entry shapes stay the
raw engine result rows plus a small header the UI renders:
    {"id", "surface", "kind": "run", "model_id", "ts", "status", "meta":
     {...run parameters...}, "rows": [...engine result dicts...]}

The file is the user's data: DELETE history/<surface> clears ONE surface,
and a restart NEVER discards entries (that was the whole complaint).
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Optional

from . import paths

logger = logging.getLogger("omlx.uplift.history")

_lock = threading.Lock()

# surfaces captured per-run (one entry per benchmark run)
RUN_SURFACES = ("throughput", "context", "ane")
# surfaces whose per-row accumulation lives in classic memory (accuracy)
ACC_SURFACES = ("accuracy",)
ALL_SURFACES = RUN_SURFACES + ACC_SURFACES


def root() -> Path:
    return paths.uplift_store_dir() / "bench-history"


def _file(surface: str) -> Path:
    if surface not in ALL_SURFACES:
        raise ValueError(f"unknown history surface: {surface}")
    return root() / surface / "history.json"


def load(surface: str) -> list[dict]:
    try:
        data = json.loads(_file(surface).read_text())
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception as e:                       # corrupt file: keep a copy
        p = _file(surface)
        try:
            p.rename(p.with_suffix(".corrupt"))
            logger.warning(f"bench history {surface}: corrupt file moved "
                           f"aside ({e})")
        except Exception:
            pass
        return []


def _save(surface: str, entries: list[dict]) -> None:
    f = _file(surface)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(entries, indent=1))
    tmp.replace(f)


def upsert_run(surface: str, entry: dict) -> None:
    """Idempotent capture: same id replaces its older snapshot (a run's
    result grows while it streams; the terminal shape wins)."""
    eid = str(entry.get("id") or "")
    if not eid:
        return
    with _lock:
        entries = load(surface)
        for i, e in enumerate(entries):
            if str(e.get("id")) == eid:
                entries[i] = entry
                break
        else:
            entries.append(entry)
        _save(surface, entries)


def capture_run(run: Any) -> None:
    """Duck-typed snapshot of one classic run object (shared by the three
    run-shaped surfaces; the same run may be captured repeatedly — upsert
    by id keeps it idempotent). Never raises: history is an affordance."""
    import time as _t
    try:
        if hasattr(run, "tuning_id"):                      # ane_tuning run
            surface = "ane"
            eid = str(run.tuning_id)
            meta = {"sequence_length": getattr(run.request, "sequence_length", None)}
            # classic's run_snapshot strips underscore-private keys; match it
            rows = [{k: v for k, v in r.items() if not k.startswith("_")}
                    for r in (getattr(run, "results", None) or [])
                    if isinstance(r, dict)]
            rec = getattr(run, "recommendation", None)
        elif hasattr(run.request, "target_tokens"):        # context run
            rec = None
            surface = "context"
            eid = str(run.bench_id)
            meta = {"target_tokens": run.request.target_tokens}
            rows = [run.result] if getattr(run, "result", None) else []
        else:                                              # throughput run
            rec = None
            surface = "throughput"
            eid = str(run.bench_id)
            meta = {"context_profile": run.request.context_profile.value,
                    "external": run.request.external is not None}
            rows = list(getattr(run, "results", None) or [])
        entry = {"id": eid, "surface": surface, "kind": "run",
                 "model_id": run.request.model_id,
                 "status": getattr(run, "status", "running"),
                 "ts": int(_t.time()),
                 "meta": meta, "rows": _finite(rows)}
        if rec is not None:
            entry["recommendation"] = _finite(rec)
        upsert_run(surface, entry)
    except Exception as e:
        logger.warning(f"bench history capture failed: {e}")


def _finite(v):
    import math
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


def entries(surface: str) -> dict:
    return {"entries": load(surface)}


def clear(surface: str) -> dict:
    with _lock:
        f = _file(surface)
        existed = f.exists()
        if existed:
            f.unlink()
    return {"status": "cleared", "surface": surface, "removed": existed}


# ---- accuracy write-through ------------------------------------------------

def acc_persist(rows: list[dict]) -> None:
    """Store classic's accumulated accuracy rows verbatim (they already
    include question_results; personal-server scale, honest payload).
    Empty list = no store file (Clear semantics, no empty litter)."""
    with _lock:
        if not rows:
            f = _file("accuracy")
            if f.exists():
                f.unlink()
            return
        _save("accuracy", [{"id": f"acc-{i}", "surface": "accuracy",
                            "kind": "row", **r}
                           for i, r in enumerate(rows)])


def acc_restore() -> list[dict]:
    out = []
    for e in load("accuracy"):
        r = {k: v for k, v in e.items()
             if k not in ("id", "surface", "kind")}
        out.append(r)
    return out


# ---- restart reconciliation -------------------------------------------------

def reconcile_interrupted(active_ids: Optional[dict[str, Optional[str]]] = None) -> None:
    """Called at router import AFTER the new process's classic modules are
    fresh: a stored run still 'running' can only mean the server died
    mid-run. Label it cancelled honestly (the UI must not poll a ghost,
    and Copy must not claim a result that never completed)."""
    live = active_ids or {}
    changed = False
    with _lock:
        for surface in RUN_SURFACES:
            entries_ = load(surface)
            for e in entries_:
                if e.get("status") == "running" and \
                        str(e.get("id")) != str(live.get(surface) or ""):
                    e["status"] = "interrupted"
                    changed = True
            if changed:
                _save(surface, entries_)
                changed = False
