"""ENV-4 acceptance: `omlx-uplift env` — the CLI side of the dev override store.

The CLI never runs inside the dev keg, so it must reach the DEV instance's
file through dev.json rather than its own runtime. These tests drive the
command with the store redirected into tmp_path.
"""
import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout

import pytest

from omlx_uplift import cli, env_tunables as et


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A dev store in tmp_path; SHADOWED/seed state restored after."""
    path = tmp_path / et.OVERRIDES_FILENAME
    monkeypatch.setattr(et, "dev_store_path", lambda: path)
    et.SHADOWED.clear()
    yield path
    et.SHADOWED.clear()


def _run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.cmd_env(list(argv))
    return rc, out.getvalue(), err.getvalue()


def test_list_on_empty_store(store):
    rc, out, _ = _run()
    assert rc == 0
    assert "no overrides stored" in out
    assert "seeding at dev startup: ON" in out


def test_set_stores_and_reports_effect(store):
    rc, out, _ = _run("set", "OMLX_DECODE_FAIR_SHARE", "0.7")
    assert rc == 0
    doc = json.loads(store.read_text())
    assert doc["vars"]["OMLX_DECODE_FAIR_SHARE"]["value"] == "0.7"
    assert doc["enabled"] is True
    assert "server" in out           # honest restart class, not a promise


def test_set_rejects_out_of_range(store):
    rc, _, err = _run("set", "OMLX_DECODE_FAIR_SHARE", "4.0")
    assert rc == 2
    assert "maximum is 1.0" in err
    assert not store.exists()        # nothing written


def test_set_rejects_unknown_name(store):
    rc, _, err = _run("set", "OMLX_TOTALLY_MADE_UP", "1")
    assert rc == 2
    assert "unknown tunable" in err
    assert "free-form" in err


@pytest.mark.parametrize("name,reason", [
    ("OMLX_MAX_NUM_SEQS", "owns"),
    ("OMLX_CONTINUOUS_BATCHING", "no live oMLX code path"),
    ("OMLX_SECRET_KEY", "credential"),
])
def test_set_names_the_reason(store, name, reason):
    """The CLI and PUT /env-overrides share not_editable_reason, so the two
    surfaces cannot explain the same refusal differently."""
    rc, _, err = _run("set", name, "1")
    assert rc == 2
    assert reason in err


def test_set_uses_the_truthy_spelling(store):
    """A flag vanilla compares against the word true must be written as the
    word, from the CLI too — 'on' is accepted, 'true' is stored."""
    rc, _, _ = _run("set", "OMLX_OQ_STREAM_CALIBRATION", "on")
    assert rc == 0
    assert json.loads(store.read_text())["vars"][
        "OMLX_OQ_STREAM_CALIBRATION"]["value"] == "true"


def test_set_empty_value_is_rejected_not_stored(store):
    rc, _, err = _run("set", "OMLX_CHUNK_SNAP", "")
    assert rc == 2
    assert "reset" in err


def test_reset_removes_one(store):
    _run("set", "OMLX_CHUNK_SNAP", "0")
    rc, out, _ = _run("reset", "OMLX_CHUNK_SNAP")
    assert rc == 0
    assert json.loads(store.read_text())["vars"] == {}
    assert "removed" in out


def test_reset_of_absent_name_is_not_an_error(store):
    rc, out, _ = _run("reset", "OMLX_CHUNK_SNAP")
    assert rc == 0
    assert "no stored override" in out


def test_disable_all_keeps_values_and_blocks_seeding(store, monkeypatch):
    _run("set", "OMLX_CHUNK_SNAP", "0")
    rc, out, _ = _run("disable-all")
    assert rc == 0
    doc = json.loads(store.read_text())
    assert doc["enabled"] is False
    assert "OMLX_CHUNK_SNAP" in doc["vars"], "disable must not delete values"
    monkeypatch.setattr(et, "_BASE_DIR", store.parent)
    et.set_dev_runtime(True)
    try:
        import os
        os.environ.pop("OMLX_CHUNK_SNAP", None)
        assert et.seed_environ(store) == {}
        assert "OMLX_CHUNK_SNAP" not in os.environ
    finally:
        et.set_dev_runtime(None)
        os.environ.pop("OMLX_CHUNK_SNAP", None)


def test_enable_all_restores_seeding(store):
    _run("disable-all")
    rc, _, _ = _run("enable-all")
    assert rc == 0
    assert json.loads(store.read_text())["enabled"] is True


def test_secret_name_cannot_be_listed_or_seeded(store):
    """A credential is excluded from ALLOWED, so _vars_only drops it on load:
    it can be neither listed nor seeded, even hand-planted in the file.
    (This is why `list` needs no mask — nothing secret survives the read.)"""
    secret_value = "sup3r-s3cret-token"
    store.write_text(json.dumps(
        {"enabled": True,
         "vars": {"OMLX_SECRET_KEY": {"value": secret_value, "set_at": "x"},
                  "OMLX_CHUNK_SNAP": {"value": "0", "set_at": "x"}}}))
    rc, out, _ = _run("list")
    assert rc == 0
    assert secret_value not in out
    assert "OMLX_SECRET_KEY" not in out
    assert "OMLX_CHUNK_SNAP" in out
    assert et.load_overrides(store) == {
        "OMLX_CHUNK_SNAP": {"value": "0", "set_at": "x"}}


def test_json_output_shape(store):
    _run("set", "OMLX_CHUNK_SNAP", "0")
    rc, out, _ = _run("list", "--json")
    assert rc == 0
    d = json.loads(out)
    assert set(d) == {"path", "enabled", "vars"}
    assert d["vars"]["OMLX_CHUNK_SNAP"]["value"] == "0"


def test_dev_store_path_follows_dev_json(monkeypatch, tmp_path):
    """The CLI must resolve the DEV instance's dir, not its own runtime's."""
    from omlx_uplift import devsrc

    monkeypatch.setattr(devsrc, "load_config",
                        lambda base_dir=None: {"base_path": str(tmp_path / "devbase")})
    p = et.dev_store_path()
    assert p == tmp_path / "devbase" / "uplift" / et.OVERRIDES_FILENAME


def test_env_is_dispatchable():
    """main() must route 'env' (the help-surface gate checks the listing;
    this checks the wiring)."""
    import sys

    old = sys.argv
    sys.argv = ["omlx-uplift", "env", "--help"]
    try:
        with redirect_stdout(io.StringIO()), pytest.raises(SystemExit) as e:
            cli.main()
        assert e.value.code == 0
    finally:
        sys.argv = old
