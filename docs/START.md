# Start here

Entry point for every agent session that maintains omlx-uplift, for any model.
Machine-specific facts (hosts, paths, the live board's settings) are NOT in this
public repo: they are in the agent's private notes/skills on each machine. If those
disagree with what you find on the box, say so and ask before relying on either.

## 1. Read

1. `docs/HANDOFF.md`: current state, open work, hazards (never drop them), pitfalls.
2. `docs/DECISIONS.md`: owner decisions. To change one, add a new row; never edit an
   old row silently.
3. `tickets/in/`: open items the owner wants kept. `tickets/out/`: started, unfinished.
4. For the area you touch: `README.md` (user view), `docs/patches.md`,
   `docs/dev-builds.md`, `docs/development.md` (test commands),
   `curated_patches/README.md`, and the `<patch>.md` notes next to a curated patch.

## 2. Choose the work

1. A ticket in `tickets/out/`: finish it.
2. The owner's request in this session. If it cannot be done now, write a ticket in
   `tickets/in/` (format in `tickets/README.md`).
3. A ticket in `tickets/in/` only when the owner asks for it.

## 3. Rules while you work

- `main` on GitHub is the only branch. Commit and push to it after verified changes.
  Publishing user-visible artifacts elsewhere (upstream PRs, releases) needs the
  owner's go.
- Gates before every push: `node --test tests/*.cjs` and `pytest tests -q` (see
  `docs/development.md` for the interpreter). Then check that CI on the pushed commit
  passes. Report a status as done or passing only when a tool result proves it.
- The repo is public. Never commit hostnames, IP addresses, user names, home paths or
  secrets. Grep the diff before you commit.
- Commit messages: no attribution footer (owner decision D2).
- Live board tests: back up settings and every file you replace first, restore
  afterwards and prove it (`cmp`, a diff of the settings against the backup). A test
  that can push memory must have a SERVER-side guard (see HANDOFF pitfalls).
- If a result changes a decision, stop and report before you change direction.

## 4. Finish every session

1. Update `docs/HANDOFF.md` (state, open work, hazards, pitfalls) and
   `docs/DECISIONS.md` (new owner decisions, same session).
2. Tickets: `git mv` `in/` -> `out/` when you start one; write its `Result` and
   `git mv` it to `done/` when finished, in the same commit as the work.
3. Commit, push, CI green, `git status` clean (stray reports go outside the repo).
4. Leave no background processes and no board in a test state.
5. Report in a few lines: what works, what does not, what the owner must do.
