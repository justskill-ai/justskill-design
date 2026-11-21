/**
 * The canvas reference bridge, as the browser half sees it: the `@` source's
 * chips, the paste that turns a copied pointer into one chip, and the sent-text
 * node that draws the same pointer short again.
 *
 * No browser and no DSH: `dsh/client.js` is a ModuleLoader registration, so a
 * stub window, a stub React and a stub Context are enough to drive every path
 * the reader touches.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// The plugin polls the Host for canvas requests; a unit test must stay off the
// network (and off the developer's running instance).
globalThis.fetch = async () => { throw new Error("offline"); };
const CANVAS_FILE = "/tmp/design.html";
const CANVAS_URI = `file://${CANVAS_FILE}`;
const SEP = "\u0000";

/** One pointer sentence exactly as `canvas/app.mjs` copies it. */
const pointer = (id = "home__hero-title", page = "home") =>
  `Use justSkill tools. Current file ${CANVAS_URI}. Page id: ${page}. Selected node ids: ${id}`;

/** Decode the chip ref the plugin builds (`fileUri\u0000page\u0000id`). */
function decodeRef(ref) {
  const parts = String(ref).split(SEP);
  if (parts.length < 3) return { uri: null, pageId: null, id: parts[0] };
  return { uri: parts[0] || null, pageId: parts[1] || null, id: parts[2] };
}

/**
 * Load the client bundle and apply it to a stub Context.
 *
 * The bundle is a ModuleLoader registration: `window` is a factory *parameter*,
 * so the script runs with this stub window, and the paste listener it installs
 * keeps that same object. `document` is the only global it reads.
 * @param {object} [services] extra Client services the plugin asks for.
 * @returns the captured registration surface.
 */
function loadClient(services = {}) {
  const client = readFileSync(join(ROOT, "dsh/client.js"), "utf8");
  let definition = null;
  const windowListeners = new Map();
  const window = {
    __ModuleLoader__: { load: (value) => { definition = value; } },
    parent: { postMessage: () => {} },
    addEventListener(name, handler) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      const list = windowListeners.get(name) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };
  new Function("window", client)(window);

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: "fragment",
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: 0 }),
    useCallback: (fn) => fn,
  };
  const module = definition.factory(() => React);

  const composerHost = { kind: "composer" };
  globalThis.document ??= {};
  Object.assign(globalThis.document, {
    activeElement: null,
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, style: {} }),
    baseURI: "http://127.0.0.1:3080/",
    addEventListener: () => {},
  });

  const sources = [];
  const registrations = [];
  const rules = [];
  const openedTabs = [];
  const disposers = [];

  const ctx = {
    // The plugin keeps a poll interval alive; a test must be able to end it, and
    // the poll must never reach the running DSH instance.
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    slots: {
      inject(_key, factory) { factory(); return () => {}; },
      register(options, component) { registrations.push({ ...options, component }); return () => {}; },
    },
    get(name) {
      if (services[name] !== undefined) return services[name];
      if (name === "sidebarRight") {
        return {
          mounted: { getSnapshot: () => "s1" },
          openTab: (kind, options) => { openedTabs.push({ kind, file: options?.params?.file }); },
        };
      }
      if (name === "sessions") return { binding: () => ({ ctx: {} }) };
      return undefined;
    },
    inject(_names, callback) {
      callback({
        get(name) {
          if (name === "inputTriggers") {
            return { registerSource(source) { sources.push(source); return () => {}; } };
          }
          if (name === "uiConversation") {
            return { userText: { register(rule) { rules.push(rule); return () => {}; } } };
          }
          return undefined;
        },
        effect(fn) {
          const dispose = fn();
          if (typeof dispose === 'function') disposers.push(dispose);
          return dispose;
        },
      });
    },
  };
  module.apply(ctx);

  const dispose = () => {
    while (disposers.length > 0) {
      const next = disposers.pop();
      try {
        next();
      } catch {
        /* already disposed */
      }
    }
  };
  return { sources, registrations, rules, openedTabs, windowListeners, composerHost, dispose };
}

/** Post one `elements` message the way the canvas iframe does. */
function postElements(windowListeners, elements, path = CANVAS_FILE) {
  for (const handler of windowListeners.get("message") ?? []) {
    handler({
      data: {
        type: "jsk-canvas",
        event: "elements",
        file: path.split("/").at(-1),
        path,
        revision: "r1",
        elements,
      },
      source: {},
    });
  }
}

/** Drive one paste through the captured listener. */
function paste(windowListeners, text, { path = [] } = {}) {
  let prevented = false;
  let stopped = false;
  const event = {
    clipboardData: { getData: () => text, setData: () => {} },
    composedPath: () => path,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  };
  for (const handler of windowListeners.get("paste") ?? []) handler(event);
  return { prevented, stopped };
}

/** The stub composer a paste must land in. */
const inComposer = (host) => [{ closest: (selector) => (selector === "[data-composer-input]" ? host : null) }];

const ELEMENTS = [
  { id: "home__hero-title", name: "Hero title", tag: "h1", type: "text", text: "Make your day easier", pageId: "home", pageName: "Home" },
  { id: "home__cta", name: "CTA", tag: "button", type: "frame", text: "", pageId: "home", pageName: "Home" },
  { id: "weird id", name: "weird", tag: "div", type: "frame", text: "", pageId: "home", pageName: "Home" },
];

test("the canvas source registers without listing a menu", async (t) => {
  const { sources, dispose } = loadClient();
  t.after(dispose);
  assert.equal(sources.length, 1);
  const [source] = sources;
  assert.equal(source.trigger, "@");
  assert.equal(source.name, "justskill-canvas");
  const candidates = await source.candidates({ sessionId: "s1" }, { query: "", signal: new AbortController().signal });
  assert.deepEqual(candidates, [], "the `@` menu ships off: element names are layer names");
});

test("a pick builds a chip whose ref carries the file and whose model form is the pointer", async (t) => {
  const { sources, windowListeners, dispose } = loadClient();
  t.after(dispose);
  postElements(windowListeners, ELEMENTS);
  const [source] = sources;
  const picked = source.onPick({
    candidate: { name: "Hero title", value: JSON.stringify({ ref: "home__hero-title" }) },
    session: { sessionId: "s1" },
    position: "inline",
    via: "menu",
    action: "pick",
    span: { start: 0, end: 0, draftRev: 1 },
  });
  assert.equal(picked.insert.source, "justskill-canvas");
  assert.equal(picked.insert.label, "Hero title");
  assert.equal(picked.insert.appearance, "file");
  assert.equal(picked.insert.clipboardText, "@home__hero-title");
  const decoded = decodeRef(picked.insert.ref);
  assert.equal(decoded.id, "home__hero-title");
  assert.equal(decoded.uri, CANVAS_URI);
  assert.equal(decoded.pageId, "home");
  assert.equal(await source.codec.serialize(picked.insert.ref), pointer());
  assert.equal(source.codec.clipboardText(picked.insert.ref), "@home__hero-title");
});

test("only names plain text can scan reach the lexicon", (t) => {
  const { sources, windowListeners, dispose } = loadClient();
  t.after(dispose);
  postElements(windowListeners, ELEMENTS);
  const names = sources[0].lexicon({ sessionId: "s1" });
  assert.deepEqual(names, ["home__hero-title", "home__cta"]);
});

test("a pasted pointer becomes one chip at the caret", (t) => {
  const inserted = [];
  const input = {
    state: { getSnapshot: () => ({ phase: "plain", draft: "", draftRev: 3 }) },
    insertReference: (reference, span) => { inserted.push({ reference, span }); return true; },
    focus: () => {},
  };
  const loaded = loadClient({
    conversation: { input: { for: () => input } },
    sessions: { binding: () => ({ ctx: {} }) },
  });
  t.after(loaded.dispose);
  postElements(loaded.windowListeners, ELEMENTS);

  const bridge = loaded.registrations.find((entry) => entry.id === "justskill-reference-paste");
  assert.notEqual(bridge, undefined, "the composer face bridge must be registered");
  bridge.component({
    sessionId: "s1",
    inputActions: {
      captureInsertion: () => ({ start: 7, end: 7, draftRev: 3 }),
      insertText: () => false,
    },
  });

  const result = paste(loaded.windowListeners, pointer(), { path: inComposer(loaded.composerHost) });
  assert.equal(result.prevented, true, "the paste must be claimed");
  assert.equal(result.stopped, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].span.start, 7);
  assert.equal(inserted[0].span.draftRev, 3);
  assert.equal(inserted[0].reference.clipboardText, "@home__hero-title");
  assert.equal(inserted[0].reference.label, "Hero title");
  assert.equal(inserted[0].reference.appearance, "file");
  const decoded = decodeRef(inserted[0].reference.ref);
  assert.equal(decoded.uri, CANVAS_URI, "the chip keeps the file the pointer named");
  assert.equal(decoded.pageId, "home");
});

test("a locked composer takes no chip and no edit", (t) => {
  const inserted = [];
  const input = {
    state: { getSnapshot: () => ({ phase: "sending", draft: "", draftRev: 3 }) },
    insertReference: (reference) => { inserted.push(reference); return true; },
    focus: () => {},
  };
  const loaded = loadClient({
    conversation: { input: { for: () => input } },
    sessions: { binding: () => ({ ctx: {} }) },
  });
  t.after(loaded.dispose);
  postElements(loaded.windowListeners, ELEMENTS);
  loaded.registrations.find((entry) => entry.id === "justskill-reference-paste").component({
    sessionId: "s1",
    inputActions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 3 }), insertText: () => false },
  });
  const quiet = console.info;
  console.info = () => {};
  let result;
  try {
    result = paste(loaded.windowListeners, pointer(), { path: inComposer(loaded.composerHost) });
  } finally {
    console.info = quiet;
  }
  assert.equal(result.prevented, false, "the ordinary paste stays");
  assert.deepEqual(inserted, []);
});

test("an ordinary paste is left alone", (t) => {
  const loaded = loadClient();
  t.after(loaded.dispose);
  loaded.registrations.find((entry) => entry.id === "justskill-reference-paste").component({
    sessionId: "s1",
    inputActions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => false },
  });
  const prose = paste(loaded.windowListeners, "hello there", { path: inComposer(loaded.composerHost) });
  assert.equal(prose.prevented, false);
  const outside = paste(loaded.windowListeners, pointer(), { path: [] });
  assert.equal(outside.prevented, false, "a paste outside the composer keeps its meaning");
});

test("the sent pointer draws as the chip again and finds its bounds", (t) => {
  const { rules, registrations, windowListeners, dispose } = loadClient();
  t.after(dispose);
  postElements(windowListeners, ELEMENTS);
  assert.equal(rules.length, 1);
  const [rule] = rules;
  const text = `改一下 ${pointer()} 这里`;
  const node = rule.match(text, 0);
  assert.notEqual(node, undefined);
  assert.equal(node.start, "改一下 ".length);
  assert.equal(text.slice(node.start, node.end), pointer());
  assert.equal(node.data.label, "Hero title");
  const decoded = decodeRef(node.data.ref);
  assert.equal(decoded.id, "home__hero-title");
  assert.equal(decoded.uri, CANVAS_URI);
  assert.equal(rule.match("just prose", 0), undefined);

  const entry = registrations.find((item) => item.name === "conversation.user.text.node" && item.key === "justskill");
  assert.notEqual(entry, undefined, "the sent-text renderer must be registered");
  const tree = entry.component({ node: { data: node.data }, raw: pointer(), interactive: true });
  const flat = JSON.stringify(tree);
  assert.match(flat, /jsk-refchip/);
  assert.match(flat, /Hero title/);
  assert.match(flat, /Use justSkill tools/);
});

test("clicking a chip reopens the file it names", (t) => {
  const { sources, windowListeners, openedTabs, dispose } = loadClient();
  t.after(dispose);
  // The canvas on screen is a different file.
  postElements(windowListeners, ELEMENTS, "/tmp/other.html");
  const [source] = sources;
  const target = `file:///tmp/design.html${SEP}home${SEP}home__hero-title`;
  assert.equal(source.openReference({ sessionId: "s1" }, { ref: target }), true);
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.deepEqual(openedTabs.at(-1), { kind: "justskill-canvas", file: CANVAS_FILE });
      resolve();
    }, 60);
  });
});
