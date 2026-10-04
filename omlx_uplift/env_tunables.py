"""ENV-1: uplift-owned OMLX_* experimental tunables — the single source of truth.

Vanilla omlx reads a handful of scheduler/engine knobs from os.environ with
no settings.json entry. Uplift exposes a hard-coded allow-list of them in
the settings UI and persists values uplift-side in
``~/.omlx/uplift/env_overrides.json`` (next to metrics.sqlite3). At
interpreter startup ``autopatch`` seeds them into ``os.environ`` before any
omlx module reads them.

Precedence (the core rule):
  * A genuine launch-time environment variable (launchd plist, shell, CLI)
    ALWAYS wins. autopatch records such names in ``SHADOWED`` and never
    overwrites them.
  * Uplift-stored values fill only the gaps.

This module must stay import-safe at interpreter startup: stdlib only,
no omlx imports. The autopatch hook sets SHADOWED via :func:`mark_shadowed`
and stores the directory hint via :func:`set_base_dir`.

Effect classes (verified against vanilla read-points 2026-09-19, re-checked
against HEAD 2026-09-20 — the read sites below are the current lines):
  immediate -> read per call (os.environ at call time): live apply works.
  model     -> EngineConfig default_factory at engine construction: RESTART MODEL.
  server    -> module-import constants / startup config: RESTART SERVER.
NOT exposed (documented skips):
  OMLX_DECODE_BURST_BUDGET_SINGLE_S — vanilla burst_decode_mode writes the
      same var on every mode save (settings.py burst_decode_env());
      last-writer-wins collision.
  OMLX_MAX_NUM_SEQS — settings.py treats it as the env fallback for the
      already-exposed max_concurrent_requests; two fields would fight.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

OVERRIDES_FILENAME = "env_overrides.json"

# name -> spec. Keys here are the ONLY env vars the API accepts; unknown
# keys are rejected with 400 (this is not a free-form env editor).
ALLOWED: dict[str, dict] = {
    # -- class 1: CALL-TIME (effect=immediate) ------------------------------
    "OMLX_CHUNK_SNAP": {
        "label": "Chunk quantization",
        "type": "bool", "default": "1", "effect": "immediate", "group": "scheduler",
        "desc": "Quantize prefill chunk boundaries to fixed steps; 0 disables (A/B measurement).",
    },
    "OMLX_MTP_PROMPT_PRIMING": {
        "label": "MTP prompt priming",
        "type": "bool", "default": "1", "effect": "immediate", "group": "mtp",
        "desc": "Prime MTP drafters from the prompt context.",
    },
    "OMLX_MTP_PRIME_WINDOW": {
        "label": "MTP priming window",
        "type": "int", "default": "0", "effect": "immediate", "group": "mtp",
        "desc": "History window (tokens) MTP priming may use; 0 = unlimited.",
        "min": 0,
    },
    "OMLX_DISABLE_PRESSURE_RECLAIM": {
        "label": "Disable pressure reclaim",
        "type": "bool", "default": "", "effect": "immediate", "group": "memory",
        "desc": "1 disables memory-pressure reclaim (restores stock behavior).",
    },
    # -- class 2: ENGINE-CONSTRUCTION (effect=model) -------------------------
    "OMLX_DECODE_BURST_BUDGET_S": {
        "label": "Burst decode budget (s)",
        "type": "float", "default": "0.03", "effect": "model", "group": "engine",
        "desc": "Wall-clock budget (s) per burst-decode pass.",
        "min": 0.001, "max": 10.0,
    },
    "OMLX_DECODE_BURST_MAX_STEPS": {
        "label": "Burst decode max steps",
        "type": "int", "default": "64", "effect": "model", "group": "engine",
        "desc": "Maximum decode steps per burst pass.",
        "min": 1, "max": 4096,
    },
    # -- class 3: MODULE-IMPORT (effect=server) ------------------------------
    "OMLX_DECODE_FAIR_SHARE": {
        "label": "Decode fair share",
        "type": "float", "default": "0.5", "effect": "server", "group": "scheduler",
        "desc": "Fair share of decode slots per request before yielding.",
        "min": 0.0, "max": 1.0,
    },
    "OMLX_DECODE_STALL_TARGET_MS": {
        "label": "Decode stall target (ms)",
        "type": "int", "default": "500", "effect": "server", "group": "scheduler",
        "desc": "Decode stall target (ms) that triggers scheduler rebalance.",
        "min": 1,
    },
    "OMLX_CONTENDED_PREFILL_CHUNK": {
        "label": "Contended prefill chunk",
        "type": "int", "default": "512", "effect": "server", "group": "scheduler",
        "desc": "Prefill chunk size (tokens) while decode is contended.",
        "min": 16,
    },
    # -- class 4: STARTUP-CONFIG (effect=server) -----------------------------
    "OMLX_CONTINUOUS_BATCHING": {
        "label": "Continuous batching",
        "type": "bool", "default": "false", "effect": "server", "group": "engine",
        "desc": "Enable experimental continuous batching at startup.",
    },
}


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

_BASE_DIR: Path | None = None


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


def load_overrides(path: Path | None = None) -> dict[str, dict]:
    """Read {VAR: {\"value\": str, \"set_at\": iso}}. Missing/corrupt = {}."""
    p = path or overrides_path()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        if k in ALLOWED and isinstance(v, dict) and isinstance(v.get("value"), str):
            out[k] = {"value": v["value"], "set_at": str(v.get("set_at", ""))}
    return out


def save_overrides(data: dict[str, dict], path: Path | None = None) -> Path:
    """Persist atomically (tmp + rename in the same dir). Parent dirs created."""
    p = path or overrides_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".env_overrides.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p


# ---------------------------------------------------------------------------
# Validation + coercion
# ---------------------------------------------------------------------------

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
        if s.lower() in ("1", "true", "yes", "on"):
            return "1"
        if s.lower() in ("0", "false", "no", "off"):
            return "0"
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

    For every stored override: if the name is already in os.environ it is
    genuine launch env -> record as SHADOWED and leave untouched; otherwise
    write it into os.environ. Returns the vars actually seeded.

    Pure stdlib; missing/corrupt file is silently skipped. Never raises.
    """
    seeded: dict[str, str] = {}
    try:
        data = load_overrides(path)
    except Exception:  # belt and braces: startup hook must never crash omlx
        return seeded
    for name, entry in data.items():
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
    shadow list, and the allow-list spec for the UI."""
    stored = load_overrides()
    values = {}
    for name in ALLOWED:
        if name in stored:
            values[name] = stored[name]["value"]
    shadow = [
        {"name": n, "value_masked": mask(os.environ.get(n, ""))}
        for n in sorted(SHADOWED)
    ]
    allowed = [
        {"name": n, **{k: spec[k] for k in ("label", "type", "default", "effect", "group", "desc") if k in spec},
         **{k: spec[k] for k in ("min", "max") if k in spec}}
        for n, spec in ALLOWED.items()
    ]
    return {"values": values, "shadowed": shadow, "allowed": allowed}


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
        "desc": "Maximum decode steps per burst pass (safety cap, bounds the host-side output list)."},
    "OMLX_CONTINUOUS_BATCHING": {"group": "engine", "effect": "server", "default": "false",
        "desc": "Enable experimental continuous batching at startup.", "managed": True},
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
        "desc": "GLM-5 hybrid-cache prefill kernel; 0/off disables."},
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
    "OMLX_MINIMAX_MSA_NATIVE_TOPK": {"group": "attention", "effect": "server", "default": "auto",
        "desc": "Minimax M3 sparse-attention top-k route: auto | native kernel | fallback."},
    "OMLX_MINIMAX_MSA_NATIVE_TOPK_SELECT": {"group": "attention", "effect": "server", "default": "auto",
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
        "desc": "oQ mixed-bit QxA8 activation mode on M5 tensor units: 1 enables for models flagged per settings (qwen35_oq_a8_enabled)."},
    "OMLX_OQ_A8_VARIANT": {"group": "quantization", "effect": "server", "default": "0",
        "desc": "Select the QxA8 kernel variant in the Qwen3.5 prefill extension (0 = auto)."},
    "OMLX_OQ_A8_ACT_MODE": {"group": "quantization", "effect": "server", "default": "0",
        "desc": "QxA8 activation handling mode in the Qwen3.5 prefill extension."},
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
    "OMLX_CLUSTER_SSH_HOST_PUBLIC_KEY": {"group": "cluster", "effect": "immediate", "default": "",
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
        "desc": "Default model name for the CLI launch (config-level override).", "managed": True},
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


def _is_secretish(name: str) -> bool:
    return name.endswith(("_KEY", "_TOKEN", "_SECRET")) or "PASSWORD" in name


def catalog() -> list[dict]:
    """ENV-3 GET payload: one row per documented var. present/live reflect
    the RUNNING process env (a launch-time or applied-live value); stored is
    the uplift override awaiting a restart; settable drives the APPLY chip."""
    stored = load_overrides()
    rows = []
    for name, spec in CATALOG.items():
        present = name in os.environ
        live = os.environ.get(name) if present else None
        if live is not None and (spec.get("secret") or _is_secretish(name)):
            live = mask(live)
        row = {"name": name, "present": present, "live": live,
               "stored": stored.get(name, {}).get("value"),
               "settable": name in ALLOWED,
               "effect": spec.get("effect", "server"),
               "group": spec.get("group", "engine"),
               "default": spec.get("default", "")}
        if spec.get("desc"):
            row["desc"] = spec["desc"]
        if spec.get("managed"):
            row["managed"] = True
        rows.append(row)
    return rows
