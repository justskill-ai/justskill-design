/**
 * Diagnostics: grouping them, filtering them, sorting them, and finding the
 * element one is about.
 *
 * PURE ESM — no `node:` imports, no DOM. Everything a report decides is decided
 * here, so a test can reach it.
 *
 * A v3 diagnostic looks like this (docs/format-v3.md §6):
 *
 *   { severity: "error", code: "structure/duplicate-id", target: "home__title",
 *     path: "body > section > div > p", offset: 1234, line: 42, column: 7,
 *     message: "…", hint: "…", fix: "…" }
 *
 * `target` is a `data-id`; `offset` is a character offset into the source. A
 * finding is located by either, and a finding that names no element inside a
 * page is answered by that page's root.
 */

const SEVERITY_RANK = { error: 0, warning: 1 };

/** Fold a severity to the two values the format defines. */
export function normalizeSeverity(severity) {
  return severity === "error" ? "error" : "warning";
}

function rankOf(diagnostic) {
  return SEVERITY_RANK[normalizeSeverity(diagnostic && diagnostic.severity)];
}

function offsetOf(diagnostic) {
  const value = diagnostic && diagnostic.offset;
  return Number.isFinite(value) ? value : Infinity;
}

/* ------------------------------------------------------------------ *
 * Reading the document model
 * ------------------------------------------------------------------ */

function asElement(node) {
  if (!node || typeof node !== "object") return false;
  if (node.kind === "element") return true;
  // Tolerant of a plain `{ tag, attrs }` object: the element contract needs both.
  return typeof node.tag === "string" && Array.isArray(node.attrs);
}

/**
 * The value of one attribute, or null.
 *
 * `attrs` is an array of `{ kind: "attr", name, rawName, value, … }` in document
 * order. A Map or a plain object is accepted too, so an older tree still reads.
 *
 * @param {object} node
 * @param {string} name
 * @returns {string|null}
 */
export function attrValue(node, name) {
  if (!node || typeof node !== "object") return null;
  const attrs = node.attrs;
  if (!attrs) return null;
  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      if (!attr) continue;
      const key = typeof attr.name === "string" ? attr.name : attr.rawName;
      if (key !== name) continue;
      if (attr.value === undefined || attr.value === null) return "";
      return typeof attr.value === "string" ? attr.value : String(attr.value);
    }
    return null;
  }
  if (typeof attrs.get === "function") {
    const value = attrs.get(name);
    return value === undefined || value === null ? null : String(value);
  }
  if (typeof attrs === "object" && Object.prototype.hasOwnProperty.call(attrs, name)) {
    const value = attrs[name];
    return value === undefined || value === null ? null : String(value);
  }
  return null;
}

/** The `data-id` of a node, or null. */
export function dataIdOf(node) {
  const value = attrValue(node, "data-id");
  return value === null || value === "" ? null : value;
}

/** The `data-type` of a node, or null. */
export function dataTypeOf(node) {
  const value = attrValue(node, "data-type");
  return value === null || value === "" ? null : value;
}

/** True for `<section data-type="page">`. */
export function isPageElement(node) {
  return asElement(node) && dataTypeOf(node) === "page";
}

function rootsOf(doc) {
  if (!doc || typeof doc !== "object") return [];
  if (Array.isArray(doc.children) && doc.children.length > 0) return doc.children;
  const roots = [];
  if (doc.html) roots.push(doc.html);
  else {
    if (doc.head) roots.push(doc.head);
    if (doc.body) roots.push(doc.body);
  }
  return roots;
}

/**
 * Every element of a document, in document order, plus the lookups a report
 * needs: parent links, and `data-id` -> element (first wins, so a duplicate id
 * resolves to the element that owns it first).
 *
 * @param {object} doc
 * @returns {{ elements: object[], parents: Map<object, object|null>, byId: Map<string, object> }}
 */
export function collectElements(doc) {
  const elements = [];
  const parents = new Map();
  const byId = new Map();

  const visit = (node, parent) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (asElement(node)) {
      elements.push(node);
      const declared = node.parent && typeof node.parent === "object" ? node.parent : null;
      parents.set(node, declared || parent || null);
      const id = dataIdOf(node);
      if (id !== null && !byId.has(id)) byId.set(id, node);
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) visit(child, node);
      return;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child, parent);
  };

  for (const root of rootsOf(doc)) visit(root, null);
  return { elements, parents, byId };
}

/** Every page of a document, in document order. */
export function pagesOf(doc, index) {
  const elements = index ? index.elements : collectElements(doc).elements;
  return elements.filter(isPageElement);
}

function enclosingPage(element, parents, fallback) {
  let current = element;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (isPageElement(current)) return current;
    current = parents.get(current) || null;
  }
  return fallback || null;
}

function deepestElementAt(elements, offset) {
  let best = null;
  for (const element of elements) {
    const start = Number.isFinite(element.start) ? element.start : null;
    const end = Number.isFinite(element.end) ? element.end : null;
    if (start === null || end === null) continue;
    if (offset < start || offset >= end) continue;
    if (best === null || start >= best.start) best = element;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Sorting, grouping, filtering
 * ------------------------------------------------------------------ */

/**
 * Errors before warnings, then by source offset, then by the order the
 * validator produced. A finding with no offset sorts last inside its severity.
 *
 * @param {object[]} list
 * @returns {object[]} a new array
 */
export function sortDiagnostics(list) {
  const source = Array.isArray(list) ? list : [];
  return source
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((a, b) => {
      const bySeverity = rankOf(a.diagnostic) - rankOf(b.diagnostic);
      if (bySeverity !== 0) return bySeverity;
      const byOffset = offsetOf(a.diagnostic) - offsetOf(b.diagnostic);
      if (byOffset !== 0) return byOffset;
      return a.index - b.index;
    })
    .map((entry) => entry.diagnostic);
}

/**
 * One row per `code`: the worst severity in the group, how many findings it has,
 * the distinct `data-id`s it points at, and the message of its first finding.
 *
 * Sorted by severity, then by count descending, then by code, so the order never
 * depends on the order findings arrived in.
 *
 * @param {object[]} list
 * @returns {{code: string, severity: string, count: number, targets: string[], message: string}[]}
 */
export function groupDiagnostics(list) {
  const groups = new Map();
  for (const diagnostic of Array.isArray(list) ? list : []) {
    if (!diagnostic) continue;
    const code = typeof diagnostic.code === "string" && diagnostic.code !== "" ? diagnostic.code : "(no code)";
    const severity = normalizeSeverity(diagnostic.severity);
    let group = groups.get(code);
    if (!group) {
      group = {
        code,
        severity,
        count: 0,
        targets: [],
        message: typeof diagnostic.message === "string" ? diagnostic.message : "",
      };
      groups.set(code, group);
    }
    // A code normally has one severity; if it ever has two, the group is as bad
    // as its worst finding rather than as good as its first.
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[group.severity]) group.severity = severity;
    group.count += 1;
    const target = typeof diagnostic.target === "string" && diagnostic.target !== "" ? diagnostic.target : null;
    if (target !== null && !group.targets.includes(target)) group.targets.push(target);
  }

  return [...groups.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.count !== b.count) return b.count - a.count;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/**
 * Findings of one severity and/or one code.
 *
 * @param {object[]} list
 * @param {{severity?: string, code?: string|string[]}|string} [options]
 *   A string is read as `severity`, which is the v1 signature.
 * @returns {object[]} a copy, so a caller cannot mutate the document's list
 */
export function filterDiagnostics(list, options = {}) {
  const source = Array.isArray(list) ? list : [];
  const settings = typeof options === "string" ? { severity: options } : options || {};

  const severity = settings.severity === undefined || settings.severity === "all" ? null : String(settings.severity);
  const rawCode = settings.code;
  const codes =
    rawCode === undefined || rawCode === null || rawCode === "all"
      ? null
      : new Set((Array.isArray(rawCode) ? rawCode : [rawCode]).map(String));

  return source.filter((diagnostic) => {
    if (!diagnostic) return false;
    if (severity !== null && normalizeSeverity(diagnostic.severity) !== severity) return false;
    if (codes !== null && !codes.has(String(diagnostic.code))) return false;
    return true;
  });
}

/** `{ errors, warnings, total }` for a list of diagnostics. */
export function summarize(list) {
  const source = Array.isArray(list) ? list : [];
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of source) {
    if (normalizeSeverity(diagnostic && diagnostic.severity) === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings, total: source.length, ok: errors === 0 };
}

/**
 * The identity of a diagnostic — docs/format-v3.md §6. Used to refuse only on a
 * finding that was not there before.
 *
 * Four fields, and `target` earns its place: a diagnostic with no `offset` is
 * common, and without `target` two errors that differ only in which element they
 * are about collapse into one key. The gate would still refuse the edit, and the
 * report would then show one row where there were two — a silent drop, which is
 * the one thing this format does not do.
 *
 * This is the only implementation. `lib/validate.mjs` imports and re-exports it
 * so the gate, the report and the documented contract cannot drift apart again.
 *
 * @param {object} diagnostic
 * @returns {string}
 */
export function diagnosticKey(diagnostic) {
  if (!diagnostic) return "|||";
  const code = typeof diagnostic.code === "string" ? diagnostic.code : "";
  const offset = Number.isFinite(diagnostic.offset) ? diagnostic.offset : "";
  const target = typeof diagnostic.target === "string" ? diagnostic.target : "";
  const message = typeof diagnostic.message === "string" ? diagnostic.message : "";
  return `${code}|${offset}|${target}|${message}`;
}

/** Drop duplicates that share a `diagnosticKey`, keeping the first. */
export function dedupeDiagnostics(list) {
  const seen = new Set();
  const out = [];
  for (const diagnostic of Array.isArray(list) ? list : []) {
    if (!diagnostic) continue;
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Locating a finding
 * ------------------------------------------------------------------ */

function looksLikeDocument(value) {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "document") return true;
  return Array.isArray(value.children) && (value.body !== undefined || value.html !== undefined || value.children.length > 0);
}

/**
 * Where on the canvas a diagnostic lives.
 *
 * The walk starts at the element named by `diagnostic.target` (a `data-id`), or
 * failing that at the deepest element whose `[start, end)` contains
 * `diagnostic.offset`. From there it walks up to the enclosing page. When the
 * start element carries no `data-id` — an unrecognised tag, a text finding — the
 * answer is the page root, which is the node that stands for the page.
 *
 * When the finding names no element and the file has exactly one page, that page
 * is the answer; with several pages and no location there is nothing honest to
 * point at, and the result is null.
 *
 * @param {object} diagnostic
 * @param {object} doc
 * @returns {{pageId: string|null, nodeId: string|null}|null}
 */
export function resolveDiagnosticTarget(diagnostic, doc) {
  // The contract is (diagnostic, doc); a caller that swapped them is understood
  // rather than answered with a wrong location.
  if (looksLikeDocument(diagnostic) && !looksLikeDocument(doc)) {
    const swap = diagnostic;
    diagnostic = doc;
    doc = swap;
  }
  if (!diagnostic || !doc) return null;
  const index = collectElements(doc);
  const pages = index.elements.filter(isPageElement);

  let element = null;
  if (typeof diagnostic.target === "string" && diagnostic.target !== "") {
    element = index.byId.get(diagnostic.target) || null;
  }
  if (!element && Number.isFinite(diagnostic.offset)) {
    element = deepestElementAt(index.elements, diagnostic.offset);
  }

  if (element) {
    const page = enclosingPage(element, index.parents, pages.length === 1 ? pages[0] : null);
    if (!page) return null;
    const pageId = dataIdOf(page);
    const nodeId = dataIdOf(element) || pageId;
    return { pageId, nodeId };
  }

  if (pages.length === 1) {
    const pageId = dataIdOf(pages[0]);
    return { pageId, nodeId: pageId };
  }
  return null;
}
