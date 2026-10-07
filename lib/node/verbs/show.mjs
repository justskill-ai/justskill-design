/**
 * `node design.mjs show <file> <data-id> [--json]` — one element, in full.
 *
 * Prints the element's open tag exactly as the file has it, its attribute list,
 * its text, and how many element children it has.
 */

import { CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { attrValue, collectElements } from "../../diagnostics.mjs";
import { byteOffsetToLineCol } from "../../spans.mjs";

export const USAGE = `Usage: node design.mjs show <file> <data-id> [options]

  --json     print one line of JSON instead of the human report
  --quiet    print nothing (with --json it still prints the payload)
  --help     print this usage

Exit codes: 0 shown, 1 no such data-id, 2 unreadable.`;

function isElement(node) {
  if (!node || typeof node !== "object") return false;
  if (node.kind === "element") return true;
  return typeof node.tag === "string" && Array.isArray(node.attrs);
}

/** The element's own text, without the indentation that surrounds its children. */
function textOf(node) {
  const children = Array.isArray(node.children) ? node.children : [];
  const text = children
    .filter((child) => child && child.kind === "text")
    .map((child) => (typeof child.value === "string" ? child.value : typeof child.raw === "string" ? child.raw : ""))
    .join("");
  return text.trim();
}

/**
 * The data `show` prints, for one element.
 *
 * @param {object} node
 * @param {string} source
 * @returns {object}
 */
export function describeNode(node, source) {
  const start = Number.isFinite(node.start) ? node.start : 0;
  const end = Number.isFinite(node.end) ? node.end : start;
  const openStart = Number.isFinite(node.openStart) ? node.openStart : start;
  const openEnd = Number.isFinite(node.openEnd) ? node.openEnd : end;
  const text = String(source === undefined || source === null ? "" : source);
  const at = byteOffsetToLineCol(text, start);

  const attrs = (Array.isArray(node.attrs) ? node.attrs : []).map((attr) => {
    const attrStart = Number.isFinite(attr.attrStart) ? attr.attrStart : Number.isFinite(attr.start) ? attr.start : 0;
    const attrEnd = Number.isFinite(attr.end) ? attr.end : attrStart;
    return {
      name: typeof attr.name === "string" ? attr.name : String(attr.rawName || ""),
      rawName: typeof attr.rawName === "string" ? attr.rawName : String(attr.name || ""),
      value: attr.value === undefined || attr.value === null ? "" : String(attr.value),
      quote: typeof attr.quote === "string" ? attr.quote : '"',
      raw: text.slice(attrStart, attrEnd),
    };
  });

  const children = (Array.isArray(node.children) ? node.children : []).filter(isElement);

  return {
    tag: typeof node.tag === "string" ? node.tag : "",
    rawTag: typeof node.rawTag === "string" ? node.rawTag : typeof node.tag === "string" ? node.tag : "",
    dataId: attrValue(node, "data-id"),
    dataType: attrValue(node, "data-type"),
    name: attrValue(node, "data-name"),
    openTag: text.slice(openStart, openEnd),
    attrs,
    text: textOf(node),
    childCount: children.length,
    start,
    end,
    line: at.line,
    column: at.column,
  };
}

function humanReport(file, dataId, described) {
  const lines = [];
  lines.push(`${dataId}  <${described.tag}>${described.dataType ? `  ${described.dataType}` : ""}`);
  lines.push(`open tag    ${described.openTag}`);
  lines.push(`attributes  ${described.attrs.length}`);
  for (const attr of described.attrs) {
    lines.push(`  ${attr.name} = ${JSON.stringify(attr.value)}`);
  }
  lines.push(`text        ${described.text === "" ? "(none)" : described.text}`);
  lines.push(`children    ${described.childCount}`);
  lines.push(`at          ${file} line ${described.line}, column ${described.column}`);
  return `${lines.join("\n")}\n`;
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: SHARED_FLAGS,
    positionals: { min: 2, max: 2 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, dataId] = positionals;
  const loaded = await readDesignFile(file);
  const index = collectElements(loaded.doc);
  const node = index.byId.get(String(dataId));
  if (!node) throw new CliError(`No element with data-id ${JSON.stringify(String(dataId))} in ${file}`, EXIT_INVALID);

  const described = describeNode(node, typeof loaded.doc.source === "string" ? loaded.doc.source : loaded.text);

  if (values.json) {
    out(JSON.stringify({ file, id: String(dataId), ...described }));
  } else {
    out(humanReport(file, String(dataId), described), { quiet: values.quiet, newline: false });
  }
  return EXIT_OK;
}
