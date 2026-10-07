/**
 * `node design.mjs format <file> [--check] [--dry-run]` — canonical text.
 *
 * `lib/normalize.mjs` decides what has to change; `lib/serialize.mjs` renders
 * the result. `--check` writes nothing and exits 1 when the file is not
 * canonical, which is what CI and a pre-commit hook use.
 */

import process from "node:process";

import { EXIT_INVALID, EXIT_OK, SHARED_FLAGS, loadExport, out, parseArgs, readDesignFile } from "../cli.mjs";
import { writeAtomic } from "../fs.mjs";

export const USAGE = `Usage: node design.mjs format <file> [options]

  --check     write nothing; exit 1 when the file is not canonical
  --dry-run   print the canonical text and write nothing
  --json      print one line of JSON instead of a human line
  --quiet     print nothing on success
  --help      print this usage

Exit codes: 0 canonical, 1 not canonical, 2 unreadable.`;

/**
 * Run both normalization layers and return the text to write.
 *
 * Layer one is semantic and lives in `lib/normalize.mjs`; it edits the document
 * in place. Layer two is textual — LF line endings, one final newline — and is
 * applied to the serialized result. `changed` is decided by comparing the final
 * text with what is on disk, never by trusting a flag: that way a file whose
 * only problem is a CRLF still counts as changed.
 */
async function normalize(loaded) {
  const serialize = await loadExport("serialize.mjs", ["serialize", "default"], "serialize");
  const normalizeDocument = await loadExport(
    "normalize.mjs",
    ["normalizeDocument", "normalize", "default"],
    "normalizeDocument",
  );
  const normalizeText = await loadExport("normalize.mjs", ["normalizeText"], "normalizeText");

  // `serialize(origin, next)` diffs `next` against the `_raw` snapshots on the
  // document that was read, which is what keeps the edit minimal.
  const produced = await normalizeDocument(loaded.doc, {
    file: loaded.file,
    text: loaded.text,
    format: loaded.format,
    serialize: (origin, next) => serialize(origin, next),
  });

  const nextDoc = produced && typeof produced === "object" && produced.doc ? produced.doc : produced;
  if (!nextDoc || typeof nextDoc !== "object") {
    throw new Error("normalizeDocument() returned no document");
  }

  let text = produced && typeof produced.text === "string" ? produced.text : serialize(loaded.doc, nextDoc);
  if (typeof text !== "string") text = loaded.text;

  const layered = normalizeText(text);
  text = typeof layered === "string" ? layered : layered && typeof layered.text === "string" ? layered.text : text;

  return { text, changed: text !== loaded.text };
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS, check: { type: "boolean" } },
    positionals: { min: 1, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const file = positionals[0];
  const loaded = await readDesignFile(file);
  const { text, changed } = await normalize(loaded);
  const canonical = !changed && text === loaded.text;

  if (values.check) {
    if (values.json) {
      out(JSON.stringify({ file, canonical, changed: !canonical, revision: loaded.revision }));
    } else {
      out(`${file}: ${canonical ? "canonical" : "not canonical"}`);
    }
    return canonical ? EXIT_OK : EXIT_INVALID;
  }

  if (values["dry-run"]) {
    // The dry run's whole value is the text, so it prints even under --quiet.
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    out(`${file}: ${canonical ? "already canonical" : "would change"}`, { quiet: values.quiet });
    return EXIT_OK;
  }

  if (canonical) {
    out(`${file}: already canonical`, { quiet: values.quiet });
    return EXIT_OK;
  }

  const written = writeAtomic(file, text);
  out(`${file}: formatted (${written.bytes} bytes)`, { quiet: values.quiet });
  return EXIT_OK;
}
