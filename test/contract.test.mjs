/**
 * The contract, checked against the code.
 *
 * `docs/format-v3.md` is the interface. `SKILL.md` is what a model reads. Both are
 * prose, and prose rots: the document keeps promising a file that was deleted, a verb
 * that was renamed, a prefix nothing emits. Every defect this suite was written to catch
 * was of that shape — `a11y/` and `asset/` sat in the table emitting nothing, §7 named
 * two exports that did not exist and left two consumer modules out, `references/`
 * documented a `viewBox` rule the table could not express. None of them failed a test,
 * because nothing compared the documents to the code.
 *
 * So these four checks derive their facts from the source — `VERBS` from `design.mjs`,
 * the exports from `lib/table.mjs`, the prefixes from the §6 table — and never from a
 * second hand-written list. A copy of the truth is a second truth, and it is the copy
 * that rots.
 *
 * ## No red list
 *
 * Every check here passes unaided, and nothing in this file is allowed to fail on
 * purpose. There was a `PENDING` map while the contract still disagreed with the code —
 * one entry, for a `lib/geometry.mjs` that `format-v3.md` §6 named while telling the reader
 * it was never written. It was compared for equality rather than used as a filter, so a new
 * failure could not hide behind it and a fixed one could not linger, and it is gone now
 * that the entry is fixed. An empty map would have been a place to put the next one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { VERBS } from "../design.mjs";
import * as table from "../lib/table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Nothing is pending. Every check in this file passes on its own.
 *
 * There was a `PENDING` map here while the contract still disagreed with the code, holding
 * exactly what was expected to fail: `docs/format-v3.md` §6 named a `lib/geometry.mjs` that
 * was never written. A guard that is allowed to fail is a guard nobody reads, so the map
 * was compared for equality (a new failure was not absorbed, a fixed one did not linger)
 * and `SD_CONTRACT_STRICT=1` turned every entry into a failure. The last entry is gone, and
 * with it the map — leaving it behind, even empty, would have left a place to put one.
 */

/** Where a command name may appear. `test/` and `evals/` talk about verbs, not to them. */
const DOC_ROOTS = ["SKILL.md", "README.md", "docs", "references", "examples", "lib", "canvas", "scripts"];

function filesUnder(target, extensions = /\.(md|mjs|html|json)$/) {
  const full = join(ROOT, target);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [relative(ROOT, full)];
  const out = [];
  for (const entry of readdirSync(full)) {
    const child = join(full, entry);
    if (statSync(child).isDirectory()) out.push(...filesUnder(join(target, entry), extensions));
    else if (extensions.test(child)) out.push(relative(ROOT, child));
  }
  return out;
}

const read = (target) => readFileSync(join(ROOT, target), "utf8");

/** The part of `format-v3.md` between two `## n.` headings. */
function contractSection(heading, next) {
  const text = read("docs/format-v3.md");
  const start = text.indexOf(heading);
  assert.ok(start !== -1, `docs/format-v3.md has no ${heading}`);
  const end = text.indexOf(next, start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * Report what fails, comparing against the pending list for this check.
 *
 * Equality in both directions on purpose. A subset check would let a new failure in
 * unnoticed, which is how a guard becomes decoration; a superset check would leave a
 * line behind after the work is done, which is how a guard becomes an exemption.
 */
function report(check, failures) {
  const sorted = [...new Set(failures)].sort();
  assert.deepEqual(sorted, [], `${check}:\n  ${sorted.join("\n  ")}`);
}

/* ------------------------------------------------------------------ *
 * 1. No document names a verb the CLI does not have
 * ------------------------------------------------------------------ */

/**
 * The shapes a command name takes in these documents.
 *
 * Every one of them was found in the tree, and a check that knows only the first would
 * miss most of the references: `SKILL.md` writes `Use \`rename\`` with no prefix at all,
 * and the README writes `` `design validate` ``. `<verb>` and `<tok>` placeholders are
 * not names, which is why the character class starts at a letter and stops at the first
 * non-name character.
 */
const COMMAND_SHAPES = [
  /design\.mjs ([a-z][a-z-]*)/g,
  /`design ([a-z][a-z-]*)`/g,
  /(?:Use|Run|Call) `([a-z][a-z-]*)`/g,
];

test("no document names a verb the CLI does not have", () => {
  const known = new Set(Object.keys(VERBS));
  const failures = [];
  for (const file of DOC_ROOTS.flatMap((root) => filesUnder(root))) {
    const text = read(file);
    for (const shape of COMMAND_SHAPES) {
      shape.lastIndex = 0;
      let match;
      while ((match = shape.exec(text)) !== null) {
        if (!known.has(match[1])) failures.push(`${file} names \`${match[1]}\`, which is not a verb`);
      }
    }
  }
  report('no document names a verb the CLI does not have', failures);
});

/* ------------------------------------------------------------------ *
 * 2. Every verb is a module, a usage, and a line in SKILL.md
 * ------------------------------------------------------------------ */

test("every verb has a module exporting USAGE, and SKILL.md shows it", async () => {
  const skill = read("SKILL.md");
  const failures = [];
  for (const verb of Object.keys(VERBS)) {
    const file = `lib/node/verbs/${verb}.mjs`;
    if (!existsSync(join(ROOT, file))) {
      failures.push(`${verb} has no ${file}`);
    } else {
      const module = await import(new URL(`../${file}`, import.meta.url));
      if (typeof module.USAGE !== "string" || module.USAGE === "") failures.push(`${file} exports no USAGE`);
      if (typeof (module.default ?? module.run) !== "function") failures.push(`${file} runs nothing`);
    }
    if (!new RegExp(`design\\.mjs ${verb}\\b`).test(skill)) {
      failures.push(`SKILL.md never shows \`design.mjs ${verb}\``);
    }
  }
  report("every verb has a module exporting USAGE, and SKILL.md shows it", failures);
});

test("every verb is dispatched lazily, so --help works before the module loads", () => {
  const source = read("design.mjs");
  for (const verb of Object.keys(VERBS)) {
    assert.match(
      source,
      new RegExp(`${verb}: \\(\\) => import\\("\\./lib/node/verbs/${verb}\\.mjs"\\)`),
      `${verb} is not dispatched through a lazy import`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 3. What the contract names exists
 * ------------------------------------------------------------------ */

test("every lib path the contract names exists", () => {
  const failures = [];
  for (const match of read("docs/format-v3.md").matchAll(/`([^`]*lib\/[^`]*)`/g)) {
    const named = match[1].trim().replace(/\s.*$/, "");
    if (!named.endsWith(".mjs")) continue;
    // A glob or a directory is a shape, not a promise about one file.
    if (named.includes("*") || named.includes("…") || named.endsWith("/")) continue;
    if (!existsSync(join(ROOT, named))) failures.push(`§6/§9 names a module that was never written: ${named}`);
  }
  report('every lib path the contract names exists', failures);
});

test("every export §7 shows is exported by the table", () => {
  const section = contractSection("## 7.", "## 8.");
  const named = [...section.matchAll(/export const (\w+)/g)].map((match) => match[1]);
  assert.ok(named.length >= 8, `§7 shows only ${named.length} exports; the code block moved?`);
  for (const name of named) {
    assert.ok(name in table, `§7 shows \`export const ${name}\`, which lib/table.mjs does not export`);
  }
});

/**
 * §7 ends with "and these are the modules that import it, no others".
 *
 * That sentence is the reason `lib/ops.mjs` is allowed to be absent from the list while
 * importing the table's *names* by hand, and it is the first thing to go stale when a
 * new module reads the table. Measured against the import statements, not against a
 * second list.
 */
test("§7's consumer list is the real set of modules that import the table", () => {
  // The list is the paragraph after the sentence that introduces it. Reading every module
  // path in §7 would count the paragraph explaining why `lib/ops.mjs` is *not* on the
  // list, and a sentence about the list is not the list.
  const paragraphs = contractSection("## 7.", "## 8.").split(/\n\s*\n/);
  const intro = paragraphs.findIndex((entry) => entry.includes("一个不多"));
  assert.ok(intro !== -1, "§7 no longer introduces a consumer list; fix this check or the document");
  const list = paragraphs[intro + 1] ?? "";
  const listed = new Set(
    [...list.matchAll(/`((?:lib|scripts|canvas)\/[\w/.-]+\.mjs)`/g)]
      .map((match) => match[1])
      .filter((name) => name !== "lib/table.mjs"),
  );
  assert.ok(listed.size >= 8, `§7's list has only ${listed.size} modules; the paragraph moved?`);
  const importers = new Set();
  for (const file of ["lib", "scripts", "canvas"].flatMap((root) => filesUnder(root, /\.mjs$/))) {
    if (/from "[^"]*table\.mjs"/.test(read(file))) importers.add(file);
  }
  assert.deepEqual(
    [...importers].sort(),
    [...listed].sort(),
    "§7's consumer list and the modules that import lib/table.mjs are not the same set",
  );
});

/* ------------------------------------------------------------------ *
 * 4. Every diagnostic prefix in §6 is one the code can emit
 * ------------------------------------------------------------------ */

/**
 * Only the §6 table counts.
 *
 * The prose below it names `geometry/` while saying it was never implemented — reading
 * the whole section would call that prefix "covered" because a sentence mentions it.
 * And a prefix counts only as a quoted string literal, because that is what a code looks
 * like (`error("style/token-cycle", …)`); a backticked mention in a comment is prose
 * about the prefix, not an emission of it.
 */
test("every diagnostic prefix in §6 has a code literal in lib/", () => {
  const section = contractSection("## 6.", "## 7.");
  const prefixes = [...section.matchAll(/^\|\s*`([a-z0-9]+)\/`\s*\|/gm)].map((match) => match[1]);
  assert.ok(prefixes.length >= 8, `§6's table lists only ${prefixes.length} prefixes; the table moved?`);

  const sources = filesUnder("lib", /\.mjs$/).map((file) => ({ file, text: read(file) }));
  const failures = [];
  for (const prefix of prefixes) {
    // `a11y` carries a digit, so the class cannot be `[a-z]`.
    const literal = new RegExp(`["']${prefix}/`);
    const emitters = sources.filter((source) => literal.test(source.text)).map((source) => source.file);
    if (emitters.length === 0) failures.push(`§6 lists ${prefix}/, and no module in lib/ emits one`);
  }
  report("every diagnostic prefix in §6 has a code literal in lib/", failures);
});
