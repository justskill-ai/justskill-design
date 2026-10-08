import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectFormat, readerFor } from "../lib/detect.mjs";
import { distance, suggest, suggestAttr } from "../lib/levenshtein.mjs";
import { asIndex, formatPointer, getAtPointer, hasPointer, parsePointer } from "../lib/pointer.mjs";
import {
  FsError,
  fileExists,
  hashText,
  readText,
  revisionOf,
  unifiedDiff,
  walkWatch,
  writeAtomic,
} from "../lib/node/fs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESIGN = path.join(ROOT, "design.mjs");
const WORK = mkdtempSync(path.join(tmpdir(), "skill-design-cli-"));

test.after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

/** Run the CLI as a child process, exactly as a user or an agent would. */
function run(args) {
  return spawnSync(process.execPath, [DESIGN, ...args], { cwd: ROOT, encoding: "utf8" });
}

function writeFixture(name, text) {
  const file = path.join(WORK, name);
  writeFileSync(file, text, "utf8");
  return file;
}

/**
 * A starter design built here rather than through `new`, so the test does not
 * depend on the verb it is checking against.
 */
function starterHtml({ duplicateId = false } = {}) {
  const second = duplicateId
    ? `\n      <p data-id="home__title" data-type="text" style="font-size:16px">second</p>`
    : "";
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>home</title>
  <meta name="design-schema" content="3.0">
  <style>:root{ --color-bg:#ffffff; --space-md:16px }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px;overflow:hidden">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;width:100%;height:100%">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700">你好</p>${second}
    </div>
  </section>
</body>
</html>
`;
}

test("design.mjs --help prints usage and exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node design\.mjs <verb>/);
});

test("every verb prints its own usage on --help and exits 0", () => {
  for (const verb of ["new", "validate", "format", "ls", "show"]) {
    const result = run([verb, "--help"]);
    assert.equal(result.status, 0, `${verb} --help: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Usage: node design\\.mjs ${verb}`));
  }
});

test("design.mjs with an unknown verb prints usage and exits 2", () => {
  const result = run(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown verb: frobnicate/);
  assert.match(result.stderr, /Usage: node design\.mjs/);
});

test("validate: a valid file exits 0", () => {
  const file = writeFixture("valid.html", starterHtml());
  const result = run(["validate", file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 errors/);
});

test("validate: a duplicate data-id exits 1", () => {
  const file = writeFixture("duplicate.html", starterHtml({ duplicateId: true }));
  const result = run(["validate", file]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /structure\//);
});

test("validate: a missing file exits 2", () => {
  const missing = path.join(WORK, "does-not-exist.html");
  const result = run(["validate", missing]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No such file/);

  const json = run(["validate", missing, "--json"]);
  assert.equal(json.status, 2);
  assert.equal(JSON.parse(json.stdout).ok, false);
});

test("new --dry-run prints the starter and writes nothing", () => {
  const before = readdirSync(WORK).length;
  const result = run(["new", path.join(WORK, "dry.html"), "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^<!doctype html>/);
  assert.match(result.stdout, /data-schema|design-schema/);
  assert.equal(readdirSync(WORK).length, before);
});

test("new writes a file that validate accepts, and refuses to overwrite it", () => {
  const file = path.join(WORK, "fresh.html");
  const created = run(["new", file, "--name", "home", "--title", "home"]);
  assert.equal(created.status, 0, created.stderr);

  const validated = run(["validate", file]);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);

  const again = run(["new", file]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--force/);

  const forced = run(["new", file, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
});

test("new rejects bad arguments with exit 2", () => {
  const result = run(["new", path.join(WORK, "bad.html"), "--size", "wide"]);
  assert.equal(result.status, 2);
  const missing = run(["new"]);
  assert.equal(missing.status, 2);
});

test("ls lists pages and the tree under one id", () => {
  const file = writeFixture("ls.html", starterHtml());
  const pages = run(["ls", file]);
  assert.equal(pages.status, 0, pages.stderr);
  assert.match(pages.stdout, /home {2}page {2}section/);

  const tree = run(["ls", file, "--in", "home__root"]);
  assert.equal(tree.status, 0, tree.stderr);
  assert.match(tree.stdout, /^home__root {2}frame {2}div/m);
  assert.match(tree.stdout, /^ {2}home__title {2}text {2}p/m);

  const other = run(["ls", file, "--in", "nope"]);
  assert.equal(other.status, 1);
});

test("show prints one element with its open tag and attributes", () => {
  const file = writeFixture("show.html", starterHtml());
  const result = run(["show", file, "home__title"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700">/);
  assert.match(result.stdout, /text {8}你好/);

  const json = run(["show", file, "home__title", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.dataId, "home__title");
  assert.equal(payload.dataType, "text");
  assert.equal(payload.childCount, 0);

  const missing = run(["show", file, "nope"]);
  assert.equal(missing.status, 1);
});

test("format: --check reports a non-canonical file, and format makes it canonical", () => {
  const messy = starterHtml().replace(
    'style="display:flex;flex-direction:column;width:100%;height:100%"',
    'style="flex-direction:column;display:flex;width:100%;height:100%"',
  );
  const file = writeFixture("messy.html", messy);

  const before = run(["format", file, "--check"]);
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stdout, /not canonical/);

  const dry = run(["format", file, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /display:flex;flex-direction:column/);
  assert.equal(readFileSync(file, "utf8"), messy, "the dry run must not write");

  const written = run(["format", file]);
  assert.equal(written.status, 0, written.stderr);
  assert.match(readFileSync(file, "utf8"), /display:flex;flex-direction:column/);

  const after = run(["format", file, "--check"]);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /canonical/);

  // The formatted file is still a valid design.
  assert.equal(run(["validate", file]).status, 0);
});

test("format: a file the tool wrote is canonical, including CRLF input", () => {
  const file = writeFixture("crlf.html", starterHtml().replace(/\n/g, "\r\n"));
  assert.equal(run(["format", file, "--check"]).status, 1);
  assert.equal(run(["format", file]).status, 0);
  assert.equal(run(["format", file, "--check"]).status, 0);
  assert.equal(readFileSync(file, "utf8").includes("\r"), false);
});

/* ------------------------------------------------------------------ *
 * lib/pointer.mjs, lib/levenshtein.mjs and lib/detect.mjs — the small
 * helpers the verbs lean on. They live here because this is the only
 * Node-side test file the CLI owns.
 * ------------------------------------------------------------------ */

test("pointer: parse and format round trip, including escapes", () => {
  assert.deepEqual(parsePointer(""), []);
  assert.deepEqual(parsePointer("/"), [""]);
  assert.deepEqual(parsePointer("/pages/0/root"), ["pages", "0", "root"]);
  assert.deepEqual(parsePointer("/a~1b/c~0d"), ["a/b", "c~d"]);
  assert.equal(formatPointer(["pages", 0, "root"]), "/pages/0/root");
  assert.equal(formatPointer(["a/b", "c~d"]), "/a~1b/c~0d");
  assert.equal(formatPointer([]), "");
  const segments = ["pages", "0", "children", "1", "style", "background/color"];
  assert.deepEqual(parsePointer(formatPointer(segments)), segments);
  assert.throws(() => parsePointer("pages/0"), /Invalid JSON Pointer/);
});

test("pointer: getAtPointer reads arrays and objects, hasPointer answers existence", () => {
  const root = { pages: [{ id: "home" }] };
  assert.deepEqual(getAtPointer(root, "/pages/0/id").value, "home");
  assert.equal(hasPointer(root, "/pages/0/id"), true);
  assert.equal(hasPointer(root, "/pages/1/id"), false);
  assert.equal(hasPointer(root, ""), true);
  assert.equal(asIndex("03"), null);
  assert.equal(asIndex("3"), 3);
});

test("levenshtein: distance, suggest, and the attribute suggestion", () => {
  assert.equal(distance("", ""), 0);
  assert.equal(distance("kitten", "sitting"), 3);
  assert.equal(suggest("colour", ["color", "size"]), "color");
  assert.equal(suggest("zzzzzzzz", ["color"], 1), null);

  const allowed = ["background-color", "color", "data-kind", "display", "width"];
  assert.equal(suggestAttr("backgound-color", allowed), "background-color");
  assert.equal(suggestAttr("backgound-color", allowed).includes("background-color"), true);
  assert.equal(suggestAttr("DATA-KIND", allowed), "data-kind");
  assert.equal(suggestAttr("kind", allowed), "data-kind");
  assert.equal(suggestAttr("color", allowed), "color");
  assert.equal(suggestAttr("zzzzzzzzzz", allowed), null);
  assert.equal(suggestAttr("color", []), null);
});

test("detectFormat: the extension decides before the content does", () => {
  const html = "<!doctype html>\n<html></html>\n";
  const pen = JSON.stringify({ version: "3.0", children: [] });

  assert.equal(detectFormat("home.html", pen), "html");
  assert.equal(detectFormat("home.htm", pen), "html");
  assert.equal(detectFormat("home.pen", html), "pen");
  assert.equal(detectFormat("HOME.HTML", pen), "html");
});

test("detectFormat: content sniffing when the extension says nothing", () => {
  const pen = JSON.stringify({ version: "3.0", children: [] });

  assert.equal(detectFormat("design", pen), "pen");
  assert.equal(detectFormat("design", "  \n" + pen), "pen");
  assert.equal(detectFormat("design", "<section data-id=\"home\"></section>"), "html");
  assert.equal(detectFormat("design", "<!doctype html><style>:root{--a:1px}</style>"), "html");
  assert.equal(detectFormat("design", "{ not json at all"), "unknown");
  assert.equal(detectFormat("design", '{"version":"3.0"}'), "unknown");
  assert.equal(detectFormat("design", "just words"), "unknown");
  assert.equal(detectFormat("design", ""), "unknown");
});

test("readerFor: a lazy loader per format and detect/unknown-format otherwise", () => {
  const load = readerFor("html");
  assert.equal(typeof load, "function");
  const error = (() => {
    try {
      readerFor("pdf");
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.equal(error.name, "DetectError");
  assert.equal(error.code, "detect/unknown-format");
});

/* ------------------------------------------------------------------ *
 * lib/node/fs.mjs — the Node file layer the verbs share.
 * ------------------------------------------------------------------ */

test("writeAtomic writes the file and leaves no temp file behind", () => {
  const dir = mkdtempSync(path.join(WORK, "atomic-"));
  const file = path.join(dir, "design.html");
  writeAtomic(file, "first");
  assert.equal(readFileSync(file, "utf8"), "first");

  const written = writeAtomic(file, "second\n");
  assert.equal(readFileSync(file, "utf8"), "second\n");
  assert.equal(written.bytes, 7);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".")), []);
  assert.deepEqual(readdirSync(dir), ["design.html"]);
});

test("writeAtomic reports fs/no-write for a directory that does not exist", () => {
  let caught = null;
  try {
    writeAtomic(path.join(WORK, "no-such-dir", "x.html"), "x");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FsError);
  assert.equal(caught.code, "fs/no-write");
  assert.equal(caught.name, "FsError");
});

test("readText separates fs/not-found from fs/unreadable", () => {
  let missing = null;
  try {
    readText(path.join(WORK, "nope.html"));
  } catch (error) {
    missing = error;
  }
  assert.equal(missing.code, "fs/not-found");

  const dir = mkdtempSync(path.join(WORK, "dir-"));
  let directory = null;
  try {
    readText(dir);
  } catch (error) {
    directory = error;
  }
  assert.equal(directory.code, "fs/unreadable");
});

test("hashText and revisionOf are stable, 8 hex characters, and change with the text", () => {
  assert.match(hashText("hello"), /^[0-9a-f]{8}$/);
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("hello\n"));
  assert.equal(revisionOf("hello"), hashText("hello"));
  assert.equal(revisionOf({ source: "hello" }), hashText("hello"));
});

test("fileExists is true for a file and a directory, false for nothing", () => {
  const file = path.join(WORK, "exists.html");
  writeFileSync(file, "x");
  assert.equal(fileExists(file), true);
  assert.equal(fileExists(WORK), true);
  assert.equal(fileExists(path.join(WORK, "absent")), false);
});

test("unifiedDiff names the line that changed", () => {
  const before = "one\ntwo\nthree\n";
  const after = "one\nTWO\nthree\n";
  const diff = unifiedDiff(before, after, "before.html", "after.html");
  assert.match(diff, /^--- before\.html$/m);
  assert.match(diff, /^\+\+\+ after\.html$/m);
  assert.match(diff, /^-two$/m);
  assert.match(diff, /^\+TWO$/m);
  assert.equal(unifiedDiff(before, before, "a", "b"), "");
});

test("walkWatch returns a close function and reports a change once", async () => {
  const dir = mkdtempSync(path.join(WORK, "watch-"));
  const seen = [];
  const close = walkWatch(dir, (events) => seen.push(...events));
  assert.equal(typeof close, "function");

  writeFileSync(path.join(dir, "changed.html"), "<p></p>");
  await new Promise((resolve) => setTimeout(resolve, 400));

  close();
  close();
  assert.ok(seen.length >= 1, "expected at least one watch event");
  assert.ok(seen.some((event) => event.filename === "changed.html"));
});

test("walkWatch reports fs/not-found for a directory that is not there", () => {
  let caught = null;
  try {
    walkWatch(path.join(WORK, "no-such-directory"), () => {});
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, "fs/not-found");
});

test("set: a repeated --unset is every op, and a single-word property is a property", () => {
  // Two bugs lived here. A repeated flag kept only its last value, so
  // `--unset position --unset left --unset top` removed one declaration and said
  // nothing about the other two. And "a style property has a hyphen" called
  // `top` an attribute, so the edit was refused with `has no "top" attribute` —
  // for a declaration the file was carrying.
  const file = writeFixture("moved.html", starterHtml().replace(
    'data-canvas="0,0" style="width:390px',
    'data-canvas="600,2400" style="position:absolute;left:-85px;top:-352px;width:390px',
  ));
  const result = run(["set", file, "home", "--attr", "data-canvas=515,2048", "--unset", "position", "--unset", "left", "--unset", "top", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.applied.length, 4, JSON.stringify(receipt.applied));
  assert.deepEqual(receipt.applied.map((op) => op.prop), ["data-canvas", "style:position", "style:left", "style:top"]);

  const written = readFileSync(file, "utf8");
  assert.match(written, /data-canvas="515,2048"/);
  assert.ok(!/position:absolute|left:-85px|top:-352px/.test(written), written.slice(0, 400));

  const validated = run(["validate", file]);
  assert.equal(validated.status, 0);
  assert.match(validated.stdout, /0 errors/);
  assert.ok(!/structure\/page-position/.test(validated.stdout), validated.stdout);
});

test("set: a repeated --attr sets both attributes", () => {
  const file = writeFixture("attrs.html", starterHtml());
  const result = run(["set", file, "home", "--attr", "data-name=Home", "--attr", "data-locked=true", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const written = readFileSync(file, "utf8");
  assert.match(written, /data-name="Home"/);
  assert.match(written, /data-locked="true"/);
});
