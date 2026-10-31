class OmlxUplift < Formula
  desc "Uplift dashboard: companion UI and metrics for oMLX"
  homepage "https://github.com/zviratko/omlx-uplift"
  # REPO-1: moved out of the omlx monorepo into its own repo.
  # Stable tag by default, `--HEAD` follows main. This repo IS the tap
  # (zviratko/uplift), so tag + formula + package version move in one
  # commit; tests/test_release_formula.py pins that they agree.
  url "https://github.com/zviratko/omlx-uplift.git",
      tag:      "v3.0",
      revision: "37e528e5f42108280d86d026f65c7a0911e86bf7"
  head "https://github.com/zviratko/omlx-uplift.git", branch: "main", using: :git

  # NO depends_on omlx (DEC-1, user 2026-10-20): uplift targets any
  # omlx-family keg that exists — vanilla (jundot/omlx) and/or omlx-dev.
  # A dev-only machine must install WITHOUT brew pulling a vanilla keg it
  # never asked for; `omlx-uplift install` resolves the target keg at
  # runtime (vanilla first when present, else omlx-dev). We never patch
  # keg files — the package mounts itself at python level, so upgrading
  # either keg stays byte-identical (re-run `omlx-uplift install` after a
  # keg upgrade to re-inject the mount).
  # AUTO-FOLLOW (python312 trial 2026-10-27): the .pth mount joins THIS
  # keg's libexec site-packages to the ENGINE interpreter's sys.path, so
  # this venv is built on the engine keg's python minor (see
  # engine_python_minor). Only 3.11 is a hard dep: a 3.12 engine implies
  # --with-python312 was used, and the dev formula's CONDITIONAL
  # dependency already pulled python@3.12 - machines staying on 3.11
  # never see it. Missing python at probe time = engine never built with
  # the option; the venv step below names the fix.
  depends_on "python@3.11"

  def omlx_python
    (formula_opt_prefix("omlx")/"libexec/bin/python")
  end

  # Probe the live omlx-family engine keg (vanilla first, else dev - the
  # same target order as `omlx-uplift install`); plain users with no keg
  # yet keep the historic 3.11 build. Falls back rather than dying: the
  # engine may be installed AFTER uplift.
  def engine_python_minor
    ["omlx", "omlx-dev"].each do |name|
      py = formula_opt_prefix(name)/"libexec/bin/python"
      next unless py.exist?

      begin
        out = Utils.safe_popen_read(py, "-c",
                                    "import sys; print('%d.%d' % sys.version_info[:2])").strip
        return out if /\A3\.1[0-9]\z/.match?(out)
      rescue ErrorReadingError
        next # keg vanished mid-probe; try the next candidate
      end
    end
    "3.11"
  end

  def install
    # Own libexec venv: standalone viewer + CLI (`omlx-uplift view` for
    # DMG installs) + the mount manager. brew's sandbox denies ALL writes
    # into other kegs in every phase (install, post_install, test), so
    # the formula itself cannot touch omlx's python. The user's one extra
    # command, `omlx-uplift install`, runs unsandboxed and drops exactly
    # ONE file — a .pth that bootstraps sys.path to this keg's venv and
    # imports the autopatch. Nothing is copied into the omlx keg.
    minor = engine_python_minor
    venv_py = formula_opt_bin("python@#{minor}")/"python#{minor}"
    unless venv_py.exist?
      odie "engine keg runs python #{minor} but brew python@#{minor} is " \
           "absent - build the engine with it first: omlx-uplift dev " \
           "install --with-python312 (pulls python@3.12), or brew " \
           "install python@#{minor}"
    end
    system venv_py, "-m", "venv", libexec
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
        Finish the mount (one command, writes one .pth into the omlx keg's
        python — vanilla when installed, else omlx-dev):
          omlx-uplift install
        then restart the service you run:
          launchctl kickstart -k gui/$(id -u)/sh.brew.omlx      (vanilla)
          launchctl kickstart -k gui/$(id -u)/sh.brew.omlx-dev  (omlx-dev)
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
