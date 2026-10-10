/**
 * The contrast check.
 *
 * Two things this file holds. First, the ratio itself, against values that are
 * known rather than computed by the same code under test. Second, the difference
 * between what can be worked out and what cannot: a translucent layer over an
 * opaque surface is arithmetic, and a layer with nothing opaque under it is a
 * guess. A report that guesses is worse than no report, because it teaches the
 * reader to ignore both.
 *
 * The composited values here are the browser's own. They were read back from a
 * canvas: `#ffffff` under `rgba(0,0,0,0.5019607843137255)` is `#7f7f7f`, and a
 * second such layer takes it to `#3f3f3f`. Rounding to `#808080` by hand is off by
 * one in every channel.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../lib/parse.mjs";
import { validateDesign, contrastRatio, CONTRAST_MINIMUM } from "../lib/validate.mjs";

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>*,*::before,*::after{box-sizing:border-box}
*{margin:0}
img{display:block}
svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:root{--color-ink:#111827;--color-dim:#cccccc;--color-card:#ffffff}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`;

function file(body, pageStyle = "width:390px;height:844px") {
  const text = `<!doctype html>\n<html lang="zh">\n${HEAD}\n<body>\n<section data-id="home" data-type="page" style="${pageStyle}">${body}</section>\n</body>\n</html>\n`;
  return parse(text);
}

const contrast = (body, pageStyle) =>
  validateDesign(file(body, pageStyle)).filter((d) => d.code === "a11y/low-contrast");

// -- the ratio ----------------------------------------------------------------

test("the ratio matches WCAG's own values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrastRatio("#ffffff", "#ffffff").toFixed(2), "1.00");
  assert.equal(contrastRatio("#ffffff", "#000000").toFixed(2), "21.00", "the order of the pair does not matter");
  // A mid grey on white is 3.95:1, which is under the minimum. This is the value
  // the check exists to find.
  assert.ok(contrastRatio("#949494", "#ffffff") < CONTRAST_MINIMUM);
});

// -- what it reports ----------------------------------------------------------

test("text below the minimum is reported, with both colours named", () => {
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <p data-id="home__t" data-type="text" style="color:#cccccc">dim</p>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.equal(found[0].target, "home__t");
  assert.match(found[0].message, /below the WCAG AA minimum of 4\.5:1/);
  assert.equal(found[0].hint, "#cccccc text on #ffffff");
});

test("text at or above the minimum is left alone", () => {
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <p data-id="home__t" data-type="text" style="color:#111827">ink</p>
  </div>`), []);
});

test("the check finds the background through an ancestor that paints nothing", () => {
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <div data-id="home__inner" data-type="frame" style="padding:8px">
      <p data-id="home__t" data-type="text" style="color:#cccccc">dim</p>
    </div>
  </div>`);
  assert.equal(found.length, 1, "a transparent box does not hide the paint behind it");
  assert.equal(found[0].hint, "#cccccc text on #ffffff");
});

test("the page's own background is the seed for the text inside it", () => {
  const found = contrast(
    `<p data-id="home__t" data-type="text" style="color:#111827">ink</p>`,
    "width:390px;height:844px;background-color:#111827",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].hint, "#111827 text on #111827");
});

test("a colour written as a token is resolved before it is compared", () => {
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-color:var(--color-card)">
    <p data-id="home__t" data-type="text" style="color:var(--color-dim)">dim</p>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].hint, "#cccccc text on #ffffff");
});

// -- the three abstentions ----------------------------------------------------

test("a photograph stops the check, because the ratio is not knowable", () => {
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-image:url("photo.png")">
    <p data-id="home__t" data-type="text" style="color:#cccccc">dim</p>
  </div>`), [], "saying white on #f8f1ee about text that sits on a photo is confidently wrong");
});

test("a translucent layer is composited over the opaque paint under it", () => {
  // A 50% black scrim over a white card is #7f7f7f, and white text on it is
  // 3.97:1 — a real failure. Version 1 kept the ancestor's white and scored the
  // text against the card, which is a different design from the one on screen.
  // Abstaining missed the failure entirely; this is the arithmetic instead.
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <div data-id="home__scrim" data-type="frame" style="background-color:#00000080">
      <p data-id="home__t" data-type="text" style="color:#ffffff">white on the scrim</p>
    </div>
  </div>`);
  assert.equal(found.length, 1);
  assert.match(found[0].hint, /#7f7f7f/, "the scrim over the card, not the card");
});

test("two translucent layers compose in order", () => {
  // The browser takes white through two 50% black layers to #3f3f3f. White text on
  // that is 10.4:1 and passes — the check must not report it, and it must reach
  // #3f3f3f rather than stopping at the first layer.
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <div data-id="home__s1" data-type="frame" style="background-color:#00000080">
      <div data-id="home__s2" data-type="frame" style="background-color:#00000080">
        <p data-id="home__t" data-type="text" style="color:#ffffff">white on two scrims</p>
      </div>
    </div>
  </div>`), []);
  // And a mid grey on the same stack does fail, so the stack is being read.
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <div data-id="home__s1" data-type="frame" style="background-color:#00000080">
      <div data-id="home__s2" data-type="frame" style="background-color:#00000080">
        <p data-id="home__t" data-type="text" style="color:#555555">grey on two scrims</p>
      </div>
    </div>
  </div>`);
  assert.equal(found.length, 1);
});

test("a translucent layer with nothing opaque under it stops the check", () => {
  // The surface below the page belongs to the deliverable, not to the file, so
  // there is no colour to composite onto. This is the abstention that survives.
  assert.deepEqual(contrast(`<div data-id="home__scrim" data-type="frame" style="background-color:#00000080">
    <p data-id="home__t" data-type="text" style="color:#ffffff">white on an unknown surface</p>
  </div>`), []);
});

test("a translucent layer over a photograph stops the check", () => {
  // A scrim over a photo is exactly the case that must not be guessed at: the
  // checker cannot see through the scrim into the image.
  assert.deepEqual(contrast(`<div data-id="home__photo" data-type="frame" style="background-image:url(a.png)">
    <div data-id="home__scrim" data-type="frame" style="background-color:#00000080">
      <p data-id="home__t" data-type="text" style="color:#ffffff">white on a scrim over a photo</p>
    </div>
  </div>`), []);
});

test("a gradient with no opaque stop stops the check", () => {
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-image:linear-gradient(180deg, #00000000, #ffffff00)">
    <p data-id="home__t" data-type="text" style="color:#cccccc">dim</p>
  </div>`), []);
});

// -- gradients ----------------------------------------------------------------

test("a gradient is scored against its worst opaque stop", () => {
  // The text sits on every stop, so passing on the best one would be a claim
  // about a gradient the text does not sit on everywhere. White text over a
  // gradient that ends light is fine at the top and unreadable at the bottom.
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-image:linear-gradient(180deg, #111827 0%, #cccccc 100%)">
    <p data-id="home__t" data-type="text" style="color:#ffffff">x</p>
  </div>`);
  assert.equal(found.length, 1);
  assert.match(found[0].hint, /#cccccc/, "the worst stop is the one reported, not the best");
  assert.match(found[0].hint, /worst of 2 gradient stops/);
});

test("the worst stop is the worst for this colour, not the darkest", () => {
  // Dark text on the same gradient fares worst against the dark end. The check
  // compares, it does not rank the stops.
  const found = contrast(`<div data-id="home__card" data-type="frame" style="background-image:linear-gradient(180deg, #111827 0%, #cccccc 100%)">
    <p data-id="home__t" data-type="text" style="color:#111827">x</p>
  </div>`);
  assert.equal(found.length, 1);
  assert.equal(found[0].hint, "#111827 text on #111827 (worst of 2 gradient stops)");
});

test("a gradient whose worst stop is dark enough is left alone", () => {
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-image:linear-gradient(180deg, #111827 0%, #000000 100%)">
    <p data-id="home__t" data-type="text" style="color:#ffffff">x</p>
  </div>`), []);
});

// -- what it does not touch ---------------------------------------------------

test("an element that is not text is never measured for contrast", () => {
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff;color:#cccccc">
    <div data-id="home__box" data-type="frame" style="width:10px;height:10px"></div>
  </div>`), []);
});

test("empty text has no contrast to measure", () => {
  assert.deepEqual(contrast(`<div data-id="home__card" data-type="frame" style="background-color:#ffffff">
    <p data-id="home__t" data-type="text" style="color:#cccccc"></p>
  </div>`), []);
});

test("the contrast findings are bounded like the geometric ones", () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    `<div data-id="home__c${i}" data-type="frame" style="background-color:#ffffff">
       <p data-id="home__t${i}" data-type="text" style="color:#cccccc">dim</p>
     </div>`).join("\n");
  assert.equal(contrast(rows).length, 20);
});
