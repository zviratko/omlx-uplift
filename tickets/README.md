# Tickets

| Directory | Meaning |
|---|---|
| `in/` | open: owner requests or items to keep but not do now |
| `out/` | in progress: an agent took it (move with `git mv` when you start) |
| `done/` | finished, with a filled `Result` section |

File name: `NNNN-short-name.md`, next free number across all three directories.
Move a ticket with `git mv` in the same commit as the work.

Template:

```
# NNNN Short title

## Request
What and why, in the owner's words where possible.

## Done when
Checks a reviewer can verify.

## Result
(filled in when done: what changed, commits, what was verified, what was not)
```
