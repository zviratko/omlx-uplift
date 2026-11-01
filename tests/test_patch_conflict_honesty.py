"""P1-P4 (stress harness 2026-10-31): a patch collision must name the other
side, a stored candidate must be visible and explain itself, a removed build
patch must read as expected residue (not as a hand edit), and the apply
order must be the operator's choice, not an alphabetical accident.

Every test here reproduces a shape the operator hit live: an overlapping
pair after a local patch moved into the curated catalog, and the follow-up
'my sources don't match' / 'it fetched v2 but did nothing' reports.
"""
import difflib
import hashlib
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from omlx_uplift import devsrc, patches, patchsource, patchsync

SAY_BASE = (
    "import os\n"
    "MODE = \"builtin\"\n"
    "TAIL = 1\n"
)


def diff_say(mode):
    new = SAY_BASE.replace('MODE = "builtin"', f'MODE = "{mode}"')
    a = SAY_BASE.splitlines(keepends=True)
    b = new.splitlines(keepends=True)
    body = "".join(difflib.unified_diff(a, b, fromfile="a/omlx/say.py",
                                        tofile="b/omlx/say.py", n=3))
    return (f"diff --git a/omlx/say.py b/omlx/say.py\n"
            f"--- a/omlx/say.py\n+++ b/omlx/say.py\n{body}").encode()


def make_keg(tmp):
    root = os.path.join(tmp, "site-packages")
    os.makedirs(os.path.join(root, "omlx"))
    with open(os.path.join(root, "omlx", "_version.py"), "w") as fh:
        fh.write('VERSION = "1.0.0"\n')
    with open(os.path.join(root, "omlx", "say.py"), "w") as fh:
        fh.write(SAY_BASE)
    return root


def version_from(pid, v, data):
    return {"v": v, "content_sha256": hashlib.sha256(data).hexdigest(),
            "patch_file": f"patches/{pid}.v{v}.diff"}


def build_store(tmp, entries, blobs):
    store = patches.PatchStore(os.path.join(tmp, "uplift"))
    os.makedirs(store.patches_dir, exist_ok=True)
    for (pid, v), data in blobs.items():
        with open(store.patch_file(pid, v), "wb") as fh:
            fh.write(data)
    store.save({"version": 2, "config": {}, "patches": entries})
    return store


def entry(pid, diffs, order=100, enabled=True, scope="omlx", desired=1,
          state="pending", source=None, extra=None):
    return {"id": pid, "enabled": enabled, "order": order, "scope": scope,
            "desired_version": desired, "state": state,
            "source": source or {"kind": "upload", "data": "x"},
            "versions": [version_from(pid, i + 1, d)
                         for i, d in enumerate(diffs)],
            **(extra or {})}


def say_of(root):
    with open(os.path.join(root, "omlx", "say.py")) as fh:
        return fh.read()


class ConflictHintRuntime(unittest.TestCase):
    """P2a: the loser of a boot-mount collision is told WHO holds the lines
    and which control resolves it — 'context mismatch' alone sent the
    operator digging through every card."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = make_keg(self._tmp.name)
        dA, dB = diff_say("sayA"), diff_say("sayB")
        self.store = build_store(
            self._tmp.name,
            [entry("aaa-say", [dA]), entry("zzz-say", [dB])],
            {("aaa-say", 1): dA, ("zzz-say", 1): dB})

    def test_loser_names_the_winner_and_the_control(self):
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        p = self.store.find(self.store.load(), "zzz-say")
        self.assertEqual(p["state"], "needs_review")
        detail = p["state_detail"]
        self.assertIn("collides with enabled patch 'aaa-say'", detail)
        self.assertIn("omlx/say.py", detail)
        self.assertIn("Apply priority", detail)
        self.assertIn('MODE = "sayA"', say_of(self.root))

    def test_no_hint_without_an_applied_peer(self):
        # corrupt bytes with no peer (a hand edit of the file): the plain
        # strict-apply reason must NOT invent a collision partner
        man = self.store.load()
        q = self.store.find(man, "aaa-say")
        q["enabled"] = False
        self.store.save(man)
        with open(os.path.join(self.root, "omlx", "say.py"), "w") as fh:
            fh.write("import os\nMODE = \"hand\"\nTAIL = 1\n")
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        p = self.store.find(self.store.load(), "zzz-say")
        self.assertNotIn("collides with", p.get("state_detail") or "")

    def test_priority_beats_alphabetical_order(self):
        # P4 engine half: a LOWER order applies first — the store field the
        # new Manage control and CLI verb write is what decides the winner
        man = self.store.load()
        self.store.find(man, "zzz-say")["order"] = 50
        self.store.save(man)
        patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertIn('MODE = "sayB"', say_of(self.root))
        p = self.store.find(self.store.load(), "aaa-say")
        self.assertIn("collides with enabled patch 'zzz-say'",
                      p["state_detail"])


def git(args, cwd):
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@x", *args],
        cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def git_fixture(tmp):
    repo = os.path.join(tmp, "repo")
    os.makedirs(os.path.join(repo, "omlx"))
    git(["init", "-q"], repo)
    with open(os.path.join(repo, "omlx", "say.py"), "w") as fh:
        fh.write(SAY_BASE)
    git(["add", "-A"], repo)
    git(["commit", "-q", "-m", "base"], repo)
    base = git(["rev-parse", "HEAD"], repo)
    cfg = {"src_path": repo, "base_pin": base,
           "formula_branch": "uplift-dev", "sync_ref": "upstream/main",
           "origin": "file://" + repo}
    return repo, base, cfg


class ConflictHintMaterialize(unittest.TestCase):
    """P2b: the build blames the loser of a same-file pair; it must also
    name the earlier patch of the pass that took the lines."""

    def run_materialize(self, tmp, patches_list, resolver=None):
        repo, base, cfg = git_fixture(tmp)
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(tmp, "uplift")
        try:
            os.makedirs(os.environ["UPLIFT_HOME"], exist_ok=True)
            res = devsrc.materialize(patches_list, cfg,
                                     on_patch_failure=resolver)
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old
        return repo, base, res

    def test_abort_names_the_same_build_partner(self):
        tmp = tempfile.mkdtemp(dir=tempfile.gettempdir())
        repo, base, res = self.run_materialize(
            tmp, [{"id": "aaa-say", "version": 1, "diff_bytes": diff_say("a")},
                  {"id": "zzz-say", "version": 1, "diff_bytes": diff_say("b")}])
        self.assertFalse(res["ok"])
        self.assertEqual(res["failed_patch"], "zzz-say")
        self.assertIn("collides with 'aaa-say' v1", res["reason"])
        self.assertIn("omlx/say.py", res["reason"])

    def test_resolver_skip_record_names_the_partner(self):
        tmp = tempfile.mkdtemp(dir=tempfile.gettempdir())
        _repo, _base, res = self.run_materialize(
            tmp, [{"id": "aaa-say", "version": 1, "diff_bytes": diff_say("a")},
                  {"id": "zzz-say", "version": 1, "diff_bytes": diff_say("b")}],
            resolver=lambda pid, reason, tried: "skip")
        self.assertTrue(res["ok"])
        self.assertIn("collides with 'aaa-say'",
                      res["skipped_patches"][0]["reason"])


class RemovedBuildPatchIsNotHandContent(unittest.TestCase):
    """P3: remove a patch the branch carries and the build zone must keep a
    quiet 'retired' explanation (the operator's 'sure they don't match —
    I just removed it' complaint), and the tombstone expires with the next
    successful build."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.dA = diff_say("sayA")
        self.store = build_store(
            self.tmp,
            [entry("say-a", [self.dA], scope="both",
                   extra={"dev_applied_note": None})],
            {("say-a", 1): self.dA})
        # the dev_applied stamp lives on the VERSION (mark_dev_applied shape)
        man = self.store.load()
        ver = self.store.find(man, "say-a")["versions"][0]
        ver["dev_applied"] = {"at": patches.now_iso(), "sha": "0" * 40}
        self.store.save(man)
        self.repo, self.base, cfg = git_fixture(self.tmp)
        self.cfg = cfg
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "uplift")
        try:
            self.m = devsrc.materialize(
                patchsource.enabled_build_patches(self.store), cfg)
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old
        self.assertTrue(self.m["ok"])

    def _classify(self, enabled, residue):
        exp = devsrc.expected_tip(enabled, self.cfg)
        return devsrc.classify_build(self.repo, self.m["tip"], self.base,
                                     exp, enabled, residue)

    def test_remove_then_classify_is_quiet_residue_not_hand(self):
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "uplift")
        try:
            res = patchsource.remove_patch(self.store, "say-a", "")
            self.assertTrue(res["ok"])
            man = self.store.load()
            self.assertEqual(man.get("patches"), [])
            tomb = man.get("retired")
            self.assertTrue(tomb, "a carried build patch leaves a tombstone")
            self.assertEqual(tomb[0]["id"], "say-a")
            # the kept diff bytes explain the branch content
            residue = patchsource.build_residue_pool(self.store, [])
            self.assertEqual([r["id"] for r in residue], ["say-a"])
            self.assertTrue(residue[0].get("retired"))
            verdict = self._classify([], residue)
            self.assertFalse(verdict["needs_rebuild"],
                             "removed != hand-content alarm")
            self.assertTrue(verdict["build_ahead"])
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old

    def test_tombstone_bytes_that_stopped_matching_are_not_trusted(self):
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "uplift")
        try:
            patchsource.remove_patch(self.store, "say-a", "")
            # a re-added patch under the same id reuses the file path: the
            # tombstone must NOT vouch for foreign bytes
            with open(self.store.patch_file("say-a", 1), "wb") as fh:
                fh.write(b"totally different bytes")
            self.assertEqual(patchsource.build_residue_pool(self.store, []),
                             [])
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old

    def test_next_successful_build_expires_tombstones(self):
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "uplift")
        try:
            patchsource.remove_patch(self.store, "say-a", "")
            self.assertTrue(self.store.load().get("retired"))
            pf = self.store.patch_file("say-a", 1)
            self.assertTrue(os.path.exists(pf), "remove keeps the diff bytes")
            patchsource.mark_dev_applied(self.store, [])
            self.assertEqual(self.store.load().get("retired"), [])
            self.assertFalse(os.path.exists(pf), "the build swept the bytes")
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old

    def test_successful_build_preserves_readded_live_diff(self):
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "uplift")
        try:
            patchsource.remove_patch(self.store, "say-a", "")
            pf = self.store.patch_file("say-a", 1)
            live = entry("say-a", [diff_say("sayB")], scope="both")
            man = self.store.load()
            man["patches"] = [live]
            self.store.save(man)
            with open(pf, "wb") as fh:
                fh.write(diff_say("sayB"))
            patchsource.mark_dev_applied(self.store, [])
            self.assertEqual(self.store.load().get("retired"), [])
            self.assertTrue(os.path.exists(pf),
                            "tombstone cleanup must not delete a live re-add")
            with open(pf, "rb") as fh:
                self.assertEqual(fh.read(), diff_say("sayB"))
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old

    def test_retired_cap_preserves_live_path(self):
        man = self.store.load()
        retired = []
        for i in range(patchsource.RETIRED_CAP):
            pid = f"old-{i}"
            retired.append({"id": pid, "versions": [
                {"v": 1, "patch_file": f"patches/{pid}.v1.diff"}]})
        # The oldest tombstone points at the same v1 path as the LIVE patch.
        retired[0]["versions"][0]["patch_file"] = "patches/say-a.v1.diff"
        retired[0]["versions"].append({"v": 2, "patch_file": "patches/old-0.v2.diff"})
        man["retired"] = retired
        with open(self.store.patch_file("old-0", 2), "wb") as fh:
            fh.write(b"old")
        new = entry("new-build", [diff_say("sayB")], scope="both")
        new["versions"][0]["dev_applied"] = {"sha": "1" * 40}
        with open(self.store.patch_file("new-build", 1), "wb") as fh:
            fh.write(diff_say("sayB"))
        patchsource._tombstone_build_copies(man, self.store, new)
        self.assertEqual(len(man["retired"]), patchsource.RETIRED_CAP)
        self.assertTrue(os.path.exists(self.store.patch_file("say-a", 1)),
                        "cap eviction must not delete a live manifest path")
        self.assertFalse(os.path.exists(self.store.patch_file("old-0", 2)),
                         "unreferenced old bytes still expire")


class StoredCandidateMustBeVisible(unittest.TestCase):
    """P1: a patch stuck in needs_review/failed after a losing boot must
    still be able to show 'a newer version is stored' — the transition gate
    used to refuse the state and hide the Manage candidate row entirely."""

    def test_edges_are_legal(self):
        store = patches.PatchStore(os.path.join(tempfile.mkdtemp(), "up"))
        for start in ("needs_review", "failed", "obsolete"):
            p = {"id": f"e-{start}", "state": start}
            self.assertTrue(store.set_state(p, "update_available", "v2"),
                            f"{start} -> update_available must be legal")
            self.assertEqual(p["state"], "update_available")

    def test_check_all_reports_why_a_candidate_is_not_adopted(self):
        tmp = tempfile.mkdtemp()
        root = make_keg(tmp)
        d1, d2 = diff_say("sayA"), diff_say("sayB")
        store = build_store(
            tmp,
            [entry("say-a", [d1], source={"kind": "url",
                                          "url": "https://x/y.diff"})],
            {("say-a", 1): d1})
        holder = {"b": d2}
        with mock.patch.object(patchsource, "fetch_url",
                               lambda u, insecure_tls=False: {
                                   "ok": True, "data": holder["b"],
                                   "source_head_sha": None, "url": u}), \
             mock.patch.object(patchsource, "_pr_merged_into_base",
                               lambda *a, **k: False):
            rep = patchsource.check_all(store, root)["reports"]["say-a"]
        # a user patch (not curated, no auto update) never auto-adopts —
        # but it must SAY so, naming the action
        self.assertEqual(rep["check"], "update_available")
        self.assertFalse(rep["promoted"])
        self.assertIn("press Promote", rep.get("reason", ""))


class SetOrderVerb(unittest.TestCase):
    """P4: the store verb behind Manage/CLI — manifest-only, honest range
    check, and it must survive the store-write ordering trap (write lands
    in a FRESH load, not an in-memory copy)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = build_store(self._tmp.name,
                                 [entry("say-a", [diff_say("sayA")])], {})

    def test_round_trip(self):
        r = patchsource.set_order(self.store, "say-a", "42")
        self.assertTrue(r["ok"])
        self.assertEqual(r["previous"], 100)
        p = self.store.find(self.store.load(), "say-a")
        self.assertEqual(p["order"], 42)
        self.assertIn("next server restart", r["note"])

    def test_rejects_junk(self):
        for bad in ("x", -1, 10000, None):
            r = patchsource.set_order(self.store, "say-a", bad)
            self.assertFalse(r["ok"], f"{bad!r} must be rejected")
        self.assertFalse(
            patchsource.set_order(self.store, "ghost", 5)["ok"])

    def test_cli_order_needs_no_omlx_tree(self):
        # KILL-NOTREE contract: order writes only the manifest
        old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = os.path.join(self._tmp.name, "uplift")
        buf_out = __import__("io").StringIO()
        try:
            from omlx_uplift import cli
            with mock.patch("omlx_uplift.patches._omlx_root",
                            return_value=None), \
                 mock.patch("omlx_uplift.paths.brew_prefix_candidates",
                            return_value=[]), \
                 redirect_stdout(buf_out):
                rc = cli.cmd_patches(["order", "say-a", "7"])
        finally:
            if old is None:
                del os.environ["UPLIFT_HOME"]
            else:
                os.environ["UPLIFT_HOME"] = old
        self.assertEqual(rc, 0, buf_out.getvalue())
        p = self.store.find(self.store.load(), "say-a")
        self.assertEqual(p["order"], 7)


class NoOrphanRetiredOnRuntimeRemove(unittest.TestCase):
    """A plain runtime patch never touched the branch — removing it must not
    leave a tombstone (the residue pool stays honest, no phantom excuses)."""

    def test_runtime_remove_writes_no_tombstone(self):
        tmp = tempfile.mkdtemp()
        root = make_keg(tmp)
        dA = diff_say("sayA")
        store = build_store(tmp, [entry("rt", [dA])], {("rt", 1): dA})
        patchsync.reconcile(store, root, allow_reexec=False)
        res = patchsource.remove_patch(store, "rt", root)
        self.assertTrue(res["ok"])
        self.assertFalse(store.load().get("retired"))
        self.assertFalse(os.path.exists(store.patch_file("rt", 1)))


if __name__ == "__main__":
    unittest.main()
