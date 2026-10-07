/**
 * lib/normalize.mjs — the canonical form.
 *
 * HTML has many legal ways to write one intent. That breaks diffs, breaks
 * round trips, and breaks the promise that one op equals one byte range. So the
 * tool picks one spelling per intent and writes it.
 *
 * Two layers, and both are idempotent:
 *
 *   text      line endings, the trailing newline, attribute quoting
 *   semantic  colors, lengths, four-value compression, attribute order,
 *             declaration order inside a style attribute
 *
 * What normalization must NOT do:
 *   - reformat a file that is already canonical (the bytes must not move)
 *   - touch the inside of an unknown element, a comment or a doctype
 *   - reorder pages or reorder elements
 *   - pretty print: whitespace between elements is content, and it stays
 *
 * Pure. No node: imports. Runs in the browser.
 */

import { parseDeclarations, getAttr, prepareBuiltDocument } from "./parse.mjs";
import { serialize } from "./serialize.mjs";
import { normalizeStyleText, compareProperties } from "./table.mjs";

/**
 * The document skeleton is written by hand and by exporters, and its attributes
 * have conventions of their own: `<meta charset>` before `<meta name>`,
 * `<link rel>` first. Reordering them would create a diff on every real file for
 * no gain, so the canonical form stops at the design layer and normalizes the
 * contents of these elements instead.
 */
export const SKELETON_TAGS = new Set(["html", "head", "body", "title", "meta", "link", "style", "script", "base"]);

export class NormalizeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NormalizeError";
    this.code = code;
  }
}

/** Replace CRLF and a lone CR with LF. */
export function normalizeLineEndings(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

/** Exactly one trailing newline. */
export function normalizeFinalNewline(text) {
  return String(text).replace(/\n*$/, "\n");
}

/**
 * The text layer. Reports whether it changed anything, so a caller can write
 * nothing when there is nothing to write.
 */
export function normalizeText(source) {
  const before = String(source);
  const after = normalizeFinalNewline(normalizeLineEndings(before));
  return { text: after, changed: after !== before };
}

// -- attribute order ---------------------------------------------------------

/**
 * `data-id`, `data-type`, then the other `data-*` alphabetically, then plain
 * attributes alphabetically, and `style` last.
 *
 * The order is fixed so that two files with the same design are the same bytes,
 * which is what makes a diff readable and a round trip exact.
 */
export function attributeRank(attr) {
  if (attr.name === "data-id") return [0, ""];
  if (attr.name === "data-type") return [1, ""];
  if (attr.name === "style") return [3, ""];
  if (attr.name.startsWith("data-")) return [2, attr.name];
  return [2.5, attr.name];
}

export function compareAttributes(a, b) {
  const [ra, na] = attributeRank(a);
  const [rb, nb] = attributeRank(b);
  if (ra !== rb) return ra - rb;
  return na < nb ? -1 : na > nb ? 1 : 0;
}

export function attributesAreSorted(attrs) {
  for (let i = 1; i < attrs.length; i += 1) {
    if (compareAttributes(attrs[i - 1], attrs[i]) > 0) return false;
  }
  return true;
}

export function sortAttributes(attrs) {
  return [...attrs].sort(compareAttributes);
}

// -- style declarations ------------------------------------------------------

export function declarationsAreOrdered(declarations) {
  for (let i = 1; i < declarations.length; i += 1) {
    if (compareProperties(declarations[i - 1].property, declarations[i].property) > 0) return false;
  }
  return true;
}

/**
 * Normalize one `style` attribute value.
 * @returns {{ text: string, changed: boolean, normalized: Array, dropped: Array }}
 */
export function normalizeStyleAttribute(value) {
  const { text, normalized, dropped } = normalizeStyleText(value ?? "", parseDeclarations);
  return { text, changed: text !== (value ?? ""), normalized, dropped };
}

// -- the document ------------------------------------------------------------

/**
 * Normalize a parsed document in place.
 *
 * @param {object} doc
 * @returns {{ doc: object, changed: boolean, normalized: Array, dropped: Array, text: string }}
 */
export function normalizeDocument(doc, options = {}) {
  const normalized = [];
  const dropped = [];
  const onDrop = options.onDrop;

  const report = (target, prop, from, to) => {
    normalized.push({ target, prop, from, to });
  };

  const visit = (node, id) => {
    if (node.kind === "element") {
      const ownId = getAttr(node, "data-id") || id;
      const isSkeleton = SKELETON_TAGS.has(node.tag) && !node.attrs.some((a) => a.name === "data-id");

      // Attributes: order them, and normalize the style value. A hand-written
      // skeleton element keeps its attribute order.
      const styleAttr = node.attrs.find((a) => a.name === "style");
      if (styleAttr && typeof styleAttr.value === "string" && styleAttr.value !== "") {
        const result = normalizeStyleAttribute(styleAttr.value);
        for (const item of result.normalized) {
          normalized.push({ target: ownId, prop: item.prop, from: item.from, to: item.to });
        }
        for (const item of result.dropped) {
          const entry = { target: ownId, prop: item.prop, value: item.value, reason: item.reason, replacement: item.replacement ?? null };
          dropped.push(entry);
          if (onDrop) onDrop(entry);
        }
        if (result.text !== styleAttr.value) styleAttr.value = result.text;
      }

      // A valueless attribute becomes an explicit one. `data-hidden` and
      // `data-hidden="true"` must not be two spellings of one intent.
      for (const attr of node.attrs) {
        if (attr.value === null && attr.name.startsWith("data-") && attr.name !== "data-hidden") {
          attr.value = "";
        }
      }

      if (!isSkeleton && !attributesAreSorted(node.attrs)) {
        node.attrs = sortAttributes(node.attrs);
        report(ownId, "attributes", "unsorted", "canonical order");
      }

      // A canonical file has no empty style attribute.
      const empty = node.attrs.find((a) => a.name === "style" && (a.value === "" || a.value === null));
      if (empty) {
        node.attrs = node.attrs.filter((a) => a !== empty);
        report(ownId, "style", "empty", "removed");
      }
    }

    for (const child of node.children || []) visit(child, id);
  };

  visit(doc, null);

  const text = options.serialize ? options.serialize(doc, doc) : doc.source;
  return {
    doc,
    changed: normalized.length > 0 || text !== doc.source,
    normalized,
    dropped,
    text,
  };
}

/**
 * A dry run for `format --check`: does this file already read as canonical.
 *
 * It answers by running the real normalizer on a copy and comparing the result,
 * so the answer can never disagree with what `format` would do. A hand-written
 * checker that re-implements the rules is how a `--check` ends up reporting a
 * file as clean that `format` then rewrites.
 *
 * Working on a copy matters: the check must not mutate the document it is
 * asked about.
 */
export function isCanonical(doc) {
  const wanted = canonicalTextOf(doc);
  const actual = normalizeText(doc.source).text;
  if (wanted === actual) return { canonical: true, reasons: [], total: 0 };

  // Report the first differences so the answer is actionable rather than a bare
  // "no". A caller that only wants the boolean ignores this list.
  const reasons = firstDifferences(actual, wanted);
  return { canonical: false, reasons, total: reasons.length };
}

/** The canonical text of a document, without touching the document. */
export function canonicalTextOf(doc) {
  // Work on a structural clone and seal it, so the clone is a valid document
  // for the serializer. Mutating the caller's document here would make a
  // read-only question ("is this canonical?") change the answer for every
  // question asked afterwards.
  const clones = (doc.children || []).map(cloneNode);
  const copy = {
    kind: "document",
    source: doc.source,
    children: clones,
    diagnostics: [],
    styleBlocks: (doc.styleBlocks || []).map((block) => ({ ...block, node: cloneNode(block.node) })),
  };
  cloneDerived(copy, clones);
  prepareBuiltDocument(copy, clones);
  normalizeDocument(copy, { serialize: (a, b) => b.source });
  return normalizeText(serialize(copy, copy)).text;
}

/** A structural clone deep enough that normalization cannot reach the original. */
function cloneNode(node) {
  if (!node) return node;
  if (node.kind === "text") {
    return { kind: "text", value: node.value, raw: node.raw, start: node.start, end: node.end };
  }
  if (node.kind === "comment" || node.kind === "doctype") {
    return { kind: node.kind, raw: node.raw, start: node.start, end: node.end };
  }
  return {
    kind: "element",
    tag: node.tag,
    rawTag: node.rawTag,
    selfClosing: node.selfClosing,
    attrs: node.attrs.map((a) => ({ ...a })),
    children: (node.children || []).map(cloneNode),
    start: node.start,
    end: node.end,
    openStart: node.openStart,
    openEnd: node.openEnd,
    closeStart: node.closeStart,
    closeEnd: node.closeEnd,
    parent: null,
  };
}

/** The clone's own html/head/body, so validation-style lookups still work. */
function cloneDerived(copy, clones) {
  const flat = [];
  const collect = (nodes) => {
    for (const node of nodes) {
      if (node.kind === "element") {
        flat.push(node);
        collect(node.children || []);
      }
    }
  };
  collect(clones);
  copy.html = flat.find((n) => n.tag === "html") || null;
  const within = copy.html ? copy.html.children.filter((n) => n.kind === "element") : flat;
  copy.head = within.find((n) => n.tag === "head") || null;
  copy.body = within.find((n) => n.tag === "body") || null;
  return copy;
}

function firstDifferences(actual, wanted) {
  const reasons = [];
  const a = actual.split("\n");
  const b = wanted.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length) && reasons.length < 20; i += 1) {
    if (a[i] !== b[i]) {
      reasons.push(`line ${i + 1}: has ${JSON.stringify((a[i] ?? "").slice(0, 90))}, canonical is ${JSON.stringify((b[i] ?? "").slice(0, 90))}`);
    }
  }
  return reasons;
}
