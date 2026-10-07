/**
 * lib/receipt.mjs — what the user is told after an edit.
 *
 * PURE ESM. No `node:` imports, no DOM, no dependencies.
 *
 * A receipt is the machine-readable half of a verb's result; `formatReceipt` is the
 * half a person reads. Both come from the same object, so the panel, the JSON output
 * and the terminal can never disagree about what happened.
 *
 * ## The invariant this file exists to keep
 *
 * **Zero silent drops.** Every declaration the model sent is either consumed into the
 * file or listed in `dropped` with a reason. A receipt that says `ok: true` and is
 * quiet about a declaration is a bug, not a formatting choice.
 *
 * ## Assumptions where docs/format-v3.md is silent
 *
 * R1. `ok` is false when the caller refused, or when any diagnostic has severity
 *     `error`. Warnings do not make a receipt fail.
 * R2. A failure carries a `refused` block — `{code, message, hint, suggestion}` — so
 *     the human text can print the reason and the one-line fix. `buildReceipt` takes
 *     it from the caller, or builds it from the first error diagnostic. A successful
 *     receipt has exactly the nine documented keys.
 * R3. `changed` defaults to `applied.length > 0`. The caller that knows whether the
 *     bytes moved (it compares hashes) should pass it.
 * R4. The human text is English except for the two lines the product fixes:
 *     `REFUSED` and `文件未改动。` — the promise that a refusal left the file alone is
 *     printed in the language the file's owner reads.
 * R5. Lines appear in this order and only when non-empty: added, normalized, dropped,
 *     applied-op count with revision, then diagnostics. `applied` is printed when at
 *     least one op ran, or when the caller reports the file changed.
 */

/** Labels are padded so every value starts in the same column. */
const LABEL = 11;

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Build the receipt object.
 *
 * @param {{verb?: string, applied?: object[], added?: string[], normalized?: object[],
 *          dropped?: object[], diagnostics?: object[], revision?: string|null,
 *          changed?: boolean, refused?: object|null, error?: object|null}} input
 */
export function buildReceipt(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const applied = list(source.applied);
  const diagnostics = list(source.diagnostics);
  const errors = diagnostics.filter((entry) => entry && entry.severity === "error");

  let refused = source.refused ?? null;
  if (refused === null && source.error) refused = source.error;
  if (refused === null && errors.length > 0) {
    const first = errors[0];
    refused = {
      code: first.code ?? null,
      message: first.message ?? "",
      hint: first.hint ?? null,
      suggestion: first.fix ?? null,
    };
  }

  const receipt = {
    ok: refused === null && errors.length === 0,
    verb: typeof source.verb === "string" && source.verb !== "" ? source.verb : null,
    applied,
    added: list(source.added),
    normalized: list(source.normalized),
    dropped: list(source.dropped),
    diagnostics,
    revision: typeof source.revision === "string" && source.revision !== "" ? source.revision : null,
    changed: typeof source.changed === "boolean" ? source.changed : applied.length > 0,
  };
  if (refused !== null) {
    receipt.refused = {
      code: refused.code ?? null,
      message: refused.message ?? "",
      hint: refused.hint ?? null,
      suggestion: refused.suggestion ?? null,
    };
  }
  return receipt;
}

function paint(text, code, color) {
  return color ? `${code}${text}${RESET}` : text;
}

function line(label, value) {
  return `${label.padEnd(LABEL)} ${value}`;
}

function normalizedText(entry) {
  const target = entry?.target ?? "?";
  const prop = entry?.prop ?? "?";
  const from = entry?.from ?? "";
  const to = entry?.to ?? "";
  const name = entry?.alias ? `${target}.${entry.alias} → ${prop}` : `${target}.${prop}`;
  if (from === to && entry?.alias) return name;
  return `${name}  ${from} → ${to}`;
}

function droppedText(entry) {
  const target = entry?.target ?? "?";
  const prop = entry?.prop ?? "?";
  const value = entry?.value ?? "";
  const reason = entry?.reason ?? "dropped";
  return `${target}.${prop}${value === "" ? "" : `  ${value}`}  (${reason})`;
}

function diagnosticText(entry) {
  const severity = entry?.severity === "error" ? "error" : "warning";
  const code = entry?.code ?? "?";
  const target = entry?.target ? `  ${entry.target}` : "";
  return `${severity}  ${code}${target}  ${entry?.message ?? ""}`;
}

/**
 * Render a receipt as text.
 *
 * @param {object} receipt from `buildReceipt`
 * @param {{color?: boolean, maxItems?: number}} [options]
 * @returns {string} text, newline-terminated
 */
export function formatReceipt(receipt, options = {}) {
  const source = receipt && typeof receipt === "object" ? receipt : {};
  const color = options.color === true;
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : 20;
  const lines = [];

  const overflow = (count) => `  … and ${count} more`;

  if (!source.ok) {
    const reason = source.refused ?? {
      code: null,
      message: (list(source.diagnostics).find((entry) => entry?.severity === "error") ?? {}).message ?? "The change was refused.",
      hint: null,
      suggestion: null,
    };
    lines.push(`${paint("REFUSED", RED, color)}  ${reason.message}`);
    if (reason.hint) lines.push(`  hint: ${reason.hint}`);
    if (reason.suggestion) lines.push(`  建议: ${reason.suggestion}`);
    const rest = list(source.diagnostics).filter(
      (entry) => entry && entry.message !== reason.message,
    );
    for (const entry of rest) {
      lines.push(`  ${paint(diagnosticText(entry), entry.severity === "error" ? RED : YELLOW, color)}`);
    }
    lines.push("文件未改动。");
    return `${lines.join("\n")}\n`;
  }

  const added = list(source.added);
  if (added.length > 0) {
    const shown = added.slice(0, maxItems);
    lines.push(line("added", shown.join(", ")));
    if (added.length > shown.length) lines.push(overflow(added.length - shown.length));
  }

  const normalized = list(source.normalized);
  if (normalized.length > 0) {
    const shown = normalized.slice(0, maxItems);
    lines.push(line("normalized", normalizedText(shown[0])));
    for (const entry of shown.slice(1)) lines.push(`  ${normalizedText(entry)}`);
    if (normalized.length > shown.length) lines.push(overflow(normalized.length - shown.length));
  }

  const dropped = list(source.dropped);
  if (dropped.length > 0) {
    const shown = dropped.slice(0, maxItems);
    lines.push(line("dropped", droppedText(shown[0])));
    for (const entry of shown.slice(1)) lines.push(`  ${droppedText(entry)}`);
    if (dropped.length > shown.length) lines.push(overflow(dropped.length - shown.length));
  }

  const applied = list(source.applied);
  if (applied.length > 0 || source.changed === true) {
    const parts = [`${applied.length} op${applied.length === 1 ? "" : "s"}`];
    if (source.revision) parts.push(`revision ${source.revision}`);
    if (source.changed === false) parts.push("no change");
    lines.push(line("applied", parts.join(" · ")));
  }

  const diagnostics = list(source.diagnostics);
  const ordered = [
    ...diagnostics.filter((entry) => entry?.severity === "error"),
    ...diagnostics.filter((entry) => entry?.severity !== "error"),
  ];
  for (const entry of ordered.slice(0, maxItems)) {
    lines.push(paint(diagnosticText(entry), entry.severity === "error" ? RED : YELLOW, color));
  }
  if (ordered.length > maxItems) lines.push(overflow(ordered.length - maxItems));

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
