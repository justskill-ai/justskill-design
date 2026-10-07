/**
 * `node design.mjs import pen <file> [-o design.html] [--report r.json]`
 *
 * Direction is one way, and the command says so: pen in, design file out. The
 * ledger prints on every run, because an import that loses a gradient and says
 * nothing is worse than one that refuses.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs } from "../cli.mjs";
import { readText } from "../fs.mjs";

export const USAGE = `Usage: node design.mjs import pen <file> [options]

  -o, --out <path>     output design file (default: <name>.html)
  --report <path>      also write the ledger as JSON
  --title <name>       file title (default: the source name)
  --stdout             print the design file instead of writing it
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
  const { html, ledger, diagnostics } = importPen(text, { title: values.title });

  const errors = (diagnostics ?? []).filter((d) => d.severity === "error");
  if (errors.length) {
    out(`REFUSED  The imported file would not validate: ${errors.length} error(s). First: ${errors[0].code} — ${errors[0].message}`);
    return EXIT_INVALID;
  }

  if (values.report) {
    mkdirSync(dirname(resolve(values.report)), { recursive: true });
    writeFileSync(resolve(values.report), `${JSON.stringify({ file, ledger, diagnostics }, null, 2)}\n`, "utf8");
  }

  if (values.stdout) {
    process.stdout.write(html);
    out(ledgerLine(ledger), { quiet: values.quiet });
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
