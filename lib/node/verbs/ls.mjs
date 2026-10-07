/**
 * `node design.mjs ls <file> [--pages] [--in <data-id>] [--depth n] [--json]`
 *
 * Two shapes, one line per node:
 *
 *   ls home.html                     every page, in document order
 *   ls home.html --in home__root     the node tree under one data-id
 *
 * A line is `data-id  data-type  tag  name`, indented two spaces per level
 * beneath the root of the listing.
 */

import { CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { attrValue, collectElements, isPageElement } from "../../diagnostics.mjs";

export const USAGE = `Usage: node design.mjs ls <file> [options]

  --pages        list pages only (the default when --in is absent)
  --in <data-id> list the node tree under one element
  --depth n      how many levels below the root to print (default: all)
  --json         print one line of JSON instead of text
  --help         print this usage

Exit codes: 0 listed, 1 no such data-id, 2 unreadable.`;

function rowsOf(node, depth, maxDepth, rows) {
  const id = attrValue(node, "data-id") || "";
  const dataType = attrValue(node, "data-type") || "";
  rows.push({
    dataId: id,
    dataType,
    tag: typeof node.tag === "string" ? node.tag : "",
    name: attrValue(node, "data-name") || "",
    depth,
  });
  if (depth >= maxDepth) return rows;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    if (child.kind !== "element" && !(typeof child.tag === "string" && Array.isArray(child.attrs))) continue;
    rowsOf(child, depth + 1, maxDepth, rows);
  }
  return rows;
}

/** One report line: `data-id  data-type  tag  name`, indented by depth. */
export function lineOf(row) {
  const fields = [row.dataId, row.dataType, row.tag];
  if (row.name) fields.push(row.name);
  return `${"  ".repeat(row.depth)}${fields.join("  ")}`;
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      pages: { type: "boolean" },
      in: { type: "string" },
      depth: { type: "number" },
    },
    positionals: { min: 1, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const file = positionals[0];
  const loaded = await readDesignFile(file);
  const index = collectElements(loaded.doc);

  let rows;
  if (values.in !== undefined && values.in !== null) {
    const root = index.byId.get(String(values.in));
    if (!root) throw new CliError(`No element with data-id ${JSON.stringify(String(values.in))} in ${file}`, EXIT_INVALID);
    if (Number.isFinite(values.depth) && values.depth < 0) throw new CliError("--depth needs a number of 0 or more");
    const maxDepth = Number.isFinite(values.depth) ? Math.trunc(values.depth) : Infinity;
    rows = rowsOf(root, 0, maxDepth, []);
  } else {
    rows = index.elements.filter(isPageElement).map((page) => ({
      dataId: attrValue(page, "data-id") || "",
      dataType: attrValue(page, "data-type") || "page",
      tag: typeof page.tag === "string" ? page.tag : "section",
      name: attrValue(page, "data-name") || "",
      depth: 0,
    }));
  }

  if (values.json) {
    out(JSON.stringify(rows));
  } else if (!values.quiet) {
    for (const row of rows) out(lineOf(row), { quiet: false });
  }

  return EXIT_OK;
}
