"""Locale-sync gate for the uplift i18n overlay.

Invariant 1 (fallback): every key referenced from the client
(C.t('uplift…') in uplift.js, data-i18n in index.html) exists in en.json —
EN fallback must never show a raw key.

Invariant 2 (batch discipline): uplift keys added by us in en.json exist in
ALL locale files. Vanilla overlay files legitimately carry different key
sets (upstream drift), so the check runs on prefixes this repo owns and
grows: uplift.req.*, uplift.layout.retention_* — extend the tuple when a
batch lands.
"""
import json
import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "omlx_uplift" / "static"
LOCALES = Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"
LOCALES_EXPECTED = ["en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-TW", "zh", "cs"]
OWNED_PREFIXES = ("uplift.req.", "uplift.layout.retention_", "uplift.env.",
                  "uplift.inflight.", "uplift.theme.")


def _locale(lang):
    return json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf-8"))


def _referenced_keys():
    # PH2-1 stage 0: scan the whole static JS surface, not uplift.js by name —
    # the split into per-section files must not blind this gate.
    js = "\n".join(sorted(p.read_text(encoding="utf-8")
                          for p in STATIC.glob("*.js")))
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    keys = set(re.findall(r"C\.t\(\s*['\"]([A-Za-z0-9_.]+)['\"]", js))
    keys |= set(re.findall(r'data-i18n="([A-Za-z0-9_.]+)"', js + html))
    keys |= set(re.findall(r'data-i18n-title="([A-Za-z0-9_.]+)"', js + html))
    keys |= set(re.findall(r'data-i18n-ph="([A-Za-z0-9_.]+)"', js + html))
    # source.<x> keys are assembled at runtime: expand the known set
    if any(k.startswith("uplift.req.source.") for k in keys):
        pass
    for k in [k for k in keys if k.endswith(".")]:
        keys.discard(k)
    return {k for k in keys if k.startswith("uplift.")}


def test_all_locale_files_present():
    have = sorted(p.stem for p in LOCALES.glob("*.json"))
    assert have == sorted(LOCALES_EXPECTED), have


def test_referenced_keys_exist_in_en_fallback():
    en = _locale("en")
    missing = {k for k in _referenced_keys() if k not in en}
    # runtime-assembled uplift.req.source.<source> — check the closed set
    for src in ("active", "stored", "both"):
        if f"uplift.req.source.{src}" in en:
            missing.discard(f"uplift.req.source.{src}")
    assert not missing, f"keys used by client but absent from en.json: {missing}"


def test_owned_key_sets_match_across_locales():
    en = _locale("en")
    owned_en = {k for k in en if k.startswith(OWNED_PREFIXES)}
    assert owned_en, "owned-prefix list stale?"
    for lang in LOCALES_EXPECTED:
        if lang == "en":
            continue
        other = _locale(lang)
        missing = owned_en - {k for k in other if k.startswith(OWNED_PREFIXES)}
        assert not missing, f"{lang}.json missing: {sorted(missing)}"
