---
name: skill-design
description: >-
  Design and edit web pages as a validated HTML file with inline CSS, then
  fine-tune them on a local canvas. Use this skill whenever the user wants to
  design, mock up, wireframe, redesign or restyle a web page, app screen, or
  mobile screen — a landing page, dashboard, settings page, pricing page, empty
  state, onboarding flow, or any layout built from frames, text, images and
  icons — or wants to change the spacing, colour, typography or
  layout of an existing design, turn a design into deliverables, or bring in a
  `.pen` file. Also use it when the user asks for a visual editor for pages, a
  design file, design tokens, or wants to review or adjust a design someone else
  drafted. Prefer this over writing page markup by hand: the file is validated,
  every change is reversible, and the user can adjust the result themselves on a
  canvas without editing code.
compatibility: Node 18 or newer. No dependencies, no install step, no build.
allowed-tools: Bash(node:*), Read, Write, Edit
---

# skill-design

You write one HTML file with inline CSS. It is the design. This skill checks it,
lets you edit it one change at a time, and gives the user a canvas to drag.

Nothing installs, nothing logs in, no server runs in the background. Every
command is `node design.mjs <verb>`.

## The one rule

**The design file is the truth. Write it, do not rewrite it.**

- Write the file with `Write`. Give every element a `data-id` and a `data-type`.
- `format` rewrites a file into canonical form. Use it when a file came from
  somewhere else; do not use it to change a design.
- Change it with `set`, `add`, `remove`, `move`, `rename`. Never rewrite the whole
  file to change one value: an op is one undo step, and a rewrite is an afternoon
  of lost work for the user who has the canvas open.
- Run `validate` before you hand anything back.

If the user has the canvas open, you are not the only writer. `set` and friends
re-read the file first, so they never clobber the user's drag. A full-file
`Write` does.

## The file

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Landing</title>
  <meta name="design-schema" content="3.0">
  <style>:root{ --color-ink:#111827; --space-md:16px }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" data-name="Home" data-canvas="0,0" style="width:390px;height:844px">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;gap:16px;padding:24px">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:var(--color-ink)">你好</p>
    </div>
  </section>
</body>
</html>
```

Three things to notice, because they are the ones that get refused:

1. **Every element carries `data-id` and `data-type`.** `data-id` is unique in
   the whole file. `data-type` must match the tag.
2. **Exactly two `<style>` blocks, both in `<head>`:** the token block (`:root`)
   and the page-frame block. Everything else is inline in a `style` attribute.
3. **One file holds many pages.** A page is `<section data-type="page">`.

Run `node design.mjs new design.html --name home` for a starting file that is
already correct, and `node design.mjs show design.html home__title` to read one
element back.

## The workflow

```sh
# 1. Start from a valid file, or read what is there.
node design.mjs new design.html --name home --title "Landing"
node design.mjs ls design.html --pages
node design.mjs show design.html home__root

# 2. Add content. The fragment is plain HTML: the model's own language.
node design.mjs add design.html --html-file /tmp/card.html --in home__root

# 3. Change one thing at a time.
node design.mjs set design.html home__title --style 'font-size:40px;color:#111827'
node design.mjs set design.html home__title --text "Ship faster"
node design.mjs move design.html home__card --after home__title
node design.mjs remove design.html home__notice
node design.mjs tokens design.html ls
node design.mjs tokens design.html set color.accent '#7c3aed'
node design.mjs tokens design.html rm space.xxl

# 4. Check. Always.
node design.mjs validate design.html --json
node design.mjs format design.html --check    # is the file in canonical form?
node design.mjs migrate design.html           # only if validate asks for it

# 5. Hand over deliverables, or let the user drag.
node design.mjs export design.html --all -o dist          # HTML, one file per page
node design.mjs export design.html --format svg -o page.svg
node design.mjs export design.html --format png --scale 2 -o page.png
node design.mjs serve design.html
```

`add` reads a fragment from `--html-file` or `--html -` (stdin). Prefer a file
or stdin: a fragment inside shell single quotes breaks on the first apostrophe.

### Images

When a page has a place for a photograph — a hero, a card, a gallery, an avatar —
and the user has not supplied an image, fill it from `references/images.md`:
verified Unsplash URLs, grouped by what the photo shows. Choose by subject — a
hero wants a wide landscape, an avatar a face — and write the URL as it appears
there. `alt` says what a person would see; the credit goes in `data-credit`,
which never renders.

The user's own image always wins: a URL, a file, or an image inside the `.pen` is
never replaced. If no catalogue photo fits, a solid colour or a gradient scrim is
the honest placeholder — never a made-up URL, never a local path that does not
exist. The catalogue is hotlinked, so a design renders its photos only with a
connection.

### Tokens

A design token is the one thing in the file that is not an element, so no other
verb can reach it. Changing a brand color is **one op**:

```sh
node design.mjs tokens design.html set color.accent '#7c3aed'
```

- The name is `<group>.<name>`, or the file's own `--group-name` after a `--`:
  `tokens design.html set -- --color-accent '#7c3aed'`.
- The seven groups are `color`, `font`, `space`, `radius`, `size`, `shadow`,
  `border`. There is no eighth: `surface.warm` is refused, and so is a token
  file that already says `--surface-warm`.
- `space`, `radius` and `size` carry a unit. `set space.md 16` writes `16px` and
  the receipt says so; a value that is not a length is refused.
- A color is normalized to hex, so `red` becomes `#ff0000` in the file.
- A token may reference a token (`var(--color-ink)`). A cycle is refused.
- Never rewrite the file to change a token. That is the one thing this workflow
  exists to prevent, and the user may have the canvas open.

## Reading a receipt

Every write prints what it did. You cannot see the file, so read this:

```
added:      home__cta, home__cta-label  (2 elements)
normalized: #fff → #ffffff
normalized: 12px 12px 12px 12px → 12px
dropped:    cursor:pointer — The format describes appearance, not interaction. A cursor is behavior.
applied 1 op, revision a161db2c (0 errors, 0 warnings)
```

- `normalized` is not an error. It is the canonical form doing its job, and the
  file now holds the value on the right of the arrow.
- `dropped` means the file does **not** hold that declaration. If it mattered,
  write it again the way the message says.
- Nothing is ever dropped in silence. If a declaration is not in the file, it is
  in this receipt.

## Reading a refusal

```
REFUSED  display:grid — grid is not a value of display.
  Accepted: flex | block | none
design.html was not changed.
```

A refusal means the file is byte-identical to what it was. Read the hint: it
always names what to write instead. The common ones:

| Refusal | What to write instead |
|---|---|
| a one-sided `margin`, such as `margin-top` | the shorthand: `margin: 0 8px 0 0` |
| `display:grid` | `display:flex` with `flex:1` on the children |
| `position:fixed` | `position:absolute` with `left` and `top` |
| `#fff`, `rgba(...)` | six or eight digit hex: `#ffffff`, `#00000080` |
| `cursor`, `transform`, `transition` | nothing. This format describes appearance, not behaviour |
| a missing `alt` | `alt=""` for a decorative image. Missing is not the same as empty |
| a duplicate `data-id` | the hint names a free id, such as `home__a-2` |

## What the format is, and is not

Supported: flexbox layout, absolute positioning, a fixed set of 45 CSS
properties, images, inline SVG icons, design tokens, and text in one run per text
element.

Not supported, and refused by name rather than ignored: grid, `position:fixed`,
transforms, animation, responsive breakpoints, rich text inside one text
element, and any property outside the table.

The full property list, with the accepted values for each, is in
`references/styling.md`. The element contract is in `references/schema.md`.
Read one of them before writing a big fragment; they are short, and they prevent
most refusals.

## The canvas

```sh
node design.mjs serve design.html
```

Prints a URL and opens it. The user drags; changes go through the same funnel as
your commands, so a drag cannot write something `validate` would refuse. If a
drag is refused, the canvas shows what it would have introduced. Clicking the
empty canvas clears the selection; dragging it pans.

Picking is by rungs, not by depth: hovering outlines the container the canvas is
standing on (solid) and that container's direct children (dashed), and a click
takes the dashed box under the pointer — the child, not the deepest element
inside it. That is how a person selects a card without landing on the word in
it; they click again to go one rung deeper. Escape walks back up a rung.

The canvas has three columns: a layer tree (every page, its elements nested,
opening fully collapsed, with expand-all and collapse-all in the header — picking
an element on the canvas opens the tree down to it and selects that row), the
design, and the selected element's properties in sections. The right panel only ever shows properties the element already has —
it cannot add a declaration the file does not carry, so use `set` for that. Either
panel folds away with `⌘\` / `⇧⌘\` or the button on the canvas edge, and either
edge drags to resize; that state lives in the browser, never in the file.

Close the tab and the service exits. The user can also `set` from the command
line while the canvas is open: both writers re-read the file first.

## Rules that save you a round trip

1. **Run `validate` when you are unsure.** It is faster than guessing, and it
   tells you the exact offset and the exact fix.
2. **Never edit `data-id` with `set`.** It is refused, because an id is an
   address rather than a property. Use `node design.mjs rename design.html card
   product`, which is the one verb that changes what an element is called.
3. **Do not add a `<style>` block** for a one-off value. Only the two allowed
   blocks are read; a third is an error.
4. **Do not write a one-sided `margin`.** Spacing is `gap` and `padding`.
   `margin` itself is allowed, but only the shorthand: a one-sided `margin-top`
   and friends are refused, because they are a second spelling of the same
   intent. Offset an element with `margin: 0 8px 0 0`, never `margin-right`.
5. **Prefer tokens.** If `:root` has `--color-ink`, use `var(--color-ink)`
   instead of a literal. The user can then restyle the whole design in one edit.
6. **Small edits, in order.** Three `set` commands beat one rewrite, and each
   one is a step the user can undo.

## Deliverables, and which need a browser

| `--format` | Needs | Notes |
|---|---|---|
| `html` (default) | nothing | One page, or `--all` for a site. Self-contained. |
| `svg` | nothing | Wraps the page in `<foreignObject>`. A browser draws it; Figma, Illustrator and Sketch show an empty rectangle. |
| `png` `jpeg` `webp` | a Chrome-family browser, or the canvas | `--scale 1..3`, `--size WxH` |

The image formats find a browser already on the machine — no download, no
bundled Chromium. When there is none the export **fails** and names three ways
forward: install Chrome, Chromium or Edge, leave the canvas open, or use
`--format svg`. It never quietly writes a different format, because a different
format is a different deliverable.

Before any image export, make sure the fonts are declared. `export` adds the
stylesheet links itself from the families the page uses, and the browser waits
for them; a screenshot taken before a web font arrives is captured in the
fallback family, where the text wraps at different words and everything below it
moves.

The HTML deliverable takes the page's own `background-color` onto `<body>`. A
page covers its own box and nothing more, so a viewport taller than the page
shows what is behind it: left white, that is a colour the design never chose. A
page that states no colour, or states `transparent`, keeps a plain document.

## Working with a `.pen` file

```sh
node design.mjs import pen design.pen -o design.html
```

One direction only: pen in, design file out. Every run prints a ledger:

```
26 pages · 2197 elements · 239 references inlined · 140 with overrides · lost: perCornerRadius×1
```

`lost` names what this format has no spelling for. Read it and tell the user,
rather than letting them find out on the review screen. `--report r.json` writes
the whole ledger.

Four things the reader translates rather than copies, because the format has no
spelling for pen's version of them:

- **A glyph is measured.** A `path` node's outline is drawn on its own grid, and
  that grid becomes the icon's `viewBox` — pen's own export writes
  `viewBox="0 0 14 14"` on a 366×366 arrow. An outline whose box cannot be
  measured keeps the node's box, which is what every glyph in the reference file
  happens to have anyway.
- **A stroked outline is drawn as a stroke**, on the `<path>`, with
  `vector-effect: non-scaling-stroke` so the width stays the width pen drew.
  It is not a `border` on the `<svg>` — that is a ring around a box, not a
  drawing.
- **A rotation is baked into the outline** for a `path` node (the ledger counts
  `bakedRotation`), because the format has no `transform`. Any other rotated node
  is drawn upright and named in `lost.rotation`.
- **A line break the author placed survives** as `white-space: pre-line`. Written
  as a literal newline it is a space, and the line then wraps wherever the font
  puts it.

The ledger also counts what it rewrote: `themedVariables` (a themeable variable
takes the document's default theme, which is the entry with no `theme` of its
own), `hardBreaks`, `pathAsGeometry`, `bakedRotation`. A variable that cannot be
reduced to one value is left out of the token block and counted as
`lost.unresolvedVariable` — never written as the string `[object Object]`, which
is a value that validates and means nothing.

**A reference is inlined, because this format has no reference.** pen stores a
`ref` node and the master it points at; the reader copies the master's subtree in
where the reference stood. The copy's root keeps the reference's own id and
everything under it is renumbered as `<reference-id>__<its own id>`, which is why
an imported file has 239 more subtrees in it than the `.pen` had nodes. Four
things follow, and they are the ones to tell the user:

- Editing a copy edits that copy alone. The master is a separate element now, so
  a change meant for every card has to be made on each one — or on the `.pen`,
  which is where the sharing lives.
- `descendants` patches are applied during the import: the text, the size, the
  swapped glyph are all in the file, and nothing applies them later.
- A reference that names nothing is refused (`pen/unresolved-ref`), as is one
  inside a loop (`pen/ref-cycle`) or nested more than 16 deep (`pen/ref-depth`).
- Children on a reference node are not part of the master's subtree, so they are
  counted in `lost.refChildren` and not written.
