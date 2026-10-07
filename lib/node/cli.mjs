/**
 * The Node side of the command line: entry-point detection, argument parsing,
 * the shared flags every verb accepts, and reading a design file once.
 *
 * A verb's `run()` returns the exit code: 0 success, 1 refused or invalid,
 * 2 unreadable file or bad arguments (docs/format-v3.md §10).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { detectFormat, readerFor } from "../detect.mjs";
import { readText, revisionOf } from "./fs.mjs";

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_UNREADABLE = 2;

/** An error a verb raises to stop with a specific exit code and message. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode] defaults to 2 — bad arguments
   * @param {string} [code]
   */
  constructor(message, exitCode = EXIT_UNREADABLE, code = "cli/error") {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

/**
 * Was this module the script Node was asked to run?
 *
 * The obvious test — `process.argv[1] === fileURLToPath(import.meta.url)` — is
 * wrong for a skill, because that is exactly how a skill gets invoked:
 *
 *   ~/.claude/skills/skill-design -> ~/.agents/skills/skill-design -> the repo
 *
 * Node's ESM loader resolves symlinks, so `import.meta.url` is the real
 * repository path while `process.argv[1]` is whatever the caller typed. The two
 * never match, `main()` never runs, and the process still exits 0 with no
 * output. A silent success is the worst possible failure, so both sides are
 * resolved properly here.
 *
 * @param {string} importMetaUrl pass `import.meta.url`
 * @param {string} [argv1] defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;

  const self = fileURLToPath(importMetaUrl);

  let realSelf;
  let realArgv;
  try {
    realSelf = fs.realpathSync(self);
    realArgv = fs.realpathSync(argv1);
  } catch {
    // One of them does not exist, which happens in a bundled or piped
    // invocation. Fall back to a plain comparison, still right when unlinked.
    return path.resolve(argv1) === path.resolve(self);
  }

  return realArgv === realSelf;
}

/**
 * A path to show a human: relative when that is shorter and still meaningful,
 * absolute otherwise.
 *
 * `path.relative` happily produces `../../../../../tmp/x.html` for a file
 * outside the working directory, which tells the reader nothing.
 */
export function relativeOrAbsolute(target, cwd = process.cwd()) {
  const relative = path.relative(cwd, target);
  if (!relative) return target;
  return relative.startsWith("..") ? target : relative;
}

/** The flags every verb accepts. Merge into a verb's own `flags`. */
export const SHARED_FLAGS = {
  json: { type: "boolean", help: "print JSON instead of a human report" },
  quiet: { type: "boolean", alias: ["q"], help: "print nothing on success" },
  "dry-run": { type: "boolean", help: "print the result and write nothing" },
  force: { type: "boolean", help: "proceed when the file already exists" },
  help: { type: "boolean", alias: ["h"], help: "print this usage" },
};

function aliasesOf(definition) {
  const alias = definition && definition.alias;
  if (!alias) return [];
  return Array.isArray(alias) ? alias.map(String) : [String(alias)];
}

function parseBoolean(raw, token) {
  const value = String(raw).toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new CliError(`Option ${token} takes true or false, got ${JSON.stringify(raw)}`);
}

/**
 * Parse `argv` against a spec.
 *
 * ```js
 * parseArgs(argv, {
 *   flags: { ...SHARED_FLAGS, name: { type: "string" }, depth: { type: "number" } },
 *   positionals: { min: 1, max: 1 },
 *   usage: USAGE,
 * })
 * ```
 *
 * Supported forms: `--flag`, `--flag=value`, `--flag value`, `--no-flag`, and
 * single-letter aliases (`-q`). `--` ends flag parsing; everything after it is a
 * positional. An unknown option is an error unless `spec.allowUnknown`.
 *
 * @param {string[]} argv
 * @param {{flags?: object, positionals?: {min?: number, max?: number}, usage?: string, allowUnknown?: boolean}} [spec]
 * @returns {{values: Record<string, any>, positionals: string[], provided: Set<string>, has: (name: string) => boolean}}
 * @throws {CliError} exit code 2 when the arguments are wrong
 */
export function parseArgs(argv, spec = {}) {
  const flags = { ...SHARED_FLAGS, ...(spec.flags || {}) };
  const lookup = new Map();
  for (const [name, definition] of Object.entries(flags)) {
    lookup.set(`--${name}`, { name, definition: definition || {} });
    for (const alias of aliasesOf(definition)) {
      lookup.set(alias.length === 1 ? `-${alias}` : `--${alias}`, { name, definition: definition || {} });
    }
  }

  const values = {};
  for (const [name, definition] of Object.entries(flags)) {
    if (definition && "default" in definition) values[name] = definition.default;
  }

  const args = Array.isArray(argv) ? argv.map(String) : [];
  const positionals = [];
  const provided = new Set();
  let index = 0;
  let stopped = false;

  const usageSuffix = spec.usage ? `\n\n${String(spec.usage).trim()}` : "";

  while (index < args.length) {
    const arg = args[index];

    if (stopped || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      index += 1;
      continue;
    }
    if (arg === "--") {
      stopped = true;
      index += 1;
      continue;
    }

    let token = arg;
    let inline = null;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals !== -1) {
      token = arg.slice(0, equals);
      inline = arg.slice(equals + 1);
    }

    let entry = lookup.get(token);
    let negated = false;
    if (!entry && token.startsWith("--no-")) {
      entry = lookup.get(`--${token.slice(5)}`);
      negated = true;
    }
    if (!entry) {
      if (spec.allowUnknown) {
        values[token.replace(/^--?/, "")] = inline === null ? true : inline;
        index += 1;
        continue;
      }
      throw new CliError(`Unknown option: ${arg}${usageSuffix}`);
    }

    const { name, definition } = entry;
    const type = definition.type || "boolean";
    index += 1;

    if (type === "boolean") {
      values[name] = negated ? false : inline === null ? true : parseBoolean(inline, token);
      provided.add(name);
      continue;
    }

    let raw = inline;
    if (raw === null) {
      if (index >= args.length) throw new CliError(`Option ${token} needs a value${usageSuffix}`);
      raw = args[index];
      index += 1;
    }

    if (type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        throw new CliError(`Option ${token} needs a number, got ${JSON.stringify(raw)}${usageSuffix}`);
      }
      values[name] = number;
    } else if (type === "list") {
      if (!Array.isArray(values[name])) values[name] = [];
      values[name].push(raw);
    } else {
      values[name] = raw;
    }
    provided.add(name);
  }

  // `--help` wins over a missing argument: `validate --help` must print the
  // usage, not complain that no file was given.
  if (values.help === true) {
    return { values, positionals, provided, has: (name) => provided.has(name) };
  }

  const minimum = spec.positionals && spec.positionals.min;
  const maximum = spec.positionals && spec.positionals.max;
  if (Number.isInteger(minimum) && positionals.length < minimum) {
    throw new CliError(`Expected ${minimum} argument${minimum === 1 ? "" : "s"}, got ${positionals.length}${usageSuffix}`);
  }
  if (Number.isInteger(maximum) && positionals.length > maximum) {
    throw new CliError(`Unexpected extra argument: ${positionals[maximum]}${usageSuffix}`);
  }

  return { values, positionals, provided, has: (name) => provided.has(name) };
}

/**
 * Print to stderr and exit.
 *
 * @param {string} message
 * @param {number} [code] defaults to 1 — refused or invalid
 * @returns {never}
 */
export function fail(message, code = EXIT_INVALID) {
  const text = message === undefined || message === null ? "" : String(message);
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  process.exitCode = code;
  process.exit(code);
}

/**
 * Print one line to stdout, unless the caller asked for quiet.
 *
 * @param {string} text
 * @param {{quiet?: boolean, stream?: NodeJS.WriteStream, newline?: boolean}} [options]
 * @returns {boolean} true when something was written
 */
export function out(text, options = {}) {
  if (options && options.quiet) return false;
  const stream = (options && options.stream) || process.stdout;
  const value = text === undefined || text === null ? "" : String(text);
  stream.write(options && options.newline === false ? value : `${value}\n`);
  return true;
}

function pickExport(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (name === "default") {
      if (typeof mod.default === "function") return mod.default;
      continue;
    }
    if (typeof mod[name] === "function") return mod[name];
  }
  return null;
}

function unwrapDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind === "document") return value;
  if (value.doc && typeof value.doc === "object") {
    const doc = unwrapDocument(value.doc);
    if (doc && !Array.isArray(doc.diagnostics) && Array.isArray(value.diagnostics)) {
      doc.diagnostics = value.diagnostics;
    }
    return doc;
  }
  if (value.value && typeof value.value === "object") return unwrapDocument(value.value);
  if (Array.isArray(value.children) || value.html || value.body) return value;
  return null;
}

/**
 * Read a design file and parse it with the reader its format selects.
 *
 * This is the shared front door of every verb. It uses `detectFormat` then the
 * reader — never a hard-coded path — so a `.pen` file and an `.html` file are
 * one code path.
 *
 * @param {string} file
 * @returns {Promise<{file: string, text: string, format: string, doc: object, revision: string}>}
 * @throws {FsError} `fs/not-found` / `fs/unreadable` — the caller maps these to exit 2
 * @throws {CliError} exit 2 for an unknown format or a reader that throws
 */
export async function readDesignFile(file) {
  const target = String(file === undefined || file === null ? "" : file);
  if (target === "") throw new CliError("No file given");

  const text = readText(target);
  const format = detectFormat(target, text);
  if (format === "unknown") {
    throw new CliError(
      `Cannot tell what ${target} is: expected .html markup or .pen JSON`,
      EXIT_UNREADABLE,
      "detect/unknown-format",
    );
  }

  const load = readerFor(format);
  let mod;
  try {
    mod = await load();
  } catch (error) {
    throw new CliError(`Cannot load the ${format} reader: ${error.message}`, EXIT_UNREADABLE, "cli/reader");
  }

  const parse = pickExport(mod, ["parseHtml", "parse", "parseDocument", "read", "default"]);
  if (!parse) {
    throw new CliError(`The ${format} reader (lib/parse.mjs) exports no parse function`, EXIT_UNREADABLE, "cli/reader");
  }

  let produced;
  try {
    produced = parse(text, { file: target, format, source: text });
    if (produced && typeof produced.then === "function") produced = await produced;
  } catch (error) {
    throw new CliError(`${target}: ${error.message}`, EXIT_UNREADABLE, "cli/parse");
  }

  const doc = unwrapDocument(produced);
  if (!doc) {
    throw new CliError(`${target}: the ${format} reader returned no document`, EXIT_UNREADABLE, "cli/parse");
  }
  if (typeof doc.source !== "string") {
    try {
      doc.source = text;
    } catch {
      /* a frozen document still works: `ls` and `show` fall back to the text */
    }
  }

  return { file: target, text, format, doc, revision: revisionOf(text) };
}

/** `lib/` — every module a verb may need lives here, whatever the verb's directory. */
const LIB_ROOT = new URL("../", import.meta.url);

/**
 * Import a `lib/` module and take the first function it exports under one of
 * `names`.
 *
 * The specifier is a bare file name inside `lib/` — `"validate.mjs"` — so a verb
 * in `lib/node/verbs/` never has to work out how many `../` it needs.
 *
 * @param {string} specifier a path inside `lib/`, for example `"validate.mjs"`
 * @param {string[]} names export names to try, in order
 * @param {string} what human name of the export, for the error message
 * @returns {Promise<Function>}
 */
export async function loadExport(specifier, names, what) {
  let mod;
  try {
    mod = await import(new URL(specifier, LIB_ROOT).href);
  } catch (error) {
    throw new CliError(`Cannot load lib/${specifier}: ${error.message}`, EXIT_UNREADABLE, "cli/module");
  }
  const fn = pickExport(mod, names);
  if (!fn) throw new CliError(`lib/${specifier} exports no ${what}()`, EXIT_UNREADABLE, "cli/module");
  return fn;
}
