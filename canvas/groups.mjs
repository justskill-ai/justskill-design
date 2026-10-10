/**
 * canvas/groups.mjs — the inspector's sections, rows and editors.
 *
 * Pure data and pure decisions, no DOM: which section a property belongs to, in
 * what order the sections are drawn, which two properties share a row, and which
 * kind of control a property gets. `app.mjs` draws what this returns — which is
 * why every claim here can be checked by `node --test` instead of by looking at
 * a panel and counting.
 *
 * Two rules make this more than a hand-written list:
 *
 *   1. The property set is `CSS_ALLOWED` from `lib/table.mjs` — the same table
 *      the validator uses. A property missing from these sections is not lost:
 *      it falls into `Other`, and a test holds every allowed property to a
 *      section, so the fallback stays a safety net instead of a dumping ground.
 *   2. The control is chosen from the *declared grammar*, not from the spelling
 *      of the current value. The first inspector tested the value with a regular
 *      expression — `#rrggbb` meant a colour picker, `-?\d+(px|%)?` meant a
 *      scrubber — which is a guess that breaks the moment a length is written
 *      `calc(...)` or a colour arrives as `var(--color-ink)`.
 */

import { CSS_ORDER, specFor } from "../lib/table.mjs";

/**
 * The sections, in the order they are drawn.
 *
 * `members` is ordered by the format's own property order (`CSS_ORDER`), not by
 * preference: the panel then reads in the same direction as the file it edits,
 * and a property that moves in the format moves here too.
 */
export const GROUPS = [
  { id: "layout", label: "Layout", members: ["display", "flex-direction", "flex-wrap", "align-items", "justify-content", "align-self", "flex", "flex-shrink", "gap"] },
  { id: "position", label: "Position", members: ["position", "left", "top"] },
  { id: "size", label: "Size", members: ["width", "height", "min-width", "min-height", "max-width", "max-height"] },
  { id: "spacing", label: "Spacing", members: ["padding", "margin"] },
  { id: "appearance", label: "Appearance", members: ["opacity", "border-radius", "overflow"] },
  { id: "fill", label: "Fill", members: ["background-color", "background-image", "background-size", "background-position"] },
  { id: "stroke", label: "Stroke", members: ["border", "border-width", "border-style", "border-color", "outline", "outline-offset"] },
  { id: "effects", label: "Effects", members: ["box-shadow"] },
  { id: "text", label: "Text", members: ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "color", "text-align", "text-transform", "white-space"] },
  { id: "image", label: "Image", members: ["object-fit"] },
];

/** The section an unknown property lands in. Never a section anyone aims for. */
export const OTHER = { id: "other", label: "Other", members: [] };

/**
 * Two properties that are read as a pair, and are therefore drawn on one row.
 *
 * Only pairs whose members both appear: a lone `height` is a row of its own, not
 * half a row with an empty box beside it.
 */
export const PAIRS = [
  ["width", "height"],
  ["min-width", "min-height"],
  ["max-width", "max-height"],
  ["left", "top"],
];

/**
 * The rows to draw for the properties an element actually has.
 *
 * @param {Iterable<string>} properties
 * @returns {Array<{ id: string, label: string, rows: string[][] }>}
 */
export function groupedFields(properties) {
  const present = new Set(properties);
  const claimed = new Set();
  const sections = [];

  for (const group of GROUPS) {
    const members = group.members.filter((property) => present.has(property));
    if (members.length === 0) continue;
    for (const property of members) claimed.add(property);
    sections.push({ id: group.id, label: group.label, rows: pairUp(members) });
  }

  const orphans = [...present].filter((property) => !claimed.has(property));
  if (orphans.length > 0) {
    // Anything the format allows and these sections do not name — a property
    // added to `CSS_ALLOWED` after this table was written. It is drawn last, and
    // it is drawn: a property the inspector cannot reach is a property a person
    // has to edit by hand.
    sections.push({ id: OTHER.id, label: OTHER.label, rows: pairUp(sortByFormat(orphans)) });
  }
  return sections;
}

function pairUp(members) {
  const rows = [];
  const used = new Set();
  for (const property of members) {
    if (used.has(property)) continue;
    const partner = partnerOf(property, members);
    if (partner) {
      rows.push([property, partner]);
      used.add(partner);
    } else {
      rows.push([property]);
    }
    used.add(property);
  }
  return rows;
}

function partnerOf(property, members) {
  for (const [a, b] of PAIRS) {
    if (a === property && members.includes(b)) return b;
    if (b === property && members.includes(a)) return a;
  }
  return null;
}

/** `CSS_ORDER` is the format's canonical order; unknown names go last, sorted. */
function sortByFormat(properties) {
  return [...properties].sort((a, b) => {
    const ia = CSS_ORDER.indexOf(a);
    const ib = CSS_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a < b ? -1 : 1;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * Which control a property gets.
 *
 *   segmented — an enum of three values or fewer, drawn as buttons: two or three
 *               short alternatives are faster to hit than a dropdown
 *   select    — a longer enum, where buttons would be a wall of text
 *   length    — a number with a unit, draggable
 *   number    — a bare number, draggable
 *   color     — a colour, with a swatch
 *   text      — everything with structure inside it (`border`, `box-shadow`,
 *               `flex`, `font-family`, …), where a free-text field is the only
 *               editor that cannot lose a value it does not understand
 */
export function controlFor(property) {
  const spec = specFor(property);
  if (!spec) return "text";
  switch (spec.kind) {
    case "enum":
    case "keyword-set":
      return spec.values.length <= 3 ? "segmented" : "select";
    case "length":
      return "length";
    case "number":
      return "number";
    case "color":
      return "color";
    default:
      return "text";
  }
}

/** The declared values of an enum property, or an empty list. */
export function valuesFor(property) {
  const spec = specFor(property);
  return Array.isArray(spec?.values) ? [...spec.values] : [];
}

/**
 * A value the scrubber can read: a number, and nothing else.
 *
 * The first version of this decided by property name, so every `length` field
 * got a scrub handle — including `gap: var(--space-md)`, `width: fit-content`
 * and `padding: 0 0 24px 0`. Dragging one of those by a pixel wrote `1`, and the
 * token, the keyword or the four-value shorthand was gone: a silent loss with a
 * gesture that looked like a nudge. A scrubber only makes sense on a value it
 * can add a number to, and this is what that means.
 */
const SCRUBBABLE = /^-?\d+(\.\d+)?(px|%|em|rem|vh|vw)?$/;

/** The kinds whose values are numbers, so dragging one is meaningful. */
const NUMERIC_KINDS = new Set(["length", "number", "font-weight", "line-height"]);

/** Is this a bare number with an optional unit? */
export function isNumericValue(value) {
  return SCRUBBABLE.test(String(value).trim());
}

/** Should this property's current value get a drag handle? */
export function scrubFor(property, value) {
  const spec = specFor(property);
  return Boolean(spec) && NUMERIC_KINDS.has(spec.kind) && isNumericValue(value);
}

/** What the format says this property may hold, for a placeholder or a tooltip. */
export function hintFor(property) {
  return specFor(property)?.hint ?? "";
}

/**
 * The bounds a numeric property declares, if it declares any.
 *
 * `opacity` is `0…1` in the table, and a field that lets you type `4` and then
 * reports an error is a field that already knew. The bounds go on the input.
 */
export function rangeFor(property) {
  const spec = specFor(property);
  return { min: spec?.min, max: spec?.max };
}
