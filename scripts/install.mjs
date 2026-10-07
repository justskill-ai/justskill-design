#!/usr/bin/env node
/**
 * Link this repository into a skills directory.
 *
 * A symlink, not a copy: edit the repository and every installed skill follows.
 * That is the same reason the project has no build step — the thing on disk is
 * the thing that runs.
 *
 *   node scripts/install.mjs              link into ~/.agents/skills and ~/.claude/skills
 *   node scripts/install.mjs --uninstall  remove what this linked
 *   node scripts/install.mjs --dry-run    print what it would do
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NAME = "skill-design";
const HOME = os.homedir();

const argv = process.argv.slice(2);
const doUninstall = argv.includes("--uninstall");
const dryRun = argv.includes("--dry-run");

function linkTargets() {
  const agents = path.join(HOME, ".agents", "skills");
  const claude = path.join(HOME, ".claude", "skills");
  return [
    { from: path.join(agents, NAME), to: ROOT, via: "~/.agents/skills" },
    { from: path.join(claude, NAME), to: path.join(agents, NAME), via: "~/.claude/skills" },
  ];
}

function describe(entry) {
  try {
    const stat = fs.lstatSync(entry.from);
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(entry.from), fs.readlinkSync(entry.from));
      return { kind: "symlink", correct: resolved === entry.to, resolved };
    }
    return { kind: stat.isDirectory() ? "directory" : "file" };
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function install() {
  let changed = 0;
  for (const entry of linkTargets()) {
    const state = describe(entry);
    if (state.kind === "symlink" && state.correct) {
      console.log(`ok        ${entry.from} -> ${entry.to}`);
      continue;
    }
    if (state.kind !== "absent") {
      console.log(`SKIPPED   ${entry.from} exists (${state.kind}). Remove it yourself, or use --uninstall if this tool linked it.`);
      continue;
    }
    if (dryRun) {
      console.log(`would     ${entry.from} -> ${entry.to}`);
      continue;
    }
    fs.mkdirSync(path.dirname(entry.from), { recursive: true });
    fs.symlinkSync(entry.to, entry.from, "dir");
    console.log(`linked    ${entry.from} -> ${entry.to}`);
    changed += 1;
  }
  console.log("");
  console.log(changed ? "Installed." : "Nothing to do.");
}

function uninstall() {
  for (const entry of linkTargets()) {
    const state = describe(entry);
    if (state.kind !== "symlink") {
      console.log(`nothing   ${entry.from} (${state.kind})`);
      continue;
    }
    if (dryRun) {
      console.log(`would remove ${entry.from}`);
      continue;
    }
    fs.unlinkSync(entry.from);
    console.log(`removed   ${entry.from}`);
  }
}

console.log(`${doUninstall ? "Uninstalling" : "Installing"} ${NAME} from ${ROOT}\n`);
if (doUninstall) uninstall();
else install();
