/**
 * lib/node/op-json.mjs — an op list as it can leave this process.
 *
 * An op list is not JSON, and the reason is worth writing down. An inverse — the
 * op list that undoes a gesture — carries the removed or replaced content as
 * *live* node objects, so `applyOps` can put the exact object back: same source
 * offsets, which is what keeps a later save minimal, same attribute order. Those
 * objects hold `parent` links (and the serializer's `_raw` snapshot), so they
 * close a cycle through `children` and `JSON.stringify` throws on them.
 *
 * Two callers need the same projection, and neither should own it: the CLI's
 * `--json` output, and the canvas service, whose response is JSON. The server
 * used to send `result.inverse` as it stood, which meant a *text* edit — the one
 * op whose inverse is a whole node — wrote the file, failed to serialize the
 * response, and answered 500; the canvas then said "Refused: internal" about an
 * edit that had landed.
 *
 * Only the fields that define an op survive. A node's content is already
 * available as its `html` bytes, so nothing a caller needs is lost, and the
 * receipt stays a document a reader can act on.
 */

/**
 * The fields that may survive.
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
  // A token op's exact bytes. Without these the receipt would print an inverse that
  // no longer says where a removed token came from, and re-applying it would put the
  // declaration back at the end of the block instead of where it was read.
  "at", "span", "restore",
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

/** Deep limits: a subtree is a few levels, and a cycle guard costs nothing. */
const MAX_DEPTH = 12;

export function jsonOps(ops) {
  if (ops === undefined || ops === null) return null;
  const walk = (value, depth) => {
    if (depth > MAX_DEPTH) return null;
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
