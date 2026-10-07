/**
 * `node design.mjs export <file> [--page <id>] [--all] [-o path] [--resolve-tokens]`
 *
 * A deliverable, not a design file. The output is a page a browser renders on
 * its own: the design's markup and inline styles, the token block so the custom
 * properties still resolve, and a viewport sized to the page.
 *
 * `--all` writes one file per page and skips the library page, because a
 * component library is scaffolding rather than a screen.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";

export const USAGE = `Usage: node design.mjs export <file> [options]

  --page <data-id>     export this page (default: the first page)
  --all                write one file per page, skipping the library page
  --include-library    with --all, include the library page too
  -o, --out <path>     output file, or output directory with --all
  --resolve-tokens     bake token values into the styles and drop the token block
  --stdout             print the HTML instead of writing a file
  --json               print a report as JSON
  --quiet              print nothing

Exit codes: 0 written, 1 refused, 2 unreadable or bad arguments.

Only pages can be exported as HTML. A deliverable is a page or a site, not a
subtree; use \`show <data-id>\` to read one element.`;

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      page: { type: "string" },
      all: { type: "boolean" },
      "include-library": { type: "boolean" },
      out: { type: "string", alias: ["o"] },
      "resolve-tokens": { type: "boolean" },
      stdout: { type: "boolean" },
      "keep-comments": { type: "boolean" },
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
  const module = await import("../../export-html.mjs");
  const options = {
    page: values.page,
    resolveTokens: values["resolve-tokens"] === true,
    keepComments: values["keep-comments"] === true,
    includeLibrary: values["include-library"] === true,
  };

  const outPath = values.out ?? values.o;

  if (values.all) {
    let results;
    try {
      results = module.exportAllPages(loaded.doc, options);
    } catch (error) {
      return refuse(error);
    }
    const dir = resolve(outPath ?? "dist");
    mkdirSync(dir, { recursive: true });
    const written = [];
    for (const item of results) {
      const target = join(dir, item.file);
      writeFileSync(target, item.html, "utf8");
      written.push({ file: target, page: item.page.id, bytes: Buffer.byteLength(item.html) });
    }
    report(written, values, `${written.length} page${written.length === 1 ? "" : "s"} written to ${dir}`);
    return EXIT_OK;
  }

  let result;
  try {
    result = module.exportPage(loaded.doc, options);
  } catch (error) {
    return refuse(error);
  }

  if (values.stdout) {
    process.stdout.write(result.html);
    return EXIT_OK;
  }

  const target = resolve(outPath ?? `${result.page.id}.html`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.html, "utf8");
  report([{ file: target, page: result.page.id, bytes: Buffer.byteLength(result.html) }], values, `${file} → ${target} (${result.page.id}, ${Buffer.byteLength(result.html)} bytes)`);
  return EXIT_OK;
}

function report(written, values, line) {
  if (values.json) {
    out(JSON.stringify({ ok: true, verb: "export", written }));
    return;
  }
  out(line, { quiet: values.quiet });
}

function refuse(error) {
  const hint = error.hint ? `\n  ${error.hint}` : "";
  out(`REFUSED  ${error.message}${hint}`);
  return EXIT_INVALID;
}
