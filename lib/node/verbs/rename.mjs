/**
 * `node design.mjs rename <file> <old-id> <new-id>`
 *
 * An id is an address. `set --attr data-id=…` can write the attribute, and it is
 * refused so that the one documented way to change an id is this verb: `set`
 * edits the thing a node is, and this verb is the only place that changes what a
 * node is *called*. Nothing else in the document points at an id.
 */

import { EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { applyAndWrite, refusedReceipt, reportRefusal, reportWrite } from "../write-verbs.mjs";
import { ID_PATTERN } from "../../table.mjs";
import { buildIdIndex } from "../../ops.mjs";
import { suggest } from "../../levenshtein.mjs";

export const USAGE = `Usage: node design.mjs rename <file> <old-id> <new-id> [options]

  --force      write even when the edit introduces a new error
  --dry-run    report what would change, write nothing
  --json       print the receipt as JSON
  --quiet      print nothing

Exit codes: 0 renamed, 1 refused, 2 unreadable or bad arguments.

An id is an address, so it is not a property you edit: \`set --attr data-id=…\` is
refused and this verb is the way through. It checks the new id against the one
pattern the format accepts, then writes it.`;

/**
 * The op one rename needs.
 *
 * One op, and no cascade: an id is unique across the file, and nothing else in
 * the document names another element by id.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Array<object>}
 */
export function renameOps(from, to) {
  return [{ op: "set", target: from, prop: "data-id", value: to }];
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS },
    positionals: { min: 3, max: 3 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, from, to] = positionals;
  const loaded = await readDesignFile(file);

  // Checked here, not by the funnel, because the funnel's only guard is the
  // new-error rule and `--force` turns that off. Without this, `--force` would
  // write an id the next `validate` refuses.
  if (!ID_PATTERN.test(to)) {
    const receipt = refusedReceipt("rename", `The id ${JSON.stringify(to)} is not a legal id.`, {
      code: "structure/bad-id",
      diagnostics: [],
      hint: "Start with a letter or _, then letters, digits, _ and - only. 64 characters at most.",
    });
    reportRefusal(receipt, values, file);
    return EXIT_INVALID;
  }

  const index = buildIdIndex(loaded.doc);
  if (!index.has(from)) {
    const near = suggest(from, [...index.keys()]);
    const receipt = refusedReceipt("rename", `No node with data-id ${JSON.stringify(from)}.`, {
      code: "ops/node-not-found",
      diagnostics: [],
      hint: near ? `Did you mean ${JSON.stringify(near)}?` : "Run `design ls` to list the ids in this file.",
    });
    reportRefusal(receipt, values, file);
    return EXIT_INVALID;
  }

  const receipt = await applyAndWrite(loaded, renameOps(from, to), { values, verb: "rename" });
  if (receipt.refused) return EXIT_INVALID;
  reportWrite(receipt, values, file);
  return EXIT_OK;
}
