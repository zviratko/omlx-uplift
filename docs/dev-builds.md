# Dev builds (`omlx-dev`): when the patch carrier is not enough

The hook mode (classic `omlx` keg + the `.pth` carrier, option 1 in the [README](../README.md#install)) is the simplest setup; the dev lane (option 2) works standalone with no classic keg installed. The hook mode's limits: a diff cannot carry new files, generated code, custom Metal kernels, or work-in-progress commits that are not a clean patch yet. Then use the companion formula. `dev install` drives brew for you (every build is a new keg version installed beside the running one, and the switch happens at the end), so no manual brew step is needed:

```bash
omlx-uplift dev bootstrap              # one-time questionnaire (or: --origin URL)
omlx-uplift dev install                # materialize build patches + build the dev keg
```

How it works: your checkout stays pristine (upstream history only). Uplift composites it with the enabled patch set into the `uplift-dev` branch and builds a separate keg from that, so you always know which bytes are running and rollback never touches your checkout. The dev keg runs as its own service (`sh.brew.omlx-dev`) with its own port and base path; it tracks upstream HEAD by default - each rebuild re-cuts the branch from the newest upstream commit. Alongside a classic install the two are independent services; you can run both.

What you get over hook mode:

- **Patches as real commits.** The `uplift-dev` branch is a normal git branch: new files, docs edits, test changes, kernel work. `omlx-uplift dev patches --scope both` lists what is folded in.
- **Arbitrary source, not just releases.** Track any ref (a PR head, `upstream/main`, a bisect point) with `dev bootstrap --sync-ref REF` and `dev status --fetch` to see drift.
- **Auto-build.** With the toggle on (PATCHES dev card, or `omlx-uplift dev auto-build on`) the tracked base commit is remembered; when the service boots on an older base it rebuilds the keg in the background. Any manual rollback or base-pin turns it off.
- **Kept builds and instant switching.** Every build stays in the Cellar under its own version. `dev kegs` lists them, `dev use <sha-prefix>` swaps between them in seconds (a bare sha picks the NEWEST build of that commit). `dev rollback` returns to the previous build; `dev prune` trims old builds (newest 5 kept by default; set `keg_stash_keep` in `~/.omlx/uplift/dev.json`, 1..20, or pass `--keep N`).
- **Build options.** Custom Metal kernels and xgrammar are formula options the build does not assume. `dev bootstrap` asks once - custom kernels are the recommended answer (they are the fastest engine build; pick them unless this Mac cannot run Xcode). If the Metal compiler is not working yet, the question flow offers to fix it: with Xcode installed it runs `xcodebuild -downloadComponent MetalToolchain` for you, without Xcode it opens the App Store page and names the follow-up commands. The answer is stored as `build_options` in `~/.omlx/uplift/dev.json` and used by every `dev install`. Change it later with `dev install --with-custom-kernel --with-grammar` - explicit flags override and re-save the stored answer, so the choice sticks across rebuilds - or edit `build_options` in `dev.json` directly. A kernel build started from a terminal checks the toolchain BEFORE launching brew and offers the same setup instead of dying minutes into the compile. None of this needs a vanilla `omlx` install: without a stored answer and with no vanilla receipt, the build only inherits options from an existing `omlx-dev` receipt, and plain flags otherwise.

Rules of thumb: stable driver plus a few upstream-PR diffs stays on `omlx` + hook mode. Reading, testing or developing omlx source, kernel or docs changes, PR-bisecting goes to `omlx-dev`. The two are independent services; you can run both. `omlx-uplift dev status` prints the live picture and the PATCHES page surfaces the same state.
