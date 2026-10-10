/**
 * `node design.mjs rename <file> <old-id> <new-id>`
 *
 * An id is an address, so two things besides the element itself point at one:
 *
 *   - `data-ref` on an instance, which names a component's `data-id`
 *   - a `data-overrides` key, which names a descendant of the component the
 *     instance points at
 *
 * Change the id without changing those and the file stops validating: every
 * instance becomes `component/unknown-ref`, and every override that named the
 * element becomes `component/unknown-override-target`. So this verb builds one
 * `set` op per reference, plus one for the id itself, and hands the list to the
 * same funnel every other verb uses. There is no second write path.
 *
 * The id op goes **last**. `applyOps` resolves every op against the tree the
 * previous op produced, so a `data-ref` op only finds its instance while that
 * instance still has a `data-id` to be addressed by.
 *
 * `set --attr data-id=…` can change an id too, and it is what this verb's own op
 * list uses. What it cannot do is the cascade, and `set` now refuses the
 * attribute outright so that the one documented way to change an id is this one.
 */

import { EXIT_INVALID, EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { applyAndWrite, refusedReceipt, reportRefusal, reportWrite } from "../write-verbs.mjs";
import { ID_PATTERN } from "../../table.mjs";
import { getAttr, walk } from "../../parse.mjs";
import { buildIdIndex, dataIdOf } from "../../ops.mjs";
import { suggest } from "../../levenshtein.mjs";

export const USAGE = `Usage: node design.mjs rename <file> <old-id> <new-id> [options]

  --force      write even when the edit introduces a new error
  --dry-run    report what would change, write nothing
  --json       print the receipt as JSON
  --quiet      print nothing

Exit codes: 0 renamed, 1 refused, 2 unreadable or bad arguments.

An id is an address. Renaming a component rewrites every \`data-ref\` that points
at it. Renaming a descendant of a component rewrites that key in the
\`data-overrides\` of the instances that point at that component. The id itself is
written last, so every reference op still resolves.

To change one instance rather than the component every instance shares, write an
override on that instance instead: \`set <instance> --attr 'data-overrides={...}'\`.`;

/**
 * The set of ids inside each component, by component id.
 *
 * This is the same rule `lib/validate.mjs` uses for
 * `component/unknown-override-target`: an override key is valid when it names a
 * descendant of the component the instance points at, at any depth, including
 * through a nested component. Getting it wrong in one place and right in the
 * other is how a cascade writes a file the validator then refuses.
 */
function componentDescendants(doc) {
  const byComponent = new Map();
  const collect = (node, into) => {
    for (const child of node.children || []) {
      if (child.kind !== "element") continue;
      const id = dataIdOf(child);
      if (id !== null) into.add(id);
      collect(child, into);
    }
  };
  walk(doc, (node) => {
    if (node.kind !== "element") return;
    if (getAttr(node, "data-type") !== "component") return;
    const id = dataIdOf(node);
    if (id === null) return;
    const ids = new Set();
    collect(node, ids);
    byComponent.set(id, ids);
  });
  return byComponent;
}

/**
 * Every op one rename needs, in the order they have to be applied.
 *
 * @param {object} doc
 * @param {string} from
 * @param {string} to
 * @returns {Array<object>}
 */
export function renameOps(doc, from, to) {
  const index = buildIdIndex(doc);
  const components = componentDescendants(doc);
  const ops = [];

  // Only an element that `applyOps` could resolve gets an op. An element with no
  // id, or a duplicate that lost first-wins, is not addressable, so skipping it
  // is the honest move — inventing an address would be guessing.
  const addressOf = (node) => {
    const id = dataIdOf(node);
    if (id === null) return null;
    return index.get(id) === node ? id : null;
  };

  walk(doc, (node) => {
    if (node.kind !== "element") return;
    const id = addressOf(node);
    if (id === null) return;

    // 1. An instance that points at the renamed element.
    if (getAttr(node, "data-ref") === from) {
      ops.push({ op: "set", target: id, prop: "data-ref", value: to });
    }

    // 2. An override that names the renamed element. Only rewrite a key the
    //    instance could legally carry: its component has to contain `from`.
    const raw = getAttr(node, "data-overrides");
    if (raw === null) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Not JSON. Leave the bytes alone and let the validator speak.
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (!Object.prototype.hasOwnProperty.call(parsed, from)) return;

    const ref = getAttr(node, "data-ref");
    const inside = ref !== null && components.get(ref);
    if (inside && !inside.has(from)) return; // Not this component's descendant.

    if (to !== from && Object.prototype.hasOwnProperty.call(parsed, to)) {
      // Renaming would merge two overrides into one and silently drop a field.
      // Let the validator refuse the duplicate id instead of losing data here.
      return;
    }

    const rebuilt = {};
    for (const [key, value] of Object.entries(parsed)) rebuilt[key === from ? to : key] = value;
    ops.push({ op: "set", target: id, prop: "data-overrides", value: JSON.stringify(rebuilt) });
  });

  // 3. The id itself, last.
  ops.push({ op: "set", target: from, prop: "data-id", value: to });
  return ops;
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: { ...SHARED_FLAGS },
    positionals: { min: 3, max: 3 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, from, to] = positionals;
  const loaded = await readDesignFile(file);

  // Checked here, not by the funnel, because the funnel's only guard is the
  // new-error rule and `--force` turns that off. Without this, `--force` would
  // write an id the next `validate` refuses.
  if (!ID_PATTERN.test(to)) {
    const receipt = refusedReceipt("rename", `The id ${JSON.stringify(to)} is not a legal id.`, {
      code: "structure/bad-id",
      diagnostics: [],
      hint: "Start with a letter or _, then letters, digits, _ and - only. 64 characters at most.",
    });
    reportRefusal(receipt, values, file);
    return EXIT_INVALID;
  }

  if (from === to) {
    // Nothing to cascade, nothing to write. The funnel reports "already as
    // asked" for an identical `set`, which is the honest answer here too.
    const receipt = await applyAndWrite(loaded, [{ op: "set", target: from, prop: "data-id", value: to }], { values, verb: "rename" });
    if (receipt.refused) return EXIT_INVALID;
    reportWrite(receipt, values, file);
    return EXIT_OK;
  }

  const index = buildIdIndex(loaded.doc);
  if (!index.has(from)) {
    const near = suggest(from, [...index.keys()]);
    const receipt = refusedReceipt("rename", `No node with data-id ${JSON.stringify(from)}.`, {
      code: "ops/node-not-found",
      diagnostics: [],
      hint: near ? `Did you mean ${JSON.stringify(near)}?` : "Run `design ls` to list the ids in this file.",
    });
    reportRefusal(receipt, values, file);
    return EXIT_INVALID;
  }

  const receipt = await applyAndWrite(loaded, renameOps(loaded.doc, from, to), { values, verb: "rename" });
  if (receipt.refused) return EXIT_INVALID;
  reportWrite(receipt, values, file);
  return EXIT_OK;
}
