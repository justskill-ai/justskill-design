/**
 * `node design.mjs new <file> [flags]` — write a starter design file.
 *
 * The starter is the smallest file that satisfies docs/format-v3.md §1: one
 * page, one frame, one text element, a token block and a page-frame block in
 * `<head>`. It is canonical by construction — attribute order is `data-id`,
 * `data-type`, then the rest alphabetically, then `style` — so `format --check`
 * on a fresh file is quiet.
 */

import process from "node:process";

import { CliError, EXIT_INVALID, SHARED_FLAGS, out, parseArgs } from "../cli.mjs";
import { fileExists, readText, writeAtomic } from "../fs.mjs";

export const USAGE = `Usage: node design.mjs new <file> [options]

  --name N                 page id and file name to start from (default: the file name)
  --title T                <title> and the heading text (default: the name)
  --tokens neutral|brand|dark
                           the token block to start from (default: neutral)
  --tokens-file P          read the token block from P instead (":root{ --x:1px }" or bare declarations)
  --size WxH               page size in px (default: 390x844)

  --dry-run                print the file and write nothing
  --force                  overwrite an existing file
  --quiet                  print nothing on success
  --help                   print this usage

Exit codes: 0 written, 1 refused, 2 bad arguments or an unreadable tokens file.`;

/**
 * Three starting token sets.
 *
 * Each one carries the seven groups, because a design that cannot name its
 * colours, its spacing, its radii and its type sizes is a design where every
 * element hardcodes a value and the user cannot restyle it in one edit. The
 * groups are the closed set from the format, so these names are the vocabulary
 * a page is written against.
 */
const TOKEN_PRESETS = {
  neutral: [
    "--color-bg:#f5f5f7", "--color-surface:#ffffff", "--color-ink:#111827",
    "--color-muted:#6b7280", "--color-line:#e5e7eb", "--color-accent:#4c8dff",
    "--space-xs:4px", "--space-sm:8px", "--space-md:16px", "--space-lg:24px", "--space-xl:32px",
    "--radius-sm:8px", "--radius-md:12px", "--radius-lg:16px", "--radius-full:9999px",
    "--size-caption:12px", "--size-label:14px", "--size-body:16px",
    "--size-title:20px", "--size-headline:24px", "--size-display:32px",
    "--font-body:Inter, system-ui, sans-serif",
    "--shadow-card:0 1px 2px #00000014",
  ],
  brand: [
    "--color-bg:#ffffff", "--color-surface:#ffffff", "--color-ink:#1e1b4b",
    "--color-muted:#6366f1", "--color-line:#e0e7ff", "--color-accent:#2563eb",
    "--space-xs:4px", "--space-sm:8px", "--space-md:16px", "--space-lg:24px", "--space-xl:32px",
    "--radius-sm:6px", "--radius-md:10px", "--radius-lg:16px", "--radius-full:9999px",
    "--size-caption:12px", "--size-label:14px", "--size-body:16px",
    "--size-title:20px", "--size-headline:24px", "--size-display:32px",
    "--font-body:Inter, system-ui, sans-serif",
    "--shadow-card:0 1px 2px #1e1b4b14",
  ],
  dark: [
    "--color-bg:#0b0d12", "--color-surface:#151922", "--color-ink:#f5f7fa",
    "--color-muted:#9aa3b2", "--color-line:#2a2f38", "--color-accent:#4c8dff",
    "--space-xs:4px", "--space-sm:8px", "--space-md:16px", "--space-lg:24px", "--space-xl:32px",
    "--radius-sm:8px", "--radius-md:12px", "--radius-lg:16px", "--radius-full:9999px",
    "--size-caption:12px", "--size-label:14px", "--size-body:16px",
    "--size-title:20px", "--size-headline:24px", "--size-display:32px",
    "--font-body:Inter, system-ui, sans-serif",
    "--shadow-card:0 1px 2px #00000066",
  ],
};

/** The page-frame block, verbatim from the contract's example. */
const PAGE_FRAME_BLOCK = 'section[data-type="page"]{ margin:0 0 24px }';

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function basenameWithoutExtension(file) {
  const base = String(file).slice(String(file).lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A usable `data-id` from whatever the caller typed. */
function slugId(raw, fallback = "home") {
  const ascii = String(raw)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 64);
  return ID_PATTERN.test(ascii) ? ascii : fallback;
}

/** Split CSS declarations on `;`, ignoring separators inside quotes, parens or comments. */
function splitDeclarations(text) {
  const source = String(text);
  const parts = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  let comment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (comment) {
      if (ch === "*" && source[i + 1] === "/") {
        comment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      comment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ";" && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** A `:root{ … }` token block built from a tokens file's text. */
function tokenBlockFromFile(text, file) {
  const raw = String(text);
  const match = raw.match(/:root\s*\{([\s\S]*?)\}/);
  const body = match ? match[1] : raw;

  const declarations = [];
  for (const part of splitDeclarations(body)) {
    const trimmed = part.trim().replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const property = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!/^--[A-Za-z0-9_-]+$/.test(property) || value === "") {
      throw new CliError(`${file}: ${JSON.stringify(trimmed)} is not a custom property declaration`, EXIT_INVALID);
    }
    declarations.push(`${property}:${value}`);
  }
  if (declarations.length === 0) {
    throw new CliError(`${file}: no custom properties found`, EXIT_INVALID);
  }
  return `:root{ ${declarations.join("; ")} }`;
}

function parseSize(raw) {
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)$/);
  if (!match) throw new CliError(`--size needs WxH in px, for example 390x844, got ${JSON.stringify(String(raw))}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) throw new CliError(`--size needs positive numbers, got ${JSON.stringify(String(raw))}`);
  const trim = (value) => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3))));
  return { width: trim(width), height: trim(height) };
}

/**
 * Build the starter file's text.
 *
 * @param {{name?: string, title?: string, tokens?: string, tokensFile?: string, width?: string, height?: string, file?: string}} options
 * @returns {string}
 */
export function starterText(options = {}) {
  const file = options.file || "design.html";
  const pageId = slugId(options.name || basenameWithoutExtension(file));
  const title = options.title || options.name || "design";

  let tokenBlock;
  if (options.tokensFile) {
    tokenBlock = tokenBlockFromFile(readText(options.tokensFile), options.tokensFile);
  } else {
    const preset = options.tokens || "neutral";
    const declarations = TOKEN_PRESETS[preset];
    if (!declarations) {
      throw new CliError(`--tokens needs neutral, brand or dark, got ${JSON.stringify(String(preset))}`);
    }
    tokenBlock = `:root{ ${declarations.join("; ")} }`;
  }

  const width = options.width || "390";
  const height = options.height || "844";
  const heading = escapeText(title);
  const documentTitle = escapeText(title);

  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>${documentTitle}</title>
  <meta name="design-schema" content="3.0">
  <style>${tokenBlock}</style>
  <style>${PAGE_FRAME_BLOCK}</style>
</head>
<body>
  <section data-id="${pageId}" data-type="page" data-canvas="0,0" style="width:${width}px;height:${height}px;overflow:hidden">
    <div data-id="${pageId}__root" data-type="frame" style="display:flex;flex-direction:column;width:100%;height:100%">
      <p data-id="${pageId}__title" data-type="text" style="font-size:32px;font-weight:700">${heading}</p>
    </div>
  </section>
</body>
</html>
`;
}

export default async function run(argv) {
  const { values, positionals } = parseArgs(argv, {
    flags: {
      ...SHARED_FLAGS,
      name: { type: "string" },
      title: { type: "string" },
      tokens: { type: "string" },
      "tokens-file": { type: "string" },
      size: { type: "string" },
    },
    positionals: { min: 1, max: 1 },
    usage: USAGE,
  });

  if (values.help) {
    out(USAGE);
    return 0;
  }

  const file = positionals[0];
  if (values.tokens && values["tokens-file"]) {
    throw new CliError("--tokens and --tokens-file cannot be combined");
  }

  const size = values.size ? parseSize(values.size) : { width: "390", height: "844" };
  const text = starterText({
    file,
    name: values.name,
    title: values.title,
    tokens: values.tokens,
    tokensFile: values["tokens-file"],
    width: size.width,
    height: size.height,
  });

  if (values["dry-run"]) {
    // The dry run's whole value is the text, so it prints even under --quiet.
    process.stdout.write(text);
    return 0;
  }

  if (fileExists(file) && !values.force) {
    throw new CliError(`Refusing to overwrite ${file}: pass --force`, EXIT_INVALID);
  }

  const written = writeAtomic(file, text);
  out(`${file}: wrote ${written.bytes} bytes`, { quiet: values.quiet });
  return 0;
}
