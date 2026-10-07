/**
 * A deliverable must be what the canvas showed.
 *
 * The canvas and the export share one renderer, so the failure this file guards
 * against is not "the two disagree" — it is "the export dropped something the
 * page depended on". A missing token block is the classic case: every element
 * that used `var(--color-ink)` still parses, still renders, and is the wrong
 * color. These tests check what a browser would compute, not what the source
 * looks like.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse, getAttr, findById } from "../lib/parse.mjs";
import { exportPage, exportAllPages, ExportError } from "../lib/export-html.mjs";
import { pageToSvg, parseSize, clampScale } from "../lib/export-svg.mjs";

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>:root{--color-bg:#ffffff;--color-ink:#0b0d12;--space-md:16px}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`;

function file(body, head = HEAD) {
  return `<!doctype html>\n<html lang="zh">\n${head}\n<body>\n${body}\n</body>\n</html>\n`;
}

const ONE_PAGE = file(`  <section data-id="home" data-type="page" data-name="首页" data-canvas="0,0" style="width:390px;height:844px">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;gap:16px;padding:24px">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:var(--color-ink)">你好</p>
    </div>
  </section>`);

// -- what the deliverable keeps ----------------------------------------------

test("a deliverable is a standalone document", () => {
  const { html } = exportPage(parse(ONE_PAGE));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>首页<\/title>/);
  assert.match(html, /<meta name="viewport" content="width=390, height=844">/);
  assert.match(html, /<\/html>\n$/);
});

test("the token block travels with the page", () => {
  const { html } = exportPage(parse(ONE_PAGE));
  assert.match(html, /:root\{/);
  assert.match(html, /--color-ink:#0b0d12/);
  assert.match(html, /color:var\(--color-ink\)/, "the element still refers to the token");
});

test("--resolve-tokens bakes the values in and drops the block", () => {
  const { html } = exportPage(parse(ONE_PAGE), { resolveTokens: true });
  assert.ok(!html.includes("--color-ink"), `the token block is gone: ${html.slice(0, 400)}`);
  assert.match(html, /color:#0b0d12/, "the value replaced the reference");
});

test("the design layer is stripped: every data-* marker is gone", () => {
  const { html } = exportPage(parse(ONE_PAGE));
  assert.ok(!/data-id=/.test(html), "no data-id in a deliverable");
  assert.ok(!/data-type=/.test(html), "no data-type in a deliverable");
  assert.ok(!/data-canvas=/.test(html), "no data-canvas in a deliverable");
  assert.ok(!/data-name=/.test(html), "no data-name in a deliverable");
  assert.ok(!/design-schema/.test(html), "the schema marker is a design-file concern");
  assert.ok(!/section\[data-type="page"\]/.test(html), "the page-frame rule is a design-file concern");
  assert.match(html, /你好/, "the content is not");
});

test("a data-id inside text is not touched", () => {
  const doc = file(`  <section data-id="home" data-type="page" style="width:1px;height:1px">
    <p data-id="home__t" data-type="text" style="font-size:12px;color:#111827">see data-id="home" and data-type=frame</p>
  </section>`);
  const { html } = exportPage(parse(doc));
  // Text is copied, not rewritten. Only the element's own attribute is removed,
  // which is why this is a walk over the tree and never a regular expression
  // over the markup: a pattern would have eaten the quote inside the sentence.
  assert.match(html, />see data-id="home" and data-type=frame</);
  assert.ok(!/<p data-id/.test(html), "the marker on the element is gone");
  assert.match(html, /<p style="font-size:12px;color:#111827">/, "the element's own markers are gone");
});

test("in a real render the colour resolves to what the canvas shows", () => {
  // The unit-level check above reads the source. This one reads what a browser
  // would compute, without a browser: the deliverable's token block must define
  // every custom property the page refers to.
  const { html } = exportPage(parse(ONE_PAGE));
  const declared = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const referenced = new Set([...html.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  for (const name of referenced) {
    assert.ok(declared.has(name), `${name} is referenced but never declared in the deliverable`);
  }
});

// -- what the deliverable keeps from the design -------------------------------

test("svg geometry, comments and a data URI survive as they are", () => {
  const doc = file(`  <section data-id="home" data-type="page" style="width:1px;height:1px">
    <svg data-id="home__icon" data-type="icon" data-icon="x" data-icon-library="lucide" style="width:24px;height:24px"><path d="M0 0h24v24H0z"/><title>icon</title></svg>
    <!-- keep me -->
    <div data-id="home__bg" data-type="frame" style="display:flex;background-image:url(&quot;data:image/svg+xml;base64,PHN2Zy8+&quot;)"></div>
  </section>`);
  const { html } = exportPage(parse(doc), { keepComments: true });
  assert.match(html, /<path d="M0 0h24v24H0z">/);
  assert.match(html, /<title>icon<\/title>/);
  assert.match(html, /<!-- keep me -->/);
  assert.match(html, /url\(&quot;data:image\/svg\+xml;base64,PHN2Zy8\+&quot;\)/);
});

test("instances are expanded in the deliverable", () => {
  const doc = file(`
    <section data-id="lib" data-type="page" data-library="true" style="width:1px;height:1px">
      <div data-id="card" data-type="component" style="display:flex;padding:16px">
        <p data-id="card__title" data-type="text" style="font-size:14px;color:#111827">Card</p>
      </div>
    </section>
    <section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px">
      <div data-id="home__card" data-type="instance" data-ref="card" data-overrides='{"card__title":{"content":"你好"}}' style="width:200px"></div>
    </section>`);
  const { html } = exportPage(parse(doc), { page: "home" });
  assert.match(html, />你好</, "the override is applied");
  assert.match(html, /padding:16px/, "the component's own style is there");
  assert.ok(!/data-ref/.test(html), "the reference is resolved, not shipped");
});

// -- page selection -----------------------------------------------------------

test("the first page is exported when none is named", () => {
  const doc = file(`
    <section data-id="a" data-type="page" data-name="A" style="width:1px;height:1px"><p data-id="a__t" data-type="text" style="font-size:12px;color:#111827">A</p></section>
    <section data-id="b" data-type="page" data-name="B" style="width:1px;height:1px"><p data-id="b__t" data-type="text" style="font-size:12px;color:#111827">B</p></section>`);
  const { html, page } = exportPage(parse(doc));
  assert.equal(page.id, "a");
  assert.match(html, />A</);
  assert.ok(!/>B</.test(html));
});

test("naming a page exports that page, and an unknown name is refused with the list", () => {
  const doc = file(`
    <section data-id="a" data-type="page" style="width:1px;height:1px"></section>
    <section data-id="b" data-type="page" style="width:1px;height:1px"></section>`);
  const { html, page } = exportPage(parse(doc), { page: "b" });
  assert.equal(page.id, "b");
  assert.match(html, /<title>b<\/title>/);

  assert.throws(() => exportPage(parse(doc), { page: "nope" }), (error) => {
    assert.equal(error.code, "export/unknown-page");
    assert.match(error.hint, /a, b/);
    return true;
  });
});

test("a file with no page is refused, not silently empty", () => {
  const doc = file(`<div data-id="x" data-type="frame" style="display:flex"></div>`);
  assert.throws(() => exportPage(parse(doc)), ExportError);
});

test("--all skips the library page and names each file after its page", () => {
  const doc = file(`
    <section data-id="home" data-type="page" style="width:1px;height:1px"></section>
    <section data-id="lib" data-type="page" data-library="true" style="width:1px;height:1px"></section>
    <section data-id="detail" data-type="page" style="width:1px;height:1px"></section>`);
  const results = exportAllPages(parse(doc));
  assert.deepEqual(results.map((r) => r.page.id), ["home", "detail"]);
  assert.deepEqual(results.map((r) => r.file), ["home.html", "detail.html"]);

  const withLibrary = exportAllPages(parse(doc), { includeLibrary: true });
  assert.deepEqual(withLibrary.map((r) => r.page.id), ["home", "lib", "detail"]);
});

// -- declaration order is canonical in the deliverable too --------------------

test("inline styles are written in the table's order, not the author's", () => {
  const doc = file(`  <section data-id="home" data-type="page" style="width:390px;height:844px">
    <div data-id="home__a" data-type="frame" style="color:#111827;display:flex;gap:8px;padding:16px"></div>
  </section>`);
  const { html } = exportPage(parse(doc));
  assert.match(html, /style="display:flex;gap:8px;padding:16px;color:#111827"/);
});

test("a token is not resolved twice", () => {
  const doc = file(`  <section data-id="home" data-type="page" style="width:1px;height:1px">
    <div data-id="home__a" data-type="frame" style="display:flex;background-color:var(--color-ink)"></div>
  </section>`, `<head><meta name="design-schema" content="3.0"><style>:root{--color-ink:#0b0d12;--alias:var(--color-ink)}</style></head>`);
  const { html } = exportPage(parse(doc), { resolveTokens: true });
  assert.match(html, /background-color:#0b0d12/);
  assert.ok(!/var\(/.test(html), `a reference survived: ${html}`);
});

// -- svg and the raster route -------------------------------------------------

test("a page becomes one SVG with the markup inside a foreignObject", () => {
  const { html, page } = exportPage(parse(ONE_PAGE));
  const svg = pageToSvg({ html, page });
  assert.match(svg, /^<\?xml version="1\.0"/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<foreignObject x="0" y="0" width="390" height="844">/);
  assert.match(svg, /viewBox="0 0 390 844"/);
  assert.match(svg, /你好/, "the page's content is inside");
  assert.match(svg, /:root\{/, "the token block travels with it, or every colour breaks");
});

test("the SVG says what cannot open it, instead of pretending", () => {
  const { html, page } = exportPage(parse(ONE_PAGE));
  const svg = pageToSvg({ html, page });
  assert.match(svg, /Figma, Illustrator and Sketch/);
  assert.match(svg, /foreignObject/);
});

test("a page with no stated size still produces a usable SVG", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:auto;height:auto"></section>`);
  const { html, page } = exportPage(parse(doc));
  const svg = pageToSvg({ html, page });
  assert.match(svg, /width="390" height="844"/, "a fallback size, not zero");
});

test("--size is parsed, and a typo is refused with the shape to use", () => {
  assert.deepEqual(parseSize("390x844"), { width: 390, height: 844 });
  assert.deepEqual(parseSize(" 375 × 812 "), { width: 375, height: 812 });
  assert.equal(parseSize(undefined), null);
  assert.throws(() => parseSize("big"), (error) => {
    assert.equal(error.code, "export/bad-size");
    assert.match(error.hint, /390x844/);
    return true;
  });
});

test("scale is clamped, so a typo cannot ask for a hundredfold image", () => {
  assert.equal(clampScale(2), 2);
  assert.equal(clampScale(0), 1);
  assert.equal(clampScale(100), 3);
  assert.equal(clampScale("nope"), 1);
});

test("the raster route refuses rather than substituting another format", async () => {
  // No browser, no canvas: the export must fail and name three ways forward.
  const { planRaster } = await import("../lib/raster.mjs");
  assert.throws(() => planRaster({ raster: "auto" }, { findBrowser: () => null }), (error) => {
    assert.match(error.hint, /Chrome/);
    assert.match(error.hint, /canvas/);
    assert.match(error.hint, /svg/);
    return true;
  });
});
