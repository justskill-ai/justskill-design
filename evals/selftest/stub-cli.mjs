#!/usr/bin/env node
// evals/selftest/stub-cli.mjs
//
// A TEST DOUBLE for evals/grade.mjs. It is NOT the skill-design implementation
// and NOT a specification of the verb surface — do not read its flags as a
// contract. Its only job is to let the grader be exercised before the real
// design.mjs exists, so that the measuring tool itself is known to work.
//
//   node evals/grade.mjs --cli evals/selftest/stub-cli.mjs
//   node evals/grade.mjs --cli evals/selftest/stub-cli.mjs --only s01,s11
//
// Modes:
//   --stub-mode=no-add    hide the `add` verb, to exercise the grader's SKIP path
//
// Verbs: validate, add, set
// Exit codes: 0 clean, 1 diagnostics present, 2 bad args or missing verb.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = (argv.find((a) => a.startsWith("--stub-mode=")) || "").split("=")[1] ||
  process.env.SKILL_DESIGN_STUB_MODE || "full";
const verb = argv[0];

const die = (msg, code = 2) => { process.stderr.write(`${msg}\n`); process.exit(code); };

const HELP = `skill-design (test double)

usage: design.mjs <verb> <file> [options]

verbs:
  validate <file> [--json]                    report diagnostics
  add <file> --html <snippet> --parent <id>   append a snippet to a node
  set <file> <data-id> --style <css>          merge css into a node's style
`;

if (!verb || verb === "--help" || verb === "-h") { process.stdout.write(HELP); process.exit(0); }
if (!["validate", "add", "set"].includes(verb) || (verb === "add" && mode === "no-add")) {
  die(`unknown verb: ${verb}`);
}

const file = argv[1];
if (!file || !existsSync(file)) die(`cannot read ${file}`);

// ------------------------------------------------------------------ helpers

/** Quote- and paren-aware declaration split — the same four states as §4.2. */
function splitDeclarations(css) {
  const out = [];
  let buf = "", quote = null, paren = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) { buf += c; if (c === "\\") { buf += css[++i] ?? ""; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "(") { paren++; buf += c; continue; }
    if (c === ")") { paren = Math.max(0, paren - 1); buf += c; continue; }
    if (c === ";" && paren === 0) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(":");
    return i === -1 ? { property: s, value: "" } : { property: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
  });
}

const ELEMENTS = () => {
  const src = readFileSync(file, "utf8");
  return { src, els: [...src.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)].map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2], at: m.index })) };
};

const attrOf = (attrs, name) => {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};

const ALIASES = { margin: null, background: "background-color" };
const UNKNOWN = new Set(["font", "transform", "cursor", "animation", "object-fit", "grid-template-columns", "border-bottom", "margin-left", "margin-top", "margin-bottom", "margin-right", "position", "left", "bottom"]);

// ------------------------------------------------------------------ validate

if (verb === "validate") {
  const { src, els } = ELEMENTS();
  const diagnostics = [], normalized = [], dropped = [], seen = new Map();

  for (const el of els) {
    const id = attrOf(el.attrs, "data-id");
    const type = attrOf(el.attrs, "data-type");
    if (id) {
      if (seen.has(id)) {
        diagnostics.push({ code: "structure/duplicate-id", severity: "error", target: id, offset: el.at, message: `data-id "${id}" is used more than once`, hint: "ids must be unique in the file" });
      } else seen.set(id, el.at);
    } else if (type) {
      diagnostics.push({ code: "structure/missing-id", severity: "warning", target: "", offset: el.at, message: `${el.tag} has data-type but no data-id`, hint: "ids are filled in with the page prefix" });
    }

    if (["input", "label", "canvas", "pre", "button"].includes(el.tag)) {
      diagnostics.push({ code: "structure/unsupported-tag", severity: "error", target: id ?? "", offset: el.at, message: `<${el.tag}> is not a design tag`, hint: "use div/p/img/svg/section" });
      continue;
    }
    if (type === "frame" && el.tag === "span") {
      diagnostics.push({ code: "structure/type-tag-mismatch", severity: "error", target: id ?? "", offset: el.at, message: `data-type="frame" on <span>; frame must be a <div>`, hint: "span is a text tag" });
    }
    if (type === "image" && attrOf(el.attrs, "alt") === null) {
      diagnostics.push({ code: "structure/missing-attr", severity: "error", target: id ?? "", offset: el.at, message: `image is missing required attribute alt`, hint: "img needs src and alt" });
    }
    if (el.tag === "svg" && type === "icon" && attrOf(el.attrs, "data-icon-library") === null) {
      diagnostics.push({ code: "structure/missing-attr", severity: "error", target: id ?? "", offset: el.at, message: `icon is missing required attribute data-icon-library`, hint: "lucide" });
    }

    const style = attrOf(el.attrs, "style");
    if (!style) continue;
    for (const d of splitDeclarations(style)) {
      const p = d.property.toLowerCase();
      if (p in ALIASES) {
        const alias = ALIASES[p];
        if (alias === null) diagnostics.push({ code: "style/alias-rejected", severity: "error", target: id ?? "", offset: el.at, message: `${p} is rejected`, hint: "use padding/gap instead of margin" });
        else { normalized.push({ property: p, from: d.value, to: `${alias}:${d.value}`, target: id ?? "" }); }
        continue;
      }
      if (UNKNOWN.has(p)) {
        diagnostics.push({ code: "style/unknown-property", severity: "warning", target: id ?? "", offset: el.at, message: `${p} is not in the format table`, hint: "see CSS_ALLOWED" });
        dropped.push({ property: p, code: "style/unknown-property", target: id ?? "" });
        continue;
      }
      if (/#[0-9a-f]{3}\b/i.test(d.value)) normalized.push({ property: p, from: d.value, to: `#${d.value.match(/#([0-9a-f]{3})\b/i)[1].split("").map((c) => c + c).join("")}`, target: id ?? "" });
    }
  }

  const receipt = {
    file,
    ok: diagnostics.filter((d) => d.severity === "error").length === 0,
    diagnostics,
    droppedDeclarations: dropped,
    normalizedValues: normalized,
    generatedIds: [],
  };
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else {
    for (const d of diagnostics) process.stdout.write(`${d.severity} ${d.code} ${d.target || "-"} offset=${d.offset} ${d.message}\n`);
    process.stdout.write(`${diagnostics.length} diagnostic(s)\n`);
  }
  process.exit(receipt.ok ? 0 : 1);
}

// ------------------------------------------------------------------ add

if (verb === "add") {
  const htmlIdx = argv.indexOf("--html");
  const parentIdx = argv.indexOf("--parent");
  if (htmlIdx === -1) die("add: missing --html <snippet>");
  if (parentIdx === -1) die("add: missing --parent <data-id>");
  const snippet = readFileSync(argv[htmlIdx + 1], "utf8").trimEnd();
  const parent = argv[parentIdx + 1];

  const src = readFileSync(file, "utf8");
  const open = src.indexOf(`data-id="${parent}"`);
  if (open === -1) die(`add: no node with data-id="${parent}"`);
  const openEnd = src.indexOf(">", open) + 1;
  let depth = 1;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = openEnd;
  let m;
  while ((m = re.exec(src))) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) {
      writeFileSync(file, `${src.slice(0, m.index)}${snippet}\n      ${src.slice(m.index)}`, "utf8");
      process.stdout.write(`${JSON.stringify({ ok: true, added: snippet.match(/data-id="([^"]+)"/)?.[1] ?? null, parent, generatedIds: [], droppedDeclarations: [], normalizedValues: [] })}\n`);
      process.exit(0);
    }
  }
  die(`add: unbalanced <div> for ${parent}`);
}

// ------------------------------------------------------------------ set

if (verb === "set") {
  const id = argv[2];
  const styleIdx = argv.indexOf("--style");
  if (!id || styleIdx === -1) die("set: usage: set <file> <data-id> --style <css>");
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(`data-id="${id}"`);
  if (at === -1) die(`set: no node with data-id="${id}"`);
  const start = src.indexOf('style="', at);
  if (start === -1) die(`set: node ${id} has no style attribute`);
  const end = src.indexOf('"', start + 7);
  const merged = `${src.slice(start + 7, end)};${argv[styleIdx + 1]}`;
  writeFileSync(file, `${src.slice(0, start + 7)}${merged}${src.slice(end)}`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, target: id, style: merged, generatedIds: [], droppedDeclarations: [], normalizedValues: [] })}\n`);
  process.exit(0);
}
