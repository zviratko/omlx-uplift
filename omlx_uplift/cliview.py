"""Human output for the omlx-uplift CLI (CLI-REVIEW, user 2026-11-12).

Most patch and dev verbs used to print their raw result dict as JSON. That
payload stays available, byte for byte, behind `--json`; without it the
verbs print what happened in plain words, one line per patch, and name the
next command when one is needed.

Rules (same as `patch status`):
  * the verdict words are the dashboard chip words;
  * no internal nouns (keg, manifest, overlay) in the printed text;
  * colour only on a TTY without NO_COLOR;
  * failures go to stderr, the result of a successful action to stdout.
"""
from __future__ import annotations

import shutil
import sys
import textwrap

# verb -> what the line says after the patch id when the action worked
_DONE = {
    "enable": "enabled",
    "disable": "disabled",
    "remove": "removed",
    "promote": "now uses the newest stored version",
    "rollback": "rolled back",
    "approve": "approval recorded",
    "adopt": "adopted as your own patch (catalog updates stop)",
    "order": "apply priority set",
    "add": "added",
    "update": "updated",
    "rebase": "rebased",
}


def _paint(stream, text: str, code: str) -> str:
    from .cli import _paint as p
    return p(stream, text, code)


def _cols() -> int:
    return shutil.get_terminal_size((100, 24)).columns


def _note(stream, text: str, indent: int = 4) -> None:
    for ln in textwrap.wrap(" ".join(str(text).split()),
                            width=max(30, _cols() - indent)) or [""]:
        print(" " * indent + _paint(stream, ln, "90"), file=stream)


def _when(store, pid: str) -> str:
    """'the next server restart' / 'the next omlx-dev build' for a pending
    patch, read from the store after the action."""
    try:
        from . import patchsource
        p = store.find(store.load(), pid)
        return patchsource.applies_phrase(p) if p else ""
    except Exception:              # noqa: BLE001 - wording only
        return ""


def gate_files(stream, out: dict, limit: int = 12) -> None:
    """The per-file evidence of a refused gate: failing files first, then
    one count line for the files that already match."""
    files = out.get("files") or []
    fails = [f for f in files if f.get("status") == "fail"]
    already = [f for f in files if f.get("status") == "already"]
    for f in fails[:limit]:
        reason = str(f.get("reason") or "does not apply").split(" — ")[0]
        print("    " + _paint(stream, "FAIL", "31") + "  "
              + str(f.get("path")) + "  " + _paint(stream, reason, "90"),
              file=stream)
    if len(fails) > limit:
        print(f"    ... and {len(fails) - limit} more failing files",
              file=stream)
    if already:
        print(_paint(stream, f"    {len(already)} other file(s) already "
                     "contain these changes", "90"), file=stream)


def action(verb: str, pid: str, out: dict, store=None) -> int:
    """One patch verb's result in words. Returns the exit code."""
    ok = bool(out.get("ok"))
    if not ok:
        err = sys.stderr
        reason = out.get("reason") or out.get("stage") or "refused"
        if out.get("stage") == "gate":
            reason = "the new version does not apply cleanly"
        print(_paint(err, f"{pid}: {verb} failed", "1;31") + f" - {reason}",
              file=err)
        if out.get("files"):
            gate_files(err, out)
        if out.get("conflicts"):
            for f in out["conflicts"]:
                print("    " + _paint(err, "CONFLICT", "33") + "  " + f,
                      file=err)
        if out.get("requires_approval"):
            print(f"    approve with: omlx-uplift patch {verb} {pid} "
                  "--approve once", file=err)
        return 1
    st = sys.stdout
    what = _DONE.get(verb, verb)
    if verb == "remove" and out.get("disabled_instead"):
        what = "disabled (catalog patches are disabled, not removed)"
    if verb == "order" and out.get("order") is not None:
        what += f" to {out['order']} (was {out.get('previous')})"
    if verb in ("add", "update") and out.get("unchanged"):
        what = "already up to date"
    if verb == "rebase" and out.get("unchanged"):
        what = "still applies - nothing to rebase"
    v = out.get("desired_version") or out.get("newest_version") or out.get("v")
    if v and verb not in ("order", "approve", "adopt", "remove", "disable"):
        what += f", active version v{v}"
    print(_paint(st, pid, "1") + ": " + what, file=st)
    state = out.get("state")
    if state == "pending" and store is not None:
        when = _when(store, pid)
        if when:
            _note(st, f"takes effect at {when}")
    for key in ("note",):
        if out.get(key) and not (verb == "rebase" and out.get("unchanged")):
            _note(st, out[key])
    if verb == "remove" and out.get("disabled_instead") and out.get("reason"):
        _note(st, out["reason"])
    if verb == "remove" and out.get("tree_bytes"):
        _note(st, f"installed files: {out['tree_bytes']}")
    fsc = out.get("file_set_changed")
    if fsc:
        _note(st, "file set changed: added %s, dropped %s" % (
            ", ".join(fsc.get("added") or []) or "none",
            ", ".join(fsc.get("dropped") or []) or "none"))
    if verb == "rebase" and not out.get("unchanged"):
        _note(st, "build it with: omlx-uplift dev upgrade --restart")
    return 0


# check / update-all -------------------------------------------------------

_CHECK_WORDS = {
    "up_to_date": ("UP TO DATE", "32"),
    "update_available": ("UPDATE", "33"),
    "obsolete": ("UPSTREAMED", "36"),
    "obsolete_reversed": ("RESTORED", "33"),
    "delisted": ("RETIRED", "33"),
    "error": ("ERROR", "31"),
}


def check_reports(title: str, payload: dict) -> int:
    """`patch check` / `patch update-all`: one line per patch source."""
    st = sys.stdout
    targets = payload.get("targets") or [payload]
    rc = 0
    for t in targets:
        reps = t.get("reports") or {}
        print(_paint(st, f"{title} ({t.get('target') or 'omlx'})", "1"),
              file=st)
        if not reps:
            print("  no patch has an online source to check", file=st)
        idw = max([len(k) for k in reps] + [8])
        for pid, r in reps.items():
            if "check" in r:
                word, code = _CHECK_WORDS.get(r["check"],
                                              (r["check"].upper(), "36"))
                extra = ""
                if r["check"] == "update_available":
                    word = f"UPDATE v{r.get('v')}"
                    extra = ("adopted" if r.get("promoted")
                             else r.get("reason") or "press Promote")
                elif r["check"] == "error":
                    from . import devsrc
                    extra = devsrc.gate_failure_detail(r)
                    rc = 1
                elif r.get("reason"):
                    extra = r["reason"]
            else:                       # update-all shapes
                if r.get("skipped"):
                    word, code, extra = "SKIPPED", "90", r["skipped"]
                elif not r.get("ok"):
                    word, code = "ERROR", "31"
                    from . import devsrc
                    extra = devsrc.gate_failure_detail(r)
                    rc = 1
                elif r.get("unchanged"):
                    word, code, extra = "UP TO DATE", "32", ""
                else:
                    word, code = "UPDATED", "32"
                    extra = (f"active version v{r.get('desired_version')}"
                             if r.get("promoted") else (r.get("note") or ""))
            line = ("  " + _paint(st, "%-12s" % word, code) + "  "
                    + "%-*s" % (idw, pid))
            if extra:
                line += "  " + _paint(st, str(extra), "90")
            print(line.rstrip(), file=st)
        if t.get("kill_switch_active"):
            print(_paint(st, "  kill switch is ON - patches stay off until "
                         "'omlx-uplift patch enable-all'", "33"), file=st)
    return rc


def apply_report(payload: dict) -> int:
    """`patch apply`: what the reconcile pass did per patch."""
    st = sys.stdout
    targets = payload.get("targets") or [payload]
    rc = 0
    words = {"applied": ("APPLIED", "32"), "already-clean": ("CLEAN", "90"),
             "restored": ("RESTORED", "36"), "deferred": ("LATER", "33"),
             "needs_review": ("REVIEW", "33"),
             "approval_required": ("HELD", "33")}
    for t in targets:
        print(_paint(st, f"patch apply ({t.get('target') or 'omlx'})", "1"),
              file=st)
        if t.get("skipped_reason"):
            print(f"  nothing applied: {t['skipped_reason']}", file=st)
            continue
        reps = t.get("reports") or []
        if not reps:
            print("  nothing to do", file=st)
        for r in reps:
            word, code = words.get(r.get("action"),
                                   (str(r.get("action")).upper(), "36"))
            if word in ("REVIEW",):
                rc = 1
            line = "  " + _paint(st, "%-9s" % word, code) + "  " + str(
                r.get("id"))
            if r.get("reason"):
                line += "  " + _paint(st, str(r["reason"]), "90")
            print(line, file=st)
        if t.get("changed"):
            _note(st, "files changed on disk - restart the server to load "
                  "them", indent=2)
    return rc


# curated catalog ----------------------------------------------------------

def curated_list(out: dict) -> int:
    st = sys.stdout
    if not out.get("ok"):
        print(_paint(sys.stderr, "catalog not reachable", "1;31") + " - "
              + str(out.get("reason") or out.get("tier_errors") or ""),
              file=sys.stderr)
        return 1
    for tier, rows in (out.get("tiers") or {}).items():
        print(_paint(st, f"catalog: {tier}", "1")
              + _paint(st, "  (installs enabled)" if tier == "default"
                       else "  (installs switched off)", "90"), file=st)
        if not rows:
            print("  (empty)", file=st)
        idw = max([len(str(e.get("id"))) for e in rows] + [8])
        for e in rows:
            if not e.get("source_ok", True):
                word, code = "BROKEN", "31"
            elif e.get("adopted"):
                word, code = "ADOPTED", "36"
            elif e.get("installed"):
                word, code = "INSTALLED", "32"
            else:
                word, code = "NOT YET", "90"
            desc = " ".join(str(e.get("description") or "").split())
            head = "  %-9s  %-*s  " % (word, idw, e.get("id"))
            room = _cols() - len(head)
            if len(desc) > room > 8:
                desc = desc[:room - 1].rstrip() + "…"
            print("  " + _paint(st, "%-9s" % word, code) + "  "
                  + "%-*s" % (idw, e.get("id")) + "  "
                  + _paint(st, desc, "90"), file=st)
    print(_paint(st, "install or refresh: omlx-uplift patch curated --sync",
                 "90"), file=st)
    return 0


def curated_sync(out: dict) -> int:
    st = sys.stdout
    rep = out.get("report") or {}
    words = {"added_enabled": ("ADDED", "32"),
             "added_disabled": ("ADDED OFF", "32"),
             "already_present": ("PRESENT", "90")}
    print(_paint(st, "catalog sync", "1"), file=st)
    idw = max([len(k) for k in rep] + [8])
    for pid, r in rep.items():
        s = str(r.get("sync") or "?")
        word, code = words.get(s, (s.replace("_", " ").upper()[:12], "33"))
        line = "  " + _paint(st, "%-12s" % word, code) + "  " + "%-*s" % (
            idw, pid)
        if r.get("reason"):
            line += "  " + _paint(st, str(r["reason"]), "90")
        print(line.rstrip(), file=st)
    for n in out.get("notes") or []:
        _note(st, n, indent=2)
    return 0 if out.get("ok") else 1


# dev status ---------------------------------------------------------------

def dev_status(cfg: dict, out: dict, active: str | None) -> int:
    st = sys.stdout
    if not out.get("installed"):
        print(_paint(sys.stderr, "omlx-dev is not set up", "1;31") + " - "
              + str(out.get("reason") or ""), file=sys.stderr)
        print("  set it up with: omlx-uplift dev install", file=sys.stderr)
        return 1
    short = lambda s: (s or "?")[:12]          # noqa: E731
    built = cfg.get("built_sha") or ""
    tip = out.get("tip") or ""
    print(_paint(st, "omlx-dev", "1;33"), file=st)
    rows = [
        ("upstream", f"{out.get('sync_ref')} at {short(out.get('base'))}"
         + (f" (pinned to {short(cfg.get('base_pin'))})"
            if cfg.get("base_pin") else "")),
        ("behind", f"{out.get('behind')} upstream commit(s) not in the build "
         "branch yet" if out.get("behind") else "0 - branch is on the "
         "current upstream base"),
        ("patches", f"{out.get('ahead')} on the build branch"),
        ("build", (f"current ({active})" if built and built == tip
                   else f"needs a rebuild - branch tip {short(tip)}, last "
                        f"build {short(built) or 'none'}")),
        ("server", f"port {cfg.get('port') or 8001}"),
    ]
    for k, v in rows:
        print(f"  {k:<9} {v}", file=st)
        if k == "patches":
            for c in out.get("patch_commits") or []:
                print("            " + _paint(st, "v%-3s" % c.get("v"), "90")
                      + f" {c.get('id')}", file=st)
    drift = out.get("drift") or {}
    if drift.get("drift"):
        print(_paint(st, "  DRIFT", "1;31") + "  the build branch holds "
              "changes no stored patch explains:", file=st)
        for key in ("hand", "missing", "changed", "stale_patches"):
            for item in drift.get(key) or []:
                print(f"           {key}: {item}", file=st)
        _note(st, "a rebuild re-cuts the branch: omlx-uplift dev install",
              indent=11)
    if built != tip or out.get("behind"):
        print(_paint(st, "next: omlx-uplift dev upgrade --restart", "90"),
              file=st)
    return 0
