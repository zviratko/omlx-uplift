"""PATCH-REBASE (user 2026-11-12): a build patch that no longer applies
onto the new base must come with the command that fixes it, and for the
user's own (upload) patches that command is `patch rebase`.

Covers:
  * rebase_patch: context-only drift merges clean -> stored as vN+1 with
    tested_base = the new base, desired promoted, worktree removed;
  * a real conflict stops with the file list and keeps the worktree;
    --continue after the edit stores vN+1; leftover markers are refused;
  * catalog / PR sources are refused with their own command;
  * fix_hint wording per source kind;
  * the CLI PATCH FAILED prompt prints the fix line;
  * a dashboard (no resolver) abort carries the fix in its reason.

All fixtures local (git init + file:// clones): no network, no Homebrew.
"""

import io
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

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


BASE = ("import os\nimport sys\n\n\ndef f():\n    a = 1\n    b = 2\n"
        "    return 1\n\n\ndef g():\n    return 2\n")


class RebaseFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-rebase-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._old_home = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "data")
        self.addCleanup(self._restore_home)
        self.work = os.path.join(self.tmp, "remote-work")
        os.makedirs(os.path.join(self.work, "omlx"))
        _git(["init", "-q", "-b", "main"], cwd=self.work)
        self._write(BASE)
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
        devsrc.ensure_clone(self.cfg)
        devsrc.fetch_sync_ref(self.cfg)
        p = mock.patch.object(devsrc, "load_config", return_value=self.cfg)
        p.start()
        self.addCleanup(p.stop)

    def _restore_home(self):
        if self._old_home is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old_home

    def _write(self, text):
        with open(os.path.join(self.work, "omlx", "k.py"), "w") as fh:
            fh.write(text)

    def _patch_diff(self, new_text):
        """A real git diff (blob ids included, like every stored upload)
        of the work tree at its current base -> new_text."""
        self._write(new_text)
        out = subprocess.run(["git", "diff", "--binary"], cwd=self.work,
                             capture_output=True).stdout
        _git(["checkout", "--", "."], cwd=self.work)
        return out

    def _advance(self, text, msg="upstream moves"):
        self._write(text)
        _commit_all(self.work, msg)
        _git(["push", "-q", self.remote, "main"], cwd=self.work)

    def _store(self, pid, diff, source=None, **extra):
        store = PatchStore(self.base_dir)
        man = empty_manifest()
        pf = store.patch_file(pid, 1)
        os.makedirs(os.path.dirname(pf), exist_ok=True)
        with open(pf, "wb") as fh:
            fh.write(diff)
        entry = {"id": pid, "enabled": True, "order": 100,
                 "source": source or {"kind": "upload"},
                 "desired_version": 1, "scope": "dev", "state": "applied",
                 "versions": [{"v": 1, "content_sha256": "0" * 64,
                               "patch_file": os.path.relpath(
                                   pf, self.base_dir)}]}
        entry.update(extra)
        man["patches"].append(entry)
        store.save(man)
        return store

    def _new_base(self):
        return _git(["rev-parse", "refs/remotes/origin/main"],
                    cwd=self.cfg["src_path"]).strip()


class RebaseTests(RebaseFixture):
    def test_context_shift_rebases_clean_and_promotes(self):
        # patch changes the body of f(); upstream then edits the def line,
        # which sits inside the hunk's context: strict apply refuses the
        # old bytes, a 3-way merge does not
        diff = self._patch_diff(BASE.replace("    return 1\n",
                                             "    x = 5\n    return x\n"))
        store = self._store("own", diff)
        self._advance(BASE.replace("def f():", "def f() -> int:"))
        from omlx_uplift import diffapply
        devsrc.fetch_sync_ref(self.cfg)
        wt0 = os.path.join(self.tmp, "probe")
        _git(["worktree", "add", "--detach", "-q", wt0, self._new_base()],
             cwd=self.cfg["src_path"])
        self.assertFalse(diffapply.check_diff(diff, wt0).get("ok"))
        _git(["worktree", "remove", "--force", wt0], cwd=self.cfg["src_path"])
        r = devsrc.rebase_patch(store, "own", "")
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(r["rebased_from"], 1)
        base = self._new_base()
        self.assertEqual(r["base"], base)
        p = store.find(store.load(), "own")
        self.assertEqual(p["desired_version"], 2)
        v2 = store.get_version(p, 2)
        self.assertEqual(v2.get("tested_base"), base)
        with open(os.path.join(self.base_dir, v2["patch_file"]), "rb") as fh:
            data = fh.read()
        self.assertIn(b"+    x = 5", data)
        self.assertIn(b" def f() -> int:", data)   # new context is in
        self.assertFalse(os.path.exists(devsrc.rebase_dir(store, "own")))
        self.assertNotIn("file_set_changed", r)

    def test_conflict_stops_then_continue_stores(self):
        diff = self._patch_diff(BASE.replace("    return 1\n",
                                             "    return 10\n"))
        store = self._store("own", diff)
        self._advance(BASE.replace("    return 1\n", "    return 100\n"))
        r = devsrc.rebase_patch(store, "own", "")
        self.assertFalse(r["ok"])
        self.assertEqual(r["stage"], "conflict")
        self.assertEqual(r["conflicts"], ["omlx/k.py"])
        self.assertIn("--continue", r["reason"])
        wt = devsrc.rebase_dir(store, "own")
        self.assertTrue(os.path.isdir(wt))
        # nothing stored yet
        self.assertEqual(store.find(store.load(), "own")["desired_version"], 1)

        # --continue with the markers still in place is refused
        r2 = devsrc.rebase_patch(store, "own", "", cont=True)
        self.assertFalse(r2["ok"])
        self.assertEqual(r2["stage"], "conflict")

        # the human decides: keep upstream's 100 and add the patch idea
        with open(os.path.join(wt, "omlx", "k.py"), "w") as fh:
            fh.write(BASE.replace("    return 1\n",
                                  "    return 100 + 10\n"))
        r3 = devsrc.rebase_patch(store, "own", "", cont=True)
        self.assertTrue(r3.get("ok"), r3)
        p = store.find(store.load(), "own")
        self.assertEqual(p["desired_version"], 2)
        self.assertFalse(os.path.exists(wt))

    def test_continue_without_rebase_in_progress(self):
        store = self._store("own", self._patch_diff(BASE + "z = 1\n"))
        r = devsrc.rebase_patch(store, "own", "", cont=True)
        self.assertFalse(r["ok"])
        self.assertIn("no rebase of own is in progress", r["reason"])

    def test_compile_error_is_refused(self):
        store = self._store("own", self._patch_diff(BASE + "def broken(:\n"))
        self._advance("# header\n" + BASE)
        r = devsrc.rebase_patch(store, "own", "")
        self.assertFalse(r["ok"])
        self.assertEqual(r["stage"], "compile")
        self.assertEqual(store.find(store.load(), "own")["desired_version"], 1)

    def test_catalog_and_online_sources_refused_with_their_command(self):
        diff = self._patch_diff(BASE + "z = 1\n")
        store = self._store("cat", diff, curated="default")
        r = devsrc.rebase_patch(store, "cat", "")
        self.assertFalse(r["ok"])
        self.assertIn("dev upgrade", r["reason"])
        store = self._store("pr", diff, source={"kind": "github_pr",
                                                "repo": "jundot/omlx",
                                                "pr": 1})
        r = devsrc.rebase_patch(store, "pr", "")
        self.assertFalse(r["ok"])
        self.assertIn("omlx-uplift patch update pr", r["reason"])


class FixHintTests(RebaseFixture):
    def test_hint_per_kind(self):
        diff = self._patch_diff(BASE + "z = 1\n")
        s = self._store("a", diff)
        self.assertIn("omlx-uplift patch rebase a", patchsource.fix_hint(s, "a"))
        s = self._store("b", diff, curated="default")
        self.assertIn("dev upgrade", patchsource.fix_hint(s, "b"))
        s = self._store("b", diff, curated="default", curated_adopted=True)
        self.assertIn("patch rebase b", patchsource.fix_hint(s, "b"))
        s = self._store("c", diff, source={"kind": "github_pr",
                                           "repo": "jundot/omlx", "pr": 7})
        h = patchsource.fix_hint(s, "c")
        self.assertIn("jundot/omlx#7", h)
        self.assertIn("patch update c", h)
        s = self._store("d", diff, source={"kind": "url", "url": "http://x"})
        self.assertIn("patch update d", patchsource.fix_hint(s, "d"))
        self.assertEqual(patchsource.fix_hint(s, "nope"), "")

    def test_cli_prompt_prints_fix_line(self):
        from omlx_uplift import cli
        self._store("own", self._patch_diff(BASE + "z = 1\n"))
        buf = io.StringIO()
        with redirect_stdout(buf), \
                mock.patch("builtins.input", return_value="2"):
            ans = cli._patch_failure_prompt("own", "does not apply", [1])
        self.assertEqual(ans, "abort")
        self.assertIn("fix: run 'omlx-uplift patch rebase own'",
                      buf.getvalue())

    def test_dashboard_abort_reason_carries_fix(self):
        diff = self._patch_diff(BASE.replace("    return 1\n",
                                             "    return 10\n"))
        store = self._store("own", diff)
        self._advance(BASE.replace("    return 1\n", "    return 100\n"))
        devsrc.fetch_sync_ref(self.cfg)
        res = devsrc.materialize(
            [{"id": "own", "version": 1, "diff_bytes": diff}], self.cfg)
        self.assertFalse(res["ok"])
        self.assertIn("fix: run 'omlx-uplift patch rebase own'",
                      res["reason"])
        self.assertIsNotNone(store)


if __name__ == "__main__":
    unittest.main()
