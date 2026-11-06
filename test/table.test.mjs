/**
 * The format table drives value normalization and property filtering.
 * These tests pin the behavior a model depends on: write natural CSS, get told
 * exactly what changed and what was dropped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDeclarations } from "../lib/parse.mjs";
import {
  CSS_ORDER, CSS_ALLOWED, REJECTED_PROPERTIES, TOKEN_GROUPS,
  normalizeColor, normalizeLength, normalizeValue, normalizeStyleText,
  compressBox, expandBox, splitValueParts, compareProperties, isAllowedProperty,
} from "../lib/table.mjs";

// -- the table itself ---------------------------------------------------------

test("every ordered property has a value grammar", () => {
  for (const name of CSS_ORDER) {
    assert.ok(CSS_ALLOWED[name], `${name} is in the emit order but has no grammar`);
  }
  for (const name of Object.keys(CSS_ALLOWED)) {
    assert.ok(isAllowedProperty(name), `${name} has a grammar but no emit order`);
  }
});

test("the table has no duplicates, and every property has a grammar", () => {
  assert.equal(new Set(CSS_ORDER).size, CSS_ORDER.length, "no duplicate property");
  // The set grew when pen's own export was measured against it: flex-shrink,
  // margin, outline, outline-offset and font-style are all things a real design
  // uses, and refusing them forced wrappers for a half-pixel.
  assert.ok(CSS_ORDER.length >= 40, `the table shrank to ${CSS_ORDER.length}`);
  assert.equal(TOKEN_GROUPS.length, 7);
});

test("every refused property explains itself and names a replacement when one exists", () => {
  for (const [name, info] of Object.entries(REJECTED_PROPERTIES)) {
    assert.ok(info.reason && info.reason.length > 10, `${name} needs a reason`);
    if (info.replacement) assert.ok(info.replacement.length > 0);
  }
});

// -- colors -------------------------------------------------------------------

test("colors normalize to six or eight digit lower case hex", () => {
  const cases = [
    ["#fff", "#ffffff"],
    ["#FFF", "#ffffff"],
    ["#AbCdEf", "#abcdef"],
    ["#fff8f9", "#fff8f9"],
    ["#abcd", "#aabbccdd"],
    ["rgb(17, 24, 39)", "#111827"],
    ["rgb(17 24 39)", "#111827"],
    ["rgba(0, 0, 0, 0.5)", "#00000080"],
    ["rgba(0,0,0,0.5)", "#00000080"],
    ["rgb(100% 100% 100%)", "#ffffff"],
    ["white", "#ffffff"],
    ["BLACK", "#000000"],
    ["transparent", "transparent"],
    ["var(--color-bg)", "var(--color-bg)"],
    ["$color-bg", "$color-bg"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeColor(input), expected, `for ${input}`);
  }
});

test("a color the format cannot read is refused with a hint", () => {
  for (const input of ["oklch(0.5 0.1 20)", "hsl live", "#gggggg", "", "lab(1 2 3)"]) {
    assert.throws(() => normalizeColor(input), /./, `expected a refusal for ${input}`);
  }
});

// -- lengths ------------------------------------------------------------------

test("lengths normalize to px with zero written as 0", () => {
  const cases = [
    ["16px", "16px"],
    ["16.0px", "16px"],
    ["0px", "0"],
    ["0", "0"],
    ["0%", "0"],
    ["16", "16px"],
    ["-8", "-8px"],
    ["1.23456px", "1.235px"],
    ["100%", "100%"],
    ["auto", "auto"],
    ["fit-content", "fit-content"],
    ["var(--space-md)", "var(--space-md)"],
    ["0.02em", "0.02em"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeLength(input), expected, `for ${input}`);
  }
});

test("padding compresses the CSS way, and three values become four", () => {
  assert.deepEqual(compressBox(["16px", "16px", "16px", "16px"]), ["16px"]);
  assert.deepEqual(compressBox(["16px", "24px", "16px", "24px"]), ["16px", "24px"]);
  assert.deepEqual(compressBox(["16px", "24px", "8px", "4px"]), ["16px", "24px", "8px", "4px"]);
  assert.deepEqual(compressBox(["16px"]), ["16px"]);
  // Three values are the one spelling that cannot round trip: left follows
  // right, so the canonical form writes all four.
  assert.deepEqual(compressBox(["16px", "24px", "8px"]), ["16px", "24px", "8px", "24px"]);
  assert.deepEqual(expandBox(["16px", "24px", "8px"]), ["16px", "24px", "8px", "24px"]);
});

test("box compression is idempotent for every arity", () => {
  const cases = [["16px"], ["16px", "24px"], ["16px", "24px", "8px"], ["16px", "24px", "8px", "4px"], ["16px", "16px", "16px", "16px"]];
  for (const input of cases) {
    const once = compressBox(input);
    assert.deepEqual(compressBox(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

test("splitValueParts respects parentheses and quotes", () => {
  assert.deepEqual(splitValueParts("url(\"a b.png\") cover"), ["url(\"a b.png\")", "cover"]);
  assert.deepEqual(splitValueParts("calc(1px + 2px) 4px"), ["calc(1px + 2px)", "4px"]);
  assert.deepEqual(splitValueParts("  "), []);
});

// -- per property values ------------------------------------------------------

test("keyword values normalize case and reject what is not allowed", () => {
  assert.equal(normalizeValue("display", "FLEX").value, "flex");
  assert.equal(normalizeValue("justify-content", "space-between").value, "space-between");
  assert.equal(normalizeValue("font-weight", "600").value, "600");
  assert.throws(() => normalizeValue("display", "grid"), /not a value of display/);
  assert.throws(() => normalizeValue("flex-direction", "verticale"), /not a value/);
});

test("font weight accepts the words a model writes", () => {
  assert.equal(normalizeValue("font-weight", "bold").value, "700");
  assert.equal(normalizeValue("font-weight", "semibold").value, "600");
  assert.equal(normalizeValue("font-weight", "normal").value, "400");
});

test("flex shorthand completes itself", () => {
  assert.equal(normalizeValue("flex", "1").value, "1 1 0%");
  assert.equal(normalizeValue("flex", "1 1").value, "1 1 0%");
  assert.equal(normalizeValue("flex", "1 1 0%").value, "1 1 0%");
  assert.equal(normalizeValue("flex", "0 0 auto").value, "0 0 auto");
});

test("border normalizes to width style color in one order", () => {
  assert.equal(normalizeValue("border", "1px solid #eee").value, "1px solid #eeeeee");
  assert.equal(normalizeValue("border", "solid 1px #EEE").value, "1px solid #eeeeee");
  assert.equal(normalizeValue("border", "#eee 1px solid").value, "1px solid #eeeeee");
});

test("box shadow normalizes each layer and refuses inset", () => {
  assert.equal(normalizeValue("box-shadow", "0 6px 16px rgba(0,0,0,0.12)").value, "0 6px 16px #0000001f");
  assert.equal(normalizeValue("box-shadow", "0 1px 2px #0001, 0 4px 8px #0002").value, "0 1px 2px #00000011, 0 4px 8px #00000022");
  assert.throws(() => normalizeValue("box-shadow", "inset 0 1px 2px #000"), /Inner shadows/);
});

test("url values gain quotes so a semicolon cannot split them", () => {
  assert.equal(normalizeValue("background-image", "url(a;b.png)").value, 'url("a;b.png")');
  assert.equal(normalizeValue("background-image", "url('a.png')").value, 'url("a.png")');
  assert.equal(normalizeValue("background-image", 'url("a.png")').value, 'url("a.png")');
});

test("line height accepts a ratio or a length", () => {
  assert.equal(normalizeValue("line-height", "1.5").value, "1.5");
  assert.equal(normalizeValue("line-height", "20px").value, "20px");
  assert.throws(() => normalizeValue("line-height", "tall"), /line height/);
});

test("opacity is clamped and rounded", () => {
  assert.equal(normalizeValue("opacity", "0.5").value, "0.5");
  assert.equal(normalizeValue("opacity", ".50").value, "0.5");
  assert.equal(normalizeValue("opacity", "2").value, "1");
  assert.equal(normalizeValue("opacity", "-1").value, "0");
});

// -- the two properties that paint behind the element --------------------------

test("a background size is a keyword, or a pair of lengths for a tile", () => {
  const size = (value) => normalizeValue("background-size", value);
  assert.deepEqual(size("cover"), { value: "cover", changed: false });
  assert.deepEqual(size("100% 100%"), { value: "100% 100%", changed: false }, "a pair of percentages is a pair, not a keyword");
  assert.deepEqual(size("26px 26px"), { value: "26px 26px", changed: false }, "a dot grid is one dot every 26px");
  assert.equal(size("26px auto").value, "26px", "a trailing auto is the same picture, so it is dropped");
  assert.equal(size("auto 50%").value, "auto 50%");
  assert.equal(size("0 0").value, "0 0");
  assert.throws(() => size("cover 26px"), /half of a pair/, "cover describes the whole picture");
  assert.throws(() => size("26px 26px 26px"), /one or two values/);
  assert.throws(() => size("fit-content"), /not a background size/);
  assert.throws(() => size("-26px"), /not a background size/, "a size cannot be negative");
});

test("a transform is a rotation, or none, and nothing else", () => {
  const transform = (value) => normalizeValue("transform", value);
  assert.deepEqual(transform("rotate(-1.5deg)"), { value: "rotate(-1.5deg)", changed: false });
  assert.equal(transform("rotate( 2deg )").value, "rotate(2deg)");
  assert.equal(transform("rotate(-0deg)").value, "rotate(0deg)", "zero has one spelling");
  assert.deepEqual(transform("none"), { value: "none", changed: false });
  assert.throws(() => transform("rotate(1turn)"), /only rotate/, "one unit, so one spelling");
  assert.throws(() => transform("translateX(-50%)"), /only rotate/, "left and top already say this");
  assert.throws(() => transform("scale(1.02)"), /only rotate/, "width and height already say this");
  assert.throws(() => transform("var(--tilt)"), /only rotate/, "the canvas and the checks have to read the angle");
});

test("a rotation is written with the other paint properties", () => {
  const { text, dropped } = normalize("transform:rotate(-1.5deg);display:flex;opacity:0.8");
  assert.deepEqual(dropped, []);
  assert.equal(text, "display:flex;opacity:0.8;transform:rotate(-1.5deg)");
});

test("a backdrop filter is blur and saturate, written in the canonical order", () => {
  const filter = (value) => normalizeValue("backdrop-filter", value);
  assert.deepEqual(filter("blur(20px)"), { value: "blur(20px)", changed: false });
  assert.equal(filter("blur( 20px ) saturate(1.4)").value, "blur(20px) saturate(1.4)");
  assert.equal(filter("saturate(1.4) blur(20px)").value, "blur(20px) saturate(1.4)", "the written order is not the canonical one");
  assert.equal(filter("blur(4)").value, "blur(4px)", "a bare number is a length, as everywhere else");
  assert.deepEqual(filter("none"), { value: "none", changed: false });
  assert.equal(filter("var(--glass)").value, "var(--glass)", "a token is left for the token resolver");
  assert.throws(() => filter("drop-shadow(0 4px 8px #00000033)"), /not a filter/);
  assert.throws(() => filter("blur(4px) blur(2px)"), /twice/, "two blurs are two intents");
  assert.throws(() => filter("blur(-4px)"), /cannot be negative/);
  assert.throws(() => filter("saturate(140%)"), /takes a number/);
  assert.throws(() => filter("blur(auto)"), /not a length/, "a blur needs a length, not a box keyword");
  assert.throws(() => filter("blur(100%)"), /not a length/, "a percentage is not a blur radius");
});

// -- whole style attributes ---------------------------------------------------

const normalize = (text) => normalizeStyleText(text, parseDeclarations);

test("declarations are reordered to the emit order", () => {
  const { text } = normalize("color:#111827;display:flex;gap:8px");
  assert.equal(text, "display:flex;gap:8px;color:#111827");
  assert.equal(compareProperties("display", "color") < 0, true);
});

test("a data URI style value survives normalization whole", () => {
  const { text, dropped } = normalize('background-image:url("data:image/svg+xml;base64,PHN2Zy8+");background-size:cover');
  assert.equal(dropped.length, 0);
  assert.equal(text, 'background-image:url("data:image/svg+xml;base64,PHN2Zy8+");background-size:cover');
});

test("out of table properties are dropped with a reason, never silently", () => {
  const { text, dropped } = normalize("display:flex;cursor:pointer;animation:none");
  assert.equal(text, "display:flex");
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((d) => d.prop), ["cursor", "animation"]);
  for (const item of dropped) assert.ok(item.reason.length > 10, `${item.prop} has a reason`);
});

test("a property that recently joined the table is not dropped any more", () => {
  // `margin` used to be refused outright. A real pen export uses it to nudge a
  // focus ring by half a pixel, and refusing it forced a wrapper element.
  const { text, dropped } = normalize("margin:-0.5px 0 0 0;outline:1px solid #B8325E;outline-offset:-0.5px;flex-shrink:0");
  assert.equal(dropped.length, 0, JSON.stringify(dropped));
  assert.match(text, /flex-shrink:0/);
  assert.match(text, /margin:-0.5px 0 0 0/);
  assert.match(text, /outline:1px solid #b8325e/);
});

test("margin is accepted, and a one-sided margin is refused with the shorthand", () => {
  // Margin is in the table but it is not the spacing system: gap and padding
  // are. It is accepted because offsetting an element by a hair is real.
  const { text, dropped } = normalize("margin:16px;display:flex");
  assert.equal(dropped.length, 0, "margin is a property now");
  assert.match(text, /margin:16px/);

  const sided = normalize("margin-top:8px");
  assert.equal(sided.dropped.length, 1);
  assert.match(sided.dropped[0].replacement, /margin/, "the replacement names the shorthand to use");
});

test("the background alias becomes background-color", () => {
  const { text, normalized } = normalize("background:#fff");
  assert.equal(text, "background-color:#ffffff");
  // Two reports: the alias rename, then the value rewrite.
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].prop, "background-color");
  assert.equal(normalized[0].reason, "aliased");
  assert.equal(normalized[1].to, "background-color: #ffffff");
});

test("the prefixed transform is an alias too, so old snippets are not dropped", () => {
  const { text, dropped } = normalize("-webkit-transform:rotate(-2deg);display:flex");
  assert.deepEqual(dropped, []);
  assert.equal(text, "display:flex;transform:rotate(-2deg)");
});

test("the prefixed backdrop filter is an alias of the one that is emitted", () => {
  const { text, dropped, normalized } = normalize("-webkit-backdrop-filter:blur(4px);opacity:0.8");
  assert.deepEqual(dropped, [], "Safari's spelling is the same declaration, so it is not refused");
  assert.equal(text, "opacity:0.8;backdrop-filter:blur(4px)", "the write order follows the table");
  assert.ok(normalized.some((entry) => entry.reason === "aliased"), "the rewrite is reported");
});

test("custom properties pass through untouched", () => {
  const { text, dropped } = normalize("--local-accent:#b8325e;color:var(--local-accent)");
  assert.equal(dropped.length, 0);
  assert.match(text, /--local-accent:#b8325e/);
});

test("normalization reports every change and is idempotent", () => {
  const first = normalize("color:#fff;padding:16px 16px 16px 16px;font-weight:bold");
  assert.ok(first.normalized.length >= 3, "three changes are reported");
  const second = normalize(first.text);
  assert.equal(second.normalized.length, 0, "normalizing twice changes nothing");
  assert.equal(second.text, first.text);
});

test("no declaration is lost: consumed plus reported equals the input count", () => {
  const cases = [
    "display:flex;cursor:pointer;color:#fff;transform:none;gap:0;margin-top:1px;--x:1",
    "background:red;border:1px solid #eee;font-weight:bold",
    "position:absolute;left:0;top:0;opacity:0.5;box-shadow:0 1px 2px #0001",
    "x-unknown:1",
  ];
  for (const css of cases) {
    const input = parseDeclarations(css);
    const { normalized, dropped } = normalize(css);
    const kept = parseDeclarations(normalize(css).text);
    assert.equal(kept.length + dropped.length, input.length, `declaration count changed for ${css}`);
    assert.ok(normalized.length >= 0);
  }
});

test("the properties pen's own export needs are all in the table", () => {
  // This list came from reading the CSS of a real pen export. If one of these
  // is missing, importing that file produces a design the tool then refuses to
  // write back, which is the worst of both worlds.
  for (const property of [
    "flex-shrink", "margin", "outline", "outline-offset", "font-style",
    "line-height", "white-space", "letter-spacing", "box-shadow",
    "border-width", "border-style", "border-color", "box-sizing",
  ]) {
    if (property === "box-sizing") continue; // handled by the export reset, not the table
    assert.ok(isAllowedProperty(property), `${property} is missing from the table`);
  }
});

test("flex-shrink accepts the values a real design uses", () => {
  assert.equal(normalizeValue("flex-shrink", "0").value, "0");
  assert.equal(normalizeValue("flex-shrink", "1").value, "1");
  assert.throws(() => normalizeValue("flex-shrink", "banana"), /number/);
});

test("an outline normalizes to width, style, colour", () => {
  assert.equal(normalizeValue("outline", "1px solid #B8325E").value, "1px solid #b8325e");
  assert.equal(normalizeValue("outline", "solid 1px #B8325E").value, "1px solid #b8325e");
  assert.equal(normalizeValue("outline", "none").value, "none");
  assert.equal(normalizeValue("outline-offset", "-0.5px").value, "-0.5px");
});

test("font-style is normal or italic, and nothing else", () => {
  assert.equal(normalizeValue("font-style", "italic").value, "italic");
  assert.equal(normalizeValue("font-style", "NORMAL").value, "normal");
  assert.throws(() => normalizeValue("font-style", "oblique"), /not a value/);
});

test("a three value margin expands like padding, so it can round trip", () => {
  assert.equal(normalizeValue("margin", "0 0 16px").value, "0 0 16px 0");
  assert.equal(normalizeValue("margin", "-0.5px 0 0 0").value, "-0.5px 0 0 0");
  assert.equal(normalizeValue("margin", "8px 8px 8px 8px").value, "8px");
  assert.equal(normalizeValue("margin", "8px 0").value, "8px 0");
});
