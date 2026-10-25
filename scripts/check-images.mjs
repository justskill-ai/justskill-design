#!/usr/bin/env node
/**
 * Check that every photo in `references/images.md` still resolves.
 *
 * The catalogue is hotlinked, and an Unsplash photo can be deleted by the person
 * who took it: a URL that returned 200 the day the file was written can return
 * 404 a month later, and the design that used it then renders an empty box. The
 * test suite never touches the network, so this is the one check that does, and
 * it is run by hand:
 *
 *   node scripts/check-images.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "references", "images.md");

const urls = [...new Set(fs.readFileSync(FILE, "utf8").match(
  /https:\/\/images\.unsplash\.com\/photo-[A-Za-z0-9-]+\?w=\d+&q=\d+&fm=jpg/g,
) ?? [])];

if (urls.length === 0) {
  console.error("no catalogue URLs found in references/images.md");
  process.exit(1);
}

const CONCURRENCY = 6;
let failed = 0;

async function check(url) {
  // HEAD is enough: the CDN answers it with the same status and content type.
  const response = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  const type = response?.headers.get("content-type") ?? "";
  if (!response?.ok || !type.startsWith("image/")) {
    failed += 1;
    console.error(`fail  ${response?.status ?? "error"}  ${url}`);
  }
}

for (let i = 0; i < urls.length; i += CONCURRENCY) {
  await Promise.all(urls.slice(i, i + CONCURRENCY).map(check));
}

console.log(`${urls.length - failed}/${urls.length} URLs resolve`);
if (failed > 0) process.exitCode = 1;
