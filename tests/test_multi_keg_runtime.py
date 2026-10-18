"""RUNTIME-MOUNT doctrine tests (2026-10-18): one shared store, two boards.

An omlx-scope patch can be live on the vanilla keg AND the omlx-dev keg at
the same time. Per-tree truth lives in version["kegs"][keg_id]; the legacy
single-slot applied/backup_dir fields mirror the most recent apply.
"""

import hashlib
import os
import tempfile
import unittest
import unittest.mock

from omlx_uplift import patchsource, patches, patchsync

DIFF = (b"diff --git a/omlx/kernels.py b/omlx/kernels.py\n"
        b"index 3..4 100644\n--- a/omlx/kernels.py\n"
        b"+++ b/omlx/kernels.py\n@@ -1 +1,2 @@\n import Metal\n"
        b"+OVERLAID = 1\n")


def make_tree(base, name, version):
    root = os.path.join(base, name, "site-packages")
    os.makedirs(os.path.join(root, "omlx"))
    with open(os.path.join(root, "omlx", "_version.py"), "w") as fh:
        fh.write(f'VERSION = "{version}"\n')
    with open(os.path.join(root, "omlx", "kernels.py"), "w") as fh:
        fh.write("import Metal\n")
    return root


def read_kernels(root):
    with open(os.path.join(root, "omlx", "kernels.py")) as fh:
        return fh.read()


class MultiKegFixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = patches.PatchStore(os.path.join(self._tmp.name, "uplift"))
        pf = self.store.patch_file("pk", 1)
        os.makedirs(os.path.dirname(pf), exist_ok=True)
        with open(pf, "wb") as fh:
            fh.write(DIFF)
        self.store.save({"version": 2, "config": {}, "patches": [
            {"id": "pk", "enabled": True, "scope": "omlx",
             "desired_version": 1, "state": "pending",
             "versions": [{"v": 1, "content_sha256":
                           hashlib.sha256(DIFF).hexdigest(),
                           "patch_file": patches.rel(pf, self.store.base_dir)}]}]})
        self.vroot = make_tree(self._tmp.name, "omlx", "1.0.0")
        self.droot = make_tree(self._tmp.name, "omlx-dev", "2.0.0")
        self.vkeg = patches.keg_id(os.path.join(self.vroot, "omlx"))
        self.dkeg = patches.keg_id(os.path.join(self.droot, "omlx"))
        self.assertNotEqual(self.vkeg, self.dkeg)

    def reconciled(self, root, target):
        with unittest.mock.patch.object(patches, "detect_patch_target",
                                        return_value=target):
            return patchsync.reconcile(self.store, root, allow_reexec=False)

    def manifest(self):
        return self.store.load()

    def patch(self):
        return self.store.find(self.manifest(), "pk")

    def version(self):
        return self.patch()["versions"][0]


class TwoBoardLifecycle(MultiKegFixture):
    def test_apply_on_vanilla_then_dev_both_carry(self):
        self.reconciled(self.vroot, "omlx")
        self.assertIn("OVERLAID", read_kernels(self.vroot))
        self.reconciled(self.droot, "dev")
        self.assertIn("OVERLAID", read_kernels(self.droot))
        ver = self.version()
        self.assertEqual(set(ver["kegs"]), {self.vkeg, self.dkeg})
        self.assertEqual(self.patch()["state"], "applied")

    def test_vanilla_resteady_after_dev_stamp_moves(self):
        # the classic flip-flop: dev applied last (legacy mirror points at
        # dev), vanilla restarts — must fast-verify, NOT re-apply or error
        self.reconciled(self.vroot, "omlx")
        self.reconciled(self.droot, "dev")
        before = read_kernels(self.vroot)
        rep = self.reconciled(self.vroot, "omlx")
        self.assertEqual(self.patch()["state"], "applied")
        self.assertFalse(rep["changed"])
        self.assertEqual(read_kernels(self.vroot), before)
        self.assertEqual([r["action"] for r in rep["reports"]], [])

    def test_disable_on_one_board_leaves_the_other_patched(self):
        self.reconciled(self.vroot, "omlx")
        self.reconciled(self.droot, "dev")
        m = self.manifest()
        self.store.find(m, "pk")["enabled"] = False
        self.store.save(m)
        self.reconciled(self.vroot, "omlx")
        self.assertNotIn("OVERLAID", read_kernels(self.vroot))
        self.assertIn("OVERLAID", read_kernels(self.droot))
        ver = self.version()
        self.assertNotIn(self.vkeg, ver.get("kegs") or {})
        self.assertIn(self.dkeg, ver.get("kegs") or {})

    def test_dev_apply_failure_keeps_vanilla_state_honest(self):
        self.reconciled(self.vroot, "omlx")
        # dev tree moved on: the stored context no longer exists anywhere
        with open(os.path.join(self.droot, "omlx", "kernels.py"), "w") as fh:
            fh.write("from metal import everything  # full rewrite upstream\n")
        rep = self.reconciled(self.droot, "dev")
        self.assertEqual(self.patch()["state"], "applied")
        rec = self.version()["kegs"][self.dkeg]
        self.assertEqual(rec["status"], "error")
        self.assertIn("detail", rec)
        self.assertIn("OVERLAID", read_kernels(self.vroot))
        self.assertNotIn("OVERLAID", read_kernels(self.droot))

    def test_remove_unwinds_both_trees(self):
        self.reconciled(self.vroot, "omlx")
        self.reconciled(self.droot, "dev")
        res = patchsource.remove_patch(self.store, "pk", self.vroot)
        self.assertTrue(res["ok"])
        self.assertNotIn("OVERLAID", read_kernels(self.vroot))
        self.assertNotIn("OVERLAID", read_kernels(self.droot))
        self.assertIsNone(self.store.find(self.manifest(), "pk"))


class ViewPerBoard(MultiKegFixture):
    def view(self, root, target):
        with unittest.mock.patch.object(patches, "detect_patch_target",
                                        return_value=target):
            keg = patches.keg_id(os.path.join(root, "omlx"))
            return patchsource.view(self.store, os.path.dirname(root), keg)

    def row(self, payload, keg_expected):
        rows = [r for r in payload["patches"] if True]
        return rows[0]

    def test_badges_are_board_local(self):
        self.reconciled(self.vroot, "omlx")
        v = self.view(self.vroot, "omlx")["patches"][0]
        self.assertEqual(v["applied_v"], 1)
        self.assertFalse(v["keg_changed"])
        d = self.view(self.droot, "dev")["patches"][0]
        # enabled + applied on the other board, not yet mounted here
        self.assertIsNone(d["applied_v"])
        self.assertTrue(d["keg_changed"])
        self.assertTrue(d["active"])
        self.assertIsNone(d.get("inactive_reason"))

    def test_legacy_stamp_still_reads(self):
        # pre-migration store shape: applied stamp only, no kegs map
        m = self.manifest()
        p = self.store.find(m, "pk")
        p["state"] = "applied"
        p["versions"][0]["applied"] = {
            "keg_id": self.vkeg, "at": "2026-10-18T00:00:00+00:00",
            "files": [{"path": "omlx/kernels.py",
                       "sha256": hashlib.sha256(
                           read_kernels(self.vroot).encode()).hexdigest(),
                       "status": "applied"}]}
        p["versions"][0]["backup_dir"] = "patches/backups/pk.v1/legacy"
        self.store.save(m)
        v = self.view(self.vroot, "omlx")["patches"][0]
        self.assertEqual(v["applied_v"], 1)
        self.assertFalse(v["keg_changed"])
        d = self.view(self.droot, "dev")["patches"][0]
        self.assertTrue(d["keg_changed"])


class TreeRootRecorded(MultiKegFixture):
    def test_record_carries_tree_root(self):
        self.reconciled(self.vroot, "omlx")
        rec = self.version()["kegs"][self.vkeg]
        self.assertEqual(rec["tree_root"], self.vroot)


if __name__ == "__main__":
    unittest.main()
