/**
 * The write verbs share one path.
 *
 * `set`, `unset`, `remove` and `move` differ only in which ops they build. The
 * funnel around those ops is identical, and it is the part that matters:
 *
 *   read again → validate → apply → validate → refuse on a NEW error →
 *   serialize the changed ranges → write atomically → report
 *
 * `add` keeps its own front end because a fragment goes through the compiler
 * first, but it calls the same `applyAndWrite`.
 */

import { CliError, EXIT_INVALID, EXIT_OK, EXIT_UNREADABLE, fail, out } from "./cli.mjs";
import { CSS_ALIASES, REJECTED_PROPERTIES } from "../table.mjs";
import { writeAtomic, revisionOf } from "./fs.mjs";

/**
 * Apply ops to a loaded document and write, or refuse.
 *
 * @param {object} loaded the result of `readDesignFile`
 * @param {Array} ops
 * @param {object} options `{ values, verb, json }`
 * @returns {Promise<object>} the receipt
 */
export async function applyAndWrite(loaded, ops, options = {}) {
  const { values = {}, verb = "set" } = options;
  const validateDesign = await loadValidate();
  const newErrors = await loadNewErrors();
  const serialize = await loadSerialize();
  const applyOps = await loadApplyOps();

  const before = validateDesign(loaded.doc);
  let next;
  let inverse;
  try {
    ({ doc: next, inverse } = applyOps(loaded.doc, ops));
  } catch (error) {
    // A refusal is a result, not a crash. It travels back as a receipt so every
    // verb reports it the same way, and so `--json` gets the same shape as a
    // success.
    const receipt = refusedReceipt(verb, error.message, {
      code: error.code ?? "ops/failed",
      diagnostics: [],
      hint: error.hint ?? null,
    });
    reportRefusal(receipt, values, loaded.file);
    return { ...receipt, refused: true };
  }

  const after = validateDesign(next);
  const introduced = newErrors(before, after);

  if (introduced.length && !values.force) {
    const receipt = refusedReceipt(verb, "This edit would introduce a new error.", {
      code: "cli/would-introduce-errors",
      diagnostics: introduced,
      hint: introduced[0]?.hint ?? null,
    });
    reportRefusal(receipt, values, loaded.file);
    return { ...receipt, refused: true };
  }

  const text = serialize(loaded.doc, next);
  const changed = text !== loaded.text;
  const revision = revisionOf(text);

  if (!values["dry-run"] && changed) writeAtomic(loaded.file, text);

  const warnings = after.filter((d) => d.severity === "warning");
  const errors = after.filter((d) => d.severity === "error");
  return {
    ok: true,
    verb,
    applied: jsonOps(ops),
    // Kept live as well, because a caller in this process can apply it.
    inverse,
    inverseJson: jsonOps(inverse),
    changed,
    revision,
    diagnostics: after,
    summary: { errors: errors.length, warnings: warnings.length },
  };
}

/**
 * Ops as they can appear in a receipt.
 *
 * An inverse carries the removed or replaced content as live node objects, so
 * `applyOps` can put the exact object back — with its source offsets, which is
 * what keeps a later save minimal. Those objects hold `parent` and `_raw` links,
 * so they are not JSON: `JSON.stringify` throws on them.
 *
 * Only the four fields that define an op survive. A node's content is already
 * available as its `html` bytes, so nothing a caller needs is lost, and the
 * receipt stays a document a reader can act on.
 */
/**
 * The fields that may survive into a receipt.
 *
 * This is a whitelist rather than a blacklist on purpose: the point is to keep
 * `parent` and `_raw` out, and a node carries a closed set of fields, so a
 * whitelist cannot leak a cycle. It must include an attribute's `name` and
 * `value`, or an inverse that reinserts a removed subtree would produce
 * attributes with no names.
 */
const OP_FIELDS = new Set([
  "op", "target", "prop", "value", "index", "html", "children", "node",
  "kind", "raw", "tag", "attrs", "selfClosing", "before", "after", "into",
  "name", "rawName", "quote",
]);

/**
 * A text or comment node inside a subtree keeps its content.
 *
 * The op fields above are a whitelist, and a text node's content lives in
 * `value` and `raw` — which the op's own `value` shadows, so the key has to be
 * kept for the node's sake. Dropping these does not lose a declaration, it loses
 * the indentation between elements, and an undo that restores the structure but
 * not the whitespace is not an undo.
 */
const ALWAYS_KEEP = new Set(["value", "raw"]);

export function jsonOps(ops) {
  if (ops === undefined || ops === null) return null;
  const walk = (value, depth) => {
    if (depth > 12) return null;
    if (value === null || typeof value !== "object") {
      return typeof value === "function" ? null : value;
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      // `parent` closes a cycle through children; `_raw` is the parse-time
      // snapshot, which is internal to the serializer.
      if (key === "parent" || key === "_raw") continue;
      if (depth > 0 && !OP_FIELDS.has(key) && !ALWAYS_KEEP.has(key)) continue;
      out[key] = walk(entry, depth + 1);
    }
    return out;
  };
  return walk(ops, 0);
}

function refusedReceipt(verb, message, extra) {
  return {
    ok: false,
    verb,
    applied: [],
    added: [],
    normalized: [],
    dropped: [],
    diagnostics: extra.diagnostics ?? [],
    revision: null,
    changed: false,
    refused: { code: extra.code, message, hint: extra.hint ?? null },
  };
}

/**
 * Every refusal prints the same way: the code, the reason, what to write
 * instead, and the line that says the file did not move. A refusal that does not
 * say what to write is a dead end for the model, which cannot see the file.
 */
export function reportRefusal(receipt, values, file) {
  if (values.json) {
    out(JSON.stringify(receipt));
    return;
  }
  const refusal = receipt.refused ?? {};
  const lines = [`REFUSED  ${refusal.message ?? "Refused."}`];
  if (refusal.hint) lines.push(`  ${refusal.hint}`);
  for (const d of receipt.diagnostics ?? []) {
    lines.push(`  ${d.code}${d.target ? ` at ${d.target}` : ""} — ${d.message}`);
    if (d.hint) lines.push(`    ${d.hint}`);
  }
  lines.push(`${file} was not changed.`);
  out(lines.join("\n"));
}

export function reportWrite(receipt, values, file) {
  if (values.json) {
    out(JSON.stringify({ ...receipt, inverse: receipt.inverseJson ?? jsonOps(receipt.inverse) }));
    return;
  }
  if (!receipt.changed) {
    out(`${file}: already as asked (0 errors, ${receipt.summary.warnings} warnings)`, { quiet: values.quiet });
    return;
  }
  const what = `${receipt.applied.length} op${receipt.applied.length === 1 ? "" : "s"}`;
  out(`${file}: ${what}, revision ${receipt.revision} (${receipt.summary.errors} errors, ${receipt.summary.warnings} warnings)`, { quiet: values.quiet });
}

// -- module loading ----------------------------------------------------------

/**
 * `lib/node/` is two levels below `lib/`, so one `..` from this file is
 * `lib/node/`. The specifiers below are plain file names.
 */
async function loadModule(specifier, names) {
  const module = await import(new URL(specifier, import.meta.url));
  for (const name of names) {
    if (typeof module[name] === "function") return module[name];
  }
  throw new Error(`${specifier} exports none of ${names.join(", ")}`);
}

const loadValidate = () => loadModule("../validate.mjs", ["validateDesign"]);
const loadSerialize = () => loadModule("../serialize.mjs", ["serialize"]);
const loadApplyOps = () => loadModule("../ops.mjs", ["applyOps"]);
export const loadNewErrors = () => loadModule("../validate.mjs", ["newErrors"]);

/**
 * `--style 'a:b;c:d'` becomes one op per declaration.
 *
 * The property name and the value are canonicalized here, before the op exists.
 * Otherwise `--style "background:#eee"` writes a second `background` declaration
 * beside the existing `background-color`, and the file ends up with two spellings
 * of one intent — which is exactly what the canonical form exists to prevent.
 *
 * @param {Function} normalizeValue from lib/table.mjs, injected so this module
 *   does not import the format table into the node layer twice.
 */
export function styleOps(target, styleText, normalizeValue) {
  const ops = [];
  for (const part of String(styleText ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new CliError(`--style wants property:value pairs, and got ${JSON.stringify(trimmed)}`, EXIT_INVALID, "cli/bad-style", 'Such as --style "font-size:20px;color:#111827"');
    }
    const rawProperty = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    ops.push(canonicalStyleOp(target, rawProperty, rawValue, normalizeValue));
  }
  return ops;
}

/** One style op with a canonical property name and value. */
export function canonicalStyleOp(target, rawProperty, rawValue, normalizeValue) {
  let property = String(rawProperty).trim().toLowerCase();
  if (property.startsWith("--")) {
    return { op: "set", target, prop: `style:${property}`, value: String(rawValue) };
  }
  const alias = CSS_ALIASES[property];
  if (alias) property = alias;
  if (REJECTED_PROPERTIES[property]) {
    const info = REJECTED_PROPERTIES[property];
    throw new CliError(info.reason, EXIT_INVALID, "style/rejected-property", info.replacement ? `Use ${info.replacement} instead.` : "Remove it.", { property, value: rawValue });
  }
  if (!normalizeValue) return { op: "set", target, prop: `style:${property}`, value: String(rawValue) };
  try {
    const normalized = normalizeValue(property, rawValue);
    return { op: "set", target, prop: `style:${property}`, value: normalized.value };
  } catch (error) {
    throw new CliError(error.message, EXIT_INVALID, error.code ?? "style/bad-value", error.hint ?? "", { property, value: rawValue });
  }
}

export { EXIT_INVALID, EXIT_OK, EXIT_UNREADABLE, fail };
