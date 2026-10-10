/**
 * lib/svg-path.mjs — a `d` string, measured and rewritten.
 *
 * pen stores a `path` node's outline as geometry, and this format stores geometry
 * too, so an import has to answer two questions the string does not answer by
 * itself:
 *
 *   where the drawing is        its ink box, which becomes the glyph's `viewBox`
 *   where it lands when turned  the same outline after a rotation, because the
 *                               format has no `transform` to express one
 *
 * Both are the same scan of the same grammar, so both live here. Split between
 * two callers they would become two half-parsers that disagree about the one
 * command neither exercised until a real file used it.
 *
 * The grammar is SVG's, arc flags included. In `a1 1 0 011 1` the `011` is three
 * tokens — large-arc 0, sweep 1, x 1 — and not the number 11. A scanner that
 * reads numbers first is wrong on the first file that writes its flags without
 * spaces, which is legal and which export tools do write.
 *
 * Every number here is a coordinate in the path's own coordinate system. What
 * that system means to the page is the caller's business: the reader decides it
 * with the node's own width and height.
 *
 * PURE ESM — no `node:` imports.
 */

/** Raised for a string this module will not guess about. */
export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathError";
  }
}

const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
const ARGUMENT_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// -- scanning -----------------------------------------------------------------

/**
 * A cursor over one `d` string.
 *
 * A scanner rather than a `matchAll`: the arc flags are single characters that
 * may sit against the number after them, so which token comes next depends on
 * the command being read, and a regular expression cannot know that.
 */
function scannerFor(text) {
  const number = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let at = 0;

  const skipSeparators = () => {
    while (at < text.length && (text[at] === "," || /\s/.test(text[at]))) at += 1;
  };

  return {
    end() {
      skipSeparators();
      return at >= text.length;
    },
    /** The next command letter, or "" at the end of the string. */
    peekCommand() {
      skipSeparators();
      return COMMANDS.includes(text[at] ?? "") ? text[at] : "";
    },
    takeCommand() {
      const letter = this.peekCommand();
      if (letter === "") throw new PathError(`expected a command at offset ${at}`);
      at += 1;
      return letter;
    },
    /** Whether another argument follows, which is how implicit repeats are read. */
    hasNumber() {
      skipSeparators();
      return at < text.length && /[-+.\d]/.test(text[at]);
    },
    takeNumber() {
      skipSeparators();
      number.lastIndex = at;
      const match = number.exec(text);
      if (!match) throw new PathError(`expected a number at offset ${at}`);
      at = number.lastIndex;
      return Number(match[0]);
    },
    /** An arc flag: exactly one `0` or `1`, even when it touches what follows. */
    takeFlag() {
      skipSeparators();
      const character = text[at];
      if (character !== "0" && character !== "1") throw new PathError(`expected an arc flag at offset ${at}`);
      at += 1;
      return Number(character);
    },
  };
}

// -- parsing ------------------------------------------------------------------

/**
 * One command, in absolute coordinates.
 *
 * Relative commands are resolved as they are read, because both callers want
 * points and neither wants to walk a current-point cursor twice. `H` and `V`
 * are already `L`, `S` and `T` are already the `C` and `Q` they mean — pen
 * writes both spellings and the reflection rules are the parser's to apply, not
 * its callers'.
 */
function parsePath(d) {
  const text = String(d ?? "");
  if (text === "") throw new PathError("empty path");
  const scan = scannerFor(text);
  const segments = [];

  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCubic = null; // reflected for `S`
  let lastQuad = null; // reflected for `T`
  let command = "";

  while (!scan.end()) {
    const letter = scan.peekCommand();
    if (letter !== "") command = scan.takeCommand();
    else if (command === "" || command === "Z" || command === "z") {
      throw new PathError("a path must start with a moveto");
    }

    const upper = command.toUpperCase();
    const relative = command !== upper;
    const base = { x: relative ? x : 0, y: relative ? y : 0 };

    if (upper === "Z") {
      segments.push({ command: "Z" });
      x = startX;
      y = startY;
      lastCubic = null;
      lastQuad = null;
      continue;
    }

    // Every other command takes its arguments; a command with no further numbers
    // has been read, and the loop moves on to the next letter.
    if (!scan.hasNumber()) {
      if (ARGUMENT_COUNT[upper] === 0) continue;
      throw new PathError(`${command} without arguments`);
    }

    const point = (ax, ay) => ({ x: base.x + ax, y: base.y + ay });

    if (upper === "M") {
      const p = point(scan.takeNumber(), scan.takeNumber());
      segments.push({ command: "M", points: [p] });
      x = p.x;
      y = p.y;
      startX = x;
      startY = y;
      // A second pair after a moveto is a lineto. The spec says so, and every
      // font export relies on it.
      command = relative ? "l" : "L";
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "L") {
      const p = point(scan.takeNumber(), scan.takeNumber());
      segments.push({ command: "L", points: [p] });
      x = p.x;
      y = p.y;
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "H") {
      const p = { x: base.x + scan.takeNumber(), y };
      segments.push({ command: "L", points: [p] });
      x = p.x;
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "V") {
      const p = { x, y: base.y + scan.takeNumber() };
      segments.push({ command: "L", points: [p] });
      y = p.y;
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "C" || upper === "S") {
      let control1;
      if (upper === "C") {
        control1 = point(scan.takeNumber(), scan.takeNumber());
      } else {
        // The first control point of a smooth curve is the previous one mirrored
        // through the current point; with no previous curve it IS the current
        // point.
        control1 = lastCubic ? { x: 2 * x - lastCubic.x, y: 2 * y - lastCubic.y } : { x, y };
      }
      const control2 = point(scan.takeNumber(), scan.takeNumber());
      const end = point(scan.takeNumber(), scan.takeNumber());
      segments.push({ command: "C", points: [control1, control2, end] });
      x = end.x;
      y = end.y;
      lastCubic = control2;
      lastQuad = null;
    } else if (upper === "Q" || upper === "T") {
      let control;
      if (upper === "Q") control = point(scan.takeNumber(), scan.takeNumber());
      else control = lastQuad ? { x: 2 * x - lastQuad.x, y: 2 * y - lastQuad.y } : { x, y };
      const end = point(scan.takeNumber(), scan.takeNumber());
      segments.push({ command: "Q", points: [control, end] });
      x = end.x;
      y = end.y;
      lastQuad = control;
      lastCubic = null;
    } else if (upper === "A") {
      const rx = scan.takeNumber();
      const ry = scan.takeNumber();
      const rotation = scan.takeNumber();
      const largeArc = scan.takeFlag();
      const sweep = scan.takeFlag();
      const end = point(scan.takeNumber(), scan.takeNumber());
      segments.push({ command: "A", rx, ry, rotation, largeArc, sweep, points: [end], from: { x, y } });
      x = end.x;
      y = end.y;
      lastCubic = null;
      lastQuad = null;
    } else {
      throw new PathError(`unsupported command ${command}`);
    }
  }

  if (segments.length === 0) throw new PathError("no drawing commands");
  return segments;
}

// -- measuring ----------------------------------------------------------------

/**
 * The extrema of one cubic segment, per axis.
 *
 * Solving the derivative rather than sampling the curve: a sampled box is
 * always slightly too small, and a box that is too small is a glyph scaled up
 * by an amount nobody can see and nobody can explain.
 */
function cubicExtremes(p0, p1, p2, p3, out) {
  for (const axis of ["x", "y"]) {
    const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
    const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis]);
    const c = p1[axis] - p0[axis];
    const roots = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) roots.push(-c / b);
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant);
        roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
      }
    }
    for (const t of roots) {
      if (!(t > 0 && t < 1)) continue;
      const mt = 1 - t;
      out.push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
      });
    }
  }
}

/**
 * The extrema of one quadratic segment, per axis.
 *
 * The derivative is linear, so the turning point is one division away. It is NOT
 * the cubic whose two control points are the same point — that is a different
 * curve, and reading it as one moves every quadratic's extremum by a fifth.
 */
function quadExtremes(p0, p1, p2, out) {
  for (const axis of ["x", "y"]) {
    const denominator = p0[axis] - 2 * p1[axis] + p2[axis];
    if (Math.abs(denominator) < 1e-12) continue;
    const t = (p0[axis] - p1[axis]) / denominator;
    if (!(t > 0 && t < 1)) continue;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
}

/**
 * An arc's extremes, on its own ellipse.
 *
 * Endpoints alone are not enough: an arc that bulges out and comes back has its
 * extremes strictly between them, and a box built from the endpoints clips the
 * bulge. The parameters below are SVG's own (appendix F.6.5), out-of-range radii
 * included — a radius too small for its chord is scaled up, and the scaled one is
 * what gets drawn.
 */
function arcPoints(segment, out) {
  const { rx: rxIn, ry: ryIn, rotation, largeArc, sweep, points, from } = segment;
  const to = points[0];
  out.push(from, to);

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return; // the spec draws a straight line instead
  if (from.x === to.x && from.y === to.y) return; // a zero-length arc draws nothing

  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;

  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1);
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const cx1 = (factor * rx * y1) / ry;
  const cy1 = (-factor * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;

  const start = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx);
  const end = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx);
  let delta = end - start;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const at = (theta) => ({
    x: cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    y: cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
  });
  const within = (theta) => {
    let t = theta - start;
    if (delta >= 0) {
      while (t < 0) t += 2 * Math.PI;
      while (t > 2 * Math.PI) t -= 2 * Math.PI;
      return t <= delta;
    }
    while (t > 0) t -= 2 * Math.PI;
    while (t < -2 * Math.PI) t += 2 * Math.PI;
    return t >= delta;
  };

  // Where the ellipse turns around: the parameter at which dx/dtheta and
  // dy/dtheta are each zero, plus the half turn that mirrors each of them.
  const thetaX = Math.atan2(-ry * sin, rx * cos);
  const thetaY = Math.atan2(ry * cos, rx * sin);
  for (const theta of [thetaX, thetaX + Math.PI, thetaY, thetaY + Math.PI]) {
    if (within(theta)) out.push(at(theta));
  }
}

/**
 * The box the outline actually covers, in its own coordinates.
 *
 * `null` means the string cannot be trusted to describe a box: it does not
 * parse, it draws nothing, or its box has no area. A box with no area is not a
 * coordinate system — a caller that used one would divide by zero and scale the
 * drawing into nothing — so it is reported as an absence rather than as zeros.
 *
 * @param {string} d
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function pathBounds(d) {
  let segments;
  try {
    segments = parsePath(d);
  } catch {
    return null;
  }

  const points = [];
  // The curve commands need the point they start from, and that point is not
  // always the last one measured: after a `Z` the pen is back at the subpath's
  // start, which is a different point.
  let current = null;
  let startX = 0;
  let startY = 0;
  for (const segment of segments) {
    if (segment.command === "Z") {
      current = { x: startX, y: startY };
    } else if (segment.command === "A") {
      arcPoints(segment, points);
      current = segment.points[0];
    } else if (segment.command === "C") {
      const [p1, p2, p3] = segment.points;
      const p0 = current ?? p3;
      // The control points are deliberately NOT measured. They are not on the
      // curve, and a box that includes them is bigger than the ink — the wifi
      // glyph's box grew by a whole unit that way, and the glyph, scaled to its
      // node box, came out smaller than pen drew it.
      points.push(p3);
      cubicExtremes(p0, p1, p2, p3, points);
      current = p3;
    } else if (segment.command === "Q") {
      const [p1, p2] = segment.points;
      const p0 = current ?? p2;
      points.push(p2);
      quadExtremes(p0, p1, p2, points);
      current = p2;
    } else {
      points.push(...segment.points);
      current = segment.points[segment.points.length - 1];
      if (segment.command === "M") {
        startX = current.x;
        startY = current.y;
      }
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  if (maxX - minX <= 0 || maxY - minY <= 0) return null;
  return { minX, minY, maxX, maxY };
}

// -- rewriting ----------------------------------------------------------------

/** Four decimals: finer than any coordinate pen writes, and short enough to read. */
const round4 = (value) => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * The same outline, turned by `degrees` about `(cx, cy)`.
 *
 * The output is absolute commands, because a rotated relative command is a
 * different command and rewriting one into the other is where a hand-written
 * transformer goes wrong. `A` keeps its radii and its flags — a rotation is
 * orientation-preserving, so the sweep does not flip — and adds `degrees` to its
 * own x-axis rotation, which is how SVG says "this ellipse is turned".
 *
 * @param {string} d
 * @param {number} degrees clockwise, as CSS measures it
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
export function rotatePath(d, degrees, cx, cy) {
  const segments = parsePath(d);
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const turn = (point) => {
    const dx = point.x - cx;
    const dy = point.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  };
  const pair = (point) => `${round4(point.x)} ${round4(point.y)}`;

  const parts = [];
  for (const segment of segments) {
    if (segment.command === "Z") {
      parts.push("Z");
      continue;
    }
    if (segment.command === "A") {
      // `rotation + degrees` follows the coordinate system the ellipse is drawn
      // in: the arc's own angle is measured inside it.
      parts.push(`A${round4(segment.rx)} ${round4(segment.ry)} ${round4(segment.rotation + degrees)} ${segment.largeArc} ${segment.sweep} ${pair(turn(segment.points[0]))}`);
      continue;
    }
    parts.push(`${segment.command}${segment.points.map((point) => pair(turn(point))).join(" ")}`);
  }
  return parts.join("");
}
