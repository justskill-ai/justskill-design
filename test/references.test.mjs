/**
 * The reference documents must be generated from the format table, never
 * hand-written.
 *
 * A second copy of the rules drifts. The failure mode is quiet and expensive:
 * the documentation says a value is fine, the validator refuses it, and the
 * model believes the documentation. This test fails when the two disagree.
 *
 * `references/images.md` is the one exception: it is data (a catalogue of photos),
 * not a rendering of the table, so it is written by hand and held to its own
 * contract in `test/images.test.mjs`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { iconNames } from "../lib/icons.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

test("every reference file is up to date with the format table", () => {
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "gen-references.mjs"), "--check"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(run.status, 0, `references are stale:\n${run.stdout}${run.stderr}`);
});

test("the reference set matches what SKILL.md points at", () => {
  const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  for (const name of ["styling.md", "schema.md"]) {
    assert.ok(skill.includes(`references/${name}`), `SKILL.md does not mention references/${name}`);
    assert.ok(existsSync(join(ROOT, "references", name)), `references/${name} is missing`);
  }
});

test("SKILL.md stays inside the size a skill body should be", () => {
  const lines = readFileSync(join(ROOT, "SKILL.md"), "utf8").split("\n").length;
  assert.ok(lines < 500, `SKILL.md is ${lines} lines; keep it under 500 and move detail into references/`);
});

/**
 * "SKILL.md names every verb the CLI exposes" moved to `test/contract.test.mjs`, which
 * derives the list from `VERBS` in `design.mjs`.
 *
 * This test held a hand-written list of twelve names. It passed for as long as the CLI
 * happened not to grow a verb, and when it did — `rename`, `migrate`, `tokens` — the copy
 * had to be edited by hand or it would have gone on passing while SKILL.md said nothing
 * about them. A second copy of the truth is a second truth, and the copy is what rots.
 */

test("the frontmatter carries a name and a description", () => {
  const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  assert.match(skill, /^---\n/, "SKILL.md must start with frontmatter");
  const front = skill.slice(4, skill.indexOf("\n---", 4));
  assert.match(front, /^name: justskill-design$/m);
  assert.match(front, /^description: >-$/m);
  const description = front.slice(front.indexOf("description:"));
  assert.ok(description.length > 300, "the description is the trigger, so it must say when to use this");
});

test("no reference document has a hole in it", () => {
  // `ICONS.length` on an object put the word "undefined" into schema.md, and the
  // `--check` above stayed green the whole time because the generator and the
  // artifact were wrong in the same way. A consistency check is not a
  // correctness check, so this one looks at the words.
  for (const name of ["styling.md", "schema.md", "cookbook.md"]) {
    const text = readFileSync(join(ROOT, "references", name), "utf8");
    assert.doesNotMatch(text, /\bundefined\b/, `references/${name} says "undefined"`);
    assert.doesNotMatch(text, /\bNaN\b/, `references/${name} says "NaN"`);
    assert.doesNotMatch(text, /\[object Object\]/, `references/${name} stringified an object`);
  }
});

test("the reference states the glyph count the table actually has", () => {
  const schema = readFileSync(join(ROOT, "references", "schema.md"), "utf8");
  const count = iconNames().length;
  assert.ok(count > 0, "the icon table is empty");
  assert.match(
    schema,
    new RegExp(`with ${count} glyphs`),
    `references/schema.md must say ${count} glyphs`,
  );
});
