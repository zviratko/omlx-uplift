"""PAT-1 unit tests: strict diff applier + patch manifest (stdlib only).

Fixtures: two real jundot/omlx PR diffs (#3764, #3765) vendored under
tests/fixtures with small reconstructed pre-image trees.
"""

import hashlib
import json
import os
import shutil
import tempfile
import unittest

from omlx_uplift import diffapply, patches

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


class TempTree(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat1-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.tree = os.path.join(self.tmp, "site-packages-fake", "omlx")
        os.makedirs(self.tree, exist_ok=True)
        self.backup = os.path.join(self.tmp, "backup")


class TestParse(TempTree):
    def _write(self, rel, data):
        path = os.path.join(self.tree, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def test_reject_empty(self):
        r = diffapply.parse_diff(b"")
        self.assertFalse(r["ok"])
        self.assertIn("empty", r["reason"])

    def test_reject_not_a_diff(self):
        r = diffapply.parse_diff(b"hello world\n")
        self.assertFalse(r["ok"])

    def test_reject_binary(self):
        diff = (b"diff --git a/omlx/x.png b/omlx/x.png\n"
                b"Binary files a/omlx/x.png and b/omlx/x.png differ\n")
        r = diffapply.parse_diff(diff)
        self.assertFalse(r["ok"])
        self.assertIn("binary", r["reason"])

    def test_reject_mode_change(self):
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                b"old mode 100644\nnew mode 100755\n"
                b"--- a/omlx/x.py\n+++ b/omlx/x.py\n"
                b"@@ -1,1 +1,1 @@\n-a\n+b\n")
        r = diffapply.parse_diff(diff)
        self.assertFalse(r["ok"])
        self.assertIn("mode", r["reason"])

    def test_reject_rename(self):
        diff = (b"diff --git a/omlx/a.py b/omlx/b.py\n"
                b"similarity index 90%\nrename from omlx/a.py\nrename to omlx/b.py\n"
                b"--- a/omlx/a.py\n+++ b/omlx/b.py\n@@ -1,1 +1,1 @@\n-a\n+b\n")
        r = diffapply.parse_diff(diff)
        self.assertFalse(r["ok"])
        self.assertIn("rename", r["reason"])

    def test_reject_hunk_count_mismatch(self):
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                b"--- a/omlx/x.py\n+++ b/omlx/x.py\n@@ -1,3 +1,3 @@\n-a\n+b\n")
        r = diffapply.parse_diff(diff)
        self.assertFalse(r["ok"])


class TestHeaderFormats(TempTree):
    """Diff header recognition: git, GNU `diff -ruN`, plain unified pairs,
    patch(1)/svn 'Index:' — all must parse to the same (path, hunks)."""

    BODY = b"@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n tail\n"

    def _check(self, name, diff, path, nfiles=1):
        r = diffapply.parse_diff(diff)
        self.assertTrue(r["ok"], f"{name}: {r['reason']}")
        self.assertEqual(len(r["files"]), nfiles, name)
        self.assertEqual(r["files"][0]["path"], path, name)
        self.assertEqual(r["files"][0]["action"], "modify", name)
        self.assertEqual(len(r["files"][0]["hunks"]), 1, name)

    def test_gnu_diff_runuN(self):
        diff = (b"diff -ruN a/mlx_embeddings/m.py b/mlx_embeddings/m.py\n"
                b"--- a/mlx_embeddings/m.py\t2026-09-18 13:31:27 +0200\n"
                b"+++ b/mlx_embeddings/m.py\t2026-09-18 15:40:17 +0200\n"
                + self.BODY)
        self._check("gnu", diff, "mlx_embeddings/m.py")

    def test_plain_unified_pair(self):
        diff = (b"--- a/omlx/x.py\t2026\n+++ b/omlx/x.py\t2026\n" + self.BODY)
        self._check("plain", diff, "omlx/x.py")

    def test_patch_index_style(self):
        diff = (b"Index: omlx/x.py\n"
                b"===================================================================\n"
                b"--- omlx/x.py\n+++ omlx/x.py\n" + self.BODY)
        self._check("index", diff, "omlx/x.py")

    def test_svn_reverse_order(self):
        diff = (b"Index: omlx/x.py\n"
                b"===================================================================\n"
                b"--- omlx/x.py\t(revision 1)\n+++ omlx/x.py\t(revision 2)\n"
                + self.BODY)
        self._check("svnrev", diff, "omlx/x.py")

    def test_multi_file_gnu(self):
        d1 = (b"--- a/omlx/a.py\n+++ b/omlx/a.py\n" + self.BODY)
        d2 = (b"--- a/mlx_embeddings/b.py\n+++ b/mlx_embeddings/b.py\n" + self.BODY)
        r = diffapply.parse_diff(d1 + d2)
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual([f["path"] for f in r["files"]],
                         ["omlx/a.py", "mlx_embeddings/b.py"])

    def test_git_format_patch_email(self):
        # `git format-patch` output: From/Subject/diffstat preamble before
        # the first 'diff --git', '-- <version>' trailer after the last hunk
        email = (b"From bdbdecb5 Mon Sep 17 00:00:00 2001\n"
                 b"From: Jan Schermer <jan@example.cz>\n"
                 b"Date: Sat, 19 Sep 2026 20:40:08 +0200\n"
                 b"Subject: [PATCH 2/2] feat(admin): live-apply something\n"
                 b"\n"
                 b"---\n"
                 b" omlx/routes.py | 4 +++-\n"
                 b" 1 file changed, 3 insertions(+), 1 deletion(-)\n"
                 b"\n"
                 b"diff --git a/omlx/routes.py b/omlx/routes.py\n"
                 b"index 19a05b80..7df1462d 100644\n"
                 b"--- a/omlx/routes.py\n+++ b/omlx/routes.py\n"
                 + self.BODY +
                 b"-- \n2.54.0 (Apple Git-157)\n")
        r = diffapply.parse_diff(email)
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual([f["path"] for f in r["files"]], ["omlx/routes.py"])
        self.assertEqual(len(r["files"][0]["hunks"]), 1)

    def test_preamble_with_stray_hunk_still_rejected(self):
        # a @@ before ANY file header means headerless content -> reject
        r = diffapply.parse_diff(b"Subject: x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n")
        self.assertFalse(r["ok"])

    def test_gnu_applies_and_restores(self):
        # the whole point: a diff -ruN patch against site-packages siblings
        src = os.path.join(self.tree, "mlx_embeddings")
        os.makedirs(src)
        target = os.path.join(src, "m.py")
        with open(target, "wb") as fh:
            fh.write(b"ctx\nold\ntail\n")
        diff = (b"diff -ruN a/mlx_embeddings/m.py b/mlx_embeddings/m.py\n"
                b"--- a/mlx_embeddings/m.py\t2026\n"
                b"+++ b/mlx_embeddings/m.py\t2026\n" + self.BODY)
        r = diffapply.apply_diff(diff, self.tree, os.path.join(self.tree, ".bak"))
        self.assertTrue(r["ok"], r.get("reason"))
        self.assertEqual(open(target, "rb").read(), b"ctx\nnew\ntail\n")
        rb = diffapply.restore_backup(os.path.join(self.tree, ".bak"), self.tree)
        self.assertTrue(rb["ok"], rb.get("reason"))
        self.assertEqual(open(target, "rb").read(), b"ctx\nold\ntail\n")


class TestApplyRoundTrip(TempTree):
    def test_real_pr3764_roundtrip(self):
        self._roundtrip("pr3764.diff", "base3764")

    def test_real_pr3765_roundtrip_multifile(self):
        self._roundtrip("pr3765.diff", "base3765")

    def _roundtrip(self, diff_name, base_name):
        diff = read(os.path.join(FIX, diff_name))
        base = os.path.join(FIX, base_name)
        tree = os.path.join(self.tmp, "tree-" + base_name, "omlx")
        shutil.copytree(os.path.join(base, "omlx"), tree)
        root = os.path.dirname(tree)

        pre = diffapply.check_diff(diff, root)
        self.assertTrue(pre["ok"], pre["reason"])

        applied = diffapply.apply_diff(diff, root, self.backup)
        self.assertTrue(applied["ok"], applied["reason"])
        self.assertTrue(all(f["status"] == "applied" for f in applied["files"]))

        # idempotence: re-check sees 'already', re-apply is a no-op
        post = diffapply.check_diff(diff, root)
        self.assertTrue(all(f["status"] == "already" for f in post["files"]))

        # rollback byte-exact against the pristine fixture tree
        restored = diffapply.restore_backup(self.backup, root)
        self.assertTrue(restored["ok"], restored["reason"])
        for dirpath, _dirs, files in os.walk(tree):
            for name in files:
                got = os.path.join(dirpath, name)
                want = os.path.join(base, "omlx", os.path.relpath(got, tree))
                self.assertEqual(read(got), read(want), got)

    def test_conflict_structured_fail_no_writes(self):
        diff = read(os.path.join(FIX, "pr3764.diff"))
        os.makedirs(os.path.join(self.tree, "admin"), exist_ok=True)
        target = os.path.join(self.tree, "admin", "routes.py")
        with open(target, "wb") as fh:
            fh.write(b"totally different\ncontent\n")
        root = os.path.dirname(self.tree)
        res = diffapply.apply_diff(diff, root, self.backup)
        self.assertFalse(res["ok"])
        self.assertIn("context mismatch", res["reason"])
        self.assertEqual(read(target), b"totally different\ncontent\n")
        self.assertFalse(os.path.isdir(self.backup))  # all-or-nothing: no backups

    def test_offset_search(self):
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                b"--- a/omlx/x.py\n+++ b/omlx/x.py\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")
        os.makedirs(os.path.join(self.tree), exist_ok=True)
        with open(os.path.join(self.tree, "x.py"), "wb") as fh:
            fh.write(b"pad\npad2\na\nb\nc\n")  # real hunk at +2
        root = os.path.dirname(self.tree)
        res = diffapply.apply_diff(diff, root, self.backup)
        self.assertTrue(res["ok"], res["reason"])
        self.assertEqual(read(os.path.join(self.tree, "x.py")),
                         b"pad\npad2\na\nB\nc\n")

    def test_zero_fuzz_context_must_match_exactly(self):
        # one context line differs -> strict reject, zero fuzz
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                b"--- a/omlx/x.py\n+++ b/omlx/x.py\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")
        with open(os.path.join(self.tree, "x.py"), "wb") as fh:
            fh.write(b"a\nb\nCHANGED\n")
        root = os.path.dirname(self.tree)
        res = diffapply.check_diff(diff, root)
        self.assertFalse(res["ok"])

    def test_crlf_preserved(self):
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\r\n"
                b"--- a/omlx/x.py\r\n+++ b/omlx/x.py\r\n"
                b"@@ -1,3 +1,4 @@\r\n a\r\n-b\r\n+B2\r\n+B3\r\n c\r\n")
        with open(os.path.join(self.tree, "x.py"), "wb") as fh:
            fh.write(b"a\r\nb\r\nc\r\n")
        root = os.path.dirname(self.tree)
        res = diffapply.apply_diff(diff, root, self.backup)
        self.assertTrue(res["ok"], res["reason"])
        out = read(os.path.join(self.tree, "x.py"))
        self.assertEqual(out, b"a\r\nB2\r\nB3\r\nc\r\n")

    def test_no_trailing_newline_preserved(self):
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                b"--- a/omlx/x.py\n+++ b/omlx/x.py\n"
                b"@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n")
        with open(os.path.join(self.tree, "x.py"), "wb") as fh:
            fh.write(b"a\nb\n")
        root = os.path.dirname(self.tree)
        res = diffapply.apply_diff(diff, root, self.backup)
        self.assertTrue(res["ok"], res["reason"])
        out = read(os.path.join(self.tree, "x.py"))
        self.assertEqual(out, b"a\nB")

    def test_create_and_delete(self):
        diff = (b"diff --git a/omlx/new.py b/omlx/new.py\n"
                b"new file mode 100644\n--- /dev/null\n+++ b/omlx/new.py\n"
                b"@@ -0,0 +1,2 @@\n+hello\n+world\n"
                b"diff --git a/omlx/gone.py b/omlx/gone.py\n"
                b"deleted file mode 100644\n--- a/omlx/gone.py\n+++ /dev/null\n"
                b"@@ -1,1 +0,0 @@\n-x\n")
        with open(os.path.join(self.tree, "gone.py"), "wb") as fh:
            fh.write(b"x\n")
        root = os.path.dirname(self.tree)
        res = diffapply.apply_diff(diff, root, self.backup)
        self.assertTrue(res["ok"], res["reason"])
        self.assertEqual(read(os.path.join(self.tree, "new.py")), b"hello\nworld\n")
        self.assertFalse(os.path.exists(os.path.join(self.tree, "gone.py")))
        rest = diffapply.restore_backup(self.backup, root)
        self.assertTrue(rest["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.tree, "new.py")))
        self.assertEqual(read(os.path.join(self.tree, "gone.py")), b"x\n")


class TestRecordPristineBackup(TempTree):
    """'Revert in memory, store as backup' — the adoption path."""

    def _setup_applied(self):
        diff = read(os.path.join(FIX, "pr3764.diff"))
        base = os.path.join(FIX, "base3764")
        tree = os.path.join(self.tmp, "t", "omlx")
        shutil.copytree(os.path.join(base, "omlx"), tree)
        root = os.path.dirname(tree)
        vanilla = read(os.path.join(base, "omlx", "admin", "routes.py"))
        self.assertTrue(diffapply.apply_diff(diff, root,
                                             os.path.join(self.tmp, "b0"))["ok"])
        return diff, root, tree, vanilla

    def test_reversed_backup_restores_vanilla(self):
        diff, root, tree, vanilla = self._setup_applied()
        bdir = os.path.join(self.tmp, "b1")
        res = diffapply.record_pristine_backup(diff, root, bdir)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["grounded"])
        # nothing was written to the tree by recording
        self.assertNotEqual(read(os.path.join(tree, "admin", "routes.py")),
                            vanilla)
        r = diffapply.restore_backup(bdir, root)
        self.assertTrue(r["ok"], r)
        self.assertEqual(read(os.path.join(tree, "admin", "routes.py")),
                         vanilla)

    def test_ungrounded_when_tree_not_patched(self):
        diff = read(os.path.join(FIX, "pr3764.diff"))
        base = os.path.join(FIX, "base3764")
        tree = os.path.join(self.tmp, "t2", "omlx")
        shutil.copytree(os.path.join(base, "omlx"), tree)
        root = os.path.dirname(tree)
        bdir = os.path.join(self.tmp, "b2")
        res = diffapply.record_pristine_backup(diff, root, bdir)
        self.assertTrue(res["ok"])
        self.assertFalse(res["grounded"])  # reverse cannot match a vanilla file
        # recorded as non-existent is WRONG here — must not claim existed=False
        import json
        meta = json.load(open(os.path.join(bdir, "meta.json")))
        self.assertEqual(meta["files"], {})

    def test_idempotent_first_touch_wins(self):
        diff, root, tree, vanilla = self._setup_applied()
        bdir = os.path.join(self.tmp, "b3")
        diffapply.record_pristine_backup(diff, root, bdir)
        first = read(os.path.join(bdir, "files", "omlx", "admin", "routes.py"))
        # a second record must not overwrite the first pristine image
        with open(os.path.join(tree, "admin", "routes.py"), "ab") as fh:
            fh.write(b"# later edit\n")
        diffapply.record_pristine_backup(diff, root, bdir)
        self.assertEqual(
            read(os.path.join(bdir, "files", "omlx", "admin", "routes.py")),
            first)


class TestPathSafety(TempTree):
    def test_safe_join_rules(self):
        root = self.tree
        cases = [
            ("omlx/admin/routes.py", True),
            ("../escape.py", False),
            ("/etc/passwd", False),
            ("a/../b/x.py", False),      # '..' rejected wholesale (strict)
            ("", False),
            ("omlx_uplift/router.py", False),  # never patch ourselves
            ("omlx\\windows.py", False),
        ]
        for rel, ok in cases:
            path, why = diffapply.safe_join(root, rel)
            self.assertEqual(path is not None, ok, f"{rel}: {why}")

    def test_symlink_escape_rejected(self):
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside, exist_ok=True)
        link = os.path.join(self.tree, "link_target")
        os.symlink(outside, link)
        path, why = diffapply.safe_join(self.tree, "link_target/x.py")
        self.assertIsNone(path)
        self.assertIn("symlink", why)

    def test_diff_with_unsafe_path_fails_check(self):
        diff = (b"diff --git a/../evil.py b/../evil.py\n"
                b"--- a/../evil.py\n+++ b/../evil.py\n@@ -1,1 +1,1 @@\n-a\n+b\n")
        res = diffapply.check_diff(diff, self.tmp)
        self.assertFalse(res["ok"])


class TestManifest(TempTree):
    def setUp(self):
        super().setUp()
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _patch(self, pid="p1", state="pending"):
        return {"id": pid, "enabled": True, "order": 10, "state": state,
                "desired_version": 1, "versions": [{"v": 1}]}

    def test_empty_manifest_defaults(self):
        m = self.store.load()
        self.assertEqual(m["patches"], [])
        self.assertIs(m["config"]["auto_update_check"], False)

    def test_corrupt_manifest_loads_empty_with_error(self):
        os.makedirs(self.store.base_dir)
        with open(self.store.manifest_path, "w") as fh:
            fh.write("{not json")
        m = self.store.load()
        self.assertEqual(m["patches"], [])
        self.assertIn("load_error", m)

    def test_save_is_atomic_and_readable(self):
        m = self.store.load()
        m["patches"].append(self._patch())
        self.store.save(m)
        again = self.store.load()
        self.assertEqual(again["patches"][0]["id"], "p1")
        # no leftover temp files
        leftovers = [f for f in os.listdir(self.store.base_dir)
                     if f.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_concurrent_style_reload_sees_last_write(self):
        m = self.store.load()
        m["config"]["auto_update_check"] = True
        self.store.save(m)
        m2 = self.store.load()
        m2["config"]["auto_update_check"] = False
        self.store.save(m2)
        self.assertIs(self.store.load()["config"]["auto_update_check"], False)

    def test_state_transitions_table(self):
        p = self._patch(state="pending")
        self.assertTrue(self.store.set_state(p, "applied"))
        # applied -> pending is legal (rollback re-arm); applied->obsolete ok
        self.assertTrue(self.store.set_state(p, "obsolete"))
        # obsolete -> applied is NOT legal (must re-enable through pending)
        self.assertFalse(self.store.set_state(p, "applied"))
        self.assertEqual(p["state"], "obsolete")
        # unknown state
        self.assertFalse(self.store.set_state(self._patch(), "banana"))

    def test_warning_badge_logic(self):
        m = self.store.load()
        p = self._patch(state="applied")
        m["patches"] = [p]
        self.assertFalse(self.store.warning_active(m))
        self.store.set_state(p, "needs_review", "keg changed")
        self.assertTrue(self.store.warning_active(m))

    def test_kill_switches(self):
        store = self.store
        os.makedirs(store.base_dir, exist_ok=True)
        self.assertFalse(store.patches_disabled())
        with open(store.sentinel_path, "w") as fh:
            fh.write("")
        self.assertTrue(store.patches_disabled())
        os.remove(store.sentinel_path)
        os.environ["OMLX_UPLIFT_NO_PATCHES"] = "1"
        try:
            self.assertTrue(store.patches_disabled())
        finally:
            del os.environ["OMLX_UPLIFT_NO_PATCHES"]
        self.assertFalse(store.patches_disabled())

    def test_keg_id_stable_and_version_sensitive(self):
        root = os.path.join(self.tmp, "site-packages-fake", "omlx")
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, "version.py"), "w") as fh:
            fh.write("__version__ = '1.0'\n")
        k1 = patches.keg_id(root)
        self.assertEqual(k1, patches.keg_id(root))
        with open(os.path.join(root, "version.py"), "w") as fh:
            fh.write("__version__ = '1.1'\n")
        k2 = patches.keg_id(root)
        self.assertNotEqual(k1, k2)
        self.assertIn("site-packages-fake:", k2)

    def test_prune_keeps_newest_and_applied(self):
        m = self.store.load()
        p = {"id": "prune-me", "state": "applied", "desired_version": 1,
             "versions": []}
        os.makedirs(self.store.patches_dir, exist_ok=True)
        for v in range(1, 6):
            pf = self.store.patch_file("prune-me", v)
            with open(pf, "wb") as fh:
                fh.write(b"diff\n")
            ver = {"v": v, "patch_file": patches.rel(pf, self.store.base_dir)}
            if v == 1:
                ver["applied"] = {"keg_id": "x"}
            p["versions"].append(ver)
        m["patches"] = [p]
        # shrink cap deterministically
        old_cap = patches.MAX_VERSIONS_PER_PATCH
        patches.MAX_VERSIONS_PER_PATCH = 3
        try:
            removed = patches.prune_versions(m, self.store)
        finally:
            patches.MAX_VERSIONS_PER_PATCH = old_cap
        kept = [v["v"] for v in m["patches"][0]["versions"]]
        self.assertIn(1, kept)          # applied always kept
        self.assertIn(5, kept)          # newest kept
        self.assertNotIn(2, kept)
        self.assertTrue(any("prune-me.v2.diff" in r for r in removed))


class TestValidationHelpers(TempTree):
    """Pieces the PAT-2 gate relies on: parse strictly, verify honestly."""

    def test_multi_file_partial_ok_reports_per_file(self):
        # routes.py hunk ok, added fake second file missing -> per-file fail
        diff = (read(os.path.join(FIX, "pr3764.diff")) +
                b"diff --git a/omlx/ghost.py b/omlx/ghost.py\n"
                b"--- a/omlx/ghost.py\n+++ b/omlx/ghost.py\n@@ -1,1 +1,1 @@\n-x\n+y\n")
        root = os.path.join(self.tmp, "root")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(root, "omlx"))
        res = diffapply.check_diff(diff, root)
        self.assertFalse(res["ok"])
        by = {f["path"]: f["status"] for f in res["files"]}
        self.assertEqual(by["omlx/admin/routes.py"], "ok")
        self.assertEqual(by["omlx/ghost.py"], "fail")

    def test_backup_first_touch_wins(self):
        diff = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                b"--- a/omlx/x.py\n+++ b/omlx/x.py\n@@ -1,1 +1,1 @@\n-v1\n+v2\n")
        target = os.path.join(self.tree, "x.py")
        with open(target, "wb") as fh:
            fh.write(b"v1\n")
        root = os.path.dirname(self.tree)
        self.assertTrue(diffapply.apply_diff(diff, root, self.backup)["ok"])
        # simulate source update v2->v3 applied on top
        diff2 = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
                 b"--- a/omlx/x.py\n+++ b/omlx/x.py\n@@ -1,1 +1,1 @@\n-v2\n+v3\n")
        self.assertTrue(diffapply.apply_diff(diff2, root, self.backup)["ok"])
        # restore returns to PRISTINE v1 (first-touch backup), not v2
        self.assertTrue(diffapply.restore_backup(self.backup, root)["ok"])
        self.assertEqual(read(target), b"v1\n")


if __name__ == "__main__":
    unittest.main()
