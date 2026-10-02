"""BE-3 step 2 behavior test: check_all's drift candidate must carry the
SAME version schema as add_patch (safeguards + root_note).

Pre-fix, check_all built its own dict and silently dropped both fields —
a v2 candidate for a kernel-touching PR stored NO safeguards, so promote
would have skipped the approval UI the pending path enforces. Fixture: a
patch touching omlx/custom_kernels/ (safeguard code kernel_source); v1
added via add_patch, evolved v2 discovered by check_all through the same
routes."""
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from omlx_uplift import patchsource, patches

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")

KERNEL_V1 = (
    b"diff --git a/omlx/custom_kernels/foo.py b/omlx/custom_kernels/foo.py\n"
    b"--- a/omlx/custom_kernels/foo.py\n"
    b"+++ b/omlx/custom_kernels/foo.py\n"
    b"@@ -1,2 +1,2 @@\n"
    b" def kern():\n"
    b"-    return 1\n"
    b"+    return 2\n")
KERNEL_V2 = KERNEL_V1.replace(b"return 2", b"return 3")


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


class DriftSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-be3-drift-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        shutil.copytree(os.path.join(FIX, "base3764", "omlx"),
                        os.path.join(self.root, "omlx"))
        os.makedirs(os.path.join(self.root, "omlx", "custom_kernels"))
        with open(os.path.join(self.root, "omlx", "custom_kernels", "foo.py"),
                  "wb") as fh:
            fh.write(b"def kern():\n    return 1\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        _Handler.routes = {"/k.diff": (200, KERNEL_V1)}

    def test_drift_candidate_carries_safeguards_like_pending(self):
        res = patchsource.add_patch(
            self.store, "kern",
            {"kind": "url", "url": f"http://127.0.0.1:{self.port}/k.diff"},
            self.root)
        self.assertTrue(res["ok"], res)
        m = self.store.load()
        p = self.store.find(m, "kern")
        v1 = p["versions"][0]
        # pending path records the kernel safeguard...
        self.assertIn("kernel_source", v1.get("safeguards", {}).get("codes", []))
        # ...and so must the drift path, on the SAME schema
        _Handler.routes["/k.diff"] = (200, KERNEL_V2)
        r = patchsource.check_all(self.store, self.root)
        self.assertEqual(r["reports"]["kern"]["check"], "update_available")
        p = self.store.find(self.store.load(), "kern")
        self.assertEqual(len(p["versions"]), 2)
        v2 = p["versions"][1]
        self.assertIn("kernel_source", v2.get("safeguards", {}).get("codes", []),
                      "BE-3 step 2: drift candidate lost the safeguards block "
                      "(the two-schema bug)")
        # promote path can hold approval on v2 exactly like v1
        self.assertNotEqual(v1["content_sha256"], v2["content_sha256"])


if __name__ == "__main__":
    unittest.main()
