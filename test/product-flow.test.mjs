/**
 * The idea-to-product route is two documents and one canvas behaviour.
 *
 * `SKILL.md` carries the nine-row route table — the version the model reads on
 * every trigger. `references/product-flow.md` expands it stage by stage. The
 * canvas supplies the one handshake the route cannot work without: ⌘C on a
 * selected element copies a pointer, and the user pastes that pointer back.
 *
 * Each of those can drift alone. A stage can be renamed in one document and not
 * the other; the copy prefix can change in `canvas/app.mjs` while the playbook
 * still quotes the old sentence; the playbook can grow into a second skill body.
 * None of that fails a build, because no test compared the files.
 *
 * So nothing here hard-copies the facts it guards. The stage names are parsed
 * out of both documents and compared, the handshake is read from the canvas and
 * looked for in the playbook, and the description is unfolded the way the
 * loader unfolds it before its trigger phrases are looked for. The one number
 * that is stated (nine stages) is the contract the table is built on: a change
 * to it should be a deliberate edit to this file, not a silent addition in one
 * document.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const SKILL_FILE = "SKILL.md";
const PLAYBOOK_FILE = "references/product-flow.md";
const CANVAS_FILE = "canvas/app.mjs";

/** The route the Lead's table states: nine stages, and both documents must agree. */
const STAGE_COUNT = 9;

/** The frontmatter description is the trigger, and a loader truncates it here. */
const DESCRIPTION_LIMIT = 1024;

/** A playbook expands the route; past this it is a second skill body. */
const PLAYBOOK_LINE_LIMIT = 450;

/** The two literals the canvas clipboard prompt cannot lose. */
const HANDSHAKE = ["Use justSkill tools. Current file", "Selected node ids:"];

const read = (name) => readFileSync(join(ROOT, name), "utf8");

/** The YAML frontmatter body, or a failure naming the file. */
function frontmatterOf(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, `${SKILL_FILE} must open with a "---" frontmatter block`);
  return match[1];
}

/**
 * The description as the loader hands it to the model.
 *
 * It is written as a folded scalar (`>-`), so a line break in the source is a
 * space in the value. The limit and the trigger phrases are about that value,
 * not about the indented source lines.
 */
function descriptionOf(text) {
  const lines = frontmatterOf(text).split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith("description:"));
  assert.notEqual(at, -1, `${SKILL_FILE} frontmatter has no "description:" key, so the skill has no trigger sentence`);
  const header = lines[at].slice("description:".length).trim();
  assert.equal(
    header,
    ">-",
    `${SKILL_FILE} writes "description: ${header}"; the description is folded prose and must stay a ">-" block`,
  );

  const body = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z][\w-]*:/.test(lines[i])) break; // the next top-level key
    body.push(lines[i].trim());
  }
  const description = body.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  assert.ok(description.length > 0, `${SKILL_FILE}'s "description:" block is empty`);
  return description;
}

/** The route section, from its heading to the "## The one rule" that closes it. */
function routeSectionOf(text) {
  const start = text.indexOf("## From an idea to a product");
  assert.notEqual(start, -1, `${SKILL_FILE} has no "## From an idea to a product" section to route a product request through`);
  const end = text.indexOf("## The one rule", start);
  assert.notEqual(
    end,
    -1,
    `${SKILL_FILE} no longer closes the route section with "## The one rule", so the route table cannot be sliced out and compared`,
  );
  return text.slice(start, end);
}

/** The `[number, name]` rows of a table whose first two columns are `# | Stage`. */
function stageRowsIn(text) {
  // Markdown emphasis in a cell is presentation, not part of the name: the READMEs
  // bold the stages the skill owns (4-8) so the scope reads at a glance, while
  // SKILL.md keeps plain text. Strip the markers before the names are compared.
  return [...text.matchAll(/^\| \*{0,2}(\d+)\*{0,2} \| ([^|]+?) \|/gm)].map((match) => ({
    number: Number(match[1]),
    name: match[2].replace(/\*\*/g, "").trim(),
  }));
}

/** The part of a file between one `## ` heading and the next one given. */
function sectionOf(file, heading, nextHeading) {
  const text = read(file);
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `${file} has no ${JSON.stringify(heading)} section`);
  const end = text.indexOf(nextHeading, start + heading.length);
  assert.notEqual(end, -1, `${file}'s ${JSON.stringify(heading)} section no longer ends before ${JSON.stringify(nextHeading)}`);
  return text.slice(start, end);
}

test("the description triggers on product ideas and on features to add or change", () => {
  const description = descriptionOf(read(SKILL_FILE));
  const triggers = [
    [/product idea/i, "a product idea"],
    [/(?:feature[^.]{0,80}(?:add|change|remove)|(?:add|change|remove)[^.]{0,80}feature)/i, "a feature to add or change"],
  ];
  for (const [pattern, phrase] of triggers) {
    assert.match(
      description,
      pattern,
      `${SKILL_FILE}'s description does not mention ${phrase}; the description is the trigger, so that request would not load the route. Description: ${JSON.stringify(
        description.slice(0, 120),
      )}…`,
    );
  }
});

test("the description stays inside the 1024-character trigger budget", () => {
  const description = descriptionOf(read(SKILL_FILE));
  assert.ok(
    description.length <= DESCRIPTION_LIMIT,
    `${SKILL_FILE}'s description is ${description.length} characters; the trigger budget is ${DESCRIPTION_LIMIT}. Cut a sentence instead of letting the trigger be truncated`,
  );
});

test("SKILL.md routes a product request to references/product-flow.md, and the file is there", () => {
  const skill = read(SKILL_FILE);
  routeSectionOf(skill); // fails, naming the sentence, if the heading that opens it moved
  assert.ok(
    skill.includes(PLAYBOOK_FILE),
    `${SKILL_FILE} has the route section but no sentence sending the model to ${PLAYBOOK_FILE}`,
  );
  assert.ok(
    existsSync(join(ROOT, PLAYBOOK_FILE)),
    `${SKILL_FILE} points at ${PLAYBOOK_FILE} but the file does not exist`,
  );
});

test("the route table and the playbook name the same nine stages in the same order", () => {
  const rows = [...routeSectionOf(read(SKILL_FILE)).matchAll(/^\| (\d+) \| ([^|]+?) \|/gm)];
  const headings = [...read(PLAYBOOK_FILE).matchAll(/^## Stage (\d+) — (.+)$/gm)];

  assert.equal(
    rows.length,
    STAGE_COUNT,
    `${SKILL_FILE}'s "## From an idea to a product" table must list ${STAGE_COUNT} stages; found ${rows.length} rows before "## The one rule"`,
  );
  assert.equal(
    headings.length,
    STAGE_COUNT,
    `${PLAYBOOK_FILE} must have ${STAGE_COUNT} "## Stage N — Name" headings; found ${headings.length}`,
  );

  for (let i = 0; i < STAGE_COUNT; i += 1) {
    const [, rowNumber, rowName] = rows[i];
    const [, headingNumber, headingName] = headings[i];
    assert.equal(
      headingName.trim(),
      rowName.trim(),
      `stage ${i + 1} has two names: ${SKILL_FILE}'s route table says "${rowName.trim()}" (row ${rowNumber}) while ${PLAYBOOK_FILE} says "## Stage ${headingNumber} — ${headingName.trim()}". Change both files or neither`,
    );
  }
});

test("the paradigm essay carries the route the always-read table does", () => {
  // The route lives in two places a person reads: the always-read table in
  // SKILL.md and the essay in docs/paradigm.md. The READMEs are product pages and
  // link to the essay rather than restating the table, so the essay is the copy
  // that can drift — and it is compared here, stage name by stage name.
  const skillStages = stageRowsIn(routeSectionOf(read(SKILL_FILE)));
  const essay = stageRowsIn(
    sectionOf("docs/paradigm.md", "## In practice: the loop", "## What this costs"),
  );
  assert.equal(
    essay.length,
    STAGE_COUNT,
    `docs/paradigm.md's route table must list ${STAGE_COUNT} stages; found ${essay.length}`,
  );
  for (let i = 0; i < STAGE_COUNT; i += 1) {
    assert.equal(essay[i].number, i + 1, `docs/paradigm.md's route table row ${i + 1} is numbered ${essay[i].number}`);
    assert.equal(
      essay[i].name,
      skillStages[i].name,
      `docs/paradigm.md's stage ${i + 1} is "${essay[i].name}" while ${SKILL_FILE} says "${skillStages[i].name}"`,
    );
  }

  // If the essay moved or was unlinked, the user-facing route would be gone while
  // every other check still passed.
  for (const name of ["README.md", "README.en.md"]) {
    assert.match(
      read(name),
      /docs\/paradigm\.md/,
      `${name} does not link to docs/paradigm.md, so the route is unreachable from the product page`,
    );
  }
});

test("the playbook quotes the copy handshake canvas/app.mjs actually emits", () => {
  const canvas = read(CANVAS_FILE);
  const playbook = read(PLAYBOOK_FILE);

  for (const literal of HANDSHAKE) {
    assert.ok(
      canvas.includes(literal),
      `${CANVAS_FILE} no longer emits ${JSON.stringify(literal)}; the copy prompt changed, so every instruction that quotes it is now wrong`,
    );
    assert.ok(
      playbook.includes(literal),
      `${PLAYBOOK_FILE} does not quote ${JSON.stringify(literal)}, which ${CANVAS_FILE} emits — the user would paste a sentence the playbook does not describe`,
    );
  }

  assert.match(
    canvas,
    /\btoast\(\s*[`"']Copied/,
    `${CANVAS_FILE} copies the pointer but no longer confirms it to the user with a "Copied …" toast`,
  );

  // The inspector must name the shortcut in both states: nothing selected
  // (where the user has not heard of it) and something selected (where copying
  // is the next action). One hint only means half the loop is undiscoverable.
  const hints = [...canvas.matchAll(/copy a pointer to (?:it|this element) for the agent/g)];
  assert.equal(
    hints.length,
    2,
    `${CANVAS_FILE} must show the ⌘C shortcut in both inspector states; found ${hints.length}`,
  );
});

test("the playbook stays a playbook, not a second SKILL.md", () => {
  const lines = read(PLAYBOOK_FILE).split("\n").length;
  assert.ok(
    lines < PLAYBOOK_LINE_LIMIT,
    `${PLAYBOOK_FILE} is ${lines} lines; it expands the route a stage at a time and must stay under ${PLAYBOOK_LINE_LIMIT}, with the route itself in ${SKILL_FILE}`,
  );
});
