"""VOICE-5/6/7/8: voice-profile fields + capability probe + design route.

Doctrine inherited from the VOICE-1 tests: request ASSEMBLY at the
uplift/vanilla seam is the code under test; _create_speech stays faked.
These cards are the Qwen3-TTS specific fields (language was already
stored; instruct/speaker/design are new) — the router tests pin the
store, the forwarding, and the server-side capability gate that keeps
non-qwen3 engines silent in the UI."""
from __future__ import annotations

import base64
import json
import sys

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


@pytest.fixture()
def fake_speech(monkeypatch):
    seen = {}

    async def _fake(kwargs):
        seen.update(kwargs)
        return Response(content=b"OFAKEAUDIO", media_type="audio/wav")
    monkeypatch.setattr(V, "_create_speech", _fake)
    return seen


WAV = b"RIFF....WAVEfmt " + b"\0" * 64
B64 = base64.b64encode(WAV).decode()


def _mk(client, **kw):
    body = {"name": kw.pop("name", "Jake"),
            "model": kw.pop("model", "Qwen3-TTS-12Hz-0.6B-Base-8bit"),
            "ref_text": "My voice sample.",
            "ref_audio_b64": B64, "ref_name": "my.wav"}
    body.update(kw)
    r = client.post("/uplift/api/voices", json=body)
    assert r.status_code == 200, r.text
    return r.json()["voice"]["id"]


# ---------------- VOICE-5: language (plumbing pre-existed; now UI-driven) --

def test_language_stores_forwards_and_clears(client, fake_speech):
    vid = _mk(client, language="english")
    assert V._load()["voices"][0]["language"] == "english"
    client.post("/uplift/api/voices/speech", json={"voice": vid, "input": "hi"})
    assert fake_speech["language"] == "english"
    # Auto = the key absent (the engine auto-adapts when language is None)
    vid2 = _mk(client, name="Auto", )
    assert "language" not in V._load()["voices"][1]
    # a PUT that drops the field clears it (the pop rule)
    client.put("/uplift/api/voices/" + vid, json={
        "name": "Jake", "model": "Qwen3-TTS-12Hz-0.6B-Base-8bit",
        "ref_text": "My voice sample."})
    assert "language" not in V._load()["voices"][0]


# ---------------- VOICE-6: instruct (style control) ----------------

def test_instructions_store_forward_and_cap(client, fake_speech):
    long = "x" * (V.MAX_INSTRUCT_CHARS + 500)
    vid = _mk(client, instructions=long)
    stored = V._load()["voices"][0]["instructions"]
    assert stored == "x" * V.MAX_INSTRUCT_CHARS, "capped, never rejected silently"
    client.post("/uplift/api/voices/speech", json={"voice": vid, "input": "hi"})
    assert fake_speech["instructions"] == stored
    # a plain speech call with no request override uses the STORED value
    client.post("/uplift/api/voices/speech", json={"voice": vid, "input": "hi"})
    assert fake_speech["instructions"] == stored


def test_speech_request_override_does_not_persist(client, fake_speech):
    vid = _mk(client, instructions="Very happy.")
    client.post("/uplift/api/voices/speech", json={
        "voice": vid, "input": "hi", "instructions": "Angry!"})
    assert fake_speech["instructions"] == "Angry!"
    assert V._load()["voices"][0]["instructions"] == "Very happy."


def test_preview_carries_instructions(client, fake_speech):
    client.post("/uplift/api/voices/preview", json={
        "model": "Qwen3-TTS-12Hz-0.6B-Base-8bit", "ref_audio_b64": B64,
        "ref_name": "r.wav", "ref_text": "t", "input": "hi",
        "instructions": "whispered"})
    assert fake_speech["instructions"] == "whispered"


# ---------------- VOICE-7: speaker presets + speed ----------------

def test_speaker_only_voice_needs_no_clip(client, fake_speech):
    vid = _mk(client, name="Vivian", speaker="vivian", ref_audio_b64="",
              ref_text="")
    v = V._load()["voices"][0]
    assert v["speaker"] == "vivian" and "ref_file" not in v
    assert not (V._store_dir() / "voices" / (vid + ".wav")).exists()
    client.post("/uplift/api/voices/speech", json={"voice": vid, "input": "hi"})
    assert fake_speech["voice"] == "vivian"
    assert fake_speech["ref_audio"] is None       # vanilla preset path
    assert fake_speech["ref_text"] is None


def test_no_clip_no_speaker_still_400(client):
    r = client.post("/uplift/api/voices", json={
        "name": "Empty", "model": "m", "ref_text": "", "ref_audio_b64": ""})
    assert r.status_code == 400 and "speaker" in r.json()["detail"]


def test_speaker_and_language_and_instruct_combine(client, fake_speech):
    vid = _mk(client, name="Rya", speaker="ryan", language="english",
              instructions="Very happy.", speed=1.4)
    client.post("/uplift/api/voices/speech", json={"voice": vid, "input": "hi"})
    assert fake_speech["voice"] == "ryan"
    assert fake_speech["language"] == "english"
    assert fake_speech["instructions"] == "Very happy."
    assert fake_speech["speed"] == 1.4


def test_list_rows_expose_the_new_fields(client):
    _mk(client, speaker="serena", instructions="calm", language="japanese")
    row = client.get("/uplift/api/voices").json()["voices"][0]
    assert (row["speaker"], row["instructions"], row["language"]) == \
        ("serena", "calm", "japanese")


# ---------------- capability probe ----------------

class _Entry:
    def __init__(self, d): self.model_path = str(d)


@pytest.fixture()
def fake_pool(monkeypatch, tmp_path):
    """Patch the probe's ONLY two vanilla imports the way audio_routes
    itself is patched in omlx tests (pool + resolve)."""
    state = {"type": "base", "qwen3": True, "langs": None, "spk": None,
             "model_type": "qwen3_tts"}
    d = tmp_path / "model"
    d.mkdir()

    def write_cfg():
        tc = {}
        if state["langs"]:
            tc["codec_language_id"] = {k: i for i, k in enumerate(state["langs"])}
        if state["spk"]:
            tc["spk_id"] = {k: i for i, k in enumerate(state["spk"])}
        j = {"model_type": state["model_type"]}
        if state["qwen3"]:
            # real qwen3 checkpoints: tts_model_type + the talker tables
            j["tts_model_type"] = state["type"]
            j["talker_config"] = tc
        (d / "config.json").write_text(json.dumps(j))

    class _Pool:
        def get_entry(self, mid): return _Entry(d)

    import sys, types
    ar = types.ModuleType("omlx.api.audio_routes")
    ar._get_engine_pool = lambda: _Pool()
    ar._resolve_model = lambda m: m
    omlx = types.ModuleType("omlx"); api = types.ModuleType("omlx.api")
    omlx.api = api; api.audio_routes = ar
    monkeypatch.setitem(sys.modules, "omlx", omlx)
    monkeypatch.setitem(sys.modules, "omlx.api", api)
    monkeypatch.setitem(sys.modules, "omlx.api.audio_routes", ar)
    write_cfg()
    return state, write_cfg


def test_capabilities_base(client, fake_pool):
    state, write = fake_pool
    state.update(langs=["chinese", "english"], spk=None); write()
    c = client.get("/uplift/api/voices/capabilities",
                   params={"model": "Qwen3-TTS-12Hz-0.6B-Base-8bit"}).json()
    assert c["qwen3"] is True and c["type"] == "base"
    assert c["languages"] == ["auto", "chinese", "english"]
    assert c["speakers"] == []


def test_capabilities_custom_voice(client, fake_pool):
    state, write = fake_pool
    state.update(type="custom_voice", langs=["english"],
                 spk=["Vivian", "Ryan", "Uncle_Fu"]); write()
    c = client.get("/uplift/api/voices/capabilities",
                   params={"model": "cv"}).json()
    assert c["type"] == "custom_voice" and c["speakers"] == \
        ["Ryan", "Uncle_Fu", "Vivian"]      # sorted (UI fills options verbatim)


def test_capabilities_dialect_keys_filtered(client, fake_pool):
    state, write = fake_pool
    state.update(langs=["chinese", "beijing_dialect", "sichuan_dialect"]); write()
    c = client.get("/uplift/api/voices/capabilities", params={"model": "x"}).json()
    assert c["languages"] == ["auto", "chinese"]


def test_capabilities_non_qwen3_stays_silent(client, fake_pool):
    state, write = fake_pool
    state.update(qwen3=False, model_type="kokoro"); write()
    # kokoro-style: a voices/ DIRECTORY and no talker_config at all
    c = client.get("/uplift/api/voices/capabilities",
                   params={"model": "Kokoro"}).json()
    assert c == {"model": "Kokoro", "qwen3": False, "type": "", "size": "",
                 "languages": [], "speakers": [], "instruct": False}


def test_capabilities_without_omlx_answers_empty(client, monkeypatch):
    # standalone-viewer mode: the probe import fails -> honest empty shape,
    # 200. sys.modules[...] = None makes `from omlx.api.audio_routes` raise
    # ImportError WITHOUT touching the real keg modules other tests import
    # (monkeypatch restores the entry).
    monkeypatch.setitem(sys.modules, "omlx.api.audio_routes", None)
    c = client.get("/uplift/api/voices/capabilities", params={"model": "m"}).json()
    assert c == {"model": "m", "qwen3": False, "type": "", "size": "",
                 "languages": [], "speakers": [], "instruct": False}


# ---------------- VOICE-8: design route ----------------

def test_design_requires_voice_design_checkpoint(client, fake_pool):
    state, write = fake_pool
    state.update(type="base", langs=["english"]); write()
    r = client.post("/uplift/api/voices/design", json={
        "model": "Qwen3-TTS-12Hz-0.6B-Base-8bit", "instruct": "warm male"})
    assert r.status_code == 400 and "not a Qwen3-TTS VoiceDesign" in r.json()["detail"]


def test_design_synths_from_description_only(client, fake_pool, monkeypatch):
    state, write = fake_pool
    state.update(type="voice_design", langs=["english"]); write()
    seen = {}

    async def _fake(kwargs):
        seen.update(kwargs)
        return Response(content=b"WAVBYTES", media_type="audio/wav")
    monkeypatch.setattr(V, "_create_speech", _fake)
    r = client.post("/uplift/api/voices/design", json={
        "model": "vd", "instruct": "A cheerful young female voice",
        "input": "Hello!", "language": "english"})
    assert r.status_code == 200 and r.content == b"WAVBYTES"
    assert seen["instructions"] == "A cheerful young female voice"
    assert seen["ref_audio"] is None and seen["ref_text"] is None
    assert seen["language"] == "english"
    assert seen["input"] == "Hello!"


def test_design_validation(client):
    assert client.post("/uplift/api/voices/design",
                       json={"model": "m"}).status_code == 400
    assert client.post("/uplift/api/voices/design",
                       json={"instruct": "x"}).status_code == 400
