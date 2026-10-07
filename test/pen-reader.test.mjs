/**
 * The `.pen` reader, against the real thing.
 *
 * The reference file is 705 KB, 19692 lines, 26 artboards and 1541 nodes. It is
 * the acceptance test for this reader: if the import reports a clean ledger and
 * the result validates, the mapping covers what pen actually writes. A synthetic
 * fixture would only cover what I remembered.
 *
 * The file lives outside the repository, so these tests skip when it is absent
 * rather than failing on another machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { parse, getAttr, findById, pagesOf } from "../lib/parse.mjs";
import { validateDesign } from "../lib/validate.mjs";
import {
  importPen, parsePen, stripJsonComments, createLedger, tokensFromVariables,
  idMapFor, styleFromNode, ledgerLine,
} from "../lib/readers/pen.mjs";

const REFERENCE = "/Users/xiguazhi/Developer/MyProjects/jiazheng-mono/design/miniprogram.pen";
const hasReference = existsSync(REFERENCE);
const reference = () => readFileSync(REFERENCE, "utf8");

// -- the small things first ---------------------------------------------------

test("json comments are stripped without eating a // inside a string", () => {
  const text = `{
  // a line comment
  "url": "https://example.com/a//b",
  /* a block comment */
  "version": "2.19"
}`;
  const parsed = JSON.parse(stripJsonComments(text));
  assert.equal(parsed.url, "https://example.com/a//b");
  assert.equal(parsed.version, "2.19");
});

test("a file with no children array is refused by name", () => {
  assert.throws(() => parsePen('{"version":"2.19"}'), (error) => {
    assert.equal(error.code, "pen/no-pages");
    return true;
  });
});

test("broken JSON is refused with the parser's own message", () => {
  assert.throws(() => parsePen('{"children": ['), (error) => {
    assert.equal(error.code, "pen/invalid-json");
    assert.match(error.message, /not JSON/);
    return true;
  });
});

test("variables become tokens, with the group taken from the name", () => {
  const ledger = createLedger();
  const { tokens, refs } = tokensFromVariables({
    "space-md": { type: "number", value: 24 },
    "color-accent": { type: "color", value: "#B8325E" },
    "radius-full": { type: "number", value: 9999 },
    "v2-sans": { type: "string", value: "Noto Sans SC" },
    brand: { type: "color", value: "#111111" },
  }, ledger);
  assert.equal(tokens.get("--space-md").value, "24px");
  assert.equal(tokens.get("--color-accent").value, "#b8325e", "hex is normalised to lower case");
  assert.equal(tokens.get("--radius-full").value, "9999px");
  assert.equal(tokens.get("--font-v2-sans").value, '"Noto Sans SC"', "a name without a group gets one");
  assert.equal(tokens.get("--color-brand").value, "#111111");
  assert.equal(refs.get("space-md"), "--space-md");
});

test("ids that this format cannot hold are rewritten, and kept unique", () => {
  const json = {
    children: [{ id: "ok", type: "frame", children: [{ id: "not ok!", type: "frame" }, { id: "ok", type: "frame" }] }],
  };
  // The map is keyed by node, because a pen file may repeat an id.
  const mapping = idMapFor(json);
  const nodes = [json.children[0], json.children[0].children[0], json.children[0].children[1]];
  const assigned = nodes.map((node) => mapping.get(node));
  assert.equal(assigned[0], "ok", "a legal id is kept");
  assert.match(assigned[1], /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, "a rewritten id is legal");
  assert.notEqual(assigned[1], "ok");
  assert.notEqual(assigned[2], "ok", "the duplicate is renamed too");
  assert.equal(new Set(assigned).size, assigned.length, "every node gets its own id");
});

// -- style mapping ------------------------------------------------------------

test("a vertical frame becomes a flex column with its gap", () => {
  const style = styleFromNode({ type: "frame", layout: "vertical", gap: 20, padding: 28 }, new Map(), createLedger());
  assert.match(style, /display:flex/);
  assert.match(style, /flex-direction:column/);
  assert.match(style, /gap:20px/);
  assert.match(style, /padding:28px/);
});

test("space_between becomes space-between, and start becomes flex-start", () => {
  const style = styleFromNode({ type: "frame", layout: "vertical", justifyContent: "space_between", alignItems: "start" }, new Map(), createLedger());
  assert.match(style, /justify-content:space-between/);
  assert.match(style, /align-items:flex-start/);
});

test("a fill is a background on a box and a colour on text", () => {
  const box = styleFromNode({ type: "frame", fill: "#EFE7E4" }, new Map(), createLedger());
  assert.match(box, /background-color:#efe7e4/);
  const text = styleFromNode({ type: "text", fill: "#2A1F22", fontSize: 14 }, new Map(), createLedger(), { text: true });
  assert.match(text, /color:#2a1f22/);
  assert.ok(!/background-color/.test(text), "a text fill is not a background");
});

test("a reference fill becomes a var()", () => {
  const refs = new Map([["v2-ink", "--v2-ink"]]);
  const style = styleFromNode({ type: "text", fill: "$v2-ink", fontSize: 14 }, refs, createLedger(), { text: true });
  assert.match(style, /color:var\(--v2-ink\)/);
});

test("a pill radius becomes 50 percent", () => {
  assert.match(styleFromNode({ type: "frame", cornerRadius: 9999 }, new Map(), createLedger()), /border-radius:50%/);
  assert.match(styleFromNode({ type: "frame", cornerRadius: 24 }, new Map(), createLedger()), /border-radius:24px/);
});

test("a stroke becomes a border, and a per-side stroke keeps its sides", () => {
  const uniform = styleFromNode({ type: "frame", stroke: "#8A6E74", strokeWidth: 1 }, new Map(), createLedger());
  assert.match(uniform, /border:1px solid #8a6e74/);
  const ledger = createLedger();
  const sided = styleFromNode({ type: "frame", stroke: "#8A6E74", strokeWidth: { top: 1 } }, new Map(), ledger);
  assert.match(sided, /border-width:1px 0 0 0/);
  assert.equal(ledger.converted.perSideStroke, 1);
});

test("an outer shadow becomes a box-shadow, and an inner one is counted as lost", () => {
  const ledger = createLedger();
  const outer = styleFromNode({ type: "frame", effect: { type: "shadow", shadowType: "outer", color: "#B8325E33", offset: { x: 0, y: 6 }, blur: 16 } }, new Map(), ledger);
  assert.match(outer, /box-shadow:0 6px 16px #b8325e33/, "offsets are normalised, so a zero x is 0 and not 0px");
  const inner = styleFromNode({ type: "frame", effect: { type: "shadow", shadowType: "inner", color: "#00000040" } }, new Map(), ledger);
  assert.ok(!/box-shadow/.test(inner));
  assert.equal(ledger.lost.innerShadow, 1);
});

test("a linear gradient becomes a background-image and a radial one is counted as lost", () => {
  const ledger = createLedger();
  const linear = styleFromNode({
    type: "frame",
    fill: { type: "gradient", gradientType: "linear", rotation: 180, colors: [{ color: "#2E1F2600", position: 0 }, { color: "#2E1F26B3", position: 1 }] },
  }, new Map(), ledger);
  assert.match(linear, /background-image:linear-gradient\(360deg,#2e1f2600 0%,#2e1f26b3 100%\)/);
  const radial = styleFromNode({ type: "frame", fill: { type: "gradient", gradientType: "radial", colors: [{ color: "#000000", position: 0 }, { color: "#ffffff", position: 1 }] } }, new Map(), ledger);
  assert.ok(!/background-image/.test(radial));
  assert.equal(ledger.lost["gradient:radial"], 1);
});

test("an image fill becomes a background image sized to cover", () => {
  const style = styleFromNode({ type: "frame", fill: { type: "image", url: "https://example.com/a.jpg", mode: "fill" } }, new Map(), createLedger());
  assert.match(style, /background-image:url\("https:\/\/example.com\/a.jpg"\)/);
  assert.match(style, /background-size:cover/);
});

test("clip becomes overflow hidden", () => {
  const style = styleFromNode({ type: "frame", clip: true, width: 343 }, new Map(), createLedger());
  assert.match(style, /overflow:hidden/);
});

test("textGrowth is counted when it is what supplies the width", () => {
  // With an explicit width, `fixed-width` says nothing new. Without one, it is
  // the only reason the text wraps, so the reader records that it used it.
  const withWidth = createLedger();
  styleFromNode({ type: "frame", textGrowth: "fixed-width", width: 343 }, new Map(), withWidth);
  assert.equal(withWidth.converted.textGrowth ?? 0, 0, "an explicit width already said it");

  const withoutWidth = createLedger();
  const style = styleFromNode({ type: "frame", textGrowth: "fixed-width" }, new Map(), withoutWidth);
  assert.equal(withoutWidth.converted.textGrowth, 1);
  assert.match(style, /white-space:normal/);
});

// -- the real file ------------------------------------------------------------

test("the real reference file imports with a clean ledger", { skip: !hasReference }, () => {
  const { html, ledger } = importPen(reference(), { title: "miniprogram" });

  // Shape.
  assert.equal(ledger.pages, 26, `expected 26 artboards, got ${ledger.pages}`);
  assert.equal(ledger.components.found, 23, "23 reusable nodes");
  assert.equal(ledger.components.instances, 239, "239 instances");

  // Nothing unknown: every property pen wrote is either mapped or counted.
  assert.deepEqual(ledger.unmapped, {}, `unmapped properties: ${JSON.stringify(ledger.unmapped)}`);

  // What is lost is only what this format has no spelling for. The list is
  // closed on purpose: a new loss must be a deliberate decision, not a surprise
  // a user discovers after importing.
  const ALLOWED_LOSSES = /^(innerShadow|gradient:|nodeType:|topLevelType:|imageFill|disabledFill|perCornerRadius|cornerRadiusArrayLength)/;
  for (const name of Object.keys(ledger.lost)) {
    assert.match(name, ALLOWED_LOSSES, `unexpected loss: ${name}`);
  }

  // The reference file pins these three exactly, so a mapping regression shows
  // up as a number rather than as a silently different file.
  assert.equal(ledger.lost["gradient:radial"] ?? 0, 0, "the file uses linear gradients only");
  assert.equal(ledger.lost["gradient:mesh"] ?? 0, 0);
  assert.equal(ledger.lost.innerShadow ?? 0, 0, "every effect in this file is an outer shadow");
  assert.equal(ledger.lost.perCornerRadius ?? 0, 1, "one node has four different corner radii");

  // The output parses and validates.
  const doc = parse(html);
  assert.equal(pagesOf(doc).length, 26);
  const errors = validateDesign(doc).filter((d) => d.severity === "error");
  assert.deepEqual(errors, [], `import produced ${errors.length} errors: ${JSON.stringify(errors.slice(0, 3), null, 2)}`);
});

test("the import is deterministic", { skip: !hasReference }, () => {
  const once = importPen(reference());
  const twice = importPen(reference());
  assert.equal(once.html, twice.html, "two imports of one file are the same bytes");
  assert.deepEqual(once.ledger, twice.ledger);
});

test("artboard positions become data-canvas, and names survive", { skip: !hasReference }, () => {
  const { html } = importPen(reference());
  const doc = parse(html);
  const pages = pagesOf(doc);
  const byName = new Map(pages.map((p) => [getAttr(p, "data-name"), p]));
  assert.ok(byName.has("首页"), "a Chinese artboard name survives");
  assert.ok(byName.has("组件库 v2"), "the component library artboard survives as a page");
  const first = byName.get("首页");
  assert.equal(getAttr(first, "data-canvas"), "600,0", "the artboard's own x/y");
  const library = byName.get("组件库 v2");
  assert.equal(getAttr(library, "data-library"), "true", "the library artboard is marked");
});

test("component ids are stable, so a reference still resolves", { skip: !hasReference }, () => {
  const { html } = importPen(reference());
  const doc = parse(html);
  const components = new Set();
  const instances = [];
  const visit = (node) => {
    if (node.kind === "element") {
      const type = getAttr(node, "data-type");
      if (type === "component") components.add(getAttr(node, "data-id"));
      if (type === "instance") instances.push(getAttr(node, "data-ref"));
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(doc);
  assert.equal(components.size, 23);
  assert.equal(instances.length, 239);
  const dangling = instances.filter((ref) => !components.has(ref));
  assert.deepEqual(dangling, [], `${dangling.length} instances point at nothing`);
});

test("overrides survive, keyed by the descendant's own id", { skip: !hasReference }, () => {
  const { html, ledger } = importPen(reference());
  assert.ok(ledger.components.overridesApplied > 100, `only ${ledger.components.overridesApplied} instances carried overrides`);
  const doc = parse(html);
  let withOverrides = 0;
  let totalKeys = 0;
  const visit = (node) => {
    if (node.kind === "element" && getAttr(node, "data-type") === "instance") {
      const raw = getAttr(node, "data-overrides");
      if (raw) {
        withOverrides += 1;
        const parsed = JSON.parse(raw);
        totalKeys += Object.keys(parsed).length;
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(doc);
  assert.equal(withOverrides, ledger.components.overridesApplied);
  assert.ok(totalKeys > 0, "the overrides have keys");
});

test("the ledger reads as one line a person can act on", { skip: !hasReference }, () => {
  const { ledger } = importPen(reference());
  const line = ledgerLine(ledger);
  assert.match(line, /26 pages/);
  assert.match(line, /23 components/);
  assert.match(line, /239 instances/);
  assert.match(line, /lost: /, "the losses are named, not hidden");
});

test("no element lost its data-id, and every id is unique in the source", { skip: !hasReference }, () => {
  const { html } = importPen(reference());
  const doc = parse(html);
  const ids = [];
  const visit = (node) => {
    if (node.kind === "element") {
      const id = getAttr(node, "data-id");
      if (id) ids.push(id);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(doc);
  assert.ok(ids.length > 1500, `only ${ids.length} ids`);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], "the import produced duplicate ids");
});

test("the imported file is canonical, so its first write is a no-op", { skip: !hasReference }, () => {
  const { html } = importPen(reference());
  const doc = parse(html);
  assert.equal(doc.source, html);
});
