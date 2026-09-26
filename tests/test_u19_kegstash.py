"""U19 — keg stash / rollback for omlx-dev builds.

Runs against a FAKE HOMEBREW_PREFIX (tmpdir) so nothing on the real box
is touched. The fake layout mirrors brew: Cellar/omlx-dev/HEAD-<sha>/ with
bin/omlx-dev whose shebang points INSIDE that cellar path, plus an
opt/omlx-dev symlink — exactly the invariant activate() must preserve.
"""
import json
import os
import shutil
import tempfile
import unittest

from omlx_uplift import kegstash


def _make_keg(prefix: str, name: str, sha: str) -> str:
    cellar = os.path.join(prefix, "Cellar", "omlx-dev", name)
    os.makedirs(os.path.join(cellar, "bin"), exist_ok=True)
    os.makedirs(os.path.join(cellar, "libexec", "bin"), exist_ok=True)
    launcher = os.path.join(cellar, "bin", "omlx-dev")
    with open(launcher, "w", encoding="utf-8") as fh:
        fh.write(f"#!{cellar}/libexec/bin/python3.11\nprint('serving')\n")
    os.chmod(launcher, 0o755)
    with open(os.path.join(cellar, "payload.txt"), "w") as fh:
        fh.write(sha)
    return cellar


class KegstashTestCase(unittest.TestCase):
    def setUp(self):
        self.prefix = tempfile.mkdtemp(prefix="uplift-u19-prefix-")
        self.root = tempfile.mkdtemp(prefix="uplift-u19-root-")
        self._old_prefix = os.environ.get("HOMEBREW_PREFIX")
        os.environ["HOMEBREW_PREFIX"] = self.prefix
        self.addCleanup(shutil.rmtree, self.prefix, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        if self._old_prefix is None:
            self.addCleanup(os.environ.pop, "HOMEBREW_PREFIX", None)
        else:
            self.addCleanup(os.environ.__setitem__, "HOMEBREW_PREFIX",
                            self._old_prefix)

    def _link_opt(self, name):
        link = kegstash.opt_link()
        os.makedirs(os.path.dirname(link), exist_ok=True)
        if os.path.islink(link):
            os.unlink(link)
        os.symlink(os.path.join("..", "Cellar", "omlx-dev", name), link)


class TestStash(KegstashTestCase):
    def test_stash_copies_and_records_meta(self):
        _make_keg(self.prefix, "HEAD-aaa1111", "aaa1111")
        self._link_opt("HEAD-aaa1111")
        r = kegstash.stash(root=self.root)
        self.assertEqual(r["name"], "HEAD-aaa1111")
        self.assertTrue(os.path.isfile(
            os.path.join(r["path"], "payload.txt")))
        meta = json.load(open(os.path.join(r["path"], "uplift-kegstash.json")))
        self.assertEqual(meta["sha"], "aaa1111")
        self.assertIn(meta["method"], ("clone", "copy"))
        self.assertGreater(meta["bytes"], 0)

    def test_stash_idempotent(self):
        _make_keg(self.prefix, "HEAD-bbb2222", "bbb2222")
        self._link_opt("HEAD-bbb2222")
        first = kegstash.stash(root=self.root)
        second = kegstash.stash(root=self.root)
        self.assertEqual(second["method"], "exists")
        self.assertEqual(first["path"], second["path"])

    def test_no_active_keg_raises(self):
        with self.assertRaises(FileNotFoundError):
            kegstash.stash(root=self.root)


class TestListPrune(KegstashTestCase):
    def _three(self):
        for i, sha in enumerate(("c" * 7, "b" * 7, "a" * 7)):
            name = f"HEAD-{sha}"
            _make_keg(self.prefix, name, sha)
            self._link_opt(name)
            kegstash.stash(root=self.root)
            # distinct stashed_at so newest-first ordering is deterministic
            meta_path = os.path.join(kegstash.kegs_root(self.root),
                                     "omlx-dev", name, "uplift-kegstash.json")
            meta = json.load(open(meta_path))
            meta["stashed_at"] = f"2026-09-2{i}T00:00:00+00:00"
            json.dump(meta, open(meta_path, "w"))

    def test_list_newest_first(self):
        self._three()
        rows = kegstash.list_stashes(root=self.root)
        # stamped in loop order: c=09-20 (oldest) ... a=09-22 (newest)
        self.assertEqual([r["name"] for r in rows],
                         ["HEAD-" + "a" * 7, "HEAD-" + "b" * 7,
                          "HEAD-" + "c" * 7])

    def test_prune_keeps_newest_and_never_the_active(self):
        self._three()
        # newest (a) always survives; b is past --keep=1 and gets pruned
        # even though...
        self._link_opt("HEAD-" + "c" * 7)
        # ...c is also past --keep but is the ACTIVE keg: spared regardless
        removed = kegstash.prune(root=self.root, keep=1)
        self.assertIn("HEAD-" + "b" * 7, removed)
        self.assertNotIn("HEAD-" + "a" * 7, removed)
        names = [r["name"] for r in kegstash.list_stashes(root=self.root)]
        self.assertIn("HEAD-" + "a" * 7, names)


class TestActivate(KegstashTestCase):
    def setUp(self):
        super().setUp()
        # the .pth remount resolves via `brew --prefix` (ignores our fake
        # prefix) — stub it so tests never write into the real dev keg
        from omlx_uplift import cli

        self._old_mount = cli._mount_into_dev_keg
        cli._mount_into_dev_keg = lambda: True
        self.addCleanup(setattr, cli, "_mount_into_dev_keg", self._old_mount)

    def test_switch_reinstalls_at_original_cellar_path(self):
        old = kegstash.running_pids
        kegstash.running_pids = lambda formula="omlx-dev": []
        self.addCleanup(setattr, kegstash, "running_pids", old)
        cellar_a = _make_keg(self.prefix, "HEAD-" + "1" * 8, "1" * 8)
        self._link_opt("HEAD-" + "1" * 8)
        kegstash.stash(root=self.root)
        # brew reinstall destroyed the outgoing keg:
        shutil.rmtree(cellar_a)
        _make_keg(self.prefix, "HEAD-" + "2" * 8, "2" * 8)
        self._link_opt("HEAD-" + "2" * 8)
        r = kegstash.activate("1" * 8, root=self.root)  # sha prefix form
        self.assertEqual(r["name"], "HEAD-" + "1" * 8)
        # the U19 shebang invariant: files exist AGAIN at the baked path
        self.assertTrue(os.path.isfile(os.path.join(cellar_a, "payload.txt")))
        with open(os.path.join(cellar_a, "bin", "omlx-dev")) as fh:
            self.assertIn(cellar_a, fh.readline())
        self.assertEqual(os.path.realpath(kegstash.opt_link()),
                         os.path.realpath(cellar_a))

    def test_unknown_sha_raises(self):
        _make_keg(self.prefix, "HEAD-" + "3" * 8, "3" * 8)
        self._link_opt("HEAD-" + "3" * 8)
        with self.assertRaises(FileNotFoundError):
            kegstash.activate("deadbeef", root=self.root)

    def test_refuses_bad_shebang(self):
        cellar = _make_keg(self.prefix, "HEAD-" + "4" * 8, "4" * 8)
        self._link_opt("HEAD-" + "4" * 8)
        kegstash.stash(root=self.root)
        # corrupt the STASH copy so the shebang escapes its own cellar
        stashed = os.path.join(kegstash.kegs_root(self.root), "omlx-dev",
                               "HEAD-" + "4" * 8)
        with open(os.path.join(stashed, "bin", "omlx-dev"), "w") as fh:
            fh.write("#!/nope/python3.11\n")
        shutil.rmtree(cellar)
        with self.assertRaises(RuntimeError):
            kegstash.activate("HEAD-" + "4" * 8, root=self.root)

    def test_refuses_while_server_running(self):
        _make_keg(self.prefix, "HEAD-" + "5" * 8, "5" * 8)
        self._link_opt("HEAD-" + "5" * 8)
        kegstash.stash(root=self.root)
        old = kegstash.running_pids
        kegstash.running_pids = lambda formula="omlx-dev": [4242]
        self.addCleanup(setattr, kegstash, "running_pids", old)
        with self.assertRaises(RuntimeError):
            kegstash.activate("HEAD-" + "5" * 8, root=self.root)
        # --force overrides the guard
        r = kegstash.activate("HEAD-" + "5" * 8, root=self.root, force=True)
        self.assertEqual(r["name"], "HEAD-" + "5" * 8)


class TestCliSurface(unittest.TestCase):
    def test_dev_actions_advertised(self):
        from omlx_uplift import help as helpmod

        usage = helpmod.COMMAND_USAGE["dev"]
        for verb in ("dev kegs", "dev stash-keg", "dev use", "dev prune"):
            self.assertIn(verb, usage)


if __name__ == "__main__":
    unittest.main()
