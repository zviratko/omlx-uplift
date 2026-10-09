"""LOG-2 (2026-10-09): a failed DRIFT-CHECK gate must not print the
build-failure-shaped 'gate REJECTED' warning to the console.

Live shape: upstream moved under a vendored curated patch; every
'dev upgrade' ran curated.sync + check_all, both of which re-gate the
(still broken) stored source against the new base. fetch_and_gate logged
the failure at WARNING — it reached stderr — so even after the user
disabled the patch and materialize no longer died, the build output
still showed the identical rejection with no attribution and no way to
tell it was the expected, harmless echo of a stale source (the candidate
simply is not stored). check_all now passes quiet=True: the verdict
stands, its LOG LEVEL drops to INFO. The add/update gate (_add_gate)
keeps WARNING — there the rejection IS the user's requested action
failing."""
import logging
import os
import unittest

from omlx_uplift import patchsource

# modify a file that does not exist in the gate tree -> a guaranteed
# failing gate without any network or fixture repo
BAD_DIFF = (
    b"diff --git a/omlx/definitely_not_here.py b/omlx/definitely_not_here.py\n"
    b"--- a/omlx/definitely_not_here.py\n"
    b"+++ b/omlx/definitely_not_here.py\n"
    b"@@ -1,1 +1,1 @@\n"
    b"-x = 1\n"
    b"+x = 2\n")


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


class TestQuietGateLog(unittest.TestCase):
    def _run(self, quiet):
        root = os.path.join(os.path.dirname(__file__), "fixtures")  # exists, no omlx pkg
        tree = self._fake_tree()
        cap = _Capture()
        log = logging.getLogger("omlx_uplift.patchsource")
        prev = log.level
        log.addHandler(cap)
        log.setLevel(logging.INFO)
        try:
            res = patchsource.fetch_and_gate(
                {"kind": "upload", "data": BAD_DIFF}, tree, quiet=quiet)
        finally:
            log.removeHandler(cap)
            log.setLevel(prev)
        return res, cap

    def _fake_tree(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="log2-tree-")
        os.makedirs(os.path.join(d, "omlx"), exist_ok=True)
        self.addCleanup(_rmtree, d)
        return d

    def test_default_gate_failure_warns(self):
        res, cap = self._run(quiet=False)
        self.assertFalse(res["ok"])
        rejected = [r for r in cap.records if "REJECTED" in r.getMessage()]
        self.assertTrue(rejected, "the add-path gate failure must stay loud")
        self.assertEqual(rejected[0].levelno, logging.WARNING)

    def test_quiet_gate_failure_logs_info(self):
        res, cap = self._run(quiet=True)
        self.assertFalse(res["ok"], "quiet must not change the verdict")
        rejected = [r for r in cap.records if "REJECTED" in r.getMessage()]
        self.assertTrue(rejected, "the failure must stay in the log file")
        self.assertEqual(rejected[0].levelno, logging.INFO,
                         "a drift-check gate failure must not read as a "
                         "build-stopping warning")

    def test_check_all_uses_quiet(self):
        """The drift check must pass quiet=True (its failure is expected)."""
        import inspect

        src = inspect.getsource(patchsource.check_all)
        self.assertIn("quiet=True", src)


def _rmtree(d):
    import shutil

    shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
