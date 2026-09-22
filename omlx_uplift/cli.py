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
  omlx-uplift install [--python PATH]     drop the autopatch .pth into a
      target environment's site-packages (default target: Homebrew omlx
      keg). Manual step for tricky venvs; REQUIRED after every fresh
      install and after every `brew upgrade omlx`.
  omlx-uplift uninstall [--python PATH]   remove the .pth again.
  omlx-uplift patches status|apply|check|disable-all
      out-of-band patch-carrier recovery when the dashboard is unreachable:
      same engine the .pth startup reconcile uses, no re-exec, JSON output.
  omlx-uplift kernel list|rebuild <name> [--src PATH]
      rebuild ONE bundled native kernel in the live keg after a patch
      touched kernel code (needs an omlx source checkout containing csrc/).

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


def _target_can_import(python: Path) -> bool:
    import subprocess

    return (
        subprocess.run(
            [str(python), "-c", "import omlx_uplift"],
            capture_output=True,
        ).returncode
        == 0
    )


def _pth_content(target: Path | None) -> str:
    """The .pth body. If the target interpreter can import omlx_uplift on
    its own (package lives in its own site-packages), a bare import
    suffices. Otherwise bootstrap sys.path with OUR package parent dir
    first — a .pth line starting with 'import ' is executed, any other
    line is appended to sys.path, so the keg needs exactly this ONE file,
    nothing else. Order matters: path line first."""
    lines: list[str] = []
    if target is not None and not _target_can_import(target):
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


def cmd_install(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="omlx-uplift install")
    ap.add_argument("--python", help="target interpreter "
                    "(default: Homebrew oMLX keg if present, else this one)")
    args = ap.parse_args(argv)
    target = args.python or _default_target_python()
    sp = _resolve_site_packages(target)
    pth = sp / PTH_NAME
    body = _pth_content(Path(target) if target else None)
    pth.write_text(body)
    print(f"installed autopatch: {pth}")
    if "\nimport " in "\n" + body and body.count("\n") > 1:
        print("  (bootstraps sys.path to this package — keg holds no copy)")
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
    Also: --enable-sentinel-off removes the sentinel after manual fixes."""
    import json as _json

    ap = argparse.ArgumentParser(prog="omlx-uplift patches")
    ap.add_argument("action", choices=["status", "apply", "check", "disable-all"])
    args = ap.parse_args(argv)

    from . import patchsource, patches as _patches, patchsync

    store = _patches.PatchStore()
    root = _patches._omlx_root()
    if not root:
        print("omlx package tree not found — is omlx installed for this python?",
              file=sys.stderr)
        return 2
    tree_root = os.path.dirname(root)

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


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in {
            "serve", "view", "install", "uninstall", "patches", "kernel"}:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    rest = sys.argv[2:]
    return {"serve": cmd_serve, "view": cmd_view, "install": cmd_install,
            "uninstall": cmd_uninstall, "patches": cmd_patches,
            "kernel": cmd_kernel}[cmd](rest)


if __name__ == "__main__":
    sys.exit(main())
