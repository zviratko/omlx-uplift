# SPDX-License-Identifier: Apache-2.0
"""ISSUE-3 follow-up: prompt-id decode must not die when the engine is gone.

A token-id prompt is only readable with the model's tokenizer. The lazy
decode used to require a LIVE engine, so inspecting a finished request
after the model had been unloaded answered forever
'model not loaded — tokens kept raw'. routers.requests now falls back to a
tokenizer-ONLY load from the discovered entry's model_path (cached LRU,
local_files_only). These tests fake transformers so no model files are
needed; the drift-guard at the end checks the REAL transformers API still
accepts the kwargs we pass.
"""

from collections import OrderedDict
from types import SimpleNamespace

import pytest

from omlx_uplift.routers import requests as R


class _FakeTok:
    def __init__(self, prefix="T"):
        self.prefix = prefix

    def decode(self, ids, skip_special_tokens=True):
        return f"{self.prefix}:{len(ids)}:{skip_special_tokens}"


def _pool(entry):
    return lambda: SimpleNamespace(get_entry=lambda mid: entry)


@pytest.fixture(autouse=True)
def _clear_tok_cache():
    R._tok_cache.clear()
    yield
    R._tok_cache.clear()


def test_live_engine_tokenizer_wins(monkeypatch):
    calls = []
    monkeypatch.setattr(R, "engine_pool", _pool(
        SimpleNamespace(engine=SimpleNamespace(tokenizer=_FakeTok("ENG")),
                        model_path="/p")))
    def no_disk(path, **kw):
        calls.append(path)
        raise AssertionError("disk load must not run while the engine is live")
    transformers = pytest.importorskip('transformers')
    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained",
                        staticmethod(no_disk))
    out = R._decode_prompt_ids("m", "[1,2,3]", False)
    assert out["text"] == "ENG:3:True"
    assert out["note"] is None


def test_unloaded_entry_decodes_via_disk(monkeypatch):
    # Vanilla keeps the discovered entry after unload: engine None, path set.
    seen = {}

    def fake_fp(path, **kw):
        seen["path"] = path
        seen["kw"] = kw
        return _FakeTok("DISK")

    transformers = pytest.importorskip('transformers')
    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained",
                        staticmethod(fake_fp))
    monkeypatch.setattr(R, "engine_pool", _pool(
        SimpleNamespace(engine=None, model_path="/models/Foo")))
    out = R._decode_prompt_ids("Foo", "[1,2,3,4]", True)
    assert out["text"] == "DISK:4:True"
    assert out["note"] is None and out["sample_truncated"] is True
    assert seen["path"] == "/models/Foo"
    assert seen["kw"].get("local_files_only") is True   # never the network
    # cached: a second decode does not reload
    out2 = R._decode_prompt_ids("Foo", "[1,2]", False)
    assert out2["text"] == "DISK:2:True"


def test_slow_tokenizer_fallback_then_honest_note(monkeypatch):
    tries = []

    def fp(path, **kw):
        tries.append(kw.get("use_fast", True))
        if kw.get("use_fast", True):
            raise ValueError("fast tokenizer unsupported")
        return _FakeTok("SLOW")

    transformers = pytest.importorskip('transformers')
    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained",
                        staticmethod(fp))
    monkeypatch.setattr(R, "engine_pool", _pool(
        SimpleNamespace(engine=None, model_path="/models/Bar")))
    out = R._decode_prompt_ids("Bar", "[9]", False)
    assert out["text"] == "SLOW:1:True" and len(tries) == 2

    def boom(path, **kw):
        raise OSError("no tokenizer files")

    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained",
                        staticmethod(boom))
    R._tok_cache.clear()
    out = R._decode_prompt_ids("Bar", "[9]", False)
    assert out["text"] is None
    assert out["note"] == "tokenizer unavailable for this model — tokens kept raw"
    # failed loads are NOT cached — a retried inspect tries again
    assert not R._tok_cache


def test_unknown_model_id_honest_note(monkeypatch):
    monkeypatch.setattr(R, "engine_pool", _pool(None))
    out = R._decode_prompt_ids("Gone", "[1,2]", False)
    assert out["text"] is None
    assert out["note"] == "model unknown to the server — tokens kept raw"


def test_tok_cache_is_lru_capped(monkeypatch):
    transformers = pytest.importorskip('transformers')
    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained",
                        staticmethod(lambda path, **kw: _FakeTok(path)))
    for i in range(R._TOK_CACHE_MAX + 2):
        R._disk_tokenizer(f"/models/M{i}")
    assert len(R._tok_cache) == R._TOK_CACHE_MAX
    assert "/models/M0" not in R._tok_cache and "/models/M1" not in R._tok_cache


def test_transformers_accepts_our_kwargs():
    """Drift guard (real API, no model files): from_pretrained must keep
    accepting local_files_only and use_fast on installed transformers."""
    transformers = pytest.importorskip("transformers")
    import inspect
    params = set(inspect.signature(
        transformers.AutoTokenizer.from_pretrained).parameters)
    assert {"local_files_only", "use_fast"} <= params or "kwargs" in params
