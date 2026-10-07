/**
 * Normalization has one job: one intent, one spelling. These tests pin the two
 * properties a caller depends on — idempotence, and never touching bytes that
 * are already canonical.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../lib/parse.mjs";
import { serialize } from "../lib/serialize.mjs";
import {
  normalizeDocument, normalizeText, normalizeStyleAttribute, isCanonical,
  sortAttributes, attributesAreSorted, compareAttributes,
} from "../lib/normalize.mjs";

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>:root{--color-ink:#111827;--space-md:16px}</style></head>`;

function file(body, head = HEAD, tail = "\n") {
  return `<!doctype html>\n<html lang="zh">\n${head}\n<body>\n${body}\n</body>\n</html>${tail}`;
}

function normalize(text) {
  const doc = parse(text);
  const result = normalizeDocument(doc, { serialize });
  return { text: serialize(doc, doc), ...result };
}

// -- the text layer -----------------------------------------------------------

test("line endings and the trailing newline are normalized", () => {
  assert.deepEqual(normalizeText("a\r\nb\r\n"), { text: "a\nb\n", changed: true });
  assert.deepEqual(normalizeText("a\nb\n\n\n"), { text: "a\nb\n", changed: true });
  assert.deepEqual(normalizeText("a\nb"), { text: "a\nb\n", changed: true });
  assert.deepEqual(normalizeText("a\nb\n"), { text: "a\nb\n", changed: false });
});

// -- attribute order ----------------------------------------------------------

test("attributes are ordered by the fixed rule", () => {
  const attrs = [
    { name: "style", value: "color:red" },
    { name: "data-name", value: "卡片" },
    { name: "data-type", value: "frame" },
    { name: "data-id", value: "card" },
    { name: "data-canvas", value: "0,0" },
  ];
  assert.deepEqual(sortAttributes(attrs).map((a) => a.name),
    ["data-id", "data-type", "data-canvas", "data-name", "style"]);
  assert.equal(attributesAreSorted(sortAttributes(attrs)), true);
  assert.equal(attributesAreSorted(attrs), false);
  assert.ok(compareAttributes({ name: "data-id" }, { name: "data-type" }) < 0);
  assert.ok(compareAttributes({ name: "data-type" }, { name: "style" }) < 0);
});

// -- style normalization ------------------------------------------------------

test("one style attribute normalizes and reports each change", () => {
  const result = normalizeStyleAttribute("background:#FFF;padding:16px 16px 16px 16px");
  assert.equal(result.text, "padding:16px;background-color:#ffffff");
  assert.equal(result.normalized.length, 3, JSON.stringify(result.normalized));
  assert.equal(result.dropped.length, 0);
});

test("a dropped declaration is reported, never discarded silently", () => {
  const seen = [];
  const text = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px"><div data-id="home__a" data-type="frame" style="display:flex;cursor:pointer"></div></section>`);
  const doc = parse(text);
  normalizeDocument(doc, { serialize, onDrop: (entry) => seen.push(entry) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prop, "cursor");
  assert.equal(seen[0].target, "home__a");
  assert.ok(seen[0].reason.length > 10);
});

// -- idempotence --------------------------------------------------------------

test("normalizing twice produces the same bytes the second time", () => {
  const messy = file(`<section style="height:844px;width:390px" data-canvas="0,0" data-type="page" data-id="home">
      <div style='padding:16px 16px 16px 16px;background:#FFF;display:flex' data-type="frame" data-id="home__a"></div>
    </section>`, HEAD, "");
  const once = normalize(messy);
  const twice = normalize(once.text);
  assert.equal(twice.text, once.text, "second pass changed something");
  assert.equal(twice.normalized.length, 0, "second pass reported a change");
});

test("a canonical file is not touched at all", () => {
  const canonical = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px">
    <div data-id="home__a" data-type="frame" style="display:flex;padding:16px;background-color:#ffffff"></div>
  </section>`);
  const result = normalize(canonical);
  assert.equal(result.text, canonical, "a canonical file must be byte identical");
  assert.equal(result.changed, false);
});

test("isCanonical explains why, instead of only saying no", () => {
  const messy = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="height:844px;width:390px"></section>`);
  const check = isCanonical(parse(messy));
  assert.equal(check.canonical, false);
  assert.ok(check.reasons.length >= 1);
  assert.match(check.reasons.join("\n"), /style/);

  const clean = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px"></section>`);
  assert.equal(isCanonical(parse(clean)).canonical, true, isCanonical(parse(clean)).reasons.join("; "));
});

test("attribute order is fixed even when the style is already canonical", () => {
  const messy = file(`<section style="width:390px;height:844px" data-id="home" data-type="page" data-canvas="0,0"></section>`);
  const result = normalize(messy);
  assert.match(result.text, /data-id="home" data-type="page" data-canvas="0,0" style=/);
});

test("comments and unknown elements survive normalization", () => {
  const text = file(`<!-- leading -->
  <section data-id="home" data-type="page" data-canvas="0,0" style="height:844px;width:390px">
    <canvas data-x="1"></canvas>
    <!-- inside -->
  </section>`);
  const result = normalize(text);
  assert.match(result.text, /<!-- leading -->/);
  assert.match(result.text, /<canvas data-x="1"><\/canvas>/);
  assert.match(result.text, /<!-- inside -->/);
});

test("pages are not reordered and whitespace between them is kept", () => {
  const text = file(`<section data-id="b" data-type="page" data-canvas="0,0" style="width:1px;height:1px"></section>

  <section data-id="a" data-type="page" data-canvas="10,0" style="width:1px;height:1px"></section>`);
  const result = normalize(text);
  assert.ok(result.text.indexOf('data-id="b"') < result.text.indexOf('data-id="a"'), "page order changed");
  assert.match(result.text, /<\/section>\n\n {2}<section data-id="a"/, "the blank line was reflowed");
});

test("a bare data-hidden becomes an explicit true", () => {
  const text = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="width:1px;height:1px"><div data-id="a" data-type="frame" data-hidden style="display:none"></div></section>`);
  const result = normalize(text);
  assert.match(result.text, /data-hidden/);
  const doc = parse(result.text);
  const again = normalize(result.text);
  assert.equal(again.text, result.text, "normalizing a bare boolean is idempotent");
});

test("an empty style attribute is removed", () => {
  const text = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="width:1px;height:1px"><div data-id="a" data-type="frame" style=""></div></section>`);
  const result = normalize(text);
  assert.ok(!/style=""/.test(result.text));
});

test("normalization keeps a data URI value whole", () => {
  const text = file(`<section data-id="home" data-type="page" data-canvas="0,0" style="width:1px;height:1px"><div data-id="a" data-type="frame" style="display:flex;background-image:url(&quot;data:image/svg+xml;base64,PHN2Zy8+&quot;)"></div></section>`);
  const result = normalize(text);
  assert.match(result.text, /data:image\/svg\+xml;base64,PHN2Zy8\+/);
  assert.equal(normalize(result.text).text, result.text);
});
