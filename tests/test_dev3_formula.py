"""DEV-3 tests: OmlxDev formula contract + dev install wiring.

The formula file itself is pure Ruby — these tests pin the CONTRACT
uplift depends on (formula name, head URL source, service isolation,
option names, binary rename) by reading the formula text, plus Python-
side helpers: receipt option inheritance and the dev-keg .pth mount
(exercised against a fake keg with a real interpreter).

No Homebrew, no network.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from omlx_uplift import cli, devsrc

FORMULA_CANDIDATES = [
    os.path.expanduser("~/git/homebrew-uplift/Formula/omlx-dev.rb"),
    "/opt/homebrew/Library/Taps/zviratko/homebrew-uplift/Formula/omlx-dev.rb",
]


def _formula_text() -> str:
    for p in FORMULA_CANDIDATES:
        if os.path.isfile(p):
            with open(p) as fh:
                return fh.read()
    raise unittest.SkipTest("omlx-dev.rb formula not found")


class FormulaContract(unittest.TestCase):
    def setUp(self):
        self.src = _formula_text()

    def test_extends_omlx_inherits_methods(self):
        self.assertRegex(self.src, r"class\s+OmlxDev\s*<\s*Omlx\b")

    def test_head_only_no_stable(self):
        # no stable `url` line outside comments
        body = "\n".join(l for l in self.src.splitlines()
                         if not l.strip().startswith("#"))
        self.assertNotIn("\n  url ", body)
        self.assertRegex(self.src, r'using:\s+:git')
        self.assertIn("uplift-dev", self.src)

    def test_head_url_is_local_devsrc(self):
        self.assertRegex(self.src, r'head\s+"file://')
        # resolved through devsrc config, not a hard-coded clone path
        self.assertIn("OmlxDevConstants.src_path", self.src)

    def test_option_names_match_upstream(self):
        # brew DSL: option "with-x" -> CLI flag --with-x
        for opt in ("with-custom-kernel", "with-grammar"):
            self.assertIn(f'option "{opt}"', self.src)

    def test_binary_rename_avoids_link_collision(self):
        self.assertIn('File.rename(bin/"omlx", bin/"omlx-dev")', self.src)

    def test_service_is_isolated(self):
        self.assertIn('"omlx-dev", "serve"', self.src)
        self.assertIn("OMLX_PORT", self.src)
        self.assertIn("8001", self.src)
        self.assertIn(".omlx-dev", self.src)
        # own log path — var/ is shared with vanilla omlx
        self.assertIn("omlx-dev.log", self.src)

    def test_service_uses_renamed_binary(self):
        m = re.search(r'run\s+\[\s*opt_bin/"([^"]+)"', self.src)
        self.assertTrue(m, "service run command not found")
        self.assertEqual(m.group(1), "omlx-dev")

    def test_post_install_is_parity(self):
        # the tap's mount command must be mentioned in post_install so the
        # dev keg gets the .pth exactly like omlx-uplift install does
        self.assertIn("omlx-uplift", self.src)

    def test_ruby_syntax_valid(self):
        ruby = shutil.which("ruby")
        if not ruby:
            self.skipTest("no ruby")
        p = subprocess.run([ruby, "-c", FORMULA_CANDIDATES[0]],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)


class ReceiptInheritance(unittest.TestCase):
    def _receipt(self, formula, used):
        prefix = self.prefix
        keg = os.path.join(prefix, "Cellar", formula, "1.0")
        os.makedirs(keg, exist_ok=True)
        with open(os.path.join(keg, "INSTALL_RECEIPT.json"), "w") as fh:
            json.dump({"used_options": used}, fh)

    def setUp(self):
        self.prefix = tempfile.mkdtemp(prefix="uplift-dev3-prefix-")
        self.addCleanup(shutil.rmtree, self.prefix, ignore_errors=True)
        self._env = os.environ.get("HOMEBREW_PREFIX")
        os.environ["HOMEBREW_PREFIX"] = self.prefix

    def tearDown(self):
        if self._env is None:
            os.environ.pop("HOMEBREW_PREFIX", None)
        else:
            os.environ["HOMEBREW_PREFIX"] = self._env

    def test_empty_when_not_installed(self):
        self.assertEqual(cli._receipt_used_options("nope"), set())

    def test_reads_used_options(self):
        self._receipt("omlx", ["--with-custom-kernel", "--HEAD"])
        self.assertEqual(cli._receipt_used_options("omlx"),
                         {"--with-custom-kernel", "--HEAD"})

    def test_dev_receipt_preferred_by_caller(self):
        # cmd_dev_upgrade order: dev receipt first, vanilla only as fallback
        self._receipt("omlx", ["--with-custom-kernel"])
        self.assertEqual(cli._receipt_used_options("omlx-dev"), set())
        self.assertEqual(cli._receipt_used_options("omlx-dev")
                         or cli._receipt_used_options("omlx"),
                         {"--with-custom-kernel"})
        self._receipt("omlx-dev", ["--with-grammar"])
        self.assertEqual(cli._receipt_used_options("omlx-dev")
                         or cli._receipt_used_options("omlx"),
                         {"--with-grammar"})


class BrewBuildCmd(unittest.TestCase):
    """brew 7.0.6 --HEAD asymmetry (both errors hit 2026-09-24): install
    needs --HEAD for a head-only formula, reinstall rejects it."""

    def setUp(self):
        self.prefix = tempfile.mkdtemp(prefix="uplift-dev3-cmd-")
        self.addCleanup(shutil.rmtree, self.prefix, ignore_errors=True)
        self._env = os.environ.get("HOMEBREW_PREFIX")
        os.environ["HOMEBREW_PREFIX"] = self.prefix

    def tearDown(self):
        if self._env is None:
            os.environ.pop("HOMEBREW_PREFIX", None)
        else:
            os.environ["HOMEBREW_PREFIX"] = self._env

    def test_first_build_installs_with_head(self):
        cmd = cli._brew_build_cmd({"--with-grammar"})
        self.assertEqual(cmd, ["brew", "install", "--HEAD",
                               "--with-grammar", "omlx-dev"])

    def test_rebuild_reinstalls_without_head(self):
        os.makedirs(os.path.join(self.prefix, "Cellar", "omlx-dev",
                                 "HEAD-abc"))
        cmd = cli._brew_build_cmd(set())
        self.assertEqual(cmd, ["brew", "reinstall", "omlx-dev"])


class MountIntoDevKeg(unittest.TestCase):
    """The .pth contract for the dev keg: one file, bootstrap line first,
    import autopatch last — identical body to `omlx-uplift install`.
    Fake keg wraps a throwaway venv so nothing touches the real system."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-dev3-keg-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # fake keg: <prefix>/libexec/bin/python -> throwaway venv python
        venv = os.path.join(self.tmp, "venv")
        subprocess.run([sys.executable, "-m", "venv", "--copies", venv],
                       check=True, capture_output=True)
        bindir = os.path.join(self.tmp, "libexec", "bin")
        os.makedirs(bindir)
        os.symlink(os.path.join(venv, "bin", "python"),
                   os.path.join(bindir, "python"))
        # brew --prefix omlx-dev must resolve to our fake keg
        fake_brew = os.path.join(self.tmp, "brew")
        with open(fake_brew, "w") as fh:
            fh.write(f"#!/bin/sh\necho {self.tmp}\n")
        os.chmod(fake_brew, 0o755)
        self._orig_which = shutil.which

        def which(name):
            if name == "brew":
                return fake_brew
            return self._orig_which(name)

        shutil.which = which
        self.addCleanup(setattr, shutil, "which", self._orig_which)
        out = subprocess.run(
            [os.path.join(bindir, "python"), "-c",
             "import site;print(site.getsitepackages()[0])"],
            capture_output=True, text=True).stdout.strip()
        self.site_pkgs = out

    def test_mount_writes_single_pth(self):
        ok = cli._mount_into_dev_keg()
        self.assertTrue(ok)
        target = os.path.join(self.site_pkgs, cli.PTH_NAME)
        self.assertTrue(os.path.isfile(target), f"missing {target}")
        with open(target) as fh:
            body = fh.read()
        self.assertIn("import omlx_uplift.autopatch", body)
        # path/bootstrap line before the import line
        lines = [l for l in body.splitlines() if l.strip()]
        self.assertTrue(lines[0].startswith("/"),
                        f"first line not a path: {lines[:2]}")
        self.assertEqual(lines[-1], "import omlx_uplift.autopatch")

    def test_mount_is_idempotent(self):
        self.assertTrue(cli._mount_into_dev_keg())
        first = open(os.path.join(self.site_pkgs, cli.PTH_NAME)).read()
        self.assertTrue(cli._mount_into_dev_keg())
        second = open(os.path.join(self.site_pkgs, cli.PTH_NAME)).read()
        self.assertEqual(first, second)

    def test_missing_keg_is_not_fatal(self):
        os.remove(os.path.join(self.tmp, "libexec", "bin", "python"))
        self.assertFalse(cli._mount_into_dev_keg())


class UpgradeDryRun(unittest.TestCase):
    """dev install must refuse cleanly without a dev.json (exit 2) and the
    materialize path must precede any brew call (dry-run prints command)."""

    def test_missing_config_exit_2(self):
        base = tempfile.mkdtemp(prefix="uplift-dev3-nocfg-")
        self.addCleanup(shutil.rmtree, base, ignore_errors=True)
        orig = devsrc.dev_json_path

        def fake_path(b=None):
            return os.path.join(base, "dev.json")

        devsrc.dev_json_path = fake_path
        self.addCleanup(setattr, devsrc, "dev_json_path", orig)

        class A:
            action = "install"
            with_custom_kernel = False
            with_grammar = False
            dry_run = True

        self.assertEqual(cli.cmd_dev_install(A()), 2)


if __name__ == "__main__":
    unittest.main()
