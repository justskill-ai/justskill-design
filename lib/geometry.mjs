/**
 * lib/geometry.mjs — certainty-only geometric checks.
 *
 * Pure ESM. No `node:` imports. Runs in the browser.
 *
 * There is no layout engine here, and that is deliberate. A second implementation
 * of flexbox would disagree with the browser in the corners, and a check that
 * cries wolf is worse than a check that stays quiet, because people stop reading
 * it. So this module models only the part of flexbox that is arithmetic. Every
 * quantity it cannot know is `UNKNOWN` and travels upward, and the checks that
 * need it report nothing.
 *
 * What it cannot know: the width of a run of text, the intrinsic size of an
 * image or a glyph, and the size of an instance whose component it has not
 * expanded. A design with much text therefore produces few findings — by design,
 * not by oversight.
 *
 * What it does not check: overflow along the **cross** axis. A 500px child in a
 * 200px column is not reported here, because the arithmetic answers "does the
 * main axis fit" and nothing more. The limit is inherited: `lib/geometry.mjs` in
 * the version 1 tree checks the main axis only, in the same words. The measured
 * pass in `canvas/app.mjs` does catch it, because it compares both axes of two
 * real boxes; on the command line this one stays quiet about it, which is the
 * direction to be wrong in.
 *
 * What it reads of `display`: only `none` and `flex`. `block` is a legal value
 * in the property table, and block layout is not flexbox — a `flex-direction` on
 * it is inert and `flex-shrink` does not apply to its children. A node whose
 * `display` is neither `flex` nor absent is therefore given no flex semantics at
 * all, rather than the wrong ones. See `laysOutWithFlex`.
 *
 * What it reads of `margin`: the main-axis pair, as part of the space a child
 * needs. A child with `margin-left: 50px` in a row occupies 50px more of the row
 * than its border box says, and leaving that out reported no overflow where a
 * browser draws one. The cross-axis pair is still not read.
 *
 * `docs/format-v3.md` §6 gives this prefix five codes and the severity
 * `warning`. A warning never blocks a write: `lib/validate.mjs` compares only
 * the diagnostics whose severity is `error`.
 *
 * The findings carry no `offset`, because they speak about layout rather than
 * about a position in the text. The diagnostic key is then
 * `code|""|target|message`, which is why §6 says `target` is the one part of
 * that key which cannot be dropped.
 */

import { getAttr, elementChildren, pagesOf, styleMapOf, nodePath } from "./parse.mjs";
import { expandBox, splitValueParts } from "./table.mjs";
import { resolveTokens } from "./tokens.mjs";

/** A quantity that needs a measurement to be known. */
const UNKNOWN = null;

const MAX_DEPTH = 64;

/**
 * How many findings of one code a report carries.
 *
 * A design that uses one faint token for secondary text produces that finding
 * once per text node — 92 of them on the reference file. All 92 are true, and
 * 92 identical lines is how a report stops being read. The first few show the
 * pattern and the summary already counts the rest.
 *
 * Exported so `lib/validate.mjs` bounds the contrast findings by the same rule
 * rather than by a second copy of it.
 */
export const MAX_REPORTED_PER_CODE = 20;

/**
 * A sub-pixel overhang is rounding, not a defect. One pixel is the smallest
 * amount a reader could act on.
 */
export const MEASURED_TOLERANCE_PX = 1;

/**
 * Values of `overflow` that hide their content in a static deliverable.
 *
 * `auto` and `scroll` give a browser a scroll affordance, so the content is
 * reachable on screen. The deliverable is a still, and there the content is
 * gone. That difference is exactly what this format refuses to leave silent.
 */
const CLIPPING_OVERFLOW = new Set(["hidden", "auto", "scroll"]);

/**
 * The parent context a child is measured against.
 *
 * `alignItems` belongs here because a child that declares no cross size is
 * stretched only when its parent says so. The default is `stretch`, and
 * `align-items: flex-start` — which the pen reader writes on every row it
 * imports, 297 times in the reference file — turns it off. Reading it from the
 * child's own `align-self` alone overstated the cross size of every such child,
 * which made the checks quieter than they should be.
 */
/** The `align-items` of a container. CSS stretches by default. */
function alignItemsOf(style) {
  return style.get("align-items") || "stretch";
}

/**
 * True when the parent takes this node out of layout.
 *
 * `data-hidden="true"` is the format's own way to say this, and `docs/format-v3.md`
 * defines it as equivalent to `display:none`. Reading only the first of the two
 * meant a node the browser never draws was still counted against its parent: a
 * hidden 400px child in a 100px row reported an overflow that cannot happen.
 */
function isHidden(node, style) {
  if (getAttr(node, "data-hidden") === "true") return true;
  return style.get("display") === "none";
}

/** True when a node's `display` gives its children flex layout. */
function laysOutWithFlex(style) {
  const display = style.get("display");
  return display === undefined || display === "flex";
}

/**
 * The children that take part in this node's layout.
 *
 * A hidden child is not laid out. An absolutely positioned child is out of flow,
 * so it takes no space in its parent and is checked separately by
 * `checkAbsolute`. Both rules were applied in two places and drifted apart from
 * `measure`, which is why they live here now.
 */
function layoutChildren(node) {
  const out = [];
  for (const child of elementChildren(node)) {
    const style = styleMapOf(child);
    if (isHidden(child, style)) continue;
    if (style.get("position") === "absolute") continue;
    out.push(child);
  }
  return out;
}

/**
 * The content box an absolutely positioned descendant resolves against.
 *
 * The rule is CSS's: the nearest ancestor that is positioned. The page is added
 * to it because a page is the surface the deliverable draws, and
 * `docs/format-v3.md` forbids positioning one (`structure/page-position`) — so a
 * page can never become a containing block by being positioned, and an absolutely
 * positioned box with no positioned ancestor would otherwise have no base at all.
 *
 * A static wrapper that is not a page does not become a base, which is the case
 * that used to be got wrong: with a relative grandparent, the browser lays the box
 * out against the grandparent, not against the static parent in between.
 */
function containingBoxOf(node, style, box, inherited) {
  const position = style.get("position");
  if (position === "relative" || position === "absolute") return box.content;
  if (getAttr(node, "data-type") === "page") return box.content;
  return inherited;
}

/**
 * The context a node is measured and checked against.
 *
 * `containing` is the box an absolutely positioned descendant resolves `left` and
 * `top` against. It is not the same box as `content`, and a node that is not a
 * base passes its own ancestor's value down unchanged.
 */
function contextOf(node, box, containing) {
  const style = styleMapOf(node);
  return {
    content: box.content,
    row: style.get("flex-direction") === "row",
    alignItems: alignItemsOf(style),
    containing: containingBoxOf(node, style, box, containing),
  };
}

/** Types whose size comes from their own declarations, or not at all. */
const MEASURABLE = new Set(["page", "frame", "component"]);

// -- values ------------------------------------------------------------------

/**
 * A resolved length in pixels, or `UNKNOWN`.
 *
 * `basis` is the containing size that a percentage is measured against. A
 * percentage with no basis is not knowable.
 */
function toPx(value, basis) {
  if (value === UNKNOWN || value === undefined || value === null) return UNKNOWN;
  const raw = String(value).trim();
  if (raw === "" || raw === "auto") return UNKNOWN;
  const match = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(raw);
  if (!match) return UNKNOWN;
  const number = Number(match[1]);
  const unit = match[2] || "px";
  if (unit === "px") return number;
  if (unit === "%") return typeof basis === "number" ? (number / 100) * basis : UNKNOWN;
  return UNKNOWN;
}

/** Resolve the token chain, then read the result as a length. */
function lengthOf(value, tokens, basis) {
  if (value === undefined) return UNKNOWN;
  return toPx(resolveTokens(String(value), tokens), basis);
}

/** The four values of a box property, resolved, or `UNKNOWN`. */
function boxOf(raw, tokens, basisW, basisH) {
  const parts = expandBox(splitValueParts(resolveTokens(String(raw), tokens)));
  const top = toPx(parts[0], basisH);
  const right = toPx(parts[1], basisW);
  const bottom = toPx(parts[2], basisH);
  const left = toPx(parts[3], basisW);
  if ([top, right, bottom, left].some((value) => value === UNKNOWN)) return UNKNOWN;
  return { top, right, bottom, left };
}

/**
 * Padding plus border, as the inset that separates the border box from the
 * content box.
 */
function insetOf(style, tokens, basisW, basisH) {
  let padX = 0;
  let padY = 0;
  let borderX = 0;
  let borderY = 0;

  const padding = style.get("padding");
  if (padding !== undefined) {
    const box = boxOf(padding, tokens, basisW, basisH);
    if (box === UNKNOWN) return UNKNOWN;
    padX = box.left + box.right;
    padY = box.top + box.bottom;
  }

  const borderWidth = style.get("border-width");
  if (borderWidth !== undefined) {
    const box = boxOf(borderWidth, tokens, basisW, basisH);
    if (box === UNKNOWN) return UNKNOWN;
    borderX = box.left + box.right;
    borderY = box.top + box.bottom;
  } else {
    const border = style.get("border");
    if (border !== undefined) {
      // `1px solid #e5e7eb` — the length is the width on every side.
      const parts = splitValueParts(resolveTokens(String(border), tokens));
      const width = parts.map((part) => toPx(part, UNKNOWN)).find((value) => value !== UNKNOWN);
      if (width === undefined) return UNKNOWN;
      borderX = width * 2;
      borderY = width * 2;
    }
  }

  return { padX, padY, borderX, borderY, x: padX + borderX, y: padY + borderY };
}

/** The two gaps, in CSS order: row gap first. `gap` alone sets both. */
function gapsOf(style, tokens) {
  const raw = style.get("gap");
  if (raw === undefined) return { row: 0, column: 0 };
  const parts = splitValueParts(resolveTokens(String(raw), tokens));
  const row = toPx(parts[0], UNKNOWN);
  const column = parts.length > 1 ? toPx(parts[1], UNKNOWN) : row;
  if (row === UNKNOWN || column === UNKNOWN) return UNKNOWN;
  return { row, column };
}

/**
 * The margin a child adds to the main axis, in CSS order: leading then trailing.
 *
 * `margin` is a formal member of the property table — `docs/format-v3.md` §6
 * keeps it because pen's export nudges a focus ring with `margin:-0.5px 0 0 0`,
 * and the eval snippets space a card with `margin:16px 0`. A margin is outside
 * the border box, so a child that reserves 50px to its left needs 50px more of
 * the row than its own width says. Leaving it out lost a real overflow: two
 * 150px children in a 300px row report nothing, and adding `margin-left:50px` to
 * the second one makes the browser scroll to 350px.
 *
 * A percentage margin resolves against the containing block's **width** on every
 * side, including top and bottom — not against the height. Verified against the
 * browser, and the reason `basisW` is the only basis here.
 *
 * `auto` is UNKNOWN: an auto margin absorbs whatever space is free, so it has no
 * size to add. Negative values are legal and keep their sign.
 *
 * Only the shorthand is read, because only the shorthand is allowed: `margin-top`
 * and its three siblings are in `REJECTED_PROPERTIES`. A document that uses one
 * really does overflow in a browser, and this module says nothing about it —
 * `style/rejected-property` is the finding that document earns.
 */
function mainMarginsOf(style, tokens, row, basisW) {
  const raw = style.get("margin");
  if (raw === undefined) return { before: 0, after: 0 };
  const parts = expandBox(splitValueParts(resolveTokens(String(raw), tokens)));
  const before = toPx(row ? parts[3] : parts[0], basisW);
  const after = toPx(row ? parts[1] : parts[2], basisW);
  if (before === UNKNOWN || after === UNKNOWN) return UNKNOWN;
  return { before, after };
}

/** True when the node grows along the parent's main axis. */
function growsAlongMain(style) {
  const flex = style.get("flex");
  if (flex === undefined) return false;
  const parts = splitValueParts(String(flex));
  const grow = Number(parts[0]);
  return Number.isFinite(grow) && grow > 0;
}

/**
 * True when the node may shrink along the parent's main axis.
 *
 * This is the rule that keeps the checks honest. A flex item shrinks by default,
 * so three `width:100%` children in a row do not overflow — they shrink to a
 * third each. Only a child that refuses to shrink has a size the container
 * cannot absorb, and only that size can be counted against the frame.
 *
 * Without this, a tabs strip of three full-width children reported 981px of
 * content in a 327px frame. The report was certain, and it was wrong.
 */
function shrinksAlongMain(style, tokens) {
  const explicit = style.get("flex-shrink");
  if (explicit !== undefined) {
    const value = toPx(resolveTokens(String(explicit), tokens), UNKNOWN);
    return value !== 0;
  }
  const flex = style.get("flex");
  if (flex !== undefined) {
    const parts = splitValueParts(resolveTokens(String(flex), tokens));
    const shrink = Number(parts[1]);
    if (Number.isFinite(shrink)) return shrink !== 0;
  }
  return true;
}

// -- the measurement ---------------------------------------------------------

/**
 * The border box and the content box of one node, in pixels.
 *
 * An axis that hugs its content is computed from the children. An axis that is
 * `UNKNOWN` stays unknown and suppresses every check that depends on it.
 *
 * @param {object} node a parsed element
 * @param {{ content: { w: number|null, h: number|null }, row: boolean }} parent
 * @param {Map} tokens name to `{ value }`
 * @param {number} depth
 */
function measure(node, parent, tokens, depth) {
  const unknown = { w: UNKNOWN, h: UNKNOWN, content: { w: UNKNOWN, h: UNKNOWN } };
  if (!node || depth > MAX_DEPTH) return unknown;

  const style = styleMapOf(node);
  const parentContent = parent?.content ?? { w: UNKNOWN, h: UNKNOWN };
  const parentIsRow = parent?.row === true;

  const inset = insetOf(style, tokens, parentContent.w, parentContent.h);
  if (inset === UNKNOWN) return unknown;

  const type = getAttr(node, "data-type") || "frame";
  const measurable = MEASURABLE.has(type);
  const flexContainer = laysOutWithFlex(style);
  const positioned = style.get("position") === "absolute";

  const children = layoutChildren(node);

  const gaps = gapsOf(style, tokens);
  const gapCount = Math.max(0, children.length - 1);

  const flexDirection = style.get("flex-direction");
  const row = flexDirection ? flexDirection === "row" : false;
  const nodeAlign = alignItemsOf(style);
  const alignSelf = style.get("align-self");
  const parentAligns = (parent?.alignItems ?? "stretch") === "stretch";
  // An absolutely positioned box is out of flow: `align-items` and `align-self`
  // do not reach it, so it never stretches. Letting it stretch read the parent's
  // content width as its own — 300px for an empty box the browser draws at 0.
  const stretches =
    !positioned && (alignSelf === "stretch" || (alignSelf === undefined && parentAligns && measurable));
  // `flex` does not apply to an out-of-flow box either.
  const grows = growsAlongMain(style) && !positioned;

  /**
   * The stated size of one axis.
   *
   * `undefined` means "this axis hugs its content". `UNKNOWN` means the value
   * exists but cannot be read.
   */
  const stated = (property, basis, isMainAxis) => {
    const raw = style.get(property);
    if (raw === undefined) return undefined;
    const text = resolveTokens(String(raw), tokens);
    if (text === "fit-content" || text === "max-content" || text === "min-content") return undefined;
    if (text === "100%" && isMainAxis && growsAlongMain(style)) return basis;
    const value = toPx(text, basis);
    return value === UNKNOWN ? UNKNOWN : value;
  };

  const minW = lengthOf(style.get("min-width"), tokens, parentContent.w);
  const maxW = lengthOf(style.get("max-width"), tokens, parentContent.w);
  const minH = lengthOf(style.get("min-height"), tokens, parentContent.h);
  const maxH = lengthOf(style.get("max-height"), tokens, parentContent.h);

  /**
   * The stated size of one axis, after its minimum and maximum.
   *
   * CSS applies the maximum first and the minimum second, so a minimum wins over
   * a maximum. That is the same order `checkAxisConflict` describes in its hint,
   * and the reverse of what this function used to do: for
   * `width:100px;min-width:120px;max-width:80px` it answered 80 where the browser
   * draws 120. The module reported the conflict correctly and then measured the
   * losing side of it.
   */
  const clamp = (value, min, max) => {
    if (value === UNKNOWN) return UNKNOWN;
    let out = value;
    if (typeof max === "number") out = Math.min(out, max);
    if (typeof min === "number") out = Math.max(out, min);
    return out;
  };

  // Width is the main axis exactly when the parent lays its children in a row.
  const fillW = parentIsRow ? grows : stretches;
  const fillH = parentIsRow ? stretches : grows;

  let ownW = stated("width", parentContent.w, parentIsRow);
  let ownH = stated("height", parentContent.h, !parentIsRow);
  if (ownW === undefined && (fillW || measurable === false)) {
    ownW = fillW ? parentContent.w : UNKNOWN;
  }
  if (ownH === undefined && (fillH || measurable === false)) {
    ownH = fillH ? parentContent.h : UNKNOWN;
  }

  const known = (value) => (typeof value === "number" ? value : UNKNOWN);

  /**
   * Whether this node's axes can be hugged at all.
   *
   * A node that does not lay out with flex is not sized by the flex algorithm, so
   * its content-derived size is a block-layout question this module does not
   * answer. A stated `width` or `height` on the same node is still read — only the
   * hug is withdrawn.
   */
  const hugIsModelled = measurable && flexContainer;

  /**
   * `flex-wrap: wrap` makes the cross size a measurement.
   *
   * The cross size is the number of lines, and the number of lines depends on the
   * available main size, which is not a property of this node. Two 200x60 children
   * in a wrapping row 300px wide are two lines and 120px tall; the same row with no
   * stated width is one line and 60px. Summing them reports 60 for the first and
   * misses a real clip — so the cross axis is UNKNOWN instead.
   *
   * The main axis is unaffected: a container that hugs its main axis is exactly as
   * long as its children need, so nothing wraps and the sum is right.
   */
  const wraps = style.get("flex-wrap") === "wrap";
  const crossAxisIsMeasured = wraps;

  const hugW = () => {
    if (!hugIsModelled) return UNKNOWN;
    if (crossAxisIsMeasured && !row) return UNKNOWN;
    let total = 0;
    for (const child of children) {
      const box = measure(child, { content: { w: UNKNOWN, h: known(ownH) }, row, alignItems: nodeAlign }, tokens, depth + 1);
      if (box.w === UNKNOWN) return UNKNOWN;
      total = row ? total + box.w : Math.max(total, box.w);
    }
    if (!row) return total + inset.x;
    if (gaps === UNKNOWN) return UNKNOWN;
    return total + gaps.column * gapCount + inset.x;
  };

  const hugH = () => {
    if (!hugIsModelled) return UNKNOWN;
    if (crossAxisIsMeasured && row) return UNKNOWN;
    let total = 0;
    for (const child of children) {
      const box = measure(child, { content: { w: known(ownW), h: UNKNOWN }, row, alignItems: nodeAlign }, tokens, depth + 1);
      if (box.h === UNKNOWN) return UNKNOWN;
      total = row ? Math.max(total, box.h) : total + box.h;
    }
    if (row) return total + inset.y;
    if (gaps === UNKNOWN) return UNKNOWN;
    return total + gaps.row * gapCount + inset.y;
  };

  // The cross axis comes first: measuring the children needs it, and it never
  // depends on the main axis. On a row the cross axis is the height.
  if (row) {
    if (ownH === undefined) ownH = clamp(hugH(), minH, maxH);
    if (ownW === undefined) ownW = clamp(hugW(), minW, maxW);
  } else {
    if (ownW === undefined) ownW = clamp(hugW(), minW, maxW);
    if (ownH === undefined) ownH = clamp(hugH(), minH, maxH);
  }

  ownW = typeof ownW === "number" ? clamp(ownW, minW, maxW) : UNKNOWN;
  ownH = typeof ownH === "number" ? clamp(ownH, minH, maxH) : UNKNOWN;

  return {
    w: ownW,
    h: ownH,
    content: {
      w: ownW === UNKNOWN ? UNKNOWN : Math.max(0, ownW - inset.x),
      h: ownH === UNKNOWN ? UNKNOWN : Math.max(0, ownH - inset.y),
    },
  };
}

// -- the checks --------------------------------------------------------------

function finding(code, node, message, hint) {
  return {
    severity: "warning",
    code,
    target: getAttr(node, "data-id") || undefined,
    path: nodePath(node),
    message,
    hint,
  };
}

function checkAxisConflict(node, style, tokens, parentContent, findings) {
  const pairs = [
    ["min-width", "max-width", parentContent.w],
    ["min-height", "max-height", parentContent.h],
  ];
  for (const [minName, maxName, basis] of pairs) {
    const min = lengthOf(style.get(minName), tokens, basis);
    const max = lengthOf(style.get(maxName), tokens, basis);
    if (typeof min !== "number" || typeof max !== "number" || min <= max) continue;
    findings.push(
      finding(
        "geometry/axis-conflict",
        node,
        `${minName} (${min}px) is greater than ${maxName} (${max}px), so ${maxName} never applies`,
        `CSS resolves a conflicting minimum and maximum in favour of the minimum, so the ${maxName} of ${max}px is unreachable`,
      ),
    );
  }
}

/**
 * Report the main axis not fitting. The code says whether the spill is visible.
 *
 * `needed` is the space the children that cannot give way already require, and
 * `content` is what the box has.
 */
function reportMainOverflow(node, style, content, needed, findings) {
  const clipped = CLIPPING_OVERFLOW.has(style.get("overflow"));
  findings.push(
    finding(
      clipped ? "geometry/clipped" : "geometry/overflow",
      node,
      clipped
        ? `The children that cannot shrink need ${Math.round(needed)}px on the main axis but the frame has ${Math.round(content)}px and hides the rest, so the last of them is cut off`
        : `The children that cannot shrink need ${Math.round(needed)}px on the main axis but the frame only has ${Math.round(content)}px`,
      clipped
        ? "raise the frame's size, or change overflow to visible if the spill is intentional"
        : "widen the frame, shrink the children, or let the frame hug its content",
    ),
  );
}

function checkMainAxis(node, box, style, tokens, children, findings) {
  // Block layout is not flexbox: `flex-direction` is inert on it and its children
  // do not shrink. Running the flex arithmetic here reported an overflow for two
  // 80px children in a `display:block;flex-direction:row` box, which the browser
  // stacks vertically and draws without overflowing. Rather than model block
  // layout — a second layout engine, and the thing this module refuses to be —
  // a node that does not lay out with flex is not checked on either axis.
  if (!laysOutWithFlex(style)) return;

  const flexDirection = style.get("flex-direction");
  const row = flexDirection === "row";
  const content = row ? box.content.w : box.content.h;
  if (content === UNKNOWN || children.length === 0) return;

  const gaps = gapsOf(style, tokens);
  if (gaps === UNKNOWN) return;
  const gap = row ? gaps.column : gaps.row;
  const gapCount = Math.max(0, children.length - 1);

  const sizes = [];
  for (const child of children) {
    const childStyle = styleMapOf(child);
    const childBox = measure(child, { content: box.content, row, alignItems: alignItemsOf(style) }, tokens, 0);
    const main = row ? childBox.w : childBox.h;
    if (main === UNKNOWN) return;
    // A margin sits outside the border box, so the space a child takes is its box
    // plus its leading and trailing margins.
    const margins = mainMarginsOf(childStyle, tokens, row, box.content.w);
    if (margins === UNKNOWN) return;
    sizes.push({
      main: main + margins.before + margins.after,
      grows: growsAlongMain(childStyle),
      shrinks: shrinksAlongMain(childStyle, tokens),
    });
  }

  const gapTotal = gap * gapCount;

  // A wrapping container puts its children on more than one line when their sum
  // is too large, so their sum is not the size of any line and cannot exceed
  // anything. Two 200px children in a wrapping 300px row wrap instead of
  // overflowing, and adding them up reports an overflow the browser never draws.
  //
  // What wrapping cannot fix is one child that is wider than a line. There is no
  // other line for it to go to, so the browser overflows: a single 400px child in
  // a wrapping 100px row scrolls to 400. Only that case is reported here.
  const wraps = style.get("flex-wrap") === "wrap";
  if (wraps) {
    const candidates = sizes.filter((entry) => !entry.grows);
    if (candidates.length === 0) return;
    const worst = candidates.reduce((a, b) => (b.main > a.main ? b : a));
    if (worst.main <= content) return;
    const clipped = CLIPPING_OVERFLOW.has(style.get("overflow"));
    findings.push(
      finding(
        clipped ? "geometry/clipped" : "geometry/overflow",
        node,
        clipped
          ? `A child needs ${Math.round(worst.main)}px on the main axis but the frame has ${Math.round(content)}px and hides the rest; a child that is wider than its line has nowhere to wrap to, so the end of it is cut off`
          : `A child needs ${Math.round(worst.main)}px on the main axis but the frame has ${Math.round(content)}px; a child that is wider than its line has nowhere to wrap to, so it spills`,
        "give the child a smaller size, or let the frame hug its content",
      ),
    );
    return;
  }

  const fillers = sizes.filter((entry) => entry.grows);
  const others = sizes.filter((entry) => !entry.grows);

  if (fillers.length > 0) {
    // A filling child has a flex basis of zero, so it has nothing to shrink and
    // it takes exactly the space the others leave. When they leave none, it gets
    // none — whether or not they shrink, because shrinking them only returns the
    // overrun, never more.
    const demanded = others.reduce((sum, entry) => sum + entry.main, 0) + gapTotal;
    if (content - demanded > 0) return;
    const fixed = others.reduce((sum, entry) => sum + entry.main, 0);
    findings.push(
      finding(
        "geometry/fill-collapsed",
        node,
        `No space is left on the main axis: the children that do not fill already need ${Math.round(fixed)}px of ${Math.round(content)}px, so the filling child gets nothing`,
        `reduce the fixed ${row ? "width" : "height"} of the siblings, or let one of them hug its content`,
      ),
    );
    return;
  }

  // Without a filler, the frame overflows only when the children that cannot
  // shrink already need more than it has. Every other child gives way, so
  // counting them would report a layout the browser never produces.
  const fixed = others.filter((entry) => !entry.shrinks);
  if (fixed.length === 0) return;
  const irreducible = fixed.reduce((sum, entry) => sum + entry.main, 0) + gapTotal;
  if (irreducible <= content) return;

  reportMainOverflow(node, style, content, irreducible, findings);
}

/**
 * An absolutely positioned box against the box it is actually positioned in.
 *
 * The base is the nearest ancestor that is **positioned**, not the parent. When
 * the parent is `static` and a grandparent is `position:relative`, the browser
 * lays the box out against the grandparent; comparing it with the static parent
 * reported a box 150px below a 50px-tall parent as leaving it, when the box was
 * sitting inside the grandparent exactly where it was asked to be.
 *
 * No positioned ancestor means the initial containing block, whose size is not in
 * the file. That is a measurement, so the check reports nothing.
 */
function checkAbsolute(node, style, tokens, containing, findings) {
  if (style.get("position") !== "absolute") return;
  if (containing.w === UNKNOWN || containing.h === UNKNOWN) return;

  const width = lengthOf(style.get("width"), tokens, containing.w);
  const height = lengthOf(style.get("height"), tokens, containing.h);
  const left = lengthOf(style.get("left"), tokens, containing.w);
  const top = lengthOf(style.get("top"), tokens, containing.h);
  if ([width, height, left, top].some((value) => typeof value !== "number")) return;

  const right = left + width;
  const bottom = top + height;
  if (left >= 0 && top >= 0 && right <= containing.w && bottom <= containing.h) return;

  findings.push(
    finding(
      "geometry/absolute-outside",
      node,
      `The box at (${Math.round(left)}, ${Math.round(top)}) sized ${Math.round(width)}x${Math.round(height)} is not fully inside the containing block of ${Math.round(containing.w)}x${Math.round(containing.h)}`,
      "an absolutely positioned node is clipped by an ancestor that clips, so part of it may be invisible",
    ),
  );
}

function walk(node, parent, tokens, findings, depth) {
  if (!node || depth > MAX_DEPTH) return;
  const style = styleMapOf(node);

  // A node the browser does not draw has no layout and no findings. Without this,
  // a `display:none` frame was still laid out and could report an overflow inside
  // a box that is not on the page.
  if (isHidden(node, style)) return;

  const children = layoutChildren(node);
  const box = measure(node, parent, tokens, depth);
  const parentContent = parent?.content ?? { w: UNKNOWN, h: UNKNOWN };
  // The base this node is checked against comes from its ancestors. A node that is
  // itself positioned establishes a base for its descendants, not for itself —
  // reading it for both made a positioned box its own containing block, and a box
  // can never be outside itself.
  const inherited = parent?.containing ?? { w: UNKNOWN, h: UNKNOWN };

  checkAxisConflict(node, style, tokens, parentContent, findings);
  checkAbsolute(node, style, tokens, inherited, findings);

  const type = getAttr(node, "data-type") || "frame";
  if (MEASURABLE.has(type)) checkMainAxis(node, box, style, tokens, children, findings);

  for (const child of elementChildren(node)) {
    walk(child, contextOf(node, box, inherited), tokens, findings, depth + 1);
  }
}

// -- public API --------------------------------------------------------------

/**
 * Geometric findings for a design document.
 *
 * @param {object} doc a parsed document
 * @param {Map} [tokens] the token map from `collectTokens`, so `var(--x)` resolves
 * @returns {Array<{ severity, code, target, path, message, hint }>}
 */
export function lintGeometry(doc, tokens) {
  const map = tokens instanceof Map ? tokens : new Map();
  const findings = [];
  const counts = new Map();

  for (const page of pagesOf(doc)) {
    walk(page, { content: { w: UNKNOWN, h: UNKNOWN }, row: false }, map, findings, 0);
  }

  // A pathological document can produce the same complaint once per node.
  // Report the first few and stay quiet about the rest.
  return findings.filter((entry) => {
    const seen = counts.get(entry.code) || 0;
    counts.set(entry.code, seen + 1);
    return seen < MAX_REPORTED_PER_CODE;
  });
}

/**
 * How far a measured child leaves its parent's measured content box, and which
 * code that is.
 *
 * This is the half of the canvas pass that can be checked without a browser. The
 * canvas divides both rectangles back to CSS pixels and reads the parent's
 * padding and border, which is the only part that needs a DOM; what to do with
 * the four numbers is arithmetic, so it lives here with the other arithmetic and
 * `test/geometry.test.mjs` can reach it.
 *
 * `content` is the parent's content box, `child` is the child's border box, both
 * relative to the same origin.
 *
 * Returns `null` when nothing overhangs, so a caller cannot report a finding it
 * did not earn. A fraction of a pixel is rounding, not a defect.
 */
export function overhangOf(child, content, options = {}) {
  const over = Math.max(
    -child.left,
    -child.top,
    child.left + child.width - content.width,
    child.top + child.height - content.height,
  );
  if (!(over > MEASURED_TOLERANCE_PX)) return null;
  const code = options.positioned
    ? "geometry/absolute-outside"
    : options.clips ? "geometry/clipped" : "geometry/overflow";
  return { over, code };
}

/** The measured box of every node, keyed by `data-id`. Exposed for tests. */
export function measureById(doc, tokens) {
  const map = tokens instanceof Map ? tokens : new Map();
  const out = new Map();
  const visit = (node, parent, depth) => {
    if (!node || depth > MAX_DEPTH) return;
    const style = styleMapOf(node);
    if (isHidden(node, style)) return;
    const box = measure(node, parent, map, depth);
    const id = getAttr(node, "data-id");
    if (id) out.set(id, box);
    for (const child of elementChildren(node)) {
      visit(child, contextOf(node, box, parent?.containing ?? { w: UNKNOWN, h: UNKNOWN }), depth + 1);
    }
  };
  for (const page of pagesOf(doc)) visit(page, { content: { w: UNKNOWN, h: UNKNOWN }, row: false }, 0);
  return out;
}
