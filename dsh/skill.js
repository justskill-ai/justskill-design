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
 * Read SKILL.md and return the registration DSH expects.
 *
 * @param {string} root package root containing SKILL.md
 * @returns {{name: string, description: string, content: string, path: string, resourceBase: {kind: "directory", path: string}}}
 */
export function readSkill(root) {
  const file = join(root, "SKILL.md");
  const raw = readFileSync(file, "utf8");
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
  if (content.trim() === "") throw new Error("SKILL.md has no body after its frontmatter");
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    content,
    path: file,
    resourceBase: { kind: "directory", path: root },
  };
}
