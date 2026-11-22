"""Boot-time writers never patch an omlx SOURCE checkout.

`_omlx_root()` resolves through find_spec, so an interpreter started inside a
checkout (cwd on sys.path, editable install) finds the checkout. The .pth boot
sync used to treat that as a vanilla install and wrote every omlx/both-scope
patch into it, including PR worktrees during their test runs.
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from omlx_uplift import patches, patchsync, treedoctor


def _pkg(base: str, git: str | None) -> str:
    """Create base/omlx and, if asked, base/.git as a 'dir' or a 'file'."""
    root = os.path.join(base, "omlx")
    os.makedirs(root)
    open(os.path.join(root, "__init__.py"), "w").close()
    if git == "dir":
        os.makedirs(os.path.join(base, ".git"))
    elif git == "file":  # a git worktree
        with open(os.path.join(base, ".git"), "w") as fh:
            fh.write("gitdir: /somewhere/.git/worktrees/x\n")
    return root


class SourceCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-checkout-")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        os.environ.pop("OMLX_UPLIFT_NO_PATCHES", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detects_checkout_and_worktree_not_install(self):
        self.assertTrue(patches.is_source_checkout(
            _pkg(os.path.join(self.tmp, "repo"), "dir")))
        self.assertTrue(patches.is_source_checkout(
            _pkg(os.path.join(self.tmp, "wt"), "file")))
        self.assertFalse(patches.is_source_checkout(
            _pkg(os.path.join(self.tmp, "site-packages"), None)))
        self.assertFalse(patches.is_source_checkout(None))

    def test_boot_sync_skips_a_checkout_and_writes_nothing(self):
        root = _pkg(os.path.join(self.tmp, "repo"), "dir")
        with mock.patch.object(patches, "_omlx_root", return_value=root), \
                mock.patch.object(patchsync, "reconcile",
                                  side_effect=AssertionError("must not run")):
            report = patchsync.sync_at_startup(self.store, allow_reexec=False)
        self.assertEqual(report["skipped_reason"], "source checkout")
        self.assertFalse(report["changed"])
        self.assertFalse(report["reexec"])

    def test_boot_sync_still_reconciles_an_install(self):
        root = _pkg(os.path.join(self.tmp, "site-packages"), None)
        seen = {}

        def fake_reconcile(store, tree_root, allow_reexec=True):
            seen["tree_root"] = tree_root
            return {"changed": False, "reports": [], "reexec": False}

        with mock.patch.object(patches, "_omlx_root", return_value=root), \
                mock.patch.object(patchsync, "reconcile", fake_reconcile):
            patchsync.sync_at_startup(self.store, allow_reexec=False)
        self.assertEqual(seen["tree_root"], os.path.dirname(root))

    def test_explicit_tree_root_is_still_honored(self):
        # CLI and tests pass a tree on purpose, checkout or not.
        base = os.path.join(self.tmp, "repo")
        _pkg(base, "dir")
        seen = {}

        def fake_reconcile(store, tree_root, allow_reexec=True):
            seen["tree_root"] = tree_root
            return {"changed": False, "reports": [], "reexec": False}

        with mock.patch.object(patchsync, "reconcile", fake_reconcile):
            patchsync.sync_at_startup(self.store, base, allow_reexec=False)
        self.assertEqual(seen["tree_root"], base)

    def test_tree_doctor_boot_check_ignores_a_checkout(self):
        root = _pkg(os.path.join(self.tmp, "repo"), "dir")
        with mock.patch.object(patches, "_omlx_root", return_value=root), \
                mock.patch.object(treedoctor, "run",
                                  side_effect=AssertionError("must not run")):
            self.assertIsNone(treedoctor.boot_check(self.store))
        self.assertFalse(os.path.exists(treedoctor._state_path(self.store)))


if __name__ == "__main__":
    unittest.main()
