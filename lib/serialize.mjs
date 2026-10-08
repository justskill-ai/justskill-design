/**
 * lib/serialize.mjs — document tree to text.
 *
 * Three levels, and the difference between them matters:
 *
 *   1. Byte fidelity — when nothing changed, `serialize(doc)` returns
 *      `doc.source` untouched. Not "an equivalent string". The same bytes.
 *   2. Minimal change — one op rewrites one byte range. A style edit rewrites
 *      the `style` value. A text edit rewrites the text. Nothing else moves.
 *   3. Canonical text — `serializeCanonical` writes the one spelling per
 *      intent. It is used by `format` and by `export`, not by an ordinary save.
 *
 * The practical consequence: a hand-written file keeps its own formatting,
 * comments and attribute order forever, until the user asks for `format`.
 *
 * Pure. No node: imports.
 */

import { RAW_TEXT_ELEMENTS, parseDeclarations, VOID_ELEMENTS } from "./parse.mjs";

// -- escaping ----------------------------------------------------------------

const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };

export function escapeText(value) {
  return String(value).replace(/[&<>]/g, (ch) => TEXT_ESCAPES[ch]);
}

export function escapeAttr(value) {
  return String(value).replace(/[&"<>]/g, (ch) => ATTR_ESCAPES[ch]);
}

// -- spans -------------------------------------------------------------------

export class SerializeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SerializeError";
    this.code = code;
  }
}

export function spansOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Apply range replacements to a source string.
 * Edits are applied from the end backwards, so no offset shifts.
 * Overlapping edits are a programming error, not a guess.
 */
export function applyEdits(source, edits) {
  const list = (edits || []).filter((e) => e && e.start !== e.end || (e && e.text !== undefined && e.text !== null && e.text !== ""));
  const sorted = [...list].sort((a, b) => b.start - a.start || b.end - a.end);
  let previous = null;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      throw new SerializeError("serialize/edit-out-of-range", `Edit ${edit.start}..${edit.end} is outside the file (0..${source.length}).`);
    }
    if (previous && previous.start < edit.end) {
      throw new SerializeError("serialize/edits-overlap", `Edit ${edit.start}..${edit.end} overlaps ${previous.start}..${previous.end}.`);
    }
    previous = edit;
  }
  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * Remove edits that another edit fully covers.
 * A parent replacement makes every child edit inside it redundant.
 */
export function outermostEdits(edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const edit of sorted) {
    const covering = out.find((kept) => kept.start <= edit.start && kept.end >= edit.end);
    if (covering) continue;
    out.push(edit);
  }
  return out;
}

// -- node text ---------------------------------------------------------------

/**
 * The canonical attribute order: `data-id`, `data-type`, then the other
 * `data-*` alphabetically, then plain attributes, and `style` last.
 *
 * This lives here as a copy of the rule in lib/normalize.mjs, because the
 * serializer may not import the normalizer — the normalizer uses the serializer.
 * `test/normalize.test.mjs` pins the two against each other, so a change to one
 * that is not made to the other fails a test rather than producing two
 * canonical forms.
 */
function attributeRank(attr) {
  if (attr.name === "data-id") return 0;
  if (attr.name === "data-type") return 1;
  if (attr.name === "style") return 3;
  return 2;
}

function compareAttrs(a, b) {
  const ra = attributeRank(a);
  const rb = attributeRank(b);
  if (ra !== rb) return ra - rb;
  return (a.name || "") < (b.name || "") ? -1 : (a.name || "") > (b.name || "") ? 1 : 0;
}

/** Attributes in canonical order, as fresh entries. */
export function orderAttributes(node) {
  return (node.attrs || [])
    .map((attr, index) => ({ attr, index }))
    .sort((a, b) => compareAttrs(a.attr, b.attr) || a.index - b.index)
    .map((entry) => entry.attr);
}

function attrEntryToText(attr) {
  if (attr.value === null || attr.value === undefined) return attr.rawName || attr.name;
  const name = attr.rawName || attr.name;
  // `attr.value` holds the decoded form, exactly as the parser holds it. The
  // escape here mirrors the parser's decode, so a value that survives a parse
  // and a write comes back with the same bytes. Decoding a second time is what
  // corrupted `&quot;` into `&amp;quot;` on the second normalization.
  return `${name}="${escapeAttr(attr.value)}"`;
}

/** The open tag, canonical form: rebuilt from the attribute list. */
export function serializeOpenTag(node, options = {}) {
  const name = options.keepRawTag ? node.rawTag || node.tag : node.tag;
  // Canonical output sorts the attributes. Byte-faithful output does not: a file
  // nobody edited must come back exactly as it was, attribute order included.
  const source = options.canonical === true ? orderAttributes(node) : (node.attrs || []);
  const parts = source.map(attrEntryToText);
  const head = parts.length ? `<${name} ${parts.join(" ")}` : `<${name}`;
  if (node.selfClosing) return `${head} />`;
  return `${head}>`;
}

export function serializeCloseTag(node) {
  return `</${node.tag}>`;
}

/**
 * Emit one node as text.
 * `raw` is returned verbatim: comments, doctypes, unknown elements, and any
 * subtree the parser could not model must survive unchanged.
 */
export function serializeNode(node, options = {}) {
  if (node === null || node === undefined) return "";
  if (options.canonical !== true && typeof node.raw === "string") return node.raw;

  if (node.kind === "comment" || node.kind === "doctype") return node.raw ?? "";

  if (node.kind === "text") {
    if (options.canonical !== true && typeof node.raw === "string" && node.value === node.raw) return node.raw;
    // `<style>` and `<script>` hold raw text, not character data. Escaping them
    // is how `svg:not([fill]) > path` becomes `svg:not([fill]) &gt; path`, which
    // is not a selector and not a warning either: the browser drops the rule and
    // the page renders differently with nothing to point at.
    if (options.rawText === true) return node.value ?? "";
    return escapeText(node.value ?? "");
  }

  if (node.kind !== "element") return "";

  const open = serializeOpenTag(node, options);
  const childOptions = RAW_TEXT_ELEMENTS.has(node.tag) ? { ...options, rawText: true } : options;
  const body = node.children.map((child) => serializeNode(child, childOptions)).join("");

  // A void element never takes a closing tag, however it was written. `<img …>`
  // and `<img … />` are both void, and emitting `</img>` for the first one is a
  // syntax error this tool would have introduced. The check has to be the tag
  // table, not the `/>` the author happened to type.
  const isVoid = VOID_ELEMENTS.has(node.tag) && node.children.length === 0;
  if (isVoid) return open;
  if (node.selfClosing && node.children.length === 0) return open;
  return `${open}${body}${serializeCloseTag(node)}`;
}

// -- canonical document ------------------------------------------------------

/**
 * Canonical text for a whole document.
 * Used by `format` and by `export`. Not used by an ordinary save.
 */
export function serializeCanonical(doc, options = {}) {
  const opts = { ...options, canonical: true };
  return doc.children.map((child) => serializeNode(child, opts)).join("");
}

// -- byte-exact save ---------------------------------------------------------

/**
 * Structural equality between an original node and a possibly edited node.
 *
 * `a` may carry a `_raw` snapshot from parse time. That snapshot is the truth
 * about the file. A caller edits the tree in place, so `a.value` may already be
 * the new value, and comparing `a` against `b` directly would report "equal"
 * for every edit.
 */
export function nodesEqual(a, b) {
  if (!a || !b) return false;

  // The same object on both sides: the answer comes from its own snapshot,
  // because the caller may have edited it in place. A node with no snapshot was
  // made by an edit, so it cannot be equal to anything that is already on disk.
  if (a === b) return a._raw ? nodeMatchesSnapshot(a) : false;

  // A snapshot has no `_raw` of its own: it IS the file's state. So a node
  // that carries a snapshot is compared snapshot-first, and the snapshot is
  // the side whose values are trustworthy.
  const snap = a._raw;
  const original = snap || a;
  if (original.kind !== b.kind) return false;

  if (original.kind === "text") return String(original.value) === String(b.value);
  if (original.kind === "comment" || original.kind === "doctype") return original.raw === b.raw;
  if (original.kind !== "element") return false;

  if (original.tag !== b.tag) return false;
  if (Boolean(original.selfClosing) !== Boolean(b.selfClosing)) return false;
  if (!attrsEqual(original.attrs, b.attrs)) return false;

  const originKids = Array.isArray(original.children) ? original.children : [];
  const nextKids = b.children || [];
  if (originKids.length !== nextKids.length) return false;
  for (let i = 0; i < originKids.length; i += 1) {
    if (!nodesEqual(originKids[i], nextKids[i])) return false;
  }
  return true;
}

/**
 * Compare a live node against its own parse-time snapshot.
 * This answers "do the bytes on disk still describe this node".
 */
export function nodeMatchesSnapshot(node) {
  const raw = node._raw;
  if (!raw) return true;
  if (node.kind === "text") return String(raw.value) === String(node.value);
  if (node.kind === "comment" || node.kind === "doctype") return raw.raw === node.raw;
  if (node.kind !== "element") return true;
  if (!attrsEqual(raw.attrs, node.attrs)) return false;
  if (!Array.isArray(raw.children)) return true;
  const live = node.children || [];
  if (raw.children.length !== live.length) return false;
  for (let i = 0; i < raw.children.length; i += 1) {
    if (raw.children[i] !== live[i]) return false;
    if (!nodeMatchesSnapshot(live[i])) return false;
  }
  return true;
}

/** True when the next child sequence would produce the same bytes. */
function childrenUnchanged(originKids, nextKids) {
  if (originKids.length !== nextKids.length) return false;
  for (let i = 0; i < originKids.length; i += 1) {
    if (!nodesEqual(originKids[i], nextKids[i])) return false;
  }
  return true;
}

/** Read a node's original child sequence, as captured at parse time. */
export function originChildrenOf(node) {
  const raw = node._raw;
  if (raw && Array.isArray(raw.children)) return raw.children;
  return node.children || [];
}

function attrsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name) return false;
    if ((x.value ?? null) !== (y.value ?? null)) return false;
    if ((x.rawName || x.name) !== (y.rawName || y.name)) return false;
  }
  return true;
}

/** Emit the smallest set of edits that turns `origin` into `next`. */
function diffNode(origin, next, edits, rawText = false) {
  if (nodesEqual(origin, next)) return;
  if (!origin || origin.start === undefined) return;

  if (origin.kind === "text") {
    // Inside `<style>` or `<script>` the text is raw: an escaped `>` would turn
    // a selector into something the browser silently drops.
    const text = rawText ? (next.value ?? "") : escapeText(next.value ?? "");
    edits.push({ start: origin.start, end: origin.end, text, reason: "text" });
    return;
  }

  if (origin.kind !== "element") {
    edits.push({ start: origin.start, end: origin.end, text: serializeNode(next, { canonical: true }), reason: "node" });
    return;
  }

  const originalAttrs = (origin._raw && origin._raw.attrs) || origin.attrs;
  const originalKids = originChildrenOf(origin);
  const nextKids = next.children || [];
  const sameAttrs = attrsEqual(originalAttrs, next.attrs);

  // The tightest edit is inside a child: one child changed and the rest match.
  // Both the parent's own open tag and that child can differ at the same time,
  // so the child pass must not pre-empt the parent pass. Child edits collected
  // here are discarded again when the parent edit covers them.
  if (originalKids.length === nextKids.length) {
    const childEdits = [];
    let changed = -1;
    let count = 0;
    for (let i = 0; i < originalKids.length; i += 1) {
      if (!nodesEqual(originalKids[i], nextKids[i])) {
        count += 1;
        changed = i;
      }
    }
    if (count === 1) {
      if (changed === -1 && nextKids.length === 0) {
        // No child to recurse into.
      } else {
        diffNode(originalKids[changed], nextKids[changed], childEdits, RAW_TEXT_ELEMENTS.has(origin.tag));
      }
      if (childEdits.length && sameAttrs) {
        edits.push(...childEdits);
        return;
      }
    }
  } else if (nextKids.length > originalKids.length) {
    const surviving = originalKids.every((child, i) => child === nextKids[i]);
    if (surviving && sameAttrs) {
      const added = nextKids.slice(originalKids.length)
        .map((child) => serializeNode(child, { canonical: true })).join("");
      if (added) {
        const anchor = originalKids.length
          ? originalKids[originalKids.length - 1].end
          : origin.openEnd;
        edits.push({ start: anchor, end: anchor, text: added, reason: "children-append" });
        return;
      }
    }
  }

  // The element's own open tag changed and the children did not: one span.
  if (sameAttrs !== true && childrenUnchanged(originalKids, nextKids) && origin.openStart !== origin.openEnd) {
    edits.push({ start: origin.openStart, end: origin.openEnd, text: serializeOpenTag(next), reason: "attributes" });
    return;
  }

  // Fall back to rewriting the element. The open tag stays when it matches.
  const bodyStart = origin.openEnd;
  const bodyEnd = origin.closeStart >= 0 ? origin.closeStart : origin.end;
  if (bodyStart <= bodyEnd && bodyStart <= origin.end) {
    const bodyText = nextKids.map((child) => serializeNode(child, { canonical: true })).join("");
    if (sameAttrs && origin.closeStart >= 0) {
      edits.push({ start: bodyStart, end: bodyEnd, text: bodyText, reason: "body" });
      return;
    }
    edits.push({
      start: origin.openStart,
      end: origin.end,
      text: `${serializeOpenTag(next)}${bodyText}${origin.closeStart >= 0 || !next.selfClosing ? serializeCloseTag(next) : ""}`,
      reason: "element",
    });
    return;
  }

  edits.push({ start: origin.start, end: origin.end, text: serializeNode(next, { canonical: true }), reason: "element" });
}

/**
 * Serialize `next` against its `origin`.
 *
 * @param {object} origin  the document as it was read from disk
 * @param {object} next    the same document after edits. May be `origin`.
 * @returns {string} the text to write to disk
 */
export function serialize(origin, next) {
  if (next === undefined || next === null) next = origin;
  // No identity shortcut here. A caller edits the tree in place and calls
  // `serialize(doc, doc)`: the diff below is what decides whether any byte
  // changed. Returning early on `origin === next` would make every in-place
  // edit invisible.

  const edits = [];
  const originChildren = originChildrenOf(origin);
  const nextChildren = next.children || [];
  if (originChildren.length === nextChildren.length) {
    for (let i = 0; i < originChildren.length; i += 1) {
      diffNode(originChildren[i], nextChildren[i], edits);
    }
  } else {
    // Top level shape changed (a page added or removed). Rewrite the region
    // that differs, keeping the identical head and tail of the file.
    let head = 0;
    while (head < originChildren.length && head < nextChildren.length
      && nodesEqual(originChildren[head], nextChildren[head])) head += 1;
    const leftOver = originChildren.length - head;
    const rightOver = nextChildren.length - head;
    let tail = 0;
    while (tail < leftOver && tail < rightOver
      && nodesEqual(originChildren[originChildren.length - 1 - tail], nextChildren[nextChildren.length - 1 - tail])) {
      tail += 1;
    }
    // Replace exactly the region that neither the common head nor the common
    // tail covers. A pure append in a one-page file is then a zero-width insert
    // at the end of the last page, and every other byte is untouched.
    const start = head < originChildren.length
      ? originChildren[head].start
      : (originChildren.length
        ? originChildren[originChildren.length - 1].end
        : origin.source.length);
    const end = tail >= 1 && originChildren.length - tail >= 0 && originChildren.length - tail < originChildren.length
      ? originChildren[originChildren.length - tail].start
      : origin.source.length;
    const text = nextChildren.slice(head, nextChildren.length - tail)
      .map((child) => serializeNode(child, { canonical: true })).join("");
    edits.push({ start, end, text, reason: "top-level" });
  }

  if (edits.length === 0) return origin.source;
  return applyEdits(origin.source, outermostEdits(edits));
}

/** Convenience: the canonical text of one element subtree. */
export function serializeSubtree(node) {
  return serializeNode(node, { canonical: true });
}

/** Declarations of a `style` attribute value, for editors. */
export function declarationsOf(value) {
  return parseDeclarations(value ?? "");
}
