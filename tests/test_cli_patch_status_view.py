"""`patch status` human view (user ask 2026-10-18): one colour-coded line
per patch — verdict word, id, scope, short description — with the old JSON
dump moved behind --json. Words mirror the dashboard chips; the keg-moved
row names cause + action (no 'keg' jargon).

Coverage: verdict mapping + precedence, RE-APPLY note, state_detail line,
OFF rows carry no note, description flattening + width truncation, kill
switch / load_error banners, empty store, colour only on a TTY (piped
stream stays clean, NO_COLOR honoured), and the CLI wiring: default view,
--json unchanged, --scope filter applies to both."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from omlx_uplift import cli


def _p(pid, **kw):
    base = {"id": pid, "enabled": True, "scope": "omlx", "state": "applied",
            "state_detail": "", "description": f"{pid} does a thing",
            "requires_approval": [], "keg_changed": False}
    base.update(kw)
    return base


OUT = {"patches": [
    _p("alpha-good"),
    _p("beta-off", enabled=False, state="disabled"),
    _p("gamma-moved", keg_changed=True),
    _p("delta-err", state="error", state_detail="context mismatch — zero fuzz"),
    _p("eps-held", requires_approval=["kernel_source"]),
    _p("zeta-dev-scope-long-description-goes-on", scope="dev",
       description="Serve Qwen3-ASR over the realtime WS with "
                   "per-utterance\nendpointing and one whole-buffer decode"),
], "keg_id": "HEAD-deadbee", "kill_switch_active": False,
   "warning": "", "load_error": ""}


class TtyStringIO(io.StringIO):
    def isatty(self):
        return True


class Renderer(unittest.TestCase):
    def render(self, out=OUT, tty=False):
        stream = TtyStringIO() if tty else io.StringIO()
        cli._print_patch_status(out, stream=stream)
        return stream.getvalue()

    def test_one_line_per_patch_with_all_columns(self):
        t = self.render()
        for pid in ("alpha-good", "beta-off", "gamma-moved", "delta-err",
                    "eps-held"):
            self.assertIn(pid, t)
        self.assertIn("APPLIED", t)
        self.assertIn("OFF", t)
        self.assertIn("RE-APPLY", t)
        self.assertIn("ERROR", t)
        self.assertIn("HELD", t)
        self.assertIn("HEAD-deadbee", t)
        self.assertIn("[omlx]", t)
        self.assertIn("--json", t)  # discoverability footer

    def test_not_in_build_word_and_note(self):
        # BUILD-STAMP honesty: the omlx-dev branch was re-cut without this
        # enabled patch — the row must say so in words, not dim the card
        out = {"patches": [_p("left-out-build", scope="both",
                              state="not_in_build",
                              state_detail="NOT in the current omlx-dev "
                                           "build — no stored version "
                                           "applies onto these sources "
                                           "(tried v1)")],
               "keg_id": "HEAD-devkeg", "kill_switch_active": False,
               "warning": "", "load_error": ""}
        t = self.render(out)
        self.assertIn("NOT IN BUILD", t)
        self.assertIn("no stored version applies", t)

    def test_words_mirror_the_dashboard_and_precedence(self):
        # keg_changed outranks the stale applied stamp; disabled is OFF
        # regardless; requires_approval (enabled) is HELD
        t = self.render()
        self.assertEqual(t.count("RE-APPLY"), 1)

    def test_re_apply_note_names_cause_and_action(self):
        t = self.render()
        self.assertIn("omlx was updated", t)
        self.assertIn("NOT in the running code", t)
        self.assertIn("restart the server", t.lower())
        self.assertNotIn("KEG", t.upper().replace("KILL", ""))  # no jargon

    def test_error_row_shows_state_detail(self):
        t = self.render()
        self.assertIn("context mismatch — zero fuzz", t)

    def test_description_flattened_and_truncated(self):
        out = {"patches": [_p("x", description="word " * 300)],
               "keg_id": "k"}
        t = self.render(out)
        body = t.split("x  [omlx]", 1)[1]
        self.assertNotIn("\n", body.split("details:")[0].strip("\n")[1:])
        self.assertIn("…", t)

    def test_rows_never_exceed_terminal_width(self):
        # 2026-10-18 regression: a flat per-row budget ignored the [scope]
        # tag width and long ids — descriptions wrapped by 2 chars + '…'.
        out = {"keg_id": "k", "patches": [
            _p("devrow", scope="dev", description="d" * 500),
            _p("omlxrow", scope="omlx", description="d" * 500),
            _p("bothrow", scope="both", description="d" * 500),
            _p("an-extremely-long-patch-id-that-exceeds-thirty-chars",
               scope="both", description="d" * 500),
            _p("short"),
        ]}
        saved = os.environ.get("COLUMNS")
        os.environ["COLUMNS"] = "80"
        try:
            t = self.render(out)
        finally:
            if saved is None:
                os.environ.pop("COLUMNS", None)
            else:
                os.environ["COLUMNS"] = saved
        for line in t.splitlines():
            self.assertLessEqual(len(line), 80,
                                 "overflowing row: %r" % line)
        # the over-long id keeps its handle and gets the description on a
        # continuation row
        lines = t.splitlines()
        i = next(k for k, l in enumerate(lines) if "exceeds-thirty-chars" in l)
        self.assertFalse(lines[i].rstrip().endswith(("ddd…", "ddddd")))
        self.assertIn("dddd", lines[i + 1])
        self.assertIn("…", t)

    def test_kill_switch_and_load_error_banners(self):
        out = dict(OUT, kill_switch_active=True, load_error="manifest v9?!")
        t = self.render(out)
        self.assertIn("KILL SWITCH ACTIVE", t)
        self.assertIn("enable-all", t)
        self.assertIn("manifest v9?!", t)

    def test_missing_description_falls_back_to_source(self):
        out = {"patches": [_p("nodesc", description="",
                              source={"kind": "upload", "file": "x.diff"})],
               "keg_id": "k"}
        t = self.render(out)
        self.assertIn("(from upload: x.diff)", t)
        out2 = {"patches": [_p("pr", description="",
                               source={"kind": "github_pr",
                                       "repo": "jundot/omlx", "pr": 4522})],
                "keg_id": "k"}
        self.assertIn("(PR jundot/omlx#4522)", self.render(out2))
        out3 = {"patches": [_p("up", description="",
                               source={"kind": "upload"})], "keg_id": "k"}
        self.assertIn("(from upload)", self.render(out3))

    def test_empty_store_is_sane(self):
        t = self.render({"patches": [], "keg_id": "k"})
        self.assertIn("(no patches stored)", t)

    def test_colour_only_on_tty(self):
        self.assertNotIn("\033[", self.render())          # piped: clean
        saved = os.environ.pop("NO_COLOR", None)
        try:
            self.assertIn("\033[", self.render(tty=True))  # tty: coloured
            os.environ["NO_COLOR"] = "1"
            self.assertNotIn("\033[", self.render(tty=True))  # honoured
        finally:
            os.environ.pop("NO_COLOR", None)
            if saved is not None:
                os.environ["NO_COLOR"] = saved


class CliWiring(unittest.TestCase):
    """Default = human view; --json = the unchanged technical dump."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="pst-view-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home

    def tearDown(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old

    def _run(self, argv):
        out = io.StringIO()
        with mock.patch("omlx_uplift.patches._omlx_root",
                        return_value="/x/site-packages/omlx"), \
                mock.patch("omlx_uplift.patches.keg_id",
                           return_value="HEAD-test"), \
                mock.patch("omlx_uplift.patchsource.view",
                           return_value=json.loads(json.dumps(OUT))):
            with redirect_stdout(out):
                rc = cli.cmd_patches(argv)
        return rc, out.getvalue()

    def test_default_prints_the_human_view(self):
        rc, t = self._run(["status"])
        self.assertEqual(rc, 0)
        self.assertIn("OMLX-UPLIFT PATCHES", t)
        self.assertIn("APPLIED", t)
        with self.assertRaises(ValueError):
            json.loads(t)   # NOT json anymore

    def test_json_flag_returns_the_technical_dump(self):
        rc, t = self._run(["status", "--json"])
        self.assertEqual(rc, 0)
        d = json.loads(t)
        self.assertEqual([p["id"] for p in d["patches"]],
                         [p["id"] for p in OUT["patches"]])
        self.assertEqual(d["keg_id"], "HEAD-deadbee")  # view()'s payload

    def test_scope_filter_applies_to_both_modes(self):
        rc, t = self._run(["status", "--scope", "dev"])
        self.assertEqual(rc, 0)
        self.assertIn("zeta-dev-scope-long-description-goes-on", t)
        self.assertNotIn("alpha-good", t)
        rc, t = self._run(["status", "--json", "--scope", "dev"])
        d = json.loads(t)
        self.assertEqual(len(d["patches"]), 1)


class DevBuildPatchTable(unittest.TestCase):
    """`dev install` per-patch table: EVERY enabled build-scope patch the
    store knows about must appear, with the reason when the branch does not
    carry it (user report 2026-10-19: a patch upstream now carries vanished
    from the table without a word)."""

    def setUp(self):
        from omlx_uplift import patches as _p

        self._home = os.environ.get("UPLIFT_HOME")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp.name, "uplift")
        store = _p.PatchStore()
        store.save({"version": 2, "config": {}, "patches": [
            {"id": "built-ok", "enabled": True, "scope": "both",
             "state": "applied", "desired_version": 1,
             "versions": [{"v": 1}]},
            {"id": "resolver-skip", "enabled": True, "scope": "both",
             "state": "applied", "desired_version": 1,
             "versions": [{"v": 1}]},
            {"id": "qwen4-mtpfix", "enabled": True, "scope": "both",
             "state": "obsolete", "desired_version": 1,
             "versions": [{"v": 1}],
             "dev_absent": {"kind": "obsolete",
                            "reason": "upstream now carries this patch"}},
            {"id": "ghost", "enabled": True, "scope": "dev",
             "state": "pending", "desired_version": 1,
             "versions": [{"v": 1}]},
            {"id": "switched-off", "enabled": False, "scope": "both",
             "state": "disabled", "desired_version": 1,
             "versions": [{"v": 1}]},
            {"id": "runtime-only", "enabled": True, "scope": "omlx",
             "state": "applied", "desired_version": 1,
             "versions": [{"v": 1}]},
        ]})

    def tearDown(self):
        if self._home is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._home

    def _render(self):
        stream = io.StringIO()
        with redirect_stdout(stream):
            cli._dev_patch_table(
                [{"id": "built-ok", "v": 1, "sha": "a" * 40, "files": 2}],
                {},
                [{"id": "resolver-skip", "reason": "no apply", "tried": [1]}])
        return stream.getvalue()

    def test_every_enabled_build_patch_has_a_row(self):
        t = self._render()
        self.assertIn("APPLIED", t)
        self.assertIn("built-ok", t)
        # upstreamed before the build: an UPSTREAMED row, not silence
        self.assertIn("qwen4-mtpfix", t)
        self.assertIn("marked obsolete", t)
        # enabled, in the store, nothing materialized: a SKIPPED row naming it
        self.assertIn("ghost", t)
        self.assertIn("enabled but NOT in this build", t)
        # a disabled patch is still listed (pre-existing pin)
        self.assertIn("switched-off", t)
        self.assertIn("DISABLED", t)
        # runtime scope never belongs to the branch — no row, no confusion
        self.assertNotIn("runtime-only", t)

    def test_no_duplicate_row_for_a_resolver_skip(self):
        t = self._render()
        self.assertEqual(t.count("resolver-skip"), 1)
        self.assertIn("built WITHOUT this patch (tried v1)", t)


if __name__ == "__main__":
    unittest.main()
