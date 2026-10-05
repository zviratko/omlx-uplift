"""ENV-3 acceptance: the env-catalog documentation surface.

1. Shape: every row carries name/effect/group/default/desc and legal values.
2. Completeness: every ALLOWED (settable) tunable is also documented, and
   every documented settable row says settable.
3. Live state: catalog() reports present/live from os.environ, stored from
   the uplift override file, and masks secret-ish values.
4. Route: GET /uplift/api/env-catalog returns {vars: [...]} shaped like (1).
"""
from unittest.mock import patch

from omlx_uplift import env_tunables as et
from omlx_uplift.routers import policy as up_p

VALID_EFFECTS = {"immediate", "model", "server"}
VALID_GROUPS = {"scheduler", "memory", "engine", "attention", "quantization",
                "moe", "mtp", "prefill", "cluster", "integrations", "server"}


def _rows():
    return et.catalog()


def test_catalog_shape():
    rows = _rows()
    assert len(rows) >= 100, "catalog documents the whole env-only surface"
    names = {r["name"] for r in rows}
    assert len(names) == len(rows), "no duplicate names"
    for r in rows:
        assert r["effect"] in VALID_EFFECTS, r
        assert r["group"] in VALID_GROUPS, r
        assert r.get("desc"), f"{r['name']} needs a description"
        assert isinstance(r["settable"], bool)
        assert isinstance(r["default"], str)


def test_every_allowed_tunable_is_documented():
    names = {r["name"] for r in _rows()}
    for allowed in et.ALLOWED:
        assert allowed in names, f"{allowed} settable but undocumented"
    for r in _rows():
        if r["settable"]:
            assert r["name"] in et.ALLOWED


def test_catalog_live_state(monkeypatch, tmp_path):
    monkeypatch.setattr(et, "_BASE_DIR", tmp_path)
    et.save_overrides({"OMLX_DECODE_FAIR_SHARE": {"value": "0.7", "set_at": "x"}})
    monkeypatch.setenv("OMLX_CHUNK_SNAP", "0")
    monkeypatch.setenv("OMLX_SECRET_KEY", "supersecretvalue")
    rows = {r["name"]: r for r in _rows()}

    live = rows["OMLX_CHUNK_SNAP"]
    assert live["present"] and live["live"] == "0"
    stored = rows["OMLX_DECODE_FAIR_SHARE"]
    assert stored["stored"] == "0.7" and not stored["present"]
    secret = rows["OMLX_SECRET_KEY"]
    assert secret["present"] and secret["live"] == et.mask("supersecretvalue")
    assert "supersecretvalue" not in secret["live"]


def test_catalog_route():
    import asyncio

    with patch.object(up_p, "require_admin", return_value=True):
        d = asyncio.run(up_p.get_env_catalog(is_admin=True))
    assert set(d) == {"vars"}
    assert any(r["name"] == "OMLX_CHUNK_SNAP" and r["settable"] for r in d["vars"])
