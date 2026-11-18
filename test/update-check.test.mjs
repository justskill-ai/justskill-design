import assert from "node:assert/strict";
import test from "node:test";

import {
  checkForUpdate,
  clearUpdateCheckCache,
  compareSemver,
  decideUpdate,
  highestTagVersion,
  normalizeVersion,
  npmLatestVersion,
  readLocalVersion,
  UPDATE_CHECK,
} from "../lib/node/update-check.mjs";

test("normalizeVersion accepts plain and v-prefixed semver", () => {
  assert.equal(normalizeVersion("3.2.3"), "3.2.3");
  assert.equal(normalizeVersion("v3.2.3"), "3.2.3");
  assert.equal(normalizeVersion("V1.0.0-rc.1"), "1.0.0-rc.1");
  assert.equal(normalizeVersion("latest"), null);
  assert.equal(normalizeVersion(""), null);
  assert.equal(normalizeVersion(null), null);
});

test("compareSemver orders core and prerelease the semver way", () => {
  assert.equal(compareSemver("3.2.2", "3.2.3"), -1);
  assert.equal(compareSemver("3.2.3", "3.2.3"), 0);
  assert.equal(compareSemver("3.10.0", "3.9.9"), 1);
  assert.equal(compareSemver("3.2.3-rc.1", "3.2.3"), -1);
  assert.equal(compareSemver("3.2.3", "3.2.3-rc.1"), 1);
  assert.equal(compareSemver("3.2.3-rc.1", "3.2.3-rc.2"), -1);
});

test("highestTagVersion picks the greatest tag, not the first", () => {
  assert.equal(highestTagVersion([
    { name: "v3.1.0" },
    { name: "v3.2.3" },
    { name: "not-a-version" },
    { name: "v3.2.2" },
  ]), "3.2.3");
  assert.equal(highestTagVersion([]), null);
  assert.equal(highestTagVersion(null), null);
});

test("npmLatestVersion reads the registry payload", () => {
  assert.equal(npmLatestVersion({ version: "3.2.2" }), "3.2.2");
  assert.equal(npmLatestVersion({ version: "nope" }), null);
  assert.equal(npmLatestVersion(null), null);
});

test("decideUpdate prefers GitHub over npm and only flags a newer remote", () => {
  assert.deepEqual(decideUpdate({
    local: "3.2.3",
    github: "3.2.3",
    npm: "9.9.9",
    now: 10,
  }), {
    local: "3.2.3",
    latest: "3.2.3",
    source: "github",
    updateAvailable: false,
    checkedAt: 10,
  });

  assert.deepEqual(decideUpdate({
    local: "3.2.3",
    github: null,
    npm: "3.3.0",
    now: 11,
  }), {
    local: "3.2.3",
    latest: "3.3.0",
    source: "npm",
    updateAvailable: true,
    checkedAt: 11,
  });

  assert.deepEqual(decideUpdate({
    local: "3.2.3",
    github: null,
    npm: null,
    now: 12,
  }), {
    local: "3.2.3",
    latest: null,
    source: null,
    updateAvailable: false,
    checkedAt: 12,
  });
});

test("readLocalVersion matches package.json", () => {
  const version = readLocalVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("checkForUpdate uses GitHub tags first and caches the result", async () => {
  clearUpdateCheckCache();
  let githubCalls = 0;
  let npmCalls = 0;
  const result = await checkForUpdate({
    now: 1_000,
    cacheMs: 60_000,
    fetchGithub: async () => {
      githubCalls += 1;
      return [{ name: "v3.3.0" }, { name: "v3.2.9" }];
    },
    fetchNpm: async () => {
      npmCalls += 1;
      return { version: "9.9.9" };
    },
  });
  assert.equal(result.latest, "3.3.0");
  assert.equal(result.source, "github");
  assert.equal(result.updateAvailable, compareSemver("3.3.0", result.local) > 0);
  assert.equal(githubCalls, 1);
  assert.equal(npmCalls, 0, "npm is not consulted when GitHub answers");

  const cached = await checkForUpdate({
    now: 1_000 + 1_000,
    cacheMs: 60_000,
    fetchGithub: async () => {
      githubCalls += 1;
      return [{ name: "v9.9.9" }];
    },
    fetchNpm: async () => {
      npmCalls += 1;
      return { version: "9.9.9" };
    },
  });
  assert.equal(cached.latest, "3.3.0");
  assert.equal(githubCalls, 1);
  assert.equal(npmCalls, 0);
});

test("checkForUpdate falls back to npm when GitHub fails", async () => {
  clearUpdateCheckCache();
  const result = await checkForUpdate({
    now: 2_000,
    force: true,
    fetchGithub: async () => null,
    fetchNpm: async () => ({ version: "3.4.0" }),
  });
  assert.equal(result.latest, "3.4.0");
  assert.equal(result.source, "npm");
  assert.equal(result.updateAvailable, compareSemver("3.4.0", result.local) > 0);
});

test("checkForUpdate stays quiet when every remote fails", async () => {
  clearUpdateCheckCache();
  const result = await checkForUpdate({
    now: 3_000,
    force: true,
    fetchGithub: async () => {
      throw new Error("network down");
    },
    fetchNpm: async () => null,
  });
  assert.equal(result.latest, null);
  assert.equal(result.source, null);
  assert.equal(result.updateAvailable, false);
  assert.equal(typeof result.local, "string");
});

test("UPDATE_CHECK exposes the remote URLs the product named", () => {
  assert.match(UPDATE_CHECK.githubTagsUrl, /justskill-ai\/justskill-design\/tags/);
  assert.match(UPDATE_CHECK.npmLatestUrl, /registry\.npmjs\.org\/justskill-design\/latest/);
});
