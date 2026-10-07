/**
 * lib/export-svg.mjs — a page as SVG, and as an image.
 *
 * ## SVG
 *
 * A page becomes one `<svg>` wrapping the HTML in `<foreignObject>`. This needs
 * no browser, which makes it the only image-ish format that works on a machine
 * with nothing installed.
 *
 * Be honest about what can open it: a browser renders `<foreignObject>` and
 * Figma, Illustrator and Sketch show a blank rectangle. That is a property of
 * the format, not a bug to work around, so the export says so.
 *
 * ## Raster
 *
 * PNG, JPEG and WebP need a browser, and `lib/node/raster-run.mjs` finds one.
 * When none can be found the export fails and names three ways forward. It does
 * NOT quietly write an SVG instead: a different format is a different
 * deliverable, and nobody asked for it.
 *
 * Browser-safe for the SVG half. The raster half is in `lib/node/`.
 */

import { escapeAttr, escapeText } from "./render.mjs";

export class ExportFormatError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = "ExportFormatError";
    this.code = code;
    this.hint = hint;
  }
}

export const IMAGE_FORMATS = new Set(["svg", "png", "jpeg", "jpg", "webp"]);

/**
 * One page as an SVG document.
 *
 * @param {object} options `{ html, page, title }`
 */
export function pageToSvg(options) {
  const html = String(options.html ?? "");
  const page = options.page ?? {};
  const width = numberOr(page.width, 390);
  const height = numberOr(page.height, 844);
  const title = options.title ?? page.name ?? "design";

  // The body's own markup goes inside the foreignObject. A full document cannot
  // nest inside an SVG, so the parts that carry meaning are lifted: the styles,
  // the font links, and the body.
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const links = [...html.matchAll(/<link[^>]*>/g)].map((m) => m[0]).join("\n");
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeText(title)}</title>
  <desc>Rendered from a skill-design design file. A browser draws this; Figma, Illustrator and Sketch show an empty rectangle because they do not implement foreignObject.</desc>
${links ? `  ${links}\n` : ""}  <style>${styles}
    .sd-page{width:${width}px;height:${height}px;overflow:hidden;background:#ffffff}
  </style>
  <foreignObject x="0" y="0" width="${width}" height="${height}">
    <xhtml:div class="sd-page" xmlns="http://www.w3.org/1999/xhtml">${body}</xhtml:div>
  </foreignObject>
</svg>
`;
}

function numberOr(value, fallback) {
  const parsed = parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A filename-safe extension for a format name. */
export function extensionFor(format) {
  const name = String(format).toLowerCase();
  return name === "jpg" ? "jpeg" : name;
}

/**
 * Write one export in whatever format was asked for.
 *
 * Runs in the node layer: it writes files and may start a browser. The format
 * decision itself lives in `lib/raster.mjs`, which is why a missing browser
 * produces a refusal naming the alternatives rather than a silent substitution.
 *
 * @param {object} options `{ html, page, format, out, scale, size, raster, tmpDir }`
 */
export async function exportFile(options) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const format = String(options.format).toLowerCase();
  const out = options.out;

  fs.mkdirSync(path.dirname(out), { recursive: true });

  if (format === "svg") {
    const svg = pageToSvg(options);
    fs.writeFileSync(out, svg, "utf8");
    return { path: out, bytes: Buffer.byteLength(svg), route: null };
  }

  if (!["png", "jpeg", "jpg", "webp"].includes(format)) {
    throw new ExportFormatError(
      "export/unknown-format",
      `There is no ${format} writer.`,
      "Formats: html, svg, png, jpeg, webp, pen.",
    );
  }

  // Everything below needs pixels, so the HTML has to exist somewhere the
  // browser can open it.
  const workDir = options.tmpDir ?? path.join(process.cwd(), ".skill-design-tmp");
  fs.mkdirSync(workDir, { recursive: true });
  const htmlPath = path.join(workDir, `${slug(options.page?.id ?? "page")}-${Date.now()}.html`);
  fs.writeFileSync(htmlPath, options.html, "utf8");

  const size = parseSize(options.size);
  const width = size?.width ?? numberOr(options.page?.width, 390);
  const height = size?.height ?? numberOr(options.page?.height, 844);

  const { renderToImage } = await import("./node/raster-run.mjs");
  try {
    const result = await renderToImage({
      htmlPath,
      outPath: out,
      width,
      height,
      scale: clampScale(options.scale),
      raster: options.raster,
      canvasOnline: options.canvasOnline === true,
    });
    return { path: result.path, bytes: result.bytes, route: `${result.route} (${result.browser})` };
  } finally {
    // The intermediate page is scaffolding, not a deliverable.
    try { fs.rmSync(htmlPath, { force: true }); } catch { /* best effort */ }
  }
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "page";
}

/** `--size WxH`, or null when it is absent or unreadable. */
export function parseSize(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(value));
  if (!match) {
    throw new ExportFormatError("export/bad-size", `--size wants WxH, and got ${JSON.stringify(value)}.`, 'Such as --size 390x844.');
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** A scale the browser accepts, so a typo cannot produce a 100× image. */
export function clampScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(3, Math.max(1, Math.round(parsed)));
}
