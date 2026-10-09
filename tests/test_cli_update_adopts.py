"""UPDATE-ADOPT (2026-10-09, user ask after the mruu pr4206 stuck state):
'patch update' re-fetched, gated and stored the fixed bytes, then left
desired_version pointing at the OLD broken version and the patch disabled
— the add flow deliberately does that (auto-promote is enabled-only), so
the "update" applied the stale v at the next restart. An update a human
asked for must actually take effect: store, then promote.
'patch update-all' is the batch twin over every re-fetchable source.
"""
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from omlx_uplift import cli, patchsource, patches


def _diff(marker="a"):
    # a minimal forward diff against omlx/x.py; the marker changes content
    return (
        "diff --git a/omlx/x.py b/omlx/x.py\n"
        "index 1111111..2222222 100644\n"
        "--- a/omlx/x.py\n"
        "+++ b/omlx/x.py\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        f"+new-{marker}\n"
    ).encode()


_SHA2 = hashlib.sha256(_diff(marker="2")).hexdigest()


class _Base(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="upd-adopt-")
        self._old_home = os.environ.get("UPLIFT_HOME")
        os.environ["UPLIFT_HOME"] = self.home
        # a fake tree_root: 'omlx' package dir with the PRE-image file
        self.pkg = tempfile.mkdtemp(prefix="upd-adopt-root-")
        os.makedirs(os.path.join(self.pkg, "omlx"))
        with open(os.path.join(self.pkg, "omlx", "x.py"), "wb") as fh:
            fh.write(b"old\n")
        self.store = patches.PatchStore()

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("UPLIFT_HOME", None)
        else:
            os.environ["UPLIFT_HOME"] = self._old_home
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.pkg, ignore_errors=True)

    def _cli(self, *argv):
        # the CLI resolves the tree via _omlx_root: point it at the fake
        with mock.patch.object(patches, "_omlx_root",
                               lambda: os.path.join(self.pkg, "omlx")):
            out = io.StringIO()
            with redirect_stdout(out):
                rc = cli.cmd_patches(list(argv))
        return rc, json.loads(out.getvalue())

    def _entry(self, pid, kind="url", enabled=False, desired=1,
               state="disabled", versions=()):
        src = {"url": {"kind": "url", "url": f"http://x/{pid}.diff"},
               "pr": {"kind": "github_pr", "repo": "r/x", "pr": 7},
               "upload": {"kind": "upload"}}[kind]
        p = {"id": pid, "enabled": enabled, "order": 100, "source": src,
             "desired_version": desired, "versions": [], "state": state,
             "state_detail": ""}
        for v, marker in enumerate(versions, start=1):
            data = _diff(marker=marker)
            rel = patches.rel(self.store.patch_file(pid, v),
                              self.store.base_dir)
            full = os.path.join(self.store.base_dir, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as fh:
                fh.write(data)
            p["versions"].append(
                {"v": v, "content_sha256": hashlib.sha256(data).hexdigest(),
                 "source_head_sha": None, "fetched_at": "now",
                 "patch_file": rel})
        return p

    def _fake_url(self, payload):
        return lambda url, tls=False: {"ok": True, "data": payload,
                                       "url": url}


class UpdateAdopts(_Base):
    def test_update_adopts_new_bytes_for_a_stale_disabled_patch(self):
        """The mruu shape: disabled, desired=1, source now serves NEW
        content -> stored v2 AND adopted (pending + enabled + desired=2)."""
        self.store.save({"patches": [self._entry("pr1", versions=["1"])]})
        with mock.patch.object(patchsource, "fetch_url",
                               self._fake_url(_diff(marker="2"))):
            rc, res = self._cli("update", "pr1")
        self.assertEqual(rc, 0, res)
        self.assertTrue(res.get("promoted"), res)
        self.assertEqual(res["desired_version"], 2)
        p = self.store.find(self.store.load(), "pr1")
        self.assertEqual(p["desired_version"], 2)
        self.assertTrue(p["enabled"])
        self.assertEqual(p["state"], "pending")

    def test_update_adopts_even_when_bytes_are_unchanged(self):
        """The exact stuck state: the fix is ALREADY the newest stored
        version but desired lags (an update ran under the old semantics).
        The 'unchanged' verdict must STILL promote — no new version."""
        self.store.save({"patches": [
            self._entry("pr1", desired=1, versions=["1", "2"])]})
        with mock.patch.object(patchsource, "fetch_url",
                               self._fake_url(_diff(marker="2"))):
            rc, res = self._cli("update", "pr1")
        self.assertEqual(rc, 0, res)
        self.assertTrue(res.get("unchanged"))
        self.assertTrue(res.get("promoted"), res)
        p = self.store.find(self.store.load(), "pr1")
        self.assertEqual(p["desired_version"], 2)
        self.assertTrue(p["enabled"])
        self.assertEqual(len(p["versions"]), 2)     # nothing new stored

    def test_update_desired_already_newest_reports_no_promotion(self):
        self.store.save({"patches": [
            self._entry("pr1", enabled=True, desired=1, state="applied",
                        versions=["1"])]})
        with mock.patch.object(patchsource, "fetch_url",
                               self._fake_url(_diff(marker="1"))):
            rc, res = self._cli("update", "pr1")
        self.assertEqual(rc, 0, res)
        self.assertFalse(res.get("promoted"))
        self.assertEqual(res["newest_version"], 1)

    def test_update_gate_failure_keeps_state_untouched(self):
        self.store.save({"patches": [self._entry("pr1", versions=["1"])]})
        bad = (b"diff --git a/omlx/x.py b/omlx/x.py\n"
               b"--- a/omlx/x.py\n+++ b/omlx/x.py\n"
               b"@@ -1 +1 @@\n-nope\n+gone\n")
        with mock.patch.object(patchsource, "fetch_url",
                               self._fake_url(bad)):
            rc, res = self._cli("update", "pr1")
        self.assertEqual(rc, 1)
        self.assertFalse(res.get("ok"))
        p = self.store.find(self.store.load(), "pr1")
        self.assertEqual(p["desired_version"], 1)
        self.assertFalse(p["enabled"])
        self.assertEqual(len(p["versions"]), 1)

    def test_update_upload_without_explicit_source_is_honest(self):
        self.store.save({"patches": [self._entry("pr1", kind="upload")]})
        rc, res = self._cli("update", "pr1")
        self.assertEqual(rc, 1)
        self.assertIn("no URL", res["reason"])

    def test_update_unknown_id(self):
        rc, res = self._cli("update", "ghost")
        self.assertEqual(rc, 1)
        self.assertIn("unknown patch id", res["reason"])

    def test_update_held_safeguards_store_bytes_but_need_approve(self):
        """A candidate with a NEW held code is stored but not adopted;
        --approve once on the re-run adopts it. 'held' is faked the way
        safeguards.held actually behaves: codes covered by a stored
        approval come back empty."""
        self.store.save({"patches": [self._entry("pr1", versions=["1"])]})
        real_held = patchsource._safeguards.held

        def fake_held(codes, always, once, sha):
            if sha == _SHA2 and "kernel_source" not in (always or []) \
                    and not (once and once.get("sha") == sha
                             and "kernel_source" in (once.get("codes") or [])):
                return ["kernel_source"]
            return real_held(codes, always, once, sha)

        with mock.patch.object(patchsource, "fetch_url",
                               self._fake_url(_diff(marker="2"))), \
             mock.patch.object(patchsource._safeguards, "held", fake_held):
            rc, res = self._cli("update", "pr1")
            self.assertEqual(rc, 1)
            self.assertIn("stored, not adopted", res["reason"])
            self.assertIn("kernel_source", res["requires_approval"])
            p = self.store.find(self.store.load(), "pr1")
            self.assertEqual(len(p["versions"]), 2)   # bytes ARE stored
            self.assertEqual(p["desired_version"], 1)  # ... not adopted
            self.assertFalse(p["enabled"])
            rc2, res2 = self._cli("update", "pr1", "--approve", "once")
        self.assertEqual(rc2, 0, res2)
        self.assertTrue(res2.get("promoted"))
        p = self.store.find(self.store.load(), "pr1")
        self.assertEqual(p["desired_version"], 2)
        self.assertTrue(p["enabled"])

    def test_update_dev_scope_notes_the_build_step(self):
        p = self._entry("pr1", versions=["1"])
        p["scope"] = "dev"
        self.store.save({"patches": [p]})
        with mock.patch.object(patchsource, "fetch_url",
                               self._fake_url(_diff(marker="2"))):
            out = patchsource.update_patch(self.store, "pr1", self.pkg,
                                           build_root=self.pkg)
        self.assertTrue(out.get("promoted"), out)
        self.assertIn("dev install", out.get("note", ""))


class UpdateAll(_Base):
    def test_update_all_scopes_enabled_disabled_and_skips_uploads(self):
        self.store.save({"patches": [self._entry("on-a", "url",
                                                 enabled=True),
                                     self._entry("off-b", "pr"),
                                     self._entry("local-c", "upload")]})
        seen = []

        def fake_update(store, pid, tree_root, source=None, scope=None,
                        build_root=None, approve=None):
            seen.append(pid)
            return {"ok": True, "promoted": False}

        with mock.patch.object(patchsource, "update_patch", fake_update):
            rc, res = self._cli("update-all")
        self.assertEqual(rc, 0)
        self.assertEqual(seen, ["on-a", "off-b"])      # disabled included
        self.assertTrue(res["reports"]["local-c"]["skipped"])
        self.assertNotIn("local-c", seen)              # upload skipped

    def test_one_failing_gate_never_stops_the_rest(self):
        self.store.save({"patches": [self._entry("a", "url"),
                                     self._entry("b", "url")]})
        results = []

        def fake_update(store, pid, tree_root, **kw):
            results.append(pid)
            return ({"ok": False, "reason": "gate refused"} if pid == "a"
                    else {"ok": True, "promoted": True})

        with mock.patch.object(patchsource, "update_patch", fake_update):
            rc, res = self._cli("update-all")
        self.assertEqual(rc, 1)
        self.assertEqual(results, ["a", "b"])
        self.assertFalse(res["ok"])
        self.assertTrue(res["reports"]["b"]["promoted"])


class HelpSurface(_Base):
    """The new verbs must be discoverable — the guard class that caught
    'dev' shipping without help text (2026-09-24)."""

    def test_usage_lists_update_adopt_and_update_all(self):
        from omlx_uplift import help as helpmod
        usage = helpmod.COMMAND_USAGE["patch"]
        self.assertIn("patch update-all", usage)
        upd = usage.split("patch update ID")[1].split("patch enable")[0]
        self.assertIn("--approve", upd)
        listed = next(d for c, d in helpmod.COMMANDS if c == "patch")
        self.assertIn("update-all", listed)

    def test_man_page_documents_both_verbs(self):
        man = os.path.join(os.path.dirname(patchsource.__file__),
                           "man", "omlx-uplift.1")
        text = open(man, encoding="utf-8").read()
        self.assertIn(".Ic update-all", text)
        self.assertIn("adopt", text)


if __name__ == "__main__":
    unittest.main()
