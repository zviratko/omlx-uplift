"""Patch safeguards: root autodetection + kernel/keg-escape heuristics.

Sits BEFORE the strict gate (PAT-2 flow) and answers two questions:

1. WHERE does this diff want to land? A diff made inside the omlx/ source
   dir ('--- a/engine/foo.py') would otherwise fail with 'target file
   missing' against the site-packages tree. If EVERY path shares one
   leading component and stripping it puts every path under 'omlx/', the
   diff was made one level deeper than expected: the paths are rewritten
   ONCE, at validation time, so the stored diff is canonical and the
   apply/backup/restore machinery never learns about the remap.

2. SHOULD this diff land there without a human looking? Two heuristics
   raise PROBLEMS (never hard failures):
   - kernel_source: anything under omlx/custom_kernels/. The compiled
     artifacts (_ext*.so, *.dylib, *.metallib) are built at package-build
     time and are NOT rebuilt by a patch — the fix may be inert or worse,
     out of sync with the Python wrapper. Requires explicit user
     approval (once or always) before reconcile will auto-apply.
   - outside_keg: a path that resolves outside the installed site-packages
     tree (or onto a missing file). Sibling packages inside the tree
     (mlx_embeddings, mlx_vlm, ...) are legitimate targets and NOT flagged.

Problems must be covered by an explicit approval to auto-apply, but the
approval is per CODE (and for 'once' per content sha), never a blanket
'ignore all safeguards' switch.

Stdlib only — imported by the router AND (indirectly, through stored
reports) consulted by the .pth startup path. Never raises.
"""

from __future__ import annotations

import os

__all__ = ["normalize_root", "assess", "held", "KERNEL_REBUILD_HINT"]

_OMLX_PREFIX = "omlx/"

# Honest rebuild path: the keg carries no csrc/ sources, so a native
# rebuild needs a source checkout (kernel rebuild swap) or a full source
# build of the formula. Both verified 2026-09-21.
KERNEL_REBUILD_HINT = (
    "omlx-uplift kernel rebuild <name> --src /path/to/omlx-checkout "
    "(one kernel, keeps a byte-exact backup) — or the full path: "
    "brew reinstall --HEAD --with-custom-kernel jundot/omlx/omlx; "
    "either way then restart omlx and re-run omlx-uplift install)")

_MAX_REPORTED_PROBLEMS = 20


# --------------------------------------------------------------------------
# Root autodetection
# --------------------------------------------------------------------------

MAX_ROOT_SHIFT = 2  # strip at most this many leading components


def _file_paths(parsed: dict) -> list[str]:
    return [f["path"] for f in parsed["files"] if f.get("path")]


def _all_under_omlx(paths: list[str]) -> bool:
    return bool(paths) and all(p.startswith(_OMLX_PREFIX) for p in paths)


def _all_prefixed(paths: list[str], prefix: str) -> bool:
    return bool(paths) and all(p.startswith(prefix) for p in paths)


def _strip_one(paths: list[str]) -> list[str] | None:
    """Drop one shared leading component from every path, or None."""
    if any("/" not in p for p in paths):
        return None
    firsts = {p.split("/", 1)[0] for p in paths}
    if len(firsts) != 1:
        return None
    head = firsts.pop()
    if not head or head in (".", ".."):
        return None
    return [p.split("/", 1)[1] for p in paths]


def normalize_root(diff: bytes | str, tree_root: str | None = None) -> tuple[bytes, str | None]:
    """Rewrite section paths so they are tree-root canonical.

    The target tree is the whole site-packages dir (omlx AND its
    neighbours are patchable), so a path that already lands on an
    existing tree entry is canonical AS-IS — mlx_embeddings/... made with
    `diff -ruN` needs no remap and must not be guessed about.

    Returns (possibly-rewritten diff bytes, note). Ladder (no guessing):

      0. every path exists in the tree already                   -> as-is
      1. paths under 'omlx/'                                     -> as-is
         (also: every path EXISTS under omlx/ in the tree        -> as-is;
          a whole-package diff carries 'omlx/' as its top dir)
      2..MAX_ROOT_SHIFT+1: strip N shared leading components
         (diff made from a checkout that nests the package under
          <repo>/<x>/... ) -> rewritten when the result is either an
          existing tree path or under 'omlx/'
      3: every path sits directly inside the package root
         ('engine/foo.py', exists under omlx/) -> prepend 'omlx/'

    note is None when nothing applied or the diff cannot be parsed — the
    strict gate still rejects unparseable input; we never guess there.
    """
    from . import diffapply

    if isinstance(diff, str):
        diff = diff.encode("utf-8")
    parsed = diffapply.parse_diff(diff)
    if not parsed["ok"]:
        return diff, None
    paths = _file_paths(parsed)
    if not paths or not all("/" in p for p in paths):
        return diff, None

    def exists_in_tree(p: str) -> bool:
        return tree_root is None or os.path.lexists(os.path.join(tree_root, *p.split("/")))

    def exists_under_omlx(p: str) -> bool:
        return exists_in_tree(_OMLX_PREFIX + p)

    def creates_into_existing(p: str, exists) -> bool:
        # a create's target obviously cannot exist yet — its PARENT must
        return exists(os.path.dirname(p))

    entries = [(f["path"], f.get("action", "modify")) for f in parsed["files"]
               if f.get("path")]
    if not entries:
        return diff, None

    # 0. already tree-root canonical (existing site-packages members).
    # Needs a tree to check against — without one we cannot tell, and the
    # ladder below keeps its old (grounded) behaviour.
    if tree_root is not None and not _all_under_omlx(paths) and all(
            exists_in_tree(p) or (a == "create" and creates_into_existing(p, exists_in_tree))
            for p, a in entries):
        return diff, None

    # 1. paths already rooted at the package
    if _all_under_omlx(paths):
        return diff, None

    # 2. strip shared leading components (checkout made one level too deep).
    # Only ever strip toward 'omlx/': a sibling's extra leading dir is
    # ambiguous (which parent did they mean?) and the strict gate will say
    # 'target missing' loudly rather than us guessing a rewrite.
    cur = list(paths)
    for _ in range(MAX_ROOT_SHIFT):
        stripped = _strip_one(cur)
        if stripped is None:
            break
        cur = stripped
        if _all_under_omlx(cur):
            removed = paths[0][: len(paths[0]) - len(cur[0]) - 1] + "/"
            note = (f"paths made under '{removed}' were rewritten to be "
                    f"rooted at the site-packages tree (diff was made "
                    f"'{removed}' too deep)")
            return _rewrite_paths(diff, remove_prefix=removed), note

    # 3. level-shift: every path already inside the package source root.
    # Grounded: only shift when every PREPENDED path actually exists in
    # the live tree (a real package member), so a sibling like
    # 'fastapi/routing.py' is NOT silently buried under omlx/ and stays
    # visible to the outside_keg heuristic.
    if not _all_prefixed(paths, _OMLX_PREFIX):
        if all(exists_under_omlx(p)
               or (a == "create" and creates_into_existing(_OMLX_PREFIX + p, exists_in_tree))
               for p, a in entries):
            note = ("paths are relative to the omlx package dir; they were "
                    "rewritten with an 'omlx/' prefix (diff was made inside "
                    "the package instead of its parent)")
            return _rewrite_paths(diff, add_prefix=_OMLX_PREFIX), note
    return diff, None


def _rewrite_paths(diff: bytes, remove_prefix: str | None = None,
                   add_prefix: str | None = None) -> bytes:
    """Byte-level rewrite of the path-bearing lines only: 'diff --git',
    '--- ', '+++ '. Hunks are never touched, so content stays byte-exact.
    The tab-suffix (timestamps in hand-made diffs) is preserved verbatim."""
    lines = diff.split(b"\n")
    last_empty = bool(lines) and lines[-1] == b""
    if last_empty:
        lines.pop()
    if len(diff) > 16 and b"\r\n" in diff[:256]:
        crlf = True
        lines = [ln[:-1] if ln.endswith(b"\r") else ln for ln in lines]
    else:
        crlf = False

    sp = remove_prefix.encode("utf-8") if remove_prefix else None
    ap = add_prefix.encode("utf-8") if add_prefix else None

    def restrip(p: bytes) -> bytes:
        body = p[2:] if p.startswith(b"a/") or p.startswith(b"b/") else p
        if sp and body.startswith(sp):
            body = body[len(sp):]
        if ap and not body.startswith(ap):
            body = ap + body
        return body

    out = []
    for ln in lines:
        if ln.startswith(b"diff --git "):
            parts = ln[len(b"diff --git "):].split(b" ")
            if len(parts) == 2:
                a = restrip(parts[0])
                out.append(b"diff --git a/" + a + b" b/" + a)
                continue
        elif ln.startswith((b"--- ", b"+++ ")):
            head, _tab, tail = ln[4:].partition(b"\t")
            if head != b"/dev/null":
                p = restrip(head)
                mark = b"--- " if ln.startswith(b"--- ") else b"+++ "
                ln = mark + p + (b"\t" + tail if tail else b"")
                out.append(ln)
                continue
        out.append(ln)
    data = b"\n".join(out)
    if last_empty:
        data += b"\n"
    if crlf:
        data = data.replace(b"\n", b"\r\n")
    return data


# --------------------------------------------------------------------------
# Heuristics
# --------------------------------------------------------------------------

def assess(parsed: dict, tree_root: str) -> dict:
    """Look at the (normalized) parsed file set and report problems.

    Returns {"problems": [{"code","path","message"}], "codes": [..],
             "truncated": bool}. Problems are advisory to the strict gate
    (the diff may still be a clean, applyable diff) but block
    AUTO-APPLY until each distinct code is explicitly approved.

    Policy: the WHOLE site-packages tree is patchable — sibling packages
    (mlx_embeddings, mlx_vlm, ...) are legitimate targets and pass without
    a word. Only a path that resolves OUTSIDE the installed tree — or
    onto nothing at all (neither the path nor its omlx/ interpretation
    exists; a modify of a missing file) — is an 'outside_keg' problem.
    """
    problems: list[dict] = []

    def add(code: str, path: str, message: str) -> None:
        if len(problems) < _MAX_REPORTED_PROBLEMS:
            problems.append({"code": code, "path": path, "message": message})

    def lexists(rel: str) -> bool:
        return (tree_root is None
                or os.path.lexists(os.path.join(tree_root, *rel.split("/"))))

    truncated = False
    for fp in parsed.get("files", []):
        path = fp.get("path") or ""
        if not path.startswith(_OMLX_PREFIX):
            if lexists(path):
                continue  # in-keg sibling: fine, no warning
            if (fp.get("action") == "create"
                    and lexists(os.path.dirname(path) or ".")):
                continue  # new file into an existing keg dir: fine
            add("outside_keg", path,
                "resolves outside the installed site-packages tree (or "
                "onto a missing file) — verify the target before applying")
            continue
        rel = path[len(_OMLX_PREFIX):]
        if rel == "custom_kernels" or rel.startswith("custom_kernels/"):
            native = "/csrc/" in f"/{rel}"
            msg = ("touches a bundled custom kernel; the compiled artifacts "
                   "(_ext*.so, *.dylib, *.metallib) are NOT rebuilt by this "
                   "patch — native changes need a rebuild: " + KERNEL_REBUILD_HINT)
            if native:
                msg += (" (path is native source under csrc/; the keg does "
                        "not even ship csrc/, so this hunk likely cannot "
                        "apply at all)")
            add("kernel_source", path, msg)
    codes: list[str] = []
    for p in problems:
        if p["code"] not in codes:
            codes.append(p["code"])
    return {"problems": problems, "codes": codes, "truncated": truncated}


def held(codes: list[str], always: list[str], once: dict | None,
         content_sha: str | None) -> list[str]:
    """Codes that still need approval given the patch's stored approvals.
    'always' covers its codes for every future version; 'once' only for the
    exact content sha it was granted against."""
    covered = set(always or [])
    if once and content_sha and once.get("sha") == content_sha:
        covered |= set(once.get("codes") or [])
    return [c for c in codes if c not in covered]
