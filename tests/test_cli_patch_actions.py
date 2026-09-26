"""CLI: 'patch' command — singular name, legacy 'patches' alias, per-patch
enable/disable/remove actions (the dashboard's API paths, CLI twin)."""
import contextlib
import io
import sys
import unittest
from unittest import mock

from omlx_uplift import cli


class FakeStore:
    sentinel_path = "/tmp/sentinel"

    def __init__(self):
        self.saved = []

    def load(self):
        return {"patches": []}

    def save(self, m):
        self.saved.append(m)

    def patches_disabled(self):
        return False

    def set_state_if(self, *a):
        pass


def _dispatch(main_argv):
    """Run cli.main() with argv; return (rc, stdout)."""
    old = sys.argv
    sys.argv = ["omlx-uplift", *main_argv]
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            rc = cli.main()
    finally:
        sys.argv = old
    return rc, out.getvalue()


class TestPatchCommandName(unittest.TestCase):
    def test_alias_routes_to_same_handler(self):
        calls = []
        with mock.patch.object(cli, "cmd_patches",
                               side_effect=lambda a: calls.append(list(a)) or 0):
            rc1, _ = _dispatch(["patch", "status"])
            rc2, _ = _dispatch(["patches", "status"])
        self.assertEqual((rc1, rc2), (0, 0))
        self.assertEqual(calls, [["status"], ["status"]])


class TestPatchActions(unittest.TestCase):
    """disable/remove/enable dispatch to the very functions the dashboard
    API routes use — the CLI must not invent its own path."""

    def _cmd(self, argv, remove_ret=None, set_ret=None):
        import omlx_uplift.patchsource as ps
        store = FakeStore()
        rm = mock.MagicMock(return_value=remove_ret or {"ok": True})
        se = mock.MagicMock(return_value=set_ret or {"ok": True})
        out = io.StringIO()
        with mock.patch("omlx_uplift.patches.PatchStore", lambda: store), \
             mock.patch("omlx_uplift.patches._omlx_root",
                        lambda: "/x/site-packages/omlx/__init__.py"), \
             mock.patch.object(ps, "remove_patch", rm), \
             mock.patch.object(ps, "set_enabled", se), \
             contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(argv)
        return rc, rm, se

    def test_disable_calls_set_enabled_false(self):
        rc, _, se = self._cmd(["disable", "my-pr"])
        self.assertEqual(rc, 0)
        se.assert_called_once()
        args, kwargs = se.call_args
        self.assertEqual(args[1], "my-pr")
        self.assertIs(args[2] if len(args) > 2 else kwargs.get("enabled"), False)

    def test_enable_with_approve(self):
        rc, _, se = self._cmd(["enable", "my-pr", "--approve", "always"])
        self.assertEqual(rc, 0)
        args, kwargs = se.call_args
        self.assertEqual(kwargs.get("approve")
                         if "approve" in kwargs else args[3], "always")

    def test_remove_calls_remove_patch(self):
        rc, rm, _ = self._cmd(["remove", "my-pr"])
        self.assertEqual(rc, 0)
        rm.assert_called_once()
        self.assertEqual(rm.call_args[0][1], "my-pr")

    def test_failure_exits_1(self):
        rc, _, _ = self._cmd(
            ["remove", "gone"],
            remove_ret={"ok": False, "reason": "unknown patch id: gone"})
        self.assertEqual(rc, 1)

    def test_id_required(self):
        with self.assertRaises(SystemExit):   # argparse error path
            self._cmd(["disable"])


if __name__ == "__main__":
    unittest.main()
