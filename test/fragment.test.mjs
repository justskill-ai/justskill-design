/**
 * test/fragment.test.mjs — the modifier path: a snippet in, one op out, or a refusal.
 *
 * The documents are plain objects in the shape docs/format-v3.md §4 freezes, so these
 * tests do not depend on `lib/parse.mjs` or `lib/serialize.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyOps, buildIdIndex, parseFragmentHtml } from "../lib/ops.mjs";
import { compileFragment, nearestIds, pagesOf, writeFragment } from "../lib/fragment.mjs";
import { buildReceipt, formatReceipt } from "../lib/receipt.mjs";

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

const attr = (name, value) => ({
  kind: "attr",
  name,
  rawName: name,
  value,
  quote: '"',
  start: -1,
  end: -1,
  attrStart: -1,
});

function el(tag, attrs, children = []) {
  return {
    kind: "element",
    tag,
    rawTag: tag,
    attrs,
    children,
    selfClosing: false,
    parent: null,
    start: -1,
    end: -1,
    openStart: -1,
    openEnd: -1,
    closeStart: -1,
    closeEnd: -1,
  };
}

function doc(children, extra = {}) {
  return {
    kind: "document",
    source: "",
    children,
    doctype: null,
    html: null,
    head: null,
    body: null,
    styleBlocks: [],
    diagnostics: [],
    ...extra,
  };
}

const frame = (id, attrs = [], children = []) =>
  el("div", [attr("data-id", id), attr("data-type", "frame"), ...attrs], children);

function makeDoc() {
  return doc([
    el("section", [attr("data-id", "home"), attr("data-type", "page")], [
      frame("home__root", [], [frame("home__hero")]),
    ]),
    el("section", [attr("data-id", "settings"), attr("data-type", "page")], [frame("settings__root")]),
  ]);
}

function withBody() {
  const body = el("body", [], [
    el("section", [attr("data-id", "home"), attr("data-type", "page")], [frame("home__root")]),
  ]);
  return doc([body], { body });
}

function styleOf(node) {
  const found = node.attrs.find((entry) => entry.name === "style");
  return found === undefined ? null : found.value;
}

/** Apply a compile result and return the document it produced. */
function commit(document, result) {
  assert.equal(result.refused, null, `unexpected refusal: ${JSON.stringify(result.refused)}`);
  const { doc: next } = applyOps(document, result.ops);
  return next;
}

/* ------------------------------------------------------------------ *
 * The accepted path
 * ------------------------------------------------------------------ */

test("a fragment becomes one insert op with the page's prefix for new ids", () => {
  const result = compileFragment(
    makeDoc(),
    '<div class="card" data-type="frame" data-name="card" style="padding:16px 16px 16px 16px">' +
      '<p data-id="home__card-title" data-type="text" style="color:#fff">卡片</p></div>',
    { in: "home__root", index: 0 },
  );
  assert.equal(result.refused, null);
  assert.equal(result.ops.length, 1);
  assert.equal(result.ops[0].op, "insert");
  assert.equal(result.ops[0].target, "home__root");
  assert.equal(result.ops[0].index, 0);
  assert.deepStrictEqual(result.added, ["home__card", "home__card-title"]);
  assert.equal(
    result.ops[0].html,
    '<div data-id="home__card" data-type="frame" data-name="card" style="padding:16px">' +
      '<p data-id="home__card-title" data-type="text" style="color:#ffffff">卡片</p></div>',
  );
  assert.deepStrictEqual(result.dropped, [
    { target: "home__card", prop: "class", value: "card", reason: "not in the format table" },
  ]);
});

test("the compiled op applies, and the added ids are addressable at once", () => {
  const document = makeDoc();
  const result = compileFragment(document, '<div data-id="n_card" data-type="frame"><p data-id="n_card_title" data-type="text">你好</p></div>', {
    in: "home__root",
  });
  const next = commit(document, result);
  const index = buildIdIndex(next);
  assert.equal(index.get("n_card").tag, "div");
  assert.equal(index.get("n_card_title").children[0].value, "你好");
  assert.deepStrictEqual(result.ops[0].target, "home__root");
});

test("the fragment root is appended to the parent unless an index is given", () => {
  const document = makeDoc();
  const first = compileFragment(document, '<div data-id="n_a" data-type="frame"></div>', { in: "home__root" });
  assert.equal(first.ops[0].index, 1);
  const second = compileFragment(document, '<div data-id="n_b" data-type="frame"></div>', {
    in: "home__root",
    index: 0,
  });
  assert.equal(second.ops[0].index, 0);
});

test("without in, the fragment lands in the last page", () => {
  const result = compileFragment(makeDoc(), '<div data-id="n_x" data-type="frame"></div>');
  assert.equal(result.refused, null);
  assert.equal(result.ops[0].target, "settings");
  assert.equal(result.ops[0].index, 1);
});

test("a page fragment lands in body", () => {
  const document = withBody();
  const result = compileFragment(document, '<section data-id="about" data-type="page"></section>');
  assert.equal(result.refused, null);
  assert.equal(result.ops[0].target, "body");
  const next = commit(document, result);
  assert.equal(buildIdIndex(next).get("about").tag, "section");
  assert.deepStrictEqual(pagesOf(next).map((page) => page.attrs[0].value), ["home", "about"]);
});

test("options.page names the prefix, options.as names the root", () => {
  const byPage = compileFragment(makeDoc(), '<div data-type="frame" data-name="cta"></div>', {
    in: "settings__root",
    page: "home",
  });
  assert.deepStrictEqual(byPage.added, ["home__cta"]);

  const byAs = compileFragment(makeDoc(), '<div data-type="frame" data-name="cta"></div>', {
    in: "home__root",
    as: "n_send",
  });
  assert.deepStrictEqual(byAs.added, ["n_send"]);
  assert.match(byAs.ops[0].html, /^<div data-id="n_send" data-type="frame"/);
});

test("an unknown page is refused", () => {
  const result = compileFragment(makeDoc(), '<div data-type="frame"></div>', { page: "nope" });
  assert.equal(result.refused.code, "structure/unknown-page");
  assert.match(result.refused.hint, /home, settings/);
});

test("an unknown parent is refused with the nearest ids", () => {
  const result = compileFragment(makeDoc(), '<div data-type="frame"></div>', { in: "home__rrot" });
  assert.equal(result.refused.code, "ops/node-not-found");
  assert.match(result.refused.suggestion, /home__root/);
});

test("an index past the end of the parent is refused", () => {
  const result = compileFragment(makeDoc(), '<div data-type="frame"></div>', { in: "home__root", index: 9 });
  assert.equal(result.refused.code, "ops/bad-index");
});

test("a parent that cannot hold children is refused", () => {
  const result = compileFragment(makeDoc(), '<span data-type="text"></span>', { in: "home" });
  assert.equal(result.refused, null);
  const onText = doc([
    el("section", [attr("data-id", "home"), attr("data-type", "page")], [
      el("p", [attr("data-id", "home__title"), attr("data-type", "text")], []),
    ]),
  ]);
  const refused = compileFragment(onText, '<div data-type="frame"></div>', { in: "home__title" });
  assert.equal(refused.refused.code, "structure/children-not-allowed");
});

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

test("a missing data-id is filled in from data-name, then the tag", () => {
  const named = compileFragment(makeDoc(), '<div data-type="frame" data-name="promo card"></div>', { in: "home__root" });
  assert.equal(named.refused, null);
  assert.deepStrictEqual(named.added, ["home__promo"]);
  assert.match(named.ops[0].html, /^<div data-id="home__promo" data-type="frame" data-name="promo card">/);

  const byTag = compileFragment(makeDoc(), '<p data-type="text">你好</p>', { in: "home__root" });
  assert.deepStrictEqual(byTag.added, ["home__p"]);
});

test("a data-name that cannot be an id falls back to the tag", () => {
  const result = compileFragment(makeDoc(), '<div data-type="frame" data-name="首页"></div>', { in: "home__root" });
  assert.deepStrictEqual(result.added, ["home__div"]);
});

test("a filled-in id that already exists is refused, not renamed", () => {
  const result = compileFragment(makeDoc(), '<div data-type="frame" data-name="root"></div>', { in: "home__root" });
  assert.equal(result.refused.code, "structure/duplicate-id");
  assert.match(result.refused.suggestion, /home__root/);
});

test("a collision with an existing id is refused and suggests the nearest", () => {
  const result = compileFragment(makeDoc(), '<div data-id="home__root" data-type="frame"></div>', {
    in: "home__root",
  });
  assert.equal(result.refused.code, "structure/duplicate-id");
  assert.equal(result.refused.message, 'data-id "home__root" is already taken.');
  assert.match(result.refused.suggestion, /^home__root, /);
  assert.deepStrictEqual(result.ops, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, "error");
});

test("two elements claiming one id inside the fragment is refused", () => {
  const result = compileFragment(
    makeDoc(),
    '<div data-id="n_a" data-type="frame"><div data-id="n_a" data-type="frame"></div></div>',
    { in: "home__root" },
  );
  assert.equal(result.refused.code, "structure/duplicate-id");
  assert.deepStrictEqual(result.added, ["n_a"]);
});

test("as conflicts with an id the fragment already carries", () => {
  const result = compileFragment(makeDoc(), '<div data-id="n_a" data-type="frame"></div>', {
    in: "home__root",
    as: "n_b",
  });
  assert.equal(result.refused.code, "structure/id-conflict");
});

test("a bad id is refused", () => {
  const result = compileFragment(makeDoc(), '<div data-id="9bad" data-type="frame"></div>', { in: "home__root" });
  assert.equal(result.refused.code, "structure/bad-id");
  const viaAs = compileFragment(makeDoc(), '<div data-type="frame"></div>', { in: "home__root", as: "has space" });
  assert.equal(viaAs.refused.code, "structure/bad-id");
});

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

test("an empty fragment and a text-only fragment are refused", () => {
  assert.equal(compileFragment(makeDoc(), "", {}).refused.code, "structure/empty-fragment");
  assert.equal(compileFragment(makeDoc(), "   \n ", {}).refused.code, "structure/empty-fragment");
  assert.equal(compileFragment(makeDoc(), "just words", {}).refused.code, "structure/empty-fragment");
  assert.equal(compileFragment(makeDoc(), "<!-- a note -->", {}).refused.code, "structure/empty-fragment");
});

test("a missing data-type is refused: it is the one attribute that says what a node is", () => {
  const result = compileFragment(makeDoc(), '<div data-id="n_a"></div>', { in: "home__root" });
  assert.equal(result.refused.code, "structure/missing-type");
  assert.match(result.refused.hint, /data-type="frame"/);
  const paragraph = compileFragment(makeDoc(), "<p>你好</p>", { in: "home__root" });
  assert.equal(paragraph.refused.code, "structure/missing-type");
  assert.match(paragraph.refused.hint, /data-type="text"/);
});

test("an unknown data-type is refused with the list", () => {
  const result = compileFragment(makeDoc(), '<div data-id="n_a" data-type="fraem"></div>', { in: "home__root" });
  assert.equal(result.refused.code, "structure/unknown-type");
  assert.match(result.refused.hint, /page, frame, component/);
  assert.match(result.refused.suggestion, /frame/);
});

test("a data-type that does not match its tag is refused", () => {
  const result = compileFragment(makeDoc(), '<div data-id="n_a" data-type="text"></div>', { in: "home__root" });
  assert.equal(result.refused.code, "structure/type-tag-mismatch");
  assert.match(result.refused.message, /text is <p>, <h1>/);
});

test("elements inside an element that cannot hold them are refused", () => {
  const result = compileFragment(
    makeDoc(),
    '<p data-id="n_a" data-type="text"><span data-id="n_b" data-type="text">x</span></p>',
    { in: "home__root" },
  );
  assert.equal(result.refused.code, "structure/children-not-allowed");
});

test("a page fragment is refused inside a page or a frame, and lands in body otherwise", () => {
  const inFrame = compileFragment(makeDoc(), '<section data-id="about" data-type="page"></section>', {
    in: "home__root",
  });
  assert.equal(inFrame.refused.code, "structure/page-misplaced");

  const inPage = compileFragment(makeDoc(), '<section data-id="about" data-type="page"></section>', { in: "home" });
  assert.equal(inPage.refused.code, "structure/page-misplaced");

  const inBody = compileFragment(withBody(), '<section data-id="about" data-type="page"></section>', {
    in: "body",
  });
  assert.equal(inBody.refused, null);
  assert.equal(inBody.ops[0].target, "body");
});

test("a nested page is refused", () => {
  const result = compileFragment(
    makeDoc(),
    '<div data-id="n_a" data-type="frame"><section data-id="n_b" data-type="page"></section></div>',
    { in: "home__root" },
  );
  assert.equal(result.refused.code, "structure/page-misplaced");
});

/* ------------------------------------------------------------------ *
 * The table: dropped, normalized, refused
 * ------------------------------------------------------------------ */

test("out-of-table properties are dropped with the table's reason, never in silence", () => {
  const result = compileFragment(
    makeDoc(),
    '<div data-id="n_card" data-type="frame" style="cursor:pointer;margin-top:8px;display:flex;border-radius:#ff"></div>',
    { in: "home__root" },
  );
  assert.equal(result.refused.code, "style/bad-length");
  assert.match(result.refused.message, /border-radius/);

  const kept = compileFragment(
    makeDoc(),
    '<div data-id="n_card" data-type="frame" style="cursor:pointer;margin-top:8px;display:flex"></div>',
    { in: "home__root" },
  );
  assert.deepStrictEqual(
    kept.dropped.map((entry) => [entry.prop, entry.reason.split(".")[0]]),
    [
      ["cursor", "The format describes appearance, not interaction"],
      ["margin-top", "A one-sided margin is a second spelling of the same intent"],
    ],
  );
  assert.deepStrictEqual(kept.normalized, []);
  assert.match(kept.ops[0].html, /style="display:flex"/);
});

test("values are normalized, and every change is reported", () => {
  const result = compileFragment(
    makeDoc(),
    '<div data-id="n_card" data-type="frame" style="background:#FFF;padding:16px 16px 16px 16px;gap:0px"></div>',
    { in: "home__root" },
  );
  assert.equal(result.refused, null);
  assert.deepStrictEqual(result.normalized, [
    { target: "n_card", prop: "background-color", from: "#FFF", to: "#ffffff", alias: "background" },
    { target: "n_card", prop: "padding", from: "16px 16px 16px 16px", to: "16px" },
    { target: "n_card", prop: "gap", from: "0px", to: "0" },
  ]);
  assert.equal(styleOf({ attrs: [{ name: "style", value: result.ops[0].html.match(/style="([^"]*)"/)[1] }] }), "background-color:#ffffff;padding:16px;gap:0");
});

test("zero silent drops: every declaration is either in the html or in dropped", () => {
  const declarations = ["background:#fff", "padding:16px 16px 16px 16px", "cursor:pointer", "grid-gap:8px", "color:#111827"];
  const result = compileFragment(
    makeDoc(),
    `<div data-id="n_card" data-type="frame" style="${declarations.join(";")}"></div>`,
    { in: "home__root" },
  );
  assert.equal(result.refused, null);
  const html = result.ops[0].html;
  const keptText = html.match(/style="([^"]*)"/)[1];
  const accounted = new Set([
    ...[...keptText.matchAll(/(?:^|;)([a-z-]+):/g)].map((match) => match[1]),
    ...result.dropped.map((entry) => entry.prop),
    ...result.normalized.map((entry) => entry.prop),
  ]);
  for (const declaration of declarations) {
    const written = declaration.slice(0, declaration.indexOf(":"));
    assert.ok(
      accounted.has(written) || written === "background" || written === "grid-gap",
      `${written} must be consumed or reported`,
    );
  }
  assert.equal(accounted.has("cursor"), true);
});

test("a value the table cannot read refuses the fragment instead of writing it", () => {
  const result = compileFragment(makeDoc(), '<div data-id="n_a" data-type="frame" style="display:banana"></div>', {
    in: "home__root",
  });
  assert.equal(result.refused.code, "style/bad-enum");
  assert.match(result.refused.hint, /flex \| block \| none/);
  assert.deepStrictEqual(result.ops, []);
});

test("attributes outside the design layer are dropped and reported", () => {
  const result = compileFragment(
    makeDoc(),
    '<img src="a.png" alt="一张图" data-credit="x" width="20" onclick="go()" data-type="image" data-id="n_img">',
    { in: "home__root" },
  );
  assert.equal(result.refused, null);
  assert.deepStrictEqual(
    result.dropped.map((entry) => entry.prop),
    ["width", "onclick"],
  );
  assert.equal(
    result.ops[0].html,
    '<img data-id="n_img" data-type="image" src="a.png" alt="一张图" data-credit="x">',
  );
});

/* ------------------------------------------------------------------ *
 * Writing and reading back
 * ------------------------------------------------------------------ */

test("the emitted html parses back to the tree the compiler built", () => {
  const source = '<div data-id="n_a" data-type="frame" style="gap:8px"><p data-id="n_b" data-type="text">a &amp; b</p><img data-id="n_c" data-type="image" src="x.png" alt=""></div>';
  const result = compileFragment(makeDoc(), source, { in: "home__root" });
  const [node] = parseFragmentHtml(result.ops[0].html);
  assert.equal(node.tag, "div");
  assert.equal(node.children[0].children[0].value, "a & b");
  assert.equal(node.children[1].tag, "img");
  assert.equal(node.children[1].attrs.find((entry) => entry.name === "src").value, "x.png");
});

test("writeFragment round-trips through the parser", () => {
  const html = '<div data-id="n_a" data-type="frame"><span data-id="n_b" data-type="text">你好 "q" &lt;x&gt;</span></div>';
  const nodes = parseFragmentHtml(html);
  const written = writeFragment(nodes);
  const again = parseFragmentHtml(written);
  assert.equal(again[0].children[0].children[0].value, nodes[0].children[0].children[0].value);
  assert.equal(again[0].attrs.length, 2);
});

/* ------------------------------------------------------------------ *
 * nearestIds
 * ------------------------------------------------------------------ */

test("nearestIds ranks the closest ids first and honours the limit", () => {
  const index = buildIdIndex(makeDoc());
  assert.deepStrictEqual(nearestIds(index, "home__rooot", 2), ["home__root", "home__hero"]);
  assert.equal(nearestIds(index, "x", 3).length, 3);
  assert.deepStrictEqual(nearestIds(["a", "b"], "a", 5), ["a", "b"]);
  assert.deepStrictEqual(nearestIds(new Set(["n_x"]), "n_y"), ["n_x"]);
  assert.deepStrictEqual(nearestIds({ n_z: 1 }, "n_z", 0), []);
});

/* ------------------------------------------------------------------ *
 * The receipt a refusal produces
 * ------------------------------------------------------------------ */

test("a refused fragment produces a receipt that prints REFUSED and 文件未改动。", () => {
  const result = compileFragment(makeDoc(), '<div data-id="home__root" data-type="frame"></div>', {
    in: "home__root",
  });
  const receipt = buildReceipt({
    verb: "add",
    applied: result.ops,
    added: result.added,
    normalized: result.normalized,
    dropped: result.dropped,
    diagnostics: result.diagnostics,
    refused: result.refused,
    revision: "abc123",
    changed: false,
  });
  assert.equal(receipt.ok, false);
  const text = formatReceipt(receipt);
  assert.match(text, /^REFUSED {2}data-id "home__root" is already taken\./m);
  assert.match(text, /建议: home__root, /);
  assert.match(text, /\n文件未改动。\n$/);
});

test("a compiled fragment produces a receipt with added, normalized and dropped", () => {
  const result = compileFragment(
    makeDoc(),
    '<div data-id="n_card" data-type="frame" style="padding:16px 16px 16px 16px;cursor:pointer"></div>',
    { in: "home__root" },
  );
  const receipt = buildReceipt({
    verb: "add",
    applied: result.ops,
    added: result.added,
    normalized: result.normalized,
    dropped: result.dropped,
    diagnostics: result.diagnostics,
    refused: result.refused,
    revision: "abc123",
    changed: true,
  });
  assert.equal(receipt.ok, true);
  const lines = formatReceipt(receipt).trimEnd().split("\n");
  assert.match(lines[0], /^added\s+n_card$/);
  assert.match(lines[1], /^normalized\s+n_card\.padding\s+16px 16px 16px 16px → 16px$/);
  assert.match(lines[2], /^dropped\s+n_card\.cursor\s+pointer\s+\(The format describes appearance/);
  assert.match(lines[3], /^applied\s+1 op · revision abc123$/);
});
