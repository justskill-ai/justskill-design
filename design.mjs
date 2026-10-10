#!/usr/bin/env node
/**
 * skill-design v2 — the single entry point.
 *
 *   node design.mjs <verb> [args]
 *
 * Verbs load lazily, so `--help` works before the module a verb needs exists,
 * and a session that only validates never imports the pen reader.
 *
 * Exit codes (docs/format-v3.md §10):
 *   0  success
 *   1  refused or invalid
 *   2  unreadable file or bad arguments
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/node/cli.mjs";
import { assertNodeVersion } from "./lib/node/fs.mjs";

/**
 * The verb table, exported so a test can derive it instead of copying it.
 *
 * `test/contract.test.mjs` checks three things against this object: every verb has a
 * module that exports `USAGE`, every verb is named in `SKILL.md`, and no document names
 * a verb that is not here. A hand-written list in the test would pass while the CLI and
 * the docs drifted apart, which is the failure the check exists to catch.
 */
export const VERBS = {
  new: () => import("./lib/node/verbs/new.mjs"),
  validate: () => import("./lib/node/verbs/validate.mjs"),
  format: () => import("./lib/node/verbs/format.mjs"),
  ls: () => import("./lib/node/verbs/ls.mjs"),
  show: () => import("./lib/node/verbs/show.mjs"),
  add: () => import("./lib/node/verbs/add.mjs"),
  set: () => import("./lib/node/verbs/set.mjs"),
  remove: () => import("./lib/node/verbs/remove.mjs"),
  move: () => import("./lib/node/verbs/move.mjs"),
  rename: () => import("./lib/node/verbs/rename.mjs"),
  migrate: () => import("./lib/node/verbs/migrate.mjs"),
  tokens: () => import("./lib/node/verbs/tokens.mjs"),
  export: () => import("./lib/node/verbs/export.mjs"),
  import: () => import("./lib/node/verbs/import.mjs"),
  serve: () => import("./lib/node/verbs/serve.mjs"),
};

export const USAGE = `skill-design — design web pages as a validated HTML file

Usage: node design.mjs <verb> [args]

Verbs:
  new <file> [--name N] [--title T] [--tokens neutral|brand|dark | --tokens-file P] [--size WxH]
  validate <file> [--json] [--strict]
  format <file> [--check] [--dry-run]
  ls <file> [--pages] [--in <data-id>] [--depth n] [--json]
  show <file> <data-id> [--json]
  add <file> --html-file f | --html - [--in <data-id>] [--as <id>] [--index n]
  set <file> <data-id> [--style 'a:b;c:d'] [--text T] [--attr name=value] [--unset name]
  remove <file> <data-id>
  move <file> <data-id> [--before X | --after X | --index n | --into P]
  rename <file> <old-id> <new-id>
  migrate <file>
  tokens <file> ls | set <组.名> <值> | rm <组.名>
  export <file> [--page <id>] [--all] [-o path] [--resolve-tokens] [--stdout]
  import pen <file> [-o out.html] [--report ledger.json]
  serve [<file>] [--port 0] [--ttl 30] [--no-open]

Shared flags: --json  --quiet  --dry-run  --force  --help

Exit codes: 0 success, 1 refused or invalid, 2 unreadable file or bad arguments.

Each line above lists the flags that matter most, not all of them; "export" alone has
nine. Run "node design.mjs <verb> --help" for the full set of one verb.`;

function print(text, stream = process.stdout) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function version() {
  try {
    const file = fileURLToPath(new URL("./package.json", import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Map a thrown error to an exit code and a message on stderr.
 *
 * @param {any} error
 * @returns {number}
 */
function reportError(error) {
  const message = error && error.message ? error.message : String(error);
  const name = error && error.name;
  if (name === "CliError") {
    print(message, process.stderr);
    return Number.isInteger(error.exitCode) ? error.exitCode : 2;
  }
  if (name === "FsError") {
    print(`ERROR  ${message}`, process.stderr);
    return error.code === "fs/no-write" ? 1 : 2;
  }
  if (name === "SpansError" || name === "DetectError") {
    print(`ERROR  ${message}`, process.stderr);
    return 2;
  }
  print(`ERROR  ${message}`, process.stderr);
  if (process.env.SD_TRACE && error && error.stack) print(error.stack, process.stderr);
  return 1;
}

/**
 * Run one command line.
 *
 * @param {string[]} [argv] defaults to `process.argv.slice(2)`
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const verb = args[0];

  try {
    assertNodeVersion();
  } catch (error) {
    return reportError(error);
  }

  if (verb === undefined) {
    print(USAGE, process.stderr);
    return 2;
  }
  if (verb === "help" || verb === "--help" || verb === "-h") {
    print(USAGE);
    return 0;
  }
  if (verb === "--version" || verb === "-v") {
    print(version());
    return 0;
  }
  if (verb.startsWith("-")) {
    print(`Unknown option: ${verb}\n\n${USAGE}`, process.stderr);
    return 2;
  }

  const load = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
  if (!load) {
    print(`Unknown verb: ${verb}\n\n${USAGE}`, process.stderr);
    return 2;
  }

  try {
    const mod = await load();
    const run = typeof mod.default === "function" ? mod.default : mod.run;
    if (typeof run !== "function") {
      print(`The ${verb} verb exports no run()`, process.stderr);
      return 1;
    }
    const code = await run(args.slice(1));
    return Number.isInteger(code) ? code : 0;
  } catch (error) {
    return reportError(error);
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
