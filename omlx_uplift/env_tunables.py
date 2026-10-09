"""ENV-1/ENV-4: uplift-owned experimental environment tunables.

Vanilla omlx reads a large set of engine/scheduler/kernel knobs from
os.environ with no settings.json entry. Uplift documents every one of them
in :data:`CATALOG` and lets the DEV instance edit any knob that vanilla does
not own or alias — see :func:`editable_names`. Values persist uplift-side in
``<base>/uplift/env.json`` (next to metrics.sqlite3; ``<base>`` is the
per-instance data dir, so omlx-dev keeps its own file at
``~/.omlx-dev/uplift/env.json``). At interpreter startup ``autopatch`` seeds
them into ``os.environ`` before any omlx module reads them.

DEV-ONLY (ENV-4): seeding and editing apply to the omlx-dev keg only. The
vanilla ``omlx`` service runs the same code with the surface locked: the
routes refuse writes and the startup hook seeds nothing. Rationale — these
are unvalidated engine switches, and a wrong value must not be able to break
the server that answers real traffic. :func:`is_dev_runtime` is the single
gate, shared by the hook and the routes.

Precedence (the core rule):
  * A genuine launch-time environment variable (launchd plist, shell, CLI)
    ALWAYS wins. autopatch records such names in ``SHADOWED`` and never
    overwrites them.
  * Uplift-stored values fill only the gaps.
  * ``"enabled": false`` in the store disables seeding ENTIRELY (the
    ``omlx-uplift env disable-all`` switch). It is persisted, not runtime
    only, because a runtime-only switch would be silently undone by the
    next boot's seed.

This module must stay import-safe at interpreter startup: stdlib only,
no omlx imports. The autopatch hook sets SHADOWED via :func:`mark_shadowed`
and stores the directory hint via :func:`set_base_dir`.

Effect classes (verified against vanilla read-points 2026-09-19, re-checked
against HEAD 2026-09-20, types re-derived by AST over the omlx tree for
ENV-4):
  immediate -> read per call (os.environ at call time): live apply works.
  model     -> EngineConfig default_factory at engine construction: RESTART MODEL.
  server    -> module-import constants / startup config: RESTART SERVER.
NOT editable (flagged ``managed`` in CATALOG, and the reason, verified against
vanilla):
  OMLX_DECODE_BURST_BUDGET_SINGLE_S — vanilla burst_decode_env() writes the
      same var on EVERY burst-mode save (omlx/settings.py:185) AND at every
      CLI start (omlx/cli.py:259): last-writer-wins collision.
  OMLX_DECODE_BURST_MAX_STEPS — same writer as above; it holds this var too.
      ENV-4 fix: it was in ALLOWED while its partner was excluded.
  OMLX_CONTINUOUS_BATCHING — ENV-4 fix: this row contradicted itself, sitting
      in ALLOWED *and* flagged managed. ``managed`` is correct, and worse: its
      only read site is omlx/config.py:266 inside OMLXConfig.from_env(), and
      nothing in the omlx package ever constructs OMLXConfig — the value is
      inert. Flagged ``dead`` so the UI says so instead of offering a knob
      that cannot do anything.
  OMLX_MODEL — same dead read site (omlx/config.py:218), now flagged ``dead``.
  OMLX_MAX_NUM_SEQS — settings.py treats it as the env fallback for the
      already-exposed max_concurrent_requests; two fields would fight.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

#: ENV-4: the store file the user asked for. ``env_overrides.json`` was the
#: ENV-1 name; it is still READ when env.json is absent (adopt, never fork)
#: so a machine that already stored a value keeps it.
OVERRIDES_FILENAME = "env.json"
LEGACY_OVERRIDES_FILENAME = "env_overrides.json"

# name -> hand-verified extras for the tunables that predate ENV-4. `type`
# and the stock default now come from TYPES/CATALOG (single source), so only
# the readable label and the numeric range live here. Keys must ALWAYS be
# editable names: test_no_manual_spec_conflicts_with_catalog asserts it, which
# is the guard that would have caught OMLX_CONTINUOUS_BATCHING sitting in
# ALLOWED and flagged managed at the same time.
MANUAL: dict[str, dict] = {
    "OMLX_CHUNK_SNAP": {"label": "Chunk quantization"},
    "OMLX_MTP_PROMPT_PRIMING": {"label": "MTP prompt priming"},
    "OMLX_MTP_PRIME_WINDOW": {"label": "MTP priming window", "min": 0},
    "OMLX_DISABLE_PRESSURE_RECLAIM": {"label": "Disable pressure reclaim"},
    "OMLX_DECODE_BURST_BUDGET_S": {"label": "Burst decode budget (s)",
                                   "min": 0.001, "max": 10.0},
    "OMLX_DECODE_FAIR_SHARE": {"label": "Decode fair share",
                               "min": 0.0, "max": 1.0},
    # vanilla casts this one with float() (omlx/scheduler.py:1535); ENV-1
    # declared it int, so a 12.5 ms target was rejected by our own validator.
    "OMLX_DECODE_STALL_TARGET_MS": {"label": "Decode stall target (ms)",
                                    "type": "float", "min": 1},
    "OMLX_CONTENDED_PREFILL_CHUNK": {"label": "Contended prefill chunk",
                                     "min": 16},
}

# readable labels for the knobs that join an inline settings section (their
# group is one of the envRows() sections), so the form never shows a raw var
# name where classic shows prose. Same slot as MANUAL's label.
MANUAL.update({
    "OMLX_DISABLE_PREFILL_BACKPRESSURE": {"label": "Disable prefill backpressure"},
    "OMLX_EMBEDDING_COMPILE": {"label": "Compile embedding models"},
    "OMLX_INKLING_MTP_PRIME_WINDOW": {"label": "Inkling MTP priming window", "min": 0},
    "OMLX_INKLING_MTP_FINAL_NORM": {"label": "Inkling MTP final norm route"},
    "OMLX_MTP_ROW_EXACT_VERIFY": {"label": "MTP row-exact verify"},
    "OMLX_GLM53_KDA_PREFILL_FUSED": {"label": "GLM-5.3 KDA fused prefill"},
})


# ---------------------------------------------------------------------------
# DEV-only gate (ENV-4)
# ---------------------------------------------------------------------------

#: the same ladder routers/apiinfo.py /identity uses: '/omlx-dev/' appears in
#: sys.prefix/sys.executable exactly when the omlx-dev formula's keg serves.
_dev_cache: bool | None = None


def is_dev_runtime() -> bool:
    """True when THIS process is served by the omlx-dev keg.

    Stdlib-only and cheap: computed once per process and cached, because the
    answer cannot change under a running interpreter and the routes call it
    on every request. The ladder lives in paths.is_dev_prefix so /identity
    and this gate can never disagree; the lazy import keeps this module
    import-safe at interpreter startup (the autopatch hook runs from a .pth).
    """
    global _dev_cache
    if _dev_cache is None:
        try:
            import sys

            from . import paths

            _dev_cache = paths.is_dev_prefix(sys.prefix, sys.executable)
        except Exception:
            _dev_cache = False
    return _dev_cache


def set_dev_runtime(flag: bool | None) -> None:
    """Test seam (and a future override hook): None restores auto-detect."""
    global _dev_cache
    _dev_cache = flag


# ---------------------------------------------------------------------------
# Shadow state (set once by autopatch at interpreter startup)
# ---------------------------------------------------------------------------

#: names that were ALREADY present in os.environ at startup (genuine launch
#: env). Their uplift-stored values are inert until the launch env changes.
SHADOWED: set[str] = set()


def mark_shadowed(name: str) -> None:
    SHADOWED.add(name)


def shadowed() -> list[str]:
    return sorted(SHADOWED)


# ---------------------------------------------------------------------------
# On-disk store: plain JSON, atomic writes, stdlib only
# ---------------------------------------------------------------------------
#
# ENV-4 document shape (``env.json``)::
#
#     {"enabled": true, "vars": {"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "..."}}}
#
# ``enabled`` is the master seeding switch the CLI writes
# (`omlx-uplift env disable-all`); it lives in the file, not in memory, so a
# disable survives the very restart that would otherwise re-seed everything.
# ``vars`` is namespaced so a variable can never collide with a document key.
# The ENV-1 file (``env_overrides.json``, a bare {VAR: {...}} map) is still
# READ when env.json does not exist, so an existing override is adopted rather
# than forked.

_BASE_DIR: Path | None = None

#: document keys: the master seeding switch, and the namespace holding the
#: overrides (namespaced so a variable can never collide with a document key)
DOC_ENABLED_KEY = "enabled"
DOC_VARS_KEY = "vars"


def set_base_dir(path) -> None:
    """Record the ~/.omlx/uplift dir discovered by autopatch (it cannot
    import omlx to resolve the base path itself)."""
    global _BASE_DIR
    if path is not None:
        _BASE_DIR = Path(path)


def overrides_path() -> Path:
    if _BASE_DIR is not None:
        return _BASE_DIR / OVERRIDES_FILENAME
    # PATHS-1: same family-A ladder as store.default_db_path, via the
    # shared helper (lazy import keeps this module stdlib-only at import
    # time — the autopatch hook needs that guarantee).
    from . import paths as _paths

    return _paths.server_base_dir() / "uplift" / OVERRIDES_FILENAME


def _legacy_path(path: Path) -> Path:
    return path.parent / LEGACY_OVERRIDES_FILENAME


def load_doc(path: Path | None = None) -> dict:
    """Read the whole store document. Missing/corrupt -> the default document.
    A legacy flat ENV-1 file is adopted into the {enabled, vars} shape."""
    p = path or overrides_path()
    default = {DOC_ENABLED_KEY: True, DOC_VARS_KEY: {}}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        if not p.exists():
            try:  # ENV-1 adoption: the old file name, flat map
                raw = json.loads(_legacy_path(p).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return default
        else:
            return default
    if not isinstance(raw, dict):
        return default
    if DOC_VARS_KEY in raw and isinstance(raw[DOC_VARS_KEY], dict):
        return {DOC_ENABLED_KEY: bool(raw.get(DOC_ENABLED_KEY, True)),
                DOC_VARS_KEY: _vars_only(raw[DOC_VARS_KEY])}
    return {DOC_ENABLED_KEY: bool(raw.get(DOC_ENABLED_KEY, True)),
            DOC_VARS_KEY: _vars_only(raw)}


def _vars_only(mapping: dict) -> dict[str, dict]:
    out = {}
    for k, v in mapping.items():
        if k in ALLOWED and isinstance(v, dict) and isinstance(v.get("value"), str):
            out[k] = {"value": v["value"], "set_at": str(v.get("set_at", ""))}
    return out


def load_overrides(path: Path | None = None) -> dict[str, dict]:
    """The {VAR: {"value", "set_at"}} map, dropping a name that is no longer
    editable (renamed/revanilla'd knobs cannot be seeded back to life)."""
    return load_doc(path)[DOC_VARS_KEY]


def seeding_enabled(path: Path | None = None) -> bool:
    return load_doc(path)[DOC_ENABLED_KEY]


def save_overrides(data: dict[str, dict], path: Path | None = None,
                   enabled: bool | None = None) -> Path:
    """Persist atomically (tmp + rename in the same dir). Parent dirs created.
    `enabled=None` keeps the flag currently on disk — a value edit must never
    silently re-arm seeding after `env disable-all`."""
    p = path or overrides_path()
    doc_enabled = seeding_enabled(p) if enabled is None else bool(enabled)
    doc = {DOC_ENABLED_KEY: doc_enabled, DOC_VARS_KEY: _vars_only(data)}
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".env.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p


def set_seeding_enabled(flag: bool, path: Path | None = None) -> Path:
    """The CLI's disable-all / enable-all switch."""
    p = path or overrides_path()
    return save_overrides(load_overrides(p), p, enabled=bool(flag))


# ---------------------------------------------------------------------------
# Validation + coercion
# ---------------------------------------------------------------------------

#: the words the UI's On/Off control may produce, per truthy spelling
_TRUE_WORDS = {"1", "true", "yes", "on"}
_FALSE_WORDS = {"0", "false", "no", "off"}


def truthy_word(name: str) -> str:
    """"true" when vanilla compares the flag against the WORD true, else "1".
    Writing the wrong on-value is the silent kind of broken: OMLX_* =1 next to
    a `== "true"` read turns the feature off with no error anywhere."""
    spec = ALLOWED.get(name) or {}
    return spec.get("truthy") or TRUTHY_WORD.get(name, "1")


def coerce(name: str, value) -> str:
    """Validate one value against ALLOWED[name] and return its canonical
    env-string form. Raises ValueError on unknown name/type/range."""
    spec = ALLOWED.get(name)
    if spec is None:
        raise ValueError(f"unknown tunable: {name}")
    t = spec["type"]
    if isinstance(value, bool):
        s = "1" if value else "0"
    elif value is None:
        raise ValueError("value required")
    else:
        s = str(value).strip()
    if t == "bool":
        on, off = truthy_word(name), ("false" if truthy_word(name) == "true" else "0")
        if s.lower() in _TRUE_WORDS:
            return on
        if s.lower() in _FALSE_WORDS:
            return off
        if s == "":
            return ""  # store-side: means "no override" but keep shape stable
        raise ValueError(f"{name}: expected a boolean")
    if t == "int":
        try:
            n = int(s)
        except ValueError:
            raise ValueError(f"{name}: expected an integer") from None
    elif t == "float":
        try:
            n = float(s)
        except ValueError:
            raise ValueError(f"{name}: expected a number") from None
    else:
        return s
    if "min" in spec and n < spec["min"]:
        raise ValueError(f"{name}: minimum is {spec['min']}")
    if "max" in spec and n > spec["max"]:
        raise ValueError(f"{name}: maximum is {spec['max']}")
    return s


def seed_environ(path: Path | None = None) -> dict[str, str]:
    """Apply the precedence rule once at interpreter startup (autopatch).

    ENV-4: dev-only. On the vanilla `omlx` keg nothing is seeded and nothing
    is recorded as shadowed — the stored file simply does not participate, so
    the production server's environment stays exactly as it was launched.

    For every stored override on omlx-dev: if the name is already in
    os.environ it is genuine launch env -> record as SHADOWED and leave
    untouched; otherwise write it into os.environ. Returns the vars actually
    seeded.

    Pure stdlib; missing/corrupt file is silently skipped. Never raises.
    """
    seeded: dict[str, str] = {}
    if not is_dev_runtime():
        return seeded
    try:
        doc = load_doc(path)
    except Exception:  # belt and braces: startup hook must never crash omlx
        return seeded
    if not doc[DOC_ENABLED_KEY]:
        return seeded  # `omlx-uplift env disable-all` is in force
    for name, entry in doc[DOC_VARS_KEY].items():
        if name in os.environ:
            mark_shadowed(name)
            continue
        os.environ[name] = entry["value"]
        seeded[name] = entry["value"]
    return seeded


def mask(value: str) -> str:
    """First/last 2 chars only — env values can hold secrets."""
    if len(value) <= 4:
        return "•" * len(value)
    return value[:2] + "•" * (len(value) - 4) + value[-2:]


def snapshot() -> dict:
    """GET payload: current values (stored, or live env when shadowed),
    shadow list, and the allow-list spec for the UI. ENV-4 adds `dev` and
    `seeding_enabled` so the UI never has to guess whether it may edit."""
    doc = load_doc()
    stored = doc[DOC_VARS_KEY]
    dev = is_dev_runtime()
    values = {}
    for name in ALLOWED:
        if name in stored:
            values[name] = stored[name]["value"]
    shadow = [
        {"name": n, "value_masked": mask(os.environ.get(n, ""))}
        for n in sorted(SHADOWED)
    ]
    allowed = [
        {"name": n, **{k: spec[k] for k in ("label", "type", "default", "effect",
                                            "group", "desc", "truthy") if k in spec},
         **{k: spec[k] for k in ("min", "max") if k in spec}}
        for n, spec in ALLOWED.items()
    ] if dev else []
    return {"dev": dev, "seeding_enabled": doc[DOC_ENABLED_KEY],
            "values": values if dev else {}, "shadowed": shadow, "allowed": allowed}


def dev_store_path() -> Path:
    """ENV-4 CLI helper: the env.json belonging to the DEV instance, resolved
    from dev.json's base_path — NOT from this process's runtime.

    `omlx-uplift env` runs from the uplift CLI keg, so is_dev_runtime() is
    false there and overrides_path() would answer for the wrong instance.
    The CLI is the one place allowed to reach across and manage the dev file.
    Lazy import: this module must stay stdlib-only at interpreter startup.
    """
    from . import devsrc

    cfg = devsrc.load_config() or {}
    base = cfg.get("base_path") or "~/.omlx-dev"
    return Path(os.path.expanduser(base)) / "uplift" / OVERRIDES_FILENAME


# ---------------------------------------------------------------------------
# ENV-3: documentation catalog of env-only engine knobs (read-only surface)
# ---------------------------------------------------------------------------
# Every entry documents one omlx environment variable that has NO
# settings.json field (so neither dashboard exposes it). Fields:
#   desc   what the knob does, from the vanilla read site
#   effect immediate | model | server — same classes as ALLOWED, verified
#          against the read point (module constant -> server; engine or
#          object construction -> model; per-call read -> immediate).
#   group  scheduler | memory | engine | attention | quantization | moe |
#          mtp | prefill | cluster | integrations
#   default stock default when unset ("" = unset means off/auto-detect)
#   type   settable-only: mirrors ALLOWED
#   secret settable-only: mask the live value in UI/log surfaces
#   managed documented, NOT settable here: vanilla writes the same var at
#          runtime (last-writer-wins collision) or it aliases an
#          already-exposed setting.
#   dead   NOT settable: its only read site is omlx/config.py, and nothing
#          constructs OMLXConfig — the value can never have an effect. Kept
#          documented because the name still appears in upstream docs.
# Growing: one CATALOG entry per verified read site; keep the omlx source
# line in sync when upstream renames a knob.
CATALOG: dict[str, dict] = {
    # -- scheduler -----------------------------------------------------------
    "OMLX_CHUNK_SNAP": {"group": "scheduler", "effect": "immediate", "default": "1",
        "desc": "Quantize prefill chunk boundaries to fixed steps; 0 disables (A/B measurement)."},
    "OMLX_DECODE_FAIR_SHARE": {"group": "scheduler", "effect": "server", "default": "0.5",
        "desc": "Decode/prefill GPU-time debt ratio: 1.0 = a 50/50 split between decode and prefill chunks."},
    "OMLX_DECODE_STALL_TARGET_MS": {"group": "scheduler", "effect": "server", "default": "500",
        "desc": "Decode-stall tolerance (ms) used to size contended prefill chunks in time."},
    "OMLX_CONTENDED_PREFILL_CHUNK": {"group": "scheduler", "effect": "server", "default": "512",
        "desc": "Fallback prefill chunk size (tokens) while decode is contended; a cold-start constant."},
    "OMLX_DISABLE_PREFILL_BACKPRESSURE": {"group": "scheduler", "effect": "immediate", "default": "",
        "desc": "1 disables prefill backpressure against the memory-enforcer abort watermark."},
    # -- memory --------------------------------------------------------------
    "OMLX_DISABLE_PRESSURE_RECLAIM": {"group": "memory", "effect": "immediate", "default": "",
        "desc": "1 disables non-destructive memory-pressure reclaim (restores stock eviction behavior)."},
    # -- engine --------------------------------------------------------------
    "OMLX_DECODE_BURST_BUDGET_S": {"group": "engine", "effect": "model", "default": "0.03",
        "desc": "Wall-clock budget (s) per burst-decode pass when several requests are concurrent."},
    "OMLX_DECODE_BURST_BUDGET_SINGLE_S": {"group": "engine", "effect": "model", "default": "0.1",
        "desc": "Wall-clock budget (s) per burst-decode pass for a single active request.",
        "managed": True},
    "OMLX_DECODE_BURST_MAX_STEPS": {"group": "engine", "effect": "model", "default": "64",
        "desc": "Maximum decode steps per burst pass (safety cap, bounds the host-side output list).",
        "managed": True},
    "OMLX_CONTINUOUS_BATCHING": {"group": "engine", "effect": "server", "default": "false",
        "desc": "Documented only: its sole read site is OMLXConfig.from_env(), which no omlx "
               "code path ever constructs.", "managed": True, "dead": True},
    "OMLX_MAX_NUM_SEQS": {"group": "engine", "effect": "server", "default": "",
        "desc": "Engine max batch size override; env fallback of the exposed max_concurrent_requests.",
        "managed": True},
    # -- attention -----------------------------------------------------------
    "OMLX_FAST_ATTENTION": {"group": "attention", "effect": "server", "default": "1",
        "desc": "Kill switch for prefill attention fast paths (blocked sliding window, mixed head-dim); 0 keeps MLX default SDPA everywhere."},
    "OMLX_NAX_JIT_ATTENTION": {"group": "attention", "effect": "server", "default": "1",
        "desc": "JIT-compiled NAX flash-attention with a separate value head dim (MLA-style 192/128 models); 0 keeps the zero-padded route."},
    "OMLX_SDPA256_TILED": {"group": "attention", "effect": "server", "default": "",
        "desc": "Force (1) or disable (0) the memory-bounded head-dim-256 long-context prefill route; unset = automatic."},
    "OMLX_FA256_STEEL": {"group": "attention", "effect": "model", "default": "",
        "desc": "1 forces the pre-NAX steel head-dim-256 attention kernel even on NAX GPUs (benchmarking)."},
    "OMLX_FA256_MIN_KV_LEN": {"group": "attention", "effect": "model", "default": "2048",
        "desc": "Minimum KV length from which the fused head-dim-256 attention patch engages."},
    "OMLX_FA256_Q_BLOCK": {"group": "attention", "effect": "model", "default": "32",
        "desc": "Query tile width of the fused head-dim-256 attention kernel."},
    "OMLX_FA256_K_BLOCK": {"group": "attention", "effect": "model", "default": "8",
        "desc": "Key tile width of the fused head-dim-256 attention kernel."},
    "OMLX_FA256_DISPATCH_BUDGET": {"group": "attention", "effect": "model", "default": "",
        "desc": "Work budget (elements) per attention dispatch before preemption; unset = per-GPU-tier auto."},
    "OMLX_FA256_DEBUG": {"group": "attention", "effect": "model", "default": "0",
        "desc": "1 logs dispatch decisions of the head-dim-256 attention patch."},
    "OMLX_SDPA_FLASH_CHUNK": {"group": "attention", "effect": "immediate", "default": "",
        "desc": "Keys per split for the MiMo-V2 flash-decode kernel; unset = auto (n_keys/128 rounded up to a power of two, in [256, 1024])."},
    "OMLX_SDPA_FLASH_HS": {"group": "attention", "effect": "immediate", "default": "",
        "desc": "Head-split factor for the MiMo-V2 flash-decode kernel; unset = auto."},
    "OMLX_MIMO_DECODE_FAST": {"group": "attention", "effect": "immediate", "default": "",
        "desc": "MiMo-V2 fused fast decode path: on by default on M5 GPUs; 1 forces on, 0 off."},
    "OMLX_MIMO_DECODE_FLASH_MIN_KEYS": {"group": "attention", "effect": "immediate", "default": "",
        "desc": "Key count from which sdpa_flash serves MiMo-V2 decode/verify attention."},
    "OMLX_DSV4_WSDPA": {"group": "attention", "effect": "server", "default": "1",
        "desc": "DeepSeek-V4 windowed SDPA attention route; 0 keeps the stock attention path."},
    "OMLX_DSV4_WSDPA_TOPK": {"group": "attention", "effect": "server", "default": "1",
        "desc": "Top-k selection fusion inside the DeepSeek-V4 windowed SDPA route."},
    "OMLX_GLM_SPARSE_MLA_NAX": {"group": "attention", "effect": "server", "default": "1",
        "desc": "Tensor-unit (NAX) sparse-MLA kernels for GLM DSA models; off keeps the stock route."},
    "OMLX_GLM_HC_PREFILL": {"group": "attention", "effect": "server", "default": "1",
        "desc": "GLM-5 hybrid-cache prefill kernel; 0/off disables. Upstream drops the read "
                "site in 543c8f4 (2026-10-08) — still live on kegs built before it."},
    "OMLX_INKLING_SLIDING_SLICE": {"group": "attention", "effect": "server", "default": "1",
        "desc": "Compute-only sliding-window slicing for Inkling models (skips masked score columns)."},
    "OMLX_QWEN4_STEP_TEXT_POSITIONS": {"group": "attention", "effect": "server", "default": "1",
        "desc": "0 keeps Qwen4 decode/verify steps on rank-three mRoPE positions (gathered-QSA arms then stay off those rows)."},
    "OMLX_QWEN4_STEP_TEXT_POSITIONS_MIN_CONTEXT": {"group": "attention", "effect": "server", "default": "32768",
        "desc": "Cached-token threshold below which Qwen4 decode/verify rows keep rank-three positions (dense path)."},
    "OMLX_QWEN4_QSA_NAX": {"group": "attention", "effect": "immediate", "default": "1",
        "desc": "Qwen4 gathered sparse-attention (QSA) on NAX tensor units."},
    "OMLX_QWEN4_QSA_NAX_PV": {"group": "attention", "effect": "server", "default": "half2",
        "desc": "How P enters the QSA P@V tensor-unit MMA: half2 (default, high accuracy), or a faster/looser variant."},
    "OMLX_QWEN4_QSA_DECODE_SDPA": {"group": "attention", "effect": "server", "default": "1",
        "desc": "0 keeps mx.fast.scaled_dot_product_attention for QSA decode instead of the fused kernel."},
    "OMLX_QWEN4_QSA_DECODE_SELECT": {"group": "attention", "effect": "server", "default": "1",
        "desc": "0 keeps the MLX maximum/argsort ops for QSA decode selection instead of the fused partition kernel."},
    # ENV-4 fix: these two were documented as OMLX_MINIMAX_*, but the vendored
    # mlx_vlm msa.py reads MLX_MINIMAX_* — the catalog names matched no read
    # site at all, so they could never show as SET and a value set here would
    # have done nothing.
    "MLX_MINIMAX_MSA_NATIVE_TOPK": {"group": "attention", "effect": "server", "default": "auto",
        "desc": "Minimax M3 sparse-attention top-k route: auto | native kernel | fallback."},
    "MLX_MINIMAX_MSA_NATIVE_TOPK_SELECT": {"group": "attention", "effect": "server", "default": "auto",
        "desc": "Minimax M3 sparse-attention top-k selection route: auto | native kernel | fallback."},
    "OMLX_GDN_BLOCK_T": {"group": "attention", "effect": "immediate", "default": "",
        "desc": "Token block size for the Gated-DeltaNet prefill kernel (one of the supported values; invalid value raises)."},
    "OMLX_GLM_DSA_INDEXER_NAX": {"group": "attention", "effect": "server", "default": "1",
        "desc": "Tensor-unit (NAX) DSA indexer scores for GLM-5.3 prefill; 0 keeps the native SIMD kernel."},
    # -- prefill kernels -----------------------------------------------------
    "OMLX_GDN_KERNEL": {"group": "prefill", "effect": "model", "default": "1",
        "desc": "Qwen3.5/3.6 Gated-DeltaNet optimized Metal prefill patch: 0 disables, keeps stock recurrence."},
    "OMLX_GDN_IMPL": {"group": "prefill", "effect": "model", "default": "pipelined",
        "desc": "GDN prefill kernel route: pipelined (default) | blocked_seq | chunked (A/B)."},
    "OMLX_GDN_MIN_T": {"group": "prefill", "effect": "model", "default": "64",
        "desc": "Minimum sequence length for the GDN prefill patch to engage (T must be >= this)."},
    "OMLX_GDN_STUB": {"group": "prefill", "effect": "model", "default": "0",
        "desc": "1 replaces the GDN prefill kernel with a pass-through stub (measurement harness)."},
    "OMLX_GDN_FUSED_G_BETA": {"group": "prefill", "effect": "model", "default": "0",
        "desc": "1 fuses the gate/beta preparation into the chunked GDN kernel."},
    "OMLX_QWEN4_GDN_PREFILL_FUSED": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Fused Qwen4 GDN prefill route (port to GLM-5.3-Flash as well); 0 keeps the unfused stock path."},
    "OMLX_QWEN4_GDN_DECODE_PLAN": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Resolve decode eligibility/operands once per layer; 0 re-derives them per call."},
    "OMLX_QWEN4_GDN_DECODE_STEP_FUSED": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Run prework, recurrence and norm-gate as one launch on the planned decode; 0 keeps three launches."},
    "OMLX_QWEN4_GDN_DECODE_QMV": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Fuse the in-/out-projections as one-row QMV on the planned GDN decode."},
    "OMLX_QWEN4_GDN_VERIFY_FUSED": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Fused speculative-verify forward for Qwen4 GDN (one launch per row set)."},
    "OMLX_QWEN4_GDN_VERIFY_TILES": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Per-row-count unrolled tiles for the fused GDN verify path; 0 keeps the rolled first geometry."},
    "OMLX_QWEN4_GDN_VERIFY_DEFERRED_STATES": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Skip writing per-step recurrent states into verify rollback records (read only on partial accept)."},
    "OMLX_GLM53_KDA_PREFILL_FUSED": {"group": "prefill", "effect": "server", "default": "1",
        "desc": "Fused KDA (Kimi delta attention) prefill for GLM-5.3; 0 keeps the stock recurrence."},
    "OMLX_GLM53_KDA_RECURRENCE": {"group": "prefill", "effect": "server", "default": "percore",
        "desc": "KDA recurrence kernel selection for GLM-5.3 (percore vs blocked)."},
    "OMLX_QWEN4_PLE_MODE": {"group": "prefill", "effect": "immediate", "default": "",
        "desc": "Qwen4 PLE storage mode: auto | resident | mmap (bound at model construction)."},
    "OMLX_QWEN4_EAGER_DISPATCH_EVERY": {"group": "prefill", "effect": "immediate", "default": "",
        "desc": "Qwen4 eager dispatch cadence: 1 commits every layer, N every N-th; unset = lazy."},
    "OMLX_QWEN4_GATHERED_MIN_QUERY": {"group": "prefill", "effect": "immediate", "default": "",
        "desc": "Minimum query tokens before Qwen4 takes the gathered-QSA attention route."},
    # -- quantized-matmul dispatch -------------------------------------------
    "OMLX_NAX": {"group": "quantization", "effect": "immediate", "default": "",
        "desc": "Force (1) or disable (0) the NAX tensor-unit route; unset = auto-detect on M5 GPUs."},
    "OMLX_QWEN35_QMM_NAX": {"group": "quantization", "effect": "immediate", "default": "",
        "desc": "Force (1) or disable (0) NAX quantized-QMM dispatch in the Qwen3.5 prefill extension."},
    "OMLX_QWEN35_QMM_NAX_VARIANT": {"group": "quantization", "effect": "immediate", "default": "0",
        "desc": "Select a bundled NAX QMM tile variant (0 = auto; 3: bn 128, 4: bk 32, 5: wm4 wn1)."},
    "OMLX_M5_GATHER_QMM_FIX": {"group": "quantization", "effect": "model", "default": "1",
        "desc": "Reroute sorted MoE gather-QMM around the defective M5 NAX kernels (issue #2267); 0 keeps native."},
    "OMLX_M5_GATHER_QMM_NATIVE": {"group": "quantization", "effect": "model", "default": "1",
        "desc": "Use the native gather-QMM on M5 once the mlx fix is detected; 0 forces the workaround."},
    "OMLX_QWEN35_Q4_MLP": {"group": "quantization", "effect": "model", "default": "1",
        "desc": "Q4 QMM prefill route for Qwen3.5 MLP blocks; 0 keeps stock matmuls."},
    "OMLX_QWEN35_Q4_MLP_MIN_TOKENS": {"group": "quantization", "effect": "model", "default": "2048",
        "desc": "Minimum prefill tokens before the Q4 MLP QMM route engages."},
    "OMLX_QWEN35_Q4_MLP_VARIANT": {"group": "quantization", "effect": "model", "default": "8",
        "desc": "Kernel tile variant for the Q4 MLP QMM route."},
    "OMLX_QWEN35_Q4_MLP_ALLOW_GS128": {"group": "quantization", "effect": "immediate", "default": "",
        "desc": "1 also routes group-size-128 Q4 linears through the Q4 MLP prefill patch."},
    "OMLX_QWEN35_Q4_LM_LINEAR": {"group": "quantization", "effect": "model", "default": "1",
        "desc": "lm_head Q4 prefill linear patch for mlx-lm models; 0 disables."},
    "OMLX_QWEN35_Q4_LINEAR": {"group": "quantization", "effect": "model", "default": "1",
        "desc": "Q4 prefill linear route (attention/GDN projections) for Qwen3.5; 0 disables."},
    "OMLX_QWEN35_Q4_LINEAR_MIN_TOKENS": {"group": "quantization", "effect": "model", "default": "2048",
        "desc": "Minimum prefill tokens before the Q4 linear route engages."},
    "OMLX_QWEN35_Q4_LINEAR_VARIANT": {"group": "quantization", "effect": "model", "default": "8",
        "desc": "Kernel tile variant for the Q4 linear route."},
    "OMLX_QWEN35_Q8_MLP_MIN_TOKENS": {"group": "quantization", "effect": "model", "default": "16384",
        "desc": "Minimum prefill tokens before the Q8 MLP linear route engages."},
    "OMLX_QWEN35_Q8_LINEAR_MIN_TOKENS": {"group": "quantization", "effect": "immediate", "default": "16384",
        "desc": "Minimum tokens before Q8 linear layers take the fast prefill route."},
    "OMLX_OQ_A8": {"group": "quantization", "effect": "model", "default": "",
        "desc": "oQ mixed-bit QxA8 activation mode on M5 tensor units: 1 enables for models flagged per settings (qwen35_oq_a8_enabled). Upstream drops the read sites in 5a26a09 (2026-10-08; the setting becomes the sole switch) — still live on kegs built before it."},
    "OMLX_OQ_A8_VARIANT": {"group": "quantization", "effect": "server", "default": "0",
        "desc": "Select the QxA8 kernel variant in the Qwen3.5 prefill extension (0 = auto). Upstream drops the read site in 5a26a09 (2026-10-08) — still live on kegs built before it."},
    "OMLX_OQ_A8_ACT_MODE": {"group": "quantization", "effect": "server", "default": "0",
        "desc": "QxA8 activation handling mode in the Qwen3.5 prefill extension. Upstream drops the read site in 5a26a09 (2026-10-08) — still live on kegs built before it."},
    "OMLX_OQ_STREAM_CALIBRATION": {"group": "quantization", "effect": "immediate", "default": "",
        "desc": "Force oQe calibration to stream layers from the checkpoint (1) or keep the RAM-safe proxy (0)."},
    "MLX_ENABLE_TF32": {"group": "quantization", "effect": "immediate", "default": "1",
        "desc": "MLX global: relaxed (TF32) fp32 matmuls on NAX. 0 also disables kernels that assume that product."},
    # -- MoE -----------------------------------------------------------------
    "OMLX_MOE_EXPERT_OFFLOAD": {"group": "moe", "effect": "model", "default": "1",
        "desc": "Offload hot MoE experts (SSD/RAM tiers) for DeepSeek-V4/GLM DSA and stock SwitchGLU models; 0 disables."},
    "OMLX_MOE_OFFLOAD_OVERLAP": {"group": "moe", "effect": "model", "default": "1",
        "desc": "Overlap expert fetch with decode compute; 0 keeps the serial path."},
    "OMLX_MOE_GATE_UP_FUSION": {"group": "moe", "effect": "model", "default": "1",
        "desc": "Fused gate/up expert matmuls for supported MoE families; applied at model load."},
    "OMLX_DEEPSEEK_SORT_MIN_ROUTES": {"group": "moe", "effect": "server", "default": "32",
        "desc": "Route count from which DeepSeek MoE uses the sorted gather path."},
    "OMLX_DEEPSEEK_MOE_NAX": {"group": "moe", "effect": "server", "default": "",
        "desc": "Force (1) or disable (0) NAX gather-QMM kernels for DeepSeek MoE prefill; unset = auto."},
    "OMLX_DEEPSEEK_MOE_NAX_MIN_ROUTES": {"group": "moe", "effect": "server", "default": "1024",
        "desc": "Route count from which the NAX gather kernels are preferred for DeepSeek MoE."},
    "OMLX_DEEPSEEK_AFFINE_BLOCK_MIN_ROUTES": {"group": "moe", "effect": "server", "default": "1024",
        "desc": "Route-count crossover for affine 2/3-bit g64 DeepSeek MoE dispatch (measured on M1 Ultra)."},
    "OMLX_DEEPSEEK_MXFP4_LARGE_BLOCK_MIN_ROUTES": {"group": "moe", "effect": "server", "default": "16384",
        "desc": "Route-count crossover for mxfp4 large-block DeepSeek MoE dispatch (8192 restores pre-M3 behavior)."},
    "OMLX_QWEN35_MOE_GATE_UP": {"group": "moe", "effect": "model", "default": "1",
        "desc": "Fused gate/up expert operands for Qwen3.5 MoE; applied when the engine loads the model."},
    "OMLX_QWEN35_MOE_DECODE_PLAN": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Resolve fused decode operands once per SwitchGLU; 0 resolves them per call."},
    "OMLX_QWEN35_MOE_ROUTER_GEMV": {"group": "moe", "effect": "server", "default": "1",
        "desc": "GEMV route for the Qwen3.5 MoE router on one-row decode; 0 keeps the composed chain."},
    "OMLX_QWEN35_MOE_ROUTER_SOFTMAX_FOLD": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Fold the softmax reduction into the fused router top-k kernel."},
    "OMLX_QWEN35_MOE_COMBINE_FUSED": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Fuse the MoE combine (weighted sum + shared gate) into one launch; 0 keeps the composed ops."},
    "OMLX_QWEN35_MOE_ROUTED_DECODE": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Routed-expert fast decode path for Qwen3.5 MoE."},
    "OMLX_QWEN35_MOE_ROUTED_DECODE_VIEWS": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Zero-copy views inside the Qwen3.5 MoE routed-decode path."},
    "OMLX_QWEN35_MOE_SHARED_FOLD": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Fold the shared-expert contribution into the routed combine in Qwen3.5 MoE decode."},
    "OMLX_QWEN35_MOE_TOPK_FOLD": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Fold top-k renormalization into the Qwen3.5 MoE decode combine."},
    "OMLX_QWEN35_MOE_VERIFY_WINDOW": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Use the routed-decode fast path for speculative-verify widths on Qwen3.5 MoE."},
    "OMLX_QWEN35_MOE_WEIGHTED_SUM": {"group": "moe", "effect": "model", "default": "1",
        "desc": "Fused weighted-sum of expert outputs for Qwen3.5 MoE; 0 keeps the composed route (issue #2132)."},
    "OMLX_QWEN35_MOE_WEIGHTED_SUM_MIN_TOKENS": {"group": "moe", "effect": "model", "default": "1024",
        "desc": "Minimum tokens before the fused Qwen3.5 MoE weighted-sum route engages."},
    "OMLX_LAGUNA_COMPILED_FUSIONS": {"group": "moe", "effect": "server", "default": "1",
        "desc": "Compiled shapeless fusions in the Laguna model; 0 keeps eager ops."},
    "OMLX_LAGUNA_FUSED_ROUTED_GATE_UP": {"group": "moe", "effect": "server", "default": "0",
        "desc": "Serve Laguna single-token decode gate/up from one gather-QMM (bit-exact); off by default."},
    "OMLX_LAGUNA_FUSED_SHARED_GATE_UP": {"group": "moe", "effect": "server", "default": "0",
        "desc": "Laguna shared-expert gate/up as one NVFP4 matmul over a row-concatenated bank; off by default."},
    # -- MTP / speculative ---------------------------------------------------
    "OMLX_MTP_PROMPT_PRIMING": {"group": "mtp", "effect": "immediate", "default": "1",
        "desc": "Prime MTP drafters from the prompt context."},
    "OMLX_MTP_PRIME_WINDOW": {"group": "mtp", "effect": "immediate", "default": "0",
        "desc": "History window (tokens) MTP priming may use; 0 = unlimited."},
    "OMLX_MTP_ROW_EXACT_VERIFY": {"group": "mtp", "effect": "server", "default": "1",
        "desc": "Row-exact MTP verification; 0 keeps the batched verify route."},
    "OMLX_INKLING_MTP_PRIME_WINDOW": {"group": "mtp", "effect": "immediate", "default": "1024",
        "desc": "History window (tokens) for Inkling VLM MTP prompt priming."},
    "OMLX_INKLING_MTP_FINAL_NORM": {"group": "mtp", "effect": "immediate", "default": "none",
        "desc": "Inkling MTP final-norm route: none | trunk."},
    # -- ANE prefill -----------------------------------------------------------
    "OMLX_QWEN35_ANE_PREFILL": {"group": "prefill", "effect": "model", "default": "",
        "desc": "ANE/GPU hybrid prefill for dense Qwen3.5/3.6/3.8 MLPs: 0 disables; unset = auto when hardware and extension allow."},
    "OMLX_QWEN35_ANE_BANK_MAX_BYTES": {"group": "prefill", "effect": "model", "default": "",
        "desc": "Cap (bytes) per ANE weight bank; unset = device-specific ladder."},
    "OMLX_QWEN35_ANE_DOWN_LAYER_STRIDE": {"group": "prefill", "effect": "model", "default": "1",
        "desc": "Layer stride for the ANE down-projection combined bank (compile fewer programs)."},
    "OMLX_QWEN35_ANE_DOWN_COMBINED_BANK": {"group": "prefill", "effect": "model", "default": "",
        "desc": "1 packs down-projection weights into one combined ANE bank."},
    # -- cluster ---------------------------------------------------------------
    "MLX_JACCL_COORDINATOR": {"group": "cluster", "effect": "immediate", "default": "",
        "desc": "Coordinator endpoint for JaCL distributed workers (set by the cluster launcher)."},
    "MLX_JACCL_RING": {"group": "cluster", "effect": "immediate", "default": "",
        "desc": "1 selects the ring collectives route for JaCL workers."},
    "MLX_IBV_DEVICES": {"group": "cluster", "effect": "immediate", "default": "",
        "desc": "Comma list of InfiniBand devices for MLX cluster workers."},
    "MLX_RANK": {"group": "cluster", "effect": "immediate", "default": "-1",
        "desc": "This worker's rank inside the cluster (set by the launcher)."},
    "OMLX_CLUSTER_CONTROL_TRANSPORT": {"group": "cluster", "effect": "immediate", "default": "auto",
        "desc": "Cluster control-plane transport: auto | unix | tcp."},
    "OMLX_CLUSTER_CONTROL_PROXY_PYTHON": {"group": "cluster", "effect": "immediate", "default": "/usr/bin/python3",
        "desc": "Interpreter used by the system-socket control proxy helper."},
    "OMLX_CLUSTER_STATE_DIR": {"group": "cluster", "effect": "immediate", "default": "~/.omlx/cluster/runtime",
        "desc": "Runtime state directory for cluster workers and probes."},
    "OMLX_CLUSTER_LAUNCHER_LEASE": {"group": "cluster", "effect": "immediate", "default": "",
        "desc": "Lease file whose staleness also fires the watchdog (covers launcher death)."},
    "OMLX_CLUSTER_PEER_ABORT_GRACE": {"group": "cluster", "effect": "immediate", "default": "5.0",
        "desc": "Seconds to let peer requests abort before the watchdog escalates."},
    "OMLX_CLUSTER_SIGNAL_CLEAR_TIMEOUT": {"group": "cluster", "effect": "immediate", "default": "10",
        "desc": "Seconds to wait for a wedged rank to clear signals before SIGKILL."},
    "OMLX_CLUSTER_SSH_HOST_PUBLIC_KEY": {"group": "cluster", "effect": "immediate", "default": "", "secret": True,
        "desc": "Override the SSH host public key used when pairing cluster peers."},
    "OMLX_JACCL_PYTHON_SIDE_CHANNEL": {"group": "cluster", "effect": "immediate", "default": "1",
        "desc": "0 disables the Python control side-channel next to JaCL."},
    "OMLX_JACCL_SIDE_CHANNEL_TRANSPORT": {"group": "cluster", "effect": "immediate", "default": "auto",
        "desc": "Side-channel transport: auto | direct | sidecar."},
    "OMLX_JACCL_SIDE_CHANNEL_PYTHON": {"group": "cluster", "effect": "immediate", "default": "/usr/bin/python3",
        "desc": "Interpreter for the side-channel sidecar process."},
    "OMLX_JACCL_SIDE_CHANNEL_TRACE": {"group": "cluster", "effect": "immediate", "default": "0",
        "desc": "1 writes a trace of side-channel frames for debugging."},
    "OMLX_DISTRIBUTED_REQUEST_READ_TIMEOUT": {"group": "cluster", "effect": "model", "default": "300.0",
        "desc": "Seconds a distributed engine waits for a peer read before failing the step."},
    "OMLX_TAILSCALE_CLI": {"group": "cluster", "effect": "immediate", "default": "",
        "desc": "Path to the tailscale CLI used for cluster discovery."},
    "OMLX_DISCOVERY": {"group": "cluster", "effect": "server", "default": "1",
        "desc": "0 disables always-on cluster peer discovery (mDNS + multicast + manual + Tailscale)."},
    "OMLX_BONJOUR": {"group": "cluster", "effect": "server", "default": "1",
        "desc": "0 stops advertising this instance over Bonjour for easy pairing."},
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_STEP": {"group": "prefill", "effect": "immediate", "default": "1",
        "desc": "1 enables adaptive prefill step resizing for Minimax M3; other values disable."},
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_STEP_SIZE": {"group": "prefill", "effect": "immediate", "default": "4096",
        "desc": "Adaptive prefill step size (tokens) for Minimax M3."},
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_AFTER": {"group": "prefill", "effect": "immediate", "default": "0",
        "desc": "Token offset after which Minimax M3 starts resizing the prefill step."},
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_MIN_REMAINING": {"group": "prefill", "effect": "immediate", "default": "4096",
        "desc": "Keep at least this many remaining tokens per step in the Minimax M3 adaptive prefill."},
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_STEP": {"group": "prefill", "effect": "immediate", "default": "1",
        "desc": "1 enables adaptive prefill step resizing for GLM DSA (mlx-lm); other values disable."},
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_STEP_SIZE": {"group": "prefill", "effect": "immediate", "default": "8192",
        "desc": "Adaptive prefill step size (tokens) for GLM DSA."},
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_AFTER": {"group": "prefill", "effect": "immediate", "default": "0",
        "desc": "Token offset after which GLM DSA starts resizing the prefill step."},
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_MIN_REMAINING": {"group": "prefill", "effect": "immediate", "default": "0",
        "desc": "Keep at least this many remaining tokens per step in the GLM DSA adaptive prefill."},
    # -- server / integrations --------------------------------------------------
    "OMLX_MODEL": {"group": "engine", "effect": "server", "default": "",
        "desc": "Documented only: read solely by OMLXConfig.from_env(), which no omlx code path "
               "constructs; `omlx serve --model` is the live switch.", "managed": True, "dead": True},
    "OMLX_MAX_IMAGE_BYTES": {"group": "server", "effect": "server", "default": "",
        "desc": "Cap (bytes) per decoded image; CLI/config override.", "managed": True},
    "OMLX_SUPERVISED": {"group": "server", "effect": "immediate", "default": "",
        "desc": "Name of the supervisor that respawns omlx; set it to allow the RESTART SERVER self-kill path (launchd/menubar set this)."},
    "OMLX_SECRET_KEY": {"group": "server", "effect": "server", "default": "",
        "desc": "Key signing admin session cookies; unset = random per boot (sessions die on restart).", "secret": True},
    "OMLX_MCP_CONFIG": {"group": "server", "effect": "server", "default": "",
        "desc": "Path to the MCP config file; env wins over settings.json.", "managed": True},
    "OMLX_BASE_PATH": {"group": "server", "effect": "immediate", "default": "",
        "desc": "Root data directory (settings, models, cluster files).", "managed": True},
    "OMLX_STARTUP_NOTICE_PATH": {"group": "server", "effect": "immediate", "default": "",
        "desc": "File where the CLI writes the startup notice (e.g. bind-address change)."},
    "OMLX_EMBEDDING_COMPILE": {"group": "engine", "effect": "model", "default": "1",
        "desc": "0 disables mx.compile for embedding models (workaround for compile regressions)."},
    "OMLX_DSH_HOME": {"group": "integrations", "effect": "immediate", "default": "",
        "desc": "Override the oh-my-pi dsh home directory."},
    "OMLX_DSH_API": {"group": "integrations", "effect": "immediate", "default": "openai-responses",
        "desc": "Protocol the dsh provider route speaks to oMLX."},
    "PI_CODING_AGENT_DIR": {"group": "integrations", "effect": "immediate", "default": "",
        "desc": "Override the pi coding-agent config directory."},
    "MODELSCOPE_DOMAIN": {"group": "integrations", "effect": "immediate", "default": "",
        "desc": "ModelScope endpoint domain; vanilla writes it on every ms_endpoint save.", "managed": True},
}


# ---------------------------------------------------------------------------
# ENV-4: editable set = everything documented, minus what vanilla owns
# ---------------------------------------------------------------------------
def _is_secretish(name: str) -> bool:
    """Credential-shaped name (the classic masking heuristic)."""
    return name.endswith(("_KEY", "_TOKEN", "_SECRET")) or "PASSWORD" in name


def is_secret(name: str) -> bool:
    """Never editable, and masked in every UI/API surface: a credential-
    shaped name, or one CATALOG marks `secret` explicitly (the cluster SSH
    host key does not end in _KEY but is a key)."""
    return bool(CATALOG.get(name, {}).get("secret")) or _is_secretish(name)


def editable_names() -> list[str]:
    """The ENV-4 editable set: documented, and NOT owned/aliased/dead/secret.

    `managed` is vanilla's own last-writer-wins or settings-alias exclusion;
    `dead` is a knob whose read site no live code path reaches; secrets stay
    out of a form that round-trips values through JSON.
    """
    return [n for n, s in CATALOG.items()
            if not s.get("managed") and not s.get("dead") and not is_secret(n)]


def not_editable_reason(name: str) -> str | None:
    """Why a documented name cannot be set here, or None when it can.

    ONE definition on purpose: the PUT route raises it as HTTP detail and
    `omlx-uplift env set` prints it, and the two must never disagree about
    what a name means.
    """
    if name in ALLOWED:
        return None
    spec = CATALOG.get(name)
    if spec is None:
        return None  # undocumented: callers report 'unknown tunable'
    if spec.get("dead"):
        return "no live oMLX code path reads this variable"
    if spec.get("managed"):
        return "vanilla oMLX owns this variable at runtime"
    if is_secret(name):
        return "a credential; Uplift never edits it"
    return "not editable from Uplift"


def _spec(name: str) -> dict:
    """One tunable spec, assembled from CATALOG + TYPES (+ MANUAL extras).
    The ten pre-ENV-4 tunables keep their hand-verified label/range here."""
    cat = CATALOG[name]
    manual = MANUAL.get(name, {})
    t = manual.get("type") or TYPES.get(name, "str")
    spec = {
        "label": manual.get("label") or name.replace("OMLX_", "").replace("MLX_", "")
                                       .replace("_", " ").title(),
        "type": t,
        "default": cat.get("default", ""),
        "effect": cat.get("effect", "server"),
        "group": cat.get("group", "engine"),
        "desc": cat.get("desc", ""),
    }
    for k in ("min", "max"):
        if k in manual:
            spec[k] = manual[k]
    if name in TRUTHY_WORD:
        spec["truthy"] = TRUTHY_WORD[name]
    return spec



#: How vanilla interprets each documented string AT ITS READ SITE:
#: bool (flag comparison / membership test), int / float (numeric cast),
#: str (used raw). Derived by AST over the omlx tree, then cross-checked
#: against every stock default in CATALOG: all int/float defaults parse as
#: their type and all flag defaults are 0/1/true/false words — zero
#: mismatches over 147 vars. Manual fixes from reading sites the regex
#: pass missed: OMLX_DISTRIBUTED_REQUEST_READ_TIMEOUT (float(raw) two lines
#: after the read), OMLX_DECODE_STALL_TARGET_MS (float; ENV-1 said int),
#: OMLX_FAST_ATTENTION / OMLX_NAX_JIT_ATTENTION / OMLX_EMBEDDING_COMPILE /
#: OMLX_MTP_PROMPT_PRIMING / OMLX_GLM_DSA_INDEXER_NAX (multi-line
#: `not in {…}` falsey sets), OMLX_GLM53_KDA_RECURRENCE (compares a mode
#: WORD: percore|blocked). Re-derive when upstream recasts a knob;
#: tests/test_env_catalog.py pins TYPES against CATALOG.
TYPES: dict[str, str] = {
    # -- bool (77)
    "OMLX_CHUNK_SNAP": "bool",
    "OMLX_DISABLE_PREFILL_BACKPRESSURE": "bool",
    "OMLX_DISABLE_PRESSURE_RECLAIM": "bool",
    "OMLX_CONTINUOUS_BATCHING": "bool",
    "OMLX_MAX_NUM_SEQS": "bool",
    "OMLX_FAST_ATTENTION": "bool",
    "OMLX_NAX_JIT_ATTENTION": "bool",
    "OMLX_SDPA256_TILED": "bool",
    "OMLX_FA256_STEEL": "bool",
    "OMLX_FA256_DISPATCH_BUDGET": "bool",
    "OMLX_FA256_DEBUG": "bool",
    "OMLX_MIMO_DECODE_FAST": "bool",
    "OMLX_DSV4_WSDPA": "bool",
    "OMLX_DSV4_WSDPA_TOPK": "bool",
    "OMLX_GLM_SPARSE_MLA_NAX": "bool",
    "OMLX_INKLING_SLIDING_SLICE": "bool",
    "OMLX_QWEN4_STEP_TEXT_POSITIONS": "bool",
    "OMLX_QWEN4_QSA_NAX": "bool",
    "OMLX_QWEN4_QSA_DECODE_SDPA": "bool",
    "OMLX_QWEN4_QSA_DECODE_SELECT": "bool",
    "OMLX_GDN_BLOCK_T": "bool",
    "OMLX_GLM_DSA_INDEXER_NAX": "bool",
    "OMLX_GDN_KERNEL": "bool",
    "OMLX_GDN_STUB": "bool",
    "OMLX_GDN_FUSED_G_BETA": "bool",
    "OMLX_QWEN4_GDN_PREFILL_FUSED": "bool",
    "OMLX_QWEN4_GDN_DECODE_PLAN": "bool",
    "OMLX_QWEN4_GDN_DECODE_STEP_FUSED": "bool",
    "OMLX_QWEN4_GDN_DECODE_QMV": "bool",
    "OMLX_QWEN4_GDN_VERIFY_FUSED": "bool",
    "OMLX_QWEN4_GDN_VERIFY_TILES": "bool",
    "OMLX_QWEN4_GDN_VERIFY_DEFERRED_STATES": "bool",
    "OMLX_GLM53_KDA_PREFILL_FUSED": "bool",
    "OMLX_NAX": "bool",
    "OMLX_QWEN35_QMM_NAX": "bool",
    "OMLX_M5_GATHER_QMM_FIX": "bool",
    "OMLX_M5_GATHER_QMM_NATIVE": "bool",
    "OMLX_QWEN35_Q4_MLP": "bool",
    "OMLX_QWEN35_Q4_MLP_ALLOW_GS128": "bool",
    "OMLX_QWEN35_Q4_LM_LINEAR": "bool",
    "OMLX_QWEN35_Q4_LINEAR": "bool",
    "OMLX_OQ_A8": "bool",
    "OMLX_OQ_STREAM_CALIBRATION": "bool",
    "OMLX_MOE_EXPERT_OFFLOAD": "bool",
    "OMLX_MOE_OFFLOAD_OVERLAP": "bool",
    "OMLX_MOE_GATE_UP_FUSION": "bool",
    "OMLX_QWEN35_MOE_GATE_UP": "bool",
    "OMLX_QWEN35_MOE_DECODE_PLAN": "bool",
    "OMLX_QWEN35_MOE_ROUTER_GEMV": "bool",
    "OMLX_QWEN35_MOE_ROUTER_SOFTMAX_FOLD": "bool",
    "OMLX_QWEN35_MOE_COMBINE_FUSED": "bool",
    "OMLX_QWEN35_MOE_ROUTED_DECODE": "bool",
    "OMLX_QWEN35_MOE_ROUTED_DECODE_VIEWS": "bool",
    "OMLX_QWEN35_MOE_SHARED_FOLD": "bool",
    "OMLX_QWEN35_MOE_TOPK_FOLD": "bool",
    "OMLX_QWEN35_MOE_VERIFY_WINDOW": "bool",
    "OMLX_QWEN35_MOE_WEIGHTED_SUM": "bool",
    "OMLX_LAGUNA_COMPILED_FUSIONS": "bool",
    "OMLX_LAGUNA_FUSED_ROUTED_GATE_UP": "bool",
    "OMLX_LAGUNA_FUSED_SHARED_GATE_UP": "bool",
    "OMLX_MTP_PROMPT_PRIMING": "bool",
    "OMLX_MTP_ROW_EXACT_VERIFY": "bool",
    "OMLX_QWEN35_ANE_PREFILL": "bool",
    "OMLX_QWEN35_ANE_DOWN_COMBINED_BANK": "bool",
    "MLX_JACCL_RING": "bool",
    "MLX_IBV_DEVICES": "bool",
    "OMLX_CLUSTER_LAUNCHER_LEASE": "bool",
    "OMLX_JACCL_SIDE_CHANNEL_TRACE": "bool",
    "OMLX_DISCOVERY": "bool",
    "OMLX_BONJOUR": "bool",
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_STEP": "bool",
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_STEP": "bool",
    "OMLX_MAX_IMAGE_BYTES": "bool",
    "OMLX_SECRET_KEY": "bool",
    "OMLX_MCP_CONFIG": "bool",
    "OMLX_BASE_PATH": "bool",
    "OMLX_EMBEDDING_COMPILE": "bool",
    # -- int (31)
    "OMLX_CONTENDED_PREFILL_CHUNK": "int",
    "OMLX_DECODE_BURST_MAX_STEPS": "int",
    "OMLX_FA256_MIN_KV_LEN": "int",
    "OMLX_FA256_Q_BLOCK": "int",
    "OMLX_FA256_K_BLOCK": "int",
    "OMLX_QWEN4_STEP_TEXT_POSITIONS_MIN_CONTEXT": "int",
    "OMLX_GDN_MIN_T": "int",
    "OMLX_QWEN35_Q4_MLP_MIN_TOKENS": "int",
    "OMLX_QWEN35_Q4_MLP_VARIANT": "int",
    "OMLX_QWEN35_Q4_LINEAR_MIN_TOKENS": "int",
    "OMLX_QWEN35_Q4_LINEAR_VARIANT": "int",
    "OMLX_QWEN35_Q8_MLP_MIN_TOKENS": "int",
    "OMLX_QWEN35_Q8_LINEAR_MIN_TOKENS": "int",
    "OMLX_OQ_A8_VARIANT": "int",
    "OMLX_OQ_A8_ACT_MODE": "int",
    "OMLX_DEEPSEEK_SORT_MIN_ROUTES": "int",
    "OMLX_DEEPSEEK_MOE_NAX_MIN_ROUTES": "int",
    "OMLX_DEEPSEEK_AFFINE_BLOCK_MIN_ROUTES": "int",
    "OMLX_DEEPSEEK_MXFP4_LARGE_BLOCK_MIN_ROUTES": "int",
    "OMLX_QWEN35_MOE_WEIGHTED_SUM_MIN_TOKENS": "int",
    "OMLX_MTP_PRIME_WINDOW": "int",
    "OMLX_INKLING_MTP_PRIME_WINDOW": "int",
    "OMLX_QWEN35_ANE_DOWN_LAYER_STRIDE": "int",
    "MLX_RANK": "int",
    "OMLX_CLUSTER_SIGNAL_CLEAR_TIMEOUT": "int",
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_STEP_SIZE": "int",
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_AFTER": "int",
    "MLX_MINIMAX_M3_ADAPTIVE_PREFILL_MIN_REMAINING": "int",
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_STEP_SIZE": "int",
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_AFTER": "int",
    "MLX_LM_GLM_DSA_ADAPTIVE_PREFILL_MIN_REMAINING": "int",
    # -- float (6)
    # vanilla casts float(); listed here so TYPES covers CATALOG exactly
    "OMLX_DECODE_STALL_TARGET_MS": "float",
    "OMLX_DECODE_FAIR_SHARE": "float",
    "OMLX_DECODE_BURST_BUDGET_S": "float",
    "OMLX_DECODE_BURST_BUDGET_SINGLE_S": "float",
    "OMLX_CLUSTER_PEER_ABORT_GRACE": "float",
    "OMLX_DISTRIBUTED_REQUEST_READ_TIMEOUT": "float",
    # -- str (33)
    "OMLX_SDPA_FLASH_CHUNK": "str",
    "OMLX_SDPA_FLASH_HS": "str",
    "OMLX_MIMO_DECODE_FLASH_MIN_KEYS": "str",
    "OMLX_GLM_HC_PREFILL": "str",
    "OMLX_QWEN4_QSA_NAX_PV": "str",
    "MLX_MINIMAX_MSA_NATIVE_TOPK": "str",
    "MLX_MINIMAX_MSA_NATIVE_TOPK_SELECT": "str",
    "OMLX_GDN_IMPL": "str",
    "OMLX_GLM53_KDA_RECURRENCE": "str",
    "OMLX_QWEN4_PLE_MODE": "str",
    "OMLX_QWEN4_EAGER_DISPATCH_EVERY": "str",
    "OMLX_QWEN4_GATHERED_MIN_QUERY": "str",
    "OMLX_QWEN35_QMM_NAX_VARIANT": "str",
    "MLX_ENABLE_TF32": "str",
    "OMLX_DEEPSEEK_MOE_NAX": "str",
    "OMLX_INKLING_MTP_FINAL_NORM": "str",
    "OMLX_QWEN35_ANE_BANK_MAX_BYTES": "str",
    "MLX_JACCL_COORDINATOR": "str",
    "OMLX_CLUSTER_CONTROL_TRANSPORT": "str",
    "OMLX_CLUSTER_CONTROL_PROXY_PYTHON": "str",
    "OMLX_CLUSTER_STATE_DIR": "str",
    "OMLX_CLUSTER_SSH_HOST_PUBLIC_KEY": "str",
    "OMLX_JACCL_PYTHON_SIDE_CHANNEL": "str",
    "OMLX_JACCL_SIDE_CHANNEL_TRANSPORT": "str",
    "OMLX_JACCL_SIDE_CHANNEL_PYTHON": "str",
    "OMLX_TAILSCALE_CLI": "str",
    "OMLX_MODEL": "str",
    "OMLX_SUPERVISED": "str",
    "OMLX_STARTUP_NOTICE_PATH": "str",
    "OMLX_DSH_HOME": "str",
    "OMLX_DSH_API": "str",
    "PI_CODING_AGENT_DIR": "str",
    "MODELSCOPE_DOMAIN": "str",
}

#: flag vars whose ON value vanilla spells the word "true" (it compares
#: == "true" or tests a membership set containing it). The UI must offer
#: true/false for these: writing 1 would read as OFF.
TRUTHY_WORD: dict[str, str] = {
    "OMLX_CONTINUOUS_BATCHING": "true",
    "OMLX_OQ_STREAM_CALIBRATION": "true",
    "OMLX_QWEN35_ANE_DOWN_COMBINED_BANK": "true",
}


#: The ONLY env vars the API accepts. Unknown keys are rejected with 400:
#: this stays an allow-list, never a free-form env editor.
ALLOWED: dict[str, dict] = {n: _spec(n) for n in editable_names()}



def catalog() -> list[dict]:
    """ENV-3/ENV-4 GET payload: one row per documented var. present/live
    reflect the RUNNING process env (a launch-time or applied-live value);
    stored is the uplift override awaiting a restart; settable drives the
    inline control — and it is only ever true on omlx-dev, because that is
    the sole runtime the store seeds (ENV-4)."""
    stored = load_overrides()
    dev = is_dev_runtime()
    rows = []
    for name, spec in CATALOG.items():
        present = name in os.environ
        live = os.environ.get(name) if present else None
        if live is not None and is_secret(name):
            live = mask(live)
        row = {"name": name, "present": present, "live": live,
               "stored": stored.get(name, {}).get("value") if dev else None,
               "settable": bool(dev and name in ALLOWED),
               "effect": spec.get("effect", "server"),
               "group": spec.get("group", "engine"),
               "default": spec.get("default", "")}
        if spec.get("desc"):
            row["desc"] = spec["desc"]
        if spec.get("managed"):
            row["managed"] = True
        if spec.get("dead"):
            row["dead"] = True
        if is_secret(name):
            row["secret"] = True
        rows.append(row)
    return rows
