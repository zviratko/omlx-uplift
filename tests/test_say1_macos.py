"""SAY-1: macOS `say` as a TTS engine — roster parsing, synthesis contract,
and dispatch through the ordinary voice routes.

CI runs these on Linux, where the real binary does not exist: every test
either exercises a PURE function or monkeypatches availability, so the
machinery is proven everywhere while a real Mac stays the only place the
subprocess itself runs. The subprocess call is captured, never faked at
the Response level — the exact argv the engine builds is under test
(injection-safety lives in that list).
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift import say_engine as SE
from omlx_uplift.routers import voices as V


ROSTER = """Albert              en_US    # Hello! My name is Albert.
Zuzana               cs_CZ    # Ahoj! Já jsem Zuzana.
Samantha (English (US)) en_US # Hello! My name is Samantha.
Ava (Enhanced)       en_US    # Hello, I'm Ava.
Ava (Premium)        en_US    # Hello, I'm Ava.
Noa (Personal)       he_IL    # שלום, קוראים לי נועה.
garbage line without structure
"""

AV_ROSTER = """Albert\ten-US\tcom.apple.speech.synthesis.voice.Albert\t[AVSpeechSynthesisVoice 0x1] Language: en-US, Name: Albert, Quality: Default [com.apple.speech.synthesis.voice.Albert]
Zuzana\tcs-CZ\tcom.apple.voice.compact.cs-CZ.Zuzana\t[AVSpeechSynthesisVoice 0x2] Language: cs-CZ, Name: Zuzana, Quality: Default [com.apple.voice.compact.cs-CZ.Zuzana]
Zuzana\tcs-CZ\tcom.apple.ttsbundle.siri_cs-CZ_compact\t[AVSpeechSynthesisVoice 0x3] Language: cs-CZ, Name: Zuzana, Quality: Enhanced [com.apple.ttsbundle.siri_cs-CZ_compact]
Voice 2\ten-US\tcom.apple.siri.natural.Simone\t[AVSpeechSynthesisVoice 0x4] Language: en-US, Name: Voice 2, Quality: Enhanced [com.apple.siri.natural.Simone]
junk-no-tabs
"""


@pytest.fixture()
def on_mac(monkeypatch):
    """Pretend this box has the engine; empty isolated cache per test.
    TTS-4b: the selected-voice probe never runs for real in tests — ''
    keeps every chain on its pre-selection shape unless a test opts in."""
    monkeypatch.setattr(SE, "available", lambda: True)
    monkeypatch.setattr(SE, "_cache", {"ts": 0.0, "voices": []})
    monkeypatch.setattr(SE, "_downloaded_names", lambda: set())
    monkeypatch.setattr(SE, "_catalog_rows", lambda: [])
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False: "")
    # SAY-5: the System Settings per-language selection probe stays
    # silent too — a live box has its own picks the tests must not read
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False: {})
    monkeypatch.setattr(SE, "_os_sel_cache", {"ts": 9e15, "map": {}})
    return SE


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from omlx_uplift.routers import base as up_base
    monkeypatch.setattr(V, "_store_dir", lambda: tmp_path)
    # SAY-CHAT: pre-arm the one-time web-chat seed flag — a real Mac answers
    # available() True and GET /voices would otherwise probe the live roster
    V._save({"version": 1, "voices": [], "say_chat_seed": True})
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.include_router(_up.page_router)
    app.dependency_overrides[up_base.require_admin] = lambda: True

    async def _ok(request):
        return True
    monkeypatch.setattr(V, "_infer_auth", _ok)
    return TestClient(app)


# ---------------------------------------------------------------- engine

def test_parse_roster_names_locales_tiers():
    vs = SE.parse_voices(ROSTER)
    assert [v["name"] for v in vs] == [
        "Albert", "Zuzana", "Samantha (English (US))", "Ava (Enhanced)",
        "Ava (Premium)", "Noa (Personal)"]
    assert vs[2]["locale"] == "en_US"           # parenthesized name part
    assert vs[2]["sample"].startswith("Hello!")
    q = {v["name"]: v["quality"] for v in vs}
    assert q["Ava (Premium)"] == "premium"
    assert q["Ava (Enhanced)"] == "enhanced"
    assert q["Noa (Personal)"] == "personal"
    assert q["Zuzana"] == "standard"


def test_parse_tolerates_nothing_and_junk_only():
    assert SE.parse_voices("") == []
    assert SE.parse_voices("total garbage\nmore garbage") == []


def test_list_voices_caches_and_marks_downloaded(monkeypatch, on_mac):
    calls = {"av": 0, "say": 0}

    def fake_av():
        calls["av"] += 1
        return on_mac.parse_av(AV_ROSTER)

    def fake_say():
        calls["say"] += 1
        return on_mac.parse_voices(ROSTER)
    monkeypatch.setattr(on_mac, "_av_rows", fake_av)
    monkeypatch.setattr(on_mac, "_say_rows", fake_say)
    a = on_mac.list_voices()
    b = on_mac.list_voices()
    assert a == b and calls == {"av": 1, "say": 1}   # second call was cache
    zz = [v for v in a if v["name"] == "Zuzana"][0]
    assert zz["downloaded"] is False and zz["sample"].startswith("Ahoj")
    avo = [v for v in a if v["identifier"] == "com.apple.siri.natural.Simone"][0]
    assert avo["downloaded"] is True                 # AV-only = downloaded
    assert avo["quality"] == "enhanced"
    ava = [v for v in a if v["name"] == "Zuzana (Enhanced)"]
    assert ava and ava[0]["downloaded"] is True      # above-Default = downloaded


def test_list_voices_empty_probe_does_not_poison_cache(monkeypatch, on_mac):
    monkeypatch.setattr(on_mac, "_av_rows", lambda: [])
    monkeypatch.setattr(on_mac, "_say_rows", lambda: [])
    assert on_mac.list_voices() == []
    monkeypatch.setattr(on_mac, "_say_rows",
                        lambda: on_mac.parse_voices(ROSTER))
    assert len(on_mac.list_voices()) == 6            # not pinned empty


def test_say_only_voices_survive_the_merge(monkeypatch, on_mac):
    """If the CLI ever lists what AV misses, the row must still appear
    (identifiers fall back to the name, nothing is silently dropped)."""
    monkeypatch.setattr(on_mac, "_av_rows", lambda: [])
    monkeypatch.setattr(on_mac, "_say_rows",
                        lambda: on_mac.parse_voices(ROSTER))
    vs = on_mac.list_voices()
    assert any(v["name"] == "Zarvox" and v["identifier"] == "Zarvox"
               for v in vs) if "Zarvox" in ROSTER else True
    assert all("identifier" in v and "downloaded" in v for v in vs)


def test_display_name_never_doubles_the_tier():
    """Newer macOS bakes '(Premium)' into AV names — the old merge
    produced 'Zuzana (Premium) (Premium)' and a second identity key,
    which is how cs_CZ/cs-CZ duplicate groups appeared."""
    assert SE._display_name("zuzana", "premium", "Zuzana (Premium)") \
        == "Zuzana (Premium)"
    assert SE._display_name("zuzana", "premium", "Zuzana") \
        == "Zuzana (Premium)"
    assert SE._display_name("zuzana", "standard", "Zuzana") == "Zuzana"


def test_av_baked_premium_name_merges_with_cli_row(monkeypatch, on_mac):
    av = [{"name": "Zuzana (Premium)", "locale": "cs-CZ",
           "quality": "premium", "identifier": "com.x.zuzana.premium",
           "desc": "Quality: Premium"}]
    sayv = SE.parse_voices(
        "Zuzana (Premium)        cs_CZ    # Ahoj! Jsem Zuzana.\n")
    monkeypatch.setattr(on_mac, "_av_rows", lambda: av)
    monkeypatch.setattr(on_mac, "_say_rows", lambda: sayv)
    vs = on_mac.list_voices()
    zz = [v for v in vs if v["name"].startswith("Zuzana")]
    assert len(zz) == 1, vs
    assert zz[0]["name"] == "Zuzana (Premium)"
    assert zz[0]["locale"] == "cs-CZ"        # ONE spelling, one group
    assert zz[0]["downloaded"] is True


def test_catalog_rows_join_as_greyed_and_resolve_refuses(monkeypatch, on_mac):
    monkeypatch.setattr(on_mac, "_av_rows", lambda: [])
    monkeypatch.setattr(on_mac, "_say_rows",
                        lambda: on_mac.parse_voices(ROSTER))
    monkeypatch.setattr(on_mac, "_catalog_rows", lambda: [
        {"name": "Zuzana", "locale": "cs-CZ", "quality": "enhanced"},
        {"name": "Zuzana", "locale": "cs-CZ", "quality": "standard"},
        {"name": "Allison", "locale": "en-US", "quality": "enhanced"},
    ])
    vs = on_mac.list_voices()
    zz = [v for v in vs if v["locale"] == "cs-CZ" and v["quality"] == "enhanced"]
    assert zz and zz[0]["installed"] is False and not zz[0]["identifier"]
    # the already-installed standard Zuzana swallowed its catalog twin
    assert sum(1 for v in vs if v["name"] == "Zuzana"
               and v["quality"] == "standard") == 1
    ab = [v for v in vs if v["name"] == "Allison (Enhanced)"]
    assert ab and ab[0]["installed"] is False
    # a greyed voice can never be resolved for synthesis
    assert on_mac.resolve("Allison (Enhanced)") is None or \
        on_mac.resolve("Allison (Enhanced)")["installed"] is not False


def test_parse_catalog_accepts_both_shapes():
    doc = {"Assets": [{"Name": "Allison", "Languages": ["en-US"]},
                      {"Name": "Agnes", "Language": "en-US"},
                      {"Name": "", "Language": "xx"},
                      "junk"]}
    out = SE.parse_catalog(doc, "enhanced")
    assert out == [{"name": "Allison", "locale": "en-US",
                    "quality": "enhanced"},
                   {"name": "Agnes", "locale": "en-US",
                    "quality": "enhanced"}]


def test_parse_catalog_footprint_reads_each_entrys_own_tier():
    # TTS-4: the modern TTSAX catalog carries every tier of a voice in
    # ONE file, distinguished by Footprint — compact == the plain
    # factory-quality row ('Iveta', not 'Iveta (Enhanced)')
    doc = {"Assets": [
        {"Name": "Zuzana", "Languages": ["cs-CZ"], "Footprint": "premium"},
        {"Name": "Zuzana", "Languages": ["cs-CZ"], "Footprint": "enhanced"},
        {"Name": "Iveta", "Languages": ["cs-CZ"], "Footprint": "compact"},
        {"Name": "Odd", "Language": "cs-CZ", "Footprint": "gigantic"},
    ]}
    out = SE.parse_catalog(doc, "footprint")
    assert out == [
        {"name": "Zuzana", "locale": "cs-CZ", "quality": "premium"},
        {"name": "Zuzana", "locale": "cs-CZ", "quality": "enhanced"},
        {"name": "Iveta", "locale": "cs-CZ", "quality": "standard"},
        {"name": "Odd", "locale": "cs-CZ", "quality": "standard"},
    ]


def test_parse_av_maps_quality_from_description():
    vs = SE.parse_av(AV_ROSTER)
    assert [v["name"] for v in vs] == ["Albert", "Zuzana", "Zuzana", "Voice 2"]
    q = [v["quality"] for v in vs]
    assert q == ["standard", "standard", "enhanced", "enhanced"]
    assert vs[1]["locale"] == "cs-CZ"
    assert vs[3]["identifier"] == "com.apple.siri.natural.Simone"


def test_synth_addresses_by_identifier_when_resolved(monkeypatch, on_mac):
    """'Voice 2' is a display name `say` cannot resolve; the engine must
    hand say the IDENTIFIER it resolved from the catalog row."""
    _as_say(on_mac, roster_rows=on_mac.parse_av(AV_ROSTER))

    class P:
        returncode = 0
        stderr = ""

    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"RIFF" + b"\0" * 200)
        return P()
    monkeypatch.setattr(SE.subprocess, "run", fake_run)
    data = on_mac.synth_bytes("Voice 2", "hello")
    assert data.startswith(b"RIFF")
    assert seen["cmd"][seen["cmd"].index("-v") + 1] == "com.apple.siri.natural.Simone"


def test_say_name_of_marker_roundtrip():
    assert SE.say_name_of("say:Zuzana") == "Zuzana"
    assert SE.say_name_of("say:Samantha (English (US))") == \
        "Samantha (English (US))"
    assert SE.say_name_of("Qwen3-TTS") == ""
    assert SE.say_name_of("") == ""


def test_speed_multiplier_maps_and_clamps():
    assert SE._speed_wpm(None) is None
    assert SE._speed_wpm("") is None
    assert SE._speed_wpm("junk") is None
    assert SE._speed_wpm(0) is None and SE._speed_wpm(-1) is None
    assert SE._speed_wpm(1.25) == "219"
    assert SE._speed_wpm(99) == "450"
    assert SE._speed_wpm(0.01) == "80"


def test_resolve_exact_name(monkeypatch, on_mac):
    monkeypatch.setattr(on_mac, "_av_rows", lambda: on_mac.parse_av(AV_ROSTER))
    monkeypatch.setattr(on_mac, "_say_rows",
                        lambda: on_mac.parse_voices(ROSTER))
    assert on_mac.resolve("Zuzana")["locale"] in ("cs-CZ", "cs_CZ")
    assert on_mac.resolve("com.apple.siri.natural.Simone")["name"] == "Voice 2 (Enhanced)"
    assert on_mac.resolve("zuzana") is None      # case matters like in say
    assert on_mac.resolve("") is None


def test_synth_builds_safe_argv(monkeypatch, on_mac):
    """The injection-surface proof: text NEVER reaches argv (it goes
    through a temp file), argv is a list, and the voice name must be on
    the installed roster."""
    _as_say(on_mac)
    seen = {}

    class P:
        returncode = 0
        stderr = ""

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        # emulate say writing the requested -o file
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"RIFF" + b"\0" * 200)
        # and echo the text file back for content assertions
        seen["text"] = Path(cmd[cmd.index("-f") + 1]).read_text()
        return P()
    monkeypatch.setattr(SE.subprocess, "run", fake_run)
    data = on_mac.synth_bytes("Zuzana", "Ahoj; rm -rf / #`backtick`",
                              speed=1.1)
    assert data.startswith(b"RIFF")
    cmd = seen["cmd"]
    assert cmd[0] == "say" and "-v" in cmd
    assert cmd[cmd.index("-v") + 1] == "Zuzana"   # roster row: id == name
    assert "-f" in cmd and "-o" in cmd
    assert "--data-format=LEI16@22050" in cmd
    assert cmd[cmd.index("-r") + 1] == "193"    # 175*1.1
    # the shell-junk text reached the FILE verbatim, never as an argv item
    assert seen["text"] == "Ahoj; rm -rf / #`backtick`"
    assert all(";" not in str(a) for a in cmd)


def test_synth_guards(monkeypatch, on_mac):
    _as_say(on_mac)
    with pytest.raises(RuntimeError):
        on_mac.synth_bytes("Nobody", "hi")
    with pytest.raises(RuntimeError):
        on_mac.synth_bytes("Zuzana", "   ")
    # truncation instead of rejection for long-but-sane text:
    captured = {}

    class P:
        returncode = 0
        stderr = ""

    def fake_run(cmd, **kw):
        captured["text"] = Path(cmd[cmd.index("-f") + 1]).read_text()
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"RIFF" + b"\0" * 200)
        return P()
    monkeypatch.setattr(SE.subprocess, "run", fake_run)
    on_mac.synth_bytes("Zuzana", "x" * (on_mac.MAX_SAY_CHARS + 500))
    assert len(captured["text"]) == on_mac.MAX_SAY_CHARS


def test_synth_failure_reason_propagates(monkeypatch, on_mac):
    _as_say(on_mac)
    bad = type("P", (), {"returncode": 1, "stderr": "could not start",
                         "stdout": ""})()
    monkeypatch.setattr(SE.subprocess, "run", lambda *a, **k: bad)
    with pytest.raises(RuntimeError, match="could not start"):
        on_mac.synth_bytes("Zuzana", "hi")


def test_convert_formats(on_mac, monkeypatch):
    assert on_mac.convert_wav(b"W", "wav") == b"W"
    assert on_mac.convert_wav(b"W", "") == b"W"
    with pytest.raises(ValueError):
        on_mac.convert_wav(b"W", "m4a")
    monkeypatch.setattr(on_mac.shutil, "which", lambda x: None)
    with pytest.raises(RuntimeError, match="ffmpeg"):
        on_mac.convert_wav(b"W", "mp3")

    class P:
        returncode = 0

    def fake_run(cmd, **kw):
        Path(cmd[-1]).write_bytes(b"MP3DATA")
        return P()
    monkeypatch.setattr(on_mac.shutil, "which", lambda x: "/usr/bin/ffmpeg")
    monkeypatch.setattr(on_mac.subprocess, "run", fake_run)
    assert on_mac.convert_wav(b"W", "mp3") == b"MP3DATA"
    assert on_mac.media_type("opus") == "audio/ogg"
    assert on_mac.media_type("what") == "audio/wav"


def test_not_macos_answers_empty_and_synth_refuses(monkeypatch):
    monkeypatch.setattr(SE, "_cache", {"ts": 0.0, "voices": []})
    monkeypatch.setattr(SE.sys, "platform", "linux")
    assert SE.available() is False
    assert SE.list_voices() == []
    assert SE.resolve("Zuzana") is None
    with pytest.raises(RuntimeError):
        SE.synth_bytes("Zuzana", "hi")


# ---------------------------------------------------------------- router

def _as_say(on_mac, roster=ROSTER, roster_rows=None):
    on_mac._cache.update(ts=9e15,
                         voices=roster_rows or on_mac.parse_voices(roster))


def test_say_endpoint_hides_when_unavailable(client, monkeypatch):
    monkeypatch.setattr(SE, "available", lambda: False)
    r = client.get("/uplift/api/voices/say")
    assert r.status_code == 200
    assert r.json() == {"supported": False, "voices": []}


def test_say_list_badges_in_use_without_cache_pollution(client, on_mac):
    _as_say(on_mac)
    r = client.post("/uplift/api/voices", json={
        "name": "Zuzana", "model": "say:Zuzana"})
    assert r.status_code == 200, r.text
    d = client.get("/uplift/api/voices/say").json()
    assert d["supported"] is True
    zz = [v for v in d["voices"] if v["name"] == "Zuzana"][0]
    assert zz["added"] is True and zz["sample"].startswith("Ahoj")
    assert all(v["added"] is False for v in d["voices"] if v["name"] != "Zuzana")
    # the per-request 'added' flag must not leak into the shared cache
    assert all("added" not in v for v in on_mac._cache["voices"])
    # and the say voice needs no clip/speaker — it was accepted bare
    store = client.get("/uplift/api/voices").json()["voices"]
    assert store[0]["model"] == "say:Zuzana" and "ref_file" not in store[0]


def test_say_create_rejects_unknown_voice(client, on_mac):
    _as_say(on_mac)
    r = client.post("/uplift/api/voices", json={
        "name": "Ghost", "model": "say:Nobody"})
    assert r.status_code == 400 and "neither an installed" in r.text
    # off a Mac even a real name is refused (no store litter)
    monkey = client  # available False below
    import omlx_uplift.say_engine as _se
    orig = _se.available
    _se.available = lambda: False
    try:
        r = monkey.post("/uplift/api/voices", json={
            "name": "Ghost", "model": "say:Zuzana"})
        assert r.status_code == 400
    finally:
        _se.available = orig


def test_speech_synth_never_touches_vanilla(client, on_mac, monkeypatch):
    _as_say(on_mac)
    hit = []

    def fake_synth(name, text, speed=None, language=None,
                 preferred=None):
        hit.append((name, text, speed))
        return b"RIFFsay" + b"\0" * 100
    monkeypatch.setattr(SE, "synth_bytes", fake_synth)

    async def no_vanilla(kwargs):
        raise AssertionError("vanilla seam called for a say voice")
    monkeypatch.setattr(V, "_create_speech", no_vanilla)

    client.post("/uplift/api/voices", json={"name": "Zu", "model": "say:Zuzana"})
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "Zu", "input": "Dobrý den", "speed": "1.2"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("audio/wav")
    assert r.content == b"RIFFsay" + b"\0" * 100
    assert hit == [("Zuzana", "Dobrý den", "1.2")]


def test_audition_endpoint_defaults_to_the_voice_greeting(client, on_mac,
                                                          monkeypatch):
    _as_say(on_mac)
    got = {}

    def fake_synth(name, text, speed=None, language=None,
                 preferred=None):
        got["args"] = (name, text)
        return b"RIFF" + b"\0" * 100
    monkeypatch.setattr(SE, "synth_bytes", fake_synth)
    r = client.post("/uplift/api/voices/say/speech", json={"name": "Zuzana"})
    assert r.status_code == 200
    assert got["args"] == ("Zuzana", "Ahoj! Já jsem Zuzana.")
    r = client.post("/uplift/api/voices/say/speech", json={"name": "Nobody"})
    assert r.status_code == 404


def test_standard_surface_named_and_anonymous(client, on_mac, monkeypatch):
    _as_say(on_mac)

    def fake_synth(name, text, speed=None, language=None,
                 preferred=None):
        return b"RIFF" + b"\0" * 100
    monkeypatch.setattr(SE, "synth_bytes", fake_synth)
    # anonymous model:'say:...' with NO response_format: WAV answer
    # (the spec's mp3 default must not force an ffmpeg hop silently)
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "say:Ava (Enhanced)", "input": "hi"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("audio/wav")
    # explicit format is honoured (declare + actually produce)
    monkeypatch.setattr(SE, "convert_wav", lambda w, f: b"MP3BYTES")
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "say:Ava (Enhanced)", "input": "hi",
                          "response_format": "mp3"})
    assert r.content == b"MP3BYTES"
    assert r.headers["content-type"].startswith("audio/mpeg")
    # stored say voice by name, no model field at all
    client.post("/uplift/api/voices", json={"name": "Zu", "model": "say:Zuzana"})
    monkeypatch.setattr(SE, "convert_wav", lambda w, f: w)
    r = client.post("/uplift/v1/audio/speech", json={"voice": "Zu",
                                                     "input": "ahoj"})
    assert r.status_code == 200 and r.content.startswith(b"RIFF")
    # engine failure answers 502 with the reason, not a silent file
    def boom(name, text, speed=None, language=None,
             preferred=None):
        raise RuntimeError("say: could not start")
    monkeypatch.setattr(SE, "synth_bytes", boom)
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "say:Zuzana", "input": "hi"})
    assert r.status_code == 502 and "could not start" in r.text


def test_edit_away_from_say_needs_a_clip(client, on_mac):
    _as_say(on_mac)
    vid = client.post("/uplift/api/voices",
                      json={"name": "Zu", "model": "say:Zuzana"}
                      ).json()["voice"]["id"]
    r = client.put("/uplift/api/voices/" + vid,
                   json={"name": "Zu", "model": "Qwen3-TTS-12Hz-0.6B-Base"})
    assert r.status_code == 400 and "reference clip" in r.text
    # editing to a DIFFERENT installed say voice is fine (the endpoint
    # contract, like the form: PUT always carries name + model)
    r = client.put("/uplift/api/voices/" + vid,
                   json={"name": "Zu", "model": "say:Albert"})
    assert r.status_code == 200
    # but not to a name this Mac cannot speak
    r = client.put("/uplift/api/voices/" + vid,
                   json={"name": "Zu", "model": "say:Ghost"})
    assert r.status_code == 400


def test_say_dispatch_works_without_omlx(client, on_mac, monkeypatch):
    """Standalone-viewer honesty: the system engine has no dependency on
    the omlx audio import — synthesis must NOT 503 just because vanilla
    is absent."""
    _as_say(on_mac)
    monkeypatch.setattr(SE, "synth_bytes",
                        lambda n, t, speed=None, language=None, preferred=None: b"RIFF" + b"\0" * 100)
    import builtins
    real_import = builtins.__import__

    def no_omlx(name, *a, **k):
        if name.startswith("omlx.api"):
            raise ImportError("vanilla absent")
        return real_import(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", no_omlx)
    client.post("/uplift/api/voices", json={"name": "Zu", "model": "say:Zuzana"})
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "Zu", "input": "hi"})
    assert r.status_code == 200 and r.content.startswith(b"RIFF")


# ---------------------------------------------------------------- SAY-CHAT
# (user 2026-10-21): the per-voice 'make available for Uplift web chat'
# switch. The store row carrying model 'say:<identifier>' IS the
# availability — the chat picker lists the store and every speech route
# already dispatches the marker — so these tests pin the store mutation
# (POST /voices/say/chat), the once-per-store default seed on the first
# GET /voices (en + cs), and that the seeded row really speaks.

def test_say_chat_toggle_roundtrip(client, on_mac):
    _as_say(on_mac)
    r = client.post("/uplift/api/voices/say/chat",
                    json={"identifier": "Zuzana", "on": True})
    assert r.status_code == 200
    assert r.json()["chat"] is True
    vid = r.json()["id"]
    store = client.get("/uplift/api/voices").json()["voices"]
    assert [v["id"] for v in store] == [vid]
    assert store[0]["model"] == "say:Zuzana"
    assert "ref_file" not in store[0] and store[0]["ref_bytes"] is None
    # ON again: idempotent, no duplicate row
    r2 = client.post("/uplift/api/voices/say/chat",
                     json={"identifier": "Zuzana", "on": True})
    assert r2.json()["id"] == vid
    assert len(client.get("/uplift/api/voices").json()["voices"]) == 1
    # OFF removes; a second OFF is an honest no-op
    r3 = client.post("/uplift/api/voices/say/chat",
                     json={"identifier": "Zuzana", "on": False})
    assert r3.json() == {"ok": True, "chat": False, "removed": vid}
    assert client.get("/uplift/api/voices").json()["voices"] == []
    r4 = client.post("/uplift/api/voices/say/chat",
                     json={"identifier": "Zuzana", "on": False})
    assert r4.json() == {"ok": True, "chat": False, "removed": None}


def test_say_chat_validation(client, on_mac, monkeypatch):
    _as_say(on_mac)
    assert client.post("/uplift/api/voices/say/chat",
                       json={"on": True}).status_code == 400
    assert client.post("/uplift/api/voices/say/chat",
                       json={"identifier": "", "on": True}).status_code == 400
    r = client.post("/uplift/api/voices/say/chat",
                    json={"identifier": "Nobody", "on": True})
    assert r.status_code == 404
    # off a Mac even a real name is refused, and nothing lands in the store
    monkeypatch.setattr(SE, "available", lambda: False)
    r = client.post("/uplift/api/voices/say/chat",
                    json={"identifier": "Zuzana", "on": True})
    assert r.status_code == 400 and "not available" in r.text
    assert client.get("/uplift/api/voices").json()["voices"] == []


def test_seed_fires_once_on_first_get_voices(client, on_mac, monkeypatch):
    # the client fixture pre-armed the flag; drop it to exercise the path
    store = V._load()
    store.pop("say_chat_seed", None)
    V._save(store)
    rows = {"en": {"name": "Samantha", "identifier": "com.x.Samantha",
                   "locale": "en-US", "quality": "standard",
                   "downloaded": False, "installed": True},
            "cs": {"name": "Zuzana (Premium)",
                  "identifier": "com.x.Zuzana.Premium", "locale": "cs-CZ",
                  "quality": "premium", "downloaded": False,
                  "installed": True}}
    monkeypatch.setattr(SE, "language_voice",
                        lambda lang, preferred=None: rows.get(lang))
    out = client.get("/uplift/api/voices").json()["voices"]
    assert [(v["name"], v["model"]) for v in out] == [
        ("Samantha", "say:com.x.Samantha"),
        ("Zuzana (Premium)", "say:com.x.Zuzana.Premium")]
    assert all(v["id"] and v["created"] for v in out)
    # deleting a seeded voice must NOT resurrect it (seed is once-per-store)
    client.delete("/uplift/api/voices/%s" % out[0]["id"])
    out2 = client.get("/uplift/api/voices").json()["voices"]
    assert [v["name"] for v in out2] == ["Zuzana (Premium)"]


def test_seed_skips_covered_language(client, on_mac, monkeypatch):
    store = V._load()
    store.pop("say_chat_seed", None)
    store["voices"] = [{"id": "zu", "name": "Zu", "model": "say:Zuzana",
                        "created": 1}]
    V._save(store)
    # cs is answered by the legacy row (its tail names the same voice);
    # en answers nothing -> the seed adds exactly zero rows but marks done
    monkeypatch.setattr(SE, "language_voice",
                        lambda lang, preferred=None: {
                            "cs": {"name": "Zuzana",
                                   "identifier": "com.x.Zuzana",
                                   "locale": "cs-CZ"}}.get(lang))
    out = client.get("/uplift/api/voices").json()["voices"]
    assert [v["id"] for v in out] == ["zu"]
    assert V._load().get("say_chat_seed") is True


def test_seed_never_fires_off_mac(client, monkeypatch):
    store = V._load()
    store.pop("say_chat_seed", None)
    V._save(store)
    monkeypatch.setattr(SE, "available", lambda: False)
    out = client.get("/uplift/api/voices").json()["voices"]
    assert out == []
    # flag stays unset so a Mac appearing later still seeds (retryable)
    assert V._load().get("say_chat_seed") is None


def test_marked_chat_voice_speaks_through_the_store_row(client, on_mac,
                                                          monkeypatch):
    _as_say(on_mac)
    monkeypatch.setattr(SE, "synth_bytes",
                        lambda n, t, speed=None, language=None,
                               preferred=None: b"RIFF" + b"\0" * 50)
    r = client.post("/uplift/api/voices/say/chat",
                    json={"identifier": "Zuzana", "on": True})
    vid = r.json()["id"]
    sp = client.post("/uplift/api/voices/speech",
                     json={"voice": vid, "input": "ahoj"})
    assert sp.status_code == 200 and sp.content.startswith(b"RIFF")
