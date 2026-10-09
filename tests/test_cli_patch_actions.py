"""CLI: 'patch' command — singular name, legacy 'patches' alias, per-patch
enable/disable/remove actions (the dashboard's API paths, CLI twin)."""
import contextlib
import io
import os
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

    def _cmd(self, argv, remove_ret=None, set_ret=None, approve_ret=None,
             add_ret=None):
        import omlx_uplift.patchsource as ps
        store = FakeStore()
        store.find = lambda m, pid: ({"id": pid, "enabled": True,
                                      "source": {"kind": "github_pr",
                                                 "repo": "jundot/omlx",
                                                 "pr": 7}}
                                     if pid == "my-pr" else None)
        rm = mock.MagicMock(return_value=remove_ret or {"ok": True})
        se = mock.MagicMock(return_value=set_ret or {"ok": True})
        ap_ = mock.MagicMock(return_value=approve_ret or {"ok": True})
        ad = mock.MagicMock(return_value=add_ret or {"ok": True})
        out = io.StringIO()
        with mock.patch("omlx_uplift.patches.PatchStore", lambda: store), \
             mock.patch("omlx_uplift.patches._omlx_root",
                        lambda: "/x/site-packages/omlx/__init__.py"), \
             mock.patch.object(ps, "remove_patch", rm), \
             mock.patch.object(ps, "set_enabled", se), \
             mock.patch.object(ps, "approve", ap_), \
             mock.patch.object(ps, "add_patch", ad), \
             contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(argv)
        return rc, rm, se, ap_, ad

    def test_disable_calls_set_enabled_false(self):
        rc, _, se, _, _ = self._cmd(["disable", "my-pr"])
        self.assertEqual(rc, 0)
        se.assert_called_once()
        args, kwargs = se.call_args
        self.assertEqual(args[1], "my-pr")
        self.assertIs(args[2] if len(args) > 2 else kwargs.get("enabled"), False)

    def test_enable_with_approve(self):
        rc, _, se, _, _ = self._cmd(["enable", "my-pr", "--approve", "always"])
        self.assertEqual(rc, 0)
        args, kwargs = se.call_args
        self.assertEqual(kwargs.get("approve")
                         if "approve" in kwargs else args[3], "always")

    def test_remove_calls_remove_patch(self):
        rc, rm, _, _, _ = self._cmd(["remove", "my-pr"])
        self.assertEqual(rc, 0)
        rm.assert_called_once()
        self.assertEqual(rm.call_args[0][1], "my-pr")

    def test_failure_exits_1(self):
        rc, _, _, _, _ = self._cmd(
            ["remove", "gone"],
            remove_ret={"ok": False, "reason": "unknown patch id: gone"})
        self.assertEqual(rc, 1)

    def test_id_required(self):
        with self.assertRaises(SystemExit):   # argparse error path
            self._cmd(["disable"])

    # --- 2026-10-09: standalone approve + update (user asks 1 and 5) ---

    def test_approve_defaults_to_once(self):
        rc, _, _, ap_, _ = self._cmd(["approve", "my-pr"])
        self.assertEqual(rc, 0)
        ap_.assert_called_once()
        args, kwargs = ap_.call_args
        self.assertEqual(args[1], "my-pr")
        self.assertEqual(kwargs.get("mode")
                         if "mode" in kwargs else (args[2] if len(args) > 2 else None),
                         "once")

    def test_approve_always_passes_mode(self):
        rc, _, _, ap_, _ = self._cmd(["approve", "my-pr", "--approve", "always"])
        self.assertEqual(rc, 0)
        args, kwargs = ap_.call_args
        self.assertEqual(kwargs.get("mode")
                         if "mode" in kwargs else args[2], "always")

    def test_approve_failure_exits_1(self):
        rc, _, _, _, _ = self._cmd(
            ["approve", "my-pr"],
            approve_ret={"ok": False, "reason": "no validated version"})
        self.assertEqual(rc, 1)

    def test_update_without_source_uses_stored_online_source(self):
        rc, _, _, _, ad = self._cmd(["update", "my-pr"])
        self.assertEqual(rc, 0)
        ad.assert_called_once()
        src = ad.call_args[0][2]
        self.assertEqual(src["kind"], "github_pr")
        self.assertEqual(src["pr"], 7)

    def test_update_with_file_uploads_new_diff(self):
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".diff",
                                         delete=False) as fh:
            fh.write("diff --git a/x b/x\n")
            path = fh.name
        self.addCleanup(os.unlink, path)
        rc, _, _, _, ad = self._cmd(["update", "my-pr", "--file", path])
        self.assertEqual(rc, 0)
        src = ad.call_args[0][2]
        self.assertEqual(src["kind"], "upload")
        self.assertIn(b"diff --git", src["data"])

    def test_update_upload_source_without_file_asks(self):
        # UPDATE-ADOPT: update errors now ride the JSON verdict on stdout
        # (the same shape as every other patch action), not stderr prose.
        store = FakeStore()
        store.find = lambda m, pid: {"id": pid,
                                     "source": {"kind": "upload"}}
        out = io.StringIO()
        with mock.patch("omlx_uplift.patches.PatchStore", lambda: store), \
             mock.patch("omlx_uplift.patches._omlx_root",
                        lambda: "/x/site-packages/omlx/__init__.py"), \
             contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(["update", "my-pr"])
        self.assertEqual(rc, 1)
        self.assertIn("--file", out.getvalue())

    def test_update_unknown_id_asks_for_add(self):
        store = FakeStore()
        store.find = lambda m, pid: None
        out = io.StringIO()
        with mock.patch("omlx_uplift.patches.PatchStore", lambda: store), \
             mock.patch("omlx_uplift.patches._omlx_root",
                        lambda: "/x/site-packages/omlx/__init__.py"), \
             contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(["update", "ghost"])
        self.assertEqual(rc, 1)
        self.assertIn("use 'add'", out.getvalue())

    # --- LOG-2 recovery path (2026-10-09): a disabled patch whose source
    # later gets a fixed version had no CLI way to adopt it — the drift
    # check's auto-promote is enabled-only, so 'enable' re-applied the
    # stale (broken) desired version and dev upgrade died again. ---

    def test_promote_calls_patchsource_promote(self):
        import omlx_uplift.patchsource as ps
        pm = mock.MagicMock(return_value={"ok": True, "state": "pending",
                                          "desired_version": 3})
        store = FakeStore()
        store.find = lambda m, pid: {"id": pid}
        out = io.StringIO()
        with mock.patch("omlx_uplift.patches.PatchStore", lambda: store), \
             mock.patch("omlx_uplift.patches._omlx_root",
                        lambda: "/x/site-packages/omlx/__init__.py"), \
             mock.patch.object(ps, "promote", pm), \
             contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(["promote", "my-pr"])
        self.assertEqual(rc, 0)
        pm.assert_called_once()
        self.assertEqual(pm.call_args[0][1], "my-pr")

    def test_promote_needs_id(self):
        with self.assertRaises(SystemExit):   # argparse error path
            self._cmd(["promote"])


if __name__ == "__main__":
    unittest.main()
