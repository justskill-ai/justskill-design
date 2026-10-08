/**
 * The renderer is shared by the canvas and the export path, so these tests pin
 * two things: what the user sees is what the file says, and the renderer's own
 * declaration splitter agrees with the parser's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse, parseDeclarations } from "../lib/parse.mjs";
import {
  renderModel, renderNodeHtml, styleMapOf, styleStringOf, resolveTokens,
  canvasPositionOf, expandInstance, componentMap, arrangePages, pageCss, pageTree,
  RenderError, escapeText,
} from "../lib/render.mjs";

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>:root{--color-ink:#111827;--space-md:16px;--color-bg:#ffffff}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`;

function file(body, head = HEAD) {
  return parse(`<!doctype html>\n<html lang="zh">\n${head}\n<body>\n${body}\n</body>\n</html>\n`);
}

// -- the splitter agrees with the parser --------------------------------------

test("the renderer's declaration splitter agrees with the parser's on every hard case", () => {
  const cases = [
    'background-image:url("data:image/svg+xml;base64,AAA");color:#ffffff',
    "font-family:\"Foo;Bar\", \"Baz;Qux\", sans-serif;font-size:14px",
    "background-image:url(a;b.svg);background-size:cover",
    "color:var(--color-ink);padding:16px 16px 16px 16px",
    "a:/* ; */1;b:2",
    "line-height:1.5",
    "",
    "   ",
  ];
  for (const css of cases) {
    const fromParser = parseDeclarations(css).map((d) => `${d.property}=${d.value}`);
    const map = styleMapOf({ attrs: [{ name: "style", value: css }] });
    const fromRenderer = [...map.entries()].map(([p, v]) => `${p}=${v}`).join("|");
    const parserJoined = fromParser.join("|");
    assert.equal(fromRenderer, parserJoined, `disagreement on ${JSON.stringify(css)}`);
  }
});

// -- tokens -------------------------------------------------------------------

test("var() resolves through the token chain", () => {
  const tokens = new Map([
    ["--color-ink", { name: "--color-ink", value: "#111827" }],
    ["--color-text", { name: "--color-text", value: "var(--color-ink)" }],
  ]);
  assert.equal(resolveTokens("var(--color-text)", tokens), "#111827");
  assert.equal(resolveTokens("1px solid var(--color-ink)", tokens), "1px solid #111827");
  assert.equal(resolveTokens("var(--missing, 4px)", tokens), "4px");
  assert.equal(resolveTokens("var(--missing)", tokens), "var(--missing)");
  assert.equal(resolveTokens("16px", tokens), "16px");
});

test("a token cycle does not hang the renderer", () => {
  const tokens = new Map([
    ["--a", { name: "--a", value: "var(--b)" }],
    ["--b", { name: "--b", value: "var(--a)" }],
  ]);
  const out = resolveTokens("var(--a)", tokens);
  assert.ok(typeof out === "string");
});

// -- the model ----------------------------------------------------------------

test("the model reports each page with its box, its position and its markup", () => {
  const doc = file(`
    <section data-id="home" data-type="page" data-name="首页" data-canvas="0,0" style="width:390px;height:844px">
      <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;gap:16px;background-color:var(--color-bg)">
        <p data-id="home__title" data-type="text" style="font-size:32px;color:var(--color-ink)">你好</p>
      </div>
    </section>`);
  const model = renderModel(doc);
  assert.equal(model.pages.length, 1);
  const page = model.pages[0];
  assert.equal(page.id, "home");
  assert.equal(page.name, "首页");
  assert.equal(page.width, "390px");
  assert.equal(page.height, "844px");
  assert.deepEqual(page.position, { x: 0, y: 0 });
  assert.match(page.boxStyle, /left:0px/);
  assert.match(page.boxStyle, /position:absolute/);
  // Tokens are resolved in the mount, because each page has its own shadow root
  // and there is no stylesheet above it to inherit from.
  assert.match(page.markup, /background-color:#ffffff/);
  assert.match(page.markup, /color:#111827/);
  assert.match(page.markup, /data-id="home__root"/);
});

test("an unresolved token is left alone rather than blanked", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><p data-id="a" data-type="text" style="color:var(--color-nope)">x</p></section>`);
  const model = renderModel(doc);
  assert.match(model.pages[0].markup, /var\(--color-nope\)/);
});

test("the page-frame rule comes from the file", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"></section>`);
  assert.equal(renderModel(doc).pageFrame, "margin:0 0 24px");
});

test("a file with no page-frame block still renders", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"></section>`, `<head><meta name="design-schema" content="3.0"><style>:root{--color-ink:#111827}</style></head>`);
  const model = renderModel(doc);
  assert.equal(model.pages.length, 1);
  assert.ok(typeof model.pageFrame === "string");
});

test("a library page is marked, and every page is in document order", () => {
  const doc = file(`
    <section data-id="home" data-type="page" data-canvas="0,0" style="width:1px;height:1px"></section>
    <section data-id="lib" data-type="page" data-library="true" data-canvas="0,900" style="width:1px;height:1px"></section>`);
  const model = renderModel(doc);
  assert.deepEqual(model.pages.map((p) => p.id), ["home", "lib"]);
  assert.equal(model.pages[0].isLibrary, false);
  assert.equal(model.pages[1].isLibrary, true);
});

test("pages with no stated position get a shelf, not a pile", () => {
  const doc = file(`
    <section data-id="a" data-type="page" style="width:100px;height:100px"></section>
    <section data-id="b" data-type="page" style="width:100px;height:100px"></section>
    <section data-id="c" data-type="page" style="width:100px;height:100px"></section>`);
  const model = renderModel(doc);
  const positions = arrangePages(model.pages, { gap: 48, perRow: 4 });
  assert.deepEqual(positions[0], { x: 0, y: 0 });
  assert.deepEqual(positions[1], { x: 148, y: 0 });
  assert.deepEqual(positions[2], { x: 296, y: 0 });
});

test("a page that states its position keeps it", () => {
  const doc = file(`
    <section data-id="a" data-type="page" data-canvas="600,240" style="width:1px;height:1px"></section>
    <section data-id="b" data-type="page" style="width:1px;height:1px"></section>`);
  const positions = arrangePages(renderModel(doc).pages, { perRow: 4 });
  assert.deepEqual(positions[0], { x: 600, y: 240 });
  assert.deepEqual(positions[1], { x: 0, y: 0 });
});

test("data-canvas parsing rejects what is not x,y", () => {
  assert.deepEqual(canvasPositionOf({ attrs: [{ name: "data-canvas", value: "0,920" }] }), { x: 0, y: 920 });
  assert.deepEqual(canvasPositionOf({ attrs: [{ name: "data-canvas", value: "-10, -20.5" }] }), { x: -10, y: -20.5 });
  assert.equal(canvasPositionOf({ attrs: [{ name: "data-canvas", value: "left" }] }), null);
  assert.equal(canvasPositionOf({ attrs: [] }), null);
});

// -- what a mount must preserve ----------------------------------------------

test("every data-id survives into the mount, so a click maps to an op", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px">
    <div data-id="home__root" data-type="frame" style="display:flex">
      <p data-id="home__title" data-type="text" style="font-size:32px">你好</p>
      <img data-id="home__photo" data-type="image" src="a.png" alt="月嫂" style="width:100%;height:80px">
    </div></section>`);
  const markup = renderModel(doc).pages[0].markup;
  for (const id of ["home__root", "home__title", "home__photo"]) {
    assert.match(markup, new RegExp(`data-id="${id}"`), `${id} is missing from the mount`);
  }
});

test("svg geometry and comments survive into the mount", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px">
    <svg data-id="home__icon" data-type="icon" data-icon="x" data-icon-library="lucide" style="width:24px;height:24px"><path d="M0 0h24v24H0z"/><title>icon</title></svg>
    <!-- a note --></section>`);
  const markup = renderModel(doc).pages[0].markup;
  assert.match(markup, /<path d="M0 0h24v24H0z">/);
  assert.match(markup, /<title>icon<\/title>/);
  assert.match(markup, /<!-- a note -->/);
});

test("void elements are not given a closing tag", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><img data-id="a" data-type="image" src="a.png" alt="" style="width:1px;height:1px"></section>`);
  const markup = renderModel(doc).pages[0].markup;
  assert.ok(!markup.includes("</img>"), `void element was closed: ${markup}`);
});

test("a data URI in a style value reaches the mount whole", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><div data-id="a" data-type="frame" style="display:flex;background-image:url(&quot;data:image/svg+xml;base64,PHN2Zy8+&quot;)"></div></section>`);
  const markup = renderModel(doc).pages[0].markup;
  // The value is held decoded and escaped once on the way out, so the mount
  // carries the same entity the file does.
  assert.match(markup, /url\(&quot;data:image\/svg\+xml;base64,PHN2Zy8\+&quot;\)/);
});

test("text is escaped in the mount, not injected", () => {
  assert.equal(escapeText("a & b < c"), "a &amp; b &lt; c");
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><p data-id="a" data-type="text" style="color:#111827">A &amp; B &lt; C</p></section>`);
  const markup = renderModel(doc).pages[0].markup;
  assert.match(markup, /A &amp; B &lt; C/);
});

// -- components and instances -------------------------------------------------

test("an instance expands into the component subtree with its own id", () => {
  const doc = file(`
    <section data-id="lib" data-type="page" data-library="true" style="width:1px;height:1px">
      <div data-id="card" data-type="component" style="display:flex;padding:16px">
        <p data-id="card__title" data-type="text" style="font-size:14px">Card</p>
      </div>
    </section>
    <section data-id="home" data-type="page" data-canvas="0,0" style="width:1px;height:1px">
      <div data-id="home__card" data-type="instance" data-ref="card" style="width:200px"></div>
    </section>`);
  const model = renderModel(doc);
  const home = model.pages.find((p) => p.id === "home");
  assert.match(home.markup, /data-id="home__card"/);
  assert.match(home.markup, /data-id="card__title"/, "the component's descendants are in the mount");
  assert.match(home.markup, /width:200px/, "the instance's own style wins on the root");
  assert.match(home.markup, /padding:16px/, "the component's style is the base");
});

test("an override changes one field and leaves the rest following the component", () => {
  const doc = file(`
    <section data-id="lib" data-type="page" data-library="true" style="width:1px;height:1px">
      <div data-id="card" data-type="component" style="display:flex;padding:16px">
        <p data-id="card__title" data-type="text" style="font-size:14px;color:#111827">Card</p>
      </div>
    </section>
    <section data-id="home" data-type="page" style="width:1px;height:1px">
      <div data-id="home__card" data-type="instance" data-ref="card" data-overrides='{"card__title":{"content":"你好","style":"font-size:20px"}}' style="width:200px"></div>
    </section>`);
  const markup = renderModel(doc).pages.find((p) => p.id === "home").markup;
  assert.match(markup, />你好</, "the overridden text is used");
  assert.match(markup, /font-size:20px/, "the overridden size is used");
  assert.match(markup, /color:#111827/, "an unmentioned field still follows the component");
});

test("a component made of a component resolves through both levels", () => {
  const doc = file(`
    <section data-id="lib" data-type="page" data-library="true" style="width:1px;height:1px">
      <div data-id="label" data-type="component" style="display:flex"><p data-id="label__text" data-type="text" style="font-size:12px">L</p></div>
      <div data-id="card" data-type="component" style="display:flex;padding:8px"><div data-id="card__label" data-type="instance" data-ref="label" style="width:10px"></div></div>
    </section>
    <section data-id="home" data-type="page" style="width:1px;height:1px"><div data-id="home__card" data-type="instance" data-ref="card" style="width:200px"></div></section>`);
  const markup = renderModel(doc).pages.find((p) => p.id === "home").markup;
  assert.match(markup, /data-id="label__text"/);
});

test("a broken reference does not blank the page, and the error is reported", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><p data-id="home__t" data-type="text" style="color:#111827">ok</p><div data-id="home__x" data-type="instance" data-ref="nope" style="width:1px;height:1px"></div></section>`);
  const model = renderModel(doc);
  assert.match(model.pages[0].markup, />ok</, "the rest of the page still renders");
  assert.equal(model.pages[0].node.__renderError, "render/unknown-ref");
});

test("expandInstance refuses an unknown ref and an over-deep chain", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><div data-id="a" data-type="component" style="display:flex"></div></section>`);
  const components = componentMap(doc);
  assert.throws(() => expandInstance({ attrs: [{ name: "data-ref", value: "gone" }] }, components), RenderError);
  assert.throws(() => expandInstance({ attrs: [{ name: "data-ref", value: "a" }] }, components, { depth: 20 }), /16 deep/);
});

test("nested instances that resolve without a cycle expand", () => {
  const doc = file(`
    <section data-id="lib" data-type="page" data-library="true" style="width:1px;height:1px">
      <div data-id="inner" data-type="component" style="display:flex"><p data-id="inner__t" data-type="text" style="font-size:12px">i</p></div>
    </section>
    <section data-id="home" data-type="page" style="width:1px;height:1px"><div data-id="home__i" data-type="instance" data-ref="inner" style="width:1px"></div></section>`);
  const errors = renderModel(doc).pages.find((p) => p.id === "home").node.__renderError;
  assert.equal(errors, undefined);
});

// -- shadow root css ----------------------------------------------------------

test("page CSS is the file's own rules, and not a reset the canvas invented", () => {
  // A shadow root cannot see the document's stylesheets, so the canvas has to
  // copy them in. What it must NOT do is add rules of its own: a canvas that
  // supplies its own box model renders a document the file does not describe,
  // and the author finds out at export time.
  const base = `<style>*,*::before,*::after{box-sizing:border-box}\n*{margin:0}\n:root{--color-ink:#111827}</style>`;
  const doc = file(
    `<section data-id="home" data-type="page" style="width:1px;height:1px"></section>`,
    `<head><meta charset="utf-8"><meta name="design-schema" content="3.0">${base}</head>`,
  );
  const css = pageCss(renderModel(doc));
  assert.match(css, /box-sizing:border-box/, "the file's box model reaches the shadow root");
  assert.match(css, /\*\{margin:0\}/, "the file's margin reset reaches the shadow root");
  assert.match(css, /:host\{--color-ink:#111827\}/, "`:root` matches nothing in a shadow tree, so the tokens go on the host");
  // An inherited property crosses a shadow boundary. The canvas chrome sets its
  // own `line-height` on the document, and without this the page's labels inherit
  // it and every one of them is a pixel taller than in the file.
  assert.match(css, /:host\{all:initial/, "the page must not inherit the canvas chrome's own type");
  assert.ok(!/:root\{/.test(css), `:root cannot match inside a shadow root: ${css}`);
});

test("a file that states no box model gets no box model from the canvas", () => {
  const doc = file(
    `<section data-id="home" data-type="page" style="width:1px;height:1px"></section>`,
    `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>:root{--color-ink:#111827}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`,
  );
  const css = pageCss(renderModel(doc));
  assert.ok(!/box-sizing/.test(css), `the canvas invented a box model: ${css}`);
  assert.match(css, /section\[data-type="page"\]\{margin:0 0 24px\}/, "the file's page-frame rule still applies");
});

// -- the layer tree -----------------------------------------------------------

test("the layer tree lists elements in document order with depth", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px">
    <div data-id="home__root" data-type="frame" data-name="根" style="display:flex">
      <p data-id="home__title" data-type="text" style="font-size:32px">你好</p>
    </div></section>`);
  const page = renderModel(doc).pages[0];
  const tree = pageTree(page.node);
  assert.deepEqual(tree.map((row) => [row.id, row.depth]), [["home__root", 0], ["home__title", 1]]);
  assert.equal(tree[0].name, "根");
  assert.equal(tree[1].text, "你好");
});

test("style helpers round trip a declaration list", () => {
  const map = styleMapOf({ attrs: [{ name: "style", value: "color:#111827;display:flex;gap:8px" }] });
  const text = styleStringOf(map);
  assert.equal(text, "display:flex;gap:8px;color:#111827");
  assert.equal(styleStringOf(styleMapOf({ attrs: [{ name: "style", value: text }] })), text);
});

test("renderNodeHtml keeps the tag, the data attributes and the style", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px"><h1 data-id="home__h" data-type="text" data-name="大标题" style="font-size:40px;font-weight:700">标题</h1></section>`);
  const node = renderModel(doc).pages[0].node;
  const html = renderNodeHtml(node.children[0], new Map());
  assert.match(html, /^<h1 /);
  assert.match(html, /data-name="大标题"/);
  assert.match(html, /font-size:40px;font-weight:700/);
  assert.match(html, />标题<\/h1>$/);
});

test("the layer tree does not list svg geometry", () => {
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px">
    <div data-id="home__bar" data-type="frame" style="display:flex">
      <svg data-id="home__icon" data-type="icon" data-icon="wifi" data-icon-library="lucide" style="width:24px;height:24px">
        <path d="M2 20h.01"></path><path d="M7 20v-4"></path><circle cx="12" cy="12" r="3"></circle><title>wifi</title>
      </svg>
    </div></section>`);
  const rows = pageTree(renderModel(doc).pages[0].node);
  assert.deepEqual(rows.map((r) => r.id), ["home__bar", "home__icon"],
    "the glyph is a row; its geometry is not");
  assert.equal(rows[1].childCount, 0, "a glyph reports no children to expand");
});

test("the layer tree is not buried by a real imported icon set", () => {
  const paths = Array.from({ length: 40 }, (_, i) => `<path d="M${i} 0h1"></path>`).join("");
  const doc = file(`<section data-id="home" data-type="page" style="width:1px;height:1px">
    <div data-id="home__row" data-type="frame" style="display:flex">
      <svg data-id="home__icon" data-type="icon" data-icon="x" data-icon-library="lucide" style="width:24px;height:24px">${paths}</svg>
    </div></section>`);
  const rows = pageTree(renderModel(doc).pages[0].node);
  assert.equal(rows.length, 2, `expected 2 rows, got ${rows.length}`);
});
