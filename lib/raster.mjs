/**
 * lib/raster.mjs — find a browser that can turn HTML into pixels.
 *
 * Node cannot draw HTML. Every tool that exports an image has to borrow a
 * renderer, and this one borrows a browser already on the machine: no download,
 * no bundled Chromium, no dependency.
 *
 * Two paths, tried in order, and the order is deliberate:
 *
 *   1. a headless Chrome, Chromium or Edge, launched with `--screenshot`
 *   2. the canvas, which is already a browser and already has the page mounted
 *
 * If neither is available the export FAILS and says so. It does not quietly fall
 * back to another format: a PNG and an SVG are different deliverables, and
 * changing what the user asked for without telling them is worse than refusing.
 *
 * Detection is split from invocation so the policy — which paths exist, what to
 * say when none does — is testable without launching anything.
 */

import { existsSync } from "node:fs";

/** Where a Chrome-family browser usually lives, per platform. */
export const BROWSER_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Arc.app/Contents/MacOS/Arc",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

/** Also look for a browser on PATH, because a homebrew or nix install lives there. */
export const PATH_NAMES = [
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
  "chrome", "msedge", "microsoft-edge", "brave-browser",
];

/**
 * @param {object} deps `{ exists, which, platform }`, injected for testing.
 * @returns {{ path: string, name: string, from: "candidate" | "path" } | null}
 */
export function findBrowser(deps = {}) {
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? defaultWhich;

  for (const candidate of BROWSER_CANDIDATES[platform] ?? []) {
    if (exists(candidate)) return { path: candidate, name: nameOf(candidate), from: "candidate" };
  }
  for (const named of PATH_NAMES) {
    const found = which(named);
    if (found) return { path: found, name: nameOf(found), from: "path" };
  }
  return null;
}

function nameOf(target) {
  const base = String(target).split(/[/\\]/).pop() ?? target;
  if (/edge|msedge/i.test(base)) return "Microsoft Edge";
  if (/chrom/i.test(base)) return "Chromium";
  if (/brave/i.test(base)) return "Brave";
  if (/arc/i.test(base)) return "Arc";
  return "Google Chrome";
}

function defaultWhich(name) {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The command line that renders one page to one image.
 *
 * `--virtual-time-budget` is the load-bearing flag. Without it the screenshot is
 * taken before a web font arrives, and the page is captured in the fallback
 * font: the text wraps at different words and every box below it moves. That is
 * the most common way an image export is quietly wrong.
 */
export function screenshotArgs({ file, out, width, height, scale = 1, budgetMs = 6000 }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--force-device-scale-factor=${scale}`,
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    `--virtual-time-budget=${budgetMs}`,
    `--screenshot=${out}`,
    `file://${file}`,
  ];
}

export class RasterError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = "RasterError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Decide how to render, or refuse with three ways forward.
 *
 * @param {object} options `{ raster: "auto"|"chrome"|"canvas", canvasOnline: boolean }`
 * @param {object} deps `{ findBrowser: () => browser | null }`
 */
export function planRaster(options = {}, deps = {}) {
  const find = deps.findBrowser ?? findBrowser;
  const wanted = options.raster ?? "auto";

  if (wanted === "chrome" || wanted === "auto") {
    const browser = find();
    if (browser) return { route: "chrome", browser };
    if (wanted === "chrome") {
      throw new RasterError(
        "raster/no-browser",
        "No Chrome-family browser was found, and --raster chrome asks for one.",
        "Install Chrome, Chromium or Edge; or use --raster canvas with the canvas open; or use --format svg.",
      );
    }
  }

  if (wanted === "canvas" || wanted === "auto") {
    if (options.canvasOnline) return { route: "canvas", browser: null };
    if (wanted === "canvas") {
      throw new RasterError(
        "raster/no-canvas",
        "No canvas is open, and --raster canvas asks for one.",
        "Run `design.mjs serve <file>` and leave the tab open; or install a Chrome-family browser; or use --format svg.",
      );
    }
  }

  throw new RasterError(
    "raster/no-route",
    "Cannot turn HTML into pixels on this machine.",
    "Install Chrome, Chromium or Edge; or run `design.mjs serve <file>` and leave the canvas open; or export --format svg instead.",
  );
}

/** Formats this module can write, and what each needs. */
export const RASTER_FORMATS = {
  png: { needsBrowser: true, transparent: true },
  jpeg: { needsBrowser: true, transparent: false },
  jpg: { needsBrowser: true, transparent: false },
  webp: { needsBrowser: true, transparent: true },
};

export function isRasterFormat(format) {
  return Object.prototype.hasOwnProperty.call(RASTER_FORMATS, String(format).toLowerCase());
}
