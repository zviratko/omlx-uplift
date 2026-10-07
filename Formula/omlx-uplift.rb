class OmlxUplift < Formula
  desc "Uplift dashboard: companion UI and metrics for oMLX"
  homepage "https://github.com/zviratko/omlx-uplift"
  # REPO-1: moved out of the omlx monorepo into its own repo.
  # Stable tag by default, `--HEAD` follows main. This repo IS the tap
  # (zviratko/uplift), so tag + formula + package version move in one
  # commit; tests/test_release_formula.py pins that they agree.
  url "https://github.com/zviratko/omlx-uplift.git", tag: "v1.1"
  head "https://github.com/zviratko/omlx-uplift.git", branch: "main", using: :git

  # Depends on the omlx formula from the upstream tap; brew resolves
  # cross-tap deps by full name. We do NOT patch omlx's keg files — the
  # package mounts itself at python level; a vanilla `brew upgrade omlx`
  # stays byte-identical (re-run `brew reinstall omlx-uplift` afterwards
  # to re-inject into the fresh keg).
  depends_on "jundot/omlx/omlx"
  depends_on "python@3.11"

  def omlx_python
    (formula_opt_prefix("omlx")/"libexec/bin/python")
  end

  def install
    # Own libexec venv: standalone viewer + CLI (`omlx-uplift view` for
    # DMG installs) + the mount manager. brew's sandbox denies ALL writes
    # into other kegs in every phase (install, post_install, test), so
    # the formula itself cannot touch omlx's python. The user's one extra
    # command, `omlx-uplift install`, runs unsandboxed and drops exactly
    # ONE file — a .pth that bootstraps sys.path to this keg's venv and
    # imports the autopatch. Nothing is copied into the omlx keg.
    system "python3.11", "-m", "venv", libexec
    # REL-1: STABLE builds pin the exact dependency set the release was
    # tested with (constraints-stable.txt, shipped in the repo); --HEAD
    # builds float fastapi/uvicorn so main always rides the newest.
    if head?
      system libexec/"bin/pip", "install", "fastapi", "uvicorn"
    else
      system libexec/"bin/pip", "install", "-c",
             buildpath/"constraints-stable.txt", "fastapi", "uvicorn"
    end
    # --no-deps: the package declares `omlx` (no PyPI distribution).
    # (bare path object, not "#{}" — brew audit style, REL-1 follow-up)
    system libexec/"bin/pip", "install", "--no-deps", buildpath
    # pip's console-script shim, into a predictable bin.
    bin.install libexec/"bin/omlx-uplift"
  end

  def caveats
    mounted = begin
      if omlx_python.exist?
        sp = Utils.safe_popen_read(omlx_python, "-c",
          "import site; print(site.getsitepackages()[0])").strip
        File.exist?("#{sp}/omlx_uplift.pth")
      else
        false
      end
    rescue
      false
    end

    if mounted
      <<~EOS
        Uplift is mounted into omlx's python. Open:
          http://127.0.0.1:<omlx-port>/uplift/
        After `brew upgrade omlx` re-run:
          omlx-uplift install
          launchctl kickstart -k gui/$(id -u)/sh.brew.omlx
      EOS
    else
      <<~EOS
        Finish the mount (one command, writes one .pth into omlx's python):
          omlx-uplift install
        then restart omlx:
          launchctl kickstart -k gui/$(id -u)/sh.brew.omlx
        Open: http://127.0.0.1:<omlx-port>/uplift/
      EOS
    end
  end

  test do
    # Self-contained: our venv always contains the package; the keg copy
    # only exists while mounted, so don't depend on mount state here.
    system libexec/"bin/python", "-c", "import omlx_uplift, omlx_uplift.router, omlx_uplift.viewer"
    # bare invocation prints usage and exits 0 (CLI help redesign made it
    # a friendly landing, not an error; expectation was exit 1 pre-2026-10)
    assert_match "omlx-uplift", shell_output("#{bin}/omlx-uplift 2>&1")
  end
end
