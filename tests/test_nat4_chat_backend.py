"""NAT-4: native chat backend (key handout + history store) tests.

Doctrine: real temp store path (no venv, no server), every claim the
router docstring makes is pinned here — size caps, role whitelist,
multimodal stripping, count caps, store-full 507, migration-friendly
shapes. The key route is tested with the settings-file fallback only
(no live server state on the test machine; the server-state branch is
the runtime-preferred path and is covered by the live drill).
"""
from __future__ import annotations

import json
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# facade FIRST: routers self-register into the shared api_router singleton
# at import time, and the facade pins bench->chat order — importing
# routers.chat directly here used to reorder the global route list and
# turn the NAT-3 golden test red (file-order-dependent, exactly the
# doctrine test_repl1 learned before).
from omlx_uplift import router as _up  # noqa: F401
from omlx_uplift.routers import chat as CH


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from omlx_uplift import router as up
    from omlx_uplift.routers import base as up_base
    monkeypatch.setattr(CH, "store_path", lambda: tmp_path / "chat_history.json")
    app = FastAPI()
    app.include_router(up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app)


def _conv(cid="c1", n=3, **kw):
    c = {"id": cid, "title": "T", "model": "m", "systemPrompt": "",
         "messages": [{"role": "user", "content": f"u{i}"} for i in range(n)]}
    c.update(kw)
    return c


def test_save_list_get_roundtrip(client):
    assert client.get("/uplift/api/chat/history").json() == []
    r = client.post("/uplift/api/chat/history", json=_conv())
    assert r.status_code == 200 and r.json()["messages"] == 3
    lst = client.get("/uplift/api/chat/history").json()
    assert lst[0]["id"] == "c1" and lst[0]["message_count"] == 3
    full = client.get("/uplift/api/chat/history/c1").json()
    assert full["messages"][0]["content"] == "u0"


def test_active_profile_name_roundtrips_sanitized(client):
    """6/6c: the store keeps the profile NAME only (content stays in the
    shared localStorage mirror). Oversized/None degrade like title does."""
    r = client.post("/uplift/api/chat/history", json=_conv(activeProfile="Coder"))
    assert r.status_code == 200
    full = client.get("/uplift/api/chat/history/c1").json()
    assert full["activeProfile"] == "Coder"
    client.post("/uplift/api/chat/history", json=_conv(activeProfile="x" * 80))
    assert len(client.get("/uplift/api/chat/history/c1").json()["activeProfile"]) == 48
    client.post("/uplift/api/chat/history", json=_conv(activeProfile=""))
    assert client.get("/uplift/api/chat/history/c1").json()["activeProfile"] is None
    # a conv saved without the field never grows one
    client.post("/uplift/api/chat/history", json=_conv(cid="c2"))
    assert client.get("/uplift/api/chat/history/c2").json()["activeProfile"] is None


def test_validation(client):
    assert client.post("/uplift/api/chat/history", json={"messages": []}).status_code == 400
    r = client.post("/uplift/api/chat/history", json={"id": "x", "messages": "no"})
    assert r.status_code == 400
    assert client.get("/uplift/api/chat/history/nope").status_code == 404
    assert client.delete("/uplift/api/chat/history/nope").status_code == 404


def test_message_cleaning(client):
    conv = _conv(cid="c2", messages=[
        {"role": "hacker", "content": "kept as user"},                 # role whitelist
        {"role": "assistant", "content": [                              # multimodal strip
            {"type": "text", "text": "the text"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
        "not-a-dict",                                                   # dropped
        {"role": "user", "content": "x" * 300_000},                     # capped
    ])
    r = client.post("/uplift/api/chat/history", json=conv)
    assert r.status_code == 200
    msgs = client.get("/uplift/api/chat/history/c2").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert msgs[1]["content"] == "the text"          # image parts stripped
    assert len(msgs[2]["content"]) == 200_000        # per-message cap


def test_reasoning_content_persists(client):
    # 4/6: thinking survives reload like classic's per-message reasoning
    conv = _conv(cid="cr", messages=[
        {"role": "user", "content": "why?", "reasoning_content": "user spoof"},
        {"role": "assistant", "content": "because", "reasoning_content": " hmm "},
    ])
    assert client.post("/uplift/api/chat/history", json=conv).status_code == 200
    msgs = client.get("/uplift/api/chat/history/cr").json()["messages"]
    assert msgs[1]["reasoning_content"] == " hmm "
    assert "reasoning_content" not in msgs[0]      # assistant-only (classic)
    conv2 = _conv(cid="cr2", messages=[{"role": "assistant", "content": "x",
                                        "reasoning_content": " "}])
    client.post("/uplift/api/chat/history", json=conv2)
    m2 = client.get("/uplift/api/chat/history/cr2").json()["messages"]
    assert "reasoning_content" not in m2[0]        # blank reasoning dropped


def test_message_and_title_caps(client):
    conv = _conv(cid="c3", n=250)
    conv["title"] = "long " * 40
    r = client.post("/uplift/api/chat/history", json=conv)
    assert r.status_code == 200
    got = client.get("/uplift/api/chat/history/c3").json()
    assert len(got["messages"]) == CH.MAX_MESSAGES
    assert len(got["title"]) <= CH.TITLE_CHARS


def test_conversation_count_cap(client):
    for i in range(CH.MAX_CONVOS + 5):
        c = _conv(cid=f"c{i}", n=1)
        c["updated"] = 0
        r = client.post("/uplift/api/chat/history", json=c)
        assert r.status_code == 200
    lst = client.get("/uplift/api/chat/history").json()
    assert len(lst) == CH.MAX_CONVOS
    assert "c0" not in {x["id"] for x in lst}       # oldest evicted


def test_store_full_returns_507(client, monkeypatch):
    monkeypatch.setattr(CH, "MAX_STORE_BYTES", 50)
    r = client.post("/uplift/api/chat/history", json=_conv(cid="big"))
    assert r.status_code == 507


def test_corrupt_store_recovers(client, monkeypatch, tmp_path):
    (tmp_path / "chat_history.json").write_text("{not json")
    assert client.get("/uplift/api/chat/history").json() == []


def test_delete(client):
    client.post("/uplift/api/chat/history", json=_conv(cid="del"))
    assert client.delete("/uplift/api/chat/history/del").status_code == 200
    assert client.get("/uplift/api/chat/history/del").status_code == 404


def test_key_handout_from_settings_file(client, monkeypatch, tmp_path):
    # force the file-fallback branch deterministically: a None sys.modules
    # entry makes `from omlx.server import ...` raise ImportError on any
    # machine (on the dev box the live-server branch could otherwise win
    # and leak the real key into the assertion)
    monkeypatch.setitem(sys.modules, "omlx.server", None)
    fake = tmp_path / ".omlx" / "settings.json"
    fake.parent.mkdir()
    fake.write_text(json.dumps({"auth": {"api_key": "sekrit"}}))
    monkeypatch.setattr(CH.Path, "home", classmethod(lambda cls: tmp_path))
    r = client.get("/uplift/api/chat/key")
    assert r.status_code == 200
    assert r.json() == {"api_key": "sekrit"}


def test_generation_overrides_persist_with_zero(client):
    # U46: classic persists its sidebar sampling fields per session; the
    # store keeps the numeric subset. 0 / 0.0 are VALID values (greedy
    # sampling) so presence is per-key — a truthiness filter would drop
    # them and change generation behaviour on reload.
    r = client.post("/uplift/api/chat/history", json=_conv(generation={
        "temperature": 0, "max_tokens": 128, "top_p": 0.0, "top_k": 40,
        "presence_penalty": -0.5,
    }))
    assert r.status_code == 200
    full = client.get("/uplift/api/chat/history/c1").json()["generation"]
    assert full == {"temperature": 0, "max_tokens": 128, "top_p": 0.0,
                    "top_k": 40, "presence_penalty": -0.5}
    # junk and non-numerics are not set; bools are not numbers here
    client.post("/uplift/api/chat/history", json=_conv(generation={
        "temperature": "hot", "top_p": True, "min_p": 0.1}))
    assert client.get("/uplift/api/chat/history/c1").json()["generation"] == {"min_p": 0.1}
    # wrong type entirely -> None (absent), never a crash
    client.post("/uplift/api/chat/history", json=_conv(generation=[1, 2]))
    assert client.get("/uplift/api/chat/history/c1").json()["generation"] is None
    # absent -> None as well
    client.post("/uplift/api/chat/history", json=_conv())
    assert client.get("/uplift/api/chat/history/c1").json()["generation"] is None
