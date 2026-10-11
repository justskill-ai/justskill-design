/**
 * `node design.mjs import pen <file> [-o design.html] [--report r.json]`
 *
 * Direction is one way, and the command says so: pen in, design file out. The
 * ledger prints on every run, because an import that loses a gradient and says
 * nothing is worse than one that refuses.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, loadExport, out, parseArgs } from "../cli.mjs";
import { readText } from "../fs.mjs";

export const USAGE = `Usage: node design.mjs import pen <file> [options]

  -o, --out <path>     output design file (default: <name>.html)
  --report <path>      also write the ledger as JSON
  --title <name>       file title (default: the pen document's own name, else the file name)
  --stdout             print the design file instead of writing it; the report goes to stderr
  --json               print the ledger as JSON
  --quiet              print only the ledger line

Exit codes: 0 imported, 1 refused, 2 unreadable or bad arguments.

The ledger names every loss and every value that was rewritten. A loss is
something this format has no spelling for, such as a mesh gradient or an inner
shadow. There is no HTML to pen direction.`;

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      out: { type: "string", alias: ["o"] },
      report: { type: "string" },
      title: { type: "string" },
      stdout: { type: "boolean" },
    },
    positionals: { min: 2, max: 2 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [format, file] = positionals;
  if (format !== "pen") {
    out(`REFUSED  There is no ${format} reader. The only input format is pen.`);
    return EXIT_INVALID;
  }

  const text = readText(file);
  const { importPen, ledgerLine } = await import("../../readers/pen.mjs");
  const parse = await loadExport("parse.mjs", ["parse"], "parse");
  const validateDesign = await loadExport("validate.mjs", ["validateDesign"], "validateDesign");
  // The reader is handed text, so it cannot know the file's name; the verb supplies it as
  // the last resort. Without it a `.pen` with no `name` of its own was titled literally
  // "imported", which tells a reader of the file nothing at all.
  const fallbackTitle = String(file).replace(/\.pen$/i, "").split("/").pop();
  let html;
  let ledger;
  let diagnostics;
  try {
    ({ html, ledger, diagnostics } = importPen(text, { title: values.title, fallbackTitle }));
  } catch (error) {
    // A reader refusal is a result, not a crash: it prints the same way every
    // other refusal does, and it keeps the code, which is what a caller branches
    // on. `design.mjs` would turn it into one line on stderr with the code lost.
    if (typeof error?.code === "string" && error.code.startsWith("pen/")) {
      if (values.json) {
        out(JSON.stringify({ ok: false, verb: "import", format, file, refused: { code: error.code, message: error.message } }));
      } else {
        out(`REFUSED  ${error.message}\n  ${error.code}`);
      }
      return EXIT_INVALID;
    }
    throw error;
  }

  // `diagnostics` is the parser's, and this check read as a guarantee while it was
  // only a syntax test: the reader never ran the validator, so a document the next
  // `validate` would refuse imported clean and exited 0. The gate asks the validator
  // directly now, and it asks about the bytes about to be written — `parse(html)`,
  // not a second rendering of the same tree.
  const errors = [
    ...(diagnostics ?? []),
    ...validateDesign(parse(html)),
  ].filter((d) => d.severity === "error");
  if (errors.length) {
    const shown = errors.slice(0, 3).map((d) => `${d.code} — ${d.message}`).join("; ");
    out(`REFUSED  The imported file would not validate: ${errors.length} error(s). ${shown}`);
    return EXIT_INVALID;
  }

  if (values.report) {
    mkdirSync(dirname(resolve(values.report)), { recursive: true });
    writeFileSync(resolve(values.report), `${JSON.stringify({ file, ledger, diagnostics }, null, 2)}\n`, "utf8");
  }

  if (values.stdout) {
    process.stdout.write(html);
    // stdout carries the document and nothing else. `--stdout` exists to be piped, and a
    // pipe cannot tell a line of HTML from a line of ledger: this wrote the ledger line to
    // stdout, so `import pen x.pen --stdout > design.html` produced a file whose last line
    // was a sentence about pages. The report goes to stderr instead — silencing it would
    // hide the losses, which are the point of this verb.
    out(values.json
      ? JSON.stringify({ ok: true, verb: "import", format, file, out: null, bytes: Buffer.byteLength(html), ledger })
      : ledgerLine(ledger), { quiet: values.quiet, stream: process.stderr });
    return EXIT_OK;
  }

  const target = resolve(values.out ?? values.o ?? `${String(file).replace(/\.pen$/i, "").split("/").pop()}.html`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html, "utf8");

  if (values.json) {
    out(JSON.stringify({ ok: true, verb: "import", format, file, out: target, bytes: Buffer.byteLength(html), ledger }));
  } else {
    out(`${file} → ${target} (${Buffer.byteLength(html)} bytes)`);
    out(ledgerLine(ledger));
  }
  return EXIT_OK;
}
