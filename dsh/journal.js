/**
 * dsh/journal.js — the plugin's own record of which pages a turn changed.
 *
 * Nothing here touches the design CLI or the workspace. A shell-env
 * contributor sees every model shell call before it executes, recognizes this
 * package's own write commands, and attributes each one to a page by reading
 * the design file as it stands before the write. A `tools/result` listener
 * then confirms the write actually landed — a refusal leaves the file
 * byte-identical, so a content hash taken before the call settles the
 * question without depending on shell exit codes. Only then does an entry
 * enter the journal.
 *
 * The journal lives in plugin-owned storage (the DSH profile directory) so
 * pills survive a restart; with no profile directory it degrades to memory.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getAttr, pagesOf, parse, walk } from "../lib/parse.mjs";

/** Verbs that change pages. `tokens`, `format` and friends are deliberately out. */
export const WRITE_VERBS = new Set(["new", "add", "set", "move", "remove", "rename", "import"]);

/** Verbs whose command line names an element or container to attribute by. */
const TARGET_VERBS = new Set(["add", "set", "move", "remove", "rename"]);

const BOOLEAN_FLAGS = new Set(["force", "dry-run", "json", "quiet", "help", "h", "stdout"]);

/** Upper bound for the journal file; past it the oldest half is dropped. */
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Command-line recognition
 * ------------------------------------------------------------------ */

/**
 * Split a shell command into segments at `&&`, `||`, `;`, `|` and newlines,
 * honoring quotes. A `cd <dir>` segment carries its directory into the
 * segments after it, so `cd sub && node design.mjs …` resolves the file
 * against the directory the model actually stood in.
 * @param {string} command the shell command.
 * @returns {{text: string, workdir: string | null}[]} segments with workdirs.
 */
export function splitShellSegments(command) {
  const segments = [];
  let start = 0;
  let quote = null;
  const push = (end) => {
    const text = command.slice(start, end).trim();
    if (text === "") return;
    const previous = segments[segments.length - 1];
    let workdir = previous ? previous.workdir : null;
    const tokens = tokenizeShell(text);
    if (tokens !== null && tokens.length >= 2 && tokens[0] === "cd") {
      workdir = tokens[1];
    }
    segments.push({ text, workdir });
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\n" || char === ";") {
      push(i);
      start = i + 1;
      continue;
    }
    if (char === "|") {
      const doubled = command[i + 1] === "|";
      push(i);
      start = doubled ? i + 2 : i + 1;
      if (doubled) i += 1;
      continue;
    }
    if (char === "&") {
      const doubled = command[i + 1] === "&";
      push(i);
      start = doubled ? i + 2 : i + 1;
      if (doubled) i += 1;
      continue;
    }
  }
  push(command.length);
  return segments;
}

/**
 * A small shell-like tokenizer: single and double quotes, backslash escapes.
 * Returns null for anything it cannot read, and the caller then skips the
 * segment — recognizing less is safer than guessing wrong.
 * @param {string} text one segment.
 * @returns {string[] | null} tokens, or null when quoting never closes.
 */
export function tokenizeShell(text) {
  const tokens = [];
  let current = "";
  let hasCurrent = false;
  let quote = null;
  const flush = () => {
    if (hasCurrent) tokens.push(current);
    current = "";
    hasCurrent = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && i + 1 < text.length) {
        i += 1;
        current += text[i];
        hasCurrent = true;
      } else {
        current += char;
        hasCurrent = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (char === "\\" && i + 1 < text.length) {
      i += 1;
      current += text[i];
      hasCurrent = true;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (quote !== null) return null;
  flush();
  return tokens;
}

/**
 * The name a token addresses this package's CLI by: `node design.mjs`,
 * `node path/to/design.mjs` or the installed `justskill` binary.
 * @param {string} token a command token.
 * @returns {"file" | "bin" | null} how the CLI is addressed.
 */
function cliKindOf(token) {
  if (token === "justskill" || token.endsWith("/justskill")) return "bin";
  const name = token.split("/").pop();
  return name === "design.mjs" ? "file" : null;
}

/**
 * One recognized write command from a shell segment.
 * @typedef {object} DesignWrite
 * @property {string} verb the write verb.
 * @property {string} file the design file as written (may be relative).
 * @property {string | null} workdir the directory the command ran from.
 * @property {string | null} target the element or container the verb names.
 * @property {string | null} renameTo the new id a `rename` gives the target.
 */

/**
 * Recognize one design.mjs write command in a shell segment. A segment that
 * invokes the CLI for a read verb, with `--dry-run`, or that cannot be
 * parsed, yields null.
 * @param {string} text one shell segment.
 * @param {string | null} workdir directory for relative file paths.
 * @returns {DesignWrite | null} the write, or null.
 */
export function parseDesignWrite(text, workdir = null) {
  const tokens = tokenizeShell(text);
  if (tokens === null) return null;

  // Leading environment assignments (`FOO=1 node design.mjs …`) are skipped.
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  // A node invocation puts the CLI one token later; node's own flags are skipped.
  if (tokens[index] === "node" || tokens[index] === "nodejs" || (tokens[index] ?? "").endsWith("/node")) {
    index += 1;
    while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
  }
  if (index >= tokens.length) return null;

  const kind = cliKindOf(tokens[index]);
  if (kind === null) return null;
  index += 1;
  if (index >= tokens.length) return null;

  let verb = tokens[index];
  index += 1;
  if (verb === "import" && index < tokens.length && tokens[index] === "pen") {
    // `import pen` is one verb with a subcommand; the subcommand is not a file.
    index += 1;
  } else if (verb === "import") {
    return null;
  }
  if (!WRITE_VERBS.has(verb)) return null;

  const positionals = [];
  const flags = new Map();
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.startsWith("-") && token !== "-") {
      const equals = token.indexOf("=");
      const bare = equals > 0 ? token.slice(0, equals) : token;
      const name = bare.slice(bare.lastIndexOf("-") + 1);
      if (BOOLEAN_FLAGS.has(name)) {
        if (name === "dry-run") return null; // writes nothing
        if (name === "stdout" && verb === "import") return null; // prints, writes nothing
        index += 1;
        continue;
      }
      let value;
      if (equals > 0) {
        value = token.slice(equals + 1);
        index += 1;
      } else {
        if (index + 1 >= tokens.length) return null;
        value = tokens[index + 1];
        index += 2;
      }
      flags.set(name, value);
      continue;
    }
    positionals.push(token);
    index += 1;
  }
  if (positionals.length === 0) return null;

  let file = positionals[0];
  if (verb === "import") {
    // `import pen <file.pen> [-o design.html]`: the pen is read, the design
    // file is what changes. The reader's default is the pen's own stem.
    const out = flags.get("out") ?? flags.get("o");
    if (out !== undefined) file = out;
    else file = join(dirnameOf(file), `${basename(file).replace(/\.pen$/i, "")}.html`);
  }
  const write = { verb, file, workdir, target: null, renameTo: null };
  if (TARGET_VERBS.has(verb)) {
    if (verb === "add") {
      write.target = flags.get("in") ?? flags.get("page") ?? null;
    } else {
      if (positionals.length < 2) return null;
      write.target = positionals[1];
    }
    if (verb === "rename") {
      if (positionals.length < 3) return null;
      write.renameTo = positionals[2];
    }
  }
  return write;
}

/** The directory part of a path, tolerant of bare names. */
function dirnameOf(file) {
  const cut = file.lastIndexOf("/");
  if (cut <= 0) return cut === 0 ? "/" : ".";
  return file.slice(0, cut);
}

/**
 * Every design.mjs write command a shell command carries, in order.
 * @param {string} command a full shell command.
 * @returns {DesignWrite[]} recognized writes, possibly empty.
 */
export function designWriteCommands(command) {
  const writes = [];
  for (const segment of splitShellSegments(command)) {
    const write = parseDesignWrite(segment.text, segment.workdir);
    if (write !== null) writes.push(write);
  }
  return writes;
}

/* ------------------------------------------------------------------ *
 * Page attribution
 * ------------------------------------------------------------------ */

/**
 * The page that contains one element, read from the file as it stands now.
 * @param {string} file absolute design file path.
 * @param {string} targetId element or container data-id.
 * @returns {{pageId: string, pageName: string} | null} the page, or null when
 *   the file does not parse, the element is absent, or it sits in no page.
 */
export function pageOfElement(file, targetId) {
  let doc;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  for (const page of pagesOf(doc)) {
    const pageId = getAttr(page, "data-id");
    if (pageId === null) continue;
    if (pageId === targetId) {
      return { pageId, pageName: getAttr(page, "data-name") || pageId };
    }
    let inside = false;
    walk(page, (node) => {
      if (inside || node.kind !== "element") return;
      if (getAttr(node, "data-id") === targetId) inside = true;
    });
    if (inside) return { pageId, pageName: getAttr(page, "data-name") || pageId };
  }
  return null;
}

/**
 * Every page of one design file, for file-level records (`new`, `import pen`).
 * @param {string} file absolute design file path.
 * @returns {{id: string, name: string}[] | null} pages, or null when unreadable.
 */
export function pagesOfFile(file) {
  let doc;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const pages = [];
  for (const page of pagesOf(doc)) {
    const id = getAttr(page, "data-id");
    if (id === null) continue;
    pages.push({ id, name: getAttr(page, "data-name") || id });
  }
  return pages;
}

/** SHA-256 of a file, or null when it does not exist or cannot be read. */
export function hashFile(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Attribute one recognized write against the file as it stands before it runs.
 * @param {DesignWrite} write a recognized write command.
 * @param {string | null} cwd the session workspace, for relative paths.
 * @returns {{file: string, pageId: string | null, pageName: string, removed: boolean} | null}
 *   the record to stage, or null when the target cannot be found (the command
 *   is then likely to fail, and a guessed page would be worse than no pill).
 */
export function attributeWrite(write, cwd = null) {
  const dir = write.workdir !== null && write.workdir !== undefined
    ? (isAbsolute(write.workdir) ? write.workdir : cwd !== null ? resolve(cwd, write.workdir) : null)
    : cwd;
  const base = !isAbsolute(write.file) && dir !== null ? resolve(dir, write.file) : write.file;
  if (!isAbsolute(base) && dir === null) {
    // No workspace to resolve a relative file against: guessing would put the
    // record on a file the command never touched.
    return null;
  }
  const file = isAbsolute(base) ? base : resolve(dir, base);

  if (write.verb === "new" || write.verb === "import" || write.target === null) {
    // File-level: the pages exist only after the write, or the command names
    // no container. The query resolves them from the file as it stands then.
    return { file, pageId: null, pageName: "", removed: false };
  }

  const page = pageOfElement(file, write.target);
  if (page === null) return null;
  if (write.verb === "rename" && page.pageId === write.target) {
    // A page is being renamed: the record names what it will be called.
    return { file, pageId: write.renameTo ?? page.pageId, pageName: "", removed: false };
  }
  return {
    file,
    pageId: page.pageId,
    pageName: page.pageName,
    removed: write.verb === "remove" && page.pageId === write.target,
  };
}

/* ------------------------------------------------------------------ *
 * The journal
 * ------------------------------------------------------------------ */

/**
 * One settled journal line.
 * @typedef {object} JournalEntry
 * @property {string} sessionId the session whose agent ran the command.
 * @property {number} turn the turn the command ran in.
 * @property {number} at wall-clock time of the confirmation.
 * @property {string} file absolute design file path.
 * @property {string} verb the write verb.
 * @property {string | null} pageId the page, or null for a file-level record.
 * @property {string} pageName the page's data-name as it stood at write time.
 * @property {boolean} removed present when the record is the page's removal.
 */

/**
 * Append-only journal with an in-memory mirror. Storage is plugin-owned; a
 * missing directory degrades to memory only, and the file is truncated from
 * its head once it grows past the cap so old turns cannot grow it forever.
 */
export class PageJournal {
  #file = null;
  #entries = [];
  #loaded = false;
  #pending = new Map();

  /**
   * @param {string | null} dir plugin-owned directory, or null for memory only.
   */
  constructor(dir) {
    if (dir !== null) this.#file = join(dir, "pages.ndjson");
  }

  /** Create the storage directory and read what is already on disk. */
  async open() {
    if (this.#file === null) {
      this.#loaded = true;
      return;
    }
    try {
      await mkdir(dirnameOf(this.#file), { recursive: true });
    } catch {
      this.#file = null;
      this.#loaded = true;
      return;
    }
    try {
      const text = await readFile(this.#file, "utf8");
      this.#entries = text.split("\n").filter((line) => line !== "").map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter((entry) => entry !== null);
    } catch {
      this.#entries = [];
    }
    this.#loaded = true;
  }

  /**
   * Stage one shell execution: attribute its design.mjs writes against the
   * pre-write file and hold them until the tool result confirms the call.
   * @param {object} execution the tool execution (arguments with `command`).
   * @param {{sessionId: string, turn: number, cwd?: string}} meta context.
   * @returns {boolean} whether anything was staged.
   */
  stageExecution(execution, meta) {
    const command = execution?.arguments?.command;
    if (typeof command !== "string" || command === "") return false;
    const key = execution.callId !== undefined && execution.callId !== null
      ? `call:${execution.callId}`
      : execution.token !== undefined && execution.token !== null
        ? `token:${execution.token}`
        : null;
    if (key === null) return false;

    const staged = [];
    for (const write of designWriteCommands(command)) {
      const attributed = attributeWrite(write, meta.cwd ?? null);
      if (attributed === null) continue;
      staged.push({
        file: attributed.file,
        verb: write.verb,
        pageId: attributed.pageId,
        pageName: attributed.pageName,
        removed: attributed.removed,
        hash: hashFile(attributed.file),
      });
    }
    if (staged.length === 0) return false;

    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      existing.staged.push(...staged);
      return true;
    }
    this.prunePending();
    this.#pending.set(key, { at: Date.now(), meta, staged });
    return true;
  }

  /**
   * Confirm or drop one staged execution. A refused write leaves the file
   * byte-identical, so an unchanged hash drops the entry without depending on
   * shell exit codes. Resolves after the entries are mirrored to disk.
   * @param {object} execution the settled tool execution.
   * @param {{isError?: boolean}} result the tool result.
   * @returns {Promise<boolean>} whether entries entered the journal.
   */
  async settleExecution(execution, result) {
    const key = execution?.callId !== undefined && execution.callId !== null
      ? `call:${execution.callId}`
      : execution?.token !== undefined && execution.token !== null
        ? `token:${execution.token}`
        : null;
    if (key === null) return false;
    const pending = this.#pending.get(key);
    if (pending === undefined) return false;
    this.#pending.delete(key);
    if (result?.isError === true) return false;

    const kept = pending.staged.filter((item) => hashFile(item.file) !== item.hash);
    if (kept.length === 0) return false;
    const at = Date.now();
    await this.append(kept.map((item) => ({
      sessionId: pending.meta.sessionId,
      turn: pending.meta.turn,
      at,
      file: item.file,
      verb: item.verb,
      pageId: item.pageId,
      pageName: item.pageName,
      removed: item.removed,
    })));
    return true;
  }

  /** Drop staged executions that never settled. */
  prunePending() {
    const deadline = Date.now() - 10 * 60_000;
    for (const [key, pending] of this.#pending) {
      if (pending.at < deadline) this.#pending.delete(key);
    }
  }

  /**
   * Append settled entries and mirror them to disk.
   * @param {JournalEntry[]} entries the entries.
   */
  async append(entries) {
    this.#entries.push(...entries);
    if (this.#file === null) return;
    try {
      const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      const info = await stat(this.#file).catch(() => null);
      if (info !== null && info.size + lines.length > JOURNAL_MAX_BYTES) {
        await this.#truncate(lines);
        return;
      }
      const handle = await open(this.#file, "a");
      try {
        await handle.writeFile(lines, "utf8");
      } finally {
        await handle.close();
      }
    } catch {
      /* the mirror is a convenience; the memory keeps serving this run */
    }
  }

  /** Rewrite the file with the newest half of the entries plus the new lines. */
  async #truncate(newLines) {
    const keep = this.#entries.slice(Math.floor(this.#entries.length / 2));
    this.#entries = keep;
    const temp = `${this.#file}.tmp`;
    try {
      await writeFile(temp, keep.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      await rename(temp, this.#file);
      const handle = await open(this.#file, "a");
      try {
        await handle.writeFile(newLines, "utf8");
      } finally {
        await handle.close();
      }
    } catch {
      try {
        await unlink(temp);
      } catch {
        /* nothing to clean */
      }
    }
  }

  /**
   * The pages one session's turn changed, grouped by file in record order.
   * @param {{sessionId: string, turn: number}} where the session and turn.
   * @returns {Promise<{file: string, pages: {id: string, name: string, removed: boolean}[]}[]>}
   *   groups, possibly empty.
   */
  async turnPages({ sessionId, turn }) {
    const wanted = typeof turn === "number" ? turn : Number(turn);
    const groups = [];
    const byFile = new Map();
    for (const entry of this.#entries) {
      if (entry.sessionId !== sessionId) continue;
      if (Number(entry.turn) !== wanted) continue;
      let group = byFile.get(entry.file);
      if (group === undefined) {
        group = { file: entry.file, pages: [] };
        byFile.set(entry.file, group);
        groups.push(group);
      }
      if (entry.pageId === null) {
        // File-level record: the file's current pages are what the write made.
        const pages = pagesOfFile(entry.file);
        if (pages !== null) {
          for (const page of pages) group.pages.push({ id: page.id, name: page.name, removed: false });
        }
        continue;
      }
      const existing = group.pages.find((page) => page.id === entry.pageId);
      if (existing === undefined) {
        group.pages.push({ id: entry.pageId, name: entry.pageName || entry.pageId, removed: entry.removed === true });
      } else if (entry.removed === true) {
        existing.removed = true;
      } else if (existing.removed === true && entry.verb !== "remove") {
        existing.removed = false;
      }
    }
    return groups;
  }
}
