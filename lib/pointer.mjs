/**
 * RFC 6901 JSON Pointer primitives.
 *
 * PURE ESM — no `node:` imports. Shared by `ops.mjs`, the validators and the CLIs.
 */

/** Split a pointer into unescaped segments. `""` and `"/"` are handled per RFC 6901. */
export function parsePointer(pointer) {
  const raw = String(pointer ?? "");
  if (raw === "") return [];
  if (!raw.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer ${JSON.stringify(raw)}: it must start with "/" or be empty`);
  }
  return raw
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Join segments into a pointer, escaping `~` and `/`. */
export function formatPointer(segments) {
  if (!segments || segments.length === 0) return "";
  return `/${segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

/** Coerce a segment to an array index, or return null when it is not one. */
export function asIndex(segment) {
  if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) return segment;
  if (typeof segment === "string" && /^(0|[1-9][0-9]*)$/.test(segment)) return Number(segment);
  return null;
}

/**
 * Read the value at `pointer`.
 * @returns {{ found: boolean, value?: unknown, parent?: unknown, key?: string, segments: string[] }}
 */
export function getAtPointer(root, pointer) {
  const segments = Array.isArray(pointer) ? pointer.map(String) : parsePointer(pointer);
  if (segments.length === 0) return { found: true, value: root, parent: undefined, key: undefined, segments };

  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (current === null || current === undefined) {
      return { found: false, parent: current, key: seg, segments };
    }
    if (Array.isArray(current)) {
      const idx = asIndex(seg);
      if (idx === null || idx >= current.length) return { found: false, parent: current, key: seg, segments };
      if (i === segments.length - 1) return { found: true, value: current[idx], parent: current, key: String(idx), segments };
      current = current[idx];
      continue;
    }
    if (typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, seg)) {
        return { found: false, parent: current, key: seg, segments };
      }
      if (i === segments.length - 1) return { found: true, value: current[seg], parent: current, key: seg, segments };
      current = current[seg];
      continue;
    }
    return { found: false, parent: current, key: seg, segments };
  }
  return { found: false, parent: undefined, key: undefined, segments };
}

/** True when `pointer` addresses an existing location. */
export function hasPointer(root, pointer) {
  return getAtPointer(root, pointer).found;
}
