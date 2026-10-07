"""NAT-3: kill-switch for the native Bench/Chat surfaces (NAT batch).

The branch `feat/native-bench-chat` ships native replacements for the two
embedded classic surfaces (Bench tabs, Chat tab). Until NAT-5 cutover, the
embed path must stay byte-identical by default, so the switch lives in ONE
place with three inputs, evaluated in this order:

  1. URL parameter  ?native=off|bench|chat|all   (per-viewer, wins over all)
  2. server config  ~/.omlx/uplift/config.json {"uplift_native_surfaces": ...}
  3. default        "off"

Values: off | bench | chat | all. Anything unrecognized falls back to "off"
(fail toward the shipped embed path, never toward an unfinished surface).

Frontend: index.html carries the resolved value as
`<html data-native-surfaces="...">` — substituted by the page router at
serve time (the flag is per-INSTANCE config, so it cannot be baked into the
static file; a literal token is replaced in the already-no-store index HTML).
"""
from __future__ import annotations

import json
from pathlib import Path

from . import paths

VALID = ("off", "bench", "chat", "all")
CONFIG_KEY = "uplift_native_surfaces"


def config_path() -> Path:
    return paths.uplift_store_dir() / "config.json"


def read_config() -> dict:
    try:
        raw = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def write_config(value: str) -> dict:
    """Persist the flag; returns the config dict after the write."""
    if value not in VALID:
        raise ValueError(f"invalid native-surfaces value {value!r} (want one of {VALID})")
    cfg = read_config()
    cfg[CONFIG_KEY] = value
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(p)
    return cfg


def server_value() -> str:
    v = read_config().get(CONFIG_KEY)
    return v if v in VALID else "off"


def resolve(url_param: str | None) -> str:
    """Effective mode for a request: URL param wins over server config."""
    if url_param in VALID:
        return url_param
    return server_value()


def enabled(mode: str, surface: str) -> bool:
    """Is a given native surface ('bench' | 'chat') on in this mode?"""
    return mode == "all" or mode == surface
