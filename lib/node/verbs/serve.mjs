/**
 * `node design.mjs serve [<file>] [--port 0] [--ttl 30] [--no-open] [--force]`
 *
 * Opens the canvas: a transient local service on 127.0.0.1 that serves the
 * design file as text, applies the ops the browser sends through the same write
 * funnel as `add`, and closes when the browser says goodbye, when it has been
 * idle for the TTL, or on SIGINT/SIGTERM.
 *
 * Invariants this verb upholds:
 *
 *   - It prints the tokenised URL and nothing else; the service itself prints
 *     nothing, so a URL can never be lost inside a log line.
 *   - It stays in the foreground until the service closes, and a clean close —
 *     bye, TTL or signal — exits 0.
 *   - Opening the browser is best effort. A missing opener is not a failure.
 */

import { spawn } from "node:child_process";
import process from "node:process";

import {
  CliError, EXIT_OK, EXIT_UNREADABLE, SHARED_FLAGS, out, parseArgs, readDesignFile,
} from "../cli.mjs";
import { fileExists, readText, revisionOf } from "../fs.mjs";
import { startServer } from "../server.mjs";

export const USAGE = `Usage: node design.mjs serve [<file>] [options]

  --port <n>     the port to listen on (default 0: the OS picks a free one)
  --ttl <min>    close after this many idle minutes (default 30; 0 never closes)
  --no-open      do not open the browser
  --open         open the browser even with --json
  --force        write even when an edit introduces a new error
  --log          append a JSONL change log beside the design file
  --verbose      print the service's log lines on stderr
  --json         print one line: { url, port, file, revision }
  --quiet        print only the URL
  --help         print this usage

The default file is design.html in the working directory.

Exit codes: 0 closed, 1 refused, 2 unreadable or bad arguments.`;

/**
 * Open `url` in the platform's browser.
 *
 * Detached and silent on purpose: the browser outlives this process, and a
 * machine with no opener (a container, a bare CI runner) must not turn a
 * working canvas into a failed command.
 *
 * @param {string} url
 */
export function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd builtin, so it needs a shell to run it.
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      /* no opener on this machine */
    });
    child.unref();
  } catch {
    /* no opener on this machine */
  }
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      port: { type: "number" },
      ttl: { type: "number" },
      open: { type: "boolean" },
      log: { type: "boolean" },
      verbose: { type: "boolean" },
    },
    positionals: { min: 0, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const file = positionals[0] ?? "design.html";
  const port = values.port === undefined ? 0 : values.port;
  const ttl = values.ttl === undefined ? 30 : values.ttl;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`--port takes an integer from 0 to 65535, got ${JSON.stringify(values.port)}`, EXIT_UNREADABLE, "serve/bad-port");
  }
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new CliError(`--ttl takes a number of minutes, 0 or more, got ${JSON.stringify(values.ttl)}`, EXIT_UNREADABLE, "serve/bad-ttl");
  }
  if (!fileExists(file)) {
    throw new CliError(
      `No such file: ${file}\nCreate one first: node design.mjs new ${file} --name home`,
      EXIT_UNREADABLE,
      "fs/not-found",
    );
  }

  // The file must be readable to serve it; an invalid file only makes the canvas
  // read-only, so a parse failure here is reported and then ignored.
  const source = readText(file);
  let revision = revisionOf(source);
  let warning = null;
  try {
    const loaded = await readDesignFile(file);
    revision = loaded.revision;
  } catch (error) {
    if (error && error.name === "FsError") throw error;
    warning = error && error.message ? error.message : String(error);
  }

  const server = await startServer({
    file,
    port,
    ttlMinutes: ttl,
    force: values.force === true,
    log: values.log === true,
    onLog: (line) => {
      if (values.verbose) process.stderr.write(`${line}\n`);
    },
  });

  if (values.json) {
    // The machine-readable line stays exactly one line; a problem with the file
    // goes to stderr, where a caller can see it without parsing it.
    if (warning) process.stderr.write(`warning: ${warning}\n`);
    out(JSON.stringify({ url: server.url, port: server.port, file, revision }));
  } else if (values.quiet) {
    out(server.url);
  } else {
    const lines = [`justSkill canvas  ${server.url}`, `  ${file}  revision ${revision}`];
    if (server.state().readOnly) lines.push(`  read only  ${server.state().readOnlyReason}`);
    if (warning) lines.push(`  warning  ${warning}`);
    if (ttl > 0) lines.push(`  closes after ${ttl} idle minute${ttl === 1 ? "" : "s"}, or with Ctrl-C`);
    out(lines.join("\n"));
  }

  const shouldOpen = values.json === true || values.quiet === true
    ? values.open === true
    : values.open !== false;
  if (shouldOpen) openBrowser(server.url);

  const reason = await server.closed;
  if (!values.json) out(`closed: ${reason}`, { quiet: values.quiet });
  return EXIT_OK;
}
