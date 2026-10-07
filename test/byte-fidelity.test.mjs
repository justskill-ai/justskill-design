/**
 * M0 — byte fidelity.
 *
 * The whole format rests on one property: a file that nobody edited comes back
 * byte for byte. If that fails, every other promise (the user's own formatting,
 * comments, hand-written SVG) is a lie.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parse, parseDeclarations, styleBlockRole, pagesOf, findById, getAttr } from "../lib/parse.mjs";
import { serialize, serializeCanonical, applyEdits } from "../lib/serialize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function fixture(name) {
  return readFileSync(join(HERE, "fixtures", "html", name), "utf8");
}

// -- the round trip -----------------------------------------------------------

test("parse then serialize returns the same bytes", () => {
  const samples = [
    "<!doctype html>\n<html><head><title>t</title></head><body><p>hi</p></body></html>\n",
    "<div data-id='a' data-type=\"frame\" style='color:red'>x</div>",
    "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n</head>\n<body>\n</body>\n</html>\n",
    "<p>a</p>\n<p>b</p>",
    "<DIV Data-Id=\"a\">TEXT</DIV>",
    "<img src=\"x.png\" alt=\"\">",
    "<svg viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/></svg>",
    "<br/>",
    "<input type=text value=a>",
    "text only, no tags",
    "",
    "<style>:root{--a:#fff}</style>",
    "<p>unclosed",
    "</p> stray",
    "<p>1 < 2 and 3 > 2</p>",
  ];
  for (const sample of samples) {
    const doc = parse(sample);
    assert.equal(serialize(doc), sample, `round trip failed for ${JSON.stringify(sample)}`);
  }
});

test("a full design file round trips byte for byte", () => {
  const text = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>miniprogram</title>
  <meta name="design-schema" content="3.0">
  <style>
    /* 只允许两个块：令牌块与页框块。元素样式一律内联。 */
    :root{ --color-bg:#0b0d12; --color-fg:#f5f7fa; --space-md:16px }
  </style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>

  <!-- 首页 -->
  <section data-id="home" data-type="page" data-name="首页" data-canvas="0,0"
           style="width:390px;height:844px;overflow:hidden">
    <div data-id="home__root" data-type="frame"
         style="display:flex;flex-direction:column;width:100%;height:100%;background-color:var(--color-bg)">
      <p data-id="home__title" data-type="text"
         style="font-size:32px;font-weight:700;color:var(--color-fg)">你好</p>
      <svg data-id="home__icon" data-type="icon" data-icon="shield-check" data-icon-library="lucide"
           style="width:24px;height:24px;color:var(--color-fg)"><path d="M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/></svg>
    </div>
  </section>

</body>
</html>
`;
  const doc = parse(text);
  assert.equal(serialize(doc), text);
});

test("comments, doctype and unknown tags survive", () => {
  const text = `<!doctype html>
<html><head><!-- head comment --><style>:root{--a:#fff}</style></head>
<body><!-- before --><div data-id="a" data-type="frame"><!-- inner --><canvas data-x="1"></canvas></div><!-- after --></body></html>
`;
  const doc = parse(text);
  assert.equal(serialize(doc), text);
  // The unknown tag is present in the tree, not dropped.
  const canvas = findById(doc, "a");
  const inner = canvas.children.find((c) => c.kind === "element" && c.tag === "canvas");
  assert.ok(inner, "the unknown element is in the tree");
});

test("a style value with a semicolon inside quotes survives the split", () => {
  const css = 'background-image:url("data:image/svg+xml;base64,PHN2Zy8+");color:#fff';
  const decls = parseDeclarations(css);
  assert.equal(decls.length, 2, `expected 2 declarations, got ${decls.length}: ${JSON.stringify(decls)}`);
  assert.equal(decls[0].property, "background-image");
  assert.equal(decls[0].value, 'url("data:image/svg+xml;base64,PHN2Zy8+")');
  assert.equal(decls[1].property, "color");
  assert.equal(decls[1].value, "#fff");
});

test("the declaration splitter tracks quotes, parens and comments", () => {
  const cases = [
    ['background-image:url("a;b.svg")', 1],
    ["background-image:url('a;b.svg')", 1],
    ["background-image:url(a;b.svg)", 1],
    ['content:"a;b";color:red', 2],
    ["a:/* ; */1;b:2", 2],
    ['a:calc(1px + 2px);b:3', 2],
    ['a:var(--x, "y;z");b:3', 2],
    ["a:1", 1],
    ["", 0],
    ["/* only a comment */", 0],
  ];
  for (const [css, expected] of cases) {
    assert.equal(parseDeclarations(css).length, expected, `for ${JSON.stringify(css)}`);
  }
});

test("two head style blocks both survive and keep their role", () => {
  const text = `<!doctype html>
<html><head>
<style>:root{--color-a:#111111}</style>
<style>section[data-type="page"]{margin:0 0 24px}</style>
</head><body><section data-id="p" data-type="page" style="width:10px;height:10px"></section></body></html>`;
  const doc = parse(text);
  assert.equal(doc.styleBlocks.length, 2);
  assert.equal(doc.styleBlocks[0].role, "tokens");
  assert.equal(doc.styleBlocks[1].role, "page-frame");
  assert.equal(doc.styleBlocks[0].declarations.length, 1);
  assert.equal(doc.styleBlocks[0].declarations[0].property, "--color-a");
  // The token block is not overwritten by the page-frame block.
  assert.equal(doc.styleBlocks[0].role, "tokens");
  assert.equal(serialize(doc), text);
});

test("styleBlockRole classifies the three shapes", () => {
  assert.equal(styleBlockRole(":root{--a:#fff}"), "tokens");
  assert.equal(styleBlockRole('section[data-type="page"]{margin:0}'), "page-frame");
  assert.equal(styleBlockRole(':root{--a:#fff}\nsection[data-type=page]{margin:0}'), "tokens+page-frame");
  assert.equal(styleBlockRole("div{color:red}"), "unknown");
});

// -- minimal edits ------------------------------------------------------------

test("a style edit rewrites only the style value", () => {
  const text = `<div data-id="a" data-type="frame" style="color:red;background-color:#ffffff"><p data-id="b" data-type="text" style="font-size:12px">hi</p></div>`;
  const doc = parse(text);
  const a = findById(doc, "a");
  a.attrs.find((x) => x.name === "style").value = "color:blue;background-color:#ffffff";
  const out = serialize(doc, doc);
  assert.equal(out, `<div data-id="a" data-type="frame" style="color:blue;background-color:#ffffff"><p data-id="b" data-type="text" style="font-size:12px">hi</p></div>`);
});

test("a text edit rewrites only the text", () => {
  const text = `<div data-id="a" data-type="frame"><!-- keep --><p data-id="b" data-type="text">old</p></div>`;
  const doc = parse(text);
  const b = findById(doc, "b");
  b.children[0].value = "新";
  const out = serialize(doc, doc);
  assert.equal(out, `<div data-id="a" data-type="frame"><!-- keep --><p data-id="b" data-type="text">新</p></div>`);
});

test("an edit inside one page leaves the other pages byte identical", () => {
  const text = `<section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px"><p data-id="home__t" data-type="text" style="font-size:32px">A</p></section>\n<section data-id="detail" data-type="page" data-canvas="490,0" style="width:390px;height:844px"><p data-id="detail__t" data-type="text" style="font-size:32px">B</p></section>`;
  const doc = parse(text);
  findById(doc, "detail__t").children[0].value = "C";
  const out = serialize(doc, doc);
  assert.equal(out, text.replace(">B<", ">C<"));
  assert.equal(out.slice(0, out.indexOf("detail")), text.slice(0, text.indexOf("detail")));
});

test("adding a page keeps the identical head and tail of the file", () => {
  const text = `<section data-id="a" data-type="page" style="width:1px;height:1px"></section>`;
  const doc = parse(text);
  const extra = parse(`<section data-id="b" data-type="page" style="width:1px;height:1px"></section>`);
  const bNode = extra.children[0];
  bNode.parent = doc.children[0].parent;
  doc.children.push(bNode);
  const out = serialize(doc, doc);
  // Nothing before the new page moves, and nothing after it either.
  assert.ok(out.startsWith(text), "the first page is byte identical");
  assert.ok(out.endsWith(`<section data-id="b" data-type="page" style="width:1px;height:1px"></section>`));
  assert.equal(out.slice(text.length), `<section data-id="b" data-type="page" style="width:1px;height:1px"></section>`);
});

test("a call site that wants a pretty append adds the separator itself", () => {
  const text = `<section data-id="a" data-type="page" style="width:1px;height:1px"></section>\n`;
  const doc = parse(text);
  const extra = parse(`<section data-id="b" data-type="page" style="width:1px;height:1px"></section>`);
  const bNode = extra.children[0];
  doc.children.push(bNode);
  assert.equal(serialize(doc, doc), `${text}<section data-id="b" data-type="page" style="width:1px;height:1px"></section>`);
});

test("applyEdits rejects overlapping edits instead of guessing", () => {
  assert.throws(() => applyEdits("abcdef", [{ start: 0, end: 3, text: "x" }, { start: 2, end: 4, text: "y" }]), /overlap/);
  assert.equal(applyEdits("abcdef", [{ start: 0, end: 1, text: "X" }, { start: 5, end: 6, text: "Y" }]), "XbcdeY");
  assert.equal(applyEdits("abcdef", [{ start: 6, end: 6, text: "!" }]), "abcdef!");
});

test("canonical text is stable and idempotent", () => {
  const text = `<div data-id='a' data-type="frame" style="background-color:#FFFFFF; padding : 16px 16px 16px 16px">x&amp;y</div>`;
  const doc = parse(text);
  const once = serializeCanonical(doc);
  const twice = serializeCanonical(parse(once));
  assert.equal(once, twice);
});

// -- fixtures -----------------------------------------------------------------

test("every html fixture round trips byte for byte", () => {
  const dir = join(HERE, "fixtures", "html");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 0, "fixtures exist");
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const doc = parse(text);
    assert.equal(serialize(doc), text, `round trip failed for ${file}`);
  }
});

test("real world fixtures round trip byte for byte", () => {
  const dir = join(HERE, "fixtures", "real");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const doc = parse(text);
    assert.equal(serialize(doc), text, `round trip failed for ${file}`);
  }
});

// -- parser facts -------------------------------------------------------------

test("a page is a section with data-type=page, in document order", () => {
  const text = `<section data-type="page" data-id="a"></section><div data-type="page" data-id="x"></div><section data-type="frame" data-id="c"></section><section data-type="page" data-id="b"></section>`;
  const doc = parse(text);
  assert.deepEqual(pagesOf(doc).map((p) => getAttr(p, "data-id")), ["a", "b"]);
});

test("offsets and line numbers are correct", () => {
  const text = `<div data-id="a" data-type="frame">\n  <p data-id="b" data-type="text">x</p>\n</div>`;
  const doc = parse(text);
  const a = findById(doc, "a");
  const b = findById(doc, "b");
  assert.equal(a.start, 0);
  assert.equal(a.openEnd, 35);
  assert.equal(text.slice(b.start, b.end), `<p data-id="b" data-type="text">x</p>`);
  assert.equal(text.slice(a.start, a.end), text);
  assert.equal(a.closeStart, text.lastIndexOf("</div>"));
});

test("malformed input produces a diagnostic, not a crash", () => {
  const cases = [
    "<div><p>x",
    "</span>",
    "<div attr=>",
    '<div a="unclosed>',
    "<!-- never closed",
    "<div <span></div>",
    "<p><p>nested</p></p>",
    "<3",
    "<>",
    "<a href='x'",
  ];
  for (const text of cases) {
    let doc;
    assert.doesNotThrow(() => { doc = parse(text); }, `parse threw for ${JSON.stringify(text)}`);
    assert.equal(typeof doc.source, "string");
    assert.ok(Array.isArray(doc.diagnostics));
  }
});

test("the parser reports the offset of what it complains about", () => {
  const text = `<div data-id="a" data-type="frame">\n</span>\n</div>`;
  const doc = parse(text);
  const stray = doc.diagnostics.find((d) => d.code === "syntax/stray-end-tag");
  assert.ok(stray, "a stray end tag is reported");
  assert.equal(stray.offset, text.indexOf("</span>"));
});

test("entity decoding covers named and numeric forms", () => {
  const doc = parse("<p>&amp; &lt; &gt; &nbsp; &#x4e2d; &#25991; &nope; & raw</p>");
  const p = doc.children[0];
  assert.equal(p.children[0].value, "& < > \u00a0 中 文 &nope; & raw");
  assert.equal(p.children[0].raw, "&amp; &lt; &gt; &nbsp; &#x4e2d; &#25991; &nope; & raw");
});

test("svg children are kept as real nodes", () => {
  const text = `<svg data-id="i" data-type="icon" data-icon="x" data-icon-library="lucide" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M1 2"/></svg>`;
  const doc = parse(text);
  const svg = findById(doc, "i");
  assert.deepEqual(svg.children.filter((c) => c.kind === "element").map((c) => c.tag), ["circle", "path"]);
  assert.equal(serialize(doc), text);
});

test("no node is dropped silently: element count is preserved", () => {
  const text = `<div data-id="a" data-type="frame"><p data-id="b" data-type="text"><span>bold</span> tail</p><canvas></canvas></div>`;
  const doc = parse(text);
  const tags = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.kind === "element") { tags.push(child.tag); visit(child); }
    }
  };
  visit(doc);
  assert.deepEqual(tags, ["div", "p", "span", "canvas"]);
  assert.equal(serialize(doc), text);
});
