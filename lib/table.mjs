/**
 * lib/table.mjs — the format table. The single source of truth.
 *
 * Six consumers read this file:
 *   1. fragment compilation (which properties and values are accepted)
 *   2. validation (what is legal)
 *   3. normalization (the one spelling per intent)
 *   4. hints ("here is what this property accepts")
 *   5. rendering (what gets emitted)
 *   6. generated reference documents
 *
 * If a rule lives anywhere else, the six drift apart, and drift between the
 * validator and the renderer is the chronic disease of tools like this one.
 *
 * Pure. No node: imports. Runs in the browser.
 */

// -- element contract --------------------------------------------------------

/** `data-type` to the tags that may carry it. */
export const TYPE_TAGS = {
  page: ["section"],
  frame: ["div"],
  text: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span"],
  image: ["img"],
  shape: ["div"],
  icon: ["svg"],
};

/** The default type for a bare tag. `div` is `frame` unless a data-* says otherwise. */
export const TAG_TO_TYPE = {
  section: "page",
  div: "frame",
  p: "text",
  h1: "text",
  h2: "text",
  h3: "text",
  h4: "text",
  h5: "text",
  h6: "text",
  span: "text",
  img: "image",
  svg: "icon",
};

/** Types that may carry children. */
export const TYPE_HAS_CHILDREN = new Set(["page", "frame"]);

/** Required non-style attributes per type. */
export const ATTR_BY_TYPE = {
  page: { required: [], optional: ["data-canvas"] },
  frame: { required: [], optional: [] },
  text: { required: [], optional: [] },
  image: { required: ["src", "alt"], optional: ["data-credit"] },
  shape: { required: ["data-kind"], optional: [] },
  // `viewbox` is spelled lowercase here on purpose: every name in this table is
  // the parser's normalized name, and the parser lowercases attribute names and
  // keeps the author's spelling in `rawName`. The compiler writes `rawName`
  // back, so the file keeps `viewBox` while this lookup stays case-insensitive.
  //
  // It sits under `optional`, not `required`, because it is only required when
  // the icon has geometry — `structure/icon-without-viewbox` already says that,
  // with the better hint ("so the browser clips it instead of scaling it").
  // Listing it as unconditionally required would make every empty `<svg>` report
  // `structure/missing-attribute` as well, and would report the same absence
  // twice on a real icon.
  //
  // Why it was missing at all: the fragment compiler filters attributes *by this
  // table*, so a hand-written `<svg viewBox="0 0 24 24">` was dropped on the way
  // in and the whole `add` was then refused for the very thing just removed. An
  // icon could not be added through the documented path.
  //
  // `fill`, `stroke`, `stroke-width` and `data-fill` are the presentation
  // attributes the file's own base rules read: the stroke rule keys on
  // `svg:not([data-fill])` and on `[fill]`/`[stroke]` on the children, and
  // `data-fill` is the opt-out from that rule.
  icon: {
    required: ["data-icon", "data-icon-library"],
    optional: ["viewbox", "fill", "stroke", "stroke-width", "data-fill"],
  },
};

/** Optional `data-*` attributes accepted on every type. */
export const COMMON_OPTIONAL = ["data-name", "data-hidden", "data-locked"];

// Two kinds, because these are the two the format can draw: `rect` is the `div`
// and `ellipse` is the same `div` under `border-radius:50%`. `line` was here and
// nothing drew it — a `data-kind="line"` node rendered as a rectangle, a value
// the format accepted and then quietly ignored. A separator is a `rect` with a
// 1px side and a fill, which is what pen's exporter writes too.
export const SHAPE_KINDS = ["rect", "ellipse"];
export const ICON_LIBRARIES = ["lucide"];

/**
 * The declarations that place an element on the canvas.
 *
 * A page's place is `data-canvas`, and that is the only spelling for it. A
 * canvas drag used to write the same place as CSS on the page as well, which
 * left a file with two answers: the canvas reads `data-canvas` and shows one
 * position, and the deliverable — where a standalone page has nothing to be
 * positioned against — shipped another.
 */
export const PAGE_PLACEMENT = new Set(["position", "left", "top", "right", "bottom", "z-index"]);

export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const TOKEN_NAME_PATTERN = /^--[a-z]+-[A-Za-z0-9_-]+$/;

/** The seven closed token groups. The group is the text before the first hyphen. */
export const TOKEN_GROUPS = ["color", "font", "space", "radius", "size", "shadow", "border"];

/** The unit each numeric token group carries. */
export const TOKEN_GROUP_UNIT = {
  space: "px",
  radius: "px",
  size: "px",
  font: null,
  color: null,
  shadow: null,
  border: null,
};

// -- style properties --------------------------------------------------------

/** Emit order. The `style` attribute is always written in this order. */
export const CSS_ORDER = [
  "display",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "gap",
  "padding",
  "position",
  "left",
  "top",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "flex",
  "flex-shrink",
  "align-self",
  "margin",
  "background-color",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "box-shadow",
  "opacity",
  "backdrop-filter",
  "transform",
  "overflow",
  "outline",
  "outline-offset",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "text-align",
  "text-transform",
  "white-space",
  "object-fit",
  "background-image",
  "background-size",
  "background-position",
];

export const CSS_SET = new Set(CSS_ORDER);

const EMIT_INDEX = new Map(CSS_ORDER.map((name, i) => [name, i]));

export function compareProperties(a, b) {
  const ai = EMIT_INDEX.has(a) ? EMIT_INDEX.get(a) : 1000;
  const bi = EMIT_INDEX.has(b) ? EMIT_INDEX.get(b) : 1000;
  if (ai !== bi) return ai - bi;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isAllowedProperty(name) {
  return EMIT_INDEX.has(name);
}

// -- value grammars ----------------------------------------------------------

const C = (hint) => ({ kind: "color", hint });
const L = (hint, extra = {}) => ({ kind: "length", hint, ...extra });
const N = (hint, extra = {}) => ({ kind: "number", hint, ...extra });
const E = (values, hint) => ({ kind: "enum", values, hint });
const K = (values, hint) => ({ kind: "keyword-set", values, hint });

/**
 * One entry per allowed property. `kind` drives both the value check and the
 * normalizer, so a property can never be legal in one and unknown in the other.
 */
export const CSS_ALLOWED = {
  display: E(["flex", "block", "none"], "flex | block | none"),
  "flex-direction": E(["row", "column"], "row | column"),
  "flex-wrap": E(["wrap", "nowrap"], "wrap | nowrap"),
  "align-items": K(["flex-start", "center", "flex-end", "stretch", "baseline"], "flex-start | center | flex-end | stretch | baseline"),
  "justify-content": K(["flex-start", "center", "flex-end", "space-between", "space-around"], "flex-start | center | flex-end | space-between | space-around"),
  gap: L("12px | var(--space-md)"),
  padding: L("16px | 16px 24px | 16px 24px 8px 24px"),
  position: E(["absolute", "relative"], "absolute | relative"),
  left: L("-8px | 0 | var(--space-sm)"),
  top: L("-8px | 0 | var(--space-sm)"),
  width: L("236px | 100% | 50% | fit-content | 100vh | 100vw"),
  height: L("844px | 100% | 50% | fit-content | 100vh | 100vw"),
  "min-width": L("0 | 200px"),
  "max-width": L("480px | 100%"),
  "min-height": L("0 | 44px"),
  "max-height": L("100% | 640px"),
  flex: { kind: "flex", hint: "1 1 0% | 0 0 auto | 1 1 auto" },
  "flex-shrink": N("0 | 1", { min: 0, max: 10 }),
  "align-self": K(["flex-start", "center", "flex-end", "stretch"], "flex-start | center | flex-end | stretch"),
  margin: L("0 | -8px | 16px 0"),
  "background-color": C("#ffffff | #ffffffee | transparent | var(--color-bg)"),
  border: { kind: "border", hint: "1px solid #e5e7eb | var(--border-hairline)" },
  "border-width": L("1px | 1px 0 1px 0"),
  "border-style": K(["solid", "dashed", "dotted"], "solid | dashed | dotted"),
  "border-color": C("#e5e7eb | var(--color-line)"),
  "border-radius": L("12px | 50% | var(--radius-lg)"),
  "box-shadow": { kind: "shadow", hint: "0 6px 16px #0000001f | 0 1px 2px #0000001a, 0 4px 8px #00000014" },
  opacity: N("0 | 0.5 | 1", { min: 0, max: 1 }),
  // Paint-only, like `box-shadow`: it changes what the surface shows, never
  // where anything sits, so no geometry rule has to know about it. Two
  // functions, not a filter chain — see normalizeBackdropFilter for why.
  "backdrop-filter": { kind: "backdrop", hint: "blur(20px) | blur(20px) saturate(1.4)" },
  // One function, not a transform list: a rotation is the only one whose effect a
  // static design and its checks can describe (a box turns, its layout does not).
  // `translate()` is `left`/`top`, and `scale()` changes a size — both already
  // have a spelling, and a second one is how the two drift apart.
  transform: { kind: "transform", hint: "rotate(-1.5deg) | none" },
  overflow: E(["hidden", "visible", "auto", "scroll"], "hidden | visible | auto | scroll"),
  outline: { kind: "outline", hint: "1px solid #b8325e" },
  "outline-offset": L("-2px | 2px"),
  "font-family": { kind: "text", hint: "Inter, system-ui, sans-serif | var(--font-body)" },
  "font-size": L("14px | var(--size-body)"),
  "font-weight": { kind: "font-weight", hint: "400 | 500 | 600 | 700 | bold" },
  "font-style": E(["normal", "italic"], "normal | italic"),
  "line-height": { kind: "line-height", hint: "1.5 | 20px" },
  "letter-spacing": L("0.02em | 1px"),
  color: C("#111827 | var(--color-ink)"),
  "text-align": E(["left", "center", "right"], "left | center | right"),
  "text-transform": E(["uppercase", "lowercase", "capitalize", "none"], "uppercase | lowercase | capitalize | none"),
  // `pre-line` is the one that means "the breaks I wrote, and nothing else":
  // it keeps a newline and still folds a run of spaces, which is what pen's own
  // export renders (`<br>` inside ordinary whitespace). `pre-wrap` keeps the
  // spaces too, and a space at the end of a line then takes part in centring —
  // 11px of shift on the imported welcome document, measured against pen's export
  // of the same file. Both are here because both are real intents.
  "white-space": E(["normal", "nowrap", "pre-wrap", "pre-line"], "normal | nowrap | pre-wrap | pre-line"),
  "object-fit": E(["cover", "contain", "fill"], "cover | contain | fill"),
  "background-image": { kind: "image", hint: 'url("photo.png") | linear-gradient(180deg, #00000000, #000000b3) | var(--img-hero)' },
  // `100% 100%` is how the format spells a stretch: pen writes an image fill's
  // `mode` as `fill`, and `cover`, `contain` and `fill` are the three modes a
  // design actually carries. Without the pair a stretched fill has no spelling,
  // and a fill that cannot be spelled is a fill that silently gets the wrong one.
  // A pair, not only a keyword: a repeating texture needs a tile that `cover`
  // cannot express — a dot grid is one dot every 26px — and the only spelling
  // before this was a data-URI SVG whose intrinsic size carried the number.
  // `100% 100%` is no longer special-cased: it is a pair of lengths like any
  // other, and it normalizes to itself.
  "background-size": { kind: "size", hint: "cover | contain | auto | 26px 26px" },
  "background-position": K(["center", "top", "bottom", "left", "right"], "center | top | bottom | left | right"),
};

export function specFor(name) {
  return CSS_ALLOWED[name] || null;
}

// -- aliases and shorthands --------------------------------------------------

/** Properties that are not part of the format, and what to do with them. */
export const CSS_ALIASES = {
  background: "background-color",
  "background-colour": "background-color",
  "bg-color": "background-color",
  // Safari's prefixed spelling is still what half the glass snippets on the web
  // carry. It is the same declaration, so it is rewritten instead of refused.
  "-webkit-backdrop-filter": "backdrop-filter",
  "-webkit-transform": "transform",
};

/** Values that mean the same thing, normalized to one spelling. */
export const VALUE_ALIASES = {
  "align-items": { "flex-left": "flex-start", start: "flex-start", end: "flex-end", "space-between": "space-between" },
  "justify-content": { start: "flex-start", end: "flex-end", "space-evenly": "space-around" },
  "flex-direction": { horizontal: "row", vertical: "column" },
  "font-weight": { normal: "400", regular: "400", medium: "500", semibold: "600", bold: "700" },
  "text-align": { start: "left", end: "right" },
};

/**
 * Properties written by a model that the format does not use, with the
 * replacement, or `null` to refuse.
 *
 * The reason field is printed in the receipt, so a refusal teaches the model
 * what this format wants instead of only what it rejected.
 */
export const REJECTED_PROPERTIES = {
  // `margin` is in the table, and it is not the spacing system: `gap` and
  // `padding` are, and they are what a fragment should use. Margin is accepted
  // because offsetting one element by a hair is a real need — an imported file
  // uses it to nudge a focus ring — and refusing it outright would force a
  // wrapper element for a half-pixel.
  "margin-top": { replacement: "margin with four values", reason: "A one-sided margin is a second spelling of the same intent." },
  "margin-right": { replacement: "gap on the parent, or margin on this element", reason: "Write the shorthand: margin: 0 8px 0 0." },
  "margin-bottom": { replacement: "gap on the parent, or margin on this element", reason: "Write the shorthand: margin: 0 0 8px 0." },
  "margin-left": { replacement: "gap on the parent, or margin on this element", reason: "Write the shorthand: margin: 0 0 0 8px." },
  cursor: { replacement: null, reason: "The format describes appearance, not interaction. A cursor is behavior." },

  transition: { replacement: null, reason: "No animation. A design file is a still." },
  animation: { replacement: null, reason: "No animation. A design file is a still." },
  "font": { replacement: "font-family, font-size, font-weight and line-height", reason: "Write the longhand properties." },
  "border-top": { replacement: "border-width: 1px 0 0 0", reason: "Use border-width with four values for one edge." },
  "border-bottom": { replacement: "border-width: 0 0 1px 0", reason: "Use border-width with four values for one edge." },
  "border-left": { replacement: "border-width: 0 0 0 1px", reason: "Use border-width with four values for one edge." },
  "border-right": { replacement: "border-width: 0 1px 0 0", reason: "Use border-width with four values for one edge." },
  "grid-template-columns": { replacement: "display:flex with flex:1 on the children", reason: "The format has no grid. Flex covers the same layouts." },
  "grid-template-rows": { replacement: "display:flex with flex:1 on the children", reason: "The format has no grid. Flex covers the same layouts." },
  "grid-gap": { replacement: "gap", reason: "The property is named gap." },
  rotate: { replacement: "transform: rotate(<deg>)", reason: "A rotation is written as transform: rotate(), so there is one spelling, not two." },
  "z-index": { replacement: "document order", reason: "Paint order follows document order. Move the element instead." },
  "text-decoration": { replacement: null, reason: "Not in the format. Use a border-width on the bottom edge for an underline." },
};

// -- normalization -----------------------------------------------------------

export class TableError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "TableError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FUNCTION = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/i;
const VAR_OR_TOKEN = /^(var\([^()]+\)|\$[A-Za-z][A-Za-z0-9_-]*)$/;

const CSS_NAMED_COLORS = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", gray: "#808080",
  grey: "#808080", silver: "#c0c0c0", navy: "#000080", teal: "#008080", cyan: "#00ffff",
  magenta: "#ff00ff", maroon: "#800000", olive: "#808000", lime: "#00ff00",
  transparent: null,
};

/**
 * The canonical spelling of a color. Throws `TableError` with a hint when the
 * value cannot be normalized.
 */
export function normalizeColor(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") throw new TableError("style/empty-value", "The value is empty.", { hint: "#rrggbb" });
  if (VAR_OR_TOKEN.test(raw)) return raw;
  if (raw.toLowerCase() === "transparent") return "transparent";
  if (HEX_COLOR.test(raw)) return expandHex(raw);
  const lower = raw.toLowerCase();
  if (Object.hasOwn(CSS_NAMED_COLORS, lower)) {
    const named = CSS_NAMED_COLORS[lower];
    return named === null ? "transparent" : named;
  }
  const fn = COLOR_FUNCTION.exec(raw);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) throw new TableError("style/bad-color", `Cannot read the color ${raw}.`, { hint: "rgb(17 24 39)" });
    const [r, g, b] = parts.slice(0, 3).map((p) => {
      const n = p.endsWith("%") ? Math.round((parseFloat(p) / 100) * 255) : parseFloat(p);
      if (!Number.isFinite(n)) throw new TableError("style/bad-color", `Cannot read the color ${raw}.`, { hint: "rgb(17 24 39)" });
      return clampInt(n);
    });
    let alpha = null;
    if (parts.length >= 4) {
      const a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (Number.isFinite(a)) alpha = a;
    }
    return alpha === null || alpha >= 1 ? toHex(r, g, b) : toHex(r, g, b, Math.round(alpha * 255));
  }
  throw new TableError("style/bad-color", `Cannot read the color ${raw}.`, {
    hint: "Use six or eight digit hex, such as #ffffff or #00000080.",
  });
}

function clampInt(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex(r, g, b, a) {
  const hex = (n) => n.toString(16).padStart(2, "0");
  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return a === undefined ? base : `${base}${hex(a)}`;
}

/** `#fff` to `#ffffff`, `#abcd` to `#aabbccdd`, and lower case. */
export function expandHex(value) {
  const body = value.slice(1).toLowerCase();
  if (body.length === 3) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  if (body.length === 4) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}${body[3]}${body[3]}`;
  return `#${body}`;
}

const LENGTH = /^(-?\d+(?:\.\d+)?)(px|%|em|rem|vh|vw|pt)?$/;

/**
 * The canonical spelling of a length or size.
 * Zero is `0`. Integers lose the `.0`. Values keep three decimals at most.
 */
export function normalizeLength(value, options = {}) {
  const raw = String(value ?? "").trim();
  if (raw === "") throw new TableError("style/empty-value", "The value is empty.", { hint: "0 | 12px" });
  if (VAR_OR_TOKEN.test(raw)) return raw;
  const keyword = raw.toLowerCase();
  if (["auto", "fit-content", "max-content", "min-content", "inherit", "100%"].includes(keyword)) return keyword;
  if (keyword === "0px" || keyword === "0%") return "0";
  const match = LENGTH.exec(keyword);
  if (!match) throw new TableError("style/bad-length", `Cannot read the length ${raw}.`, { hint: "Use px, such as 12px. Use 0 for zero." });
  const number = Number(match[1]);
  const unit = match[2] || (number === 0 ? "" : "px");
  const rounded = round3(number);
  if (rounded === 0 && unit !== "%" && unit !== "em" && unit !== "rem" && unit !== "vh" && unit !== "vw") return "0";
  return `${formatNumber(rounded)}${unit}`;
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return String(round3(value)).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Expand the CSS box shorthand to four values.
 *
 * Three values are the problem case: `8px 24px 18px` means left follows right,
 * which is `8px 24px 18px 24px`. Compressing that back to three would read as
 * something else, so the canonical form expands first and compresses after.
 * Without that step, normalizing a file twice can change the design.
 */
export function expandBox(values) {
  const list = values.slice(0, 4);
  if (list.length === 0) return [];
  if (list.length === 1) return [list[0], list[0], list[0], list[0]];
  if (list.length === 2) return [list[0], list[1], list[0], list[1]];
  if (list.length === 3) return [list[0], list[1], list[2], list[1]];
  return list;
}

/** Four values to the shortest equal spelling, using the 1/2/4 value forms. */
export function compressBox(values) {
  const [top, right, bottom, left] = expandBox(values);
  if (top === right && right === bottom && bottom === left) return [top];
  if (top === bottom && right === left) return [top, right];
  // The three value form is never emitted: it is the one spelling that cannot
  // round trip, because the author may have meant `right` for `left`.
  return [top, right, bottom, left];
}

const WHITESPACE_OUTSIDE = /\s+/;

/** Split a value on whitespace that is not inside parentheses or quotes. */
export function splitValueParts(value) {
  const raw = String(value ?? "").trim();
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      current += ch;
      if (ch === "\\") { current += raw[i + 1] ?? ""; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "(") { depth += 1; current += ch; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (depth === 0 && WHITESPACE_OUTSIDE.test(ch)) {
      if (current) { parts.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Normalize one declaration value for one property.
 * @returns {{ value: string, changed: boolean }}
 */
export function normalizeValue(property, value) {
  const raw = String(value ?? "").trim();
  const spec = CSS_ALLOWED[property];

  const aliasMap = VALUE_ALIASES[property];
  if (aliasMap && aliasMap[raw.toLowerCase()]) {
    return { value: aliasMap[raw.toLowerCase()], changed: aliasMap[raw.toLowerCase()] !== raw };
  }

  if (property === "font-family") {
    return { value: normalizeFontFamily(raw), changed: normalizeFontFamily(raw) !== raw };
  }

  if (property === "box-shadow") {
    const normalized = normalizeShadowValue(raw);
    return { value: normalized, changed: normalized !== raw };
  }

  if (property === "line-height") {
    if (VAR_OR_TOKEN.test(raw)) return { value: raw, changed: false };
    if (raw.endsWith("px") || raw.endsWith("em") || raw.endsWith("rem")) {
      const n = normalizeLength(raw);
      return { value: n, changed: n !== raw };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new TableError("style/bad-number", `Cannot read the line height ${raw}.`, { hint: "1.5 | 20px" });
    }
    return { value: formatNumber(round3(n)), changed: formatNumber(round3(n)) !== raw };
  }

  if (property === "font-weight") {
    const lower = raw.toLowerCase();
    const mapped = VALUE_ALIASES["font-weight"][lower];
    if (mapped) return { value: mapped, changed: mapped !== raw };
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new TableError("style/bad-number", `Cannot read the font weight ${raw}.`, { hint: "400 | 500 | 600 | 700" });
    return { value: String(Math.round(n)), changed: String(Math.round(n)) !== raw };
  }

  if (property === "opacity") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new TableError("style/bad-number", `Cannot read the opacity ${raw}.`, { hint: "0 to 1" });
    const clamped = Math.max(0, Math.min(1, round3(n)));
    return { value: formatNumber(clamped), changed: formatNumber(clamped) !== raw };
  }

  if (property === "outline") {
    const raw2 = String(value ?? "").trim();
    if (VAR_OR_TOKEN.test(raw2) || raw2 === "none") return { value: raw2, changed: false };
    const parts = splitValueParts(raw2);
    let width = null; let lineStyle = null; let color = null;
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (["solid", "dashed", "dotted", "none"].includes(lower)) { lineStyle = lower; continue; }
      try { color = normalizeColor(part); continue; } catch { /* not a colour */ }
      width = normalizeLength(part);
    }
    const out = `${width ?? "1px"} ${lineStyle ?? "solid"} ${color ?? "#000000"}`;
    return { value: out, changed: out !== raw2 };
  }

  if (property === "flex") {
    if (VAR_OR_TOKEN.test(raw)) return { value: raw, changed: false };
    const parts = splitValueParts(raw);
    const normalized = parts.map((p) => (p === "0" ? "0" : p)).join(" ");
    if (parts.length === 1) {
      const n = Number(parts[0]);
      if (Number.isFinite(n)) return { value: `${formatNumber(n)} 1 0%`, changed: true };
    }
    if (parts.length === 2) {
      const out = `${parts[0]} ${parts[1]} 0%`;
      return { value: out, changed: out !== raw };
    }
    return { value: normalized, changed: normalized !== raw };
  }

  if (property === "background-image") {
    return { value: normalizeUrlQuoting(raw), changed: normalizeUrlQuoting(raw) !== raw };
  }

  if (!spec) throw new TableError("style/unknown-property", `The property ${property} is not in the format.`, {});

  switch (spec.kind) {
    case "color": {
      const out = normalizeColor(raw);
      return { value: out, changed: out !== raw };
    }
    case "length": {
      const parts = splitValueParts(raw);
      // A three value box is the one spelling that cannot round trip, so it is
      // expanded to four. `margin` is a box like `padding`.
      const isBox = property === "padding" || property === "margin" || property.startsWith("border-width");
      const outParts = parts.map((p) => normalizeLength(p));
      const out = isBox ? compressBox(outParts).join(" ") : outParts.join(" ");
      return { value: out, changed: out !== raw };
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new TableError("style/bad-number", `Cannot read the number ${raw}.`, { hint: spec.hint });
      const bounded = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, round3(n)));
      return { value: formatNumber(bounded), changed: formatNumber(bounded) !== raw };
    }
    case "enum":
    case "keyword-set": {
      const lower = raw.toLowerCase();
      const values = spec.values.map((v) => v.toLowerCase());
      const index = values.indexOf(lower);
      if (index === -1) {
        throw new TableError("style/bad-enum", `${raw} is not a value of ${property}.`, {
          hint: `Accepted: ${spec.hint}`,
        });
      }
      const out = spec.values[index];
      return { value: out, changed: out !== raw };
    }
    case "border": {
      const value = normalizeBorderValue(raw);
      return { value, changed: value !== raw };
    }
    case "shadow": {
      const value = normalizeShadowValue(raw);
      return { value, changed: value !== raw };
    }
    case "size": {
      const size = normalizeBackgroundSize(raw);
      return { value: size, changed: size !== raw };
    }
    case "backdrop": {
      const filter = normalizeBackdropFilter(raw);
      return { value: filter, changed: filter !== raw };
    }
    case "transform": {
      const transform = normalizeTransform(raw);
      return { value: transform, changed: transform !== raw };
    }
    case "image":
    case "text":
    default:
      return { value: raw, changed: false };
  }
}

/**
 * Quote every `url(...)` argument, so a value never needs a space to be read
 * back and a `;` inside the URL cannot split the declaration.
 *
 * A hand-written file often carries `url(&quot;a.png&quot;)`. That is HTML
 * attribute escaping, not part of the URL, so it is read as the quote it
 * represents and written back as a plain `"` inside the argument. Attribute
 * escaping then happens exactly once, at serialization. Without this step a
 * second normalization pass would turn `&quot;` into `&amp;quot;`, which is how
 * a value grows an extra layer of escaping on every save.
 */
export function normalizeUrlQuoting(value) {
  const text = String(value);
  return text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/g, (_m, d, s, bare) => {
    const target = unwrapQuoteEntities(d !== undefined ? d : s !== undefined ? s : bare);
    return `url("${target}")`;
  });
}

/**
 * Strip a pair of quote character references around a value.
 * `&quot;a.png&quot;` becomes `a.png`. Only a matching outer pair is removed, so
 * a URL that legitimately contains `&quot;` in the middle keeps it.
 */
export function unwrapQuoteEntities(value) {
  const text = String(value);
  const head = /^&(?:quot|#0*34|#x0*22);/i.exec(text);
  if (!head) return text;
  const tail = /&(?:quot|#0*34|#x0*22);$/i.exec(text);
  if (!tail || tail.index < head[0].length) return text;
  return text.slice(head[0].length, tail.index);
}

/** `&quot;` and `&#34;` read as the `"` they represent. */
export function decodeQuoteEntities(value) {
  return String(value).replace(/&(?:quot|#0*34|#x0*22);/gi, '"').replace(/&(?:apos|#0*39|#x0*27);/gi, "'");
}

/** Font families are written as given. No fallback tail is appended. */
/**
 * The CSS-wide family keywords. A `font-family` list that ends in one of these
 * ends in something every browser has; a list that ends in `"Noto Serif SC"`
 * ends in something the browser may not have, and the fallback is then the
 * document default, which is a serif face on most engines and a different layout
 * on all of them.
 */
export const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
  "math", "emoji", "fangsong",
]);

/** The pair pen's exporter appends, and the pair this format writes. */
export const FONT_FALLBACK = "system-ui, sans-serif";

/**
 * A family list with a generic family at the end, if it had none.
 *
 * `"Noto Serif SC"` alone means "Noto Serif SC, or whatever the document
 * default is". The document default is not the same on every machine, so a
 * design that loads its webfont looks right and a design that cannot — offline,
 * behind a proxy, on a build machine — does not look like the same design.
 */
export function ensureGenericFamily(value) {
  const raw = String(value ?? "").trim();
  if (!raw || VAR_OR_TOKEN.test(raw)) return raw;
  const parts = splitTopLevel(raw, ",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return raw;
  const last = parts[parts.length - 1].replace(/^["']|["']$/g, "").trim().toLowerCase();
  if (GENERIC_FAMILIES.has(last)) return raw;
  return `${parts.join(", ")}, ${FONT_FALLBACK}`;
}

export function normalizeFontFamily(value) {
  const raw = String(value ?? "").trim();
  if (VAR_OR_TOKEN.test(raw)) return raw;
  const parts = splitTopLevel(raw, ",").map((p) => p.trim()).filter(Boolean);
  return parts.map((part) => {
    // A family written as `&quot;Foo;Bar&quot;` is the quoted family "Foo;Bar".
    // Reading the escaping first keeps the `;` where it belongs: inside a name,
    // not between two declarations.
    const unescaped = unwrapQuoteEntities(part);
    if (unescaped !== part) return `"${unescaped}"`;
    if (part.startsWith('"') || part.startsWith("'")) return `"${part.slice(1, -1)}"`;
    const lower = part.toLowerCase();
    if (GENERIC_FAMILIES.has(lower)) return lower;
    if (lower.startsWith("var(")) return part;
    if (part.includes(";")) return `"${part}"`;
    return /^[A-Za-z][A-Za-z0-9]*$/.test(part) ? part : `"${part}"`;
  }).join(", ");
}

/** `1px solid #eee` in one order: width, style, color. */
export function normalizeBorderValue(value) {
  const raw = String(value ?? "").trim();
  if (VAR_OR_TOKEN.test(raw)) return raw;
  const parts = splitValueParts(raw);
  let width = null;
  let style = null;
  let color = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (["solid", "dashed", "dotted", "none"].includes(lower)) { style = lower; continue; }
    try {
      color = normalizeColor(part);
      continue;
    } catch {
      // not a color
    }
    width = normalizeLength(part);
  }
  if (width === null && style === null && color === null) {
    throw new TableError("style/bad-border", `Cannot read the border ${raw}.`, { hint: "1px solid #e5e7eb" });
  }
  return [width ?? "1px", style ?? "solid", color ?? "#000000"].join(" ");
}

/** Shadows: one or more, each `x y blur [spread] color`, comma separated. */
export function normalizeShadowValue(value) {
  const raw = String(value ?? "").trim();
  if (VAR_OR_TOKEN.test(raw)) return raw;
  if (raw.toLowerCase() === "none") return "none";
  const layers = splitTopLevel(raw, ",").map((layer) => {
    const parts = splitValueParts(layer.trim());
    const numbers = [];
    let color = "#000000";
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "inset") {
        throw new TableError("style/bad-shadow", "Inner shadows are not in the format.", { hint: "Use an outer shadow." });
      }
      try {
        color = normalizeColor(part);
        continue;
      } catch {
        // not a color
      }
      numbers.push(normalizeLength(part));
    }
    if (numbers.length < 2) {
      throw new TableError("style/bad-shadow", `Cannot read the shadow ${raw}.`, { hint: "0 6px 16px #0000001f" });
    }
    while (numbers.length < 3) numbers.push("0");
    return [...numbers.slice(0, 4), color].join(" ");
  });
  return layers.join(", ");
}

/** The keywords a background size may be, and the hint shared by its refusals. */
const BACKGROUND_SIZE_KEYWORDS = new Set(["cover", "contain", "auto"]);
const BACKGROUND_SIZE_HINT = "cover | contain | auto | 26px 26px";

/** The lengths a size may pair; a box keyword such as `fit-content` is not one. */
const NOT_A_SIZE_KEYWORD = new Set(["fit-content", "max-content", "min-content", "inherit"]);

/**
 * A background size: one keyword, or one or two lengths.
 *
 * `cover`, `contain` and `auto` each describe the whole picture, so they never
 * take a partner — `cover 26px` is two intents, and guessing one of them is how
 * a validator starts disagreeing with the file it just wrote.
 *
 * The pair exists for a tile. A dot grid is one dot every 26px, and the only
 * spelling the format had for that was a data-URI SVG whose intrinsic size
 * carried the number; `background-size: 26px 26px` over a radial gradient says
 * the same thing in a value a person can read and change.
 *
 * A trailing `auto` is dropped: `26px auto` and `26px` paint the same picture,
 * and the format keeps one spelling per intent.
 */
export function normalizeBackgroundSize(value) {
  const raw = String(value ?? "").trim();
  if (VAR_OR_TOKEN.test(raw)) return raw;
  const parts = splitValueParts(raw);
  if (parts.length === 0 || parts.length > 2) {
    throw new TableError("style/bad-size", `background-size:${raw} — a size is one or two values.`, {
      hint: BACKGROUND_SIZE_HINT,
    });
  }
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.length === 1) {
    if (BACKGROUND_SIZE_KEYWORDS.has(lower[0])) return lower[0];
    const single = normalizeLength(parts[0]);
    if (NOT_A_SIZE_KEYWORD.has(single) || single.startsWith("-")) {
      throw new TableError("style/bad-size", `${single} is not a background size.`, { hint: BACKGROUND_SIZE_HINT });
    }
    return single;
  }
  if (lower.some((part) => part === "cover" || part === "contain")) {
    throw new TableError(
      "style/bad-size",
      `background-size:${raw} — cover and contain describe the whole picture, not half of a pair.`,
      { hint: BACKGROUND_SIZE_HINT },
    );
  }
  const pair = lower.map((part, index) => {
    if (part === "auto") return "auto";
    const length = normalizeLength(parts[index]);
    if (NOT_A_SIZE_KEYWORD.has(length) || length.startsWith("-")) {
      throw new TableError("style/bad-size", `${length} is not a background size.`, { hint: BACKGROUND_SIZE_HINT });
    }
    return length;
  });
  if (pair[0] === "auto" && pair[1] === "auto") return "auto";
  if (pair[1] === "auto") return pair[0];
  return pair.join(" ");
}

/** The hint every backdrop-filter refusal carries. */
const BACKDROP_FILTER_HINT = "blur(20px) | blur(20px) saturate(1.4)";

/** A length a blur may take: a number with a unit, and no percentage. */
const BLUR_LENGTH = /^-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|pt)?$/;

function backdropFilterError(raw, detail) {
  return new TableError("style/bad-backdrop", `backdrop-filter:${raw} — ${detail}`, { hint: BACKDROP_FILTER_HINT });
}

/**
 * A backdrop filter: `blur()` and, optionally, `saturate()`.
 *
 * Two functions, not a filter chain. The glass this format needs is a blur of
 * what is behind the surface plus a saturation lift; `drop-shadow`,
 * `brightness` and the rest are a pipeline, and a pipeline with no vocabulary is
 * a string the validator cannot read, the canvas cannot edit, and the contrast
 * checker cannot say anything true about.
 *
 * The written order is not kept: blur-then-saturate is the canonical spelling,
 * because the two commute for this purpose and one spelling per intent is the
 * rule the rest of the table follows.
 */
export function normalizeBackdropFilter(value) {
  const raw = String(value ?? "").trim();
  if (VAR_OR_TOKEN.test(raw)) return raw;
  if (raw.toLowerCase() === "none") return "none";
  const found = new Map();
  const pattern = /([a-zA-Z-]+)\s*\(\s*([^()]*?)\s*\)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (raw.slice(last, match.index).trim() !== "") {
      throw backdropFilterError(raw, "only filters, separated by spaces, may appear.");
    }
    const name = match[1].toLowerCase();
    const argument = match[2].trim();
    if (name !== "blur" && name !== "saturate") {
      throw backdropFilterError(raw, `${name}() is not a filter the format reads.`);
    }
    if (found.has(name)) throw backdropFilterError(raw, `${name}() appears twice.`);
    if (name === "blur") {
      const length = normalizeLength(argument);
      if (!BLUR_LENGTH.test(length)) throw backdropFilterError(raw, `${argument} is not a length a blur can take.`);
      if (length.startsWith("-")) throw backdropFilterError(raw, "a blur radius cannot be negative.");
      found.set(name, `blur(${length})`);
    } else {
      const number = Number(argument);
      if (!Number.isFinite(number) || number < 0) {
        throw backdropFilterError(raw, "saturate() takes a number, such as 1.4.");
      }
      found.set(name, `saturate(${formatNumber(round3(number))})`);
    }
    last = pattern.lastIndex;
  }
  if (last === 0 || raw.slice(last).trim() !== "") {
    throw backdropFilterError(raw, "only blur() and saturate() may appear.");
  }
  return ["blur", "saturate"].filter((name) => found.has(name)).map((name) => found.get(name)).join(" ");
}

/** `rotate(<deg>)`, the one function `transform` reads. */
const ROTATE_DEGREES = /^rotate\(\s*(-?\d+(?:\.\d+)?)\s*deg\s*\)$/i;

/**
 * A transform: `rotate(<deg>)` or `none`.
 *
 * Rotation is the only transform a static design can describe without changing
 * what the design is: a box turns about its own centre, its layout and its
 * children's layout do not move, and a renderer draws it with one CSS
 * declaration. `translate()` duplicates `left`/`top` and `scale()` duplicates
 * `width`/`height`; a second spelling of a size is the drift this table exists
 * to prevent, so both are refused by name.
 *
 * The angle is a literal: `var()` is refused because the canvas, the geometry
 * checks and the export all have to read the number to draw a box around it.
 * The unit is `deg` — `turn` and `rad` would be two more spellings of the same
 * angle.
 */
export function normalizeTransform(value) {
  const raw = String(value ?? "").trim();
  if (raw.toLowerCase() === "none") return "none";
  const match = ROTATE_DEGREES.exec(raw);
  if (!match) {
    throw new TableError("style/bad-transform", `transform:${raw} — only rotate(<deg>) is in the format.`, {
      hint: "rotate(-1.5deg) | none",
    });
  }
  const degrees = round3(Number(match[1]));
  return `rotate(${formatNumber(degrees === 0 ? 0 : degrees)}deg)`;
}

/** Split on a separator that is not nested inside brackets or quotes. */
export function splitTopLevel(value, separator) {
  const raw = String(value ?? "");
  const out = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

// -- declaration list --------------------------------------------------------

/**
 * Normalize a whole `style` attribute value.
 *
 * @param {string} styleText the raw attribute value
 * @param {(name:string)=>string} parse  injected `parseDeclarations` to avoid a cycle
 * @returns {{ text: string, normalized: Array, dropped: Array }}
 */
export function normalizeStyleText(styleText, parseDeclarations) {
  const declarations = parseDeclarations(String(styleText ?? ""));
  const normalized = [];
  const dropped = [];
  const kept = [];

  for (const decl of declarations) {
    let property = decl.property;
    let value = decl.value;
    if (property === "") {
      dropped.push({
        prop: decl.rawProperty, value: decl.rawValue,
        reason: "There is no property name before the colon.",
      });
      continue;
    }
    if (property.startsWith("--")) {
      // A custom property is always allowed. It is how a design carries its own
      // local values, and refusing it would push authors toward literals.
      kept.push({ property, value });
      continue;
    }
    const alias = CSS_ALIASES[property];
    if (alias) {
      normalized.push({ prop: alias, from: `${property}: ${value}`, to: `${alias}: ${value}`, reason: "aliased" });
      property = alias;
    }
    const rejected = REJECTED_PROPERTIES[property];
    if (rejected) {
      dropped.push({ prop: property, value, reason: rejected.reason, replacement: rejected.replacement });
      continue;
    }
    if (!CSS_ALLOWED[property]) {
      dropped.push({
        prop: property, value,
        reason: "Not in the format table.",
        replacement: null,
      });
      continue;
    }
    let next;
    try {
      next = normalizeValue(property, value);
    } catch (error) {
      dropped.push({ prop: property, value, reason: error.message, replacement: error.hint ?? null });
      continue;
    }
    if (next.changed) {
      normalized.push({ prop: property, from: `${property}: ${value}`, to: `${property}: ${next.value}` });
    }
    kept.push({ property, value: next.value });
  }

  const ordered = kept
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => compareProperties(a.property, b.property) || a.i - b.i)
    .map(({ property, value }) => `${property}:${value}`);

  return { text: ordered.join(";"), normalized, dropped };
}

/** Every property whose value grammar a model most often gets wrong. */
export const COMMON_MISTAKES = Object.entries(REJECTED_PROPERTIES)
  .map(([property, info]) => ({ property, replacement: info.replacement, reason: info.reason }))
  .sort((a, b) => a.property.localeCompare(b.property));
