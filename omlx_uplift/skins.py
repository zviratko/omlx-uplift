# SPDX-License-Identifier: Apache-2.0
"""Uplift skin system (design v1, 2026-09-22).

Skins are CSS-only themes a user drops into ``<base>/uplift/skins/`` where
<base> resolves like the metrics store (server base_path -> OMLX_BASE_PATH
-> ~/.omlx). Two encodings of one format (design section 2):

* crate: ``<name>.yml`` — single-file distribution (tokens + inline b64
  resources + overlay CSS block scalar).
* working copy: ``<name>-<mtime>/`` — the SERVING source of truth. Created
  by extraction at scan time, NEVER overwritten afterwards (protects hand
  edits); extracted files win over the crate.

Serving contract (section 3): compiled ``theme.css`` scoped to
``:root[data-theme="<dir>"]`` cached in-process keyed by directory mtimes,
plus whitelisted resource files served through the same static machinery
(ETag/304) the rest of uplift uses. Everything here is pure-Python + PyYAML
(ships in the omlx runtime); no disk precompute, no restart to add a skin.

Failure posture (section 6): a bad skin never breaks the page. Malformed
YAML or unsupported ``skin_version`` skips the WHOLE skin with a reason
surfaced in the listing; a bad token key/value or an undecodable resource is
skipped individually with a warning and the skin still loads.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import os
import re
from pathlib import Path

log = logging.getLogger("uplift.skins")

SUPPORTED_SKIN_VERSION = 1

# --- name / path whitelists (design sections 2.1, 6) -----------------------
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")                 # crate <name>
DIR_RE = re.compile(r"^[a-z0-9][a-z0-9-]*(-\d{10})?$")        # working copy
_RES_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
RES_RE = re.compile(r"^icons/[A-Za-z0-9][A-Za-z0-9._-]*$")    # served relpath

# Fixed v1 icon vocabulary: icons/<basename>.<ext> -> --icon-<basename>.
# Anything else present under icons/ is servable but gets no CSS variable
# (forward compat: unknown names are ignored, design section 4).
ICON_BASENAMES = ("caret", "close", "logo-dot")

# Size caps (design 2.1): crate 1 MB, per-resource 512 KB, extracted 8 MB.
MAX_CRATE_BYTES = 1 * 1024 * 1024
MAX_RESOURCE_BYTES = 512 * 1024
MAX_EXTRACTED_BYTES = 8 * 1024 * 1024

# --- token vocabulary (design section 6) ----------------------------------
# The 18 color grounds/inks of uplift.css :root + the header-chrome trio +
# the two font stacks. Unknown token keys are IGNORED (forward compat).
COLOR_TOKENS = frozenset({
    "bg", "card", "row2", "field", "panel", "edge", "ink", "dim", "accent",
    "chart-1", "chart-2", "grid", "heat", "frame", "red", "good", "warn",
    "bad", "hdr-ink", "hdr-edge", "hdr-hover",
})
FONT_TOKENS = frozenset({"mono", "sans"})
NUMERIC_TOKENS = frozenset({"hdr-weight"})
TOKEN_KIND = {**{k: "color" for k in COLOR_TOKENS},
              **{k: "font" for k in FONT_TOKENS},
              **{k: "weight" for k in NUMERIC_TOKENS}}

_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_FUNC_RE = re.compile(
    r"^(?:rgb|rgba|hsl|hsla)\(\s*[\d%.a-zA-Z,\s/]+\)\s*$")
_NAMED_RE = re.compile(r"^(?:[a-z]+|transparent|currentcolor|currentColor)$")
_WEIGHT_RE = re.compile(r"^(?:[1-9]00|normal|bold)$")
_FONT_RE = re.compile(r"^[A-Za-z0-9 ,\"'._-]+$")


def _valid_token(name: str, value: str) -> bool:
    kind = TOKEN_KIND.get(name)
    if kind == "color":
        return bool(_HEX_RE.match(value) or _FUNC_RE.match(value)
                    or _NAMED_RE.match(value))
    if kind == "font":
        return bool(_FONT_RE.match(value)) and len(value) <= 300
    if kind == "weight":
        return bool(_WEIGHT_RE.match(value))
    return False


def skins_root(base: Path | None = None) -> Path:
    """<base>/uplift/skins — same base resolution as the metrics store."""
    if base is None:
        base = Path(_resolve_base_path())
    return Path(base) / "uplift" / "skins"


def _resolve_base_path() -> str:
    base = None
    try:
        from omlx.server import _server_state

        gs = getattr(_server_state, "global_settings", None)
        bp = getattr(gs, "base_path", None) if gs else None
        if bp:
            base = str(bp)
    except Exception:
        pass
    if base is None:
        env = os.environ.get("OMLX_BASE_PATH")
        base = env if env else os.path.expanduser("~/.omlx")
    return base


# ---------------------------------------------------------------------------
# Crate parsing (never raises; returns (crate|None, reason))
# ---------------------------------------------------------------------------

def parse_crate(raw: str | bytes):
    """Parse crate YAML. Returns (crate_dict, None) or (None, reason)."""
    import yaml

    if isinstance(raw, bytes):
        if len(raw) > MAX_CRATE_BYTES:
            return None, f"file larger than {MAX_CRATE_BYTES} bytes"
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None, "not valid UTF-8"
    if len(raw.encode("utf-8")) > MAX_CRATE_BYTES:
        return None, f"file larger than {MAX_CRATE_BYTES} bytes"
    try:
        data = yaml.safe_load(raw)
    except Exception as exc:  # yaml.YAMLError + any decoder surprise
        return None, f"malformed YAML: {exc}"
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return None, "top level is not a mapping"
    try:
        version = int(data.get("skin_version", 1))
    except (TypeError, ValueError):
        return None, "skin_version is not an integer"
    if version > SUPPORTED_SKIN_VERSION:
        return None, (f"skin_version {version} newer than supported "
                      f"{SUPPORTED_SKIN_VERSION}")
    crate = {"skin_version": version, "raw": raw}
    label = data.get("label")
    crate["label"] = label if isinstance(label, str) and label.strip() else None
    classic = data.get("classic")
    crate["classic"] = classic if isinstance(classic, dict) else {}
    tokens = data.get("tokens")
    crate["tokens"] = {k: v for k, v in tokens.items()
                       if isinstance(k, str) and isinstance(v, str)} \
        if isinstance(tokens, dict) else {}
    icons = data.get("icons")
    crate["icons"] = {k: v for k, v in icons.items()
                      if isinstance(k, str) and isinstance(v, str)} \
        if isinstance(icons, dict) else {}
    css = data.get("css")
    crate["css"] = css if isinstance(css, str) else ""
    # Unknown top-level keys: ignored (forward compat), not an error.
    return crate, None


def _decode_resource(value: str, total_written: int):
    """Decoded bytes for a crate resource value, or (None, reason).

    Binary resources are base64 by spec. A readable block scalar whose
    characters happen to spell a base64 shape is kept verbatim (it decodes
    to printable text AND carries whitespace, so it was authored as text);
    a value that is not base64 at all is kept verbatim as UTF-8 (design
    2.1: text block scalars are first-class, b64 tolerated for any value)."""
    blob = None
    compact = "".join(value.split())
    if re.fullmatch(r"[A-Za-z0-9+/]{4,}={0,2}", compact):
        try:
            cand = base64.b64decode(compact, validate=True)
            try:
                text = cand.decode("utf-8")
                printable = all(c in "\n\t\r" or ord(c) >= 32 for c in text)
                if not (printable and any(c in value for c in " \n")):
                    blob = cand  # binary payload, or genuine single-line b64
            except UnicodeDecodeError:
                blob = cand  # binary payload
        except (binascii.Error, ValueError):
            blob = None  # b64 shape but undecodable padding: keep as text
    if blob is None:
        blob = value.encode("utf-8")
    if len(blob) > MAX_RESOURCE_BYTES:
        return None, f"resource larger than {MAX_RESOURCE_BYTES} bytes"
    if total_written + len(blob) > MAX_EXTRACTED_BYTES:
        return None, "skin extracted size cap (8 MB) exceeded"
    return blob, None


def _safe_child(root: Path, rel: str) -> Path | None:
    """root/rel resolved, still inside root (no '..', no symlink escape)."""
    if not rel or rel.startswith("/") or "\x00" in rel:
        return None
    try:
        p = (root / rel).resolve()
    except (OSError, ValueError):
        return None
    if p == root.resolve() or not p.is_relative_to(root.resolve()):
        return None
    return p


def _res_target(icons_dir_name: str) -> str | None:
    """Validate a crate icons map key as 'icons/<file>'; return that relpath."""
    rel = f"icons/{icons_dir_name}"
    if not RES_RE.match(rel) or not _RES_NAME_RE.match(icons_dir_name):
        return None
    return rel


# ---------------------------------------------------------------------------
# Extraction: crate -> working copy (idempotent, NEVER overwrite)
# ---------------------------------------------------------------------------

def extract_crate(root: Path, name: str, yml_bytes: bytes, mtime: int):
    """Create ``<root>/<name>-<mtime>/`` from a crate. Returns (dir_name|None,
    warnings, error|None). An existing directory is never touched."""
    dir_name = f"{name}-{int(mtime)}"
    if not DIR_RE.match(dir_name):
        return None, [], f"invalid directory name {dir_name!r}"
    target = root / dir_name
    if target.is_dir():
        return dir_name, [], None  # never overwrite hand edits
    crate, reason = parse_crate(yml_bytes)
    if crate is None:
        return None, [], reason
    warnings: list[str] = []
    try:
        target.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        return dir_name, [], None  # lost a race but the dir is there
    total = len(yml_bytes)

    def _write(rel: str, blob: bytes, meta_file: bool = False):
        nonlocal total
        p = _safe_child(target, rel)
        if p is None:
            warnings.append(f"skipped {rel}: path escaped skin dir")
            return False
        # the per-resource cap guards resources; skin.yml is the crate copy
        # itself and is already capped by MAX_CRATE_BYTES at parse time
        if (not meta_file and len(blob) > MAX_RESOURCE_BYTES) \
                or total + len(blob) > MAX_EXTRACTED_BYTES:
            warnings.append(f"skipped {rel}: size cap exceeded")
            return False
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "wb") as fh:  # no follow-replace: fresh dir anyway
                fh.write(blob)
            total += len(blob)
            return True
        except OSError as exc:
            warnings.append(f"skipped {rel}: {exc}")
            return False

    # skin.yml verbatim (the working copy is self-describing)
    _write("skin.yml", yml_bytes, meta_file=True)
    # overlay.css from css: (absent when the crate carries none)
    css = crate["css"]
    if css:
        blob, err = _decode_resource(css, total)
        if blob is None:
            warnings.append(f"skipped overlay.css: {err}")
        else:
            _write("overlay.css", blob)
    # icons: decoded; a bad entry only skips itself (fallback cascade, sec 4)
    for icon_name in sorted(crate["icons"]):
        rel = _res_target(icon_name)
        if rel is None:
            warnings.append(f"skipped icons/{icon_name}: name not whitelisted")
            continue
        blob, err = _decode_resource(crate["icons"][icon_name], total)
        if blob is None:
            warnings.append(f"skipped {rel}: {err}")
            continue
        _write(rel, blob)
    for w in warnings:
        log.warning("skin %s: %s", dir_name, w)
    return dir_name, warnings, None


# ---------------------------------------------------------------------------
# Scan / listing (design section 3 response shape)
# ---------------------------------------------------------------------------

def _load_dir_meta(skin_yml_path: Path):
    """Parse a working copy's skin.yml with an mtime-keyed parse cache."""
    key = str(skin_yml_path)
    try:
        st = skin_yml_path.stat()
    except OSError:
        return {}
    cached = _META_CACHE.get(key)
    if cached and cached[0] == (st.st_mtime, st.st_size):
        return cached[1]
    crate, _reason = parse_crate(skin_yml_path.read_bytes())
    meta = crate or {}
    _META_CACHE[key] = ((st.st_mtime, st.st_size), meta)
    return meta


_META_CACHE: dict[str, tuple, dict] = {}

_CSS_CACHE: dict[str, tuple[tuple, tuple[bytes, str]]] = {}


def invalidate_caches() -> None:
    _META_CACHE.clear()
    _CSS_CACHE.clear()


def classic_mapping(crate: dict) -> dict:
    """{theme: light|dark, enhanced: bool} for the embedded classic pages
    (design section 5). Declared values win; else theme derives from --bg
    luminance (light bg -> light, everything else -> dark)."""
    classic = crate.get("classic") or {}
    theme = classic.get("theme")
    if theme not in ("light", "dark"):
        bg = ""
        for k, v in (crate.get("tokens") or {}).items():
            if k == "bg":
                bg = v
                break
        lum = _luminance(bg)
        theme = "light" if (lum is not None and lum > 0.5) else "dark"
    enhanced = classic.get("enhanced")
    return {"theme": theme, "enhanced": bool(enhanced) if isinstance(
        enhanced, bool) else False}


def _luminance(color: str):
    """Relative luminance 0..1 for #rgb/#rrggbb/#rrggbbaa or rgb()/rgba();
    None for anything we cannot compute."""
    c = (color or "").strip()
    try:
        if _HEX_RE.match(c):
            h = c[1:]
            if len(h) in (3, 4):
                h = "".join(ch * 2 for ch in h[:3])
            else:
                h = h[:6]
            r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        else:
            m = re.match(
                r"^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)", c)
            if not m:
                return None
            r, g, b = (int(x) for x in m.groups())
    except ValueError:
        return None
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def _crate_mtime_int(path: Path) -> int:
    try:
        return int(path.stat().st_mtime)
    except OSError:
        return 0


def _dir_ts(dir_path: Path, dir_name: str) -> int:
    m = re.search(r"-(\d{10})$", dir_name)
    if m:
        return int(m.group(1))
    try:
        return int(dir_path.stat().st_mtime)
    except OSError:
        return 0


def list_skins(root: Path | None = None) -> list[dict]:
    """Scan the skins dir: extract any crate that has no working copy for its
    current mtime, then list working-copy entries newest-wins per base name.

    Entry shape (section 3): {name, label, ts, stale, yml_newer, dir,
    classic} plus optional {reason} for crates that failed to load.
    """
    root = skins_root() if root is None else Path(root)
    if not root.is_dir():
        return []
    warnings_seen: dict[str, list[str]] = {}

    # 1. crates: parse, extract missing working copies, remember failures
    crate_mtime: dict[str, int] = {}
    broken: list[dict] = []
    try:
        ymls = sorted(root.glob("*.yml"))
    except OSError:
        return []
    for yml in ymls:
        name = yml.stem
        if not NAME_RE.match(name):
            continue  # not a crate we recognise; leave the file alone
        mt = _crate_mtime_int(yml)
        crate_mtime[name] = mt
        want = f"{name}-{mt}"
        if (root / want).is_dir():
            continue
        try:
            raw = yml.read_bytes()
        except OSError as exc:
            broken.append({"name": name, "label": name, "ts": mt,
                           "stale": False, "yml_newer": False, "dir": None,
                           "classic": classic_mapping({}),
                           "reason": f"cannot read file: {exc}"})
            continue
        dir_name, warns, err = extract_crate(root, name, raw, mt)
        if err is not None:
            broken.append({"name": name, "label": name, "ts": mt,
                           "stale": False, "yml_newer": False, "dir": None,
                           "classic": classic_mapping({}), "reason": err})
        elif dir_name:
            warnings_seen[dir_name] = warns
            if warns:  # persist: a scan warning must survive repeat scans
                try:
                    (root / dir_name / ".extract-warnings").write_text(
                        "\n".join(warns), encoding="utf-8")
                except OSError:
                    pass

    # 2. working copies grouped by base name, newest first
    groups: dict[str, list[dict]] = {}
    try:
        dirs = sorted(root.iterdir())
    except OSError:
        dirs = []
    for d in dirs:
        if not d.is_dir() or d.is_symlink():
            continue  # only real dirs are working copies
        if not DIR_RE.match(d.name):
            continue
        base = re.sub(r"-\d{10}$", "", d.name)
        meta = _load_dir_meta(d / "skin.yml")
        label = meta.get("label") or base
        warns = warnings_seen.get(d.name)
        if warns is None:
            sidecar = d / ".extract-warnings"
            warns = sidecar.read_text(encoding="utf-8").splitlines() \
                if sidecar.is_file() else []
        groups.setdefault(base, []).append({
            "name": None,  # assigned below (base name vs suffixed)
            "dir": d.name,
            "label": label,
            "ts": _dir_ts(d, d.name),
            "stale": False,
            "yml_newer": False,
            "classic": classic_mapping(meta),
            "warnings": warns,
        })

    entries: list[dict] = []
    for base, rows in groups.items():
        rows.sort(key=lambda r: (-r["ts"], r["dir"]))
        for i, r in enumerate(rows):
            r["name"] = base if i == 0 else f"{base}-{r['ts']}"
            r["stale"] = i > 0
            mt = crate_mtime.get(base)
            # flag the yml/dir mismatch on the base-name entry only (the one
            # that follows the yml): older pinned versions are stale anyway
            if i == 0 and mt is not None and mt > r["ts"]:
                r["yml_newer"] = True
            entries.append(r)
    # 3. crates that never became a working copy still show, with a reason
    listed_bases = set(groups)
    for b in broken:
        if b["name"] not in listed_bases:
            entries.append(b)
    entries.sort(key=lambda e: (e["name"]))
    return entries


def resolve_sel(entries: list[dict], sel: str) -> dict | None:
    """Resolve a picker selection ('night' or exact 'night-<ts>') to an
    entry; None when unknown."""
    if not sel or not DIR_RE.match(sel):
        return None
    exact = [e for e in entries if e["dir"] == sel]
    if exact:
        return exact[0]
    if re.search(r"-\d{10}$", sel):
        return None  # an explicit suffixed version must exist exactly
    base = [e for e in entries if e["name"] == sel]
    return base[0] if base else None


# ---------------------------------------------------------------------------
# theme.css compile + in-process cache (design section 3)
# ---------------------------------------------------------------------------

_RES_MEDIA = {".png": "image/png", ".svg": "image/svg+xml",
              ".css": "text/css", ".woff2": "font/woff2"}


def res_media_type(rel: str) -> str:
    ext = os.path.splitext(rel)[1].lower()
    return _RES_MEDIA.get(ext, "application/octet-stream")


def _file_mtime_ns(p: Path) -> int:
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return 0


def theme_css(root: Path, sel_entry: dict) -> tuple[bytes, str]:
    """Compiled stylesheet bytes + strong ETag for a resolved working copy.

    Cache key: (dir, dir mtime, skin.yml mtime, overlay.css mtime) — the
    design's (dir, dir mtime, skin.yml mtime) plus overlay.css content
    mtime, because editing overlay.css in place does not bump the dir
    mtime and a hand edit MUST show on refresh (acceptance, section 9)."""
    root = Path(root)
    d = root / sel_entry["dir"]
    key = (str(d), _file_mtime_ns(d), _file_mtime_ns(d / "skin.yml"),
           _file_mtime_ns(d / "overlay.css"))
    hit = _CSS_CACHE.get(str(d))
    if hit and hit[0] == key:
        return hit[1]

    meta = _load_dir_meta(d / "skin.yml")
    decls, warns = compile_token_decls(meta.get("tokens") or {}, sel_entry["dir"])
    for w in warns:
        log.warning("skin %s: %s", sel_entry["dir"], w)
    icon_decls = compile_icon_decls(d, sel_entry["dir"])

    scope = f':root[data-theme="{sel_entry["dir"]}"]'
    parts = []
    if decls:
        parts.append(f"{scope} {{ {' '.join(decls)} }}\n")
    if icon_decls:
        parts.append(f"{scope} {{\n  " + "\n  ".join(icon_decls) + "\n}\n")

    overlay = None
    ov = d / "overlay.css"
    if ov.is_file():
        try:
            overlay = ov.read_bytes().decode("utf-8", "replace")
        except OSError:
            overlay = None
    elif meta.get("css"):
        overlay = meta["css"]
    if overlay and overlay.strip():
        parts.append("\n" + overlay.strip() + "\n")

    css = ("".join(parts)).encode("utf-8")
    etag = f'"{hashlib.md5(css, usedforsecurity=False).hexdigest()}"'
    _CSS_CACHE[str(d)] = (key, (css, etag))
    return css, etag


def compile_token_decls(tokens: dict, dir_name: str):
    """Validated '--key: value' declarations for a crate/working-copy token
    map. Bad keys and values are skipped individually with warnings."""
    decls, warns = [], []
    for key in sorted(tokens):
        value = tokens[key].strip()
        if key not in TOKEN_KIND:
            warns.append(f"unknown token {key!r} ignored")
            continue
        if not _valid_token(key, value):
            warns.append(f"invalid value for token {key!r}: {value[:80]!r}")
            continue
        decls.append(f"--{key}: {value};")
    return decls, warns


def compile_icon_decls(dir_path: Path, dir_name: str) -> list[str]:
    """--icon-<name> variables for v1 vocabulary files that actually exist
    under <dir>/icons/ (a variable is emitted ONLY when its file exists —
    design section 4)."""
    decls = []
    icons = dir_path / "icons"
    if not icons.is_dir():
        return decls
    try:
        names = sorted(os.listdir(icons))
    except OSError:
        return decls
    found: dict[str, str] = {}
    for n in names:
        rel = f"icons/{n}"
        if not RES_RE.match(rel):
            continue
        p = _safe_child(dir_path, rel)
        if p is None or not p.is_file():
            continue
        base = os.path.splitext(n)[0]
        if base in ICON_BASENAMES and base not in found:
            found[base] = rel
    for base in ICON_BASENAMES:
        if base in found:
            url = f"/uplift/api/skins/{dir_name}/res/{found[base]}"
            decls.append(f"--icon-{base}: url({url});")
    return decls


# ---------------------------------------------------------------------------
# CLI codecs: compile (dir -> canonical crate) + decompile (dir if absent)
# ---------------------------------------------------------------------------

def _yaml_scalar(value) -> str:
    # json.dumps emits valid YAML double-quoted flow scalars for str/num/bool
    return json.dumps(value, ensure_ascii=False)


def compile_dir(dir_path: Path) -> str:
    """Directory -> canonical crate text: keys sorted in a fixed order,
    text as block scalar, binary as single-line base64. Deterministic:
    identical input dir -> byte-identical output (design section 2.2/8)."""
    dir_path = Path(dir_path)
    dir_name = dir_path.name
    if not DIR_RE.match(dir_name):
        raise ValueError(f"not a skin working dir: {dir_name!r}")
    meta = parse_crate((dir_path / "skin.yml").read_bytes())[0] or {}

    out: list[str] = [f"skin_version: {meta.get('skin_version', 1)}"]
    if meta.get("label"):
        out.append(f"label: {_yaml_scalar(meta['label'])}")
    classic = {k: v for k, v in (meta.get("classic") or {}).items()
               if k in ("theme", "enhanced")}
    if classic:
        out.append("classic:")
        for k in sorted(classic):
            out.append(f"  {k}: {_yaml_scalar(classic[k])}")
    tokens = {k: v for k, v in (meta.get("tokens") or {}).items()
              if k in TOKEN_KIND}
    if tokens:
        out.append("tokens:")
        for k in sorted(tokens):
            out.append(f"  {k}: {_yaml_scalar(tokens[k])}")

    icons_dir = dir_path / "icons"
    icon_names: list[str] = []
    if icons_dir.is_dir():
        icon_names = sorted(n for n in os.listdir(icons_dir)
                            if _RES_NAME_RE.match(n)
                            and (icons_dir / n).is_file()
                            and not (icons_dir / n).is_symlink())
    if icon_names:
        out.append("icons:")
        for n in icon_names:
            blob = (icons_dir / n).read_bytes()
            if len(blob) > MAX_RESOURCE_BYTES:
                log.warning("compile: skipping %s (over 512 KB)", n)
                continue
            out.append(f"  {_yaml_scalar(n)}: "
                       f"{base64.b64encode(blob).decode('ascii')}")

    css = ""
    ov = dir_path / "overlay.css"
    if ov.is_file():
        css = ov.read_text(encoding="utf-8", errors="replace")
    else:
        css = meta.get("css") or ""
    css = css.rstrip("\n")
    if css.strip():
        out.append("css: |-")
        for line in css.split("\n"):
            out.append(("  " + line) if line else "")
    return "\n".join(out) + "\n"


def decompile_crate(yml_path: Path, root: Path | None = None) -> str:
    """Crate -> ``<name>-<mtime>/`` under root (same never-overwrite rule).
    Returns the directory name; raises ValueError on a crate that cannot
    load (never silently produces a broken working copy from the CLI)."""
    root = skins_root() if root is None else Path(root)
    yml_path = Path(yml_path)
    name = yml_path.stem
    if not NAME_RE.match(name):
        raise ValueError(f"invalid crate name: {name!r}")
    raw = yml_path.read_bytes()
    _dir, warns, err = extract_crate(root, name, raw, _crate_mtime_int(yml_path))
    if err:
        raise ValueError(err)
    for w in warns:
        log.warning("decompile: %s", w)
    return f"{name}-{_crate_mtime_int(yml_path)}"


# ---------------------------------------------------------------------------
# Route glue (router.py imports these)
# ---------------------------------------------------------------------------

def skin_state(sel: str, root: Path | None = None):
    """Resolve a picker selection at request time; returns (root, entry) or
    (root, None). Extraction happens here too so a freshly dropped crate is
    servable without a separate list call."""
    root = skins_root() if root is None else Path(root)
    entries = list_skins(root)
    return root, resolve_sel(entries, sel)
