/**
 * The evals, held to what the code actually does.
 *
 * `evals/evals.json` describes twenty edits and what each one should produce. The
 * assertions in it are prose, and prose about behaviour is what rots: they said `margin`
 * was rejected (it is a legal member of the table), that `display:grid` gives
 * `style/bad-value` (it gives `style/bad-enum`), that a `<label data-type="text">` gives
 * `structure/unsupported-tag` (it gives `structure/type-tag-mismatch`), and that a dropped
 * property would appear "in a style/ diagnostic or in the normalized list" (it appears in
 * `dropped`, which is a third thing).
 *
 * `evals/grade.mjs` does not read `assertions` at all, so none of that failed anything.
 *
 * Two jobs, one funnel. The first is the receipt gate: each snippet runs through the same
 * funnel the CLI runs — parse, compile, apply, validate, diff the errors — and the result
 * is compared to the `expect` block stored beside it as an exact multiset. The second is
 * the prose: five checks compare what `assertions` and `expected_output` *say* to what the
 * funnel measured. They live in one file because both need the same funnel, and a second
 * copy of it would be the very thing this file exists to prevent.
 *
 * ## Why the comparison is exact
 *
 * A subset check ("every expected entry is present") passes while the receipt rots: a
 * compile that used to drop eleven declarations and now drops three still contains the
 * three. So the comparison is an exact multiset, and a failure names both directions —
 * `missing` and `extra`. The projection drops the wording (`message`, `hint`, `reason`)
 * and keeps the identity (`code@target`, `target|prop|value`, `target|prop|from|to`),
 * because the identity is the contract and the wording is not.
 *
 * ## The parent
 *
 * Every snippet is compiled into the same parent, `home__slot`, which every eval's
 * starter has. The prompt says where the model should put it; the parent decides only
 * where the `insert` lands, not which declarations are kept, dropped or refused, and
 * that second thing is what `expect` records.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../lib/parse.mjs";
import { compileFragment } from "../lib/fragment.mjs";
import { applyOps } from "../lib/ops.mjs";
import { serialize } from "../lib/serialize.mjs";
import { newErrors, validateDesign } from "../lib/validate.mjs";
import { CSS_ORDER, REJECTED_PROPERTIES } from "../lib/table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARENT = "home__slot";

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const evals = JSON.parse(read("evals/evals.json")).evals;
const starter = read("evals/starter.html");

/**
 * One eval, through the funnel, as the facts a receipt can be compared on.
 *
 * Three stages, because there are three outcomes and only two of them are "refused":
 *
 *   - `refused`  the fragment compiler refused. Nothing was compiled, so no declaration
 *                was kept, dropped or normalized. The refusal is the whole receipt.
 *   - `blocked`  the compiler produced ops and the write funnel refused them, because the
 *                file would gain an error (`a11y/missing-alt`, `structure/missing-attribute`).
 *                The compile still has a receipt — the drops and normalizations happened —
 *                and the file is untouched. This stage is why the old two-way split could
 *                not describe eleven of twenty evals.
 *   - `accepted` the ops applied and no new error appeared.
 *
 * The funnel is `add`'s: validate the file, compile the fragment, apply the ops,
 * validate again, and take the difference with `newErrors` — the same function the write
 * funnel uses to decide whether to refuse, so "blocked" here means what it means there.
 */
function runEval(entry) {
  const before = parse(starter);
  const fragment = read(entry.files[0]);
  const compiled = compileFragment(before, fragment, { in: PARENT });

  const dropped = compiled.dropped.map((d) => ({ target: d.target ?? null, prop: d.prop, value: d.value ?? null }));
  const normalized = compiled.normalized.map((d) => ({ target: d.target ?? null, prop: d.prop, from: d.from ?? null, to: d.to ?? null }));
  const codes = (list) => list.filter((d) => d.severity === "error").map((d) => ({ code: d.code, target: d.target ?? null }));

  if (compiled.refused) {
    return { stage: "refused", refused: compiled.refused.code, codes: codes(compiled.diagnostics), dropped: [], normalized: [] };
  }

  const { doc: next } = applyOps(before, compiled.ops);
  const introduced = newErrors(validateDesign(before), validateDesign(next));
  if (introduced.length > 0) {
    return { stage: "blocked", refused: "cli/would-introduce-errors", codes: codes(introduced), dropped, normalized };
  }

  return {
    stage: "accepted",
    refused: null,
    codes: codes(compiled.diagnostics),
    dropped,
    normalized,
    // A property no receipt can express: the bytes the funnel would write have to be a
    // fixed point of the serializer. A file that changes again on the next read is one
    // `format` would rewrite, and `format --check` would call it not canonical.
    roundTrip: (() => {
      const written = serialize(before, next);
      const reread = parse(written);
      return serialize(reread, reread) === written;
    })(),
  };
}

/** The identity of an entry, with the wording dropped. */
const key = {
  code: (entry) => `${entry.code}@${entry.target ?? "-"}`,
  dropped: (entry) => `${entry.target ?? "-"}|${entry.prop}|${entry.value ?? ""}`,
  normalized: (entry) => `${entry.target ?? "-"}|${entry.prop}|${entry.from ?? ""}|${entry.to ?? ""}`,
};

/** Compare a projected list as a multiset, and say which entries are missing and extra. */
function sameMultiset(actual, expected, project, label) {
  const count = (list) => {
    const map = new Map();
    for (const entry of list) {
      const k = project(entry);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  };
  const left = count(actual);
  const right = count(expected);
  const missing = [];
  const extra = [];
  for (const [k, n] of right) {
    const have = left.get(k) ?? 0;
    for (let i = have; i < n; i += 1) missing.push(k);
  }
  for (const [k, n] of left) {
    const want = right.get(k) ?? 0;
    for (let i = want; i < n; i += 1) extra.push(k);
  }
  assert.deepEqual(
    { missing: missing.sort(), extra: extra.sort() },
    { missing: [], extra: [] },
    `${label}: the receipt and the expectation are not the same multiset`,
  );
}

/**
 * Regenerate the `expect` blocks.
 *
 *     SD_EVAL_DUMP=1 node --test test/evals.test.mjs
 *
 * The measured facts are printed as JSON, one line per eval, and pasting them back into
 * `evals/evals.json` is the only supported way to change an expectation. Hand-editing one
 * is how the prose got here: an expectation written from memory is a claim about the
 * code, and this file exists because those claims were wrong.
 */
const DUMP = process.env.SD_EVAL_DUMP === "1";

function dump(entry, actual) {
  const { roundTrip, ...rest } = actual;
  const block = {
    stage: rest.stage,
    ...(rest.stage === "accepted" ? {} : { refused: rest.refused }),
    codes: rest.codes,
    dropped: rest.dropped,
    normalized: rest.normalized,
  };
  return JSON.stringify({ id: entry.id, name: entry.name, expect: block });
}

test("every eval has an expect block, and every snippet it names exists", () => {
  for (const entry of evals) {
    if (DUMP) {
      process.stdout.write(dump(entry, runEval(entry)) + "\n");
      continue;
    }
    assert.ok(entry.expect, `eval ${entry.id} (${entry.name}) has no expect block`);
    assert.ok(Array.isArray(entry.files) && entry.files.length > 0, `eval ${entry.id} names no snippet`);
    for (const file of entry.files) read(file);
  }
});

for (const entry of evals) {
  test(`eval ${entry.id} ${entry.name}: the receipt is what evals.json says it is`, () => {
    if (DUMP) return;
    const expect = entry.expect;
    const actual = runEval(entry);

    assert.equal(actual.stage, expect.stage, `eval ${entry.id}: expected the ${expect.stage} stage`);
    if (expect.stage !== "accepted") {
      assert.equal(actual.refused, expect.refused, `eval ${entry.id}: refused by a different code`);
    }

    sameMultiset(actual.codes, expect.codes ?? [], key.code, `eval ${entry.id} codes`);
    sameMultiset(actual.dropped, expect.dropped ?? [], key.dropped, `eval ${entry.id} dropped`);
    sameMultiset(actual.normalized, expect.normalized ?? [], key.normalized, `eval ${entry.id} normalized`);

    if (expect.stage === "accepted") {
      assert.equal(actual.roundTrip, true, `eval ${entry.id}: the written file does not re-serialize to itself`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * The prose beside the expectations
 * ------------------------------------------------------------------ */

/**
 * `assertions` and `expected_output` are read by whoever grades a run, and by whoever
 * reads the eval to understand the format. `grade.mjs` never touches them, so nothing
 * noticed when they described an implementation that does not exist. These four checks
 * compare the words to the measured receipt.
 *
 * What they do not do is grade style. A vague sentence is allowed; a false one is not.
 */

/** Every code `lib/` can emit: a quoted literal where a code goes. */
function emittableCodes() {
  const out = new Set();
  for (const file of filesUnderRoot("lib", /\.mjs$/)) {
    for (const match of read(file).matchAll(/["']([a-z0-9]+\/[a-z0-9-]+)["']/g)) out.add(match[1]);
  }
  return out;
}

function filesUnderRoot(target, extensions) {
  const out = [];
  const walk = (relative) => {
    const full = join(ROOT, relative);
    for (const entry of readdirSync(full)) {
      const child = join(relative, entry);
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (extensions.test(child)) out.push(child);
    }
  };
  walk(target);
  return out;
}

/** The property names the format knows, so a backticked word can be recognised as one. */
const KNOWN_PROPERTIES = new Set([...CSS_ORDER, ...Object.keys(REJECTED_PROPERTIES)]);

/** Every CSS property named in backticks, written `prop` or `prop:value`. */
function propertiesNamed(text) {
  const out = new Set();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const name = match[1].split(":")[0].trim();
    if (KNOWN_PROPERTIES.has(name)) out.add(name);
  }
  return out;
}

/**
 * The clauses of a description.
 *
 * Split on `;` and `—` and on a period that ends a sentence, but not on the period in
 * `rgba(0,0,0,.06)`. A clause is the unit a claim lives in: "`margin` is a member of
 * CSS_ALLOWED; only the one-sided longhands are refused" makes two claims, and only the
 * second one is about a refusal.
 */
function clausesOf(text) {
  return text
    .split(/;|—|\n|(?<=[a-z)`])\.(?=\s|$)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
}

const NEGATION = /\b(no|not|nothing|neither|never|without|absent|zero)\b/;
const OUTCOME_VERBS = /\b(dropped|normalized|accounted for|recorded)\b/;
const REJECTION = /\b(rejected|refused|refuses|dropped|not in CSS_ALLOWED|must appear)\b/;

function textOf(entry) {
  return [...(entry.assertions ?? []).map((a) => a.text), entry.expected_output ?? ""].join("\n");
}

test("every diagnostic code named in evals.json is one the code can emit", () => {
  const emittable = emittableCodes();
  const unknown = [];
  for (const entry of evals) {
    for (const match of textOf(entry).matchAll(/([a-z0-9]+\/[a-z][a-z0-9-]+)/g)) {
      const code = match[1];
      if (!/^(syntax|style|structure|a11y|asset|component|version|ops)\//.test(code)) continue;
      if (!emittable.has(code)) unknown.push(`eval ${entry.id} names ${code}, which no module in lib/ emits`);
    }
  }
  assert.deepEqual([...new Set(unknown)], []);
});

test("a code an eval claims as a result is the code that fires", () => {
  const wrong = [];
  for (const entry of evals) {
    const actual = new Set([...runEval(entry).codes.map((c) => c.code), runEval(entry).refused].filter(Boolean));
    for (const clause of clausesOf(textOf(entry))) {
      for (const match of clause.matchAll(/([a-z0-9]+\/[a-z][a-z0-9-]+)/g)) {
        const code = match[1];
        if (!/^(syntax|style|structure|a11y|asset|component|version|ops)\//.test(code)) continue;
        // A clause that says the code does not appear is a claim about absence.
        if (NEGATION.test(clause.slice(0, match.index))) continue;
        if (!actual.has(code)) {
          wrong.push(`eval ${entry.id} expects ${code}, and the receipt has ${[...actual].join(", ") || "nothing"}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(wrong)], []);
});

test("a refused fragment is not described as if it had been compiled", () => {
  const wrong = [];
  for (const entry of evals) {
    if (runEval(entry).stage !== "refused") continue;
    for (const clause of clausesOf(textOf(entry))) {
      // "the trailing `;` is dropped" and "the style attribute does not end with `;`" are
      // claims about bytes the funnel would have written. A refused compile writes nothing.
      if (!OUTCOME_VERBS.test(clause) && !/does not end with `;`|contains no `;;`/.test(clause)) continue;
      const at = clause.search(OUTCOME_VERBS) === -1 ? 0 : clause.search(OUTCOME_VERBS);
      const before = clause.slice(0, at);
      if (NEGATION.test(before)) continue;
      wrong.push(`eval ${entry.id} claims "${clause.slice(0, 90)}", and the compiler refused before compiling anything`);
    }
  }
  assert.deepEqual([...new Set(wrong)], []);
});

test("a property the receipt drops is named in the eval's own words", () => {
  const silent = [];
  for (const entry of evals) {
    const text = textOf(entry);
    const actual = runEval(entry);
    for (const prop of new Set(actual.dropped.map((d) => d.prop))) {
      if (!propertiesNamed(text).has(prop)) {
        silent.push(`eval ${entry.id} drops ${prop}, and its text never names it`);
      }
    }
  }
  assert.deepEqual([...new Set(silent)], []);
});

test("a property the prose calls refused is one the receipt drops", () => {
  const wrong = [];
  for (const entry of evals) {
    const text = textOf(entry);
    const actual = runEval(entry);
    // A fragment the compiler refused has no drop list at all: nothing was compiled, and
    // the third check already governs what may be said about it. Comparing its prose to an
    // empty list would flag the property that *caused* the refusal, which is a true claim.
    if (actual.stage === "refused") continue;
    const dropped = new Set(actual.dropped.map((d) => d.prop));
    for (const clause of clausesOf(text)) {
      if (!REJECTION.test(clause)) continue;
      // "kept or reported, not dropped" is a claim about absence, and it is the wording
      // this check exists to encourage.
      if (/\b(not|never|no)\b[^.;]{0,30}\b(dropped|rejected|refused)\b/.test(clause)) continue;
      for (const prop of propertiesNamed(clause)) {
        if (dropped.has(prop)) continue;
        // `margin:0 is rejected` is the defect this catches: margin is in the table and the
        // file keeps it. Only the one-sided longhands are ever refused.
        wrong.push(`eval ${entry.id} says ${prop} is refused/dropped, and the receipt keeps it`);
      }
    }
  }
  assert.deepEqual([...new Set(wrong)], []);
});
