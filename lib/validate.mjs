/**
 * lib/validate.mjs — four layers.
 *
 *   syntax/     the parser already reported these; they are passed through
 *   style/      is every property in the table, is every value legal
 *   structure/  ids, types, tags, required attributes
 *   a11y/       image alt text
 *   asset/      image src
 *   component/  refs, overrides, cycles
 *   version/    the design-schema marker
 *   ops/        reported by lib/ops.mjs, passed through here
 *
 * `geometry/` is not in that list and has no codes: overflow, collapse and
 * clipping are not checked anywhere yet. `docs/format-v3.md` §6 says so.
 *
 * The rule that matters most in this file: every element is either valid or it
 * gets a diagnostic. An element is never ignored. Ignoring is how a design file
 * rots, because the canvas cannot render what the validator does not describe.
 *
 * Pure. No node: imports.
 */

import { walk, getAttr, hasAttr, pagesOf, dataAttrs, elementChildren, textOf, nodePath, parseDeclarations } from "./parse.mjs";
import {
  TYPE_TAGS, TAG_TO_TYPE, TYPE_HAS_CHILDREN, ATTR_BY_TYPE, COMMON_OPTIONAL,
  SHAPE_KINDS, ICON_LIBRARIES, ID_PATTERN, CSS_ALLOWED, CSS_ALIASES,
  REJECTED_PROPERTIES, ensureGenericFamily, normalizeValue,
  PAGE_PLACEMENT,
} from "./table.mjs";
import { BASE_RULES, hasBaseRules, missingBaseRules } from "./base-css.mjs";
import { ICON_VIEW_BOX } from "./icons.mjs";
import { suggest } from "./levenshtein.mjs";
import { diagnosticKey } from "./diagnostics.mjs";
import { findTokenCycles, tokenNameProblem, tokenSites } from "./tokens.mjs";

// The key lives in `lib/diagnostics.mjs` and is re-exported here because this is
// the module callers already load for it (`server.mjs` takes it through
// `loadExport("validate.mjs", [...])`). It used to be defined in both files, with
// two different field lists; see the note on the implementation.
export { diagnosticKey };

export const SCHEMA_VERSION = "3.0";
export const SCHEMA_META_NAME = "design-schema";

const DATA_TYPE_VALUES = Object.keys(TYPE_TAGS);

/**
 * The one required attribute that is not a wording problem.
 *
 * `docs/format-v3.md` §6 gives `a11y/` and `asset/` to this module — image alt
 * text and image `src` — and until now neither prefix was ever emitted: both
 * absences came out as `structure/missing-attribute`, so the contract named two
 * families of diagnostic that did not exist. `lib/table.mjs` owns the rule; this
 * is only where the rule gets its name.
 *
 * Everything else keeps the generic code: an `icon` with no `data-icon-library`
 * is a malformed element, not an accessibility finding.
 */
const REQUIRED_CODE = {
  "image:alt": "a11y/missing-alt",
  "image:src": "asset/missing-src",
};

function makeDiagnostic(severity, code, message, extra = {}) {
  const d = { severity, code, message };
  if (extra.target) d.target = extra.target;
  if (extra.path) d.path = extra.path;
  if (extra.offset !== undefined && extra.offset !== null) d.offset = extra.offset;
  if (extra.hint) d.hint = extra.hint;
  if (extra.fix) d.fix = extra.fix;
  return d;
}

export function errorKeys(diagnostics) {
  const keys = new Set();
  for (const d of diagnostics) {
    if (d.severity === "error") keys.add(diagnosticKey(d));
  }
  return keys;
}

/** Errors present in `after` that `before` did not already have. */
export function newErrors(before, after) {
  const known = errorKeys(before);
  return after.filter((d) => d.severity === "error" && !known.has(diagnosticKey(d)));
}

export function summarize(diagnostics) {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings, total: diagnostics.length };
}

// -- tokens -------------------------------------------------------------------

/** Every `--name: value` declaration in every token block, merged. */
export function collectTokens(doc) {
  const { sites, duplicates } = tokenSites(doc);
  return { tokens: sites, duplicates: duplicates.map((entry) => entry.name) };
}

// -- the validator ------------------------------------------------------------

/**
 * @param {object} doc parsed document
 * @param {object} options `{ strict, tokens }`
 * @returns {Array} diagnostics
 */
export function validateDesign(doc, options = {}) {
  const out = [];
  for (const d of doc.diagnostics || []) out.push(d);

  const strict = options.strict === true;
  const warn = (code, message, extra) => out.push(makeDiagnostic(strict ? "error" : "warning", code, message, extra));
  const error = (code, message, extra) => out.push(makeDiagnostic("error", code, message, extra));

  // -- version ----------------------------------------------------------------
  const meta = findMeta(doc, SCHEMA_META_NAME);
  if (!meta) {
    error("version/missing-marker",
      `The file has no <meta name="${SCHEMA_META_NAME}" content="${SCHEMA_VERSION}">.`,
      { hint: `Add <meta name="${SCHEMA_META_NAME}" content="${SCHEMA_VERSION}"> inside <head>.` });
  } else if (meta.value !== SCHEMA_VERSION) {
    error("version/unsupported",
      `The file says schema ${JSON.stringify(meta.value)}. This build reads ${SCHEMA_VERSION}.`,
      { offset: meta.offset, hint: `Run \`design migrate\` to move the file to ${SCHEMA_VERSION}.` });
  }

  // -- style blocks -----------------------------------------------------------
  const headStyleCount = (doc.styleBlocks || []).filter((b) => b.inHead).length;
  for (const block of doc.styleBlocks || []) {
    if (!block.inHead) {
      error("style/style-in-body",
        "A <style> element sits outside <head>.",
        { offset: block.node.start, hint: "Only two style blocks are read, and both live in <head>." });
      continue;
    }
    if (block.role === "unknown") {
      error("style/unsupported-block",
        "This <style> block is neither the token block nor the page-frame block.",
        {
          offset: block.node.start,
          hint: 'Allowed content: `:root{--name:value}` and `section[data-type="page"]{...}`.',
        });
    }
  }
  if (headStyleCount === 0) {
    warn("style/no-token-block",
      "The file has no token block, so it has no design tokens.",
      { hint: "Add <style>:root{--color-ink:#111827}</style> in <head>." });
  }

  // The base rules are what make a `width` mean the width of the box. Without
  // them a browser reads `width:375px;padding:0 24px` as 423px, and a `<p>`
  // brings a margin the file never asked for. Every renderer of this file — the
  // browser, the canvas, and `export` — reads the rules that are written down,
  // and none of them supplies a box model of its own.
  const styleText = (doc.styleBlocks || []).map((block) => block.text).join("\n");
  if (!hasBaseRules(styleText)) {
    warn("style/no-base-rules",
      "The file states no box model, so a browser reads every `width` as a content width and gives text tags a default margin.",
      {
        offset: (doc.styleBlocks || [])[0]?.node.start,
        hint: `Put \`${BASE_RULES[0]}\` and \`${BASE_RULES[1]}\` in front of the token block. \`design new\` and \`design import\` write them.`,
      });
  } else {
    // A file written before a rule existed keeps its box model and loses one
    // shape or one glyph — `data-kind="ellipse"` with nothing to round it draws
    // a square, and nothing about the page looks broken. So the missing rules
    // are named, because a silent difference is the one thing this format does
    // not allow.
    const missing = missingBaseRules(styleText);
    if (missing.length > 0) {
      warn("style/incomplete-base-rules",
        `The file states a box model but omits ${missing.length === 1 ? "one base rule" : `${missing.length} base rules`}: ${missing.join(" ")}`,
        {
          offset: (doc.styleBlocks || [])[0]?.node.start,
          hint: "Add them in front of the token block. `design new` and `design import` write the current set.",
        });
    }
  }

  const { tokens, duplicates } = collectTokens(doc);
  for (const name of new Set(duplicates)) {
    // Not "the last one wins", which is what this used to say and what §4.1 forbids:
    // both style blocks are collected, and the later block must not overwrite the
    // earlier one. A reader who is told the last declaration wins has been told to
    // edit the wrong one — and `tokens set` would have written to the first.
    const site = tokens.get(name);
    warn("style/duplicate-token", `The token ${name} is declared more than once.`, {
      offset: site.offset,
      hint: "A design has one token block. Keep one declaration per token.",
    });
  }
  for (const cycle of findTokenCycles(tokens)) {
    error("style/token-cycle",
      cycle.names.length === 1
        ? `The token ${cycle.names[0]} references itself.`
        : `The tokens ${cycle.names.join(" → ")} → ${cycle.names[0]} reference each other in a cycle.`,
      {
        offset: cycle.offsets[0],
        hint: "A token may reference a token, but the chain has to reach a value. Break the cycle.",
      });
  }
  for (const token of tokens.values()) {
    const problem = tokenNameProblem(token.name);
    if (problem !== null) {
      warn("style/token-name", problem.message, { offset: token.offset, hint: problem.hint });
    }
  }

  // -- pages ------------------------------------------------------------------
  const pages = pagesOf(doc);
  if (pages.length === 0) {
    error("structure/no-page",
      'The file has no page. A page is <section data-type="page">.',
      { hint: 'Add <section data-id="home" data-type="page" style="width:390px;height:844px"></section>.' });
  }

  const seenIds = new Map();
  const seenCanvas = new Map();

  walk(doc, (node) => {
    if (node.kind !== "element") return;
    const inSvg = insideSvg(node);
    checkElement(node, { doc, out, error, warn, tokens, seenIds, seenCanvas, pages, parseDeclarations, inSvg });
  });

  // -- page placement ---------------------------------------------------------
  for (const [key, entries] of seenCanvas) {
    if (entries.length < 2) continue;
    for (const entry of entries.slice(1)) {
      warn("structure/duplicate-canvas",
        `Two pages sit at the same canvas point ${key}.`,
        {
          target: entry.id || undefined, offset: entry.node.start,
          hint: "The canvas will draw one over the other. Move this page, or run `design format` to lay the pages out again.",
        });
    }
  }

  // -- instances --------------------------------------------------------------
  const components = new Map();
  walk(doc, (node) => {
    if (node.kind === "element" && getAttr(node, "data-type") === "component") {
      const id = getAttr(node, "data-id");
      if (id) components.set(id, node);
    }
  });

  walk(doc, (node) => {
    if (node.kind !== "element") return;
    if (getAttr(node, "data-type") !== "instance") return;
    const id = getAttr(node, "data-id");
    const ref = getAttr(node, "data-ref");
    if (!ref) return;
    if (!components.has(ref)) {
      const suggestion = suggest(ref, [...components.keys()]);
      error("component/unknown-ref",
        `This instance points at ${ref}, and no component has that id.`,
        {
          target: id, offset: node.start,
          hint: suggestion ? `Did you mean ${suggestion}?` : `Known components: ${[...components.keys()].join(", ") || "none"}.`,
        });
      return;
    }
    const overrides = getAttr(node, "data-overrides");
    if (overrides === null) return;
    let parsed;
    try {
      parsed = JSON.parse(overrides);
    } catch (e) {
      error("component/bad-overrides", `data-overrides is not JSON: ${e.message}`, { target: id, offset: node.start, hint: 'Such as {"card__title":{"content":"Hi"}}' });
      return;
    }
    const component = components.get(ref);
    const descendants = new Map();
    for (const child of allDescendants(component)) {
      const childId = getAttr(child, "data-id");
      if (childId) descendants.set(childId, child);
    }
    const descendantIds = new Set(descendants.keys());
    for (const key of Object.keys(parsed)) {
      if (!descendantIds.has(key)) {
        const suggestion = suggest(key, [...descendantIds]);
        error("component/unknown-override-target",
          `${key} is not a descendant id of the component ${ref}.`,
          {
            target: id, offset: node.start,
            hint: suggestion ? `Did you mean ${suggestion}?` : `Descendants: ${[...descendantIds].join(", ") || "none"}.`,
          });
      }
    }
    // Text inside an `<svg>` that is not inside a `<text>` draws nothing, so a
    // `content` patch on a glyph is a silent erase: the icon is still in the
    // file and the mount is blank. A glyph is geometry here — `children`
    // replaces it.
    for (const [key, fields] of Object.entries(parsed)) {
      const target = descendants.get(key);
      if (!target || target.tag !== "svg") continue;
      if (!fields || typeof fields !== "object" || !("content" in fields)) continue;
      error("component/text-override-on-icon",
        `A content override on ${key} writes text into an <svg>, and nothing draws it.`,
        { target: id, offset: node.start, hint: `Send "children" with the glyph's geometry, or set data-icon on the component.` });
    }
  });

  // -- component cycles ------------------------------------------------------
  for (const cycle of componentCycles(doc)) {
    error("component/cycle",
      `These components reference each other in a loop: ${cycle.join(" -> ")}.`,
      { hint: "Break the loop by removing one data-ref." });
  }

  out.sort(bySeverityThenOffset);
  return out;
}

function bySeverityThenOffset(a, b) {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  const ao = a.offset ?? Number.MAX_SAFE_INTEGER;
  const bo = b.offset ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function findMeta(doc, name) {
  let found = null;
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.kind !== "element") continue;
      if (child.tag === "meta" && (getAttr(child, "name") || "") === name) {
        if (!found) found = { value: getAttr(child, "content"), offset: child.start, node: child };
      }
      if (child.tag !== "body") visit(child);
    }
  };
  visit(doc);
  return found;
}

function allDescendants(node, out = []) {
  for (const child of node.children || []) {
    if (child.kind !== "element") continue;
    out.push(child);
    allDescendants(child, out);
  }
  return out;
}

/**
 * The document skeleton is not part of the design layer, but it is still
 * checked. Without this list a valid file would report <html> and <head> as
 * unsupported tags, which is the loudest possible way to be wrong.
 */
export const SKELETON_TAGS = new Set(["html", "head", "body", "title", "meta", "link", "style", "script", "base"]);

/** An `<svg>` draws its own geometry. Those children are not design elements. */
export function insideSvg(node) {
  let current = node.parent;
  while (current) {
    if (current.kind === "element" && current.tag === "svg") return true;
    current = current.parent;
  }
  return false;
}

function checkElement(node, ctx) {
  const { out, error, warn, tokens, seenIds, seenCanvas, pages } = ctx;
  const id = getAttr(node, "data-id");
  const type = getAttr(node, "data-type");
  const path = nodePath(node);

  // The parser reports its own syntax problems. An element we cannot model is
  // still in the tree, and it is still an error: silently keeping it would let
  // a write delete it later.
  if (SKELETON_TAGS.has(node.tag) && !type) return;

  // Inside `<svg>` is the opaque layer: `<path>`, `<circle>`, `<title>` and the
  // rest of the geometry. It stays in the tree byte for byte, and the design
  // layer does not claim it. A glyph is validated through its `<svg>`.
  if (ctx.inSvg) {
    if (getAttr(node, "data-id") || getAttr(node, "data-type")) {
      error("structure-id-inside-icon",
        `<${node.tag}> is inside an <svg>, so it is drawing geometry, not a design element.`,
        {
          target: getAttr(node, "data-id") || undefined,
          offset: node.start,
          hint: 'Remove data-id and data-type. Address the icon through its <svg data-type="icon"> element.',
        });
    }
    return;
  }

  if (!TAG_TO_TYPE[node.tag]) {
    error("structure/unsupported-tag",
      `<${node.tag}> is not part of the format.`,
      {
        target: id || undefined,
        path,
        offset: node.start,
        hint: `Allowed tags: ${[...new Set(Object.values(TYPE_TAGS).flat())].join(", ")}.`,
      });
    return;
  }

  if (!id) {
    error("structure/missing-id",
      `<${node.tag}> has no data-id.`,
      {
        path,
        offset: node.start,
        hint: `Every element is addressable. A page-named id such as home__${node.tag === "p" ? "title" : "box"} is the convention.`,
      });
  } else if (!ID_PATTERN.test(id)) {
    error("structure/bad-id",
      `The id ${JSON.stringify(id)} is not a legal id.`,
      {
        target: id, path, offset: node.start,
        hint: "Start with a letter or _, then letters, digits, _ and - only. 64 characters at most.",
      });
  } else if (seenIds.has(id)) {
    const keeper = seenIds.get(id);
    // A duplicate is a collision, not a typo. The useful hint is a name that is
    // free, so the author can copy it instead of inventing one.
    const free = firstFreeId(id, seenIds);
    error("structure/duplicate-id",
      `The id ${id} is already used at offset ${keeper.node.start}.`,
      {
        target: id,
        offset: node.start,
        hint: `Rename this one to ${free}, or rename the other. Ids are unique across the whole file, including every page and every component.`,
      });
  } else {
    seenIds.set(id, { node });
  }

  if (!type) {
    error("structure/missing-type",
      `<${node.tag}> has no data-type.`,
      {
        target: id || undefined, path, offset: node.start,
        hint: `Choose one of: ${DATA_TYPE_VALUES.join(", ")}. <${node.tag}> defaults to ${TAG_TO_TYPE[node.tag]}.`,
      });
    return;
  }

  if (!DATA_TYPE_VALUES.includes(type)) {
    const suggestion = suggest(type, DATA_TYPE_VALUES);
    error("structure/unknown-type",
      `${type} is not an element type.`,
      {
        target: id || undefined, path, offset: node.start,
        hint: suggestion ? `Did you mean ${suggestion}? Valid: ${DATA_TYPE_VALUES.join(", ")}.` : `Valid: ${DATA_TYPE_VALUES.join(", ")}.`,
      });
    return;
  }

  const allowedTags = TYPE_TAGS[type];
  if (!allowedTags.includes(node.tag)) {
    error("structure/type-tag-mismatch",
      `data-type="${type}" needs one of ${allowedTags.join(", ")}, and this element is <${node.tag}>.`,
      {
        target: id || undefined, path, offset: node.start,
        hint: `<${node.tag}> carries data-type="${TAG_TO_TYPE[node.tag]}".`,
      });
    return;
  }

  // Children are only allowed on some types.
  const childElements = elementChildren(node);
  const text = textOf(node);
  if (type === "icon" && childElements.length === 0 && !hasAttr(node, "data-hidden")) {
    warn("structure/empty-icon",
      "This icon has no geometry, so it renders as nothing.",
      {
        target: id || undefined, path, offset: node.start,
        hint: "Put the glyph's <path> or <circle> elements inside the <svg>.",
      });
  }
  if (!TYPE_HAS_CHILDREN.has(type) && type !== "icon" && childElements.length) {
    error("structure/children-not-allowed",
      `data-type="${type}" cannot contain elements, and this one contains ${childElements.map((c) => `<${c.tag}>`).join(", ")}.`,
      {
        target: id || undefined, path, offset: node.start,
        hint: type === "text"
          ? "A text element holds one run of text. Wrap the parts in a frame, or use <span> for inline emphasis."
          : `Wrap the content in a frame, then place the ${type} beside it.`,
      });
  }
  if (type === "text" && childElements.length === 0 && text.trim() === "" && !hasAttr(node, "data-hidden")) {
    warn("structure/empty-text", "This text element has no text.", { target: id || undefined, path, offset: node.start, hint: "Add text, or set data-hidden=\"true\"." });
  }

  // Required and optional attributes.
  const contract = ATTR_BY_TYPE[type] || { required: [], optional: [] };
  for (const name of contract.required) {
    const value = getAttr(node, name);
    if (value === null || value === "") {
      error(REQUIRED_CODE[`${type}:${name}`] ?? "structure/missing-attribute",
        `data-type="${type}" requires ${name}.`,
        { target: id || undefined, path, offset: node.start, hint: requiredHint(type, name) });
    }
  }

  const allowedData = new Set([...COMMON_OPTIONAL, ...contract.required, ...contract.optional]);
  for (const attr of dataAttrs(node)) {
    if (attr.name === "data-id" || attr.name === "data-type") continue;
    if (allowedData.has(attr.name)) continue;
    const suggestion = suggest(attr.name, [...allowedData]);
    error("structure/unknown-attribute",
      `${attr.name} is not an attribute of data-type="${type}".`,
      {
        target: id || undefined, path, offset: attr.start,
        hint: suggestion ? `Did you mean ${suggestion}?` : `Allowed: ${[...allowedData].join(", ")}.`,
      });
  }

  if (type === "shape") {
    const kind = getAttr(node, "data-kind");
    if (kind && !SHAPE_KINDS.includes(kind)) {
      const suggestion = suggest(kind, SHAPE_KINDS);
      error("structure/bad-shape-kind",
        `${kind} is not a shape kind.`,
        { target: id || undefined, offset: node.start, hint: suggestion ? `Did you mean ${suggestion}?` : `Valid: ${SHAPE_KINDS.join(", ")}.` });
    }
    // `data-kind="ellipse"` is a claim about shape, and a `div` is a rectangle
    // until something rounds it. The declaration has to be in the node's own
    // style: a `[data-kind="ellipse"]` rule in the head would round it in the
    // file and stop matching in the deliverable, where `export` drops the design
    // attributes — a circle that ships as a square.
    if (kind === "ellipse" && !roundsItself(node)) {
      warn("style/ellipse-without-radius",
        "This node declares data-kind=\"ellipse\" and nothing rounds it, so it draws as a rectangle.",
        {
          target: id || undefined,
          offset: node.start,
          hint: "Add `border-radius:50%` to the element's style. `%` measures against both axes, so a 60×20 node is an ellipse and not a pill.",
        });
    }
  }

  if (type === "icon") {
    const library = getAttr(node, "data-icon-library");
    if (library && !ICON_LIBRARIES.includes(library)) {
      error("structure/unknown-icon-library",
        `${library} is not a known icon library.`,
        { target: id || undefined, offset: node.start, hint: `Known: ${ICON_LIBRARIES.join(", ")}.` });
    }
    const glyph = getAttr(node, "data-icon");
    if (glyph && !/^[a-z0-9-]{1,40}$/.test(glyph)) {
      error("structure/bad-icon-name",
        `${JSON.stringify(glyph)} is not a glyph name.`,
        { target: id || undefined, offset: node.start, hint: "Lower case letters, digits and hyphens, such as shield-check." });
    }
    // Geometry without a grid is not scaled, it is clipped: a 24×24 glyph in a
    // 15×15 element shows its top-left corner and nothing else. That is how
    // `target`'s three rings became one arc.
    if (childElements.length && !hasAttr(node, "viewBox")) {
      error("structure/icon-without-viewbox",
        "This icon has geometry but no viewBox, so the browser clips it instead of scaling it.",
        {
          target: id || undefined,
          offset: node.start,
          hint: `Declare the grid the geometry was drawn on: viewBox="${ICON_VIEW_BOX}".`,
        });
    }
  }

  if (type === "page") {
    const canvas = getAttr(node, "data-canvas");
    if (canvas !== null) {
      const parsed = parseCanvasPosition(canvas);
      if (!parsed) {
        error("structure/bad-canvas",
          `data-canvas must be "x,y", and this one is ${JSON.stringify(canvas)}.`,
          { target: id || undefined, offset: node.start, hint: 'Such as data-canvas="0,920".' });
      } else {
        const key = `${parsed.x},${parsed.y}`;
        if (!seenCanvas.has(key)) seenCanvas.set(key, []);
        seenCanvas.get(key).push({ node, id });
      }
    }
    // A page's place on the canvas is `data-canvas`. A canvas drag once wrote
    // that place as CSS on the page as well, and the two spellings then
    // disagree: the canvas positions a page from `data-canvas` and shows one
    // thing, while `export` drops the CSS and would have shipped another. The
    // export drops it either way, so this is a warning about a stale spelling,
    // not a broken deliverable.
    const placement = parseDeclarations(getAttr(node, "style") ?? "")
      .map((d) => d.property)
      .filter((property) => PAGE_PLACEMENT.has(property));
    if (placement.length > 0) {
      warn("structure/page-position",
        `This page states its own placement in style: ${placement.join(", ")}. The canvas places a page with data-canvas.`,
        {
          target: id || undefined, offset: node.start,
          hint: canvas === null ? "Remove those declarations, or move the page with data-canvas." : `Remove those declarations. This page is at data-canvas="${canvas}".`,
        });
    }
    if (type === "page" && node.tag !== "section") return;
  }

  // -- style -------------------------------------------------------------------
  const styleAttr = node.attrs.find((a) => a.name === "style");
  if (!styleAttr) {
    if (node.tag !== "svg" && !TYPE_HAS_CHILDREN.has(type) && type !== "instance") {
      warn("style/no-style",
        `<${node.tag}> has no style attribute, so it renders with browser defaults.`,
        { target: id || undefined, path, offset: node.start, hint: "Add the properties this element actually needs." });
    }
    return;
  }

  if (!styleAttr.value || styleAttr.value.trim() === "") {
    warn("style/empty-style", "The style attribute is empty.", { target: id || undefined, offset: styleAttr.start, hint: "Remove the attribute, or put a declaration in it." });
    return;
  }

  checkStyle(node, styleAttr, { ...ctx, tokens, path, id });
}

/**
 * True when this element's own style rounds it.
 *
 * Only the element's own `style` counts. `data-kind` is a design attribute, so
 * `export` strips it: a `[data-kind="ellipse"]` rule in the head rounds the node
 * in the file and leaves it square in the deliverable.
 */
function roundsItself(node) {
  const styleAttr = node.attrs?.find((a) => a.name === "style");
  if (!styleAttr || !styleAttr.value) return false;
  return parseDeclarations(styleAttr.value).some((d) => d.property === "border-radius");
}

function requiredHint(type, name) {
  if (type === "image" && name === "alt") return 'Write alt="" for a decorative image. A missing alt is not the same as an empty one.';
  if (type === "image" && name === "src") return 'Such as src="hero.png".';
  if (type === "icon" && name === "data-icon") return 'Such as data-icon="shield-check".';
  if (type === "icon" && name === "data-icon-library") return 'Such as data-icon-library="lucide".';
  if (type === "instance") return "Such as data-ref=\"card\", where card is the data-id of a component.";
  return "See docs/format-v3.md section 3.";
}

/** The first `id-2`, `id-3`, … that nothing else uses. */
export function firstFreeId(id, taken) {
  const base = id.replace(/-\d+$/, "");
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-copy`;
}

/**
 * The shorthand for a one-sided box property, with the value that was written.
 * Returns null for anything that is not a box side.
 */
export function shorthandHint(property, value) {
  const side = /^(margin|padding|border)-(top|right|bottom|left)$/.exec(property);
  if (!side) return null;
  const [, base, where] = side;
  if (base === "border") return null;
  const parts = ["0", "0", "0", "0"];
  parts[["top", "right", "bottom", "left"].indexOf(where)] = String(value).trim();
  return `Write the shorthand: ${base}: ${parts.join(" ").replace(/ 0 0 0$/, " 0 0 0")}.`;
}

export function parseCanvasPosition(value) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(value));
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * Style rules. Every declaration is either accepted or reported.
 * Nothing is dropped here: a declaration that cannot be accepted becomes a
 * diagnostic, because a silently dropped property is a property the canvas
 * would then not render either, and the author would never find out.
 */
function checkStyle(node, styleAttr, ctx) {
  const { error, warn, tokens, path, id } = ctx;
  const declarations = (ctx.parseDeclarations || parseDeclarations)(styleAttr.value);

  const base = styleAttr.valueStart;
  for (const decl of declarations) {
    const offset = base + decl.textStart;
    const property = decl.property;
    if (property === "") {
      error("style/no-property",
        "A declaration has no property name.",
        { target: id || undefined, path, offset, hint: `Write name:value, such as color:#111827. Got ${JSON.stringify(decl.rawValue.trim().slice(0, 40))}.` });
      continue;
    }
    if (property.startsWith("--")) continue;

    const rejected = REJECTED_PROPERTIES[property];
    if (rejected) {
      // A one-sided margin is refused in favour of the shorthand, and the hint
      // has to name the shorthand FOR THIS VALUE. A fixed string would tell the
      // author to write `margin: 8px 0 0 0` for a 16px offset.
      error("style/rejected-property",
        rejected.reason,
        {
          target: id || undefined, path, offset,
          hint: shorthandHint(property, decl.value) ?? (rejected.replacement ? `Use ${rejected.replacement} instead.` : "Remove it."),
        });
      continue;
    }
    if (CSS_ALIASES[property]) {
      warn("style/aliased-property",
        `${property} is written as ${CSS_ALIASES[property]}.`,
        { target: id || undefined, path, offset, hint: `Write ${CSS_ALIASES[property]}:${decl.value} directly.` });
      continue;
    }
    if (!CSS_ALLOWED[property]) {
      const suggestion = suggest(property, Object.keys(CSS_ALLOWED));
      error("style/unknown-property",
        `${property} is not in the format.`,
        {
          target: id || undefined, path, offset,
          hint: suggestion ? `Did you mean ${suggestion}?` : "See references/styling.md for the full list.",
        });
      continue;
    }

    try {
      normalizeValue(property, decl.value);
    } catch (e) {
      error("style/bad-value",
        `${property}:${decl.value} — ${e.message}`,
        { target: id || undefined, path, offset, hint: e.hint });
      continue;
    }

    if (decl.value.includes("var(")) {
      for (const match of decl.value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        const name = match[1];
        if (tokens.size && !tokens.has(name)) {
          const suggestion = suggest(name, [...tokens.keys()]);
          warn("style/unknown-token",
            `${name} is not declared in the token block.`,
            {
              target: id || undefined, path, offset,
              hint: suggestion ? `Did you mean ${suggestion}?` : `Declared tokens: ${[...tokens.keys()].join(", ") || "none"}.`,
            });
        }
      }
    }

    // A family list with no generic family at the end has no defined fallback.
    // When the webfont does not arrive — offline, behind a proxy, on a build
    // machine — the browser uses the DOCUMENT default, which is a serif face on
    // most engines, and the design stops looking like the design.
    if (property === "font-family" && !decl.value.includes("var(") && ensureGenericFamily(decl.value) !== decl.value) {
      warn("style/no-generic-family",
        `${decl.value} ends in a family the machine may not have, so the fallback is the document default.`,
        {
          target: id || undefined, path, offset,
          hint: `Write ${ensureGenericFamily(decl.value)}.`,
        });
    }
  }
}

/** Components that reference each other in a loop. */
export function componentCycles(doc) {
  const components = new Map();
  walk(doc, (node) => {
    if (node.kind !== "element") return;
    if (getAttr(node, "data-type") !== "component") return;
    const id = getAttr(node, "data-id");
    if (id) components.set(id, node);
  });

  const edges = new Map();
  for (const [id, node] of components) {
    const refs = [];
    for (const child of allDescendants(node)) {
      if (getAttr(child, "data-type") === "instance") {
        const ref = getAttr(child, "data-ref");
        if (ref) refs.push(ref);
      }
    }
    edges.set(id, refs);
  }

  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    const colour = state.get(id);
    if (colour === "done") return;
    if (colour === "open") {
      const at = stack.indexOf(id);
      if (at !== -1) cycles.push([...stack.slice(at), id]);
      return;
    }
    state.set(id, "open");
    stack.push(id);
    for (const next of edges.get(id) || []) {
      if (components.has(next)) visit(next);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of components.keys()) visit(id);
  return cycles;
}
