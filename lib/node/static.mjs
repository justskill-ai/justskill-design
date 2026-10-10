/**
 * lib/node/static.mjs — the served-file whitelist for the canvas service.
 *
 * Two rules, and they are the whole file:
 *
 *   1. A route is a KEY in a Map, and a request path is only ever *looked up* in
 *      it. A request therefore never becomes a filesystem path, which is why
 *      `/lib/../package.json`, `/lib/%2e%2e%2fpackage.json` and every other
 *      escaping spelling miss the table instead of escaping a directory.
 *   2. The table is built from two literal sources: the list below, and a
 *      listing of three literal directories (`canvas/`, `lib/`, `lib/readers/`).
 *      Nothing under `lib/node/` is ever listed — those modules import `node:*`
 *      and must never cross the wire — and no request can add an entry.
 *
 * The browser parses the design file itself, so `lib/parse.mjs`, `lib/render.mjs`
 * and their neighbours are imported by the canvas as ES modules. That is why the
 * route list is explicit: the canvas can only fetch what this file names.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: `lib/node/static.mjs` → `../../`. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The canvas shell. `/` and this file are the same asset. */
export const SHELL_ROUTE = "/";
export const SHELL_FILE = "canvas/index.html";

/**
 * The explicit table: route → path relative to the package root.
 *
 * Every target here exists, and `test/serve.test.mjs` holds it that way: a route whose
 * file is not written yet belongs in `PLACEHOLDER_ROUTES`, where it answers 404 and says
 * so. Listing a missing file here used to be allowed — it 404s the same way — but then
 * the table could not be read as a promise, and nothing told the difference between "the
 * module landed" and "the module was renamed".
 *
 * The canvas modules listed are the names the canvas agent is known to use; the directory
 * listing in `buildRoutes` picks up any others it adds. That listing covers all of `lib/`,
 * so an entry here is documentation rather than a requirement: a module the canvas imports
 * is served whether or not it has a line in this table. Nothing needs a line added to
 * become reachable, and no test would fail if one were left out.
 */
export const STATIC_ROUTES = new Map([
  [SHELL_ROUTE, SHELL_FILE],
  ["/canvas/index.html", "canvas/index.html"],
  ["/canvas/styles.css", "canvas/styles.css"],
  ["/canvas/app.mjs", "canvas/app.mjs"],

  // The browser-side modules of the format. The design rule is that the canvas
  // parses and renders the file itself, so it imports these directly.
  ["/lib/parse.mjs", "lib/parse.mjs"],
  ["/lib/serialize.mjs", "lib/serialize.mjs"],
  ["/lib/render.mjs", "lib/render.mjs"],
  ["/lib/table.mjs", "lib/table.mjs"],
  ["/lib/validate.mjs", "lib/validate.mjs"],
  ["/lib/geometry.mjs", "lib/geometry.mjs"],
  ["/lib/normalize.mjs", "lib/normalize.mjs"],
  ["/lib/diagnostics.mjs", "lib/diagnostics.mjs"],
  ["/lib/spans.mjs", "lib/spans.mjs"],
  ["/lib/detect.mjs", "lib/detect.mjs"],
  ["/lib/levenshtein.mjs", "lib/levenshtein.mjs"],
  ["/lib/ops.mjs", "lib/ops.mjs"],
  ["/lib/fragment.mjs", "lib/fragment.mjs"],
  ["/lib/receipt.mjs", "lib/receipt.mjs"],
  ["/lib/tokens.mjs", "lib/tokens.mjs"],
  ["/lib/icons.mjs", "lib/icons.mjs"],
  ["/lib/readers/pen.mjs", "lib/readers/pen.mjs"],
]);

/**
 * Routes with no file behind them yet.
 *
 * They answer 404 like any unlisted path, and they are listed because the contract names
 * them: a reader of this file learns which modules are planned, and `test/serve.test.mjs`
 * requires every entry here to still be missing, so one that lands has to move up into
 * `STATIC_ROUTES` instead of quietly working.
 *
 * Empty on purpose. `lib/pointer.mjs` (RFC 6901 helpers, seventy lines nobody called) was
 * in the real table and is gone; the entries that were waiting here — `lib/icons.mjs` and
 * `lib/readers/pen.mjs` — both landed.
 */
export const PLACEHOLDER_ROUTES = new Map([]);

/**
 * Directories that are listed at start-up, literally.
 *
 * `lib/` is listed without recursion, so `lib/node/` stays unreachable. A file
 * is only added when its name is a plain file name (no separators, no leading
 * dot) and its resolved path stays inside the package root.
 */
export const SCANNED_DIRS = ["canvas", "lib", "lib/readers"];

/** A plain file name: the only shape a scanned entry may have. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `file` is `root` itself or lives under it, symlinks included. */
export function isInside(root, file) {
  const base = path.resolve(String(root));
  const target = path.resolve(String(file));
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  try {
    const real = fs.realpathSync(target);
    if (real !== base && !real.startsWith(base + path.sep)) return false;
  } catch {
    // The file does not exist yet. The path check above already holds, and the
    // route is re-checked at serve time, so a later symlink cannot slip through.
  }
  return true;
}

/**
 * Build the served map: the explicit table first, then whatever the three
 * literal directories hold. A request never contributes an entry.
 *
 * @param {string} [root] the package root, for tests that serve another tree
 * @returns {Map<string, string>} route → absolute file path
 */
export function buildRoutes(root = PACKAGE_ROOT) {
  const base = path.resolve(root);
  const routes = new Map();

  for (const [route, relative] of STATIC_ROUTES) {
    const file = path.resolve(base, relative);
    if (isInside(base, file)) routes.set(route, file);
  }

  for (const dir of SCANNED_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(base, dir), { withFileTypes: true });
    } catch {
      continue; // the directory does not exist yet
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue; // no subdirectories, so lib/node/ stays out
      if (!SAFE_NAME.test(entry.name)) continue;
      const relative = `${dir}/${entry.name}`;
      const route = `/${relative}`;
      if (routes.has(route)) continue; // the explicit table wins
      const file = path.resolve(base, relative);
      if (!isInside(base, file)) continue;
      routes.set(route, file);
    }
  }

  return routes;
}

/**
 * Resolve a request path against the map. A miss is `null`, never a path.
 *
 * The path arrives percent-encoded; it is decoded once so an escaped name still
 * matches an entry, and then it is only used as a Map key. A decoded `..`, a
 * backslash or a NUL simply does not match anything.
 *
 * @param {Map<string, string>} routes
 * @param {string} pathname
 * @returns {{route: string, file: string} | null}
 */
export function routeFor(routes, pathname) {
  if (!routes || typeof pathname !== "string" || pathname === "") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // a malformed escape is not a route
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const file = routes.get(decoded);
  return file ? { route: decoded, file } : null;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The MIME type for a served file. `.mjs` must be a JavaScript type or the
 * browser refuses the module.
 *
 * @param {string} file
 * @returns {string}
 */
export function contentTypeOf(file) {
  return CONTENT_TYPES[path.extname(String(file)).toLowerCase()] || "application/octet-stream";
}
