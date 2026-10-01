"""PERF-1 (SWEEP183 B2): remote-fetch handlers must not block the event loop.

Each test monkeypatches the blocking work to a sync call that waits on a
threading.Event nobody sets, runs the handler as a task, and checks the
event loop keeps ticking (heartbeat) while the handler is pending. Work run
directly in the loop starves the heartbeat; through asyncio.to_thread it
does not. Handlers are called directly — the only Depends default is a
plain bool, no FastAPI app needed (test_overlay_api precedent).
"""
import asyncio
import threading

import pytest

from omlx_uplift.routers import dev as dev_mod  # SPLIT-1: patch the owner
from omlx_uplift.routers import patches as patches_mod


async def _assert_loop_alive(factory):
    ticks = []

    async def heartbeat(stop):
        while not stop.is_set():
            await asyncio.sleep(0.01)
            ticks.append(1)

    stop = asyncio.Event()
    hb = asyncio.create_task(heartbeat(stop))
    await asyncio.sleep(0.05)
    before = len(ticks)
    task = asyncio.create_task(factory())
    await asyncio.sleep(0.08)          # handler now sits inside the blocked work
    alive = len(ticks) - before
    task.cancel()
    # Release the blocked pool thread NOW: the loop's shutdown_default_executor
    # (pytest-asyncio teardown) joins it, and that finalizer can run before
    # any function-scoped fixture teardown — waiting the full ev.wait(5)
    # timeout would add ~5 s per test.
    for ev in _BLOCK_EVENTS:
        ev.set()
    _BLOCK_EVENTS.clear()
    stop.set()
    await asyncio.gather(hb, task, return_exceptions=True)
    assert alive >= 3, (
        f"event loop starved while handler blocked ({alive} heartbeat ticks "
        "in 130 ms) — the blocking call must run via asyncio.to_thread")


def _block(monkeypatch, module, name, result):
    # The wait ends via ev.wait timeout OR the explicit release in
    # _assert_loop_alive right after the cancel (see comment there).
    ev = threading.Event()
    _BLOCK_EVENTS.append(ev)
    monkeypatch.setattr(
        module, name, lambda *a, **k: (ev.wait(5), result)[1])


_BLOCK_EVENTS: list = []


@pytest.fixture
def _store(monkeypatch):
    monkeypatch.setattr(patches_mod, "patch_store", lambda: None)
    monkeypatch.setattr(patches_mod, "_patch_tree_root", lambda: "/nonexistent")


@pytest.mark.asyncio
async def test_patches_check_offloads_to_thread(monkeypatch, _store):
    from omlx_uplift import patchsource
    _block(monkeypatch, patchsource, "check_all", {"ok": True})
    await _assert_loop_alive(lambda: patches_mod.patches_check(is_admin=True))


@pytest.mark.asyncio
async def test_patches_curated_offloads_to_thread(monkeypatch, _store):
    from omlx_uplift import curated
    _block(monkeypatch, curated, "list_remote", {"tiers": {}})
    await _assert_loop_alive(lambda: patches_mod.patches_curated(is_admin=True))


@pytest.mark.asyncio
async def test_patches_curated_sync_offloads_to_thread(monkeypatch, _store):
    from omlx_uplift import curated, patchsource
    monkeypatch.setattr(patchsource, "dev_build_root", lambda: None)
    _block(monkeypatch, curated, "sync", {"ok": True})
    await _assert_loop_alive(lambda: patches_mod.patches_curated_sync(is_admin=True))


@pytest.mark.asyncio
async def test_patches_add_offloads_to_thread(monkeypatch, _store):
    from omlx_uplift import patchsource
    monkeypatch.setattr(patchsource, "dev_build_root", lambda: None)
    _block(monkeypatch, patchsource, "add_patch", {"ok": True})
    req = patches_mod.PatchAddRequest(id="perf1", kind="url",
                                 url="http://127.0.0.1:9/x.diff")
    await _assert_loop_alive(
        lambda: patches_mod.patches_add(req, is_admin=True))
