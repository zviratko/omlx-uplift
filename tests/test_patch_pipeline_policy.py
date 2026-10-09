"""2026-10-09 patch-pipeline policy batch (user asks):

  1. 'there is no way to approve a patch from cli'  -> patchsource.approve
  2. 'approval only for stuff outside the keg — not true for pr4206'
     -> outside_keg is a KEG premise: on a source checkout it becomes an
        advisory (the pr4206 dev-scope false hold)
  3. 'enable added patches by default if they apply cleanly'
     -> add_patch lands pending+enabled when nothing is held
  4. 'new curated version should upgrade' -> check_all auto-promotes a
     validated candidate for catalog-owned (not adopted) patches
"""
import os
import shutil
import tempfile
import unittest

from omlx_uplift import patchsource, patches, safeguards

FIX = os.path.join(os.path.dirname(__file__), "fixtures")

DIFF_HEAD = ("diff --git a/{p} b/{p}\n"
             "index 1111111..2222222 100644\n"
             "--- a/{p}\n"
             "+++ b/{p}\n")
CREATE_HEAD = ("diff --git a/{p} b/{p}\n"
               "new file mode 100644\n"
               "index 0000000..2222222\n"
               "--- /dev/null\n"
               "+++ b/{p}\n")


def _modify(path, old, new):
    body = f"@@ -1,2 +1,2 @@\n context\n-{old}\n+{new}\n"
    return (DIFF_HEAD.format(p=path) + body).encode()


def _create(path, lines):
    n = len(lines)
    body = f"@@ -0,0 +1,{n} @@\n" + "".join(f"+{l}\n" for l in lines)
    return (CREATE_HEAD.format(p=path) + body).encode()


class ApproveActionTest(unittest.TestCase):
    """(1) a standalone approval that does NOT enable the patch."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-approve-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _entry(self, pid="kern", codes=("kernel_source",), sha="sha1",
               v=1, state="disabled", enabled=False, desired=1):
        manifest = self.store.load()
        manifest["patches"].append({
            "id": pid, "enabled": enabled, "order": 100, "source": {},
            "desired_version": desired,
            "versions": [{"v": v, "content_sha256": sha,
                          "safeguards": {"codes": list(codes)}}],
            "state": state, "state_detail": ""})
        self.store.save(manifest)

    def test_approve_once_records_and_does_not_enable(self):
        self._entry()
        r = patchsource.approve(self.store, "kern", mode="once")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["approved"], ["kernel_source"])
        m = self.store.load()
        p = self.store.find(m, "kern")
        self.assertFalse(p["enabled"])                     # approve != enable
        self.assertEqual(p["safeguard_once"],
                         {"sha": "sha1", "codes": ["kernel_source"]})

    def test_approve_always_survives_a_new_version(self):
        self._entry()
        r = patchsource.approve(self.store, "kern", mode="always")
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.store.load()["patches"][0]["safeguard_always"],
                         ["kernel_source"])

    def test_approve_targets_the_newest_candidate_when_no_desired(self):
        self._entry(v=3, desired=0, state="update_available")
        r = patchsource.approve(self.store, "kern", mode="once")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["version"], 3)
        self.assertEqual(self.store.load()["patches"][0]["safeguard_once"]
                         ["sha"], "sha1")

    def test_approve_then_enable_needs_no_second_approval(self):
        self._entry()
        patchsource.approve(self.store, "kern", mode="always")
        e = patchsource.set_enabled(self.store, "kern", True)
        self.assertTrue(e["ok"], e)
        self.assertTrue(self.store.load()["patches"][0]["enabled"])

    def test_refusals(self):
        self.assertFalse(patchsource.approve(self.store, "ghost",
                                             mode="once")["ok"])
        self._entry(codes=())
        self.assertFalse(patchsource.approve(self.store, "kern",
                                             mode="yolo")["ok"])

    def test_note_when_nothing_was_held(self):
        self._entry(codes=())
        r = patchsource.approve(self.store, "kern", mode="once")
        self.assertTrue(r["ok"])
        self.assertEqual(r["approved"], [])
        self.assertIn("note", r)


class SrcTreeOutsideKegTest(unittest.TestCase):
    """(2) pr4206: a dev-scope diff that creates a file under a directory
    the base checkout lacks must NOT raise an approval hold."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-src-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.src = os.path.join(self.tmp, "checkout")
        os.makedirs(os.path.join(self.src, "omlx", "engine"))
        with open(os.path.join(self.src, "omlx", "engine", "pool.py"),
                  "w") as fh:
            fh.write("context\nalpha = 1\n")

    def test_create_into_missing_dir_is_advisory_on_src(self):
        d = (_modify("omlx/engine/pool.py", "alpha = 1", "alpha = 2")
             + _create("benchmarks/kernel_parity.py", ["#!/usr/bin/env python3"]))
        g = patchsource.validate(d, self.src, skip_patterns=None,
                                 tree_kind="src")
        self.assertTrue(g["ok"], g.get("reason"))
        self.assertEqual(g["safeguards"]["codes"], [])       # NOT held
        self.assertEqual(g["safeguards"]["problems"], [])
        adv = [a for a in g["safeguards"]["advisories"]
               if a["code"] == "outside_keg"]
        self.assertEqual(len(adv), 1)                        # grouped, one row
        self.assertEqual(adv[0]["paths"], ["benchmarks/kernel_parity.py"])

    def test_same_diff_still_holds_on_a_keg(self):
        d = _create("benchmarks/kernel_parity.py", ["x = 1"])
        g = patchsource.validate(d, self.src, skip_patterns=None,
                                 tree_kind="keg")
        self.assertIn("outside_keg", g["safeguards"]["codes"])


class CleanAddEnablesByDefaultTest(unittest.TestCase):
    """(3) a new patch that gates clean lands enabled; a held one does not."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-add-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.keg = os.path.join(self.tmp, "site-packages")
        os.makedirs(os.path.join(self.keg, "omlx", "engine"))
        with open(os.path.join(self.keg, "omlx", "engine", "pool.py"),
                  "w") as fh:
            fh.write("context\nalpha = 1\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _patch(self, d, pid):
        r = patchsource.add_patch(self.store, pid,
                                  {"kind": "upload", "data": d}, self.keg)
        self.assertTrue(r["ok"], r)
        return self.store.find(self.store.load(), pid)

    def test_clean_add_is_enabled_and_pending(self):
        p = self._patch(_modify("omlx/engine/pool.py", "alpha = 1",
                                "alpha = 7"), "clean")
        self.assertTrue(p["enabled"])
        self.assertEqual(p["state"], "pending")
        self.assertEqual(p["desired_version"], 1)

    def test_held_add_stays_disabled(self):
        os.makedirs(os.path.join(self.keg, "ghost_pkg"))
        p = self._patch(_create("totely_elsewhere/x.py", ["a = 1"]), "held")
        self.assertFalse(p["enabled"])
        self.assertEqual(p["state"], "disabled")

    def test_update_of_existing_patch_never_flips_the_user_choice(self):
        pid = "cycle"
        self._patch(_modify("omlx/engine/pool.py", "alpha = 1", "alpha = 7"),
                    pid)
        patchsource.set_enabled(self.store, pid, False)   # user opts out
        r = patchsource.add_patch(
            self.store, pid,
            {"kind": "upload",
             "data": _modify("omlx/engine/pool.py", "alpha = 1", "alpha = 9")},
            self.keg)
        self.assertTrue(r["ok"], r)
        p = self.store.find(self.store.load(), pid)
        self.assertFalse(p["enabled"])                    # user choice kept
        self.assertEqual(p["state"], "disabled")


class CuratedAutoPromoteTest(unittest.TestCase):
    """(4) a catalog-owned patch follows its published version; an adopted
    or user patch keeps the manual Promote decision."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-promote-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.keg = os.path.join(self.tmp, "site-packages")
        os.makedirs(os.path.join(self.keg, "omlx", "engine"))
        self.src = os.path.join(self.tmp, "checkout")
        os.makedirs(os.path.join(self.src, "omlx", "engine"))
        self.v1 = _modify("omlx/engine/pool.py", "alpha = 1", "alpha = 7")
        self.v2 = _modify("omlx/engine/pool.py", "alpha = 1", "alpha = 8")
        for root in (self.keg, self.src):
            with open(os.path.join(root, "omlx", "engine", "pool.py"),
                      "w") as fh:
                fh.write("context\nalpha = 1\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _installed(self, *, curated="default", adopted=False, scope=None):
        manifest = self.store.load()
        ver = {"v": 1, "content_sha256": "old-sha", "source_head_sha": "h1",
               "patch_file": "patches/x.v1.diff", "safeguards": {"codes": []},
               "applied": {"keg_id": "tree:old", "at": "2026-10-01T00:00:00+00:00",
                           "files": []}}
        entry = {"id": "bundled", "enabled": True, "order": 100,
                 "source": {"kind": "github_pr", "repo": "jundot/omlx",
                            "pr": 4242},
                 "desired_version": 1, "versions": [ver],
                 "state": "applied", "state_detail": ""}
        if curated:
            entry["curated"] = curated
        if adopted:
            entry["curated_adopted"] = True
        if scope:
            entry["scope"] = scope
        manifest["patches"].append(entry)
        self.store.save(manifest)

    def _check(self):
        import omlx_uplift.patchsource as ps
        orig_pr, orig_url = ps.fetch_pr, ps.fetch_url

        def fake_url(url, *a, **k):
            return {"ok": True, "data": self.v2, "source_head_sha": "h2"}

        def fake_pr(repo, pr, *a, **k):
            return {"ok": True, "data": self.v2, "source_head_sha": "h2"}

        ps.fetch_pr = fake_pr
        ps.fetch_url = fake_url
        try:
            return ps.check_all(self.store, self.keg, dev_root=self.src)
        finally:
            ps.fetch_pr, ps.fetch_url = orig_pr, orig_url

    def test_bundled_candidate_auto_promotes(self):
        self._installed()
        rep = self._check()["reports"]["bundled"]
        self.assertEqual(rep["check"], "update_available")
        self.assertTrue(rep["promoted"])
        p = self.store.find(self.store.load(), "bundled")
        self.assertEqual(p["desired_version"], 2)
        self.assertEqual(p["state"], "pending")
        self.assertIn("auto-promoted", p["state_detail"])

    def test_adopted_patch_waits_for_the_user(self):
        self._installed(adopted=True)
        rep = self._check()["reports"]["bundled"]
        self.assertFalse(rep["promoted"])
        p = self.store.find(self.store.load(), "bundled")
        self.assertEqual(p["desired_version"], 1)
        self.assertEqual(p["state"], "update_available")

    def test_user_added_patch_waits_for_the_user(self):
        self._installed(curated=None)
        rep = self._check()["reports"]["bundled"]
        self.assertFalse(rep["promoted"])
        self.assertEqual(self.store.find(self.store.load(), "bundled")
                         ["desired_version"], 1)

    def test_disabled_bundled_patch_is_not_re_enabled(self):
        self._installed()
        patchsource.set_enabled(self.store, "bundled", False)
        rep = self._check()["reports"]["bundled"]
        self.assertFalse(rep.get("promoted"))
        p = self.store.find(self.store.load(), "bundled")
        self.assertFalse(p["enabled"])
        self.assertEqual(p["desired_version"], 1)


if __name__ == "__main__":
    unittest.main()
