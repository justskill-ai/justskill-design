/**
 * Which reader opens this file?
 *
 * The extension decides first, because a caller who named a file `.html` means
 * it. Content sniffing is the fallback for a file with no useful extension —
 * `design` from stdin, or a fixture in a temp directory.
 *
 * PURE ESM — no `node:` imports, no filesystem. The caller reads the text; this
 * module only decides what it is and which reader to load.
 */

export class DetectError extends Error {
  /**
   * @param {string} code   `detect/unknown-format`
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DetectError";
    this.code = code;
  }
}

/**
 * Format name -> a lazy loader for its reader.
 *
 * Lazy so that `design.mjs --help` and an HTML-only session never load the pen
 * reader, and so that a missing reader is an error at use, not at import.
 */
export const READERS = Object.freeze({
  html: () => import("./parse.mjs"),
  pen: () => import("./readers/pen.mjs"),
});

/**
 * The loader for `format`.
 *
 * @param {"html"|"pen"|string} format
 * @returns {() => Promise<object>}
 * @throws {DetectError} `detect/unknown-format`
 */
export function readerFor(format) {
  const load = READERS[format];
  if (typeof load !== "function") {
    const known = Object.keys(READERS).join(", ");
    throw new DetectError(
      "detect/unknown-format",
      `No reader for format ${JSON.stringify(String(format))}: expected one of ${known}`,
    );
  }
  return load;
}

/** The lower-case extension of a path, `.html` style, or `""`. */
export function extensionOf(file) {
  if (typeof file !== "string" || file === "") return "";
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

const PEN_EXTENSIONS = new Set([".pen"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/** True when the text is JSON with both a `version` and a `children` field. */
export function looksLikePen(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.version !== undefined &&
    value.children !== undefined
  );
}

/** True when a `<` appears before the first `{`. */
export function looksLikeHtml(text) {
  if (typeof text !== "string") return false;
  const angle = text.indexOf("<");
  if (angle === -1) return false;
  const brace = text.indexOf("{");
  return brace === -1 || angle < brace;
}

/**
 * `"html"`, `"pen"` or `"unknown"`.
 *
 * Rules, in order:
 *  1. `.pen` extension -> pen.
 *  2. `.html` / `.htm` extension -> html.
 *  3. text that starts with `{` and parses as JSON with a `version` and a
 *     `children` field -> pen.
 *  4. a `<` before the first `{` -> html.
 *  5. otherwise unknown.
 *
 * The extension beats the content in both directions, which is the rule a
 * renamed file depends on: `page.html` that happens to hold pen JSON is still
 * read as HTML, and a `.pen` file with markup is still read as pen.
 *
 * @param {string} path
 * @param {string} text
 * @returns {"html"|"pen"|"unknown"}
 */
export function detectFormat(path, text) {
  const extension = extensionOf(path);
  if (PEN_EXTENSIONS.has(extension)) return "pen";
  if (HTML_EXTENSIONS.has(extension)) return "html";

  const source = typeof text === "string" ? text : "";
  if (looksLikePen(source)) return "pen";
  if (looksLikeHtml(source)) return "html";
  return "unknown";
}
