/**
 * "Did you mean ...?" support.
 * PURE ESM — no `node:` imports.
 */

/** Levenshtein edit distance, two-row iterative. */
export function distance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j += 1) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[t.length];
}

/**
 * Return the closest candidate, or null when nothing is close enough.
 * `maxDistance` defaults to a third of the input length (min 2, max 4).
 */
export function suggest(input, candidates, maxDistance) {
  const list = Array.from(candidates || []);
  if (list.length === 0) return null;

  const s = String(input);
  const limit =
    typeof maxDistance === "number"
      ? maxDistance
      : Math.min(4, Math.max(2, Math.floor(s.length / 3)));

  let best = null;
  let bestScore = Infinity;
  for (const candidate of list) {
    const c = String(candidate);
    // An identical candidate is never a suggestion. "Did you mean home__title"
    // when the author already wrote home__title teaches nothing, and callers
    // that ask about a duplicate rely on getting the OTHER similar name back.
    if (c === s) continue;
    const d = distance(s, c);
    if (d < bestScore || (d === bestScore && best !== null && c < best)) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= limit ? best : null;
}

/**
 * Suggest from a list of token references, comparing only the name part so that
 * `$color.surafce` still finds `$color.surface`.
 */
export function suggestTokenRef(ref, candidates, maxDistance) {
  const list = Array.from(candidates || []);
  if (list.length === 0) return null;

  const parts = String(ref).split(".");
  const name = parts.length > 1 ? parts.slice(1).join(".") : String(ref);
  const group = parts.length > 1 ? parts[0] : null;

  const sameGroup = group ? list.filter((c) => String(c).startsWith(`${group}.`)) : [];
  const pool = sameGroup.length > 0 ? sameGroup : list;

  const stripped = pool.map((c) => {
    const p = String(c).split(".");
    return { full: c, name: p.length > 1 ? p.slice(1).join(".") : String(c) };
  });

  const hit = suggest(name, stripped.map((x) => x.name), maxDistance);
  if (hit === null) return null;
  const match = stripped.find((x) => x.name === hit);
  return match ? match.full : null;
}

function bareName(value) {
  const lower = String(value).toLowerCase();
  return lower.startsWith("data-") ? lower.slice(5) : lower;
}

/**
 * Suggest an attribute name for a typo: `backgound-color` -> `background-color`.
 *
 * Tried in order, so the answer never gets worse than an exact answer:
 * the name itself, a case-insensitive match, the name without its `data-`
 * prefix (`kind` -> `data-kind`), then a fuzzy match on either form.
 *
 * @param {string} name          what the file wrote
 * @param {Iterable<string>} allowedNames  the attribute names the table allows
 * @returns {string|null} the allowed name, or null when nothing is close
 */
export function suggestAttr(name, allowedNames) {
  const list = Array.from(allowedNames || [], (c) => String(c));
  if (list.length === 0) return null;

  const input = String(name ?? "");
  if (input === "") return null;

  const exact = list.find((c) => c === input);
  if (exact) return exact;

  const lower = input.toLowerCase();
  const insensitive = list.find((c) => c.toLowerCase() === lower);
  if (insensitive) return insensitive;

  const pairs = list.map((c) => ({ full: c, bare: bareName(c) }));
  const want = bareName(input);

  const bareHit = pairs.find((p) => p.bare === want);
  if (bareHit) return bareHit.full;

  const fuzzy = suggest(want, pairs.map((p) => p.bare));
  if (fuzzy !== null) {
    const match = pairs.find((p) => p.bare === fuzzy);
    if (match) return match.full;
  }

  const fuzzyFull = suggest(lower, pairs.map((p) => p.full));
  return fuzzyFull;
}
