/**
 * test/serve.test.mjs — the canvas service, off the wire.
 *
 * The invariants this suite pins, in the order they break:
 *
 *   1. The four guards hold on every API request: a bad `Host` is 403, a foreign
 *      `Origin` is 403, a missing or wrong token is 401, a body over 4 MiB is
 *      413, a non-JSON content type is 415. Statics stay token-free, because a
 *      browser cannot put a header on a module import.
 *   2. The served-file whitelist is a Map lookup, so every whitelisted route
 *      resolves and every traversal spelling — `/lib/../package.json`,
 *      `/canvas/../../package.json`, `%2e%2e%2f` — fails with 404 or 403 and
 *      never returns a byte from outside the list. `lib/node/` is never served.
 *   3. The write path is the funnel: a valid op writes and returns a receipt, an
 *      op that adds a new error is refused with 409 and leaves the file byte
 *      identical, and a stale `baseRevision` still applies — to the current text
 *      — and reports `rebased: true`.
 *   4. SSE delivers `hello` at connect and `changed` after a write.
 *   5. A file that does not parse or does not validate is reported read-only and
 *      is still served as text.
 *   6. Undo puts the file back to its exact previous bytes, and redo re-applies.
 *
 * Every server this suite starts is closed before the test ends.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer, MAX_BODY_BYTES } from "../lib/node/server.mjs";
import { PACKAGE_ROOT, PLACEHOLDER_ROUTES, STATIC_ROUTES, buildRoutes } from "../lib/node/static.mjs";
import { revisionOf } from "../lib/node/fs.mjs";

const WORK = mkdtempSync(path.join(tmpdir(), "skill-design-serve-"));
test.after(() => rmSync(WORK, { recursive: true, force: true }));

/** A canonical design file: every attribute already in canonical order. */
const VALID = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>home</title>
  <meta name="design-schema" content="3.0">
  <style>*,*::before,*::after{box-sizing:border-box}\n*{margin:0}\nimg{display:block}\nsvg:not([data-fill]) > :not([fill]):not([stroke]){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n:root{ --color-bg:#ffffff; --space-md:16px }</style>
  <style>section[data-type="page"]{ margin:0 0 24px }</style>
</head>
<body>
  <section data-id="home" data-type="page" data-canvas="0,0" style="width:390px;height:844px;overflow:hidden">
    <div data-id="home__root" data-type="frame" style="display:flex;flex-direction:column;width:100%;height:100%">
      <p data-id="home__title" data-type="text" style="font-size:32px;font-weight:700">你好</p>
      <img data-id="home__pic" data-type="image" alt="a" src="a.png" style="width:40px;height:40px">
    </div>
  </section>
</body>
</html>
`;

/** Valid HTML that the schema rejects: no `design-schema` marker. */
const NO_MARKER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>t</title></head>
<body><section data-id="a" data-type="page" style="width:10px;height:10px"></section></body>
</html>
`;

/** A parse error, surfaced as a diagnostic: `</p>` closes nothing. */
const BAD_SYNTAX = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="design-schema" content="3.0"></head>
<body><p data-id="a" data-type="text" style="font-size:12px>hi</p></body>
</html>
`;

let counter = 0;

function fixture(text, extension = ".html") {
  counter += 1;
  const file = path.join(WORK, `case-${counter}${extension}`);
  writeFileSync(file, text, "utf8");
  return file;
}

/** Start a server for one test and always close it. */
async function withServer(file, fn, options = {}) {
  const server = await startServer({ file, port: 0, ttlMinutes: 0, ...options });
  try {
    return await fn(server);
  } finally {
    server.close("test finished");
    await server.closed;
  }
}

function urlFor(server, route, withToken = true) {
  const base = `http://127.0.0.1:${server.port}${route}`;
  if (!withToken) return base;
  return `${base}${route.includes("?") ? "&" : "?"}t=${server.token}`;
}

async function get(server, route, options = {}) {
  const res = await fetch(urlFor(server, route, options.token !== false));
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function post(server, route, payload, headers = {}) {
  const init = { method: "POST", headers: { ...headers } };
  if (payload !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(urlFor(server, route), init);
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* a refusal may not be JSON */
  }
  return { status: res.status, headers: res.headers, body, json };
}

/** A request with full control of the headers, for the Host guard. */
function rawRequest(port, requestPath, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: requestPath, headers, setHost: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/* ---------------------------------------------------------------- *
 * 1. The four guards
 * ---------------------------------------------------------------- */

test("guard: only a loopback Host is accepted", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const bad = await rawRequest(server.port, "/api/state", { headers: { Host: "evil.example" } });
    assert.equal(bad.status, 403);
    assert.equal(JSON.parse(bad.body).code, "host-not-allowed");

    const rebound = await rawRequest(server.port, "/api/state", { headers: { Host: "127.0.0.1.evil.example" } });
    assert.equal(rebound.status, 403, "a suffix that merely starts with 127.0.0.1 is not loopback");

    const ipv6 = await rawRequest(server.port, `/api/state?t=${server.token}`, { headers: { Host: "[::1]:1234" } });
    assert.equal(ipv6.status, 200);

    const named = await rawRequest(server.port, `/api/state?t=${server.token}`, { headers: { Host: `localhost:${server.port}` } });
    assert.equal(named.status, 200);

    // Static assets are behind the same Host guard.
    const staticBad = await rawRequest(server.port, "/lib/parse.mjs", { headers: { Host: "design.example" } });
    assert.equal(staticBad.status, 403);
  });
});

test("guard: a foreign Origin is refused, the same origin is allowed", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const foreign = await get(server, "/api/state", { token: true });
    assert.equal(foreign.status, 200, "no Origin at all: the CLI has none");

    const cross = await fetch(urlFor(server, "/api/state"), { headers: { Origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal((await cross.json()).code, "origin-not-allowed");

    const wrongPort = await fetch(urlFor(server, "/api/state"), { headers: { Origin: `http://127.0.0.1:${server.port + 1}` } });
    assert.equal(wrongPort.status, 403, "the origin host must equal the Host header");

    const opaque = await fetch(urlFor(server, "/api/state"), { headers: { Origin: "null" } });
    assert.equal(opaque.status, 403);

    const same = await fetch(urlFor(server, "/api/state"), { headers: { Origin: `http://127.0.0.1:${server.port}` } });
    assert.equal(same.status, 200);
  });
});

test("guard: the capability token is required on /api/* and absent from statics", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/state?t=wrong`)).status, 401);
    assert.equal((await get(server, "/api/state")).status, 200);

    const header = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { "X-Design-Token": server.token } });
    assert.equal(header.status, 200, "the header form is accepted too");

    // A module import cannot carry a header or a query string.
    const module = await fetch(`http://127.0.0.1:${server.port}/lib/parse.mjs`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type"), /javascript/);
  });
});

test("guard: the body is capped at 4 MiB and must be JSON", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const tooLarge = await fetch(urlFor(server, "/api/ops"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: revisionOf(VALID), ops: [{ op: "set", target: "home__title", prop: "style:color", value: "x".repeat(MAX_BODY_BYTES) }] }),
    });
    assert.equal(tooLarge.status, 413);

    const wrongType = await fetch(urlFor(server, "/api/ops"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ ops: [] }),
    });
    assert.equal(wrongType.status, 415);

    const badJson = await fetch(urlFor(server, "/api/ops"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);

    // A body-less POST is how undo, redo and bye are called.
    const noBody = await post(server, "/api/undo");
    assert.equal(noBody.status, 200);
    assert.equal(noBody.json.code, "history/empty");

    assert.equal(readFileSync(file, "utf8"), VALID, "no refusal wrote a byte");
  });
});

/* ---------------------------------------------------------------- *
 * 2. The static whitelist
 * ---------------------------------------------------------------- */

test("static: every whitelisted route resolves, and only those", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const routes = buildRoutes(PACKAGE_ROOT);
    assert.ok(routes.size > 10);

    // Every route the table produces has a file behind it. This used to tolerate a
    // missing one, which meant the table could not be read as a promise: "the module
    // landed" and "the module was renamed" looked the same from here.
    for (const [route, target] of routes) {
      assert.ok(existsSync(target), `${route} is listed and its file is missing`);
      const res = await get(server, route, { token: false });
      assert.equal(res.status, 200, `${route} did not resolve`);
      assert.equal(res.body, readFileSync(target, "utf8"), `${route} served different bytes`);
      assert.notEqual(res.headers.get("content-type"), "application/octet-stream", `${route} has no content type`);
    }

    // The modules the browser must be able to import directly. The canvas
    // parses and renders the file itself, so these are not optional.
    for (const name of [
      "parse.mjs", "serialize.mjs", "render.mjs", "table.mjs", "validate.mjs",
      "normalize.mjs", "diagnostics.mjs", "spans.mjs", "detect.mjs",
      "levenshtein.mjs", "ops.mjs", "fragment.mjs", "receipt.mjs", "tokens.mjs",
    ]) {
      assert.ok(routes.has(`/lib/${name}`), `/lib/${name} is not in the whitelist`);
      assert.equal((await get(server, `/lib/${name}`, { token: false })).status, 200, `/lib/${name} did not resolve`);
    }

    // The ratchet.
    //
    // `STATIC_ROUTES` is a promise that the file is there; `PLACEHOLDER_ROUTES` is a
    // promise that it is not. Both directions are checked, so neither list can quietly
    // become the other: a route added before its file is written fails here instead of
    // 404ing in a browser tab, and a placeholder whose module landed has to move up.
    for (const [route, relative] of STATIC_ROUTES) {
      const target = path.join(PACKAGE_ROOT, relative);
      assert.ok(existsSync(target), `${route} is in STATIC_ROUTES and ${relative} does not exist`);
      assert.equal((await get(server, route, { token: false })).status, 200, `${route} is listed and exists but did not resolve`);
    }
    for (const [route, relative] of PLACEHOLDER_ROUTES) {
      const target = path.join(PACKAGE_ROOT, relative);
      assert.ok(!existsSync(target), `${route} landed; move it into STATIC_ROUTES`);
      assert.equal((await get(server, route, { token: false })).status, 404, `${route} is a placeholder but answered something else`);
    }

    // Node-side modules import `node:*` and must never cross the wire.
    for (const route of ["/lib/node/cli.mjs", "/lib/node/fs.mjs", "/lib/node/server.mjs", "/lib/node/static.mjs"]) {
      assert.equal((await get(server, route, { token: false })).status, 404, `${route} is reachable`);
    }
  });
});

test("static: a traversal cannot escape the whitelist", async () => {
  const file = fixture(VALID);
  const secret = readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8");
  await withServer(file, async (server) => {
    const attempts = [
      "/lib/../package.json",
      "/canvas/../../package.json",
      "/lib/%2e%2e/package.json",
      "/../package.json",
      "/lib/..%2fpackage.json",
      "/lib/%2e%2e%2fpackage.json",
      "/canvas/%2e%2e/%2e%2e/package.json",
      "/lib/..\\package.json",
      "/lib/parse.mjs/../../package.json",
      "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    ];

    for (const attempt of attempts) {
      const res = await rawRequest(server.port, attempt, { headers: { Host: `127.0.0.1:${server.port}` } });
      assert.ok(res.status === 404 || res.status === 403, `${attempt} answered ${res.status}`);
      assert.ok(!res.body.includes(secret.slice(0, 40)), `${attempt} returned package.json`);
      assert.ok(!res.body.includes("root:"), `${attempt} returned a system file`);
    }

    // The same spellings through fetch, which normalises some of them first.
    for (const attempt of ["/lib/../package.json", "/canvas/../../package.json", "/%2e%2e%2fpackage.json"]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${attempt}`);
      assert.ok(res.status === 404 || res.status === 403, `${attempt} answered ${res.status}`);
    }
  });
});

/* ---------------------------------------------------------------- *
 * 3. The write funnel
 * ---------------------------------------------------------------- */

test("funnel: a valid op writes, returns a receipt, and bumps the revision", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const before = await get(server, "/api/state");
    const state = JSON.parse(before.body);
    assert.equal(state.readOnly, false);
    assert.equal(state.readOnlyReason, null);
    assert.equal(state.revision, revisionOf(VALID));
    assert.equal(state.canUndo, false);
    assert.ok(!state.doc, "state carries metadata, never the document");
    assert.ok(!before.body.includes("data-id"), "state never carries the document");

    const res = await post(server, "/api/ops", {
      baseRevision: revisionOf(VALID),
      ops: [{ op: "set", target: "home__title", prop: "style:font-size", value: "40px" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.rebased, false);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.applied.length, 1);
    assert.equal(res.json.inverse.length, 1);
    assert.deepEqual(res.json.diagnostics, []);
    assert.equal(res.json.canUndo, true);

    const text = readFileSync(file, "utf8");
    assert.match(text, /font-size:40px/);
    assert.equal(res.json.revision, revisionOf(text));
    assert.equal(res.headers.get("x-design-revision"), revisionOf(text), "every answer carries the revision");

    const fetched = await get(server, "/api/file");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body, text);
    assert.equal(fetched.headers.get("x-design-revision"), revisionOf(text));
    assert.match(fetched.headers.get("content-type"), /text\/plain/);
  });
});

/**
 * An edit whose inverse is a whole node still has to come back as JSON.
 *
 * Every op list is JSON-shaped except through one key: an inverse carries the
 * removed content as *live* node objects, so `applyOps` can put the exact object
 * back, and those objects hold `parent` links — a cycle through `children`.
 * Style ops hid this, because their inverse is a string: `{\"op\":\"set\",\"value\":\"40px\"}`.
 * A text op's inverse is the text node itself, so the response threw inside
 * `JSON.stringify` and answered 500 — *after* the file had been written. The
 * canvas showed "Refused: internal" for an edit that had landed, which is the
 * worst of both: the work is done and the tool says it was refused, so the next
 * thing anyone does is try again.
 */
test("a text op answers JSON, and undo of it does too", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const res = await post(server, "/api/ops", {
      baseRevision: revisionOf(readFileSync(file, "utf8")),
      ops: [{ op: "set", target: "home__title", prop: "text", value: "你好2" }],
    });

    assert.equal(res.status, 200, "a text edit is not a server error");
    assert.equal(res.json.ok, true);
    assert.equal(res.json.changed, true);
    assert.match(readFileSync(file, "utf8"), />你好2</);

    // The live half is what an in-process caller needs; the wire half has to be
    // JSON, and it has to still describe the same op.
    assert.equal(res.json.applied[0].prop, "text");
    assert.equal(res.json.inverse[0].prop, "text");
    assert.ok(!("parent" in res.json.inverse[0]), "no parent links on the wire");
    assert.doesNotThrow(() => JSON.stringify(res.json));

    const undone = await post(server, "/api/undo", {});
    assert.equal(undone.status, 200, "undoing a text edit is not a server error either");
    assert.equal(undone.json.ok, true);
    assert.match(readFileSync(file, "utf8"), />你好</);
  });
});

test("funnel: a new error is refused with 409 and the file is byte identical", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const before = readFileSync(file, "utf8");
    const res = await post(server, "/api/ops", {
      baseRevision: revisionOf(before),
      ops: [{ op: "unset", target: "home__pic", prop: "alt" }],
    });

    assert.equal(res.status, 409);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, "cli/would-introduce-errors");
    assert.equal(res.json.changed, false);
    assert.ok(res.json.diagnostics.some((d) => d.code === "a11y/missing-alt"), JSON.stringify(res.json.diagnostics));
    assert.ok(res.json.diagnostics.every((d) => d.severity === "error"));
    assert.equal(readFileSync(file, "utf8"), before, "a refusal must not write");

    // The refusal names what to write instead: a fix, a hint or an explicit code.
    const named = res.json.diagnostics[0];
    assert.ok(named.code && named.message, "a refusal must name the problem");

    // A bad op is refused the same way, without touching the file.
    const bad = await post(server, "/api/ops", { ops: [{ op: "frobnicate", target: "home__title" }] });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.ok, false);
    assert.ok(bad.json.code.startsWith("ops/"), bad.json.code);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("funnel: a stale baseRevision is rebased onto the current text", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    // Another writer — the agent — edits the file between the canvas's read and
    // its op. The stale revision must not stop the op, and must not revert it.
    const external = VALID.replace("你好", "你好，世界");
    writeFileSync(file, external, "utf8");

    const res = await post(server, "/api/ops", {
      baseRevision: revisionOf(VALID),
      ops: [{ op: "set", target: "home__title", prop: "style:color", value: "#111111" }],
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.rebased, true);
    const text = readFileSync(file, "utf8");
    assert.match(text, /你好，世界/, "the agent's edit survived the canvas op");
    assert.match(text, /color:#111111/, "the op was applied to the current text");
    assert.equal(res.json.revision, revisionOf(text));
  });
});

/* ---------------------------------------------------------------- *
 * 4. SSE
 * ---------------------------------------------------------------- */

test("sse: hello at connect, changed after a write", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const decoder = new TextDecoder();
    const controller = new AbortController();
    const res = await fetch(urlFor(server, "/api/events"), { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    const reader = res.body.getReader();
    let buffer = "";
    const readUntil = async (needle) => {
      const deadline = Date.now() + 4000;
      while (!buffer.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}: ${JSON.stringify(buffer)}`);
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil("event: hello");
    const hello = buffer.slice(0, buffer.indexOf("\n\n"));
    assert.match(hello, /^event: hello\ndata: \{/);
    const helloData = JSON.parse(hello.split("\n")[1].slice("data: ".length));
    assert.equal(helloData.file, path.basename(file));
    assert.equal(helloData.revision, revisionOf(VALID));

    const write = await post(server, "/api/ops", {
      baseRevision: revisionOf(VALID),
      ops: [{ op: "set", target: "home__title", prop: "style:font-size", value: "44px" }],
    });
    assert.equal(write.status, 200);

    await readUntil("event: changed");
    const frames = buffer.split("\n\n").filter(Boolean).map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "));
      const data = lines.find((line) => line.startsWith("data: "));
      return { event: event ? event.slice("event: ".length) : null, data: data ? JSON.parse(data.slice("data: ".length)) : null };
    });
    const changed = frames.find((frame) => frame.event === "changed");
    assert.ok(changed, `no changed frame in ${JSON.stringify(buffer)}`);
    assert.equal(changed.data.revision, write.json.revision);
    assert.equal(changed.data.reason, "ops");

    controller.abort();
  });
});

/* ---------------------------------------------------------------- *
 * 5. Read-only reporting
 * ---------------------------------------------------------------- */

test("state: a file that does not parse or does not validate is read-only", async () => {
  const broken = fixture(BAD_SYNTAX);
  await withServer(broken, async (server) => {
    const res = await get(server, "/api/state");
    assert.equal(res.status, 200, "a broken file must not stop the service");
    const state = JSON.parse(res.body);
    assert.equal(state.readOnly, true);
    assert.ok(typeof state.readOnlyReason === "string" && state.readOnlyReason.length > 0);
    assert.equal(state.revision, revisionOf(BAD_SYNTAX));

    // The text is still served, so the canvas can show what is there.
    const text = await get(server, "/api/file");
    assert.equal(text.status, 200);
    assert.equal(text.body, BAD_SYNTAX);
  });

  const noMarker = fixture(NO_MARKER);
  await withServer(noMarker, async (server) => {
    const state = JSON.parse((await get(server, "/api/state")).body);
    assert.equal(state.readOnly, true);
    assert.match(state.readOnlyReason, /version\/missing-marker/);
  });

  const good = fixture(VALID);
  await withServer(good, async (server) => {
    const state = JSON.parse((await get(server, "/api/state")).body);
    assert.equal(state.readOnly, false);
    assert.equal(state.readOnlyReason, null);
  });

  // A file no reader can open yet is still served as text, read-only.
  const pen = '{"version":"2.0","children":[]}';
  const unreadable = fixture(pen, ".pen");
  await withServer(unreadable, async (server) => {
    const res = await get(server, "/api/state");
    assert.equal(res.status, 200);
    const state = JSON.parse(res.body);
    assert.equal(state.readOnly, true);
    assert.ok(state.readOnlyReason.length > 0);
    assert.equal((await get(server, "/api/file")).body, pen);
  });
});

/* ---------------------------------------------------------------- *
 * 6. Undo and redo
 * ---------------------------------------------------------------- */

test("history: undo restores the exact previous bytes, redo re-applies", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const before = readFileSync(file, "utf8");
    const write = await post(server, "/api/ops", {
      baseRevision: revisionOf(before),
      ops: [
        { op: "set", target: "home__title", prop: "style:font-size", value: "40px" },
        { op: "set", target: "home__title", prop: "style:color", value: "#111111" },
      ],
    });
    assert.equal(write.status, 200);
    const after = readFileSync(file, "utf8");
    assert.notEqual(after, before);

    const undo = await post(server, "/api/undo");
    assert.equal(undo.status, 200);
    assert.equal(undo.json.ok, true);
    assert.equal(undo.json.changed, true);
    assert.equal(readFileSync(file, "utf8"), before, "undo must restore the exact bytes");
    assert.equal(undo.json.revision, revisionOf(before));

    const redo = await post(server, "/api/redo");
    assert.equal(redo.status, 200);
    assert.equal(redo.json.ok, true);
    assert.equal(readFileSync(file, "utf8"), after, "redo must re-apply the same bytes");

    const empty = await post(server, "/api/undo");
    assert.equal(empty.json.ok, true);
    const twice = await post(server, "/api/undo");
    assert.equal(twice.json.ok, false);
    assert.equal(twice.json.code, "history/empty");
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("state: canUndo and canRedo follow the stacks", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const op = { baseRevision: revisionOf(VALID), ops: [{ op: "set", target: "home__title", prop: "style:font-size", value: "40px" }] };
    await post(server, "/api/ops", op);
    let state = JSON.parse((await get(server, "/api/state")).body);
    assert.equal(state.canUndo, true);
    assert.equal(state.canRedo, false);

    await post(server, "/api/undo");
    state = JSON.parse((await get(server, "/api/state")).body);
    assert.equal(state.canUndo, false);
    assert.equal(state.canRedo, true);

    await post(server, "/api/redo");
    state = JSON.parse((await get(server, "/api/state")).body);
    assert.equal(state.canUndo, true);
    assert.equal(state.canRedo, false);
  });
});

/* ---------------------------------------------------------------- *
 * 7. Whole-text save, and closing
 * ---------------------------------------------------------------- */

test("save: writes a whole text, refuses a new error, and repairs a broken file", async () => {
  const file = fixture(BAD_SYNTAX);
  await withServer(file, async (server) => {
    assert.equal(JSON.parse((await get(server, "/api/state")).body).readOnly, true);

    // Valid HTML with one deliberate defect: the image has no alt.
    const noAlt = VALID.replace(' alt="a"', "");
    const refused = await post(server, "/api/save", { baseRevision: revisionOf(BAD_SYNTAX), text: noAlt });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "cli/would-introduce-errors");
    assert.ok(refused.json.diagnostics.some((d) => d.code === "a11y/missing-alt"));
    assert.equal(readFileSync(file, "utf8"), BAD_SYNTAX, "a refused save must not write");

    const repaired = await post(server, "/api/save", { baseRevision: revisionOf(BAD_SYNTAX), text: VALID });
    assert.equal(repaired.status, 200);
    assert.equal(repaired.json.ok, true);
    assert.equal(repaired.json.changed, true);
    assert.equal(readFileSync(file, "utf8"), VALID);

    const state = JSON.parse((await get(server, "/api/state")).body);
    assert.equal(state.readOnly, false);
    assert.equal(state.canUndo, false, "a whole-text save clears the op history");

    const missing = await post(server, "/api/save", { text: 42 });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "save/no-text");
  });
});

test("lifecycle: /api/bye closes the service, and close() is idempotent", async () => {
  const file = fixture(VALID);
  const server = await startServer({ file, port: 0, ttlMinutes: 0 });
  const bye = await post(server, "/api/bye");
  assert.equal(bye.status, 200);
  assert.equal(bye.json.ok, true);

  const reason = await Promise.race([
    server.closed,
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 3000)),
  ]);
  assert.equal(reason, "the browser closed the canvas");

  server.close("again");
  await server.closed;

  await assert.rejects(fetch(urlFor(server, "/api/state")));
});

test("lifecycle: the idle timer closes a server nobody is using", async () => {
  const file = fixture(VALID);
  const server = await startServer({ file, port: 0, ttlMinutes: 0.002 }); // 120 ms
  const reason = await Promise.race([
    server.closed,
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 4000)),
  ]);
  assert.match(String(reason), /idle for/, `expected an idle close, got ${reason}`);
  server.close("test finished");
});

/* ---------------------------------------------------------------- *
 * 7. Export: the canvas cannot write files, so the service does
 * ---------------------------------------------------------------- */

test("export: writes <page>.export.html next to the design file", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const { status, json: body } = await post(server, "/api/export", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].page, "home");

    // `<pageId>.html` would be ambiguous: in this format the design file is an HTML file
    // too, so a sibling `home.html` could be a deliverable or another design.
    assert.equal(path.basename(body.files[0].path), "home.export.html");
    const written = readFileSync(body.files[0].path, "utf8");
    assert.ok(written.startsWith("<!doctype html>"), written.slice(0, 40));
    assert.match(written, /你好/);

    // A deliverable is a document, not a design file. Every `data-id`, `data-type`,
    // `data-canvas` and the schema marker are addressing this format invented, and a
    // browser has no use for them: they are scaffolding, and shipping them would hand
    // the reader a file that looks like a design.
    for (const scaffolding of ["data-id", "data-type", "data-canvas"]) {
      // In attribute position. `section[data-type="page"]` is a selector in the page-frame
      // rule, which the deliverable carries on purpose — it is what makes a page a page.
      assert.ok(!new RegExp(`\\s${scaffolding}="`).test(written), `an export must not carry ${scaffolding} as an attribute`);
    }
    assert.ok(!written.includes("design-schema"), "an export must not claim to be a design file");
  });
});

test("export: --all writes one file per page and skips the library page", async () => {
  const withLibrary = VALID.replace(
    "</body>",
    '  <section data-id="kit" data-type="page" data-library="true" style="width:390px;height:844px"></section>\n</body>',
  );
  const file = fixture(withLibrary);
  await withServer(file, async (server) => {
    const { status, json: body } = await post(server, "/api/export", { all: true });
    assert.equal(status, 200);
    assert.deepEqual(body.files.map((entry) => entry.page), ["home"]);
  });
});

test("export: the same bytes as the command line, for the same page", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    const { json: body } = await post(server, "/api/export", {});
    const fromCanvas = readFileSync(body.files[0].path, "utf8");

    // The deliverable is the point of the whole tool, so the two doors have to lead to
    // the same room: the service calls `lib/export-html.mjs`, exactly what the verb calls.
    const { exportPage } = await import("../lib/export-html.mjs");
    const { parse } = await import("../lib/parse.mjs");
    const fromCli = exportPage(parse(VALID), {}).html;
    assert.equal(fromCanvas, fromCli);
  });
});

test("export: every refusal path answers with its own code", async () => {
  const file = fixture(VALID);
  await withServer(file, async (server) => {
    // No capability token, on a POST that writes files.
    const noToken = await fetch(`http://127.0.0.1:${server.port}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noToken.status, 401);

    // A foreign Origin.
    const foreign = await post(server, "/api/export", {}, { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);

    // GET is not a way to write a file.
    const wrongMethod = await get(server, "/api/export");
    assert.equal(wrongMethod.status, 405);

    // A body that is not JSON. The content type is only judged when there is a body:
    // a body-less POST is how undo, redo and bye are called.
    const wrongType = await fetch(urlFor(server, "/api/export"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({}),
    });
    assert.equal(wrongType.status, 415);

    // The body cap is shared with /api/ops, and a route that writes files must not be a
    // way around it.
    const tooLarge = await fetch(urlFor(server, "/api/export"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "x".repeat(MAX_BODY_BYTES) }),
    });
    assert.equal(tooLarge.status, 413);

    // A page that does not exist.
    const unknownPage = await post(server, "/api/export", { page: "nope" });
    assert.equal(unknownPage.status, 409);
    assert.equal(unknownPage.json.code, "export/unknown-page");
    assert.match(unknownPage.json.hint, /home/);
  });
});

test("export: a file that does not parse is refused with its diagnostics", async () => {
  const file = fixture(BAD_SYNTAX);
  await withServer(file, async (server) => {
    const { status, json: body } = await post(server, "/api/export", {});
    assert.equal(status, 409);
    assert.equal(body.code, "export/read-only");
    assert.ok(Array.isArray(body.diagnostics) && body.diagnostics.length > 0, "the refusal names what is wrong");
  });
});

/**
 * The one target an export may never write.
 *
 * A page id and a file name line up often enough — a design called `home.export.html`
 * whose first page is `home` — and without the guard the export replaces the design with
 * its own deliverable. That is unrecoverable: the design is the only copy of the intent.
 */
test("export: it refuses to write over the design file itself", async () => {
  // Named so that page `home`'s export target is the design file itself.
  const file = path.join(WORK, "home.export.html");
  writeFileSync(file, VALID, "utf8");
  await withServer(file, async (server) => {
    const before = readFileSync(file, "utf8");
    const { status, json: body } = await post(server, "/api/export", {});
    assert.equal(status, 409);
    assert.equal(body.code, "export/would-overwrite-design");
    assert.equal(readFileSync(file, "utf8"), before, "the design file must be untouched");
  });
});
