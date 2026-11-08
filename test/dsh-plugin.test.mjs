import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DESIGN_MARKER, readDesignFile, scanWorkspace, SKIP_DIRS } from "../dsh/scan.js";
import { readSkill, SKILL_DESCRIPTION, SKILL_NAME } from "../dsh/skill.js";

const ROOT = new URL("..", import.meta.url).pathname;

function designDocument(title, pages = 2) {
  const body = Array.from({ length: pages }, (_, index) => (
    `<section data-id="page${index}" data-type="page" data-canvas="0,0" style="width:390px;height:844px">` +
    `<p data-id="page${index}__title" data-type="text" style="font-size:24px">${title} ${index}</p>` +
    `</section>`
  )).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="design-schema" content="3.0"></head><body>${body}</body></html>`;
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "justskill-dsh-"));
  await writeFile(join(root, "design.html"), designDocument("Home", 3));
  await writeFile(join(root, "notes.html"), "<!doctype html><title>notes</title><p>not a design</p>");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "checkout.html"), designDocument("Checkout", 1));
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "design.html"), designDocument("Ignored", 1));
  await mkdir(join(root, "deep", "a", "b"), { recursive: true });
  await writeFile(join(root, "deep", "a", "b", "design.html"), designDocument("Deep", 1));
  return root;
}

test("the design marker is the one the format already writes", () => {
  assert.equal(DESIGN_MARKER.test('<meta name="design-schema" content="3.0">'), true);
  assert.equal(DESIGN_MARKER.test("<meta content='3.0' name='design-schema'>"), true);
  assert.equal(DESIGN_MARKER.test('<meta name="theme-color" content="#fff">'), false);
});

test("readDesignFile reads a design and ignores ordinary HTML", async (t) => {
  const root = await workspaceFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const design = await readDesignFile(join(root, "design.html"));
  assert.notEqual(design, null);
  assert.equal(design.name, "design.html");
  assert.equal(design.title, "Home");
  assert.equal(design.pages, 3);
  assert.match(design.uri, /^file:\/\//);
  assert.ok(design.size > 0);
  assert.ok(design.mtime > 0);

  assert.equal(await readDesignFile(join(root, "notes.html")), null);
});

test("scanWorkspace groups design files, skips ignored directories and respects depth", async (t) => {
  const root = await workspaceFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanWorkspace({ path: root });
  const names = result.files.map((file) => file.name);
  assert.equal(names.includes("design.html"), true);
  assert.equal(names.includes("checkout.html"), true);
  assert.equal(result.files.some((file) => file.path.includes("node_modules")), false);
  assert.equal(result.incomplete, false);

  // depth 6 from root: design.html is depth 0, nested/checkout depth 1,
  // deep/a/b/design depth 3; all inside the default bound.
  assert.equal(result.files.length, 3);

  const shallow = await scanWorkspace({ path: root }, { maxDepth: 0 });
  assert.equal(shallow.files.length, 1);
  assert.equal(shallow.files[0].name, "design.html");

  const capped = await scanWorkspace({ path: root }, { maxFiles: 1 });
  assert.equal(capped.files.length, 1);
  assert.equal(capped.incomplete, true);
});

test("scanWorkspace never follows a symlink out of the workspace", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "justskill-outside-"));
  const root = await mkdtemp(join(tmpdir(), "justskill-inside-"));
  t.after(() => Promise.all([
    rm(outside, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true }),
  ]));
  await writeFile(join(outside, "secret.html"), designDocument("Secret", 1));
  try {
    await symlink(join(outside, "secret.html"), join(root, "linked.html"));
  } catch {
    return; // a platform without symlink permission
  }

  const result = await scanWorkspace({ path: root });
  assert.equal(result.files.some((file) => file.name === "linked.html"), false);
});

test("the ignored directory list covers dependency and build output", () => {
  for (const name of ["node_modules", ".git", "dist", "build", "coverage"]) {
    assert.equal(SKIP_DIRS.has(name), true);
  }
});

test("readSkill strips frontmatter and keeps the package root as the resource base", () => {
  const skill = readSkill(ROOT);
  assert.equal(skill.name, SKILL_NAME);
  assert.equal(skill.description, SKILL_DESCRIPTION);
  assert.ok(skill.description.length <= 500, "the DSH catalog truncates at 500 characters");
  assert.equal(skill.content.includes("---\nname:"), false);
  assert.match(skill.content, /^# justSkill/m);
  assert.equal(skill.path, join(ROOT, "SKILL.md"));
  assert.deepEqual(skill.resourceBase, { kind: "directory", path: ROOT });
});

test("SKILL.md describes the tool-first canvas step with a serve fallback", () => {
  const source = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  assert.match(source, /\| 6 \| Canvas \| Open the canvas: if a `justskill_canvas` tool is available/);
  assert.match(source, /never start a server yourself/);
  assert.match(source, /Otherwise start `serve` in the background/);
  assert.match(source, /right-sidebar \*\*Canvas\*\* tab/);
});

test("package.json declares the DSH bundle and client and ships every runtime file", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "justskill-design");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.main, "./dsh/index.js");
  assert.equal(pkg.exports["./client"], "./dsh/client.js");
  assert.match(pkg.engines.dsh, /0\.2\.1-rc\.3/);

  const files = new Set(pkg.files);
  for (const required of ["SKILL.md", "lib", "canvas", "references", "dsh", "cordis.patch.yml"]) {
    assert.equal(files.has(required), true, `files must include ${required}`);
  }

  const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
  assert.match(patch, /name:\s*'justskill-design'/);
});

test("the client bundle loads through the ModuleLoader factory and registers both surfaces", () => {
  const client = readFileSync(join(ROOT, "dsh/client.js"), "utf8");
  let definition = null;
  const window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  new Function("window", client)(window);

  assert.equal(definition.id, "justskill-design");
  assert.equal(typeof definition.factory, "function");
  const React = {
    createElement: () => null,
    Fragment: "fragment",
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: 0 }),
    useCallback: (fn) => fn,
  };
  const module = definition.factory((name) => {
    if (name === "react") return React;
    throw new Error(`unexpected require(${name})`);
  });
  assert.deepEqual(module.inject, ["slots"]);
  assert.equal(typeof module.apply, "function");
  assert.match(client, /sidebar\.panellist/);
  assert.match(client, /sidebarRightTabs/);
  assert.match(client, /embed=1/);
  assert.match(client, /Do NOT run `node design\.mjs serve`/);
  assert.match(client, /canvas request watcher/);
  assert.match(client, /pending\/clear/);
  // Regression: the icon helper must pop a trailing numeric size instead of
  // passing the first child as `width` (rendered `[object Object]`).
  assert.match(client, /typeof args\[args\.length - 1\] === 'number'/);
});

test("the client apply registers the workbench panel and the Canvas tab in the right sidebar", () => {
  const client = readFileSync(join(ROOT, "dsh/client.js"), "utf8");
  let definition = null;
  const window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  new Function("window", client)(window);
  const React = {
    createElement: () => null,
    Fragment: "fragment",
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: 0 }),
    useCallback: (fn) => fn,
  };
  const module = definition.factory(() => React);

  const registrations = [];
  const tabs = [];
  const effects = [];
  const ctx = {
    effect(fn) { effects.push(fn); return () => {}; },
    slots: {
      inject(key, callback) { callback(); },
      register(options, component) { registrations.push({ ...options, component }); return () => {}; },
    },
    inject(names, callback) {
      callback({
        get: (name) => (name === "sidebarRightTabs" ? { register: (options) => { tabs.push(options); return () => {}; } } : undefined),
        effect(fn) { fn(); return () => {}; },
      });
    },
  };
  module.apply(ctx);
  const names = registrations.map((entry) => entry.name);
  assert.equal(names.includes("sidebar.panellist"), true);
  assert.equal(names.includes("main"), true);
  assert.equal(names.includes("sidebar.right.pane.tab"), true);
  assert.equal(names.includes("sidebar.right.pane.tab.title"), true);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].kind, "justskill-canvas");
  assert.equal(tabs[0].keepMounted, true);
  assert.equal(typeof tabs[0].title, "function");
});

test("the canvas has an opt-in embed mode and it leaves normal tabs alone", () => {
  const app = readFileSync(join(ROOT, "canvas/app.mjs"), "utf8");
  const css = readFileSync(join(ROOT, "canvas/styles.css"), "utf8");
  assert.match(app, /get\("embed"\) === "1"/);
  assert.match(app, /function enterEmbed\(\)/);
  assert.match(app, /panels\.left\.open = false/);
  assert.match(app, /panels\.right\.open = false/);
  assert.match(css, /body\[data-embed\]/);
  assert.match(css, /#export-all/);
  // Selection calls preventDefault on pointerdown, which suppresses the
  // browser's focus change; an embedded canvas must take keyboard focus itself
  // or ⌘C is handled by the host page instead of the canvas.
  const html = readFileSync(join(ROOT, "canvas/index.html"), "utf8");
  assert.match(html, /<body tabindex="-1">/);
  assert.match(app, /function claimKeyboardFocus\(\)/);
  assert.match(app, /window\.focus\(\)/);
});
