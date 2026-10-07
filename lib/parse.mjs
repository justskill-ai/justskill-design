/**
 * lib/parse.mjs — HTML text to a document tree.
 *
 * Two hard rules:
 *
 *   1. Nothing is rewritten. Every node carries `start`/`end` so the serializer
 *      can return the original bytes. Attributes keep their original order,
 *      quoting and case. Comments and unknown tags are kept as nodes.
 *   2. Every node carries a source offset, so a diagnostic can name a line in
 *      the file. v1 could not do this, and its diagnostics were worse for it.
 *
 * This is a tolerant scanner, not a spec HTML5 parser. It does not build an
 * implied tree (no implicit <tbody>, no foster parenting). It does close <p>
 * and <li> implicitly, because that is what a hand-written file expects.
 *
 * Pure. No node: imports. Runs in the browser.
 */

// -- tag tables --------------------------------------------------------------

export const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

export const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

/** Tags that an open element of the same name closes implicitly. */
const IMPLICIT_CLOSE = new Set(["p", "li", "dt", "dd", "option", "tr", "td", "th"]);

// -- entities ----------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", middot: "\u00b7",
  times: "\u00d7", divide: "\u00f7", plusmn: "\u00b1", deg: "\u00b0",
  larr: "\u2190", rarr: "\u2192", uarr: "\u2191", darr: "\u2193",
  harr: "\u2194", check: "\u2713", cross: "\u2717", star: "\u2605",
  heart: "\u2665", dash: "\u2010", minus: "\u2212", le: "\u2264",
  ge: "\u2265", ne: "\u2260", laquo: "\u00ab", raquo: "\u00bb",
  sect: "\u00a7", para: "\u00b6", dagger: "\u2020", permil: "\u2030",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
};

/**
 * Decode entities in text.
 * An unknown entity stays literal: guessing is worse than showing the raw text.
 */
export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const value = NAMED_ENTITIES[body];
    return value === undefined ? whole : value;
  });
}

// -- diagnostics -------------------------------------------------------------

function diagnostic(severity, code, message, offset, hint) {
  const d = { severity, code, message };
  if (offset !== undefined && offset !== null) d.offset = offset;
  if (hint) d.hint = hint;
  return d;
}

// -- nodes -------------------------------------------------------------------

/**
 * A frozen copy of a node as it was read.
 *
 * The serializer needs to compare "what the file says" against "what the tree
 * now says". A caller edits the tree in place, so the original values would
 * otherwise be overwritten and every edit would look like no change.
 * `_raw` is that original, attached at parse time.
 */
function snapshotAttrs(attrs) {
  return attrs.map((a) => ({ name: a.name, rawName: a.rawName, value: a.value, quote: a.quote }));
}

function snapshotNode(node) {
  const snap = {
    kind: node.kind,
    tag: node.tag,
    selfClosing: Boolean(node.selfClosing),
    attrs: snapshotAttrs(node.attrs || []),
    children: [],
  };
  if (node.kind === "text") snap.value = node.value;
  if (node.kind === "comment" || node.kind === "doctype") snap.raw = node.raw;
  return snap;
}

/**
 * Attach the parse-time snapshot.
 *
 * `_raw.children` is a COPY of the original child node objects, captured here
 * and never mutated afterwards. Keeping the objects (not a reference to the
 * live array) is what makes "one page added to three pages" visible: the copy
 * still holds the three originals.
 *
 * A snapshot's own `_raw` is left undefined on purpose. That marks it as the
 * file's state, so `nodeMatchesSnapshot` can tell it apart from a live node.
 */
function seal(node) {
  const snap = snapshotNode(node);
  snap.children = (node.children || []).slice();
  node._raw = snap;
  return node;
}

function elementNode(tag, rawTag, attrs, selfClosing, start) {
  return {
    kind: "element",
    tag,
    rawTag,
    attrs,
    children: [],
    selfClosing,
    parent: null,
    start,
    end: start,
    openStart: start,
    openEnd: start,
    closeStart: -1,
    closeEnd: -1,
  };
}

function textNode(value, raw, start) {
  return { kind: "text", value, raw, parent: null, start, end: start + raw.length };
}

/**
 * Seal a whole tree that a caller built by hand, bottom-up.
 *
 * Nothing in the tool edits an unsealed tree: without the snapshots the
 * serializer cannot tell an edit from an untouched sibling, and it would write
 * the entire document on every save. Callers that construct a document
 * programmatically (the ops tests, the `.pen` reader, an importer) call this
 * once and then behave exactly like a parsed file.
 */
export function sealTreeFor(node) {
  for (const child of node.children || []) {
    if (child.kind === "element") sealTreeFor(child);
    else if (!child._raw) seal(child);
  }
  if (node.kind === "element" && node.tag !== "#document") seal(node);
  return node;
}

/** The original children sequence of a node, or the current one for a new node. */
export function originChildren(node) {
  return node._raw && node._raw.children ? node._raw.children : (node.children || []);
}

/** True when a node has no stored original, i.e. it was created by an edit. */
export function isNewNode(node) {
  return !node._raw;
}

// -- tags --------------------------------------------------------------------

/** Index just past the `>` that ends the tag that starts at `lt`, or -1. */
function findTagEnd(source, lt) {
  let i = lt + 1;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Index of `</tag` at or after `from`, or -1. Only used for raw text elements. */
function indexOfCloseTag(source, tag, from) {
  const needle = `</${tag}`;
  const lower = source.toLowerCase();
  const at = lower.indexOf(needle, from);
  return at;
}

function isNameStart(ch) {
  return /[A-Za-z_:]/.test(ch);
}

function isNameChar(ch) {
  return /[A-Za-z0-9_:.-]/.test(ch);
}

/** Parse the inside of a start tag, after the tag name. */
/**
 * Decode the structural character references in an attribute value.
 *
 * Only these four characters are decoded. The other 49 that `decodeEntities`
 * knows about are left in place on purpose: they are not re-encoded on the way
 * out, so decoding them would change the bytes of a file nobody edited, and byte
 * fidelity is what the whole format rests on.
 *
 * The serializer escapes exactly these four back, so `&quot;` returns as
 * `&quot;` and a data URI written with an entity is never double-encoded.
 */
export function decodeAttrEntities(value) {
  const text = String(value ?? "");
  if (!text.includes("&")) return text;
  return text.replace(/&(quot|apos|lt|gt|amp|#0*34|#0*39|#0*60|#0*62|#0*38|#x0*22|#x0*27|#x0*3c|#x0*3e|#x0*26);/gi, (whole) => {
    const lower = whole.toLowerCase();
    if (lower === "&quot;" || lower === "&#34;" || lower === "&#x22;") return '"';
    if (lower === "&apos;" || lower === "&#39;" || lower === "&#x27;") return "'";
    if (lower === "&lt;" || lower === "&#60;" || lower === "&#x3c;") return "<";
    if (lower === "&gt;" || lower === "&#62;" || lower === "&#x3e;") return ">";
    if (lower === "&amp;" || lower === "&#38;" || lower === "&#x26;") return "&";
    return whole;
  });
}

function parseAttributes(body, bodyStart, diagnostics) {
  const attrs = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (i >= body.length) break;
    if (body[i] === "/") { i += 1; continue; }

    const attrStart = bodyStart + i;
    const nameStart = i;
    if (!isNameStart(body[i])) {
      diagnostics.push(diagnostic(
        "error", "syntax/bad-attribute",
        `Attribute name cannot start with ${JSON.stringify(body[i])}.`,
        attrStart,
        "An attribute name starts with a letter, `_` or `:`.",
      ));
      // Skip to the next whitespace so the scanner makes progress.
      while (i < body.length && !/\s/.test(body[i])) i += 1;
      continue;
    }
    while (i < body.length && isNameChar(body[i])) i += 1;
    const rawName = body.slice(nameStart, i);

    let j = i;
    while (j < body.length && /\s/.test(body[j])) j += 1;

    if (body[j] !== "=") {
      // Valueless attribute. Keep it as it stands: `data-hidden` is not `data-hidden=""`.
      attrs.push({
        kind: "attr", name: rawName.toLowerCase(), rawName, value: null, quote: null,
        start: attrStart, end: attrStart + rawName.length,
        attrStart, nameStart: attrStart, valueStart: -1, valueEnd: -1,
      });
      i = j;
      continue;
    }

    let v = j + 1;
    while (v < body.length && /\s/.test(body[v])) v += 1;
    const valueStart = bodyStart + v;
    let value = "";
    let quote = null;
    let valueEnd = valueStart;

    if (body[v] === '"' || body[v] === "'") {
      quote = body[v];
      const close = body.indexOf(quote, v + 1);
      if (close === -1) {
        diagnostics.push(diagnostic(
          "error", "syntax/unclosed-attribute",
          `Attribute ${rawName} has an opening ${quote} with no closing ${quote}.`,
          attrStart,
          "Close the quoted value.",
        ));
        value = decodeAttrEntities(body.slice(v + 1));
        valueEnd = bodyStart + body.length;
        i = body.length;
      } else {
        // A quoted attribute value is fully decoded, structural entities
        // included. The serializer escapes exactly these characters back, so
        // `&quot;` returns as `&quot;` and a data URI written with an entity is
        // not double-encoded on the next write.
        value = decodeAttrEntities(body.slice(v + 1, close));
        valueEnd = bodyStart + close;
        i = close + 1;
      }
    } else {
      let k = v;
      while (k < body.length && !/[\s]/.test(body[k])) k += 1;
      value = decodeAttrEntities(body.slice(v, k));
      valueEnd = bodyStart + k;
      i = k;
    }

    attrs.push({
      kind: "attr", name: rawName.toLowerCase(), rawName, value, quote,
      start: attrStart, end: valueEnd + (quote ? 1 : 0),
      attrStart, nameStart: attrStart, valueStart, valueEnd,
    });
  }
  return attrs;
}

function pushText(parent, source, from, to, diagnostics) {
  if (to <= from) return;
  const raw = source.slice(from, to);
  const node = seal(textNode(decodeEntities(raw), raw, from));
  node.parent = parent;
  parent.children.push(node);
  return node;
}

// -- the document ------------------------------------------------------------

/**
 * Parse HTML text into a document model.
 * @param {string} text
 * @returns {object} document
 */
export function parse(text) {
  const source = String(text);
  const diagnostics = [];
  const doc = {
    kind: "document",
    source,
    children: [],
    doctype: null,
    html: null,
    head: null,
    body: null,
    styleBlocks: [],
    diagnostics,
  };

  // A virtual root: the document, so that top-level nodes have a parent.
  const root = { kind: "element", tag: "#document", rawTag: "#document", attrs: [], children: [], parent: null, start: 0, end: source.length, openStart: 0, openEnd: 0, closeStart: -1, closeEnd: -1, selfClosing: false };
  const stack = [root];
  const current = () => stack[stack.length - 1];

  const closeAt = (depth, closeStart, closeEnd) => {
    for (let d = stack.length - 1; d > depth; d -= 1) {
      const el = stack[d];
      el.end = el.openEnd;
      diagnostics.push(diagnostic(
        "warning", "syntax/unclosed-element",
        `<${el.tag}> is not closed. It ends where its parent ends.`,
        el.start,
        `Add </${el.tag}> after its content.`,
      ));
    }
    stack.length = depth + 1;
    const el = stack[depth];
    el.closeStart = closeStart;
    el.closeEnd = closeEnd;
    el.end = closeEnd;
    stack.pop();
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      pushText(current(), source, i, source.length, diagnostics);
      break;
    }
    if (lt > i) pushText(current(), source, i, lt, diagnostics);

    // Comment.
    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      const end = close === -1 ? source.length : close + 3;
      if (close === -1) {
        diagnostics.push(diagnostic("error", "syntax/unclosed-comment", "Comment has no `-->`.", lt, "Add `-->`."));
      }
      const node = seal({ kind: "comment", raw: source.slice(lt, end), parent: current(), start: lt, end });
      current().children.push(node);
      i = end;
      continue;
    }

    // Doctype, CDATA and processing instructions.
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const close = source.indexOf(">", lt);
      const end = close === -1 ? source.length : close + 1;
      const raw = source.slice(lt, end);
      const node = seal({ kind: "doctype", raw, parent: current(), start: lt, end });
      current().children.push(node);
      if (doc.doctype === null && /^<!doctype/i.test(raw)) doc.doctype = node;
      i = end;
      continue;
    }

    // End tag.
    if (source.startsWith("</", lt)) {
      const close = source.indexOf(">", lt);
      if (close === -1) {
        pushText(current(), source, lt, source.length, diagnostics);
        break;
      }
      const raw = source.slice(lt + 2, close);
      const tag = raw.trim().split(/[\s/]/)[0].toLowerCase();
      let depth = -1;
      for (let d = stack.length - 1; d >= 1; d -= 1) {
        if (stack[d].tag === tag) { depth = d; break; }
      }
      if (depth === -1) {
        diagnostics.push(diagnostic(
          "error", "syntax/stray-end-tag",
          `</${tag}> closes nothing. No <${tag}> is open here.`,
          lt,
          `Remove </${tag}>, or add the matching <${tag}> before it.`,
        ));
      } else {
        closeAt(depth, lt, close + 1);
      }
      i = close + 1;
      continue;
    }

    // Start tag.
    if (!isNameStart(source[lt + 1] || "")) {
      // `<=`, `<<`, a lone `<`. It is text.
      pushText(current(), source, lt, lt + 1, diagnostics);
      i = lt + 1;
      continue;
    }

    const end = findTagEnd(source, lt);
    if (end === -1) {
      const nextLt = source.indexOf("<", lt + 1);
      const stop = nextLt === -1 ? source.length : nextLt;
      const inside = source.slice(lt, stop);
      if (/^\s*$/.test(inside) || !inside.includes("<")) {
        diagnostics.push(diagnostic(
          "error", "syntax/unclosed-tag",
          `The tag that starts here has no \`>\`.`,
          lt,
          "Add `>` to close the start tag.",
        ));
        pushText(current(), source, lt, source.length, diagnostics);
        break;
      }
      // There is another `<` inside: treat this one as text and keep scanning.
      pushText(current(), source, lt, lt + 1, diagnostics);
      i = lt + 1;
      continue;
    }

    const inner = source.slice(lt + 1, end);
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(body);
    const rawTag = nameMatch ? nameMatch[0] : "";
    const tag = rawTag.toLowerCase();
    const attrs = parseAttributes(body.slice(rawTag.length), lt + 1 + rawTag.length, diagnostics);

    // Close an open element of the same name for these tags.
    if (IMPLICIT_CLOSE.has(tag) && current().tag === tag) {
      closeAt(stack.length - 1, -1, -1);
    }

    const el = elementNode(tag, rawTag, attrs, selfClosing, lt);
    el.parent = current();
    el.openEnd = end + 1;
    el.end = end + 1;
    current().children.push(el);

    if (VOID_ELEMENTS.has(tag) || selfClosing) {
      i = end + 1;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const close = indexOfCloseTag(source, tag, end + 1);
      if (close === -1) {
        const raw = source.slice(end + 1);
        const child = seal(textNode(tag === "style" ? raw : decodeEntities(raw), raw, end + 1));
        child.parent = el;
        el.children.push(child);
        el.closeStart = -1;
        el.closeEnd = -1;
        el.end = source.length;
        diagnostics.push(diagnostic(
          "warning", "syntax/unclosed-element",
          `<${tag}> is not closed.`,
          lt,
          `Add </${tag}>.`,
        ));
        i = source.length;
        continue;
      }
      const raw = source.slice(end + 1, close);
      if (raw.length) {
        const child = seal(textNode(tag === "style" ? raw : decodeEntities(raw), raw, end + 1));
        child.parent = el;
        el.children.push(child);
      }
      const closeEnd = close + `</${tag}>`.length;
      el.closeStart = close;
      el.closeEnd = closeEnd;
      el.end = closeEnd;
      i = closeEnd;
      continue;
    }

    stack.push(el);
    i = end + 1;
  }

  // Anything still open at the end.
  for (let d = stack.length - 1; d >= 1; d -= 1) {
    const el = stack[d];
    el.end = source.length;
    el.closeStart = -1;
    el.closeEnd = -1;
    diagnostics.push(diagnostic(
      "warning", "syntax/unclosed-element",
      `<${el.tag}> is not closed. It ends at the end of the file.`,
      el.start,
      `Add </${el.tag}> after its content.`,
    ));
  }

  // Seal every node bottom-up: each element stores its original children
  // sequence, so the serializer can tell an edit from an untouched sibling.
  const sealTree = (node) => {
    for (const child of node.children) {
      if (child.kind === "element") sealTree(child);
      else if (!child._raw) seal(child);
    }
    if (node.kind === "element" && node.tag !== "#document") seal(node);
  };
  sealTree(root);
  if (!root._raw) seal(root);

  doc.children = root.children;
  for (const child of doc.children) child.parent = null;
  // The document needs a snapshot too: a new page is appended to
  // `doc.children`, and the serializer compares against this list.
  doc._raw = snapshotNode(doc);
  doc._raw.children = doc.children.slice();
  doc.html = doc.children.find((n) => n.kind === "element" && n.tag === "html") || null;
  const htmlChildren = doc.html ? doc.html.children.filter((n) => n.kind === "element") : doc.children.filter((n) => n.kind === "element");
  doc.head = htmlChildren.find((n) => n.tag === "head") || null;
  doc.body = htmlChildren.find((n) => n.tag === "body") || null;
  doc.styleBlocks = collectStyleBlocks(doc);
  return doc;
}

// -- style blocks ------------------------------------------------------------

/**
 * `:root{…}` is the token block. `section[data-type="page"]{…}` is the page-frame
 * block. Both must survive. v1 kept only the last block it read, which silently
 * emptied the token table whenever a file had both.
 */
export function styleBlockRole(cssText) {
  const roles = [];
  if (/:root\s*\{/.test(cssText)) roles.push("tokens");
  if (/section\s*\[\s*data-type\s*=\s*["']?page["']?\s*\]/.test(cssText)) roles.push("page-frame");
  if (roles.length === 0) return "unknown";
  return roles.length === 2 ? "tokens+page-frame" : roles[0];
}

export function collectStyleBlocks(doc) {
  const blocks = [];
  const visit = (node, inHead) => {
    for (const child of node.children || []) {
      if (child.kind !== "element") continue;
      if (child.tag === "style") {
        const textNode = child.children.find((c) => c.kind === "text");
        const text = textNode ? textNode.raw : "";
        const role = styleBlockRole(text);
        const block = {
          kind: "style-block",
          role,
          inHead,
          node: child,
          text,
          textStart: textNode ? textNode.start : child.openEnd,
          textEnd: textNode ? textNode.end : child.openEnd,
          declarations: [],
          rules: [],
        };
        if (role === "tokens" || role === "tokens+page-frame") block.declarations = parseRootDeclarations(text);
        blocks.push(block);
      }
      visit(child, inHead || child.tag === "head");
    }
  };
  visit(doc, false);
  return blocks;
}

/** All `:root` declarations, merged across every head style block. */
export function rootDeclarations(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.role === "tokens" || block.role === "tokens+page-frame") out.push(...block.declarations);
  }
  return out;
}

function parseRootDeclarations(cssText) {
  const out = [];
  const re = /:root\s*\{/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(cssText, open);
    if (close === -1) continue;
    for (const decl of parseDeclarations(cssText.slice(open + 1, close))) {
      out.push({ ...decl, blockOffset: open + 1 + decl.textStart });
    }
    re.lastIndex = close;
  }
  return out;
}

function findMatchingBrace(text, open) {
  let depth = 0;
  let quote = null;
  let comment = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (comment) {
      if (ch === "*" && text[i + 1] === "/") { comment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") { comment = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// -- CSS declarations --------------------------------------------------------

/**
 * Split a declaration list into declarations.
 *
 * The split must NOT be `text.split(";")`. A `;` inside a quoted string or
 * inside parentheses is part of the value:
 *
 *     background-image: url("data:image/svg+xml;base64,AAA")
 *
 * Splitting on `;` turns that into `url("data:image/svg+xml` and loses the
 * image. v1 shipped that defect. So this walks the text and tracks four states:
 * single quotes, double quotes, parenthesis depth, and comment.
 *
 * @returns {Array<{property:string, rawProperty:string, value:string, rawValue:string, textStart:number, textEnd:number}>}
 */
export function parseDeclarations(text) {
  const source = String(text);
  const out = [];
  let i = 0;
  let start = 0;

  const emit = (from, to) => {
    const raw = source.slice(from, to);
    if (!raw.trim()) return;
    // Find the first `:` that is outside every quoted or parenthesised region.
    let depth = 0;
    let quote = null;
    let colon = -1;
    for (let k = 0; k < raw.length; k += 1) {
      const ch = raw[k];
      if (quote) {
        if (ch === "\\") { k += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && raw[k + 1] === "*") {
        const end = raw.indexOf("*/", k + 2);
        k = end === -1 ? raw.length : end + 1;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") { depth += 1; continue; }
      if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
      if (ch === ":" && depth === 0) { colon = k; break; }
    }
    if (colon === -1) return;
    const rawProperty = raw.slice(0, colon);
    const rawValue = raw.slice(colon + 1);
    out.push({
      property: rawProperty.trim().toLowerCase(),
      rawProperty,
      value: stripCssComments(rawValue).trim(),
      rawValue,
      textStart: from,
      textEnd: to,
    });
  };

  let quote = null;
  let comment = false;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (comment) {
      if (ch === "*" && source[i + 1] === "/") { comment = false; i += 2; continue; }
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") { comment = true; i += 2; continue; }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (ch === "(") { depth += 1; i += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (ch === ";" && depth === 0) {
      emit(start, i);
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  emit(start, source.length);

  if (quote) {
    const last = out[out.length - 1];
    if (last) last.unclosedString = true;
  }
  return out;
}

export function stripCssComments(value) {
  if (!value.includes("/*")) return value;
  return value.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** True when the declaration list contains an unclosed quote or parenthesis. */
export function declarationListIsBalanced(text) {
  let quote = null;
  let depth = 0;
  let comment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (comment) {
      if (ch === "*" && text[i + 1] === "/") { comment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") { comment = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return quote === null && depth === 0;
}

// -- tree helpers ------------------------------------------------------------

export function walk(node, visit, depth = 0) {
  visit(node, depth);
  for (const child of node.children || []) {
    if (child.kind === "element") walk(child, visit, depth + 1);
  }
}

export function findById(doc, id) {
  let found = null;
  walk(doc, (node) => {
    if (found || node.kind !== "element") return;
    const attr = getAttr(node, "data-id");
    if (attr === id) found = node;
  });
  return found;
}

export function getAttr(node, name) {
  if (!node || !node.attrs) return null;
  const lower = name.toLowerCase();
  for (const attr of node.attrs) {
    if (attr.name === lower) return attr.value === null ? "" : attr.value;
  }
  return null;
}

export function hasAttr(node, name) {
  if (!node || !node.attrs) return false;
  const lower = name.toLowerCase();
  return node.attrs.some((a) => a.name === lower);
}

export function getAttrNode(node, name) {
  if (!node || !node.attrs) return null;
  const lower = name.toLowerCase();
  return node.attrs.find((a) => a.name === lower) || null;
}

/** Give a caller-built document the snapshot the serializer requires. */
export function prepareBuiltDocument(doc, children) {
  const tree = children || doc.children || [];
  const root = {
    kind: "element", tag: "#document", rawTag: "#document", attrs: [], children: tree,
    parent: null, start: 0, end: doc.source ? doc.source.length : 0,
    openStart: 0, openEnd: 0, closeStart: -1, closeEnd: -1, selfClosing: false,
  };
  sealTreeFor(root);
  if (!root._raw) seal(root);
  doc.children = root.children;
  doc._raw = snapshotNode(doc);
  doc._raw.children = doc.children.slice();
  return doc;
}

/** The `style` attribute, parsed into declarations. */
export function styleOf(node) {
  const raw = getAttr(node, "style");
  if (raw === null) return [];
  return parseDeclarations(raw);
}

/** Every `data-` attribute on a node, in source order. */
export function dataAttrs(node) {
  return (node.attrs || []).filter((a) => a.name.startsWith("data-"));
}

/** Direct element children. */
export function elementChildren(node) {
  return (node.children || []).filter((c) => c.kind === "element");
}

/** The concatenated text of a node's text children. */
export function textOf(node) {
  return (node.children || []).filter((c) => c.kind === "text").map((c) => c.value).join("");
}

/** A human path such as `body > section > div > p`. */
export function nodePath(node) {
  const parts = [];
  let current = node;
  while (current && current.kind === "element" && current.tag !== "#document") {
    parts.unshift(current.tag);
    current = current.parent;
  }
  return parts.join(" > ");
}

/** Page elements in document order. */
export function pagesOf(doc) {
  const pages = [];
  walk(doc, (node) => {
    if (node.kind === "element" && node.tag === "section" && getAttr(node, "data-type") === "page") {
      pages.push(node);
    }
  });
  return pages;
}

export function byteOffsetToLineCol(source, offset) {
  const limit = Math.max(0, Math.min(offset ?? 0, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < limit; i += 1) {
    if (source[i] === "\n") { line += 1; lineStart = i + 1; }
  }
  return { line, column: limit - lineStart + 1 };
}
