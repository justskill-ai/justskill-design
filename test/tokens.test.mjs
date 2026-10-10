/**
 * The token layer: names, groups, values, addressing, cycles.
 *
 * A token is the one part of a design file that is not an element. It has no
 * `data-id`, so nothing else in the tool can reach it, and before this layer existed
 * the only way to change a brand color was to rewrite the whole file. What these tests
 * hold down is that the address is unambiguous (one spelling, one token), that the
 * rules the skill's own `references/schema.md` states are the rules the code enforces,
 * and that a token chain cannot take the process down.
 *
 * The op side — `set-token` / `unset-token`, and that an undo puts the bytes back — is
 * in `test/ops.test.mjs`, next to the other op kinds.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parse } from "../lib/parse.mjs";
import { renderModel, resolveTokens } from "../lib/render.mjs";
import { collectTokens, validateDesign } from "../lib/validate.mjs";
import { TOKEN_GROUPS, TableError } from "../lib/table.mjs";
import {
  TOKEN_MAX_DEPTH,
  findTokenCycles,
  groupOfToken,
  normalizeTokenValue,
  resolveTokenName,
  tokenNameProblem,
  tokenReferenceNames,
  tokenSites,
} from "../lib/tokens.mjs";

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

/** A file whose only interesting part is the `:root{}` body. */
function file(root, body = `<section data-id="home" data-type="page" style="width:390px;height:844px"></section>`) {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="design-schema" content="3.0">',
    `<style>:root{${root}}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("\n");
}

function docOf(text) {
  return parse(text, { file: "t.html", format: "html", source: text });
}

function codesOf(text) {
  return validateDesign(docOf(text)).map((d) => d.code);
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

test("a token name is written two ways and both mean the same token", () => {
  assert.equal(resolveTokenName("color.accent"), "--color-accent");
  assert.equal(resolveTokenName("--color-accent"), "--color-accent");
  assert.equal(resolveTokenName(" radius.brand-500 "), "--radius-brand-500");
  assert.equal(groupOfToken("--radius-brand-500"), "radius");
});

test("a name from a group outside the seven is refused, in both spellings", () => {
  for (const spec of ["brand.primary", "--brand-primary", "surface.warm"]) {
    assert.throws(() => resolveTokenName(spec), (error) => {
      assert.ok(error instanceof TableError);
      assert.equal(error.code, "style/token-name");
      assert.match(error.hint, /color/);
      return true;
    }, `${spec} should be refused`);
  }
});

test("a name with no group at all is refused with the shape it wants", () => {
  for (const spec of ["accent", "--accent", "color.", "color.a.b", ""]) {
    assert.throws(() => resolveTokenName(spec), { name: "TableError" }, `${spec} should be refused`);
  }
});

/**
 * The rule is two rules, and only the shape half used to run.
 *
 * `--brand` (no name after the group) always failed the pattern, so the old check
 * caught it. `--brand-500` has a perfectly good shape and a group that is not one of
 * the seven, and it was accepted — while `tokens set brand.500` was refused, so the
 * file was called valid and its tokens were unaddressable. `references/schema.md` says
 * the group "must be one of" the seven, and that page is the contract the model reads.
 */
test("a well-shaped name from an unknown group is a problem, not a pass", () => {
  assert.equal(tokenNameProblem("--color-accent"), null);
  assert.equal(tokenNameProblem("--size-body"), null);

  const unknown = tokenNameProblem("--accent-500");
  assert.ok(unknown, "an unknown group must be reported even when the shape is fine");
  assert.equal(unknown.group, "accent");
  assert.match(unknown.message, /accent/);
  assert.match(unknown.hint, /color/);

  const shape = tokenNameProblem("--brand");
  assert.match(shape.message, /--<group>-<name>/);
});

test("the validator reports both halves of the rule, at the token", () => {
  const warnings = validateDesign(docOf(file(" --accent-500:#111111; --brand:#222222 ")))
    .filter((d) => d.code === "style/token-name");
  assert.equal(warnings.length, 2);
  for (const warning of warnings) {
    // The offset is a file offset, not an offset into the `:root{}` body and not
    // `undefined` — which is what every token diagnostic used to carry, because this
    // read `decl.start` off an object that never had one.
    assert.ok(Number.isInteger(warning.offset), `${warning.message} has no offset`);
    assert.match(file(" --accent-500:#111111; --brand:#222222 ").slice(warning.offset), /^--/);
  }
});

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

test("a numeric group carries a unit, and a value that is not a length is refused", () => {
  assert.deepEqual(normalizeTokenValue("space", "16"), { value: "16px", changed: true });
  assert.deepEqual(normalizeTokenValue("space", "16px"), { value: "16px", changed: false });
  assert.deepEqual(normalizeTokenValue("radius", "0"), { value: "0", changed: false });
  assert.deepEqual(normalizeTokenValue("size", "1.5rem"), { value: "1.5rem", changed: false });
  assert.throws(() => normalizeTokenValue("space", "wide"), { code: "style/bad-length" });
  assert.throws(() => normalizeTokenValue("space", ""), { code: "style/empty-value" });
});

test("a color is written as the hex the rest of the file uses", () => {
  assert.deepEqual(normalizeTokenValue("color", "red"), { value: "#ff0000", changed: true });
  assert.deepEqual(normalizeTokenValue("color", "#FFF"), { value: "#ffffff", changed: true });
  assert.deepEqual(normalizeTokenValue("color", "#2563eb"), { value: "#2563eb", changed: false });
  assert.deepEqual(normalizeTokenValue("color", "var(--color-ink)"), { value: "var(--color-ink)", changed: false });
  assert.throws(() => normalizeTokenValue("color", "not a color"), { code: "style/bad-color" });
});

/**
 * The three groups the contract sets no rule for. A normalizer here would be a rule
 * nobody asked for, and the first thing it would break is `--font-body`, whose value is
 * a font stack.
 */
test("font, shadow and border values are written as given", () => {
  const stack = "Inter, system-ui, sans-serif";
  assert.deepEqual(normalizeTokenValue("font", stack), { value: stack, changed: false });
  assert.deepEqual(normalizeTokenValue("shadow", "0 1px 2px #00000014"), { value: "0 1px 2px #00000014", changed: false });
  assert.deepEqual(normalizeTokenValue("border", "1px solid #e5e7eb"), { value: "1px solid #e5e7eb", changed: false });
});

/* ------------------------------------------------------------------ *
 * Addressing
 * ------------------------------------------------------------------ */

test("every token is found once, with a file offset that points at it", () => {
  const text = file(" --color-bg:#f5f5f7; --space-md:16px; --color-accent:#2563eb ");
  const { sites } = tokenSites(docOf(text));
  assert.deepEqual([...sites.keys()], ["--color-bg", "--space-md", "--color-accent"]);
  for (const site of sites.values()) {
    assert.ok(text.startsWith(site.name, site.offset), `${site.name} is not at ${site.offset}`);
    assert.equal(site.value, text.slice(site.offset + site.name.length + 1).split(/[;\s]/)[0]);
  }
});

/** `render` and `export` read the tokens through `collectTokens`; it must stay a Map. */
test("collectTokens still answers with a token Map", () => {
  const doc = docOf(file(" --color-bg:#f5f5f7; --space-md:16px "));
  const { tokens, duplicates } = collectTokens(doc);
  assert.ok(tokens instanceof Map);
  assert.deepEqual([...tokens.keys()], ["--color-bg", "--space-md"]);
  assert.equal(tokens.get("--space-md").value, "16px");
  assert.deepEqual(duplicates, []);
});

test("a token block outside head is not a token block", () => {
  // format-v3 §4.1 defines a token block as a `<style>` in `<head>`. A body block is a
  // `style/style-in-body` error, and reading tokens out of it would let a broken file
  // resolve `var(--x)` as if it were fine.
  const text = [
    "<!doctype html>",
    '<html><head><meta name="design-schema" content="3.0"><style>section[data-type="page"]{margin:0}</style></head>',
    '<body><style>:root{ --color-bg:#f5f5f7 }</style>',
    '<section data-id="home" data-type="page" style="width:390px;height:844px"></section>',
    "</body></html>",
  ].join("\n");
  assert.equal(collectTokens(docOf(text)).tokens.size, 0);
  assert.ok(codesOf(text).includes("style/style-in-body"));
});

test("a name declared in two style blocks is a conflict, not a last-one-wins", () => {
  const text = [
    "<!doctype html>",
    '<html><head><meta name="design-schema" content="3.0">',
    "<style>:root{ --color-bg:#f5f5f7 }</style>",
    "<style>:root{ --color-bg:#000000 }</style>",
    "</head><body>",
    '<section data-id="home" data-type="page" style="width:390px;height:844px"></section>',
    "</body></html>",
  ].join("\n");
  const { sites, duplicates } = tokenSites(docOf(text));
  assert.equal(sites.size, 1);
  assert.deepEqual(duplicates.map((d) => d.name), ["--color-bg"]);
  // The first declaration wins the slot; both offsets are reported so a caller can name
  // both. §4.1 forbids the later block overwriting the earlier one, so choosing is not
  // this layer's to do.
  assert.equal(duplicates[0].offsets.length, 2);

  const warnings = validateDesign(docOf(text)).filter((d) => d.code === "style/duplicate-token");
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0].message + warnings[0].hint, /last one wins/i);
});

/* ------------------------------------------------------------------ *
 * References and cycles
 * ------------------------------------------------------------------ */

test("a value names every token it references, fallbacks included", () => {
  assert.deepEqual(tokenReferenceNames("#ffffff"), []);
  assert.deepEqual(tokenReferenceNames("var(--color-ink)"), ["--color-ink"]);
  assert.deepEqual(tokenReferenceNames("var( --space-md , 8px )"), ["--space-md"]);
  assert.deepEqual(tokenReferenceNames("var(--a, var(--b))"), ["--a", "--b"]);
});

/**
 * A cycle used to be invisible to `validate` and fatal to `export`.
 *
 * Measured before the fix, on a file with `--color-accent:var(--color-ink)` and
 * `--color-ink:var(--color-accent)` referenced by one element:
 *
 *     design validate t.html                  → 0 errors, 0 warnings — valid
 *     design export t.html --resolve-tokens   → REFUSED  Maximum call stack size exceeded
 *
 * `plan.md` §4.2 already promised "循环被拒绝", so the contract was right and the code
 * was wrong. Both halves are held here: the validator reports it, and the resolver
 * refuses to follow it even when nobody validated first.
 */
test("a cycle is an error, and it names the tokens in it", () => {
  const text = file(" --color-accent:var(--color-ink); --color-ink:var(--color-accent) ");
  const found = validateDesign(docOf(text)).find((d) => d.code === "style/token-cycle");
  assert.ok(found, "a token cycle must be an error");
  assert.equal(found.severity, "error");
  assert.match(found.message, /--color-accent/);
  assert.match(found.message, /--color-ink/);
  assert.ok(Number.isInteger(found.offset));
});

test("a token that references itself is a cycle of one", () => {
  const found = validateDesign(docOf(file(" --color-bg:var(--color-bg) ")))
    .find((d) => d.code === "style/token-cycle");
  assert.ok(found);
  assert.match(found.message, /references itself/);
});

test("a long chain is not a cycle, however long it is", () => {
  const chain = Array.from({ length: 40 }, (_, i) => `--space-s${i}:var(--space-s${i + 1})`);
  chain.push("--space-s40:1px");
  assert.deepEqual(codesOf(file(` ${chain.join("; ")} `)).filter((c) => c === "style/token-cycle"), []);
});

test("two tokens that reference each other are one cycle, not two", () => {
  const { sites } = tokenSites(docOf(file(" --a-one:var(--b-two); --b-two:var(--a-one) ")));
  assert.equal(findTokenCycles(sites).length, 1);
});

test("a reference to a token that does not exist is not a cycle", () => {
  assert.deepEqual(codesOf(file(" --color-accent:var(--color-nope) ")).filter((c) => c === "style/token-cycle"), []);
});

/**
 * The other half of the same defect. `export` reads a file that has errors — it has to,
 * because a refusal there would mean nobody could see what was wrong with it — so the
 * resolver cannot assume a validator ran. A cycle must come out as the literal
 * `var(--x)`, not as a stack overflow.
 */
test("resolving a cyclic token leaves it as written instead of recursing", () => {
  const tokens = new Map([
    ["--color-accent", { name: "--color-accent", value: "var(--color-ink)" }],
    ["--color-ink", { name: "--color-ink", value: "var(--color-accent)" }],
  ]);
  assert.equal(resolveTokens("var(--color-accent)", tokens), "var(--color-accent)");
  assert.equal(resolveTokens("var(--color-ink)", tokens), "var(--color-ink)");
  // A declared fallback is not applied to a cycle member. CSS would call the cyclic
  // value "guaranteed-invalid" and use the fallback; working that out means following
  // the cycle far enough to classify every member of it. The resolver's job here is
  // only to not die on a file nobody validated, and validation refuses a cycle, so the
  // reference is left standing. Pinned because it is a choice, not an accident.
  assert.equal(resolveTokens("var(--color-accent, #ff0000)", tokens), "var(--color-accent)");

  // And the same file through the renderer the canvas and `export` both use.
  const text = file(
    " --color-accent:var(--color-ink); --color-ink:var(--color-accent) ",
    `<section data-id="home" data-type="page" style="width:390px;height:844px">`
      + '<p data-id="home__t" data-type="text" style="color:var(--color-accent)">x</p></section>',
  );
  const markup = renderModel(docOf(text), { resolveTokens: true }).pages[0].markup;
  assert.doesNotMatch(markup, /Maximum call stack/);
  assert.match(markup, /color:var\(--color-(accent|ink)\)/);
});

test("a chain deeper than the cap is left as written rather than followed forever", () => {
  assert.equal(TOKEN_MAX_DEPTH, 16);
  const tokens = new Map();
  for (let i = 0; i <= 40; i += 1) tokens.set(`--color-c${i}`, { value: i === 40 ? "#123456" : `var(--color-c${i + 1})` });
  const resolved = resolveTokens("var(--color-c0)", tokens);
  assert.match(resolved, /var\(--color-c\d+\)/, `the chain stopped at a literal: ${resolved}`);
  assert.doesNotMatch(resolved, /#123456/);

  // One below the cap still resolves, so the cap is a cap and not a wall.
  const short = new Map([["--color-a", { value: "var(--color-b)" }], ["--color-b", { value: "#123456" }]]);
  assert.equal(resolveTokens("var(--color-a)", short), "#123456");
});

/* ------------------------------------------------------------------ *
 * The groups themselves
 * ------------------------------------------------------------------ */

test("the seven groups are still seven and each is addressable", () => {
  assert.deepEqual(TOKEN_GROUPS, ["color", "font", "space", "radius", "size", "shadow", "border"]);
  for (const group of TOKEN_GROUPS) {
    assert.equal(resolveTokenName(`${group}.probe`), `--${group}-probe`);
    assert.equal(tokenNameProblem(`--${group}-probe`), null);
  }
});
