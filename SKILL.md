---
name: skill-design
description: >-
  Design and edit web pages as a validated HTML file with inline CSS, then
  fine-tune them on a local canvas. Use this skill whenever the user wants to
  design, mock up, wireframe, redesign or restyle a web page, app screen, or
  mobile screen — a landing page, dashboard, settings page, pricing page, empty
  state, onboarding flow, component library, or any layout built from frames,
  text, images and icons — or wants to change the spacing, colour, typography or
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
- Change it with `set`, `add`, `remove`, `move`. Never rewrite the whole file to
  change one value: an op is one undo step, and a rewrite is an afternoon of
  lost work for the user who has the canvas open.
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

# 4. Check. Always.
node design.mjs validate design.html --json
node design.mjs format design.html --check    # is the file in canonical form?

# 5. Hand over deliverables, or let the user drag.
node design.mjs export design.html --all -o dist          # HTML, one file per page
node design.mjs export design.html --format svg -o page.svg
node design.mjs export design.html --format png --scale 2 -o page.png
node design.mjs serve design.html
```

`add` reads a fragment from `--html-file` or `--html -` (stdin). Prefer a file
or stdin: a fragment inside shell single quotes breaks on the first apostrophe.

## Reading a receipt

Every write prints what it did. You cannot see the file, so read this:

```
added:      home__cta, home__cta-label  (2 elements)
normalized: #fff → #ffffff
normalized: 12px 12px 12px 12px → 12px
dropped:    margin:16px — The format spaces elements with gap, never with margin.
            use gap (on the parent) or padding (on this element)
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
| `margin` | `gap` on the parent, or `padding` on this element |
| `display:grid` | `display:flex` with `flex:1` on the children |
| `position:fixed` | `position:absolute` with `left` and `top` |
| `#fff`, `rgba(...)` | six or eight digit hex: `#ffffff`, `#00000080` |
| `cursor`, `transform`, `transition` | nothing. This format describes appearance, not behaviour |
| a missing `alt` | `alt=""` for a decorative image. Missing is not the same as empty |
| a duplicate `data-id` | the hint names a free id, such as `home__a-2` |

## What the format is, and is not

Supported: flexbox layout, absolute positioning, a fixed set of about 40 CSS
properties, images, inline SVG icons, design tokens, components and instances,
text in one run per text element.

Not supported, and refused by name rather than ignored: grid, `position:fixed`,
transforms, animation, responsive breakpoints, rich text inside one text
element, and any property outside the table.

The full property list, with the accepted values for each, is in
`references/styling.md`. The element contract is in `references/schema.md`.
Read one of them before writing a big fragment; they are short, and they prevent
most refusals.

## Components

A component is a `div` with `data-type="component"`, living in a page marked
`data-library="true"`. An instance points at it:

```html
<div data-id="home__card" data-type="instance" data-ref="card"
     data-overrides='{"card__title":{"content":"你好","style":"font-size:20px"}}'></div>
```

The file stores only the reference. The component's markup reaches the export
and the canvas through the instance. Edit the component once and every instance
follows; override one field and only that field is pinned.

**Editing a descendant id is editing the component.** In an imported pen file,
`card__title` appears once, in the library, and 239 instances point at it. That
is the point — one edit reaches every instance. When the user wants to change
one instance instead, write `data-overrides` on that instance:

```sh
node design.mjs set design.html home__card --attr   'data-overrides={"card__title":{"style":"font-size:20px"}}'
```

The canvas can select and edit the component, but it cannot yet write an
override for one instance. Tell the user that rather than letting them believe a
drag changed only one card.

## The canvas

```sh
node design.mjs serve design.html
```

Prints a URL and opens it. The user drags; changes go through the same funnel as
your commands, so a drag cannot write something `validate` would refuse. If a
drag is refused, the canvas shows what it would have introduced.

Close the tab and the service exits. The user can also `set` from the command
line while the canvas is open: both writers re-read the file first.

## Rules that save you a round trip

1. **Run `validate` when you are unsure.** It is faster than guessing, and it
   tells you the exact offset and the exact fix.
2. **Never edit `data-id` with `set`.** Use `rename` when it exists, because an
   id is an address and other elements may point at it.
3. **Do not add a `<style>` block** for a one-off value. Only the two allowed
   blocks are read; a third is an error.
4. **Do not write `margin`.** Spacing is `gap` and `padding`. This is the single
   most common refusal.
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

## Working with a `.pen` file

```sh
node design.mjs import pen design.pen -o design.html
```

One direction only: pen in, design file out. Every run prints a ledger:

```
26 pages · 1515 elements · 23 components · 239 instances · 140 with overrides · lost: perCornerRadius×1
```

`lost` names what this format has no spelling for. Read it and tell the user,
rather than letting them find out on the review screen. `--report r.json` writes
the whole ledger.
