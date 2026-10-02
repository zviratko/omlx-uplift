"""BE-3 step 5: add_patch returns ONE PatchOpResult — the wire contract.

v1 was 275 lines / 12 non-uniform dict returns; the phases (gate/store/
adopt/transition) each return a PatchOpResult and render() reproduces the
historical dicts KEY-EXACTLY (tests + CLI + JS read a subset; this test
pins the superset so future phases cannot silently drop a field).

Each test drives the REAL store/fixture path and asserts the full key
set of the matching v1 verdict."""
import os
import shutil
import tempfile
import unittest

from omlx_uplift import diffapply, patchsource, patches

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
PR3764 = open(os.path.join(FIX, "pr3764.diff"), "rb").read()


class AddPatchContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-be3s5-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _upload(self, data, **kw):
        return patchsource.add_patch(self.store, "demo",
                                     {"kind": "upload", "data": data},
                                     self.root, **kw)

    def test_config_reject_keyset(self):
        r = self._upload(PR3764, scope="nonsense")
        self.assertEqual(r, {"ok": False, "reason": r["reason"]})
        self.assertNotIn("stage", r)

    def test_gate_failure_keyset_and_new_patch_left_out(self):
        broken = (b"diff --git a/omlx/admin/routes.py b/omlx/admin/routes.py\n"
                  b"--- a/omlx/admin/routes.py\n"
                  b"+++ b/omlx/admin/routes.py\n"
                  b"@@ -1,1 +1,1 @@\n-garbage line that cannot match\n+nope\n")
        r = self._upload(broken)
        self.assertEqual(
            set(r), {"ok", "stage", "reason", "files", "compile_problems",
                     "advisories"})
        self.assertEqual(r["stage"], "gate")
        self.assertFalse(r["ok"])
        # v1: a failed add of a NEW patch saved the manifest WITHOUT the
        # staged entry — nothing of 'demo' persists
        self.assertIsNone(self.store.find(self.store.load(), "demo"))

    def test_stored_verdict_keyset(self):
        r = self._upload(PR3764)
        self.assertEqual(
            set(r), {"ok", "v", "state", "reversal", "advisories", "files",
                     "safeguards", "requires_approval", "note"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["v"], 1)
        self.assertNotIn("stage", r)            # v1 never had it here
        self.assertNotIn("obsolete", r)

    def test_unchanged_verdict_keyset(self):
        self._upload(PR3764)
        r = self._upload(PR3764)
        self.assertEqual(r, {"ok": True, "unchanged": True, "v": 1,
                             "state": "disabled", "advisories": []})

    def test_only_one_response_shape_remains(self):
        """Source census: inside the add_patch pipeline no ad-hoc verdict
        dict may reappear — every return goes through PatchOpResult.render
        (the 12-shape drift is what this step deletes)."""
        import inspect

        from omlx_uplift import patchsource as ps
        src = inspect.getsource(ps.add_patch)
        for fn in ("_add_gate", "_add_store_version", "_add_adopt",
                   "_add_transition", "_add_reject"):
            src += inspect.getsource(getattr(ps, fn))
        self.assertNotIn('return {"ok"', src)
        self.assertNotIn("return {'ok'", src)

    def test_adopted_verdict_keyset(self):
        # hunks already on disk -> adopt as applied (obsolete key ALWAYS
        # present on this verdict: None when adopted, v1 quirk kept)
        diffapply.apply_diff(PR3764, self.root, os.path.join(self.tmp, "b0"))
        r = self._upload(PR3764)
        self.assertEqual(
            set(r), {"ok", "v", "adopted", "obsolete", "reversal", "state",
                     "reason", "advisories", "files"})
        self.assertTrue(r["adopted"])
        self.assertIsNone(r["obsolete"])

if __name__ == "__main__":
    unittest.main()
