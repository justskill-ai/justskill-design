#!/usr/bin/env node
// evals/grade.mjs — first-round pass-rate measuring tool for skill-design v2.
//
//   node evals/grade.mjs [options]
//
//     --cli <path>     design.mjs to measure (default: ./design.mjs)
//     --only <ids>     comma-separated snippet stems or eval ids, e.g. s01,s05,11
//     --json <path>    write the collected receipts here
//     --raw            when no insert verb exists, splice the snippet by raw
//                      text edit and still run `validate` (off by default)
//     --clean          delete the temp workspace when finished
//     --quiet          table only
//     --help
//
// What it does, per eval in evals/evals.json:
//   1. copy evals/starter.html into a fresh temp directory
//   2. insert evals/snippets/sNN.html into <div data-id="home__slot"> using the
//      CLI's `add` verb (see INSERT_FORMS)
//   3. run `validate` and collect the receipt as JSON
//   4. decide "first-round pass" (see judge() — the rule is written out there)
//
// It ALWAYS exits 0. This is a measuring tool, not a gate. A verb that does not
// exist yet produces SKIP, never a crash and never a guessed verdict.
//
// Zero dependencies, pure ESM, Node >= 18.
//
// Self-test without a real CLI:
//   node evals/grade.mjs --cli evals/selftest/stub-cli.mjs

import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STARTER = join(HERE, "starter.html");
const EVALS_JSON = join(HERE, "evals.json");

// The snippet is inserted as the last child of this element in starter.html.
const INSERT_PARENT = "home__slot";

// Candidate command shapes for insertion, tried in order. The verb surface is
// not frozen yet, so the first shape that inserts the clean control snippet
// (eval 11, `footer`) wins; if none does, every row is SKIPped with a hint.
// The real spelling first, then older guesses, so this file keeps working if the
// verb surface moves. `add` reads a literal fragment from --html, and --in names
// the parent. A snippet may contain newlines and quotes: it is passed as one argv
// entry, never through a shell.
// The first argument is the snippet's PATH and the second is the design file, so
// a form must read the snippet itself. The real spelling is
// `add <file> --html <fragment> --in <parent>`; the rest are older guesses kept
// so this file keeps working if the verb surface moves.
const INSERT_FORMS = [
  (snipPath, file) => ["add", file, "--html", readFileSync(snipPath, "utf8"), "--in", INSERT_PARENT],
  (snipPath, file) => ["add", file, "--html", readFileSync(snipPath, "utf8"), "--parent", INSERT_PARENT],
  (snipPath, file) => ["add", file, "--html-file", snipPath, "--in", INSERT_PARENT],
  (snipPath, file) => ["add", file, "--file", snipPath, "--parent", INSERT_PARENT],
  (snipPath, file) => ["insert", file, "--html", readFileSync(snipPath, "utf8"), "--in", INSERT_PARENT],
];

const MISSING_VERB_RE =
  /(unknown|unrecognized|unsupported|no such|not a|invalid|missing)\s+(verb|command|subcommand)|(verb|command)\s+["'`]?[a-z-]+["'`]?\s+(not found|unknown|does not exist)|未知|不支持|没有(这个)?(动词|命令)/i;

const CONTROL_EVAL_ID = 11; // the deliberately clean snippet

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);

function opt(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const HELP = argv.includes("--help") || argv.includes("-h");
const CLI = resolve(ROOT, String(opt("--cli", "design.mjs")));
const ONLY = opt("--only", null);
const JSON_OUT = opt("--json", null);
const RAW = argv.includes("--raw");
const CLEAN = argv.includes("--clean");
const QUIET = argv.includes("--quiet");

if (HELP) {
  process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(0);
}

// ------------------------------------------------------------------ helpers

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function runNode(args, { cwd = ROOT } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) return { code: 124, stdout: "", stderr: String(r.error.message), spawnError: true };
  return {
    code: r.status === null ? 124 : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    spawnError: false,
  };
}

const runCli = (args, opts) => runNode([CLI, ...args], opts);

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Pull JSON out of CLI output, tolerating log lines around it. */
function parseReceiptOutput(res) {
  const out = (res.stdout || "").trim();
  const direct = tryJson(out);
  if (direct) return { json: direct, shape: "stdout-json" };
  const a = res.stdout.indexOf("{");
  const b = res.stdout.lastIndexOf("}");
  if (a !== -1 && b > a) {
    const j = tryJson(res.stdout.slice(a, b + 1));
    if (j) return { json: j, shape: "embedded-json" };
  }
  const err = (res.stderr || "").trim();
  const ej = tryJson(err);
  if (ej) return { json: ej, shape: "stderr-json" };
  return { json: null, shape: "unparsed-text" };
}

function pick(obj, names) {
  if (obj === null || typeof obj !== "object") return undefined;
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  return undefined;
}

/**
 * Turn a receipt of unknown shape into the five fields the table needs.
 * Unknown shapes are kept verbatim in the JSON dump, never discarded.
 */
function normalizeReceipt(json) {
  const empty = {
    diagnostics: [], dropped: [], normalized: [], generatedIds: [], groupCodes: [],
    ok: null, raw: json ?? null,
  };
  if (!json || typeof json !== "object") return empty;
  const root = (json.receipt && typeof json.receipt === "object" && json.receipt) ||
    (json.result && typeof json.result === "object" && json.result) || json;

  const dRaw = pick(root, ["diagnostics", "errors", "problems", "issues", "messages"]) ??
    pick(json, ["diagnostics", "errors"]) ?? [];
  const diagnostics = (Array.isArray(dRaw) ? dRaw : []).map((d) => ({
    code: String(pick(d, ["code", "id", "kind"]) ?? ""),
    severity: String(pick(d, ["severity", "level"]) ?? "error"),
    target: String(pick(d, ["target", "dataId", "node"]) ?? ""),
    path: String(pick(d, ["path"]) ?? ""),
    offset: pick(d, ["offset", "index"]) ?? null,
    message: String(pick(d, ["message", "msg", "text"]) ?? ""),
  }));

  // `groups` is the grouped-by-code view; it is the only place a code can
  // appear when the receipt lists counts without individual diagnostics.
  const gRaw = pick(root, ["groups", "grouped"]) ?? [];
  const groupCodes = (Array.isArray(gRaw) ? gRaw : []).map((g) => String(pick(g, ["code"]) ?? "")).filter(Boolean);

  const fmt = (x) => {
    if (x === null || x === undefined) return "";
    if (typeof x === "string") return x;
    if (typeof x !== "object") return String(x);
    const prop = pick(x, ["property", "prop", "name", "declaration"]) ?? "";
    const from = pick(x, ["from", "raw", "before", "rawValue", "input"]);
    const to = pick(x, ["to", "value", "after", "normalized", "output"]);
    const code = pick(x, ["code", "reason"]) ?? "";
    if (prop && (from !== undefined || to !== undefined)) {
      return `${prop}:${from ?? "?"}→${to ?? "?"}${code ? ` [${code}]` : ""}`;
    }
    if (code && !prop) return String(code);
    return clip(JSON.stringify(x), 90);
  };

  const list = (v) => (Array.isArray(v) ? v.map(fmt).filter(Boolean) : v ? [String(v)] : []);

  // When the receipt carries no explicit dropped/normalized arrays (today's CLI
  // reports everything as diagnostics), derive the two columns from the codes.
  // Explicit arrays always win.
  const asRow = (d) => `${d.code}${d.target ? ` @${d.target}` : ""}${d.message ? ` — ${d.message}` : ""}`;
  const derivedDropped = diagnostics
    .filter((d) => /(rejected|unsupported|unknown|dropped|ignored|not-allowed)/.test(d.code))
    .map(asRow);
  const derivedNormalized = diagnostics
    .filter((d) => /(alias|normaliz|shorthand|rewrit|converted|expanded)/.test(d.code))
    .map(asRow);

  const dropped = list(pick(root, ["dropped", "droppedDeclarations", "drops", "rejected", "refusals"]) ??
    pick(json, ["dropped", "droppedDeclarations"]));
  const normalized = list(pick(root, ["normalized", "normalizedValues", "normalizations", "changes"]) ??
    pick(json, ["normalized", "normalizedValues"]));

  return {
    diagnostics,
    groupCodes,
    ok: typeof root.ok === "boolean" ? root.ok : null,
    dropped: dropped.length ? dropped : derivedDropped,
    normalized: normalized.length ? normalized : derivedNormalized,
    generatedIds: list(pick(root, ["generatedIds", "autoIds", "filledIds", "generated", "addedIds"]) ??
      pick(json, ["generatedIds", "autoIds"])),
    raw: json,
  };
}

/** Fallback when the receipt is not JSON at all: scrape diagnostic codes. */
function scrapeCodes(text) {
  const codes = new Set();
  for (const m of String(text).matchAll(/\b([a-z]+\/[a-z0-9-]+)\b/g)) codes.add(m[1]);
  return [...codes];
}

// ------------------------------------------------------------------ verbs

function verbListing() {
  const h = runCli(["--help"]);
  const text = `${h.stdout}\n${h.stderr}`;
  const verbs = new Set();
  for (const line of text.split("\n")) {
    // matches both "  validate <file> [--json]" and "  validate     check a file"
    const m = /^\s{2,4}([a-z][a-z0-9-]{1,24})(?:\s{2,}.*|\s+[<[].*|\s*)$/.exec(line);
    if (m) verbs.add(m[1]);
  }
  return { verbs, exit: h.code };
}

/**
 * The per-verb probe is authoritative; the `--help` listing is only displayed.
 * A CLI can advertise a verb it has not wired up yet, and a verb can exist
 * without being listed, so the probe decides.
 */
function verbExists(verb) {
  const r = runCli([verb, "--help"]);
  if (r.spawnError) return false;
  if (MISSING_VERB_RE.test(r.stderr) || MISSING_VERB_RE.test(r.stdout)) return false;
  return true;
}

// ------------------------------------------------------------------ workspace

let WORK = null;
function workspace() {
  if (!WORK) {
    mkdirSync(join(tmpdir(), "skill-design-evals"), { recursive: true });
    WORK = mkdtempSync(join(tmpdir(), "skill-design-evals", "run-"));
  }
  return WORK;
}

/**
 * Raw text insertion used only with --raw, and only to keep the measuring tool
 * useful while the add verb is still being written. It splices the snippet in
 * just before the closing tag of INSERT_PARENT. It performs no normalization
 * and claims none.
 */
function spliceByText(file, snippet) {
  const src = readFileSync(file, "utf8");
  const open = src.indexOf(`data-id="${INSERT_PARENT}"`);
  if (open === -1) throw new Error(`no data-id="${INSERT_PARENT}" in starter`);
  // find the end of the opening tag, then the matching close of that div
  const openEnd = src.indexOf(">", open) + 1;
  let depth = 1;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = openEnd;
  let m;
  while ((m = re.exec(src))) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) {
      const at = m.index;
      const out = `${src.slice(0, at)}${snippet.trimEnd()}\n      ${src.slice(at)}`;
      writeFileSync(file, out, "utf8");
      return true;
    }
  }
  throw new Error(`unbalanced <div> for ${INSERT_PARENT}`);
}

// ------------------------------------------------------------------ judging

/**
 * FIRST-ROUND PASS — the rule, in full:
 *
 *   A row passes when the tool's FIRST response is actionable and complete:
 *     a) the run finished with a documented exit code (0 accepted, 1 rejected);
 *        a crash, a timeout or exit 2 fails the row;
 *     b) the output is a receipt we can read — parsed JSON, or text containing
 *        at least one recognizable `prefix/code` diagnostic;
 *     c) if the tool reported errors, every error diagnostic names something:
 *        a non-empty code AND a target, path or offset. A bare "invalid" fails;
 *     d) if the tool reported no errors, nothing may be dropped without a
 *        receipt entry: every dropped declaration must carry a code or a
 *        property name.
 *
 *   Deliberately defective snippets can therefore pass — they pass by being
 *   REFUSED with a nameable code. What fails is a silent drop, a crash, or a
 *   verdict that names nothing. The per-eval `assertions` in evals.json carry
 *   the content-level checks; this rule only measures first-round legibility.
 */
function judge({ insert, validate, receipt, shape, codes, refusal }) {
  const reasons = [];
  // A non-zero insert exit is not a failure on its own. A defective snippet is
  // SUPPOSED to be refused, and a refusal changes no file, so the explanation
  // lives in the insert's own output rather than in what `validate` says about
  // the untouched file. The exit code only counts against the run when nothing
  // explained it.
  if (insert && insert.code !== 0 && !refusal) reasons.push(`insert exit ${insert.code} with no readable refusal`);
  if (refusal && !refusal.legible) reasons.push(`the refusal names nothing (${refusal.shape})`);

  const v = validate;
  if (v.spawnError) reasons.push("validate crashed or timed out");
  else if (v.code !== 0 && v.code !== 1) reasons.push(`validate exit ${v.code} (expected 0 or 1)`);

  const haveReceipt = Boolean(receipt) || (codes && codes.length > 0);
  if (!haveReceipt) reasons.push(`no readable receipt (${shape})`);

  const errors = (receipt?.diagnostics ?? []).filter((d) => String(d.severity).toLowerCase() !== "warning");
  if (receipt && errors.length > 0) {
    // "names something" = a code plus a target, a path or a human message.
    const unnamed = errors.filter((d) => !d.code || (!d.target && !d.path && !d.message));
    if (unnamed.length > 0) reasons.push(`${unnamed.length} error diagnostic(s) name nothing`);
  }
  if (receipt && errors.length === 0) {
    const badDrop = (receipt.dropped ?? []).filter((s) => !s || !String(s).trim());
    if (badDrop.length > 0) reasons.push("dropped declaration with no receipt entry");
  }
  return { pass: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ main

function main() {
  if (!existsSync(EVALS_JSON)) {
    process.stdout.write(`SKIP all: missing ${EVALS_JSON}\n0/0 = 0%\n`);
    return;
  }
  const spec = JSON.parse(readFileSync(EVALS_JSON, "utf8"));
  let evals = Array.isArray(spec.evals) ? spec.evals : [];

  if (ONLY && typeof ONLY === "string") {
    const want = new Set(ONLY.split(",").map((s) => s.trim()).filter(Boolean));
    evals = evals.filter((e) => {
      const stem = (e.files?.[0] ?? "").split("/").pop()?.replace(/\.html$/, "") ?? "";
      return want.has(stem) || want.has(String(e.id)) || want.has(e.name);
    });
  }

  const cliExists = existsSync(CLI);
  const listed = cliExists ? verbListing() : { verbs: new Set(), exit: null };
  const haveValidate = cliExists && verbExists("validate");
  const haveAdd = cliExists && verbExists("add");
  const haveInsert = cliExists && verbExists("insert");
  const haveSet = cliExists && verbExists("set");

  if (!QUIET) {
    process.stdout.write(`skill-design eval grader\n`);
    process.stdout.write(`  cli        ${CLI}${cliExists ? "" : "  (missing)"}\n`);
    process.stdout.write(`  starter    ${STARTER}\n`);
    process.stdout.write(`  verbs      ${cliExists ? [...listed.verbs].sort().join(" ") || "(none listed)" : "n/a"}\n`);
    process.stdout.write(`  surface    validate=${haveValidate ? "yes" : "no"} add=${haveAdd ? "yes" : "no"} insert=${haveInsert ? "yes" : "no"} set=${haveSet ? "yes" : "no"}\n\n`);
  }

  const ws = workspace();
  const rows = [];
  const receipts = [];

  // probe the insert forms once on the clean control snippet, then reuse it
  let insertForm = null;
  let insertProbe = null;
  const control = evals.find((e) => e.id === CONTROL_EVAL_ID) ?? evals[0];
  if (cliExists && haveValidate && control && (haveAdd || haveInsert)) {
    const probeFile = join(ws, `probe-${control.id}.html`);
    const snipPath = resolve(ROOT, control.files[0]);
    for (const form of INSERT_FORMS) {
      copyFileSync(STARTER, probeFile);
      const r = runCli(form(snipPath, probeFile));
      if (r.code === 0) { insertForm = form; insertProbe = r; break; }
      if (MISSING_VERB_RE.test(r.stderr) || MISSING_VERB_RE.test(r.stdout)) { insertProbe = r; break; }
      insertProbe = r;
    }
  }

  // --raw needs neither an add verb nor a working command shape: it splices the
  // snippet itself and only asks the CLI to validate.
  const whySkip = !cliExists ? `no CLI at ${CLI}`
    : !haveValidate ? "no `validate` verb"
      : RAW ? null
        : !(haveAdd || haveInsert) ? "no `add`/`insert` verb"
          : !insertForm ? "insert verb exists but no known command shape worked (update INSERT_FORMS in grade.mjs)"
            : null;

  for (const ev of evals) {
    const rel = ev.files?.[0] ?? "";
    const snipPath = resolve(ROOT, rel);
    const stem = rel.split("/").pop() ?? `eval${ev.id}`;
    const row = {
      id: ev.id, name: ev.name, snippet: stem, file: rel,
      pass: "SKIP", reason: whySkip ?? "", refusalCodes: "", dropped: "", normalized: "",
      generatedIds: "", receiptShape: "", insert: "", validateExit: null, accepted: null,
      control: ev.id === CONTROL_EVAL_ID,
    };
    const record = { eval: ev.id, name: ev.name, snippet: rel, row, receipt: null, stdout: "", stderr: "" };

    try {
      if (whySkip) {
        row.reason = whySkip;
      } else if (!existsSync(snipPath)) {
        row.pass = "no";
        row.reason = `missing snippet ${rel}`;
      } else {
        const file = join(ws, `${stem}-${ev.id}.html`);
        copyFileSync(STARTER, file);
        const snippet = readFileSync(snipPath, "utf8");

        let insert = null;
        if (insertForm) {
          insert = runCli(insertForm(snipPath, file));
          row.insert = "cli";
        } else if (RAW) {
          spliceByText(file, snippet);
          row.insert = "raw-text";
        }
        row.insertExit = insert ? insert.code : null;

        const vr = runCli(["validate", file, "--json"]);
        row.validateExit = vr.code;
        const parsed = parseReceiptOutput(vr);
        record.stdout = vr.stdout;
        record.stderr = vr.stderr;

        const receipt = normalizeReceipt(parsed.json);
        row.receiptShape = parsed.shape;
        if (!parsed.json) {
          const codes = scrapeCodes(`${vr.stdout}\n${vr.stderr}`);
          row.refusalCodes = codes.join(" ");
        } else {
          const codes = [...new Set([
            ...receipt.diagnostics.map((d) => d.code),
            ...receipt.groupCodes,
          ].filter(Boolean))];
          row.refusalCodes = codes.join(" ");
          row.dropped = receipt.dropped.map((s) => clip(s, 34)).join("; ");
          row.normalized = receipt.normalized.map((s) => clip(s, 34)).join("; ");
          row.generatedIds = receipt.generatedIds.map((s) => clip(s, 22)).join("; ");
          row.accepted = receipt.ok === true || (receipt.diagnostics.length === 0 && receipt.ok === null);
        }
        record.receipt = receipt.raw ?? { scrapedCodes: scrapeCodes(`${vr.stdout}\n${vr.stderr}`) };

        // When the insert was refused, its own output is the receipt a reader
        // has to go on: nothing was written, so `validate` still describes the
        // file as it was.
        let refusal = null;
        if (insert && insert.code !== 0) {
          const ir = parseReceiptOutput(insert);
          if (ir.json) {
            const fromInsert = normalizeReceipt(ir.json);
            const codesInRefusal = [...new Set(fromInsert.diagnostics.map((d) => d.code).filter(Boolean))];
            refusal = {
              shape: ir.shape,
              codes: codesInRefusal,
              legible: codesInRefusal.length > 0,
            };
            if (codesInRefusal.length) {
              row.refusalCodes = codesInRefusal.join(" ");
              row.dropped = fromInsert.dropped.map((x) => clip(x, 34)).join("; ");
              row.normalized = fromInsert.normalized.map((x) => clip(x, 34)).join("; ");
            }
            record.insertReceipt = ir.json;
          } else {
            const scraped = scrapeCodes(`${insert.stdout}\n${insert.stderr}`);
            refusal = { shape: ir.shape, codes: scraped, legible: scraped.length > 0 };
            if (scraped.length) row.refusalCodes = scraped.join(" ");
          }
        }

        const verdict = judge({ insert, validate: vr, receipt: parsed.json ? receipt : null, shape: parsed.shape, codes: scrapeCodes(`${vr.stdout}\n${vr.stderr}`), refusal });
        row.pass = verdict.pass ? "yes" : "no";
        row.reason = verdict.reasons.join("; ");
      }
    } catch (err) {
      row.pass = "no";
      row.reason = `grader error: ${err && err.message ? err.message : String(err)}`;
    }
    rows.push(row);
    receipts.push(record);
  }

  // ------------------------------------------------------------- print table

  const cols = [
    ["snippet", 9, (r) => r.snippet.replace(/\.html$/, "")],
    ["pass", 6, (r) => r.pass],
    ["refusal code", 30, (r) => r.refusalCodes || "—"],
    ["dropped", 34, (r) => r.dropped || "—"],
    ["normalized", 34, (r) => r.normalized || "—"],
    ["note", 26, (r) => (r.pass === "SKIP" ? clip(r.reason, 26) : r.pass === "no" ? clip(r.reason, 26) : r.insert || "")],
  ];

  const head = cols.map(([t, w]) => clip(t, w).padEnd(w)).join(" | ");
  process.stdout.write(`${head}\n${cols.map(([, w]) => "-".repeat(w)).join("-+-")}\n`);
  for (const r of rows) {
    process.stdout.write(`${cols.map(([, w, f]) => clip(f(r), w).padEnd(w)).join(" | ")}\n`);
  }

  const ran = rows.filter((r) => r.pass !== "SKIP");
  const passed = rows.filter((r) => r.pass === "yes");
  const pct = ran.length === 0 ? 0 : Math.round((passed.length / ran.length) * 100);
  process.stdout.write(`\n${passed.length}/${ran.length} = ${pct}%\n`);

  const skipped = rows.filter((r) => r.pass === "SKIP");
  const accepted = ran.filter((r) => r.accepted === true);
  process.stdout.write(
    `${rows.length} snippets, ${ran.length} graded, ${accepted.length} accepted clean, ` +
    `${ran.length - accepted.length} refused, ${skipped.length} skipped\n`,
  );
  if (ran.length > 0) {
    const clean = ran.find((r) => r.control);
    if (clean) {
      process.stdout.write(
        `clean control (${clean.snippet.replace(/\.html$/, "")}): ` +
        `${clean.accepted === true ? "accepted clean — corpus is calibrated" : `REFUSED (${clip(clean.refusalCodes, 60)}) — the clean snippet must validate`}\n`,
      );
    }
  }
  if (skipped.length > 0) {
    process.stdout.write(`skip reasons: ${[...new Set(skipped.map((r) => r.reason))].join(" | ")}\n`);
    if (whySkip && insertProbe) {
      process.stdout.write(`insert probe: exit ${insertProbe.code} ${clip(insertProbe.stderr || insertProbe.stdout, 160)}\n`);
    }
  }
  const failed = rows.filter((r) => r.pass === "no");
  if (failed.length > 0) process.stdout.write(`fail reasons: ${[...new Set(failed.map((r) => r.reason))].join(" | ")}\n`);

  // ------------------------------------------------------------- receipts

  const outPath = typeof JSON_OUT === "string" ? resolve(ROOT, JSON_OUT) : join(ws, "receipts.json");
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify({
      generated: new Date().toISOString(),
      cli: CLI, cli_found: cliExists, verbs: [...listed.verbs].sort(),
      surface: { validate: haveValidate, add: haveAdd, insert: haveInsert, set: haveSet },
      pass_rate: { passed: passed.length, ran: ran.length, total: rows.length, percent: pct },
      rows: rows.map(({ ...r }) => r),
      receipts,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`\nreceipts: ${outPath}\n`);
  } catch (err) {
    process.stdout.write(`\ncould not write receipts: ${err.message}\n`);
  }

  if (CLEAN) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } }
  else process.stdout.write(`workspace: ${ws}\n`);
}

try {
  main();
} catch (err) {
  process.stdout.write(`\ngrader failed: ${err && err.stack ? err.stack : String(err)}\n`);
}
// A measuring tool always reports success so it can be run inside a pipeline.
process.exitCode = 0;
