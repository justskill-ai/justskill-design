# skill-design

Design web pages as a **validated HTML file with inline CSS**, then fine-tune
them on a local canvas.

A skill, not a product: no MCP server, no app to install, no account, no build
step, no `npm install`. Node 18 or newer, built-in modules only.

```
design.html  ──validate──▶  diagnostics       (what is wrong, and what to write instead)
     ▲          format   ──▶  canonical text    (one intent, one spelling)
     │          export   ──▶  a deliverable      (one page, or a whole site)
     │
     └──── canvas ◀── add / set / remove / move / rename
```

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

## The format, in one screen

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

- `docs/format-v3.md` — the frozen contract: the element model, the canonical
  form, the diagnostic codes, the module boundaries.
- `references/styling.md` — the 45 allowed properties and their value grammars.
- `references/schema.md` — the element contract, generated from the format table.

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

### The write funnel

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

### The receipt

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

## Tests

```sh
npm test          # node --test "test/*.test.mjs"
```

What the suite pins, in order of what breaks first if it fails:

| Suite | Invariant |
|---|---|
| `byte-fidelity` | Parse then serialize returns the same bytes, for hand-written files, real files, comments, unknown tags and `<svg>` geometry |
| `table` | One table drives validation, normalization and hints; every property has a value grammar |
| `validate` | Every element is either valid or gets a diagnostic that names a fix |
| `normalize` | Normalization is idempotent and never touches a canonical file |
| `ops`, `fragment` | Ops are invertible; a fragment is compiled, checked and refused with a named reason |
| `cli` | Exit codes 0/1/2 are stable across success and refusal paths |

## Measured today

| Metric | Threshold | Measured |
|---|---|---|
| First-response legibility (20 real snippets) | ≥ 80% | **20/20 = 100%** |
| Silent drops | 0 | 0 |
| Serialization round trip | byte exact | byte exact, 11 fixtures including a 73 KB generated design |
| Normalization | idempotent | idempotent |
| `.pen` import | 0 errors, empty `unmapped` | **0 errors, `unmapped` empty** |
| `.pen` import ledger | every loss named | 1 loss in 1541 nodes (`perCornerRadius`) |
| pen's own export | the same picture | text line boxes and the arrow's four corners within 0.1px, `viewBox` and font identical |
| Tests | — | 651 pass, 0 fail |

The `.pen` acceptance case is a real 705 KB file with 26 artboards and 1541
nodes. It imports to 1515 elements — the ledger counts the nodes that became a
design node, so the 26 artboards are not in that number — plus 23 components,
239 instances and 140 instances carrying overrides, in about 60 ms. The result
validates and is already canonical: `examples/miniprogram.html` carries 1541
`data-id`s (the 1515 elements and the 26 pages) and 1754 tags in all, the rest
being `<svg>` geometry and wrappers that are not design nodes. One node in that
file has four different corner radii, which this format does not have a spelling
for, and the ledger says so by name.

The import is measured against pen's own export, not against itself. The welcome
document pen ships — one 1000×1458 artboard, two text lines, one rotated arrow —
was exported from pen.dev as HTML and imported here, and the two renderings were
measured in the same browser: the text's two line boxes agree to 0.05px
(224.00/551 against 224.05/550.91, and 101.39/796.20 against 101.42/796.16), the
font is the same Noto Sans face pen's export links (`measureText` 599 against
598.9), and the arrow's four drawn corners land within 0.1px of where pen's
`transform: rotate(45deg)` puts them. That measurement is why the reader measures
a glyph's own box for its `viewBox`, draws a stroked outline as a stroke rather
than a `border` on its `<svg>`, bakes a rotation into the outline, keeps an
authored line break as `white-space: pre-line`, and asks for `Noto Sans` instead
of assuming the machine has it.

The legibility metric means: the first response is always usable, whether it
accepts the snippet or refuses it with a code, a target and a fix. The 20
snippets are the ones a model actually writes: `display:grid`, `position:fixed`,
`rgba()`, `#fff`, a one-sided `margin`, a missing `alt`, a wrong `data-type` for
the tag, a duplicate id, a `font` shorthand, a `<svg>` written by hand.

**10 are refused by name. The other 10 compile, and 9 of those report what they
rewrote or dropped** — `#fff` becoming `#ffffff`, a four-value `padding`
collapsing, a `cursor` or a `transform` landing in `dropped`. One is already
clean. A crash, a silent drop, or a refusal that names nothing fails the metric.
It does not claim that 100% of designs are accepted; it claims that no first
response is a dead end. `evals/evals.json` states per snippet what that response
has to contain, and `test/evals.test.mjs` checks it.

## Install

```sh
git clone <this repo> ~/Developer/skill-design
node scripts/install.mjs
```

That links the repository into `~/.agents/skills/skill-design` and
`~/.claude/skills/skill-design`.

## Scope

Not a general HTML and CSS tool. It supports a closed set: flexbox layout,
absolute positioning, a fixed property whitelist, images, inline SVG glyphs, and
one run of text per text element. No grid, no `position:fixed`, no transforms, no
animation, no responsive breakpoints, no rich text. The reasons are in
`docs/plan.md`, and the value grammar for every allowed property is in
`references/styling.md`.

## Credits

`test/fixtures/real/open-design-components.html` is a copy of a fixture from
[OpenDesign](https://github.com/nexu-io/open-design) (Apache-2.0), kept as a
real-world parse case.
