/**
 * lib/export-html.mjs — a design file to a deliverable.
 *
 * A design file is already valid HTML, so "export" is mostly subtraction: take
 * one page out, drop the design layer's bookkeeping, and make the result stand
 * on its own.
 *
 * What the deliverable keeps:
 *   - the design's own tags, text and inline styles
 *   - the token block, unless `resolveTokens` bakes the values into the styles
 *   - the page's size, as a viewport meta so a browser renders it at that size
 *
 * What it drops:
 *   - `data-id`, `data-type` and every other `data-*` marker. The design layer
 *     is scaffolding for editing, not part of the page.
 *   - the page-frame rule, which exists so a file with several pages reads as a
 *     list. One page does not need it.
 *   - `<title>` and `<meta name="design-schema">` are replaced: a deliverable
 *     needs the page's name, not the file's schema marker.
 *
 * The renderer is shared with the canvas, so what a user dragged is what lands
 * in the file. There is no second implementation to drift.
 *
 * Pure. No node: imports.
 */

import { renderModel, escapeText, escapeAttr } from "./render.mjs";
import { parseDeclarations } from "./parse.mjs";
import { compareProperties } from "./table.mjs";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ATTR_ESCAPES = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };
const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Attributes that belong to the design layer, not to the deliverable. */
const DESIGN_ATTRS = /^data-(id|type|canvas|library|name|hidden|locked|kind|icon|icon-library|ref|overrides|credit)$/;

export class ExportError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = "ExportError";
    this.code = code;
    this.hint = hint;
  }
}

export function renderPageHtml(model, page, options = {}) {
  const resolveTokens = options.resolveTokens === true;
  const renderOptions = { resolveTokens };
  const body = renderNodeHtml(page.node, model.tokens, renderOptions, options);

  const head = [];
  head.push('<meta charset="utf-8">');
  head.push(`<title>${escapeText(page.name)}</title>`);
  head.push(`<meta name="viewport" content="width=${cssLength(page.width)}, height=${cssLength(page.height)}">`);

  const styles = [];
  if (!resolveTokens) {
    // The tokens live in the file's <head>, not on the page, and every
    // `var(--x)` in the page refers to them. Dropping the block would leave the
    // deliverable with a broken color on every element that used one — and it
    // would look fine in the canvas, which is the worst kind of bug.
    const declarations = tokenDeclarations(model, page.node);
    if (declarations) styles.push(`:root{${declarations}}`);
  }
  styles.push(resetCss());
  head.push(`<style>${styles.join("\n")}</style>`);

  return `<!doctype html>
<html lang="${escapeAttr(options.lang ?? "zh")}">
<head>
${head.map((line) => `  ${line}`).join("\n")}
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The `:root` declarations for a deliverable: the file's token block, plus any
 * custom property declared on the page itself. The ones the page mentions win,
 * because a page may override a token for its own subtree.
 */
function tokenDeclarations(model, pageNode) {
  const found = new Map();
  for (const [name, token] of model.tokens ?? new Map()) found.set(name, token.value);
  const styleAttr = (pageNode.attrs ?? []).find((a) => a.name === "style");
  if (styleAttr && /--/.test(styleAttr.value ?? "")) {
    for (const declaration of parseDeclarations(styleAttr.value)) {
      if (declaration.property.startsWith("--")) found.set(declaration.property, declaration.value);
    }
  }
  return [...found.entries()].map(([name, value]) => `${name}:${value}`).join(";");
}

function resetCss() {
  return [
    "*,*::before,*::after{box-sizing:border-box}",
    "html,body{margin:0;padding:0}",
    "p,h1,h2,h3,h4,h5,h6{margin:0}",
    "img{display:block;max-width:100%}",
  ].join("");
}

function cssLength(value) {
  const text = String(value ?? "auto");
  const match = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(text.trim());
  if (!match) return text.trim();
  return `${match[1]}`;
}

/**
 * Render one node for a deliverable.
 *
 * This is the renderer's node writer with the design attributes removed. It is a
 * second walk rather than a post-processing regular expression, because a
 * regular expression over HTML is how a `data-id` ends up inside a text node and
 * a document gets corrupted.
 */
export function renderNodeHtml(node, tokens, renderOptions = {}, options = {}) {
  if (node.kind === "text") return escapeText(node.value);
  if (node.kind === "comment") return options.keepComments ? (node.raw ?? "") : "";
  if (node.kind !== "element") return "";

  const attrs = [];
  for (const attr of node.attrs ?? []) {
    if (attr.name === "style") continue;
    if (DESIGN_ATTRS.test(attr.name)) continue;
    if (attr.value === null || attr.value === undefined) {
      attrs.push(attr.rawName || attr.name);
      continue;
    }
    attrs.push(`${attr.rawName || attr.name}="${escapeAttr(attr.value)}"`);
  }

  const styleText = serializeStyle(node, tokens, renderOptions);
  if (styleText) attrs.push(`style="${escapeAttr(styleText)}"`);

  const head = attrs.length ? `<${node.tag} ${attrs.join(" ")}>` : `<${node.tag}>`;
  const body = (node.children ?? []).map((child) => renderNodeHtml(child, tokens, renderOptions, options)).join("");
  if (VOID.has(node.tag)) return `${head}${body}`;
  return `${head}${body}</${node.tag}>`;
}

/** A node's declarations, in table order, with tokens resolved or kept. */
export function serializeStyle(node, tokens, renderOptions = {}) {
  const styleAttr = (node.attrs ?? []).find((a) => a.name === "style");
  if (!styleAttr || !styleAttr.value) return "";
  const declarations = parseDeclarations(styleAttr.value);
  if (declarations.length === 0) return "";
  const kept = declarations
    .filter((d) => d.property !== "" && d.value !== "")
    .map((d, index) => ({
      property: d.property,
      value: renderOptions.resolveTokens === false ? d.value : resolveTokensIn(d.value, tokens),
      index,
    }))
    .sort((a, b) => compareProperties(a.property, b.property) || a.index - b.index);
  return kept.map(({ property, value }) => `${property}:${value}`).join(";");
}

function resolveTokensIn(value, tokens) {
  if (!tokens || tokens.size === 0) return value;
  if (!String(value).includes("var(")) return value;
  return String(value).replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([^()]*))?\)/g, (whole, name, fallback) => {
    const token = tokens.get(name);
    if (!token) return fallback !== undefined ? fallback.trim() : whole;
    return resolveTokensIn(token.value, tokens);
  });
}

/**
 * One page of a design file, as a standalone document.
 *
 * @param {object} doc parsed design file
 * @param {object} options `{ page, resolveTokens, keepComments, lang }`
 */
export function exportPage(doc, options = {}) {
  const model = renderModel(doc, { resolveTokens: options.resolveTokens === true });
  const pages = model.pages;
  if (pages.length === 0) {
    throw new ExportError("export/no-page", "The file has no page to export.", 'Add <section data-id="home" data-type="page">.');
  }

  let page;
  if (options.page) {
    page = pages.find((p) => p.id === options.page);
    if (!page) {
      throw new ExportError(
        "export/unknown-page",
        `There is no page with data-id ${JSON.stringify(options.page)}.`,
        `Pages: ${pages.map((p) => p.id).join(", ")}.`,
      );
    }
  } else {
    page = pages[0];
  }

  return { html: renderPageHtml(model, page, options), page, model };
}

/**
 * Every page, except the library page.
 *
 * A library page holds components, which are scaffolding: a component's markup
 * reaches the deliverable through the instances that use it, not as a page of
 * its own. `--page <library>` still exports it, for a component gallery.
 */
export function exportAllPages(doc, options = {}) {
  const model = renderModel(doc, { resolveTokens: options.resolveTokens === true });
  const wanted = options.includeLibrary
    ? model.pages
    : model.pages.filter((page) => !page.isLibrary);
  if (wanted.length === 0) {
    throw new ExportError("export/no-page", "The file has no page to export.", null);
  }
  return wanted.map((page) => ({
    page,
    file: `${page.id}.html`,
    html: renderPageHtml(model, page, options),
  }));
}

/** True when the request asks for something only a browser can produce. */
export function needsBrowser(format) {
  return ["png", "jpeg", "jpg", "webp"].includes(String(format).toLowerCase());
}
