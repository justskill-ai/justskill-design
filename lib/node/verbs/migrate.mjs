/**
 * `node design.mjs migrate <file>`
 *
 * Move a file onto the schema this build reads, by fixing the one thing that
 * carries the version: the `<meta name="design-schema">` marker.
 *
 * Why this exists at all: `version/unsupported` prints the hint
 * "Run `design migrate` to move the file to 3.0", and that command did not
 * exist. A hint that names a command nobody can run is a dead end, and a dead
 * end is the one failure this tool promises not to hand back.
 *
 * There is no older *HTML* schema in this repository, so this is not a format
 * translator and must not pretend to be one. It fixes the marker, revalidates,
 * and reports. If the file has other problems they are reported, not repaired.
 *
 * It does not go through the op layer, and it cannot: an op is addressed by
 * `data-id`, `resolveAddress` accepts nothing else, and a `<meta>` has no
 * `data-id`. So the marker is edited the way the serializer edits anything —
 * one byte range.
 */

import { EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { refusedReceipt, reportRefusal } from "../write-verbs.mjs";
import { revisionOf, unifiedDiff, writeAtomic } from "../fs.mjs";
import { SCHEMA_META_NAME, SCHEMA_VERSION, findMeta, newErrors, validateDesign } from "../../validate.mjs";
import { getAttrNode, parse } from "../../parse.mjs";
import { applyEdits } from "../../spans.mjs";

export const USAGE = `Usage: node design.mjs migrate <file> [options]

  --force      write even when the edit introduces a new error
  --dry-run    print the diff, write nothing
  --json       print the receipt as JSON
  --quiet      print nothing

Exit codes: 0 already current, or migrated; 1 refused and unchanged; 2 unreadable
or bad arguments.

This fixes the version marker only. It is not a format translator: there is no
older HTML schema, so there is nothing to translate from. A file that is already
current is left byte for byte alone, down to its modification time.`;

/** The marker, spelled the way `new` and the pen importer spell it. */
function markerText() {
  return `<meta name="${SCHEMA_META_NAME}" content="${SCHEMA_VERSION}">`;
}

/**
 * The whitespace a line starts with, so an inserted line sits where a person
 * would have put it. Canonical form does not care, but a file someone reads does.
 */
function indentAt(text, offset) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return (/^[ \t]*/.exec(text.slice(lineStart, offset)) ?? [""])[0];
}

/**
 * Where to put the marker when the file has none.
 *
 * Inside `<head>`, after the `<title>` when there is one — that is where every
 * file in this repository already has it, so the result looks like the files a
 * person writes. Falls back outward: end of `<head>`, then a `<head>` of its
 * own, then the top of the file.
 *
 * @returns {{ at: number, text: string }}
 */
function insertionPoint(doc, text) {
  const head = doc.head;
  if (head) {
    const title = (head.children || []).find((c) => c.kind === "element" && c.tag === "title");
    if (title) return { at: title.end, text: `\n${indentAt(text, title.start)}${markerText()}` };
    const elements = (head.children || []).filter((c) => c.kind === "element");
    const last = elements[elements.length - 1];
    if (last) return { at: last.end, text: `\n${indentAt(text, last.start)}${markerText()}` };
    return { at: head.openEnd, text: `\n${markerText()}\n` };
  }

  const html = doc.html;
  if (html) {
    // No `<head>` to write into, so make one. A browser invents a head anyway;
    // writing it down means the next reader does not have to.
    return { at: html.openEnd, text: `\n<head>\n${markerText()}\n</head>` };
  }

  return { at: 0, text: `${markerText()}\n` };
}

/**
 * The new text, or `null` when the marker is already right.
 *
 * @returns {{ text: string, from: string|null, how: string }|null}
 */
function migrateText(doc, text) {
  const meta = findMeta(doc, SCHEMA_META_NAME);

  if (!meta) {
    const { at, text: insertion } = insertionPoint(doc, text);
    return { text: applyEdits(text, [{ start: at, end: at, text: insertion }]), from: null, how: "added" };
  }

  if (meta.value === SCHEMA_VERSION) return null;

  const content = getAttrNode(meta.node, "content");
  if (content && content.valueStart >= 0) {
    // `valueStart` points at the opening quote when there is one — the parser
    // spans `"3.0` rather than `3.0` — so step past it. An unquoted value has no
    // quote and starts where it says. Leave the tag's own spelling alone.
    const start = content.valueStart + (content.quote ? 1 : 0);
    return {
      text: applyEdits(text, [{ start, end: content.valueEnd, text: SCHEMA_VERSION }]),
      from: meta.value ?? null,
      how: "rewritten",
    };
  }

  // A marker with no readable `content`: give it one, right after the `name`
  // attribute, rather than rewriting the whole tag.
  const name = getAttrNode(meta.node, "name");
  const at = name ? name.end : meta.node.start + 1 + String(meta.node.rawTag ?? meta.node.tag).length;
  return {
    text: applyEdits(text, [{ start: at, end: at, text: ` content="${SCHEMA_VERSION}"` }]),
    from: null,
    how: "added",
  };
}

/** The one line a human reads, in the house shape. */
function report(receipt, values, file) {
  if (values.json) {
    out(JSON.stringify(receipt));
    return;
  }
  const { errors, warnings } = receipt.summary;
  const tail = `(${errors} errors, ${warnings} warnings)`;
  if (!receipt.changed) {
    out(`${file}: already ${SCHEMA_VERSION} ${tail}`, { quiet: values.quiet });
    return;
  }
  const from = receipt.from === null ? "no marker" : `schema ${receipt.from}`;
  out(`${file}: ${from} → ${SCHEMA_VERSION}, revision ${receipt.revision} ${tail}`, { quiet: values.quiet });
  if (values["dry-run"] && receipt.diff) out(receipt.diff);
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS },
    positionals: { min: 1, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file] = positionals;
  const loaded = await readDesignFile(file);

  if (loaded.format !== "html") {
    const receipt = refusedReceipt("migrate", `${file} is not an HTML design file.`, {
      code: "cli/not-a-design-file",
      diagnostics: [],
      hint: "Only .html design files carry a design-schema marker.",
    });
    reportRefusal(receipt, values, loaded.file);
    return EXIT_INVALID;
  }

  const before = validateDesign(loaded.doc);
  const change = migrateText(loaded.doc, loaded.text);

  if (!change) {
    // Already current. Report the state and touch nothing: not the bytes, not
    // the modification time, not the inode. Re-running a migration must be free.
    const errors = before.filter((d) => d.severity === "error").length;
    const warnings = before.filter((d) => d.severity === "warning").length;
    const receipt = {
      ok: true,
      verb: "migrate",
      applied: [],
      added: [],
      normalized: [],
      dropped: [],
      diagnostics: before,
      revision: revisionOf(loaded.text),
      changed: false,
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
      summary: { errors, warnings },
    };
    report(receipt, values, loaded.file);
    return EXIT_OK;
  }

  // Re-read the result the way any other write does, so a migration is held to
  // the same rule: it may not introduce an error. `migrate` refuses every format
  // but HTML above, so the HTML reader is the one to re-read with.
  const reparsed = parse(change.text, { file: loaded.file, format: "html", source: change.text });
  if (typeof reparsed.source !== "string") reparsed.source = change.text;
  const after = validateDesign(reparsed);
  const introduced = newErrors(before, after);

  if (introduced.length && !values.force) {
    const receipt = refusedReceipt("migrate", "This migration would introduce a new error.", {
      code: "cli/would-introduce-errors",
      diagnostics: introduced,
      hint: introduced[0]?.hint ?? null,
    });
    reportRefusal(receipt, values, loaded.file);
    return EXIT_INVALID;
  }

  if (!values["dry-run"]) writeAtomic(loaded.file, change.text);

  const receipt = {
    ok: true,
    verb: "migrate",
    applied: [],
    added: [],
    normalized: [],
    dropped: [],
    diagnostics: after,
    revision: revisionOf(change.text),
    changed: true,
    from: change.from,
    to: SCHEMA_VERSION,
    how: change.how,
    summary: {
      errors: after.filter((d) => d.severity === "error").length,
      warnings: after.filter((d) => d.severity === "warning").length,
    },
  };
  if (values["dry-run"]) receipt.diff = unifiedDiff(loaded.text, change.text, loaded.file, "migrated");
  report(receipt, values, loaded.file);
  return EXIT_OK;
}
