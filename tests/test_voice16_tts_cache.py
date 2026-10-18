"""VOICE-16b: the bubble-owned chat audio cache.

Two halves, both pinned here:

- `omlx_uplift/tts_cache.py` (unit): key identity, write/read round-trip,
  the owner map that makes "audio lives as long as the bubble" true, the
  orphan classes Check reports and Cleanup removes (and never touches live
  audio), the caps, and the path-safety rule that a client string is a JSON
  key and never a file name.
- the routers: POST /voices/speech stores and re-serves a chunk when the
  request carries {conv, msg, rev} and never wakes the synth seam twice for
  it; a request without the block (or a streamed one) is uncached; and a
  chat save prunes the audio of the bubbles it no longer has.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.testclient import TestClient

from omlx_uplift import router as _up                      # noqa: F401 (facade first)
from omlx_uplift import tts_cache as TC
from omlx_uplift.routers import base as UP_BASE
from omlx_uplift.routers import chat as CH
from omlx_uplift.routers import voices as VO


@pytest.fixture()
def store(tmp_path, monkeypatch):
    d = tmp_path / "tts_cache"
    monkeypatch.setattr(TC, "cache_dir", lambda: d)
    return d


@pytest.fixture()
def client(monkeypatch, tmp_path, store):
    from omlx_uplift import router as up
    monkeypatch.setattr(CH, "store_path", lambda: tmp_path / "chat_history.json")
    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[UP_BASE.require_admin] = lambda: True
    return TestClient(app)


# ---- unit: identity, storage, ownership ----------------------------------

def test_key_identity_is_the_speech_not_the_bubble(store):
    a = TC.key_for("M:Ana", "Hello there.")
    assert a == TC.key_for("M:Ana", "Hello there.")
    assert a != TC.key_for("M:Bo", "Hello there.")            # other voice
    assert a != TC.key_for("M:Ana", "Hello there..")          # other text
    assert a != TC.key_for("M:Ana", "Hello there.", speed=1.2)
    assert a != TC.key_for("M:Ana", "Hello there.", language="cs")


def test_put_get_roundtrip_keeps_media_type(store):
    k = TC.key_for("M:Ana", "one")
    assert TC.put(k, b"RIFFdata", "audio/wav",
                  {"conv": "c1", "msg": "m1", "rev": "r1"}) is True
    got = TC.get(k)
    assert got is not None and got[0] == b"RIFFdata"
    assert got[1] == "audio/wav"
    assert TC.get(TC.key_for("M:Ana", "never stored")) is None
    assert TC.totals() == {"files": 1, "bytes": 8, "conversations": 1,
                           "bubbles": 1}


def test_junk_never_reaches_the_disk(store):
    assert TC.put("../escape", b"x", "audio/wav") is False
    assert TC.put("zz", b"x", "audio/wav") is False           # not a hash
    assert TC.get("not-a-key") is None
    assert TC.put(TC.key_for("v", "t"), b"", "audio/wav") is False
    assert TC.token("a/b") == "" and TC.token("<b>") == ""
    assert TC.token("x" * 200) == ""
    assert list(store.glob("*")) == []


def test_same_chunk_in_two_bubbles_is_one_file_and_survives_one_delete(store):
    k = TC.key_for("M:Ana", "shared sentence")
    TC.put(k, b"A" * 40, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r1"})
    TC.put(k, b"A" * 40, "audio/wav", {"conv": "c1", "msg": "m2", "rev": "r1"})
    assert TC.totals()["files"] == 1
    TC.prune_conversation("c1", ["m2"], revs={"m2": "r1"})
    assert TC.get(k) is not None, "m2 still quotes it"
    TC.prune_conversation("c1", [], revs={})
    assert TC.get(k) is None and TC.totals()["files"] == 0


def test_revised_plan_replaces_the_old_chunks(store):
    old = TC.key_for("M:Ana", "old sentence")
    new = TC.key_for("M:Ana", "new sentence")
    TC.put(old, b"1" * 10, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r1"})
    # the bubble re-planned after an edit: the next synth carries rev r2
    TC.put(new, b"2" * 10, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r2"})
    assert TC.get(new) is not None
    assert TC.get(old) is None, "the superseded chunk is not left behind"
    assert TC.totals() == {"files": 1, "bytes": 10, "conversations": 1,
                           "bubbles": 1}


def test_a_save_that_clears_the_plan_frees_the_audio(store):
    k = TC.key_for("M:Ana", "gone")
    TC.put(k, b"3" * 10, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r1"})
    # bubble still exists but no longer has a speech plan -> rev '0'
    assert TC.prune_conversation("c1", ["m1"], revs={"m1": "0"}) == 10
    assert TC.get(k) is None


def test_drop_conversation_takes_only_its_own_audio(store):
    shared = TC.key_for("M:Ana", "shared")
    TC.put(shared, b"x" * 5, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r1"})
    TC.put(shared, b"x" * 5, "audio/wav", {"conv": "c2", "msg": "m9", "rev": "r1"})
    mine = TC.key_for("M:Ana", "only c1")
    TC.put(mine, b"y" * 5, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r1"})
    TC.drop_conversation("c1")
    assert TC.get(mine) is None
    assert TC.get(shared) is not None, "c2 still owns the same sentence"
    assert TC.totals()["conversations"] == 1


def test_lru_eviction_frees_the_oldest_when_the_cache_grows(store, monkeypatch):
    monkeypatch.setattr(TC, "MAX_TOTAL_BYTES", 25)
    keys = []
    for i, ch in enumerate("abcde"):
        k = TC.key_for("M:Ana", "chunk " + ch)
        keys.append(k)
        TC.put(k, b"z" * 10, "audio/wav",
               {"conv": "c1", "msg": "m%d" % i, "rev": "r1"})
    total = TC.totals()["bytes"]
    assert total <= 25, total
    assert TC.get(keys[-1]) is not None, "the newest chunk stays"
    assert TC.get(keys[0]) is None, "the oldest gave way"


# ---- the sweep ------------------------------------------------------------

def _seed_two_chats(store):
    ka = TC.key_for("M:Ana", "alive")
    kb = TC.key_for("M:Ana", "dying")
    TC.put(ka, b"a" * 100, "audio/wav", {"conv": "c1", "msg": "m1", "rev": "r1"})
    TC.put(kb, b"b" * 100, "audio/wav", {"conv": "c2", "msg": "m2", "rev": "r1"})
    return ka, kb


def test_check_and_cleanup_report_only_what_is_really_orphaned(store):
    ka, kb = _seed_two_chats(store)
    # 1. a chat the store no longer has (c2 deleted behind the cache's back)
    # 2. an unowned index row
    kc = TC.key_for("M:Ana", "ownerless")
    TC.put(kc, b"c" * 100, "audio/wav")
    # 3. a stray file the index never heard of
    (store / "stray.wav").write_bytes(b"d" * 100)
    # 4. an index row whose file vanished
    store.joinpath(TC._load()["files"][kb]["name"]).unlink()

    live = {"c1": ["m1"]}
    rep = TC.check(live)
    kinds = set(rep["orphans"])
    assert {"chat_gone", "unowned", "stray_file"} <= kinds, rep["orphans"]
    assert rep["orphan_files"] == 4 and rep["orphan_bytes"] == 400, rep
    assert rep["files"] == 3 and rep["bytes"] == 300

    out = TC.cleanup(live)
    assert out["removed"] == 4 and out["freed"] >= 200, out
    assert TC.get(ka) is not None, "live audio is never touched"
    assert TC.get(kc) is None and TC.get(kb) is None
    assert not (store / "stray.wav").exists()
    assert TC.check(live)["orphan_files"] == 0
    assert TC.check(live)["files"] == 1


def test_check_without_a_chat_store_skips_the_chat_classes(store):
    _seed_two_chats(store)
    rep = TC.check(None)
    assert "chat_gone" not in rep["orphans"]
    assert "bubble_gone" not in rep["orphans"]


# ---- routers: /voices/speech ---------------------------------------------

@pytest.fixture()
def synth_spy(monkeypatch):
    """Stand in for the whole synth leg: the router must not be reached twice
    for a chunk that the cache already holds."""
    calls = []

    async def fake_synth(v, text, **kw):
        calls.append((v["id"], text, bool(kw.get("stream"))))
        return Response(content=b"WAV:" + text.encode(), media_type="audio/wav")

    def fake_alias(voice, model=""):
        return ({"id": voice, "name": voice.split(":")[-1]}, voice.split(":")[0], None)

    monkeypatch.setattr(VO, "_synth", fake_synth)
    monkeypatch.setattr(VO, "_alias_lookup", fake_alias)
    return calls


def _k(text):
    """The key the ROUTER derives for this text: it hashes the resolved voice
    plus the model leg _alias_lookup hands back, so the test must not."""
    return TC.key_for("M:Ana", text, model="M")


def _speech(client, text, cache=None, **kw):
    body = {"voice": "M:Ana", "input": text}
    if cache:
        body["cache"] = cache
    body.update(kw)
    return client.post("/uplift/api/voices/speech", json=body)


def test_cached_speech_synthesizes_once_per_chunk(client, store, synth_spy):
    cache = {"conv": "c1", "msg": "m1", "rev": "r1"}
    r1 = _speech(client, "Hello.", cache)
    assert r1.status_code == 200 and r1.content == b"WAV:Hello."
    assert r1.headers["x-uplift-tts-cache"] == "stored"
    r2 = _speech(client, "Hello.", cache)
    assert r2.headers["x-uplift-tts-cache"] == "hit"
    assert r2.content == b"WAV:Hello."
    assert len(synth_spy) == 1, "the replay never wakes the model"
    assert TC.totals()["files"] == 1


def test_no_cache_block_and_streams_stay_uncached(client, store, synth_spy):
    r = _speech(client, "Uncached.")
    assert "x-uplift-tts-cache" not in r.headers
    assert TC.totals()["files"] == 0
    r = _speech(client, "Streaming.", {"conv": "c1", "msg": "m1", "rev": "r1"},
                stream=True)
    assert r.status_code == 200
    assert TC.totals()["files"] == 0, "a progressive reply has no body to store"
    assert len(synth_spy) == 2


def test_a_junk_owner_is_ignored_not_fatal(client, store, synth_spy):
    r = _speech(client, "Sneaky.", {"conv": "../etc", "msg": "m1", "rev": "r1"})
    assert r.status_code == 200 and r.content == b"WAV:Sneaky."
    assert TC.totals()["files"] == 0
    assert list(store.glob("*")) == []


def test_cache_endpoints_answer_the_operator(client, store, synth_spy):
    _speech(client, "One taken.", {"conv": "c1", "msg": "m1", "rev": "r1"})
    # the bubble must exist in the chat store, or the sweep is RIGHT to call
    # its audio orphaned (that is the delete-a-bubble rule)
    client.post("/uplift/api/chat/history", json={
        "id": "c1", "title": "T", "model": "m", "systemPrompt": "",
        "messages": [_msg("assistant", "One taken.", "m1",
                          {"mode": "sentence", "n": 1, "rev": "r1"})]})
    rep = client.get("/uplift/api/voices/speech-cache").json()
    assert rep["files"] == 1 and rep["totals"]["bytes"] > 0, rep
    assert rep["orphan_files"] == 0, rep
    (store / "stray.wav").write_bytes(b"z" * 50)
    rep = client.get("/uplift/api/voices/speech-cache").json()
    assert rep["orphans"].get("stray_file", {}).get("count") == 1, rep["orphans"]
    out = client.post("/uplift/api/voices/speech-cache/cleanup", json={}).json()
    assert out["removed"] == 1 and out["freed"] == 50, out
    assert not (store / "stray.wav").exists()
    assert client.get("/uplift/api/voices/speech-cache").json()["files"] == 1, \
        "live audio survives a cleanup"


def test_cache_sweep_never_runs_unauthenticated():
    # the contract is "no sweep without admin", not one particular rejection
    # code: without the override the request must not reach the handler (401/
    # 403 from the auth leg, 422 where the auth dependency itself demands a
    # credential — CI has no omlx settings, the keg does)
    from omlx_uplift import router as up
    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    c = TestClient(app)
    assert c.get("/uplift/api/voices/speech-cache").status_code != 200
    assert c.post("/uplift/api/voices/speech-cache/cleanup", json={}).status_code != 200


# ---- routers: the chat lifecycle feeds the cache --------------------------

def _msg(role, content, mid, speech=None):
    m = {"role": role, "content": content, "mid": mid}
    if speech:
        m["speech"] = speech
    return m


def test_speech_plan_and_mid_survive_the_sanitizer(client):
    plan = {"mode": "sentence", "n": 3, "rev": "ab12", "junk": "x" * 999}
    conv = {"id": "c1", "title": "T", "model": "m", "systemPrompt": "",
            "messages": [_msg("assistant", "hi", "m1", plan),
                         _msg("assistant", "yo", "<script>", {"n": 0})]}
    r = client.post("/uplift/api/chat/history", json=conv)
    assert r.status_code == 200
    msgs = client.get("/uplift/api/chat/history/c1").json()["messages"]
    assert msgs[0]["mid"] == "m1"
    assert msgs[0]["speech"] == {"mode": "sentence", "n": 3, "rev": "ab12"}
    assert "mid" not in msgs[1], "a junk id collapses to no id at all"
    assert "speech" not in msgs[1], "n<=0 is not a plan"


def test_saving_without_a_bubble_deletes_its_audio(client, store, synth_spy):
    cache = {"conv": "c1", "msg": "m1", "rev": "r1"}
    _speech(client, "Keep me.", {"conv": "c1", "msg": "m2", "rev": "r1"})
    _speech(client, "Drop me.", cache)
    assert TC.get(_k("Drop me.")) is not None, "both chunks are on disk"
    assert TC.totals()["files"] == 2
    keep = {"id": "c1", "title": "T", "model": "m", "systemPrompt": "",
            "messages": [_msg("assistant", "Keep me.", "m2",
                              {"mode": "sentence", "n": 1, "rev": "r1"})]}
    assert client.post("/uplift/api/chat/history", json=keep).status_code == 200
    assert TC.get(_k("Drop me.")) is None
    assert TC.get(_k("Keep me.")) is not None
    assert TC.totals()["files"] == 1


def test_editing_a_bubbles_text_frees_the_old_take(client, store, synth_spy):
    _speech(client, "Original.", {"conv": "c1", "msg": "m1", "rev": "r1"})
    edited = {"id": "c1", "title": "T", "model": "m", "systemPrompt": "",
              "messages": [_msg("assistant", "Edited.", "m1",
                                {"mode": "sentence", "n": 1, "rev": "r2"})]}
    client.post("/uplift/api/chat/history", json=edited)
    assert TC.get(_k("Original.")) is None


def test_delete_chat_frees_its_audio(client, store, synth_spy):
    _speech(client, "Bye.", {"conv": "c1", "msg": "m1", "rev": "r1"})
    keep = {"id": "c2", "title": "T", "model": "m", "systemPrompt": "",
            "messages": [_msg("assistant", "Stay.", "m9",
                              {"mode": "sentence", "n": 1, "rev": "r1"})]}
    gone = {"id": "c1", "title": "T", "model": "m", "systemPrompt": "",
            "messages": [_msg("assistant", "Bye.", "m1",
                              {"mode": "sentence", "n": 1, "rev": "r1"})]}
    _speech(client, "Stay.", {"conv": "c2", "msg": "m9", "rev": "r1"})
    client.post("/uplift/api/chat/history", json=keep)
    client.post("/uplift/api/chat/history", json=gone)
    assert TC.get(_k("Bye.")) is not None and TC.get(_k("Stay.")) is not None
    assert client.delete("/uplift/api/chat/history/c1").status_code == 200
    assert TC.get(_k("Bye.")) is None
    assert TC.get(_k("Stay.")) is not None, "another chat's audio is not ours to free"


def test_index_file_is_plain_json(store):
    TC.put(TC.key_for("M:Ana", "t"), b"x", "audio/wav",
           {"conv": "c1", "msg": "m1", "rev": "r1"})
    d = json.loads((store / "index.json").read_text())
    assert d["version"] == 1 and set(d) == {"version", "files", "owners"}
