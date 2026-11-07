# How it works

中文版：[docs/zh/how-it-works.md](zh/how-it-works.md)

The README tells you what this is and who it is for. This document is the
engineering view: what the design file is, what the CLI does to it, how the
canvas edits the same file, and what the tool deliberately leaves out.

## Why the design file is HTML

A model already writes HTML and CSS well. Asking it to write a private JSON
document instead spends its attention on a format it must first learn, and every
one of those files needs a renderer before anyone can look at it.

So the design file is the markup. It is a valid, self-contained HTML file: open
it in a browser and the design is there. What this tool adds is not a format but
four guarantees:

| Guarantee | What it means |
|---|---|
| It is checked | Every element and every declaration is either accepted or reported. Nothing is dropped in silence. |
| It is editable | Every element has a `data-id`, so an edit is one byte range, not a rewrite. |
| It is canonical | One intent has one spelling. Diffs stay readable, round trips stay exact. |
| It is honest | A file that nobody edited comes back byte for byte. Your own formatting, your comments and your hand-written `<svg>` stay where you put them. |

The checking verbs and the canvas are two views of the same file:

```
design.html  ──validate──▶  diagnostics       (what is wrong, and what to write instead)
     ▲          format   ──▶  canonical text    (one intent, one spelling)
     │          export   ──▶  a deliverable      (one page, or a whole site)
     │
     └──── canvas ◀── add / set / remove / move / rename
```

## The format in one screen

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
  <section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;gap:16px;padding:24px">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:var(--color-ink)">你好</p>
    </div>
  </section>
</body>
</html>
```

Two style blocks are allowed in `<head>`, and both are read: the token block
(`:root`) and the page-frame block. Every element otherwise carries an inline
`style`. Every element carries `data-id` and `data-type`.

Where to read more:

- `docs/format-v3.md` — the frozen contract: the element model, the canonical
  form, the diagnostic codes, the module boundaries.
- `references/styling.md` — the allowed properties and their value grammars.
- `references/schema.md` — the element contract, generated from the format table.
- `references/images.md` — the verified Unsplash photos a page may use when the
  user has not supplied one, with what each photo shows and who took it.
- `references/product-flow.md` — the stage-by-stage playbook the agent follows
  from idea to code.
- `SKILL.md` — the instructions the agent reads on every trigger.

## Commands

```sh
node design.mjs new      design.html --name home --title Landing
node design.mjs validate design.html --json
node design.mjs format   design.html --check
node design.mjs ls       design.html --pages
node design.mjs show     design.html home__title
node design.mjs add      design.html --html-file card.html --in home__root
node design.mjs set      design.html home__title --style 'font-size:40px'
node design.mjs move     design.html home__card --index 0
node design.mjs rename   design.html home__card product
node design.mjs migrate  design.html
node design.mjs remove   design.html home__note
node design.mjs export   design.html --all -o dist
node design.mjs import   pen some.pen -o design.html
node design.mjs serve    design.html
```

`serve` prints a tokenised URL and opens the canvas. The canvas and the CLI
write through the same funnel, so a drag and a `set` cannot disagree.

Exit codes: `0` success, `1` refused or invalid, `2` unreadable or bad arguments.

## The canvas

The canvas is three columns: the layer tree on the left — every page with its
elements nested under it, opening closed, with expand-all and collapse-all in the
header and picking an element on the canvas opening the path down to it — the
design in the middle, and the selected element's own properties on the right,
grouped into sections and edited with the control its grammar asks for.

Hovering shows the container the pointer is standing on, solid, and that
container's direct children, dashed — a click selects the container, a
double-click steps into the dashed box under the pointer, and Escape walks back
up one rung. Every page carries its name in a pill above its top-left corner,
and that name is chrome rather than part of the drawing: it keeps its own size
and its own few pixels of air at every zoom, so it reads the same at 10% as at
100%.

Either side folds away with the button on the canvas edge or `⌘\` (the tree) and
`⇧⌘\` (the inspector), and either edge drags to resize. None of that is document
state: the panels remember themselves in the browser and never write a byte to
the design file.

## The write funnel

Every write goes through the same path, whether it comes from a command or from
the canvas:

1. read the file again — another writer may have changed it
2. validate it, so a pre-existing error is not blamed on this edit
3. compile the change into ops
4. apply the ops
5. validate again, and refuse unless the edit introduces **no new error**
6. normalize only the changed nodes, then write atomically
7. print a receipt

Step 5 is what makes a broken file repairable. A file may already have errors;
an edit may fix them; an edit may not add another one.

## The receipt

The model cannot see the file, so the receipt is what it has. Every declaration
is either consumed or reported:

```
$ node design.mjs add design.html --html-file card.html --in home__root
added:      home__cta, home__cta-label  (2 elements)
normalized: #fff → #ffffff
normalized: 12px 12px 12px 12px → 12px
normalized: rgba(0,0,0,0.6) → #00000099
dropped:    cursor:pointer — The format describes appearance, not interaction. A cursor is behavior.
applied 1 op, revision a161db2c (0 errors, 0 warnings)
```

A refusal is a result, not a failure, and it says what to write instead:

```
REFUSED  display: grid is not a value of display.
  Accepted: flex | block | none
design.html was not changed.
```

## Scope

Not a general HTML and CSS tool. It supports a closed set: flexbox layout,
absolute positioning, a fixed property whitelist, images, inline SVG glyphs, and
one run of text per text element. No grid, no `position:fixed`, no transforms
beyond a rotation, no animation, no responsive breakpoints, no rich text.

The reasons are in `docs/plan.md`. The value grammar for every allowed property
is in `references/styling.md`. The cost of that narrowness is real: some screens
cannot be drawn in this format, and the honest answer there is a different tool.

## Installing the skill from the checkout

The README installs the skill through the skills CLI. If you would rather keep
the checkout itself as the skill, link it in with the installer:

```sh
git clone https://github.com/justskill-ai/justskill-design.git ~/Developer/justskill-design
node ~/Developer/justskill-design/scripts/install.mjs
```

The repository is the skill, so the install is one symlink into the skills
directory your agent already reads. It links the checkout into
`~/.agents/skills/justskill-design` and `~/.claude/skills/justskill-design`, so
any agent that reads those directories picks it up; editing the checkout is the
update. `--uninstall` removes both links, and `--dry-run` prints what it would do.

## Quality

What the suite pins, and what today's measurements say, is in
`docs/quality.md`.
