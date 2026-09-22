"""`omlx-uplift install` patch-preview tests (visible banner + verdicts).

patch_preview() is a pure dry-run: verdicts success / applied / warning /
failure map onto diffapply.check_diff statuses and the manifest's applied
records. print_patch_preview() must never raise and never emit ANSI codes
when the stream is not a TTY.
"""

import io
import os
import shutil
import tempfile
import unittest

from omlx_uplift import cli, diffapply, patches, patchsource, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
PR3764 = open(os.path.join(FIX, "pr3764.diff"), "rb").read()


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-prev-")
        self.addCleanup(shutil_cleanup, self.tmp)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        res = patchsource.add_patch(self.store, "demo",
                                    {"kind": "upload", "data": PR3764},
                                    self.root)
        self.assertTrue(res["ok"], res)
        patchsource.set_enabled(self.store, "demo", True)

    def _preview(self, keg=None):
        rows = cli.patch_preview(self.store, self.root, keg)
        return {r["id"]: r["verdict"] for r in rows}

    def test_pending_clean_diff_reports_success(self):
        self.assertEqual(self._preview(), {"demo": "success"})

    def test_applied_and_verified_reports_applied(self):
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        keg = patches.keg_id(os.path.join(self.root, "omlx"))
        self.assertEqual(self._preview(keg), {"demo": "applied"})

    def test_upstream_merged_reports_warning(self):
        # simulate upstream shipping the same fix: new-side bytes on disk,
        # no applied record for this keg (as after an omlx upgrade)
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        m = self.store.load()
        p = self.store.find(m, "demo")
        for v in p["versions"]:
            v.pop("applied", None)          # fresh keg: nothing recorded
        self.store.save(m)
        self.assertEqual(self._preview("keg-new"), {"demo": "warning"})

    def test_drifted_target_reports_failure(self):
        target = os.path.join(self.root, "omlx", "admin", "routes.py")
        data = open(target, "rb").read()
        # break a context line the diff requires verbatim (upstream reflow)
        self.assertIn(b"    cache_changed = False", data)
        open(target, "wb").write(
            data.replace(b"    cache_changed = False",
                         b"    cache_changed: bool = False", 1))
        self.assertEqual(self._preview(), {"demo": "failure"})

    def test_disabled_patch_is_not_listed(self):
        patchsource.set_enabled(self.store, "demo", False)
        self.assertEqual(self._preview(), {})

    def test_missing_diff_file_reports_failure(self):
        m = self.store.load()
        p = self.store.find(m, "demo")
        v = self.store.get_version(p, p["desired_version"])
        path = os.path.join(self.store.base_dir, v["patch_file"])
        os.remove(path)
        self.store.save(m)
        row = cli.patch_preview(self.store, self.root, None)[0]
        self.assertEqual(row["verdict"], "failure")
        self.assertIn("missing", row["detail"])


class BannerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-banner-")
        self.addCleanup(shutil_cleanup, self.tmp)

    def test_no_ansi_on_non_tty(self):
        class Fake(io.StringIO):
            def isatty(self):
                return False
        out = Fake()
        self.assertEqual(cli._paint(out, "SUCCESS", "32"), "SUCCESS")
        tty = io.StringIO()
        tty.isatty = lambda: True           # type: ignore[assignment]
        self.assertEqual(cli._paint(tty, "SUCCESS", "32"),
                         "\033[32mSUCCESS\033[0m")

    def test_banner_never_raises_without_omlx(self):
        # omlx may be unimportable here (CLI venv) — install must not break
        out = io.StringIO()
        cli.print_patch_preview(None, stream=out)   # must not raise
        self.assertIn("OMLX-UPLIFT PATCHES", out.getvalue())


def shutil_cleanup(path):
    shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
