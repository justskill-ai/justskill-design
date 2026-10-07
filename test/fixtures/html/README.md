# html fixtures

Every fixture below must satisfy `serialize(parse(text)) === text` byte for byte
with no edit applied (format-v3 §5.1, byte fidelity). "Must validate clean" is the
contract expectation; the third column also records what `node design.mjs validate`
actually reports today, so a mismatch is visible instead of assumed.

| fixture | what it pins | must validate clean |
|---|---|---|
| `simple.html` | The baseline shape: one `section[data-type="page"]`, a `frame` holding a `frame` holding two `text` nodes, and the tokens block (`:root{…}`) and the page-frame block (`section[data-type="page"]{…}`) in **two separate `<style>` elements in `<head>`** — §4.1 requires both blocks to be collected and merged, never one overriding the other. | **yes — clean today** (0 errors, 0 warnings; both blocks reported as `tokens+page-frame`) |
| `entities.html` | Text decoding: named (`&amp; &lt; &gt; &nbsp;`), hex (`&#x4e2d;`), decimal (`&#25991;`), a bare `&` that is not an entity (`AT&T`, `a&b`), a double-escaped `&amp;amp;`, and a literal `<<<` and `><` in text that must not start a tag. Pins that `text.value` is decoded while `text.raw` stays byte-identical. | **yes — clean today** |
| `comments.html` | Comment positions: in `<head>` (before, between and after the two `<style>` blocks), in `<body>` before the first page, **inside a frame** before/between/after its children, between two pages, just before `</body>`, and after `</body>`. Also `--` inside text that is not a comment. Pins that comments are opaque bytes, are never reordered, and never enter the design tree. | **yes — clean today** |
| `svg-icon.html` | `data-type="icon"` on an `<svg>` carrying `data-icon` + `data-icon-library`, whose children are `<title>`, `<circle>` and `<path>` and must survive untouched (§2 opaque layer). Also a second `<svg>` whose `style` attribute is single-quoted and contains `url("data:image/svg+xml;base64,PHN2Zy8+")` — a `;` inside quotes inside a `;`-delimited declaration list — plus the same quoted-`;` shape inside the head page-frame rule. | **no — blocked by a contract conflict.** §3 says `icon` cannot carry children; §2 says `<svg>` internals are the opaque layer. Today's validator takes the §3 reading and reports `structure/children-not-allowed` ×2 plus `structure/unsupported-tag` ×4 for the `<circle>`/`<path>`/`<title>` nodes. This fixture is unfixable until the Lead decides which rule wins — that is its purpose. |
| `data-uri.html` | The §4.2 four-state declaration scanner: `;` inside a double-quoted string (`url("data:image/svg+xml;base64,AAA")`), inside a single-quoted string (`url('a;b.svg')`), inside **parentheses only** (`url(data:image/svg+xml;base64,AAA)`), and inside a quoted `font-family` value (`"Foo;Bar", "Baz;Qux"`). All four shapes appear in element `style` attributes, in the `:root` tokens block, and in the page-frame rule. A naive `split(";")` splits every one of them. | **no — 1 error today, and it is a doc conflict.** The scanner passes all four shapes (verified directly against `parseDeclarations`). The single error is `content` on `hero__caption`: §4.2 names `content:"a;b"` as an example of a value whose `;` is legal, but `content` is not in `CSS_ALLOWED`, so that example can never appear in a valid file. Either the property joins the table or the §4.2 wording drops the example. |
| `quotes.html` | Attribute syntax: values in single quotes (`data-id='quotes__card'`), double quotes, and unquoted (`data-name=Quotes`, `data-canvas=0,0`, `style=font-size:12px`); attribute names in mixed case (`DATA-ID`, `DATA-TYPE`, `data-HIDDEN`, `data-Name`); a self-closing `<img/>` that still satisfies the `image` contract (`src` + `alt`); and `data-hidden` written both as `data-hidden="true"` and bare — §8 text-layer normalization rewrites the bare form to `data-hidden="true"`. | **yes — clean today.** Mixed-case attribute names are matched ASCII case-insensitively, which format-v3 never states; this fixture is what pins that reading. |
| `unknown-tag.html` | §2.1, the failure mode the parser must plug: a `<canvas data-x="1">` and a `<pre>` that are neither design layer nor opaque layer. The `<pre>` holds real newlines, a raw `<` and `>` in text (`gap < 16 && gap > 4`), a `;`, and an escaped `&lt;div&gt;` inside a string. The parser must keep every byte, the validator must report `structure/unsupported-tag`, and the serializer must **never** rewrite the inside of either element. | **no — 2 errors, exactly the two designed ones** (`structure/unsupported-tag` for `<canvas>` and `<pre>`). The bytes survive; that is the point. |
| `crlf.html` | Byte-identical to `simple.html` except that every line ends `\r\n` and the file has **no trailing newline** (24 CRLF, 0 bare LF, 1241 bytes). Pins that offsets, line/column mapping and `source.slice(start, end)` work on CRLF, that the parser does not silently normalize line endings, and that §8's LF unification is a normalization step and not a parse-time side effect. | **yes — clean today** |

Two contract gaps these fixtures expose, both left in place on purpose:

1. **`icon` children vs. `<svg>` geometry.** §3 marks `icon` as childless; §2 puts
   `<svg>` internals in the opaque layer, which is never validated. Every real
   lucide icon is an `<svg>` with `<path>` children, so the two rules cannot both
   hold. `svg-icon.html`, `test/fixtures/real/pen-pages.html` and snippet `s16`
   all depend on the answer.
2. **Attribute-name case and bare booleans.** format-v3 never says whether
   `DATA-ID` matches `data-id`, nor whether a bare `data-hidden` counts as
   `"true"`. `quotes.html` currently passes under the permissive reading
   (case-insensitive match, bare boolean = true), so the permissive reading is
   what the implementation chose — it should be written into the doc.
