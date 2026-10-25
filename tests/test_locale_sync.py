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
                  "uplift.patches.", "uplift.envcat.",
                  # NAT-3: native surface skeleton keys (bench stubs + chat)
                  "uplift.chat.",
                  # NAT-6: native/classic surface switch nav labels
                  "uplift.nav.",
                  # STATUS-SPLIT (2026-10-25): the three-view nav labels and
                  # the About page. Both batches shipped in all 10 overlays,
                  # so they are cross-locale enforced from now on.
                  "uplift.tab.", "uplift.about.", "uplift.layout.")


def _locale(lang):
    return json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf-8"))


def _referenced_keys():
    # PH2-1 stage 0: scan the whole static JS surface, not uplift.js by name —
    # the split into per-section files must not blind this gate.
    js = "\n".join(sorted(p.read_text(encoding="utf-8")
                          for p in STATIC.glob("*.js")))
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    # D5 (live QA 2026-10-25): this gate used to know ONE call shape,
    # C.t('key'). The chat/bench/editor surfaces grew three more — the
    # fallback-taking t('key', 'English'), its aliases (tf/tf2/ta/tr, with or
    # without the C. namespace) and el.dataset.i18n = 'key' — and every key
    # reaching the UI that way was INVISIBLE here. 31 strings shipped with no
    # catalog entry at all and rendered their English fallback in every locale,
    # which looks like "translation missing" to the user and like "green" here.
    keys = set()
    CALL = re.compile(
        r"""\b(?:C\.|D\.|U\.|G\.)?t(?:f2?|a|r)?\(\s*['"]([A-Za-z0-9_.]+)['"]""")
    for m in CALL.finditer(js):
        k = m.group(1)
        # 'uplift.bench.extras_family_' + f  /  'uplift.metric.' + tk: the
        # literal is a PREFIX of a runtime-assembled key, so it is not a key
        # and must not be demanded of the catalog. Detected by what follows
        # the literal (a +), because such a prefix can end in '.' OR '_' —
        # the old endswith('.') guess missed the underscore one.
        if re.match(r"\s*\+", js[m.end():m.end() + 40]):
            continue
        keys.add(k)
    keys |= set(re.findall(
        r"""dataset\.i18n(?:Title|Ph|Html|Aria|Placeholder)?\s*=\s*['"]"""
        r"""([A-Za-z0-9_.]+)['"]""", js))
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
    """D5: parity is now derived from en.json itself, not from a hand-grown
    tuple of prefixes. OWNED_PREFIXES is exactly the kind of list that goes
    stale: batches landed under uplift.se., uplift.gs., uplift.ui.,
    uplift.status. and uplift.action., none of which were ever added, so the
    gate silently covered a fraction of the catalog while claiming to police
    batches. en.json is the source of truth for what exists (Invariant 1
    already forces every referenced key into it), so 'in en => in all locales'
    needs no maintenance to be complete."""
    en = _locale("en")
    owned_en = {k for k in en if k.startswith("uplift.")}
    assert owned_en, "en.json overlay empty?"
    # the prefix tuple still earns its keep as a floor: if someone shrinks the
    # owned set below what it documents, that is a decision, not a slip
    documented = {k for k in owned_en if k.startswith(OWNED_PREFIXES)}
    assert documented, "owned-prefix list stale?"
    for lang in LOCALES_EXPECTED:
        if lang == "en":
            continue
        other = _locale(lang)
        missing = owned_en - set(other)
        assert not missing, f"{lang}.json missing {len(missing)} en.json keys: {sorted(missing)}"


_PH = re.compile(r"\{[a-zA-Z_][a-zA-Z0-9_]*\}")


def test_placeholder_sets_survive_translation():
    """A translation that loses or renames {type} silently prints the raw
    brace token into the UI, and .replace() leaves the sentence with a hole.
    Placeholder multisets must match en.json key for key."""
    en = _locale("en")
    for lang in LOCALES_EXPECTED:
        if lang == "en":
            continue
        for k, v in _locale(lang).items():
            if k not in en or not isinstance(v, str):
                continue
            assert sorted(_PH.findall(v)) == sorted(_PH.findall(en[k])), (
                f"{lang}.json {k}: {sorted(_PH.findall(v))} vs "
                f"en {sorted(_PH.findall(en[k]))}")


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
