"""Safeguards tests: root autodetection, kernel/keg-escape heuristics,
per-code approval model (once/always), reconcile hold."""

import os
import shutil
import tempfile
import unittest

from omlx_uplift import diffapply, patchsource, patchsync, safeguards


def _mk_tree(tmp):
    root = os.path.join(tmp, "site-packages")
    pkg = os.path.join(root, "omlx")
    os.makedirs(os.path.join(pkg, "engine"))
    os.makedirs(os.path.join(pkg, "custom_kernels", "decode_fast"))
    with open(os.path.join(pkg, "version.py"), "w") as fh:
        fh.write("__version__ = '9.9.9'\n")
    with open(os.path.join(pkg, "engine", "pool.py"), "w") as fh:
        fh.write("alpha = 1\nbeta = 2\ngamma = 3\n")
    with open(os.path.join(pkg, "custom_kernels", "decode_fast", "fast.py"), "w") as fh:
        fh.write("def run():\n    return 1\n")
    open(os.path.join(pkg, "custom_kernels", "decode_fast",
                      "_ext.cpython-311-darwin.so"), "wb").close()
    return root


def _diff(path, ctx, old, new, strip=""):
    """One-file unified diff changing exactly one line (old -> new) after a
    matching context line, for a file whose (pre-normalization) path is
    <strip/><path>."""
    full = f"{strip}{path}" if strip else path
    head = (f"diff --git a/{full} b/{full}\n"
            f"index 1111111..2222222 100644\n"
            f"--- a/{full}\n+++ b/{full}\n")
    body = f"@@ -1,2 +1,2 @@\n {ctx}\n-{old}\n+{new}\n"
    return (head + body).encode()


class NormalizeRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-sg-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = _mk_tree(self.tmp)

    def test_deep_diff_rewritten_and_applies(self):
        # diff made from inside omlx/: engine/pool.py instead of omlx/engine/pool.py
        # a diff made inside the package ('engine/pool.py') is level-shifted
        # onto the live tree (grounded: the shifted file exists)
        d = _diff("engine/pool.py", "alpha = 1", "beta = 2", "beta = 42")
        g = patchsource.validate(d, self.root)
        self.assertTrue(g["ok"], g.get("reason"))
        self.assertIn("omlx/", g.get("note", ""))
        d2 = _diff("engine/pool.py", "alpha = 1", "beta = 2", "beta = 42",
                   strip="omlx/")
        # strip the omlx/ prefix -> depth-too-deep diff
        d2 = d2.replace(b"omlx/engine/pool.py", b"engine/pool.py")
        g2 = patchsource.validate(d2, self.root)
        self.assertTrue(g2["ok"], g2.get("reason"))
        self.assertIn("rewritten", g2.get("note", ""))
        # canonical bytes target omlx/engine/pool.py
        parsed = diffapply.parse_diff(g2["diff"])
        self.assertEqual(parsed["files"][0]["path"], "omlx/engine/pool.py")

    def test_hunks_untouched_byte_exact(self):
        d = _diff("engine/pool.py", "alpha = 1", "beta = 2", "beta = 42",
                  strip="omlx/").replace(b"omlx/engine/pool.py", b"engine/pool.py")
        out, note = safeguards.normalize_root(d)
        self.assertIsNotNone(note)
        hunk_lines = [l for l in out.split(b"\n") if l.startswith((b"+", b"-"))
                      and not l.startswith((b"--- ", b"+++ "))]
        self.assertEqual(hunk_lines, [b"-beta = 2", b"+beta = 42"])

    def test_no_strip_when_paths_already_canonical(self):
        d = _diff("omlx/engine/pool.py", "alpha = 1", "beta = 2", "beta = 9")
        out, note = safeguards.normalize_root(d)
        self.assertIsNone(note)
        self.assertEqual(out, d)

    def test_no_strip_when_not_all_under_omlx(self):
        # shared 'sub/' strip would leave one path outside omlx/ -> no guess;
        # grounded level-shift cannot fire either (neither file exists
        # under the shifted name in the live tree)
        raw = (_diff("sub/engine/pool.py", "alpha = 1", "beta = 2", "beta = 9")
               + _diff("sub/other/pkg.py", "x = 1", "y = 2", "y = 9"))
        out, note = safeguards.normalize_root(raw, self.root)
        self.assertIsNone(note)
        self.assertEqual(out, raw)


class HeuristicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-sg-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = _mk_tree(self.tmp)

    def test_kernel_source_problem(self):
        d = _diff("custom_kernels/decode_fast/fast.py",
                  "def run():", "    return 1", "    return 2")
        g = patchsource.validate(d, self.root)
        codes = g["safeguards"]["codes"]
        self.assertIn("kernel_source", codes)
        # advisory to the strict gate: the diff itself is clean
        self.assertTrue(g["ok"])
        self.assertIn("brew reinstall", g["safeguards"]["problems"][0]["message"])

    def test_in_keg_sibling_not_flagged(self):
        # a sibling package that EXISTS in the tree is a legitimate target
        os.makedirs(os.path.join(self.root, "fastapi"))
        with open(os.path.join(self.root, "fastapi", "routing.py"), "w") as fh:
            fh.write("x = 1\nx = 2\n")
        d = _diff("fastapi/routing.py", "x = 1", "x = 2", "x = 22")
        g = patchsource.validate(d, self.root)
        self.assertEqual(g["safeguards"]["codes"], [])
        self.assertTrue(g["ok"])

    def test_outside_keg_problem(self):
        # a sibling that does NOT exist in the tree resolves onto nothing —
        # gate flags it; the strict apply would fail on a missing file anyway
        d = _diff("ghost_pkg/routing.py", "x = 1", "x = 2", "x = 22")
        g = patchsource.validate(d, self.root)
        self.assertIn("outside_keg", g["safeguards"]["codes"])

    def test_clean_diff_no_problems(self):
        d = _diff("engine/pool.py", "alpha = 1", "beta = 2", "beta = 7")
        g = patchsource.validate(d, self.root)
        self.assertEqual(g["safeguards"]["codes"], [])
        self.assertTrue(g["ok"])

    def test_csrc_under_kernels_flagged(self):
        p = "omlx/custom_kernels/decode_fast/csrc/sdpa_decode.metal"
        parsed = {"files": [{"path": p, "action": "create", "hunks": [],
                             "reject": None}]}
        rep = safeguards.assess(parsed, self.root)
        self.assertEqual(rep["codes"], ["kernel_source"])
        self.assertIn("csrc", rep["problems"][0]["message"])


class HeldModelTests(unittest.TestCase):
    def test_held_semantics(self):
        self.assertEqual(safeguards.held(["kernel_source"], [], None, "sha1"),
                         ["kernel_source"])
        # once covers only its exact sha
        once = {"sha": "sha1", "codes": ["kernel_source"]}
        self.assertEqual(safeguards.held(["kernel_source"], [], once, "sha1"), [])
        self.assertEqual(safeguards.held(["kernel_source"], [], once, "sha2"),
                         ["kernel_source"])
        # always covers its codes across versions, nothing else
        self.assertEqual(safeguards.held(["kernel_source"], ["kernel_source"],
                                         None, "sha9"), [])
        self.assertEqual(safeguards.held(["kernel_source", "outside_keg"],
                                         ["kernel_source"], None, "sha9"),
                         ["outside_keg"])


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-sg-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = _mk_tree(self.tmp)
        self.store = patches_store(self.tmp)

    def test_add_flags_requires_approval_and_enable_refuses(self):
        d = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 2")
        r = patchsource.add_patch(self.store, "kern",
                                  {"kind": "upload", "data": d}, self.root)
        self.assertTrue(r["ok"])
        self.assertEqual(r["requires_approval"], ["kernel_source"])
        # auto-apply refused until approved
        e = patchsource.set_enabled(self.store, "kern", True)
        self.assertFalse(e["ok"])
        self.assertEqual(e["requires_approval"], ["kernel_source"])
        # patch must not be enabled by the refused call
        m = self.store.load()
        self.assertFalse(self.store.find(m, "kern")["enabled"])

    def test_approve_once_binds_to_sha(self):
        d = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 3")
        patchsource.add_patch(self.store, "kern",
                              {"kind": "upload", "data": d}, self.root)
        e = patchsource.set_enabled(self.store, "kern", True, approve="once")
        self.assertTrue(e["ok"], e)
        m = self.store.load()
        p = self.store.find(m, "kern")
        self.assertTrue(p["enabled"])
        self.assertEqual(p["safeguard_once"]["codes"], ["kernel_source"])
        # a NEW version (different sha) is held again
        d2 = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 4")
        r = patchsource.add_patch(self.store, "kern",
                                  {"kind": "upload", "data": d2}, self.root)
        self.assertEqual(r["requires_approval"], ["kernel_source"])

    def test_approve_always_survives_new_version(self):
        d = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 5")
        patchsource.add_patch(self.store, "kern",
                              {"kind": "upload", "data": d}, self.root)
        patchsource.set_enabled(self.store, "kern", True, approve="always")
        d2 = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 6")
        r = patchsource.add_patch(self.store, "kern",
                                  {"kind": "upload", "data": d2}, self.root)
        self.assertEqual(r["requires_approval"], [])

    def test_reconcile_holds_unapproved_applies_approved(self):
        d = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 7")
        patchsource.add_patch(self.store, "kern",
                              {"kind": "upload", "data": d}, self.root)
        m = self.store.load()
        p = self.store.find(m, "kern")
        p["enabled"] = True
        p["desired_version"] = 1
        self.store.save(m)
        rep = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertEqual(rep["reports"][0]["action"], "approval_required")
        with open(os.path.join(self.root, "omlx", "custom_kernels",
                               "decode_fast", "fast.py")) as fh:
            self.assertIn("return 1", fh.read())  # NOT applied
        # approve always -> now it applies
        e = patchsource.set_enabled(self.store, "kern", True, approve="always")
        self.assertTrue(e["ok"], e)
        rep = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertEqual(rep["reports"][0]["action"], "applied")
        with open(os.path.join(self.root, "omlx", "custom_kernels",
                               "decode_fast", "fast.py")) as fh:
            self.assertIn("return 7", fh.read())

    def test_view_exposes_safeguards(self):
        d = _diff("custom_kernels/decode_fast/fast.py", "def run():", "    return 1", "    return 8")
        patchsource.add_patch(self.store, "kern",
                              {"kind": "upload", "data": d}, self.root)
        v = patchsource.view(self.store, self.root, "tree:abc")
        p = v["patches"][0]
        self.assertEqual(p["requires_approval"], ["kernel_source"])
        self.assertIn("brew reinstall", p["kernel_rebuild_hint"])
        self.assertEqual(p["versions"][0]["safeguards"]["codes"],
                         ["kernel_source"])

    def test_clean_patch_unaffected(self):
        d = _diff("engine/pool.py", "alpha = 1", "beta = 2", "beta = 44")
        r = patchsource.add_patch(self.store, "plain",
                                  {"kind": "upload", "data": d}, self.root)
        self.assertEqual(r["requires_approval"], [])
        e = patchsource.set_enabled(self.store, "plain", True)
        self.assertTrue(e["ok"])
        rep = patchsync.reconcile(self.store, self.root, allow_reexec=False)
        self.assertEqual(rep["reports"][0]["action"], "applied")


def patches_store(tmp):
    from omlx_uplift import patches as _patches
    return _patches.PatchStore(base_dir=os.path.join(tmp, "uplift-data"))
