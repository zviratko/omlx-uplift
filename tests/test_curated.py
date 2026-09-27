"""Curated catalog: listing, .json manifests, tier policy, idempotence.

The network is always a fake fetch — the module must never touch GitHub
in unit tests, and a fetch failure must leave the store untouched.
"""
import json
import os
import shutil
import tempfile
import unittest

from omlx_uplift import curated, patches

# a minimal one-file diff the gate can apply against a fake tree
DIFF = (
    b"diff --git a/pkg/mod.py b/pkg/mod.py\n"
    b"--- a/pkg/mod.py\n"
    b"+++ b/pkg/mod.py\n"
    b"@@ -1,2 +1,3 @@\n"
    b" line1\n"
    b"+injected\n"
    b" line2\n")

MD_PR = json.dumps({
    "description": "Apply the cap without restart.",
    "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
    "scope": "omlx"})
MD_FILE = json.dumps({
    "description": "Nice to have.",
    "source": {"kind": "file"}})
MD_NOSRC = json.dumps({
    "description": "No usable source here.",
    "source": {"kind": "carrier-pigeon"}})

FILES = {
    "api-listing-default": [
        {"name": "live-apply.json"}, {"name": "stray.diff"}],
    "api-listing-optional": [
        {"name": "nice.json"}, {"name": "nice.diff"},
        {"name": "broken.json"}],
    "raw-default-live-apply.json": MD_PR,
    "raw-optional-nice.json": MD_FILE,
    "raw-optional-nice.diff": DIFF,
    "raw-optional-broken.json": MD_NOSRC,
}


def make_fetch(files, pr_diff=DIFF):
    """Serves the catalog plus one canned github_pr diff so github_pr
    sources gate like url sources in tests."""
    def fetch(url):
        if "api.github.com" in url:
            tier = url.rstrip("/").rsplit("/", 1)[-1]
            key = f"api-listing-{tier}"
        elif "pull/" in url:              # github.com/<repo>/pull/N.diff
            return {"ok": True, "data": pr_diff}
        elif "raw.githubusercontent" in url:
            parts = url.split("/curated_patches/", 1)[-1]
            tier, name = parts.split("/", 1)
            key = f"raw-{tier}-{name}"
        else:
            return {"ok": False, "status": 404, "reason": "HTTP 404"}
        if key not in files:
            return {"ok": False, "status": 404, "reason": "HTTP 404"}
        data = files[key]
        if isinstance(data, list):
            return {"ok": True, "data": json.dumps(data).encode()}
        if isinstance(data, str):
            data = data.encode()
        return {"ok": True, "data": data}
    return fetch


class CuratedSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-curated-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        os.makedirs(os.path.join(self.root, "pkg"))
        with open(os.path.join(self.root, "pkg", "mod.py"), "w") as fh:
            fh.write("line1\nline2\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        self.fetch = make_fetch(FILES)
        # add_patch fetches through patchsource — route it to the fake too
        from omlx_uplift import patchsource
        pf = self.fetch

        def fake_fetch(url, *a, **kw):
            r = pf(url)
            if not r.get("ok"):
                return r
            return {"ok": True, "data": r["data"], "source_head_sha": None,
                    "url": url}

        def fake_fetch_pr(repo, pr, *a, **kw):
            return {"ok": True, "data": DIFF, "source_head_sha": None,
                    "url": f"https://github.com/{repo}/pull/{pr}.diff"}
        saved = getattr(patchsource, "fetch_url")
        patchsource.fetch_url = fake_fetch
        self.addCleanup(setattr, patchsource, "fetch_url", saved)
        saved = getattr(patchsource, "fetch_pr")
        patchsource.fetch_pr = fake_fetch_pr
        self.addCleanup(setattr, patchsource, "fetch_pr", saved)

    def test_listing_carries_manifest_fields(self):
        r = curated.list_remote(self.fetch)
        self.assertTrue(r["ok"])
        d = r["tiers"]["default"]
        self.assertEqual([e["id"] for e in d], ["live-apply"])
        e = d[0]
        self.assertEqual(e["description"], "Apply the cap without restart.")
        self.assertEqual(e["source"]["kind"], "github_pr")
        self.assertEqual(e["scope"], "omlx")
        self.assertTrue(e["source_ok"])
        # 'file' source resolves to the sibling .diff raw URL
        nice = [x for x in r["tiers"]["optional"] if x["id"] == "nice"][0]
        self.assertEqual(nice["source"], {
            "kind": "url",
            "url": ("https://raw.githubusercontent.com/zviratko/"
                    "omlx-uplift/HEAD/curated_patches/optional/nice.diff")})
        # unusable source kind -> listed but not installable
        broken = [x for x in r["tiers"]["optional"]
                  if x["id"] == "broken"][0]
        self.assertFalse(broken["source_ok"])

    def test_sync_tier_policy(self):
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertEqual(r["report"]["live-apply"]["sync"], "added_enabled")
        self.assertEqual(r["report"]["nice"]["sync"], "added_disabled")
        self.assertEqual(r["report"]["broken"]["sync"], "skipped_incomplete")
        m = self.store.load()
        p = self.store.find(m, "live-apply")
        self.assertTrue(p["enabled"])
        self.assertEqual(p["description"], "Apply the cap without restart.")
        self.assertEqual(p["curated"], "default")
        self.assertEqual(p["source"]["kind"], "github_pr")
        self.assertFalse(self.store.find(m, "nice")["enabled"])
        self.assertIsNone(self.store.find(m, "broken"))

    def test_sync_idempotent_and_respects_user_choice(self):
        curated.sync(self.store, self.root, fetch=self.fetch)
        # user disables the default-tier patch
        from omlx_uplift import patchsource
        patchsource.set_enabled(self.store, "live-apply", False)
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertEqual(r["report"]["live-apply"]["sync"], "already_present")
        self.assertFalse(self.store.find(self.store.load(),
                                         "live-apply")["enabled"])

    def test_reversal_flag_propagates(self):
        files = dict(FILES)
        files["raw-optional-nice.json"] = json.dumps({
            "description": "Undo a merged change.",
            "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 1},
            "reversal": True})
        # reversal gates in the un-apply direction: tree must contain the
        # change for the reversed diff to apply
        with open(os.path.join(self.root, "pkg", "mod.py"), "w") as fh:
            fh.write("line1\ninjected\nline2\n")
        r = curated.sync(self.store, self.root, fetch=make_fetch(files))
        self.assertEqual(r["report"]["nice"]["sync"], "added_disabled")
        p = self.store.find(self.store.load(), "nice")
        self.assertTrue(p["reversal"])

    def test_failed_listing_is_failsafe(self):
        def dead(url):
            return {"ok": False, "reason": "network down"}
        r = curated.sync(self.store, self.root, fetch=dead)
        self.assertFalse(r["ok"])
        self.assertEqual(r["report"], {})
        self.assertEqual(self.store.load()["patches"], [])

    def test_sync_matches_user_added_patch_by_source(self):
        """User added the same PR under their own id first: sync must NOT
        install a second copy — it marks the existing patch as a catalog
        patch (BUNDLED) and leaves every user decision alone."""
        from omlx_uplift import patchsource
        r = patchsource.add_patch(self.store, "my-pr",
                                  {"kind": "github_pr", "repo": "jundot/omlx",
                                   "pr": 1234}, self.root)
        self.assertTrue(r["ok"], r)
        patchsource.set_enabled(self.store, "my-pr", True)
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertEqual(r["report"]["live-apply"]["sync"], "already_present")
        self.assertEqual(r["report"]["live-apply"]["under_id"], "my-pr")
        m = self.store.load()
        self.assertIsNone(self.store.find(m, "live-apply"))   # no duplicate
        p = self.store.find(m, "my-pr")
        self.assertEqual(p["curated"], "default")             # BUNDLED mark
        self.assertTrue(p["enabled"])                         # user choice kept
        # and the catalog preview agrees: installed under their id
        lst = curated.list_remote(self.fetch)
        e = lst["tiers"]["default"][0]
        self.assertTrue(e["source_ok"])   # preview flags source, router adds 'installed'

    def test_adopt_detaches_and_sync_respects_it(self):
        from omlx_uplift import patchsource
        curated.sync(self.store, self.root, fetch=self.fetch)   # installs live-apply enabled
        r = curated.adopt(self.store, "live-apply")
        self.assertTrue(r["ok"])
        m = self.store.load()
        p = self.store.find(m, "live-apply")
        self.assertNotIn("curated", p)
        self.assertTrue(p["curated_adopted"])
        self.assertTrue(p["enabled"])          # adoption never changes state
        # a later sync sees it but never re-bundles or duplicates it
        r = curated.sync(self.store, self.root, fetch=self.fetch)
        self.assertEqual(r["report"]["live-apply"]["sync"], "already_present")
        self.assertTrue(r["report"]["live-apply"]["adopted"])
        self.assertNotIn("curated", self.store.find(self.store.load(),
                                                    "live-apply"))

    def test_norm_source_identity(self):
        self.assertEqual(curated.norm_source(
            {"kind": "github_pr", "repo": "Jundot/omlx", "pr": "12"}),
            ("github_pr", "jundot/omlx", 12))
        self.assertIsNone(curated.norm_source({"kind": "github_pr", "pr": 1}))
        self.assertIsNone(curated.norm_source({"kind": "upload"}))
        self.assertIsNone(curated.norm_source(None))

    def test_absent_tier_is_empty_not_error(self):
        files = {k: v for k, v in FILES.items()
                 if "optional" not in k and "nice" not in k
                 and "broken" not in k}
        files.pop("api-listing-optional", None)
        r = curated.list_remote(make_fetch(files))
        self.assertTrue(r["ok"])
        self.assertEqual(r["tiers"].get("optional"), [])
        self.assertNotIn("optional", r["errors"])

    # ---- bundled patches apply to BOTH targets (user ask 2026-09-27) ----
    def _files_scope_both(self):
        files = dict(FILES)
        md = json.loads(files["raw-default-live-apply.json"])
        md["scope"] = "both"
        files["raw-default-live-apply.json"] = json.dumps(md)
        return files

    def _build_root(self):
        # a clean dev-src checkout stand-in carrying the patch target
        root = os.path.join(self.tmp, "dev-src")
        os.makedirs(os.path.join(root, "pkg"))
        with open(os.path.join(root, "pkg", "mod.py"), "w") as fh:
            fh.write("line1\nline2\n")
        return root

    def test_sync_installs_both_when_dev_available(self):
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()),
                         build_root=self._build_root())
        self.assertEqual(r["report"]["live-apply"]["sync"], "added_enabled")
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "both")

    def test_sync_both_without_dev_falls_back_runtime(self):
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()))
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "omlx")
        self.assertTrue(any("runtime-only" in n for n in r["notes"]))

    def test_sync_both_dev_gate_refusal_falls_back_runtime(self):
        # build root WITHOUT the patch target -> full-diff gate refuses
        empty = os.path.join(self.tmp, "empty-src")
        os.makedirs(empty, exist_ok=True)
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()),
                         build_root=empty)
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "omlx")
        self.assertTrue(p["enabled"])   # fallback still installs default tier
        self.assertTrue(any("fell back to runtime" in n for n in r["notes"]))
        self.assertEqual(p.get("both_refused_v"), p.get("desired_version"))

    def test_refused_rescope_does_not_churn_on_every_sync(self):
        # same content again: the refusal is remembered, no remove/re-add
        empty = os.path.join(self.tmp, "empty-src")
        os.makedirs(empty, exist_ok=True)
        both = make_fetch(self._files_scope_both())
        curated.sync(self.store, self.root, fetch=both, build_root=empty)
        first = self.store.find(self.store.load(), "live-apply")
        v_file = first["versions"][0]["patch_file"]
        r2 = curated.sync(self.store, self.root, fetch=both, build_root=empty)
        self.assertEqual(r2["report"]["live-apply"]["sync"], "already_present")
        second = self.store.find(self.store.load(), "live-apply")
        # stored version untouched — no new version materialized
        self.assertEqual(second["versions"][0]["patch_file"], v_file)
        self.assertEqual(len(second["versions"]), 1)

    def test_rescope_migrates_installed_omlx_patch_to_both(self):
        # first install runtime-only (no dev carrier), THEN omlx-dev gets
        # bootstrapped and a sync widens the scope: stored diff is the
        # FULL bytes, enabled flag survives
        both = make_fetch(self._files_scope_both())
        curated.sync(self.store, self.root, fetch=both)   # no build_root yet
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "omlx")
        r = curated.sync(self.store, self.root, fetch=both,
                         build_root=self._build_root())
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "both")
        self.assertTrue(p["enabled"])
        self.assertTrue(p["curated"])
        # one patch, not a second copy
        ids = [x["id"] for x in self.store.load()["patches"]]
        self.assertEqual(ids.count("live-apply"), 1)

    def test_rescope_never_touches_user_chosen_scope(self):
        # a patch the user added themselves (no curated stamp) keeps its
        # omlx scope — the catalog must not re-scope user decisions
        from omlx_uplift import patchsource
        patchsource.add_patch(self.store, "mine", {
            "kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
            self.root)
        m = self.store.load()
        p = self.store.find(m, "mine")
        p["curated"] = "default"       # recognized as a catalog patch
        self.store.save(m)
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()),
                         build_root=self._build_root())
        self.assertEqual(r["report"]["live-apply"]["sync"], "already_present")
        self.assertEqual(patches.patch_scope(
            self.store.find(self.store.load(), "mine")), "omlx")


if __name__ == "__main__":
    unittest.main()
