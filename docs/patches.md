# Patches

Uplift can carry small local patches on top of oMLX so fixes you need today (for example open PRs of oMLX) survive keg upgrades, with per-patch version history and rollback. **Rollback never rolls back omlx itself.**

Declarative model:

- The manifest `~/.omlx/uplift/patches.json` is the only description of what should be applied. You may edit it by text while omlx is stopped.
- Nothing writes the keg from the dashboard. Enable, disable, promote, rollback and reconcile are bookkeeping; files change only when an interpreter with the `.pth` hook boots (the `omlx serve` start, a launchd respawn, or `omlx-uplift patch apply` when you want it now).
- When the startup engine really changed files, it re-execs the interpreter once before engines start, so the server process never imports a half-patched tree.
- Each patch keeps its stored versions (newest 100). Sources are a GitHub PR (`repo/N`), any https URL, or an uploaded `.diff`. Every candidate passes a strict validation gate first: pure unified-diff parse, strict context match against the tree as it will be at apply time, `py_compile` / JSON checks. A failed gate stores nothing and changes no state. Diffs that touch kernel sources or reach outside the keg need an explicit approval (`enable --approve once|always`, or the matching dashboard prompt) before auto-apply.

State meanings (PATCHES page chips):

| state | meaning |
|---|---|
| `applied` | desired version is live in the keg (verified byte-exact) |
| `pending` | will apply at the next omlx start |
| `update_available` | source drifted; a validated candidate awaits Promote |
| `needs_review` | apply failed (usually after a keg upgrade) and oMLX runs WITHOUT the patch until you resolve it |
| `obsolete` | upstream now contains the change; consider Remove |
| `disabled` | files are restored to vanilla bytes |

Rollback semantics:

- Does: point the patch back to a previous stored version. Files become byte-exact to what they were before (vanilla or the other version) at the next omlx restart. Disable and Remove likewise restore pristine vanilla bytes, unwinding every applied version's backups newest-first.
- Does NOT: install, downgrade or pin omlx. If a keg upgrade moved the code under your patch, the patch is marked `needs_review`, never forced.

When upstream merges the PR, "Check for updates" reports the patch as obsolete (all hunks already present). The honest response is Remove, which restores vanilla bytes.

CLI control, per patch or global:

```bash
omlx-uplift patch status               # JSON view of manifest + verification
omlx-uplift patch add ID --pr repo/N   # or --url U | --file F, optional --scope
omlx-uplift patch enable ID            # --approve once|always if safeguards fire
omlx-uplift patch disable ID           # one patch off, files revert to vanilla
omlx-uplift patch remove ID
omlx-uplift patch apply                # reconcile now (no re-exec)
omlx-uplift patch check                # re-fetch sources, report drift
omlx-uplift patch curated [--sync]     # published catalog (see curated_patches/)
omlx-uplift patch promote ID           # accept the newest validated candidate
omlx-uplift patch rollback ID [--to-v N]  # undo a promote: previous stored
                                       # version becomes desired again
omlx-uplift patch approve ID --approve once|always  # safeguard approval only
omlx-uplift patch update-all           # re-check + adopt every online source
omlx-uplift patch enable-all           # twin of disable-all: sentinel gone,
                                       # flags restored to what it recorded
```

`patch curated --sync` installs the catalog: default tier enabled, optional tier installed but off. Opening the PATCHES page runs the same sync once. Re-sync never overwrites your decisions.

Kill switches (both mean: boot pristine vanilla, manifest untouched, verify-only, no writes):

```bash
OMLX_UPLIFT_NO_PATCHES=1 omlx serve    # env kill switch, one launch
touch ~/.omlx/uplift/patches.disabled  # sentinel, until removed
omlx-uplift patch disable-all          # sentinel + disable every patch
```

If a patch set wedges boot, use a kill switch, fix the manifest by hand (it is plain JSON), run `patch enable-all`, start again. `disable-all` and `enable-all` touch only the manifest and the sentinel, so they work even when this python cannot see an omlx package at all - which is the case they exist for.
