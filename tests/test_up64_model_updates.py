"""UP-64: model update check — state, staleness, ignore rules, routes.

The engine's HFDownloader.check_updates is the seam: it is faked here with
the same return format (updates repo -> {files, size}, checked, failed), so
the uplift code under test is the state file, the ignore rules and the
background trigger, not the Hub call.
"""
from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omlx_uplift import router as _up            # facade FIRST (route order)
from omlx_uplift import model_updates as MU


class FakeDL:
    def __init__(self, model_dir, updates):
        self.model_dir = model_dir
        self.updates = updates
        self.calls = []
        self._tasks = {}

    def has_unfinished_download(self, repo_id):
        return False

    async def check_updates(self, repo_ids, token=""):
        self.calls.append((list(repo_ids), token))
        ups = {r: v for r, v in self.updates.items() if r in repo_ids}
        return {"updates": ups, "checked": len(repo_ids), "failed": []}


@pytest.fixture()
def env(monkeypatch, tmp_path):
    models = tmp_path / "models"
    for repo in ("org/a", "org/b", "other/c"):
        (models / repo).mkdir(parents=True)
    dl = FakeDL(models, {"org/a": {"files": 2, "size": 100}})
    monkeypatch.setattr(MU, "state_path", lambda: tmp_path / "model_updates.json")
    monkeypatch.setattr(MU, "_downloader", lambda: dl)
    shas = {"org/a": "sha1"}
    monkeypatch.setattr(MU, "_hub_sha", lambda repo, token: shas.get(repo))
    monkeypatch.setattr(MU, "_task", None)
    return dl, shas


@pytest.fixture()
def client(env):
    from omlx_uplift.routers import base as up_base
    app = FastAPI()
    app.include_router(_up.api_router, prefix="/uplift/api")
    app.dependency_overrides[up_base.require_admin] = lambda: True
    return TestClient(app)


def test_check_lists_updates_with_hub_sha(env):
    dl, _ = env
    st = asyncio.run(MU.run_check())
    assert dl.calls[0][0] == ["org/a", "org/b", "other/c"]
    assert st["updates"] == {"org/a": {"files": 2, "size": 100, "sha": "sha1"}}
    v = MU.view(st)
    assert v["pending"] == 1 and v["updates"][0]["ignored"] is None


def test_ignore_version_hides_until_a_new_commit(env):
    dl, shas = env
    asyncio.run(MU.run_check())
    v = MU.view(MU.set_ignore("org/a", "version"))
    assert v["pending"] == 0 and v["updates"][0]["ignored"] == "version"
    shas["org/a"] = "sha2"                      # the Hub moved on
    v = MU.view(asyncio.run(MU.run_check()))
    assert v["pending"] == 1 and v["updates"][0]["ignored"] is None


def test_ignore_model_skips_its_hub_call(env):
    dl, _ = env
    asyncio.run(MU.run_check())
    v = MU.view(MU.set_ignore("org/a", "model"))
    assert v["pending"] == 0 and v["ignored_models"] == ["org/a"]
    asyncio.run(MU.run_check())
    assert "org/a" not in dl.calls[-1][0]
    v = MU.view(MU.set_ignore("org/a", "none"))
    assert v["ignored_models"] == []


def test_ignore_version_needs_a_current_update(env):
    with pytest.raises(ValueError):
        MU.set_ignore("org/b", "version")
    with pytest.raises(ValueError):
        MU.set_ignore("org/b", "forever")


def test_stale_after_interval_or_finished_update(env):
    dl, _ = env
    st = asyncio.run(MU.run_check())
    assert not MU._stale(st, dl)
    st2 = dict(st, checked_at=time.time() - MU.INTERVAL_S - 1)
    assert MU._stale(st2, dl)

    class T:
        repo_id = "org/a"
        completed_at = time.time() + 5
    dl._tasks = {"t": T()}
    assert MU._stale(st, dl)


def test_failed_check_keeps_the_last_good_result(env, monkeypatch):
    dl, _ = env
    asyncio.run(MU.run_check())

    async def boom(repo_ids, token=""):
        raise RuntimeError("hub down")
    monkeypatch.setattr(dl, "check_updates", boom)
    st = asyncio.run(MU.run_check())
    assert st["error"] == "hub down" and "org/a" in st["updates"]


def test_corrupt_state_reads_as_empty(env, tmp_path):
    (tmp_path / "model_updates.json").write_text("{nope")
    assert MU.load()["updates"] == {}


def test_routes_roundtrip(client, env):
    r = client.post("/uplift/api/model-updates/check", json={"hf_token": "T"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pending"] == 1 and body["updates"][0]["repo_id"] == "org/a"
    assert env[0].calls[-1][1] == "T"
    assert "T" not in (MU.state_path().read_text())   # token never stored
    r = client.post("/uplift/api/model-updates/ignore",
                    json={"repo_id": "org/a", "mode": "version"})
    assert r.status_code == 200 and r.json()["pending"] == 0
    assert client.get("/uplift/api/model-updates").json()["pending"] == 0
    bad = client.post("/uplift/api/model-updates/ignore", json={"repo_id": "x"})
    assert bad.status_code == 400
    bad = client.post("/uplift/api/model-updates/ignore", content=b"[]")
    assert bad.status_code == 400
