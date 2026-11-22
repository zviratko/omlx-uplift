#!/usr/bin/env python3
"""SYNC-1 label/text drift check (user 2026-11-21).

Classic's i18n EN texts get mirrored into uplift two ways: as the English
fallback of C.tf('classic.key', '...') and — the dangerous way — as uplift's
OWN locale value or hardcoded label/hint for the same row. When upstream
later rewords or renames that text, the mirror goes stale SILENTLY: the
globalspec gate pins schemas, not words, and a C.tf fallback only shows when
the key is missing. Found this way: the model-editor row for
qwen4_gdn_decode_wide_proj still read 'Qwen4 Wide-Proj GDN Decode ...
(experimental)' from its port-time copy while classic had become 'Qwen4
Extended Fused Decode' with a rewritten hint.

Two complementary sweeps against the CURRENT classic EN catalog (range
INDEPENDENT — drift can predate the last reviewed range, as wide_proj's
did; run it on every sync run):

  CHECK 1 (text): every English literal uplift paints (its en.json values +
    static JS literals). Exact match with a classic value = verbatim
    mirror, parity. Otherwise, sharing a 5-word normalized run with a
    classic value = suspect stale paraphrase (classic reworded around our
    copy). No overlap = uplift-original text, unflagged.

  CHECK 2 (name): every seBind row whose payload key names a classic
    modal.model_settings key (after camel->snake and enable/_enabled
    folding). If the row's label/hint is not a C.tf reference to that
    classic key and its text differs from classic's CURRENT value, the
    copy is stale. A row referencing any classic key inside a ternary
    passes. Equal text passes (untranslated but parity — converting it to
    the classic key is recommended, not a run blocker).

Exit 0 = clean. Exit 1 = suspects printed; each one is fixed in the run by
moving the row onto classic's own key via C.tf (run-13 doctrine: translated
in every locale through the mounted catalog, self-healing on reword) and
deleting the uplift copy from all locale files — or justified in ALLOW /
ALLOW_ROW below with a real reason.

Known blind spot: uplift text for a classic feature that never resembled
classic's wording AND sits on a renamed/merged payload key (classic
re-names a field, e.g. ssd_ngram_offload over qwen4_ple_ssd_offload) —
neither sweep links them; that stays manual template review (S3c).
"""
import argparse
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N_CANDIDATE = "apps/omlx-web/omlx_web/i18n/en.json"
MIN_LEN = 20          # shorter literals are too generic to compare
RUN = 5               # shared normalized word-run length that flags a mirror

# uplift literal -> why it is NOT a stale mirror (triaged 2026-11-21)
ALLOW = {
    "Maximum RAM used by encoded snapshots waiting to be written to SSD. "
    "When the buffer is full, cache writes pause until space is available. "
    "A size without a unit is read as MB.":
        "classic hint verbatim + uplift unit sentence (owner report: the "
        "engine reads a bare number as bytes; uplift stamps MB)",
    "A custom benchmark is already running in this server.":
        "uplift's own bench panel; classic's string names classic's "
        "throughput bench",
    "API requests cannot override this value":
        "uplift composite hint joining two classic strings (kwarg row)",
    "Parameters passed to chat template. Force: API requests cannot "
    "override this value.":
        "uplift composite of classic chat_template_kwargs_hint + "
        "kwarg_force_tooltip",
    "Alias to use when the requested model is unavailable.":
        "uplift GS panel's own wording for model_fallback (never copied)",
    "Anyone who can reach this server will be able to use inference APIs, "
    "MCP tools, and web search without an API key.\n\nBy turning this on, "
    "you acknowledge that the server will be exposed to attacks from the "
    "network, that you understand you are removing this security "
    "protection, and that you have put appropriate security measures in "
    "place.\n\nSelect OK only if you understand and accept this.":
        "verbatim copy of the CURRENT classic keyless_inference_confirm "
        "(GS_LABELS is the spec-row label source); flagged only by a run "
        "collision with the sibling _hint key",
    "Custom target must be a whole number of at least 2,048 tokens.":
        "uplift bench validation",
    "Generation tokens must be a whole number of at least 1.":
        "uplift bench validation",
    "Parallel requests must be a whole number between 1 and 256.":
        "uplift bench validation",
    "Prefill length must be a whole number of at least 1,024 tokens.":
        "uplift bench validation",
    "Pick at least one prompt length":
        "uplift bench panel (classic's is its own prompt-length picker)",
    "Seconds between trivial GPU kernels while a model is loaded but idle, "
    "keeping the GPU out of its idle power state (the first command buffer "
    "after an idle stall can take seconds on large models). Ticks stop "
    "when the Keep GPU Awake After Requests time runs out; 0 disables.":
        "uplift GS keep-warm row description; classic dropped its own "
        "interval hint when the row moved (run 23 wording)",
    "The macOS say engine is not available on this server.":
        "uplift-only say TTS engine",
    "direct repo id, e.g. mlx-community/Llama-3-8B-4bit":
        "uplift downloader placeholder, own 'direct repo id, e.g.' prefix",
}

# (payload_key, field) -> why the row may keep uplift text (check 2)
ALLOW_ROW = {
    ("guided_grammar", "hint"):
        "uplift's own grammar-textarea description (classic's hint "
        "belongs to the enable toggle, mirrored there)",
    ("external_engine", "hint"):
        "uplift's picker hint is its own (multi-engine list); classic's "
        "select_hint names one engine; the GGUF branch uses classic's key",
    ("gdn_ssd_pending_max_size", "hint"):
        "classic's hint verbatim + uplift's unit sentence (owner report: "
        "the engine reads a bare number as bytes; uplift's input stamps MB)",
}


def norm(s):
    return (s.lower().replace("\u2013", "-").replace("\u2014", "-")
             .replace("\u2019", "'").replace("\u201c", '"')
             .replace("\u201d", '"'))


def toks(s):
    return re.findall(r"[a-z0-9.%{}]+", norm(s))


def classic_catalog(src, sha):
    path = I18N_CANDIDATE
    r = subprocess.run(["git", "-C", src, "show", f"{sha}:{path}"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        # pre-split trees: locate the i18n en.json at that commit
        r = subprocess.run(
            ["git", "-C", src, "ls-tree", "-r", "--name-only", sha],
            capture_output=True, text=True, check=True)
        cands = [l for l in r.stdout.splitlines()
                 if l.endswith("i18n/en.json")]
        if not cands:
            sys.exit(f"no i18n en.json found at {sha} in {src}")
        path = cands[0]
        r = subprocess.run(["git", "-C", src, "show", f"{sha}:{path}"],
                           capture_output=True, text=True, check=True)
    return json.loads(r.stdout), path


def unesc(s):
    # JS source carries '\n' as two bytes; the catalog has a real newline
    return s.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')


def uplift_literals():
    """(literal -> set of 'where') for every EN string uplift paints."""
    lits = {}
    with open(os.path.join(REPO, "omlx_uplift", "locales", "en.json"),
              encoding="utf-8") as fh:
        for k, v in json.load(fh).items():
            if isinstance(v, str) and len(v) >= MIN_LEN:
                lits.setdefault(v, set()).add(f"locale:{k}")
    for js in _static_js():
        src = js[1]
        for m in re.finditer(
                r"C\.tf\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)", src):
            s = unesc(m.group(2))
            if len(s) >= MIN_LEN:
                lits.setdefault(s, set()).add(
                    f"{js[0]}:tf-fallback:{m.group(1)}")
        for m in re.finditer(
                r"(label|hint|ph|confirm|desc|title):\s*'([^']{20,})'", src):
            lits.setdefault(unesc(m.group(2)), set()).add(f"{js[0]}:{m.group(1)}")
        for m in re.finditer(r"'([a-z][\w.]*)':\s*'([^']{20,})'", src):
            # EN fallback tables (gsys sub-key strip): key is a classic
            # i18n key, value its English text
            lits.setdefault(unesc(m.group(2)), set()).add(
                f"{js[0]}:EN-table:{m.group(1)}")
    return lits


def _static_js():
    out = []
    static = os.path.join(REPO, "omlx_uplift", "static")
    for root, _dirs, files in os.walk(static):
        if "vendor" in root:
            continue
        for f in files:
            if f.endswith(".js"):
                out.append((f, open(os.path.join(root, f),
                                    encoding="utf-8",
                                    errors="replace").read()))
    return out


# ---- check 2 helpers ---------------------------------------------------------

def snake(k):
    k = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", k).lower()
    k = re.sub(r"^enable_", "", k)
    k = re.sub(r"_enabled$", "", k)
    return k


def _skip_str(src, i):
    # src[i] == "'"; return index just past the closing quote
    i += 1
    while i < len(src):
        if src[i] == "\\":
            i += 2
            continue
        if src[i] == "'":
            return i + 1
        i += 1
    return i


def slice_call(src, start):
    i, depth = start, 0
    while i < len(src):
        c = src[i]
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
        elif c == "'":
            i = _skip_str(src, i)
            continue
        i += 1
    return None


def opt_expr(opts, name):
    """text of the `name: <expr>` value inside an opts object literal"""
    pos = 0
    while True:
        m = re.compile(r"\b" + name + r":\s*").search(opts, pos)
        if not m:
            return None
        i, depth = m.end(), 0
        while i < len(opts):
            c = opts[i]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif c == "," and depth == 0:
                break
            elif c == "'":
                i = _skip_str(opts, i)
                continue
            i += 1
        expr = opts[m.end():i].strip()
        if not expr.startswith("//"):      # a comment bleed: keep searching
            return expr
        pos = i


def row_check(cls):
    ms_prefix = "modal.model_settings."
    ms = {k[len(ms_prefix):]: v for k, v in cls.items()
          if k.startswith(ms_prefix) and isinstance(v, str)}
    flags = []
    for fname, src in _static_js():
        for m in re.finditer(r"seBind\(", src):
            call = slice_call(src, m.start())
            if not call:
                continue
            body = call[len("seBind("):-1]
            am = re.match(r"\s*'\w+'\s*,\s*'(\w+)'\s*,", body)
            if not am:
                continue
            base = snake(am.group(1))
            lk, hk = ms_prefix + base, ms_prefix + base + "_hint"
            if lk not in cls and hk not in cls:
                continue
            om = re.match(r"\s*'\w+'\s*,\s*'\w+'\s*,", body)
            opts = body[om.end():]
            for field, ck in (("label", lk), ("hint", hk)):
                if ck not in cls:
                    continue
                expr = opt_expr(opts, field)
                if expr is None:
                    continue
                if (re.search(r"C\.t[fra]?\(", expr)
                        and re.search(r"'\s*(modal|settings|chat|models|js)\.",
                                      expr)):
                    continue        # classic-driven (possibly via ternary)
                if (am.group(1), field) in ALLOW_ROW:
                    continue
                fm = re.fullmatch(r"'([^']*)'", expr)
                if fm and unesc(fm.group(1)) == cls[ck]:
                    continue        # verbatim EN parity (untranslated only)
                flags.append((fname, am.group(1), ck,
                              expr.replace("\n", " ")[:90],
                              cls[ck][:90]))
    return flags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--omlx-src", default=os.environ.get(
        "OMLX_SRC", os.path.expanduser("~/git/omlx-upstream")))
    ap.add_argument("--sha", default="HEAD")
    args = ap.parse_args()

    cls, path = classic_catalog(args.omlx_src, args.sha)
    index = {}
    for k, v in cls.items():
        if not isinstance(v, str):
            continue
        t = toks(v)
        for i in range(max(0, len(t) - RUN + 1)):
            index.setdefault(" ".join(t[i:i + RUN]), set()).add(k)
    cls_vals = set(v for v in cls.values() if isinstance(v, str))

    lits = uplift_literals()
    suspects = []
    for s, where in sorted(lits.items()):
        if s in cls_vals:
            continue                      # verbatim mirror = parity
        t = toks(s)
        seen = set()
        for i in range(max(0, len(t) - RUN + 1)):
            seen |= index.get(" ".join(t[i:i + RUN]), set())
        if seen and s not in ALLOW:
            suspects.append((s, sorted(seen), sorted(where)))

    print(f"sync-label-drift: {len(lits)} uplift literals vs "
          f"{len(cls_vals)} classic EN values ({args.sha} @ {path})")
    for s, keys, where in suspects:
        print("CHECK1 STALE-TEXT? " + (s[:100] + ("..." if len(s) > 100 else "")))
        for k in keys[:3]:
            print(f"    classic {k}: {cls[k][:100]}")
        print("    uplift  " + "; ".join(where)[:160])

    rows = row_check(cls)
    for fname, pk, ck, expr, cur in rows:
        print(f"CHECK2 STALE-ROW? {fname} row '{pk}' ({field_of(ck)})")
        print(f"    classic {ck}: {cur}")
        print(f"    uplift  {expr}")

    n = len(suspects) + len(rows)
    if not n:
        print("clean — no stale mirror of classic text")
        return 0
    print(f"\n{n} suspect(s): move each row onto classic's key via C.tf and "
          "delete the uplift copy, or allowlist it with a reason")
    return 1


def field_of(ck):
    return "hint" if ck.endswith("_hint") else "label"


if __name__ == "__main__":
    sys.exit(main())
