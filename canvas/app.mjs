/**
 * The canvas.
 *
 * Three rules hold this together, and each one is a decision:
 *
 * 1. The browser parses and renders the file itself. It imports the same
 *    `lib/parse.mjs` and `lib/render.mjs` the CLI validates with, so the canvas
 *    cannot disagree with the tool about what a file means. The service sends
 *    text, never a document tree.
 *
 * 2. Each page mounts inside its own shadow root. A page's tokens and page-frame
 *    rule get exactly one scope, so a design cannot restyle this chrome and this
 *    chrome cannot restyle a design. It is also why the canvas never has to
 *    write its own styles into the design file.
 *
 * 3. The canvas only ever sends ops, and the service only ever accepts them
 *    through the same write funnel the CLI uses. A drag is a `set` of
 *    `style:left` and `style:top`; there is no second write path to keep in
 *    sync, and no way for a drag to write something the validator would refuse.
 */

import { parse, getAttr, pagesOf } from "/lib/parse.mjs";
import {
  renderModel, canvasMountCss, pagePaperRadius, renderNodeHtml, styleMapOf, styleStringOf,
  arrangePages, pageTree, resolveTokens, webfontLinks,
} from "/lib/render.mjs";
import { collectTokens, lintContrast } from "/lib/validate.mjs";
import { lintGeometry, overhangOf, MAX_REPORTED_PER_CODE } from "/lib/geometry.mjs";

// -- wire --------------------------------------------------------------------

const TOKEN = new URLSearchParams(location.search).get("t") ?? "";

/**
 * One call to the service.
 *
 * The response object comes back with the payload, because the revision lives in
 * a header and the canvas has to record it: it is how the canvas recognises its
 * own write when the change arrives over the event stream, and how it knows the
 * other writer got there first.
 */
async function api(path, options = {}) {
  const url = `/api/${path}?t=${encodeURIComponent(TOKEN)}`;
  const init = { headers: {}, ...options };
  if (options.body !== undefined) {
    init.method = options.method ?? "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const type = response.headers.get("content-type") ?? "";
  let payload = null;
  try {
    payload = type.includes("application/json") ? await response.json() : await response.text();
  } catch {
    payload = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    payload,
    revision: response.headers.get("X-Design-Revision"),
  };
}

// -- state -------------------------------------------------------------------

const state = {
  file: "",
  text: "",
  revision: "",
  readOnly: false,
  readOnlyReason: "",
  doc: null,
  model: null,
  diagnostics: [],
  selection: null,
  hovering: null,
  // No `mode`. There was a `mode: "select"` here with no reader anywhere in the canvas —
  // a toggle nothing toggled and nothing consulted, which reads as if the canvas had
  // states it does not have.
  camera: { x: 40, y: 40, zoom: 1 },
  boxes: new Map(),
  canUndo: false,
  canRedo: false,
  busy: false,
};

/** Counts mounts, so a font callback from a replaced mount can be ignored. */
let mountGeneration = 0;

const ui = {
  viewport: document.getElementById("viewport"),
  canvas: document.getElementById("canvas"),
  overlay: document.getElementById("overlay"),
  pageList: document.getElementById("page-list"),
  layerList: document.getElementById("layer-list"),
  inspector: document.getElementById("inspector"),
  selectionName: document.getElementById("selection-name"),
  fileName: document.getElementById("file-name"),
  revision: document.getElementById("revision"),
  readonly: document.getElementById("readonly"),
  zoomLabel: document.getElementById("zoom-label"),
  problemCount: document.getElementById("problem-count"),
  problems: document.getElementById("problems"),
  fixPane: document.getElementById("fix-pane"),
  fixHint: document.getElementById("fix-hint"),
  fixText: document.getElementById("fix-textarea"),
  problemList: document.getElementById("problem-list"),
  toast: document.getElementById("toast"),
};

let toastTimer = null;
function toast(message, kind = "") {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${kind}`.trim();
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, kind === "refused" ? 7000 : 2600);
}

// -- camera ------------------------------------------------------------------

function applyCamera() {
  const { x, y, zoom } = state.camera;
  ui.canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  ui.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function zoomAt(clientX, clientY, factor) {
  const rect = ui.viewport.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const { x, y, zoom } = state.camera;
  const raw = Math.min(4, Math.max(0.1, zoom * factor));
  const next = crossesOne(zoom, raw) ? 1 : raw;
  const scale = next / zoom;
  state.camera = { zoom: next, x: px - (px - x) * scale, y: py - (py - y) * scale };
  applyCamera();
  drawOverlay();
}

/**
 * 100% is a stop on the ladder, not a step that happens to land nearby.
 *
 * The zoom steps multiply by 1.15, so from the 10% a fresh canvas opens at they
 * run ... 81% -> 94% -> 108% and step straight over 1:1. A design tool whose
 * zoom cannot reach 1:1 is a tool where every look at the drawing is a scaled
 * raster, and scaled text is soft text. A step that would cross 100% stops on it
 * instead, in both directions.
 */
function crossesOne(from, to) {
  return (from < 1 && to > 1) || (from > 1 && to < 1);
}

function fitAll() {
  const pages = state.model?.pages ?? [];
  if (pages.length === 0) return;
  const rect = ui.viewport.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const page of pages) {
    const box = state.boxes.get(page.id);
    const position = box?.position ?? { x: 0, y: 0 };
    const width = box?.width ?? (parseFloat(page.width) || 390);
    const height = box?.height ?? (parseFloat(page.height) || 844);
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + width);
    maxY = Math.max(maxY, position.y + height);
  }
  const pad = 60;
  const zoom = Math.min(
    1.5,
    Math.max(0.1, Math.min((rect.width - pad * 2) / (maxX - minX || 1), (rect.height - pad * 2) / (maxY - minY || 1))),
  );
  state.camera = {
    zoom,
    x: pad - minX * zoom,
    y: pad - minY * zoom,
  };
  applyCamera();
  drawOverlay();
}

// -- load and mount ----------------------------------------------------------

async function loadDocument({ keepCamera = false } = {}) {
  const [stateResponse, fileResponse] = await Promise.all([api("state"), api("file")]);
  if (fileResponse.status !== 200) {
    toast(`Cannot read the file: ${fileResponse.status}`, "refused");
    return;
  }
  state.file = stateResponse.payload?.file ?? state.file;
  state.readOnly = Boolean(stateResponse.payload?.readOnly);
  state.readOnlyReason = stateResponse.payload?.readOnlyReason ?? "";
  state.canUndo = Boolean(stateResponse.payload?.canUndo);
  state.canRedo = Boolean(stateResponse.payload?.canRedo);
  state.text = fileResponse.payload;
  state.revision = fileResponse.revision ?? stateResponse.payload?.revision ?? "";

  document.title = `${state.file} — skill-design`;

  mountAll();
  if (!keepCamera) fitAll();
  renderChrome();
}

/**
 * The geometric findings, in the shape the drawer already renders.
 *
 * The service sends the file text and its metadata, never a document tree, so
 * the browser is the one that decides what the file means. This check is pure,
 * so it runs here on the same parse the canvas renders — the arithmetic and the
 * drawing cannot disagree about what the file says.
 *
 * It is deliberately the only validator family the drawer shows. The rest of the
 * report belongs to `node design.mjs validate`, which is where a writer reads it.
 */
function geometryDiagnostics(doc) {
  const { tokens } = collectTokens(doc);
  return lintGeometry(doc, tokens).map((entry) => ({
    severity: entry.severity,
    code: entry.code,
    message: entry.message,
    target: entry.target,
    path: entry.path,
    hint: entry.hint,
  }));
}

/**
 * Contrast, as the drawer wants it.
 *
 * Contrast is in the drawer because of what the count on the Problems button
 * means. It is read as "this file has this many problems", and the canvas is the
 * only place a reader sees the drawing they are being told about. A file the
 * canvas called clean and `design.mjs validate` called 22 warnings is the canvas
 * lying by omission — the same disagreement between two readers of one result that
 * the `add` receipt used to have.
 *
 * The rest of `validateDesign` is deliberately not run. Structure and property
 * findings are about the file's shape, not the drawing, and a file being edited is
 * allowed to be half-written; 43 rows of `structure/missing-id` in a layout tool is
 * noise that buries the layout. `design.mjs validate` is the full report, and it is
 * the one the write funnel consults.
 */
function contrastDiagnostics(doc) {
  const { tokens } = collectTokens(doc);
  return lintContrast(doc, tokens).map((entry) => ({
    severity: entry.severity ?? "warning",
    code: entry.code,
    message: entry.message,
    target: entry.target,
    path: entry.path,
    hint: entry.hint,
  }));
}

/**
 * What the browser can prove and the arithmetic cannot.
 *
 * `lib/geometry.mjs` works on the file, so it is blind to anything that needs a
 * measurement: a run of text, the intrinsic size of an image, an instance whose
 * component it has not expanded. Here the page is mounted, so every one of those
 * has a real box. This pass reads them.
 *
 * Three traps, each one a way to report something untrue:
 *
 *   - **Zoom.** `applyCamera` puts `transform: scale(zoom)` on `ui.canvas`, so
 *     every rectangle is in screen pixels. Both rectangles are scaled the same way,
 *     so the comparison itself does not care — but the numbers in the message do, so
 *     everything is divided back to CSS pixels first.
 *   - **Expanded instances.** `expandInstance` copies a component's subtree into
 *     the page, so the component's `data-id`s appear more than once. An op never
 *     addresses a copy, so a finding about one would name an element the writer
 *     cannot edit. A repeated id is skipped.
 *   - **Sub-pixel layout.** A fraction of a pixel of overhang is rounding, not a
 *     defect. `lib/geometry.mjs` holds the tolerance.
 */
/**
 * The box an absolutely positioned element is really laid out against.
 *
 * A child in flow is laid out by its parent, so the parent is the box to compare
 * it with. An absolutely positioned child is not: it resolves against its nearest
 * positioned ancestor, and a static parent in between is not that box. Comparing
 * with it reported boxes as leaving a parent they were never inside — and the
 * arithmetic pass in `lib/geometry.mjs` applies the same rule, so both passes name
 * the same box and the merge can still collapse them.
 *
 * A page counts, the same way it does there, because a page may not be positioned.
 */
function containingBlockOf(element) {
  let node = element.parentElement;
  while (node) {
    const position = getComputedStyle(node).position;
    if ((position && position !== "static") || node.getAttribute?.("data-type") === "page") return node;
    node = node.parentElement;
  }
  return null;
}

function measuredGeometryDiagnostics() {
  const zoom = state.camera.zoom || 1;
  const mounted = [];
  const counts = new Map();

  for (const host of ui.canvas.querySelectorAll(".page-box .page-host")) {
    const root = host.shadowRoot;
    if (!root) continue;
    for (const element of root.querySelectorAll("[data-id]")) {
      const id = element.getAttribute("data-id");
      counts.set(id, (counts.get(id) || 0) + 1);
      mounted.push([element, id]);
    }
  }

  const worstByParent = new Map();
  for (const [element, id] of mounted) {
    if (counts.get(id) > 1) continue;
    // Which box this element is measured against. A positioned element is the one
    // case where the parent is the wrong answer; for everything else it is right,
    // and it is also the element the finding has to name.
    const selfStyle = getComputedStyle(element);
    const parent = selfStyle.position === "absolute"
      ? containingBlockOf(element)
      : element.parentElement?.closest?.("[data-id]") ?? null;
    if (!parent) continue;

    const self = element.getBoundingClientRect();
    if (self.width < 1 || self.height < 1) continue;
    const outer = parent.getBoundingClientRect();
    if (outer.width < 1 || outer.height < 1) continue;

    // Back to CSS pixels, where `getComputedStyle` also lives.
    const style = getComputedStyle(parent);
    const num = (value) => parseFloat(value) || 0;
    const padLeft = num(style.paddingLeft) + num(style.borderLeftWidth);
    const padTop = num(style.paddingTop) + num(style.borderTopWidth);
    const contentW = outer.width / zoom - padLeft - num(style.paddingRight) - num(style.borderRightWidth);
    const contentH = outer.height / zoom - padTop - num(style.paddingBottom) - num(style.borderBottomWidth);

    const left = (self.left - outer.left) / zoom - padLeft;
    const top = (self.top - outer.top) / zoom - padTop;
    const width = self.width / zoom;
    const height = self.height / zoom;

    const clipped = ["hidden", "auto", "scroll"].includes(style.overflow);
    const measured = overhangOf(
      { left, top, width, height },
      { width: contentW, height: contentH },
      { positioned: selfStyle.position === "absolute", clips: clipped },
    );
    if (!measured) continue;
    const { over, code } = measured;

    const parentId = parent.getAttribute("data-id");

    // Who the finding is about, and how many of them to emit.
    //
    // `geometry/absolute-outside` is about the node that is out of place, so it
    // is reported per node, exactly as `lib/geometry.mjs` reports it. The other
    // two are about the frame that is too small: a row of three children that do
    // not fit produces the same fact three times, and three copies of one fact is
    // how a report stops being read. One per frame is also what the writer has to
    // change, and it is what the arithmetic pass names, so the two passes
    // describe the same defect the same way and the merge can collapse them.
    const aboutChild = code === "geometry/absolute-outside";
    const key = aboutChild ? `${code}|${id}` : `${code}|${parentId}`;
    const previous = worstByParent.get(key);
    if (previous && previous.over >= over) continue;
    worstByParent.set(key, {
      severity: "warning",
      code,
      target: aboutChild ? id : parentId,
      over,
      message: code === "geometry/absolute-outside"
        ? `A positioned child ${Math.round(width)}x${Math.round(height)} at (${Math.round(left)}, ${Math.round(top)}) is not fully inside this box's content area of ${Math.round(contentW)}x${Math.round(contentH)}`
        : code === "geometry/clipped"
          ? `A child overhangs this box's content area of ${Math.round(contentW)}x${Math.round(contentH)} by ${Math.round(over)}px, and the box hides the rest`
          : `A child overhangs this box's content area of ${Math.round(contentW)}x${Math.round(contentH)} by ${Math.round(over)}px`,
      hint: `measured on the canvas: the widest child is ${Math.round(width)}x${Math.round(height)}, so this is the box the browser drew, not an estimate`,
    });
  }
  return [...worstByParent.values()].map(({ over, ...entry }) => entry);
}

/**
 * The arithmetic findings, with the measured ones given precedence.
 *
 * Both passes can name the same element and the same code. The measured one
 * carries the box the browser actually drew, so it is the one worth reading.
 *
 * The per-code limit is applied **after** the merge, because the merge is where
 * the findings the reader will see are finally assembled. `lintGeometry` keeps the
 * limit on its own half, and the measured half can add more of a code the
 * arithmetic half never saw at all — 25 frames whose text overflows are invisible
 * to the arithmetic and 25 rows in the drawer is exactly the report §6 promises
 * not to hand anyone.
 */
function mergeGeometry(arithmetic, measured) {
  const measuredKeys = new Set(measured.map((entry) => `${entry.code}|${entry.target}`));
  const merged = [
    ...arithmetic.filter((entry) => !measuredKeys.has(`${entry.code}|${entry.target}`)),
    ...measured,
  ];
  const counts = new Map();
  return merged.filter((entry) => {
    const seen = counts.get(entry.code) || 0;
    counts.set(entry.code, seen + 1);
    return seen < MAX_REPORTED_PER_CODE;
  });
}

function recomputeDiagnostics() {
  if (!state.doc) return;
  const arithmetic = geometryDiagnostics(state.doc);
  state.diagnostics = [
    ...(state.doc.diagnostics ?? []),
    ...mergeGeometry(arithmetic, measuredGeometryDiagnostics()),
    ...contrastDiagnostics(state.doc),
  ];
  // `renderProblems` writes the badge as well as the list, so the two cannot
  // disagree. The badge used to be written only by `renderChrome`, which runs
  // before the measured pass finishes: the drawer filled in and the badge went on
  // showing the arithmetic count.
  renderProblems();
}

/**
 * Wait until the mounted pages can be measured.
 *
 * Text laid out in a fallback family is a different width, and an image with no
 * bytes yet is 0x0. A box measured before either arrives is a box the reader never
 * sees, reported as overflow that is not there. Fonts first, then the images that
 * are still loading.
 *
 * The images are given a deadline. An image that never answers — a host that
 * accepts the connection and then says nothing — must not leave the drawer
 * showing a half-finished report for the rest of the session. Two seconds is
 * longer than a local file takes and shorter than a reader's patience; an image
 * that misses it is measured as it stands, and the next mount measures it again.
 */
const IMAGE_WAIT_MS = 2000;

function layoutSettled() {
  const fonts = typeof document.fonts?.ready?.then === "function" ? document.fonts.ready : Promise.resolve();
  return fonts.then(() => {
    const pending = [];
    for (const host of ui.canvas.querySelectorAll(".page-box .page-host")) {
      for (const image of host.shadowRoot?.querySelectorAll("img") ?? []) {
        if (image.complete) continue;
        pending.push(
          new Promise((resolve) => {
            const done = () => resolve();
            image.addEventListener("load", done, { once: true });
            image.addEventListener("error", done, { once: true });
          }),
        );
      }
    }
    if (pending.length === 0) return undefined;
    return Promise.race([
      Promise.all(pending),
      new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS)),
    ]);
  });
}

function mountAll() {
  const started = performance.now();
  const generation = ++mountGeneration;
  state.doc = parse(state.text);
  state.model = renderModel(state.doc);
  // The parser's syntax findings, plus what the layout arithmetic can prove.
  // The parser's syntax findings, plus what the file itself can be held to. The
  // measured pass adds the rest once the page has settled.
  state.diagnostics = [
    ...(state.doc.diagnostics ?? []),
    ...geometryDiagnostics(state.doc),
    ...contrastDiagnostics(state.doc),
  ];
  state.boxes = new Map();
  const positions = arrangePages(state.model.pages, { gap: 48, perRow: 4 });
  state.model.pages.forEach((page, index) => {
    const position = positions[index] ?? { x: 0, y: 0 };
    const declaredHeight = parseFloat(page.height) || 0;
    state.boxes.set(page.id, {
      position,
      width: parseFloat(page.width) || 390,
      // The content decides, unless the page declares a height. The number here
      // is provisional and `measurePageBoxes` replaces it before the camera
      // fits the view.
      height: declaredHeight || 844,
      declaredHeight,
    });
  });

  applyWebfonts();

  ui.canvas.textContent = "";
  for (const page of state.model.pages) {
    ui.canvas.appendChild(buildPageBox(page));
  }
  measurePageBoxes();
  applyCamera();
  drawOverlay();
  renderProblems();

  // The measured pass has to wait until the page has settled. Text laid out in a
  // fallback family is a different width, and an image with no bytes yet is 0x0; a
  // box measured before either arrives is a box the reader never sees, reported as
  // overflow that is not there. The arithmetic pass above needs no waiting, so the
  // drawer is never empty while this runs.
  //
  // It runs once per mount. A later change — a resize, an edit, a font that
  // arrives after its deadline — is measured by the next mount, not by this one.
  layoutSettled().then(() => {
    // A newer mount has already replaced this one; its own pass will run.
    if (generation !== mountGeneration) return;
    recomputeDiagnostics();
  });

  const ms = Math.round(performance.now() - started);
  ui.revision.textContent = `${state.revision} · ${ms}ms`;
  ui.readonly.hidden = !state.readOnly;
  if (state.readOnly) ui.readonly.title = state.readOnlyReason;
  // Ops need a document to apply to, so a file that does not parse can only be repaired
  // by writing its text back. That is the one thing `/api/save` is for, and this button
  // is the only client that calls it.
  document.getElementById("fix-text").hidden = !state.readOnly;
}

/**
 * Ask for the same fonts `export` declares.
 *
 * A design that wraps differently on the canvas than in the deliverable is a
 * design the author approved without seeing. The canvas cannot inline a font, so
 * it requests the same stylesheets the deliverable will, and a machine with no
 * network falls back exactly as the deliverable would.
 */
function applyWebfonts() {
  for (const link of document.querySelectorAll("link[data-canvas-font]")) link.remove();
  // One request per family for the whole file. One per PAGE is a request per
  // page for the same family — ten stylesheets for two families, and the same
  // face declared more than once.
  const hrefs = new Set(webfontLinks(state.model));
  for (const href of hrefs) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.canvasFont = "";
    document.head.appendChild(link);
  }
}

function buildPageBox(page) {
  const box = state.boxes.get(page.id);
  const element = document.createElement("div");
  element.className = "page-box";
  element.dataset.pageId = page.id;
  element.style.left = `${box.position.x}px`;
  element.style.top = `${box.position.y}px`;
  element.style.width = `${box.width}px`;
  // A page that declares no height is as tall as its content. Pinning it to a
  // guessed 844 is how a page gets a scrollbar in the file and a hard cut on the
  // canvas, with the bottom third of the design simply not drawn.
  if (box.declaredHeight) element.style.height = `${box.declaredHeight}px`;
  if (page.isLibrary) element.style.outline = "1px dashed #4c8dff66";

  // The paper is the page's own shape. A page can round its own corners — the
  // component library is a 24px card, not a screen — and the paper sits behind
  // it: a paper with the chrome's own 10px radius under a 24px page shows a white
  // crescent in every corner, a shape the page never drew. The page's radius
  // reaches the paper and the clip, so a page that declares a height is cut at
  // its own shape and not at the paper's.
  const pageRadius = pagePaperRadius(page, state.model.tokens);
  if (pageRadius) element.style.borderRadius = pageRadius;

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `${page.name}${page.isLibrary ? " · library" : ""}`;
  element.appendChild(label);

  const host = document.createElement("div");
  host.className = "page-host";
  host.style.width = "100%";
  host.style.height = box.declaredHeight ? "100%" : "auto";
  host.style.overflow = box.declaredHeight ? "hidden" : "visible";
  host.style.borderRadius = pageRadius || "9px";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  // `canvasMountCss` is the file's rules plus the one rule the canvas owns: a
  // page's outer margin is the document flow's business, and on the canvas the
  // paper is exactly the page. See that function for what goes wrong without it.
  style.textContent = canvasMountCss(state.model);
  root.appendChild(style);

  // The mount IS the page: same tag, same declarations, same `data-id`. The
  // canvas used to mount the page's children into a plain block `<div>`, which
  // threw away `display:flex`, `align-items`, `gap`, `padding` and the
  // background in one go. Every child with no width of its own then filled the
  // page instead of hugging its content, and every padded child grew by its own
  // padding. The file said one thing; the canvas drew another.
  const mount = document.createElement("section");
  mount.setAttribute("data-id", page.id);
  mount.setAttribute("data-type", "page");
  mount.setAttribute("data-name", page.name);
  mount.style.cssText = styleStringOf(page.declarations);
  mount.innerHTML = page.markup;
  root.appendChild(mount);
  element.appendChild(host);

  return element;
}

/** The height a page takes on the canvas: its own, or what its content needs. */
function measurePageBoxes() {
  for (const page of state.model.pages) {
    const box = state.boxes.get(page.id);
    if (!box || box.declaredHeight) continue;
    const host = ui.canvas.querySelector(`.page-box[data-page-id="${CSS.escape(page.id)}"] .page-host`);
    const mount = host?.shadowRoot?.querySelector("section[data-type=\"page\"]");
    if (!mount) continue;
    const height = mount.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) box.height = height;
  }
}

// -- mapping a click back to a data-id --------------------------------------

/** The nearest ancestor-or-self that carries a `data-id`. */
function addressOf(node) {
  let current = node;
  while (current && current.nodeType === 1) {
    const id = current.getAttribute?.("data-id");
    if (id) return { id, element: current };
    current = current.parentNode;
  }
  return null;
}

function targetFromEvent(event) {
  const path = event.composedPath ? event.composedPath() : [];
  for (const entry of path) {
    if (entry?.nodeType !== 1) continue;
    if (entry.classList?.contains("page-box")) {
      const id = entry.dataset.pageId;
      const pageNode = state.model.pages.find((p) => p.id === id)?.node;
      return pageNode ? { id, element: entry, kind: "page" } : null;
    }
    if (entry.hasAttribute?.("data-id")) {
      return { id: entry.getAttribute("data-id"), element: entry, kind: "element" };
    }
  }
  return null;
}

/** The live shadow-root element for a data-id, so the overlay can measure it. */
function elementForId(id) {
  for (const host of ui.canvas.querySelectorAll("*")) {
    const root = host.shadowRoot;
    if (!root) continue;
    const found = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (found) return found;
  }
  const pageBox = ui.canvas.querySelector(`.page-box[data-page-id="${CSS.escape(id)}"]`);
  return pageBox ?? null;
}

// -- overlay -----------------------------------------------------------------

function drawOverlay() {
  ui.overlay.textContent = "";
  const rect = ui.viewport.getBoundingClientRect();
  for (const [id, className] of [[state.selection, "outline"], [state.hovering, "outline hover"]]) {
    if (!id) continue;
    const element = elementForId(id);
    if (!element) continue;
    const box = element.getBoundingClientRect();
    const node = document.createElement("div");
    node.className = className;
    node.style.left = `${box.left - rect.left}px`;
    node.style.top = `${box.top - rect.top}px`;
    node.style.width = `${box.width}px`;
    node.style.height = `${box.height}px`;
    if (className === "outline") {
      for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const handle = document.createElement("div");
        handle.className = "handle";
        handle.dataset.handle = `${hx}${hy}`;
        handle.style.left = `${hx ? box.width : 0}px`;
        handle.style.top = `${hy ? box.height : 0}px`;
        node.appendChild(handle);
      }
    }
    ui.overlay.appendChild(node);
  }
}

// -- chrome ------------------------------------------------------------------

function renderChrome() {
  ui.fileName.textContent = state.file;
  ui.pageList.textContent = "";
  for (const page of state.model.pages) {
    const item = document.createElement("li");
    item.dataset.pageId = page.id;
    if (state.selection === page.id) item.classList.add("selected");
    const name = document.createElement("span");
    name.textContent = page.name;
    item.appendChild(name);
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = page.isLibrary ? "library" : `${state.boxes.get(page.id).width}×${Math.round(state.boxes.get(page.id).height)}`;
    item.appendChild(badge);
    item.addEventListener("click", () => select(page.id, { reveal: true }));
    ui.pageList.appendChild(item);
  }

  ui.layerList.textContent = "";
  const current = state.selection ? findPageOfId(state.selection) : state.model.pages[0]?.id;
  const page = state.model.pages.find((p) => p.id === current) ?? state.model.pages[0];
  if (page) {
    for (const row of pageTree(page.node)) {
      const item = document.createElement("li");
      item.dataset.nodeId = row.id;
      item.style.paddingLeft = `${10 + row.depth * 12}px`;
      if (state.selection === row.id) item.classList.add("selected");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = row.name || row.id || `(${row.tag})`;
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = row.type ?? row.tag;
      item.appendChild(label);
      item.appendChild(type);
      item.addEventListener("click", () => select(row.id, { reveal: true }));
      item.addEventListener("mouseenter", () => { state.hovering = row.id; drawOverlay(); });
      item.addEventListener("mouseleave", () => { state.hovering = null; drawOverlay(); });
      ui.layerList.appendChild(item);
    }
  }

  document.getElementById("undo").disabled = !state.canUndo || state.readOnly;
  document.getElementById("redo").disabled = !state.canRedo || state.readOnly;
  // A file that does not parse has nothing to export, and the service would answer 409.
  // A disabled button says so before the click.
  document.getElementById("export-page").disabled = state.readOnly;
  document.getElementById("export-all").disabled = state.readOnly;

  renderProblems();
  renderInspector();
}

/**
 * The count on the Problems button.
 *
 * It is a summary of the list beside it, so it is written wherever the list is.
 * Keeping it inside `renderChrome` meant the measured pass — which only redrew the
 * list — left a badge reading 2 above a drawer holding 7 rows.
 */
function renderProblemCount() {
  const errors = state.diagnostics.filter((d) => d.severity === "error").length;
  ui.problemCount.textContent = String(state.diagnostics.length);
  ui.problemCount.classList.toggle("has-errors", errors > 0);
}

function findPageOfId(id) {
  for (const page of state.model.pages) {
    if (page.id === id) return page.id;
    const rows = pageTree(page.node);
    if (rows.some((row) => row.id === id)) return page.id;
  }
  return state.model.pages[0]?.id ?? null;
}

function renderProblems() {
  renderProblemCount();
  ui.problemList.textContent = "";
  if (state.diagnostics.length === 0) {
    const row = document.createElement("div");
    row.className = "issue";
    row.innerHTML = '<span class="msg muted">No problems.</span>';
    ui.problemList.appendChild(row);
    return;
  }
  for (const diagnostic of state.diagnostics) {
    const row = document.createElement("div");
    row.className = "issue";
    const sev = document.createElement("span");
    sev.className = `sev ${diagnostic.severity}`;
    sev.textContent = diagnostic.severity;
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = diagnostic.code;
    const message = document.createElement("span");
    message.className = "msg";
    message.textContent = diagnostic.message;
    if (diagnostic.hint) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = diagnostic.hint;
      message.appendChild(hint);
    }
    row.appendChild(sev);
    row.appendChild(code);
    row.appendChild(message);
    if (diagnostic.target) {
      row.addEventListener("click", () => select(diagnostic.target, { reveal: true }));
    }
    ui.problemList.appendChild(row);
  }
}

// -- inspector ---------------------------------------------------------------

const NUMERIC = /^-?\d+(\.\d+)?(px|%)?$/;

function renderInspector() {
  ui.inspector.textContent = "";
  const id = state.selection;
  if (!id) {
    ui.selectionName.textContent = "Nothing selected";
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Click an element on the canvas, or a row in the layer tree.";
    ui.inspector.appendChild(empty);
    return;
  }
  const node = findNode(id);
  if (!node) {
    ui.selectionName.textContent = id;
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "This element is no longer in the file.";
    ui.inspector.appendChild(empty);
    return;
  }

  const type = getAttr(node, "data-type") ?? node.tag;
  ui.selectionName.textContent = `${getAttr(node, "data-name") || id}`;

  const identity = document.createElement("dl");
  identity.className = "attrs";
  for (const [label, value] of [
    ["data-id", id],
    ["data-type", type],
    ["tag", node.tag],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value ?? "—";
    identity.appendChild(dt);
    identity.appendChild(dd);
  }
  ui.inspector.appendChild(identity);

  const styleMap = styleMapOf(node);
  if (styleMap.size) {
    const heading = document.createElement("div");
    heading.className = "group";
    heading.textContent = "Style";
    ui.inspector.appendChild(heading);
    for (const [property, value] of styleMap) {
      ui.inspector.appendChild(buildField(id, node, property, value));
    }
  }

  if (node.kind === "element" && ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span"].includes(node.tag)) {
    const heading = document.createElement("div");
    heading.className = "group";
    heading.textContent = "Text";
    ui.inspector.appendChild(heading);
    const text = (node.children ?? []).filter((c) => c.kind === "text").map((c) => c.value).join("");
    const field = document.createElement("div");
    field.className = "field";
    const input = document.createElement("input");
    input.type = "text";
    input.value = text;
    input.disabled = state.readOnly;
    input.addEventListener("change", () => {
      commit([{ op: "set", target: id, prop: "text", value: input.value }]);
    });
    field.appendChild(input);
    ui.inspector.appendChild(field);
  }
}

function buildField(id, node, property, value) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = property;
  field.appendChild(label);

  const isColor = property === "color" || property === "background-color" || property === "border-color";
  const bare = String(value);
  const varMatch = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(bare);

  if (isColor && /^#[0-9a-fA-F]{6,8}$/.test(bare)) {
    const input = document.createElement("input");
    input.type = "color";
    input.value = bare.slice(0, 7);
    input.disabled = state.readOnly;
    input.addEventListener("change", () => {
      commit([{ op: "set", target: id, prop: `style:${property}`, value: input.value }]);
    });
    field.appendChild(input);
    const raw = document.createElement("div");
    raw.className = "value-line";
    raw.textContent = bare;
    field.appendChild(raw);
    return field;
  }

  if (varMatch) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = bare;
    input.disabled = state.readOnly;
    input.addEventListener("change", () => {
      commit([{ op: "set", target: id, prop: `style:${property}`, value: input.value }]);
    });
    field.appendChild(input);
    const resolved = resolveTokens(bare, state.model.tokens);
    if (resolved !== bare) {
      const line = document.createElement("div");
      line.className = "value-line";
      line.textContent = `→ ${resolved}`;
      field.appendChild(line);
    }
    return field;
  }

  if (NUMERIC.test(bare)) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = bare;
    input.className = "scrub";
    input.disabled = state.readOnly;
    input.title = "Drag left or right to change, or type a value";
    input.addEventListener("change", () => {
      commit([{ op: "set", target: id, prop: `style:${property}`, value: input.value }]);
    });
    attachScrub(input, (next) => {
      commit([{ op: "set", target: id, prop: `style:${property}`, value: next }]);
    });
    field.appendChild(input);
    return field;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.value = bare;
  input.disabled = state.readOnly;
  input.addEventListener("change", () => {
    commit([{ op: "set", target: id, prop: `style:${property}`, value: input.value }]);
  });
  field.appendChild(input);
  return field;
}

/**
 * A number that scrubs.
 *
 * Only the value is previewed while the pointer moves; the op is sent on
 * release. Sending an op per pixel would fill the change log with steps nobody
 * asked for, and every one of them is an undo step.
 */
function attachScrub(input, onCommit) {
  let startX = 0;
  let startValue = 0;
  let unit = "";
  let active = false;

  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    active = true;
    startX = event.clientX;
    const match = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(input.value.trim());
    startValue = match ? Number(match[1]) : 0;
    unit = match ? match[2] : "";
    capturePointer(input, event.pointerId);
    event.preventDefault();
  });

  input.addEventListener("pointermove", (event) => {
    if (!active) return;
    const delta = Math.round((event.clientX - startX) / 2);
    input.value = `${startValue + delta}${unit}`;
  });

  input.addEventListener("pointerup", (event) => {
    if (!active) return;
    active = false;
    try { input.releasePointerCapture(event.pointerId); } catch { /* released */ }
    const next = input.value.trim();
    if (next !== `${startValue}${unit}`) onCommit(next);
  });
}

function findNode(id) {
  if (!state.doc) return null;
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (node.kind === "element" && getAttr(node, "data-id") === id) { found = node; return; }
    for (const child of node.children ?? []) visit(child);
  };
  visit(state.doc);
  return found;
}

// -- selection ---------------------------------------------------------------

function select(id, options = {}) {
  state.selection = id;
  if (options.reveal) reveal(id);
  renderChrome();
}

function reveal(id) {
  const element = elementForId(id);
  if (!element) return;
  const rect = ui.viewport.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const inside = box.left >= rect.left && box.right <= rect.right && box.top >= rect.top && box.bottom <= rect.bottom;
  if (inside) return;
  const zoom = state.camera.zoom;
  state.camera.x += rect.left + rect.width / 2 - (box.left + box.width / 2);
  state.camera.y += rect.top + rect.height / 2 - (box.top + box.height / 2);
  applyCamera();
  drawOverlay();
}

// -- writes ------------------------------------------------------------------

/**
 * Every write from the canvas goes through here, and every one of them goes
 * through the service's funnel: revalidate, refuse on a new error, write
 * atomically. The canvas has no privileged path.
 */
async function commit(ops) {
  if (state.readOnly) {
    toast("The file is read only. Fix the problem it reports first.", "refused");
    return;
  }
  if (state.busy) return;
  state.busy = true;
  const originalText = state.text;
  try {
    const { status, payload } = await api("ops", { body: { baseRevision: state.revision, ops } });
    if (status === 200 && payload?.ok) {
      state.revision = payload.revision;
      state.canUndo = true;
      state.canRedo = false;
      await loadDocument({ keepCamera: true });
      return;
    }
    // A refusal is a result. The whole point of refusing is to show what the
    // edit would have introduced, so that is what the drawer shows.
    state.text = originalText;
    if (payload?.diagnostics?.length) {
      state.diagnostics = payload.diagnostics;
      renderProblems();
      ui.problems.hidden = false;
      toast(`Refused: ${payload.diagnostics[0].message}`, "refused");
    } else {
      toast(`Refused: ${payload?.code ?? status}`, "refused");
    }
    await loadDocument({ keepCamera: true });
  } catch (error) {
    toast(`The service did not accept that: ${error.message}`, "refused");
  } finally {
    state.busy = false;
  }
}

// -- gestures ----------------------------------------------------------------

let drag = null;

/**
 * Capture is an optimisation, not a requirement: it keeps the events coming when
 * the pointer leaves the element. It throws when there is no live pointer for
 * the id, and an uncaught throw here would abort the rest of the handler and
 * leave the interaction half-applied. So it is attempted, never trusted.
 */
function capturePointer(element, pointerId) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* the drag still works without capture */
  }
}

ui.viewport.addEventListener("pointerdown", (event) => {
  const target = event.target;
  const handle = target?.classList?.contains("handle") ? target : null;

  if (handle && state.selection) {
    const element = elementForId(state.selection);
    if (element) {
      const start = element.getBoundingClientRect();
      drag = { kind: "resize", corner: handle.dataset.handle, id: state.selection, startX: event.clientX, startY: event.clientY, startWidth: start.width, startHeight: start.height, startLeft: start.left, startTop: start.top, element };
      capturePointer(ui.viewport, event.pointerId);
      event.preventDefault();
      return;
    }
  }

  const label = target?.classList?.contains("page-label") ? target : null;
  if (label || event.altKey) {
    const pageBox = target.closest(".page-box");
    if (pageBox) {
      drag = pageDrag(pageBox, pageBox.dataset.pageId, event);
      capturePointer(ui.viewport, event.pointerId);
      event.preventDefault();
      return;
    }
  }

  if (target === ui.viewport || target === ui.canvas) {
    drag = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: state.camera.x, originY: state.camera.y };
    ui.viewport.classList.add("panning");
    capturePointer(ui.viewport, event.pointerId);
    return;
  }

  const hit = targetFromEvent(event);
  if (hit) {
    select(hit.id);
    // A page is placed by `data-canvas`, and that is the only spelling for it.
    // This used to fall through to the frame path below, which writes
    // `position:absolute` plus `left`/`top`: the canvas ignores those on a page
    // because it positions one from `data-canvas`, so the file looked right
    // here while `export` shipped the page pushed off its own top-left corner.
    drag = hit.kind === "page"
      ? pageDrag(hit.element, hit.id, event)
      : { kind: "maybe-move", id: hit.id, startX: event.clientX, startY: event.clientY, moved: false, element: elementForId(hit.id) };
    capturePointer(ui.viewport, event.pointerId);
  } else {
    select(null);
  }
});

/** A drag that moves a whole page. `data-canvas` is what it commits. */
function pageDrag(pageBox, id, event) {
  const box = state.boxes.get(id);
  return {
    kind: "page", id, element: pageBox,
    startX: event.clientX, startY: event.clientY,
    originX: box?.position?.x ?? 0, originY: box?.position?.y ?? 0,
    zoom: state.camera.zoom,
  };
}

ui.viewport.addEventListener("pointermove", (event) => {
  if (!drag) {
    const hit = targetFromEvent(event);
    const next = hit?.id ?? null;
    if (next !== state.hovering) {
      state.hovering = next;
      drawOverlay();
    }
    return;
  }

  if (drag.kind === "pan") {
    state.camera.x = drag.originX + (event.clientX - drag.startX);
    state.camera.y = drag.originY + (event.clientY - drag.startY);
    applyCamera();
    return;
  }

  if (drag.kind === "page") {
    const zoom = drag.zoom || 1;
    const x = Math.round(drag.originX + (event.clientX - drag.startX) / zoom);
    const y = Math.round(drag.originY + (event.clientY - drag.startY) / zoom);
    drag.element.style.left = `${x}px`;
    drag.element.style.top = `${y}px`;
    drag.moved = { x, y };
    return;
  }

  if (drag.kind === "maybe-move") {
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved && drag.element) {
      drag.element.style.translate = `${dx / state.camera.zoom}px ${dy / state.camera.zoom}px`;
    }
    return;
  }

  if (drag.kind === "resize") {
    const zoom = state.camera.zoom || 1;
    const dx = (event.clientX - drag.startX) / zoom;
    const dy = (event.clientY - drag.startY) / zoom;
    const [hx, hy] = drag.corner.split("").map(Number);
    const width = Math.max(1, Math.round(drag.startWidth + (hx ? dx : 0)));
    const height = Math.max(1, Math.round(drag.startHeight + (hy ? dy : 0)));
    drag.element.style.width = `${width}px`;
    drag.element.style.height = `${height}px`;
    drag.pending = { width, height };
  }
});

ui.viewport.addEventListener("pointerup", (event) => {
  if (!drag) return;
  const current = drag;
  drag = null;
  ui.viewport.classList.remove("panning");

  if (current.kind === "page" && current.moved) {
    const { x, y } = current.moved;
    const node = state.model.pages.find((p) => p.id === current.id);
    if (node) commit([{ op: "set", target: current.id, prop: "data-canvas", value: `${x},${y}` }]);
    return;
  }

  if (current.kind === "maybe-move" && current.moved) {
    const dx = Math.round((event.clientX - current.startX) / (state.camera.zoom || 1));
    const dy = Math.round((event.clientY - current.startY) / (state.camera.zoom || 1));
    if (current.element) current.element.style.translate = "";
    const node = findNode(current.id);
    if (!node) return;
    const map = styleMapOf(node);
    // A frame moves by becoming positioned. That is one spelling, not two: the
    // canonical form has absolute placement as `position:absolute` plus
    // `left`/`top`, so the canvas writes exactly that.
    const left = (parseFloat(map.get("left")) || 0) + dx;
    const top = (parseFloat(map.get("top")) || 0) + dy;
    commit([
      { op: "set", target: current.id, prop: "style:position", value: "absolute" },
      { op: "set", target: current.id, prop: "style:left", value: `${Math.round(left)}px` },
      { op: "set", target: current.id, prop: "style:top", value: `${Math.round(top)}px` },
    ]);
    return;
  }

  if (current.kind === "resize" && current.pending) {
    commit([
      { op: "set", target: current.id, prop: "style:width", value: `${current.pending.width}px` },
      { op: "set", target: current.id, prop: "style:height", value: `${current.pending.height}px` },
    ]);
  }
});

ui.viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.08 : 1 / 1.08);
    return;
  }
  if (event.shiftKey) state.camera.x -= event.deltaY;
  else { state.camera.x -= event.deltaX; state.camera.y -= event.deltaY; }
  applyCamera();
  drawOverlay();
}, { passive: false });

window.addEventListener("keydown", (event) => {
  const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (inField) return;
  if (event.key === " ") {
    ui.viewport.classList.add("move-mode");
    event.preventDefault();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    if (!state.selection) return;
    event.preventDefault();
    commit([{ op: "remove", target: state.selection }]);
    return;
  }
  if (event.key === "Escape") {
    select(null);
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[event.key] && state.selection) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const [dx, dy] = arrows[event.key];
    const node = findNode(state.selection);
    if (!node) return;
    const map = styleMapOf(node);
    const left = (parseFloat(map.get("left")) || 0) + dx * step;
    const top = (parseFloat(map.get("top")) || 0) + dy * step;
    commit([
      { op: "set", target: state.selection, prop: "style:position", value: "absolute" },
      { op: "set", target: state.selection, prop: "style:left", value: `${left}px` },
      { op: "set", target: state.selection, prop: "style:top", value: `${top}px` },
    ]);
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === " ") ui.viewport.classList.remove("move-mode");
});

// -- top bar actions ---------------------------------------------------------

document.getElementById("zoom-in").addEventListener("click", () => {
  const rect = ui.viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.15);
});
document.getElementById("zoom-out").addEventListener("click", () => {
  const rect = ui.viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.15);
});
document.getElementById("fit").addEventListener("click", fitAll);
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("redo").addEventListener("click", redo);
document.getElementById("toggle-problems").addEventListener("click", () => {
  ui.problems.hidden = !ui.problems.hidden;
});
document.getElementById("export-page").addEventListener("click", () => exportPages(false));
document.getElementById("export-all").addEventListener("click", () => exportPages(true));
document.getElementById("close-problems").addEventListener("click", () => {
  ui.problems.hidden = true;
});
document.getElementById("fix-text").addEventListener("click", openFixText);
document.getElementById("fix-save").addEventListener("click", saveFixText);

/**
 * Read the file back into a textarea so a person can repair what does not parse.
 *
 * `/api/save` has existed since the service did and nothing called it: a file the parser
 * rejects was read-only, with no way out from the canvas but an editor outside it. A
 * broken file is exactly when someone wants the canvas open — it is where the diagnostics
 * are.
 *
 * `baseRevision` is sent with the text, so a save that would land on top of a change made
 * while the textarea was open is answered with `rebased: true` and says so, rather than
 * replacing the other writer's work in silence.
 */
async function openFixText() {
  const { payload } = await api("file");
  if (typeof payload !== "string") {
    toast("Could not read the file.", "refused");
    return;
  }
  ui.fixText.value = payload;
  ui.fixHint.textContent = "This file does not parse, so it cannot be edited one change at a time. Fix the text, then save — the whole file is replaced.";
  ui.fixPane.hidden = false;
  document.getElementById("fix-save").hidden = false;
  ui.problems.hidden = false;
  ui.fixText.focus();
}

async function saveFixText() {
  const text = ui.fixText.value;
  const { payload } = await api("save", { body: { baseRevision: state.revision, text } });
  if (!payload?.ok) {
    const diagnostics = payload?.diagnostics ?? [];
    if (diagnostics.length > 0) {
      state.diagnostics = diagnostics;
      renderProblems();
    }
    ui.fixHint.textContent = payload?.message ?? "The text was refused.";
    toast(payload?.message ?? "The text was refused.", "refused");
    return;
  }
  ui.fixPane.hidden = true;
  document.getElementById("fix-save").hidden = true;
  ui.fixText.value = "";
  if (payload.rebased) {
    toast("Saved, but the file had changed while you were typing.", "refused");
  } else {
    toast("Saved.", "ok");
  }
  await loadDocument({ keepCamera: true });
}

/**
 * Write the deliverable the user is looking at.
 *
 * The canvas cannot write files, so it asks the service to — and the service calls
 * `lib/export-html.mjs`, the same functions `design.mjs export` calls. A deliverable taken
 * from here and one taken from the command line are the same bytes, which is the property
 * that makes "export" mean one thing.
 *
 * A refusal with diagnostics opens the drawer rather than flashing a toast: the file has a
 * problem the user has to see, and 7 seconds is not enough time to read a diagnostic.
 */
async function exportPages(all) {
  const { payload } = await api("export", { body: all ? { all: true } : {} });
  if (payload?.ok) {
    const names = payload.files.map((entry) => entry.path.split("/").pop());
    toast(`Wrote ${names.join(", ")}`, "ok");
    return;
  }
  const diagnostics = payload?.diagnostics ?? [];
  if (diagnostics.length > 0) {
    state.diagnostics = diagnostics;
    renderProblems();
    ui.problems.hidden = false;
  }
  toast(payload?.message ?? "Export refused.", "refused");
}

async function undo() {
  const { payload } = await api("undo", { body: {} });
  if (payload?.ok) {
    state.canUndo = Boolean(payload.canUndo);
    state.canRedo = Boolean(payload.canRedo);
    await loadDocument({ keepCamera: true });
  } else {
    toast("Nothing to undo.", "");
  }
}

async function redo() {
  const { payload } = await api("redo", { body: {} });
  if (payload?.ok) {
    state.canUndo = Boolean(payload.canUndo);
    state.canRedo = Boolean(payload.canRedo);
    await loadDocument({ keepCamera: true });
  } else {
    toast("Nothing to redo.", "");
  }
}

// -- live updates ------------------------------------------------------------

/**
 * The file has two writers, so the canvas has to hear about the other one.
 * A revision it already has is ignored: the canvas caused that write itself.
 */
function subscribe() {
  const events = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  events.addEventListener("changed", async (event) => {
    let revision = null;
    try { revision = JSON.parse(event.data)?.revision; } catch { /* plain text */ }
    if (revision && revision === state.revision) return;
    await loadDocument({ keepCamera: true });
  });
  events.addEventListener("hello", () => { /* the stream is live */ });
  events.onerror = () => { /* EventSource reconnects on its own */ };
}

window.addEventListener("resize", () => drawOverlay());
window.addEventListener("beforeunload", () => {
  navigator.sendBeacon(`/api/bye?t=${encodeURIComponent(TOKEN)}`);
});

window.addEventListener("error", (event) => {
  toast(`Canvas error: ${event.message}`, "refused");
});

// -- start -------------------------------------------------------------------

/**
 * Start. A failure here must be visible: a canvas that renders nothing and says
 * nothing is the worst possible failure mode, because it looks like a design
 * with no pages.
 */
loadDocument()
  .then(subscribe)
  .catch(async (error) => {
    ui.revision.textContent = "load failed";
    toast(`Cannot load the design: ${error.message}`, "refused");
    const panel = document.createElement("p");
    panel.className = "empty";
    panel.textContent = `${error.message}`;
    ui.inspector.prepend(panel);
    console.error(error);
  });
