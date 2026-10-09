"""TUI-3 perf layer: TTL display caches, the launchctl service probe, and
the background pulse contract.

The rule these pin down: a repaint must never block on a subprocess. Display
state (service liveness, git carrier status, network catalog, mount probe) is
cached with a TTL and refreshed off the UI thread; the patch manifest is NOT
cached, because it is the security-relevant state the dashboard and CLI share.
"""
import os
import shutil
import tempfile
import time
import unittest

from omlx_uplift.tui.context import Context


class FakeRun:
    """Stand-in for subprocess.run for the probes (NOT Context._runner,
    which belongs to op command execution)."""

    def __init__(self, results=None, default=None):
        self.calls = []
        self.results = results or {}
        # default models 'service unknown to launchd' (rc 113), the same
        # shape a real probe returns then
        self.default = default if default is not None else Res("", 113)

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))
        out = self.results.get(argv[-1] if argv else "", self.default)
        if isinstance(out, Exception):
            raise out
        return out


class Res:
    def __init__(self, stdout="", returncode=0):
        self.stdout, self.returncode = stdout, returncode


class ProbeCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tui3-perf-")
        self._old_home = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        self.fake = FakeRun()
        self._real = Context._probe
        Context._probe = staticmethod(self.fake)

    def tearDown(self):
        Context._probe = self._real
        if self._old_home is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old_home
        shutil.rmtree(self.home, ignore_errors=True)


class TestLaunchdProbe(ProbeCase):
    def test_running_job_reports_started(self):
        self.fake.results = {
            "sh.brew.omlx": Res('"PID" = 5451;\n"Label" = "sh.brew.omlx";'),
            "sh.brew.omlx-dev": Res('"Label" = "sh.brew.omlx-dev";'),
        }
        rows = Context(tree_root="").services()
        states = {r["formula"]: r["state"] for r in rows}
        self.assertEqual(states["omlx"], "started")
        self.assertEqual(states["omlx-dev"], "stopped",
                         "loaded without a PID is stopped, not unknown")

    def test_absent_service_is_empty_not_error(self):
        self.fake.results = {"sh.brew.omlx": Res("", 113),
                             "sh.brew.omlx-dev": Res("", 113)}
        rows = Context(tree_root="").services()
        self.assertEqual({r["state"] for r in rows}, {""})

    def test_probe_explosion_degrades_honestly(self):
        self.fake.results = {"sh.brew.omlx": OSError("launchctl gone"),
                             "sh.brew.omlx-dev": OSError("launchctl gone")}
        rows = Context(tree_root="").services()
        self.assertEqual({r["state"] for r in rows}, {"unknown"})

    def test_asked_launchctl_not_brew(self):
        Context(tree_root="").services()
        joined = [" ".join(c) for c in self.fake.calls]
        self.assertTrue(all(not c.startswith("brew ") for c in joined),
                        "the 450 ms brew launcher must be off the hot path: "
                        + repr(joined))
        self.assertIn("launchctl list sh.brew.omlx", joined)


class TestTTLCache(ProbeCase):
    def test_repeat_reads_hit_the_cache(self):
        ctx = Context(tree_root="")
        ctx.services()
        n = len(self.fake.calls)
        for _ in range(5):
            ctx.services()
        self.assertEqual(len(self.fake.calls), n, "TTL window re-probes")

    def test_invalidate_forces_the_next_read(self):
        ctx = Context(tree_root="")
        ctx.services()
        n = len(self.fake.calls)
        ctx.invalidate()
        ctx.services()
        self.assertEqual(len(self.fake.calls), n + 2,
                         "one pair of labels per forced probe")

    def test_expiry_lets_a_stale_value_be_replaced(self):
        ctx = Context(tree_root="")
        ctx.services()
        stamp = ctx._cache["services"][0]
        ctx._cache["services"] = (stamp - ctx._SERVICES_TTL - 1,
                                  [{"formula": "stale"}])
        self.assertNotEqual(ctx.services()[0].get("formula"), "stale")

    def test_producer_failure_keeps_the_last_good_value(self):
        # the probe layer already turns a launchctl OSError into 'unknown'
        # (test_probe_explosion_degrades_honestly); this checks the OUTER
        # safety net — if building a whole services row throws for any other
        # reason, the cache replays the last good snapshot instead of
        # crashing the repaint or blanking the panel.
        ctx = Context(tree_root="")
        good = ctx.services()

        class Dead:
            @staticmethod
            def load_config():
                raise RuntimeError("dev.json unreadable")

        ctx.devsrc = Dead()
        # expire (not clear): 'the cached truth aged out AND the re-probe
        # died' is the failure combination this net exists for
        stamp = ctx._cache["services"][0]
        ctx._cache["services"] = (stamp - ctx._SERVICES_TTL - 1, good)
        self.assertEqual(ctx.services(), good,
                         "a repaint must show yesterday's truth rather "
                         "than crash or blank")

    def test_collector_empty_shapes(self):
        # the point of `empty`: a builder does .get() on dicts and iterates
        # lists — a fallback of the WRONG shape would crash the very repaint
        # the cache exists to save. Kill each producer outright, with
        # nothing cached to replay, and demand the neutral shape back.
        for attr, producer_attr, want in (
                ("catalog", "_catalog_now", dict),
                ("dev_summary", "_dev_summary_now", dict),
                ("services", "_services_now", list),
                ("pth_missing", "_pth_missing_now", bool)):
            ctx = Context(tree_root="")

            def dead(*_a, **_kw):
                raise RuntimeError("collector dead")

            setattr(ctx, producer_attr, dead)
            got = getattr(ctx, attr)()
            self.assertIsInstance(got, want, f"{attr} fallback shape")

    def test_manifest_is_never_cached(self):
        # the security-relevant state: another terminal can arm the kill
        # switch at any moment and the next paint must show it
        from omlx_uplift import patches
        ctx = Context(tree_root="")
        ctx.patches_view()
        st = patches.PatchStore()
        st.save({"patches": [], "config": {},
                 "kill_switch_marker": True})
        with open(st.sentinel_path, "w") as fh:
            fh.write("armed by test")
        self.assertTrue(ctx.patches_view()["kill_switch_active"])


class TestPulse(ProbeCase):
    def test_pulse_warms_local_collectors_only(self):
        ctx = Context(tree_root="")
        calls_before = len(self.fake.calls)
        ctx.pulse(want_catalog=False)
        self.assertGreater(len(self.fake.calls), calls_before)
        self.assertNotIn("catalog", ctx._cache,
                         "the GitHub fetch must not be pulsed forever "
                         "while some other panel is on screen")
        ctx.pulse(want_catalog=True)
        self.assertIn("catalog", ctx._cache)


if __name__ == "__main__":
    unittest.main()
