/**
 * canvas/tree.mjs — the layer tree, as data.
 *
 * No DOM, and no imports at all. The canvas decides how a tree looks; this file
 * decides what the tree *is*: which row is inside which, which rows are visible
 * under the current expansion, and what a selection has to open to be seen.
 *
 * That split is the point. Everything here runs under `node --test` — a browser
 * is not needed to know that collapsing a node hides its grandchildren, or that
 * selecting a deeply nested element opens exactly the path down to it. The DOM
 * half of the tree (`renderLayerTree` in `app.mjs`) is then thin enough to read.
 *
 * The input rows are what `pageTree()` in `lib/render.mjs` already produces:
 * document order, one row per element, with a `depth`:
 *
 *     { id, type, tag, name, depth, hidden, childCount, text }
 */

/**
 * A view is the expansion state, in three parts:
 *
 *   `all`       — the standing intent: everything open, everything closed, or
 *                 "nobody has said" and each node decides for itself (which, on
 *                 a fresh view, means closed)
 *   `expanded`  — nodes opened against that intent
 *   `collapsed` — nodes closed against it
 *
 * A tree opens closed. An imported design can be thousands of rows, and one that
 * greets you as a wall of text is one nobody reads; a page list is a map, and a
 * map you can see the shape of is worth more than the first level of detail.
 * The two buttons at the top of the panel are the two ways out of that, and
 * selecting something on the canvas opens exactly the path down to it.
 */
export function newView() {
  return { all: "closed", expanded: new Set(), collapsed: new Set() };
}

/**
 * Depth-first rows -> nested nodes, in document order.
 *
 * A row's parent is the nearest row above it with a smaller depth, which is how
 * the flat form carries the structure. A malformed jump (0 -> 3 with no 1 or 2)
 * attaches to the nearest ancestor that exists instead of throwing: the file is
 * the authority, and a layer list is not the place to refuse to draw one.
 */
export function nest(rows) {
  const roots = [];
  const stack = [];
  for (const row of rows) {
    const depth = Math.max(0, row.depth | 0);
    const node = { ...row, depth, children: [] };
    const parent = depth === 0 ? null : nearestAncestor(stack, depth - 1);
    (parent ? parent.children : roots).push(node);
    stack.length = depth;
    stack[depth] = node;
  }
  return roots;
}

function nearestAncestor(stack, depth) {
  for (let d = Math.min(depth, stack.length - 1); d >= 0; d -= 1) {
    if (stack[d]) return stack[d];
  }
  return null;
}

/** Every node in document order, open or closed. */
export function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

/** id -> node, for the whole tree. */
export function byId(nodes) {
  const index = new Map();
  walk(nodes, (node) => index.set(node.id, node));
  return index;
}

/** The ancestors of `id`, root first, ending with `id` itself. */
export function pathTo(nodes, id) {
  let found = null;
  const walkPath = (list, trail) => {
    for (const node of list) {
      const next = [...trail, node.id];
      if (node.id === id) { found = next; return; }
      walkPath(node.children, next);
      if (found) return;
    }
  };
  walkPath(nodes, []);
  return found ?? [];
}

export function hasChildren(node) {
  return (node.children?.length ?? 0) > 0;
}

/**
 * Is this node open?
 *
 * Exceptions first, then the standing intent. A node the user closed stays
 * closed even under "expand all"; a node they opened stays open even under
 * "collapse all" — which is what makes both buttons useful rather than absolute
 * (collapse everything, then open the one branch you are working on), and what
 * makes the two directions of a single toggle both stick.
 */
export function isOpen(node, view) {
  if (!hasChildren(node)) return false;
  if (view.collapsed.has(node.id)) return false;
  if (view.expanded.has(node.id)) return true;
  return view.all === "open";
}

/** Open every node, discarding the per-node exceptions. */
export function expandAll(view) {
  view.all = "open";
  view.expanded.clear();
  view.collapsed.clear();
}

/** Close every node, discarding the per-node exceptions. */
export function collapseAll(view) {
  view.all = "closed";
  view.expanded.clear();
  view.collapsed.clear();
}

/** Open or close one node, in place, remembering the choice. */
export function toggleNode(node, view) {
  if (!hasChildren(node)) return false;
  if (isOpen(node, view)) {
    view.expanded.delete(node.id);
    view.collapsed.add(node.id);
  } else {
    view.collapsed.delete(node.id);
    view.expanded.add(node.id);
  }
  return isOpen(node, view);
}

/**
 * Open everything above `id`, so a selected row can actually be seen.
 *
 * A selection is often made from the canvas, and a row that is selected while
 * its ancestors are closed is a row the user cannot find — the panel looks like
 * it lost the selection rather than like it folded it away.
 */
export function openPath(nodes, id, view) {
  const path = pathTo(nodes, id);
  for (const ancestor of path.slice(0, -1)) {
    view.collapsed.delete(ancestor);
    view.expanded.add(ancestor);
  }
  return path;
}

/** The rows to draw, in document order: everything not inside a closed node. */
export function visibleNodes(nodes, view) {
  const out = [];
  const visit = (list) => {
    for (const node of list) {
      out.push(node);
      if (hasChildren(node) && isOpen(node, view)) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/**
 * The page roots of a document model, each with its element tree nested under it.
 *
 * The page is a rung of the tree, not a label above it, so its elements start one
 * level deeper than `pageTree()` reported them. Without the shift a page and its
 * top-level elements would both be depth 0, and every depth-keyed decision —
 * the default open limit, `aria-level`, the indent — would be off by one.
 */
export function pageRoots(pages, rowsOf) {
  return pages.map((page) => {
    const children = shiftDepth(nest(rowsOf(page)), 1);
    return {
      id: page.id,
      kind: "page",
      depth: 0,
      name: page.name,
      type: "page",
      tag: "section",
      hidden: false,
      isLibrary: Boolean(page.isLibrary),
      childCount: children.length,
      children,
    };
  });
}

/** Re-number a nested tree's depths, in place, and return it. */
function shiftDepth(nodes, by) {
  for (const node of nodes) {
    node.depth += by;
    shiftDepth(node.children, by);
  }
  return nodes;
}
