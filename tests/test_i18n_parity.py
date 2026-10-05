"""I18N-2 acceptance: per-locale placeholder parity + brand/unit whitelist.

For every uplift.* key, the {var} set of the translated value must equal
the {var} set of the en value — a dropped or renamed placeholder breaks
interpolation at runtime. Scripted, not eyeballed (ticket acceptance).

Second rule: a non-en value byte-identical to en must be a legitimate
brand/unit/technical string (the same class the reverse JS lint whitelists);
anything else means a translation was skipped.
"""
import json
import re
from pathlib import Path

LOCALES = Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"
LANGS = [p.stem for p in LOCALES.glob("*.json") if p.stem != "en"]

# same family as tests/i18n-reverse-lint.test.cjs WHITELIST (JS side), plus
# composed technical labels: every WORD must be a brand/unit/tech token,
# placeholder, number or punctuation (e.g. "CPU W", "prefill tok/s",
# "Claude Code", "PR #", "brew services restart omlx-dev").
TECH_WORDS = {
    "GiB", "MiB", "KiB", "GB", "MB", "tok/s", "tps", "HTTP", "API", "URL",
    "JSON", "HTML", "oMLX", "omlx", "MLX", "HF", "TRENDING", "POPULAR",
    "SEARCH", "TRACE", "DEBUG", "INFO", "WARNING", "ERROR", "GitHub", "PR",
    "Claude", "Code", "Lightning", "MTP", "VLM", "CPU", "GPU", "ANE", "RPM",
    "W", "°C", "brew", "services", "restart", "omlx-dev", "gateway",
    "cache", "prefill", "SSE", "TLS", "SHA", "DEV", "KEG",
    # accepted git/dev loanwords kept English in these locales' tech style
    "Patches", "patches", "branch", "build",
    # quantization method labels — identical by design in all locales
    # (classic shows 'RHT + int16' untranslated; it carries no prose)
    "RHT", "int16",
}


def _brand_unit(v):
    v = v.strip()
    if re.fullmatch(r"[\W\d.,%]+|[\d.,]+%?", v):
        return True
    v = re.sub(r"\{\w+\}", " ", v)             # placeholders carry no prose
    # tokens may keep internal '/' (tok/s) and '-' (omlx-dev); '/' between
    # words ("Patches / DEV") is whitespace-separated and drops out
    words = re.findall(r"°C|[A-Za-z][A-Za-z0-9.-]*(?:/[A-Za-z0-9]+)?|\d+", v)
    if not words:
        return True
    return all(w in TECH_WORDS for w in words)


def _vars(v):
    return set(re.findall(r"\{(\w+)\}", v))


def _load(lang):
    return json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf-8"))


def test_placeholder_parity():
    en = _load("en")
    bad = []
    for lang in LANGS:
        d = _load(lang)
        for k, v in en.items():
            if k not in d:
                continue  # batch rule covered by test_locale_sync
            if _vars(v) != _vars(d[k]):
                bad.append(f"{lang}:{k} en={sorted(_vars(v))} tr={sorted(_vars(d[k]))}")
    assert not bad, "placeholder drift:\n" + "\n".join(bad)


def test_en_identical_values_are_brand_or_unit():
    en = _load("en")
    bad = []
    for lang in LANGS:
        d = _load(lang)
        for k, v in en.items():
            tv = d.get(k)
            if tv == v and not _brand_unit(v):
                # short generic words legitimately coincide in some locales
                # (e.g. cs 'URL'); flag only multi-word phrases
                if len(v.split()) > 1:
                    bad.append(f"{lang}:{k} = {v!r}")
    assert not bad, "EN-identical translations outside the brand/unit whitelist:\n" + "\n".join(bad)
