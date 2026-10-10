/**
 * `rename` exists, and it carries the references with it.
 *
 * An id is an address. Two things besides the element point at one:
 *
 *   - `data-ref` on an instance, naming a component's `data-id`
 *   - a `data-overrides` key, naming a descendant of the component that instance
 *     points at
 *
 * Change the id alone and the file stops validating: every instance becomes
 * `component/unknown-ref` and every override that named the element becomes
 * `component/unknown-override-target`. `set --attr data-id=…` did exactly that,
 * which is why it is now refused and this verb is the one way through.
 *
 * The id op goes last. `applyOps` resolves each op against the tree the previous
 * one produced, so a `data-ref` op only finds its instance while that instance
 * still has the id being addressed.
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

const HEAD = (library, home) => `<!doctype html>
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
  <section data-id="lib" data-type="page" data-library="true" style="width:390px;height:200px">
${library}
  </section>
  <section data-id="home" data-type="page" style="width:390px;height:844px">
${home}
  </section>
</body>
</html>
`;

/** A component with one text descendant, and two instances that point at it. */
const CARD = HEAD(
  `    <div data-id="card" data-type="component" style="display:flex;flex-direction:column;width:200px">
      <p data-id="card__title" data-type="text" style="font-size:14px;color:#111827">Card</p>
    </div>`,
  `    <div data-id="home__a" data-type="instance" data-overrides="{&quot;card__title&quot;:{&quot;content&quot;:&quot;A&quot;}}" data-ref="card" style="width:200px"></div>
    <div data-id="home__b" data-type="instance" data-ref="card" style="width:200px"></div>`,
);

function workspace(text = CARD) {
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

test("renaming a component rewrites every data-ref", () => {
  const { file } = workspace();
  const original = read(file);

  const res = run(["rename", file, "card", "product", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary.errors, 0);

  const after = read(file);
  assert.match(after, /data-id="product"/);
  assert.equal(after.match(/data-ref="product"/g)?.length, 2, "both instances follow");
  assert.doesNotMatch(after, /data-ref="card"/);
  assert.match(after, /data-id="card__title"/, "a descendant's id does not move with its parent");
  assert.match(after, /&quot;card__title&quot;/, "and neither does an override keyed on one");

  assert.ok(undoRestores(file, original, receipt), "the inverse restores the original bytes");
});

test("renaming a descendant rewrites the data-overrides key", () => {
  const { file } = workspace();
  const original = read(file);

  const res = run(["rename", file, "card__title", "card__heading", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.summary.errors, 0);

  const after = read(file);
  assert.match(after, /data-id="card__heading"/);
  // The override key is JSON inside an HTML attribute, so the entity-escaped
  // form is what has to change. `parse` decodes `&quot;` and the serializer
  // escapes exactly that character back.
  assert.match(after, /data-overrides="\{&quot;card__heading&quot;:\{&quot;content&quot;:&quot;A&quot;\}\}"/);
  assert.doesNotMatch(after, /&quot;card__title&quot;/);
  assert.match(after, /data-ref="card"/, "the component's own id is untouched");

  assert.ok(undoRestores(file, original, receipt));
});

test("an instance's own id moves alone", () => {
  const { file } = workspace();
  const res = run(["rename", file, "home__a", "home__hero", "--json"]);
  assert.equal(res.code, 0, res.stderr);

  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.applied.length, 1, "nothing points at an instance");
  const after = read(file);
  assert.match(after, /data-id="home__hero"/);
  assert.equal(after.match(/data-ref="card"/g)?.length, 2, "both refs untouched");
  assert.match(after, /&quot;card__title&quot;/, "and the override untouched");
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

  const plain = run(["rename", file, "card", "1bad"]);
  assert.equal(plain.code, 1);
  assert.match(plain.stdout, /is not a legal id/);
  assert.equal(read(file), before);

  // The funnel's only guard is the new-error rule, and `--force` turns that off.
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
    assert.match(res.stdout, /design\.mjs rename/, "the hint names the verb that cascades");
    assert.equal(read(file), before, "and the file does not move");
  }

  const json = run(["set", file, "card", "--attr", "data-id=product", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).refused.code, "cli/data-id-is-the-address");
});

test("a broken data-overrides is left byte for byte", () => {
  // Not JSON: the cascade must not touch it. Rewriting what it cannot read would
  // be guessing at a value a person may still be editing.
  const broken = CARD.replace('data-overrides="{&quot;card__title&quot;:{&quot;content&quot;:&quot;A&quot;}}"', 'data-overrides="{oops"');
  const { file } = workspace(broken);
  const res = run(["rename", file, "card", "product"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(read(file), /data-overrides="\{oops"/, "the attribute came back as it was");
});

test("the real 239-instance file keeps a clean ledger", () => {
  // The cascade, measured on the file the `.pen` importer produces: 23
  // components, 239 instances, 140 overrides. The baseline is read from the file
  // rather than pinned here, because a rename may not add an error of any kind
  // whatever the file already contains. (It carried 18
  // `component/text-override-on-icon` errors until the example was regenerated;
  // that is what made a dynamic baseline the right shape.)
  const dir = mkdtempSync(join(tmpdir(), "sd-rename-real-"));
  const file = join(dir, "miniprogram.html");
  copyFileSync(REAL, file);
  const original = read(file);

  const before = JSON.parse(run(["validate", file, "--json"]).stdout);
  const baseline = before.diagnostics.filter((d) => d.severity === "error").length;

  const res = run(["rename", file, "x2cjUg", "z2cjUg", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.summary.errors, baseline, `no new error (baseline ${baseline})`);

  const after = JSON.parse(run(["validate", file, "--json"]).stdout);
  const codes = (list) => list.filter((d) => d.severity === "error").map((d) => d.code);
  assert.equal(codes(after.diagnostics).filter((c) => c === "component/unknown-ref").length, 0);
  assert.equal(codes(after.diagnostics).filter((c) => c === "component/unknown-override-target").length, 0);

  // Minimality: every changed line is the same line with the id substituted.
  const a = original.split("\n");
  const b = read(file).split("\n");
  assert.equal(a.length, b.length, "no line was added or removed");
  const differing = a.map((line, i) => (line === b[i] ? null : i)).filter((i) => i !== null);
  assert.ok(differing.length > 0, "something changed");
  for (const i of differing) {
    assert.equal(a[i].replaceAll("x2cjUg", "z2cjUg"), b[i], `line ${i + 1} is not a pure substitution`);
  }
  assert.ok(undoRestores(file, original, receipt), "and the inverse restores it");
});
