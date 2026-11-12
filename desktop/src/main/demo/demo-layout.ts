// The demo Herdr's tab layouts: each tab is a split tree
// as Herdr keeps one, answered as `pane.layout` does (the shape of the
// fixtures captured from live Herdr: a 134 x 45 area, rects in cells, splits
// with Herdr's ids "split_<n>_root|0|1", panes in the tree's order). A tab with
// no tree yet gets the arrangement Herdr's own splits make: two panes side by
// side, three with the right half split down, four as two columns each split
// down.

type Json = Record<string, unknown>;

export type DemoDirection = "right" | "down";

export type DemoNode =
  | { readonly type: "pane"; readonly paneId: string }
  | { readonly type: "split"; readonly direction: DemoDirection; readonly ratio: number; readonly first: DemoNode; readonly second: DemoNode };

export interface DemoTabLayout {
  root: DemoNode;
  zoomed: boolean;
  focused: string;
}

/** The fixtures' area (a 134 x 45 Herdr window). */
export const demoArea = { x: 0, y: 0, width: 134, height: 45 } as const;

const flip = (direction: DemoDirection): DemoDirection => (direction === "right" ? "down" : "right");

/** Herdr's arrangement for panes split in turn: halves, right then down. */
export function defaultTree(paneIds: readonly string[], direction: DemoDirection = "right"): DemoNode {
  if (paneIds.length === 1) return { type: "pane", paneId: paneIds[0]! };
  const half = Math.floor(paneIds.length / 2);
  return {
    type: "split",
    direction,
    ratio: 0.5,
    first: defaultTree(paneIds.slice(0, half), flip(direction)),
    second: defaultTree(paneIds.slice(half), flip(direction)),
  };
}

/** The tree's panes, first side first. */
export function treePanes(node: DemoNode): string[] {
  return node.type === "pane" ? [node.paneId] : [...treePanes(node.first), ...treePanes(node.second)];
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** `pane.layout`'s `layout` for the tab, in Herdr's wire shape. */
export function layoutJson(tabId: string, workspaceId: string, tab: DemoTabLayout, area: Rect = demoArea): Json {
  const panes: Json[] = [];
  const splits: Json[] = [];
  let serial = 0;
  const walk = (node: DemoNode, rect: Rect, side: string): void => {
    if (node.type === "pane") {
      panes.push({ focused: node.paneId === tab.focused, pane_id: node.paneId, rect });
      return;
    }
    splits.push({ direction: node.direction, id: `split_${serial}_${side}`, ratio: node.ratio, rect });
    serial += 1;
    if (node.direction === "right") {
      const width = Math.round(rect.width * node.ratio);
      walk(node.first, { ...rect, width }, "0");
      walk(node.second, { ...rect, x: rect.x + width, width: rect.width - width }, "1");
    } else {
      const height = Math.round(rect.height * node.ratio);
      walk(node.first, { ...rect, height }, "0");
      walk(node.second, { ...rect, y: rect.y + height, height: rect.height - height }, "1");
    }
  };
  walk(tab.root, area, "root");
  return { area, focused_pane_id: tab.focused, panes, splits, tab_id: tabId, workspace_id: workspaceId, zoomed: tab.zoomed };
}

/** The tree with `paneId` split in two: it keeps the first side, `newPaneId` takes the second. */
export function splitLeaf(node: DemoNode, paneId: string, direction: DemoDirection, newPaneId: string): DemoNode {
  if (node.type === "pane") {
    return node.paneId === paneId ? { type: "split", direction, ratio: 0.5, first: node, second: { type: "pane", paneId: newPaneId } } : node;
  }
  return { ...node, first: splitLeaf(node.first, paneId, direction, newPaneId), second: splitLeaf(node.second, paneId, direction, newPaneId) };
}

/** The tree without `paneId`: its sibling takes its split's place (null when it was the last pane). */
export function removeLeaf(node: DemoNode, paneId: string): DemoNode | null {
  if (node.type === "pane") return node.paneId === paneId ? null : node;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

/** The tree with the split at `path` (false the first side, true the second) set to `ratio`; null when a pane or nothing is there. */
export function setRatioAt(node: DemoNode, path: readonly boolean[], ratio: number): DemoNode | null {
  if (node.type === "pane") return null;
  if (path.length === 0) return { ...node, ratio };
  const inner = setRatioAt(path[0] ? node.second : node.first, path.slice(1), ratio);
  if (inner === null) return null;
  return path[0] ? { ...node, second: inner } : { ...node, first: inner };
}

/** The tree as Herdr's LayoutDescription root (LayoutNode: panes and splits). */
export function describeTree(node: DemoNode): Json {
  return node.type === "pane"
    ? { type: "pane", pane_id: node.paneId }
    : { type: "split", direction: node.direction, ratio: node.ratio, first: describeTree(node.first), second: describeTree(node.second) };
}
