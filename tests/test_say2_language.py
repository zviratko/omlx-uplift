"""SAY-2: language routing for the macOS `say` engine.

Pins the contract added on top of SAY-1:
- say_split: 'say' bare, 'say:' empty tail, 'say:<voice>', case-insensitive
  token, non-say models untouched;
- the AV probe's isDefault column parses through (4-column legacy rows
  still load, default False);
- language_voice chain: preferred mark (exact locale beats primary match,
  stale marks skipped, wrong-region marks never answer) -> language
  default -> best installed for the language -> None when nothing speaks;
- route(): explicit voice wins, a locale tail ('say:cs-CZ') routes like a
  language-carrying request, bare with no language = system default, and
  an unknown voice stays an honest miss;
- synth argv: a routed request carries the preferred voice's identifier;
  with no default known the -v flag is dropped (say picks the system
  voice itself) — never a fabricated silence;
- the tab endpoints: POST /voices/say/preferred set/replace/clear + the
  preferred_for flag on GET /voices/say, with NO pseudo-model voice ever
  added to the store;
- dispatch: bare 'say' + language and 'say:<locale>' on the standard
  /uplift/v1/audio/speech surface and on /voices/speech;
- validation: a stored voice may carry model 'say' (routes per request),
  'say:<installed>' or 'say:<routable locale>' — junk and unspappable
  languages are refused at the door.

SAY-2c (Override macOS default) adds:
- system_language(): parsed from `defaults` AppleLanguages, AppleLocale
  fallback, honest '' without the binary; cached, never shells out in
  the other tests (on_mac patches it to '');
- a preferred mark answering the Mac's own language carries
  language-less requests; without it (or without a detected language)
  the pre-SAY-2c system default answers untouched;
- default_voice() prefers the flagged row of the system language;
- GET /voices/say advertises system_language / system_voice and the
  per-row answers_default flag the tab's text button labels from.

SAY-5 (System Settings per-language selection) adds:
- spoken_selections(): the user's Spoken Content ▸ Voices picks read
  from the com.apple.Accessibility domain ({language: voiceId}); {} on
  older macOS (no such key) keeps every pre-SAY-5 expectation intact;
- chain step 2: a per-language OS pick outranks the global selection,
  the factory flag and the quality tiers — but never a preferred mark,
  and never a voice this Mac no longer holds.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift import say_engine as SE
from omlx_uplift.routers import voices as V

AV2 = (
    "Zuzana\tcs-CZ\tcom.apple.voice.compact.cs-CZ.Zuzana\t"
    "[AVSpeechSynthesisVoice 0x1] Language: cs-CZ, Name: Zuzana, "
    "Quality: Default [com.apple.voice.compact.cs-CZ.Zuzana]\t0\n"
    "Zuzana\tcs-CZ\tcom.apple.ttsbundle.siri_cs-CZ_compact\t"
    "[AVSpeechSynthesisVoice 0x2] Language: cs-CZ, Name: Zuzana, "
    "Quality: Enhanced [com.apple.ttsbundle.siri_cs-CZ_compact]\t0\n"
    "Ilja\tcs-CZ\tcom.apple.voice.premium.cs-CZ.Ilja\t"
    "[AVSpeechSynthesisVoice 0x3] Language: cs-CZ, Name: Ilja, "
    "Quality: Premium [com.apple.voice.premium.cs-CZ.Ilja]\t0\n"
    "Samantha\ten-US\tcom.apple.speech.synthesis.voice.Samantha\t"
    "[AVSpeechSynthesisVoice 0x4] Language: en-US, Name: Samantha, "
    "Quality: Default [com.apple.speech.synthesis.voice.Samantha]\t1\n"
    "Laura\tsk-SK\tcom.apple.voice.compact.sk-SK.Laura\t"
    "[AVSpeechSynthesisVoice 0x5] Language: sk-SK, Name: Laura, "
    "Quality: Default [com.apple.voice.compact.sk-SK.Laura]\t0\n")


@pytest.fixture()
def on_mac(monkeypatch):
    """Pretend this box has the engine; the fixture cache is the ONLY
    roster — both probes answer empty so a miss never runs the real
    osascript and never pollutes the cache on a live Mac."""
    monkeypatch.setattr(SE, "available", lambda: True)
    monkeypatch.setattr(SE, "_downloaded_names", lambda: set())
    monkeypatch.setattr(SE, "_catalog_rows", lambda: [])
    monkeypatch.setattr(SE, "_av_rows", lambda: [])
    monkeypatch.setattr(SE, "_say_rows", lambda: [])
    monkeypatch.setattr(SE, "_cache",
                        {"ts": 9e15, "voices": SE.parse_av(AV2)})
    # SAY-2c: the system-language probe never runs for real in tests —
    # '' keeps every legacy expectation (no override, first flagged row).
    # TTS-4b: same for the selected-voice probe (a real osascript would
    # read the TEST MAC's System Settings into every expectation).
    monkeypatch.setattr(SE, "system_language", lambda force=False: "")
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False: "")
    monkeypatch.setattr(SE, "_sel_cache", {"ts": 9e15, "id": ""})
    # SAY-5: the System Settings per-language selection probe never runs
    # for real either (a live box has its own picks); {} keeps every
    # expectation on the pre-SAY-5 chain unless a test sets picks itself.
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


def _fake_synth(monkeypatch):
    """Capture (name, text, speed, language, preferred) instead of
    running `say`; return honest-looking WAV bytes."""
    seen = []

    def fake(name, text, speed=None, language=None, preferred=None, target=None):
        seen.append((name, text, speed, language, preferred))
        return b"RIFF" + b"\0" * 100
    monkeypatch.setattr(SE, "synth_bytes", fake)
    return seen


# ------------------------------------------------------------------ token

def test_say_split_all_spellings():
    assert SE.say_split("say") == (True, "")
    assert SE.say_split("say:") == (True, "")
    assert SE.say_split(" say ") == (True, "")
    assert SE.say_split("SAY:Zuzana") == (True, "Zuzana")   # token CI
    assert SE.say_split("say:com.apple.voice.compact.cs-CZ.Zuzana") == \
        (True, "com.apple.voice.compact.cs-CZ.Zuzana")      # tail verbatim
    assert SE.say_split("say:cs-CZ") == (True, "cs-CZ")
    assert SE.say_split("Qwen3-TTS-12Hz") == (False, "")
    assert SE.say_split("saysomething") == (False, "")
    assert SE.say_split("") == (False, "")
    assert SE.say_split(None) == (False, "")


def test_parse_av_default_column_and_legacy_rows():
    rows = SE.parse_av(AV2)
    assert [r["default"] for r in rows] == [False, False, False, True, False]
    legacy = SE.parse_av("X\ten-US\tcom.x\tQuality: Default [com.x]")
    assert legacy[0]["default"] is False        # 4-col probe still loads


# ------------------------------------------------------------------ chain

def test_language_voice_preferred_exact_beats_primary(on_mac):
    pref = {"cs": "com.apple.voice.premium.cs-CZ.Ilja",
            "cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    v = SE.language_voice("cs-CZ", pref)
    assert v["identifier"] == "com.apple.ttsbundle.siri_cs-CZ_compact"
    # primary-only request accepts the primary mark only as fallback
    v2 = SE.language_voice("cs", pref)          # exact cs mark exists
    assert v2["identifier"] == "com.apple.voice.premium.cs-CZ.Ilja"


def test_language_voice_region_mismatch_never_answers(on_mac):
    pref = {"cs-SK": "com.apple.voice.compact.sk-SK.Laura"}
    v = SE.language_voice("cs-CZ", pref)        # Laura is sk, not cs-CZ
    assert v["identifier"] == "com.apple.voice.premium.cs-CZ.Ilja"


def test_language_voice_stale_mark_falls_through(on_mac):
    pref = {"cs-CZ": "com.apple.voice.long-gone"}
    v = SE.language_voice("cs-CZ", pref)
    assert v is not None and v["identifier"] != "com.apple.voice.long-gone"


def test_language_voice_default_beats_quality_then_none(on_mac):
    # en-US: Samantha is the ONLY English row — she answers 'en'
    # (TTS-4 note: she no longer wins BY her isDefault flag — the tier
    # order leads now; the flag breaks ties inside one tier only)
    assert SE.language_voice("en", {})["identifier"] == \
        "com.apple.speech.synthesis.voice.Samantha"
    # cs-CZ: nothing isDefault -> the tab's quality promise: Premium Ilja
    assert SE.language_voice("cs-CZ", {})["identifier"] == \
        "com.apple.voice.premium.cs-CZ.Ilja"
    # sk: primary match on the sk-SK row
    assert SE.language_voice("sk", {})["name"] == "Laura"
    assert SE.language_voice("de", {}) is None
    assert SE.language_voice("", {}) is None


ZUZ_PAIR = [
    {"name": "Zuzana", "locale": "cs-CZ", "quality": "standard",
     "identifier": "com.apple.voice.super-compact.cs-CZ.Zuzana",
     "installed": True, "default": True},
    {"name": "Zuzana (Premium)", "locale": "cs-CZ", "quality": "premium",
     "identifier": "com.apple.voice.premium.cs-CZ.Zuzana",
     "installed": True, "default": False},
]


def test_selected_voice_beats_the_factory_flag(monkeypatch, on_mac):
    """TTS-4b (user): System Settings ▸ Read & Speak names the Mac's real
    default voice; AVFoundation's isDefault only marks the factory row.
    A Mac whose selection is 'Zuzana (Premium)' must badge and answer
    with Premium — exactly what bare `say` speaks (byte-proven)."""
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False:
                        "com.apple.voice.premium.cs-CZ.Zuzana")
    on_mac._cache.update(ts=9e15, voices=[dict(r) for r in ZUZ_PAIR])
    assert SE.selected_row()["identifier"] == \
        "com.apple.voice.premium.cs-CZ.Zuzana"
    assert SE.language_voice("cs-CZ", {})["identifier"] == \
        "com.apple.voice.premium.cs-CZ.Zuzana"
    # the badge set answers with exactly the row the router picks
    assert SE.effective_default_addrs() == \
        {"com.apple.voice.premium.cs-CZ.Zuzana"}


def test_flag_answers_when_no_selection_is_known(on_mac):
    # probe blind (non-Mac layout, deleted voice): the factory flag keeps
    # answering its language — quality alone must not invent a default
    # (kocour truth: bare say == flagged Samantha although an Enhanced
    #  en-US row is installed)
    on_mac._cache.update(ts=9e15, voices=[dict(r) for r in ZUZ_PAIR])
    assert SE.selected_row() is None
    assert SE.language_voice("cs-CZ", {})["identifier"] == \
        "com.apple.voice.super-compact.cs-CZ.Zuzana"
    assert SE.effective_default_addrs() == \
        {"com.apple.voice.super-compact.cs-CZ.Zuzana"}


def test_selection_only_answers_its_own_language(monkeypatch, on_mac):
    # a Premium cs-CZ selection must not hijack sk-SK: Laura still
    # answers Slovak (flagged there) — the selection scores locales like
    # everything else in the chain
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False:
                        "com.apple.voice.premium.cs-CZ.Zuzana")
    rows = [dict(r) for r in ZUZ_PAIR] + [
        {"name": "Laura", "locale": "sk-SK", "quality": "standard",
         "identifier": "com.apple.voice.compact.sk-SK.Laura",
         "installed": True, "default": True}]
    on_mac._cache.update(ts=9e15, voices=rows)
    assert SE.language_voice("sk", {})["name"] == "Laura"


def test_default_voice_leads_with_the_selection(monkeypatch, on_mac):
    # no sysl, no flags matching... the selection IS the bare-say default
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False:
                        "com.apple.voice.premium.cs-CZ.Zuzana")
    on_mac._cache.update(ts=9e15, voices=[dict(r) for r in ZUZ_PAIR])
    assert SE.default_voice()["identifier"] == \
        "com.apple.voice.premium.cs-CZ.Zuzana"


def test_say_list_badges_the_selection_over_the_flag(client,
                                                     monkeypatch, on_mac):
    rows = [dict(r) for r in ZUZ_PAIR]
    for r in rows:
        r.update(sample="", downloaded=r["quality"] != "standard")
    on_mac._cache.update(ts=9e15, voices=rows)
    # without a selection: the factory flag is badged
    vs = {v["identifier"]: v for v in
          client.get("/uplift/api/voices/say").json()["voices"]}
    assert vs["com.apple.voice.super-compact.cs-CZ.Zuzana"]["default"] is True
    assert vs["com.apple.voice.premium.cs-CZ.Zuzana"]["default"] is False
    # with the user's System Settings selection: the badge moves — and
    # the compact row becomes what the tabs call an OVERRIDE candidate
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False:
                        "com.apple.voice.premium.cs-CZ.Zuzana")
    vs = {v["identifier"]: v for v in
          client.get("/uplift/api/voices/say").json()["voices"]}
    assert vs["com.apple.voice.premium.cs-CZ.Zuzana"]["default"] is True
    assert vs["com.apple.voice.super-compact.cs-CZ.Zuzana"]["default"] is False
    d = client.get("/uplift/api/voices/say").json()
    assert d["system_voice"] == "Zuzana (Premium)"


def test_route_explicit_locale_tail_and_default(on_mac):
    assert SE.route("Zuzana") == "com.apple.voice.compact.cs-CZ.Zuzana"
    # locale tail routes like a language-carrying request
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    assert SE.route("cs-CZ", None, pref) == "com.apple.ttsbundle.siri_cs-CZ_compact"
    assert SE.route("", "cs", pref) == "com.apple.ttsbundle.siri_cs-CZ_compact"
    # no language, no tail: the Mac's own default voice
    assert SE.route("") == "com.apple.speech.synthesis.voice.Samantha"
    with pytest.raises(LookupError) as e:
        SE.route("Nobody")
    assert "not installed" in str(e.value)
    with pytest.raises(LookupError) as e:
        SE.route("de")
    assert "language 'de'" in str(e.value)


def test_route_without_default_flag_addresses_say_directly(monkeypatch, on_mac):
    rows = [r for r in SE.parse_av(AV2) if not r["default"]]
    SE._cache.update(ts=9e15, voices=rows)
    assert SE.route("") == ""          # nothing is marked default
    assert SE.default_voice() is None


def test_synth_argv_carries_the_routed_identifier(monkeypatch, on_mac):
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    seen = {}

    class P:
        returncode = 0
        stderr = ""

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"RIFF" + b"\0" * 200)
        return P()
    monkeypatch.setattr(SE.subprocess, "run", fake_run)
    SE.synth_bytes("", "ahoj", None, "cs-CZ", pref)
    assert seen["cmd"][seen["cmd"].index("-v") + 1] == \
        "com.apple.ttsbundle.siri_cs-CZ_compact"


def test_synth_omits_voice_flag_for_system_default(monkeypatch):
    monkeypatch.setattr(SE, "available", lambda: True)
    monkeypatch.setattr(SE, "_cache", {"ts": 9e15, "voices": []})
    monkeypatch.setattr(SE, "_av_rows", lambda: [])
    monkeypatch.setattr(SE, "_say_rows", lambda: [])
    monkeypatch.setattr(SE, "detect_language", lambda t: "")
    monkeypatch.setattr(SE, "system_language", lambda force=False: "")
    # TTS-4b: this test fakes ALL of subprocess.run — the selected-voice
    # probe must not fall into it
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False: "")
    seen = {}

    class P:
        returncode = 0
        stderr = ""

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"RIFF" + b"\0" * 200)
        return P()
    monkeypatch.setattr(SE.subprocess, "run", fake_run)
    SE.synth_bytes("", "hello")        # no roster at all
    assert "-v" not in seen["cmd"]     # `say` answers with its own default


# ------------------------------------------------- system language (2c)

class _Defaults:
    """stand-in for the `defaults read -g KEY` pair; '' rc!=0"""

    def __init__(self, languages=None, locale=None):
        self.languages, self.locale = languages, locale
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append(list(cmd))

        class P:
            pass
        P.returncode, P.stderr = 0, ""
        key = cmd[-1]
        if key == "AppleLanguages" and self.languages is not None:
            P.stdout = self.languages
        elif key == "AppleLocale" and self.locale is not None:
            P.stdout = self.locale
        else:
            P.returncode = 1
            P.stdout = ""
        return P()


def _no_syslang_cache(monkeypatch):
    monkeypatch.setattr(SE, "_sys_lang_cache", {"ts": 0.0, "lang": None})


def test_system_language_parses_applelanguages(monkeypatch):
    _no_syslang_cache(monkeypatch)
    monkeypatch.setattr(SE.shutil, "which", lambda x: "/usr/bin/defaults")
    run = _Defaults(languages='(\n    "en-US"\n)\n',
                    locale="en_US@rg=czzzzz\n")
    monkeypatch.setattr(SE.subprocess, "run", run)
    assert SE.system_language() == "en-US"
    # cached: the second read must not spend another subprocess
    n = len(run.calls)
    assert SE.system_language() == "en-US" and len(run.calls) == n


def test_system_language_falls_back_to_applelocale(monkeypatch):
    _no_syslang_cache(monkeypatch)
    monkeypatch.setattr(SE.shutil, "which", lambda x: "/usr/bin/defaults")
    run = _Defaults(locale="de_AT\n")     # AppleLanguages unreadable
    monkeypatch.setattr(SE.subprocess, "run", run)
    assert SE.system_language() == "de-AT"


def test_system_language_silent_without_defaults(monkeypatch):
    _no_syslang_cache(monkeypatch)
    monkeypatch.setattr(SE.shutil, "which", lambda x: None)
    assert SE.system_language() == ""
    # an unreadable pair is honestly '' — every caller keeps the
    # pre-SAY-2c behaviour
    _no_syslang_cache(monkeypatch)
    monkeypatch.setattr(SE.shutil, "which", lambda x: "/usr/bin/defaults")
    monkeypatch.setattr(SE.subprocess, "run", _Defaults())
    assert SE.system_language() == ""


def test_override_mark_answers_language_less_request(on_mac, monkeypatch):
    monkeypatch.setattr(SE, "system_language", lambda force=False: "cs-CZ")
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    # bare, no text the detector could answer: the override speaks
    assert SE.route("", None, pref) == "com.apple.ttsbundle.siri_cs-CZ_compact"


def test_mark_for_other_language_leaves_system_default(on_mac, monkeypatch):
    monkeypatch.setattr(SE, "system_language", lambda force=False: "en-US")
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    assert SE.route("", None, pref) == \
        "com.apple.speech.synthesis.voice.Samantha"


def test_override_needs_the_system_language(on_mac):
    # fixture sysl is '': a mark answering cs-CZ stays a language route
    # and does NOT hijack language-less requests (legacy behaviour)
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    assert SE.route("", None, pref) == \
        "com.apple.speech.synthesis.voice.Samantha"


def test_default_voice_prefers_the_system_language(on_mac, monkeypatch):
    # AV's isDefault marks EVERY language's own default — a Slovak Mac
    # must hear Laura, not whichever flagged row the roster lists first
    tab = chr(9)   # the probe line's real TAB separators
    av3 = AV2.replace("com.apple.voice.compact.sk-SK.Laura]" + tab + "0",
                      "com.apple.voice.compact.sk-SK.Laura]" + tab + "1")
    SE._cache.update(ts=9e15, voices=SE.parse_av(av3))
    monkeypatch.setattr(SE, "system_language", lambda force=False: "sk")
    assert SE.default_voice()["name"] == "Laura"
    monkeypatch.setattr(SE, "system_language", lambda force=False: "en-US")
    assert SE.default_voice()["name"] == "Samantha"
    # unknown language (fixture ''): legacy first flagged row
    assert SE.default_voice()["name"] == "Samantha"


# --------------------------------------------------- auto-detection (A)

class _Run:
    """stand-in for subprocess.run capturing every argv"""

    def __init__(self, out="cs\t99", rc=0):
        self.out, self.rc, self.calls = out, rc, []

    def __call__(self, cmd, **kw):
        self.calls.append(list(cmd))

        class P:
            pass
        P.returncode = self.rc
        P.stdout = self.out
        P.stderr = ""
        return P()


def test_detect_language_parses_and_gates(monkeypatch):
    monkeypatch.setattr(SE.shutil, "which", lambda x: "/usr/bin/osascript")

    def run_with(out, rc=0):
        r = _Run(out, rc)
        monkeypatch.setattr(SE.subprocess, "run", r)
        return r

    run_with("cs\t99")
    assert SE.detect_language("Ahoj, jak se máš dnes?") == "cs"
    run_with("zh-Hans\t95")
    assert SE.detect_language("你好，今天过得怎么样啊") == "zh"   # script folds
    run_with("pl\t29")
    assert SE.detect_language("ok") == ""          # under the gate
    run_with("und\t80")
    assert SE.detect_language("??? !!! ...") == ""
    run_with("", rc=1)
    assert SE.detect_language("some text here") == ""
    run_with("garbage without a tab")
    assert SE.detect_language("some text here") == ""
    # too little text never pays for a subprocess
    r = run_with("cs\t99")
    assert SE.detect_language("ah") == "" and not r.calls


def test_detect_text_travels_in_argv_not_shell(monkeypatch):
    r = _Run("cs\t99")
    monkeypatch.setattr(SE.shutil, "which", lambda x: "/usr/bin/osascript")
    monkeypatch.setattr(SE.subprocess, "run", r)
    SE.detect_language("Ahoj; rm -rf / #`backtick`")
    cmd = r.calls[0]
    assert cmd[0] == "osascript" and cmd[1] == "-"
    assert cmd[2] == "Ahoj; rm -rf / #`backtick`"   # verbatim argv item


def test_route_auto_detects_only_when_nothing_explicit(monkeypatch, on_mac):
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    calls = []

    def fake_detect(t):
        calls.append(t)
        return "cs"
    monkeypatch.setattr(SE, "detect_language", fake_detect)
    # bare + no language: the text decides, preferred mark answers
    assert SE.route("", None, pref, "Ahoj, jak se máš?") == \
        "com.apple.ttsbundle.siri_cs-CZ_compact"
    assert calls == ["Ahoj, jak se máš?"]
    # explicit language or voice: never pays for detection
    calls.clear()
    SE.route("", "sk", pref, "text")
    SE.route("Zuzana", None, pref, "text")
    assert calls == []
    # a guess with nothing installed falls back to the system default
    monkeypatch.setattr(SE, "detect_language", lambda t: "xx")
    assert SE.route("", None, {}, "some english") == \
        "com.apple.speech.synthesis.voice.Samantha"
    # shaky guess ('' from the gate) — same safe fallback
    monkeypatch.setattr(SE, "detect_language", lambda t: "")
    assert SE.route("", None, {}, "ok") == \
        "com.apple.speech.synthesis.voice.Samantha"


def test_synth_end_to_end_auto_routes(monkeypatch, on_mac):
    """the FULL synth_bytes path: bare call, detector says cs, the
    preferred voice answers — one osascript probe then one say run."""
    pref = {"cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    seen = {}

    def fake_run(cmd, **kw):
        if cmd[0] == "osascript":
            class A:
                returncode, stdout, stderr = 0, "cs\t99", ""
            return A()
        seen["cmd"] = cmd
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"RIFF" + b"\0" * 200)
        class S:
            returncode, stdout, stderr = 0, "", ""
        return S()
    monkeypatch.setattr(SE.subprocess, "run", fake_run)
    # the detector guards on shutil.which('osascript'): absent on the
    # Linux runner, so fake the whole Mac here — the wiring under test
    # is synth_bytes -> detect -> preferred chain, not PATH discovery
    monkeypatch.setattr(SE.shutil, "which", lambda x: "/usr/bin/osascript")
    SE.synth_bytes("", "Ahoj, jak se dnes máš?", None, None, pref)
    assert seen["cmd"][seen["cmd"].index("-v") + 1] == \
        "com.apple.ttsbundle.siri_cs-CZ_compact"


# ---------------------------------------------------------------- marks

def test_preferred_endpoints_roundtrip(client, on_mac):
    r = client.post("/uplift/api/voices/say/preferred", json={
        "locale": "cs-CZ",
        "identifier": "com.apple.ttsbundle.siri_cs-CZ_compact"})
    assert r.status_code == 200, r.text
    assert r.json()["preferred"] == {
        "cs-CZ": "com.apple.ttsbundle.siri_cs-CZ_compact"}
    d = client.get("/uplift/api/voices/say").json()
    zz = [v for v in d["voices"]
          if v["identifier"] == "com.apple.ttsbundle.siri_cs-CZ_compact"][0]
    assert zz["preferred_for"] == "cs-CZ"
    assert all(not v.get("preferred_for") for v in d["voices"]
               if v is not zz)
    # marking a SECOND voice in the same language REPLACES the first
    r = client.post("/uplift/api/voices/say/preferred", json={
        "locale": "cs-CZ", "identifier": "com.apple.voice.premium.cs-CZ.Ilja"})
    assert r.json()["preferred"] == {
        "cs-CZ": "com.apple.voice.premium.cs-CZ.Ilja"}
    # clearing
    r = client.post("/uplift/api/voices/say/preferred", json={
        "locale": "cs-CZ", "identifier": ""})
    assert r.json()["preferred"] == {}
    # marking NEVER touches the voice store (no pseudo-models)
    assert client.get("/uplift/api/voices").json()["voices"] == []


def test_say_list_advertises_the_system_default(client, on_mac, monkeypatch):
    # SAY-2c payload: the tab needs the detected language, the voice it
    # answers with, and which rows a mark on would override
    monkeypatch.setattr(SE, "system_language", lambda force=False: "cs-CZ")
    d = client.get("/uplift/api/voices/say").json()
    assert d["system_language"] == "cs-CZ"
    # TTS-4b: no selection in this fixture, cs-CZ has no flagged row —
    # chain step 4 (best tier) answers: Ilja (Premium). The old code fell
    # through to the factory-flagged row of ANOTHER language (Samantha)
    # whenever cs-CZ held no flag; that is what made the UI name the
    # wrong 'macOS default'.
    assert d["system_voice"] == "Ilja"
    by = {v["identifier"]: v for v in d["voices"]}
    assert by["com.apple.voice.compact.cs-CZ.Zuzana"]["answers_default"] is True
    assert by["com.apple.speech.synthesis.voice.Samantha"]["answers_default"] is False
    assert by["com.apple.voice.compact.sk-SK.Laura"]["answers_default"] is False
    # unknown system language: the tab promises nothing
    monkeypatch.setattr(SE, "system_language", lambda force=False: "")
    d = client.get("/uplift/api/voices/say").json()
    assert d["system_language"] == ""
    assert not any(v.get("answers_default") for v in d["voices"])


def test_preferred_rejects_junk(client, on_mac):
    r = client.post("/uplift/api/voices/say/preferred", json={})
    assert r.status_code == 400
    r = client.post("/uplift/api/voices/say/preferred",
                    json={"locale": "cs-CZ", "identifier": "Nobody"})
    assert r.status_code == 404 and "not an installed" in r.text


def test_preferred_normalises_locale_spelling(client, on_mac):
    r = client.post("/uplift/api/voices/say/preferred", json={
        "locale": "cs_CZ", "identifier": "Ilja"})
    assert r.json()["preferred"] == {
        "cs-CZ": "com.apple.voice.premium.cs-CZ.Ilja"}


# ------------------------------------------------------------- dispatch

def test_bare_say_routes_by_request_language(client, on_mac, monkeypatch):
    seen = _fake_synth(monkeypatch)
    client.post("/uplift/api/voices/say/preferred", json={
        "locale": "cs-CZ", "identifier": "com.apple.voice.premium.cs-CZ.Ilja"})
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": "say", "input": "Ahoj",
                          "language": "cs-CZ"})
    assert r.status_code == 200, r.text
    name, text, _sp, _lg, pref = seen[-1]
    assert name == ""                       # routing happens in the engine
    assert pref["cs-CZ"] == "com.apple.voice.premium.cs-CZ.Ilja"


def test_standard_surface_locale_tail_and_voice_field(client, on_mac,
                                                      monkeypatch):
    seen = _fake_synth(monkeypatch)
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "say:cs-CZ", "input": "ahoj"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("audio/wav")
    assert seen[-1][0] == "cs-CZ"           # locale tail, verbatim
    # engine token in the voice field (the SDK habit)
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "gpt-4o-mini-tts", "voice": "say",
                          "input": "ahoj", "language": "sk"})
    assert r.status_code == 200, r.text
    assert seen[-1][0] == "" and seen[-1][3] == "sk"
    # explicit identifier in the voice field, no stored entry
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "x", "input": "hi",
                          "voice": "say:com.apple.ttsbundle.siri_cs-CZ_compact"})
    assert r.status_code == 200, r.text
    assert seen[-1][0] == "com.apple.ttsbundle.siri_cs-CZ_compact"


def test_language_without_voice_is_honest(client, on_mac, monkeypatch):
    # synth_bytes runs FOR REAL here (no subprocess): route() must raise
    # through the engine chain and the router must surface the reason
    r = client.post("/uplift/v1/audio/speech",
                    json={"model": "say", "input": "hallo",
                          "language": "de"})
    assert r.status_code == 502
    assert "language 'de'" in r.text


def test_stored_voice_accepts_locale_and_bare_say(client, on_mac):
    r = client.post("/uplift/api/voices", json={
        "name": "Cestina", "model": "say:cs-CZ", "language": "cs-CZ"})
    assert r.status_code == 200, r.text
    r = client.post("/uplift/api/voices", json={
        "name": "Auto", "model": "say"})
    assert r.status_code == 200, r.text
    r = client.post("/uplift/api/voices", json={
        "name": "Ghost", "model": "say:de"})
    assert r.status_code == 400 and "neither an installed" in r.text
    r = client.post("/uplift/api/voices", json={
        "name": "Ghost", "model": "say:com.apple.voice.nope"})
    assert r.status_code == 400


def test_stored_locale_voice_speaks(client, on_mac, monkeypatch):
    seen = _fake_synth(monkeypatch)
    vid = client.post("/uplift/api/voices", json={
        "name": "Cestina", "model": "say:cs-CZ"}).json()["voice"]["id"]
    r = client.post("/uplift/api/voices/speech",
                    json={"voice": vid, "input": "ahoj"})
    assert r.status_code == 200, r.text
    assert seen[-1][0] == "cs-CZ"


# --------------------------------------------------------------- locales
# The tab strings are assembled through tf(key, fallback) with
# {locale}/{voice} placeholders — invisible to the C.t literal gate, so
# they self-pin here (uplift-static-ui-gate doctrine: every family has
# exactly one owner file; this is that owner for say_mark/say_unmark/
# say_preferred_for and the SAY-2c button labels).

SAY2_KEYS = ("uplift.voices.say_mark", "uplift.voices.say_unmark",
             "uplift.voices.say_preferred_for",
             "uplift.voices.say_btn_mark", "uplift.voices.say_btn_clear",
             "uplift.voices.say_btn_override",
             "uplift.voices.say_btn_override_clear",
             "uplift.voices.say_system_default")
SAY2_DROPPED = ("uplift.voices.say_use", "uplift.voices.say_in_use",
                "uplift.voices.say_added_ok")
_PH_RE = re.compile(r"\{\w+\}")


def _phs(value):
    return sorted(_PH_RE.findall(value))


@pytest.mark.parametrize("loc", ["en", "cs", "es", "fr", "ja", "ko",
                                 "pt-BR", "ru", "zh", "zh-TW"])
def test_say2_locale_keys(loc):
    import json as _json
    from pathlib import Path as _P
    path = _P(__file__).parent.parent / "omlx_uplift" / "locales" / (loc + ".json")
    d = _json.loads(path.read_text())
    en = d if loc == "en" else _json.loads(
        (path.parent / "en.json").read_text())
    for k in SAY2_KEYS:
        assert k in d and d[k].strip(), "%s missing in %s" % (k, loc)
        assert _phs(d[k]) == _phs(en[k]), "%s placeholder drift in %s" % (k, loc)
        if loc != "en":
            assert d[k] != en[k], "%s untranslated in %s" % (k, loc)
    for k in SAY2_DROPPED:
        assert k not in d, "%s is dead copy in %s" % (k, loc)
    # the hint must teach the button, not the removed star or USE copy
    hint = d["uplift.voices.say_hint"]
    assert "★" not in hint and "USE" not in hint and "say:<locale>" in hint


# ---------------------------------------------------------------- SAY-5
# System Settings ▸ Spoken Content ▸ Voices per-language System Voice
# picks (macOS 26+ store in com.apple.Accessibility). User picks only —
# the engine claims nothing it cannot read.

OS_SEL_TEXT = '''(
        cs,
                {
            "_type" = "Speech.VoiceSelection";
            "_version" = 0;
            boundLanguage = cs;
            voiceId = "com.apple.voice.premium.cs-CZ.Zuzana";
        },
        en,
        {
            "_type" = "Speech.VoiceSelection";
            "_version" = 0;
            boundLanguage = en;
            voiceId = "com.apple.speech.synthesis.voice.GoodNews";
        }
)'''


def test_parse_spoken_selections_real_output():
    sel = SE._parse_spoken_selections(OS_SEL_TEXT)
    assert sel == {"cs": "com.apple.voice.premium.cs-CZ.Zuzana",
                   "en": "com.apple.speech.synthesis.voice.GoodNews"}


def test_parse_spoken_selections_pairing_and_junk():
    # no boundLanguage: the scalar BEFORE the block pairs with it
    sel = SE._parse_spoken_selections('(de, {\nvoiceId = "x.y.Z";\n})')
    assert sel == {"de": "x.y.Z"}
    # records missing either half, junk and empty input never raise
    assert SE._parse_spoken_selections('({\n"_type" = "junk";\n})') == {}
    assert SE._parse_spoken_selections("") == {}
    assert SE._parse_spoken_selections(None) == {}


def test_os_selection_beats_factory_flag(on_mac, monkeypatch):
    # the user's Czech pick is Zuzana (Premium): that row answers cs-CZ
    # and the badge set moves with it — routing and chip share the chain
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False:
                        {"cs": "com.apple.voice.premium.cs-CZ.Zuzana"})
    on_mac._cache.update(ts=9e15, voices=[dict(r) for r in ZUZ_PAIR])
    assert SE.language_voice("cs-CZ", {})["identifier"] == \
        "com.apple.voice.premium.cs-CZ.Zuzana"
    assert SE.effective_default_addrs() == \
        {"com.apple.voice.premium.cs-CZ.Zuzana"}
    assert SE.route("", "cs-CZ") == "com.apple.voice.premium.cs-CZ.Zuzana"


def test_preferred_mark_still_outranks_the_os_selection(on_mac, monkeypatch):
    # uplift's own mark is the operator's explicit word; System Settings
    # answers only where uplift has not spoken
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False:
                        {"cs": "com.apple.voice.premium.cs-CZ.Zuzana"})
    on_mac._cache.update(ts=9e15, voices=[dict(r) for r in ZUZ_PAIR])
    marked = SE.language_voice(
        "cs-CZ", {"cs-CZ": "com.apple.voice.super-compact.cs-CZ.Zuzana"})
    assert marked["identifier"] == \
        "com.apple.voice.super-compact.cs-CZ.Zuzana"


def test_uninstalled_selection_falls_back_honestly(on_mac, monkeypatch):
    # the picked voice was deleted from this Mac: we must not address a
    # voice that cannot speak — the pre-SAY-5 chain answers untouched
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False:
                        {"cs": "com.apple.voice.premium.cs-CZ.Nonexistent"})
    on_mac._cache.update(ts=9e15, voices=[dict(r) for r in ZUZ_PAIR])
    assert SE.system_selected_voice("cs-CZ") is None
    assert SE.language_voice("cs-CZ", {})["identifier"] == \
        "com.apple.voice.super-compact.cs-CZ.Zuzana"


def test_primary_key_answers_the_whole_language_family(on_mac, monkeypatch):
    # Spoken Content lists 'English' once; the en pick answers en-US...
    rows = [dict(r) for r in ZUZ_PAIR] + [
        {"name": "Ava", "locale": "en-GB", "quality": "standard",
         "identifier": "com.apple.voice.compact.en-GB.Ava",
         "installed": True, "default": True}]
    on_mac._cache.update(ts=9e15, voices=rows)
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False:
                        {"en": "com.apple.voice.compact.en-GB.Ava"})
    assert SE.language_voice("en-GB", {})["name"] == "Ava"
    # ...and never leaks into another language family
    assert SE.language_voice("cs-CZ", {})["name"].startswith("Zuzana")


def test_say_list_badges_the_os_selection(client, monkeypatch, on_mac):
    rows = [dict(r) for r in ZUZ_PAIR]
    for r in rows:
        r.update(sample="", downloaded=r["quality"] != "standard")
    on_mac._cache.update(ts=9e15, voices=rows)
    vs = {v["identifier"]: v for v in
          client.get("/uplift/api/voices/say").json()["voices"]}
    assert vs["com.apple.voice.super-compact.cs-CZ.Zuzana"]["default"] is True
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False:
                        {"cs": "com.apple.voice.premium.cs-CZ.Zuzana"})
    vs = {v["identifier"]: v for v in
          client.get("/uplift/api/voices/say").json()["voices"]}
    assert vs["com.apple.voice.premium.cs-CZ.Zuzana"]["default"] is True
    assert vs["com.apple.voice.super-compact.cs-CZ.Zuzana"]["default"] is False
