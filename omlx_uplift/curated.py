"""Curated patch catalog (zviratko/omlx-uplift @ curated_patches/).

The maintainer publishes ready-made patches under
``curated_patches/default/`` and ``curated_patches/optional/`` in the
public uplift repo. Every patch is ONE manifest file, ``<name>.json``,
shaped like a store patch entry so it merges into the local manifest
naturally:

    {
      "description": "short purpose of the patch",
      "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 1234},
      "reversal": false,              // optional, default false
      "scope":    "omlx"              // optional: omlx|dev|both; omit = auto
    }

``source`` is whatever upstream exists: a github_pr link (preferred —
the catalog never duplicates content an open PR already owns), a plain
url, or ``{"kind": "file"}`` for a vendored ``<name>.diff`` sitting next
to the manifest — vendored diffs are the exception for features that
have no PR at all.

Policy (user spec 2026-09-27):
  * default tier  -> installed, ENABLED (reconcile applies it like any
                     enabled patch; on omlx-dev the dev materializer
                     picks it up through the shared store)
  * optional tier -> installed but NOT enabled (present, visible, one
                     click away)
  * re-sync never overwrites user decisions: an existing patch keeps its
    enabled flag and desired_version; the normal drift check keeps it
    fresh afterwards.

Everything network here is fail-safe: a failed fetch leaves the local
store exactly as it was (same rule as patchsource.check_all).
"""
from __future__ import annotations

import json
import logging
import re

from . import patches, patchsource

_log = logging.getLogger("omlx_uplift.curated")

CURATED_REPO = "zviratko/omlx-uplift"
CURATED_DIR = "curated_patches"
TIERS = ("default", "optional")

_API = "https://api.github.com/repos/{repo}/contents/{dir}/{tier}"
_RAW = "https://raw.githubusercontent.com/{repo}/HEAD/{dir}/{tier}/{name}"


def _slug(filename: str) -> str | None:
    """manifest filename -> patch id (same charset the store enforces)."""
    base = re.sub(r"\.json$", "", filename or "")
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", base):
        return base
    return None


def _raw_url(tier: str, name: str) -> str:
    return _RAW.format(repo=CURATED_REPO, dir=CURATED_DIR, tier=tier,
                       name=name)


def norm_source(src) -> tuple | None:
    """Comparable identity of a patch source (None = nothing to match).
    Two sources are the SAME patch when they normalize equal — that is
    how the catalog recognizes a patch the user added by hand (same PR
    linked twice is one patch, under any id)."""
    src = src or {}
    kind = src.get("kind")
    if kind == "github_pr":
        repo = str(src.get("repo") or "").strip().lower()
        try:
            pr = int(src.get("pr"))
        except (TypeError, ValueError):
            return None
        return ("github_pr", repo.lstrip("/"), pr) if repo and pr else None
    if kind == "url":
        u = str(src.get("url") or "").strip().rstrip("/")
        return ("url", u) if u else None
    return None


def find_by_source(manifest: dict, src) -> dict | None:
    """The stored patch whose source matches `src` — by normalized
    identity, NOT by id: a patch the user added themselves under any
    name is still the same patch as the catalog entry."""
    nid = norm_source(src)
    if nid is None:
        return None
    for p in manifest.get("patches", []):
        if norm_source(p.get("source")) == nid:
            return p
    return None


def _list_tier(tier: str, fetch) -> dict:
    """Directory listing for one tier. Returns {ok, entries|reason}.
    An absent directory (HTTP 404) is an EMPTY tier, not an error — the
    repo may only ship defaults, or none at all yet."""
    url = _API.format(repo=CURATED_REPO, dir=CURATED_DIR, tier=tier)
    r = fetch(url)
    if not r.get("ok"):
        if r.get("status") == 404:
            return {"ok": True, "entries": []}
        return {"ok": False, "reason": r.get("reason") or "listing failed"}
    try:
        items = json.loads(r["data"])
    except ValueError:
        return {"ok": False, "reason": "corrupt listing response"}
    if not isinstance(items, list):
        return {"ok": False, "reason": "unexpected listing shape"}
    entries = []
    for it in items:
        name = it.get("name") or ""
        if not name.endswith(".json"):
            continue
        pid = _slug(name)
        if pid is None:
            continue
        entries.append({"tier": tier, "id": pid, "name": name})
    return {"ok": True, "entries": entries}


def _fetch_manifest(entry: dict, fetch) -> dict:
    """Fetch + parse one <name>.json. Returns {} on any failure — the
    entry then comes back without metadata (listed, never installed)."""
    r = fetch(_raw_url(entry["tier"], entry["name"]))
    if not r.get("ok"):
        return {}
    try:
        data = json.loads(r["data"].decode("utf-8", "replace"))
    except (ValueError, AttributeError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _entry_source(entry: dict):
    """catalog source field -> (add_patch source dict | None).
    'file' resolves to the vendored <name>.diff sitting next to the
    manifest; anything already shaped for add_patch passes through."""
    src = entry.get("source") or {}
    kind = src.get("kind")
    if kind == "file":
        return {"kind": "url",
                "url": _raw_url(entry["tier"],
                                re.sub(r"\.json$", ".diff", entry["name"]))}
    if kind in ("github_pr", "url"):
        return dict(src)
    return None


def list_remote(fetch=None) -> dict:
    """All curated entries across both tiers: {ok, tiers: {tier: [entries]},
    errors: {tier: reason}}. A tier that fails to list does not poison the
    other one. Each entry carries its manifest fields (description,
    source, reversal, scope); 'source_ok' marks whether the source is
    installable at all."""
    if fetch is None:
        from .patchsource import fetch_bytes as _fb

        def fetch(url):
            return _fb(url)
    out, errors = {}, {}
    for tier in TIERS:
        r = _list_tier(tier, fetch)
        if not r["ok"]:
            errors[tier] = r["reason"]
            continue
        for e in r["entries"]:
            meta = _fetch_manifest(e, fetch)
            e["description"] = str(meta.get("description") or "")[:300]
            e["reversal"] = bool(meta.get("reversal"))
            e["scope"] = meta.get("scope")
            src = _entry_source(dict(meta, tier=tier, name=e["name"]))
            e["source"] = src
            e["source_ok"] = src is not None and bool(e["description"])
        out[tier] = r["entries"]
    ok = len(errors) < len(TIERS)
    return {"ok": ok, "tiers": out, "errors": errors}


def sync(store, tree_root: str, fetch=None, build_root: str | None = None) -> dict:
    """Install/surface the curated catalog. Idempotent: re-running after
    user edits changes nothing about their decisions.

    Per entry the report says: added_enabled | added_disabled |
    added_pending_approval | already_present | skipped_incomplete |
    skipped_obsolete | failed.
    """
    def _f(url):
        if fetch is not None:
            return fetch(url)
        from .patchsource import fetch_bytes
        return fetch_bytes(url)

    listing = list_remote(_f)
    report, notes = {}, []
    manifest = store.load()
    for tier in TIERS:
        for e in listing["tiers"].get(tier, []):
            pid = e["id"]
            add_id = pid          # rescope re-adds keep the existing store id
            was_enabled = False   # survives a remove/re-add rescope
            if not e.get("source_ok"):
                # manifest missing/unparsable, no usable source, or no
                # description — never install half-declared work
                why = ("manifest missing or unreadable"
                       if not e.get("source") else "description missing")
                report[pid] = {"sync": "skipped_incomplete", "reason": why}
                notes.append(f"{pid}: {why}")
                continue
            # identity is the SOURCE, not the id: a patch the user added
            # themselves (same PR link under any name) is the same patch
            # — never install a second copy of it
            p = (find_by_source(manifest, e["source"])
                 or store.find(manifest, pid))
            if p is not None:
                if p.get("curated_adopted"):
                    # the user adopted it — it is theirs, the catalog
                    # lists but no longer claims it
                    report[pid] = {"sync": "already_present",
                                   "under_id": p["id"], "adopted": True}
                    continue
                if p.get("id") != pid or not p.get("curated"):
                    # user-added match: keep their id/decisions, mark it
                    # as a catalog patch (BUNDLED badge lights)
                    p["curated"] = tier
                    if not p.get("description") and e.get("description"):
                        p["description"] = e["description"]
                    store.save(manifest)
                # scope migration (user ask 2026-09-27: bundled patches
                # apply to BOTH the runtime keg and omlx-dev). Scope is
                # fixed per patch inside patchsource (stored bytes differ:
                # omlx keeps the pruned diff, both stores the FULL diff),
                # so a rescope re-materializes: remove restores vanilla
                # bytes NOW, the re-add gates the full diff and reconcile
                # re-applies at next boot. Only ever widen omlx -> both;
                # never touch a scope the user chose for themselves.
                cur = patches.patch_scope(p)
                was_enabled = bool(p.get("enabled"))
                if (e.get("scope") == patches.SCOPE_BOTH
                        and cur == patches.SCOPE_OMLX
                        and build_root
                        # catalog OWNERSHIP is the curated tier tag — the
                        # store id may differ (installed under a legacy slug
                        # before source dedupe); an adopted patch left the
                        # catalog's scope decisions to the user
                        and p.get("curated") and not p.get("curated_adopted")
                        # a refused full diff is not retried every sync —
                        # only once the patch content changed again (the
                        # stamp rides version numbers, which bump per new
                        # stored version; same-sha re-syncs stay quiet)
                        and p.get("both_refused_v") != p.get("desired_version")):
                    res = patchsource.remove_patch(store, p["id"], tree_root)
                    if not res.get("ok"):
                        report[pid] = {"sync": "already_present",
                                       "under_id": p["id"],
                                       "rescope_failed": res.get("reason")}
                        notes.append(f"{pid}: rescope to both failed "
                                     f"({res.get('reason')}) — kept {cur}")
                        continue
                    # remove_patch saved its own reload — the loop's
                    # manifest copy is stale; re-read so add_patch's
                    # already-taken guard cannot reject the re-add
                    manifest = store.load()
                    add_id = p["id"]   # keep the user/store id stable
                    p = None   # fall through to the add path with scope=both
                else:
                    report[pid] = {"sync": "already_present",
                                   "under_id": p["id"]}
                    continue
            scope_try = e.get("scope")
            if scope_try == patches.SCOPE_BOTH and not build_root:
                # no omlx-dev carrier on this machine — the runtime side
                # alone covers what exists here (notes keep it honest)
                scope_try = None
                notes.append(f"{pid}: scope both requested, omlx-dev not "
                             f"bootstrapped — installed runtime-only")
            res = patchsource.add_patch(store, add_id, dict(e["source"]),
                                        tree_root, scope=scope_try,
                                        reversal=bool(e.get("reversal")),
                                        build_root=build_root)
            both_refused = None
            if (not res.get("ok") and not res.get("obsolete")
                    and scope_try == patches.SCOPE_BOTH):
                # the dev side refuses the full diff (context drifted from
                # the sync ref, kernel-only paths...) — the runtime side is
                # still valuable; fall back instead of losing the patch
                notes.append(f"{pid}: both refused ({res.get('reason')}) — "
                             f"fell back to runtime scope")
                both_refused = str(res.get("reason") or "")[:200]
                res = patchsource.add_patch(store, pid, dict(e["source"]),
                                            tree_root,
                                            scope=patches.SCOPE_OMLX,
                                            reversal=bool(e.get("reversal")))
            if res.get("obsolete"):
                # upstream already carries it on this machine — not an
                # error; nothing stored, nothing to enable
                report[pid] = {"sync": "skipped_obsolete"}
                continue
            if not res.get("ok"):
                report[pid] = {"sync": "failed", "stage": res.get("stage"),
                               "reason": res.get("reason")}
                notes.append(f"{pid}: gate refused ({res.get('reason')})")
                continue
            manifest = store.load()
            p = store.find(manifest, add_id)
            if p is not None and (tier == "default" or was_enabled):
                # re-scoped patches keep the user's enabled flag (a remove/
                # re-add would otherwise silently reset optional-tier ones)
                en = patchsource.set_enabled(store, add_id, True)
                if en.get("ok"):
                    report[pid] = {"sync": "added_enabled"}
                else:
                    # safeguard approval pending is NOT a failure — the
                    # patch is installed, the dashboard asks to approve
                    report[pid] = {"sync": "added_pending_approval",
                                   "reason": en.get("reason")}
                    notes.append(f"{pid}: {en.get('reason')}")
            else:
                report[pid] = {"sync": "added_disabled"}
            # annotation LAST: set_enabled saves its own manifest reload —
            # writing description/curated before it would be lost
            manifest = store.load()
            p = store.find(manifest, add_id)
            if p is not None:
                if e.get("description"):
                    p["description"] = e["description"]
                p["curated"] = tier
                if both_refused is not None:
                    # remember WHICH content the dev side refused; re-scope
                    # attempts resume only when a new version lands
                    p["both_refused_v"] = p.get("desired_version")
                    p["both_refused_reason"] = both_refused
                store.save(manifest)
    for tier, reason in listing["errors"].items():
        notes.append(f"tier {tier}: {reason}")
    return {"ok": listing["ok"], "report": report, "notes": notes}


def adopt(store, patch_id: str) -> dict:
    """Adopt the patch as local: unbundle it from the curated catalog.
    The patch keeps its id, state, enabled flag and every version record
    — it simply stops being a catalog patch: no BUNDLED badge, future
    syncs never touch it again. This is the graceful alternative to
    Remove (user decision 2026-09-27: the catalog must not silently
    delete work the user relies on)."""
    manifest = store.load()
    p = store.find(manifest, patch_id)
    if p is None:
        return {"ok": False, "reason": f"unknown patch id: {patch_id}"}
    p.pop("curated", None)
    p["curated_adopted"] = True
    store.save(manifest)
    return {"ok": True, "id": patch_id}
