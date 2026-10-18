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


# System Settings' downloadable roster: the MobileAsset catalogs the OS
# ships (readable, no root). MacinTalk entries are the classic compact
# voices; the Vocalizer set is the enhanced-quality downloads. What is
# INSTALLED still comes from AV/say only — these two files say what
# Apple offers here, never what this Mac currently holds.
_CAT_PATHS = (
    ("/System/Library/AssetsV2/com_apple_MobileAsset_MacinTalkVoiceAssets/"
     "com_apple_MobileAsset_MacinTalkVoiceAssets.xml", "standard"),
    ("/System/Library/AssetsV2/com_apple_MobileAsset_VoiceServices_"
     "CombinedVocalizerVoices/com_apple_MobileAsset_VoiceServices_"
     "CombinedVocalizerVoices.xml", "enhanced"),
)


def _norm_locale(loc) -> str:
    return str(loc or "").strip().replace("_", "-")


def _root_name(name) -> str:
    """Display identity across rosters: 'Samantha (English (US))' and
    'Samantha' are the same person; 'Ava (Premium)' vs 'Ava (Enhanced)'
    are not — the parenthetical is stripped here but the row's QUALITY
    travels alongside, so tiers stay distinct without the suffix text."""
    return str(name or "").split(" (")[0].strip().lower()


def parse_catalog(doc, quality: str) -> list:
    """One AssetsV2 plist -> [{name, locale, quality}]."""
    out = []
    for e in ((doc or {}).get("Assets") or []):
        if not isinstance(e, dict):
            continue
        name = str(e.get("Name") or "").strip()
        locs = e.get("Languages") or ([e.get("Language")]
                                      if e.get("Language") else [])
        for l in locs:
            if name and l:
                out.append({"name": name, "locale": _norm_locale(l),
                            "quality": quality})
    return out


def _catalog_rows() -> list:
    rows = []
    for path, quality in _CAT_PATHS:
        try:
            with open(path, "rb") as fh:
                rows += parse_catalog(plistlib.load(fh), quality)
        except (OSError, ValueError) as e:
            log.info("voice catalog %s unavailable: %s",
                     path.rsplit("/", 1)[-1], e)
    return rows


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


def _display_name(root_name: str, quality: str, os_name: str) -> str:
    """Plain names stay plain; above-Default rows show their tier. The
    OS sometimes bakes the suffix into the display name already
    ('Zuzana (Premium)' on newer macOS) — never append it twice."""
    if quality == "standard":
        return os_name or root_name.title()
    suffix = "(%s)" % quality.title()
    if suffix.lower() in str(os_name or "").lower():
        return os_name
    return "%s %s" % (os_name or root_name.title(), suffix)


_cache: dict = {"ts": 0.0, "voices": []}


def list_voices(force: bool = False) -> list:
    """The full picture for the tab, cached:
      INSTALLED rows — every voice this Mac actually holds: AVFoundation
      (System Settings' own source; sees downloaded neural/Siri voices
      the CLI roster omits) UNION `say -v ?` (adds anything AV misses
      and supplies each voice's demo greeting). Each carries its OS
      identifier — the exact say -v address.
      DOWNLOADABLE rows — Apple's local MobileAsset catalogs: offered
      here but not on this Mac (installed False; no buttons, the engine
      cannot speak them yet).
    Downloaded badge, from system facts only: quality above Default (the
    sealed system ships Default voices), absence from the CLI roster, or
    a legacy *.SpeechVoice bundle. Shipped rows carry no badge.
    Locale spelling is normalised to BCP-47 everywhere (say uses
    cs_CZ, AV and the catalogs cs-CZ — one language, one group)."""
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
        say_by_key.setdefault((_root_name(s["name"]),
                               _norm_locale(s["locale"]).lower(),
                               s["quality"]), s)
    # standard-quality say rows also answer to the bare (root, locale):
    # AV 'Samantha' == CLI 'Samantha (English (US))'
    say_flat = {}
    for s in sayv:
        say_flat.setdefault((_root_name(s["name"]),
                             _norm_locale(s["locale"]).lower()), s)
    rows, seen = [], set()

    def add(row):
        key = (_root_name(row["name"]), _norm_locale(row["locale"]).lower(),
               row["quality"])
        if key in seen:
            return
        seen.add(key)
        rows.append(row)

    for a in av:
        s = say_by_key.get((_root_name(a["name"]),
                            _norm_locale(a["locale"]).lower(),
                            a["quality"])) \
            or (say_flat.get((_root_name(a["name"]),
                              _norm_locale(a["locale"]).lower()))
                if a["quality"] == "standard" else None)
        quality = a["quality"]
        if quality == "standard" and s and s["quality"] != "standard":
            quality = s["quality"]
        downloaded = (quality != "standard") or (s is None) \
            or (a["name"] in downloaded_bundles)
        add({
            "name": _display_name(_root_name(a["name"]), quality, a["name"]),
            "locale": _norm_locale(a["locale"]), "quality": quality,
            "sample": (s or {}).get("sample", ""),
            "identifier": a["identifier"], "downloaded": downloaded,
            "installed": True,
        })
    for s in sayv:
        add({"name": s["name"], "locale": _norm_locale(s["locale"]),
             "quality": s["quality"], "sample": s["sample"],
             "identifier": s["name"], "installed": True,
             "downloaded": s["name"] in downloaded_bundles
             or s["quality"] != "standard"})
    for c in _catalog_rows():
        if (_root_name(c["name"]), _norm_locale(c["locale"]).lower(),
                c["quality"]) in seen:
            continue
        add({"name": _display_name(_root_name(c["name"]), c["quality"],
                                   c["name"]),
             "locale": _norm_locale(c["locale"]), "quality": c["quality"],
             "sample": "", "identifier": "", "downloaded": False,
             "installed": False})
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
            if v.get("installed") is False:
                continue        # downloadable-but-absent: nothing to speak
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
