"""BE-2: collector.py family split — the seams exist and hold behavior.

collector.py was one 580-line module with one 375-line sample_once mixing
seven concerns and THREE copies of the entry.engine._engine.engine.
scheduler walk. The split rule: shared scheduler-walk helper + one
functional collector per metric family, Collector keeps state + tick +
persistence only.

These tests pin (a) the walk exists ONCE (corewalk module + string census
over the two sampler files), (b) each family collector as a pure function,
(c) the existing end-to-end tick tests (test_collector_sources,
test_retention) are the behavior guard — RED before the split (they
import nonexistent names), GREEN after.
"""
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def test_scheduler_walk_lives_once_in_corewalk():
    from omlx_uplift import corewalk

    assert callable(corewalk.scheduler_for)
    assert callable(corewalk.output_collectors_for)

    class Inner:
        scheduler = "SCHED"

    class AsyncCore:
        engine = Inner()

    class Engine:
        _engine = AsyncCore()

    class Entry:
        engine = Engine()

    assert corewalk.scheduler_for(Entry()) == "SCHED"

    # DFlash shape: no async wrapper, scheduler on the engine itself
    class DirectEngine:
        scheduler = "SCHED2"

    class DirectEntry:
        engine = DirectEngine()

    assert corewalk.scheduler_for(DirectEntry()) == "SCHED2"
    assert corewalk.scheduler_for(None) is None
    assert corewalk.scheduler_for(object()) is None


def test_walk_string_census_entry_walk_only_in_corewalk():
    """The entry->engine->_engine->engine->scheduler hop is spelled once.
    collector.py and request_log.py must no longer contain the literal
    `_engine` attribute hop at all (they call corewalk). instrument.py is
    out of scope: its _engine use maps a CORE back to a model id (reverse
    direction), not the sampler walk."""
    for name in ("collector.py", "request_log.py"):
        src = (REPO / "omlx_uplift" / name).read_text()
        # the ASYNC-CORE HOP specifically: '_engine' as an attribute name
        # (quotes), not the word 'collect_engines'
        assert '"_engine"' not in src and "'_engine'" not in src, \
            f"{name} still spells the walk inline"
    core = (REPO / "omlx_uplift" / "corewalk.py").read_text()
    assert '"_engine"' in core


def test_family_collectors_are_pure_functions():
    from omlx_uplift import collectors

    for fn in ("collect_totals_rates", "collect_engines", "collect_memory",
               "collect_cache"):
        assert callable(getattr(collectors, fn)), fn

    # totals/rates pure: prev in -> (pairs, prev_out) out
    snap = {"total_prompt_tokens": 100, "total_completion_tokens": 50,
            "total_cached_tokens": 10, "total_requests": 4,
            "total_tokens_served": 150, "cache_efficiency": 0.1,
            "avg_prefill_tps": 7.0, "avg_generation_tps": 3.0}
    pairs, prev = collectors.collect_totals_rates(snap, now=1000.0, prev={})
    assert pairs["tot.total_prompt_tokens"] == 100.0
    assert "rate.prompt_tokens_s" not in pairs          # first tick, dt==0
    pairs2, prev2 = collectors.collect_totals_rates(
        dict(snap, total_prompt_tokens=150), now=1005.0, prev=prev)
    assert pairs2["rate.prompt_tokens_s"] == 10.0       # (150-100)/5
    # counter reset -> rate dropped for that tick, honest absence
    pairs3, _ = collectors.collect_totals_rates(
        dict(snap, total_prompt_tokens=10), now=1010.0, prev=prev2)
    assert "rate.prompt_tokens_s" not in pairs3


def test_macmon_collector_owns_its_process_state():
    from omlx_uplift.collectors import MacmonCollector

    m = MacmonCollector()
    # absent macmon: collect stays silent, never raises, probes at most once
    m.collect({})
    m.collect({})


def test_collector_keeps_state_tick_persistence_only():
    src = (REPO / "omlx_uplift" / "collector.py").read_text()
    assert len(src.splitlines()) < 260, "Collector did not shrink — split regressed"
    # one-tick transaction + signature map + daily purge stay on Collector
    assert "write_tick" in src and "_persisted" in src and "purge" in src


def test_collector_lifecycle_survives_the_split():
    """THE regression this ticket produced on 2026-10-03: the rewrite
    dropped start()/stop() and the app lifespan died with
    AttributeError before the service came up (caught only by the live
    deploy smoke). register() calls collector.start(); shutdown calls
    stop(); both must exist and stop() must release the macmon pipe."""
    import asyncio
    import inspect

    from omlx_uplift.collector import Collector
    from omlx_uplift.collectors import MacmonCollector

    for name in ("start", "stop", "_run", "sample_once"):
        assert callable(getattr(Collector, name)), f"Collector.{name} gone"
    assert callable(getattr(MacmonCollector, "shutdown", None)), \
        "MacmonCollector.shutdown gone — orphaned `macmon pipe` on restart"
    c = Collector.__new__(Collector)          # no store needed for stop()
    c._task = None
    c._macmon_collector = MacmonCollector()
    asyncio.run(c.stop())                      # must be a no-op, not a crash
    # register()'s actual call site:
    src = (REPO / "omlx_uplift" / "__init__.py").read_text()
    assert "collector.start()" in src or ".start()" in src
    sig = inspect.signature(Collector.start)
    assert "self" in sig.parameters
