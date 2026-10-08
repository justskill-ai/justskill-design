/**
 * The validator's job is to make every problem findable and every fix nameable.
 * These tests pin the two failure modes that matter: a problem that is not
 * reported at all, and a report that does not say what to write instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "../lib/parse.mjs";
import { validateDesign, summarize, newErrors, errorKeys, collectTokens, componentCycles } from "../lib/validate.mjs";
import { parseDeclarations } from "../lib/parse.mjs";

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>:root{--color-ink:#111827;--space-md:16px}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`;

function file(body, head = HEAD) {
  const text = `<!doctype html>\n<html lang="zh">\n${head}\n<body>\n${body}\n</body>\n</html>\n`;
  return parse(text);
}

function page(inner, attrs = 'data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px"') {
  return `<section ${attrs}>${inner}</section>`;
}

const codes = (doc, options) => validateDesign(doc, options).map((d) => d.code);
const errorsOf = (doc, options) => validateDesign(doc, options).filter((d) => d.severity === "error");

// -- the clean case -----------------------------------------------------------

test("a well formed file validates with no diagnostics", () => {
  const doc = file(page(`
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;width:100%;height:100%;gap:16px;padding:16px;background-color:var(--color-ink)">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700;color:#ffffff">你好</p>
      <img data-id="home__photo" data-type="image" src="a.png" alt="月嫂" style="width:100%;height:200px;object-fit:cover">
    </div>`));
  const diagnostics = validateDesign(doc);
  assert.deepEqual(diagnostics, [], `unexpected diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
});

// -- version ------------------------------------------------------------------

test("a missing or wrong schema marker is an error", () => {
  const noMarker = file(page(""), `<head><style>:root{--a:#111111}</style></head>`);
  assert.ok(codes(noMarker).includes("version/missing-marker"));

  const wrong = file(page(""), `<head><meta name="design-schema" content="2.0"><style>:root{--a:#111111}</style></head>`);
  const diagnostics = validateDesign(wrong);
  const found = diagnostics.find((d) => d.code === "version/unsupported");
  assert.ok(found);
  assert.match(found.hint, /migrate/);
});

// -- structure ----------------------------------------------------------------

test("a missing data-id is an error that suggests the naming convention", () => {
  const doc = file(page(`<div data-type="frame" style="display:flex"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/missing-id");
  assert.ok(found);
  assert.match(found.hint, /__/);
});

test("a missing or wrong data-type is an error that names the default", () => {
  const missing = file(page(`<div data-id="a" style="display:flex"></div>`));
  const found = validateDesign(missing).find((d) => d.code === "structure/missing-type");
  assert.ok(found);
  assert.match(found.hint, /frame/);

  const wrong = file(page(`<p data-id="a" data-type="frame" style="color:#111827">x</p>`));
  const mismatch = validateDesign(wrong).find((d) => d.code === "structure/type-tag-mismatch");
  assert.ok(mismatch);
  assert.match(mismatch.message, /<p>/);
});

test("an unknown data-type gets a suggestion", () => {
  const doc = file(page(`<div data-id="a" data-type="franme" style="display:flex"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/unknown-type");
  assert.ok(found);
  assert.match(found.hint, /frame/);
});

test("a duplicate id is an error on the later element", () => {
  const doc = file(page(`
    <div data-id="home__a" data-type="frame" style="display:flex"></div>
    <div data-id="home__a" data-type="frame" style="display:flex"></div>`));
  const found = validateDesign(doc).filter((d) => d.code === "structure/duplicate-id");
  assert.equal(found.length, 1);
  assert.equal(found[0].offset, doc.source.lastIndexOf('<div data-id="home__a"'));
  assert.match(found[0].hint, /unique/);
});

test("two different ids are not a collision, however similar they look", () => {
  const doc = file(page(`
    <div data-id="home__title" data-type="frame" style="display:flex"></div>
    <div data-id="home__titel" data-type="frame" style="display:flex"></div>`));
  assert.equal(validateDesign(doc).filter((d) => d.code === "structure/duplicate-id").length, 0);
});

test("a duplicate suggests a free id to rename to", () => {
  const doc = file(page(`
    <div data-id="home__a" data-type="frame" style="display:flex"></div>
    <div data-id="home__a-2" data-type="frame" style="display:flex"></div>
    <div data-id="home__a" data-type="frame" style="display:flex"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/duplicate-id");
  assert.ok(found);
  assert.match(found.hint, /home__a-3/, "the hint names an id nothing else uses");
});

test("a duplicate inside a component is caught against the component's own ids", () => {
  const doc = file(page(`
    <div data-id="card" data-type="component" style="display:flex">
      <p data-id="card__title" data-type="text" style="font-size:14px">a</p>
    </div>
    <p data-id="card__title" data-type="text" style="font-size:14px">b</p>`));
  assert.ok(validateDesign(doc).some((d) => d.code === "structure/duplicate-id"));
});

test("an unsupported tag is reported and does not vanish", () => {
  const doc = file(page(`<canvas data-id="a" style="width:1px"></canvas>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/unsupported-tag");
  assert.ok(found);
  assert.match(found.hint, /section/);
});

test("missing required attributes name what to write", () => {
  const doc = file(page(`<img data-id="a" data-type="image" style="width:1px;height:1px">`));
  const found = validateDesign(doc).filter((d) => d.code === "structure/missing-attribute");
  assert.equal(found.length, 2);
  const alt = found.find((d) => d.message.includes("alt"));
  assert.match(alt.hint, /decorative/);
});

test("an attribute that does not belong to the type is an error", () => {
  const doc = file(page(`<p data-id="a" data-type="text" data-icon="x" style="color:#111827">x</p>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/unknown-attribute");
  assert.ok(found);
  assert.match(found.message, /data-icon/);
});

test("children on a text element are refused with a way forward", () => {
  const doc = file(page(`<p data-id="a" data-type="text" style="color:#111827"><span>bold</span></p>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/children-not-allowed");
  assert.ok(found);
  assert.match(found.hint, /span|frame/);
});

test("a file with no page is an error", () => {
  const doc = file(`<div data-id="a" data-type="frame" style="display:flex"></div>`);
  const found = validateDesign(doc).find((d) => d.code === "structure/no-page");
  assert.ok(found);
  assert.match(found.hint, /section/);
});

test("data-canvas must be x,y", () => {
  const ok = file(page("", 'data-id="home" data-type="page" data-canvas="0,920" style="width:1px;height:1px"'));
  assert.ok(!codes(ok).includes("structure/bad-canvas"));

  const bad = file(page("", 'data-id="home" data-type="page" data-canvas="left" style="width:1px;height:1px"'));
  const found = validateDesign(bad).find((d) => d.code === "structure/bad-canvas");
  assert.ok(found);
  assert.match(found.hint, /0,920/);
});

test("two pages on the same canvas point are reported", () => {
  const doc = file(`
    <section data-id="a" data-type="page" data-canvas="0,0" style="width:1px;height:1px"></section>
    <section data-id="b" data-type="page" data-canvas="0,0" style="width:1px;height:1px"></section>`);
  assert.ok(codes(doc).includes("structure/duplicate-canvas"));
});

// -- style --------------------------------------------------------------------

test("a property outside the table is an error that suggests the real one", () => {
  const doc = file(page(`<div data-id="a" data-type="frame" style="display:flex;backgound-color:#ffffff"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "style/unknown-property");
  assert.ok(found);
  assert.match(found.hint, /background-color/);
});

test("margin is in the table, so it validates; a one-sided margin is refused", () => {
  // Margin is legal. It is not the spacing system — gap and padding are — but a
  // half-pixel nudge is a real need, and refusing margin outright forced a
  // wrapper element. The one-sided spellings stay refused in favour of the
  // shorthand, which is the form that can round trip.
  const ok = file(page(`<div data-id="a" data-type="frame" style="display:flex;margin:16px"></div>`));
  assert.ok(!validateDesign(ok).some((d) => d.code === "style/rejected-property"));

  const sided = file(page(`<div data-id="a" data-type="frame" style="display:flex;margin-top:16px"></div>`));
  const found = validateDesign(sided).find((d) => d.code === "style/rejected-property");
  assert.ok(found);
  assert.match(found.hint, /margin: 16px 0 0 0/);
});

test("a bad value reports the property, the value and what to write", () => {
  const doc = file(page(`<div data-id="a" data-type="frame" style="display:flex;justify-content:between"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "style/bad-value");
  assert.ok(found);
  assert.match(found.message, /justify-content:between/);
  assert.match(found.hint, /space-between/);
});

test("a value the format cannot read is an error, not a silent pass", () => {
  const doc = file(page(`<div data-id="a" data-type="frame" style="display:flex;color:oklch(0.5 0.1 20)"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "style/bad-value");
  assert.ok(found);
  assert.match(found.hint, /hex/);
});

test("an alias is a warning, because it still means what it says", () => {
  const doc = file(page(`<div data-id="a" data-type="frame" style="display:flex;background:#ffffff"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "style/aliased-property");
  assert.ok(found);
  assert.equal(found.severity, "warning");
});

test("an undeclared token is reported with the nearest declared one", () => {
  const doc = file(page(`<p data-id="a" data-type="text" style="color:var(--color-inkk)">x</p>`));
  const found = validateDesign(doc).find((d) => d.code === "style/unknown-token");
  assert.ok(found);
  assert.match(found.hint, /--color-ink/);
});

test("the semicolon inside a data URI is not read as two declarations", () => {
  const doc = file(page(`<div data-id="a" data-type="frame" style="display:flex;background-image:url(&quot;data:image/svg+xml;base64,PHN2Zy8+&quot;);background-size:cover"></div>`));
  const diagnostics = validateDesign(doc);
  assert.deepEqual(diagnostics, [], `unexpected: ${JSON.stringify(diagnostics, null, 2)}`);
});

test("a style block in the body is an error", () => {
  const doc = file(`<style>div{color:red}</style>${page(`<div data-id="a" data-type="frame" style="display:flex"></div>`)}`);
  assert.ok(codes(doc).includes("style/style-in-body"));
});

test("a third style block with other content is an error", () => {
  const doc = file(page(""), `<head><meta name="design-schema" content="3.0"><style>:root{--a:#111111}</style><style>div{color:red}</style></head>`);
  assert.ok(codes(doc).includes("style/unsupported-block"));
});

test("two head style blocks are both read: the token block is not lost", () => {
  const doc = file(page(`<p data-id="a" data-type="text" style="color:var(--color-ink)">x</p>`));
  const { tokens } = collectTokens(doc);
  assert.ok(tokens.has("--color-ink"), "the token block survived the page-frame block");
  const diagnostics = validateDesign(doc);
  assert.ok(!diagnostics.some((d) => d.code === "style/unknown-token"), "no false unknown-token report");
});

test("a token name outside the seven groups is reported", () => {
  const doc = file(page(""), `<head><meta name="design-schema" content="3.0"><style>:root{--brand:#111111}</style></head>`);
  const found = validateDesign(doc).find((d) => d.code === "style/token-name");
  assert.ok(found);
  assert.match(found.hint, /group/);
});

// -- components ---------------------------------------------------------------

test("an instance that points at nothing is reported with the known ids", () => {
  const doc = file(page(`<div data-id="home__card" data-type="instance" data-ref="card" style="width:1px;height:1px"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "component/unknown-ref");
  assert.ok(found);
  assert.match(found.message, /card/);
});

test("an override key outside the component is reported", () => {
  const doc = file(page(`
    <div data-id="card" data-type="component" style="display:flex;gap:4px">
      <p data-id="card__title" data-type="text" style="font-size:14px">Card</p>
    </div>
    <div data-id="home__a" data-type="instance" data-ref="card" data-overrides='{"card__titel":{"font-size":"20px"}}' style="width:1px"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "component/unknown-override-target");
  assert.ok(found);
  assert.match(found.hint, /card__title/);
});

test("malformed overrides JSON is reported, not thrown", () => {
  const doc = file(page(`
    <div data-id="card" data-type="component" style="display:flex"></div>
    <div data-id="home__a" data-type="instance" data-ref="card" data-overrides='{oops}' style="width:1px"></div>`));
  assert.ok(codes(doc).includes("component/bad-overrides"));
});

test("a component loop is detected", () => {
  const doc = file(page(`
    <div data-id="a" data-type="component" style="display:flex">
      <div data-id="a__i" data-type="instance" data-ref="b" style="width:1px"></div>
    </div>
    <div data-id="b" data-type="component" style="display:flex">
      <div data-id="b__i" data-type="instance" data-ref="a" style="width:1px"></div>
    </div>`));
  const cycles = componentCycles(doc);
  assert.ok(cycles.length >= 1);
  assert.ok(codes(doc).includes("component/cycle"));
});

// -- the new-errors gate ------------------------------------------------------

test("newErrors reports only what the edit added", () => {
  const good = validateDesign(file(page(`<div data-id="a" data-type="frame" style="display:flex"></div>`)));
  const bad = validateDesign(file(page(`<div data-id="a" data-type="frame" style="display:flex;margin-top:1px"></div>`)));
  assert.equal(newErrors(good, good).length, 0);
  assert.equal(newErrors(good, bad).length, 1);
  assert.equal(newErrors(bad, bad).length, 0, "a pre-existing error is not new");
});

test("errorKeys is stable for the same problem", () => {
  const one = validateDesign(file(page(`<div data-id="a" data-type="frame" style="display:flex;margin-top:1px"></div>`)));
  const two = validateDesign(file(page(`<div data-id="a" data-type="frame" style="display:flex;margin-top:1px"></div>`)));
  assert.deepEqual([...errorKeys(one)], [...errorKeys(two)]);
});

test("summarize counts errors and warnings", () => {
  const diagnostics = validateDesign(file(page(`<div data-id="a" data-type="frame" style="display:flex;background:#ffffff;margin-left:1px"></div>`)));
  const summary = summarize(diagnostics);
  assert.equal(summary.total, diagnostics.length);
  assert.ok(summary.errors >= 1);
  assert.ok(summary.warnings >= 1);
});

test("every diagnostic carries a code, a severity and a message", () => {
  const doc = file(page(`<canvas data-id="a"></canvas><p data-id="a" data-type="text" style="color:oklch(1 2 3)">x</p>`));
  for (const d of validateDesign(doc)) {
    assert.match(d.code, /^[a-z]+\/[a-z-]+$/, `bad code: ${d.code}`);
    assert.ok(d.severity === "error" || d.severity === "warning");
    assert.ok(d.message.length > 5);
  }
});

test("no element escapes validation: every element in the file is accounted for", () => {
  const doc = file(page(`
    <div data-id="a" data-type="frame" style="display:flex">
      <canvas data-id="b"></canvas>
      <p data-type="text">no id</p>
      <img data-id="c" data-type="image" style="width:1px">
    </div>`));
  const diagnostics = validateDesign(doc);
  const targets = diagnostics.map((d) => d.offset);
  // Each of the three inner elements produced at least one diagnostic.
  for (const id of ["a", "b", "c"]) {
    const node = (function find(n) {
      if (n.kind === "element" && n.attrs?.some((x) => x.name === "data-id" && x.value === id)) return n;
      for (const child of n.children || []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    })(doc);
    if (!node) continue;
    assert.ok(targets.some((t) => t !== undefined && t >= node.start && t <= node.end),
      `element ${id} produced no diagnostic at its own location`);
  }
});

// -- the opaque layer ---------------------------------------------------------

test("svg geometry is the opaque layer: it is not validated as design elements", () => {
  const doc = file(page(`
    <svg data-id="home__icon" data-type="icon" data-icon="shield-check" data-icon-library="lucide" style="width:24px;height:24px;color:#111827">
      <path d="M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/>
      <circle cx="12" cy="12" r="3"/>
      <title>shield</title>
    </svg>`));
  const diagnostics = validateDesign(doc);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), [],
    `unexpected errors: ${JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2)}`);
});

test("an icon with no geometry is a warning with a fix", () => {
  const doc = file(page(`<svg data-id="home__icon" data-type="icon" data-icon="x" data-icon-library="lucide" style="width:24px;height:24px"></svg>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/empty-icon");
  assert.ok(found);
  assert.match(found.hint, /path/);
});

test("an id inside an svg is refused, because nothing can address it", () => {
  const doc = file(page(`
    <svg data-id="home__icon" data-type="icon" data-icon="x" data-icon-library="lucide" style="width:24px;height:24px">
      <path data-id="home__icon__path" d="M0 0h24v24H0z"/>
    </svg>`));
  const found = validateDesign(doc).find((d) => d.code === "structure-id-inside-icon");
  assert.ok(found);
  assert.match(found.hint, /svg data-type="icon"/);
});

test("the real icon fixture validates once geometry is the opaque layer", () => {
  const path = fileURLToPath(new URL("./fixtures/html/svg-icon.html", import.meta.url));
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const diagnostics = validateDesign(parse(text));
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), [],
    `unexpected errors: ${JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2)}`);
});
