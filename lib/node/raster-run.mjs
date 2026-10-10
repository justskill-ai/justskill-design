/**
 * lib/node/raster-run.mjs — the part of rasterisation that starts a process.
 *
 * `lib/raster.mjs` decides; this runs. The split is what keeps the policy
 * testable without launching a browser in a test.
 *
 * The browser is given a `--screenshot` path and a window size, waits for fonts,
 * and exits. Nothing is installed and nothing is left running.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { findBrowser, planRaster, screenshotArgs, RasterError } from "../raster.mjs";

/**
 * The machine, as `lib/raster.mjs` needs to see it.
 *
 * That module is served to the canvas, so it may not import `node:fs` or read `process`.
 * The three facts it needs to look for a browser are handed to it here instead, and this
 * is the only place in the tree that answers them — which is what keeps "is there a
 * browser" a policy question with one implementation.
 */
const MACHINE = {
  exists: existsSync,
  platform: process.platform,
  which(name) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  },
};

/** `findBrowser` bound to this machine, in the shape `planRaster` asks for. */
const onThisMachine = () => findBrowser(MACHINE);

/**
 * Render one HTML file to one image.
 *
 * @param {object} options `{ htmlPath, outPath, width, height, scale, raster, canvasOnline, timeoutMs }`
 * @returns {Promise<{ path: string, bytes: number, route: string, browser: string }>}
 */
export async function renderToImage(options) {
  const plan = planRaster(
    { raster: options.raster, canvasOnline: options.canvasOnline },
    { findBrowser: onThisMachine },
  );

  if (plan.route === "canvas") {
    // The canvas is a browser that already has the page mounted. It rasterises
    // and posts the bytes back, which is the same route the service offers for a
    // machine with no Chrome-family browser installed.
    throw new RasterError(
      "raster/canvas-not-wired",
      "The canvas route needs a canvas to be open and reachable.",
      "Run `design.mjs serve <file>` and leave the tab open, or install a Chrome-family browser.",
    );
  }

  const args = screenshotArgs({
    file: options.htmlPath,
    out: options.outPath,
    width: options.width,
    height: options.height,
    scale: options.scale ?? 1,
    budgetMs: options.budgetMs ?? 6000,
  });

  const result = await run(plan.browser.path, args, options.timeoutMs ?? 60000);
  if (result.code !== 0 && !existsSync(options.outPath)) {
    throw new RasterError(
      "raster/browser-failed",
      `${plan.browser.name} exited ${result.code} without writing an image.`,
      result.stderr.trim().split("\n").slice(-3).join(" ") || "Run the same command by hand to see the browser's output.",
    );
  }
  if (!existsSync(options.outPath)) {
    throw new RasterError("raster/no-output", `${plan.browser.name} wrote no image.`, "Check that the page is a file the browser can open.");
  }

  return {
    path: options.outPath,
    bytes: statSync(options.outPath).size,
    route: plan.route,
    browser: plan.browser.name,
  };
}

/** Spawn, collect, never reject on a non-zero exit: the caller reads the code. */
function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RasterError("raster/timeout", `${command} did not finish within ${timeoutMs} ms.`, "Raise the timeout, or check the page for a request that never settles."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new RasterError("raster/spawn-failed", `Cannot run ${command}: ${error.message}`, "Check the browser path with `which google-chrome`."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
