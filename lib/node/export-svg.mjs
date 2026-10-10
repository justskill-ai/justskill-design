/**
 * lib/node/export-svg.mjs — the half of image export that touches the machine.
 *
 * `lib/export-svg.mjs` builds an SVG document and decides how big a page renders; this
 * writes bytes and may start a browser. The split is a purity boundary, not a taste
 * boundary: every file directly under `lib/` is served to the canvas over HTTP, so a
 * module that imports `node:fs` is a module the browser downloads and then dies on. The
 * old single file dodged that with `await import("node:fs")` inside a function — which
 * works, and hides the violation from a reader and from every check that looks at the top
 * of a file.
 */

import fs from "node:fs";
import path from "node:path";

import { ExportFormatError, clampScale, pageToSvg, renderSize } from "../export-svg.mjs";

/** A filename-safe fragment of a page id, for the intermediate file. */
function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "page";
}

/**
 * Write one export in whatever format was asked for.
 *
 * The format decision itself lives in `lib/raster.mjs`, which is why a missing browser
 * produces a refusal naming the alternatives rather than a silent substitution.
 *
 * @param {object} options `{ html, page, format, out, scale, size, raster, tmpDir }`
 */
export async function exportFile(options) {
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

  // Everything below needs pixels, so the HTML has to exist somewhere the browser can
  // open it.
  const workDir = options.tmpDir ?? path.join(process.cwd(), ".skill-design-tmp");
  fs.mkdirSync(workDir, { recursive: true });
  const htmlPath = path.join(workDir, `${slug(options.page?.id ?? "page")}-${Date.now()}.html`);
  fs.writeFileSync(htmlPath, options.html, "utf8");

  const { width, height } = renderSize(options.page, options.size);
  const { renderToImage } = await import("./raster-run.mjs");
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
