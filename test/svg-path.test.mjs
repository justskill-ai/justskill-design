/**
 * `lib/svg-path.mjs`, on the grammar rather than on one file.
 *
 * The `.pen` corpus exercises `M`, `m`, `l`, `c`, `z` and nothing else — 27 path
 * nodes, all straight lines and cubics — so a parser that only ever meets those
 * passes every corpus test and fails on the first icon that ships an arc. The
 * cases here are the ones SVG allows and pen files contain: implicit repeats,
 * glued negative numbers, exponent notation, the reflection rules for `S` and
 * `T`, and arc flags written without separators.
 *
 * The two invariants worth stating out loud:
 *
 *   a box is the ink, not the control points   a control point is not on the
 *                                             curve, and a box that includes
 *                                             one scales every glyph drawn in it
 *   a turn is reversible                       turning an outline by θ and then
 *                                             by -θ is the outline again, which
 *                                             is what makes baking a rotation
 *                                             into the geometry safe at all
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { pathBounds, rotatePath, PathError } from "../lib/svg-path.mjs";

const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

/** Every number in a `d` string, so two spellings of one outline can be compared. */
const numbersOf = (d) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/** The same outline, allowing for the four decimals a drawn turn is rounded to. */
const assertPathClose = (actual, expected) => {
  const a = numbersOf(actual);
  const b = numbersOf(expected);
  assert.equal(a.length, b.length, `${actual} and ${expected} do not have the same shape`);
  a.forEach((value, index) => close(value, b[index], 1e-3));
};

// -- the box ------------------------------------------------------------------

test("a box comes from the commands, in both spellings", () => {
  assert.deepEqual(pathBounds("M0 0L10 0L10 20L0 20Z"), { minX: 0, minY: 0, maxX: 10, maxY: 20 });
  assert.deepEqual(pathBounds("m0 0l10 0l0 20l-10 0z"), { minX: 0, minY: 0, maxX: 10, maxY: 20 });
  assert.deepEqual(pathBounds("M0 0H10V20H0Z"), { minX: 0, minY: 0, maxX: 10, maxY: 20 });
  assert.deepEqual(pathBounds("M0 0h10v20h-10z"), { minX: 0, minY: 0, maxX: 10, maxY: 20 });
});

test("a second pair after a moveto is a lineto", () => {
  // The spec says so, and pen's own geometry relies on it: the status bar's
  // signal glyph is one `m` followed by a run of implicit linetos.
  assert.deepEqual(pathBounds("m1 2 3 4 5 6"), { minX: 1, minY: 2, maxX: 9, maxY: 12 });
  assert.deepEqual(pathBounds("M1 2 3 4"), { minX: 1, minY: 2, maxX: 3, maxY: 4 });
});

test("numbers that run together are still numbers", () => {
  assert.deepEqual(pathBounds("M1-2L3-4"), { minX: 1, minY: -4, maxX: 3, maxY: -2 });
  assert.deepEqual(pathBounds("M1e1 2e0L3e1 4e0"), { minX: 10, minY: 2, maxX: 30, maxY: 4 });
  assert.deepEqual(pathBounds("M.5.5L1.5 1.5"), { minX: 0.5, minY: 0.5, maxX: 1.5, maxY: 1.5 });
  assert.deepEqual(pathBounds("M0,0,10,0,10,10"), { minX: 0, minY: 0, maxX: 10, maxY: 10 });
});

test("a curve's box is the curve, not the control points that steer it", () => {
  // The two control points sit at y=10; the curve only reaches 7.5. A box built
  // from the control points is a third too tall, and every glyph in that box is
  // then drawn a third too small.
  assert.deepEqual(pathBounds("M0 0C0 10 10 10 10 0"), { minX: 0, minY: 0, maxX: 10, maxY: 7.5 });
  assert.deepEqual(pathBounds("M0 0Q5 10 10 0"), { minX: 0, minY: 0, maxX: 10, maxY: 5 });
});

test("S and T reflect the control point they follow", () => {
  // `c` then `s`: the second curve's first control point is the first curve's
  // second control point mirrored through the joint, and the smooth curve stays
  // on the axis. Read without the reflection it bulges, and the box grows.
  const smooth = pathBounds("M0 0c0-5 10-5 10 0s10 5 10 0");
  assert.deepEqual(smooth, { minX: 0, minY: -3.75, maxX: 20, maxY: 3.75 });
  const quad = pathBounds("M0 0q5 5 10 0t10 0");
  assert.deepEqual(quad, { minX: 0, minY: -2.5, maxX: 20, maxY: 2.5 });
});

test("Z returns the pen to where the subpath started", () => {
  // A curve drawn after a `Z` starts at the subpath's start, not at the last
  // point drawn — and its box is measured from there.
  const box = pathBounds("M0 0L10 0L10 10ZC20 0 20 0 20 0");
  assert.equal(box.minX, 0);
  assert.equal(box.maxX, 20);
  close(box.maxY, 10);
});

test("an arc's box includes the bulge, not just its endpoints", () => {
  // Half a circle of radius 5: the endpoints are both at y=0 and the drawing
  // reaches y=-5. Endpoints alone would give a box with no height at all.
  const box = pathBounds("M0 0A5 5 0 0 1 10 0");
  assert.ok(box, "an arc with a bulge has a box");
  close(box.minX, 0);
  close(box.maxX, 10);
  close(box.minY, -5);
  close(box.maxY, 0, 1e-6);
  // The same arc the other way round bulges the other way.
  assert.ok(pathBounds("M0 0A5 5 0 0 0 10 0").maxY > 0);
});

test("arc flags may be written without separators", () => {
  // `a1 1 0 011 1` is rx 1, ry 1, rotation 0, large-arc 0, sweep 1, x 1, y 1.
  // A scanner that reads the `011` as the number 11 loses the arc entirely.
  const unseparated = pathBounds("M0 0a1 1 0 011 1");
  assert.deepEqual(unseparated, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  assert.deepEqual(pathBounds("M0 0A1 1 0 0 1 1 1"), unseparated);
});

test("an arc whose radii are too small for its chord is scaled up, as the spec says", () => {
  // rx=ry=1 cannot span a chord of 4; the spec scales the radii to 2 and draws
  // the half circle, so the box is 4 wide and 2 tall — not 4 by 1.
  const box = pathBounds("M0 0A1 1 0 0 1 4 0");
  close(box.maxX, 4);
  close(box.minY, -2);
});

test("a radius of zero is a straight line, not an error", () => {
  assert.deepEqual(pathBounds("M0 0A0 0 0 0 1 10 10"), { minX: 0, minY: 0, maxX: 10, maxY: 10 });
});

test("a string that describes no box is null, never zeros", () => {
  // A caller divides by the box to scale the drawing into its element. Zeros
  // would scale it into nothing and say nothing.
  assert.equal(pathBounds(""), null);
  assert.equal(pathBounds("junk"), null);
  assert.equal(pathBounds("M0 0"), null, "a moveto alone draws nothing");
  assert.equal(pathBounds("M2 20h.01"), null, "a horizontal line has no height");
  assert.equal(pathBounds("M2 20v5"), null, "a vertical line has no width");
  assert.equal(pathBounds(undefined), null);
  assert.throws(() => rotatePath("nonsense", 45, 0, 0), PathError);
});

test("the arrow pen drew, and a real glyph from a real file", () => {
  // Both from `.pen` files this reader has imported: the welcome document's
  // arrow, and a battery cap whose node box is 4.075 tall while its ink is 4.
  assert.deepEqual(pathBounds("M7 0l0 14m7-7l-7 7-7-7"), { minX: 0, minY: 0, maxX: 14, maxY: 14 });
  assert.deepEqual(
    pathBounds("M0 0l0 4c0.80473-0.33878 1.32804-1.12687 1.32804-2 0-0.87313-0.52331-1.66122-1.32804-2"),
    { minX: 0, minY: 0, maxX: 1.32804, maxY: 4 },
  );
});

// -- the turn -----------------------------------------------------------------

test("a turn is absolute, and reversible", () => {
  const square = "M0 0L10 0L10 10L0 10Z";
  assert.equal(rotatePath(square, 90, 0, 0), "M0 0L0 10L-10 10L-10 0Z");
  assert.equal(rotatePath(square, 0, 0, 0), "M0 0L10 0L10 10L0 10Z");
  // Turning by θ and then by -θ gives the outline back — to the four decimals a
  // drawn turn is rounded to — which is what makes baking a rotation into the
  // geometry safe.
  const there = rotatePath("M7 0l0 14m7-7l-7 7-7-7", 45, 0, 0);
  const back = rotatePath(there, -45, 0, 0);
  assertPathClose(back, "M7 0L7 14M14 7L7 14L0 7");
});

test("a turn keeps the arc it turns", () => {
  // Radii and flags survive — a rotation is orientation-preserving, so the sweep
  // cannot flip — the ellipse's own angle moves with the coordinate system, and
  // the endpoint is a coordinate like any other and turns with it.
  assert.equal(rotatePath("M0 0A5 3 30 1 0 10 0", 0, 0, 0), "M0 0A5 3 30 1 0 10 0");
  assert.equal(rotatePath("M0 0A5 3 30 1 0 10 0", 15, 0, 0), "M0 0A5 3 45 1 0 9.6593 2.5882");
});

test("a turn about a point that is not the origin", () => {
  // The reader turns about the outline's own top-left corner, which for a glyph
  // drawn away from the origin is not (0,0).
  assert.equal(rotatePath("M10 10L20 10", 90, 10, 10), "M10 10L10 20");
});

test("a turn never writes a negative zero", () => {
  const turned = rotatePath("M0 0L0 5", 180, 0, 0);
  assert.equal(turned, "M0 0L0 -5");
  assert.ok(!/-0[ .]/.test(rotatePath("M1 1L2 1", 90, 0, 0)));
});
