/**
 * The reference documents must be generated from the format table, never
 * hand-written.
 *
 * A second copy of the rules drifts. The failure mode is quiet and expensive:
 * the documentation says a value is fine, the validator refuses it, and the
 * model believes the documentation. This test fails when the two disagree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("SKILL.md names every verb the CLI exposes", () => {
  const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  for (const verb of ["new", "validate", "format", "ls", "show", "add", "set", "remove", "move", "export", "import", "serve"]) {
    assert.match(skill, new RegExp(`design\\.mjs ${verb}\\b`), `SKILL.md does not show \`design.mjs ${verb}\``);
  }
});

test("the frontmatter carries a name and a description", () => {
  const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  assert.match(skill, /^---\n/, "SKILL.md must start with frontmatter");
  const front = skill.slice(4, skill.indexOf("\n---", 4));
  assert.match(front, /^name: skill-design$/m);
  assert.match(front, /^description: >-$/m);
  const description = front.slice(front.indexOf("description:"));
  assert.ok(description.length > 300, "the description is the trigger, so it must say when to use this");
});
