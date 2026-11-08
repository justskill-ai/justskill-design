/**
 * An in-page link fails silently.
 *
 * The hero row under the tagline — `[开始用](#开始用)`, `[技术细节](#技术细节)` and
 * five siblings in each language — exists to save a reader a scroll. Rename
 * `## 开始用` and nothing fails: the page renders, the badges still show, and the
 * link quietly lands at the top of the document. The reader assumes they clicked
 * wrong, and nobody files that.
 *
 * GitHub derives the anchor from the heading itself: lowercase, HTML tags and
 * inline markup dropped, punctuation and symbols dropped, spaces turned into
 * hyphens, `-1`/`-2` appended to repeats. Nothing in the build knows that rule,
 * so the only check is to compare the anchors a document produces against the
 * anchors its links ask for — and, because the two READMEs render one page in
 * two languages, to compare which sections their hero rows walk, in order.
 *
 * These are not tests of taste. Each failure is a link that goes nowhere on a
 * page that renders perfectly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(ROOT, name), "utf8");

/**
 * The documents that could carry an in-page link.
 *
 * `docs/` and `references/` are walked rather than listed: a new page is a new
 * set of headings, and a link to one of them is worth checking the day it is
 * written. `test/` and `evals/` are left out — they quote markdown, they do not
 * render it.
 */
const DOCUMENTS = (() => {
  const out = ["README.md", "README.en.md", "SKILL.md"];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir)).sort()) {
      const path = `${dir}/${entry}`;
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (entry.endsWith(".md")) out.push(path);
    }
  };
  walk("docs");
  walk("references");
  return out;
})();

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * The document with fenced code blocks blanked out.
 *
 * `SKILL.md`'s command loop is a fenced shell block whose comments start with
 * `# 1.`, `# 2.`, …; counting those as headings would invent anchors that do not
 * exist and could hide a real link behind a fabricated one.
 */
function withoutFences(markdown) {
  let fence = null;
  return markdown
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line);
      if (open) {
        if (fence) fence = null;
        else fence = open[1];
        return "";
      }
      return fence ? "" : line;
    })
    .join("\n");
}

/**
 * The anchor GitHub derives from a heading: the rendered text, lowercased,
 * stripped of everything that is not a letter, mark, number, underscore, space
 * or hyphen, with spaces turned into hyphens.
 */
function githubAnchor(heading) {
  const rendered = heading
    .replace(/<[^>]*>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|\*|~~/g, "");
  return rendered
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

/** Every heading in the document, with the anchor it will answer to. */
function headingsIn(markdown) {
  const seen = new Set();
  const headings = [];
  for (const line of withoutFences(markdown).split("\n")) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/\s+#+\s*$/, "");
    const base = githubAnchor(text);
    let slug = base;
    for (let repeat = 1; seen.has(slug); repeat += 1) slug = `${base}-${repeat}`;
    seen.add(slug);
    headings.push({ level: match[1].length, text, slug });
  }
  return headings;
}

/** The `](#…)` targets of a document, with fenced code and inline code removed. */
function inPageLinks(markdown) {
  const text = withoutFences(markdown).replace(/`[^`\n]*`/g, "");
  return [...text.matchAll(/\]\(#([^)\s]+)\)/g)].map((match) =>
    decodeURIComponent(match[1]),
  );
}

/** The hero row: the one line carrying several in-page links. */
function heroRow(name) {
  const line = withoutFences(read(name))
    .split("\n")
    .find((candidate) => (candidate.match(/\]\(#/g) ?? []).length >= 3);
  assert.ok(line, `${name} has no hero row of in-page links`);
  return inPageLinks(line);
}

test("every in-page link lands on a heading", () => {
  for (const name of DOCUMENTS) {
    const markdown = read(name);
    const anchors = new Set(headingsIn(markdown).map((heading) => heading.slug));
    for (const target of inPageLinks(markdown)) {
      assert.ok(
        anchors.has(target),
        `${name} links to #${target}, but no heading produces that anchor, so the link lands at the top of the page. Anchors this document produces: ${
          [...anchors].join(", ") || "(none)"
        }`,
      );
    }
  }
});

test("the two README hero rows walk the same sections in the same order", () => {
  const sections = (name) =>
    headingsIn(read(name))
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.slug);
  const walk = (name) => {
    const order = sections(name);
    return heroRow(name).map((target) => {
      const index = order.indexOf(target);
      assert.notEqual(
        index,
        -1,
        `${name}'s hero row links to #${target}, which is not a level-2 section`,
      );
      return index;
    });
  };

  const zh = walk("README.md");
  const en = walk("README.en.md");
  assert.ok(
    zh.length >= 3,
    "README.md's hero row is gone; putting a table of contents back is the point of this test",
  );
  assert.deepEqual(
    en,
    zh,
    `the hero rows disagree: README.md walks sections ${JSON.stringify(zh)} and README.en.md walks ${JSON.stringify(en)}`,
  );
});

test("the anchors are GitHub's rules", () => {
  const document = [
    "```sh",
    "# 1. A comment, not a heading.",
    "```",
    "",
    "## Real section",
    "",
    "## Real section",
    "",
    "## `set-token`：注释与 `unset-token`",
  ].join("\n");
  assert.deepEqual(
    headingsIn(document).map((heading) => heading.slug),
    [
      "real-section",
      "real-section-1",
      "set-token注释与-unset-token",
    ],
  );
});

test("the anchor check would notice a renamed heading", () => {
  const document = ["# Page", "", "[jump](#quick-start)", "", "## Getting started"].join("\n");
  assert.deepEqual(inPageLinks(document), ["quick-start"]);
  const anchors = new Set(headingsIn(document).map((heading) => heading.slug));
  assert.equal(
    anchors.has("quick-start"),
    false,
    "a renamed heading still produced the old anchor, so the check above would pass vacuously",
  );
  assert.equal(
    anchors.has("getting-started"),
    true,
    "the anchor rule here does not match GitHub's, so every result above is suspect",
  );
});
