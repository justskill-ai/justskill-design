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
import {
  newView, pageRoots, isOpen, toggleNode, openPath, visibleNodes, hasChildren, pathTo,
  expandAll, collapseAll, rungAt,
} from "./tree.mjs";
import {
  groupedFields, controlFor, valuesFor, hintFor, rangeFor, scrubFor, isNumericValue,
} from "./groups.mjs";

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
  // What the pointer is over, and which page it is over — ids repeat across
  // pages, so the id alone does not name an element. The selection remembers its
  // page for the same reason: the box has to be drawn around the copy the user
  // picked, not around the first copy with that id in the document.
  hoveringPage: null,
  selectionPage: null,
  // The layer tree: the nested nodes, what is open, and which row has the keyboard.
  tree: [],
  treeView: newView(),
  treeFocus: null,
  revealedFor: null,
  lastSelection: null,
  // Set by a selection made on the canvas: the row has to be opened to and
  // scrolled to even when the selection did not change.
  expandRow: false,
  /*
   * The rung the canvas is standing on, as a depth: 1 is "the page's own
   * children", 2 is "their children", and 0 happens when someone selects a page
   * itself. A depth rather than an element, because the solid box follows the
   * pointer — hovering the next section along has to land on *that* section, and
   * an element-shaped level could only ever name one of them.
   */
  levelDepth: 1,
  // The inspector sections the user folded shut, by section id.
  folded: new Set(),
};

/** Counts mounts, so a font callback from a replaced mount can be ignored. */
let mountGeneration = 0;

const ui = {
  viewport: document.getElementById("viewport"),
  canvas: document.getElementById("canvas"),
  overlay: document.getElementById("overlay"),
  layerTree: document.getElementById("layer-tree"),
  treeExpand: document.getElementById("tree-expand"),
  treeCollapse: document.getElementById("tree-collapse"),
  panelLeft: document.getElementById("panel-left"),
  panelRight: document.getElementById("panel-right"),
  dividerLeft: document.getElementById("divider-left"),
  dividerRight: document.getElementById("divider-right"),
  toggleLeft: document.getElementById("toggle-left"),
  toggleRight: document.getElementById("toggle-right"),
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
  /*
   * The middle of every page, put in the middle of the viewport.
   *
   * This used to anchor the drawing's top-left corner `pad` pixels from the
   * viewport's top-left, which is only centred when the pages and the window have
   * the same shape. They rarely do — a phone-shaped column of artboards in a wide
   * window left the whole right half empty and every page pinned to the corner,
   * which reads as a canvas that failed to fit rather than one that fitted the
   * wrong way.
   */
  state.camera = {
    zoom,
    x: rect.width / 2 - ((minX + maxX) / 2) * zoom,
    y: rect.height / 2 - ((minY + maxY) / 2) * zoom,
  };
  applyCamera();
  drawOverlay();
}

// -- panels ------------------------------------------------------------------

/**
 * Panel geometry: which panels are open, and how wide.
 *
 * This is chrome state and it stays chrome state. It is not written into the
 * design file, it is not sent to the service, and it takes no part in a commit:
 * opening a panel is not an edit, and a design file that changed because someone
 * resized a sidebar would break the one promise this whole tool is built on.
 *
 * It is remembered in `localStorage`, keyed per browser rather than per file —
 * which panel you like open is a fact about you, not about the document. A
 * browser that refuses (private mode throws on write) gets the defaults every
 * time: mildly annoying, never broken.
 */
const PANEL_KEY = "skill-design.canvas.panels";
const PANEL_MIN = 160;
const PANEL_GUTTER = 6; // must match the `--gutter-*` default in styles.css
const PANEL_DEFAULT = { left: 240, right: 260 };

const panels = {
  left: { open: true, width: PANEL_DEFAULT.left },
  right: { open: true, width: PANEL_DEFAULT.right },
};

function loadPanels() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null");
  } catch {
    saved = null; // no storage, or something else owns that key
  }
  for (const side of ["left", "right"]) {
    const entry = saved?.[side];
    if (!entry) continue;
    if (typeof entry.open === "boolean") panels[side].open = entry.open;
    if (Number.isFinite(entry.width)) panels[side].width = entry.width;
  }
  // Read first, clamp after: a remembered width is clamped against the *other*
  // remembered width, whichever order the two happen to be read in.
  reclampPanels();
}

function savePanels() {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panels));
  } catch {
    /* the canvas works without remembering anything */
  }
}

/** The narrowest centre column that is still a canvas. */
const CANVAS_MIN = 160;

/**
 * Never narrower than a usable column, and never so wide that the canvas — or
 * the other panel — is squeezed out of the window.
 *
 * The ceiling used to be half the window per side, which is a rule that only
 * holds while one panel is open. Two panels at half the window add up to more
 * than the window: the centre track resolves to zero, and `overflow: hidden`
 * then hides the canvas and the two buttons that live on it, with the state
 * written to `localStorage` for the next visit. Measured against the space that
 * is actually left, the two sides cannot starve the middle.
 */
function clampPanel(side, width) {
  const other = side === "left" ? "right" : "left";
  const otherTrack = panels[other].open ? panels[other].width + PANEL_GUTTER : 0;
  const ceiling = Math.max(PANEL_MIN, window.innerWidth - otherTrack - PANEL_GUTTER - CANVAS_MIN);
  return Math.round(Math.min(Math.max(width, PANEL_MIN), ceiling));
}

/**
 * Bring both panels back inside the window.
 *
 * Two passes, because the ceiling of one side is computed from the other: a
 * shrink on the right can be what makes room on the left.
 */
function reclampPanels() {
  withPanelGeometry(() => {
    for (const side of ["left", "right"]) panels[side].width = clampPanel(side, panels[side].width);
    for (const side of ["right", "left"]) panels[side].width = clampPanel(side, panels[side].width);
  });
}

/** The horizontal space the left panel takes from the viewport, in pixels. */
function leftTrackWidth() {
  return panels.left.open ? panels.left.width + PANEL_GUTTER : 0;
}

/**
 * Run a geometry change and keep the drawing where it was on screen.
 *
 * The canvas is anchored to the viewport's top-left corner, and collapsing or
 * resizing the left panel moves exactly that corner — so the whole design slides
 * sideways with it. A panel is chrome: changing one must not move the thing
 * being designed. The correction is the change in the left track, measured
 * rather than assumed, and the right panel needs none because it moves no
 * corner.
 */
function withPanelGeometry(change) {
  const before = leftTrackWidth();
  change();
  applyPanels();
  const after = leftTrackWidth();
  if (after !== before) {
    state.camera.x -= after - before;
    applyCamera();
  }
  drawOverlay();
}

/**
 * Write the geometry into the four variables the layout reads.
 *
 * `#stage` sizes its tracks from them and `.drawer` anchors its edges to them.
 * A collapsed panel sets its own to 0, gutter included: a hidden panel that
 * leaves a 6px slot behind is a hidden panel you can still see.
 */
function applyPanels() {
  const root = document.documentElement.style;
  for (const side of ["left", "right"]) {
    const { open, width } = panels[side];
    root.setProperty(`--panel-${side}`, open ? `${width}px` : "0px");
    root.setProperty(`--gutter-${side}`, open ? `${PANEL_GUTTER}px` : "0px");
  }
  ui.panelLeft.hidden = !panels.left.open;
  ui.panelRight.hidden = !panels.right.open;
  ui.dividerLeft.hidden = !panels.left.open;
  ui.dividerRight.hidden = !panels.right.open;
  // A focusable `separator` is a widget, and a widget reports its value. Written
  // here rather than in the HTML so the bounds have one definition: `PANEL_MIN`
  // and the same ceiling `clampPanel` uses.
  for (const [side, divider] of [["left", ui.dividerLeft], ["right", ui.dividerRight]]) {
    divider.setAttribute("aria-valuenow", String(panels[side].width));
    divider.setAttribute("aria-valuemin", String(PANEL_MIN));
    divider.setAttribute("aria-valuemax", String(Math.max(PANEL_MIN, Math.round(window.innerWidth / 2))));
  }
  for (const [side, button] of [["left", ui.toggleLeft], ["right", ui.toggleRight]]) {
    button.setAttribute("aria-pressed", String(panels[side].open));
    button.classList.toggle("off", !panels[side].open);
    button.title = `${panels[side].open ? "Hide" : "Show"} the ${side === "left" ? "layers panel" : "inspector"} (${side === "left" ? "⌘\\" : "⇧⌘\\"})`;
  }
}

function setPanelWidth(side, width, { remember = true } = {}) {
  withPanelGeometry(() => { panels[side].width = clampPanel(side, width); });
  if (remember) savePanels();
}

function togglePanel(side) {
  withPanelGeometry(() => { panels[side].open = !panels[side].open; });
  savePanels();
}

/**
 * A panel edge, dragged.
 *
 * Pointer capture is what makes this feel like an edge instead of a 6px strip:
 * the pointer is free to leave the divider, and the width still follows it. The
 * keyboard gets the same two keys the divider's `separator` role implies, so the
 * layout is not mouse-only.
 */
function initDivider(side, element) {
  const outward = side === "left" ? 1 : -1; // which way grows this panel
  let dragging = null;

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = { pointerId: event.pointerId, startX: event.clientX, startWidth: panels[side].width };
    capturePointer(element, event.pointerId);
    element.classList.add("dragging");
    event.preventDefault();
  });

  element.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    setPanelWidth(side, dragging.startWidth + (event.clientX - dragging.startX) * outward, { remember: false });
  });

  const end = (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    dragging = null;
    element.classList.remove("dragging");
    try { element.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    savePanels();
  };
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);

  element.addEventListener("dblclick", () => setPanelWidth(side, PANEL_DEFAULT[side]));

  element.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 8;
    if (event.key === "ArrowLeft") setPanelWidth(side, panels[side].width - step * outward);
    else if (event.key === "ArrowRight") setPanelWidth(side, panels[side].width + step * outward);
    else return;
    event.preventDefault();
    // And it stops here. The canvas nudges the selected element on the same two
    // keys, so a resize keypress that was allowed to bubble resized a panel *and*
    // committed a one-pixel move — a write from a gesture that is supposed to
    // touch nothing but chrome.
    event.stopPropagation();
  });
}

function wirePanels() {
  loadPanels();
  applyPanels();
  initDivider("left", ui.dividerLeft);
  initDivider("right", ui.dividerRight);
  ui.toggleLeft.addEventListener("click", () => togglePanel("left"));
  ui.toggleRight.addEventListener("click", () => togglePanel("right"));
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
  buildTree();
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

/**
 * What a canvas event is over, and *which page* it is over.
 *
 * The page is not decoration. Ids repeat across a document — every instance of a
 * component expands into a copy that keeps the component's inner ids — so an id
 * on its own names one element per instantiation, and a lookup that does not say
 * which artboard to look in answers with a copy somewhere else on the canvas.
 * The composed path knows: the page box is in it, after the element.
 */
function targetFromEvent(event) {
  const path = event.composedPath ? event.composedPath() : [];
  const pageBox = path.find((entry) => entry?.classList?.contains("page-box")) ?? null;
  const pageId = pageBox?.dataset.pageId ?? null;
  for (const entry of path) {
    if (entry?.nodeType !== 1) continue;
    if (entry === pageBox) {
      const pageNode = state.model.pages.find((p) => p.id === pageId)?.node;
      return pageNode ? { id: pageId, element: entry, kind: "page", pageId } : null;
    }
    if (entry.hasAttribute?.("data-id")) {
      return { id: entry.getAttribute("data-id"), element: entry, kind: "element", pageId };
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

/**
 * The boxes on the canvas, in the order they are painted.
 *
 *   the selection   solid, with the four resize handles
 *   the level       solid, thinner, no handles — what the pointer is standing on
 *   its children    dashed — one click each, and one level down
 *   the one under the pointer   dashed, with a wash, so "what will I get" is not
 *                               a guess between two boxes that overlap
 *
 * The level is drawn as a box of its own only when it is not already the
 * selection, because two borders on one element reads as a mistake.
 */
function drawOverlay() {
  ui.overlay.textContent = "";
  const rect = ui.viewport.getBoundingClientRect();

  if (state.selection) {
    // The page it was picked in, when that is known; otherwise the id is all
    // there is and the first match is the answer, as it always was.
    const element = (state.selectionPage ? elementInPage(state.selectionPage, state.selection) : null)
      ?? elementForId(state.selection);
    if (element) ui.overlay.appendChild(boxOver(element, rect, "outline", { handles: true, id: state.selection }));
  }

  const picture = hoverPicture();
  if (!picture) return;

  if (picture.levelId !== state.selection) {
    const element = elementInPage(picture.pageId, picture.levelId);
    if (element) ui.overlay.appendChild(boxOver(element, rect, "outline level", { id: picture.levelId }));
  }

  for (const child of picture.children) {
    const element = elementInPage(picture.pageId, child.id);
    if (!element) continue;
    const className = child.id === picture.underId ? "outline child under" : "outline child";
    ui.overlay.appendChild(boxOver(element, rect, className, { id: child.id }));
  }
}

function boxOver(element, rect, className, { handles = false, id = null } = {}) {
  const box = element.getBoundingClientRect();
  const node = document.createElement("div");
  node.className = className;
  // Which element this box is around. Nothing reads it but a test and a
  // console; a box that cannot say what it is a box around is a box nobody can
  // debug.
  if (id) node.dataset.id = id;
  node.style.left = `${box.left - rect.left}px`;
  node.style.top = `${box.top - rect.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
  if (!handles) return node;
  for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const handle = document.createElement("div");
    handle.className = "handle";
    handle.dataset.handle = `${hx}${hy}`;
    handle.style.left = `${hx ? box.width : 0}px`;
    handle.style.top = `${hy ? box.height : 0}px`;
    node.appendChild(handle);
  }
  return node;
}

// -- chrome ------------------------------------------------------------------

function renderChrome() {
  ui.fileName.textContent = state.file;
  renderLayerTree();

  document.getElementById("undo").disabled = !state.canUndo || state.readOnly;
  document.getElementById("redo").disabled = !state.canRedo || state.readOnly;
  // A file that does not parse has nothing to export, and the service would answer 409.
  // A disabled button says so before the click.
  document.getElementById("export-page").disabled = state.readOnly;
  document.getElementById("export-all").disabled = state.readOnly;

  renderProblems();
  renderInspector();
}

// -- the layer tree ----------------------------------------------------------

/**
 * Rebuild the nested tree from the model.
 *
 * Called when the document changes, not when the selection does: `pageTree()`
 * walks every element of every page, and doing that on each selection change
 * (which the first version of this panel did, at more than ten times the data)
 * is a walk whose result nobody edited.
 */
function buildTree() {
  state.tree = state.model ? pageRoots(state.model.pages, (page) => pageTree(page.node)) : [];
}

/**
 * The two buttons in the Layers header.
 *
 * They are the standing intent — "everything open" or "everything closed" — not
 * a loop over the rows that are open right now. That is what makes them O(1) on
 * a file with three thousand rows, and what makes an expanded branch survive:
 * the exceptions a person made with a chevron stay exceptions.
 */
ui.treeExpand.addEventListener("click", () => {
  expandAll(state.treeView);
  renderLayerTree();
});

ui.treeCollapse.addEventListener("click", () => {
  collapseAll(state.treeView);
  renderLayerTree();
});

/** id -> <li>, rebuilt with the tree, so focus and scrolling need no selector. */
let treeRows = new Map();

function renderLayerTree() {
  const hadFocus = ui.layerTree.contains(document.activeElement);
  // A row selected from the canvas has to be reachable — a selection hidden
  // inside a closed ancestor looks like a panel that lost it. Opened on a
  // *change* of selection, and on an explicit `expand` from the canvas, but not
  // on every render: doing that re-opened an ancestor the user had just
  // collapsed, because the chevron's own click renders the tree it folded, and
  // the chevron became a control that did nothing.
  const pending = state.expandRow;
  if (state.selection && (pending || state.selection !== state.lastSelection)) {
    openPath(state.tree, state.selection, state.treeView);
  }
  state.lastSelection = state.selection;
  state.expandRow = false;

  ui.layerTree.textContent = "";
  treeRows = new Map();

  if (state.tree.length === 0) {
    const empty = document.createElement("li");
    empty.className = "tree-empty";
    empty.textContent = state.model ? "No pages." : "Loading…";
    ui.layerTree.appendChild(empty);
    return;
  }

  const visible = visibleNodes(state.tree, state.treeView);
  // Roving tabindex: exactly one row carries the tab stop, and it is the row the
  // arrow keys are standing on.
  if (!state.treeFocus || !visible.some((node) => node.id === state.treeFocus)) {
    state.treeFocus = state.selection && visible.some((node) => node.id === state.selection)
      ? state.selection
      : visible[0]?.id ?? null;
  }

  // Rendered by recursing from the roots, not by walking the flat visible list:
  // the list contains a node *and* its descendants, so drawing from it would
  // draw every subtree once for the node and once for each of its ancestors.
  appendTreeItems(ui.layerTree, state.tree);

  const selected = state.selection ? treeRows.get(state.selection) : null;
  if (selected && (pending || state.revealedFor !== state.selection)) {
    state.revealedFor = state.selection;
    selected.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  // Focus is only taken back if the tree had it: after an edit the canvas
  // re-renders, and stealing focus out of an inspector field mid-typing would
  // close the field the user is working in.
  if (hadFocus && state.treeFocus) treeRows.get(state.treeFocus)?.focus({ preventScroll: true });
}

/**
 * Append a list of nodes, and the children of the ones that are open.
 *
 * The rows are a real nesting — a `<ul>` inside the `<li>` it belongs to — not
 * the flat list with `padding-left: depth * 13px` this panel used to draw. A flat
 * list looks the same and cannot be collapsed, and collapse is the reason the
 * panel exists.
 */
function appendTreeItems(list, nodes) {
  for (const node of nodes) {
    const open = isOpen(node, state.treeView);
    const item = document.createElement("li");
    item.className = "tree-item";
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(node.depth + 1));
    item.setAttribute("aria-selected", String(state.selection === node.id));
    if (hasChildren(node)) item.setAttribute("aria-expanded", String(open));
    if (node.hidden) item.dataset.hidden = "true";
    item.dataset.nodeId = node.id;
    item.tabIndex = state.treeFocus === node.id ? 0 : -1;
    item.appendChild(treeRow(node));

    if (open) {
      const children = document.createElement("ul");
      children.className = "tree-children";
      // A `treeitem`'s children are a group, not a list: the role is what makes
      // the nesting legible to anything that reads the tree rather than sees it.
      children.setAttribute("role", "group");
      appendTreeItems(children, node.children);
      item.appendChild(children);
    }

    treeRows.set(node.id, item);
    list.appendChild(item);
  }
}

function treeRow(node) {
  const row = document.createElement("div");
  row.className = "tree-row";

  // The chevron is decorative: the state it shows is `aria-expanded` on the
  // item, which is what the keyboard and the screen reader read.
  const chevron = document.createElement("span");
  if (hasChildren(node)) chevron.className = "chevron";
  else chevron.className = "chevron leaf";
  chevron.setAttribute("aria-hidden", "true");
  row.appendChild(chevron);

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name || node.id || `(${node.tag})`;
  row.appendChild(label);

  const type = document.createElement("span");
  type.className = "tree-type";
  type.textContent = node.type ?? node.tag;
  row.appendChild(type);

  if (node.kind === "page") {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = pageBadge(node);
    row.appendChild(badge);
  }
  return row;
}

function pageBadge(node) {
  if (node.isLibrary) return "library";
  const box = state.boxes.get(node.id);
  return box ? `${box.width}×${Math.round(box.height)}` : "";
}

/**
 * The nodes from a page down to `id`, or an empty list if it is not in the tree.
 *
 * One walk, because everything the pointer needs is a *chain*: which rung to
 * stand on, which child is under the pointer, and what a click would select are
 * three readings of the same chain.
 */
function pathNodesOf(id, pageId = null) {
  // Scoped to a page when the caller knows one, because a chain found in the
  // wrong page is a chain of the wrong elements.
  const root = pageId ? state.tree.filter((node) => node.id === pageId) : state.tree;
  const trail = [];
  const descend = (nodes) => {
    for (const node of nodes) {
      trail.push(node);
      if (node.id === id) return true;
      if (descend(node.children)) return true;
      trail.pop();
    }
    return false;
  };
  return descend(root) ? [...trail] : [];
}

function treeNodeFor(id) {
  const path = pathNodesOf(id);
  return path.length > 0 ? path[path.length - 1] : null;
}

/**
 * The element for `id`, inside the page it belongs to.
 *
 * Ids repeat across pages — a component instance expands into copies that keep
 * the component's inner ids — so a lookup that does not say *which page* can
 * answer with the same element in a different artboard, and the box is then
 * drawn around something off screen. Scoping the search to the page the pointer
 * is in is what keeps the boxes on the thing they name.
 */
function elementInPage(pageId, id) {
  const pageBox = ui.canvas.querySelector(`.page-box[data-page-id="${CSS.escape(pageId)}"]`);
  if (!pageBox) return null;
  if (id === pageId) return pageBox;
  for (const host of pageBox.querySelectorAll("*")) {
    const root = host.shadowRoot;
    if (!root) continue;
    const found = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (found) return found;
  }
  return null;
}

/**
 * What the pointer is offering: the level it is standing on, and the children
 * of that level — one of which a click will select.
 */
function hoverPicture() {
  if (!state.hovering) return null;
  const path = pathNodesOf(state.hovering, state.hoveringPage);
  if (path.length === 0) return null;
  const rung = rungAt(path.map((node) => node.id), state.levelDepth);
  const level = path[rung.depth];
  return {
    pageId: path[0].id,
    levelId: rung.levelId,
    level,
    children: level.children ?? [],
    underId: rung.underId,
    insideChild: rung.insideChild,
  };
}

/** The element a press would select: the child under the pointer, or the level. */
function pressTarget(hoveredId, pageId = null) {
  const path = pathNodesOf(hoveredId, pageId);
  if (path.length === 0) return null;
  const rung = rungAt(path.map((node) => node.id), state.levelDepth);
  return { pageId: path[0].id, node: path[rung.depth + (rung.insideChild ? 1 : 0)] };
}

function setHovering(id, pageId = null) {
  if (state.hovering === id && state.hoveringPage === pageId) return;
  state.hovering = id;
  state.hoveringPage = pageId;
  drawOverlay();
}

/** The page a tree row belongs to: the outermost row it sits in. */
function pageIdOfTreeRow(item) {
  let root = item;
  for (let el = item?.parentElement; el && el.id !== "layer-tree"; el = el.parentElement) {
    if (el.classList.contains("tree-item")) root = el;
  }
  return root?.dataset.nodeId ?? null;
}

/**
 * Nothing in the canvas is text to select while the canvas is being dragged.
 *
 * Cancelling the press suppresses the mouse events a selection would start from,
 * and `.panning` turns off selection for the chrome — but `user-select` does not
 * cross a shadow boundary, and the design's own text lives on the other side of
 * one. So the gesture gets a third guard, on the event the selection itself
 * fires. Scoped to a drag in progress: outside one, selecting a string in a page
 * still works the way it did.
 */
ui.viewport.addEventListener("selectstart", (event) => {
  if (drag || ui.viewport.classList.contains("panning")) event.preventDefault();
});

/**
 * Rows are one delegated listener, not one per row.
 *
 * An imported design can be thousands of rows; two listeners each is a cost paid
 * on every render, and the row identity is already in `data-node-id`.
 */
/**
 * The item a pointer event is really over.
 *
 * A child list is a `<ul>` inside the parent `<li>`, so the 13px indent band
 * beside a nested row belongs to the *parent's* item. Resolving `.tree-item`
 * alone therefore selected the parent when someone clicked just left of a child
 * — the canvas jumping to a different element than the one under the pointer —
 * and hover outlined the parent too. A row is what a row is; the band between
 * rows is nobody's, and does nothing.
 */
function rowItemOf(target) {
  return target?.closest?.(".tree-row")?.closest(".tree-item") ?? null;
}

ui.layerTree.addEventListener("mouseover", (event) => {
  const item = rowItemOf(event.target);
  setHovering(item?.dataset.nodeId ?? null, item ? pageIdOfTreeRow(item) : null);
});
ui.layerTree.addEventListener("mouseleave", () => setHovering(null));

ui.layerTree.addEventListener("click", (event) => {
  const item = rowItemOf(event.target);
  const id = item?.dataset.nodeId;
  if (!id) return;
  const node = treeNodeFor(id);
  if (!node) return;
  state.treeFocus = id;

  if (event.target.closest?.(".chevron") && hasChildren(node)) {
    // The chevron opens; it does not select. Selecting on the way to a chevron
    // is how a tree jumps the canvas to a different element than the one asked for.
    toggleNode(node, state.treeView);
    renderLayerTree();
    return;
  }
  item.focus({ preventScroll: true });
  select(id, { reveal: true, pageId: pageIdOfTreeRow(item) });
});

/**
 * The keys the tree owns, and only those.
 *
 * The canvas already listens on `window` for the arrow keys — they nudge the
 * selected element one pixel, and that is a write to the file — so a key the
 * tree handles has to stop here. Declaring the set is what makes that true in
 * both directions: `⌘Z`, `Delete` and `Escape` still mean what they mean
 * everywhere else, and an arrow key pressed on a leaf, where the tree can do
 * nothing with it, is still an arrow key the tree consumed. Letting that one
 * fall through moved an element in the design by one pixel — a write nobody
 * asked for, from a keypress that looked inert.
 */
const TREE_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "]);

ui.layerTree.addEventListener("keydown", (event) => {
  if (!TREE_KEYS.has(event.key)) return;
  event.preventDefault();
  event.stopPropagation();

  const visible = visibleNodes(state.tree, state.treeView);
  if (visible.length === 0) return;
  const at = Math.max(0, visible.findIndex((node) => node.id === state.treeFocus));
  const node = visible[at];
  const standOn = (next) => {
    state.treeFocus = next;
    renderLayerTree();
    treeRows.get(next)?.focus({ preventScroll: true });
  };

  switch (event.key) {
    case "ArrowDown": standOn(visible[Math.min(visible.length - 1, at + 1)].id); break;
    case "ArrowUp": standOn(visible[Math.max(0, at - 1)].id); break;
    case "ArrowRight":
      if (hasChildren(node) && !isOpen(node, state.treeView)) { toggleNode(node, state.treeView); renderLayerTree(); }
      else if (hasChildren(node)) standOn(visible[at + 1].id);
      break;
    case "ArrowLeft": {
      const path = pathTo(state.tree, node.id);
      if (hasChildren(node) && isOpen(node, state.treeView)) { toggleNode(node, state.treeView); renderLayerTree(); }
      else if (path.length > 1) standOn(path[path.length - 2]);
      break;
    }
    case "Home": standOn(visible[0].id); break;
    case "End": standOn(visible[visible.length - 1].id); break;
    case "Enter":
    case " ":
      select(node.id, { reveal: true, pageId: pageIdOfTreeRow(treeRows.get(node.id) ?? ui.layerTree) });
      break;
  }
});

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
      row.addEventListener("click", () => select(diagnostic.target, { reveal: true, expand: true }));
    }
    ui.problemList.appendChild(row);
  }
}

// -- inspector ---------------------------------------------------------------

/**
 * The inspector: the selected element's own properties, in sections.
 *
 * Every row here edits one declaration of the selected element, and every edit
 * goes through `commit` — the same funnel the CLI writes through. There is no
 * second write path, so a value typed here is refused exactly when the CLI would
 * refuse it, and the refusal names the same reason.
 *
 * Only the properties the element actually carries are drawn. A property that is
 * not in the file is not a row: an empty field would be a promise that writing
 * it adds the declaration and an empty value is the same as no value, which is
 * not true of this format. (Adding a property is a separate feature.)
 */
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

  ui.selectionName.textContent = `${getAttr(node, "data-name") || id}`;
  ui.inspector.appendChild(identityBlock(id, node));

  const styleMap = styleMapOf(node);
  for (const section of groupedFields(styleMap.keys())) {
    ui.inspector.appendChild(sectionBlock(id, section, styleMap));
  }

  if (node.kind === "element" && ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span"].includes(node.tag)) {
    ui.inspector.appendChild(contentBlock(id, node));
  }
}

function sectionHead(id, label, folded) {
  const head = document.createElement("button");
  head.type = "button";
  head.className = "section-head";
  head.dataset.section = id;
  head.setAttribute("aria-expanded", String(!folded));
  head.textContent = label;
  return head;
}

function focusSectionHead(id) {
  ui.inspector.querySelector(`.section-head[data-section="${id}"]`)?.focus();
}

function identityBlock(id, node) {
  const identity = document.createElement("dl");
  identity.className = "attrs";
  for (const [label, value] of [
    ["data-id", id],
    ["data-type", getAttr(node, "data-type") ?? node.tag],
    ["tag", node.tag],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value ?? "—";
    identity.appendChild(dt);
    identity.appendChild(dd);
  }
  return identity;
}

/**
 * One section: a heading that folds it, and a body of rows.
 *
 * Folding is remembered in `state.folded`, not in the DOM: the inspector is
 * rebuilt on every selection, and a `<details>` that closed itself again on the
 * next click would be a control that forgets what it was told.
 */
function sectionBlock(id, section, styleMap) {
  const wrap = document.createElement("div");
  wrap.className = "section";
  const folded = state.folded.has(section.id);
  if (folded) wrap.classList.add("folded");

  const head = sectionHead(section.id, section.label, folded);
  head.addEventListener("click", () => {
    if (state.folded.has(section.id)) state.folded.delete(section.id);
    else state.folded.add(section.id);
    renderInspector();
    // The rebuild replaced the button that was just pressed, so a keyboard user
    // would lose their place on every fold. The tree restores focus the same way.
    focusSectionHead(section.id);
  });
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "section-body";
  for (const row of section.rows) {
    const line = document.createElement("div");
    line.className = "field-grid";
    for (const property of row) line.appendChild(buildField(id, property, styleMap.get(property)));
    body.appendChild(line);
  }
  wrap.appendChild(body);
  return wrap;
}

/**
 * The text of a text element, which is not a declaration and so is its own row.
 *
 * Foldable like any other section, under the id `content` — not `text`, which is
 * the Text section's id and would fold two different things with one click.
 */
function contentBlock(id, node) {
  const wrap = document.createElement("div");
  wrap.className = "section";
  const folded = state.folded.has("content");
  if (folded) wrap.classList.add("folded");

  const head = sectionHead("content", "Content", folded);
  head.addEventListener("click", () => {
    if (state.folded.has("content")) state.folded.delete("content");
    else state.folded.add("content");
    renderInspector();
    focusSectionHead("content");
  });
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "section-body";
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = "text";
  label.htmlFor = "field-content";
  field.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.id = "field-content";
  input.value = (node.children ?? []).filter((child) => child.kind === "text").map((child) => child.value).join("");
  input.disabled = state.readOnly;
  input.addEventListener("change", () => {
    commit([{ op: "set", target: id, prop: "text", value: input.value }]);
  });
  field.appendChild(input);
  body.appendChild(field);
  wrap.appendChild(body);
  return wrap;
}

/**
 * One property, with the editor its grammar asks for.
 *
 * `controlFor` reads the property's declared kind out of `lib/table.mjs`; this
 * function is the only place that turns a kind into an element. The rule for
 * every branch is the same: never lose a value. A `select` that does not list the
 * current value gets the current value added to it, so an unusual spelling stays
 * visible and stays selectable instead of silently snapping to the first option.
 */
function buildField(id, property, value) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = property;
  label.title = hintFor(property);
  field.appendChild(label);

  const bare = String(value);
  const control = controlFor(property);

  if (control === "segmented" || control === "select") {
    const values = valuesFor(property);
    const options = values.includes(bare) ? values : [...values, bare];
    if (control === "segmented") {
      field.appendChild(segmentedControl(id, property, bare, options));
    } else {
      // A segmented control is a group and names itself; a `select` is a control
      // and needs the label to point at it.
      const select = selectControl(id, property, bare, options);
      label.htmlFor = select.id;
      field.appendChild(select);
    }
    return field;
  }

  if (control === "color" && /^#[0-9a-fA-F]{6,8}$/.test(bare)) {
    const input = document.createElement("input");
    input.type = "color";
    input.id = `field-${property}`;
    input.value = bare.slice(0, 7);
    input.disabled = state.readOnly;
    input.addEventListener("change", () => {
      commit([{ op: "set", target: id, prop: `style:${property}`, value: input.value }]);
    });
    label.htmlFor = input.id;
    field.appendChild(input);
    field.appendChild(valueLine(bare));
    return field;
  }

  const input = textControl(id, property, bare, {
    // A number input sanitizes what it cannot parse to the empty string, which
    // would hide a value the file really carries (`opacity: var(--fade)`).
    type: control === "number" && isNumericValue(bare) ? "number" : "text",
    scrub: scrubFor(property, bare),
    ...rangeFor(property),
  });
  label.htmlFor = input.id;
  field.appendChild(input);

  // A token is worth showing twice: once as what the file says, once as what the
  // browser resolved it to. `var(--color-ink)` is the intent; `#111827` is the
  // colour, and a designer checking contrast needs both.
  const resolved = resolveTokens(bare, state.model.tokens);
  if (resolved !== bare) field.appendChild(valueLine(`→ ${resolved}`));
  return field;
}

function valueLine(text) {
  const line = document.createElement("div");
  line.className = "value-line";
  line.textContent = text;
  return line;
}

function textControl(id, property, value, { type = "text", scrub = false, min, max } = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.id = `field-${property}`;
  input.value = value;
  input.disabled = state.readOnly;
  const hint = hintFor(property);
  if (hint) {
    input.placeholder = hint;
    input.title = hint;
  }
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);

  const send = (next) => commit([{ op: "set", target: id, prop: `style:${property}`, value: next }]);
  input.addEventListener("change", () => send(input.value));
  if (scrub) {
    input.className = "scrub";
    input.title = "Drag left or right to change, or type a value";
    attachScrub(input, send);
  }
  return input;
}

function segmentedControl(id, property, value, options) {
  const group = document.createElement("div");
  group.className = "seg";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", property);
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seg-option";
    if (option === value) button.classList.add("active");
    button.textContent = option;
    button.disabled = state.readOnly;
    button.addEventListener("click", () => {
      commit([{ op: "set", target: id, prop: `style:${property}`, value: option }]);
    });
    group.appendChild(button);
  }
  return group;
}

function selectControl(id, property, value, options) {
  const select = document.createElement("select");
  select.id = `field-${property}`;
  select.disabled = state.readOnly;
  for (const option of options) {
    const entry = document.createElement("option");
    entry.value = option;
    entry.textContent = option;
    if (option === value) entry.selected = true;
    select.appendChild(entry);
  }
  select.addEventListener("change", () => {
    commit([{ op: "set", target: id, prop: `style:${property}`, value: select.value }]);
  });
  return select;
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
  let original = "";
  let moved = false;
  let active = false;

  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    active = true;
    moved = false;
    startX = event.clientX;
    original = input.value;
    const match = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(input.value.trim());
    startValue = match ? Number(match[1]) : 0;
    unit = match ? match[2] : "";
    capturePointer(input, event.pointerId);
    event.preventDefault();
  });

  input.addEventListener("pointermove", (event) => {
    if (!active) return;
    if (event.clientX !== startX) moved = true;
    const delta = Math.round((event.clientX - startX) / 2);
    input.value = `${startValue + delta}${unit}`;
  });

  input.addEventListener("pointerup", (event) => {
    if (!active) return;
    active = false;
    try { input.releasePointerCapture(event.pointerId); } catch { /* released */ }
    if (!moved) {
      // A press that never moved is a press, not a drag. The value goes back
      // exactly as the file spells it — `0.50` is not rewritten to `0.5`, and
      // `var(--space-md)` cannot be re-read as `0` — so touching a field can
      // never be the thing that changed it.
      input.value = original;
      return;
    }
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

/**
 * Select an element.
 *
 * `reveal` pans the canvas to it; `expand` opens the layer tree down to it. They
 * are two different questions and the answer differs by who asked: a row click
 * in the tree needs the canvas moved but the tree is already there, while a pick
 * on the canvas — or a row in the Problems drawer — has to open the tree, even
 * when the element was already the selection. Without that second half, picking
 * the same element twice, or picking it after "collapse all", leaves the panel
 * showing nothing selected, which reads as a panel that missed the click.
 */
function select(id, options = {}) {
  state.selection = id;
  state.selectionPage = id ? options.pageId ?? null : null;
  // Selecting something is also standing on it: the canvas then shows it solid
  // and its own children dashed, ready for the next click down. Nothing selected
  // is back to the first rung — the page's own children.
  state.levelDepth = id ? pathNodesOf(id).length - 1 : 1;
  if (options.reveal) reveal(id);
  if (options.expand) state.expandRow = true;
  renderChrome();
  // The outline is drawn from `state.selection`, so a selection that does not
  // redraw it leaves the canvas boxing whatever was selected before. A click on
  // the canvas forces the redraw by moving the pointer over a different element
  // first; a row in the Problems drawer never touches the canvas at all, so it
  // was the case that showed it — the drawer named one element and the canvas
  // went on highlighting another, for as long as the pointer stayed off the page.
  drawOverlay();
}

/** Bring an element into view. Camera only: `select` redraws the overlay once. */
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
  // The panel toggles sit on the canvas but they are not the canvas. Without
  // this the click falls through to "nothing was hit", which clears the
  // selection — folding a panel away would also throw away what was selected.
  if (target?.closest?.(".viewport-toggle")) return;
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
    // The background is the one place with nothing under it, so a press here is
    // a candidate for "clear the selection" — but only if the pointer never
    // moves. Panning the canvas is not a way of saying "select nothing".
    drag = {
      kind: "pan", startX: event.clientX, startY: event.clientY,
      originX: state.camera.x, originY: state.camera.y, moved: false,
    };
    ui.viewport.classList.add("panning");
    capturePointer(ui.viewport, event.pointerId);
    // Cancel the press. Without this the pointer drag is *also* the browser's
    // text selection gesture, and panning the canvas drags a blue smear across
    // every string in the design. (Cancelling `pointerdown` suppresses the
    // compatibility mouse events the selection would start from; `user-select`
    // on `.panning` is the belt to this pair of braces.)
    event.preventDefault();
    return;
  }

  const hit = targetFromEvent(event);
  if (hit) {
    // A press takes the box the pointer is offering — the level's child it is
    // inside, or the level itself — not the deepest element under the cursor.
    // That is the whole point of the rungs: clicking a card must not land on the
    // word inside it.
    const target = pressTarget(hit.id, hit.pageId)
      ?? { pageId: hit.pageId, node: treeNodeFor(hit.id) ?? { id: hit.id } };
    select(target.node.id, { expand: true, pageId: target.pageId });
    // A page is placed by `data-canvas`, and that is the only spelling for it.
    // This used to fall through to the frame path below, which writes
    // `position:absolute` plus `left`/`top`: the canvas ignores those on a page
    // because it positions one from `data-canvas`, so the file looked right
    // here while `export` shipped the page pushed off its own top-left corner.
    const moving = elementInPage(target.pageId, target.node.id) ?? hit.element;
    drag = hit.kind === "page"
      ? pageDrag(hit.element, hit.id, event)
      : { kind: "maybe-move", id: target.node.id, startX: event.clientX, startY: event.clientY, moved: false, element: moving };
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
    setHovering(hit?.id ?? null, hit?.pageId ?? null);
    return;
  }

  if (drag.kind === "pan") {
    if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) drag.moved = true;
    state.camera.x = drag.originX + (event.clientX - drag.startX);
    state.camera.y = drag.originY + (event.clientY - drag.startY);
    applyCamera();
    // The overlay is a *sibling* of the canvas, not a child of it: it is
    // positioned in viewport pixels and does not inherit the camera transform.
    // Moving the camera therefore has to redraw it, or the canvas slides out
    // from under a selection box that stays exactly where it was — a blue
    // rectangle marking nothing. Every other camera move (wheel, zoom, fit,
    // reveal) already redraws; this one was the exception.
    drawOverlay();
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

  // A press on the empty canvas that did not pan is a click on nothing, and
  // clicking nothing clears the selection — the same thing `Escape` does. The
  // three-pixel threshold is the same one an element drag uses: a click always
  // arrives with a pixel or two of jitter, and a jittery click is still a click.
  if (current.kind === "pan") {
    if (!current.moved) select(null);
    return;
  }

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
  if ((event.metaKey || event.ctrlKey) && event.code === "Backslash") {
    // The layout, from the keyboard: ⌘\ is the layers panel, ⇧⌘\ the inspector.
    // The *physical* key is what is checked, not `event.key`: with shift held the
    // same key reports `|`, and a shortcut that stops working when you press the
    // modifier it is documented with is a shortcut nobody can use.
    event.preventDefault();
    togglePanel(event.shiftKey ? "right" : "left");
    return;
  }
  if (event.key === " ") {
    // A focused button activates on space, and that keypress is the button's.
    if (document.activeElement?.tagName === "BUTTON") return;
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
    // Up one rung, and the selection goes with it: from a card to the section it
    // sits in, and from the first rung to nothing selected at all.
    const path = state.selection ? pathNodesOf(state.selection, state.selectionPage) : [];
    if (path.length - 1 > 1) select(path[path.length - 2].id, { pageId: path[0].id });
    else select(null);
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[event.key] && state.selection) {
    // The nudge is the one branch that writes, so it gets the second guard: the
    // tree and the panel edges handle the arrow keys themselves and stop their
    // own events, and this is what keeps a leaked keypress from moving a design
    // by one pixel. Only the nudge — Delete, ⌘Z, Escape and ⌘\ have to keep
    // working while a row in the tree has focus, and none of them nudges.
    if (event.target?.closest?.("#layer-tree, .divider")) return;
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

window.addEventListener("resize", () => {
  // A window narrow enough to squeeze a panel re-clamps it, so a remembered
  // 700px inspector cannot cover the design on a laptop screen — and the
  // re-clamp goes through the same geometry path as a drag, so giving a column
  // width back does not slide the drawing sideways with the viewport edge.
  reclampPanels();
});
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
wirePanels();
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
