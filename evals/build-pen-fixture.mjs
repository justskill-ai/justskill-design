#!/usr/bin/env node
// evals/build-pen-fixture.mjs
//
// Builds test/fixtures/real/pen-pages.html from a pen.dev .pen file.
// This is test-data tooling: it lives under evals/ on purpose and is NOT part
// of lib/ and NOT shipped. It is deterministic and re-runnable.
//
//   node evals/build-pen-fixture.mjs [path/to/source.pen] [out.html]
//
// Default source: /Users/xiguazhi/Developer/MyProjects/jiazheng-mono/design/miniprogram.pen
// Default output: test/fixtures/real/pen-pages.html
//
// Takes the FIRST 3 top-level frames and emits one
// <section data-type="page"> per frame.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const SRC = process.argv[2] || "/Users/xiguazhi/Developer/MyProjects/jiazheng-mono/design/miniprogram.pen";
const OUT = process.argv[3] || resolve(ROOT, "test/fixtures/real/pen-pages.html");

const JUSTIFY = {
  start: "flex-start", end: "flex-end", center: "center",
  space_between: "space-between", space_around: "space-around", space_evenly: "space-evenly",
};
const ALIGN = {
  start: "flex-start", end: "flex-end", center: "center",
  stretch: "stretch", baseline: "baseline",
};

const doc = JSON.parse(readFileSync(SRC, "utf8"));
const VARS = doc.variables || {};
const usedVars = new Set();

// ---------------------------------------------------------------- utilities

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

function len(v) {
  if (typeof v === "number") return v === 0 ? "0" : `${v}px`;
  return String(v);
}

function paint(v) {
  if (typeof v !== "string") return null;
  if (v.startsWith("$")) {
    const name = v.slice(1);
    usedVars.add(name);
    return `var(--${name})`;
  }
  return v;
}

function paddingValue(p) {
  if (typeof p === "number") return p === 0 ? null : len(p);
  if (!Array.isArray(p) || p.length === 0) return null;
  if (p.every((n) => !n)) return null;
  if (p.length === 1) return len(p[0]);
  if (p.length === 2) return `${len(p[0])} ${len(p[1])}`;
  if (p.length === 3) return `${len(p[0])} ${len(p[1])} ${len(p[2])}`;
  return `${len(p[0])} ${len(p[1])} ${len(p[2])} ${len(p[3])}`;
}

function shadowValue(effect) {
  if (!effect) return null;
  const list = Array.isArray(effect) ? effect : [effect];
  const parts = [];
  for (const e of list) {
    if (!e || (e.type && e.type !== "shadow")) continue;
    const inset = e.shadowType === "inner" ? "inset " : "";
    const off = e.offset || { x: 0, y: 0 };
    parts.push(`${inset}${len(off.x || 0)} ${len(off.y || 0)} ${len(e.blur || 0)} ${e.color || "#00000033"}`);
  }
  return parts.length ? parts.join(", ") : null;
}

// ------------------------------------------------- pen node -> element data

let idSeq = 0;
const seenIds = new Set();

function nodeId(penId, name) {
  let base = String(penId || name || `n${++idSeq}`).replace(/[^A-Za-z0-9_-]/g, "-");
  if (!/^[A-Za-z_]/.test(base)) base = `n-${base}`;
  base = base.slice(0, 56);
  let id = base;
  let n = 2;
  while (seenIds.has(id)) id = `${base}-${n++}`;
  seenIds.add(id);
  return id;
}

function styleOf(node) {
  const out = [];
  const push = (p, v) => { if (v !== null && v !== undefined && v !== "") out.push(`${p}:${v}`); };

  const isFrame = node.type === "frame";
  const isText = node.type === "text";

  if (isFrame) {
    const dir = node.layout === "vertical" ? "column" : "row";
    push("display", "flex");
    push("flex-direction", dir);
    if (node.justifyContent) push("justify-content", JUSTIFY[node.justifyContent] || node.justifyContent);
    if (node.alignItems) push("align-items", ALIGN[node.alignItems] || node.alignItems);
  }

  push("gap", node.gap ? len(node.gap) : null);
  push("padding", paddingValue(node.padding));

  if (node.width === "fill_container") {
    // pen `fill_container` on a frame inside a row is `flex:1`; anywhere else
    // it is a plain 100% width.
    if (node.type === "frame" && node.layout !== "vertical") push("flex", "1");
    else push("width", "100%");
  } else if (node.width !== undefined) {
    push("width", len(node.width));
  }
  if (node.height === "fill_container") push("height", "100%");
  else if (node.height !== undefined) push("height", len(node.height));

  if (node.clip) push("overflow", "hidden");
  if (node.fill && !isText && !isIcon(node)) push("background-color", paint(node.fill));

  if (node.stroke) {
    const w = node.strokeWidth === undefined ? 1 : node.strokeWidth;
    push("border", `${len(w)} solid ${paint(node.stroke)}`);
  }
  if (node.cornerRadius !== undefined) {
    push("border-radius", node.cornerRadius >= 9999 ? "9999px" : len(node.cornerRadius));
  }
  if (isEllipse(node)) push("border-radius", "50%");

  push("box-shadow", shadowValue(node.effect));

  if (isText) push("color", node.fill ? paint(node.fill) : null);
  if (isText && node.fontFamily) push("font-family", paint(node.fontFamily));
  if (isText && node.fontSize !== undefined) push("font-size", len(node.fontSize));
  if (isText && node.fontWeight !== undefined) push("font-weight", String(node.fontWeight));
  if (isText && node.lineHeight !== undefined) push("line-height", String(node.lineHeight));
  if (isText && node.letterSpacing !== undefined) push("letter-spacing", len(node.letterSpacing));
  if (isText && node.textAlign) push("text-align", String(node.textAlign));

  if (isIcon(node)) push("color", node.fill ? paint(node.fill) : null);

  return out.join(";");
}

const isIcon = (n) => n.type === "icon";
const isEllipse = (n) => n.type === "ellipse";

// ------------------------------------------------------------- serializer

const indent = (d) => "  ".repeat(d);

function attrsToString(pairs) {
  return pairs.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
}

/**
 * One pen node as an element.
 *
 * `copy` is set while a reference is being inlined: `{ prefix, root }`. The
 * copied root takes the reference's own id, and every node under it is renumbered
 * as `<prefix>__<its own id>`, because an id is unique across the document and one
 * master may be referenced more than once.
 */
function emitElement(node, depth, copy = null) {
  if (node.type === "ref") {
    emitRef(node, depth, copy);
    return;
  }
  const pad = indent(depth);
  const id = copy ? copyId(copy, node) : nodeId(node.id, node.name);
  const type = TYPE_OF[node.type] || "frame";
  const pairs = [["data-id", id], ["data-type", type]];

  if (node.type === "shape" || node.type === "rectangle" || node.type === "ellipse") pairs.push(["data-kind", node.type === "ellipse" ? "ellipse" : "rect"]);
  if (node.name) pairs.push(["data-name", node.name]);
  if (node.__dataHidden === "true") pairs.push(["data-hidden", "true"]);
  if (node.type === "icon") {
    pairs.push(["data-icon", node.icon || "square"]);
    pairs.push(["data-icon-library", node.library || "lucide"]);
  }

  const style = styleOf(node);
  if (style) pairs.push(["style", style]);

  if (TEXT_TAGS[node.type]) {
    body.push(`${pad}<p${attrsToString(pairs)}>${esc(node.content || "")}</p>`);
    return;
  }
  if (node.type === "icon") {
    pairs.push(["viewBox", "0 0 24 24"]);
    pairs.push(["fill", "none"]);
    pairs.push(["stroke", "currentColor"]);
    pairs.push(["stroke-width", "2"]);
    body.push(`${pad}<svg${attrsToString(pairs)}>`);
    if (node.name) body.push(`${pad}  <title>${esc(node.name)}</title>`);
    body.push(`${pad}  <path d="M0 0h24v24H0z"></path>`);
    body.push(`${pad}</svg>`);
    return;
  }
  if (node.type === "rectangle" || node.type === "ellipse") {
    body.push(`${pad}<div${attrsToString(pairs)}></div>`);
    return;
  }

  // frame (with children)
  const kids = node.children || [];
  if (kids.length === 0) {
    body.push(`${pad}<div${attrsToString(pairs)}></div>`);
    return;
  }
  body.push(`${pad}<div${attrsToString(pairs)}>`);
  for (const kid of kids) emitElement(kid, depth + 1, copy);
  body.push(`${pad}</div>`);
}

/** A `ref` is inlined: the node it names is copied in, patches and all. */
function emitRef(node, depth, copy) {
  const target = byIdNode.get(node.ref);
  if (!target) throw new Error(`the reference ${JSON.stringify(node.ref)} points at no node in this document`);
  const rootId = copy ? copyId(copy, node) : nodeId(node.id, node.name);
  const clone = structuredClone(target);
  clone.name = node.name || clone.name;
  for (const key of ["width", "height"]) {
    if (node[key] !== undefined) clone[key] = node[key];
  }
  applyOverrides(clone, node.descendants);
  emitElement(clone, depth, { prefix: rootId, root: clone });
}

function copyId(copy, node) {
  if (node === copy.root) return copy.prefix;
  const base = typeof node.id === "string" && node.id !== "" ? node.id : `n${++idSeq}`;
  let id = `${copy.prefix}__${base}`;
  if (id.length > 64) id = `${copy.prefix.slice(0, 40)}__${idSeq++}`;
  let n = 2;
  while (seenIds.has(id)) id = `${copy.prefix}__${base}-${n++}`;
  seenIds.add(id);
  return id;
}

/** A reference's patches, applied to the copy's own nodes. */
function applyOverrides(clone, descendants) {
  if (!descendants || typeof descendants !== "object") return;
  const index = new Map();
  (function walk(n) {
    if (typeof n.id === "string" && !index.has(n.id)) index.set(n.id, n);
    for (const child of n.children || []) walk(child);
  })(clone);
  for (const [targetId, fields] of Object.entries(descendants)) {
    const target = index.get(targetId);
    if (!target) continue;
    for (const [key, value] of Object.entries(fields || {})) {
      if (key === "enabled" || key === "visible") {
        if (value) delete target.__dataHidden;
        else target.__dataHidden = "true";
        continue;
      }
      target[key] = value;
    }
  }
}

const TYPE_OF = { frame: "frame", text: "text", icon: "icon", rectangle: "shape", ellipse: "shape" };
const TEXT_TAGS = { text: "p" };

// A reference may point at a master anywhere in the document, including one that
// is not among the pages this fixture emits.
const byIdNode = new Map();
(function index(nodes) {
  for (const n of nodes) {
    if (typeof n.id === "string" && !byIdNode.has(n.id)) byIdNode.set(n.id, n);
    if (n.children) index(n.children);
  }
})(doc.children);

// ------------------------------------------------------------- head block

const pages = doc.children.slice(0, 3);
const body = [];
for (const [i, page] of pages.entries()) {
  const id = nodeId(page.id, page.name);
  const pairs = [["data-id", id], ["data-type", "page"]];
  if (page.name) pairs.push(["data-name", page.name]);
  if (page.x !== undefined || page.y !== undefined) pairs.push(["data-canvas", `${page.x || 0},${page.y || 0}`]);
  const w = page.width === "fill_container" ? "100%" : len(page.width);
  const h = page.height === undefined ? null : len(page.height);
  const st = [`width:${w}`, h ? `height:${h}` : null, "overflow:hidden"].filter(Boolean).join(";");
  pairs.push(["style", st]);
  body.push(`  <section${attrsToString(pairs)}>`);
  for (const kid of page.children || []) emitElement(kid, 2);
  body.push(`  </section>`);
}

// `usedVars` is filled during styleOf(); the tokens block needs it, so the
// elements are emitted first and `:root` is prepended afterwards.
const tokenLines = [];
for (const name of [...usedVars].sort()) {
  const v = VARS[name];
  if (!v) continue;
  // font stacks are quoted so the custom property survives being dropped into
  // a font-family list.
  const value = /sans|serif|mono|font/.test(name)
    ? JSON.stringify(String(v.value))
    : String(v.value);
  tokenLines.push(`    --${name}:${value}`);
}

const head = [
  "<!doctype html>",
  '<html lang="zh">',
  "<head>",
  '  <meta charset="utf-8">',
  "  <title>miniprogram.pen — first 3 frames</title>",
  '  <meta name="design-schema" content="3.0">',
  "  <style>",
  "    /* tokens lifted from miniprogram.pen variables, only those referenced */",
  "    :root{",
  `${tokenLines.join(";\n")};`,
  "    }",
  "  </style>",
  "  <style>",
  '    section[data-type="page"]{ margin:0 0 24px }',
  "  </style>",
  "</head>",
  "<body>",
];

const html = [...head, ...body, "</body>", "</html>", ""].join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, "utf8");

const bytes = Buffer.byteLength(html, "utf8");
const nodes = (html.match(/data-id="/g) || []).length;
console.log(`wrote ${OUT}`);
console.log(`  source      ${SRC}`);
console.log(`  pages       ${pages.length} (${pages.map((p) => p.name).join(", ")})`);
console.log(`  elements    ${nodes}`);
console.log(`  tokens      ${tokenLines.length}`);
console.log(`  bytes       ${bytes}` + (bytes > 120 * 1024 ? "  *** OVER 120 KB ***" : ""));
