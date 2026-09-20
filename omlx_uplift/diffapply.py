"""Strict unified-diff applier — pure Python, stdlib only (PAT-1).

Rules (per PAT-0 design, do not loosen without a decision record):
- STRICT: a hunk applies only when its full context matches byte-for-byte.
  Line-number offsets are searched (git-apply style forward/backward), but
  ZERO fuzz: never apply a hunk whose context does not match exactly.
- Byte-exact: operate on bytes, preserve CRLF/LF per line, preserve
  trailing-newline presence (git "\ No newline at end of file" markers).
- Path safety: targets must resolve inside the tree root after normpath;
  reject '..', absolute paths, symlink escapes, and anything under
  ``omlx_uplift/`` (uplift never patches itself).
- Reject at parse time with a clear reason: git binary patches, file mode
  changes, rename/copy metadata.
- No exceptions as flow control: check/apply/restore return structured dicts.
"""

from __future__ import annotations

import hashlib
import os
import re

__all__ = ["parse_diff", "check_diff", "apply_diff", "restore_backup",
           "safe_join", "splitlines_keepends"]

_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


# --------------------------------------------------------------------------
# Low-level line helpers
# --------------------------------------------------------------------------

def splitlines_keepends(data: bytes) -> list[bytes]:
    """splitlines(True) that keeps the concept of a missing final newline:
    the last element simply has no eol bytes when the data has no final eol."""
    if not data:
        return []
    return data.splitlines(keepends=True)


def _split_eol(line: bytes) -> tuple[bytes, bytes]:
    """Return (text, eol) with eol in {b'', b'\\n', b'\\r\\n'}."""
    if line.endswith(b"\r\n"):
        return line[:-2], b"\r\n"
    if line.endswith(b"\n"):
        return line[:-1], b"\n"
    return line, b""


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def _fail(reason: str) -> dict:
    return {"ok": False, "reason": reason, "files": []}


def parse_diff(diff: bytes | str) -> dict:
    """Parse a (possibly multi-file) unified diff.

    Returns {"ok": bool, "reason": str|None, "files": [filepatch]}.
    Each filepatch: {path, action: modify|create|delete, hunks, reject}.
    A file with a non-None reject must abort the whole patch (strict).
    """
    if isinstance(diff, str):
        diff = diff.encode("utf-8")
    if not diff.strip():
        return _fail("empty diff")

    lines = diff.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()  # artifact of the final newline
    # CRLF diff files: the CR belongs to the line ending, not the content.
    # Target-file CRLF is preserved via per-line eol handling downstream.
    if len(diff) > 16 and b"\r\n" in diff[:256]:
        lines = [ln[:-1] if ln.endswith(b"\r") else ln for ln in lines]

    # Section boundaries: one per "diff --git" header.
    starts = [i for i, ln in enumerate(lines) if ln.startswith(b"diff --git ")]
    if not starts:
        return _fail("not a unified diff: no 'diff --git' header found")
    if starts[0] != 0 and any(l.strip() for l in lines[: starts[0]]):
        # tolerate leading noise (index lines etc.) only if blank
        return _fail("unified diff has content before the first file header")

    files: list[dict] = []
    bounds = starts + [len(lines)]
    for si in range(len(starts)):
        files.append(_parse_file_section(lines[bounds[si] : bounds[si + 1]]))

    rejected = [f for f in files if f.get("reject")]
    if rejected:
        return _fail(rejected[0]["reject"])
    if not any(f["hunks"] for f in files):
        return _fail("unified diff contains no hunks")
    return {"ok": True, "reason": None, "files": files}


def _git_paths(header: bytes) -> tuple[str, str]:
    """Extract a/... b/... paths from a 'diff --git a/x b/y' header.
    Quoted or space-containing paths are rejected as unsupported (rare, strict)."""
    parts = header[len(b"diff --git ") :].split(b" ")
    if len(parts) != 2:
        return "", ""
    a, b = parts
    for p in (a, b):
        if p.startswith(b'"') or b'"' in p:
            return "", ""
    a = a[2:] if a.startswith(b"a/") else a
    b = b[2:] if b.startswith(b"b/") else b
    return a.decode("utf-8", "replace"), b.decode("utf-8", "replace")


def _parse_file_section(section: list[bytes]) -> dict:
    header = section[0]
    a_path, b_path = _git_paths(header)
    reject = None
    if not b_path:
        reject = "unsupported diff header (quoted or spaced paths)"

    old_path = new_path = None
    hunks: list[dict] = []
    i = 1
    while i < len(section):
        ln = section[i]
        if ln.startswith((b"index ", b"similarity index", b"index", b"new file mode",
                          b"deleted file mode")) or ln == b"":
            i += 1
            continue
        if ln.startswith((b"old mode", b"new mode")):
            reject = reject or "file mode changes unsupported"
            i += 1
            continue
        if ln.startswith((b"rename from", b"rename to", b"copy from", b"copy to")):
            reject = reject or "git rename/copy metadata unsupported"
            i += 1
            continue
        if ln.startswith(b"Binary files") or ln.startswith(b"GIT binary patch"):
            reject = reject or "binary patch unsupported"
            i += 1
            continue
        if ln.startswith(b"--- "):
            p = ln[4:].split(b"\t")[0].decode("utf-8", "replace")
            old_path = None if p == "/dev/null" else _strip_ab(p)
            i += 1
            continue
        if ln.startswith(b"+++ "):
            p = ln[4:].split(b"\t")[0].decode("utf-8", "replace")
            new_path = None if p == "/dev/null" else _strip_ab(p)
            i += 1
            continue
        m = _HUNK_RE.match(ln.decode("utf-8", "replace"))
        if m:
            hunk, i = _parse_hunk(section, i)
            if hunk.get("reject"):
                reject = reject or hunk["reject"]
            else:
                hunks.append(hunk)
            continue
        i += 1  # unknown header line: ignore (version, CRC etc.)

    path = new_path or b_path or old_path or a_path
    if not reject and not path:
        reject = "cannot determine target path"
    if new_path is None and old_path and not reject:
        action = "delete"
    elif old_path is None and new_path and not reject:
        action = "create"
    else:
        action = "modify"
    if not reject and path.endswith("/"):
        reject = "unsupported path"
    return {"path": path, "action": action, "hunks": hunks, "reject": reject}


def _strip_ab(p: str) -> str:
    if p.startswith("a/") or p.startswith("b/"):
        return p[2:]
    return p


def _parse_hunk(section: list[bytes], start: int) -> tuple[dict, int]:
    m = _HUNK_RE.match(section[start].decode("utf-8", "replace"))
    old_start = int(m.group(1))
    old_count = int(m.group(2)) if m.group(2) is not None else 1
    new_start = int(m.group(3))
    new_count = int(m.group(4)) if m.group(4) is not None else 1

    lines: list[tuple[str, bytes, bool]] = []  # (op, text, has_eol)
    old_seen = new_seen = 0
    i = start + 1
    reject = None
    while i < len(section) and (old_seen < old_count or new_seen < new_count):
        ln = section[i]
        i += 1
        if ln.startswith(b"\\ "):  # "\ No newline at end of file"
            if lines:
                op, text, _ = lines[-1]
                lines[-1] = (op, text, False)
            continue
        if ln.startswith(b" "):
            op, text = " ", ln[1:]
            old_seen += 1
            new_seen += 1
        elif ln.startswith(b"-"):
            op, text = "-", ln[1:]
            old_seen += 1
        elif ln.startswith(b"+"):
            op, text = "+", ln[1:]
            new_seen += 1
        else:
            reject = "malformed hunk line"
            break
        # an implicit newline from splitlines means eol is present
        lines.append((op, text, True))
    # a "\ No newline at end of file" marker may sit right after the last
    # counted line — the loop can exit on counts before seeing it
    if (i < len(section) and section[i].startswith(b"\\ ") and lines):
        op, text, _ = lines[-1]
        lines[-1] = (op, text, False)
        i += 1
    if reject is None and (old_seen != old_count or new_seen != new_count):
        reject = "hunk line counts do not match the @@ header"
    hunk = {"old_start": old_start, "old_count": old_count,
            "new_start": new_start, "new_count": new_count,
            "lines": lines}
    if reject:
        hunk = {"reject": reject}
    return hunk, i


# --------------------------------------------------------------------------
# Path safety
# --------------------------------------------------------------------------

def safe_join(tree_root: str, rel_path: str) -> tuple[str | None, str | None]:
    """Resolve rel_path inside tree_root. Returns (abs_path, None) or
    (None, reject_reason). Rejects: absolute paths, '..', empty, backslashes,
    symlink escapes, targets under omlx_uplift/."""
    if not rel_path:
        return None, "empty path"
    if rel_path.startswith("/") or (len(rel_path) > 1 and rel_path[1] == ":"):
        return None, f"absolute path rejected: {rel_path}"
    if "\\" in rel_path:
        return None, f"backslash in path rejected: {rel_path}"
    parts = rel_path.split("/")
    if any(p in ("..", "") for p in parts):
        return None, f"path traversal rejected: {rel_path}"
    first = parts[0]
    if first == "omlx_uplift":
        return None, f"refusing to patch uplift itself: {rel_path}"
    root_real = os.path.realpath(tree_root)
    target = os.path.normpath(os.path.join(root_real, *parts))
    if target != root_real and not target.startswith(root_real + os.sep):
        return None, f"path escapes tree root: {rel_path}"
    # symlink escape: walk each existing component and re-check containment
    cur = root_real
    for p in parts:
        cur = os.path.join(cur, p)
        if os.path.islink(cur):
            real_cur = os.path.realpath(cur)
            if real_cur != root_real and not real_cur.startswith(root_real + os.sep):
                return None, f"symlink escapes tree root: {rel_path}"
    return target, None


# --------------------------------------------------------------------------
# In-memory application (one file)
# --------------------------------------------------------------------------

def _eol_stats(content_lines: list[tuple[bytes, bytes]]) -> tuple[int, int]:
    crlf = lf = 0
    for _text, eol in content_lines:
        if eol == b"\r\n":
            crlf += 1
        elif eol == b"\n":
            lf += 1
    return crlf, lf


def _find_hunk(content: list[tuple[bytes, bytes]], hunk: dict, hint: int,
               reverse: bool) -> int | None:
    """Return the index in content where this hunk's old-side matches exactly,
    or None. git-apply style search: hint first, then +1, -1, +2, -2, ...
    ``reverse`` matches the hunk's NEW side (used to detect 'already applied')."""
    want = [text
            for (op, text, _eol) in hunk["lines"]
            if (op in (" ", "+") if reverse else op in (" ", "-"))]
    n = len(want)
    if n == 0:
        return hint if hint <= len(content) else None
    maxpos = len(content) - n
    if maxpos < 0:
        return None

    def matches(pos: int) -> bool:
        for k, text in enumerate(want):
            c_text, _c_eol = content[pos + k]
            if c_text != text:
                return False
        return True

    seen = set()
    start = max(0, min(hint, maxpos))
    for delta in range(0, max(len(content), 1) + 1):
        cands = [start] if delta == 0 else [start + delta, start - delta]
        for pos in cands:
            if 0 <= pos <= maxpos and pos not in seen:
                seen.add(pos)
                if matches(pos):
                    return pos
    return None


def _apply_file(content: bytes | None, filepatch: dict) -> dict:
    """Strict in-memory apply. Returns {ok, reason?, already?, new_bytes?}."""
    action = filepatch["action"]
    hunks = filepatch["hunks"]

    if action == "create":
        if content not in (None, b""):
            new_bytes, why = _hunks_to_new_file(hunks)
            if new_bytes is not None and content == new_bytes:
                return {"ok": True, "already": True}
            return {"ok": False, "reason": "create: target file already exists"}
        new_bytes, why = _hunks_to_new_file(hunks)
        if new_bytes is None:
            return {"ok": False, "reason": f"create: {why}"}
        return {"ok": True, "new_bytes": new_bytes}

    if content is None:
        if action == "delete":
            return {"ok": True, "already": True}  # file already gone
        return {"ok": False, "reason": f"target file missing: {filepatch['path']}"}

    content_lines = [_split_eol(l) for l in splitlines_keepends(content)]

    # Already-applied detection (honest 'obsolete' state). Meaningful only
    # when the hunk set has a matchable new side (context or additions); a
    # create hunk (empty old side) and a context-less delete have none.
    has_new_side = any(op in (" ", "+") for h in hunks
                       for (op, _t, _e) in h["lines"])
    if has_new_side and _all_hunks(content_lines, hunks, reverse=True) is not None:
        return {"ok": True, "already": True}

    result = _all_hunks(content_lines, hunks, reverse=False)
    if result is None:
        # maybe it is already applied (full new side matches)
        if has_new_side and _all_hunks(content_lines, hunks, reverse=True) is not None:
            return {"ok": True, "already": True}
        return {"ok": False, "reason": "context mismatch — strict apply failed "
                                       "(zero fuzz); hunk(s) do not match file content"}

    new_lines, offsets = result
    crlf, lf = _eol_stats(content_lines)
    out: list[bytes] = []
    for text, eol in new_lines:
        if eol is None:  # added line without original context eol
            eol = b"\r\n" if crlf > lf else b"\n"
        out.append(text + eol)
    new_bytes = b"".join(out)

    if action == "delete":
        if new_bytes != b"":
            return {"ok": False, "reason": "delete: hunks do not cover the whole file"}
        return {"ok": True, "new_bytes": b"", "delete_file": True,
                "offsets": offsets}
    return {"ok": True, "new_bytes": new_bytes, "offsets": offsets}


def _hunks_to_new_file(hunks: list[dict]) -> tuple[bytes | None, str | None]:
    """Content for a create patch: additions only; context/deletes must be empty."""
    out: list[bytes] = []
    crlf_seen = lf_seen = False
    for h in hunks:
        for (op, text, has_eol) in h["lines"]:
            if op == "+":
                has_cr = text.endswith(b"\r")
                if has_cr:
                    text = text[:-1]
                    crlf_seen = True
                elif has_eol:
                    lf_seen = True
                out.append((text, b"\r\n" if has_cr else b"\n", has_eol))
            elif op in (" ", "-"):
                return None, "new-file hunk contains context or delete lines"
    if not out:
        return None, "no added lines"
    dominant = b"\r\n" if (crlf_seen and not lf_seen) else b"\n"
    data = b""
    for text, eol, has_eol in out:
        data += text + (dominant if has_eol else b"")
    return data, None


def _all_hunks(content_lines: list[tuple[bytes, bytes]], hunks: list[dict],
               reverse: bool) -> tuple[list[tuple[bytes, bytes]], list[int]] | None:
    """Apply all hunks of one file in order against an exact match; offsets
    tracked cumulatively (git-apply semantics). None = strict mismatch."""
    work = list(content_lines)
    crlf, lf = _eol_stats(content_lines)
    dominant = b"\r\n" if crlf > lf else b"\n"
    cursor = 0
    offsets: list[int] = []
    for h in hunks:
        hint = h["old_start"] - 1 + cursor
        pos = _find_hunk(work, h, hint, reverse)
        if pos is None:
            return None
        offsets.append(pos - (h["old_start"] - 1))
        cursor += pos - (h["old_start"] - 1)
        if reverse:
            # in-memory un-apply: what IS on disk (context + '+') becomes
            # context + '-' lines of the original
            new_len = sum(1 for (op, _t, _e) in h["lines"] if op in (" ", "+"))
            seg = work[pos : pos + new_len]
            rebuilt: list[tuple[bytes, bytes]] = []
            si = 0
            for (op, text, has_eol) in h["lines"]:
                if op in (" ", "+"):
                    rebuilt.append(seg[si])
                    si += 1
                else:  # '-' — restore the original line, eol inherited from disk
                    base_eol = seg[0][1] if seg and seg[0][1] else b"\n"
                    t = text[:-1] if text.endswith(b"\r") else text
                    rebuilt.append((t, base_eol if has_eol else b""))
            work[pos : pos + new_len] = rebuilt
        else:
            old_len = sum(1 for (op, _t, _e) in h["lines"] if op in (" ", "-"))
            seg = work[pos : pos + old_len]
            ctx_eol = seg[0][1] if seg and seg[0][1] else dominant
            rebuilt = []
            si = 0
            for (op, text, has_eol) in h["lines"]:
                if op == " ":
                    rebuilt.append(seg[si])
                    si += 1
                elif op == "-":
                    si += 1
                else:  # '+' — added line inherits the hunk's eol
                    keep_cr = text.endswith(b"\r")
                    t = text[:-1] if keep_cr else text
                    eol = b"\r\n" if keep_cr else ctx_eol
                    rebuilt.append((t, eol if has_eol else b""))
            work[pos : pos + old_len] = rebuilt
    return work, offsets


# --------------------------------------------------------------------------
# Public modes
# --------------------------------------------------------------------------

def check_diff(diff: bytes | str, tree_root: str) -> dict:
    """Dry-run against a tree. Per-file structured results, no writes.

    {"ok": bool, "reason": str|None,
     "files": [{"path", "status": ok|already|fail, "reason": str|None}]}
    """
    parsed = parse_diff(diff)
    if not parsed["ok"]:
        return {"ok": False, "reason": parsed["reason"], "files": []}

    results = []
    all_ok = True
    for fp in parsed["files"]:
        target, why = safe_join(tree_root, fp["path"])
        if target is None:
            results.append({"path": fp["path"], "status": "fail", "reason": why})
            all_ok = False
            continue
        try:
            with open(target, "rb") as fh:
                content = fh.read()
        except FileNotFoundError:
            content = None
        except OSError as exc:
            results.append({"path": fp["path"], "status": "fail",
                            "reason": f"cannot read: {exc}"})
            all_ok = False
            continue
        res = _apply_file(content, fp)
        if res.get("already"):
            results.append({"path": fp["path"], "status": "already",
                            "reason": "hunks already present (upstream merged?)"})
        elif res.get("ok"):
            results.append({"path": fp["path"], "status": "ok", "reason": None})
        else:
            results.append({"path": fp["path"], "status": "fail",
                            "reason": res.get("reason")})
            all_ok = False
    return {"ok": all_ok, "reason": None if all_ok else "one or more files failed",
            "files": results}


def apply_diff(diff: bytes | str, tree_root: str, backup_dir: str) -> dict:
    """Strict apply with backups of the ORIGINALS. A file that already has a
    backup in backup_dir keeps it (first-touch-per-keg wins), so repeated
    applies stay reversible to pristine vanilla bytes.
    All files must pass check before ANY write (all-or-nothing)."""
    parsed = parse_diff(diff)
    if not parsed["ok"]:
        return {"ok": False, "reason": parsed["reason"], "files": []}

    # resolve + check everything first
    plan = []
    for fp in parsed["files"]:
        target, why = safe_join(tree_root, fp["path"])
        if target is None:
            return {"ok": False, "reason": why, "files": []}
        try:
            with open(target, "rb") as fh:
                content = fh.read()
        except FileNotFoundError:
            content = None
        res = _apply_file(content, fp)
        plan.append((fp, target, content, res))

    failures = [(fp["path"], r) for fp, _t, _c, r in plan if not r.get("ok")
                and not r.get("already")]
    if failures:
        return {"ok": False,
                "reason": "; ".join(f"{p}: {r.get('reason')}" for p, r in failures),
                "files": [{"path": p, "status": "fail"} for p, _r in failures]}

    meta_path = os.path.join(backup_dir, "meta.json")
    meta = _load_backup_meta(meta_path)
    written = []
    os.makedirs(backup_dir, exist_ok=True)
    for fp, target, content, res in plan:
        if res.get("already"):
            written.append({"path": fp["path"], "status": "already"})
            continue
        rel_key = fp["path"]
        if rel_key not in meta["files"]:
            # back up the pristine original (or record absence for creates)
            bpath = _backup_path(backup_dir, rel_key)
            os.makedirs(os.path.dirname(bpath), exist_ok=True)
            if content is not None:
                with open(bpath, "wb") as fh:
                    fh.write(content)
            meta["files"][rel_key] = {"existed": content is not None,
                                      "sha256": (hashlib.sha256(content).hexdigest()
                                                 if content is not None else None)}
            _save_backup_meta(meta_path, meta)
        if res.get("delete_file"):
            try:
                os.remove(target)
            except FileNotFoundError:
                pass
        else:
            _atomic_write(target, res["new_bytes"])
        written.append({"path": fp["path"], "status": "applied"})
    return {"ok": True, "reason": None, "files": written}


def restore_backup(backup_dir: str, tree_root: str) -> dict:
    """Byte-exact rollback of one backup dir into tree_root."""
    meta_path = os.path.join(backup_dir, "meta.json")
    if not os.path.isfile(meta_path):
        return {"ok": False, "reason": f"no backup meta at {meta_path}", "files": []}
    meta = _load_backup_meta(meta_path)
    restored = []
    for rel_key, info in sorted(meta["files"].items()):
        target, why = safe_join(tree_root, rel_key)
        if target is None:
            return {"ok": False, "reason": why, "files": restored}
        if info.get("existed"):
            bpath = _backup_path(backup_dir, rel_key)
            try:
                with open(bpath, "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                return {"ok": False, "reason": f"backup unreadable: {exc}",
                        "files": restored}
            if (info.get("sha256") and
                    hashlib.sha256(data).hexdigest() != info["sha256"]):
                return {"ok": False, "reason": f"backup corrupt for {rel_key}",
                        "files": restored}
            _atomic_write(target, data)
            restored.append({"path": rel_key, "status": "restored"})
        else:
            try:
                os.remove(target)
            except FileNotFoundError:
                pass
            except OSError as exc:
                return {"ok": False, "reason": f"cannot remove created file: {exc}",
                        "files": restored}
            restored.append({"path": rel_key, "status": "removed"})
    return {"ok": True, "reason": None, "files": restored}


# --------------------------------------------------------------------------
# Backup storage helpers (shared layout with patches.py)
# --------------------------------------------------------------------------

def _backup_path(backup_dir: str, rel_path: str) -> str:
    return os.path.join(backup_dir, "files", *rel_path.split("/"))


def _load_backup_meta(meta_path: str) -> dict:
    import json

    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        if not isinstance(meta.get("files"), dict):
            meta["files"] = {}
        return meta
    except (OSError, ValueError):
        return {"files": {}}


def _save_backup_meta(meta_path: str, meta: dict) -> None:
    import json

    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    tmp = meta_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, meta_path)


def _atomic_write(target: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".uplift-tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    # keep original mode when the file exists (never change modes ourselves)
    try:
        st = os.stat(target)
        os.chmod(tmp, st.st_mode & 0o7777)
    except OSError:
        pass
    os.replace(tmp, target)
