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
 *   - `justifyContent`/`alignItems` become the CSS properties, with
 *     `space_between` becoming `space-between`
 *   - `fill` is `background-color`, except on text and icons, where it is `color`
 *   - `cornerRadius: 9999` becomes `50%`, a pill and a circle both
 *   - `clip` becomes `overflow:hidden`
 *   - `textGrowth: "fixed-width"` becomes `white-space:normal` on a fixed width
 *   - `reusable: true` becomes `data-type="component"`
 *   - `ref` becomes `data-type="instance"` with `data-ref`
 *   - `descendants` becomes `data-overrides`, keyed by the descendant's id
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
import { ICONS, ICON_LIBRARY, hasIcon, iconBody } from "../icons.mjs";
import { serializeCanonical } from "../serialize.mjs";
import { normalizeColor, normalizeValue, TOKEN_GROUP_UNIT, TOKEN_GROUPS } from "../table.mjs";

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
      cssValue = `"${String(value)}"`;
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

  if (node.layout === "none") {
    count(ledger.converted, "layoutNone");
  } else if (node.layout === "vertical") {
    set("display", "flex");
    set("flex-direction", "column");
    if (node.gap !== undefined) set("gap", `${node.gap}px`);
  } else if (node.layout === "horizontal") {
    set("display", "flex");
    set("flex-direction", "row");
    set("align-items", "center");
    if (node.gap !== undefined) set("gap", `${node.gap}px`);
  } else if (Array.isArray(node.children) && node.children.length) {
    set("display", "flex");
    set("flex-direction", "column");
  }

  if (node.justifyContent) set("justify-content", JUSTIFY[node.justifyContent] ?? node.justifyContent);
  if (node.alignItems) set("align-items", ALIGN[node.alignItems] ?? node.alignItems);

  if (node.padding !== undefined) {
    const padding = Array.isArray(node.padding) ? node.padding : [node.padding];
    set("padding", boxValue(padding));
  }

  if (node.width !== undefined) set("width", widthValue(node.width, node.textGrowth));
  if (node.height !== undefined) set("height", heightValue(node.height));
  if (node.width === undefined && node.height === undefined) set("width", "fit-content");

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
      const corners = node.cornerRadius.map((v) => (Number(v) >= 9999 ? "50%" : `${Number(v)}px`));
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
      set("border-radius", "50%");
      count(ledger.converted, "pillRadius");
    } else {
      set("border-radius", `${node.cornerRadius}px`);
    }
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

function boxValue(values) {
  return values.map((v) => (v === 0 ? "0" : `${v}px`)).join(" ");
}

/**
 * Pen writes sizes as a number, or as one of a few keywords.
 *
 * `fill_container` and `fill` both mean "take the parent's width"; `hug` means
 * "shrink to the content". Pen 2.19 renamed the first pair, and the newer name is
 * by far the more common one in a real file: 714 uses against a handful.
 */
function widthValue(width, textGrowth) {
  if (width === "fill_container" || width === "fill") return "100%";
  if (width === "hug" || width === "hug_contents") return "fit-content";
  if (width === null) return "fit-content";
  if (typeof width === "string") return width;
  return `${width}px`;
}

/** The same keywords apply to a height. */
function heightValue(height) {
  if (height === "fill_container" || height === "fill") return "100%";
  if (height === "hug" || height === "hug_contents") return "fit-content";
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
      set("background-size", "cover");
      set("background-position", "center");
      count(ledger.converted, "imageFills");
    } else {
      count(ledger.lost, "imageFillWithoutUrl");
    }
    if (fill.mode && fill.mode !== "fill") {
      count(ledger.unmapped, `fillMode:${fill.mode}`);
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
    const rotation = Number.isFinite(fill.rotation) ? fill.rotation + 180 : 180;
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
    color = node.stroke.fill ?? node.stroke.color ?? "#000000";
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
    set("font-family", value.startsWith("var(") ? value : String(node.fontFamily));
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
  const entries = [...map.entries()];
  entries.sort((a, b) => {
    const ai = STYLE_ORDER.indexOf(a[0]);
    const bi = STYLE_ORDER.indexOf(b[0]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return entries
    .map(([property, value]) => {
      if (property.startsWith("--")) return `${property}:${value}`;
      try {
        const normalized = normalizeValue(property, value);
        if (normalized.changed) count(ledger.converted, "normalizedValues");
        return `${property}:${normalized.value}`;
      } catch (error) {
        // The validator has the better message, and it will produce one. This
        // reader passes the value through rather than inventing a second error
        // vocabulary.
        ledger.notes.push(`${property}:${value} — ${error.message}`);
        return `${property}:${value}`;
      }
    })
    .join(";");
}

// -- nodes --------------------------------------------------------------------

const TYPE_MAP = { frame: "frame", text: "text", icon: "icon", rectangle: "shape", ellipse: "shape", ref: "instance" };

function dataTypeFor(node) {
  if (node.reusable === true) return "component";
  return TYPE_MAP[node.type] ?? null;
}

function tagFor(node, dataType) {
  if (dataType === "text") return "p";
  if (dataType === "icon") return "svg";
  if (dataType === "image") return "img";
  return "div";
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
    attrs.push(`data-kind="${node.type === "ellipse" ? "ellipse" : "rect"}"`);
  }
  if (dataType === "icon") {
    attrs.push(`data-icon="${escapeAttr(node.icon ?? "circle")}"`);
    attrs.push(`data-icon-library="${escapeAttr(node.library ?? "lucide")}"`);
  }
  if (dataType === "instance") {
    const ref = context.byId.get(node.ref) ?? node.ref;
    attrs.push(`data-ref="${escapeAttr(ref ?? "")}"`);
    const overrides = overridesFor(node, context, ledger);
    if (overrides) attrs.push(`data-overrides='${escapeAttr(overrides)}'`);
  }
  const childContext = {
    ...context,
    glyph: dataType === "icon",
    text: dataType === "text",
  };
  const style = styleFromNode(node, refs, ledger, childContext);
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

  const children = node.children.map((child) => renderNode(child, refs, ledger, context)).join("\n");
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
  const name = String(node.icon ?? "");
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
      if (key === "icon") { patch.content = String(value); continue; }
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
  if (property === "border-radius") return value >= 9999 ? "50%" : `${value}px`;
  if (["width", "height", "font-size", "letter-spacing", "cornerRadius"].includes(property)) return `${value}px`;
  if (property === "opacity") return String(value);
  return resolveReference(String(value), context.refs, ledger);
}

// -- the import ---------------------------------------------------------------

/**
 * @param {string} text the `.pen` file
 * @param {object} options `{ title }`
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

    const children = (artboard.children ?? []).map((child) => renderNode(child, refs, ledger, context)).join("\n");
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
    `  <title>${escapeText(options.title ?? json.name ?? "imported")}</title>`,
    '  <meta name="design-schema" content="3.0">',
    `  <style>${tokenBlock ? `:root{${tokenBlock}}` : "/* no variables in the source file */"}</style>`,
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
function pageStyle(artboard, refs, ledger) {
  const style = new Map();
  if (artboard.width !== undefined) style.set("width", widthValue(artboard.width));
  if (artboard.height !== undefined) style.set("height", heightValue(artboard.height));
  if (artboard.fill && typeof artboard.fill === "string") {
    style.set("background-color", colourValue(resolveReference(artboard.fill, refs, ledger), ledger));
  }
  if (artboard.cornerRadius !== undefined) {
    const radius = Array.isArray(artboard.cornerRadius) ? artboard.cornerRadius[0] : artboard.cornerRadius;
    if (Number(radius) >= 9999) style.set("border-radius", "50%");
    else style.set("border-radius", `${Number(radius)}px`);
  }
  style.set("overflow", "hidden");
  return [...style.entries()].map(([p, v]) => `${p}:${v}`).join(";");
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
