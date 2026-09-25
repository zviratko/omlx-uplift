"""DEV-6 tests: scope rename (omlx/dev/both), one shared store, target
gating, dev-side applied-state.

Byte-identical legacy behaviour is proven by the DEV-1 suite (legacy
--scope build now normalizes to 'dev' — asserted there).
"""

import json
import os
import shutil
import tempfile
import unittest
import unittest.mock

from omlx_uplift import patchsource, patches, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")

# csrc/ section (source tree only) + keg-installable python section
MIXED_DIFF = (
    b"diff --git a/tests/test_x.py b/tests/test_x.py\n"
    b"index 1111111..2222222 100644\n"
    b"--- a/tests/test_x.py\n"
    b"+++ b/tests/test_x.py\n"
    b"@@ -1,1 +1,2 @@\n"
    b" test line one\n"
    b"+test line two\n"
    b"diff --git a/omlx/kernels.py b/omlx/kernels.py\n"
    b"index 3333333..4444444 100644\n"
    b"--- a/omlx/kernels.py\n"
    b"+++ b/omlx/kernels.py\n"
    b"@@ -1,2 +1,3 @@\n"
    b" import Metal\n"
    b" KERNELS = {}\n"
    b"+EXTRA = 1\n"
)


class ScopeModelTests(unittest.TestCase):
    def test_legacy_normalize(self):
        self.assertEqual(patches.patch_scope({"scope": "runtime"}), "omlx")
        self.assertEqual(patches.patch_scope({"scope": "build"}), "dev")
        self.assertEqual(patches.patch_scope({}), "omlx")
        self.assertEqual(patches.patch_scope({"scope": "both"}), "both")

    def test_target_matrix(self):
        self.assertTrue(patches.scope_touches_keg("omlx"))
        self.assertTrue(patches.scope_touches_keg("both"))
        self.assertFalse(patches.scope_touches_keg("dev"))
        self.assertTrue(patches.scope_touches_dev("dev"))
        self.assertTrue(patches.scope_touches_dev("both"))
        self.assertFalse(patches.scope_touches_dev("omlx"))

    def test_detect_target_from_keg_path(self):
        self.assertEqual(
            patches.detect_patch_target(
                "/opt/hb/Cellar/omlx-dev/H/libexec/lib/python3.11/"
                "site-packages/omlx"), "dev")
        self.assertEqual(
            patches.detect_patch_target(
                "/opt/hb/Cellar/omlx/H/libexec/lib/python3.11/"
                "site-packages/omlx"), "omlx")


class BothScopeAddTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.keg = os.path.join(self.tmp, "keg")
        self.src = os.path.join(self.tmp, "src")
        os.makedirs(os.path.join(self.keg, "omlx"))
        os.makedirs(os.path.join(self.src, "omlx"))
        os.makedirs(os.path.join(self.src, "tests"))
        with open(os.path.join(self.keg, "omlx", "kernels.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        with open(os.path.join(self.src, "omlx", "kernels.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        with open(os.path.join(self.src, "tests", "test_x.py"), "w") as fh:
            fh.write("test line one\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "uplift"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_both_stores_full_diff_and_gates_keg_too(self):
        res = patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        self.assertTrue(res["ok"], res)
        m = self.store.load()
        p = self.store.find(m, "mix")
        self.assertEqual(p["scope"], "both")
        stored = open(os.path.join(self.store.base_dir,
                                   p["versions"][0]["patch_file"]),
                      "rb").read()
        # stored bytes are the FULL diff (tests/ survive for dev-src)
        self.assertIn(b"tests/test_x.py", stored)

    def test_both_rejected_when_keg_cannot_host(self):
        # keg tree WITHOUT kernels.py: pruned keg overlay fails to gate
        os.remove(os.path.join(self.keg, "omlx", "kernels.py"))
        res = patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("stage"), "keg-gate")

    def test_materialize_input_includes_both(self):
        patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        patchsource.set_enabled(self.store, "mix", True, approve="always")
        out = patchsource.enabled_build_patches(self.store)
        self.assertEqual([p["id"] for p in out], ["mix"])


class DevKegNeverMountsTests(unittest.TestCase):
    def test_reconcile_skips_everything_on_dev_keg(self):
        # DEV-6 decision 2: even omlx/both scopes must not overlay a dev keg
        import hashlib

        with tempfile.TemporaryDirectory() as tmp:
            store = patches.PatchStore(os.path.join(tmp, "uplift"))
            diff = (b"diff --git a/omlx/kernels.py b/omlx/kernels.py\n"
                    b"index 3..4 100644\n--- a/omlx/kernels.py\n"
                    b"+++ b/omlx/kernels.py\n@@ -1 +1,2 @@\n import Metal\n"
                    b"+OVERLAID = 1\n")
            pf = store.patch_file("pk", 1)
            os.makedirs(os.path.dirname(pf), exist_ok=True)
            with open(pf, "wb") as fh:
                fh.write(diff)
            store.save({"version": 2, "config": {}, "patches": [
                {"id": "pk", "enabled": True, "scope": "omlx",
                 "desired_version": 1, "state": "pending",
                 "versions": [{"v": 1, "content_sha256":
                               hashlib.sha256(diff).hexdigest(),
                               "patch_file": patches.rel(pf, store.base_dir)}]}]})
            target = os.path.join(tmp, "site-packages")
            os.makedirs(os.path.join(target, "omlx"))
            with open(os.path.join(target, "omlx", "kernels.py"), "w") as fh:
                fh.write("import Metal\n")
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                patchsync.reconcile(store, target, allow_reexec=False)
            # the patched source already carries everything: no overlay,
            # state untouched
            with open(os.path.join(target, "omlx", "kernels.py")) as fh:
                self.assertNotIn("OVERLAID", fh.read())
            self.assertEqual(store.find(store.load(), "pk")["state"],
                             "pending")

    def test_mark_dev_applied_clears_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = patches.PatchStore(os.path.join(tmp, "uplift"))
            m = {"version": 2, "config": {}, "patches": [
                {"id": "p1", "enabled": True, "scope": "dev",
                 "desired_version": 1, "state": "pending",
                 "versions": [{"v": 1, "content_sha256": "x"}]}]}
            store.save(m)
            patchsource.mark_dev_applied(
                store, [{"id": "p1", "v": 1, "sha": "abc123"}])
            out = store.load()
            p = store.find(out, "p1")
            self.assertEqual(p["state"], "applied")
            self.assertEqual(p["versions"][0]["dev_applied"]["sha"], "abc123")


class ViewScopeFilterTests(unittest.TestCase):
    def test_cli_status_shows_all_by_default(self):
        # 'patches status' must list every scope (item 5e); 'dev patches'
        # lists dev+both (item 5f). Both read the ONE store (item 8g).
        import subprocess
        import sys

        here = os.path.dirname(os.path.abspath(patches.__file__))
        pkg_parent = os.path.dirname(here)
        env = dict(os.environ, PYTHONPATH=pkg_parent)
        # argparse-level: --scope choices carry the new names and legacy
        out = subprocess.run(
            [sys.executable, "-m", "omlx_uplift.cli", "patches", "--help"],
            capture_output=True, text=True, env=env, cwd="/")
        self.assertIn("omlx", out.stdout)
        self.assertIn("both", out.stdout)
        out = subprocess.run(
            [sys.executable, "-m", "omlx_uplift.cli", "dev", "--help"],
            capture_output=True, text=True, env=env, cwd="/")
        self.assertIn("patches", out.stdout)


if __name__ == "__main__":
    unittest.main()
