/**
 * `references/images.md` is the one hand-written reference: a catalogue of
 * verified Unsplash URLs plus what each photo shows.
 *
 * It is data rather than a copy of the format table, so the generator cannot
 * derive it (see `test/references.test.mjs` for the generated documents). The
 * invariants this test pins are the ones that make the catalogue usable by a
 * model: every row is a URL it can copy whole, every URL has the shape that was
 * verified, and every row says what the photo shows and who took it. Availability
 * is checked by `scripts/check-images.mjs`, which needs the network, so it is run
 * by hand rather than here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (name) => readFileSync(join(ROOT, name), "utf8");

const CATALOGUE = read("references/images.md");
const SKILL = read("SKILL.md");

/** One table row: `| src | what it shows | credit |`. */
const ROW = /^\| `(https:\/\/images\.unsplash\.com\/photo-[A-Za-z0-9-]+\?w=1080&q=80&fm=jpg)` \| ([^|]+) \| ([^|]+) \|$/;

const rows = CATALOGUE.split("\n").filter((line) => line.startsWith("| `https://images.unsplash.com/"));

test("SKILL.md sends the model to the catalogue", () => {
  assert.ok(SKILL.includes("references/images.md"), "SKILL.md does not mention references/images.md");
  // The catalogue is not the first choice: the user's own image is.
  assert.match(SKILL, /user's own image/i, "SKILL.md does not say the user's image wins");
});

test("the catalogue has enough photos to design with", () => {
  assert.ok(rows.length >= 32, `only ${rows.length} catalogue rows; a page with an avatar, a hero and a gallery needs more`);
});

test("every catalogue row is a URL a model can copy whole", () => {
  for (const row of rows) {
    const match = ROW.exec(row);
    assert.ok(match, `not a copyable row: ${row}`);
    // `?w=1080&q=80&fm=jpg` is the shape every URL in the file was verified in.
    assert.ok(!row.includes("&amp;"), `catalogue row HTML-escaped its URL: ${row}`);
  }
});

test("no photo appears twice", () => {
  const ids = rows.map((row) => ROW.exec(row)[1]);
  assert.equal(new Set(ids).size, ids.length, "the catalogue repeats a photo");
});

test("every row says what the photo shows, and who took it", () => {
  for (const row of rows) {
    const [, , shows, credit] = ROW.exec(row);
    assert.ok(shows.trim().length >= 8, `no useful description: ${row}`);
    assert.match(
      credit.trim(),
      /^Photo (by .+ on Unsplash|from Unsplash)$/,
      `credit is not a credit: ${row}`,
    );
  }
});

test("the catalogue is grouped by what a page is looking for", () => {
  const groups = [...CATALOGUE.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  for (const name of [
    "Landscapes and scenery",
    "Portraits and faces",
    "Interiors and workspaces",
    "Objects and food",
    "Animals",
  ]) {
    assert.ok(groups.includes(name), `the catalogue has no "${name}" group`);
  }
});

test("the catalogue states the licence and the hotlink rule", () => {
  assert.match(CATALOGUE, /Unsplash License/, "the catalogue does not name its licence");
  assert.match(CATALOGUE, /hotlink/i, "the catalogue does not say the photos are hotlinked");
  assert.match(CATALOGUE, /w=400/, "the catalogue does not say a smaller width is allowed for avatars");
});

test("the catalogue has no hole in it", () => {
  for (const pattern of [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/]) {
    assert.doesNotMatch(CATALOGUE, pattern, "the catalogue stringified something that is not text");
  }
});
