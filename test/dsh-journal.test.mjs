/**
 * The plugin's page journal must record what actually happened, so each piece
 * is tested against the facts of a shell command and a design file:
 * recognizing this package's own write commands in a model's shell line,
 * attributing a target element to the page it sits in, and confirming a write
 * by the file's content rather than by an exit code.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  attributeWrite,
  designWriteCommands,
  hashFile,
  pageOfElement,
  PageJournal,
  parseDesignWrite,
  splitShellSegments,
} from "../dsh/journal.js";

/** Fixtures live in the gitignored scratch directory, never in /tmp. */
const ACTUAL = new URL("./.actual/dsh-journal/", import.meta.url).pathname;

const DESIGN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shop</title>
<meta name="design-schema" content="3.0"></head><body>
<section data-id="home" data-type="page" data-name="首页" data-canvas="0,0" style="width:390px;height:844px">
  <div data-id="home__root" data-type="frame" style="display:flex">
    <p data-id="home__title" data-type="text" style="font-size:24px">你好</p>
  </div>
</section>
<section data-id="settings" data-type="page" data-name="设置" data-canvas="500,0" style="width:390px;height:844px">
  <p data-id="settings__hint" data-type="text" style="font-size:14px">设置</p>
</section>
</body></html>`;

async function designFixture(name = "design.html", text = DESIGN) {
  await mkdir(ACTUAL, { recursive: true });
  const file = join(ACTUAL, name);
  await writeFile(file, text);
  return file;
}

test("a design.mjs write command is recognized across shell shapes", () => {
  assert.deepEqual(designWriteCommands("node design.mjs set design.html home__title --style 'color:#fff'"), [
    { verb: "set", file: "design.html", workdir: null, target: "home__title", renameTo: null },
  ]);
  assert.deepEqual(
    designWriteCommands("node ./design.mjs set design.html home__title --text 你好"),
    [{ verb: "set", file: "design.html", workdir: null, target: "home__title", renameTo: null }],
  );
  assert.deepEqual(
    designWriteCommands("justskill remove design.html home__notice"),
    [{ verb: "remove", file: "design.html", workdir: null, target: "home__notice", renameTo: null }],
  );
  assert.deepEqual(
    designWriteCommands("FOO=1 node design.mjs move design.html home__card --after home__title"),
    [{ verb: "move", file: "design.html", workdir: null, target: "home__card", renameTo: null }],
  );
});

test("chained and piped commands yield one record per write segment", () => {
  const writes = designWriteCommands(
    "node design.mjs set design.html a --text x && node design.mjs add design.html --html-file /tmp/card.html --in home__root | tee log",
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].verb, "set");
  assert.equal(writes[0].target, "a");
  assert.equal(writes[1].verb, "add");
  assert.equal(writes[1].target, "home__root");
});

test("a cd prefix carries its directory into the following segments", () => {
  const segments = splitShellSegments("cd sub && node design.mjs set design.html a --text x");
  assert.equal(segments.length, 2);
  assert.equal(segments[0].workdir, "sub");
  assert.equal(segments[1].workdir, "sub");
});

test("commands that write nothing are not recorded", () => {
  assert.deepEqual(designWriteCommands("node design.mjs validate design.html --json"), []);
  assert.deepEqual(designWriteCommands("node design.mjs tokens design.html ls"), []);
  assert.deepEqual(designWriteCommands("node design.mjs set design.html a --text x --dry-run"), []);
  assert.deepEqual(designWriteCommands("node design.mjs export design.html --all -o dist"), []);
  assert.deepEqual(designWriteCommands("node design.mjs format design.html --check"), []);
});

test("quotes and spaces survive the tokenizer", () => {
  const write = parseDesignWrite('node design.mjs set "my design.html" a --text "it\'s fine"');
  assert.notEqual(write, null);
  assert.equal(write.file, "my design.html");
  assert.equal(write.target, "a");
});

test("import pen names the design file the command writes", () => {
  const withOut = parseDesignWrite("node design.mjs import pen shots.design.pen -o design.html");
  assert.equal(withOut.file, "design.html");
  const defaultOut = parseDesignWrite("node design.mjs import pen shots.design.pen");
  assert.equal(defaultOut.file, "shots.design.html");
  assert.equal(parseDesignWrite("node design.mjs import pen shots.pen --stdout"), null);
});

test("the pen subcommand is not mistaken for the file", () => {
  const write = parseDesignWrite("node design.mjs import pen design.pen -o out.html");
  assert.equal(write.verb, "import");
  assert.equal(write.file, "out.html");
});

test("an element resolves to the page it sits in", async () => {
  const file = await designFixture();
  assert.deepEqual(pageOfElement(file, "home__title"), { pageId: "home", pageName: "首页" });
  assert.deepEqual(pageOfElement(file, "home__root"), { pageId: "home", pageName: "首页" });
  assert.deepEqual(pageOfElement(file, "settings__hint"), { pageId: "settings", pageName: "设置" });
  // A page id names itself.
  assert.deepEqual(pageOfElement(file, "home"), { pageId: "home", pageName: "首页" });
  assert.equal(pageOfElement(file, "nope__gone"), null);
});

test("attribution covers every verb's target", async () => {
  const file = await designFixture();
  assert.deepEqual(
    attributeWrite({ verb: "set", file, workdir: null, target: "home__title", renameTo: null }),
    { file, pageId: "home", pageName: "首页", removed: false },
  );
  assert.deepEqual(
    attributeWrite({ verb: "remove", file, workdir: null, target: "home__title", renameTo: null }),
    { file, pageId: "home", pageName: "首页", removed: false },
  );
  assert.deepEqual(
    attributeWrite({ verb: "remove", file, workdir: null, target: "settings", renameTo: null }),
    { file, pageId: "settings", pageName: "设置", removed: true },
  );
  assert.deepEqual(
    attributeWrite({ verb: "rename", file, workdir: null, target: "home", renameTo: "start" }),
    { file, pageId: "start", pageName: "", removed: false },
  );
  assert.deepEqual(
    attributeWrite({ verb: "rename", file, workdir: null, target: "home__title", renameTo: "home__heading" }),
    { file, pageId: "home", pageName: "首页", removed: false },
  );
  // An element the file does not have is not guessed at.
  assert.equal(
    attributeWrite({ verb: "set", file, workdir: null, target: "gone", renameTo: null }),
    null,
  );
  // `new` and container-less `add` are file-level records.
  assert.deepEqual(
    attributeWrite({ verb: "new", file, workdir: null, target: null, renameTo: null }),
    { file, pageId: null, pageName: "", removed: false },
  );
  assert.deepEqual(
    attributeWrite({ verb: "add", file, workdir: null, target: null, renameTo: null }),
    { file, pageId: null, pageName: "", removed: false },
  );
});

test("a relative file resolves against the command's workdir", async () => {
  await mkdir(join(ACTUAL, "sub"), { recursive: true });
  const file = join(ACTUAL, "sub", "design.html");
  await writeFile(file, DESIGN);
  const write = { verb: "set", file: "design.html", workdir: "sub", target: "home__title", renameTo: null };
  assert.deepEqual(attributeWrite(write, ACTUAL.replace(/\/$/, "")), {
    file,
    pageId: "home",
    pageName: "首页",
    removed: false,
  });
});

test("a landed write enters the journal; a refused one does not", async () => {
  const file = await designFixture();
  const journal = new PageJournal(null);
  await journal.open();

  const execution = { arguments: { command: "node design.mjs set design.html home__title --text 新" }, callId: "c1" };
  const staged = journal.stageExecution(execution, { sessionId: "s1", turn: 3, cwd: ACTUAL });
  assert.equal(staged, true);
  assert.deepEqual(await journal.turnPages({ sessionId: "s1", turn: 3 }), []);

  // The write lands: the file changes, so the record is confirmed.
  await writeFile(file, DESIGN.replace("你好", "新"));
  assert.equal(await journal.settleExecution(execution, { isError: false }), true);
  assert.deepEqual(await journal.turnPages({ sessionId: "s1", turn: 3 }), [
    { file, pages: [{ id: "home", name: "首页", removed: false }] },
  ]);

  // A second write in the same turn folds into the same group.
  const second = { arguments: { command: "node design.mjs set design.html settings__hint --text 改" }, callId: "c2" };
  journal.stageExecution(second, { sessionId: "s1", turn: 3, cwd: ACTUAL });
  await writeFile(file, DESIGN.replace("你好", "新").replace(">设置<", ">改<"));
  assert.equal(await journal.settleExecution(second, { isError: false }), true);
  const groups = await journal.turnPages({ sessionId: "s1", turn: 3 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].pages.map((page) => page.id), ["home", "settings"]);

  // A refused write (file byte-identical) is dropped.
  const refused = { arguments: { command: "node design.mjs set design.html home__title --text 再改" }, callId: "c3" };
  journal.stageExecution(refused, { sessionId: "s1", turn: 4, cwd: ACTUAL });
  assert.equal(await journal.settleExecution(refused, { isError: false }), false);
  assert.deepEqual(await journal.turnPages({ sessionId: "s1", turn: 4 }), []);
});

test("an errored tool result drops its staged record", async () => {
  const file = await designFixture("error-case.html");
  const journal = new PageJournal(null);
  await journal.open();
  const execution = { arguments: { command: "node design.mjs set design.html home__title --text 新" }, callId: "e1" };
  journal.stageExecution(execution, { sessionId: "s2", turn: 1, cwd: ACTUAL });
  await writeFile(file, DESIGN.replace("你好", "新"));
  assert.equal(await journal.settleExecution(execution, { isError: true }), false);
  assert.deepEqual(await journal.turnPages({ sessionId: "s2", turn: 1 }), []);
});

test("commands of other turns and sessions stay out of the answer", async () => {
  const file = await designFixture();
  const journal = new PageJournal(null);
  await journal.open();
  const writeAndSettle = async (callId, sessionId, turn, replacement) => {
    const execution = { arguments: { command: "node design.mjs set design.html home__title --text 一" }, callId };
    journal.stageExecution(execution, { sessionId, turn, cwd: ACTUAL });
    await writeFile(file, DESIGN.replace("你好", replacement));
    await journal.settleExecution(execution, { isError: false });
  };
  await writeAndSettle("t1", "sA", 1, "一");
  await writeAndSettle("t2", "sA", 2, "二");
  await writeAndSettle("t3", "sB", 1, "三");
  assert.equal((await journal.turnPages({ sessionId: "sA", turn: 1 })).length, 1);
  assert.equal((await journal.turnPages({ sessionId: "sA", turn: 2 })).length, 1);
  assert.equal((await journal.turnPages({ sessionId: "sA", turn: 3 })).length, 0);
  assert.equal((await journal.turnPages({ sessionId: "sB", turn: 1 })).length, 1);
  assert.equal((await journal.turnPages({ sessionId: "sB", turn: 2 })).length, 0);
});

test("a file-level record resolves to the file's current pages", async () => {
  const file = join(ACTUAL, "fresh.html");
  await rm(file, { force: true });
  const journal = new PageJournal(null);
  await journal.open();
  const execution = { arguments: { command: "node design.mjs import pen fresh.pen -o fresh.html" }, callId: "f1" };
  journal.stageExecution(execution, { sessionId: "s3", turn: 1, cwd: ACTUAL });
  // The import creates the design file; only then does the record settle.
  await designFixture("fresh.html", DESIGN);
  assert.equal(await journal.settleExecution(execution, { isError: false }), true);
  assert.deepEqual(await journal.turnPages({ sessionId: "s3", turn: 1 }), [
    {
      file,
      pages: [
        { id: "home", name: "首页", removed: false },
        { id: "settings", name: "设置", removed: false },
      ],
    },
  ]);
});

test("the journal persists across an open", async () => {
  const dir = join(ACTUAL, "persist");
  await mkdir(dir, { recursive: true });
  const file = await designFixture("persisted.html");
  const first = new PageJournal(dir);
  await first.open();
  const execution = { arguments: { command: `node design.mjs set ${file} home__title --text 存` }, callId: "p1" };
  first.stageExecution(execution, { sessionId: "s4", turn: 7, cwd: ACTUAL });
  await writeFile(file, DESIGN.replace("你好", "存"));
  await first.settleExecution(execution, { isError: false });

  const second = new PageJournal(dir);
  await second.open();
  assert.deepEqual(await second.turnPages({ sessionId: "s4", turn: 7 }), [
    { file, pages: [{ id: "home", name: "首页", removed: false }] },
  ]);
  assert.equal((await readFile(join(dir, "pages.ndjson"), "utf8")).includes("首页"), true);
  await rm(dir, { recursive: true, force: true });
});

test("hashes distinguish an existing file from a missing one", async () => {
  const file = await designFixture("hashed.html");
  const before = hashFile(file);
  await writeFile(file, DESIGN.replace("你好", "换"));
  assert.notEqual(hashFile(file), before);
  assert.equal(hashFile(join(ACTUAL, "no-such-file.html")), null);
});

test("a write without a workspace to resolve against records nothing", () => {
  // Relative file, no cwd: guessing would name a file the command never touched.
  assert.deepEqual(
    attributeWrite({ verb: "set", file: "design.html", workdir: null, target: "a", renameTo: null }, null),
    null,
  );
});

test("unparseable shell quoting yields no record", () => {
  assert.deepEqual(designWriteCommands("node design.mjs set 'unterminated.html a --text x"), []);
});
