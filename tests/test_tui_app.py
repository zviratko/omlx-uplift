"""TUI-1 App behaviour, headless.

The App class holds every decision the interface makes and imports no curses,
so the whole confirmation gate is testable here. These tests are the reason
the TUI is safe to ship: each one asserts that state on disk did NOT change
until the operator answered, and that a hostile or accidental keystroke cannot
arm a destructive action.
"""
import os
import shutil
import tempfile
import time
import unittest

from omlx_uplift import patches
from omlx_uplift.tui import model, ops
from omlx_uplift.tui.app import App
from omlx_uplift.tui.context import Context


def store_manifest():
    return {"patches": [
        {"id": "alpha", "enabled": True, "order": 100,
         "source": {"kind": "url", "url": "http://x/alpha.diff"},
         "desired_version": 2,
         "versions": [{"v": 1, "content_sha256": "a",
                       "fetched_at": "2026-10-01T00:00"},
                      {"v": 2, "content_sha256": "b",
                       "fetched_at": "2026-10-05T00:00"}],
         "state": "applied", "state_detail": "", "description": "alpha"},
        {"id": "beta", "enabled": False, "order": 100,
         "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 42},
         "desired_version": 0, "versions": [], "state": "disabled",
         "state_detail": "", "description": "beta"},
    ]}


class AppCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tui-app-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        self.store = patches.PatchStore()
        self.store.save(store_manifest())
        self.ctx = Context(store=self.store, tree_root="/fake/tree")
        self.app = App(self.ctx)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)

    # ---------------------------------------------------------- helpers ----
    def enabled(self, pid):
        p = self.store.find(self.store.load(), pid)
        return bool(p and p.get("enabled"))

    def select_patch(self, pid):
        self.app.goto("patches")
        s = self.app.screen
        self.app.pending = None
        idx = next((i for i, r in enumerate(s.rows) if r.key == pid), None)
        self.assertIsNotNone(idx, f"{pid} is not on the patches screen")
        s.selected = idx

    def settle(self, timeout=3.0):
        """Wait for the worker to report — an op runs in a thread so the
        screen keeps repainting, and a test must not race it."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.app.drain():
                return True
            time.sleep(0.01)
        return False


class TestNothingRunsUnasked(AppCase):
    """The confirmation gate."""

    def test_a_write_action_waits_and_writes_nothing(self):
        self.select_patch("alpha")
        self.app.on_key("d")
        self.assertTrue(self.app.pending, "disable must ask first")
        self.assertFalse(self.app.awaiting_yes, "disable is a WRITE, not HIGH")
        self.assertTrue(self.enabled("alpha"),
                        "the store changed before the operator answered")
        self.assertIn("omlx-uplift patch disable alpha", self.app.prompt)

    def test_any_key_that_is_not_y_cancels_a_write(self):
        for key in ("n", "", " ", "Y", "enter", "x", "q", "1"):
            self.store.save(store_manifest())
            self.select_patch("alpha")
            self.app.on_key("d")
            self.assertTrue(self.app.pending)
            self.app.on_key(key)
            self.assertFalse(self.app.pending, f"{key!r} left the gate open")
            self.assertTrue(self.enabled("alpha"),
                            f"{key!r} must not disable the patch")
            self.app.running = True

    def test_typed_y_runs_the_write(self):
        self.select_patch("alpha")
        self.app.on_key("d")
        self.app.on_key("y")
        self.assertTrue(self.settle())
        self.assertFalse(self.enabled("alpha"))
        self.assertIn("done", self.app.notice)

    def test_a_high_action_cannot_be_armed_by_a_partial_answer(self):
        # remove patch restores tree bytes and deletes the stored diff. The
        # curses layer reads a LINE and delivers it as 'yes:<text>'; anything
        # short of YES must be harmless, including a stray 'y' + Enter.
        # 'yES' is deliberately NOT here: the answer is matched
        # case-insensitively, so that one really is a confirmation.
        for answer in ("y", "ye", "Y", "yesp", "", "yes please", "no"):
            self.store.save(store_manifest())
            self.select_patch("alpha")
            self.app.on_key("x")
            self.assertTrue(self.app.pending and self.app.awaiting_yes)
            self.app.on_key("yes:" + answer)
            self.assertFalse(self.app.pending)
            self.assertIsNotNone(self.store.find(self.store.load(), "alpha"),
                                 f"answer {answer!r} removed the patch")
            self.assertIn("needs a typed YES", self.app.notice)

    def test_the_yes_line_confirms_a_high_action(self):
        # 'remove patch' runs against a fake tree, so the op itself fails;
        # what matters is that the gate OPENED — the op ran, and said so
        for answer in ("YES", "yes", "  Yes  ", "yES"):   # case/space tolerant
            self.store.save(store_manifest())
            self.select_patch("alpha")
            self.app.on_key("x")
            self.app.on_key("yes:" + answer)
            self.assertTrue(self.app.busy, f"{answer!r} never armed the op")
            self.settle()
            self.assertIn("remove patch", self.app.notice)

    def test_navigation_cannot_slip_past_an_open_question(self):
        # an operator mid-line who hits a screen key must not switch screens
        # (and definitely not confirm): any key that is not an answer cancels
        self.select_patch("alpha")
        self.app.on_key("x")
        self.app.on_key("1")
        self.assertFalse(self.app.pending)
        self.assertEqual(self.app.current, "patches",
                         "the question vanished AND switched screens")
        self.assertIsNotNone(self.store.find(self.store.load(), "alpha"))

    def test_q_cancels_a_pending_confirmation_instead_of_running_it(self):
        # while a question is open, q answers 'no' rather than quitting: an
        # operator who hits q at a YES prompt wants out of THAT, and quitting
        # here could not be distinguished from confirming by accident. The
        # second q is the one that leaves.
        self.select_patch("alpha")
        self.app.on_key("x")
        self.app.on_key("q")
        self.assertFalse(self.app.pending)
        self.assertTrue(self.app.running, "q cancelled the op and also quit")
        self.assertIsNotNone(self.store.find(self.store.load(), "alpha"))
        self.app.on_key("q")
        self.assertFalse(self.app.running)

    def test_ctrl_c_also_answers_no(self):
        self.select_patch("alpha")
        self.app.on_key("x")
        self.app.on_key("ctrl_c")
        self.assertFalse(self.app.pending)
        self.assertIsNotNone(self.store.find(self.store.load(), "alpha"))

    def test_read_only_actions_run_immediately(self):
        # dry-run test touches nothing, so making the operator confirm it
        # would only train them to press y without reading
        self.select_patch("alpha")
        self.app.on_key("t")
        self.assertFalse(self.app.pending)
        self.assertTrue(self.settle())

    def test_an_op_needs_a_row_of_the_right_kind(self):
        self.app.goto("patches")
        s = self.app.screen
        s.selected = len(s.rows)                      # past the end -> clamped
        s.clamp()
        # a header/empty row must not accept 'enable'
        empty = [r for r in s.rows if not r.selectable]
        if empty:
            s.selected = s.rows.index(empty[0])
            self.app.on_key("e")
            self.assertFalse(self.app.pending)


class TestNavigation(AppCase):
    def test_number_keys_switch_screens(self):
        for key, name in (("2", "patches"), ("3", "catalog"), ("4", "dev"),
                          ("5", "log"), ("1", "overview")):
            self.app.on_key(key)
            self.assertEqual(self.app.current, name)

    def test_cursor_skips_headers_and_lands_on_a_row(self):
        # the dev screen leads with a dev-src info row and stashes follow
        self.app.goto("dev")
        first = self.app.screen.current()
        self.assertTrue(first.selectable or first.kind == "empty",
                        f"selection landed on {first.kind}")

    def test_j_and_k_move_and_stop_at_the_ends(self):
        self.app.goto("patches")
        s = self.app.screen
        start = s.selected
        self.app.on_key("k")
        self.assertEqual(s.selected, max(0, start - 1))
        for _ in range(20):
            self.app.on_key("k")
        self.assertEqual(s.selected, 0)
        for _ in range(20):
            self.app.on_key("j")
        self.assertEqual(s.selected, len(s.rows) - 1)

    def test_arrow_keys_alias_j_and_k(self):
        self.app.goto("patches")
        s = self.app.screen
        self.app.on_key("down")
        self.assertGreaterEqual(s.selected, 1)

    def test_enter_toggles_the_detail_pane(self):
        self.app.goto("patches")
        shown = "\n".join(t for t, _ in self.app.lines(120, 40))
        self.app.on_key("enter")
        hidden = "\n".join(t for t, _ in self.app.lines(120, 40))
        self.assertIn("desired:", shown)
        self.assertNotIn("desired:", hidden)

    def test_help_overlay_opens_and_closes_on_any_key(self):
        self.app.on_key("?")
        self.assertTrue(self.app.show_help)
        self.assertIn("keys and rules", self.app.lines(120, 40)[0][0])
        self.app.on_key("j")
        self.assertFalse(self.app.show_help)
        self.assertEqual(self.app.current, "overview",
                         "a key that dismissed help must not also act")

    def test_unknown_key_says_so_instead_of_silently_ignoring(self):
        self.app.goto("patches")
        self.app.on_key("W")
        self.assertIn("does nothing", self.app.notice)

    def test_the_notice_appears_in_the_title(self):
        self.app.notice = "theme p(doom)"
        self.assertIn("[theme p(doom)]",
                      self.app.lines(120, 40)[0][0])

    def test_selection_survives_a_rebuild(self):
        # state refreshes every few seconds; the cursor must not jump back to
        # the top while the operator is reading row five
        self.select_patch("beta")
        self.app.build()
        self.assertEqual(self.app.screen.current().key, "beta")

    def test_a_new_row_does_not_move_the_selection(self):
        self.select_patch("beta")
        m = store_manifest()
        m["patches"].append({"id": "gamma", "enabled": False, "order": 50,
                             "source": {"kind": "upload"},
                             "desired_version": 0, "versions": [],
                             "state": "pending", "description": ""})
        self.store.save(m)
        self.app.build()
        self.assertEqual(self.app.screen.current().key, "beta")


class TestGuardRails(AppCase):
    def test_tree_ops_refuse_without_an_omlx_tree(self):
        self.ctx._tree_root_override = ""
        self.assertFalse(self.ctx.tree_root)
        self.app.goto("patches")
        # ops whose function takes a tree root must refuse, not ask: a write
        # aimed at an empty tree_root is worse than a refused keypress
        for key in ("c", "y"):
            self.app.pending = None
            self.app.on_key(key)
            self.assertFalse(self.app.pending, f"'{key}' opened a gate")
            self.assertIn("no omlx package tree", self.app.notice)
        # and the empty screen must name the real reason, not 'no patches'
        text = "\n".join(r.text() for r in self.app.screen.rows)
        self.assertIn("omlx package tree not found", text)
        self.assertNotIn("no patches stored", text)

    def test_the_kill_switch_still_works_with_no_omlx_tree(self):
        # TUI-1: the kill switch writes only the manifest and the sentinel, so
        # a machine that cannot see an omlx tree must NOT lose its rescue
        # command. Same rule as cmd_patches, in the same direction — if the
        # two surfaces disagreed here, the TUI would refuse a key whose own
        # status line advertises it.
        self.ctx._tree_root_override = ""
        self.app.goto("patches")
        self.app.on_key("K")
        self.assertTrue(self.app.awaiting_yes, "kill switch must still arm")
        self.app.on_key("yes:YES")
        self.assertTrue(self.settle())
        self.assertTrue(os.path.exists(self.store.sentinel_path))
        self.app.on_key("U")
        self.app.on_key("yes:YES")
        self.assertTrue(self.settle())
        self.assertFalse(os.path.exists(self.store.sentinel_path))

    def test_keg_ops_stay_available_without_a_tree(self):
        # a keg switch does not need the python tree — refusing it would hide
        # the rollback that fixes a broken patch state
        self.ctx._tree_root_override = ""
        self.app.goto("dev")
        self.assertTrue(any(o.key == "r" for o in
                            self.app.screen.screen_ops()))

    def test_one_action_at_a_time(self):
        self.select_patch("alpha")
        self.app.on_key("t")                      # read-only, starts a thread
        self.assertTrue(self.app.busy)
        self.app.on_key("d")
        self.assertFalse(self.app.pending,
                         "a second action queued while the first ran")
        self.assertIn("still running", self.app.notice)
        self.settle()

    def test_an_exception_in_an_op_reports_and_survives(self):
        def boom_run(ctx, row=None):
            raise RuntimeError("kaboom")

        boom = ops.Op("!", "explode", boom_run, (ops.PATCH,), ops.READ)
        self.app.goto("patches")
        self.app.screens["patches"].ops_pool = [boom]
        self.app.on_key("!")             # READ: runs at once, then raises
        self.assertTrue(self.settle(), "the worker never reported back")
        self.assertIn("FAILED", self.app.notice)
        self.assertIn("kaboom", "\n".join(self.ctx.log_lines()))
        self.assertTrue(self.app.running)

    def test_cancel_reports_the_truth_about_an_in_process_action(self):
        self.select_patch("alpha")
        self.app.on_key("t")
        self.assertIn("nothing to cancel", self.app.cancel())
        self.settle()

    def test_the_store_is_reread_between_actions(self):
        # another terminal (or the dashboard) may have changed everything
        self.app.goto("patches")
        self.assertEqual(len(self.app.screen.rows), 2)
        m = store_manifest()
        m["patches"].pop(0)
        self.store.save(m)
        self.app.last_build = 0.0
        self.app.refresh_if_stale()
        self.assertEqual(len(self.app.screen.rows), 1)


class TestActionsReachTheStore(AppCase):
    """End-to-end on a scratch store: each action must produce the same state
    change the CLI verb would, because it calls the same function."""

    def test_disable_then_enable_round_trip(self):
        self.select_patch("alpha")
        self.app.on_key("d")
        self.app.on_key("y")
        self.assertTrue(self.settle())
        self.assertFalse(self.enabled("alpha"))
        self.select_patch("alpha")
        self.app.on_key("e")
        self.app.on_key("y")
        self.assertTrue(self.settle())
        self.assertTrue(self.enabled("alpha"))

    def test_rollback_moves_desired_version_back_one(self):
        self.select_patch("alpha")
        self.app.on_key("v")
        self.app.on_key("y")
        self.assertTrue(self.settle())
        p = self.store.find(self.store.load(), "alpha")
        self.assertEqual(p["desired_version"], 1)
        self.assertEqual(p["state"], "pending")

    def test_kill_switch_arms_and_disarms_through_the_cli_verb(self):
        self.app.goto("patches")
        self.app.on_key("K")
        self.assertTrue(self.app.awaiting_yes)
        self.app.on_key("yes:YES")
        self.assertTrue(self.settle())
        self.assertTrue(os.path.exists(self.store.sentinel_path))
        self.assertFalse(self.enabled("alpha"))
        # enable-all restores exactly what the switch recorded
        self.app.on_key("U")
        self.app.on_key("yes:YES")
        self.assertTrue(self.settle())
        self.assertFalse(os.path.exists(self.store.sentinel_path))
        self.assertTrue(self.enabled("alpha"),
                        "enable-all must restore the flag disable-all stamped")

    def test_a_failed_action_is_reported_as_a_failure(self):
        self.select_patch("beta")               # no stored version at all
        self.app.on_key("v")
        self.app.on_key("y")
        self.assertTrue(self.settle())
        self.assertIn("FAILED", self.app.notice)
        self.assertIn("no previous version", "\n".join(self.ctx.log_lines()))

    def test_every_action_logs_the_command_it_mirrors(self):
        self.select_patch("alpha")
        self.app.on_key("d")
        self.app.on_key("y")
        self.settle()
        logged = "\n".join(self.ctx.log_lines())
        self.assertIn("omlx-uplift patch disable alpha", logged)


class TestThemeKey(AppCase):
    def test_T_cycles_and_persists(self):
        from omlx_uplift.tui import themes

        seen = []
        for _ in range(len(themes.names())):
            self.app.on_key("T")
            seen.append(self.app.theme_name)
        self.assertEqual(len(set(seen)), len(seen), "cycling repeated a theme")
        # one full pass returns to where we started: the first press moved OFF
        # the default, the last one landed back on it
        self.assertEqual(seen[-1], "default")
        self.assertEqual(themes.get_theme(), seen[-1],
                         "the choice must survive the session")
        # 'T' is advertised on every screen, not only where an op lists it
        self.app.goto("overview")
        text = "\n".join(t for t, _ in self.app.lines(140, 40))
        self.assertIn("[T] theme", text)

    def test_the_named_palette_is_reachable_in_one_pass(self):
        from omlx_uplift.tui import themes

        for _ in range(len(themes.names()) * 2):
            if self.app.theme_name == "p(doom)":
                break
            self.app.on_key("T")
        self.assertEqual(self.app.theme_name, "p(doom)")
        self.assertEqual(self.app.theme["title_prefix"], "SHODAN")
        self.app.on_key("1")
        self.assertIn("SHODAN ::", self.app.lines(120, 40)[0][0])


class TestRenderPath(AppCase):
    def test_frames_never_exceed_the_window(self):
        for key in ("1", "2", "3", "4", "5"):
            self.app.on_key(key)
            for height in (6, 12, 24, 40):
                self.assertLessEqual(len(self.app.lines(90, height)), height)

    def test_the_prompt_reaches_the_frame_with_its_target(self):
        self.select_patch("alpha")
        self.app.on_key("x")
        text = "\n".join(t for t, _ in self.app.lines(120, 30))
        self.assertIn("REMOVE PATCH", text)
        self.assertIn("'alpha'", text)
        self.assertIn("type YES", text)


if __name__ == "__main__":
    unittest.main()
