/**
 * dsh/skill.js — turn this package's SKILL.md into a DSH skill contribution.
 *
 * The skill stays the source of truth: README, CLI, references and the canvas
 * are all resolved relative to the package root, so a plugin install and a
 * `~/.agents/skills` symlink see exactly the same files. Only the YAML
 * frontmatter is removed: DSH expects the Markdown body, not the metadata.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SKILL_NAME = "justskill-design";

/**
 * The catalog description DSH shows next to the skill name. DSH truncates the
 * catalog at 500 characters (dsh-tool-skill), and this stays comfortably under
 * it while keeping the "what triggers it" part first.
 */
export const SKILL_DESCRIPTION =
  "把产品想法推进到受用户审批的页面设计，再按设计写代码。用于产品想法、功能增删、页面/应用界面设计、改版、调整间距色彩排版、导出设计、导入 .pen 等场景。设计就是一份受校验的 HTML 文件，用户可以在画布上实时审阅和调整。";

/**
 * Read the small YAML subset this frontmatter uses: scalar values, folded
 * blocks (`>-`), and block lists. Keeping the parser here means `whenToUse`
 * stays in SKILL.md instead of becoming a second copy in JavaScript.
 *
 * @param {string} frontmatter text between the leading and trailing `---`
 * @returns {Map<string, string | string[]>}
 */
function parseFrontmatter(frontmatter) {
  const fields = new Map();
  const lines = frontmatter.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(lines[index]);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    index += 1;

    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const block = [];
      while (index < lines.length && (lines[index].startsWith(" ") || lines[index].startsWith("\t") || lines[index].trim() === "")) {
        block.push(lines[index].trim());
        index += 1;
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      value = value.startsWith("|") ? block.join("\n") : block.join(" ").replace(/\s+/g, " ").trim();
      fields.set(key, value);
      continue;
    }

    if (value === "") {
      const items = [];
      while (index < lines.length && /^\s+-\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s+-\s+/, "").trim().replace(/^['"]|['"]$/g, ""));
        index += 1;
      }
      fields.set(key, items);
      continue;
    }

    fields.set(key, value.replace(/^['"]|['"]$/g, ""));
  }
  return fields;
}

/**
 * Read SKILL.md and return the registration DSH expects.
 *
 * @param {string} root package root containing SKILL.md
 * @returns {{name: string, description: string, whenToUse?: string, metadata?: {category?: string, tags?: string[]}, content: string, path: string, resourceBase: {kind: "directory", path: string}}}
 */
export function readSkill(root) {
  const file = join(root, "SKILL.md");
  const raw = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const fields = match === null ? new Map() : parseFrontmatter(match[1]);
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
  if (content.trim() === "") throw new Error("SKILL.md has no body after its frontmatter");

  const whenToUse = fields.get("whenToUse");
  const category = fields.get("category");
  const tags = fields.get("tags");
  const metadata = {};
  if (typeof category === "string" && category !== "") metadata.category = category;
  if (Array.isArray(tags) && tags.length > 0) metadata.tags = tags;

  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    ...(typeof whenToUse === "string" && whenToUse !== "" ? { whenToUse } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    content,
    path: file,
    resourceBase: { kind: "directory", path: root },
  };
}
