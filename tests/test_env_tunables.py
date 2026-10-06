"""ENV-1/ENV-4 acceptance: uplift experimental env tunables.

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
6. ENV-4 DEV-only: the vanilla runtime seeds nothing, reports nothing
   settable and refuses writes with 403; a documented-but-owned name gets the
   reason. disable-all persists and survives a re-seed.
"""
import asyncio
import json
import os

import pytest
from fastapi import HTTPException

from omlx_uplift import env_tunables as et


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    """Fresh store + empty SHADOWED per test; OMLX_* env writes undone after.

    ENV-4: tests opt INTO the dev runtime explicitly. This repo's test
    interpreter lives in ~/venvs/omlx-dev, and paths.is_dev_prefix
    deliberately does not treat that as the dev keg — a test that relied on
    the name would prove nothing about the gate.
    """
    path = tmp_path / et.OVERRIDES_FILENAME
    monkeypatch.setattr(et, "_BASE_DIR", tmp_path)
    et.set_dev_runtime(True)
    et.SHADOWED.clear()
    before = {k: v for k, v in os.environ.items() if k.startswith("OMLX_")
              or k.startswith("MLX_")}

    yield path

    et.SHADOWED.clear()
    et.set_dev_runtime(None)
    for k in list(os.environ):
        if (k.startswith("OMLX_") or k.startswith("MLX_")) and k not in before:
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
    r = _put({"OMLX_DECODE_BURST_BUDGET_S": 0.05})
    assert r["results"]["OMLX_DECODE_BURST_BUDGET_S"] == "restart_model"
    # engine construction re-reads os.environ on model reload
    assert os.environ["OMLX_DECODE_BURST_BUDGET_S"] == "0.05"


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
    doc = json.loads(path.read_text())
    assert doc["vars"]["OMLX_CHUNK_SNAP"]["value"] == "0"

    # delete: JSON entry removed, genuine env value stays
    r = _put({"OMLX_CHUNK_SNAP": None})
    assert r["results"]["OMLX_CHUNK_SNAP"] == "shadowed"
    assert "OMLX_CHUNK_SNAP" not in json.loads(path.read_text())["vars"]
    assert os.environ["OMLX_CHUNK_SNAP"] == "1"


def test_put_unknown_key_400(_clean):
    with pytest.raises(HTTPException) as e:
        _put({"OMLX_NOT_A_TUNABLE": "1"})
    assert e.value.status_code == 400


def test_put_type_and_range_validation_400(_clean):
    for bad in ({"OMLX_CONTENDED_PREFILL_CHUNK": "abc"},
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
    r = _put({"OMLX_CHUNK_SNAP": True})
    assert r["values"]["OMLX_CHUNK_SNAP"] == "1"


def test_put_bool_honours_the_word_true(_clean):
    """ENV-4: TRUTHY_WORD vars must be written the way vanilla compares them.
    OMLX_OQ_STREAM_CALIBRATION is read as `env in ("1","true","yes","on")` —
    a UI that always wrote 1 would still work, but a var compared with
    == "true" only fires on the word, so coercion has to know the difference.
    """
    assert et.truthy_word("OMLX_OQ_STREAM_CALIBRATION") == "true"
    assert et.coerce("OMLX_OQ_STREAM_CALIBRATION", "on") == "true"
    assert et.coerce("OMLX_OQ_STREAM_CALIBRATION", "0") == "false"
    # and a plain flag still gets 1/0
    assert et.truthy_word("OMLX_CHUNK_SNAP") == "1"
    assert et.coerce("OMLX_CHUNK_SNAP", "true") == "1"


# -- 6. ENV-4 DEV-only --------------------------------------------------------

def test_vanilla_runtime_seeds_nothing(_clean, monkeypatch):
    path = _clean
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "x"}}, path)
    et.set_dev_runtime(False)
    try:
        os.environ.pop("OMLX_CHUNK_SNAP", None)
        assert et.seed_environ(path) == {}
        assert "OMLX_CHUNK_SNAP" not in os.environ
        assert et.SHADOWED == set()
        snap = _get()
        assert snap["dev"] is False and snap["allowed"] == [] and snap["values"] == {}
        rows = {r["name"]: r for r in et.catalog()}
        assert not any(r["settable"] for r in rows.values())
    finally:
        et.set_dev_runtime(True)


def test_vanilla_runtime_refuses_writes(_clean):
    et.set_dev_runtime(False)
    try:
        with pytest.raises(HTTPException) as e:
            _put({"OMLX_CHUNK_SNAP": "0"})
        assert e.value.status_code == 403
        assert "omlx-dev" in e.value.detail
    finally:
        et.set_dev_runtime(True)


def test_managed_name_gets_the_reason(_clean):
    """A documented-but-owned variable is 403 with a sentence, not a 400 that
    reads like a typo — the whole point of MANAGED is 'vanilla owns this'."""
    with pytest.raises(HTTPException) as e:
        _put({"OMLX_MAX_NUM_SEQS": "8"})
    assert e.value.status_code == 403
    assert "owns" in e.value.detail

    with pytest.raises(HTTPException) as e:
        _put({"OMLX_CONTINUOUS_BATCHING": "true"})
    assert e.value.status_code == 403
    assert "no live oMLX code path" in e.value.detail


def test_delete_of_a_no_longer_editable_name_still_works(_clean):
    """A var vanilla took over must stay clearable from our store."""
    et.save_overrides({"OMLX_DECODE_BURST_MAX_STEPS": {"value": "99", "set_at": "x"}},
                      _clean)
    r = _put({"OMLX_DECODE_BURST_MAX_STEPS": None})
    assert r["results"]["OMLX_DECODE_BURST_MAX_STEPS"] == "removed"
    assert et.load_overrides(_clean) == {}


def test_disable_all_persists_across_reseed(_clean):
    path = _clean
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "x"}}, path)
    et.set_seeding_enabled(False, path)
    os.environ.pop("OMLX_CHUNK_SNAP", None)
    assert et.seed_environ(path) == {}
    assert "OMLX_CHUNK_SNAP" not in os.environ
    assert et.seeding_enabled(path) is False
    # a later value edit must NOT silently re-arm the switch
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "1", "set_at": "y"}}, path)
    assert et.seeding_enabled(path) is False
    et.set_seeding_enabled(True, path)
    assert et.seed_environ(path) == {"OMLX_CHUNK_SNAP": "1"}


def test_legacy_env_overrides_file_is_adopted(tmp_path, monkeypatch):
    """ENV-1 wrote a flat {VAR: {...}} map into env_overrides.json; ENV-4 reads
    it when env.json is absent so an existing override is not orphaned."""
    legacy = tmp_path / et.LEGACY_OVERRIDES_FILENAME
    legacy.write_text(json.dumps({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "t"}}))
    monkeypatch.setattr(et, "_BASE_DIR", tmp_path)
    assert et.load_overrides() == {"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "t"}}
    assert et.seeding_enabled() is True


def test_put_rejects_empty_body(_clean):
    with pytest.raises(HTTPException) as e:
        _put({})
    assert e.value.status_code == 400


# -- 4. store hygiene ---------------------------------------------------------

def test_save_atomic_no_tmp_leftovers(_clean):
    path = _clean
    et.save_overrides({"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "t"}}, path)
    assert et.load_overrides(path) == {"OMLX_CHUNK_SNAP": {"value": "0", "set_at": "t"}}
    leftovers = [p.name for p in path.parent.iterdir() if p.name.startswith(".env.")]
    assert leftovers == []


def test_load_corrupt_and_unknown_keys(_clean):
    path = _clean
    path.write_text("{not json")
    assert et.load_overrides(path) == {}
    path.write_text('{"vars": {"OMLX_UNKNOWN": {"value": "1"}, '
                    '"OMLX_CHUNK_SNAP": {"value": "0"}}}')
    assert et.load_overrides(path) == {"OMLX_CHUNK_SNAP": {"value": "0", "set_at": ""}}
    # a var vanilla owns cannot be resurrected from the file either
    path.write_text('{"vars": {"OMLX_MAX_NUM_SEQS": {"value": "8"}}}')
    assert et.load_overrides(path) == {}


def test_snapshot_shape(_clean):
    snap = _get()
    names = {a["name"] for a in snap["allowed"]}
    assert names == set(et.ALLOWED)
    assert all(a["effect"] in ("immediate", "model", "server") for a in snap["allowed"])
    assert snap["dev"] is True and snap["seeding_enabled"] is True


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
