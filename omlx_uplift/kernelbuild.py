"""In-keg native kernel rebuild (PAT-6 follow-up).

The keg ships compiled kernel artifacts (_ext*.so, lib*_kernel_ops.dylib,
*.metallib) but NOT their csrc/ sources, so a patch that touches native
kernel code cannot take effect by file edits alone. This module builds ONE
kernel from a source checkout with the exact installed-keg interpreter and
swaps the three artifacts into the keg — no full `brew reinstall`, no
re-download of the world.

What is guaranteed by the build itself (verified 2026-09-21):
- the extension is compiled against the keg python's MLX install;
- CMake bakes @loader_path rpaths, so the swapped binaries resolve
  libmlx from the FINAL keg location with zero install_name_tool fixups;
- artifacts are ad-hoc re-signed after the swap (same policy brew uses).

What the user must provide (and what makes this NOT a brew reinstall):
- a source checkout containing omlx/custom_kernels/<name>/csrc (git clone
  or an existing omlx clone; --src reuses one);
- a throwaway build venv (created here) with cmake, ninja and nanobind
  pinned to the MLX build's version + the same mlx release as the keg.

The swap keeps a byte-exact backup of the originals under the uplift data
dir so the uplift-managed `restore` path stays honest.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

KERNELS = ("bonsai", "decode_fast", "glm_moe_dsa", "minimax_m3",
           "qwen35_prefill")

# nanobind ABI must match MLX's own build (see omlx pyproject [build-system]);
# a mismatch silently rejects every mlx.core.array at runtime.
NANOBIND_PIN = "nanobind==2.15.0"

_ARTIFACT_GLOBS = ("_ext*.so", "lib*kernel_ops*.dylib", "*.metallib")


def _run(cmd, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def resolve_sources(name: str, src: str | None) -> str:
    """Path to omlx/custom_kernels/<name>/csrc from a checkout."""
    if src:
        base = os.path.join(src, "omlx", "custom_kernels", name)
    else:
        base = os.path.join(os.getcwd(), "omlx", "custom_kernels", name)
        if not os.path.isdir(base):
            base = os.path.join(os.getcwd(), "custom_kernels", name)
    csrc = os.path.join(base, "csrc")
    if not os.path.isfile(os.path.join(csrc, "CMakeLists.txt")):
        raise SystemExit(
            f"no kernel sources at {csrc} — run inside an omlx source "
            "checkout (any revision containing the kernel) or pass "
            "--src /path/to/omlx-checkout")
    return csrc


def keg_dirs() -> tuple[str, str, str]:
    """(python exe, site-packages dir, omlx package root) — the LIVE keg.
    Reuses patches._omlx_root so CLI/venv layouts both resolve."""
    from . import patches as _patches

    root = _patches._omlx_root()
    if not root:
        raise SystemExit("omlx package tree not found — is omlx installed?")
    tree = os.path.dirname(root)           # site-packages
    # <...>/libexec/lib/python3.11/site-packages -> <...>/libexec/bin/python
    cand = os.path.normpath(os.path.join(tree, "..", "..", "..",
                                         "bin", "python"))
    if not os.path.isfile(cand):
        cand = os.path.normpath(os.path.join(tree, "..", "..", "..", "..",
                                             "..", "bin", "python"))
    exe = cand if os.path.isfile(cand) else sys.executable  # DMG/plain: this python
    return exe, tree, root


def build_venv(workdir: str, keg_python: str, quiet=False) -> str:
    """Throwaway build venv. CMakeLists probes ONE python for nanobind AND
    MLX (`python -m ... --cmake-dir`); the keg has mlx but not nanobind,
    and a venv over the keg python does NOT see the keg's libexec site-
    packages (not a 'system' one). So: plain venv from the keg python +
    cmake/ninja + nanobind pinned to MLX's build version (a mismatch
    silently rejects every mlx.core.array at runtime) + the SAME mlx
    release the keg runs. The probe below fails loudly if any of that is
    untrue — never a silently wrong-ABI extension."""
    venv = os.path.join(workdir, "venv")
    _run([keg_python, "-m", "venv", venv],
         stdout=subprocess.DEVNULL if quiet else sys.stderr)
    pip = os.path.join(venv, "bin", "pip")
    mlx_ver = _run([keg_python, "-c",
                    "import importlib.metadata as m; print(m.version('mlx'))"],
                   capture_output=True, text=True).stdout.strip()
    pkgs = ["cmake>=3.27", "ninja", NANOBIND_PIN]
    if mlx_ver:
        pkgs.append(f"mlx=={mlx_ver}")
    _run([pip, "install", "-q", *pkgs],
         stdout=subprocess.DEVNULL if quiet else sys.stderr)
    vpy = os.path.join(venv, "bin", "python")
    try:
        _run([vpy, "-c", "import nanobind, mlx"], capture_output=True, text=True)
        _run([vpy, "-m", "mlx", "--cmake-dir"], capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            "build venv cannot resolve nanobind+mlx — usually a missing "
            f"mlx=={mlx_ver or '?'} wheel for this python. stderr: "
            + (exc.stderr or "")[-300:])
    return venv


def build_kernel(name: str, csrc: str, out_dir: str, keg_python: str,
                 venv: str, jobs: int | None = None) -> str:
    """cmake+ninja one kernel; artifacts land in out_dir. Returns out_dir.

    Python_EXECUTABLE is the BUILD venv python — CMakeLists probes it for
    nanobind and MLX (`python -m ... --cmake-dir`), which only exist there;
    the keg python has neither. The venv is built FROM the keg python and
    carries the same mlx version, so the compiled ABI matches the keg
    (verified end-to-end 2026-09-21); the version guard below keeps it honest.
    """
    venv_python = os.path.join(venv, "bin", "python")
    probe = "import sys; print('%d.%d' % sys.version_info[:2])"
    v1 = _run([keg_python, "-c", probe], capture_output=True, text=True).stdout.strip()
    v2 = _run([venv_python, "-c", probe], capture_output=True, text=True).stdout.strip()
    if v1 != v2:
        raise SystemExit(f"build venv python {v2} != keg python {v1} — "
                         "ABI mismatch would produce an unloadable extension")
    os.makedirs(out_dir, exist_ok=True)
    ninja = shutil.which("ninja") or os.path.join(venv, "bin", "ninja")
    cmake = os.path.join(venv, "bin", "cmake")
    if not os.path.isfile(cmake):
        cmake = shutil.which("cmake")
        if not cmake:
            raise SystemExit("cmake not found (build venv install failed?)")
    env = dict(os.environ, MACOSX_DEPLOYMENT_TARGET="15.0")
    _run([cmake, "-S", csrc, "-B", os.path.join(out_dir, "build"),
          "-G", "Ninja",
          f"-DCMAKE_MAKE_PROGRAM={ninja}",
          f"-DPython_EXECUTABLE={venv_python}",
          f"-DPython3_EXECUTABLE={venv_python}",
          "-DCMAKE_BUILD_TYPE=Release",
          "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0",
          "-DBUILD_SHARED_LIBS=ON",
          f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={out_dir}"], env=env)
    _run([cmake, "--build", os.path.join(out_dir, "build"),
          "-j", str(jobs or (os.cpu_count() or 4))], env=env)
    return out_dir


def deploy(name: str, out_dir: str, store_base: str, quiet=False) -> dict:
    """Swap artifacts into the live keg with a byte-exact backup."""
    _exe, tree, omlx_root = keg_dirs()
    target_dir = os.path.join(omlx_root, "custom_kernels", name)
    if not os.path.isdir(target_dir):
        raise SystemExit(f"kernel {name!r} not present in the keg "
                         f"({target_dir} missing)")
    backup = os.path.join(store_base, "kernel-backups", name)
    os.makedirs(backup, exist_ok=True)
    swapped, meta_path = [], os.path.join(backup, "meta.json")
    meta = {"files": {}}
    if os.path.isfile(meta_path):
        try:
            meta = json.load(open(meta_path))
        except (OSError, ValueError):
            meta = {"files": {}}
    for pat in _ARTIFACT_GLOBS:
        for built in sorted(glob.glob(os.path.join(out_dir, pat))):
            dest = os.path.join(target_dir, os.path.basename(built))
            if not os.path.isfile(dest):
                continue  # keg may ship fewer artifacts than the build makes
            with open(dest, "rb") as fh:
                raw = fh.read()
            rel = os.path.relpath(dest, tree)
            if meta["files"].get(rel, {}).get("sha256") is None:
                bpath = os.path.join(backup, "files", rel)
                os.makedirs(os.path.dirname(bpath), exist_ok=True)
                with open(bpath, "wb") as fh:
                    fh.write(raw)
                meta["files"][rel] = {"sha256": hashlib.sha256(raw).hexdigest()}
            shutil.copy2(built, dest)
            if dest.endswith((".so", ".dylib")):
                _stamp_mlx_rpath(dest, tree)
                _run(["/usr/bin/codesign", "--force", "--sign", "-", dest],
                     stdout=subprocess.DEVNULL if quiet else sys.stderr,
                     stderr=subprocess.DEVNULL)
            swapped.append(os.path.basename(dest))
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=1, sort_keys=True)
    # stale bytecode next to the swap must go or fast.py logic may be cached
    for d in glob.glob(os.path.join(target_dir, "__pycache__")):
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "kernel": name, "swapped": swapped,
            "backup_dir": backup}


def verify(name: str) -> dict:
    """Import the (re)built kernel in a child process of the keg python."""
    exe, _tree, _root = keg_dirs()
    r = subprocess.run(
        [exe, "-c",
         f"import json, omlx.custom_kernels as ck;"
         f"print(json.dumps(ck.native_kernel_status()['{name}']))"],
        capture_output=True, text=True, cwd="/")
    try:
        status = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        status = {"available": False, "import_error": r.stderr[-400:]}
    return {"ok": bool(status.get("available")), "status": status}


def restore(name: str, quiet=False) -> dict:
    """Byte-exact rollback of a kernel rebuild from its backup (mirrors
    diffapply.restore_backup semantics: sha-verified, refuses on corruption)."""
    _exe, tree, omlx_root = keg_dirs()
    from . import patches as _patches
    backup = os.path.join(_patches.default_base_dir(), "kernel-backups", name)
    meta_path = os.path.join(backup, "meta.json")
    if not os.path.isfile(meta_path):
        return {"ok": False, "reason": f"no kernel backup at {backup}",
                "files": []}
    meta = json.load(open(meta_path))
    restored = []
    for rel, info in sorted(meta.get("files", {}).items()):
        target = os.path.join(tree, *rel.split(os.sep))
        bpath = os.path.join(backup, "files", *rel.split(os.sep))
        try:
            with open(bpath, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            return {"ok": False, "reason": f"backup unreadable: {exc}",
                    "files": restored}
        if hashlib.sha256(data).hexdigest() != info.get("sha256"):
            return {"ok": False, "reason": f"backup corrupt for {rel}",
                    "files": restored}
        with open(target, "wb") as fh:
            fh.write(data)
        if target.endswith((".so", ".dylib")):
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-",
                            target], check=False,
                           stdout=subprocess.DEVNULL if quiet else sys.stderr,
                           stderr=subprocess.DEVNULL)
        restored.append({"path": rel, "status": "restored"})
    for d in glob.glob(os.path.join(omlx_root, "custom_kernels", name,
                                    "__pycache__")):
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "reason": None, "files": restored}


def _stamp_mlx_rpath(binary: str, tree: str) -> None:
    """Same fixup the brew formula applies (issue #2233): ensure the real
    mlx lib dir is an LC_RPATH so dlopen survives the keg's post-install
    install-name rewrite. CMake already bakes @loader_path-relative rpaths;
    this is the belt. install_name_tool invalidates the signature, hence
    the re-sign by the caller."""
    mlx_lib = os.path.join(tree, "mlx", "lib")
    if not os.path.isdir(mlx_lib):
        return
    try:
        out = subprocess.run(["/usr/bin/otool", "-l", binary],
                             capture_output=True, text=True).stdout
    except OSError:
        return
    if mlx_lib in out:
        return
    subprocess.run(["/usr/bin/install_name_tool", "-add_rpath", mlx_lib,
                    binary], check=False, capture_output=True)


def rebuild(name: str, src: str | None = None, workdir: str | None = None,
            keep_venv: bool = False, quiet=False) -> dict:
    """Full pipeline for one kernel: sources -> venv -> build -> swap ->
    verify. Raises SystemExit with a clear message on missing inputs."""
    if name not in KERNELS:
        raise SystemExit(f"unknown kernel {name!r} — "
                         f"known: {', '.join(KERNELS)}")
    csrc = resolve_sources(name, src)
    from . import patches as _patches
    store_base = _patches.default_base_dir()
    keg_python, _tree, _root = keg_dirs()
    tmp = workdir or tempfile.mkdtemp(prefix=f"uplift-kernel-{name}-")
    ephemeral = workdir is None
    os.makedirs(tmp, exist_ok=True)
    try:
        venv = build_venv(tmp, keg_python, quiet=quiet)
        out = build_kernel(name, csrc, os.path.join(tmp, "out"),
                           keg_python, venv)
        res = deploy(name, out, store_base, quiet=quiet)
        res["verify"] = verify(name)
        res["workdir"] = tmp
        return res
    finally:
        if ephemeral and not keep_venv:
            shutil.rmtree(tmp, ignore_errors=True)
