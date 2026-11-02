# Development

Tests live in `tests/` (pytest + node:test). CI (`.github/workflows/tests.yml`) runs both suites on every push to `main` as an alien-box fresh-checkout smoke - but `omlx` is not on PyPI and is Apple-Silicon-bound, so the runner cannot install it: the ~13 tests that exercise omlx internals SKIP there (conftest.py, reason printed per test). The full run needs the macOS dev box and the keg interpreter (the only python with fastapi + omlx):

```bash
# one-time helper libs (system python3 lacks pytest); the interpreter is
# the omlx keg's libexec python - classic keg if installed, else omlx-dev
/opt/homebrew/opt/omlx/libexec/bin/pip install -q --target ~/hermes/TMP/pylibs \
    pytest pytest-asyncio

cd ~/git/omlx-uplift-repo && \
PYTHONPATH=$HOME/hermes/TMP/pylibs:. /opt/homebrew/opt/omlx/libexec/bin/python \
    -m pytest tests -q            # ~540 tests, ~30 s

for f in omlx_uplift/static/*.js; do node --check "$f"; done \
    && node --test tests/*.cjs
# (`node --check a.js b.js` validates ONLY the first argument - never
#  trust the glob form; scripts/nightly-tests.sh loops for the same reason)
```

`PYTHONPATH` must put the clone BEFORE the deployed keg copy, otherwise tests silently exercise the installed package (confirm with `python -c "import omlx_uplift; print(omlx_uplift.__file__)"`).
