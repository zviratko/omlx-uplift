# Curated patches

Ready-made uplift patches, consumed by the omlx-uplift dashboard
(Patches / dev → "Curated patches") and by
`omlx-uplift patch curated [--sync]`.

Layout — exactly two tiers:

    default/    installed ENABLED by default (applied automatically)
    optional/   installed but NOT enabled (present, one click away)

Each patch is a pair of files:

    <name>.diff   the patch itself (git diff, omlx-package-root paths)
    <name>.md     manifest (REQUIRED): a short description of the
                  purpose. A .diff without its .md is skipped.

The manifest may carry one optional frontmatter line to pin the patch
scope (`omlx` = vanilla keg overlay, `dev` = omlx-dev build only,
`both`); without it the scope is auto-classified like a manual add.

A sync never overwrites local decisions: once installed, a patch keeps
its enabled flag; the normal drift check keeps its content fresh.
Patches that upstream later merges are auto-marked obsolete.
