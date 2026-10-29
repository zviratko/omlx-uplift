"""UP-60 tests: the dev-build dependency guard.

The guard compares THREE coordinates that a single build consumes - our
`Formula/omlx-dev.rb`, the tap's `Formula/omlx.rb`, and the source tree's
`pyproject.toml` at the commit being cut - and it probes the finished keg's own
interpreter before that keg is allowed to become live.

Real 2026-10-29 failure it pins: a lagging tap installed mlx-audio 0.4.3 over
the 0.6.3 the source asked for; the engine died at
`from mlx_lm.generate import GenerationBatch` on a keg brew had called success.

No Homebrew, no network, no real keg: formula trees are fixtures in tmp dirs and
the probe runner is a fake. The ONE test that touches the machine (the live tap
pair) skips when the tap is absent - that is CI.
"""

import json
import os
import unittest

from omlx_uplift import devguard

PARENT = '''class Omlx < Formula
  url "https://github.com/jundot/omlx.git", tag: "v0.7.3"
  resource "mlx-audio" do
    url "https://github.com/Blaizzy/mlx-audio.git",
      revision: "8c244a1faff44cfa69e3151c195f52a4c1c90be5"
  end

  resource "en-core-web-sm" do
    url "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
    sha256 "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"
  end
end
'''

DEV = '''class OmlxDev < Omlx
  resource "mlx-audio" do
    url "https://github.com/Blaizzy/mlx-audio.git",
        revision: "8c244a1faff44cfa69e3151c195f52a4c1c90be5"
  end

  # resource "commented-out" do
  #   url "https://example.invalid/x.git", revision: "deadbeefdeadbeef"
  # end

  resource "en-core-web-sm" do
    url "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
    sha256 "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"
  end
end
'''

PYPROJECT = '''
[project]
dependencies = [
  "mlx-lm @ git+https://github.com/ml-explore/mlx-lm@0d4d3d04f8ab7ce4a51e7209e8615755a48ba94d",
  "mlx-audio @ git+https://github.com/Blaizzy/mlx-audio@8c244a1faff44cfa69e3151c195f52a4c1c90be5",
  "spacy>=3.8.4",
]
'''


def _fake_prefix(tmp, dev_text=DEV, parent_text=PARENT, write_parent=True):
    """Build a brew-prefix-shaped fixture tree; return its root."""
    dev_dir = os.path.join(tmp, *devguard.DEV_TAP_REL, "Formula")
    os.makedirs(dev_dir, exist_ok=True)
    with open(os.path.join(dev_dir, "omlx-dev.rb"), "w") as fh:
        fh.write(dev_text)
    if write_parent:
        par_dir = os.path.join(tmp, *devguard.PARENT_TAP_REL, "Formula")
        os.makedirs(par_dir, exist_ok=True)
        with open(os.path.join(par_dir, "omlx.rb"), "w") as fh:
            fh.write(parent_text)
    return tmp


class Parsing(unittest.TestCase):
    def test_resources_include_positional_sha256(self):
        res = devguard.parse_resources(PARENT)
        self.assertEqual(res["mlx-audio"].revision,
                         "8c244a1faff44cfa69e3151c195f52a4c1c90be5")
        # brew writes `sha256 "..."`, not `sha256: "..."` - the wheel resource
        # must still be read or a swapped artifact would never be noticed
        self.assertEqual(
            res["en-core-web-sm"].sha256,
            "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85")

    def test_commented_resource_is_not_a_resource(self):
        self.assertNotIn("commented-out", devguard.parse_resources(DEV))

    def test_source_pins(self):
        pins = devguard.parse_source_pins(PYPROJECT)
        self.assertEqual(pins["mlx-audio"],
                         "8c244a1faff44cfa69e3151c195f52a4c1c90be5")
        self.assertNotIn("spacy", pins)      # a range is not a commit

    def test_line_of_names_the_line_to_edit(self):
        self.assertEqual(devguard.formula_line_of(DEV, "mlx-audio"), 2)
        self.assertEqual(devguard.formula_line_of(DEV, "nope"), 0)


class PreBuildFindings(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp(prefix="up60-")
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)

    def test_matching_coordinates_pass(self):
        root = _fake_prefix(self.tmp)
        self.assertEqual(devguard.pre_build_findings(PYPROJECT,
                                                     brew_prefix=root), [])

    def test_our_redeclar_resource_must_equal_upstreams(self):
        # exactly the 2026-10-29 shape: our formula still on the old commit
        root = _fake_prefix(self.tmp, dev_text=DEV.replace(
            "8c244a1faff44cfa69e3151c195f52a4c1c90be5",
            "5175326b0f7e5f2e1a0f9a4e0e0e0e0e0e0e0e0e"))
        f = devguard.pre_build_findings(PYPROJECT, brew_prefix=root)
        self.assertEqual([x.kind for x in f], ["formula-skew"])
        text = f[0].render()
        self.assertIn("mlx-audio", text)
        self.assertIn("omlx-dev.rb:2", text)          # names the line to bump
        self.assertIn("5175326b0f7e", text)           # shows both coordinates
        self.assertIn("brew update", text)            # and one way out

    def test_tap_lagging_the_source_is_refused_too(self):
        root = _fake_prefix(self.tmp, parent_text=PARENT.replace(
            "8c244a1faff44cfa69e3151c195f52a4c1c90be5",
            "5175326b0f7e5f2e1a0f9a4e0e0e0e0e0e0e0e0e"))
        f = devguard.pre_build_findings(
            PYPROJECT, source_label="abc:pyproject.toml", brew_prefix=root)
        kinds = [x.kind for x in f]
        self.assertIn("tap-lag", kinds)
        self.assertIn("pull --ff-only", " ".join(x.render() for x in f))

    def test_extra_resource_we_own_is_not_a_finding(self):
        root = _fake_prefix(self.tmp, dev_text=DEV.replace(
            'resource "en-core-web-sm"', 'resource "our-own-thing"'))
        self.assertEqual([x.kind for x in
                          devguard.pre_build_findings(PYPROJECT,
                                                      brew_prefix=root)
                          if x.kind == "formula-skew"], [])

    def test_unreachable_parent_continues_unverified(self):
        # no tap checkout AND no network: an operator with no brew must still be
        # able to build - the guard says so loudly instead of blocking.
        root = _fake_prefix(self.tmp, write_parent=False)
        real = devguard.parent_formula_text

        def none(_p, **kw):
            return "", ""
        devguard.parent_formula_text = none
        try:
            f = devguard.pre_build_findings(PYPROJECT, brew_prefix=root)
        finally:
            devguard.parent_formula_text = real
        self.assertEqual([x.kind for x in f], ["unverifiable"])


class PostBuildProbes(unittest.TestCase):
    def test_clean_keg_reports_nothing(self):
        rows = [[label, ""] for label, _s, _w in devguard.PROBES]

        def runner(cmd, **kw):
            self.assertIn("-c", cmd)
            return _Completed(json.dumps(rows))
        self.assertEqual(devguard.post_build_probes("/keg/py", runner=runner),
                         [])

    def test_first_broken_import_is_named_with_its_cause(self):
        def runner(cmd, **kw):
            rows = [["entry", ""]]
            rows += [[label, "ImportError: nope"]
                     if label == "mlx-lm batch" else [label, ""]
                     for label, _s, _w in devguard.PROBES[1:]]
            return _Completed(json.dumps(rows))
        out = devguard.post_build_probes("/keg/py", runner=runner)
        self.assertEqual(len(out), 1)
        label, err = out[0]
        self.assertEqual(label, "mlx-lm batch")
        self.assertIn("ImportError", err)
        self.assertIn("omlx's scheduler", err)   # names what the import needs

    def test_missing_interpreter_is_an_error_not_a_pass(self):
        def runner(cmd, **kw):
            raise FileNotFoundError(cmd[0])
        out = devguard.post_build_probes("/nope/py", runner=runner)
        self.assertEqual(out[0][0], "interpreter")

    def test_garbage_from_the_child_is_an_error(self):
        def runner(cmd, **kw):
            return _Completed("not json at all")
        self.assertEqual(devguard.post_build_probes("/keg/py", runner=runner)
                         [0][0], "probe output")

    def test_entry_module_probe_is_the_engine_import(self):
        # the wall of 2026-10-29 was omlx.scheduler importing GenerationBatch;
        # the FIRST probe must be the engine's own entry module
        self.assertEqual(devguard.PROBES[0][0], "entry")
        self.assertIn("omlx.scheduler", devguard.PROBES[0][1])


class _Completed:
    def __init__(self, stdout, returncode=0):
        self.stdout, self.returncode, self.stderr = stdout, returncode, ""


class DevsrcWiring(unittest.TestCase):
    def test_guard_refuses_and_force_downgrades(self):
        from omlx_uplift import devsrc

        res = devsrc.BuildResult(ok=False, stage="config", returncode=2,
                                 lines=[])
        real_bp, real_find = devsrc._base_pyproject, devguard.pre_build_findings
        finding = devguard.Finding(kind="formula-skew",
                                   text="mlx-audio differs", fix="brew update")
        devsrc._base_pyproject = lambda cfg, path: ("", "x:pyproject.toml")
        devguard.pre_build_findings = lambda *a, **k: [finding]
        try:
            err = devsrc._prebuild_dependency_guard({}, "/dev-src", res)
            self.assertIn("disagree", err)
            self.assertTrue(any(s == "err" for s, _t in res.lines))

            res2 = devsrc.BuildResult(ok=False, stage="config", returncode=2,
                                      lines=[])
            self.assertIsNone(devsrc._prebuild_dependency_guard(
                {}, "/dev-src", res2, skip_guard=True))
            self.assertTrue(any(s == "warn" for s, _t in res2.lines))
        finally:
            devsrc._base_pyproject = real_bp
            devguard.pre_build_findings = real_find

    def test_unverifiable_never_blocks_a_build(self):
        # CI / fresh box: no tap checkout. A warning, and the build proceeds.
        from omlx_uplift import devsrc

        res = devsrc.BuildResult(ok=False, stage="config", returncode=2,
                                 lines=[])
        real_bp, real_find = devsrc._base_pyproject, devguard.pre_build_findings
        devsrc._base_pyproject = lambda cfg, path: ("", "x:pyproject.toml")
        devguard.pre_build_findings = lambda *a, **k: [devguard.Finding(
            kind="unverifiable", text="no parent formula to compare against")]
        try:
            self.assertIsNone(devsrc._prebuild_dependency_guard({}, "/d", res))
            self.assertTrue(any(s == "warn" for s, _t in res.lines))
            self.assertFalse(any(s == "err" for s, _t in res.lines))
        finally:
            devsrc._base_pyproject = real_bp
            devguard.pre_build_findings = real_find

    def test_run_dev_build_accepts_skip_guard(self):
        import inspect

        from omlx_uplift import devsrc
        self.assertIn("skip_guard",
                      inspect.signature(devsrc.run_dev_build).parameters)
        self.assertIn("skip_guard",
                      inspect.signature(devsrc._run_dev_build_body).parameters)


class LiveTapPair(unittest.TestCase):
    """The invariant that protects the next real build on a dev box."""

    def test_this_machines_coordinates_agree(self):
        from omlx_uplift import devsrc

        cfg = devsrc.load_config()
        if not cfg:
            self.skipTest("no omlx-dev bootstrap on this machine")
        path = devsrc.src_path(cfg)
        if not os.path.isdir(os.path.join(path, ".git")):
            self.skipTest(f"dev-src checkout missing at {path}")
        text, label = devsrc._base_pyproject(cfg, path)
        self.assertTrue(text, "base pyproject must be readable")
        findings = devguard.pre_build_findings(text, source_label=label)
        bad = [f.render() for f in findings if f.kind != "unverifiable"]
        self.assertEqual(bad, [], "tap formula / parent formula / source pins "
                                  "disagree - a build here would ship mixed "
                                  "dependencies")


if __name__ == "__main__":
    unittest.main()
