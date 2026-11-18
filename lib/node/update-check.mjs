/**
 * Local version + remote update check for justSkill Design.
 *
 * Source order (as product decided): GitHub tags first (highest semver),
 * then npm `latest` if GitHub is unreachable or returns nothing usable.
 * `releases/latest` is deliberately not used — it can lag the newest tag.
 *
 * The browser never calls GitHub/npm directly (CORS + no secret surface).
 * Canvas and the DSH host both call into this module over their own APIs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_NAME = "justskill-design";
const GITHUB_REPO = "justskill-ai/justskill-design";
const GITHUB_TAGS_URL = `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=30`;
const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/** In-process cache so opening the workbench and a canvas in one minute shares one fetch. */
const DEFAULT_CACHE_MS = 60 * 60 * 1000;
let memoryCache = null;

/**
 * Read the installed package version from disk.
 * @param {string} [root]
 * @returns {string}
 */
export function readLocalVersion(root = ROOT) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Strip a leading `v`/`V` and keep only a plain `x.y.z` (+ optional prerelease/build).
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const bare = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bare)) return null;
  return bare;
}

/**
 * Compare two normalized semver strings. Prerelease sorts below the matching
 * release (`3.2.3-rc.1` < `3.2.3`). Build metadata is ignored.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] < right.core[i]) return -1;
    if (left.core[i] > right.core[i]) return 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const n = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < n; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = Number(l);
    const rn = Number(r);
    const lNum = Number.isInteger(ln) && String(ln) === l;
    const rNum = Number.isInteger(rn) && String(rn) === r;
    if (lNum && rNum) return ln < rn ? -1 : 1;
    if (lNum) return -1;
    if (rNum) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} version
 * @returns {{ core: [number, number, number], pre: string[] } | null}
 */
function parseSemver(version) {
  const normalized = normalizeVersion(version);
  if (normalized === null) return null;
  const plus = normalized.indexOf("+");
  const noBuild = plus === -1 ? normalized : normalized.slice(0, plus);
  const dash = noBuild.indexOf("-");
  const corePart = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const prePart = dash === -1 ? "" : noBuild.slice(dash + 1);
  const core = corePart.split(".").map((part) => Number(part));
  if (core.length !== 3 || core.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return {
    core: /** @type {[number, number, number]} */ (core),
    pre: prePart === "" ? [] : prePart.split("."),
  };
}

/**
 * Highest usable semver among GitHub tag names.
 * @param {unknown} tags
 * @returns {string | null}
 */
export function highestTagVersion(tags) {
  if (!Array.isArray(tags)) return null;
  let best = null;
  for (const entry of tags) {
    const name = entry && typeof entry === "object" ? entry.name : null;
    const version = normalizeVersion(name);
    if (version === null) continue;
    if (best === null || compareSemver(version, best) > 0) best = version;
  }
  return best;
}

/**
 * @param {unknown} body
 * @returns {string | null}
 */
export function npmLatestVersion(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  return normalizeVersion(/** @type {{ version?: unknown }} */ (body).version);
}

/**
 * @typedef {object} UpdateCheckResult
 * @property {string} local
 * @property {string | null} latest
 * @property {"github" | "npm" | null} source
 * @property {boolean} updateAvailable
 * @property {number} checkedAt
 */

/**
 * Build the public result shape from already-fetched remote versions.
 * @param {object} input
 * @param {string} input.local
 * @param {string | null} [input.github]
 * @param {string | null} [input.npm]
 * @param {number} [input.now]
 * @returns {UpdateCheckResult}
 */
export function decideUpdate(input) {
  const local = normalizeVersion(input.local) ?? "0.0.0";
  const github = normalizeVersion(input.github ?? null);
  const npm = normalizeVersion(input.npm ?? null);
  const latest = github ?? npm;
  const source = github !== null ? "github" : npm !== null ? "npm" : null;
  const checkedAt = typeof input.now === "number" ? input.now : Date.now();
  return {
    local,
    latest,
    source,
    updateAvailable: latest !== null && compareSemver(latest, local) > 0,
    checkedAt,
  };
}

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<any | null>}
 */
async function fetchJson(url, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 4_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "justskill-design-update-check",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check GitHub tags, then npm. Failures become "no update", never throw.
 *
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {number} [options.cacheMs]
 * @param {boolean} [options.force]
 * @param {typeof fetchJson} [options.fetchGithub]
 * @param {typeof fetchJson} [options.fetchNpm]
 * @param {number} [options.now]
 * @returns {Promise<UpdateCheckResult>}
 */
export async function checkForUpdate(options = {}) {
  const now = typeof options.now === "number" ? options.now : Date.now();
  const cacheMs = typeof options.cacheMs === "number" ? options.cacheMs : DEFAULT_CACHE_MS;
  const local = readLocalVersion(options.root);

  if (options.force !== true && memoryCache !== null && now - memoryCache.checkedAt < cacheMs) {
    return { ...memoryCache, local };
  }

  const fetchGithub = options.fetchGithub ?? ((url, init) => fetchJson(url, init));
  const fetchNpm = options.fetchNpm ?? ((url, init) => fetchJson(url, init));

  let github = null;
  try {
    const tags = await fetchGithub(GITHUB_TAGS_URL, { timeoutMs: 4_000 });
    github = highestTagVersion(tags);
  } catch {
    github = null;
  }

  let npm = null;
  if (github === null) {
    try {
      const body = await fetchNpm(NPM_LATEST_URL, { timeoutMs: 4_000 });
      npm = npmLatestVersion(body);
    } catch {
      npm = null;
    }
  }

  const result = decideUpdate({ local, github, npm, now });
  memoryCache = result;
  return result;
}

/** Test helper: drop the in-process cache. */
export function clearUpdateCheckCache() {
  memoryCache = null;
}

export const UPDATE_CHECK = {
  packageName: PACKAGE_NAME,
  githubRepo: GITHUB_REPO,
  githubTagsUrl: GITHUB_TAGS_URL,
  npmLatestUrl: NPM_LATEST_URL,
  defaultCacheMs: DEFAULT_CACHE_MS,
};
