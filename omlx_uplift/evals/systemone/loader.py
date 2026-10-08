"""REPL-4c: System-1 decision-model task pack loader.

Pinned JSON fixtures (extract once via scripts/extract_systemone_packs.py,
offline-first per the card): the runtime NEVER touches the network and
needs no `datasets` install — just json + hashlib from the stdlib.

Integrity: manifest.json carries a sha256 per pack; a file that does not
match its digest is refused (an eval pack silently mutated by a stray
script is the worst failure mode for a benchmark).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"


class PackError(Exception):
    """Fixture missing/corrupt — message is user-displayable."""


def manifest() -> dict[str, Any]:
    try:
        return json.loads((DATA_DIR / "manifest.json").read_text())
    except FileNotFoundError as e:
        raise PackError("decision task pack manifest missing "
                        "(is omlx_uplift/evals/systemone/data shipped?)") from e
    except json.JSONDecodeError as e:
        raise PackError(f"decision task pack manifest is not valid JSON: {e}") from e


def load_pack(name: str) -> dict[str, Any]:
    """One pack: {name, license, source, items:[{id,state,options,answer}]}."""
    mf = manifest()
    spec = mf.get("packs", {}).get(name)
    if spec is None:
        raise PackError(f"unknown decision pack: {name}")
    f = DATA_DIR / f"{name}.json"
    if not f.is_file():
        raise PackError(f"decision pack file missing: {name}.json")
    raw = f.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != spec.get("sha256"):
        raise PackError(f"decision pack {name}: sha256 mismatch "
                        f"(pinned {str(spec.get('sha256'))[:12]}…, "
                        f"file {digest[:12]}…) — refusing to score against "
                        "an unpack that changed under the bench")
    try:
        pack = json.loads(raw)
    except json.JSONDecodeError as e:
        raise PackError(f"decision pack {name}: invalid JSON: {e}") from e
    items = pack.get("items")
    if not isinstance(items, list) or not items:
        raise PackError(f"decision pack {name}: no items")
    return pack


def packs_summary() -> dict[str, dict[str, Any]]:
    """Task grid payload: per-pack provenance + item count (no full load)."""
    out = {}
    for name, spec in manifest().get("packs", {}).items():
        out[name] = {"source": spec.get("source"),
                     "license": spec.get("license"),
                     "items": spec.get("items"),
                     "sha256": spec.get("sha256")}
    return out
