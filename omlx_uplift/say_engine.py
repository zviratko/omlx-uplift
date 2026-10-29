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
  `say -v NAME -f FILE -o OUT --data-format=LEI16@24000`, producing a
  plain 24 kHz mono RIFF WAV. argv is a list, the voice name must
  match an installed voice exactly, and the text is capped — no shell,
  no injection surface, no unbounded work;
- formats other than WAV are transcoded with the same optional ffmpeg
  the reference-clip path uses; without ffmpeg the call fails 415 with
  the reason instead of lying about the bytes;
- SAY-2: the engine token 'say' works bare as well as 'say:<voice>'.
  route(name, language, preferred) picks the address: an explicit voice
  (identifier or display name) wins; a bare request routes by language
  through the caller-supplied preferred map (the tab's "mark preferred
  for cs-CZ" favourites), then the owner's per-language System Voice
  from System Settings (SAY-5), then the language's AV default, then
  its best installed voice; with no language at all a mark answering the Mac's
  own language (SAY-2c 'Override macOS default') wins, else the Mac's
  default voice answers (and if even that is unknown, `say` runs
  without -v and picks it itself). Routing lives here; the marks live
  in the voice store.
"""
from __future__ import annotations

import io
import logging
import plistlib
import re
import struct
import shutil
import subprocess
import sys
import tempfile
import wave
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

SAY_PREFIX = "say:"            # voice.model marker for this engine
SAY_ENGINE = "say"             # bare engine token (SAY-2: language routing)
MAX_SAY_CHARS = 200000         # a reply this long is a mistake, not an answer
# A reply past one segment is rendered in pieces and stitched into one file, so
# memory tracks the LONGEST SEGMENT, not the longest answer. That is why the
# ceiling is in MB of audio rather than characters: 24 kHz mono 16-bit is a flat
# 48 KB per second of speech, while characters per second belongs to the VOICE
# (18 chars/s measured for Samantha, 5 chars/s for the novelty voice this Mac
# ships as its English default) - the same text is 3x the bytes on a slow voice.
DEFAULT_CHUNK_CHARS = 1200     # ~1-2 sentences; each extra call costs ~1.1 s
DEFAULT_MAX_AUDIO_MB = 256     # ~90 minutes of speech
MIN_CHUNK_CHARS = 200          # below this the per-call setup dominates
MAX_CHUNK_CHARS = 20000        # `say` reads a file, so argv is not the limit
MIN_MAX_AUDIO_MB = 1
MAX_MAX_AUDIO_MB = 4096

_MIN_DETECT_CHARS = 3          # below this there is nothing to recognise
_NL_CONFIDENT = 50             # percent; 'ok' scores pl@29 — garbage stops here
_DETECT_CHARS = 1000           # a reply's first lines decide the language
_TIMEOUT_S = 180
# 24 kHz, not 22.05: libsndfile encodes Opus only at 8/12/16/24/48 kHz, so a
# 22.05 kHz render breaks response_format=opus for this engine alone.
_SAMPLE_RATE = 24000
BYTES_PER_AUDIO_SECOND = _SAMPLE_RATE * 2   # mono 16-bit: 48 KB per second
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
\tset dfl to ((v's isDefault()) as integer)
set out to out & nm & "\t" & lg & "\t" & idr & "\t" & dsc & "\t" & dfl & "
"
end repeat
return out
'''

_QUALITY_RE = re.compile(r"Quality:\s*([A-Za-z-]+)")

# SAY-2 auto-detection: Apple's OWN text-language identifier (the
# NaturalLanguage framework Spotlight and TextEdit use) — offline, no
# model download, and proven on this box: Czech scores cs@99 with AND
# without diacritics, Slovak stays sk (never mistaken for cs), and
# garbage like 'ok' only reaches pl@29, under the confidence gate.
# Same AppleScriptObjC lane as the voice probe; the candidate rides in
# argv (no shell), the script arrives on stdin. Output: 'cs\t99'.
_NL_PROBE = '''use framework "NaturalLanguage"
use scripting additions
on run argv
\tset rec to current application's NLLanguageRecognizer's alloc()'s init()
\t(rec's processString:(item 1 of argv))
\tset d to rec's languageHypothesesWithMaximum:1
\tset ks to d's allKeys()
\tif (count of ks) is 0 then return ""
\tset k to item 1 of ks
\tset conf to ((d's objectForKey:k)'s doubleValue()) as real
\treturn (k as text) & "\\t" & ((conf * 100) div 1 as text)
end run
'''


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
    """AV probe output -> rows {name, locale, quality, identifier, desc,
    default}. Locale keeps AV's BCP-47 spelling (en-US); the UI
    normalises. The 5th column (isDefault, SAY-2) is optional — older
    probe output without it parses as non-default, never as junk."""
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
        default = len(parts) > 4 and parts[4].strip() == "1"
        out.append({"name": name, "locale": lang, "quality": q,
                    "identifier": ident, "desc": desc, "default": default})
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
# ships (readable, no root). Three generations live side by side:
#   MacinTalk        — the classic compact voices (all standard quality)
#   CombinedVocalizer — the legacy enhanced-quality downloads
#   TTSAXResourceModel — the modern 'Maui' neural set; ONE file carries
#       every tier per voice (Footprint: compact/enhanced/premium/
#       personal), and System Settings' picker is built from it. Missing
#       it hid the plain 'Iveta' and the 'Zuzana (Premium)' offer (user
#       report: 'there is an Iveta without (Enhanced) not shown at all').
# What is INSTALLED still comes from AV/say only — these files say what
# Apple offers here, never what this Mac currently holds.
_CAT_PATHS = (
    ("/System/Library/AssetsV2/com_apple_MobileAsset_MacinTalkVoiceAssets/"
     "com_apple_MobileAsset_MacinTalkVoiceAssets.xml", "standard"),
    ("/System/Library/AssetsV2/com_apple_MobileAsset_VoiceServices_"
     "CombinedVocalizerVoices/com_apple_MobileAsset_VoiceServices_"
     "CombinedVocalizerVoices.xml", "enhanced"),
    ("/System/Library/AssetsV2/com_apple_MobileAsset_TTSAXResourceModelAssets/"
     "com_apple_MobileAsset_TTSAXResourceModelAssets.xml", "footprint"),
)

_TIER_BY_FOOTPRINT = {"premium": "premium", "enhanced": "enhanced",
                      "personal": "personal", "compact": "standard",
                      "default": "standard"}


def _norm_locale(loc) -> str:
    return str(loc or "").strip().replace("_", "-")


def _root_name(name) -> str:
    """Display identity across rosters: 'Samantha (English (US))' and
    'Samantha' are the same person; 'Ava (Premium)' vs 'Ava (Enhanced)'
    are not — the parenthetical is stripped here but the row's QUALITY
    travels alongside, so tiers stay distinct without the suffix text."""
    return str(name or "").split(" (")[0].strip().lower()


def parse_catalog(doc, quality: str) -> list:
    """One AssetsV2 plist -> [{name, locale, quality}]. quality is a
    fixed tier word, or 'footprint' to read each entry's own Footprint
    field (the modern TTSAX catalog holds several tiers per voice)."""
    out = []
    for e in ((doc or {}).get("Assets") or []):
        if not isinstance(e, dict):
            continue
        name = str(e.get("Name") or "").strip()
        q = quality
        if quality == "footprint":
            q = _TIER_BY_FOOTPRINT.get(
                str(e.get("Footprint") or "").strip().lower(), "standard")
        locs = e.get("Languages") or ([e.get("Language")]
                                      if e.get("Language") else [])
        for l in locs:
            if name and l:
                out.append({"name": name, "locale": _norm_locale(l),
                            "quality": q})
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
            "installed": True, "default": bool(a.get("default")),
        })
    for s in sayv:
        add({"name": s["name"], "locale": _norm_locale(s["locale"]),
             "quality": s["quality"], "sample": s["sample"],
             "identifier": s["name"], "installed": True, "default": False,
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
             "installed": False, "default": False})
    if rows:
        _cache.update(ts=now, voices=rows)
    return rows


def parse_voice_language(token) -> tuple:
    """Split a voice address into (name, language), either order.

    Display names are NOT unique on macOS: eight of them (the Eloquence
    family - Shelley, Eddy, Sandy, Grandma, Grandpa, Reed, Rocko, Sinji)
    exist once per language, fourteen languages each, so 'say:Shelley'
    cannot say which Shelley is meant. Writing the language beside the name
    does: 'Shelley:pt-BR' and 'pt-BR:Shelley' both address one row.
    Identifiers carry dots, not colons, and come back untouched."""
    raw = str(token or "").strip()
    if ":" not in raw:
        return raw, ""
    head, _, tail = raw.partition(":")
    head, tail = head.strip(), tail.strip()
    if not head or not tail:
        return raw, ""
    if _LOCALEISH_RE.match(tail) and not _LOCALEISH_RE.match(head):
        return head, tail
    if _LOCALEISH_RE.match(head) and not _LOCALEISH_RE.match(tail):
        return tail, head
    return raw, ""


def name_languages(name: str) -> list:
    """Every language this Mac carries a display name in, for honest errors."""
    return sorted({_norm_locale(v.get("locale")) for v in list_voices()
                   if v.get("installed") is not False and v["name"] == name
                   and v.get("locale")}, key=str.lower)


def resolve(name: str, language=None) -> Optional[dict]:
    """Match a requested voice by IDENTIFIER first (the exact address —
    two system voices share one display name), then by display name.
    `language` picks between the rows that share a name, so a caller who
    named Shelley AND pt-BR gets the Brazilian one, and one who asked for
    a language that name does not cover gets None rather than a surprise.
    Without a language the first roster row answers, as before.
    A miss refreshes the roster once: the owner may have downloaded the
    voice in System Settings seconds ago, and waiting out a cache TTL to
    accept it would read as a bug."""
    if not name:
        return None
    want, named = parse_voice_language(name)
    language = language or named
    for fresh in (False, True):
        rows = [v for v in list_voices(force=fresh)
                if v.get("installed") is not False]   # absent: nothing to speak
        for v in rows:
            # A voice only `say -v ?` knows has its DISPLAY NAME as its
            # identifier, which is exactly the string that is not unique. When
            # the caller pinned a language, such a row only answers if it
            # actually speaks that language; a real identifier (dotted, with
            # the locale inside) passes the same test honestly.
            if v["identifier"] == want and (
                    not language or _locale_score(language, v.get("locale")) > 0):
                return v
        shares = [v for v in rows if v["name"] == want]
        if not shares:
            continue
        if not language:
            return shares[0]
        ranked = sorted(shares, key=lambda v: (
            -_locale_score(language, v.get("locale")),
            _quality_rank(v.get("quality")),
        ))
        if _locale_score(language, ranked[0].get("locale")) > 0:
            return ranked[0]
        return None
    return None


def say_name_of(model: str) -> str:
    """'say:Zuzana' -> 'Zuzana' (the model marker stores the raw name)."""
    return str(model or "")[len(SAY_PREFIX):] if str(model or "").startswith(
        SAY_PREFIX) else ""


# A tail like 'cs-CZ' / 'zh-Hans' / 'pt' is a language, not a voice name.
# Voice names with spaces or dots (identifiers) never match; a genuine
# three-letter voice name still wins, because resolve() runs first.
_LOCALEISH_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def say_split(model) -> tuple:
    """(is_say, voice_or_empty) for every spelling of the engine token:
    'say' (bare — SAY-2 language routing), 'say:' and 'say:<tail>' —
    where the tail is an explicit voice (identifier or display name)
    or, SAY-2, a locale ('say:cs-CZ' routes exactly like a bare say
    request carrying language cs-CZ). The token is matched
    case-insensitively; the tail keeps its exact spelling because that
    is what `resolve` must match."""
    s = str(model or "").strip()
    low = s.lower()
    if low == SAY_ENGINE:
        return True, ""
    if low.startswith(SAY_PREFIX):
        return True, s[len(SAY_PREFIX):].strip()
    return False, ""


def _locale_score(req, have) -> int:
    """How well a requested language answers a marked/spoken locale:
    2 = same full locale, 1 = same primary language when ONE side names
    no region (request 'cs' satisfies mark 'cs-CZ' and vice versa),
    0 = different — 'cs-CZ' never answers 'cs-SK'."""
    r = _norm_locale(req).lower()
    k = _norm_locale(have).lower()
    if not r or not k:
        return 0
    if r == k:
        return 2
    rp, _, rs = r.partition("-")
    kp, _, ks = k.partition("-")
    if rp == kp and not (rs and ks):
        return 1
    return 0


_QUALITY_ORDER = {"premium": 0, "enhanced": 1, "personal": 2}


def _quality_rank(quality) -> int:
    return _QUALITY_ORDER.get(str(quality or ""), 3)


def _installed_rows() -> list:
    return [v for v in list_voices() if v.get("installed") is not False]


def _marked_voice(lang, preferred=None) -> Optional[dict]:
    """SAY-2c (shared with language_voice): the installed row a preferred
    mark points at for this language — exact locale beats primary-language
    match; a mark pointing at a voice this Mac no longer holds is skipped.
    None when no mark answers the language."""
    by_addr = {}
    for v in _installed_rows():
        by_addr[v.get("identifier") or v["name"]] = v
    best, best_score = None, 0
    for loc, addr in (preferred or {}).items():
        v = by_addr.get(str(addr or ""))
        if v is None:
            continue            # stale mark (voice deleted/downloaded away)
        score = _locale_score(lang, loc)
        if score > best_score:
            best, best_score = v, score
    return best


def language_voice(lang, preferred=None) -> Optional[dict]:
    """SAY-2: the row that answers a language-carrying `say` request.
    Chain (TTS-4b + SAY-5, System Settings as truth):
      1. the voice marked preferred for that language (exact locale beats
         primary-language match; a mark pointing at a voice this Mac no
         longer holds is skipped);
      2. the voice the owner picked for that language in System Settings
         ▸ Spoken Content ▸ Voices (SAY-5: a real per-language user
         selection, read from the accessibility domain — it outranks a
         global pick that belongs to a different language);
      3. the Mac's SELECTED system voice (System Settings ▸ Read & Speak)
         when its own language answers this request — that is what `say`
         and macOS itself speak with;
      4. the language's AVFoundation-flagged default row (the factory
         default for languages the selection does not cover);
      5. the best installed tier (Premium > Enhanced > Personal >
         standard) when the language has no flagged row;
      6. None when the language has nothing installed — the caller fails
         honestly instead of speaking the text in a random language."""
    if not lang:
        return None
    best = _marked_voice(lang, preferred)
    if best is not None:
        return best
    rows = _installed_rows()
    in_lang = [v for v in rows if _locale_score(lang, v.get("locale"))]
    if not in_lang:
        return None
    picked = system_selected_voice(lang)
    if picked is not None:
        return picked
    sel = selected_row()
    if sel is not None and _locale_score(lang, sel.get("locale")):
        return sel
    in_lang.sort(key=lambda v: (not v.get("default"),
                                _quality_rank(v.get("quality")),
                                str(v.get("name") or "")))
    return in_lang[0]


_SEL_TTL_S = 300
_sel_cache: dict = {"ts": 0.0, "id": None}

# NSSpeechSynthesizer's class method answers with the identifier of the
# voice System Settings ▸ Accessibility ▸ Read & Speak has selected — the
# same one bare `say` speaks with (byte-proven against `say -o` output on
# a default box). AVFoundation's per-voice isDefault is NOT that: it marks
# the factory default-QUALITY row of every language (a Mac with a
# downloaded 'Zuzana (Premium)' selected still flags compact Zuzana).
_DV_PROBE = '''use framework "AppKit"
use scripting additions
set dv to current application's NSSpeechSynthesizer's defaultVoice()
return dv as text
'''


def selected_voice_identifier(force: bool = False) -> str:
    """Identifier of the user's selected system voice ('' when unknown:
    non-Mac, probe failure, or a name the responder cannot print).
    Cached like system_language — the setting rarely changes."""
    if not available():
        return ""
    now = time.time()
    if not force and _sel_cache["id"] is not None \
            and now - _sel_cache["ts"] < _SEL_TTL_S:
        return _sel_cache["id"]
    ident = ""
    if shutil.which("osascript") is not None:
        try:
            p = subprocess.run(["osascript", "-e", _DV_PROBE],
                               capture_output=True, text=True, timeout=15)
            if p.returncode == 0:
                ident = p.stdout.strip()
        except (OSError, subprocess.SubprocessError) as e:
            log.info("say selected-voice probe failed: %s", e)
    _sel_cache.update(ts=now, id=ident)
    return ident


def selected_row() -> Optional[dict]:
    """The installed catalog row behind the selected system voice.
    Identifier first (AV rows carry the exact handle); legacy CLI rows
    address themselves by name, so fall back to the identifier's last
    segment matched case-insensitively against row names. None when the
    selection names a voice this Mac no longer holds or the probe failed
    — every caller then keeps the pre-TTS-4 behaviour."""
    sel = selected_voice_identifier()
    if not sel:
        return None
    rows = _installed_rows()
    for v in rows:
        if (v.get("identifier") or v["name"]) == sel:
            return v
    tail = sel.rsplit(".", 1)[-1].lower()
    for v in rows:
        if _root_name(v["name"]) == tail:
            return v
    return None


# SAY-5 (user 2026-10-19): System Settings ▸ Accessibility ▸ Spoken
# Content ▸ Voices lets the owner pick a System Voice PER LANGUAGE (the
# list groups them by primary language — 'English' covers every en-*
# variant, exactly what macOS itself answers with). macOS 26+ stores
# those picks in the com.apple.Accessibility domain as an alternating
# array of language key + record dict; older macOS has no such key and
# an untouched Spoken Content never writes one. Absence is honest
# silence: {} leaves every language on the pre-SAY-5 chain.
_OS_SEL_DOMAIN = "com.apple.Accessibility"
_OS_SEL_KEY = "SpokenContentDefaultVoiceSelectionsByLanguage"
_OS_SEL_TTL_S = 300
_os_sel_cache: dict = {"ts": 0.0, "map": None}


def _parse_spoken_selections(text) -> dict:
    """`defaults read` output for the selection array -> {language:
    voiceId}. Each record is a flat {...} block carrying boundLanguage
    and voiceId; keys arrive in whatever order the OS wrote them, so
    both are read per block. A record without boundLanguage pairs with
    the scalar that precedes its block (the array's alternating
    spelling). Junk blocks are skipped, never fatal."""
    out = {}
    frags = re.split(r"\{", text or "")
    for i, block in enumerate(frags[1:], 1):
        block = block.split("}", 1)[0]
        m_vid = re.search(r'voiceId\s*=\s*"([^"]+)"', block)
        if not m_vid:
            continue
        addr = m_vid.group(1)
        m_lang = re.search(r'boundLanguage\s*=\s*"?([^";]+?)"?\s*;', block)
        lang = ""
        if m_lang:
            lang = m_lang.group(1)
        else:
            m_prev = re.search(r'"?([A-Za-z][A-Za-z0-9-]*)"?\s*,\s*$',
                               frags[i - 1].rstrip()[-200:])
            if m_prev:
                lang = m_prev.group(1)
        lang = _norm_locale(lang).lower()
        if lang and addr:
            out[lang] = addr
    return out


def spoken_selections(force: bool = False) -> dict:
    """{primary language: voiceId} as set in System Settings — user
    picks only, never a factory default claim. Cached like the other
    probes; {} on non-Mac, older macOS, or probe failure."""
    if not available():
        return {}
    now = time.time()
    if not force and _os_sel_cache["map"] is not None \
            and now - _os_sel_cache["ts"] < _OS_SEL_TTL_S:
        return _os_sel_cache["map"]
    mapping: dict = {}
    if shutil.which("defaults") is not None:
        try:
            p = subprocess.run(
                ["defaults", "read", _OS_SEL_DOMAIN, _OS_SEL_KEY],
                capture_output=True, text=True, timeout=5)
            if p.returncode == 0:
                mapping = _parse_spoken_selections(p.stdout)
        except (OSError, subprocess.SubprocessError) as e:
            log.info("say spoken-selection probe failed: %s", e)
    _os_sel_cache.update(ts=now, map=mapping)
    return mapping


def system_selected_voice(lang) -> Optional[dict]:
    """The installed row the owner's per-language System Voice points
    at: 'cs-CZ' answers the 'cs' selection because that is how Spoken
    Content groups them. None when no selection answers the language
    or the chosen voice is not on this Mac anymore — macOS falls back
    to its own default there and so do we; a voice that cannot speak
    is never addressed."""
    if not lang:
        return None
    sel = spoken_selections()
    if not sel:
        return None
    by_addr = {}
    for v in _installed_rows():
        by_addr[v.get("identifier") or v["name"]] = v
    # most specific answering key first: an 'en-US' selection beats an
    # 'en' one when both exist (macOS writes primaries today; forward
    # compatible and deterministic either way)
    order = sorted(sel.items(),
                   key=lambda kv: -_locale_score(lang, str(kv[0] or "")))
    for key, addr in order:
        k = str(key or "").lower()
        # a region-less key answers every variant of that language
        # (Spoken Content groups them that way); a key WITH a region
        # answers only its exact locale — 'en-US' never claims en-GB
        if not k or _locale_score(lang, k) <= 0:
            continue
        if "-" in k and k != _norm_locale(lang).lower():
            continue
        v = by_addr.get(str(addr or ""))
        if v is not None:
            return v
    return None


def effective_default_addrs() -> set:
    """TTS-4: addresses (identifier, else name) of the rows that answer
    their OWN language with no preferred mark involved — what the tabs
    badge 'macOS DEFAULT'. Computed per language through the SAME chain
    the router uses (selection beats flag), so the badge and the voice
    that actually speaks can never disagree."""
    langs = {v.get("locale") for v in _installed_rows() if v.get("locale")}
    addrs = set()
    for loc in langs:
        d = language_voice(loc)
        if d:
            addrs.add(d.get("identifier") or d["name"])
    return addrs


_SYS_LANG_TTL_S = 300              # the language rarely changes; but it can
_sys_lang_cache: dict = {"ts": 0.0, "lang": None}
_TAGGED_RE = re.compile(r'"([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)"')


def _read_global_default(key: str) -> str:
    """One NSGlobalDomain value via the `defaults` CLI ('' on any
    failure). The global domain is user-readable without elevation;
    the binary is guarded on PATH like every other optional probe."""
    if shutil.which("defaults") is None:
        return ""
    try:
        p = subprocess.run(["defaults", "read", "-g", key],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as e:
        log.info("say system language probe failed (%s): %s", key, e)
        return ""
    return p.stdout if p.returncode == 0 else ""


def system_language(force: bool = False) -> str:
    """SAY-2c: the Mac's own LANGUAGE default as a BCP-47 tag ('en-US').
    The first AppleLanguages entry is the system language the Spoken
    Content default voice follows; AppleLocale ('en_US@rg=czzzzz') is
    the fallback spelling. '' when unknown (non-Mac, probe failure) —
    every caller then keeps the pre-SAY-2c behaviour. Cached; a wrong
    answer only changes which rows the tab labels 'macOS default'."""
    now = time.time()
    if not force and _sys_lang_cache["lang"] is not None \
            and now - _sys_lang_cache["ts"] < _SYS_LANG_TTL_S:
        return _sys_lang_cache["lang"]
    lang = ""
    m = _TAGGED_RE.search(_read_global_default("AppleLanguages"))
    if m:
        lang = m.group(1)
    else:
        loc = _read_global_default("AppleLocale").split("@")[0]
        lang = loc.strip().strip('"')
    lang = _norm_locale(lang)
    _sys_lang_cache.update(ts=now, lang=lang)
    return lang


def default_answered(locale) -> bool:
    """True when a preferred mark for this row's language also answers
    language-less requests — i.e. what the tab labels 'override the
    macOS default'. Same matching the router and route() use."""
    sysl = system_language()
    return bool(sysl) and _locale_score(sysl, locale) > 0


def default_voice() -> Optional[dict]:
    """The Mac's own system default voice — what bare `say` (no -v)
    speaks with. TTS-4b: the System Settings selection IS that voice and
    leads; when the probe cannot see it (non-Mac, failure, deleted
    voice) fall back to the system language's chain row, then to any
    factory-flagged row. None when nothing can be named — the caller
    then addresses `say` with no voice and lets the system choose."""
    sel = selected_row()
    if sel is not None:
        return sel
    sysl = system_language()
    if sysl:
        v = language_voice(sysl)
        if v is not None:
            return v
    rows = _installed_rows()
    for v in rows:
        if v.get("default"):
            return v
    return None


def detect_language(text) -> str:
    """SAY-2 auto-detection: dominant written language of one utterance,
    normalised to what the voice chain understands. '' — meaning "do not
    route, keep the old system-default behaviour" — for too little text,
    a missing osascript, any probe failure, 'und', or a top hypothesis
    under the confidence gate. Script-only subtags fold to the primary
    language ('zh-Hans' -> 'zh') because voice locales carry a REGION
    ('zh-CN') and the locale chain answers a region-less request by
    primary language."""
    t = " ".join(str(text or "").split())
    if len(t) < _MIN_DETECT_CHARS or shutil.which("osascript") is None:
        return ""
    try:
        p = subprocess.run(["osascript", "-", t[:_DETECT_CHARS]],
                           input=_NL_PROBE, capture_output=True,
                           text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as e:
        log.info("say language detect failed to run: %s", e)
        return ""
    if p.returncode != 0:
        log.info("say language detect rc=%d: %s", p.returncode,
                 (p.stderr or "").strip()[:160])
        return ""
    lang, _, conf = (p.stdout or "").strip().partition("\t")
    try:
        score = int(conf)
    except ValueError:
        return ""
    lang = lang.strip()
    if not lang or lang.lower() == "und" or score < _NL_CONFIDENT:
        return ""
    parts = [x for x in lang.split("-") if not (len(x) == 4 and x.isalpha())]
    return "-".join(parts)


def route(name: str, language=None, preferred=None, text=None) -> str:
    """The address to speak with. An explicit name wins when it resolves
    to an installed voice (identifier or display name). SAY-2 adds the
    language-carrying alias: when the tail is NOT a voice but looks like
    a locale ('say:cs-CZ', 'say:cs'), it routes exactly like a bare
    request carrying that language — preferred mark, language default,
    best installed voice. The tail may also name both at once
    ('say:Zuzana:cs-CZ', 'say:cs-CZ:Zuzana'), which is how a voice whose
    display name serves fourteen languages is addressed for one of them.
    A bare request with NO language is answered from the TEXT: Apple's own
    from the TEXT: Apple's own identifier guesses the language —
    confidence-gated, and any shaky or unanswerable guess degrades to
    '' leaving the Mac's system default in place. '' means 'no -v flag
    — `say` picks its own default'. Raises LookupError with a user-safe
    reason when an EXPLICIT language has nothing installed."""
    name = (name or "").strip()
    if name:
        # A voice the caller NAMED wins over a language field beside it: they
        # asked for that voice, and a Slovak voice reading Czech text is what
        # `say -v` has always done. A language written INTO the address
        # ('say:Laura:sk-SK') is a different promise - both halves were meant,
        # so a half this Mac does not carry is refused, not dropped.
        bare, pinned = parse_voice_language(name)
        v = resolve(name, pinned)
        if v is not None:
            return v.get("identifier") or v["name"]
        if _LOCALEISH_RE.match(name):
            return _by_language(name, preferred)
        if pinned and bare and not _LOCALEISH_RE.match(bare):
            langs = name_languages(bare)
            if langs:
                shown = ", ".join(langs[:6]) + (", ..." if len(langs) > 6 else "")
                raise LookupError(
                    "voice '%s' is installed for %s, not for %s. Pick one of "
                    "those languages, or address the voice by the identifier "
                    "the macOS voices tab shows" % (bare[:40], shown, str(pinned)[:16]))
        raise LookupError(
            "voice '%s' is not installed on this Mac" % name[:64])
    if language:
        return _by_language(language, preferred)
    det = detect_language(text)
    if det:
        v = language_voice(det, preferred)
        if v is not None:
            # a shaky guess must never be WORSE than no guess: with
            # nothing installed for the detected language we fall
            # through to the system default below
            return v.get("identifier") or v["name"]
    # SAY-2c: a preferred mark answering the Mac's OWN language overrides
    # the system default voice even for language-less requests — that is
    # what the tab's 'Override macOS default' button promises. Without
    # such a mark (or without knowing the system language) the untouched
    # system default answers, exactly as before.
    sysl = system_language()
    v = (_marked_voice(sysl, preferred) if sysl else None) or default_voice()
    return (v.get("identifier") or v["name"]) if v else ""


def _by_language(lang, preferred) -> str:
    v = language_voice(lang, preferred)
    if v is None:
        raise LookupError(
            "no installed macOS voice for language '%s' — mark one "
            "preferred in the macOS voices tab or download a voice in "
            "System Settings" % str(lang)[:32])
    return v.get("identifier") or v["name"]


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


def clean_chunk_chars(raw) -> int:
    """Characters per `say` call. 0 means 'never split, one call whatever the
    length'; junk means the default, because a store with null in it is not a
    request to stop speaking."""
    if raw is None:
        return DEFAULT_CHUNK_CHARS
    try:
        value = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return DEFAULT_CHUNK_CHARS
    if value <= 0:
        return 0
    return max(MIN_CHUNK_CHARS, min(MAX_CHUNK_CHARS, value))


def clean_max_audio_mb(raw) -> int:
    """Ceiling for one reply in MB of AUDIO, the unit that means the same on
    every Mac. 0 or junk means the default; it can never be switched off,
    because an unbounded render is what this limit exists to prevent."""
    if raw is None:
        return DEFAULT_MAX_AUDIO_MB
    try:
        value = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return DEFAULT_MAX_AUDIO_MB
    if value <= 0:
        return DEFAULT_MAX_AUDIO_MB
    return max(MIN_MAX_AUDIO_MB, min(MAX_MAX_AUDIO_MB, value))


def long_input_error(text_len: int, max_audio_mb: int = DEFAULT_MAX_AUDIO_MB) -> str:
    """Why this utterance must not be rendered at all, or '' to render it.

    One limit only, and it is a sanity gate rather than a policy: the byte
    ceiling does the real work while the reply is stitched, so nothing here
    has to guess how big a given voice will make a given text."""
    if text_len > MAX_SAY_CHARS:
        return ("this reply is %d characters, over the %d character limit of "
                "one spoken answer - shorten it or read it in parts"
                % (text_len, MAX_SAY_CHARS))
    return ""


_SENT_SPLIT = re.compile(r"(?<=[.!?。！？])\s+|\n+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,;:，；：])\s*")


def split_text(text: str, max_chars: int) -> list:
    """Sentence-sized pieces of one utterance, none longer than `max_chars`;
    `max_chars` 0 or one short sentence returns the text whole.

    Deliberately its own splitter rather than an import of vanilla's private
    `_split_tts_text`: uplift ships as an add-on and a rename upstream must
    never be able to break speech here. The rules are the useful ones -
    sentence ends first, clause ends when a single sentence overshoots, and a
    wordless monster is cut on the length so nothing is ever dropped."""
    text = (text or "").strip()
    if not text:
        return []
    if max_chars <= 0 or len(text) <= max_chars:
        return [text]

    def pack(parts, buffer, out):
        for part in parts:
            part = part.strip()
            if not part:
                continue
            while len(part) > max_chars:            # nothing survives oversized
                if buffer:
                    out.append(buffer)
                    buffer = ""
                out.append(part[:max_chars].strip())
                part = part[max_chars:].strip()
            if not part:
                continue
            candidate = (buffer + " " + part).strip() if buffer else part
            if len(candidate) <= max_chars:
                buffer = candidate
            else:
                if buffer:
                    out.append(buffer)
                buffer = part
        return buffer

    chunks = []
    held = ""
    for sentence in _SENT_SPLIT.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > max_chars:
            held = pack(_CLAUSE_SPLIT.split(sentence), held, chunks)
            continue
        candidate = (held + " " + sentence).strip() if held else sentence
        if held and len(candidate) > max_chars:
            chunks.append(held)
            held = sentence
        else:
            held = candidate
    if held:
        chunks.append(held)
    return chunks or [text]


def wav_header(sample_rate: int, channels: int = 1, sample_width: int = 2,
               data_bytes: int = 0) -> bytes:
    """A canonical 44-byte PCM WAV header with the SIZES FILLED IN.

    Offsets 4 (RIFF chunk) and 40 (data chunk) are where the format says they
    are, which is what a stitched file must carry: a streamed reply cannot
    promise a length it does not know yet, but a finished one has no excuse
    for lying about it - players, `wave` and anything that shows a duration
    read these two numbers."""
    block = channels * sample_width
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", min(36 + data_bytes, 0x7FFFFFF0), b"WAVE", b"fmt ", 16,
        1, channels, sample_rate, sample_rate * block, block, sample_width * 8,
        b"data", data_bytes)


def synth_wav(text: str, target: str = "", speed=None) -> bytes:
    """Render one string with an ALREADY resolved voice address. No routing,
    no limits: the segmentation path resolves the voice once for the whole
    reply and calls this per piece, because re-detecting the language
    sentence by sentence would hand one Czech answer three different voices.
    `target` empty drops -v and lets `say` use the system voice."""
    text = (text or "").strip()
    if not text:
        raise RuntimeError("nothing to say")
    args = ["say"] + (["-v", str(target)] if target else [])
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


def pcm_of(wav: bytes) -> tuple:
    """(rate, channels, sample_width, payload) of a WAV that `say` produced.
    Read with `wave`, which walks the real chunks instead of trusting a fixed
    offset - some macOS releases slip LIST/fact chunks between fmt and data."""
    with wave.open(io.BytesIO(wav), "rb") as wf:
        return (wf.getframerate(), wf.getnchannels(), wf.getsampwidth(),
                wf.readframes(wf.getnframes()))


def spool_wav(segments, target: str, speed, ceiling_bytes: int,
              out_path: str) -> tuple:
    """Render every piece into ONE WAV file, header written last.

    Only one segment is ever held: the reply accumulates on disk, which is the
    whole reason a long answer costs the server about nothing. Raises
    RuntimeError past `ceiling_bytes` (a refusal, never a truncated file) and
    when the voice changes format mid-reply. Returns (rate, channels, width,
    payload_bytes)."""
    fmt = None
    total = 0
    with open(out_path, "wb") as out:
        out.write(b"\x00" * 44)          # real header lands when sizes are known
        for segment in segments:
            rate, channels, width, pcm = pcm_of(synth_wav(segment, target, speed))
            if fmt is None:
                fmt = (rate, channels, width)
            elif (rate, channels, width) != fmt:
                raise RuntimeError("macOS say changed format between segments: "
                                   "%s then %s" % (fmt, (rate, channels, width)))
            total += len(pcm)
            if total > ceiling_bytes:
                raise RuntimeError(
                    "this reply passed the %d MB audio ceiling set under "
                    "Settings > Audio > macOS voices before it finished "
                    "speaking. Raise the ceiling, lower the segment size, or "
                    "ask for a shorter answer" % (ceiling_bytes // 1000000))
            if pcm:
                out.write(pcm)
    if fmt is None:
        raise RuntimeError("nothing to say")
    with open(out_path, "r+b") as fh:
        fh.seek(0)
        fh.write(wav_header(fmt[0], fmt[1], fmt[2], total))
    return fmt + (total,)


def synth_bytes(name: str, text: str, speed=None,
                language=None, preferred=None) -> bytes:
    """Render one utterance to plain WAV bytes. Raises RuntimeError with a
    user-safe reason; input never reaches a shell. Addressing goes through
    the resolved row's IDENTIFIER when it has one - display names collide
    (the system ships two Samanthas), identifiers do not.
    SAY-2: an empty `name` routes - the preferred mark for `language`,
    the language's own default, the best installed voice for the
    detected language of TEXT, or the Mac-wide default voice; when even
    that is unknown the -v flag is dropped and `say` answers in the
    system voice (never a silent failure)."""
    text = (text or "").strip()
    if not text:
        raise RuntimeError("nothing to say")
    refused = long_input_error(len(text))
    if refused:
        raise RuntimeError(refused)
    try:
        target = route(name, language, preferred, text)
    except LookupError as e:
        raise RuntimeError(str(e))
    return synth_wav(text, target, speed)


def convert_wav(wav: bytes, fmt: str) -> bytes:
    """WAV -> fmt with the repo's optional-ffmpeg pattern. fmt 'wav' is a
    no-op; unknown formats raise ValueError, missing ffmpeg raises
    RuntimeError (callers map both to 4xx/5xx honestly)."""
    fmt = (fmt or "wav").lower().strip()
    if fmt in ("wav", ""):
        return wav
    if fmt not in _MEDIA:
        raise ValueError("unsupported format '%s'" % fmt)
    with tempfile.TemporaryDirectory(prefix="uplift-say-") as td:
        src = Path(td) / "in.wav"
        dst = Path(td) / ("out." + _EXT_SUFFIX.get(fmt, fmt))
        src.write_bytes(wav)
        convert_file(str(src), str(dst), fmt)
        return dst.read_bytes()


# ffmpeg names a few formats differently than the API does
_EXT_SUFFIX = {"opus": "ogg"}


def convert_file(src: str, dst: str, fmt: str) -> None:
    """Transcode a WAV FILE to dst, in a child process: neither the input nor
    the output is ever held here, which is what keeps a long reply cheap. The
    extension of dst is the caller's business, so that ffmpeg's own name for
    the format stays one lookup away from the API's."""
    if Path(dst).suffix.lstrip(".").lower() not in (fmt, _EXT_SUFFIX.get(fmt)):
        # Checked before the binary is even looked for: ffmpeg picks its target
        # format from the extension, so a '.wav' destination asked to be 'mp3'
        # would come back as WAV wearing an mp3 content-type.
        raise ValueError("convert_file wants a .%s destination, got '%s'"
                         % (fmt, Path(dst).name[-16:]))
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError("this server has no ffmpeg: macOS say answers WAV "
                           "only (response_format='%s' cannot be honoured)"
                           % (fmt or "wav"))
    p = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(src),
                        str(dst)], capture_output=True, text=True,
                       timeout=_TIMEOUT_S)
    if p.returncode != 0 or not Path(dst).is_file() or Path(dst).stat().st_size < 1:
        raise RuntimeError("ffmpeg conversion to %s failed" % fmt)


def media_type(fmt: str) -> str:
    return _MEDIA.get((fmt or "wav").lower().strip(), "audio/wav")
