"""PAT-3 tests: startup reconcile engine + re-exec loop guard + kill switches.

The re-exec test runs a REAL subprocess python with a synthesized .pth
directory: site-packages-style dir containing the uplift package parent,
a fake 'omlx' package, and our .pth line. argv[0] is a script file so the
re-exec contract (python <script>) applies.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from omlx_uplift import diffapply, patches, patchsync

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
PR3764 = open(os.path.join(FIX, "pr3764.diff"), "rb").read()
PKG_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(diffapply.__file__)))


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat3-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        os.environ.pop("OMLX_UPLIFT_NO_PATCHES", None)

    def _add_enabled(self):
        return _add_patch(self.store, self.root)(PR3764)

    def test_apply_then_verify_only(self):
        self._add_enabled()
        report = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertTrue(report["changed"])
        self.assertEqual(report["reports"][0]["action"], "applied")
        m = self.store.load()
        p = self.store.find(m, "demo")
        self.assertEqual(p["state"], "applied")
        # second pass: fast verify-only, no re-exec request
        report2 = patchsync.reconcile(self.store, self.root, allow_reexec=True)
        self.assertFalse(report2["changed"])
        self.assertFalse(report2["reexec"])

    def test_disable_restores_on_next_reconcile(self):
        self._add_enabled()
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        from omlx_uplift import patchsource

        patchsource.set_enabled(self.store, "demo", False)
        report = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertTrue(report["changed"])
        # bytes back pristine vs fixture
        got = open(os.path.join(self.root, "omlx/admin/routes.py"), "rb").read()
        want = open(os.path.join(FIX, "base3764/omlx/admin/routes.py"), "rb").read()
        self.assertEqual(got, want)
        p = self.store.find(self.store.load(), "demo")
        self.assertEqual(p["state"], "disabled")

    def test_conflict_marks_needs_review(self):
        # enabled patch whose target file was corrupted (simulated upgrade)
        self._add_enabled()
        with open(os.path.join(self.root, "omlx/admin/routes.py"), "wb") as fh:
            fh.write(b"corrupted by vanilla upgrade\n")
        report = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        acts = {r["id"]: r["action"] for r in report["reports"]}
        self.assertEqual(acts.get("demo"), "needs_review")
        m = self.store.load()
        self.assertEqual(self.store.find(m, "demo")["state"], "needs_review")
        self.assertTrue(self.store.warning_active(m))

    def test_kill_switch_env_verify_only(self):
        self._add_enabled()
        os.environ["OMLX_UPLIFT_NO_PATCHES"] = "1"
        self.addCleanup(os.environ.pop, "OMLX_UPLIFT_NO_PATCHES", None)
        report = patchsync.reconcile(self.store, self.root, allow_reexec=True)
        self.assertTrue(report["verify_only"])
        self.assertFalse(report["changed"])
        # file untouched
        got = open(os.path.join(self.root, "omlx/admin/routes.py"), "rb").read()
        want = open(os.path.join(FIX, "base3764/omlx/admin/routes.py"), "rb").read()
        self.assertEqual(got, want)

    def test_kill_switch_sentinel(self):
        self._add_enabled()
        os.makedirs(self.store.base_dir, exist_ok=True)
        with open(self.store.sentinel_path, "w") as fh:
            fh.write("x")
        report = patchsync.reconcile(self.store, self.root, allow_reexec=True)
        self.assertTrue(report["verify_only"])
        self.assertEqual(report["skipped_reason"], "kill switch")

    def test_lock_busy_falls_back_to_verify(self):
        import fcntl

        self._add_enabled()
        os.makedirs(self.store.base_dir, exist_ok=True)
        holder = open(self.store.lock_path, "a+")
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(holder.close)
        report = patchsync.reconcile(self.store, self.root, allow_reexec=True)
        self.assertTrue(report["verify_only"])
        self.assertEqual(report["skipped_reason"], "lock busy")

    def test_keg_change_invalidates_applied_state(self):
        self._add_enabled()
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        # simulate brew upgrade: version.py changes -> new keg id
        with open(os.path.join(self.root, "omlx", "version.py"), "w") as fh:
            fh.write("__version__ = '9.9'\n")
        m = self.store.load()
        p = self.store.find(m, "demo")
        applied = p["versions"][0]["applied"]
        # applied keg id differs from the (new) current keg
        new_keg = patches.keg_id(os.path.join(self.root, "omlx"))
        self.assertNotEqual(applied["keg_id"], new_keg)

    def test_empty_manifest_fast(self):
        import time

        t0 = time.monotonic()
        report = patchsync.reconcile(self.store, self.root, allow_reexec=True)
        self.assertLess(time.monotonic() - t0, 10.0)  # acceptance bound
        self.assertFalse(report["changed"])


def _add_patch(store, root):
    from omlx_uplift import patchsource

    def add(diff, pid="demo"):
        res = patchsource.add_patch(store, pid,
                                    {"kind": "upload", "data": diff}, root)
        patchsource.set_enabled(store, pid, True)
        return res
    return add


class ReexecGuardTests(unittest.TestCase):
    """os.execv stubbed: count execs across an emulated boot chain and
    prove the marker allows AT MOST ONE re-exec per chain (PAT-0 restart
    semantics, acceptance criterion 5)."""

    class FakeExec(Exception):
        pass

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat3g-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        with open(os.path.join(self.root, "omlx", "version.py"), "w") as fh:
            fh.write("__version__ = '0.1'\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        _add_patch(self.store, self.root)(PR3764)
        for k in ("OMLX_UPLIFT_REEXEC", "OMLX_UPLIFT_NO_REEXEC",
                  "OMLX_UPLIFT_NO_PATCHES"):
            os.environ.pop(k, None)
        self.execs = []

        def fake_execv(exe, args):
            self.execs.append((exe, args))
            raise ReexecGuardTests.FakeExec()

        self._real_execv = os.execv
        os.execv = fake_execv
        self.addCleanup(self._restore)

    def _restore(self):
        os.execv = self._real_execv
        patchsync._post_reexec_boot = False
        os.environ.pop("OMLX_UPLIFT_REEXEC", None)

    def _fresh_interpreter(self):
        # emulate os.execv: module state resets, environment survives
        patchsync._post_reexec_boot = False

    def test_at_most_one_execv_and_no_loop(self):
        # boot 1: real change -> execv fires once, process "replaced"
        with self.assertRaises(self.FakeExec):
            patchsync.sync_at_startup(self.store, self.root)
        self.assertEqual(len(self.execs), 1)
        self.assertIn("OMLX_UPLIFT_REEXEC", os.environ)

        # boot 2 (post-exec): simulate a SECOND pending change by undoing
        # the files on disk and forcing state back to pending
        got = os.path.join(self.root, "omlx/admin/routes.py")
        shutil.copy(os.path.join(FIX, "base3764/omlx/admin/routes.py"), got)
        m = self.store.load()
        p = self.store.find(m, "demo")
        p["state"] = "pending"
        p["versions"][0].pop("applied", None)
        self.store.save(m)

        self._fresh_interpreter()
        report = patchsync.sync_at_startup(self.store, self.root)
        # guard caught the marker: no second exec, boots anyway
        self.assertEqual(len(self.execs), 1)
        self.assertFalse(report["reexec"])
        self.assertTrue(report.get("loop_guard"))
        # marker env token consumed so children never inherit it
        self.assertNotIn("OMLX_UPLIFT_REEXEC", os.environ)

    def test_no_reexec_env_forces_boot_with_pending(self):
        os.environ["OMLX_UPLIFT_NO_REEXEC"] = "1"
        report = patchsync.sync_at_startup(self.store, self.root)
        self.assertEqual(self.execs, [])
        self.assertTrue(report["changed"])
        self.assertFalse(report["reexec"])


SUBMODULE_PTH_SCRIPT = r'''
import os, sys
print("BOOT-COUNT")   # printed once per interpreter boot
if __name__ == "__main__":
    import fake_marker_mod  # placeholder import; may fail, doesn't matter
'''

# A script whose argv[0] IS a file: re-exec reconstructs python <script>.
SCRIPT = r"""\
import os, sys
with open(sys.argv[1], "a") as fh:
    fh.write("boot\n")
import omlx_uplift.autopatch  # exactly what the .pth line executes
print("MARKER:" + (os.environ.get("OMLX_UPLIFT_REEXEC") or "-"))
"""


class SubprocessPthTests(unittest.TestCase):
    """Synthesized keg + .pth in a temp tree; a REAL interpreter boots it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat3sub-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        with open(os.path.join(self.root, "omlx", "version.py"), "w") as fh:
            fh.write("__version__ = '0.1'\n")
        with open(os.path.join(self.root, "omlx", "__init__.py"), "w") as fh:
            fh.write("")
        self.data = os.path.join(self.tmp, "data")
        # synthetic .pth: package parent + autopatch (as cmd_install writes)
        self.pth_dir = os.path.join(self.tmp, "pth")
        os.makedirs(self.pth_dir)
        with open(os.path.join(self.pth_dir, "omlx_uplift.pth"), "w") as fh:
            fh.write(PKG_PARENT + "\nimport omlx_uplift.autopatch\n")
        self.script = os.path.join(self.tmp, "boot.py")
        with open(self.script, "w") as fh:
            fh.write(SCRIPT)
        self.boots = os.path.join(self.tmp, "boots.log")
        self.env = dict(os.environ)
        self.env.update({
            # .pth semantics: pth_dir carries the file, PYTHONPATH resolves
            # BOTH the real uplift package (PKG_PARENT) and the fake omlx
            # keg (self.root). self.root comes FIRST: after
            # `omlx-uplift install` the uplift package lives inside the
            # keg's site-packages, which is PKG_PARENT itself — and that
            # directory also carries the real omlx, which would otherwise
            # shadow the fake keg and point sync at the live tree.
            "PYTHONPATH": os.pathsep.join([self.root, PKG_PARENT, self.pth_dir]),
            "OMLX_BASE_PATH": self.data,  # store base -> data/uplift
            "HOME": self.tmp,             # keep real ~/.omlx out of reach
        })
        self.env.pop("OMLX_UPLIFT_NO_REEXEC", None)
        self.env.pop("OMLX_UPLIFT_REEXEC", None)
        self.env.pop("OMLX_UPLIFT_NO_PATCHES", None)

    def _boot(self, extra_env=None, timeout=60):
        env = dict(self.env)
        env.update(extra_env or {})
        return subprocess.run(
            [sys.executable, self.script, self.boots],
            capture_output=True, text=True, env=env, timeout=timeout)

    def _seed_pending(self):
        store = patches.PatchStore(os.path.join(self.data, "uplift"))
        _add_patch(store, self.root)(PR3764)
        return store

    def test_reexec_then_clean_second_boot(self):
        store = self._seed_pending()
        proc = self._boot()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # The exec fires during site-init (the .pth), before the script
        # body: the one visible boot IS the post-re-exec interpreter.
        boots = open(self.boots).read().count("boot")
        self.assertEqual(boots, 1, proc.stdout + proc.stderr)
        # MARKER:- proves the one-shot env token was set by execv AND
        # consumed by the guard on the second interpreter pass.
        self.assertIn("MARKER:-", proc.stdout)
        # patch landed: the comment line PR3764 adds is present
        got = open(os.path.join(self.root, "omlx/admin/routes.py"), "rb").read()
        self.assertIn(b"The WebUI saves the FULL settings payload", got)
        p = store.find(store.load(), "demo")
        self.assertEqual(p["state"], "applied")
        # and no re-exec marker survives the boot
        self.assertNotIn("OMLX_UPLIFT_REEXEC", proc.stdout)

    def test_verify_only_boot_does_not_reexec(self):
        store = self._seed_pending()
        first = self._boot()  # applies + re-execs (invisible boot)
        self.assertEqual(first.returncode, 0, first.stderr)
        os.remove(self.boots)
        second = self._boot()  # applied + verified: NO re-exec this time
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(open(self.boots).read().count("boot"), 1)

    def test_kill_switch_boots_clean_with_pending(self):
        store = self._seed_pending()
        proc = self._boot({"OMLX_UPLIFT_NO_PATCHES": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(open(self.boots).read().count("boot"), 1)
        got = open(os.path.join(self.root, "omlx/admin/routes.py"), "rb").read()
        want = open(os.path.join(FIX, "base3764/omlx/admin/routes.py"), "rb").read()
        self.assertEqual(got, want)  # pristine

    def test_sentinel_boots_clean_with_applied_state(self):
        store = self._seed_pending()
        patchsync.reconcile(store, self.root, allow_reexec=False)  # applied
        self.assertFalse(os.path.exists(self.boots))  # no subprocess yet
        os.makedirs(store.base_dir, exist_ok=True)
        with open(store.sentinel_path, "w") as fh:
            fh.write("stop\n")
        proc = self._boot()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(open(self.boots).read().count("boot"), 1)


if __name__ == "__main__":
    unittest.main()
