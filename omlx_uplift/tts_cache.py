"""VOICE-16b: the chat audio cache — synthesized speech owned by a bubble.

Why: the chat player rows must replay without waking a TTS model, and the
user's rule is that audio lives exactly as long as the bubble it belongs to:
delete a bubble (or the chat) and its audio goes with it.

Layout (all under the canonical shared uplift store, DEV-6):

    <store>/tts_cache/index.json     the only directory; audio never leaves
    <store>/tts_cache/<sha1>.<ext>   one file per (voice, text) pair

A file is named by a hash of the SYNTHESIS PARAMETERS, not of the message, so
the same sentence spoken by the same voice is stored once and re-used by every
bubble that contains it. Ownership is the other half: `owners[conv][msg]`
lists the keys that bubble's plan used, which is what makes deletion, pruning
and the orphan sweep possible at all.

`rev` is the plan revision. A bubble that was edited (or re-chunked after an
upgrade) sends a new rev with its next synth batch; the server then forgets the
old rev's keys for that bubble instead of leaving text that no longer exists
behind. That is also why the sweep never has to re-derive chunk texts.

Nothing here trusts the client strings: conv/msg/rev are validated to short
safe tokens and are used ONLY as JSON keys — never as a path. File names come
from hashlib, so a request cannot steer a write outside the cache dir.

Caps (stated, not invented): one entry 8 MiB, the whole cache 512 MiB with
least-recently-used eviction past that, index 4 MiB. LRU eviction can drop
audio for a bubble that still exists; the row then simply re-synthesizes,
which is the same path a cache miss takes.

Concurrency: uplift runs as ONE uvicorn worker (same assumption as
routers/chat.py, routers/patches.py); a process-local lock covers the
read-modify-write of the index.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

MAX_ENTRY_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_INDEX_BYTES = 4 * 1024 * 1024
TOKEN_CHARS = 64                      # conv / msg / rev length cap

_EXT = {
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/opus": "opus",
    "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a",
}
_KEY_RE = re.compile(r"^[0-9a-f]{40}$")
_lock = threading.Lock()


def cache_dir() -> Path:
    from . import paths
    return paths.uplift_store_dir() / "tts_cache"


def _index_path() -> Path:
    return cache_dir() / "index.json"


def _empty() -> dict:
    return {"version": 1, "files": {}, "owners": {}}


def _load() -> dict:
    p = _index_path()
    try:
        d = json.loads(p.read_text())
        if (isinstance(d, dict) and isinstance(d.get("files"), dict)
                and isinstance(d.get("owners"), dict)):
            return d
    except Exception:
        pass
    return _empty()


def _save(store: dict) -> None:
    d = cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    p = _index_path()
    tmp = p.with_suffix(".json.tmp")
    data = json.dumps(store, ensure_ascii=False)
    if len(data.encode()) > MAX_INDEX_BYTES:
        _evict(store, MAX_TOTAL_BYTES // 2)      # index pressure: free audio
        data = json.dumps(store, ensure_ascii=False)
    tmp.write_text(data)
    os.replace(tmp, p)


def token(raw, field: str = "id") -> str:
    """Client-supplied identity → a short safe token, or '' when junk.

    Tokens are JSON keys only, but they still pass through here so a store
    file can never be polluted with markup or megabytes of text.
    """
    s = str(raw if raw is not None else "").strip()
    if not s or len(s) > TOKEN_CHARS:
        return ""
    if any(ch in s for ch in "<>\"'\\/"):
        return ""
    return s


def key_for(voice: str, text: str, speed=None, language=None,
            model=None, instructions=None, ref_text=None) -> str:
    """Identity of a synthesis: what a byte-for-byte replay must match."""
    parts = [str(voice or ""), str(text or ""), str(speed or ""),
             str(language or ""), str(model or ""), str(instructions or ""),
             str(ref_text or "")]
    return hashlib.sha1("\x1f".join(parts).encode("utf-8", "replace")).hexdigest()


def _ext_for(media_type: str) -> str:
    return _EXT.get((media_type or "").split(";")[0].strip().lower(), "bin")


def _find_file(store: dict, key: str) -> Optional[str]:
    entry = store["files"].get(key)
    if not entry:
        return None
    name = str(entry.get("name") or "")
    return name or None


def get(key: str) -> Optional[Tuple[bytes, str]]:
    """Cached bytes for a synthesis key, or None (a miss is not an error)."""
    if not _KEY_RE.match(key or ""):
        return None
    with _lock:
        store = _load()
        name = _find_file(store, key)
        if not name:
            return None
        p = cache_dir() / name
        try:
            data = p.read_bytes()
        except OSError:
            # the file vanished under us: forget the row, report a miss
            store["files"].pop(key, None)
            _prune_owner_refs(store)
            _save(store)
            return None
        entry = store["files"][key]
        entry["at"] = int(time.time() * 1000)          # LRU touch
        _save(store)
    return data, str(entry.get("media_type") or "audio/wav")


def put(key: str, body: bytes, media_type: str,
        owner: Optional[dict] = None) -> bool:
    """Store one synthesized chunk. `owner` = {conv, msg, rev} (may be None:
    an unowned entry is legal and is what the sweep later reports)."""
    if not _KEY_RE.match(key or "") or not body or len(body) > MAX_ENTRY_BYTES:
        return False
    owner = owner or {}
    conv, msg = token(owner.get("conv"), "conv"), token(owner.get("msg"), "msg")
    rev = token(owner.get("rev"), "rev") or "0"
    name = "%s.%s" % (key, _ext_for(media_type))
    with _lock:
        store = _load()
        replaced = _claim_owner(store, conv, msg, rev, key)
        if key in store["files"]:
            # the bytes are already here (this bubble or another one quoted the
            # same sentence): the ownership move still has to be written
            _release(store, replaced)
            _save(store)
            return True
        d = cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        p = d / name
        try:
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, p)
        except OSError:
            return False
        store["files"][key] = {"name": name, "media_type": media_type,
                               "bytes": len(body), "voice": str(owner.get("voice") or ""),
                               "at": int(time.time() * 1000)}
        _release(store, replaced)              # the bubble's previous take is done
        _evict(store, MAX_TOTAL_BYTES)
        _save(store)
    return True


def _claim_owner(store: dict, conv: str, msg: str, rev: str, key: str) -> list:
    """Attach `key` to a bubble and report the keys this SUPERSEDES.

    An edited bubble re-plans with a new rev: its previous chunk keys are
    returned here so the caller can release them (a file another bubble quotes
    the same way survives). Returns [] when nothing was replaced.
    """
    if not conv or not msg:
        return []
    msgs = store["owners"].setdefault(conv, {})
    held = msgs.get(msg)
    if isinstance(held, dict) and str(held.get("rev") or "0") == rev:
        keys = msgs[msg].setdefault("keys", [])
        if key not in keys:
            keys.append(key)
        return []
    replaced = [k for k in ((held or {}).get("keys") or []) if k != key] \
        if isinstance(held, dict) else []
    msgs[msg] = {"rev": rev, "keys": [key]}
    return replaced


def _release(store: dict, keys: list) -> int:
    """Drop files no bubble quotes any more; keeps bytes honest."""
    freed = 0
    for key in keys or []:
        freed += _drop_if_last_ref(store, key, "", "")
    _prune_owner_refs(store)
    return freed


def _referenced(store: dict) -> set:
    out = set()
    for msgs in store["owners"].values():
        if not isinstance(msgs, dict):
            continue
        for held in msgs.values():
            if isinstance(held, dict):
                out.update(held.get("keys") or [])
    return out


def _prune_owner_refs(store: dict) -> None:
    """Drop owned keys the index no longer knows, and empty owners."""
    refs = set(store["files"].keys())
    for conv in list(store["owners"].keys()):
        msgs = store["owners"][conv]
        if not isinstance(msgs, dict):
            del store["owners"][conv]
            continue
        for msg in list(msgs.keys()):
            held = msgs[msg]
            if not isinstance(held, dict):
                del msgs[msg]
                continue
            held["keys"] = [k for k in (held.get("keys") or []) if k in refs]
            if not held["keys"]:
                del msgs[msg]
        if not msgs:
            del store["owners"][conv]


def _drop_file(store: dict, key: str) -> int:
    entry = store["files"].pop(key, None)
    if not entry:
        return 0
    try:
        (cache_dir() / str(entry.get("name") or "")).unlink()
    except OSError:
        pass
    return int(entry.get("bytes") or 0)


def _evict(store: dict, cap: int) -> int:
    """Least-recently-used eviction past `cap`. Returns bytes freed.

    Only UNOWNED entries go first; if the cache is still over cap with every
    file owned by a live bubble, the oldest owned entries give way too —
    a bubble losing cached audio only costs a re-synthesis on replay.
    """
    total = sum(int(e.get("bytes") or 0) for e in store["files"].values())
    if total <= cap:
        return 0
    refs = _referenced(store)
    order = sorted(store["files"].items(),
                   key=lambda kv: (kv[0] in refs, kv[1].get("at") or 0))
    freed = 0
    for key, _entry in order:
        if total - freed <= cap:
            break
        freed += _drop_file(store, key)
    _prune_owner_refs(store)
    return freed


# ---- lifecycle hooks called by the chat router ---------------------------

def prune_conversation(conv: str, mids: List[str], revs: Optional[dict] = None) -> int:
    """A conversation was saved: bubbles that are gone take their audio.

    `mids` is the set of message ids the saved conversation still has.
    A bubble whose plan revision moved (an edit re-plans on the next speak,
    the rev rides in the saved plan) is dropped here too, so the client never
    has to send a delete for it.
    """
    conv = token(conv)
    if not conv:
        return 0
    keep = {token(m) for m in mids if token(m)}
    with _lock:
        store = _load()
        msgs = store["owners"].get(conv)
        if not isinstance(msgs, dict):
            return 0
        freed = 0
        for msg in list(msgs.keys()):
            held = msgs[msg]
            want = (revs or {}).get(msg)
            if msg not in keep or (want and isinstance(held, dict)
                                   and str(held.get("rev") or "0") != str(want)):
                for key in (held.get("keys") or []) if isinstance(held, dict) else []:
                    freed += _drop_if_last_ref(store, key, conv, msg)
                msgs.pop(msg, None)
        if not msgs:
            store["owners"].pop(conv, None)
        _prune_owner_refs(store)
        _save(store)
    return freed


def _drop_if_last_ref(store: dict, key: str, conv: str, msg: str) -> int:
    """Delete a file only when no OTHER bubble still lists it.

    Pass conv='' / msg='' to release a key that was ALREADY removed from the
    owner map (the revision-replacement path)."""
    for c, msgs in store["owners"].items():
        if not isinstance(msgs, dict):
            continue
        for m, held in msgs.items():
            if c == conv and m == msg:
                continue
            if isinstance(held, dict) and key in (held.get("keys") or []):
                return 0
    return _drop_file(store, key)


def drop_conversation(conv: str) -> int:
    """A chat was deleted: everything it owned goes, now."""
    conv = token(conv)
    if not conv:
        return 0
    with _lock:
        store = _load()
        msgs = store["owners"].pop(conv, None)
        freed = 0
        for held in (msgs or {}).values() if isinstance(msgs, dict) else []:
            for key in (held.get("keys") or []) if isinstance(held, dict) else []:
                freed += _drop_if_last_ref(store, key, conv, "")
        _prune_owner_refs(store)
        _save(store)
    return freed


def note_deleted_message(conv: str, msg: str) -> int:
    """One bubble deleted (cheaper than waiting for the next save)."""
    conv, msg = token(conv), token(msg)
    if not conv or not msg:
        return 0
    with _lock:
        store = _load()
        held = (store["owners"].get(conv) or {}).pop(msg, None)
        freed = 0
        for key in (held or {}).get("keys") or []:
            freed += _drop_if_last_ref(store, key, conv, msg)
        _prune_owner_refs(store)
        _save(store)
    return freed


# ---- the sweep (Check / Cleanup audio cache) -----------------------------

def totals() -> dict:
    with _lock:
        store = _load()
        return {"files": len(store["files"]),
                "bytes": sum(int(e.get("bytes") or 0)
                             for e in store["files"].values()),
                "conversations": len(store["owners"]),
                "bubbles": sum(len(m) for m in store["owners"].values()
                               if isinstance(m, dict))}


def check(live: Optional[Dict[str, List[str]]] = None) -> dict:
    """Classify what is on disk against the conversations that still exist.

    `live` maps conversation id -> the message ids it currently holds
    (the caller reads the chat store; this module never does, so no import
    cycle with routers/chat.py). Passing None skips the chat-side classes and
    reports only the storage-side ones.
    """
    with _lock:
        store = _load()
        d = cache_dir()
        on_disk = {p.name for p in d.glob("*") if p.is_file()
                   and not p.name.endswith(".tmp")} if d.is_dir() else set()
        refs = _referenced(store)
        out = {"files": len(store["files"]), "bytes": 0,
               "disk_files": len(on_disk), "conversations": len(store["owners"]),
               "orphans": {}}
        for e in store["files"].values():
            out["bytes"] += int(e.get("bytes") or 0)
        gone_conv: Dict[str, dict] = {}
        for key, entry in store["files"].items():
            nb = {"count": 0, "bytes": 0}
            name = str(entry.get("name") or "")
            size = int(entry.get("bytes") or 0)
            if name not in on_disk:
                _tally(gone_conv, "missing_file", size)
            elif key not in refs:
                _tally(gone_conv, "unowned", size)
        # owner rows the index cannot back any more, or that no chat owns
        for conv, msgs in store["owners"].items():
            if not isinstance(msgs, dict):
                continue
            for msg, held in msgs.items():
                if not isinstance(held, dict):
                    continue
                for key in held.get("keys") or []:
                    if key not in store["files"]:
                        _tally(gone_conv, "missing_file", 0)
            if live is None:
                continue
            if conv not in live:
                _tally(gone_conv, "chat_gone",
                       sum(int((store["files"].get(k) or {}).get("bytes") or 0)
                           for m in msgs.values() if isinstance(m, dict)
                           for k in (m.get("keys") or [])))
                continue
            keep = set(live[conv])
            for msg, held in msgs.items():
                if isinstance(held, dict) and msg not in keep:
                    _tally(gone_conv, "bubble_gone",
                           sum(int((store["files"].get(k) or {}).get("bytes") or 0)
                               for k in (held.get("keys") or [])))
        # files the index never heard of
        named = {str(e.get("name") or "") for e in store["files"].values()}
        stray_bytes = 0
        stray_count = 0
        for name in on_disk - named - {"index.json"}:
            try:
                stray_bytes += (d / name).stat().st_size
            except OSError:
                pass
            stray_count += 1
        if stray_count:
            gone_conv["stray_file"] = {"count": stray_count, "bytes": stray_bytes}
        out["orphans"] = gone_conv
        out["orphan_files"] = sum(v["count"] for v in gone_conv.values())
        out["orphan_bytes"] = sum(v["bytes"] for v in gone_conv.values())
        return out


def _tally(into: dict, kind: str, size: int) -> None:
    row = into.setdefault(kind, {"count": 0, "bytes": 0})
    row["count"] += 1
    row["bytes"] += int(size or 0)


def cleanup(live: Optional[Dict[str, List[str]]] = None) -> dict:
    """Delete what check() would report. Returns the same shape plus freed."""
    before = check(live)
    with _lock:
        store = _load()
        d = cache_dir()
        refs = _referenced(store)
        freed = 0
        count = 0
        # 1. index rows whose file is gone, and rows nobody owns
        for key in list(store["files"].keys()):
            entry = store["files"][key]
            name = str(entry.get("name") or "")
            if key not in refs:
                freed += _drop_file(store, key)
                count += 1
            elif not (d / name).is_file():
                store["files"].pop(key, None)
                count += 1
        # 2. owners the chat store no longer has
        if live is not None:
            for conv in list(store["owners"].keys()):
                msgs = store["owners"][conv]
                if conv not in live or not isinstance(msgs, dict):
                    for held in (msgs or {}).values() if isinstance(msgs, dict) else []:
                        for key in (held.get("keys") or []) if isinstance(held, dict) else []:
                            freed += _drop_if_last_ref(store, key, conv, "")
                    store["owners"].pop(conv, None)
                    count += 1
                    continue
                keep = set(live[conv])
                for msg in list(msgs.keys()):
                    if msg in keep:
                        continue
                    held = msgs[msg]
                    for key in (held.get("keys") or []) if isinstance(held, dict) else []:
                        freed += _drop_if_last_ref(store, key, conv, msg)
                    msgs.pop(msg, None)
                    count += 1
        # 3. files on disk with no index row
        named = {str(e.get("name") or "") for e in store["files"].values()}
        if d.is_dir():
            for p in list(d.glob("*")):
                if not p.is_file() or p.name == "index.json":
                    continue
                if p.name in named:
                    continue
                try:
                    freed += p.stat().st_size
                    p.unlink()
                    count += 1
                except OSError:
                    pass
        _prune_owner_refs(store)
        _save(store)
    after = totals()
    return {"removed": count, "freed": freed, "before": before,
            "files": after["files"], "bytes": after["bytes"]}


def clear_all() -> dict:
    """Operator escape hatch: drop the whole cache (no chat is touched)."""
    with _lock:
        store = _load()
        freed = sum(_drop_file(store, k) for k in list(store["files"].keys()))
        store["owners"] = {}
        _save(store)
    return {"freed": freed}
