"""KEGID-2 treedoctor: RECORD census, expected-drift, boot cache, CLI exits.

The fixture builds a fake site-packages with an omlx wheel: package files,
a dist-info RECORD with real sha256= hashes (same base64-url form pip
writes), plus kernel artifacts that must be EXCLUDED (brew rebuilds them
post-install, RECORD can't match them on a healthy keg either).
"""

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from omlx_uplift import treedoctor  # noqa: E402


def _rec_line(rel: str, data: bytes) -> str:
    h = base64.urlsafe_b64encode(
        hashlib.sha256(data).digest()).decode().rstrip("=")
    return f"{rel},sha256={h},{len(data)}\n"


import itertools

_UID = itertools.count()


class _FakeStore:
    def __init__(self, base, manifest=None):
        self.base_dir = base
        self._manifest = manifest or {"patches": []}
        self.disabled = False

    def load(self):
        return self._manifest

    def patches_disabled(self):
        return self.disabled


class TreeFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="treedoctor-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.sp = os.path.join(self.tmp, "site-packages")
        self.tree = self.sp                      # tree_root == site-packages
        pkg = os.path.join(self.sp, "omlx")
        di = os.path.join(self.sp, "omlx-0.9.0.dist-info")
        os.makedirs(os.path.join(pkg, "custom_kernels", "bonsai"))
        os.makedirs(di)
        self.files = {
            "omlx/__init__.py": b"__version__='0.9.0'\n",
            "omlx/model_settings.py": b"def validate_moe_expert_offload(s): pass\n",
            "omlx/admin/routes.py": b"# routes\n",
            "omlx/utils/model_loading.py": b"# loading\n",
        }
        rec = []
        for rel, data in self.files.items():
            f = os.path.join(self.sp, *rel.split("/"))
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, "wb") as fh:
                fh.write(data)
            rec.append(_rec_line(rel, data))
        # kernel artifacts: in RECORD but rebuilt by brew -> excluded
        kdata = b"\xcf\xfa\xed\xfe-kernel"
        kre = "omlx/custom_kernels/bonsai/_ext.cpython-311-darwin.so"
        with open(os.path.join(self.sp, *kre.split("/")), "wb") as fh:
            fh.write(kdata)
        rec.append(_rec_line(kre, b"stale-hash-from-wheel-build"))
        self.cre = _rec_line("omlx/custom_kernels/bonsai/"
                             "libomlx_bonsai_kernel_ops.dylib", b"x")
        rec.append(self.cre)
        with open(os.path.join(di, "RECORD"), "w") as fh:
            fh.write("".join(rec))

    def _store_with_applied(self, files, keg="kegA", state="applied"):
        base = os.path.join(self.tmp, "store-" + str(next(_UID)))
        os.makedirs(base, exist_ok=True)
        bd_rel = "patches/backups/demo.v1/keg"
        meta_dir = os.path.join(base, bd_rel)
        os.makedirs(meta_dir, exist_ok=True)
        with open(os.path.join(meta_dir, "meta.json"), "w") as fh:
            json.dump({"files": {f: {"existed": True, "sha256": None}
                                 for f in files}}, fh)
        manifest = {"patches": [{
            "id": "demo", "state": state, "desired_version": 1,
            "versions": [{"v": 1, "backup_dir": bd_rel,
                          "applied": {"keg_id": keg}}]}]}
        return _FakeStore(base, manifest)

    def _touch(self, rel, data=b"# tampered\n"):
        f = os.path.join(self.sp, *rel.split("/"))
        with open(f, "wb") as fh:
            fh.write(data)

    def _rm(self, rel):
        os.remove(os.path.join(self.sp, *rel.split("/")))


class TestCensus(TreeFixture):
    def test_clean_tree_ok(self):
        rep = treedoctor.census(self.tree)
        self.assertTrue(rep["ok"], rep)
        self.assertEqual(rep["unexpected"], [])
        self.assertEqual(rep["n_checked"], len(self.files))  # kernels excluded

    def test_hash_drift_is_named(self):
        self._touch("omlx/model_settings.py")
        rep = treedoctor.census(self.tree)
        self.assertFalse(rep["ok"])
        paths = {e["path"] for e in rep["unexpected"]}
        self.assertEqual(paths, {"omlx/model_settings.py"})
        self.assertEqual(rep["unexpected"][0]["kind"], "hash")

    def test_missing_file_is_named(self):
        self._rm("omlx/admin/routes.py")
        rep = treedoctor.census(self.tree)
        self.assertFalse(rep["ok"])
        self.assertEqual(rep["unexpected"][0]["path"], "omlx/admin/routes.py")
        self.assertEqual(rep["unexpected"][0]["kind"], "missing")

    def test_kernel_artifacts_never_alarm(self):
        # the fixture RECORD already disagrees with the kernel .so hash
        rep = treedoctor.census(self.tree)
        self.assertTrue(rep["ok"], rep["unexpected"])

    def test_expected_drift_explains_patch_files(self):
        self._touch("omlx/admin/routes.py")
        self._rm("omlx/utils/model_loading.py")
        rep = treedoctor.census(
            self.tree,
            expected={"omlx/admin/routes.py", "omlx/utils/model_loading.py"})
        self.assertTrue(rep["ok"], rep["unexpected"])
        self.assertEqual(sorted(rep["expected"]),
                         ["omlx/admin/routes.py", "omlx/utils/model_loading.py"])
        self.assertEqual(rep["n_expected"], 2)

    def test_no_record_skips(self):
        shutil.rmtree(os.path.join(self.sp, "omlx-0.9.0.dist-info"))
        rep = treedoctor.census(self.tree)
        self.assertTrue(rep["ok"])
        self.assertIn("RECORD", rep["skipped_reason"])

    def test_kegid1_incident_shape(self):
        """The 2026-10-04 outage: model_settings.py restored to a pre-
        upgrade copy while model_loading.py stayed newer. No applied patch
        -> both must alarm."""
        self._touch("omlx/model_settings.py", b"def old_signature(s): pass\n")
        rep = treedoctor.census(self.tree)
        self.assertFalse(rep["ok"])
        self.assertIn("omlx/model_settings.py",
                      {e["path"] for e in rep["unexpected"]})


class _FakeStore:
    def __init__(self, base, manifest=None):
        self.base_dir = base
        self._manifest = manifest or {"patches": []}
        self.disabled = False

    def load(self):
        return self._manifest

    def patches_disabled(self):
        return self.disabled


class TestExpectedDrift(TreeFixture):
    def test_applied_files_are_expected(self):
        self._touch("omlx/admin/routes.py")
        store = self._store_with_applied(["omlx/admin/routes.py"])
        exp = treedoctor.expected_drift(store, self.tree, "kegA")
        self.assertEqual(exp, {"omlx/admin/routes.py"})

    def test_other_keg_files_not_expected(self):
        store = self._store_with_applied(["omlx/admin/routes.py"], keg="other")
        self.assertEqual(treedoctor.expected_drift(store, self.tree, "kegA"),
                         set())

    def test_removed_patch_no_longer_excuses(self):
        store = self._store_with_applied(["omlx/admin/routes.py"],
                                         state="disabled")
        self.assertEqual(treedoctor.expected_drift(store, self.tree, "kegA"),
                         set())


class TestBootCheck(TreeFixture):
    def setUp(self):
        super().setUp()
        self.base = os.path.join(self.tmp, "store")
        os.makedirs(self.base, exist_ok=True)
        self.store = _FakeStore(self.base)

    def _patch_hooks(self, keg="site-packages:abc123"):
        from omlx_uplift import patches as _p
        orig_root, orig_keg = _p._omlx_root, _p.keg_id
        _p._omlx_root = lambda: os.path.join(self.sp, "omlx")
        _p.keg_id = lambda root=None: keg
        self.addCleanup(lambda: setattr(_p, "_omlx_root", orig_root))
        self.addCleanup(lambda: setattr(_p, "keg_id", orig_keg))

    def test_clean_boot_caches_and_stays_quiet(self):
        self._patch_hooks()
        rep = treedoctor.boot_check(store=self.store)
        self.assertTrue(rep["ok"])
        state = os.path.join(self.base, ".treedoctor.json")
        with open(state) as fh:
            st = json.load(fh)
        self.assertEqual(st["keg_id"], "site-packages:abc123")

    def test_drift_warns_never_raises(self):
        self._patch_hooks()
        self._touch("omlx/admin/routes.py")
        import logging
        records = []
        h = logging.Handler()
        h.emit = records.append
        lg = logging.getLogger("omlx_uplift")
        lg.addHandler(h)
        self.addCleanup(lg.removeHandler, h)
        rep = treedoctor.boot_check(store=self.store)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("TREE DRIFT" in r.getMessage() for r in records))

    def test_repair_clears_next_boot_no_stale_alarm(self):
        """Drift verdicts are NEVER cached: after a manual repair the next
        boot must go silent, not replay the warning (same fingerprints,
        healed tree — exactly when a cached alarm would lie)."""
        self._patch_hooks()
        self._touch("omlx/admin/routes.py")
        rep = treedoctor.boot_check(store=self.store)
        self.assertFalse(rep["ok"])
        self.assertFalse(os.path.exists(
            os.path.join(self.base, ".treedoctor.json")))
        # repair: byte-identical restore from the fixture RECORD's hash
        self._restore_clean("omlx/admin/routes.py")
        rep2 = treedoctor.boot_check(store=self.store)
        self.assertTrue(rep2["ok"], rep2["unexpected"])

    def _restore_clean(self, rel):
        data = self.files[rel]
        with open(os.path.join(self.sp, *rel.split("/")), "wb") as fh:
            fh.write(data)

    def test_kill_switch_stays_out(self):
        self._patch_hooks()
        self.store.disabled = True
        self.assertIsNone(treedoctor.boot_check(store=self.store))

    def test_cache_invalidates_on_manifest_fingerprint(self):
        """Applied-patch removal must re-run the census, not replay the
        cached OK verdict (that cached-OK-after-removal hole is how the
        KEGID-1 incident could hide)."""
        self._patch_hooks()
        rep = treedoctor.boot_check(store=self.store)      # caches OK
        self.assertTrue(rep["ok"])
        # a patch gets applied that owns a file, then someone tampers it
        store2 = self._store_with_applied(["omlx/admin/routes.py"])
        store2.disabled = False
        with open(os.path.join(store2.base_dir, "patches.json"), "w") as fh:
            json.dump(store2._manifest, fh)

        class S2(_FakeStore):
            def load(self):
                return json.load(open(os.path.join(self.base_dir,
                                                   "patches.json")))
        s = S2(store2.base_dir)
        rep = treedoctor.boot_check(store=s)               # fp changed -> runs
        self.assertTrue(rep["ok"])                          # patch owns it
        self._touch("omlx/utils/model_loading.py")
        rep = treedoctor.boot_check(store=s)               # fp same, cache replays
        # drift is OUTSIDE the patch set, but cache was written when the
        # tree was clean — manual edits are the documented blind spot of
        # the once-per-keg boot census (CLI/nightly stay live). This test
        # pins THAT behaviour so the trade-off is not accidental.
        self.assertTrue(rep["ok"])
        rep = treedoctor.census(self.tree,
                                expected=treedoctor.expected_drift(
                                    s, self.tree, "site-packages:abc123"))
        self.assertFalse(rep["ok"])                         # live path sees it


class TestCliExit(TreeFixture):
    def test_doctor_exit_codes(self):
        from omlx_uplift import cli as _cli
        from omlx_uplift import patches as _p
        # never touch the real ~/.omlx/uplift from tests
        os.environ["UPLIFT_HOME"] = os.path.join(self.tmp, "uplift-home")
        self.addCleanup(os.environ.pop, "UPLIFT_HOME", None)
        orig_root = _p._omlx_root
        _p._omlx_root = lambda: os.path.join(self.sp, "omlx")
        self.addCleanup(lambda: setattr(_p, "_omlx_root", orig_root))
        self.assertEqual(_cli.cmd_doctor([]), 0)
        self._touch("omlx/model_settings.py")
        self.assertEqual(_cli.cmd_doctor([]), 1)
        shutil.rmtree(os.path.join(self.sp, "omlx-0.9.0.dist-info"))
        self.assertEqual(_cli.cmd_doctor([]), 2)


class TestDoctorEndpoint(TreeFixture):
    """KEGID-3 API: route registered, admin-gated, honest verdict shape."""

    def _client(self):
        import unittest.mock as mock

        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from omlx_uplift import router as up
        from omlx_uplift.routers import patches as up_p

        app = FastAPI()
        app.include_router(up.api_router, prefix="/uplift/api")

        async def _admin_true():
            return True

        from omlx_uplift.router import require_admin
        app.dependency_overrides[require_admin] = _admin_true
        store = _FakeStore(os.path.join(self.tmp, "store-api"))
        self._mocks = [
            mock.patch.object(up_p, "patch_store", lambda: store),
            mock.patch.object(up_p, "_patch_tree_root", lambda: self.tree),
        ]
        for m in self._mocks:
            m.start()
        self.addCleanup(lambda: [m.stop() for m in self._mocks])
        return TestClient(app), store

    def test_route_registered(self):
        from omlx_uplift import router as up

        paths = {r.path for r in up.api_router.routes}
        self.assertIn("/doctor", paths)

    def test_endpoint_clean_then_drift(self):
        client, _ = self._client()
        r = client.get("/uplift/api/doctor")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["ok"], body)
        self.assertEqual(body["source"], "probe")
        self.assertEqual(body["n_checked"], len(self.files))
        self._touch("omlx/model_settings.py")
        body = client.get("/uplift/api/doctor").json()
        self.assertFalse(body["ok"])
        self.assertEqual([e["path"] for e in body["unexpected"]],
                         ["omlx/model_settings.py"])


if __name__ == "__main__":
    unittest.main()
