"""Native Chat surface API — LIVE (NAT-4).

Design frozen in NAT-1 (out/NAT-1.*): deep-chat talks to public /v1/*
same-origin; uplift's own routes serve ONLY:

- GET  /chat/key          one-time API-key handout behind require_admin.
    Equal exposure surface to classic (omlx/admin/routes.py:1875 injects
    the same value into the chat template for every logged-in admin
    page); the native page needs it because deep-chat's request headers
    are built client-side. Never logged, never stored outside the
    caller's memory (+ classic's own localStorage key, same as classic).
- GET/POST /chat/history  conversation store (NAT-1 probe item 7
    verdict: SERVER store; localStorage 'omlx_chat_history' migrated by
    the client on first boot; both paths mirrored while classic lives —
    NAT-5 removes the mirror). JSON file under the uplift store; single
    writer is this process (uplift runs as one uvicorn worker — same
    assumption as the patch/policy stores).
- GET/DELETE /chat/history/{id}   open one conversation / drop one.

Size guards (all stated, none invented): 200 messages kept per
conversation, 48-char titles, 8 MB store file cap, conversations
capped at 200. History messages are plain {role, content} text parts —
image data URLs are stripped on save (classic keeps them; they blew the
localStorage quota — the server store must not repeat that; the chat UI
keeps showing the image in the live view).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import Depends, HTTPException, Request

from .base import api_router, require_admin

MAX_MESSAGES = 200
MAX_CONVOS = 200
MAX_STORE_BYTES = 8 * 1024 * 1024
TITLE_CHARS = 48


def store_path() -> Path:
    from .. import paths
    return paths.uplift_store_dir() / "chat_history.json"


def _load() -> dict:
    p = store_path()
    try:
        d = json.loads(p.read_text())
        if isinstance(d, dict) and isinstance(d.get("conversations"), dict):
            return d
    except Exception:
        pass
    return {"version": 1, "conversations": {}}


def _save(store: dict) -> None:
    p = store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(store, ensure_ascii=False)
    if len(text.encode()) > MAX_STORE_BYTES:
        raise HTTPException(status_code=507,
                            detail="chat history store is full; delete a "
                                   "conversation and retry")
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(text)
    tmp.replace(p)


def _clean_message(m: dict) -> dict:
    role = str(m.get("role") or "user")
    if role not in ("user", "assistant", "system"):
        role = "user"
    content = m.get("content")
    if isinstance(content, list):  # multimodal parts: keep text only
        content = " ".join(str(p.get("text", "")) for p in content
                           if isinstance(p, dict) and p.get("type") == "text")
    out = {"role": role, "content": str(content or "")[:200_000]}
    # 4/6: thinking persists per assistant message (classic stores
    # reasoning_content the same way; live panel re-shows the last turn's)
    rc = m.get("reasoning_content")
    # classic's hasVisibleThinking: whitespace-only is not thinking
    if role == "assistant" and isinstance(rc, str) and rc.strip():
        out["reasoning_content"] = rc[:200_000]
    if m.get("created_at"):
        out["created_at"] = str(m["created_at"])[:40]
    return out


@api_router.get("/chat/key")
async def chat_key(is_admin: bool = Depends(require_admin)):
    """Admin-gated API key handout (NAT-1 auth verdict: session gate,
    NOT template injection; exposure surface equal to classic's)."""
    key = ""
    try:
        from omlx.server import _server_state
        gs = getattr(_server_state, "global_settings", None)
        if gs is not None:
            key = str(getattr(gs.auth, "api_key", "") or "")
    except Exception:
        pass
    if not key:
        cfg = Path.home() / ".omlx" / "settings.json"
        try:
            key = str(json.loads(cfg.read_text())["auth"]["api_key"])
        except Exception:
            raise HTTPException(status_code=503,
                                detail="API key unavailable (no server state)")
    return {"api_key": key}


@api_router.get("/chat/history")
async def chat_history_list(is_admin: bool = Depends(require_admin)):
    """Summaries only (id/title/model/message_count/updated) — the full
    store can be megabytes; open one conversation to fetch its messages."""
    store = _load()
    out = []
    for cid, c in store["conversations"].items():
        out.append({"id": cid, "title": c.get("title", ""),
                    "model": c.get("model"),
                    "message_count": len(c.get("messages") or []),
                    "updated": c.get("updated", 0)})
    out.sort(key=lambda x: x["updated"])
    return out


@api_router.get("/chat/history/{conv_id}")
async def chat_history_get(conv_id: str, is_admin: bool = Depends(require_admin)):
    c = _load()["conversations"].get(conv_id)
    if c is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return c


@api_router.post("/chat/history")
async def chat_history_save(request: Request,
                            is_admin: bool = Depends(require_admin)):
    body = await request.json()
    cid = str((body or {}).get("id") or "").strip()
    if not cid or len(cid) > 64:
        raise HTTPException(status_code=400, detail="conversation id required")
    msgs = (body or {}).get("messages")
    if msgs is None:
        raise HTTPException(status_code=400, detail="messages required")
    if not isinstance(msgs, list):
        raise HTTPException(status_code=400, detail="messages must be a list")
    store = _load()
    existing = store["conversations"].get(cid) or {}
    conv = {
        "id": cid,
        "title": str(body.get("title") or existing.get("title") or "")[:TITLE_CHARS],
        "model": str(body.get("model") or "")[:120] or None,
        "systemPrompt": str(body.get("systemPrompt") or "")[:8000],
        # 6/6c: active prompt-profile NAME only (content stays in the
        # shared localStorage store). Sanitized like title: a stored
        # string must never reach innerHTML — UI renders it textContent.
        "activeProfile": str(body.get("activeProfile") or "")[:48] or None,
        "thinking": bool(body.get("thinking")),
        "thinkingBudget": body.get("thinkingBudget")
        if isinstance(body.get("thinkingBudget"), int) else None,
        "messages": [_clean_message(m) for m in msgs[-MAX_MESSAGES:]
                     if isinstance(m, dict)],
        "updated": int(time.time() * 1000),
    }
    store["conversations"][cid] = conv
    # cap conversation count (oldest updated first out)
    convs = store["conversations"]
    if len(convs) > MAX_CONVOS:
        for old in sorted(convs, key=lambda k: convs[k]["updated"])[:len(convs) - MAX_CONVOS]:
            del convs[old]
    _save(store)
    kb = len(json.dumps(conv, ensure_ascii=False).encode()) // 1024
    return {"status": "saved", "id": cid, "messages": len(conv["messages"]),
            "kb": kb}


@api_router.delete("/chat/history/{conv_id}")
async def chat_history_delete(conv_id: str,
                              is_admin: bool = Depends(require_admin)):
    store = _load()
    if conv_id not in store["conversations"]:
        raise HTTPException(status_code=404, detail="conversation not found")
    del store["conversations"][conv_id]
    _save(store)
    return {"status": "deleted", "id": conv_id}
