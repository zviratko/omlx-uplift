"""DEV-2 tests: dev-src repository manager + materializer.

All fixtures are local (git init --bare "remote" + file:// clone): no
network, no Homebrew. Covers: ensure_clone + drift guard, materialize
commits (one per patch, attribution line), abort on a bad patch, re-
materialize dropping a disabled patch, hand-commit drift detection, and
origin URL checks refusing unknown remotes.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

from omlx_uplift import devsrc


def _git(args, cwd=None, check=True):
    p = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise AssertionError(f"git {args}: {p.stderr}")
    return p.stdout


def _commit_all(repo, msg):
    _git(["add", "-A"], cwd=repo)
    _git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
          "-m", msg], cwd=repo)


def _make_unified_diff(path, old_text, new_text):
    """Minimal single-file unified diff: every old line as context, the
    extra new lines as additions (strict-applier friendly)."""
    old_lines = old_text.splitlines(keepends=True)
    new_lines = new_text.splitlines(keepends=True)
    out = [f"diff --git a/{path} b/{path}\n",
           f"--- a/{path}\n", f"+++ b/{path}\n",
           f"@@ -1,{len(old_lines)} +1,{len(new_lines)} @@\n"]
    out += [" " + ln for ln in old_lines]
    out += ["+" + ln for ln in new_lines[len(old_lines):]]
    return "".join(out).encode()


class DevsrcFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-dev2-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # "remote" bare repo with a fake kernel csrc file + python module
        self.work = os.path.join(self.tmp, "remote-work")
        os.makedirs(self.work)
        _git(["init", "-q", "-b", "main"], cwd=self.work)
        os.makedirs(os.path.join(self.work, "omlx", "custom_kernels", "k",
                                 "csrc"))
        with open(os.path.join(self.work, "omlx", "k.py"), "w") as fh:
            fh.write("import Metal\nKERNELS = {}\n")
        with open(os.path.join(self.work, "omlx", "custom_kernels", "k",
                               "csrc", "k.mm"), "w") as fh:
            fh.write("kernel one\nkernel two\n")
        _commit_all(self.work, "base")
        self.remote = os.path.join(self.tmp, "remote.git")
        _git(["clone", "-q", "--bare", self.work, self.remote])
        self.base_dir = os.path.join(self.tmp, "data")
        self.cfg = {
            "origin": "file://" + self.remote,
            "upstream": "file://" + self.remote,
            "sync_ref": "origin/main",
            "formula_branch": devsrc.DEV_BRANCH_DEFAULT,
            "src_path": os.path.join(self.base_dir, "dev-src"),
        }

    # -- diffs --------------------------------------------------------------
    def _patch_diff(self, pid):
        """A build-scope diff: both a csrc/ hunk and a python hunk."""
        kmm = os.path.join(self.work, "omlx", "custom_kernels", "k", "csrc",
                           "k.mm")
        kp = os.path.join(self.work, "omlx", "k.py")
        return (
            f"diff --git a/omlx/custom_kernels/k/csrc/k.mm "
            f"b/omlx/custom_kernels/k/csrc/k.mm\n"
            f"--- a/omlx/custom_kernels/k/csrc/k.mm\n"
            f"+++ b/omlx/custom_kernels/k/csrc/k.mm\n"
            f"@@ -1,2 +1,3 @@\n kernel one\n kernel two\n+patched {pid}\n"
            f"diff --git a/omlx/k.py b/omlx/k.py\n"
            f"--- a/omlx/k.py\n+++ b/omlx/k.py\n"
            f"@@ -1,2 +1,3 @@\n import Metal\n KERNELS = {{}}\n"
            f"+EXTRA_{pid} = 1\n").encode()

    def _broken_diff(self):
        return (b"diff --git a/omlx/k.py b/omlx/k.py\n"
                b"--- a/omlx/k.py\n+++ b/omlx/k.py\n"
                b"@@ -1,2 +1,3 @@\n import Metal\n GARBAGE = 1\n"
                b"+WILL_NOT_MATCH = 1\n")

    # -- tests --------------------------------------------------------------
    def test_formula_branch_seeding_lets_brew_clone(self):
        """The bug this guards: bare `brew install omlx-dev` does
        `git clone --branch uplift-dev file://.../dev-src` and dies with
        git-128 when the branch does not exist yet (post-bootstrap,
        pre-install). bootstrap seeds it at the sync tip."""
        path = devsrc.ensure_clone(self.cfg)
        # fresh clone: the formula branch must NOT exist yet
        self.assertIsNone(devsrc._rev_parse(devsrc.DEV_BRANCH_DEFAULT, path))
        devsrc.fetch_sync_ref(self.cfg)
        sha = devsrc.ensure_formula_branch(self.cfg)
        self.assertTrue(sha)
        # idempotent: never re-cut (materialize owns that)
        self.assertIsNone(devsrc.ensure_formula_branch(self.cfg))
        # the EXACT clone brew runs now succeeds
        dest = os.path.join(self.tmp, "brew-cache-clone")
        _git(["clone", "--branch", devsrc.DEV_BRANCH_DEFAULT,
              "file://" + path, dest])
        tip = _git(["rev-parse", "HEAD"], cwd=dest).strip()
        self.assertEqual(tip, sha)

    def test_ensure_clone_sets_remotes(self):
        path = devsrc.ensure_clone(self.cfg)
        self.assertTrue(os.path.isdir(os.path.join(path, ".git")))
        self.assertEqual(_git(["remote"], cwd=path).split(),
                         ["origin", "upstream"])
        self.assertEqual(
            _git(["remote", "get-url", "origin"], cwd=path).strip(),
            "file://" + self.remote)

    def test_origin_drift_refuses(self):
        path = devsrc.ensure_clone(self.cfg)
        # someone repoints the clone under our feet
        _git(["remote", "set-url", "origin", "https://example.com/other.git"],
             cwd=path)
        with self.assertRaises(devsrc.DevsrcError) as ctx:
            devsrc.ensure_clone(self.cfg)
        self.assertIn("drifted", str(ctx.exception))
        # fetch also refuses through ensure_clone path used by upgrade
        with self.assertRaises(devsrc.DevsrcError):
            devsrc.fetch_sync_ref(dict(self.cfg))

    def test_materialize_one_commit_per_patch(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        patches = [{"id": "p-one", "version": 1,
                    "diff_bytes": self._patch_diff("one")},
                   {"id": "p-two", "version": 2,
                    "diff_bytes": self._patch_diff("two")}]
        r = devsrc.materialize(patches, self.cfg)
        self.assertTrue(r["ok"], r)
        st = devsrc.status(self.cfg, patches)
        self.assertEqual(st["ahead"], 2)
        self.assertEqual(st["behind"], 0)
        self.assertEqual([c["id"] for c in st["patch_commits"]],
                         ["p-one", "p-two"])
        self.assertFalse(st["drift"]["drift"], st["drift"])
        # commit message carries the attribution line
        body = _git(["log", "-1", "--format=%B"], cwd=devsrc.src_path(self.cfg))
        self.assertIn("Made under human guidelines", body)
        # the diff really landed in the worktree
        tip_tree = _git(["show", f"{r['tip']}:omlx/custom_kernels/k/csrc/k.mm"],
                        cwd=devsrc.src_path(self.cfg))
        self.assertIn("patched one", tip_tree)
        self.assertIn("patched two", tip_tree)

    def test_expected_tip_matches_materialize(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        patches = [{"id": "p-one", "version": 1,
                    "diff_bytes": self._patch_diff("one")}]
        r = devsrc.materialize(patches, self.cfg)
        exp = devsrc.expected_tip(patches, self.cfg)
        self.assertTrue(exp["ok"], exp)
        self.assertEqual(exp["tip"], r["tip"])

    def test_disable_patch_then_rematerialize_drops_commit(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        both = [{"id": "p-one", "version": 1,
                 "diff_bytes": self._patch_diff("one")},
                {"id": "p-two", "version": 1,
                 "diff_bytes": self._patch_diff("two")}]
        devsrc.materialize(both, self.cfg)
        only_one = both[:1]
        r = devsrc.materialize(only_one, self.cfg)
        self.assertTrue(r["ok"], r)
        st = devsrc.status(self.cfg, only_one)
        self.assertEqual(st["ahead"], 1)
        self.assertEqual([c["id"] for c in st["patch_commits"]], ["p-one"])
        self.assertFalse(st["drift"]["drift"])
        # branch content no longer carries p-two
        blob = _git(["show", f"{r['tip']}:omlx/k.py"],
                    cwd=devsrc.src_path(self.cfg))
        self.assertNotIn("EXTRA_two", blob)

    def test_broken_patch_aborts_whole_pass(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        first = {"id": "p-good", "version": 1,
                 "diff_bytes": self._patch_diff("good")}
        ok = devsrc.materialize([first], self.cfg)
        self.assertTrue(ok["ok"])
        bad = {"id": "p-bad", "version": 1, "diff_bytes": self._broken_diff()}
        r = devsrc.materialize([first, bad], self.cfg)
        self.assertFalse(r["ok"])
        self.assertIn("p-bad", r["reason"])
        st = devsrc.status(self.cfg, [first])
        # branch sits at its previous tip: exactly the good patch remains
        self.assertEqual(st["ahead"], 1)
        self.assertEqual([c["id"] for c in st["patch_commits"]], ["p-good"])
        # worktree is clean, not half-applied
        self.assertTrue(devsrc.worktree_clean(devsrc.src_path(self.cfg)))

    def test_hand_commit_flags_drift(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        patches = [{"id": "p-one", "version": 1,
                    "diff_bytes": self._patch_diff("one")}]
        devsrc.materialize(patches, self.cfg)
        src = devsrc.src_path(self.cfg)
        _git(["checkout", "-q", devsrc.DEV_BRANCH_DEFAULT], cwd=src)
        with open(os.path.join(src, "omlx", "hand.py"), "w") as fh:
            fh.write("sneaky = True\n")
        _commit_all(src, "hand edit")
        st = devsrc.status(self.cfg, patches)
        self.assertTrue(st["drift"]["drift"], st["drift"])
        self.assertIn("hand.py", st["drift"]["detail"])

    def test_stale_patch_version_flags_drift(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        patches = [{"id": "p-one", "version": 1,
                    "diff_bytes": self._patch_diff("one")}]
        devsrc.materialize(patches, self.cfg)
        # the patch gets a NEW version upstream; branch still has v1 content
        newer = self._patch_diff("one").replace(b"EXTRA_one = 1",
                                                b"EXTRA_one = 2")
        st = devsrc.status(self.cfg,
                           [{"id": "p-one", "version": 2,
                             "diff_bytes": newer}])
        self.assertTrue(st["drift"]["drift"], st["drift"])

    def test_fetch_only_configured_sync_ref(self):
        devsrc.ensure_clone(self.cfg)
        cfg = dict(self.cfg, sync_ref="elsewhere/main")
        with self.assertRaises(devsrc.DevsrcError):
            devsrc.fetch_sync_ref(cfg)

    def test_install_config_and_save_load(self):
        cfg = devsrc.install_config(yes=True, origin="file://" + self.remote,
                                    base_dir=self.base_dir)
        self.assertEqual(cfg["sync_ref"], "origin/main")
        loaded = devsrc.load_config(base_dir=self.base_dir)
        self.assertEqual(loaded["origin"], "file://" + self.remote)
        path = devsrc.ensure_clone(loaded)
        self.assertTrue(os.path.isdir(path))


    # -- DEV-7 base pin -------------------------------------------------------
    def _advance_upstream(self, n=2):
        """Push n new commits onto the remote's main and fetch them."""
        shas = []
        for i in range(n):
            with open(os.path.join(self.work, "omlx", "k.py"), "a") as fh:
                fh.write(f"# advance {i}\n")
            _commit_all(self.work, f"advance {i}")
            _git(["push", "-q", self.remote, "main"], cwd=self.work)
            shas.append(_git(["rev-parse", "HEAD"], cwd=self.work).strip())
        return shas

    def test_base_pin_changes_materialize_base(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        base1 = devsrc.base_sha_of(self.cfg)          # follows sync ref
        shas = self._advance_upstream(2)
        devsrc.fetch_sync_ref(self.cfg)
        self.assertEqual(devsrc.base_sha_of(self.cfg), shas[-1])
        # pin to the OLDER commit: base must stop following
        cfg = dict(self.cfg, base_pin=shas[0])
        self.assertEqual(devsrc.base_sha_of(cfg), shas[0])
        r = devsrc.materialize([], cfg)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["base"], shas[0])

    def test_base_pin_rejects_unknown_commit(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        cfg = dict(self.cfg, base_pin="deadbeef" * 5)
        with self.assertRaises(devsrc.DevsrcError):
            devsrc.base_sha_of(cfg)
        r = devsrc.materialize([], cfg)
        self.assertFalse(r["ok"])
        self.assertIn("base pin", r["reason"])

    def test_recent_commits_lists_sync_ref_log(self):
        devsrc.ensure_clone(self.cfg)
        shas = self._advance_upstream(3)
        devsrc.fetch_sync_ref(self.cfg)
        commits = devsrc.recent_commits(self.cfg, limit=50)
        self.assertEqual(commits[0]["sha"], shas[-1])   # newest first
        self.assertEqual(len(commits), 4)               # base + 3 advances
        self.assertTrue(all(c["short"] and c["subject"] for c in commits))

    def test_status_reports_base_pin(self):
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        self.assertIsNone(devsrc.status(self.cfg)["base_pin"])
        st = devsrc.status(dict(self.cfg, base_pin="short"))
        # unresolvable pin surfaces as reason, not a crash
        self.assertIn("base pin", st.get("reason", ""))


if __name__ == "__main__":
    unittest.main()
