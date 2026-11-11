"""BUG-8: concurrent saves of the chat-history and voices stores.

Before the fix every writer shared one temp file name and no writer held a
lock from load to save: two saves at once answered 500 (the second rename
found no temp file) or the later save dropped the earlier change. These tests
send 20 saves at the same time through the real routes on one event loop
(the production layout: one uvicorn worker) and check that every save answers
200 and every change is in the store file.
"""
from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from fastapi import FastAPI

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift.routers import base as up_base
from omlx_uplift.routers import chat as CH
from omlx_uplift.routers import voices as V

N = 20


def _app():
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return app


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t")


async def test_parallel_chat_saves_all_land(monkeypatch, tmp_path):
    monkeypatch.setattr(CH, "store_path", lambda: tmp_path / "chat_history.json")
    async with _client(_app()) as c:
        rs = await asyncio.gather(*[
            c.post("/uplift/api/chat/history",
                   json={"id": f"c{i}", "title": f"T{i}",
                         "messages": [{"role": "user", "content": f"m{i}"}]})
            for i in range(N)])
        assert [r.status_code for r in rs] == [200] * N, [r.text for r in rs]
        # deletes race the same way
        rd = await asyncio.gather(*[c.delete(f"/uplift/api/chat/history/c{i}")
                                    for i in range(0, N, 2)])
        assert [r.status_code for r in rd] == [200] * (N // 2)
    store = json.loads((tmp_path / "chat_history.json").read_text())
    assert sorted(store["conversations"]) == sorted(f"c{i}" for i in range(1, N, 2))
    assert not list(tmp_path.glob("*.tmp")), "no temp file may stay behind"


WAV = b"RIFF....WAVEfmt " + b"\0" * 64
B64 = base64.b64encode(WAV).decode()


async def test_parallel_voice_creates_all_land(monkeypatch, tmp_path):
    monkeypatch.setattr(V, "_store_dir", lambda: tmp_path)
    V._save({"version": 1, "voices": [], "say_chat_seed": True})
    async with _client(_app()) as c:
        rs = await asyncio.gather(*[
            c.post("/uplift/api/voices",
                   json={"name": f"Voice {i}", "model": "Qwen3-TTS-Base",
                         "ref_text": "sample", "ref_audio_b64": B64,
                         "ref_name": "a.wav"})
            for i in range(N)])
        assert [r.status_code for r in rs] == [200] * N, [r.text for r in rs]
        ids = [r.json()["voice"]["id"] for r in rs]
        rd = await asyncio.gather(*[c.delete(f"/uplift/api/voices/{v}")
                                    for v in ids[::2]])
        assert [r.status_code for r in rd] == [200] * (N // 2)
    store = json.loads((tmp_path / "voices.json").read_text())
    assert sorted(v["id"] for v in store["voices"]) == sorted(ids[1::2])
    assert not list(tmp_path.glob("*.tmp")), "no temp file may stay behind"


def test_voice_save_leaves_no_temp_file_on_error(monkeypatch, tmp_path):
    monkeypatch.setattr(V, "_store_dir", lambda: tmp_path)
    with pytest.raises(TypeError):
        V._save({"bad": object()})              # not JSON-serializable
    assert not list(tmp_path.glob("*.tmp"))
    assert not (tmp_path / "voices.json").exists()
