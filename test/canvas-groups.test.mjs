/**
 * test/canvas-groups.test.mjs — the inspector's sections against the format.
 *
 * The inspector is a view of `CSS_ALLOWED`, and the failure mode that matters is
 * silent: a property the format allows, that no section draws and no fallback
 * catches, is a property a person has to edit by hand without ever being told
 * why. So the first test is a comparison, not a list:
 *
 *   1. every allowed property has a home — a named section, or `Other`
 *   2. `Other` stays empty for the current format (it is a safety net, not a
 *      dumping ground), and unknown names do land in it
 *   3. rows pair up only when both halves are present
 *   4. the control follows the declared grammar, not the spelling of a value
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CSS_ALLOWED, CSS_ORDER } from "../lib/table.mjs";
import {
  GROUPS, OTHER, PAIRS, groupedFields, controlFor, valuesFor, hintFor, scrubFor, isNumericValue,
} from "../canvas/groups.mjs";

const ALLOWED = Object.keys(CSS_ALLOWED);

test("every property the format allows is drawn by a named section", () => {
  const missing = ALLOWED.filter((property) => {
    const sections = groupedFields([property]);
    return sections.length === 0 || sections[0].id === OTHER.id;
  });
  assert.deepEqual(missing, [], `no section draws: ${missing.join(", ")}`);
});

test("no section claims a property the format does not allow", () => {
  const claimed = GROUPS.flatMap((group) => group.members);
  const unknown = claimed.filter((property) => !ALLOWED.includes(property));
  assert.deepEqual(unknown, [], `sections name properties that do not exist: ${unknown.join(", ")}`);
});

test("no property is claimed twice", () => {
  const claimed = GROUPS.flatMap((group) => group.members);
  const seen = new Set();
  const twice = claimed.filter((property) => (seen.has(property) ? true : (seen.add(property), false)));
  assert.deepEqual(twice, [], `claimed by two sections: ${twice.join(", ")}`);
});

test("a property the groups do not know falls into Other, last", () => {
  const sections = groupedFields(["width", "future-property"]);
  assert.deepEqual(sections.map((section) => section.id), ["size", OTHER.id]);
  assert.deepEqual(sections[1].rows, [["future-property"]]);
});

test("Other sorts what it catches by the format's order", () => {
  // Neither name is in the format, so the fallback has to fall back: sorted by
  // name, which is at least stable between renders.
  const sections = groupedFields(["zzz", "aaa"]);
  assert.deepEqual(sections[0].rows, [["aaa"], ["zzz"]]);
});

test("sections are drawn in their declared order, and only when they have rows", () => {
  const sections = groupedFields(["color", "display", "width"]);
  assert.deepEqual(sections.map((section) => section.id), ["layout", "size", "text"]);
  assert.deepEqual(sections.map((section) => section.rows), [[["display"]], [["width"]], [["color"]]]);
});

test("two properties of a pair share a row only when both are present", () => {
  assert.deepEqual(groupedFields(["width", "height", "padding"])[0].rows, [["width", "height"]]);
  assert.deepEqual(groupedFields(["width", "padding"])[0].rows, [["width"]]);
  assert.deepEqual(
    groupedFields(["min-width", "min-height", "max-width"])[0].rows,
    [["min-width", "min-height"], ["max-width"]],
    "an unpaired max-width is a row of its own",
  );
});

test("every declared pair is a pair of properties the format allows", () => {
  for (const pair of PAIRS) {
    for (const property of pair) {
      assert.ok(ALLOWED.includes(property), `${property} is in PAIRS but not in CSS_ALLOWED`);
    }
  }
});

test("the control follows the declared grammar", () => {
  assert.equal(controlFor("display"), "segmented", "three values or fewer are buttons");
  assert.equal(controlFor("align-items"), "select", "five values are a dropdown");
  assert.equal(controlFor("width"), "length");
  assert.equal(controlFor("opacity"), "number");
  assert.equal(controlFor("color"), "color");
  assert.equal(controlFor("background-color"), "color");
  assert.equal(controlFor("font-family"), "text", "a family list is not an enum");
  assert.equal(controlFor("border"), "text");
  assert.equal(controlFor("box-shadow"), "text");
  assert.equal(controlFor("not-a-property"), "text", "an unknown property still gets an editor");
});

test("every allowed property resolves to a control, and the enum ones to values", () => {
  for (const property of ALLOWED) {
    const control = controlFor(property);
    assert.ok(["segmented", "select", "length", "number", "color", "text"].includes(control), `${property} -> ${control}`);
    if (control === "segmented" || control === "select") {
      assert.ok(valuesFor(property).length > 0, `${property} is an enum control with no declared values`);
    }
    assert.equal(typeof hintFor(property), "string", `${property} has no hint`);
  }
});

/**
 * The scrubber is a handle that adds a number to the value it holds. On a value
 * that is not a number, that gesture does not nudge it — it *replaces* it, and
 * the first version of this shipped exactly that: a 1px drag on `gap:
 * var(--space-md)` wrote `1`, and the token was gone without a word.
 */
test("a scrub handle is offered only for a value it can add a number to", () => {
  assert.equal(scrubFor("gap", "12px"), true);
  assert.equal(scrubFor("gap", "0"), true);
  assert.equal(scrubFor("width", "50%"), true);
  assert.equal(scrubFor("opacity", "0.5"), true);
  assert.equal(scrubFor("font-weight", "700"), true, "a font weight is a number");
  assert.equal(scrubFor("line-height", "1.5"), true);

  assert.equal(scrubFor("gap", "var(--space-md)"), false, "a token is not a number");
  assert.equal(scrubFor("width", "fit-content"), false);
  assert.equal(scrubFor("width", "calc(100% - 24px)"), false);
  assert.equal(scrubFor("padding", "0 0 24px 0"), false, "a four-value shorthand is not a number");
  assert.equal(scrubFor("color", "#111827"), false, "there is nothing to drag");
  assert.equal(scrubFor("font-weight", "bold"), false);
  assert.equal(scrubFor("not-a-property", "12px"), false);
});

test("a number input is only used when the value really is a number", () => {
  // `type="number"` sanitizes what it cannot parse to the empty string, which
  // would show an empty field for a declaration the file really carries.
  assert.equal(isNumericValue("14px"), true);
  assert.equal(isNumericValue("-8px"), true);
  assert.equal(isNumericValue("1.25rem"), true);
  assert.equal(isNumericValue("var(--size-body)"), false);
  assert.equal(isNumericValue("fit-content"), false);
  assert.equal(isNumericValue("0 22px 0 26px"), false);
});

test("CSS_ORDER knows every allowed property, so Other can sort anything", () => {
  const unknown = ALLOWED.filter((property) => !CSS_ORDER.includes(property));
  assert.deepEqual(unknown, [], `CSS_ORDER is missing: ${unknown.join(", ")}`);
});
