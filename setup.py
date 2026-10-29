"""Classic build hook: bundle the curated catalog seed inside the package.

`curated_patches/` keeps its repository path permanently. Installed uplifts and
stored catalog patches carry raw URLs built from it
(`raw.githubusercontent.com/zviratko/omlx-uplift/HEAD/curated_patches/...`), so
moving that directory 404s every machine that has not updated yet - it did, on
the first attempt at this change (mruu report, five re-gate failures from
`dev upgrade`).

The artifact still needs a copy INSIDE the package, because that is what lets an
install know its own catalog without the GitHub contents API, which is capped at
60 requests per hour unauthenticated and whose refusal used to empty the catalog
silently. One canonical location in git, one generated copy in the wheel:
`curated.SEED_DIRS` reads the installed copy first and falls back to the source
tree, so a checkout run (`PYTHONPATH=repo python -m omlx_uplift.cli`, the nightly
loop, editable installs) sees the same catalog without a build step.

Proof that the copy actually lands is the tap build itself: after `brew install
--HEAD omlx-uplift`, the files must exist under
`.../site-packages/omlx_uplift/curated_patches/<tier>/`.
"""

import os
import shutil

from setuptools import setup
from setuptools.command.build_py import build_py

PKG = "omlx_uplift"
CATALOG = "curated_patches"
HERE = os.path.dirname(os.path.abspath(__file__))


class build_py_with_catalog(build_py):
    """build_py, plus the catalog seed copied into the built package."""

    def run(self):
        super().run()
        src = os.path.join(HERE, CATALOG)
        if not os.path.isdir(src):
            self.warn("no %s/ in the source tree - the wheel ships without a "
                      "catalog seed" % CATALOG)
            return
        total = 0
        for tier in sorted(os.listdir(src)):
            tdir = os.path.join(src, tier)
            if not os.path.isdir(tdir):
                continue
            out = os.path.join(self.build_lib, PKG, CATALOG, tier)
            self.mkpath(out)
            for name in sorted(os.listdir(tdir)):
                shutil.copy2(os.path.join(tdir, name), os.path.join(out, name))
                total += 1
        self.announce("bundled catalog seed: %d files -> %s/%s"
                      % (total, PKG, CATALOG))


setup(
    name="omlx-uplift",
    cmdclass={"build_py": build_py_with_catalog},
)
