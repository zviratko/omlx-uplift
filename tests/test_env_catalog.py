"""ENV-3/ENV-4 acceptance: the env-catalog documentation + edit surface.

1. Shape: every row carries name/effect/group/default/desc and legal values.
2. Completeness: every editable tunable is also documented, and every
   documented settable row says settable.
3. Live state: catalog() reports present/live from os.environ, stored from the
   uplift override file, and masks secret-ish values.
4. Route: GET /uplift/api/env-catalog returns {vars: [...]} shaped like (1).
5. ENV-4 consistency: ALLOWED is derived, so no name can be simultaneously
   editable and owned by vanilla (the OMLX_CONTINUOUS_BATCHING contradiction),
   every type is legal and agrees with its stock default, and the surface is
   closed on the vanilla runtime.
"""
from unittest.mock import patch

import pytest

from omlx_uplift import env_tunables as et
from omlx_uplift.routers import policy as up_p

VALID_EFFECTS = {"immediate", "model", "server"}
VALID_GROUPS = {"scheduler", "memory", "engine", "attention", "quantization",
                "moe", "mtp", "prefill", "cluster", "integrations", "server"}
VALID_TYPES = {"bool", "int", "float", "str"}


@pytest.fixture(autouse=True)
def _dev_runtime():
    """ENV-4: the catalog reports settable/stored only on omlx-dev. Tests that
    assert the editable shape opt in; paths.is_dev_prefix deliberately does
    not treat this repo's ~/venvs/omlx-dev test interpreter as the dev keg."""
    et.set_dev_runtime(True)
    yield
    et.set_dev_runtime(None)


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


# -- 5. ENV-4 derivation consistency ------------------------------------------

def test_types_cover_the_catalog_exactly():
    assert set(et.TYPES) == set(et.CATALOG)
    assert all(t in VALID_TYPES for t in et.TYPES.values())


def test_manual_specs_name_editable_vars_only():
    """The guard for the bug this release fixes: a name listed as a hand-tuned
    tunable while CATALOG flags it vanilla-owned is a silent contradiction —
    the UI shows a control, the server refuses the write."""
    for name in et.MANUAL:
        spec = et.CATALOG.get(name)
        assert spec is not None, f"MANUAL documents unknown var {name}"
        assert name in et.ALLOWED, (
            f"{name} has a manual spec but is not editable "
            f"(managed={bool(spec.get('managed'))} dead={bool(spec.get('dead'))} "
            f"secret={et.is_secret(name)})")


def test_editable_set_is_documented_and_excludes_owned():
    for name, spec in et.CATALOG.items():
        editable = name in et.ALLOWED
        assert editable == (not spec.get("managed") and not spec.get("dead")
                            and not et.is_secret(name)), name
    assert len(et.ALLOWED) > 100, "ENV-4 opened the surface beyond the ten originals"
    # the exclusions that motivated the flags must actually be excluded
    for name in ("OMLX_MAX_NUM_SEQS", "MODELSCOPE_DOMAIN", "OMLX_BASE_PATH",
                 "OMLX_DECODE_BURST_BUDGET_SINGLE_S", "OMLX_DECODE_BURST_MAX_STEPS",
                 "OMLX_CONTINUOUS_BATCHING", "OMLX_MODEL", "OMLX_SECRET_KEY",
                 "OMLX_CLUSTER_SSH_HOST_PUBLIC_KEY"):
        assert name not in et.ALLOWED, f"{name} must not be editable"


def test_spec_type_matches_the_documented_default():
    """A stock default that cannot parse as the declared type means one of the
    two was derived wrong — this caught OMLX_DECODE_STALL_TARGET_MS (vanilla
    casts float, ENV-1 declared int)."""
    for name, spec in et.ALLOWED.items():
        d = (spec["default"] or "").strip()
        if not d:
            continue
        t = spec["type"]
        if t == "int":
            int(d)
        elif t == "float":
            float(d)
        elif t == "bool":
            assert d in ("0", "1", "true", "false"), f"{name}: default {d!r} not a flag"


def test_every_spec_is_ui_shaped():
    for name, spec in et.ALLOWED.items():
        assert spec["label"] and spec["desc"], name
        assert spec["type"] in VALID_TYPES, name
        assert spec["effect"] in VALID_EFFECTS, name
        assert not name.startswith("_")
    # no inline row may fall back to a mangled auto-label in a settings section
    for name, spec in et.ALLOWED.items():
        if spec["group"] in ("mtp", "scheduler", "memory", "engine"):
            assert name in et.MANUAL, f"{name} renders inline without a label"


def test_truthy_word_is_only_for_flags():
    for name in et.TRUTHY_WORD:
        assert name not in et.MANUAL or et.MANUAL[name].get("type") != "int"
        spec = et.ALLOWED.get(name)
        if spec is not None:
            assert spec["type"] == "bool", name


def test_catalog_reports_nothing_settable_on_vanilla():
    et.set_dev_runtime(False)
    try:
        rows = et.catalog()
        assert not any(r["settable"] for r in rows)
        assert not any(r.get("stored") for r in rows)
        assert et.snapshot()["allowed"] == []
    finally:
        et.set_dev_runtime(True)


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
    assert secret["secret"] is True and not secret["settable"]


def test_managed_and_dead_rows_are_flagged():
    rows = {r["name"]: r for r in _rows()}
    assert rows["OMLX_BASE_PATH"]["managed"] is True
    assert rows["OMLX_CONTINUOUS_BATCHING"]["managed"] is True
    assert rows["OMLX_CONTINUOUS_BATCHING"]["dead"] is True
    assert rows["OMLX_NAX_JIT_ATTENTION"].get("managed") is None
    assert rows["OMLX_NAX_JIT_ATTENTION"]["settable"] is True


def test_catalog_route():
    import asyncio

    with patch.object(up_p, "require_admin", return_value=True):
        d = asyncio.run(up_p.get_env_catalog(is_admin=True))
    assert set(d) == {"dev", "vars"}
    assert d["dev"] is True
    assert any(r["name"] == "OMLX_CHUNK_SNAP" and r["settable"] for r in d["vars"])
