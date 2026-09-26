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

PTH_NAME = "omlx_uplift.pth"


def _resolve_site_packages(python: str | None) -> Path:
    code = (
        "import site,sys; ps=site.getsitepackages()"
        "if hasattr(site,'getsitepackages') and site.getsitepackages() "
        "else [site.getusersitepackages()]; print(ps[0])"
    )
    import subprocess

    if python:
        out = subprocess.run(
            [python, "-c", code], capture_output=True, text=True, check=True
        )
        return Path(out.stdout.strip())
    # current interpreter: prefer the *real* install over user-site
    for p in site.getsitepackages():  # pragma: no cover (env-dependent)
        cand = Path(p)
        if cand.is_dir() and os.access(cand, os.W_OK):
            return cand
    user = Path(site.getusersitepackages())
    user.mkdir(parents=True, exist_ok=True)
    return user


def _brew_formula_python(formula: str) -> Path | None:
    """Path to a Homebrew keg's libexec python for ANY formula (omlx,
    omlx-dev, ...), if brew + the keg exist."""
    import shutil

    brew = shutil.which("brew")
    if not brew:
        return None
    try:
        prefix = subprocess.run(
            [brew, "--prefix", formula], capture_output=True, text=True,
            timeout=15).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):  # pragma: no cover
        return None
    cand = Path(prefix) / "libexec" / "bin" / "python"
    return cand if prefix and cand.is_file() else None


def _brew_omlx_python() -> Path | None:
    """Path to a Homebrew oMLX keg interpreter, if brew + omlx exist."""
    return _brew_formula_python("omlx")


def _pth_content(target: Path | None) -> str:
    """The .pth body: ALWAYS bootstrap sys.path with OUR package parent
    dir, then import autopatch — a .pth line starting with 'import ' is
    executed, any other line is appended to sys.path, so the keg needs
    exactly this ONE file, nothing else. Order matters: path line first.

    Do NOT probe the target for 'import omlx_uplift' to decide whether the
    path line is needed: a working .pth already in the target's
    site-packages makes that probe succeed BY BOOTSTRAPPING ITSELF, so the
    rewrite would drop the path line and break the mount we just proved
    (the run-1 404 / run-2 fixes-it sequence). A duplicated sys.path entry
    is harmless; the conditional was not."""
    lines: list[str] = []
    if target is not None:
        pkg_parent = str(Path(__file__).resolve().parent.parent)
        # brew kegs live under a VERSIONED Cellar dir; point the .pth at
        # the stable opt/ symlink instead so `brew upgrade omlx-uplift`
        # needs no remount.
        if "/Cellar/omlx-uplift/" in pkg_parent:
            base, rest = pkg_parent.split("/Cellar/omlx-uplift/", 1)
            rest = rest.split("/", 1)[1]  # drop the version directory
            pkg_parent = f"{base}/opt/omlx-uplift/{rest}"
        lines.append(pkg_parent)
    lines.append("import omlx_uplift.autopatch")
    return "\n".join(lines) + "\n"


def _default_target_python(formula: str | None = None) -> str | None:
    """No --python given: prefer a Homebrew keg (the common case for tap
    users), else stay in the current interpreter. `formula` selects which
    keg (DEV-3: 'omlx-dev' mounts the dev keg too)."""
    keg = _brew_formula_python(formula or "omlx")
    return str(keg) if keg else None


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
    Also: --enable-sentinel-off removes the sentinel after manual fixes."""
    import json as _json

    ap = argparse.ArgumentParser(prog="omlx-uplift patches")
    ap.add_argument("action", choices=["status", "apply", "check",
                                       "disable-all", "add"])
    ap.add_argument("id", nargs="?", help="patch id (add)")
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
            fh.write("disabled via omlx-uplift patches disable-all\n")
        out = {"ok": True, "sentinel": store.sentinel_path}
    print(_json.dumps(out, indent=2))
    return 0 if out.get("ok", True) else 1


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
                                       "kegs", "stash-keg", "use", "prune"])
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
        if args.action == "upgrade":
            print("note: 'dev upgrade' is now 'dev install' (it installs "
                  "the first build too)", file=sys.stderr)
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
        pth_msg = ("yes" if r["pth"] else
                   "NO — run: omlx-uplift install --formula omlx-dev")
        print(f"active keg -> {r['name']} ({r['cellar']})\n"
              f"uplift .pth remounted: {pth_msg}\n"
              "load it with: brew services restart omlx-dev")
        return 0

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


def _receipt_used_options(formula: str) -> set:
    """used_options from the formula's own INSTALL_RECEIPT.json (empty when
    not installed)."""
    import glob
    import json as _json

    prefix = os.environ.get("HOMEBREW_PREFIX", "/opt/homebrew")
    receipts = sorted(glob.glob(f"{prefix}/Cellar/{formula}/*/INSTALL_RECEIPT.json"))
    if not receipts:
        return set()
    try:
        with open(receipts[-1]) as fh:
            data = _json.load(fh)
    except (OSError, ValueError):
        return set()
    opts = set((data.get("used_options") or []))
    return opts


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
    """The ONLY rebuild path (DEV-context decision 3): re-cut uplift-dev
    from the synced base with one commit per enabled build patch, then
    `brew install` (first build) or `brew reinstall` (rebuild). Both always
    re-stage the branch tip (`brew upgrade` would no-op on a head)."""
    from . import devsrc, patchsource
    from . import patches as _patches

    cfg = devsrc.load_config()
    if not cfg:
        print("omlx-dev is not bootstrapped yet — run: omlx-uplift dev "
              "bootstrap", file=sys.stderr)
        return 2
    path = devsrc.src_path(cfg)
    if not os.path.isdir(os.path.join(path, ".git")):
        print(f"dev-src clone missing ({path}) — run: omlx-uplift dev "
              "bootstrap", file=sys.stderr)
        return 2
    try:
        devsrc.ensure_clone(cfg)          # drift guard before any fetch
        if not devsrc.worktree_clean(path):
            print(f"dev-src worktree is dirty: {path}\nuplift refuses to "
                  "re-cut the branch over local edits — commit or discard "
                  "them first.", file=sys.stderr)
            return 1
        devsrc.fetch_sync_ref(cfg)
    except devsrc.DevsrcError as exc:
        print(f"dev-src: {exc}", file=sys.stderr)
        return 1

    build_patches = patchsource.enabled_build_patches(_patches_store())
    res = devsrc.materialize(build_patches, cfg)
    if not res.get("ok"):
        print(f"materialize FAILED: {res.get('reason')}", file=sys.stderr)
        for c in res.get("commits", []):
            print(f"  applied before failure: {c['id']} v{c.get('v')}",
                  file=sys.stderr)
        print("fix or disable the named patch, then re-run", file=sys.stderr)
        return 1
    tip = res["tip"]
    n = len([c for c in res["commits"] if c.get("sha")])
    print(f"uplift-dev: {cfg['sync_ref']} @ {res['base'][:12]} + "
          f"{n} patch commit(s) -> tip {tip[:12]}")
    # the branch IS the apply step for dev/both scopes — record it so the
    # dashboard stops showing 'pending' forever (reconcile never sees these)
    patchsource.mark_dev_applied(_patches_store(), res["commits"])

    # re-gate BEFORE the rebuild (DEV-context decision 9) — failures mark
    # needs_review per patch, never silently skipped
    regate = _regate_build_patches(build_patches)
    for pid, why in regate.items():
        print(f"re-gate FAILED for build patch {pid}: {why} "
              "(marked needs_review)", file=sys.stderr)

    flags = set()
    if args.with_custom_kernel:
        flags.add("--with-custom-kernel")
    if args.with_grammar:
        flags.add("--with-grammar")
    if not flags:
        # user decision 2026-09-24: preserve custom-kernel + grammar from
        # the user's build — dev receipt first, else the vanilla omlx one
        flags = _receipt_used_options("omlx-dev") or _receipt_used_options("omlx")
    cmd = _brew_build_cmd(flags)
    if args.dry_run:
        print("dry-run: would run: " + " ".join(cmd))
        return 0
    _coexistence_warnings()
    # U19: brew reinstall DESTROYS the outgoing keg — clone it into the
    # stash first so `dev use <old-sha>` stays possible. Best-effort: a
    # failed stash must never block the rebuild.
    try:
        from . import kegstash

        if kegstash.active_keg():
            r = kegstash.stash()
            print(f"previous keg stashed: {r['name']} ({r['method']}) "
                  f"— rollback: omlx-uplift dev use {r['name'][5:12]}")
    except Exception as exc:
        print(f"keg stash skipped: {exc}", file=sys.stderr)
    # install owns the pin (decision 3): brew refuses to reinstall a pinned
    # formula, so lift it for this one rebuild and restore it afterwards —
    # on success AND on failure (the pin must never silently disappear)
    subprocess.run(["brew", "unpin", "omlx-dev"], capture_output=True)
    print("running: " + " ".join(cmd))
    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        subprocess.run(["brew", "pin", "omlx-dev"], capture_output=True)
        print("brew build FAILED — dev keg untouched (pin restored)",
              file=sys.stderr)
        return proc.returncode
    subprocess.run(["brew", "pin", "omlx-dev"], capture_output=True)
    cfg = devsrc.load_config() or cfg
    cfg["built_sha"] = tip
    # wall-clock build completion: the dashboard compares it against the
    # running service's start time to show RESTART NEEDED (DEV-6)
    cfg["built_at"] = _patches.now_iso()
    devsrc.save_config(cfg)
    _mount_into_dev_keg()
    print(f"omlx-dev built from {tip[:12]}; .pth mount refreshed")
    _dev_next_steps(cfg, fresh=False)
    return 0


def _formula_keg_exists(formula: str) -> bool:
    import glob

    prefix = os.environ.get("HOMEBREW_PREFIX", "/opt/homebrew")
    return bool(glob.glob(f"{prefix}/Cellar/{formula}/*"))


def _brew_build_cmd(flags) -> list:
    """The brew command that builds omlx-dev (head-only formula).

    This brew version is inconsistent about --HEAD and both error paths
    are real (hit 2026-09-24): `install` REFUSES a head-only formula
    without --HEAD, `reinstall` REJECTS --HEAD outright. So: first build
    installs with the flag, every rebuild reinstalls without it. Neither
    is ever `brew upgrade` — it no-ops on branch heads."""
    if _formula_keg_exists("omlx-dev"):
        return ["brew", "reinstall", *sorted(flags), "omlx-dev"]
    return ["brew", "install", "--HEAD", *sorted(flags), "omlx-dev"]


def _dev_next_steps(cfg: dict, fresh: bool) -> None:
    """The commands that matter after bootstrap/install — printed once,
    not scattered across stages."""
    from . import devsrc

    rt = devsrc.runtime_config(cfg)
    url = f"http://127.0.0.1:{rt['port']}/uplift/"
    if fresh:
        print("\nNext steps:\n"
              "  1. enable build-scope patches, then build:\n"
              "       omlx-uplift dev install"
              "   [--with-custom-kernel --with-grammar]\n"
              "  2. run the dev server instead of vanilla:\n"
              "       brew services stop omlx && brew services start omlx-dev\n"
              f"     dashboard: {url}  (data root {rt['base_path']})\n"
              "  Later: toggle patches and rebuild from the dashboard's\n"
              "  Build patches section, or re-run step 1.")
    else:
        print("\nNext steps:\n"
              "  1. load the new build:\n"
              "       brew services restart omlx-dev\n"
              f"     dashboard: {url}  (data root {rt['base_path']})\n"
              "  2. switch back to vanilla any time:\n"
              "       brew services stop omlx-dev && brew services start omlx")


def _regate_build_patches(build_patches: list[dict]) -> dict:
    """Re-gate every enabled build patch against the freshly checked-out
    base (materialize ran first, so the worktree IS the new base + earlier
    patches... gate against the pristine base tree instead: a detached
    worktree at base). Returns {patch_id: reason} for failures."""
    from . import devsrc, patchsource

    cfg = devsrc.load_config() or {}
    store = _patches_store()
    failures: dict[str, str] = {}
    if not build_patches or not cfg.get("src_path"):
        return failures
    import tempfile

    path = devsrc.src_path(cfg)
    remote, ref = devsrc._sync_parts(cfg)
    base = f"refs/remotes/{remote}/{ref}"
    tmp = tempfile.mkdtemp(prefix="uplift-regate-")
    try:
        devsrc._git(["worktree", "add", "--detach", "-q", tmp, base],
                    cwd=path)
        manifest = store.load()
        for p in build_patches:
            # gate against the tree as the NEXT patch will find it: base +
            # all earlier patches in materialization order
            entry = store.find(manifest, p["id"])
            if entry is None:
                continue
            ver = store.get_version(entry, p["version"]) or {}
            result = patchsource.validate(
                p["diff_bytes"], tmp,
                reverse=bool(entry.get("reversal")), skip_patterns=None)
            if not result["ok"]:
                entry["state"] = "needs_review"
                entry["state_detail"] = ("re-gate after dev install failed: "
                                         + (result.get("reason")
                                            or "one or more files failed"))
                failures[p["id"]] = result.get("reason") or "gate failed"
                # still apply so later patches gate against the same tree
                # materialize actually built (materialize committed them)
            try:
                devsrc._apply_one(tmp, p["id"], p.get("version", 0),
                                  p["diff_bytes"])
            except devsrc.DevsrcError:
                pass
        if failures:
            store.save(manifest)
    except devsrc.DevsrcError as exc:
        print(f"re-gate skipped (worktree at base failed): {exc}",
              file=sys.stderr)
    finally:
        devsrc._git(["worktree", "remove", "--force", tmp], cwd=path,
                    check=False)
    return failures


def _mount_into_dev_keg() -> bool:
    """Drop the uplift .pth into the omlx-dev keg's python (own keg, so
    unsandboxed; same single-file contract as
    `omlx-uplift install --formula omlx-dev`)."""
    target = _default_target_python("omlx-dev")
    if not target:
        return False
    sp = _resolve_site_packages(target)
    sp.mkdir(parents=True, exist_ok=True)
    (sp / PTH_NAME).write_text(_pth_content(Path(target)), encoding="utf-8")
    return True


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
            "serve", "view", "install", "uninstall", "patches", "kernel",
            "skin", "dev"}:
        print(f"omlx-uplift: unknown command {sys.argv[1]!r}\n",
              file=sys.stderr)
        from .help import print_help
        print_help()
        return 1
    cmd = sys.argv[1]
    rest = sys.argv[2:]
    if cmd == "skin":
        # 'omlx-uplift skin compile …' — the action is rest[0], not rest itself
        if not rest or rest[0] not in ("compile", "decompile"):
            print("usage: omlx-uplift skin compile <dir> [-o out.yml]\n"
                  "       omlx-uplift skin decompile <yml> [-C skins-dir]")
            return 1
        return cmd_skin(rest)
    return {"serve": cmd_serve, "view": cmd_view, "install": cmd_install,
            "uninstall": cmd_uninstall, "patches": cmd_patches,
            "kernel": cmd_kernel, "dev": cmd_dev}[cmd](rest)


if __name__ == "__main__":
    sys.exit(main())
