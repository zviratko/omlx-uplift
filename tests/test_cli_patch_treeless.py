"""CLI: patch verbs on a machine whose omlx tree cannot be resolved.

The shape that produced this file (mruu, 2026-10-29): a keg directory was
removed from the Cellar while /opt/homebrew/opt/omlx-dev still pointed at it, so
no tree resolved. `patch status` then refused, and so did every verb that only
reads and writes ~/.omlx/uplift - which is the one moment an operator needs to
see what is applied and drop the patch that broke the build.

Every test here drives the REAL cli.main() against an isolated UPLIFT_HOME store
with _patch_targets forced to report no tree, because the old tests that claimed
to cover store-only verbs never mocked the tree resolution and so only ever ran
where a keg existed (the KILL-NOTREE lesson).
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

from omlx_uplift import cli


def _store_with_two_patches(base):
    """One runtime patch carrying a pristine backup, one build-scope patch."""
    os.makedirs(os.path.join(base, "backups", "demo.v1"), exist_ok=True)
    with open(os.path.join(base, "backups", "demo.v1", "omlx_demo.py"), "w") as f:
        f.write("fake pristine bytes\n")
    manifest = {
        "version": 1,
        "config": {"default_target": "dev"},
        "patches": [
            {"id": "demo-runtime", "enabled": True, "scope": "omlx",
             "state": "applied", "desired_version": 1,
             "versions": [{"v": 1,
                           "applied": {"at": "x", "sha": "abc"},
                           "kegs": {"keg-fake": {
                               "status": "applied", "at": "x",
                               "backup_dir": "backups/demo.v1",
                               "tree_root": "/nonexistent/site-packages"}}}]},
            {"id": "demo-build", "enabled": True, "scope": "dev",
             "state": "applied", "desired_version": 1,
             "versions": [{"v": 1, "dev_applied": {"at": "x", "sha": "def"}}]},
        ],
    }
    with open(os.path.join(base, "patches.json"), "w") as f:
        json.dump(manifest, f)


def _run(argv, want, rows, missing, base):
    """cli.main() with the tree resolution forced; returns (rc, out, err)."""
    old_argv = sys.argv
    sys.argv = ["omlx-uplift", *argv]
    out, err = io.StringIO(), io.StringIO()
    targets = mock.patch.object(cli, "_patch_targets",
                                return_value=(want, rows, missing))
    env = mock.patch.dict(os.environ, {"UPLIFT_HOME": base})
    try:
        with targets, env, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            rc = cli.main()
    finally:
        sys.argv = old_argv
    return rc, out.getvalue(), err.getvalue()


class TreelessStoreVerbs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.join(self.tmp.name, "uplift")
        os.makedirs(self.base, exist_ok=True)
        _store_with_two_patches(self.base)
        self.no_rows = ("dev", [], ["dev"])

    def tearDown(self):
        self.tmp.cleanup()

    def _manifest(self):
        with open(os.path.join(self.base, "patches.json")) as f:
            return json.load(f)

    # ---- the listing must answer -----------------------------------------
    def test_status_lists_the_store_and_says_no_tree_was_read(self):
        rc, out, err = _run(["patch", "status"], *self.no_rows, self.base)
        self.assertEqual(rc, 0, msg=err)
        self.assertIn("demo-runtime", out)
        self.assertIn("demo-build", out)
        self.assertIn("no omlx tree found", out)          # the WARNING banner
        self.assertIn("no omlx install tree found", err)  # and the note
        self.assertIn(self.base, err)   # names the REAL store, not a guess

    def test_status_json_carries_the_missing_target(self):
        rc, out, err = _run(["patch", "status", "--json"], *self.no_rows,
                            self.base)
        self.assertEqual(rc, 0, msg=err)
        payload = json.loads(out)
        self.assertEqual(payload["tree_missing"], ["dev"])
        self.assertEqual(payload["tree"], "")
        self.assertEqual([p["id"] for p in payload["patches"]],
                         ["demo-runtime", "demo-build"])

    # ---- per-patch control is store state, not tree bytes ----------------
    def test_disable_works_without_a_tree(self):
        rc, out, err = _run(["patch", "disable", "demo-runtime"], *self.no_rows,
                            self.base)
        self.assertEqual(rc, 0, msg=err)
        self.assertTrue(json.loads(out)["ok"])
        entry = [p for p in self._manifest()["patches"]
                 if p["id"] == "demo-runtime"][0]
        self.assertFalse(entry["enabled"])

    def test_promote_and_rollback_answer_without_a_tree(self):
        for verb in ("promote", "rollback"):
            rc, out, err = _run(["patch", verb, "demo-build"], *self.no_rows,
                                self.base)
            self.assertEqual(rc, 1, msg=err)     # honest 'no candidate', not rc 2
            self.assertIn("ok", out)

    def test_remove_forgets_the_entry_and_keeps_the_backups(self):
        rc, out, err = _run(["patch", "remove", "demo-runtime"], *self.no_rows,
                            self.base)
        self.assertEqual(rc, 0, msg=err)
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["backups_kept"])
        self.assertIn("not restored", payload["tree_bytes"])
        ids = [p["id"] for p in self._manifest()["patches"]]
        self.assertNotIn("demo-runtime", ids)     # boot will not re-apply it
        kept = os.path.join(self.base, "backups", "demo.v1", "omlx_demo.py")
        self.assertTrue(os.path.isfile(kept))     # the only copy survives

    # ---- verbs that genuinely need a tree still refuse, with a way out ---
    def test_apply_still_refuses_and_names_the_repair(self):
        rc, out, err = _run(["patch", "apply"], *self.no_rows, self.base)
        self.assertEqual(rc, 2)
        self.assertIn("needs a real install tree", err)
        self.assertIn("omlx-uplift dev use", err)     # the actual fix

    def test_refusal_lists_the_kegs_that_survive(self):
        with mock.patch.object(cli, "_dev_keg_versions",
                               return_value=["20261029.062511.0e7bff2"]):
            rc, out, err = _run(["patch", "apply"], *self.no_rows, self.base)
        self.assertEqual(rc, 2)
        self.assertIn("20261029.062511.0e7bff2", err)
        self.assertNotIn("dev bootstrap", err.split("no omlx-dev keg")[0])

    def test_bootstrap_advice_only_appears_when_the_cellar_is_empty(self):
        with mock.patch.object(cli, "_dev_keg_versions", return_value=[]):
            rc, out, err = _run(["patch", "apply"], *self.no_rows, self.base)
        self.assertIn("dev bootstrap", err)

    # ---- 'both' on a box with one real tree answers for that tree --------
    def test_one_missing_tree_does_not_blank_the_other_board(self):
        rows = [("omlx", "/some/site-packages", "/some/site-packages/omlx")]
        rc, out, err = _run(["patch", "status"], "both", rows, ["dev"],
                            self.base)
        self.assertIn("target 'dev' has no resolvable tree", err)
        self.assertEqual(rc, 0, msg=out + err)


if __name__ == "__main__":
    unittest.main()
