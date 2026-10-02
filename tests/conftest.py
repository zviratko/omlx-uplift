"""Suite-wide collection policy (CI-1).

omlx is not on PyPI and is Apple-Silicon/MLX-bound, so a Linux CI runner
can never install it. Roughly 60 tests genuinely exercise omlx internals
(stubs of _server_state, scheduler walks, psutil_compat...) — directly or
indirectly (e.g. retention -> Collector.sample_once -> omlx.server_metrics).
Rather than let them fail red on every push — which trains everyone to
ignore CI — they SKIP with an explicit reason when omlx is missing. On
the dev box (keg python) NOTHING is skipped: same suite, same semantics.

Two mechanisms, both narrow:
  * collect_ignore for the two files whose TOP-LEVEL `import omlx` kills
    collection before any hook can run;
  * a makereport wrapper converting ONLY ModuleNotFoundError('omlx'...)
    into skips — real assertion failures stay red even on omlx-less runs.
"""
from __future__ import annotations

import importlib.util

import pytest

_HAS_OMLX = importlib.util.find_spec("omlx") is not None

collect_ignore = [] if _HAS_OMLX else ["test_overlay_api.py", "test_skins.py"]


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    # The runner captures test-call exceptions into CallInfo before this
    # hook sees them, so convert here: outcome is the single source of
    # truth (passed/failed/skipped are derived properties on TestReport).
    outcome = yield
    if _HAS_OMLX or call.when != "call" or call.excinfo is None:
        return
    exc = call.excinfo.value
    if not (isinstance(exc, ModuleNotFoundError)
            and str(exc.name or "").split(".")[0] == "omlx"):
        return
    report = outcome.get_result()
    report.outcome = "skipped"
    report.longrepr = (f"skipped: needs the omlx package ({exc.name}) — "
                       "macOS keg python only")
