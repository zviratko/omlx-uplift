"""omlx-uplift CLI.

  omlx-uplift serve [oMLX serve args...]   run oMLX + Uplift (wrapper:
      delegates ALL argument handling and startup to omlx's own serve
      command — zero logic duplication; the .pth autopatch mounts us when
      omlx.server is imported). Falls back to explicit mount if the .pth
      is not installed.
  omlx-uplift view  [--api URL] [--port N] standalone viewer for installs
      that cannot load Python (DMG): serves the same UI, talks plain HTTP.
  omlx-uplift install [--python PATH]     drop the autopatch .pth into a
      target environment's site-packages (pip installs do this via the
      data_files hook; manual for tricky venvs).
  omlx-uplift uninstall [--python PATH]   remove it again.
"""

from __future__ import annotations

import argparse
import os
import site
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


def cmd_install(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="omlx-uplift install")
    ap.add_argument("--python", help="target interpreter (default: this one)")
    args = ap.parse_args(argv)
    sp = _resolve_site_packages(args.python)
    pth = sp / PTH_NAME
    pth.write_text("import omlx_uplift.autopatch\n")
    print(f"installed autopatch: {pth}")
    return 0


def cmd_uninstall(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="omlx-uplift uninstall")
    ap.add_argument("--python", help="target interpreter (default: this one)")
    args = ap.parse_args(argv)
    pth = _resolve_site_packages(args.python) / PTH_NAME
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
        help="standalone Uplift viewer (for DMG/remote oMLX over HTTP)",
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


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in {"serve", "view", "install", "uninstall"}:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    rest = sys.argv[2:]
    return {"serve": cmd_serve, "view": cmd_view,
            "install": cmd_install, "uninstall": cmd_uninstall}[cmd](rest)


if __name__ == "__main__":
    sys.exit(main())
