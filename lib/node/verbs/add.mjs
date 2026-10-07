/**
 * `node design.mjs add <file> --html-file f | --html - [--in <parent>] [--as <id>] [--index n]`
 *
 * The modifier. This is the path a model uses: it writes an HTML fragment, the
 * tool checks it, and only then does a byte of the file move.
 *
 * The funnel, in order:
 *
 *   1. read the file again            (another writer may have changed it)
 *   2. validate it                    (so a pre-existing error is not blamed here)
 *   3. compile the fragment to one op (parse, check, normalize, name, index)
 *   4. apply the op
 *   5. validate again, and refuse unless the edit made no NEW error
 *   6. normalize the changed nodes only, then write atomically
 *   7. print the receipt
 *
 * Step 5 is the important one. A file may already have errors: the model is
 * allowed to fix one of them, and it is not allowed to add another. Refusing on
 * any error at all would make a broken file impossible to repair through this
 * tool.
 */

import process from "node:process";

import {
  CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile, loadExport,
} from "../cli.mjs";
import { readText, writeAtomic, revisionOf } from "../fs.mjs";

export const USAGE = `Usage: node design.mjs add <file> [options]

  --html-file <path>   read the fragment from a file
  --html -             read the fragment from stdin
  --in <data-id>       the parent to insert into (default: the first page)
  --page <data-id>     the page to insert into (default: inferred from --in)
  --as <data-id>       rename the fragment's root to this id
  --index <n>          insert at this position (default: last)
  --force              write even when the edit introduces a new error
  --dry-run            compile and validate, print the receipt, write nothing
  --json               print the receipt as JSON
  --quiet              print nothing

Exit codes: 0 added, 1 refused or invalid, 2 unreadable or bad arguments.`;

async function readFragment(values) {
  if (values["html-file"]) {
    const text = readText(values["html-file"]);
    return { html: text, from: values["html-file"] };
  }
  if (values.html === "-" || values.html === true) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return { html: Buffer.concat(chunks).toString("utf8"), from: "stdin" };
  }
  if (typeof values.html === "string") return { html: values.html, from: "--html" };
  throw new CliError(
    "No fragment given.",
    EXIT_INVALID,
    "cli/no-fragment",
    "Use --html-file <path>, or --html - to read from stdin.",
  );
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      html: { type: "string" },
      "html-file": { type: "string" },
      in: { type: "string" },
      as: { type: "string" },
      index: { type: "string" },
      page: { type: "string" },
    },
    positionals: { min: 1, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const file = positionals[0];
  const fragment = await readFragment(values);
  const loaded = await readDesignFile(file);

  const compileFragment = await loadExport("fragment.mjs", ["compileFragment"], "compileFragment");
  const validateDesign = await loadExport("validate.mjs", ["validateDesign"], "validateDesign");
  const newErrors = await loadExport("validate.mjs", ["newErrors"], "newErrors");
  const applyOps = await loadExport("ops.mjs", ["applyOps"], "applyOps");
  const serialize = await loadExport("serialize.mjs", ["serialize"], "serialize");

  const before = validateDesign(loaded.doc);

  const parent = values.in ?? defaultParent(loaded.doc);
  if (!parent) {
    throw new CliError(
      `${file} has no page to insert into.`,
      EXIT_INVALID,
      "cli/no-parent",
      'Add a page first, or name one with --in. A page is <section data-type="page">.',
    );
  }

  // `--in` names any element, most often a frame that holds the slot. `page` is
  // only set when the caller asked for a page by name, because passing an
  // element id there makes the fragment compiler reject it as an unknown page.
  const compiled = compileFragment(loaded.doc, fragment.html, {
    in: parent,
    as: values.as,
    index: values.index === undefined ? undefined : Number(values.index),
    page: values.page,
  });

  if (compiled.refused) {
    return refuse(compiled, values, file);
  }

  const { doc: next, inverse } = applyOps(loaded.doc, compiled.ops);
  const after = validateDesign(next);
  const introduced = newErrors(before, after);

  if (introduced.length && !values.force) {
    const receipt = {
      ok: false,
      verb: "add",
      applied: [],
      added: [],
      normalized: compiled.normalized,
      dropped: compiled.dropped,
      diagnostics: introduced,
      revision: loaded.revision,
      changed: false,
    };
    return refuse({ ...compiled, diagnostics: introduced, refused: { code: "cli/would-introduce-errors", message: "This edit would introduce a new error." } }, values, file, receipt);
  }

  const text = serialize(loaded.doc, next);

  if (values["dry-run"]) {
    const receipt = buildReceipt(compiled, { revision: revisionOf(text), changed: text !== loaded.text, inv: inverse });
    print(receipt, values, file);
    return EXIT_OK;
  }

  writeAtomic(file, text);
  const receipt = buildReceipt(compiled, { revision: revisionOf(text), changed: text !== loaded.text, inverse });
  print(receipt, values, file);
  return EXIT_OK;
}

function defaultParent(doc) {
  const pages = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.kind === "element") {
        if (child.tag === "section" && attrOf(child, "data-type") === "page" && !pages.length) pages.push(child);
        visit(child);
      }
    }
  };
  visit(doc);
  return pages.length ? attrOf(pages[0], "data-id") : null;
}

function attrOf(node, name) {
  const found = (node.attrs || []).find((a) => a.name === name);
  if (!found) return null;
  return found.value === null || found.value === undefined ? "" : found.value;
}

function buildReceipt(compiled, extra) {
  return {
    ok: true,
    verb: "add",
    applied: compiled.ops,
    added: compiled.added,
    normalized: compiled.normalized,
    dropped: compiled.dropped,
    diagnostics: compiled.diagnostics,
    revision: extra.revision,
    changed: extra.changed,
  };
}

function print(receipt, values, file) {
  if (values.json) {
    out(JSON.stringify(receipt));
    return;
  }
  const lines = [];
  if (receipt.added.length) lines.push(`added:      ${receipt.added.join(", ")}  (${receipt.added.length} elements)`);
  for (const item of receipt.normalized) lines.push(`normalized: ${item.from} → ${item.to}`);
  for (const item of receipt.dropped) {
    lines.push(`dropped:    ${item.prop}${item.value === undefined ? "" : `:${item.value}`} — ${item.reason}`);
    if (item.replacement) lines.push(`            use ${item.replacement}`);
  }
  lines.push(`applied ${receipt.applied.length} op, revision ${receipt.revision} (${receipt.diagnostics.filter((d) => d.severity === "error").length} errors, ${receipt.diagnostics.filter((d) => d.severity === "warning").length} warnings)`);
  out(lines.join("\n"), { quiet: values.quiet });
}

function refuse(compiled, values, file, receipt) {
  const payload = receipt || {
    ok: false,
    verb: "add",
    applied: [],
    added: [],
    normalized: compiled.normalized,
    dropped: compiled.dropped,
    diagnostics: compiled.diagnostics,
    revision: null,
    changed: false,
  };
  if (values.json) {
    out(JSON.stringify(payload));
  } else {
    const refusal = compiled.refused || { code: "cli/refused", message: "Refused." };
    const lines = [`REFUSED  ${refusal.message}`];
    if (refusal.hint) lines.push(`  ${refusal.hint}`);
    if (refusal.suggestion) lines.push(`  ${refusal.suggestion}`);
    for (const item of compiled.dropped) lines.push(`  dropped: ${item.prop} — ${item.reason}`);
    for (const d of payload.diagnostics) {
      if (d.severity !== "error") continue;
      lines.push(`  error: ${d.code}${d.target ? ` at ${d.target}` : ""} — ${d.message}`);
      if (d.hint) lines.push(`         ${d.hint}`);
    }
    lines.push(`${file} was not changed.`);
    out(lines.join("\n"));
  }
  return EXIT_INVALID;
}
