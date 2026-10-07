/**
 * The write verbs, as a user meets them: a child process, a file on disk, an
 * exit code.
 *
 * The invariant that ties them together: every change a verb makes can be undone
 * by applying the inverse op list, and that undo restores the exact original
 * bytes. That is what `undo` will do, so it is pinned here at the level where a
 * user sees it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, getAttr, findById } from "../lib/parse.mjs";
import { serialize } from "../lib/serialize.mjs";
import { applyOps } from "../lib/ops.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "design.mjs");
const STARTER = join(HERE, "fixtures", "html", "simple.html");

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "sd-verbs-"));
  const file = join(dir, "design.html");
  writeFileSync(file, readFileSync(STARTER, "utf8"));
  return { dir, file, original: readFileSync(STARTER, "utf8") };
}

/** Apply the recorded inverse to the changed text, and compare bytes. */
function undoRestores(original, changed, inverse) {
  const origin = parse(original);
  const next = parse(changed);
  const { doc: back } = applyOps(next, inverse);
  return serialize(next, back) === original;
}

// -- set ----------------------------------------------------------------------

test("set writes a canonical property and reports the op", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__card", "--style", "border-radius:20px;background:#eee", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(r.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.applied.length, 2);

    const after = readFileSync(file, "utf8");
    assert.match(after, /background-color:#eeeeee/);
    assert.match(after, /border-radius:20px/);
    assert.ok(!after.includes("background:#eee"), "the alias is not left behind");
    // One spelling of one intent on that element: the alias replaced the
    // declaration it meant, rather than sitting beside it.
    const element = findById(parse(after), "home__card");
    const style = getAttr(element, "style");
    assert.equal((style.match(/background-color:/g) ?? []).length, 1);
    assert.ok(!style.includes("background:"), "no second background declaration");
    assert.ok(undoRestores(readFileSync(STARTER, "utf8"), after, receipt.inverse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set replaces text, and the inverse puts the old text back", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__title", "--text", "你好，设计", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(r.stdout);
    const after = readFileSync(file, "utf8");
    assert.match(after, />你好，设计</);
    assert.ok(undoRestores(readFileSync(STARTER, "utf8"), after, receipt.inverse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set refuses a value outside the table, and says what is allowed", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__card", "--style", "display:grid"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /REFUSED/);
    assert.match(r.stdout, /flex \| block \| none/);
    assert.equal(readFileSync(file, "utf8"), readFileSync(STARTER, "utf8"), "the file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set refuses a property the format does not use, and names the replacement", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__card", "--style", "margin:16px"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /gap/);
    assert.equal(readFileSync(file, "utf8"), readFileSync(STARTER, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set with nothing to change is refused, not silently a no-op", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__card"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Nothing to set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set --unset removes one declaration and leaves the neighbours", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__card", "--unset", "border-radius", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const after = readFileSync(file, "utf8");
    assert.ok(!after.includes("border-radius"), "the declaration is gone");
    assert.match(after, /background-color:#f5f5f7/, "its neighbour stayed");
    assert.ok(undoRestores(readFileSync(STARTER, "utf8"), after, JSON.parse(r.stdout).inverse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set on an unknown id is refused with the code, not a crash", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__nope", "--style", "color:#111111"]);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("REFUSED") || r.stderr.includes("REFUSED"), r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- remove -------------------------------------------------------------------

test("remove takes the subtree and the inverse puts it back byte for byte", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["remove", file, "home__card", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(r.stdout);
    const after = readFileSync(file, "utf8");
    assert.ok(!after.includes('data-id="home__card"'));
    assert.ok(!after.includes("home__card-value"), "the subtree went with it");
    assert.ok(undoRestores(readFileSync(STARTER, "utf8"), after, receipt.inverse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove of an unknown id is refused", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["remove", file, "home__nope"]);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(file, "utf8"), readFileSync(STARTER, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- move ---------------------------------------------------------------------

test("move --index reorders, and the inverse restores the original bytes", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["move", file, "home__card", "--index", "0", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(r.stdout);
    const after = readFileSync(file, "utf8");
    // Compare the two opening tags: "home__card" is also a prefix of its
    // descendant ids, so indexOf on the bare id would match the wrong one.
    assert.ok(after.indexOf('<div data-id="home__card"') < after.indexOf('<p data-id="home__title"'),
      "the card is first now");
    assert.ok(undoRestores(readFileSync(STARTER, "utf8"), after, receipt.inverse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("move --before and --after address a sibling by id", () => {
  const { dir, file } = workspace();
  try {
    assert.equal(run(["move", file, "home__card", "--after", "home__title"]).code, 0);
    const after = readFileSync(file, "utf8");
    assert.ok(after.indexOf('<p data-id="home__title"') < after.indexOf('<div data-id="home__card"'));
    assert.equal(run(["move", file, "home__card", "--before", "home__title"]).code, 0);
    const back = readFileSync(file, "utf8");
    assert.ok(back.indexOf('<div data-id="home__card"') < back.indexOf('<p data-id="home__title"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("move with no destination, or with two, is refused", () => {
  const { dir, file } = workspace();
  try {
    const none = run(["move", file, "home__card"]);
    assert.equal(none.code, 1);
    assert.match(none.stdout, /Where should it go/);

    const two = run(["move", file, "home__card", "--before", "home__title", "--index", "1"]);
    assert.equal(two.code, 1);
    assert.match(two.stdout, /One destination at a time/);

    assert.equal(readFileSync(file, "utf8"), readFileSync(STARTER, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("move into its own subtree is refused by the engine", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["move", file, "home__root", "--into", "home__title"]);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(file, "utf8"), readFileSync(STARTER, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- the verbs agree with the validator ---------------------------------------

test("a verb never leaves a file that fails to validate", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-verbs-clean-"));
  const file = join(dir, "design.html");
  try {
    cpSync(STARTER, file);
    const steps = [
      ["set", file, "home__title", "--style", "font-size:40px"],
      ["set", file, "home__card", "--style", "background-color:#efefef"],
      ["move", file, "home__card", "--index", "0"],
      ["add", file, "--html", '<p data-id="home__note" data-type="text" style="font-size:12px;color:#111827">note</p>', "--in", "home__root"],
      ["remove", file, "home__note"],
    ];
    for (const step of steps) {
      const r = run(step);
      assert.equal(r.code, 0, `${step[0]} failed: ${r.stdout}${r.stderr}`);
      const v = run(["validate", file, "--json"]);
      assert.equal(v.code, 0, `after ${step[0]}: ${v.stdout}`);
      const receipt = JSON.parse(v.stdout);
      const errors = (receipt.diagnostics ?? []).filter((d) => d.severity === "error");
      assert.equal(errors.length, 0, `after ${step[0]}: ${JSON.stringify(errors)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run reports the change and writes nothing", () => {
  const { dir, file } = workspace();
  try {
    const before = readFileSync(file, "utf8");
    const r = run(["set", file, "home__card", "--style", "border-radius:99px", "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(r.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(readFileSync(file, "utf8"), before, "the file is byte identical after a dry run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
