"""macOS `say` as a TTS engine — no model, no GPU, instant.

The box that runs uplift is by definition a Mac, and every Mac ships the
speech synthesizer behind the `say` command with a roster of system
voices (per-locale, plus whatever the owner downloaded through System
Settings > Spoken Content > Voices). For reading replies aloud that is
often exactly enough: zero RAM, zero load time, and the voice is the one
the user's accessibility setup already sounds like.

Contract of this module:
- availability is probed, never assumed (non-macOS / stripped systems
  return available() False and the UI hides the feature);
- the voice list comes from `say -v ?` — the ground truth of what THIS
  machine can actually speak. Lines look like
      Zuzana               cs_CZ    # Ahoj! Já jsem Zuzana.
      Samantha (English (US)) en_US # Hello! My name is Samantha.
  so the name is everything before the locale token (it may contain
  spaces and parentheses) and the greeting doubles as the audition
  sample;
- quality tiers ride IN the name on modern macOS ('Foo (Enhanced)',
  'Foo (Premium)', 'Foo (Personal)'); plain names are Standard;
- 'downloaded' is best-effort: voices the owner added land as
  *.SpeechVoice bundles under ~/Library/Speech/Voices (user) or
  /Library/Speech/Voices (all users). Bundles are the only on-disk
  truth readable without root, so voices outside them are simply NOT
  badged (we never claim 'System' for something we cannot prove);
- synthesis writes the text to a temp file and runs
  `say -v NAME -f FILE -o OUT --data-format=LEI16@22050`, producing a
  plain 22.05 kHz mono RIFF WAV. argv is a list, the voice name must
  match an installed voice exactly, and the text is capped — no shell,
  no injection surface, no unbounded work;
- formats other than WAV are transcoded with the same optional ffmpeg
  the reference-clip path uses; without ffmpeg the call fails 415 with
  the reason instead of lying about the bytes.
"""
from __future__ import annotations

import logging
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

SAY_PREFIX = "say:"            # voice.model marker for this engine
MAX_SAY_CHARS = 10000          # a whole long reply already; keep the cap honest
_TIMEOUT_S = 180
_SAMPLE_RATE = 22050
_BASE_WPM = 175                # say's default pace is ~175-190; multipliers ride on it
_CACHE_TTL_S = 300

_LINE_RE = re.compile(
    r"^(?P<name>.+?)\s+(?P<locale>[a-z]{2}(?:[-_][A-Za-z0-9]{2,6})*(?:-x)?)"
    r"\s+#\s*(?P<sample>.*)$")

_TIERS = (("premium", "(Premium)"), ("enhanced", "(Enhanced)"),
          ("personal", "(Personal)"))


def available() -> bool:
    """True when `say` exists on this platform. Probed per call (cheap
    PATH lookup) so a dev box without the binary behaves like Linux."""
    return sys.platform == "darwin" and shutil.which("say") is not None


def parse_voices(text: str) -> list:
    """`say -v ?` output -> [{name, locale, quality, sample}].

    Tolerates junk lines (they are skipped, not fatal): the roster is a
    system file we do not control."""
    out = []
    for line in (text or "").splitlines():
        m = _LINE_RE.match(line.strip())
        if not m:
            continue
        name = m.group("name").strip()
        if not name:
            continue
        quality = "standard"
        for tier, tag in _TIERS:
            if tag.lower() in name.lower():
                quality = tier
                break
        out.append({"name": name, "locale": m.group("locale").strip(),
                    "quality": quality, "sample": m.group("sample").strip()})
    return out


def _downloaded_names() -> set:
    """Voice names backed by *.SpeechVoice bundles in the two readable
    install locations. Name = bundle's VoiceName, else bundle basename."""
    found = set()
    for base in (Path.home() / "Library" / "Speech" / "Voices",
                 Path("/Library/Speech/Voices")):
        try:
            bundles = list(base.glob("*.SpeechVoice"))
        except OSError:
            continue
        for b in bundles:
            plist = b / "Contents" / "Info.plist"
            name = ""
            try:
                with open(plist, "rb") as fh:
                    name = str(plistlib.load(fh).get("VoiceName") or "")
            except (OSError, ValueError):
                pass
            found.add((name or b.stem).strip())
    return found


_cache: dict = {"ts": 0.0, "voices": []}


def list_voices(force: bool = False) -> list:
    """Installed voices + downloaded badge, cached (the roster changes only
    when the owner downloads in System Settings — 5 min is plenty)."""
    if not available():
        return []
    now = time.time()
    if not force and now - _cache["ts"] < _CACHE_TTL_S:
        return _cache["voices"]
    try:
        p = subprocess.run(["say", "-v", "?"], capture_output=True,
                           text=True, timeout=15)
        voices = parse_voices(p.stdout or "")
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("say voice probe failed: %s", e)
        voices = []
    downloaded = _downloaded_names()
    for v in voices:
        v["downloaded"] = v["name"] in downloaded
    # keep the previous stamp only when the roster survived parsing, so a
    # transient junk run does not pin a bad list for a cache lifetime
    if voices:
        _cache.update(ts=now, voices=voices)
    return voices


def resolve(name: str) -> Optional[dict]:
    """Exact-match a requested voice name against the installed roster
    (case-sensitive: `say` itself is, and the list we render came from it).
    A miss refreshes the roster once: the owner may have downloaded the
    voice in System Settings seconds ago, and waiting out a cache TTL to
    accept it would read as a bug."""
    if not name:
        return None
    for v in list_voices():
        if v["name"] == name:
            return v
    for v in list_voices(force=True):
        if v["name"] == name:
            return v
    return None


def say_name_of(model: str) -> str:
    """'say:Zuzana' -> 'Zuzana' (the model marker stores the raw name)."""
    return str(model or "")[len(SAY_PREFIX):] if str(model or "").startswith(
        SAY_PREFIX) else ""


def _speed_wpm(speed) -> Optional[str]:
    try:
        mult = float(str(speed).strip() or "nan")
    except (TypeError, ValueError):
        return None
    if mult != mult or mult <= 0:            # NaN guard; junk = engine default
        return None
    return str(max(80, min(450, round(_BASE_WPM * mult))))


_MEDIA = {"wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac",
          "opus": "audio/ogg", "aac": "audio/aac", "pcm": "audio/L16;codec=pcm"}


def synth_bytes(name: str, text: str, speed=None) -> bytes:
    """Render one utterance to plain WAV bytes. Raises RuntimeError with a
    user-safe reason; input never reaches a shell."""
    if resolve(name) is None:
        raise RuntimeError("voice '%s' is not installed on this Mac" % name)
    text = (text or "").strip()
    if not text:
        raise RuntimeError("nothing to say")
    if len(text) > MAX_SAY_CHARS:
        text = text[:MAX_SAY_CHARS]     # truncate, don't punish the whole reply
    args = ["say", "-v", name]
    wpm = _speed_wpm(speed)
    if wpm:
        args += ["-r", wpm]
    with tempfile.TemporaryDirectory(prefix="uplift-say-") as td:
        src = Path(td) / "in.txt"
        dst = Path(td) / "out.wav"
        src.write_text(text, encoding="utf-8")
        cmd = args + ["-f", str(src), "-o", str(dst),
                      "--data-format=LEI16@%d" % _SAMPLE_RATE]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise RuntimeError("macOS say timed out after %ds" % _TIMEOUT_S)
        except OSError as e:
            raise RuntimeError("macOS say failed to start: %s" % e.strerror)
        if p.returncode != 0 or not dst.is_file() or dst.stat().st_size < 100:
            reason = (p.stderr or "").strip()[:200] or "no audio produced"
            raise RuntimeError("macOS say: %s" % reason)
        return dst.read_bytes()


def convert_wav(wav: bytes, fmt: str) -> bytes:
    """WAV -> fmt with the repo's optional-ffmpeg pattern. fmt 'wav' is a
    no-op; unknown formats raise ValueError, missing ffmpeg raises
    RuntimeError (callers map both to 4xx/5xx honestly)."""
    fmt = (fmt or "wav").lower().strip()
    if fmt in ("wav", ""):
        return wav
    if fmt not in _MEDIA:
        raise ValueError("unsupported format '%s'" % fmt)
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError("this server has no ffmpeg: macOS say answers WAV "
                           "only (response_format='%s' cannot be honoured)"
                           % fmt)
    with tempfile.TemporaryDirectory(prefix="uplift-say-") as td:
        src = Path(td) / "in.wav"
        dst = Path(td) / ("out." + ("ogg" if fmt == "opus" else fmt))
        src.write_bytes(wav)
        p = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(src),
                            str(dst)], capture_output=True, text=True,
                           timeout=_TIMEOUT_S)
        if p.returncode != 0 or not dst.is_file():
            raise RuntimeError("ffmpeg conversion to %s failed" % fmt)
        return dst.read_bytes()


def media_type(fmt: str) -> str:
    return _MEDIA.get((fmt or "wav").lower().strip(), "audio/wav")
