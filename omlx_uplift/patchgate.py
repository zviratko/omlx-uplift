"""BE-3 step 1 (pure move): the validation gate of the patch pipeline.

Everything that decides 'may this diff become a stored pending version':
the py_compile/json compile gate, the full no-write validate() gate, and
the all-already helper the upstreamed check uses. Moved verbatim out of
patchsource.py; patchsource re-exports these names so existing seams
(tests call patchsource.validate directly; devsrc.recheck_build_patches
gates through patchsource.validate) keep resolving to the same objects.

Gate order is load-bearing (PAT-2): parse -> strict dry-run against the
tree -> compile gate on in-memory post-apply bytes -> safeguards assess.
validate() also ROOT-NORMALIZES once, so sha/stored bytes/apply/reversal
all work on identical canonical content.
"""

from __future__ import annotations

import hashlib
import json
import os

from . import diffapply
from . import safeguards as _safeguards


def _py_compiles(data: bytes) -> bool:
    """True when data is syntactically valid Python (in-memory, no writes)."""
    try:
        compile(data, "uplift-check.py", "exec")
        return True
    except (SyntaxError, ValueError):
        return False


def compile_gate(parsed: dict, tree_root: str,
                 overrides: dict | None = None,
                 reverse: bool = False) -> list[str]:
    """py_compile/json checks on in-memory post-apply content. Returns a
    list of human-readable problems (empty = gate passed).

    reverse: True checks the REVERSAL result (the pre-image) — a reversal
    patch must leave compilable code too."""
    import py_compile
    import tempfile

    problems: list[str] = []
    for fp in parsed["files"]:
        target, why = diffapply.safe_join(tree_root, fp["path"])
        if target is None:
            problems.append(f"{fp['path']}: {why}")
            continue
        if overrides and fp["path"] in overrides:
            content = overrides[fp["path"]]
        else:
            try:
                with open(target, "rb") as fh:
                    content = fh.read()
            except FileNotFoundError:
                content = None
        if reverse:
            res = diffapply._apply_file_rev(content, fp)  # in-memory only
        else:
            res = diffapply._apply_file(content, fp)  # in-memory only
        if res.get("already"):
            continue
        if not res.get("ok"):
            problems.append(f"{fp['path']}: {res.get('reason')}")
            continue
        new_bytes = res.get("new_bytes", b"")
        ext = os.path.splitext(fp["path"])[1].lower()
        if ext == ".py":
            base_ok = _py_compiles(content) if content is not None else True
            post_ok = _py_compiles(new_bytes)
            if base_ok and not post_ok:
                problems.append(f"{fp['path']}: patch breaks compilation "
                                "(file compiled before the patch)")
            elif not post_ok:
                # pre-image already un-compilable: not the patch's doing —
                # report honestly, do not block (upstream ships it that way)
                pass
        elif ext == ".json":
            try:
                json.loads(new_bytes.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                problems.append(f"{fp['path']}: invalid JSON — {exc}")
        # HTML/templates: text apply only, no compile gate (honest by design)
    return problems


def validate(diff: bytes, tree_root: str,
             overrides: dict | None = None,
             reverse: bool = False,
             skip_patterns: list[str] | None = None,
             tree_kind: str = "keg") -> dict:
    """Full gate WITHOUT writing anything.

    The diff is first root-normalized (safeguards.normalize_root): a diff
    made one directory too deep is rewritten to tree-root-canonical paths
    ONCE here, so everything downstream (sha, stored file, apply) works on
    the canonical bytes.

    skip_patterns: whole file sections matching these patterns are PRUNED
    from the diff before the sha is taken (see diffapply.prune_sections) —
    stored bytes, gate, apply and reversal all see the same pruned diff.
    Pruned paths come back in 'skipped' and as SKIPPED rows in 'files'.

    overrides: {rel_path: bytes} — tree content to use instead of the live
    file for those paths (gate the candidate against the tree as reconcile
    will find it at apply time: this patch's own hunks unwound to pristine,
    other patches' hunks still applied).

    reverse: True gates the diff as a REVERSAL — it must UN-apply cleanly
    against the live tree (the merged change is present and revertible).

    tree_kind: which KIND of tree tree_root is — 'keg' (installed
    site-packages, the default) or 'src' (a full source checkout, the dev
    carrier for scope=dev/both). Only the safeguards heuristics read it:
    their premises are keg-specific and must not be recited at a source
    tree. Never affects gate verdicts, diff bytes or the sha.

    Returns {ok, reason?, advisories?, files: [per-file results],
             compile_problems: [...], content_sha256, diff, safeguards?,
             note?}.
    """
    skipped: list[str] = []
    if skip_patterns:
        diff, skipped = diffapply.prune_sections(diff, skip_patterns)
        if skipped and not diff.strip():
            return {"ok": False, "reason": "every file in the diff matches "
                    "the skip patterns — nothing left to apply",
                    "files": [], "compile_problems": [], "skipped": skipped,
                    "content_sha256": hashlib.sha256(diff).hexdigest(),
                    "diff": diff}
    diff, note = _safeguards.normalize_root(diff, tree_root)
    content_sha256 = hashlib.sha256(diff).hexdigest()
    parsed = diffapply.parse_diff(diff)
    if not parsed["ok"]:
        return {"ok": False, "reason": f"parse: {parsed['reason']}",
                "files": [], "compile_problems": [], "skipped": skipped,
                "content_sha256": content_sha256, "diff": diff}
    check = diffapply.check_diff(diff, tree_root, overrides=overrides,
                                 reverse=reverse)
    compile_problems = compile_gate(parsed, tree_root, overrides=overrides,
                                    reverse=reverse)
    ok = all(f["status"] in ("ok", "already") for f in check["files"]) \
        and bool(check["files"]) and not compile_problems
    files = check["files"]
    out = {"ok": ok,
           "reason": check.get("reason") if not ok else None,
           "files": files,
           "skipped": skipped,
           "compile_problems": compile_problems,
           "content_sha256": content_sha256,
           "diff": diff,
           "safeguards": _safeguards.assess(parsed, tree_root, tree_kind)}
    if note:
        out["note"] = note
    return out


def gate_all_already(result: dict) -> bool:
    """True when a gate passed and EVERY file section is 'already' — the
    tree (base or keg) already contains the hunks: upstreamed."""
    files = result.get("files") or []
    return bool(files) and result.get("ok") and all(
        f.get("status") == "already" for f in files)
