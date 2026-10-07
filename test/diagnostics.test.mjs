import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeDiagnostics,
  diagnosticKey,
  filterDiagnostics,
  groupDiagnostics,
  resolveDiagnosticTarget,
  sortDiagnostics,
  summarize,
} from "../lib/diagnostics.mjs";

/* ------------------------------------------------------------------ *
 * Documents in the shape docs/format-v3.md §4 freezes.
 * ------------------------------------------------------------------ */

function attr(name, value) {
  return { kind: "attr", name, rawName: name, value, quote: '"', start: 0, end: 0, attrStart: 0 };
}

function element(tag, attrs, children, start, end) {
  const node = {
    kind: "element",
    tag,
    rawTag: tag,
    attrs,
    children,
    selfClosing: false,
    parent: null,
    start,
    end,
    openStart: start,
    openEnd: start + 1,
    closeStart: end - 1,
    closeEnd: end,
  };
  for (const child of children) child.parent = node;
  return node;
}

function text(value, start) {
  return { kind: "text", value, raw: value, parent: null, start, end: start + value.length };
}

function documentOf(pages) {
  const html = element("html", [], pages, 0, 340);
  return {
    kind: "document",
    source: "x".repeat(340),
    children: [html],
    doctype: null,
    html,
    head: null,
    body: null,
    styleBlocks: [],
    diagnostics: [],
  };
}

/** Two pages, plus an unidentified `<span>` inside the first page's title. */
function twoPageDocument() {
  const span = element("span", [], [], 132, 138);
  const title = element(
    "p",
    [attr("data-id", "home__title"), attr("data-type", "text")],
    [text("你好", 120), span],
    100,
    140,
  );
  const root = element("div", [attr("data-id", "home__root"), attr("data-type", "frame")], [title], 60, 150);
  const page = element(
    "section",
    [attr("data-id", "home"), attr("data-type", "page"), attr("data-canvas", "0,0")],
    [root],
    10,
    170,
  );

  const otherTitle = element("p", [attr("data-id", "about__title"), attr("data-type", "text")], [], 220, 260);
  const otherRoot = element("div", [attr("data-id", "about__root"), attr("data-type", "frame")], [otherTitle], 200, 270);
  const otherPage = element("section", [attr("data-id", "about"), attr("data-type", "page")], [otherRoot], 180, 290);
  const stray = element("marquee", [attr("data-id", "loose")], [], 300, 320);

  return documentOf([page, otherPage, stray]);
}

function onePageDocument() {
  const title = element("p", [attr("data-id", "home__title"), attr("data-type", "text")], [text("你好", 120)], 100, 140);
  const root = element("div", [attr("data-id", "home__root"), attr("data-type", "frame")], [title], 60, 150);
  const page = element("section", [attr("data-id", "home"), attr("data-type", "page")], [root], 10, 170);
  return documentOf([page]);
}

const SAMPLE = [
  { severity: "warning", code: "style/unknown-property", target: "home__title", offset: 130, message: "unknown property: colr" },
  { severity: "error", code: "structure/duplicate-id", target: "home__title", offset: 110, message: 'duplicate data-id "home__title"' },
  { severity: "error", code: "structure/duplicate-id", target: "about__title", offset: 230, message: 'duplicate data-id "about__title"' },
  { severity: "error", code: "a11y/missing-alt", target: "home", offset: 20, message: "image has no alt" },
  { severity: "warning", code: "style/unknown-value", target: "home__root", offset: 70, message: "unknown value: auto" },
  { severity: "warning", code: "a11y/missing-alt", target: "about", offset: 240, message: "image has no alt text" },
];

test("groupDiagnostics: one row per code, worst severity first, then count, then code", () => {
  const groups = groupDiagnostics(SAMPLE);
  assert.deepEqual(
    groups.map((group) => group.code),
    ["a11y/missing-alt", "structure/duplicate-id", "style/unknown-property", "style/unknown-value"],
  );

  const duplicate = groups.find((group) => group.code === "structure/duplicate-id");
  assert.equal(duplicate.severity, "error");
  assert.equal(duplicate.count, 2);
  assert.deepEqual(duplicate.targets, ["home__title", "about__title"]);
  assert.equal(duplicate.message, 'duplicate data-id "home__title"');

  // a11y/missing-alt has one error and one warning: the group is the worse of the two.
  const a11y = groups.find((group) => group.code === "a11y/missing-alt");
  assert.equal(a11y.severity, "error");
  assert.equal(a11y.count, 2);
  assert.deepEqual(a11y.targets, ["home", "about"]);
});

test("groupDiagnostics: the group object has exactly the documented keys", () => {
  const [group] = groupDiagnostics([SAMPLE[0]]);
  assert.deepEqual(Object.keys(group).sort(), ["code", "count", "message", "severity", "targets"]);
});

test("groupDiagnostics: an empty list groups to nothing", () => {
  assert.deepEqual(groupDiagnostics([]), []);
  assert.deepEqual(groupDiagnostics(undefined), []);
});

test("filterDiagnostics: by severity, by code, and by both", () => {
  assert.equal(filterDiagnostics(SAMPLE, { severity: "error" }).length, 3);
  assert.equal(filterDiagnostics(SAMPLE, { severity: "all" }).length, SAMPLE.length);
  assert.equal(filterDiagnostics(SAMPLE, { code: "structure/duplicate-id" }).length, 2);
  assert.equal(filterDiagnostics(SAMPLE, { severity: "warning", code: "style/unknown-value" }).length, 1);
  assert.deepEqual(filterDiagnostics(SAMPLE, { code: "nope/nothing" }), []);
});

test("filterDiagnostics: returns a new array and leaves the input alone", () => {
  const filtered = filterDiagnostics(SAMPLE, { severity: "error" });
  assert.notEqual(filtered, SAMPLE);
  filtered.pop();
  assert.equal(SAMPLE.length, 6);
});

test("sortDiagnostics: errors before warnings, then by offset", () => {
  const sorted = sortDiagnostics(SAMPLE);
  assert.deepEqual(
    sorted.map((diagnostic) => diagnostic.code),
    [
      "a11y/missing-alt",
      "structure/duplicate-id",
      "structure/duplicate-id",
      "style/unknown-value",
      "style/unknown-property",
      "a11y/missing-alt",
    ],
  );
  assert.deepEqual(sorted.slice(1, 3).map((diagnostic) => diagnostic.offset), [110, 230]);
});

test("sortDiagnostics: a finding with no offset sorts last inside its severity", () => {
  const sorted = sortDiagnostics([
    { severity: "error", code: "b", offset: 10 },
    { severity: "error", code: "a" },
  ]);
  assert.deepEqual(sorted.map((diagnostic) => diagnostic.code), ["b", "a"]);
});

test("summarize and diagnosticKey", () => {
  assert.deepEqual(summarize(SAMPLE), { errors: 3, warnings: 3, total: 6, ok: false });
  assert.equal(diagnosticKey(SAMPLE[1]), 'structure/duplicate-id|110|duplicate data-id "home__title"');
  assert.equal(dedupeDiagnostics([...SAMPLE, SAMPLE[1]]).length, SAMPLE.length);
});

test("resolveDiagnosticTarget: a target id resolves to that element", () => {
  const doc = twoPageDocument();
  assert.deepEqual(resolveDiagnosticTarget({ target: "home__title" }, doc), {
    pageId: "home",
    nodeId: "home__title",
  });
  assert.deepEqual(resolveDiagnosticTarget({ target: "about__root" }, doc), {
    pageId: "about",
    nodeId: "about__root",
  });
  assert.deepEqual(resolveDiagnosticTarget({ target: "home" }, doc), { pageId: "home", nodeId: "home" });
});

test("resolveDiagnosticTarget: an offset finds the deepest element that contains it", () => {
  const doc = twoPageDocument();
  assert.deepEqual(resolveDiagnosticTarget({ offset: 130 }, doc), { pageId: "home", nodeId: "home__title" });
  assert.deepEqual(resolveDiagnosticTarget({ offset: 165 }, doc), { pageId: "home", nodeId: "home" });
  assert.deepEqual(resolveDiagnosticTarget({ offset: 230 }, doc), { pageId: "about", nodeId: "about__title" });
});

test("resolveDiagnosticTarget: an element with no data-id falls back to the page root", () => {
  const doc = twoPageDocument();
  // The <span> at 132..138 has no data-id; the page root stands for it.
  assert.deepEqual(resolveDiagnosticTarget({ offset: 134 }, doc), { pageId: "home", nodeId: "home" });
});

test("resolveDiagnosticTarget: a random id falls back to the offset", () => {
  const doc = twoPageDocument();
  assert.deepEqual(resolveDiagnosticTarget({ target: "nope", offset: 130 }, doc), {
    pageId: "home",
    nodeId: "home__title",
  });
});

test("resolveDiagnosticTarget: an element outside every page has nowhere to point", () => {
  const doc = twoPageDocument();
  assert.equal(resolveDiagnosticTarget({ target: "loose" }, doc), null);
  assert.equal(resolveDiagnosticTarget({ offset: 305 }, doc), null);
});

test("resolveDiagnosticTarget: a location-less finding in a one-page file answers that page", () => {
  const one = onePageDocument();
  assert.deepEqual(resolveDiagnosticTarget({ code: "version/missing-schema" }, one), {
    pageId: "home",
    nodeId: "home",
  });
  // Two pages and no location: null, rather than a guess.
  assert.equal(resolveDiagnosticTarget({ code: "version/missing-schema" }, twoPageDocument()), null);
});

test("resolveDiagnosticTarget: a v1-style argument order is understood", () => {
  const doc = twoPageDocument();
  assert.deepEqual(resolveDiagnosticTarget(doc, { target: "home__title" }), {
    pageId: "home",
    nodeId: "home__title",
  });
});
