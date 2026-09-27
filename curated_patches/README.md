# Curated patches

Ready-made uplift patches, consumed by the omlx-uplift dashboard
(Patches / dev → "Curated patches") and by
`omlx-uplift patch curated [--sync]`.

Layout — exactly two tiers:

    default/    installed ENABLED on sync (applied to omlx-dev builds)
    optional/   installed but NOT enabled (one click away)

Format — each patch is ONE manifest, `<name>.json`, shaped like a
store patch entry so it merges into the local manifest cleanly:

    {
      "description": "short purpose of the patch",   // required
      "source": {"kind": "github_pr", "repo": "jundot/omlx", "pr": 3765},
      "reversal": false,                             // optional
      "scope":    "omlx"                             // optional: omlx|dev|both
    }

`source` rules:

  * A feature that has an upstream PR links it — `github_pr`. The
    catalog never copies content a PR already owns; when the PR merges,
    the drift check marks the patch obsolete on its own.
  * No PR? Vendor the diff next to the manifest as `<name>.diff` and
    use `{"kind": "file"}` (or any `url`).

`scope` can be omitted — the gate auto-classifies it. `reversal: true`
for patches that UNDO a merged change (disable restores original bytes).

A manifest without a description or with an unusable source is listed
but skipped on sync — never installed half-declared.
