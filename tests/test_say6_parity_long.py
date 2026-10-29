"""SAY-6: parity with the vanilla macOS-speech work (kocour, 2026-10-29).

Two things came over from `feat/tts-macos-say`:

* addressing — a voice display name is not unique on macOS (the Eloquence
  family exists once per language), so `say:<name>:<locale>` addresses one row
  and a pinned language the name does not cover is refused, not ignored;
* long replies — the engine used to cut the text at 10000 characters silently,
  which lost the end of an answer and reported success. Now a long reply is
  rendered in sentence-sized pieces stitched into ONE file on disk, so memory
  tracks the longest piece, and the limit an operator sets is in MB of audio
  because characters say nothing about the size of speech.

Every test here is pure or monkeypatched: CI runs them on Linux where `say`
does not exist, and the subprocess is captured rather than stubbed at the
Response level so the real contract is the one under test.
"""
from __future__ import annotations

import os
import wave
from pathlib import Path

import pytest
from fastapi import HTTPException

from omlx_uplift import say_engine as SE
from omlx_uplift.routers import voices as V

# tests/ is not a package, so the roster and the fixtures that SAY-1 built are
# restated here rather than imported across test modules.
ROSTER = """Albert              en_US    # Hello! My name is Albert.
Zuzana               cs_CZ    # Ahoj! Já jsem Zuzana.
Rico                 it_IT    # Ciao! Mi chiamo Rico.
Rico                 pt_BR    # Olá! Meu nome é Rico.
"""

# One display name, two languages: the shape the old code could not express.
# Nothing invented here — this is the Eloquence family on a normal macOS.
SHARED_ROSTER = ROSTER


@pytest.fixture()
def on_mac(monkeypatch):
    """Pretend this box has the engine, with an isolated empty cache."""
    monkeypatch.setattr(SE, "available", lambda: True)
    monkeypatch.setattr(SE, "_cache", {"ts": 0.0, "voices": []})
    monkeypatch.setattr(SE, "_downloaded_names", lambda: set())
    monkeypatch.setattr(SE, "_catalog_rows", lambda: [])
    monkeypatch.setattr(SE, "selected_voice_identifier",
                        lambda force=False: "")
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False: {})
    monkeypatch.setattr(SE, "_os_sel_cache", {"ts": 9e15, "map": {}})
    return SE


def _as_say(engine, roster=ROSTER):
    engine._cache.update(ts=9e15, voices=engine.parse_voices(roster))

ROWS = [
    {"name": "Zuzana", "locale": "cs-CZ", "quality": "standard",
     "sample": "Ahoj", "identifier": "com.apple.voice.super-compact.cs-CZ.Zuzana",
     "installed": True, "default": False, "downloaded": False},
    {"name": "Zuzana (Premium)", "locale": "cs-CZ", "quality": "premium",
     "sample": "Ahoj", "identifier": "com.apple.voice.premium.cs-CZ.Zuzana",
     "installed": True, "default": False, "downloaded": True},
    {"name": "Rico", "locale": "it-IT", "quality": "standard",
     "sample": "Ciao", "identifier": "com.apple.eloquence.it-IT.Rico",
     "installed": True, "default": False, "downloaded": False},
    {"name": "Rico", "locale": "pt-BR", "quality": "standard",
     "sample": "Ola", "identifier": "com.apple.eloquence.pt-BR.Rico",
     "installed": True, "default": False, "downloaded": False},
]


@pytest.fixture()
def shared(on_mac, monkeypatch):
    """The same Mac with a shared display name and a tiered one."""
    monkeypatch.setattr(SE, "list_voices", lambda force=False: list(ROWS))
    return on_mac


# ------------------------------------------------------- addressing parity --

def test_the_language_may_be_written_on_either_side_of_the_name(shared):
    assert SE.parse_voice_language("Rico") == ("Rico", "")
    assert SE.parse_voice_language("Rico:pt-BR") == ("Rico", "pt-BR")
    assert SE.parse_voice_language("pt-BR:Rico") == ("Rico", "pt-BR")
    # identifiers are dotted, so they must never be torn apart
    assert SE.parse_voice_language("com.apple.eloquence.pt-BR.Rico") == (
        "com.apple.eloquence.pt-BR.Rico", "")


def test_a_shared_name_without_a_language_still_answers(shared):
    """Naming a voice alone is a real request and it speaks; that is exactly
    why the UI has to say which language it will be."""
    assert SE.resolve("Rico")["locale"] == "it-IT"


@pytest.mark.parametrize("address,locale", [
    ("Rico:pt-BR", "pt-BR"), ("pt-BR:Rico", "pt-BR"), ("Rico:it-IT", "it-IT"),
])
def test_a_pinned_language_picks_that_row(shared, address, locale):
    assert SE.resolve(address)["locale"] == locale


def test_a_pinned_language_the_name_does_not_cover_resolves_to_nothing(shared):
    assert SE.resolve("Rico:de-DE") is None
    assert SE.name_languages("Rico") == ["it-IT", "pt-BR"]


def test_route_lists_the_languages_a_pinned_name_does_cover(shared):
    with pytest.raises(LookupError) as exc:
        SE.route("Rico:de-DE", None, {}, "Hallo")
    text = str(exc.value)
    assert "it-IT" in text and "pt-BR" in text and "de-DE" in text
    assert "identifier" in text


def test_a_named_voice_outlives_a_language_field_but_not_its_own(shared):
    """Beside a language field the voice wins (the long-standing contract, and
    what `say -v` does); written into the address, both halves are meant."""
    assert SE.route("Rico:pt-BR", None, {}, "Ola") == "com.apple.eloquence.pt-BR.Rico"
    assert SE.route("Rico", "pt-BR", {}, "Ola") == "com.apple.eloquence.it-IT.Rico"


def test_a_tier_in_the_display_name_stays_addressable(shared):
    """'(Premium)' is how macOS lists the voice, and the model arrives in a
    JSON body, so a space needs no encoding. Pinned so nobody 'cleans' it."""
    assert SE.resolve("Zuzana (Premium)")["quality"] == "premium"
    assert SE.route("Zuzana (Premium)", None, {}, "Ahoj") == (
        "com.apple.voice.premium.cs-CZ.Zuzana")


def test_the_shared_roster_parses_from_the_real_say_output(on_mac):
    on_mac._cache.update(ts=9e15, voices=on_mac.parse_voices(SHARED_ROSTER))
    rows = on_mac.list_voices()
    assert [r["name"] for r in rows].count("Rico") == 2
    # `say -v ?` spells locales with an underscore (pt_BR) while callers write
    # BCP-47 (pt-BR); the scorer normalizes both sides, so the pin below has to
    # land on the Brazilian row even though the roster never says "pt-BR".
    pinned = on_mac.resolve("Rico:pt-BR")
    assert on_mac._norm_locale(pinned["locale"]) == "pt-BR"


# --------------------------------------------------------------- splitter  --

SHAPES = {
    "sentences": "One two three. Four five six! Seven eight nine? " * 40,
    "paragraphs": "First line.\n\nSecond paragraph is longer than the first.\n"
                  "Third one ends here.\n" * 20,
    "cjk": "こんにちは。元気がでる歌をうたおう。今日はいい天気ですね。" * 25,
    "no punctuation": "alpha beta gamma delta epsilon zeta eta theta " * 30,
    "one long word": "x" * 4000,
}


@pytest.mark.parametrize("shape", sorted(SHAPES))
@pytest.mark.parametrize("chunk", [60, 300, 1200, 0])
def test_the_splitter_loses_nothing_and_obeys_the_cap(shape, chunk):
    text = SHAPES[shape]
    pieces = SE.split_text(text, chunk)
    assert "".join(pieces).replace(" ", "").replace("\n", "") == \
        text.strip().replace(" ", "").replace("\n", ""), "text must survive"
    if chunk:
        assert all(len(p) <= chunk for p in pieces), "a piece outran the cap"
    else:
        assert pieces == [text.strip()], "0 means one call"


def test_a_short_reply_is_never_split(on_mac):
    assert SE.split_text("Ahoj.", 1200) == ["Ahoj."]
    assert SE.split_text("   ", 1200) == []


def test_the_wav_header_is_44_bytes_and_tells_the_truth():
    hdr = SE.wav_header(24000, 1, 2, 48000)
    assert len(hdr) == 44
    import struct
    assert struct.unpack("<I", hdr[4:8])[0] == 36 + 48000, "RIFF size"
    assert struct.unpack("<I", hdr[40:44])[0] == 48000, "data size"
    assert struct.unpack("<I", hdr[24:28])[0] == 24000, "sample rate"


# ------------------------------------------------------- spool and stitch  --

def _fake_say_wav(text, rate=24000, frames_per_char=1):
    """A WAV whose payload length is its text length, so a stitch can be
    measured in bytes instead of trusted."""
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x01\x02" * max(1, len(text) * frames_per_char))
    return buf.getvalue()


@pytest.fixture()
def fake_say(on_mac, monkeypatch):
    """`say` answers with a deterministic WAV per call, and every call is
    recorded so segmentation can be observed."""
    calls = []
    monkeypatch.setattr(SE, "available", lambda: True)
    _as_say(on_mac)

    def fake(text, target="", speed=None):
        calls.append({"text": text, "target": target, "speed": speed})
        return _fake_say_wav(text)

    monkeypatch.setattr(SE, "synth_wav", fake)
    return calls


def test_pieces_become_one_honest_wav(shared, fake_say, tmp_path):
    out = str(tmp_path / "stitched.wav")
    pieces = ["First sentence here.", "Second sentence here.", "Third one."]
    rate, channels, width, total = SE.spool_wav(pieces, "com.apple.x", None,
                                                10 * 1000000, out)
    assert len(fake_say) == 3, "one call per piece"
    assert {c["target"] for c in fake_say} == {"com.apple.x"}, \
        "routing happened once, not per piece"
    with wave.open(out, "rb") as wf:
        assert wf.getnframes() * 2 == total
        assert wf.getframerate() == rate == 24000
        assert (wf.getnchannels(), wf.getsampwidth()) == (channels, width) == (1, 2)
    assert os.path.getsize(out) == total + 44, "header matches the payload"
    joined = "".join(c["text"] for c in fake_say)
    assert joined.replace(" ", "") == "".join(pieces).replace(" ", "")


def test_the_ceiling_refuses_instead_of_truncating(shared, fake_say, tmp_path):
    # 1000 characters per piece, 2 bytes of audio per character: the fourth
    # piece is what walks past a 5000-byte ceiling
    out = str(tmp_path / "capped.wav")
    with pytest.raises(RuntimeError, match="ceiling"):
        SE.spool_wav(["word " * 200] * 4, "x", None, 5000, out)
    assert os.path.getsize(out) <= 5000 + 44, "refused at the crossing, not after"


def test_a_voice_that_changes_format_mid_reply_is_reported(shared, monkeypatch,
                                                          tmp_path):
    """Never stitch two rates into one file and call it audio."""
    seq = [_fake_say_wav("ab", rate=24000), _fake_say_wav("cd", rate=22050)]
    monkeypatch.setattr(SE, "available", lambda: True)

    def fake(text, target="", speed=None):
        return seq.pop(0)

    monkeypatch.setattr(SE, "synth_wav", fake)
    with pytest.raises(RuntimeError, match="changed format"):
        SE.spool_wav(["ab", "cd"], "x", None, 10 * 1000000,
                     str(tmp_path / "bad.wav"))


def test_synth_bytes_renders_a_long_text_whole_without_truncating(shared,
                                                                 fake_say):
    """The retired contract cut the text at MAX_SAY_CHARS and said nothing.
    Refusing is allowed; losing the end of an answer is not."""
    text = "word " * 3000
    SE.synth_bytes("Zuzana", text)
    assert len(fake_say) == 1
    assert fake_say[0]["text"] == text.strip(), "the whole text reached `say`"
    assert fake_say[0]["text"].count("word") == 3000, "not sliced at the cap"


def test_an_absurd_reply_is_refused_before_anything_renders(shared, fake_say):
    with pytest.raises(RuntimeError, match=str(SE.MAX_SAY_CHARS)):
        SE.synth_bytes("Zuzana", "x" * (SE.MAX_SAY_CHARS + 1))
    assert fake_say == [], "a refusal must not render"


# ---------------------------------------------------------------- limits   --

@pytest.mark.parametrize("raw,expected", [
    (None, SE.DEFAULT_CHUNK_CHARS), (0, 0), ("off", SE.DEFAULT_CHUNK_CHARS),
    (50, SE.MIN_CHUNK_CHARS), (99999, SE.MAX_CHUNK_CHARS), ("1500.9", 1500),
])
def test_chunk_size_is_cleaned_not_trusted(raw, expected):
    assert SE.clean_chunk_chars(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    (None, SE.DEFAULT_MAX_AUDIO_MB), (0, SE.DEFAULT_MAX_AUDIO_MB),
    (-5, SE.DEFAULT_MAX_AUDIO_MB), (99999, SE.MAX_MAX_AUDIO_MB),
    ("64", 64), (1, SE.MIN_MAX_AUDIO_MB),
])
def test_ceiling_is_cleaned_and_cannot_be_switched_off(raw, expected):
    assert SE.clean_max_audio_mb(raw) == expected


def test_the_store_supplies_both_limits(monkeypatch):
    """A board that never set them gets the defaults; one that holds junk gets
    the defaults too, never an unbounded render."""
    store = {"voices": [], "say_chunk_chars": "nonsense", "say_max_audio_mb": 0}
    monkeypatch.setattr(V, "_load", lambda: dict(store))
    assert V._say_limits() == (SE.DEFAULT_CHUNK_CHARS, SE.DEFAULT_MAX_AUDIO_MB)
    store.update(say_chunk_chars=300, say_max_audio_mb=32)
    assert V._say_limits() == (300, 32)
    store.update(say_chunk_chars=0)
    assert V._say_limits() == (0, 32), "0 is a choice, not junk"


# --------------------------------------------------------- router contract --

@pytest.fixture()
def spools():
    """Fail any test that leaves a spool behind: a leaked temp file per
    request is how a Mac quietly runs out of space."""
    import glob
    import tempfile
    pat = os.path.join(tempfile.gettempdir(), "uplift-say-*")
    before = set(glob.glob(pat))
    yield
    leaked = sorted(set(glob.glob(pat)) - before)
    for path in leaked:
        try:
            (os.rmdir if os.path.isdir(path) else os.unlink)(path)
        except OSError:
            pass
    assert not leaked, "spool files left behind: %s" % [os.path.basename(x)
                                                        for x in leaked]


def _stub_render(monkeypatch, pieces_seen, frames_per_char=1):
    """Record the segmentation the router chose and answer with WAVs sized to
    match their text, so a byte ceiling can be expressed in characters."""
    _as_say(SE)
    monkeypatch.setattr(SE, "available", lambda: True)

    def fake(text, target="", speed=None):
        pieces_seen.append(text)
        return _fake_say_wav(text, frames_per_char=frames_per_char)

    monkeypatch.setattr(SE, "synth_wav", fake)
    monkeypatch.setattr(SE, "route", lambda *a, **k: "com.apple.x")


def test_a_short_reply_stays_a_plain_response(shared, monkeypatch, spools):
    seen = []
    _stub_render(monkeypatch, seen)
    monkeypatch.setattr(V, "_say_limits", lambda: (1200, 256))
    import asyncio
    resp = asyncio.run(V._say_response("Zuzana", "Ahoj, jak se máš?"))
    assert resp.__class__.__name__ == "Response", "no spool for a sentence"
    assert resp.body.startswith(b"RIFF"), "the cache reads .body"
    assert seen == ["Ahoj, jak se máš?"]


def test_a_long_reply_is_spooled_and_cleaned_up(shared, monkeypatch, spools):
    import asyncio
    seen = []
    _stub_render(monkeypatch, seen)
    monkeypatch.setattr(V, "_say_limits", lambda: (300, 256))
    text = "One two three four five six seven. " * 40          # ~1720 chars
    resp = asyncio.run(V._say_response("Zuzana", text))
    assert resp.__class__.__name__ == "FileResponse"
    assert len(seen) > 1, "the reply was rendered in pieces"
    assert "".join(seen).replace(" ", "") == text.replace(" ", "")
    assert os.path.getsize(resp.path) == sum(len(s) for s in seen) * 2 + 44
    assert resp.headers.get("X-Uplift-TTS-Cache") == "spooled", \
        "an uncached reply must say so"
    resp.background.func(*resp.background.args, **resp.background.kwargs)
    assert not os.path.exists(resp.path)


def test_a_spooled_reply_reports_a_ceiling_as_an_error(shared, monkeypatch,
                                                       spools):
    import asyncio
    seen = []
    _stub_render(monkeypatch, seen, frames_per_char=2000)   # 4 KB per character
    monkeypatch.setattr(V, "_say_limits", lambda: (300, 1))  # 1 MB ceiling
    with pytest.raises(HTTPException) as exc:
        asyncio.run(V._say_response("Zuzana", "word " * 400))
    assert exc.value.status_code == 502
    assert "ceiling" in str(exc.value.detail)


def test_a_single_call_reply_under_a_tiny_ceiling_is_still_honest(
        shared, monkeypatch, spools):
    """chunk 0 means the caller asked for one `say` call, so the byte ceiling
    has to be checked on that path too — a refusal, never a surprise."""
    import asyncio
    seen = []
    _stub_render(monkeypatch, seen)
    monkeypatch.setattr(V, "_say_limits", lambda: (0, 256))
    text = "One two three four five six seven. " * 40
    resp = asyncio.run(V._say_response("Zuzana", text))
    assert resp.__class__.__name__ == "Response"
    assert len(seen) == 1, "one call for the whole reply"


# ------------------------------------------------------------- conversion  --

def test_convert_file_hands_the_work_to_ffmpeg_and_keeps_it_off_the_heap(
        shared, tmp_path, monkeypatch):
    src = tmp_path / "a.wav"
    dst = tmp_path / "a.mp3"
    src.write_bytes(_fake_say_wav("hello"))
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!%s\nimport sys\nopen(sys.argv[-1], 'wb').write(b'ID3FAKE')\n"
                    % os.sys.executable)
    fake.chmod(0o755)
    monkeypatch.setattr(SE.shutil, "which", lambda name: str(fake))
    SE.convert_file(str(src), str(dst), "mp3")
    assert dst.read_bytes() == b"ID3FAKE"


def test_convert_file_without_ffmpeg_says_which_format_it_cannot_do(
        shared, tmp_path, monkeypatch):
    monkeypatch.setattr(SE.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="mp3"):
        SE.convert_file(str(tmp_path / "a.wav"), str(tmp_path / "a.mp3"), "mp3")


def test_convert_file_refuses_a_mismatched_extension(shared, tmp_path):
    """The suffix is what ffmpeg reads as the target format: a caller that
    builds '.wav' out of a 'mp3' request must be stopped here, not served."""
    with pytest.raises(ValueError):
        SE.convert_file(str(tmp_path / "a.wav"), str(tmp_path / "a.wav"), "mp3")


def test_convert_wav_still_works_from_bytes(shared, monkeypatch):
    """The short path keeps its byte-in byte-out contract; only long replies
    go through a file."""
    monkeypatch.setattr(SE, "convert_file",
                        lambda src, dst, fmt: Path(dst).write_bytes(b"OK"))
    assert SE.convert_wav(b"WAVVAV", "mp3") == b"OK"
    assert SE.convert_wav(b"WAVVAV", "wav") == b"WAVVAV"


# ------------------------------------------------- the row clicked is the row
# that speaks (found by the live QA of this same deploy, 2026-10-29)

SHELVES = [
    {"name": "Shelley", "identifier": "com.apple.eloquence.de-DE.Shelley",
     "locale": "de-DE", "quality": "default", "sample": "Hallo!",
     "installed": True, "downloaded": True, "default": False},
    {"name": "Shelley", "identifier": "com.apple.eloquence.pt-BR.Shelley",
     "locale": "pt-BR", "quality": "default", "sample": "Olá!",
     "installed": True, "downloaded": True, "default": False},
]


class _Audition:
    """The smallest thing POST /voices/say/speech reads: a JSON body."""

    def __init__(self, **body):
        self._body = body

    async def json(self):
        return self._body


def _two_shelvies(monkeypatch):
    """Install the two rows and watch which address reaches `say`."""
    monkeypatch.setattr(SE, "available", lambda: True)
    monkeypatch.setattr(SE, "_cache",
                        {"ts": 9e15, "voices": [dict(r) for r in SHELVES]})
    monkeypatch.setattr(SE, "_downloaded_names", lambda: set())
    monkeypatch.setattr(SE, "_catalog_rows", lambda: [])
    monkeypatch.setattr(SE, "_av_rows", lambda: [])
    monkeypatch.setattr(SE, "selected_voice_identifier", lambda force=False: "")
    monkeypatch.setattr(SE, "spoken_selections", lambda force=False: {})
    monkeypatch.setattr(SE, "_os_sel_cache", {"ts": 9e15, "map": {}})
    monkeypatch.setattr(V, "_say_limits", lambda: (1200, 256))
    monkeypatch.setattr(V, "_say_preferred", lambda: {})
    heard = {}

    def fake(text, target="", speed=None):
        heard["target"] = target
        heard["text"] = text
        return b"RIFF" + b"\0" * 44 + b"\0" * 44
    monkeypatch.setattr(SE, "synth_wav", fake)
    return heard


def test_the_audition_speaks_the_row_it_resolved(monkeypatch, spools):
    """Two 'Shelley' rows, two languages: the Eloquence family on a normal Mac.

    The audition resolved the addressed row and then handed the bare DISPLAY
    NAME to the renderer, which routed it a SECOND time - and the second trip
    through a name that collides can land on the other row. Clicking Brazilian
    Portuguese heard German. The resolved row must reach the renderer."""
    import asyncio
    heard = _two_shelvies(monkeypatch)
    asyncio.run(V.voices_say_speech(_Audition(name="Shelley:pt-BR")))
    assert heard["target"] == "com.apple.eloquence.pt-BR.Shelley", heard
    assert heard["text"] == "Olá!", "the greeting comes from the same row"


def test_an_unpinned_audition_still_answers_the_best_row(monkeypatch, spools):
    """Naming a shared voice with NO language keeps the old contract: the first
    installed row that carries it answers, so nothing that worked before
    starts needing the pinned form."""
    import asyncio
    heard = _two_shelvies(monkeypatch)
    asyncio.run(V.voices_say_speech(_Audition(name="Shelley")))
    assert heard["target"] == SHELVES[0]["identifier"], heard


def test_a_pinned_language_the_name_lacks_is_answered(monkeypatch, spools):
    """'Shelley:cs-CZ' has no row. It must not silently speak another language:
    the answer names the languages that DO carry the name."""
    import asyncio
    _two_shelvies(monkeypatch)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(V.voices_say_speech(_Audition(name="Shelley:cs-CZ")))
    assert exc.value.status_code == 404
    detail = str(exc.value.detail)
    # The answer has to be actionable on its own: which voice, which languages
    # it DOES have, which one was asked for.
    assert "Shelley" in detail and "de-DE" in detail and "pt-BR" in detail, detail
    assert "cs-CZ" in detail and "not for" in detail, detail
