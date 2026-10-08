/**
 * `node design.mjs set <file> <data-id> [--style 'a:b;c:d'] [--text T] [--attr name=value]`
 *
 * One op per declaration, per attribute and per text change. Each op is one
 * undo step and one byte range, which is what makes an edit reviewable and
 * cheap to reverse.
 */

import { EXIT_OK, SHARED_FLAGS, out, parseArgs, readDesignFile } from "../cli.mjs";
import { applyAndWrite, reportWrite, styleOps, canonicalStyleOp } from "../write-verbs.mjs";
import { normalizeValue, CSS_ALIASES, CSS_SET } from "../../table.mjs";
import { shorthandHint } from "../../validate.mjs";

export const USAGE = `Usage: node design.mjs set <file> <data-id> [options]

  --style 'a:b;c:d'    set style declarations, one op each
  --text <value>       replace the element's text
  --attr name=value    set an attribute (repeatable)
  --unset name         remove an attribute or a style declaration (repeatable)
  --force              write even when the edit introduces a new error
  --dry-run            report what would change, write nothing
  --json               print the receipt as JSON
  --quiet              print nothing

Exit codes: 0 changed, 1 refused, 2 unreadable or bad arguments.

The data-id is the address. To change an id, use \`rename\`, which also updates
every reference to it.`;

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      style: { type: "string" },
      text: { type: "string" },
      attr: { type: "list" },
      unset: { type: "list" },
    },
    positionals: { min: 2, max: 2 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const [file, target] = positionals;
  const loaded = await readDesignFile(file);

  const ops = [];
  try {
    if (values.style !== undefined) ops.push(...styleOps(target, values.style, normalizeValue));
  } catch (error) {
    // A property the format does not use is a refusal, not a crash: report it
    // the same way the funnel reports one, so the shape is identical. The hint
    // is generated from the value, so `margin-top:16px` is told to write
    // `margin: 16px 0 0 0` and not a fixed example.
    if (error.property && error.hint === undefined) {
      error.hint = shorthandHint(error.property, error.value) ?? null;
    }
    const receipt = {
      ok: false, verb: "set", applied: [], added: [], normalized: [], dropped: [],
      diagnostics: error.hint ? [{ severity: "error", code: error.code, message: error.message, hint: error.hint }] : [],
      revision: null, changed: false,
      refused: { code: error.code ?? "cli/bad-style", message: error.message, hint: error.hint ?? null },
    };
    if (values.json) out(JSON.stringify(receipt));
    else {
      out([`REFUSED  ${error.message}`, error.hint ? `  ${error.hint}` : null, `${file} was not changed.`].filter(Boolean).join("\n"));
    }
    return 1;
  }
  if (values.text !== undefined) ops.push({ op: "set", target, prop: "text", value: values.text });

  for (const pair of asList(values.attr)) {
    const equals = String(pair).indexOf("=");
    if (equals === -1) {
      out(`REFUSED  --attr wants name=value, and got ${JSON.stringify(pair)}`);
      return 1;
    }
    ops.push({
      op: "set",
      target,
      prop: String(pair).slice(0, equals).trim(),
      value: String(pair).slice(equals + 1),
    });
  }

  for (const name of asList(values.unset)) {
    const text = String(name);
    if (isCssProperty(text)) {
      // The same alias rule applies to an unset, or removing `background` would
      // leave the `background-color` it was meant to remove.
      const property = CSS_ALIASES[text.toLowerCase()] ?? text.toLowerCase();
      ops.push({ op: "unset", target, prop: `style:${property}` });
    } else {
      ops.push({ op: "unset", target, prop: text });
    }
  }

  if (ops.length === 0) {
    out(`REFUSED  Nothing to set. Use --style, --text, --attr or --unset.`);
    return 1;
  }

  const receipt = await applyAndWrite(loaded, ops, { values, verb: "set" });
  if (receipt.refused) return 1;
  reportWrite(receipt, values, file);
  return EXIT_OK;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A bare `--unset background-color` is a style declaration, and a bare
 * `--unset data-name` is an attribute. Style properties have no `data-` prefix,
 * which is the whole difference.
 *
 * The table decides, not the spelling. "Has a hyphen" reads well until
 * `--unset top`, `--unset width` or `--unset display`: those are single words,
 * so the old rule called them attributes and refused the edit with `has no
 * "top" attribute` — for a declaration the file was carrying.
 */
function isCssProperty(name) {
  const text = String(name).toLowerCase();
  if (text.startsWith("data-")) return false;
  return CSS_SET.has(text) || Object.hasOwn(CSS_ALIASES, text);
}
