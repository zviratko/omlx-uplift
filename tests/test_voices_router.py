"""VOICE-1: named voice-cloning voices — router contract.

Vanilla already synthesizes from ref_audio (base64) + ref_text on
/v1/audio/speech; uplift only owns the NAMED-VOICE storage and the proxy.
Doctrine (same as test_nat4_chat_backend): real temp store, every claim
the module docstring makes is pinned here — slug rules, format whitelist,
size caps, no-base64-in-JSON, name-vs-id lookup, and the exact request
the vanilla seam receives. The seam itself (_create_speech) is
monkeypatched: request ASSEMBLY is the uplift code under test; re-faking
vanilla's engine call would test nothing.
"""
from __future__ import annotations

import base64
import json

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift.routers import voices as V


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from omlx_uplift.routers import base as up_base
    monkeypatch.setattr(V, "_store_dir", lambda: tmp_path)
    # SAY-CHAT: pre-arm the one-time web-chat seed flag — a real Mac answers
    # available() True and GET /voices would otherwise probe the live roster
    V._save({"version": 1, "voices": [], "say_chat_seed": True})
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app)


WAV = b"RIFF....WAVEfmt " + b"\0" * 64      # bytes are opaque to the store
B64 = base64.b64encode(WAV).decode()


def _mk(client, name="Jake", model="Qwen3-TTS-12Hz-0.6B-Base-8bit", **kw):
    body = {"name": name, "model": model, "ref_text": "My voice sample.",
            "ref_audio_b64": B64, "ref_name": kw.pop("ref_name", "my.wav")}
    body.update(kw)
    return client.post("/uplift/api/voices", json=body)


def test_create_list_roundtrip_stores_no_base64(client):
    assert client.get("/uplift/api/voices").json() == {"voices": []}
    r = _mk(client)
    assert r.status_code == 200, r.text
    vid = r.json()["voice"]["id"]
    assert vid == "jake"
    lst = client.get("/uplift/api/voices").json()["voices"]
    assert lst[0]["name"] == "Jake" and lst[0]["ref_bytes"] == len(WAV)
    # the store JSON must never carry audio bytes
    store = json.loads((V._store_dir() / "voices.json").read_text())
    assert "ref_audio" not in json.dumps(store) and B64 not in json.dumps(store)
    # audio landed next to it under the voice id
    assert (V._store_dir() / "voices" / (vid + ".wav")).read_bytes() == WAV


def test_slug_and_collisions(client):
    assert _mk(client, name="Jake").json()["voice"]["id"] == "jake"
    assert _mk(client, name="Jake").json()["voice"]["id"] == "jake-2"
    assert _mk(client, name="  !!!  ").json()["voice"]["id"] == "voice"
    assert _mk(client, name="Ünicode Näme").json()["voice"]["id"] == "nicode-n-me"


@pytest.mark.parametrize("ref_name,code", [
    ("my.webm", 400), ("clip.m4a", 400), ("noext", 400)])
def test_format_whitelist_no_ffmpeg(client, ref_name, code):
    r = _mk(client, ref_name=ref_name)
    assert r.status_code == code and "flac/mp3/wav" in r.json()["detail"]


def test_size_caps_and_validation(client):
    big = base64.b64encode(b"\0" * (V.MAX_VOICE_AUDIO_BYTES + 1)).decode()
    assert _mk(client, ref_audio_b64=big).status_code == 413
    assert _mk(client, ref_audio_b64="!!!not-base64!!!").status_code == 400
    assert _mk(client, ref_audio_b64="").status_code == 400
    assert _mk(client, name="").status_code == 400
    assert _mk(client, model="").status_code == 400


def test_update_swap_keeps_single_audio(client):
    vid = _mk(client).json()["voice"]["id"]
    audio = V._store_dir() / "voices" / (vid + ".wav")
    assert audio.is_file()
    # WAV bytes even under a .mp3 name pass through untouched (content is
    # the authority); the swap payload stays a legal clip post-invariant
    WAVE2 = b"RIFF\x24\x00\x00\x00WAVEfmt new-take" + b"\1" * 32
    r = client.put("/uplift/api/voices/" + vid, json={
        "name": "Jake", "model": "other-tts", "ref_text": "new sample",
        "ref_audio_b64": base64.b64encode(WAVE2).decode(),
        "ref_name": "take2.mp3"})
    assert r.status_code == 200
    assert V._load()["voices"][0]["model"] == "other-tts"
    assert audio.read_bytes() == WAVE2
    # update WITHOUT new audio edits metadata only, file survives
    assert client.put("/uplift/api/voices/" + vid, json={
        "name": "Jay", "model": "other-tts",
        "ref_text": "kept"}).status_code == 200
    assert audio.is_file() and V._load()["voices"][0]["name"] == "Jay"
    assert client.put("/uplift/api/voices/nope", json={
        "name": "x", "model": "y"}).status_code == 404


def test_delete_removes_record_and_audio(client):
    vid = _mk(client).json()["voice"]["id"]
    audio = V._store_dir() / "voices" / (vid + ".wav")
    assert client.delete("/uplift/api/voices/" + vid).json()["deleted"] == vid
    assert not audio.exists() and V._load()["voices"] == []
    assert client.delete("/uplift/api/voices/" + vid).status_code == 404


# ---------------- speech proxy: assembly is the uplift code --------------

@pytest.fixture()
def fake_speech(monkeypatch):
    seen = {}

    async def _fake(kwargs):
        seen.update(kwargs)
        return Response(content=b"OFAKEAUDIO", media_type="audio/wav")
    monkeypatch.setattr(V, "_create_speech", _fake)
    return seen


def test_speech_by_id_attaches_stored_clip(client, fake_speech):
    vid = _mk(client).json()["voice"]["id"]
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": vid, "input": "Hello world"})
    assert r.status_code == 200 and r.content == b"OFAKEAUDIO"
    assert r.headers["content-type"] == "audio/wav"
    assert fake_speech["input"] == "Hello world"
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV
    assert fake_speech["ref_text"] == "My voice sample."
    assert fake_speech["stream"] is False


def test_speech_by_display_name_case_insensitive(client, fake_speech):
    _mk(client, name="David")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "david", "input": "hi"})
    assert r.status_code == 200 and fake_speech["model"].startswith("Qwen3-TTS")


def test_speech_unknown_voice_lists_available(client, fake_speech):
    _mk(client, name="Jake")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "ghost", "input": "hi"})
    assert r.status_code == 404 and "Jake" in r.json()["detail"]


def test_speech_missing_audio_file_is_honest(client, fake_speech):
    vid = _mk(client).json()["voice"]["id"]
    (V._store_dir() / "voices" / (vid + ".wav")).unlink()
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": vid, "input": "hi"})
    assert r.status_code == 500 and "missing" in r.json()["detail"]


def test_speech_empty_input(client, fake_speech):
    vid = _mk(client).json()["voice"]["id"]
    assert client.post("/uplift/api/voices/speech",
                       json={"voice": vid, "input": "  "}).status_code == 400


def test_no_audio_module_is_503_through_the_real_seam(client):
    # standalone-viewer shape: this one must NOT stub _create_speech —
    # the 503 lives INSIDE the seam, so it is the only test that exercises
    # the real import path
    vid = _mk(client).json()["voice"]["id"]
    import builtins
    real_import = builtins.__import__

    def boom(name, *a, **k):
        if name.startswith("omlx.api.audio"):
            raise ImportError(name)
        return real_import(name, *a, **k)
    builtins.__import__ = boom
    try:
        r = client.post("/uplift/api/voices/speech",
                        json={"voice": vid, "input": "hi"})
    finally:
        builtins.__import__ = real_import
    assert r.status_code == 503 and "TTS is not available" in r.json()["detail"]


def test_preview_uses_ad_hoc_fields_and_leaves_no_file(client, fake_speech):
    r = client.post("/uplift/api/voices/preview", json={
        "model": "some-tts", "ref_text": "sample", "ref_audio_b64": B64,
        "ref_name": "p.wav", "input": "preview me"})
    assert r.status_code == 200 and r.content == b"OFAKEAUDIO"
    assert fake_speech["model"] == "some-tts"
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV
    # nothing stored: no voice rows added by the preview (the fixture's
    # pre-armed say_chat_seed marker rides the store, that is not a row)
    assert V._load()["voices"] == []
    tmp = V._store_dir() / "tmp"
    assert not tmp.exists() or list(tmp.iterdir()) == []  # temp cleaned
    # bad format rejected before any synth
    assert client.post("/uplift/api/voices/preview", json={
        "model": "m", "ref_audio_b64": B64, "ref_name": "x.webm",
        "input": "y"}).status_code == 400


def test_store_cap(client, monkeypatch):
    monkeypatch.setattr(V, "MAX_VOICES", 2)
    assert _mk(client, name="a").status_code == 200
    assert _mk(client, name="b").status_code == 200
    assert _mk(client, name="c").status_code == 507


# --------------------------------------------------------------------------
# POST /uplift/v1/audio/speech — the STANDARD OpenAI surface. Same seam,
# same store; the contract under test is the SPEC SHAPE: form or JSON or
# multipart body, mp3 default, response_format/speed/stream forwarded,
# OpenAI error bodies, auth errors in-band (401 authentication_error).
# --------------------------------------------------------------------------

@pytest.fixture()
def std_client(monkeypatch, tmp_path):
    monkeypatch.setattr(V, "_store_dir", lambda: tmp_path)
    async def _ok(request):
        return True
    monkeypatch.setattr(V, "_infer_auth", _ok)
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.include_router(_up.page_router)
    from omlx_uplift.routers import base as up_base
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app, raise_server_exceptions=False), None


def test_std_named_voice_form_body_default_mp3(std_client, fake_speech):
    client, _ = std_client
    _mk(client, name="Jake")
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "Jake", "input": "hello"})
    assert r.status_code == 200 and r.content == b"OFAKEAUDIO"
    assert fake_speech["response_format"] == "mp3"          # spec default
    assert fake_speech["model"] == "Qwen3-TTS-12Hz-0.6B-Base-8bit"
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV


def test_std_json_body_forwards_format_speed_stream(std_client, fake_speech):
    client, _ = std_client
    _mk(client, name="David", model="m-base")
    r = client.post("/uplift/v1/audio/speech", json={
        "model": "override-tts", "voice": "David", "input": "hi",
        "response_format": "flac", "speed": 1.5, "stream": True,
        "language": "cs"})
    assert r.status_code == 200, r.text
    assert fake_speech["model"] == "override-tts"           # explicit wins
    assert fake_speech["response_format"] == "flac"
    assert fake_speech["speed"] == 1.5
    assert fake_speech["stream"] is True
    assert fake_speech["language"] == "cs"


def test_std_multipart_ignores_file_parts(std_client, fake_speech):
    client, _ = std_client
    _mk(client, name="Jake")
    import io
    files = {"ref_audio": ("x.wav", io.BytesIO(b"ignored-by-design"))}
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "jake", "input": "multipart"}, files=files)
    assert r.status_code == 200, r.text
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV   # STORED clip


def test_std_passthrough_without_voice(std_client, fake_speech):
    client, _ = std_client
    r = client.post("/uplift/v1/audio/speech", data={
        "model": "plain-tts", "input": "anon clone",
        "ref_audio": B64, "ref_text": "sample transcript"})
    assert r.status_code == 200, r.text
    assert fake_speech["model"] == "plain-tts"
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV  # verbatim
    assert fake_speech["ref_text"] == "sample transcript"


def test_std_errors_use_openai_bodies(std_client, fake_speech):
    client, _ = std_client
    r = client.post("/uplift/v1/audio/speech", data={"voice": "Jake"})
    e = r.json()["error"]
    assert r.status_code == 400 and e["type"] == "invalid_request_error" \
        and "input" in e["message"]
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "Ghost", "input": "hi"})
    assert r.status_code == 404 and r.json()["error"]["type"] == "not_found_error"
    r = client.post("/uplift/v1/audio/speech", data={"input": "orphan text"})
    assert r.status_code == 400 and "model" in r.json()["error"]["message"]
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "Jake", "input": "x", "speed": "9"})
    assert r.status_code == 400 and "0.25" in r.json()["error"]["message"]


def test_std_auth_failure_is_authentication_error(std_client, fake_speech,
                                                  monkeypatch):
    client, _ = std_client
    from fastapi import HTTPException as FH
    async def deny(request):
        raise FH(status_code=401, detail="Invalid API key")
    monkeypatch.setattr(V, "_infer_auth", deny)
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "Jake", "input": "hi"})
    assert r.status_code == 401 and r.json()["error"]["type"] == "authentication_error"


# --------------------------------------------------------------------------
# 'Model:Voice' alias syntax — vanilla rejects ':' in profile ids so the
# alias cannot be a stored MODEL alias; instead the speech resolvers parse
# the composite: after the LAST ':' picks the voice, before it is a base-
# model hint (family prefix keeps the stored model, any other overrides).
# Whole-string lookup runs FIRST: display names may themselves contain ':'.
# --------------------------------------------------------------------------

def test_alias_native_route_family_hint_keeps_stored_model(client, fake_speech):
    _mk(client, name="Jake")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "Qwen3-TTS:Jake", "input": "alias me"})
    assert r.status_code == 200, r.text
    # 'qwen3-tts' is a substring of the stored model -> hint, not override
    assert fake_speech["model"] == "Qwen3-TTS-12Hz-0.6B-Base-8bit"
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV


def test_alias_native_route_foreign_prefix_overrides_model(client, fake_speech):
    _mk(client, name="Jake")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "some-other-tts:Jake", "input": "x"})
    assert r.status_code == 200, r.text
    assert fake_speech["model"] == "some-other-tts"         # clip survives
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV


def test_alias_explicit_model_field_wins(client, fake_speech):
    _mk(client, name="Jake")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "hint:Jake", "model": "chosen-tts",
                          "input": "x"})
    assert r.status_code == 200 and fake_speech["model"] == "chosen-tts"


def test_alias_display_name_containing_colon(client, fake_speech):
    _mk(client, name="Radio: Jake")                        # id radio--jake
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "Radio: Jake", "input": "x"})
    assert r.status_code == 200, r.text
    assert fake_speech["model"] == "Qwen3-TTS-12Hz-0.6B-Base-8bit"


def test_alias_unknown_tail_still_404(client):
    _mk(client, name="Jake")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "Qwen3-TTS:Ghost", "input": "x"})
    assert r.status_code == 404


def test_std_alias_in_voice_field(std_client, fake_speech):
    client, _ = std_client
    _mk(client, name="Jake")
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "Qwen3-TTS-12Hz-0.6B-Base-8bit:Jake",
                          "input": "std alias"})
    assert r.status_code == 200, r.text
    assert fake_speech["model"] == "Qwen3-TTS-12Hz-0.6B-Base-8bit"
    assert base64.b64decode(fake_speech["ref_audio"]) == WAV


def test_std_alias_in_model_field(std_client, fake_speech):
    client, _ = std_client
    _mk(client, name="Jake")
    # SDK users who stuff everything into `model` reach the same voice
    r = client.post("/uplift/v1/audio/speech",
                    data={"model": "Qwen3-TTS:Jake", "input": "via model"})
    assert r.status_code == 200, r.text
    assert fake_speech["model"] == "Qwen3-TTS-12Hz-0.6B-Base-8bit"


# --------------------------------------------------------------------------
# VOICE-2: /voices/transcribe — auto-transcribe the reference clip via a
# local STT model. Same seam doctrine as speech: request ASSEMBLY is the
# uplift code under test, vanilla's engine call is monkeypatched (and the
# 503 branch lives INSIDE the seam).
# --------------------------------------------------------------------------

def test_transcribe_passes_clip_bytes_and_model(client, monkeypatch):
    seen = {}
    async def fake(data, filename, model, language=None):
        seen.update(data=data, filename=filename, model=model, language=language)
        return "  This is what my voice sounds like.  "
    monkeypatch.setattr(V, "_create_transcription", fake)
    r = client.post("/uplift/api/voices/transcribe",
                    json={"model": "whisper-tiny-mlx-4bit",
                          "ref_audio_b64": B64, "ref_name": "my.wav"})
    assert r.status_code == 200
    # text arrives trimmed — the field is a transcript, not a blob
    assert r.json() == {"text": "This is what my voice sounds like."}
    assert seen["data"] == WAV and seen["filename"] == "my.wav"
    assert seen["model"] == "whisper-tiny-mlx-4bit"
    assert seen["language"] is None


def test_transcribe_validation(client, monkeypatch):
    async def ok(data, filename, model, language=None):
        return "ok"
    monkeypatch.setattr(V, "_create_transcription", ok)
    assert client.post("/uplift/api/voices/transcribe",
                       json={"ref_audio_b64": B64}).status_code == 400
    assert client.post("/uplift/api/voices/transcribe",
                       json={"model": "m"}).status_code == 400
    assert client.post("/uplift/api/voices/transcribe",
                       json={"model": "m", "ref_audio_b64": "!!!"}).status_code == 400
    assert client.post("/uplift/api/voices/transcribe",
                       json={"model": "m", "ref_audio_b64": ""}).status_code == 400
    # ext is deliberately NOT whitelisted: vanilla's STT decoder owns
    # format honesty (miniaudio + its own error); the real flow passes
    # an already-whitelisted clip, and an exotic one gets vanilla's 400
    r = client.post("/uplift/api/voices/transcribe",
                    json={"model": "m", "ref_audio_b64": B64,
                          "ref_name": "x.webm"})
    assert r.status_code == 200, r.text


def test_transcribe_size_cap(client, monkeypatch):
    big = base64.b64encode(b"\0" * (V.MAX_VOICE_AUDIO_BYTES + 1)).decode()
    r = client.post("/uplift/api/voices/transcribe",
                    json={"model": "m", "ref_audio_b64": big})
    assert r.status_code == 413


def test_transcribe_503_without_omlx(client, monkeypatch):
    # the no-STT shape: the seam raises the router's own 503 (soft-import
    # branch lives INSIDE _create_transcription, mirroring _create_speech)
    from fastapi import HTTPException as FH
    async def down(*a, **k):
        raise FH(status_code=503, detail="STT is not available on this server")
    monkeypatch.setattr(V, "_create_transcription", down)
    r = client.post("/uplift/api/voices/transcribe",
                    json={"model": "m", "ref_audio_b64": B64})
    assert r.status_code == 503 and "not available" in r.json()["detail"]


# --------------------------------------------------------------------------
# VOICE-4: save-as / edit — re-clone an EXISTING clip onto another model
# without re-uploading audio (from_voice), and full-field PUT edits.
# --------------------------------------------------------------------------

def test_save_as_reuses_stored_clip(client):
    vid = _mk(client, name="Jake").json()["voice"]["id"]
    r = client.post("/uplift/api/voices", json={
        "name": "Jake Big", "model": "other-tts-4b",
        "ref_text": "My voice sample.", "from_voice": vid})
    assert r.status_code == 200, r.text
    nid = r.json()["voice"]["id"]
    assert nid == "jake-big"
    # the bytes were COPIED, not moved: both clips on disk, same content
    d = V._store_dir() / "voices"
    assert (d / (vid + ".wav")).read_bytes() == WAV
    assert (d / (nid + ".wav")).read_bytes() == WAV
    lst = {v["id"]: v for v in client.get("/uplift/api/voices").json()["voices"]}
    assert lst[nid]["model"] == "other-tts-4b"


def test_save_as_validation(client):
    assert client.post("/uplift/api/voices", json={
        "name": "X", "model": "m", "from_voice": "ghost"}).status_code == 404
    vid = _mk(client, name="Jake").json()["voice"]["id"]
    # clip file gone -> honest 409 (store edit by hand)
    (V._store_dir() / "voices" / (vid + ".wav")).unlink()
    r = client.post("/uplift/api/voices", json={
        "name": "X", "model": "m", "from_voice": vid})
    assert r.status_code == 409 and "missing" in r.json()["detail"]


def test_update_can_change_model_and_text(client):
    _mk(client, name="Jake")
    r = client.put("/uplift/api/voices/jake", json={
        "name": "Jake", "model": "swapped-tts", "ref_text": "new transcript"})
    assert r.status_code == 200, r.text
    v = client.get("/uplift/api/voices").json()["voices"][0]
    assert v["model"] == "swapped-tts" and v["ref_text"] == "new transcript"
    assert v["ref_bytes"] == len(WAV)      # clip untouched by a text/model edit


def test_speech_ref_text_override_for_editor_preview(client, fake_speech):
    # VOICE-4: the editor previews a NEW transcript against the stored
    # clip; absent field keeps the stored one (edit-truthful preview)
    _mk(client, name="Jake")
    client.put("/uplift/api/voices/jake", json={
        "name": "Jake", "model": "Qwen3-TTS-12Hz-0.6B-Base-8bit",
        "ref_text": "Original stored line."})
    client.post("/uplift/api/voices/speech",
                json={"voice": "jake", "input": "hi"})
    assert fake_speech["ref_text"] == "Original stored line."
    client.post("/uplift/api/voices/speech",
                json={"voice": "jake", "input": "hi", "ref_text": "typed edit"})
    assert fake_speech["ref_text"] == "typed edit"


def test_update_keeps_unlisted_fields_when_client_sends_them(client):
    # contract behind the editor's passthrough: a PUT carrying language/
    # speed keeps them; the form echoes fields it does not render
    _mk(client, name="Jake", language="cs", speed=1.3)
    client.put("/uplift/api/voices/jake", json={
        "name": "Jake", "model": "m2", "ref_text": "t",
        "language": "cs", "speed": 1.3})
    v = client.get("/uplift/api/voices").json()["voices"][0]
    assert v["language"] == "cs" and v["speed"] == 1.3


# ------------- mp3/flac references: ffmpeg transcode, honest failure ------
# vanilla writes ref bytes to a FIXED .wav-suffixed tempfile, so the store
# may only ever hold real WAV. These pin that invariant end to end.

MP3_BYTES = b"ID3\x04\x00\x00" + b"\x11" * 120
FAKE_WAV = b"RIFF\x24\x00\x00\x00WAVEfmt fake-output"


def _fake_ffmpeg(tmp_path, monkeypatch, out=FAKE_WAV):
    import sys
    exe = tmp_path / "ffmpeg"
    exe.write_text("#!%s\nimport sys\nopen(sys.argv[-1], 'wb').write(%r)\n"
                   % (sys.executable, out))
    exe.chmod(0o755)
    monkeypatch.setattr(V.shutil, "which",
                        lambda name: str(exe) if name == "ffmpeg" else None)
    return exe


def test_mp3_reference_transcoded_with_ffmpeg(client, monkeypatch, tmp_path):
    _fake_ffmpeg(tmp_path, monkeypatch)
    r = client.post("/uplift/api/voices", json={
        "name": "Mira", "model": "Qwen3-TTS-12Hz-0.6B-Base-8bit",
        "ref_text": "sample", "ref_name": "clip.mp3",
        "ref_audio_b64": base64.b64encode(MP3_BYTES).decode()})
    assert r.status_code == 200, r.text
    vid = r.json()["voice"]["id"]
    assert r.json()["voice"]["ref_file"] == vid + ".wav"
    # the STORE holds the converted bytes, never the mp3
    stored = V._store_dir() / "voices" / (vid + ".wav")
    assert stored.read_bytes() == FAKE_WAV


def test_mp3_reference_without_ffmpeg_fails_415(client, monkeypatch):
    monkeypatch.setattr(V.shutil, "which", lambda name: None)
    r = client.post("/uplift/api/voices", json={
        "name": "Mira", "model": "m", "ref_text": "sample",
        "ref_name": "clip.mp3",
        "ref_audio_b64": base64.b64encode(MP3_BYTES).decode()})
    assert r.status_code == 415
    assert "no ffmpeg" in r.json()["detail"] and "WAV" in r.json()["detail"]


def test_content_beats_extension(client, monkeypatch):
    # a real WAV named .mp3 stores WITHOUT touching ffmpeg; an mp3 lying
    # behind .wav gets converted (or 415 without ffmpeg)
    monkeypatch.setattr(V.shutil, "which", lambda name: None)
    r = _mk(client, ref_name="honest-mistake.mp3")   # WAV bytes, .mp3 name
    assert r.status_code == 200, r.text
    vid = r.json()["voice"]["id"]
    assert (V._store_dir() / "voices" / (vid + ".wav")).read_bytes() == WAV
    r2 = client.post("/uplift/api/voices", json={
        "name": "Liar", "model": "m", "ref_text": "s",
        "ref_name": "okay.wav",                        # mp3 bytes, .wav name
        "ref_audio_b64": base64.b64encode(MP3_BYTES).decode()})
    assert r2.status_code == 415


def test_speaker_only_voice_never_reaches_the_converter(client, monkeypatch):
    monkeypatch.setattr(V.shutil, "which", lambda name: None)
    r = client.post("/uplift/api/voices", json={
        "name": "Viv", "model": "Qwen3-TTS-CustomVoice", "speaker": "vivian",
        "ref_text": "", "ref_audio_b64": ""})
    assert r.status_code == 200, r.text


def test_legacy_mp3_clip_migrates_on_first_synth(client, monkeypatch,
                                                 tmp_path, fake_speech):
    _fake_ffmpeg(tmp_path, monkeypatch)
    vid = _mk(client).json()["voice"]["id"]
    clip = V._store_dir() / "voices" / (vid + ".wav")
    clip.write_bytes(MP3_BYTES)          # simulate a pre-invariant store
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": vid, "input": "hi"})
    assert r.status_code == 200, r.text
    assert base64.b64decode(fake_speech["ref_audio"]) == FAKE_WAV
    assert clip.read_bytes() == FAKE_WAV          # migrated in place


def test_legacy_mp3_clip_without_ffmpeg_fails_honestly(client, monkeypatch,
                                                       fake_speech):
    monkeypatch.setattr(V.shutil, "which", lambda name: None)
    vid = _mk(client).json()["voice"]["id"]
    clip = V._store_dir() / "voices" / (vid + ".wav")
    clip.write_bytes(MP3_BYTES)
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": vid, "input": "hi"})
    assert r.status_code == 415 and "no ffmpeg" in r.json()["detail"]
