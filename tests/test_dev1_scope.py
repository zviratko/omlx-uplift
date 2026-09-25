"""DEV-1 tests: patch scope field (runtime/build) + build-tree gating.

A 'build' patch gates against a full source checkout WITHOUT skip-pruning
(UNPRUNED diff bytes == stored bytes == sha-consistency rule) and is never
applied to the keg: reconcile ignores it, view shows it inactive. Runtime
patches (absent scope, v1 manifests) must behave byte-identically.
"""

import hashlib
import os
import shutil
import tempfile
import unittest
import unittest.mock

from omlx_uplift import patchsource, patches, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
PR3764 = open(os.path.join(FIX, "pr3764.diff"), "rb").read()

# a kernel-touching diff: one section under csrc/ (never in the keg), one
# real Python section (in the keg). Whole-repo shape as a PR would carry it.
CSRC_DIFF = (
    b"diff --git a/omlx/custom_kernels/fastattn/csrc/attn.mm "
    b"b/omlx/custom_kernels/fastattn/csrc/attn.mm\n"
    b"index 1111111..2222222 100644\n"
    b"--- a/omlx/custom_kernels/fastattn/csrc/attn.mm\n"
    b"+++ b/omlx/custom_kernels/fastattn/csrc/attn.mm\n"
    b"@@ -1,2 +1,3 @@\n"
    b" kernel line one\n"
    b" kernel line two\n"
    b"+kernel line three\n"
    b"diff --git a/omlx/kernels.py b/omlx/kernels.py\n"
    b"index 3333333..4444444 100644\n"
    b"--- a/omlx/kernels.py\n"
    b"+++ b/omlx/kernels.py\n"
    b"@@ -1,2 +1,3 @@\n"
    b" import Metal\n"
    b" KERNELS = {}\n"
    b"+EXTRA = 1\n"
)


def _make_source_tree(root):
    """A fake full-repo checkout: the keg paths PLUS csrc/ and tests/."""
    pkg = os.path.join(root, "omlx")
    os.makedirs(pkg)
    with open(os.path.join(pkg, "__init__.py"), "wb") as fh:
        fh.write(b"")
    csrc = os.path.join(pkg, "custom_kernels", "fastattn", "csrc")
    os.makedirs(csrc)
    with open(os.path.join(csrc, "attn.mm"), "wb") as fh:
        fh.write(b"kernel line one\nkernel line two\n")
    with open(os.path.join(pkg, "kernels.py"), "wb") as fh:
        fh.write(b"import Metal\nKERNELS = {}\n")


class ScopeHelpersTest(unittest.TestCase):
    def test_absent_scope_is_runtime(self):
        self.assertEqual(patches.patch_scope({}), patches.SCOPE_RUNTIME)
        self.assertEqual(patches.patch_scope({"scope": "nonsense"}),
                         patches.SCOPE_RUNTIME)
        self.assertEqual(patches.patch_scope({"scope": "build"}),
                         patches.SCOPE_BUILD)

    def test_manifest_version_is_2(self):
        self.assertEqual(patches.MANIFEST_VERSION, 2)


class ScopeGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-dev1-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # keg tree: site-packages/omlx (fixture) — no csrc/, no repo files
        self.keg = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.keg, "omlx"))
        # source tree: full checkout with csrc/
        self.src = os.path.join(self.tmp, "src")
        _make_source_tree(self.src)
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def test_build_gate_passes_unpruned_and_sha_matches_stored_bytes(self):
        res = patchsource.add_patch(
            self.store, "kern", {"kind": "upload", "data": CSRC_DIFF},
            self.keg, scope="build", build_root=self.src)
        self.assertTrue(res["ok"], res)
        m = self.store.load()
        p = self.store.find(m, "kern")
        self.assertEqual(p["scope"], "build")
        ver = p["versions"][0]
        # stored bytes are the UNPRUNED diff: gate sha == sha of original
        self.assertEqual(ver["content_sha256"],
                         hashlib.sha256(CSRC_DIFF).hexdigest())
        pf = ver["patch_file"]
        with open(os.path.join(self.store.base_dir, pf), "rb") as fh:
            self.assertEqual(fh.read(), CSRC_DIFF)

    def test_auto_classify_names_build_only_sections(self):
        # runtime auto-classification without scope: keg gate fails because
        # csrc/ is missing from the keg; verdict must name the section and
        # only the whole-patch build scope is offered
        res = patchsource.add_patch(
            self.store, "kern", {"kind": "upload", "data": CSRC_DIFF},
            self.keg, build_root=self.src)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("stage"), "classification")
        self.assertIn("omlx/custom_kernels/fastattn/csrc/attn.mm",
                      res["needs_build_scope"])
        # nothing stored
        m = self.store.load()
        self.assertIsNone(self.store.find(m, "kern"))

    def test_dev_build_root_follows_dev_json_across_base_split(self):
        """mruu regression: bootstrap ran with OMLX_BASE_PATH set (dev.json
        + dev-src live under ~/.omlx/uplift), the add ran with a different
        (or no) OMLX_BASE_PATH — the gate must find dev-src via dev.json,
        exactly like `dev status` does. The old hardcoded <base>/dev-src
        guess rejected every build-scope add on that machine."""
        import json as _json
        tmp = tempfile.mkdtemp(prefix="uplift-buildroot-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        real_base = os.path.join(tmp, ".omlx", "uplift")
        src = os.path.join(real_base, "dev-src")
        os.makedirs(os.path.join(src, ".git"))
        with open(os.path.join(real_base, "dev.json"), "w") as fh:
            _json.dump({"src_path": src}, fh)
        env = dict(os.environ, OMLX_BASE_PATH=os.path.join(tmp, ".omlx-dev"))
        orig_expand = os.path.expanduser
        with unittest.mock.patch.dict(os.environ, env):
            # redirect ~ into the fixture so the canonical base is found
            os.path.expanduser = (
                lambda p: p.replace("~", tmp) if p.startswith("~")
                else orig_expand(p))
            try:
                self.assertEqual(patchsource.dev_build_root(), src)
            finally:
                os.path.expanduser = orig_expand

    def test_build_scope_without_build_root_refuses(self):
        res = patchsource.add_patch(
            self.store, "kern", {"kind": "upload", "data": CSRC_DIFF},
            self.keg, scope="build")
        self.assertFalse(res["ok"])
        self.assertIn("source checkout", res["reason"])

    def test_scope_is_fixed_per_patch(self):
        res = patchsource.add_patch(
            self.store, "kern", {"kind": "upload", "data": CSRC_DIFF},
            self.keg, scope="build", build_root=self.src)
        self.assertTrue(res["ok"], res)
        res2 = patchsource.add_patch(
            self.store, "kern", {"kind": "upload", "data": CSRC_DIFF},
            self.keg, scope="runtime", build_root=self.src)
        self.assertFalse(res2["ok"])
        self.assertIn("scope is fixed per patch", res2["reason"])

    def test_runtime_patch_still_gates_against_keg(self):
        res = patchsource.add_patch(
            self.store, "demo", {"kind": "upload", "data": PR3764}, self.keg)
        self.assertTrue(res["ok"], res)
        m = self.store.load()
        p = self.store.find(m, "demo")
        # runtime is the implicit default — no scope key written (v1 shape)
        self.assertNotIn("scope", p)
        self.assertEqual(patches.patch_scope(p), patches.SCOPE_RUNTIME)


class BuildPatchesNeverTouchKegTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-dev1r-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.keg = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.keg, "omlx"))
        self.src = os.path.join(self.tmp, "src")
        _make_source_tree(self.src)
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        res = patchsource.add_patch(
            self.store, "kern", {"kind": "upload", "data": CSRC_DIFF},
            self.keg, scope="build", build_root=self.src)
        self.assertTrue(res["ok"], res)

    def _keg_bytes(self):
        target = os.path.join(self.keg, "omlx", "admin", "routes.py")
        with open(target, "rb") as fh:
            return fh.read()

    def test_reconcile_ignores_enabled_build_patch(self):
        # csrc/ sections raise the kernel_source safeguard: approve it
        r = patchsource.set_enabled(self.store, "kern", True, approve="always")
        self.assertEqual(r["state"], "pending")
        before = self._keg_bytes()
        report = patchsync.reconcile(self.store, self.keg, allow_reexec=False)
        # no reports at all: the build patch is invisible to reconcile
        self.assertEqual(report["reports"], [])
        self.assertFalse(report["changed"])
        self.assertEqual(self._keg_bytes(), before)
        m = self.store.load()
        p = self.store.find(m, "kern")
        for v in p["versions"]:
            self.assertNotIn("applied", v)
            self.assertNotIn("backup_dir", v)

    def test_view_shows_build_patch_inactive_with_reason(self):
        patchsource.set_enabled(self.store, "kern", True, approve="always")
        out = patchsource.view(self.store, self.keg,
                               patches.keg_id(os.path.join(self.keg, "omlx")))
        row = [p for p in out["patches"] if p["id"] == "kern"][0]
        self.assertEqual(row["scope"], "build")
        self.assertTrue(row["enabled"])
        self.assertFalse(row["active"])
        self.assertIn("omlx-dev", row["inactive_reason"])

    def test_disable_is_manifest_state_only(self):
        patchsource.set_enabled(self.store, "kern", True)
        patchsync.reconcile(self.store, self.keg, allow_reexec=False)
        before = self._keg_bytes()
        r = patchsource.set_enabled(self.store, "kern", False)
        self.assertTrue(r["ok"])
        report = patchsync.reconcile(self.store, self.keg, allow_reexec=False)
        self.assertEqual(report["reports"], [])
        self.assertEqual(self._keg_bytes(), before)

    def test_removal_of_build_patch_keeps_keg_untouched(self):
        patchsource.set_enabled(self.store, "kern", True)
        before = self._keg_bytes()
        r = patchsource.remove_patch(self.store, "kern", self.keg)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self._keg_bytes(), before)


class RuntimeRegressionTest(unittest.TestCase):
    """A v1-style manifest (no scope keys) reconciles byte-identically."""

    def test_runtime_reconcile_unchanged(self):
        tmp = tempfile.mkdtemp(prefix="uplift-dev1v-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        root = os.path.join(tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(root, "omlx"))
        store = patches.PatchStore(os.path.join(tmp, "data"))
        res = patchsource.add_patch(
            store, "demo", {"kind": "upload", "data": PR3764}, root)
        self.assertTrue(res["ok"], res)
        patchsource.set_enabled(store, "demo", True)
        report = patchsync.reconcile(store, root, allow_reexec=False)
        self.assertTrue(report["changed"])
        actions = [r["action"] for r in report["reports"]]
        self.assertIn("applied", actions)


if __name__ == "__main__":
    unittest.main()
