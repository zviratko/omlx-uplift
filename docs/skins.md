# Writing an Uplift skin

A skin is a single YAML file that re-themes the whole Uplift dashboard —
colors, fonts, icons, optional webfonts and arbitrary overlay CSS. No
Python, no JavaScript, no rebuild, no restart: drop the file in the skins
directory and the dashboard picks it up on the next refresh.

Skins are *additive*: they never replace the built-in themes, and a broken
skin never breaks the page (see [Failure posture](#failure-posture)).

## Where skins live

One scan root per runtime:

```
~/.omlx/uplift/skins/          # production omlx
~/.omlx-dev/uplift/skins/      # the omlx-dev runtime
```

The directory holds two kinds of entries:

* **Crates you drop in** — `<name>.yml`. Extracted automatically into a
  working copy `<name>-<mtime>/` on the next scan.
* **Working copies** — `<name>-<stamp>/` directories. This is the serving
  source of truth: `skin.yml` (crate verbatim), `overlay.css`, and the
  extracted `icons/` and `fonts/` files. A working copy is **never
  overwritten** after creation, so you can hand-edit it and the edits
  survive every refresh.

Uplift also ships example skins. The server unpacks them at startup into
hidden `.bundled-<name>-<stamp>/` working copies. **A user crate or working
copy of the same base name shadows the bundled skin** — the supported way
to customize an example is to copy its crate into your skins dir and edit
it. Your own files are never deleted by updates; only superseded
engine-owned `.bundled-` copies are pruned.

Name rule: `[a-z0-9][a-z0-9-]*` (lowercase, digits, hyphens). The file is
`<name>.yml`, and the theme picker shows the `label` you choose.

## The crate format

```yaml
skin_version: 1
label: "My Skin"

classic:              # how embedded classic pages (Bench/Chat) are mapped
  theme: dark         #   light | dark — optional, derived from --bg otherwise
  enhanced: false     #   optional

tokens:               # the palette — see the whitelist below
  bg: "#0b0e13"
  card: "#11151c"
  ink: "#d7dce4"
  accent: "#5ac8fa"
  # ...

icons:                # inline SVG, readable block scalars
  caret.svg: |-
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">...</svg>
  logo-dot.svg: |-
    <svg ...>...</svg>

fonts:                # optional webfonts; base64 or verbatim text
  OFL.txt: |-
    <licence text — required when you ship a font file>
  myfont-400.woff2: "base64dataBase64data..."

css: |-               # optional overlay CSS, see below
  .card { border-style: double; }
```

Unknown top-level keys are ignored (forward compatibility). `css` may also
be omitted for a pure token skin — tokens alone already re-theme every
surface on the board.

### Tokens

Only whitelisted names compile; anything else is skipped with a warning.

| kind | names |
|---|---|
| color (21) | `bg` `card` `row2` `field` `panel` `edge` `ink` `dim` `accent` `chart-1` `chart-2` `grid` `heat` `frame` `red` `good` `warn` `bad` `hdr-ink` `hdr-edge` `hdr-hover` |
| font (2) | `mono` `sans` — CSS font stacks |
| weight (1) | `hdr-weight` — `normal`, `bold`, or `100`–`900` |

Colors accept `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`, `rgb()/rgba()/hsl()/hsla()`
and named colors. The grounds you will set in almost every skin are
`bg` (page), `card`, `row2` (alternating rows), `field` (inputs), `panel`,
`edge` (borders) and the inks `ink` (text) / `dim` (secondary text).
`good` / `warn` / `bad` / `red` carry status semantics — keep them
distinguishable from each other, charts and badges depend on it.

### Icons

Exactly four basenames are wired into CSS variables: `caret`, `close`,
`logo-dot`, `grip` (as `icons/caret.svg` etc., `--icon-caret`, ...). Any
*other* file under `icons/` is still served — use that for scene art and
reference it from your overlay CSS with a **relative** URL:

```css
.card::before { background-image: url("res/icons/my-cat.svg"); }
```

Relative `res/...` paths are required so the crate works both as a user
file and as a bundled working copy. A typo in a `res/` path fails
silently — the icon simply never appears. Double-check spelling.

### Fonts

Files declared under `fonts:` land in the working copy's `fonts/`
directory and are served at
`/uplift/api/skins/<dir>/res/fonts/<file>`. Nothing is wired in
automatically — declare `@font-face` in your overlay CSS and point the
`mono`/`sans` tokens at the family:

```css
@font-face { font-family: 'My Mono'; font-style: normal; font-weight: 400;
  src: url('res/fonts/myfont-400.woff2') format('woff2'); }
```

If you ship a font file, ship its licence text alongside it in the crate
(`fonts/OFL.txt` for OFL fonts) — a bundled test enforces this.

### Overlay CSS

The engine wraps everything you write — but only what you write — in a
scope selector, so plain selectors are correct:

```css
/* you write */        /* engine serves */
.card { ... }   -->    :root[data-theme="<dir>"] .card { ... }
```

Set `html { color-scheme: dark; }` (or `light`) to match `classic.theme`
so native scrollbars and form controls follow the skin.

## Rules the engine cares about

**Motion.** The dashboard has a global motion switch that sets
`html[data-motion="off"]`. It only force-kills the base CSS's own animated
classes, so **every `@keyframes`, `animation` or `transition` in your
overlay must be gated** behind `:root:not([data-motion="off"])` —
otherwise the switch lies and your skin keeps moving:

```css
@keyframes blink { 50% { opacity: .2 } }
:root:not([data-motion="off"]) .card::before { animation: blink 2s infinite }
```

(`@keyframes` bodies may live ungated; the *selectors that apply the
animation* must be gated. The engine warns in the skin listing when this
is violated — warnings are advisory, not fatal.)

**Size caps.** Crate ≤ 1 MB, one resource ≤ 512 KB, extracted working
copy ≤ 8 MB.

**Header text slots.** `.logo::after` is capped at 24 characters with an
ellipsis by the engine; longer strings go in `.logo .logo-below::after`
(max-width 260 px, ellipsized — at 9 px mono, ~50 characters fit).

## Authoring workflow

1. **Start from an example.** The crates in
   [`omlx_uplift/skins-example/`](../omlx_uplift/skins-example) in the
   repo (and unpacked under `.bundled-*` in your skins dir) cover the
   range: `night-watch.yml` is a minimal light token skin, `shodan.yml`
   is the full showcase (icons + webfonts + heavy overlay CSS). Copy one
   and change the label first so you never confuse it with the original.
2. **Drop it in the skins dir.** `~/.omlx/uplift/skins/myskin.yml`.
   Refresh the dashboard; *My Skin* appears in the header theme picker,
   previewed on hover, committed on click.
3. **Iterate on the working copy or the crate.** Hand-editing
   `myskin-<mtime>/overlay.css` shows up on refresh without re-extraction
   (the CSS cache keys on that file's mtime). When happy, fold the edits
   back into the crate with `omlx-uplift skin compile`:

   ```bash
   omlx-uplift skin compile ~/.omlx/uplift/skins/myskin-1730000000 -o myskin.yml
   ```

   `compile` is deterministic and byte-identical round-trips resources;
   `omlx-uplift skin decompile myskin.yml` does the reverse (extracts a
   working copy, never overwriting an existing one).
4. **Ship it.** A skin is just a file — send people the `.yml`. To bundle
   a skin into uplift itself, drop the crate into
   `omlx_uplift/skins-example/` in the repo; it ships as package data and
   appears on every install at the next server start.

## Failure posture

Nothing a bad skin does can take the page down:

* malformed YAML, a newer `skin_version`, or an oversized crate → the
  whole skin is skipped, with the reason shown in the picker listing
  (`stale` / `yml_newer` hints included);
* one bad token key or value → that token alone is skipped with a warning,
  the rest of the skin loads;
* an undecodable resource → skipped individually.

So a skin that "does nothing" usually means one of: a syntax error in the
YAML (check the listing for the reason), a typo'd token name (silently
unstyled — validate against the whitelist), or a typo'd `res/` path.

## Checklist before shipping

- [ ] `skin_version: 1`, lowercase-hyphen crate name, meaningful `label`
- [ ] every token key is in the whitelist, every value parses as its kind
- [ ] `classic.theme` declared and matches `--bg`
- [ ] every animation/transition gated on `[data-motion]`
- [ ] all `url('res/...')` references resolve to files the crate ships
- [ ] fonts ship their licence
- [ ] overlay sets `color-scheme`
- [ ] it loads via drop-in and renders sensibly at both wide and ~1000 px
      windows, with charts, badges and the model editor open
