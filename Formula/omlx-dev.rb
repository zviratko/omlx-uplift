# omlx-dev: oMLX built FROM THE LOCAL uplift dev-src clone (DEV-3).
#
# The formula is deliberately dumb (DEV-context decision 2): it builds the
# tip of the `uplift-dev` branch of ~/.omlx/uplift/dev-src, which omlx-uplift
# materializes from the enabled build-scope patches (one commit per patch).
# Uncommitted changes in dev-src are invisible to brew — brew fetches into
# its own cache clone and resets to origin/uplift-dev (verified in
# download_strategy/git_download_strategy.rb). The ONLY rebuild path is:
#
#     omlx-uplift dev install
#
# which re-materializes first, stamps a unique build_version + build_commit
# into dev.json, then runs `brew install omlx-dev` (KEG-VERSIONED, see
# build_version below: every build is a NEW fake version, so brew installs
# it beside the live keg instead of `reinstall`, which moves the running
# keg out of the way BEFORE the multi-minute build).
#
# WHY `class OmlxDev < Omlx` needs re-declarations: Homebrew resets the
# stable/head SoftwareSpecs on subclassing (formula.rb `inherited`), so the
# DSL constants (head url, options, depends_on, resources, skip_clean) must
# be re-declared here; the METHODS (install, post_install, patch_xgrammar,
# fix_custom_kernel_rpaths, verify_custom_kernels) are inherited from
# jundot's formula unchanged. Keeping the class inheritance means upstream
# build-logic fixes land here for free; if jundot ever changes the DSL in a
# way that breaks this subclass, the fallback is vendoring the class body
# (documented in ~/hermes/uplift/in/DEV-context.md decision 4).
#
# DEC-1 (2026-10-20): this needs only the jundot/omlx TAP CHECKOUT (a git
# clone of the formula file) — never an installed vanilla omlx keg. The
# uplift formula likewise dropped its depends_on omlx; a dev-only machine
# installs and mounts entirely without vanilla.
require "json"

module OmlxDevConstants
  # Declared identically to jundot/omlx — keep in sync (verified 2026-09-24).
  OMLX_FORMULA_PATH = "#{HOMEBREW_LIBRARY}/Taps/jundot/homebrew-omlx/Formula/omlx.rb".freeze

  def self.dev_config
    path = File.expand_path("~/.omlx/uplift/dev.json")
    data = JSON.parse(File.read(path))
    data.is_a?(Hash) ? data : {}
  rescue
    {}
  end

  def self.src_path(cfg)
    File.expand_path(cfg["src_path"] || "~/.omlx/uplift/dev-src")
  end

  # KEG-VERSIONED (user 2026-10-20): a FAKE per-build version instead of a
  # HEAD keg. `brew reinstall` unlinks and renames the LIVE keg away BEFORE
  # the multi-minute source build (reinstall/reinstall.rb `backup keg`) —
  # for that whole window opt/omlx-dev dangles and a crash cannot restart.
  # With a unique version per build, uplift runs a plain `brew install`:
  # brew builds the new keg while the old one keeps serving, installs it at
  # its own Cellar/<version> directory, and switches links at the end (ms).
  # Previous binaries simply stay in Cellar — rollback is a symlink switch
  # (omlx-uplift dev use), and two builds of ONE commit are two distinct
  # versions (recompiles and patch-set changes never share bytes).
  # `omlx-uplift dev install` stamps build_version into dev.json right
  # before running brew. A manual bare `brew install` (bootstrap path)
  # derives a stable version from the branch tip instead.
  def self.build_version(cfg)
    v = cfg["build_version"].to_s.strip
    return v unless v.empty?

    src = src_path(cfg)
    br = cfg["formula_branch"] || "uplift-dev"
    stamp = begin
      Utils.popen_read("git", "-C", src, "log", "-1",
                       "--date=format:%Y%m%d.%H%M%S",
                       "--format=%cd.%h", br).strip
    rescue StandardError
      ""
    end
    stamp.empty? ? "0.manual" : stamp
  end
end

# Load jundot's formula by PATH — plain `brew` may resolve formulas via the
# API without ever loading the file, so the class may not be defined yet.
# E2E-2 (first-run test 2026-10-22): this guard used top-level `odie`, which
# does not exist inside Formulary's module_eval — any load of this file with
# the jundot tap missing (brew unpin, brew options, …) printed a Ruby stack
# trace instead of the fix below. `raise` always works; brew shows it as
# "Error: <message>".
unless defined?(Omlx)
  unless File.exist?(OmlxDevConstants::OMLX_FORMULA_PATH)
    raise "omlx-dev needs the jundot/omlx tap checked out at " \
          "#{OmlxDevConstants::OMLX_FORMULA_PATH}; run: brew tap jundot/omlx " \
          "https://github.com/jundot/omlx && brew trust jundot/omlx"
  end
  require OmlxDevConstants::OMLX_FORMULA_PATH
end

class OmlxDev < Omlx
  desc "LLM inference server (omlx) built from the local uplift dev-src branch"
  homepage "https://github.com/zviratko/omlx"
  license "Apache-2.0"

  # KEG-VERSIONED source spec (see OmlxDevConstants.build_version): the
  # per-build fake version + a git STABLE url at the local clone. This is
  # what makes a plain `brew install omlx-dev` build the branch tip into
  # its own Cellar directory — the old head-only shape forced
  # `install --HEAD`/`reinstall`, and reinstall moves the LIVE keg away
  # before the build even starts. `head` stays as the manual escape hatch.
  def self.dev_source(cfg)
    br = cfg["formula_branch"] || "uplift-dev"
    sha = cfg["build_commit"].to_s.strip
    sha = "" unless sha.match?(/\A[0-9a-f]{40}\z/)
    opts = { using: :git, branch: br }
    opts[:commit] = sha unless sha.empty?
    ["file://#{OmlxDevConstants.src_path(cfg)}", opts]
  end

  def self.dev_src
    OmlxDevConstants.src_path(OmlxDevConstants.dev_config)
  end

  def self.dev_branch
    OmlxDevConstants.dev_config["formula_branch"] || "uplift-dev"
  end

  _dev_cfg = OmlxDevConstants.dev_config
  _dev_url, _dev_opts = dev_source(_dev_cfg)
  version OmlxDevConstants.build_version(_dev_cfg)
  url _dev_url, **_dev_opts

  head "file://#{OmlxDevConstants.src_path(OmlxDevConstants.dev_config)}",
       branch: OmlxDevConstants.dev_config["formula_branch"] || "uplift-dev",
       using:  :git

  # Re-declared (see header): same flags as jundot/omlx so receipt-based
  # option reuse works the same way.
  option "with-custom-kernel",
         "Build native custom kernels for Bonsai, GLM-5.2, MiniMax M3 and Qwen3.5/3.6/4 acceleration"
  option "with-grammar", "Install xgrammar for structured output (requires torch, ~2GB)"
  option "with-python312", "EXPERIMENT: build the libexec venv on python " \
    "3.12 (inside upstream's own >=3.11,<3.14 support) instead of the " \
    "hardcoded python3.11. 3.13+ is NOT possible for the engine: " \
    "mlx-audio[all] -> misaki requires python <3.13. Opt-in trial until " \
    "upstream moves (jundot/omlx#3074, PR #3075 closed unmerged)."

  depends_on "rust" => :build
  depends_on arch: :arm64
  depends_on macos: :sequoia
  depends_on "python@3.11"
  # --with-python312: REQUIRED to be a DECLARED depends_on (conditional:
  # build.with? works in the class body — verified on brew 7.0.11), not
  # just a PATH pick — Homebrew superenv strips -I include paths of
  # UNDECLARED formulae, and omlx's nanobind C++ wheel then dies on
  # 'Python.h not found' (proven the hard way, 2026-10-27 trial).
  # Conditional so option-off / vanilla-only machines pull NOTHING new.
  depends_on "python@3.12" if build.with?("python312")

  on_macos do
    skip_clean "libexec" if MacOS.version >= "27"
  end

  # Same resources as jundot/omlx (subclass specs start empty - re-declared).
  # THIS REVISION IS A DEPENDENCY COORDINATE, NOT A COMMENT: the inherited
  # install() stages resource("mlx-audio") and pip-installs it LAST, so a stale
  # revision here silently rewrites the dependency set the source just built.
  # Upstream 3a5a6b2 (2026-10-29) moved its own resource 5175326 (0.4.3) ->
  # 8c244a1 (0.6.3) AND deleted the `inreplace "mlx-lm==0.31.1"` patch, because
  # 0.6.3 requires mlx-lm>=0.31.1 instead of ==0.31.1. With the patch gone from
  # the parent and 0.4.3 staged from here, that last pip step downgraded
  # mlx-lm 0.32.3.dev8+g0d4d3d04f -> 0.31.1, which has no GenerationBatch, and
  # omlx/scheduler.py:33 raised at boot on a keg that built "successfully".
  # Keep this in step with upstream's Formula/omlx.rb and with the
  # mlx-audio pin in the source tree's pyproject.toml.
  resource "mlx-audio" do
    url "https://github.com/Blaizzy/mlx-audio.git",
        revision: "8c244a1faff44cfa69e3151c195f52a4c1c90be5"
  end

  resource "en-core-web-sm" do
    url "https://github.com/explosion/spacy-models/releases/download/" \
        "en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
    sha256 "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"
  end

  # Own service block (decision 4/6): different label, own binary, port and
  # data root diverted via env, and a log path that CANNOT collide — `var`
  # is the shared HOMEBREW_PREFIX/var, so omlx.log would clash.
  # Port/base_path come from dev.json (DEV-4); edits need
  # `brew services restart omlx-dev` — brew regenerates the launchd plist
  # from this block at start time.
  service do
    dev_cfg = OmlxDevConstants.dev_config
    port = dev_cfg["port"] || 8001
    base = dev_cfg["base_path"] || "~/.omlx-dev"
    run [opt_bin/"omlx-dev", "serve"]
    keep_alive true
    working_dir var
    log_path var/"log/omlx-dev.log"
    error_log_path var/"log/omlx-dev.log"
    environment_variables PATH:           std_service_path_env,
                          OMLX_PORT:      port.to_s,
                          OMLX_BASE_PATH: File.expand_path(base),
                          # E2E-3 (2026-10-22): with a saved 0.0.0.0 host but
                          # no API key, omlx asks interactively to fall back
                          # to loopback — under launchd that prompt can never
                          # be answered and the service wedges ("Startup
                          # canceled", exit 1). The notice-path env makes omlx
                          # apply the fallback itself and write the why to
                          # this file instead of blocking.
                          OMLX_STARTUP_NOTICE_PATH: var/"startup-notice.txt"
  end

  def install
    if Dir[buildpath/"omlx/*"].none?
      odie "dev-src checkout missing at #{self.class.dev_src} — run: omlx-uplift dev bootstrap"
    end
    # TEMPORARY DEPENDENCY CEILING — remove once omlx ships its own ceiling
    # (tracked upstream as jundot/omlx#4831; someone else already reported the
    # symptom and isolated the same culprit, so this is a workaround, not a fix).
    #
    # preshed 3.0.14 (PyPI 2026-10-24 21:39) ships .pyx sources byte-identical
    # to 3.0.13 — only the compiled extensions and the version string differ, so
    # it is a rebuild, and that rebuild makes spaCy 3.8.16 die inside
    # Tokenizer._flush_specials on ANY spacy.load():
    #   OverflowError: Python int too large to convert to C ssize_t
    # The parent install ends with `spacy.load('en_core_web_sm')` as a build
    # check, so the whole keg build fails (and Kokoro TTS would fail at runtime
    # too). omlx pins only `spacy>=3.8.4`, and preshed arrives transitively, so
    # PIP_CONSTRAINT is the only lever that reaches it before that check runs.
    # Kept at the exact version the working kegs resolved (2026-10-24 17:19).
    (buildpath/"uplift-pip-constraints.txt").write("preshed==3.0.13\n")
    ENV["PIP_CONSTRAINT"] = (buildpath/"uplift-pip-constraints.txt").to_s

    # Third trap out of upstream 3a5a6b2, and it only bites on macOS 27. mlx-audio
    # 0.6.3's `[all]` extras ask for `uvicorn[standard]`, which pulls the prebuilt
    # maturin wheel `watchfiles`. That .so has no room in its Mach-O header for
    # Homebrew's rewritten ID, so an otherwise COMPLETE build dies in the linker fixup
    # after the keg is installed:
    #   Failed changing dylib ID of .../site-packages/watchfiles/_rust_notify.abi3.so
    #   MachO::HeaderPadError ... needs to be relinked with -headerpad_max_install_names
    #   Error: Failed to fix install linkage
    # ...and brew exits 1 having printed its own success banner. The parent already
    # carries a --no-binary list for exactly this class of wheel, but that list lives
    # inside the inherited install body, and copying it here is the mistake that caused
    # trap (a). pip's format control is append-style, so the env adds one name without
    # forking anything: verified against this box's pip with a CLI --no-binary for a
    # different package present - watchfiles still resolves to the sdist, which builds
    # with the parent's own RUSTFLAGS/LDFLAGS headerpad. watchfiles is only uvicorn's
    # dev-reload watcher; nothing here imports it, so building it from source costs
    # Rust time and nothing else.
    ENV["PIP_NO_BINARY"] = "watchfiles"
    # --with-python312 (EXPERIMENT; option OFF = byte-identical upstream
    # build): jundot's parent creates the venv with a literal
    # `system "python3.11", "-m", "venv", libexec`; a PATH shim named
    # python3.11 pointing at 3.12 retargets it WITHOUT forking their
    # build code. 3.12 sits INSIDE upstream's own >=3.11,<3.14 support —
    # no source patch. 3.13+ is impossible for the ENGINE: mlx-audio[all]
    # -> misaki requires python <3.13 (the 3.14 trial died exactly there).
    # The declared depends_on "python@3.12" is LOAD-BEARING: superenv
    # strips -I paths of undeclared formulae and omlx's nanobind wheel
    # then fails on 'Python.h not found' (include pins kept as belt).
    if build.with?("python312")
      shim = buildpath/"uplift-py-shim"
      shim.mkpath
      File.symlink("/opt/homebrew/opt/python@3.12/bin/python3.12",
                   shim/"python3.11")
      ENV.prepend_path "PATH", shim.to_s
      py312_inc = Formula["python@3.12"].opt_libexec/"include/python3.12"
      ENV.append "CFLAGS", "-I#{py312_inc}"
      ENV.append "CXXFLAGS", "-I#{py312_inc}"
    end
    super
    ENV.delete("PIP_CONSTRAINT")
    ENV.delete("PIP_NO_BINARY")
    # The parent links bin/omlx; this keg must NOT, or linking both formulas
    # at once collides. Rename inside the keg (pre-link), leave the libexec
    # venv untouched.
    if (bin/"omlx").symlink? || (bin/"omlx").exist?
      File.rename(bin/"omlx", bin/"omlx-dev")
    end
  end

  def caveats
    port = OmlxDevConstants.dev_config["port"] || 8001
    base = OmlxDevConstants.dev_config["base_path"] || "~/.omlx-dev"
    <<~EOS
      omlx-dev builds from #{self.class.dev_src} (branch #{self.class.dev_branch}).
      Build/rebuild ONLY via:  omlx-uplift dev install

      Service (runs on port #{port}, data root #{base}):
        brew services stop omlx && brew services start omlx-dev
      Running BOTH services at once is usually unwanted (shared mutable state).
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/omlx-dev --version")
    system libexec/"bin/python", "-c",
           "import spacy; spacy.load('en_core_web_sm')"
    verify_custom_kernels(libexec/"bin/python") if build.with?("custom-kernel")
  end
end
