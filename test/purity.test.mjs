/**
 * The browser boundary, and the HTML the canvas loads.
 *
 * Every file directly under `lib/` is served to the canvas over HTTP. That is not a
 * convention, it is what `lib/node/static.mjs` does: `buildRoutes` shallow-scans `lib/`
 * and whitelists each `.mjs` it finds. So a module under `lib/` that imports `node:fs` is
 * a module the browser downloads and then dies on — and the failure is a blank canvas,
 * not a test failure, because nothing was checking.
 *
 * Two real defects came out of this boundary and both are pinned here:
 *
 *   - `lib/export-svg.mjs` reached for `node:fs` and `process.env` inside a function, with
 *     `await import("node:fs")`. Dynamic, so a reader and every check that looks at the top
 *     of a file saw nothing. The node half now lives in `lib/node/export-svg.mjs`.
 *   - `lib/raster.mjs` had a top-level `import { existsSync } from "node:fs"` and defaulted
 *     `platform` to `process.platform`, so the file threw on load in a browser. It now takes
 *     the machine as an argument, and `lib/node/raster-run.mjs` is the only place that
 *     answers.
 *
 * ## Comments are not usage
 *
 * A file that explains *why* it avoids `process.platform` mentions `process.platform`, and
 * a check that greps the raw text flags it. The scan strips comments and string literals
 * first. That is what "real usage, not a mention" has to mean if it is to mean anything.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../lib/parse.mjs";
import { isCanonical } from "../lib/normalize.mjs";
import { buildRoutes } from "../lib/node/static.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");
const CANVAS = join(ROOT, "canvas");

const read = (file) => readFileSync(file, "utf8");

function filesIn(dir, extension) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(extension)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** `lib/` without `lib/node/`, which is the only place node code may live. */
const browserModules = () => filesIn(LIB, ".mjs").filter((file) => !file.includes(`${LIB}/node/`));

/**
 * The source with comments removed, and nothing else.
 *
 * A claim about imports is a claim about code, and code inside a comment is not code —
 * `lib/raster.mjs` explains *why* it avoids `process.platform` and would otherwise be
 * caught by its own explanation.
 *
 * String bodies are KEPT. The first version of this stripped them too, which made
 * `"node:fs"` invisible to the very check that looks for `"node:fs"` — a sanitiser that
 * deletes the evidence. Handles `//` and `/* *​/` while tracking the three quote
 * characters, so a `//` inside a URL is not a comment; a regex literal containing `//`
 * would confuse it, and there are none in this tree.
 */
function withoutComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. The boundary itself
 * ------------------------------------------------------------------ */

test("no module served to the browser imports a node: builtin", () => {
  const offenders = [];
  for (const file of [...browserModules(), ...filesIn(CANVAS, ".mjs")]) {
    const code = withoutComments(read(file));
    if (/from\s*["']node:/.test(code) || /import\s*\(\s*["']node:/.test(code) || /\brequire\s*\(/.test(code)) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `these would throw in the browser:\n  ${offenders.join("\n  ")}`);
});

test("node-only code is confined to lib/node/", () => {
  const patterns = [
    [/(?:^|\n)\s*import\s[^"']*["']node:/, "a node: import"],
    [/\brequire\s*\(/, "require()"],
    [/\bprocess\.(?:env|argv|exit|cwd|platform|versions)\b/, "process.*"],
    [/\b__(?:dirname|filename)\b/, "__dirname/__filename"],
    [/\bBuffer\.(?:from|alloc|concat)\b/, "Buffer.*"],
    [/\bimport\s*\(\s*["']node:/, "a dynamic node: import"],
  ];
  const offenders = [];
  for (const file of browserModules()) {
    const code = withoutComments(read(file));
    for (const [pattern, label] of patterns) {
      if (pattern.test(code)) offenders.push(`${relative(ROOT, file)} uses ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `move node-only code into lib/node/:\n  ${offenders.join("\n  ")}`);
});

test("the canvas never asks the browser for a file handle", () => {
  const forbidden = [
    "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker",
    "FileSystemFileHandle", "FileSystemWritableFileStream", "webkitRequestFileSystem",
  ];
  for (const file of filesIn(CANVAS, ".mjs")) {
    const code = withoutComments(read(file));
    for (const api of forbidden) {
      assert.ok(!code.includes(api), `${relative(ROOT, file)} must not use ${api}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. What the browser is allowed to fetch
 * ------------------------------------------------------------------ */

const routes = buildRoutes(ROOT);

function specifiersOf(source) {
  const out = [];
  const re = /(?:^|\n)\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
  return out;
}

/** Resolve a specifier the way the browser would: a rooted path is served as written. */
function servedPath(specifier, fromFile) {
  if (/^[a-z]+:/.test(specifier)) return null;
  if (specifier.startsWith("/")) return specifier.slice(1);
  return relative(ROOT, resolve(dirname(fromFile), specifier)).split("\\").join("/");
}

test("every module the canvas imports is reachable over HTTP, and none is node-only", () => {
  const seen = new Set();
  const queue = ["canvas/app.mjs"];
  const missing = [];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!routes.has(`/${rel}`)) missing.push(rel);
    const file = join(ROOT, rel);
    for (const spec of specifiersOf(read(file))) {
      const resolved = servedPath(spec, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  assert.deepEqual(missing, [], `not reachable over HTTP: ${missing.join(", ")}`);
  for (const rel of seen) {
    assert.ok(!rel.startsWith("lib/node/"), `${rel} must not be served to the browser`);
  }
  assert.ok(seen.size > 5, `only ${seen.size} modules walked; the entry point moved?`);
});

test("every name the canvas imports from /lib/ is really exported", async () => {
  const missing = [];
  for (const file of filesIn(CANVAS, ".mjs")) {
    const source = read(file);
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\/lib\/[^"']+)["']/g)) {
      const names = match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const module = await import(new URL(`../${match[2].slice(1)}`, import.meta.url));
      for (const name of names) {
        if (!(name in module)) missing.push(`${relative(ROOT, file)} imports { ${name} } from ${match[2]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `the canvas would fail to import:\n  ${missing.join("\n  ")}`);
});

test("a static route is served from the whitelist, never from a joined path", () => {
  const server = read(join(LIB, "node", "server.mjs"));
  assert.match(server, /routeFor\(routes, url\.pathname\)/, "static requests must go through routeFor");
  assert.ok(
    !/path\.join\(\s*PACKAGE_ROOT\s*,\s*url\.pathname/.test(server),
    "never join a raw URL path onto the package root",
  );

  // And `routeFor` itself has to be the map lookup, or the guard above is a formality.
  const staticModule = withoutComments(read(join(LIB, "node", "static.mjs")));
  assert.match(staticModule, /routes\.get\(decoded\)/, "routeFor must get from the whitelist map");
  assert.ok(
    !/readFileSync\(\s*path\.join/.test(staticModule),
    "routeFor must not read a path it built from the request",
  );
});

/* ------------------------------------------------------------------ *
 * 3. The HTML the canvas loads
 * ------------------------------------------------------------------ */

test("index.html loads only whitelisted assets and has no inline script", () => {
  const html = read(join(CANVAS, "index.html"));
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(refs.length > 0, "index.html references nothing");
  for (const ref of refs) {
    if (/^https?:/.test(ref)) continue;
    assert.ok(routes.has(ref), `${ref} is not in the static whitelist`);
  }
  assert.match(html, /<script type="module" src="\/canvas\/app\.mjs"><\/script>/);
  assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline script: it would need a CSP exception");
});

test("every element the canvas looks up by id exists in index.html", () => {
  const ids = new Set([...read(join(CANVAS, "index.html")).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const file of filesIn(CANVAS, ".mjs")) {
    const source = read(file);
    for (const match of source.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (!ids.has(match[1])) missing.push(`${relative(ROOT, file)} -> #${match[1]}`);
    }
    for (const match of source.matchAll(/(?:querySelector|querySelectorAll|closest|matches)\(\s*["'`]#([A-Za-z][\w-]*)["'`]/g)) {
      if (!ids.has(match[1])) missing.push(`${relative(ROOT, file)} -> #${match[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "the canvas would throw on a null element");
});

/**
 * A class the canvas sets is either styled by the stylesheet or looked up by something.
 *
 * Not "every class has a rule", which is what this check said first and what `page-host`
 * disproved: that element is sized by the page's own declared height, so its width,
 * height, overflow and radius are set inline, and the class exists so the tree can be
 * addressed (`.page-box[data-page-id=…] .page-host`). A rule for it would be dead CSS.
 *
 * What must not happen is a class that is neither: a name nothing styles and nothing
 * queries is a typo, and the element it was meant to shape is invisible.
 */
test("every class the canvas builds is styled, or is a marker something looks up", () => {
  const css = read(join(CANVAS, "styles.css"));
  const sources = filesIn(CANVAS, ".mjs").map((file) => read(file));
  const built = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/class(?:Name)?\s*=\s*[`"']([^`"']+)[`"']/g)) {
      for (const name of match[1].split(/\s+/)) if (name && !name.includes("$")) built.add(name);
    }
  }
  const orphans = [...built].filter((name) => {
    if (new RegExp(`\\.${name}\\b`).test(css)) return false;
    const looked = new RegExp(`["'\`][^"'\`]*\\.${name}(?![\\w-])`).test(sources.join("\n"));
    return !looked;
  });
  assert.deepEqual(orphans, [], `styled by nothing and queried by nothing: ${orphans.join(", ")}`);
});

/* ------------------------------------------------------------------ *
 * 4. The examples are canonical, which is the claim the README makes
 * ------------------------------------------------------------------ */

/**
 * `README.md` says a design file is a valid self-contained HTML file, and
 * `docs/format-v3.md` §5 says a file this repository publishes is already in canonical
 * form. Nothing was testing that on `examples/`, so an example could drift into a shape
 * `format` would rewrite and nobody would see it.
 *
 * The obvious check — `serialize(parse(text), parse(text)) === text` — is vacuous: with no
 * edits, `serialize` returns the origin's bytes by design, so it can never fail. A mutation
 * (`<!doctype  html>`, two spaces) proved it. `isCanonical` is the function that exists for
 * this question, and it compares the text to the canonical form rather than to itself.
 */
test("every published example is already in canonical form", () => {
  const files = readdirSync(join(ROOT, "examples")).filter((name) => name.endsWith(".html"));
  assert.ok(files.length > 0, "expected at least one example");
  for (const name of files) {
    const text = read(join(ROOT, "examples", name));
    const doc = parse(text, { file: name, format: "html", source: text });
    const verdict = isCanonical(doc);
    assert.ok(
      verdict.canonical,
      `examples/${name} is not canonical: ${verdict.reasons.slice(0, 3).join("; ")}`,
    );
  }
});
