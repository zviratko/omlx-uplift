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

- SAY-1: the macOS system synthesizer rides the SAME machinery as a
  pseudo-model: a voice with model 'say:<Name>' is dispatched inside
  _synth_ref to omlx_uplift/say_engine (say -v Name -f in -o out.wav).
  GET /voices/say serves the tab catalog (installed voices, quality tier,
  downloaded badge), POST /voices/say/speech auditions one before saving.
  Stored AND anonymous ('model': 'say:Zuzana') speech on the standard
  surface both work — every caller (chat read-aloud included) gets `say`
  through the ordinary voice name.

- SAY-2: the engine token also works BARE ('say') and in the `voice`
  field, and a request may carry a `language` instead of a voice name.
  The tail itself may BE a locale — 'say:cs-CZ' routes exactly like a
  bare 'say' carrying language cs-CZ (explicit installed voice still
  wins over the locale reading). The voices store gains a top-level
  'say_preferred' map ({locale: identifier}) edited through
  POST /voices/say/preferred — the macOS tab marks a favourite per
  language ("Mark preferred for: cs-CZ") instead of creating
  pseudo-model voices. A language route resolves: preferred mark →
  the language's default voice → its best installed voice → honest
  404 naming the language. No mark, no language: the TEXT answers —
  Apple's own NaturalLanguage identifier guesses the language
  (confidence-gated; a shaky guess or an uninstalled one falls back to
  the Mac's system default voice). Existing stored 'say:<Name>' voices
  keep working unchanged; the tab simply stops creating new ones.

- POST /uplift/v1/audio/speech is the STANDARD OpenAI surface
  (audio/speech/create): form or JSON body, Bearer-key auth shared with
  /v1/*, response_format honoured, and `voice` extended to accept a
  stored name/id — clients written for the OpenAI SDK clone voices by
  name with zero uplift-specific code. Deliberately mirrored under
  /uplift/v1/ (not a bare /v1 override): a client that appends '/v1'
  to a base URL ending in /uplift reaches it, and vanilla's own
  /v1/audio/speech (PR #676, unnamed ref_audio cloning) stays intact.

- TTS-1: models get a DEFAULT tier. voices.json gains a top-level
  'tts_defaults' map ({model: {speaker, instructions, language}}; '' is
  unset, a model whose three fields are all empty has NO key) edited
  through GET/POST /voices/tts/defaults. Every uplift speech path now
  resolves per field: request > stored voice field > tts_defaults[model].
  ONE helper (_tts_defaults_merge) owns that order; the say engine stays
  untouched (its `language` is ROUTING, not a checkpoint field) and a
  model with no defaults row passes through exactly as before.
  POST /voices/tts/speak speaks a MODEL with no stored voice and no
  reference clip (the TEXT TO SPEECH tab audition, editor preview)
  through the same _create_speech seam and the same merge. The
  capability probe answers from checkpoint CONFIG only — never from a
  model name: 'type' from the top-level tts_model_type (the spk_id
  table is the fallback only when the marker is absent), plus
  'size' (tts_model_size) and 'instruct' (voice_design, or
  custom_voice whose size is known and not 0b6 — per the official
  Qwen3-TTS model card the 0.6B-CustomVoice has no instruction control;
  absent/unknown can never prove it, so it answers False).

Size rules are stated, not invented: vanilla caps the base64 field at
20 MiB of characters (~15 MiB of raw audio — enough for ~60 s). We cap
raw uploads at MAX_VOICE_AUDIO_BYTES = 14 MiB so the re-encoded base64
always fits with margin. Formats accepted by extension: wav/mp3/flac —
but the STORE always holds real WAV: vanilla's speech route writes the
ref bytes to a tempfile with a hardcoded .wav suffix, so mp3/flac clips
transcribe fine (miniaudio sniffs content) yet poison every synthesis
that uses the voice. Non-WAV uploads are therefore transcoded to WAV
with ffmpeg at save time; if the server has no ffmpeg the save fails
with 415 and the reason. webm/ogg/m4a stay out (the recorder ships WAV
— NAT-4 6/6b lesson).

Standalone-viewer mode (omlx or mlx_audio absent): imports stay soft,
CRUD still works against the JSON store, synthesis answers 503 with the
reason — the store is data, the engine is a service.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import logging
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .. import say_engine
from .base import api_router, page_router, require_admin

_log = logging.getLogger("omlx_uplift.voices")

MAX_VOICES = 64
MAX_VOICE_AUDIO_BYTES = 14 * 1024 * 1024     # base64 then <= 20 MiB chars
MAX_NAME_CHARS = 64
MAX_REF_TEXT_CHARS = 4000
MAX_INSTRUCT_CHARS = 1000                    # VOICE-6: style instruction prose
# TTS-1 caps: model keys are ids, speaker/language short ids (same cap
# _sanitize gives a voice's own language/speaker); DEFAULT instruction
# prose rides EVERY synth of the model, so it stays tighter than the
# per-voice MAX_INSTRUCT_CHARS. The clip-less speak route's text cap is
# the say engine's own number — one honest limit for spoken utterances.
MAX_TTS_MODEL_CHARS = 128
MAX_TTS_ID_CHARS = 64
MAX_TTS_DEFAULT_INSTRUCT_CHARS = 500
MAX_SPEECH_INPUT_CHARS = say_engine.MAX_SAY_CHARS
ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
AUDIO_EXTS = {".wav", ".mp3", ".flac"}


def _is_wav(data: bytes) -> bool:
    return data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _sniff_kind(data: bytes, ext: str) -> str:
    """Content wins over the extension hint; the guess only names ffmpeg's
    input file, ffmpeg probes the bytes themselves anyway."""
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF
                              and data[1] & 0xE0 == 0xE0):
        return "mp3"
    if data[:4] == b"fLaC":
        return "flac"
    return (ext or "").lstrip(".").lower() or "audio"


def _to_wav(data: bytes, kind: str) -> bytes:
    """The store's single audio format is WAV (module docstring: vanilla
    hardcodes the .wav tempfile suffix for ref bytes). WAV passes through
    untouched; anything else transcodes via ffmpeg or fails honestly —
    there is no other decoder on a ffmpeg-less keg."""
    if _is_wav(data):
        return data
    exe = shutil.which("ffmpeg")
    if not exe:
        raise HTTPException(status_code=415, detail=(
            "reference audio is %s, not WAV, and this server has no ffmpeg "
            "to convert it — install ffmpeg or provide a WAV clip" % kind))
    with tempfile.TemporaryDirectory(prefix="uplift-ref-") as td:
        src = Path(td) / ("src." + kind)
        dst = Path(td) / "dst.wav"
        src.write_bytes(data)
        try:
            proc = subprocess.run(
                [exe, "-hide_banner", "-loglevel", "error", "-y",
                 "-i", str(src), "-ac", "1", str(dst)],
                capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504,
                                detail="ffmpeg conversion timed out")
        if proc.returncode != 0 or not dst.is_file():
            why = proc.stderr.decode(errors="replace").strip()[-300:]
            raise HTTPException(status_code=400, detail=(
                "ffmpeg could not decode the reference audio: "
                + (why or "no output produced")))
        out = dst.read_bytes()
    if len(out) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=(
            "reference audio exceeds %d MiB after conversion to WAV — use a "
            "shorter clip" % (MAX_VOICE_AUDIO_BYTES // (1024 * 1024))))
    return out


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
    for k in ("language", "speed", "instructions", "speaker", "designed_from"):
        if raw.get(k) not in (None, ""):
            val = raw[k]
            # VOICE-5/6/7 caps: language/speaker are short ids, instruct
            # free text (vanilla feeds it to the model prompt; 1k chars is
            # generous prose and keeps voices.json sane)
            if k == "instructions":
                val = str(val).strip()[:MAX_INSTRUCT_CHARS]
            elif k in ("language", "speaker"):
                val = str(val).strip()[:64]
            elif k == "designed_from":       # VOICE-8: honest origin note
                val = str(val).strip()[:MAX_INSTRUCT_CHARS]
            v[k] = val
        elif k == "designed_from":
            # origin survives an edit that does not resend it (metadata,
            # never re-sent to the engine — only _sanitize's editable set pops)
            pass
        else:
            v.pop(k, None)
    return v


async def _synth_ref(model: str, text: str, ref_path: Optional[Path],
                     ref_text: str, language=None, speed=None,
                     stream: bool = False, response_format: str = "wav",
                     instructions=None, speaker=None) -> Response:
    """Call vanilla create_speech in-process with a reference clip attached.

    ref_path None = no cloning (plain preset-voice TTS model). The clip is
    read from disk here and base64'd only for the duration of the call —
    it never lands in any JSON store or log. speaker (VOICE-7) is the
    CustomVoice preset name — vanilla routes it to the engine's `voice`
    kwarg; Base checkpoints carry no presets and vanilla drops it there
    (_accepts_preset_voice).
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="'input' must not be empty")
    # SAY-1: a voice whose model is 'say:<Name>' is rendered by the macOS
    # system synthesizer — no TTS model, no reference clip, no vanilla call.
    # The name rides the model marker; stream is not supported by this
    # engine (the whole utterance renders in well under a second, so
    # chunking would only complicate the response for zero latency gain).
    # SAY-2: the bare token 'say' (or 'say:' with no voice) means "route
    # by language" — the request/voice language picks the preferred voice.
    is_say, say_tail = say_engine.say_split(model)
    if is_say:
        return await _say_response(say_tail, text, speed=speed,
                                   response_format=response_format,
                                   language=language)
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
        ref_bytes = ref_path.read_bytes()
        if not _is_wav(ref_bytes):
            # voice stored before the WAV invariant existed (mp3/flac era):
            # transcode ONCE and migrate the file in place — every later
            # synth reads WAV. Without ffmpeg this raises the honest 415
            # here rather than crashing vanilla's .wav-suffixed tempfile.
            ref_bytes = _to_wav(ref_bytes, _sniff_kind(ref_bytes, ref_path.suffix))
            ref_path.write_bytes(ref_bytes)
        ref_b64 = base64.b64encode(ref_bytes).decode()
    kwargs = dict(
        model=model,
        input=text,
        voice=speaker or None,
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


def _say_preferred() -> dict:
    """SAY-2 preferred map ({locale: identifier}) from the voice store.
    The store predates the key — a missing or malformed map is simply
    empty, never an error."""
    p = _load().get("say_preferred")
    return {str(k): str(v) for k, v in p.items()} if isinstance(p, dict) else {}


def _tts_defaults() -> dict:
    """TTS-1: the {model: {speaker, instructions, language}} map from the
    voice store — the model-level DEFAULT tier of synth resolution, same
    store-map shape as _say_preferred. The store predates the key and
    lanes may hand-edit it: a missing map, a non-dict row or an
    all-empty row is simply not returned, never an error. Unknown keys
    inside a row are DROPPED — the three fields are the whole contract,
    so a smuggled 'speed' can never ride every synth of the model.
    Values stay verbatim (no case folding anywhere in this feature):
    locale-ish strings are distinct strings to whatever table reads them."""
    d = _load().get("tts_defaults")
    if not isinstance(d, dict):
        return {}
    out = {}
    for model, row in d.items():
        if not isinstance(row, dict):
            continue
        clean = {k: str(row.get(k) or "") for k in
                 ("speaker", "instructions", "language")}
        if any(clean.values()):
            out[str(model)] = clean
    return out


def _tts_defaults_merge(model: str, language, instructions, speaker):
    """TTS-1: THE single resolution point — per field, request > stored
    voice field > tts_defaults[model]. Callers pass what they already
    resolved from request+voice (this helper only adds the third tier);
    None means unset, so an explicit '' from a request stays '' and is
    NOT replaced by a default. A model with no defaults row returns the
    inputs untouched — that is the passthrough guarantee every pre-TTS-1
    request keeps today. The say engine is exempt BY CONTRACT: its
    `language` drives SAY-2 routing (the preferred map), not a
    checkpoint language table, and speaker/instructions would be
    silently dropped by that engine anyway."""
    if say_engine.say_split(model)[0]:
        return language, instructions, speaker
    d = _tts_defaults().get((model or "").strip())
    if not d:
        return language, instructions, speaker
    return (language or d.get("language") or None,
            instructions if instructions is not None
            else (d.get("instructions") or None),
            speaker if speaker is not None else (d.get("speaker") or None))


async def _say_tail_ok(tail: str) -> bool:
    """A stored voice may name an installed system voice OR a locale
    that routes today ('say:cs-CZ', SAY-2); an empty tail (bare 'say')
    routes per REQUEST language, so it is always a valid definition.
    Anything else would only ever 502 — refuse it at the door."""
    if not tail:
        return True
    if await asyncio.to_thread(say_engine.resolve, tail) is not None:
        return True
    if say_engine._LOCALEISH_RE.match(tail):
        return await asyncio.to_thread(
            say_engine.language_voice, tail, _say_preferred()) is not None
    return False


async def _say_response(name: str, text: str, speed=None,
                        response_format: str = "wav",
                        language=None) -> Response:
    """Render one utterance with the macOS engine. The two blocking steps
    (say subprocess, optional ffmpeg) run off the event loop; every failure
    answers with the reason instead of a fake silent wav. WAV stays
    byte-exact (no re-encode) — the common case pays nothing for formats
    it never asked for. SAY-2: an empty `name` is no longer an error — it
    routes through the preferred mark for `language`, the language's own
    default, the detected language of the text, or the Mac's default
    voice (say_engine.route)."""
    if not say_engine.available():
        raise HTTPException(status_code=404,
                            detail="macOS say is not available on this server")
    try:
        wav = await asyncio.to_thread(
            say_engine.synth_bytes, name or "", text, speed,
            language, _say_preferred())
        data = await asyncio.to_thread(say_engine.convert_wav, wav,
                                       response_format)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        _log.warning("macOS say failed: %s", e)
        raise HTTPException(status_code=502, detail=str(e))
    return Response(content=data,
                    media_type=say_engine.media_type(response_format))


async def _create_transcription(data: bytes, filename: str, model: str,
                                language=None) -> str:
    """Second vanilla seam: speech-to-text, in-process like _create_speech.

    VOICE-2: the ADD form's AUTO-TRANSCRIBE — vanilla owns the engine,
    uplift only wraps the stored/uploaded bytes into the multipart shape
    create_transcription expects (UploadFile over BytesIO; its _read_upload
    awaits file.read(), which starlette provides even for a sync buffer).
    Returns the transcript text. Same soft-import 503 and honest
    HTTPException propagation as the TTS seam."""
    try:
        from omlx.api.audio_routes import create_transcription
        from starlette.datastructures import UploadFile
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="STT is not available on this server (omlx audio routes "
                   "missing: %s)" % exc) from exc
    uf = UploadFile(file=io.BytesIO(data), filename=filename)
    # EVERY defaulted Form() param must be passed explicitly: a direct
    # call skips FastAPI's DI, leaving un-passed ones bound to their
    # FieldInfo objects ('Form' object has no attribute 'strip' — live QA)
    resp = await create_transcription(
        file=uf, model=model, language=language or None, prompt=None,
        response_format="json", temperature=0.0, stream=False,
        max_tokens=None, word_timestamps=False)
    # response_model is FastAPI-only sugar: a direct call returns the
    # pydantic object itself
    return getattr(resp, "text", None) or ""


async def _synth(voice: dict, text: str, stream: bool = False,
                 fmt: str = "wav", speed=None, language=None,
                 model=None, ref_text=None, instructions=None,
                 speaker=None) -> Response:
    # ref_text: the EDITOR previews a changed transcript against the
    # STORED clip before saving — the override keeps preview truthful
    # (VOICE-4); absent = the voice's saved transcript. instructions
    # follows the SAME override rule (VOICE-6): the editor's live form
    # value previews, the stored one applies to plain speech calls.
    # speaker (VOICE-7): preset name for CustomVoice models; a voice
    # without one clones via ref clip exactly as before.
    ref_file = voice.get("ref_file")
    ref_path = (_audio_dir() / Path(ref_file).name) if ref_file else None
    eff_model = model or voice["model"]
    # TTS-1 third tier, per field: request (already merged over the voice
    # value below) > stored voice field > tts_defaults[resolved model].
    # The None-vs-'' distinction is kept: an explicit empty override from
    # the editor form is the REQUEST speaking, not an unset field.
    language, instructions, speaker = _tts_defaults_merge(
        eff_model,
        language or voice.get("language"),
        voice.get("instructions") if instructions is None else instructions,
        voice.get("speaker") if speaker is None else speaker)
    return await _synth_ref(eff_model, text, ref_path,
                            voice.get("ref_text") if ref_text is None
                            else ref_text,
                            language,
                            speed or voice.get("speed"), stream,
                            response_format=fmt,
                            instructions=instructions,
                            speaker=speaker)


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


def _family_hint(hint: str, model: str) -> bool:
    """True when a 'Model:' prefix merely names the voice's own base
    model (exact or as a substring — 'Qwen3-TTS' inside
    'Qwen3-TTS-12Hz-0.6B-Base-8bit'). A family hint does NOT override
    the stored model; anything else is an explicit model choice."""
    h = (hint or "").lower().strip()
    m = (model or "").lower()
    return bool(h) and (h == m or h in m)


def _alias_lookup(name: str, model: str):
    """Resolve a possibly 'Model:Voice' composite to a stored voice.

    The whole string is tried first — a display name may legitimately
    contain ':'. Otherwise the part after the LAST colon selects the
    voice and the part before it names the base model: a family hint
    keeps the voice's stored model, any other prefix overrides it (the
    SAME reference clip clones onto any TTS model that accepts it —
    vanilla decides, and 404s honestly when the model does not exist).
    An explicit 'model' field always wins over the prefix. Returns
    (voice|None, model_override|None, resolved_name)."""
    store = _load()
    key = (name or "").strip()
    if not key:
        return None, (model or None), key
    v = _find(store, key)
    if v is None and ":" in key:
        head, _, tail = key.rpartition(":")
        tail = tail.strip()
        if tail:
            v = _find(store, tail)
            if v is not None:
                explicit = (model or "").strip()
                # the composite may ITSELF have arrived in the model field
                # (voice empty) — only a DIFFERENT explicit model overrides
                if explicit and explicit != key:
                    return v, explicit, tail
                hint = head.strip()
                return v, (None if _family_hint(hint, v["model"]) else
                           (hint or None)), tail
        # composite with no voice behind it: not ours (vanilla presets
        # and model ids never carry ':') — caller answers as unknown
        return None, (model or None), key
    return v, (model or None), key


@api_router.get("/voices")
async def voices_list(_auth=Depends(require_admin)):
    store = _load()
    out = []
    for v in store["voices"]:
        row = {k: v.get(k) for k in ("id", "name", "model", "ref_text",
                                     "language", "speed", "instructions",
                                     "speaker", "created")}
        f = v.get("ref_file")
        row["ref_bytes"] = (_audio_dir() / Path(f).name).stat().st_size \
            if f and (_audio_dir() / Path(f).name).is_file() else None
        out.append(row)
    return {"voices": out}


@api_router.post("/voices/design")
async def voices_design(request: Request, _auth=Depends(require_admin)):
    """VOICE-8: design a reference clip with a VoiceDesign checkpoint.

    Body: {model, instruct, input?, language?}. The design model needs NO
    ref audio — the description IS the input; mlx_audio raises honestly
    when the checkpoint is not a voice_design one, and the capability
    probe double-checks it here BEFORE burning a model load. Returns the
    raw WAV (the client then stores it as an ordinary clone voice's
    reference clip — the card's own 'Voice Design then Clone' workflow,
    no fine-tuning, no training framework)."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    model = str(raw.get("model") or "").strip()
    instruct = str(raw.get("instruct") or "").strip()[:MAX_INSTRUCT_CHARS]
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    if not instruct:
        raise HTTPException(status_code=400,
                            detail="instruct (the voice description) is required")
    caps = await voices_capabilities(model=model, _auth=True)
    if not caps.get("qwen3") or caps.get("type") != "voice_design":
        raise HTTPException(status_code=400, detail=(
            "'%s' is not a Qwen3-TTS VoiceDesign checkpoint "
            "(type: %s) — download e.g. mlx-community/"
            "Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit first"
            % (model, caps.get("type") or "unknown")))
    text = str(raw.get("input") or "Hello! This is how I sound.").strip()
    return await _synth_ref(model, text, None, "",
                            raw.get("language") or None, None,
                            False, "wav", instruct)


@api_router.get("/voices/capabilities")
async def voices_capabilities(model: str = "", _auth=Depends(require_admin)):
    """VOICE-5/6/7: what THIS TTS model can actually do, read from the
    checkpoint's config.json — never guessed from the model name.

    Static metadata only (same trick as vanilla GET /v1/audio/voices: the
    spk_id table + the language table live in the config, the model does
    not need to load). Non-Qwen3-TTS engines and unknown models answer
    {'qwen3': False,...} — the UI then stays SILENT about language/
    speaker/instruct (those fields are Qwen3-TTS specific per the user).

    Fields:
      qwen3      bool  — the checkpoint is qwen3_tts
      type       str   — 'base' | 'custom_voice' | 'voice_design'
      size       str   — tts_model_size ('0b6'|'1b7'|…; '' unknown)
      languages  list  — engine language ids (lowercase; 'auto' first)
      speakers   list  — preset speaker names (empty on Base clones)
      instruct   bool  — the engine accepts a style instruction prompt
                         (TTS-1: from CONFIG fields only — voice_design,
                         or custom_voice whose size is known and not
                         0b6, the model card's no-instruct checkpoint;
                         absent/unknown never guesses to True)

    Non-qwen3 answers carry the SAME key set (size '', instruct False):
    consumers read one shape, not two.
    """
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    empty = {"model": model, "qwen3": False, "type": "", "size": "",
             "languages": [], "speakers": [], "instruct": False}
    try:
        # vanilla's OWN resolution (audio_routes.list_model_voices does
        # exactly this): pool entry -> on-disk model dir, no load needed
        from omlx.api.audio_routes import _get_engine_pool, _resolve_model
        pool = _get_engine_pool()
        resolved = _resolve_model(model)
        entry = pool.get_entry(resolved) if pool is not None else None
        if entry is None:
            return empty
        cfg = Path(entry.model_path) / "config.json"
        empty["model"] = resolved
        j = json.loads(cfg.read_text())
    except (ImportError, OSError, ValueError):
        return empty
    if j.get("model_type") != "qwen3_tts" and "talker_config" not in j:
        return empty
    tc = j.get("talker_config") or {}
    langs = ["auto"] + [k for k in (tc.get("codec_language_id") or {})
                        if "dialect" not in k]
    speakers = sorted((tc.get("spk_id") or {}).keys())
    # TTS-1: the checkpoint NAMES its own family — the top-level
    # tts_model_type/tts_model_size keys (verified on disk: VoiceDesign
    # 1.7B ships voice_design/1b7, Base 0.6B ships base/0b6, and both
    # carry an EMPTY spk_id table). The speaker table is the fallback
    # ONLY when the marker is absent (a pre-marker CustomVoice still
    # has its presets); nothing is ever guessed from the model NAME.
    ttype = str(j.get("tts_model_type") or "").strip().lower()
    if not ttype:
        ttype = "custom_voice" if speakers else "base"
    size = str(j.get("tts_model_size") or "").strip().lower()
    instruct = (ttype == "voice_design"
                or (ttype == "custom_voice" and bool(size)
                    and size != "0b6"))
    return {"model": resolved, "qwen3": True, "type": ttype, "size": size,
            "languages": langs, "speakers": speakers, "instruct": instruct}


@api_router.get("/voices/say")
async def voices_say_list(_auth=Depends(require_admin)):
    """SAY-1: the macOS-voices tab catalog. Roster comes from `say -v ?`
    — what THIS Mac can actually speak — plus the quality tier parsed
    from the name and the 'additional' badge from on-disk voice bundles
    (only proven downloads are badged; nothing is guessed). 'added' marks
    voices already saved into the named-voice store so the tab can show
    them as in use instead of offering a duplicate.
    SAY-2: 'preferred' is the language→voice map, and each marked row
    carries 'preferred_for' with the locale it answers — the tab's
    preferred button.
    SAY-2c: 'system_language' + 'system_voice' tell the tab what THIS
    Mac answers by default; every row whose language would override it
    carries 'answers_default' so its button can read honestly instead
    of showing a star."""
    if not say_engine.available():
        return {"supported": False, "voices": []}
    voices = await asyncio.to_thread(say_engine.list_voices)
    sysl = await asyncio.to_thread(say_engine.system_language)
    store = _load()
    saved = set()
    for v in store["voices"]:
        is_say, tail = say_engine.say_split(v.get("model") or "")
        if is_say and tail:
            saved.add(tail)
    pref = _say_preferred()
    addr2loc = {}
    for loc, addr in pref.items():
        if addr:
            addr2loc[addr] = loc
    dv = say_engine.default_voice() or {}
    # TTS-4: 'default' answers "does THIS row speak its language by
    # default" — computed through the routing chain (best installed tier;
    # a downloaded Premium outranks the factory isDefault compact row),
    # never the raw AVFoundation flag, so the badge and the voice that
    # actually answers can never disagree
    eff = say_engine.effective_default_addrs()
    return {"supported": True, "preferred": pref,
            "system_language": sysl, "system_voice": dv.get("name") or "",
            "voices": [dict(
                v, added=v["name"] in saved
                or v.get("identifier") in saved,
                preferred_for=addr2loc.get(v.get("identifier"))
                or addr2loc.get(v["name"]) or "",
                default=v.get("installed", True) is not False and (
                    (v.get("identifier") or v["name"]) in eff),
                answers_default=bool(sysl)
                and say_engine._locale_score(sysl, v.get("locale")) > 0)
                       for v in voices]}


@api_router.post("/voices/say/preferred")
async def voices_say_preferred(request: Request, _auth=Depends(require_admin)):
    """SAY-2: mark which system voice answers for a language. Body
    {locale, identifier}: the pair 'cs-CZ' + 'com.apple.voice…Zuzana'
    means a `say` request carrying language cs-CZ (or plain cs) speaks
    with that voice instead of falling through to the language default.
    An empty identifier clears the mark. One voice per language; marking
    a second voice in the same language replaces the first."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    locale = say_engine._norm_locale(str(raw.get("locale") or "").strip())
    if not locale:
        raise HTTPException(status_code=400, detail="'locale' is required")
    addr = str(raw.get("identifier") or "").strip()
    store = _load()
    pref = store.get("say_preferred")
    if not isinstance(pref, dict):
        pref = {}
    if addr:
        if not say_engine.available():
            raise HTTPException(status_code=400, detail=(
                "macOS say is not available on this server"))
        v = await asyncio.to_thread(say_engine.resolve, addr)
        if v is None:
            raise HTTPException(status_code=404, detail=(
                "'%s' is not an installed macOS voice" % addr[:64]))
        pref[locale] = v.get("identifier") or v["name"]
    else:
        pref.pop(locale, None)
    store["say_preferred"] = pref
    _save(store)
    return {"ok": True, "preferred": pref}


@api_router.post("/voices/say/speech")
async def voices_say_speech(request: Request, _auth=Depends(require_admin)):
    """Audition a system voice from the tab before saving anything.
    Body {name, input?}: the default text is the voice's OWN greeting
    from the roster — every voice introduces itself in its own language."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    name = str(raw.get("name") or "").strip()
    v = await asyncio.to_thread(say_engine.resolve, name)
    if v is None:
        raise HTTPException(status_code=404,
                            detail="'%s' is not an installed macOS voice"
                                   % name[:64])
    text = str(raw.get("input") or v.get("sample")
               or "Hello! My name is %s." % v["name"].split(" (")[0])
    return await _say_response(v["name"], text, speed=raw.get("speed"))


# ---------------------------------------------------------------------------
# TTS-1: per-model speech defaults + clip-less model speech. The store map
# is a SIBLING of say_preferred (same _load/_save discipline); the merge
# tier it feeds is _tts_defaults_merge, applied by every uplift speech
# path. No engine probe on the defaults routes on purpose: the tab's
# model list comes from the manager, and a DEFAULT mark is metadata
# until some synth actually reads it.
# ---------------------------------------------------------------------------

@api_router.get("/voices/tts/defaults")
async def voices_tts_defaults_get(_auth=Depends(require_admin)):
    """TTS-1: the WHOLE {model: {speaker, instructions, language}} map,
    normalized (junk and all-empty rows are not returned). The TEXT TO
    SPEECH tab's DEFAULT badges and the model editor's TTS section both
    prefill from here — one read, no per-model round trips."""
    return {"defaults": _tts_defaults()}


@api_router.post("/voices/tts/defaults")
async def voices_tts_defaults_set(request: Request,
                                  _auth=Depends(require_admin)):
    """TTS-1: set or clear one model's default speaker/instructions/
    language. Body {model, speaker?, instructions?, language?}: a field
    absent or empty is UNSET, and all three empty drops the model key —
    the store never keeps a row that could not change anything. Every
    POST REPLACES the model's whole row (the editor always resends all
    three fields, so a stale field cannot hide in a partial update).
    Caps mirror the voice fields (module constants); values are trimmed
    but otherwise verbatim — 'cs-CZ' and 'CS-cz' are different strings
    to an engine's language table and this server plays no language
    police. Unknown body keys are ignored, never stored."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    model = str(raw.get("model") or "").strip()[:MAX_TTS_MODEL_CHARS]
    if not model:
        raise HTTPException(status_code=400, detail="'model' is required")
    row = {
        "speaker": str(raw.get("speaker") or "").strip()[:MAX_TTS_ID_CHARS],
        "language": str(raw.get("language") or "").strip()[:MAX_TTS_ID_CHARS],
        "instructions": str(raw.get("instructions") or "")
                        .strip()[:MAX_TTS_DEFAULT_INSTRUCT_CHARS],
    }
    store = _load()
    d = store.get("tts_defaults")
    if not isinstance(d, dict):
        d = {}
    if any(row.values()):
        d[model] = row
    else:
        d.pop(model, None)
    store["tts_defaults"] = d
    _save(store)
    return {"ok": True, "defaults": _tts_defaults()}


@api_router.post("/voices/tts/speak")
async def voices_tts_speak(request: Request, _auth=Depends(require_admin)):
    """TTS-1: speak with a MODEL — no stored voice, no reference clip.
    The TEXT TO SPEECH tab auditions a built-in speaker and the model
    editor previews its defaults through exactly this route: the request
    rides _synth_ref's shape minus the clip (ref_audio/ref_text None,
    speaker -> vanilla's `voice` kwarg), wav default. Absent fields
    still pick up tts_defaults[model] — the tab previews what the
    DEFAULT mark actually produces. Unknown model / non-TTS engine /
    synthesis failure: vanilla's honest HTTPExceptions propagate through
    the seam unchanged (same 404/502 semantics as every speech route),
    and a server without the audio module answers the seam's 503."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    model = str(raw.get("model") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    text = str(raw.get("input") or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail="'input' must not be empty")
    if len(text) > MAX_SPEECH_INPUT_CHARS:
        raise HTTPException(status_code=400, detail=(
            "'input' exceeds %d characters" % MAX_SPEECH_INPUT_CHARS))
    # the SAME merge as every other uplift speech path: this route has no
    # stored voice, so it is request > default (say models exempt inside)
    language, instructions, speaker = _tts_defaults_merge(
        model,
        str(raw.get("language") or "").strip() or None,
        str(raw.get("instructions") or "").strip() or None,
        str(raw.get("speaker") or "").strip() or None)
    return await _synth_ref(model, text, None, "",
                            language=language,
                            stream=False, response_format="wav",
                            instructions=instructions, speaker=speaker)


@api_router.post("/voices")
async def voices_create(request: Request, _auth=Depends(require_admin)):
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    store = _load()
    if len(store["voices"]) >= MAX_VOICES:
        raise HTTPException(status_code=507,
                            detail="voice store is full (%d)" % MAX_VOICES)
    # SAY-1: a system voice carries no clip and no speaker — its whole
    # definition is 'say:<installed name>' (or bare 'say' for a voice that
    # routes by language, SAY-2); validate any name against the roster so
    # a typo cannot create a voice that only ever 502s.
    is_say, say_tail = say_engine.say_split(raw.get("model"))
    if is_say:
        if not say_engine.available():
            raise HTTPException(status_code=400, detail=(
                "macOS say is not available on this server"))
        if not await _say_tail_ok(say_tail):
            raise HTTPException(status_code=400, detail=(
                "'%s' is neither an installed macOS voice nor a language "
                "this Mac can speak" % say_tail[:64]))
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
    if not data and raw.get("from_voice"):
        # SAVE AS: reuse a stored voice's clip (re-cloning the SAME voice
        # onto a different model must not force an audio re-upload). The
        # source's extension travels with its bytes.
        src = _find(store, str(raw["from_voice"]))
        if not src:
            raise HTTPException(status_code=404, detail="from_voice not found: %s"
                                % raw["from_voice"])
        rf = src.get("ref_file")
        src_path = (_audio_dir() / Path(rf).name) if rf else None
        if src_path is None or not src_path.is_file():
            raise HTTPException(status_code=409, detail=(
                "reference clip for '%s' is missing from the store" % src["name"]))
        data = src_path.read_bytes()
        ext = src_path.suffix.lower()
    # VOICE-7: a CustomVoice voice is (speaker [+instruct]) with NO ref
    # clip — that is a complete voice; a Base clone needs the clip. The
    # store keeps whichever shape arrived; _synth passes ref only if stored.
    if not data and not str(raw.get("speaker") or "").strip() and not is_say:
        raise HTTPException(status_code=400, detail=(
            "reference audio is required (or a preset speaker for a "
            "CustomVoice model)")
        )
    if len(data) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=(
            "reference audio exceeds %d MiB" % (MAX_VOICE_AUDIO_BYTES // (1024 * 1024))))
    # THE store invariant: ref_file bytes are always real WAV (module
    # docstring). Sniff content, not the name — an mp3 renamed .wav would
    # otherwise poison the voice exactly like an mp3 named honestly.
    # (speaker-only voices carry no clip — nothing to normalize.)
    if data:
        data = _to_wav(data, _sniff_kind(data, ext))
        ext = ".wav"
    taken = {v["id"] for v in store["voices"]}
    v = _sanitize(raw)
    v["id"] = (raw.get("id") or "").strip() or _slug(v["name"], taken)
    if not ID_RE.match(v["id"]):
        raise HTTPException(status_code=400, detail="invalid voice id")
    if v["id"] in taken:
        raise HTTPException(status_code=409,
                            detail="voice id exists: %s" % v["id"])
    v["created"] = int(time.time())
    if data:                        # VOICE-7: a speaker-only voice stores NO clip
        v["ref_file"] = v["id"] + ext
        d = _audio_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / v["ref_file"]).write_bytes(data)
    store["voices"].append(v)
    _save(store)
    return {"ok": True, "voice": {k: v.get(k) for k in
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
    # SAY-1 round trip: editing INTO a system voice validates the name
    # like create does; editing AWAY from one must not strip the voice
    # down to nothing (no clip, no speaker = a voice that cannot speak).
    _is_say, _say_tail = say_engine.say_split(merged.get("model"))
    if _is_say:
        if not say_engine.available():
            raise HTTPException(status_code=400, detail=(
                "macOS say is not available on this server"))
        if not await _say_tail_ok(_say_tail):
            raise HTTPException(status_code=400, detail=(
                "'%s' is neither an installed macOS voice nor a language "
                "this Mac can speak" % _say_tail[:64]))
    elif not (merged.get("ref_file") or v.get("ref_file")) \
            and not (merged.get("speaker") or "").strip():
        raise HTTPException(status_code=400, detail=(
            "this voice has no reference clip — attach one or keep it on "
            "the macOS say engine"))
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
        data = _to_wav(data, _sniff_kind(data, ext))
        old = _audio_dir() / Path(v.get("ref_file", "")).name
        merged["ref_file"] = v["id"] + ".wav"
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
    text = str(raw.get("input") or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail="'input' must not be empty")
    voice_raw = str(raw.get("voice") or "")
    v, model_override, _ = _alias_lookup(voice_raw,
                                         str(raw.get("model") or ""))
    if not v:
        # SAY-2: the native UI (chat read-aloud included) can address a
        # system voice directly — voice 'say:<identifier>' speaks that
        # voice, bare 'say' + language routes through the preferred
        # marks. A STORED voice whose whole name matches still won the
        # lookup above; this leg is only the store miss.
        is_say, say_tail = say_engine.say_split(voice_raw)
        if is_say:
            return await _say_response(
                say_tail, text, speed=raw.get("speed") or None,
                language=raw.get("language") or None)
        names = ", ".join(x["name"] for x in _load()["voices"]) or "(none yet)"
        raise HTTPException(status_code=404,
                            detail="unknown voice; available: %s" % names)
    return await _synth(v, str(raw.get("input") or ""),
                        stream=bool(raw.get("stream")), model=model_override,
                        language=raw.get("language") or None,
                        speed=raw.get("speed") or None,
                        instructions=raw.get("instructions")
                        if "instructions" in raw else None,
                        ref_text=raw.get("ref_text") if "ref_text" in raw
                        else None)


@api_router.post("/voices/transcribe")
async def voices_transcribe(request: Request, _auth=Depends(require_admin)):
    """VOICE-2: transcript for a reference clip, via a locally-installed
    STT model (whisper/Qwen3-ASR/...). Body: {model, ref_audio_b64,
    ref_name?, language?}. The client fills the Reference-text field from
    the answer — the user still confirms/edits it, because cloning quality
    depends on the transcript matching the clip EXACTLY (vanilla rule:
    ref_text ships with every synth)."""
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    model = str(raw.get("model") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="STT model is required")
    b64 = raw.get("ref_audio_b64") or ""
    try:
        data = base64.b64decode(b64, validate=True) if b64 else b""
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="ref_audio_b64 is not valid base64")
    if not data:
        raise HTTPException(status_code=400, detail="audio is required")
    if len(data) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=(
            "audio exceeds %d MiB" % (MAX_VOICE_AUDIO_BYTES // (1024 * 1024))))
    fname = str(raw.get("ref_name") or "clip.wav")
    text = await _create_transcription(data, fname, model, raw.get("language"))
    return {"text": text.strip()}   # the field holds a transcript, not a blob


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
                                raw.get("language"), raw.get("speed"),
                                instructions=raw.get("instructions"),
                                speaker=raw.get("speaker"))
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
#                    … including 'Model:Voice' alias syntax in EITHER the
#                    voice or model field: text after the LAST ':' picks
#                    the stored voice, text before it is a base-model
#                    hint (family prefix keeps the voice's model, any
#                    other prefix overrides it for this synth)
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
    fmt_given = bool(str(body.get("response_format") or "").strip())
    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        return _openai_err(400, "speed must be a float between 0.25 and 4.0.")
    if not 0.25 <= speed <= 4.0:
        return _openai_err(400, "speed must be between 0.25 and 4.0.")
    stream = str(body.get("stream", "")).lower() in ("1", "true", "yes", "on")
    name = str(body.get("voice") or "").strip()
    model = str(body.get("model") or "").strip()
    # 'Model:Voice' alias syntax is accepted in EITHER field (the SDK
    # habit of stuffing everything into `model` is just as common)
    v, model_use, lookup = _alias_lookup(name or model, model)
    # SAY-2: the say engine token may arrive in EITHER field — 'say'
    # (route by the request's language) or 'say:<voice>' (explicit OS
    # identifier or display name, no stored entry needed). A stored
    # voice whose WHOLE string matches still wins: the lookup above
    # tries the complete name first, exactly like every other alias.
    say_hit = None
    if v is None:
        is_say, say_tail = say_engine.say_split(name)
        if is_say:
            say_hit = say_tail
        else:
            is_say, say_tail = say_engine.say_split(model_use or model)
            if is_say:
                say_hit = say_tail
    if not v and name and say_hit is None:
        # spec: unknown voice is a request error; uplift hint (available
        # names) inside the OpenAI body shape
        avail = ", ".join(x["name"] for x in _load()["voices"]) or "(none yet)"
        return _openai_err(404, "Voice '%s' is not a stored uplift voice; "
                                "available: %s" % (name, avail))
    if not model_use and not v and say_hit is None:
        return _openai_err(400, "You must provide a 'model' (or a stored "
                                "voice name in 'voice').")

    try:
        if v:
            _tgt = model_use or v.get("model") or ""
            if say_engine.say_split(_tgt)[0] and not fmt_given:
                fmt = "wav"        # same honest default as the anonymous leg
            resp = await _synth(v, text, fmt=fmt, speed=speed, stream=stream,
                                language=body.get("language") or None,
                                instructions=body.get("instructions") or None,
                                model=model_use)
        elif say_hit is not None:
            # system-voice call with no stored voice: explicit
            # 'say:<Name>'/'say:<identifier>' or bare 'say' + language
            # (SAY-2 preferred routing). The spec's mp3 DEFAULT would
            # force an ffmpeg hop (or a 502 on a server without one) for
            # a caller that never asked for a format; a WAV answer
            # declared as WAV is the honest reading.
            resp = await _say_response(
                say_hit, text,
                speed=speed,
                response_format=fmt if fmt_given else "wav",
                language=body.get("language") or None)
        else:
            # no named voice: pass-through to vanilla — anonymous
            # ref_audio cloning (PR #676 fields) included verbatim.
            # TTS-1 adds the model-default tier: `name` is empty here
            # (a non-empty unknown name 404s above, a say name took the
            # say leg), so request > tts_defaults[model] for
            # language/instructions/speaker(=vanilla voice). No defaults
            # row = the exact pre-TTS-1 request, field for field.
            language, instructions, speaker = _tts_defaults_merge(
                model_use,
                body.get("language") or None,
                body.get("instructions") or None,
                name or None)
            kw = dict(model=model_use, input=text, response_format=fmt,
                      speed=speed, stream=stream,
                      language=language,
                      instructions=instructions,
                      voice=speaker)
            if body.get("ref_audio"):
                kw["ref_audio"] = body["ref_audio"]
                kw["ref_text"] = body.get("ref_text") or None
            resp = await _create_speech(kw)
    except HTTPException as e:
        return _openai_err(e.status_code, str(e.detail))
    return resp
