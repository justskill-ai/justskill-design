/**
 * lib/readers/pen.mjs — a `.pen` file to a design file.
 *
 * One direction only, and honestly so. Reading is a mapping exercise: pen's
 * model is close enough to HTML with inline CSS that most of it has a direct
 * spelling. Writing back is a different product, so there is no writer, and no
 * pretence of one.
 *
 * Every loss is counted. `importPen` returns a ledger with three columns:
 *
 *   - `lost`       something in the file has no spelling here and is gone
 *   - `converted`  a value was rewritten to the one spelling this format allows
 *   - `unmapped`   a property this reader does not know at all, by name
 *
 * The ledger is the point. A silent import is how a user loses a gradient and
 * finds out on the review screen.
 *
 * ## What maps to what
 *
 * Pen has no CSS, so the mapping is by intent, not by name:
 *
 *   - a top-level frame becomes a page (`<section data-type="page">`)
 *   - `layout: "vertical"` becomes `display:flex;flex-direction:column`
 *   - an absent `layout` becomes `display:flex;flex-direction:row`
 *   - an absent `alignItems` becomes `align-items:flex-start`, on a row and on a
 *     column alike. Pen's own exporter writes `flex-start` for both, and
 *     centring a row moved every nanny card's text 2px down against its photo
 *   - `justifyContent`/`alignItems` become the CSS properties, with
 *     `space_between` becoming `space-between`
 *   - `fill` is `background-color`, except on text and icons, where it is `color`
 *   - an image fill's `mode` is `background-size`: `cover` and `contain` carry
 *     over as themselves, `fill` stretches and is `100% 100%`. Pen's own export
 *     writes both spellings. A mode with no CSS word for it is counted as
 *     unmapped instead of quietly becoming `cover`, which crops what the design
 *     stretched
 *   - `cornerRadius: 9999` stays a pixel radius, because `50%` on a 375x48 bar
 *     draws an ellipse and pen means a pill
 *   - `ellipse` becomes `data-kind="ellipse"` plus `border-radius:50%`
 *   - `clip` becomes `overflow:hidden`
 *   - `textGrowth: "fixed-width"` becomes `white-space:normal` on a fixed width
 *   - `reusable: true` becomes `data-type="component"`
 *   - `ref` becomes `data-type="instance"` with `data-ref`
 *   - `descendants` becomes `data-overrides`, keyed by the descendant's id. An
 *     `icon` field becomes `data-icon` plus the new `children` geometry, because
 *     a glyph is geometry in this format and a name is only its label
 *   - `variables` become the token block, and `$name` references become `var()`
 *   - `x`/`y` become `data-canvas`
 *
 * ## What has no spelling, and is counted as lost
 *
 * Non-linear gradients, mesh gradients, more than one fill, inner shadows,
 * slots, themes, prototype links, and any property not in the list above. Each
 * one is named in the ledger rather than dropped in the dark.
 *
 * Pure. No node: imports, so the canvas could read a `.pen` file too.
 */

import { parse, prepareBuiltDocument } from "../parse.mjs";
import { ICONS, ICON_LIBRARY, ICON_VIEW_BOX, hasIcon, iconBody } from "../icons.mjs";
import { serializeCanonical } from "../serialize.mjs";
import { ensureGenericFamily, normalizeColor, normalizeValue, normalizeStyleText, round3, TOKEN_GROUP_UNIT, TOKEN_GROUPS } from "../table.mjs";
import { baseCss } from "../base-css.mjs";

export const PEN_VERSION_SUPPORTED = ["2.6", "2.19"];

const ICONS_COUNT = Object.keys(ICONS).length;

// -- json with comments -------------------------------------------------------

/**
 * Pen allows `//` and `/* *\/` comments in its JSON.
 * A naive strip would eat a `//` inside a string, such as a URL.
 */
export function stripJsonComments(source) {
  const text = String(source);
  let out = "";
  let inString = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] ?? ""; i += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parsePen(text) {
  let json;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch (error) {
    const failure = new Error(`The .pen file is not JSON: ${error.message}`);
    failure.code = "pen/invalid-json";
    throw failure;
  }
  if (!json || typeof json !== "object" || !Array.isArray(json.children)) {
    const failure = new Error("The .pen file has no children array, so it holds no artboards.");
    failure.code = "pen/no-pages";
    throw failure;
  }
  return json;
}

// -- the ledger ---------------------------------------------------------------

export function createLedger() {
  return {
    version: null,
    pages: 0,
    sourceNodes: 0,
    nodes: 0,
    lost: {},
    converted: {},
    unmapped: {},
    components: { found: 0, instances: 0, overridesApplied: 0, overrideFieldsDropped: 0 },
    notes: [],
  };
}

function count(target, key, by = 1) {
  target[key] = (target[key] ?? 0) + by;
}

// -- escaping and ids ---------------------------------------------------------

const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };

const escapeText = (value) => String(value ?? "").replace(/[&<>]/g, (ch) => TEXT_ESCAPES[ch]);
const escapeAttr = (value) => String(value ?? "").replace(/[&"<>]/g, (ch) => ATTR_ESCAPES[ch]);

/** Pen does not constrain ids. This format does, so a bad one is rewritten. */
export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * Pen ids to ids this format accepts.
 *
 * The result maps a NODE to its new id, not an id string to a new id string: a
 * pen file may carry the same id twice, and a string-keyed map would silently
 * keep only the last one, leaving the first node unimportable.
 *
 * @returns {Map<object, string>}
 */
export function idMapFor(json) {
  const used = new Set();
  const mapping = new Map();
  const visit = (node) => {
    const original = typeof node.id === "string" ? node.id : null;
    let candidate = original
      ? (ID_PATTERN.test(original) ? original : sanitiseId(original))
      : `n-${mapping.size + 1}`;
    if (used.has(candidate)) {
      let n = 2;
      while (used.has(`${candidate}-${n}`)) n += 1;
      candidate = `${candidate}-${n}`;
      count(temporaryLedger.converted, "duplicateIds");
    }
    used.add(candidate);
    mapping.set(node, candidate);
    for (const child of node.children ?? []) visit(child);
  };
  for (const artboard of json.children) visit(artboard);
  return mapping;
}

/** The same mapping, addressed by the source id. For a file with unique ids. */
export function idLookup(json) {
  const byNode = idMapFor(json);
  const byId = new Map();
  const visit = (node) => {
    if (typeof node.id === "string" && !byId.has(node.id)) byId.set(node.id, byNode.get(node));
    for (const child of node.children ?? []) visit(child);
  };
  for (const artboard of json.children) visit(artboard);
  return { byNode, byId };
}

function sanitiseId(raw) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z_]+/, "");
  return cleaned.slice(0, 64) || `n-${Math.abs(hash(String(raw))).toString(36)}`;
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h;
}

// -- variables ----------------------------------------------------------------

/**
 * Pen variables become the token block. The group comes from the name's own
 * prefix when it is one of the seven, so `$space-md` lands in `--space-md` and
 * `$surface-container` lands in `--color-surface-container`.
 */
export function tokensFromVariables(variables, ledger) {
  const tokens = new Map();
  const refs = new Map();
  for (const [name, definition] of Object.entries(variables ?? {})) {
    const value = definition && typeof definition === "object" ? definition.value : definition;
    const type = definition && typeof definition === "object" ? definition.type : null;
    const cssName = tokenNameFor(name, type);
    let cssValue;
    if (type === "number") {
      const unit = TOKEN_GROUP_UNIT[cssName.slice(2).split("-")[0]] ?? "px";
      cssValue = `${value}${unit}`;
      count(ledger.converted, "numericTokens");
    } else if (type === "string") {
      // A `--font-*` token holds a family list, and pen's own export writes
      // `system-ui, sans-serif` after every list it emits. A list that ends in a
      // webfont ends in something the machine may not have, so the fallback
      // becomes the DOCUMENT default — a serif face on most engines, and a
      // different layout with it. The fallback goes on the token, because the
      // elements reference the token and never spell a family themselves.
      const quoted = `"${String(value)}"`;
      cssValue = cssName.startsWith("--font-") ? ensureGenericFamily(quoted) : quoted;
      count(ledger.converted, "stringTokens");
    } else {
      try {
        cssValue = normalizeColor(String(value));
      } catch {
        cssValue = String(value);
        count(ledger.converted, "unparsedColors");
      }
    }
    tokens.set(cssName, { name: cssName, value: cssValue, type: type ?? "color" });
    refs.set(name, cssName);
    if (cssName !== `--${name}`) count(ledger.converted, "renamedTokens");
  }
  return { tokens, refs };
}

function tokenNameFor(name, type) {
  const raw = String(name);
  const lower = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const group = lower.split("-")[0];
  if (TOKEN_GROUPS.includes(group)) return `--${lower}`;
  const fallback = type === "number" ? "space" : type === "string" ? "font" : "color";
  count(temporaryLedger, "tokensWithoutGroup");
  return `--${fallback}-${lower}`;
}

// The token group fallback needs the ledger, and a module-level handle keeps
// `tokenNameFor` a pure function of its own name. It is set during an import.
let temporaryLedger = createLedger();

/** `$name` becomes `var(--name)`, or the value itself when it is not a token. */
export function resolveReference(value, refs, ledger) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const name = value.slice(1);
  const cssName = refs.get(name) ?? `--${name}`;
  if (!refs.has(name)) count(ledger.unmapped, "unresolvedVariableReferences");
  return `var(${cssName})`;
}

// -- style mapping ------------------------------------------------------------

const JUSTIFY = { space_between: "space-between", space_around: "space-around", space_evenly: "space-around", start: "flex-start", end: "flex-end", center: "center" };
const ALIGN = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch", baseline: "baseline" };

/**
 * An image fill's `mode`, as CSS `background-size`.
 *
 * Pen states how the image meets its box. `cover` and `contain` carry over as
 * the same keywords; `fill` stretches the image to the box, which CSS writes as
 * `100% 100%`. A mode that is not here is not guessed at — the ledger reports it
 * as unmapped, because a crop where the design stretches is exactly the kind of
 * difference nobody looks for.
 */
const IMAGE_FILL_SIZE = { cover: "cover", contain: "contain", fill: "100% 100%" };

/**
 * Pen node to an inline `style` value.
 *
 * The order of the checks is the order of precedence: a text node's `fill` is
 * a colour for the glyphs, not a background.
 */
export function styleFromNode(node, refs, ledger, context = {}) {
  const style = new Map();
  const set = (property, value) => {
    if (value === undefined || value === null || value === "") return;
    style.set(property, value);
  };

  // A child of a `layout:none` frame is placed by its own x and y, and by nothing else.
  //
  // This is the other half of the `relative` set below: with neither, the child is a
  // block box in the parent's flow, so two children that overlap in pen (a battery body
  // and the fill inside it) stack in the file. `left`/`top` are the properties the table
  // accepts for this, and `position` before `width` is the emit order.
  if (context.parentLayoutNone === true && Number.isFinite(node.x) && Number.isFinite(node.y)) {
    set("position", "absolute");
    set("left", `${round3(node.x)}px`);
    set("top", `${round3(node.y)}px`);
    count(ledger.converted, "absoluteChild");
  }

  // Three cases, and the difference between the last two matters:
  //
  //   "vertical"   a column
  //   "horizontal" a row, which is also pen's DEFAULT when `layout` is absent
  //   "none"       no flow at all; the children are positioned absolutely
  //
  // Reading an absent `layout` as a column is a tempting mistake and a costly
  // one: 208 frames in the reference file have more than one child and no
  // `layout` field, and every one of them is a row.
  //
  // `none` used to be counted as a conversion and then not converted: the frame got no
  // declarations at all, so its children — which pen places by their own x and y — became
  // ordinary block boxes and stacked. The status bar's battery fill rendered *below* the
  // battery body instead of inside it. Now the frame becomes the containing block (see
  // the absolute placement below) and `relative` is what makes that true.
  if (node.layout === "none") {
    set("position", "relative");
    count(ledger.converted, "layoutNone");
  } else if (node.layout === "vertical") {
    set("display", "flex");
    set("flex-direction", "column");
    // Pen's own default for a column. It matters more than it looks: with
    // `stretch`, a component with no width fills the column, and the reference
    // artboard renders its buttons as full-width bars instead of the pills it
    // drew. `flex-start` is what pen means when it does not say.
    set("align-items", "flex-start");
    if (node.gap !== undefined) set("gap", `${node.gap}px`);
  } else if (hasElementChildren(node)) {
    set("display", "flex");
    set("flex-direction", "row");
    set("align-items", "flex-start");
    if (node.gap !== undefined) set("gap", `${node.gap}px`);
  }

  // An explicit value is written AFTER the default, or the default erases it.
  if (node.justifyContent) set("justify-content", JUSTIFY[node.justifyContent] ?? node.justifyContent);
  if (node.alignItems) set("align-items", ALIGN[node.alignItems] ?? node.alignItems);

  if (node.padding !== undefined) {
    const padding = Array.isArray(node.padding) ? node.padding : [node.padding];
    set("padding", boxValue(padding));
  }

  const parentIsRow = context.parentIsRow === true;
  const parentIsColumn = context.parentIsColumn === true;

  // Pen's `width` on an auto-layout COMPONENT is the CONTENT width, and the
  // padding sits outside it. Pen's own exporter says so: in the reference
  // artboard it writes `content-box` on exactly two nodes, `TabBar` and
  // `BottomActionBar`, and `border-box` on the other 115.
  //
  // Both conditions are load-bearing, and each one is a measured counterexample:
  //
  //   `reusable`    `Month/2026年9月` is a column with `gap` and 12px of padding
  //                 on both sides, and its 236px is the BORDER box. Only the
  //                 component masters state a content width.
  //   `layout|gap`  `StatusBar` is a master with 48px of padding, and its 375px
  //                 is the border box too, because it is a fixed-position frame
  //                 and not an auto-layout one.
  //
  // Across the whole reference file the rule matches ten nodes, and eight of
  // them have no padding on the axis they declare, so they do not move. The two
  // that do move are `TabBar` 375 → 423 and `BottomActionBar` 375 → 407, which
  // is what pen's own export of the same artboard measures.
  const autoLayout = node.layout === "vertical" || node.layout === "horizontal" || node.gap !== undefined;
  const pad = node.reusable === true && autoLayout && node.padding !== undefined ? paddingSides(node.padding) : null;

  // Filling is about the axis, and only a container can fill one.
  //
  //   in a ROW, `fill_container` on the width shares the main axis: flex:1.
  //   in a COLUMN, the width is the cross axis and stretches.
  //   `fill_container` on a HEIGHT is the cross axis in a row and the main axis
  //   in a column.
  //
  // Two mistakes live here, and both are quiet. Writing `100%` collapses,
  // because a percentage inside an auto-width parent resolves to zero. And
  // stretching a text node along a row stretches it VERTICALLY, which is not
  // what the author asked for: the sheet in the reference modal grew to four
  // times its height that way. A text node hugs its content instead.
  if (node.width !== undefined) {
    const value = widthValue(node.width, node.textGrowth, parentIsRow ? true : parentIsColumn ? false : undefined);
    if (value === FILL_ALONG) {
      if (context.text && !hasElementChildren(node)) set("width", "fit-content");
      else { set("flex", "1 1 0%"); set("min-width", "0"); }
    } else if (value === FILL_ACROSS) {
      if (context.text && !hasElementChildren(node)) set("width", "fit-content");
      // `align-self: stretch` is the obvious spelling and it is the wrong one:
      // it is overridden by the parent's own `align-items`, and a column whose
      // author wrote `align-items: flex-start` — which pen does by default —
      // then leaves the child hugging its content. A tab bar collapsed from
      // 327px to 38px that way. `100%` fills a parent that has a definite
      // width, which is the case where pen says `fill_container` on the cross
      // axis.
      else set("width", "100%");
    } else {
      set("width", paddedSize(value, pad, "x"));
    }
  }
  if (node.height !== undefined) {
    const value = heightValue(node.height, parentIsColumn ? true : parentIsRow ? false : undefined);
    if (value === FILL_ALONG) { set("flex", "1 1 0%"); set("min-height", "0"); }
    else if (value === FILL_ACROSS) set("align-self", "stretch");
    else set("height", paddedSize(value, pad, "y"));
  }

  // A frame with no width stretches to its parent, which is the flex default
  // and what pen means by an unset width on a container. Only a leaf hugs its
  // content, because a leaf has nothing to stretch around.
  if (node.width === undefined && !hasElementChildren(node) && context.text) set("width", "fit-content");

  // Pen's auto layout is a fixed-position model: a control keeps the size it was
  // drawn at, and nothing shrinks to fit. CSS flexbox is the opposite — every
  // item starts at `flex-shrink: 1` — so a 375px status bar inside a 404px column
  // gets squeezed, and the whole artboard reads as squashed.
  //
  // Pen's own exporter states this on every flex child, and the pen FILE has no
  // field for it: it is what the format means, not something the author chose.
  // So it is written here, where pen's semantics are translated, and not in the
  // format table, where it would rewrite every hand-written design.
  const penType = node.type;
  const isContainer = penType === "frame" || node.reusable === true;
  if (isContainer && !style.has("flex")) set("flex-shrink", "0");

  if (node.textGrowth === "fixed-width" && node.width === undefined) {
    set("white-space", "normal");
    count(ledger.converted, "textGrowth");
  }

  // A fill is a background on a box and a colour on a glyph.
  const fill = node.fill;
  if (typeof fill === "string") {
    const value = colourValue(resolveReference(fill, refs, ledger), ledger);
    if (context.glyph) set("color", value);
    else if (context.text) set("color", value);
    else set("background-color", value);
  } else if (fill && typeof fill === "object") {
    applyObjectFill(fill, style, set, ledger, context);
  }

  if (node.cornerRadius !== undefined) {
    if (Array.isArray(node.cornerRadius)) {
      // Pen writes one radius, or four in top-right-bottom-left order. This
      // format has a single `border-radius`, so four equal corners become one
      // value and anything else becomes the four longhand properties.
      const corners = node.cornerRadius.map((v) => (Number(v) >= 9999 ? "9999px" : `${Number(v)}px`));
      if (corners.length === 1 || corners.every((v) => v === corners[0])) {
        set("border-radius", corners[0]);
      } else {
        // This format has one radius for all four corners (docs/format-v3.md,
        // canonical form). Per-corner radii would be four more properties in
        // the table and four more controls in the inspector, for one node in a
        // 1541-node reference file. So the corners collapse to the largest and
        // the loss is named, rather than the format growing a rare feature.
        const largest = corners.slice().sort((a, b) => (parseFloat(b) || 0) - (parseFloat(a) || 0))[0];
        set("border-radius", largest);
        count(ledger.lost, "perCornerRadius");
      }
      count(ledger.converted, "cornerRadiusArray");
    } else if (node.cornerRadius >= 9999) {
      // A pill, and `50%` is NOT one: a percentage radius is measured against
      // the box's own width and height, so on a 421x48 button it draws an
      // ellipse. Pen says 9999 and means "as round as the box allows", which is
      // what a very large pixel radius does.
      set("border-radius", "9999px");
      count(ledger.converted, "pillRadius");
    } else {
      set("border-radius", `${node.cornerRadius}px`);
    }
  }

  if (node.type === "ellipse") {
    // Pen's ellipse is a true ellipse: `rx` and `ry` differ when the box is not
    // square, and `50%` is the only radius that does the same — it is measured
    // against the box's own width and height. The declaration goes on the node
    // and not into a `[data-kind="ellipse"]` rule, because `export` strips the
    // design attributes and the rule would stop matching in the deliverable.
    set("border-radius", "50%");
    count(ledger.converted, "ellipseRadius");
  }

  if (node.stroke !== undefined || node.strokeWidth !== undefined) {
    applyStroke(node, style, set, refs, ledger);
  }

  if (node.effect !== undefined) applyEffect(node.effect, style, set, ledger);

  if (node.opacity !== undefined && node.opacity < 1) set("opacity", String(node.opacity));
  if (node.clip === true) set("overflow", "hidden");

  if (context.text) applyTextStyle(node, style, set, refs, ledger);

  return styleOrder(style, ledger);
}

/**
 * A colour as this format spells it: six or eight digit lower case hex.
 * A `var()` reference is left alone, and a value that cannot be read is passed
 * through and counted, because the validator will report it with a better
 * message than this reader can.
 */
function colourValue(value, ledger) {
  const text = String(value ?? "");
  if (text === "" || text.startsWith("var(")) return text;
  try {
    return normalizeColor(text);
  } catch {
    count(ledger.converted, "unparsedColors");
    return text;
  }
}

/**
 * The declarations a `ref` states for itself: only size, and only when the
 * source gave one. Everything else belongs to the component.
 *
 * The main axis is `flex`, and `flex-basis` beats the component's own `width`,
 * so filling along the axis works from the instance alone. The cross axis is
 * different: `align-self: stretch` stretches a flex item only while its own
 * cross size is `auto`, and a component that states a size — every component
 * master does — wins over it. A `fill_container` divider inside the review list
 * therefore stayed at the master's 320px instead of the list's 311px. A
 * percentage says what the instance means, and resolves to `auto` when the
 * parent has no definite size, which is the case where stretching would have
 * done nothing either.
 */
function styleFromRefSize(node, context = {}, ledger) {
  const style = new Map();
  const width = node.width === undefined ? undefined : widthValue(node.width, node.textGrowth, context.parentIsRow === true);
  if (width === FILL_ALONG) { style.set("flex", "1 1 0%"); style.set("min-width", "0"); }
  else if (width === FILL_ACROSS) style.set("width", "100%");
  else if (typeof width === "string") style.set("width", width);
  if (node.height !== undefined) {
    const height = heightValue(node.height, context.parentIsColumn === true);
    if (height === FILL_ALONG) { style.set("flex", "1 1 0%"); style.set("min-height", "0"); }
    else if (height === FILL_ACROSS) style.set("height", "100%");
    else style.set("height", height);
  }
  if (style.size === 0) return "";
  return orderedStyleText([...style.entries()], ledger);
}

/** Split a declaration list. Only used to hand text back to the format table. */
function parseBareDeclarations(value) {
  const declarations = [];
  for (const part of String(value ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    declarations.push({ property: trimmed.slice(0, colon).trim().toLowerCase(), value: trimmed.slice(colon + 1).trim() });
  }
  return declarations;
}

function hasElementChildren(node) {
  return Array.isArray(node.children) && node.children.some((child) => child && typeof child === "object" && child.type);
}

function boxValue(values) {
  return values.map((v) => (v === 0 ? "0" : `${v}px`)).join(" ");
}

/**
 * The four padding sides, in CSS order.
 *
 * Pen writes padding as one number, or as a list in top/right/bottom/left order,
 * which is also CSS order — so a list of three is top, horizontal, bottom, the
 * same as `padding: a b c` in CSS.
 */
function paddingSides(padding) {
  const values = (Array.isArray(padding) ? padding : [padding])
    .map((v) => (typeof v === "number" ? v : parseFloat(v)))
    .filter((v) => Number.isFinite(v));
  if (values.length === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (values.length === 1) return { top: values[0], right: values[0], bottom: values[0], left: values[0] };
  if (values.length === 2) return { top: values[0], right: values[1], bottom: values[0], left: values[1] };
  if (values.length === 3) return { top: values[0], right: values[1], bottom: values[2], left: values[1] };
  return { top: values[0], right: values[1], bottom: values[2], left: values[3] };
}

/** A declared size plus the padding on that axis. A keyword passes through. */
function paddedSize(value, pad, axis) {
  if (!pad) return value;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value));
  if (!match) return value;
  const extra = axis === "x" ? pad.left + pad.right : pad.top + pad.bottom;
  if (!extra) return value;
  return `${Math.round((Number(match[1]) + extra) * 100) / 100}px`;
}

/**
 * Pen writes sizes as a number, or as one of a few keywords.
 *
 * `fill_container` and `fill` both mean "take the parent's width"; `hug` means
 * "shrink to the content". Pen 2.19 renamed the first pair, and the newer name is
 * by far the more common one in a real file: 714 uses against a handful.
 */
/**
 * Sizes that are not a number.
 *
 * `fill_container` needs the parent's axis to be spelled, so these return a
 * marker: filling the main axis and filling the cross axis are two different
 * declarations. Returning `100%` for both is what a first pass does, and it
 * collapses — a percentage width inside a parent whose own width is auto
 * resolves to zero, so a panel beside a fixed portrait shrinks instead of
 * filling the rest, and its text wraps three times.
 */
const FILL_ALONG = Symbol("fill-along");
const FILL_ACROSS = Symbol("fill-across");

function widthValue(width, textGrowth, parentIsRow) {
  if (width === "fill_container" || width === "fill") {
    if (parentIsRow === undefined) return "100%";
    return parentIsRow ? FILL_ALONG : FILL_ACROSS;
  }
  if (width === "hug" || width === "hug_contents" || width === "fit_content") return "fit-content";
  if (width === "max_content") return "fit-content";
  if (width === null) return "fit-content";
  if (typeof width === "string") return width;
  return `${width}px`;
}

/** The same keywords apply to a height. */
function heightValue(height, parentIsColumn) {
  if (height === "fill_container" || height === "fill") {
    if (parentIsColumn === undefined) return "100%";
    return parentIsColumn ? FILL_ALONG : FILL_ACROSS;
  }
  if (height === "hug" || height === "hug_contents" || height === "fit_content") return "fit-content";
  if (height === "max_content") return "fit-content";
  if (height === null) return "fit-content";
  if (typeof height === "string") return height;
  return `${height}px`;
}

function applyObjectFill(fill, style, set, ledger, context) {
  const type = fill.type ?? "solid";
  if (type === "image") {
    if (context.text || context.glyph) {
      count(ledger.lost, "imageFillOnText");
      return;
    }
    if (fill.url) {
      set("background-image", `url("${fill.url}")`);
      // How the image meets its box. `cover` and `contain` are the CSS keywords
      // of the same name; pen's `fill` stretches the image, which CSS writes as
      // `100% 100%`. A mode this format cannot draw stays in the ledger as
      // unmapped rather than quietly becoming `cover`: an image that is cropped
      // where the design stretches it is a difference no one would look for.
      const size = IMAGE_FILL_SIZE[fill.mode ?? "cover"];
      if (size) set("background-size", size);
      set("background-position", "center");
      count(ledger.converted, "imageFills");
      if (!size) count(ledger.unmapped, `fillMode:${fill.mode}`);
    } else {
      count(ledger.lost, "imageFillWithoutUrl");
    }
    return;
  }
  if (type === "gradient") {
    if (fill.gradientType && fill.gradientType !== "linear") {
      count(ledger.lost, `gradient:${fill.gradientType}`);
      return;
    }
    const stops = Array.isArray(fill.colors) ? fill.colors : [];
    if (stops.length < 2) {
      count(ledger.lost, "gradientWithFewerThanTwoStops");
      return;
    }
    // Pen's `rotation` runs counter-clockwise and CSS measures clockwise from
    // "to top", so one is the other subtracted from 360. Two measurements pin
    // it, and both come from pen's own rendering of the reference file:
    //
    //   180  the caption scrim. Pen is dark at the bottom, and 360-180 = 180.
    //   135  the meetup banner. Pen's darkest corner is the bottom LEFT, which
    //        is 225deg, and 360-135 = 225.
    //
    // An earlier version wrote `rotation + 180` instead. That is right for 180
    // and 90 degrees wrong for everything else, which is the kind of error a
    // gradient hides: the band is still a band, it is just on the wrong side.
    const rotation = Number.isFinite(fill.rotation) ? ((360 - fill.rotation) % 360 + 360) % 360 : 180;
    const rendered = stops
      .map((stop) => {
        let color = String(stop.color ?? "#000000");
        try {
          color = normalizeColor(color);
        } catch {
          count(ledger.converted, "unparsedGradientStops");
        }
        const position = Number.isFinite(stop.position) ? `${Math.round(stop.position * 100)}%` : null;
        return position === null ? color : `${color} ${position}`;
      })
      .join(",");
    set("background-image", `linear-gradient(${rotation}deg,${rendered})`);
    count(ledger.converted, "linearGradients");
    return;
  }
  if (Array.isArray(fill.enabled) || fill.enabled === false) {
    count(ledger.lost, "disabledFill");
    return;
  }
  count(ledger.unmapped, `fillType:${type}`);
}

function applyStroke(node, style, set, refs, ledger) {
  // 2.19 writes `stroke: {fill, thickness, align}`; 2.6 writes `stroke` plus
  // `strokeWidth`. Both are read, so one reader covers both files.
  let color = node.stroke;
  let width = node.strokeWidth ?? 1;
  if (node.stroke && typeof node.stroke === "object" && !Array.isArray(node.stroke)) {
    // A stroke with no paint is not drawn. `border` needs a colour and there is none, so
    // writing one means inventing it — and the value this used to invent was black.
    //
    // Two measurements in the reference artboards say the paint-less stroke is structure,
    // not design. Every painted one follows its page: the same battery border is #000000 on
    // the light pages and #ffffff on the dark ones, and the nine notification buttons carry
    // nine different colours and thicknesses, four of them carrying none at all. Every
    // paint-less one is the identical `{align:"inside",thickness:1}` on all nine styles,
    // which no designer writes and no theme can colour. And the invented line hides where
    // nobody looked: black on #141417 is invisible, black on white is a box.
    const paint = node.stroke.fill ?? node.stroke.color;
    if (paint === undefined || paint === null) {
      count(ledger.lost, "strokeWithoutPaint");
      return;
    }
    color = paint;
    width = node.stroke.thickness ?? width;
    if (node.stroke.align && node.stroke.align !== "inside") {
      count(ledger.lost, `strokeAlign:${node.stroke.align}`);
    }
  }
  const cssColor = colourValue(resolveReference(color, refs, ledger), ledger);
  if (width && typeof width === "object") {
    const sides = [width.top ?? 0, width.right ?? 0, width.bottom ?? 0, width.left ?? 0];
    set("border-width", sides.map((v) => (v === 0 ? "0" : `${v}px`)).join(" "));
    set("border-style", "solid");
    set("border-color", cssColor);
    count(ledger.converted, "perSideStroke");
    return;
  }
  const cssWidth = typeof width === "number" ? width : 1;
  if (cssWidth === 0) return;
  set("border", `${cssWidth}px solid ${cssColor}`);
}

function applyEffect(effect, style, set, ledger) {
  const effects = Array.isArray(effect) ? effect : [effect];
  const shadows = [];
  for (const entry of effects) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "innerShadow" || entry.shadowType === "inner") {
      count(ledger.lost, "innerShadow");
      continue;
    }
    if (entry.type !== "shadow") {
      count(ledger.unmapped, `effect:${entry.type}`);
      continue;
    }
    const x = entry.offset?.x ?? 0;
    const y = entry.offset?.y ?? 0;
    const blur = entry.blur ?? 0;
    let color = String(entry.color ?? "#00000040");
    try {
      color = normalizeColor(color);
    } catch {
      count(ledger.converted, "unparsedShadowColors");
    }
    shadows.push(`${x}px ${y}px ${blur}px ${color}`);
  }
  if (shadows.length) set("box-shadow", shadows.join(", "));
}

function applyTextStyle(node, style, set, refs, ledger) {
  if (node.fontFamily) {
    const value = resolveReference(node.fontFamily, refs, ledger);
    if (value.startsWith("var(")) {
      set("font-family", value);
    } else {
      // Pen's own export appends `system-ui, sans-serif` to every family it
      // writes, and it is not decoration. A list that ends in a webfont ends in
      // something the machine may not have, so the fallback becomes the DOCUMENT
      // default — a serif face on most engines, and a different layout with it.
      // Offline, behind a proxy, or on a build machine, the design would stop
      // looking like the design.
      set("font-family", ensureGenericFamily(String(node.fontFamily)));
    }
  }
  if (node.fontSize !== undefined) set("font-size", `${node.fontSize}px`);
  if (node.fontWeight !== undefined) set("font-weight", String(node.fontWeight));
  if (node.lineHeight !== undefined) set("line-height", String(node.lineHeight));
  if (node.letterSpacing !== undefined) {
    set("letter-spacing", `${node.letterSpacing}px`);
  }
  if (node.textAlign) set("text-align", node.textAlign);
  if (node.textTransform) set("text-transform", node.textTransform);
  if (node.fixedWidth === true) set("white-space", "normal");
}

/** Emit order, without importing the table: this reader must stay dependency-light. */
const STYLE_ORDER = [
  "display", "flex-direction", "flex-wrap", "align-items", "justify-content", "gap", "padding",
  "position", "left", "top", "width", "height", "flex", "background-color", "border",
  "border-width", "border-style", "border-color", "border-radius", "box-shadow", "opacity",
  "overflow", "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "color", "text-align", "text-transform", "white-space", "background-image", "background-size",
  "background-position",
];

/**
 * Order the declarations and hand each value to the format's own normalizer.
 *
 * The second half matters more than it looks. Pen writes `font-weight: "normal"`
 * and shadow offsets as `0px`; the canonical form wants `400` and `0`. Re-deriving
 * those rules here would give two normalizers that drift apart, so the reader
 * borrows the one the validator and the canvas already use.
 */
function styleOrder(map, ledger) {
  return orderedStyleText([...map.entries()], ledger);
}

/**
 * Order declarations the way the format table does, and put each value through
 * the format's own normalizer.
 *
 * Both halves matter. Pen writes `font-weight: "normal"` and shadow offsets as
 * `0px`; the canonical form wants `400` and `0`. And the emit ORDER is fixed by
 * the table — `min-width` before `flex`, `position` before `width` — so a reader
 * with its own idea of the order writes a file whose very first `format --check`
 * reports a diff the author never made.
 *
 * Re-deriving either here would give two implementations, and two
 * implementations drift.
 */
function orderedStyleText(pairs, ledger) {
  const kept = [];
  for (const [property, value] of pairs) {
    if (value === undefined || value === null || value === "") continue;
    kept.push([property, normaliseValueFor(property, value, ledger)]);
  }
  const text = kept.map(([property, value]) => `${property}:${value}`).join(";");
  return normalizeStyleText(text, parseBareDeclarations).text;
}

/**
 * One value, through the format's own normalizer.
 *
 * The validator has the better message for a value it cannot read, so an
 * unreadable value is passed through and recorded rather than re-diagnosed.
 */
function normaliseValueFor(property, value, ledger) {
  if (!ledger || property.startsWith("--")) return value;
  try {
    const normalized = normalizeValue(property, value);
    if (normalized.changed) count(ledger.converted, "normalizedValues");
    return normalized.value;
  } catch (error) {
    ledger.notes.push(`${property}:${value} — ${error.message}`);
    return value;
  }
}

// -- nodes --------------------------------------------------------------------

/**
 * Pen node types, as this format's types.
 *
 * `icon_font` and `path` are both an icon by another spelling. Pen 2.6 writes a glyph as
 * `iconFontName` + `iconFontFamily` where 2.19 writes `icon` + `library`, and a `path`
 * node carries the outline itself instead of a name. All three draw the same thing, so
 * they all become `icon`; what differs is where the geometry comes from, and that is
 * `glyphBody`'s business.
 */
const TYPE_MAP = {
  frame: "frame", text: "text", icon: "icon", icon_font: "icon", path: "icon",
  rectangle: "shape", ellipse: "shape", ref: "instance",
};

function dataTypeFor(node) {
  if (node.reusable === true) return "component";
  return TYPE_MAP[node.type] ?? null;
}

/**
 * A glyph's name, in whichever of the three spellings the node uses.
 *
 * A `path` node has no name of its own — its outline is the glyph — so the layer name
 * becomes one. The table wants letters, digits and hyphens, and `data-icon` is a label
 * here: the drawing is the geometry, and the validator does not look the name up.
 */
function iconNameFor(node) {
  const named = node.icon ?? node.iconFontName;
  if (named !== undefined && named !== null && String(named) !== "") return String(named);
  const slug = String(node.name ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "circle" : slug;
}

/**
 * The grid a glyph is drawn on.
 *
 * A named glyph comes from the built-in set and is drawn on that set's grid. A `path`
 * node carries its own outline in coordinates relative to its own box — `M19.2 …` on a
 * node 19.2 wide starts at the right edge — so its viewBox is that box. Drawing it on the
 * set's grid would scale a 19×12 status-bar glyph into a 24×24 square and clip it.
 */
function iconViewBoxFor(node) {
  if (node.type !== "path") return ICON_VIEW_BOX;
  const width = Number(node.width);
  const height = Number(node.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return ICON_VIEW_BOX;
  return `0 0 ${round3(width)} ${round3(height)}`;
}

function tagFor(node, dataType) {
  if (dataType === "text") return "p";
  if (dataType === "icon") return "svg";
  if (dataType === "image") return "img";
  return "div";
}

/**
 * What a child has to know about its parent.
 *
 * Two axes and one absence. `fill_container` means "share the main axis" in a row and
 * "stretch across" in a column — two different declarations — and a child of a
 * `layout:none` frame is placed by its own x and y rather than by the flow.
 *
 * This exists because the artboard loop built the same object by hand and left the flags
 * out, so every direct child of a page was read as if its parent's axis were unknown and
 * `fill_container` fell back to `width:100%`. On a row page that is wrong by exactly the
 * width of the sibling before it: the Swiss Clean dashboard's content took the full
 * 1440px beside its 240px sidebar, and the page's own `overflow:hidden` cut those 240px
 * off the right edge — the Export button and half the last metric card. It hid for as long
 * as it did because the reference file's 25 pages all have `layout: vertical`, where
 * `100%` and `stretch` happen to agree.
 */
function childContext(node, context) {
  return {
    ...context,
    parentIsRow: node.layout !== "vertical",
    parentIsColumn: node.layout === "vertical",
    parentLayoutNone: node.layout === "none",
  };
}

/**
 * Render one pen node as HTML.
 *
 * The reader writes HTML text and then parses it with the real parser, so an
 * imported file goes through exactly the same model, serializer and validator
 * as a hand-written one. Building a tree directly would create a second
 * representation that could drift from the parser's.
 */
function renderNode(node, refs, ledger, context = {}) {
  ledger.sourceNodes += 1;
  const dataType = dataTypeFor(node);
  if (!dataType) {
    count(ledger.lost, `nodeType:${node.type}`);
    return "";
  }
  ledger.nodes += 1;

  const id = context.ids.get(node) ?? node.id ?? `n-${ledger.nodes}`;
  const attrs = [`data-id="${escapeAttr(id)}"`, `data-type="${dataType}"`];
  if (node.name) attrs.push(`data-name="${escapeAttr(node.name)}"`);

  if (dataType === "shape") {
    // A reusable ellipse becomes a `component`, and `component` takes no
    // `data-kind`. Nothing is lost by that: pen's `ellipse` IS
    // `border-radius:50%`, the node already carries it, and it scales with the
    // box exactly as pen's ellipse does. The kind is a name, the radius is the
    // shape.
    attrs.push(`data-kind="${node.type === "ellipse" ? "ellipse" : "rect"}"`);
  }
  if (dataType === "icon") {
    attrs.push(`data-icon="${escapeAttr(iconNameFor(node))}"`);
    attrs.push(`data-icon-library="${escapeAttr(node.library ?? node.iconFontFamily ?? "lucide")}"`);
    // Without this the glyph is not scaled, it is clipped. See ICON_VIEW_BOX.
    attrs.push(`viewBox="${iconViewBoxFor(node)}"`);
  }
  if (dataType === "instance") {
    const ref = context.byId.get(node.ref) ?? node.ref;
    attrs.push(`data-ref="${escapeAttr(ref ?? "")}"`);
    const overrides = overridesFor(node, context, ledger);
    if (overrides) attrs.push(`data-overrides='${escapeAttr(overrides)}'`);
  }
  // What this node's own style has to know about itself — not what its children need,
  // which is `childContext()` below. The two were one name once, and the local one
  // shadowed the function.
  const styleContext = {
    ...context,
    glyph: dataType === "icon",
    text: dataType === "text",
  };
  // An instance carries no style of its own.
  //
  // Whatever this reader wrote here is merged on top of the component's own
  // declarations when the renderer expands it, so an unset width written as
  // `width:fit-content` would silently override the component's real width. In
  // the reference file that collapsed the status bar, the nav bar and the tab
  // bar of every page. A pen `ref` may carry size overrides, and those are the
  // only declarations worth writing.
  const style = dataType === "instance"
    ? styleFromRefSize(node, context, ledger)
    : styleFromNode(node, refs, ledger, styleContext);
  if (style) attrs.push(`style="${escapeAttr(style)}"`);

  const tag = tagFor(node, dataType);
  if (dataType === "image" || dataType === "icon") {
    const inner = dataType === "icon" ? glyphBody(node, ledger) : "";
    return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
  }
  if (!Array.isArray(node.children) || node.children.length === 0) {
    if (dataType === "text") {
      return `<${tag} ${attrs.join(" ")}>${escapeText(node.content ?? node.name ?? "")}</${tag}>`;
    }
    return `<${tag} ${attrs.join(" ")}></${tag}>`;
  }

  // A child has to know its parent's axis: `fill_container` means "share the
  // main axis" in a row and "stretch across" in a column, and those are two
  // different declarations.
  const children = node.children
    .map((child) => renderNode(child, refs, ledger, childContext(node, context)))
    .join("\n");
  if (dataType === "text") {
    return `<${tag} ${attrs.join(" ")}>${escapeText(node.content ?? "")}</${tag}>`;
  }
  return `<${tag} ${attrs.join(" ")}>\n${children}\n</${tag}>`;
}

/**
 * A glyph, as inline geometry.
 *
 * Pen stores a glyph by name. This format stores geometry, so the name is
 * resolved against the built-in set and the glyph's own paths are written in.
 * Nothing is fetched: the set is in the repository, so an import works offline
 * and produces the same bytes on every machine.
 *
 * A name the set does not carry becomes a visible placeholder AND is counted in
 * the ledger. A wrong glyph would be worse than an obviously wrong one, and a
 * silent one would be worse than both.
 */
function glyphBody(node, ledger) {
  // Pen 2.6 writes a glyph as `iconFontName` where 2.19 writes `icon`. Same drawing, older
  // spelling, and worth a ledger line: the reference file carries 233 of them, and before
  // this they were all counted as an unknown node type.
  if (node.type === "icon_font") count(ledger.converted, "iconFont");
  // A `path` node IS geometry: there is no name to look up, and the outline is the glyph.
  if (node.type === "path" && typeof node.geometry === "string" && node.geometry !== "") {
    count(ledger.converted, "pathAsGeometry");
    const rule = node.fillRule === "evenodd" ? ' fill-rule="evenodd"' : "";
    // `fill="currentColor"` opts this path out of the base rule that strokes every child
    // of an `<svg>` carrying neither `data-fill` nor its own `fill`. Pen's `path` is a
    // filled outline, and a filled outline drawn as a stroke is a different shape.
    return `<path d="${escapeAttr(node.geometry)}" fill="currentColor"${rule}></path>`;
  }
  return glyphFor(node.icon ?? node.iconFontName, ledger);
}

/**
 * The same lookup, by name. A `ref` can swap one instance's glyph, and that
 * patch is geometry too, so it goes through here.
 */
function glyphFor(value, ledger) {
  const name = String(value ?? "");
  if (name && hasIcon(name)) return iconBody(name);
  count(ledger.lost, name ? "glyphNotInSet" : "iconWithoutName");
  if (name) ledger.notes.push(`glyph ${JSON.stringify(name)} is not in the built-in set (${ICONS_COUNT} glyphs): a placeholder was written`);
  return `<rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor"></rect>`;
}

function overridesFor(node, context, ledger) {
  const descendants = node.descendants;
  if (!descendants || typeof descendants !== "object") return null;
  const out = {};
  let droppedFields = 0;
  for (const [targetId, fields] of Object.entries(descendants)) {
    const mappedId = context.byId.get(targetId) ?? targetId;
    const patch = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (key === "content") { patch.content = String(value); continue; }
      if (key === "fill") {
        const css = resolveReference(value, context.refs, ledger);
        patch.style = patch.style ? `${patch.style};color:${css}` : `color:${css}`;
        continue;
      }
      // `icon` swaps one instance's glyph. Both halves of the pair move
      // together: `data-icon` is the name, `children` is the geometry. Writing
      // the name alone would leave the master's paths in place, and writing the
      // geometry alone would leave the master's name in place — a file whose
      // label disagrees with its own drawing.
      //
      // This was a `content` patch once. `content` is text, and text inside an
      // `<svg>` that is not inside a `<text>` draws nothing at all: eight tiles
      // on the home page rendered as eight empty white boxes, and no ledger line
      // said so.
      if (key === "icon") {
        patch["data-icon"] = String(value);
        patch.children = glyphFor(value, ledger);
        count(ledger.converted, "iconOverrides");
        continue;
      }
      if (key === "enabled") { patch["data-hidden"] = value ? "false" : "true"; continue; }
      if (key === "visible") { patch["data-hidden"] = value ? "false" : "true"; continue; }
      const css = OVERRIDE_CSS[key];
      if (css) {
        const rendered = cssValueFor(css, value, context, ledger);
        if (rendered) patch.style = patch.style ? `${patch.style};${css}:${rendered}` : `${css}:${rendered}`;
        continue;
      }
      droppedFields += 1;
      count(ledger.unmapped, `override:${key}`);
    }
    if (Object.keys(patch).length) out[mappedId] = patch;
  }
  ledger.components.overrideFieldsDropped += droppedFields;
  if (Object.keys(out).length) ledger.components.overridesApplied += 1;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

const OVERRIDE_CSS = {
  fontSize: "font-size",
  fontWeight: "font-weight",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textAlign: "text-align",
  width: "width",
  height: "height",
  cornerRadius: "border-radius",
  clip: "overflow",
  opacity: "opacity",
};

function cssValueFor(property, value, context, ledger) {
  if (property === "overflow") return value ? "hidden" : "visible";
  if (property === "border-radius") return value >= 9999 ? "9999px" : `${value}px`;
  if (["width", "height", "font-size", "letter-spacing", "cornerRadius"].includes(property)) return `${value}px`;
  if (property === "opacity") return String(value);
  return resolveReference(String(value), context.refs, ledger);
}

// -- the import ---------------------------------------------------------------

/**
 * @param {string} text the `.pen` file
 * @param {object} options `{ title, fallbackTitle }`
 *   `title` wins, then the document's own `name`, then `fallbackTitle`. The last one exists
 *   because this function is handed text and cannot know what the file is called; the verb
 *   that read it supplies the name. Before it, a `.pen` with no `name` was titled
 *   "imported", which is a title that says only that something happened.
 * @returns {{ html: string, ledger: object, diagnostics: Array }}
 */
export function importPen(text, options = {}) {
  const ledger = createLedger();
  temporaryLedger = ledger;
  const json = parsePen(text);
  ledger.version = json.version ?? null;
  if (ledger.version && !PEN_VERSION_SUPPORTED.includes(ledger.version)) {
    ledger.notes.push(`version ${ledger.version} is newer than this reader was written against (${PEN_VERSION_SUPPORTED.join(", ")})`);
  }

  const { tokens, refs } = tokensFromVariables(json.variables, ledger);
  const { byNode: ids, byId } = idLookup(json);
  const renamed = [...ids.entries()].filter(([node, to]) => node.id !== to).length;
  if (renamed > 0) count(ledger.converted, "renumberedIds", renamed);

  const context = { ids, byId, refs, tokens };
  const pages = [];
  for (const artboard of json.children) {
    if (artboard.type !== "frame") {
      count(ledger.lost, `topLevelType:${artboard.type}`);
      continue;
    }
    const dataType = artboard.reusable === true ? "component" : "page";
    const id = ids.get(artboard) ?? artboard.id ?? `page-${pages.length}`;
    const attrs = [`data-id="${escapeAttr(id)}"`, `data-type="page"`];
    if (artboard.name) {
      attrs.push(`data-name="${escapeAttr(artboard.name)}"`);
      if (/组件库|component library/i.test(artboard.name)) {
        attrs.push('data-library="true"');
        count(ledger.converted, "libraryPageByName");
      }
    }
    if (Number.isFinite(artboard.x) || Number.isFinite(artboard.y)) {
      attrs.push(`data-canvas="${Math.round(artboard.x ?? 0)},${Math.round(artboard.y ?? 0)}"`);
    }
    attrs.push(`style="${escapeAttr(pageStyle(artboard, refs, ledger))}"`);

    const children = (artboard.children ?? [])
      .map((child) => renderNode(child, refs, ledger, childContext(artboard, context)))
      .join("\n");
    pages.push(`  <section ${attrs.join(" ")}>\n${children}\n  </section>`);
    ledger.pages += 1;
  }

  if (pages.length === 0) {
    const failure = new Error("The .pen file has no top-level frame, so it has no artboard to import.");
    failure.code = "pen/no-pages";
    throw failure;
  }

  ledger.components.found = countReusable(json);
  ledger.components.instances = countInstances(json);

  const tokenBlock = [...tokens.values()].map((t) => `${t.name}:${t.value}`).join(";");
  const head = [
    "  <meta charset=\"utf-8\">",
    `  <title>${escapeText(options.title ?? json.name ?? options.fallbackTitle ?? "imported")}</title>`,
    '  <meta name="design-schema" content="3.0">',
    // The base rules come first, in the same block as the tokens. Without them
    // the imported file means something else in a plain browser than it does in
    // the canvas: `width` becomes the content width, and every label grows the
    // height of its default margin. See `lib/base-css.mjs`.
    `  <style>${baseCss()}\n    :root{${tokenBlock}}</style>`,
    '  <style>section[data-type="page"]{ margin:0 0 24px }</style>',
  ].join("\n");

  const html = [
    "<!doctype html>",
    "<html lang=\"zh\">",
    "<head>",
    head,
    "</head>",
    "<body>",
    pages.join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n");

  // Round trip through the real parser and serializer, so the output is
  // canonical by construction rather than by hope.
  const doc = prepareBuiltDocument(parse(html));
  return { html: serializeCanonical(doc), ledger, diagnostics: doc.diagnostics ?? [] };
}

/**
 * An artboard's own style becomes the page box's style.
 *
 * The values go through the same normalizers the per-node path uses, so an
 * imported file is canonical by construction and its first `format --check`
 * passes. A reader that writes its own spelling is a reader that produces files
 * whose first edit shows up as a formatting diff.
 */
/**
 * An artboard's own style becomes the page box's style.
 *
 * The artboard IS a frame, so it goes through the same mapping a frame does.
 * Mapping only its fill and size is the mistake that hides a whole screen class:
 * a modal artboard carries `justifyContent: "end"` so its sheet sits at the
 * bottom, and dropping that leaves the sheet at the top of an otherwise empty
 * page — with the same total height, which is what makes it hard to notice.
 */
function pageStyle(artboard, refs, ledger) {
  const style = new Map();
  for (const part of styleFromNode(artboard, refs, ledger, { parentIsColumn: true }).split(";")) {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    style.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
  }
  // The page box is positioned by the canvas, so it keeps its own size, and it
  // clips what overflows.
  if (artboard.width !== undefined) style.set("width", `${Number(artboard.width)}px`);
  if (artboard.height !== undefined) style.set("height", `${Number(artboard.height)}px`);
  style.set("overflow", "hidden");
  return orderedStyleText([...style.entries()], ledger);
}

function walkPen(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walkPen(child, visit);
}

function countReusable(json) {
  let n = 0;
  for (const artboard of json.children) walkPen(artboard, (node) => { if (node.reusable === true) n += 1; });
  return n;
}

function countInstances(json) {
  let n = 0;
  for (const artboard of json.children) walkPen(artboard, (node) => { if (node.type === "ref") n += 1; });
  return n;
}

/** A one-line summary, for a CLI to print. */
export function ledgerLine(ledger) {
  const lost = Object.entries(ledger.lost);
  const unmapped = Object.entries(ledger.unmapped);
  const parts = [
    `${ledger.pages} pages`,
    `${ledger.nodes} elements`,
    `${ledger.components.found} components`,
    `${ledger.components.instances} instances`,
    `${ledger.components.overridesApplied} with overrides`,
  ];
  if (lost.length) parts.push(`lost: ${lost.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (unmapped.length) parts.push(`unmapped: ${unmapped.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  return parts.join(" · ");
}
