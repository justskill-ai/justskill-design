/**
 * Build the GitHub release body for one version.
 *
 * The publish workflow runs this after npm accepted the tarball, then creates
 * (or edits) the release with `gh release create --notes-file`. Keeping the
 * body out of the workflow and inside a script means:
 *
 *   - the top of every release page says how to get onto this version, which
 *     is the question a "有新版" badge sends people here to answer;
 *   - Features / Fixes / Changes come from the commit subjects the repository
 *     already writes in one style, so nobody has to remember to fill a
 *     template at the exact moment they are least willing to;
 *   - the same code can backfill a release for a tag that predates it.
 *
 * Conventions read from `git log` subjects:
 *
 *   feat: ...                 -> Features
 *   fix: ...                  -> Fixes
 *   perf|refactor|build|style|revert: ... -> Changes
 *   chore: ..., test: ..., docs: ..., ci: ... -> Commits only
 *   anything else (: or not)  -> Changes
 *
 * A release commit (`chore: release X.Y.Z`) never describes user-facing work,
 * so it stays out of What's New and remains visible under Commits.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIELD = "\x1f";
const RECORD = "\x1e";

/** Types that describe user-facing work when the prefix is this exact word. */
const SECTION_BY_TYPE = new Map([
  ["feat", "features"],
  ["fix", "fixes"],
]);

/** Types that describe internal work and belong under Changes. */
const CHANGE_TYPES = new Set(["perf", "refactor", "build", "style", "revert"]);

/** Types that are bookkeeping only: neither Features, Fixes nor Changes. */
const BOOKKEEPING_TYPES = new Set(["chore", "test", "docs", "ci"]);

const SECTION_TITLES = {
  features: "### Features",
  fixes: "### Fixes",
  changes: "### Changes",
};

/**
 * Split a commit subject into its conventional-commit parts.
 *
 * @param {string} subject
 * @returns {{ type: string | null, scope: string | null, text: string }}
 */
export function parseSubject(subject) {
  const match = /^([A-Za-z]+)(?:\(([^)]*)\))?!?:\s+(.+)$/u.exec(subject.trim());
  if (match === null) {
    return { type: null, scope: null, text: subject.trim() };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ?? null,
    text: match[3].trim(),
  };
}

/**
 * Which What's New section a subject belongs to, or null for bookkeeping.
 *
 * @param {string} subject
 * @returns {"features" | "fixes" | "changes" | null}
 */
export function sectionFor(subject) {
  const { type } = parseSubject(subject);
  if (type === null) return "changes";
  if (SECTION_BY_TYPE.has(type)) return SECTION_BY_TYPE.get(type);
  if (CHANGE_TYPES.has(type)) return "changes";
  if (BOOKKEEPING_TYPES.has(type)) return null;
  // `canvas:`, `brand:`, `skill:` and friends are this repository's own
  // prefixes; they describe the product, so they are changes, not noise.
  return "changes";
}

/**
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string} short
 * @property {string} subject
 * @property {string} author
 * @property {string} email
 */

/**
 * @param {Commit[]} commits newest first
 * @returns {{ features: string[], fixes: string[], changes: string[] }}
 */
export function groupCommits(commits) {
  const groups = { features: [], fixes: [], changes: [] };
  for (const commit of commits) {
    const section = sectionFor(commit.subject);
    if (section === null) continue;
    groups[section].push(parseSubject(commit.subject).text);
  }
  return groups;
}

/**
 * GitHub handles of the people in this range, from the noreply addresses every
 * commit made through the web UI or a verified email already carries.
 *
 * @param {Commit[]} commits
 * @returns {string[]}
 */
export function contributors(commits) {
  const handles = new Set();
  for (const commit of commits) {
    const match = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(commit.email);
    if (match !== null) handles.add(match[1]);
  }
  return [...handles].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {{ version: string, from?: string, to?: string, repo: string, commits: Commit[] }} input
 * @returns {string}
 */
export function renderNotes({ version, from = "", to = `v${version}`, repo, commits }) {
  const lines = [];
  lines.push("## Install / Update", "");
  lines.push(
    "通过 npm 安装或更新：插件和 Skill 是同一个包（[justskill-design](https://www.npmjs.com/package/justskill-design)）。",
    "",
    "```sh",
    "# DSH 插件",
    "dsh plugin --profile web add justskill-design@latest",
    "dsh plugin --profile web update justskill-design@latest",
    "",
    "# Skill",
    "npx skills update",
    "```",
    "",
    "## What's New",
    "",
  );

  const groups = groupCommits(commits);
  const anySection = groups.features.length + groups.fixes.length + groups.changes.length > 0;
  for (const key of /** @type {const} */ (["features", "fixes", "changes"])) {
    if (groups[key].length === 0) continue;
    lines.push(SECTION_TITLES[key], "");
    for (const text of groups[key]) lines.push(`- ${text}`);
    lines.push("");
  }
  if (!anySection) {
    lines.push("这个版本只有内部改动，见下方提交列表。", "");
  }

  lines.push("## Commits", "");
  for (const commit of commits) {
    lines.push(`- ${commit.subject} ([\`${commit.short}\`](https://github.com/${repo}/commit/${commit.sha}))`);
  }
  lines.push("");
  if (from !== "") {
    lines.push(
      `[${from}...${to}](https://github.com/${repo}/compare/${from}...${to}) · ${commits.length} commits`,
      "",
    );
  } else {
    lines.push(`${commits.length} commits`, "");
  }

  const people = contributors(commits);
  if (people.length > 0) {
    lines.push("## Contributors", "");
    for (const handle of people) lines.push(`- @${handle}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Read the commits between two refs, newest first.
 *
 * @param {{ repo: string, from?: string, to: string, cwd?: string }} input
 * @returns {Commit[]}
 */
export function readCommits({ from = "", to, cwd = ROOT }) {
  const range = from === "" ? to : `${from}..${to}`;
  const format = ["%H", "%h", "%s", "%an", "%ae"].join("%x1f") + "%x1e";
  const output = execFileSync("git", ["log", "--no-merges", `--format=${format}`, range], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/u, "").trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [sha, short, subject, author, email] = record.split(FIELD);
      return { sha, short, subject, author, email };
    });
}

/** The closest tag before `ref`, or "" when this is the first release. */
export function previousTag(ref, cwd = ROOT) {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${ref}^`], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const values = { version: "", from: "", to: "", repo: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [flag, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[index + 1] ?? "";
    if (inline === undefined) index += 1;
    if (!(flag in values)) throw new Error(`unknown flag --${flag}`);
    values[flag] = value;
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version || JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (args.repo === "") {
    throw new Error("--repo owner/name is required (the workflow passes $GITHUB_REPOSITORY)");
  }
  const to = args.to || `v${version}`;
  const from = args.from === "none" ? "" : args.from || previousTag(to);
  const commits = readCommits({ from, to, cwd: ROOT });
  process.stdout.write(renderNotes({ version, from, to, repo: args.repo, commits }));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
