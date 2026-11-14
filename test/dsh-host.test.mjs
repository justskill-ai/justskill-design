import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { apply } from "../dsh/index.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function designDocument(title = "Home") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="design-schema" content="3.0"></head><body>` +
    `<section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px">` +
    `<p data-id="home__title" data-type="text" style="font-size:24px">${title}</p></section></body></html>`;
}

function fakeHarness() {
  const skills = [];
  const tools = [];
  const routes = new Map();
  const disposers = [];
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const services = {
    connection,
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  const ctx = {
    logger: { warn() {}, info() {} },
    skills: {
      register(skill) {
        skills.push(skill);
        return () => {};
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => {};
    },
    inject(names, callback) {
      assert.equal(Array.isArray(names), true);
      assert.equal(names.length > 0, true);
      callback({
        get: (name) => services[name],
        effect(fn) {
          const dispose = fn();
          if (typeof dispose === "function") disposers.push(dispose);
          return () => {};
        },
      });
    },
  };
  return { ctx, skills, tools, routes, disposers };
}

function request(path, payload) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("the host half registers the skill and both Host routes on the connection service", () => {
  const harness = fakeHarness();
  apply(harness.ctx);

  assert.equal(harness.skills.length, 1);
  const skill = harness.skills[0];
  assert.equal(skill.name, "justskill-design");
  assert.equal(skill.source, "bundled");
  assert.match(skill.content, /^# justSkill/m);
  assert.equal(skill.content.includes("---\nname:"), false);
  assert.deepEqual(skill.resourceBase, { kind: "directory", path: ROOT });
  assert.match(skill.whenToUse, /product idea/);
  assert.deepEqual(skill.metadata, { category: "workflow", tags: ["design", "ui", "canvas", "html", "prototyping", "product"] });

  assert.equal(harness.routes.has("/api/justskill-design/scan/stream"), true);
  assert.equal(harness.routes.has("/api/justskill-design/canvas"), true);
  assert.equal(harness.routes.has("/api/justskill-design/canvas/close"), true);
  assert.equal(harness.routes.has("/api/justskill-design/pending"), true);
  assert.equal(harness.routes.has("/api/justskill-design/pending/clear"), true);
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.tools[0].name, "justskill_canvas");
});

test("the canvas tool queues a session-scoped request and the pending routes claim it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justskill-tool-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "design.html");
  await writeFile(file, designDocument("Home"));
  await writeFile(join(root, "plain.html"), "<html><body>plain</body></html>");

  const harness = fakeHarness();
  apply(harness.ctx);
  const tool = harness.tools[0];
  assert.equal(tool.name, "justskill_canvas");
  assert.match(tool.description, /right-sidebar Canvas tab/);
  assert.match(tool.description, /Never run `node design\.mjs serve`/);

  const exec = { agent: { id: "session-tool", session: { header: { cwd: root } } } };
  const value = await tool.execute({ file: "design.html" }, exec);
  assert.deepEqual(value, { requested: true, file });
  assert.match(tool.output.render([], value)[0].text, /justskill_canvas/);

  const pending = harness.routes.get("/api/justskill-design/pending");
  const claimed = await pending.fetch(request("/api/justskill-design/pending", { sessionId: "session-tool" }));
  assert.equal(claimed.status, 200);
  assert.deepEqual((await claimed.json()).value, { pending: { file } });

  const other = await pending.fetch(request("/api/justskill-design/pending", { sessionId: "session-other" }));
  assert.deepEqual((await other.json()).value, { pending: null });

  const clear = harness.routes.get("/api/justskill-design/pending/clear");
  const cleared = await clear.fetch(request("/api/justskill-design/pending/clear", { sessionId: "session-tool", file }));
  assert.equal(cleared.status, 200);
  const empty = await pending.fetch(request("/api/justskill-design/pending", { sessionId: "session-tool" }));
  assert.deepEqual((await empty.json()).value, { pending: null });

  await assert.rejects(() => tool.execute({ file: "missing.html" }, exec), /no such file/);
  await assert.rejects(() => tool.execute({ file: "plain.html" }, exec), /design-schema/);
});

function readEvents(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("the streaming scan route sends start, files, workspace-done and done as NDJSON", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justskill-host-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "design.html"), designDocument("Home"));
  await writeFile(join(root, "plain.html"), "<html><body>not a design</body></html>");

  const harness = fakeHarness();
  apply(harness.ctx);
  const route = harness.routes.get("/api/justskill-design/scan/stream");
  const response = await route.fetch(request("/api/justskill-design/scan/stream", {
    workspaces: [{ id: "ws-1", path: root, title: "Demo" }],
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/x-ndjson/);

  const events = readEvents(await response.text());
  assert.deepEqual(events.map((event) => event.type), ["start", "files", "workspace-done", "done"]);

  const [start, files, workspaceDone, done] = events;
  assert.deepEqual(start.workspaces, [{ id: "ws-1", path: root, title: "Demo" }]);
  assert.equal(files.workspace, "ws-1");
  assert.equal(files.files.length, 1);
  assert.equal(files.files[0].name, "design.html");
  assert.equal(files.files[0].title, "Home");
  assert.equal(files.files[0].pages, 1);
  assert.match(files.files[0].uri, /^file:\/\//);
  assert.equal(workspaceDone.workspace, "ws-1");
  assert.equal(workspaceDone.count, 1);
  assert.equal(workspaceDone.incomplete, false);
  assert.equal(done.incomplete, false);
});

test("the canvas route starts a loopback canvas, and the close route stops it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justskill-canvas-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "design.html");
  await writeFile(file, designDocument("Home"));

  const harness = fakeHarness();
  apply(harness.ctx);
  t.after(async () => {
    try {
      const route = harness.routes.get("/api/justskill-design/canvas/close");
      if (route !== undefined) await route.fetch(request("/api/justskill-design/canvas/close", { file }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    } catch {
      /* cleanup is best effort */
    }
  });

  const open = harness.routes.get("/api/justskill-design/canvas");
  const response = await open.fetch(request("/api/justskill-design/canvas", { file }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.value.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+$/);
  assert.equal(body.value.file, file);

  const page = await fetch(body.value.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /JustSkill Design canvas/);

  const close = harness.routes.get("/api/justskill-design/canvas/close");
  const closed = await close.fetch(request("/api/justskill-design/canvas/close", { file }));
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { ok: true, value: { closed: true } });
  await new Promise((resolve) => setTimeout(resolve, 120));
});

test("the canvas route refuses a file that is not a design", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justskill-bad-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "plain.html");
  await writeFile(file, "<html><body>not a design</body></html>");

  const harness = fakeHarness();
  apply(harness.ctx);
  const open = harness.routes.get("/api/justskill-design/canvas");
  const response = await open.fetch(request("/api/justskill-design/canvas", { file }));
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not-a-design-file");
});

test("the streaming scan route validates its body and limits the number of workspaces", async () => {
  const harness = fakeHarness();
  apply(harness.ctx);
  const route = harness.routes.get("/api/justskill-design/scan/stream");

  const bad = await route.fetch(request("/api/justskill-design/scan/stream", { workspaces: "nope" }));
  assert.equal(bad.status, 400);

  const workspaces = Array.from({ length: 65 }, (_, index) => ({ id: `w${index}`, path: `/tmp/w${index}` }));
  const tooMany = await route.fetch(request("/api/justskill-design/scan/stream", { workspaces }));
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error.code, "too-many-workspaces");
});

