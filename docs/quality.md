# Quality

中文版：[docs/zh/quality.md](zh/quality.md)

What the test suite holds fixed, and what the measurements say today. The
product view is in the README; the engineering view of the format is in
`docs/how-it-works.md`.

## Tests

```sh
npm test                # node --test
npm run images:check    # needs the network: every catalogue URL still resolves
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
| `images` | Every catalogue row is a unique, copyable URL with what the photo shows and who took it |

Two more guards keep the documents honest: `test/product-flow.test.mjs` compares
the nine-stage route in `SKILL.md`, `references/product-flow.md` and
`docs/paradigm.md`, and checks both READMEs link to the essay;
`test/skill-doc.test.mjs` compares the property count and the margin rules in the
hand-written documents against `lib/table.mjs`.

## Measured today

| Metric | Threshold | Measured |
|---|---|---|
| First-response legibility (20 real snippets) | ≥ 80% | **20/20 = 100%** |
| Silent drops | 0 | 0 |
| Serialization round trip | byte exact | byte exact, 11 fixtures including a 73 KB generated design |
| Normalization | idempotent | idempotent |
| `.pen` import | 0 errors, empty `unmapped` | **0 errors, `unmapped` empty** |
| `.pen` import ledger | every loss named | 1 loss in 1541 source nodes (`perCornerRadius`) |
| pen's own export | the same picture | text line boxes and the arrow's four corners within 0.1px, `viewBox` and font identical |

The `.pen` acceptance case is a real 705 KB file with 26 artboards and 1541
source nodes. It imports to 2197 elements in about 100 ms: 239 references are
inlined, and 140 of them carried field-level patches that are applied during the
import. The ledger counts emitted elements, so the 26 artboards are not in that
number and the copies are. The result validates and is already canonical:
`examples/miniprogram.html` carries 2223 `data-id`s (the 2197 elements and the 26
pages) and 3066 tags in all, the rest being `<svg>` geometry and wrappers that
are not design nodes. One node in that file has four different corner radii, a
shape this format does not have a spelling for, and the ledger says so by name.

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

## The legibility metric

The metric means: the first response is always usable, whether it accepts the
snippet or refuses it with a code, a target and a fix. The 20 snippets are the
ones a model actually writes: `display:grid`, `position:fixed`, `rgba()`, `#fff`,
a one-sided `margin`, a missing `alt`, a wrong `data-type` for the tag, a
duplicate id, a `font` shorthand, a `<svg>` written by hand.

**10 are refused by name. The other 10 compile, and 9 of those report what they
rewrote or dropped** — `#fff` becoming `#ffffff`, a four-value `padding`
collapsing, a `cursor` or a `z-index` landing in `dropped`. One is already clean.
A crash, a silent drop, or a refusal that names nothing fails the metric. It does
not claim that 100% of designs are accepted; it claims that no first response is
a dead end. `evals/evals.json` states per snippet what that response has to
contain, and `test/evals.test.mjs` checks it.
