"""HYGIENE-2: the public tree carries no LAN addresses or private host names.

Private IPv4 ranges are checked everywhere (CI included). Host names are
private themselves, so they are not listed here: the check reads them from
~/.config/omlx-uplift/private-patterns when that file exists (the devbox and
its nightly run) and skips that half elsewhere. scripts/hooks/pre-commit
applies the same rules to every staged change.
"""
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_IP = re.compile(r"(?<![\d.])(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)"
                        r"\.\d{1,3}\.\d{1,3}(?![\d.])")
SKIP = ("omlx_uplift/bench_tasks/",)          # third-party exam datasets


def _tracked():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True)
    if out.returncode != 0:
        pytest.skip("not a git checkout")
    for rel in out.stdout.decode().split("\0"):
        if rel and not rel.startswith(SKIP):
            p = ROOT / rel
            try:
                yield rel, p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
                continue


def _hits(rx):
    return [f"{rel}:{n}" for rel, text in _tracked()
            for n, line in enumerate(text.splitlines(), 1) if rx.search(line)]


def test_no_private_ip_addresses():
    assert _hits(PRIVATE_IP) == []


def test_no_private_host_names():
    f = Path(os.environ.get("OMLX_UPLIFT_PRIVATE_PATTERNS",
                            Path.home() / ".config/omlx-uplift/private-patterns"))
    if not f.is_file():
        pytest.skip("no private-patterns file on this machine")
    pats = [l.strip() for l in f.read_text().splitlines()
            if l.strip() and not l.lstrip().startswith("#")]
    if not pats:
        pytest.skip("private-patterns file is empty")
    rx = re.compile("|".join(f"(?:{p})" for p in pats), re.I)
    assert _hits(rx) == []
