// The layout model: a tab's layout as Herdr gives it
// (`pane.layout`, the CLI's `herdr pane layout --pane <id>`; the four answers in
// fixtures/layout were captured from live Herdr) becomes the tile tree (nested
// splits with direction and ratio, panes as leaves, in Herdr's own
// arrangement), each tile's place as fractions of the main area (cells to
// fractions), and what the main area shows: the tiles, the zoomed pane alone,
// or, past 4 panes, the selected pane alone with a quiet line.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeReply, decodePaneLayoutResult } from "../src/main/herdr/wire";
import {
  decideTiles,
  maxTiles,
  sameArrangement,
  splitShape,
  tileFrames,
  tileTree,
  tooManyNote,
  type PaneLayout,
  type TileNode,
} from "../src/shared/pane-layout";

const fixture = (name: string): PaneLayout =>
  decodeReply(readFileSync(new URL(`../fixtures/layout/${name}.json`, import.meta.url), "utf8"), decodePaneLayoutResult);

const single = fixture("layout-single-pane");
const workers = fixture("layout-workers-tab");
const three = fixture("layout-three-panes");
const four = fixture("layout-four-panes");

/** The tree as text: (right 0.5 a | b), leaves by pane id. */
function shape(node: TileNode | null): string {
  if (node === null) return "none";
  if (node.type === "pane") return node.paneId;
  return `(${node.direction} ${node.ratio} ${shape(node.first)} | ${shape(node.second)})`;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const frames = (layout: PaneLayout) =>
  Object.fromEntries(
    tileFrames(tileTree(layout)!).tiles.map((tile) => [tile.paneId, [round(tile.frame.left), round(tile.frame.top), round(tile.frame.width), round(tile.frame.height)]]),
  );

describe("Herdr's layout answer", () => {
  it("decodes each fixture: area, panes with rects and focus, splits, tab, workspace, zoomed", () => {
    expect(single).toEqual({
      tabId: "w7:t1",
      workspaceId: "w7",
      area: { x: 0, y: 0, width: 134, height: 45 },
      focusedPaneId: "w7:p1",
      panes: [{ paneId: "w7:p1", focused: true, rect: { x: 0, y: 0, width: 134, height: 45 } }],
      splits: [],
      zoomed: false,
    });
    expect(four.panes.map((pane) => pane.paneId)).toEqual(["w7:p4S", "w7:p4V", "w7:p4T", "w7:p4W"]);
    expect(four.splits).toEqual([
      { id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 134, height: 45 } },
      { id: "split_1_0", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 67, height: 45 } },
      { id: "split_2_1", direction: "down", ratio: 0.5, rect: { x: 67, y: 0, width: 67, height: 45 } },
    ]);
    expect([workers.tabId, three.tabId, four.tabId]).toEqual(["w7:tZ", "w7:t12", "w7:t13"]);
  });

  it("refuses an answer that is not a layout (an error, a pane without a rect)", () => {
    expect(() => decodeReply('{"id":"x","error":{"code":"unknown_method","message":"pane.layout"}}', decodePaneLayoutResult)).toThrow(/unknown_method/);
    const broken = '{"id":"x","result":{"type":"pane_layout","layout":{"area":{"x":0,"y":0,"width":10,"height":10},"panes":[{"pane_id":"a","focused":true}],"splits":[],"tab_id":"t","workspace_id":"w","zoomed":false}}}';
    expect(() => decodeReply(broken, decodePaneLayoutResult)).toThrow(/rect/);
  });
});

describe("the tile tree", () => {
  it("one pane is one leaf", () => {
    expect(shape(tileTree(single))).toBe("w7:p1");
    expect(frames(single)).toEqual({ "w7:p1": [0, 0, 1, 1] });
  });

  it("the workers tab: two panes side by side, split right at Herdr's ratio", () => {
    expect(shape(tileTree(workers))).toBe("(right 0.5 w7:p48 | w7:p4M)");
    const root = tileTree(workers)!;
    expect(root).toMatchObject({ type: "split", id: "split_0_root", fraction: 0.5, extent: 134 });
    expect(frames(workers)).toEqual({ "w7:p48": [0, 0, 0.5, 1], "w7:p4M": [0.5, 0, 0.5, 1] });
  });

  it("three panes: the left one full height, the right half split down (23 and 22 rows of 45)", () => {
    expect(shape(tileTree(three))).toBe("(right 0.5 w7:p4N | (down 0.5 w7:p4P | w7:p4R))");
    expect(frames(three)).toEqual({
      "w7:p4N": [0, 0, 0.5, 1],
      "w7:p4P": [0.5, 0, 0.5, round(23 / 45)],
      "w7:p4R": [0.5, round(23 / 45), 0.5, round(22 / 45)],
    });
    // Each split keeps Herdr's id and ratio; the fraction is the first side's share in cells.
    const right = (tileTree(three) as Extract<TileNode, { type: "split" }>).second;
    expect(right).toMatchObject({ type: "split", id: "split_1_1", direction: "down", ratio: 0.5, extent: 45 });
    expect(round((right as Extract<TileNode, { type: "split" }>).fraction)).toBe(round(23 / 45));
  });

  it("four panes: two columns, each split down; tiles in Herdr's order (its pane list)", () => {
    expect(shape(tileTree(four))).toBe("(right 0.5 (down 0.5 w7:p4S | w7:p4V) | (down 0.5 w7:p4T | w7:p4W))");
    expect(frames(four)).toEqual({
      "w7:p4S": [0, 0, 0.5, round(23 / 45)],
      "w7:p4V": [0, round(23 / 45), 0.5, round(22 / 45)],
      "w7:p4T": [0.5, 0, 0.5, round(23 / 45)],
      "w7:p4W": [0.5, round(23 / 45), 0.5, round(22 / 45)],
    });
    const { tiles, dividers } = tileFrames(tileTree(four)!);
    expect(tiles.map((tile) => [tile.index, tile.paneId])).toEqual([
      [0, "w7:p4S"],
      [1, "w7:p4V"],
      [2, "w7:p4T"],
      [3, "w7:p4W"],
    ]);
    // A divider per split: the column line across the whole area, a row line in each column.
    expect(dividers.map((divider) => [divider.splitId, divider.direction, round(divider.at), divider.firstPaneId])).toEqual([
      ["split_0_root", "right", 0.5, "w7:p4S"],
      ["split_1_0", "down", round(23 / 45), "w7:p4S"],
      ["split_2_1", "down", round(23 / 45), "w7:p4T"],
    ]);
    expect(dividers[1]!.frame).toEqual({ left: 0, top: 0, width: 0.5, height: 1 });
  });

  it("is rebuilt from the rects alone when the splits are missing (same arrangement)", () => {
    const bare: PaneLayout = { ...four, splits: [] };
    expect(frames(bare)).toEqual(frames(four));
    expect(tileTree(bare)).toMatchObject({ type: "split", direction: "right" });
  });

  it("a dragged divider moves its tiles (the override is a split's new fraction)", () => {
    const root = tileTree(workers)!;
    const moved = tileFrames(root, new Map([["split_0_root", 0.3]])).tiles;
    expect(moved.map((tile) => [tile.paneId, round(tile.frame.left), round(tile.frame.width)])).toEqual([
      ["w7:p48", 0, 0.3],
      ["w7:p4M", 0.3, 0.7],
    ]);
  });
});

describe("what the main area shows for the selected pane", () => {
  it("the tab's tiles with the selected pane focused, 2 to 4 panes", () => {
    for (const [layout, pane] of [
      [workers, "w7:p4M"],
      [three, "w7:p4R"],
      [four, "w7:p4W"],
    ] as const) {
      const decision = decideTiles(layout, pane);
      expect(decision.kind).toBe("tiles");
      if (decision.kind !== "tiles") continue;
      expect(decision.focusedPaneId).toBe(pane);
      expect(decision.tiles.length).toBe(layout.panes.length);
    }
  });

  it("one pane alone: a one-pane tab, no layout yet, or a pane the layout does not list", () => {
    expect(decideTiles(single, "w7:p1")).toMatchObject({ kind: "single", paneId: "w7:p1", reason: "onePane", note: null });
    expect(decideTiles(null, "w7:p1")).toMatchObject({ kind: "single", reason: "noLayout" });
    expect(decideTiles(four, "w7:p1")).toMatchObject({ kind: "single", reason: "notInLayout" });
  });

  it("Herdr's zoom is what shows: a zoomed tab shows its zoomed pane (focused_pane_id), zoomed, whichever of its panes was selected", () => {
    const zoomed: PaneLayout = { ...four, zoomed: true, focusedPaneId: "w7:p4T" };
    expect(decideTiles(zoomed, "w7:p4T")).toMatchObject({ kind: "single", paneId: "w7:p4T", reason: "zoomed", zoomed: true, paneCount: 4 });
    // Another pane of the zoomed tab selected: the zoomed one shows, with Zoomed and Unzoom (was: the selected pane, not zoomed).
    expect(decideTiles(zoomed, "w7:p4S")).toMatchObject({ kind: "single", paneId: "w7:p4T", reason: "zoomed", zoomed: true });
    // A zoomed layout naming no pane it lists: the selected pane, still zoomed (Unzoom stays offered).
    expect(decideTiles({ ...zoomed, focusedPaneId: "w7:gone" }, "w7:p4S")).toMatchObject({ kind: "single", paneId: "w7:p4S", reason: "zoomed", zoomed: true });
  });

  it("more than 4 panes: the selected pane alone, with the quiet line", () => {
    expect(maxTiles).toBe(4);
    const five: PaneLayout = {
      ...four,
      panes: [...four.panes.slice(0, 3), { paneId: "w7:p4W", focused: false, rect: { x: 67, y: 23, width: 33, height: 22 } }, { paneId: "w7:p4X", focused: false, rect: { x: 100, y: 23, width: 34, height: 22 } }],
      splits: [...four.splits, { id: "split_3_1", direction: "right", ratio: 0.5, rect: { x: 67, y: 23, width: 67, height: 22 } }],
    };
    expect(tileTree(five)).not.toBeNull();
    expect(decideTiles(five, "w7:p4X")).toEqual({
      kind: "single",
      paneId: "w7:p4X",
      reason: "tooMany",
      zoomed: false,
      paneCount: 5,
      note: "This tab has 5 panes; Adari shows up to 4. Zoom or close one in Herdr.",
    });
    expect(tooManyNote(7)).toBe("This tab has 7 panes; Adari shows up to 4. Zoom or close one in Herdr.");
  });
});

describe("a tab's arrangement and a split's shape", () => {
  // The captured four panes: split_1_0 holds p4S over p4V. Exchanging p4V's and p4W's places keeps the pane list's order, the splits and p4S's place.
  const rectOf = (paneId: string) => four.panes.find((pane) => pane.paneId === paneId)!.rect;
  const exchanged: PaneLayout = {
    ...four,
    panes: four.panes.map((pane) =>
      pane.paneId === "w7:p4V" ? { ...pane, rect: rectOf("w7:p4W") } : pane.paneId === "w7:p4W" ? { ...pane, rect: rectOf("w7:p4V") } : pane,
    ),
  };

  it("names the split's direction and both sides in order, ratios aside", () => {
    expect(splitShape(tileTree(four)!, "split_1_0")).toBe(JSON.stringify(["split_1_0", "down", "w7:p4S", "w7:p4V"]));
    expect(splitShape(tileTree(exchanged)!, "split_1_0")).toBe(JSON.stringify(["split_1_0", "down", "w7:p4S", "w7:p4W"]));
    expect(splitShape(tileTree(four)!, "split_9_0")).toBeNull();
    const moved: PaneLayout = { ...four, splits: four.splits.map((split) => ({ ...split, ratio: 0.3 })) };
    expect(splitShape(tileTree(moved)!, "split_1_0")).toBe(splitShape(tileTree(four)!, "split_1_0"));
  });

  it("two layouts arrange a tab the same way only with the same tree: the panes' order alone is not enough", () => {
    expect(exchanged.panes.map((pane) => pane.paneId)).toEqual(four.panes.map((pane) => pane.paneId));
    expect(exchanged.splits).toEqual(four.splits);
    expect(sameArrangement(four, exchanged)).toBe(false);
    expect(sameArrangement(four, { ...four, splits: four.splits.map((split) => ({ ...split, ratio: 0.3 })) })).toBe(true);
    expect(sameArrangement(four, { ...four, zoomed: true })).toBe(false);
    expect(sameArrangement(four, { ...four, tabId: "w7:t99" })).toBe(false);
  });
});
