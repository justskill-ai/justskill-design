/**
 * lib/render.mjs — the document tree to what the canvas mounts.
 *
 * The renderer is shared by the canvas and by `export`. That is the whole point:
 * what the user drags is what ships. A separate "preview renderer" is how a
 * design tool ends up with two truths.
 *
 * Browser-safe on purpose. The canvas parses and renders the file itself, so the
 * service never has to send a document tree over the wire and the two sides
 * cannot disagree about what the file means.
 *
 * What the renderer does:
 *   - resolves `var(--token)` from the file's token block
 *   - inlines the token block into each page's scope
 *   - expands component instances into the component's subtree plus overrides
 *   - positions pages with the page-frame block and `data-canvas`
 *   - keeps every element's `data-id`, so the canvas can map a click to an op
 *
 * What it does not do:
 *   - it does not rewrite the design file. A mount is a view.
 *   - it does not inject canvas chrome into the design markup. The canvas puts
 *     its own styles in its own document, and each page gets a shadow root.
 *
 * Pure. No node: imports.
 */

import { parse, getAttr, pagesOf, walk, elementChildren, textOf, VOID_ELEMENTS } from "./parse.mjs";
import { collectTokens } from "./validate.mjs";
import { CSS_ALLOWED, splitTopLevel } from "./table.mjs";

export const LIBRARY_PAGE_ATTR = "data-library";

// -- escaping ----------------------------------------------------------------

const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };

export function escapeText(value) {
  return String(value ?? "").replace(/[&<>]/g, (ch) => TEXT_ESCAPES[ch]);
}

export function escapeAttr(value) {
  return String(value ?? "").replace(/[&"<>]/g, (ch) => ATTR_ESCAPES[ch]);
}

// -- style -------------------------------------------------------------------

/** The `style` attribute, as a property to value map. Last declaration wins. */
export function styleMapOf(node) {
  const raw = getAttr(node, "style");
  const out = new Map();
  if (raw === null) return out;
  for (const declaration of parseDeclarationsCached(raw)) {
    if (declaration.property) out.set(declaration.property, declaration.value);
  }
  return out;
}

const declarationCache = new Map();

function parseDeclarationsCached(text) {
  if (declarationCache.has(text)) return declarationCache.get(text);
  const out = parseDeclarationsLocal(text);
  if (declarationCache.size > 5000) declarationCache.clear();
  declarationCache.set(text, out);
  return out;
}

/**
 * A local declaration splitter.
 *
 * It duplicates the parser's `parseDeclarations` on purpose: this module is
 * imported by the canvas, and reaching back into `parse.mjs` for a helper it
 * already exports would be a cycle. The two are pinned against each other by
 * `test/render.test.mjs`, which fails if they ever disagree on a data URI.
 */
function parseDeclarationsLocal(text) {
  const source = String(text ?? "");
  const out = [];
  let start = 0;
  let quote = null;
  let comment = false;
  let depth = 0;

  const emit = (from, to) => {
    const raw = source.slice(from, to);
    if (!raw.trim()) return;
    let d = 0;
    let q = null;
    let colon = -1;
    for (let k = 0; k < raw.length; k += 1) {
      const ch = raw[k];
      if (q) {
        if (ch === "\\") { k += 1; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === "(") { d += 1; continue; }
      if (ch === ")") { d = Math.max(0, d - 1); continue; }
      if (ch === ":" && d === 0) { colon = k; break; }
    }
    if (colon === -1) return;
    // The parser strips comments from a value, so this must too: a disagreement
    // here means the canvas shows a different value than the validator checked.
    out.push({
      property: raw.slice(0, colon).trim().toLowerCase(),
      value: raw.slice(colon + 1).replace(/\/\*[\s\S]*?\*\//g, " ").trim(),
    });
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (comment) {
      if (ch === "*" && source[i + 1] === "/") { comment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") { comment = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (ch === ";" && depth === 0) { emit(start, i); start = i + 1; }
  }
  emit(start, source.length);
  return out;
}

/** Serialize a property map back to a `style` attribute value, in table order. */
export function styleStringOf(map) {
  const entries = [...map.entries()].filter(([, value]) => value !== undefined && value !== null && value !== "");
  entries.sort((a, b) => {
    const ai = EMIT.indexOf(a[0]);
    const bi = EMIT.indexOf(b[0]);
    if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a[0] < b[0] ? -1 : 1;
  });
  return entries.map(([p, v]) => `${p}:${v}`).join(";");
}

const EMIT = Object.keys(CSS_ALLOWED);

/** Replace `var(--name)` with the token's value, following the chain. */
export function resolveTokens(cssValue, tokens, depth = 0) {
  if (depth > 16) return cssValue;
  const text = String(cssValue ?? "");
  if (!text.includes("var(")) return text;
  return text.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
    const token = tokens.get(name);
    if (!token) return fallback !== undefined ? fallback.trim() : whole;
    return resolveTokens(token.value, tokens, depth + 1);
  });
}

/** `data-canvas="x,y"`, or null when the page has no stated position. */
export function canvasPositionOf(node) {
  const raw = getAttr(node, "data-canvas");
  if (raw === null) return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

// -- instances ---------------------------------------------------------------

export class RenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

/** Every `data-type="component"` in the file, by `data-id`. */
export function componentMap(doc) {
  const components = new Map();
  walk(doc, (node) => {
    if (node.kind !== "element") return;
    if (getAttr(node, "data-type") !== "component") return;
    const id = getAttr(node, "data-id");
    if (id) components.set(id, node);
  });
  return components;
}

function cloneTree(node) {
  if (node.kind === "text") return { kind: "text", value: node.value, raw: node.raw };
  if (node.kind === "comment" || node.kind === "doctype") return { kind: node.kind, raw: node.raw };
  return {
    kind: "element",
    tag: node.tag,
    rawTag: node.rawTag,
    selfClosing: node.selfClosing,
    attrs: (node.attrs || []).map((a) => ({ ...a })),
    children: (node.children || []).map(cloneTree),
  };
}

function findDescendant(root, id) {
  let found = null;
  walk(root, (node) => {
    if (found || node.kind !== "element") return;
    if (getAttr(node, "data-id") === id) found = node;
  });
  return found;
}

function setAttrValue(node, name, value) {
  const found = (node.attrs || []).find((a) => a.name === name);
  if (found) {
    found.value = value;
    return;
  }
  node.attrs = node.attrs || [];
  node.attrs.push({ kind: "attr", name, rawName: name, value, quote: '"' });
}

function mergeStyle(node, styleText) {
  if (!styleText) return;
  const map = new Map();
  for (const [p, v] of styleMapOf(node)) map.set(p, v);
  for (const declaration of parseDeclarationsLocal(styleText)) map.set(declaration.property, declaration.value);
  setAttrValue(node, "style", styleStringOf(map));
}

/**
 * `resolve(instance) = applyOverrides(deepClone(component), overrides)`.
 *
 * The file stores only the reference. Expansion happens here, on the way to a
 * mount, so the component stays the single source of truth and a `data-id`
 * never has to be invented for a copy.
 */
export function expandInstance(instance, components, options = {}) {
  const ref = getAttr(instance, "data-ref");
  const depth = options.depth ?? 0;
  if (depth > 16) {
    throw new RenderError("render/ref-depth", `Instances nest more than 16 deep at ${ref}.`);
  }
  const component = components.get(ref);
  if (!component) {
    throw new RenderError("render/unknown-ref", `No component has the data-id ${ref}.`);
  }

  const copy = cloneTree(component);

  // The instance's own identity, name and state land on the component root.
  const instanceId = getAttr(instance, "data-id");
  if (instanceId) setAttrValue(copy, "data-id", instanceId);
  setAttrValue(copy, "data-type", "instance");
  for (const name of ["data-name", "data-hidden", "data-locked", "data-ref"]) {
    const value = getAttr(instance, name);
    if (value !== null) setAttrValue(copy, name, value);
  }
  const instanceStyle = getAttr(instance, "style");
  if (instanceStyle) {
    const map = new Map();
    for (const [p, v] of styleMapOf(copy)) map.set(p, v);
    for (const declaration of parseDeclarationsLocal(instanceStyle)) map.set(declaration.property, declaration.value);
    setAttrValue(copy, "style", styleStringOf(map));
  }

  const overridesText = getAttr(instance, "data-overrides");
  if (overridesText) {
    let overrides;
    try {
      overrides = JSON.parse(overridesText);
    } catch {
      throw new RenderError("render/bad-overrides", `data-overrides on ${instanceId} is not JSON.`);
    }
    for (const [targetId, fields] of Object.entries(overrides)) {
      if (!fields || typeof fields !== "object") continue;
      const target = findDescendant(copy, targetId);
      if (!target) continue;
      applyOverrideFields(target, fields);
    }
  }

  // Nested instances resolve too, so a component made of components works.
  resolveChildren(copy, components, depth + 1, options);
  return copy;
}

function applyOverrideFields(node, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === "content") {
      const textChildren = (node.children || []).filter((c) => c.kind === "text");
      if (textChildren.length) {
        textChildren[0].value = String(value);
        textChildren[0].raw = String(value);
      } else {
        node.children = [{ kind: "text", value: String(value), raw: String(value) }];
      }
      continue;
    }
    // A glyph is geometry in this format, so one instance swapping its icon
    // ships the new geometry. `content` is text, and text inside an `<svg>` that
    // is not inside a `<text>` draws nothing — which is how eight tiles on the
    // home page became eight empty boxes.
    if (key === "children") {
      node.children = childrenFromMarkup(String(value));
      continue;
    }
    if (key === "style") {
      mergeStyle(node, String(value));
      continue;
    }
    if (key.startsWith("data-")) {
      setAttrValue(node, key, String(value));
    }
  }
}

/** The nodes a markup string describes, for an override that replaces children. */
function childrenFromMarkup(markup) {
  const doc = parse(markup);
  return (doc.children || []).filter((child) => child.kind === "element" || child.kind === "text");
}

/** Replace every instance in a subtree with its expansion, in place. */
export function resolveChildren(node, components, depth = 0, options = {}) {
  const out = [];
  for (const child of node.children || []) {
    if (child.kind !== "element") {
      out.push(child);
      continue;
    }
    if (getAttr(child, "data-type") === "instance") {
      const expanded = expandInstance(child, components, { ...options, depth });
      out.push(expanded);
      continue;
    }
    resolveChildren(child, components, depth, options);
    out.push(child);
  }
  node.children = out;
  return node;
}

// -- the render model --------------------------------------------------------

/**
 * Build the render model for a parsed document.
 *
 * @param {object} doc
 * @param {object} options `{ resolveTokens: boolean, expandInstances: boolean }`
 * @returns {{ pages: Array, tokens: Map, diagnostics: Array, pageFrame: string }}
 */
export function renderModel(doc, options = {}) {
  const { tokens } = collectTokens(doc);
  const components = options.expandInstances === false ? new Map() : componentMap(doc);
  const pages = [];
  let index = 0;

  for (const node of pagesOf(doc)) {
    const id = getAttr(node, "data-id") || `page-${index}`;
    const map = styleMapOf(node);
    const width = map.get("width") || "auto";
    const height = map.get("height") || "auto";
    const isLibrary = getAttr(node, LIBRARY_PAGE_ATTR) === "true";

    const copy = cloneTree(node);
    try {
      if (options.expandInstances !== false) resolveChildren(copy, components, 0, options);
    } catch (error) {
      // A broken reference must not blank the whole canvas. The page still
      // mounts, and the instance renders as an empty box with its id, so the
      // user can see where the problem is.
      copy.__renderError = error.code || "render/error";
    }

    // The page's own declarations move to the page box, and the section keeps
    // only what positions it on the canvas.
    const boxStyle = new Map();
    for (const [property, value] of map) boxStyle.set(property, value);
    boxStyle.set("position", "absolute");
    const position = canvasPositionOf(node);
    if (position) {
      boxStyle.set("left", `${position.x}px`);
      boxStyle.set("top", `${position.y}px`);
    }
    if (boxStyle.get("overflow") === undefined) boxStyle.set("overflow", "hidden");

    pages.push({
      id,
      name: getAttr(node, "data-name") || id,
      isLibrary,
      width,
      height,
      position,
      index,
      boxStyle: styleStringOf(boxStyle),
      declarations: map,
      // Built from the COPY, not from `node`. The copy is where the instances
      // were expanded; rendering the original would mount the reference and
      // silently drop the component's subtree.
      markup: copy.children.map((child) => renderNodeHtml(child, tokens, options)).join(""),
      node: copy,
    });
    index += 1;
  }

  return {
    pages,
    tokens,
    components,
    diagnostics: doc.diagnostics || [],
    pageFrame: pageFrameRule(doc),
    // Every rule the file states about itself, in document order. A shadow root
    // cannot see the document's stylesheets, so the canvas has to put them in
    // the page's own root — and it must put in exactly these, not a reset of its
    // own invention. A canvas that invents rules renders a document the file
    // does not describe.
    styleText: styleTextOf(doc),
  };
}

/** The text of every `<style>` block in the document, in order. */
export function styleTextOf(doc) {
  return (doc.styleBlocks || []).map((block) => block.text ?? "").filter(Boolean).join("\n");
}

/**
 * The same CSS with the `:root{…}` rule removed.
 *
 * `:root` matches no element inside a shadow root, so keeping the rule would
 * define the tokens nowhere. The canvas declares them on `:host` instead; see
 * `pageCss`.
 */
export function withoutRootRule(cssText) {
  const text = String(cssText ?? "");
  let out = "";
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf(":root", index);
    if (at === -1) {
      out += text.slice(index);
      break;
    }
    const open = text.indexOf("{", at);
    if (open === -1) {
      out += text.slice(index);
      break;
    }
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, at);
    index = close + 1;
  }
  return out.replace(/\n{2,}/g, "\n").trim();
}

/** The page-frame rule, as the file declares it. */
export function pageFrameRule(doc) {
  for (const block of doc.styleBlocks || []) {
    if (block.role === "page-frame" || block.role === "tokens+page-frame") {
      const match = /section\s*\[\s*data-type\s*=\s*["']?page["']?\s*\]\s*\{([^}]*)\}/.exec(block.text);
      if (match) return match[1].trim();
    }
  }
  return "margin:0 0 24px";
}

/**
 * Render one node as HTML for a mount.
 *
 * The element keeps its tag, its `data-*` attributes and its inline style. That
 * is what makes the canvas able to map a clicked element straight back to its
 * `data-id`, and what makes "what you see" the same bytes as "what you export".
 */
export function renderNodeHtml(node, tokens, options = {}) {
  if (node.kind === "text") return escapeText(node.value);
  if (node.kind === "comment") return node.raw || "";
  if (node.kind === "doctype") return "";
  if (node.kind !== "element") return "";

  const attrs = [];
  for (const attr of node.attrs || []) {
    if (attr.name === "style") continue;
    if (attr.value === null || attr.value === undefined) {
      attrs.push(attr.rawName || attr.name);
      continue;
    }
    attrs.push(`${attr.rawName || attr.name}="${escapeAttr(attr.value)}"`);
  }

  const styleText = styleForMount(node, tokens, options);
  if (styleText) attrs.push(`style="${escapeAttr(styleText)}"`);

  const name = node.tag;
  const head = attrs.length ? `<${name} ${attrs.join(" ")}>` : `<${name}>`;
  const body = (node.children || []).map((child) => renderNodeHtml(child, tokens, options)).join("");
  if (VOID_ELEMENTS.has(name)) {
    // A void element cannot hold children. A hand-written file may still put
    // them there, so they are emitted after the void element rather than
    // dropped: a mount must show everything the file contains.
    return `${head}${body}`;
  }
  return `${head}${body}</${name}>`;
}

/** The inline style a mounted element carries, with tokens resolved or kept. */
export function styleForMount(node, tokens, options = {}) {
  const map = styleMapOf(node);
  if (map.size === 0) return "";
  if (options.resolveTokens === false) return styleStringOf(map);
  const out = new Map();
  for (const [property, value] of map) out.set(property, resolveTokens(value, tokens));
  return styleStringOf(out);
}

/**
 * The full CSS for one page's shadow root.
 *
 * A shadow root is what lets the canvas put a page's tokens and page-frame rule
 * in exactly one scope, without either leaking into the canvas chrome. It is
 * also why the canvas never has to write its own styles into the design file.
 *
 * The rules are the FILE's rules. A canvas that injects a reset of its own makes
 * the file mean one thing on the canvas and another thing in a browser, and the
 * author finds out at export time. So the only rule added here is what a shadow
 * root needs and a document does not: `:host`.
 */
export function pageCss(model, options = {}) {
  const parts = [];
  // `all: initial` first, and it is not decoration. An inherited property crosses
  // a shadow boundary: the canvas chrome sets `line-height: 1.5` on the document
  // so its own panels read well, the page's elements inherit it through the host,
  // and every label on the canvas is a pixel taller than the same label in the
  // file. Nothing in the page can override an inheritance it never declared.
  //
  // The two declarations after it are what a mount needs and a document gets for
  // free: a block box, and a positioning context for the overlay.
  parts.push(":host{all:initial;display:block;position:relative}");
  // `:root` matches nothing in a shadow tree, so the token values go on the host
  // element. The rest of the file's CSS is copied as it stands.
  const declarations = [...(model.tokens ?? new Map()).entries()].map(([name, token]) => `${name}:${token.value}`).join(";");
  if (declarations) parts.push(`:host{${declarations}}`);
  const rules = withoutRootRule(model.styleText ?? "");
  if (rules) parts.push(rules);
  else parts.push(`section[data-type="page"]{${model.pageFrame || ""}}`);
  return parts.join("\n");
}

/**
 * What the canvas injects into a page's shadow root: the file's rules, plus the
 * one rule that belongs to the canvas.
 *
 * Where a page sits is the canvas's business. `data-canvas` says where, and the
 * page box is the paper the page is drawn on. A page's outer margin is the
 * document flow's business: it is what separates one page from the next when the
 * file is opened in a browser. On the canvas it is nothing, and left in place it
 * escapes the mount and the paper grows by it — the chrome then paints a 24px
 * band under every page whose own background is not white. No reader of the file
 * ever sees that band and the file does not describe it. So the canvas states
 * the one thing it owns, after the file's rules, and nothing else.
 */
export function canvasMountCss(model, options = {}) {
  return [pageCss(model, options), 'section[data-type="page"]{margin:0}'].join("\n");
}

/** The page box style for a page that sits on the canvas. */
export function pageBoxStyle(page) {
  const map = new Map();
  for (const declaration of parseDeclarationsLocal(page.boxStyle)) map.set(declaration.property, declaration.value);
  return styleStringOf(map);
}

/**
 * Where a page sits, with a fallback when the file states no position.
 * The canvas uses this when `data-canvas` is absent, so a fresh file is not a
 * pile of pages at the same spot.
 */
export function arrangePages(pages, options = {}) {
  const gap = options.gap ?? 48;
  const perRow = options.perRow ?? 4;
  let nextX = 0;
  let nextY = 0;
  let rowHeight = 0;
  let column = 0;
  return pages.map((page) => {
    if (page.position) return page.position;
    const width = parseFloat(page.width) || 390;
    const height = parseFloat(page.height) || 844;
    if (column >= perRow) {
      column = 0;
      nextX = 0;
      nextY += rowHeight + gap;
      rowHeight = 0;
    }
    const position = { x: nextX, y: nextY };
    nextX += width + gap;
    rowHeight = Math.max(rowHeight, height);
    column += 1;
    return position;
  });
}

/**
 * Font families a page uses that a browser does not already have.
 *
 * A design may name a family the machine does not have installed. Without a
 * stylesheet the browser falls back, and the fallback has different metrics: the
 * same text wraps at a different word and every box below it moves. That is not
 * a cosmetic difference, it is a layout difference, and it is why the reference
 * renders of an imported file disagreed with us while their total heights still
 * matched.
 *
 * The list is what the file declares, resolved through its tokens. Nothing is
 * appended: docs/format-v3.md §2.3 says a font family is written as given.
 */
export function webfontFamilies(model) {
  const found = new Map();
  const families = (value) => splitTopLevel(String(value ?? ""), ",")
    .map((part) => decodeQuoteEntities(String(part).trim()).replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);

  const visit = (node) => {
    if (node.kind === "element") {
      const style = styleMapOf(node).get("font-family");
      if (style) {
        for (const family of families(resolveTokens(style, model.tokens))) {
          if (!SYSTEM_FAMILIES.has(family.toLowerCase())) found.set(family, family);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const page of model.pages) visit(page.node);
  return [...found.values()].sort();
}

/**
 * One stylesheet URL per family, asking only for the weights a page uses.
 *
 * A family with no weights is still requested: the browser needs the family
 * before it can pick a weight at all. The canvas asks for the same fonts the
 * export declares, because the two must render the same file at the same text
 * widths — otherwise the author ships a layout they never saw.
 */
export function webfontLinks(model, page) {
  const families = webfontFamilies(model);
  if (families.length === 0) return [];
  const weights = new Set();
  const visit = (node) => {
    if (node?.kind === "element") {
      const weight = styleMapOf(node).get("font-weight");
      if (weight && /^\d{3}$/.test(weight)) weights.add(Number(weight));
    }
    for (const child of node?.children ?? []) visit(child);
  };
  // No page means the whole file. The canvas mounts every page at once, so it
  // asks once for the union; asking per page would register the same family and
  // weight from several subset files, and the browser would then have two
  // `@font-face` rules for one face. `export` passes a page, because a
  // deliverable should request only what it renders.
  if (page) visit(page.node);
  else for (const each of model.pages ?? []) visit(each.node);
  const axis = [...weights].sort((a, b) => a - b);
  return families.map((family) => {
    const name = family.replace(/\s+/g, "+");
    const query = axis.length ? `:wght@${axis.join(";")}` : "";
    return `https://fonts.googleapis.com/css2?family=${name}${query}&display=swap`;
  });
}

const SYSTEM_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif",
  "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
  "-apple-system", "blinkmacsystemfont", "segoe ui", "helvetica", "helvetica neue",
  "arial", "roboto", "inter", "noto sans", "noto serif", "pingfang sc", "hiragino sans gb",
  "microsoft yahei", "simsun", "simhei", "wenquanyi micro hei", "source han sans sc",
]);

function decodeQuoteEntities(value) {
  return value.replace(/&(?:quot|#0*34|#x0*22);/gi, '"').replace(/&(?:apos|#0*39|#x0*27);/gi, "'");
}

/** Convenience for a caller that only has text. */
export function renderText(text, options = {}) {
  return renderModel(parse(text), options);
}

/**
 * Elements in a page, for the layer tree.
 *
 * The inside of an `<svg>` is not listed. It is the opaque layer: `<path>`,
 * `<circle>` and `<title>` are how one glyph draws itself, not nodes a user can
 * select, and listing them buries the real structure under a hundred rows of
 * geometry. The glyph's own `<svg>` is listed, with its name.
 */
export function pageTree(node, depth = 0, out = [], insideSvg = false) {
  for (const child of elementChildren(node)) {
    if (insideSvg) continue;
    const isGlyph = child.tag === "svg";
    out.push({
      id: getAttr(child, "data-id"),
      type: getAttr(child, "data-type"),
      tag: child.tag,
      name: getAttr(child, "data-name"),
      depth,
      hidden: getAttr(child, "data-hidden") === "true",
      childCount: isGlyph ? 0 : elementChildren(child).length,
      text: textOf(child).trim().slice(0, 60),
    });
    pageTree(child, depth + 1, out, isGlyph);
  }
  return out;
}
