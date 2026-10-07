/**
 * lib/fragment.mjs — the modifier. A model sends an HTML snippet; this turns it into
 * one op, or refuses it with a reason.
 *
 * PURE ESM. No `node:` imports, no DOM, no dependencies beyond `lib/`.
 *
 * ## What "compile" means here
 *
 * The snippet is not trusted and not written as it arrives. It is parsed, its
 * structure is checked against the element contract, its attributes are filtered
 * through the format table, every value is normalized, and only then is it written
 * back out as the `html` of one `insert` op. Anything the table does not accept is
 * reported — in `dropped`, or as a refusal. Nothing is discarded in silence.
 *
 * ## Where the rules come from (docs/format-v3.md)
 *
 *   §3  the element contract: which tag may carry which `data-type`
 *   §7  the format table in `lib/table.mjs` — the single source of truth
 *   §8  the semantic normalization of values
 *
 * ## Assumptions where docs/format-v3.md is silent
 *
 * F1. An out-of-table *property* is dropped and reported (`cursor`, `margin`, …).
 *     An allowed property with a value the table cannot read *refuses* the whole
 *     fragment: dropping it would throw away intent, and writing it would produce a
 *     file the validator rejects. A table reason is printed as the drop reason,
 *     because that is how the model learns what to write instead.
 *   F2. An allowed attribute is `data-id`, `data-type`, any of `COMMON_OPTIONAL`, or
 *     one listed for the type in `ATTR_BY_TYPE`. Every other attribute — `class`,
 *     `id`, `onclick`, `width` — is dropped and reported.
 *   F3. A missing `data-id` is filled in as `<page>__<name-or-tag>`; a `data-name`
 *     that cannot be an id (Chinese, spaces, a leading digit) falls back to the tag.
 *     A missing `data-type` is always refused: it is the one attribute that says what
 *     the element *is*, and guessing a type is how a `<div>` becomes a `frame` when
 *     the author meant a `shape`.
 *   F4. A collision is refused, including one the auto-filled id creates. Inventing a
 *     suffix would rename the model's element behind its back. The refusal carries the
 *     nearest existing ids.
 *   F5. `options.as` fills in the root's missing id. If the root already carries a
 *     different id, that disagreement is refused rather than silently resolved.
 *   F6. `options.in` names the parent. Without it, a `page` snippet lands in `<body>`
 *     and anything else lands in the resolved page. `options.index` defaults to the
 *     end of the parent's children.
 *   F7. An address that names nothing is `ops/node-not-found`, the same code the op
 *     engine uses, so a caller can treat "no such parent" once.
 *   F8. Missing required attributes (`src`, `alt`, `data-kind`, …) are *not* refused
 *     here. §6 gives those findings to `lib/validate.mjs`, which sees the written file
 *     anyway; reporting them twice would double every `<img>`.
 *   F9. Values are normalized by `normalizeValue` from `lib/table.mjs` — one
 *     implementation for the compiler, the validator and the normalizer, as §7
 *     requires. The compiler never rewrites a value the table cannot read; it refuses
 *     (F1) and prints the table's own hint.
 */

import {
  RESERVED_CONTAINERS,
  VOID_TAGS,
  buildIdIndex,
  escapeAttrValue,
  escapeTextValue,
  parseFragmentHtml,
  parseStyleDeclarations,
} from "./ops.mjs";
import {
  ATTR_BY_TYPE,
  COMMON_OPTIONAL,
  CSS_ALIASES,
  ID_PATTERN,
  REJECTED_PROPERTIES,
  TAG_TO_TYPE,
  TYPE_HAS_CHILDREN,
  TYPE_TAGS,
  TableError,
  normalizeValue,
  specFor,
} from "./table.mjs";
import { distance } from "./levenshtein.mjs";

const ID_MAX = 64;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isElement(node) {
  return isObject(node) && (node.kind === "element" || typeof node.tag === "string");
}

function attrOf(node, name) {
  const wanted = String(name).toLowerCase();
  for (const attr of Array.isArray(node.attrs) ? node.attrs : []) {
    if (attr && typeof attr.name === "string" && attr.name.toLowerCase() === wanted) return attr;
  }
  return null;
}

function attrValueOf(node, name) {
  const attr = attrOf(node, name);
  return attr === null ? null : String(attr.value ?? "");
}

function dataIdOf(node) {
  const value = attrValueOf(node, "data-id");
  return value === null || value === "" ? null : value;
}

function dataTypeOf(node) {
  const value = attrValueOf(node, "data-type");
  return value === null || value === "" ? null : value;
}

/** Thrown by the walker, caught once by `compileFragment`. */
class Refusal extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "Refusal";
    this.code = code;
    this.hint = extra.hint ?? null;
    this.suggestion = extra.suggestion ?? null;
    this.target = extra.target ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * Reading the document
 * ------------------------------------------------------------------ */

function rootsOf(doc) {
  const found = [];
  const push = (value) => {
    if (isObject(value) && !found.includes(value)) found.push(value);
  };
  if (Array.isArray(doc.children)) for (const child of doc.children) push(child);
  for (const key of ["html", "head", "body"]) push(doc[key]);
  return found;
}

/** Every element in document order, with the elements above it. */
function walkElements(doc) {
  const out = [];
  const visit = (node, ancestry) => {
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (!isElement(child)) continue;
      out.push({ node: child, ancestry });
      visit(child, ancestry.concat([child]));
    }
  };
  for (const root of rootsOf(doc)) {
    out.push({ node: root, ancestry: [] });
    visit(root, [root]);
  }
  return out;
}

/** Pages in document order. */
export function pagesOf(doc) {
  const pages = [];
  for (const entry of walkElements(doc)) {
    if (dataTypeOf(entry.node) === "page" && dataIdOf(entry.node) !== null) pages.push(entry.node);
  }
  return pages;
}

/** A data-id, or one of the four reserved container words. */
function findNode(doc, address) {
  if (typeof address !== "string" || address === "") return null;
  for (const entry of walkElements(doc)) {
    if (dataIdOf(entry.node) === address) return entry.node;
  }
  if (!RESERVED_CONTAINERS.includes(address)) return null;
  if (address === "document") return doc;
  const slot = address === "html" ? doc.html : address === "head" ? doc.head : doc.body;
  if (isObject(slot)) return slot;
  for (const entry of walkElements(doc)) if (entry.node.tag === address) return entry.node;
  return null;
}

/** The innermost page above an element, or the element itself. */
function pageOfElement(doc, node) {
  for (const entry of walkElements(doc)) {
    if (entry.node !== node) continue;
    for (let i = entry.ancestry.length - 1; i >= 0; i -= 1) {
      if (dataTypeOf(entry.ancestry[i]) === "page") return entry.ancestry[i];
    }
    return dataTypeOf(node) === "page" ? node : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

/** The first run of id characters in a display name, or null. */
function nameToken(value) {
  if (typeof value !== "string") return null;
  const match = /[A-Za-z_][A-Za-z0-9_-]*/.exec(value);
  return match === null ? null : match[0];
}

function autoId(page, element) {
  const prefix = nameToken(page === null ? null : dataIdOf(page)) ?? "page";
  const token = nameToken(attrValueOf(element, "data-name")) ?? element.tag;
  let id = `${prefix}__${token}`;
  if (id.length > ID_MAX) id = id.slice(0, ID_MAX);
  return ID_PATTERN.test(id) ? id : null;
}

/**
 * The nearest ids in an index to `id`, closest first.
 *
 * `index` is whatever holds the ids: the `Map` from `buildIdIndex`, an array, a
 * `Set`, or an object used as a set. Ties break alphabetically so the suggestion is
 * the same on every run.
 */
export function nearestIds(index, id, limit = 3) {
  const candidates = [];
  if (index instanceof Map) candidates.push(...index.keys());
  else if (index instanceof Set) candidates.push(...index);
  else if (Array.isArray(index)) candidates.push(...index);
  else if (isObject(index)) candidates.push(...Object.keys(index));
  const target = String(id ?? "");
  return candidates
    .map((candidate) => ({ candidate: String(candidate), score: distance(target, String(candidate)) }))
    .sort((a, b) => a.score - b.score || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.candidate);
}

/* ------------------------------------------------------------------ *
 * Writing the fragment back
 * ------------------------------------------------------------------ */

/**
 * Serialize nodes as HTML.
 *
 * Only what this module produces is ever read back by `parseFragmentHtml`, so the
 * escaper covers exactly the entities that parser decodes. Attribute order is the
 * order the compiler chose — `data-id`, `data-type`, the rest as written, `style`
 * last — which is also the order §8 normalizes to.
 */
export function writeFragment(nodes) {
  const out = [];
  const write = (list) => {
    for (const node of Array.isArray(list) ? list : []) {
      if (!isObject(node)) continue;
      if (node.kind === "text") {
        out.push(escapeTextValue(node.value ?? node.raw ?? ""));
        continue;
      }
      if (node.kind === "comment") {
        out.push(typeof node.raw === "string" ? node.raw : `<!--${node.value ?? ""}-->`);
        continue;
      }
      if (node.kind === "doctype") {
        out.push(typeof node.raw === "string" ? node.raw : "<!doctype html>");
        continue;
      }
      if (!isElement(node)) {
        if (typeof node.raw === "string") out.push(node.raw);
        continue;
      }
      const attrs = (Array.isArray(node.attrs) ? node.attrs : [])
        .map((attr) => ` ${attr.name}="${escapeAttrValue(attr.value)}"`)
        .join("");
      out.push(`<${node.tag}${attrs}>`);
      if (!VOID_TAGS.has(node.tag)) {
        write(node.children);
        out.push(`</${node.tag}>`);
      }
    }
  };
  write(nodes);
  return out.join("");
}

/* ------------------------------------------------------------------ *
 * Attributes and declarations
 * ------------------------------------------------------------------ */

function isAllowedAttr(type, name) {
  if (COMMON_OPTIONAL.includes(name)) return true;
  const spec = ATTR_BY_TYPE[type];
  if (!spec) return false;
  return (spec.required ?? []).includes(name) || (spec.optional ?? []).includes(name);
}

/**
 * Filter, normalize and rewrite one `style` attribute.
 *
 * @returns {string} the rebuilt attribute text — empty when nothing survived
 * @throws {Refusal} when a value of an allowed property cannot be read (F1)
 */
function compileStyle(value, target, result) {
  const kept = [];
  for (const declaration of parseStyleDeclarations(String(value ?? ""))) {
    const written = declaration.property.toLowerCase();
    if (written === "") continue;

    let property = written;
    let alias = null;
    if (!Object.prototype.hasOwnProperty.call(REJECTED_PROPERTIES, written) && specFor(written) === null) {
      const renamed = CSS_ALIASES[written];
      if (typeof renamed === "string" && specFor(renamed) !== null) {
        alias = written;
        property = renamed;
      }
    }

    if (Object.prototype.hasOwnProperty.call(REJECTED_PROPERTIES, written)) {
      const rejected = REJECTED_PROPERTIES[written] ?? {};
      const reason = rejected.replacement
        ? `${rejected.reason ?? "Not in the format."} Use ${rejected.replacement} instead.`
        : rejected.reason ?? "Not in the format.";
      result.dropped.push({ target, prop: written, value: declaration.value, reason });
      continue;
    }
    if (specFor(property) === null) {
      result.dropped.push({ target, prop: written, value: declaration.value, reason: "not in the format table" });
      continue;
    }

    let normalized;
    try {
      normalized = normalizeValue(property, declaration.value);
    } catch (err) {
      if (err instanceof TableError) {
        throw new Refusal(err.code, `${written}: ${err.message}`, {
          target,
          hint: err.hint ?? specFor(property)?.hint ?? null,
        });
      }
      throw err;
    }
    if (alias !== null || normalized.changed) {
      const entry = { target, prop: property, from: declaration.value, to: normalized.value };
      if (alias !== null) entry.alias = alias;
      result.normalized.push(entry);
    }
    kept.push(`${property}:${normalized.value}`);
  }
  return kept.join(";");
}

/* ------------------------------------------------------------------ *
 * Compilation
 * ------------------------------------------------------------------ */

function readOptions(options) {
  const source = isObject(options) ? options : {};
  const string = (value) => (typeof value === "string" && value !== "" ? value : null);
  return {
    in: string(source.in),
    as: string(source.as),
    page: string(source.page),
    index: Number.isInteger(source.index) && source.index >= 0 ? source.index : null,
  };
}

/**
 * Build the element the op will carry: the ids and types made explicit, the
 * attributes filtered, the style rewritten.
 */
function compileElement(element, depth, context) {
  const { page, options, used, result } = context;

  const type = dataTypeOf(element);
  if (type === null) {
    throw new Refusal("structure/missing-type", `A <${element.tag}> in the fragment has no data-type.`, {
      hint: `Add data-type, for example data-type="${TAG_TO_TYPE[element.tag] ?? "frame"}".`,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(TYPE_TAGS, type)) {
    throw new Refusal("structure/unknown-type", `${JSON.stringify(type)} is not a data-type.`, {
      target: dataIdOf(element) ?? undefined,
      hint: `One of: ${Object.keys(TYPE_TAGS).join(", ")}`,
      suggestion: nearestIds(TYPE_TAGS, type, 2).join(", ") || null,
    });
  }
  if (!TYPE_TAGS[type].includes(element.tag)) {
    throw new Refusal(
      "structure/type-tag-mismatch",
      `A <${element.tag}> cannot be a ${type}; ${type} is <${TYPE_TAGS[type].join(">, <")}>.`,
      {
        target: dataIdOf(element) ?? undefined,
        hint: `Write <${TYPE_TAGS[type][0]} data-type="${type}">, or change data-type.`,
      },
    );
  }
  if (type === "page" && depth > 0) {
    throw new Refusal("structure/page-misplaced", "A page cannot sit inside another element.", {
      target: dataIdOf(element) ?? undefined,
      hint: "A fragment holds a page at its top level, or no page at all.",
    });
  }

  const elementChildren = (Array.isArray(element.children) ? element.children : []).filter(isElement);
  if (elementChildren.length > 0 && !TYPE_HAS_CHILDREN.has(type)) {
    throw new Refusal("structure/children-not-allowed", `A ${type} element cannot hold elements.`, {
      target: dataIdOf(element) ?? undefined,
      hint: "Only page, frame and component take children. Put the children in a frame.",
    });
  }

  // -- the id ----------------------------------------------------------------

  let id = dataIdOf(element);
  if (id === null) {
    if (depth === 0 && options.as !== null) {
      id = options.as;
    } else {
      id = autoId(type === "page" ? element : page, element);
      if (id === null) {
        throw new Refusal("structure/bad-id", `Cannot build a data-id for <${element.tag}>.`, {
          hint: `Ids match ${ID_PATTERN.source}`,
        });
      }
    }
  } else if (depth === 0 && options.as !== null && options.as !== id) {
    throw new Refusal(
      "structure/id-conflict",
      `The fragment root says data-id=${JSON.stringify(id)}, but the call asked for ${JSON.stringify(options.as)}.`,
      { target: id, hint: "Send one id, or none." },
    );
  }
  if (!ID_PATTERN.test(id)) {
    throw new Refusal("structure/bad-id", `${JSON.stringify(id)} is not a usable data-id.`, {
      hint: `Ids match ${ID_PATTERN.source}`,
    });
  }
  if (used.has(id)) {
    throw new Refusal("structure/duplicate-id", `data-id ${JSON.stringify(id)} is already taken.`, {
      target: id,
      hint: "Every element in the file has its own data-id.",
      suggestion: nearestIds(used, id).join(", ") || null,
    });
  }
  used.add(id);
  result.added.push(id);

  // -- attributes ------------------------------------------------------------

  const kept = [];
  const seen = new Set();
  let styleText = null;
  for (const attr of Array.isArray(element.attrs) ? element.attrs : []) {
    const name = String(attr.name).toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === "data-id") {
      kept.push({ name, value: id });
      continue;
    }
    if (name === "data-type") {
      kept.push({ name, value: type });
      continue;
    }
    if (name === "style") {
      const text = compileStyle(attr.value, id, result);
      if (text !== "") styleText = text;
      continue;
    }
    if (isAllowedAttr(type, name)) {
      kept.push({ name, value: String(attr.value ?? "") });
      continue;
    }
    result.dropped.push({
      target: id,
      prop: name,
      value: String(attr.value ?? ""),
      reason: "not in the format table",
    });
  }
  if (!seen.has("data-id")) kept.unshift({ name: "data-id", value: id });
  if (!seen.has("data-type")) kept.unshift({ name: "data-type", value: type });
  if (styleText !== null) kept.push({ name: "style", value: styleText });

  // The written order is §8's: `data-id`, `data-type`, the rest as they were sent,
  // `style` last. Writing it here means the op carries bytes that are already in the
  // file's canonical shape, whatever order the model happened to use.
  const rest = kept.filter((entry) => entry.name !== "data-id" && entry.name !== "data-type" && entry.name !== "style");
  const style = kept.find((entry) => entry.name === "style");
  const ordered = [{ name: "data-id", value: id }, { name: "data-type", value: type }, ...rest];
  if (style !== undefined) ordered.push(style);

  // -- children --------------------------------------------------------------

  const children = [];
  for (const child of Array.isArray(element.children) ? element.children : []) {
    if (isElement(child)) {
      children.push(compileElement(child, depth + 1, context));
    } else if (isObject(child) && child.kind === "text") {
      children.push({ kind: "text", value: child.value ?? "", raw: child.raw ?? child.value ?? "" });
    } else if (isObject(child) && child.kind === "comment") {
      children.push({ kind: "comment", raw: child.raw ?? "" });
    }
  }

  return {
    kind: "element",
    tag: element.tag,
    rawTag: element.rawTag ?? element.tag,
    attrs: ordered.map((entry) => ({
      kind: "attr",
      name: entry.name,
      rawName: entry.name,
      value: entry.value,
      quote: '"',
    })),
    children,
    selfClosing: false,
    parent: null,
  };
}

/**
 * Compile one HTML fragment into one `insert` op.
 *
 * @param {object} doc the document the fragment will be inserted into
 * @param {string} html the fragment
 * @param {{in?: string, index?: number, as?: string, page?: string}} [options]
 * @returns {{ops: object[], added: string[], normalized: object[], dropped: object[],
 *            diagnostics: object[],
 *            refused: null | {code: string, message: string, hint: string|null,
 *                              suggestion: string|null}}}
 */
export function compileFragment(doc, html, options = {}) {
  const result = {
    ops: [],
    added: [],
    normalized: [],
    dropped: [],
    diagnostics: [],
    refused: null,
  };

  const refuseWith = (refusal) => {
    result.refused = {
      code: refusal.code,
      message: refusal.message,
      hint: refusal.hint ?? null,
      suggestion: refusal.suggestion ?? null,
    };
    result.ops = [];
    const diagnostic = { severity: "error", code: refusal.code, message: refusal.message };
    if (refusal.target !== null && refusal.target !== undefined) diagnostic.target = refusal.target;
    if (refusal.hint) diagnostic.hint = refusal.hint;
    if (refusal.suggestion) diagnostic.fix = refusal.suggestion;
    result.diagnostics.push(diagnostic);
    return result;
  };

  if (!isObject(doc)) {
    return refuseWith(new Refusal("ops/no-doc", `Expected a document, got ${doc === null ? "null" : typeof doc}.`));
  }
  if (typeof html !== "string" || html.trim() === "") {
    return refuseWith(
      new Refusal("structure/empty-fragment", "The fragment is empty.", {
        hint: 'Send at least one element, such as <div data-id="n_card" data-type="frame"></div>.',
      }),
    );
  }

  const roots = parseFragmentHtml(html);
  const elementRoots = roots.filter(isElement);
  if (elementRoots.length === 0) {
    return refuseWith(
      new Refusal("structure/empty-fragment", "The fragment has no elements, only text or comments.", {
        hint: 'Send at least one element, such as <div data-id="n_card" data-type="frame"></div>.',
      }),
    );
  }

  const options_ = readOptions(options);
  const index = buildIdIndex(doc);
  const pages = pagesOf(doc);

  // -- which page names the ids that have none --------------------------------

  let page = null;
  if (options_.page !== null) {
    page = pages.find((candidate) => dataIdOf(candidate) === options_.page) ?? null;
    if (page === null) {
      return refuseWith(
        new Refusal("structure/unknown-page", `There is no page with data-id ${JSON.stringify(options_.page)}.`, {
          target: options_.page,
          hint: pages.length === 0 ? "This document has no pages." : `Pages: ${pages.map(dataIdOf).join(", ")}`,
        }),
      );
    }
  } else if (options_.in !== null) {
    const named = findNode(doc, options_.in);
    if (named !== null && named !== doc) page = pageOfElement(doc, named);
  }
  if (page === null && pages.length > 0) page = pages[pages.length - 1];

  // -- the parent -------------------------------------------------------------

  const rootIsPage = elementRoots.some((element) => dataTypeOf(element) === "page");
  let parentAddress = options_.in;
  if (parentAddress === null) {
    if (rootIsPage) parentAddress = isObject(doc.body) ? "body" : "document";
    else if (page !== null) parentAddress = dataIdOf(page);
    else parentAddress = isObject(doc.body) ? "body" : null;
  }
  if (parentAddress === null) {
    return refuseWith(
      new Refusal("structure/no-page", "The document has no page to add this fragment to.", {
        hint: "Add a page, or name a parent with in.",
      }),
    );
  }
  const parent = findNode(doc, parentAddress);
  if (parent === null) {
    return refuseWith(
      new Refusal("ops/node-not-found", `There is no node with data-id ${JSON.stringify(parentAddress)}.`, {
        target: parentAddress,
        hint: "Name the parent with in, or leave in out to use the last page.",
        suggestion: nearestIds(index, parentAddress).join(", ") || null,
      }),
    );
  }
  const parentType = dataTypeOf(parent);
  if (parent !== doc && parentType !== null && !TYPE_HAS_CHILDREN.has(parentType)) {
    return refuseWith(
      new Refusal("structure/children-not-allowed", `A ${parentType} element cannot hold children.`, {
        target: parentAddress,
        hint: "Only page, frame and component take children.",
      }),
    );
  }
  if (rootIsPage && parent !== doc && parentType !== null && parentType !== "page") {
    return refuseWith(
      new Refusal("structure/page-misplaced", `A page cannot sit inside a ${parentType}.`, {
        target: parentAddress,
        hint: "Send the page without in, or name body.",
      }),
    );
  }
  if (rootIsPage && parentType === "page") {
    return refuseWith(
      new Refusal("structure/page-misplaced", "A page cannot sit inside another page.", {
        target: parentAddress,
        hint: "Send the page without in, or name body.",
      }),
    );
  }

  // -- compile ----------------------------------------------------------------

  const context = { page, options: options_, used: new Set(index.keys()), result };
  let nodes;
  try {
    nodes = elementRoots.map((element) => compileElement(element, 0, context));
  } catch (err) {
    if (err instanceof Refusal) return refuseWith(err);
    throw err;
  }

  // -- emit -------------------------------------------------------------------

  const siblings = Array.isArray(parent.children) ? parent.children : [];
  const at = options_.index === null ? siblings.length : options_.index;
  if (at > siblings.length) {
    return refuseWith(
      new Refusal(
        "ops/bad-index",
        `Cannot insert at index ${at}: ${JSON.stringify(parentAddress)} has ${siblings.length} children.`,
        { target: parentAddress, hint: `Use an index from 0 to ${siblings.length}.` },
      ),
    );
  }
  result.ops = [{ op: "insert", target: parentAddress, index: at, html: writeFragment(nodes) }];
  return result;
}
