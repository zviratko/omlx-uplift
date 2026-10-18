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

# The installed-voice catalog System Settings itself uses: AVFoundation
# sees voices the CLI roster omits (downloaded Siri/neural sets) and
# carries the true audio quality (Default/Enhanced/Premium) in the
# object description. Probed headless through AppleScriptObjC — works
# over ssh and in launchd sessions (verified); a failure degrades to
# the plain `say -v ?` list, never to an empty tab.
_AV_PROBE = '''use framework "AVFoundation"
use scripting additions
set vs to current application's AVSpeechSynthesisVoice's speechVoices()
set n to (vs's |count|()) as integer
set out to ""
repeat with i from 0 to (n - 1)
\tset v to vs's objectAtIndex:i
\tset nm to (v's |name|()) as text
\tset lg to (v's language()) as text
\tset idr to (v's identifier()) as text
\tset dsc to (v's |description|()) as text
\tset out to out & nm & "\t" & lg & "\t" & idr & "\t" & dsc & "
"
end repeat
return out
'''

_QUALITY_RE = re.compile(r"Quality:\s*([A-Za-z-]+)")


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
                    "quality": quality, "sample": m.group("sample").strip(),
                    "identifier": name})   # CLI rows have no id: the name IS it
    return out


def parse_av(text: str) -> list:
    """AV probe output -> rows {name, locale, quality, identifier, desc}.
    Locale keeps AV's BCP-47 spelling (en-US); the UI normalises."""
    out = []
    for line in (text or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name, lang, ident, desc = (p.strip() for p in parts[:4])
        if not name or not ident:
            continue
        m = _QUALITY_RE.search(desc)
        q = (m.group(1).lower() if m else "default")
        if q == "default":
            q = "standard"        # same vocabulary the UI chips use
        out.append({"name": name, "locale": lang, "quality": q,
                    "identifier": ident, "desc": desc})
    return out


def _say_key(name: str, locale: str) -> tuple:
    """Cross-roster identity: AV 'Eddy' + en-US == say
    'Eddy (English (US))' + en_US once the region parenthesis and the
    separator style drop out."""
    root = re.sub(r"\s*\(.*\)\s*$", "", name).strip().lower()
    return (root, locale.replace("_", "-").lower())


def _downloaded_names() -> set:
    """Voice names backed by *.SpeechVoice bundles in the two readable
    install locations. Name = bundle's VoiceName, else bundle basename.
    (Legacy macOS 11-era path; kept because those installs are still
    what older boxes have — modern downloads surface through the AV
    probe's quality/presence rules instead.)"""
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


def _av_rows() -> list:
    """AVFoundation catalog via osascript, or [] when unavailable."""
    if shutil.which("osascript") is None:
        return []
    try:
        p = subprocess.run(["osascript", "-"], input=_AV_PROBE,
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("macOS voice probe failed: %s", e)
        return []
    if p.returncode != 0:
        log.warning("macOS voice probe rc=%d: %s", p.returncode,
                    (p.stderr or "").strip()[:200])
        return []
    return parse_av(p.stdout or "")


def _say_rows() -> list:
    try:
        p = subprocess.run(["say", "-v", "?"], capture_output=True,
                           text=True, timeout=15)
        return parse_voices(p.stdout or "")
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("say voice probe failed: %s", e)
        return []


_cache: dict = {"ts": 0.0, "voices": []}


def list_voices(force: bool = False) -> list:
    """Every voice this Mac has INSTALLED (System Settings' set, not the
    CLI subset), cached. AVFoundation is the catalog; `say -v ?` adds
    anything AV misses and supplies each voice's demo greeting.

    Downloaded flag, from the OS's own facts:
      - quality above Default — the sealed system set ships Default
        voices only; Enhanced/Premium/Personal variants exist solely
        because someone downloaded them;
      - or simply absent from the `say` roster (downloaded neural/Siri
        sets: say speaks them by IDENTIFIER, which is why every row
        carries one);
      - or a legacy *.SpeechVoice bundle on disk (older macOS path).
    Nothing else is claimed: system-shipped rows carry no badge."""
    if not available():
        return []
    now = time.time()
    if not force and now - _cache["ts"] < _CACHE_TTL_S:
        return _cache["voices"]
    av = _av_rows()
    sayv = _say_rows()
    downloaded_bundles = _downloaded_names()
    say_by_key = {}
    for s in sayv:
        say_by_key.setdefault(_say_key(s["name"], s["locale"]), s)
    rows, seen = [], set()
    for a in av:
        key = _say_key(a["name"], a["locale"])
        if (a["identifier"], key) in seen:
            continue
        seen.add((a["identifier"], key))
        s = say_by_key.get(key)
        quality = a["quality"]
        if quality == "standard" and s and s["quality"] != "standard":
            quality = s["quality"]
        downloaded = (quality != "standard") or (s is None) \
            or (a["name"] in downloaded_bundles)
        rows.append({
            "name": a["name"] + ("" if quality == "standard" else
                                 " (%s)" % quality.title()),
            "locale": a["locale"], "quality": quality,
            "sample": (s or {}).get("sample", ""),
            "identifier": a["identifier"], "downloaded": downloaded,
        })
    def _row_key(nm, loc, qual):
        # tier parenthesis is part of the IDENTITY (Ava Enhanced and Ava
        # Premium are two downloads); region parenthesis is not
        root = re.sub(r"\s*\((?!\s*(?:Premium|Enhanced|Personal)).*?\)\s*$",
                      "", nm, flags=re.I).strip().lower()
        return (root, loc.replace("_", "-").lower(), qual)

    for s in sayv:
        # say sees something AV did not: honor the CLI roster too
        if any(_row_key(r["name"], r["locale"], r["quality"])
               == _row_key(s["name"], s["locale"], s["quality"])
               or (r["name"] == s["name"] and
                   _say_key(r["name"], r["locale"])
                   == _say_key(s["name"], s["locale"]))
               for r in rows):
            continue
        rows.append({"name": s["name"], "locale": s["locale"],
                     "quality": s["quality"], "sample": s["sample"],
                     "identifier": s["name"],
                     "downloaded": s["name"] in downloaded_bundles
                     or s["quality"] != "standard"})
    if rows:
        _cache.update(ts=now, voices=rows)
    return rows


def resolve(name: str) -> Optional[dict]:
    """Match a requested voice by IDENTIFIER first (the exact address —
    two system voices share one display name), then by display name.
    A miss refreshes the roster once: the owner may have downloaded the
    voice in System Settings seconds ago, and waiting out a cache TTL to
    accept it would read as a bug."""
    if not name:
        return None
    for fresh in (False, True):
        for v in list_voices(force=fresh):
            if v["identifier"] == name or v["name"] == name:
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
    user-safe reason; input never reaches a shell. Addressing goes through
    the resolved row's IDENTIFIER when it has one — display names collide
    (the system ships two Samanthas), identifiers do not."""
    row = resolve(name)
    if row is None:
        raise RuntimeError("voice '%s' is not installed on this Mac" % name)
    target = row.get("identifier") or row["name"]
    text = (text or "").strip()
    if not text:
        raise RuntimeError("nothing to say")
    if len(text) > MAX_SAY_CHARS:
        text = text[:MAX_SAY_CHARS]     # truncate, don't punish the whole reply
    args = ["say", "-v", target]
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
