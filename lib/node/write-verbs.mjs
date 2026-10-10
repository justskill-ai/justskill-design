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
import { shorthandHint } from "../validate.mjs";
import { writeAtomic, revisionOf } from "./fs.mjs";
import { jsonOps } from "./op-json.mjs";

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
 * A refusal, in the shape every reader expects.
 *
 * `suggestion` is carried through when there is one, because format-v3 §6 documents it
 * on the diagnostic and the human text prints it: a refusal that says "no such id" and
 * stops is a dead end for a model, which cannot see the file to guess.
 */
export function refusedReceipt(verb, message, extra) {
  const refused = { code: extra.code, message, hint: extra.hint ?? null };
  if (extra.suggestion !== undefined && extra.suggestion !== null) refused.suggestion = extra.suggestion;
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
    refused,
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
    const hint = shorthandHint(property, rawValue) ?? (info.replacement ? `Use ${info.replacement} instead.` : "Remove it.");
    throw new CliError(info.reason, EXIT_INVALID, "style/rejected-property", hint, { property, value: rawValue });
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
