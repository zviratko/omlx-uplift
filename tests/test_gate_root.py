"""GATE-ROOT (user report 2026-11-12, a user machine): `patch update` of a rebased PR
gated 26 files 'already' and failed on the one file that changed. The gate
ran against dev-src, the uplift-dev branch, which carries the OLD version as
a commit. Every dev/both candidate gate now runs against a clean worktree of
the build base (pristine_build_root), the same tree the dev build uses.

Real git fixtures (no network): a carrier with v1 materialized, upstream
moves, the source now serves v2 rebased onto the new base.
"""

import os
from unittest import mock

from omlx_uplift import devsrc, patchsource

from tests.test_patch_rebase import BASE, RebaseFixture, _git


class GateRootTests(RebaseFixture):
    def setUp(self):
        super().setUp()
        carrier = self.cfg["src_path"]
        for target, value in (("dev_build_root", carrier),
                              ("_dev_cfg_for", self.cfg)):
            p = mock.patch.object(patchsource, target,
                                  return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def _carrier_with_v1_then_upstream_moves(self):
        """v1 changes f(); it is materialized on the carrier (uplift-dev).
        Upstream then edits g() AND the line v1 sits next to, and the source
        publishes v2 = the same feature rebased onto the new base."""
        v1 = self._patch_diff(BASE.replace("    return 1\n",
                                           "    return 10\n"))
        r = devsrc.materialize([{"id": "own", "version": 1,
                                 "diff_bytes": v1}], self.cfg)
        self.assertTrue(r.get("ok"), r)
        new_base = BASE.replace("    b = 2\n", "    b = 3\n")
        self._advance(new_base)
        # v2 is cut against the NEW base (work repo HEAD)
        self._write(new_base.replace("    return 1\n", "    return 10\n"))
        v2 = subprocess_diff(self.work)
        _git(["checkout", "--", "."], cwd=self.work)
        return v1, v2

    def test_carrier_gate_is_the_bug(self):
        """Control: the old gate root refuses v2 (its own old hunk sits
        there, the moved line does not) - the exact user-machine signature."""
        _, v2 = self._carrier_with_v1_then_upstream_moves()
        res = patchsource.fetch_and_gate({"kind": "upload", "data": v2},
                                         self.cfg["src_path"],
                                         tree_kind="src", quiet=True)
        self.assertFalse(res.get("ok"))

    def test_pristine_root_is_clean_base_and_removed(self):
        self._carrier_with_v1_then_upstream_moves()
        with patchsource.pristine_build_root() as root:
            self.assertNotEqual(root, self.cfg["src_path"])
            head = _git(["rev-parse", "HEAD"], cwd=root).strip()
            self.assertEqual(head, self._new_base())   # fetched, at the tip
            with open(os.path.join(root, "omlx", "k.py")) as fh:
                self.assertNotIn("return 10", fh.read())
        self.assertFalse(os.path.exists(root))
        self.assertNotIn(root, _git(["worktree", "list"],
                                    cwd=self.cfg["src_path"]))

    def test_update_through_pristine_root_stores_and_promotes(self):
        v1, v2 = self._carrier_with_v1_then_upstream_moves()
        store = self._store("own", v1, source={"kind": "url",
                                               "url": "http://x/own.diff"})
        fake = mock.Mock(return_value={"ok": True, "data": v2,
                                       "source_head_sha": None,
                                       "url": "http://x/own.diff"})
        with mock.patch.object(patchsource, "fetch_url", fake), \
                patchsource.pristine_build_root() as root:
            r = patchsource.update_patch(store, "own", "", build_root=root)
        self.assertTrue(r.get("ok"), r)
        p = store.find(store.load(), "own")
        self.assertEqual(p["desired_version"], 2)
        self.assertEqual(store.get_version(p, 2).get("tested_base"),
                         self._new_base())

    def test_check_all_default_gates_the_clean_base(self):
        """check_all with no dev_root (CLI `patch check`, dashboard 'Check
        for updates') stores v2 instead of reporting a gate error."""
        v1, v2 = self._carrier_with_v1_then_upstream_moves()
        store = self._store("own", v1, source={"kind": "url",
                                               "url": "http://x/own.diff"},
                            auto_update=True)
        fake = mock.Mock(return_value={"ok": True, "data": v2,
                                       "source_head_sha": None,
                                       "url": "http://x/own.diff"})
        with mock.patch.object(patchsource, "fetch_url", fake):
            out = patchsource.check_all(store, "")
        rep = out["reports"]["own"]
        self.assertEqual(rep.get("check"), "update_available", rep)
        self.assertTrue(rep.get("promoted"), rep)
        self.assertEqual(store.find(store.load(), "own")["desired_version"],
                         2)
        self.assertEqual(_git(["worktree", "list"],
                              cwd=self.cfg["src_path"]).count("\n"), 1)

    def test_no_dev_setup_yields_none(self):
        with mock.patch.object(patchsource, "dev_build_root",
                               return_value=None), \
                mock.patch.object(patchsource, "_dev_cfg_for",
                                  return_value=None):
            with patchsource.pristine_build_root() as root:
                self.assertIsNone(root)

    def test_base_pin_is_honoured(self):
        """detached_base_worktree follows a base pin like materialize does
        (it used to take the sync-ref tip)."""
        pinned = self._new_base()
        self._advance(BASE + "later = 1\n")
        cfg = dict(self.cfg, base_pin=pinned)
        with mock.patch.object(patchsource, "_dev_cfg_for",
                               return_value=cfg):
            with patchsource.pristine_build_root() as root:
                self.assertEqual(
                    _git(["rev-parse", "HEAD"], cwd=root).strip(), pinned)


def subprocess_diff(repo):
    import subprocess
    return subprocess.run(["git", "diff", "--binary"], cwd=repo,
                          capture_output=True).stdout


