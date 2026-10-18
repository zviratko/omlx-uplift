"""TTS-1 locale self-pin: the TEXT TO SPEECH tab and the shared-editor
voice-defaults block assemble labels through tf(key, EN fallback) —
invisible to the C.t literal gate, so they self-pin here
(uplift-static-ui-gate doctrine; owner file for the tts_* family).
Pins: every new key exists non-empty in all 10 locales, placeholder
multisets equal EN, values are translated (not EN-identical), the tf()
fallback literals in the statics match en.json byte-for-byte (a drifted
literal flickers the other wording pre-catalog; ternary key sites pair
branch-by-branch), and index.html carries the renamed menu fallback.
"""
import json
import re
from pathlib import Path

import pytest

LOCALES = ["en", "cs", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh", "zh-TW"]
TTS1_KEYS = (
    "uplift.voices.tab_tts", "uplift.voices.tts_title",
    "uplift.voices.tts_hint", "uplift.voices.tts_none",
    "uplift.voices.tts_settings", "uplift.voices.tts_default",
    "uplift.voices.tts_set_default", "uplift.voices.tts_clear_default",
    "uplift.voices.tts_no_default", "uplift.voices.tts_section",
    "uplift.voices.tts_section_note", "uplift.voices.tts_badge_title",
    # TTS-2: the macOS group header (voices page) + the editor's custom-
    # voices block
    "uplift.voices.tts_mac_title", "uplift.voices.editor_title",
    "uplift.voices.editor_hint",
)
RENAMED = ("uplift.tab.voices", "uplift.page.voices_full")
_PH_RE = re.compile(r"\{\w+\}")
_LOC_DIR = Path(__file__).parent.parent / "omlx_uplift" / "locales"
_STATIC = _LOC_DIR.parent / "static"


def _load(loc):
    return json.loads((_LOC_DIR / (loc + ".json")).read_text())


def _ph(v):
    return sorted(_PH_RE.findall(v))


@pytest.mark.parametrize("loc", LOCALES)
def test_tts1_keys_present_and_consistent(loc):
    d = _load(loc)
    en = d if loc == "en" else _load("en")
    for k in TTS1_KEYS + RENAMED:
        assert k in d and d[k].strip(), f"{k} missing in {loc}"
        assert _ph(d[k]) == _ph(en[k]), f"{k} placeholder drift in {loc}"
        if loc != "en":
            assert d[k] != en[k], f"{k} untranslated in {loc}"


def test_tts1_renamed_menu_in_english():
    en = _load("en")
    assert en["uplift.tab.voices"] == "TTS & Voices"
    assert en["uplift.page.voices_full"] == "TTS & Voices"


_CALL_RE = re.compile(r"\b(?:C\.|c\.)?tf\(|\bvcTabBtn\(")


def _call_args(src, open_paren):
    """Group the strings of one call by top-level argument. '+' between two
    adjacent literals of the same argument merges them (multi-line string
    concatenation); ?: branches stay separate entries."""
    pos = open_paren + 1
    depth = 1
    args = [[]]           # per arg: list of branch strings
    merge_next = False    # a bare '+' just closed the previous string
    while pos < len(src):
        ch = src[pos]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                break
        elif ch == "," and depth == 1:
            args.append([])
            merge_next = False
        elif ch in "\"'":
            q = ch
            k = pos + 1
            s = []
            while k < len(src) and src[k] != q:
                if src[k] == "\\":
                    s.append(src[k:k + 2])
                    k += 2
                    continue
                s.append(src[k])
                k += 1
            frag = "".join(s)
            if "\\" in frag:
                frag = frag.encode().decode("unicode_escape")
            if merge_next and args[-1]:
                args[-1][-1] += frag
            else:
                args[-1].append(frag)
            merge_next = False
            pos = k + 1
            continue
        elif ch == "+":
            merge_next = True
        pos += 1
    return args


def _js_tf_pairs(src):
    """(key, fallback) pairs from every tf/vcTabBtn call: a ternary key
    site pairs its branches by position; single keys join their branches"""
    out = []
    for m in _CALL_RE.finditer(src):
        args = _call_args(src, src.index("(", m.end() - 1))
        if len(args) < 2 or not args[0]:
            continue
        keys, vals = args[0], args[1]
        if len(keys) == 1:
            out.append((keys[0], "".join(vals)))
        elif len(keys) == len(vals):
            out.extend(zip(keys, vals))
        # keys without an aligned fallback (computed) are not pinned here
    return out


@pytest.mark.parametrize("js", ["uplift_voices.js", "uplift_mmeditor.js",
                                "uplift_mmtable.js"])
def test_tts1_js_fallbacks_match_en(js):
    src = (_STATIC / js).read_text()
    en = _load("en")
    used = {k for k, _ in _js_tf_pairs(src) if k in TTS1_KEYS}
    for key, got in _js_tf_pairs(src):
        if key not in TTS1_KEYS:
            continue
        assert got == en[key], (
            "%s fallback in %s drifted:\n JS: %r\n EN: %r" % (key, js, got, en[key]))
    if js == "uplift_voices.js":
        # every tab-family key must actually be reached from the page
        missing = set(TTS1_KEYS) - used - {
            "uplift.voices.tts_section", "uplift.voices.tts_section_note",
            "uplift.voices.tts_badge_title",   # editor/table family lives elsewhere
            "uplift.voices.editor_title", "uplift.voices.editor_hint"}
        assert not missing, "tts_* keys unused in the page: " + str(missing)


def test_index_html_fallbacks_match_en():
    html = (_STATIC / "index.html").read_text()
    assert 'data-i18n="uplift.tab.voices">TTS &amp; Voices<' in html
    assert 'data-i18n="uplift.page.voices_full">TTS &amp; Voices<' in html
