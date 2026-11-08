/**
 * dsh/scan.js — find justSkill design files inside a workspace.
 *
 * A design file is identified by the marker the format already carries:
 * `<meta name="design-schema" content="...">`. No new marker is introduced and
 * no filename convention is required, so a file named by the user keeps
 * working. The scan is deliberately bounded: a workspace can be arbitrary
 * large, and the workbench is a picker, not an indexer.
 */

import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** A design file always carries this meta tag; the format owns the spelling. */
export const DESIGN_MARKER = /<meta\b[^>]*\bname\s*=\s*["']design-schema["'][^>]*>/i;

/** Directories that never contain user-facing design files. */
export const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".next", ".nuxt", ".svelte-kit",
  ".cache", ".turbo", ".parcel-cache", ".venv", ".tox", ".pytest_cache",
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
 * Scan one workspace, depth-first, bounded by depth, file count and time.
 *
 * @param {{path: string}} workspace canonical workspace directory
 * @param {{deadline?: number, maxDepth?: number, maxFiles?: number}} [options]
 * @returns {Promise<{path: string, files: Array<object>, incomplete: boolean}>}
 */
export async function scanWorkspace(workspace, options = {}) {
  const root = workspace.path;
  const deadline = options.deadline ?? Date.now() + LIMITS.budgetMs;
  const maxDepth = options.maxDepth ?? LIMITS.maxDepth;
  const maxFiles = options.maxFiles ?? LIMITS.maxFiles;
  const files = [];
  let incomplete = false;

  const expired = () => Date.now() > deadline;

  async function walk(directory, depth) {
    if (expired() || files.length >= maxFiles) {
      incomplete = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, never fail the whole panel
    }
    for (const entry of entries) {
      if (expired() || files.length >= maxFiles) {
        incomplete = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(entry.name)) continue;
        await walk(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !HTML.test(entry.name)) continue;
      const meta = await readDesignFile(file);
      if (meta !== null) files.push(meta);
    }
  }

  await walk(root, 0);
  files.sort((left, right) => right.mtime - left.mtime);
  return { path: root, files, incomplete };
}
