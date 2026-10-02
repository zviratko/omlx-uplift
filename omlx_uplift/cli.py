"""omlx-uplift - Uplift dashboard, metrics and patch carrier for oMLX.

Slim help: `omlx-uplift help [COMMAND]` (or --help). Full documentation:
`omlx-uplift man` - install steps, config files, the patch state machine,
omlx-dev build-scope patches and the brew-upgrade workflow.
"""


from __future__ import annotations

import argparse
import os
import site
import subprocess
import sys
from pathlib import Path

# BE-1: keg/brew plumbing moved to brewutil (the dev-build engine needs it
# too and devsrc must not import cli). These aliases keep the public-ish
# names the CLI and its tests already use.
from . import brewutil as _brewutil

PTH_NAME = _brewutil.PTH_NAME
_resolve_site_packages = _brewutil.resolve_site_packages
_brew_formula_python = _brewutil.brew_formula_python
_brew_omlx_python = _brewutil.brew_omlx_python
_pth_content = _brewutil.pth_content
_default_target_python = _brewutil.default_target_python
_mount_into_dev_keg = _brewutil.mount_into_dev_keg
_receipt_used_options = _brewutil.receipt_used_options
_brew_build_cmd = _brewutil.brew_build_cmd
_formula_keg_exists = _brewutil.formula_keg_exists



# ------------------------------------------------------------- patch preview
def _color_enabled(stream) -> bool:
    return (getattr(stream, "isatty", lambda: False)()
            and not os.environ.get("NO_COLOR"))


def _paint(stream, text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _color_enabled(stream) else text


def patch_preview(store, tree_root: str, keg: str | None) -> list[dict]:
    """Dry-run every ENABLED patch against the live tree (no writes).

    Returns [{id, verdict: success|warning|failure|applied|reversed,
              detail, reversal}] in manifest order:
      success   hunks apply cleanly (will land on next server start)
      applied   uplift already applied it to this keg and hashes match
      warning   hunks already present on disk, strictly reversible —
                upstream most likely picked the fix up
      failure   strict apply fails (drift or corrupt diff); next boot will
                mark needs_review and boot unpatched for this patch
      reversed  a REVERSAL patch: its un-apply verifies (cleanly, verified
                on this keg, or already reverted) — next boot reverts the
                merged change
    Reversal patches never take the success/applied/warning labels; their
    non-failure verdict is always 'reversed'. Never raises: classification
    errors surface as verdict=failure.
    """
    from . import diffapply
    from . import patches as _patches_mod

    out: list[dict] = []
    try:
        manifest = store.load()
    except Exception as exc:                       # unreadable manifest
        return [{"id": "(manifest)", "verdict": "failure",
                 "detail": f"cannot read patch manifest: {exc}",
                 "reversal": False}]
    for patch in sorted(manifest.get("patches", []),
                        key=lambda p: (p.get("order", 100), p.get("id", ""))):
        pid = patch.get("id", "?")
        if not patch.get("enabled"):
            continue
        if not _patches_mod.scope_touches_keg(
                _patches_mod.patch_scope(patch)):
            continue  # dev-scope: never applied to a keg (DEV-1)
        rev = bool(patch.get("reversal"))
        ver = store.get_version(patch, patch.get("desired_version"))
        if ver is None:
            out.append({"id": pid, "verdict": "failure",
                        "detail": "no stored desired version",
                        "reversal": rev})
            continue
        # Fast happy path: applied on THIS keg and recorded files still have
        # the applied bytes -> nothing to do, verified.
        applied = ver.get("applied") or {}
        if (patch.get("state") == "applied" and applied.get("keg_id") == keg):
            try:
                from . import patchsync
                if patchsync._files_match(tree_root, applied.get("files", [])):
                    out.append({"id": pid,
                                "verdict": "reversed" if rev else "applied",
                                "detail": ("already reverted on this keg — "
                                           "verified" if rev else
                                           "already applied to this keg — "
                                           "verified"),
                                "reversal": rev})
                    continue
            except Exception:
                pass
        pf = ver.get("patch_file")
        data = None
        if pf:
            path = pf if os.path.isabs(pf) else os.path.join(store.base_dir, pf)
            try:
                with open(path, "rb") as fh:
                    data = fh.read()
            except OSError:
                data = None
        if data is None:
            out.append({"id": pid, "verdict": "failure",
                        "detail": "stored diff file missing",
                        "reversal": rev})
            continue
        try:
            chk = diffapply.check_diff(data, tree_root, reverse=rev)
        except Exception as exc:
            out.append({"id": pid, "verdict": "failure",
                        "detail": f"check crashed: {exc}",
                        "reversal": rev})
            continue
        files = chk.get("files", [])
        fails = [f for f in files if f["status"] == "fail"]
        alrdy = [f for f in files if f["status"] == "already"]
        if fails:
            why = "; ".join(f"{f['path']}: {f['reason']}" for f in fails[:2])
            out.append({"id": pid, "verdict": "failure",
                        "detail": (f"will NOT reverse (needs_review next "
                                   f"boot) — {why}" if rev else
                                   f"will NOT apply (needs_review next "
                                   f"boot) — {why}"),
                        "reversal": rev})
        elif alrdy:
            out.append({"id": pid,
                        "verdict": "reversed" if rev else "warning",
                        "detail": ("tree is already at the reverted state — "
                                   "nothing left to undo" if rev else
                                   "already applied and reverts cleanly — "
                                   "upstream likely picked it up"),
                        "reversal": rev})
        else:
            out.append({"id": pid,
                        "verdict": "reversed" if rev else "success",
                        "detail": ("reverts the merged change on next "
                                   "server start" if rev else
                                   "applies cleanly on next server start"),
                        "reversal": rev})
    return out


def print_patch_preview(store, stream=None) -> None:
    """Visible banner after `install`. Advisory only — never fails install."""
    import sys
    stream = stream or sys.stdout
    try:
        from . import patches as _patches
        root = _patches._omlx_root()
        if not root:
            print("OMLX-UPLIFT PATCHES: omlx package tree not found — "
                  "preview skipped", file=stream)
            return
        tree_root = os.path.dirname(root)
        store = store or _patches.PatchStore()
        if store.patches_disabled():
            print(_paint(stream, "OMLX-UPLIFT PATCHES: DISABLED (kill-switch "
                         "sentinel present) — boot will be unpatched", "33"),
                  file=stream)
            return
        keg = _patches.keg_id(root)
        rows = patch_preview(store, tree_root, keg)
        if not rows:
            return
        ids = ", ".join(r["id"] for r in rows)
        print(f"\n{_paint(stream, 'OMLX-UPLIFT PATCHES TO APPLY: ', '1;36')}"
              f"{ids}", file=stream)
        style = {"success": ("SUCCESS", "32"), "warning": ("WARNING", "33"),
                 "failure": ("FAILURE", "31"), "applied": ("APPLIED", "32"),
                 "reversed": ("REVERSED", "31")}
        for r in rows:
            word, code = style[r["verdict"]]
            print(f"  {_paint(stream, f'{word:8}', code)} {r['id']}"
                  f" — {r['detail']}", file=stream)
        # honest roll-up: forward vs reversal vs failed, counted from rows.
        # 'warning' (hunks already upstream) lands as a no-op APPLIED at
        # boot, so it counts as forward — it did not fail.
        n_fwd = sum(1 for r in rows
                    if r["verdict"] in ("success", "applied", "warning"))
        n_rev = sum(1 for r in rows if r["verdict"] == "reversed")
        n_fail = sum(1 for r in rows if r["verdict"] == "failure")
        summary = (f"SUMMARY: {n_fwd} forward, {n_rev} reversed, "
                   f"{n_fail} failed")
        print(_paint(stream, summary, "31" if n_fail else "1;36"),
              file=stream)
    except Exception as exc:                        # preview must never break install
        print(f"OMLX-UPLIFT PATCHES: preview unavailable ({exc})", file=stream)


def _example_skins_dir() -> Path:
    """Deprecated alias kept for 3rd-party callers/tests; the package crate
    dir is the single source of bundled skins (see skins.bundled_package_dir)."""
    return Path(__file__).resolve().parent / "skins-example"


# Bundled skins are NO LONGER copied into ~/.omlx/uplift/skins by install.
# The crates stay in the keg; the server unpacks working copies into
# ~/.omlx{,-dev}/uplift/skins/ at startup (skins.sync_bundled) and prunes
# the ones its update superseded. install_example_skins below is a no-op
# shim so an old call site (or script) does not break.


def install_example_skins(stream=None, force: str = "ask") -> None:
    """Deprecated no-op (2026-09-25 skins rework)."""
    out = stream or sys.stdout
    print("bundled skins: no longer installed as .yml — unpacked by the "
          "server at startup (see omlx-uplift skin / ~/.omlx/uplift/skins)",
          file=out)


def _verify_mount(python: str) -> tuple[bool, str]:
    """Import omlx.server in a throwaway subprocess and check the mount
    flag autopatch/register sets. The 404-after-upgrade reports all came
    from a server whose mount never happened; this turns 'install printed
    success' into 'mount actually works' (or names the failure)."""
    import subprocess

    code = ("import omlx.server as s; "
            "raise SystemExit(0 if getattr(s.app, '_omlx_uplift_mounted', False) else 1)")
    try:
        r = subprocess.run([python, "-c", code], capture_output=True,
                           text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"probe failed: {exc}"
    if r.returncode == 0:
        return True, ""
    tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
    return False, " / ".join(tail)


def cmd_install(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="omlx-uplift install")
    ap.add_argument("--python", help="target interpreter "
                    "(default: Homebrew oMLX keg if present, else this one)")
    ap.add_argument("--yes", action="store_true",
                    help="deprecated no-op (bundled skins are unpacked by "
                    "the server at startup, not installed as .yml)")
    ap.add_argument("--keep-skins", action="store_true",
                    help="deprecated no-op (see --yes)")
    ap.add_argument("--formula", help="target a Homebrew formula's keg "
                    "instead of omlx (e.g. omlx-dev); ignored with --python")
    args = ap.parse_args(argv)
    target = args.python or _default_target_python(args.formula)
    sp = _resolve_site_packages(target)
    pth = sp / PTH_NAME
    body = _pth_content(Path(target) if target else None)
    pth.write_text(body)
    print(f"installed autopatch: {pth}")
    if "\nimport " in "\n" + body and body.count("\n") > 1:
        print("  (bootstraps sys.path to this package — keg holds no copy)")
    # DEV-9: an omlx-dev keg is a SEPARATE keg — a `brew reinstall/upgrade
    # omlx-dev` wipes its site-packages and the plain install would leave
    # dev unmounted until `dev install` runs. Hook it here too,
    # idempotently, whenever it exists (no-op when there is no dev keg).
    # Skipped when --python/--formula explicitly names another target.
    if not args.python and not args.formula:
        if _mount_into_dev_keg():
            print("installed autopatch: omlx-dev keg (DEV-9 co-mount)")
    # mount proof: the .pth alone proves nothing — probe the target env the
    # same way the server will boot (import omlx.server, check the flag).
    ok, detail = _verify_mount(target or sys.executable)
    if ok:
        print("mount check: OK (omlx.server imports with Uplift mounted)")
    else:
        print("WARNING: mount check FAILED — /uplift/ will 404 until this "
              f"is fixed:\n  {detail}", file=sys.stderr)
        return 1
    print_patch_preview(None)
    return 0


def cmd_uninstall(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="omlx-uplift uninstall")
    ap.add_argument("--python", help="target interpreter "
                    "(default: Homebrew oMLX keg if present, else this one)")
    args = ap.parse_args(argv)
    target = args.python or _default_target_python()
    pth = _resolve_site_packages(target) / PTH_NAME
    if pth.exists():
        pth.unlink()
        print(f"removed {pth}")
    else:
        print("nothing to remove")
    return 0


def cmd_serve(argv=None) -> int:
    """Delegate everything to omlx.cli — same args, same startup order,
    same settings resolution (drift-proof by construction)."""
    sys.argv = ["omlx", "serve", *(argv if argv is not None else sys.argv[1:])]
    import omlx.cli as cli

    orig_serve = cli.serve_command

    def serve_with_uplift(args):
        # Fallback mount for environments without the .pth: omlx imports
        # its server lazily, so wrapping serve_command pre-import is the
        # one seam guaranteed to run before uvicorn.Config is built.
        # register() itself starts the collector via the app lifespan.
        import omlx.server as server  # noqa: F401 (import is the point)

        from . import register

        register(server.app)
        return orig_serve(args)

    cli.serve_command = serve_with_uplift
    return cli.main()


def cmd_view(argv=None) -> int:
    import uvicorn

    ap = argparse.ArgumentParser(
        prog="omlx-uplift view",
        description="standalone Uplift viewer (for DMG/remote oMLX over HTTP)",
    )
    ap.add_argument("--api", default="", help="oMLX base URL, e.g. http://host:8000")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=11436)
    args = ap.parse_args(argv)

    from .viewer import build_viewer_app

    app = build_viewer_app(api_base=args.api)
    print(f"Uplift viewer: http://{args.host}:{args.port}/uplift/")
    if args.api:
        print(f"       upstream API: {args.api}")
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


def cmd_patches(argv=None) -> int:
    """Out-of-band patch recovery (PAT-3). Subcommands:
      status       manifest + verification view (JSON)
      apply        reconcile now against the live keg (no re-exec)
      check        re-fetch sources, report drift (JSON)
      disable-all  kill switch on (sentinel) + disable every patch
      add          fetch -> gate -> store a patch (id + --pr/--url/--file)
      enable|disable|remove   per-patch control (same paths as the dashboard)
    Also: --enable-sentinel-off removes the sentinel after manual fixes.
    Command name: 'omlx-uplift patch' (singular); legacy 'patches' still
    dispatches here for compatibility."""
    import json as _json

    ap = argparse.ArgumentParser(prog="omlx-uplift patch")
    ap.add_argument("action", choices=["status", "apply", "check",
                                       "disable-all", "add",
                                       "enable", "disable", "remove",
                                       "curated", "adopt"])
    ap.add_argument("id", nargs="?",
                    help="patch id (add/enable/disable/remove)")
    ap.add_argument("--sync", action="store_true",
                    help="curated: install the catalog (default tier gets "
                         "enabled); without the flag only preview")
    ap.add_argument("--approve", choices=["once", "always"],
                    help="accept the desired version's safeguard codes so "
                         "auto-apply is allowed (enable)")
    ap.add_argument("--pr", help="GitHub PR as repo/N, e.g. jundot/omlx/123")
    ap.add_argument("--url", help="plain URL of a diff file")
    ap.add_argument("--file", help="local diff file (upload kind)")
    ap.add_argument("--scope", choices=["omlx", "dev", "both",
                                        "runtime", "build"],
                    help="patch scope (DEV-6). omlx: pruned overlay on the "
                         "vanilla keg only. dev: materialized on the "
                         "uplift-dev branch only (full diff, incl. tests), "
                         "gated against a source checkout (--build-root or "
                         "the dev-src clone). both: uplift-dev gets the "
                         "full diff AND the vanilla keg the pruned overlay. "
                         "Omit to auto-classify (a PR with build-only "
                         "sections suggests 'both'). 'runtime'/'build' are "
                         "legacy aliases of omlx/dev.")
    ap.add_argument("--build-root", help="source checkout used to gate "
                                         "scope=dev/both (default: ~/.omlx/"
                                         "uplift/dev-src when present)")
    args = ap.parse_args(argv)

    from . import patchsource, patches as _patches, patchsync

    store = _patches.PatchStore()
    root = _patches._omlx_root()
    if not root:
        print("omlx package tree not found — is omlx installed for this python?",
              file=sys.stderr)
        return 2
    tree_root = os.path.dirname(root)

    if args.action == "add":
        import re as _re

        if not args.id:
            ap.error("add needs a patch id")
        if sum(bool(x) for x in (args.pr, args.url, args.file)) != 1:
            ap.error("add needs exactly one of --pr repo/N, --url, --file")
        source = {"kind": "url"}
        if args.pr:
            m = _re.fullmatch(r"([\w.-]+/[\w.-]+)/?(\d+)", args.pr.strip())
            if not m:
                ap.error("--pr must be repo/N")
            source = {"kind": "github_pr", "repo": m.group(1),
                      "pr": int(m.group(2))}
        elif args.url:
            source = {"kind": "url", "url": args.url}
        elif args.file:
            with open(args.file, "rb") as fh:
                source = {"kind": "upload", "data": fh.read()}
        build_root = args.build_root or patchsource.dev_build_root()
        out = patchsource.add_patch(store, args.id, source, tree_root,
                                    scope=args.scope, build_root=build_root)
        if not out.get("ok") and out.get("stage") == "classification":
            print(_json.dumps(out, indent=2))
            print("hint: re-run with --scope both (recommended: full diff "
                  "to uplift-dev + pruned overlay on the keg) or --scope "
                  "dev (dev-src only)", file=sys.stderr)
            return 3
        print(_json.dumps(out, indent=2))
        return 0 if out.get("ok") else 1

    if args.action == "curated":
        from . import curated
        if args.sync:
            out = curated.sync(store, tree_root,
                               build_root=patchsource.dev_build_root())
        else:
            out = curated.list_remote()
            manifest = store.load()
            for tier in out["tiers"].values():
                for e in tier:
                    p = (curated.find_by_source(manifest, e.get("source"))
                         or store.find(manifest, e["id"]))
                    e["installed"] = p is not None
                    if p is not None:
                        e["under_id"] = p["id"]
                        e["adopted"] = bool(p.get("curated_adopted"))
        print(_json.dumps(out, indent=2))
        return 0 if out.get("ok") else 1

    if args.action == "adopt":
        from . import curated
        if not args.id:
            ap.error("adopt needs a patch id")
        out = curated.adopt(store, args.id)
        print(_json.dumps(out, indent=2))
        return 0 if out.get("ok") else 1

    if args.action in ("enable", "disable", "remove"):
        if not args.id:
            ap.error(f"{args.action} needs a patch id")
        if args.action == "remove":
            out = patchsource.remove_patch(store, args.id, tree_root)
        else:
            out = patchsource.set_enabled(store, args.id,
                                          args.action == "enable",
                                          approve=args.approve)
        print(_json.dumps(out, indent=2))
        return 0 if out.get("ok") else 1

    if args.action == "status":
        out = patchsource.view(store, tree_root, _patches.keg_id(root))
        # DEV-6: show ALL patches by default; --scope filters
        if args.scope:
            want = _patches._LEGACY_SCOPE_NAMES.get(args.scope, args.scope)
            out["patches"] = [p for p in out["patches"] if p["scope"] == want]
    elif args.action == "apply":
        out = patchsync.reconcile(store, tree_root, allow_reexec=False)
        out["kill_switch_active"] = store.patches_disabled()
    elif args.action == "check":
        out = patchsource.check_all(store, tree_root)
    else:  # disable-all
        manifest = store.load()
        for patch in manifest.get("patches", []):
            patch["enabled"] = False
            store.set_state_if(patch, "disabled", "disabled by CLI")
        store.save(manifest)
        with open(store.sentinel_path, "w") as fh:
            fh.write("disabled via omlx-uplift patch disable-all\n")
        out = {"ok": True, "sentinel": store.sentinel_path}
    print(_json.dumps(out, indent=2))
    return 0 if out.get("ok", True) else 1


def _dev11_disable_auto_update(via: str) -> bool:
    """DEV-11 invariant: any rollback/pin returns the dev keg to manual
    mode. Writes auto_update=False into dev.json; True when the flag was
    there and got flipped, False when absent/no config (idempotent)."""
    from . import devsrc

    cfg = devsrc.load_config()
    if not cfg or not cfg.get("auto_update"):
        return False
    cfg["auto_update"] = False
    devsrc.save_config(cfg)
    print(f"auto-update (TRACK HEAD) turned OFF ({via})", file=sys.stderr)
    return True


def cmd_dev(argv=None) -> int:
    """omlx-dev management (DEV queue). Subcommands:
      bootstrap   questionnaire + dev-src clone + dev.json + uplift-dev branch
      status      dev-src state as JSON (branch/tip/drift)
      install     materialize build patches + brew install/reinstall (DEV-3)
      reconfigure port/base-path/sharing (DEV-4)
      ('upgrade' is accepted as a legacy alias of 'install')"""
    import json as _json

    ap = argparse.ArgumentParser(prog="omlx-uplift dev")
    ap.add_argument("action", choices=["bootstrap", "install", "status",
                                       "reconfigure", "upgrade", "patches",
                                       "kegs", "stash-keg", "use", "prune",
                                       "rollback", "auto-build"])
    ap.add_argument("name", nargs="?",
                    help="keg name or sha prefix for 'use' (U19)")
    ap.add_argument("--keep", type=int, default=3,
                    help="prune: stashes to keep (default 3)")
    ap.add_argument("--force", action="store_true",
                    help="use: activate even with a live dev server / "
                         "unverified shebang")
    ap.add_argument("--scope", choices=["omlx", "dev", "both",
                                        "runtime", "build"],
                    help="scope filter for 'dev patches' (DEV-6; default: "
                         "dev+both)")
    ap.add_argument("--yes", action="store_true",
                    help="take questionnaire defaults (scripted use)")
    ap.add_argument("--src", help="existing omlx checkout to detect origin "
                                  "from (bootstrap)")
    ap.add_argument("--origin", help="dev-src origin URL (bootstrap, skips Q&A)")
    ap.add_argument("--sync-ref", help="sync ref to track, e.g. origin/main")
    ap.add_argument("--fetch", action="store_true",
                    help="status: fetch the sync ref first")
    ap.add_argument("--with-custom-kernel", action="store_true",
                    help="install: build custom kernels (default: inherit "
                         "from the existing omlx-dev/omlx receipt)")
    ap.add_argument("--with-grammar", action="store_true",
                    help="install: install xgrammar (default: inherit)")
    ap.add_argument("--dry-run", action="store_true",
                    help="install: materialize check + print the brew "
                         "command, build nothing")
    ap.add_argument("--port", type=int,
                    help="reconfigure: dev server port (default 8001)")
    ap.add_argument("--base-path", help="reconfigure: dev data root "
                    "(default ~/.omlx-dev)")
    ap.add_argument("--share", action="append", default=[],
                    help="reconfigure: share with vanilla ~/.omlx "
                         "(repeatable or comma-list): models, "
                         "model_settings, model_profiles")
    ap.add_argument("--no-share", action="append", default=[],
                    help="reconfigure: keep private (repeatable or "
                         "comma-list)")
    ap.add_argument("--interactive", action="store_true",
                    help="reconfigure: ask the sharing questionnaire")
    args = ap.parse_args(argv)

    from . import devsrc, patchsource

    if args.action == "bootstrap":
        existing = devsrc.load_config()
        if existing and os.path.isdir(
                os.path.join(devsrc.src_path(existing), ".git")):
            print("dev-src is already bootstrapped — see: omlx-uplift dev "
                  "status", file=sys.stderr)
            return 1
        print("Bootstrapping omlx-dev (the build-patch companion install).\n")
        cfg = devsrc.install_config(src_hint=args.src, yes=args.yes,
                                    origin=args.origin,
                                    sync_ref=args.sync_ref)
        path = devsrc.ensure_clone(cfg)
        print(f"[1/3] dev-src clone: {path}")
        # the formula branch must exist BEFORE any brew build (bare
        # `brew install omlx-dev` clones it by name — a missing branch is a
        # git-128 wall for people who skipped the CLI). Empty branch at the
        # sync tip: zero patch commits until dev install materializes them.
        try:
            devsrc.fetch_sync_ref(cfg)
            seeded = devsrc.ensure_formula_branch(cfg)
        except devsrc.DevsrcError as exc:
            print(f"[2/3] WARNING: could not seed the "
                  f"{cfg.get('formula_branch') or devsrc.DEV_BRANCH_DEFAULT}"
                  f" branch: {exc}", file=sys.stderr)
            seeded = None
        branch = cfg.get("formula_branch") or devsrc.DEV_BRANCH_DEFAULT
        if seeded:
            print(f"[2/3] formula branch {branch} created at "
                  f"{cfg['sync_ref']} ({seeded[:12]})")
        print(f"[3/3] config: {devsrc.dev_json_path()}")
        # port is a user choice, not a constant: ask during the bootstrap
        # questionnaire (dev often REPLACES vanilla and wants its port —
        # the service block injects OMLX_PORT, which overrides whatever
        # port the copied settings.json says). --yes keeps 8001.
        if not args.yes and args.port is None and sys.stdin.isatty():
            vp = devsrc.vanilla_port()
            ans = input(f"Dev server port "
                        f"[{devsrc.RUNTIME_DEFAULTS['port']}] "
                        f"(vanilla omlx uses {vp}): ").strip()
            if ans:
                args.port = int(ans) if ans.isdigit() else None
                if args.port is None:
                    print(f"not a number — keeping default "
                          f"{devsrc.RUNTIME_DEFAULTS['port']}")
        # DEV-4 work item 3: runtime/sharing questionnaire lives in
        # reconfigure (one code path); bootstrap runs it as a quiet
        # sub-step (sharing questionnaire + warnings, no duplicate JSON)
        rc = cmd_dev_reconfigure(args, cfg=cfg, quiet=True)
        if rc not in (0,):
            return rc
        _dev_next_steps(cfg, fresh=True)
        return 0

    if args.action in ("install", "upgrade"):
        # 'upgrade' stays accepted as a legacy alias — no note, the single
        # install path installs the first build too
        return cmd_dev_install(args)

    if args.action == "reconfigure":
        return cmd_dev_reconfigure(args)

    if args.action == "patches":
        # DEV-6: the dev view of the SAME manifest — dev/both by default
        # (--scope narrows)
        from . import patches as _patches_mod, patchsource as _ps
        store = _patches_store()
        root = _patches_mod._omlx_root()
        tree_root = os.path.dirname(root) if root else os.getcwd()
        out = _ps.view(store, tree_root, None)
        want = getattr(args, "scope", None)
        want = _patches_mod._LEGACY_SCOPE_NAMES.get(want, want)
        if want:
            out["patches"] = [p for p in out["patches"] if p["scope"] == want]
        else:
            out["patches"] = [p for p in out["patches"]
                              if _patches_mod.scope_touches_dev(p["scope"])]
        print(_json.dumps(out, indent=2))
        return 0

    if args.action in ("kegs", "stash-keg", "use", "prune"):
        # U19 — binary rollback: stash/switch previous omlx-dev builds
        from . import kegstash

        if args.action == "stash-keg":
            try:
                r = kegstash.stash()
            except FileNotFoundError as exc:
                print(str(exc), file=sys.stderr)
                return 1
            print(f"stashed {r['name']} -> {r['path']} ({r['method']})")
            return 0
        if args.action == "kegs":
            rows = kegstash.list_stashes()
            act = kegstash.active_keg()
            if not rows:
                print("no stashed kegs — a stash is taken automatically on "
                      "'dev install' (or run: omlx-uplift dev stash-keg)")
                return 0
            for m in rows:
                size = m.get("bytes") or 0
                mark = "  <- active" if m.get("name") == act else ""
                print(f"{m.get('name')}  {m.get('stashed_at', '?')}  "
                      f"{size / 2**30:.1f} GiB  {m.get('method', '?')}{mark}")
            return 0
        if args.action == "prune":
            removed = kegstash.prune(keep=args.keep)
            print("removed: " + (", ".join(removed) if removed else "nothing")
                  + f" (kept newest {args.keep})")
            return 0
        # use
        if not args.name:
            print("usage: omlx-uplift dev use <sha|HEAD-sha>",
                  file=sys.stderr)
            return 2
        try:
            r = kegstash.activate(args.name, force=args.force)
        except (FileNotFoundError, RuntimeError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        # DEV-11 invariant: switching to a specific (possibly older) keg is
        # going back to manual — auto-update must not undo it on next boot.
        _dev11_disable_auto_update("dev use")
        pth_msg = ("yes" if r["pth"] else
                   "NO — run: omlx-uplift install --formula omlx-dev")
        print(f"active keg -> {r['name']} ({r['cellar']})\n"
              f"uplift .pth remounted: {pth_msg}\n"
              "load it with: brew services restart omlx-dev")
        return 0

    if args.action == "rollback":
        # DEV-11 add-on: one-command "back to manual" — most recent stashed
        # keg + flag OFF. Restore itself is pure kegstash.activate (existing
        # machinery), so the budget gate in the ticket is met.
        from . import kegstash

        rows = kegstash.list_stashes()
        act = kegstash.active_keg()
        rows = [m for m in rows if m.get("name") != act]
        if not rows:
            print("nothing to roll back to — no stashed keg other than the "
                  "active one (see: omlx-uplift dev kegs)", file=sys.stderr)
            return 1
        target = rows[0]
        try:
            r = kegstash.activate(target["name"], force=args.force)
        except (FileNotFoundError, RuntimeError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        off = _dev11_disable_auto_update("dev rollback")
        # Ticket step 2: base goes back to tracking HEAD (un-pin). Safe
        # because auto_update is OFF now — and the boot hook independently
        # refuses to auto-build anything but an un-pinned HEAD anyway.
        try:
            from . import devsrc

            dcfg = devsrc.load_config()
            if dcfg and dcfg.pop("base_pin", None) is not None:
                devsrc.save_config(dcfg)
                print("base pin cleared — tracking HEAD again (manual)",
                      file=sys.stderr)
        except Exception as exc:  # rollback itself succeeded — stay advisory
            # LOG-SILENT-1: used to pass silently, so a stale base_pin hid
            # inside a 'successful' rollback and the next boot refused to
            # auto-build with no paper trail.
            print(f"WARNING: base pin NOT cleared ({exc}) — run: "
                  "omlx-uplift dev auto-build off/on or edit dev.json",
                  file=sys.stderr)
        pth_msg = ("yes" if r["pth"] else
                   "NO — run: omlx-uplift install --formula omlx-dev")
        print(f"rolled back to {r['name']} ({r['cellar']})\n"
              f"auto-update flag: {'OFF' if off else 'unchanged (no dev.json)'}\n"
              f"uplift .pth remounted: {pth_msg}\n"
              "load it with: brew services restart omlx-dev")
        return 0

    if args.action == "auto-build":
        # DEV-11: the boot hook's detached worker. Same pipeline as the
        # manual build (KISS: one rebuild path, DEV-context decision 3),
        # then restart the service so the new keg actually loads. Output
        # goes to the dev-side log; nobody watches this process.
        import types

        rc = cmd_dev_install(types.SimpleNamespace(
            with_custom_kernel=False, with_grammar=False, dry_run=False))
        if rc == 0:
            subprocess.run(["brew", "services", "restart", "omlx-dev"])
        return rc

    if args.action == "status":
        cfg = devsrc.load_config()
        if not cfg:
            print(_json.dumps({"installed": False,
                               "reason": "dev.json missing — run "
                                         "omlx-uplift dev bootstrap"}, indent=2))
            return 1
        if args.fetch:
            try:
                devsrc.fetch_sync_ref(cfg)
            except devsrc.DevsrcError as exc:
                print(f"fetch failed: {exc}", file=sys.stderr)
        out = devsrc.status(cfg, patchsource.enabled_build_patches(
            _patches_store()))
        print(_json.dumps(out, indent=2))
        return 0

    print(f"dev {args.action} lands with the later DEV ticket",
          file=sys.stderr)
    return 2


def _patches_store():
    from . import patches as _patches

    return _patches.PatchStore()


def _service_state(formula: str) -> str:
    """brew services state for a formula ('started', 'stopped', ... or '').
    NOTE: this brew's `services list` takes NO name argument — parse the
    full table."""
    try:
        out = subprocess.run(["brew", "services", "list"],
                             capture_output=True, text=True,
                             timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[0] == formula:
            return parts[1] if len(parts) > 1 else ""
    return ""


def _coexistence_warnings() -> None:
    """DEV-context decision 7: if the vanilla omlx service runs, print the
    switch commands and the both-running warning; warn on a dev/vanilla
    port clash from ~/.omlx/settings.json."""
    state = _service_state("omlx")
    if state in ("started", "running"):
        print("WARNING: the vanilla omlx service is running. Running omlx "
              "AND omlx-dev at once is usually unwanted (shared mutable "
              "state). To switch over:\n"
              "  brew services stop omlx\n"
              "  brew services start omlx-dev", file=sys.stderr)
    # port clash: dev port vs vanilla settings.json port
    from . import devsrc

    cfg = devsrc.load_config() or {}
    dev_port = cfg.get("port", 8001)
    try:
        import json

        with open(os.path.expanduser("~/.omlx/settings.json")) as fh:
            vanilla_port = json.load(fh).get("port", 8000)
    except (OSError, ValueError):
        vanilla_port = 8000
    if int(dev_port) == int(vanilla_port):
        print(f"WARNING: dev port {dev_port} equals the vanilla omlx port — "
              "the two servers would fight. Change it: omlx-uplift dev "
              "reconfigure", file=sys.stderr)


def _share_answers(args, cfg: dict, devsrc) -> dict:
    """Share map from --share/--no-share flags, an interactive
    questionnaire, or the config defaults (DEV-context 6 copy)."""
    share = devsrc.share_map(cfg)
    names = list(devsrc.SHARE_DEFAULTS)

    def _collect(values):
        out = set()
        for v in values or []:
            out.update(x.strip() for x in v.split(",") if x.strip())
        return out

    on = _collect(getattr(args, "share", None))
    off = _collect(getattr(args, "no_share", None))
    unknown = (on | off) - set(names)
    for name in sorted(unknown):
        print(f"WARNING: unknown share knob {name!r} (choose from: "
              f"{', '.join(names)})", file=sys.stderr)
    if getattr(args, "interactive", False):
        print("What should omlx-dev SHARE with the vanilla ~/.omlx? "
              "(shared = symlink, live state stays single; private = a "
              "copy seeded once, dev server drifts)")
        for name in names:
            rec = "Y" if devsrc.SHARE_DEFAULTS[name] else "n"
            if name == "models":
                hint = ("recommended yes — big, mostly immutable")
            elif name == "settings":
                hint = ("yes if dev REPLACES vanilla (copies auth/api keys; "
                        "the dev port comes from dev.json, not this file); "
                        "no if BOTH servers will run (admin saves clobber)")
            else:
                hint = ("recommended no while BOTH servers run — mutable, "
                        "concurrent writes race")
            ans = input(f"  share {name}? [{rec}] ({hint}): ").strip().lower()
            share[name] = (ans.startswith("y") if ans
                           else devsrc.SHARE_DEFAULTS[name])
    share.update({n: True for n in on if n in names})
    share.update({n: False for n in off if n in names})
    return {k: bool(share[k]) for k in names}


def cmd_dev_reconfigure(args, cfg: dict | None = None,
                        quiet: bool = False) -> int:
    """DEV-4: port/base-path diversion + sharing map, realized as symlinks
    / seeded copies under the dev base path. The service picks port/base up
    on restart (brew regenerates the launchd plist from the formula block).
    quiet=True keeps only warnings and the share actions (bootstrap calls
    it as a sub-step and prints its own summary)."""
    import json as _json

    from . import devsrc

    if cfg is None:
        cfg = devsrc.load_config()
        if not cfg:
            print("dev.json missing — run: omlx-uplift dev bootstrap",
                  file=sys.stderr)
            return 2

    changed = False
    if getattr(args, "port", None):
        port = int(args.port)
        if not 1 <= port <= 65535:
            print(f"invalid port {port}", file=sys.stderr)
            return 2
        vp = devsrc.vanilla_port()
        if port == vp:
            print(f"WARNING: dev port {port} equals the vanilla omlx port "
                  f"({vp}) — the two servers would fight over it.",
                  file=sys.stderr)
        if port != vp and devsrc.port_in_use(port):
            print(f"port {port} is already in use by something else",
                  file=sys.stderr)
            return 1
        cfg["port"] = port
        changed = True
    if getattr(args, "base_path", None):
        cfg["base_path"] = os.path.expanduser(args.base_path)
        changed = True
    if (getattr(args, "share", None) or getattr(args, "no_share", None)
            or getattr(args, "interactive", False)
            or "share" not in cfg):
        cfg["share"] = _share_answers(args, cfg, devsrc)
        changed = True

    if changed:
        devsrc.save_config(cfg)
        if not quiet:
            print(f"config written: {devsrc.dev_json_path()}")

    actions = devsrc.realize_share(cfg)
    for a in actions:
        line = f"  {a['name']}: {a['action']}"
        if a.get("reason"):
            line += f" — {a['reason']}"
        print(line)

    rt = devsrc.runtime_config(cfg)
    # service restart only when it's actually running (never start it here)
    if _service_state("omlx-dev") in ("started", "running") and changed:
        subprocess.run(["brew", "services", "restart", "omlx-dev"])
        print(f"omlx-dev service restarted (port {rt['port']}, base "
              f"{rt['base_path']})")
    elif changed and not quiet:
        print("NOTE: after the next `brew services start/restart omlx-dev` "
              f"the service runs on port {rt['port']} with base path "
              f"{rt['base_path']} (brew regenerates the launchd plist from "
              "the formula's service block at start time).")
    if not quiet:
        _coexistence_warnings()
        print(_json.dumps({"port": rt["port"], "base_path": rt["base_path"],
                           "share": devsrc.share_map(cfg),
                           "actions": actions}, indent=2))
    return 0


def cmd_dev_install(args) -> int:
    """`omlx-uplift dev install`: thin CLI skin over devsrc.run_dev_build
    (BE-1). The engine is pure data in/out; this function only decides what
    to print — the patch table, the colored header, the next-step hints."""
    from . import devsrc

    def _print(stream, text):
        print(text, file=stream, flush=(stream is sys.stdout and False))

    # streaming printer (BE-1): lines print as the engine emits them,
    # exactly like the old inline prints did. The header+table block —
    # which sat right after a successful materialize — is inserted before
    # the first line that follows materialize (re-gate noise, stash, brew
    # chatter, dry-run); brew's own subprocess output interleaves live.
    state = {"header": False}

    def _header(res):
        print()
        print(_paint(sys.stdout, "OMLX-DEV BUILD", "1;36")
              + f"  {res.sync_ref} @ {(res.base_sha or '')[:12]}  "
              + f"+{res.n_applied} patch commit(s) -> tip {res.tip[:12]}")
        _dev_patch_table(res.materialize.get("commits", []),
                         res.upstreamed or {})

    def _on_line(res, stream, text):
        # trigger lines only ever appear after a SUCCESSFUL materialize,
        # so seeing one is the boundary signal; print the header first.
        if (not state["header"]
                and (text.startswith(("running: ", "dry-run: would run",
                                      "previous keg stashed"))
                     or "RE-GATE FAILED" in text)):
            state["header"] = True
            _header(res)
        print(text, file=sys.stderr if stream == 'err' else sys.stdout,
              flush=True)

    res = devsrc.run_dev_build(
        with_custom_kernel=bool(getattr(args, 'with_custom_kernel', False)),
        with_grammar=bool(getattr(args, 'with_grammar', False)),
        dry_run=bool(getattr(args, 'dry_run', False)),
        warn=_coexistence_warnings, on_line=_on_line)
    # fallback: materialize succeeded but no trigger line came
    if (not state["header"] and res.materialize
            and res.materialize.get("ok")):
        _header(res)
    if res.ok and res.stage == 'ok':
        _dev_next_steps(res.cfg or {}, fresh=False)
        # VERY LAST: the one command that matters now (brew's own 'after an
        # upgrade' caveat is skipped — the build runs with --quiet)
        print("\nTo restart omlx-dev now run:\n"
              "  brew services restart omlx-dev", flush=True)
    return res.returncode


def _dev_patch_table(commits: list[dict], upstreamed: dict) -> None:
    """Coloured per-patch table for `dev install` — one row per ENABLED
    dev/both patch in materialize order, plus every DISABLED dev/both patch
    shown explicitly as DISABLED (silent omission made people hunt for
    patches they had simply switched off). Verdicts stay single uppercase
    words: the dashboard tails this output (RESULT line + build log)."""
    from . import patches as _patches

    out = sys.stdout
    style = {  # verdict -> (word, colour, extra)
        "APPLIED": ("APPLIED", "32", "commit {sha}"),
        "UPSTREAMED": ("UPSTREAMED", "31",
                       "PR merged upstream — no commit, patch no longer "
                       "needed (disabled candidates: re-enable or remove)"),
        "ALREADY PRESENT": ("SKIPPED", "33",
                            "base already contains the hunks — no commit"),
        "DISABLED": ("DISABLED", "35", "not in this build"),
    }
    rows = []
    for c in commits:
        if c.get("sha"):
            key, extra = "APPLIED", style["APPLIED"][2].format(
                sha=c["sha"][:12])
        elif c.get("skipped") == "already-present":
            if c["id"] in upstreamed:
                key, extra = "UPSTREAMED", style["UPSTREAMED"][2]
            else:
                key, extra = "ALREADY PRESENT", style["ALREADY PRESENT"][2]
        else:
            key, extra = "APPLIED", ""   # unreachable today; keeps rows sane
        rows.append((c["id"], key, extra))

    def _disabled_dev_rows():
        try:
            man = _patches_store().load()
        except Exception:                           # noqa: BLE001 — display
            return []
        return [(p.get("id", "?"), "DISABLED", style["DISABLED"][2])
                for p in man.get("patches", [])
                if _patches.scope_touches_dev(_patches.patch_scope(p))
                and not p.get("enabled")]

    rows += _disabled_dev_rows()
    if not rows:
        return
    width = max(len(r[0]) for r in rows)
    for pid, key, extra in rows:
        word, code, _ = style[key]
        line = f"  {_paint(out, f'{word:11}', code)} {pid:<{width}}"
        print(f"{line}  {extra}" if extra else line, file=out)


def _dev_next_steps(cfg: dict, fresh: bool) -> None:
    """The ONE command that matters after a build. Bootstrap is already a
    done deal here (install refuses without it), so never mention it; the
    coexistence warning above already printed the switch commands. After a
    rebuild the only next step is the restart hint — printed by the caller
    as the very last output after RESULT."""
    from . import devsrc

    if not fresh:
        return
    rt = devsrc.runtime_config(cfg)
    print("\nNext steps:\n"
          "  build with patches:  omlx-uplift dev install\n"
          "  then start the dev server:  brew services start omlx-dev\n"
          f"  dashboard: http://127.0.0.1:{rt['port']}/uplift/  "
          f"(data root {rt['base_path']})")


def cmd_kernel(argv=None) -> int:
    """Rebuild one bundled native custom kernel IN THE LIVE KEG.

      omlx-uplift kernel rebuild <name> --src /path/to/omlx-checkout
      omlx-uplift kernel list

    A patch that touches kernel code needs this: the keg ships compiled
    artifacts, not csrc/ sources, so --src points at ANY omlx source
    checkout (git clone; the kernel name must exist there). Much cheaper
    than `brew reinstall --HEAD --with-custom-kernel`: one kernel, no
    re-download of the world. Originals are backed up byte-exactly under
    the uplift data dir (kernel-backups/<name>/files/). Restart omlx
    afterwards: launchctl kickstart -k gui/$(id -u)/sh.brew.omlx"""
    import json as _json

    ap = argparse.ArgumentParser(prog="omlx-uplift kernel")
    ap.add_argument("action", choices=["list", "rebuild", "restore"])
    ap.add_argument("kernel", nargs="?", help="kernel name (see list)")
    ap.add_argument("--src", help="omlx source checkout containing the "
                                  "kernel's csrc/ (default: cwd)")
    ap.add_argument("--workdir", help="keep build dir here for debugging")
    args = ap.parse_args(argv)

    from . import kernelbuild

    if args.action == "list":
        print(_json.dumps({"kernels": list(kernelbuild.KERNELS)}, indent=2))
        return 0
    if args.action == "restore":
        if not args.kernel:
            ap.error("restore needs a kernel name")
        res = kernelbuild.restore(args.kernel)
        print(_json.dumps(res, indent=2))
        return 0 if res.get("ok") else 1
    if not args.kernel:
        ap.error("rebuild needs a kernel name (see: omlx-uplift kernel list)")
    try:
        res = kernelbuild.rebuild(args.kernel, src=args.src,
                                  workdir=args.workdir)
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"kernel build failed: {exc}", file=sys.stderr)
        return 1
    print(_json.dumps(res, indent=2))
    return 0 if res.get("verify", {}).get("ok") else 1


def cmd_skin(argv=None) -> int:
    """Skin crate <-> working-dir codecs (design section 8).

      compile <dir> [-o out.yml]   working dir -> canonical crate text
                                   (deterministic; resources byte-identical
                                   through decompile)
      decompile <yml> [-C dir]     crate -> <name>-<mtime>/ in the skins
                                   dir (default: the live uplift skins dir;
                                   never overwrites an existing dir)
    """
    ap = argparse.ArgumentParser(prog="omlx-uplift skin")
    ap.add_argument("action", choices=["compile", "decompile"])
    ap.add_argument("path", help="skin dir (compile) or crate .yml (decompile)")
    ap.add_argument("-o", "--out", default=None,
                    help="output .yml path (compile; default: stdout)")
    ap.add_argument("-C", "--skins-dir", dest="skins_dir", default=None,
                    help="skins root for decompile (default: ~/.omlx/uplift/skins)")
    args = ap.parse_args(argv)

    from pathlib import Path as _P
    from . import skins

    if args.action == "compile":
        try:
            text = skins.compile_dir(_P(args.path))
        except (ValueError, OSError) as exc:
            print(f"skin compile: {exc}", file=sys.stderr)
            return 1
        if args.out:
            _P(args.out).write_text(text, encoding="utf-8")
            print(f"wrote {args.out}")
        else:
            sys.stdout.write(text)
        return 0

    try:
        dir_name = skins.decompile_crate(
            _P(args.path), _P(args.skins_dir) if args.skins_dir else None)
    except (ValueError, OSError) as exc:
        print(f"skin decompile: {exc}", file=sys.stderr)
        return 1
    print(f"extracted {dir_name}")
    return 0


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        # omlx-uplift [help] -> slim command list; `help <cmd>` -> usage
        rest = sys.argv[2:]
        from .help import print_help
        return print_help(rest[0] if rest else None)
    if sys.argv[1] == "man":
        from .help import show_man
        return show_man()
    if sys.argv[1] not in {
            "serve", "view", "install", "uninstall", "patch", "patches",
            "kernel", "skin", "dev"}:
        print(f"omlx-uplift: unknown command {sys.argv[1]!r}\n",
              file=sys.stderr)
        from .help import print_help
        print_help()
        return 1
    cmd = sys.argv[1]
    if cmd == "patches":
        # compatibility alias: the command renamed to singular 'patch'
        # (it always took one id at a time). Same handler, same flags.
        cmd = "patch"
    rest = sys.argv[2:]
    if cmd == "skin":
        # 'omlx-uplift skin compile …' — the action is rest[0], not rest itself
        if not rest or rest[0] not in ("compile", "decompile"):
            print("usage: omlx-uplift skin compile <dir> [-o out.yml]\n"
                  "       omlx-uplift skin decompile <yml> [-C skins-dir]")
            return 1
        return cmd_skin(rest)
    return {"serve": cmd_serve, "view": cmd_view, "install": cmd_install,
            "uninstall": cmd_uninstall, "patch": cmd_patches,
            "kernel": cmd_kernel, "dev": cmd_dev}[cmd](rest)


if __name__ == "__main__":
    sys.exit(main())
