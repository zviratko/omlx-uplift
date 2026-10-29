"""PAT-TABLE tests: the merged patch table's server contract.

- set_targets: VANILLA/DEV checkboxes — scope AND enable in one act,
  widening re-gates the newly used tree, held safeguards answer
  requires_approval without writing anything.
- set_pin: per-surface version targets — reconcile (runtime) and
  enabled_build_patches (materialize input) resolve their own version.
- set_auto_update + check_all: per-patch AUTO UPDATE auto-promotes a
  validated candidate; a pinned surface keeps its pin anyway.
- patchsync: unchecking VANILLA restores the vanilla bytes on the next
  reconcile instead of freezing the tree patched.
- view(): surfaces/auto_update/pins fields the table renders from.
"""

import difflib
import hashlib
import os
import shutil
import tempfile
import unittest
import unittest.mock

from omlx_uplift import patchsource, patches, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")

REL = "omlx/admin/routes.py"


def _diff_adding_line(orig_text, marker):
    """A minimal unified diff prepending one comment line to the fixture
    file — two calls with different markers give two distinct versions."""
    lines = orig_text.splitlines(keepends=True)
    new = [f"# uplift-test {marker}\n"] + lines
    d = difflib.unified_diff(lines, new, fromfile="a/" + REL,
                             tofile="b/" + REL, lineterm="\n")
    return "".join(d).encode("utf-8")


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pattable-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.keg = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.keg, "omlx"))
        # source checkout: same installable paths (the dev gate must see
        # the same diff bytes; csrc/ only exists here)
        self.src = os.path.join(self.tmp, "src")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.src, "omlx"))
        with open(os.path.join(self.keg, REL), "r", encoding="utf-8") as fh:
            self.orig = fh.read()
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        # add_patch for an online-kind is overkill here: upload diffs
        self.diff_a = _diff_adding_line(self.orig, "A")
        self.diff_b = _diff_adding_line(self.orig, "B")
        self.diff_c = _diff_adding_line(self.orig, "C")

    def add(self, pid="p1", scope=None, diff=None):
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            res = patchsource.add_patch(
                self.store, pid,
                {"kind": "upload", "data": diff or self.diff_a},
                self.keg, scope=scope, build_root=self.src)
        self.assertTrue(res.get("ok"), res)
        return res

    def manifest_patch(self, pid="p1"):
        return self.store.find(self.store.load(), pid)

    def targets(self, runtime, dev, pid="p1", approve=None):
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            return patchsource.set_targets(self.store, pid, runtime, dev,
                                           approve=approve,
                                           tree_root=self.keg)

    def reconcile(self):
        return patchsync.reconcile(self.store, self.keg, allow_reexec=False)

    def live(self):
        with open(os.path.join(self.keg, REL), "r", encoding="utf-8") as fh:
            return fh.read()


class SetTargetsTest(_Base):
    def test_checkbox_pair_maps_onto_scope_and_enable(self):
        self.add(scope="omlx")
        r = self.targets(True, False)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["scope"], "omlx")
        self.assertTrue(self.manifest_patch()["enabled"])
        r = self.targets(True, True)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.manifest_patch()["scope"], "both")
        r = self.targets(False, True)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.manifest_patch()["scope"], "dev")
        # unchecked both: disable, LAST SCOPE kept for re-check parity
        r = self.targets(False, False)
        self.assertTrue(r["ok"], r)
        p = self.manifest_patch()
        self.assertFalse(p["enabled"])
        self.assertEqual(p["scope"], "dev")
        r = self.targets(False, True)   # re-check the same box
        self.assertTrue(r["ok"], r)
        self.assertTrue(self.manifest_patch()["enabled"])
        self.assertEqual(self.manifest_patch()["scope"], "dev")

    def test_widening_rejects_diff_that_does_not_fit_src(self):
        self.add(scope="omlx")
        os.remove(os.path.join(self.src, REL))   # the dev tree lost the file
        r = self.targets(True, True)
        self.assertFalse(r["ok"])
        self.assertIn("does not fit", r["reason"])
        p = self.manifest_patch()
        self.assertNotEqual(p.get("scope"), "both")  # nothing written
        self.assertTrue(p["enabled"])                # stayed as it was

    def test_missing_dev_root_refuses_build_surface(self):
        self.add(scope="omlx")
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=""):
            r = patchsource.set_targets(self.store, "p1", True, True,
                                        tree_root=self.keg)
        self.assertFalse(r["ok"])
        self.assertIn("bootstrap", r["reason"])
        self.assertNotEqual(self.manifest_patch().get("scope"), "both")

    def test_held_safeguards_answer_requires_approval(self):
        # kernel .py under omlx/custom_kernels/: on the SRC carrier that is
        # an advisory (the rebuild IS the pipeline), on the KEG carrier it
        # HOLDS. So: add dev-clean, then widen to VANILLA — the freshly
        # gated keg half raises kernel_source and the checkbox must get
        # requires_approval with NOTHING written, then pass on approve.
        kerel = "omlx/custom_kernels/fastattn/probe.py"
        for root in (self.src, self.keg):
            f = os.path.join(root, kerel)
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, "w") as fh:
                fh.write("x = 1\n")
        d = difflib.unified_diff(["x = 1\n"], ["x = 1\n", "y = 2\n"],
                                 fromfile="a/" + kerel, tofile="b/" + kerel,
                                 lineterm="\n")
        kdiff = "".join(d).encode("utf-8")
        self.add(scope="dev", diff=kdiff)     # src carrier: advisory only
        p = self.manifest_patch()
        self.assertTrue(p["enabled"])         # dev gate clean -> auto-landed
        r = self.targets(True, True)          # VANILLA on -> keg kernel hold
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("requires_approval"), r)
        p = self.manifest_patch()
        self.assertEqual(p.get("scope"), "dev")   # nothing written
        r = self.targets(True, True, approve="always")
        self.assertTrue(r["ok"], r)
        p = self.manifest_patch()
        self.assertEqual(p["scope"], "both")
        self.assertTrue(p.get("safeguard_always"))

    def test_scope_change_flips_pending(self):
        self.add(scope="omlx")
        self.reconcile()                          # applied on the keg
        self.assertEqual(self.manifest_patch()["state"], "applied")
        r = self.targets(True, True)              # widen to the branch
        self.assertTrue(r["ok"], r)
        p = self.manifest_patch()
        self.assertEqual(p["scope"], "both")
        self.assertEqual(p["state"], "pending")


class PinFlowTest(_Base):
    def _two_versions(self):
        self.add(scope="omlx", diff=self.diff_a)   # v1, enabled pending
        self.reconcile()
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            res = patchsource.add_patch(
                self.store, "p1",
                {"kind": "upload", "data": self.diff_b}, self.keg)
        self.assertTrue(res.get("ok"), res)         # v2 candidate

    def test_pin_swaps_the_applied_runtime_copy(self):
        self._two_versions()
        patchsource.promote(self.store, "p1")       # desired -> v2
        self.reconcile()
        self.assertIn("uplift-test B", self.live())
        r = patchsource.set_pin(self.store, "p1", "runtime", 1)
        self.assertTrue(r["ok"], r)
        self.reconcile()
        live = self.live()
        self.assertIn("uplift-test A", live)        # back on the pinned copy
        self.assertNotIn("uplift-test B", live)
        r = patchsource.set_pin(self.store, "p1", "runtime", None)
        self.assertTrue(r["ok"], r)
        self.reconcile()
        self.assertIn("uplift-test B", self.live())  # follow desired again

    def test_unknown_pin_version_rejected(self):
        self.add(scope="omlx")
        r = patchsource.set_pin(self.store, "p1", "runtime", 9)
        self.assertFalse(r["ok"])
        self.assertIn("v9", r["reason"])

    def test_materialize_input_follows_build_pin(self):
        self._two_versions()
        patchsource.promote(self.store, "p1")       # desired 2
        self.targets(True, True)                    # scope both
        patchsource.set_pin(self.store, "p1", "build", 1)
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            items = patchsource.enabled_build_patches(self.store,
                                                      with_bytes=False)
        self.assertEqual([i["version"] for i in items], [1])


class AutoUpdateTest(_Base):
    def test_turning_on_adopts_a_waiting_candidate(self):
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            patchsource.add_patch(self.store, "p1",
                                  {"kind": "upload", "data": self.diff_b},
                                  self.keg)
        self.assertEqual(self.manifest_patch()["state"], "update_available")
        r = patchsource.set_auto_update(self.store, "p1", True)
        self.assertTrue(r["ok"], r)
        self.assertTrue(r.get("promoted"))
        p = self.manifest_patch()
        self.assertTrue(p["auto_update"])
        self.assertEqual(p["desired_version"], 2)
        self.assertEqual(p["state"], "pending")

    def test_check_all_promotes_flagged_patch_only(self):
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        m = self.store.load()
        p = self.store.find(m, "p1")
        # a fresh url source + auto flag; fake a drifted gate result
        p["source"] = {"kind": "url", "url": "http://127.0.0.1:9/x.diff"}
        p["auto_update"] = True
        self.store.save(m)
        new_diff = self.diff_b
        gate = {
            "ok": True, "diff": new_diff,
            "content_sha256": hashlib.sha256(new_diff).hexdigest(),
            "source_head_sha": "0123456789abcdef0123456789abcdef01234567",
            "fetched_at": "", "files": [{"path": REL, "status": "applied"}],
            "safeguards": {}, "advisories": [],
        }
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate)):
            rep = patchsource.check_all(self.store, self.keg)
        r = rep["reports"]["p1"]
        self.assertEqual(r["check"], "update_available")
        self.assertTrue(r["promoted"])
        p = self.manifest_patch()
        self.assertEqual(p["desired_version"], r["v"])
        # control: flag OFF -> a NEW drifted candidate waits for a click
        patchsource.set_auto_update(self.store, "p1", False)
        gate_c = dict(gate)
        gate_c["diff"] = self.diff_c
        gate_c["content_sha256"] = hashlib.sha256(self.diff_c).hexdigest()
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate_c)):
            rep2 = patchsource.check_all(self.store, self.keg)
        r2 = rep2["reports"]["p1"]
        self.assertEqual(r2["check"], "update_available")
        self.assertFalse(r2.get("promoted"))
        self.assertEqual(self.manifest_patch()["desired_version"], r["v"])

    def _url_gate(self, diff):
        """check_all only re-fetches online sources, and it gates through
        fetch_and_gate — the same seam the other tests in this class use."""
        m = self.store.load()
        q = self.store.find(m, "p1")
        q["source"] = {"kind": "url", "url": "http://127.0.0.1:9/x.diff"}
        self.store.save(m)
        return {"ok": True, "diff": diff,
                "content_sha256": hashlib.sha256(diff).hexdigest(),
                "source_head_sha": "0" * 40, "fetched_at": "",
                "files": [{"path": REL, "status": "applied"}],
                "safeguards": {}, "advisories": []}

    def test_candidate_stored_while_disabled_is_adopted_on_enable(self):
        """mruu report 2026-10-29: specprefill-alias-fix sat on v1 with AUTO
        UPDATE switched on while v2 sat stored and gated. Promotion rode the
        DRIFT EDGE only — once the source stopped changing, nothing adopted the
        candidate and the check answered 'up_to_date' indefinitely. A stored
        candidate is either adopted (auto update) or named (every other case),
        never silently ignored."""
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        gate = self._url_gate(self.diff_b)
        m = self.store.load()
        q = self.store.find(m, "p1")
        q["auto_update"] = True
        q["enabled"] = False      # the drift lands while the patch is OFF
        self.store.save(m)
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate)):
            rep = patchsource.check_all(self.store, self.keg)
        self.assertFalse(rep["reports"]["p1"].get("promoted"),
                         "a disabled patch never auto-applies")
        self.assertEqual(self.manifest_patch()["desired_version"], 1)
        # the operator enables it later; the source has NOT drifted since
        m = self.store.load()
        q = self.store.find(m, "p1")
        q["enabled"] = True
        q["state"] = "applied"    # a Build has since landed v1
        self.store.save(m)
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate)):
            rep2 = patchsource.check_all(self.store, self.keg)
        r2 = rep2["reports"]["p1"]
        self.assertEqual(r2["check"], "update_available", r2)
        self.assertTrue(r2.get("adopted_stale"), r2)
        self.assertTrue(r2.get("promoted"), r2)
        q2 = self.manifest_patch()
        self.assertEqual(q2["desired_version"], 2, q2)
        self.assertEqual(q2["state"], "pending", q2)

    def test_waiting_candidate_is_named_when_auto_update_is_off(self):
        """The same shape with AUTO UPDATE off must not adopt (the operator's
        choice) and must not stay silent either."""
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        gate = self._url_gate(self.diff_b)
        m = self.store.load()
        q = self.store.find(m, "p1")
        q["auto_update"] = False
        q["enabled"] = False
        self.store.save(m)
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate)):
            patchsource.check_all(self.store, self.keg)
        m = self.store.load()
        q = self.store.find(m, "p1")
        q["enabled"] = True
        q["state"] = "applied"
        self.store.save(m)
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate)):
            rep = patchsource.check_all(self.store, self.keg)
        r = rep["reports"]["p1"]
        self.assertEqual(r["check"], "update_available", r)
        self.assertFalse(r.get("promoted"), r)
        self.assertIn("Promote", r.get("reason", ""), r)
        q = self.manifest_patch()
        self.assertEqual(q["desired_version"], 1, q)
        # the visible half: the row must stop claiming a plain 'applied'
        self.assertEqual(q["state"], "update_available", q)
        self.assertIn("not in use", q.get("state_detail", ""), q)

    def test_auto_never_walks_over_a_pin(self):
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        patchsource.set_auto_update(self.store, "p1", True)
        patchsource.set_pin(self.store, "p1", "build", 1)
        m = self.store.load()   # check_all only re-fetches online sources
        pp = self.store.find(m, "p1")
        pp["source"] = {"kind": "url", "url": "http://127.0.0.1:9/x.diff"}
        self.store.save(m)
        new_diff = self.diff_b
        gate = {
            "ok": True, "diff": new_diff,
            "content_sha256": hashlib.sha256(new_diff).hexdigest(),
            "source_head_sha": "abc", "fetched_at": "",
            "files": [{"path": REL, "status": "applied"}],
            "safeguards": {}, "advisories": [],
        }
        with unittest.mock.patch.object(patchsource, "fetch_and_gate",
                                        return_value=dict(gate)):
            patchsource.check_all(self.store, self.keg)
        p = self.manifest_patch()
        self.assertEqual(p["desired_version"], 2)     # shared target moved
        self.assertEqual(patches.patch_pins(p)["build"], 1)  # pin held


class ReconcileSurfaceTest(_Base):
    def test_unchecking_vanilla_restores_keg_bytes(self):
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        self.assertIn("uplift-test A", self.live())
        r = self.targets(False, True)                  # VANILLA off
        self.assertTrue(r["ok"], r)
        rep = self.reconcile()
        self.assertEqual(self.live(), self.orig)       # vanilla bytes back
        self.assertIn("restored", [x.get("action")
                                   for x in rep["reports"]])
        p = self.manifest_patch()
        self.assertTrue(p["enabled"])                  # still on the branch
        self.assertEqual(p["state"], "pending")
        self.assertEqual(p.get("scope"), "dev")

    def test_dev_scope_never_mounts_the_keg(self):
        self.add(scope="dev", diff=self.diff_a)
        self.reconcile()
        self.assertEqual(self.live(), self.orig)


class RemoveSweepTest(_Base):
    def test_remove_after_disable_restart_sweeps_backups(self):
        # live QA (2026-10-20): disable -> restart restores AND clears the
        # keg records; the later Remove found no unwind chain and left the
        # backups/<id>.vN/ leaf behind forever. The leaf must go with the
        # entry when no tree holds a record for that version.
        self.add(scope="omlx")
        self.reconcile()
        self.assertIn("uplift-test A", self.live())
        r = self.targets(False, False)                   # both boxes off
        self.assertTrue(r["ok"], r)
        self.reconcile()                                 # boot restores
        self.assertEqual(self.live(), self.orig)
        p = self.manifest_patch()
        self.assertFalse(p.get("enabled"))
        bdir = os.path.join(self.store.base_dir, "backups", "p1.v1")
        # The live defect shape: some earlier cycle cleared the records but
        # left the pristine leaf behind. Reproduce it directly — Remove must
        # sweep a record-free version's backups even with nothing to unwind.
        os.makedirs(bdir, exist_ok=True)
        with open(os.path.join(bdir, "orphan.txt"), "w") as fh:
            fh.write("pristine bytes holder")
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            res = patchsource.remove_patch(self.store, "p1", self.keg)
        self.assertTrue(res.get("ok"), res)
        self.assertFalse(os.path.isdir(bdir),
                         "remove must sweep backups of a record-free version")
        # a never-mounted removal still must not crash
        self.add(scope="dev")
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            res = patchsource.remove_patch(self.store, "p1", self.keg)
        self.assertTrue(res.get("ok"), res)


class ContentTwinTest(_Base):
    """One patch per CONTENT (user report 2026-10-29): the vendored catalog
    copy of a branch and the same branch's PR landed side by side - source
    identity compares URLs, and GitHub's .diff differs from a local
    `git diff` only in index-hash width and the function-label after the
    @@ range. Both gaps close here."""

    def _github_shaped(self, data: bytes) -> bytes:
        import re

        b = re.sub(rb"(?m)^index ([0-9a-f]{8})\.\.([0-9a-f]{8})",
                   rb"index \1\1..\2\2", data)
        b = re.sub(rb"(?m)^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)$",
                   rb"\1 def _marker():", b)
        self.assertNotEqual(b, data)
        return b

    def test_norm_sha_blurs_only_the_routing_noise(self):
        self.assertEqual(patchsource._content_norm_sha(
                             self._github_shaped(self.diff_a)),
                         patchsource._content_norm_sha(self.diff_a))
        # and must NOT blur a real content difference
        self.assertNotEqual(patchsource._content_norm_sha(
                                self._github_shaped(self.diff_b)),
                            patchsource._content_norm_sha(self.diff_a))

    def test_add_refuses_the_twin_under_a_second_id(self):
        self.add(pid="p1")
        twin = self._github_shaped(self.diff_a)
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            res = patchsource.add_patch(
                self.store, "p2", {"kind": "upload", "data": twin},
                self.keg, build_root=self.src)
        self.assertFalse(res.get("ok"), res)
        self.assertEqual(res.get("stage"), "duplicate")
        self.assertIn("p1", res.get("reason"))
        # a refused add leaves no trace (the same rule as a failed gate)
        self.assertIsNone(self.manifest_patch("p2"))

    def test_cross_scope_twin_compares_in_the_keg_view(self):
        # the live pair from 2026-10-29: a catalog vendor stores the FULL
        # diff (dev scope, apps/tests sections included); the user adds
        # the same change as a PR and the runtime gate prunes those
        # sections — raw bytes never match, but the INSTALLABLE content is
        # one patch. The twin check must see that.
        newfile = (
            b"diff --git a/apps/omlx-web/extra.js b/apps/omlx-web/extra.js\n"
            b"new file mode 100644\n"
            b"--- /dev/null\n"
            b"+++ b/apps/omlx-web/extra.js\n"
            b"@@ -0,0 +1,1 @@\n"
            b"+// extra\n")
        self.add(pid="vendor", scope="dev", diff=self.diff_a + newfile)
        stored = open(os.path.join(self.store.base_dir,
                                   "patches/vendor.v1.diff"), "rb").read()
        self.assertIn(b"apps/omlx-web/extra.js", stored,
                      "the dev-scope add must keep the full diff")
        with unittest.mock.patch.object(patchsource, "dev_build_root",
                                        return_value=self.src):
            res = patchsource.add_patch(
                self.store, "pr-twin",
                {"kind": "upload", "data": self._github_shaped(
                    self.diff_a + newfile)},
                self.keg, build_root=self.src)
        # auto-classification lands the candidate as a runtime patch (the
        # keg gate prunes the apps section) — the guard must still refuse
        self.assertFalse(res.get("ok"), res)
        self.assertEqual(res.get("stage"), "duplicate")
        self.assertIn("vendor", res.get("reason"))
        self.assertIsNone(self.manifest_patch("pr-twin"))

    def test_remove_of_a_curated_patch_disables_it_instead(self):
        # a removed catalog entry is re-added by the next check (policy
        # 2026-10-09) — the honest outcome of the verb is disable, and the
        # response must say so (user report: "it went back in as pending")
        self.add(pid="p1", scope="omlx")
        m = self.store.load()
        q = self.store.find(m, "p1")
        q["curated"] = "default"
        q["enabled"] = True
        self.store.save(m)
        res = patchsource.request_removal(self.store, "p1", self.keg)
        self.assertTrue(res.get("ok"), res)
        self.assertTrue(res.get("disabled_instead"))
        self.assertIn("curated catalog", res.get("reason"))
        q = self.manifest_patch("p1")
        self.assertIsNotNone(q, "the row must stay listed (disabled)")
        self.assertFalse(q.get("enabled"))
        # adopted = owned = really removable
        m = self.store.load()
        self.store.find(m, "p1")["curated_adopted"] = True
        self.store.save(m)
        res2 = patchsource.request_removal(self.store, "p1", self.keg)
        self.assertTrue(res2.get("ok"), res2)
        self.assertIsNone(self.manifest_patch("p1"))
        # the kernel stays raw for internal flows (rescope re-adds): a
        # curated entry CAN still be hard-removed through remove_patch
        self.add(pid="p3", scope="omlx")
        m = self.store.load()
        q3 = self.store.find(m, "p3")
        q3["curated"] = "default"
        self.store.save(m)
        res3 = patchsource.remove_patch(self.store, "p3", self.keg)
        self.assertTrue(res3.get("ok"), res3)
        self.assertIsNone(self.manifest_patch("p3"))


class ViewSurfacesTest(_Base):
    def test_view_reports_table_fields(self):
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        patchsource.set_pin(self.store, "p1", "build", 1)
        patchsource.set_auto_update(self.store, "p1", True)
        v = patchsource.view(self.store, self.keg, "test-keg")
        e = [x for x in v["patches"] if x["id"] == "p1"][0]
        self.assertTrue(e["surfaces"]["runtime"]["checked"])
        self.assertFalse(e["surfaces"]["runtime"]["pinned"])
        self.assertEqual(e["surfaces"]["runtime"]["version"], 1)
        self.assertFalse(e["surfaces"]["build"]["checked"])  # scope omlx
        self.assertTrue(e["surfaces"]["build"]["pinned"])
        self.assertEqual(e["pins"], {"runtime": None, "build": 1})
        self.assertTrue(e["auto_update"])
        self.assertEqual(e["latest_v"], 1)
        self.assertIsNone(e["dev_applied_v"])   # never materialized


class DryRunVersionTest(_Base):
    def test_dry_run_can_target_a_pinned_version(self):
        self.add(scope="omlx", diff=self.diff_a)
        self.reconcile()
        r = patchsource.test_dry_run(self.store, "p1", self.keg, v=1)
        self.assertTrue(r["ok"], r)
        r = patchsource.test_dry_run(self.store, "p1", self.keg, v=9)
        self.assertFalse(r["ok"])
        self.assertIn("v9", r["reason"])


class PinStateHonestyTest(_Base):
    """User 2026-10-20: pinning to the version that is ALREADY on disk
    turned the row amber (and releasing it kept it amber). A state change
    needs an actual outstanding change behind it."""

    def test_pin_to_applied_version_stays_applied(self):
        self.add(scope="omlx")
        self.reconcile()
        self.assertEqual(self.manifest_patch()["state"], "applied")
        r = patchsource.set_pin(self.store, "p1", "runtime", 1)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.manifest_patch()["state"], "applied",
                         "a no-op pin must not claim outstanding work")

    def test_release_of_a_noop_pin_returns_to_applied(self):
        self.add(scope="omlx")
        self.reconcile()
        patchsource.set_pin(self.store, "p1", "runtime", 1)
        r = patchsource.set_pin(self.store, "p1", "runtime", None)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.manifest_patch()["state"], "applied")

    def test_other_selected_surface_outstanding_keeps_pending(self):
        self.add(scope="omlx")
        self.reconcile()
        # widen WITHOUT the set_targets ceremony: DEV is selected but the
        # branch carries nothing -> the pin write must say 'work pending',
        # even though the runtime target itself is already on disk
        m = self.store.load()
        self.store.find(m, "p1")["scope"] = "both"
        self.store.save(m)
        r = patchsource.set_pin(self.store, "p1", "runtime", 1)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.manifest_patch()["state"], "pending")
        r = patchsource.set_pin(self.store, "p1", "runtime", None)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.manifest_patch()["state"], "pending",
                         "release cannot outrun the branch")

    def test_disabled_patch_pin_writes_no_state_stamp(self):
        self.add(scope="omlx")
        r = self.targets(False, False)
        self.assertTrue(r["ok"], r)
        before = self.manifest_patch()["state_changed_at"]
        out = patchsource.set_pin(self.store, "p1", "runtime", 1)
        self.assertTrue(out["ok"], out)
        p = self.manifest_patch()
        self.assertEqual(p["state"], "disabled")
        self.assertEqual(p["state_changed_at"], before)


class RouterContractTest(unittest.TestCase):
    """The three new endpoint wrappers: a held safeguard must surface as
    HTTP 409 (the checkbox revert branches on err.status === 409), plain
    failures 422, successes the patchsource dict verbatim."""

    def _run(self, coro):
        import asyncio
        return asyncio.run(coro)

    def test_targets_status_codes(self):
        from fastapi import HTTPException

        from omlx_uplift.routers import patches as pmod

        store = object()
        req = pmod.PatchTargetsRequest(id="p1", runtime=True, dev=True)
        # CI runs without the omlx package: _patch_tree_root() 503s before
        # the mocked set_targets is reached. The endpoint's honest answer
        # with no tree IS 503 — stub the tree so this test drives the
        # 409/422/200 mapping it claims to pin.
        tree = unittest.mock.patch.object(pmod, "_patch_tree_root",
                                          return_value="/tmp/fake-tree")
        with tree, \
             unittest.mock.patch.object(pmod, "patch_store",
                                        return_value=store), \
             unittest.mock.patch.object(patchsource, "set_targets",
                                        return_value={"ok": False,
                                                      "requires_approval":
                                                          ["kernel_source"],
                                                      "reason": "hold"}):
            with self.assertRaises(HTTPException) as cm:
                self._run(pmod.patches_targets(req, is_admin=True))
            self.assertEqual(cm.exception.status_code, 409)
        with tree, \
             unittest.mock.patch.object(pmod, "patch_store",
                                        return_value=store), \
             unittest.mock.patch.object(patchsource, "set_targets",
                                        return_value={"ok": True,
                                                      "scope": "both"}):
            out = self._run(pmod.patches_targets(req, is_admin=True))
            self.assertEqual(out["scope"], "both")
        with tree, \
             unittest.mock.patch.object(pmod, "patch_store",
                                        return_value=store), \
             unittest.mock.patch.object(patchsource, "set_targets",
                                        return_value={"ok": False,
                                                      "reason": "does not fit"}):
            with self.assertRaises(HTTPException) as cm:
                self._run(pmod.patches_targets(req, is_admin=True))
            self.assertEqual(cm.exception.status_code, 422)

    def test_pin_and_auto_status_codes(self):
        from fastapi import HTTPException

        from omlx_uplift.routers import patches as pmod

        store = object()
        with unittest.mock.patch.object(pmod, "patch_store",
                                        return_value=store), \
             unittest.mock.patch.object(
                 patchsource, "set_pin",
                 return_value={"ok": False, "reason": "no stored version"}):
            with self.assertRaises(HTTPException) as cm:
                self._run(pmod.patches_pin(
                    pmod.PatchPinRequest(id="p1", target="build",
                                         version=9), is_admin=True))
            self.assertEqual(cm.exception.status_code, 422)
        with unittest.mock.patch.object(pmod, "patch_store",
                                        return_value=store), \
             unittest.mock.patch.object(
                 patchsource, "set_auto_update",
                 return_value={"ok": True, "auto_update": True,
                               "promoted": True}):
            out = self._run(pmod.patches_auto(
                pmod.PatchAutoRequest(id="p1", enabled=True),
                is_admin=True))
            self.assertTrue(out["promoted"])


if __name__ == "__main__":
    unittest.main()
