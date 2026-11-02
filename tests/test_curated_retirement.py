"""Retired catalog patches (user report 2026-11-02, audio-deps-in-base).

Deleting a curated manifest retires the patch for everyone who installed it:
their own store row survives, its source URL starts answering 404, and the
upgrade log used to print that as a gate failure while the card stayed green
'applied'. The contract now:

  * a catalog patch a SUCCESSFUL listing no longer names is RETIRED -
    disabled, stamped, and reported honestly;
  * nothing is ever deleted automatically: the row, its stored diff bytes and
    its backups stay, Remove is the operator's decision;
  * a listing that failed (or a tier that did not answer) never retires
    anything - absence of evidence is not evidence of retirement;
  * re-publishing clears the stamp so the patch can be enabled again;
  * the drift check stops re-fetching a retired source and says 'delisted'.

Fixtures follow tests/test_curated.py: a synthetic catalog behind a fake
fetch, a fake tree, and the bundled seed redirected so a refused listing
cannot install this repository's real catalog.
"""
import json
import os
import shutil
import tempfile
import unittest

from omlx_uplift import curated, patches, patchsource

DIFF = (
    b"diff --git a/pkg/mod.py b/pkg/mod.py\n"
    b"--- a/pkg/mod.py\n"
    b"+++ b/pkg/mod.py\n"
    b"@@ -1,2 +1,3 @@\n line1\n+injected\n line2\n")
NICE_DIFF = DIFF.replace(b"+injected\n", b"+injected-nice\n")
MINE_DIFF = DIFF.replace(b"+injected\n", b"+injected-mine\n")

MD_PR = json.dumps({
    "description": "Apply the cap without restart.",
    "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
    "scope": "omlx"})
MD_FILE = json.dumps({"description": "Nice to have.", "source": {"kind": "file"}})

FILES = {
    "raw-default-index.json": ["live-apply.json"],
    "raw-optional-index.json": ["nice.json", "nice.diff"],
    "raw-default-live-apply.json": MD_PR,
    "raw-optional-nice.json": MD_FILE,
    "raw-optional-nice.diff": NICE_DIFF,
}


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-retire-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        old = curated.SEED_DIRS
        curated.SEED_DIRS = [os.path.join(self.tmp, "no-such-seed")]
        self.addCleanup(setattr, curated, "SEED_DIRS", old)
        self.root = os.path.join(self.tmp, "site-packages")
        os.makedirs(os.path.join(self.root, "pkg"))
        with open(os.path.join(self.root, "pkg", "mod.py"), "w") as fh:
            fh.write("line1\nline2\n")
        self.files = {k: (list(v) if isinstance(v, list) else v)
                      for k, v in FILES.items()}
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        self._route_fetch()

    def _route_fetch(self):
        files = self.files

        def fetch(url):
            if "api.github.com" in url:
                tier = url.rstrip("/").rsplit("/", 1)[-1]
                key = "api-listing-%s" % tier
            elif "pull/" in url:
                return {"ok": True, "data": DIFF}
            elif "example.com" in url:
                # a user-added patch (never a catalog row): served so
                # add_patch can actually store it. Content must be distinct
                # from every catalog diff here - the content-twin guard
                # rejects byte-identical patches BY DESIGN.
                return {"ok": True, "data": MINE_DIFF}
            elif "raw.githubusercontent" in url:
                tier, name = url.split("/curated_patches/", 1)[-1].split("/", 1)
                key = "raw-%s-%s" % (tier, name)
            else:
                return {"ok": False, "status": 404, "reason": "HTTP 404 from %s" % url}
            if key not in files:
                return {"ok": False, "status": 404, "reason": "HTTP 404 from %s" % url}
            data = files[key]
            if isinstance(data, list):
                return {"ok": True, "data": json.dumps(data).encode()}
            if isinstance(data, str):
                data = data.encode()
            return {"ok": True, "data": data}
        self.fetch = fetch

        def fake_fetch(url, *a, **kw):
            r = fetch(url)
            if not r.get("ok"):
                return r
            return {"ok": True, "data": r["data"], "source_head_sha": None,
                    "url": url}

        def fake_fetch_pr(repo, pr, *a, **kw):
            return {"ok": True, "data": DIFF, "source_head_sha": None,
                    "url": "https://github.com/%s/pull/%s.diff" % (repo, pr)}
        for name, fn in (("fetch_url", fake_fetch), ("fetch_pr", fake_fetch_pr)):
            saved = getattr(patchsource, name)
            setattr(patchsource, name, fn)
            self.addCleanup(setattr, patchsource, name, saved)
        saved = getattr(curated.patchsource, "fetch_bytes", None)
        if saved is not None:
            patchsource.fetch_bytes = fetch
            self.addCleanup(setattr, patchsource, "fetch_bytes", saved)

    # -- helpers ---------------------------------------------------------
    def install_both(self):
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertEqual(r["report"]["live-apply"]["sync"], "added_enabled")
        self.assertEqual(r["report"]["nice"]["sync"], "added_disabled")
        return r

    def find(self, pid):
        for p in self.store.load().get("patches", []):
            if p.get("id") == pid:
                return p
        return None

    def drop_from_catalog(self, pid, tier):
        self.files["raw-%s-index.json" % tier] = [
            n for n in self.files["raw-%s-index.json" % tier]
            if n != "%s.json" % pid]
        self.files.pop("raw-%s-%s.json" % (tier, pid), None)
        self.files.pop("raw-%s-%s.diff" % (tier, pid), None)

    # -- the sweep -------------------------------------------------------
    def test_delisted_catalog_patch_is_retired_and_disabled(self):
        self.install_both()
        p = self.find("nice")
        self.assertTrue(p["versions"], "fixture: the patch has stored bytes")
        # an operator who enabled it must have it switched off by the retirement
        patchsource.set_enabled(self.store, "nice", True)
        self.drop_from_catalog("nice", "optional")

        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertEqual(r["report"]["nice"]["sync"], "delisted")
        self.assertTrue(any("retired from the catalog" in n for n in r["notes"]),
                        "the sync notes must say what happened: %r" % r["notes"])
        p = self.find("nice")
        self.assertFalse(p["enabled"], "retiring disables the patch")
        self.assertTrue(p.get("delisted"), "and stamps the retirement")
        self.assertEqual(p["state"], "disabled")
        self.assertIn("retired from the patch catalog", p["state_detail"])
        # NEVER a delete: the row and its bytes survive for the operator
        self.assertTrue(p["versions"])
        diff_files = [f for f in os.listdir(self.store.patches_dir)
                      if f.startswith("nice.")]
        self.assertTrue(diff_files, "stored diff bytes must survive: %r" % diff_files)

    def test_retire_is_idempotent_and_keeps_user_choice_afterwards(self):
        self.install_both()
        self.drop_from_catalog("nice", "optional")
        curated.sync(self.store, self.root, fetch=self.fetch)
        stamp = self.find("nice")["delisted"]
        # the operator re-enables a retired patch (the bytes still apply);
        # a later sync must not fight that decision
        patchsource.set_enabled(self.store, "nice", True)
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertNotEqual(r["report"].get("nice", {}).get("sync"), "delisted")
        p = self.find("nice")
        self.assertTrue(p["enabled"], "retirement is a one-time act, not a latch")
        self.assertEqual(p["delisted"], stamp)

    def test_untrustworthy_listing_retires_nothing(self):
        self.install_both()
        self.drop_from_catalog("nice", "optional")
        # the optional tier's index stops answering at all: the chain falls
        # through to the LEGACY contents API, whose 404 means 'no listing'
        # and is reported as an EMPTY tier. Acting on that would switch off
        # every curated patch the moment the catalog moved (the published-
        # coordinate incident), so a sweep needs remote/bundled origins.
        del self.files["raw-optional-index.json"]
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertNotIn("delisted", r["report"], r["report"])
        p = self.find("nice")
        self.assertFalse(p.get("delisted"))
        self.assertFalse(p["enabled"], "was installed disabled by tier policy")
        # and an entry the OTHER tier still lists is untouched either way
        self.assertNotIn("delisted", self.find("live-apply"))

    def test_relisted_patch_loses_the_stamp(self):
        self.install_both()
        self.drop_from_catalog("nice", "optional")
        curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertTrue(self.find("nice")["delisted"])
        # publish it again under the same id
        self.files["raw-optional-index.json"] = ["nice.json", "nice.diff"]
        self.files["raw-optional-nice.json"] = MD_FILE
        self.files["raw-optional-nice.diff"] = NICE_DIFF
        curated.sync(self.store, self.root, fetch=self.fetch)
        p = self.find("nice")
        self.assertNotIn("delisted", p, "re-publishing must not stay bricked")
        self.assertFalse(p["enabled"], "re-enabling stays the operator's call")

    def test_adopted_and_user_patches_are_never_swept(self):
        self.install_both()
        curated.adopt(self.store, "nice")
        # a patch the user added themselves (no curated tag at all)
        patchsource.add_patch(self.store, "mine", {
            "kind": "url", "url": "https://example.com/mine.diff"},
            self.root, quiet=True)
        patchsource.set_enabled(self.store, "mine", True)
        self.files["raw-optional-index.json"] = []
        curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertNotIn("delisted", self.find("nice"))
        self.assertNotIn("delisted", self.find("mine"))
        self.assertTrue(self.find("mine")["enabled"])

    # -- the drift check -------------------------------------------------
    def test_check_all_reports_delisted_without_touching_the_source(self):
        self.install_both()
        self.drop_from_catalog("nice", "optional")
        curated.sync(self.store, self.root, fetch=self.fetch)
        calls = []
        saved = patchsource.fetch_url

        def spy(url, *a, **kw):
            calls.append(url)
            return saved(url, *a, **kw)
        patchsource.fetch_url = spy
        self.addCleanup(setattr, patchsource, "fetch_url", saved)
        rep = patchsource.check_all(self.store, self.root)
        self.assertEqual(rep["reports"]["nice"]["check"], "delisted")
        self.assertIn("stored version", rep["reports"]["nice"]["reason"]
                      + curated.DELISTED_DETAIL)
        self.assertFalse([c for c in calls if "nice.diff" in c],
                         "a retired source must not be re-fetched and 404")

    def test_check_404_on_a_catalog_url_retires_it(self):
        # a box that only ever runs `patch check` (no sync since the retire):
        # the 404 on OUR catalog URL is the evidence, and the verdict is the
        # same one the sync lane gives
        self.install_both()
        self.drop_from_catalog("nice", "optional")
        rep = patchsource.check_all(self.store, self.root)
        self.assertEqual(rep["reports"]["nice"]["check"], "delisted")
        p = self.find("nice")
        self.assertTrue(p.get("delisted"))
        self.assertFalse(p["enabled"])
        self.assertIn("HTTP 404", p["delisted_reason"])

    def test_transient_fetch_failure_is_still_an_error(self):
        self.install_both()
        saved = patchsource.fetch_url
        patchsource.fetch_url = lambda url, *a, **kw: {
            "ok": False, "stage": "fetch", "status": 503,
            "reason": "HTTP 503 from %s" % url}
        self.addCleanup(setattr, patchsource, "fetch_url", saved)
        rep = patchsource.check_all(self.store, self.root)
        self.assertEqual(rep["reports"]["nice"]["check"], "error")
        self.assertNotIn("delisted", self.find("nice"))

    # -- the surfaces ----------------------------------------------------
    def test_view_and_cli_wording(self):
        from omlx_uplift import cli
        self.install_both()
        self.drop_from_catalog("nice", "optional")
        curated.sync(self.store, self.root, fetch=self.fetch)
        out = patchsource.view(self.store, self.root, patches.keg_id(self.root))
        row = [p for p in out["patches"] if p["id"] == "nice"][0]
        self.assertTrue(row["delisted"])
        self.assertIn("catalog", row["delisted_reason"])
        # the CLI verdict word: RETIRED, not a bare OFF
        out["patches"] = [row]
        import io
        buf = io.StringIO()
        cli._print_patch_status(out, stream=buf)
        self.assertIn("RETIRED", buf.getvalue())

    def test_disable_detail_names_when_the_restore_happens(self):
        # a build patch comes back when omlx-dev is next compiled - telling
        # the operator to restart the server was a lie about the action
        patchsource.add_patch(self.store, "buildy", {
            "kind": "url", "url": "https://example.com/buildy.diff"},
            self.root, scope=patches.SCOPE_DEV, quiet=True,
            build_root=self.root)
        patchsource.set_enabled(self.store, "buildy", True)
        # the branch stamp is what makes the patch 'applied' for a build
        # scope - write it into the reloaded manifest the save actually keeps
        m = self.store.load()
        p = self.store.find(m, "buildy")
        v = (self.store.get_version(p, p.get("desired_version"))
             or (p.get("versions") or [{}])[-1])
        v["dev_applied"] = {"sha": "deadbeef", "at": "2026-11-02T00:00:00"}
        self.store.save(m)
        patchsource.set_enabled(self.store, "buildy", False)
        detail = self.find("buildy")["state_detail"]
        self.assertIn("omlx-dev build", detail, detail)
        self.assertNotIn("next restart", detail)


if __name__ == "__main__":
    unittest.main()
