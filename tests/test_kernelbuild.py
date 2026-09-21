"""kernelbuild tests — pure logic only (no compiler runs here)."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from omlx_uplift import kernelbuild


class ResolveSourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-kb-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _mk(self, name):
        d = os.path.join(self.tmp, "src", "omlx", "custom_kernels", name, "csrc")
        os.makedirs(d)
        open(os.path.join(d, "CMakeLists.txt"), "w").write("x")
        return os.path.join(self.tmp, "src")

    def test_finds_csrc_under_src(self):
        src = self._mk("decode_fast")
        self.assertEqual(
            kernelbuild.resolve_sources("decode_fast", src),
            os.path.join(src, "omlx", "custom_kernels", "decode_fast", "csrc"))

    def test_missing_sources_exits_with_guidance(self):
        with self.assertRaises(SystemExit) as cm:
            kernelbuild.resolve_sources("bonsai", self.tmp)
        self.assertIn("--src", str(cm.exception))

    def test_unknown_kernel_rejected(self):
        with self.assertRaises(SystemExit):
            kernelbuild.rebuild("not_a_kernel")


class KegDirsTests(unittest.TestCase):
    def test_libexec_layout_resolves_bin_python(self):
        with tempfile.TemporaryDirectory() as tmp:
            sp = os.path.join(tmp, "libexec", "lib", "python3.11",
                              "site-packages")
            os.makedirs(os.path.join(sp, "omlx"))
            binp = os.path.join(tmp, "libexec", "bin")
            os.makedirs(binp)
            exe = os.path.join(binp, "python")
            open(exe, "w").close()
            os.chmod(exe, 0o755)
            from omlx_uplift import patches as _p
            orig = _p._omlx_root
            _p._omlx_root = lambda: os.path.realpath(os.path.join(sp, "omlx"))
            try:
                got_exe, tree, root = kernelbuild.keg_dirs()
            finally:
                _p._omlx_root = orig
            self.assertEqual(got_exe, os.path.realpath(exe))
            self.assertTrue(os.path.isfile(got_exe))


class StampTests(unittest.TestCase):
    def test_stamp_noop_without_mlx_lib(self):
        with tempfile.TemporaryDirectory() as tmp:
            binp = os.path.join(tmp, "x.so")
            open(binp, "wb").write(b"x")
            kernelbuild._stamp_mlx_rpath(binp, tmp)  # mlx/lib absent -> no raise
            self.assertTrue(os.path.isfile(binp))


class DeployTests(unittest.TestCase):
    def test_deploy_swaps_and_backs_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            sp = os.path.join(tmp, "libexec", "lib", "python3.11",
                              "site-packages")
            kd = os.path.join(sp, "omlx", "custom_kernels", "decode_fast")
            os.makedirs(kd)
            os.makedirs(os.path.join(sp, "mlx", "lib"))
            open(os.path.join(sp, "omlx", "__init__.py"), "w").close()
            real = os.path.join(kd, "_ext.cpython-311-darwin.so")
            with open(real, "wb") as fh:
                fh.write(b"ORIGINAL")
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            with open(os.path.join(out, "_ext.cpython-311-darwin.so"), "wb") as fh:
                fh.write(b"REBUILT")
            from omlx_uplift import patches as _p
            orig_root, orig_base = _p._omlx_root, _p.default_base_dir
            _p._omlx_root = lambda: os.path.realpath(os.path.join(sp, "omlx"))
            try:
                res = kernelbuild.deploy("decode_fast", out,
                                         os.path.join(tmp, "data"))
            finally:
                _p._omlx_root, _p.default_base_dir = orig_root, orig_base
            self.assertTrue(res["ok"])
            self.assertIn("_ext.cpython-311-darwin.so", res["swapped"])
            with open(real, "rb") as fh:
                self.assertEqual(fh.read(), b"REBUILT")
            meta = json.load(open(os.path.join(res["backup_dir"], "meta.json")))
            self.assertTrue(meta["files"], "backup meta must record originals")
            rec = next(iter(meta["files"].values()))
            import hashlib
            self.assertEqual(rec["sha256"], hashlib.sha256(b"ORIGINAL").hexdigest())
            bpath = os.path.join(res["backup_dir"], "files",
                                 *next(iter(meta["files"])).split(os.sep))
            with open(bpath, "rb") as fh:
                self.assertEqual(fh.read(), b"ORIGINAL")

    def test_deploy_unknown_kernel_dir_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            sp = os.path.join(tmp, "site-packages")
            os.makedirs(os.path.join(sp, "omlx"))
            from omlx_uplift import patches as _p
            orig = _p._omlx_root
            _p._omlx_root = lambda: os.path.realpath(os.path.join(sp, "omlx"))
            try:
                with self.assertRaises(SystemExit):
                    kernelbuild.deploy("decode_fast", tmp,
                                       os.path.join(tmp, "data"))
            finally:
                _p._omlx_root = orig


class CliTests(unittest.TestCase):
    def test_kernel_list(self):
        from omlx_uplift import cli
        rc = cli.cmd_kernel(["list"])
        self.assertEqual(rc, 0)

    def test_rebuild_requires_name(self):
        from omlx_uplift import cli
        with self.assertRaises(SystemExit):
            cli.cmd_kernel(["rebuild"])

    def test_restore_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            sp = os.path.join(tmp, "libexec", "lib", "python3.11",
                              "site-packages")
            kd = os.path.join(sp, "omlx", "custom_kernels", "decode_fast")
            os.makedirs(kd)
            os.makedirs(os.path.join(sp, "mlx", "lib"))
            real = os.path.join(kd, "_ext.cpython-311-darwin.so")
            with open(real, "wb") as fh:
                fh.write(b"VANILLA")
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            with open(os.path.join(out, "_ext.cpython-311-darwin.so"), "wb") as fh:
                fh.write(b"PATCHED")
            from omlx_uplift import patches as _p
            orig_root, orig_base = _p._omlx_root, _p.default_base_dir
            _p._omlx_root = lambda: os.path.realpath(os.path.join(sp, "omlx"))
            _p.default_base_dir = lambda: os.path.join(tmp, "data")
            try:
                kernelbuild.deploy("decode_fast", out, os.path.join(tmp, "data"))
                with open(real, "rb") as fh:
                    self.assertEqual(fh.read(), b"PATCHED")
                res = kernelbuild.restore("decode_fast", quiet=True)
            finally:
                _p._omlx_root, _p.default_base_dir = orig_root, orig_base
            self.assertTrue(res["ok"], res)
            with open(real, "rb") as fh:
                self.assertEqual(fh.read(), b"VANILLA")

    def test_restore_without_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            from omlx_uplift import patches as _p
            orig_base = _p.default_base_dir
            _p.default_base_dir = lambda: os.path.join(tmp, "nothing")
            try:
                res = kernelbuild.restore("bonsai")
            finally:
                _p.default_base_dir = orig_base
            self.assertFalse(res["ok"])
