"""FALSE-OBSOLETE guard (user report 2026-10-20, mruu + kocour).

The upstreamed-probe's KEG fallback gated the stored diff against the
DEV KEG — a tree carrying the patches' OWN hunks (baked from the
materialized branch, or boot-mounted under a keg id the pristine strip
can no longer match once the tree was rebuilt). all-'already' read from
such a tree is the patch reading itself, not evidence of upstream: three
live patches were retired at once by that self-read and the next build
silently dropped them (+0 patch commits).

The fix adds two witnesses per verdict — base_lacks (the diff still
APPLIES to the gated tree) and tree_clean (the gate provably ran without
this patch) — a self-heal that walks false-obsolete patches back to
applied, and the decisive pristine-base all-'already' acceptance so
GENUINE upstreaming still retires.
"""
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from omlx_uplift import patchsource, patches

DIFF_V1 = (
    b"diff --git a/omlx/admin/foo.py b/omlx/admin/foo.py\n"
    b"--- a/omlx/admin/foo.py\n"
    b"+++ b/omlx/admin/foo.py\n"
    b"@@ -1,2 +1,2 @@\n"
    b" def run():\n"
    b"-    return 1\n"
    b"+    return 2\n")

PRE = b"def run():\n    return 1\n"


class _Handler(BaseHTTPRequestHandler):
    routes: dict = {}

    def do_GET(self):  # noqa: N802
        status, body = self.routes.get(self.path, (404, b"missing"))
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class FalseObsoleteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def _tree(self, content=PRE):
        root = os.path.join(self.tmp, "site-packages")
        d = os.path.join(root, "omlx", "admin")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "foo.py"), "wb") as fh:
            fh.write(content)
        return root

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-false-obsolete-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        _Handler.routes = {"/p.diff": (200, DIFF_V1)}
        self.root = self._tree()
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def _url_src(self):
        return {"kind": "url",
                "url": f"http://127.0.0.1:{self.port}/p.diff"}

    def _set_scope(self, pid, scope):
        m = self.store.load()
        self.store.find(m, pid)["scope"] = scope
        self.store.save(m)

    def _churn_keg_ids(self):
        """Simulate the content-hash id drift a rebuild/mount causes:
        applied records keep their bytes but no longer match the live
        tree's id — the pristine strip then silently finds nothing."""
        m = self.store.load()
        p = self.store.find(m, "ctx")
        for v in p.get("versions", []):
            v["kegs"] = {"site-packages:churned0000": rec
                         for rec in (v.get("kegs") or {}).values()}
        self.store.save(m)

    def _add_applied(self, pid="ctx"):
        """Store v1 via the real add path, then emulate the mount: tree
        carries the patched bytes, the version entry records 'applied'
        under the CURRENT keg id (a later _churn_keg_ids() stands in for
        the id drift a rebuild causes)."""
        res = patchsource.add_patch(self.store, pid, self._url_src(),
                                    self.root)
        self.assertTrue(res["ok"], res)
        with open(os.path.join(self.root, "omlx", "admin", "foo.py"),
                  "wb") as fh:
            fh.write(b"def run():\n    return 2\n")
        m = self.store.load()
        p = self.store.find(m, pid)
        kid = patches.keg_id(os.path.join(self.root, "omlx"))
        for v in p["versions"]:
            v.setdefault("kegs", {})[kid] = {"status": "applied",
                                             "at": "2026-10-20T00:00:00+00:00"}
        self.assertTrue(self.store.set_state(p, "applied", "test mount"))
        self.store.save(m)
        return p

    # ---- the incident itself -------------------------------------------
    def test_self_read_on_stripped_tree_never_retires_runtime_patch(self):
        """[omlx] applied + mounted (tree carries hunks) + records under a
        churned keg id (strip dead): the old code read 'already' back from
        our own mount and marked the patch obsolete. It must not."""
        self._add_applied()
        self._churn_keg_ids()
        out = patchsource.check_all(self.store, self.root)
        self.assertEqual(out["reports"]["ctx"]["check"], "up_to_date")
        m = self.store.load()
        self.assertEqual(self.store.find(m, "ctx")["state"], "applied")

    def test_both_patch_survives_clean_base_lacks_the_content(self):
        """[both] + pristine base gate says the diff still APPLIES
        (base_lacks) — the KEG fallback must be skipped even though the
        dev keg carries the hunks."""
        self._add_applied()
        self._set_scope("ctx", "both")
        self._churn_keg_ids()
        clean = os.path.join(self.tmp, "basewt2")
        d = os.path.join(clean, "omlx", "admin")
        os.makedirs(d)
        with open(os.path.join(d, "foo.py"), "wb") as fh:
            fh.write(PRE)
        out = patchsource.check_all(self.store, self.root, dev_root=clean)
        rep = out["reports"]["ctx"]["check"]
        self.assertEqual(rep, "up_to_date")
        m = self.store.load()
        self.assertEqual(self.store.find(m, "ctx")["state"], "applied")

    # ---- self-heal -------------------------------------------------------
    def test_false_obsolete_reversed_by_clean_base(self):
        """Already falsely retired: the next drift run against a base the
        diff still applies to must walk the state back to applied."""
        self._add_applied()
        self._set_scope("ctx", "both")
        m = self.store.load()
        p = self.store.find(m, "ctx")
        self.assertTrue(self.store.set_state(
            p, "obsolete",
            "upstream now contains the patch — consider removing"))
        self.store.save(m)
        clean = os.path.join(self.tmp, "basewt")
        d = os.path.join(clean, "omlx", "admin")
        os.makedirs(d)
        with open(os.path.join(d, "foo.py"), "wb") as fh:
            fh.write(PRE)
        out = patchsource.check_all(self.store, self.root, dev_root=clean)
        self.assertEqual(out["reports"]["ctx"]["check"],
                         "obsolete_reversed")
        m = self.store.load()
        p = self.store.find(m, "ctx")
        self.assertEqual(p["state"], "applied")
        self.assertIn("revalidated", p.get("state_detail", ""))

    # ---- genuine upstreaming still retires -------------------------------
    def test_pristine_base_all_already_retires_for_real(self):
        """A genuinely merged patch: the pristine base worktree already
        carries the content — all-'already' there is decisive, obsolete
        must fire."""
        self._add_applied()
        self._set_scope("ctx", "both")
        merged = os.path.join(self.tmp, "mergetree")
        d = os.path.join(merged, "omlx", "admin")
        os.makedirs(d)
        with open(os.path.join(d, "foo.py"), "wb") as fh:
            fh.write(b"def run():\n    return 2\n")   # content present
        out = patchsource.check_all(self.store, self.root, dev_root=merged)
        self.assertEqual(out["reports"]["ctx"]["check"], "obsolete")
        m = self.store.load()
        self.assertEqual(self.store.find(m, "ctx")["state"], "obsolete")

    # ---- working strip still allows honest verdicts -----------------------
    def test_runtime_patch_never_applied_can_still_retire(self):
        """No applied records anywhere: the live tree provably never saw
        this patch, so all-'already' IS upstream evidence."""
        self._add_applied()
        m = self.store.load()
        p = self.store.find(m, "ctx")
        for v in p["versions"]:
            v["kegs"] = {}
        self.store.save(m)
        # upstream meanwhile grew the content: tree shows the patched bytes
        shutil.rmtree(os.path.join(self.root, "omlx"))
        self._tree(b"def run():\n    return 2\n")
        m = self.store.load()
        self.assertTrue(self.store.set_state(
            self.store.find(m, "ctx"), "applied", ""))
        # applied->... state already 'applied'; ensure records stay empty
        self.store.save(m)
        out = patchsource.check_all(self.store, self.root)
        self.assertEqual(out["reports"]["ctx"]["check"], "obsolete")


if __name__ == "__main__":
    unittest.main()
