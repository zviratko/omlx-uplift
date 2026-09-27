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

    def test_absent_tier_is_empty_not_error(self):
        files = {k: v for k, v in FILES.items()
                 if "optional" not in k and "nice" not in k
                 and "broken" not in k}
        files.pop("api-listing-optional", None)
        r = curated.list_remote(make_fetch(files))
        self.assertTrue(r["ok"])
        self.assertEqual(r["tiers"].get("optional"), [])
        self.assertNotIn("optional", r["errors"])


if __name__ == "__main__":
    unittest.main()
