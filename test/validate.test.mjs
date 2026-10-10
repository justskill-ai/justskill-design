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

const HEAD = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>*,*::before,*::after{box-sizing:border-box}\n*{margin:0}\nimg{display:block}\nsvg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n:root{--color-ink:#111827;--space-md:16px}</style><style>section[data-type="page"]{margin:0 0 24px}</style></head>`;

function file(body, head = HEAD) {
  const text = `<!doctype html>\n<html lang="zh">\n${head}\n<body>\n${body}\n</body>\n</html>\n`;
  return parse(text);
}

function page(inner, attrs = 'data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px"') {
  return `<section ${attrs}>${inner}</section>`;
}

const codes = (doc, options) => validateDesign(doc, options).map((d) => d.code);
const errorsOf = (doc, options) => validateDesign(doc, options).filter((d) => d.severity === "error");

// -- the box model the file states about itself -------------------------------

test("a file with no box model is told, because two renderers will disagree", () => {
  // `width:375px;padding:0 24px` is 423px wide to a browser and 375px wide to a
  // renderer that injects a reset. The file is the only place that can say which
  // one it means, so a file that says nothing gets told.
  const plain = `<head><meta charset="utf-8"><meta name="design-schema" content="3.0"><style>:root{--color-ink:#111827}</style></head>`;
  const found = validateDesign(file(page(""), plain));
  const reported = found.find((d) => d.code === "style/no-base-rules");
  assert.ok(reported, `expected style/no-base-rules, got ${found.map((d) => d.code).join(", ")}`);
  assert.equal(reported.severity, "warning");
  assert.match(reported.hint, /box-sizing:border-box/);

  const withBase = validateDesign(file(page("")));
  assert.ok(!withBase.some((d) => d.code === "style/no-base-rules"), "a file that states its box model is left alone");
});

test("a file written before a base rule existed is told which rule it is missing", () => {
  // The box model holds, so nothing about the page looks broken. One glyph
  // paints as a black silhouette, or one shape has no meaning, and only that
  // node knows. A difference like that cannot be silent, so the file is told the
  // rule by name.
  const before = HEAD.replace("img{display:block}\n", "").replace("</style>", "</style>", 1);
  const found = validateDesign(file(page(""), before));
  const reported = found.find((d) => d.code === "style/incomplete-base-rules");
  assert.ok(reported, `expected style/incomplete-base-rules, got ${found.map((d) => d.code).join(", ")}`);
  assert.equal(reported.severity, "warning");
  assert.match(reported.message, /img\{display:block\}/, "the message names the rule to add");
  assert.match(reported.message, /one base rule/, "a single missing rule is counted in the singular");
  assert.ok(!found.some((d) => d.code === "style/no-base-rules"), "the file does state a box model");

  // The same rule written in a different spelling is the same rule. Whitespace
  // and quotes are not part of what the file means.
  const rewritten = HEAD.replace(
    "svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    "svg:not([data-fill])> :not([fill]):not([stroke]) { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round }",
  );
  const rewrittenFound = validateDesign(file(page(""), rewritten));
  assert.ok(!rewrittenFound.some((d) => d.code === "style/incomplete-base-rules"), `a rule is not its spelling: ${rewrittenFound.map((d) => `${d.code} ${d.message}`).join(" | ")}`);

  assert.ok(!validateDesign(file(page(""))).some((d) => d.code === "style/incomplete-base-rules"), "the canonical header is complete");
});

test("an ellipse that nothing rounds is told, because a div is a rectangle", () => {
  const body = (style) => page(`    <div data-id="home__dot" data-type="shape" data-kind="ellipse" style="${style}"></div>`);
  const flat = file(body("width:44px;height:44px;background-color:#fce7f3"));
  const reported = validateDesign(flat).find((d) => d.code === "style/ellipse-without-radius");
  assert.ok(reported, "a declared ellipse with no radius draws as a square");
  assert.equal(reported.severity, "warning");
  assert.match(reported.hint, /border-radius:50%/);

  const round = file(body("width:44px;height:44px;background-color:#fce7f3;border-radius:50%"));
  assert.ok(!codes(round).includes("style/ellipse-without-radius"), "a rounded ellipse is left alone");

  // A rule in the head is not a fix. It rounds the node in the file and stops
  // matching in the deliverable, where the design attributes are gone.
  const head = HEAD.replace("</style></head>", '</style></head>');
  const byRule = parse(`<!doctype html>\n<html lang="zh">\n${head}\n<body>\n${body("width:44px;height:44px;background-color:#fce7f3")}\n</body>\n</html>\n`);
  assert.ok(codes(byRule).includes("style/ellipse-without-radius"), "a data-kind selector cannot ship");
});

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

test("missing required attributes name what to write, under the right code", () => {
  const doc = file(page(`<img data-id="a" data-type="image" style="width:1px;height:1px">`));
  const found = validateDesign(doc);

  // `docs/format-v3.md` §6 assigns the two image rules to their own families: the
  // alt text is an accessibility finding and the src is an asset one. They used to
  // arrive as two `structure/missing-attribute` errors, which left the contract's
  // `a11y/` and `asset/` prefixes with nothing that could ever emit them.
  const alt = found.find((d) => d.code === "a11y/missing-alt");
  const src = found.find((d) => d.code === "asset/missing-src");
  assert.ok(alt, `expected a11y/missing-alt, got ${found.map((d) => d.code).join(", ")}`);
  assert.ok(src, `expected asset/missing-src, got ${found.map((d) => d.code).join(", ")}`);
  assert.match(alt.hint, /decorative/);
  assert.equal(alt.target, "a");
  assert.equal(src.target, "a");
  assert.equal(found.filter((d) => d.code === "structure/missing-attribute").length, 0);
});

test("a required attribute that is not an image rule keeps the generic code", () => {
  // The mapping is per `type:attribute`, not per diagnostic. An icon missing its
  // library is a malformed element rather than an accessibility finding, and an
  // instance with no `data-ref` is neither.
  const doc = file(page(
    `<svg data-id="i" data-type="icon" data-icon="bell" viewBox="0 0 24 24" style="width:1px;height:1px"><path d="M1 1"/></svg>`
    + `<div data-id="r" data-type="instance"></div>`,
  ));
  const found = validateDesign(doc).filter((d) => d.code === "structure/missing-attribute");
  assert.equal(found.length, 2, JSON.stringify(found.map((d) => d.message)));
  assert.deepEqual(found.map((d) => d.target).sort(), ["i", "r"]);
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

test("a content override on a glyph is reported, because nothing would draw it", () => {
  // Text inside an `<svg>` that is not inside a `<text>` draws nothing, so this
  // patch leaves the icon in the file and the mount blank.
  const doc = file(page(`
    <div data-id="card" data-type="component" style="display:flex">
      <svg data-id="card__icon" data-type="icon" data-icon="sparkles" data-icon-library="lucide" viewBox="0 0 24 24" style="width:22px;height:22px"><path d="M1 1h2v2H1z"></path></svg>
    </div>
    <div data-id="home__a" data-type="instance" data-ref="card" data-overrides='{"card__icon":{"content":"gem"}}' style="width:1px"></div>`));
  const found = validateDesign(doc).find((d) => d.code === "component/text-override-on-icon");
  assert.ok(found, "the erase is silent otherwise");
  assert.match(found.hint, /children/);

  const geometry = file(page(`
    <div data-id="card" data-type="component" style="display:flex">
      <svg data-id="card__icon" data-type="icon" data-icon="gem" data-icon-library="lucide" viewBox="0 0 24 24" style="width:22px;height:22px"><path d="M1 1h2v2H1z"></path></svg>
    </div>
    <div data-id="home__a" data-type="instance" data-ref="card" data-overrides='{"card__icon":{"data-icon":"gem","children":"&lt;path d=\\"M3 3h2v2H3z\\"&gt;&lt;/path&gt;"}}' style="width:1px"></div>`));
  assert.ok(!codes(geometry).includes("component/text-override-on-icon"), "the geometry patch is the way to swap a glyph");
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
    <svg data-id="home__icon" data-type="icon" data-icon="shield-check" data-icon-library="lucide" viewBox="0 0 24 24" style="width:24px;height:24px;color:#111827">
      <path d="M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/>
      <circle cx="12" cy="12" r="3"/>
      <title>shield</title>
    </svg>`));
  const diagnostics = validateDesign(doc);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), [],
    `unexpected errors: ${JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2)}`);
});

test("a family list with no generic family is told what to write", () => {
  // `"Noto Serif SC"` alone means "Noto Serif SC, or whatever this machine uses
  // for text", and that is a serif face on most engines. The design then looks
  // like a different design on any machine that cannot fetch the webfont.
  const doc = file(page(`
    <p data-id="home__t" data-type="text" style="font-family:&quot;Noto Serif SC&quot;;font-size:19px">标题</p>`));
  const found = validateDesign(doc).find((d) => d.code === "style/no-generic-family");
  assert.ok(found, `expected style/no-generic-family, got ${codes(doc).join(", ")}`);
  assert.match(found.hint, /system-ui, sans-serif/);

  const fine = file(page(`
    <p data-id="home__t" data-type="text" style="font-family:&quot;Noto Serif SC&quot;, system-ui, sans-serif;font-size:19px">标题</p>`));
  assert.ok(!codes(fine).includes("style/no-generic-family"), "a list that ends in a generic is left alone");
});

test("an icon with geometry but no viewBox is an error, because it is clipped", () => {
  // A `<svg>` with no `viewBox` has no coordinate system: the geometry is drawn
  // in the element's own pixel box. `target`'s three rings then render as one
  // arc and `signal`'s five bars as a single dot — no warning, no console
  // message, just a different drawing.
  const doc = file(page(`
    <svg data-id="home__icon" data-type="icon" data-icon="target" data-icon-library="lucide" style="width:15px;height:15px">
      <circle cx="12" cy="12" r="10"></circle>
    </svg>`));
  const found = validateDesign(doc).find((d) => d.code === "structure/icon-without-viewbox");
  assert.ok(found, `expected structure/icon-without-viewbox, got ${codes(doc).join(", ")}`);
  assert.match(found.hint, /viewBox="0 0 24 24"/);
});

test("an empty icon needs no viewBox, only geometry does", () => {
  const doc = file(page(`
    <svg data-id="home__icon" data-type="icon" data-icon="target" data-icon-library="lucide" style="width:15px;height:15px"></svg>`));
  assert.ok(!codes(doc).includes("structure/icon-without-viewbox"));
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

test("a page that states its own placement is warned, and pointed at data-canvas", () => {
  const doc = file(page("", `data-id="home" data-type="page" data-canvas="600,2400" style="display:flex;position:absolute;left:-85px;top:-352px;width:375px"`));
  const found = validateDesign(doc).find((d) => d.code === "structure/page-position");
  assert.ok(found, "two spellings for one page is what needs saying");
  assert.equal(found.severity, "warning");
  assert.match(found.message, /position, left, top/);
  assert.match(found.hint, /600,2400/);

  const clean = file(page("", `data-id="home" data-type="page" data-canvas="600,2400" style="display:flex;width:375px"`));
  assert.ok(!codes(clean).includes("structure/page-position"));
});
