#!/usr/bin/env python3
"""REPL-4: MTEB child runner — runs ONE task against the omlx public API.

Spawned by omlx_uplift/embed_engine.py with the mteb-env python (never
the keg: mteb hard-requires torch, the kegs stay torch-free). Auth:
OPENAI_API_KEY from the environment ONLY (never argv — ps would leak it;
same rule the harness path pins in tests).

Output contract (the parent parses these, everything else is passthrough
for the log):
  UPLIFT {"phase": "...", ...}     progress lines
  UPLIFT_RESULT {json}             exactly one, on success
The result JSON is the mteb scores dict flattened to the numbers the
native UI table shows; nothing is invented — missing values stay null.

_verify_server auth fix (NAT-6 S3, now productized): mteb 2.24 verifies
the server with an UNAUTHENTICATED GET /v1/models; omlx requires Bearer
auth, so the wrapper would die before encoding. We override only that
method; every other wrapper behavior is upstream's.
"""
import argparse
import json
import os
import sys


def emit(kind: str, payload: dict) -> None:
    print(f"{kind} {json.dumps(payload, default=str)}", flush=True)


def _finite(v):
    """NaN/Inf (mteb emits them for degenerate metrics under --limit)
    are not JSON-compliant; replace with None — 'no value', honest."""
    import math
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


def build_wrapper(kind: str, root: str, model: str, key: str):
    import requests  # noqa: F401 (used by the mixin below)
    from mteb.models.openai_wrappers import (OpenAIAPIEncodeWrapper,
                                             OpenAIAPIRerankWrapper)

    class AuthMixin:
        def _verify_server(self):
            r = requests.get(f"{self.endpoint_url}/v1/models", timeout=10,
                             headers={"Authorization": f"Bearer {key}"},
                             verify=self.verify_ssl)
            r.raise_for_status()

    base = (OpenAIAPIEncodeWrapper if kind in ("embed", "encode")
            else OpenAIAPIRerankWrapper)
    cls = type("Auth" + base.__name__, (AuthMixin, base), {})
    kwargs = dict(endpoint_url=root, model_name=model, api_key=key,
                  # text-only: both wrappers otherwise advertise every
                  # modality and may build a payload omlx can't serve
                  modalities=["text"])
    if kind in ("embed", "encode"):
        # omlx /v1/embeddings takes plain 'input' (text). The wrapper's
        # default would route EVERY batch through the vLLM chat-
        # embeddings shape ('messages'), which omlx rejects 422 — the
        # NAT-6 S3 probe pinned this as the fix.
        kwargs["use_chat_template"] = False
    return cls(**kwargs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True,
                    help="server ROOT url, e.g. http://127.0.0.1:8001 "
                         "(mteb wrappers append /v1/... themselves — NAT-6 S3)")
    ap.add_argument("--model", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--kind", choices=("embed", "encode", "rerank"),
                    required=True,
                    help="embed (=mteb encode wrapper; the engine-facing "
                         "name is 'embed', 'encode' kept as an alias)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()

    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        emit("UPLIFT_RESULT", {"error": "OPENAI_API_KEY missing in env"})
        return 2

    import mteb
    emit("UPLIFT", {"phase": "loading", "task": args.task})
    task = mteb.get_task(args.task)
    # metric NAME is task metadata's main_score field (e.g.
    # 'cosine_spearman'); 2.24's TaskResult has no task_metadata attr —
    # reading the wrong one here silently nulled every score once.
    try:
        metric_name = str(task.metadata.main_score)
    except Exception:
        metric_name = "main_score"
    wrapper = build_wrapper(args.kind, args.root, args.model, key)

    emit("UPLIFT", {"phase": "running", "task": args.task,
                    "splits": list(task.metadata.eval_splits or [])})
    run_kw = dict(output_folder=args.outdir,
                  eval_splits=list(task.metadata.eval_splits or ["test"]))
    if args.limit:
        run_kw["limit"] = args.limit
    results = mteb.MTEB(tasks=[task]).run(wrapper, **run_kw)
    # mteb returns list[Result]; 2.24 entries always carry a
    # 'main_score' key (verified live 2026-10-08: BIOSSES test entry
    # main_score == cosine_spearman 0.8588). Missing values stay null —
    # nothing is invented.
    out = {"task": args.task, "kind": args.kind, "model": args.model,
           "limit": args.limit or None, "scores": {}}
    for res in results:
        for split, entries in (res.scores or {}).items():
            if not entries:
                out["scores"][split] = None
                continue
            e = entries[0]
            main = e.get("main_score")
            mname = metric_name
            if mname != "main_score" and e.get(mname) is None:
                mname = "main_score"
            out["scores"][split] = _finite({
                "main_score": float(main) if main is not None else None,
                "main_metric": mname,
                "all": {k: v for k, v in e.items()
                        if isinstance(v, (int, float))},
            })
    emit("UPLIFT_RESULT", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
