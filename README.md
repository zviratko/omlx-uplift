# omlx-uplift

Uplift is an opt-in companion dashboard and metrics layer for
[oMLX](https://github.com/jundot/omlx). It installs as a separate Homebrew
formula (`zviratko/uplift/omlx-uplift`) and never copies code into the omlx
keg: one `.pth` file (`omlx_uplift.pth`) bootstraps `sys.path` and imports
the autopatch hook at interpreter start. The classic `/admin/` dashboard
stays byte-identical and fully working.

```bash
brew tap zviratko/uplift https://github.com/zviratko/homebrew-uplift
brew install omlx-uplift
omlx-uplift install                      # writes the ONE .pth into the omlx keg
launchctl kickstart -k gui/$(id -u)/sh.brew.omlx
# open http://127.0.0.1:<omlx-port>/uplift/
```

After `brew upgrade omlx` (fresh keg), re-run `omlx-uplift install` and
kickstart again. Removing uplift: `omlx-uplift uninstall` (removes the
`.pth`), then `brew uninstall omlx-uplift`.

## Patch carrier (PATCHES page)

Uplift can carry small local patches on top of vanilla oMLX so fixes you
need today (for example open PRs of oMLX) survive vanilla upgrades, with
per-patch version history and rollback — **rollback never rolls back
omlx itself**.

Declarative model:

- The manifest `~/.omlx/uplift/patches.json` is the only description of
  what should be applied. You may edit it by text while omlx is stopped.
- Nothing writes the keg from the dashboard. Enable, disable, promote,
  rollback and reconcile are bookkeeping; files change only when an
  interpreter with the `.pth` hook boots (the `omlx serve` start, a
  launchd respawn — or `omlx-uplift patches apply` when you want it now).
- When the startup engine really changed files, it re-execs the
  interpreter once before engines start, so the server process never
  imports a half-patched tree.
- Each patch keeps its stored versions (newest 100). Sources are a
  GitHub PR (`owner/repo` + number), any https URL, or an uploaded
  `.diff`. Every candidate passes a strict validation gate first: pure
  unified-diff parse, strict context match against the tree as it will
  be at apply time (this patch's own hunks unwound), `py_compile` /
  JSON checks. A failed gate stores nothing and changes no state.

State meanings (PATCHES page chips):

| state | meaning |
|---|---|
| `applied` | desired version is live in the keg (verified byte-exact) |
| `pending` | will apply at the next omlx start |
| `update_available` | source drifted; a validated candidate awaits Promote |
| `needs_review` | apply failed (usually after a vanilla upgrade) — **WARNING banner**; oMLX boots and runs WITHOUT the patch until you resolve it |
| `obsolete` | upstream now contains the change — consider Remove |
| `disabled` | files are restored to vanilla bytes |

Rollback semantics — what rollback does and does NOT do:

- Does: point the patch back to a previous stored version. Files become
  byte-exact to what they were before (vanilla or the other version) at
  the next omlx restart. Disable and Remove likewise restore pristine
  vanilla bytes, unwinding every applied version's backups newest-first.
- Does NOT: install, downgrade or pin omlx. Uplift never touches the
  keg's omlx content — if a vanilla upgrade moved the code under your
  patch, the patch is MARKED for review (`needs_review`), never forced.

Obsolete flow: when upstream merges the PR, "Check for updates" reports
the patch as obsolete (all hunks already present) and state lights up
`obsolete`. The honest response is Remove, which restores vanilla bytes.

Kill switches (both mean: boot pristine vanilla, manifest untouched,
verify-only — no writes):

```bash
OMLX_UPLIFT_NO_PATCHES=1 omlx serve      # env kill switch, one launch
touch ~/.omlx/uplift/patches.disabled    # sentinel, until removed
omlx-uplift patches disable-all          # sentinel + disable every patch
omlx-uplift patches status               # JSON view for recovery
omlx-uplift patches apply                # reconcile now (no re-exec)
omlx-uplift patches check                # re-fetch sources, report drift
```

If a patch set wedges boot, use a kill switch, fix the manifest by hand
(it is plain JSON), remove the sentinel, start again.

## Development kegs (`omlx-dev`) — when the patch carrier is not enough

The hook mode above (vanilla `omlx` + the `.pth` carrier) is the right
default: nothing in the omlx tree changes, patches are strict unified
diffs gated against the exact keg bytes. It has hard limits, though: a
diff cannot carry NEW files, generated code, custom Metal kernels, or
work-in-progress commits that are not a clean patch yet. When you hit
those, use the companion formula instead:

```bash
brew install zviratko/uplift/omlx-dev   # builds omlx from YOUR git checkout
omlx-uplift dev bootstrap               # one-time questionnaire (or: --origin URL)
omlx-uplift dev install                 # materialize + install the dev keg
```

How it works: your checkout stays PRISTINE (upstream history only). Uplift
composites it with the enabled patch set into the `uplift-dev` branch and
builds a SEPARATE keg from that — so you always know exactly which bytes
are running, and rollback never touches your checkout. The dev keg runs
as its own service (`sh.brew.omlx-dev`) with its own port and base path;
the stable `omlx` keeps serving alongside it.

What you get over hook mode:

- **Patches as real commits.** The `uplift-dev` branch is a normal git
  branch: new files, README/docs edits, test changes, kernel work —
  anything a diff can't express. `omlx-uplift dev patches --scope both`
  lists what is folded in.
- **Run arbitrary source, not just releases.** Track any ref — your
  fork's PR head, `upstream/main`, a bisect point — with
  `omlx-uplift dev bootstrap --sync-ref upstream/main` and
  `dev status --fetch` to see drift. Useful for testing an upstream PR
  locally before it merges.
- **Auto-build (DEV-11).** With the toggle on (dashboard PATCHES → dev
  card, or `omlx-uplift dev auto-build on`) the tracked base commit is
  remembered; when the service boots on an older base it rebuilds the
  keg in the background, so a morning boot picks up pushed commits. Any
  manual rollback or base-pin turns it OFF — your control wins.
- **Keg stash and instant switching (U19).** `dev stash-keg` freezes the
  current keg, `dev use <sha-prefix>` swaps between saved kegs in
  seconds — bisect a regression or A/B two builds without rebuilds.
  `dev rollback` returns to the last-known-good; `dev prune` trims old
  stashes.
- **Build options** the formula ships without: `dev install
  --with-custom-kernel --with-grammar`.

Rules of thumb: stable driver + a few upstream-PR diffs → stay on
`omlx` + hook mode. Reading, testing or developing omlx source, kernel
or docs changes, PR-bisecting → `omlx-dev`. The two are independent
services; you can run both. More detail (DEV-context decisions, scope
model runtime/build/both): `omlx-uplift dev status` prints the live
picture, and the PATCHES page surfaces the same state.
