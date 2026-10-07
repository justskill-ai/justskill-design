/**
 * Byte-exact interval arithmetic.
 *
 * One rule every caller depends on: `applyEdits` never drifts. Edits are sorted
 * by `start` descending and spliced from the end of the text backwards, so
 * replacing an earlier range can never move a later one.
 *
 * PURE ESM — no `node:` imports, no DOM. Runs in the browser.
 *
 * Offsets are character offsets into a JavaScript string (UTF-16 code units),
 * which is what the parser records. `byteOffsetToLineCol` keeps its historical
 * name, but it counts characters, not UTF-8 bytes.
 */

/** An edit that cannot be applied: `code` is `spans/overlap`, `spans/range` or `spans/invalid`. */
export class SpansError extends Error {
  /**
   * @param {string} code   `spans/overlap`, `spans/range`, `spans/invalid`
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SpansError";
    this.code = code;
  }
}

function startOf(span) {
  const value = span && span.start;
  return Number.isFinite(value) ? value : 0;
}

function endOf(span) {
  const value = span && span.end;
  if (Number.isFinite(value)) return value;
  return startOf(span);
}

/**
 * A new array, sorted by `start` ascending and then by `end`. The input is not
 * touched, so a caller can keep its own order.
 *
 * @param {{start: number, end?: number}[]} spans
 * @returns {object[]}
 */
export function sortSpans(spans) {
  const list = Array.isArray(spans) ? spans : [];
  return list
    .map((span, index) => ({ span, index }))
    .sort((a, b) => {
      const byStart = startOf(a.span) - startOf(b.span);
      if (byStart !== 0) return byStart;
      const byEnd = endOf(a.span) - endOf(b.span);
      if (byEnd !== 0) return byEnd;
      return a.index - b.index;
    })
    .map((entry) => entry.span);
}

/**
 * True when two half-open ranges share at least one offset.
 *
 * Adjacent ranges (`[0,3)` and `[3,6)`) do not overlap: that is the case a
 * caller uses to replace two neighbouring regions in one pass.
 *
 * A zero-length range is an insertion point. It overlaps a non-empty range it
 * sits on or inside (`start <= point <= end`), because the order of an
 * insertion at the boundary of a replacement is not defined; it overlaps
 * another zero-length range only when the two share the same point.
 *
 * @param {{start: number, end?: number}} a
 * @param {{start: number, end?: number}} b
 * @returns {boolean}
 */
export function spansOverlap(a, b) {
  const aStart = startOf(a);
  const aEnd = endOf(a);
  const bStart = startOf(b);
  const bEnd = endOf(b);
  const aEmpty = aStart === aEnd;
  const bEmpty = bStart === bEnd;

  if (aEmpty && bEmpty) return aStart === bStart;
  if (aEmpty) return aStart >= bStart && aStart <= bEnd;
  if (bEmpty) return bStart >= aStart && bStart <= aEnd;
  return aStart < bEnd && bStart < aEnd;
}

function normalizeEdit(edit, index, length) {
  if (!edit || typeof edit !== "object") {
    throw new SpansError("spans/invalid", `Edit ${index} is not an object`);
  }
  const start = edit.start;
  const end = edit.end === undefined ? start : edit.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new SpansError("spans/invalid", `Edit ${index} needs integer offsets, got ${String(start)}..${String(end)}`);
  }
  if (start < 0 || end < start || end > length) {
    throw new SpansError(
      "spans/range",
      `Edit ${index} is out of range: ${start}..${end} does not fit inside 0..${length}`,
    );
  }
  const text = edit.text === undefined || edit.text === null ? "" : edit.text;
  if (typeof text !== "string") {
    throw new SpansError("spans/invalid", `Edit ${index} needs a string replacement, got ${typeof text}`);
  }
  return { start, end, text, index };
}

/**
 * Replace every range in `source`, back to front.
 *
 * @param {string} source
 * @param {{start: number, end?: number, text?: string}[]} edits
 * @returns {string}
 * @throws {SpansError} `spans/overlap` when two edits overlap, `spans/range`
 *   when an edit falls outside the text, `spans/invalid` when an edit is
 *   malformed
 */
export function applyEdits(source, edits) {
  const text = source === undefined || source === null ? "" : String(source);
  const list = Array.isArray(edits) ? edits : [];
  if (list.length === 0) return text;

  const normalized = list.map((edit, index) => normalizeEdit(edit, index, text.length));
  const sorted = sortSpans(normalized);

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (spansOverlap(previous, current)) {
      throw new SpansError(
        "spans/overlap",
        `Edits ${previous.index} and ${current.index} overlap: ` +
          `${previous.start}..${previous.end} and ${current.start}..${current.end}`,
      );
    }
  }

  let out = text;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const edit = sorted[i];
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * The 1-based line and column of `offset`.
 *
 * Counts characters (UTF-16 code units), not bytes. `\n` ends a line; a `\r`
 * before it belongs to the line it terminates, so a CRLF file reports column 1
 * on the line after the break and never counts the pair twice. An offset past
 * either end of the text is clamped.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {{line: number, column: number}}
 */
export function byteOffsetToLineCol(source, offset) {
  const text = source === undefined || source === null ? "" : String(source);
  const numeric = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const limit = Math.max(0, Math.min(numeric, text.length));

  let line = 1;
  let column = 1;
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
