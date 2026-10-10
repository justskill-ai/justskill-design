/**
 * The documents a model reads must not contradict the code.
 *
 * `SKILL.md` is the body the model reads on every trigger, so a wrong sentence
 * in it is worse than a missing feature: it teaches the model to avoid something
 * the format allows, or to write something it will refuse.
 *
 * The margin story is the one that happened. `margin` is a member of the format
 * table — it takes the four-value shorthand, and only the one-sided spellings are
 * refused — but `SKILL.md` said "Do not write `margin` … the single most common
 * refusal", showed a receipt dropping it, and listed it in the refusal table. A
 * file that declared `margin:16px` was accepted with no receipt entry at all, so
 * every one of those three statements was false.
 *
 * These are not tests of taste. Each one fails on a sentence that is provably
 * untrue of `lib/table.mjs` today.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CSS_ORDER } from "../lib/table.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (name) => readFileSync(join(ROOT, name), "utf8");

/** Every document that is written by hand. `references/` is generated. */
const HAND_WRITTEN = ["SKILL.md", "README.md", "docs/format-v3.md"];

test("no hand-written document says margin itself is refused", () => {
  for (const name of HAND_WRITTEN) {
    const text = read(name);
    assert.doesNotMatch(
      text,
      /Do not write `margin`/,
      `${name} tells the model to avoid a property the table accepts`,
    );
    assert.doesNotMatch(
      text,
      /margin\s*:\s*null/,
      `${name} still describes the removed \`margin: null\` alias rule`,
    );
  }
});

test("no receipt example drops a margin declaration", () => {
  // `margin` is a property now, so a receipt can never carry this line. An
  // example that shows it teaches the model to expect a refusal that will not
  // come, and to rewrite a declaration that was already fine.
  for (const name of ["SKILL.md", "README.md"]) {
    assert.doesNotMatch(
      read(name),
      /^dropped:\s+margin:/m,
      `${name} shows a receipt dropping margin, which the compiler cannot produce`,
    );
  }
});

test("a hand-written document states the property count the table has", () => {
  // The generated `references/styling.md` derives its count. A hand-written one
  // has to be checked, or it goes stale the moment a property is added — which
  // is exactly what happened at 40, twice, while the table had 45.
  const count = CSS_ORDER.length;
  const STATEMENT = /(\d+)(?:\s+[\w-]+){0,2}\s+properties|(\d+)\s*个属性/g;

  for (const name of HAND_WRITTEN) {
    const text = read(name);
    for (const match of text.matchAll(STATEMENT)) {
      const stated = Number(match[1] ?? match[2]);
      assert.equal(
        stated,
        count,
        `${name} says ${stated} properties, the table has ${count} — in ${JSON.stringify(match[0])}`,
      );
    }
  }
});

test("the count check would notice a wrong number", () => {
  // A guard on the guard: if the pattern stopped matching, the test above would
  // pass vacuously on any document.
  const STATEMENT = /(\d+)(?:\s+[\w-]+){0,2}\s+properties|(\d+)\s*个属性/g;
  assert.ok([..."the 40 allowed properties".matchAll(STATEMENT)].length > 0);
  assert.ok([..."// 40 个属性，按输出顺序".matchAll(STATEMENT)].length > 0);
  assert.ok([..."a fixed set of 45 CSS\nproperties".matchAll(STATEMENT)].length > 0);
});
