// A tab's split panes: Herdr's layout for the tab
// (`pane.layout`, what `herdr pane layout --pane <id>` prints: the area, each
// pane's rect in cells and whether it is focused, each split's direction, id,
// ratio and rect, the tab, the workspace, and whether a pane is zoomed) made
// into the tile tree the main area draws: nested splits with their direction
// and ratio, panes as leaves, in Herdr's own arrangement, every tile's place a
// fraction of the main area (cells to fractions, so 23 of 45 rows stays 23/45).
//
// What the main area shows for the selected pane: its tab's tiles (2 to 4
// panes) with that pane focused; one pane alone for a one-pane tab, a tab
// Herdr has zoomed (the zoomed pane alone, as Herdr shows it), or a tab with
// more than 4 panes (with a quiet line saying so). Pure: no Herdr calls here.

/** A rectangle in terminal cells, as Herdr reports it. */
export interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Herdr splits a pane to the right or down only. */
export type SplitDirection = "right" | "down";

export interface LayoutPane {
  readonly paneId: string;
  readonly rect: CellRect;
  readonly focused: boolean;
}

export interface LayoutSplit {
  readonly id: string;
  /** "right" or "down" as Herdr sends it (kept as sent; the tree reads only those two). */
  readonly direction: string;
  /** The first side's share as Herdr keeps it. */
  readonly ratio: number;
  readonly rect: CellRect;
}

/** One tab's layout (`pane.layout`'s `layout`). */
export interface PaneLayout {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly area: CellRect;
  readonly focusedPaneId: string | null;
  /** In Herdr's order: the tree, first side first. */
  readonly panes: readonly LayoutPane[];
  readonly splits: readonly LayoutSplit[];
  readonly zoomed: boolean;
}

/** The tile tree: a split with two sides, or a pane. */
export type TileNode = TilePaneNode | TileSplitNode;

export interface TilePaneNode {
  readonly type: "pane";
  readonly paneId: string;
}

export interface TileSplitNode {
  readonly type: "split";
  /** Herdr's split id ("split_0_root"), or "cut:<…>" for one read off the rects alone. */
  readonly id: string;
  readonly direction: SplitDirection;
  /** Herdr's ratio for the split. */
  readonly ratio: number;
  /** The first side's share in cells (what is drawn): 23 of 45 rows is 23/45. */
  readonly fraction: number;
  /** The split's length along its direction, in cells (columns for right, rows for down). */
  readonly extent: number;
  readonly first: TileNode;
  readonly second: TileNode;
}

/** A place in the main area, each value a fraction of it (0 to 1). */
export interface Frame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One pane's tile. */
export interface Tile {
  readonly paneId: string;
  readonly frame: Frame;
  /** Its place in Herdr's order (0 for ⌘1). */
  readonly index: number;
}

/** The line between a split's two sides, which a drag moves. */
export interface Divider {
  readonly splitId: string;
  readonly direction: SplitDirection;
  /** The split's whole region. */
  readonly frame: Frame;
  /** Where the line is, as a fraction of the region along the direction. */
  readonly at: number;
  /** The split's length in cells along its direction. */
  readonly extent: number;
  /** A pane on the first side whose edge is the line (the pane a resize names). */
  readonly firstPaneId: string;
}

/** The most panes the main area shows at once (Herdr's workers tabs hold four). */
export const maxTiles = 4;

/** The quiet line for a tab with more panes than the main area shows. */
export function tooManyNote(count: number): string {
  return `This tab has ${count} panes; Adari shows up to ${maxTiles}. Zoom or close one in Herdr.`;
}

const isDirection = (value: string): value is SplitDirection => value === "right" || value === "down";

function contains(outer: CellRect, inner: CellRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function union(rects: readonly CellRect[]): CellRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const start = (rect: CellRect, direction: SplitDirection): number => (direction === "right" ? rect.x : rect.y);
const length = (rect: CellRect, direction: SplitDirection): number => (direction === "right" ? rect.width : rect.height);

/**
 * Where a region's panes part along `direction`: the cell every pane ends at or
 * starts from, with panes on both sides; of several, the one nearest the ratio.
 */
function cutAt(region: CellRect, panes: readonly LayoutPane[], direction: SplitDirection, ratio: number): number | null {
  const from = start(region, direction);
  const to = from + length(region, direction);
  const wanted = from + ratio * (to - from);
  let best: number | null = null;
  const candidates = [...new Set(panes.map((pane) => start(pane.rect, direction)))].filter((cut) => cut > from && cut < to);
  for (const cut of candidates) {
    const before = panes.filter((pane) => start(pane.rect, direction) + length(pane.rect, direction) <= cut);
    const after = panes.filter((pane) => start(pane.rect, direction) >= cut);
    if (before.length === 0 || after.length === 0 || before.length + after.length !== panes.length) continue;
    if (best === null || Math.abs(cut - wanted) < Math.abs(best - wanted)) best = cut;
  }
  return best;
}

function sides(region: CellRect, direction: SplitDirection, cut: number): [CellRect, CellRect] {
  if (direction === "right") {
    return [
      { x: region.x, y: region.y, width: cut - region.x, height: region.height },
      { x: cut, y: region.y, width: region.x + region.width - cut, height: region.height },
    ];
  }
  return [
    { x: region.x, y: region.y, width: region.width, height: cut - region.y },
    { x: region.x, y: cut, width: region.width, height: region.y + region.height - cut },
  ];
}

function build(region: CellRect, panes: readonly LayoutPane[], splits: readonly LayoutSplit[], used: Set<string>): TileNode | null {
  if (panes.length === 0) return null;
  if (panes.length === 1) return { type: "pane", paneId: panes[0]!.paneId };
  // Herdr's split for this region: the largest one inside it not used yet (its rect is the region itself).
  const split = splits
    .filter((candidate) => !used.has(candidate.id) && isDirection(candidate.direction) && contains(region, candidate.rect))
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
  const order: SplitDirection[] = split === undefined || split.direction === "right" ? ["right", "down"] : ["down", "right"];
  for (const direction of order) {
    const herdrs = split !== undefined && split.direction === direction ? split : undefined;
    const cut = cutAt(region, panes, direction, herdrs?.ratio ?? 0.5);
    if (cut === null) continue;
    if (herdrs !== undefined) used.add(herdrs.id);
    const [firstRegion, secondRegion] = sides(region, direction, cut);
    const first = build(firstRegion, panes.filter((pane) => start(pane.rect, direction) < cut), splits, used);
    const second = build(secondRegion, panes.filter((pane) => start(pane.rect, direction) >= cut), splits, used);
    if (first === null || second === null) return null;
    const extent = length(region, direction);
    const fraction = (cut - start(region, direction)) / extent;
    return {
      type: "split",
      id: herdrs?.id ?? `cut:${direction}:${region.x},${region.y},${region.width},${region.height}`,
      direction,
      ratio: herdrs?.ratio ?? fraction,
      fraction,
      extent,
      first,
      second,
    };
  }
  return null;
}

/**
 * The tile tree for a layout: Herdr's splits where they name the region, the
 * pane rects deciding where each side ends (so the tree holds whatever the
 * answer leaves out). Null for no panes, or rects no split arrangement makes.
 */
export function tileTree(layout: PaneLayout): TileNode | null {
  if (layout.panes.length === 0) return null;
  return build(union(layout.panes.map((pane) => pane.rect)), layout.panes, layout.splits, new Set());
}

function edgeTile(tiles: readonly Tile[], direction: SplitDirection, edge: number): Tile | undefined {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  return tiles.find((tile) => (direction === "right" ? near(tile.frame.left + tile.frame.width, edge) : near(tile.frame.top + tile.frame.height, edge)));
}

/**
 * Every tile's frame and every split's divider, the tree's own order (Herdr's).
 * `overrides` gives a split a new fraction (a divider being dragged).
 */
export function tileFrames(root: TileNode, overrides: ReadonlyMap<string, number> = new Map()): { tiles: Tile[]; dividers: Divider[] } {
  const tiles: Tile[] = [];
  const dividers: Divider[] = [];
  const walk = (node: TileNode, frame: Frame): void => {
    if (node.type === "pane") {
      tiles.push({ paneId: node.paneId, frame, index: tiles.length });
      return;
    }
    const at = overrides.get(node.id) ?? node.fraction;
    const right = node.direction === "right";
    const first: Frame = right ? { ...frame, width: frame.width * at } : { ...frame, height: frame.height * at };
    const second: Frame = right
      ? { ...frame, left: frame.left + frame.width * at, width: frame.width * (1 - at) }
      : { ...frame, top: frame.top + frame.height * at, height: frame.height * (1 - at) };
    const divider = dividers.length;
    dividers.push({ splitId: node.id, direction: node.direction, frame, at, extent: node.extent, firstPaneId: "" });
    const before = tiles.length;
    walk(node.first, first);
    const edge = right ? first.left + first.width : first.top + first.height;
    const touching = edgeTile(tiles.slice(before), node.direction, edge) ?? tiles[tiles.length - 1]!;
    dividers[divider] = { ...dividers[divider]!, firstPaneId: touching.paneId };
    walk(node.second, second);
  };
  walk(root, { left: 0, top: 0, width: 1, height: 1 });
  return { tiles, dividers };
}

/** Why the main area shows one pane. */
export type SingleReason = "noLayout" | "notInLayout" | "onePane" | "zoomed" | "tooMany";

export type TileDecision =
  | {
      readonly kind: "single";
      /** The pane shown: the selected one, or the tab's zoomed pane when Herdr has one (it can differ from the selection). */
      readonly paneId: string;
      readonly reason: SingleReason;
      /** Herdr has this tab zoomed (on this pane). */
      readonly zoomed: boolean;
      /** The tab's panes as the layout lists them (0 without a layout). */
      readonly paneCount: number;
      /** The quiet line (more than 4 panes), else null. */
      readonly note: string | null;
    }
  | {
      readonly kind: "tiles";
      readonly focusedPaneId: string;
      readonly root: TileNode;
      readonly tiles: readonly Tile[];
      readonly dividers: readonly Divider[];
      readonly paneCount: number;
    };

/**
 * What the main area shows for `paneId` given its tab's layout (null: not
 * read yet, or refused). A zoomed tab shows what Herdr shows: its zoomed pane
 * (the layout's focused_pane_id), whichever of its panes was selected (the
 * App moves the selection to it); a zoomed layout naming no pane it lists
 * shows the selected pane, still zoomed so Unzoom is offered.
 */
export function decideTiles(layout: PaneLayout | null, paneId: string, overrides?: ReadonlyMap<string, number>): TileDecision {
  const single = (reason: SingleReason, zoomed = false, note: string | null = null, shown = paneId): TileDecision => ({
    kind: "single",
    paneId: shown,
    reason,
    zoomed,
    paneCount: layout?.panes.length ?? 0,
    note,
  });
  if (layout === null) return single("noLayout");
  if (!layout.panes.some((pane) => pane.paneId === paneId)) return single("notInLayout");
  if (layout.zoomed) {
    const focused = layout.focusedPaneId;
    const zoomedPane = focused !== null && layout.panes.some((pane) => pane.paneId === focused) ? focused : paneId;
    return single("zoomed", true, null, zoomedPane);
  }
  if (layout.panes.length === 1) return single("onePane");
  if (layout.panes.length > maxTiles) return single("tooMany", false, tooManyNote(layout.panes.length));
  const root = tileTree(layout);
  if (root === null) return single("noLayout");
  const { tiles, dividers } = tileFrames(root, overrides);
  return { kind: "tiles", focusedPaneId: paneId, root, tiles, dividers, paneCount: layout.panes.length };
}

/** Why a split is refused (the tab already shows the most tiles), or null. */
export function splitRefusal(tabPanes: number): string | null {
  return tabPanes >= maxTiles ? `This tab already shows ${maxTiles} panes; Adari shows up to ${maxTiles}.` : null;
}

/** A tree as nested arrays, ratios aside: a pane by its id, a split as [id, direction, first, second]. */
function plainShape(node: TileNode): unknown {
  return node.type === "pane" ? node.paneId : [node.id, node.direction, plainShape(node.first), plainShape(node.second)];
}

/**
 * A tree's shape, ratios aside: every split by its id and
 * direction with both sides in order, every pane by its id, as one string
 * (JSON, so ids never run together). Two trees of the same shape put the same
 * panes on the same sides of the same splits.
 */
export function treeShape(node: TileNode): string {
  return JSON.stringify(plainShape(node));
}

/** The shape of the split `splitId` in the tree (its direction and both sides, nested splits included); null when it has none. */
export function splitShape(root: TileNode, splitId: string): string | null {
  const find = (node: TileNode): TileNode | null =>
    node.type === "pane" ? null : node.id === splitId ? node : (find(node.first) ?? find(node.second));
  const found = find(root);
  return found === null ? null : treeShape(found);
}

/**
 * How a tab arranges its panes, ratios aside: its tab, its
 * zoom and its tree's shape (the panes in Herdr's order when no tree can be
 * read). Two layouts with the same arrangement place every pane on the same
 * side of the same split, so a drag or an action on one still means the same.
 */
export function arrangementOf(layout: PaneLayout): string {
  const tree = tileTree(layout);
  return JSON.stringify([layout.tabId, layout.zoomed, tree === null ? layout.panes.map((pane) => pane.paneId) : plainShape(tree)]);
}

/** Whether two layouts of a tab arrange the same panes the same way (arrangementOf): what a drag on one was about still stands. */
export function sameArrangement(a: PaneLayout, b: PaneLayout): boolean {
  return arrangementOf(a) === arrangementOf(b);
}

/** A divider let go: its split and the first side's new share, for `layout.set_split_ratio`; a pane of the tab names it. */
export interface RatioRequest {
  readonly paneId: string;
  readonly splitId: string;
  readonly ratio: number;
}

/** What a divider released at `at` asks Herdr: the split's ratio set to where you let go (4 places); null under half a cell. */
export function ratioRequest(divider: Divider, at: number): RatioRequest | null {
  if (Math.abs(at - divider.at) * divider.extent < 0.5) return null;
  return { paneId: divider.firstPaneId, splitId: divider.splitId, ratio: Math.round(at * 10_000) / 10_000 };
}

/** Herdr's split ids name the side of its parent a split is on: split_<n>_root, split_<n>_0 (first), split_<n>_1 (second). */
const herdrSplitId = /^split_\d+_(root|0|1)$/;

/**
 * The path `layout.set_split_ratio` takes to the split `splitId`: the sides
 * from the root, false the first and true the second (the encoding is
 * inferred: herdr/pane-methods.ts). Null when the tree has no such split,
 * when it or a split on the way was read off the rects alone (its place in
 * Herdr's tree is not known), or when Herdr's id names another side than the
 * path's last step. An id in another shape is taken as opaque.
 */
export function splitPath(root: TileNode, splitId: string): boolean[] | null {
  const find = (node: TileNode, path: boolean[]): boolean[] | null => {
    if (node.type === "pane" || node.id.startsWith("cut:")) return null;
    if (node.id === splitId) return path;
    return find(node.first, [...path, false]) ?? find(node.second, [...path, true]);
  };
  const path = find(root, []);
  if (path === null) return null;
  const side = herdrSplitId.exec(splitId)?.[1];
  if (side === undefined) return path;
  const last = path.length === 0 ? "root" : path[path.length - 1] ? "1" : "0";
  return side === last ? path : null;
}

/** A tab's layout tree as `layout.set_split_ratio` answers it (Herdr's LayoutDescription root, the parts read). */
export type LayoutTreeNode =
  | { readonly type: "pane"; readonly paneId: string | null }
  | { readonly type: "split"; readonly direction: string; readonly ratio: number; readonly first: LayoutTreeNode; readonly second: LayoutTreeNode };

/** The ratio of the split at `path` in a layout tree, or null when a pane or nothing is there. */
export function ratioAtPath(node: LayoutTreeNode, path: readonly boolean[]): number | null {
  let at = node;
  for (const step of path) {
    if (at.type !== "split") return null;
    at = step ? at.second : at.first;
  }
  return at.type === "split" ? at.ratio : null;
}

/** Where focus moves from a tile (as Herdr's pane.focus_direction names them; the move is the app's own). */
export type FocusDirection = "left" | "right" | "up" | "down";

const near = 1e-6;

/**
 * The tile focus moves to from `paneId` in `direction`, or null: the nearest
 * tile beyond that edge that shares some of its span; of those, the one
 * sharing the most, then the first in Herdr's order.
 */
export function neighbourTile(tiles: readonly Tile[], paneId: string, direction: FocusDirection): string | null {
  const from = tiles.find((tile) => tile.paneId === paneId);
  if (from === undefined) return null;
  const a = from.frame;
  const across = direction === "left" || direction === "right";
  let best: { tile: Tile; gap: number; shared: number } | null = null;
  for (const tile of tiles) {
    if (tile === from) continue;
    const b = tile.frame;
    let gap: number;
    if (direction === "right") gap = b.left - (a.left + a.width);
    else if (direction === "left") gap = a.left - (b.left + b.width);
    else if (direction === "down") gap = b.top - (a.top + a.height);
    else gap = a.top - (b.top + b.height);
    if (gap < -near) continue;
    const shared = across
      ? Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
      : Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    if (shared <= near) continue;
    const better =
      best === null ||
      gap < best.gap - near ||
      (Math.abs(gap - best.gap) <= near && (shared > best.shared + near || (Math.abs(shared - best.shared) <= near && tile.index < best.tile.index)));
    if (better) best = { tile, gap, shared };
  }
  return best?.tile.paneId ?? null;
}
