/**
 * `node design.mjs validate <file> [--json] [--strict]` — the four-layer report.
 *
 * The validator is `lib/validate.mjs`; this verb only reads the file, runs it,
 * and prints. Exit codes: 0 no errors, 1 errors (or warnings under --strict),
 * 2 the file is unreadable or the arguments are wrong.
 */

import { EXIT_INVALID, EXIT_OK, EXIT_UNREADABLE, SHARED_FLAGS, loadExport, out, parseArgs, readDesignFile } from "../cli.mjs";
import { dedupeDiagnostics, groupDiagnostics, sortDiagnostics, summarize } from "../../diagnostics.mjs";
import { byteOffsetToLineCol } from "../../spans.mjs";

export const USAGE = `Usage: node design.mjs validate <file> [options]

  --json     print one line of JSON instead of the human report
  --strict   exit 1 when there are warnings as well as errors
  --quiet    print nothing when the file is valid
  --help     print this usage

Exit codes: 0 valid, 1 invalid, 2 unreadable.`;

function codeOf(diagnostic) {
  return typeof diagnostic.code === "string" && diagnostic.code !== "" ? diagnostic.code : "(no code)";
}

function whereOf(diagnostic, source) {
  let line = Number.isFinite(diagnostic.line) ? diagnostic.line : null;
  let column = Number.isFinite(diagnostic.column) ? diagnostic.column : null;
  if ((line === null || column === null) && Number.isFinite(diagnostic.offset)) {
    const at = byteOffsetToLineCol(source, diagnostic.offset);
    if (line === null) line = at.line;
    if (column === null) column = at.column;
  }
  if (line === null) return "";
  return `line ${line}, column ${column === null ? 1 : column}`;
}

/**
 * The grouped human report: one header per code, then that group's findings.
 *
 * @param {string} file
 * @param {object[]} diagnostics
 * @param {string} source
 * @returns {string}
 */
export function humanReport(file, diagnostics, source) {
  const sorted = sortDiagnostics(diagnostics);
  const lines = [];

  for (const group of groupDiagnostics(sorted)) {
    const label = group.severity === "error" ? "ERROR  " : "WARNING";
    lines.push(`${label}  ${group.code}  x${group.count}`);
    for (const diagnostic of sorted) {
      if (codeOf(diagnostic) !== group.code) continue;
      const target = typeof diagnostic.target === "string" && diagnostic.target !== "" ? diagnostic.target : "";
      const path = typeof diagnostic.path === "string" ? diagnostic.path : "";
      const where = whereOf(diagnostic, source);
      const position = [target, path].filter(Boolean).join("  ");
      lines.push(`  ${position}${where ? `  (${where})` : ""}`.trimEnd());
      if (diagnostic.message) lines.push(`    ${diagnostic.message}`);
      if (diagnostic.hint) lines.push(`    hint  ${diagnostic.hint}`);
      if (diagnostic.fix) lines.push(`    fix   ${diagnostic.fix}`);
    }
  }

  const { errors, warnings } = summarize(sorted);
  lines.push(`${file}: ${errors} errors, ${warnings} warnings${errors === 0 ? " — valid" : " — invalid"}`);
  return `${lines.join("\n")}\n`;
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS, strict: { type: "boolean" } },
    positionals: { min: 1, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const file = positionals[0];

  let loaded;
  try {
    loaded = await readDesignFile(file);
  } catch (error) {
    if (values.json && error && (error.name === "FsError" || error.name === "CliError")) {
      out(JSON.stringify({ file, ok: false, reason: error.code || "cli/error", message: error.message }));
      return EXIT_UNREADABLE;
    }
    throw error;
  }

  const validateDesign = await loadExport("validate.mjs", ["validateDesign", "validate", "default"], "validateDesign");
  const parserDiagnostics = Array.isArray(loaded.doc.diagnostics) ? loaded.doc.diagnostics : [];
  // `strict` is passed through so the report and the exit code agree: under
  // --strict the validator itself promotes a warning to an error.
  const produced = validateDesign(loaded.doc, {
    file,
    text: loaded.text,
    format: loaded.format,
    strict: values.strict === true,
  });
  const diagnostics = sortDiagnostics(
    dedupeDiagnostics([...parserDiagnostics, ...(Array.isArray(produced) ? produced : [])]),
  );

  const counts = summarize(diagnostics);
  const ok = counts.errors === 0 && (!values.strict || counts.warnings === 0);

  if (values.json) {
    out(
      JSON.stringify({
        file,
        format: loaded.format,
        revision: loaded.revision,
        ok,
        counts: { errors: counts.errors, warnings: counts.warnings },
        groups: groupDiagnostics(diagnostics),
        diagnostics,
      }),
    );
  } else if (!values.quiet || !ok) {
    out(humanReport(file, diagnostics, loaded.text), { newline: false });
  }

  return ok ? EXIT_OK : EXIT_INVALID;
}
