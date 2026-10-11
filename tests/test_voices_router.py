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
    r = client.put("/uplift/api/voices/" + vid, json={
        "name": "Jake", "model": "other-tts", "ref_text": "new sample",
        "ref_audio_b64": base64.b64encode(b"NEW").decode(),
        "ref_name": "take2.wav"})
    assert r.status_code == 200
    assert V._load()["voices"][0]["model"] == "other-tts"
    assert audio.read_bytes() == b"NEW"
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
    assert V._load() == {"version": 1, "voices": []}      # nothing stored
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
