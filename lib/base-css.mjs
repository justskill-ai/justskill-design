/**
 * lib/base-css.mjs — the rules a design file states about itself.
 *
 * A design file is a standalone HTML document. Inline styles decide the layout,
 * and three browser defaults decide what those inline styles MEAN:
 *
 *   `box-sizing`   is `content-box`, so `width:375px;padding:0 24px` is 423px
 *                  wide, not 375px.
 *   `margin`       on `p`, `h1` and the other text tags is not zero, so a
 *                  one-line label is 16px taller than its author expects.
 *   SVG geometry   defaults to `fill:black`, so a stroke-based glyph paints as
 *                  a solid silhouette.
 *
 * The rules are deliberately keyed on the element, not on a `data-*` attribute.
 * A `data-*` selector would be shorter — one rule instead of 28 declarations —
 * and it would be wrong: `export` drops every design attribute, so a rule keyed
 * on `data-kind` stops matching in the deliverable and a circle ships as a
 * square. What a node looks like has to live in the node's own `style`.
 *
 * The file cannot leave those to chance and then be read the same way by three
 * renderers. So the file states them once, and every reader of the file gets the
 * same answer: the browser, the canvas, and `export`.
 *
 * The one exception is `:root{…}` inside a shadow root. `:root` matches no
 * element there, so the canvas puts the token values on `:host` instead. See
 * `pageCss` in `lib/render.mjs`.
 *
 * Byte fidelity: these rules are text inside a `<style>` block, which is the
 * page-frame layer. The serializer keeps them as bytes, and the parser does not
 * read them.
 */

/** The rules, one per line, in the order they must appear. */
export const BASE_RULES = [
  "*,*::before,*::after{box-sizing:border-box}",
  "*{margin:0}",
  "img{display:block}",
  // A built-in glyph carries no `fill` and no `stroke`, so these two live on the
  // glyph's own `<svg>`: a stroke needs a colour from somewhere, and `color` on
  // the element is what tints it. `:not([fill])` lets a solid icon opt out.
  "svg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
];

/** The base rules as CSS text, ready to sit in front of the token block. */
export function baseCss(rules = BASE_RULES) {
  return rules.join("\n");
}

/**
 * True when this CSS text already states a box model.
 *
 * The check is on `box-sizing`, because that is the rule that changes what a
 * `width` means. A file that omits it is not broken — it is a file whose widths
 * are content widths, which is a legitimate thing to write and a bad thing to
 * write by accident.
 */
export function hasBaseRules(cssText) {
  return /box-sizing\s*:/.test(String(cssText ?? ""));
}

/** The base rules found in a `<style>` block, or "" when there are none. */
export function baseRulesOf(cssText) {
  const text = String(cssText ?? "");
  if (!hasBaseRules(text)) return "";
  const lines = [];
  for (const rule of text.split("\n")) {
    const trimmed = rule.trim();
    if (!trimmed || trimmed.startsWith(":root")) continue;
    if (/^[^{]*\{[^}]*\}$/.test(trimmed)) lines.push(trimmed);
  }
  return lines.join("\n");
}

/**
 * The base rules this CSS text does not state.
 *
 * A file written before a rule existed is a file that renders differently from
 * the format it claims, and the difference is silent: the box model holds, so
 * nothing looks broken, and one shape or one glyph is simply wrong. So the file
 * is told which rule it is missing.
 *
 * Whitespace and quotes are free: `svg:not([data-fill]) > :not([fill])` with a
 * space before the brace states the same rule as the canonical line.
 */
export function missingBaseRules(cssText) {
  const text = squash(String(cssText ?? ""));
  return BASE_RULES.filter((rule) => !text.includes(squash(rule)));
}

function squash(text) {
  return text.replace(/\s+/g, "").replace(/["']/g, "");
}
