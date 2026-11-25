"""SYNC-1 run 39 (upstream f8f165bc #4918): classic grew a throughput queue.

A start that arrives while a throughput run is active is now parked in
`omlx.admin.benchmark._queue` and launched by the FINISHING run's own
`run_queue` task. That opens a window where `get_active_run()` already reads
None while a parked run is certain to start, and classic's own route closes it
with a second signal, `queue_busy()`.

Uplift's bench FIFO owned only the active check, so it could claim an idle
machine inside that window and run two throughput benches on one engine - and
break the 1-at-a-time assumption that scopes the `_upload_to_omlx_ai` swap.

These tests are pure-asyncio and never import omlx, like the rest of the queue
suite: the engine surface is stubbed at the module's own lookup seams.
"""
import pytest

from omlx_uplift import bench_queue as bq
from omlx_uplift.bench_engine import classic_busy


class FakeEngine:
    """The three shapes omlx.admin.benchmark can be in: pre-#4918 (no
    `queue_busy` attribute at all), and post-#4918 with the accessor."""

    def __init__(self, active=None, queue_busy=None):
        self._active = active
        if queue_busy is not None:
            self.queue_busy = queue_busy      # else: pre-#4918 engine

    def get_active_run(self):
        return self._active


class FakeRun:
    bench_id = "b-1"


# ---- bench_engine.classic_busy --------------------------------------------

def test_classic_busy_reports_an_active_run(monkeypatch):
    import omlx_uplift.bench_engine as be
    monkeypatch.setattr(be, "_engine",
                        lambda: FakeEngine(active=FakeRun(),
                                           queue_busy=lambda: False))
    assert classic_busy() is True


def test_classic_busy_reports_the_pending_window(monkeypatch):
    """The bug: no run is active, yet classic is about to start one."""
    import omlx_uplift.bench_engine as be
    monkeypatch.setattr(be, "_engine",
                        lambda: FakeEngine(active=None, queue_busy=lambda: True))
    assert classic_busy() is True


def test_classic_busy_is_false_on_a_free_slot(monkeypatch):
    import omlx_uplift.bench_engine as be
    monkeypatch.setattr(be, "_engine",
                        lambda: FakeEngine(active=None, queue_busy=lambda: False))
    assert classic_busy() is False


def test_classic_busy_degrades_on_an_engine_without_a_queue(monkeypatch):
    """An older keg has no queue_busy; the active check is the whole answer."""
    import omlx_uplift.bench_engine as be
    monkeypatch.setattr(be, "_engine", lambda: FakeEngine(active=None))
    assert classic_busy() is False
    monkeypatch.setattr(be, "_engine", lambda: FakeEngine(active=FakeRun()))
    assert classic_busy() is True


def test_classic_busy_lets_a_broken_probe_surface(monkeypatch):
    """classic_busy() does not swallow: a dead engine surfaces exactly like the
    neighbouring `get_active_run()` call in start() already does. Only the
    queue probe catches, so a broken accessor cannot wedge the pump
    (test_probe_never_wedges_the_pump_on_a_broken_accessor)."""
    import omlx_uplift.bench_engine as be

    def boom():
        raise RuntimeError("engine gone")

    monkeypatch.setattr(be, "_engine", lambda: FakeEngine(queue_busy=boom))
    with pytest.raises(RuntimeError):
        classic_busy()


# ---- the queue probe -------------------------------------------------------

def _patch_engine(mod, monkeypatch):
    monkeypatch.setattr(bq, "_mod", lambda name: mod if name == "bench_engine" else None)


def test_probe_waits_for_classics_pending_queue(monkeypatch):
    class Mod:
        @staticmethod
        def classic_busy():
            return True

    _patch_engine(Mod(), monkeypatch)
    assert bq._busy_throughput() is True
    assert "waiting" in bq._REASONS["throughput"], \
        "the operator must be told a classic run is pending, not just running"


def test_probe_is_free_when_classic_holds_nothing(monkeypatch):
    class Mod:
        classic_busy = staticmethod(lambda: False)

    _patch_engine(Mod(), monkeypatch)
    assert bq._busy_throughput() is False


def test_probe_never_wedges_the_pump_on_a_broken_accessor(monkeypatch):
    class Mod:
        @staticmethod
        def classic_busy():
            raise RuntimeError("no omlx")

    _patch_engine(Mod(), monkeypatch)
    # None means "cannot answer", which _busy_now() treats as not-blocking
    assert bq._busy_throughput() is None
    assert bq._busy_now() is None


def test_probe_returns_none_without_the_module(monkeypatch):
    _patch_engine(None, monkeypatch)
    assert bq._busy_throughput() is None


@pytest.mark.asyncio
async def test_idle_flips_with_classics_pending_queue(monkeypatch):
    """`idle()` is the pump's gate. A classic run parked in the queue must keep
    it shut, and the pump must open the moment classic drains - the existing
    suite covers the pump loop itself once a probe reports busy."""
    state = {"busy": True}

    class Mod:
        @staticmethod
        def classic_busy():
            return state["busy"]

    monkeypatch.setattr(bq, "_mod",
                        lambda name: Mod() if name == "bench_engine" else None)

    assert await bq.idle() is False, \
        "a pending classic run must not read as an idle machine"
    assert "waiting" in bq._busy_now()

    state["busy"] = False
    assert await bq.idle() is True
    assert bq._busy_now() is None
