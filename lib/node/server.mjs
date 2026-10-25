/**
 * lib/node/server.mjs — the local canvas service.
 *
 * Invariants this file upholds.
 *
 *   1. Loopback only. The listener binds 127.0.0.1, and the module prints
 *      nothing: it returns `{ url, close, port, token, closed }` and the verb
 *      prints the URL.
 *   2. Four guards on every request: a loopback `Host` (the DNS-rebinding
 *      guard), an `Origin` that is loopback and equals the `Host` header when
 *      one is present, a capability token on `/api/*` only, and a 4 MiB body
 *      cap with `Content-Type: application/json` on POST. Statics are
 *      deliberately token-free: a browser cannot put a header on a module
 *      import, and a token in the module URL would leak into every `import`.
 *   3. The browser parses and renders the design. This service sends the FILE
 *      TEXT (`/api/file`) and metadata (`/api/state`) — never a document tree,
 *      so the two sides cannot disagree about what the file means, and a
 *      keystroke does not ship the whole document.
 *   4. One writer path, the funnel of lib/node/verbs/add.mjs: re-read the file,
 *      validate it, apply the ops, validate again, refuse unless the edit adds
 *      no NEW error (unless `force`), normalize only what changed, `writeAtomic`,
 *      bump the revision, broadcast `changed`, return the receipt. The file on
 *      disk is the authority: a `baseRevision` that does not match is reported
 *      as `rebased: true` and the ops are applied to the current text anyway.
 *   5. `readOnly` is a report, not a lock. It is true when the file does not
 *      parse or does not validate, so the canvas can still show the design, the
 *      problems and the raw text. Ops are refused only when there is no
 *      document to apply them to; `/api/save` keeps working, which is how a
 *      broken file is repaired from the canvas.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

import { CliError, loadExport, readDesignFile } from "./cli.mjs";
import { jsonOps } from "./op-json.mjs";
import { readText, revisionOf, walkWatch, writeAtomic } from "./fs.mjs";
import {
  PACKAGE_ROOT, SHELL_FILE, buildRoutes, contentTypeOf, isInside, routeFor,
} from "./static.mjs";

/** The largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Undo steps kept in memory. Past this the oldest step is dropped. */
export const MAX_HISTORY = 100;

const GOODBYE_GRACE_MS = 3000;
const PING_MS = 15000;
const TTL_TICK_MAX_MS = 15000;

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/** The host name of a `Host` header, with any port removed. */
export function hostNameOf(host) {
  const raw = String(host === undefined || host === null ? "" : host).trim().toLowerCase();
  if (raw === "") return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? null : raw.slice(0, end + 1);
  }
  if (raw.includes(":")) {
    const at = raw.lastIndexOf(":");
    const port = raw.slice(at + 1);
    return /^\d+$/.test(port) ? raw.slice(0, at) : raw; // a bare `::1` has no port
  }
  return raw;
}

/** Only loopback names, whatever the port. This is the DNS-rebinding guard. */
export function isLoopbackHost(host) {
  const name = hostNameOf(host);
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

/**
 * True when the request may proceed: an absent `Origin` (the CLI has none), or
 * a loopback origin whose host equals the `Host` header.
 */
export function isAllowedOrigin(origin, host) {
  if (origin === undefined || origin === null || origin === "") return true;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return false;
  }
  if (!isLoopbackHost(parsed.host)) return false;
  return parsed.host.toLowerCase() === String(host || "").trim().toLowerCase();
}

function isJsonContentType(value) {
  return /^application\/(?:[A-Za-z0-9.+-]+\+)?json\s*(;|$)/i.test(String(value || "").trim());
}

/** Constant-time token comparison; a length mismatch is a mismatch. */
function tokenMatches(provided, token) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

function json(res, status, payload, extra = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extra,
  };
  // The canvas records the revision of every answer, and a header survives a
  // payload it does not want to read. `/api/file` sets it explicitly as well.
  if (payload && typeof payload.revision === "string" && payload.revision !== "") {
    headers["X-Design-Revision"] = payload.revision;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(body);
}

/** Answer, then keep reading the request so the client sees the answer. */
function answerAndDrain(req, res, status, payload) {
  json(res, status, payload);
  try {
    if (!req.readableEnded) req.resume();
  } catch {
    /* the request is already gone */
  }
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

/**
 * Start the canvas service for one design file.
 *
 * @param {object} options
 * @param {string} options.file        the design file to serve
 * @param {number} [options.port]      0 picks a free port (default 0)
 * @param {number} [options.ttlMinutes] idle minutes before closing; 0 or absent means never
 * @param {boolean} [options.force]    write even when an edit adds a new error
 * @param {boolean} [options.log]      append a JSONL change log beside the file
 * @param {(line: string) => void} [options.onLog] human-readable lines; nothing is printed here
 * @param {boolean} [options.open]     accepted and ignored: opening a browser is the verb's job
 * @returns {Promise<{url: string, port: number, token: string, file: string, close: (reason?: string) => void, closed: Promise<string>}>}
 * @throws {FsError} the file cannot be read — the caller maps that to exit 2
 * @throws {CliError} the module could not be loaded
 */
export async function startServer(options = {}) {
  if (typeof options.file !== "string" || options.file === "") {
    throw new CliError("startServer() needs a design file", 2, "serve/no-file");
  }
  const file = path.resolve(options.file);

  const ttlMinutes = Number(options.ttlMinutes ?? 0);
  const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60000 : 0;
  const force = options.force === true;
  const writeLog = options.log === true;
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
  const log = (line) => {
    try {
      onLog(String(line));
    } catch {
      /* a listener that throws must not stop the service */
    }
  };
  const token = crypto.randomBytes(16).toString("hex");
  const routes = buildRoutes(PACKAGE_ROOT);

  // The lib/ modules are loaded the same way a verb loads them, so a rename is
  // reported as a CliError instead of crashing halfway through a request.
  const deps = {
    applyOps: await loadExport("ops.mjs", ["applyOps"], "applyOps"),
    buildIdIndex: await loadExport("ops.mjs", ["buildIdIndex"], "buildIdIndex"),
    validateDesign: await loadExport("validate.mjs", ["validateDesign"], "validateDesign"),
    newErrors: await loadExport("validate.mjs", ["newErrors"], "newErrors"),
    errorKeys: await loadExport("validate.mjs", ["errorKeys"], "errorKeys"),
    diagnosticKey: await loadExport("validate.mjs", ["diagnosticKey"], "diagnosticKey"),
    normalizeDocument: await loadExport("normalize.mjs", ["normalizeDocument"], "normalizeDocument"),
    serialize: await loadExport("serialize.mjs", ["serialize"], "serialize"),
    parse: await loadExport("parse.mjs", ["parse", "parseHtml"], "parse"),
    detectFormat: await loadExport("detect.mjs", ["detectFormat"], "detectFormat"),
    exportPage: await loadExport("export-html.mjs", ["exportPage"], "exportPage"),
    exportAllPages: await loadExport("export-html.mjs", ["exportAllPages"], "exportAllPages"),
  };

  // A missing or unreadable file is a start-up failure; an invalid one is not.
  readText(file);

  const clients = new Set();
  const undoStack = [];
  const redoStack = [];

  /** What the clients were last told. `/api/state` and `/api/file` re-read. */
  let state = { text: "", revision: null, doc: null, diagnostics: [], readOnly: true, readOnlyReason: "not read yet" };

  let lastActivity = Date.now();
  let closed = false;
  let closeReason = null;
  let closeResolve = null;
  const closedPromise = new Promise((resolve) => {
    closeResolve = resolve;
  });

  const touch = () => {
    lastActivity = Date.now();
  };

  const logPath = path.join(
    path.dirname(file),
    `${path.basename(file, path.extname(file))}.canvas-log.jsonl`,
  );

  /* ---- reading ---------------------------------------------------- */

  /**
   * Read the file and everything the canvas needs to know about it.
   *
   * The text is always returned, parsed or not: a file with a syntax error is
   * exactly when the human wants to see it. A parse failure becomes `readOnly`
   * with the reason, never a thrown error.
   *
   * @throws {FsError} when the file itself cannot be read
   */
  async function current() {
    const source = readText(file);
    const revision = revisionOf(source);
    try {
      const loaded = await readDesignFile(file);
      const diagnostics = deps.validateDesign(loaded.doc);
      const errors = diagnostics.filter((d) => d.severity === "error");
      return {
        text: source,
        revision,
        doc: loaded.doc,
        diagnostics,
        readOnly: errors.length > 0,
        readOnlyReason: errors.length ? reasonFromErrors(errors) : null,
      };
    } catch (error) {
      return {
        text: source,
        revision,
        doc: null,
        diagnostics: [],
        readOnly: true,
        readOnlyReason: reasonFromError(error),
      };
    }
  }

  function adopt(snapshot) {
    state = snapshot;
    return snapshot;
  }

  function reasonFromErrors(errors) {
    const first = errors[0];
    const head = `${first.code}: ${first.message}`;
    const rest = errors.length - 1;
    if (rest <= 0) return head;
    return `${head} (+${rest} more error${rest === 1 ? "" : "s"})`;
  }

  function reasonFromError(error) {
    const code = (error && error.code) || (error && error.name) || "error";
    return `${code}: ${error && error.message ? error.message : String(error)}`;
  }

  /** The metadata shape of `/api/state`; the document is never part of it. */
  function statePayload(snapshot, withToken = false) {
    const payload = {
      file: path.basename(file),
      path: file,
      revision: snapshot.revision,
      readOnly: snapshot.readOnly === true,
      readOnlyReason: snapshot.readOnlyReason ?? null,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    };
    if (withToken) payload.token = token;
    return payload;
  }

  /* ---- telling the clients ---------------------------------------- */

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...clients]) {
      try {
        client.res.write(frame);
      } catch {
        clearInterval(client.ping);
        clients.delete(client);
      }
    }
  }

  function logChange(entry) {
    if (!writeLog) return;
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      log(`warning: cannot write the change log: ${error.message}`);
    }
  }

  /* ---- the write funnel ------------------------------------------- */

  /** The `data-id` of an element, or null. */
  function idOf(node) {
    const attr = (node.attrs || []).find((entry) => entry.name === "data-id");
    const value = attr ? String(attr.value ?? "") : "";
    return value === "" ? null : value;
  }

  /**
   * The elements this edit touched: every op target, whatever the op inserted,
   * and a node renamed by `set data-id`.
   */
  function touchedIds(beforeDoc, nextDoc, applied) {
    const ids = new Set();
    for (const op of applied) {
      if (op && typeof op.target === "string" && op.target !== "") ids.add(op.target);
      if (op && op.op === "set" && op.prop === "data-id" && typeof op.value === "string") ids.add(op.value);
    }
    const before = deps.buildIdIndex(beforeDoc);
    for (const id of deps.buildIdIndex(nextDoc).keys()) {
      if (!before.has(id)) ids.add(id);
    }
    return ids;
  }

  /**
   * Normalize the elements the edit touched, and nothing else.
   *
   * `normalizeDocument` walks a whole tree, so it is handed one touched subtree
   * at a time. Its text output is discarded: the text is produced once, by
   * diffing the whole document against the one that was read, which is what
   * keeps every untouched byte where it was (format-v3 §5.1, "minimal change").
   */
  function normalizeTouched(doc, ids) {
    const normalized = [];
    const dropped = [];
    if (ids.size === 0) return { normalized, dropped };

    const visit = (node) => {
      for (const child of node.children || []) {
        if (!child || child.kind !== "element") continue;
        const id = idOf(child);
        if (id !== null && ids.has(id)) {
          const result = deps.normalizeDocument(child, { serialize: () => "" });
          normalized.push(...result.normalized);
          dropped.push(...result.dropped);
          continue; // the subtree is normalized whole
        }
        visit(child);
      }
    };
    visit(doc);
    return { normalized, dropped };
  }

  /**
   * Steps 6 and 7 of the funnel: normalize only what changed, serialize against
   * the document that was read, write atomically, adopt the new state.
   */
  function commit(snap, result, applied) {
    const norm = normalizeTouched(result.doc, touchedIds(snap.doc, result.doc, applied));
    const text = deps.serialize(snap.doc, result.doc);
    const diagnostics = deps.validateDesign(result.doc);
    const changed = text !== snap.text;
    if (changed) writeAtomic(file, text);
    const revision = revisionOf(text);
    const errors = diagnostics.filter((d) => d.severity === "error");
    const committed = adopt({
      text,
      revision,
      doc: result.doc,
      diagnostics,
      readOnly: errors.length > 0,
      readOnlyReason: errors.length ? reasonFromErrors(errors) : null,
    });
    return {
      text,
      revision,
      diagnostics,
      changed,
      normalized: norm.normalized,
      dropped: norm.dropped,
      state: committed,
    };
  }

  /**
   * Apply ops to the file: the funnel of lib/node/verbs/add.mjs, with the
   * canvas's concurrency rule on top. `baseRevision` never decides what is
   * written — the file on disk is the authority — it only reports staleness.
   */
  async function writeOps(res, body) {
    const ops = Array.isArray(body.ops) ? body.ops : null;
    if (ops === null || ops.length === 0) {
      json(res, 400, { ok: false, code: "ops/empty", message: 'Send { baseRevision, ops: [...] } with at least one op.' });
      return;
    }
    const baseRevision = typeof body.baseRevision === "string" ? body.baseRevision : null;

    let snap;
    try {
      snap = adopt(await current());
    } catch (error) {
      json(res, 409, { ok: false, code: error.code || "fs/unreadable", message: error.message, ...statePayload(state) });
      return;
    }

    const rebased = baseRevision !== null && baseRevision !== snap.revision;

    if (!snap.doc) {
      json(res, 409, {
        ok: false,
        code: "file/unparseable",
        message: `The file does not parse, so there is no document to apply ops to. ${snap.readOnlyReason}`,
        diagnostics: [],
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    const before = snap.diagnostics;
    let result;
    try {
      result = deps.applyOps(snap.doc, ops);
    } catch (error) {
      if (error && error.name === "OpsError") {
        json(res, 409, {
          ok: false,
          code: error.code || "ops/bad-op",
          message: error.message,
          opIndex: Number.isInteger(error.opIndex) ? error.opIndex : null,
          diagnostics: [],
          rebased,
          changed: false,
          ...statePayload(snap),
        });
        return;
      }
      throw error;
    }

    // Step 5: refuse unless the edit introduces no new error.
    const applied = deps.validateDesign(result.doc);
    const introduced = deps.newErrors(before, applied);
    if (introduced.length > 0 && !force) {
      json(res, 409, {
        ok: false,
        code: "cli/would-introduce-errors",
        message: `The change would introduce ${introduced.length} new error${introduced.length === 1 ? "" : "s"}.`,
        diagnostics: introduced,
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    // Steps 6 and 7: normalize what the edit touched, serialize against the
    // document that was read, write atomically.
    const done = commit(snap, result, result.applied);

    pushHistory(undoStack, {
      ops: result.applied,
      inverse: result.inverse,
      beforeKeys: deps.errorKeys(before),
      afterKeys: deps.errorKeys(done.diagnostics),
      revision: done.revision,
    });
    redoStack.length = 0;

    if (done.changed) broadcast("changed", { revision: done.revision, reason: "ops" });
    logChange({ ts: new Date().toISOString(), source: "ops", revision: done.revision, ops: jsonOps(result.applied), inverse: jsonOps(result.inverse) });

    json(res, 200, {
      ok: true,
      revision: done.revision,
      rebased,
      changed: done.changed,
      applied: jsonOps(result.applied),
      inverse: jsonOps(result.inverse),
      normalized: done.normalized,
      dropped: done.dropped,
      diagnostics: done.diagnostics,
      ...statePayload(done.state),
    });
  }

  /**
   * Undo or redo one step. The stacks hold op lists, not snapshots: reversing a
   * gesture is one op list, and applying it to whatever the file says now keeps
   * a concurrent agent edit.
   *
   * An undo restores a state that was already accepted, including any error that
   * state carried, so the refusal test is against the union of the errors the
   * file has now and the errors the restored state had — never against zero.
   */
  async function writeHistory(res, direction) {
    const undoing = direction === "undo";
    const from = undoing ? undoStack : redoStack;
    const to = undoing ? redoStack : undoStack;

    if (from.length === 0) {
      json(res, 200, {
        ok: false,
        code: "history/empty",
        message: `Nothing to ${direction}.`,
        revision: state.revision,
        rebased: false,
        changed: false,
        inverse: [],
        diagnostics: state.diagnostics,
        ...statePayload(state),
      });
      return;
    }

    let snap;
    try {
      snap = adopt(await current());
    } catch (error) {
      json(res, 409, { ok: false, code: error.code || "fs/unreadable", message: error.message, ...statePayload(state) });
      return;
    }
    if (!snap.doc) {
      json(res, 409, {
        ok: false,
        code: "file/unparseable",
        message: `The file does not parse, so there is nothing to ${direction}. ${snap.readOnlyReason}`,
        diagnostics: [],
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    const step = from[from.length - 1];
    const rebased = snap.revision !== step.revision;

    let result;
    try {
      result = deps.applyOps(snap.doc, step.inverse);
    } catch (error) {
      json(res, 409, {
        ok: false,
        code: error.code || "ops/bad-op",
        message: `Cannot ${direction}: ${error.message}`,
        opIndex: Number.isInteger(error.opIndex) ? error.opIndex : null,
        diagnostics: [],
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    const after = deps.validateDesign(result.doc);
    const known = new Set([...deps.errorKeys(snap.diagnostics), ...(undoing ? step.beforeKeys : step.afterKeys)]);
    const introduced = after.filter((d) => d.severity === "error" && !known.has(deps.diagnosticKey(d)));
    if (introduced.length > 0 && !force) {
      json(res, 409, {
        ok: false,
        code: "cli/would-introduce-errors",
        message: `The ${direction} would introduce ${introduced.length} new error${introduced.length === 1 ? "" : "s"}.`,
        diagnostics: introduced,
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    const done = commit(snap, result, result.applied);

    from.pop();
    pushHistory(to, {
      ops: result.applied,
      inverse: result.inverse,
      beforeKeys: deps.errorKeys(snap.diagnostics),
      afterKeys: deps.errorKeys(done.diagnostics),
      revision: done.revision,
    });

    if (done.changed) broadcast("changed", { revision: done.revision, reason: direction });
    logChange({ ts: new Date().toISOString(), source: direction, revision: done.revision, ops: jsonOps(result.applied), inverse: jsonOps(result.inverse) });

    json(res, 200, {
      ok: true,
      revision: done.revision,
      rebased,
      changed: done.changed,
      applied: jsonOps(result.applied),
      inverse: jsonOps(result.inverse),
      normalized: done.normalized,
      dropped: done.dropped,
      diagnostics: done.diagnostics,
      ...statePayload(done.state),
    });
  }

  function pushHistory(stack, entry) {
    stack.push(entry);
    while (stack.length > MAX_HISTORY) stack.shift();
  }

  /**
   * A whole-text save. It exists so a file that does not parse can still be
   * repaired from the canvas: the submitted text is parsed, checked against the
   * errors the current file already has, and written only when it adds none.
   *
   * A stale `baseRevision` is reported, not obeyed, exactly as for ops — the
   * human pressed save on the text they can see. The history is cleared,
   * because every stored inverse describes a document that no longer exists.
   */
  async function writeSave(res, body) {
    if (typeof body.text !== "string") {
      json(res, 400, { ok: false, code: "save/no-text", message: "Send { baseRevision, text } with text as a string." });
      return;
    }
    const text = body.text;

    let snap;
    try {
      snap = adopt(await current());
    } catch (error) {
      json(res, 409, { ok: false, code: error.code || "fs/unreadable", message: error.message, ...statePayload(state) });
      return;
    }

    const rebased = typeof body.baseRevision === "string" && snap.revision !== null && body.baseRevision !== snap.revision;
    const format = deps.detectFormat(file, text);
    if (format !== "html") {
      json(res, 409, {
        ok: false,
        code: "save/format",
        message: `A whole-text save writes HTML. ${path.basename(file)} is read as ${format}.`,
        diagnostics: [],
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    let doc;
    try {
      doc = deps.parse(text, { file, format, source: text });
      if (doc && typeof doc.then === "function") doc = await doc;
    } catch (error) {
      json(res, 400, {
        ok: false,
        code: "save/parse",
        message: `The text does not parse: ${error.message}`,
        diagnostics: [],
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }
    if (!doc || typeof doc !== "object") {
      json(res, 400, { ok: false, code: "save/parse", message: "The text produced no document.", diagnostics: [], rebased, changed: false, ...statePayload(snap) });
      return;
    }

    const diagnostics = deps.validateDesign(doc);
    const introduced = deps.newErrors(snap.doc ? snap.diagnostics : [], diagnostics);
    if (introduced.length > 0 && !force) {
      json(res, 409, {
        ok: false,
        code: "cli/would-introduce-errors",
        message: `The save would introduce ${introduced.length} new error${introduced.length === 1 ? "" : "s"}.`,
        diagnostics: introduced,
        rebased,
        changed: false,
        ...statePayload(snap),
      });
      return;
    }

    const changed = text !== snap.text;
    if (changed) writeAtomic(file, text);
    const revision = revisionOf(text);
    const errors = diagnostics.filter((d) => d.severity === "error");
    const committed = adopt({
      text,
      revision,
      doc,
      diagnostics,
      readOnly: errors.length > 0,
      readOnlyReason: errors.length ? reasonFromErrors(errors) : null,
    });

    undoStack.length = 0;
    redoStack.length = 0;

    if (changed) broadcast("changed", { revision, reason: "save" });
    logChange({ ts: new Date().toISOString(), source: "save", revision, bytes: Buffer.byteLength(text, "utf8") });

    json(res, 200, {
      ok: true,
      revision,
      rebased,
      changed,
      applied: [],
      inverse: [],
      diagnostics,
      ...statePayload(committed),
    });
  }

  /* ---- HTTP ------------------------------------------------------- */

  function handleStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      text(res, 405, "Method not allowed\n");
      return;
    }
    const hit = routeFor(routes, url.pathname);
    if (!hit) {
      text(res, 404, "Not found\n");
      return;
    }
    if (!isInside(PACKAGE_ROOT, hit.file)) {
      text(res, 403, "Forbidden\n");
      return;
    }

    let body;
    try {
      body = fs.readFileSync(hit.file);
    } catch {
      if (hit.route === "/") {
        // The shell is not built yet. The service still explains itself rather
        // than answering a bare 404 at the URL the human was told to open.
        const html = shellPlaceholder();
        text(res, 200, html, "text/html; charset=utf-8");
        return;
      }
      text(res, 404, "Not found\n");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypeOf(hit.file),
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  /**
   * `POST /api/export` — write a deliverable next to the design file.
   *
   * The canvas cannot write files, so the service writes them. The pages come from
   * `lib/export-html.mjs`, the same functions `design.mjs export` calls, so a deliverable
   * taken from the canvas and one taken from the command line are the same bytes.
   *
   * ## Why every file is named `.export.html`
   *
   * In this format the design file is an HTML file too. `home.html` next to `design.html`
   * is therefore ambiguous: it could be the deliverable for the page `home`, or another
   * design. It is also what a person would call the file, which is how the ambiguity gets
   * created in the first place. `<pageId>.export.html` cannot be mistaken for either.
   *
   * The one target that is refused outright is the design file itself: a layout whose page
   * id and file name line up (page `home` in `home.export.html`) would otherwise overwrite
   * the design with its own export.
   */
  async function writeExport(res, body) {
    let snap;
    try {
      snap = adopt(await current());
    } catch (error) {
      json(res, 409, { ok: false, code: error.code || "fs/unreadable", message: error.message, ...statePayload(state) });
      return;
    }

    if (snap.readOnly === true || !snap.doc) {
      json(res, 409, {
        ok: false,
        code: "export/read-only",
        message: `The file does not parse, so there is nothing to export. ${snap.readOnlyReason ?? ""}`.trim(),
        diagnostics: snap.diagnostics ?? [],
        ...statePayload(snap),
      });
      return;
    }

    const options = {
      resolveTokens: body.resolveTokens === true,
      page: typeof body.page === "string" && body.page !== "" ? body.page : undefined,
    };

    let results;
    try {
      if (body.all === true) {
        results = deps.exportAllPages(snap.doc, options).map((entry) => ({ id: entry.page.id, html: entry.html }));
      } else {
        const one = deps.exportPage(snap.doc, options);
        results = [{ id: one.page.id, html: one.html }];
      }
    } catch (error) {
      json(res, 409, {
        ok: false,
        code: error.code || "export/failed",
        message: error.message,
        hint: error.hint ?? null,
        diagnostics: [],
        ...statePayload(snap),
      });
      return;
    }

    const dir = path.dirname(file);
    const written = [];
    for (const entry of results) {
      const target = path.join(dir, `${entry.id}.export.html`);
      if (path.resolve(target) === path.resolve(file)) {
        json(res, 409, {
          ok: false,
          code: "export/would-overwrite-design",
          message: `Exporting page ${entry.id} would write over ${path.basename(file)}.`,
          hint: "Rename the page or the design file; the export is named <page>.export.html.",
          diagnostics: [],
          ...statePayload(snap),
        });
        return;
      }
      writeAtomic(target, entry.html);
      written.push({ page: entry.id, path: target, bytes: Buffer.byteLength(entry.html, "utf8") });
    }

    json(res, 200, { ok: true, files: written, ...statePayload(snap) });
  }

  function shellPlaceholder() {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>justSkill canvas</title></head>
<body style="font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d12;color:#e5e7eb;padding:40px;max-width:60ch">
<h1 style="font-size:16px">The canvas shell is not built yet</h1>
<p>This service is running, but <code>${escapeHtml(SHELL_FILE)}</code> does not exist.</p>
<p>The design file is served as text at <code>/api/file?t=&lt;token&gt;</code>; its metadata is at <code>/api/state?t=&lt;token&gt;</code>.</p>
</body>
</html>
`;
  }

  async function readJsonBody(req, res) {
    const declared = Number(req.headers["content-length"] ?? 0);
    const contentType = req.headers["content-type"];

    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      answerAndDrain(req, res, 413, {
        ok: false,
        code: "body/too-large",
        message: `The body is limited to ${MAX_BODY_BYTES} bytes.`,
      });
      return null;
    }
    if (declared > 0 && !isJsonContentType(contentType)) {
      answerAndDrain(req, res, 415, {
        ok: false,
        code: "body/content-type",
        message: "Send Content-Type: application/json.",
      });
      return null;
    }

    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          answerAndDrain(req, res, 413, {
            ok: false,
            code: "body/too-large",
            message: `The body is limited to ${MAX_BODY_BYTES} bytes.`,
          });
          return null;
        }
        chunks.push(chunk);
      }
    } catch {
      try {
        res.end();
      } catch {
        /* the client is gone */
      }
      return null;
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.trim() === "") return {};

    if (!isJsonContentType(contentType)) {
      json(res, 415, { ok: false, code: "body/content-type", message: "Send Content-Type: application/json." });
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      json(res, 400, { ok: false, code: "body/bad-json", message: error.message });
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      json(res, 400, { ok: false, code: "body/bad-json", message: "The body must be a JSON object." });
      return null;
    }
    return parsed;
  }

  async function handle(req, res) {
    touch();

    let url;
    try {
      url = new URL(String(req.url || "/"), `http://${req.headers.host || "127.0.0.1"}`);
    } catch {
      text(res, 400, "Bad request\n");
      return;
    }

    // Guard 1: the DNS-rebinding guard, on every request, static or not.
    if (!isLoopbackHost(req.headers.host)) {
      json(res, 403, { ok: false, code: "host-not-allowed", message: `Host ${JSON.stringify(req.headers.host ?? "")} is not loopback.` });
      return;
    }

    // Guard 2: when an Origin is present it must be loopback and match the Host.
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      json(res, 403, { ok: false, code: "origin-not-allowed", message: `Blocked origin ${JSON.stringify(req.headers.origin ?? "")}.` });
      return;
    }

    const route = url.pathname;

    // Statics are token-free on purpose: the browser cannot put a header on a
    // module import, and a token in the URL would travel with every import.
    if (!route.startsWith("/api/")) {
      handleStatic(req, res, url);
      return;
    }

    // Guard 3: the capability token.
    const provided = url.searchParams.get("t") || req.headers["x-design-token"];
    if (!tokenMatches(provided, token)) {
      json(res, 401, { ok: false, code: "bad-token", message: "Missing or wrong access token." });
      return;
    }

    if (route === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      // A client arriving cancels a goodbye that a reload already announced.
      // `beforeunload` cannot tell a reload from a closed tab, and a service
      // that dies on F5 is a service the author has to restart by hand.
      cancelGoodbye();
      const client = { res, ping: null };
      clients.add(client);
      res.write(`event: hello\ndata: ${JSON.stringify(statePayload(state))}\n\n`);
      client.ping = setInterval(() => {
        touch();
        try {
          res.write(": ping\n\n");
        } catch {
          /* the client is gone; `close` on the request cleans up */
        }
      }, PING_MS);
      req.on("close", () => {
        clearInterval(client.ping);
        clients.delete(client);
      });
      return;
    }

    if (route === "/api/state" && req.method === "GET") {
      let snapshot;
      try {
        snapshot = adopt(await current());
      } catch (error) {
        snapshot = {
          text: null,
          revision: null,
          doc: null,
          diagnostics: [],
          readOnly: true,
          readOnlyReason: reasonFromError(error),
        };
      }
      json(res, 200, statePayload(snapshot, true));
      return;
    }

    if (route === "/api/file" && req.method === "GET") {
      let snapshot;
      try {
        snapshot = adopt(await current());
      } catch (error) {
        json(res, 409, { ok: false, code: error.code || "fs/unreadable", message: error.message, ...statePayload(state) });
        return;
      }
      text(res, 200, snapshot.text, "text/plain; charset=utf-8", {
        "X-Design-Revision": String(snapshot.revision),
        "X-Content-Type-Options": "nosniff",
      });
      return;
    }

    if (req.method !== "POST") {
      json(res, 405, { ok: false, code: "method-not-allowed", message: `${req.method} is not allowed on ${route}.` });
      return;
    }

    // Guard 4: the body cap and the JSON-only rule.
    const body = await readJsonBody(req, res);
    if (body === null) return;

    switch (route) {
      case "/api/ops":
        await writeOps(res, body);
        return;
      case "/api/undo":
        await writeHistory(res, "undo");
        return;
      case "/api/redo":
        await writeHistory(res, "redo");
        return;
      case "/api/save":
        await writeSave(res, body);
        return;
      case "/api/export":
        await writeExport(res, body);
        return;
      case "/api/bye":
        json(res, 200, { ok: true, message: "The canvas service is closing." });
        res.on("finish", () => goodbye());
        return;
      default:
        json(res, 404, { ok: false, code: "not-found", message: route });
        return;
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`error: ${error && error.message ? error.message : error}`);
      if (!res.headersSent) {
        json(res, 500, { ok: false, code: "internal", message: error && error.message ? error.message : String(error) });
      } else {
        try {
          res.end();
        } catch {
          /* the response is already gone */
        }
      }
    });
  });

  /* ---- watching the file ------------------------------------------ */

  // Watch the directory, not the file: an atomic write replaces the file by
  // rename, which detaches a watcher bound to the old inode.
  let watcherClose = null;
  const base = path.basename(file);
  const onDiskChange = () => {
    if (closed) return;
    let source;
    try {
      source = readText(file);
    } catch (error) {
      broadcast("changed", { revision: null, reason: "unreadable" });
      log(`warning: cannot read ${file}: ${error.message}`);
      return;
    }
    const revision = revisionOf(source);
    if (revision === state.revision) return; // our own write, or a no-op touch
    state = { ...state, text: source, revision };
    broadcast("changed", { revision, reason: "disk" });
    log(`changed on disk: revision ${revision}`);
  };

  try {
    watcherClose = walkWatch(path.dirname(file), (events) => {
      if (events.some((event) => !event.filename || event.filename === base)) onDiskChange();
    });
  } catch (error) {
    log(`warning: cannot watch ${path.dirname(file)}: ${error.message}`);
  }

  /* ---- lifecycle --------------------------------------------------- */

  let goodbyeTimer = null;

  /**
   * The canvas said goodbye. Wait before believing it.
   *
   * `beforeunload` fires on a reload too, and the reload reconnects a moment
   * later. Closing on the spot turned every refresh into a dead port. A new SSE
   * client in the window below cancels the close; if none arrives, the tab
   * really is gone.
   */
  function goodbye() {
    if (closed || goodbyeTimer) return;
    goodbyeTimer = setTimeout(() => {
      goodbyeTimer = null;
      if (clients.size === 0) close("the browser closed the canvas");
    }, GOODBYE_GRACE_MS);
    goodbyeTimer.unref?.();
  }

  function cancelGoodbye() {
    if (!goodbyeTimer) return;
    clearTimeout(goodbyeTimer);
    goodbyeTimer = null;
  }

  function close(reason = "closed") {
    if (closed) return;
    closed = true;
    closeReason = String(reason);

    if (ttlTimer) clearInterval(ttlTimer);
    if (watcherClose) {
      try {
        watcherClose();
      } catch {
        /* already closed */
      }
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    for (const client of clients) {
      clearInterval(client.ping);
      try {
        client.res.write(`event: bye\ndata: ${JSON.stringify({ reason: closeReason })}\n\n`);
        client.res.end();
      } catch {
        /* the client is gone */
      }
    }
    clients.clear();

    server.close();
    // Idle keep-alive sockets would otherwise hold the process open after the
    // last response. The delay lets the response that triggered the close flush.
    const reap = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* older Node has no such method */
      }
    }, 100);
    reap.unref?.();

    log(`closed: ${closeReason}`);
    closeResolve(closeReason);
  }

  const onSigint = () => close("signal SIGINT");
  const onSigterm = () => close("signal SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let ttlTimer = null;
  if (ttlMs > 0) {
    const every = Math.max(50, Math.min(TTL_TICK_MAX_MS, Math.floor(ttlMs / 4)));
    ttlTimer = setInterval(() => {
      if (closed) return;
      if (clients.size > 0) return; // an open SSE client is activity
      if (Date.now() - lastActivity >= ttlMs) close(`idle for ${ttlMinutes} minute${ttlMinutes === 1 ? "" : "s"}`);
    }, every);
    ttlTimer.unref?.();
  }

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  // Read once before the first client can ask, so `/api/state` is never blank.
  try {
    adopt(await current());
  } catch {
    /* the file was readable a moment ago; the first request re-reads it */
  }
  if (state.readOnly) {
    log(`warning: ${state.readOnlyReason}`);
    log("the canvas opens read-only until the file is valid again");
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return {
    url,
    port,
    token,
    file,
    routes,
    close,
    closed: closedPromise,
    state: () => state,
  };
}
