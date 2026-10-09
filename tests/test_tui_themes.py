"""TUI-1 themes: palette selection, the curses colour bridge, persistence.

The bridge is driven with plain callables (alloc_pair / init_color) instead of
curses, so this runs headless — including on CI, which has no terminal.
"""
import os
import unittest

from omlx_uplift.tui import themes


class FakeTerminal:
    """Enough curses surface to exercise palette(): counts pair allocations
    and records which colour numbers each pair got."""

    def __init__(self, max_colors=256, can_change=True, n_pairs=64):
        self.max_colors = max_colors
        self.can_change = can_change
        self.n_pairs = n_pairs
        self.pairs = []               # (pair_no, fg, bg)
        self.colors = {}              # idx -> (r,g,b) written by init_color
        self._next = 0

    def alloc_pair(self, fg, bg):
        self._next += 1
        if self._next > self.n_pairs - 1:
            raise AssertionError("allocated more pairs than the terminal has")
        self.pairs.append((self._next, fg, bg))
        return 1 << (8 + self._next)          # a distinctive fake attribute

    def init_color(self, idx, r, g, b):
        if not self.can_change:
            raise curses_error()
        self.colors[idx] = (r, g, b)


class curses_error(Exception):
    pass


BOLD, REVERSE = 1, 2


def build(name, term):
    return themes.palette(
        name, term.max_colors, can_change=term.can_change,
        alloc_pair=term.alloc_pair,
        init_color=(term.init_color if term.can_change else None),
        n_pairs=term.n_pairs, bold_attr=BOLD, reverse_attr=REVERSE)


class TestCatalog(unittest.TestCase):
    def test_pdoom_is_reachable_by_several_names(self):
        # the user asked for the theme by name; aliases are the friendly path
        for word in ("p(doom)", "P(DOOM)", "shodan", "doom", "pd"):
            self.assertEqual(themes.norm(word), "p(doom)", word)

    def test_unknown_theme_falls_back_to_default(self):
        self.assertEqual(themes.norm("nonsense"), "default")
        self.assertEqual(themes.norm(None), "default")

    def test_every_theme_covers_every_tone(self):
        for name, th in themes.THEMES.items():
            missing = set(themes.TONES) - set(th["tones"])
            self.assertFalse(missing, f"{name} has no spec for {missing}")

    def test_describe_mentions_the_palette_origin(self):
        self.assertIn("SHODAN", themes.describe("p(doom)"))


class TestBridge(unittest.TestCase):
    def test_256_terminal_gets_exact_rgb(self):
        term = FakeTerminal(max_colors=256, can_change=True)
        attrs, info = build("p(doom)", term)
        self.assertEqual(info["mode"], "256")
        self.assertEqual(info["note"], "exact RGB")
        # crimson was written into a free slot (>=16), in 0..1000 units
        rgb = {v for v in term.colors.values()}
        self.assertIn(tuple(round(c * 1000 / 255) for c in (0xFF, 0x41, 0x36)),
                      rgb)

    def test_terminal_without_colour_control_approximates(self):
        term = FakeTerminal(max_colors=256, can_change=False)
        _, info = build("p(doom)", term)
        self.assertEqual(info["note"], "xterm-256 approximation")
        self.assertEqual(term.colors, {}, "must not touch the palette")

    def test_16_colour_terminal_uses_basic_indices_only(self):
        term = FakeTerminal(max_colors=8, can_change=True)
        attrs, info = build("p(doom)", term)
        self.assertEqual(info["mode"], "16")
        self.assertEqual(term.colors, {})
        for _no, fg, bg in term.pairs:
            for value in (fg, bg):
                self.assertTrue(value == -1 or 0 <= value <= 15,
                                f"index {value} out of the basic range")

    def test_default_theme_keeps_named_basic_colours(self):
        # 'default' means "use the terminal's own GREEN/RED", so it must never
        # re-mix an exact RGB slot even on a 256-colour terminal
        term = FakeTerminal(max_colors=256, can_change=True)
        build("default", term)
        self.assertEqual(term.colors, {})
        for _no, fg, _bg in term.pairs:
            self.assertTrue(fg == -1 or 0 <= fg <= 15)

    def test_mono_theme_uses_no_pairs(self):
        term = FakeTerminal()
        attrs, info = build("mono", term)
        self.assertEqual(info["mode"], "mono")
        self.assertEqual(term.pairs, [])
        self.assertTrue(attrs["sel"] & REVERSE or attrs["title"] & BOLD)

    def test_pair_count_never_exceeds_the_terminal(self):
        for n in (8, 16, 64):
            term = FakeTerminal(n_pairs=n)
            _attrs, info = build("p(doom)", term)
            self.assertLessEqual(info["pairs"], n - 1, f"n_pairs={n}")

    def test_only_a_theme_with_its_own_bg_repaints_the_ground(self):
        # bkgd() paints every cell a line does not cover. If the ground came
        # from a tone, the default theme would tint the whole screen with
        # that tone's colour — exactly the behaviour it promises not to have.
        _attrs, info = build("default", FakeTerminal(max_colors=256))
        self.assertEqual(info["ground"], 0)
        _attrs, info = build("p(doom)", FakeTerminal(max_colors=256))
        self.assertNotEqual(info["ground"], 0)
        _attrs, info = build("mono", FakeTerminal(max_colors=256))
        self.assertEqual(info["ground"], 0)

    def test_the_note_says_what_was_actually_delivered(self):
        # a status line that claims a loss which did not happen would erode
        # trust in the one place the operator checks for colour fidelity
        cases = {
            ("default", 256, True): "terminal\'s own colours",
            ("default", 8, True): "16 basic colours",
            ("p(doom)", 256, True): "exact RGB",
            ("p(doom)", 256, False): "xterm-256 approximation",
            ("mono", 256, True): "bold/reverse only",
        }
        for (name, colors, can_change), want in cases.items():
            term = FakeTerminal(max_colors=colors, can_change=can_change)
            _attrs, info = build(name, term)
            self.assertEqual(info["note"], want,
                             f"{name} on {colors} colours "
                             f"(can_change={can_change})")

    def test_bold_survives_a_degraded_terminal(self):
        term = FakeTerminal(max_colors=8, can_change=False)
        attrs, _info = build("p(doom)", term)
        self.assertTrue(attrs["bad"] & BOLD)
        self.assertTrue(attrs["title"] & BOLD)


class TestColourMath(unittest.TestCase):
    def test_cube_lookup_round_trips_its_own_rgb(self):
        idx = themes.cube_index((0xFF, 0x41, 0x36))
        near = themes.xterm256_rgb(idx)
        self.assertTrue(all(abs(a - b) < 60 for a, b in
                            zip(near, (0xFF, 0x41, 0x36))), near)

    def test_grey_ramp_beats_the_cube_for_neutral_greys(self):
        self.assertEqual(themes.color_index((128, 128, 128), "256"),
                         themes.gray_index((128, 128, 128)))

    def test_basic_index_picks_the_nearest_named_colour(self):
        # plain distance, so a saturated red lands on the SGR RED (170,0,0),
        # not bright red (255,85,85) — bright red is further away in RGB.
        # Documented here because "nearest" is not what a person would guess.
        self.assertEqual(themes.basic_index((255, 0, 0)), 1)
        self.assertEqual(themes.basic_index((255, 255, 255)), 15)
        self.assertEqual(themes.basic_index((0, 0, 0)), 0)

    def test_hex_forms(self):
        self.assertEqual(themes.resolve("#abc"), (0xAA, 0xBB, 0xCC))
        self.assertEqual(themes.resolve("#aabbcc"), (0xAA, 0xBB, 0xCC))
        self.assertIsNone(themes.resolve("green"))
        self.assertIsNone(themes.resolve("#xyz"))


class TestPersistence(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.home = tempfile.mkdtemp(prefix="tui-theme-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home

    def tearDown(self):
        import shutil
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self.home, ignore_errors=True)

    def test_round_trip(self):
        self.assertEqual(themes.get_theme(), "default")
        self.assertEqual(themes.set_theme("P(DOOM)"), "p(doom)")
        self.assertEqual(themes.get_theme(), "p(doom)")
        with open(themes.config_path()) as fh:
            self.assertIn("p(doom)", fh.read())

    def test_other_keys_survive_a_theme_write(self):
        themes.save({"qa_marker": 1})
        themes.set_theme("mono")
        self.assertEqual(themes.load().get("qa_marker"), 1)

    def test_broken_file_is_not_an_error(self):
        path = themes.config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("{not json")
        self.assertEqual(themes.load(), {})
        self.assertEqual(themes.get_theme(), "default")

    def test_prefs_live_outside_the_patch_manifest(self):
        # patches.json carries approvals and desired versions; a cosmetic
        # preference must not be written into it
        themes.set_theme("p(doom)")
        self.assertTrue(os.path.exists(themes.config_path()))
        self.assertFalse(os.path.exists(os.path.join(self.home,
                                                     "patches.json")),
                         "theme prefs must not touch the patch manifest")


if __name__ == "__main__":
    unittest.main()
