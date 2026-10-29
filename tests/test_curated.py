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

# DISTINCT content for the second synthetic catalog entry: since the
# content-twin guard (user report 2026-10-29 — a catalog vendor and the
# PR behind it installed side by side), two catalog entries carrying the
# same bytes are a duplicate BY DESIGN, so fixtures that model two
# different patches must ship two different diffs.
NICE_DIFF = DIFF.replace(b"+injected\n", b"+injected-nice\n")

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

# index.json per tier is the listing now; the contents API survives only as
# the legacy fallback (mruu ask 2026-10-29: that call is capped at 60/hour
# unauthenticated and its refusal used to empty the catalog silently). A
# non-manifest name in the index is skipped, same as before.
FILES = {
    "raw-default-index.json": ["live-apply.json", "stray.diff"],
    "raw-optional-index.json": ["nice.json", "broken.json", "nice.diff"],
    "raw-default-live-apply.json": MD_PR,
    "raw-optional-nice.json": MD_FILE,
    "raw-optional-nice.diff": NICE_DIFF,
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


def _w(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


class CuratedSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-curated-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # These fixtures describe a SYNTHETIC catalog. Without redirecting the
        # bundled seed, a refused listing would fall back to the catalog this
        # repository actually ships and install real patches into the store.
        old = curated.SEED_DIRS
        curated.SEED_DIRS = [os.path.join(self.tmp, "no-such-seed")]
        self.addCleanup(setattr, curated, "SEED_DIRS", old)
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
        # The card must be able to tell a FAILED check from a quiet one
        # (mruu report 2026-10-29): a tier that could not be listed used to
        # reach the dashboard only as a note line, in the same muted text
        # as informational per-patch chatter.
        self.assertEqual(sorted(r["tier_errors"]), ["default", "optional"])
        self.assertIn("network down", r["tier_error_text"])
        self.assertIn("tier default:", r["tier_error_text"])

    def test_rate_limited_listing_reports_the_refusal(self):
        # the exact shape of an unauthenticated GitHub contents call after
        # the hourly budget is spent
        def wall(url):
            return {"ok": False, "reason": "HTTP 403 from " + url}
        r = curated.sync(self.store, self.root, fetch=wall)
        self.assertFalse(r["ok"])
        self.assertIn("HTTP 403", r["tier_error_text"])
        self.assertTrue(any("tier default" in n for n in r["notes"]))

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

    def test_catalog_never_demotes_from_the_build(self):
        # USER VETO 2026-10-18 (mruu): I narrowed ctx-probe/voice14
        # both->omlx in the catalog and their next dev upgrade dropped them
        # from the build without a word. Rule now pinned by code: sync may
        # widen toward the build, a declared-narrower catalog NEVER shrinks
        # a catalog-owned entry's scope. Leaving the build is a user action.
        br = self._build_root()
        curated.sync(self.store, self.root, fetch=make_fetch(
                         self._files_scope_both()),
                     build_root=br)
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "both")
        r = curated.sync(self.store, self.root, fetch=make_fetch(FILES),
                         build_root=br)
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "both",
                         "sync demoted a build-scope patch to runtime")
        self.assertTrue(p["enabled"])
        self.assertEqual(r["report"]["live-apply"]["sync"], "already_present")
        # no re-materialize churn either
        ids = [x["id"] for x in self.store.load()["patches"]]
        self.assertEqual(ids.count("live-apply"), 1)

    def test_narrow_never_touches_adopted_or_user_scopes(self):
        # an adopted patch left the catalog's scope decisions to the
        # user; a user-added (not catalog-owned) entry keeps its scope.
        br = self._build_root()
        curated.sync(self.store, self.root, fetch=make_fetch(
                         self._files_scope_both()),
                     build_root=br)
        m = self.store.load()
        self.store.find(m, "live-apply")["curated_adopted"] = True
        self.store.save(m)
        curated.sync(self.store, self.root, fetch=make_fetch(FILES),
                     build_root=br)
        p = self.store.find(self.store.load(), "live-apply")
        self.assertEqual(patches.patch_scope(p), "both")

    def test_rescope_migrates_legacy_slug_under_different_id(self):
        # the real-world store: catalog patch installed BEFORE source
        # dedupe under a legacy slug (prXXXX) — dedupe recognizes it by
        # SOURCE, stamps curated, and the rescope must widen THAT entry
        # (id != catalog pid) without adding a second copy
        from omlx_uplift import patchsource
        patchsource.add_patch(self.store, "pr1234", {
            "kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
            self.root)
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()),
                         build_root=self._build_root())
        # rescope re-materializes: remove + re-add UNDER THE SAME STORE ID
        # (user decisions ride the id — a rename would orphan them)
        self.assertEqual(r["report"]["live-apply"]["sync"], "added_enabled")
        p = self.store.find(self.store.load(), "pr1234")
        self.assertEqual(patches.patch_scope(p), "both")
        self.assertTrue(p["curated"])
        self.assertTrue(p["enabled"])
        ids = [x["id"] for x in self.store.load()["patches"]]
        self.assertEqual(ids.count("pr1234"), 1)
        self.assertNotIn("live-apply", ids)

    def test_rescope_widens_source_matched_patch(self):
        # a patch the user added themselves that dedupe recognizes as the
        # catalog's (same source) IS catalog-owned from then on — bundled
        # scope policy applies: widen omlx -> both, keep it enabled
        from omlx_uplift import patchsource
        patchsource.add_patch(self.store, "mine", {
            "kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
            self.root)
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()),
                         build_root=self._build_root())
        self.assertEqual(r["report"]["live-apply"]["sync"], "added_enabled")
        p = self.store.find(self.store.load(), "mine")
        self.assertEqual(patches.patch_scope(p), "both")  # id kept, widened
        self.assertTrue(p["curated"])
        self.assertTrue(p["enabled"])
        ids = [x["id"] for x in self.store.load()["patches"]]
        self.assertEqual(ids.count("mine"), 1)

    def test_rescope_never_touches_adopted_patch(self):
        # adopt-as-local = the user owns the scope decision; sync must not
        # re-scope it, only leave it present
        from omlx_uplift import patchsource
        patchsource.add_patch(self.store, "mine", {
            "kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
            self.root)
        m = self.store.load()
        p = self.store.find(m, "mine")
        p["curated"] = "default"
        p["curated_adopted"] = True    # adopted: catalog no longer claims it
        self.store.save(m)
        r = curated.sync(self.store, self.root,
                         fetch=make_fetch(self._files_scope_both()),
                         build_root=self._build_root())
        self.assertEqual(r["report"]["live-apply"]["sync"], "already_present")
        self.assertEqual(patches.patch_scope(
            self.store.find(self.store.load(), "mine")), "omlx")


class BundledCatalogTests(unittest.TestCase):
    """Discovery without the rate-limited contents API (mruu ask
    2026-10-29). Order is: index.json on the raw CDN, then the copy bundled
    inside this installed uplift, then the legacy API. A tier served from the
    seed is DEGRADED, not failed: the operator must still be able to install
    what their version knows about, and the card must not read a refusal as
    'catalog empty'."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-seed-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "site-packages")
        os.makedirs(os.path.join(self.root, "pkg"))
        with open(os.path.join(self.root, "pkg", "mod.py"), "w") as fh:
            fh.write("line1\nline2\n")
        self.store = patches.PatchStore(os.path.join(self.tmp, "data"))
        # a synthetic bundled catalog
        self.seed = os.path.join(self.tmp, "seed")
        for tier in ("default", "optional"):
            os.makedirs(os.path.join(self.seed, tier))
        _w(os.path.join(self.seed, "default", "index.json"),
           {"entries": ["bundled-one.json"]})
        _w(os.path.join(self.seed, "default", "bundled-one.json"),
           {"description": "Ships inside the keg.", "source": {"kind": "file"}})
        with open(os.path.join(self.seed, "default", "bundled-one.diff"), "wb") as fh:
            fh.write(DIFF)
        _w(os.path.join(self.seed, "optional", "index.json"), {"entries": []})
        self.addCleanup(setattr, curated, "SEED_DIRS", curated.SEED_DIRS)
        curated.SEED_DIRS = [self.seed]
        from omlx_uplift import patchsource
        saved = patchsource.fetch_url

        def fake_fetch(url, *a, **kw):
            return {"ok": True, "data": DIFF, "source_head_sha": None,
                    "url": url}
        patchsource.fetch_url = fake_fetch
        self.addCleanup(setattr, patchsource, "fetch_url", saved)

    def test_remote_index_answers_without_touching_the_api(self):
        seen = []

        def fetch(url):
            seen.append(url)
            if url.endswith("default/index.json"):
                return {"ok": True, "data": json.dumps(
                    {"entries": ["remote-a.json"]}).encode()}
            if url.endswith("default/remote-a.json"):
                return {"ok": True, "data": json.dumps(
                    {"description": "From the repository.",
                     "source": {"kind": "file"}}).encode()}
            return {"ok": False, "status": 404, "reason": "HTTP 404"}
        r = curated.list_remote(fetch)
        self.assertTrue(r["ok"])
        self.assertEqual([e["id"] for e in r["tiers"]["default"]],
                         ["remote-a"])
        self.assertEqual(r["origins"]["default"], "remote")
        # the optional tier has no remote index here -> the seed serves it
        self.assertEqual(r["origins"]["optional"], "bundled")
        self.assertEqual(r["tiers"]["optional"], [])
        self.assertFalse([u for u in seen if "api.github.com" in u],
                         "the rate-limited API must not be consulted when "
                         "the index answers")

    def test_refused_index_falls_back_to_the_bundled_seed(self):
        def fetch(url):
            return {"ok": False, "status": 403,
                    "reason": "HTTP 403 from " + url}
        r = curated.list_remote(fetch)
        self.assertTrue(r["ok"])
        self.assertEqual(r["errors"], {})
        self.assertEqual([e["id"] for e in r["tiers"]["default"]],
                         ["bundled-one"])
        self.assertEqual(r["origins"]["default"], "bundled")
        # metadata comes from the bundled manifest too, so the row is real
        self.assertEqual(r["tiers"]["default"][0]["description"],
                         "Ships inside the keg.")
        rep = curated.sync(self.store, self.root, fetch=fetch)
        self.assertEqual(rep["report"]["bundled-one"]["sync"], "added_enabled")
        self.assertEqual(rep["tier_errors"], {})
        notes = " ".join(rep["notes"])
        self.assertIn("bundled with this uplift version", notes)
        self.assertIn("update uplift to see it", notes)

    def test_no_remote_and_no_seed_is_a_real_failure(self):
        curated.SEED_DIRS = [os.path.join(self.tmp, "no-seed-here")]

        def fetch(url):
            return {"ok": False, "status": 403,
                    "reason": "HTTP 403 from " + url}
        r = curated.list_remote(fetch)
        self.assertFalse(r["ok"])
        self.assertIn("default", r["errors"])
        self.assertIn("bundled seed had none", r["errors"]["default"])
        rep = curated.sync(self.store, self.root, fetch=fetch)
        self.assertEqual(rep["tier_errors"], r["errors"])
        self.assertEqual(self.store.load()["patches"], [])


class ShippedCatalogIntegrity(unittest.TestCase):
    """The bundled seed and its index must not drift apart: index.json is
    hand-maintained next to the files it lists, and a patch added without a
    line in the index would be invisible to every install (the old API
    listing saw the directory, so it could not hide)."""

    # captured before any test in this module redirects the seed
    SEEDS = list(curated.SEED_DIRS)

    def _tier_dir(self, tier):
        for root in self.SEEDS:
            d = os.path.join(root, tier)
            if os.path.isdir(d):
                return d
        self.fail("no catalog seed directory for tier " + tier)

    def test_build_hook_bundles_the_catalog(self):
        """The wheel copy is what makes the seed exist on an installed box.
        It is a build-time move, so nothing else in the suite would notice if
        the hook were dropped (mruu report: the first attempt MOVED the
        directory instead, which broke every install that had not updated)."""
        # the hook sits at the project root: next to the catalog directory in
        # a checkout, one level above the installed package copy
        found = None
        for seed in self.SEEDS:
            for cand in (os.path.dirname(seed),
                         os.path.dirname(os.path.dirname(seed))):
                path = os.path.join(cand, "setup.py")
                if os.path.isfile(path):
                    found = path
                    break
            if found:
                break
        self.assertTrue(found, "no setup.py reachable from the seed roots")
        with open(found, encoding="utf-8") as fh:
            hook = fh.read()
        self.assertIn('CATALOG = "curated_patches"', hook)
        self.assertIn('cmdclass={"build_py": build_py_with_catalog}', hook)
        # and it copies per tier, so a new tier cannot be forgotten silently
        self.assertIn("self.mkpath(out)", hook)
        self.assertIn("shutil.copy2", hook)

    def test_published_catalog_path_is_untouched(self):
        """`curated_patches/` at the repository root is a published raw-URL
        coordinate: it is baked into every stored catalog patch source and into
        every uplift build older than the reader. Changing it 404s those
        installs (it did, once), so moving it is a migration, not a rename."""
        self.assertEqual(curated.CURATED_DIR, "curated_patches")
        self.assertEqual(
            curated._raw_url("default", "warm-before-ready.diff"),
            "https://raw.githubusercontent.com/zviratko/omlx-uplift/HEAD/"
            "curated_patches/default/warm-before-ready.diff")

    def test_index_equals_the_directory_for_every_tier(self):
        for tier in curated.TIERS:
            d = self._tier_dir(tier)
            with open(os.path.join(d, curated.INDEX_NAME), encoding="utf-8") as fh:
                idx = json.load(fh)
            listed = idx.get("entries")
            self.assertIsInstance(listed, list, tier + ": index entries list")
            on_disk = sorted(f for f in os.listdir(d)
                             if f.endswith(".json") and f != curated.INDEX_NAME)
            self.assertEqual(sorted(listed), on_disk,
                             "%s/%s does not match the directory %s"
                             % (tier, curated.INDEX_NAME, on_disk))

    def test_every_shipped_manifest_is_installable(self):
        for tier in curated.TIERS:
            d = self._tier_dir(tier)
            with open(os.path.join(d, curated.INDEX_NAME), encoding="utf-8") as fh:
                names = json.load(fh).get("entries") or []
            for name in names:
                path = os.path.join(d, name)
                with open(path, encoding="utf-8") as fh:
                    meta = json.load(fh)
                self.assertTrue(str(meta.get("description") or "").strip(),
                                name + ": a catalog entry needs a description")
                src = meta.get("source") or {}
                self.assertIn(src.get("kind"), ("file", "github_pr", "url"),
                              name + ": unusable source kind")
                if src.get("kind") == "file":
                    diff = os.path.join(d, name[:-5] + ".diff")
                    self.assertTrue(os.path.isfile(diff),
                                    name + ": source 'file' needs the "
                                            "sibling .diff bundled too")
                    self.assertGreater(os.path.getsize(diff), 0,
                                       name + ": empty diff")



if __name__ == "__main__":
    unittest.main()
