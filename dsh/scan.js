/**
 * dsh/scan.js — find justSkill design files inside a workspace.
 *
 * A design file is identified by the marker the format already carries:
 * `<meta name="design-schema" content="...">`. No new marker is introduced and
 * no filename convention is required, so a file named by the user keeps
 * working. The scan is deliberately bounded: a workspace can be arbitrary
 * large, and the workbench is a picker, not an indexer. Because it is bounded,
 * the traversal order is part of the contract: shallow files must be found
 * before a large subtree can spend the whole budget.
 */

import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** A design file always carries this meta tag; the format owns the spelling. */
export const DESIGN_MARKER = /<meta\b[^>]*\bname\s*=\s*["']design-schema["'][^>]*>/i;

/**
 * Directories that never contain user-facing design files.
 *
 * The package-manager stores, agent caches and this plugin's own export temp
 * directory are listed because a workspace root can legitimately contain them
 * (a local `.pnpm-store`, `.claude`, `.justskill-design-tmp`) and walking them
 * costs thousands of `readdir` calls while yielding nothing.
 */
export const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".claude", ".next", ".nuxt", ".svelte-kit",
  ".cache", ".turbo", ".parcel-cache", ".venv", ".tox", ".pytest_cache",
  ".pnpm-store", ".pnpm", ".yarn", ".npm", ".justskill-design-tmp",
  "node_modules", "bower_components", "dist", "build", "out", "coverage",
  "vendor", "target", "bin", "obj", "Pods", "DerivedData",
]);

/** Limits that keep one workspace from stalling the panel. */
export const LIMITS = {
  maxDepth: 6,
  maxFiles: 2000,
  maxReadBytes: 512 * 1024,
  headBytes: 8 * 1024,
  budgetMs: 2500,
};

const HTML = /\.html?$/i;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const PAGE = /\bdata-type\s*=\s*["']page["']/g;

/**
 * Read one candidate file and return its design metadata, or null when it is
 * not a design file.
 *
 * @param {string} file absolute path
 * @returns {Promise<null | {path: string, uri: string, name: string, title: string | null, pages: number | null, size: number, mtime: number}>}
 */
export async function readDesignFile(file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  let text;
  if (info.size <= LIMITS.maxReadBytes) {
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
  } else {
    let handle;
    try {
      handle = await open(file, "r");
      const buffer = Buffer.alloc(Math.min(LIMITS.headBytes, info.size));
      await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.toString("utf8");
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  if (!DESIGN_MARKER.test(text)) return null;
  const title = TITLE.exec(text)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const pages = info.size <= LIMITS.maxReadBytes ? (text.match(PAGE)?.length ?? 0) : null;
  return {
    path: file,
    uri: pathToFileURL(file).href,
    name: basename(file),
    title,
    pages,
    size: info.size,
    mtime: info.mtimeMs,
  };
}

/**
 * Scan one workspace, breadth-first, bounded by depth, file count and time.
 *
 * Breadth-first matters more than it looks: with depth-first traversal the
 * visit order is whatever `readdir` returns, so one huge sibling directory (a
 * package-manager store, a tool cache) could spend the whole budget before a
 * `design.html` sitting at the workspace root was ever read. Visiting a
 * directory's files before its children, and every directory at one depth
 * before the next, keeps shallow files first even when the scan runs out of
 * time. The result then carries `incomplete`, and the caller must tell a
 * partial list apart from an empty workspace.
 *
 * @param {{path: string}} workspace canonical workspace directory
 * @param {{deadline?: number, maxDepth?: number, maxFiles?: number, onFile?: (file: object) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{path: string, files: Array<object>, incomplete: boolean, cancelled: boolean}>}
 */
export async function scanWorkspace(workspace, options = {}) {
  const root = workspace.path;
  const deadline = options.deadline ?? Date.now() + LIMITS.budgetMs;
  const maxDepth = options.maxDepth ?? LIMITS.maxDepth;
  const maxFiles = options.maxFiles ?? LIMITS.maxFiles;
  const onFile = typeof options.onFile === "function" ? options.onFile : null;
  const signal = options.signal;
  const files = [];
  let incomplete = false;
  let cancelled = false;

  const expired = () => Date.now() > deadline;
  const aborted = () => signal !== undefined && signal.aborted;
  const exhausted = () => expired() || files.length >= maxFiles;

  const queue = [{ directory: root, depth: 0 }];
  walk: for (let head = 0; head < queue.length; head += 1) {
    if (aborted()) {
      cancelled = true;
      break;
    }
    if (exhausted()) {
      incomplete = true;
      break;
    }
    const { directory, depth } = queue[head];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip, never fail the whole panel
    }

    const children = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) children.push(entry.name);
        continue;
      }
      if (!entry.isFile() || !HTML.test(entry.name)) continue;
      if (aborted()) {
        cancelled = true;
        break walk;
      }
      if (exhausted()) {
        incomplete = true;
        break walk;
      }
      const meta = await readDesignFile(join(directory, entry.name));
      if (meta === null) continue;
      if (aborted()) {
        cancelled = true;
        break walk;
      }
      files.push(meta);
      if (onFile !== null) onFile(meta);
    }

    for (const name of children) {
      if (aborted()) {
        cancelled = true;
        break walk;
      }
      if (exhausted()) {
        incomplete = true;
        break walk;
      }
      queue.push({ directory: join(directory, name), depth: depth + 1 });
    }
  }

  files.sort((left, right) => right.mtime - left.mtime);
  return { path: root, files, incomplete: incomplete || cancelled, cancelled };
}
