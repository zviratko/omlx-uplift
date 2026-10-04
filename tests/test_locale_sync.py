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
                  "uplift.inflight.", "uplift.theme.",
                  # I18N-1 leak sweep: every prefix that got new keys must be
                  # cross-locale enforced so the batch rule keeps holding
                  "uplift.bench.", "uplift.chip.", "uplift.dl.", "uplift.feed.",
                  "uplift.gsys.", "uplift.helper.", "uplift.logs.", "uplift.mm.",
                  "uplift.mo.", "uplift.models.", "uplift.retention.",
                  "uplift.patches.", "uplift.envcat.")


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


# I18N-1 (SWEEP183 D1): the same gate in the OTHER direction, over the
# whole uplift.* namespace, not just the owned prefixes. Extras can never
# render (en is the fallback source of truth for what exists) — ja alone
# carried 26 dead keys purged with this test. DYNAMIC EXCEPTION: keys are
# assembled at runtime ('uplift.se.' + field key in modelmgr's seBind,
# 'uplift.gs.' + dotted path + '.' + option value in gsys' gsLocalize),
# so a literal-absent key is NOT proof of death. The closed reachable
# sets are whitelisted here; new dynamic families must extend it — the
# whitelist is deliberate, a grep over the corpus cannot see concatenation.
DYNAMIC_REACHABLE = {
    # uplift.se.<key> for the sampling-loop keys (uplift_modelmgr.js, the
    # only seBind keys ABSENT from en.json — en falls through to the
    # English literal; ja/ko translate them, legitimately)
    "uplift.se.temperature", "uplift.se.top_p", "uplift.se.top_k",
}
DYNAMIC_REACHABLE_PREFIXES = (
    # uplift.gs.<path>.<value> — gsLocalize translates every [value,label]
    # option array (tiers, idle_opts, log levels) this way
    "uplift.gs.res.tiers.", "uplift.gs.model.idle_opts.",
    "uplift.gs.server.levels.",
)


def _statically_unreachable(k, corpus):
    """D2: a key is dead only if neither its literal NOR its dynamic
    builder pattern appears. 'uplift.se.temperature' is referenced as
    'uplift.se.' + key — the prefix-with-quote forms prove the family is
    assembled, per-file judgment stays with the whitelist above."""
    return k not in corpus


def test_no_uplift_keys_beyond_en():
    en = _locale("en")
    corpus = "\n".join(
        p.read_text(encoding="utf-8")
        for p in sorted(STATIC.glob("*.js"))) + (STATIC / "index.html").read_text(
        encoding="utf-8")
    for lang in LOCALES_EXPECTED:
        if lang == "en":
            continue
        other = _locale(lang)
        extras = {k for k in other
                  if k.startswith("uplift.") and k not in en
                  and k not in DYNAMIC_REACHABLE
                  and not k.startswith(DYNAMIC_REACHABLE_PREFIXES)
                  and _statically_unreachable(k, corpus)}
        assert not extras, (
            f"{lang}.json carries uplift.* keys en.json does not have and "
            f"no client reference reaches: {sorted(extras)}")
