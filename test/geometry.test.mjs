/**
 * The geometric checks.
 *
 * The rule this file exists to hold: a check reports nothing it cannot prove.
 * A false report is worse than silence, because people stop reading a report
 * that is wrong. So the quiet cases here outnumber the reporting ones, and the
 * first test in the file is the one that caught a false positive in the first
 * version of the module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse, styleMapOf } from "../lib/parse.mjs";
import { collectTokens, validateDesign } from "../lib/validate.mjs";
import { lintGeometry, measureById, overhangOf, MAX_REPORTED_PER_CODE } from "../lib/geometry.mjs";

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>*,*::before,*::after{box-sizing:border-box}
*{margin:0}
img{display:block}
svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:root{--space-md:16px}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`;

function file(inner, pageStyle = "width:390px;height:844px") {
  const text = `<!doctype html>\n<html lang="zh">\n${HEAD}\n<body>\n<section data-id="home" data-type="page" style="${pageStyle}">${inner}</section>\n</body>\n</html>\n`;
  const doc = parse(text);
  return { doc, tokens: collectTokens(doc).tokens };
}

const findings = (inner, pageStyle) => {
  const { doc, tokens } = file(inner, pageStyle);
  return lintGeometry(doc, tokens);
};

const codesOf = (inner, pageStyle) => findings(inner, pageStyle).map((entry) => entry.code);

// -- the rule that keeps the checks honest ------------------------------------

test("children that can shrink are not counted against the frame", () => {
  // Three full-width children in a row. A browser shrinks them to a third each,
  // so nothing overflows. Counting their stated width reported 981px of content
  // in a 327px frame: certain, and wrong. This test is why the rule exists.
  const quiet = codesOf(`<div data-id="home__tabs" data-type="frame" style="display:flex;flex-direction:row;width:327px">
    <div data-id="home__a" data-type="frame" style="width:100%"></div>
    <div data-id="home__b" data-type="frame" style="width:100%"></div>
    <div data-id="home__c" data-type="frame" style="width:100%"></div>
  </div>`);
  assert.deepEqual(quiet, [], "shrinkable children give way, so the frame does not overflow");
});

test("an axis that needs a measurement reports nothing", () => {
  // The width of a run of text is not knowable without measuring it, so a frame
  // of text is quiet on the main axis. A text-heavy design produces few
  // findings by design, not by oversight.
  const quiet = codesOf(`<div data-id="home__card" data-type="frame" style="display:flex;flex-direction:column;width:200px">
    <p data-id="home__t" data-type="text" style="font-size:16px">a very long line of text</p>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("a percentage with no basis to measure against is unknown, not zero", () => {
  // The row has no width of its own and its parent has none either, so `50%` is
  // measured against nothing. Reading it as 0 would make every frame look empty
  // and every overflow look impossible.
  const { doc, tokens } = file(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row">
    <div data-id="home__half" data-type="frame" style="flex:0 0 auto;width:50%;height:10px"></div>
  </div>`, "height:844px");
  assert.equal(measureById(doc, tokens).get("home__half").w, null);
});

// -- the five codes -----------------------------------------------------------

test("geometry/overflow: children that cannot shrink need more than the frame has", () => {
  const found = findings(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:200px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:200px"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/overflow");
  assert.equal(found[0].severity, "warning");
  assert.equal(found[0].target, "home__row");
  assert.match(found[0].message, /400px/);
  assert.match(found[0].message, /300px/);
});

test("geometry/clipped: the same, where the frame hides what does not fit", () => {
  const found = findings(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px;overflow:hidden">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:400px"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/clipped");
  assert.match(found[0].message, /cut off/);
});

test("a scroll container clips too, because the deliverable is a still", () => {
  const found = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px;overflow:auto">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:400px"></div>
  </div>`);
  assert.deepEqual(found, ["geometry/clipped"]);
});

test("geometry/fill-collapsed: the siblings leave nothing for the child that fills", () => {
  const found = findings(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:300px"></div>
    <div data-id="home__b" data-type="frame" style="flex:1 1 0%;min-width:0"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/fill-collapsed");
  assert.equal(found[0].target, "home__row");
});

test("a fill child that still has room is left alone", () => {
  const quiet = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:100px"></div>
    <div data-id="home__b" data-type="frame" style="flex:1 1 0%;min-width:0"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("geometry/axis-conflict: a minimum above a maximum leaves the maximum unreachable", () => {
  const found = findings(`<div data-id="home__box" data-type="frame" style="width:100px;height:40px;min-width:120px;max-width:80px"></div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/axis-conflict");
  assert.equal(found[0].target, "home__box");
  assert.match(found[0].message, /min-width \(120px\)/);
});

test("geometry/absolute-outside: a positioned box that leaves its containing block", () => {
  // `position:relative` is what makes the box the containing block. Without it the
  // base is the page, and a dot at (90, 0) sits inside a 390px page perfectly well.
  const found = findings(`<div data-id="home__box" data-type="frame" style="position:relative;width:100px;height:100px">
    <div data-id="home__dot" data-type="shape" data-kind="rect" style="position:absolute;left:90px;top:0;width:20px;height:20px"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/absolute-outside");
  assert.equal(found[0].target, "home__dot");
});

test("a positioned box that fits reports nothing", () => {
  const quiet = codesOf(`<div data-id="home__box" data-type="frame" style="position:relative;width:100px;height:100px">
    <div data-id="home__dot" data-type="shape" data-kind="rect" style="position:absolute;left:10px;top:10px;width:20px;height:20px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("the containing block is the nearest positioned ancestor, not the parent", () => {
  // A static parent between the box and the relative grandparent does not become
  // the base. The browser lays the box out against the grandparent, where it is
  // inside: 300px tall, box at top 150 of 20px. Comparing it with the 50px static
  // parent in between reported a box that leaves a box it was never in.
  const quiet = codesOf(`<div data-id="home__gp" data-type="frame" style="position:relative;width:300px;height:300px">
    <div data-id="home__mid" data-type="frame" style="width:100px;height:50px">
      <div data-id="home__dot" data-type="shape" data-kind="rect" style="position:absolute;left:0;top:150px;width:40px;height:20px"></div>
    </div>
  </div>`);
  assert.deepEqual(quiet, [], "the grandparent is the base, and the box fits inside it");
});

test("a positioned box with no positioned ancestor is measured against the page", () => {
  // A page cannot be positioned — `structure/page-position` refuses it — so
  // without this rule a box like this one has no base at all and is never checked.
  const found = findings(`<div data-id="home__box" data-type="frame" style="width:100px;height:100px">
    <div data-id="home__dot" data-type="shape" data-kind="rect" style="position:absolute;left:400px;top:0;width:20px;height:20px"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/absolute-outside");
  assert.equal(found[0].target, "home__dot");
});

// -- the page seed ------------------------------------------------------------

test("a page that declares its height is measured against it", () => {
  const boxes = measureById(file(`<div data-id="home__a" data-type="frame" style="width:100%"></div>`, "width:390px;height:844px").doc, collectTokens(file("").doc).tokens);
  assert.equal(boxes.get("home__a").w, 390, "the declared page width is the basis");
});

test("height:100% of a box whose height is unknown reports nothing", () => {
  // The outer box hugs its content, and one of its children is a text node, so
  // its height is not knowable. `height:100%` inside it is then measured against
  // nothing: the box may be 900px tall or 90px, so no overflow can be claimed —
  // not even though the child states a height of 900px, because that child is
  // free to shrink.
  const { doc, tokens } = file(`<div data-id="home__box" data-type="frame" style="display:flex;flex-direction:column;width:200px">
    <p data-id="home__t" data-type="text" style="font-size:16px">text</p>
    <div data-id="home__inner" data-type="frame" style="height:100%">
      <div data-id="home__tall" data-type="frame" style="flex:0 0 auto;height:900px"></div>
    </div>
  </div>`);
  assert.equal(measureById(doc, tokens).get("home__box").h, null, "the hugging box has no knowable height");
  assert.equal(measureById(doc, tokens).get("home__inner").h, null, "so 100% of it has none either");
  assert.deepEqual(codesOf(`<div data-id="home__box" data-type="frame" style="display:flex;flex-direction:column;width:200px">
    <p data-id="home__t" data-type="text" style="font-size:16px">text</p>
    <div data-id="home__inner" data-type="frame" style="height:100%">
      <div data-id="home__tall" data-type="frame" style="flex:0 0 auto;height:900px"></div>
    </div>
  </div>`), []);
});

test("a page without a declared height hugs its content, and is measured", () => {
  const { doc, tokens } = file(`<div data-id="home__a" data-type="frame" style="height:200px"></div>`, "width:390px");
  assert.equal(measureById(doc, tokens).get("home__a").h, 200);
});

// -- the report, not the module ----------------------------------------------

test("a geometric finding reaches validate, and stays a warning", () => {
  const { doc } = file(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px;overflow:hidden">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:400px"></div>
  </div>`);
  const found = validateDesign(doc).filter((d) => d.code === "geometry/clipped");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning", "a warning is what keeps it from blocking a write");
  assert.ok(found[0].path, "a finding names where it is");
  assert.equal(found[0].offset, undefined, "a geometric finding has no offset in the text");
});

test("--strict promotes a geometric warning, the same as any other warning", () => {
  const { doc } = file(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px;overflow:hidden">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:400px"></div>
  </div>`);
  const found = validateDesign(doc, { strict: true }).filter((d) => d.code === "geometry/clipped");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "error");
});

test("one code is reported at most MAX_REPORTED_PER_CODE times", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    `<div data-id="home__r${i}" data-type="frame" style="display:flex;flex-direction:row;width:100px;overflow:hidden">
       <div data-id="home__c${i}" data-type="frame" style="flex:0 0 auto;width:400px"></div>
     </div>`).join("\n");
  const found = findings(rows).filter((entry) => entry.code === "geometry/clipped");
  assert.equal(found.length, MAX_REPORTED_PER_CODE, "a report nobody reads is a check that does not work");
});

test("the diagnostic key keeps two findings on different elements apart", () => {
  // A geometric finding has no `offset`, so `target` is the only part of the key
  // that distinguishes one from another. Without it the report would collapse
  // two different elements into one line — silent loss, in a report about loss.
  const { doc } = file(`<div data-id="home__a" data-type="frame" style="display:flex;flex-direction:row;width:100px;overflow:hidden">
      <div data-id="home__a1" data-type="frame" style="flex:0 0 auto;width:400px"></div>
    </div>
    <div data-id="home__b" data-type="frame" style="display:flex;flex-direction:row;width:100px;overflow:hidden">
      <div data-id="home__b1" data-type="frame" style="flex:0 0 auto;width:400px"></div>
    </div>`);
  const found = validateDesign(doc).filter((d) => d.code === "geometry/clipped");
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((d) => d.target).sort(), ["home__a", "home__b"]);
});

test("a wrapping row is not summed onto one line", () => {
  // Two 200px children in a wrapping 300px row wrap in the browser, so nothing
  // overflows. Adding them up reported an overflow the browser never draws —
  // the false report this module exists to avoid.
  const row = (wrap) => `<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;${wrap}width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:200px;height:20px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:200px;height:20px"></div>
  </div>`;
  assert.deepEqual(codesOf(row("flex-wrap:wrap;")), [], "a wrapping row puts them on two lines");
  assert.deepEqual(codesOf(row("")), ["geometry/overflow"], "without wrap it really does overflow");
});

test("a child is stretched only when its parent says to stretch it", () => {
  // `align-items: flex-start` turns the cross-axis stretch off. The pen reader
  // writes it on every row it imports — 297 times in the reference file — and a
  // model that reads only the child's `align-self` stretches all of them, so the
  // inner box is measured 200 wide where the browser hugs it to its content.
  const column = (align) => `<div data-id="home__card" data-type="frame" style="display:flex;flex-direction:column;${align}width:200px;height:300px">
    <div data-id="home__inner" data-type="frame" style="height:40px">
      <div data-id="home__fill" data-type="frame" style="width:100%;height:10px"></div>
    </div>
  </div>`;
  const widthOf = (align) => {
    const { doc, tokens } = file(column(align));
    return measureById(doc, tokens).get("home__inner").w;
  };
  assert.equal(widthOf(""), 200, "the default stretch gives the inner box the parent's width");
  // Hugging, its width is its content, and a percentage of an unknowable width is
  // unknowable — so it stops being measurable at all.
  assert.equal(widthOf("align-items:flex-start;"), null, "flex-start makes it hug instead");
});

// -- the measured half, which the canvas cannot test --------------------------

test("a measured child inside its parent's content box reports nothing", () => {
  assert.equal(overhangOf({ left: 0, top: 0, width: 100, height: 50 }, { width: 100, height: 50 }, {}), null);
  assert.equal(overhangOf({ left: 10, top: 10, width: 80, height: 30 }, { width: 100, height: 50 }, {}), null);
});

test("a sub-pixel overhang is rounding, not a defect", () => {
  // A browser lays out in fractions. Reporting half a pixel would make the check
  // fire on designs that are correct.
  assert.equal(overhangOf({ left: 0, top: 0, width: 100.5, height: 50 }, { width: 100, height: 50 }, {}), null);
  assert.equal(overhangOf({ left: -0.5, top: 0, width: 100, height: 50 }, { width: 100, height: 50 }, {}), null);
});

test("the smallest overhang a reader could act on is reported", () => {
  const found = overhangOf({ left: 0, top: 0, width: 102, height: 50 }, { width: 100, height: 50 }, {});
  assert.ok(found);
  assert.equal(Math.round(found.over), 2);
  assert.equal(found.code, "geometry/overflow");
});

test("the code follows what the parent does with the spill", () => {
  const child = { left: 0, top: 0, width: 200, height: 50 };
  const content = { width: 100, height: 50 };
  assert.equal(overhangOf(child, content, { clips: true }).code, "geometry/clipped");
  assert.equal(overhangOf(child, content, { clips: false }).code, "geometry/overflow");
  // A positioned child that leaves the box is about the child, whatever the
  // parent does with the spill, and that is how `lib/geometry.mjs` reports it too
  // — otherwise the two passes would name the same defect twice.
  assert.equal(overhangOf(child, content, { positioned: true, clips: true }).code, "geometry/absolute-outside");
});

test("an overhang on any of the four edges counts", () => {
  const content = { width: 100, height: 100 };
  assert.ok(overhangOf({ left: -5, top: 0, width: 50, height: 50 }, content, {}), "left");
  assert.ok(overhangOf({ left: 0, top: -5, width: 50, height: 50 }, content, {}), "top");
  assert.ok(overhangOf({ left: 80, top: 0, width: 50, height: 50 }, content, {}), "right");
  assert.ok(overhangOf({ left: 0, top: 80, width: 50, height: 50 }, content, {}), "bottom");
});

test("an element entirely outside is measured by its farthest edge", () => {
  const found = overhangOf({ left: 150, top: 0, width: 50, height: 50 }, { width: 100, height: 100 }, {});
  assert.equal(Math.round(found.over), 100, "150 + 50 - 100");
});

// -- the module itself --------------------------------------------------------

test("the measurement is a border box and a content box", () => {
  const { doc, tokens } = file(`<div data-id="home__pad" data-type="frame" style="width:200px;height:100px;padding:16px 24px;border:2px solid #000000"></div>`);
  const box = measureById(doc, tokens).get("home__pad");
  assert.equal(box.w, 200);
  assert.equal(box.h, 100);
  assert.equal(box.content.w, 200 - (24 * 2 + 2 * 2));
  assert.equal(box.content.h, 100 - (16 * 2 + 2 * 2));
});

test("a hidden child is not in flow, so it cannot overflow", () => {
  const quiet = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:100px">
    <div data-id="home__a" data-type="frame" data-hidden="true" style="flex:0 0 auto;width:900px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

// -- display, margin, wrap, minimum -------------------------------------------
//
// Every case below was measured in a browser before it was written here, because
// each one is a claim about what a browser does. The measurements are in the
// comment above the assertion that depends on them.

test("display:none says the same thing as data-hidden", () => {
  // `docs/format-v3.md` defines `data-hidden="true"` as equivalent to
  // `display:none`. Only the first was read, so a hidden 400px child was counted
  // against a 100px row. Browser: scrollWidth 100 = clientWidth 100, no overflow.
  const quiet = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:100px">
    <div data-id="home__a" data-type="frame" style="display:none;flex:0 0 auto;width:400px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:20px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("a display:none frame has no layout to check", () => {
  // Browser: offsetWidth 0 and no box at all. Laying it out reported an overflow
  // inside a box that is not on the page.
  const quiet = codesOf(`<div data-id="home__frame" data-type="frame" style="display:none;flex-direction:row;width:100px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:400px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("display:block is not given flex semantics", () => {
  // Browser: the two 80px children are stacked (tops 0 and 10), scrollWidth 100,
  // no overflow. `flex-direction` is inert on block layout and its children do not
  // shrink, so the flex arithmetic is not the right arithmetic and the module
  // declines to guess at block layout instead.
  const quiet = codesOf(`<div data-id="home__frame" data-type="frame" style="display:block;flex-direction:row;width:100px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:80px;height:10px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:80px;height:10px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("a block box still reports the size it states", () => {
  // Declining the flex arithmetic withdraws the hug, not the declared width.
  const boxes = measureById(
    file(`<div data-id="home__frame" data-type="frame" style="display:block;width:120px;height:40px"></div>`).doc,
    collectTokens(file("").doc).tokens,
  );
  assert.equal(boxes.get("home__frame").w, 120);
  assert.equal(boxes.get("home__frame").h, 40);
});

test("a margin on the main axis is part of the space a child needs", () => {
  // Browser: scrollWidth 350 > clientWidth 300. Two 150px children fit a 300px
  // row exactly; 50px of left margin on the second one does not.
  const found = findings(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:150px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:150px;margin:0 0 0 50px"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/overflow");
});

test("a negative margin gives space back", () => {
  // The sign has to survive: `docs/format-v3.md` keeps `margin:-0.5px 0 0 0` for
  // pen's focus ring. Two 150px children in a 300px row fit, and pulling the
  // second one 50px to the left still fits, so nothing is reported.
  const quiet = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:150px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:150px;margin:0 0 0 -50px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("an auto margin has no size to add, so nothing is claimed", () => {
  // `margin:0 auto` absorbs the free space. It is neither 0 nor a length, so the
  // sum is not knowable and the frame is left alone.
  const quiet = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:150px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:150px;margin:0 auto"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("a percentage margin is measured against the width, on both axes", () => {
  // Browser: `margin:10% 0 0 0` in a 400x200 column puts the child 40px down and
  // scrollHeight is 210 against clientHeight 200. Every margin percentage resolves
  // against the containing block's width, including top and bottom. This case
  // tells the two bases apart: 170 + 40 exceeds the 200px height, while the wrong
  // basis would give 170 + 20 = 190 and report nothing.
  const found = findings(`<div data-id="home__box" data-type="frame" style="display:flex;flex-direction:column;width:400px;height:200px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;height:170px;margin:10% 0 0 0"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/overflow");
});

test("only the margin shorthand is read, because only it is allowed", () => {
  // `margin-top` and its three siblings are in `REJECTED_PROPERTIES`: the format
  // has one spelling for one intent. A browser honours the longhand, so this
  // document really does overflow — and this module reports nothing, because the
  // document is one `set` away from being refused and the reader is told that
  // instead. The test pins the choice so it is a decision and not an accident.
  const quiet = codesOf(`<div data-id="home__box" data-type="frame" style="display:flex;flex-direction:column;width:400px;height:200px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;height:170px;margin-top:40px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("a wrapping row does not sum its children onto one line", () => {
  const quiet = codesOf(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;flex-wrap:wrap;width:300px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:200px"></div>
    <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:200px"></div>
  </div>`);
  assert.deepEqual(quiet, []);
});

test("a wrapping row still reports one child that cannot fit its line", () => {
  // Browser: scrollWidth 400 > clientWidth 100. There is no second line for a
  // single child to move to, so wrapping cannot absorb it.
  const found = findings(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;flex-wrap:wrap;width:100px">
    <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:400px"></div>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/overflow");
});

test("a wrapping box's cross size is a measurement, so it is not claimed", () => {
  // Browser: a wrapping 300px row of two 200x60 children is 120px tall (two
  // lines). Summing says 60. The line count depends on the available width, which
  // is not a property of the node, so the cross axis is unknown.
  const boxes = measureById(
    file(`<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;flex-wrap:wrap;width:300px">
      <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:200px;height:60px"></div>
      <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:200px;height:60px"></div>
    </div>`).doc,
    collectTokens(file("").doc).tokens,
  );
  assert.equal(boxes.get("home__row").h, null, "two lines or one, depending on the width");
  assert.equal(boxes.get("home__row").w, 300, "the stated width is still read");
});

test("a wrapping box that hugs its main axis is still measured", () => {
  // Browser: a wrapping row with no stated width, two 200x60 children and a parent
  // that does not stretch it is 400px wide — one line, because the box sizes to its
  // content. Only the cross axis becomes a measurement. The page is told not to
  // stretch, or the row would take the page's 390px instead of hugging.
  const { doc, tokens } = file(
    `<div data-id="home__row" data-type="frame" style="display:flex;flex-direction:row;flex-wrap:wrap">
      <div data-id="home__a" data-type="frame" style="flex:0 0 auto;width:200px;height:60px"></div>
      <div data-id="home__b" data-type="frame" style="flex:0 0 auto;width:200px;height:60px"></div>
    </div>`,
    "width:390px;height:844px;align-items:flex-start",
  );
  const boxes = measureById(doc, tokens);
  assert.equal(boxes.get("home__row").w, 400);
  assert.equal(boxes.get("home__row").h, null, "and its height is still a measurement");
});

test("a minimum wins over a maximum, as CSS says and as the hint says", () => {
  // Browser: `width:100px;min-width:120px;max-width:80px` draws at 120px. The
  // module reported the conflict and then measured the losing side of it, which
  // contradicted the hint it printed.
  const { doc, tokens } = file(`<div data-id="home__a" data-type="frame" style="width:100px;min-width:120px;max-width:80px;height:20px"></div>`);
  assert.equal(measureById(doc, tokens).get("home__a").w, 120);
  const found = findings(`<div data-id="home__a" data-type="frame" style="width:100px;min-width:120px;max-width:80px;height:20px"></div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "geometry/axis-conflict");
  assert.match(found[0].hint, /in favour of the minimum/);
});

test("an absolutely positioned box does not stretch", () => {
  // Browser: an empty `position:absolute` box with no width is 0px wide, not the
  // 300px of its parent. `align-items` does not reach an out-of-flow box.
  const boxes = measureById(
    file(`<div data-id="home__box" data-type="frame" style="width:300px;height:200px">
      <div data-id="home__a" data-type="frame" style="position:absolute;left:0;top:0;height:20px"></div>
    </div>`).doc,
    collectTokens(file("").doc).tokens,
  );
  assert.equal(boxes.get("home__a").w, 0);
});

test("an absolutely positioned box hugs a child that is wider than its parent", () => {
  // Browser: an absolutely positioned box with no width around one 400px child
  // inside a 300px parent is 400px wide. Shrink-to-fit is floored by the content's
  // own minimum, so the hug is the right answer here and stretching was not.
  const boxes = measureById(
    file(`<div data-id="home__box" data-type="frame" style="width:300px;height:200px">
      <div data-id="home__a" data-type="frame" style="position:absolute;left:0;top:0">
        <div data-id="home__b" data-type="frame" style="width:400px;height:20px"></div>
      </div>
    </div>`).doc,
    collectTokens(file("").doc).tokens,
  );
  assert.equal(boxes.get("home__a").w, 400);
});

test("the module reads a token when it measures", () => {
  const { doc, tokens } = file(`<div data-id="home__a" data-type="frame" style="width:var(--space-md);height:40px"></div>`);
  assert.equal(measureById(doc, tokens).get("home__a").w, 16);
});

test("styleMapOf reads the declarations the measurement needs", () => {
  const { doc } = file(`<div data-id="home__a" data-type="frame" style="display:flex;flex-direction:row;width:10px"></div>`);
  let node = null;
  const visit = (n) => { if (n.attrs && n.attrs.some((a) => a.value === "home__a")) node = n; for (const c of n.children || []) visit(c); };
  visit(doc);
  assert.equal(styleMapOf(node).get("flex-direction"), "row");
});
