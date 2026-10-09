"""`patch rollback` — the CLI twin of the dashboard's Roll Back button.

The dashboard has had POST /patches/rollback from the start; the CLI did
not, so an operator at a shell could not undo a bad promote without editing
the manifest by hand. The verb only rewrites the manifest (desired_version
steps back, state goes pending so the next restart re-applies), so these
tests mock the tree root instead of relying on an installed omlx — CI has
no omlx, and a live probe would fail them for the wrong reason.
"""
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from omlx_uplift import cli


class TestPatchRollbackVerb(unittest.TestCase):

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="cli-rb-")
        self.tree = tempfile.mkdtemp(prefix="cli-rb-tree-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        from omlx_uplift import patches

        self.store = patches.PatchStore()
        self.store.save({"patches": [
            {"id": "alpha", "enabled": True, "order": 100,
             "source": {"kind": "url", "url": "http://x/alpha.diff"},
             "desired_version": 3,
             "versions": [{"v": n, "content_sha256": "c",
                           "fetched_at": "2026-10-01T00:00"}
                          for n in (1, 2, 3)],
             "state": "applied", "state_detail": "",
             "description": "alpha"}]})
        # cmd_patches refuses to do anything when it cannot see an omlx tree;
        # point it at a scratch dir so the verb's own logic is what is tested
        self._root = mock.patch(
            "omlx_uplift.patches._omlx_root",
            return_value=os.path.join(self.tree, "omlx"))
        self._root.start()
        self.addCleanup(self._root.stop)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.tree, ignore_errors=True)

    def _run(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(argv)
        return rc, json.loads(out.getvalue())

    def _patch(self):
        return self.store.find(self.store.load(), "alpha")

    def test_rollback_lands_on_the_previous_version(self):
        rc, res = self._run(["rollback", "alpha"])
        self.assertEqual(rc, 0, res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["desired_version"], 2)
        self.assertEqual(self._patch()["desired_version"], 2,
                         "the manifest must carry the rollback")
        self.assertEqual(self._patch()["state"], "pending",
                         "a rolled-back patch re-applies at the next restart")

    def test_to_v_targets_a_specific_stored_version(self):
        rc, res = self._run(["rollback", "alpha", "--to-v", "1"])
        self.assertEqual(rc, 0, res)
        self.assertEqual(res["desired_version"], 1)
        self.assertEqual(self._patch()["desired_version"], 1)

    def test_an_unstored_version_is_refused(self):
        rc, res = self._run(["rollback", "alpha", "--to-v", "9"])
        self.assertEqual(rc, 1)
        self.assertIn("not stored", res["reason"])
        self.assertEqual(self._patch()["desired_version"], 3,
                         "a refusal must change nothing")

    def test_a_patch_with_one_version_has_nothing_to_roll_back(self):
        m = self.store.load()
        m["patches"][0]["versions"] = [m["patches"][0]["versions"][0]]
        m["patches"][0]["desired_version"] = 1
        self.store.save(m)
        rc, res = self._run(["rollback", "alpha"])
        self.assertEqual(rc, 1)
        self.assertIn("no previous version", res["reason"])

    def test_an_unknown_id_is_refused(self):
        rc, res = self._run(["rollback", "ghost"])
        self.assertEqual(rc, 1)
        self.assertIn("unknown patch id", res["reason"])

    def test_the_id_is_mandatory(self):
        with self.assertRaises(SystemExit):        # argparse usage error
            self._run(["rollback"])

    def test_the_verb_appears_in_the_usage_text(self):
        from omlx_uplift import help as helpmod

        self.assertIn("rollback", helpmod.COMMAND_USAGE["patch"])


if __name__ == "__main__":
    unittest.main()
