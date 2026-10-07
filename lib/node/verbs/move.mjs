/**
 * `node design.mjs move <file> <data-id> [--before X] [--after X] [--index n] [--into P]`
 *
 * One op. A move is addressed by data-id, never by a CSS selector, so it is
 * unambiguous and it survives a sibling being inserted or removed.
 */

import { EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { applyAndWrite, reportWrite } from "../write-verbs.mjs";

export const USAGE = `Usage: node design.mjs move <file> <data-id> [options]

  --before <data-id>   put it immediately before this sibling
  --after <data-id>    put it immediately after this sibling
  --index <n>          put it at this position (0 is first)
  --into <data-id>     put it inside this element, last
  --force              write even when the edit introduces a new error
  --dry-run            report what would change, write nothing
  --json               print the receipt as JSON
  --quiet              print nothing

Exactly one destination is required.

Exit codes: 0 moved, 1 refused, 2 unreadable or bad arguments.

A move cannot put an element inside its own subtree, and it cannot make a
non-container hold children. Both are refused by name.`;

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      before: { type: "string" },
      after: { type: "string" },
      index: { type: "string" },
      into: { type: "string" },
    },
    positionals: { min: 2, max: 2 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, target] = positionals;
  const destinations = ["before", "after", "index", "into"].filter((key) => values[key] !== undefined);
  if (destinations.length === 0) {
    out("REFUSED  Where should it go? Use --before, --after, --index or --into.");
    return 1;
  }
  if (destinations.length > 1) {
    out(`REFUSED  One destination at a time, and ${destinations.length} were given: ${destinations.join(", ")}.`);
    return 1;
  }

  const op = { op: "move", target };
  const key = destinations[0];
  if (key === "index") {
    const index = Number(values.index);
    if (!Number.isInteger(index) || index < 0) {
      out(`REFUSED  --index wants a number from 0 up, and got ${JSON.stringify(values.index)}.`);
      return 1;
    }
    op.index = index;
  } else {
    op[key] = values[key];
  }

  const loaded = await readDesignFile(file);
  const receipt = await applyAndWrite(loaded, [op], { values, verb: "move" });
  if (receipt.refused) return 1;
  reportWrite(receipt, values, file);
  return EXIT_OK;
}
