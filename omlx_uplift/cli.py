"""omlx-uplift — Uplift dashboard, metrics and patch carrier for oMLX.

Uplift is a pure add-on package: it never modifies vanilla omlx files in
place (patches are the explicit exception, see PATCHES below). The classic
dashboard at /admin/ stays byte-identical.

COMMANDS
  omlx-uplift serve [oMLX serve args...]   run oMLX + Uplift (wrapper:
      delegates ALL argument handling and startup to omlx's own serve
      command — zero logic duplication; the .pth autopatch mounts us when
      omlx.server is imported). Falls back to explicit mount if the .pth
      is not installed.
  omlx-uplift view  [--api URL] [--port N] standalone viewer for installs
      that cannot load Python (DMG): serves the same UI, talks plain HTTP.
  omlx-uplift install [--python PATH] [--yes|--keep-skins]
      drop the autopatch .pth into a
      target environment's site-packages (default target: Homebrew omlx
      keg). Manual step for tricky venvs; REQUIRED after every fresh
      install and after every `brew upgrade omlx`. Prints a colour
      per-patch preview first: "OMLX-UPLIFT PATCHES TO APPLY: <ids>" then
      SUCCESS / APPLIED / WARNING / FAILURE per patch (dry-run only, no
      writes). Also copies the bundled example skins into
      ~/.omlx/uplift/skins/ — an existing differing file is only replaced
      after confirmation, and the previous version is always kept as
      <name>.yml.<timestamp>~ first (--yes answers yes, --keep-skins skips
      skin installation entirely; non-interactive runs never overwrite).
      Ends with a MOUNT CHECK: imports omlx.server in a probe subprocess
      and verifies the Uplift mount flag — exit 1 + the failing import
      lines when /uplift/ would 404 after the next start.
  omlx-uplift uninstall [--python PATH]   remove the .pth again.
  omlx-uplift patches status|apply|check|disable-all
      out-of-band patch-carrier recovery when the dashboard is unreachable:
      same engine the .pth startup reconcile uses, no re-exec, JSON output.
  omlx-uplift kernel list|rebuild <name> [--src PATH]
      rebuild ONE bundled native kernel in the live keg after a patch
      touched kernel code (needs an omlx source checkout containing csrc/).
  omlx-uplift skin compile <dir> [-o out.yml]
      pack a skin working dir (~/.omlx/uplift/skins/<name>-<mtime>/) back
      into a canonical single-file crate .yml (deterministic).
  omlx-uplift skin decompile <yml> [-C skins-dir]
      extract a skin crate into <name>-<mtime>/ (never overwrites an
      existing dir — that one may carry hand edits).

CONFIG FILES  (all under the data dir: ~/.omlx/uplift/, or $OMLX_BASE_PATH
/uplift/ when that environment variable is set)
  metrics.sqlite3        UPLIFT'S OWN metrics database. The collector writes
      sub-hour-resolution time series and per-request rows here. Vanilla
      omlx's ~/.omlx/usage.sqlite3 (hourly rollups) is opened strictly
      READ-ONLY and never written by uplift.
  env_overrides.json     uplift-stored experimental OMLX_* tunables (the
      allow-list shown in Settings). Seeded into os.environ at interpreter
      startup by the autopatch hook. A genuine launch-time environment
      variable (launchd plist, shell, CLI) ALWAYS wins; stored values fill
      only the gaps. Effect class per knob is shown in the UI: immediate /
      restart model / restart server.
  patches.json           patch manifest: declarative desired state for every
      patch carrier (state machine: pending -> applied -> update_available /
      needs_review / failed / disabled / obsolete). Stored diffs, backups
      and this manifest live entirely uplift-side.
  patches/               stored diff files and byte-exact pre-apply backups.
  patches.lock           reconcile lock (startup and CLI share it).
  patches.disabled       kill-switch sentinel: when present, startup only
      verifies patches and boots omlx unpatched. `patches disable-all`
      creates it; delete the file (or re-enable patches in the UI) to resume.
  kernel-backups/        byte-exact originals behind `kernel rebuild`.
Browser-side settings (theme, layout, locale) are client-side only: they
live in localStorage, never in these files.

PATCHES  (patch carrier, PAT design)
  You upload unified diffs; uplift applies them to the live omlx package
  tree with a strict applier and keeps byte-exact backups for restore.
  At every server start, BEFORE omlx.server is imported, the .pth hook runs
  a reconcile: applied+unchanged patches are skipped (fast verify), enabled
  patches whose target still matches are (re)applied in order, failures turn
  into needs_review (WARNING badge) and boot continues UNPATCHED for that
  one patch only. If any file changed on disk, the process re-execs itself
  ONCE before engines start, so patched code is served right away. Hard
  limits: whole reconcile is time-boxed to 60 s (rest defers to next start),
  at most one re-exec per boot, and every error path boots omlx unpatched —
  a broken patch can never prevent the server from starting.
  Guard rails: diffs touching compiled kernel sources (omlx/custom_kernels/)
  or resolving outside the keg are HELD until you approve per reason code;
  `omlx-uplift kernel rebuild` handles the compiled-artifact side.

OMLX UPGRADE WORKFLOW  (brew upgrade omlx / pip install -U omlx)
  The upgrade replaces the keg and silently unmounts uplift (the .pth dies
  with the old keg). Until you re-mount, omlx serves VANILLA. Sequence:

      brew upgrade omlx
      omlx-uplift install          # BEFORE the restart, or first boot is vanilla
      launchctl kickstart -k gui/$(id -u)/sh.brew.omlx

  At that first patched boot every enabled patch is re-applied against the
  NEW keg: diffs whose context still matches apply automatically; diffs
  broken by upstream drift go to needs_review and need a re-based upload in
  the UI (Settings -> Patches, or `omlx-uplift patches status`). Your data
  survives untouched: ~/.omlx/uplift/ is outside the keg.
  `brew upgrade omlx-uplift` needs no remount: the .pth points at the stable
  opt/ symlink.
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


def _brew_omlx_python() -> Path | None:
    """Path to a Homebrew oMLX keg interpreter, if brew + omlx exist."""
    import shutil
    import subprocess

    brew = shutil.which("brew")
    if not brew:
        return None
    try:
        prefix = subprocess.run(
            [brew, "--prefix", "omlx"], capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):  # pragma: no cover
        return None
    cand = Path(prefix) / "libexec" / "bin" / "python"
    return cand if prefix and cand.is_file() else None


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


def _default_target_python() -> str | None:
    """No --python given: prefer a Homebrew oMLX keg (the common case for
    tap users), else stay in the current interpreter."""
    keg = _brew_omlx_python()
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
        if _patches_mod.patch_scope(patch) == _patches_mod.SCOPE_BUILD:
            continue  # build-scope: never applied to a keg (DEV-1)
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
    return Path(__file__).resolve().parent / "skins-example"


def install_example_skins(stream=None, force: str = "ask") -> None:
    """Copy bundled example skin crates into the live skins dir.

    force: 'ask' (prompt on a differing existing file), 'yes' (replace),
    'keep' (never touch). A replaced file is NEVER deleted: the previous
    version is saved next to it as <name>.yml.<YYYYmmdd-HHMMSS>~ and the
    backup path is disclosed to the user. Byte-identical files are left
    alone; non-interactive streams never block (keep + tell)."""
    out = stream or sys.stdout
    import filecmp
    import shutil
    from datetime import datetime
    from . import skins as _skins

    src = _example_skins_dir()
    if not src.is_dir():                      # exotic installs without data
        return
    dest = _skins.skins_root()
    for yml in sorted(src.glob("*.yml")):
        target = dest / yml.name
        try:
            if not dest.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            if target.exists() and filecmp.cmp(target, yml, shallow=False):
                print(f"skin example: {target} already current", file=out)
                continue
            if target.exists():
                if force == "ask":
                    if not sys.stdin.isatty():
                        print(f"skin example: {target} exists and differs — "
                              "kept (re-run with --yes to replace)", file=out)
                        continue
                    ans = input(f"{target} exists and differs from the "
                                f"bundled example — replace? [y/N] ").strip()
                    if ans.lower() not in ("y", "yes"):
                        print(f"skin example: kept {target}", file=out)
                        continue
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                backup = target.with_name(f"{target.name}.{stamp}~")
                shutil.copy2(target, backup)
                print(f"skin example: replaced {target}\n"
                      f"    previous version saved as {backup}", file=out)
            else:
                print(f"skin example: installed {target}", file=out)
            shutil.copy2(yml, target)
        except OSError as exc:
            print(f"skin example: skipped {yml.name} ({exc})", file=out)


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
                    help="replace existing example skins without asking "
                    "(old copies are kept as <name>.yml.<timestamp>~)")
    ap.add_argument("--keep-skins", action="store_true",
                    help="do not touch example skins in ~/.omlx/uplift/skins")
    args = ap.parse_args(argv)
    target = args.python or _default_target_python()
    sp = _resolve_site_packages(target)
    pth = sp / PTH_NAME
    body = _pth_content(Path(target) if target else None)
    pth.write_text(body)
    print(f"installed autopatch: {pth}")
    if "\nimport " in "\n" + body and body.count("\n") > 1:
        print("  (bootstraps sys.path to this package — keg holds no copy)")
    if not args.keep_skins:
        install_example_skins(force="yes" if args.yes else "ask")
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
    ap.add_argument("--scope", choices=["runtime", "build"],
                    help="patch scope (DEV-1). runtime gates against the "
                         "keg; build gates against a source checkout "
                         "(--build-root or the dev-src clone) and is "
                         "materialized on the omlx-dev branch. Omit to "
                         "auto-classify: the verdict names build-only "
                         "sections when a keg gate cannot host them.")
    ap.add_argument("--build-root", help="source checkout used to gate "
                                         "scope=build (default: ~/.omlx/"
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
            print("hint: re-run with --scope build to record it as a "
                  "build patch", file=sys.stderr)
            return 3
        print(_json.dumps(out, indent=2))
        return 0 if out.get("ok") else 1

    if args.action == "status":
        out = patchsource.view(store, tree_root, _patches.keg_id(root))
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
    if len(sys.argv) < 2 or sys.argv[1] not in {
            "serve", "view", "install", "uninstall", "patches", "kernel",
            "skin"}:
        print(__doc__)
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
            "kernel": cmd_kernel}[cmd](rest)


if __name__ == "__main__":
    sys.exit(main())
