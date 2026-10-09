"""LOG-2 (2026-10-09): 'patch disable-all' arms the boot kill switch and
turned every patch off, but the removal verb the help text promised
('--enable-sentinel-off') never existed — the only way back was rm(1) on
a path the user had to find, and nobody knew their runtime patches were
silently off. 'patch enable-all' is the twin: sentinel gone, and the
enabled flags restore EXACTLY to what disable-all recorded. Patches the
user had disabled before the kill switch stay off (the stamp records only
what the kill switch itself switched off), and the user's own later
disable of a re-enabled patch is a decision enable-all never reverts.
"""
import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout

from omlx_uplift import cli, patches


def _patch(pid, enabled):
    return {"id": pid, "enabled": enabled, "order": 100,
            "source": {"kind": "url", "url": f"http://x/{pid}.diff"},
            "desired_version": 0, "versions": [],
            "state": "applied" if enabled else "disabled",
            "state_detail": ""}


class KillSwitchRoundTrip(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.home = tempfile.mkdtemp(prefix="log2-kill-")
        self._old_home = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        self.store = patches.PatchStore()
        manifest = {"patches": [_patch("on-a", True), _patch("on-b", True),
                                _patch("off-c", False)]}
        self.store.save(manifest)

    def tearDown(self):
        import shutil

        if self._old_home is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def _run(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = cli.cmd_patches(list(argv))
        return rc, json.loads(out.getvalue())

    def _enabled(self, pid):
        p = self.store.find(self.store.load(), pid)
        return bool(p and p.get("enabled"))

    def test_disable_all_arms_sentinel_and_stamps_enabled(self):
        rc, res = self._run("disable-all")
        self.assertEqual(rc, 0)
        self.assertTrue(self.store.patches_disabled())
        self.assertFalse(self._enabled("on-a"))
        m = self.store.load()
        a = self.store.find(m, "on-a")
        self.assertTrue(a.get("enabled_before_kill"))
        # a patch already off by the user gets NO stamp — enable-all must
        # not resurrect it
        c = self.store.find(m, "off-c")
        self.assertNotIn("enabled_before_kill", c)
        self.assertIn("sentinel", res)

    def test_enable_all_disarms_and_restores_exactly_the_footprint(self):
        self._run("disable-all")
        rc, res = self._run("enable-all")
        self.assertEqual(rc, 0)
        self.assertFalse(self.store.patches_disabled())
        self.assertTrue(self._enabled("on-a"))
        self.assertTrue(self._enabled("on-b"))
        self.assertFalse(self._enabled("off-c"),
                         "the user's own disable survived the round trip")
        self.assertEqual(sorted(res["restored"]), ["on-a", "on-b"])
        # stamps are consumed, not left behind
        m = self.store.load()
        self.assertNotIn("enabled_before_kill", self.store.find(m, "on-a"))

    def test_enable_all_without_sentinel_is_a_clean_noop(self):
        rc, res = self._run("enable-all")
        self.assertEqual(rc, 0)
        self.assertTrue(res["ok"])
        self.assertEqual(res["restored"], [])
        self.assertFalse(res["kill_switch_active"])
        self.assertFalse(self._enabled("off-c"))

    def test_rearm_does_not_overwrite_first_footprint(self):
        """disable-all, patch becomes enabled again in between, disable-all
        again: the re-arm stamps it (it IS what the kill switch turned off
        this time) and enable-all restores that footprint; the first
        stamp's 'False' is never overwritten by a later 'True'."""
        self._run("disable-all")
        m = self.store.load()
        c = self.store.find(m, "off-c")
        c["enabled"] = True           # e.g. curated sync or a manual act
        self.store.save(m)
        self._run("disable-all")      # re-arm over a changed state
        m = self.store.load()
        self.assertTrue(self.store.find(m, "off-c").get("enabled_before_kill"))
        self._run("enable-all")
        self.assertTrue(self._enabled("off-c"))
        self.assertTrue(self._enabled("on-a"))
        # and the first-armed rule: a stamp already present is never lost
        # when the patch is off at re-arm time
        self._run("disable-all")
        m = self.store.load()
        self.assertTrue(self.store.find(m, "on-a").get("enabled_before_kill"))

    def test_pending_state_after_restore(self):
        """A restored patch must be 'pending' so the next reconcile boots
        it — not stuck in 'disabled' with enabled=True."""
        self._run("disable-all")
        self._run("enable-all")
        p = self.store.find(self.store.load(), "on-a")
        self.assertTrue(p["enabled"])
        self.assertEqual(p["state"], "pending")

    def test_the_kill_switch_works_with_no_omlx_tree(self):
        """TUI-1: these verbs write only the manifest and the sentinel, so
        they must answer before cmd_patches' tree check. The case they exist
        for is 'the patched runtime is the problem' — and on a machine where
        omlx is not importable (the CI venv, or a keg you just broke), the
        old order refused the rescue command with 'is omlx installed?'.
        Regression test for the five CI failures that landed in LOG-2."""
        from unittest import mock

        import omlx_uplift.patches as _patches

        with mock.patch.object(_patches, "_omlx_root", return_value=None):
            rc_arm, armed = self._run("disable-all")
            self.assertTrue(armed["ok"], "arm must succeed without a tree")
            self.assertTrue(os.path.exists(self.store.sentinel_path))
            self.assertFalse(self._enabled("on-a"))
            rc_off, back = self._run("enable-all")
        self.assertTrue(back["ok"], "clear must succeed without a tree")
        self.assertEqual(back["restored"], ["on-a", "on-b"])
        self.assertFalse(os.path.exists(self.store.sentinel_path))
        self.assertTrue(self._enabled("on-a"))
        self.assertFalse(self._enabled("off-c"),
                        "a patch the user had off stays off")

    def test_tree_bound_verbs_still_refuse_without_a_tree(self):
        """The gate stays where it belongs: 'status' reads the live tree to
        answer 'applied on this keg?', so it must still say it cannot."""
        from unittest import mock

        import omlx_uplift.patches as _patches

        err = io.StringIO()
        with mock.patch.object(_patches, "_omlx_root", return_value=None), \
                redirect_stdout(io.StringIO()), redirect_stderr(err):
            rc = cli.cmd_patches(["status"])
        self.assertEqual(rc, 2)
        self.assertIn("tree not found", err.getvalue())


if __name__ == "__main__":
    unittest.main()
