"""Help surface: slim --help must cover EVERY command main() dispatches,
per-command usage works, and the bundled man page renders.

The DEV queue added `dev` without touching the help text — this test is the
guard against that class of drift (complaint 2026-09-24).
"""
import io
import re
import shutil
import subprocess
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from omlx_uplift import help as helpmod

PKG = Path(__file__).resolve().parents[1] / "omlx_uplift"


def _main_argv(argv):
    import sys
    from omlx_uplift import cli
    old = sys.argv
    sys.argv = ["omlx-uplift", *argv]
    try:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cli.main()
        return rc, buf.getvalue()
    finally:
        sys.argv = old


def _dispatchable_commands():
    """The set main() knows: parse the source for the dispatch set."""
    src = (PKG / "cli.py").read_text(encoding="utf-8")
    m = re.search(r'"skin",\s*"dev"\}', src)
    assert m, "main() dispatch set changed shape — update this test"
    block = src[max(0, m.start() - 200):m.end()]
    return set(re.findall(r'"([a-z-]+)"', block))


class TestHelpSurface(unittest.TestCase):
    def test_every_command_listed_in_help(self):
        dispatch = _dispatchable_commands() - {"help", "man"}
        listed = {c for c, _ in helpmod.COMMANDS}
        self.assertEqual(dispatch - listed, set(),
                         "commands main() dispatches but --help omits")
        rc, out = _main_argv(["--help"])
        self.assertEqual(rc, 0)
        for meta in ("help", "man"):
            self.assertIn(meta, out, f"--help never mentions {meta}")

    def test_slim_help_is_one_screen(self):
        rc, out = _main_argv(["--help"])
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertLess(len(lines), 25, "help ballooned past one screen")
        for cmd, _ in helpmod.COMMANDS:
            self.assertIn(cmd, out)
        self.assertIn("man", out)

    def test_no_args_shows_slim_help(self):
        rc, out = _main_argv([])
        self.assertEqual(rc, 0)
        self.assertIn("usage: omlx-uplift", out)

    def test_unknown_command_names_itself_and_exits_1(self):
        import sys
        from omlx_uplift import cli
        old = sys.argv
        sys.argv = ["omlx-uplift", "bogus"]
        try:
            with redirect_stdout(io.StringIO()):
                rc = cli.main()
        finally:
            sys.argv = old
        self.assertEqual(rc, 1)

    def test_per_command_usage(self):
        for cmd, _ in helpmod.COMMANDS:
            rc, out = _main_argv(["help", cmd])
            self.assertEqual(rc, 0, cmd)
            self.assertIn(cmd, out)

    def test_no_color_env_strips_ansi(self):
        import os
        old = os.environ.get("NO_COLOR")
        os.environ["NO_COLOR"] = "1"
        try:
            rc, out = _main_argv(["--help"])
        finally:
            if old is None:
                del os.environ["NO_COLOR"]
            else:
                os.environ["NO_COLOR"] = old
        self.assertNotIn("\x1b[", out)

    def test_man_page_shipped_and_covers_all_commands(self):
        path = helpmod.man_path()
        self.assertIsNotNone(path, "man/omlx-uplift.1 missing or not shipped")
        text = Path(path).read_text(encoding="utf-8")
        for cmd, _ in helpmod.COMMANDS:
            self.assertRegex(text, rf"\bIc {cmd}\b",
                             f"man page never documents command {cmd}")

    @unittest.skipIf(shutil.which("mandoc") is None, "no mandoc")
    def test_man_page_lint_clean(self):
        path = helpmod.man_path()
        proc = subprocess.run(["mandoc", "-Tlint", path],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_show_man_pipe_does_not_crash(self):
        # non-tty path (our redirect_stdout is not a tty)
        rc = helpmod.show_man()
        self.assertIn(rc, (0, None))


if __name__ == "__main__":
    unittest.main()
