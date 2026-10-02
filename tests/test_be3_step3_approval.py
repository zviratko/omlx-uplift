"""BE-3 step 3: _apply_approval is the single safeguard-approval machine.

Ticket acceptance: the once-sha binding must reject a stale sha from
EITHER entry point (enable and promote), tested once against the shared
helper and once per caller — promote's drifted copy skipped the
post-approval coverage re-check, which is exactly how a 'once' approval
recorded against a DIFFERENT content sha could sail through.
"""
import os
import shutil
import tempfile
import unittest

from omlx_uplift import patchsource, patches


class ApplyApprovalTest(unittest.TestCase):
    def test_no_held_needs_no_approve(self):
        p = {"id": "x", "versions": []}
        ok, approved, err = patchsource._apply_approval(
            p, {"content_sha256": "s1", "safeguards": {"codes": []}}, None)
        self.assertTrue(ok)
        self.assertEqual(approved, [])
        self.assertIsNone(err)

    def test_held_requires_approve(self):
        p = {"id": "x"}
        v = {"content_sha256": "s1", "safeguards": {"codes": ["kernel_source"]}}
        for bad in (None, "", "yes"):
            ok, _, err = patchsource._apply_approval(p, v, bad)
            self.assertFalse(ok, bad)
            self.assertEqual(err["requires_approval"], ["kernel_source"])
        # recording untouched on refusal
        self.assertNotIn("safeguard_once", p)
        self.assertNotIn("safeguard_always", p)

    def test_once_binds_the_exact_sha(self):
        p = {"id": "x"}
        v = {"content_sha256": "s1", "safeguards": {"codes": ["kernel_source"]}}
        ok, approved, err = patchsource._apply_approval(p, v, "once")
        self.assertTrue(ok)
        self.assertEqual(approved, ["kernel_source"])
        self.assertEqual(p["safeguard_once"], {"sha": "s1",
                                               "codes": ["kernel_source"]})
        # same approval does NOT cover a different content sha (stale once)
        v2 = {"content_sha256": "s2", "safeguards": {"codes": ["kernel_source"]}}
        ok2, _, err2 = patchsource._apply_approval(dict(p), v2, None)
        self.assertFalse(ok2)
        self.assertEqual(err2["requires_approval"], ["kernel_source"])

    def test_always_covers_future_versions(self):
        p = {"id": "x"}
        v = {"content_sha256": "s1", "safeguards": {"codes": ["kernel_source"]}}
        ok, _, _ = patchsource._apply_approval(p, v, "always")
        self.assertTrue(ok)
        self.assertEqual(p["safeguard_always"], ["kernel_source"])
        v2 = {"content_sha256": "s2", "safeguards": {"codes": ["kernel_source"]}}
        ok2, _, _ = patchsource._apply_approval(p, v2, None)
        self.assertTrue(ok2)


class StoreLevelBindingTest(unittest.TestCase):
    """The ticket's test once more through the REAL entry points with a
    real store: a once-approval recorded via enable must NOT let promote
    accept a drifted (different-sha) candidate without approval."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-be3s3-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        m = self.store.load()
        m["patches"] = [{
            "id": "demo", "enabled": False, "order": 10, "source": {},
            "desired_version": 1, "state": "pending", "state_detail": "",
            "versions": [
                {"v": 1, "content_sha256": "sha-v1", "safeguards":
                    {"problems": [], "codes": ["kernel_source"]}},
                {"v": 2, "content_sha256": "sha-v2", "safeguards":
                    {"problems": [], "codes": ["kernel_source"]}},
            ],
        }]
        self.store.save(m)

    def _p(self):
        return self.store.find(self.store.load(), "demo")

    def test_enable_once_then_promote_rejects_stale_sha(self):
        r = patchsource.set_enabled(self.store, "demo", True, approve="once")
        self.assertTrue(r["ok"], r)
        once = self._p()["safeguard_once"]
        self.assertEqual(once["sha"], "sha-v1")
        # candidate v2 is NEW content; the once approval must not carry over
        pr = patchsource.promote(self.store, "demo")            # no approve
        self.assertFalse(pr["ok"])
        self.assertEqual(pr.get("requires_approval"), ["kernel_source"])
        # and promote's once binding records v2's sha, not v1's
        pr2 = patchsource.promote(self.store, "demo", approve="once")
        self.assertTrue(pr2["ok"], pr2)
        self.assertEqual(self._p()["safeguard_once"]["sha"], "sha-v2")

    def test_promote_rejects_without_approval(self):
        r = patchsource.promote(self.store, "demo")
        self.assertFalse(r["ok"])
        self.assertEqual(r.get("requires_approval"), ["kernel_source"])


if __name__ == "__main__":
    unittest.main()
