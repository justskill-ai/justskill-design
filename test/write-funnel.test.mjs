/**
 * The write funnel, end to end.
 *
 * These are the invariants the whole product rests on, and each one fails first
 * if a layer drifts:
 *
 *   - a fragment is compiled, checked and applied, or refused by name
 *   - an edit that would introduce a NEW error is refused, and the file is byte
 *     identical afterwards
 *   - an edit that repairs an existing error is allowed through
 *   - an op list is invertible, so undo restores the exact bytes
 *   - a file nobody edited is never rewritten
 *
 * Every case drives the real modules in the order the verb does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse, getAttr, findById } from "../lib/parse.mjs";
import { serialize } from "../lib/serialize.mjs";
import { validateDesign, newErrors, errorKeys } from "../lib/validate.mjs";
import { applyOps, OpsError } from "../lib/ops.mjs";
import { compileFragment } from "../lib/fragment.mjs";
import { normalizeDocument } from "../lib/normalize.mjs";

const START = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>funnel</title>
  <meta name="design-schema" content="3.0">
  <style>*,*::before,*::after{box-sizing:border-box}\n*{margin:0}\nimg{display:block}\nsvg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n:root{ --color-ink:#111827; --space-md:16px }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;gap:16px;padding:24px">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:var(--color-ink)">你好</p>
    </div>
  </section>
</body>
</html>
`;

/** The funnel, exactly as lib/node/verbs/add.mjs runs it. */
function applyFragment(text, html, options = {}) {
  const doc = parse(text);
  const before = validateDesign(doc);
  const compiled = compileFragment(doc, html, options);
  if (compiled.refused) return { refused: compiled.refused, text, compiled };
  const { doc: next, inverse } = applyOps(doc, compiled.ops);
  const after = validateDesign(next);
  const introduced = newErrors(before, after);
  if (introduced.length && !options.force) {
    return { refused: { code: "funnel/would-introduce-errors", introduced }, text, compiled };
  }
  return { text: serialize(doc, next), inverse, compiled, doc: next, diagnostics: after };
}

// -- the happy path -----------------------------------------------------------

test("a clean fragment is compiled, applied, and reported", () => {
  const result = applyFragment(START, `<div data-id="home__cta" data-type="frame" style="display:flex;padding:12px 12px 12px 12px;background:#fff">
  <p data-id="home__cta-label" data-type="text" style="font-size:16px;color:rgba(0,0,0,0.6)">开始</p>
</div>`, { in: "home__root" });

  assert.equal(result.refused, undefined, `unexpected refusal: ${JSON.stringify(result.refused)}`);
  assert.deepEqual(result.compiled.added, ["home__cta", "home__cta-label"]);

  // Every change is reported: two value rewrites and one refused property.
  const normalized = result.compiled.normalized.map((n) => n.prop);
  assert.ok(normalized.includes("background-color"), "the alias rename is reported");
  assert.ok(normalized.includes("padding"), "the four-value compression is reported");
  assert.ok(normalized.includes("color"), "the rgba rewrite is reported");

  // The bytes that changed are the inserted subtree and nothing else.
  assert.ok(result.text.startsWith(START.slice(0, START.indexOf("    </div>"))));
  assert.match(result.text, /data-id="home__cta"/);
  assert.match(result.text, /background-color:#ffffff/, "the alias landed canonically");
  assert.match(result.text, /padding:12px;/, "the padding was compressed");
  assert.match(result.text, /color:#00000099/, "rgba became eight-digit hex");

  // The result still validates.
  const after = validateDesign(parse(result.text));
  assert.deepEqual(after.filter((d) => d.severity === "error"), []);
});

test("a fragment with a one-sided margin is refused, and the reason names the shorthand", () => {
  const result = applyFragment(START, `<div data-id="home__box" data-type="frame" style="display:flex;margin-top:16px"></div>`, { in: "home__root" });
  assert.equal(result.refused, undefined, "an out-of-table property is dropped, not fatal");
  assert.equal(result.compiled.dropped.length, 1);
  const dropped = result.compiled.dropped[0];
  assert.equal(dropped.prop, "margin-top");
  assert.equal(dropped.target, "home__box", "the report names the element it changed");
  // The reason says which form to use, and the hint carries the value.
  assert.match(dropped.reason, /shorthand/);
  assert.match(dropped.replacement ?? "", /margin/);
  const element = findById(parse(result.text), "home__box");
  assert.equal(getAttr(element, "style"), "display:flex", "the element kept only what the table allows");
});

test("a fragment may use a whole margin: it is a property, not a spacing system", () => {
  const result = applyFragment(START, `<div data-id="home__box" data-type="frame" style="display:flex;margin:-0.5px 0 0 0"></div>`, { in: "home__root" });
  assert.equal(result.refused, undefined, JSON.stringify(result.refused));
  assert.equal(result.compiled.dropped.length, 0);
  assert.match(result.text, /margin:-0.5px 0 0 0/);
});

test("a fragment with an unsupported value is refused by name", () => {
  const result = applyFragment(START, `<div data-id="home__row" data-type="frame" style="display:grid"></div>`, { in: "home__root" });
  assert.ok(result.refused, "grid is not a value of display");
  assert.match(JSON.stringify(result.refused), /display/);
  assert.equal(result.text, START, "the file is untouched");
});

test("a fragment with a duplicate id is refused with a free name", () => {
  const result = applyFragment(START, `<p data-id="home__title" data-type="text" style="font-size:14px">x</p>`, { in: "home__root" });
  assert.ok(result.refused);
  assert.match(JSON.stringify(result.refused), /home__title/);
  assert.equal(result.text, START);
});

test("a fragment missing data-type is refused, and a missing id is filled in", () => {
  const noType = applyFragment(START, `<div data-id="home__x"></div>`, { in: "home__root" });
  assert.ok(noType.refused, "data-type is required");

  const noId = applyFragment(START, `<div data-type="frame" style="display:flex"></div>`, { in: "home__root" });
  assert.equal(noId.refused, undefined, `unexpected refusal: ${JSON.stringify(noId.refused)}`);
  assert.equal(noId.compiled.added.length, 1);
  assert.match(noId.compiled.added[0], /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  assert.match(noId.text, new RegExp(`data-id="${noId.compiled.added[0]}"`));
});

// -- the gate -----------------------------------------------------------------

test("an edit that introduces a new error is refused and writes nothing", () => {
  const result = applyFragment(START, `<img data-id="home__photo" data-type="image" src="a.png" style="width:100%;height:80px">`, { in: "home__root" });
  assert.ok(result.refused, "a missing alt is a new error");
  assert.equal(result.text, START, "the file is byte identical");
  const introduced = result.refused.introduced;
  assert.ok(introduced.some((d) => d.code === "structure/missing-attribute"));
  assert.ok(introduced[0].hint.length > 10, "the refusal says what to write");
});

test("an edit that repairs an existing error is allowed", () => {
  const broken = START.replace('data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:var(--color-ink)"',
    'data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:oklch(0.5 0.1 20)"');
  const before = validateDesign(parse(broken));
  assert.ok(errorKeys(before).size > 0, "the file starts broken");

  // Fix the bad color by replacing the element's style attribute.
  const doc = parse(broken);
  const { doc: next } = applyOps(doc, [{ op: "set", target: "home__title", prop: "style", value: "font-size:32px;font-weight:700;color:#111827" }]);
  const after = validateDesign(next);
  assert.equal(newErrors(before, after).length, 0, "the repair introduces nothing new");
});

test("a pre-existing error does not block an unrelated edit", () => {
  const broken = START.replace("<body>", "<body>\n  <canvas data-id=\"stray\"></canvas>");
  const before = validateDesign(parse(broken));
  assert.ok(errorKeys(before).size > 0);

  const result = applyFragment(broken, `<p data-id="home__note" data-type="text" style="font-size:12px;color:#111827">note</p>`, { in: "home__root" });
  assert.equal(result.refused, undefined, "the unrelated error must not block this edit");
  assert.match(result.text, /data-id="home__note"/);
});

// -- the drag path ------------------------------------------------------------

test("a canvas drag becomes exactly three ops, and they are invertible", () => {
  const doc = parse(START);
  const ops = [
    { op: "set", target: "home__title", prop: "style:position", value: "absolute" },
    { op: "set", target: "home__title", prop: "style:left", value: "122px" },
    { op: "set", target: "home__title", prop: "style:top", value: "61px" },
  ];
  const { doc: next, inverse } = applyOps(doc, ops);
  const moved = serialize(doc, next);
  assert.match(moved, /position:absolute;left:122px;top:61px/);

  // Only the moved element's bytes changed.
  assert.equal(moved.slice(0, moved.indexOf('<p data-id="home__title"')),
    START.slice(0, START.indexOf('<p data-id="home__title"')));

  // Undo restores the exact original bytes.
  const { doc: back } = applyOps(next, inverse);
  assert.equal(serialize(next, back), START);
});

test("a no-op drag produces the same bytes, so nothing is written", () => {
  const doc = parse(START);
  const { doc: next, inverse } = applyOps(doc, [
    { op: "set", target: "home__title", prop: "style:position", value: "absolute" },
    { op: "set", target: "home__title", prop: "style:left", value: "0px" },
    { op: "set", target: "home__title", prop: "style:top", value: "0px" },
  ]);
  const once = serialize(doc, next);
  const twice = serialize(next, applyOps(next, inverse).doc);
  assert.equal(twice, START);
  assert.notEqual(once, START, "the first drag does change the file");
});

test("moving a page writes data-canvas and nothing else", () => {
  const doc = parse(START);
  const { doc: next, inverse } = applyOps(doc, [{ op: "set", target: "home", prop: "data-canvas", value: "600,240" }]);
  const moved = serialize(doc, next);
  assert.equal(moved, START.replace('data-canvas="0,0"', 'data-canvas="600,240"'));
  assert.equal(serialize(next, applyOps(next, inverse).doc), START);
});

test("moving an element into its own subtree is refused", () => {
  const doc = parse(START);
  assert.throws(() => applyOps(doc, [{ op: "move", target: "home__root", into: "home__title" }]), OpsError);
});

// -- byte fidelity on the save path -------------------------------------------

test("a file nobody edited is never rewritten", () => {
  const doc = parse(START);
  assert.equal(serialize(doc, doc), START);
});

test("normalizing a clean file changes no bytes, and normalizing a messy one is idempotent", () => {
  const clean = parse(START);
  const cleanResult = normalizeDocument(clean, { serialize });
  assert.equal(serialize(clean, clean), START);
  assert.equal(cleanResult.normalized.length, 0, "a canonical file reports no change");

  const messy = START
    .replace('data-canvas="0,0" style="width:390px;height:844px"', 'style="height:844px;width:390px" data-canvas="0,0"')
    .replace("background-color:var(--color-ink)", "background-color:#111");
  const first = parse(messy);
  normalizeDocument(first, { serialize });
  const once = serialize(first, first);
  const second = parse(once);
  normalizeDocument(second, { serialize });
  assert.equal(serialize(second, second), once, "a second pass changes nothing");
});

test("every reported normalization is one a reader can act on", () => {
  const messy = START.replace('style="font-size:32px;font-weight:700;color:var(--color-ink)"',
    'style="color:#fff;font-size:32px;font-weight:bold;padding:16px 16px 16px 16px"');
  const doc = parse(messy);
  const { normalized } = normalizeDocument(doc, { serialize });
  assert.ok(normalized.length >= 2);
  for (const entry of normalized) {
    assert.ok(entry.target, "a change names the element it changed");
    assert.ok(entry.from && entry.to, `a change has a before and an after: ${JSON.stringify(entry)}`);
  }
});
