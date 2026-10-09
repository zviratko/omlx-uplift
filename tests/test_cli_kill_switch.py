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
from contextlib import redirect_stdout

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


if __name__ == "__main__":
    unittest.main()
