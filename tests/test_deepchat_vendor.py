"""NAT-4 vendor gate: the vendored deep-chat bundle must match its
manifest (version, sha256, size) and must not reach out to the network
by itself. The offline audit (NAT-1 probe item 8) ran against the S1
drill; this test keeps it true for every future vendor commit — an
upgrade is one deliberate edit of MANIFEST.json + this gate."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

VENDOR = Path(__file__).resolve().parents[1] / "omlx_uplift" / "static" / "vendor" / "deep-chat"


@pytest.fixture(scope="module")
def manifest():
    return json.loads((VENDOR / "MANIFEST.json").read_text())


def test_bundle_matches_manifest(manifest):
    raw = (VENDOR / manifest["file"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest["sha256"], \
        "bundle drifted from MANIFEST.json — re-pin deliberately (NAT-4 rule)"
    assert len(raw) == manifest["bytes"]


def test_license_shipped(manifest):
    text = (VENDOR / manifest["license_file"]).read_text()
    assert "MIT License" in text


def test_version_in_filename_and_manifest(manifest):
    assert manifest["version"] in manifest["file"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"])


def test_bundle_self_registers_custom_element(manifest):
    text = (VENDOR / manifest["file"]).read_text()
    assert 'customElements.define("deep-chat"' in text


def test_bundle_no_dynamic_or_bare_imports(manifest):
    """Offline serving guarantee: the bundle may only end with its own
    export statement (ESM), import nothing, and fetch no CDN script.
    The ESM import grammar is checked at statement boundaries only —
    the bundle legitimately contains a class method named `import`
    (the settings import-button handler `t.import.bind`), which is NOT
    an ESM import."""
    text = (VENDOR / manifest["file"]).read_text()
    assert not re.search(r"""(^|[;}\n])\s*import\s*[{*"']""", text), "bare import found"
    # dynamic import() always opens on a string/template literal; the
    # method definition `import(t){` (params -> body) must NOT match
    assert not re.search(r"import\s*\(\s*[`'\"uUhx/]", text), "dynamic import found"
    assert not re.search(r"\bawait\s+import\b", text), "await import found"
    for cdn in ("unpkg.com", "jsdelivr", "esm.sh", "cdn.", "/dist/deepChat.css"):
        assert cdn not in text, f"CDN reference {cdn} in bundle"


def test_static_route_media_type(manifest):
    """pages._MEDIA_TYPES serves .js; the vendor path rides the same
    gate (require_admin) — a typo'd suffix would serve octet-stream and
    kill ESM loading silently."""
    from omlx_uplift.routers.pages import _MEDIA_TYPES
    assert _MEDIA_TYPES[Path(manifest["file"]).suffix] == "application/javascript"
