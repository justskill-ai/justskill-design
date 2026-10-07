/**
 * Node-only file helpers: reading, atomic writing, hashing, watching.
 *
 * This module and the rest of `lib/node/` are the only places that import
 * `node:*`. Keep it that way — the browser canvas imports the other `lib/`
 * modules directly.
 *
 * Every failure is an `FsError` with a code the CLI can map to an exit code:
 * `fs/not-found`, `fs/unreadable`, `fs/no-write`.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MIN_NODE_MAJOR = 18;

export class FsError extends Error {
  /**
   * @param {string} code  `fs/not-found` | `fs/unreadable` | `fs/no-write` | …
   * @param {string} message
   * @param {string} [file]
   */
  constructor(code, message, file) {
    super(message);
    this.name = "FsError";
    this.code = code;
    if (file !== undefined) this.file = file;
  }
}

function errnoOf(error) {
  return error && typeof error.code === "string" ? error.code : "";
}

/** Node's major version, as a number. */
export function nodeMajor(version = process.versions.node) {
  return Number(String(version).split(".")[0]);
}

/** True when the runtime is new enough for this tool. */
export function nodeVersionOk(version = process.versions.node) {
  return nodeMajor(version) >= MIN_NODE_MAJOR;
}

/** Throw when the runtime is too old. */
export function assertNodeVersion() {
  if (nodeVersionOk()) return;
  throw new FsError(
    "fs/node-version",
    `skill-design needs Node ${MIN_NODE_MAJOR} or newer, but this is Node ${process.versions.node}.\n` +
      "Install a current Node release (https://nodejs.org) and run the command again.",
  );
}

/**
 * Read a text file.
 *
 * @param {string} file
 * @returns {string}
 * @throws {FsError} `fs/not-found` when it does not exist, `fs/unreadable`
 *   otherwise (a directory, a permission problem, a broken link)
 */
export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === "ENOENT" || errno === "ENOTDIR") {
      throw new FsError("fs/not-found", `No such file: ${file}`, file);
    }
    if (errno === "EISDIR") {
      throw new FsError("fs/unreadable", `Cannot read ${file}: it is a directory`, file);
    }
    if (errno === "EACCES") {
      throw new FsError("fs/unreadable", `Cannot read ${file}: permission denied`, file);
    }
    throw new FsError("fs/unreadable", `Cannot read ${file}: ${error.message}`, file);
  }
}

/** True when anything exists at `file` (a file or a directory). */
export function fileExists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The content hash of a text: the first 8 hex digits of sha256.
 *
 * Short on purpose — it labels a revision in a message, it does not guard a
 * download.
 *
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 8);
}

/**
 * The revision of a design file's text.
 *
 * Accepts a string, and tolerates a document object by hashing its `source` —
 * the text the document was parsed from.
 *
 * @param {string|{source?: string}} text
 * @returns {string}
 */
export function revisionOf(text) {
  if (typeof text === "string") return hashText(text);
  if (text && typeof text.source === "string") return hashText(text.source);
  return hashText(String(text));
}

/**
 * Write `text` to `file` atomically: write a sibling temp file, fsync it,
 * rename it over the target. A rename within one directory is atomic on POSIX,
 * so a reader never sees a half-written design file, and the file's mode is the
 * usual 0644 whatever the process umask says.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{file: string, bytes: number}}
 * @throws {FsError} `fs/no-write`
 */
export function writeAtomic(file, text) {
  const target = String(file);
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const body = String(text);

  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o644);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the descriptor may already be gone */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
    const errno = errnoOf(error);
    if (errno === "ENOENT") {
      throw new FsError("fs/no-write", `Cannot write ${target}: no such directory ${dir}`, target);
    }
    if (errno === "EACCES" || errno === "EPERM" || errno === "EROFS") {
      throw new FsError("fs/no-write", `Cannot write ${target}: permission denied`, target);
    }
    if (errno === "EISDIR") {
      throw new FsError("fs/no-write", `Cannot write ${target}: it is a directory`, target);
    }
    throw new FsError("fs/no-write", `Cannot write ${target}: ${error.message}`, target);
  }

  return { file: target, bytes: Buffer.byteLength(body, "utf8") };
}

/**
 * A small line diff, enough for a CLI preview.
 *
 * The common prefix and suffix are found, and everything between them becomes
 * one hunk of `-` and `+` lines with `context` unchanged lines around it. This
 * is not a general-purpose diff: a preview of a targeted edit is what it is for.
 *
 * @param {string} before
 * @param {string} after
 * @param {string} [labelA]
 * @param {string} [labelB]
 * @returns {string} `""` when nothing changed
 */
export function unifiedDiff(before, after, labelA = "before", labelB = "after") {
  if (labelA && typeof labelA === "object") {
    const options = labelA;
    labelA = options.labelA || options.label || "before";
    labelB = options.labelB || options.label || "after";
  }
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  if (String(before) === String(after)) return "";
  const context = 3;

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > head && bEnd > head && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1;
    bEnd -= 1;
  }

  const from = Math.max(0, head - context);
  const aTo = Math.min(a.length, aEnd + context);
  const bTo = Math.min(b.length, bEnd + context);

  const lines = [
    `--- ${labelA}`,
    `+++ ${labelB}`,
    `@@ -${from + 1},${aTo - from} +${from + 1},${bTo - from} @@`,
  ];
  for (let i = from; i < head; i += 1) lines.push(` ${a[i]}`);
  for (let i = head; i < aEnd; i += 1) lines.push(`-${a[i]}`);
  for (let i = head; i < bEnd; i += 1) lines.push(`+${b[i]}`);
  for (let i = aEnd; i < aTo; i += 1) lines.push(` ${a[i]}`);

  return `${lines.join("\n")}\n`;
}

/**
 * Watch a directory, debounced.
 *
 * `onChange` is called at most once per 100 ms of quiet with the batch of
 * events that arrived in that window:
 *
 *   onChange([{ eventType: "change", filename: "home.html", file: "/abs/home.html" }])
 *
 * Recursive watching is used where the platform supports it (macOS, Windows,
 * and Linux on Node 20+) and falls back to the immediate directory otherwise.
 *
 * @param {string} dir
 * @param {(events: {eventType: string, filename: string, file: string}[]) => void} onChange
 * @returns {() => void} close the watcher
 * @throws {FsError} `fs/not-found` / `fs/unreadable`
 */
export function walkWatch(dir, onChange) {
  const root = String(dir);
  const pending = new Map();
  let timer = null;
  let watcher = null;

  const flush = () => {
    timer = null;
    const events = [...pending.values()];
    pending.clear();
    if (events.length === 0) return;
    try {
      onChange(events);
    } catch {
      /* a listener that throws must not kill the watcher */
    }
  };

  const listener = (eventType, filename) => {
    const name = filename === null || filename === undefined ? "" : String(filename);
    pending.set(name, { eventType: String(eventType), filename: name, file: name ? path.join(root, name) : root });
    if (timer === null) timer = setTimeout(flush, 100);
  };

  const open = (options) => fs.watch(root, options, listener);

  try {
    watcher = open({ recursive: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") throw new FsError("fs/not-found", `No such directory: ${root}`, root);
    try {
      watcher = open({});
    } catch (fallbackError) {
      const errno = errnoOf(fallbackError);
      if (errno === "ENOENT") throw new FsError("fs/not-found", `No such directory: ${root}`, root);
      throw new FsError("fs/unreadable", `Cannot watch ${root}: ${fallbackError.message}`, root);
    }
  }

  watcher.on("error", () => {
    /* a watcher error is not a reason to crash the process */
  });

  return function close() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  };
}
