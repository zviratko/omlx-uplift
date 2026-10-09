"""TUI-3 MC shell: the menu spec and the frame layout, pinned.

frame.render() is safety-critical the same way model.render() was: curses
corrupts a screen the moment a line overflows the terminal, so the width and
height guarantees get a full sweep here. The menu spec gets contract tests
because it is the bridge between 'what the operator sees in a dropdown' and
'which existing ops.Op actually runs' — accelerators must be unique, every
row command must carry a REAL op, and a greyed command must carry a reason.
"""
import os
import shutil
import tempfile
import unittest

from omlx_uplift import patches
from omlx_uplift.tui import frame, menus, model, ops
from omlx_uplift.tui.context import Context


def manifest():
    return {"patches": [
        {"id": "alpha", "enabled": True, "order": 100,
         "source": {"kind": "url", "url": "http://x/alpha.diff"},
         "desired_version": 2,
         "versions": [{"v": 1, "fetched_at": "2026-10-01T00:00"},
                      {"v": 2, "fetched_at": "2026-10-05T00:00"}],
         "state": "applied", "state_detail": "", "description": "alpha"},
        {"id": "beta", "enabled": False, "order": 200,
         "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 42},
         "desired_version": 0, "versions": [], "state": "disabled",
         "state_detail": "", "description": "beta"},
    ]}


class Env:
    """menus.build() reads this; enough to stand in for App headlessly."""

    def __init__(self, ctx, current="patches", row=None):
        self.current = current
        self.tree_root = ctx.tree_root
        self.detail_open = True
        self.footer_open = True
        self.theme_name = "default"
        self.kill_switch = False
        self._row = row

    def row_for(self, panel):
        return self._row if panel == self.current else None


class MenuSpec(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tui-menus-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        self.store = patches.PatchStore()
        self.store.save(manifest())
        self.ctx = Context(store=self.store, tree_root="/fake/tree")
        self.row = model.build_patches(self.ctx).current()
        self.ms = menus.build(Env(self.ctx, row=self.row))

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)

    def names(self):
        return [m.name for m in self.ms]

    def test_the_bar_covers_every_area(self):
        for wanted in ("Go", "Patches", "Catalog", "Keg", "Services",
                       "View", "Help"):
            self.assertIn(wanted, self.names())

    def test_bar_accels_are_unique(self):
        accels = [m.accel for m in self.ms]
        self.assertEqual(len(accels), len(set(accels)),
                         "Alt+letter could open two menus")

    def test_item_accels_are_unique_inside_every_dropdown(self):
        def check(items, where):
            used = set()
            for it in items:
                if isinstance(it, str):
                    continue
                if it.kind == "sub":
                    check(it.payload, where + ">" + it.label)
                    continue
                if it.accel:
                    # case-SENSITIVE: 'u' (update) and 'U' (kill OFF) are
                    # different commands and the App dispatches exact-case
                    # first — but two identical letters are a real bug
                    self.assertNotIn(
                        it.accel, used,
                        f"duplicate accelerator '{it.accel}' in {where}")
                    used.add(it.accel)
        for m in self.ms:
            check(m.items, m.name)

    def test_every_op_item_carries_a_real_op(self):
        for m in self.ms:
            for it in m.items:
                if isinstance(it, str) or it.kind != "op":
                    continue
                self.assertIsInstance(it.payload, ops.Op)
                self.assertIn(it.payload, ops.ALL_OPS,
                              "menus must reuse the shipped op objects, "
                              "not clones with policy of their own")

    def test_row_commands_carry_the_right_row(self):
        pm = [m for m in self.ms if m.name == "Patches"][0]
        row_items = [i for i in pm.items
                     if not isinstance(i, str) and i.kind == "op"
                     and i.payload.row_kinds not in (None, ops.ANY)]
        self.assertTrue(row_items)
        for it in row_items:
            self.assertIsNotNone(it.target,
                                 "a row command must carry its row")
            self.assertIsInstance(it.target, model.Row)
            self.assertEqual((it.target.raw or {}).get("id"),
                             self.row.raw.get("id"))

    def test_a_command_that_cannot_run_shows_its_reason(self):
        # no omlx tree: tree-bound commands grey out WITH a reason; the kill
        # switch stays live (store-only — the rescue path never greys)
        env = Env(self.ctx, row=self.row)
        env.tree_root = None
        ms = menus.build(env)
        pm = [m for m in ms if m.name == "Patches"][0]
        gated = [i for i in pm.items if not isinstance(i, str)
                 and not i.enabled]
        self.assertTrue(gated)
        for it in gated:
            self.assertTrue(it.reason, f"'{it.label}' greyed without a why")
        live = [i for i in pm.items if not isinstance(i, str)
                and "Kill switch" in i.label]
        self.assertTrue(all(i.enabled for i in live),
                        "the kill switch answers even with no tree")

    def test_u_and_capital_u_are_different_commands(self):
        # 'u' update and 'U' kill-switch-OFF share a letter on the panels;
        # the dropdown keeps BOTH (case-sensitive dispatch), so it must
        # never silently rewrite one into the other
        pm = [m for m in self.ms if m.name == "Patches"][0]
        accels = {i.accel for i in pm.items if not isinstance(i, str)}
        self.assertIn("u", accels)
        self.assertIn("U", accels)

    def test_go_menu_names_every_panel(self):
        go = [m for m in self.ms if m.name == "Go"][0]
        panels = [i.payload for i in go.items
                  if not isinstance(i, str) and i.kind == "panel"]
        self.assertEqual(panels, list(menus.PANEL_NAMES))
        # current panel is 'patches' — the second entry carries the mark
        self.assertEqual([i.checked for i in go.items
                          if not isinstance(i, str) and i.kind == "panel"],
                         [False, True, False, False, False],
                         "the current panel shows where you are")


class FrameSweep(unittest.TestCase):
    """The two guarantees: never wider than width-1, never taller than
    height — across menus open, questions pending, tiny and huge windows."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tui-frame-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        self.store = patches.PatchStore()
        self.store.save(manifest())
        self.ctx = Context(store=self.store, tree_root="/fake/tree")
        self.screen = model.build_patches(self.ctx)
        self.ms = menus.build(Env(self.ctx, row=self.screen.current()))

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)

    def _frames(self, **kw):
        for width in (40, 60, 80, 100, 120, 160, 210):
            for height in (6, 10, 14, 24, 30, 50):
                for open_menu in (None, 0, 1, 3):
                    yield dict(width=width, height=height,
                               bar_open=open_menu is not None,
                               bar_index=open_menu or 0,
                               items=(self.ms[open_menu].items
                                      if open_menu is not None else None),
                               **kw)

    def test_no_frame_breaches_the_window(self):
        for kw in self._frames(detail="some detail text " * 8,
                               footers=self.screen.footer,
                               notice="theme default 80x24"):
            f = frame.render_frame(self.screen, menus=self.ms, **kw)
            w, h = kw["width"], kw["height"]
            self.assertLessEqual(len(f.lines), h,
                                 f"too tall at {w}x{h}")
            for ln in f.lines:
                self.assertLessEqual(frame.line_len(ln), w - 1,
                                     f"too wide at {w}x{h}: "
                                     f"{frame.line_text(ln)!r}")

    def test_open_dropdowns_reach_the_sweep(self):
        # guard against the generator silently skipping the open state
        seen = [kw for kw in self._frames(detail="x") if kw["bar_open"]]
        self.assertTrue(seen)

    def test_a_dropdown_never_overwrites_the_footer_or_the_prompt(self):
        for width in (40, 80, 120):
            for height in (10, 16, 24, 40):
                f = frame.render_frame(
                    self.screen, menus=self.ms, bar_index=1, bar_open=True,
                    items=self.ms[1].items, item_cursor=0,
                    detail="d" * 200, width=width, height=height,
                    prompt="REMOVE PATCH 'alpha' — this cannot be undone")
                text = "\n".join(frame.line_text(l) for l in f.lines)
                self.assertIn("F1 help", text,
                              "the legend must survive an open dropdown")
                self.assertIn("REMOVE PATCH", text,
                              "a live question must survive an open dropdown")

    def test_hits_are_ordered_topmost_first(self):
        # clicking a dropdown row that happens to cover a panel row must hit
        # the item, never the row underneath: App.click takes the FIRST hit
        f = frame.render_frame(self.screen, menus=self.ms, bar_index=1,
                               bar_open=True, items=self.ms[1].items,
                               detail="x", width=120, height=30)
        first_item = min((h for h in f.hits if h[4][0] == "item"),
                         key=lambda h: h[2])
        for h in f.hits:
            if h[4][0] != "row":
                continue
            overlap_x = (h[0] <= first_item[1] and first_item[0] <= h[1])
            overlap_y = h[2] == first_item[2]
            if overlap_x and overlap_y:
                self.assertLess(f.hits.index(first_item), f.hits.index(h),
                                f"{h[4]} shadows {first_item[4]}")

    def test_only_painted_rows_get_hits(self):
        # 2-row store in a box with padding: padding lines must not select
        f = frame.render_frame(self.screen, menus=self.ms, width=100,
                               height=40)
        rows = [h[4][1] for h in f.hits if h[4][0] == "row"]
        self.assertLessEqual(max(rows) if rows else 0,
                             len(self.screen.rows) - 1)
        first, last = self.screen.shown
        for idx in set(rows):
            self.assertTrue(first <= idx < last)

    def test_separator_lines_stay_inside_their_box(self):
        f = frame.render_frame(self.screen, menus=self.ms, bar_index=1,
                               bar_open=True, items=self.ms[1].items,
                               width=120, height=40)
        # every body line that renders a divider must start with the box
        # vertical — no free-floating '│┤───├│' fragments past the overlay
        for ln in f.lines[1:]:
            text = frame.line_text(ln)
            self.assertNotIn("───┤", text[1:],
                             "a separator escaped its dropdown")

    def test_narrow_without_detail_gives_rows_the_full_height(self):
        f = frame.render_frame(self.screen, menus=self.ms, detail=None,
                               width=80, height=24)
        text = "\n".join(frame.line_text(l) for l in f.lines)
        self.assertNotIn("Details", text)
        self.assertIn("alpha", text)

    def test_wide_puts_the_details_alongside(self):
        f = frame.render_frame(self.screen, menus=self.ms,
                               detail="source:   url http://x/alpha.diff",
                               width=140, height=30)
        self.assertIn("Details", frame.line_text(f.lines[1]))

    def test_ascii_fallback_when_utf8_is_off(self):
        f = frame.render_frame(self.screen, menus=self.ms, width=90,
                               height=20, utf8=False)
        text = "\n".join(frame.line_text(l) for l in f.lines)
        self.assertIn("+--", text)
        self.assertNotIn("─", text)


if __name__ == "__main__":
    unittest.main()
