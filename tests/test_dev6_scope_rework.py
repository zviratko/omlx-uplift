"""DEV-6 tests: scope rename (omlx/dev/both), one shared store, target
gating, dev-side applied-state.

Byte-identical legacy behaviour is proven by the DEV-1 suite (legacy
--scope build now normalizes to 'dev' — asserted there).
"""

import json
import os
import shutil
import tempfile
import unittest
import unittest.mock

from omlx_uplift import patchsource, patches, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")

# csrc/ section (source tree only) + keg-installable python section
MIXED_DIFF = (
    b"diff --git a/tests/test_x.py b/tests/test_x.py\n"
    b"index 1111111..2222222 100644\n"
    b"--- a/tests/test_x.py\n"
    b"+++ b/tests/test_x.py\n"
    b"@@ -1,1 +1,2 @@\n"
    b" test line one\n"
    b"+test line two\n"
    b"diff --git a/omlx/kernels.py b/omlx/kernels.py\n"
    b"index 3333333..4444444 100644\n"
    b"--- a/omlx/kernels.py\n"
    b"+++ b/omlx/kernels.py\n"
    b"@@ -1,2 +1,3 @@\n"
    b" import Metal\n"
    b" KERNELS = {}\n"
    b"+EXTRA = 1\n"
)


class ScopeModelTests(unittest.TestCase):
    def test_legacy_normalize(self):
        self.assertEqual(patches.patch_scope({"scope": "runtime"}), "omlx")
        self.assertEqual(patches.patch_scope({"scope": "build"}), "dev")
        self.assertEqual(patches.patch_scope({}), "omlx")
        self.assertEqual(patches.patch_scope({"scope": "both"}), "both")

    def test_target_matrix(self):
        self.assertTrue(patches.scope_touches_keg("omlx"))
        self.assertTrue(patches.scope_touches_keg("both"))
        self.assertFalse(patches.scope_touches_keg("dev"))
        self.assertTrue(patches.scope_touches_dev("dev"))
        self.assertTrue(patches.scope_touches_dev("both"))
        self.assertFalse(patches.scope_touches_dev("omlx"))

    def test_detect_target_from_keg_path(self):
        self.assertEqual(
            patches.detect_patch_target(
                "/opt/hb/Cellar/omlx-dev/H/libexec/lib/python3.11/"
                "site-packages/omlx"), "dev")
        self.assertEqual(
            patches.detect_patch_target(
                "/opt/hb/Cellar/omlx/H/libexec/lib/python3.11/"
                "site-packages/omlx"), "omlx")


class BothScopeAddTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.keg = os.path.join(self.tmp, "keg")
        self.src = os.path.join(self.tmp, "src")
        os.makedirs(os.path.join(self.keg, "omlx"))
        os.makedirs(os.path.join(self.src, "omlx"))
        os.makedirs(os.path.join(self.src, "tests"))
        with open(os.path.join(self.keg, "omlx", "kernels.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        with open(os.path.join(self.src, "omlx", "kernels.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        with open(os.path.join(self.src, "tests", "test_x.py"), "w") as fh:
            fh.write("test line one\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "uplift"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_both_stores_full_diff_and_gates_keg_too(self):
        res = patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        self.assertTrue(res["ok"], res)
        m = self.store.load()
        p = self.store.find(m, "mix")
        self.assertEqual(p["scope"], "both")
        stored = open(os.path.join(self.store.base_dir,
                                   p["versions"][0]["patch_file"]),
                      "rb").read()
        # stored bytes are the FULL diff (tests/ survive for dev-src)
        self.assertIn(b"tests/test_x.py", stored)

    def test_both_rejected_when_keg_cannot_host(self):
        # keg tree WITHOUT kernels.py: pruned keg overlay fails to gate
        os.remove(os.path.join(self.keg, "omlx", "kernels.py"))
        res = patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("stage"), "keg-gate")

    def test_materialize_input_includes_both(self):
        patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        patchsource.set_enabled(self.store, "mix", True, approve="always")
        out = patchsource.enabled_build_patches(self.store)
        self.assertEqual([p["id"] for p in out], ["mix"])

    def test_materialize_input_excludes_obsolete(self):
        # jundot/omlx#4320 class: an upstream-MERGED patch is marked
        # obsolete while still enabled — materializing its stale diff
        # would abort the build (context moved upstream) or resurrect
        # trimmed lines. Obsolete = retired: builds NOTHING.
        patchsource.add_patch(
            self.store, "mix", {"kind": "upload", "data": MIXED_DIFF},
            self.keg, scope="both", build_root=self.src)
        patchsource.set_enabled(self.store, "mix", True, approve="always")
        m = self.store.load()
        p = self.store.find(m, "mix")
        self.assertTrue(self.store.set_state(p, "obsolete", "merged upstream"))
        self.store.save(m)
        out = patchsource.enabled_build_patches(self.store)
        self.assertEqual(out, [])


class DevKegRuntimeMountTests(unittest.TestCase):
    # RUNTIME-MOUNT doctrine (2026-10-18, user ruling): the dev keg mounts
    # omlx-scope overlays rebuild-free; dev/both still ride the branch.
    def _setup(self, tmp, scope):
        import hashlib

        store = patches.PatchStore(os.path.join(tmp, "uplift"))
        diff = (b"diff --git a/omlx/kernels.py b/omlx/kernels.py\n"
                b"index 3..4 100644\n--- a/omlx/kernels.py\n"
                b"+++ b/omlx/kernels.py\n@@ -1 +1,2 @@\n import Metal\n"
                b"+OVERLAID = 1\n")
        pf = store.patch_file("pk", 1)
        os.makedirs(os.path.dirname(pf), exist_ok=True)
        with open(pf, "wb") as fh:
            fh.write(diff)
        store.save({"version": 2, "config": {}, "patches": [
            {"id": "pk", "enabled": True, "scope": scope,
             "desired_version": 1, "state": "pending",
             "versions": [{"v": 1, "content_sha256":
                           hashlib.sha256(diff).hexdigest(),
                           "patch_file": patches.rel(pf, store.base_dir)}]}]})
        target = os.path.join(tmp, "site-packages")
        os.makedirs(os.path.join(target, "omlx"))
        with open(os.path.join(target, "omlx", "_version.py"), "w") as fh:
            fh.write('VERSION = "9.9.9"\n')
        with open(os.path.join(target, "omlx", "kernels.py"), "w") as fh:
            fh.write("import Metal\n")
        return store, target

    def test_reconcile_mounts_omlx_scope_on_dev_keg(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, target = self._setup(tmp, "omlx")
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                patchsync.reconcile(store, target, allow_reexec=False)
            with open(os.path.join(target, "omlx", "kernels.py")) as fh:
                self.assertIn("OVERLAID", fh.read())
            self.assertEqual(store.find(store.load(), "pk")["state"],
                             "applied")

    def test_reconcile_skips_both_scope_on_dev_keg(self):
        # the dev build carries the full diff: no overlay mount, no state mix
        with tempfile.TemporaryDirectory() as tmp:
            store, target = self._setup(tmp, "both")
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                patchsync.reconcile(store, target, allow_reexec=False)
            with open(os.path.join(target, "omlx", "kernels.py")) as fh:
                self.assertNotIn("OVERLAID", fh.read())
            self.assertEqual(store.find(store.load(), "pk")["state"],
                             "pending")

    def test_mark_dev_applied_clears_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = patches.PatchStore(os.path.join(tmp, "uplift"))
            m = {"version": 2, "config": {}, "patches": [
                {"id": "p1", "enabled": True, "scope": "dev",
                 "desired_version": 1, "state": "pending",
                 "versions": [{"v": 1, "content_sha256": "x"}]}]}
            store.save(m)
            patchsource.mark_dev_applied(
                store, [{"id": "p1", "v": 1, "sha": "abc123"}])
            out = store.load()
            p = store.find(out, "p1")
            self.assertEqual(p["state"], "applied")
            self.assertEqual(p["versions"][0]["dev_applied"]["sha"], "abc123")


class BuildStampHonestyTests(unittest.TestCase):
    """USER REPORT 2026-10-19 (mruu): `dev upgrade` SKIPPED
    voice14-qwen3-realtime at the operator's choice, yet the dashboard
    card still read 'APPLIED — applied to the omlx-dev build sources'.
    The branch is re-cut on every build, so a stamp left from the previous
    build names a commit that no longer exists. The build must therefore
    stamp what it CARRIED and record an honest absence for what it left
    out — per board, without flipping the shared state the vanilla keg
    legitimately owns."""

    def _store(self, tmp, patches_in):
        store = patches.PatchStore(os.path.join(tmp, "uplift"))
        store.save({"version": 2, "config": {}, "patches": patches_in})
        return store

    def _entries(self):
        return [
            {"id": "carried", "enabled": True, "scope": "both",
             "desired_version": 1, "state": "applied",
             "state_detail": "applied to the omlx-dev build sources",
             "versions": [{"v": 1, "content_sha256": "a",
                           "dev_applied": {"at": "old", "sha": "1" * 40}}]},
            {"id": "left-out", "enabled": True, "scope": "both",
             "desired_version": 1, "state": "applied",
             "state_detail": "applied to the omlx-dev build sources",
             "versions": [{"v": 1, "content_sha256": "b",
                           "dev_applied": {"at": "old", "sha": "2" * 40}}]},
        ]

    def test_skipped_patch_loses_the_stale_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp, self._entries())
            patchsource.mark_dev_applied(
                store, [{"id": "carried", "v": 1, "sha": "3" * 40,
                         "files": 1}],
                skipped=[{"id": "left-out", "reason": "no apply",
                          "tried": [1]}])
            man = store.load()
            carried = store.find(man, "carried")
            out = store.find(man, "left-out")
            # the build's own commit is recorded
            self.assertEqual(carried["versions"][0]["dev_applied"]["sha"],
                             "3" * 40)
            self.assertNotIn("dev_absent", carried)
            # the skipped one: dead commit gone, absence recorded
            self.assertNotIn("dev_applied", out["versions"][0])
            self.assertEqual(out["dev_absent"]["kind"], "skipped")
            self.assertIn("NOT in the current omlx-dev build",
                          out["dev_absent"]["reason"])
            self.assertIn("tried v1", out["dev_absent"]["reason"])
            # the SHARED state is not flipped — the vanilla keg still
            # carries this 'both' overlay (RUNTIME-MOUNT), and the skip was
            # the operator's own choice (no needs_review nag)
            self.assertEqual(out["state"], "applied")
            self.assertEqual(out["state_detail"],
                             "applied to the omlx-dev build sources")

    def test_dev_board_shows_the_build_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp, self._entries())
            patchsource.mark_dev_applied(
                store, [{"id": "carried", "v": 1, "sha": "3" * 40}],
                skipped=[{"id": "left-out", "reason": "no apply",
                          "tried": [1]}])
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                rows = {r["id"]: r for r in
                        patchsource.view(store, "", "devkeg")["patches"]}
            self.assertEqual(rows["carried"]["state"], "applied")
            self.assertTrue(rows["carried"]["active"])
            self.assertEqual(rows["carried"]["applied_v"], 1)
            self.assertEqual(rows["left-out"]["state"], "not_in_build")
            self.assertFalse(rows["left-out"]["active"])
            self.assertIsNone(rows["left-out"]["applied_v"])
            self.assertIn("NOT in the current omlx-dev build",
                          rows["left-out"]["state_detail"])
            # the vanilla board keeps the shared truth: the overlay IS there
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="omlx"):
                vrows = {r["id"]: r for r in
                         patchsource.view(store, "", "vanillakeg")["patches"]}
            self.assertEqual(vrows["left-out"]["state"], "applied")

    def test_build_wording_does_not_follow_the_patch_to_the_vanilla_card(self):
        # 'applied to the omlx-dev build sources' is a BUILD fact; on the
        # vanilla board the same patch is a runtime mount (RUNTIME-MOUNT)
        with tempfile.TemporaryDirectory() as tmp:
            entries = self._entries()
            for e in entries:
                e["versions"][0].pop("dev_applied", None)
                e["versions"][0]["kegs"] = {"vanillakeg": {
                    "status": "applied", "at": "now",
                    "tree_root": "/opt/homebrew/lib/python3.11/site-packages"}}
            store = self._store(tmp, entries)
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="omlx"):
                rows = {r["id"]: r for r in
                        patchsource.view(store, "", "vanillakeg")["patches"]}
            self.assertEqual(rows["carried"]["state"], "applied")
            self.assertIn("applied to the running server",
                          rows["carried"]["state_detail"])
            self.assertNotIn("omlx-dev build sources",
                             rows["carried"]["state_detail"])
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                drows = {r["id"]: r for r in
                         patchsource.view(store, "", "devkeg")["patches"]}
            self.assertIn("omlx-dev build sources",
                          drows["carried"]["state_detail"])

    def test_base_carried_patch_is_stamped_without_a_commit(self):
        # materialize skips the commit when the base already has the hunks:
        # the branch still CARRIES the patch, so the card must stay applied
        with tempfile.TemporaryDirectory() as tmp:
            entries = self._entries()
            for e in entries:
                e["versions"][0].pop("dev_applied", None)
            store = self._store(tmp, entries)
            patchsource.mark_dev_applied(
                store, [{"id": "carried", "v": 1, "sha": None,
                         "skipped": "already-present"}])
            man = store.load()
            carried = store.find(man, "carried")
            rec = carried["versions"][0]["dev_applied"]
            self.assertIsNone(rec["sha"])
            self.assertTrue(rec["base"])
            self.assertIn("already carry", carried["state_detail"])
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                rows = {r["id"]: r for r in
                        patchsource.view(store, "", "devkeg")["patches"]}
            self.assertEqual(rows["carried"]["state"], "applied")

    def test_obsolete_entry_keeps_its_own_verdict(self):
        # an upstreamed patch is retired, not missing: clear the dead commit
        # stamp but never present it as a skipped build patch
        with tempfile.TemporaryDirectory() as tmp:
            entries = self._entries()
            entries[1]["state"] = "obsolete"
            store = self._store(tmp, entries)
            patchsource.mark_dev_applied(
                store, [{"id": "carried", "v": 1, "sha": "3" * 40}])
            man = store.load()
            out = store.find(man, "left-out")
            self.assertEqual(out["state"], "obsolete")
            self.assertNotIn("dev_applied", out["versions"][0])
            self.assertEqual(out["dev_absent"]["kind"], "obsolete")
            with unittest.mock.patch.object(patches, "detect_patch_target",
                                            return_value="dev"):
                rows = {r["id"]: r for r in
                        patchsource.view(store, "", "devkeg")["patches"]}
            self.assertEqual(rows["left-out"]["state"], "obsolete")


class ViewScopeFilterTests(unittest.TestCase):
    def test_cli_status_shows_all_by_default(self):
        # 'patches status' must list every scope (item 5e); 'dev patches'
        # lists dev+both (item 5f). Both read the ONE store (item 8g).
        import subprocess
        import sys

        here = os.path.dirname(os.path.abspath(patches.__file__))
        pkg_parent = os.path.dirname(here)
        env = dict(os.environ, PYTHONPATH=pkg_parent)
        # argparse-level: --scope choices carry the new names and legacy
        out = subprocess.run(
            [sys.executable, "-m", "omlx_uplift.cli", "patches", "--help"],
            capture_output=True, text=True, env=env, cwd="/")
        self.assertIn("omlx", out.stdout)
        self.assertIn("both", out.stdout)
        out = subprocess.run(
            [sys.executable, "-m", "omlx_uplift.cli", "dev", "--help"],
            capture_output=True, text=True, env=env, cwd="/")
        self.assertIn("patches", out.stdout)


if __name__ == "__main__":
    unittest.main()
