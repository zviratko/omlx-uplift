"""TUI-1 op catalog: key hygiene, CLI twins, and the anti-drift guarantee.

Three things this pins down:

  1. No screen can bind one key twice, and no op can claim a key the loop
     reserves (1-5, j/k, n, enter, ?, q). A silent collision would make one
     action unreachable.
  2. Every op names the CLI command it mirrors — the screen must never do
     something a person cannot also do from a shell.
  3. A mutating op calls the SAME function the dashboard route uses (or runs
     the CLI verb itself). The TUI must not grow its own copy of patch policy,
     because a second copy drifts: 'dev use' carries the DEV-11 invariants,
     'patch disable-all' owns the kill-switch stamping rules.
"""
import os
import shutil
import tempfile
import unittest

from omlx_uplift.tui import ops


class TestKeyHygiene(unittest.TestCase):
    def test_no_duplicate_key_within_a_screen(self):
        # a screen shows its row ops and its screen ops at the same time
        dupes = ops.duplicate_keys({
            "patches": ops.PATCH_ROW_OPS + ops.PATCH_SCREEN_OPS,
            "catalog": ops.CATALOG_ROW_OPS + ops.CATALOG_SCREEN_OPS,
            "dev": ops.KEG_ROW_OPS + ops.KEG_SCREEN_OPS,
            "overview": ops.SERVER_ROW_OPS,
        })
        self.assertEqual(dupes, [], "a key bound twice hides one action")

    def test_no_op_claims_a_navigation_key(self):
        clash = sorted({o.key for o in ops.ALL_OPS} & ops.RESERVED_KEYS)
        self.assertEqual(clash, [], f"ops must not use loop keys: {clash}")

    def test_keys_are_single_letters(self):
        for op in ops.ALL_OPS:
            self.assertEqual(len(op.key), 1, op.label)
            self.assertTrue(op.key.isalpha(), f"{op.key!r} is not a letter")

    def test_find_and_ops_for(self):
        self.assertIsNone(ops.find("z", ops.PATCH_ROW_OPS))
        self.assertEqual(ops.find("e", ops.PATCH_ROW_OPS).label, "enable")
        # a screen op is not a row op: 'c' checks drift on the patches screen,
        # it is not something you do TO a patch
        self.assertEqual(ops.ops_for(ops.PATCH, ops.PATCH_SCREEN_OPS), [])
        self.assertEqual(len(ops.ops_for(ops.PATCH, ops.PATCH_ROW_OPS)),
                         len(ops.PATCH_ROW_OPS))


class TestOpTable(unittest.TestCase):
    def test_every_op_names_the_command_it_mirrors(self):
        for op in ops.ALL_OPS:
            self.assertTrue(op.cli, f"{op.label} shows no CLI equivalent")
            line = op.cli_line({"id": "p1", "name": "HEAD-abc",
                                "formula": "omlx"})
            if line.startswith("("):
                continue                      # explicitly marked 'no CLI verb'
            self.assertTrue(
                line.startswith("omlx-uplift patch ")
                or line.startswith("omlx-uplift dev ")
                or line.startswith("brew services restart "),
                f"{op.label}: {line!r} is not a command an operator can type")

    def test_exactly_three_ops_run_without_confirming(self):
        # read-only by contract: dry-run test, drift check, status refresh
        labels = sorted(o.label for o in ops.ALL_OPS
                        if o.danger == ops.READ)
        self.assertEqual(labels, ["check drift", "dry-run test",
                                  "refresh (+fetch)"])

    def test_destructive_ops_need_a_typed_yes(self):
        high = {o.label for o in ops.ALL_OPS if o.danger == ops.HIGH}
        for wanted in ("remove patch", "kill switch ON", "kill switch OFF",
                       "activate keg", "rollback to newest stash",
                       "prune old stashes", "dev install (build)",
                       "restart service"):
            self.assertIn(wanted, high, f"{wanted} must need a typed YES")

    def test_tree_bound_ops_are_flagged(self):
        # needs_tree means 'this function takes a tree root', not 'this is
        # about patches'. Without the flag a file write would aim at an empty
        # tree_root; with it on a store-only verb, the TUI would refuse the
        # kill switch on a machine with no importable omlx — the one case
        # where it is needed (this is what kept CI red since LOG-2).
        tree_bound = {"update", "dry-run test", "remove patch", "check drift",
                      "reconcile now", "install", "adopt as local",
                      "sync catalog"}
        for op in ops.PATCH_ROW_OPS + ops.PATCH_SCREEN_OPS \
                + ops.CATALOG_ROW_OPS + ops.CATALOG_SCREEN_OPS:
            self.assertEqual(op.needs_tree, op.label in tree_bound,
                             f"{op.label}: needs_tree={op.needs_tree}")
        for op in ops.KEG_SCREEN_OPS + ops.SERVER_ROW_OPS + ops.KEG_ROW_OPS:
            self.assertFalse(op.needs_tree,
                             f"{op.label} acts on kegs/services, not the tree")

    def test_store_only_verbs_survive_a_missing_tree(self):
        # the manifest side of recovery must work with no omlx importable
        from omlx_uplift.tui import ops as _o
        for label in ("enable", "disable", "promote", "rollback version",
                      "approve once", "kill switch ON", "kill switch OFF"):
            op = next(o for o in _o.ALL_OPS if o.label == label)
            self.assertFalse(op.needs_tree, label)

    def test_labels_fit_the_key_bar(self):
        for op in ops.ALL_OPS:
            self.assertLessEqual(len(op.label), 24, op.label)


class FakeMod:
    """Stand-in for a pipeline module. Any attribute becomes a recorder tagged
    with this module's name, so a call records 'patchsync.reconcile' and not
    just 'reconcile'."""

    def __init__(self, prefix, calls):
        self._prefix = prefix
        self._calls = calls

    def __getattr__(self, item):
        def fn(*a, **kw):
            self._calls.append((f"{self._prefix}.{item}", a, kw))
            return {"ok": True}
        return fn


class TestOpsCallExistingCode(unittest.TestCase):
    """An op must be a thin call into the module the dashboard route uses."""

    ROW = {"id": "p1", "name": "HEAD-1", "under_id": "legacy-id"}

    def setUp(self):
        from omlx_uplift.tui.context import Context

        self.calls = []
        # a real Context over a scratch store: tree_root is a property and the
        # module handles are part of what the ops rely on, so faking the whole
        # object would test less, not more
        self._home = tempfile.mkdtemp(prefix="tui-ops-")
        self._old = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self._home
        self.addCleanup(self._cleanup)
        self.ctx = Context(store=Context().store, tree_root="TREE")
        self.store = self.ctx.store
        for mod in ("patchsource", "curated", "kegstash", "patchsync"):
            setattr(self.ctx, mod, FakeMod(mod, self.calls))
        self.ctx.build_root = lambda: "BUILD"

        def rec(name, result=None):
            def fn(*a, **kw):
                self.calls.append((name, a, kw))
                return result if result is not None else {"ok": True}
            return fn

        self.ctx.cli_dev_verb = rec("cli_dev_verb")
        self.ctx.cli_patch_verb = rec("cli_patch_verb")
        self.ctx.subprocess_runner = rec("subprocess")

    def _cleanup(self):
        if self._old is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old
        shutil.rmtree(self._home, ignore_errors=True)

    def _run(self, key, pool, row=None):
        op = ops.find(key, pool)
        self.assertIsNotNone(op, f"no op bound to {key!r}")
        return op.run(self.ctx, self.ROW if row is None else row)

    def test_per_patch_ops_reach_patchsource(self):
        for key, fn in (("e", "set_enabled"), ("d", "set_enabled"),
                        ("p", "promote"), ("u", "update_patch"),
                        ("v", "rollback"), ("a", "approve"),
                        ("x", "remove_patch"), ("t", "test_dry_run")):
            self.calls.clear()
            self._run(key, ops.PATCH_ROW_OPS)
            self.assertEqual(self.calls[0][0], f"patchsource.{fn}",
                             f"'{key}' must call patchsource.{fn}")
            self.assertIs(self.calls[0][1][0], self.store,
                          f"'{key}' must act on the context's store")
            self.assertEqual(self.calls[0][1][1], "p1",
                             f"'{key}' must pass the selected id")

    def test_enable_passes_the_approve_flag_through(self):
        # an op must not swallow a safeguard approval
        op = ops.find("e", ops.PATCH_ROW_OPS)
        self.calls.clear()
        op.run(self.ctx, self.ROW, approve="always")
        self.assertEqual(self.calls[0][2].get("approve"), "always")

    def test_check_and_apply_use_the_drift_and_reconcile_paths(self):
        self.calls.clear()
        self._run("c", ops.PATCH_SCREEN_OPS)
        self.assertEqual(self.calls[0][0], "patchsource.check_all")
        self.calls.clear()
        self._run("y", ops.PATCH_SCREEN_OPS)
        self.assertEqual(self.calls[0][0], "patchsync.reconcile")
        self.assertFalse(self.calls[0][2]["allow_reexec"],
                         "the TUI must never re-exec the server")

    def test_kill_switch_goes_through_the_cli_verb(self):
        # cmd_patches owns the enabled_before_kill stamping rules (first-armed
        # wins; a patch the user had disabled stays off) — a copy would drift
        for key, verb in (("K", "disable-all"), ("U", "enable-all")):
            self.calls.clear()
            self._run(key, ops.PATCH_SCREEN_OPS)
            self.assertEqual(self.calls[0], ("cli_patch_verb", (verb,), {}),
                             f"'{key}' must run the '{verb}' CLI verb")

    def test_keg_use_and_rollback_go_through_the_cli_verbs(self):
        # DEV-11: these verbs also turn auto-build off, clear the base pin and
        # sync brew's link record; kegstash.activate alone skips all three
        self.calls.clear()
        self._run("s", ops.KEG_ROW_OPS, {"name": "HEAD-abc", "key": "HEAD-abc"})
        self.assertEqual(self.calls[0],
                         ("cli_dev_verb", ("use", "HEAD-abc"), {}))
        self.calls.clear()
        self._run("r", ops.KEG_SCREEN_OPS)
        self.assertEqual(self.calls[0], ("cli_dev_verb", ("rollback",), {}))
        self.calls.clear()
        self._run("f", ops.KEG_SCREEN_OPS)
        self.assertEqual(self.calls[0],
                         ("cli_dev_verb", ("status", "--fetch"), {}))

    def test_stash_uses_kegstash_directly(self):
        # stash takes no in-process invariant, so the module call is enough
        self.calls.clear()
        self._run("t", ops.KEG_SCREEN_OPS)
        self.assertEqual(self.calls[0][0], "kegstash.stash")

    def test_build_and_restart_run_as_child_commands(self):
        self.calls.clear()
        self._run("b", ops.KEG_SCREEN_OPS)
        self.assertEqual(self.calls[0],
                         ("subprocess", (["omlx-uplift", "dev", "install"],),
                          {}))
        self.calls.clear()
        self._run("s", ops.SERVER_ROW_OPS, {"formula": "omlx-dev"})
        self.assertEqual(self.calls[0],
                         ("subprocess",
                          (["brew", "services", "restart", "omlx-dev"],), {}))

    def test_restart_refuses_an_unknown_formula(self):
        # the formula string reaches brew; only the two we ship may go through
        res = ops.find("s", ops.SERVER_ROW_OPS).run(self.ctx,
                                                    {"formula": "../evil"})
        self.assertFalse(res["ok"])
        self.assertEqual(self.calls, [], "must not spawn anything")

    def test_adopt_prefers_the_store_id_of_an_installed_catalog_entry(self):
        # a catalog slug and the entry on disk can differ (legacy prXXXX ids
        # predate source dedupe); adopting the slug would miss
        self.calls.clear()
        self._run("o", ops.CATALOG_ROW_OPS,
                  {"id": "pr4206-personal", "under_id": "legacy-slug"})
        self.assertEqual(self.calls[0][0], "curated.adopt")
        self.assertEqual(self.calls[0][1][1], "legacy-slug")

    def test_catalog_install_refuses_an_entry_without_a_source(self):
        self.calls.clear()
        res = self._run("i", ops.CATALOG_ROW_OPS,
                        {"id": "broken", "entry": {"id": "broken"}})
        self.assertFalse(res["ok"])
        self.assertIn("source", res["reason"])
        self.assertEqual(
            [c for c in self.calls if c[0].startswith("patchsource")], [],
            "an incomplete entry must never reach add_patch")


if __name__ == "__main__":
    unittest.main()
