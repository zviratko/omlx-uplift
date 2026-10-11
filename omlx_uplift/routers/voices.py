"""VOICE-1: named voice-cloning voices for TTS — uplift-only layer.

Vanilla omlx already speaks voice cloning: POST /v1/audio/speech takes
first-class `ref_audio` (base64) + `ref_text` fields (AudioSpeechRequest)
and Qwen3-TTS family models synthesize with them. What vanilla has NO
storage concept for is a NAMED voice — an alias carrying a reference clip
plus its transcript, so clients and the chat UI can say voice 'Jake'
instead of re-attaching audio on every request. Model aliases cannot carry
it: the speech endpoint reads only request fields + the resolved model
(stored model settings are not applied to /v1/audio/speech), and profile
ids reject ':'.

So this router owns the thin part; vanilla stays untouched:

- voices.json + voices/<id>.<ext> in the SHARED uplift store (Family B,
  same home as chat history; audio bytes live in files, the JSON never
  carries base64),
- CRUD behind require_admin,
- POST /voices/speech {voice, input, ...} decodes the stored clip,
  base64-encodes it and calls vanilla's create_speech() IN-PROCESS — same
  uvicorn, same _server_state, no HTTP loopback, no second API key. The
  returned audio Response passes through byte-identical,
- POST /voices/preview runs the same synth from ad-hoc ref fields so the
  ADD form can hear the voice before saving it.

- POST /uplift/v1/audio/speech is the STANDARD OpenAI surface
  (audio/speech/create): form or JSON body, Bearer-key auth shared with
  /v1/*, response_format honoured, and `voice` extended to accept a
  stored name/id — clients written for the OpenAI SDK clone voices by
  name with zero uplift-specific code. Deliberately mirrored under
  /uplift/v1/ (not a bare /v1 override): a client that appends '/v1'
  to a base URL ending in /uplift reaches it, and vanilla's own
  /v1/audio/speech (PR #676, unnamed ref_audio cloning) stays intact.

Size rules are stated, not invented: vanilla caps the base64 field at
20 MiB of characters (~15 MiB of raw audio — enough for ~60 s). We cap
raw uploads at MAX_VOICE_AUDIO_BYTES = 14 MiB so the re-encoded base64
always fits with margin. Formats are capped to what miniaudio decodes
natively (wav/mp3/flac): the keg has NO ffmpeg, and the mlx_audio audio
path silently 400s on webm/ogg/m4a for the same reason the chat STT
recorder ships WAV (NAT-4 6/6b lesson).

Standalone-viewer mode (omlx or mlx_audio absent): imports stay soft,
CRUD still works against the JSON store, synthesis answers 503 with the
reason — the store is data, the engine is a service.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .base import api_router, page_router, require_admin

_log = logging.getLogger("omlx_uplift.voices")

MAX_VOICES = 64
MAX_VOICE_AUDIO_BYTES = 14 * 1024 * 1024     # base64 then <= 20 MiB chars
MAX_NAME_CHARS = 64
MAX_REF_TEXT_CHARS = 4000
ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
AUDIO_EXTS = {".wav", ".mp3", ".flac"}


def _store_dir() -> Path:
    from .. import paths
    return paths.uplift_store_dir()


def _index_path() -> Path:
    return _store_dir() / "voices.json"


def _audio_dir() -> Path:
    return _store_dir() / "voices"


def _load() -> dict:
    try:
        d = json.loads(_index_path().read_text())
        if isinstance(d, dict) and isinstance(d.get("voices"), list):
            return d
    except Exception:
        pass
    return {"version": 1, "voices": []}


def _save(store: dict) -> None:
    p = _index_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(store, ensure_ascii=False, indent=1))
    tmp.replace(p)


def _slug(name: str, taken: set) -> str:
    base = re.sub(r"[^a-z0-9_-]+", "-", (name or "").lower()).strip("-")[:32]
    if not base or not base[0].isalpha():
        base = "voice-" + base
    base = base[:32].rstrip("-")
    sid, n = base, 2
    while sid in taken or not ID_RE.match(sid):
        sid = (base[:28] + "-" + str(n))
        n += 1
    return sid


def _sanitize(raw: dict, existing: Optional[dict] = None) -> dict:
    name = str(raw.get("name") or "").strip()[:MAX_NAME_CHARS]
    model = str(raw.get("model") or "").strip()[:300]
    if not name:
        raise HTTPException(status_code=400, detail="voice name is required")
    if not model:
        raise HTTPException(status_code=400, detail="TTS model is required")
    ref_text = str(raw.get("ref_text") or "").strip()[:MAX_REF_TEXT_CHARS]
    v = dict(existing or {})
    v.update({"name": name, "model": model, "ref_text": ref_text})
    for k in ("language", "speed"):
        if raw.get(k) not in (None, ""):
            v[k] = raw[k]
        else:
            v.pop(k, None)
    return v


async def _synth_ref(model: str, text: str, ref_path: Optional[Path],
                     ref_text: str, language=None, speed=None,
                     stream: bool = False, response_format: str = "wav",
                     instructions=None) -> Response:
    """Call vanilla create_speech in-process with a reference clip attached.

    ref_path None = no cloning (plain preset-voice TTS model). The clip is
    read from disk here and base64'd only for the duration of the call —
    it never lands in any JSON store or log.
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="'input' must not be empty")
    ref_b64 = None
    if ref_path is not None:
        if not ref_path.is_file():
            raise HTTPException(status_code=500,
                                detail="reference audio file is missing from "
                                       "the store; re-create the voice")
        if not (ref_text or "").strip():
            raise HTTPException(status_code=400,
                                detail="ref_text is required for voice "
                                       "cloning (vanilla rule)")
        ref_b64 = base64.b64encode(ref_path.read_bytes()).decode()
    kwargs = dict(
        model=model,
        input=text,
        ref_audio=ref_b64,
        ref_text=(ref_text or None) if ref_b64 else None,
        language=language or None,
        speed=speed or None,
        stream=bool(stream),
        response_format=response_format or "wav",
        instructions=instructions or None,
    )
    return await _create_speech(kwargs)


async def _create_speech(kwargs: dict) -> Response:
    """Seam into vanilla. Soft import keeps this module usable where omlx
    or mlx_audio is absent (standalone viewer); the seam is what router
    tests monkeypatch, so request ASSEMBLY is exercised everywhere while
    the vanilla call itself stays single-line and un-faked."""
    try:
        from omlx.api.audio_models import AudioSpeechRequest
        from omlx.api.audio_routes import create_speech
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="TTS is not available on this server (omlx audio routes "
                   "missing: %s)" % exc) from exc
    # vanilla raises HTTPException with honest details (model not found,
    # engine not a TTS model, synthesis failure) — let them propagate
    return await create_speech(AudioSpeechRequest(**kwargs))


async def _synth(voice: dict, text: str, stream: bool = False,
                 fmt: str = "wav", speed=None, language=None,
                 model=None) -> Response:
    ref_file = voice.get("ref_file")
    ref_path = (_audio_dir() / Path(ref_file).name) if ref_file else None
    return await _synth_ref(model or voice["model"], text, ref_path,
                            voice.get("ref_text") or "",
                            language or voice.get("language"),
                            speed or voice.get("speed"), stream,
                            response_format=fmt)


def _find(store: dict, key: str) -> Optional[dict]:
    """id first, then case-insensitive display name (the 'Jake' UX)."""
    key = (key or "").strip()
    for v in store["voices"]:
        if v["id"] == key:
            return v
    low = key.lower()
    for v in store["voices"]:
        if v["name"].lower() == low:
            return v
    return None


@api_router.get("/voices")
async def voices_list(_auth=Depends(require_admin)):
    store = _load()
    out = []
    for v in store["voices"]:
        row = {k: v.get(k) for k in ("id", "name", "model", "ref_text",
                                     "language", "speed", "created")}
        f = v.get("ref_file")
        row["ref_bytes"] = (_audio_dir() / Path(f).name).stat().st_size \
            if f and (_audio_dir() / Path(f).name).is_file() else None
        out.append(row)
    return {"voices": out}


@api_router.post("/voices")
async def voices_create(request: Request, _auth=Depends(require_admin)):
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    store = _load()
    if len(store["voices"]) >= MAX_VOICES:
        raise HTTPException(status_code=507,
                            detail="voice store is full (%d)" % MAX_VOICES)
    b64 = raw.get("ref_audio_b64") or ""
    fname = raw.get("ref_name") or "reference.wav"
    ext = Path(fname).suffix.lower()
    if ext not in AUDIO_EXTS:
        raise HTTPException(status_code=400, detail=(
            "reference audio must be %s — this server decodes no other "
            "format without ffmpeg" % "/".join(sorted(e[1:] for e in AUDIO_EXTS))))
    try:
        data = base64.b64decode(b64, validate=True) if b64 else b""
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="ref_audio_b64 is not valid base64")
    if not data:
        raise HTTPException(status_code=400, detail="reference audio is required")
    if len(data) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=(
            "reference audio exceeds %d MiB" % (MAX_VOICE_AUDIO_BYTES // (1024 * 1024))))
    taken = {v["id"] for v in store["voices"]}
    v = _sanitize(raw)
    v["id"] = (raw.get("id") or "").strip() or _slug(v["name"], taken)
    if not ID_RE.match(v["id"]):
        raise HTTPException(status_code=400, detail="invalid voice id")
    if v["id"] in taken:
        raise HTTPException(status_code=409,
                            detail="voice id exists: %s" % v["id"])
    v["ref_file"] = v["id"] + ext
    v["created"] = int(time.time())
    d = _audio_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / v["ref_file"]).write_bytes(data)
    store["voices"].append(v)
    _save(store)
    return {"ok": True, "voice": {k: v[k] for k in
                                  ("id", "name", "model", "ref_file")}}


@api_router.put("/voices/{vid}")
async def voices_update(vid: str, request: Request,
                        _auth=Depends(require_admin)):
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    store = _load()
    v = _find(store, vid)
    if not v:
        raise HTTPException(status_code=404, detail="no such voice: %s" % vid)
    merged = _sanitize(raw, existing=v)
    b64 = raw.get("ref_audio_b64")
    if b64:
        fname = raw.get("ref_name") or "reference.wav"
        ext = Path(fname).suffix.lower()
        if ext not in AUDIO_EXTS:
            raise HTTPException(status_code=400,
                                detail="reference audio must be wav/mp3/flac")
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="invalid base64")
        if len(data) > MAX_VOICE_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="reference audio too large")
        old = _audio_dir() / Path(v.get("ref_file", "")).name
        merged["ref_file"] = v["id"] + ext
        (_audio_dir() / merged["ref_file"]).write_bytes(data)
        if old.is_file() and old.name != merged["ref_file"]:
            old.unlink(missing_ok=True)
    merged.update({"id": v["id"], "created": v.get("created"),
                   "ref_file": merged.get("ref_file") or v.get("ref_file")})
    store["voices"][store["voices"].index(v)] = merged
    _save(store)
    return {"ok": True}


@api_router.delete("/voices/{vid}")
async def voices_delete(vid: str, _auth=Depends(require_admin)):
    store = _load()
    v = _find(store, vid)
    if not v:
        raise HTTPException(status_code=404, detail="no such voice: %s" % vid)
    f = v.get("ref_file")
    if f:
        (_audio_dir() / Path(f).name).unlink(missing_ok=True)
    store["voices"].remove(v)
    _save(store)
    return {"ok": True, "deleted": v["id"]}


@api_router.post("/voices/speech")
async def voices_speech(request: Request, _auth=Depends(require_admin)):
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    store = _load()
    v = _find(store, str(raw.get("voice") or ""))
    if not v:
        names = ", ".join(x["name"] for x in store["voices"]) or "(none yet)"
        raise HTTPException(status_code=404,
                            detail="unknown voice; available: %s" % names)
    return await _synth(v, str(raw.get("input") or ""),
                        stream=bool(raw.get("stream")))


@api_router.post("/voices/preview")
async def voices_preview(request: Request, _auth=Depends(require_admin)):
    """Ad-hoc synth for the ADD form before anything is stored."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    b64 = raw.get("ref_audio_b64") or ""
    try:
        data = base64.b64decode(b64, validate=True) if b64 else b""
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid base64")
    if len(data) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="reference audio too large")
    model = str(raw.get("model") or "")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    ref_text = str(raw.get("ref_text") or "")
    tmp_path = None
    if data:
        ext = Path(str(raw.get("ref_name") or "r.wav")).suffix.lower()
        if ext not in AUDIO_EXTS:
            raise HTTPException(status_code=400,
                                detail="reference audio must be wav/mp3/flac")
        d = _store_dir() / "tmp"
        d.mkdir(parents=True, exist_ok=True)
        tmp_path = d / ("preview-%d%s" % (time.time_ns(), ext))
        tmp_path.write_bytes(data)
    try:
        return await _synth_ref(model,
                                str(raw.get("input")
                                    or "This is a preview of this voice."),
                                tmp_path, ref_text,
                                raw.get("language"), raw.get("speed"))
    finally:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)


# --------------------------------------------------------------------------
# Standard OpenAI surface: POST /uplift/v1/audio/speech
# (https://developers.openai.com/api/reference — audio/speech/create)
#
# Contract honoured, field by field:
#   input            required text (spec: invalid_request_error without it)
#   model            required — UNLESS `voice` names a stored voice that
#                    already carries its base model (uplift extension)
#   voice            spec has a preset enum; here it ALSO resolves stored
#                    voice names/ids (the cloning extension, PR #676
#                    fields attached by the server, never over the wire)
#   response_format  mp3|opus|aac|flac|wav|pcm|hc-webm upstream; default
#                    mp3 per spec. We forward verbatim — vanilla owns the
#                    honest unsupported-format 400 (aac/hc-webm decode
#                    via libsndfile 1.2.2 in the keg, verified)
#   speed            0.25–4.0 (spec range; coerced from form strings)
#   stream           chunked audio response, passed through
#   language         passed through (spec: only some models)
#   instructions     accepted, forwarded (spec: only gpt-4o TTS; vanilla
#                    ignores for Qwen — same honesty as upstream)
# Body may be form-urlencoded, multipart (file parts ignored — reference
# audio lives in the voice), or JSON; auth is the SAME Bearer key /
# x-api-key as /v1/* plus the dashboard session cookie for UI use.
# Errors use the OpenAI {"error": {message, type}} shape.
# --------------------------------------------------------------------------

_STD_METHODS = ("POST",)


def _openai_err(status, message):
    _types = {401: "authentication_error", 404: "not_found_error",
              413: "invalid_request_error", 429: "rate_limit_error"}
    return JSONResponse(status_code=status, content={"error": {
        "message": message,
        "type": _types.get(status, "server_error" if status >= 500
                           else "invalid_request_error"),
        "param": None, "code": None}})


async def _infer_auth(request: Request) -> bool:
    """Bearer/x-api-key like /v1/audio/speech; dashboard session cookie
    also accepted so UI code can reuse one path. Vanilla's own verifier
    IS the implementation — sub-keys, skip-verification and loopback
    no-auth semantics come along untouched. Raises HTTPException (the
    handler converts it to an OpenAI error body)."""
    try:
        from omlx.server import verify_inference_api_key
    except ImportError:
        return await require_admin(request)
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        from fastapi.security import HTTPAuthorizationCredentials
        creds = HTTPAuthorizationCredentials(scheme="Bearer",
                                             credentials=auth[7:].strip())
        return await verify_inference_api_key(request, creds)
    if request.headers.get("x-api-key"):
        # verify_api_key re-reads the header itself when creds are None
        return await verify_inference_api_key(request, None)
    return await require_admin(request)


async def _std_body(request: Request) -> dict:
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype == "application/json":
        b = await request.json()
        return b if isinstance(b, dict) else {}
    form = await request.form()          # urlencoded AND multipart
    out = {}
    for k in form.keys():
        val = form[k]
        # UploadFile parts (a client uploading a ref clip) are ignored:
        # reference audio belongs to the stored voice, never to the request
        if isinstance(val, str):
            out[k] = val
    return out


@page_router.api_route("/uplift/v1/audio/speech", methods=list(_STD_METHODS),
                       include_in_schema=True)
async def speech_std(request: Request):
    try:
        await _infer_auth(request)
    except HTTPException as e:
        return _openai_err(e.status_code, str(e.detail))
    body = await _std_body(request)
    text = str(body.get("input") or body.get("text") or "")
    if not text.strip():
        # vanilla's own create_speech answers 400 for empty input — mirror it
        return _openai_err(400, "'input' field must not be empty")
    fmt = str(body.get("response_format") or "mp3").strip().lower()
    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        return _openai_err(400, "speed must be a float between 0.25 and 4.0.")
    if not 0.25 <= speed <= 4.0:
        return _openai_err(400, "speed must be between 0.25 and 4.0.")
    stream = str(body.get("stream", "")).lower() in ("1", "true", "yes", "on")
    name = str(body.get("voice") or "").strip()
    model = str(body.get("model") or "").strip()

    v = _find(_load(), name) if name else None
    if name and not v:
        # spec: unknown voice is a 400-style request error; we keep the
        # uplift hint (names available) but the OpenAI body shape
        avail = ", ".join(x["name"] for x in _load()["voices"]) or "(none yet)"
        return _openai_err(404, "Voice '%s' is not a stored uplift voice; "
                                "available: %s" % (name, avail))
    if not model and not v:
        return _openai_err(400, "You must provide a 'model' (or a stored "
                                "voice name in 'voice').")

    try:
        if v:
            resp = await _synth(v, text, fmt=fmt, speed=speed, stream=stream,
                                language=body.get("language") or None,
                                model=model or None)
        else:
            # no named voice: pure pass-through to vanilla — anonymous
            # ref_audio cloning (PR #676 fields) included verbatim
            kw = dict(model=model, input=text, response_format=fmt,
                      speed=speed, stream=stream,
                      language=body.get("language") or None,
                      instructions=body.get("instructions") or None,
                      voice=name or None)
            if body.get("ref_audio"):
                kw["ref_audio"] = body["ref_audio"]
                kw["ref_text"] = body.get("ref_text") or None
            resp = await _create_speech(kw)
    except HTTPException as e:
        return _openai_err(e.status_code, str(e.detail))
    return resp
