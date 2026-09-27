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
# which re-materializes first, then `brew reinstall omlx-dev` (head-only
# formula: HEAD is always the build target; this brew has no --HEAD flag
# on reinstall).
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
end

# Load jundot's formula by PATH — plain `brew` may resolve formulas via the
# API without ever loading the file, so the class may not be defined yet.
unless defined?(Omlx)
  unless File.exist?(OmlxDevConstants::OMLX_FORMULA_PATH)
    odie "omlx-dev needs the jundot/omlx tap checked out at " \
         "#{OmlxDevConstants::OMLX_FORMULA_PATH}; run: brew tap jundot/omlx"
  end
  require OmlxDevConstants::OMLX_FORMULA_PATH
end

class OmlxDev < Omlx
  desc "LLM inference server (omlx) built from the local uplift dev-src branch"
  homepage "https://github.com/zviratko/omlx"
  license "Apache-2.0"

  # Head-only: the source is the local clone, there is no stable artifact.
  def self.dev_src
    OmlxDevConstants.src_path(OmlxDevConstants.dev_config)
  end

  def self.dev_branch
    OmlxDevConstants.dev_config["formula_branch"] || "uplift-dev"
  end

  head "file://#{OmlxDevConstants.src_path(OmlxDevConstants.dev_config)}",
       branch: OmlxDevConstants.dev_config["formula_branch"] || "uplift-dev",
       using:  :git

  # Re-declared (see header): same flags as jundot/omlx so receipt-based
  # option reuse works the same way.
  option "with-custom-kernel",
         "Build native custom kernels for Bonsai, GLM-5.2, MiniMax M3 and Qwen3.5/3.6/4 acceleration"
  option "with-grammar", "Install xgrammar for structured output (requires torch, ~2GB)"

  depends_on "rust" => :build
  depends_on arch: :arm64
  depends_on macos: :sequoia
  depends_on "python@3.11"

  on_macos do
    skip_clean "libexec" if MacOS.version >= "27"
  end

  # Same resources as jundot/omlx (subclass specs start empty — re-declared).
  resource "mlx-audio" do
    url "https://github.com/Blaizzy/mlx-audio.git",
        revision: "51753266e0a4f766fd5e6fbc46652224efc23981"
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
                          OMLX_BASE_PATH: File.expand_path(base)
  end

  def install
    if Dir[buildpath/"omlx/*"].none?
      odie "dev-src checkout missing at #{self.class.dev_src} — run: omlx-uplift dev bootstrap"
    end
    super
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
      (first run needs `omlx-uplift dev bootstrap` — it clones dev-src and
      creates the branch this formula builds; a missing-branch clone error
      below means bootstrap was skipped).
      (it re-materializes the build patches, then reinstalls from the branch tip;
      plain `brew upgrade` no-ops on branch heads).

      Pin it so plain brew never rebuilds behind uplift's back:
        brew pin omlx-dev

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
