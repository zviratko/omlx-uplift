"""REPL-4: the mteb-env venv — MTEB + its torch dependency, ISOLATED.

Decision recorded on the REPL-4 card (2026-10-08): mteb 2.24.0 hard-
requires torch (>=2.0; measured torch 2.14.1 = 587 MB inside the spike
env), so a SECOND pinned venv keeps the harness bench-env and its
torch-free probe byte-identical. The rule that actually matters — the
omlx/uplift KEGS never gain a dependency — holds either way: this env
lives under the uplift store and is only ever a SUBPROCESS interpreter,
exactly like bench-env.

Same machinery as bench-env (bench_env.create/status parameterized):
marker digest vs mteb_env_requirements.txt, refuse-to-run-when-stale,
key-via-env-only children. The extra_check here verifies mteb imports
instead of the torch absence probe.
"""
from __future__ import annotations

from pathlib import Path

from . import bench_env

MTEB_REQUIREMENTS = Path(__file__).with_name("mteb_env_requirements.txt")
MTEB_VENV_DIRNAME = "mteb-env"
MTEB_MARKER = "uplift-mteb-env.json"


def _mteb_importable(py: Path) -> None:
    import subprocess
    r = subprocess.run([str(py), "-c", "import mteb"], capture_output=True,
                       text=True)
    if r.returncode != 0:
        raise RuntimeError(f"mteb not importable in built env: "
                           f"{r.stderr.strip()[-300:]}")


def mteb_status() -> dict:
    return bench_env.status(dirname=MTEB_VENV_DIRNAME, req=MTEB_REQUIREMENTS,
                            marker=MTEB_MARKER)


def mteb_create(*, reinstall: bool = False, quiet: bool = False) -> dict:
    return bench_env.create(reinstall=reinstall, quiet=quiet,
                            dirname=MTEB_VENV_DIRNAME, req=MTEB_REQUIREMENTS,
                            marker=MTEB_MARKER, import_name="mteb",
                            extra_check=_mteb_importable)
