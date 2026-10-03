# Changelog

Notable changes to omlx-uplift, per release. `brew install
zviratko/uplift/omlx-uplift` gets the latest tagged release; `--HEAD`
tracks `main`. Tags are cut from `main` with the formula retargeted in
the same commit — see `tests/test_release_formula.py` for what is pinned.

Maintenance rule: when a change is worth a user's attention (feature,
fixed annoyance, changed behavior, new command), add one bullet under an
`Unreleased` heading in the same PR/commit; release preparation moves
`Unreleased` into a version section. Not a commit dump — skip refactors
users never see.

## Unreleased

## [1.0] — 2026-10-03

First stable release; stable Homebrew installs are dependency-pinned
(`constraints-stable.txt`) while `--HEAD` floats.

### Added
- Skin system growth: hover previews in the picker, motion-governance
  validator, skin-overridable CSS tokens, eleven new crates (CAAAAATZ!,
  PHOSPHOR, TRON grid, INKWELL/INKWELL NOIR, discovery-one, halftone,
  kubus, lampion, monitor-83, artelight) and the authoring guide in
  `docs/skins.md`
- Achievements and gamified operations (SHODAN voice), upgrade taunts,
  Czech and 8 more locales at full overlay parity
- Memory & cache header with the three GiB figures; per-card clocks on
  the PHOSPHOR roll band
- CI: GitHub Actions on every push, PR and release tag; nightly
  full-suite watcher for the dev box

### Changed
- Model-settings editor redesigned: Context → Thinking → Sampling →
  Acceleration order, toggles and their knobs as aligned family bands,
  layout fully stable while changes queue (rail pops in, never moves a
  control)
- Patch carrier: dev builds moved to a separate keg (`omlx-dev`), one
  gate rule, one safeguard-approval machine, per-patch disable and
  process log
- Frontend consolidated: one widget registry, one dirty-state machine,
  one fetch kit (`domkit`) — pages no longer drift apart
- Stable builds pin their Python dependencies to the tested set

## [0.9b] — 2026-10-01

Pre-1.0 polish baseline: monorepo split of the frontend (router, models
manager, inspector into modules), shared-domkit groundwork, static-drift
guards, settings-editor modal fixes; login hardening (constant-time key
compare, brute-force throttle).

## [0.1] — 2026-09-26

First standalone repository and Homebrew formula (`zviratko/uplift/
omlx-uplift`): uplift dashboard, metrics store, patch carrier, mount
mechanism (.pth into the omlx keg) and the v1 skin system (drop-in CSS
crates, crate + working-dir formats, CLI codecs) extracted from the omlx
monorepo.
