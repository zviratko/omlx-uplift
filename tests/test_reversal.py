"""Reversal patches: undo an already merged PR by applying its diff in the
un-apply direction. Covers the strict reverse applier (diffapply), the gate
+ adoption path (patchsource), reconcile (patchsync) and the CLI preview
verdict + summary line (cli).

Fixtures reuse the vendored PR diffs: base3764 is the PRE-image (the PR
applies forward), so a reversal of PR3764 there must FAIL the gate (the
merged change is absent); a reversal against a tree where the PR content is
already merged must verify and revert to base3764 bytes.
"""

import io
import json
import os
import shutil
import tempfile
import unittest

from omlx_uplift import cli, diffapply, patches, patchsource, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
PR3764 = open(os.path.join(FIX, "pr3764.diff"), "rb").read()


class TempTree(unittest.TestCase):
    """site-packages tree at the PR3764 PRE-image (forward diff applies)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-rev-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def target(self):
        return os.path.join(self.root, "omlx", "admin", "routes.py")

    def merge_pr3764(self):
        """Bring the tree to the MERGED image by applying the PR for real."""
        res = diffapply.apply_diff(PR3764, self.root,
                                   os.path.join(self.tmp, "seed-backup"))
        self.assertTrue(res["ok"], res)


class ReverseApplierTests(TempTree):
    def test_check_forward_on_preimage_is_ok(self):
        chk = diffapply.check_diff(PR3764, self.root)
        self.assertTrue(chk["ok"])

    def test_check_reverse_on_preimage_is_already(self):
        # merged change absent -> nothing to undo: 'already', gate stays ok
        chk = diffapply.check_diff(PR3764, self.root, reverse=True)
        self.assertTrue(chk["ok"])
        self.assertTrue(all(f["status"] == "already" for f in chk["files"]))

    def test_check_reverse_on_merged_image_is_ok(self):
        self.merge_pr3764()
        chk = diffapply.check_diff(PR3764, self.root, reverse=True)
        self.assertTrue(chk["ok"])
        self.assertTrue(all(f["status"] == "ok" for f in chk["files"]))

    def test_apply_reverse_restores_preimage_bytes(self):
        # byte-exact round trip: apply forward, capture merged bytes,
        # reverse-apply, compare against the original pre-image
        with open(self.target(), "rb") as fh:
            pre = fh.read()
        self.merge_pr3764()
        with open(self.target(), "rb") as fh:
            merged = fh.read()
        self.assertNotEqual(merged, pre)
        res = diffapply.apply_diff(PR3764, self.root,
                                   os.path.join(self.tmp, "rev-backup"),
                                   reverse=True)
        self.assertTrue(res["ok"], res)
        with open(self.target(), "rb") as fh:
            self.assertEqual(fh.read(), pre)

    def test_reversal_disable_restores_merged_bytes(self):
        # the reversal's backup must hold the MERGED bytes so a disable
        # (restore_backup) brings the merge back, not something else
        self.merge_pr3764()
        with open(self.target(), "rb") as fh:
            merged = fh.read()
        bdir = os.path.join(self.tmp, "rev-backup")
        res = diffapply.apply_diff(PR3764, self.root, bdir, reverse=True)
        self.assertTrue(res["ok"], res)
        one = diffapply.restore_backup(bdir, self.root)
        self.assertTrue(one["ok"], one)
        with open(self.target(), "rb") as fh:
            self.assertEqual(fh.read(), merged)

    def test_reverse_drift_fails_strictly(self):
        self.merge_pr3764()
        data = open(self.target(), "rb").read()
        self.assertIn(b"    cache_changed = False", b"x" + data)
        # corrupt a NEW-side context line the reverse match needs
        open(self.target(), "wb").write(
            data.replace(b"    cache_changed = False",
                         b"    cache_changed : bool = False", 1))
        chk = diffapply.check_diff(PR3764, self.root, reverse=True)
        self.assertFalse(chk["ok"])


class GateAndAdoptTests(TempTree):
    def test_reversal_gate_on_preimage_adopts_as_nothing_to_undo(self):
        # merged change absent: every file reports 'already' in reverse, so
        # the adoption path stores it as an APPLIED reversal (mirror of the
        # forward adopt: nothing to do now, but it reverts after a future
        # keg update brings the merge back)
        res = patchsource.add_patch(self.store, "undo-3764",
                                    {"kind": "upload", "data": PR3764},
                                    self.root, reversal=True)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res.get("reversal"))
        self.assertIn("already in effect", res.get("reason", ""))

    def test_reversal_gate_passes_on_merged_tree(self):
        self.merge_pr3764()
        with open(self.target(), "rb") as fh:
            merged = fh.read()
        res = patchsource.add_patch(self.store, "undo-3764",
                                    {"kind": "upload", "data": PR3764},
                                    self.root, reversal=True)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res.get("reversal"))
        m = self.store.load()
        p = self.store.find(m, "undo-3764")
        self.assertTrue(p["reversal"])
        # same lifecycle as a forward patch: stored, disabled until Enable
        self.assertFalse(p["enabled"])
        # nothing written yet — the revert happens at reconcile (restart)
        with open(self.target(), "rb") as fh:
            self.assertEqual(fh.read(), merged)
        patchsource.set_enabled(self.store, "undo-3764", True)
        rep = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertTrue(any(r.get("action") == "applied"
                            for r in rep["reports"]), rep)
        pre = open(os.path.join(FIX, "base3764", "omlx", "admin",
                                "routes.py"), "rb").read()
        with open(self.target(), "rb") as fh:
            self.assertEqual(fh.read(), pre)

    def test_reversal_reconcile_reverts_then_disable_restores_merge(self):
        self.merge_pr3764()
        pre = open(os.path.join(FIX, "base3764", "omlx", "admin",
                                "routes.py"), "rb").read()
        with open(self.target(), "rb") as fh:
            merged = fh.read()
        res = patchsource.add_patch(self.store, "undo-3764",
                                    {"kind": "upload", "data": PR3764},
                                    self.root, reversal=True)
        self.assertTrue(res["ok"], res)
        self.assertNotIn("adopted", res)      # merged tree: real revert pending
        patchsource.set_enabled(self.store, "undo-3764", True)
        rep = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertTrue(any(r.get("action") == "applied"
                            for r in rep["reports"]), rep)
        with open(self.target(), "rb") as fh:
            self.assertEqual(fh.read(), pre)   # merged change reverted
        # disable -> merged bytes back (backup holds the merged image)
        patchsource.set_enabled(self.store, "undo-3764", False)
        rep = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertTrue(any(r.get("action") == "restored"
                            for r in rep["reports"]), rep)
        with open(self.target(), "rb") as fh:
            self.assertEqual(fh.read(), merged)

    def test_direction_is_immutable_per_patch(self):
        res = patchsource.add_patch(self.store, "undo-3764",
                                    {"kind": "upload", "data": PR3764},
                                    self.root, reversal=True)
        self.assertTrue(res["ok"], res)
        res2 = patchsource.add_patch(self.store, "undo-3764",
                                     {"kind": "upload", "data": PR3764},
                                     self.root, reversal=False)
        self.assertFalse(res2["ok"])
        self.assertIn("REVERSAL", res2["reason"])

    def test_view_exposes_reversal_flag(self):
        patchsource.add_patch(self.store, "undo-3764",
                              {"kind": "upload", "data": PR3764},
                              self.root, reversal=True)
        view = patchsource.view(self.store, self.root, None)
        rows = {p["id"]: p for p in view["patches"]}
        self.assertTrue(rows["undo-3764"]["reversal"])


class CliPreviewTests(TempTree):
    def _add_enabled(self, reversal):
        res = patchsource.add_patch(self.store, "undo-3764",
                                    {"kind": "upload", "data": PR3764},
                                    self.root, reversal=reversal)
        self.assertTrue(res["ok"], res)
        patchsource.set_enabled(self.store, "undo-3764", True)

    def test_reversal_clean_verdict_is_reversed(self):
        self.merge_pr3764()
        # real lifecycle: add -> enable (state pending, desired_version set).
        # preview must report the clean-revert verdict 'reversed', not
        # 'applied' or 'warning'
        patchsource.add_patch(self.store, "undo-3764",
                              {"kind": "upload", "data": PR3764},
                              self.root, reversal=True)
        patchsource.set_enabled(self.store, "undo-3764", True)
        rows = {r["id"]: r for r in cli.patch_preview(self.store, self.root, None)}
        self.assertEqual(rows["undo-3764"]["verdict"], "reversed")
        self.assertIn("next server start", rows["undo-3764"]["detail"])

    def test_reversal_on_preimage_reports_reversed_already(self):
        self._add_enabled(reversal=True)
        rows = cli.patch_preview(self.store, self.root, None)
        # adopted APPLIED reversal: fast verify path -> reversed/verified
        self.assertTrue(rows)
        self.assertTrue(all(r["verdict"] == "reversed" for r in rows))

    def test_summary_line_counts_and_colour(self):
        self.merge_pr3764()
        self._add_enabled(reversal=True)   # adopted reversal -> applied/reversed
        # forward patch that fails (drift the tree AFTER adding)
        res = patchsource.add_patch(self.store, "fwd",
                                    {"kind": "upload", "data": PR3764},
                                    self.root)
        patchsource.set_enabled(self.store, "fwd", True)
        out = io.StringIO()   # non-TTY: no ANSI codes
        import unittest.mock as mock
        import re
        with mock.patch("omlx_uplift.patches._omlx_root",
                        return_value=os.path.join(self.root, "omlx")):
            cli.print_patch_preview(self.store, stream=out)
        text = out.getvalue()
        self.assertIn("REVERSED", text)
        m = re.search(r"SUMMARY: (\d+) forward, (\d+) reversed, (\d+) failed",
                      text)
        self.assertTrue(m, text)
        fwd, revn, fail = (int(g) for g in m.groups())
        self.assertEqual(revn, 1)           # the adopted reversal counts
        self.assertGreaterEqual(fwd + fail, 1)


if __name__ == "__main__":
    unittest.main()
