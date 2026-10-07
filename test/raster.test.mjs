/**
 * The raster decision, and the browser command it produces.
 *
 * Detection is purposefully separate from launching so the policy is testable:
 * which routes exist, what happens when none does, and — the part that matters
 * most — that the tool never quietly writes a different format than the one the
 * user asked for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findBrowser, planRaster, screenshotArgs, isRasterFormat, RasterError,
  BROWSER_CANDIDATES, PATH_NAMES,
} from "../lib/raster.mjs";

// -- detection ----------------------------------------------------------------

test("a browser in a standard location is found, and named", () => {
  const known = BROWSER_CANDIDATES.darwin[0];
  const found = findBrowser({ exists: (p) => p === known, which: () => null, platform: "darwin" });
  assert.equal(found.path, known);
  assert.equal(found.from, "candidate");
  assert.ok(found.name.length > 0);
});

test("Edge and Chromium are told apart from Chrome", () => {
  const edge = BROWSER_CANDIDATES.darwin.find((p) => p.includes("Edge"));
  assert.equal(findBrowser({ exists: (p) => p === edge, which: () => null, platform: "darwin" }).name, "Microsoft Edge");
  const chromium = BROWSER_CANDIDATES.darwin.find((p) => p.includes("Chromium"));
  assert.equal(findBrowser({ exists: (p) => p === chromium, which: () => null, platform: "darwin" }).name, "Chromium");
});

test("a browser is found on PATH when no standard location matches", () => {
  const found = findBrowser({ exists: () => false, which: (name) => (name === "chromium" ? "/opt/bin/chromium" : null), platform: "linux" });
  assert.equal(found.path, "/opt/bin/chromium");
  assert.equal(found.from, "path");
});

test("no browser at all is null, not a throw", () => {
  assert.equal(findBrowser({ exists: () => false, which: () => null, platform: "darwin" }), null);
  assert.equal(findBrowser({ exists: () => false, which: () => null, platform: "sunos" }), null);
});

test("every platform has candidates, and PATH names are bare", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.ok(BROWSER_CANDIDATES[platform].length > 0, `${platform} has no candidates`);
  }
  for (const name of PATH_NAMES) assert.ok(!name.includes("/"), `${name} is not a bare name`);
});

// -- the route ----------------------------------------------------------------

test("auto prefers a browser, and falls to the canvas when there is none", () => {
  const withBrowser = planRaster({ raster: "auto" }, { findBrowser: () => ({ path: "/chrome", name: "Google Chrome" }) });
  assert.equal(withBrowser.route, "chrome");

  const withoutBrowser = planRaster({ raster: "auto", canvasOnline: true }, { findBrowser: () => null });
  assert.equal(withoutBrowser.route, "canvas");
});

test("asking for canvas specifically does not launch a browser", () => {
  const plan = planRaster({ raster: "canvas", canvasOnline: true }, { findBrowser: () => ({ path: "/chrome", name: "Google Chrome" }) });
  assert.equal(plan.route, "canvas");
});

test("when nothing can render, the refusal names three ways forward", () => {
  assert.throws(() => planRaster({ raster: "auto" }, { findBrowser: () => null }), (error) => {
    assert.equal(error.code, "raster/no-route");
    assert.match(error.hint, /Chrome/);
    assert.match(error.hint, /canvas/);
    assert.match(error.hint, /svg/);
    return true;
  });
});

test("a forced route that is missing refuses instead of switching format", () => {
  assert.throws(() => planRaster({ raster: "chrome" }, { findBrowser: () => null }), (error) => {
    assert.equal(error.code, "raster/no-browser");
    assert.match(error.hint, /svg/, "the third way out is named");
    return true;
  });
  assert.throws(() => planRaster({ raster: "canvas", canvasOnline: false }), (error) => {
    assert.equal(error.code, "raster/no-canvas");
    return true;
  });
});

// -- the command --------------------------------------------------------------

test("the screenshot command waits for fonts before it captures", () => {
  const args = screenshotArgs({ file: "/tmp/a.html", out: "/tmp/a.png", width: 375, height: 812 });
  // Without a virtual time budget the page is captured in the fallback font:
  // the text wraps at other words and everything below it moves.
  assert.ok(args.some((a) => a.startsWith("--virtual-time-budget=")), "no font wait");
  assert.ok(args.includes("--screenshot=/tmp/a.png"));
  assert.ok(args.includes("--window-size=375,812"));
  assert.ok(args.includes("file:///tmp/a.html"));
  assert.ok(args.includes("--headless=new"));
});

test("scale and a fractional size are passed through, rounded", () => {
  const args = screenshotArgs({ file: "/a.html", out: "/a.png", width: 375.4, height: 812.6, scale: 2 });
  assert.ok(args.includes("--window-size=375,813"));
  assert.ok(args.includes("--force-device-scale-factor=2"));
});

test("the format table says which outputs need a browser", () => {
  for (const format of ["png", "jpeg", "jpg", "webp"]) assert.equal(isRasterFormat(format), true, format);
  for (const format of ["html", "svg", "pen"]) assert.equal(isRasterFormat(format), false, format);
});

test("RasterError carries a code and a hint, so a caller can act", () => {
  const error = new RasterError("raster/x", "message", "hint");
  assert.equal(error.name, "RasterError");
  assert.equal(error.code, "raster/x");
  assert.equal(error.hint, "hint");
});
