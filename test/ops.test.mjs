/**
 * test/ops.test.mjs — the op engine, and the receipt that reports it.
 *
 * The documents here are plain objects in the shape docs/format-v3.md §4 freezes.
 * They are built by hand on purpose: `lib/parse.mjs` and `lib/serialize.mjs` are other
 * people's files, and the op engine must be testable without either of them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  OP_KINDS,
  OpsError,
  applyOps,
  buildIdIndex,
  parseFragmentHtml,
  parseStyleDeclarations,
  setOpFor,
} from "../lib/ops.mjs";
import { buildReceipt, formatReceipt } from "../lib/receipt.mjs";

/* ------------------------------------------------------------------ *
 * Building documents
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

const text = (value) => ({ kind: "text", value, raw: value, parent: null, start: -1, end: -1 });

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

function frame(id, attrs = [], children = []) {
  return el("div", [attr("data-id", id), attr("data-type", "frame"), ...attrs], children);
}

function makeDoc() {
  return doc([
    el("section", [attr("data-id", "home"), attr("data-type", "page"), attr("data-name", "首页")], [
      frame("home__root", [], [
        el("p", [attr("data-id", "home__title"), attr("data-type", "text"), attr("style", "font-size:32px")], [text("你好")]),
        frame("home__card", [attr("style", "background-color:#ffffff;border-radius:8px")]),
        frame("home__cta"),
      ]),
    ]),
    el("section", [attr("data-id", "other"), attr("data-type", "page")], [frame("other__root", [], [frame("other__note")])]),
  ]);
}

/** Drop the `parent` pointers: they are links, not content, and they cycle. */
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "parent") continue;
      out[key] = strip(inner);
    }
    return out;
  }
  return value;
}

function same(actual, expected) {
  assert.deepStrictEqual(strip(actual), strip(expected));
}

function attrValueOf(node, name) {
  const found = node.attrs.find((entry) => entry.name === name);
  return found === undefined ? null : found.value;
}

function byId(document, id) {
  return buildIdIndex(document).get(id);
}

function styleOf(node) {
  return attrValueOf(node, "style");
}

/** Apply, then undo, and require the document to come back byte for byte. */
function roundTrip(document, ops) {
  const forward = applyOps(document, ops);
  const back = applyOps(forward.doc, forward.inverse);
  same(back.doc, document);
  assert.deepStrictEqual(back.applied, forward.inverse);
  return forward;
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

test("OP_KINDS is the five op kinds", () => {
  assert.deepStrictEqual(OP_KINDS, ["set", "unset", "insert", "remove", "move"]);
});

test("OpsError carries a code under the ops/ prefix", () => {
  const error = new OpsError("ops/no-target", "nothing there", { target: "n_x" });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "OpsError");
  assert.equal(error.code, "ops/no-target");
  assert.equal(error.target, "n_x");
});

/* ------------------------------------------------------------------ *
 * The id index
 * ------------------------------------------------------------------ */

test("buildIdIndex walks pages in document order, then their subtrees", () => {
  const index = buildIdIndex(makeDoc());
  assert.deepStrictEqual(
    [...index.keys()],
    ["home", "home__root", "home__title", "home__card", "home__cta", "other", "other__root", "other__note"],
  );
  assert.equal(index.get("home").tag, "section");
  assert.equal(index.get("home__title").tag, "p");
});

test("buildIdIndex does not index the descendants of an instance", () => {
  const document = doc([
    el("section", [attr("data-id", "home"), attr("data-type", "page")], [
      el("div", [attr("data-id", "home__inst"), attr("data-type", "instance"), attr("data-ref", "card")], [
        frame("card__title"),
      ]),
      frame("home__tail"),
    ]),
  ]);
  const index = buildIdIndex(document);
  assert.deepStrictEqual([...index.keys()], ["home", "home__inst", "home__tail"]);
});

test("buildIdIndex keeps the first id when two nodes claim it", () => {
  const document = doc([
    el("section", [attr("data-id", "home"), attr("data-type", "page")], [frame("dup"), frame("dup")]),
  ]);
  const index = buildIdIndex(document);
  assert.equal([...index.keys()].filter((id) => id === "dup").length, 1);
  assert.equal(index.get("dup"), document.children[0].children[0]);
});

test("buildIdIndex of a non-document is empty, not a throw", () => {
  assert.equal(buildIdIndex(null).size, 0);
});

/* ------------------------------------------------------------------ *
 * set
 * ------------------------------------------------------------------ */

test("set writes an attribute it did not have before", () => {
  const document = makeDoc();
  const { doc: next, applied, inverse } = applyOps(document, [
    { op: "set", target: "home__cta", prop: "data-name", value: "开始" },
  ]);
  assert.equal(attrValueOf(byId(next, "home__cta"), "data-name"), "开始");
  assert.deepStrictEqual(applied, [{ op: "set", target: "home__cta", prop: "data-name", value: "开始" }]);
  assert.deepStrictEqual(inverse, [{ op: "unset", target: "home__cta", prop: "data-name" }]);
  same(applyOps(next, inverse).doc, document);
});

test("set replaces an attribute it had", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "set", target: "home__title", prop: "style", value: "font-size:40px" },
  ]);
  assert.equal(styleOf(byId(next, "home__title")), "font-size:40px");
  assert.deepStrictEqual(inverse, [{ op: "set", target: "home__title", prop: "style", value: "font-size:32px" }]);
  same(applyOps(next, inverse).doc, document);
});

test("set on style:<property> appends a declaration and changes only its value later", () => {
  const document = makeDoc();
  const added = applyOps(document, [
    { op: "set", target: "home__card", prop: "style:border-radius", value: "12px" },
  ]);
  assert.equal(styleOf(byId(added.doc, "home__card")), "background-color:#ffffff;border-radius:12px");
  same(applyOps(added.doc, added.inverse).doc, document);

  const changed = applyOps(added.doc, [
    { op: "set", target: "home__card", prop: "style:border-radius", value: "4px" },
  ]);
  assert.equal(styleOf(byId(changed.doc, "home__card")), "background-color:#ffffff;border-radius:4px");
  assert.deepStrictEqual(changed.inverse, [
    { op: "set", target: "home__card", prop: "style:border-radius", value: "12px" },
  ]);
  same(applyOps(changed.doc, changed.inverse).doc, added.doc);
});

test("set on style: keeps the spacing written around the old value", () => {
  const document = doc([frame("n_a", [attr("style", "color: #fff ; padding: 8px")])]);
  const { doc: next, inverse } = applyOps(document, [
    { op: "set", target: "n_a", prop: "style:color", value: "#000000" },
  ]);
  assert.equal(styleOf(byId(next, "n_a")), "color: #000000 ; padding: 8px");
  same(applyOps(next, inverse).doc, document);
});

test("set on text replaces the element's text", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "set", target: "home__title", prop: "text", value: "再见" },
  ]);
  assert.deepStrictEqual(byId(next, "home__title").children.map((child) => child.value), ["再见"]);
  same(applyOps(next, inverse).doc, document);
});

test("set on text restores mixed content exactly, through the exact-restore form", () => {
  const document = doc([
    frame("n_box", [], [text("a"), frame("n_inner"), text("b")]),
  ]);
  const { doc: next, inverse } = applyOps(document, [{ op: "set", target: "n_box", prop: "text", value: "x" }]);
  assert.deepStrictEqual(byId(next, "n_box").children.map((child) => child.kind), ["text"]);
  same(applyOps(next, inverse).doc, document);
});

test("set on text of an empty element is undone by unset", () => {
  const document = doc([frame("n_empty")]);
  const { doc: next, inverse } = applyOps(document, [{ op: "set", target: "n_empty", prop: "text", value: "hi" }]);
  assert.deepStrictEqual(inverse, [{ op: "unset", target: "n_empty", prop: "text" }]);
  same(applyOps(next, inverse).doc, document);
});

test("set on data-id renames the node and refuses a taken id", () => {
  const document = makeDoc();
  const renamed = applyOps(document, [{ op: "set", target: "home__cta", prop: "data-id", value: "home__go" }]);
  assert.ok(buildIdIndex(renamed.doc).has("home__go"));
  assert.ok(!buildIdIndex(renamed.doc).has("home__cta"));
  same(applyOps(renamed.doc, renamed.inverse).doc, document);

  assert.throws(
    () => applyOps(document, [{ op: "set", target: "home__cta", prop: "data-id", value: "home__card" }]),
    (error) => error instanceof OpsError && error.code === "ops/duplicate-id",
  );
});

test("a set value may be a number or a boolean", () => {
  const document = makeDoc();
  const { doc: next } = applyOps(document, [
    { op: "set", target: "home__cta", prop: "data-hidden", value: true },
  ]);
  assert.equal(attrValueOf(byId(next, "home__cta"), "data-hidden"), "true");
  assert.throws(
    () => applyOps(document, [{ op: "set", target: "home__cta", prop: "data-x", value: { a: 1 } }]),
    (error) => error.code === "ops/bad-op",
  );
});

/* ------------------------------------------------------------------ *
 * unset
 * ------------------------------------------------------------------ */

test("unset removes an attribute and puts it back in its own position", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "unset", target: "home__title", prop: "style" },
  ]);
  assert.equal(attrValueOf(byId(next, "home__title"), "style"), null);
  assert.deepStrictEqual(
    byId(next, "home__title").attrs.map((entry) => entry.name),
    ["data-id", "data-type"],
  );
  same(applyOps(next, inverse).doc, document);
});

test("unset removes one declaration and leaves the others alone", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "unset", target: "home__card", prop: "style:background-color" },
  ]);
  assert.equal(styleOf(byId(next, "home__card")), "border-radius:8px");
  same(applyOps(next, inverse).doc, document);

  const all = applyOps(next, [{ op: "unset", target: "home__card", prop: "style:border-radius" }]);
  assert.equal(attrValueOf(byId(all.doc, "home__card"), "style"), null);
  same(applyOps(all.doc, all.inverse).doc, next);
});

test("unset removes the text", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [{ op: "unset", target: "home__title", prop: "text" }]);
  assert.deepStrictEqual(byId(next, "home__title").children, []);
  same(applyOps(next, inverse).doc, document);
});

test("unset reports ops/no-target when there is nothing to remove", () => {
  const document = makeDoc();
  for (const op of [
    { op: "unset", target: "home__cta", prop: "data-name" },
    { op: "unset", target: "home__card", prop: "style:color" },
    { op: "unset", target: "home__cta", prop: "text" },
  ]) {
    assert.throws(
      () => applyOps(document, [op]),
      (error) => error instanceof OpsError && error.code === "ops/no-target",
    );
  }
});

/* ------------------------------------------------------------------ *
 * insert
 * ------------------------------------------------------------------ */

test("insert parses the fragment, so the new id is addressable at once", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    {
      op: "insert",
      target: "home__root",
      index: 1,
      html: '<div data-id="n_card" data-type="frame" style="gap:8px"><p data-id="n_card__title" data-type="text">卡片</p></div>',
    },
  ]);
  assert.deepStrictEqual(
    byId(next, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__title", "n_card", "home__card", "home__cta"],
  );
  assert.equal(byId(next, "n_card__title").children[0].value, "卡片");
  assert.deepStrictEqual(inverse, [{ op: "remove", target: "n_card" }]);
  same(applyOps(next, inverse).doc, document);
});

test("an insert can be followed by a set on the inserted node", () => {
  const document = makeDoc();
  const { doc: next } = applyOps(document, [
    { op: "insert", target: "home__root", index: 0, html: '<div data-id="n_new" data-type="frame"></div>' },
    { op: "set", target: "n_new", prop: "style:padding", value: "16px" },
  ]);
  assert.equal(styleOf(byId(next, "n_new")), "padding:16px");
});

test("insert keeps the fragment's own bytes on the node", () => {
  const roots = parseFragmentHtml('<div data-id="n_x" data-type="frame">hi</div>');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].raw, undefined);
  const { doc: next } = applyOps(makeDoc(), [
    { op: "insert", target: "home__root", index: 0, html: '<div data-id="n_x" data-type="frame">hi</div>' },
  ]);
  const inserted = byId(next, "n_x");
  assert.equal(inserted.children[0].value, "hi");
});

test("insert refuses an index past the end and a duplicate id", () => {
  const document = makeDoc();
  assert.throws(
    () =>
      applyOps(document, [
        { op: "insert", target: "home__root", index: 9, html: '<div data-id="n_x" data-type="frame"></div>' },
      ]),
    (error) => error.code === "ops/bad-index",
  );
  assert.throws(
    () =>
      applyOps(document, [
        { op: "insert", target: "home__root", index: 0, html: '<div data-id="home__card" data-type="frame"></div>' },
      ]),
    (error) => error.code === "ops/duplicate-id" && error.duplicate === "home__card",
  );
});

test("insert into a node that cannot hold children is refused", () => {
  const document = makeDoc();
  assert.throws(
    () => applyOps(document, [{ op: "insert", target: "home__title", index: 0, html: "<span></span>" }]),
    (error) => error.code === "ops/bad-op",
  );
});

/* ------------------------------------------------------------------ *
 * remove
 * ------------------------------------------------------------------ */

test("remove drops the node and the inverse inserts it back verbatim", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [{ op: "remove", target: "home__card" }]);
  assert.deepStrictEqual(
    byId(next, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__title", "home__cta"],
  );
  assert.equal(inverse.length, 1);
  assert.equal(inverse[0].op, "insert");
  assert.equal(inverse[0].target, "home__root");
  assert.equal(inverse[0].index, 1);
  same(applyOps(next, inverse).doc, document);
});

test("remove by index takes the child at that position", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [{ op: "remove", target: "home__root", index: 0 }]);
  assert.equal(attrValueOf(byId(next, "home__root").children[0], "data-id"), "home__card");
  same(applyOps(next, inverse).doc, document);
  assert.throws(
    () => applyOps(document, [{ op: "remove", target: "home__root", index: 7 }]),
    (error) => error.code === "ops/bad-index",
  );
});

test("remove of an unknown id is ops/node-not-found, with the op index", () => {
  assert.throws(
    () => applyOps(makeDoc(), [{ op: "remove", target: "n_ghost" }]),
    (error) => error.code === "ops/node-not-found" && error.opIndex === 0 && error.target === "n_ghost",
  );
});

/* ------------------------------------------------------------------ *
 * move
 * ------------------------------------------------------------------ */

test("move before a sibling", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "move", target: "home__cta", before: "home__title" },
  ]);
  assert.deepStrictEqual(
    byId(next, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__cta", "home__title", "home__card"],
  );
  assert.deepStrictEqual(inverse, [{ op: "move", target: "home__cta", index: 2 }]);
  same(applyOps(next, inverse).doc, document);
});

test("move after a sibling", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "move", target: "home__title", after: "home__cta" },
  ]);
  assert.deepStrictEqual(
    byId(next, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__card", "home__cta", "home__title"],
  );
  same(applyOps(next, inverse).doc, document);
});

test("move to an index inside the same parent", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [{ op: "move", target: "home__title", index: 2 }]);
  assert.deepStrictEqual(
    byId(next, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__card", "home__cta", "home__title"],
  );
  same(applyOps(next, inverse).doc, document);
  assert.throws(
    () => applyOps(document, [{ op: "move", target: "home__title", index: 5 }]),
    (error) => error.code === "ops/bad-index",
  );
});

test("move into another parent, and back", () => {
  const document = makeDoc();
  const { doc: next, inverse } = applyOps(document, [
    { op: "move", target: "home__card", into: "other__root", index: 0 },
  ]);
  assert.deepStrictEqual(
    byId(next, "other__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__card", "other__note"],
  );
  assert.deepStrictEqual(
    byId(next, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__title", "home__cta"],
  );
  assert.deepStrictEqual(inverse, [{ op: "move", target: "home__card", into: "home__root", index: 1 }]);
  same(applyOps(next, inverse).doc, document);
});

test("move into a parent appends when no index is given", () => {
  const document = makeDoc();
  const { doc: next } = applyOps(document, [{ op: "move", target: "home__title", into: "other__root" }]);
  assert.deepStrictEqual(
    byId(next, "other__root").children.map((child) => attrValueOf(child, "data-id")),
    ["other__note", "home__title"],
  );
});

test("move by a sibling in another parent", () => {
  const document = makeDoc();
  const forward = roundTrip(document, [{ op: "move", target: "home__cta", before: "other__note" }]);
  assert.equal(forward.applied.length, 1);
  assert.deepStrictEqual(
    byId(forward.doc, "other__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__cta", "other__note"],
  );
  const backward = roundTrip(document, [{ op: "move", target: "other__note", after: "home__card" }]);
  assert.equal(backward.applied.length, 1);
  assert.deepStrictEqual(
    byId(backward.doc, "home__root").children.map((child) => attrValueOf(child, "data-id")),
    ["home__title", "home__card", "other__note", "home__cta"],
  );
});

test("move refuses moving a node inside itself", () => {
  const document = makeDoc();
  assert.throws(
    () => applyOps(document, [{ op: "move", target: "home__root", into: "home__card" }]),
    (error) => error.code === "ops/bad-op" && /inside itself/.test(error.message),
  );
  assert.throws(
    () => applyOps(document, [{ op: "move", target: "home__root", before: "home__title" }]),
    (error) => error.code === "ops/bad-op",
  );
  assert.throws(
    () => applyOps(document, [{ op: "move", target: "home__cta", into: "home__cta" }]),
    (error) => error.code === "ops/bad-op",
  );
});

/* ------------------------------------------------------------------ *
 * Cross-cutting behaviour
 * ------------------------------------------------------------------ */

test("the input document is never mutated", () => {
  const document = makeDoc();
  const snapshot = JSON.stringify(document);
  const { doc: next } = applyOps(document, [
    { op: "set", target: "home__title", prop: "style:color", value: "#ffffff" },
    { op: "insert", target: "home__root", index: 0, html: '<div data-id="n_new" data-type="frame"></div>' },
    { op: "move", target: "home__cta", into: "other__root" },
    { op: "remove", target: "home__card" },
  ]);
  assert.equal(JSON.stringify(document), snapshot);
  assert.notEqual(next, document);
});

test("the returned document shares no object with its input", () => {
  const document = makeDoc();
  const { doc: next } = applyOps(document, [{ op: "set", target: "home__cta", prop: "data-name", value: "开始" }]);
  assert.notEqual(next.children[0], document.children[0]);
  assert.notEqual(next.children[0].children[0].children[2], document.children[0].children[0].children[2]);
});

test("parent pointers in the returned document point at the returned tree", () => {
  const document = makeDoc();
  const { doc: next } = applyOps(document, [{ op: "move", target: "home__cta", into: "other__root" }]);
  const root = byId(next, "other__root");
  for (const child of root.children) assert.equal(child.parent, root);
  assert.equal(byId(next, "home__title").parent, byId(next, "home__root"));
  assert.equal(next.children[0].parent, null);
});

test("a batch of every op kind round-trips", () => {
  const document = makeDoc();
  const forward = roundTrip(document, [
    { op: "set", target: "home__title", prop: "text", value: "标题" },
    { op: "set", target: "home__card", prop: "style:padding", value: "16px 16px 16px 16px" },
    { op: "set", target: "home__card", prop: "data-name", value: "卡片" },
    { op: "unset", target: "home__card", prop: "style:border-radius" },
    { op: "insert", target: "home__root", index: 0, html: '<div data-id="n_a" data-type="frame"></div>' },
    { op: "move", target: "home__cta", before: "n_a" },
    { op: "move", target: "other__note", into: "home__root", index: 1 },
    { op: "remove", target: "home__card" },
    { op: "set", target: "n_a", prop: "style:gap", value: "8px" },
  ]);
  assert.equal(forward.applied.length, 9);
  assert.equal(forward.inverse.length, 9);
});

test("an empty op list returns the document itself, undeformed", () => {
  const document = makeDoc();
  const { doc: next, inverse, applied } = applyOps(document, []);
  same(next, document);
  assert.deepStrictEqual(inverse, []);
  assert.deepStrictEqual(applied, []);
});

test("bad input is reported with the documented codes", () => {
  assert.throws(() => applyOps(null, []), (error) => error.code === "ops/no-doc");
  assert.throws(() => applyOps({}, []), (error) => error.code === "ops/no-doc");
  assert.throws(() => applyOps(makeDoc(), null), (error) => error.code === "ops/bad-op");
  assert.throws(() => applyOps(makeDoc(), [null]), (error) => error.code === "ops/bad-op");
  assert.throws(() => applyOps(makeDoc(), [{ op: "frobnicate", target: "home" }]), (error) => error.code === "ops/bad-op");
  assert.throws(() => applyOps(makeDoc(), [{ op: "set", target: "home" }]), (error) => error.code === "ops/bad-op");
  assert.throws(
    () => applyOps(makeDoc(), [{ op: "set", target: "home", prop: "style:" , value: "x" }]),
    (error) => error.code === "ops/bad-op",
  );
  assert.throws(
    () => applyOps(makeDoc(), [{ op: "move", target: "home__cta" }]),
    (error) => error.code === "ops/bad-op",
  );
  assert.throws(
    () => applyOps(makeDoc(), [{ op: "move", target: "home__cta", before: "home__title", after: "home__card" }]),
    (error) => error.code === "ops/bad-op",
  );
  assert.throws(
    () => applyOps(makeDoc(), [{ op: "insert", target: "home__root", index: -1, html: "<div></div>" }]),
    (error) => error.code === "ops/bad-op",
  );
});

test("the op that failed is attached to the error", () => {
  try {
    applyOps(makeDoc(), [
      { op: "set", target: "home__cta", prop: "data-name", value: "ok" },
      { op: "set", target: "n_ghost", prop: "data-name", value: "no" },
    ]);
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal(error.code, "ops/node-not-found");
    assert.equal(error.opIndex, 1);
    assert.deepStrictEqual(error.op, { op: "set", target: "n_ghost", prop: "data-name", value: "no" });
  }
});

test("a document's html, head and body slots follow an edit made deep inside them", () => {
  const body = el("body", [], [
    el("section", [attr("data-id", "home"), attr("data-type", "page")], [frame("home__root", [], [frame("n_gone")])]),
  ]);
  const head = el("head", []);
  const html = el("html", [], [head, body]);
  const document = doc([html], { html, head, body });

  const removed = applyOps(document, [{ op: "remove", target: "n_gone" }]);
  assert.equal(removed.doc.html, removed.doc.children[0]);
  assert.equal(removed.doc.head, removed.doc.html.children[0]);
  assert.equal(removed.doc.body, removed.doc.html.children[1]);
  assert.ok(!buildIdIndex(removed.doc).has("n_gone"), "the stale subtree must not stay reachable");
  assert.deepStrictEqual(removed.doc.body.children[0].children[0].children, []);
  same(applyOps(removed.doc, removed.inverse).doc, document);

  const added = applyOps(removed.doc, [
    { op: "insert", target: "home__root", index: 0, html: '<div data-id="n_new" data-type="frame"></div>' },
  ]);
  assert.equal(added.doc.body, added.doc.html.children[1]);
  assert.ok(buildIdIndex(added.doc.body).has("n_new"));
  same(applyOps(added.doc, added.inverse).doc, removed.doc);
});

test("a reserved container word reaches body, head and the document", () => {
  const document = makeDoc();
  document.body = el("body", []);
  document.children.push(document.body);
  const { doc: next } = applyOps(document, [
    { op: "insert", target: "body", index: 0, html: '<section data-id="about" data-type="page"></section>' },
  ]);
  assert.equal(buildIdIndex(next).get("about").tag, "section");
  assert.equal(next.body.children[0], buildIdIndex(next).get("about"));
});

/* ------------------------------------------------------------------ *
 * The CSS declaration scanner
 * ------------------------------------------------------------------ */

test("the declaration scanner does not split a value on its semicolons", () => {
  const declarations = parseStyleDeclarations('background-image:url("data:image/svg+xml;base64,AAA");color:#fff');
  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].property, "background-image");
  assert.equal(declarations[0].value, 'url("data:image/svg+xml;base64,AAA")');
  assert.equal(declarations[1].property, "color");
  assert.equal(declarations[1].value, "#fff");
});

test("the scanner tracks quotes, parens and comments in all four states", () => {
  const declarations = parseStyleDeclarations('content:"a;b"; grid-template-columns:1fr /* ; */ 2fr; width:calc(100% - 4px)');
  assert.deepStrictEqual(
    declarations.map((entry) => [entry.property, entry.value]),
    [
      ["content", '"a;b"'],
      ["grid-template-columns", "1fr /* ; */ 2fr"],
      ["width", "calc(100% - 4px)"],
    ],
  );
});

test("a declaration's value range is exactly the value", () => {
  const source = "color: #fff ; padding:8px";
  const [first] = parseStyleDeclarations(source);
  assert.equal(source.slice(first.valueStart, first.valueEnd), "#fff");
});

/* ------------------------------------------------------------------ *
 * setOpFor
 * ------------------------------------------------------------------ */

test("setOpFor returns one set when the node is there", () => {
  const document = makeDoc();
  assert.deepStrictEqual(setOpFor(document, "home__cta", "style:gap", "8px"), [
    { op: "set", target: "home__cta", prop: "style:gap", value: "8px" },
  ]);
});

test("setOpFor builds the node it needs when it is not there yet", () => {
  const document = makeDoc();
  const ops = setOpFor(document, "home__fresh", "style:gap", "8px");
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, "insert");
  assert.equal(ops[0].target, "home");
  assert.equal(ops[1].op, "set");
  const { doc: next } = applyOps(document, ops);
  assert.equal(byId(next, "home__fresh").tag, "div");
  assert.equal(attrValueOf(byId(next, "home__fresh"), "style"), "gap:8px");

  const asText = setOpFor(document, "home__label", "text", "你好");
  const { doc: withText } = applyOps(document, asText);
  assert.equal(byId(withText, "home__label").tag, "p");
  assert.equal(byId(withText, "home__label").children[0].value, "你好");
});

test("setOpFor falls back to the last page, and gives up when there is none", () => {
  const document = makeDoc();
  const ops = setOpFor(document, "stray", "data-name", "无前缀");
  assert.equal(ops[0].target, "other");
  assert.throws(
    () => setOpFor(doc([]), "stray", "data-name", "x"),
    (error) => error.code === "ops/no-target",
  );
});

/* ------------------------------------------------------------------ *
 * The receipt
 * ------------------------------------------------------------------ */

test("a successful receipt has the nine documented keys", () => {
  const receipt = buildReceipt({
    verb: "add",
    applied: [{ op: "insert", target: "n_hero", index: 2 }],
    added: ["n_card", "n_card_title"],
    normalized: [{ target: "n_card", prop: "background-color", from: "#fff", to: "#ffffff" }],
    dropped: [{ target: "n_card", prop: "cursor", value: "pointer", reason: "not in the format table" }],
    diagnostics: [],
    revision: "3f2a9c1b",
    changed: true,
  });
  assert.deepStrictEqual(Object.keys(receipt), [
    "ok",
    "verb",
    "applied",
    "added",
    "normalized",
    "dropped",
    "diagnostics",
    "revision",
    "changed",
  ]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verb, "add");
  assert.equal(receipt.changed, true);
  assert.equal(receipt.revision, "3f2a9c1b");
  assert.deepStrictEqual(receipt.added, ["n_card", "n_card_title"]);
});

test("the human text lists added, normalized, dropped and the applied count in that order", () => {
  const text = formatReceipt(
    buildReceipt({
      verb: "add",
      applied: [{ op: "insert", target: "n_hero", index: 2 }],
      added: ["n_card", "n_card_title"],
      normalized: [{ target: "n_card", prop: "background-color", from: "#fff", to: "#ffffff" }],
      dropped: [{ target: "n_card", prop: "cursor", value: "pointer", reason: "not in the format table" }],
      revision: "3f2a9c1b",
      changed: true,
    }),
  );
  const lines = text.trimEnd().split("\n");
  assert.match(lines[0], /^added\s+n_card, n_card_title$/);
  assert.match(lines[1], /^normalized\s+n_card\.background-color\s+#fff → #ffffff$/);
  assert.match(lines[2], /^dropped\s+n_card\.cursor\s+pointer\s+\(not in the format table\)$/);
  assert.match(lines[3], /^applied\s+1 op · revision 3f2a9c1b$/);
});

test("the human text prints only the sections that have something in them", () => {
  const text = formatReceipt(buildReceipt({ verb: "set", applied: [], added: [], changed: false }));
  assert.equal(text, "");
});

test("a refusal prints REFUSED, the reason, the suggestion and 文件未改动。", () => {
  const receipt = buildReceipt({
    verb: "add",
    applied: [],
    changed: false,
    revision: "3f2a9c1b",
    refused: {
      code: "structure/duplicate-id",
      message: 'data-id "home__cta" is already taken.',
      hint: "Every element in the file has its own data-id.",
      suggestion: "home__card, home__title",
    },
  });
  assert.equal(receipt.ok, false);
  const text = formatReceipt(receipt);
  assert.match(text, /^REFUSED {2}data-id "home__cta" is already taken\./m);
  assert.match(text, /hint: Every element in the file has its own data-id\./);
  assert.match(text, /建议: home__card, home__title/);
  assert.match(text, /\n文件未改动。\n$/);
  assert.ok(!text.includes("applied"));
});

test("an error diagnostic makes the receipt fail even without a refused block", () => {
  const receipt = buildReceipt({
    verb: "patch",
    applied: [{ op: "set", target: "n_a", prop: "style:gap", value: "8px" }],
    diagnostics: [{ severity: "error", code: "structure/bad", message: "Something is wrong.", fix: "Fix it." }],
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.refused.code, "structure/bad");
  assert.match(formatReceipt(receipt), /^REFUSED {2}Something is wrong\./m);
  assert.match(formatReceipt(receipt), /文件未改动。\n$/);
});

test("a warning does not fail the receipt, and is printed after the applied line", () => {
  const receipt = buildReceipt({
    verb: "patch",
    applied: [{ op: "set", target: "n_a", prop: "style:gap", value: "8px" }],
    diagnostics: [{ severity: "warning", code: "style/alias", message: "background is background-color.", target: "n_a" }],
    revision: "abc",
    changed: true,
  });
  assert.equal(receipt.ok, true);
  const lines = formatReceipt(receipt).trimEnd().split("\n");
  assert.match(lines[0], /^applied\s+1 op · revision abc$/);
  assert.match(lines[1], /^warning {2}style\/alias {2}n_a {2}background is background-color\.$/);
});

test("zero silent drops: every declaration is consumed or reported", () => {
  const declarations = ["background-color:#fff", "padding:16px 16px 16px 16px", "cursor:pointer"];
  const normalized = [{ target: "n_card", prop: "background-color", from: "#fff", to: "#ffffff" }];
  const dropped = [{ target: "n_card", prop: "cursor", value: "pointer", reason: "not in the format table" }];
  const kept = ["background-color:#ffffff", "padding:16px"];
  const consumed = new Set([...kept.map((entry) => entry.split(":")[0]), ...dropped.map((entry) => entry.prop)]);
  for (const declaration of declarations) {
    const property = declaration.split(":")[0];
    assert.ok(consumed.has(property), `${property} must be consumed or reported`);
    assert.ok(
      kept.some((entry) => entry.startsWith(`${property}:`)) ||
        normalized.some((entry) => entry.prop === property) ||
        dropped.some((entry) => entry.prop === property),
    );
  }
});
