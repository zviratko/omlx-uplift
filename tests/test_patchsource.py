"""PAT-2 tests: patch sources, validation gate, orchestration, API routes.

Network is a local http.server on 127.0.0.1 — no external calls. The
validation gate and orchestration run against a fake tree root with an
'omlx' package dir, same layout diffapply expects.
"""

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from omlx_uplift import diffapply, patchsource, patches

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
PR3764 = open(os.path.join(FIX, "pr3764.diff"), "rb").read()


class _Handler(BaseHTTPRequestHandler):
    routes = {}  # path -> (status, body) set per test

    def do_GET(self):  # noqa: N802
        status, body = self.routes.get(self.path, (404, b"missing"))
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # silence
        pass


class HttpFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        t = threading.Thread(target=cls.server.serve_forever, daemon=True)
        t.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"


class GateTests(HttpFixture):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat2-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        _Handler.routes = {}

    def test_fetch_bytes_ok(self):
        _Handler.routes["/p.diff"] = (200, PR3764)
        r = patchsource.fetch_bytes(self.url("/p.diff"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["data"], PR3764)

    def test_fetch_fail_safe_codes(self):
        _Handler.routes["/e404"] = (404, b"nope")
        _Handler.routes["/empty"] = (200, b"   ")
        _Handler.routes["/big"] = (200, b"x" * (patchsource.SIZE_CAP + 1))
        for path in ("/e404", "/empty", "/big", "/missing"):
            r = patchsource.fetch_bytes(self.url(path))
            self.assertFalse(r["ok"], path)

    def test_gate_ok_clean_diff(self):
        g = patchsource.validate(PR3764, self.root)
        self.assertTrue(g["ok"], g.get("reason"))
        self.assertEqual(g["compile_problems"], [])

    def test_gate_rejects_garbage(self):
        g = patchsource.validate(b"hello\nworld\n", self.root)
        self.assertFalse(g["ok"])
        self.assertIn("parse", g["reason"])

    def test_gate_rejects_broken_python(self):
        # patch a small, compilable .py in the tree: post-apply must compile
        pkg = os.path.join(self.root, "omlx", "tiny")
        os.makedirs(pkg, exist_ok=True)
        with open(os.path.join(pkg, "__init__.py"), "wb") as fh:
            fh.write(b"")
        with open(os.path.join(pkg, "mod.py"), "wb") as fh:
            fh.write(b"x = 1\ny = 2\n")
        diff = (b"diff --git a/omlx/tiny/mod.py b/omlx/tiny/mod.py\n"
                b"--- a/omlx/tiny/mod.py\n+++ b/omlx/tiny/mod.py\n"
                b"@@ -1,2 +1,3 @@\n x = 1\n y = 2\n+def broken(:\n")
        g = patchsource.validate(diff, self.root)
        self.assertFalse(g["ok"])
        self.assertTrue(any("compile" in p for p in g["compile_problems"]),
                        g["compile_problems"])

    def test_advisories(self):
        self.assertEqual(patchsource.url_advisories("https://x/y.diff"), [])
        w = patchsource.url_advisories("http://internal/y.diff")
        self.assertTrue(any("plaintext" in a for a in w))
        w = patchsource.url_advisories("https://user:pw@host/y.diff")
        self.assertTrue(any("credentials" in a for a in w))

    def test_parse_pr_ref(self):
        self.assertEqual(
            patchsource.parse_pr_ref("https://github.com/jundot/omlx/pull/3764"),
            ("jundot/omlx", 3764))
        self.assertEqual(patchsource.parse_pr_ref("jundot/omlx", "42"),
                         ("jundot/omlx", 42))
        self.assertIsNone(patchsource.parse_pr_ref("https://example.com/x"))


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat2o-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))

    def test_add_upload_pending(self):
        res = patchsource.add_patch(
            self.store, "demo", {"kind": "upload", "data": PR3764}, self.root)
        self.assertTrue(res["ok"], res)
        m = self.store.load()
        p = self.store.find(m, "demo")
        # add = fetch + gate + store version; Enable is an explicit user act
        self.assertEqual(p["state"], "disabled")
        self.assertFalse(p["enabled"])
        self.assertEqual(len(p["versions"]), 1)
        r = patchsource.set_enabled(self.store, "demo", True)
        self.assertEqual(r["state"], "pending")
        m = self.store.load()
        p = self.store.find(m, "demo")
        self.assertTrue(p["enabled"])
        self.assertEqual(p["desired_version"], 1)

    def test_add_rejects_bad_id(self):
        res = patchsource.add_patch(
            self.store, "Bad ID!", {"kind": "upload", "data": PR3764}, self.root)
        self.assertFalse(res["ok"])

    def test_add_rejection_carries_per_file_detail(self):
        # a rejected add must still carry files/compile_problems — the UI
        # gate table renders the per-file WHY from them (without them the
        # user only ever sees "REJECTED — gate failed")
        broken = (PR3764 + b"\ndiff --git a/omlx/ghost.py b/omlx/ghost.py\n"
                  b"--- a/omlx/ghost.py\n+++ b/omlx/ghost.py\n"
                  b"@@ -1,1 +1,1 @@\n-import os\n+import sys\n")
        res = patchsource.add_patch(
            self.store, "detail", {"kind": "upload", "data": broken},
            self.root)
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("stage"), "gate")
        fails = [f for f in res.get("files", []) if f["status"] == "fail"]
        self.assertEqual([f["path"] for f in fails], ["omlx/ghost.py"])
        self.assertIn("missing", fails[0]["reason"])
        # nothing stored on a gate reject (fail-safe)
        self.assertIsNone(self.store.find(self.store.load(), "detail"))

    def test_add_unchanged_no_duplicate_version(self):
        patchsource.add_patch(self.store, "demo",
                              {"kind": "upload", "data": PR3764}, self.root)
        res = patchsource.add_patch(self.store, "demo",
                                    {"kind": "upload", "data": PR3764}, self.root)
        self.assertTrue(res.get("unchanged"))
        p = self.store.find(self.store.load(), "demo")
        self.assertEqual(len(p["versions"]), 1)

    def test_add_failed_gate_stores_nothing(self):
        res = patchsource.add_patch(
            self.store, "demo", {"kind": "upload",
                                 "data": b"not a diff at all\n"}, self.root)
        self.assertFalse(res["ok"])
        m = self.store.load()
        self.assertIsNone(self.store.find(m, "demo"))

    def test_enable_disable_cycle(self):
        patchsource.add_patch(self.store, "demo",
                              {"kind": "upload", "data": PR3764}, self.root)
        r = patchsource.set_enabled(self.store, "demo", True)
        self.assertEqual(r["state"], "pending")
        r = patchsource.set_enabled(self.store, "demo", False)
        self.assertEqual(r["state"], "disabled")
        r = patchsource.set_enabled(self.store, "demo", True)
        self.assertEqual(r["state"], "pending")

    def test_remove_cleans_files(self):
        patchsource.add_patch(self.store, "demo",
                              {"kind": "upload", "data": PR3764}, self.root)
        pf = self.store.patch_file("demo", 1)
        self.assertTrue(os.path.exists(pf))
        r = patchsource.remove_patch(self.store, "demo", self.root)
        self.assertTrue(r["ok"])
        self.assertFalse(os.path.exists(pf))
        self.assertIsNone(self.store.find(self.store.load(), "demo"))

    def test_dry_run_and_diff(self):
        patchsource.add_patch(self.store, "demo",
                              {"kind": "upload", "data": PR3764}, self.root)
        patchsource.set_enabled(self.store, "demo", True)
        res = patchsource.test_dry_run(self.store, "demo", self.root)
        self.assertTrue(res["ok"])
        data = patchsource.get_diff(self.store, "demo", 1)
        self.assertEqual(data, PR3764)

    def test_config_toggle(self):
        r = patchsource.set_config(self.store, True)
        self.assertTrue(r["config"]["auto_update_check"])
        m = self.store.load()
        self.assertTrue(m["config"]["auto_update_check"])

    def test_upload_all_already_adopts_as_applied(self):
        # user patched by hand (or omlx merged it), then wants it persisted:
        # uploading that same diff must STORE it as APPLIED, enabled, with
        # pristine backups — not reject it as obsolete
        pool = os.path.join(self.root, "omlx", "admin", "routes.py")
        with open(pool, "rb") as fh:
            vanilla = fh.read()
        diffapply.apply_diff(PR3764, self.root, os.path.join(self.tmp, "b0"))
        res = patchsource.add_patch(
            self.store, "hand", {"kind": "upload", "data": PR3764}, self.root)
        self.assertTrue(res.get("adopted"), res)
        self.assertIsNone(res.get("obsolete"))
        m = self.store.load()
        p = self.store.find(m, "hand")
        self.assertEqual(p["state"], "applied")
        self.assertTrue(p["enabled"])
        v = p["versions"][-1]
        self.assertTrue(v.get("adopted"))
        self.assertIsNotNone(v.get("applied", {}).get("keg_id"))
        # per-file hashes = live (post) content: reconcile treats this keg as
        # already patched; a fresh keg (brew upgrade) re-applies
        for f in v["applied"]["files"]:
            with open(os.path.join(self.root, f["path"]), "rb") as fh:
                self.assertEqual(
                    hashlib.sha256(fh.read()).hexdigest(), f["sha256"])
        # pristine backups exist -> disable restores the pre-patch originals
        bdir = os.path.join(self.store.base_dir, v["backup_dir"])
        self.assertTrue(os.listdir(bdir))
        # the stored backup is the REVERSED image: restoring it returns the
        # exact vanilla bytes the patch was built on
        diffapply.restore_backup(bdir, self.root)
        with open(pool, "rb") as fh:
            self.assertEqual(fh.read(), vanilla)

    def test_reupload_same_content_after_adoption_unchanged(self):
        diffapply.apply_diff(PR3764, self.root, os.path.join(self.tmp, "b0"))
        first = patchsource.add_patch(
            self.store, "hand", {"kind": "upload", "data": PR3764}, self.root)
        again = patchsource.add_patch(
            self.store, "hand", {"kind": "upload", "data": PR3764}, self.root)
        self.assertTrue(again.get("unchanged"), again)
        self.assertEqual(again["v"], first["v"])


class DriftCheckTests(HttpFixture):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-pat2d-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        _Handler.routes = {}

    def _add_via_url(self):
        _Handler.routes["/p.diff"] = (200, PR3764)
        res = patchsource.add_patch(
            self.store, "demo",
            {"kind": "url", "url": self.url("/p.diff")}, self.root)
        patchsource.set_enabled(self.store, "demo", True)
        return res

    def test_check_up_to_date(self):
        self._add_via_url()
        r = patchsource.check_all(self.store, self.root)
        self.assertEqual(r["reports"]["demo"]["check"], "up_to_date")

    def test_check_update_available(self):
        self._add_via_url()
        # evolved diff: one-character change inside an added comment line —
        # content differs, hunk line counts stay valid, context still matches
        evolved = PR3764.replace(b"may unload engines", b"may unload ENGINES", 1)
        self.assertNotEqual(evolved, PR3764)
        _Handler.routes["/p.diff"] = (200, evolved)
        r = patchsource.check_all(self.store, self.root)
        self.assertEqual(r["reports"]["demo"]["check"], "update_available")
        p = self.store.find(self.store.load(), "demo")
        # candidate v2 stored; desired stays v1 until promote (design:
        # on-disk desire untouched)
        self.assertEqual(p["state"], "update_available")
        self.assertEqual(p["desired_version"], 1)

    def test_check_error_is_display_only(self):
        self._add_via_url()
        _Handler.routes["/p.diff"] = (500, b"boom")
        r = patchsource.check_all(self.store, self.root)
        self.assertEqual(r["reports"]["demo"]["check"], "error")
        p = self.store.find(self.store.load(), "demo")
        self.assertEqual(p["state"], "pending")  # NOT needs_review
        self.assertEqual(len(p["versions"]), 1)

    def test_promote_and_rollback(self):
        self._add_via_url()
        evolved = PR3764.replace(b"may unload engines", b"may unload ENGINES", 1)
        _Handler.routes["/p.diff"] = (200, evolved)
        patchsource.check_all(self.store, self.root)
        r = patchsource.promote(self.store, "demo")
        self.assertEqual(r["desired_version"], 2)
        self.assertEqual(r["state"], "pending")
        r = patchsource.rollback(self.store, "demo")
        self.assertEqual(r["desired_version"], 1)
        r = patchsource.rollback(self.store, "nope")
        self.assertFalse(r["ok"])


class RouterSurfaceTests(unittest.TestCase):
    """Route wiring: existence + auth dependency, no real network."""

    def test_routes_registered(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from omlx_uplift import router as up

        app = FastAPI()
        app.include_router(up.api_router, prefix="/uplift/api")

        async def _admin_true():
            return True

        from omlx_uplift.router import require_admin
        app.dependency_overrides[require_admin] = _admin_true

        tmp = tempfile.mkdtemp(prefix="uplift-pat2r-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        root = os.path.join(tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(root, "omlx"))
        store = patches.PatchStore(os.path.join(tmp, "data"))

        import unittest.mock as mock
        with mock.patch.object(up, "patch_store", lambda: store), \
             mock.patch.object(up, "_patch_tree_root", lambda: root):
            client = TestClient(app)
            r = client.get("/uplift/api/patches")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["patches"], [])

            r = client.post("/uplift/api/patches/add", json={
                "id": "demo", "kind": "upload", "data": PR3764.decode()})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["state"], "disabled")

            r = client.post("/uplift/api/patches/enable", json={"id": "demo"})
            self.assertEqual(r.json()["state"], "pending")

            r = client.get("/uplift/api/patches")
            body = r.json()
            self.assertEqual(len(body["patches"]), 1)
            self.assertIn("advisories", body["patches"][0])

            r = client.post("/uplift/api/patches/test", json={"id": "demo"})
            self.assertTrue(r.json()["ok"])

            r = client.get("/uplift/api/patches/diff/demo/1")
            self.assertEqual(r.content, PR3764)

            r = client.post("/uplift/api/patches/disable", json={"id": "demo"})
            self.assertEqual(r.json()["state"], "disabled")

            r = client.post("/uplift/api/patches/remove", json={"id": "demo"})
            self.assertTrue(r.json()["ok"])

            r = client.get("/uplift/api/patches/diff/demo/9")
            self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
