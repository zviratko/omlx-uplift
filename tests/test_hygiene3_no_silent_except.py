"""HYGIENE-3: no broad exception handler may swallow an error silently.

A handler that catches Exception (or everything) must log, narrow its type,
or do real fallback work - a body of only `pass` hid failures from the log.
"""
import ast
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "omlx_uplift"


def _silent_handlers():
    out = []
    for f in sorted(PKG.rglob("*.py")):
        for n in ast.walk(ast.parse(f.read_text())):
            if not isinstance(n, ast.ExceptHandler):
                continue
            t = n.type
            broad = t is None or (isinstance(t, ast.Name)
                                  and t.id in ("Exception", "BaseException"))
            if broad and len(n.body) == 1 and isinstance(n.body[0], ast.Pass):
                out.append(f"{f.relative_to(PKG.parent)}:{n.lineno}")
    return out


def test_no_silent_broad_except():
    assert _silent_handlers() == []
