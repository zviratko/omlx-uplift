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

import asyncio
import json
import re
import time
from pathlib import Path

from fastapi import Depends, HTTPException, Request

from .. import tts_cache
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


GEN_KEYS = ("temperature", "max_tokens", "top_p", "top_k",
            "min_p", "repetition_penalty", "presence_penalty")
# UP-38: token counts + measured TPS. Whitelist, not passthrough: this store is
# user-visible JSON that export feeds to other tools, so a runaway client must
# not be able to grow it per message.
USAGE_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens",
              "cached_tokens", "reasoning_tokens", "tps")


def _clean_state(raw):
    """ROUND 9: the stash of UNSAVED page state (prompt + settings the
    active preset does not own). Whitelist-only: known keys, pinned types,
    generation via the same cleaner as conv.generation; anything else or
    an oversized blob collapses to None (a stash is a convenience, never
    a payload channel)."""
    if not isinstance(raw, dict):
        return None
    out = {}
    p = raw.get("prompt")
    out["prompt"] = str(p or "")[:8000]
    s = raw.get("settings")
    if isinstance(s, dict):
        keep = {}
        th = s.get("thinking")
        if isinstance(th, str) and _STOP_RE.fullmatch(th):
            keep["thinking"] = th
        tb = s.get("thinkingBudget")
        if isinstance(tb, int) and not isinstance(tb, bool) and tb >= 0:
            keep["thinkingBudget"] = tb
        gen = _clean_generation(s.get("generation"))
        if gen:
            keep["generation"] = gen
        keep["webSearch"] = bool(s.get("webSearch"))
        for k, mx in (("voice", 120), ("autospeak", 1), ("chunk", 16),
                      ("sttModel", 120), ("sttLang", 16),
                      ("sttAutosend", 1), ("sttMode", 11)):
            v = s.get(k)
            if isinstance(v, str):
                keep[k] = v[:mx]
        out["settings"] = keep
    else:
        out["settings"] = None
    if len(json.dumps(out, ensure_ascii=False)) > 6000:
        return None
    return out


def _clean_variants(raw):
    """ROUND 11: per-profile unsaved working copies {name: {prompt,
    settings}}. Reuses _clean_state per entry; caps entry count and name
    length; total blob cap 20 KB, over-cap collapses to {} (variants are
    a convenience, the saved store is the truth)."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in list(raw.items())[:12]:
        if not isinstance(k, str) or not k or len(k) > 48:
            continue
        cv = _clean_state(v if isinstance(v, dict) else None)
        if cv and (cv["prompt"] or cv["settings"]):
            out[k] = cv
    if len(json.dumps(out, ensure_ascii=False)) > 20000:
        return {}
    return out


# UP-37: a reasoning stop is the model's own vocabulary (classic
# reasoningStops): auto/off/on/limit plus an effort level like 'low' or
# 'medium'. Shape-checked here; the picker decides legality.
_STOP_RE = re.compile(r"[a-z][a-z0-9_-]{0,15}")


def _clean_by_model(raw):
    """UP-37: per-model knob sets {model: {thinking, thinkingBudget,
    generation}} — classic modelSettingsByModel (chat.html:3146). One
    entry per model, count and key length capped hard."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in list(raw.items())[:16]:
        key = str(k or "")[:120]
        if not key or not isinstance(v, dict):
            continue
        th = v.get("thinking")
        gen = _clean_generation(v.get("generation"))
        tb = v.get("thinkingBudget")
        out[key] = {
            "thinking": th if isinstance(th, str) and _STOP_RE.fullmatch(th)
                        else "auto",
            "thinkingBudget": tb if isinstance(tb, int)
                              and not isinstance(tb, bool) and tb >= 0 else None,
            "generation": gen,
        }
    return out


def _clean_generation(raw):
    """U46: per-chat sampling overrides — classic's snapshotGenerationSettings
    fields (chat.html:3386), persisted per session like classic does.
    Numeric only: 0 and 0.0 are VALID (temp 0 = greedy) so presence is
    checked per key, never by truthiness; bools excluded (Python bool is
    int); anything else means 'not set' -> engine default."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for k in GEN_KEYS:
        v = raw.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = v
    return out or None


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
    # U74: an Edited mark survives reloads. Timestamp only — honest,
    # no per-field bookkeeping (editing reasoning or content sets it).
    if m.get("edited"):
        out["edited"] = str(m.get("edited"))[:40]
    # VOICE-16b: a bubble owns its synthesized audio, so it needs an identity
    # that survives reloads and re-ordering (indices do not). Client-minted,
    # opaque, and only ever a JSON key on the cache side.
    mid = tts_cache.token(m.get("mid"))
    if mid:
        out["mid"] = mid
    # VOICE-16b: the read-aloud plan (how this bubble was split into chunks),
    # so the player rows come back after a reload and load from the cache
    # instead of waking the TTS model. Rev = client digest of the text that
    # was spoken: when the text (or the mode) changes, the rev moves and the
    # old audio becomes unreachable — the prune below deletes it.
    speech = m.get("speech")
    if isinstance(speech, dict):
        mode = str(speech.get("mode") or "")
        n = speech.get("n")
        clean_s = {}
        if mode in ("sentence", "line", "paragraph"):
            clean_s["mode"] = mode
        if isinstance(n, int) and not isinstance(n, bool) and 0 < n <= 5000:
            clean_s["n"] = n
        rev = tts_cache.token(speech.get("rev"))
        if rev:
            clean_s["rev"] = rev
        # the text fingerprint that proves the plan still matches the bubble:
        # a strategy change re-plans NEW bubbles only, an edited text re-plans
        # that one (VOICE-16, user 2026-10-18)
        summ = tts_cache.token(speech.get("sum"))
        if summ:
            clean_s["sum"] = summ
        if clean_s:
            out["speech"] = clean_s
    # U78: what the reply was actually sampled with (per-TURN provenance;
    # the per-chat generation object is the CURRENT knob state, which
    # rewording mid-chat would falsify for older replies). Sanitized
    # hard: only known numeric keys + the two thinking fields.
    raw_p = m.get("params")
    if role == "assistant" and isinstance(raw_p, dict):
        clean_p = {}
        for k in GEN_KEYS:
            v = raw_p.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                clean_p[k] = v
        if isinstance(raw_p.get("enable_thinking"), bool):
            clean_p["enable_thinking"] = raw_p["enable_thinking"]
        tb = raw_p.get("thinking_budget")
        if isinstance(tb, int) and not isinstance(tb, bool):
            clean_p["thinking_budget"] = tb
        rv = raw_p.get("reasoning_effort")
        if isinstance(rv, str) and _STOP_RE.fullmatch(rv):
            clean_p["reasoning_effort"] = rv
        if clean_p:
            out["params"] = clean_p
    # UP-16 live fix (QA 2026-10-25): usage used to be DROPPED here, which made
    # the client's own recovery dead code — toolbar ctxUsed() walks the last
    # rows for .usage to rebuild the context ring, and the footer chip reads it
    # for the token/TPS line. After any reload the ring sat at 0% and the line
    # was gone until the next live turn. (rmodel already persists with the
    # variant markers below — checked, not assumed.)
    raw_u = m.get("usage")
    if role == "assistant" and isinstance(raw_u, dict):
        clean_u = {}
        for k in USAGE_KEYS:
            v = raw_u.get(k)
            if (isinstance(v, (int, float)) and not isinstance(v, bool)
                    and 0 <= v < 1e12):
                clean_u[k] = v
        if clean_u:
            out["usage"] = clean_u
    # UP-43: attachment META (names + kinds) survives reloads; bytes never
    # do — the store stays text-only by design (client sanitizes at save,
    # this whitelist is the second gate). Capped hard: 8 entries, 120 chars.
    att = m.get("att")
    if isinstance(att, list):
        out["att"] = [{"n": str(a.get("n") or "")[:120],
                       "k": a.get("k") if a.get("k") in ("image", "file", "audio") else "file"}
                      for a in att[:8] if isinstance(a, dict) and a.get("n")]
    # UP-29: regenerate-variant markers (assistant rows only). A variant
    # chain self-describes on each row: vg=group, vid=chain, vsel marks
    # the shown sibling (0 = parked/hidden, absent = plain row). rmodel is
    # display-only provenance for the variant tab tooltip. Capped hard.
    if role == "assistant":
        vg = m.get("vg")
        if isinstance(vg, str) and 0 < len(vg) <= 40:
            out["vg"] = vg
            vid = m.get("vid")
            if isinstance(vid, str) and 0 < len(vid) <= 40:
                out["vid"] = vid
            if m.get("vsel") in (0, 1):
                out["vsel"] = int(m.get("vsel"))
        rm = m.get("rmodel")
        if isinstance(rm, str) and rm:
            out["rmodel"] = rm[:120]
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
    def _sync():
        store = _load()
        out = []
        for cid, c in store["conversations"].items():
            out.append({"id": cid, "title": c.get("title", ""),
                        "model": c.get("model"),
                        # UP-39: pinned rides the summary so the list can
                        # sort pinned-first without opening every chat
                        "pinned": bool(c.get("pinned", False)),
                        "message_count": len(c.get("messages") or []),
                        "updated": c.get("updated", 0)})
        out.sort(key=lambda x: x["updated"])
        return out

    return await asyncio.to_thread(_sync)


@api_router.get("/chat/history/export")
async def chat_history_export(is_admin: bool = Depends(require_admin)):
    """U77: whole store as a list of full conversations (classic's
    Download Chats counterpart; its format is the same array-of-chats).
    LITERAL path — must stay registered BEFORE /chat/history/{conv_id}
    or FastAPI shadows it (the bench route-order lesson, golden-tested)."""
    def _sync():
        store = _load()
        convs = list(store["conversations"].values())
        convs.sort(key=lambda c: c.get("updated", 0))
        return convs

    return await asyncio.to_thread(_sync)


@api_router.get("/chat/history/{conv_id}")
async def chat_history_get(conv_id: str, is_admin: bool = Depends(require_admin)):
    def _sync():
        c = _load()["conversations"].get(conv_id)
        if c is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        return c

    return await asyncio.to_thread(_sync)


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

    def _sync():
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
            # CHAT-3R (user: changing a preset must keep custom text so the
            # user can go back safely): the stashed unbound/edited prompt.
            # Same textContent-only rule as activeProfile.
            "customPrompt": str(body.get("customPrompt") or "")[:8000],
            # ROUND 9: full-page stash twin ({prompt, settings}) — see _clean_state
            "customState": _clean_state(body.get("customState")),
            # ROUND 11: per-profile unsaved working copies (the stash's
            # successor — divergence belongs to the profile, not to a slot)
            "variants": _clean_variants(body.get("variants")),
            # UP-37: effort stops widen the old fixed four (see _STOP_RE)
            "thinking": body.get("thinking")
            if isinstance(body.get("thinking"), str)
            and _STOP_RE.fullmatch(body.get("thinking") or "")
            else "auto",
            # UP-37(3): classic's per-model knob sets ride the session
            "modelSettingsByModel": _clean_by_model(
                body.get("modelSettingsByModel")),
            "thinkingBudget": body.get("thinkingBudget")
            if isinstance(body.get("thinkingBudget"), int)
            and not isinstance(body.get("thinkingBudget"), bool)
            and body.get("thinkingBudget") >= 0 else None,
            # U46: classic persists the sidebar sampling fields per session
            # (schedulePersistModelSettings -> syncSessionModelSettingsFromUi);
            # native mirrors the same scope. None = nothing set = engine default.
            "generation": _clean_generation(body.get("generation")),
            # UP-39: pin flag (classic togglePinChat :7967). Strictly a
            # boolean; absent in the body keeps the stored value (partial
            # savers like migrateLegacy must not silently unpin).
            "pinned": (body.get("pinned") is True if "pinned" in body
                       else bool(existing.get("pinned", False))),
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
                tts_cache.drop_conversation(old)     # VOICE-16b: its audio too
        _save(store)
        # VOICE-16b: a bubble the save no longer carries takes its audio with it,
        # and so does one whose plan revision moved (edited text, new voice,
        # re-chunked after an upgrade). Runs after the write so a rejected save
        # can never delete live audio.
        tts_cache.prune_conversation(
            cid, [m.get("mid") for m in conv["messages"] if m.get("mid")],
            revs={m["mid"]: (m.get("speech") or {}).get("rev") or "0"
                  for m in conv["messages"] if m.get("mid")})
        kb = len(json.dumps(conv, ensure_ascii=False).encode()) // 1024
        return {"status": "saved", "id": cid, "messages": len(conv["messages"]),
                "kb": kb}

    return await asyncio.to_thread(_sync)


@api_router.delete("/chat/history/{conv_id}")
async def chat_history_delete(conv_id: str,
                              is_admin: bool = Depends(require_admin)):
    def _sync():
        store = _load()
        if conv_id not in store["conversations"]:
            raise HTTPException(status_code=404, detail="conversation not found")
        del store["conversations"][conv_id]
        _save(store)
        freed = tts_cache.drop_conversation(conv_id)      # VOICE-16b
        return {"status": "deleted", "id": conv_id, "audio_freed": freed}

    return await asyncio.to_thread(_sync)
