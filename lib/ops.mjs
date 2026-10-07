/**
 * lib/ops.mjs — the operation engine.
 *
 * PURE ESM. No `node:` imports, no DOM, no dependencies. `lib/` top-level files are
 * loaded in the browser too (format-v3 §10.2).
 *
 * One op is at once the sync payload, the undo unit, the change-log entry and the
 * patch command. Five kinds:
 *
 *   { op: "set",    target: "n_cta", prop: "border-radius", value: "12px" }
 *   { op: "unset",  target: "n_cta", prop: "border-radius" }
 *   { op: "insert", target: "n_hero", index: 0, html: "<div …></div>" }
 *   { op: "remove", target: "n_card" }
 *   { op: "move",   target: "n_card", before: "n_cta" }   // or after / index / into
 *
 * ## Addressing
 *
 * By `data-id`, not by JSON Pointer and not by CSS selector. A data-id survives a
 * sibling being inserted or reordered, which is exactly when a positional path
 * breaks. The id index walks the document in document order; the first id wins on
 * duplicates, and an `instance`'s descendants are *not* indexed — they exist only as
 * an expansion and are edited through `data-overrides` (a later milestone).
 *
 * ## Assumptions where docs/format-v3.md is silent
 *
 * A1. `set` prop forms. `"style:<css-property>"` writes one declaration inside the
 *     `style` attribute; `"text"` replaces the element's content with one text node;
 *     any other prop name is an attribute name (`"data-name"`, `"data-id"`, `"style"`).
 * A2. Values are written verbatim. Normalization is a separate layer (§8), so an op
 *     never rewrites more than the thing it names.
 * A3. Errors use only the six codes listed in the brief. `ops/node-not-found` is "no
 *     node carries that data-id"; `ops/no-target` is "the node exists but the thing
 *     you named inside it does not".
 * A4. Container addresses. A target is a data-id. Containers that cannot carry one
 *     (`document`, `html`, `head`, `body`) are addressable by those four reserved
 *     words, and only when no data-id matches. Without this, inserting a page or
 *     inverting a cross-parent `move` would be unaddressable.
 * A5. Exact-restore forms. Some inverse ops cannot be expressed with the plain op
 *     shapes, so they carry extra fields that only the inverse uses, and `applyOps`
 *     accepts them:
 *       - `children: [...]` names the child list a parent must end up with. It is the
 *         only way back once a write has merged two text nodes: the file no longer
 *         says where the node sat between them, so the op has to. Elements are named
 *         by `data-id` and text is inline, which makes the list plain data — it
 *         survives JSON, where a live node object does not. `set`, `insert`, `remove`
 *         and `move` all accept it; `insert` and `move` need no `html`/`node`
 *         alongside it;
 *       - `set` on an attribute with `index: n` puts the attribute back at position n
 *         (attribute order is part of byte fidelity, §4 invariant 5);
 *       - `set` on `"style"` writes the whole `style` attribute, which is how adding
 *         or removing one declaration is undone without reflowing the other ones;
 *       - `insert` with `node: <subtree>` inserts that tree verbatim (the inverse of
 *         `remove` — re-parsing HTML would lose bytes the model cannot express);
 *       - `remove` with `index: n` removes `target`'s child at that index (the inverse
 *         of an insert whose node has no data-id).
 *     `writeFragment`-compatible `html` is set alongside `node` whenever
 *     `doc.source` carries the original bytes.
 *     The list is carried only when the sequence can actually change shape on the way
 *     to disk — that is, when the write would leave two text nodes side by side. Ops
 *     that cannot merge anything keep the small index-based inverse.
 * A6. `insert` parses its HTML with the local mini parser below. `lib/parse.mjs` owns
 *     the document parser and `parseFragmentHtml` may or may not exist there; this
 *     module never imports it, so `insert` works before, during and after that file
 *     lands. The inserted top-level node keeps `raw`, its exact bytes, so the
 *     serializer can write the fragment back verbatim.
 * A7. `applyOps` returns a document that shares no object with its input, and every
 *     `parent` pointer in it is consistent with the returned tree.
 * A8. `setOpFor` returns an op *list*. With the node present it is one `set`. With
 *     the node absent the smallest list that still works is an `insert` of a minimal
 *     node plus the `set`; the parent is the id before `__` when that id exists
 *     (`home__cta` → `home`), else the last page.
 * A9. `parseStyleDeclarations` lives in this file. §4.2 fixes the shape of a
 *     declaration but does not say where the scanner lives, and `set style:x` needs
 *     the byte range of the *value* — which the `CssDeclaration` shape does not carry.
 *     Consumers that only need `{property, value}` can read `lib/parse.mjs` instead.
 * A10. `insert` refuses a target that cannot hold children (page, frame, component,
 *     or the document — format-v3 §3) and an `instance` target. The three type names
 *     are repeated here rather than imported from `lib/table.mjs`, so this module —
 *     which every other one depends on — keeps loading even if a table entry is
 *     renamed.
 */

export const OP_KINDS = ["set", "unset", "insert", "remove", "move"];

export class OpsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "OpsError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ *
 * Small local helpers. No imports: this module has no dependencies.
 * ------------------------------------------------------------------ */

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isElement(node) {
  return isObject(node) && (node.kind === "element" || typeof node.tag === "string");
}

function isDocumentLike(node) {
  return isObject(node) && (node.kind === "document" || Array.isArray(node.children));
}

/** The slots that hold child nodes. Nothing else is walked. */
const DOCUMENT_SLOTS = ["children", "doctype", "html", "head", "body"];

/** The document slots that are aliases for elements that also sit in `children`. */
const ALIAS_SLOTS = ["html", "head", "body"];

/**
 * The `data-type` values that may carry children. format-v3 §3 is the contract; this
 * engine repeats the three names rather than import the table, so the module that
 * every other one depends on keeps loading even if a table entry is renamed.
 */
const CHILD_TYPES = new Set(["page", "frame", "component"]);

function slotKeys(node) {
  if (!isObject(node)) return [];
  if (node.kind === "document") return DOCUMENT_SLOTS;
  if (isElement(node)) return ["children"];
  return [];
}

/** Containers that cannot carry a data-id and are therefore named literally (A4). */
export const RESERVED_CONTAINERS = ["document", "html", "head", "body"];

function attrOf(node, name) {
  const list = Array.isArray(node.attrs) ? node.attrs : [];
  const wanted = String(name).toLowerCase();
  for (const attr of list) {
    if (attr && typeof attr.name === "string" && attr.name.toLowerCase() === wanted) return attr;
  }
  return null;
}

function attrValue(node, name) {
  const attr = attrOf(node, name);
  return attr ? String(attr.value ?? "") : null;
}

/** `data-id` when it is a usable id, else null. */
export function dataIdOf(node) {
  if (!isElement(node)) return null;
  const value = attrValue(node, "data-id");
  return value !== null && value !== "" ? value : null;
}

/** `data-type` when present and non-empty, else null. */
export function dataTypeOf(node) {
  if (!isElement(node)) return null;
  const value = attrValue(node, "data-type");
  return value !== null && value !== "" ? value : null;
}

/* ------------------------------------------------------------------ *
 * Walking the tree
 * ------------------------------------------------------------------ */

/**
 * Every design-layer node in document order, with the path that reaches it.
 *
 * A path step is `{ key, index }`: `index` is -1 for an object slot (`html`, `body`,
 * `doctype`) and the array position otherwise. Paths are how this module mutates: a
 * path is resolved once, then rebuilt, so no lookup is ever done against a tree that
 * a previous step already changed.
 *
 * An `instance` is yielded but not descended into: see the header of `buildIdIndex`.
 */
function collectEntries(doc) {
  const out = [];
  const walk = (node, path) => {
    for (const key of slotKeys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          const child = value[i];
          if (child === null || child === undefined) continue;
          const childPath = path.concat([{ key, index: i }]);
          out.push({ node: child, parent: node, index: i, path: childPath });
          if (isElement(child) && dataTypeOf(child) === "instance") continue;
          walk(child, childPath);
        }
      } else if (isObject(value)) {
        const childPath = path.concat([{ key, index: -1 }]);
        out.push({ node: value, parent: node, index: -1, path: childPath });
        walk(value, childPath);
      }
    }
  };
  walk(doc, []);
  return out;
}

/**
 * Rebuild the spine from `root` down `path`, replacing the node at the end with
 * `apply(node)`. Nodes off the path are shared, never copied, and never mutated.
 * `apply` may return `REMOVE` to delete the node from an array slot.
 *
 * `docRoot` and `patch` exist for one reason: a document keeps `html`, `head` and
 * `body` as slots over nodes that also sit in `children`. Replacing the body deep
 * inside `<html>` must move the document's own `body` slot too, or `doc.body` keeps
 * answering from the tree as it was — including ids that were just removed. The
 * patch is applied once, at the root, by `applyToPath`.
 */
const REMOVE = Symbol("ops.remove");

function rebuild(root, path, apply, docRoot, patch) {
  if (path.length === 0) return apply(root);
  const step = path[0];
  const rest = path.slice(1);
  const copy = { ...root };
  if (step.index >= 0) {
    const source = root[step.key];
    const list = Array.isArray(source) ? source.slice() : [];
    const before = list[step.index];
    const next = rebuild(before, rest, apply, docRoot, patch);
    if (next === REMOVE) list.splice(step.index, 1);
    else list[step.index] = next;
    copy[step.key] = list;
    if (docRoot !== undefined && before !== undefined) {
      for (const alias of ALIAS_SLOTS) {
        if (before === docRoot[alias]) patch[alias] = next === REMOVE ? null : next;
      }
    }
  } else {
    const before = root[step.key];
    const next = rebuild(before, rest, apply, docRoot, patch);
    copy[step.key] = next === REMOVE ? null : next;
    // The other direction: the path came down an alias slot, so `children` still
    // holds the node it used to point at.
    if (docRoot !== undefined && ALIAS_SLOTS.includes(step.key) && Array.isArray(root.children)) {
      const at = root.children.indexOf(before);
      if (at >= 0) {
        const list = copy.children.slice();
        if (next === REMOVE) list.splice(at, 1);
        else list[at] = next;
        copy.children = list;
      }
    }
  }
  return copy;
}

/** `rebuild`, plus the one write that keeps a document's alias slots honest. */
function applyToPath(doc, path, apply) {
  const patch = {};
  const next = rebuild(doc, path, apply, doc, patch);
  if (next === doc) return next;
  for (const [alias, value] of Object.entries(patch)) next[alias] = value;
  return next;
}

/* ------------------------------------------------------------------ *
 * Node-id index
 * ------------------------------------------------------------------ */

/**
 * `Map<data-id, node>` over the whole document.
 *
 * Pages come in document order, so a plain document-order walk visits them in that
 * order and then their subtrees, which is exactly the required order. The first id
 * wins on duplicates: a second node claiming an id is a validation error, and
 * addressing must stay deterministic while the validator reports it.
 *
 * An `instance`'s descendants are not indexed. They are an expansion, not bytes;
 * `data-overrides` on the instance is the way to change one.
 */
export function buildIdIndex(doc) {
  const index = new Map();
  if (!isObject(doc)) return index;
  for (const entry of collectEntries(doc)) {
    if (!isElement(entry.node)) continue;
    const id = dataIdOf(entry.node);
    if (id === null || index.has(id)) continue;
    index.set(id, entry.node);
  }
  return index;
}

/** The first entry whose element carries `id`, matching `buildIdIndex`'s rule. */
function entryOfId(doc, id) {
  for (const entry of collectEntries(doc)) {
    if (isElement(entry.node) && dataIdOf(entry.node) === id) return entry;
  }
  return null;
}

/**
 * Resolve an address to an entry. A data-id wins; the four reserved words resolve
 * the containers that cannot carry one (A4).
 */
function resolveAddress(doc, address) {
  const entries = collectEntries(doc);
  for (const entry of entries) {
    if (isElement(entry.node) && dataIdOf(entry.node) === address) return entry;
  }
  if (!RESERVED_CONTAINERS.includes(address)) return null;
  if (address === "document") return { node: doc, parent: null, index: -1, path: [] };
  const slot = address === "html" ? doc.html : address === "head" ? doc.head : doc.body;
  if (isObject(slot)) {
    for (const entry of entries) if (entry.node === slot) return entry;
    return { node: slot, parent: doc, index: -1, path: [{ key: address, index: -1 }] };
  }
  for (const entry of entries) {
    if (isElement(entry.node) && entry.node.tag === address) return entry;
  }
  return null;
}

function requireEntry(doc, address, op) {
  const entry = resolveAddress(doc, address);
  if (entry === null) {
    throw new OpsError("ops/node-not-found", `No node with data-id ${JSON.stringify(address)}`, {
      target: address,
      op,
    });
  }
  return entry;
}

function requireContainer(doc, address, op) {
  const entry = requireEntry(doc, address, op);
  if (entry.node === doc) return entry;
  assertHoldsChildren(entry.node, address, op);
  return entry;
}

/** Only page, frame and component take children (format-v3 §3). */
function assertHoldsChildren(node, address, op) {
  if (!isElement(node)) {
    throw new OpsError(
      "ops/bad-op",
      `${JSON.stringify(address)} cannot hold children: it is a ${node.kind || "non-element"} node`,
      { target: address, op },
    );
  }
  if (dataTypeOf(node) === "instance") {
    throw new OpsError(
      "ops/bad-op",
      `${JSON.stringify(address)} is an instance: edit the component, or its data-overrides`,
      { target: address, op },
    );
  }
  const type = dataTypeOf(node);
  if (type !== null && !CHILD_TYPES.has(type)) {
    throw new OpsError(
      "ops/bad-op",
      `${JSON.stringify(address)} is a ${type}: only page, frame and component take children`,
      { target: address, op },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Attribute and style-text editing
 * ------------------------------------------------------------------ */

function withAttr(node, name, value, insertIndex) {
  const attrs = Array.isArray(node.attrs) ? node.attrs.slice() : [];
  const wanted = String(name).toLowerCase();
  const at = attrs.findIndex((attr) => attr && String(attr.name).toLowerCase() === wanted);
  if (at >= 0) {
    attrs[at] = { ...attrs[at], value };
  } else {
    const fresh = {
      kind: "attr",
      name,
      rawName: name,
      value,
      quote: '"',
      start: -1,
      end: -1,
      attrStart: -1,
    };
    const position = Number.isInteger(insertIndex)
      ? Math.max(0, Math.min(insertIndex, attrs.length))
      : attrs.length;
    attrs.splice(position, 0, fresh);
  }
  return { ...node, attrs };
}

function withoutAttr(node, name) {
  const wanted = String(name).toLowerCase();
  const attrs = (Array.isArray(node.attrs) ? node.attrs : []).filter(
    (attr) => !(attr && String(attr.name).toLowerCase() === wanted),
  );
  return { ...node, attrs };
}

function attrIndexOf(node, name) {
  const list = Array.isArray(node.attrs) ? node.attrs : [];
  const wanted = String(name).toLowerCase();
  return list.findIndex((attr) => attr && String(attr.name).toLowerCase() === wanted);
}

function scalarText(value, op) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new OpsError(
    "ops/bad-op",
    `A "set" value must be a string, number or boolean, got ${value === null ? "null" : typeof value}`,
    { op },
  );
}

/**
 * Split a `style` attribute into declarations.
 *
 * §4.2 forbids splitting on `;`: a data URI contains one, and so does `content:"a;b"`.
 * This walks characters and tracks four states — single quote, double quote, paren
 * depth, comment — and only treats `;` and `:` as separators when all four are at
 * rest. Escapes inside a string do not take part in state changes.
 *
 * Runs inside `style` attributes and inside the two `<style>` blocks, which is why
 * it lives here rather than in a module of its own.
 *
 * @returns {{property: string, value: string, rawValue: string, start: number,
 *            end: number, valueStart: number, valueEnd: number}[]}
 *          `start`/`end` bound the declaration without its separator or padding;
 *          `valueStart`/`valueEnd` bound exactly the value.
 */
export function parseStyleDeclarations(text) {
  const source = String(text ?? "");
  const raw = [];
  let start = 0;
  let colon = -1;
  let depth = 0;
  let quote = null;
  let comment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (comment) {
      if (ch === "*" && source[i + 1] === "/") {
        comment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (depth > 0) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      comment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ";") {
      raw.push({ start, end: i, colon });
      start = i + 1;
      colon = -1;
      continue;
    }
    if (ch === ":" && colon < 0) colon = i;
  }
  raw.push({ start, end: source.length, colon });

  const out = [];
  for (const piece of raw) {
    let from = piece.start;
    let to = piece.end;
    while (from < to && /\s/.test(source[from])) from += 1;
    while (to > from && /\s/.test(source[to - 1])) to -= 1;
    if (from >= to) continue;
    const head = piece.colon >= 0 && piece.colon < to ? source.slice(from, piece.colon) : source.slice(from, to);
    const property = head.trim();
    let valueStart = to;
    let value = "";
    if (piece.colon >= 0 && piece.colon < to) {
      valueStart = piece.colon + 1;
      while (valueStart < to && /\s/.test(source[valueStart])) valueStart += 1;
      value = source.slice(valueStart, to);
    }
    out.push({
      property,
      rawProperty: property,
      value,
      rawValue: piece.colon >= 0 && piece.colon < to ? source.slice(piece.colon + 1, to) : "",
      start: from,
      end: to,
      valueStart,
      valueEnd: valueStart + value.length,
    });
  }
  return out;
}

function findDeclaration(text, property) {
  const wanted = String(property).toLowerCase();
  for (const declaration of parseStyleDeclarations(text)) {
    if (declaration.property.toLowerCase() === wanted) return declaration;
  }
  return null;
}

function replaceDeclarationValue(text, declaration, value) {
  return `${text.slice(0, declaration.valueStart)}${value}${text.slice(declaration.valueEnd)}`;
}

function appendDeclaration(text, property, value) {
  const trimmed = String(text ?? "").replace(/\s+$/, "");
  if (trimmed === "") return `${property}:${value}`;
  const separator = trimmed.endsWith(";") ? "" : ";";
  return `${trimmed}${separator}${property}:${value}`;
}

function removeDeclaration(text, declaration) {
  const after = text.indexOf(";", declaration.end);
  let from;
  let to;
  if (after >= 0) {
    from = declaration.start;
    to = after + 1;
  } else {
    const before = text.lastIndexOf(";", declaration.start - 1);
    from = before >= 0 ? before : 0;
    to = declaration.end;
  }
  const next = `${text.slice(0, from)}${text.slice(to)}`.trim();
  return next.endsWith(";") ? next.slice(0, -1) : next;
}

/* ------------------------------------------------------------------ *
 * Fragment parsing (A6)
 * ------------------------------------------------------------------ */

/** Tags that never take a closing tag. Shared with `lib/fragment.mjs`. */
export const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ENTITIES = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&nbsp;", "\u00a0"],
  ["&amp;", "&"],
];

export function escapeAttrValue(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeTextValue(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeEntities(value) {
  let out = value;
  for (const [entity, char] of ENTITIES) out = out.split(entity).join(char);
  return out;
}

function skipSpace(source, from, to) {
  let i = from;
  while (i < to && /\s/.test(source[i])) i += 1;
  return i;
}

/**
 * Parse an HTML fragment into the document model's element shape.
 *
 * This is deliberately *not* `lib/parse.mjs`. It never sees a whole file: no
 * doctype, no `<head>`, no `<style>` blocks, no byte offsets that anything else
 * depends on. What it must do is turn `<div data-id="n_x" data-type="frame">…</div>`
 * into a node so a later op can address `n_x` — which is why the raw string alone is
 * not enough and why this parser exists at all.
 *
 * Offsets are relative to `html`. A mismatched closing tag pops to the matching open
 * element when there is one and is otherwise ignored, so a malformed fragment can
 * never corrupt a tree. No implicit tag completion happens beyond that.
 *
 * @returns {object[]} the top-level nodes, in order
 */
export function parseFragmentHtml(html) {
  const source = typeof html === "string" ? html : "";
  const roots = [];
  const stack = [];

  const push = (node) => {
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    node.parent = parent;
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      push({
        kind: "text",
        value: decodeEntities(source.slice(i)),
        raw: source.slice(i),
        parent: null,
        start: i,
        end: source.length,
      });
      break;
    }
    if (lt > i) {
      push({
        kind: "text",
        value: decodeEntities(source.slice(i, lt)),
        raw: source.slice(i, lt),
        parent: null,
        start: i,
        end: lt,
      });
    }
    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      const stop = close === -1 ? source.length : close + 3;
      push({ kind: "comment", raw: source.slice(lt, stop), parent: null, start: lt, end: stop });
      i = stop;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const gt = source.indexOf(">", lt);
      const stop = gt === -1 ? source.length : gt + 1;
      push({ kind: "doctype", raw: source.slice(lt, stop), parent: null, start: lt, end: stop });
      i = stop;
      continue;
    }
    if (source.startsWith("</", lt)) {
      const gt = source.indexOf(">", lt);
      const stop = gt === -1 ? source.length : gt + 1;
      const name = source.slice(lt + 2, gt === -1 ? source.length : gt).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].tag === name) {
          stack[depth].closeStart = lt;
          stack[depth].closeEnd = stop;
          stack[depth].end = stop;
          stack.length = depth;
          break;
        }
      }
      i = stop;
      continue;
    }

    const nameMatch = /^<([A-Za-z][^\s/>]*)/.exec(source.slice(lt));
    if (nameMatch === null) {
      push({
        kind: "text",
        value: source[lt],
        raw: source[lt],
        parent: null,
        start: lt,
        end: lt + 1,
      });
      i = lt + 1;
      continue;
    }

    const rawTag = nameMatch[1];
    const tag = rawTag.toLowerCase();
    const attrs = [];
    let cursor = lt + 1 + rawTag.length;
    let selfClosing = false;
    let openEnd = source.length;
    while (cursor < source.length) {
      const ch = source[cursor];
      if (ch === ">") {
        openEnd = cursor + 1;
        break;
      }
      if (ch === "/" && source[cursor + 1] === ">") {
        selfClosing = true;
        openEnd = cursor + 2;
        break;
      }
      if (/\s/.test(ch)) {
        cursor += 1;
        continue;
      }
      const nameStart = cursor;
      while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) cursor += 1;
      const rawName = source.slice(nameStart, cursor);
      const name = rawName.toLowerCase();
      let value = "";
      let quote = "";
      let valueStart = cursor;
      let valueEnd = cursor;
      let after = skipSpace(source, cursor, source.length);
      if (source[after] === "=") {
        after = skipSpace(source, after + 1, source.length);
        const first = source[after];
        if (first === '"' || first === "'") {
          const close = source.indexOf(first, after + 1);
          const stop = close === -1 ? source.length : close;
          quote = first;
          value = decodeEntities(source.slice(after + 1, stop));
          valueStart = after;
          valueEnd = close === -1 ? source.length : close + 1;
          cursor = valueEnd;
        } else {
          let stop = after;
          while (stop < source.length && !/[\s>]/.test(source[stop])) stop += 1;
          value = decodeEntities(source.slice(after, stop));
          valueStart = after;
          valueEnd = stop;
          cursor = stop;
        }
      } else {
        cursor = after;
      }
      attrs.push({
        kind: "attr",
        name,
        rawName,
        value,
        quote,
        start: valueStart,
        end: valueEnd,
        attrStart: nameStart,
      });
    }

    const node = {
      kind: "element",
      tag,
      rawTag,
      attrs,
      children: [],
      selfClosing,
      parent: null,
      start: lt,
      end: openEnd,
      openStart: lt,
      openEnd,
      closeStart: -1,
      closeEnd: -1,
    };
    push(node);
    i = openEnd;
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
  }

  return roots;
}

/** The exact bytes of a node, when the document carries its own source. */
function rawBytesOf(doc, node) {
  if (!isObject(doc) || typeof doc.source !== "string" || !isObject(node)) return null;
  const { start, end } = node;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > doc.source.length) return null;
  return doc.source.slice(start, end);
}

/* ------------------------------------------------------------------ *
 * Detaching the result (A7)
 * ------------------------------------------------------------------ */

/**
 * Deep-copy a tree, re-linking every `parent` pointer to the copy.
 *
 * `applyOps` ends with this so the returned document shares no object with its
 * input, which is what "the input must never be mutated" has to mean once a caller
 * holds both. A memo keeps shared nodes shared — `styleBlocks[i].node` is the very
 * `<style>` element that sits in `<head>`, and splitting it into two objects would
 * break that.
 */
function detach(node, parent, memo) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => detach(item, parent, memo));
  const seen = memo.get(node);
  if (seen !== undefined) return seen;

  const out = {};
  memo.set(node, out);
  const keys = Object.keys(node);
  for (const key of keys) out[key] = undefined;

  const isTree = isElement(node) || node.kind === "document";
  const childParent = isElement(node) ? out : null;
  for (const key of keys) {
    if (key === "parent") continue;
    const value = node[key];
    if (isTree && slotKeys(node).includes(key)) {
      out[key] = Array.isArray(value)
        ? value.map((item) => detach(item, childParent, memo))
        : isObject(value)
          ? detach(value, childParent, memo)
          : value;
    } else {
      out[key] = detach(value, parent, memo);
    }
  }
  if (keys.includes("parent")) out.parent = parent === undefined ? null : parent;
  return out;
}

/* ------------------------------------------------------------------ *
 * Exact-restore child lists
 * ------------------------------------------------------------------ */

/**
 * The parent's child list, as plain data.
 *
 * HTML has no room for two adjacent text nodes: a write merges them, and every index
 * after the merge moves up by one. So an op that lifts a node out from between two
 * text nodes cannot be undone by an index once the file has been written and read
 * back — and the write path does exactly that between two ops ("apply, serialize,
 * write; the next op comes from a fresh parse").
 *
 * The inverse therefore carries the parent's child list as it was. An element is
 * referenced by `data-id` (in the entry's `target`), because a document that came back
 * from disk holds new node objects; text and comments are inline, because they are the
 * very nodes a write merges. Every entry is plain data, so the list survives JSON —
 * including the receipt's own field whitelist — where a live node object does not.
 */
function snapshotChildren(children) {
  const out = [];
  for (const child of Array.isArray(children) ? children : []) {
    if (!isObject(child)) continue;
    if (child.kind === "text") {
      out.push({
        kind: "text",
        value: String(child.value ?? ""),
        raw: String(child.raw ?? child.value ?? ""),
      });
      continue;
    }
    if (child.kind === "comment" || child.kind === "doctype") {
      out.push({ kind: child.kind, raw: String(child.raw ?? "") });
      continue;
    }
    const id = dataIdOf(child);
    if (id !== null) {
      // `target`, not `id`: the receipt keeps an op's own fields and drops the rest
      // (`lib/node/write-verbs.mjs`), and a ref that lost its id would come back as
      // an empty entry. `target` already means "the data-id this op addresses".
      out.push({ kind: "ref", target: id });
      continue;
    }
    // No data-id: after a re-read there is nothing to look it up by, so the only
    // thing that can carry it is the node itself.
    out.push({ kind: "node", node: child });
  }
  return out;
}

/**
 * The nodes a `children` field names.
 *
 * Both shapes are accepted: the descriptor above, and the live nodes `set` writes.
 * Inline entries are materialized fresh (they carry no bytes of their own — the
 * serializer edits the origin's range, which is where the old bytes still are).
 * `known` supplies nodes the tree no longer holds: the element a `remove` took out.
 */
function materializeChildren(doc, descriptor, known, op) {
  const out = [];
  for (const entry of Array.isArray(descriptor) ? descriptor : []) {
    if (!isObject(entry)) continue;
    if (entry.kind === "ref") {
      const id = entry.target ?? entry.id;
      const fromKnown = known === undefined ? undefined : known.get(id);
      const node = fromKnown !== undefined ? fromKnown : entryOfId(doc, id)?.node ?? null;
      if (node === null) {
        // A list that cannot be produced in full is not an exact restore, and
        // restoring part of it would drop a node in silence. Refuse instead.
        throw new OpsError(
          "ops/no-target",
          `The child list names ${JSON.stringify(id)}, which is not in the document`,
          { target: id, op },
        );
      }
      out.push(node);
      continue;
    }
    if (entry.kind === "node") {
      if (isObject(entry.node)) out.push(entry.node);
      continue;
    }
    if (isElement(entry)) {
      out.push(entry);
      continue;
    }
    if (entry.kind === "text") {
      out.push({
        kind: "text",
        value: String(entry.value ?? ""),
        raw: String(entry.raw ?? entry.value ?? ""),
        parent: null,
        start: -1,
        end: -1,
      });
      continue;
    }
    if (entry.kind === "comment" || entry.kind === "doctype") {
      out.push({ kind: entry.kind, raw: String(entry.raw ?? ""), parent: null, start: -1, end: -1 });
      continue;
    }
    throw new OpsError(
      "ops/bad-op",
      `A child list entry must be text, comment, doctype, ref or node, got ${JSON.stringify(entry.kind)}`,
      { op },
    );
  }
  return out;
}

/**
 * True when writing this list would merge two of its entries: two text nodes side by
 * side have no bytes between them, so a re-read sees one node where there were two,
 * and every later index refers to a different node.
 */
function hasAdjacentText(children) {
  for (let i = 1; i < children.length; i += 1) {
    const left = children[i - 1];
    const right = children[i];
    if (isObject(left) && left.kind === "text" && isObject(right) && right.kind === "text") return true;
  }
  return false;
}

/** The same list with one node gone, by identity. */
function withoutNode(children, node) {
  return (Array.isArray(children) ? children : []).filter((child) => child !== node);
}

/**
 * Apply a `children` field: the parent's child list becomes exactly this, whatever the
 * whitespace did on the way to disk.
 *
 * @returns {{doc: object, inverse: object[], at: number}}
 */
function restoreChildren(doc, op, container, known) {
  const before = Array.isArray(container.node.children) ? container.node.children : [];
  const restored = materializeChildren(doc, op.children, known, op);
  const added = restored.findIndex((node) => !before.includes(node));
  const next = applyToPath(doc, container.path, () => ({ ...container.node, children: restored }));
  const inverse = [
    {
      op: "insert",
      target: op.target,
      index: added < 0 ? before.length : added,
      children: snapshotChildren(before),
    },
  ];
  return { doc: next, inverse, at: added };
}

/* ------------------------------------------------------------------ *
 * Op normalization
 * ------------------------------------------------------------------ */

function requireString(op, key) {
  if (typeof op[key] !== "string" || op[key] === "") {
    throw new OpsError("ops/bad-op", `A ${JSON.stringify(op.op)} op needs a non-empty "${key}" string`, {
      op,
    });
  }
}

/**
 * Check one op's shape and return the op with only its known fields, in a stable
 * order. Every rejection is `ops/bad-op`: the caller sent something the engine
 * cannot read, which is not the same as naming a node that is not there.
 */
export function normalizeOp(op) {
  if (!isObject(op)) {
    throw new OpsError("ops/bad-op", `Each op must be an object, got ${JSON.stringify(op)}`);
  }
  switch (op.op) {
    case "set": {
      requireString(op, "target");
      requireString(op, "prop");
      if (!hasOwn(op, "value")) {
        throw new OpsError("ops/bad-op", `A "set" op needs a "value"`, { op });
      }
      const out = { op: "set", target: op.target, prop: op.prop, value: op.value };
      if (Array.isArray(op.children)) out.children = op.children;
      if (Number.isInteger(op.index) && op.index >= 0) out.index = op.index;
      return out;
    }
    case "unset": {
      requireString(op, "target");
      requireString(op, "prop");
      return { op: "unset", target: op.target, prop: op.prop };
    }
    case "insert": {
      requireString(op, "target");
      if (!Number.isInteger(op.index) || op.index < 0) {
        throw new OpsError("ops/bad-op", `An "insert" op needs a non-negative integer "index"`, { op });
      }
      const hasHtml = typeof op.html === "string";
      const hasNode = isObject(op.node) || Array.isArray(op.node);
      const hasChildren = Array.isArray(op.children);
      if (!hasHtml && !hasNode && !hasChildren) {
        throw new OpsError("ops/bad-op", `An "insert" op needs an "html" string`, { op });
      }
      const out = { op: "insert", target: op.target, index: op.index };
      if (hasHtml) out.html = op.html;
      if (hasNode) out.node = op.node;
      if (hasChildren) out.children = op.children;
      return out;
    }
    case "remove": {
      requireString(op, "target");
      const out = { op: "remove", target: op.target };
      if (Array.isArray(op.children)) out.children = op.children;
      if (hasOwn(op, "index")) {
        if (!Number.isInteger(op.index) || op.index < 0) {
          throw new OpsError("ops/bad-op", `A "remove" op's "index" must be a non-negative integer`, { op });
        }
        out.index = op.index;
      }
      return out;
    }
    case "move": {
      requireString(op, "target");
      const named = ["before", "after"].filter((key) => typeof op[key] === "string" && op[key] !== "");
      if (named.length > 1) {
        throw new OpsError("ops/bad-op", `A "move" op takes "before" or "after", not both`, { op });
      }
      const hasInto = typeof op.into === "string" && op.into !== "";
      if (hasInto && named.length > 0) {
        throw new OpsError("ops/bad-op", `A "move" op takes "into" or a sibling, not both`, { op });
      }
      const hasIndex = hasOwn(op, "index");
      if (hasIndex && (!Number.isInteger(op.index) || op.index < 0)) {
        throw new OpsError("ops/bad-op", `A "move" op's "index" must be a non-negative integer`, { op });
      }
      if (!hasInto && named.length === 0 && !hasIndex) {
        throw new OpsError(
          "ops/bad-op",
          `A "move" op needs one of "before", "after", "index" or "into"`,
          { op },
        );
      }
      if (named.length === 0 && !hasInto && !hasIndex) {
        throw new OpsError("ops/bad-op", `A "move" op needs a destination`, { op });
      }
      const out = { op: "move", target: op.target };
      if (Array.isArray(op.children)) out.children = op.children;
      if (named.length === 1) {
        const key = named[0];
        out[key] = op[key];
      } else if (hasInto) {
        out.into = op.into;
        if (hasIndex) out.index = op.index;
      } else {
        out.index = op.index;
      }
      return out;
    }
    default:
      throw new OpsError(
        "ops/bad-op",
        `Unknown op ${JSON.stringify(op.op)}; expected one of ${OP_KINDS.join(", ")}`,
        { op },
      );
  }
}

/* ------------------------------------------------------------------ *
 * Applying one op
 * ------------------------------------------------------------------ */

function insertNodesFor(op) {
  if (Array.isArray(op.node)) return op.node.slice();
  if (isObject(op.node)) return [op.node];
  return parseFragmentHtml(op.html);
}

function idsWithin(nodes) {
  const ids = [];
  const seen = new Set();
  const walk = (node) => {
    for (const entry of collectEntries(node)) {
      if (!isElement(entry.node)) continue;
      const id = dataIdOf(entry.node);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  for (const node of nodes) {
    if (entryIsElement(node)) {
      const id = dataIdOf(node);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    walk(node);
  }
  return ids;
}

function entryIsElement(node) {
  return isElement(node);
}

function applySet(doc, op) {
  const entry = requireEntry(doc, op.target, op);
  const node = entry.node;
  const inverse = [];
  let next;

  if (op.prop === "text") {
    const children = Array.isArray(node.children) ? node.children : [];
    if (Array.isArray(op.children)) {
      next = { ...node, children: op.children.map((child) => ({ ...child })) };
    } else {
      next = {
        ...node,
        children: [
          {
            kind: "text",
            value: scalarText(op.value, op),
            raw: scalarText(op.value, op),
            parent: null,
            start: -1,
            end: -1,
          },
        ],
      };
    }
    // Undo needs the old children verbatim: an element may hold several text nodes,
    // or text mixed with elements, and no single string brings that back (A5).
    inverse.push(
      children.length === 0
        ? { op: "unset", target: op.target, prop: "text" }
        : { op: "set", target: op.target, prop: "text", value: textOf(children), children },
    );
    return { doc: applyToPath(doc, entry.path, () => next), inverse };
  }

  if (op.prop.startsWith("style:")) {
    const property = op.prop.slice("style:".length);
    if (property === "") {
      throw new OpsError("ops/bad-op", `A "set" op needs a CSS property after "style:"`, { op });
    }
    const attr = attrOf(node, "style");
    const text = attr ? String(attr.value ?? "") : "";
    const declaration = findDeclaration(text, property);
    if (declaration !== null) {
      next = withAttr(node, "style", replaceDeclarationValue(text, declaration, scalarText(op.value, op)));
      inverse.push({ op: "set", target: op.target, prop: op.prop, value: declaration.value });
    } else {
      next = withAttr(node, "style", appendDeclaration(text, property, scalarText(op.value, op)));
      // Writing the whole attribute back is the only exact undo: dropping the new
      // declaration again would also reflow the separators around it (A5).
      inverse.push(
        attr ? { op: "set", target: op.target, prop: "style", value: text } : { op: "unset", target: op.target, prop: "style" },
      );
    }
    return { doc: applyToPath(doc, entry.path, () => next), inverse };
  }

  const value = scalarText(op.value, op);
  if (op.prop.toLowerCase() === "data-id") {
    if (value === "") {
      throw new OpsError("ops/bad-op", `A "set" on "data-id" needs a non-empty value`, { op });
    }
    const clash = entryOfId(doc, value);
    if (clash !== null && clash.node !== node) {
      throw new OpsError("ops/duplicate-id", `data-id ${JSON.stringify(value)} is already taken`, {
        target: op.target,
        duplicate: value,
        op,
      });
    }
    next = withAttr(node, op.prop, value);
    inverse.push({ op: "set", target: value, prop: op.prop, value: op.target });
    return { doc: applyToPath(doc, entry.path, () => next), inverse };
  }

  const existing = attrOf(node, op.prop);
  next = withAttr(node, op.prop, value, op.index);
  if (existing !== null) {
    inverse.push({ op: "set", target: op.target, prop: op.prop, value: String(existing.value ?? "") });
  } else {
    // Removing the attribute again restores the original list exactly, wherever the
    // write put it.
    inverse.push({ op: "unset", target: op.target, prop: op.prop });
  }
  return { doc: applyToPath(doc, entry.path, () => next), inverse };
}

function textOf(children) {
  return children
    .filter((child) => isObject(child) && child.kind === "text")
    .map((child) => String(child.value ?? child.raw ?? ""))
    .join("");
}

function applyUnset(doc, op) {
  const entry = requireEntry(doc, op.target, op);
  const node = entry.node;
  const inverse = [];

  if (op.prop === "text") {
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) {
      throw new OpsError("ops/no-target", `${JSON.stringify(op.target)} has no text to unset`, {
        target: op.target,
        prop: op.prop,
        op,
      });
    }
    inverse.push({ op: "set", target: op.target, prop: "text", value: textOf(children), children });
    return { doc: applyToPath(doc, entry.path, () => ({ ...node, children: [] })), inverse };
  }

  if (op.prop.startsWith("style:")) {
    const property = op.prop.slice("style:".length);
    const attr = attrOf(node, "style");
    const text = attr ? String(attr.value ?? "") : "";
    const declaration = findDeclaration(text, property);
    if (declaration === null) {
      throw new OpsError(
        "ops/no-target",
        `${JSON.stringify(op.target)} has no "${property}" declaration`,
        { target: op.target, prop: op.prop, op },
      );
    }
    const trimmed = removeDeclaration(text, declaration);
    const next = trimmed === "" ? withoutAttr(node, "style") : withAttr(node, "style", trimmed);
    inverse.push({ op: "set", target: op.target, prop: "style", value: text });
    return { doc: applyToPath(doc, entry.path, () => next), inverse };
  }

  const existing = attrOf(node, op.prop);
  if (existing === null) {
    throw new OpsError(
      "ops/no-target",
      `${JSON.stringify(op.target)} has no ${JSON.stringify(op.prop)} attribute`,
      { target: op.target, prop: op.prop, op },
    );
  }
  const at = attrIndexOf(node, op.prop);
  inverse.push({ op: "set", target: op.target, prop: op.prop, value: String(existing.value ?? ""), index: at });
  return { doc: applyToPath(doc, entry.path, () => withoutAttr(node, op.prop)), inverse };
}

function applyInsert(doc, op) {
  const container = requireContainer(doc, op.target, op);
  const parent = container.node;
  const children = Array.isArray(parent.children) ? parent.children : [];

  // The exact-restore form: the op names the child list the parent must end up with.
  if (Array.isArray(op.children)) {
    const known = new Map();
    for (const node of insertNodesFor(op)) {
      const id = dataIdOf(node);
      if (id !== null && !known.has(id)) known.set(id, node);
    }
    return restoreChildren(doc, op, container, known);
  }

  if (op.index > children.length) {
    throw new OpsError(
      "ops/bad-index",
      `Cannot insert at index ${op.index}: ${JSON.stringify(op.target)} has ${children.length} children`,
      { target: op.target, index: op.index, op },
    );
  }

  const incoming = insertNodesFor(op).map((node) => ({ ...node }));
  if (incoming.length === 0) {
    throw new OpsError("ops/bad-op", `An "insert" op's html has no nodes`, { op });
  }

  const index = buildIdIndex(doc);
  const claimed = new Set();
  for (const node of incoming) {
    for (const id of idsWithin([node])) {
      if (index.has(id) || claimed.has(id)) {
        throw new OpsError(
          "ops/duplicate-id",
          `Inserting data-id ${JSON.stringify(id)} would duplicate an existing id`,
          { target: op.target, duplicate: id, op },
        );
      }
      claimed.add(id);
    }
  }

  const nextChildren = [
    ...children.slice(0, op.index),
    ...incoming,
    ...children.slice(op.index),
  ];
  const next = { ...parent, children: nextChildren };
  const inverse = [];
  if (hasAdjacentText(nextChildren)) {
    // A text entry of the fragment can fuse with a text neighbour on the way to
    // disk. Then no index of the written file names where it was, so the undo
    // restores the whole list instead.
    inverse.push({ op: "remove", target: op.target, children: snapshotChildren(children) });
  } else {
    for (let i = incoming.length - 1; i >= 0; i -= 1) {
      const id = dataIdOf(incoming[i]);
      if (id !== null) inverse.push({ op: "remove", target: id });
      else inverse.push({ op: "remove", target: op.target, index: op.index + i });
    }
  }
  return { doc: applyToPath(doc, container.path, () => next), inverse };
}

function applyRemove(doc, op) {
  // The exact-restore form: the op names the child list the parent must end up with,
  // and the node it names is simply not in it.
  if (Array.isArray(op.children)) {
    const container = requireContainer(doc, op.target, op);
    return restoreChildren(doc, op, container, new Map());
  }

  let entry;
  if (hasOwn(op, "index")) {
    const container = requireContainer(doc, op.target, op);
    const children = Array.isArray(container.node.children) ? container.node.children : [];
    if (op.index >= children.length) {
      throw new OpsError(
        "ops/bad-index",
        `Cannot remove index ${op.index}: ${JSON.stringify(op.target)} has ${children.length} children`,
        { target: op.target, index: op.index, op },
      );
    }
    const child = children[op.index];
    entry = { node: child, parent: container.node, index: op.index, path: container.path.concat([{ key: "children", index: op.index }]) };
  } else {
    entry = requireEntry(doc, op.target, op);
    if (entry.parent === null || entry.index < 0) {
      throw new OpsError(
        "ops/bad-op",
        `Cannot remove ${JSON.stringify(op.target)}: it has no parent to be removed from`,
        { target: op.target, op },
      );
    }
  }

  const removed = entry.node;
  const parentAddress = addressOfEntry(doc, entry.parent);
  if (parentAddress === null) {
    throw new OpsError(
      "ops/bad-op",
      `Cannot remove ${JSON.stringify(op.target)}: its parent carries no data-id, so the removal cannot be undone`,
      { target: op.target, op },
    );
  }
  const raw = rawBytesOf(doc, removed);
  const undo = { op: "insert", target: parentAddress, index: entry.index, node: removed };
  if (raw !== null) undo.html = raw;
  const parentChildren = Array.isArray(entry.parent.children) ? entry.parent.children : [];
  if (hasAdjacentText(withoutNode(parentChildren, removed))) {
    // Taking this node out leaves two text nodes side by side, and the write merges
    // them: `index` above would name a different boundary on the way back.
    undo.children = snapshotChildren(parentChildren);
  }
  return {
    doc: applyToPath(doc, entry.path, () => REMOVE),
    inverse: [undo],
  };
}

/** The address that reaches `node`: its data-id, or a reserved container word. */
function addressOfEntry(doc, node) {
  if (node === doc) return "document";
  const id = dataIdOf(node);
  if (id !== null) return id;
  if (isElement(node) && RESERVED_CONTAINERS.includes(node.tag)) {
    const slot = node.tag === "html" ? doc.html : node.tag === "head" ? doc.head : node.tag === "body" ? doc.body : null;
    if (slot === node) return node.tag;
    for (const entry of collectEntries(doc)) {
      if (entry.node === node) return node.tag;
    }
  }
  return null;
}

function applyMove(doc, op) {
  const source = requireEntry(doc, op.target, op);

  // The exact-restore form: the op names the child list the parent must end up with,
  // and the node it names is already in that list.
  if (Array.isArray(op.children)) {
    return restoreMove(doc, op, source);
  }

  const sourceParent = source.parent;
  const sourceIndex = source.index;
  if (sourceParent === null || sourceIndex < 0) {
    throw new OpsError(
      "ops/bad-op",
      `Cannot move ${JSON.stringify(op.target)}: it is not a child of anything`,
      { target: op.target, op },
    );
  }
  const parentAddress = addressOfEntry(doc, sourceParent);
  if (parentAddress === null) {
    throw new OpsError(
      "ops/bad-op",
      `Cannot move ${JSON.stringify(op.target)}: its parent carries no data-id, so the move cannot be undone`,
      { target: op.target, op },
    );
  }

  const sourcePath = source.path;
  const insideSource = (path) =>
    path.length > sourcePath.length &&
    sourcePath.every((step, i) => step.key === path[i].key && step.index === path[i].index);

  // Where the node goes, expressed in the array *after* the removal, because that is
  // the array `move` inserts into. `before`/`after` name a sibling in the array as it
  // looks now, so a sibling that sat behind the source shifts down by one.
  let destAddress;
  let destIndex;
  let sameParent;
  let limit;

  if (op.into !== undefined) {
    const dest = resolveAddress(doc, op.into);
    if (dest === null) {
      throw new OpsError("ops/node-not-found", `No node with data-id ${JSON.stringify(op.into)}`, {
        target: op.into,
        op,
      });
    }
    if (dest.node === source.node || insideSource(dest.path)) {
      throw new OpsError("ops/bad-op", `Cannot move ${JSON.stringify(op.target)} inside itself`, {
        target: op.target,
        op,
      });
    }
    if (dest.node !== doc) assertHoldsChildren(dest.node, op.into, op);
    sameParent = dest.node === sourceParent;
    const children = Array.isArray(dest.node.children) ? dest.node.children : [];
    limit = sameParent ? children.length - 1 : children.length;
    destIndex = hasOwn(op, "index") ? op.index : limit;
    destAddress = op.into;
  } else if (op.before !== undefined || op.after !== undefined) {
    const siblingAddress = op.before !== undefined ? op.before : op.after;
    const sibling = requireEntry(doc, siblingAddress, op);
    if (sibling.parent === null || sibling.index < 0) {
      throw new OpsError("ops/bad-op", `${JSON.stringify(siblingAddress)} has no parent`, { op });
    }
    if (sibling.node === source.node) {
      throw new OpsError("ops/bad-op", `Cannot move ${JSON.stringify(op.target)} relative to itself`, {
        target: op.target,
        op,
      });
    }
    if (insideSource(sibling.path)) {
      throw new OpsError("ops/bad-op", `Cannot move ${JSON.stringify(op.target)} inside itself`, {
        target: op.target,
        op,
      });
    }
    sameParent = sibling.parent === sourceParent;
    destAddress = addressOfEntry(doc, sibling.parent);
    if (destAddress === null) {
      throw new OpsError(
        "ops/bad-op",
        `Cannot move ${JSON.stringify(op.target)} next to ${JSON.stringify(siblingAddress)}: that parent carries no data-id`,
        { target: op.target, op },
      );
    }
    const siblings = Array.isArray(sibling.parent.children) ? sibling.parent.children : [];
    limit = sameParent ? siblings.length - 1 : siblings.length;
    destIndex = op.before !== undefined ? sibling.index : sibling.index + 1;
    if (sameParent && sourceIndex < destIndex) destIndex -= 1;
  } else {
    sameParent = true;
    destAddress = parentAddress;
    const siblings = Array.isArray(sourceParent.children) ? sourceParent.children : [];
    limit = siblings.length - 1;
    destIndex = op.index;
  }

  if (destIndex > limit) {
    throw new OpsError(
      "ops/bad-index",
      `Cannot move to index ${destIndex}: ${JSON.stringify(destAddress)} has ${limit} slot${limit === 1 ? "" : "s"} after the removal`,
      { target: op.target, index: destIndex, op },
    );
  }

  // Remove, then insert: resolving the destination again after the removal is what
  // keeps the second half honest when the source sat in the same array.
  const stripped = applyToPath(doc, sourcePath, () => REMOVE);
  const container = resolveAddress(stripped, destAddress);
  if (container === null) {
    throw new OpsError(
      "ops/node-not-found",
      `Cannot re-reach ${JSON.stringify(destAddress)} after removing ${JSON.stringify(op.target)}`,
      { target: op.target, op },
    );
  }
  const children = Array.isArray(container.node.children) ? container.node.children : [];
  if (destIndex > children.length) {
    throw new OpsError(
      "ops/bad-index",
      `Cannot move to index ${destIndex}: ${JSON.stringify(destAddress)} has ${children.length} children left`,
      { target: op.target, index: destIndex, op },
    );
  }
  const nextChildren = [...children.slice(0, destIndex), source.node, ...children.slice(destIndex)];
  const rebuilt = applyToPath(stripped, container.path, () => ({ ...container.node, children: nextChildren }));

  const inverse = [{ op: "move", target: op.target, into: parentAddress, index: sourceIndex }];
  if (hasAdjacentText(withoutNode(sourceParent.children, source.node))) {
    // Lifting this node out leaves two text nodes side by side, and the write merges
    // them: the index above would name a different boundary on the way back.
    inverse[0].children = snapshotChildren(sourceParent.children);
  }
  return { doc: rebuilt, inverse };
}

/**
 * Put a node back into a parent whose child list the op names outright.
 *
 * The list is authoritative: it says where the node goes, text and all. That is the
 * only way back once a write has merged the two text nodes the node used to sit
 * between — the information is not in the file any more, so it has to travel in the
 * op.
 */
function restoreMove(doc, op, source) {
  const parentAddress = typeof op.into === "string" && op.into !== ""
    ? op.into
    : addressOfEntry(doc, source.parent);
  if (parentAddress === null) {
    throw new OpsError(
      "ops/bad-op",
      `Cannot restore ${JSON.stringify(op.target)}: its parent carries no data-id`,
      { target: op.target, op },
    );
  }
  requireContainer(doc, parentAddress, op);

  const known = new Map([[op.target, source.node]]);
  const stripped = applyToPath(doc, source.path, () => REMOVE);
  const container = resolveAddress(stripped, parentAddress);
  if (container === null) {
    throw new OpsError(
      "ops/node-not-found",
      `Cannot re-reach ${JSON.stringify(parentAddress)} after removing ${JSON.stringify(op.target)}`,
      { target: op.target, op },
    );
  }
  const before = Array.isArray(container.node.children) ? container.node.children : [];
  const restored = materializeChildren(stripped, op.children, known, op);
  const at = restored.indexOf(source.node);
  const next = applyToPath(stripped, container.path, () => ({ ...container.node, children: restored }));
  return {
    doc: next,
    inverse: [
      {
        op: "move",
        target: op.target,
        into: parentAddress,
        index: at < 0 ? before.length : at,
        children: snapshotChildren(before),
      },
    ],
  };
}

function applyOne(doc, op) {
  switch (op.op) {
    case "set":
      return applySet(doc, op);
    case "unset":
      return applyUnset(doc, op);
    case "insert":
      return applyInsert(doc, op);
    case "remove":
      return applyRemove(doc, op);
    case "move":
      return applyMove(doc, op);
    default:
      throw new OpsError("ops/bad-op", `Unknown op ${JSON.stringify(op.op)}`, { op });
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Apply ops to a document and return the ops that undo them.
 *
 * `doc` is untouched; the returned document shares no object with it (A7). The
 * inverse list is flattened in reverse order, so
 * `applyOps(applyOps(doc, ops).doc, inverse).doc` is the original document again.
 *
 * Every op runs against the tree the previous op produced: an `insert` followed by a
 * `set` on the inserted id works, and an id renamed by one op is the id the next op
 * must use.
 *
 * @returns {{doc: object, inverse: object[], applied: object[]}}
 */
export function applyOps(doc, ops) {
  if (!isDocumentLike(doc)) {
    throw new OpsError(
      "ops/no-doc",
      `Expected a document, got ${doc === null ? "null" : typeof doc}`,
    );
  }
  if (!Array.isArray(ops)) {
    throw new OpsError("ops/bad-op", `Ops must be an array, got ${typeof ops}`);
  }

  let current = doc;
  const applied = [];
  const inverses = [];

  for (let i = 0; i < ops.length; i += 1) {
    const op = normalizeOp(ops[i]);
    let result;
    try {
      result = applyOne(current, op);
    } catch (err) {
      if (err instanceof OpsError) {
        err.opIndex = i;
        err.op = op;
      }
      throw err;
    }
    current = result.doc;
    inverses.push(result.inverse);
    applied.push(op);
  }

  const flat = [];
  for (let i = inverses.length - 1; i >= 0; i -= 1) flat.push(...inverses[i]);
  return { doc: detach(current, undefined, new WeakMap()), inverse: flat, applied };
}

/* ------------------------------------------------------------------ *
 * Helpers the canvas and the fragment compiler use
 * ------------------------------------------------------------------ */

function childCount(doc, address) {
  const entry = resolveAddress(doc, address);
  if (entry === null) return 0;
  return Array.isArray(entry.node.children) ? entry.node.children.length : 0;
}

function inferParentId(doc, target) {
  const index = buildIdIndex(doc);
  const marker = target.indexOf("__");
  if (marker > 0) {
    const prefix = target.slice(0, marker);
    if (index.has(prefix)) return prefix;
  }
  let lastPage = null;
  for (const entry of collectEntries(doc)) {
    if (isElement(entry.node) && dataTypeOf(entry.node) === "page") {
      const id = dataIdOf(entry.node);
      if (id !== null) lastPage = id;
    }
  }
  return lastPage;
}

/**
 * The smallest op list that writes `value` at `target`'s `prop`.
 *
 * With the node present that is one `set`: `set` creates the attribute or the
 * declaration when it is not there yet, so there is no "parent path" to build.
 *
 * With the node absent there is nothing to set, and the smallest list that still
 * works is the node itself plus the write: an `insert` of a minimal element carrying
 * that `data-id` and a `data-type`, then the `set`. A `text` write makes a `<p>`,
 * anything else a `<div>`. The parent is the id before `__` when it exists
 * (`home__cta` → `home`), else the last page. With no page anywhere the target
 * cannot be placed and this throws `ops/no-target` (A8).
 *
 * @returns {object[]} ops, ready for `applyOps`
 */
export function setOpFor(doc, target, prop, value) {
  if (typeof target !== "string" || target === "") {
    throw new OpsError("ops/bad-op", `A target must be a non-empty data-id string`);
  }
  if (typeof prop !== "string" || prop === "") {
    throw new OpsError("ops/bad-op", `A prop must be a non-empty string`);
  }
  const index = buildIdIndex(doc);
  if (index.has(target)) return [{ op: "set", target, prop, value }];

  const parent = inferParentId(doc, target);
  if (parent === null) {
    throw new OpsError(
      "ops/no-target",
      `No node with data-id ${JSON.stringify(target)}, and no page to create it in`,
      { target },
    );
  }
  const id = escapeAttrValue(target);
  const html =
    prop === "text"
      ? `<p data-id="${id}" data-type="text"></p>`
      : `<div data-id="${id}" data-type="frame"></div>`;
  return [
    { op: "insert", target: parent, index: childCount(doc, parent), html },
    { op: "set", target, prop, value },
  ];
}
