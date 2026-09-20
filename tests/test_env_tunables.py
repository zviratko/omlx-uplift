"""ENV-1 acceptance: uplift experimental env tunables.

1. Precedence: a genuine launch-time env var WINS — seed_environ records it
   in SHADOWED and does not overwrite os.environ; absent names are seeded.
2. Shadowed PUT: value persists to JSON, os.environ untouched, result
   'shadowed'. Delete of a shadowed key leaves the genuine env value.
3. Validation: unknown key 400, bad type 400, out-of-range 400
   (all-or-nothing: nothing persisted when one key is bad).
4. Atomic write: save_overrides leaves no tmp files, survives reopen;
   corrupt/missing JSON loads as {}.
5. Live apply per effect class: immediate -> os.environ now; model ->
   os.environ seeded for the next engine construction; server -> JSON only.
"""
import asyncio
import json
import os

import pytest
from fastapi import HTTPException

from omlx_uplift import env_tunables as et


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    """Fresh store + empty SHADOWED per test; OMLX_* env writes undone after."""
    path = tmp_path / "env_overrides.json"
    monkeypatch.setattr(et, "_BASE_DIR", tmp_path)
    et.SHADOWED.clear()
    before = {k: v for k, v in os.environ.items() if k.startswith("OMLX_")}

    yield path

    et.SHADOWED.clear()
    for k in list(os.environ):
        if k.startswith("OMLX_") and k not in before:
            del os.environ[k]
    for k, v in before.items():
        os.environ[k] = v


# -- 1. precedence ------------------------------------------------------------

def test_seed_env_wins_over_stored(_clean, monkeypatch):
    path = _clean
    monkeypatch.setenv("OMLX_CHUNK_SNAP", "1")  # genuine launch env
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "x"}}, path)
    seeded = et.seed_environ(path)

    assert seeded == {}
    assert os.environ["OMLX_CHUNK_SNAP"] == "1"  # NOT overwritten
    assert "OMLX_CHUNK_SNAP" in et.SHADOWED


def test_seed_fills_gaps(_clean):
    path = _clean
    os.environ.pop("OMLX_CHUNK_SNAP", None)
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "x"}}, path)
    seeded = et.seed_environ(path)

    assert seeded == {"OMLX_CHUNK_SNAP": "0"}
    assert os.environ["OMLX_CHUNK_SNAP"] == "0"
    assert "OMLX_CHUNK_SNAP" not in et.SHADOWED


# -- 2/3/5. router semantics (call handlers directly; auth injected) ---------

def _put(body):
    from omlx_uplift import router

    return asyncio.run(router.put_env_overrides(body, is_admin=True))


def _get():
    from omlx_uplift import router

    return asyncio.run(router.get_env_overrides(is_admin=True))


def test_put_immediate_live_apply(_clean):
    r = _put({"OMLX_CHUNK_SNAP": "0"})
    assert r["results"]["OMLX_CHUNK_SNAP"] == "applied_live"
    assert os.environ["OMLX_CHUNK_SNAP"] == "0"
    assert r["values"]["OMLX_CHUNK_SNAP"] == "0"


def test_put_model_effect_seeds_for_next_engine(_clean):
    r = _put({"OMLX_DECODE_BURST_MAX_STEPS": 128})
    assert r["results"]["OMLX_DECODE_BURST_MAX_STEPS"] == "restart_model"
    # engine construction re-reads os.environ on model reload
    assert os.environ["OMLX_DECODE_BURST_MAX_STEPS"] == "128"


def test_put_server_effect_json_only(_clean):
    r = _put({"OMLX_DECODE_FAIR_SHARE": 0.7})
    assert r["results"]["OMLX_DECODE_FAIR_SHARE"] == "restart_server"
    assert "OMLX_DECODE_FAIR_SHARE" not in os.environ  # not live-applied
    assert r["values"]["OMLX_DECODE_FAIR_SHARE"] == "0.7"


def test_put_shadowed_stores_but_never_writes(_clean, monkeypatch):
    """ENV-3 sanity: with a shadow present, NO os.environ write happens."""
    path = _clean
    monkeypatch.setenv("OMLX_CHUNK_SNAP", "1")
    et.SHADOWED.add("OMLX_CHUNK_SNAP")

    r = _put({"OMLX_CHUNK_SNAP": "0"})
    assert r["results"]["OMLX_CHUNK_SNAP"] == "shadowed"
    assert os.environ["OMLX_CHUNK_SNAP"] == "1"        # genuine env untouched
    assert json.loads(path.read_text())["OMLX_CHUNK_SNAP"]["value"] == "0"

    # delete: JSON entry removed, genuine env value stays
    r = _put({"OMLX_CHUNK_SNAP": None})
    assert r["results"]["OMLX_CHUNK_SNAP"] == "shadowed"
    assert "OMLX_CHUNK_SNAP" not in json.loads(path.read_text())
    assert os.environ["OMLX_CHUNK_SNAP"] == "1"


def test_put_unknown_key_400(_clean):
    with pytest.raises(HTTPException) as e:
        _put({"OMLX_NOT_A_TUNABLE": "1"})
    assert e.value.status_code == 400


def test_put_type_and_range_validation_400(_clean):
    for bad in ({"OMLX_DECODE_BURST_MAX_STEPS": "abc"},
                {"OMLX_DECODE_FAIR_SHARE": 4.0},     # max 1.0
                {"OMLX_MTP_PRIME_WINDOW": -5},       # min 0
                {"OMLX_CHUNK_SNAP": "maybe"}):
        with pytest.raises(HTTPException) as e:
            _put(bad)
        assert e.value.status_code == 400


def test_put_all_or_nothing(_clean):
    path = _clean
    with pytest.raises(HTTPException):
        _put({"OMLX_CHUNK_SNAP": "1", "OMLX_DECODE_FAIR_SHARE": 99})
    assert et.load_overrides(path) == {}   # nothing persisted


def test_put_bool_coercion(_clean):
    r = _put({"OMLX_CONTINUOUS_BATCHING": True})
    assert r["values"]["OMLX_CONTINUOUS_BATCHING"] == "1"


def test_put_rejects_empty_body(_clean):
    with pytest.raises(HTTPException) as e:
        _put({})
    assert e.value.status_code == 400


# -- 4. store hygiene ---------------------------------------------------------

def test_save_atomic_no_tmp_leftovers(_clean):
    path = _clean
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "t"}}, path)
    assert et.load_overrides(path) == {"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "t"}}
    leftovers = [p.name for p in path.parent.iterdir() if p.name.startswith(".env_overrides.")]
    assert leftovers == []


def test_load_corrupt_and_unknown_keys(_clean):
    path = _clean
    path.write_text("{not json")
    assert et.load_overrides(path) == {}
    path.write_text('{"OMLX_UNKNOWN": {"value": "1"}, "OMLX_CHUNK_SNAP": {"value": "0"}}')
    assert et.load_overrides(path) == {"OMLX_CHUNK_SNAP": {"value": "0", "set_at": ""}}


def test_snapshot_shape(_clean):
    snap = _get()
    names = {a["name"] for a in snap["allowed"]}
    assert names == set(et.ALLOWED)
    assert all(a["effect"] in ("immediate", "model", "server") for a in snap["allowed"])


def test_mask_hides_middle():
    assert et.mask("12345678") == "12••••78"
    assert et.mask("ab") == "••"


def test_autopatch_seeding_is_import_safe():
    """A fresh interpreter with a garbage override file must boot cleanly."""
    import subprocess
    import sys

    p = subprocess.run(
        [sys.executable, "-c",
         "import os, tempfile, pathlib;"
         "d = tempfile.mkdtemp();"
         "(pathlib.Path(d)/'env_overrides.json').write_text('{{{');"
         "from omlx_uplift import env_tunables as et;"
         "et.set_base_dir(d);"
         "assert et.seed_environ() == {}; print('OK')"],
        capture_output=True, text=True, timeout=60)
    assert "OK" in p.stdout, p.stderr
