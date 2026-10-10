/**
 * An icon can be added through the documented path.
 *
 * `SKILL.md` tells the model to add content with `add --html-file`, and that the
 * fragment "is plain HTML: the model's own language". An `<svg>` is part of that
 * language, and `viewBox` is part of an `<svg>` — the validator has always
 * refused geometry without it (`structure/icon-without-viewbox`).
 *
 * But the fragment compiler filters attributes *by the format table*, and
 * `viewBox` was not in the table. So the attribute was dropped on the way in and
 * the whole `add` was then refused for the very thing that had just been
 * removed: an icon could not be added at all.
 *
 * Two things have to hold together, and this file pins both:
 *
 *   1. `viewBox` survives compilation, with its original spelling. The case is
 *      load-bearing: `export --format svg` emits real XML, where `viewbox` is
 *      not `viewBox` and the glyph silently loses its coordinate system.
 *   2. An icon with geometry and no `viewBox` is still refused. The fix must not
 *      turn the guard off.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../lib/parse.mjs";
import { compileFragment } from "../lib/fragment.mjs";
import { applyOps } from "../lib/ops.mjs";
import { serialize } from "../lib/serialize.mjs";
import { validateDesign } from "../lib/validate.mjs";
import { exportPage } from "../lib/export-html.mjs";
import { pageToSvg } from "../lib/export-svg.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** A file with the base rules stated, so a compile has nothing else to report. */
const DESIGN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Icons</title>
<meta name="design-schema" content="3.0">
<style>*,*::before,*::after{box-sizing:border-box}
*{margin:0}
img{display:block}
svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:root{ --color-ink:#111827 }</style>
<style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
<section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px;overflow:hidden">
<div data-id="home__slot" data-type="frame" style="display:flex;flex-direction:column;width:100%"></div>
</section>
</body>
</html>
`;

const WITH_VIEWBOX = '<svg data-id="home__bell" data-type="icon" data-icon="bell" data-icon-library="lucide" viewBox="0 0 24 24" style="width:24px;height:24px;color:#111827"><path d="M10.268 21a2 2 0 0 0 3.464 0"></path></svg>';

const NO_VIEWBOX = '<svg data-id="home__bell" data-type="icon" data-icon="bell" data-icon-library="lucide" style="width:24px;height:24px;color:#111827"><path d="M10.268 21a2 2 0 0 0 3.464 0"></path></svg>';

/** Compile a fragment into DESIGN and hand back everything worth asserting on. */
function compile(fragment) {
  const doc = parse(DESIGN);
  const result = compileFragment(doc, fragment, { in: "home__slot" });
  if (result.refused) return { result, next: null, text: null, diagnostics: [] };
  const { doc: next } = applyOps(doc, result.ops);
  // `next.source` is the text the parse saw and never changes; the file the op
  // produces is the diff between the two trees.
  return { result, next, text: serialize(doc, next), diagnostics: validateDesign(next) };
}

const codes = (diagnostics) => diagnostics.map((d) => d.code);

test("an icon fragment keeps its viewBox and is accepted", () => {
  const { result, text, diagnostics } = compile(WITH_VIEWBOX);

  assert.equal(result.refused, null, "the fragment must compile");
  assert.deepEqual(result.dropped, [], "nothing may be dropped");
  assert.deepEqual(result.added, ["home__bell"]);
  assert.deepEqual(codes(diagnostics), [], "and the result must validate clean");

  // The spelling, not just the presence: the XML deliverable depends on it.
  assert.match(result.ops[0].html, /viewBox="0 0 24 24"/, "the op carries the author's spelling");
  assert.match(text, /viewBox="0 0 24 24"/, "and so does the file");
  assert.doesNotMatch(text, /viewbox=/, "never the parser's normalized spelling");
});

test("geometry without a viewBox is still refused", () => {
  const { result, diagnostics } = compile(NO_VIEWBOX);

  // The refusal comes from the validator through the funnel, not from the
  // compiler: the compiler keeps the fragment's own words and the document is
  // judged as a whole.
  assert.equal(result.refused, null, "compiling is not where this is caught");
  assert.ok(
    codes(diagnostics).includes("structure/icon-without-viewbox"),
    `expected structure/icon-without-viewbox, got ${codes(diagnostics).join(", ") || "(none)"}`,
  );
});

test("viewBox survives into the SVG deliverable as XML", () => {
  const { next } = compile(WITH_VIEWBOX);
  assert.ok(next, "the fragment must compile");

  const { html, page } = exportPage(next);
  assert.match(html, /viewBox="0 0 24 24"/, "the HTML deliverable keeps it too");

  const svg = pageToSvg({ html, page });
  // This is why the case matters: the SVG is parsed as XML, which has no
  // attribute-name repair, so a lowercased `viewbox` would be an unknown
  // attribute and the geometry would be clipped rather than scaled.
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.doesNotMatch(svg, /viewbox=/);
});

test("the icon example in the generated reference is itself a valid icon", () => {
  const schema = readFileSync(join(ROOT, "references", "schema.md"), "utf8");
  const section = schema.slice(schema.indexOf("## Icons"));
  const block = /```html\n([\s\S]*?)```/.exec(section);
  assert.ok(block, "references/schema.md no longer carries an icon example");

  // A model copies this example. If it does not compile, the example is the bug.
  const { result, diagnostics } = compile(block[1].trim());
  assert.equal(result.refused, null, "the documented example must compile");
  assert.deepEqual(result.dropped, [], "the documented example must not be silently trimmed");
  assert.deepEqual(codes(diagnostics), [], "the documented example must validate clean");
});

test("the reference documents every attribute the table accepts", () => {
  const schema = readFileSync(join(ROOT, "references", "schema.md"), "utf8");
  assert.match(schema, /`viewBox`/, "viewBox is accepted by the table and demanded by the validator");
  assert.match(schema, /`data-fill`/, "data-fill is the opt-out from the base stroke rule");
});
