/**
 * `node design.mjs tokens <file> ls | set <组.名> <值> | rm <组.名>`
 *
 * A design token is not an element, so no other verb can reach it. Without this one,
 * "make the brand color purple" meant rewriting the whole file, which is the one thing
 * `SKILL.md` tells a model never to do ("Write it, do not rewrite it"). v1 could
 * address a token as `/tokens/color/bg`; this is that ability, on a file whose tokens
 * are CSS.
 *
 * Two spellings of a name reach the same token, and `lib/tokens.mjs` is where they
 * become one: `color.accent` (what `plan.md` §5.1 documents, and what a shell can
 * accept without reading `--` as a flag) and `--color-accent` (what the file says, and
 * what `tokens ls` prints).
 *
 * `set` and `rm` go through the same funnel as every other write: re-read, validate,
 * apply, validate, refuse on a NEW error, write atomically, report. So a `set` that
 * would introduce a cycle is refused by name rather than written and discovered later.
 */

import { CliError, EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { applyAndWrite, refusedReceipt, reportRefusal, reportWrite } from "../write-verbs.mjs";
import { groupOfToken, normalizeTokenValue, resolveTokenName, tokenSites } from "../../tokens.mjs";
import { suggest } from "../../levenshtein.mjs";

export const USAGE = `Usage: node design.mjs tokens <file> <subcommand> [options]

  ls                        list the token block, one token per line
  set <组.名> <值>           set a token, adding it when it is not there
  rm <组.名>                 remove a token

A name is written either way, and both mean the same token:

  color.accent              the seven groups are color font space radius size shadow border
  --color-accent            needs a \`--\` first, because a leading dash reads as a flag

    node design.mjs tokens t.html set -- --color-accent '#7c3aed'

Everything after \`--\` is a name or a value, never a flag.

A numeric group carries a unit. \`set space.md 16\` writes 16px, and a value that is not
a length is refused. A color is written as the hex the rest of the file uses. font,
shadow and border values are written as given.

  --dry-run    report what would change, write nothing
  --json       print the receipt as JSON
  --quiet      print nothing
  --help       print this usage

Exit codes: 0 changed, 1 refused, 2 unreadable or bad arguments.`;

/** The file's tokens, plus every name that is declared more than once. */
function sitesOf(loaded) {
  const { sites, duplicates } = tokenSites(loaded.doc);
  return { sites, duplicates };
}

function refuse(loaded, values, message, extra) {
  const receipt = refusedReceipt("tokens", message, { diagnostics: [], ...extra });
  reportRefusal(receipt, values, loaded.file);
  return EXIT_INVALID;
}

async function list(loaded, values) {
  const { sites, duplicates } = sitesOf(loaded);
  const rows = [...sites.values()].map((site) => ({ name: site.name, value: site.value, offset: site.offset }));
  if (values.json) {
    out(JSON.stringify({
      file: loaded.file,
      tokens: rows,
      duplicates: duplicates.map((entry) => entry.name),
    }));
    return EXIT_OK;
  }
  if (rows.length === 0) {
    out(`${loaded.file}: no tokens`, { quiet: false });
    return EXIT_OK;
  }
  out(`${loaded.file}: ${rows.length} token${rows.length === 1 ? "" : "s"}`, { quiet: false });
  for (const row of rows) out(`  ${row.name}  ${row.value}`, { quiet: false });
  for (const entry of duplicates) {
    out(`  ${entry.name} is declared ${entry.offsets.length} times`, { quiet: false });
  }
  return EXIT_OK;
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS },
    positionals: { min: 2, max: 4 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, sub, spec, raw] = positionals;
  if (!["ls", "set", "rm"].includes(sub)) {
    throw new CliError(`Unknown tokens subcommand: ${sub}\n\n${USAGE}`);
  }
  if (sub === "set" && (spec === undefined || raw === undefined)) {
    throw new CliError(`tokens set needs a name and a value\n\n${USAGE}`);
  }
  if (sub === "rm" && spec === undefined) {
    throw new CliError(`tokens rm needs a name\n\n${USAGE}`);
  }

  const loaded = await readDesignFile(file);
  if (sub === "ls") return list(loaded, values);

  let name;
  try {
    name = resolveTokenName(spec);
  } catch (error) {
    // The same code the validator reports for the same problem, so a model that reads
    // one message and writes the other is not being told two different things.
    return refuse(loaded, values, error.message, { code: error.code ?? "style/token-name", hint: error.hint ?? null });
  }

  const { sites, duplicates } = sitesOf(loaded);
  const clash = duplicates.find((entry) => entry.name === name);
  if (clash !== undefined) {
    // `findDeclaration` returns the first declaration and the file has two. A `set`
    // would write to one of them while the other kept winning, and an `rm` would leave
    // the token in place while reporting that it removed it. Both are silent wrong
    // answers, so neither is allowed to happen.
    return refuse(loaded, values, `${name} is declared ${clash.offsets.length} times, so which one to change has no answer.`, {
      code: "cli/duplicate-token",
      hint: "Keep one declaration per token, then run this again.",
    });
  }

  if (sub === "rm") {
    if (!sites.has(name)) {
      const known = [...sites.keys()];
      const closest = suggest(name, known);
      return refuse(loaded, values, `There is no token ${name}.`, {
        code: "cli/no-such-token",
        hint: closest ? `Did you mean ${closest}?` : (known.length === 0 ? "This design has no tokens." : `Declared: ${known.join(", ")}.`),
      });
    }
    const receipt = await applyAndWrite(loaded, [{ op: "unset-token", name }], { values, verb: "tokens" });
    if (receipt.refused) return EXIT_INVALID;
    reportWrite(receipt, values, file);
    return EXIT_OK;
  }

  let normalized;
  try {
    normalized = normalizeTokenValue(groupOfToken(name), raw);
  } catch (error) {
    return refuse(loaded, values, error.message, { code: error.code ?? "style/bad-value", hint: error.hint ?? null });
  }

  const receipt = await applyAndWrite(loaded, [{ op: "set-token", name, value: normalized.value }], { values, verb: "tokens" });
  if (receipt.refused) return EXIT_INVALID;
  reportWrite(receipt, values, file);
  if (normalized.changed && receipt.changed && !values.json && !values.quiet) {
    // Zero silent drops covers a value this tool rewrote as much as one it discarded:
    // `set space.md 16` writes 16px, and the line says so. Same shape as `add`. Not
    // printed when the file did not move — a line about a rewrite that did not happen
    // is the opposite of a report a reader can trust.
    out(`normalized: ${String(raw)} → ${normalized.value}`);
  }
  return EXIT_OK;
}
