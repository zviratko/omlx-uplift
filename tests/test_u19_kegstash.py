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
        # DEV-13: per-BUILD identity — stash name = keg name + time key,
        # cellar_name carries the shebang-anchor Cellar address.
        self.assertTrue(r["name"].startswith("HEAD-aaa1111_"), r["name"])
        self.assertEqual(r["cellar_name"], "HEAD-aaa1111")
        self.assertTrue(os.path.isfile(
            os.path.join(r["path"], "payload.txt")))
        meta = json.load(open(os.path.join(r["path"], "uplift-kegstash.json")))
        self.assertEqual(meta["sha"], "aaa1111")
        self.assertEqual(meta["cellar_name"], "HEAD-aaa1111")
        self.assertIn(meta["method"], ("clone", "copy"))
        self.assertGreater(meta["bytes"], 0)

    def test_same_sha_double_stash_leaves_two_entries(self):
        """DEV-13 AC1: the 'exists' no-op is gone — reinstalling at the
        SAME commit must still leave a rollback-able artifact."""
        cellar = _make_keg(self.prefix, "HEAD-bbb2222", "bbb2222")
        self._link_opt("HEAD-bbb2222")
        first = kegstash.stash(root=self.root)
        with open(os.path.join(cellar, "payload.txt"), "w") as fh:
            fh.write("rebuilt")            # same sha, different bytes
        second = kegstash.stash(root=self.root)
        self.assertNotEqual(first["path"], second["path"])
        self.assertNotEqual(second["method"], "exists")
        self.assertEqual(first["cellar_name"], second["cellar_name"])
        # both independently restorable
        rows = kegstash.list_stashes(root=self.root)
        self.assertEqual(len(rows), 2)

    def test_no_active_keg_raises(self):
        with self.assertRaises(FileNotFoundError):
            kegstash.stash(root=self.root)


class TestListPrune(KegstashTestCase):
    def _three(self):
        names = []
        for i, sha in enumerate(("c" * 7, "b" * 7, "a" * 7)):
            name = f"HEAD-{sha}"
            _make_keg(self.prefix, name, sha)
            self._link_opt(name)
            r = kegstash.stash(root=self.root)
            names.append(r["name"])
            # distinct stashed_at so newest-first ordering is deterministic
            meta_path = os.path.join(r["path"], "uplift-kegstash.json")
            meta = json.load(open(meta_path))
            meta["stashed_at"] = f"2026-09-2{i}T00:00:00+00:00"
            json.dump(meta, open(meta_path, "w"))
        return names

    def test_list_newest_first(self):
        self._three()
        rows = kegstash.list_stashes(root=self.root)
        # stamped in loop order: c=09-20 (oldest) ... a=09-22 (newest)
        self.assertEqual([r["cellar_name"] for r in rows],
                         ["HEAD-" + "a" * 7, "HEAD-" + "b" * 7,
                          "HEAD-" + "c" * 7])

    def test_prune_keeps_newest_and_never_the_active(self):
        self._three()
        # newest (a) always survives; b is past --keep=1 and gets pruned
        # even though...
        self._link_opt("HEAD-" + "c" * 7)
        # ...c is also past --keep but its CELLAR slot is the ACTIVE keg:
        # spared regardless (DEV-13: guard compares cellar_name, the
        # stash dir itself carries a time suffix now)
        removed = kegstash.prune(root=self.root, keep=1)
        rem_shas = [n.split("_")[0] for n in removed]
        self.assertIn("HEAD-" + "b" * 7, rem_shas)
        self.assertNotIn("HEAD-" + "a" * 7, rem_shas)
        names = [r["cellar_name"] for r in kegstash.list_stashes(root=self.root)]
        self.assertIn("HEAD-" + "a" * 7, names)
        self.assertIn("HEAD-" + "c" * 7, names)

    def test_prune_active_guard_survives_time_keyed_names(self):
        """DEV-13 AC3: a stash whose cellar slot IS the active keg must
        never be pruned even though name != active_keg() any more."""
        _make_keg(self.prefix, "HEAD-" + "d" * 7, "d" * 7)
        self._link_opt("HEAD-" + "d" * 7)
        mine = kegstash.stash(root=self.root)
        # four older filler stashes so `mine` lands past keep=1... make
        # mine OLDEST by re-stamping, active slot still HEAD-ddddddddd
        meta_path = os.path.join(mine["path"], "uplift-kegstash.json")
        meta = json.load(open(meta_path))
        meta["stashed_at"] = "2026-01-01T00:00:00+00:00"
        json.dump(meta, open(meta_path, "w"))
        for i, sha in enumerate(("e" * 7, "f" * 7)):
            _make_keg(self.prefix, "HEAD-" + sha, sha)
            r = kegstash.stash(name="HEAD-" + sha, root=self.root)
            mp = os.path.join(r["path"], "uplift-kegstash.json")
            m2 = json.load(open(mp)); m2["stashed_at"] = f"2026-06-0{i}T00:00:00+00:00"
            json.dump(m2, open(mp, "w"))
        removed = kegstash.prune(root=self.root, keep=1)
        self.assertNotIn(mine["name"], removed)
        self.assertTrue(os.path.isdir(mine["path"]))

    def test_prune_default_reads_devjson_config(self):
        """DEV-13 AC3: `keg_stash_keep` in dev.json drives the default;
        clamp to 1..20; fall back to DEFAULT_KEEP when unset."""
        from omlx_uplift import devsrc

        old = devsrc.load_config
        self.addCleanup(setattr, devsrc, "load_config", old)
        for cfg, want in (({}, 5), ({"keg_stash_keep": 2}, 2),
                          ({"keg_stash_keep": 0}, 1),
                          ({"keg_stash_keep": 99}, 20),
                          ({"keg_stash_keep": "x"}, 5)):
            devsrc.load_config = lambda c=cfg: dict(c)
            self.assertEqual(kegstash.stash_keep(), want)
        devsrc.load_config = lambda: (_ for _ in ()).throw(RuntimeError("no cfg"))
        self.assertEqual(kegstash.stash_keep(), 5)

    def test_prune_explicit_keep_beats_config(self):
        from omlx_uplift import devsrc

        old = devsrc.load_config
        self.addCleanup(setattr, devsrc, "load_config", old)
        devsrc.load_config = lambda: {"keg_stash_keep": 20}
        # keep=0 from CLI clamp? prune(keep=2) must slice at 2, not config
        self._three()
        self._link_opt("HEAD-" + "a" * 7)
        removed = kegstash.prune(root=self.root, keep=2)
        self.assertEqual(len(removed), 1)


class TestActivate(KegstashTestCase):
    def setUp(self):
        super().setUp()
        # the .pth remount resolves via `brew --prefix` (ignores our fake
        # prefix) — stub it so tests never write into the real dev keg
        from omlx_uplift import cli

        self._old_mount = cli._mount_into_dev_keg
        cli._mount_into_dev_keg = lambda: True
        self.addCleanup(setattr, cli, "_mount_into_dev_keg", self._old_mount)
        old = kegstash.running_pids
        kegstash.running_pids = lambda formula="omlx-dev": []
        self.addCleanup(setattr, kegstash, "running_pids", old)

    def _stamp(self, path, when):
        meta_path = os.path.join(path, "uplift-kegstash.json")
        meta = json.load(open(meta_path))
        meta["stashed_at"] = when
        json.dump(meta, open(meta_path, "w"))

    def test_switch_reinstalls_at_original_cellar_path(self):
        cellar_a = _make_keg(self.prefix, "HEAD-" + "1" * 8, "1" * 8)
        self._link_opt("HEAD-" + "1" * 8)
        r1 = kegstash.stash(root=self.root)
        # brew reinstall destroyed the outgoing keg:
        shutil.rmtree(cellar_a)
        _make_keg(self.prefix, "HEAD-" + "2" * 8, "2" * 8)
        self._link_opt("HEAD-" + "2" * 8)
        r = kegstash.activate(r1["name"], root=self.root)  # exact build name
        self.assertEqual(r["name"], r1["name"])
        self.assertEqual(r["cellar_name"], "HEAD-" + "1" * 8)
        # the U19 shebang invariant: files exist AGAIN at the baked path
        self.assertTrue(os.path.isfile(os.path.join(cellar_a, "payload.txt")))
        with open(os.path.join(cellar_a, "bin", "omlx-dev")) as fh:
            self.assertIn(cellar_a, fh.readline())
        self.assertEqual(os.path.realpath(kegstash.opt_link()),
                         os.path.realpath(cellar_a))

    def test_bare_sha_picks_newest_build_of_that_sha(self):
        """DEV-13 AC2: two builds share one sha — `dev use <sha>` = the
        newest, `dev use <full build name>` = exactly it."""
        sha = "9" * 8
        cellar = _make_keg(self.prefix, "HEAD-" + sha, sha)
        self._link_opt("HEAD-" + sha)
        first = kegstash.stash(root=self.root)
        self._stamp(first["path"], "2026-09-01T00:00:00+00:00")
        with open(os.path.join(cellar, "payload.txt"), "w") as fh:
            fh.write("build2")
        second = kegstash.stash(root=self.root)
        self._stamp(second["path"], "2026-09-02T00:00:00+00:00")
        r = kegstash.activate("HEAD-" + sha, root=self.root)   # bare sha
        self.assertEqual(r["name"], second["name"], "newest build wins")
        with open(os.path.join(cellar, "payload.txt")) as fh:
            self.assertEqual(fh.read(), "build2")
        r = kegstash.activate(first["name"], root=self.root)   # exact name
        self.assertEqual(r["name"], first["name"])
        with open(os.path.join(cellar, "payload.txt")) as fh:
            self.assertEqual(fh.read(), sha)     # older bytes restored

    def test_activate_replaces_stale_slot_build(self):
        """DEV-13 AC2 drill: the Cellar slot holds build A of sha S while
        build B of the SAME sha is activated — activate must REPLACE the
        slot, not silently keep A (the `if not isdir` hole)."""
        sha = "7" * 8
        name = "HEAD-" + sha
        cellar = _make_keg(self.prefix, name, sha)
        self._link_opt(name)
        a = kegstash.stash(root=self.root)
        self._stamp(a["path"], "2026-09-01T00:00:00+00:00")
        with open(os.path.join(cellar, "payload.txt"), "w") as fh:
            fh.write("B")
        b = kegstash.stash(root=self.root)
        self._stamp(b["path"], "2026-09-02T00:00:00+00:00")
        # slot currently holds B-bytes; activate A explicitly
        r = kegstash.activate(a["name"], root=self.root)
        self.assertEqual(r["cellar_name"], name)
        with open(os.path.join(cellar, "payload.txt")) as fh:
            self.assertEqual(fh.read(), sha, "slot replaced with A bytes")

    def test_legacy_untagged_stash_entry_still_activates(self):
        """Rollback compat: entries stashed pre-DEV-13 have no
        cellar_name — the name IS the cellar address."""
        name = "HEAD-" + "6" * 8
        cellar = _make_keg(self.prefix, name, "6" * 8)
        self._link_opt(name)
        kegstash.stash(root=self.root)
        # rewrite the newest entry back to the legacy shape
        rows = kegstash.list_stashes(root=self.root)
        p = rows[0]["path"]
        meta = json.load(open(os.path.join(p, "uplift-kegstash.json")))
        meta.pop("cellar_name")
        meta["name"] = name
        json.dump(meta, open(os.path.join(p, "uplift-kegstash.json"), "w"))
        os.rename(p, os.path.join(os.path.dirname(p), name))
        r = kegstash.activate("HEAD-" + "6" * 8, root=self.root)
        self.assertEqual(r["cellar_name"], name)
        self.assertTrue(os.path.isfile(os.path.join(
            kegstash.cellar_dir(), name, "payload.txt")))

    def test_unknown_sha_raises(self):
        _make_keg(self.prefix, "HEAD-" + "3" * 8, "3" * 8)
        self._link_opt("HEAD-" + "3" * 8)
        with self.assertRaises(FileNotFoundError):
            kegstash.activate("deadbeef", root=self.root)

    def test_refuses_bad_shebang(self):
        cellar = _make_keg(self.prefix, "HEAD-" + "4" * 8, "4" * 8)
        self._link_opt("HEAD-" + "4" * 8)
        r = kegstash.stash(root=self.root)
        # corrupt the STASH copy so the shebang escapes its own cellar
        with open(os.path.join(r["path"], "bin", "omlx-dev"), "w") as fh:
            fh.write("#!/nope/python3.11\n")
        shutil.rmtree(cellar)
        with self.assertRaises(RuntimeError):
            kegstash.activate(r["name"], root=self.root)

    def test_refuses_while_server_running(self):
        _make_keg(self.prefix, "HEAD-" + "5" * 8, "5" * 8)
        self._link_opt("HEAD-" + "5" * 8)
        r0 = kegstash.stash(root=self.root)
        kegstash.running_pids = lambda formula="omlx-dev": [4242]
        with self.assertRaises(RuntimeError):
            kegstash.activate(r0["name"], root=self.root)
        # --force overrides the guard
        r = kegstash.activate(r0["name"], root=self.root, force=True)
        self.assertEqual(r["name"], r0["name"])


class TestCliSurface(unittest.TestCase):
    def test_dev_actions_advertised(self):
        from omlx_uplift import help as helpmod

        usage = helpmod.COMMAND_USAGE["dev"]
        for verb in ("dev kegs", "dev stash-keg", "dev use", "dev prune"):
            self.assertIn(verb, usage)


if __name__ == "__main__":
    unittest.main()
