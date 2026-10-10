/**
 * Design tokens: the one place that knows what a token name means.
 *
 * A token lives in the `:root{}` of a `<style>` block, which makes it the only part
 * of a design file that is not an element. Nothing can address it by `data-id`, so
 * every rule about it — the seven groups, the name shape, the unit a numeric group
 * carries, the reference chain — has to be written down somewhere, and this is that
 * place. The alternative is what the tree already suffered once: the same rule
 * written twice, drifting apart.
 *
 * This module is pure and browser-loadable: no `node:*`, no `process`. It reads a
 * parsed document and answers questions. It does not write; the writing is an op
 * (`set-token` / `unset-token` in `lib/ops.mjs`), because every change in this tool
 * goes through one funnel.
 *
 * What a token is, per `docs/format-v3.md` §4.2 and `docs/plan.md` §4.2:
 *
 *   - `:root{ --color-accent:#2563eb }` inside a `<style>` in `<head>`.
 *   - The name is `--<group>-<name>`, and the group is one of seven.
 *   - `space`, `radius` and `size` carry a unit. `color` is a color. `font`,
 *     `shadow` and `border` are free-form CSS values, and this module does not
 *     invent a rule for them.
 *   - A token may reference a token. The chain stops at depth 16, and a cycle is
 *     refused rather than followed.
 */

import {
  TOKEN_GROUPS,
  TOKEN_GROUP_UNIT,
  TOKEN_NAME_PATTERN,
  TableError,
  normalizeColor,
  normalizeLength,
} from "./table.mjs";

/** How far a `var(--a)` chain may be followed before it is left as written. */
export const TOKEN_MAX_DEPTH = 16;

/**
 * Replace every `var(--name)` in a CSS value with the token's value, and follow
 * the chain. A name that the map does not hold stays as written, unless the
 * declaration carries a fallback, which CSS would use in that case.
 *
 * This belongs here, with the depth limit and the cycle rule it obeys. It used to
 * live in `lib/render.mjs`, and `export-html.mjs` then grew its own copy with no
 * depth limit at all: a token cycle emptied the stack during `export` while
 * `validate` called the same file valid.
 *
 * `seen` holds the names on the current chain. A repeat leaves the reference as
 * written, so a cycle cannot recurse.
 */
export function resolveTokens(cssValue, tokens, depth = 0, seen = null) {
  if (depth > TOKEN_MAX_DEPTH) return cssValue;
  const text = String(cssValue ?? "");
  if (!text.includes("var(")) return text;
  return text.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
    const token = tokens.get(name);
    if (!token) return fallback !== undefined ? fallback.trim() : whole;
    if (seen && seen.has(name)) return fallback !== undefined ? fallback.trim() : whole;
    const next = seen ? new Set(seen) : new Set();
    next.add(name);
    return resolveTokens(token.value, tokens, depth + 1, next);
  });
}

/** `var(--name)` or `var(--name, fallback)`. The fallback may itself hold a `var()`. */
const TOKEN_REFERENCE = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/** The group of a token name: the text between `--` and the first hyphen. */
export function groupOfToken(name) {
  return String(name ?? "").slice(2).split("-")[0];
}

/**
 * What is wrong with a token name, or `null` when nothing is.
 *
 * One function, because there are two callers and they must not disagree: the
 * validator, which reports a name written in a file, and `resolveTokenName`, which
 * refuses a name typed on the command line.
 *
 * The rule has two halves and only one of them used to be checked.
 * `references/schema.md` — the page the skill hands a model — says the group "must be
 * one of" the seven, and the groups are a closed set in `plan.md` §4.2. The check was
 * the shape alone, so `--accent-500` passed validation while `tokens set accent.500`
 * was refused: the file was called valid and its tokens were unaddressable, with
 * nothing saying so. A test named "a token name outside the seven groups is reported"
 * passed only because its sample, `--brand`, happened to break the shape too.
 *
 * @returns {{group:string, message:string, hint:string}|null}
 */
export function tokenNameProblem(name) {
  const raw = String(name ?? "");
  const group = groupOfToken(raw);
  const known = TOKEN_GROUPS.includes(group);
  if (TOKEN_NAME_PATTERN.test(raw) && known) return null;
  if (!TOKEN_NAME_PATTERN.test(raw) && known) {
    return {
      group,
      message: `The token ${raw} does not follow --<group>-<name>.`,
      hint: `The group is ${group}. Add a name after it, such as --${group}-base.`,
    };
  }
  if (!TOKEN_NAME_PATTERN.test(raw)) {
    return {
      group,
      message: `The token ${raw} does not follow --<group>-<name>.`,
      hint: `The group must be one of: ${TOKEN_GROUPS.join(", ")}.`,
    };
  }
  return {
    group,
    message: `The token ${raw} uses the group ${group}, which is not one of the ${TOKEN_GROUPS.length}.`,
    hint: `The groups are: ${TOKEN_GROUPS.join(", ")}.`,
  };
}

/**
 * A token name as it is written in the file, from either spelling.
 *
 * The file spells it `--color-accent`. The CLI spells it `color.accent`, because
 * `docs/plan.md` §5.1 documents `tokens set <组.名> <值>` and because a leading `--`
 * reads as a flag in a shell. Both are accepted here and produce the one name the
 * file uses, so neither spelling can grow its own behaviour.
 *
 * @param {string} spec `color.accent` or `--color-accent`
 * @returns {string} `--color-accent`
 * @throws {TableError} `style/token-name` for a group that is not one of the seven
 */
export function resolveTokenName(spec) {
  const raw = String(spec ?? "").trim();
  const groups = `Write <group>.<name>, such as color.accent. The groups are: ${TOKEN_GROUPS.join(", ")}.`;
  if (raw === "") throw new TableError("style/token-name", "A token name is required.", { hint: groups });

  if (raw.startsWith("--")) {
    const problem = tokenNameProblem(raw);
    if (problem !== null) throw new TableError("style/token-name", problem.message, { hint: problem.hint });
    return raw;
  }

  const dot = raw.indexOf(".");
  if (dot === -1) {
    throw new TableError("style/token-name", `The token ${raw} does not name a group.`, { hint: groups });
  }
  const group = raw.slice(0, dot);
  if (!TOKEN_GROUPS.includes(group)) {
    throw new TableError("style/token-name", `${group} is not a token group.`, {
      hint: `The group must be one of: ${TOKEN_GROUPS.join(", ")}.`,
    });
  }
  const name = `--${group}-${raw.slice(dot + 1)}`;
  const problem = tokenNameProblem(name);
  if (problem !== null) throw new TableError("style/token-name", problem.message, { hint: problem.hint });
  return name;
}

/**
 * The value a token declaration should carry.
 *
 * Only the two rules the contract states are enforced, because a rule that is not
 * written down cannot be enforced by surprise:
 *
 *   - a numeric group carries a unit, so a bare `16` becomes `16px` and a value
 *     that is not a length is refused. Storing `16` would produce `var(--space-md)`
 *     → `16`, which is invalid CSS, so the page would silently lose the property.
 *   - a color is normalized to the hex the rest of the file uses.
 *
 * `font`, `shadow` and `border` are written as given. `docs/format-v3.md` §4.2 sets
 * no rule for them, and a normalizer invented here would be a rule nobody asked for.
 *
 * @returns {{value:string, changed:boolean}}
 */
export function normalizeTokenValue(group, value) {
  const raw = String(value ?? "").trim();
  if (raw === "") throw new TableError("style/empty-value", "A token needs a value.", { hint: "--space-md:16px" });
  const unit = TOKEN_GROUP_UNIT[group];
  if (unit === null || unit === undefined) {
    if (group !== "color") return { value: raw, changed: false };
    const color = normalizeColor(raw);
    return { value: color, changed: color !== raw };
  }
  const normalized = normalizeLength(raw);
  return { value: normalized, changed: normalized !== raw };
}

/** Every token name a value references, in order. `var(--a, var(--b))` names both. */
export function tokenReferenceNames(value) {
  const text = String(value ?? "");
  if (!text.includes("var(")) return [];
  const out = [];
  TOKEN_REFERENCE.lastIndex = 0;
  let m;
  while ((m = TOKEN_REFERENCE.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * Every token in the document, and where it is written.
 *
 * One site per name: the first declaration wins the slot, and a later declaration of
 * the same name is reported instead of quietly replacing it. `format-v3.md` §4.1
 * says both style blocks are collected and that the later block must not overwrite
 * the earlier one, so a name declared twice is a conflict the caller has to resolve,
 * not a value this function gets to choose.
 *
 * `offset` is a **file** offset: the block's text starts at `block.textStart`, and a
 * declaration's `start` is relative to that text. Both live here so the addition
 * happens once.
 *
 * @returns {{sites:Map<string,object>, duplicates:Array<{name:string, offsets:number[]}>, blocks:object[]}}
 */
export function tokenSites(doc) {
  const sites = new Map();
  const duplicates = [];
  const blocks = [];
  for (const block of doc?.styleBlocks || []) {
    // `inHead` is part of the test because format-v3 §4.1 defines a token block that
    // way ("`<style>` 在 `<head>` 内、内容含 `:root{` 时是 `tokens`"). A `<style>` in
    // `<body>` is a `style/style-in-body` error, and reading tokens out of a block the
    // contract does not recognise would let a broken file look like a working one.
    if (block.inHead !== true) continue;
    if (block.role !== "tokens" && block.role !== "tokens+page-frame") continue;
    blocks.push(block);
    for (const declaration of block.declarations || []) {
      if (!declaration.property.startsWith("--")) continue;
      const offset = (block.textStart ?? 0) + declaration.start;
      const known = sites.get(declaration.property);
      if (known) {
        known.duplicates.push(offset);
        const reported = duplicates.find((entry) => entry.name === declaration.property);
        if (reported) reported.offsets.push(offset);
        else duplicates.push({ name: declaration.property, offsets: [known.offset, offset] });
        continue;
      }
      sites.set(declaration.property, {
        name: declaration.property,
        value: declaration.value,
        offset,
        block,
        declaration,
        duplicates: [],
      });
    }
  }
  return { sites, duplicates, blocks };
}

/**
 * Token reference cycles, each reported once.
 *
 * A cycle is not an edge case: `--a:var(--b); --b:var(--a)` makes any consumer that
 * follows the chain recurse until the stack dies — that is what
 * `export --resolve-tokens` did, with `REFUSED Maximum call stack size exceeded` as
 * the whole report, while `validate` called the same file valid. `docs/plan.md` §4.2
 * already promised "循环被拒绝"; this is where the promise is kept.
 *
 * Depth-first with three colours, so a name is walked once and every distinct cycle
 * is reported from its own entry point. A self-reference is a cycle of one.
 *
 * @returns {Array<{names:string[], offsets:number[]}>}
 */
export function findTokenCycles(sites) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map();
  const stack = [];
  const found = [];
  const seen = new Set();

  const visit = (name) => {
    const state = colour.get(name) || WHITE;
    if (state === BLACK) return;
    if (state === GREY) {
      const at = stack.indexOf(name);
      const names = stack.slice(at);
      const key = [...names].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ names, offsets: names.map((n) => sites.get(n)?.offset).filter((o) => o !== undefined) });
      }
      return;
    }
    colour.set(name, GREY);
    stack.push(name);
    const site = sites.get(name);
    for (const referenced of tokenReferenceNames(site?.value)) {
      if (sites.has(referenced)) visit(referenced);
    }
    stack.pop();
    colour.set(name, BLACK);
  };

  for (const name of sites.keys()) visit(name);
  return found;
}
