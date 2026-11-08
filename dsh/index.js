/**
 * dsh/index.js — host half of the justSkill Design plugin.
 *
 * Three responsibilities, each deliberately small:
 *
 *   1. Register the skill that already lives in this package, so a plugin
 *      install is equivalent to dropping the directory into a skills root.
 *   2. Scan registered workspaces for design files. The browser cannot read
 *      the filesystem, so the picker asks the Host.
 *   3. Start one canvas service per design file on a loopback port and hand
 *      the browser its tokenized URL. The canvas itself is unchanged — the
 *      plugin only decides which file it serves.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { startServer } from "../lib/node/server.mjs";
import { readDesignFile, scanWorkspace } from "./scan.js";
import { readSkill } from "./skill.js";

export const name = "justskill-design";
export const inject = ["skills"];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_TTL_MS = 15_000;
const SCAN_BUDGET_MS = 6_000;
const WORKSPACE_BUDGET_MS = 2_500;
const MAX_WORKSPACES = 64;
const PENDING_TTL_MS = 60_000;

/** Successful JSON response; no store, the panel re-reads deliberately. */
function ok(value) {
  return Response.json({ ok: true, value }, {
    headers: { "cache-control": "no-store" },
  });
}

/** Refusal response with a stable code the client can branch on. */
function fail(status, code, message) {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Canonicalize one workspace directory; returns null when it is not one. */
async function canonicalWorkspace(entry) {
  if (entry === null || typeof entry !== "object") return null;
  if (typeof entry.path !== "string" || entry.path.trim() === "") return null;
  if (!isAbsolute(entry.path)) return null;
  try {
    const path = await realpath(entry.path);
    const info = await stat(path);
    if (!info.isDirectory()) return null;
    return {
      id: typeof entry.id === "string" ? entry.id : path,
      path,
      title: typeof entry.title === "string" ? entry.title : "",
    };
  } catch {
    return null;
  }
}

/**
 * One canvas server per design file, owned by the plugin fiber. A second open
 * for the same file joins the first start instead of racing it.
 */
class CanvasPool {
  #entries = new Map();

  async open(file) {
    const current = this.#entries.get(file);
    if (current?.server !== undefined) return current.server;
    if (current?.starting !== undefined) return current.starting;

    const starting = (async () => {
      const server = await startServer({
        file,
        port: 0,
        ttlMinutes: 30,
        open: false,
      });
      const entry = { server };
      this.#entries.set(file, entry);
      server.closed.then(() => {
        if (this.#entries.get(file) === entry) this.#entries.delete(file);
      }, () => {
        if (this.#entries.get(file) === entry) this.#entries.delete(file);
      });
      return server;
    })();

    this.#entries.set(file, { starting });
    try {
      return await starting;
    } catch (error) {
      this.#entries.delete(file);
      throw error;
    }
  }

  close(file) {
    const entry = this.#entries.get(file);
    this.#entries.delete(file);
    try {
      entry?.server?.close("plugin closed the canvas");
    } catch {
      /* already closing */
    }
  }

  closeAll() {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      try {
        entry.server?.close("plugin disposed");
      } catch {
        /* already closing */
      }
    }
  }
}

export function apply(ctx) {
  const skill = readSkill(ROOT);
  ctx.effect(() => ctx.skills.register({
    ...skill,
    source: "bundled",
  }), "justskill-design: skill");

  const pool = new CanvasPool();
  ctx.effect(() => () => pool.closeAll(), "justskill-design: canvas servers");

  // Session-scoped handoff from the Host tool to the browser watcher. The tool
  // cannot touch the right-sidebar UI, so it leaves a request the client claims
  // and clears after the tab is open.
  const pending = new Map();
  const purgePending = () => {
    const now = Date.now();
    for (const [sessionId, entry] of pending) {
      if (now - entry.at > PENDING_TTL_MS) pending.delete(sessionId);
    }
  };

  const cache = new Map();

  ctx.inject(["connection"], (scope) => {
    const connection = scope.get("connection");
    if (connection === undefined || typeof connection.fetch?.register !== "function") {
      ctx.logger?.warn?.("justskill-design: connection.fetch is unavailable; the workbench Host API stays off");
      return;
    }

    const route = (path, handler, label) => {
      scope.effect(() => connection.fetch.register({
        path,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: handler,
      }), label);
    };

    route("/api/justskill-design/scan", async (request) => {
      const body = await readJson(request);
      if (body === null) return fail(400, "bad-request", "body must be a JSON object");
      if (!Array.isArray(body.workspaces)) return fail(400, "bad-request", "workspaces must be an array");
      if (body.workspaces.length > MAX_WORKSPACES) {
        return fail(400, "too-many-workspaces", `at most ${MAX_WORKSPACES} workspaces per scan`);
      }

      const valid = [];
      for (const entry of body.workspaces) {
        const workspace = await canonicalWorkspace(entry);
        if (workspace !== null) valid.push(workspace);
      }

      const refresh = body.refresh === true;
      const deadline = Date.now() + SCAN_BUDGET_MS;
      const results = [];
      for (const workspace of valid) {
        const cached = cache.get(workspace.path);
        if (!refresh && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
          results.push({ ...workspace, ...cached.value, cached: true });
          continue;
        }
        const local = Math.min(Date.now() + WORKSPACE_BUDGET_MS, deadline);
        const value = await scanWorkspace(workspace, { deadline: local });
        cache.set(workspace.path, { at: Date.now(), value });
        results.push({ ...workspace, ...value });
      }

      return ok({
        workspaces: results,
        scannedAt: Date.now(),
        incomplete: results.some((entry) => entry.incomplete === true),
      });
    }, "justskill-design: workspace scan route");

    route("/api/justskill-design/canvas", async (request) => {
      const body = await readJson(request);
      if (body === null) return fail(400, "bad-request", "body must be a JSON object");
      if (typeof body.file !== "string" || body.file.trim() === "") {
        return fail(400, "bad-request", "file must be a non-empty string");
      }
      if (!isAbsolute(body.file)) return fail(400, "bad-request", "file must be absolute");

      let file;
      try {
        file = await realpath(body.file);
      } catch {
        return fail(404, "file-not-found", `no such file: ${body.file}`);
      }

      const meta = await readDesignFile(file);
      if (meta === null) {
        return fail(422, "not-a-design-file", `${file} has no design-schema marker`);
      }

      try {
        const server = await pool.open(file);
        return ok({ url: server.url, file, port: server.port });
      } catch (error) {
        return fail(500, "canvas-start-failed", error instanceof Error ? error.message : String(error));
      }
    }, "justskill-design: canvas open route");

    route("/api/justskill-design/canvas/close", async (request) => {
      const body = await readJson(request);
      if (body === null) return fail(400, "bad-request", "body must be a JSON object");
      if (typeof body.file !== "string" || body.file.trim() === "") {
        return fail(400, "bad-request", "file must be a non-empty string");
      }
      let file;
      try {
        file = await realpath(body.file);
      } catch {
        return ok({ closed: false });
      }
      pool.close(file);
      return ok({ closed: true });
    }, "justskill-design: canvas close route");

    route("/api/justskill-design/pending", async (request) => {
      const body = await readJson(request);
      if (body === null) return fail(400, "bad-request", "body must be a JSON object");
      if (typeof body.sessionId !== "string" || body.sessionId === "") {
        return fail(400, "bad-request", "sessionId must be a non-empty string");
      }
      purgePending();
      const entry = pending.get(body.sessionId);
      return ok({ pending: entry === undefined ? null : { file: entry.file } });
    }, "justskill-design: pending canvas route");

    route("/api/justskill-design/pending/clear", async (request) => {
      const body = await readJson(request);
      if (body === null) return fail(400, "bad-request", "body must be a JSON object");
      if (typeof body.sessionId !== "string" || body.sessionId === "") {
        return fail(400, "bad-request", "sessionId must be a non-empty string");
      }
      purgePending();
      const entry = pending.get(body.sessionId);
      if (entry !== undefined && (typeof body.file !== "string" || body.file === "" || body.file === entry.file)) {
        pending.delete(body.sessionId);
      }
      return ok({ cleared: true });
    }, "justskill-design: pending canvas clear route");
  });

  ctx.inject(["tools"], (scope) => {
    const tools = scope.get("tools");
    if (tools === undefined || typeof tools.register !== "function") return;

    scope.effect(() => tools.register({
      name: "justskill_canvas",
      description:
        "Open the justSkill design canvas in the DSH right-sidebar Canvas tab. Use this " +
        "whenever the user asks to open, show or focus the design canvas, and before " +
        "designing page by page. Never run `node design.mjs serve` in DeepSeek Harness; " +
        "the canvas is the right-sidebar tab.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Absolute path to the design file. Defaults to design.html in the session workspace.",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            requested: { type: "boolean" },
            file: { type: "string" },
          },
          required: ["requested", "file"],
        },
        render(_args, value) {
          return [{ type: "text", text: `justskill_canvas → ${value.file}` }];
        },
      },
      timeoutMs: 15_000,
      isConcurrencySafe() {
        return false;
      },
      async execute(args, exec) {
        const agent = exec === undefined ? undefined : exec.agent;
        const sessionId = agent === undefined ? undefined : agent.id;
        const cwd = agent === undefined ? undefined : agent.session?.header?.cwd;
        if (typeof sessionId !== "string" || sessionId === "") {
          throw new Error("justskill_canvas: no calling session");
        }
        if (typeof cwd !== "string" || cwd === "") {
          throw new Error("justskill_canvas: no session workspace");
        }
        const requested = args !== null && typeof args === "object" && typeof args.file === "string"
          ? args.file
          : "";
        const candidate = requested === ""
          ? resolve(cwd, "design.html")
          : isAbsolute(requested) ? requested : resolve(cwd, requested);
        let file;
        try {
          file = await realpath(candidate);
        } catch {
          throw new Error(`justskill_canvas: no such file: ${candidate}`);
        }
        const meta = await readDesignFile(file);
        if (meta === null) {
          throw new Error(`justskill_canvas: ${file} has no design-schema marker`);
        }
        purgePending();
        pending.set(sessionId, { file, at: Date.now() });
        return { requested: true, file };
      },
    }), "justskill-design: canvas tool");
  });
}
