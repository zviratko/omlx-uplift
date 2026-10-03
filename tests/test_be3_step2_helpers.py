"""BE-3 step 2: _gate_root_selection + _store_version — the drift-path
schema fix and the single gate-root rule.

Behavior fix under test: check_all's update-candidate path used to build
its own version dict WITHOUT safeguards/root_note, so drift candidates
silently lost fields the pending path enforced (two schemas, already
drifted). Now one writer, superset schema, both paths."""
import os
import shutil
import tempfile
import unittest

from omlx_uplift import patchsource, patches


class StoreVersionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-be3s2-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _result(self, **over):
        r = {"diff": b"diff --git a/omlx/x.py b/omlx/x.py\n",
             "content_sha256": "ab" * 32,
             "source_head_sha": "cd" * 32}
        r.update(over)
        return r

    def test_schema_superset_everywhere(self):
        patch = {"id": "demo", "versions": []}
        v = patchsource._store_version(
            self.store, patch,
            self._result(safeguards={"problems": [{"code": "kernel_source"}],
                                     "codes": ["kernel_source"]},
                         note="root normalized: stripped 1 component"))
        self.assertEqual(v["v"], 1)
        self.assertEqual(v["content_sha256"], "ab" * 32)
        self.assertEqual(v["source_head_sha"], "cd" * 32)
        self.assertIn("fetched_at", v)
        self.assertIn("patch_file", v)
        # the two fields check_all's copy used to DROP:
        self.assertEqual(v["safeguards"]["codes"], ["kernel_source"])
        self.assertEqual(v["root_note"],
                         "root normalized: stripped 1 component")
        self.assertIs(patch["versions"][0], v)     # appended, save left to host
        # bytes really on disk
        with open(os.path.join(self.store.base_dir, v["patch_file"]), "rb") as fh:
            self.assertEqual(fh.read(), self._result()["diff"])

    def test_absent_fields_stay_absent(self):
        patch = {"id": "demo2", "versions": []}
        v = patchsource._store_version(self.store, patch, self._result())
        self.assertNotIn("safeguards", v)
        self.assertNotIn("root_note", v)


class GateRootSelectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-be3s2b-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        self.tree = os.path.join(self.tmp, "site-packages")
        os.makedirs(os.path.join(self.tree, "omlx"))

    def test_runtime_uses_overlay_and_skip_patterns(self):
        manifest = {"patches": [], "config": {"skip_path_prefixes": ["*/tests/*"]}}
        patch = {"id": "demo", "versions": []}
        calls = []
        orig = patchsource._pristine_overlay
        patchsource._pristine_overlay = lambda s, p, t: calls.append(t) or {"x": None}
        try:
            root, ov, skip, kind = patchsource._gate_root_selection(
                self.store, manifest, patch, self.tree)
        finally:
            patchsource._pristine_overlay = orig
        self.assertEqual(root, self.tree)
        self.assertEqual(ov, {"x": None})
        self.assertEqual(skip, ["*/tests/*"])
        self.assertEqual(kind, "keg")
        self.assertEqual(calls, [self.tree])

    def test_dev_scope_unpruned_and_no_overlay(self):
        manifest = {"patches": [], "skip_patterns": ["*/tests/*"]}
        patch = {"id": "d", "versions": [], "scope": "dev"}
        root, ov, skip, kind = patchsource._gate_root_selection(
            self.store, manifest, patch, self.tree, dev_root="/fake/dev")
        self.assertEqual(root, "/fake/dev")
        self.assertIsNone(ov)
        self.assertIsNone(skip)             # UNPRUNED: stored bytes are the full diff
        self.assertEqual(kind, "src")       # a source checkout, NOT a keg

    def test_dev_scope_missing_root_is_falsy_for_caller_wording(self):
        manifest = {"patches": []}
        patch = {"id": "d", "versions": [], "scope": "both"}
        orig = patchsource.dev_build_root
        patchsource.dev_build_root = lambda: None
        try:
            root, ov, skip, kind = patchsource._gate_root_selection(
                self.store, manifest, patch, self.tree)
        finally:
            patchsource.dev_build_root = orig
        self.assertFalse(root)              # each call site keeps its own error


if __name__ == "__main__":
    unittest.main()
