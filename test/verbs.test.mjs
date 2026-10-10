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
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, getAttr, findById, pagesOf } from "../lib/parse.mjs";
import { validateDesign } from "../lib/validate.mjs";
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
    const r = run(["set", file, "home__card", "--style", "transform:rotate(3deg)"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /REFUSED/);
    assert.equal(readFileSync(file, "utf8"), readFileSync(STARTER, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set refuses a one-sided margin and offers the shorthand", () => {
  const { dir, file } = workspace();
  try {
    const r = run(["set", file, "home__card", "--style", "margin-top:16px"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /margin: 16px 0 0 0/);
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

// -- add: the refusal has to be readable by both readers ----------------------

/**
 * The human text said `REFUSED …` and the JSON said nothing at all.
 *
 * A refusal from the fragment compiler produced `{ok:false, applied:[], changed:false}`
 * with no `refused` block — no code, no message, no hint. A caller reading `--json` could
 * not tell "refused, because this fragment puts `data-type="text"` on a `<label>`" from
 * "the edit happened to change nothing", and the two are not the same answer.
 * `lib/receipt.mjs` R2 and format-v3 §6 both say a failure carries the block.
 */
test("add's JSON refusal carries the code, the message and the hint", () => {
  const { dir, file } = workspace();
  const fragment = join(dir, "fragment.html");
  writeFileSync(fragment, '<label data-id="n_label" data-type="text">手机号</label>');
  const { code, stdout } = run(["add", file, "--html-file", fragment, "--in", "home__root", "--json"]);
  assert.equal(code, 1, "a refused add must not exit 0");

  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.changed, false);
  assert.ok(receipt.refused, "the JSON receipt has no refused block");
  assert.equal(receipt.refused.code, "structure/type-tag-mismatch");
  assert.match(receipt.refused.message, /label/);
  assert.ok(receipt.refused.hint, "a refusal without a hint is a dead end for a model");
});

test("add's human refusal and its JSON refusal agree about the code", () => {
  const { dir, file } = workspace();
  const fragment = join(dir, "fragment.html");
  writeFileSync(fragment, '<label data-id="n_label" data-type="text">手机号</label>');
  const human = run(["add", file, "--html-file", fragment, "--in", "home__root"]);
  const json = run(["add", file, "--html-file", fragment, "--in", "home__root", "--json"]);
  const receipt = JSON.parse(json.stdout);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /REFUSED/);
  assert.match(human.stdout, new RegExp(receipt.refused.code.replace("/", "\\/")));
  assert.match(human.stdout, /was not changed\./);
});

// -- import pen: the verb's flags had no test at all --------------------------

/**
 * A `.pen` document small enough to read, with or without a name of its own.
 *
 * Every test below goes through the command line, because that is where the two defects
 * this section exists for lived: `--stdout` appended the ledger line to the document, and
 * a document with no `name` was titled literally `imported`. The reader's own tests call
 * `importPen()` directly, so neither was reachable from them.
 */
function penDoc(options = {}) {
  const doc = {
    version: "2.19",
    children: [
      {
        type: "frame", id: "p1", name: "Page", x: 0, y: 0, width: 390, height: 844,
        children: [
          { type: "text", id: "t1", name: "Title", content: "hi", width: "fill_container", height: 40 },
        ],
      },
    ],
  };
  if (options.name !== undefined) doc.name = options.name;
  return JSON.stringify(doc, null, 2);
}

test("import pen --stdout writes a design file and nothing else", () => {
  const { dir } = workspace();
  const pen = join(dir, "sample.pen");
  writeFileSync(pen, penDoc({ name: "Sample" }));

  const { code, stdout, stderr } = run(["import", "pen", pen, "--stdout"]);
  assert.equal(code, 0, stderr);

  // The whole of stdout is the document. This used to end with a sentence about pages,
  // so `--stdout > design.html` produced a file that was not a design file — and a pipe
  // cannot tell a line of HTML from a line of ledger.
  const doc = parse(stdout);
  assert.equal(pagesOf(doc).length, 1);
  assert.deepEqual(validateDesign(doc).filter((d) => d.severity === "error"), []);
  assert.match(stdout.trimEnd(), /<\/html>$/);

  // The ledger still reaches a person, on the stream a pipe does not consume.
  assert.match(stderr, /1 pages/);
});

test("import pen --stdout --json keeps the JSON off stdout as well", () => {
  const { dir } = workspace();
  const pen = join(dir, "sample.pen");
  writeFileSync(pen, penDoc({ name: "Sample" }));

  const { code, stdout, stderr } = run(["import", "pen", pen, "--stdout", "--json"]);
  assert.equal(code, 0, stderr);
  assert.match(stdout.trimEnd(), /<\/html>$/);
  const report = JSON.parse(stderr);
  assert.equal(report.ok, true);
  assert.equal(report.out, null, "nothing was written to a file, and the report says so");
  assert.equal(report.ledger.pages, 1);
});

test("import pen titles the file from the document, then from the file name", () => {
  const { dir } = workspace();
  const titleOf = (name) => {
    const text = readFileSync(name, "utf8");
    return (/<title>([^<]*)<\/title>/.exec(text) ?? [])[1];
  };

  // The pen document's own name wins over the file name it happens to live in.
  const named = join(dir, "named.pen");
  writeFileSync(named, penDoc({ name: "Ledger Sample" }));
  const first = join(dir, "first.html");
  assert.equal(run(["import", "pen", named, "-o", first, "--quiet"]).code, 0);
  assert.equal(titleOf(first), "Ledger Sample");

  // No name in the document: the file name. It used to be the literal word "imported",
  // which tells a reader of the file nothing about what it is.
  const anon = join(dir, "anon.pen");
  writeFileSync(anon, penDoc());
  const second = join(dir, "second.html");
  assert.equal(run(["import", "pen", anon, "-o", second, "--quiet"]).code, 0);
  assert.equal(titleOf(second), "anon");

  // And an explicit --title beats both.
  const third = join(dir, "third.html");
  assert.equal(run(["import", "pen", named, "-o", third, "--title", "Chosen", "--quiet"]).code, 0);
  assert.equal(titleOf(third), "Chosen");
});

/**
 * The import gate, asked to do what its own message says.
 *
 * It read the diagnostics the reader returns, which are the parser's, so it
 * caught malformed HTML and nothing else. A `.pen` whose every `ref` pointed at
 * a node that does not exist imported clean, exited 0, and wrote a document the
 * very next `validate` refuses — the one case the gate exists for.
 */
test("an import that would not validate is refused, and writes nothing", () => {
  const { dir } = workspace();
  const pen = join(dir, "ghost.pen");
  const out = join(dir, "ghost.html");
  try {
    writeFileSync(pen, JSON.stringify({
      version: "2.19",
      name: "ghost",
      children: [{
        type: "frame", id: "board", name: "Board", width: 375, height: 812,
        children: [{ type: "ref", id: "used", name: "Card", ref: "ghost" }],
      }],
    }, null, 2));

    const refused = run(["import", "pen", pen, "-o", out]);
    assert.equal(refused.code, 1, `expected a refusal: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stdout, /REFUSED/, refused.stdout);
    assert.match(refused.stdout, /component\/unknown-ref/, "the refusal names the defect, not just its count");
    assert.equal(existsSync(out), false, "a refused import writes no file");

    // The same command on a file that resolves still imports, so the gate
    // refuses this document and not the shape of it.
    writeFileSync(pen, penDoc({ name: "ok" }));
    assert.equal(run(["import", "pen", pen, "-o", out, "--quiet"]).code, 0);
    assert.ok(existsSync(out), "a clean file still imports");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
