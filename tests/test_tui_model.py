"""TUI-1 model: screens built from live state, and the frame-fit contract.

The render() guarantees are what make the curses layer safe: a line wider than
the terminal makes curses wrap the frame, and a frame taller than the window
makes addstr throw mid-paint. Both are asserted here across an exhaustive size
sweep, so a future column or footer change cannot ship a screen that breaks on
a small window.

Flag-driven marks (! held, K keg-changed) are tested on _patch_row rather than
through build_patches: patchsource.view() COMPUTES those two from the store
and the live keg, so a manifest fixture cannot stage them.
"""
import os
import shutil
import tempfile
import unittest

from omlx_uplift import patches
from omlx_uplift.tui import model, ops
from omlx_uplift.tui.context import Context

VERSIONS = [{"v": 1, "content_sha256": "a", "fetched_at": "2026-10-01T09:00"},
            {"v": 2, "content_sha256": "b", "fetched_at": "2026-10-02T09:00"},
            {"v": 3, "content_sha256": "c", "fetched_at": "2026-10-03T09:00"}]


def manifest():
    return {"patches": [
        {"id": "pr4320-web-split", "enabled": True, "order": 100,
         "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 4320},
         "desired_version": 3, "versions": VERSIONS, "state": "applied",
         "state_detail": "", "curated": "default",
         "description": "web: serve the split app bundle from the host"},
        {"id": "tq-posids", "enabled": False, "order": 100,
         "source": {"kind": "url", "url": "https://x/y/tq.diff"},
         "desired_version": 2, "versions": VERSIONS, "state": "needs_review",
         "state_detail": "3 hunks failed",
         "description": "turboquant: fix position ids for ndim=3 caches"},
        {"id": "revert-ane", "enabled": True, "order": 110, "reversal": True,
         "source": {"kind": "upload"}, "desired_version": 1,
         "versions": VERSIONS, "state": "pending",
         "description": "reverts the ANE offload that regressed prefill"},
    ]}


class FakeKegstash:
    """Stands in for kegstash so the dev screen's row shape is pinned without
    a real Homebrew Cellar."""

    def __init__(self, rows, active):
        self.rows = rows
        self.active = active

    def list_stashes(self, *a, **k):
        return [dict(r) for r in self.rows]

    def active_keg(self, *a, **k):
        return self.active


class ModelTestCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tui-model-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        self.store = patches.PatchStore()
        self.store.save(manifest())
        self.ctx = Context(store=self.store, tree_root="/fake/site-packages")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)


class TestPatchScreen(ModelTestCase):
    def test_one_row_per_stored_patch(self):
        s = model.build_patches(self.ctx)
        self.assertEqual([r.kind for r in s.rows], [ops.PATCH] * 3)
        self.assertEqual([r.key for r in s.rows],
                         ["pr4320-web-split", "tq-posids", "revert-ane"])

    def test_state_enabled_scope_version_and_id_are_all_visible(self):
        text = model.build_patches(self.ctx).rows[1].text()
        for wanted in ("off", "needs_review", "v2", "tq-posids"):
            self.assertIn(wanted, text)

    def test_bundled_and_reversal_marks_render_on_a_real_screen(self):
        rows = {r.key: r for r in model.build_patches(self.ctx).rows}
        self.assertEqual(rows["pr4320-web-split"].cols[0][0].strip(), "B")
        self.assertEqual(rows["revert-ane"].cols[0][0].strip(), "R")
        self.assertEqual(rows["tq-posids"].cols[0][0].strip(), ".")

    def test_detail_describes_the_source_and_the_state_detail(self):
        detail = model.build_patches(self.ctx).rows[0].detail
        self.assertIn("PR jundot/omlx/#4320", detail)
        self.assertIn("bundled (default)", detail)
        self.assertIn("3 stored", model.build_patches(self.ctx).rows[1].detail)

    def test_kill_switch_arms_a_warning_line(self):
        with open(self.store.sentinel_path, "w") as fh:
            fh.write("x")
        s = model.build_patches(self.ctx)
        self.assertTrue(any("KILL SWITCH ARMED" in t for t, _ in s.footer))

    def test_empty_store_says_so_and_points_at_the_catalog(self):
        self.store.save({"patches": []})
        s = model.build_patches(self.ctx)
        self.assertEqual(len(s.rows), 1)
        self.assertEqual(s.rows[0].kind, "empty")
        self.assertIn("catalog", s.rows[0].text())

    def test_screen_ops_and_row_ops_are_both_offered(self):
        s = model.build_patches(self.ctx)
        self.assertEqual([o.key for o in s.screen_ops()], ["c", "y", "K", "U"])
        self.assertIn("e", [o.key for o in s.row_ops()])

    def test_a_patch_row_never_offers_a_keg_action(self):
        labels = " ".join(o.label
                          for o in model.build_patches(self.ctx).row_ops())
        self.assertNotIn("activate", labels)


class TestRowMarks(unittest.TestCase):
    """_patch_row is the unit that turns flags into the column of marks."""

    def test_each_flag_has_its_letter(self):
        cases = (
            ({"requires_approval": True}, "!"),
            ({"curated": "optional"}, "B"),
            ({"reversal": True}, "R"),
            ({"keg_changed": True}, "K"),
            ({"requires_approval": True, "keg_changed": True}, "!K"),
            ({}, "."),
        )
        for flags, want in cases:
            row = model._patch_row(dict(id="x", **flags), ops.PATCH)
            self.assertEqual(row.cols[0][0].strip(), want, str(flags))

    def test_a_held_patch_is_warned_in_both_the_row_and_the_detail(self):
        row = model._patch_row({"id": "x", "requires_approval": True},
                               ops.PATCH)
        self.assertEqual(row.cols[0][1], model.TONE_WARN)
        self.assertIn("HELD", row.detail)
        self.assertIn("omlx-uplift patch approve x", row.detail,
                      "the screen must name the way out, not just the block")

    def test_missing_desired_version_does_not_print_none(self):
        row = model._patch_row({"id": "x"}, ops.CATALOG)
        self.assertNotIn("None", row.text())


class TestDevScreen(ModelTestCase):
    def test_missing_dev_config_is_reported_not_raised(self):
        self.assertIn("bootstrap", model.build_dev(self.ctx).rows[0].text())

    def test_stashes_are_listed_and_the_active_one_is_marked(self):
        self.ctx.kegstash = FakeKegstash(
            [{"name": "HEAD-aaa_1", "cellar_name": "HEAD-aaa",
              "stashed_at": "2026-10-09T15:22:44", "bytes": 2 * 2 ** 30,
              "method": "clone", "path": "/x/HEAD-aaa"},
             {"name": "HEAD-bbb_1", "cellar_name": "HEAD-bbb",
              "stashed_at": "2026-10-08T09:00:00", "bytes": 2 ** 30,
              "method": "move", "path": "/x/HEAD-bbb"}], active="HEAD-bbb")
        s = model.build_dev(self.ctx)
        kegs = [r for r in s.rows if r.kind == ops.KEG]
        self.assertEqual([r.key for r in kegs],
                         ["HEAD-aaa_1", "HEAD-bbb_1"])
        self.assertIn("2.0 GiB", kegs[0].text())
        self.assertTrue(kegs[1].text().startswith(">"),
                        "the active keg carries the selection marker")
        self.assertIn("ACTIVE", kegs[1].detail)

    def test_two_builds_sharing_a_cellar_are_flagged(self):
        # DEV-13: stash names now carry a time suffix but can map to ONE
        # Cellar address — prune and activate both depend on that
        rows = [{"name": "HEAD-aaa_1", "cellar_name": "HEAD-aaa",
                 "stashed_at": "2026-10-09", "bytes": 0, "path": "/1"},
                {"name": "HEAD-aaa_2", "cellar_name": "HEAD-aaa",
                 "stashed_at": "2026-10-08", "bytes": 0, "path": "/2"}]
        self.ctx.kegstash = FakeKegstash(rows, active=None)
        s = model.build_dev(self.ctx)
        self.assertTrue(all("share this Cellar address" in r.detail
                            for r in s.rows if r.kind == ops.KEG))

    def test_drift_from_the_carrier_is_shown_as_its_own_row(self):
        # devsrc.drift_check returns {drift: bool, detail: 'a; b'}
        self.ctx.dev_summary = lambda: {
            "installed": True, "branch": "uplift-dev", "tip": "a" * 40,
            "base": "b" * 40, "sync_ref": "upstream/main", "base_pin": None,
            "ahead": 1, "behind": 0, "patch_commits": [], "drift": [
                "touched outside the patch set (hand commit?): omlx/x.py"],
            "drift_note": "1 drift line(s)", "auto_update": False,
            "auto_note": "manual", "detail": ["carrier branch: uplift-dev"]}
        s = model.build_dev(self.ctx)
        self.assertTrue(any("DRIFT" in r.text() and "hand commit" in r.text()
                            for r in s.rows))

    def test_keg_screen_offers_its_verbs(self):
        self.assertEqual({o.key for o in model.build_dev(self.ctx)
                          .screen_ops()}, {"t", "r", "z", "b", "f"})


class TestOverview(ModelTestCase):
    def test_counts_roll_up_the_store(self):
        text = model.build_overview(self.ctx).rows[0].text()
        for wanted in ("3 total", "2 enabled", "0 held", "1 to review"):
            self.assertIn(wanted, text)

    def test_service_rows_are_restartable(self):
        s = model.build_overview(self.ctx)
        svc = [r for r in s.rows if r.kind == ops.SERVER]
        self.assertEqual([r.key for r in svc], ["omlx", "omlx-dev"])
        s.selected = s.rows.index(svc[0])
        self.assertEqual([o.key for o in s.row_ops()], ["s"])


class TestCatalogScreen(ModelTestCase):
    def test_offline_catalog_says_so_without_losing_the_screen(self):
        self.ctx.catalog = lambda: {"ok": False, "tiers": {},
                                    "reason": "no route to github"}
        s = model.build_catalog(self.ctx)
        self.assertIn("no route to github", s.rows[0].text())
        self.assertIn("untouched", s.rows[0].detail)

    def test_installed_entries_are_marked_and_named_by_their_store_id(self):
        self.ctx.catalog = lambda: {
            "ok": True,
            "tiers": {"default": [
                {"id": "slug-a", "under_id": "legacy-id", "installed": True,
                 "description": "d", "source": {"kind": "file"}, "scope": "omlx",
                 "source_ok": True, "adopted": False},
                {"id": "slug-b", "installed": False, "description": "e",
                 "source": {"kind": "github_pr", "repo": "jundot/omlx",
                            "pr": 1}, "scope": "omlx", "source_ok": True}]},
            "errors": {}}
        rows = [r for r in model.build_catalog(self.ctx).rows
                if r.kind == ops.CATALOG]
        self.assertIn("legacy-id", rows[0].text())
        self.assertIn("already in the store", rows[0].detail)
        self.assertIn("press i", rows[1].detail)

    def test_an_incomplete_manifest_is_flagged_as_uninstallable(self):
        self.ctx.catalog = lambda: {
            "ok": True, "errors": {}, "tiers": {"optional": [
                {"id": "bad", "installed": False, "description": "",
                 "source": None, "source_ok": False}]}}
        rows = [r for r in model.build_catalog(self.ctx).rows
                if r.kind == ops.CATALOG]
        self.assertIn("INCOMPLETE", rows[0].detail)


class TestFrameFits(ModelTestCase):
    """render() must never overflow the window in either axis."""

    def prompts(self):
        return {
            "none": "",
            "write": model.confirm_prompt(ops.find("d", ops.PATCH_ROW_OPS),
                                          {"id": "tq-posids"}),
            "high": model.confirm_prompt(ops.find("x", ops.PATCH_ROW_OPS),
                                         {"id": "tq-posids"}),
        }

    def test_no_frame_is_taller_or_wider_than_the_window(self):
        checked = 0
        for name in model.BUILDERS:
            s = model.BUILDERS[name](self.ctx)
            for sel in (0, min(1, len(s.rows) - 1), len(s.rows) - 1):
                s.selected = sel
                for height in range(1, 40):
                    for width in (40, 60, 100, 220):
                        for prompt in self.prompts().values():
                            for yes in (None, "YE"):
                                for busy in ("", "dev install (build)"):
                                    lines = model.render(
                                        s, width, prompt=prompt, busy=busy,
                                        height=height, yes_line=yes)
                                    checked += 1
                                    self.assertLessEqual(
                                        len(lines), height,
                                        f"{name} sel={sel} {width}x{height} "
                                        f"prompt={bool(prompt)} "
                                        f"yes={yes!r} -> {len(lines)} lines")
                                    for text, _tone in lines:
                                        self.assertLessEqual(
                                            len(text), width,
                                            f"{name} {width}x{height}: "
                                            f"line too wide: {text!r}")
        self.assertGreater(checked, 4000)

    def test_the_key_bar_survives_a_six_line_window(self):
        text = "\n".join(t for t, _ in model.render(
            model.build_patches(self.ctx), 90, height=6))
        self.assertIn("[q] quit", text)

    def test_a_live_question_survives_a_small_window(self):
        # answering YES to 'remove patch' without reading the question would
        # be the worst failure this UI can have
        s = model.build_patches(self.ctx)
        prompt = model.confirm_prompt(ops.find("x", ops.PATCH_ROW_OPS),
                                      {"id": "tq-posids"})
        for height in (6, 8, 10):
            text = "\n".join(t for t, _ in model.render(
                s, 100, prompt=prompt, yes_line="", height=height))
            self.assertIn("REMOVE PATCH", text, f"h={height}")
            self.assertIn("patch remove tq-posids", text, f"h={height}")

    def test_a_cut_pane_says_how_much_it_cut(self):
        s = model.build_patches(self.ctx)
        for r in s.rows:
            r.detail = "\n".join(f"line {i}" for i in range(40))
        lines = [t for t, _ in model.render(s, 100, height=14)]
        self.assertTrue(any("more detail line(s)" in l for l in lines))

    def test_no_room_for_rows_still_names_the_hidden_count(self):
        s = model.build_patches(self.ctx)
        prompt = model.confirm_prompt(ops.find("x", ops.PATCH_ROW_OPS),
                                      {"id": "x"})
        lines = [t for t, _ in model.render(s, 120, prompt=prompt, height=5)]
        self.assertTrue(any("row(s)" in l and ("hidden" in l or "+" in l)
                            for l in lines),
                        "rows must never vanish without a trace")

    def test_tones_always_come_from_the_documented_set(self):
        # a typo'd tone paints as plain text and silently loses its signal
        vocab = set(model.TONES) | {None}
        for name in model.BUILDERS:
            scr = model.BUILDERS[name](self.ctx)
            for _t, tone in model.render(scr, 100, height=40):
                self.assertIn(tone, vocab, f"{name} emitted {tone!r}")

    def test_the_selected_row_keeps_its_marker_after_a_shrink(self):
        s = model.build_patches(self.ctx)
        s.selected = 2
        self.assertTrue(any(t.startswith(">") for t, _
                            in model.render(s, 100, height=30)))
        self.assertTrue(any(t.startswith(">") for t, _
                            in model.render(s, 100, height=6)))


class TestKeymap(unittest.TestCase):
    def make(self):
        rows = [model.Row(ops.PATCH, "p1", [("p1", None)], "detail")]
        return model.Screen("t", "t", rows, [],
                            ops.PATCH_ROW_OPS + ops.PATCH_SCREEN_OPS)

    def test_navigation_keys_are_never_claimed_by_an_op(self):
        s = self.make()
        keys = [k for k, _ in s.keymap()]
        self.assertFalse(set(keys) & {"1", "2", "3", "4", "5", "j", "k", "n",
                                      "q", "?"})

    def test_a_key_appears_once_even_when_row_and_screen_both_bind_it(self):
        # 'c' is check on this screen; if a row ever bound 'c' too, the bar
        # must show one entry, not two meanings for one keystroke
        s = self.make()
        keys = [k for k, _ in s.keymap()]
        self.assertEqual(len(keys), len(set(keys)))

    def test_keybar_lists_the_row_actions_then_the_screen_actions(self):
        s = self.make()
        labels = [v for _k, v in s.keymap()]
        self.assertIn("enable", labels)
        self.assertIn("kill switch ON", labels)


class TestConfirmPrompt(unittest.TestCase):
    def test_write_prompt_asks_for_y_and_shows_the_command(self):
        text = model.confirm_prompt(ops.find("d", ops.PATCH_ROW_OPS),
                                    {"id": "p1"})
        self.assertIn("press y to run", text)
        self.assertIn("omlx-uplift patch disable p1", text)

    def test_high_prompt_demands_yes_and_carries_the_hint(self):
        op = ops.find("x", ops.PATCH_ROW_OPS)
        text = model.confirm_prompt(op, {"id": "p1"})
        self.assertIn("type YES", text)
        self.assertIn("restores pristine files", text)

    def test_screen_level_prompt_names_the_screen_not_a_row(self):
        text = model.confirm_prompt(ops.find("K", ops.PATCH_SCREEN_OPS), None)
        self.assertIn("this screen", text)
        self.assertIn("omlx-uplift patch disable-all", text)

    def test_every_op_prompt_names_its_own_target(self):
        for op in ops.ALL_OPS:
            text = model.confirm_prompt(op, {"id": "p1", "name": "HEAD-1",
                                             "formula": "omlx"})
            self.assertIn(op.label.upper().split("(")[0].strip().split()[0],
                          text.upper(), op.label)


class TestResultLines(unittest.TestCase):
    def test_ok_and_failure_are_distinguishable(self):
        self.assertTrue(model.result_lines({"ok": True,
                                            "state": "pending"})[0]
                        .startswith("OK"))
        line = model.result_lines({"ok": False, "reason": "drift"})[0]
        self.assertTrue(line.startswith("FAILED"))
        self.assertIn("drift", line)

    def test_a_cancelled_op_says_nothing_changed(self):
        self.assertIn("nothing changed", model.result_lines(None)[0])

    def test_lists_are_summarised_not_dumped(self):
        line = model.result_lines({"ok": True,
                                   "removed": ["a", "b", "c"]})[0]
        self.assertIn("a, b, c", line)
        self.assertLess(len(line), 200)

    def test_a_bare_ok_still_prints_something(self):
        self.assertTrue(model.result_lines({"ok": True})[0])


if __name__ == "__main__":
    unittest.main()
