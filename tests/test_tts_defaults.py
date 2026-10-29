"""TTS-1: per-model TTS defaults — store contract + the merge tier.

Doctrine inherited from the VOICE-1 tests: request ASSEMBLY at the
_create_speech seam is the uplift code under test; the seam stays faked.
Pinned here: the 'tts_defaults' store shape (all-three-empty drops the
model key, rows carry ONLY the three fields, other store sections
survive), GET/POST roundtrip + clear + caps + verbatim locales (no case
folding anywhere) + junk-body 400s, and THE resolution order —
request > stored voice field > tts_defaults[model] — proven on every
speech path (native /voices/speech, the standard /uplift/v1 voice leg
AND its anonymous passthrough leg, /voices/tts/speak). The say engine is
proved UNTOUCHED: a 'say' voice still routes through say_preferred even
when the store carries defaults under the model key 'say', and a model
with no defaults row passes through byte-identically to pre-TTS-1.

The capability-probe extension (scope addition) is pinned at the bottom:
type/size/instruct read from checkpoint CONFIG only — custom_voice 1b7
can instruct, 0b6 cannot (official Qwen3-TTS model card), voice_design
always can, base never can, an absent tts_model_type falls back to the
spk_id table, absent/unknown size never guesses to True — and non-qwen3
answers carry the same key set.
"""
from __future__ import annotations

import base64
import json
import sys

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift import say_engine as SE
from omlx_uplift.routers import voices as V


WAV = b"RIFF....WAVEfmt " + b"\0" * 64
B64 = base64.b64encode(WAV).decode()
MODEL = "Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from omlx_uplift.routers import base as up_base
    monkeypatch.setattr(V, "_store_dir", lambda: tmp_path)
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.include_router(_up.page_router)
    app.dependency_overrides[up_base.require_admin] = lambda: True

    async def _ok(request):
        return True
    monkeypatch.setattr(V, "_infer_auth", _ok)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture()
def fake_speech(monkeypatch):
    seen = {}

    async def _fake(kwargs):
        seen.update(kwargs)
        return Response(content=b"OFAKEAUDIO", media_type="audio/wav")
    monkeypatch.setattr(V, "_create_speech", _fake)
    return seen


def _set(client, model=MODEL, **fields):
    body = {"model": model}
    body.update(fields)
    return client.post("/uplift/api/voices/tts/defaults", json=body)


def _get(client):
    return client.get("/uplift/api/voices/tts/defaults").json()["defaults"]


def _mk(client, name="Jake", model=MODEL, **kw):
    body = {"name": name, "model": model, "ref_text": "My voice sample.",
            "ref_audio_b64": B64, "ref_name": "my.wav"}
    body.update(kw)
    r = client.post("/uplift/api/voices", json=body)
    assert r.status_code == 200, r.text
    return r.json()["voice"]["id"]


# ------------------------------------------------------ store contract

def test_defaults_empty_then_roundtrip(client):
    assert _get(client) == {}
    r = _set(client, speaker="Dad", instructions="warm male", language="cs-CZ")
    assert r.status_code == 200 and r.json()["ok"] is True
    row = {"speaker": "Dad", "instructions": "warm male", "language": "cs-CZ"}
    assert r.json()["defaults"] == {MODEL: row}
    assert _get(client) == {MODEL: row}
    # the FILE holds exactly the row shape (all three keys, nothing else)
    store = json.loads((V._store_dir() / "voices.json").read_text())
    assert store["tts_defaults"] == {MODEL: row}


def test_defaults_post_replaces_row_and_other_models_survive(client):
    _set(client, model="a-tts", speaker="sa", language="la")
    _set(client, model="a-tts", speaker="sb")     # full replace, not merge
    assert _get(client)["a-tts"] == {"speaker": "sb", "instructions": "",
                                     "language": ""}
    _set(client, model="b-tts", instructions="ib")
    assert _get(client)["a-tts"]["speaker"] == "sb"


def test_defaults_all_empty_clears_the_model_key(client):
    _set(client, speaker="Dad")
    assert MODEL in _get(client)
    r = _set(client)                              # every field absent/empty
    assert r.status_code == 200 and r.json()["defaults"] == {}
    store = json.loads((V._store_dir() / "voices.json").read_text())
    assert store["tts_defaults"] == {}            # not an empty row — no key
    # clearing a model that was never set is an honest no-op
    assert _set(client, model="ghost").status_code == 200


def test_defaults_caps(client):
    r = _set(client, model="m" * 200, speaker="s" * 100, language="l" * 100,
             instructions="i" * 900)
    assert r.status_code == 200
    (key, row), = r.json()["defaults"].items()
    assert len(key) == V.MAX_TTS_MODEL_CHARS == 128
    assert row["speaker"] == "s" * 64 and row["language"] == "l" * 64
    assert row["instructions"] == "i" * V.MAX_TTS_DEFAULT_INSTRUCT_CHARS == \
        "i" * 500


def test_defaults_values_verbatim_trim_only(client):
    _set(client, model="vm", language="cs-CZ", speaker=" sr-Latn-RS ")
    row = _get(client)["vm"]
    assert row["language"] == "cs-CZ"             # no case folding, ever
    assert row["speaker"] == "sr-Latn-RS"         # trimmed, not re-cased
    _set(client, model="vm2", language="CS-cz")
    assert _get(client)["vm2"]["language"] == "CS-cz"


def test_defaults_rejects_junk_bodies(client):
    assert client.post("/uplift/api/voices/tts/defaults",
                       json=["not", "a", "dict"]).status_code == 400
    assert client.post("/uplift/api/voices/tts/defaults",
                       json="string").status_code == 400
    assert client.post("/uplift/api/voices/tts/defaults",
                       json={"speaker": "x"}).status_code == 400
    assert _set(client, model="   ").status_code == 400


def test_defaults_store_clean_of_junk_keys(client):
    # unknown body fields are ignored, never smuggled into the row that
    # rides every synth of the model; sibling store sections survive
    V._save({"version": 1, "voices": [], "say_preferred": {"cs": "Zuzana"}})
    _mk(client, name="Jake")
    r = _set(client, speaker="Dad", speed=2.0, name="hack",
             ref_audio_b64=B64, instructions="warm")
    assert r.status_code == 200
    store = json.loads((V._store_dir() / "voices.json").read_text())
    assert set(store["tts_defaults"][MODEL]) == {"speaker", "instructions",
                                                "language"}
    assert store["say_preferred"] == {"cs": "Zuzana"} and len(store["voices"]) == 1


def test_defaults_get_normalizes_a_hand_edited_junk_store(client):
    (V._store_dir() / "voices.json").write_text(json.dumps({
        "version": 1, "voices": [],
        "tts_defaults": {"good": {"speaker": "s"},
                         "all-empty": {"speaker": "", "instructions": "",
                                       "language": ""},
                         "notadict": 5,
                         "junkkeys": {"speaker": "x", "speed": 9, "extra": 1}}}))
    assert _get(client) == {"good": {"speaker": "s", "instructions": "",
                                     "language": ""},
                            "junkkeys": {"speaker": "x", "instructions": "",
                                         "language": ""}}


# -------------------------------------------- merge order on speech paths

def _with_defaults(client):
    """defaults: all three fields; voice: speaker+language only — so each
    field independently proves request > voice > default."""
    _set(client, speaker="Dspk", instructions="Dinst", language="d-lang")
    _mk(client, name="Jake", speaker="Vspk", language="v-lang")


def test_merge_native_voice_beats_default(client, fake_speech):
    _with_defaults(client)
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "jake", "input": "hi"})
    assert r.status_code == 200 and r.content == b"OFAKEAUDIO"
    assert fake_speech["voice"] == "Vspk"         # stored voice beats default
    assert fake_speech["language"] == "v-lang"
    assert fake_speech["instructions"] == "Dinst"  # default fills the gap


def test_merge_native_request_beats_everything(client, fake_speech):
    _with_defaults(client)
    client.post("/uplift/api/voices/speech", json={
        "voice": "jake", "input": "hi",
        "language": "r-lang", "instructions": "r-inst"})
    assert fake_speech["language"] == "r-lang"
    assert fake_speech["instructions"] == "r-inst"
    assert fake_speech["voice"] == "Vspk"         # untouched field keeps tier 2


def test_merge_native_silent_voice_takes_all_defaults(client, fake_speech):
    _set(client, speaker="Dspk", instructions="Dinst", language="d-lang")
    _mk(client, name="Plain")                     # no speaker/language/instruct
    client.post("/uplift/api/voices/speech", json={"voice": "plain", "input": "x"})
    assert fake_speech["voice"] == "Dspk"
    assert fake_speech["language"] == "d-lang"
    assert fake_speech["instructions"] == "Dinst"
    assert fake_speech["ref_text"] == "My voice sample."   # clone path intact


def test_merge_no_defaults_row_passthrough_unchanged(client, fake_speech):
    _mk(client, name="Jake", speaker="Vspk", language="v-lang",
        model="other-tts")                        # NO defaults row at all
    client.post("/uplift/api/voices/speech", json={"voice": "jake", "input": "x"})
    assert fake_speech["voice"] == "Vspk" and fake_speech["language"] == "v-lang"
    assert fake_speech["instructions"] is None


def test_merge_std_voice_leg(client, fake_speech):
    _with_defaults(client)
    r = client.post("/uplift/v1/audio/speech",
                    data={"voice": "Jake", "input": "hi"})
    assert r.status_code == 200, r.text
    assert fake_speech["voice"] == "Vspk" and fake_speech["language"] == "v-lang"
    assert fake_speech["instructions"] == "Dinst"
    client.post("/uplift/v1/audio/speech", json={
        "voice": "Jake", "input": "hi", "language": "r-lang"})
    assert fake_speech["language"] == "r-lang"    # request still wins


def test_merge_std_anonymous_leg_fills_from_defaults(client, fake_speech):
    _set(client, speaker="Dspk", instructions="Dinst", language="d-lang")
    r = client.post("/uplift/v1/audio/speech",
                    data={"model": MODEL, "input": "hi"})
    assert r.status_code == 200, r.text
    assert fake_speech["voice"] == "Dspk"         # default speaker -> voice kw
    assert fake_speech["language"] == "d-lang"
    assert fake_speech["instructions"] == "Dinst"
    assert fake_speech["response_format"] == "mp3"      # spec default kept
    assert fake_speech.get("ref_audio") is None   # still no clip involved


def test_merge_std_anonymous_no_row_and_request_verbatim(client, fake_speech):
    # the passthrough guarantee: model without a defaults row is the
    # EXACT pre-TTS-1 request, fields absent -> None, given -> verbatim
    r = client.post("/uplift/v1/audio/speech",
                    data={"model": "other-tts", "input": "hi"})
    assert r.status_code == 200, r.text
    assert (fake_speech["voice"], fake_speech["language"],
            fake_speech["instructions"]) == (None, None, None)
    client.post("/uplift/v1/audio/speech", data={
        "model": "other-tts", "input": "hi", "language": "cs",
        "instructions": "bright"})
    assert fake_speech["language"] == "cs" and fake_speech["instructions"] == "bright"


def test_say_voice_routes_via_preferred_defaults_exempt(client, fake_speech,
                                                        monkeypatch):
    """Contract: the say engine is UNTOUCHED by TTS-1. A stored 'say'
    voice still renders through say_preferred; a defaults row under the
    model key 'say' cannot hijack its language routing, and
    speaker/instructions (fields the engine has none of) never leak in."""
    monkeypatch.setattr(SE, "available", lambda: True)
    seen = []

    def fake(name, text, speed=None, language=None, preferred=None,
             target=None):
        seen.append((name, text, speed, language, preferred))
        return b"RIFF" + b"\0" * 100
    monkeypatch.setattr(SE, "synth_bytes", fake)
    _set(client, model="say", speaker="Dspk", instructions="Dinst",
         language="d-lang")                       # must change NOTHING
    V._save({**V._load(), "say_preferred": {"cs": "com.apple.Samantha"}})
    _mk(client, name="Sys", model="say", ref_audio_b64="", ref_text="")
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "sys", "input": "hi"})
    assert r.status_code == 200 and r.content.startswith(b"RIFF")
    assert fake_speech == {}                      # never left the say engine
    name, text, speed, language, preferred = seen[-1]
    assert (name, text, speed) == ("", "hi", None)
    assert language is None                       # NOT the d-lang default
    assert preferred == {"cs": "com.apple.Samantha"}   # SAY-2 intact
    # and the standard surface's anonymous say leg likewise untouched
    r = client.post("/uplift/v1/audio/speech",
                    data={"model": "say", "input": "ahoj"})
    assert r.status_code == 200, r.text
    assert seen[-1][3] is None and seen[-1][4] == {"cs": "com.apple.Samantha"}


# ------------------------------------------------ POST /voices/tts/speak

def test_tts_speak_builds_clipless_request_with_speaker(client, fake_speech):
    _set(client, instructions="Dinst")
    r = client.post("/uplift/api/voices/tts/speak", json={
        "model": MODEL, "input": "hello", "speaker": "Vivian"})
    assert r.status_code == 200 and r.content == b"OFAKEAUDIO"
    assert r.headers["content-type"] == "audio/wav"
    assert fake_speech["model"] == MODEL and fake_speech["input"] == "hello"
    assert fake_speech["voice"] == "Vivian"       # speaker -> vanilla voice
    assert fake_speech["ref_audio"] is None       # NO clip, ever, on this leg
    assert fake_speech["ref_text"] is None
    assert fake_speech["response_format"] == "wav" and fake_speech["stream"] is False
    assert fake_speech["instructions"] == "Dinst"  # request>default merge
    assert V._load()["voices"] == []              # nothing stored


def test_tts_speak_all_from_defaults_when_request_silent(client, fake_speech):
    _set(client, speaker="Dspk", instructions="Dinst", language="d-lang")
    r = client.post("/uplift/api/voices/tts/speak",
                    json={"model": MODEL, "input": "hi"})
    assert r.status_code == 200, r.text
    assert (fake_speech["voice"], fake_speech["instructions"],
            fake_speech["language"]) == ("Dspk", "Dinst", "d-lang")


def test_tts_speak_validation_400s(client, fake_speech):
    assert client.post("/uplift/api/voices/tts/speak",
                       json=["junk"]).status_code == 400
    assert client.post("/uplift/api/voices/tts/speak",
                       json={"input": "hi"}).status_code == 400
    assert client.post("/uplift/api/voices/tts/speak",
                       json={"model": " ", "input": "hi"}).status_code == 400
    assert client.post("/uplift/api/voices/tts/speak",
                       json={"model": "m", "input": "   "}).status_code == 400
    r = client.post("/uplift/api/voices/tts/speak", json={
        "model": "m", "input": "x" * (V.MAX_SPEECH_INPUT_CHARS + 1)})
    assert r.status_code == 400 and "exceeds" in r.json()["detail"]
    assert fake_speech == {}                      # refused before any synth


def test_tts_speak_seam_errors_propagate_honestly(client, monkeypatch):
    from fastapi import HTTPException as FH

    async def not_found(kwargs):
        raise FH(status_code=404, detail="Model not found: ghost-tts")
    monkeypatch.setattr(V, "_create_speech", not_found)
    r = client.post("/uplift/api/voices/tts/speak",
                    json={"model": "ghost-tts", "input": "hi"})
    assert r.status_code == 404 and "ghost-tts" in r.json()["detail"]

    async def engine_down(kwargs):
        raise FH(status_code=502, detail="synthesis failed")
    monkeypatch.setattr(V, "_create_speech", engine_down)
    r = client.post("/uplift/api/voices/tts/speak",
                    json={"model": "m", "input": "hi"})
    assert r.status_code == 502 and "synthesis failed" in r.json()["detail"]


def test_tts_speak_503_without_omlx(client):
    # standalone-viewer shape through the REAL seam (no stub — the 503
    # lives inside _create_speech's soft import, same test as VOICE-1)
    import builtins
    real_import = builtins.__import__

    def boom(name, *a, **k):
        if name.startswith("omlx.api.audio"):
            raise ImportError(name)
        return real_import(name, *a, **k)
    builtins.__import__ = boom
    try:
        r = client.post("/uplift/api/voices/tts/speak",
                        json={"model": "m", "input": "hi"})
    finally:
        builtins.__import__ = real_import
    assert r.status_code == 503 and "TTS is not available" in r.json()["detail"]


# --------------------------------------- capability probe: config-only truth

class _Entry:
    def __init__(self, d):
        self.model_path = str(d)


@pytest.fixture()
def fake_pool(monkeypatch, tmp_path):
    """Same vanilla-patch shape as test_voices_profiles (pool + resolve),
    extended with tts_model_size and the option to DROP the top-level
    tts_model_type marker (pre-marker checkpoints)."""
    state = {"type": "base", "size": "0b6", "marker": True, "qwen3": True,
             "model_type": "qwen3_tts", "langs": None, "spk": None}
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
            if state["marker"]:
                j["tts_model_type"] = state["type"]
            if state["size"]:
                j["tts_model_size"] = state["size"]
            j["talker_config"] = tc
        (d / "config.json").write_text(json.dumps(j))

    class _Pool:
        def get_entry(self, mid):
            return _Entry(d)

    ar = type(sys)("omlx.api.audio_routes")
    ar._get_engine_pool = lambda: _Pool()
    ar._resolve_model = lambda m: m
    omlx = type(sys)("omlx")
    api = type(sys)("omlx.api")
    omlx.api = api
    api.audio_routes = ar
    monkeypatch.setitem(sys.modules, "omlx", omlx)
    monkeypatch.setitem(sys.modules, "omlx.api", api)
    monkeypatch.setitem(sys.modules, "omlx.api.audio_routes", ar)
    write_cfg()
    return state, write_cfg


def _caps(client, model="m"):
    return client.get("/uplift/api/voices/capabilities",
                      params={"model": model}).json()


def test_caps_custom_voice_1b7_instructs_0b6_never(client, fake_pool):
    state, write = fake_pool
    state.update(type="custom_voice", size="1b7", langs=["english"],
                 spk=["Vivian", "Ryan", "Uncle_Fu"])
    write()
    c = _caps(client, "cv-1b7")
    assert c["type"] == "custom_voice" and c["size"] == "1b7"
    assert c["instruct"] is True
    assert c["speakers"] == ["Ryan", "Uncle_Fu", "Vivian"]
    assert c["languages"] == ["auto", "english"]  # existing keys unchanged
    state.update(size="0b6")                      # the model card's exception
    write()
    assert _caps(client, "cv-0b6")["instruct"] is False


def test_caps_voice_design_and_base(client, fake_pool):
    state, write = fake_pool
    state.update(type="voice_design", size="1b7", spk=None)
    write()
    c = _caps(client, "vd")
    assert c["type"] == "voice_design" and c["instruct"] is True \
        and c["size"] == "1b7"
    state.update(type="base", size="0b6")
    write()
    c = _caps(client, "base")
    assert c["type"] == "base" and c["instruct"] is False and c["size"] == "0b6"


def test_caps_unknown_and_fallback_never_guess(client, fake_pool):
    state, write = fake_pool
    # custom_voice with NO size marker: unknown can never prove the
    # 1.7B instruction control -> honest False (config fields only)
    state.update(type="custom_voice", size="", spk=["Vivian"])
    write()
    c = _caps(client, "cv-nosize")
    assert c["size"] == "" and c["instruct"] is False
    # pre-marker checkpoint: tts_model_type absent -> the spk_id table is
    # the ONLY fallback evidence (non-empty = custom_voice)
    state.update(marker=False, size="1b7")
    write()
    c = _caps(client, "cv-legacy")
    assert c["type"] == "custom_voice" and c["instruct"] is True
    state.update(spk=None)
    write()
    assert _caps(client, "base-legacy")["type"] == "base"


def test_caps_non_qwen3_carries_one_shape(client, fake_pool):
    state, write = fake_pool
    state.update(qwen3=False, model_type="kokoro")
    write()
    assert _caps(client, "Kokoro") == {
        "model": "Kokoro", "qwen3": False, "type": "", "size": "",
        "languages": [], "speakers": [], "instruct": False}
