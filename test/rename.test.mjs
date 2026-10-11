/**
 * `rename` is the one way an id changes.
 *
 * An id is an address. `set --attr data-id=…` writes the attribute and is
 * refused, because an address is not a property: this verb is what checks the new
 * name against the pattern the format accepts and writes it. Nothing else in the
 * document names an element by id, so the rename is one op and touches one line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../lib/parse.mjs";
import { applyOps } from "../lib/ops.mjs";
import { serialize } from "../lib/serialize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "design.mjs");
const REAL = join(ROOT, "examples", "miniprogram.html");

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const HEAD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Rename</title>
  <meta name="design-schema" content="3.0">
  <style>*,*::before,*::after{box-sizing:border-box}
*{margin:0}
img{display:block}
svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:root{ --color-ink:#111827 }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" style="width:390px;height:844px">
    <div data-id="card" data-type="frame" style="display:flex;flex-direction:column;width:200px">
      <p data-id="card__title" data-type="text" style="font-size:14px;color:#111827">Card</p>
    </div>
    <p data-id="home__tail" data-type="text" style="font-size:12px;color:#111827">tail</p>
  </section>
</body>
</html>
`;

function workspace(text = HEAD) {
  const dir = mkdtempSync(join(tmpdir(), "sd-rename-"));
  const file = join(dir, "design.html");
  writeFileSync(file, text);
  return { dir, file };
}

const read = (file) => readFileSync(file, "utf8");

/** Apply the inverse the receipt carried, and compare bytes. */
function undoRestores(file, original, receipt) {
  const changed = read(file);
  const next = parse(changed);
  const { doc: back } = applyOps(next, receipt.inverse);
  return serialize(next, back) === original;
}

test("renaming an element moves its id and nothing else", () => {
  const { file } = workspace();
  const original = read(file);

  const res = run(["rename", file, "card", "product", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary.errors, 0);
  assert.equal(receipt.applied.length, 1, "an id is one op; nothing else names it");

  const after = read(file);
  assert.match(after, /data-id="product"/);
  assert.doesNotMatch(after, /data-id="card"/);
  assert.match(after, /data-id="card__title"/, "a descendant's id does not move with its parent");
  assert.equal(after.split("\n").length, original.split("\n").length, "one line changed");

  assert.ok(undoRestores(file, original, receipt), "the inverse restores the original bytes");
});

test("renaming something that is not there is refused", () => {
  const { file } = workspace();
  const before = read(file);
  const res = run(["rename", file, "home__nope", "product"]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /No node with data-id "home__nope"/);
  assert.equal(read(file), before, "nothing was written");
});

test("an illegal new id is refused even with --force", () => {
  const { file } = workspace();
  const before = read(file);
  // Without the check in front, this would write an id the next validate refuses.
  const forced = run(["rename", file, "card", "1bad", "--force"]);
  assert.equal(forced.code, 1, "still refused");
  assert.equal(read(file), before, "and still nothing written");
});

test("renaming an id to itself changes nothing", () => {
  const { file } = workspace();
  const before = read(file);
  const res = run(["rename", file, "card", "card"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /already as asked/);
  assert.equal(read(file), before);
});

test("set refuses data-id, in every spelling, and names rename", () => {
  const { file } = workspace();
  const before = read(file);

  for (const args of [
    ["set", file, "card", "--attr", "data-id=product"],
    ["set", file, "card", "--attr", "DATA-ID=product"],
    ["set", file, "card", "--unset", "data-id"],
  ]) {
    const res = run(args);
    assert.equal(res.code, 1, `${args.join(" ")} must be refused`);
    assert.match(res.stdout, /REFUSED/);
    assert.match(res.stdout, /design\.mjs rename/, "the hint names the verb that owns an address");
    assert.equal(read(file), before, "and the file does not move");
  }

  const json = run(["set", file, "card", "--attr", "data-id=product", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).refused.code, "cli/data-id-is-the-address");
});

test("the real imported file keeps a clean ledger", () => {
  // Measured on the file the `.pen` importer produces, rather than on a synthetic
  // one: the baseline is read from the file, because a rename may not add an error
  // of any kind whatever the file already contains.
  const dir = mkdtempSync(join(tmpdir(), "sd-rename-real-"));
  const file = join(dir, "miniprogram.html");
  copyFileSync(REAL, file);
  const original = read(file);

  const target = /<section data-id="([^"]+)" data-type="page"/.exec(original)?.[1];
  assert.ok(target, "the example has a page to rename");
  const renamed = `${target}Z`;

  const before = JSON.parse(run(["validate", file, "--json"]).stdout);
  const baseline = before.diagnostics.filter((d) => d.severity === "error").length;

  const res = run(["rename", file, target, renamed, "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.summary.errors, baseline, `no new error (baseline ${baseline})`);

  // Minimality: every changed line is the same line with the id substituted.
  const a = original.split("\n");
  const b = read(file).split("\n");
  assert.equal(a.length, b.length, "no line was added or removed");
  const differing = a.map((line, i) => (line === b[i] ? null : i)).filter((i) => i !== null);
  assert.ok(differing.length > 0, "something changed");
  for (const i of differing) {
    assert.equal(a[i].replaceAll(target, renamed), b[i], `line ${i + 1} is not a pure substitution`);
  }
  assert.ok(undoRestores(file, original, receipt), "and the inverse restores it");
});
