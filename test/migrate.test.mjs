/**
 * `migrate` exists, and it is the command the validator tells people to run.
 *
 * `version/unsupported` prints "Run `design migrate` to move the file to 3.0",
 * and for a while there was no such verb: the hint named a command nobody could
 * run, which is a dead end, and a dead end is the one thing this tool promises
 * not to hand back.
 *
 * There is no older HTML schema here, so migrate fixes the version marker and
 * nothing else. Two properties matter more than the rewrite itself:
 *
 *   1. A file that is already current is left alone down to its modification
 *      time. Re-running a migration must be free, and "nothing to do" must not
 *      count as a change.
 *   2. It may not introduce an error, the same rule every other write obeys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "design.mjs");

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const MARKER = '<meta name="design-schema" content="3.0">';

/** A valid, current file: the two style blocks and one page, nothing else. */
const CURRENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Migrate</title>
  ${MARKER}
  <style>:root{ --color-ink:#111827 }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" style="width:390px;height:844px">
    <p data-id="home__title" data-type="text" style="font-size:32px">Hi</p>
  </section>
</body>
</html>
`;

function workspace(text = CURRENT) {
  const dir = mkdtempSync(join(tmpdir(), "sd-migrate-"));
  const file = join(dir, "design.html");
  writeFileSync(file, text);
  return { dir, file };
}

const read = (file) => readFileSync(file, "utf8");

test("a file that is already current is not touched at all", () => {
  const { file } = workspace();
  const before = read(file);
  // An old timestamp and an old access time: if the verb writes, this moves.
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(file, old, old);
  const stampBefore = statSync(file, { bigint: true });

  const res = run(["migrate", file]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /already 3\.0/);

  const stampAfter = statSync(file, { bigint: true });
  assert.equal(read(file), before, "the bytes are identical");
  assert.equal(stampAfter.mtimeNs, stampBefore.mtimeNs, "the modification time did not move");
  assert.equal(stampAfter.ino, stampBefore.ino, "and it is the same file");
});

test("a wrong version is rewritten in place, one line", () => {
  const { file } = workspace(CURRENT.replace('content="3.0"', 'content="2.0"'));
  const before = read(file);

  const res = run(["migrate", file]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /schema 2\.0 → 3\.0/);

  const after = read(file);
  assert.match(after, /content="3\.0"/);
  assert.doesNotMatch(after, /content="2\.0"/);

  // Exactly one line differs, and it is the marker's line.
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length, "no line was added or removed");
  const differing = a.map((line, i) => (line === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(differing.length, 1, `lines ${differing.join(", ")} differ`);
  assert.match(b[differing[0]], /design-schema/);
  assert.equal(a[differing[0]].replace("2.0", "3.0"), b[differing[0]], "and only the version changed");
});

test("a file with no marker gets one, indented like its neighbours", () => {
  const { file } = workspace(CURRENT.replace(`  ${MARKER}\n`, ""));

  const res = run(["migrate", file]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /no marker → 3\.0/);

  const after = read(file);
  // After `<title>`, which is where every file in this repository has it, and
  // with the same two-space indent its siblings use.
  assert.match(after, /\n {2}<meta name="design-schema" content="3\.0">\n/);

  const validated = run(["validate", file]);
  assert.equal(validated.code, 0, validated.stdout + validated.stderr);
});

test("a file with no <head> gets one", () => {
  const { file } = workspace(
    '<!doctype html>\n<html lang="en">\n<body>\n'
    + '<section data-id="home" data-type="page" style="width:100px;height:100px"></section>\n'
    + "</body>\n</html>\n",
  );

  const res = run(["migrate", file]);
  assert.equal(res.code, 0, res.stderr);
  const after = read(file);
  assert.match(after, /<head>\n<meta name="design-schema" content="3\.0">\n<\/head>/);
  // The head is created inside `<html>`, before the body it already had.
  assert.ok(after.indexOf("<head>") > after.indexOf("<html"), "the head sits inside html");
  assert.ok(after.indexOf("</head>") < after.indexOf("<body>"), "and before the body");
});

test("--dry-run prints the diff and writes nothing", () => {
  const { file } = workspace(CURRENT.replace('content="3.0"', 'content="1.0"'));
  const before = read(file);

  const res = run(["migrate", file, "--dry-run"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /-.*content="1\.0"/);
  assert.match(res.stdout, /\+.*content="3\.0"/);
  assert.equal(read(file), before, "a dry run must not write");
});

test("--json is one parseable receipt", () => {
  const { file } = workspace(CURRENT.replace('content="3.0"', 'content="2.0"'));
  const res = run(["migrate", file, "--json"]);
  assert.equal(res.code, 0, res.stderr);

  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verb, "migrate");
  assert.equal(receipt.changed, true);
  assert.equal(receipt.from, "2.0");
  assert.equal(receipt.to, "3.0");
  assert.equal(receipt.summary.errors, 0);
  assert.match(receipt.revision, /^[0-9a-f]{8}$/);
});

test("the command the validator names is the command that fixes it", () => {
  // The whole point of the verb: follow the hint, and the file validates.
  const { file } = workspace(CURRENT.replace('content="3.0"', 'content="2.0"'));

  const broken = run(["validate", file]);
  assert.equal(broken.code, 1, "a wrong marker is an error");
  assert.match(broken.stdout, /design migrate/, "and the hint names this verb");

  assert.equal(run(["migrate", file]).code, 0);
  assert.equal(run(["validate", file]).code, 0, "following the hint fixed the file");
});

test("running it twice is the same as running it once", () => {
  const { file } = workspace(CURRENT.replace('content="3.0"', 'content="2.0"'));
  run(["migrate", file]);
  const once = read(file);
  const res = run(["migrate", file]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /already 3\.0/);
  assert.equal(read(file), once, "idempotent");
});

test("exit codes: a missing file is 2, and --help is 0", () => {
  const missing = run(["migrate", join(tmpdir(), "sd-migrate-does-not-exist.html")]);
  assert.equal(missing.code, 2);

  const help = run(["migrate", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node design\.mjs migrate/);

  const listed = run(["--help"]);
  assert.match(listed.stdout, /migrate <file>/, "and the verb is in the top-level list");
});
