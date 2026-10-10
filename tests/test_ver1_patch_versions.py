"""VER-1 tests (user 2026-10-10): curated patch versions are tied to the
base commits they were tested against, and the dev materializer uses that.

Covers:
  * _store_version stamps tested_base (gate tree's HEAD) — checkout trees
    only; the sha-consistency rule is untouched (diff bytes identical).
  * base_distance: symmetric commit distance, None for unknown shas.
  * materialize ladder: desired version fails -> nearest-tested stored
    alternate is committed with fallback_from reported honestly.
  * materialize resolver: nothing applies -> 'skip' builds WITHOUT the
    patch (skipped_patches), anything else aborts the pass (pre-VER-1).
  * mark_dev_applied stamps the version that IS on the branch and says so
    in state_detail when it is not the desired one.

All fixtures local (git init + file:// clones): no network, no Homebrew.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from omlx_uplift import devsrc, patchsource
from omlx_uplift.patches import PatchStore, empty_manifest


def _git(args, cwd=None, check=True):
    p = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise AssertionError(f"git {args}: {p.stderr}")
    return p.stdout


def _commit_all(repo, msg):
    _git(["add", "-A"], cwd=repo)
    _git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
          "-m", msg], cwd=repo)


def _diff(path, old_lines, new_lines):
    out = [f"diff --git a/{path} b/{path}\n",
           f"--- a/{path}\n", f"+++ b/{path}\n",
           f"@@ -1,{len(old_lines)} +1,{len(new_lines)} @@\n"]
    out += [" " + ln for ln in old_lines]
    out += ["+" + ln for ln in new_lines[len(old_lines):]]
    return "".join(out).encode()


class Ver1Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-ver1-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # versions live under UPLIFT_HOME — redirect the store here
        self._old_home = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "data")
        self.addCleanup(self._restore_home)
        self.work = os.path.join(self.tmp, "remote-work")
        os.makedirs(self.work)
        _git(["init", "-q", "-b", "main"], cwd=self.work)
        os.makedirs(os.path.join(self.work, "omlx"))
        with open(os.path.join(self.work, "omlx", "k.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        _commit_all(self.work, "base")
        self.remote = os.path.join(self.tmp, "remote.git")
        _git(["clone", "-q", "--bare", self.work, self.remote])
        self.base_dir = os.path.join(self.tmp, "data")
        self.cfg = {
            "origin": "file://" + self.remote,
            "upstream": "file://" + self.remote,
            "sync_ref": "origin/main",
            "formula_branch": devsrc.DEV_BRANCH_DEFAULT,
            "src_path": os.path.join(self.tmp, "dev-src"),
        }

    def _restore_home(self):
        if self._old_home is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old_home

    # -- helpers -------------------------------------------------------------
    def _good_diff(self):
        return _diff("omlx/k.py",
                     ["import Metal\n", "KERNELS = {}\n"],
                     ["import Metal\n", "KERNELS = {}\n", "EXTRA = 1\n"])

    def _broken_diff(self):
        return _diff("omlx/k.py",
                     ["import Metal\n", "GARBAGE = 1\n"],
                     ["import Metal\n", "GARBAGE = 1\n", "WILL_NOT_MATCH = 1\n"])

    def _store_entry(self, pid, versions: dict, desired: int):
        """Write a manifest + diff files directly (no network, no gate):
        versions = {v: diff_bytes}."""
        store = PatchStore(self.base_dir)
        man = empty_manifest()
        entry = {"id": pid, "enabled": True, "order": 100,
                 "source": {"kind": "upload"}, "desired_version": desired,
                 "scope": "dev",
                 "state": "pending", "versions": []}
        for v, data in versions.items():
            pf = store.patch_file(pid, v)
            os.makedirs(os.path.dirname(pf), exist_ok=True)
            with open(pf, "wb") as fh:
                fh.write(data)
            entry["versions"].append(
                {"v": v, "content_sha256": "0" * 64,
                 "patch_file": os.path.relpath(pf, self.base_dir)})
        man["patches"].append(entry)
        store.save(man)
        return store

    def _advance_base(self, k_lines, msg="move on"):
        """Commit new content for omlx/k.py on the work repo and push it to
        the bare, then fetch into the dev-src clone so the materialize
        base moves past what the stored diffs were written against."""
        with open(os.path.join(self.work, "omlx", "k.py"), "w") as fh:
            fh.write("".join(k_lines))
        _commit_all(self.work, msg)
        _git(["push", "-q", self.remote, "main"], cwd=self.work)

    # -- tested_base stamping --------------------------------------------------
    def test_store_version_stamps_gate_tree_head(self):
        """Gating against a git checkout stamps the checkout's HEAD into
        the version entry; a non-repo tree stays untagged (honest
        absence)."""
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        clean = os.path.join(self.tmp, "clean-base")
        _git(["clone", "-q", self.cfg["src_path"], clean])
        head = _git(["rev-parse", "HEAD"], cwd=clean).strip()
        store = PatchStore(self.base_dir)
        r = patchsource.add_patch(store, "p-stamp",
                                  {"kind": "upload", "data": self._good_diff()},
                                  clean, scope="runtime")
        self.assertTrue(r["ok"], r)
        man = store.load()
        entry = store.find(man, "p-stamp")
        ver = store.get_version(entry, entry["desired_version"])
        self.assertEqual(ver.get("tested_base"), head)
        # bytes identity untouched: stored file is exactly the uploaded diff
        with open(os.path.join(self.base_dir, ver["patch_file"]), "rb") as fh:
            self.assertEqual(fh.read(), self._good_diff())

    def test_store_version_untagged_on_non_repo_tree(self):
        plain = os.path.join(self.tmp, "plain")
        os.makedirs(os.path.join(plain, "omlx"))
        with open(os.path.join(plain, "omlx", "k.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        store = PatchStore(self.base_dir)
        r = patchsource.add_patch(store, "p-plain",
                                  {"kind": "upload", "data": self._good_diff()},
                                  plain, scope="runtime")
        self.assertTrue(r["ok"], r)
        man = store.load()
        entry = store.find(man, "p-plain")
        ver = store.get_version(entry, entry["desired_version"])
        self.assertNotIn("tested_base", ver)

    def test_base_distance(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        path = self.cfg["src_path"]
        b1 = _git(["rev-parse", "refs/remotes/origin/main"], cwd=path).strip()
        self.assertEqual(devsrc.base_distance(path, b1, b1), 0)
        self._advance_base(["import Metal\n", "KERNELS = {}\n", "x = 1\n"])
        self._advance_base(["import Metal\n", "KERNELS = {}\n", "x = 1\n",
                            "y = 2\n"], "two")
        _git(["fetch", "-q", "origin"], cwd=path)
        b3 = _git(["rev-parse", "refs/remotes/origin/main"], cwd=path).strip()
        self.assertEqual(devsrc.base_distance(path, b1, b3), 2)
        self.assertEqual(devsrc.base_distance(path, b3, b1), 2)   # symmetric
        self.assertIsNone(devsrc.base_distance(path, "f" * 40, b1))
        self.assertIsNone(devsrc.base_distance(path, None, b1))

    # -- materialize ladder ----------------------------------------------------
    def test_materialize_falls_back_to_nearest_version(self):
        """v2 (desired) is broken on the moved base; v1 was tested against
        the OLD base and still applies to nothing after the base moved its
        context lines… the fixture keeps v1 VALID on the new base (the
        feature line is independent), which is exactly the real-world
        shape: an older diff whose context survived the move."""
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        path = self.cfg["src_path"]
        old_base = _git(["rev-parse", "refs/remotes/origin/main"],
                        cwd=path).strip()
        # store v1 = good bytes tested at old base; v2 = broken bytes
        store = self._store_entry("p-f",
                                  {1: self._good_diff(),
                                   2: self._broken_diff()}, desired=2)
        # stamp v1 the way _store_version does
        man = store.load()
        store.find(man, "p-f")["versions"][0]["tested_base"] = old_base
        store.save(man)
        # base moves: k.py grows a line AFTER the patched area context
        self._advance_base(["import Metal\n", "KERNELS = {}\n", "tail = 1\n"])
        devsrc.fetch_sync_ref(self.cfg)
        patches = [{"id": "p-f", "version": 2, "diff_bytes": self._broken_diff()}]
        r = devsrc.materialize(patches, self.cfg)
        self.assertTrue(r["ok"], r.get("reason"))
        c = [c for c in r["commits"] if c["id"] == "p-f"][0]
        self.assertEqual(c["v"], 1)
        self.assertEqual(c["fallback_from"], 2)
        self.assertTrue(c["sha"])
        # the committed tree really carries v1's content
        content = open(os.path.join(path, "omlx", "k.py")).read()
        self.assertIn("EXTRA = 1", content)

    def test_materialize_no_alternates_aborts_without_resolver(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        store = self._store_entry("p-x", {1: self._broken_diff()}, desired=1)
        patches = [{"id": "p-x", "version": 1,
                    "diff_bytes": self._broken_diff()}]
        r = devsrc.materialize(patches, self.cfg)
        self.assertFalse(r["ok"])
        self.assertEqual(r.get("failed_patch"), "p-x")

    def test_materialize_resolver_skip_builds_without_patch(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        self._store_entry("p-s", {1: self._broken_diff()}, desired=1)
        ok_bytes = self._good_diff()
        patches = [{"id": "p-s", "version": 1, "diff_bytes": self._broken_diff()},
                   {"id": "p-ok", "version": 1, "diff_bytes": ok_bytes}]
        asked = []

        def resolver(pid, reason, tried):
            asked.append((pid, list(tried)))
            return "skip"

        r = devsrc.materialize(patches, self.cfg, on_patch_failure=resolver)
        self.assertTrue(r["ok"], r.get("reason"))
        self.assertEqual(asked, [("p-s", [1])])
        self.assertEqual([s["id"] for s in r["skipped_patches"]], ["p-s"])
        ids = [c["id"] for c in r["commits"] if c.get("sha")]
        self.assertEqual(ids, ["p-ok"])    # the healthy patch still built

    def test_materialize_resolver_abort_aborts_pass(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        self._store_entry("p-s", {1: self._broken_diff()}, desired=1)
        patches = [{"id": "p-s", "version": 1, "diff_bytes": self._broken_diff()}]
        r = devsrc.materialize(patches, self.cfg,
                               on_patch_failure=lambda *a: "abort")
        self.assertFalse(r["ok"])
        self.assertEqual(r.get("failed_patch"), "p-s")
        self.assertFalse((r.get("commits") or []))

    # -- mark_dev_applied honesty ----------------------------------------------
    def test_mark_dev_applied_stamps_built_version(self):
        store = self._store_entry("p-m",
                                  {1: self._good_diff(),
                                   2: self._good_diff()}, desired=2)
        man = store.load()
        entry = store.find(man, "p-m")
        patchsource.mark_dev_applied(store, [{"id": "p-m", "v": 1,
                                              "sha": "a" * 40}])
        man = store.load()
        entry = store.find(man, "p-m")
        v1 = store.get_version(entry, 1)
        v2 = store.get_version(entry, 2)
        self.assertIn("dev_applied", v1)
        self.assertNotIn("dev_applied", v2)   # the branch does NOT carry v2
        self.assertEqual(entry["state"], "applied")
        self.assertIn("as v1", entry["state_detail"])
        self.assertIn("desired v2", entry["state_detail"])


if __name__ == "__main__":
    unittest.main()
