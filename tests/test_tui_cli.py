"""TUI-1 CLI surface: the `tui` verb is wired, refuses a non-tty honestly, and
the `patch rollback` verb the TUI needed (and which the dashboard always had)
now exists.

Nothing here starts curses: the tty guard must fail BEFORE the screen is
touched, which is exactly what makes the refusal testable — and what keeps a
piped `omlx-uplift tui | tee log` from writing control codes into a file.

The rollback tests mock the tree root instead of relying on an installed omlx:
the verb only rewrites the manifest, and CI has no omlx, so a live probe would
make these tests fail there for the wrong reason.
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from omlx_uplift import cli
from omlx_uplift.tui import app as appmod


def _dispatch(argv):
    old = sys.argv
    sys.argv = ["omlx-uplift", *argv]
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main()
    finally:
        sys.argv = old
    return rc, out.getvalue(), err.getvalue()


class TestDispatch(unittest.TestCase):
    def test_tui_is_a_known_command(self):
        # main() gates on a literal set; an unlisted verb prints 'unknown'
        with mock.patch.object(cli, "cmd_tui",
                               side_effect=lambda a: 0) as h:
            rc, _out, _err = _dispatch(["tui"])
        self.assertEqual(rc, 0)
        h.assert_called_once_with([])

    def test_cmd_tui_delegates_to_the_screen(self):
        with mock.patch.object(appmod, "run_tui", return_value=7) as run:
            self.assertEqual(cli.cmd_tui(["--x"]), 7)
        run.assert_called_once_with(["--x"])


class TestHeadlessRefusal(unittest.TestCase):
    """pytest gives us no tty, so this is also the CI path."""

    def _run(self, stdin_tty, stdout_tty, term="xterm-256color"):
        """Swap the streams ourselves: contextlib.redirect_stdout replaces
        sys.stdout AFTER a patch.object on the old one would have been
        attached, so patching isatty that way silently tests nothing."""
        buf_out, buf_err = io.StringIO(), io.StringIO()
        buf_out.isatty = lambda: stdout_tty
        buf_err.isatty = lambda: True
        saved = (sys.stdin, sys.stdout, sys.stderr)
        sys.stdin = mock.Mock(isatty=lambda: stdin_tty)
        sys.stdout, sys.stderr = buf_out, buf_err
        try:
            with mock.patch.dict(os.environ, {"TERM": term}):
                rc = appmod.run_tui([])
        finally:
            sys.stdin, sys.stdout, sys.stderr = saved
        return rc, buf_out.getvalue(), buf_err.getvalue()

    def test_a_pipe_refuses_with_exit_2_and_no_traceback(self):
        rc, out, err = self._run(False, False)
        self.assertEqual(rc, 2)
        self.assertEqual(out, "",
                         "nothing may reach stdout: a pipe would capture "
                         "control codes as file content")
        self.assertIn("needs a terminal", err)
        self.assertNotIn("Traceback", err)

    def test_both_streams_must_be_a_tty(self):
        # stdout-only is the 'tee the log' shape; stdin-only is a redirected
        # script. Neither can drive a screen.
        self.assertEqual(self._run(True, False)[0], 2)
        self.assertEqual(self._run(False, True)[0], 2)

    def test_the_refusal_names_the_headless_alternatives(self):
        _rc, _out, err = self._run(False, False)
        for verb in ("patch status", "dev status"):
            self.assertIn(verb, err,
                          "an operator told 'no' must be told 'do this "
                          "instead'")

    def test_TERM_dumb_refuses(self):
        # emacs shells and some pagers report a tty but cannot paint
        rc, _out, err = self._run(True, True, term="dumb")
        self.assertEqual(rc, 2)
        self.assertIn("TERM", err)

    def test_the_repl_is_never_started_without_a_screen(self):
        with mock.patch.object(appmod, "_curses_loop") as loop:
            rc = self._run(False, False)[0]
        self.assertEqual(rc, 2)
        loop.assert_not_called()


class TestHelpSurface(unittest.TestCase):
    def test_help_lists_tui(self):
        from omlx_uplift import help as helpmod

        self.assertIn("tui", {c for c, _ in helpmod.COMMANDS})
        self.assertIn("tui", helpmod.COMMAND_USAGE)

    def test_usage_shows_the_entry_point(self):
        from omlx_uplift import help as helpmod

        self.assertIn("omlx-uplift tui", helpmod.COMMAND_USAGE["tui"])


class TestPatchRollbackVerb(unittest.TestCase):
    """The dashboard has had POST /patches/rollback from the start; the CLI did
    not, so an operator at a shell could not undo a bad promote. The TUI's 'v'
    needs it, and the verb is the honest fix."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tui-rb-")
        self.tree = tempfile.mkdtemp(prefix="tui-rb-tree-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        from omlx_uplift import patches

        self.store = patches.PatchStore()
        self.store.save({"patches": [
            {"id": "alpha", "enabled": True, "order": 100,
             "source": {"kind": "url", "url": "http://x/alpha.diff"},
             "desired_version": 3,
             "versions": [{"v": n, "content_sha256": "c",
                           "fetched_at": "2026-10-01T00:00"}
                          for n in (1, 2, 3)],
             "state": "applied", "state_detail": "",
             "description": "alpha"}]})
        # cmd_patches refuses to do anything when it cannot see an omlx tree;
        # point it at a scratch dir so the verb's own logic is what is tested
        self._root = mock.patch(
            "omlx_uplift.patches._omlx_root",
            return_value=os.path.join(self.tree, "omlx"))
        self._root.start()
        self.addCleanup(self._root.stop)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.tree, ignore_errors=True)

    def _run(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.cmd_patches(argv)
        return rc, json.loads(out.getvalue())

    def _patch(self):
        return self.store.find(self.store.load(), "alpha")

    def test_rollback_lands_on_the_previous_version(self):
        rc, res = self._run(["rollback", "alpha"])
        self.assertEqual(rc, 0, res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["desired_version"], 2)
        self.assertEqual(self._patch()["desired_version"], 2,
                         "the manifest must carry the rollback")
        self.assertEqual(self._patch()["state"], "pending",
                         "a rolled-back patch re-applies at the next restart")

    def test_to_v_targets_a_specific_stored_version(self):
        rc, res = self._run(["rollback", "alpha", "--to-v", "1"])
        self.assertEqual(rc, 0, res)
        self.assertEqual(res["desired_version"], 1)
        self.assertEqual(self._patch()["desired_version"], 1)

    def test_an_unstored_version_is_refused(self):
        rc, res = self._run(["rollback", "alpha", "--to-v", "9"])
        self.assertEqual(rc, 1)
        self.assertIn("not stored", res["reason"])
        self.assertEqual(self._patch()["desired_version"], 3,
                         "a refusal must change nothing")

    def test_a_patch_with_one_version_has_nothing_to_roll_back(self):
        m = self.store.load()
        m["patches"][0]["versions"] = [m["patches"][0]["versions"][0]]
        m["patches"][0]["desired_version"] = 1
        self.store.save(m)
        rc, res = self._run(["rollback", "alpha"])
        self.assertEqual(rc, 1)
        self.assertIn("no previous version", res["reason"])

    def test_an_unknown_id_is_refused(self):
        rc, res = self._run(["rollback", "ghost"])
        self.assertEqual(rc, 1)
        self.assertIn("unknown patch id", res["reason"])

    def test_the_id_is_mandatory(self):
        with self.assertRaises(SystemExit):        # argparse usage error
            self._run(["rollback"])

    def test_the_verb_appears_in_the_usage_text(self):
        from omlx_uplift import help as helpmod

        self.assertIn("rollback", helpmod.COMMAND_USAGE["patch"])


if __name__ == "__main__":
    unittest.main()
