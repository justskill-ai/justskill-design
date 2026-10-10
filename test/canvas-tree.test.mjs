/**
 * test/canvas-tree.test.mjs — the layer tree's decisions, without a browser.
 *
 * `canvas/tree.mjs` exists so that these questions have answers that can be
 * checked here instead of by opening the canvas and squinting:
 *
 *   1. Rows become a tree: a row's parent is the nearest row above it with a
 *      smaller depth, and document order survives the nesting.
 *   2. Expansion is a standing intent plus two sets of exceptions. The cases
 *      that matter are the awkward ones: a tree opens fully closed, a node the
 *      user opened stays open under "collapse all", and a node they closed stays
 *      closed under "expand all".
 *   3. Closing a node hides its whole subtree, not just its children.
 *   4. Selecting a nested element opens the path down to it and nothing else,
 *      and a missing id is answered with an empty path rather than a throw.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  nest, walk, byId, pathTo, hasChildren, isOpen, toggleNode, openPath, visibleNodes,
  pageRoots, newView, expandAll, collapseAll,
} from "../canvas/tree.mjs";

/** A row, in the shape `pageTree()` produces. */
function row(id, depth, extra = {}) {
  return { id, depth, type: "frame", tag: "div", name: id, hidden: false, childCount: 0, text: "", ...extra };
}

/**
 *  page
 *    header
 *    body
 *      title
 *      list
 *        item-1
 *        item-2
 *    footer
 */
const ROWS = [
  row("header", 0),
  row("body", 0),
  row("title", 1),
  row("list", 1),
  row("item-1", 2),
  row("item-2", 2),
  row("footer", 0),
];

test("nest puts each row under the nearest row above it with a smaller depth", () => {
  const tree = nest(ROWS);
  assert.deepEqual(tree.map((node) => node.id), ["header", "body", "footer"]);
  const body = tree[1];
  assert.deepEqual(body.children.map((node) => node.id), ["title", "list"]);
  assert.deepEqual(body.children[1].children.map((node) => node.id), ["item-1", "item-2"]);
  assert.deepEqual(tree[2].children, []);
});

test("nest copies its rows, so the caller's list is not rewritten", () => {
  const rows = ROWS.map((source) => ({ ...source }));
  const before = JSON.stringify(rows);
  nest(rows);
  assert.equal(JSON.stringify(rows), before, "nest mutated the rows it was given");
});

/**
 * The flat form can carry a depth that skips a level — an importer that drops an
 * intermediate wrapper produces exactly that. The row still has to be drawn
 * somewhere: it lands under the nearest ancestor that exists, rather than
 * throwing or vanishing from the panel.
 */
test("nest attaches a skipped depth to the nearest ancestor that exists", () => {
  const tree = nest([row("page-body", 0), row("deep", 3)]);
  assert.deepEqual(tree.map((node) => node.id), ["page-body"]);
  assert.deepEqual(tree[0].children.map((node) => node.id), ["deep"]);
  assert.equal(tree[0].children[0].depth, 3, "the depth is kept as given");
});

test("walk and byId see every node in document order", () => {
  const tree = nest(ROWS);
  const seen = [];
  walk(tree, (node) => seen.push(node.id));
  assert.deepEqual(seen, ["header", "body", "title", "list", "item-1", "item-2", "footer"]);
  assert.equal(byId(tree).size, 7);
  assert.equal(byId(tree).get("item-2").depth, 2);
});

test("pathTo returns the ancestors and the node, or nothing for an unknown id", () => {
  const tree = nest(ROWS);
  assert.deepEqual(pathTo(tree, "item-1"), ["body", "list", "item-1"]);
  assert.deepEqual(pathTo(tree, "body"), ["body"]);
  assert.deepEqual(pathTo(tree, "nope"), []);
});

test("a leaf is never open, whatever the view says", () => {
  const tree = nest(ROWS);
  const view = newView();
  const leaf = byId(tree).get("title");
  view.expanded.add("title");
  assert.equal(hasChildren(leaf), false);
  assert.equal(isOpen(leaf, view), false, "a node with no children has nothing to open");
});

/**
 * The promise the panel makes on load: a map you can see the shape of. Depth is
 * deliberately not part of it — a limit would open the first three rungs of a
 * three-thousand-row import and call that "collapsed".
 */
test("a fresh view has everything closed", () => {
  const tree = nest(ROWS);
  const view = newView();
  const index = byId(tree);

  for (const id of ["header", "body", "title", "list", "item-1", "footer"]) {
    assert.equal(isOpen(index.get(id), view), false, `${id} opened itself`);
  }
  assert.deepEqual(
    visibleNodes(tree, view).map((node) => node.id),
    ["header", "body", "footer"],
    "every top-level row is drawn, and nothing under them",
  );
});

test("expandAll opens every node; collapseAll closes every node", () => {
  const chain = nest([row("a", 0), row("b", 1), row("c", 2), row("d", 3)]);
  const view = newView();
  const index = byId(chain);

  expandAll(view);
  assert.deepEqual(visibleNodes(chain, view).map((node) => node.id), ["a", "b", "c", "d"]);
  assert.equal(isOpen(index.get("c"), view), true);

  collapseAll(view);
  assert.deepEqual(visibleNodes(chain, view).map((node) => node.id), ["a"]);
  assert.equal(view.expanded.size, 0, "collapseAll is the standing intent, not a list of ids");
  assert.equal(view.collapsed.size, 0);
});

/**
 * The regression this pair of sets exists for: with a single `expanded` set, the
 * standing intent wins the argument on every render, so a node closed under
 * "expand all" springs back open and the chevron is a control that does nothing.
 */
test("an exception beats the standing intent in both directions", () => {
  const tree = nest(ROWS);
  const view = newView();
  const index = byId(tree);
  const list = index.get("list");

  // closed by default; the user opens one branch
  toggleNode(list, view);
  assert.equal(isOpen(list, view), true);
  assert.equal(view.expanded.has("list"), true);
  assert.equal(view.collapsed.has("list"), false, "an id in both sets is a contradiction");

  // "expand all" must not lose it, and the user then closes one node
  expandAll(view);
  assert.equal(isOpen(list, view), true);
  toggleNode(list, view);
  assert.equal(isOpen(list, view), false, "a close under expand-all has to stick");
  assert.equal(view.collapsed.has("list"), true);
  assert.equal(view.expanded.has("list"), false);

  // "collapse all" clears the exceptions and closes everything
  collapseAll(view);
  assert.equal(isOpen(list, view), false);
  assert.equal(isOpen(index.get("body"), view), false);
});

/**
 * A round trip has to come back to the same answer, and it must never leave an
 * id in both sets — "closed and open at once" is not a state anything can read.
 *
 * It does leave the *choice* behind, on purpose: after a round trip the node is
 * explicitly what it was by default, which is what keeps it put if the default
 * limit ever changes.
 */
test("toggling twice returns the node to the state it started in", () => {
  for (const standing of ["closed", "open"]) {
    const tree = nest(ROWS);
    const view = newView();
    view.all = standing;
    const list = byId(tree).get("list");
    const before = isOpen(list, view);

    toggleNode(list, view);
    assert.equal(isOpen(list, view), !before, `toggle had no effect under all=${standing}`);

    toggleNode(list, view);
    assert.equal(isOpen(list, view), before, `round trip changed the answer under all=${standing}`);
    assert.equal(
      view.expanded.has("list") && view.collapsed.has("list"),
      false,
      `"list" is in both sets under all=${standing}`,
    );
  }
});

test("closing a node hides its whole subtree, not just its children", () => {
  const tree = nest(ROWS);
  const view = newView();
  expandAll(view);
  const list = byId(tree).get("list");

  assert.deepEqual(visibleNodes(tree, view).map((node) => node.id), ROWS.map((r) => r.id));

  toggleNode(list, view);
  assert.deepEqual(
    visibleNodes(tree, view).map((node) => node.id),
    ["header", "body", "title", "list", "footer"],
    "item-1 and item-2 are two levels down and must go with their parent",
  );
});

test("openPath opens every ancestor of a selection, and only the ancestors", () => {
  const tree = nest(ROWS);
  const view = newView(); // nothing is open

  const path = openPath(tree, "item-2", view);
  assert.deepEqual(path, ["body", "list", "item-2"]);
  assert.equal(isOpen(byId(tree).get("body"), view), true);
  assert.equal(isOpen(byId(tree).get("list"), view), true);
  assert.equal(isOpen(byId(tree).get("footer"), view), false, "a sibling stays as it was");
  assert.deepEqual(visibleNodes(tree, view).map((node) => node.id), ROWS.map((r) => r.id));
});

test("openPath also overrides a node the user had closed", () => {
  const tree = nest(ROWS);
  const view = newView();
  const list = byId(tree).get("list");
  expandAll(view);
  toggleNode(list, view); // the user closed it
  assert.equal(isOpen(list, view), false);
  openPath(tree, "item-1", view); // then picked something inside it on the canvas
  assert.equal(isOpen(list, view), true);
  assert.equal(visibleNodes(tree, view).some((node) => node.id === "item-1"), true);
});

test("pageRoots makes each page a root and nests its elements under it", () => {
  const pages = [{ id: "home", name: "Home" }, { id: "library", name: "Library", isLibrary: true }];
  const rowsOf = (page) => (page.id === "home" ? ROWS : []);
  const roots = pageRoots(pages, rowsOf);

  assert.deepEqual(roots.map((node) => node.id), ["home", "library"]);
  assert.equal(roots[0].depth, 0);
  assert.equal(roots[0].childCount, 3);
  assert.deepEqual(roots[0].children.map((node) => node.id), ["header", "body", "footer"]);
  assert.equal(
    roots[0].children[1].children[0].depth,
    2,
    "the page is rung 0, so its elements start one level deeper than pageTree() reported",
  );
  assert.deepEqual(roots[1].children, []);
  assert.equal(hasChildren(roots[1]), false, "an empty page has no chevron");
});

test("a page with elements is closed like everything else", () => {
  const roots = pageRoots([{ id: "home", name: "Home" }], () => ROWS);
  const view = newView();
  assert.equal(isOpen(roots[0], view), false, "a fresh panel is a list of page names");
  assert.equal(visibleNodes(roots, view).length, 1, "and nothing under them");

  expandAll(view);
  assert.equal(visibleNodes(roots, view).length, 8, "the page, its rows, and their children");
});
