"""ENV-1: uplift-owned OMLX_* experimental tunables — the single source of truth.

Vanilla omlx reads a handful of scheduler/engine knobs from os.environ with
no settings.json entry. Uplift exposes a hard-coded allow-list of them in
the settings UI and persists values uplift-side in
``~/.omlx/uplift/env_overrides.json`` (next to metrics.sqlite3). At
interpreter startup ``autopatch`` seeds them into ``os.environ`` before any
omlx module reads them.

Precedence (the core rule):
  * A genuine launch-time environment variable (launchd plist, shell, CLI)
    ALWAYS wins. autopatch records such names in ``SHADOWED`` and never
    overwrites them.
  * Uplift-stored values fill only the gaps.

This module must stay import-safe at interpreter startup: stdlib only,
no omlx imports. The autopatch hook sets SHADOWED via :func:`mark_shadowed`
and stores the directory hint via :func:`set_base_dir`.

Effect classes (verified against vanilla read-points 2026-09-19, re-checked
against HEAD 2026-09-20 — the read sites below are the current lines):
  immediate -> read per call (os.environ at call time): live apply works.
  model     -> EngineConfig default_factory at engine construction: RESTART MODEL.
  server    -> module-import constants / startup config: RESTART SERVER.
NOT exposed (documented skips):
  OMLX_DECODE_BURST_BUDGET_SINGLE_S — vanilla burst_decode_mode writes the
      same var on every mode save (settings.py burst_decode_env());
      last-writer-wins collision.
  OMLX_MAX_NUM_SEQS — settings.py treats it as the env fallback for the
      already-exposed max_concurrent_requests; two fields would fight.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

OVERRIDES_FILENAME = "env_overrides.json"

# name -> spec. Keys here are the ONLY env vars the API accepts; unknown
# keys are rejected with 400 (this is not a free-form env editor).
ALLOWED: dict[str, dict] = {
    # -- class 1: CALL-TIME (effect=immediate) ------------------------------
    "OMLX_CHUNK_SNAP": {
        "type": "bool", "default": "1", "effect": "immediate", "group": "scheduler",
        "desc": "Quantize prefill chunk boundaries to fixed steps; 0 disables (A/B measurement).",
    },
    "OMLX_MTP_PROMPT_PRIMING": {
        "type": "bool", "default": "1", "effect": "immediate", "group": "mtp",
        "desc": "Prime MTP drafters from the prompt context.",
    },
    "OMLX_MTP_PRIME_WINDOW": {
        "type": "int", "default": "0", "effect": "immediate", "group": "mtp",
        "desc": "History window (tokens) MTP priming may use; 0 = unlimited.",
        "min": 0,
    },
    "OMLX_DISABLE_PRESSURE_RECLAIM": {
        "type": "bool", "default": "", "effect": "immediate", "group": "memory",
        "desc": "1 disables memory-pressure reclaim (restores stock behavior).",
    },
    # -- class 2: ENGINE-CONSTRUCTION (effect=model) -------------------------
    "OMLX_DECODE_BURST_BUDGET_S": {
        "type": "float", "default": "0.03", "effect": "model", "group": "engine",
        "desc": "Wall-clock budget (s) per burst-decode pass.",
        "min": 0.001, "max": 10.0,
    },
    "OMLX_DECODE_BURST_MAX_STEPS": {
        "type": "int", "default": "64", "effect": "model", "group": "engine",
        "desc": "Maximum decode steps per burst pass.",
        "min": 1, "max": 4096,
    },
    # -- class 3: MODULE-IMPORT (effect=server) ------------------------------
    "OMLX_DECODE_FAIR_SHARE": {
        "type": "float", "default": "0.5", "effect": "server", "group": "scheduler",
        "desc": "Fair share of decode slots per request before yielding.",
        "min": 0.0, "max": 1.0,
    },
    "OMLX_DECODE_STALL_TARGET_MS": {
        "type": "int", "default": "500", "effect": "server", "group": "scheduler",
        "desc": "Decode stall target (ms) that triggers scheduler rebalance.",
        "min": 1,
    },
    "OMLX_CONTENDED_PREFILL_CHUNK": {
        "type": "int", "default": "512", "effect": "server", "group": "scheduler",
        "desc": "Prefill chunk size (tokens) while decode is contended.",
        "min": 16,
    },
    # -- class 4: STARTUP-CONFIG (effect=server) -----------------------------
    "OMLX_CONTINUOUS_BATCHING": {
        "type": "bool", "default": "false", "effect": "server", "group": "engine",
        "desc": "Enable experimental continuous batching at startup.",
    },
}


# ---------------------------------------------------------------------------
# Shadow state (set once by autopatch at interpreter startup)
# ---------------------------------------------------------------------------

#: names that were ALREADY present in os.environ at startup (genuine launch
#: env). Their uplift-stored values are inert until the launch env changes.
SHADOWED: set[str] = set()


def mark_shadowed(name: str) -> None:
    SHADOWED.add(name)


def shadowed() -> list[str]:
    return sorted(SHADOWED)


# ---------------------------------------------------------------------------
# On-disk store: plain JSON, atomic writes, stdlib only
# ---------------------------------------------------------------------------

_BASE_DIR: Path | None = None


def set_base_dir(path) -> None:
    """Record the ~/.omlx/uplift dir discovered by autopatch (it cannot
    import omlx to resolve the base path itself)."""
    global _BASE_DIR
    if path is not None:
        _BASE_DIR = Path(path)


def overrides_path() -> Path:
    if _BASE_DIR is not None:
        return _BASE_DIR / OVERRIDES_FILENAME
    # Same resolution as store.default_db_path, without importing omlx at
    # module import time (router context: omlx is importable, use its state).
    base = None
    try:  # pragma: no cover - depends on live server state
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
    return base / "uplift" / OVERRIDES_FILENAME


def load_overrides(path: Path | None = None) -> dict[str, dict]:
    """Read {VAR: {\"value\": str, \"set_at\": iso}}. Missing/corrupt = {}."""
    p = path or overrides_path()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        if k in ALLOWED and isinstance(v, dict) and isinstance(v.get("value"), str):
            out[k] = {"value": v["value"], "set_at": str(v.get("set_at", ""))}
    return out


def save_overrides(data: dict[str, dict], path: Path | None = None) -> Path:
    """Persist atomically (tmp + rename in the same dir). Parent dirs created."""
    p = path or overrides_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".env_overrides.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p


# ---------------------------------------------------------------------------
# Validation + coercion
# ---------------------------------------------------------------------------

def coerce(name: str, value) -> str:
    """Validate one value against ALLOWED[name] and return its canonical
    env-string form. Raises ValueError on unknown name/type/range."""
    spec = ALLOWED.get(name)
    if spec is None:
        raise ValueError(f"unknown tunable: {name}")
    t = spec["type"]
    if isinstance(value, bool):
        s = "1" if value else "0"
    elif value is None:
        raise ValueError("value required")
    else:
        s = str(value).strip()
    if t == "bool":
        if s.lower() in ("1", "true", "yes", "on"):
            return "1"
        if s.lower() in ("0", "false", "no", "off"):
            return "0"
        if s == "":
            return ""  # store-side: means "no override" but keep shape stable
        raise ValueError(f"{name}: expected a boolean")
    if t == "int":
        try:
            n = int(s)
        except ValueError:
            raise ValueError(f"{name}: expected an integer") from None
    elif t == "float":
        try:
            n = float(s)
        except ValueError:
            raise ValueError(f"{name}: expected a number") from None
    else:
        return s
    if "min" in spec and n < spec["min"]:
        raise ValueError(f"{name}: minimum is {spec['min']}")
    if "max" in spec and n > spec["max"]:
        raise ValueError(f"{name}: maximum is {spec['max']}")
    return s


def seed_environ(path: Path | None = None) -> dict[str, str]:
    """Apply the precedence rule once at interpreter startup (autopatch).

    For every stored override: if the name is already in os.environ it is
    genuine launch env -> record as SHADOWED and leave untouched; otherwise
    write it into os.environ. Returns the vars actually seeded.

    Pure stdlib; missing/corrupt file is silently skipped. Never raises.
    """
    seeded: dict[str, str] = {}
    try:
        data = load_overrides(path)
    except Exception:  # belt and braces: startup hook must never crash omlx
        return seeded
    for name, entry in data.items():
        if name in os.environ:
            mark_shadowed(name)
            continue
        os.environ[name] = entry["value"]
        seeded[name] = entry["value"]
    return seeded


def mask(value: str) -> str:
    """First/last 2 chars only — env values can hold secrets."""
    if len(value) <= 4:
        return "•" * len(value)
    return value[:2] + "•" * (len(value) - 4) + value[-2:]


def snapshot() -> dict:
    """GET payload: current values (stored, or live env when shadowed),
    shadow list, and the allow-list spec for the UI."""
    stored = load_overrides()
    values = {}
    for name in ALLOWED:
        if name in stored:
            values[name] = stored[name]["value"]
    shadow = [
        {"name": n, "value_masked": mask(os.environ.get(n, ""))}
        for n in sorted(SHADOWED)
    ]
    allowed = [
        {"name": n, **{k: spec[k] for k in ("type", "default", "effect", "group", "desc") if k in spec},
         **{k: spec[k] for k in ("min", "max") if k in spec}}
        for n, spec in ALLOWED.items()
    ]
    return {"values": values, "shadowed": shadow, "allowed": allowed}
