/**
 * The `.pen` reader, against the real thing.
 *
 * The reference file is 706 KB, 19698 lines, 26 artboards and 1541 nodes. It is
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, getAttr, findById, pagesOf, walk } from "../lib/parse.mjs";
import { validateDesign } from "../lib/validate.mjs";
import {
  importPen, parsePen, stripJsonComments, createLedger, tokensFromVariables,
  idMapFor, styleFromNode, ledgerLine,
} from "../lib/readers/pen.mjs";
import { exportAllPages } from "../lib/export-html.mjs";
import { iconBody } from "../lib/icons.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  // Pen's own export writes `system-ui, sans-serif` after every family it
  // emits. A list that ends in a webfont ends in something the machine may not
  // have, and the fallback is then the document default.
  assert.equal(tokens.get("--font-v2-sans").value, '"Noto Sans SC", system-ui, sans-serif', "a name without a group gets one, and a family list gets a fallback");
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

test("a direct child of a page knows its parent's axis", () => {
  // `fill_container` means "share the main axis" in a row and "stretch across" in a column,
  // and the two are different declarations. The artboard loop built its child context by
  // hand and left the axis out, so every direct child of a page was read as if its parent's
  // axis were unknown and `fill_container` fell back to `width:100%`. On a row page that is
  // wrong by exactly the width of the sibling before it: the Swiss Clean dashboard's content
  // took the full 1440px beside its 240px sidebar and the page's `overflow:hidden` cut those
  // 240px off the right edge — the Export button and half the last metric card.
  //
  // It hid for as long as it did because all 25 pages of the reference file have
  // `layout: vertical`, and in a column `100%` and `stretch` happen to agree.
  const styleOf = (html, id) => (new RegExp(`data-id="${id}"[^>]*style="([^"]*)"`).exec(html) ?? [])[1] ?? "";

  const row = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "row", name: "Dashboard", width: 1440, height: 900,
      children: [
        { type: "frame", id: "side", name: "Sidebar", width: 240, height: "fill_container", layout: "vertical" },
        { type: "frame", id: "content", name: "Content", width: "fill_container", height: "fill_container", layout: "vertical" },
      ],
    }],
  });
  const built = importPen(row).html;
  assert.match(styleOf(built, "side"), /width:240px/);
  assert.match(styleOf(built, "content"), /flex:1 1 0%/, `in a row, fill_container shares the main axis: ${styleOf(built, "content")}`);
  assert.ok(!/width:100%/.test(styleOf(built, "content")), "it must not take the page's whole width beside a sibling");

  // The same child on a column page stretches across, which is what `100%` already was —
  // the reason the reference file never showed the defect.
  const column = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "col", name: "Page", width: 402, height: 900, layout: "vertical",
      children: [{ type: "frame", id: "inner", name: "Content", width: "fill_container", layout: "vertical" }],
    }],
  });
  assert.match(styleOf(importPen(column).html, "inner"), /width:100%/, "in a column, fill_container stretches");
});

test("a `layout:none` frame places its children where pen put them", () => {
  // Pen positions these children by their own x and y; CSS positions them by `left`/`top`
  // inside a containing block. Reading `none` as "write no declarations" left every child a
  // block box, so children that overlap in pen stacked in the file: the status bar's
  // battery fill rendered below the battery body instead of inside it.
  const parent = styleFromNode({ type: "frame", layout: "none", width: 27, height: 13 }, new Map(), createLedger());
  assert.match(parent, /position:relative/, "the frame has to be the containing block");

  const child = styleFromNode({ type: "shape", x: 2, y: 2, width: 21, height: 9 }, new Map(), createLedger(), { parentLayoutNone: true });
  assert.match(child, /position:absolute/);
  assert.match(child, /left:2px/);
  assert.match(child, /top:2px/);

  // A child that is in flow is not placed: the same node under a row stays a flex item.
  const flowed = styleFromNode({ type: "shape", x: 2, y: 2, width: 21, height: 9 }, new Map(), createLedger(), { parentIsRow: true });
  assert.ok(!/position:absolute/.test(flowed), "a child in flow must not be pulled out of it");
});

test("the ledger calls `layout:none` a conversion only when it converts something", () => {
  // It was counted under `converted`, whose own definition is "a value was rewritten to the
  // one spelling this format allows", while nothing at all was written for those frames.
  // The count and the rewrite have to be one decision, so this asserts both together.
  const ledger = createLedger();
  const style = styleFromNode({ type: "frame", layout: "none", width: 27, height: 13 }, new Map(), ledger);
  assert.equal(ledger.converted.layoutNone, 1);
  assert.match(style, /position:relative/, "counted as converted, so something is converted");
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

test("a pill radius stays a pixel radius, because 50% draws an ellipse", () => {
  // A percentage radius measures against both axes, so `50%` on a 375x48 button
  // is an ellipse and not the pill the author drew.
  assert.match(styleFromNode({ type: "frame", cornerRadius: 9999 }, new Map(), createLedger()), /border-radius:9999px/);
  assert.match(styleFromNode({ type: "frame", cornerRadius: 24 }, new Map(), createLedger()), /border-radius:24px/);
});

test("pen's ellipse becomes data-kind plus the one radius that draws an ellipse", () => {
  // pen's `ellipse` is a true ellipse: `rx` and `ry` differ when the box is not
  // square, which is exactly what a percentage radius draws. It goes on the node
  // and not into a `[data-kind="ellipse"]` rule, because `export` strips the
  // design attributes and the rule would stop matching in the deliverable.
  const style = styleFromNode({ type: "ellipse", fill: "#FCE7F3" }, new Map(), createLedger());
  assert.match(style, /background-color:#fce7f3/);
  assert.match(style, /border-radius:50%/);
});

test("a stroke with no paint is not drawn, and the ledger says so", () => {
  // `border` needs a colour, and a paint-less stroke has none. Defaulting to black — which
  // this did — invents a line the design does not have. The evidence is in the reference
  // artboards: every painted stroke follows its page (the same battery border is #000000 on
  // the light pages and #ffffff on the dark ones, and the nine notification buttons carry
  // nine different colours), while the 18 paint-less ones are the identical
  // `{align:"inside",thickness:1}` on all nine styles. Structure, not design — and the
  // invented line hides exactly where nobody looks, because black on #141417 is invisible
  // and black on white is a box.
  const painted = styleFromNode({ type: "frame", stroke: { thickness: 2, fill: "#000000" } }, new Map(), createLedger());
  assert.match(painted, /border:2px solid #000000/, "a stroke that has a paint is drawn as one");

  const bare = createLedger();
  const style = styleFromNode({ type: "frame", width: 402, stroke: { align: "inside", thickness: 1 } }, new Map(), bare);
  assert.ok(!/border/.test(style), `a paint-less stroke draws nothing, got: ${style}`);
  assert.equal(bare.lost.strokeWithoutPaint, 1, "a silent skip would be a silent loss");

  // A paint-less per-side stroke is the same decision, and the same single count.
  const sides = createLedger();
  const perSide = styleFromNode({ type: "frame", stroke: { thickness: { right: 1 } } }, new Map(), sides);
  assert.ok(!/border/.test(perSide), `a paint-less divider draws nothing, got: ${perSide}`);
  assert.equal(sides.lost.strokeWithoutPaint, 1);
  assert.equal(sides.converted.perSideStroke, undefined, "and it is not also counted as a conversion");
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
  // 180 means 180. Pen's own exporter writes the node's `rotation` straight
  // through as the CSS angle, and the two files it was checked against are a
  // 180deg caption scrim and a 135deg banner.
  assert.match(linear, /background-image:linear-gradient\(180deg,#2e1f2600 0%,#2e1f26b3 100%\)/);
  const radial = styleFromNode({ type: "frame", fill: { type: "gradient", gradientType: "radial", colors: [{ color: "#000000", position: 0 }, { color: "#ffffff", position: 1 }] } }, new Map(), ledger);
  assert.ok(!/background-image/.test(radial));
  assert.equal(ledger.lost["gradient:radial"], 1);
});

test("an image fill's mode picks the background-size that means the same thing", () => {
  const style = (mode) => styleFromNode(
    { type: "frame", fill: mode ? { type: "image", url: "https://example.com/a.jpg", mode } : { type: "image", url: "https://example.com/a.jpg" } },
    new Map(),
    createLedger(),
  );
  assert.match(style("cover"), /background-image:url\("https:\/\/example.com\/a.jpg"\)/);
  assert.match(style("cover"), /background-size:cover/);
  assert.match(style("contain"), /background-size:contain/);
  // Two spellings, both measured: pen's own export of the reference design writes
  // `background-size: cover` ten times and `background-size: 100% 100%` once.
  assert.match(style("fill"), /background-size:100% 100%/, "pen's `fill` stretches the image; `cover` crops it");
  assert.match(style(), /background-size:cover/, "a fill that states no mode is covered, which is what pen exports");
});

test("an image fill mode this format cannot draw is reported, not rounded to cover", () => {
  // The reader used to write `cover` for every image fill and count the rest as
  // unmapped, so a stretched photo shipped cropped — a difference nobody looks
  // for, in a direction the file never asked for.
  const ledger = createLedger();
  const style = styleFromNode(
    { type: "frame", fill: { type: "image", url: "https://example.com/a.jpg", mode: "tile" } },
    new Map(),
    ledger,
  );
  assert.ok(!/background-size/.test(style), `a mode we cannot draw must not become a size we never read: ${style}`);
  assert.deepEqual(ledger.unmapped, { "fillMode:tile": 1 });
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
  assert.equal(ledger.refs.found, 239, "239 references");
  assert.equal(ledger.refs.inlined, 239, "and every one of them is inlined");
  assert.equal(ledger.refs.overridesApplied, 140, "140 references carried field-level patches");
  assert.equal(ledger.refs.overrideFieldsDropped, 0, "no patch field went unmapped");

  // Nothing unknown: every property pen wrote is either mapped or counted.
  assert.deepEqual(ledger.unmapped, {}, `unmapped properties: ${JSON.stringify(ledger.unmapped)}`);

  // What is lost is only what this format has no spelling for. The list is
  // closed on purpose: a new loss must be a deliberate decision, not a surprise
  // a user discovers after importing.
  const ALLOWED_LOSSES = /^(innerShadow|gradient:|nodeType:|topLevelType:|imageFill|disabledFill|perCornerRadius|cornerRadiusArrayLength|strokeWithoutPaint)/;
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

/**
 * The committed example is a fresh import of the reference file, byte for byte.
 *
 * It was not, for a while. `examples/miniprogram.html` had ten gradients at `360deg` and
 * seven at `315deg` where the reader now writes `180deg` and `225deg` — exactly the output
 * of the `rotation + 180` formula this module's own comment calls 90 degrees wrong — and
 * eighteen overrides that wrote text into an `<svg>` instead of swapping the glyph. Every
 * other test passed: the ledger tests above check counts and losses, and the rename tests
 * take their baseline from whatever the file happens to contain. Nothing compared the
 * artifact to the reader, so it drifted for as long as nobody looked at it.
 *
 * Regenerate with:
 *
 *   node design.mjs import pen <the .pen> -o examples/miniprogram.html --title miniprogram
 */
test("the committed example is what the reader produces today", { skip: !hasReference }, () => {
  const committed = readFileSync(join(ROOT, "examples", "miniprogram.html"), "utf8");
  const fresh = importPen(reference(), { title: "miniprogram" }).html;
  assert.notEqual(committed.length, 0, "examples/miniprogram.html is empty");
  assert.equal(
    committed,
    fresh,
    "examples/miniprogram.html is stale; regenerate it with:\n"
      + "  node design.mjs import pen " + REFERENCE + " -o examples/miniprogram.html --title miniprogram",
  );
});

test("artboard positions become data-canvas, and names survive", { skip: !hasReference }, () => {
  const { html } = importPen(reference());
  const doc = parse(html);
  const pages = pagesOf(doc);
  const byName = new Map(pages.map((p) => [getAttr(p, "data-name"), p]));
  assert.ok(byName.has("首页"), "a Chinese artboard name survives");
  assert.ok(byName.has("组件库 v2"), "the artboard that holds the masters survives as a page");
  const first = byName.get("首页");
  assert.equal(getAttr(first, "data-canvas"), "600,0", "the artboard's own x/y");
  const masters = byName.get("组件库 v2");
  assert.equal(getAttr(masters, "data-library"), null, "no page is scaffolding: an artboard is a page");
});

test("every reference is inlined, and no id is spent twice", { skip: !hasReference }, () => {
  const { html, ledger } = importPen(reference());
  const doc = parse(html);
  const ids = [];
  const types = new Set();
  const visit = (node) => {
    if (node.kind === "element") {
      const id = getAttr(node, "data-id");
      if (id) ids.push(id);
      types.add(getAttr(node, "data-type"));
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(doc);

  assert.equal(ledger.refs.inlined, 239);
  assert.ok(!types.has("instance") && !types.has("component"), "the format has neither type");
  // The 1541 ids of the source, plus one subtree per reference: the copies are
  // bytes in this file, not a reference a renderer resolves later.
  assert.ok(ids.length > 2000, `only ${ids.length} ids: the copies are not in the file`);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], "an inlined copy must not reuse the master's ids");
});

test("an override is baked into the copy it belongs to", () => {
  // A reference may patch fields of the node it points at. The file that comes out
  // stores the result, not the patch: there is no renderer left to apply one.
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      {
        type: "frame", id: "lib", name: "Masters", width: 375, height: 100,
        children: [{
          type: "frame", id: "card", name: "Card", reusable: true, layout: "vertical", width: 320, gap: 4,
          children: [
            { type: "text", id: "title", name: "Title", content: "Card", width: 200, height: 24 },
            { type: "icon", id: "ico", name: "Icon", icon: "sparkles", library: "lucide", width: 22, height: 22 },
          ],
        }],
      },
      {
        type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{
          type: "ref", id: "used", name: "Card", ref: "card",
          descendants: { title: { content: "你好", fontSize: 20 }, ico: { icon: "gem", enabled: false } },
        }],
      },
    ],
  });
  const { html, ledger } = importPen(pen);
  assert.equal(ledger.refs.overridesApplied, 1);
  assert.equal(ledger.refs.overrideFieldsDropped, 0);

  assert.match(html, /<p data-id="used__title"[^>]*>你好<\/p>/, "the patched text is the copy's text");
  assert.match(html, /data-id="used__title"[^>]*font-size:20px/, "and the patched declaration is in its style");
  assert.match(html, /data-id="used__ico"[^>]*data-hidden="true"/, "a hidden node says so on the copy");
  assert.match(html, /data-icon="gem"/, "the swapped glyph is the copy's glyph");
  assert.ok(!/data-overrides/.test(html), "the file stores the result, not a patch to apply later");
  assert.ok(!/data-ref/.test(html), "and no reference survives the import");

  // The master is untouched by the patch: it is still the card it was.
  assert.match(html, /<p data-id="title"[^>]*>Card<\/p>/);
});

test("a field with no spelling here is counted, not dropped quietly", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      { type: "frame", id: "lib", name: "Masters", width: 375, height: 100,
        children: [{ type: "frame", id: "card", name: "Card", reusable: true, width: 320, children: [{ type: "text", id: "t", name: "T", content: "x", width: 40, height: 20 }] }] },
      { type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{ type: "ref", id: "used", name: "Card", ref: "card", descendants: { t: { rotation: 45 } } }] },
    ],
  });
  const { ledger } = importPen(pen);
  assert.equal(ledger.refs.overrideFieldsDropped, 1);
  assert.equal(ledger.unmapped["override:rotation"], 1, JSON.stringify(ledger.unmapped));
});

test("a swapped glyph is drawn, not named", { skip: !hasReference }, () => {
  const { html, ledger } = importPen(reference());
  // The reference file swaps a glyph on 18 references — 8 on 首页, 7 on 月嫂详情,
  // 3 on 我的 — and the 18 use 16 different names.
  assert.equal(ledger.converted.iconOverrides, 18);

  const glyphs = new Map();
  for (const match of html.matchAll(/<svg[^>]*data-icon="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/g)) {
    glyphs.set(match[1], match[2]);
  }
  assert.ok(glyphs.has("gem") && glyphs.has("graduation-cap"), "the swapped names are there");
  for (const [name, body] of glyphs) {
    assert.match(body.trim(), /^<(path|circle|rect|line|polyline|ellipse)/, `${name} has no geometry`);
  }
  // Text inside an `<svg>` that is not inside a `<text>` draws nothing, so a bare
  // name is a blank box that validates.
  assert.ok(!/>\s*(gem|graduation-cap)\s*</.test(html), "a glyph name must not be written as text");
});

test("the ledger reads as one line a person can act on", { skip: !hasReference }, () => {
  const { ledger } = importPen(reference());
  const line = ledgerLine(ledger);
  assert.match(line, /26 pages/);
  assert.match(line, /239 references inlined/);
  assert.match(line, /140 with overrides/);
  assert.match(line, /lost: /, "the losses are named, not hidden");
});

test("every element has an id, and no id is spent twice", { skip: !hasReference }, () => {
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
  assert.ok(ids.length > 2000, `only ${ids.length} ids`);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], "the import produced duplicate ids");
});

test("the imported file is canonical, so its first write is a no-op", { skip: !hasReference }, () => {
  const { html } = importPen(reference());
  const doc = parse(html);
  assert.equal(doc.source, html);
});

// -- layout defaults, pinned because each one was a real defect ----------------

test("an absent layout is a row, not a column", () => {
  // Pen's default layout is horizontal. Reading it as a column collapsed 208
  // frames in the reference file, so this is pinned by name.
  const row = styleFromNode({ type: "frame", width: "fill_container", children: [{ type: "text", id: "t" }] }, new Map(), createLedger(), { parentIsColumn: true });
  assert.match(row, /flex-direction:row/);
  assert.match(row, /width:100%/);

  const column = styleFromNode({ type: "frame", layout: "vertical", gap: 8 }, new Map(), createLedger(), {});
  assert.match(column, /flex-direction:column/);

  const none = styleFromNode({ type: "frame", layout: "none" }, new Map(), createLedger(), {});
  assert.ok(!/display:flex/.test(none), "layout none has no flow");
});

test("both of pen's layout defaults are flex-start, and the export says so", () => {
  // Every row in the reference file that states no `alignItems` comes out of
  // pen's own exporter as `align-items: flex-start`, and centring instead moved
  // each nanny card's text block down by 2px against its 120px photo. Measured
  // over the 25 artboards: 6.782 → 6.303 mean difference.
  const row = styleFromNode({ type: "frame", children: [{ type: "text", id: "t" }] }, new Map(), createLedger(), {});
  assert.match(row, /align-items:flex-start/);
  const column = styleFromNode({ type: "frame", layout: "vertical", gap: 8 }, new Map(), createLedger(), {});
  assert.match(column, /align-items:flex-start/);
  // An explicit value still wins.
  const centred = styleFromNode({ type: "frame", alignItems: "center", children: [{ type: "text", id: "t" }] }, new Map(), createLedger(), {});
  assert.match(centred, /align-items:center/);
});

test("fill_container is spelled by the parent's axis", () => {
  // In a row the width shares the main axis; in a column it stretches across.
  const inRow = styleFromNode({ type: "frame", width: "fill_container", children: [{ type: "text", id: "t" }] }, new Map(), createLedger(), { parentIsRow: true });
  assert.match(inRow, /flex:1 1 0%/);
  assert.match(inRow, /min-width:0/);
  assert.ok(!/align-self/.test(inRow), `stretching across a row is a height change: ${inRow}`);

  const inColumn = styleFromNode({ type: "frame", width: "fill_container", children: [{ type: "text", id: "t" }] }, new Map(), createLedger(), { parentIsColumn: true });
  // `align-self:stretch` is the obvious spelling and the wrong one: the parent's
  // own `align-items` overrides it, and pen's column default is `flex-start`.
  assert.match(inColumn, /width:100%/);
  assert.ok(!/flex:1/.test(inColumn), `sharing the main axis of a column is a height change: ${inColumn}`);
});

test("a text node hugs rather than filling, so it cannot stretch vertically", () => {
  const text = styleFromNode({ type: "text", width: "fill_container", content: "hi" }, new Map(), createLedger(), { text: true, parentIsRow: true });
  assert.match(text, /width:fit-content/);
  assert.ok(!/align-self/.test(text), `a row's cross axis is vertical: ${text}`);
});

test("an artboard's own layout reaches the page", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "modal", name: "Modal", width: 375, height: 812,
      layout: "vertical", justifyContent: "end", clip: true, fill: "#2E1F26A6",
      children: [{ type: "frame", id: "sheet", name: "Sheet", width: "fill_container", height: 200 }],
    }],
  });
  const { html } = importPen(pen);
  const page = html.slice(html.indexOf("<section"), html.indexOf(">", html.indexOf("<section")) + 1);
  assert.match(page, /justify-content:flex-end/, "a bottom sheet needs its artboard's alignment");
  assert.match(page, /display:flex/);
  assert.match(page, /flex-direction:column/);
});

test("pen 2.6 writes a glyph as `icon_font`, and it is the same glyph", () => {
  // The reference file is 2.6 and spells every one of its 233 glyphs this way; the test
  // below covers 2.19's `icon`. Both draw the same thing, so both have to be read. Until
  // they were, all 233 were dropped in silence — and `unmapped: {}` still said that
  // nothing was unknown, because an unknown *node type* was counted somewhere else.
  const pen = JSON.stringify({
    version: "2.6",
    children: [{
      type: "frame", id: "board", name: "Board", width: 375, height: 812,
      children: [{
        type: "icon_font", id: "ico", name: "notifIcon", iconFontName: "bell",
        iconFontFamily: "lucide", width: 22, height: 22, fill: "#FFFFFF",
      }],
    }],
  });
  const { html, ledger } = importPen(pen);
  assert.match(html, /data-icon="bell"/, "the glyph name survives as the label");
  assert.match(html, /data-icon-library="lucide"/, "the library in 2.6's spelling is the same library");
  assert.match(html, /viewBox="0 0 24 24"/, "a named glyph is drawn on the set's grid");
  assert.match(html, /<path d="[^"]+"/, "the geometry is the drawing; the name is only its label");
  assert.match(html, /color:#ffffff/, "a fill on a glyph is a colour, not a background");
  assert.equal(ledger.lost["nodeType:icon_font"], undefined, "an icon_font is no longer an unknown node type");
  assert.equal(ledger.converted.iconFont, 1, "the older spelling is counted as the rewrite it is");
});

test("a pen `path` keeps its own outline, on the outline's own grid", () => {
  // A `path` node has no glyph name — the outline is the drawing — and the grid
  // it is drawn on is the OUTLINE'S box, not the node's. The two are the same for
  // every glyph in the reference file, which is why the node's box looked right
  // for so long; they part company the moment an outline is scaled, and pen's own
  // export settles which one wins: a 366×366 arrow whose outline is 14×14 is
  // exported as `viewBox="0 0 14 14"` on a 366×366 element. So the outline is
  // measured. This fixture is one bar — 2.133 × 1.146 in the corner of a
  // 19.2 × 12.226 node — and it is now scaled into the node's box, as pen scales
  // it, instead of being drawn at a tenth of its size in one corner.
  const pen = JSON.stringify({
    version: "2.6",
    children: [{
      type: "frame", id: "board", name: "Board", width: 375, height: 812,
      children: [{
        type: "path", id: "sig", name: "Cellular Connection", width: 19.2, height: 12.226,
        geometry: "M19.2 1.14623c0-0.63304-0.47756-1.14623-1.06667-1.14623l-1.06666 0z",
        fill: "#000000ff", fillRule: "evenodd",
      }],
    }],
  });
  const { html, ledger } = importPen(pen);
  assert.match(html, /data-icon="cellular-connection"/, "the layer name becomes the glyph name");
  assert.match(html, /viewBox="17\.067 0 2\.133 1\.146"/, "the outline's own box is its grid");
  assert.match(html, /<path d="M19\.2 1\.14623[^"]*" fill="currentColor" fill-rule="evenodd">/, "the outline is written verbatim, filled, and even-odd");
  assert.equal(ledger.lost["nodeType:path"], undefined, "a path is no longer dropped");
  assert.equal(ledger.converted.pathAsGeometry, 1);
});

// -- an outline that is stroked, or turned ------------------------------------

test("a stroked path is drawn with its stroke, not with a border around its box", () => {
  // The arrow from pen's welcome document, at the size pen draws it: a 14×14
  // outline in a 366×366 node, stroked 50 wide with round ends. It used to import
  // as a `<svg>` with `border:50px solid` — a square ring around an empty box —
  // and a `<path fill="currentColor">`, which painted the chevron solid black.
  // pen's own export of the same node is the reference here: `viewBox="0 0 14 14"`,
  // `fill:none`, `stroke-width:50` and `vector-effect:non-scaling-stroke`.
  const pen = JSON.stringify({
    version: "2.13",
    children: [{
      type: "frame", id: "board", name: "Welcome", width: 1000, height: 1458, layout: "none",
      children: [{
        type: "path", id: "arrow", x: 267.801, y: 632, width: 366, height: 366,
        geometry: "M7 0l0 14m7-7l-7 7-7-7",
        stroke: "#ff8302ff", strokeWidth: 50, strokeLinecap: "round", strokeLinejoin: "round",
      }],
    }],
  });
  const { html, ledger } = importPen(pen);
  assert.match(html, /viewBox="0 0 14 14"/, "the grid is the outline's box, so the drawing scales into the node");
  assert.match(html, /<path d="M7 0l0 14m7-7l-7 7-7-7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="50" vector-effect="non-scaling-stroke">/);
  assert.match(html, /color:#ff8302ff/, "the stroke's paint is the element's colour, and the outline references it");
  assert.match(html, /overflow:visible/, "half of a 50-wide stroke lies outside the outline");
  const element = html.slice(html.indexOf("<svg "), html.indexOf("</svg>"));
  assert.ok(!/border:/.test(element), "a glyph's stroke is not a border on its box");
  assert.equal(ledger.lost.glyphFill, undefined, "there is no fill to lose");
});

test("a rotated outline is turned in its own coordinates, and the ledger says so", () => {
  // This format has no `transform` (the table refuses `transform` and `rotate` by
  // name), so a turned outline is rewritten rather than wrapped. pen measures
  // rotation counter-clockwise and CSS measures it clockwise, so the outline is
  // turned by `-rotation`; pen turns the element about its top-left corner, which
  // is the viewBox's origin.
  const pen = JSON.stringify({
    version: "2.13",
    children: [{
      type: "frame", id: "board", name: "Welcome", width: 1000, height: 1458, layout: "none",
      children: [{
        type: "path", id: "arrow", x: 267.801, y: 632, width: 366, height: 366, rotation: -45,
        geometry: "M7 0l0 14m7-7l-7 7-7-7",
        stroke: "#ff8302ff", strokeWidth: 50, strokeLinecap: "round", strokeLinejoin: "round",
      }],
    }],
  });
  const { html, ledger } = importPen(pen);
  // (7,0) turned 45° clockwise about (0,0) is (4.9497, 4.9497); (7,14) is
  // (-4.9497, 14.8492).
  assert.match(html, /<path d="M4\.9497 4\.9497L-4\.9497 14\.8492M4\.9497 14\.8492L-4\.9497 14\.8492L-4\.9497 4\.9497"/);
  assert.equal(ledger.converted.bakedRotation, 1, "the geometry is no longer the bytes pen wrote, so it is counted");
  assert.equal(ledger.lost.rotation, undefined, "and it is not also counted as a loss");
  assert.match(ledger.notes.join("\n"), /rotated -45 degrees/, "the ledger names the node and the angle");
  assert.match(html, /overflow:visible/, "a turned outline leaves the box it was measured in");
});

test("a rotation this format cannot express is named, and counted once", () => {
  // A frame's rotation cannot be baked: every child would have to move with it,
  // and a child's own placement is a `left`/`top` pair. So it is drawn upright and
  // the ledger says which node and by how much.
  const pen = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "board", name: "Board", width: 375, height: 812, layout: "none",
      children: [{ type: "frame", id: "card", name: "Card", x: 20, y: 20, width: 100, height: 50, rotation: 30, layout: "none" }],
    }],
  });
  const { html, ledger } = importPen(pen);
  assert.equal(ledger.lost.rotation, 1);
  assert.match(ledger.notes.join("\n"), /rotated 30 degrees/);
  assert.ok(!/transform/.test(html), "and nothing invents a transform");
});

// -- text, and what it does with a line break ---------------------------------

test("a line break the author placed survives the import", () => {
  // pen writes a newline in `content` and its own export writes `<br>` for it.
  // Written as a literal newline it is a space: HTML folds it away and the line
  // then wraps wherever the font happens to make it fit — a different design on
  // every machine. `pre-line` is how this format says "keep the breaks I wrote,
  // and nothing else" — `pre-wrap` also keeps the space before the break, and a
  // trailing space then counts towards the line's centre: 11px of shift, measured
  // against pen's own export of the welcome document.
  const pen = JSON.stringify({
    version: "2.13",
    children: [{
      type: "frame", id: "board", name: "Board", width: 1000, height: 1458, layout: "none",
      children: [
        { type: "text", id: "two", x: 0, y: 0, width: 923, height: 307, content: "Ask agent to \ndesign something", fill: "#ff8303ff", fontSize: 100, textAlign: "center" },
        { type: "text", id: "one", x: 0, y: 400, width: 200, height: 40, content: "Single line", fontSize: 16, textGrowth: "fixed-width" },
      ],
    }],
  });
  const { html, ledger } = importPen(pen);
  assert.match(html, /white-space:pre-line"*>Ask agent to/);
  assert.equal(ledger.converted.hardBreaks, 1, "one text node, one count — not one per newline");
  // The other text node has no break of its own, so nothing about its wrapping
  // changes: only the node that wrote one gets the declaration.
  const single = html.slice(html.indexOf('data-id="one"'), html.indexOf('data-id="one"') + 300);
  assert.ok(!/pre-line/.test(single), "a text with no break of its own is unchanged");
  assert.equal((html.match(/pre-line/g) ?? []).length, 1);
});

// -- variables, and the value a theme starts from -----------------------------

test("a themed variable takes the value of the document's default theme", () => {
  // pen stores a themeable variable as a list of `{value, theme?}` entries. The
  // list is not a value: reading it as one wrote the literal string
  // "[object Object],[object Object]" into the token block, in a file that
  // validated. The entry with no `theme` of its own is the one every theme starts
  // from, and it is the one pen's own export inlines.
  const ledger = createLedger();
  const { tokens } = tokensFromVariables({
    "surface-container": {
      type: "color",
      value: [
        { value: "#F2F3F0" },
        { value: "#111111", theme: { Mode: "Dark" } },
      ],
    },
  }, ledger);
  assert.equal(tokens.get("--color-surface-container").value, "#f2f3f0");
  assert.equal(ledger.converted.themedVariables, 1);
});

test("a variable that is not one value is left out, and named", () => {
  // The other half: a variable this reader cannot turn into one CSS value must
  // not become a value that means nothing. Leaving it out leaves its references
  // visible — the validator says `var()` has no definition — which is a better
  // failure than a colour that is the string "[object Object]".
  const ledger = createLedger();
  const { tokens, refs } = tokensFromVariables({
    "surface-container": { type: "color", value: [{ theme: { Mode: "Light" }, value: { nested: true } }] },
  }, ledger);
  assert.equal(tokens.size, 0, "no token is written");
  assert.equal(refs.size, 0);
  assert.equal(ledger.lost.unresolvedVariable, 1);
  assert.match(ledger.notes.join("\n"), /surface-container/);
});

test("a glyph name the set does not carry is a visible placeholder, and is counted", () => {
  // The other half of the two tests above: a name that is not in the set must not become a
  // silent hole. This is the guarantee that made the 233 missing icons worth fixing.
  const pen = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "board", name: "Board", width: 375, height: 812,
      children: [{ type: "icon", id: "ico", name: "Nope", icon: "not-a-real-glyph", library: "lucide", width: 15, height: 15 }],
    }],
  });
  const { html, ledger } = importPen(pen);
  assert.match(html, /<rect [^>]*stroke="currentColor"/, "a placeholder is drawn, not nothing");
  assert.equal(ledger.lost.glyphNotInSet, 1);
  assert.match(ledger.notes.join("\n"), /not-a-real-glyph/, "and the ledger names it");
});

test("an imported glyph carries the grid it was drawn on", () => {
  // Pen stores a glyph by name, and this format stores geometry — which means
  // the element has to say what coordinate system that geometry is in. Without
  // `viewBox` the browser does not scale the 24×24 drawing into a 15×15 box, it
  // clips it.
  const pen = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "board", name: "Board", width: 375, height: 812,
      children: [{ type: "icon", id: "ico", name: "Target", icon: "target", library: "lucide", width: 15, height: 15, fill: "#2E1F26" }],
    }],
  });
  const { html } = importPen(pen);
  assert.match(html, /data-icon="target"[^>]*viewBox="0 0 24 24"/, `the icon has no grid: ${html.slice(html.indexOf("data-icon=\"target\"") - 120, html.indexOf("data-icon=\"target\"") + 160)}`);
});

test("an imported ellipse carries its own radius, so a deliverable keeps it", () => {
  // `data-kind` alone is not enough: `export` drops every `data-*` attribute, so
  // a rule keyed on it rounds the node in the file and leaves the shipped page
  // square. The declaration rides on the element instead.
  const pen = JSON.stringify({
    version: "2.19",
    children: [{
      type: "frame", id: "board", name: "Board", width: 375, height: 812,
      children: [{ type: "ellipse", id: "dot", name: "Avatar", width: 44, height: 44, fill: "#FCE7F3" }],
    }],
  });
  const { html } = importPen(pen);
  const at = html.indexOf('data-id="dot"');
  const tag = html.slice(at, html.indexOf(">", at));
  assert.match(tag, /data-kind="ellipse"/, tag);
  assert.match(tag, /border-radius:50%/, tag);
});

test("a ref that fills the cross axis states a size, because stretch loses", () => {
  // `align-self: stretch` stretches a flex item only while its own cross size is
  // `auto`. A master states its size, so the master's 320px would beat the
  // stretch: the divider in the reference file's review list came out 320 wide
  // where pen draws the list's 311. The reference's own size is merged over the
  // copy, so the copy is as wide as the reference says.
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      {
        type: "frame", id: "lib", name: "Masters", width: 375, height: 100,
        children: [{ type: "frame", id: "divider", name: "Divider", reusable: true, width: 320, height: 1, fill: "#F0E1E4" }],
      },
      {
        type: "frame", id: "board", name: "Board", width: 375, height: 812, layout: "vertical", padding: [0, 16, 0, 16],
        children: [{ type: "ref", id: "used", name: "Divider", ref: "divider", width: "fill_container" }],
      },
    ],
  });
  const { html } = importPen(pen);
  const at = html.indexOf('data-id="used"');
  const tag = html.slice(at, html.indexOf(">", at));
  assert.match(tag, /data-type="frame"/, "a reference is a frame in the file that comes out");
  assert.match(tag, /width:100%/, tag);
  assert.ok(!/width:320px/.test(tag), `the reference's size wins over the master's: ${tag}`);
  assert.ok(!/align-self/.test(tag), `stretch never beats the master's own width: ${tag}`);
});

test("a swapped glyph is drawn in the copy, with its name and its geometry together", () => {
  // The copy carries both halves: `data-icon` is the name and the paths are the
  // drawing. A name without geometry is a blank box that validates, and geometry
  // without the name is a label that disagrees with its own drawing.
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      {
        type: "frame", id: "lib", name: "Masters", width: 375, height: 100,
        children: [{
          type: "frame", id: "tile", name: "Tile", reusable: true, layout: "vertical", width: 64,
          children: [{ type: "icon", id: "ico", name: "Icon", icon: "sparkles", library: "lucide", width: 22, height: 22, fill: "#B8325E" }],
        }],
      },
      {
        type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{ type: "ref", id: "used", name: "Tile", ref: "tile", width: 64, descendants: { ico: { icon: "gem" } } }],
      },
    ],
  });
  const { html, ledger } = importPen(pen);
  assert.equal(ledger.converted.iconOverrides, 1);
  const board = html.slice(html.indexOf('data-id="board"'));
  const firstPath = (name) => /d="([^"]+)"/.exec(iconBody(name))[1];
  assert.match(board, /data-icon="gem"/, "the name moved with the glyph");
  assert.ok(board.includes(`d="${firstPath("gem")}"`), "gem's own geometry is drawn");
  assert.ok(!board.includes(`d="${firstPath("sparkles")}"`), "sparkles is gone from the copy");
});

// -- an artboard that is itself reusable ---------------------------------------

/**
 * pen lets any node be reusable, a top-level artboard included.
 *
 * Nothing about that changes the artboard: it is a frame, it is at the top of the
 * document, so it is a page. What changes is the reference to it — the reference
 * is inlined where it stands, and the artboard stays where pen put it.
 */
test("a reusable artboard is a page, and the reference to it is inlined", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      {
        type: "frame", id: "card", name: "Card", reusable: true, width: 320, height: 80,
        children: [{ type: "text", id: "card_title", name: "Title", content: "你好", width: 120, height: 24 }],
      },
      {
        type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{ type: "ref", id: "used", name: "Card", ref: "card" }],
      },
    ],
  });
  const { html, ledger } = importPen(pen);
  const doc = parse(html);

  assert.deepEqual(
    pagesOf(doc).map((page) => getAttr(page, "data-id")),
    ["card", "board"],
    "both artboards are pages: nothing in this format is scaffolding",
  );
  assert.equal(getAttr(pagesOf(doc)[0], "data-library"), null);
  assert.deepEqual(validateDesign(doc).filter((d) => d.severity === "error"), [], "the product validates");
  assert.equal(ledger.pages, 2);

  const board = html.slice(html.indexOf('data-id="board"'));
  assert.match(board, /data-id="used"/, "the copy takes the reference's own id");
  assert.match(board, /data-id="used__card_title"/, "and the master's subtree is renumbered under it");
  assert.ok(board.includes("你好"), "the master's content came with the copy");
  assert.equal(html.match(/你好/g).length, 2, "and the master still has its own");
});

test("two references to one master get different ids", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      { type: "frame", id: "card", name: "Card", reusable: true, width: 320, height: 80,
        children: [{ type: "text", id: "title", name: "Title", content: "x", width: 120, height: 24 }] },
      { type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [
          { type: "ref", id: "a", name: "A", ref: "card" },
          { type: "ref", id: "b", name: "B", ref: "card" },
        ] },
    ],
  });
  const { html } = importPen(pen);
  assert.match(html, /data-id="a__title"/);
  assert.match(html, /data-id="b__title"/);
  assert.equal(new Set([...html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1])).size, [...html.matchAll(/data-id="([^"]+)"/g)].length);
});

test("a file of nothing but a reusable artboard is one page, and one deliverable", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [{ type: "frame", id: "card", name: "Card", reusable: true, width: 320, height: 80, children: [] }],
  });
  const doc = parse(importPen(pen).html);
  assert.equal(pagesOf(doc).length, 1, "the artboard is a page");
  assert.deepEqual(exportAllPages(doc).map((file) => file.file), ["card.html"], "and every page is exported");
});

// -- a reference that cannot be inlined ----------------------------------------

test("a reference that names nothing is refused, not written as an empty box", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [{ type: "frame", id: "board", name: "Board", width: 375, height: 812,
      children: [{ type: "ref", id: "used", name: "Card", ref: "ghost" }] }],
  });
  assert.throws(() => importPen(pen), (error) => {
    assert.equal(error.code, "pen/unresolved-ref");
    assert.match(error.message, /ghost/);
    return true;
  });
});

test("a reference chain that comes back on itself is refused", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [{ type: "frame", id: "board", name: "Board", width: 375, height: 812, children: [
      { type: "frame", id: "a", name: "A", reusable: true, width: 100, height: 100, children: [{ type: "ref", id: "a_use", ref: "b" }] },
      { type: "frame", id: "b", name: "B", reusable: true, width: 100, height: 100, children: [{ type: "ref", id: "b_use", ref: "a" }] },
      { type: "ref", id: "start", ref: "a" },
    ] }],
  });
  assert.throws(() => importPen(pen), (error) => {
    assert.equal(error.code, "pen/ref-cycle");
    assert.match(error.message, /a -> b|b -> a/);
    return true;
  });
});

test("a reference nested inside a master is inlined too", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      { type: "frame", id: "inner", name: "Inner", reusable: true, width: 40, height: 20,
        children: [{ type: "text", id: "inner_t", name: "T", content: "i", width: 40, height: 20 }] },
      { type: "frame", id: "outer", name: "Outer", reusable: true, layout: "vertical", width: 100, gap: 2,
        children: [{ type: "ref", id: "outer_inner", name: "Inner", ref: "inner" }] },
      { type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{ type: "ref", id: "used", name: "Outer", ref: "outer" }] },
    ],
  });
  const { html, ledger } = importPen(pen);
  // Three: the outer master is an artboard, so its own page renders the reference
  // inside it once, and the copy in `board` renders it again.
  assert.equal(ledger.refs.inlined, 3);
  assert.match(html, /data-id="used"/);
  assert.match(html, /data-id="used__outer_inner"/, "the copy of the nested reference");
  assert.match(html, /data-id="used__outer_inner__inner_t"/, "and the subtree under that copy");
});

test("a reference that carries children of its own names the loss", () => {
  const pen = JSON.stringify({
    version: "2.19",
    children: [
      { type: "frame", id: "card", name: "Card", reusable: true, width: 320, height: 80, children: [] },
      { type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{ type: "ref", id: "used", ref: "card", children: [{ type: "text", id: "extra", name: "X", content: "x", width: 20, height: 20 }] }] },
    ],
  });
  const { ledger } = importPen(pen);
  assert.equal(ledger.lost.refChildren, 1);
  assert.ok(ledger.notes.some((note) => note.includes("children of its own")), JSON.stringify(ledger.notes));
});

