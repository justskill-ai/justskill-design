/**
 * `node design.mjs remove <file> <data-id>`
 *
 * One op. The element and its subtree go, and the inverse op carries the whole
 * removed subtree back, so undo restores the exact bytes.
 */

import { EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { applyAndWrite, reportWrite } from "../write-verbs.mjs";

export const USAGE = `Usage: node design.mjs remove <file> <data-id> [options]

  --force      write even when the edit introduces a new error
  --dry-run    report what would change, write nothing
  --json       print the receipt as JSON
  --quiet      print nothing

Exit codes: 0 removed, 1 refused, 2 unreadable or bad arguments.

Removing a page removes its whole subtree. Removing a component refuses nothing,
but every instance that referenced it becomes an unknown reference, which the
validator will report as a new error.`;

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS },
    positionals: { min: 2, max: 2 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, target] = positionals;
  const loaded = await readDesignFile(file);
  const receipt = await applyAndWrite(loaded, [{ op: "remove", target }], { values, verb: "remove" });
  if (receipt.refused) return 1;
  reportWrite(receipt, values, file);
  return EXIT_OK;
}
